import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import {
  createArtifactRedactor,
  isSensitiveEnvKey,
} from "../artifacts/redaction";
import {
  createDatasourceSession,
  type DatasourceSession,
} from "../datasources";
import type { MongoDriverModule } from "../datasources/mongo";
import { scrubDatasourceText } from "../datasources/redact";
import type { EnvironmentDatasourceSet } from "../datasources/resolve";
import { SeedStateStore } from "../runner/seedState";
import { readPath } from "../runner/verifiers/matchers";
import type { FixtureEvent } from "../schema/events.v1";
import { runExecVerb, runExecVerbSync } from "./exec";
import { runHttpVerb } from "./http";
import {
  appendProjectLedger,
  defaultLedgerRoot,
  fixtureStates,
  foldLedger,
  lastSeedRun,
  ledgerKey,
  projectLedgerPath,
  readProjectLedger,
  type FixtureLiveState,
} from "./ledger";
import { runMongoVerb } from "./mongo";
import {
  fixtureDurationMs,
  fixtureScope,
  specFixtureRefParts,
  type FixtureAdapter,
  type FixtureDefinition,
  type FixtureEventStatus,
  type FixtureScope,
  type FixturesRegistry,
  type FixtureVerbName,
  type ProjectLedgerRecord,
  type RunFixtureLedger,
  type RunFixtureLedgerEntry,
  type SpecFixtureRef,
} from "./schema";
import {
  FixtureTemplateError,
  resolveFixtureTemplate,
  type FixtureTemplateScope,
} from "./template";
import {
  FixtureVerbError,
  type FixtureVerbContext,
  type FixtureVerbOutcome,
} from "./types";

/**
 * The fixture lifecycle of one consumer — a run, a `cairn run` invocation's
 * suite/seed host, or a `cairn fixtures` CLI verb:
 *
 *   setup(refs)  ensure each referenced fixture and its `needs` (needs
 *                first), then the `.reset` verbs; seed/suite fixtures are
 *                reused while fresh (ledger + ttl + verify)
 *   teardown()   finally semantics: every run-scoped fixture whose ensure
 *                ran is torn down in reverse order, after a failure or a
 *                cancel too (never with the cancelled signal)
 *   armSignal()  on SIGINT/SIGTERM, exec teardowns run synchronously; other
 *                adapters stay "live" in the ledger for `cairn fixtures sweep`
 *
 * Where the environment policy keeps fixture writes off — trait `shared` or
 * `protected` without `--allow-fixture-writes` / `write: true`, or
 * `mutations: deny` (nothing overrides it) — ensure/reset/teardown are
 * dry-run (an event with status `dry-run`, nothing written); a dry-run
 * ensure still runs the read-only `verify` to prove the data is there and
 * read its outputs, else reuses the outputs the ledger recorded for the
 * same definition and parameters.
 */

/** Why fixture writes are off here, or undefined when they are allowed. */
export function fixtureWriteBlock(input: {
  envName: string;
  policyTrait?: "owned" | "shared" | "protected";
  policyMutations?: "allow" | "deny";
  allowWrites?: boolean;
  /** The spec reference says `write: true`. */
  write?: boolean;
}): string | undefined {
  if (input.policyMutations === "deny") {
    return `environment ${input.envName} denies mutations (policy.mutations: deny): fixture writes are off`;
  }
  if (
    (input.policyTrait === "shared" || input.policyTrait === "protected") &&
    input.allowWrites !== true &&
    input.write !== true
  ) {
    return `environment ${input.envName} is ${input.policyTrait}: writes need --allow-fixture-writes or write: true`;
  }
  return undefined;
}

const DEFAULT_VERB_TIMEOUT_MS = 120_000;
/** Teardown budget on the SIGINT/SIGTERM path (the process is exiting). */
const SIGNAL_TEARDOWN_BUDGET_MS = 30_000;
/** A cancelled run still tears down, but within this budget per verb. */
const CANCELLED_TEARDOWN_BUDGET_MS = 30_000;

export class FixtureSetupError extends Error {
  constructor(
    readonly fixture: string,
    readonly verb: FixtureVerbName | "plan",
    message: string,
    readonly durationMs = 0,
    readonly timedOut = false,
    readonly cancelled = false,
  ) {
    super(message);
    this.name = "FixtureSetupError";
  }
}

/** What a suite/seed fixture looks like to every run that shares it. */
interface HostedFixture {
  adapter: FixtureAdapter;
  scope: FixtureScope;
  outputs: Record<string, unknown>;
  publicOutputs: Record<string, unknown>;
  /** Secret values (secret outputs, login tokens) every sharer scrubs. */
  secrets: string[];
  ensuredAt?: string;
  status: FixtureEventStatus;
  reason?: string;
  dryRun: boolean;
}

/**
 * Suite- and seed-scoped fixtures of one `cairn run` invocation: ensured
 * once (by the first run that needs them; concurrent runs wait on the same
 * promise), shared by every later run, and — suite scope — torn down in
 * reverse order when the invocation ends. Seed fixtures are never torn down
 * here.
 */
export class FixtureHost {
  private readonly memo = new Map<string, Promise<HostedFixture>>();
  private readonly teardowns: Array<{
    name: string;
    run: () => Promise<void>;
  }> = [];

  /**
   * What this invocation's services lifecycle did with the seed: `ran`
   * (with when) makes every seed fixture ensured before it stale; a seed
   * skipped as fresh keeps them fresh (the seed state's timestamp moves on
   * a passing freshnessCheck too). Unset: the invocation does not know.
   */
  seed: { ran: boolean; at?: string } | undefined;

  constructor(
    /** Invocation-level sinks (the journal). */
    readonly sinks: {
      onEvent?: (event: FixtureEvent) => void;
      onVerbStart?: (info: VerbStartInfo) => void;
      onVerbEnd?: (info: VerbEndInfo) => void;
    } = {},
  ) {}

  /** The shared fixture for `key`, creating it once. */
  acquire(
    key: string,
    create: () => Promise<HostedFixture>,
  ): { first: boolean; value: Promise<HostedFixture> } {
    const existing = this.memo.get(key);
    if (existing) return { first: false, value: existing };
    const value = create();
    // A failed ensure stays failed for the whole invocation (no retry per run).
    value.catch(() => undefined);
    this.memo.set(key, value);
    return { first: true, value };
  }

  addTeardown(name: string, run: () => Promise<void>): void {
    this.teardowns.push({ name, run });
  }

  /** Suite fixtures with a teardown verb, still to be torn down. */
  get pendingTeardowns(): number {
    return this.teardowns.length;
  }

  /** Tear down every suite fixture, newest first. Never throws. */
  async teardownAll(): Promise<void> {
    const items = this.teardowns.splice(0).toReversed();
    for (const item of items) {
      await item.run().catch(() => undefined);
    }
  }
}

export interface VerbStartInfo {
  name: string;
  verb: FixtureVerbName;
  budgetMs: number;
  scope: FixtureScope;
}
export interface VerbEndInfo {
  name: string;
  verb: FixtureVerbName;
  status: FixtureEventStatus;
  durationMs: number;
  error?: string;
}

