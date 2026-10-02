import { dirname, isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { findConfigFile } from "../../core/config/loader";
import {
  resolveProjectRuntimeContext,
  UnknownEnvironmentError,
  type ProjectRuntimeContext,
} from "../../core/config/runtimeContext";
import type { MongoDriverModule } from "../../core/datasources/mongo";
import { resolveEnvironmentDatasources } from "../../core/datasources/resolve";
import {
  defaultLedgerRoot,
  expiresAt,
  fixtureStates,
  foldLedger,
  isOpenState,
  ownerProcessAlive,
  projectLedgerPath,
  readProjectLedger,
  type FixtureLiveState,
} from "../../core/fixtures/ledger";
import {
  FIXTURES_RESULT_SCHEMA_ID,
  type FixtureListRow,
  type FixtureStatusRow,
  type FixtureSweepRow,
  type FixturesResult,
} from "../../core/fixtures/result";
import {
  FixtureRuntime,
  FixtureSetupError,
  fixtureWriteBlock,
} from "../../core/fixtures/runtime";
import {
  fixtureDurationMs,
  fixtureScope,
  FIXTURE_VERBS,
  type FixtureDefinition,
  type FixturesRegistry,
} from "../../core/fixtures/schema";
import { cairnContextEnv, targetChildEnv } from "../../core/processEnv";
import type { FixtureEvent } from "../../core/schema/events.v1";
import { emit, resolveFormat } from "../format";
import { log } from "../logger";
import { resolveScopedSecrets } from "./secrets";

/**
 * `cairn fixtures list|status|ensure|reset|teardown|sweep` (MCP
 * `cairn_fixtures_*`): inspect and drive the config `fixtures:` registry
 * outside a run. Result `urn:cairntrace.dev:fixtures:v1`. Exit 0 ok (a
 * dry-run included), 1 a verb (or a `--verify`) failed, 2 error, 4 invalid
 * input (unknown fixture or env, invalid config, bad flag).
 */

export type FixturesAction =
  | "list"
  | "status"
  | "ensure"
  | "reset"
  | "teardown"
  | "sweep";

export interface FixturesRequest {
  action: FixturesAction;
  /** ensure/reset/teardown: exactly one; status: an optional filter. */
  names?: string[];
  config?: string;
  env?: string;
  /** Parameters as `key=value` (values parsed as JSON when they are). */
  with?: string[] | Record<string, unknown>;
  /** Let mutating verbs write on a shared environment. */
  allowWrites?: boolean;
  /** status: run each fixture's verify against its recorded outputs. */
  verify?: boolean;
  /** sweep: minimum age of a leftover (default 1h). */
  olderThan?: string | number;
  /** sweep: tear the candidates down (default: report only). */
  apply?: boolean;
  /** sweep: seed fixtures too (default: only past their ttl). */
  includeSeed?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  onEvent?: (event: FixtureEvent) => void;
  /** Test seams. */
  ledgerRoot?: string;
  seedStateRoot?: string;
  loadMongoDriver?: () => Promise<MongoDriverModule | undefined>;
}

class FixturesInputError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 4,
  ) {
    super(message);
  }
}

const DEFAULT_SWEEP_AGE_MS = 3_600_000;

function base(
  action: FixturesAction,
  extra: Partial<FixturesResult> = {},
): FixturesResult {
  return {
    $schema: FIXTURES_RESULT_SCHEMA_ID,
    version: "1",
    action,
    ok: true,
    exitCode: 0,
    warnings: [],
    ...extra,
  };
}

function failure(
  action: FixturesAction,
  exitCode: 1 | 2 | 4,
  error: string,
  extra: Partial<FixturesResult> = {},
): FixturesResult {
  return base(action, { ...extra, ok: false, exitCode, error });
}

/** `key=value` list → params (JSON values parsed when they parse). */
export function parseWithFlags(
  pairs: string[] | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (pairs === undefined) return undefined;
  if (!Array.isArray(pairs)) return pairs;
  if (pairs.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new FixturesInputError(
        `--with expects key=value, got "${pair}"`,
        4,
      );
    }
    const raw = pair.slice(eq + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    out[pair.slice(0, eq)] = value;
  }
  return out;
}

