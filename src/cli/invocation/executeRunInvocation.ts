import { basename, dirname, relative, resolve } from "node:path";
import type { BrowserBackend } from "../../adapters/browserBackend";
import {
  generateInvocationId,
  InvocationJournal,
  redactArgv,
} from "../../core/artifacts/invocationJournal";
import {
  createLiveArtifactRedactor,
  registerSecretValues,
} from "../../core/artifacts/redaction";
import { recordSeedRun } from "../../core/fixtures/ledger";
import { RUN_LOCK_ENV, RunLockRefusedError } from "../../core/runPolicy/lock";
import { SuiteError } from "../../core/suites/resolve";
import { suiteVarEnvName } from "../../core/suites/schema";
import {
  recordLedgerSession,
  type LedgerHandle,
} from "../../core/runPolicy/sessionLedger";
import { FixtureHost } from "../../core/fixtures/runtime";
import {
  cairnContextEnv,
  targetChildEnvWithSelectedTvaultKeys,
} from "../../core/processEnv";
import { runPool } from "../../core/runner/pool";
import { killLiveCommandsSync } from "../../core/runner/boundedCommand";
import { signalBudget, type SignalBudget } from "../../core/runPolicy/finally";
import {
  generateRunToken,
  runSpec,
  type ProgressListener,
} from "../../core/runner/Runner";
import {
  ServicesCancelledError,
  type CriticalTeardownFailure,
  type ServicesHandle,
} from "../../core/runner/services";
import type { WebServerHandle } from "../../core/runner/webServer";
import type { ArtifactRedactor } from "../../core/artifacts/ArtifactWriter";
import type { InvocationSummary } from "../../core/schema/events.v1";
import type { BrowserConfig } from "../../core/schema/config.v1";
import {
  buildRunNextActions,
  type InvocationOutcome,
  type RunResult,
} from "../../core/schema/run.v1";
import type {
  BatchRunResult,
  BatchSkippedSpec,
} from "../../core/schema/runBatch.v1";
import type {
  RunInvocationKind,
  RunInvocationOptions,
  RunInvocationOrigin,
} from "../../core/schema/runInvocation.v1";
import type { SelectionResult } from "../../core/schema/selection.v1";
import type { Backend, ExitCode } from "../../core/schema/shared";
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
  describeCriticalTeardown,
  resolveRunPolicy,
  RunPolicyResolutionError,
  RunPolicySession,
  summarizeRunPolicy,
  type RunPolicyDeps,
} from "./runPolicy";
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
  EngineMetrics,
  resolveRunMetrics,
  type InvocationMetrics,
} from "./metrics";
import {
  buildDelegatePlan,
  buildDelegateRequest,
  DelegateSession,
  delegatedResults,
  DelegationError,
  journalDirOf,
  readSettledRun,
  refusedPlanEntries,
  renderDelegatePlan,
  resolveDelegation,
  resolveRunnerSpawn,
  withDelegatedOutcome,
  type DelegateSettled,
  type DelegationTarget,
  type RunnerSpawnSpec,
} from "./delegate";
import {
  delegateVerdict,
  type DelegatedExitCode,
  type RelayedRun,
} from "../../core/delegate/relay";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DELEGATE_CONTRACT,
  type DelegatePlan,
} from "../../core/schema/delegate.v1";
import type { InvocationPlannedRun } from "../../core/schema/events.v1";
import {
  type AppliedSuite,
  applySuite,
  refreshSuiteVars,
  runSuiteAfterHooksSync,
  runSuiteHooks,
  type SuiteHooksOutcome,
} from "./suite";
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
  /**
   * A delegated runner reported a run settled (`result`: its run.json,
   * when the runner already copied it under the local artifact root).
   */
  delegatedRunFinish?(
    ctx: SpecRunContext & {
      status: "passed" | "failed" | "errored";
      runId: string;
      durationMs?: number;
      result?: RunResult;
    },
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
   * it: before services teardown, or — when a config `run:` policy or a
   * critical teardown can still change the exit code — after the verdict,
   * carrying `invocationOutcome` and the settled `exitCode`. Awaited, so a
   * slow consumer (a piped stdout) holds the engine exactly like the CLI
   * drain did.
   */
  onDocument?: (
    document: RunDocument,
    meta: RunDocumentMeta,
  ) => void | Promise<void>;
  /**
   * SIGINT / SIGTERM while documents are held: the ones of the iterations
   * that finished, with `invocationOutcome.exitCode` 130 / 143, from the
   * synchronous signal path (no continuation runs after it). Write them
   * synchronously; without it they go to `onDocument` unawaited.
   */
  onDocumentSync?: (document: RunDocument, meta: RunDocumentMeta) => void;
  /**
   * Serialize invocations that boot the same services/webServer
   * environment (config + env). Resolves with a release function.
   */
  /** Where the run policy looks at the machine (tests only). */
  runPolicyDeps?: RunPolicyDeps;
  /** Bound on one spec's `backend.close()` (tests only; default 90s). */
  backendCloseTimeoutMs?: number;
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
  /** A runner environment: what would be spawned (masked). */
  delegate?: DelegatePlan;
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
  /** 130 / 143 only for a delegated invocation the runner settled that way. */
  exitCode: ExitCode | 130 | 143;
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
/** Synchronous cleanup the signal path still runs (bounded by `budget`). */
type SignalHook = (signal: SignalName, budget: SignalBudget) => void;

/** The code cairn exits with on a signal (what `CAIRN_EXIT_CODE` says then). */
function signalExitCode(signal: SignalName): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

/** A services environment the signal path tears down. */
interface TrackedServices {
  terminateSync(): void;
  /** A critical entry (or the provisioner's `down`) has not run yet. */
  criticalPending?(): boolean;
}

/** Per-invocation registry of the resources the signal path must kill. */
class ResourceScope {
  private readonly backends = new Set<BrowserBackend>();
  private readonly servers = new Set<{ terminateSync(): void }>();
  private readonly services = new Set<TrackedServices>();
  private readonly reporters = new Set<AbortReporter>();
  private readonly locks = new Set<{ releaseLockSync(): void }>();
  private readonly ledgers = new Set<LedgerHandle>();
  /** Suite `after` hooks: while services are still up. */
  private readonly beforeTeardownHooks = new Set<SignalHook>();
  /** `run.finally`: after services and the webServer are down. */
  private readonly afterTeardownHooks = new Set<SignalHook>();

  trackSignalHook(
    stage: "before-teardown" | "after-teardown",
    hook: SignalHook,
  ): () => void {
    const set =
      stage === "before-teardown"
        ? this.beforeTeardownHooks
        : this.afterTeardownHooks;
    set.add(hook);
    return () => {
      set.delete(hook);
    };
  }

  private runSignalHooks(
    set: Set<SignalHook>,
    signal: SignalName,
    budget: SignalBudget,
  ): void {
    const hooks = [...set];
    set.clear();
    for (const hook of hooks) {
      try {
        hook(signal, budget);
      } catch {
        // Cleanup must never block the exit path.
      }
    }
  }

  trackLedger(handle: LedgerHandle): () => void {
    this.ledgers.add(handle);
    return () => {
      this.ledgers.delete(handle);
    };
  }

  /** The run lock is released last on the signal path. */
  trackLock(session: { releaseLockSync(): void }): () => void {
    this.locks.add(session);
    return () => {
      this.locks.delete(session);
    };
  }

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

  trackServices(handle: TrackedServices): () => void {
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

  /**
   * What is left after the browsers: suite `after` hooks, the webServer /
   * services teardown, `run.finally`. `critical` when a services teardown
   * still owes a critical entry (a provisioner's `down`).
   */
  private pendingCleanup(): "critical" | "teardown" | undefined {
    for (const handle of this.services) {
      try {
        if (handle.criticalPending?.()) return "critical";
      } catch {
        // A probe never blocks the exit path.
      }
    }
    return this.beforeTeardownHooks.size > 0 ||
      this.servers.size > 0 ||
      this.services.size > 0 ||
      this.afterTeardownHooks.size > 0
      ? "teardown"
      : undefined;
  }

  /**
   * Reporters once; every command still running (preconditions, hooks,
   * preflight, `run:` steps); browsers; the suite's `after` hooks (services
   * still up); the webServer and services; `run.finally`; and the run lock
   * last — so the next run of the config never starts while something of
   * this one is still working. The suite's `after` hooks share one bounded
   * budget and `run.finally` gets its own after the services teardown, so
   * slow `after` hooks never cost it its run; the services teardown (a
   * provisioner's critical `down` included) has its own caps and never
   * depends on either. `notice` gets one line before the slow part: the
   * hosts (cleanup.ts's handler, `cairn mcp`) hold further signals until
   * this returns, so a second Ctrl-C does not cut it short.
   */
  terminateSync(signal: SignalName, notice?: (message: string) => void): void {
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
    try {
      killLiveCommandsSync();
    } catch {
      // Cleanup must never block the exit path.
    }
    const budget = signalBudget();
    this.killBackendsSync();
    // The daemons are dead: ledger entries with no survivor go.
    for (const ledger of this.ledgers) {
      try {
        ledger.finish();
      } catch {
        // Cleanup must never block the exit path.
      }
    }
    this.ledgers.clear();
    const pending = this.pendingCleanup();
    if (pending && notice) {
      try {
        notice(
          `cleanup in progress (${
            pending === "critical"
              ? "critical teardown pending"
              : "teardown pending"
          }); further Ctrl-C is ignored until it ends, send SIGKILL to force`,
        );
      } catch {
        // Narration never blocks the exit path.
      }
    }
    this.runSignalHooks(this.beforeTeardownHooks, signal, budget);
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
    // `run.finally`: a window of its own, whatever the hooks before took.
    this.runSignalHooks(this.afterTeardownHooks, signal, signalBudget());
    for (const lock of this.locks) {
      try {
        lock.releaseLockSync();
      } catch {
        // Cleanup must never block the exit path.
      }
    }
    this.locks.clear();
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

/**
 * The longest one spec's `backend.close()` may take. Above the adapters' own
 * bounds (a Playwright close is killed after 10s, an agent-browser `close`
 * command after 60s), so it only catches a close that would never return.
 */
const BACKEND_CLOSE_TIMEOUT_MS = 90_000;

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
  /** The request's options; `--suite` replaces them with the suite's defaults applied. */
  private opts: RunInvocationOptions;
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
  /** The config `run:` block of this invocation (F8), once resolved. */
  private policy: RunPolicySession | undefined;
  /** `--suite` (F9): the resolved suite, once applied. */
  private suite: AppliedSuite | undefined;
  /** `suite.started` was journaled and `suite.finished` not yet. */
  private suiteOpen = false;
  private suiteHooksFailed = 0;
  /** Config `metrics:` probes (F11), once resolved. */
  private metrics: EngineMetrics | undefined;
  /** The delegated runner of a `runner:` environment, once spawned. */
  private delegateSession: DelegateSession | undefined;
  /** `--bail`: set by the first failed or errored spec. */
  private readonly bailState: {
    tripped: boolean;
    trigger?: { spec: string; exitCode: ExitCode };
  } = { tripped: false };
  /** Specs `--bail` never started, across iterations. */
  private readonly skippedSpecs: BatchSkippedSpec[] = [];
  /** The project config directory, for the browser-session ledger. */
  private projectDir: string | undefined;
  /** Critical teardown entries that failed (exit 8). */
  private criticalFailures: CriticalTeardownFailure[] = [];
  /** Exit 8 / 9 messages of the run policy. */
  private readonly policyErrors: string[] = [];
  /**
   * The exit code can still change after the specs (a config `run:` policy
   * or a critical teardown): documents are held until it settled, so what
   * is printed / returned agrees with the process exit code.
   */
  private holdDocuments = false;
  private readonly heldDocuments: Array<{
    document: RunDocument;
    meta: RunDocumentMeta;
  }> = [];
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
      // Safety net for a path that skipped the explicit release (a crash).
      this.policy?.releaseLockSync();
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

  /**
   * `backend.close()` with a bound. A close that waits on a hung browser or
   * daemon must not hold what follows a spec — the next spec, the suite
   * `after` hooks, the services teardown, the exit. Past the bound the
   * backend's synchronous kill (`terminateSync`) ends its processes.
   */
  private async closeBackend(
    backend: BrowserBackend,
    real: BrowserBackend,
  ): Promise<void> {
    const timeoutMs = this.io.backendCloseTimeoutMs ?? BACKEND_CLOSE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      backend.close().then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (closed) return;
    try {
      real.terminateSync?.();
    } catch {
      // best-effort: the close already failed its bound
    }
    this.note(
      "warn",
      `the ${real.name} browser did not close within ${timeoutMs}ms; ${
        real.terminateSync ? "its processes were killed" : "it was abandoned"
      }`,
    );
  }

  /* ----- cancellation ----- */

  private abortGracefully(): void {
    if (this.aborted || this.terminated) return;
    this.aborted = true;
    if (this.delegateSession) {
      // A delegated runner cancels its remote invocation (SIGINT, grace,
      // SIGTERM, SIGKILL); the relay keeps going until it exits.
      this.delegateSession.cancel("cancel");
    } else {
      this.note(
        "warn",
        "cancel requested: stopping browser sessions and skipping the remaining specs",
      );
    }
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
    this.resources.terminateSync(signal, (message) => this.signalNote(message));
  }

  /** A backend for one spec run, tracked for the signal path. */
  private createTrackedBackend(options: Parameters<typeof createBackend>[0]): {
    backend: BrowserBackend;
    untrack: () => void;
    real: BrowserBackend;
    /** Call after `backend.close()`: settles the browser-session ledger entry. */
    finishLedger: () => void;
  } {
    const real = createBackend(options);
    const untrackBackend = this.resources.trackBackend(real);
    const backend = this.io.signal
      ? cancellableBackend(real, this.io.signal)
      : real;
    const ledger = this.recordBrowserSession(real, options);
    // The browser pid is only known while the session lives: learn it once
    // more right before the backend closes.
    const untrack = (): void => {
      ledger.learn();
      untrackBackend();
    };
    return { backend, untrack, real, finishLedger: ledger.finish };
  }

  /**
   * Record the browser session in the owned-session ledger (`cairn doctor
   * --orphans`, `run.verifyClean: [browsers]`). The pid is learnt while the
   * session runs (agent-browser also has a pid file the scan reads).
   */
  private recordBrowserSession(
    real: BrowserBackend,
    options: Parameters<typeof createBackend>[0],
  ): { learn: () => void; finish: () => void } {
    const choice = options.mock ? "mock" : (options.backend ?? "agent-browser");
    if (choice === "mock")
      return { learn: () => undefined, finish: () => undefined };
    const handle = recordLedgerSession({
      session: options.session ?? this.sessionRoot,
      backend: choice,
      invocationId: this.id,
      projectDir: this.projectDir ?? this.cwd,
      ...(this.io.runPolicyDeps?.ledgerRoot
        ? { root: this.io.runPolicyDeps.ledgerRoot }
        : {}),
      ...(this.io.runPolicyDeps?.probe
        ? { probe: this.io.runPolicyDeps.probe }
        : {}),
    });
    const untrackLedger = this.resources.trackLedger(handle);
    const learn = (): void => {
      try {
        const pid = real.browserPid?.();
        if (pid !== undefined) handle.setPids([pid]);
      } catch {
        // best-effort
      }
    };
    const timer = setInterval(learn, 2_000);
    timer.unref?.();
    return {
      learn,
      finish: () => {
        clearInterval(timer);
        untrackLedger();
        handle.finish(this.io.runPolicyDeps?.probe);
      },
    };
  }

  /* ----- results ----- */

  /** Hand a spec document to the caller now, or hold it until settlement. */
  private async emitDocument(
    document: RunDocument,
    meta: RunDocumentMeta,
  ): Promise<void> {
    if (this.holdDocuments) {
      this.heldDocuments.push({ document, meta });
      return;
    }
    await this.io.onDocument?.(document, meta);
  }

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
    // The run lock goes before the journal settles, so `run.lock.released`
    // lands ahead of `invocation.finished`.
    this.policy?.releaseLock();
    if (journal) {
      this.emitSuiteFinished(code);
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
        ...this.policySummary(),
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

  /**
   * `--bail`: the first failed or errored spec stops the scheduling of the
   * rest. A refused spec (environment policy) and a cancel do not trip it.
   */
  private tripBail(
    opts: RunInvocationOptions,
    specPath: string,
    result: RunResult,
  ): void {
    if (!opts.bail || this.bailState.tripped || this.aborted) return;
    if (result.status !== "failed" && result.status !== "errored") return;
    this.bailState.tripped = true;
    this.bailState.trigger = { spec: specPath, exitCode: result.exitCode };
    this.note(
      "warn",
      `--bail: ${result.spec.name} ${result.status}; no further spec will start`,
    );
  }

  /** Journal `suite.finished` once (the exit code the invocation settled on). */
  private emitSuiteFinished(code: number): void {
    if (!this.suiteOpen || !this.suite) return;
    this.suiteOpen = false;
    this.activeJournal?.appendEvent({
      ts: new Date().toISOString(),
      type: "suite.finished",
      name: this.suite.resolved.name,
      exitCode: code,
      ...(this.suiteHooksFailed > 0
        ? { hooksFailed: this.suiteHooksFailed }
        : {}),
    });
  }

  /**
   * `--suite`: say which seed post-commands the suite skipped, and warn about
   * a `seed.postCommands.skip` entry that matched none (a typo would
   * otherwise run the command silently).
   */
  private noteSeedSkips(
    plan: Awaited<ReturnType<typeof resolveServicesPlan>>,
  ): void {
    const wanted = this.suite?.resolved.seedSkip ?? [];
    if (!plan || wanted.length === 0) return;
    const skipped = new Set(
      (plan.skippedPostCommands ?? []).map((c) => c.trim()),
    );
    if (skipped.size > 0) {
      this.note(
        "info",
        `suite ${this.suite!.resolved.name}: skipping ${skipped.size} seed postCommand(s)`,
      );
    }
    for (const entry of wanted) {
      if (!skipped.has(entry.trim())) {
        this.note(
          "warn",
          `suite ${this.suite!.resolved.name}: seed.postCommands.skip entry matches no seed postCommand: ${this.redactNote(entry)}`,
        );
      }
    }
  }

  private redactNote(text: string): string {
    return this.activeJournal?.redactText(text) ?? text;
  }

  /* ----- run policy (F8) ----- */

  /** `runPolicy` of the journal summary, when the policy did anything notable. */
  private policySummary(): Pick<InvocationSummary, "runPolicy"> {
    const runPolicy = summarizeRunPolicy(this.policy, this.criticalFailures);
    return runPolicy ? { runPolicy } : {};
  }

  /**
   * Resolve the invocation's `run:` policy and run its gates before
   * anything starts: the lock, the preflight checks and the clean-machine
   * assertion. Returns the refusal message (exit 4), or undefined to go on.
   * The lock stays held on success; every exit path releases it.
   */
  private async startRunPolicy(
    specs: readonly string[],
    scopedSecrets: ScopedSecrets,
    redactor: ArtifactRedactor,
    /**
     * A delegated environment: the lock is that environment's own, and
     * `verifyClean` does not apply (nothing of the run is local).
     */
    delegated?: { env: string },
  ): Promise<string | undefined> {
    let resolved: Awaited<ReturnType<typeof resolveRunPolicy>>;
    try {
      resolved = await resolveRunPolicy(
        specs,
        this.opts,
        scopedSecrets,
        this.cwd,
      );
    } catch (e) {
      if (e instanceof RunPolicyResolutionError)
        return redactor.text(e.message);
      throw e;
    }
    if (
      resolved &&
      delegated &&
      (resolved.policy.verifyClean?.length ?? 0) > 0
    ) {
      this.note(
        "info",
        `run.verifyClean is not checked locally for the delegated environment "${delegated.env}" (nothing of the run is local; the remote cairn applies its own)`,
      );
      const { verifyClean: _skipped, ...policy } = resolved.policy;
      resolved = { ...resolved, policy };
    }
    if (!resolved) return undefined;
    const session = new RunPolicySession(resolved, {
      invocationId: this.id,
      origin: this.io.origin,
      argv:
        this.request.argv ??
        runOptionsToArgv(this.request.specs, this.request.options),
      cwd: this.cwd,
      scopedSecrets,
      redactor,
      journal: this.journal,
      note: (kind, message) => this.note(kind, message),
      signal: this.cancelController.signal,
      reuseServices: this.opts.reuseServices === true,
      ...(this.io.runPolicyDeps ? { deps: this.io.runPolicyDeps } : {}),
      redactArgv: (argv) => redactArgv(argv, redactor),
      ...(this.suite ? { suite: this.suite.resolved.name } : {}),
      ...(delegated ? { lockEnvironment: delegated.env } : {}),
    });
    this.policy = session;
    this.resources.trackLock(session);
    try {
      await session.acquireLock();
    } catch (e) {
      if (e instanceof RunLockRefusedError) return redactor.text(e.message);
      throw e;
    }
    // A `cairn services …` command started by this run (a hook, a `run:`
    // step, the provisioner) runs under this lock instead of refusing.
    const held = session.lockHandle;
    if (held) {
      scopedSecrets.env[RUN_LOCK_ENV] = held.path;
      scopedSecrets.childEnv[RUN_LOCK_ENV] = held.path;
    }
    const failed = await session.preflight();
    if (failed) return failed;
    const dirty = await session.checkClean("before");
    if (dirty.length > 0) {
      return `refusing to start: the machine is not clean before the run (run.verifyClean): ${session.describeDirty(dirty)}`;
    }
    // From here on `finally` runs on every exit path, a signal's included.
    this.resources.trackSignalHook("after-teardown", (signal, budget) =>
      session.runFinallySync(signalExitCode(signal), budget, (message) =>
        this.signalNote(message),
      ),
    );
    return undefined;
  }

  /** Narration on the signal path (stderr only: the journal is settled). */
  private signalNote(message: string): void {
    this.runLog.warn(message);
  }

  /**
   * After the services/webServer teardown: a critical teardown failure is
   * exit 8, then the `finally` belts run, then the clean-machine check
   * (exit 9 unless 8 already applies). Returns the exit code the run settles
   * on and the messages to report.
   */
  private async settlePolicy(
    code: ExitCode,
    critical: readonly CriticalTeardownFailure[],
  ): Promise<{ exitCode: ExitCode; errors: string[] }> {
    const policy = this.policy;
    const errors: string[] = [];
    let exitCode = code;
    // A critical teardown entry needs no `run:` block: it is the entry's own
    // flag.
    if (critical.length > 0) {
      this.criticalFailures = [...critical];
      exitCode = 8;
      const message = `critical teardown failed: ${describeCriticalTeardown(critical)}`;
      errors.push(message);
      this.note("warn", message);
    }
    if (!policy) {
      this.policyErrors.push(...errors);
      return { exitCode, errors };
    }
    await policy.runFinally(exitCode);
    const dirty = await policy.checkClean("after");
    if (dirty.length > 0) {
      const message = `state is not clean after the run (run.verifyClean): ${policy.describeDirty(dirty)}`;
      errors.push(message);
      this.note("warn", message);
      if (exitCode !== 8) exitCode = 9;
    }
    this.policyErrors.push(...errors);
    return { exitCode, errors };
  }

  /** {@link settlePolicy} for a lifecycle that failed to boot. */
  private async settleBoot(
    error: unknown,
    svcHandle: ServicesHandle | undefined,
  ): Promise<{ code: ExitCode | undefined; suffix: string }> {
    const base = configErrorExitCode(error);
    const critical =
      svcHandle?.criticalTeardownFailures?.() ??
      (error as { criticalTeardownFailures?: CriticalTeardownFailure[] })
        .criticalTeardownFailures ??
      [];
    const settled = await this.settlePolicy(base, critical);
    return {
      code: settled.exitCode === base ? undefined : settled.exitCode,
      suffix: settled.errors.length > 0 ? `; ${settled.errors.join("; ")}` : "",
    };
  }

  /* ----- the invocation ----- */

  private async run(): Promise<RunInvocationResult> {
    let specs = this.request.specs;
    // `--suite` (F9): the config's suite supplies the specs and the option
    // defaults; everything below then runs as if they had been typed.
    if (this.opts.suite !== undefined) {
      try {
        const applied = await applySuite({
          specs,
          options: this.opts,
          cwd: this.cwd,
          callerEnv:
            this.request.callerEnv ??
            (process.env as Record<string, string | undefined>),
        });
        this.suite = applied;
        this.opts = applied.options;
        specs = applied.resolved.specs;
        for (const warning of applied.warnings) this.note("warn", warning);
        if (applied.resolved.skippedDrafts.length > 0) {
          this.note(
            "info",
            `suite ${applied.resolved.name}: skipped ${applied.resolved.skippedDrafts.length} draft(s) starting with _`,
          );
        }
      } catch (e) {
        if (e instanceof SuiteError) return this.fail(e.message, e.exitCode);
        return this.fail((e as Error).message, 2);
      }
    }
    const { opts, cwd } = this;
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
    if (
      opts.runToken !== undefined &&
      !/^[A-Za-z0-9_.-]{1,64}$/.test(opts.runToken)
    ) {
      return this.fail(
        "--run-token must be 1-64 letters, digits, '_', '.' or '-'",
        2,
      );
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
          : "at least one spec path is required (or --suite <name>)",
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

    // `environments.<n>.runner`: the invocation runs elsewhere; this
    // process keeps the journal, the run directories, the exit code and the
    // cancel (see ./delegate.ts).
    let delegation: DelegationTarget | undefined;
    try {
      delegation = await resolveDelegation(expandedSpecs, opts, cwd);
    } catch (e) {
      if (e instanceof DelegationError) return this.fail(e.message, e.exitCode);
      throw e;
    }

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
      const { selection, refusals: selectionRefusals } =
        await this.withPolicySkips(built);
      if (delegation && selection.selected.length > 0) {
        const plan = await this.delegatePlanFor(
          delegation,
          [
            ...selection.selected.map((spec) => spec.path),
            ...selectionRefusals.keys(),
          ],
          selectionRefusals,
          iterations,
          multiRun,
          this.request.callerEnv ??
            (process.env as Record<string, string | undefined>),
        );
        this.printDelegatePlan(plan);
        selection.delegate = plan;
      }
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
              runnable,
              // A delegated environment's node scripts run elsewhere.
              delegation ? { skipNodePin: true } : {},
            )
          : noSecretsScope(callerEnv);
    } catch (e) {
      return this.fail((e as Error).message, configErrorExitCode(e));
    }

    // `--suite`: the suite's vars resolve again now that the vault's
    // secrets are in (a `${env.X}` the vault provides was empty before),
    // and `requires.vars` is checked against them.
    if (this.suite) {
      try {
        const refreshed = await refreshSuiteVars(
          this.suite,
          scopedSecrets.env,
          // A services dry-run never read the vault.
          opts.servicesDryRun ? { checkRequiredVars: false } : {},
        );
        opts.var = refreshed.var.length > 0 ? refreshed.var : undefined;
        opts.label = refreshed.label;
        for (const key of opts.servicesDryRun ? [] : refreshed.dropped) {
          this.note(
            "warn",
            `suite ${this.suite.resolved.name}: var ${key} uses an \${env.X} that is not set (not even by the vault); it is not passed, so the config's ${key} (if any) applies`,
          );
        }
        for (const key of opts.servicesDryRun
          ? []
          : refreshed.droppedProcessEnv) {
          this.note(
            "warn",
            `suite ${this.suite.resolved.name}: processEnv ${key} uses an \${env.X} that is not set (not even by the vault); it is not exported`,
          );
        }
        // `processEnv`: every later process of the run (preflight, services,
        // hooks, specs, verifiers) gets it, and `${env.X}` in the config and
        // specs resolves against it. Names only are narrated.
        const exported = Object.keys(refreshed.processEnv);
        if (exported.length > 0) {
          Object.assign(scopedSecrets.env, refreshed.processEnv);
          Object.assign(scopedSecrets.childEnv, refreshed.processEnv);
          this.note(
            "info",
            `suite ${this.suite.resolved.name}: process env ${exported.join(", ")}`,
          );
        }
      } catch (e) {
        if (e instanceof SuiteError) return this.fail(e.message, e.exitCode);
        return this.fail((e as Error).message, configErrorExitCode(e));
      }
    }

    // A services dry-run is a planning command, not a spec run with no-op
    // services. Resolve and return the effective lifecycle, then stop before
    // the web server, hooks, browser backend, run directory, or preconditions.
    if (opts.servicesDryRun && delegation) {
      this.narration.servicesDryRunStarting?.();
      const plan = await this.delegatePlanFor(
        delegation,
        expandedSpecs,
        refusals,
        iterations,
        multiRun,
        scopedSecrets.env,
      );
      const text = this.printDelegatePlan(plan);
      return {
        ...this.base(),
        kind: "services-dry-run",
        document: {
          servicesDryRun: true,
          plan: text.trimEnd().split("\n"),
          delegate: plan,
        },
        documents: [],
        exitCode: 0,
      };
    }
    if (opts.servicesDryRun) {
      this.narration.servicesDryRunStarting?.();
      try {
        const plan = await resolveServicesPlan(
          firstSpec,
          opts,
          scopedSecrets,
          cwd,
          this.suite?.resolved.seedSkip,
          this.suite?.resolved.name,
        );
        this.noteSeedSkips(plan);
        const processEnv = Object.keys(this.suite?.resolved.processEnv ?? {});
        const text = plan
          ? renderServicesDryRunPlan(
              processEnv.length > 0 ? { ...plan, processEnv } : plan,
              scopedSecrets,
            )
          : undefined;
        if (text !== undefined) {
          if (this.narration.servicesPlan) this.narration.servicesPlan(text);
          else this.runLog.info(text.trimEnd());
        } else if (!opts.noServices) {
          this.runLog.info(
            "services dry-run: no services for this environment (no `services:` block at the top level or in the environment, or `services: false`)",
          );
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
      argv:
        this.request.argv ??
        runOptionsToArgv(this.request.specs, this.request.options),
      cwd,
      origin: this.io.origin,
      ...(this.io.client ? { client: this.io.client } : {}),
      ...(invocationContext.configPath
        ? { configPath: invocationContext.configPath }
        : {}),
      ...(invocationContext.environment
        ? { env: invocationContext.environment }
        : {}),
      ...(invocationContext.envAlias
        ? { envAlias: invocationContext.envAlias }
        : {}),
      labels: parseLabelFlags(opts.label),
      ...(this.suite ? { suite: this.suite.resolved.name } : {}),
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
    journal?.narrate(
      this.suite
        ? `starting suite "${this.suite.resolved.name}" (env ${this.suite.resolved.env}): ${specs.length} spec(s)`
        : summarizeStartingSpecs(specs, cwd),
    );
    if (journal && this.suite) {
      const resolved = this.suite.resolved;
      this.suiteOpen = true;
      journal.appendEvent({
        ts: new Date().toISOString(),
        type: "suite.started",
        name: resolved.name,
        env: resolved.env,
        specs: specs.length,
        ...(opts.parallel !== undefined && opts.parallel > 1
          ? { parallel: opts.parallel }
          : {}),
        ...(opts.bail ? { bail: true as const } : {}),
      });
    }
    this.projectDir = invocationContext.configPath
      ? dirname(invocationContext.configPath)
      : undefined;
    const lifecycleCtx = {
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
    };

    if (delegation) {
      return this.runDelegated({
        target: delegation,
        journal,
        untrackJournal,
        runnable,
        refusals,
        scopedSecrets,
        lifecycleCtx,
        iterations,
        multiRun,
        parallel,
        startedAtMs: invocationStartedAtMs,
        firstSpec,
      });
    }

    // F8 run policy: the lock first (before anything starts), then the
    // preflight checks and the clean-machine assertion. A refusal here is
    // exit 4 and nothing of ours was started.
    if (runnable.length > 0) {
      const refusal = await this.startRunPolicy(
        runnable,
        scopedSecrets,
        lifecycleCtx.redactor,
      );
      if (refusal) {
        untrackJournal?.();
        return this.lifecycleFailure(refusal, 4, lifecycleCtx);
      }
    }

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
        ? await resolveServicesPlan(
            firstSpec,
            opts,
            scopedSecrets,
            cwd,
            this.suite?.resolved.seedSkip,
            this.suite?.resolved.name,
          )
        : undefined;
      this.noteSeedSkips(plan);
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
          (terminateSync, criticalPending) => {
            untrackSvc = this.resources.trackServices({
              terminateSync,
              ...(criticalPending ? { criticalPending } : {}),
            });
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
        // F10: what the provisioner exported reaches every later phase,
        // hook, spec and verifier as env.
        if (svcHandle.exportedEnv) {
          Object.assign(scopedSecrets.env, svcHandle.exportedEnv);
          Object.assign(scopedSecrets.childEnv, svcHandle.exportedEnv);
        }
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
      // F8: belts and the clean-machine check run after a failed boot too;
      // a critical teardown that failed in the cleanup outranks the boot error.
      const boot = await this.settleBoot(e, svcHandle);
      // A boot the cancel killed reports like any cancel before the specs;
      // other errors (a cancelled lock wait, a boot failure) keep their own.
      if (e instanceof ServicesCancelledError) {
        return this.fail(CANCELLED_BEFORE_SPECS + boot.suffix, boot.code ?? 2);
      }
      if (this.aborted) {
        return this.fail(
          (e as Error).message + boot.suffix,
          boot.code ?? configErrorExitCode(e),
        );
      }
      // A services lock refusal (exit 4) or a boot failure (exit 2).
      return this.lifecycleFailure(
        (e as Error).message + boot.suffix,
        boot.code ?? configErrorExitCode(e),
        lifecycleCtx,
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
      const boot = await this.settleBoot(e, svcHandle);
      if (this.aborted) {
        return this.fail(CANCELLED_BEFORE_SPECS + boot.suffix, boot.code ?? 2);
      }
      // A webServer boot/readiness/setup failure (exit 2).
      return this.lifecycleFailure(
        (e as Error).message + boot.suffix,
        boot.code ?? configErrorExitCode(e),
        lifecycleCtx,
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
    // Metrics probes (F11) and suite hooks (F9) get the same context.
    const runMetrics = bootsLifecycle
      ? await resolveRunMetrics(firstSpec, opts, scopedSecrets, cwd)
      : undefined;
    const hookContext: HookContext =
      (opts.before?.length ?? 0) + (opts.after?.length ?? 0) > 0 ||
      this.suite !== undefined ||
      runMetrics !== undefined
        ? await resolveHookContext(firstSpec, opts, scopedSecrets, cwd)
        : {};
    if (runMetrics) {
      this.metrics = new EngineMetrics({
        resolved: runMetrics,
        invocationId: this.id,
        journal,
        redactor: lifecycleCtx.redactor,
        note: (kind, message) => this.note(kind, message),
        signal: this.cancelController.signal,
        context: cairnContextEnv(hookContext),
      });
    }
    const suiteHookOpts = (phase: "before" | "after", code?: number) => {
      const suite = this.suite!;
      const env: NodeJS.ProcessEnv = {
        ...scopedSecrets.childEnv,
        ...cairnContextEnv(hookContext),
        CAIRN_SUITE: suite.resolved.name,
        ...(journal ? { CAIRN_INVOCATION_DIR: journal.dir } : {}),
        ...(code !== undefined ? { CAIRN_EXIT_CODE: String(code) } : {}),
        ...Object.fromEntries(
          Object.entries(suite.resolved.vars).map(([key, value]) => [
            suiteVarEnvName(key),
            value,
          ]),
        ),
      };
      return {
        suite: suite.resolved.name,
        phase,
        commands:
          phase === "before" ? suite.resolved.before : suite.resolved.after,
        timeoutMs: suite.resolved.hookTimeoutMs ?? hookTimeoutMs,
        cwd: suite.configDir,
        env: targetChildEnvWithSelectedTvaultKeys(
          env,
          scopedSecrets.selectedKeys ?? [],
        ),
        journal,
        redact: (text: string) => lifecycleCtx.redactor.text(text),
        fatal: phase === "before",
        note: (kind: "info" | "warn", message: string) =>
          this.note(kind, message),
      };
    };
    let suiteBeforeStarted = false;
    // Suite `after` hooks on the signal path: what the async path has not
    // finished (a signal stops cairn before an async continuation runs).
    let suiteAfterDone = 0;
    let suiteAfterFinished = false;
    const untrackSuiteSignal =
      this.suite && this.suite.resolved.after.length > 0
        ? this.resources.trackSignalHook(
            "before-teardown",
            (signal, budget) => {
              if (!suiteBeforeStarted || suiteAfterFinished) return;
              suiteAfterFinished = true;
              const hook = suiteHookOpts("after", signalExitCode(signal));
              this.suiteHooksFailed += runSuiteAfterHooksSync({
                suite: hook.suite,
                commands: hook.commands,
                timeoutMs: hook.timeoutMs,
                cwd: hook.cwd,
                env: hook.env,
                journal: hook.journal,
                redact: hook.redact,
                note: (_kind, message) => this.signalNote(message),
                from: suiteAfterDone + 1,
                budget,
              });
            },
          )
        : undefined;

    // The verdict can still change after the specs: hold the documents.
    this.holdDocuments =
      this.policy !== undefined || svcHandle?.hasCriticalTeardown?.() === true;
    // A signal ends cairn before that verdict: what finished is handed over
    // then (exit 130 / 143), never dropped.
    const untrackHeldDocuments = this.holdDocuments
      ? this.resources.trackReporter((signal) =>
          this.flushHeldDocumentsSync(signal),
        )
      : undefined;

    // Resolve one final exit status only after lifecycle teardown.
    let exitCode: ExitCode = 2;
    const summaryRows: IterationSummary[] = [];
    const documents: RunDocument[] = [];
    let crash: string | undefined;
    let beforeHookError: string | undefined;
    try {
      // The suite's before hooks run once, after services and the webServer
      // are up (their failure stops the run like a failed --before hook).
      // A cancel that landed before this point started nothing: no after
      // hooks either.
      if (this.suite && !this.aborted) {
        suiteBeforeStarted = true;
        const outcome = await runSuiteHooks({
          ...suiteHookOpts("before"),
          signal: this.cancelController.signal,
        });
        this.suiteHooksFailed += outcome.failed;
        if (outcome.failed > 0 && !this.aborted) {
          beforeHookError = outcome.firstFailure;
          summaryRows.push({
            it: iterations[0]!,
            exitCode: 2,
            results: [],
            note: "suite before hook",
          });
          exitCode = 2;
        }
      }
      // Services/webServer are shared; each iteration (one pass with a single
      // run when no --repeat/--matrix) re-runs the --before hooks, then the specs.
      for (const it of iterations) {
        if (this.aborted || beforeHookError !== undefined) break;
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
        // Invocation-scope metrics (F11) bracket this iteration's specs.
        const iterationMetrics: InvocationMetrics | undefined =
          this.metrics?.forIteration(
            iterSecrets,
            multiRun ? it.index : undefined,
          );
        try {
          await iterationMetrics?.start();
          outcome =
            expandedSpecs.length === 1 && parallel === 1
              ? await this.runSingle(firstSpec, inputs)
              : await this.runBatch(expandedSpecs, parallel, inputs);
        } catch (e) {
          crash = `run ${it.index} crashed: ${(e as Error).message}`;
          this.note("warn", crash);
          outcome = { exitCode: 2 };
        }
        try {
          await iterationMetrics?.finish(results);
        } catch (e) {
          this.note("warn", `metrics: ${(e as Error).message}`);
          await iterationMetrics?.dispose();
        }
        if (outcome.document) documents.push(outcome.document);
        summaryRows.push({ it, exitCode: outcome.exitCode, results });
        exitCode = mergeExitCodes(exitCode, outcome.exitCode, it.index === 1);
        if (this.bailState.tripped && it.index < iterations.length) {
          this.note(
            "warn",
            `--bail: not starting run ${it.index + 1}/${iterations.length} (${this.bailState.trigger?.spec ?? "a spec"} did not pass)`,
          );
          break;
        }
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
      // No sampler outlives the invocation.
      await this.metrics?.disposeAll();
      // The suite's after hooks run on every exit path once its before phase
      // began (a cancel included: cleanup must run, so they get no signal),
      // while services and the webServer are still up.
      if (
        this.suite &&
        suiteBeforeStarted &&
        !suiteAfterFinished &&
        this.suite.resolved.after.length > 0
      ) {
        try {
          const outcome: SuiteHooksOutcome = await runSuiteHooks({
            ...suiteHookOpts("after", exitCode),
            onDone: (index) => {
              suiteAfterDone = index;
            },
          });
          this.suiteHooksFailed += outcome.failed;
        } catch (e) {
          this.suiteHooksFailed += 1;
          this.note("warn", `suite after hooks: ${(e as Error).message}`);
        }
        suiteAfterFinished = true;
      }
      untrackSuiteSignal?.();
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

    // F8: a critical teardown that failed is exit 8, the `finally` belts
    // run, and the clean-machine check may turn the exit into 9. The lock is
    // released last, before the journal settles.
    const specsExitCode = exitCode;
    const settledPolicy = await this.settlePolicy(
      exitCode,
      svcHandle?.criticalTeardownFailures?.() ?? [],
    );
    exitCode = settledPolicy.exitCode;
    this.policy?.releaseLock();

    // Persist the batch summary (stdout only had it until now) and settle.
    if (journal) {
      this.emitSuiteFinished(exitCode);
      const invocationError = [
        ...(beforeHookError !== undefined ? [beforeHookError] : []),
        ...settledPolicy.errors,
      ].join("; ");
      const summary = buildInvocationSummary(summaryRows, {
        exitCode,
        durationMs: Date.now() - invocationStartedAtMs,
        multiRun,
        ...(invocationError ? { error: invocationError } : {}),
        skipped: this.skippedSpecs.length,
        ...this.policySummary(),
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
    untrackHeldDocuments?.();

    // Held documents: now that the verdict is in, hand them over with the
    // invocation's exit code (and why it differs from the specs' own).
    const settledOutcome = this.holdDocuments
      ? this.invocationOutcome(
          specsExitCode,
          exitCode,
          settledPolicy.errors,
          lifecycleCtx.redactor,
        )
      : undefined;
    const settled = new Map<RunDocument, RunDocument>();
    if (settledOutcome) {
      for (const held of this.heldDocuments) {
        const document = withInvocationOutcome(held.document, settledOutcome);
        settled.set(held.document, document);
        await this.io.onDocument?.(document, held.meta);
      }
      this.heldDocuments.length = 0;
    }
    const finalDocuments = documents.map(
      (doc) =>
        settled.get(doc) ??
        (settledOutcome ? withInvocationOutcome(doc, settledOutcome) : doc),
    );

    if (beforeHookError !== undefined) {
      // A critical teardown failure or a dirty machine outranks the hook.
      return this.fail(
        [beforeHookError, ...settledPolicy.errors].join("; "),
        exitCode === 8 || exitCode === 9 ? exitCode : 2,
        { documents: finalDocuments },
      );
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
          summary: batchSummary(results, this.skippedSpecs.length),
          results,
          ...(this.skippedSpecs.length > 0
            ? { skipped: [...this.skippedSpecs] }
            : {}),
          exitCode,
          ...(settledOutcome ? { invocationOutcome: settledOutcome } : {}),
        },
        documents: finalDocuments,
        exitCode,
      };
    }
    const document = finalDocuments[0];
    if (!document) {
      return {
        ...this.base(),
        kind: "errored",
        error:
          crash ??
          (this.aborted
            ? CANCELLED_BEFORE_SPECS
            : "the run produced no result"),
        documents: finalDocuments,
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
      documents: finalDocuments,
      exitCode,
    };
  }

  /**
   * The signal path: the documents still held (the iterations that finished
   * before SIGINT / SIGTERM) are handed over now, synchronously, with
   * `invocationOutcome.exitCode` 130 / 143 — cairn exits before the verdict
   * they waited for. `onDocumentSync` when the host has one (the CLI writes
   * stdout synchronously), else a fire-and-forget `onDocument`.
   */
  private flushHeldDocumentsSync(signal: SignalName): void {
    const held = this.heldDocuments.splice(0);
    if (held.length === 0) return;
    const specsExitCode = held.reduce<ExitCode>(
      (code, entry, index) =>
        mergeExitCodes(code, entry.document.exitCode, index === 0),
      0,
    );
    const runPolicy = summarizeRunPolicy(this.policy, this.criticalFailures);
    const outcome: InvocationOutcome = {
      exitCode: signalExitCode(signal),
      specsExitCode,
      error: `interrupted by ${signal} before the invocation settled`,
      ...(runPolicy ? { runPolicy } : {}),
    };
    for (const entry of held) {
      const document = withInvocationOutcome(entry.document, outcome);
      try {
        if (this.io.onDocumentSync) {
          this.io.onDocumentSync(document, entry.meta);
        } else {
          void Promise.resolve(
            this.io.onDocument?.(document, entry.meta),
          ).catch(() => undefined);
        }
      } catch {
        // The process is exiting; a document that cannot be written is lost.
      }
    }
  }

  /** `invocationOutcome` of the documents of a held invocation. */
  private invocationOutcome(
    specsExitCode: ExitCode,
    exitCode: ExitCode,
    errors: readonly string[],
    redactor: { text: (input: string) => string },
  ): InvocationOutcome {
    const runPolicy = summarizeRunPolicy(this.policy, this.criticalFailures);
    return {
      exitCode,
      specsExitCode,
      ...(errors.length > 0 ? { error: redactor.text(errors.join("; ")) } : {}),
      ...(runPolicy ? { runPolicy } : {}),
    };
  }

  /**
   * `error` for a settled document whose post-run step failed (could not
   * stamp, could not write JUnit): the document alone reads as passed.
   */
  private postRunError(): { error?: string } {
    const errors = [...this.policyErrors, ...this.postRunErrors];
    return errors.length > 0 ? { error: errors.join("; ") } : {};
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
  private async withPolicySkips(selection: SelectionResult): Promise<{
    selection: SelectionResult;
    refusals: ReadonlyMap<string, RefusedSpec>;
  }> {
    const refusals = await evaluateSpecPolicies(
      selection.selected.map((s) => s.path),
      this.opts,
      this.request.callerEnv ??
        (process.env as Record<string, string | undefined>),
      this.cwd,
    );
    if (refusals.size === 0) return { selection, refusals };
    return {
      refusals,
      selection: {
        ...selection,
        selected: selection.selected.filter((s) => !refusals.has(s.path)),
        skipped: [
          ...selection.skipped,
          ...selection.selected.flatMap((s) => {
            const refused = refusals.get(s.path);
            return refused
              ? [
                  {
                    name: s.name,
                    path: s.path,
                    reason: describeRefusal(refused),
                  },
                ]
              : [];
          }),
        ],
      },
    };
  }

  /* ----- delegated runner (environments.<n>.runner) ----- */

  /**
   * What a delegated invocation would spawn (`--services-dry-run`,
   * `--select-only`): the runner argv and the request, masked. A runner
   * reference that does not resolve yet (a secret the dry run never read)
   * shows unresolved, with a warning.
   */
  private async delegatePlanFor(
    target: DelegationTarget,
    /** Every spec of the invocation, refused ones included. */
    specs: readonly string[],
    refusals: ReadonlyMap<string, RefusedSpec>,
    iterations: readonly RunIteration[],
    multiRun: boolean,
    env: Record<string, string | undefined>,
  ): Promise<DelegatePlan> {
    const redactor = createLiveArtifactRedactor(undefined, env);
    let spawn: RunnerSpawnSpec;
    try {
      spawn = resolveRunnerSpawn(target, env, redactor);
    } catch (e) {
      this.note(
        "warn",
        `environments.${target.envName}.runner: ${(e as Error).message} (the plan shows the unresolved command)`,
      );
      spawn = {
        command: [...target.runner.command],
        displayCommand: [...target.runner.command],
        cwd: target.runner.cwd
          ? resolve(target.configDir, target.runner.cwd)
          : target.configDir,
        env: {},
        envNames: Object.keys(target.runner.env ?? {}).toSorted(),
        ...(target.runner.timeoutMs !== undefined
          ? { timeoutMs: target.runner.timeoutMs }
          : {}),
        ...(target.runner.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: target.runner.idleTimeoutMs }
          : {}),
        cancelGraceMs: target.runner.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      };
    }
    const artifactRoot = await resolveBatchArtifactRoot(
      specs[0] ?? target.configPath,
      this.opts,
      this.cwd,
    );
    const planned = planInvocationRuns(specs, iterations, multiRun);
    const request = buildDelegateRequest({
      invocationId: this.id,
      target,
      ...(this.suite ? { suite: this.suite.resolved.name } : {}),
      specs: specs.filter((spec) => !refusals.has(spec)),
      planned,
      refused: refusedPlanEntries(planned, refusals),
      rawOptions: this.request.options,
      resolvedOptions: this.opts,
      artifactRoot,
      journalDir: journalDirOf(artifactRoot, this.id),
      eventsPath: "<CAIRN_DELEGATE_EVENTS: a temporary file cairn creates>",
      spawn,
    });
    return buildDelegatePlan(target, spawn, request, redactor);
  }

  /** The plan text on stderr (the dry-run sink); returns it. */
  private printDelegatePlan(plan: DelegatePlan): string {
    const text = renderDelegatePlan(plan);
    if (this.narration.servicesPlan) this.narration.servicesPlan(text);
    else this.runLog.info(text.trimEnd());
    return text;
  }

  /** Local-only features a delegated invocation does not run, said once. */
  private noteDelegatedScope(target: DelegationTarget): void {
    const suite = this.suite?.resolved;
    if (suite && (suite.before.length > 0 || suite.after.length > 0)) {
      this.note(
        "info",
        `suite ${suite.name}: its before/after hooks run with the remote invocation, not locally (environment "${target.envName}" has a runner)`,
      );
    }
    if ((this.opts.before?.length ?? 0) + (this.opts.after?.length ?? 0) > 0) {
      this.note(
        "info",
        "--before/--after hooks do not run locally for a delegated environment: the runner gets them in its request (options.before / options.after)",
      );
    }
    if (this.opts.stampIfGreen || this.opts.autoAnnotate) {
      this.note(
        "warn",
        "--stamp-if-green / --auto-annotate are not applied to a delegated invocation (its runs execute elsewhere)",
      );
    }
  }

  /**
   * `environments.<n>.runner`: the run policy's lock (that environment's
   * own) and preflight run here, then the runner executes the invocation
   * elsewhere while this process relays its events stream into the
   * journal, maps its runs onto the plan, and — once it exited — verifies
   * the run directories it placed, settles the exit code, runs
   * `run.finally` and hands over the result documents read from those run
   * directories. No services, webServer, browser, suite hooks, metrics or
   * verifyClean run locally.
   */
  private async runDelegated(input: {
    target: DelegationTarget;
    journal: InvocationJournal | undefined;
    untrackJournal: (() => void) | undefined;
    runnable: string[];
    refusals: ReadonlyMap<string, RefusedSpec>;
    scopedSecrets: ScopedSecrets;
    lifecycleCtx: {
      specs: readonly string[];
      refusals: ReadonlyMap<string, RefusedSpec>;
      parallel: number;
      environment?: string;
      redactor: ArtifactRedactor;
    };
    iterations: readonly RunIteration[];
    multiRun: boolean;
    parallel: number;
    startedAtMs: number;
    firstSpec: string;
  }): Promise<RunInvocationResult> {
    const { opts, cwd } = this;
    const { target, journal, scopedSecrets } = input;
    if (!journal) {
      input.untrackJournal?.();
      return this.fail(
        `the invocation journal could not be written under ${this.artifactRoot ?? "the artifact root"}: a delegated invocation needs it (the runner's run directories go there too)`,
        2,
      );
    }
    // The signal path cancels (and waits for) the runner before the journal
    // is marked aborted, so the journal stays live while the runner stops.
    input.untrackJournal?.();
    let onSignal: ((signal: SignalName) => void) | undefined;
    let interruptedBy: SignalName | undefined;
    const untrackSignal = this.resources.trackReporter((signal) => {
      interruptedBy = signal;
      try {
        onSignal?.(signal);
      } finally {
        journal.abortSync(signal);
      }
    });
    this.noteDelegatedScope(target);
    const labels = parseLabelFlags(opts.label);
    const backend: Backend = opts.mock
      ? "mock"
      : (opts.backend ?? "agent-browser");
    const planned = journal.snapshot.planned;
    const refused: RunResult[] = [];
    for (const entry of planned) {
      const refusal = input.refusals.get(entry.spec);
      if (!refusal) continue;
      journalRefused(journal, refusal, entry.index);
      refused.push(synthesizeRefusedResult(refusal, { labels, backend }, cwd));
    }
    const settleBase = {
      journal,
      untrackSignal,
      startedAtMs: input.startedAtMs,
      multiRun: input.multiRun,
      parallel: input.parallel,
      planned,
      redactor: input.lifecycleCtx.redactor,
    };
    // Every spec refused by the environment policy: nothing to delegate.
    if (input.runnable.length === 0) {
      return this.settleDelegated({
        ...settleBase,
        results: refused,
        exitCode: 7,
        specsExitCode: 7,
        errors: [],
      });
    }
    const refusal = await this.startRunPolicy(
      input.runnable,
      scopedSecrets,
      input.lifecycleCtx.redactor,
      { env: target.envName },
    );
    if (refusal) {
      untrackSignal();
      return this.lifecycleFailure(refusal, 4, input.lifecycleCtx);
    }
    const hookContext = await resolveHookContext(
      input.firstSpec,
      opts,
      scopedSecrets,
      cwd,
    );
    // A cancel before the runner exists spawns nothing. From here to the
    // spawn nothing awaits, so a later cancel reaches the session.
    if (this.aborted) {
      untrackSignal();
      await this.settlePolicy(2, []);
      return this.fail(CANCELLED_BEFORE_SPECS, 2);
    }
    let spawn: RunnerSpawnSpec;
    try {
      spawn = resolveRunnerSpawn(
        target,
        scopedSecrets.env,
        input.lifecycleCtx.redactor,
      );
    } catch (e) {
      untrackSignal();
      await this.settlePolicy(4, []);
      return this.lifecycleFailure(
        `environments.${target.envName}.runner: ${(e as Error).message}`,
        4,
        input.lifecycleCtx,
      );
    }
    const artifactRoot = this.artifactRoot!;
    const total = planned.length;
    const refusedEntries = refusedPlanEntries(planned, input.refusals);
    const refusedIndexes = new Set(refusedEntries.map((entry) => entry.index));
    const mode: SpecRunContext["mode"] =
      total === 1 && input.parallel === 1 ? "single" : "batch";
    const specContext = (run: RelayedRun): SpecRunContext => ({
      mode,
      specPath: run.spec,
      idx: Math.max(0, run.index - 1),
      total,
      parallel: input.parallel,
      iteration: 1,
      planIndex: run.index,
      plannedTotal: total,
    });
    const session = new DelegateSession({
      invocationId: this.id,
      journal,
      artifactRoot,
      planned,
      refusedIndexes,
      configDir: target.configDir,
      spawn,
      request: ({ eventsPath }) =>
        buildDelegateRequest({
          invocationId: this.id,
          target,
          ...(this.suite ? { suite: this.suite.resolved.name } : {}),
          specs: input.runnable,
          planned,
          refused: refusedEntries,
          rawOptions: this.request.options,
          resolvedOptions: opts,
          artifactRoot,
          journalDir: journal.dir,
          eventsPath,
          spawn,
        }),
      redactor: input.lifecycleCtx.redactor,
      childEnv: targetChildEnvWithSelectedTvaultKeys(
        scopedSecrets.childEnv,
        scopedSecrets.selectedKeys ?? [],
      ),
      context: hookContext,
      hooks: {
        note: (kind, message) => this.note(kind, message),
        signalNote: (message) => this.signalNote(message),
        onRunStarted: (run) => {
          journal.narrate(
            `[${run.index}/${total}] ${run.spec} — starting… (delegated)`,
          );
          this.narration.specStart?.(specContext(run));
        },
        onRunFinished: (run) => {
          const result = run.synthetic ? undefined : readSettledRun(run.runDir);
          this.narration.delegatedRunFinish?.({
            ...specContext(run),
            status: run.status ?? "errored",
            runId: run.runId,
            ...(run.durationMs !== undefined
              ? { durationMs: run.durationMs }
              : {}),
            ...(result ? { result: { ...result, runDir: run.runDir } } : {}),
          });
          journal.narrate(
            `${completionMark(run.status ?? "errored", false)} [${run.index}/${total}] ${basename(run.spec)} ${run.status ?? "errored"}${
              run.durationMs !== undefined
                ? ` (${formatMs(run.durationMs)})`
                : ""
            }${run.synthetic ? " (no run directory)" : ` ${run.runDir}`}`,
          );
        },
        onProgress: (message) => this.note("info", `runner: ${message}`),
        onDiagnostic: (diagnostic) =>
          this.note(
            "warn",
            `delegated runner ${diagnostic.code}: ${diagnostic.message}`,
          ),
        onOutputLine: (line) => this.logger.scope("runner").debug(line),
      },
    });
    this.delegateSession = session;
    const verdictInput = (settled: {
      exit: DelegateSettled["exit"];
      cancelled: boolean;
      timedOut: boolean;
      idle: boolean;
      verification: DelegateSettled["verification"];
    }) =>
      delegateVerdict({
        exit: settled.exit,
        cancelled: settled.cancelled,
        timedOut: settled.timedOut,
        idle: settled.idle,
        runs: session.relay.runList(),
        planned: Math.max(0, total - refusedIndexes.size),
        verification: {
          missing: settled.verification.missing.length,
          unfinished: settled.verification.unfinished.length,
          foreign: settled.verification.foreign.length,
          unsettled: settled.verification.unsettled.length,
        },
        diagnostics: session.relay.diagnostics,
        ...(session.relay.remoteStatus || session.relay.remoteSummary
          ? {
              remote: {
                ...(session.relay.remoteStatus
                  ? { status: session.relay.remoteStatus }
                  : {}),
                ...(session.relay.remoteSummary
                  ? { summary: session.relay.remoteSummary }
                  : {}),
              },
            }
          : {}),
        ...(spawn.timeoutMs !== undefined
          ? { timeoutMs: spawn.timeoutMs }
          : {}),
        ...(spawn.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: spawn.idleTimeoutMs }
          : {}),
      });
    const outcomeDelegate = (
      exit: DelegateSettled["exit"],
    ): NonNullable<InvocationOutcome["delegate"]> => ({
      contract: DELEGATE_CONTRACT,
      ...(session.relay.remoteInvocationId
        ? { remoteInvocationId: session.relay.remoteInvocationId }
        : {}),
      ...(exit.exitCode !== undefined ? { runnerExitCode: exit.exitCode } : {}),
      ...(exit.signal ? { runnerSignal: exit.signal } : {}),
      diagnostics: session.relay.diagnostics.length,
    });
    // SIGINT / SIGTERM: cancel the runner synchronously (the relay keeps
    // going while it stops), then hand over the documents of the runs it
    // reported, with invocationOutcome.exitCode 130 / 143.
    onSignal = (signal) => {
      session.cancelSync(signal);
      const verdict = verdictInput({
        exit: {},
        cancelled: true,
        timedOut: false,
        idle: false,
        verification: session.relay.verify(),
      });
      const results = delegatedResults({
        runs: session.relay.runList(),
        refused,
        specs: input.runnable,
        exitCode: signalExitCode(signal),
        cancelled: true,
        labels,
        backend,
        environment: target.envName,
        cwd,
      });
      const document = this.delegatedDocument(results, {
        exitCode: signalExitCode(signal),
        specsExitCode: verdict.specsExitCode,
        error: `interrupted by ${signal}: the delegated runner was cancelled`,
        delegate: outcomeDelegate({}),
        planned,
        parallel: input.parallel,
        multiRun: input.multiRun,
        durationMs: Date.now() - input.startedAtMs,
      });
      try {
        if (this.io.onDocumentSync) {
          this.io.onDocumentSync(document.document, document.meta);
        } else {
          void Promise.resolve(
            this.io.onDocument?.(document.document, document.meta),
          ).catch(() => undefined);
        }
      } catch {
        // The process is exiting; a document that cannot be written is lost.
      }
    };
    this.narration.specsStart?.({ mode, total, parallel: input.parallel });
    let settled: DelegateSettled;
    try {
      settled = await session.run();
    } finally {
      session.cleanup();
    }
    if (settled.terminated) {
      // The signal path already settled the journal and the documents.
      untrackSignal();
      return {
        ...this.base(),
        aborted: true,
        kind: "errored",
        error: `the delegated invocation was interrupted by ${interruptedBy ?? "a signal"}`,
        documents: [],
        exitCode: signalExitCode(interruptedBy ?? "SIGINT"),
      };
    }
    const verdict = verdictInput(settled);
    for (const diagnostic of verdict.diagnostics) {
      session.relay.diagnose(diagnostic);
    }
    journal.setDelegate({
      diagnostics: session.relay.diagnostics.length,
      ...(settled.cancelled ? { cancelled: true as const } : {}),
      ...(settled.timedOut ? { timedOut: true as const } : {}),
      ...(settled.idle ? { idle: true as const } : {}),
    });
    let exitCode = verdict.exitCode;
    const errors = [...verdict.errors];
    // --strict-requires: a refused spec fails an otherwise green invocation.
    if (exitCode === 0 && opts.strictRequires && refused.length > 0) {
      exitCode = 7;
      errors.push(
        `--strict-requires: ${refused.length} spec(s) refused by the environment policy`,
      );
    }
    const results = delegatedResults({
      runs: session.relay.runList(),
      refused,
      specs: input.runnable,
      exitCode,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
      cancelled: settled.cancelled,
      labels,
      backend,
      environment: target.envName,
      cwd,
    });
    return this.settleDelegated({
      ...settleBase,
      results,
      exitCode,
      specsExitCode: verdict.specsExitCode,
      errors,
      delegate: outcomeDelegate(settled.exit),
      ...(session.relay.remoteSummary
        ? { remoteSummary: session.relay.remoteSummary }
        : {}),
    });
  }

  /** The single RunResult or the BatchRunResult of a delegated invocation. */
  private delegatedDocument(
    results: RunResult[],
    input: {
      exitCode: DelegatedExitCode;
      specsExitCode: ExitCode;
      error?: string;
      delegate?: NonNullable<InvocationOutcome["delegate"]>;
      planned: readonly InvocationPlannedRun[];
      parallel: number;
      multiRun: boolean;
      durationMs: number;
    },
  ): { document: RunDocument; meta: RunDocumentMeta } {
    const runPolicy = summarizeRunPolicy(this.policy, this.criticalFailures);
    const outcome: InvocationOutcome = {
      exitCode: input.exitCode,
      specsExitCode: input.specsExitCode,
      ...(input.error ? { error: input.error } : {}),
      ...(runPolicy ? { runPolicy } : {}),
      ...(input.delegate ? { delegate: input.delegate } : {}),
    };
    const single =
      input.planned.length === 1 &&
      input.parallel === 1 &&
      !input.multiRun &&
      results.length === 1;
    const raw: RunDocument = single
      ? results[0]!
      : {
          $schema: "urn:cairntrace.dev:run-batch:v1",
          version: "1",
          parallel: input.parallel,
          totalDurationMs: Math.max(0, input.durationMs),
          summary: batchSummary(results),
          results,
          exitCode:
            input.exitCode === 130 || input.exitCode === 143
              ? input.specsExitCode
              : input.exitCode,
        };
    return {
      document: withDelegatedOutcome(raw, outcome),
      meta: { kind: single ? "single" : "batch", iteration: 1 },
    };
  }

  /**
   * After the runner (or with nothing to delegate): JUnit, the batch
   * narration, `run.finally`, the lock, the journal summary and the result
   * document, in that order.
   */
  private async settleDelegated(input: {
    journal: InvocationJournal;
    untrackSignal: () => void;
    results: RunResult[];
    exitCode: DelegatedExitCode;
    specsExitCode: ExitCode;
    errors: string[];
    delegate?: NonNullable<InvocationOutcome["delegate"]>;
    remoteSummary?: InvocationSummary;
    startedAtMs: number;
    multiRun: boolean;
    parallel: number;
    planned: readonly InvocationPlannedRun[];
    redactor: ArtifactRedactor;
  }): Promise<RunInvocationResult> {
    const { opts, cwd } = this;
    const { journal, results, exitCode } = input;
    await writeJUnitIfRequested(opts, results, this.runLog, cwd);
    const summary = batchSummary(results);
    const durationMs = Math.max(0, Date.now() - input.startedAtMs);
    this.narration.batchEnd?.({ ...summary, durationMs });
    if (this.policy) await this.policy.runFinally(exitCode);
    this.policy?.releaseLock();
    this.emitSuiteFinished(exitCode);
    const error =
      input.errors.length > 0
        ? input.redactor.text(input.errors.join("; "))
        : undefined;
    const remote = input.remoteSummary;
    const status =
      this.aborted || exitCode === 130 || exitCode === 143
        ? "aborted"
        : exitCode === 0
          ? "passed"
          : exitCode === 1 || exitCode === 7
            ? "failed"
            : "errored";
    journal.narrate(
      `finished: ${status}, ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored${
        summary.refused ? `, ${summary.refused} refused` : ""
      } in ${formatMs(durationMs)} (exit ${exitCode}, delegated)`,
    );
    journal.finish(status, {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      errored: summary.errored,
      ...(summary.refused ? { refused: summary.refused } : {}),
      ...(remote?.skipped ? { skipped: remote.skipped } : {}),
      durationMs,
      exitCode,
      ...(input.multiRun && remote?.iterations
        ? { iterations: remote.iterations }
        : {}),
      ...(error ? { error } : {}),
      ...this.policySummary(),
    });
    input.untrackSignal();
    this.activeJournal = undefined;
    const { document, meta } = this.delegatedDocument(results, {
      exitCode,
      specsExitCode: input.specsExitCode,
      ...(error ? { error } : {}),
      ...(input.delegate ? { delegate: input.delegate } : {}),
      planned: input.planned,
      parallel: input.parallel,
      multiRun: input.multiRun,
      durationMs,
    });
    await this.io.onDocument?.(document, meta);
    return {
      ...this.base(),
      ...(error ? { error } : this.postRunError()),
      ...(exitCode === 130 || exitCode === 143 ? { aborted: true } : {}),
      kind: meta.kind === "single" ? "single" : "batch",
      document,
      documents: [document],
      exitCode,
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
      await this.emitDocument(result, {
        kind: "single",
        iteration: inputs.index,
      });
      return { exitCode: 7, document: result };
    }
    const { backend, untrack, real, finishLedger } = this.createTrackedBackend({
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
    const runToken = opts.runToken ?? generateRunToken();
    const specMetrics = this.metrics?.forSpec(scopedSecrets, runToken);
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
      await specMetrics?.start();
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
      // One spec per iteration: a failure still ends --bail's later iterations.
      this.tripBail(opts, specPath, result);
      if (invocation)
        journalRunFinished(invocation, planIndex, specPath, result);
      await specMetrics?.finish(result);
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
      // After the hooks: a collector that rewrote diagnostics/report.json is
      // merged into, never overwritten.
      await specMetrics?.mergeReport();
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

      await this.emitDocument(result, {
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
      if (result.status !== "refused") this.tripBail(opts, specPath, result);
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
      await this.emitDocument(result, {
        kind: "single",
        iteration: inputs.index,
        errored: true,
      });
      return { exitCode, document: result };
    } finally {
      untrackSignalArtifactReporter?.();
      await specMetrics?.dispose();
      untrack();
      await this.closeBackend(backend, real);
      finishLedger();
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
    // --bail: specs that never started because an earlier one did not pass.
    const bailed: Array<{ idx: number; spec: string }> = [];
    try {
      const pooled = await runPool<string, RunResult | undefined>(
        specs,
        parallel,
        async (specPath, idx, workerIndex) => {
          if (opts.bail && this.bailState.tripped) {
            bailed.push({ idx, spec: specPath });
            return undefined;
          }
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
          const { backend, untrack, real, finishLedger } =
            this.createTrackedBackend({
              ...backendOpts(opts, inputs.browser),
              session: `${this.sessionRoot}-w${workerIndex}-s${idx}`,
            });
          const specListener = this.specListener(ctx);
          const runToken = opts.runToken ?? generateRunToken();
          const specMetrics = this.metrics?.forSpec(scopedSecrets, runToken);
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
            await specMetrics?.start();
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
            this.tripBail(opts, specPath, r);
            if (invocation)
              journalRunFinished(invocation, planIndex, specPath, r);
            await specMetrics?.finish(r);
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
            await specMetrics?.mergeReport();
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
            if (!refusal) this.tripBail(opts, specPath, errored);
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
            await specMetrics?.dispose();
            untrack();
            await this.closeBackend(backend, real);
            finishLedger();
          }
        },
      );
      results = pooled.filter(
        (result): result is RunResult => result !== undefined,
      );
    } catch (error) {
      untrackAbortReporter();
      throw error;
    }
    const skipped: BatchSkippedSpec[] = bailed
      .toSorted((a, b) => a.idx - b.idx)
      .map(({ spec }) => ({
        spec,
        reason: "bailed" as const,
        bailedBy: this.bailState.trigger?.spec ?? "an earlier spec",
      }));
    if (skipped.length > 0) {
      this.skippedSpecs.push(...skipped);
      this.note(
        "warn",
        `--bail: skipped ${skipped.length} spec(s) after ${this.bailState.trigger?.spec ?? "a failure"}: ${skipped
          .map((entry) => basename(entry.spec))
          .join(", ")}`,
      );
      invocation?.journal.appendEvent({
        ts: new Date().toISOString(),
        type: "invocation.bailed",
        spec: this.bailState.trigger?.spec ?? "unknown",
        exitCode: this.bailState.trigger?.exitCode ?? 1,
        skipped: skipped.length,
      });
    }

    // Keep the signal-time reporter registered through stamping, JUnit, and
    // the document hand-off (stdout drain in the CLI). A signal in this final
    // window must still preserve a durable batch summary.
    try {
      const totalDurationMs = Date.now() - tStart;
      const summary = batchSummary(results, skipped.length);
      // --bail only skips what had not started: the exit code follows the
      // usual precedence over the specs that ran (a spec that failed while
      // the bailing one errored still makes it 1, as without --bail).
      const exitCode = batchExitCode(results, opts.strictRequires);

      this.narration.batchEnd?.({ ...summary, durationMs: totalDurationMs });

      const batch: BatchRunResult = {
        $schema: "urn:cairntrace.dev:run-batch:v1",
        version: "1",
        parallel,
        totalDurationMs,
        summary,
        results,
        ...(skipped.length > 0 ? { skipped } : {}),
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
      await this.emitDocument(batch, {
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

/**
 * A document with the invocation's settled verdict: the top-level
 * `exitCode` becomes the invocation's when the lifecycle changed it (8 / 9
 * outrank the specs' own code), and a RunResult whose spec passed reads
 * `errored` with the reason as `failure` (`invocationOutcome.specsExitCode`
 * keeps what the spec alone did; run.json on disk is never rewritten). A
 * signal's 130 / 143 changes nothing but `invocationOutcome`.
 */
export function withInvocationOutcome(
  document: RunDocument,
  outcome: InvocationOutcome,
): RunDocument {
  const lifecycleCode =
    outcome.exitCode === 8 || outcome.exitCode === 9
      ? outcome.exitCode
      : undefined;
  if (document.$schema === "urn:cairntrace.dev:run-batch:v1") {
    return {
      ...document,
      ...(lifecycleCode !== undefined && document.exitCode !== lifecycleCode
        ? { exitCode: lifecycleCode }
        : {}),
      invocationOutcome: outcome,
    };
  }
  const run = document as RunResult;
  if (lifecycleCode === undefined || run.exitCode === lifecycleCode) {
    return { ...run, invocationOutcome: outcome };
  }
  const message =
    outcome.error ??
    (lifecycleCode === 8
      ? "a critical teardown failed"
      : "the machine is not clean after the run");
  const passed = run.status === "passed";
  const next: RunResult = {
    ...run,
    exitCode: lifecycleCode,
    invocationOutcome: outcome,
    ...(passed
      ? {
          status: "errored" as const,
          summary: `the spec passed, then the invocation failed (exit ${lifecycleCode}): ${message}`,
          failure: { phase: "invocation", message },
        }
      : {}),
  };
  return passed && run.nextActions !== undefined
    ? { ...next, nextActions: buildRunNextActions(next) }
    : next;
}

/** BatchRunResult summary; `refused` only when a spec was refused. */
function batchSummary(
  results: readonly RunResult[],
  skipped = 0,
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
    ...(skipped > 0 ? { skipped } : {}),
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
