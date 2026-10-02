import { homedir } from "node:os";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ArtifactRef,
  BrowserBackend,
  ConsoleEntry,
  NetworkEntry,
  ResolvedElement,
} from "../../adapters/browserBackend";
import { runBoundedCommand } from "./boundedCommand";
import {
  ArtifactWriter,
  type ArtifactRedactor,
} from "../artifacts/ArtifactWriter";
import {
  addEnospcHint,
  pruneRuns,
  DEFAULT_KEEP_RUNS,
  DEFAULT_KEEP_FAILED_RUNS,
  evidenceFailureReason,
  pathFreeMessage,
  type PruneResult,
  type RetentionArchiveOutcome,
  type RetentionEvidencePolicy,
  type RetentionPublishOutcome,
} from "../artifacts/retention";
import {
  checkStoppedTrace,
  DEFAULT_TRACE_MAX_BYTES,
  sanitizeKeptTrace,
  tracePathForBackend,
} from "../artifacts/traceCapture";
import {
  createLiveArtifactRedactor,
  registerSecretValues,
} from "../artifacts/redaction";
import { LiveLog, logIndex, logSlug } from "../artifacts/liveLog";
import { combineListeners, makePlainNarration } from "../artifacts/narration";
import { PhaseTracker } from "../artifacts/phaseTracker";
import {
  CAIRN_PROGRESS_FILE_ENV,
  ProgressFiles,
  ProgressTail,
} from "../artifacts/progressChannel";
import { describeStep, withoutQuery } from "../artifacts/stepLabel";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { resolveSpecRuntimeContext } from "../config/runtimeContext";
import { evaluateEnvPolicy, refusalDocument } from "../envPolicy";
import {
  cairnContextEnv,
  targetChildEnvWithSelectedTvaultKeys,
} from "../processEnv";
import { parseSpec } from "../parser/parseSpec";
import { computeContractHash } from "../contractHash";
import { evaluateWhen } from "./conditions";
import {
  cutClipsWithVidtrace,
  isVidtraceAvailable,
  moveClipsIntoRunDir,
  clipPointsToLabels,
} from "../clip/vidtraceClip";
import type { ExitCode } from "../schema/shared";
import {
  openPath,
  teardownPlan,
  type EvalStep,
  type Locator,
  type MonitorStep,
  type RequestStep,
  type Spec,
  type Step,
  type TransformStep,
} from "../schema/spec.v1";
import type {
  MonitorTargetConfig,
  RetentionConfig,
  StashConfig,
} from "../schema/config.v1";
import type {
  OutcomeResult,
  RunArtifacts,
  RunFailure,
  RunInvocationRef,
  RunRefusal,
  RunResult,
  StepResult,
} from "../schema/run.v1";
import {
  PRECONDITION_OUTPUT_TAIL_CHARS,
  type RunEvent,
} from "../schema/events.v1";
import {
  isScriptVerifier,
  verifierKind,
  type Verifier,
} from "../schema/verifier.v1";
import type { BriefStep } from "../schema/brief.v1";
import {
  isInteractiveLocatorStep,
  isLocatorMissError,
  replaceStepLocator,
} from "../accompany/replaceStepLocator";
import { buildReplayManifest } from "../schema/replay.v1";
import type { Outcome } from "../schema/spec.v1";
import { CAIRN_VERSION } from "../../cli/version";
import { type EvaluatedOutcome, evaluateOutcomes } from "./OutcomeEvaluator";
import { runNodeScript } from "./nodeScripts";
import {
  deepMapStrings,
  resolveArtifactPlaceholders,
  resolveEvalPlaceholders,
  resolveFixtureMap,
  resolveResponsePlaceholders,
  resolveRuntimeFilePath,
} from "./runtimePlaceholders";
import {
  briefStepFromSpecStep,
  isBriefableStep,
  redactBriefStep,
} from "../exporters/briefExporter";
import { generateRunId } from "./runId";
import {
  gateFailureMessage,
  GateReferenceError,
  waitForGate,
  assertGateRefs,
  type GateContext,
} from "../gates/evaluate";
import { gateRefList } from "../gates/schema";
import {
  executeRunStep,
  resolveRunPlaceholders,
  runStepLabel,
} from "./runStep";
import {
  armSignalTeardown,
  createTeardownClaims,
  runTeardown,
  type TeardownItemResult,
  type TeardownRunStatus,
  type TeardownSummary,
} from "./teardown";
import {
  resolveEvalHostFile,
  resolveScopedEvalHostFile,
  resolveStepFile,
  specFileScope,
  type StepFileScope,
  stepFileScopeAt,
} from "./stepFiles";
import {
  applyWaitScale,
  resolveWaitScale,
  runResilientBrowserStep,
} from "./interactionResilience";
import { isRelativeUrl, joinUrl, resolveUrl } from "./url";
import type { VerifierEvaluation } from "./verifiers/types";
import type { ScriptVerifierContext } from "./verifiers/script";
// F4/F16: datasources, ${captures.*} and expect/capture steps.
import type { CaptureStep, ExpectStep } from "../schema/spec.v1";
import { resolveEnvironmentDatasources } from "../datasources/resolve";
import {
  FixtureRuntime,
  FixtureSetupError,
  type FixtureHost,
} from "../fixtures/runtime";
import {
  fixtureNamesReferenced,
  resolveFixturePlaceholders,
  unresolvedFixtureReferences,
} from "../fixtures/template";
import { planFixtures } from "../fixtures/runtime";
import { expectLocator } from "./verifiers/expect";
import { resolveCapturePlaceholders } from "./verifiers/refs";
import { executeCaptureStep, executeExpectStep } from "./verifiers/stepChecks";
import {
  type MonitorClient,
  type ProfileType,
  defaultMonitorClient,
} from "../monitor/monitorClient";
import {
  ProcessSampler,
  type ProcessMetricsSummary,
  renderProcessMarkdown,
} from "../monitor/processSampler";
import type {
  ServicesArtifactBundle,
  ServicesRunStatus,
  ServicesRunWindow,
} from "./services";

/**
 * Optional progress callbacks the runner invokes during execution.
 * The CLI attaches a TTY-aware listener for interactive `cairn run` output;
 * tests typically omit it.
 */
export interface ProgressListener {
  onRunStart?(
    spec: Spec,
    runId: string,
    runDir: string,
    backendName: string,
    /**
     * The environment the run actually resolved to (config default, spec
     * `environment:`, or `--env` override — in that precedence). Not the
     * same as `spec.environment`: that field is only the spec's own
     * unresolved default and ignores a CLI `--env` override.
     */
    environment: string,
  ): void;
  onPreconditionStart?(name: string, timeoutMs: number): void;
  /** A line the precondition appended to its `CAIRN_PROGRESS_FILE`. */
  onPreconditionProgress?(name: string, message: string): void;
  onPreconditionFinish?(
    name: string,
    exitCode: number | undefined,
    durationMs: number,
    details?: { timedOut?: boolean; signal?: string },
  ): void;
  onStepStart?(idx: number, step: Step, stepId: string): void;
  onStepFinish?(
    idx: number,
    stepId: string,
    status: StepResult["status"],
    durationMs: number,
    error: string | undefined,
  ): void;
  onOutcomesStart?(total: number): void;
  onOutcomeStart?(outcome: Outcome): void;
  /** A line a node script verifier reported via `ctx.progress()`. */
  onOutcomeProgress?(outcome: Outcome, message: string): void;
  onOutcomeFinish?(outcome: Outcome, evaluation: VerifierEvaluation): void;
  onRunEnd?(result: RunResult): void;
  /**
   * A non-fatal authoring warning (e.g. a deprecated spec-relative path in
   * an imported action). Each distinct warning reaches this hook once per
   * process; every run also records it in its run.log.
   */
  onWarning?(message: string): void;
}

export interface RunOptions {
  specPath: string;
  backend: BrowserBackend;
  /** Defaults to ~/.cairntrace/runs */
  artifactRoot?: string;
  /** Cold-start gate from §10.6. Default false for local runs. */
  coldStart?: boolean;
  /** Override default environment from spec. */
  environmentOverride?: string;
  /** ${vars.X} substitution bag. */
  vars?: Record<string, string | number | boolean>;
  /** Override process.env. */
  env?: Record<string, string | undefined>;
  /** Environment authorized for shell target children; vault controls removed. */
  childEnv?: Record<string, string | undefined>;
  /** Explicit TinyVault names that may retain a `TVAULT_` prefix in children. */
  selectedTvaultKeys?: Iterable<string>;
  /** Literal values resolved by a scoped secret provider; artifact-only. */
  secretValues?: Iterable<string>;
  /** Inject a clock for deterministic run ids in tests. */
  now?: () => Date;
  /** Receives progress events during the run. */
  listener?: ProgressListener;
  /**
   * Called when an interactive locator step fails. Return `retry` with a new
   * locator (authored values are preserved) or `abort` to fail the step.
   * Absent on normal CLI runs.
   */
  onLocatorMiss?: (ctx: LocatorMissContext) => Promise<LocatorMissDecision>;
  /** Path to a cairntrace.config.yml. Disables auto-discovery from the spec dir. */
  configPath?: string;
  /** Worker slot for `${worker.index}`. Defaults to 0. */
  workerIndex?: number;
  /** Per-run token for `${run.token}`. Defaults to a generated token. */
  runToken?: string;
  /** Services lifecycle events to prepend to events.ndjson (from startServices). */
  servicesEvents?: Array<{
    phase: string;
    event: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }>;
  /**
   * Best-effort service-log capture supplied by the CLI-owned services
   * lifecycle. The runner writes the returned bounded bundle inside runDir.
   */
  captureServicesArtifacts?: (
    status: ServicesRunStatus,
    runWindow: ServicesRunWindow,
  ) => Promise<ServicesArtifactBundle>;
  /**
   * Opt-in process monitoring. `true` or a config object enables the
   * `--monitor` sampler: the browser process tree's CPU/RSS is sampled during
   * the run and reduced into `diagnostics/process.{md,json}. Zero-cost when
   * absent/false. Implicitly enabled when `MONITOR=1` is in the env (the run
   * was launched under `monitor run`).
   */
  monitor?: boolean | MonitorConfig;
  /** Inject a MonitorClient for tests. Defaults to the real `monitor` CLI. */
  monitorClient?: MonitorClient;
  /**
   * Best-effort archive of a pruned run dir (e.g. to fcheap) before deletion.
   * Only invoked when config `retention.archiveToStash` is true. Injected by
   * the CLI so the core runner stays free of the stash (fcheap) dependency.
   * `evidence` carries the config `stash` gate (include, TTL); a resolved
   * outcome is recorded as an `artifact.stash` archive event, a throw (an
   * EvidenceTransferError carries a reason code) keeps the run on disk.
   */
  onArchiveRun?: (
    runDir: string,
    runId: string,
    tags: string[],
    evidence?: RetentionEvidencePolicy,
  ) => Promise<void | RetentionArchiveOutcome>;
  /**
   * Explicit remote publication callback. It must validate a server-verified,
   * credential-free, byte-matching receipt before resolving; pruneRuns keeps
   * the source on any failure. `evidence.include` is
   * `retention.publish.include`.
   */
  onPublishRun?: (
    runDir: string,
    runId: string,
    tags: string[],
    retentionDays: number,
    evidence?: RetentionEvidencePolicy,
  ) => Promise<void | RetentionPublishOutcome>;
  /**
   * Free-form labels stamped into run.json (`cairn run --label key=value`).
   * Used by `cairn stats --group-by` for A/B cohorts. Optional.
   */
  labels?: Record<string, string>;
  /**
   * Raise the auto-prune keep-count to at least this many runs per spec for
   * this invocation (`cairn run --repeat/--matrix` sets it to the iteration
   * count so earlier repeats are not pruned mid-benchmark). Never lowers a
   * configured `retention.keepRuns`; ignored when retention is disabled.
   */
  minKeepRuns?: number;
  /** Internal command-level capture override (used by `cairn audit`). */
  captureOverride?: Partial<{
    screenshots: "always" | "on-failure" | "never";
    snapshots: "always" | "on-failure" | "never";
    trace: "always" | "on-failure" | "never";
    video: "always" | "on-failure" | "never";
  }>;
  /** Internal command-level video settings (used by `cairn audit`). */
  videoOptions?: { slowMo?: number; speed?: number };
  /**
   * The `cairn run` invocation this run belongs to. Stamped on the
   * `run.started` event and on run.json when present.
   */
  invocation?: RunInvocationRef;
  /**
   * Cadence of `run.heartbeat` events (default 15000ms). Internal: tests use
   * a short interval; `0` disables heartbeats.
   */
  heartbeatIntervalMs?: number;
  /**
   * Cancellation. On abort the running precondition (or node transform /
   * script verifier) has its process tree killed, the remaining
   * preconditions, steps and outcomes are skipped, and the run still writes
   * a consistent run.json: status `errored`, `failure.phase: "cancelled"`.
   * Aborted before the run directory exists, runSpec throws instead.
   */
  signal?: AbortSignal;
  /** Checkpoint store for `session.resume` (default ~/.cairntrace/checkpoints). */
  checkpointStore?: CheckpointStore;
  /**
   * Environment the policy reads `requires.env` opt-in variables from
   * (default: the run environment). `cairn run` passes the caller's.
   */
  policyEnv?: Record<string, string | undefined>;
  /**
   * F3b: let mutating fixture verbs (ensure/reset/teardown) run on an
   * environment whose policy trait is `shared` (`cairn run
   * --allow-fixture-writes`). Without it they are dry-run there unless the
   * spec's fixture reference says `write: true`.
   */
  allowFixtureWrites?: boolean;
  /**
   * The invocation's suite/seed fixture host: suite fixtures are ensured
   * once per invocation and torn down when it ends; seed fixtures once per
   * services seed. Without one they are handled by this run.
   */
  fixtureHost?: FixtureHost;
}

/** The failure message of a run its invocation cancelled. */
export const RUN_CANCELLED_MESSAGE = "cairn: invocation cancelled";

/**
 * runSpec was asked to run a spec the environment policy refuses
 * (`requires.env` / `requires.mutates` vs `environments.<name>.policy`).
 * `cairn run` filters refused specs before runSpec; other callers (heal,
 * audit) get this error before anything starts.
 */
export class SpecRefusedError extends Error {
  readonly exitCode = 7 as const;
  constructor(
    public readonly refusal: RunRefusal,
    public readonly specPath: string,
    /** The parsed spec: its name and outcome ids (reported `skipped`). */
    public readonly spec?: { name: string; outcomeIds: string[] },
  ) {
    super(
      `refused in environment "${refusal.env}": ${refusal.reason} (${specPath})`,
    );
    this.name = "SpecRefusedError";
  }
}

/**
 * runSpec's invocation was cancelled before the spec started (no run
 * directory exists yet). Callers report it as `failure.phase: "cancelled"`.
 */
export class RunCancelledError extends Error {
  constructor() {
    super(RUN_CANCELLED_MESSAGE);
    this.name = "RunCancelledError";
  }
}

export type LocatorMissDecision =
  | { action: "abort" }
  | { action: "retry"; locator: Locator };

export interface LocatorMissContext {
  step: Step;
  stepId: string;
  index: number;
  error: string;
  brief: BriefStep;
}

export interface MonitorConfig {
  /** Sampling interval in milliseconds. Default 1000. */
  intervalMs?: number;
}

/**
 * Run a behavioral spec end-to-end:
 *   parse → make run dir → execute steps (with capture) → evaluate outcomes
 *   → write evidence + run.* artifacts + agent_context.md → return RunResult.
 *
 * The runner is backend-agnostic — it talks only to the `BrowserBackend`
 * interface, so a MockBrowserBackend works for tests and `--mock` runs.
 */
export async function runSpec(opts: RunOptions): Promise<RunResult> {
  // The phase tracker owns an interval timer (run.heartbeat). Stop it on
  // every exit path — including a throw from parse, a backend, or a write —
  // so a failed run can never keep the process alive or append heartbeats
  // after the run settled.
  const lifecycle: RunLifecycle = { logs: new Set(), tails: new Set() };
  try {
    return await executeSpec(opts, lifecycle);
  } catch (error) {
    // A throw after the fixtures were set up (a writer I/O error, a
    // listener) still owes the spec teardown and the fixture teardowns.
    await lifecycle.abandon?.().catch(() => undefined);
    throw error;
  } finally {
    lifecycle.tracker?.stop();
    for (const tail of lifecycle.tails) tail.stop();
    for (const log of lifecycle.logs) log.close();
    lifecycle.progressFiles?.dispose();
    lifecycle.disarmSignalTeardown?.();
    lifecycle.disarmFixtureSignal?.();
  }
}

/** Resources a run owns that must be released on every exit path. */
interface RunLifecycle {
  tracker?: PhaseTracker;
  /** Open live logs (run.log, precondition and verifier logs). */
  logs: Set<LiveLog>;
  /** Progress-file tails of the item in flight. */
  tails: Set<ProgressTail>;
  progressFiles?: ProgressFiles;
  /** Removes the SIGINT/SIGTERM teardown handler (spec `teardown:`). */
  disarmSignalTeardown?: () => void;
  /** Removes the SIGINT/SIGTERM fixture teardown handler (F3b). */
  disarmFixtureSignal?: () => void;
  /**
   * Finally semantics on a throw out of executeSpec: the spec teardown and
   * the run's fixture teardowns, once, best effort.
   */
  abandon?: () => Promise<void>;
}