function parseAge(raw: string | number | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_SWEEP_AGE_MS;
  if (typeof raw === "number") return raw;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  try {
    return fixtureDurationMs(raw.trim());
  } catch {
    throw new FixturesInputError(
      `invalid --older-than "${raw}" (milliseconds, or a number with ms|s|m|h|d)`,
      4,
    );
  }
}

interface LoadedFixtures {
  ctx: ProjectRuntimeContext;
  configPath: string;
  registry: FixturesRegistry;
  project: string;
  env: Record<string, string | undefined>;
  selectedKeys?: Iterable<string>;
  secretValues: string[];
  warnings: string[];
}

async function loadFixtures(
  req: FixturesRequest,
  needsSecrets: boolean,
): Promise<LoadedFixtures> {
  const cwd = req.cwd ?? process.cwd();
  const configPath = req.config
    ? isAbsolute(req.config)
      ? req.config
      : resolve(cwd, req.config)
    : await findConfigFile(cwd);
  if (!configPath) {
    throw new FixturesInputError(
      `fixtures live in cairntrace.config.yml — none found from ${cwd} upward; pass --config <path>`,
      4,
    );
  }
  const warnings: string[] = [];
  let env = targetChildEnv(process.env) as Record<string, string | undefined>;
  let selectedKeys: Iterable<string> | undefined;
  let secretValues: string[] = [];
  if (needsSecrets) {
    try {
      const scoped = await resolveScopedSecrets(configPath, {
        configPath,
        ...(req.env !== undefined ? { environmentOverride: req.env } : {}),
      });
      env = scoped.childEnv;
      selectedKeys = scoped.selectedKeys;
      secretValues = [...scoped.secretValues];
    } catch (error) {
      if (error instanceof UnknownEnvironmentError) {
        throw new FixturesInputError(error.message, 4);
      }
      warnings.push(
        `scoped secrets unavailable (${(error as Error).message}); fixtures see the plain environment`,
      );
    }
  }
  let ctx: ProjectRuntimeContext;
  try {
    ctx = await resolveProjectRuntimeContext({
      configPath,
      cwd,
      env,
      ...(req.env !== undefined ? { envOverride: req.env } : {}),
      onWarning: (message) => warnings.push(message),
    });
  } catch (error) {
    if (error instanceof UnknownEnvironmentError || error instanceof ZodError) {
      throw new FixturesInputError(
        error instanceof ZodError
          ? `invalid config ${configPath}: ${error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`
          : error.message,
        4,
      );
    }
    throw new FixturesInputError((error as Error).message, 2);
  }
  return {
    ctx,
    configPath,
    registry: ctx.config?.fixtures ?? {},
    project: ctx.config?.project ?? "cairntrace",
    env,
    ...(selectedKeys ? { selectedKeys } : {}),
    secretValues,
    warnings,
  };
}

function verbsOf(def: FixtureDefinition): FixtureListRow["verbs"] {
  return FIXTURE_VERBS.filter((verb) => def[verb] !== undefined);
}

function listRows(registry: FixturesRegistry): FixtureListRow[] {
  return Object.entries(registry).map(([name, def]) => ({
    name,
    kind: def.kind,
    scope: fixtureScope(def),
    ...(def.description ? { description: def.description } : {}),
    ...(def.kind !== "exec" && def.datasource
      ? { datasource: def.datasource }
      : {}),
    verbs: verbsOf(def),
    needs: def.needs ?? [],
    outputs: Object.entries(def.outputs ?? {}).map(([key, spec]) => ({
      key,
      ...(typeof spec !== "string" && spec.secret ? { secret: true } : {}),
    })),
    ...(def.owner
      ? {
          owner: {
            ...(def.owner.exactlyOne !== undefined
              ? { exactlyOne: def.owner.exactlyOne }
              : {}),
            ...(def.owner.marker
              ? { marker: Object.keys(def.owner.marker) }
              : {}),
          },
        }
      : {}),
    ...(def.ttl !== undefined ? { ttlMs: fixtureDurationMs(def.ttl) } : {}),
    ...(def.with ? { with: Object.keys(def.with) } : {}),
  }));
}

