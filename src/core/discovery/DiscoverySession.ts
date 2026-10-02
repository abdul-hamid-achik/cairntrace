import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BrowserBackend,
  InvocationResult,
  ResolvedElement,
} from "../../adapters/browserBackend";
import type { ArtifactRedactor } from "../artifacts/ArtifactWriter";
import {
  createLiveArtifactRedactor,
  isSensitiveEnvKey,
} from "../artifacts/redaction";
import { withoutQuery } from "../artifacts/stepLabel";
import type { SnapshotElement } from "../healer/snapshotParser";
import { SpecRefusedError } from "../runner/Runner";
import {
  collectUnresolvedRuntimeRefs,
  deepMapStrings,
  resolveEvalPlaceholders,
  resolveResponsePlaceholders,
} from "../runner/runtimePlaceholders";
import { isRelativeUrl, joinUrl, resolveUrl } from "../runner/url";
import {
  collectLocatorInventory,
  type LocatorInventory,
} from "../snapshot/locatorInventory";
import type { ConfigVarValue } from "../schema/config.v1";
import {
  DEFAULT_DISCOVERY_SESSION_TTL_MS,
  type DiscoveryAction,
  type DiscoveryInteractResult,
  type DiscoverySetup,
  type DiscoverySnapshotElement,
  type SessionJournalFile,
  type SnapshotInfo,
  type SnapshotMode,
} from "../schema/discovery.v1";
import type {
  Locator,
  RedactionConfig,
  WaitCondition,
} from "../schema/spec.v1";
import {
  mutationsOf,
  queryNetwork,
  toDiscoveryEntry,
  type DiscoveryNetworkEntry,
  type NetworkQuery,
} from "./networkLog";
import { holdsRedacted, REDACTED } from "./placeholderRedaction";
import {
  DRAFT_FILE,
  journalSeq,
  journalSteps,
  openElsewhere,
  SESSIONS_DIR,
  SessionJournal,
  type SessionJournalRead,
} from "./sessionJournal";
import {
  expandPath,
  rebaseImport,
  resolveActionFiles,
  resolveSetup,
  SetupResolutionError,
  useSteps,
  type SetupExport,
} from "./setup";
import { buildSpecYaml } from "./specExporter";
import { parseSnapshotWithFlags, snapshotView } from "./snapshotView";
import {
  isEphemeralTarget,
  missingInputMessage,
  recordInteraction,
  recordOpen,
  recordOpenWithWait,
  secretPlaceholders,
  stepSchemaIssues,
  withPortableFilePaths,
  withSecretPlaceholders,
  type SecretPlaceholder,
} from "./stepRecorder";
import {
  DISCOVERY_SCREENSHOT_TIMEOUT_MS,
  memoizeSecrets,
  runStepsThroughRunner,
  withScreenshotDeadline,
  type DiscoveryRunContext,
  type DiscoveryScreenshots,
  type DiscoverySecrets,
  type ResolveDiscoverySecrets,
  type RunStepsInput,
  type RunStepsOutcome,
} from "./stepRunner";

/**
 * The config/env/var inputs a session was opened with. Recorded steps keep
 * their `${vars.X}` placeholders, so exporting re-resolves them with these.
 */
export interface DiscoveryRuntimeInputs {
  config?: string;
  env?: string;
  vars?: Record<string, ConfigVarValue>;
}

/**
 * A stateful discovery session that keeps a browser backend alive across
 * interactions. Each interaction is recorded as a spec-compatible step so
 * the agent can later export the full session as a spec YAML.
 *
 * Every step — setup, the opening navigation, interactions, a resume replay —
 * executes through the runner (`runSpec`, see stepRunner), so discovery and
 * `cairn run` share step semantics, config/env/var/secret resolution and the
 * interaction resilience layer. A session journals itself to
 * `<artifactRoot>/_sessions/<id>/` (see SessionJournal) when opened with an
 * artifact root; the journal outlives the browser (TTL, close, restart).
 *
 * Session lifecycle:
 *   1. `openSession()` — setup (optional), open the URL, first snapshot
 *   2. `captureSnapshot()` — the current page (none | diff | compact | full)
 *   3. `interact()` — perform + record one step; post-action snapshot
 *   4. `navigate()` — record an open step
 *   5. `getInventory()` / `getNetwork()` — locators / requests seen
 *   6. `getExportableSteps()` — what an export writes
 *   7. `closeSession()` — close the backend; the journal stays
 */

export interface DiscoverySession {
  readonly id: string;
  readonly createdAt: number;
  lastActivity: number;
  currentUrl: string;
  readonly steps: RecordedStep[];
  lastSnapshot: SnapshotElement[];
}

export interface RecordedStep {
  step: Record<string, unknown>;
  timestamp: string;
  ok: boolean;
  resolvedElement?: ResolvedElement;
  /** Journal action index that recorded it. */
  index?: number;
  /** Undone with removeStep. */
  removed?: boolean;
}

/** Map of active sessions — managed by the MCP server / CLI. */
export type SessionRegistry = Map<string, DiscoverySessionHandle>;

/** What opening (or resuming) a session did. */
export interface DiscoveryOpenInfo {
  setup?: {
    ok: boolean;
    /** Steps the setup run executed (after `use:` expansion). */
    steps: number;
    durationMs: number;
    error?: string;
    /** Setup run directory, kept when it failed. */
    runDir?: string;
    warnings: string[];
  };
  snapshot: DiscoverySnapshotElement[];
  snapshotInfo: SnapshotInfo;
  screenshot?: string;
  warnings: string[];
}

export interface DiscoverySessionHandle {
  session: DiscoverySession;
  backend: BrowserBackend;
  /**
   * Serializes backend operations so two concurrent calls against the same
   * session can't interleave on the single shared browser (which would corrupt
   * the recorded-step order and the last-snapshot/url state).
   */
  lock: Promise<unknown>;
  /**
   * Project `browser.testIdAttribute` the session was opened with; the
   * inventory scans this attribute so it matches what `by: testid` resolves.
   */
  testIdAttribute?: string;
  /** Environment baseUrl the session was opened with (relative navigation). */
  baseUrl?: string;
  /**
   * Scrubs secrets from URLs the session RETURNS (the browser's page URL can
   * carry a token the opened URL had). `session.currentUrl` stays raw because
   * relative navigation resolves against it; use {@link publicUrl} to show it.
   */
  redactUrl?: (url: string) => string;
  /** See {@link DiscoveryRuntimeInputs}. */
  runtimeInputs?: DiscoveryRuntimeInputs;
  /** On-disk journal (absent for journal-less sessions in tests). */
  journal?: SessionJournal;
  /** How steps execute (the runner bridge). */
  runner: DiscoveryRunContext;
  /** Idle time after which a sweep closes the browser. */
  ttlMs: number;
  actionCount: number;
  snapshotSeq: number;
  /** Absolute action files `use:` steps resolve against (setup + steps). */
  imports: string[];
  /**
   * Action files the session's own `use:` steps (recorded through interact)
   * need, beyond the setup's: an export and a resume carry them too.
   */
  useImports: string[];
  /**
   * `${evals.X}` / `${requests.X}` values captured by earlier actions (their
   * `assign`). Each action is its own run, so discovery splices them into
   * the executed copy of a later step the way one run would; the recorded
   * step keeps the placeholder.
   */
  captures: {
    evals: Record<string, unknown>;
    requests: Record<string, unknown>;
  };
  /**
   * Spec-level fields every action run carries: a `fromSpec` setup's
   * `vars`, `settleMs`, `viewport` and `redaction`, so a later
   * `${vars.X}` the source defines resolves live as it will in the export.
   */
  runExtra?: Record<string, unknown>;
  /** Feed a setup spec's `redaction:` into the session redactor. */
  setRedactionConfig: (config: RedactionConfig | undefined) => void;
  setup?: DiscoverySetup;
  setupExport?: SetupExport;
  /** Checkpoint restored before setup. */
  resume?: string;
  waitUntil?: "networkidle" | "load" | "domcontentloaded";
  /** Literal secret values → placeholders, applied to every recorded step. */
  secrets: SecretPlaceholder[];
  network: {
    entries: DiscoveryNetworkEntry[];
    /** Backend log entries already attributed since the last clear. */
    harvested: number;
    /** Action the next late entries belong to. */
    lastAction: number;
  };
  configDir: string;
  cwd: string;
  /** Raw config (authoring.template.imports, discovery block). */
  config?: unknown;
  /** Intent/outcomes of the last export (the draft reuses them). */
  draft: { name?: string; intent?: string; outcomes?: unknown[] };
  redactor: ArtifactRedactor;
  /** Default snapshot mode / budget of this session. */
  snapshotMode: SnapshotMode;
  maxBytes?: number;
  closed: boolean;
  /** session.closed written (idempotence across close paths). */
  journalEnded?: boolean;
  /** Set by openSession / resumeSession. */
  opened?: DiscoveryOpenInfo;
  /** Temporary work dir owned by a journal-less session. */
  ownedWorkDir?: string;
  /**
   * Screenshot state: the runner's backend bounds each capture, and the
   * first capture timeout turns screenshots off for the session (see
   * {@link screenshotWarnings}).
   */
  screenshots: DiscoveryScreenshots;
}

