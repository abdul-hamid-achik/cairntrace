import { basename, relative } from "node:path";
import type { BrowserBackend } from "../../adapters/browserBackend";
import {
  generateInvocationId,
  InvocationJournal,
} from "../../core/artifacts/invocationJournal";
import {
  createLiveArtifactRedactor,
  registerSecretValues,
} from "../../core/artifacts/redaction";
import { recordSeedRun } from "../../core/fixtures/ledger";
import { FixtureHost } from "../../core/fixtures/runtime";
import { cairnContextEnv } from "../../core/processEnv";
import { runPool } from "../../core/runner/pool";
import {
  generateRunToken,
  runSpec,
  type ProgressListener,
} from "../../core/runner/Runner";
import {
  ServicesCancelledError,
  type ServicesHandle,
} from "../../core/runner/services";
import type { WebServerHandle } from "../../core/runner/webServer";
import type { BrowserConfig } from "../../core/schema/config.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type { BatchRunResult } from "../../core/schema/runBatch.v1";
import type {
  RunInvocationKind,
  RunInvocationOptions,
  RunInvocationOrigin,
} from "../../core/schema/runInvocation.v1";
import type { SelectionResult } from "../../core/schema/selection.v1";
import type { ExitCode } from "../../core/schema/shared";
import { parseLabelFlags } from "../../core/stats/runStats";
import { writeAbortedBatchSummary } from "../abortedBatch";
import { createBackend } from "../backendFactory";
import { defaultCodemapDeps } from "../commands/annotate";
import {
  describeIteration,
  iterationLabels,
  parseMatrix,
  parseRepeat,
  planIterations,
  type RunIteration,
} from "../commands/runMatrix";
import type { ScopedSecrets } from "../commands/secrets";
import { completionMark } from "../progress";
import type { LoggingConfig } from "../logger";
import {
  formatMs,
  type HookContext,
  type HookObserver,
  resolveHookContext,
  runAfterHooksForResult,
  runHookCommands,
} from "./hooks";
import {
  buildInvocationSummary,
  type IterationSummary,
  mergeExitCodes,
  planInvocationRuns,
  renderIterationSummary,
  withIterationEnv,
} from "./iterations";
import {
  assertServicesBootAllowed,
  collectSpecRedaction,
  configErrorExitCode,
  environmentLockKey,
  maybeInjectTvaultSecrets,
  maybeStartWebServer,
  plansWebServer,
  preflightEnvironments,
  renderServicesDryRunPlan,
  resolveBatchArtifactRoot,
  resolveBrowserConfig,
  resolveInvocationContext,
  resolveLockContext,
  resolveServicesPlan,
  type ServicesNarration,
  startServicesPlan,
} from "./lifecycle";
import {
  backendOpts,
  parseHookTimeoutMs,
  parseVarFlags,
  runOptionsToArgv,
} from "./options";
import {
  makeArchiveRun,
  publishRun,
  runPostRunIntegrations,
  stampIfGreen,
  writeJUnitIfRequested,
} from "./postRun";
import {
  describeRefusal,
  evaluateSpecPolicies,
  noSecretsScope,
  type RefusedSpec,
  synthesizeRefusedResult,
} from "./policy";
import {
  adoptStartedRun,
  synthesizeCancelledResult,
  synthesizeErroredResult,
  synthesizeInvocationErroredResult,
} from "./results";
import {
  buildSelectionResult,
  DRAFT_SKIP_REASON,
  expandSpecArgsWithDrafts,
  normalizeTagFilters,
  selectSpecsByBlastRadius,
  selectSpecsByTags,
  summarizeStartingSpecs,
} from "./selection";

/**
 * The run engine shared by `cairn run` (CLI adapter) and MCP `cairn_run`:
 * spec expansion and selection, repeat/matrix planning, environment
 * preflight, scoped secrets, services + webServer lifecycle, before/after
 * hooks, the worker pool (one browser session per spec, unique per
 * invocation), post-run integrations, retention archive/publish adapters,
 * stamp-if-green, JUnit and the invocation journal.
 *
 * It owns no process: no process.exit/exitCode, no stdout writes, no
 * process.env mutation and no signal handlers. Presentation goes through
 * {@link RunNarration}; documents go to `onDocument` and the result;
 * cancellation comes in through `signal` (graceful teardown) and the
 * synchronous {@link RunInvocationHandle.terminateSync} emergency hook the
 * CLI calls from its signal handler.
 */

/** The leveled logger the engine narrates through (the CLI's `log`). */
export interface RunLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  raw(chunk: string): void;
  scope(name: string): RunLogger;
}

export interface RunInvocationRequest {
  /** Spec paths, directories (expanded recursively) or both. */
  specs: string[];
  options: RunInvocationOptions;
  /** Base for relative paths (default: process.cwd()). */
  cwd?: string;
  /** Command line recorded in invocation.json (default: rebuilt from options). */
  argv?: readonly string[];
  /**
   * Caller environment the environment policy reads `requires.env` opt-in
   * variables from (default: process.env, read only).
   */
  callerEnv?: Record<string, string | undefined>;
}

/** One spec run as the narration and progress listeners see it. */
export interface SpecRunContext {
  /** `single`: one spec at parallel 1; `batch`: one spec of a batch. */
  mode: "single" | "batch";
  specPath: string;
  /** 0-based position in the iteration's spec list. */
  idx: number;
  total: number;
  parallel: number;
  /** 1-based iteration (always 1 without repeat/matrix). */
  iteration: number;
  /** 1-based position in the whole invocation plan. */
  planIndex: number;
  plannedTotal: number;
}

/**
 * Presentation hooks. Every hook is optional; without them the engine
 * narrates through its logger only (what MCP gets).
 */
export interface RunNarration {
  /** Batch-level narration (`noteInfo`/`noteWarn`). */
  note?(kind: "info" | "warn", message: string): void;
  /** The per-spec renderer (tty spinner, plain lines, NDJSON narration). */
  specListener?(ctx: SpecRunContext): ProgressListener | undefined;
  /** Specs are about to run (single or batch). */
  specsStart?(ctx: {
    mode: "single" | "batch";
    total: number;
    parallel: number;
  }): void;
  specStart?(ctx: SpecRunContext): void;
  /** `result` for a run that settled; `error` when runSpec threw. */
  specFinish?(
    ctx: SpecRunContext & { result?: RunResult; error?: string },
  ): void;
  batchEnd?(summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    /** Specs the environment policy refused (present when > 0). */
    refused?: number;
    durationMs: number;
  }): void;
  /** A single-spec run errored before producing a result. */
  singleErrored?(): void;
  /** tty narration for post-run stash lines (undefined = stash logger). */
  postRun?: (message: string, kind: "info" | "warn") => void;
  /** Services narration sinks; called right before services start. */
  services?(): ServicesNarration | undefined;
  /** `--services-dry-run` is about to resolve its plan. */
  servicesDryRunStarting?(): void;
  /** The `--services-dry-run` plan text. */
  servicesPlan?(text: string): void;
  /** The config `logging` block (CLI applies it as a project default). */
  loggingConfig?(config: LoggingConfig | undefined): void;
  /** `--repeat`/`--matrix` end-of-run summary rows. */
  iterationsSummary?(rows: IterationSummary[], planned: number): void;
  /** Signal-time partial batch summary outcome (synchronous). */
  abortedBatchSummary?(outcome: { path: string } | { error: string }): void;
}

/** A per-iteration result document (what `cairn run --format json` prints). */
export type RunDocument = RunResult | BatchRunResult;

export interface RunDocumentMeta {
  /** `preflight`: errored documents of an invocation stopped before any spec. */
  kind: "single" | "batch" | "preflight";
  iteration: number;
  /** A synthesized errored result (single-spec crash / preflight). */
  errored?: boolean;
}

export interface RunInvocationIO {
  origin: RunInvocationOrigin;
  /** MCP client (`name/version`), stamped into invocation.json. */
  client?: string;
  /** Root logger; the engine derives `run`, `web-server`, `services` scopes. */
  logger?: RunLogger;
  narration?: RunNarration;
  /** Extra listener per spec run (MCP progress notifications). */
  progressListener?: (ctx: SpecRunContext) => ProgressListener | undefined;
  /** Graceful cancellation: kill browsers, skip what is left, tear down. */
  signal?: AbortSignal;
  /**
   * false: an invocation whose plan would start config services (and run
   * their teardown) fails with exit 4 before anything starts — an MCP server
   * started without `--allow-services`. `noServices`, `reuseServices` and
   * `servicesDryRun` still work. Default (undefined): allowed (the CLI).
   */
  allowServicesBoot?: boolean;
  /**
   * Each iteration's document, in order, at the moment `cairn run` prints
   * it (before services teardown). Awaited, so a slow consumer (a piped
   * stdout) holds the engine exactly like the CLI drain did.
   */
  onDocument?: (
    document: RunDocument,
    meta: RunDocumentMeta,
  ) => void | Promise<void>;
  /**
   * Serialize invocations that boot the same services/webServer
   * environment (config + env). Resolves with a release function.
   */
  environmentLock?: (
    key: string,
    options: {
      signal?: AbortSignal;
      /** Called once when another invocation holds the key. */
      onWait?: (holder: string | undefined) => void;
    },
  ) => Promise<() => void>;
}

