import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { UnknownEnvironmentError } from "../../core/config/runtimeContext";
import {
  type BrowseTarget,
  redactBrowseUrl,
  resolveBrowseTarget,
} from "../../core/discovery/browseTarget";
import {
  closeSession,
  DiscoverySetupError,
  journalRefusal,
  openSession,
  resumeSession,
  type DiscoverySessionHandle,
} from "../../core/discovery/DiscoverySession";
import {
  DiscoveryExportRefusedError,
  exportJournalSession,
  type DiscoveryExportResult,
} from "../../core/discovery/exportSession";
import {
  listSessions,
  readSessionJournal,
  resolveSessionDir,
} from "../../core/discovery/sessionJournal";
import type { ResolveDiscoverySecrets } from "../../core/discovery/stepRunner";
import { collectLocatorInventory } from "../../core/snapshot/locatorInventory";
import { SpecRefusedError } from "../../core/runner/Runner";
import {
  DEFAULT_DISCOVERY_SESSION_TTL_MS,
  discoveryConfigOf,
  DiscoverySetupSchema,
  SnapshotModeSchema,
  type DiscoverySetup,
  type SessionJournalFile,
  type SnapshotInfo,
  type SnapshotMode,
} from "../../core/schema/discovery.v1";
import { OutcomeSchema, type Outcome } from "../../core/schema/spec.v1";
import { type BackendChoice, createBackend } from "../backendFactory";
import { trackBackend } from "../cleanup";
import { emit, resolveFormat } from "../format";
import { log } from "../logger";
import { backendOpts, parseVarFlags } from "./run";
import { resolveScopedSecrets } from "./secrets";

export interface DiscoverCommandOptions {
  roles?: boolean;
  testids?: boolean;
  waitUntil?: "networkidle" | "load" | "domcontentloaded";
  env?: string;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  provider?: string;
  device?: string;
  config?: string;
  /** Repeatable `--var key=value` overrides for `${vars.X}` in the URL. */
  var?: string[];
  /** Repeatable `--use <action>` setup steps (imported reusable actions). */
  use?: string[];
  /** Repeatable `--import <file>` action files for `--use`. */
  import?: string[];
  /** `--from-spec <path>` + `--until-step <id>` setup. */
  fromSpec?: string;
  untilStep?: string;
  /** `--resume <checkpoint>` before setup. */
  resume?: string;
  snapshotMode?: string;
  maxBytes?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface DiscoverReport {
  status: "ok";
  requestedUrl: string;
  url: string;
  backend: string;
  snapshot: Array<{
    role: string;
    name?: string;
    level: number;
    ref?: string;
  }>;
  inventory?: {
    roles?: Array<{
      role: string;
      name?: string;
      count: number;
      refs: string[];
      locator: { by: "role"; role: string; name?: string };
    }>;
    testids?: Array<{
      testId: string;
      count: number;
      selector: string;
      tagNames: string[];
      textSamples: string[];
    }>;
    /** Attribute the test-id scan read (config `browser.testIdAttribute`). */
    testIdAttribute?: string;
  };
  /** Session journal of this one-shot (`cairn discover export --from-session`). */
  sessionId?: string;
  journal?: string;
  snapshotInfo?: SnapshotInfo;
  setup?: {
    ok: boolean;
    steps: number;
    durationMs: number;
    warnings: string[];
  };
  warnings?: string[];
}

/* ----- shared session plumbing (CLI one-shot + MCP tools) ----- */

/** Inputs that open (or resume) a discovery session. */
export interface DiscoveryOpenInput {
  url?: string;
  env?: string;
  config?: string;
  var?: string[];
  mock?: boolean;
  headed?: boolean;
  backend?: BackendChoice;
  provider?: string;
  device?: string;
  /** agent-browser session name (default: unique per session). */
  sessionName?: string;
  waitUntil?: "networkidle" | "load" | "domcontentloaded";
  setup?: DiscoverySetup;
  imports?: string[];
  resume?: string;
  ttlMs?: number;
  snapshotMode?: SnapshotMode;
  maxBytes?: number;
  origin: "cli" | "mcp";
  client?: string;
  /**
   * Called with the backend as soon as it exists (before setup runs), so a
   * CLI can register it for signal-time cleanup.
   */
  onBackend?: (backend: BrowserBackend) => void;
}

/** Where journals live for a config: `artifactRoot`, else ~/.cairntrace/runs. */
export function journalRootFor(target: Pick<BrowseTarget, "config">): string {
  const configured = target.config?.artifactRoot;
  return configured
    ? resolve(configured)
    : join(homedir(), ".cairntrace", "runs");
}

/** `${secrets.X}` from the configured provider, per synthetic spec. */
export function discoverySecretsResolver(input: {
  env?: string;
  configPath?: string;
  vars?: Record<string, string>;
}): ResolveDiscoverySecrets {
  return async (specPath: string) => {
    const scoped = await resolveScopedSecrets(specPath, {
      ...(input.env !== undefined ? { environmentOverride: input.env } : {}),
      ...(input.configPath ? { configPath: input.configPath } : {}),
      ...(input.vars && Object.keys(input.vars).length > 0
        ? { vars: input.vars }
        : {}),
    });
    return {
      env: scoped.env,
      childEnv: scoped.childEnv,
      secretValues: scoped.secretValues,
      ...(scoped.selectedKeys
        ? { selectedTvaultKeys: scoped.selectedKeys }
        : {}),
      secretNames: [
        ...(scoped.selectedKeys ?? []),
        ...(scoped.secrets?.required ?? []),
        ...(scoped.secrets?.keys ?? []),
      ],
    };
  };
}

function createDiscoveryBackend(
  input: Pick<
    DiscoveryOpenInput,
    "mock" | "headed" | "backend" | "provider" | "device" | "sessionName"
  >,
  target: BrowseTarget,
): BrowserBackend {
  const choice: BackendChoice = input.mock
    ? "mock"
    : (input.backend ??
      discoveryConfigOf(target.config).backend ??
      "agent-browser");
  return createBackend({
    ...backendOpts(
      {
        ...(input.headed !== undefined ? { headed: input.headed } : {}),
        backend: choice,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.device !== undefined ? { device: input.device } : {}),
      },
      target.browser,
    ),
    // One agent-browser daemon per session: two sessions never share a page.
    session:
      input.sessionName ??
      `cairntrace-disc-${process.pid}-${randomBytes(3).toString("hex")}`,
  });
}