export interface FixtureRuntimeOptions {
  /** Project name (config `project`, default `cairntrace`): the ledger file. */
  project: string;
  envName: string;
  registry: FixturesRegistry;
  /** Relative exec/mongo script paths and exec cwd resolve here. */
  configDir: string;
  /** Child environment (secrets included, vault controls removed). */
  childEnv: Record<string, string | undefined>;
  selectedTvaultKeys?: Iterable<string>;
  /** Non-secret CAIRN_* context for exec children. */
  contextEnv?: Record<string, string>;
  vars?: Record<string, string | number | boolean>;
  baseUrl?: string;
  runToken?: string;
  datasourceSet?: EnvironmentDatasourceSet;
  /** `environments.<env>.policy.trait`. */
  policyTrait?: "owned" | "shared" | "protected";
  /** `environments.<env>.policy.mutations` (`deny`: fixture writes off). */
  policyMutations?: "allow" | "deny";
  /** `cairn run --allow-fixture-writes` / `cairn fixtures --allow-writes`. */
  allowWrites?: boolean;
  origin: "run" | "invocation" | "cli";
  runId?: string;
  invocationId?: string;
  /** The invocation's suite/seed host; without one they behave per run. */
  host?: FixtureHost;
  /** Cancel: setup stops and its running verb is killed. */
  signal?: AbortSignal;
  /** Test seam: the optional `mongodb` driver. */
  loadMongoDriver?: () => Promise<MongoDriverModule | undefined>;
  /** `~/.cairntrace/fixtures` override (tests). */
  ledgerRoot?: string;
  /** `~/.cairntrace/services` override (seed state; tests). */
  seedStateRoot?: string;
  /** Scrubs event text with the consumer's redactor. */
  redact?: (text: string) => string;
  /** Redacts event/ledger values (key-aware) with the consumer's redactor. */
  redactValue?: <T>(value: T) => T;
  onEvent?: (event: FixtureEvent) => void | Promise<void>;
  onVerbStart?: (info: VerbStartInfo) => void | Promise<void>;
  onVerbEnd?: (info: VerbEndInfo) => void;
  now?: () => Date;
}

interface PlanEntry {
  name: string;
  /** Listed in the spec (not only pulled in through needs). */
  direct: boolean;
  reset: boolean;
  with?: Record<string, unknown>;
  write: boolean;
}

interface Instance {
  name: string;
  def: FixtureDefinition;
  scope: FixtureScope;
  params: Record<string, unknown>;
  write: boolean;
  defHash: string;
  outputs: Record<string, unknown>;
  publicOutputs: Record<string, unknown>;
  ensuredAt?: string;
  ensureStatus?: FixtureEventStatus;
  reason?: string;
  dryRun: boolean;
  /** Its ensure (or reset, for a reset-only fixture) ran: teardown is owed. */
  touched: boolean;
  hosted: boolean;
  /** A run-scoped fixture's ledger instance (the run id, or a CLI token). */
  instance?: string;
  /**
   * The ensure found a record by its natural key that it did not create
   * (and that carries no owner.marker): never torn down by cairn.
   */
  adopted?: boolean;
  reset?: { status: FixtureEventStatus; at: string; error?: string };
  teardown?: { status: FixtureEventStatus; at: string; error?: string };
}

function sha(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

/** Ledger values a redactor replaced cannot stand in for the real output. */
function isRedacted(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes("[redacted]");
}

/** Values under a sensitive key (`token`, `password`, …), at any depth. */
function sensitiveValues(value: unknown, out: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (key && isSensitiveEnvKey(key) && value.length >= 4) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) sensitiveValues(item, out, key);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [child, item] of Object.entries(value)) {
      sensitiveValues(item, out, child);
    }
  }
}

/** A mongo verify that is a mongosh script (it cannot be proven read-only). */
function isScriptVerify(def: FixtureDefinition): boolean {
  return (
    def.kind === "mongo" &&
    def.verify !== undefined &&
    !Array.isArray(def.verify) &&
    "script" in def.verify
  );
}

/** `$`, `$.a.b`, `$[0]` — not a `${…}` template. */
function isJsonPath(text: string): boolean {
  return text === "$" || text.startsWith("$.") || text.startsWith("$[");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every fixture a spec's refs pull in, needs first (stable order). */
export function planFixtures(
  refs: readonly SpecFixtureRef[],
  registry: FixturesRegistry,
): PlanEntry[] {
  const parts = refs.map(specFixtureRefParts);
  const known = Object.keys(registry);
  for (const part of parts) {
    if (!registry[part.name]) {
      throw new FixtureSetupError(
        part.name,
        "plan",
        `unknown fixture "${part.name}"; config fixtures: ${
          known.length > 0 ? known.join(", ") : "(none)"
        }`,
      );
    }
  }
  const entries = new Map<string, PlanEntry>();
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string, write: boolean): void => {
    const existing = entries.get(name);
    if (existing) {
      existing.write ||= write;
      for (const need of registry[name]?.needs ?? []) visit(need, write);
      return;
    }
    if (visiting.has(name)) {
      throw new FixtureSetupError(
        name,
        "plan",
        `fixture needs cycle at ${name}`,
      );
    }
    visiting.add(name);
    for (const need of registry[name]?.needs ?? []) {
      if (!registry[need]) {
        throw new FixtureSetupError(
          name,
          "plan",
          `fixture ${name} needs unknown fixture "${need}"`,
        );
      }
      visit(need, write);
    }
    visiting.delete(name);
    entries.set(name, { name, direct: false, reset: false, write });
    order.push(name);
  };
  for (const part of parts) {
    visit(part.name, part.write);
    const entry = entries.get(part.name)!;
    entry.direct = true;
    entry.reset ||= part.reset;
    if (part.with) entry.with = part.with;
  }
  return order.map((name) => entries.get(name)!);
}

export class FixtureRuntime {
  private readonly instances = new Map<string, Instance>();
  /** Fixtures whose teardown this runtime owes, in ensure order. */
  private readonly owed: Instance[] = [];
  /** Every event this runtime emitted (CLI results). */
  readonly events: FixtureEvent[] = [];
  private readonly secrets = new Set<string>();
  private ledgerStates: Promise<Map<string, FixtureLiveState>> | undefined;
  private readonly runStatusEnv: Record<string, string> = {};
  /** Ledger instance of this consumer's run-scoped fixtures. */
  private readonly instanceId: string;

  constructor(private readonly opts: FixtureRuntimeOptions) {
    // The run id; outside a run the CLI's token (`cli_…`), else a fresh id.
    this.instanceId =
      opts.runId ??
      opts.runToken ??
      `${opts.origin}_${randomBytes(6).toString("hex")}`;
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** Outputs for `${fixtures.<name>.<key>}` (secret outputs included). */
  outputs(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      [...this.instances.values()].map((inst) => [inst.name, inst.outputs]),
    );
  }

  /** Literal values to scrub (secret outputs, login tokens, resolved secrets). */
  secretValues(): string[] {
    return [...this.secrets];
  }

  /** `<runDir>/fixtures.json`. */
  runLedger(): RunFixtureLedger {
    return {
      version: 1,
      entries: [...this.instances.values()].map(
        (inst): RunFixtureLedgerEntry => ({
          name: inst.name,
          adapter: inst.def.kind,
          scope: inst.scope,
          ...(inst.ensuredAt ? { ensuredAt: inst.ensuredAt } : {}),
          outputs: inst.publicOutputs,
          ...(inst.ensureStatus ? { status: inst.ensureStatus } : {}),
          ...(inst.reason ? { reason: this.scrub(inst.reason) } : {}),
          ...(inst.reset ? { reset: inst.reset } : {}),
          ...(inst.teardown ? { teardown: inst.teardown } : {}),
        }),
      ),
    };
  }

  /** Fixtures this runtime will tear down (run scope; suite without a host). */
  get pendingTeardowns(): number {
    return this.owed.filter((inst) => !inst.teardown).length;
  }