function statusRow(
  name: string,
  envName: string,
  def: FixtureDefinition | undefined,
  state: FixtureLiveState | undefined,
  now: number,
): FixtureStatusRow {
  if (!state) {
    return {
      name,
      env: envName,
      adapter: def!.kind,
      scope: fixtureScope(def!),
      state: "never",
    };
  }
  const expiry = expiresAt(state);
  const expired =
    state.state === "live" && expiry !== undefined && Date.parse(expiry) <= now;
  return {
    name,
    env: envName,
    adapter: state.adapter,
    scope: state.scope,
    state: expired ? "expired" : state.state,
    ...(state.ensuredAt ? { ensuredAt: state.ensuredAt } : {}),
    ...(expiry ? { expiresAt: expiry } : {}),
    lastVerb: state.lastVerb,
    lastStatus: state.lastStatus,
    lastAt: state.lastAt,
    ...(state.lastError ? { lastError: state.lastError } : {}),
    origin: state.origin,
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.adopted ? { adopted: true as const } : {}),
    ...(state.outputs &&
    state.state !== "torn-down" &&
    state.state !== "released"
      ? { outputs: state.outputs }
      : {}),
    ...(def === undefined ? { unknown: true as const } : {}),
  };
}

function exitFromEvents(events: readonly FixtureEvent[]): 0 | 1 {
  return events.some((event) => event.status === "failed") ? 1 : 0;
}