/** `--since-codemap` matched no spec: nothing ran. */
export interface SkippedRunDocument {
  status: "skipped";
  reason: "not_in_blast_radius";
  since: string;
  specs: string[];
}

/** `--services-dry-run` result. */
export interface ServicesPlanDocument {
  servicesDryRun: true;
  /** Redacted plan lines (empty when no services block applies). */
  plan: string[];
}

export interface RunInvocationResult {
  invocationId: string;
  kind: RunInvocationKind;
  /**
   * `single` → RunResult, `batch` → BatchRunResult (aggregated over every
   * iteration for repeat/matrix), `selection` → SelectionResult, `skipped`,
   * `services-dry-run`, and for `errored` the errored document when one
   * exists (unknown --env).
   */
  document?:
    | RunResult
    | BatchRunResult
    | SelectionResult
    | SkippedRunDocument
    | ServicesPlanDocument;
  /** Per-iteration documents in order (what the CLI printed). */
  documents: RunDocument[];
  exitCode: ExitCode;
  /** Invocation-level failure (errored kind). */
  error?: string;
  /**
   * True when `error` stopped the invocation before or around its specs
   * (bad flags, unknown env, secrets, services/webServer boot, a fatal
   * --before hook). The CLI reports it as a fatal error; a crashed iteration
   * (already narrated as a warning) leaves it unset.
   */
  fatal?: boolean;
  /** True when the invocation was cancelled. */
  aborted?: boolean;
  /** Run directories of every spec run that started. */
  runDirs: string[];
  /** Absolute journal directory, when a journal was written. */
  journalDir?: string;
  artifactRoot?: string;
}

export interface RunInvocationHandle {
  readonly invocationId: string;
  readonly result: Promise<RunInvocationResult>;
  /**
   * Resolves once the invocation journal exists (or the invocation settled
   * before writing one): the point a background caller can hand back ids.
   */
  readonly started: Promise<{ journalDir?: string; artifactRoot?: string }>;
  /**
   * Signal-path emergency hook, fully synchronous: mark the journal aborted,
   * capture signal-time services artifacts, write the aborted batch summary,
   * then kill browser daemons, the webServer and services.
   */
  terminateSync(signal: "SIGINT" | "SIGTERM"): void;
}

type SignalName = "SIGINT" | "SIGTERM";
type AbortReporter = (signal: SignalName) => void;

/** Per-invocation registry of the resources the signal path must kill. */
class ResourceScope {
  private readonly backends = new Set<BrowserBackend>();
  private readonly servers = new Set<{ terminateSync(): void }>();
  private readonly services = new Set<{ terminateSync(): void }>();
  private readonly reporters = new Set<AbortReporter>();

  trackBackend(backend: BrowserBackend): () => void {
    this.backends.add(backend);
    return () => {
      this.backends.delete(backend);
    };
  }

  trackServer(handle: { terminateSync(): void }): () => void {
    this.servers.add(handle);
    return () => {
      this.servers.delete(handle);
    };
  }

  trackServices(handle: { terminateSync(): void }): () => void {
    this.services.add(handle);
    return () => {
      this.services.delete(handle);
    };
  }

  trackReporter(reporter: AbortReporter): () => void {
    this.reporters.add(reporter);
    return () => {
      this.reporters.delete(reporter);
    };
  }

  /** Kill every live browser session (daemon + Chrome) synchronously. */
  killBackendsSync(): void {
    for (const backend of this.backends) {
      try {
        if (backend.terminateSync) backend.terminateSync();
        else void backend.close().catch(() => undefined);
      } catch {
        // Cleanup must never block the exit path.
      }
    }
    this.backends.clear();
  }

  /** Reporters once, then backends, the webServer and services. */
  terminateSync(signal: SignalName): void {
    // Clear first so re-entry cannot write duplicate summaries.
    const reporters = [...this.reporters];
    this.reporters.clear();
    for (const reporter of reporters) {
      try {
        reporter(signal);
      } catch {
        // A partial-summary failure must not prevent browser/service cleanup.
      }
    }
    this.killBackendsSync();
    for (const set of [this.servers, this.services]) {
      for (const handle of set) {
        try {
          handle.terminateSync();
        } catch {
          // Cleanup must never block the exit path.
        }
      }
      set.clear();
    }
  }
}

/** Backend calls that a cancelled invocation refuses (a dead browser). */
const CANCELLABLE_BACKEND_METHODS = new Set([
  "runStep",
  "runStepWithNetworkPostcondition",
  "snapshot",
  "screenshot",
  "getUrl",
  "getTitle",
  "getText",
  "getCount",
  "getValue",
  "waitForTimeout",
  "getNetworkRequests",
  "clearNetworkLog",
  "getConsole",
  "clearConsole",
  "getErrors",
  "setViewport",
  "request",
  "evaluate",
  "saveState",
  "loadState",
  "clearBrowserState",
  "startTrace",
  "stopTrace",
  "startVideo",
  "stopVideo",
]);

const CANCELLED_MESSAGE = "cairn: invocation cancelled";

/** A graceful cancel that landed before the first spec ran. */
const CANCELLED_BEFORE_SPECS = "invocation cancelled before its specs ran";

/**
 * Wrap a backend so that once `signal` aborts every browser call rejects
 * immediately (and the backend reports itself wedged so optional captures
 * are skipped): the in-flight runSpec winds down to a written, errored run
 * instead of relaunching a browser that was just killed.
 */
function cancellableBackend(
  backend: BrowserBackend,
  signal: AbortSignal,
): BrowserBackend {
  return new Proxy(backend, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function" || prop === "constructor") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === "isWedged") {
        return () => signal.aborted || Boolean(fn.call(target));
      }
      if (typeof prop === "string" && CANCELLABLE_BACKEND_METHODS.has(prop)) {
        return (...args: unknown[]) =>
          signal.aborted
            ? Promise.reject(new Error(CANCELLED_MESSAGE))
            : fn.apply(target, args);
      }
      return fn.bind(target);
    },
  });
}

/** Call every listener's hook in order (undefined when none is set). */
function combineListeners(
  ...listeners: Array<ProgressListener | undefined>
): ProgressListener | undefined {
  const present = listeners.filter(
    (listener): listener is ProgressListener => listener !== undefined,
  );
  if (present.length <= 1) return present[0];
  const keys = new Set(
    present.flatMap((listener) => Object.keys(listener)),
  ) as Set<keyof ProgressListener>;
  const combined: Record<string, (...args: unknown[]) => void> = {};
  for (const key of keys) {
    combined[key] = (...args: unknown[]) => {
      for (const listener of present) {
        const hook = listener[key] as
          | ((...hookArgs: unknown[]) => void)
          | undefined;
        hook?.apply(listener, args);
      }
    };
  }
  return combined as ProgressListener;
}

/** Preserve the UI listener while observing the durable run directory. */
function withRunStartHook(
  listener: ProgressListener | undefined,
  hook: (runDir: string, runId: string) => void,
): ProgressListener {
  return {
    ...listener,
    onRunStart(spec, runId, runDir, backendName, environment) {
      hook(runDir, runId);
      listener?.onRunStart?.(spec, runId, runDir, backendName, environment);
    },
  };
}

/** What a spec run needs to journal one iteration's spec runs. */
interface InvocationRunContext {
  journal: InvocationJournal;
  /** 1-based iteration (always 1 without --repeat/--matrix). */
  iteration: number;
  specsPerIteration: number;
  multiRun: boolean;
}

/** 1-based plan index of spec `specIndex` (0-based) in this iteration. */
function planIndexOf(
  iteration: number,
  specsPerIteration: number,
  specIndex: number,
): number {
  return (iteration - 1) * specsPerIteration + specIndex + 1;
}

/** Journal: planned run `index` is about to start. */
function journalRunStarting(
  ctx: InvocationRunContext,
  index: number,
  specPath: string,
): void {
  const position = `${index}/${ctx.journal.plannedTotal}`;
  ctx.journal.runStarting(index, specPath);
  void ctx.journal.tracker.enter("steps", {
    item: `spec ${position} ${basename(specPath)}`,
  });
  ctx.journal.narrate(`[${position}] ${specPath} — starting…`);
}

/** Journal: planned run `index` settled with `result`. */
function journalRunFinished(
  ctx: InvocationRunContext,
  index: number,
  specPath: string,
  result: Pick<
    RunResult,
    "runId" | "runDir" | "status" | "durationMs" | "synthetic"
  > & {
    outcomes?: RunResult["outcomes"];
  },
  error?: string,
): void {
  // A refused spec never started: it has no run entry (see run.refused).
  if (result.status === "refused") return;
  ctx.journal.runFinished({
    index,
    spec: specPath,
    runId: result.runId,
    runDir: result.runDir,
    status: result.status,
    ...(result.synthetic ? { synthetic: true as const } : {}),
  });
  const outcomes = result.outcomes ?? [];
  const passed = outcomes.filter((o) => o.status === "passed").length;
  ctx.journal.narrate(
    `${completionMark(result.status, false)} [${index}/${ctx.journal.plannedTotal}] ${basename(specPath)} ${result.status} (${formatMs(result.durationMs)}, ${passed}/${outcomes.length} outcomes)${
      result.synthetic ? " (no run directory)" : ` ${result.runDir}`
    }${error ? `: ${error}` : ""}`,
  );
}

/**
 * Journal: planned run `index` was refused by the environment policy (the
 * preflight, or runSpec's own guard): a `run.refused` event, no run entry.
 */