  private writeBlock(write: boolean): string | undefined {
    return fixtureWriteBlock({
      envName: this.opts.envName,
      ...(this.opts.policyTrait ? { policyTrait: this.opts.policyTrait } : {}),
      ...(this.opts.policyMutations
        ? { policyMutations: this.opts.policyMutations }
        : {}),
      ...(this.opts.allowWrites ? { allowWrites: true } : {}),
      write,
    });
  }

  private writesAllowed(write: boolean): boolean {
    return this.writeBlock(write) === undefined;
  }

  private scrub(text: string): string {
    const scrubbed = scrubDatasourceText(text, [...this.secrets]);
    return this.opts.redact ? this.opts.redact(scrubbed) : scrubbed;
  }

  /**
   * A JSON value with every known secret scrubbed and sensitive keys
   * (`token`, `password`, …) redacted, like the run's artifact writer
   * (never throws).
   */
  private redactValue<T>(value: T): T {
    try {
      const keyed = createArtifactRedactor(undefined, {}, [
        ...this.secrets,
      ]).value(value);
      return this.opts.redactValue
        ? this.opts.redactValue(keyed)
        : (JSON.parse(this.scrub(JSON.stringify(keyed))) as T);
    } catch {
      return "[redacted]" as T;
    }
  }

  private publicOutputs(
    def: FixtureDefinition,
    outputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(outputs)) {
      const spec = def.outputs?.[key];
      out[key] =
        spec !== undefined && typeof spec !== "string" && spec.secret
          ? "[redacted]"
          : value;
    }
    return this.redactValue(out);
  }

  private templateScope(params: Record<string, unknown>): FixtureTemplateScope {
    return {
      with: params,
      fixtures: this.outputs(),
      vars: this.opts.vars ?? {},
      env: this.opts.childEnv,
      ...(this.opts.baseUrl !== undefined
        ? { baseUrl: this.opts.baseUrl }
        : {}),
      ...(this.opts.runToken !== undefined
        ? { runToken: this.opts.runToken }
        : {}),
      now: this.now().toISOString(),
    };
  }

  private session(): DatasourceSession {
    return createDatasourceSession(this.opts.datasourceSet, {
      env: this.opts.childEnv,
      ...(this.opts.vars ? { vars: this.opts.vars } : {}),
      envName: this.opts.envName,
      ...(this.opts.loadMongoDriver
        ? { loadMongoDriver: this.opts.loadMongoDriver }
        : {}),
    });
  }

  private ledgerRoot(): string {
    return this.opts.ledgerRoot ?? defaultLedgerRoot();
  }

  private async liveStates(): Promise<Map<string, FixtureLiveState>> {
    this.ledgerStates ??= readProjectLedger(
      this.opts.project,
      this.ledgerRoot(),
    ).then(foldLedger);
    return this.ledgerStates;
  }

  private async currentSeed(): Promise<{ lastRunAt: string } | undefined> {
    try {
      const state = await new SeedStateStore(this.opts.seedStateRoot).read(
        this.opts.project,
      );
      return state ? { lastRunAt: state.lastRunAt } : undefined;
    } catch {
      return undefined;
    }
  }

  /* ----- events + ledger ----- */

  private async emit(
    inst: Pick<Instance, "name" | "def" | "scope" | "hosted">,
    verb: FixtureVerbName,
    status: FixtureEventStatus,
    durationMs: number,
    extra: {
      outputs?: Record<string, unknown>;
      error?: string;
      reason?: string;
      timedOut?: boolean;
    } = {},
    sink: { hostOnly?: boolean } = {},
  ): Promise<FixtureEvent> {
    const event = {
      ts: this.now().toISOString(),
      type: `fixture.${verb}` as const,
      name: inst.name,
      adapter: inst.def.kind,
      status,
      durationMs: Math.max(0, Math.round(durationMs)),
      scope: inst.scope,
      ...(extra.outputs !== undefined
        ? { outputs: this.redactValue(extra.outputs) }
        : {}),
      ...(extra.error !== undefined ? { error: this.scrub(extra.error) } : {}),
      ...(extra.reason !== undefined
        ? { reason: this.scrub(extra.reason) }
        : {}),
      ...(extra.timedOut ? { timedOut: true } : {}),
    } as FixtureEvent;
    this.events.push(event);
    try {
      if (!sink.hostOnly) await this.opts.onEvent?.(event);
      if (inst.hosted) this.opts.host?.sinks.onEvent?.(event);
    } catch (error) {
      // Teardown has finally semantics: a sink that fails (a full disk, a
      // read-only run directory) must not stop the teardowns still owed.
      if (verb !== "teardown") throw error;
    }
    return event;
  }

  private async recordLedger(
    inst: Instance,
    verb: FixtureVerbName,
    status: FixtureEventStatus,
    extra: {
      error?: string;
      reason?: string;
      seed?: { lastRunAt: string };
      origin?: ProjectLedgerRecord["origin"];
      released?: boolean;
    } = {},
  ): Promise<void> {
    if (verb === "verify") return;
    if (status === "skipped" && !extra.released) return;
    const ttl =
      inst.def.ttl !== undefined ? fixtureDurationMs(inst.def.ttl) : undefined;
    const record = this.ledgerRecord(inst, verb, status, {
      ...extra,
      ...(ttl !== undefined ? { ttlMs: ttl } : {}),
    });
    await appendProjectLedger(record, this.ledgerRoot());
    this.ledgerStates = undefined;
  }

  private ledgerRecord(
    inst: Instance,
    verb: FixtureVerbName,
    status: FixtureEventStatus,
    extra: {
      error?: string;
      reason?: string;
      seed?: { lastRunAt: string };
      origin?: ProjectLedgerRecord["origin"];
      ttlMs?: number;
      released?: boolean;
    },
  ): Omit<ProjectLedgerRecord, "v" | "pid" | "host"> {
    const redactValue = <T>(value: T): T => this.redactValue(value);
    return {
      ts: this.now().toISOString(),
      project: this.opts.project,
      env: this.opts.envName,
      name: inst.name,
      adapter: inst.def.kind,
      scope: inst.scope,
      verb,
      status,
      defHash: inst.defHash,
      ...(verb === "ensure" && status === "ok"
        ? { outputs: redactValue(inst.publicOutputs) }
        : {}),
      ...(Object.keys(inst.params).length > 0
        ? { with: redactValue(inst.params) }
        : {}),
      ...(extra.ttlMs !== undefined ? { ttlMs: extra.ttlMs } : {}),
      ...(extra.seed ? { seed: extra.seed } : {}),
      origin: extra.origin ?? (inst.hosted ? "invocation" : this.opts.origin),
      ...(inst.scope === "run" && inst.instance
        ? { instance: inst.instance }
        : {}),
      ...(verb === "ensure" && status === "ok" && inst.adopted
        ? { adopted: true as const }
        : {}),
      ...(extra.released ? { released: true as const } : {}),
      ...(this.opts.runId ? { runId: this.opts.runId } : {}),
      ...(this.opts.invocationId
        ? { invocationId: this.opts.invocationId }
        : {}),
      ...(extra.error ? { error: this.scrub(extra.error) } : {}),
      ...(extra.reason ? { reason: this.scrub(extra.reason) } : {}),
    };
  }

  /* ----- one verb ----- */

  private verbBudgetMs(def: FixtureDefinition, verb: FixtureVerbName): number {
    const verbDef = def[verb] as { timeoutMs?: number } | string | unknown[];
    const own =
      verbDef && !Array.isArray(verbDef) && typeof verbDef === "object"
        ? verbDef.timeoutMs
        : undefined;
    return own ?? def.timeoutMs ?? DEFAULT_VERB_TIMEOUT_MS;
  }

  private verbContext(
    inst: Instance,
    verb: FixtureVerbName,
    opts: {
      deadline: number;
      signal?: AbortSignal;
      session: DatasourceSession;
    },
  ): FixtureVerbContext {
    const scope = this.templateScope(inst.params);
    const def = inst.def;
    const resolved = (value: unknown): unknown =>
      value === undefined
        ? undefined
        : resolveFixtureTemplate(value, scope, this.secrets);
    const fixture = {
      ...def,
      [verb]: resolved(def[verb]),
      ...(def.kind === "http"
        ? {
            ...(def.login ? { login: resolved(def.login) } : {}),
            ...(def.headers ? { headers: resolved(def.headers) } : {}),
            ...(def.baseUrl ? { baseUrl: resolved(def.baseUrl) } : {}),
          }
        : {}),
    } as FixtureDefinition;
    const marker = def.owner?.marker
      ? (resolved(def.owner.marker) as Record<string, unknown>)
      : undefined;
    return {
      name: inst.name,
      verb,
      scope: inst.scope,
      fixture,
      verbDef: fixture[verb],
      params: inst.params,
      outputs: inst.outputs,
      ...(marker ? { marker } : {}),
      exactlyOne: def.owner?.exactlyOne === true,
      writesAllowed: this.writesAllowed(inst.write),
      configDir: this.opts.configDir,
      childEnv: this.opts.childEnv,
      contextEnv: { ...this.opts.contextEnv, ...this.runStatusEnv },
      ...(this.opts.selectedTvaultKeys
        ? { selectedTvaultKeys: this.opts.selectedTvaultKeys }
        : {}),
      datasources: opts.session,
      ...(this.opts.datasourceSet
        ? { datasourceSet: this.opts.datasourceSet }
        : {}),
      envName: this.opts.envName,
      vars: this.opts.vars ?? {},
      ...(this.opts.baseUrl !== undefined
        ? { baseUrl: this.opts.baseUrl }
        : {}),
      deadline: opts.deadline,
      ...(opts.signal ? { signal: opts.signal } : {}),
      secrets: this.secrets,
    };
  }

  /**
   * Run one verb (no events). Template errors and adapter failures come
   * back as FixtureVerbError; the caller records them.
   */
  private async execVerb(
    inst: Instance,
    verb: FixtureVerbName,
    opts: { signal?: AbortSignal; budgetMs?: number } = {},
  ): Promise<FixtureVerbOutcome> {
    const budget = opts.budgetMs ?? this.verbBudgetMs(inst.def, verb);
    const session = this.session();
    try {
      let ctx: FixtureVerbContext;
      try {
        ctx = this.verbContext(inst, verb, {
          deadline: Date.now() + budget,
          session,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (error) {
        if (error instanceof FixtureTemplateError) {
          throw new FixtureVerbError(`${verb}: ${error.message}`);
        }
        throw error;
      }
      switch (inst.def.kind) {
        case "exec":
          return await runExecVerb(ctx);
        case "mongo":
          return await runMongoVerb(ctx);
        case "http":
          return await runHttpVerb(ctx);
      }
    } catch (error) {
      if (error instanceof FixtureVerbError) throw error;
      throw new FixtureVerbError(
        scrubDatasourceText((error as Error).message, [...this.secrets]),
      );
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Outputs of a verb result (`$…` paths or templates). */
  private computeOutputs(
    inst: Instance,
    verb: FixtureVerbName,
    result: unknown,
  ): Record<string, unknown> {
    const out = this.readOutputs(inst, verb, result);
    // Outputs under a sensitive key are secrets too: scrubbed from events,
    // the ledger and (registered by the runner) the run's evidence.
    const found = new Set<string>();
    sensitiveValues(out, found);
    for (const value of found) this.secrets.add(value);
    return out;
  }

  private readOutputs(
    inst: Instance,
    verb: FixtureVerbName,
    result: unknown,
  ): Record<string, unknown> {
    const def = inst.def;
    if (!def.outputs) {
      return def.kind === "exec" && isPlainObject(result) ? { ...result } : {};
    }
    const out: Record<string, unknown> = {};
    const scope = this.templateScope(inst.params);
    for (const [key, spec] of Object.entries(def.outputs)) {
      const from = typeof spec === "string" ? spec : spec.from;
      let value: unknown;
      if (isJsonPath(from)) {
        if (result === undefined) {
          throw new FixtureVerbError(
            `output ${key}: the ${verb} produced no result to read ${from} from${
              def.kind === "exec" ? " (its last stdout line was not JSON)" : ""
            }`,
          );
        }
        const hit = readPath(result, from);
        if (!hit.exists) {
          throw new FixtureVerbError(
            `output ${key}: ${from} is not in the ${verb} result`,
          );
        }
        value = hit.value;
      } else {
        try {
          value = resolveFixtureTemplate(from, scope, this.secrets);
        } catch (error) {
          throw new FixtureVerbError(
            `output ${key}: ${(error as Error).message}`,
          );
        }
      }
      if (typeof spec !== "string" && spec.secret) {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (text && text.length >= 4) this.secrets.add(text);
      }
      out[key] = value;
    }
    return out;
  }

  /* ----- setup ----- */

  private instanceFor(entry: PlanEntry): Instance {
    const existing = this.instances.get(entry.name);
    if (existing) return existing;
    const def = this.opts.registry[entry.name]!;
    const merged = { ...def.with, ...entry.with };
    let params: Record<string, unknown>;
    try {
      params = resolveFixtureTemplate(
        merged,
        this.templateScope({}),
        this.secrets,
      );
    } catch (error) {
      throw new FixtureSetupError(
        entry.name,
        "plan",
        `fixture ${entry.name} with: ${(error as Error).message}`,
      );
    }
    const inst: Instance = {
      name: entry.name,
      def,
      scope: fixtureScope(def),
      params,
      write: entry.write,
      defHash: sha({ def, with: merged }),
      outputs: {},
      publicOutputs: {},
      dryRun: false,
      touched: false,
      hosted: false,
      ...(fixtureScope(def) === "run" ? { instance: this.instanceId } : {}),
    };
    return inst;
  }

  /**
   * Ensure the spec's fixtures (needs first) and run the `.reset`s. Throws
   * FixtureSetupError naming the fixture that failed; whatever was ensured
   * before it is still owed a teardown.
   */
  async setup(refs: readonly SpecFixtureRef[]): Promise<void> {
    const plan = planFixtures(refs, this.opts.registry);
    for (const entry of plan) {
      this.throwIfCancelled(entry.name);
      const inst = await this.use(entry);
      if (entry.reset && inst.def.ensure !== undefined) {
        this.throwIfCancelled(entry.name);
        await this.runReset(inst);
      }
    }
  }

  private throwIfCancelled(name: string): void {
    if (this.opts.signal?.aborted) {
      throw new FixtureSetupError(
        name,
        "ensure",
        `cancelled before fixture ${name}`,
        0,
        false,
        true,
      );
    }
  }

  /** Ensure one fixture (reset-only fixtures are reset instead). */
  private async use(entry: PlanEntry): Promise<Instance> {
    const already = this.instances.get(entry.name);
    if (already) return already;
    const inst = this.instanceFor(entry);
    this.instances.set(inst.name, inst);
    if (inst.def.ensure === undefined) {
      await this.runReset(inst);
      return inst;
    }
    if (inst.scope !== "run" && this.opts.host) {
      await this.useHosted(inst);
      return inst;
    }
    await this.ensureInstance(inst);
    return inst;
  }

  private async useHosted(inst: Instance): Promise<void> {
    const host = this.opts.host!;
    const key = `${this.opts.envName}\u0000${inst.name}\u0000${inst.defHash}`;
    const startedAt = Date.now();
    const acquired = host.acquire(key, async () => {
      inst.hosted = true;
      try {
        await this.ensureInstance(inst);
      } finally {
        // The invocation tears it down when it ends — after a failed ensure
        // too, which may have left partial data — with this runtime's
        // environment (a fresh datasource session per verb).
        if (inst.scope === "suite" && inst.touched && inst.def.teardown) {
          host.addTeardown(inst.name, async () => {
            await this.teardownOne(inst, { hostOnly: true });
          });
        }
      }
      return {
        adapter: inst.def.kind,
        scope: inst.scope,
        outputs: inst.outputs,
        publicOutputs: inst.publicOutputs,
        secrets: [...this.secrets],
        ...(inst.ensuredAt ? { ensuredAt: inst.ensuredAt } : {}),
        status: inst.ensureStatus ?? "ok",
        ...(inst.reason ? { reason: inst.reason } : {}),
        dryRun: inst.dryRun,
      };
    });
    if (acquired.first) {
      await acquired.value;
      return;
    }
    let shared: HostedFixture;
    try {
      shared = await acquired.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emit(inst, "ensure", "failed", Date.now() - startedAt, {
        error: `${inst.scope} fixture failed earlier in this invocation: ${message}`,
      });
      throw new FixtureSetupError(
        inst.name,
        "ensure",
        `fixture ${inst.name}: ${message}`,
      );
    }
    inst.outputs = shared.outputs;
    inst.publicOutputs = shared.publicOutputs;
    for (const secret of shared.secrets) this.secrets.add(secret);
    if (shared.ensuredAt) inst.ensuredAt = shared.ensuredAt;
    inst.ensureStatus = "skipped";
    inst.dryRun = shared.dryRun;
    inst.reason = `${inst.scope} fixture ${
      shared.dryRun ? "checked (dry-run)" : "ensured"
    } earlier in this invocation`;
    await this.emit(inst, "ensure", "skipped", Date.now() - startedAt, {
      outputs: inst.publicOutputs,
      reason: inst.reason,
    });
  }

  private async ensureInstance(inst: Instance): Promise<void> {
    if (!this.writesAllowed(inst.write)) {
      await this.dryRunEnsure(inst);
      return;
    }
    if (inst.scope !== "run") {
      const fresh = await this.freshness(inst);
      if (fresh.fresh) {
        inst.outputs = fresh.state.outputs ?? {};
        inst.publicOutputs = inst.outputs;
        if (fresh.state.ensuredAt) inst.ensuredAt = fresh.state.ensuredAt;
        inst.ensureStatus = "skipped";
        inst.reason = fresh.reason;
        await this.emit(inst, "ensure", "skipped", fresh.durationMs, {
          outputs: inst.publicOutputs,
          reason: fresh.reason,
        });
        return;
      }
    }
    const budgetMs = this.verbBudgetMs(inst.def, "ensure");
    await this.opts.onVerbStart?.({
      name: inst.name,
      verb: "ensure",
      budgetMs,
      scope: inst.scope,
    });
    const startedAt = Date.now();
    inst.touched = true;
    if (this.ownsTeardown(inst)) this.owe(inst);
    let outcome: FixtureVerbOutcome;
    try {
      outcome = await this.execVerb(inst, "ensure", {
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        budgetMs,
      });
      // http find-or-create found a record it did not create (no marker on
      // it): it is used, never torn down.
      inst.adopted =
        inst.def.kind === "http" &&
        isPlainObject(outcome.result) &&
        outcome.result["owned"] === false;
      inst.outputs = this.computeOutputs(inst, "ensure", outcome.result);
    } catch (error) {
      await this.failVerb(inst, "ensure", startedAt, error);
    }
    inst.publicOutputs = this.publicOutputs(inst.def, inst.outputs);
    inst.ensuredAt = this.now().toISOString();
    inst.ensureStatus = "ok";
    const durationMs = Date.now() - startedAt;
    await this.emit(inst, "ensure", "ok", durationMs, {
      outputs: inst.publicOutputs,
    });
    this.opts.onVerbEnd?.({
      name: inst.name,
      verb: "ensure",
      status: "ok",
      durationMs,
    });
    const seed = inst.scope === "seed" ? await this.currentSeed() : undefined;
    await this.recordLedger(inst, "ensure", "ok", seed ? { seed } : {});
    if (inst.def.verify !== undefined) {
      const verified = await this.runVerify(inst);
      if (!verified.ok) {
        throw new FixtureSetupError(
          inst.name,
          "verify",
          `fixture ${inst.name} verify failed after ensure: ${verified.error}`,
          verified.durationMs,
        );
      }
    }
  }

  /**
   * This runtime tears it down: run scope always; suite scope when no
   * invocation host shares it; seed scope never (it lives with the seed).
   */
  private ownsTeardown(inst: Instance): boolean {
    if (inst.scope === "run") return true;
    return inst.scope === "suite" && !inst.hosted && !this.opts.host;
  }

  private owe(inst: Instance): void {
    if (inst.def.teardown === undefined) return;
    if (!this.owed.includes(inst)) this.owed.push(inst);
  }

  /** Record a failed verb and throw the setup error. */
  private async failVerb(
    inst: Instance,
    verb: FixtureVerbName,
    startedAt: number,
    error: unknown,
  ): Promise<never> {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof FixtureVerbError && error.timedOut;
    const cancelled = this.opts.signal?.aborted === true;
    if (verb === "ensure") inst.ensureStatus = "failed";
    if (verb === "reset") {
      inst.reset = {
        status: "failed",
        at: this.now().toISOString(),
        error: this.scrub(message),
      };
    }
    await this.emit(inst, verb, "failed", durationMs, {
      error: message,
      ...(timedOut ? { timedOut: true } : {}),
    });
    this.opts.onVerbEnd?.({
      name: inst.name,
      verb,
      status: "failed",
      durationMs,
      error: this.scrub(message),
    });
    await this.recordLedger(inst, verb, "failed", { error: message });
    throw new FixtureSetupError(
      inst.name,
      verb,
      this.scrub(`fixture ${inst.name} ${verb} failed: ${message}`),
      durationMs,
      timedOut,
      cancelled,
    );
  }

  private async freshness(inst: Instance): Promise<
    | {
        fresh: true;
        state: FixtureLiveState;
        reason: string;
        durationMs: number;
      }
    | { fresh: false }
  > {
    const startedAt = Date.now();
    const state = (await this.liveStates()).get(
      ledgerKey(this.opts.envName, inst.name),
    );
    if (
      !state ||
      state.state !== "live" ||
      state.fromReset ||
      state.defHash !== inst.defHash
    ) {
      return { fresh: false };
    }
    // Secret outputs are never recorded: the ledger cannot stand in for them.
    const hasSecretOutputs = Object.values(inst.def.outputs ?? {}).some(
      (spec) => typeof spec !== "string" && spec.secret === true,
    );
    if (hasSecretOutputs || isRedacted(state.outputs)) return { fresh: false };
    const ttlMs =
      inst.def.ttl !== undefined ? fixtureDurationMs(inst.def.ttl) : undefined;
    const ageMs =
      state.ensuredAt !== undefined
        ? this.now().getTime() - Date.parse(state.ensuredAt)
        : Number.POSITIVE_INFINITY;
    if (ttlMs !== undefined ? ageMs >= ttlMs : inst.scope !== "seed") {
      return { fresh: false };
    }
    if (inst.scope === "seed" && (await this.reseededSince(state))) {
      return { fresh: false };
    }
    if (state.adopted) inst.adopted = true;
    // Verify against the recorded outputs before trusting the ledger.
    if (inst.def.verify !== undefined) {
      inst.outputs = state.outputs ?? {};
      const verified = await this.runVerify(inst, { quiet: true });
      if (!verified.ok) return { fresh: false };
    }
    const age = Math.round(ageMs / 1000);
    return {
      fresh: true,
      state,
      reason: `fresh: ensured ${state.ensuredAt ?? "earlier"} (${age}s ago${
        ttlMs !== undefined ? `, ttl ${Math.round(ttlMs / 1000)}s` : ""
      }${inst.scope === "seed" ? ", no reseed since" : ""}${
        inst.def.verify !== undefined ? ", verify ok" : ""
      })`,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Did the services seed run after this fixture was ensured? An invocation
   * that watched its own seed knows; otherwise the last seed run an
   * invocation recorded, then the services seed state (whose timestamp also
   * moves when a freshnessCheck passes — conservative).
   */
  private async reseededSince(state: FixtureLiveState): Promise<boolean> {
    const ensuredAt = state.ensuredAt ? Date.parse(state.ensuredAt) : 0;
    const after = (at: string | undefined): boolean =>
      at !== undefined && Date.parse(at) > ensuredAt;
    const observed = this.opts.host?.seed;
    if (observed?.ran && after(observed.at)) return true;
    if (after(await lastSeedRun(this.opts.project, this.ledgerRoot()))) {
      return true;
    }
    if (observed) return false;
    return after((await this.currentSeed())?.lastRunAt);
  }

  private async dryRunEnsure(inst: Instance): Promise<void> {
    inst.dryRun = true;
    inst.ensureStatus = "dry-run";
    const startedAt = Date.now();
    const why = this.writeBlock(inst.write) ?? "fixture writes are off";
    // The ledger's last ensure of the SAME definition and parameters (the
    // hash covers `with`): another instance's ids would aim the steps at
    // the wrong record.
    const recorded = await this.matchingLiveState(inst);
    const recordedOutputs = this.ledgerOutputs(recorded);
    if (recorded?.adopted) inst.adopted = true;
    if (inst.def.verify !== undefined && !isScriptVerify(inst.def)) {
      // verify may read the fixture's own recorded outputs.
      inst.outputs = recordedOutputs;
      const verified = await this.runVerify(inst, { quiet: true });
      if (!verified.ok) {
        const message = `fixture ${inst.name} is not in place and writes are off (${why}): verify failed: ${verified.error}`;
        await this.emit(inst, "ensure", "failed", Date.now() - startedAt, {
          error: message,
          reason: `dry-run: ${why}`,
        });
        throw new FixtureSetupError(
          inst.name,
          "ensure",
          this.scrub(message),
          Date.now() - startedAt,
        );
      }
      try {
        inst.outputs = this.computeOutputs(inst, "verify", verified.result);
      } catch {
        inst.outputs = recordedOutputs;
      }
      inst.reason = `dry-run: ${why}; verify ok`;
    } else {
      inst.outputs = recordedOutputs;
      inst.reason = `dry-run: ${why}; ${
        recorded
          ? `outputs from the ledger (ensured ${recorded.ensuredAt ?? "earlier"} with the same definition and parameters)`
          : `${
              isScriptVerify(inst.def)
                ? "the verify script cannot run while writes are off, and "
                : "no verify verb and "
            }no ledger record of this definition and parameters: outputs unavailable`
      }`;
    }
    inst.publicOutputs = this.publicOutputs(inst.def, inst.outputs);
    await this.emit(inst, "ensure", "dry-run", Date.now() - startedAt, {
      outputs: inst.publicOutputs,
      reason: inst.reason,
    });
    await this.recordLedger(inst, "ensure", "dry-run", {
      reason: inst.reason,
    });
  }

  /** Recorded outputs a redactor did not replace (a redacted one is unknown). */
  private ledgerOutputs(
    state: FixtureLiveState | undefined,
  ): Record<string, unknown> {
    if (!state || state.state === "torn-down" || state.state === "released") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(state.outputs ?? {}).filter(
        ([, value]) => !isRedacted(value),
      ),
    );
  }

  /** The newest ledger state of a fixture here (any instance). */
  private async liveState(name: string): Promise<FixtureLiveState | undefined> {
    return fixtureStates(await this.liveStates(), this.opts.envName, name)[0];
  }

  /** The newest live state recorded for this definition and parameters. */
  private async matchingLiveState(
    inst: Instance,
  ): Promise<FixtureLiveState | undefined> {
    return fixtureStates(
      await this.liveStates(),
      this.opts.envName,
      inst.name,
    ).find((state) => state.state === "live" && state.defHash === inst.defHash);
  }

  private async runVerify(
    inst: Instance,
    opts: { quiet?: boolean } = {},
  ): Promise<
    | { ok: true; result: unknown; durationMs: number }
    | { ok: false; error: string; durationMs: number }
  > {
    const startedAt = Date.now();
    const budgetMs = this.verbBudgetMs(inst.def, "verify");
    if (!opts.quiet) {
      await this.opts.onVerbStart?.({
        name: inst.name,
        verb: "verify",
        budgetMs,
        scope: inst.scope,
      });
    }
    try {
      const outcome = await this.execVerb(inst, "verify", {
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        budgetMs,
      });
      const durationMs = Date.now() - startedAt;
      await this.emit(inst, "verify", "ok", durationMs);
      if (!opts.quiet) {
        this.opts.onVerbEnd?.({
          name: inst.name,
          verb: "verify",
          status: "ok",
          durationMs,
        });
      }
      return { ok: true, result: outcome.result, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = this.scrub((error as Error).message);
      await this.emit(inst, "verify", "failed", durationMs, {
        error: message,
        ...(error instanceof FixtureVerbError && error.timedOut
          ? { timedOut: true }
          : {}),
      });
      if (!opts.quiet) {
        this.opts.onVerbEnd?.({
          name: inst.name,
          verb: "verify",
          status: "failed",
          durationMs,
          error: message,
        });
      }
      return { ok: false, error: message, durationMs };
    }
  }

  private async runReset(inst: Instance): Promise<void> {
    if (inst.def.reset === undefined) {
      throw new FixtureSetupError(
        inst.name,
        "reset",
        `fixture ${inst.name} has no reset verb`,
      );
    }
    const block = this.writeBlock(inst.write);
    if (block !== undefined) {
      inst.dryRun = inst.def.ensure === undefined ? true : inst.dryRun;
      const reason = `dry-run: ${block}`;
      inst.reset = { status: "dry-run", at: this.now().toISOString() };
      if (inst.def.ensure === undefined) {
        inst.ensureStatus = "dry-run";
        inst.reason = reason;
        inst.outputs = this.ledgerOutputs(await this.matchingLiveState(inst));
        inst.publicOutputs = this.publicOutputs(inst.def, inst.outputs);
      }
      await this.emit(inst, "reset", "dry-run", 0, { reason });
      await this.recordLedger(inst, "reset", "dry-run", { reason });
      return;
    }
    const budgetMs = this.verbBudgetMs(inst.def, "reset");
    await this.opts.onVerbStart?.({
      name: inst.name,
      verb: "reset",
      budgetMs,
      scope: inst.scope,
    });
    const startedAt = Date.now();
    if (inst.def.ensure === undefined) {
      // A reset-only fixture is "ensured" by its reset.
      inst.touched = true;
      if (this.ownsTeardown(inst)) this.owe(inst);
    }
    try {
      const outcome = await this.execVerb(inst, "reset", {
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        budgetMs,
      });
      if (inst.def.ensure === undefined) {
        inst.outputs = this.computeOutputs(inst, "reset", outcome.result);
        inst.publicOutputs = this.publicOutputs(inst.def, inst.outputs);
      }
    } catch (error) {
      await this.failVerb(inst, "reset", startedAt, error);
    }
    const durationMs = Date.now() - startedAt;
    inst.reset = { status: "ok", at: this.now().toISOString() };
    if (inst.def.ensure === undefined) {
      inst.ensureStatus = "ok";
      inst.ensuredAt = inst.reset.at;
    }
    await this.emit(
      inst,
      "reset",
      "ok",
      durationMs,
      inst.def.ensure === undefined ? { outputs: inst.publicOutputs } : {},
    );
    this.opts.onVerbEnd?.({
      name: inst.name,
      verb: "reset",
      status: "ok",
      durationMs,
    });
    await this.recordLedger(inst, "reset", "ok");
  }

  /* ----- teardown ----- */

  /**
   * Why the teardown cannot run: it reads one of the fixture's own outputs
   * (`${fixtures.<self>.<key>}`) that was never recorded. Undefined when it
   * can run (other template problems fail the teardown as usual).
   */
  private missingOwnOutputs(inst: Instance): string | undefined {
    try {
      resolveFixtureTemplate(
        inst.def.teardown,
        this.templateScope(inst.params),
        new Set(),
      );
      return undefined;
    } catch (error) {
      if (
        error instanceof FixtureTemplateError &&
        error.reference.startsWith(`fixtures.${inst.name}.`)
      ) {
        return `no recorded outputs to tear it down with (${error.message}${
          inst.ensureStatus === "failed" ? "; its ensure failed" : ""
        })`;
      }
      return undefined;
    }
  }

  /**
   * Tear down every fixture this runtime owes, newest first. Runs after a
   * failure or a cancel too; a failure is recorded and the rest still run.
   * Returns the fixtures whose teardown failed.
   */
  async teardown(
    runStatus?: "passed" | "failed" | "errored",
  ): Promise<Array<{ name: string; error: string }>> {
    if (runStatus) this.runStatusEnv["CAIRN_RUN_STATUS"] = runStatus;
    const failed: Array<{ name: string; error: string }> = [];
    for (const inst of this.owed.toReversed()) {
      if (inst.teardown) continue;
      const error = await this.teardownOne(
        inst,
        runStatus ? { runStatus } : {},
      );
      if (error) failed.push({ name: inst.name, error });
    }
    return failed;
  }

  private async teardownOne(
    inst: Instance,
    /** Ledger origin override (a sweep). */
    /** The invocation tears down a suite fixture: only its sinks hear it. */
    opts: {
      runStatus?: "passed" | "failed" | "errored";
      origin?: ProjectLedgerRecord["origin"];
      hostOnly?: boolean;
    } = {},
  ): Promise<string | undefined> {
    if (inst.teardown) return undefined;
    if (opts.runStatus) {
      this.runStatusEnv["CAIRN_RUN_STATUS"] = opts.runStatus;
    }
    // The invocation tears suite fixtures down after every run: no single
    // run status applies, so none is passed.
    if (opts.hostOnly) delete this.runStatusEnv["CAIRN_RUN_STATUS"];
    const sinkOpts = { hostOnly: opts.hostOnly === true };
    const block = this.writeBlock(inst.write);
    if (block !== undefined) {
      inst.teardown = { status: "dry-run", at: this.now().toISOString() };
      await this.emit(
        inst,
        "teardown",
        "dry-run",
        0,
        { reason: `dry-run: ${block}` },
        sinkOpts,
      );
      return undefined;
    }
    // Nothing cairn may or can tear down: a record the ensure adopted (found
    // by its natural key, without the owner marker), or a teardown that
    // needs outputs the ensure never recorded (it failed first).
    const left = inst.adopted
      ? "the ensure found an existing record it did not create (no owner.marker on it): left in place"
      : this.missingOwnOutputs(inst);
    if (left !== undefined) {
      inst.teardown = { status: "skipped", at: this.now().toISOString() };
      await this.emit(
        inst,
        "teardown",
        "skipped",
        0,
        { reason: left },
        sinkOpts,
      );
      // An adopted record is released for good; a failed ensure's leftovers
      // stay visible (state failed) until a sweep --apply releases them.
      if (inst.adopted || opts.origin === "sweep") {
        await this.recordLedger(inst, "teardown", "skipped", {
          reason: left,
          released: true,
          ...(opts.origin ? { origin: opts.origin } : {}),
        });
      }
      return undefined;
    }
    const cancelled = this.opts.signal?.aborted === true;
    const budgetMs = cancelled
      ? Math.min(
          this.verbBudgetMs(inst.def, "teardown"),
          CANCELLED_TEARDOWN_BUDGET_MS,
        )
      : this.verbBudgetMs(inst.def, "teardown");
    try {
      if (inst.hosted) {
        this.opts.host?.sinks.onVerbStart?.({
          name: inst.name,
          verb: "teardown",
          budgetMs,
          scope: inst.scope,
        });
      } else {
        await this.opts.onVerbStart?.({
          name: inst.name,
          verb: "teardown",
          budgetMs,
          scope: inst.scope,
        });
      }
    } catch {
      // Finally semantics: a failing sink never stops a teardown.
    }
    const startedAt = Date.now();
    // Finally semantics: never pass the (possibly aborted) run signal.
    let error: string | undefined;
    let timedOut = false;
    try {
      await this.execVerb(inst, "teardown", { budgetMs });
    } catch (caught) {
      error = this.scrub((caught as Error).message);
      timedOut = caught instanceof FixtureVerbError && caught.timedOut;
    }
    const durationMs = Date.now() - startedAt;
    const status: FixtureEventStatus = error === undefined ? "ok" : "failed";
    inst.teardown = {
      status,
      at: this.now().toISOString(),
      ...(error ? { error } : {}),
    };
    await this.emit(
      inst,
      "teardown",
      status,
      durationMs,
      {
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      },
      sinkOpts,
    );
    const end = {
      name: inst.name,
      verb: "teardown" as const,
      status,
      durationMs,
      ...(error ? { error } : {}),
    };
    try {
      if (inst.hosted) this.opts.host?.sinks.onVerbEnd?.(end);
      else this.opts.onVerbEnd?.(end);
    } catch {
      // Finally semantics: a failing sink never stops a teardown.
    }
    await this.recordLedger(inst, "teardown", status, {
      ...(error ? { error } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    return error;
  }

  /**
   * SIGINT/SIGTERM: run the exec teardowns still owed, synchronously (no
   * promise continuation runs before the process exits); other adapters
   * are reported skipped and stay live in the ledger for `cairn fixtures
   * sweep`. The handler is prepended, so arm it BEFORE the spec teardown
   * arms its own (that one then runs first, like the normal path). Returns
   * the disposer.
   */
  armSignal(writeEventSync: (event: FixtureEvent) => void): () => void {
    let fired = false;
    const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
    const dispose = (): void => {
      for (const [signal, handler] of handlers) {
        process.removeListener(signal, handler);
      }
      handlers.clear();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        dispose();
        if (!fired) {
          fired = true;
          this.signalTeardown(signal, writeEventSync);
        }
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal);
        }
      };
      handlers.set(signal, handler);
      process.prependListener(signal, handler);
    }
    return dispose;
  }

  private signalTeardown(
    signal: "SIGINT" | "SIGTERM",
    writeEventSync: (event: FixtureEvent) => void,
  ): void {
    const deadline = Date.now() + SIGNAL_TEARDOWN_BUDGET_MS;
    this.runStatusEnv["CAIRN_RUN_STATUS"] = "errored";
    for (const inst of this.owed.toReversed()) {
      if (inst.teardown || !inst.touched) continue;
      const base = {
        ts: new Date().toISOString(),
        type: "fixture.teardown" as const,
        name: inst.name,
        adapter: inst.def.kind,
        scope: inst.scope,
        signal,
      };
      if (
        inst.def.kind !== "exec" ||
        inst.adopted ||
        !this.writesAllowed(inst.write)
      ) {
        inst.teardown = { status: "skipped", at: base.ts };
        writeEventSync({
          ...base,
          status: "skipped",
          durationMs: 0,
          reason: `${signal}: ${inst.def.kind} teardown runs asynchronously; it stays live in the fixture ledger for \`cairn fixtures sweep\``,
        });
        continue;
      }
      const startedAt = Date.now();
      const remaining = deadline - startedAt;
      let error: string | undefined;
      if (remaining <= 0) {
        error = "signal teardown budget exhausted";
      } else {
        const session = this.session();
        try {
          runExecVerbSync(
            this.verbContext(inst, "teardown", {
              deadline:
                startedAt +
                Math.min(remaining, this.verbBudgetMs(inst.def, "teardown")),
              session,
            }),
          );
        } catch (caught) {
          error = this.scrub((caught as Error).message);
        }
      }
      const status: FixtureEventStatus = error ? "failed" : "ok";
      inst.teardown = { status, at: new Date().toISOString() };
      writeEventSync({
        ...base,
        status,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
      this.appendLedgerSync(inst, status, error);
    }
  }

  private appendLedgerSync(
    inst: Instance,
    status: FixtureEventStatus,
    error: string | undefined,
  ): void {
    try {
      const root = this.ledgerRoot();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      appendFileSync(
        projectLedgerPath(this.opts.project, root),
        `${JSON.stringify({
          v: 1,
          pid: process.pid,
          host: hostname(),
          ...this.ledgerRecord(
            inst,
            "teardown",
            status,
            error ? { error } : {},
          ),
        })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // The process is exiting; the ledger is best-effort here.
    }
  }

  /* ----- CLI verbs ----- */

  /** `cairn fixtures ensure <name>`: ensure it (and its needs); no teardown. */
  async ensureOne(
    name: string,
    opts: { with?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.setup([
      { use: name, ...(opts.with ? { with: opts.with } : {}) },
    ]);
  }

  /** `cairn fixtures reset <name>`: ensure its needs, then reset it. */
  async resetOne(
    name: string,
    opts: { with?: Record<string, unknown> } = {},
  ): Promise<void> {
    const plan = planFixtures(
      [{ use: name, ...(opts.with ? { with: opts.with } : {}) }],
      this.opts.registry,
    );
    for (const entry of plan) {
      if (entry.name === name) {
        const inst = this.instanceFor(entry);
        this.instances.set(name, inst);
        await this.adoptLedgerOutputs(inst);
        await this.runReset(inst);
      } else {
        await this.use(entry);
      }
    }
  }

  /**
   * `cairn fixtures teardown <name>` / sweep: tear it down with the outputs
   * and parameters its ensure recorded in the ledger — one instance (a
   * run-scoped fixture has one per run), by default the newest. Returns the
   * error when it failed.
   */
  async teardownRecorded(
    name: string,
    /** The ledger instance of a run-scoped fixture. */
    opts: {
      with?: Record<string, unknown>;
      origin?: "cli" | "sweep";
      instance?: string;
    } = {},
  ): Promise<{ status: FixtureEventStatus; error?: string }> {
    const def = this.opts.registry[name];
    if (!def) {
      throw new FixtureSetupError(name, "plan", `unknown fixture "${name}"`);
    }
    const states = fixtureStates(
      await this.liveStates(),
      this.opts.envName,
      name,
    );
    const state =
      opts.instance !== undefined
        ? states.find((candidate) => candidate.instance === opts.instance)
        : states[0];
    // A fresh instance per call: the CLI tears several instances down.
    this.instances.delete(name);
    const inst = this.instanceFor({
      name,
      direct: true,
      reset: false,
      write: false,
      ...(opts.with
        ? { with: opts.with }
        : state?.with
          ? { with: state.with }
          : {}),
    });
    if (state) {
      if (state.instance !== undefined) inst.instance = state.instance;
      else delete inst.instance;
    }
    if (state?.adopted) inst.adopted = true;
    this.instances.set(name, inst);
    // `${fixtures.<need>.<key>}` in the teardown reads the needs' records
    // (the same run's instance of a run-scoped need, when there is one).
    for (const need of def.needs ?? []) {
      if (!this.opts.registry[need]) continue;
      const needStates = fixtureStates(
        await this.liveStates(),
        this.opts.envName,
        need,
      );
      const needState =
        needStates.find(
          (candidate) =>
            inst.instance !== undefined && candidate.instance === inst.instance,
        ) ?? needStates[0];
      this.instances.delete(need);
      const needInst = this.instanceFor({
        name: need,
        direct: false,
        reset: false,
        write: false,
      });
      needInst.outputs = this.ledgerOutputs(needState);
      this.instances.set(need, needInst);
    }
    inst.outputs = this.ledgerOutputs(state);
    inst.touched = true;
    if (def.teardown === undefined) {
      await this.emit(inst, "teardown", "skipped", 0, {
        reason: "no teardown verb",
      });
      return { status: "skipped" };
    }
    const error = await this.teardownOne(inst, {
      origin: opts.origin ?? "cli",
    });
    return error === undefined
      ? { status: inst.teardown?.status ?? "ok" }
      : { status: "failed", error };
  }

  /** `cairn fixtures status --verify`: verify with the recorded outputs. */
  async verifyRecorded(name: string): Promise<{
    ok: boolean;
    error?: string;
    skipped?: true;
    reason?: string;
  }> {
    const def = this.opts.registry[name];
    if (!def) {
      throw new FixtureSetupError(name, "plan", `unknown fixture "${name}"`);
    }
    if (def.verify === undefined) return { ok: true, skipped: true };
    const block = this.writeBlock(false);
    if (isScriptVerify(def) && block !== undefined) {
      return {
        ok: true,
        skipped: true,
        reason: `the verify script cannot run while writes are off (${block})`,
      };
    }
    const state = await this.liveState(name);
    this.instances.delete(name);
    const inst = this.instanceFor({
      name,
      direct: true,
      reset: false,
      write: false,
      ...(state?.with ? { with: state.with } : {}),
    });
    for (const need of def.needs ?? []) {
      if (this.instances.has(need) || !this.opts.registry[need]) continue;
      const needInst = this.instanceFor({
        name: need,
        direct: false,
        reset: false,
        write: false,
      });
      needInst.outputs = this.ledgerOutputs(await this.liveState(need));
      this.instances.set(need, needInst);
    }
    inst.outputs = this.ledgerOutputs(state);
    this.instances.set(name, inst);
    const verified = await this.runVerify(inst, { quiet: true });
    return verified.ok ? { ok: true } : { ok: false, error: verified.error };
  }

  /** Outputs the ledger recorded for this definition and parameters. */
  private async adoptLedgerOutputs(inst: Instance): Promise<void> {
    inst.outputs = this.ledgerOutputs(await this.matchingLiveState(inst));
    inst.publicOutputs = this.publicOutputs(inst.def, inst.outputs);
  }
}