async function executeSpec(
  opts: RunOptions,
  lifecycle: RunLifecycle,
): Promise<RunResult> {
  const runEnv = targetChildEnvWithSelectedTvaultKeys(
    opts.env ?? (process.env as Record<string, string | undefined>),
    opts.selectedTvaultKeys ?? [],
  );
  const workerIndex = opts.workerIndex ?? 0;
  const runToken = opts.runToken ?? generateRunToken();
  const runtime = await resolveSpecRuntimeContext(opts.specPath, {
    ...(opts.environmentOverride !== undefined
      ? { envOverride: opts.environmentOverride }
      : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
    env: runEnv,
  });
  const resolvedVars = resolveRuntimeVars(runtime.vars, {
    workerIndex,
    runToken,
  });
  const {
    spec,
    resolved,
    path: specPath,
    origins,
    actionsByName,
  } = await parseSpec(opts.specPath, {
    env: runEnv,
    vars: resolvedVars,
    // `${config.dir}` follows the resolved config (an explicit --config
    // included), not only the one found by walking up from the spec.
    configDir: runtime.configDir,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    runtime: { workerIndex, runToken },
  });

  const env = runtime.envName;
  // Environment policy, before the run directory or anything else exists.
  // `cairn run` already filtered refused specs; this guards other callers.
  const envPolicy = runtime.config?.environments[env]?.policy;
  const policyInput = {
    ...(spec.requires ? { requires: spec.requires } : {}),
    envName: env,
    ...(envPolicy ? { policy: envPolicy } : {}),
  };
  const verdict = evaluateEnvPolicy({
    ...policyInput,
    env: opts.policyEnv ?? runEnv,
  });
  if (!verdict.allowed) {
    throw new SpecRefusedError(
      refusalDocument(verdict, policyInput),
      specPath,
      {
        name: spec.name,
        outcomeIds: spec.outcomes.map((outcome) => outcome.id),
      },
    );
  }
  // Cancelled before this spec started: no run directory.
  if (opts.signal?.aborted) throw new RunCancelledError();
  const cancelled = (): boolean => opts.signal?.aborted === true;
  const waitScale = resolveWaitScale(
    runtime.waitScale,
    runEnv["CAIRN_WAIT_SCALE"],
  );
  opts.backend.setWaitScale(waitScale);
  // The actual backend that ran is authoritative — spec.backend is only
  // advisory metadata that may not match the CLI's --backend choice.
  const backendName = opts.backend.name;
  const artifactRoot =
    opts.artifactRoot ??
    runtime.config?.artifactRoot ??
    join(homedir(), ".cairntrace", "runs");
  const now = (opts.now ?? (() => new Date()))();
  const runId = generateRunId(spec.name, now);
  const runDir = resolve(artifactRoot, runId);

  // Investigation and vidtrace enrichment happen after the core run writer
  // finishes. Register spec-declared literals process-wide so those post-run
  // text artifacts use the same redaction boundary as the main artifact pack.
  registerSecretValues(spec.redaction?.values ?? []);
  // Live: values registered later in the run (F3b secret fixture outputs,
  // login tokens, outputs under a sensitive key) are scrubbed from every
  // artifact written after they are known — steps and outcomes included.
  const redactor = createLiveArtifactRedactor(
    spec.redaction,
    runEnv,
    opts.secretValues,
  );
  const writer = new ArtifactWriter(
    runDir,
    redactor,
    runtime.config?.report ? { report: runtime.config.report } : {},
  );
  await writer.ensureDirs();
  await writer.writeResolvedSpec(resolved);

  // Prepend services lifecycle events (docker/seed/tmux/teardown) to
  // events.ndjson so post-run diagnostics show the full environment lifecycle.
  if (opts.servicesEvents && opts.servicesEvents.length > 0) {
    await writer.appendServicesEvents(opts.servicesEvents);
  }

  const startedAt = now.toISOString();
  const coldStart = opts.coldStart ?? runEnv["CI"] === "true";
  await writer.appendEvent({
    ts: startedAt,
    type: "run.started",
    runId,
    spec: spec.name,
    ...(opts.invocation ? { invocation: opts.invocation } : {}),
  });
  // run.log: the plain narration of this run, always written (whatever
  // --format/--progress the CLI uses), redacted line by line.
  const runLog = openRunLog(writer, redactor, RUN_LOG_PATH);
  lifecycle.logs.add(runLog);
  const narration = makePlainNarration({
    write: (text) => runLog.write(text),
    runEnd: true,
  });
  // Every callback except onRunEnd: run.log must be complete before the
  // manifest checksums it, while the caller's onRunEnd keeps firing after.
  const listener = combineListeners(narration, opts.listener);
  await writer.appendEvent({
    ts: new Date().toISOString(),
    type: "log.opened",
    kind: "narration",
    name: "run",
    path: RUN_LOG_PATH,
  });
  lifecycle.progressFiles = new ProgressFiles();
  const progressFiles = lifecycle.progressFiles;
  listener.onRunStart?.(spec, runId, runDir, backendName, env);
  // phase.changed + run.heartbeat (every 15s while active) for live viewers.
  const tracker = new PhaseTracker({
    append: (event) => writer.appendEvent(event),
    ...(opts.heartbeatIntervalMs !== undefined
      ? { intervalMs: opts.heartbeatIntervalMs }
      : {}),
  });
  lifecycle.tracker = tracker;
  // Non-secret context for precondition shells (and, via run.ts, hooks).
  const contextEnv = cairnContextEnv({
    environment: env,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    runToken,
    runId,
    runDir,
    ...(runtime.configPath ? { configDir: dirname(runtime.configPath) } : {}),
  });

  function createRunFixtures(): FixtureRuntime | undefined {
    const refs = spec.fixtures ?? [];
    if (refs.length === 0) return undefined;
    const runtimeFixtures = new FixtureRuntime({
      project: runtime.config?.project ?? "cairntrace",
      envName: env,
      registry: runtime.config?.fixtures ?? {},
      configDir: runtime.configPath
        ? dirname(runtime.configPath)
        : dirname(specPath),
      childEnv: opts.childEnv ?? runEnv,
      ...(opts.selectedTvaultKeys !== undefined
        ? { selectedTvaultKeys: opts.selectedTvaultKeys }
        : {}),
      contextEnv,
      vars: resolvedVars,
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      runToken,
      datasourceSet: resolveEnvironmentDatasources(
        runtime.config?.datasources,
        runtime.config?.environments[env]?.datasources,
      ),
      ...(envPolicy?.trait ? { policyTrait: envPolicy.trait } : {}),
      ...(envPolicy?.mutations ? { policyMutations: envPolicy.mutations } : {}),
      allowWrites: opts.allowFixtureWrites === true,
      origin: "run",
      runId,
      ...(opts.invocation ? { invocationId: opts.invocation.id } : {}),
      ...(opts.fixtureHost ? { host: opts.fixtureHost } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      redact: (text) => redactor.text(text),
      redactValue: (value) => redactor.value(value),
      onEvent: (event) => writer.appendEvent(event),
      onVerbStart: async ({ name, verb, budgetMs }) => {
        const label = fixturePhaseLabel(verb, name);
        await tracker.enter(
          verb === "teardown" ? "teardown" : "preconditions",
          {
            item: label,
            budgetMs,
          },
        );
        if (verb !== "teardown")
          listener.onPreconditionStart?.(label, budgetMs);
      },
      onVerbEnd: ({ name, verb, status, durationMs, error }) => {
        const label = fixturePhaseLabel(verb, name);
        runLog.writeLine(
          `${label}: ${status} in ${durationMs}ms${error ? ` — ${error}` : ""}`,
        );
        if (verb !== "teardown") {
          listener.onPreconditionFinish?.(
            label,
            status === "failed" ? 1 : 0,
            durationMs,
            {},
          );
        } else if (status === "failed") {
          opts.listener?.onWarning?.(`${label} failed: ${error ?? "failed"}`);
        }
      },
    });
    lifecycle.disarmFixtureSignal = runtimeFixtures.armSignal((event) => {
      try {
        appendFileSync(
          join(runDir, "events.ndjson"),
          `${JSON.stringify(redactor.value(event))}\n`,
        );
      } catch {
        // The process is exiting; evidence is best-effort here.
      }
    });
    return runtimeFixtures;
  }
  // F3b: tear down the run's fixtures (after the spec teardown) and write
  // <runDir>/fixtures.json. Runs once, on every exit path.
  let fixturesSettled = false;
  const settleFixtures = async (
    runStatus: TeardownRunStatus,
  ): Promise<void> => {
    if (!fixtures || fixturesSettled) return;
    fixturesSettled = true;
    await fixtures.teardown(runStatus);
    lifecycle.disarmFixtureSignal?.();
    // A teardown's login token is known only now.
    registerSecretValues(fixtures.secretValues());
    await writer.writeJson("fixtures.json", fixtures.runLedger());
  };

  // F3a: `${runs.<assign>…}` values of run steps, and the request/eval
  // splice sources once the step loop declares them (teardown may run from
  // an early stop, before those maps exist).
  const runValues: Record<string, unknown> = {};
  const splice: {
    responses: Record<string, unknown>;
    evals: Record<string, unknown>;
  } = { responses: {}, evals: {} };
  // F3b: the spec's config fixtures (ensured after the preconditions), their
  // outputs spliced as ${fixtures.<name>.<key>} into steps, teardown and
  // verifiers. Armed BEFORE the spec teardown's signal handler so, on
  // SIGINT/SIGTERM, the spec teardown runs first (like the normal path).
  const fixtures = createRunFixtures();
  const spliceRuntime = (s: string): string =>
    resolveRunPlaceholders(
      resolveEvalPlaceholders(
        resolveResponsePlaceholders(
          fixtures ? resolveFixturePlaceholders(s, fixtures.outputs()) : s,
          splice.responses,
        ),
        splice.evals,
      ),
      runValues,
    );
  const runStepChildEnv = opts.childEnv ?? runEnv;
  // F3a spec teardown: always runs once, after the outcomes or an early
  // stop; on SIGINT/SIGTERM its `run` items run from the signal handler.
  // Each item runs once: the two paths share one set of claims (a host
  // that survives the signal still finishes the aborted run).
  const teardown = teardownPlan(resolved.teardown);
  const claimTeardownItem = createTeardownClaims();
  let teardownSummary: TeardownSummary | undefined;
  lifecycle.disarmSignalTeardown = armSignalTeardown({
    steps: teardown.steps,
    budgetMs: teardown.timeoutMs,
    runDir,
    redact: (event) => redactor.value(event),
    claim: claimTeardownItem,
    invocation: (step, _index, signal) => ({
      step: deepMapStrings(step, spliceRuntime),
      fileScope: specFileScope(dirname(specPath)),
      childEnv: runStepChildEnv,
      contextEnv: {
        ...contextEnv,
        CAIRN_RUN_STATUS: "errored",
        CAIRN_RUN_SIGNAL: signal,
      },
      ...(opts.selectedTvaultKeys !== undefined
        ? { selectedTvaultKeys: opts.selectedTvaultKeys }
        : {}),
    }),
  });
  const executeTeardownStep = async (
    step: Step,
    runStatus: TeardownRunStatus,
    remainingMs: number,
  ): Promise<TeardownItemResult> => {
    const prepared = deepMapStrings(step, spliceRuntime);
    // A cancel killed the browser; a wedged backend would only time out.
    const browserUsable = !cancelled() && opts.backend.isWedged?.() !== true;
    if ("run" in prepared) {
      const ran = await executeRunStep({
        step: prepared,
        fileScope: specFileScope(dirname(specPath)),
        childEnv: runStepChildEnv,
        contextEnv: { ...contextEnv, CAIRN_RUN_STATUS: runStatus },
        ...(opts.selectedTvaultKeys !== undefined
          ? { selectedTvaultKeys: opts.selectedTvaultKeys }
          : {}),
        maxTimeoutMs: remainingMs,
      });
      if (ran.ok && ran.assign) runValues[ran.assign] = ran.value;
      return ran.ok
        ? { status: "passed" }
        : {
            status: "failed",
            ...(ran.error ? { error: ran.error } : {}),
            ...(ran.timedOut ? { timedOut: true } : {}),
          };
    }
    if (!browserUsable) {
      return {
        status: "skipped",
        error: cancelled()
          ? "browser closed by the cancel"
          : "browser backend is wedged",
      };
    }
    if ("when" in prepared && prepared.when) {
      if (!(await evaluateWhen(prepared.when, opts.backend))) {
        return { status: "skipped" };
      }
    }
    const bounded = async (
      work: Promise<TeardownItemResult>,
    ): Promise<TeardownItemResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<TeardownItemResult>((resolveExpired) => {
        timer = setTimeout(
          () =>
            resolveExpired({
              status: "failed",
              error: `did not finish within the teardown budget (${remainingMs}ms left)`,
              timedOut: true,
            }),
          remainingMs,
        );
      });
      try {
        return await Promise.race([work, expired]);
      } finally {
        clearTimeout(timer);
      }
    };
    if ("request" in prepared) {
      return bounded(
        runRequestStep({
          step: prepared,
          backend: opts.backend,
          requestIndex: 0,
          baseUrl: runtime.baseUrl,
        }).then((requested) => {
          if (!requested.ok) {
            return { status: "failed" as const, error: requested.error };
          }
          splice.responses[requested.assign] = requested.response;
          return { status: "passed" as const };
        }),
      );
    }
    if ("eval" in prepared) {
      return bounded(
        runEvalStep({
          step: prepared as EvalStep,
          backend: opts.backend,
          specDir: dirname(specPath),
          fileScope: specFileScope(dirname(specPath)),
          writer,
        }).then((ev) => {
          if (!ev.ok) return { status: "failed" as const, error: ev.error };
          if (ev.assign) splice.evals[ev.assign] = { value: ev.value };
          return { status: "passed" as const };
        }),
      );
    }
    let browserStep = resolveOpenStep(prepared, {
      baseUrl: runtime.baseUrl,
      artifacts: {},
    });
    browserStep = applyWaitScale(
      applySpecClickSettle(browserStep, resolved.settleMs),
      waitScale,
    );
    return bounded(
      runResilientBrowserStep(browserStep, opts.backend, waitScale).then((r) =>
        r.ok
          ? { status: "passed" as const }
          : {
              status: "failed" as const,
              error: r.stderr.trim() || `exit ${r.exitCode}`,
            },
      ),
    );
  };
  const runSpecTeardown = async (
    runStatus: TeardownRunStatus,
    /** Abandoning a run that threw: evidence writes may fail; carry on. */
    bestEffort = false,
  ): Promise<TeardownSummary | undefined> => {
    if (teardown.steps.length === 0 || teardownSummary) return teardownSummary;
    const tolerate = async (work: () => unknown): Promise<void> => {
      if (!bestEffort) {
        await work();
        return;
      }
      try {
        await work();
      } catch {
        // The run already threw; its evidence is best effort from here.
      }
    };
    teardownSummary = await runTeardown({
      steps: teardown.steps,
      budgetMs: teardown.timeoutMs,
      runStatus,
      emit: (event) => tolerate(() => writer.appendEvent(event)),
      log: (line) => {
        void tolerate(() => runLog.writeLine(line));
      },
      warn: (message) => opts.listener?.onWarning?.(message),
      enter: (item, budgetMs) =>
        tolerate(() => tracker.enter("teardown", { item, budgetMs })),
      claim: claimTeardownItem,
      execute: (step, _index, remainingMs) =>
        executeTeardownStep(step, runStatus, remainingMs),
    });
    lifecycle.disarmSignalTeardown?.();
    return teardownSummary;
  };

  // Settle a run that stops before its browser steps (failed precondition,
  // unusable checkpoint, cancel): run.json, run.log end line, manifest and
  // retention, exactly like a precondition failure always has.
  const finishEarly = async (
    input: Pick<
      PreconditionFailureInput,
      | "name"
      | "durationMs"
      | "timedOut"
      | "message"
      | "phase"
      | "step"
      | "steps"
      | "signal"
    >,
  ): Promise<RunResult> => {
    // F3a: the spec teardown runs on early stops too (status errored).
    await runSpecTeardown("errored");
    // F3b: then the run's fixtures, newest first (finally semantics).
    await settleFixtures("errored");
    // The run settles here: no heartbeat may follow run.errored/manifest.
    tracker.stop();
    const failureResult = await finalizePreconditionFailure({
      writer,
      redactor,
      spec,
      specPath,
      runId,
      runDir,
      environment: env,
      backend: backendName,
      coldStart,
      labels: opts.labels,
      ...(opts.invocation ? { invocation: opts.invocation } : {}),
      startedAt,
      ...input,
      listener: opts.listener,
      beforeManifest: (failed) => {
        narration.onRunEnd?.(failed);
        runLog.close();
      },
      ...(opts.captureServicesArtifacts
        ? { captureServicesArtifacts: opts.captureServicesArtifacts }
        : {}),
    });
    await applyRunRetention({
      retention: runtime.config?.retention,
      stash: runtime.config?.stash,
      artifactRoot,
      writer,
      opts,
    });
    return failureResult;
  };

  lifecycle.abandon = async (): Promise<void> => {
    await runSpecTeardown("errored", true).catch(() => undefined);
    if (fixtures && !fixturesSettled) {
      fixturesSettled = true;
      await fixtures.teardown("errored").catch(() => undefined);
      lifecycle.disarmFixtureSignal?.();
      registerSecretValues(fixtures.secretValues());
      await writer
        .writeJson("fixtures.json", fixtures.runLedger())
        .catch(() => undefined);
    }
  };

  // F3b: a spec that names unknown fixtures, or splices
  // ${fixtures.<name>…} it does not list (or lists no fixtures at all), is
  // a config error before anything runs (an unresolved placeholder would
  // reach the browser, a shell or a verifier as literal text).
  const fixtureProblem = checkFixtureReferences();
  if (fixtureProblem) {
    return finishEarly({
      phase: "fixture",
      name: fixtureProblem.name,
      message: fixtureProblem.message,
      durationMs: 0,
      timedOut: false,
    });
  }
  function fixtureReferenceText(): string {
    return JSON.stringify({
      steps: resolved.steps ?? [],
      teardown: resolved.teardown ?? [],
      outcomes: resolved.outcomes,
    });
  }
  function checkFixtureReferences():
    | { name: string; message: string }
    | undefined {
    const text = fixtureReferenceText();
    const preconditionRefs = fixtureNamesReferenced(
      JSON.stringify(resolved.preconditions ?? {}),
    );
    if (preconditionRefs.length > 0) {
      return {
        name: preconditionRefs[0]!,
        message: `\${fixtures.${preconditionRefs[0]}…} is used in preconditions, which run before the fixtures are ensured; use it in steps, teardown or outcomes`,
      };
    }
    if (!fixtures) {
      const used = fixtureNamesReferenced(text);
      if (used.length === 0) return undefined;
      return {
        name: used[0]!,
        message: `\${fixtures.${used[0]}…} is referenced but the spec lists no fixtures; add fixtures: [${used[0]}]`,
      };
    }
    let planned: string[];
    try {
      planned = planFixtures(
        spec.fixtures ?? [],
        runtime.config?.fixtures ?? {},
      ).map((entry) => entry.name);
    } catch (error) {
      return error instanceof FixtureSetupError
        ? { name: error.fixture, message: error.message }
        : { name: "fixtures", message: (error as Error).message };
    }
    const unknown = fixtureNamesReferenced(text).filter(
      (name) => !planned.includes(name),
    );
    if (unknown.length === 0) return undefined;
    return {
      name: unknown[0]!,
      message: `\${fixtures.${unknown[0]}…} is referenced but the spec's fixtures (${planned.join(", ")}) do not include it; add it to fixtures:`,
    };
  }

  // F2: `preconditions.wait` — readiness gates (config `gates:` names or
  // inline), waited in order BEFORE the commands. Each gate's budget is the
  // phase item (phase.changed); a gate that is not ready settles the run like
  // a failed precondition named `wait <gate>`.
  const preconditionGates = gateRefList(spec.preconditions?.wait);
  if (preconditionGates.length > 0) {
    const configDir = runtime.configPath
      ? dirname(runtime.configPath)
      : undefined;
    const gateCtx: GateContext = {
      registry: runtime.config?.gates ?? {},
      env: targetChildEnvWithSelectedTvaultKeys(
        { ...(opts.childEnv ?? runEnv), ...contextEnv },
        opts.selectedTvaultKeys ?? [],
      ),
      cwd: dirname(specPath),
      ...(configDir ? { registryCwd: configDir } : {}),
      scope: "precondition",
      ...(opts.signal ? { signal: opts.signal } : {}),
      redact: (text) => redactor.text(text),
      onEvent: (event) => {
        const label = `wait ${event.name}`;
        if (event.type === "gate.started") {
          void tracker.enter("preconditions", {
            item: event.name,
            ...(event.budgetMs > 0 ? { budgetMs: event.budgetMs } : {}),
          });
          listener.onPreconditionStart?.(label, event.budgetMs);
        }
        void writer.appendEvent(event).catch(() => undefined);
        if (event.type === "gate.attempt" && !event.ok) {
          listener.onPreconditionProgress?.(
            label,
            `attempt ${event.attempt}: ${event.detail}`,
          );
        }
        if (event.type === "gate.passed" || event.type === "gate.failed") {
          listener.onPreconditionFinish?.(
            label,
            event.type === "gate.passed" ? 0 : 1,
            event.durationMs,
            event.type === "gate.failed" && event.timedOut
              ? { timedOut: true }
              : {},
          );
        }
      },
    };
    try {
      assertGateRefs(preconditionGates, gateCtx);
    } catch (error) {
      if (!(error instanceof GateReferenceError)) throw error;
      return finishEarly({
        name: "wait",
        message: `preconditions.wait: ${error.message}`,
        durationMs: 0,
        timedOut: false,
      });
    }
    for (const ref of preconditionGates) {
      const result = await waitForGate(ref, gateCtx);
      if (result.ok) continue;
      return finishEarly({
        ...(result.cancelled ? { phase: "cancelled" as const } : {}),
        name: `wait ${result.name}`,
        message: result.cancelled
          ? `${RUN_CANCELLED_MESSAGE} while waiting for gate "${result.name}"`
          : gateFailureMessage(result),
        durationMs: result.durationMs,
        timedOut: result.timedOut === true,
      });
    }
  }

  // Execute spec preconditions (setup/reset shell commands) BEFORE any browser
  // interaction. Until v1.48 the schema accepted `preconditions.commands` but
  // nothing executed them — guards and data resets silently did nothing. Each
  // command runs through the shell with cwd = the spec's directory (or its own
  // `cwd`, resolved against it); `preconditions.env` is layered over
  // process.env. A non-zero exit aborts the run: a failed precondition means
  // the spec's contract cannot be evaluated.
  const preconditionCommands = spec.preconditions?.commands ?? [];
  if (preconditionCommands.length > 0) {
    const specDir = dirname(specPath);
    const preEnv: NodeJS.ProcessEnv = targetChildEnvWithSelectedTvaultKeys(
      {
        ...(opts.childEnv ?? runEnv),
        ...contextEnv,
        ...Object.fromEntries(
          Object.entries(spec.preconditions?.env ?? {}).map(([k, v]) => [
            k,
            String(v),
          ]),
        ),
      },
      opts.selectedTvaultKeys ?? [],
    );
    for (const [index, command] of preconditionCommands.entries()) {
      const label = command.name ?? `precondition[${index}]`;
      // Cancelled between preconditions: the rest never start.
      if (cancelled()) {
        return finishEarly({
          phase: "cancelled",
          name: label,
          message: `${RUN_CANCELLED_MESSAGE} before precondition "${label}" started`,
          durationMs: 0,
          timedOut: false,
        });
      }
      const cwd = command.cwd ? resolve(specDir, command.cwd) : specDir;
      const timeoutMs = command.timeoutMs ?? 120_000;
      await tracker.enter("preconditions", {
        item: label,
        budgetMs: timeoutMs,
      });
      // Live log of the command's combined output, redacted line by line.
      const logPath = `logs/precondition-${logIndex(index + 1)}-${logSlug(label)}.log`;
      const preconditionLog = openRunLog(writer, redactor, logPath);
      lifecycle.logs.add(preconditionLog);
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "log.opened",
        kind: "precondition",
        name: label,
        path: logPath,
      });
      const startedAtMs = Date.now();
      // precondition.run is a post-mortem event: a long quiesce poll used to
      // leave events.ndjson silent for its whole budget, indistinguishable
      // from a dead run. The started twin bounds the mystery to one command.
      await writer.appendEvent({
        ts: new Date(startedAtMs).toISOString(),
        type: "precondition.started",
        name: label,
        timeoutMs,
        index: index + 1,
        total: preconditionCommands.length,
        logPath,
      });
      listener.onPreconditionStart?.(label, timeoutMs);
      // Lines the command appends to $CAIRN_PROGRESS_FILE become
      // precondition.progress events while it runs.
      const progressFile = progressFiles.create(
        `precondition-${logIndex(index + 1)}`,
      );
      const progressTail = progressFile
        ? new ProgressTail(progressFile, {
            onMessage: (message) => {
              void writer
                .appendEvent({
                  ts: new Date().toISOString(),
                  type: "precondition.progress",
                  name: label,
                  message,
                })
                .catch(() => undefined);
              listener.onPreconditionProgress?.(label, redactor.text(message));
            },
          }).start()
        : undefined;
      if (progressTail) lifecycle.tails.add(progressTail);
      // The deadline and a cancel hard-kill the command's process tree (a
      // shell's children too). The shell's exit settles the command: a
      // background process it left holding stdout (`cmd &`) cannot stretch
      // the deadline. preEnv is the whole env — nothing of this process's
      // env (publisher/TinyVault credentials) is merged in. The command
      // keeps this process's terminal (no own process group).
      const result = await (async () => {
        try {
          return await runBoundedCommand("/bin/sh", ["-c", command.run], {
            cwd,
            env: progressFile
              ? { ...preEnv, [CAIRN_PROGRESS_FILE_ENV]: progressFile }
              : preEnv,
            timeoutMs,
            onOutput: (chunk) => preconditionLog.write(chunk),
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
        } finally {
          progressTail?.stop();
          if (progressTail) lifecycle.tails.delete(progressTail);
          preconditionLog.close();
          lifecycle.logs.delete(preconditionLog);
        }
      })();
      const killedByCancel = result.cancelled;
      const timedOut = result.timedOut;
      // Redact the whole output before cutting it: a secret that straddles
      // the cut would otherwise survive as a partial literal no redactor
      // recognizes.
      const output = redactor.text(String(result.all ?? ""));
      const durationMs = Date.now() - startedAtMs;
      // Keep the TAIL: the end of a failing setup command (the error, the
      // last poll line) is what explains it; the head is usually banner noise.
      const outputTail = tailText(output, PRECONDITION_OUTPUT_TAIL_CHARS);
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "precondition.run",
        name: label,
        ...(typeof result.exitCode === "number"
          ? { exitCode: result.exitCode }
          : {}),
        durationMs,
        timedOut,
        ...(result.exitSignal ? { signal: result.exitSignal } : {}),
        output: outputTail,
        ...(outputTail.length < output.length ? { outputTruncated: true } : {}),
        logPath,
      });
      listener.onPreconditionFinish?.(label, result.exitCode, durationMs, {
        timedOut: timedOut && !killedByCancel,
        ...(result.exitSignal ? { signal: result.exitSignal } : {}),
      });
      if (killedByCancel) {
        return finishEarly({
          phase: "cancelled",
          name: label,
          message: `${RUN_CANCELLED_MESSAGE}: precondition "${label}" was killed after ${durationMs}ms`,
          durationMs,
          timedOut: false,
          ...(result.exitSignal ? { signal: result.exitSignal } : {}),
        });
      }
      if (result.exitCode !== 0) {
        const message = timedOut
          ? `Precondition "${label}" timed out after ${durationMs}ms${
              result.exitSignal ? ` (${result.exitSignal})` : ""
            }`
          : result.spawnError
            ? `Precondition "${label}" could not start: ${redactor.text(result.spawnError)}`
            : `Precondition "${label}" failed (${
                result.exitCode === undefined && result.exitSignal
                  ? `killed by ${result.exitSignal}`
                  : `exit ${result.exitCode}`
              }): ${tailText(output.trimEnd(), 500)}`;
        return finishEarly({
          name: label,
          durationMs,
          timedOut,
          ...(result.exitSignal ? { signal: result.exitSignal } : {}),
          message,
        });
      }
    }
  }

  // F3b: ensure the spec's fixtures (needs first), then their `.reset`s —
  // after the preconditions (guards run first) and before any browser call.
  // A failure settles the run like a failed precondition (phase fixture);
  // what was ensured before it is still torn down.
  if (fixtures) {
    const fixturesStartedAt = Date.now();
    try {
      try {
        await fixtures.setup(spec.fixtures ?? []);
      } finally {
        // Secret outputs and login tokens (a failed setup's too): the live
        // run redactor and every later one scrub them.
        registerSecretValues(fixtures.secretValues());
      }
      // Every ${fixtures.<name>.<key>} the spec splices must have a value
      // (a dry-run may have none): never send a literal placeholder on.
      const unresolved = unresolvedFixtureReferences(
        fixtureReferenceText(),
        fixtures.outputs(),
      );
      if (unresolved.length > 0) {
        const first = unresolved[0]!;
        const entry = fixtures
          .runLedger()
          .entries.find((candidate) => candidate.name === first.name);
        throw new FixtureSetupError(
          first.name,
          "ensure",
          `${first.reference} has no value after the fixtures were set up${
            entry?.reason ? ` (fixture ${first.name}: ${entry.reason})` : ""
          }${
            unresolved.length > 1
              ? `; also unresolved: ${unresolved
                  .slice(1)
                  .map((ref) => ref.reference)
                  .join(", ")}`
              : ""
          }`,
        );
      }
    } catch (error) {
      const failed =
        error instanceof FixtureSetupError
          ? error
          : new FixtureSetupError(
              "fixtures",
              "ensure",
              (error as Error).message,
            );
      const cancelledNow = failed.cancelled || cancelled();
      return finishEarly({
        phase: cancelledNow ? "cancelled" : "fixture",
        name: failed.fixture,
        message: cancelledNow
          ? `${RUN_CANCELLED_MESSAGE} during fixture "${failed.fixture}"`
          : failed.message,
        durationMs: Math.max(failed.durationMs, Date.now() - fixturesStartedAt),
        timedOut: failed.timedOut,
      });
    }
  }

  // A session.resume checkpoint that cannot be used (missing, expired, or
  // captured for another origin) fails the run HERE: after the preconditions,
  // so a precondition may create or refresh the state file it resumes (a
  // scope sidecar that no longer matches the state file is ignored), and
  // before any backend call or browser start.
  let resumePath: string | undefined;
  if (spec.session?.resume) {
    const check = await (
      opts.checkpointStore ?? new CheckpointStore()
    ).checkResume(
      spec.session.resume,
      runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {},
    );
    resumePath = check.path;
    if (check.problem) {
      const failed = await recordSessionResumeFailure(
        writer,
        spec.session.resume,
        check.problem.message,
        0,
      );
      return finishEarly({
        phase: "session",
        name: spec.session.resume,
        step: SESSION_RESUME_STEP,
        steps: [failed],
        message: check.problem.message,
        durationMs: 0,
        timedOut: false,
      });
    }
  }

  // Reset backend's network/console logs before the run so we don't pick up
  // leakage from a previous spec on the same session.
  await safe(() => opts.backend.clearNetworkLog());
  await safe(() => opts.backend.clearConsole());

  const policy = mergeCapturePolicy(spec, opts.captureOverride);

  // Surface clip/video misconfigurations that would otherwise silently produce
  // nothing — the marquee "run → video → vidtrace clip" loop only works on the
  // playwright backend with video enabled.
  const clipPointsRequested = (spec.artifacts?.clipPoints?.length ?? 0) > 0;
  if (clipPointsRequested && policy.video === "never") {
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "warning",
      warning:
        "clipPoints are configured but artifacts.capture.video is 'never' — no video is recorded, so no clips can be cut. Set video: on-failure (or always) to enable clips.",
    });
  }
  if (policy.video !== "never" && !opts.backend.startVideo) {
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "warning",
      warning: `video capture is requested but the '${opts.backend.name}' backend does not record video — only the playwright backend does. Run with --backend playwright to produce video${
        clipPointsRequested ? " and clips" : ""
      }.`,
    });
  }

  // Start video recording. Same best-effort pattern as trace: backends
  // without video support no-op. The default policy is `never` so videos are
  // only recorded when the spec explicitly opts in.
  if (policy.video !== "never") {
    const videoConfig = {
      ...spec.artifacts?.video,
      ...opts.videoOptions,
    };
    await safe(async () =>
      opts.backend.startVideo?.({
        slowMo: videoConfig?.slowMo,
        speed: videoConfig?.speed,
      }),
    );
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "start",
      policy: policy.video,
      ...(videoConfig?.slowMo ? { slowMo: videoConfig.slowMo } : {}),
      ...(videoConfig?.speed && videoConfig.speed !== 1
        ? { speed: videoConfig.speed }
        : {}),
    });
  }

  // Start trace after video setup. Playwright creates its context when tracing
  // starts, so video must configure recordVideo + slowMo first or the trace
  // context would be discarded and the recording options ignored.
  if (policy.trace !== "never") {
    await safe(async () => opts.backend.startTrace?.());
  }

  // Cold-start gate (plan §10.6). Default `false` locally, `true` in CI.
  // Resolves before checkpoint resume so the spec's own setup populates state
  // *after* the wipe.
  if (coldStart) {
    await safe(() => opts.backend.clearBrowserState());
  }

  // Restore the checkpoint (scope already validated above). The `resume`
  // field accepts a literal path or a name registered with `cairn login` /
  // `cairn checkpoint capture-from-session`. A failed load is a failed
  // `session.resume` step, never swallowed: the steps would otherwise run
  // signed out and fail somewhere misleading.
  let resumeFailed: StepResult | undefined;
  if (spec.session?.resume && resumePath) {
    const resumeStartedAt = Date.now();
    let loadError: string | undefined;
    try {
      const loaded = await opts.backend.loadState(resumePath);
      if (!loaded.ok) {
        loadError = loaded.stderr.trim() || `exit ${loaded.exitCode}`;
      }
    } catch (e) {
      loadError = (e as Error).message;
    }
    if (loadError !== undefined) {
      resumeFailed = await recordSessionResumeFailure(
        writer,
        spec.session.resume,
        `could not restore checkpoint "${spec.session.resume}": ${loadError}`,
        Date.now() - resumeStartedAt,
      );
    }
  }

  // Apply the viewport before any step runs. Spec-level wins over the
  // environment's config. Placed after loadState so backends that rebuild
  // their page on state restore still end up at the requested size.
  const viewport = spec.viewport ?? runtime.viewport;
  if (viewport) {
    // Deliberately not routed through safe(): that helper discards the
    // error, and a swallowed setViewport failure previously left the
    // "viewport.set" event looking identical whether the resize actually
    // took effect or the backend rejected/ignored it — silently misleading
    // anyone debugging an off-viewport element. Record the outcome instead.
    let viewportError: string | undefined;
    try {
      await opts.backend.setViewport?.(viewport.width, viewport.height);
    } catch (e) {
      viewportError = (e as Error).message;
    }
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "viewport.set",
      width: viewport.width,
      height: viewport.height,
      ok: viewportError === undefined,
      ...(viewportError ? { error: viewportError } : {}),
    });
  }

  const stepResults: StepResult[] = resumeFailed ? [resumeFailed] : [];
  let lastSuccessfulStep: Step | undefined;
  let latestScreenshot: string | undefined;
  let latestSnapshot: string | undefined;
  let latestDiagnostics: string | undefined;
  let didError = resumeFailed !== undefined;
  const downloads: Record<string, string> = {};
  const transforms: Record<string, string> = {};
  /** request-step artifact paths by assign name (run-relative). */
  const requests: Record<string, string> = {};
  /** Captured request-step responses for ${requests.<name>.…} substitution. */
  const responses: Record<string, unknown> = {};
  /** eval-step artifact paths by assign name (run-relative). */
  const evals: Record<string, string> = {};
  /** Captured eval-step return values for ${evals.<name>.…} substitution. */
  const evalValues: Record<string, unknown> = {};
  /**
   * F16: `${captures.<name>.…}` values — capture steps, then verifier
   * `assign`s during outcome evaluation (the outcome ctx shares this map).
   */
  const captureValues: Record<string, unknown> = {};
  // F3a: teardown splices the same maps (the step loop owns them).
  splice.responses = responses;
  splice.evals = evalValues;
  const namedArtifacts: Record<string, ArtifactRef> = {};
  const diagnostics: string[] = [];

  // Opt-in process monitoring (`--monitor` or MONITOR=1). The sampler targets
  // the backend's browserPid() and may start lazily — agent-browser spawns its
  // daemon on the first command, so the PID can be unavailable until after the
  // first step. Zero-cost when monitoring is disabled.
  const monitorClient =
    opts.monitorClient ??
    defaultMonitorClient(runtime.config?.diagnostics?.monitor?.binary);
  const monitorEnabled =
    opts.monitor !== undefined && opts.monitor !== false
      ? true
      : isTruthyEnv(runEnv["MONITOR"]);
  const monitorIntervalMs =
    typeof opts.monitor === "object" && opts.monitor
      ? opts.monitor.intervalMs
      : undefined;
  let sampler: ProcessSampler | undefined;
  let processMetricsSummary: ProcessMetricsSummary | undefined;
  const maybeStartSampler = (): void => {
    if (!monitorEnabled || sampler) return;
    const pid = opts.backend.browserPid?.();
    if (pid === undefined || pid <= 1) return;
    sampler = new ProcessSampler({
      pid,
      ...(monitorIntervalMs !== undefined
        ? { intervalMs: monitorIntervalMs }
        : {}),
      client: monitorClient,
    });
    sampler.start();
    // When launched under `monitor run`, surface the target PID so the parent
    // monitor can observe the exact browser process tree.
    if (isTruthyEnv(runEnv["MONITOR"])) {
      void writer
        .writeJson(
          "diagnostics/target.json",
          { pid, backend: backendName, writtenAt: new Date().toISOString() },
          "diagnostic",
        )
        .catch(() => undefined);
    }
  };
  maybeStartSampler();
  // F13: relative paths of a step resolve against the file that declares it.
  const stepFileScope = (index: number): StepFileScope =>
    stepFileScopeAt(
      { path: specPath, origins, actionsByName },
      index,
      (key, message) =>
        reportDeprecation(key, message, { runLog, listener: opts.listener }),
    );
  const totalSteps = (resolved.steps ?? []).length;
  if (totalSteps > 0) await tracker.enter("steps");
  for (let i = 0; i < totalSteps; i++) {
    // No session (failed resume) or a cancel: the remaining steps never run.
    if (resumeFailed || cancelled()) break;
    const step = resolved.steps![i]!;
    const stepId = step.id ?? `step_${i + 1}`;
    const stepStart = Date.now();
    const fileScope = stepFileScope(i);
    const described =
      "run" in step
        ? { kind: "run", label: runStepLabel(step) }
        : describeStep(step);
    tracker.setItem(stepId);
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "step.started",
      stepId,
      index: i + 1,
      total: totalSteps,
      kind: described.kind,
      label: described.label,
    });
    listener.onStepStart?.(i, step, stepId);

    // Optional when: predicate — skip the step if the page doesn't match.
    if ("when" in step && step.when) {
      let conditionHolds = false;
      try {
        conditionHolds = await evaluateWhen(step.when, opts.backend);
      } catch (e) {
        // Treat parse errors as a step failure so they surface clearly.
        const durationMs = Date.now() - stepStart;
        stepResults.push({
          id: stepId,
          status: "failed",
          durationMs,
          error: `when: ${(e as Error).message}`,
        });
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "step.failed",
          stepId,
          durationMs,
          error: `when: ${(e as Error).message}`,
        });
        listener.onStepFinish?.(
          i,
          stepId,
          "failed",
          durationMs,
          `when: ${(e as Error).message}`,
        );
        break;
      }
      if (!conditionHolds) {
        const durationMs = Date.now() - stepStart;
        stepResults.push({ id: stepId, status: "skipped", durationMs });
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "step.finished",
          stepId,
          durationMs,
          skipped: true,
          when: step.when,
        });
        listener.onStepFinish?.(i, stepId, "skipped", durationMs, undefined);
        continue;
      }
    }

    const stepArtifacts: string[] = [];
    // Splice captured request-response fields (${requests.<name>.…}) and
    // eval return values (${evals.<name>.…}) into any string field of the
    // step before it runs — the hybrid-flow hook ("fetch token via API, fill
    // it into the UI" / "read store value, fill it into the form").
    // F3b: ${fixtures.<name>.<key>} from the spec's fixtures.
    const withFixtures = fixtures
      ? deepMapStrings(step, (s) =>
          resolveFixturePlaceholders(s, fixtures.outputs()),
        )
      : step;
    // F16: `expect` / `capture` resolve their own references (typed whole
    // references, unknown names reported instead of spliced as ""), so the
    // text splices below skip them.
    const resolvesOwnRefs = "expect" in step || "capture" in step;
    const substituted =
      !resolvesOwnRefs &&
      (Object.keys(responses).length > 0 || Object.keys(evalValues).length > 0)
        ? deepMapStrings(withFixtures, (s) =>
            resolveEvalPlaceholders(
              resolveResponsePlaceholders(s, responses),
              evalValues,
            ),
          )
        : withFixtures;
    // F3a: ${runs.<assign>.…} from earlier run steps.
    const withRuns =
      !resolvesOwnRefs && Object.keys(runValues).length > 0
        ? deepMapStrings(substituted, (s) =>
            resolveRunPlaceholders(s, runValues),
          )
        : substituted;
    // F16: ${captures.<assign>.…} from earlier capture steps.
    const withCaptures =
      !resolvesOwnRefs && Object.keys(captureValues).length > 0
        ? deepMapStrings(withRuns, (s) =>
            resolveCapturePlaceholders(s, captureValues),
          )
        : withRuns;
    let stepToRun = resolveOpenStep(withCaptures, {
      baseUrl: runtime.baseUrl,
      artifacts: namedArtifacts,
    });
    stepToRun = applySpecClickSettle(stepToRun, resolved.settleMs);
    stepToRun = applyWaitScale(stepToRun, waitScale);
    let pendingDownload:
      | {
          assign: string;
          relativePath: string;
          absolutePath: string;
        }
      | undefined;
    if ("download" in stepToRun) {
      const relativePath = downloadRelativePath(stepToRun.download.saveAs);
      const absolutePath = await writer.preparePath(relativePath, "download");
      pendingDownload = {
        assign: stepToRun.download.assign ?? artifactNameFromPath(relativePath),
        relativePath,
        absolutePath,
      };
      stepToRun = {
        ...stepToRun,
        download: { ...stepToRun.download, saveAs: absolutePath },
      };
    } else if ("upload" in stepToRun) {
      stepToRun = {
        ...stepToRun,
        upload: {
          ...stepToRun.upload,
          path: resolveUploadPath(
            stepToRun.upload.path,
            fileScope,
            runDir,
            namedArtifacts,
          ),
        },
      };
    }

    let stepStatus: StepResult["status"] = "passed";
    let stepError: string | undefined;
    let stepResolved: ResolvedElement | undefined;
    let stepScreenshot: string | undefined;
    // Best-known page URL after the step, only where it is free (no extra
    // backend round-trip): the diagnostics capture of a failed step, or the
    // navigation target of an open step that passed.
    let stepUrl: string | undefined;
    try {
      if ("run" in stepToRun) {
        // F3a: a host process with a process-tree deadline; a cancel kills it.
        const ran = await executeRunStep({
          step: stepToRun,
          fileScope,
          childEnv: runStepChildEnv,
          contextEnv,
          ...(opts.selectedTvaultKeys !== undefined
            ? { selectedTvaultKeys: opts.selectedTvaultKeys }
            : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!ran.ok) {
          stepStatus = "failed";
          stepError = ran.error ?? "run step failed";
        } else if (ran.assign) {
          runValues[ran.assign] = ran.value;
        }
      } else if ("request" in stepToRun) {
        const requested = await runRequestStep({
          step: stepToRun,
          backend: opts.backend,
          requestIndex: i + 1,
          baseUrl: runtime.baseUrl,
        });
        if (!requested.ok) {
          stepStatus = "failed";
          stepError = requested.error;
        } else {
          const relativePath = `requests/${requested.assign}.json`;
          await writer.writeJson(relativePath, requested.response, "request");
          const absolutePath = writer.resolve(relativePath);
          responses[requested.assign] = requested.response;
          requests[requested.assign] = relativePath;
          namedArtifacts[requested.assign] = {
            kind: "request",
            path: absolutePath,
            relativePath,
          };
          stepArtifacts.push(relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.request",
            stepId,
            path: relativePath,
            assign: requested.assign,
            status: requested.response.status,
          });
        }
      } else if ("transform" in stepToRun) {
        const transformed = await runTransformStep({
          step: stepToRun,
          writer,
          specDir: dirname(specPath),
          fileScope,
          ...(opts.signal ? { signal: opts.signal } : {}),
          artifacts: namedArtifacts,
          vars: resolvedVars,
          childEnv: opts.childEnv ?? runEnv,
          ...(opts.selectedTvaultKeys !== undefined
            ? { selectedTvaultKeys: opts.selectedTvaultKeys }
            : {}),
        });
        if (!transformed.ok) {
          stepStatus = "failed";
          stepError = transformed.error;
        } else {
          transforms[transformed.assign] = transformed.relativePath;
          namedArtifacts[transformed.assign] = {
            kind: "transform",
            path: transformed.absolutePath,
            relativePath: transformed.relativePath,
          };
          stepArtifacts.push(transformed.relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.transform",
            stepId,
            path: transformed.relativePath,
            assign: transformed.assign,
          });
        }
      } else if ("eval" in stepToRun) {
        const ev = await runEvalStep({
          step: stepToRun as EvalStep,
          backend: opts.backend,
          specDir: dirname(specPath),
          fileScope,
          writer,
        });
        if (!ev.ok) {
          stepStatus = "failed";
          stepError = ev.error;
        } else if (ev.assign) {
          const relativePath = `evals/${ev.assign}.json`;
          evals[ev.assign] = relativePath;
          evalValues[ev.assign] = { value: ev.value };
          namedArtifacts[ev.assign] = {
            kind: "eval",
            path: writer.resolve(relativePath),
            relativePath,
          };
          stepArtifacts.push(relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.eval",
            stepId,
            path: relativePath,
            assign: ev.assign,
          });
        }
      } else if ("expect" in stepToRun || "capture" in stepToRun) {
        // F16: typed mid-flow assertion (evidence like an outcome) or a
        // structured value for ${captures.*}; both read the page through
        // backend.evaluate, `expect.request` through the request transport.
        const checkDeps = {
          backend: opts.backend,
          scope: {
            artifacts: namedArtifacts,
            responses,
            evals: evalValues,
            captures: captureValues,
            runOutputs: runValues,
            ...(fixtures ? { fixtureOutputs: fixtures.outputs() } : {}),
            runStartedAt: startedAt,
          },
          ...(runtime.browser?.testIdAttribute
            ? { testIdAttribute: runtime.browser.testIdAttribute }
            : {}),
          waitScale,
          ...(opts.signal ? { signal: opts.signal } : {}),
          request: async (call: {
            method: string;
            url: string;
            headers?: Record<string, string>;
            body?: unknown;
          }) => {
            const sent = await runRequestStep({
              step: {
                request: {
                  method: call.method as RequestStep["request"]["method"],
                  url: call.url,
                  ...(call.headers ? { headers: call.headers } : {}),
                  ...(call.body !== undefined ? { body: call.body } : {}),
                },
              },
              backend: opts.backend,
              requestIndex: i + 1,
              baseUrl: runtime.baseUrl,
            });
            return sent.ok
              ? {
                  ok: true as const,
                  response: {
                    status: sent.response.status,
                    body: sent.response.body,
                    url: sent.response.url,
                  },
                }
              : { ok: false as const, error: sent.error };
          },
        };
        const checked =
          "expect" in stepToRun
            ? await executeExpectStep({
                step: stepToRun as ExpectStep,
                stepId,
                index: i + 1,
                writer,
                deps: checkDeps,
              })
            : await executeCaptureStep({
                step: stepToRun as CaptureStep,
                writer,
                deps: checkDeps,
                captures: captureValues,
                registerSecrets: registerSecretValues,
              });
        stepArtifacts.push(...checked.artifacts);
        if (!checked.ok) {
          stepStatus = "failed";
          stepError = checked.error;
        }
      } else if ("monitor" in stepToRun) {
        const mon = await runMonitorStep({
          step: stepToRun as MonitorStep,
          backend: opts.backend,
          client: monitorClient,
          writer,
          index: i + 1,
          targets: runtime.config?.diagnostics?.monitor?.targets ?? {},
        });
        if (!mon.ok) {
          stepStatus = "failed";
          stepError = mon.error;
        } else {
          stepArtifacts.push(...mon.relativePaths);
          if (mon.assign) {
            namedArtifacts[mon.assign] = {
              kind: "monitor" as ArtifactRef["kind"],
              path: writer.resolve(mon.relativePath),
              relativePath: mon.relativePath,
            };
          }
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.monitor",
            stepId,
            action: mon.action,
            path: mon.relativePath,
            ...(mon.assign ? { assign: mon.assign } : {}),
          });
        }
      } else {
        let current: Step = stepToRun;
        let r = await runResilientBrowserStep(current, opts.backend, waitScale);
        while (
          !r.ok &&
          opts.onLocatorMiss &&
          isInteractiveLocatorStep(current) &&
          isLocatorMissError(r.stderr.trim() || `exit ${r.exitCode}`)
        ) {
          const decision = await opts.onLocatorMiss({
            step: current,
            stepId,
            index: i,
            error: r.stderr.trim() || `exit ${r.exitCode}`,
            brief: redactBriefStep(
              briefStepFromSpecStep(current, i),
              runEnv,
              opts.secretValues ?? [],
            ),
          });
          if (decision.action === "abort") break;
          current = replaceStepLocator(current, decision.locator);
          r = await runResilientBrowserStep(current, opts.backend, waitScale);
        }
        stepResolved = r.resolvedElement;
        if (!r.ok) {
          stepStatus = "failed";
          stepError = r.stderr.trim() || `exit ${r.exitCode}`;
        } else {
          if (pendingDownload) {
            downloads[pendingDownload.assign] = pendingDownload.relativePath;
            namedArtifacts[pendingDownload.assign] = {
              kind: "download",
              path: pendingDownload.absolutePath,
              relativePath: pendingDownload.relativePath,
            };
            stepArtifacts.push(pendingDownload.relativePath);
            await writer.appendEvent({
              ts: new Date().toISOString(),
              type: "artifact.download",
              stepId,
              path: pendingDownload.relativePath,
              assign: pendingDownload.assign,
            });
          }
          const assign = stepToRun.postcondition?.network?.assign;
          if (assign && r.networkMatch) {
            const response = networkMatchToResponse(r.networkMatch);
            const relativePath = `requests/${assign}.json`;
            await writer.writeJson(relativePath, response, "request");
            responses[assign] = response;
            requests[assign] = relativePath;
            namedArtifacts[assign] = {
              kind: "request",
              path: writer.resolve(relativePath),
              relativePath,
            };
            stepArtifacts.push(relativePath);
            await writer.appendEvent({
              ts: new Date().toISOString(),
              type: "artifact.request",
              stepId,
              path: relativePath,
              assign,
              status: response.status,
            });
          }
        }
      }
    } catch (e) {
      stepStatus = "failed";
      stepError = addEnospcHint((e as Error).message);
      didError = true;
    }

    // The browser PID may only be known after the first navigation (agent-browser
    // spawns its daemon lazily), so retry starting the sampler each step.
    maybeStartSampler();

    // When the backend is wedged, every follow-up subprocess (snapshot,
    // screenshot, diagnostics-eval) re-queues behind an unresponsive daemon
    // and just adds wall time without yielding useful evidence. Skip the
    // post-failure capture phase and record a single artifact noting the
    // short-circuit. The close() call further down escalates to a daemon
    // kill for the same reason. A cancelled run captures nothing: its
    // browser was killed on purpose.
    if (cancelled()) {
      // No post-step capture after a cancel.
    } else if (opts.backend.isWedged?.()) {
      const rel = `diagnostics/${pad(i + 1)}_${stepId}.json`;
      await writer.writeJson(
        rel,
        {
          stepId,
          status: stepStatus,
          stepError,
          wedged: true,
          note: "backend reported isWedged() === true after a child-timeout kill; post-failure capture was skipped to avoid hitting the unresponsive daemon. The close path will escalate to a daemon kill.",
        },
        "diagnostic",
      );
      latestDiagnostics = rel;
      diagnostics.push(rel);
      stepArtifacts.push(rel);
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.diagnostics",
        stepId,
        path: rel,
        wedged: true,
      });
    } else {
      // Capture snapshot and (on failure or always) screenshot.
      if (
        policy.snapshots === "always" ||
        (policy.snapshots === "on-failure" && stepStatus !== "passed")
      ) {
        const rel = `snapshots/${pad(i + 1)}_${stepId}.txt`;
        const snap = await safe(() => opts.backend.snapshot());
        if (snap && snap.ok) {
          await writer.writeText(rel, snap.text, "snapshot");
          latestSnapshot = rel;
          stepArtifacts.push(rel);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.snapshot",
            stepId,
            path: rel,
          });
        }
      }
      const shouldShoot =
        policy.screenshots === "always" ||
        (policy.screenshots === "on-failure" && stepStatus !== "passed");
      if (shouldShoot) {
        const rel = `screenshots/${pad(i + 1)}_${stepId}.png`;
        const screenshotPath = await writer.preparePath(rel, "screenshot");
        const shot = await opts.backend
          .screenshot({ path: screenshotPath })
          .catch((e: unknown) => ({
            ok: false as const,
            path: screenshotPath,
            durationMs: 0,
            error: `screenshot failed: ${(e as Error).message}`,
          }));
        if (shot && shot.ok) {
          latestScreenshot = rel;
          stepScreenshot = rel;
          stepArtifacts.push(rel);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.screenshot",
            stepId,
            path: rel,
          });
        } else if (shot) {
          // A producer may have left a truncated PNG behind before reporting
          // failure. Never publish that file as usable evidence.
          await writer.remove(rel);
          const error =
            shot.error ??
            "screenshot capture failed without backend diagnostics";
          const diagnosticRel = `diagnostics/${pad(i + 1)}_${stepId}_screenshot.json`;
          await writer.writeJson(
            diagnosticRel,
            {
              stepId,
              path: rel,
              error,
              note: /timed out|rendering surface/i.test(error)
                ? "The browser did not provide a composited frame before the hard deadline. On a headed or desktop-backed run, confirm the display is awake; on a headless runner, confirm Chromium has a rendering surface."
                : "Screenshot capture is best-effort; the backend returned a concrete failure instead of silently dropping the artifact.",
            },
            "diagnostic",
          );
          latestDiagnostics = diagnosticRel;
          diagnostics.push(diagnosticRel);
          stepArtifacts.push(diagnosticRel);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.screenshot",
            action: "failed",
            stepId,
            path: rel,
            error,
          });

          // Screenshots are best-effort evidence, never part of the contract.
          // A capture timeout is recorded as a warning + missing-artifact note
          // (the diagnostic above, with action:"failed" on the event) but must
          // NOT fail the step or spec. A capture timeout marks the backend
          // wedged only when the backend had to stop its browser over it
          // (agent-browser: the capture still blocked its daemon after a 20s
          // drain; Playwright: any capture timeout); the flag then skips
          // diagnostics and further OPTIONAL captures
          // (console/network/trace/video). A genuinely wedged page fails
          // naturally on its next real interaction.
        }
      }
      if (stepStatus !== "passed" && !opts.backend.isWedged?.()) {
        const rel = `diagnostics/${pad(i + 1)}_${stepId}.json`;
        const captured = await captureDiagnostics(
          opts.backend,
          step,
          stepError,
        );
        // The diagnostics eval already read location.href: reuse it for the
        // step event instead of paying another backend round-trip.
        stepUrl = diagnosticsUrl(captured);
        await writer.writeJson(rel, captured, "diagnostic");
        latestDiagnostics = rel;
        diagnostics.push(rel);
        stepArtifacts.push(rel);
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "artifact.diagnostics",
          stepId,
          path: rel,
        });
      }
    }

    const durationMs = Date.now() - stepStart;
    stepResults.push({
      id: stepId,
      status: stepStatus,
      durationMs,
      ...(stepError ? { error: stepError } : {}),
      ...(stepArtifacts.length > 0 ? { artifacts: stepArtifacts } : {}),
      ...(stepResolved ? { resolved: stepResolved } : {}),
    });

    if (stepStatus === "passed" && "open" in stepToRun) {
      stepUrl = openPath(stepToRun);
    }
    const stepEndTs = new Date().toISOString();
    const stepEnd = {
      stepId,
      durationMs,
      ...(stepResolved ? { resolved: stepResolved } : {}),
      ...(stepUrl ? { url: withoutQuery(stepUrl) } : {}),
      ...(stepScreenshot ? { screenshot: stepScreenshot } : {}),
    };
    await writer.appendEvent(
      stepStatus === "passed"
        ? { ts: stepEndTs, type: "step.finished", ...stepEnd }
        : {
            ts: stepEndTs,
            type: "step.failed",
            ...stepEnd,
            ...(stepError ? { error: stepError } : {}),
          },
    );
    listener.onStepFinish?.(i, stepId, stepStatus, durationMs, stepError);

    if (stepStatus === "passed") {
      lastSuccessfulStep = step;
    } else {
      // Stop on first failure to avoid cascading noise.
      break;
    }
  }

  // A child-timeout kill leaves the adapter's command channel untrustworthy.
  // Keep the artifacts already written and skip only the OPTIONAL follow-up
  // captures (console/network, trace/video) that would queue behind the same
  // wedged daemon and turn one bounded failure into several more timeouts.
  // Outcome evaluation is NOT gated on this — the contract always runs (see
  // the evaluateOutcomes call below).
  const backendWedgedAfterSteps =
    opts.backend.isWedged?.() === true || cancelled();

  // Stop the process sampler (if it ever started) and reduce its samples into
  // diagnostics/process.{json,md}. Zero-cost when monitoring was disabled or
  // no browser PID ever became available.
  let processMetricsArtifact: string | undefined;
  if (sampler) {
    processMetricsSummary = await sampler.stop();
    if (
      processMetricsSummary.samples.length > 0 ||
      processMetricsSummary.tree.length > 0
    ) {
      const jsonRel = "diagnostics/process.json";
      const mdRel = "diagnostics/process.md";
      await writer.writeJson(jsonRel, processMetricsSummary, "process-metrics");
      await writer.writeText(
        mdRel,
        renderProcessMarkdown(processMetricsSummary),
        "process-metrics",
      );
      processMetricsArtifact = jsonRel;
      diagnostics.push(mdRel);
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.monitor",
        action: "summary",
        path: jsonRel,
        samples: processMetricsSummary.samples.length,
        peakRssBytes: processMetricsSummary.peakRssBytes,
        peakCpuPercent: processMetricsSummary.peakCpuPercent,
      });
    }
  }

  // Persist console + network even on full pass, so agents have evidence to skim.
  // Read errors once here. The console verifier reuses this snapshot so a
  // long script outcome cannot hang a second `getErrors()` on a stale daemon.
  const consoleEntries = backendWedgedAfterSteps
    ? []
    : await safe(() => opts.backend.getConsole()).then((x) => x ?? []);
  const networkEntries = backendWedgedAfterSteps
    ? []
    : await safe(() => opts.backend.getNetworkRequests()).then((x) => x ?? []);
  let capturedConsoleErrors: ConsoleEntry[] | undefined;
  let consoleUnavailable: string | undefined;
  if (backendWedgedAfterSteps) {
    consoleUnavailable =
      "console was not captured because the backend was wedged";
  } else {
    try {
      capturedConsoleErrors = await opts.backend.getErrors();
    } catch (error) {
      consoleUnavailable = (error as Error).message;
    }
  }
  const consoleErrors =
    capturedConsoleErrors ?? consoleEntries.filter((e) => e.type === "error");
  await writer.writeNdjson("console/console.ndjson", consoleEntries, "console");
  await writer.writeNdjson("console/errors.ndjson", consoleErrors, "console");
  const failedNetwork = networkEntries.filter(
    (e) => e.status !== undefined && e.status >= 400,
  );
  await writer.writeNdjson(
    "network/requests.ndjson",
    networkEntries,
    "network",
  );
  await writer.writeNdjson(
    "network/failed_requests.ndjson",
    failedNetwork,
    "network",
  );

  // Stop trace recording: Playwright → traces/playwright-trace.zip (Trace
  // Viewer), agent-browser → traces/agent-browser-trace.json (Chrome
  // trace-event JSON for Perfetto). A failed stop, an empty file or one over
  // traceMaxBytes is dropped with an artifact.trace event, never a failure.
  const { path: traceRelPath, format: traceFormat } =
    tracePathForBackend(backendName);
  let tracePath: string | undefined;
  if (
    !backendWedgedAfterSteps &&
    policy.trace !== "never" &&
    opts.backend.stopTrace
  ) {
    const traceResult = await safe(async () =>
      opts.backend.stopTrace?.(await writer.preparePath(traceRelPath, "trace")),
    );
    tracePath = await safe(() =>
      checkStoppedTrace({
        writer,
        relativePath: traceRelPath,
        format: traceFormat,
        stopped: traceResult,
        maxBytes:
          spec.artifacts?.capture?.traceMaxBytes ?? DEFAULT_TRACE_MAX_BYTES,
      }),
    );
  }

  // The video is finalized after outcome evaluation. Playwright cannot save a
  // recording until its page/context closes, while outcome verifiers still
  // need that live page.
  const videoRelPath = `videos/${backendName}-video.webm`;
  let videoPath: string | undefined;

  // Evaluate outcomes first so we know whether the run failed before
  // deciding whether to auto-cut video clips.
  const failedStep = stepResults.find((s) => s.status === "failed")?.id;
  const ctx: ScriptVerifierContext = {
    lastSuccessfulStep: lastSuccessfulStep?.id,
    ...(failedStep ? { failedStep } : {}),
    latestScreenshot,
    latestSnapshot,
    latestDiagnostics,
    ...(tracePath ? { trace: tracePath } : {}),
    ...(videoPath ? { video: videoPath } : {}),
    runDir,
    specDir: dirname(specPath),
    artifacts: namedArtifacts,
    responses,
    evals: evalValues,
    networkEntries,
    ...(capturedConsoleErrors !== undefined
      ? { consoleErrors: capturedConsoleErrors }
      : {}),
    ...(consoleUnavailable !== undefined ? { consoleUnavailable } : {}),
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    vars: resolvedVars,
    childEnv: opts.childEnv ?? runEnv,
    ...(opts.selectedTvaultKeys !== undefined
      ? { selectedTvaultKeys: opts.selectedTvaultKeys }
      : {}),
    ...(processMetricsSummary ? { processMetrics: processMetricsSummary } : {}),
    // A node script verifier's process tree is killed on cancel.
    ...(opts.signal ? { signal: opts.signal } : {}),
    // F4/F16: the environment's datasources; ${captures.*} (capture steps,
    // then verifier assigns), ${runs.*} and ${run.startedAt} for verifiers.
    datasources: resolveEnvironmentDatasources(
      runtime.config?.datasources,
      runtime.config?.environments[env]?.datasources,
    ),
    envName: env,
    captures: captureValues,
    runOutputs: runValues,
    runStartedAt: startedAt,
    // SDK `ctx.run`: this run's identity, so a verifier can scope its
    // queries to the records the run created (token) or its cohort (labels).
    runInfo: {
      id: runId,
      token: runToken,
      startedAt,
      ...(opts.labels && Object.keys(opts.labels).length > 0
        ? { labels: opts.labels }
        : {}),
    },
    // F3b: ${fixtures.<name>.<key>} for verifiers.
    ...(fixtures ? { fixtureOutputs: fixtures.outputs() } : {}),
    ...(runtime.browser?.testIdAttribute
      ? { testIdAttribute: runtime.browser.testIdAttribute }
      : {}),
  };
  listener.onOutcomesStart?.(resolved.outcomes.length);
  // Outcomes are the contract and are ALWAYS evaluated, even when the backend
  // marked itself wedged after a screenshot/child timeout. The verifiers carry
  // their own bounded deadlines, so a genuinely unresponsive page fails each
  // check naturally instead of every outcome being silently voided; a page
  // that merely lost its compositing surface (e.g. a slept display) still
  // reports real pass/fail. The wedged flag only skips the optional artifact
  // captures above (console/network/trace/video).
  // Listener calls ride the evaluation loop itself: a long verifier poll used
  // to buffer EVERY outcome line until the whole set finished, so two 5-min
  // polls meant ten silent minutes and then all verdicts at once. The
  // outcome.started / outcome.<status> events ride the same hooks so
  // events.ndjson is live too. The hooks are synchronous; ArtifactWriter
  // serializes appends, so the un-awaited writes keep their order.
  if (resolved.outcomes.length > 0) await tracker.enter("outcomes");
  const outcomeStartedAt = new Map<string, number>();
  // Node script verifiers run as child processes: their stdout/stderr go to
  // logs/outcome-<id>.log and lines they report through ctx.progress()
  // (CAIRN_PROGRESS_FILE) become outcome.progress events while they run.
  let scriptRun: { log: LiveLog; tail?: ProgressTail } | undefined;
  const endScriptRun = (): void => {
    if (!scriptRun) return;
    scriptRun.tail?.stop();
    if (scriptRun.tail) lifecycle.tails.delete(scriptRun.tail);
    scriptRun.log.close();
    lifecycle.logs.delete(scriptRun.log);
    scriptRun = undefined;
    delete ctx.scriptRun;
  };
  const outcomeHooks: {
    onStart(outcome: Outcome): void;
    onFinish(outcome: Outcome, evaluation: VerifierEvaluation): void;
  } = {
    onStart: (outcome) => {
      const timeoutMs = verifierTimeoutMs(outcome.verify);
      outcomeStartedAt.set(outcome.id, Date.now());
      tracker.setItem(outcome.id, timeoutMs);
      void writer
        .appendEvent({
          ts: new Date().toISOString(),
          type: "outcome.started",
          outcomeId: outcome.id,
          kind: verifierKind(outcome.verify),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        })
        .catch(() => undefined);
      if (
        isScriptVerifier(outcome.verify) &&
        outcome.verify.script.runtime === "node"
      ) {
        const logPath = `logs/outcome-${logSlug(outcome.id)}.log`;
        const outcomeLog = openRunLog(writer, redactor, logPath);
        lifecycle.logs.add(outcomeLog);
        void writer
          .appendEvent({
            ts: new Date().toISOString(),
            type: "log.opened",
            kind: "outcome",
            name: outcome.id,
            path: logPath,
          })
          .catch(() => undefined);
        const progressFile = progressFiles.create(`outcome-${outcome.id}`);
        const tail = progressFile
          ? new ProgressTail(progressFile, {
              onMessage: (message) => {
                void writer
                  .appendEvent({
                    ts: new Date().toISOString(),
                    type: "outcome.progress",
                    outcomeId: outcome.id,
                    message,
                  })
                  .catch(() => undefined);
                listener.onOutcomeProgress?.(outcome, redactor.text(message));
              },
            }).start()
          : undefined;
        if (tail) lifecycle.tails.add(tail);
        scriptRun = { log: outcomeLog, ...(tail ? { tail } : {}) };
        ctx.scriptRun = {
          onOutputLine: (_stream, line) => outcomeLog.writeLine(line),
          ...(progressFile ? { progressFile } : {}),
        };
      }
      listener.onOutcomeStart?.(outcome);
    },
    onFinish: (outcome, evaluation) => {
      // Drain the progress file first so the last message precedes the verdict.
      endScriptRun();
      const started = outcomeStartedAt.get(outcome.id);
      void writer
        .appendEvent({
          ts: new Date().toISOString(),
          type: evaluation.skipped
            ? "outcome.skipped"
            : evaluation.passed
              ? "outcome.passed"
              : "outcome.failed",
          outcomeId: outcome.id,
          ...(started !== undefined
            ? { durationMs: Math.max(0, Date.now() - started) }
            : {}),
          // F5: how long a polled verifier waited and how often it looked.
          ...(evaluation.attempts !== undefined
            ? { attempts: evaluation.attempts }
            : {}),
          ...(evaluation.polledMs !== undefined
            ? { polledMs: Math.max(0, Math.round(evaluation.polledMs)) }
            : {}),
        })
        .catch(() => undefined);
      listener.onOutcomeFinish?.(outcome, evaluation);
    },
  };
  // F5: a polling verifier narrates its attempts as outcome.progress.
  const onOutcomeProgress = (outcome: Outcome, message: string): void => {
    void writer
      .appendEvent({
        ts: new Date().toISOString(),
        type: "outcome.progress",
        outcomeId: outcome.id,
        message,
      })
      .catch(() => undefined);
    listener.onOutcomeProgress?.(outcome, redactor.text(message));
  };
  // One outcome at a time so a cancel can stop between them and abandon the
  // one in flight (a node script's process tree is killed through ctx.signal;
  // a late result of an abandoned verifier is ignored). Remaining outcomes
  // are reported skipped.
  const evaluated: EvaluatedOutcome[] = [];
  for (const outcome of resolved.outcomes) {
    if (cancelled()) {
      const evaluation = cancelledEvaluation();
      outcomeHooks.onFinish(outcome, evaluation);
      evaluated.push({ outcome, evaluation });
      continue;
    }
    let abandoned = false;
    const settled = await raceAbort(
      evaluateOutcomes([outcome], opts.backend, ctx, {
        onStart: (o) => {
          if (!abandoned) outcomeHooks.onStart(o);
        },
        onFinish: (o, e) => {
          if (!abandoned) outcomeHooks.onFinish(o, e);
        },
        onProgress: (o, message) => {
          if (!abandoned) onOutcomeProgress(o, message);
        },
      }),
      opts.signal,
    );
    if (settled === ABORTED) {
      abandoned = true;
      const evaluation = cancelledEvaluation();
      outcomeHooks.onFinish(outcome, evaluation);
      evaluated.push({ outcome, evaluation });
      continue;
    }
    evaluated.push(...settled);
  }
  endScriptRun();
  // A cancel that landed before every verdict was in: the run is errored
  // (failure.phase "cancelled"), whatever the partial verdicts say.
  const cancelledBeforeVerdict = cancelled();

  const outcomeResults: OutcomeResult[] = [];
  for (const { outcome, evaluation } of evaluated) {
    const outcomeStatus: OutcomeResult["status"] = evaluation.skipped
      ? "skipped"
      : evaluation.passed
        ? "passed"
        : "failed";
    outcomeResults.push({
      id: outcome.id,
      status: outcomeStatus,
      evidence: `outcomes/${outcome.id}.md`,
      ...(evaluation.raw !== undefined
        ? { evidenceRaw: `outcomes/${outcome.id}.raw.json` }
        : {}),
    });
  }

  // F3a: the spec teardown runs after the outcomes, while the browser is
  // still up and before the verdict is written; it sees the would-be status
  // (CAIRN_RUN_STATUS). Only `failRun: true` lets it change a passed run.
  const verdictBeforeTeardown: TeardownRunStatus =
    didError || cancelledBeforeVerdict
      ? "errored"
      : stepResults.some((s) => s.status === "failed") ||
          outcomeResults.some((o) => o.status === "failed")
        ? "failed"
        : "passed";
  const teardownResult = await runSpecTeardown(verdictBeforeTeardown);
  // F3b: the run's fixtures are torn down after the spec teardown (newest
  // first); a failed fixture teardown is reported, never changes the status.
  await settleFixtures(verdictBeforeTeardown);
  const teardownFailure =
    teardown.failRun && verdictBeforeTeardown === "passed"
      ? teardownResult?.failed[0]
      : undefined;

  const endedAt = new Date().toISOString();
  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  const stepFailed = stepResults.some((s) => s.status === "failed");
  const outcomeFailed = outcomeResults.some((o) => o.status === "failed");
  const status: RunResult["status"] =
    didError || cancelledBeforeVerdict || teardownFailure
      ? "errored"
      : stepFailed || outcomeFailed
        ? "failed"
        : "passed";
  const exitCode: ExitCode =
    status === "errored" ? 2 : status === "failed" ? 1 : 0;

  // Canonical failure reason + one-line summary (FEATURES item 1). On a
  // non-passing run the first failed step wins (it stopped the run and is the
  // root cause); otherwise the first failed outcome carries the reason. The
  // summary is always populated so a consumer can surface a single line
  // without scanning steps[]/outcomes[].
  const failedStepResult = stepResults.find((s) => s.status === "failed");
  const failedOutcomeIdx = outcomeResults.findIndex(
    (o) => o.status === "failed",
  );
  let failure: RunFailure | undefined;
  let summary: string;
  if (status === "passed") {
    const passedOutcomes = outcomeResults.filter(
      (o) => o.status === "passed",
    ).length;
    summary = `${passedOutcomes}/${outcomeResults.length} outcomes passed`;
  } else if (failedStepResult?.id === SESSION_RESUME_STEP) {
    // The checkpoint could not be restored: an environment problem, not
    // locator drift (no brief, no heal hint).
    const message = failedStepResult.error ?? "session.resume failed";
    failure = {
      phase: "session",
      ...(spec.session?.resume ? { name: spec.session.resume } : {}),
      step: SESSION_RESUME_STEP,
      message,
    };
    summary = `errored at step '${SESSION_RESUME_STEP}': ${message}`;
  } else if (failedStepResult) {
    const stepMsg =
      failedStepResult.error ?? `step '${failedStepResult.id}' failed`;
    const failedIndex = stepResults.findIndex(
      (s) => s.id === failedStepResult.id,
    );
    const specSteps = resolved.steps ?? [];
    const specStep =
      specSteps.find(
        (s, i) => (s.id ?? `step_${i + 1}`) === failedStepResult.id,
      ) ?? (failedIndex >= 0 ? specSteps[failedIndex] : undefined);
    failure = {
      step: failedStepResult.id,
      message: stepMsg,
      ...(specStep && isBriefableStep(specStep)
        ? {
            brief: {
              step: redactBriefStep(
                briefStepFromSpecStep(
                  specStep,
                  failedIndex >= 0 ? failedIndex : 0,
                ),
                runEnv,
                opts.secretValues ?? [],
              ),
              error: stepMsg,
            },
          }
        : {}),
    };
    summary =
      status === "errored"
        ? `errored at step '${failedStepResult.id}': ${stepMsg}`
        : `step '${failedStepResult.id}' failed: ${stepMsg}`;
  } else if (failedOutcomeIdx >= 0) {
    const failedOutcome = outcomeResults[failedOutcomeIdx]!;
    const evalEntry = evaluated[failedOutcomeIdx]?.evaluation;
    const detail = evalEntry
      ? `expected ${evalEntry.expected}; actual ${evalEntry.actual}`
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)
      : "verifier failed";
    failure = {
      outcome: failedOutcome.id,
      message: `outcome '${failedOutcome.id}' failed: ${detail}`,
    };
    summary = `outcome '${failedOutcome.id}' failed`;
  } else if (teardownFailure) {
    // F3a `teardown: {failRun: true}`: a failed cleanup errors a passed run.
    failure = {
      phase: "teardown",
      name: teardownFailure.stepId,
      message: `teardown step '${teardownFailure.stepId}' failed: ${teardownFailure.error}`,
    };
    summary = `errored in teardown '${teardownFailure.stepId}': ${teardownFailure.error}`;
  } else {
    summary = status;
  }
  if (cancelledBeforeVerdict) {
    failure = {
      phase: "cancelled",
      ...(failure?.step ? { step: failure.step } : {}),
      message: RUN_CANCELLED_MESSAGE,
    };
    summary = `cancelled: ${RUN_CANCELLED_MESSAGE}${
      failedStepResult ? ` (at step '${failedStepResult.id}')` : ""
    }`;
  }

  // Now that every verifier has finished with the page, finalize the browser
  // context and save the recording.
  if (!backendWedgedAfterSteps && policy.video !== "never") {
    const videoResult = await safe(async () =>
      opts.backend.stopVideo?.(await writer.preparePath(videoRelPath, "video")),
    );
    if (videoResult?.ok) {
      videoPath = videoRelPath;
    }
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "stop",
      ...(videoPath ? { path: videoPath } : {}),
    });
  }

  // Honor the trace capture policy: with the default "on-failure", a passing
  // run deletes its trace (they're the bulk of artifact disk usage).
  if (tracePath && status === "passed" && policy.trace !== "always") {
    await safe(() => writer.remove(traceRelPath));
    tracePath = undefined;
  }
  // A kept trace is sanitized in place (best effort: credential headers,
  // cookies, storage state, password-field values, sensitive params and
  // registered secrets → [redacted]) and marked in the manifest: `sanitized`
  // (stashable on opt-in, never published), or `secret-bearing` when it
  // could not be rewritten (stash/publish gate).
  if (tracePath) {
    await safe(() =>
      sanitizeKeptTrace({
        writer,
        relativePath: traceRelPath,
        format: traceFormat,
        redactor,
        sensitiveNames: [
          ...(spec.redaction?.headers ?? []),
          ...(spec.redaction?.storageKeys ?? []),
          ...(spec.redaction?.queryParams ?? []),
        ],
      }),
    );
  }

  // Same policy applies to video: a passing run with `on-failure` deletes
  // the .webm to save disk (videos are larger than traces).
  if (videoPath && status === "passed" && policy.video !== "always") {
    await safe(() => writer.remove(videoRelPath));
    videoPath = undefined;
  }

  // Auto-cut clips from spec points when the run failed and video is kept.
  const clips: Record<string, string> = {};
  const clipPoints = spec.artifacts?.clipPoints;
  if (status === "failed" && videoPath && clipPoints && clipPoints.length > 0) {
    const vidtrace = await isVidtraceAvailable();
    if (vidtrace.available) {
      const labels = clipPointsToLabels(clipPoints);
      const cutResult = await cutClipsWithVidtrace(
        writer.resolve(videoRelPath),
        labels,
        {
          outputDir: await writer.ensureDir("videos/clips"),
          name: spec.name,
          tags: runtime.config?.clips?.tags ?? spec.artifacts?.clipTags ?? [],
          reencode: false,
        },
      );
      if (cutResult.ok && cutResult.clips && cutResult.clips.length > 0) {
        const movedClips = await moveClipsIntoRunDir(runDir, cutResult);
        for (const relativePath of Object.values(movedClips)) {
          writer.registerExisting(relativePath, "clip");
        }
        Object.assign(clips, movedClips);
        if (Object.keys(clips).length > 0) {
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.video",
            action: "clip",
            clips,
          });
        }
      } else if (cutResult.error) {
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "artifact.video",
          action: "clip",
          error: cutResult.error,
        });
      }
    } else {
      // Clips were requested but vidtrace isn't installed — surface it
      // instead of silently dropping the evidence the user asked for.
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.video",
        action: "clip",
        error:
          "vidtrace not found on PATH — clipPoints were requested but no clips were cut. Install vidtrace to enable failure clip extraction.",
      });
    }
  }

  // Write outcome evidence, including clips in the source when available.
  for (const { outcome, evaluation } of evaluated) {
    const outcomeStatus: OutcomeResult["status"] = evaluation.skipped
      ? "skipped"
      : evaluation.passed
        ? "passed"
        : "failed";
    await writer.writeOutcomeEvidence({
      outcomeId: outcome.id,
      status: outcomeStatus,
      description: outcome.description,
      expected: evaluation.expected,
      actual: evaluation.actual,
      source: {
        ...(ctx.lastSuccessfulStep
          ? { lastSuccessfulStep: ctx.lastSuccessfulStep }
          : {}),
        ...(latestScreenshot ? { screenshot: latestScreenshot } : {}),
        ...(latestSnapshot ? { snapshot: latestSnapshot } : {}),
        ...(latestDiagnostics ? { diagnostics: latestDiagnostics } : {}),
        ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
        ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
        ...(Object.keys(evals).length > 0 ? { evals } : {}),
        ...(tracePath ? { trace: tracePath } : {}),
        ...(videoPath ? { video: videoPath } : {}),
        ...(Object.keys(clips).length > 0 ? { clips } : {}),
      },
      ...(evaluation.raw !== undefined ? { raw: evaluation.raw } : {}),
      whyThisMatters: outcome.description,
    });
  }

  // Service processes are still alive here, so capture their bounded tails
  // before the CLI tears the shared lifecycle down. Diagnostic collection is
  // deliberately outside durationMs and cannot change the behavioral verdict.
  const servicesArtifact = await writeServicesArtifacts({
    writer,
    capture: opts.captureServicesArtifacts,
    status,
    runWindow: { startedAt, endedAt },
  });

  const artifacts: RunArtifacts = {
    report: "report.html",
    reportJson: "report.json",
    agentContext: "agent_context.md",
    events: "events.ndjson",
    console: "console/errors.ndjson",
    network: "network/failed_requests.ndjson",
    ...(latestScreenshot ? { screenshots: [latestScreenshot] } : {}),
    ...(latestSnapshot ? { snapshots: [latestSnapshot] } : {}),
    ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(evals).length > 0 ? { evals } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(servicesArtifact ? { services: servicesArtifact } : {}),
    ...(tracePath ? { trace: tracePath } : {}),
    ...(processMetricsArtifact
      ? { processMetrics: processMetricsArtifact }
      : {}),
    ...(videoPath ? { video: videoPath } : {}),
    ...(Object.keys(clips).length > 0 ? { clips } : {}),
    replay: "replay.json",
    manifest: "artifact-manifest.json",
  };
  const labels =
    opts.labels && Object.keys(opts.labels).length > 0
      ? opts.labels
      : undefined;
  const result: RunResult = {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    runDir,
    spec: {
      name: spec.name,
      path: specPath,
      // Always populate contractHash (FEATURES nice-to-have): stamped specs
      // carry it; unstamped specs get the on-the-fly sha256 over intent +
      // outcomes, matching what `cairn spec verify --stamp` would write.
      contractHash: spec.contractHash ?? computeContractHash(spec),
    },
    environment: env,
    backend: backendName as RunResult["backend"],
    coldStart,
    ...(labels ? { labels } : {}),
    ...(opts.invocation ? { invocation: opts.invocation } : {}),
    status,
    summary,
    ...(failure ? { failure } : {}),
    startedAt,
    endedAt,
    durationMs,
    outcomes: outcomeResults,
    steps: stepResults,
    artifacts,
    exitCode,
  };

  const publicResult = redactor.value(result);
  await writer.writeRun(publicResult);
  await writer.writeOutcomesIndex(publicResult);
  await writer.writeAgentContext(spec, publicResult);

  // Exact-replay manifest (SPEC §7.3): replay.json captures everything an
  // agent needs to reproduce the run without re-reading the resolved spec.
  // Env/var VALUES are never included — only key names — and the writer
  // redacts. Best-effort: a write failure must never fail the completed run.
  await safe(() =>
    writer.writeReplay(
      buildReplayManifest({
        runId,
        specName: spec.name,
        specPath,
        ...(spec.contractHash
          ? { contractHash: spec.contractHash }
          : { contractHash: computeContractHash(spec) }),
        backend: backendName,
        ...(env ? { environment: env } : {}),
        ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
        ...(viewport ? { viewport } : {}),
        capturePolicy: policy,
        envKeys: Object.keys(runtime.vars),
        cairnVersion: CAIRN_VERSION,
        generatedAt: endedAt,
      }),
    ),
  );
  // The run settles here. Stop heartbeats before the final event so nothing
  // is appended after run.* or after the manifest checksums events.ndjson.
  tracker.stop();
  await writer.appendEvent(
    status === "passed"
      ? { ts: endedAt, type: "run.passed", runId, durationMs }
      : status === "failed"
        ? { ts: endedAt, type: "run.failed", runId, durationMs }
        : {
            ts: endedAt,
            type: "run.errored",
            runId,
            durationMs,
            ...(failure?.phase ? { phase: failure.phase } : {}),
            ...(failure?.phase && failure.name ? { name: failure.name } : {}),
          },
  );
  // run.log is complete before the manifest checksums it.
  narration.onRunEnd?.(publicResult);
  runLog.close();
  await writer.writeManifest(artifacts.manifest);
  opts.listener?.onRunEnd?.(publicResult);

  // Auto-prune the artifact root per the config retention policy. Best-effort
  // — a prune failure must never fail the run that just completed. Default
  // keepRuns is 3 (see DEFAULT_KEEP_RUNS) when no retention block is set;
  // retention.enabled: false disables pruning entirely.
  await applyRunRetention({
    retention: runtime.config?.retention,
    stash: runtime.config?.stash,
    artifactRoot,
    writer,
    opts,
  });

  return publicResult;
}