function journalRefused(
  journal: InvocationJournal,
  refused: Pick<RefusedSpec, "specName" | "specPath" | "refusal">,
  index: number,
): void {
  if (index > 0) journal.runRefused(index);
  journal.appendEvent({
    ts: new Date().toISOString(),
    type: "run.refused",
    spec: refused.specName,
    reason: refused.refusal.reason,
    env: refused.refusal.env,
    ...(refused.refusal.code ? { code: refused.refusal.code } : {}),
    ...(index > 0 ? { index } : {}),
    path: refused.specPath,
  });
  journal.narrate(
    `${completionMark("refused", false)} [${index || 1}/${journal.plannedTotal}] ${basename(refused.specPath)} ${describeRefusal(refused)}`,
  );
}

/**
 * The refusal of a result that runSpec's own policy guard produced (the
 * preflight could not evaluate the spec), for its `run.refused` event.
 */
function refusalOf(
  result: RunResult,
  specPath: string,
): Pick<RefusedSpec, "specName" | "specPath" | "refusal"> | undefined {
  return result.status === "refused" && result.refusal
    ? { specName: result.spec.name, specPath, refusal: result.refusal }
    : undefined;
}

/** Hook observer for one run's `--after` hooks, when journaled. */
function afterHookObserver(
  ctx: InvocationRunContext | undefined,
  runId: string,
): HookObserver | undefined {
  if (!ctx) return undefined;
  return {
    journal: ctx.journal,
    runId,
    ...(ctx.multiRun ? { iteration: ctx.iteration } : {}),
  };
}

/** Options for one iteration (labels + auto-prune floor for repeat/matrix). */
interface IterationOptions {
  opts: RunInvocationOptions;
  minKeepRuns?: number;
}

/** Shared per-iteration inputs of a spec run. */
interface IterationInputs {
  iteration: IterationOptions;
  index: number;
  services?: ServicesHandle;
  browser?: BrowserConfig;
  scopedSecrets: ScopedSecrets;
  sink: RunResult[];
  hookContext: HookContext;
  invocation?: InvocationRunContext;
  hookTimeoutMs: number;
  /** Specs the environment policy refused, by expanded spec path. */
  refusals: ReadonlyMap<string, RefusedSpec>;
  /** F3b: suite/seed fixtures shared by every run of the invocation. */
  fixtureHost?: FixtureHost;
}

interface IterationOutcome {
  exitCode: ExitCode;
  document?: RunDocument;
}

/**
 * Start one run invocation. Returns immediately; `result` settles when the
 * invocation (and its teardown) finished.
 */
export function startRunInvocation(
  request: RunInvocationRequest,
  io: RunInvocationIO,
): RunInvocationHandle {
  return new RunInvocation(request, io).handle;
}

/** Run one invocation to completion. */
export function executeRunInvocation(
  request: RunInvocationRequest,
  io: RunInvocationIO,
): Promise<RunInvocationResult> {
  return startRunInvocation(request, io).result;
}

class RunInvocation {
  readonly id: string;
  readonly handle: RunInvocationHandle;
  private readonly cwd: string;
  private readonly opts: RunInvocationOptions;
  private readonly logger: RunLogger;
  private readonly runLog: RunLogger;
  private readonly narration: RunNarration;
  private readonly resources = new ResourceScope();
  private readonly runDirs: string[] = [];
  private readonly archiveRun: ReturnType<typeof makeArchiveRun>;
  private readonly sessionRoot: string;
  /** Mirrors the journal for narration until it settles. */
  private activeJournal: InvocationJournal | undefined;
  private journal: InvocationJournal | undefined;
  private artifactRoot: string | undefined;
  private aborted = false;
  private terminated = false;
  /**
   * Fires on a graceful cancel only (never on the CLI's terminateSync signal
   * path, which exits right after): kills running hooks and a booting
   * webServer.
   */
  private readonly cancelController = new AbortController();
  /** Post-run failures (stamp-if-green, JUnit) reported as `error`. */
  private readonly postRunErrors: string[] = [];
  private readonly postRunLog = {
    warn: (message: string): void => {
      this.postRunErrors.push(message);
      this.runLog.warn(message);
    },
  };
  private markStarted!: (value: {
    journalDir?: string;
    artifactRoot?: string;
  }) => void;

  constructor(
    private readonly request: RunInvocationRequest,
    private readonly io: RunInvocationIO,
  ) {
    this.id = generateInvocationId();
    this.cwd = request.cwd ?? process.cwd();
    this.opts = request.options;
    this.logger = io.logger ?? silentLogger;
    this.runLog = this.logger.scope("run");
    this.narration = io.narration ?? {};
    this.archiveRun = makeArchiveRun((message) => this.note("warn", message));
    // agent-browser session names: the CLI keeps `cairntrace-<pid>` (one run
    // command per process); every other origin adds the invocation's random
    // suffix so concurrent invocations in one server never share a daemon.
    this.sessionRoot =
      io.origin === "cli"
        ? `cairntrace-${process.pid}`
        : `cairntrace-${io.origin}-${process.pid}-${this.id.slice(-6)}`;
    const started = new Promise<{
      journalDir?: string;
      artifactRoot?: string;
    }>((resolveStarted) => {
      this.markStarted = resolveStarted;
    });
    const onAbort = (): void => this.abortGracefully();
    if (io.signal?.aborted) this.aborted = true;
    else io.signal?.addEventListener("abort", onAbort, { once: true });
    const result = this.run().finally(() => {
      io.signal?.removeEventListener("abort", onAbort);
      this.markStarted({
        ...(this.journal ? { journalDir: this.journal.dir } : {}),
        ...(this.artifactRoot ? { artifactRoot: this.artifactRoot } : {}),
      });
    });
    this.handle = {
      invocationId: this.id,
      result,
      started,
      terminateSync: (signal) => this.terminateSync(signal),
    };
  }

  /* ----- narration ----- */

  /** Batch-level narration: the journal's narration.log + the UI/logger. */
  private note(kind: "info" | "warn", message: string): void {
    this.activeJournal?.narrate(
      kind === "warn" ? `warning: ${message}` : message,
    );
    if (this.narration.note) this.narration.note(kind, message);
    else if (kind === "warn") this.runLog.warn(message);
    else this.runLog.info(message);
  }

  /* ----- cancellation ----- */

  private abortGracefully(): void {
    if (this.aborted || this.terminated) return;
    this.aborted = true;
    this.note(
      "warn",
      "cancel requested: stopping browser sessions and skipping the remaining specs",
    );
    // In-flight browser calls fail fast through cancellableBackend; killing
    // the daemons unblocks a call that is already waiting on one.
    this.resources.killBackendsSync();
    // Running hooks and a booting webServer are killed by their listeners.
    this.cancelController.abort();
  }

  private terminateSync(signal: SignalName): void {
    if (this.terminated) return;
    this.terminated = true;
    this.aborted = true;
    this.resources.terminateSync(signal);
  }

  /** A backend for one spec run, tracked for the signal path. */
  private createTrackedBackend(options: Parameters<typeof createBackend>[0]): {
    backend: BrowserBackend;
    untrack: () => void;
    real: BrowserBackend;
  } {
    const real = createBackend(options);
    const untrack = this.resources.trackBackend(real);
    const backend = this.io.signal
      ? cancellableBackend(real, this.io.signal)
      : real;
    return { backend, untrack, real };
  }

  /* ----- results ----- */

  private base(): Pick<
    RunInvocationResult,
    "invocationId" | "runDirs" | "journalDir" | "artifactRoot" | "aborted"
  > {
    return {
      invocationId: this.id,
      runDirs: [...this.runDirs],
      ...(this.journal ? { journalDir: this.journal.dir } : {}),
      ...(this.artifactRoot ? { artifactRoot: this.artifactRoot } : {}),
      ...(this.aborted ? { aborted: true } : {}),
    };
  }

  /**
   * An invocation-level failure: narrate it into the journal and settle the
   * journal (still open only before specs ran), then report it.
   */
  private fail(
    message: string,
    code: ExitCode,
    extra: { document?: RunDocument; documents?: RunDocument[] } = {},
  ): RunInvocationResult {
    const journal = this.activeJournal;
    if (journal) {
      journal.narrate(`error: ${message}`);
      journal.finish(this.aborted ? "aborted" : "errored", {
        total: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        durationMs: Math.max(
          0,
          Date.now() - Date.parse(journal.snapshot.startedAt),
        ),
        exitCode: code,
        error: message,
      });
      this.activeJournal = undefined;
    }
    return {
      ...this.base(),
      kind: "errored",
      error: message,
      fatal: true,
      exitCode: code,
      documents: extra.documents ?? [],
      ...(extra.document ? { document: extra.document } : {}),
    };
  }