/** Run a fixtures action; never throws (errors are in the result). */
export async function runFixtures(
  req: FixturesRequest,
): Promise<FixturesResult> {
  const action = req.action;
  let loaded: LoadedFixtures;
  try {
    loaded = await loadFixtures(req, action !== "list" && action !== "status");
  } catch (error) {
    const exitCode = error instanceof FixturesInputError ? error.exitCode : 2;
    return failure(
      action,
      exitCode,
      (error as Error).message,
      req.config ? { config: req.config } : {},
    );
  }
  const { ctx, registry, project } = loaded;
  const envName = ctx.envName;
  const policy = ctx.config?.environments[envName]?.policy;
  const policyTrait = policy?.trait;
  const policyMutations = policy?.mutations;
  const ledgerRoot = req.ledgerRoot ?? defaultLedgerRoot();
  // The same rule the runs apply: shared/protected without --allow-writes,
  // and `mutations: deny` always, keep the mutating verbs dry-run.
  const writeBlock = fixtureWriteBlock({
    envName,
    ...(policyTrait ? { policyTrait } : {}),
    ...(policyMutations ? { policyMutations } : {}),
    ...(req.allowWrites === true ? { allowWrites: true } : {}),
  });
  const common: Partial<FixturesResult> = {
    project,
    env: envName,
    config: loaded.configPath,
    writes: writeBlock === undefined ? "allowed" : "dry-run",
    ...(writeBlock !== undefined ? { writesReason: writeBlock } : {}),
    warnings: loaded.warnings,
  };
  if (action === "list") {
    return base(action, { ...common, fixtures: listRows(registry) });
  }

  let params: Record<string, unknown> | undefined;
  let olderThanMs = DEFAULT_SWEEP_AGE_MS;
  try {
    params = parseWithFlags(req.with);
    if (action === "sweep") olderThanMs = parseAge(req.olderThan);
  } catch (error) {
    return failure(action, 4, (error as Error).message, common);
  }
  const names = req.names ?? [];
  if (["ensure", "reset", "teardown"].includes(action)) {
    if (names.length !== 1) {
      return failure(
        action,
        4,
        `${action} takes exactly one fixture name`,
        common,
      );
    }
  }
  for (const name of action === "sweep" ? [] : names) {
    if (!registry[name]) {
      return failure(
        action,
        4,
        `unknown fixture "${name}"; config fixtures: ${
          Object.keys(registry).join(", ") || "(none)"
        }`,
        common,
      );
    }
  }

  const redactor = createArtifactRedactor(
    undefined,
    loaded.env,
    loaded.secretValues,
  );
  const configDir = dirname(loaded.configPath);
  const runToken = `cli_${Date.now().toString(36)}`;
  const runtime = new FixtureRuntime({
    project,
    envName,
    registry,
    configDir,
    childEnv: loaded.env,
    ...(loaded.selectedKeys ? { selectedTvaultKeys: loaded.selectedKeys } : {}),
    contextEnv: cairnContextEnv({
      environment: envName,
      ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}),
      runToken,
      configDir,
    }),
    vars: ctx.vars,
    ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}),
    runToken,
    datasourceSet: resolveEnvironmentDatasources(
      ctx.config?.datasources,
      ctx.config?.environments[envName]?.datasources,
    ),
    ...(policyTrait ? { policyTrait } : {}),
    ...(policyMutations ? { policyMutations } : {}),
    allowWrites: req.allowWrites === true,
    origin: "cli",
    ledgerRoot,
    ...(req.seedStateRoot ? { seedStateRoot: req.seedStateRoot } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    ...(req.loadMongoDriver ? { loadMongoDriver: req.loadMongoDriver } : {}),
    redact: (text) => redactor.text(text),
    redactValue: (value) => redactor.value(value),
    ...(req.onEvent ? { onEvent: req.onEvent } : {}),
  });
  const ledger = projectLedgerPath(project, ledgerRoot);
  // The document goes through the key-aware redactor too (a `token` field
  // of an exec result, a secret a verb resolved), like run evidence.
  const done = (result: FixturesResult): FixturesResult =>
    createArtifactRedactor(undefined, loaded.env, [
      ...loaded.secretValues,
      ...runtime.secretValues(),
    ]).value(result);

  if (action === "status") {
    const states = foldLedger(await readProjectLedger(project, ledgerRoot));
    const now = Date.now();
    const wanted = names.length > 0 ? names : Object.keys(registry);
    const rows: FixtureStatusRow[] = [];
    // A run-scoped fixture has one state per run instance: show the newest
    // one still owed a teardown (live or failed), else the newest.
    const pick = (name: string): { state?: FixtureLiveState; open: number } => {
      const all = fixtureStates(states, envName, name);
      const open = all.filter(isOpenState);
      const state = open[0] ?? all[0];
      return { ...(state ? { state } : {}), open: open.length };
    };
    for (const name of wanted) {
      const { state, open } = pick(name);
      const row = statusRow(name, envName, registry[name], state, now);
      if (open > 1) row.instances = open;
      if (
        req.verify &&
        row.state !== "never" &&
        row.state !== "torn-down" &&
        row.state !== "released"
      ) {
        try {
          row.verify = await runtime.verifyRecorded(name);
        } catch (error) {
          row.verify = { ok: false, error: (error as Error).message };
        }
      }
      rows.push(row);
    }
    // Ledger entries of fixtures the config no longer declares.
    if (names.length === 0) {
      const unknown = new Set<string>();
      for (const state of states.values()) {
        if (state.env !== envName || registry[state.name]) continue;
        unknown.add(state.name);
      }
      for (const name of unknown) {
        const { state, open } = pick(name);
        const row = statusRow(name, envName, undefined, state, now);
        if (open > 1) row.instances = open;
        rows.push(row);
      }
    }
    const verifyFailed = rows.some((row) => row.verify && !row.verify.ok);
    return done(
      base(action, {
        ...common,
        ok: !verifyFailed,
        exitCode: verifyFailed ? 1 : 0,
        status: rows,
        ledger,
      }),
    );
  }

  if (action === "sweep") {
    const states = foldLedger(await readProjectLedger(project, ledgerRoot));
    const now = Date.now();
    const candidates: FixtureSweepRow[] = [];
    for (const state of states.values()) {
      if (state.env !== envName) continue;
      if (state.state !== "live" && state.state !== "failed") continue;
      const def = registry[state.name];
      const ageMs = state.ensuredAt
        ? Math.max(0, now - Date.parse(state.ensuredAt))
        : undefined;
      const expiry = expiresAt(state);
      const expired = expiry !== undefined && Date.parse(expiry) <= now;
      const row: FixtureSweepRow = {
        name: state.name,
        env: envName,
        scope: state.scope,
        state: state.state as FixtureSweepRow["state"],
        ...(state.instance !== undefined ? { instance: state.instance } : {}),
        ...(state.ensuredAt ? { ensuredAt: state.ensuredAt } : {}),
        ...(ageMs !== undefined ? { ageMs } : {}),
        action: "teardown",
      };
      if (!def) row.action = "skipped-unknown";
      else if (def.teardown === undefined) row.action = "skipped-no-teardown";
      else if (state.adopted) row.action = "skipped-adopted";
      else if (ownerProcessAlive(state)) row.action = "skipped-owner-alive";
      else if (state.scope === "seed" && !expired && !req.includeSeed) {
        row.action = "skipped-seed";
      } else if (!expired && (ageMs ?? 0) < olderThanMs) {
        row.action = "skipped-young";
      } else if (needsMissingOutputs(state.name, def.teardown, state)) {
        row.action = "skipped-no-outputs";
      }
      candidates.push(row);
    }
    if (req.apply) {
      for (const row of candidates) {
        // A teardown that needs outputs its failed ensure never recorded
        // cannot run: --apply releases it from the ledger instead (the
        // teardown verb records it, status skipped).
        if (row.action !== "teardown" && row.action !== "skipped-no-outputs") {
          continue;
        }
        try {
          const torn = await runtime.teardownRecorded(row.name, {
            origin: "sweep",
            ...(row.instance !== undefined ? { instance: row.instance } : {}),
          });
          row.result = torn.status;
          if (torn.error) row.error = torn.error;
        } catch (error) {
          row.result = "failed";
          row.error = (error as Error).message;
        }
      }
    }
    const failed = candidates.some((row) => row.result === "failed");
    return done(
      base(action, {
        ...common,
        ok: !failed,
        exitCode: failed ? 1 : 0,
        sweep: { olderThanMs, applied: req.apply === true, candidates },
        events: runtime.events,
        ledger,
      }),
    );
  }

  const name = names[0]!;
  try {
    if (action === "ensure") {
      await runtime.ensureOne(name, params ? { with: params } : {});
    } else if (action === "reset") {
      await runtime.resetOne(name, params ? { with: params } : {});
    } else {
      // Every instance still owed a teardown (a run-scoped fixture has one
      // per run), newest first; none recorded: tear down once without.
      const open = fixtureStates(
        foldLedger(await readProjectLedger(project, ledgerRoot)),
        envName,
        name,
      ).filter(isOpenState);
      for (const state of open.length > 0 ? open : [undefined]) {
        await runtime.teardownRecorded(name, {
          ...(params ? { with: params } : {}),
          ...(state?.instance !== undefined
            ? { instance: state.instance }
            : {}),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof FixtureSetupError)) {
      return done(
        failure(action, 2, (error as Error).message, {
          ...common,
          events: runtime.events,
        }),
      );
    }
    return done(
      failure(action, error.verb === "plan" ? 4 : 1, error.message, {
        ...common,
        events: runtime.events,
        ledger,
      }),
    );
  }
  const outputs = Object.fromEntries(
    runtime
      .runLedger()
      .entries.filter((entry) => Object.keys(entry.outputs).length > 0)
      .map((entry) => [entry.name, entry.outputs]),
  );
  const exitCode = exitFromEvents(runtime.events);
  return done(
    base(action, {
      ...common,
      ok: exitCode === 0,
      exitCode,
      events: runtime.events,
      ...(action !== "teardown" ? { outputs } : {}),
      ledger,
    }),
  );
}

/**
 * The teardown reads the fixture's own outputs (`${fixtures.<self>.…}`)
 * and the ledger recorded none (its ensure failed first).
 */
function needsMissingOutputs(
  name: string,
  teardown: unknown,
  state: FixtureLiveState,
): boolean {
  return (
    Object.keys(state.outputs ?? {}).length === 0 &&
    JSON.stringify(teardown).includes(`\${fixtures.${name}.`)
  );
}

/* ----- markdown ----- */

function cell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function fixturesMarkdown(result: FixturesResult): string {
  const lines = [
    `# cairn fixtures ${result.action}${result.env ? ` — ${result.env}` : ""}`,
    "",
  ];
  if (result.error) lines.push(`error: ${result.error}`, "");
  if (result.writes === "dry-run") {
    lines.push(
      `Mutating verbs are dry-run: ${result.writesReason ?? "the environment policy keeps fixture writes off"}.`,
      "",
    );
  }
  if (result.fixtures) {
    lines.push(
      "| fixture | kind | scope | verbs | needs | outputs |",
      "|---|---|---|---|---|---|",
      ...result.fixtures.map(
        (row) =>
          `| ${row.name} | ${row.kind} | ${row.scope} | ${row.verbs.join(", ")} | ${row.needs.join(", ")} | ${row.outputs
            .map((o) => (o.secret ? `${o.key} (secret)` : o.key))
            .join(", ")} |`,
      ),
      "",
    );
  }
  if (result.status) {
    lines.push(
      "| fixture | scope | state | ensured | expires | last | verify |",
      "|---|---|---|---|---|---|---|",
      ...result.status.map(
        (row) =>
          `| ${row.name}${
            row.unknown ? " (not in config)" : ""
          } | ${row.scope} | ${row.state}${
            row.instances ? ` (${row.instances} instances)` : ""
          }${
            row.adopted ? " (adopted)" : ""
          } | ${cell(row.ensuredAt)} | ${cell(row.expiresAt)} | ${cell(
            row.lastVerb ? `${row.lastVerb} ${row.lastStatus}` : "",
          )} | ${cell(
            row.verify
              ? row.verify.skipped
                ? (row.verify.reason ?? "no verify verb")
                : row.verify.ok
                  ? "ok"
                  : `failed: ${row.verify.error ?? ""}`
              : "",
          )} |`,
      ),
      "",
    );
  }
  if (result.sweep) {
    lines.push(
      `Older than ${result.sweep.olderThanMs}ms; ${
        result.sweep.applied ? "applied" : "dry-run (pass --apply to tear down)"
      }.`,
      "",
      "| fixture | scope | state | age | action | result |",
      "|---|---|---|---|---|---|",
      ...result.sweep.candidates.map(
        (row) =>
          `| ${row.name} | ${row.scope} | ${row.state} | ${cell(
            row.ageMs !== undefined ? `${Math.round(row.ageMs / 1000)}s` : "",
          )} | ${row.action} | ${cell(row.result ? `${row.result}${row.error ? `: ${row.error}` : ""}` : "")} |`,
      ),
      "",
    );
  }
  if (result.events && result.events.length > 0 && !result.sweep) {
    lines.push(
      "| verb | fixture | status | duration | detail |",
      "|---|---|---|---|---|",
      ...result.events.map(
        (event) =>
          `| ${event.type.replace("fixture.", "")} | ${event.name} | ${event.status} | ${event.durationMs}ms | ${cell(
            event.error ?? event.reason ?? "",
          )} |`,
      ),
      "",
    );
  }
  if (result.outputs && Object.keys(result.outputs).length > 0) {
    lines.push("Outputs:", "");
    for (const [name, outputs] of Object.entries(result.outputs)) {
      lines.push(`- ${name}: ${cell(outputs)}`);
    }
    lines.push("");
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  lines.push(`exit ${result.exitCode}`);
  return lines.join("\n");
}

/* ----- commander ----- */

export interface FixturesCommandOptions {
  config?: string;
  env?: string;
  with?: string[];
  allowWrites?: boolean;
  verify?: boolean;
  olderThan?: string;
  apply?: boolean;
  includeSeed?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function fixturesCommand(
  action: FixturesAction,
  names: string[],
  opts: FixturesCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result: FixturesResult;
  try {
    result = await runFixtures({
      action,
      names,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.with !== undefined ? { with: opts.with } : {}),
      ...(opts.allowWrites ? { allowWrites: true } : {}),
      ...(opts.verify ? { verify: true } : {}),
      ...(opts.olderThan !== undefined ? { olderThan: opts.olderThan } : {}),
      ...(opts.apply ? { apply: true } : {}),
      ...(opts.includeSeed ? { includeSeed: true } : {}),
      signal: controller.signal,
      // Narrate on stderr (stdout carries only the document).
      onEvent: (event) => {
        const line = `fixture ${event.type.replace("fixture.", "")} ${event.name}: ${event.status} (${event.durationMs}ms)${
          event.error
            ? ` — ${event.error}`
            : event.reason
              ? ` — ${event.reason}`
              : ""
        }`;
        if (event.status === "failed") log.warn(line);
        else log.info(line);
      },
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  process.stdout.write(emit(format, result, fixturesMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (result.error) process.stderr.write(`cairn fixtures: ${result.error}\n`);
  process.exitCode = result.exitCode;
}