const SERVICES_MANIFEST_PATH = "services/manifest.json";

/**
 * Attach a services lifecycle bundle to the current run without allowing
 * observability failures to rewrite the test result. The services layer owns
 * collection and bounds; ArtifactWriter owns confinement, redaction and file
 * permissions.
 */
async function writeServicesArtifacts(input: {
  writer: ArtifactWriter;
  capture: RunOptions["captureServicesArtifacts"];
  status: ServicesRunStatus;
  runWindow: ServicesRunWindow;
}): Promise<string | undefined> {
  if (!input.capture) return undefined;

  try {
    const bundle = await input.capture(input.status, input.runWindow);
    if (!bundle.captured) return undefined;

    for (const file of bundle.files) {
      await input.writer.writeText(
        file.relativePath,
        file.content,
        `services-${file.source}`,
      );
    }

    await input.writer.writeJson(
      SERVICES_MANIFEST_PATH,
      {
        $schema: "urn:cairntrace.dev:service-artifacts:v1",
        version: bundle.version,
        status: bundle.status,
        capturedAt: bundle.capturedAt,
        runWindow: bundle.runWindow,
        policy: bundle.policy,
        ownership: bundle.ownership,
        files: bundle.files.map((file) => ({
          source: file.source,
          path: file.relativePath,
          label: file.label,
          bytes: file.bytes,
          truncated: file.truncated,
          ...(file.metadata ? { metadata: file.metadata } : {}),
        })),
        errors: bundle.errors,
        totalBytes: bundle.totalBytes,
        truncated: bundle.truncated,
      },
      "services-manifest",
    );
    await input.writer.appendEvent({
      ts: bundle.capturedAt,
      type: "artifact.services",
      action: "capture",
      path: SERVICES_MANIFEST_PATH,
      sources: bundle.files.length,
      errors: bundle.errors.length,
      totalBytes: bundle.totalBytes,
      truncated: bundle.truncated,
    });
    return SERVICES_MANIFEST_PATH;
  } catch (error) {
    // Capture is diagnostic-only. Preserve the browser/outcome verdict and
    // leave a redacted event explaining why no service manifest was linked.
    await safe(() =>
      input.writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.services",
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

/**
 * Reason code + one-line, path-free message of an archive/publish failure
 * for `artifact.*` events.
 */
function transferFailure(error: unknown): {
  reason: ReturnType<typeof evidenceFailureReason>;
  message: string;
} {
  return {
    reason: evidenceFailureReason(error),
    message: pathFreeMessage(
      error instanceof Error ? error.message : String(error),
    ),
  };
}

/**
 * Auto-prune after a run. Archive/publish outcomes of the pruned runs are
 * recorded on THIS run's events (`artifact.stash` action `archive`,
 * `artifact.publish`, `artifact.retention` warnings for runs retained because
 * archiving failed, and an error event when the prune itself throws) — a
 * retention failure never fails the run that just completed.
 */
async function applyRunRetention(input: {
  retention: RetentionConfig | undefined;
  /** Config `stash` block: the archive evidence gate and TTL. */
  stash?: StashConfig | undefined;
  artifactRoot: string;
  writer: ArtifactWriter;
  opts: RunOptions;
}): Promise<PruneResult | undefined> {
  const { retention, artifactRoot, writer, opts } = input;
  const keepRuns =
    retention?.enabled === false
      ? undefined
      : Math.max(
          retention?.keepRuns ?? DEFAULT_KEEP_RUNS,
          opts.minKeepRuns ?? 0,
        );
  if (keepRuns === undefined) return undefined;

  const requiresArchive = retention?.archiveToStash === true;
  const requiresPublication = retention?.publish?.enabled === true;
  if (
    (requiresArchive && !opts.onArchiveRun) ||
    (requiresPublication && !opts.onPublishRun)
  ) {
    // Fail closed: deleting without the configured archive callback would
    // violate the user's retention policy. Some callers (for example
    // library/MCP integrations) do not inject the CLI's file.cheap adapter.
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.retention",
      action: "warning",
      warning: requiresPublication
        ? "retention.publish.enabled is true but no publication adapter was provided; pruning was skipped"
        : "retention.archiveToStash is enabled but no archive adapter was provided; pruning was skipped",
    });
    return undefined;
  }

  const record = (event: RunEvent): Promise<unknown> =>
    safe(() => writer.appendEvent(event));
  // Archive pruned runs to fcheap before deletion when configured. The
  // archive callback is injected via opts so the core runner doesn't depend
  // on the stash (fcheap) CLI module. Throwing keeps the run on disk.
  const onArchive =
    (requiresArchive || requiresPublication) &&
    (opts.onArchiveRun || opts.onPublishRun)
      ? async (dir: string, rid: string) => {
          const tags = [
            ...(retention?.archiveTags ?? []),
            "retention-archived",
          ];
          if (requiresArchive) {
            try {
              const saved = await opts.onArchiveRun!(dir, rid, tags, {
                ...(input.stash?.include
                  ? { include: input.stash.include }
                  : {}),
                ...(input.stash?.unsafeIncludeRawTraces
                  ? { unsafeIncludeRawTraces: true }
                  : {}),
                ...(input.stash?.ttl ? { ttl: input.stash.ttl } : {}),
              });
              await record({
                ts: new Date().toISOString(),
                type: "artifact.stash",
                action: "archive",
                runId: rid,
                status: saved?.status ?? "saved",
                ...(saved?.stashId ? { stashId: saved.stashId } : {}),
                ...(saved?.excluded?.length
                  ? { excluded: saved.excluded }
                  : {}),
                ...(saved?.ttl ? { ttl: saved.ttl } : {}),
                ...(saved?.expiresAt ? { expiresAt: saved.expiresAt } : {}),
                tags: saved?.tags ?? tags,
              });
            } catch (error) {
              await record({
                ts: new Date().toISOString(),
                type: "artifact.stash",
                action: "archive",
                runId: rid,
                status: "error",
                ...transferFailure(error),
              });
              throw error;
            }
          }
          if (requiresPublication) {
            try {
              const published = await opts.onPublishRun!(
                dir,
                rid,
                tags,
                retention?.publish?.retentionDays ?? 7,
                retention?.publish?.include
                  ? { include: retention.publish.include }
                  : {},
              );
              await record({
                ts: new Date().toISOString(),
                type: "artifact.publish",
                runId: rid,
                status: "published",
                ...(published?.artifactRef
                  ? { artifactRef: published.artifactRef }
                  : {}),
                ...(published?.webUrl ? { webUrl: published.webUrl } : {}),
                ...(published?.excluded?.length
                  ? { excluded: published.excluded }
                  : {}),
              });
            } catch (error) {
              await record({
                ts: new Date().toISOString(),
                type: "artifact.publish",
                runId: rid,
                status: "error",
                ...transferFailure(error),
              });
              throw error;
            }
          }
        }
      : undefined;
  const keepFailedRuns = retention?.keepFailedRuns ?? DEFAULT_KEEP_FAILED_RUNS;
  let pruned: PruneResult;
  try {
    pruned = await pruneRuns(artifactRoot, {
      keepRuns,
      keepFailedRuns,
      ...(onArchive ? { onArchive } : {}),
    });
  } catch (error) {
    await record({
      ts: new Date().toISOString(),
      type: "artifact.retention",
      action: "error",
      warning: `retention prune failed: ${transferFailure(error).message}`,
    });
    return undefined;
  }
  for (const archiveFailure of pruned.archiveFailures) {
    await record({
      ts: new Date().toISOString(),
      type: "artifact.retention",
      action: "warning",
      runId: archiveFailure.runId,
      reason: archiveFailure.reason ?? "unknown",
      warning: `archiving ${archiveFailure.runId} failed (${pathFreeMessage(archiveFailure.error)}); the run was retained on disk`,
    });
  }
  if (
    onArchive &&
    (pruned.removed.length > 0 || pruned.archiveFailures.length > 0)
  ) {
    await record({
      ts: new Date().toISOString(),
      type: "artifact.retention",
      action: "summary",
      removed: pruned.removed.length,
      archiveFailures: pruned.archiveFailures.length,
    });
  }
  return pruned;
}

interface PreconditionFailureInput {
  writer: ArtifactWriter;
  redactor: ArtifactRedactor;
  spec: Spec;
  specPath: string;
  runId: string;
  runDir: string;
  environment: string;
  backend: string;
  coldStart: boolean;
  labels?: Record<string, string>;
  invocation?: RunInvocationRef;
  startedAt: string;
  name: string;
  durationMs: number;
  timedOut: boolean;
  signal?: string;
  message: string;
  listener?: ProgressListener;
  /** Runs after the final event and before the manifest (run.log end line). */
  beforeManifest?: (result: RunResult) => void;
  captureServicesArtifacts?: RunOptions["captureServicesArtifacts"];
  /**
   * Pre-browser phase that stopped the run (default `precondition`):
   * `session` (the session.resume checkpoint cannot be used) or
   * `cancelled` (the invocation was cancelled during preconditions).
   */
  phase?: "precondition" | "session" | "cancelled" | "fixture";
  /** Synthetic step id of a session failure (`session.resume`). */
  step?: string;
  /** Step results to report (the failed `session.resume` step). */
  steps?: StepResult[];
}

/** Marker {@link raceAbort} resolves with when the signal aborted first. */
const ABORTED: unique symbol = Symbol("aborted");

/**
 * Settle with `promise`, or with {@link ABORTED} as soon as `signal` aborts.
 * The abandoned promise keeps running; its rejection is swallowed.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolveRace, rejectRace) => {
    const onAbort = (): void => {
      promise.catch(() => undefined);
      resolveRace(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveRace(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectRace(error);
      },
    );
  });
}

/** The verdict of an outcome a cancel skipped (or abandoned mid-check). */
function cancelledEvaluation(): VerifierEvaluation {
  return {
    passed: false,
    skipped: true,
    expected: "the outcome to be evaluated",
    actual: "skipped: the invocation was cancelled",
  };
}

/** Synthetic step id of a `session.resume` that could not be restored. */
export const SESSION_RESUME_STEP = "session.resume";

/**
 * The failed `session.resume` step: step.started + step.failed events (so
 * live viewers show it like any step) and its StepResult.
 */
async function recordSessionResumeFailure(
  writer: ArtifactWriter,
  checkpoint: string,
  error: string,
  durationMs: number,
): Promise<StepResult> {
  const ts = new Date().toISOString();
  await writer.appendEvent({
    ts,
    type: "step.started",
    stepId: SESSION_RESUME_STEP,
    kind: "session",
    label: `resume ${checkpoint}`,
  });
  await writer.appendEvent({
    ts: new Date().toISOString(),
    type: "step.failed",
    stepId: SESSION_RESUME_STEP,
    durationMs,
    error,
  });
  return { id: SESSION_RESUME_STEP, status: "failed", durationMs, error };
}

/** Summary line of a run stopped before its browser steps. */
function earlyFailureSummary(input: PreconditionFailureInput): string {
  switch (input.phase ?? "precondition") {
    case "session":
      return `errored at step '${input.step ?? "session.resume"}': ${input.message}`;
    case "cancelled":
      return `cancelled in precondition '${input.name}': ${input.message}`;
    case "fixture":
      return `errored in fixture '${input.name}': ${input.message}`;
    default:
      return `errored in precondition '${input.name}': ${input.message}`;
  }
}

/**
 * Finalize a failure that occurs after the real run context exists but before
 * browser steps begin. This keeps the run discoverable by `cairn stats` and
 * prevents the CLI from replacing it with an unwritten parse/local/0ms shell.
 */
async function finalizePreconditionFailure(
  input: PreconditionFailureInput,
): Promise<RunResult> {
  const endedAt = new Date().toISOString();
  const durationMs = Math.max(
    input.durationMs,
    Date.parse(endedAt) - Date.parse(input.startedAt),
  );
  const labels =
    input.labels && Object.keys(input.labels).length > 0
      ? input.labels
      : undefined;
  const servicesArtifact = await writeServicesArtifacts({
    writer: input.writer,
    capture: input.captureServicesArtifacts,
    status: "errored",
    runWindow: { startedAt: input.startedAt, endedAt },
  });
  const artifacts: RunArtifacts = {
    report: "report.html",
    reportJson: "report.json",
    agentContext: "agent_context.md",
    events: "events.ndjson",
    ...(servicesArtifact ? { services: servicesArtifact } : {}),
    manifest: "artifact-manifest.json",
  };
  const result: RunResult = {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId: input.runId,
    runDir: input.runDir,
    spec: {
      name: input.spec.name,
      path: input.specPath,
      contractHash: input.spec.contractHash ?? computeContractHash(input.spec),
    },
    environment: input.environment,
    backend: input.backend as RunResult["backend"],
    coldStart: input.coldStart,
    ...(labels ? { labels } : {}),
    ...(input.invocation ? { invocation: input.invocation } : {}),
    status: "errored",
    summary: earlyFailureSummary(input),
    failure: {
      phase: input.phase ?? "precondition",
      name: input.name,
      ...(input.step ? { step: input.step } : {}),
      message: input.message,
      durationMs: input.durationMs,
      timedOut: input.timedOut,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    startedAt: input.startedAt,
    endedAt,
    durationMs,
    outcomes: [],
    steps: input.steps ?? [],
    artifacts,
    exitCode: 2,
  };

  const publicResult = input.redactor.value(result);
  await input.writer.appendEvent({
    ts: endedAt,
    type: "run.errored",
    runId: input.runId,
    phase: input.phase ?? "precondition",
    name: input.name,
    durationMs,
    timedOut: input.timedOut,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  await input.writer.writeRun(publicResult);
  await input.writer.writeOutcomesIndex(publicResult);
  await input.writer.writeAgentContext(input.spec, publicResult);
  input.beforeManifest?.(publicResult);
  await input.writer.writeManifest(artifacts.manifest);
  input.listener?.onRunEnd?.(publicResult);
  return publicResult;
}

/** Capture policies with sensible defaults. */
function mergeCapturePolicy(
  spec: Spec,
  override: RunOptions["captureOverride"] = {},
): {
  screenshots: "always" | "on-failure" | "never";
  snapshots: "always" | "on-failure" | "never";
  trace: "always" | "on-failure" | "never";
  video: "always" | "on-failure" | "never";
} {
  const c = spec.artifacts?.capture ?? {};
  return {
    screenshots: override.screenshots ?? c.screenshots ?? "on-failure",
    snapshots: override.snapshots ?? c.snapshots ?? "always",
    trace: override.trace ?? c.trace ?? "on-failure",
    video: override.video ?? c.video ?? "never",
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

const RUN_LOG_PATH = "run.log";

/** Phase item / narration label of a fixture verb (`fixture ensure kit`). */
function fixturePhaseLabel(verb: string, name: string): string {
  return `fixture ${verb} ${name}`;
}

/**
 * Open a live, line-redacted log inside the run directory and register it so
 * the artifact manifest lists it with the `log` kind.
 */
function openRunLog(
  writer: ArtifactWriter,
  redactor: ArtifactRedactor,
  relativePath: string,
): LiveLog {
  const log = new LiveLog(writer.resolve(relativePath), {
    redact: (line) => redactor.text(line),
  });
  // Every line goes through the run redactor: say so explicitly rather than
  // relying on the kind (a renamed kind must not turn it secret-bearing).
  writer.registerExisting(
    relativePath,
    relativePath === RUN_LOG_PATH ? "run-log" : "log",
    "redacted",
  );
  return log;
}

/** The declared budget of an outcome verifier, when it has one. */
function verifierTimeoutMs(verify: Verifier): number | undefined {
  for (const config of Object.values(verify)) {
    if (
      config !== null &&
      typeof config === "object" &&
      "timeoutMs" in config &&
      typeof config.timeoutMs === "number"
    ) {
      return config.timeoutMs;
    }
  }
  return undefined;
}

/** `location.href` from a captureDiagnostics() payload, when it has one. */
function diagnosticsUrl(captured: unknown): string | undefined {
  if (captured === null || typeof captured !== "object") return undefined;
  const url = "url" in captured ? captured.url : undefined;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

/** The last `max` characters of `text` (the whole text when shorter). */
function tailText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

function downloadRelativePath(saveAs: string): string {
  // Keep downloads inside the run directory even when a spec accidentally
  // provides an absolute or parent-relative path. Nested download paths are
  // deliberately collapsed for now to keep artifact references simple.
  return `downloads/${basename(saveAs)}`;
}

function transformRelativePath(saveAs: string): string {
  return `transforms/${basename(saveAs)}`;
}

function artifactNameFromPath(path: string): string {
  const raw = basename(path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(raw) ? raw : `artifact_${raw || "download"}`;
}

function resolveUploadPath(
  path: string,
  scope: StepFileScope,
  runDir: string,
  artifacts: Record<string, ArtifactRef>,
): string {
  const resolved = resolveArtifactPlaceholders(path, artifacts);
  const usedRelativeArtifact =
    /\$\{artifacts\.[a-z][A-Za-z0-9_]*\.relativePath\}/.test(path);
  if (usedRelativeArtifact && !isAbsolute(resolved)) {
    return resolve(runDir, resolved);
  }
  // Bare relative paths resolve against the directory of the file that
  // declares the step (the spec, or an imported action), matching how
  // `transform.file` / `eval.file` / script-verifier `file:` resolve — so an
  // upload of a repo fixture is independent of the process cwd.
  return resolveStepFile(resolved, scope, "upload.path");
}

/** Deprecations already reported to a listener (once per process). */
const reportedDeprecations = new Set<string>();

/**
 * Record a deprecation in this run's run.log (every run) and hand it to the
 * caller's listener the first time this process sees it (the CLI/MCP narrate
 * it as a warning).
 */
function reportDeprecation(
  key: string,
  message: string,
  sinks: { runLog: LiveLog; listener: ProgressListener | undefined },
): void {
  sinks.runLog.write(`warning: ${message}\n`);
  if (reportedDeprecations.has(key)) return;
  reportedDeprecations.add(key);
  sinks.listener?.onWarning?.(message);
}

/**
 * Per-run token for `${run.token}` / `CAIRN_RUN_TOKEN`. Exported so the CLI
 * can mint it before `runSpec` and hand the same value to `--after` hooks.
 */
export function generateRunToken(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRuntimeVars(
  vars: Record<string, string | number | boolean>,
  runtime: { workerIndex: number; runToken: string },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] =
      typeof value === "string"
        ? value
            .replace(/\$\{worker\.index\}/g, String(runtime.workerIndex))
            .replace(/\$\{run\.token\}/g, runtime.runToken)
        : value;
  }
  return out;
}

function resolveOpenStep(
  step: Step,
  opts: {
    baseUrl?: string;
    artifacts: Record<string, ArtifactRef>;
  },
): Step {
  if (!("open" in step)) return step;
  const path = resolveArtifactPlaceholders(openPath(step), opts.artifacts);
  const resolvedPath =
    opts.baseUrl && isRelativeUrl(path) ? joinUrl(opts.baseUrl, path) : path;
  if (resolvedPath === openPath(step)) return step;
  return typeof step.open === "string"
    ? { ...step, open: resolvedPath }
    : { ...step, open: { ...step.open, path: resolvedPath } };
}

/** Apply a spec-wide click settle only when the click has no local override. */
function applySpecClickSettle(step: Step, settleMs: number | undefined): Step {
  if (
    settleMs === undefined ||
    !("click" in step) ||
    step.settleMs !== undefined
  ) {
    return step;
  }
  return { ...step, settleMs };
}

/** The captured envelope a request step produces. */
interface RequestResponse {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  id?: string;
}

function networkMatchToResponse(entry: NetworkEntry): RequestResponse {
  let body: unknown;
  if (entry.postData) {
    try {
      body = JSON.parse(entry.postData);
    } catch {
      body = entry.postData;
    }
  }
  const status = entry.status ?? 0;
  return {
    url: entry.url,
    method: entry.method,
    status,
    ok: status >= 200 && status < 400,
    headers: {},
    body: body ?? null,
    ...(entry.id ? { id: entry.id } : {}),
  };
}

/**
 * Execute a `request` step through the backend's out-of-page request primitive
 * when available, falling back to bounded page-context fetch for older backends.
 */
async function runRequestStep(opts: {
  step: RequestStep;
  backend: BrowserBackend;
  requestIndex: number;
  baseUrl?: string;
}): Promise<
  | { ok: true; assign: string; response: RequestResponse }
  | { ok: false; error: string }
> {
  const req = opts.step.request;
  const assign = req.assign ?? `request_${opts.requestIndex}`;
  const resolved = await resolveRequestUrl(req.url, opts);
  if (!resolved.ok) return resolved;
  const timeoutMs = req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const request = { ...req, url: resolved.url, timeoutMs };

  if (typeof opts.backend.request === "function") {
    const backendResponse = await opts.backend.request({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      timeoutMs,
    });
    if (!backendResponse.ok) {
      return {
        ok: false,
        error: `request failed: ${backendResponse.error ?? "unknown error"} (${request.method} ${request.url})`,
      };
    }
    return applyExpectStatus(assign, request, {
      url: request.url,
      method: request.method,
      status: backendResponse.status,
      ok: backendResponse.status >= 200 && backendResponse.status < 400,
      headers: backendResponse.headers,
      body: backendResponse.body,
    });
  }

  const origin = await ensureRequestOrigin(opts.backend, request.url);
  if (!origin.ok) return origin;

  const result = await opts.backend.evaluate(buildRequestScript(request), {
    timeoutMs,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: `request eval failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: `request returned non-JSON eval output: ${result.stdout.slice(0, 200)}`,
    };
  }
  if (parsed && typeof parsed["requestError"] === "string") {
    return {
      ok: false,
      error: `request failed: ${parsed["requestError"]} (${request.method} ${request.url})`,
    };
  }

  const response: RequestResponse = {
    url: request.url,
    method: request.method,
    status: typeof parsed["status"] === "number" ? parsed["status"] : 0,
    ok: Boolean(parsed["ok"]),
    headers:
      parsed["headers"] && typeof parsed["headers"] === "object"
        ? (parsed["headers"] as Record<string, string>)
        : {},
    body: parsed["body"],
  };

  return applyExpectStatus(assign, request, response);
}

function applyExpectStatus(
  assign: string,
  request: RequestStep["request"],
  response: RequestResponse,
):
  | { ok: true; assign: string; response: RequestResponse }
  | {
      ok: false;
      error: string;
    } {
  if (request.expectStatus !== undefined) {
    const allowed = Array.isArray(request.expectStatus)
      ? request.expectStatus
      : [request.expectStatus];
    if (!allowed.includes(response.status)) {
      const bodyExcerpt = JSON.stringify(response.body)?.slice(0, 300) ?? "";
      return {
        ok: false,
        error: `request status ${response.status} not in expectStatus [${allowed.join(", ")}] (${request.method} ${request.url}) body: ${bodyExcerpt}`,
      };
    }
  }

  return { ok: true, assign, response };
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

async function resolveRequestUrl(
  url: string,
  opts: { baseUrl?: string; backend: BrowserBackend },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!isRelativeUrl(url)) return { ok: true, url };
  if (opts.baseUrl) return { ok: true, url: joinUrl(opts.baseUrl, url) };

  const currentUrl = await opts.backend.getUrl().catch(() => "about:blank");
  if (currentUrl === "about:blank" || currentUrl.startsWith("about:blank")) {
    return {
      ok: false,
      error: `request: relative URL "${url}" needs a baseUrl (config environments.<env>.baseUrl) or a prior open`,
    };
  }
  return { ok: true, url: resolveUrl(currentUrl, url) };
}

async function ensureRequestOrigin(
  backend: BrowserBackend,
  requestUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const currentUrl = await backend.getUrl().catch(() => "about:blank");
  if (!(currentUrl === "about:blank" || currentUrl.startsWith("about:blank"))) {
    return { ok: true };
  }
  if (!/^https?:\/\//i.test(requestUrl)) return { ok: true };

  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return { ok: true };
  }

  const opened = await backend.runStep({ open: origin });
  if (!opened.ok) {
    return {
      ok: false,
      error: `request: could not establish app origin ${origin} before fetch: ${
        opened.stderr.trim() ||
        opened.stdout.trim() ||
        `exit ${opened.exitCode}`
      }`,
    };
  }
  return { ok: true };
}

function buildRequestScript(req: RequestStep["request"]): string {
  const headers: Record<string, string> = { ...req.headers };
  let bodyExpr: string | undefined;
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      bodyExpr = JSON.stringify(req.body);
    } else {
      bodyExpr = JSON.stringify(JSON.stringify(req.body));
      const hasContentType = Object.keys(headers).some(
        (h) => h.toLowerCase() === "content-type",
      );
      if (!hasContentType) headers["content-type"] = "application/json";
    }
  }
  return [
    `(async () => {`,
    `  try {`,
    `    const res = await fetch(${JSON.stringify(req.url)}, {`,
    `      method: ${JSON.stringify(req.method)},`,
    `      credentials: "include",`,
    `      headers: ${JSON.stringify(headers)},`,
    ...(bodyExpr !== undefined ? [`      body: ${bodyExpr},`] : []),
    ...(req.timeoutMs !== undefined
      ? [`      signal: AbortSignal.timeout(${req.timeoutMs}),`]
      : []),
    `    });`,
    `    const text = await res.text();`,
    `    let body = null;`,
    `    try { body = JSON.parse(text); } catch (_) { body = text; }`,
    `    const headers = {};`,
    `    res.headers.forEach((v, k) => { headers[k] = v; });`,
    `    return { status: res.status, ok: res.ok, headers, body };`,
    `  } catch (e) {`,
    `    return { requestError: String((e && e.message) || e) };`,
    `  }`,
    `})()`,
  ].join("\n");
}

async function runTransformStep(opts: {
  step: TransformStep;
  writer: ArtifactWriter;
  specDir: string;
  /** Where the step's relative paths resolve (an action's own directory). */
  fileScope?: StepFileScope;
  artifacts: Record<string, ArtifactRef>;
  vars?: Record<string, string | number | boolean>;
  childEnv?: Record<string, string | undefined>;
  selectedTvaultKeys?: Iterable<string>;
  /** Kills the transform's process tree on abort. */
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      assign: string;
      relativePath: string;
      absolutePath: string;
    }
  | { ok: false; error: string }
> {
  const target = opts.step.transform;
  const relativePath = transformRelativePath(target.saveAs);
  const absolutePath = await opts.writer.preparePath(relativePath, "transform");

  const scope = opts.fileScope ?? specFileScope(opts.specDir);
  const file = resolveStepFile(target.file, scope, "transform.file");
  // A plain relative input is a fixture the step declares; artifact
  // placeholders resolve against the run directory as before.
  const input =
    /\$\{artifacts\./.test(target.input) || isAbsolute(target.input)
      ? resolveRuntimeFilePath(target.input, {
          artifacts: opts.artifacts,
          runDir: opts.writer.runDir,
          specDir: opts.specDir,
        })
      : resolveStepFile(target.input, scope, "transform.input");

  const result = await runNodeScript({
    file,
    cwd: opts.specDir,
    entryNames: ["transform"],
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.childEnv !== undefined ? { env: opts.childEnv } : {}),
    ...(opts.selectedTvaultKeys !== undefined
      ? { selectedTvaultKeys: opts.selectedTvaultKeys }
      : {}),
    ctx: {
      input,
      inputPath: input,
      output: { path: absolutePath, relativePath },
      outputPath: absolutePath,
      fixtures: resolveFixtureMap(target.fixtures, opts.artifacts),
      artifacts: opts.artifacts,
      vars: opts.vars ?? {},
      runDir: opts.writer.runDir,
      specDir: opts.specDir,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      error: `node transform failed: ${result.error?.message ?? result.stderr}`,
    };
  }

  const returned = result.result as { ok?: unknown; evidence?: unknown } | null;
  if (returned && typeof returned === "object" && returned.ok === false) {
    return { ok: false, error: "node transform returned ok=false" };
  }

  if (!(await fileExists(absolutePath))) {
    return {
      ok: false,
      error: `node transform did not write ${absolutePath}`,
    };
  }

  return {
    ok: true,
    assign: target.assign ?? artifactNameFromPath(relativePath),
    relativePath,
    absolutePath,
  };
}

/**
 * Execute an `eval` step — run arbitrary JS in the page context via
 * `backend.evaluate()` and optionally capture the return value.
 *
 * The source is either inline (`js`) or read from a file (`file`, resolved
 * against specDir). The source is wrapped so `args` is passed as the single
 * argument. The return value is JSON-parsed from the backend's stdout
 * (agent-browser auto-stringifies eval results).
 *
 * If `assign` is set, the captured value is written to `evals/<assign>.json`
 * (after redaction) and made available for `${evals.<name>.…}` interpolation.
 */

/**
 * Turn eval args.filePath / args.fixtureFiles into in-page base64 so the
 * browser never fetches `/cairn-fixtures/…`.
 */
export function loadEvalHostFiles(
  args: Record<string, unknown>,
  specDir: string,
  /** Host path resolver (default: absolute → cwd → specDir). */
  resolveHostFile: (raw: string, field: string) => string = (raw) =>
    resolveEvalHostFile(raw, specDir),
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.filePath === "string" && args.filePath.length > 0) {
    const absolute = resolveHostFile(args.filePath, "eval.args.filePath");
    out.bytesBase64 = readFileSync(absolute).toString("base64");
    out.filePath = absolute;
  }
  if (
    args.fixtureFiles &&
    typeof args.fixtureFiles === "object" &&
    args.fixtureFiles !== null &&
    !Array.isArray(args.fixtureFiles)
  ) {
    const fixtureBytes: Record<string, string> = {};
    for (const [name, raw] of Object.entries(
      args.fixtureFiles as Record<string, unknown>,
    )) {
      if (typeof raw !== "string" || raw.length === 0) {
        throw new Error(`fixtureFiles.${name} must be a host path`);
      }
      fixtureBytes[name] = readFileSync(
        resolveHostFile(raw, `eval.args.fixtureFiles.${name}`),
      ).toString("base64");
    }
    out.fixtureBytes = fixtureBytes;
    delete out.fixtureFiles;
  }
  return out;
}

async function runEvalStep(opts: {
  step: EvalStep;
  backend: BrowserBackend;
  specDir: string;
  /** Where the step's relative paths resolve (an action's own directory). */
  fileScope?: StepFileScope;
  writer: ArtifactWriter;
}): Promise<
  { ok: true; assign?: string; value: unknown } | { ok: false; error: string }
> {
  const target = opts.step.eval;

  let source: string;
  try {
    if (target.js) {
      source = target.js;
    } else {
      const file = resolveStepFile(
        target.file!,
        opts.fileScope ?? specFileScope(opts.specDir),
        "eval.file",
      );
      const { readFile } = await import("node:fs/promises");
      source = await readFile(file, "utf8");
    }
  } catch (e) {
    return {
      ok: false,
      error: `eval: failed to load source: ${(e as Error).message}`,
    };
  }

  // Wrap so `args` is the single argument and the value is returned.
  // Host paths (`filePath` / `fixtureFiles`) are read here and injected as
  // base64 so the page can build a readable File without staging into the
  // app's public/ directory (CDP path upload is ACCESS_DENIED).
  let pageArgs: Record<string, unknown>;
  try {
    const scope = opts.fileScope ?? specFileScope(opts.specDir);
    pageArgs = loadEvalHostFiles(
      target.args ?? {},
      opts.specDir,
      (raw, field) => resolveScopedEvalHostFile(raw, scope, field),
    );
  } catch (e) {
    return {
      ok: false,
      error: `eval: ${(e as Error).message}`,
    };
  }
  const argsJson = JSON.stringify(pageArgs);
  const wrapped = `(async (args) => { ${source} })(${argsJson})`;

  let result;
  try {
    const deadline = target.timeoutMs
      ? Date.now() + target.timeoutMs
      : undefined;
    result = await opts.backend.evaluate(
      wrapped,
      target.timeoutMs ? { timeoutMs: target.timeoutMs } : {},
    );
    if (
      !result.ok &&
      target.retryOnNavigation &&
      isNavigationContextLoss(result.stderr)
    ) {
      await opts.backend.waitForTimeout(350);
      const remainingMs = deadline
        ? Math.max(1, deadline - Date.now())
        : undefined;
      result = await opts.backend.evaluate(
        wrapped,
        remainingMs ? { timeoutMs: remainingMs } : {},
      );
    }
  } catch (e) {
    return {
      ok: false,
      error: `eval: backend.evaluate threw: ${(e as Error).message}`,
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      error: `eval failed: exitCode=${result.exitCode}, stderr=${result.stderr.trim() || "(empty)"}`,
    };
  }

  // Parse the return value from stdout (agent-browser auto-stringifies).
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    // If the result isn't JSON, use the raw stdout as a string value.
    value = result.stdout;
  }

  // Write the captured value to evals/<assign>.json (after redaction).
  if (target.assign) {
    const relativePath = `evals/${target.assign}.json`;
    await opts.writer.writeJson(relativePath, { value }, "eval");
    return { ok: true, assign: target.assign, value };
  }

  return { ok: true, value };
}

function isNavigationContextLoss(stderr: string): boolean {
  return /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/i.test(
    stderr,
  );
}

/**
 * Execute a `monitor` step: capture a process profile or one-shot sample of
 * the backend's browser process tree via the external `monitor` CLI, and
 * write it to `monitor/<padded>-<action>.json`. With `assign`, register the
 * result as a named artifact (kind `monitor`) reusable via
 * `${artifacts.<assign>.path}`. Fails the step if no browser PID is available
 * or the monitor binary is missing — the author explicitly asked to capture
 * at this point, so a silent skip would hide the gap.
 */
async function runMonitorStep(opts: {
  step: MonitorStep;
  backend: BrowserBackend;
  client: MonitorClient;
  writer: ArtifactWriter;
  index: number;
  targets: Record<string, MonitorTargetConfig>;
}): Promise<
  | {
      ok: true;
      action: string;
      relativePath: string;
      relativePaths: string[];
      assign?: string;
    }
  | { ok: false; error: string }
> {
  const target = opts.step.monitor;
  let pid: number | undefined;
  if (target.target) {
    const selector = opts.targets[target.target];
    if (!selector) {
      return {
        ok: false,
        error: `monitor target ${JSON.stringify(target.target)} is not declared in diagnostics.monitor.targets`,
      };
    }
    const resolved = await opts.client.resolveTarget(selector);
    pid = resolved?.pid;
    if (pid === undefined) {
      return {
        ok: false,
        error: `monitor could not resolve exactly one process for target ${JSON.stringify(target.target)} (runtime=${selector.runtime}, codebaseRoot=${selector.codebaseRoot}${
          selector.mainScriptSuffix
            ? `, mainScriptSuffix=${selector.mainScriptSuffix}`
            : ""
        })`,
      };
    }
  } else {
    pid = opts.backend.browserPid?.();
  }
  if (pid === undefined || pid <= 1) {
    return {
      ok: false,
      error: target.target
        ? `monitor target ${JSON.stringify(target.target)} resolved no usable PID`
        : "monitor step needs a browser PID, but the backend has no spawned browser process (start the run with an `open` step first, or use a backend that exposes browserPid)",
    };
  }
  if (!(await opts.client.available())) {
    return {
      ok: false,
      error:
        "monitor step needs the `monitor` CLI on PATH (github.com/abdul-hamid-achik/monitor) — install it to capture process profiles/snapshots",
    };
  }
  const labelSlug = target.label
    ? `_${target.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "";
  const base = `${pad(opts.index)}_${target.action}${labelSlug}`;
  const relativePath = `monitor/${base}.json`;

  if (target.action === "profile") {
    const rawRelativePath = `monitor/${base}.profile`;
    const profile = await opts.client.captureProfile(
      pid,
      (target.type ?? "heap") as ProfileType,
      {
        ...(target.durationSeconds !== undefined
          ? { durationSeconds: target.durationSeconds }
          : {}),
        outputPath: opts.writer.resolve(rawRelativePath),
        stepId: opts.step.id ?? `step_${opts.index}`,
        service: target.target ?? "browser",
      },
    );
    if (!profile) {
      return {
        ok: false,
        error: `monitor profile <pid> --type ${target.type ?? "heap"} returned no result (process exited or profile failed)`,
      };
    }
    if (profile.path) {
      opts.writer.registerExisting(rawRelativePath, "monitor");
      profile.path = rawRelativePath;
    }
    await opts.writer.writeJson(relativePath, profile, "monitor");
    return {
      ok: true,
      action: `profile:${profile.type}`,
      relativePath,
      relativePaths: profile.path
        ? [relativePath, rawRelativePath]
        : [relativePath],
      ...(target.assign ? { assign: target.assign } : {}),
    };
  }
  // action === "snapshot"
  const sample = await opts.client.sampleProcess(pid);
  if (!sample) {
    return {
      ok: false,
      error: `monitor process ${pid} returned no result (process exited or sample failed)`,
    };
  }
  await opts.writer.writeJson(relativePath, sample, "monitor");
  return {
    ok: true,
    action: "snapshot",
    relativePath,
    relativePaths: [relativePath],
    ...(target.assign ? { assign: target.assign } : {}),
  };
}

async function fileExists(absPath: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(absPath)).isFile();
  } catch {
    return false;
  }
}

async function captureDiagnostics(
  backend: BrowserBackend,
  step: Step,
  stepError: string | undefined,
): Promise<unknown> {
  const descriptor = diagnosticStepDescriptor(step);
  const needles = diagnosticNeedles(step);
  const selector =
    ("click" in step && step.click.by === "selector" && step.click.selector) ||
    ("hover" in step && step.hover.by === "selector" && step.hover.selector) ||
    ("focus" in step && step.focus.by === "selector" && step.focus.selector) ||
    ("fill" in step && step.fill.by === "selector" && step.fill.selector) ||
    ("select" in step &&
      step.select.by === "selector" &&
      step.select.selector) ||
    ("upload" in step &&
      step.upload.by === "selector" &&
      step.upload.selector) ||
    ("download" in step &&
      step.download.by === "selector" &&
      step.download.selector) ||
    "";
  const js = [
    `(() => {`,
    `  const descriptor = ${JSON.stringify(descriptor)};`,
    `  const needles = ${JSON.stringify(needles)};`,
    `  const selector = ${JSON.stringify(selector)};`,
    `  const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();`,
    `  const visible = (el) => {`,
    `    if (!el) return false;`,
    `    const style = getComputedStyle(el);`,
    `    const rect = el.getBoundingClientRect();`,
    `    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;`,
    `  };`,
    `  const textOf = (el) => normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent);`,
    `  const sample = (sel, map) => Array.from(document.querySelectorAll(sel)).filter(visible).map(map).filter(Boolean).slice(0, 40);`,
    `  const bodyText = document.body ? document.body.innerText || '' : '';`,
    `  const excerpts = needles.map((needle) => {`,
    `    const idx = bodyText.toLowerCase().indexOf(String(needle).toLowerCase());`,
    `    return { needle, found: idx >= 0, excerpt: idx >= 0 ? normalize(bodyText.slice(Math.max(0, idx - 120), idx + String(needle).length + 120)) : '' };`,
    `  });`,
    `  let selectorCount = null;`,
    `  if (selector) {`,
    `    try { selectorCount = document.querySelectorAll(selector).length; } catch (e) { selectorCount = 'invalid selector: ' + e.message; }`,
    `  }`,
    // Streaming-SSR forensics (2026-07-12 empty-<main> investigation): a
    // Suspense boundary still mid-flush leaves `<!--$?-->` comment markers
    // in the DOM, and one that errored/fell back leaves `<!--$!-->` —
    // counting them plus readyState and landmark shape turns "the wait
    // failed" into "the page was still streaming when it failed."
    `  const suspenseBoundaries = (() => {`,
    `    let pending = 0, clientRendered = 0;`,
    `    try {`,
    `      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);`,
    `      let node;`,
    `      while ((node = walker.nextNode())) {`,
    `        if (node.nodeValue === '$?') pending++;`,
    `        else if (node.nodeValue === '$!') clientRendered++;`,
    `      }`,
    `    } catch (e) {}`,
    `    return { pending, clientRendered };`,
    `  })();`,
    `  const landmarks = {};`,
    `  for (const tag of ['header', 'main', 'footer']) {`,
    `    const el = document.querySelector(tag);`,
    `    landmarks[tag] = {`,
    `      tag,`,
    `      present: Boolean(el),`,
    `      childElementCount: el ? el.childElementCount : 0,`,
    `      visibleTextLength: el ? normalize(el.innerText || '').length : 0,`,
    `    };`,
    `  }`,
    `  return {`,
    `    url: location.href,`,
    `    title: document.title,`,
    `    step: descriptor,`,
    `    stepError: ${JSON.stringify(stepError ?? "")},`,
    `    selectorCount,`,
    `    readyState: document.readyState,`,
    `    suspenseBoundaries,`,
    `    landmarks,`,
    `    expectedTextExcerpts: excerpts,`,
    `    visibleButtons: sample('button, [role=button], input[type=button], input[type=submit]', (el) => ({ text: textOf(el), disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), selector: el.tagName.toLowerCase(), className: String(el.className || '').slice(0, 120) })),`,
    `    visibleLinks: sample('a, [role=link]', (el) => ({ text: textOf(el), href: el.href || '', className: String(el.className || '').slice(0, 120) })),`,
    `    visibleInputs: sample('input, textarea, select, [role=combobox]', (el) => ({ label: normalize(el.labels && el.labels[0] ? el.labels[0].innerText : ''), placeholder: el.getAttribute('placeholder') || '', name: el.getAttribute('name') || '', type: el.getAttribute('type') || el.tagName.toLowerCase(), value: el.type === 'password' ? '[redacted]' : String(el.value || '').slice(0, 80) })),`,
    `    formLabels: sample('label', (el) => textOf(el)),`,
    `    tableHeaders: sample('th, [role=columnheader]', (el) => textOf(el)),`,
    `  };`,
    `})()`,
  ].join("\n");

  const result = await safe(() => backend.evaluate(js));
  if (!result?.ok) {
    return {
      step: descriptor,
      stepError,
      diagnosticsError:
        result?.stderr ||
        `diagnostics eval failed with exit ${result?.exitCode}`,
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return {
      step: descriptor,
      stepError,
      diagnosticsError: `diagnostics JSON parse failed: ${(e as Error).message}`,
      stdout: result.stdout.slice(0, 2000),
    };
  }
}

function diagnosticStepDescriptor(step: Step): Record<string, unknown> {
  if ("click" in step) return { kind: "click", locator: step.click };
  if ("hover" in step) return { kind: "hover", locator: step.hover };
  if ("focus" in step) return { kind: "focus", locator: step.focus };
  if ("fill" in step) {
    const { value: _value, ...locator } = step.fill;
    return { kind: "fill", locator };
  }
  if ("select" in step) {
    const { value: _value, label: _label, ...locator } = step.select;
    return { kind: "select", locator };
  }
  if ("upload" in step) {
    const { path: _path, ...locator } = step.upload;
    return { kind: "upload", locator };
  }
  if ("download" in step) {
    const {
      saveAs: _saveAs,
      assign: _assign,
      timeoutMs: _timeoutMs,
      ...locator
    } = step.download;
    return { kind: "download", locator };
  }
  if ("transform" in step) {
    const {
      file,
      input,
      saveAs,
      assign,
      runtime: _runtime,
      fixtures: _fixtures,
    } = step.transform;
    return { kind: "transform", file, input, saveAs, assign };
  }
  if ("open" in step) return { kind: "open", url: openPath(step) };
  if ("batch" in step) {
    return {
      kind: "batch",
      subSteps: step.batch.map((sub) => Object.keys(sub)[0] ?? "?"),
    };
  }
  if ("request" in step) {
    return {
      kind: "request",
      method: step.request.method,
      url: step.request.url,
    };
  }
  if ("eval" in step) {
    return {
      kind: "eval",
      js: step.eval.js ? "(inline)" : undefined,
      file: step.eval.file,
      assign: step.eval.assign,
    };
  }
  if ("wait" in step) return { kind: "wait", condition: step.wait };
  if ("press" in step) return { kind: "press", key: step.press };
  if ("scroll" in step) return { kind: "scroll", scroll: step.scroll };
  if ("snapshot" in step) return { kind: "snapshot" };
  if ("type" in step) return { kind: "type" };
  if ("monitor" in step)
    return {
      kind: "monitor",
      action: step.monitor.action,
      type: step.monitor.type,
    };
  if ("run" in step) {
    return typeof step.run === "string"
      ? { kind: "run", shell: "(inline)" }
      : {
          kind: "run",
          ...(step.run.node ? { node: step.run.node } : { shell: "(inline)" }),
          assign: step.run.assign,
        };
  }
  if ("expect" in step) {
    return "request" in step.expect
      ? {
          kind: "expect",
          request: `${step.expect.request.method} ${step.expect.request.url}`,
        }
      : { kind: "expect", locator: expectLocator(step.expect) };
  }
  if ("capture" in step) {
    return { kind: "capture", assign: step.capture.assign };
  }
  return {
    kind: "use",
    action: typeof step.use === "string" ? step.use : step.use.action,
  };
}

function diagnosticNeedles(step: Step): string[] {
  const values: string[] = [];
  const add = (v: string | undefined) => {
    if (v && !values.includes(v)) values.push(v);
  };
  if ("click" in step) add(locatorNeedle(step.click));
  if ("hover" in step) add(locatorNeedle(step.hover));
  if ("focus" in step) add(locatorNeedle(step.focus));
  if ("fill" in step) add(locatorNeedle(step.fill));
  if ("type" in step) add(locatorNeedle(step.type));
  if ("select" in step) add(locatorNeedle(step.select));
  if ("upload" in step) add(locatorNeedle(step.upload));
  if ("download" in step) add(locatorNeedle(step.download));
  if ("transform" in step) {
    add(step.transform.file);
    add(step.transform.input);
    add(step.transform.saveAs);
  }
  if ("eval" in step) {
    add(step.eval.file);
    add(step.eval.assign);
  }
  if ("wait" in step) {
    if ("text" in step.wait) add(step.wait.text);
    if ("notText" in step.wait) add(step.wait.notText);
    if ("selector" in step.wait) add(step.wait.selector);
    if ("value" in step.wait) add(locatorNeedle(step.wait.value));
    if ("url" in step.wait) {
      add(step.wait.url.includes);
      add(step.wait.url.equals);
      add(step.wait.url.pattern);
    }
  }
  if ("scroll" in step && "to" in step.scroll)
    add(locatorNeedle(step.scroll.to));
  if ("batch" in step) {
    for (const sub of step.batch) {
      if ("click" in sub) add(sub.click.selector);
      else if ("hover" in sub) add(sub.hover.selector);
      else if ("fill" in sub) add(sub.fill.selector);
      else if ("type" in sub) add(sub.type.selector);
      else if ("upload" in sub) add(sub.upload.selector);
      else if ("scroll" in sub && "to" in sub.scroll)
        add(sub.scroll.to.selector);
      else if ("wait" in sub) {
        if ("text" in sub.wait) add(sub.wait.text);
        if ("notText" in sub.wait) add(sub.wait.notText);
        if ("selector" in sub.wait) add(sub.wait.selector);
      }
    }
  }
  return values.slice(0, 10);
}

function locatorNeedle(locator: {
  name?: string;
  text?: string;
  role?: string;
  selector?: string;
  testid?: string;
}): string | undefined {
  return (
    locator.name ??
    locator.text ??
    locator.selector ??
    locator.testid ??
    locator.role
  );
}

/**
 * writeFile that ensures parent dir exists. Named with Bun_ prefix to avoid
 * shadowing the global fs.writeFile import; this is just a small helper.
 */