  /**
   * The services/webServer lifecycle stopped the invocation before any spec
   * started: a `cairn services up` lock refusal (exit 4) or a services or
   * webServer boot failure (exit 2). Like an unknown --env, structured
   * consumers still get a schema-valid errored document (and JUnit when
   * requested): one errored result per spec that would have run, the
   * policy's refused result for the others, a batch for several. The
   * document carries the redacted message (a boot error quotes log tails).
   */
  private async lifecycleFailure(
    message: string,
    code: ExitCode,
    ctx: {
      specs: readonly string[];
      refusals: ReadonlyMap<string, RefusedSpec>;
      parallel: number;
      environment?: string;
      redactor: { text: (input: string) => string };
    },
  ): Promise<RunInvocationResult> {
    const labels = parseLabelFlags(this.opts.label);
    const backend = this.opts.mock
      ? "mock"
      : (this.opts.backend ?? "agent-browser");
    const redacted = ctx.redactor.text(message);
    const results = ctx.specs.map((specPath) => {
      const refused = ctx.refusals.get(specPath);
      return refused
        ? synthesizeRefusedResult(refused, { labels, backend }, this.cwd)
        : synthesizeInvocationErroredResult(
            specPath,
            redacted,
            code,
            {
              labels,
              backend,
              ...(ctx.environment ? { environment: ctx.environment } : {}),
            },
            this.cwd,
          );
    });
    await writeJUnitIfRequested(this.opts, results, this.runLog, this.cwd);
    const document: RunDocument =
      results.length === 1
        ? results[0]!
        : {
            $schema: "urn:cairntrace.dev:run-batch:v1",
            version: "1",
            parallel: ctx.parallel,
            totalDurationMs: 0,
            summary: batchSummary(results),
            results,
            exitCode: code,
          };
    await this.io.onDocument?.(document, {
      kind: "preflight",
      iteration: 1,
      errored: true,
    });
    // CLI stderr keeps the raw boot error for the operator; an MCP result's
    // error is agent-facing text (cairn_run puts it ahead of the summary),
    // so it gets the same redaction as the document.
    return this.fail(this.io.origin === "cli" ? message : redacted, code, {
      document,
    });
  }

  /* ----- the invocation ----- */