/**
 * Resolve config/env/vars (fails before any browser on an unknown env, a
 * missing var, or a relative URL without a baseUrl), create the backend and
 * open a journaled session. The backend is closed when opening fails.
 */
export async function openDiscovery(input: DiscoveryOpenInput): Promise<{
  handle: DiscoverySessionHandle;
  target: BrowseTarget;
}> {
  if (input.url === undefined && !input.setup && !input.resume) {
    throw new Error("pass a url, a setup, or a resume checkpoint");
  }
  const vars = parseVarFlags(input.var);
  const target = await resolveBrowseTarget({
    // Without a url (setup-only), resolve config/env against a blank page.
    url: input.url ?? "about:blank",
    label: "discover",
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    // The mock backend never navigates a real page, so a bare path is fine
    // for offline exploration.
    allowUnresolvedRelative: input.mock === true,
  });
  const backend = createDiscoveryBackend(input, target);
  input.onBackend?.(backend);
  const discovery = discoveryConfigOf(target.config);
  try {
    const handle = await openSession(
      backend,
      input.url !== undefined ? target.url : undefined,
      {
        // Navigate with the resolved URL but record the URL as requested:
        // `${secrets.X}` / `${env.X}` / `${vars.X}` and relative paths stay
        // placeholders in the exported spec, never resolved values.
        ...(input.url !== undefined ? { recordUrl: target.requestedUrl } : {}),
        redactUrl: (u) => redactBrowseUrl(target, u),
        runtimeInputs: {
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(Object.keys(vars).length > 0 ? { vars } : {}),
        },
        ...(input.waitUntil !== undefined
          ? { waitUntil: input.waitUntil }
          : {}),
        ...(target.testIdAttribute
          ? { testIdAttribute: target.testIdAttribute }
          : {}),
        ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
        artifactRoot: journalRootFor(target),
        origin: input.origin,
        ...(input.client ? { client: input.client } : {}),
        headed: input.headed === true,
        ...(input.mock ? { mock: true } : {}),
        envName: target.envName,
        ...(target.configPath ? { configPath: target.configPath } : {}),
        configDir: target.configDir,
        ...(target.config ? { config: target.config } : {}),
        ...(input.setup ? { setup: input.setup } : {}),
        ...(input.imports ? { imports: input.imports } : {}),
        ...(input.resume ? { resume: input.resume } : {}),
        resolveSecrets: discoverySecretsResolver({
          ...(input.env !== undefined ? { env: input.env } : {}),
          ...(target.configPath ? { configPath: target.configPath } : {}),
          vars,
        }),
        secretNames: [
          ...(target.secrets?.required ?? []),
          ...(target.secrets?.keys ?? []),
        ],
        sensitiveValues: target.sensitiveValues,
        ttlMs:
          input.ttlMs ??
          discovery.sessionTtlMs ??
          DEFAULT_DISCOVERY_SESSION_TTL_MS,
        ...(input.snapshotMode ? { snapshotMode: input.snapshotMode } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      },
    );
    if (target.warnings.length > 0 && handle.opened) {
      handle.opened.warnings.unshift(...target.warnings);
    }
    return { handle, target };
  } catch (e) {
    await backend.close().catch(() => undefined);
    throw e;
  }
}

/**
 * Re-open a session from its journal (`cairn_discover_resume`): a fresh
 * backend, the setup again, every recorded step replayed.
 */
export async function resumeDiscovery(
  dir: string,
  input: Omit<
    DiscoveryOpenInput,
    "url" | "setup" | "imports" | "resume" | "waitUntil"
  >,
): Promise<{
  handle: DiscoverySessionHandle;
  target: BrowseTarget;
  session: SessionJournalFile;
}> {
  const read = await readSessionJournal(dir);
  if (!read) throw new Error(`no readable session journal in ${dir}`);
  const session = read.session;
  if (session.kind !== "discovery") {
    throw new Error(
      `session ${session.sessionId} is an ${session.kind} session; only discovery sessions resume`,
    );
  }
  // Before a browser exists (resumeSession checks again).
  const refusal = journalRefusal(read);
  if (refusal) throw new Error(`discovery resume: ${refusal}`);
  const vars = {
    ...Object.fromEntries(
      Object.entries(session.vars ?? {}).filter(
        ([, value]) => value !== "[redacted]",
      ),
    ),
    ...parseVarFlags(input.var),
  } as Record<string, string>;
  const env = input.env ?? session.env;
  const config = input.config ?? session.configPath;
  const target = await resolveBrowseTarget({
    url: "about:blank",
    label: "discover",
    ...(env !== undefined ? { env } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
  const mock = input.mock ?? session.mock === true;
  const backend = createDiscoveryBackend(
    {
      ...input,
      mock,
      ...(input.backend === undefined &&
      !mock &&
      (session.backend === "playwright" || session.backend === "agent-browser")
        ? { backend: session.backend }
        : {}),
    },
    target,
  );
  try {
    const handle = await resumeSession(backend, read, {
      redactUrl: (u) => redactBrowseUrl(target, u),
      runtimeInputs: {
        ...(config !== undefined ? { config } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(Object.keys(vars).length > 0 ? { vars } : {}),
      },
      ...(target.testIdAttribute
        ? { testIdAttribute: target.testIdAttribute }
        : {}),
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      origin: input.origin,
      ...(input.client ? { client: input.client } : {}),
      headed: input.headed === true,
      ...(mock ? { mock: true } : {}),
      envName: target.envName,
      ...(target.configPath ? { configPath: target.configPath } : {}),
      configDir: target.configDir,
      ...(target.config ? { config: target.config } : {}),
      resolveSecrets: discoverySecretsResolver({
        ...(env !== undefined ? { env } : {}),
        ...(target.configPath ? { configPath: target.configPath } : {}),
        vars,
      }),
      secretNames: [
        ...(target.secrets?.required ?? []),
        ...(target.secrets?.keys ?? []),
      ],
      sensitiveValues: target.sensitiveValues,
      ttlMs:
        input.ttlMs ??
        discoveryConfigOf(target.config).sessionTtlMs ??
        session.ttlMs ??
        DEFAULT_DISCOVERY_SESSION_TTL_MS,
      ...(input.snapshotMode ? { snapshotMode: input.snapshotMode } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
    });
    return { handle, target, session };
  } catch (e) {
    await backend.close().catch(() => undefined);
    throw e;
  }
}

/** The setup of `cairn discover` flags (`--use` / `--from-spec`). */
export function setupFromFlags(
  opts: Pick<DiscoverCommandOptions, "use" | "fromSpec" | "untilStep">,
): DiscoverySetup | undefined {
  const uses = opts.use ?? [];
  if (opts.fromSpec !== undefined || opts.untilStep !== undefined) {
    if (uses.length > 0) {
      throw new Error("use either --use or --from-spec/--until-step, not both");
    }
    if (!opts.fromSpec || !opts.untilStep) {
      throw new Error("--from-spec and --until-step go together");
    }
    return DiscoverySetupSchema.parse({
      fromSpec: opts.fromSpec,
      untilStep: /^\d+$/.test(opts.untilStep)
        ? Number(opts.untilStep)
        : opts.untilStep,
    });
  }
  if (uses.length === 0) return undefined;
  return DiscoverySetupSchema.parse(uses.map(parseUseFlag));
}

/** `name` or `name:key=value,key=value`. */
function parseUseFlag(flag: string): {
  use: string;
  vars?: Record<string, string>;
} {
  const colon = flag.indexOf(":");
  if (colon < 0) return { use: flag };
  const vars = parseVarFlags(
    flag
      .slice(colon + 1)
      .split(",")
      .filter((pair) => pair.length > 0),
  );
  return {
    use: flag.slice(0, colon),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  };
}

/**
 * `cairn discover <url>` — enhanced snapshot that returns the full
 * accessibility tree + locator inventory in one call. The MCP discovery
 * tools (cairn_discover_*) are the primary interactive interface; this
 * CLI command is the one-shot equivalent. It runs `--use` / `--from-spec`
 * setup first (through the runner, like `cairn run`), and leaves a session
 * journal behind for `cairn discover export --from-session`.
 */
export async function discoverCommand(
  targetUrl: string | undefined,
  opts: DiscoverCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let setup: DiscoverySetup | undefined;
  let snapshotMode: SnapshotMode = "full";
  let maxBytes: number | undefined;
  try {
    setup = setupFromFlags(opts);
    if (opts.snapshotMode !== undefined) {
      snapshotMode = SnapshotModeSchema.parse(opts.snapshotMode);
    }
    if (opts.maxBytes !== undefined) {
      maxBytes = Number(opts.maxBytes);
      if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        throw new Error(
          `--max-bytes expects a positive integer, got ${opts.maxBytes}`,
        );
      }
    }
  } catch (e) {
    process.stderr.write(`cairn discover: ${(e as Error).message}\n`);
    process.exit(4);
    return;
  }
  if (targetUrl === undefined && !setup && !opts.resume) {
    process.stderr.write(
      "cairn discover: pass a url (or --use/--from-spec/--resume setup)\n",
    );
    process.exit(4);
    return;
  }

  let opened: Awaited<ReturnType<typeof openDiscovery>>;
  // Tracked from creation: a Ctrl-C during a slow setup must not orphan
  // the browser.
  let untrack: () => void = noop;
  try {
    // Config/env/vars resolve BEFORE a browser exists: the URL, the baseUrl
    // and the project `browser:` block (testIdAttribute, provider, click
    // tuning) all come from the same cairntrace.config.yml a run would use.
    opened = await openDiscovery({
      ...(targetUrl !== undefined ? { url: targetUrl } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.var ? { var: opts.var } : {}),
      ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
      ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
      ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.device !== undefined ? { device: opts.device } : {}),
      ...(opts.waitUntil !== undefined ? { waitUntil: opts.waitUntil } : {}),
      ...(setup ? { setup } : {}),
      ...(opts.import && opts.import.length > 0
        ? { imports: opts.import }
        : {}),
      ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
      snapshotMode,
      // The one-shot prints the whole tree unless --max-bytes caps it (the
      // MCP tools default to a budget; a CLI caller asked for this page).
      maxBytes: maxBytes ?? Number.POSITIVE_INFINITY,
      origin: "cli",
      onBackend: (backend) => {
        untrack = trackBackend(backend);
      },
    });
  } catch (e) {
    untrack();
    process.stderr.write(`cairn discover: ${(e as Error).message}\n`);
    process.exit(browseErrorExitCode(e));
    return;
  }
  const { handle, target } = opened;
  for (const warning of handle.opened?.warnings ?? []) log.warn(warning);

  try {
    // Collect inventory
    const includeRoles = opts.roles || (!opts.roles && !opts.testids);
    const includeTestIds = opts.testids || (!opts.roles && !opts.testids);
    let inventory;
    try {
      inventory = await collectLocatorInventory(handle.backend, {
        roles: includeRoles,
        testids: includeTestIds,
        ...(target.testIdAttribute
          ? { testIdAttribute: target.testIdAttribute }
          : {}),
      });
    } catch {
      // inventory is best-effort
    }

    const info = handle.opened;
    const report: DiscoverReport = {
      status: "ok",
      requestedUrl: targetUrl ?? "",
      // The page URL can carry a secret the resolved URL had; never print it.
      url: redactBrowseUrl(
        target,
        await handle.backend.getUrl().catch(() => handle.session.currentUrl),
      ),
      backend: handle.backend.name,
      snapshot: (info?.snapshot ?? []).map((e) => ({
        role: e.role,
        ...(e.name ? { name: e.name } : {}),
        level: e.level,
        ...(e.ref ? { ref: e.ref } : {}),
      })),
      ...(inventory ? { inventory } : {}),
      sessionId: handle.session.id,
      ...(handle.journal ? { journal: handle.journal.dir } : {}),
      ...(info?.snapshotInfo ? { snapshotInfo: info.snapshotInfo } : {}),
      ...(info?.setup
        ? {
            setup: {
              ok: info.setup.ok,
              steps: info.setup.steps,
              durationMs: info.setup.durationMs,
              warnings: info.setup.warnings,
            },
          }
        : {}),
      ...(info && info.warnings.length > 0 ? { warnings: info.warnings } : {}),
    };

    process.stdout.write(emit(format, report, discoverToMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  } catch (e) {
    process.stderr.write(`cairn discover: ${(e as Error).message}\n`);
    process.exitCode = 2;
  } finally {
    untrack();
    await closeSession(handle).catch(() => undefined);
  }
}

/**
 * Resolve the discover target (URL + project browser settings) from config.
 * `--var` values feed `${vars.X}` in the URL.
 */
export async function resolveDiscoverTarget(
  targetUrl: string,
  opts: Pick<DiscoverCommandOptions, "config" | "env" | "var"> = {},
): Promise<BrowseTarget> {
  const vars = parseVarFlags(opts.var);
  return resolveBrowseTarget({
    url: targetUrl,
    label: "discover",
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
}

export async function resolveDiscoverUrl(
  targetUrl: string,
  opts: Pick<DiscoverCommandOptions, "config" | "env" | "var"> = {},
): Promise<string> {
  return (await resolveDiscoverTarget(targetUrl, opts)).url;
}

/**
 * Exit 4 for config errors (unknown explicit env, a bad setup), 7 when the
 * environment policy refuses a `--from-spec` setup, 2 otherwise.
 */
export function browseErrorExitCode(e: unknown): number {
  if (e instanceof UnknownEnvironmentError) return e.exitCode;
  if (e instanceof SpecRefusedError) return e.exitCode;
  // A setup that cannot be resolved (4) or that the policy refuses (7).
  if (e instanceof DiscoverySetupError && e.exitCode !== undefined) {
    return e.exitCode;
  }
  if ((e as Error | undefined)?.name === "SetupResolutionError") return 4;
  return 2;
}

export function discoverToMarkdown(report: DiscoverReport): string {
  const lines = [`# Discover: ${report.url}`, "", `Backend: ${report.backend}`];
  if (report.sessionId) {
    lines.push(
      `Session: ${report.sessionId}${
        report.journal ? ` (journal: ${report.journal})` : ""
      }`,
    );
  }
  if (report.setup) {
    lines.push(
      `Setup: ${
        report.setup.ok ? "ok" : "failed"
      } (${report.setup.steps} steps, ${report.setup.durationMs}ms)`,
    );
  }
  lines.push("", "## Accessibility Snapshot");

  if (report.snapshot.length === 0) {
    lines.push("- (empty snapshot)");
  } else {
    for (const el of report.snapshot) {
      const indent = "  ".repeat(el.level);
      const name = el.name ? ` "${el.name}"` : "";
      const ref = el.ref ? ` [ref=${el.ref}]` : "";
      lines.push(`${indent}- ${el.role}${name}${ref}`);
    }
  }
  if (report.snapshotInfo?.truncated) {
    lines.push(
      `- … (${report.snapshotInfo.returned}/${report.snapshotInfo.elements} elements; full snapshot in the journal: ${report.snapshotInfo.path ?? "n/a"})`,
    );
  }

  if (report.inventory?.roles) {
    lines.push("", "## Roles");
    if (report.inventory.roles.length === 0) {
      lines.push("- No role locators found");
    } else {
      for (const entry of report.inventory.roles) {
        const name = entry.name ? ` "${entry.name}"` : "";
        const count = entry.count > 1 ? ` (${entry.count} matches)` : "";
        const refs =
          entry.refs.length > 0 ? ` refs: ${entry.refs.join(", ")}` : "";
        const locator = entry.name
          ? `{ by: role, role: ${entry.role}, name: ${entry.name} }`
          : `{ by: role, role: ${entry.role} }`;
        lines.push(`- ${entry.role}${name}${count} -> ${locator}${refs}`);
      }
    }
  }

  if (report.inventory?.testids) {
    const attribute = report.inventory.testIdAttribute ?? "data-testid";
    lines.push(
      "",
      attribute === "data-testid"
        ? "## Test IDs"
        : `## Test IDs (${attribute})`,
    );
    if (report.inventory.testids.length === 0) {
      lines.push(`- No ${attribute} attributes found`);
    } else {
      for (const entry of report.inventory.testids) {
        const count = entry.count > 1 ? ` (${entry.count} matches)` : "";
        const tags = entry.tagNames.join(", ");
        const sample = entry.textSamples[0]
          ? ` text: ${entry.textSamples[0]}`
          : "";
        lines.push(
          `- ${entry.testId}${count} -> ${entry.selector} tags: ${tags}${sample}`,
        );
      }
    }
  }

  return lines.join("\n");
}

/* ----- cairn discover export --from-session ----- */

export interface DiscoverExportCommandOptions {
  fromSession?: string;
  path?: string;
  intent?: string;
  /** YAML/JSON file holding the outcomes array. */
  outcomes?: string;
  resume?: string;
  overwrite?: boolean;
  config?: string;
  artifactRoot?: string;
  /** Convention export target (folder or .yml) relative to the config dir. */
  into?: string;
  name?: string;
  conventions?: boolean;
  /** commander `--no-reuse-actions` → false. */
  reuseActions?: boolean;
  /** commander `--no-lift-vars` → false. */
  liftVars?: boolean;
  /** `--allow-secret-literals` (refuseSecrets: false). */
  allowSecretLiterals?: boolean;
  /** `--requires-env a,b`. */
  requiresEnv?: string;
  mutates?: boolean;
  /** Repeatable `--tag`. */
  tag?: string[];
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/** Load `--outcomes <file>`: a YAML/JSON array (or `{ outcomes: [...] }`). */
export async function loadOutcomesFile(path: string): Promise<Outcome[]> {
  return parseOutcomeList(
    parseYaml(await readFile(path, "utf8")) as unknown,
    path,
  );
}

/** A YAML/JSON outcomes array (or `{ outcomes: [...] }`), schema-checked. */
function parseOutcomeList(doc: unknown, path: string): Outcome[] {
  const list = Array.isArray(doc)
    ? doc
    : doc &&
        typeof doc === "object" &&
        Array.isArray((doc as { outcomes?: unknown }).outcomes)
      ? (doc as { outcomes: unknown[] }).outcomes
      : undefined;
  if (!list || list.length === 0) {
    throw new Error(`${path}: expected a non-empty outcomes array`);
  }
  return list.map((outcome, i) => {
    const parsed = OutcomeSchema.safeParse(outcome);
    if (!parsed.success) {
      throw new Error(
        `${path}: outcome ${i + 1}: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "outcome"} ${issue.message}`,
          )
          .join("; ")}`,
      );
    }
    return parsed.data;
  });
}

/** Artifact root for `--from-session <id>` (flag > config > default). */
async function sessionsRoot(opts: {
  artifactRoot?: string;
  config?: string;
}): Promise<string> {
  if (opts.artifactRoot) return resolve(opts.artifactRoot);
  const target = await resolveBrowseTarget({
    url: "about:blank",
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  }).catch(() => undefined);
  return target
    ? journalRootFor(target)
    : join(homedir(), ".cairntrace", "runs");
}

/**
 * `cairn discover export --from-session <dir|id> --path <spec> --intent …
 * --outcomes <file>` — write a session as a spec from its journal alone
 * (after the browser expired or closed). `--intent` / `--outcomes` default
 * to the session's last export (session.json), so a re-export needs
 * neither. Exit 0 written and verified, 4 refused or verify failed, 2
 * error.
 */
export async function discoverExportCommand(
  opts: DiscoverExportCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  if (!opts.fromSession) {
    fail("--from-session is required", 4);
    return;
  }
  const requiresEnv = (opts.requiresEnv ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const requires =
    requiresEnv.length > 0 || opts.mutates
      ? {
          ...(requiresEnv.length > 0 ? { env: requiresEnv } : {}),
          ...(opts.mutates ? { mutates: true } : {}),
        }
      : undefined;
  let result: DiscoveryExportResult;
  try {
    const dir = await resolveSessionDir(
      opts.fromSession,
      await sessionsRoot(opts),
    );
    // A re-export reuses the contract of the session's last export.
    const earlier =
      opts.intent && opts.outcomes
        ? undefined
        : (await readSessionJournal(dir))?.session;
    const intent = opts.intent ?? earlier?.intent;
    const outcomes = opts.outcomes
      ? await loadOutcomesFile(opts.outcomes)
      : earlier?.outcomes && earlier.outcomes.length > 0
        ? parseOutcomeList(earlier.outcomes, `${dir}/session.json`)
        : undefined;
    if (!intent || !outcomes) {
      throw new DiscoveryExportRefusedError(
        `--intent and --outcomes are required: session ${
          earlier?.sessionId ?? opts.fromSession
        } has no earlier export whose ${
          !intent ? "intent" : "outcomes"
        } could be reused`,
      );
    }
    const reused = [
      ...(opts.intent ? [] : ["intent"]),
      ...(opts.outcomes ? [] : ["outcomes"]),
    ];
    result = await exportJournalSession(dir, {
      ...(opts.path ? { path: opts.path } : {}),
      intent,
      outcomes,
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.overwrite ? { overwrite: true } : {}),
      ...(opts.into ? { into: opts.into } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.conventions ? { conventions: true } : {}),
      ...(opts.reuseActions === false ? { reuseActions: false } : {}),
      ...(opts.liftVars === false ? { liftVars: false } : {}),
      ...(opts.allowSecretLiterals ? { refuseSecrets: false } : {}),
      ...(requires ? { requires } : {}),
      ...(opts.tag && opts.tag.length > 0 ? { tags: opts.tag } : {}),
    });
    if (reused.length > 0) {
      result = {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          `reused the ${reused.join(" and ")} of the session's last export (pass ${reused
            .map((field) => `--${field}`)
            .join(" / ")} to change them)`,
        ],
      };
    }
  } catch (e) {
    fail(
      (e as Error).message,
      e instanceof DiscoveryExportRefusedError ? 4 : 2,
    );
    return;
  }
  const { writtenTo: _writtenTo, ...report } = result;
  process.stdout.write(emit(format, report, exportToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (!result.verifyOk) process.exitCode = 4;
}

function fail(message: string, code: number): void {
  process.stderr.write(`cairn discover export: ${message}\n`);
  process.exitCode = code;
}

function exportToMarkdown(
  report: Omit<DiscoveryExportResult, "writtenTo">,
): string {
  const lines = [
    `# Exported ${report.stepCount} steps to ${report.path}`,
    "",
    `Verify: ${report.verifyOk ? "parses OK" : "FAILED"}`,
  ];
  if (report.sessionId) lines.push(`Session: ${report.sessionId}`);
  if (report.skippedFailed > 0) {
    lines.push(`Excluded ${report.skippedFailed} failed action(s).`);
  }
  for (const error of report.verifyErrors ?? [])
    lines.push(`- error: ${error}`);
  for (const warning of report.warnings ?? [])
    lines.push(`- warning: ${warning}`);
  const conventions = report.report;
  if (conventions) {
    lines.push("", "## Conventions");
    for (const reused of conventions.reusedActions) {
      lines.push(
        `- ${
          reused.applied ? "reused" : "candidate"
        } ${reused.action} (${reused.source}${
          reused.steps ? `, steps ${reused.steps[0]}-${reused.steps[1]}` : ""
        }, confidence ${reused.confidence})${
          reused.reason ? ` — ${reused.reason}` : ""
        }`,
      );
    }
    for (const lifted of conventions.liftedVars) {
      lines.push(`- lifted ${lifted.where} → \${vars.${lifted.var}}`);
    }
    for (const secret of conventions.secretsPlaceholdered) {
      lines.push(`- secret at ${secret.where} → ${secret.placeholder}`);
    }
    for (const warning of conventions.warnings)
      lines.push(`- note: ${warning}`);
  }
  for (const next of report.nextActions ?? []) lines.push(`- next: ${next}`);
  return lines.join("\n");
}

/* ----- cairn discover sessions ----- */

export interface DiscoverSessionsCommandOptions {
  config?: string;
  artifactRoot?: string;
  limit?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface DiscoverSessionsReport {
  root: string;
  sessions: Array<{
    sessionId: string;
    kind: string;
    status: string;
    startUrl: string;
    currentUrl?: string;
    stepCount?: number;
    openedAt: string;
    lastActivityAt: string;
    exportedTo?: string[];
    journal: string;
  }>;
}

/** `cairn discover sessions` — session journals under the artifact root. */
export async function discoverSessionsCommand(
  opts: DiscoverSessionsCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const root = await sessionsRoot(opts);
  const limit = opts.limit !== undefined ? Number(opts.limit) : 20;
  const sessions = (await listSessions(root)).slice(
    0,
    Number.isInteger(limit) && limit > 0 ? limit : 20,
  );
  const report: DiscoverSessionsReport = {
    root,
    sessions: sessions.map(({ dir, session }) => ({
      sessionId: session.sessionId,
      kind: session.kind,
      status: session.status,
      startUrl: session.startUrl,
      ...(session.currentUrl ? { currentUrl: session.currentUrl } : {}),
      ...(session.stepCount !== undefined
        ? { stepCount: session.stepCount }
        : {}),
      openedAt: session.openedAt,
      lastActivityAt: session.lastActivityAt,
      ...(session.exportedTo ? { exportedTo: session.exportedTo } : {}),
      journal: dir,
    })),
  };
  process.stdout.write(
    emit(format, report, (r) =>
      r.sessions.length === 0
        ? `No sessions under ${r.root}`
        : [
            `# Sessions (${r.root})`,
            "",
            ...r.sessions.map(
              (s) =>
                `- ${s.sessionId} ${s.kind} ${s.status} ${s.currentUrl ?? s.startUrl} (${s.stepCount ?? 0} steps, ${s.lastActivityAt})`,
            ),
          ].join("\n"),
    ),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function noop(): void {}