/** Project settings a discovery session carries across tool calls. */
export interface DiscoverySessionOptions {
  waitUntil?: "networkidle" | "load" | "domcontentloaded";
  /** Config `browser.testIdAttribute` (default `data-testid`). */
  testIdAttribute?: string;
  /** Config environment baseUrl, for relative `navigate` URLs. */
  baseUrl?: string;
  /**
   * The URL to RECORD as the initial `open` step when it differs from the
   * one navigated: the caller's templated or relative form, so resolved
   * secrets never reach an exported spec and the spec follows the run's
   * environment baseUrl. Defaults to the navigated URL.
   */
  recordUrl?: string;
  /** See {@link DiscoverySessionHandle.redactUrl}. */
  redactUrl?: (url: string) => string;
  /** See {@link DiscoveryRuntimeInputs}. */
  runtimeInputs?: DiscoveryRuntimeInputs;
  /** Journal root: `<artifactRoot>/_sessions/<id>/`. No journal when unset. */
  artifactRoot?: string;
  origin?: "cli" | "mcp";
  client?: string;
  headed?: boolean;
  mock?: boolean;
  /** Reuse an id (resume); default a fresh UUID. */
  sessionId?: string;
  /** Resolved environment name (journal `env`). */
  envName?: string;
  /** Resolved cairntrace.config.yml (synthetic specs never discover one). */
  configPath?: string;
  /** Directory of the config (or cwd without one): `${config.dir}`. */
  configDir?: string;
  /** Raw config object. */
  config?: unknown;
  setup?: DiscoverySetup;
  /** Explicit action files for `setup` / `use:` (relative to cwd). */
  imports?: string[];
  /** Checkpoint to restore before setup (scoped, like `session.resume`). */
  resume?: string;
  resolveSecrets?: ResolveDiscoverySecrets;
  /** Names a `${secrets.X}` placeholder may use (config secrets keys). */
  secretNames?: readonly string[];
  /** Values to scrub from everything returned (resolved URL secrets). */
  sensitiveValues?: readonly string[];
  ttlMs?: number;
  /** Hard deadline of one screenshot (default 20s; tests shorten it). */
  screenshotTimeoutMs?: number;
  snapshotMode?: SnapshotMode;
  maxBytes?: number;
  cwd?: string;
  /** Process env for redaction and placeholders (default process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * The setup could not reach its state; the session is not opened.
 * `exitCode`: 4 when the setup cannot be resolved (an action or step id
 * that does not exist), 7 when the environment policy refuses it.
 */
export class DiscoverySetupError extends Error {
  override name = "DiscoverySetupError";
  constructor(
    message: string,
    readonly runDir?: string,
    readonly exitCode?: 4 | 7,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Journal directories a session of this process holds open. */
const liveJournals = new Set<string>();

/**
 * Run `fn` exclusively against a session's backend: concurrent calls queue
 * behind one another instead of racing on the same browser. The stored lock
 * never carries a rejection, so one failed op can't poison the queue.
 */
function withLock<T>(
  handle: DiscoverySessionHandle,
  fn: () => Promise<T>,
): Promise<T> {
  const run = handle.lock.then(fn, fn);
  handle.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ----- construction ----- */

/**
 * The session redactor: rebuilt when the runner resolves a new secret or a
 * setup spec brings its `redaction:` block, and live (it also scrubs values
 * registered process-wide later — runSpec registers a spec's
 * `redaction.values` when its run starts).
 */
function makeRedactor(
  runner: DiscoveryRunContext,
  env: Record<string, string | undefined>,
  extra: readonly string[],
): {
  redactor: ArtifactRedactor;
  setConfig: (config: RedactionConfig | undefined) => void;
} {
  let size = -1;
  let config: RedactionConfig | undefined;
  let current: ArtifactRedactor | undefined;
  const get = (): ArtifactRedactor => {
    if (!current || size !== runner.secretValues.size) {
      current = createLiveArtifactRedactor(config, env, [
        ...runner.secretValues,
        ...extra,
      ]);
      size = runner.secretValues.size;
    }
    return current;
  };
  return {
    redactor: {
      value: <T>(input: T): T => get().value(input),
      text: (input: string): string => get().text(input),
    },
    setConfig: (next) => {
      config = next;
      current = undefined;
    },
  };
}

function redactVarInputs(
  vars: Record<string, ConfigVarValue> | undefined,
): Record<string, ConfigVarValue> | undefined {
  if (!vars || Object.keys(vars).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [
      key,
      isSensitiveEnvKey(key) ? "[redacted]" : value,
    ]),
  );
}

function buildHandle(
  backend: BrowserBackend,
  opts: DiscoverySessionOptions,
  id: string,
  now: number,
  journalDir?: string,
): DiscoverySessionHandle {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const cwd = opts.cwd ?? process.cwd();
  const configDir = opts.configDir ?? cwd;
  let ownedWorkDir: string | undefined;
  let workDir: string;
  let runsDir: string;
  if (journalDir) {
    workDir = join(journalDir, "work");
    runsDir = join(journalDir, "runs");
  } else {
    ownedWorkDir = mkdtempSync(join(tmpdir(), "cairn-discovery-"));
    workDir = ownedWorkDir;
    runsDir = join(ownedWorkDir, "runs");
  }
  const secretNames = new Set(opts.secretNames ?? []);
  const screenshots: DiscoveryScreenshots = {
    timeoutMs: opts.screenshotTimeoutMs ?? DISCOVERY_SCREENSHOT_TIMEOUT_MS,
  };
  const runner: DiscoveryRunContext = {
    // Steps run on the session's browser; only screenshots are bounded.
    backend: withScreenshotDeadline(backend, screenshots),
    workDir,
    runsDir,
    secretValues: new Set(),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.runtimeInputs?.env !== undefined
      ? { env: opts.runtimeInputs.env }
      : {}),
    ...(opts.runtimeInputs?.vars ? { vars: opts.runtimeInputs.vars } : {}),
    ...(opts.resolveSecrets
      ? { resolveSecrets: memoizeSecrets(opts.resolveSecrets) }
      : {}),
  };
  const redaction = makeRedactor(runner, env, opts.sensitiveValues ?? []);
  const handle: DiscoverySessionHandle = {
    session: {
      id,
      createdAt: now,
      lastActivity: now,
      currentUrl: "about:blank",
      steps: [],
      lastSnapshot: [],
    },
    backend,
    lock: Promise.resolve(),
    runner,
    ttlMs: opts.ttlMs ?? DEFAULT_DISCOVERY_SESSION_TTL_MS,
    actionCount: 0,
    snapshotSeq: 0,
    imports: [],
    useImports: [],
    captures: { evals: {}, requests: {} },
    setRedactionConfig: redaction.setConfig,
    secrets: secretPlaceholders(env, {
      secretNames,
      isSensitiveKey: isSensitiveEnvKey,
    }),
    network: { entries: [], harvested: 0, lastAction: 0 },
    configDir,
    cwd,
    draft: {},
    redactor: redaction.redactor,
    snapshotMode: opts.snapshotMode ?? "diff",
    closed: false,
    screenshots,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts.setup ? { setup: opts.setup } : {}),
    ...(opts.testIdAttribute ? { testIdAttribute: opts.testIdAttribute } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.runtimeInputs ? { runtimeInputs: opts.runtimeInputs } : {}),
    ...(ownedWorkDir ? { ownedWorkDir } : {}),
  };
  handle.redactUrl = (url: string) =>
    handle.redactor.text(opts.redactUrl ? opts.redactUrl(url) : url);
  // A provider secret resolved later (first synthetic run) joins the
  // placeholder list, so a literal of it is never recorded.
  runner.onSecrets = (secrets: DiscoverySecrets) => {
    for (const name of secrets.secretNames ?? []) secretNames.add(name);
    handle.secrets = secretPlaceholders(
      { ...env, ...secrets.env },
      { secretNames, isSensitiveKey: isSensitiveEnvKey },
    );
  };
  return handle;
}

function journalState(
  handle: DiscoverySessionHandle,
  opts: DiscoverySessionOptions,
  startUrl: string,
): SessionJournalFile {
  const at = new Date(handle.session.createdAt).toISOString();
  const vars = redactVarInputs(opts.runtimeInputs?.vars);
  return {
    version: 1,
    sessionId: handle.session.id,
    kind: "discovery",
    pid: process.pid,
    origin: opts.origin ?? "mcp",
    ...(opts.client ? { client: opts.client } : {}),
    startUrl: handle.redactor.text(startUrl),
    backend: handle.backend.name,
    headed: opts.headed === true,
    ...(opts.envName ? { env: opts.envName } : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    status: "open",
    openedAt: at,
    lastActivityAt: at,
    ttlMs: handle.ttlMs,
    ...(opts.setup ? { setup: absoluteSetup(opts.setup, handle.cwd) } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(vars ? { vars } : {}),
    ...(opts.waitUntil ? { waitUntil: opts.waitUntil } : {}),
    ...(opts.mock ? { mock: true } : {}),
    stepCount: 0,
    actionCount: 0,
  };
}

/**
 * A `fromSpec` path as the journal keeps it: absolute, so an export or a
 * resume from another directory reads the same spec.
 */
function absoluteSetup(setup: DiscoverySetup, cwd: string): DiscoverySetup {
  if (Array.isArray(setup)) return setup;
  return { ...setup, fromSpec: expandPath(setup.fromSpec, cwd) };
}

/**
 * Create a new discovery session: run its setup (if any), open the URL,
 * capture the first snapshot. Throws (DiscoverySetupError, navigation
 * failure) without closing the backend — the caller owns it.
 */
export async function openSession(
  backend: BrowserBackend,
  url: string | undefined,
  opts: DiscoverySessionOptions = {},
): Promise<DiscoverySessionHandle> {
  if (url === undefined && !opts.setup && !opts.resume) {
    throw new Error(
      "discovery: pass a url, a setup, or a resume checkpoint to open a session",
    );
  }
  const id = opts.sessionId ?? randomUUID();
  const handle = buildHandle(
    backend,
    opts,
    id,
    Date.now(),
    opts.artifactRoot
      ? join(resolve(opts.artifactRoot), SESSIONS_DIR, id)
      : undefined,
  );
  const recordUrl = opts.recordUrl ?? url;
  if (opts.artifactRoot) {
    const journal = SessionJournal.create(
      opts.artifactRoot,
      journalState(handle, opts, recordUrl ?? ""),
      handle.redactor,
    );
    if (journal) {
      handle.journal = journal;
      liveJournals.add(journal.dir);
    }
  }
  try {
    const warnings: string[] = [];
    const info: Partial<DiscoveryOpenInfo> = {};
    if (opts.setup || opts.resume) {
      const setup = await runSetup(handle, opts);
      info.setup = setup.info;
      if (setup.screenshot) info.screenshot = setup.screenshot;
      warnings.push(...setup.info.warnings);
    }
    if (url !== undefined) {
      // Execute the same step shape we record (not a hardcoded `{open: url}`)
      // so a caller-supplied waitUntil governs the navigation — otherwise
      // discovery explores a half-settled page (e.g. an un-hydrated SPA)
      // while the exported spec waits. Only the URL may differ: the recorded
      // one keeps the caller's placeholders and relative path.
      const openStepFor = (target: string): Record<string, unknown> =>
        opts.waitUntil !== undefined
          ? recordOpenWithWait(target, opts.waitUntil)
          : recordOpen(target);
      const recorded = openStepFor(recordUrl ?? url);
      const executed =
        recordUrl !== undefined && recordUrl !== url
          ? openStepFor(executableOpenUrl(recordUrl, url))
          : recorded;
      const outcome = await performAction(handle, {
        action: "open",
        recorded,
        executed,
        snapshotMode: opts.snapshotMode,
        maxBytes: opts.maxBytes,
      });
      if (!outcome.ok) {
        throw new Error(
          `discovery: navigation failed: ${outcome.error ?? "unknown error"}`,
        );
      }
      if (outcome.screenshot) info.screenshot = outcome.screenshot;
      if (outcome.warnings) warnings.push(...outcome.warnings);
      info.snapshot = outcome.snapshot;
      info.snapshotInfo = outcome.snapshotInfo;
    } else {
      handle.session.currentUrl = await backend
        .getUrl()
        .catch(() => handle.session.currentUrl);
      const view = await capture(handle, opts.snapshotMode, opts.maxBytes);
      info.snapshot = view.snapshot;
      info.snapshotInfo = view.info;
    }
    handle.opened = {
      ...info,
      snapshot: info.snapshot ?? [],
      snapshotInfo: info.snapshotInfo!,
      warnings,
    } as DiscoveryOpenInfo;
    // A url's open recorded a step (and wrote the draft); a setup-only
    // session still shows its setup in the draft and where it landed.
    if (url === undefined) {
      writeDraft(handle);
      touchJournal(handle, handle.session.currentUrl);
    }
    return handle;
  } catch (error) {
    endJournal(handle, "closed", "close", (error as Error).message);
    disposeWorkDir(handle);
    throw error;
  }
}

/**
 * The URL to execute when the recorded form differs from the navigated one.
 * A `${…}` placeholder or relative path is resolved by the runner from the
 * same config/env/vars, so the executed spec keeps the recorded form and no
 * resolved secret is written to the synthetic spec; anything else (a
 * relative path resolved against the current page) executes as navigated.
 */
function executableOpenUrl(recordUrl: string, navigated: string): string {
  if (recordUrl.includes("${")) return recordUrl;
  return navigated;
}

async function runSetup(
  handle: DiscoverySessionHandle,
  opts: DiscoverySessionOptions,
): Promise<{
  info: NonNullable<DiscoveryOpenInfo["setup"]>;
  screenshot?: string;
}> {
  const started = Date.now();
  const index = ++handle.actionCount;
  let resolved: Awaited<ReturnType<typeof resolveSetup>> | undefined;
  if (opts.setup) {
    resolved = await resolveSetup(opts.setup, {
      ...(opts.imports ? { imports: opts.imports } : {}),
      configDir: handle.configDir,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
      cwd: handle.cwd,
    }).catch((error: Error) => {
      throw new DiscoverySetupError(
        error.message,
        undefined,
        error instanceof SetupResolutionError ? 4 : undefined,
        { cause: error },
      );
    });
    handle.setupExport = resolved.exported;
    if (resolved.resume) handle.resume = resolved.resume;
    // Every later action runs with the source spec's own context.
    const { requires: _requires, ...runExtra } = resolved.extra;
    if (Object.keys(runExtra).length > 0) handle.runExtra = runExtra;
    handle.setRedactionConfig(
      resolved.extra["redaction"] as RedactionConfig | undefined,
    );
  }
  handle.imports = [
    ...new Set([...(resolved?.exported.imports ?? []), ...handle.useImports]),
  ];
  const resume = resolved?.resume ?? opts.resume;
  const run: RunStepsInput = {
    name: "discovery_setup",
    steps: resolved?.steps ?? [],
    ...(resolved ? { imports: resolved.imports, extra: resolved.extra } : {}),
    ...(resolved?.specDir ? { specDir: resolved.specDir } : {}),
    ...(resume ? { resume } : {}),
    ...(handle.journal ? { runsDir: handle.journal.resolve("setup") } : {}),
    screenshots: screenshotsOn(handle),
  };
  handle.journal?.update({
    ...(handle.imports.length > 0 ? { imports: handle.imports } : {}),
    ...(resume ? { resume } : {}),
  });
  let outcome: RunStepsOutcome | undefined;
  let error: string | undefined;
  let refused: SpecRefusedError | undefined;
  try {
    outcome = await runStepsThroughRunner(handle.runner, run);
    if (!outcome.ok) error = outcome.error ?? "setup failed";
  } catch (e) {
    error = (e as Error).message;
    if (e instanceof SpecRefusedError) refused = e;
  }
  const url = await handle.backend.getUrl().catch(() => "about:blank");
  handle.session.currentUrl = url;
  const screenshot = lastScreenshot(handle, index, outcome);
  const durationMs = Date.now() - started;
  handle.journal?.append({
    ts: new Date().toISOString(),
    type: "action.performed",
    index,
    action: "setup",
    ok: error === undefined,
    ...(error ? { error: handle.redactor.text(error) } : {}),
    urlBefore: "about:blank",
    urlAfter: journalUrl(handle, url),
    durationMs,
    ...(screenshot ? { screenshot } : {}),
  });
  const warnings = [
    ...(resolved?.warnings ?? []),
    ...screenshotWarnings(handle, index),
  ];
  if (error !== undefined) {
    const runDir = outcome?.runDir;
    throw new DiscoverySetupError(
      `discovery setup failed: ${handle.redactor.text(error)}${
        runDir ? ` (setup run: ${runDir})` : ""
      }`,
      runDir,
      refused ? refused.exitCode : undefined,
      refused ? { cause: refused } : undefined,
    );
  }
  // A passing setup run is evidence, not noise: keep it in the journal.
  return {
    info: {
      ok: true,
      steps: outcome?.steps.length ?? 0,
      durationMs,
      ...(handle.journal && outcome ? { runDir: outcome.runDir } : {}),
      warnings,
    },
    ...(screenshot ? { screenshot } : {}),
  };
}

/* ----- performing actions ----- */

interface ActionInput {
  action: string;
  /** The step the session records (placeholders kept). */
  recorded: Record<string, unknown>;
  /** The step executed when it differs (auto-assign, resolved URL). */
  executed?: Record<string, unknown>;
  locator?: Record<string, unknown>;
  snapshotMode?: SnapshotMode | undefined;
  maxBytes?: number | undefined;
}

interface ActionOutcome {
  ok: boolean;
  index: number;
  error?: string;
  resolvedElement?: ResolvedElement;
  url: string;
  snapshot: DiscoverySnapshotElement[];
  snapshotInfo: SnapshotInfo;
  screenshot?: string;
  mutations: Array<{ method: string; path: string; status?: number }>;
  captures: Record<string, unknown>;
  durationMs: number;
  /** A screenshot timeout turned screenshots off during this action. */
  warnings?: string[];
}

async function performAction(
  handle: DiscoverySessionHandle,
  input: ActionInput,
): Promise<ActionOutcome> {
  await flushLateNetwork(handle);
  const index = ++handle.actionCount;
  const urlBefore = handle.session.currentUrl;
  const started = Date.now();
  let outcome: RunStepsOutcome | undefined;
  let error: string | undefined;
  try {
    outcome = await runStepsThroughRunner(handle.runner, {
      name: "discovery_action",
      steps: [input.executed ?? input.recorded],
      imports: handle.imports,
      ...(handle.runExtra ? { extra: handle.runExtra } : {}),
      screenshots: screenshotsOn(handle),
    });
    if (!outcome.ok) error = outcome.error ?? "step failed";
  } catch (e) {
    error = (e as Error).message;
  }
  const durationMs = Date.now() - started;
  const ok = error === undefined;
  if (ok && outcome) keepCaptures(handle, outcome);
  const entries = harvestNetwork(handle, index, outcome);
  const screenshot = lastScreenshot(handle, index, outcome);
  const resolvedElement = outcome?.steps.findLast(
    (step) => step.resolved,
  )?.resolved;
  if (ok) await outcome?.dispose();

  const view = await capture(handle, input.snapshotMode, input.maxBytes);
  const url = await handle.backend
    .getUrl()
    .catch(() =>
      ok && "open" in input.recorded ? openTarget(input) : urlBefore,
    );
  handle.session.currentUrl = url;

  const timestamp = new Date().toISOString();
  handle.session.steps.push({
    step: input.recorded,
    timestamp,
    ok,
    index,
    ...(resolvedElement ? { resolvedElement } : {}),
  });
  const mutations = mutationsOf(entries);
  handle.journal?.append({
    ts: timestamp,
    type: "action.performed",
    index,
    action: input.action,
    ...(input.locator ? { locator: input.locator } : {}),
    ok,
    ...(error ? { error: handle.redactor.text(error) } : {}),
    urlBefore: journalUrl(handle, urlBefore),
    urlAfter: journalUrl(handle, url),
    durationMs,
    ...(screenshot ? { screenshot } : {}),
    ...(view.info.path ? { snapshot: view.info.path } : {}),
    ...(entries.length > 0 ? { network: { mutations } } : {}),
  });
  const warnings = screenshotWarnings(handle, index);
  if (ok) {
    handle.journal?.append({
      ts: timestamp,
      type: "step.recorded",
      index,
      step: input.recorded,
    });
    writeDraft(handle);
  }
  touchJournal(handle, url);
  return {
    ok,
    index,
    ...(error ? { error: publicText(handle, error) } : {}),
    ...(resolvedElement ? { resolvedElement } : {}),
    url: publicUrl(handle, url),
    snapshot: view.snapshot,
    snapshotInfo: view.info,
    ...(screenshot ? { screenshot } : {}),
    mutations,
    captures: outcome?.captures ?? {},
    durationMs,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** Keep the captures an action made (`assign`ed by the step itself). */
function keepCaptures(
  handle: DiscoverySessionHandle,
  outcome: Pick<RunStepsOutcome, "evals" | "requests">,
): void {
  for (const [kind, values] of [
    ["evals", outcome.evals],
    ["requests", outcome.requests],
  ] as const) {
    for (const [name, value] of Object.entries(values)) {
      if (name === AUTO_EVAL_ASSIGN || name === AUTO_REQUEST_ASSIGN) continue;
      handle.captures[kind][name] = value;
    }
  }
}

/**
 * The step to execute, with `${evals.X…}` / `${requests.X…}` captured by an
 * earlier action spliced in (each action is its own run, which would
 * otherwise type the literal placeholder). Refused when a reference was
 * never captured, when the capture is redacted in the run's artifacts, or
 * for `${artifacts.X}` of an earlier action (its run is gone).
 */
function spliceCaptures(
  handle: DiscoverySessionHandle,
  step: Record<string, unknown>,
): { step: Record<string, unknown> } | { error: string } {
  if (!/\$\{(?:evals|requests|artifacts)\./.test(JSON.stringify(step))) {
    return { step };
  }
  const { evals, requests } = handle.captures;
  const missing = collectUnresolvedRuntimeRefs(step, {}, requests, evals);
  if (missing.length > 0) {
    return {
      error:
        `step references ${missing.map((ref) => `\${${ref}}`).join(", ")}, ` +
        "which no earlier action of this session captured; record the eval/request " +
        "with that `assign` first (artifacts of an earlier action are not kept between actions)",
    };
  }
  const spliced = deepMapStrings(step, (text) =>
    resolveEvalPlaceholders(resolveResponsePlaceholders(text, requests), evals),
  );
  if (holdsRedacted(spliced) && !holdsRedacted(step)) {
    return {
      error:
        `a captured value this step uses is ${REDACTED} in the session's artifacts, ` +
        "so discovery cannot splice it live; the recorded placeholder resolves when the exported spec runs",
    };
  }
  return { step: spliced };
}

function openTarget(input: ActionInput): string {
  const open = (input.executed ?? input.recorded)["open"];
  if (typeof open === "string") return open;
  if (open && typeof open === "object") {
    const path = (open as Record<string, unknown>)["path"];
    if (typeof path === "string") return path;
  }
  return "about:blank";
}

/** Whether this session still captures a screenshot per action. */
function screenshotsOn(handle: DiscoverySessionHandle): boolean {
  return handle.screenshots.disabled === undefined;
}

/**
 * Once, right after the action (index) whose screenshot capture timed out:
 * journal `screenshots.disabled` and return the warning that action's result
 * carries. Screenshots stay off for the session. Usually its browser, page
 * and steps are untouched, but a backend may have had to stop its browser
 * over the hung capture (agent-browser when the capture still blocked its
 * daemon; Playwright on any capture timeout): it then reports itself
 * wedged, and the warning says the page state is gone.
 */
function screenshotWarnings(
  handle: DiscoverySessionHandle,
  index: number,
): string[] {
  const state = handle.screenshots;
  if (state.disabled === undefined || state.reported) return [];
  state.reported = true;
  const reason = handle.redactor.text(state.disabled);
  handle.journal?.append({
    ts: new Date().toISOString(),
    type: "screenshots.disabled",
    index,
    reason,
  });
  const next =
    handle.backend.isWedged?.() === true
      ? "The browser backend had to stop its browser over the hung capture, so this session's page state (URL, cookies, storage) is gone: close it and open a new session once the display is awake and unlocked."
      : "The session and its browser keep going; open a new session (display awake and unlocked) to capture screenshots again.";
  return [
    `screenshots are off for the rest of this session: ${reason}. ${next}`,
  ];
}

function lastScreenshot(
  handle: DiscoverySessionHandle,
  index: number,
  outcome: RunStepsOutcome | undefined,
): string | undefined {
  const source = outcome?.screenshots.findLast((path) => path !== undefined);
  if (!source || !handle.journal) return undefined;
  return handle.journal.copyScreenshot(index, source);
}

/** Redacted, query-free URL for the journal. */
function journalUrl(handle: DiscoverySessionHandle, url: string): string {
  return withoutQuery(handle.redactor.text(url));
}

function publicText(handle: DiscoverySessionHandle, text: string): string {
  return handle.redactUrl ? handle.redactUrl(text) : handle.redactor.text(text);
}

function touchJournal(handle: DiscoverySessionHandle, url: string): void {
  if (!handle.journal) return;
  handle.journal.update({
    lastActivityAt: new Date().toISOString(),
    currentUrl: journalUrl(handle, url),
    stepCount: exportable(handle).length,
    actionCount: handle.actionCount,
  });
}

/* ----- network ----- */

function harvestNetwork(
  handle: DiscoverySessionHandle,
  index: number,
  outcome: RunStepsOutcome | undefined,
): DiscoveryNetworkEntry[] {
  // No run (it threw before starting): the backend log was not cleared, so
  // the previous action's attribution stays valid.
  if (!outcome) return [];
  const raw = outcome.network;
  const entries = raw.map((entry) =>
    toDiscoveryEntry(entry, index, (text) => handle.redactor.text(text)),
  );
  handle.network.entries.push(...entries);
  handle.network.harvested = raw.length;
  handle.network.lastAction = index;
  if (entries.length > 0) {
    handle.journal?.writeJson(`network/${journalSeq(index)}.json`, entries);
  }
  return entries;
}

/**
 * Requests that completed after an action returned (a debounced autosave, a
 * late XHR) are still in the backend's log: attribute them to that action
 * before the next run clears the log.
 */
async function flushLateNetwork(handle: DiscoverySessionHandle): Promise<void> {
  const action = handle.network.lastAction;
  if (action === 0) return;
  const raw = await handle.backend.getNetworkRequests().catch(() => []);
  const late = raw.slice(handle.network.harvested);
  if (late.length === 0) return;
  handle.network.harvested = raw.length;
  const entries = late.map((entry) =>
    toDiscoveryEntry(entry, action, (text) => handle.redactor.text(text), true),
  );
  handle.network.entries.push(...entries);
  handle.journal?.writeJson(
    `network/${journalSeq(action)}.json`,
    handle.network.entries.filter((entry) => entry.action === action),
  );
}

/** Requests the session observed (redacted), optionally filtered. */
export async function getNetwork(
  handle: DiscoverySessionHandle,
  query: NetworkQuery = {},
): Promise<ReturnType<typeof queryNetwork>> {
  touch(handle);
  return withLock(handle, async () => {
    await flushLateNetwork(handle);
    return queryNetwork(handle.network.entries, query);
  });
}

/* ----- snapshots ----- */

async function capture(
  handle: DiscoverySessionHandle,
  mode: SnapshotMode | undefined,
  maxBytes: number | undefined,
): Promise<{ snapshot: DiscoverySnapshotElement[]; info: SnapshotInfo }> {
  const snap = await handle.backend
    .snapshot({ interactive: true })
    .catch(() => undefined);
  const text = snap?.ok ? snap.text : "";
  const elements = text ? parseSnapshotWithFlags(text) : [];
  const effectiveMode = mode ?? handle.snapshotMode;
  let path: string | undefined;
  let bytes = Buffer.byteLength(text);
  if (handle.journal && text) {
    const seq = ++handle.snapshotSeq;
    const written = handle.journal.writeText(
      `snapshots/${journalSeq(seq)}.txt`,
      text,
    );
    if (written) {
      path = written.path;
      bytes = written.bytes;
      handle.journal.append({
        ts: new Date().toISOString(),
        type: "snapshot.captured",
        path,
        bytes,
        mode: effectiveMode,
        elements: elements.length,
      });
    }
  }
  const view = snapshotView({
    current: elements,
    previous: handle.session.lastSnapshot,
    mode: effectiveMode,
    maxBytes: maxBytes ?? handle.maxBytes,
    ...(path ? { path } : {}),
    bytes,
    redact: (value) => handle.redactor.text(value),
  });
  handle.session.lastSnapshot = elements;
  return { snapshot: view.snapshot, info: view.info };
}

/**
 * A URL (or backend message quoting one) safe to return or display: the
 * session's redactor applied (see {@link DiscoverySessionHandle.redactUrl}).
 * Defaults to the current page.
 */
export function publicUrl(
  handle: DiscoverySessionHandle,
  url: string = handle.session.currentUrl,
): string {
  return handle.redactUrl ? handle.redactUrl(url) : url;
}

function touch(handle: DiscoverySessionHandle): void {
  handle.session.lastActivity = Date.now();
}

/**
 * Capture the current page snapshot (`mode` default: the session's, diff).
 */
export async function captureSnapshot(
  handle: DiscoverySessionHandle,
  opts: { mode?: SnapshotMode; maxBytes?: number } = {},
): Promise<{
  snapshot: DiscoverySnapshotElement[];
  url: string;
  snapshotInfo: SnapshotInfo;
}> {
  touch(handle);
  return withLock(handle, async () => {
    const view = await capture(handle, opts.mode, opts.maxBytes);
    const url = await handle.backend
      .getUrl()
      .catch(() => handle.session.currentUrl);
    handle.session.currentUrl = url;
    touchJournal(handle, url);
    return {
      snapshot: view.snapshot,
      url: publicUrl(handle, url),
      snapshotInfo: view.info,
    };
  });
}

/**
 * Capture the live session's browser state (cookies/localStorage/IndexedDB) to
 * a checkpoint file via the backend's `saveState`. Runs under the session lock
 * so it doesn't interleave with an in-flight interaction on the shared browser.
 * The resulting file is resumable through `session: { resume: <name> }`, which
 * is how a discovered authenticated flow satisfies the cold-start contract.
 */
export async function captureCheckpoint(
  handle: DiscoverySessionHandle,
  path: string,
): Promise<InvocationResult> {
  touch(handle);
  return withLock(handle, () => handle.backend.saveState(path));
}

/* ----- interact ----- */

export interface InteractInput {
  action?: DiscoveryAction;
  target?: Locator | string;
  value?: string;
  label?: string;
  path?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollPixels?: number;
  eval?: Record<string, unknown>;
  wait?: WaitCondition;
  assert?: WaitCondition;
  request?: Record<string, unknown>;
  /** Any spec step (escape hatch; validated with StepSchema). */
  step?: Record<string, unknown>;
  /** Step `id` to record. */
  id?: string;
  snapshotMode?: SnapshotMode;
  maxBytes?: number;
}

function invalid(
  handle: DiscoverySessionHandle,
  error: string,
): DiscoveryInteractResult {
  return { ok: false, url: publicUrl(handle), snapshot: [], error };
}

/**
 * Perform an interaction on the page and record the step.
 */
export async function interact(
  handle: DiscoverySessionHandle,
  input: InteractInput,
): Promise<DiscoveryInteractResult> {
  touch(handle);

  // Reject ephemeral snapshot @refs up front with a specific message: they
  // execute live but can never replay, so recording one would silently produce
  // a broken spec (recordInteraction also guards this for direct callers).
  if (isEphemeralTarget(input.target)) {
    return invalid(
      handle,
      'target is an ephemeral snapshot @ref (e.g. "@e2") that cannot replay; pass a stable locator from cairn_discover_inventory (by: role|label|text) or a CSS selector instead',
    );
  }

  let built: Record<string, unknown> | undefined;
  let action: string;
  if (input.step) {
    built = input.id ? { id: input.id, ...input.step } : { ...input.step };
    action = stepKind(built);
  } else if (input.action) {
    action = input.action;
    built = recordInteraction({
      action: input.action,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      ...(input.scrollDirection !== undefined
        ? { scrollDirection: input.scrollDirection }
        : {}),
      ...(input.scrollPixels !== undefined
        ? { scrollPixels: input.scrollPixels }
        : {}),
      ...(input.eval !== undefined ? { eval: input.eval } : {}),
      ...(input.wait !== undefined ? { wait: input.wait } : {}),
      ...(input.assert !== undefined ? { assert: input.assert } : {}),
      ...(input.request !== undefined ? { request: input.request } : {}),
      ...(input.id !== undefined ? { id: input.id } : {}),
    });
    if (!built) {
      return invalid(
        handle,
        `invalid interaction: ${missingInputMessage({ action: input.action })}`,
      );
    }
  } else {
    return invalid(handle, "invalid interaction: pass action or step");
  }

  // Recorded steps are spec steps: portable file paths, secrets as
  // placeholders, and valid against the spec StepSchema.
  const recorded = withSecretPlaceholders(
    withPortableFilePaths(built, {
      cwd: handle.cwd,
      configDir: handle.configDir,
    }),
    handle.secrets,
  );
  const issues = stepSchemaIssues(recorded);
  if (issues) {
    return invalid(
      handle,
      `invalid interaction: not a valid spec step: ${issues}`,
    );
  }
  if ("use" in recorded) {
    const name = useName(recorded["use"]);
    try {
      const files = await resolveActionFiles([name], {
        configDir: handle.configDir,
        ...(handle.config !== undefined ? { config: handle.config } : {}),
        cwd: handle.cwd,
        imports: handle.imports,
      });
      for (const file of files) {
        if (!handle.useImports.includes(file)) handle.useImports.push(file);
        if (!handle.imports.includes(file)) handle.imports.push(file);
      }
      handle.journal?.update({ imports: handle.imports });
    } catch (e) {
      return invalid(handle, (e as Error).message);
    }
  }
  const executed =
    input.action === "assert"
      ? withAssertBudget(recorded)
      : withAutoAssign(recorded);

  return withLock(handle, async () => {
    // Inside the lock: an action queued ahead may capture what this uses.
    const spliced = spliceCaptures(handle, executed);
    if ("error" in spliced) {
      return invalid(handle, `invalid interaction: ${spliced.error}`);
    }
    const run = spliced.step;
    const outcome = await performAction(handle, {
      action,
      recorded,
      ...(run !== recorded ? { executed: run } : {}),
      ...(locatorOf(recorded) ? { locator: locatorOf(recorded)! } : {}),
      snapshotMode: input.snapshotMode,
      maxBytes: input.maxBytes,
    });
    const result = actionResult(handle, recorded, outcome, input.maxBytes);
    return {
      ok: outcome.ok,
      index: outcome.index,
      ...(outcome.resolvedElement
        ? { resolvedElement: outcome.resolvedElement }
        : {}),
      url: outcome.url,
      snapshot: outcome.snapshot,
      snapshotInfo: outcome.snapshotInfo,
      ...(outcome.ok ? {} : { error: outcome.error ?? "step failed" }),
      recordedStep: recorded,
      durationMs: outcome.durationMs,
      ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
      network: { mutations: outcome.mutations },
      ...(result ? { result } : {}),
      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
    };
  });
}

/** How long an `assert` waits live (the recorded wait keeps the run default). */
export const ASSERT_TIMEOUT_MS = 5_000;

/**
 * An assertion is about the page now: fail it after a few seconds instead
 * of a wait's 30s default. The recorded step is unchanged.
 */
function withAssertBudget(
  step: Record<string, unknown>,
): Record<string, unknown> {
  const wait = step["wait"];
  if (!wait || typeof wait !== "object" || "timeoutMs" in wait) return step;
  return { ...step, wait: { ...wait, timeoutMs: ASSERT_TIMEOUT_MS } };
}

const AUTO_EVAL_ASSIGN = "discovery_eval";
const AUTO_REQUEST_ASSIGN = "discovery_request";

/**
 * An eval/request without `assign` captures nothing; the executed copy
 * assigns one so the agent sees the value. The RECORDED step is unchanged.
 */
function withAutoAssign(
  step: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, name] of [
    ["eval", AUTO_EVAL_ASSIGN],
    ["request", AUTO_REQUEST_ASSIGN],
  ] as const) {
    const body = step[key];
    if (body && typeof body === "object" && !("assign" in body)) {
      return { ...step, [key]: { ...(body as object), assign: name } };
    }
  }
  return step;
}

function actionResult(
  handle: DiscoverySessionHandle,
  recorded: Record<string, unknown>,
  outcome: ActionOutcome,
  maxBytes: number | undefined,
): Record<string, unknown> | undefined {
  const pick = (key: "eval" | "request", auto: string): unknown => {
    const body = recorded[key] as Record<string, unknown> | undefined;
    if (!body) return undefined;
    const assign = typeof body["assign"] === "string" ? body["assign"] : auto;
    return outcome.captures[assign];
  };
  const budget = Math.max(
    256,
    Math.floor((maxBytes ?? handle.maxBytes ?? 16_384) / 2),
  );
  const evalValue = pick("eval", AUTO_EVAL_ASSIGN);
  if (evalValue && typeof evalValue === "object" && "value" in evalValue) {
    return bounded(
      { value: handle.redactor.value((evalValue as { value: unknown }).value) },
      budget,
    );
  }
  const response = pick("request", AUTO_REQUEST_ASSIGN) as
    | { status?: unknown; body?: unknown }
    | undefined;
  if (response && typeof response === "object") {
    return bounded(
      {
        ...(typeof response.status === "number"
          ? { status: response.status }
          : {}),
        body: handle.redactor.value(response.body),
      },
      budget,
    );
  }
  return undefined;
}

/** Keep a returned value within `budget` bytes of JSON (else a preview). */
function bounded(
  value: Record<string, unknown>,
  budget: number,
): Record<string, unknown> {
  const text = JSON.stringify(value) ?? "";
  if (Buffer.byteLength(text) <= budget) return value;
  return { truncated: true, preview: text.slice(0, budget) };
}

function stepKind(step: Record<string, unknown>): string {
  const keys = Object.keys(step).filter(
    (key) => key !== "id" && key !== "when" && key !== "postcondition",
  );
  return keys.find((key) => key !== "target" && key !== "until") ?? "step";
}

function useName(use: unknown): string {
  if (typeof use === "string") return use;
  if (use && typeof use === "object") {
    const action = (use as Record<string, unknown>)["action"];
    if (typeof action === "string") return action;
  }
  return String(use);
}

/** The locator an interactive step acts on (for the journal). */
function locatorOf(
  step: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const key of [
    "click",
    "hover",
    "focus",
    "fill",
    "type",
    "select",
    "upload",
    "download",
  ]) {
    const body = step[key];
    if (body && typeof body === "object" && "by" in body) {
      const {
        value: _value,
        label: _label,
        path: _path,
        until: _until,
        ...locator
      } = body as Record<string, unknown>;
      return locator;
    }
  }
  if (step["target"] && typeof step["target"] === "object") {
    return step["target"] as Record<string, unknown>;
  }
  const scroll = step["scroll"];
  if (scroll && typeof scroll === "object" && "to" in scroll) {
    return (scroll as { to: Record<string, unknown> }).to;
  }
  return undefined;
}

/* ----- navigate ----- */

/**
 * Navigate to a new URL within the session.
 */
export async function navigate(
  handle: DiscoverySessionHandle,
  url: string,
  opts?: {
    waitUntil?: "networkidle" | "load" | "domcontentloaded";
    snapshotMode?: SnapshotMode;
    maxBytes?: number;
  },
): Promise<DiscoveryInteractResult> {
  touch(handle);
  const target = resolveNavigationUrl(handle, url);
  // A relative URL joined onto the config baseUrl is RECORDED relative, so
  // the exported spec follows whichever environment runs it. One resolved
  // against the current page (no baseUrl) has no such anchor at run time, so
  // the absolute target is recorded.
  const recordedUrl = isRelativeUrl(url) && handle.baseUrl ? url : target;
  const stepFor = (u: string): Record<string, unknown> =>
    opts?.waitUntil !== undefined
      ? recordOpenWithWait(u, opts.waitUntil)
      : recordOpen(u);
  const recorded = withSecretPlaceholders(stepFor(recordedUrl), handle.secrets);
  // Placeholders are resolved by the runner (same config/env/secrets);
  // anything else navigates to the target resolved here.
  const executed = url.includes("${") ? recorded : stepFor(target);

  return withLock(handle, async () => {
    const spliced = spliceCaptures(handle, executed);
    if ("error" in spliced) {
      return invalid(handle, `navigation refused: ${spliced.error}`);
    }
    const run = spliced.step;
    const outcome = await performAction(handle, {
      action: "navigate",
      recorded,
      ...(run !== recorded ? { executed: run } : {}),
      snapshotMode: opts?.snapshotMode,
      maxBytes: opts?.maxBytes,
    });
    return {
      ok: outcome.ok,
      index: outcome.index,
      url: outcome.url,
      snapshot: outcome.snapshot,
      snapshotInfo: outcome.snapshotInfo,
      ...(outcome.ok ? {} : { error: outcome.error ?? "navigation failed" }),
      recordedStep: recorded,
      durationMs: outcome.durationMs,
      ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
      network: { mutations: outcome.mutations },
      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
    };
  });
}

/**
 * Resolve a `navigate` URL. A relative URL joins the session's config
 * baseUrl, else resolves against the page the browser is on (like following
 * a relative link). With neither, a real browser would be sent to a bare
 * `/path`, so that fails loudly; only the mock backend (which never
 * navigates anything real) keeps the bare path.
 */
export function resolveNavigationUrl(
  handle: DiscoverySessionHandle,
  url: string,
): string {
  if (!isRelativeUrl(url)) return url;
  if (handle.baseUrl) return joinUrl(handle.baseUrl, url);
  const current = handle.session.currentUrl;
  if (/^https?:\/\//i.test(current)) return resolveUrl(current, url);
  if (handle.backend.name === "mock") return url;
  throw new Error(
    `discovery: relative URL "${url}" cannot be resolved — the session has ` +
      `no config baseUrl and the current page (${publicUrl(handle, current) || "none"}) is not ` +
      `an http(s) URL; pass an absolute URL or reopen the session with a ` +
      `config/env that defines baseUrl`,
  );
}

/**
 * Collect locator inventory from the current page. Test ids are scanned on
 * the session's `browser.testIdAttribute` (default `data-testid`).
 */
export async function getInventory(
  handle: DiscoverySessionHandle,
  opts?: { roles?: boolean; testids?: boolean },
): Promise<LocatorInventory> {
  touch(handle);
  const includeRoles = opts?.roles || (!opts?.roles && !opts?.testids);
  const includeTestIds = opts?.testids || (!opts?.roles && !opts?.testids);
  return withLock(handle, () =>
    collectLocatorInventory(handle.backend, {
      roles: includeRoles,
      testids: includeTestIds,
      ...(handle.testIdAttribute
        ? { testIdAttribute: handle.testIdAttribute }
        : {}),
    }),
  );
}

/* ----- recorded steps ----- */

function exportable(handle: DiscoverySessionHandle): RecordedStep[] {
  return handle.session.steps.filter((step) => step.ok && !step.removed);
}

/**
 * Get all recorded steps (for suggest/review). Refreshes the session's
 * activity timestamp so reviewing a session keeps it alive — otherwise a long
 * review pause could let the idle sweep reap the session mid-export.
 */
export function getSteps(
  handle: DiscoverySessionHandle,
): Record<string, unknown>[] {
  touch(handle);
  return handle.session.steps
    .filter((step) => !step.removed)
    .map((step) => step.step);
}

/**
 * Get the steps that are safe to export as a spec: only those that executed
 * successfully. A failed interaction (a click that didn't resolve, a 404
 * navigate) never achieved its effect, so exporting it would produce a spec
 * that can't replay. Returns the count of excluded failed steps so callers can
 * warn the agent.
 */
export function getExportableSteps(handle: DiscoverySessionHandle): {
  steps: Record<string, unknown>[];
  skippedFailed: number;
} {
  touch(handle);
  const ok = exportable(handle);
  return {
    steps: ok.map((s) => s.step),
    skippedFailed: handle.session.steps.filter((s) => !s.ok && !s.removed)
      .length,
  };
}

/**
 * Undo the step recorded by action `index` (it stays in the journal as
 * `step.removed`; the browser state is not rolled back).
 */
export function removeStep(
  handle: DiscoverySessionHandle,
  index: number,
): { removed: boolean; steps: number } {
  touch(handle);
  const recorded = handle.session.steps.find(
    (step) => step.index === index && step.ok && !step.removed,
  );
  if (!recorded) return { removed: false, steps: exportable(handle).length };
  recorded.removed = true;
  handle.journal?.append({
    ts: new Date().toISOString(),
    type: "step.removed",
    index,
  });
  writeDraft(handle);
  touchJournal(handle, handle.session.currentUrl);
  return { removed: true, steps: exportable(handle).length };
}

/* ----- draft ----- */

/** Where a draft would be promoted from (config `authoring.draftsDir`). */
function draftsDirOf(handle: DiscoverySessionHandle): string {
  const authoring =
    handle.config && typeof handle.config === "object"
      ? (handle.config as Record<string, unknown>)["authoring"]
      : undefined;
  const dir =
    authoring && typeof authoring === "object"
      ? (authoring as Record<string, unknown>)["draftsDir"]
      : undefined;
  return join(
    handle.configDir,
    typeof dir === "string" ? dir : "flows/_drafts",
  );
}

/**
 * The YAML an export would write now (imports relative to `specPath`).
 * `redact` (the journal's) is applied to every value before it becomes
 * YAML — never to the YAML text, which would cut a quoted placeholder.
 */
export function draftYaml(
  handle: Pick<
    DiscoverySessionHandle,
    "session" | "setupExport" | "resume" | "draft"
  > & { useImports?: readonly string[] },
  specPath: string,
  steps: Record<string, unknown>[],
  redact: <T>(value: T) => T = (value) => value,
): { yaml: string; stepCount: number } {
  const name =
    handle.draft.name ??
    `draft_${handle.session.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8)
      .toLowerCase()}`;
  const setup = handle.setupExport;
  const imports = [
    ...new Set([...(setup?.imports ?? []), ...(handle.useImports ?? [])]),
  ];
  return buildSpecYaml({
    name,
    intent: redact(
      handle.draft.intent ?? "(draft) describe what this journey proves",
    ),
    outcomes: redact(handle.draft.outcomes ?? []) as Parameters<
      typeof buildSpecYaml
    >[0]["outcomes"],
    steps: redact(steps),
    sessionId: handle.session.id,
    draft: true,
    ...(imports.length > 0
      ? { imports: imports.map((file) => rebaseImport(file, specPath)) }
      : {}),
    ...(setup
      ? {
          setupSteps: redact(setup.steps),
          ...(setup.vars ? { vars: redact(setup.vars) } : {}),
          ...(setup.requires !== undefined ? { requires: setup.requires } : {}),
          ...(setup.coldStart ? { coldStart: setup.coldStart } : {}),
        }
      : {}),
    ...((setup?.resume ?? handle.resume)
      ? { resume: setup?.resume ?? handle.resume }
      : {}),
  });
}

/** Regenerate `draft.spec.yml` (secrets are placeholders; values redacted). */
function writeDraft(handle: DiscoverySessionHandle): void {
  const journal = handle.journal;
  if (!journal) return;
  const steps = exportable(handle).map((step) => step.step);
  const name = handle.draft.name ?? "draft";
  const { yaml, stepCount } = draftYaml(
    handle,
    join(draftsDirOf(handle), `${name}.yml`),
    steps,
    (value) => journal.redactValue(value),
  );
  const written = journal.writeText(DRAFT_FILE, yaml, { preRedacted: true });
  if (!written) return;
  journal.append({
    ts: new Date().toISOString(),
    type: "draft.updated",
    path: DRAFT_FILE,
    steps: stepCount,
  });
}

/** Note an export (journal + draft follow its intent/outcomes). */
export function recordExport(
  handle: DiscoverySessionHandle,
  input: {
    path: string;
    name: string;
    intent: string;
    outcomes: unknown[];
  },
): void {
  handle.draft = {
    name: input.name,
    intent: input.intent,
    outcomes: input.outcomes,
  };
  writeDraft(handle);
}

/* ----- lifecycle ----- */

function endJournal(
  handle: DiscoverySessionHandle,
  status: "closed" | "expired",
  reason: "ttl" | "close" | "shutdown" | "export",
  error?: string,
): void {
  const journal = handle.journal;
  if (!journal || handle.journalEnded) return;
  handle.journalEnded = true;
  liveJournals.delete(journal.dir);
  const now = new Date().toISOString();
  journal.append({
    ts: now,
    type: "session.closed",
    reason,
    ...(error ? { error: handle.redactor.text(error) } : {}),
  });
  // The update re-reads session.json first: an export from the journal in
  // another process may have recorded `exportedTo` since the last action.
  journal.update({ closedAt: now, lastActivityAt: now });
  const exported = (journal.snapshot.exportedTo?.length ?? 0) > 0;
  journal.update({ status: exported ? "exported" : status });
}

function disposeWorkDir(handle: DiscoverySessionHandle): void {
  try {
    if (handle.ownedWorkDir) {
      rmSync(handle.ownedWorkDir, { recursive: true, force: true });
    } else if (handle.journal) {
      rmSync(handle.journal.resolve("work"), { recursive: true, force: true });
    }
  } catch {
    // Best-effort.
  }
}

/**
 * Close a session and free the backend. Runs under the session lock so the
 * backend isn't torn down while an in-flight interact/navigate still uses it.
 * The journal stays (status closed / expired / exported).
 */
export async function closeSession(
  handle: DiscoverySessionHandle,
  reason: "ttl" | "close" | "shutdown" | "export" = "close",
): Promise<void> {
  if (handle.closed) return;
  handle.closed = true;
  await withLock(handle, () => handle.backend.close()).catch(() => undefined);
  endJournal(handle, reason === "ttl" ? "expired" : "closed", reason);
  disposeWorkDir(handle);
}

/**
 * Sweep expired sessions from the registry (each session's own `ttlMs`).
 * The browser closes; the journal stays with status `expired`. Returns the
 * IDs of closed sessions.
 */
export async function sweepSessions(
  registry: SessionRegistry,
  now: number = Date.now(),
): Promise<string[]> {
  const expired: string[] = [];
  for (const [id, handle] of registry) {
    if (now - handle.session.lastActivity > handle.ttlMs) {
      expired.push(id);
      // Drop from the registry BEFORE closing so a concurrent call sees
      // "session not found" instead of racing the teardown.
      registry.delete(id);
      await closeSession(handle, "ttl").catch(() => undefined);
    }
  }
  return expired;
}

/**
 * Close all sessions in the registry (used on server shutdown).
 */
export async function closeAllSessions(
  registry: SessionRegistry,
): Promise<void> {
  for (const handle of registry.values()) {
    await closeSession(handle, "shutdown").catch(() => undefined);
  }
  registry.clear();
}

/**
 * Signal path: mark every journal closed synchronously (the process exits
 * as soon as the handler returns; backends are killed by the caller).
 */
export function endAllJournalsSync(registry: SessionRegistry): void {
  // The backends are terminated by the caller; closeSession may still run
  // afterwards (async path) and only closes what is left.
  for (const handle of registry.values()) {
    endJournal(handle, "closed", "shutdown");
  }
}

/* ----- resume ----- */

export type ResumeOptions = Omit<
  DiscoverySessionOptions,
  "sessionId" | "setup" | "resume" | "recordUrl" | "waitUntil" | "artifactRoot"
>;

/**
 * Why a journal cannot be resumed (or exported) as it is, or undefined:
 * another live process still writes it, a step line could not be read, or a
 * recorded step holds a value the redactor replaced (a literal secret the
 * agent typed instead of a `${secrets.X}` placeholder) — replaying
 * `[redacted]` would only look like success.
 */
export function journalRefusal(
  read: SessionJournalRead,
  opts: { live?: boolean } = {},
): string | undefined {
  const session = read.session;
  if (opts.live !== false) {
    if (liveJournals.has(read.dir)) {
      return `session ${session.sessionId} is open in this process; use it (or close it) instead of resuming`;
    }
    const pid = openElsewhere(session);
    if (pid !== undefined) {
      return `session ${session.sessionId} is still open in process ${pid}; close it there (cairn_discover_close) or wait for its TTL before resuming`;
    }
  }
  if (read.unreadableSteps) {
    return `session ${session.sessionId}: ${read.unreadableSteps} recorded step event(s) in events.ndjson cannot be read (written by a newer cairn, or damaged); the recorded steps are incomplete`;
  }
  const redacted = journalSteps(read.events)
    .steps.filter(({ step }) => holdsRedacted(step))
    .map(({ index }) => index);
  if (redacted.length > 0) {
    return `session ${session.sessionId}: recorded step(s) of action ${redacted.join(", ")} hold ${REDACTED} (a literal secret was scrubbed from the journal); remove them (cairn_discover_remove_step) and record the value as a \${secrets.X} placeholder`;
  }
  return undefined;
}

/**
 * Re-open a session from its journal on a fresh backend: restore the
 * checkpoint and run the setup again, then replay every recorded step in one
 * runner pass. The journal continues (same id; `session.opened` with
 * `resumed: true`, then a `replay` action). Throws when the replay fails,
 * and before anything starts when {@link journalRefusal} refuses it.
 */
export async function resumeSession(
  backend: BrowserBackend,
  read: SessionJournalRead,
  opts: ResumeOptions = {},
): Promise<DiscoverySessionHandle> {
  const refusal = journalRefusal(read);
  if (refusal) throw new Error(`discovery resume: ${refusal}`);
  const prior = read.session;
  const handle = buildHandle(
    backend,
    {
      ...opts,
      sessionId: prior.sessionId,
      ...(prior.setup ? { setup: prior.setup } : {}),
      ...(prior.resume ? { resume: prior.resume } : {}),
      ...(prior.waitUntil ? { waitUntil: prior.waitUntil } : {}),
    },
    prior.sessionId,
    Date.now(),
    read.dir,
  );
  const journal = SessionJournal.attach(read.dir, prior, handle.redactor);
  handle.journal = journal;
  liveJournals.add(journal.dir);
  // Action files the recorded `use:` steps need (the setup re-resolves its
  // own); a superset is harmless.
  handle.useImports = [...(prior.imports ?? [])];
  handle.imports = [...handle.useImports];
  const { steps } = journalSteps(read.events);
  handle.actionCount = read.events.reduce(
    (max, event) =>
      event.type === "action.performed" ? Math.max(max, event.index) : max,
    0,
  );
  handle.snapshotSeq = read.events.filter(
    (event) => event.type === "snapshot.captured",
  ).length;
  handle.network.entries = loadNetwork(read.dir);
  if (prior.intent) {
    handle.draft = {
      intent: prior.intent,
      ...(prior.outcomes ? { outcomes: prior.outcomes } : {}),
    };
  }
  for (const { index, step } of steps) {
    handle.session.steps.push({
      step,
      timestamp: prior.lastActivityAt,
      ok: true,
      index,
    });
  }
  const now = new Date().toISOString();
  journal.update({
    status: "open",
    pid: process.pid,
    lastActivityAt: now,
    ttlMs: handle.ttlMs,
    closedAt: undefined,
    backend: backend.name,
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.client ? { client: opts.client } : {}),
  });
  journal.append({
    ts: now,
    type: "session.opened",
    sessionId: prior.sessionId,
    kind: "discovery",
    resumed: true,
  });

  try {
    const warnings: string[] = [];
    let setupInfo: DiscoveryOpenInfo["setup"];
    if (prior.setup || prior.resume) {
      const setup = await runSetup(handle, {
        ...opts,
        ...(prior.setup ? { setup: prior.setup } : {}),
        ...(prior.imports ? { imports: prior.imports } : {}),
        ...(prior.resume ? { resume: prior.resume } : {}),
      });
      setupInfo = setup.info;
      warnings.push(...setup.info.warnings);
    }
    const index = ++handle.actionCount;
    const started = Date.now();
    let error: string | undefined;
    let outcome: RunStepsOutcome | undefined;
    if (steps.length > 0) {
      try {
        outcome = await runStepsThroughRunner(handle.runner, {
          name: "discovery_replay",
          steps: steps.map(({ step }) => withAutoAssign(step)),
          imports: handle.imports,
          ...(handle.runExtra ? { extra: handle.runExtra } : {}),
          screenshots: screenshotsOn(handle),
        });
        if (!outcome.ok) error = outcome.error ?? "replay failed";
        else keepCaptures(handle, outcome);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    const url = await backend.getUrl().catch(() => "about:blank");
    handle.session.currentUrl = url;
    const screenshot = lastScreenshot(handle, index, outcome);
    harvestNetwork(handle, index, outcome);
    if (!error) await outcome?.dispose();
    journal.append({
      ts: new Date().toISOString(),
      type: "action.performed",
      index,
      action: "replay",
      ok: error === undefined,
      ...(error ? { error: handle.redactor.text(error) } : {}),
      urlBefore: "about:blank",
      urlAfter: journalUrl(handle, url),
      durationMs: Date.now() - started,
      ...(screenshot ? { screenshot } : {}),
    });
    warnings.push(...screenshotWarnings(handle, index));
    if (error) {
      throw new Error(
        `discovery resume: replay failed: ${publicText(handle, error)}${
          outcome && handle.journal ? ` (replay run: ${outcome.runDir})` : ""
        }`,
      );
    }
    const view = await capture(handle, opts.snapshotMode, opts.maxBytes);
    touchJournal(handle, url);
    writeDraft(handle);
    handle.opened = {
      ...(setupInfo ? { setup: setupInfo } : {}),
      snapshot: view.snapshot,
      snapshotInfo: view.info,
      ...(screenshot ? { screenshot } : {}),
      warnings,
    };
    return handle;
  } catch (error) {
    endJournal(handle, "closed", "close", (error as Error).message);
    disposeWorkDir(handle);
    throw error;
  }
}

/** Every journaled network entry (network/NNN.json), in action order. */
export function loadNetwork(dir: string): DiscoveryNetworkEntry[] {
  const out: DiscoveryNetworkEntry[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(join(dir, "network")).filter((file) =>
      /^\d+\.json$/.test(file),
    );
  } catch {
    return out;
  }
  for (const file of files.toSorted()) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dir, "network", file), "utf8"),
      ) as unknown;
      if (Array.isArray(parsed))
        out.push(...(parsed as DiscoveryNetworkEntry[]));
    } catch {
      // Skip an unreadable file.
    }
  }
  return out;
}

/* ----- export sources ----- */

/** Setup export of a journal (re-resolved: a fromSpec reads its source). */
export async function setupExportOf(
  session: SessionJournalFile,
  opts: { configDir: string; config?: unknown; cwd?: string },
): Promise<SetupExport | undefined> {
  if (!session.setup) {
    return session.resume
      ? { steps: [], imports: [], resume: session.resume }
      : undefined;
  }
  if (Array.isArray(session.setup)) {
    return {
      steps: useSteps(session.setup),
      imports: session.imports ?? [],
      ...(session.resume ? { resume: session.resume } : {}),
    };
  }
  const resolved = await resolveSetup(session.setup, {
    configDir: opts.configDir,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(session.resume ? { resume: session.resume } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  return resolved.exported;
}