  private async run(): Promise<RunInvocationResult> {
    const { opts, cwd } = this;
    const specs = this.request.specs;
    const parallel = Math.max(1, opts.parallel ?? 1);
    let hookTimeoutMs: number;
    try {
      hookTimeoutMs = parseHookTimeoutMs(
        opts.hookTimeoutMs === undefined
          ? undefined
          : String(opts.hookTimeoutMs),
      );
    } catch (e) {
      return this.fail((e as Error).message, 2);
    }

    let expandedSpecs: string[];
    let skippedDrafts: string[];
    try {
      const expanded = await expandSpecArgsWithDrafts(specs, cwd);
      expandedSpecs = expanded.specs;
      skippedDrafts = expanded.drafts;
    } catch (e) {
      return this.fail((e as Error).message, 2);
    }
    if (skippedDrafts.length > 0) {
      // `_` folders and files under a directory argument are drafts: say
      // so, so a suite never loses specs silently.
      this.note(
        "info",
        `skipped ${skippedDrafts.length} draft path(s) starting with _ (name one to run it): ${skippedDrafts
          .map((p) => relative(cwd, p) || p)
          .join(", ")}`,
      );
    }
    if (
      expandedSpecs.length === 0 &&
      !(opts.selectOnly && skippedDrafts.length > 0)
    ) {
      return this.fail(
        skippedDrafts.length > 0
          ? `no specs to run: everything under ${specs.join(", ")} is a draft (a _ folder or file); name one to run it`
          : "at least one spec path is required",
        2,
      );
    }

    const requiredTags = normalizeTagFilters(opts.tag);

    let iterations: RunIteration[];
    try {
      parseVarFlags(opts.var);
      parseLabelFlags(opts.label);
      iterations = planIterations(
        opts.repeat === undefined
          ? undefined
          : parseRepeat(String(opts.repeat)),
        parseMatrix(opts.matrix),
      );
    } catch (e) {
      return this.fail((e as Error).message, 2);
    }
    const multiRun = opts.repeat !== undefined || opts.matrix !== undefined;

    // `--select-only`: resolve which specs WOULD run WITHOUT launching a
    // browser, services, or webServer. Emits SelectionResult v1. Applies
    // `--tag` and/or `--since-codemap` filters with skip reasons.
    if (opts.selectOnly) {
      const built = await buildSelectionResult(
        expandedSpecs,
        opts.sinceCodemap,
        defaultCodemapDeps,
        requiredTags,
        cwd,
      );
      built.skipped.push(
        ...skippedDrafts.map((path) => ({
          name: basename(path).replace(/\.ya?ml$/i, ""),
          path,
          reason: DRAFT_SKIP_REASON,
        })),
      );
      // The environment policy is part of "would it run": a refused spec is
      // listed under `skipped` with its reason, never as selected.
      const selection = await this.withPolicySkips(built);
      return {
        ...this.base(),
        kind: "selection",
        document: selection,
        documents: [],
        exitCode: 0,
      };
    }

    // Tag filter (AND): keep only specs that declare every requested tag in
    // `metadata.tags`. Applied before blast-radius so codemap sees the narrowed set.
    if (requiredTags.length > 0) {
      const tagSel = await selectSpecsByTags(expandedSpecs, requiredTags);
      expandedSpecs = tagSel.selected;
      this.note(
        "info",
        `tag filter [${requiredTags.join(", ")}]: ${expandedSpecs.length} spec(s)`,
      );
      if (expandedSpecs.length === 0) {
        return this.fail(
          `no specs matched --tag ${requiredTags.map((t) => JSON.stringify(t)).join(" --tag ")} ` +
            `(need every tag on metadata.tags; case-insensitive)`,
          2,
        );
      }
    }

    // `--since-codemap <ref>`: narrow to the specs a change can actually hit
    // via `codemap review` blast-radius intersection. Best-effort — degrades
    // to the full set when codemap is absent.
    if (opts.sinceCodemap) {
      const candidates = expandedSpecs;
      expandedSpecs = await selectSpecsByBlastRadius(
        expandedSpecs,
        opts.sinceCodemap,
      );
      if (expandedSpecs.length === 0) {
        this.note(
          "info",
          `--since-codemap ${opts.sinceCodemap} selected 0 specs (blast radius matched no spec's coversSymbol); nothing to run`,
        );
        return {
          ...this.base(),
          kind: "skipped",
          document: {
            status: "skipped",
            reason: "not_in_blast_radius",
            since: opts.sinceCodemap,
            specs: candidates,
          },
          documents: [],
          exitCode: 0,
        };
      }
    }

    // Environment check, once per invocation and before secrets, services,
    // hooks or a browser exist: undefined default environments warn once;
    // an explicit --env the config does not define is a config error
    // (exit 4) with a schema-valid errored document.
    const envError = await preflightEnvironments(expandedSpecs, opts, (m) =>
      this.note("warn", m),
    );
    if (envError) {
      const labels = parseLabelFlags(opts.label);
      const results = expandedSpecs.map((specPath) =>
        synthesizeErroredResult(specPath, envError, { labels }, cwd),
      );
      await writeJUnitIfRequested(opts, results, this.runLog, cwd);
      const document: RunDocument =
        results.length === 1
          ? results[0]!
          : {
              $schema: "urn:cairntrace.dev:run-batch:v1",
              version: "1",
              parallel,
              totalDurationMs: 0,
              summary: {
                total: results.length,
                passed: 0,
                failed: 0,
                errored: results.length,
              },
              results,
              exitCode: envError.exitCode,
            };
      await this.io.onDocument?.(document, {
        kind: "preflight",
        iteration: 1,
        errored: true,
      });
      return this.fail(envError.message, envError.exitCode, { document });
    }

    // Environment policy (requires.env / mutates vs environments.<n>.policy),
    // per spec and before secrets, services, the webServer, hooks,
    // preconditions or a browser exist: a refused spec never starts
    // anything and never gets a run directory.
    const callerEnv =
      this.request.callerEnv ??
      (process.env as Record<string, string | undefined>);
    const refusals = await evaluateSpecPolicies(
      expandedSpecs,
      opts,
      callerEnv,
      cwd,
    );
    const runnable = expandedSpecs.filter((spec) => !refusals.has(spec));
    for (const refused of refusals.values()) {
      this.note(
        "warn",
        `${basename(refused.specPath)} ${describeRefusal(refused)}`,
      );
    }

    // The lifecycle (secrets, services, webServer, browser block, hooks)
    // resolves from the first spec that will actually run.
    const firstSpec = runnable[0] ?? expandedSpecs[0]!;
    let scopedSecrets: ScopedSecrets;
    try {
      scopedSecrets =
        runnable.length > 0
          ? await maybeInjectTvaultSecrets(
              firstSpec,
              opts,
              {
                warn: (m) => this.runLog.warn(m),
                info: (m) => this.note("info", m),
              },
              cwd,
            )
          : noSecretsScope(callerEnv);
    } catch (e) {
      return this.fail((e as Error).message, configErrorExitCode(e));
    }

    // A services dry-run is a planning command, not a spec run with no-op
    // services. Resolve and return the effective lifecycle, then stop before
    // the web server, hooks, browser backend, run directory, or preconditions.
    if (opts.servicesDryRun) {
      this.narration.servicesDryRunStarting?.();
      try {
        const plan = await resolveServicesPlan(
          firstSpec,
          opts,
          scopedSecrets,
          cwd,
        );
        const text = plan
          ? renderServicesDryRunPlan(plan, scopedSecrets)
          : undefined;
        if (text !== undefined) {
          if (this.narration.servicesPlan) this.narration.servicesPlan(text);
          else this.runLog.info(text.trimEnd());
        }
        return {
          ...this.base(),
          kind: "services-dry-run",
          document: {
            servicesDryRun: true,
            plan: text === undefined ? [] : text.trimEnd().split("\n"),
          },
          documents: [],
          exitCode: 0,
        };
      } catch (e) {
        return this.fail((e as Error).message, configErrorExitCode(e));
      }
    }

    // Cancelled while resolving: stop before anything boots.
    if (this.aborted) {
      return this.fail("invocation cancelled before it started", 2);
    }

    // Invocation journal (<artifactRoot>/_invocations/<id>/): the plan, live
    // status, services and hook events + logs, and the final summary.
    // Created before services so their output streams into it while they boot.
    const invocationStartedAtMs = Date.now();
    const invocationContext = await resolveInvocationContext(
      firstSpec,
      opts,
      scopedSecrets,
      cwd,
    );
    this.artifactRoot = invocationContext.artifactRoot;
    // Services output and --before hooks are journaled before any run has
    // registered its spec's redaction block: learn every spec's now.
    const specRedaction = await collectSpecRedaction(
      expandedSpecs,
      scopedSecrets.env,
    );
    registerSecretValues(specRedaction.values ?? []);
    const journal = InvocationJournal.create({
      artifactRoot: invocationContext.artifactRoot,
      argv: this.request.argv ?? runOptionsToArgv(specs, opts),
      cwd,
      origin: this.io.origin,
      ...(this.io.client ? { client: this.io.client } : {}),
      ...(invocationContext.configPath
        ? { configPath: invocationContext.configPath }
        : {}),
      ...(invocationContext.environment
        ? { env: invocationContext.environment }
        : {}),
      labels: parseLabelFlags(opts.label),
      parallel,
      planned: planInvocationRuns(expandedSpecs, iterations, multiRun),
      redactor: createLiveArtifactRedactor(
        specRedaction,
        scopedSecrets.env,
        scopedSecrets.secretValues,
      ),
      invocationId: this.id,
    });
    this.journal = journal;
    this.activeJournal = journal;
    this.markStarted({
      ...(journal ? { journalDir: journal.dir } : {}),
      artifactRoot: invocationContext.artifactRoot,
    });
    // SIGINT/SIGTERM: mark the journal aborted synchronously before exit.
    const untrackJournal = journal
      ? this.resources.trackReporter((signal) => journal.abortSync(signal))
      : undefined;
    journal?.narrate(summarizeStartingSpecs(specs, cwd));

    // Bring up the configured services environment (docker/seed/tmux) FIRST:
    // the webServer is usually an app process that depends on that infra,
    // so starting it before the database exists crashes it on a fresh
    // machine. Starts once before the pool, stops once after.
    let svcHandle: ServicesHandle | undefined;
    let servicesProject: string | undefined;
    let untrackSvc: (() => void) | undefined;
    let releaseEnvironment: (() => void) | undefined;
    // Nothing to run (every spec refused): no services, no webServer.
    const bootsLifecycle = runnable.length > 0;
    try {
      const plan = bootsLifecycle
        ? await resolveServicesPlan(firstSpec, opts, scopedSecrets, cwd)
        : undefined;
      servicesProject = plan?.project;
      assertServicesBootAllowed(plan, this.io.allowServicesBoot);
      if (
        this.io.environmentLock &&
        (plan ||
          (bootsLifecycle && (await plansWebServer(firstSpec, opts, cwd))))
      ) {
        const lockCtx = await resolveLockContext(
          firstSpec,
          opts,
          scopedSecrets,
          cwd,
        );
        releaseEnvironment = await this.io.environmentLock(
          environmentLockKey(lockCtx.configPath, lockCtx.dir),
          {
            ...(this.io.signal ? { signal: this.io.signal } : {}),
            onWait: (holder) =>
              this.note(
                "info",
                `waiting for the services environment of ${lockCtx.configPath ?? lockCtx.dir} (env "${lockCtx.envName}"): invocation ${holder ?? "(unknown)"} is using it`,
              ),
          },
        );
      }
      // Cancelled while resolving or queued: boot nothing.
      if (this.aborted) throw new Error(CANCELLED_BEFORE_SPECS);
      // A cancel that lands mid-boot kills the running docker/seed/readiness
      // command tree, stops tmux readiness waits at their next poll and tears
      // down the phases already started (startServices rejects).
      if (plan) {
        svcHandle = await startServicesPlan(
          plan,
          scopedSecrets,
          (terminateSync) => {
            untrackSvc = this.resources.trackServices({ terminateSync });
          },
          {
            ...(journal ? { journal } : {}),
            ...this.servicesNarration(),
            log: (m) => this.logger.scope("services").info(m),
            logDetail: (m) => this.logger.scope("services").debug(m),
            warn: (m) => this.logger.scope("services").warn(m),
            onOutput: (c) => this.logger.raw(c),
            signal: this.cancelController.signal,
          },
        );
      }
      if (this.aborted) {
        // Booted before the cancel landed: stop it like the normal teardown.
        if (svcHandle) {
          void journal?.tracker.enter("teardown");
          await svcHandle.stop().catch(() => undefined);
        }
        throw new Error(CANCELLED_BEFORE_SPECS);
      }
    } catch (e) {
      untrackSvc?.();
      releaseEnvironment?.();
      untrackJournal?.();
      // A boot the cancel killed reports like any cancel before the specs;
      // other errors (a cancelled lock wait, a boot failure) keep their own.
      if (e instanceof ServicesCancelledError) {
        return this.fail(CANCELLED_BEFORE_SPECS, 2);
      }
      if (this.aborted) {
        return this.fail((e as Error).message, configErrorExitCode(e));
      }
      // A services lock refusal (exit 4) or a boot failure (exit 2).
      return this.lifecycleFailure(
        (e as Error).message,
        configErrorExitCode(e),
        {
          specs: expandedSpecs,
          refusals,
          parallel,
          ...(invocationContext.environment
            ? { environment: invocationContext.environment }
            : {}),
          redactor: createLiveArtifactRedactor(
            specRedaction,
            scopedSecrets.env,
            scopedSecrets.secretValues,
          ),
        },
      );
    }

    // Bring up the configured webServer (if any) once for the whole
    // invocation, before any spec runs. A boot/setup failure is fatal (exit 2).
    let server: WebServerHandle | undefined;
    let untrackServer: (() => void) | undefined;
    // A graceful cancel while the webServer boots kills its process tree, so
    // the readiness wait fails fast instead of running to readyTimeoutMs.
    let killBootingServer: (() => void) | undefined;
    const onCancelDuringBoot = (): void => killBootingServer?.();
    this.cancelController.signal.addEventListener("abort", onCancelDuringBoot, {
      once: true,
    });
    try {
      if (this.aborted) throw new Error(CANCELLED_BEFORE_SPECS);
      server = !bootsLifecycle
        ? undefined
        : await maybeStartWebServer(
            firstSpec,
            opts,
            // Track for signal teardown the instant the server is spawned — before
            // readiness/setup — so a signal during a slow boot can't orphan it.
            (terminateSync) => {
              untrackServer = this.resources.trackServer({ terminateSync });
              killBootingServer = terminateSync;
              if (this.cancelController.signal.aborted) terminateSync();
            },
            {
              ...(this.narration.loggingConfig
                ? {
                    onLoggingConfig: (config: LoggingConfig | undefined) =>
                      this.narration.loggingConfig?.(config),
                  }
                : {}),
              log: (m: string) => this.logger.scope("web-server").info(m),
              warn: (m: string) => this.logger.scope("web-server").warn(m),
              ...(journal ? { journal } : {}),
              signal: this.cancelController.signal,
              cwd,
            },
          );
      if (this.aborted) throw new Error(CANCELLED_BEFORE_SPECS);
    } catch (e) {
      if (server || svcHandle) void journal?.tracker.enter("teardown");
      // Booted before the cancel landed: stop it like the normal teardown.
      if (server) await server.stop().catch(() => undefined);
      untrackServer?.();
      // Tear down the services environment too before reporting.
      if (svcHandle) {
        await svcHandle.stop().catch(() => undefined);
        untrackSvc?.();
      }
      releaseEnvironment?.();
      untrackJournal?.();
      if (this.aborted) return this.fail(CANCELLED_BEFORE_SPECS, 2);
      // A webServer boot/readiness/setup failure (exit 2).
      return this.lifecycleFailure(
        (e as Error).message,
        configErrorExitCode(e),
        {
          specs: expandedSpecs,
          refusals,
          parallel,
          ...(invocationContext.environment
            ? { environment: invocationContext.environment }
            : {}),
          redactor: createLiveArtifactRedactor(
            specRedaction,
            scopedSecrets.env,
            scopedSecrets.secretValues,
          ),
        },
      );
    } finally {
      this.cancelController.signal.removeEventListener(
        "abort",
        onCancelDuringBoot,
      );
      killBootingServer = undefined;
    }

    // Project-level browser tuning (config `browser:` block) applied to every
    // backend this invocation constructs. Resolved once, same scope as
    // webServer/services. Best-effort: no config → adapter defaults.
    const browser = await resolveBrowserConfig(firstSpec, opts, cwd);
    // F3b: suite fixtures are ensured once (by the first run that uses
    // them) and torn down when the invocation ends, before the webServer and
    // services stop; seed fixtures once per services seed. Their events go
    // to the journal as well as to the run that ensured them.
    const fixtureHost = this.createFixtureHost(journal);
    await observeSeed(fixtureHost, svcHandle, servicesProject);
    // Non-secret context (CAIRN_ENV, CAIRN_BASE_URL, CAIRN_CONFIG_DIR) for the
    // --before/--after hooks; per-run ids are layered on per run.
    const hookContext: HookContext =
      (opts.before?.length ?? 0) + (opts.after?.length ?? 0) > 0
        ? await resolveHookContext(firstSpec, opts, scopedSecrets, cwd)
        : {};

    // Resolve one final exit status only after lifecycle teardown.
    let exitCode: ExitCode = 2;
    const summaryRows: IterationSummary[] = [];
    const documents: RunDocument[] = [];
    let crash: string | undefined;
    let beforeHookError: string | undefined;
    try {
      // Services/webServer are shared; each iteration (one pass with a single
      // run when no --repeat/--matrix) re-runs the --before hooks, then the specs.
      for (const it of iterations) {
        if (this.aborted) break;
        const iteration: IterationOptions = multiRun
          ? {
              opts: {
                ...opts,
                label: [...(opts.label ?? []), ...iterationLabels(it)],
              },
              minKeepRuns: iterations.length,
            }
          : { opts };
        const iterSecrets = withIterationEnv(scopedSecrets, it);
        if (multiRun) {
          this.note(
            "info",
            `run ${it.index}/${iterations.length}: ${describeIteration(it)}`,
          );
        }

        // Domain hooks (e.g. tools/flip-path.sh next) run AFTER services+secrets
        // so they can restart tmux panes, and BEFORE each run's first spec.
        // Not when the policy refused every spec: nothing would run after them.
        try {
          await runHookCommands("before", bootsLifecycle ? opts.before : [], {
            env: { ...iterSecrets.childEnv, ...cairnContextEnv(hookContext) },
            selectedTvaultKeys: iterSecrets.selectedKeys ?? [],
            timeoutMs: hookTimeoutMs,
            cwd,
            note: (kind, message) => this.note(kind, message),
            signal: this.cancelController.signal,
            ...(journal
              ? {
                  observer: {
                    journal,
                    ...(multiRun ? { iteration: it.index } : {}),
                  },
                }
              : {}),
          });
        } catch (e) {
          // A cancel killed the hook (or landed while it ran): not a hook
          // failure; nothing of this iteration runs.
          if (this.aborted) break;
          beforeHookError = (e as Error).message;
          summaryRows.push({
            it,
            exitCode: 2,
            results: [],
            note: "before hook",
          });
          exitCode = 2;
          break;
        }
        // Cancelled during the hooks: the specs (preconditions, run dirs)
        // never start.
        if (this.aborted) break;

        const results: RunResult[] = [];
        const inputs: IterationInputs = {
          iteration,
          index: it.index,
          ...(svcHandle ? { services: svcHandle } : {}),
          ...(browser ? { browser } : {}),
          scopedSecrets: iterSecrets,
          sink: results,
          hookContext,
          ...(journal
            ? {
                invocation: {
                  journal,
                  iteration: it.index,
                  specsPerIteration: expandedSpecs.length,
                  multiRun,
                },
              }
            : {}),
          hookTimeoutMs,
          refusals,
          fixtureHost,
        };
        let outcome: IterationOutcome;
        try {
          outcome =
            expandedSpecs.length === 1 && parallel === 1
              ? await this.runSingle(firstSpec, inputs)
              : await this.runBatch(expandedSpecs, parallel, inputs);
        } catch (e) {
          crash = `run ${it.index} crashed: ${(e as Error).message}`;
          this.note("warn", crash);
          outcome = { exitCode: 2 };
        }
        if (outcome.document) documents.push(outcome.document);
        summaryRows.push({ it, exitCode: outcome.exitCode, results });
        exitCode = mergeExitCodes(exitCode, outcome.exitCode, it.index === 1);
        if (
          outcome.exitCode !== 0 &&
          opts.stopOnFail &&
          it.index < iterations.length
        ) {
          this.note(
            "warn",
            `--stop-on-fail: stopping after run ${it.index}/${iterations.length} (exit ${outcome.exitCode})`,
          );
          break;
        }
      }
    } finally {
      if (multiRun && summaryRows.length > 0) {
        if (this.narration.iterationsSummary) {
          this.narration.iterationsSummary(summaryRows, iterations.length);
        } else {
          this.runLog.info(
            renderIterationSummary(summaryRows, iterations.length),
          );
        }
        journal?.narrate(
          renderIterationSummary(summaryRows, iterations.length),
        );
      }
      // F3b: suite fixtures first (they may need the app and its infra).
      if (fixtureHost.pendingTeardowns > 0) {
        await fixtureHost.teardownAll();
      }
      if (server || svcHandle) void journal?.tracker.enter("teardown");
      // Reverse of startup: the app process releases its infra connections
      // before the services environment goes away.
      if (server) {
        if (server.startedByUs && exitCode !== 0) {
          const logTail = server.tailLog(80).trim();
          if (logTail) {
            this.note(
              "info",
              `web server log (last 80 lines${
                server.logPath ? `, full: ${server.logPath}` : ""
              }):\n${logTail}`,
            );
          }
        }
        await server.stop().catch(() => undefined);
        untrackServer?.();
      }
      if (svcHandle) {
        await svcHandle.stop().catch(() => undefined);
        untrackSvc?.();
      }
      releaseEnvironment?.();
    }

    // Persist the batch summary (stdout only had it until now) and settle.
    if (journal) {
      const summary = buildInvocationSummary(summaryRows, {
        exitCode,
        durationMs: Date.now() - invocationStartedAtMs,
        multiRun,
        ...(beforeHookError !== undefined ? { error: beforeHookError } : {}),
      });
      // Exit 7 (every spec refused, or --strict-requires) did not run what
      // was asked: "failed", not an infrastructure error.
      const status = this.aborted
        ? "aborted"
        : exitCode === 0
          ? "passed"
          : exitCode === 1 || exitCode === 7
            ? "failed"
            : "errored";
      journal.narrate(
        `finished: ${status}, ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored${
          summary.refused ? `, ${summary.refused} refused` : ""
        } in ${formatMs(summary.durationMs)} (exit ${exitCode})`,
      );
      journal.finish(status, summary);
    }
    untrackJournal?.();
    this.activeJournal = undefined;

    if (beforeHookError !== undefined) {
      return this.fail(beforeHookError, 2, { documents });
    }

    if (multiRun) {
      const results = summaryRows.flatMap((row) => row.results);
      return {
        ...this.base(),
        ...this.postRunError(),
        kind: "batch",
        document: {
          $schema: "urn:cairntrace.dev:run-batch:v1",
          version: "1",
          parallel,
          totalDurationMs: Math.max(0, Date.now() - invocationStartedAtMs),
          summary: batchSummary(results),
          results,
          exitCode,
        },
        documents,
        exitCode,
      };
    }
    const document = documents[0];
    if (!document) {
      return {
        ...this.base(),
        kind: "errored",
        error:
          crash ??
          (this.aborted
            ? CANCELLED_BEFORE_SPECS
            : "the run produced no result"),
        documents,
        exitCode,
      };
    }
    return {
      ...this.base(),
      ...this.postRunError(),
      kind:
        document.$schema === "urn:cairntrace.dev:run-batch:v1"
          ? "batch"
          : "single",
      document,
      documents,
      exitCode,
    };
  }

  /**
   * `error` for a settled document whose post-run step failed (could not
   * stamp, could not write JUnit): the document alone reads as passed.
   */
  private postRunError(): { error?: string } {
    return this.postRunErrors.length > 0
      ? { error: this.postRunErrors.join("; ") }
      : {};
  }

  /**
   * The `refused` result of a spec the environment policy refused, plus its
   * `run.refused` event and narration line in the invocation journal.
   */
  private refusedResult(
    refused: RefusedSpec,
    inputs: IterationInputs,
    planIndex: number,
  ): RunResult {
    const { opts } = inputs.iteration;
    const result = synthesizeRefusedResult(
      refused,
      {
        labels: parseLabelFlags(opts.label),
        backend: opts.mock ? "mock" : (opts.backend ?? "agent-browser"),
      },
      this.cwd,
    );
    const journal = inputs.invocation?.journal;
    if (journal) journalRefused(journal, refused, planIndex);
    return result;
  }

  /** `--select-only`: move policy-refused specs from `selected` to `skipped`. */
  private async withPolicySkips(
    selection: SelectionResult,
  ): Promise<SelectionResult> {
    const refusals = await evaluateSpecPolicies(
      selection.selected.map((s) => s.path),
      this.opts,
      this.request.callerEnv ??
        (process.env as Record<string, string | undefined>),
      this.cwd,
    );
    if (refusals.size === 0) return selection;
    return {
      ...selection,
      selected: selection.selected.filter((s) => !refusals.has(s.path)),
      skipped: [
        ...selection.skipped,
        ...selection.selected.flatMap((s) => {
          const refused = refusals.get(s.path);
          return refused
            ? [{ name: s.name, path: s.path, reason: describeRefusal(refused) }]
            : [];
        }),
      ],
    };
  }

  /** Services narration sinks from the presentation layer, if any. */
  private servicesNarration(): { narration?: ServicesNarration } {
    const narration = this.narration.services?.();
    return narration ? { narration } : {};
  }

  /** The invocation's suite/seed fixture host (F3b), journaled. */
  private createFixtureHost(
    journal: InvocationJournal | undefined,
  ): FixtureHost {
    return new FixtureHost({
      onEvent: (event) => journal?.appendEvent(event),
      onVerbStart: ({ name, verb, budgetMs }) => {
        void journal?.tracker.enter("teardown", {
          item: `fixture ${verb} ${name}`,
          budgetMs,
        });
      },
      onVerbEnd: ({ name, verb, status, durationMs, error }) => {
        const line = `fixture ${verb} ${name}: ${status} in ${formatMs(durationMs)}${
          error ? ` — ${error}` : ""
        }`;
        journal?.narrate(line);
        if (status === "failed") this.note("warn", line);
      },
    });
  }

  /** runSpec options shared by single and batch runs. */
  private runSpecOptions(
    specPath: string,
    inputs: IterationInputs,
  ): Omit<
    Parameters<typeof runSpec>[0],
    "backend" | "workerIndex" | "runToken" | "listener" | "invocation"
  > {
    const { opts, minKeepRuns } = inputs.iteration;
    const vars = parseVarFlags(opts.var);
    const labels = parseLabelFlags(opts.label);
    const { services, scopedSecrets } = inputs;
    return {
      specPath,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      // --reuse-services: a warm stack, a cold browser (an explicit coldStart wins).
      ...(opts.coldStart !== undefined
        ? { coldStart: opts.coldStart }
        : services?.reusedLock
          ? { coldStart: true }
          : {}),
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(minKeepRuns ? { minKeepRuns } : {}),
      env: scopedSecrets.env,
      childEnv: scopedSecrets.childEnv,
      secretValues: scopedSecrets.secretValues,
      ...(scopedSecrets.selectedKeys
        ? { selectedTvaultKeys: scopedSecrets.selectedKeys }
        : {}),
      ...(services?.events.length ? { servicesEvents: services.events } : {}),
      ...(services
        ? { captureServicesArtifacts: services.captureRunArtifacts }
        : {}),
      ...(opts.monitor ? { monitor: opts.monitor } : {}),
      onArchiveRun: this.archiveRun,
      onPublishRun: publishRun,
      // A graceful cancel kills the running precondition / node transform /
      // script verifier tree and skips the rest of the spec.
      signal: this.cancelController.signal,
      // The same opt-in source the invocation's policy preflight used.
      policyEnv:
        this.request.callerEnv ??
        (process.env as Record<string, string | undefined>),
      ...(opts.allowFixtureWrites ? { allowFixtureWrites: true } : {}),
      ...(inputs.fixtureHost ? { fixtureHost: inputs.fixtureHost } : {}),
    };
  }

  /** Narration + progress listeners for one spec run. */
  private specListener(ctx: SpecRunContext): ProgressListener | undefined {
    return combineListeners(
      this.narration.specListener?.(ctx),
      this.io.progressListener?.(ctx),
      // Authoring warnings (deprecated action paths) reach the narration.
      { onWarning: (message) => this.note("warn", message) },
    );
  }

  /* ----- single-spec path (preserves v0.0 behavior) ----- */

  private async runSingle(
    specPath: string,
    inputs: IterationInputs,
  ): Promise<IterationOutcome> {
    const { opts } = inputs.iteration;
    const { services, invocation, scopedSecrets, sink } = inputs;
    const planIndex = invocation
      ? planIndexOf(invocation.iteration, invocation.specsPerIteration, 0)
      : 0;
    const refused = inputs.refusals.get(specPath);
    if (refused) {
      // Policy refusal: no backend, no run directory, exit 7.
      const result = this.refusedResult(refused, inputs, planIndex);
      sink.push(result);
      if (
        !(await writeJUnitIfRequested(
          opts,
          [result],
          this.postRunLog,
          this.cwd,
        ))
      ) {
        return { exitCode: 2, document: result };
      }
      await this.io.onDocument?.(result, {
        kind: "single",
        iteration: inputs.index,
      });
      return { exitCode: 7, document: result };
    }
    const { backend, untrack } = this.createTrackedBackend({
      ...backendOpts(opts, inputs.browser),
      session: this.sessionRoot,
    });
    const ctx: SpecRunContext = {
      mode: "single",
      specPath,
      idx: 0,
      total: 1,
      parallel: 1,
      iteration: inputs.index,
      planIndex: planIndex || inputs.index,
      plannedTotal: invocation?.journal.plannedTotal ?? 1,
    };
    const listener = this.specListener(ctx);
    // Minted here (not inside runSpec) so --after hooks see the same token.
    const runToken = generateRunToken();
    let activeRunDir: string | undefined;
    let startedRun: { runId: string; runDir: string } | undefined;
    const signalAwareListener =
      services || invocation
        ? withRunStartHook(listener, (runDir, runId) => {
            activeRunDir = runDir;
            startedRun = { runId, runDir };
            invocation?.journal.runStarted(planIndex, specPath, runId, runDir);
          })
        : listener;
    if (invocation) journalRunStarting(invocation, planIndex, specPath);
    const untrackSignalArtifactReporter = services
      ? this.resources.trackReporter((signal) => {
          if (activeRunDir) {
            services.captureSignalArtifactsSync(activeRunDir, signal);
          }
        })
      : undefined;
    this.narration.specsStart?.({ mode: "single", total: 1, parallel: 1 });

    let exitCode: ExitCode = 2;
    try {
      const result = await runSpec({
        ...this.runSpecOptions(specPath, inputs),
        backend,
        workerIndex: 0,
        runToken,
        ...(invocation
          ? { invocation: invocation.journal.ref(planIndex) }
          : {}),
        ...(signalAwareListener ? { listener: signalAwareListener } : {}),
      });
      // runSpec captures the normal success/failure service bundle before it
      // resolves. From here onward the signal-only fallback must not overwrite
      // that finalized evidence pack.
      activeRunDir = undefined;
      exitCode = result.exitCode;
      sink.push(result);
      this.runDirs.push(result.runDir);
      if (invocation)
        journalRunFinished(invocation, planIndex, specPath, result);
      if (!this.aborted) {
        await runAfterHooksForResult(
          result,
          {
            after: opts.after,
            hookTimeoutMs: inputs.hookTimeoutMs,
            signal: this.cancelController.signal,
          },
          scopedSecrets,
          { ...inputs.hookContext, runToken },
          afterHookObserver(invocation, result.runId),
          (kind, message) => this.note(kind, message),
        );
      }
      if (
        !this.aborted &&
        !(await stampIfGreen(opts, [result], this.postRunLog))
      ) {
        return { exitCode: 2, document: result };
      }
      if (
        !(await writeJUnitIfRequested(
          opts,
          [result],
          this.postRunLog,
          this.cwd,
        ))
      ) {
        return { exitCode: 2, document: result };
      }

      if (!this.aborted) {
        await runPostRunIntegrations(result, specPath, opts, {
          log: this.runLog,
          ...(this.narration.postRun
            ? { narrate: this.narration.postRun }
            : {}),
          cwd: this.cwd,
        });
      }

      await this.io.onDocument?.(result, {
        kind: "single",
        iteration: inputs.index,
      });
      return { exitCode, document: result };
    } catch (e) {
      const result = adoptStartedRun(
        synthesizeErroredResult(
          specPath,
          e as Error,
          { labels: parseLabelFlags(opts.label) },
          this.cwd,
        ),
        startedRun,
      );
      sink.push(result);
      exitCode = result.exitCode;
      if (invocation) {
        const refusal = refusalOf(result, specPath);
        if (refusal) {
          journalRefused(invocation.journal, refusal, planIndex);
        } else {
          journalRunFinished(
            invocation,
            planIndex,
            specPath,
            result,
            (e as Error).message,
          );
        }
      }
      this.narration.singleErrored?.();
      if (
        !(await writeJUnitIfRequested(
          opts,
          [result],
          this.postRunLog,
          this.cwd,
        ))
      ) {
        return { exitCode: 2, document: result };
      }
      await this.io.onDocument?.(result, {
        kind: "single",
        iteration: inputs.index,
        errored: true,
      });
      return { exitCode, document: result };
    } finally {
      untrackSignalArtifactReporter?.();
      untrack();
      await backend.close().catch(() => undefined);
    }
  }

  /* ----- multi-spec path ----- */

  private async runBatch(
    specs: string[],
    parallel: number,
    inputs: IterationInputs,
  ): Promise<IterationOutcome> {
    const { opts } = inputs.iteration;
    const { services, invocation, scopedSecrets, sink } = inputs;
    this.narration.specsStart?.({
      mode: "batch",
      total: specs.length,
      parallel,
    });
    const tStart = Date.now();
    const startedAt = new Date(tStart).toISOString();
    const artifactRoot = await resolveBatchArtifactRoot(
      specs[0]!,
      opts,
      this.cwd,
    );
    const activeRunDirs = new Set<string>();
    const completedByIndex: Array<RunResult | undefined> = Array.from({
      length: specs.length,
    });
    const untrackAbortReporter = this.resources.trackReporter((signal) => {
      if (services) {
        for (const runDir of activeRunDirs) {
          services.captureSignalArtifactsSync(runDir, signal);
        }
      }
      const completed = completedByIndex.filter(
        (result): result is RunResult => result !== undefined,
      );
      try {
        const written = writeAbortedBatchSummary(artifactRoot, {
          signal,
          startedAt,
          parallel,
          requestedTotal: specs.length,
          completed,
        });
        if (this.narration.abortedBatchSummary) {
          this.narration.abortedBatchSummary({ path: written.path });
        } else {
          this.runLog.warn(`wrote aborted batch summary to ${written.path}`);
        }
      } catch (error) {
        const message = (error as Error).message;
        if (this.narration.abortedBatchSummary) {
          this.narration.abortedBatchSummary({ error: message });
        } else {
          this.runLog.warn(`could not write aborted batch summary: ${message}`);
        }
      }
    });

    // Each SPEC gets its own session id — not just each worker. A per-worker
    // session reused the same agent-browser daemon across every spec in the
    // batch, so a daemon that wedged during spec 1 poisoned the rest. Per-spec
    // sessions mean a fresh daemon and browser per spec; the worker index
    // stays in the name so parallel workers still can't collide, and the
    // session root is unique per invocation (MCP runs share one process).
    const plannedTotal = invocation?.journal.plannedTotal ?? specs.length;
    let results: RunResult[];
    try {
      results = await runPool(
        specs,
        parallel,
        async (specPath, idx, workerIndex) => {
          const refused = inputs.refusals.get(specPath);
          if (refused) {
            // Policy refusal: no backend, no run directory; the batch keeps
            // going (it fails only under --strict-requires).
            const planIndex = invocation
              ? planIndexOf(
                  invocation.iteration,
                  invocation.specsPerIteration,
                  idx,
                )
              : 0;
            const ctx: SpecRunContext = {
              mode: "batch",
              specPath,
              idx,
              total: specs.length,
              parallel,
              iteration: inputs.index,
              planIndex:
                planIndex || (inputs.index - 1) * specs.length + idx + 1,
              plannedTotal,
            };
            this.narration.specStart?.(ctx);
            const result = this.refusedResult(refused, inputs, planIndex);
            completedByIndex[idx] = result;
            sink.push(result);
            this.narration.specFinish?.({ ...ctx, result });
            return result;
          }
          if (this.aborted) {
            const cancelled = synthesizeCancelledResult(
              specPath,
              { labels: parseLabelFlags(opts.label) },
              this.cwd,
            );
            sink.push(cancelled);
            return cancelled;
          }
          const planIndex = invocation
            ? planIndexOf(
                invocation.iteration,
                invocation.specsPerIteration,
                idx,
              )
            : 0;
          const ctx: SpecRunContext = {
            mode: "batch",
            specPath,
            idx,
            total: specs.length,
            parallel,
            iteration: inputs.index,
            planIndex: planIndex || (inputs.index - 1) * specs.length + idx + 1,
            plannedTotal,
          };
          const { backend, untrack } = this.createTrackedBackend({
            ...backendOpts(opts, inputs.browser),
            session: `${this.sessionRoot}-w${workerIndex}-s${idx}`,
          });
          const specListener = this.specListener(ctx);
          const runToken = generateRunToken();
          let activeRunDir: string | undefined;
          let startedRun: { runId: string; runDir: string } | undefined;
          const signalAwareListener =
            services || invocation
              ? withRunStartHook(specListener, (runDir, runId) => {
                  activeRunDir = runDir;
                  if (services) activeRunDirs.add(runDir);
                  startedRun = { runId, runDir };
                  invocation?.journal.runStarted(
                    planIndex,
                    specPath,
                    runId,
                    runDir,
                  );
                })
              : specListener;
          if (invocation) journalRunStarting(invocation, planIndex, specPath);
          this.narration.specStart?.(ctx);
          try {
            const r = await runSpec({
              ...this.runSpecOptions(specPath, inputs),
              backend,
              workerIndex,
              runToken,
              ...(invocation
                ? { invocation: invocation.journal.ref(planIndex) }
                : {}),
              ...(signalAwareListener ? { listener: signalAwareListener } : {}),
            });
            if (activeRunDir) activeRunDirs.delete(activeRunDir);
            activeRunDir = undefined;
            // runSpec returns only after run.json/report.json/manifest are
            // durable. Record immediately, before best-effort annotation/stash
            // work, so a signal can index every completed run directory.
            completedByIndex[idx] = r;
            sink.push(r);
            this.runDirs.push(r.runDir);
            if (invocation)
              journalRunFinished(invocation, planIndex, specPath, r);
            if (!this.aborted) {
              await runAfterHooksForResult(
                r,
                {
                  after: opts.after,
                  hookTimeoutMs: inputs.hookTimeoutMs,
                  signal: this.cancelController.signal,
                },
                scopedSecrets,
                { ...inputs.hookContext, runToken },
                afterHookObserver(invocation, r.runId),
                (kind, message) => this.note(kind, message),
              );
            }
            this.narration.specFinish?.({ ...ctx, result: r });
            if (!this.aborted) {
              await runPostRunIntegrations(r, specPath, opts, {
                log: this.runLog,
                ...(this.narration.postRun
                  ? { narrate: this.narration.postRun }
                  : {}),
                cwd: this.cwd,
              });
            }
            return r;
          } catch (e) {
            // Synthesize an errored RunResult so the batch survives (refused
            // when runSpec's own policy guard refused it, cancelled when the
            // invocation was cancelled before the spec started).
            const err = e as Error;
            const errored = adoptStartedRun(
              synthesizeErroredResult(
                specPath,
                err,
                { labels: parseLabelFlags(opts.label) },
                this.cwd,
              ),
              startedRun,
            );
            const refusal = refusalOf(errored, specPath);
            this.narration.specFinish?.(
              refusal
                ? { ...ctx, result: errored }
                : { ...ctx, error: err.message },
            );
            completedByIndex[idx] = errored;
            sink.push(errored);
            if (invocation) {
              if (refusal) {
                journalRefused(invocation.journal, refusal, planIndex);
              } else {
                journalRunFinished(
                  invocation,
                  planIndex,
                  specPath,
                  errored,
                  err.message,
                );
              }
            }
            return errored;
          } finally {
            if (activeRunDir) activeRunDirs.delete(activeRunDir);
            untrack();
            await backend.close().catch(() => undefined);
          }
        },
      );
    } catch (error) {
      untrackAbortReporter();
      throw error;
    }

    // Keep the signal-time reporter registered through stamping, JUnit, and
    // the document hand-off (stdout drain in the CLI). A signal in this final
    // window must still preserve a durable batch summary.
    try {
      const totalDurationMs = Date.now() - tStart;
      const summary = batchSummary(results);
      const exitCode = batchExitCode(results, opts.strictRequires);

      this.narration.batchEnd?.({ ...summary, durationMs: totalDurationMs });

      const batch: BatchRunResult = {
        $schema: "urn:cairntrace.dev:run-batch:v1",
        version: "1",
        parallel,
        totalDurationMs,
        summary,
        results,
        exitCode,
      };

      if (
        !this.aborted &&
        !(await stampIfGreen(opts, results, this.postRunLog))
      ) {
        return { exitCode: 2, document: batch };
      }
      if (
        !(await writeJUnitIfRequested(opts, results, this.postRunLog, this.cwd))
      ) {
        return { exitCode: 2, document: batch };
      }
      await this.io.onDocument?.(batch, {
        kind: "batch",
        iteration: inputs.index,
      });
      return { exitCode, document: batch };
    } finally {
      untrackAbortReporter();
    }
  }
}

/**
 * Tell the fixture host what the services seed did this invocation: a seed
 * that actually ran makes seed-scoped fixtures ensured before it stale (and
 * is recorded for later invocations); one skipped as fresh keeps them fresh.
 */
async function observeSeed(
  host: FixtureHost,
  services: ServicesHandle | undefined,
  project: string | undefined,
): Promise<void> {
  const seedEvents = (services?.events ?? []).filter(
    (event) => event.phase === "seed",
  );
  const ran = seedEvents.find(
    (event) => event.event === "complete" && event.message === "seed complete",
  );
  if (ran) {
    host.seed = { ran: true, at: ran.timestamp };
    if (project) await recordSeedRun(project, ran.timestamp);
  } else if (seedEvents.some((event) => event.event === "skip")) {
    host.seed = { ran: false };
  }
}

/** BatchRunResult summary; `refused` only when a spec was refused. */
function batchSummary(
  results: readonly RunResult[],
): BatchRunResult["summary"] {
  const count = (status: RunResult["status"]): number =>
    results.filter((r) => r.status === status).length;
  const refused = count("refused");
  return {
    total: results.length,
    passed: count("passed"),
    failed: count("failed"),
    errored: count("errored"),
    ...(refused > 0 ? { refused } : {}),
  };
}

/**
 * A batch's exit code: 6 (contract changed) > 1 (failed) > 2 (errored) > 7
 * (refused) > 0. Refused is 7 when every spec was refused (nothing ran —
 * whatever --parallel, one spec or many) or, under --strict-requires, when
 * any spec was. Otherwise a refused spec does not fail the batch.
 */
function batchExitCode(
  results: readonly RunResult[],
  strictRequires: boolean | undefined,
): ExitCode {
  const summary = batchSummary(results);
  if (results.some((result) => result.exitCode === 6)) return 6;
  if (summary.failed > 0) return 1;
  if (summary.errored > 0) return 2;
  const refused = summary.refused ?? 0;
  if (refused > 0 && (strictRequires || refused === summary.total)) return 7;
  return 0;
}

/** Logger used when the caller passes none: drops everything. */
const silentLogger: RunLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  raw: () => undefined,
  scope: () => silentLogger,
};
