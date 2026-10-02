import { z } from "zod";
import { IsoTimestampSchema, RelativePathSchema } from "./shared";
import { RunInvocationRefSchema, RunRefusalCodeSchema } from "./run.v1";

/**
 * Wire schema for `events.ndjson` (events contract v1).
 *
 * Every line of a run directory's `events.ndjson` (and, for invocation-level
 * lifecycle events, of `_invocations/<id>/events.ndjson`) is one JSON object
 * `{ ts, type, ...fields }`. This module is the single source of truth for the
 * event vocabulary: `ArtifactWriter.appendEvent` is typed against
 * {@link RunEvent}, and a golden test validates every event the runner writes.
 *
 * Compatibility rules (append-only log, read by agents and Studio):
 *   - New event types and new optional fields are additive (minor release).
 *   - Renaming/removing a type or a field, or making a field required, is a
 *     breaking change.
 *   - Readers must ignore event types they do not know and tolerate fields
 *     they do not use. The schemas below are strict so the PRODUCER test
 *     catches accidental drift; consumers that need leniency should switch
 *     on `type` instead of strict-parsing whole lines.
 *
 * Paths inside events are relative to the directory that holds the
 * `events.ndjson` that announces them (normally the run directory).
 */

const ts = IsoTimestampSchema;
const durationMs = z.number().int().nonnegative();
const nonEmpty = z.string().min(1);

/** The snapshot element a semantic locator resolved to before acting. */
const ResolvedElementSchema = z
  .object({
    role: nonEmpty,
    name: z.string().optional(),
    ref: z.string().optional(),
  })
  .strict();

/** A step's `when:` gate as authored (string shorthand or object form). */
const WhenSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

/* ----- lifecycle phases ----- */

export const RunPhaseSchema = z.enum([
  "services",
  "before-hooks",
  "preconditions",
  "steps",
  "outcomes",
  "after-hooks",
  "teardown",
  "stash",
  "retention",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/* ----- run ----- */

export const RunStartedEventSchema = z
  .object({
    ts,
    type: z.literal("run.started"),
    runId: nonEmpty,
    spec: nonEmpty,
    /** Present when the run belongs to a `cairn run` invocation journal. */
    invocation: RunInvocationRefSchema.optional(),
  })
  .strict();

const runEndShape = {
  ts,
  runId: nonEmpty,
  durationMs,
};

export const RunPassedEventSchema = z
  .object({ ...runEndShape, type: z.literal("run.passed") })
  .strict();

export const RunFailedEventSchema = z
  .object({ ...runEndShape, type: z.literal("run.failed") })
  .strict();

export const RunErroredEventSchema = z
  .object({
    ...runEndShape,
    type: z.literal("run.errored"),
    /** Set when the run errored before browser steps (e.g. "precondition"). */
    phase: nonEmpty.optional(),
    /** Authored phase item name (e.g. the precondition's name). */
    name: nonEmpty.optional(),
    timedOut: z.boolean().optional(),
    signal: nonEmpty.optional(),
  })
  .strict();

/**
 * The environment policy refused a spec before anything started. Written to
 * the invocation journal's events.ndjson (a refused spec has no run
 * directory); the batch/single result carries the `refusal` document.
 */
export const RunRefusedEventSchema = z
  .object({
    ts,
    type: z.literal("run.refused"),
    /** Spec name (the file stem when the spec does not parse). */
    spec: nonEmpty,
    /** One-line human reason. */
    reason: nonEmpty,
    /** The resolved environment the spec was refused in. */
    env: nonEmpty,
    code: RunRefusalCodeSchema.optional(),
    /** 1-based position in the invocation plan. */
    index: z.number().int().positive().optional(),
    /** Spec path as the invocation expanded it. */
    path: nonEmpty.optional(),
  })
  .strict();

export const PhaseChangedEventSchema = z
  .object({
    ts,
    type: z.literal("phase.changed"),
    phase: RunPhaseSchema,
    /** Item inside the phase (precondition name, hook command index, …). */
    item: z.string().optional(),
    /** Budget for the phase/item, when it has one (precondition timeout, …). */
    budgetMs: z.number().int().nonnegative().optional(),
    /** ISO deadline = phase start + budgetMs. */
    deadline: ts.optional(),
  })
  .strict();

export const RunHeartbeatEventSchema = z
  .object({
    ts,
    type: z.literal("run.heartbeat"),
    phase: RunPhaseSchema,
    item: z.string().optional(),
    /** Elapsed time in the CURRENT phase/item (compare with budgetMs). */
    elapsedMs: durationMs,
    budgetMs: z.number().int().nonnegative().optional(),
    /** Elapsed time since the run (or invocation) started. */
    runElapsedMs: durationMs.optional(),
    /** PID of the cairn process writing the log. */
    pid: z.number().int().positive(),
  })
  .strict();

/* ----- steps ----- */

export const StepStartedEventSchema = z
  .object({
    ts,
    type: z.literal("step.started"),
    stepId: nonEmpty,
    /** 1-based position of the step in the resolved spec. */
    index: z.number().int().positive().optional(),
    /** Number of top-level steps in the resolved spec. */
    total: z.number().int().positive().optional(),
    /** Step kind: the step's action key (open, click, fill, wait, …). */
    kind: nonEmpty.optional(),
    /** Short human label, e.g. `click role=button "Save"`. Never carries fill values. */
    label: nonEmpty.optional(),
  })
  .strict();

const stepEndShape = {
  ts,
  stepId: nonEmpty,
  durationMs,
  resolved: ResolvedElementSchema.optional(),
  /** Best-known page URL after the step (navigation target or diagnostics). */
  url: nonEmpty.optional(),
  /** Screenshot captured for this step, relative to the run directory. */
  screenshot: RelativePathSchema.optional(),
};

export const StepFinishedEventSchema = z
  .object({
    ...stepEndShape,
    type: z.literal("step.finished"),
    /** true when the step's `when:` gate did not hold and the step was skipped. */
    skipped: z.boolean().optional(),
    when: WhenSchema.optional(),
  })
  .strict();

export const StepFailedEventSchema = z
  .object({
    ...stepEndShape,
    type: z.literal("step.failed"),
    error: z.string().optional(),
  })
  .strict();

/* ----- outcomes ----- */

export const OutcomeStartedEventSchema = z
  .object({
    ts,
    type: z.literal("outcome.started"),
    outcomeId: nonEmpty,
    /** Verifier kind (text, url, script, …). */
    kind: nonEmpty,
    /** Verifier budget when the outcome declares one. */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const OutcomeProgressEventSchema = z
  .object({
    ts,
    type: z.literal("outcome.progress"),
    outcomeId: nonEmpty,
    message: z.string(),
  })
  .strict();

const outcomeEndShape = {
  ts,
  outcomeId: nonEmpty,
  /** Wall time the verifier spent on this outcome. */
  durationMs: durationMs.optional(),
  /** Evaluations performed under `poll` (absent when the verifier did not poll). */
  attempts: z.number().int().positive().optional(),
  /** Wall time spent polling, in ms (absent when the verifier did not poll). */
  polledMs: durationMs.optional(),
};

/* ----- expect steps ----- */

const expectEndShape = {
  ts,
  stepId: nonEmpty,
  /** `expect.id`, else the step id. */
  expectId: nonEmpty,
  /** Assertions checked: visible, hidden, count, text, value, attribute, enabled, request (joined with +). */
  kind: nonEmpty,
  /** Evidence file (`expects/NNN_<id>.json`). */
  path: RelativePathSchema.optional(),
  attempts: z.number().int().nonnegative().optional(),
  durationMs: durationMs.optional(),
  expected: z.string(),
  actual: z.string(),
};

export const ExpectPassedEventSchema = z
  .object({ ...expectEndShape, type: z.literal("expect.passed") })
  .strict();
export const ExpectFailedEventSchema = z
  .object({ ...expectEndShape, type: z.literal("expect.failed") })
  .strict();

export const OutcomePassedEventSchema = z
  .object({ ...outcomeEndShape, type: z.literal("outcome.passed") })
  .strict();
export const OutcomeFailedEventSchema = z
  .object({ ...outcomeEndShape, type: z.literal("outcome.failed") })
  .strict();
export const OutcomeSkippedEventSchema = z
  .object({ ...outcomeEndShape, type: z.literal("outcome.skipped") })
  .strict();

/* ----- preconditions ----- */

export const PreconditionStartedEventSchema = z
  .object({
    ts,
    type: z.literal("precondition.started"),
    name: nonEmpty,
    timeoutMs: z.number().int().positive(),
    /** 1-based position among the spec's precondition commands. */
    index: z.number().int().positive().optional(),
    total: z.number().int().positive().optional(),
    /** Live log of the command's output, relative to the run directory. */
    logPath: RelativePathSchema.optional(),
  })
  .strict();

/** Maximum characters of precondition output kept in `precondition.run.output`. */
export const PRECONDITION_OUTPUT_TAIL_CHARS = 4000;

export const PreconditionRunEventSchema = z
  .object({
    ts,
    type: z.literal("precondition.run"),
    name: nonEmpty,
    /** Absent when the child was killed by a signal before exiting. */
    exitCode: z.number().int().optional(),
    durationMs,
    timedOut: z.boolean(),
    signal: nonEmpty.optional(),
    /** TAIL of the combined stdout+stderr (last 4000 characters). */
    output: z.string(),
    /** true when `output` is a tail of a longer output. */
    outputTruncated: z.boolean().optional(),
    logPath: RelativePathSchema.optional(),
  })
  .strict();

export const PreconditionProgressEventSchema = z
  .object({
    ts,
    type: z.literal("precondition.progress"),
    name: nonEmpty,
    message: z.string(),
  })
  .strict();

/* ----- hooks (--before / --after) ----- */

const HookKindSchema = z.enum(["before", "after"]);

export const HookStartedEventSchema = z
  .object({
    ts,
    type: z.literal("hook.started"),
    hook: HookKindSchema,
    /** 1-based position among the hooks of this kind. */
    index: z.number().int().positive(),
    /** The command line, redacted. */
    command: z.string(),
    logPath: RelativePathSchema.optional(),
    /** `--after` hooks: the run the hook ran for. */
    runId: nonEmpty.optional(),
    /** `--repeat`/`--matrix`: the 1-based iteration the hook ran in. */
    iteration: z.number().int().positive().optional(),
    /** Hook budget (`--hook-timeout-ms`). */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/** Maximum characters of hook output kept in `hook.finished.outputTail`. */
export const HOOK_OUTPUT_TAIL_CHARS = 2000;

export const HookFinishedEventSchema = z
  .object({
    ts,
    type: z.literal("hook.finished"),
    hook: HookKindSchema,
    index: z.number().int().positive(),
    /** Absent when the child was killed by a signal before exiting. */
    exitCode: z.number().int().optional(),
    durationMs,
    timedOut: z.boolean().optional(),
    /** TAIL of the redacted combined output (last 2000 characters). */
    outputTail: z.string().optional(),
    runId: nonEmpty.optional(),
    iteration: z.number().int().positive().optional(),
  })
  .strict();

/* ----- live logs ----- */

export const LogOpenedEventSchema = z
  .object({
    ts,
    type: z.literal("log.opened"),
    kind: z.enum(["precondition", "hook", "outcome", "services", "narration"]),
    name: nonEmpty,
    /** Relative to the directory holding the events.ndjson that announces it. */
    path: RelativePathSchema,
  })
  .strict();

/* ----- invocation journal ----- */

/**
 * Invocation status. Exit 7 (every spec refused by the environment policy,
 * or any refusal under `--strict-requires`) settles as `failed` with
 * `summary.exitCode: 7` and `summary.refused`: what was asked did not run.
 */
export const InvocationStatusSchema = z.enum([
  "running",
  "passed",
  "failed",
  "errored",
  "aborted",
]);
export type InvocationStatus = z.infer<typeof InvocationStatusSchema>;

export const InvocationStartedEventSchema = z
  .object({
    ts,
    type: z.literal("invocation.started"),
    invocationId: nonEmpty,
    /** Number of planned spec runs (specs × repeat/matrix iterations). */
    planned: z.number().int().nonnegative(),
  })
  .strict();

export const InvocationFinishedEventSchema = z
  .object({
    ts,
    type: z.literal("invocation.finished"),
    invocationId: nonEmpty,
    status: InvocationStatusSchema,
    /** SIGINT/SIGTERM when the invocation was aborted by a signal. */
    signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
  })
  .strict();

/* ----- invocation journal file (`_invocations/<id>/invocation.json`) ----- */

/** One planned spec run (specs × `--repeat`/`--matrix` iterations). */
export const InvocationPlannedRunSchema = z
  .object({
    /** 1-based position in the invocation plan. */
    index: z.number().int().positive(),
    /** Spec path as the invocation expanded it. */
    spec: nonEmpty,
    /** Iteration labels (`repeat=2`, matrix `key=value`). */
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** A run the invocation started; `status` is "running" until it settles. */
export const InvocationRunEntrySchema = z
  .object({
    index: z.number().int().positive(),
    spec: nonEmpty,
    runId: nonEmpty,
    /** Absolute run directory (same value as run.json `runDir`). */
    runDir: nonEmpty,
    status: z.enum(["running", "passed", "failed", "errored"]).optional(),
    /**
     * `true` when the spec errored or was cancelled before its run started:
     * `runId` / `runDir` are placeholders with nothing on disk. Additive.
     */
    synthetic: z.literal(true).optional(),
  })
  .strict();

/** One `--repeat`/`--matrix` iteration row of the final summary. */
export const InvocationIterationSummarySchema = z
  .object({
    index: z.number().int().positive(),
    /** Iteration description, e.g. `repeat=2 path=next`. */
    label: z.string(),
    exitCode: z.number().int(),
    specs: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    note: z.string().optional(),
  })
  .strict();

/** The batch summary that `cairn run` prints, persisted at the end. */
export const InvocationSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    /**
     * Specs the environment policy refused (never started; no `runs` entry,
     * a `run.refused` event instead). Present only when > 0. Additive.
     */
    refused: z.number().int().nonnegative().optional(),
    durationMs,
    exitCode: z.number().int(),
    iterations: z.array(InvocationIterationSummarySchema).optional(),
    /** Invocation-level failure (services boot, a fatal `--before` hook). */
    error: z.string().optional(),
  })
  .strict();

/**
 * `invocation.json`: one per `cairn run` process, rewritten atomically
 * (temp file + rename) as specs start and finish, so readers may poll it.
 */
export const InvocationJournalSchema = z
  .object({
    version: z.literal(1),
    invocationId: nonEmpty,
    pid: z.number().int().positive(),
    /** CLI arguments after the binary, redacted. */
    argv: z.array(z.string()),
    cwd: nonEmpty,
    /** Entry point: `cli` (`cairn run`) or `mcp` (`cairn_run`). Additive. */
    origin: z.enum(["cli", "mcp"]).optional(),
    /** MCP client that requested the invocation (`name/version`). Additive. */
    client: nonEmpty.optional(),
    configPath: nonEmpty.optional(),
    /** Resolved environment name, when known. */
    env: nonEmpty.optional(),
    /** `--label key=value` pairs. */
    labels: z.record(z.string(), z.string()).optional(),
    parallel: z.number().int().positive(),
    planned: z.array(InvocationPlannedRunSchema),
    status: InvocationStatusSchema,
    startedAt: ts,
    endedAt: ts.optional(),
    /** The most recently started planned run. */
    current: z
      .object({
        index: z.number().int().positive(),
        spec: nonEmpty,
        runId: nonEmpty.optional(),
      })
      .strict()
      .optional(),
    runs: z.array(InvocationRunEntrySchema),
    summary: InvocationSummarySchema.optional(),
    /** Set with status "aborted" when a signal ended the invocation. */
    signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
  })
  .strict();
export type InvocationJournalFile = z.infer<typeof InvocationJournalSchema>;

/**
 * Reader-side copy of a strict schema: every object level drops unknown keys
 * instead of rejecting them, so a journal written by a newer cairn (with
 * fields this build does not know) still reads. Writers and the contract
 * tests keep the strict schema.
 */
function ignoreUnknownKeys(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(
      schema.shape as Record<string, z.ZodTypeAny>,
    )) {
      shape[key] = ignoreUnknownKeys(value);
    }
    return z.object(shape).strip();
  }
  if (schema instanceof z.ZodOptional) {
    return ignoreUnknownKeys(schema.unwrap()).optional();
  }
  if (schema instanceof z.ZodArray) {
    return z.array(ignoreUnknownKeys(schema.element));
  }
  return schema;
}

/** Lenient twin of {@link InvocationJournalSchema} for readers. */
export const InvocationJournalReadSchema = ignoreUnknownKeys(
  InvocationJournalSchema,
) as z.ZodType<InvocationJournalFile>;
export type InvocationSummary = z.infer<typeof InvocationSummarySchema>;
export type InvocationPlannedRun = z.infer<typeof InvocationPlannedRunSchema>;

/* ----- artifacts ----- */

const stepArtifactShape = {
  ts,
  stepId: nonEmpty,
  path: RelativePathSchema,
};

export const ArtifactScreenshotEventSchema = z
  .object({
    ...stepArtifactShape,
    type: z.literal("artifact.screenshot"),
    /** "failed" when the backend could not produce the image. */
    action: z.literal("failed").optional(),
    error: z.string().optional(),
  })
  .strict();

export const ArtifactSnapshotEventSchema = z
  .object({ ...stepArtifactShape, type: z.literal("artifact.snapshot") })
  .strict();

export const ArtifactDownloadEventSchema = z
  .object({
    ...stepArtifactShape,
    type: z.literal("artifact.download"),
    assign: nonEmpty,
  })
  .strict();

export const ArtifactTransformEventSchema = z
  .object({
    ...stepArtifactShape,
    type: z.literal("artifact.transform"),
    assign: nonEmpty,
  })
  .strict();

export const ArtifactEvalEventSchema = z
  .object({
    ...stepArtifactShape,
    type: z.literal("artifact.eval"),
    assign: nonEmpty,
  })
  .strict();

export const ArtifactRequestEventSchema = z
  .object({
    ...stepArtifactShape,
    type: z.literal("artifact.request"),
    assign: nonEmpty,
    status: z.number().int(),
  })
  .strict();

export const ArtifactDiagnosticsEventSchema = z
  .object({
    ...stepArtifactShape,
    type: z.literal("artifact.diagnostics"),
    wedged: z.boolean().optional(),
  })
  .strict();

/** Reserved: declared since v1 for video clip events; not written today. */
export const ArtifactClipEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.clip"),
    stepId: nonEmpty.optional(),
    path: RelativePathSchema.optional(),
    clips: z.record(z.string(), RelativePathSchema).optional(),
    error: z.string().optional(),
  })
  .strict();

export const ArtifactMonitorEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.monitor"),
    /** Monitor step action (profile | snapshot) or "summary" for --monitor. */
    action: nonEmpty,
    path: RelativePathSchema,
    stepId: nonEmpty.optional(),
    assign: nonEmpty.optional(),
    samples: z.number().int().nonnegative().optional(),
    peakRssBytes: z.number().nonnegative().optional(),
    peakCpuPercent: z.number().nonnegative().optional(),
  })
  .strict();

export const ArtifactVideoEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.video"),
    action: z.enum(["warning", "start", "stop", "clip"]),
    warning: z.string().optional(),
    policy: z.enum(["always", "on-failure", "never"]).optional(),
    slowMo: z.number().nonnegative().optional(),
    speed: z.number().positive().optional(),
    path: RelativePathSchema.optional(),
    clips: z.record(z.string(), RelativePathSchema).optional(),
    error: z.string().optional(),
  })
  .strict();

export const ArtifactServicesEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.services"),
    action: z.enum(["capture", "error"]),
    path: RelativePathSchema.optional(),
    sources: z.number().int().nonnegative().optional(),
    errors: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  })
  .strict();

/**
 * Short, path-free reason a stash, archive or publish produced no durable
 * copy. `message` beside it is a redacted one-line detail without paths.
 */
export const EvidenceFailureReasonSchema = z.enum([
  "fcheap-missing",
  "save-failed",
  "auth",
  "too-large",
  "timeout",
  "secrets-blocked",
  "unknown",
]);
export type EvidenceFailureReason = z.infer<typeof EvidenceFailureReasonSchema>;

/**
 * One file.cheap save of this run (`auto-stash`, `manual`) or of a pruned run
 * (`archive`, written to the run whose retention pass pruned it, with that
 * run's id in `runId`). `status: "error"` always carries `reason`.
 */
export const ArtifactStashEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.stash"),
    action: z.enum(["auto-stash", "manual", "archive"]),
    receipt: RelativePathSchema.optional(),
    stashId: nonEmpty.optional(),
    status: z.enum(["saved", "saved_with_failures", "error"]),
    postSaveFailureCount: z.number().int().nonnegative().optional(),
    reason: EvidenceFailureReasonSchema.optional(),
    message: z.string().optional(),
    /** Relative paths/dirs left out by the evidence gate (`traces/`). */
    excluded: z.array(z.string()).optional(),
    /** Secret-scanner findings file.cheap reported for the saved copy. */
    secretsFound: z.number().int().nonnegative().optional(),
    ttl: z.string().optional(),
    expiresAt: IsoTimestampSchema.optional(),
    tags: z.array(z.string()).optional(),
    /** archive: the pruned run this save describes. */
    runId: nonEmpty.optional(),
  })
  .strict();

/** A remote file.cheap publication of this run (or, with `runId`, a pruned one). */
export const ArtifactPublishEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.publish"),
    status: z.enum(["published", "error"]),
    /** The verified ArtifactRefV1 (credential-free, no signed URLs). */
    artifactRef: z.record(z.string(), z.unknown()).optional(),
    webUrl: z.string().url().optional(),
    receipt: RelativePathSchema.optional(),
    reason: EvidenceFailureReasonSchema.optional(),
    message: z.string().optional(),
    excluded: z.array(z.string()).optional(),
    runId: nonEmpty.optional(),
  })
  .strict();

export const ArtifactRetentionEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.retention"),
    /** warning | error | summary */
    action: nonEmpty,
    warning: z.string().optional(),
    /** The pruned run a warning is about (archive/publish failure). */
    runId: nonEmpty.optional(),
    reason: EvidenceFailureReasonSchema.optional(),
    /** summary: runs removed / retained because archiving failed. */
    removed: z.number().int().nonnegative().optional(),
    archiveFailures: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Trace capture outcome. `saved` names the kept file and its format;
 * `error` (empty file, stop failure) and `dropped` (over
 * `artifacts.capture.traceMaxBytes`) never fail the run.
 */
export const ArtifactTraceEventSchema = z
  .object({
    ts,
    type: z.literal("artifact.trace"),
    action: z.enum(["saved", "error", "dropped"]),
    path: RelativePathSchema.optional(),
    /** playwright-zip (Trace Viewer) | chrome-trace-json (Perfetto). */
    format: z.enum(["playwright-zip", "chrome-trace-json"]).optional(),
    reason: z
      .enum(["empty", "stop-failed", "too-large", "sanitize-failed"])
      .optional(),
    bytes: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
    /** `sanitized` when the sanitizer rewrote it, else `secret-bearing`. */
    sensitivity: z
      .enum(["redacted", "secret-bearing", "safe", "sanitized"])
      .optional(),
    warning: z.string().optional(),
  })
  .strict();

export const ViewportSetEventSchema = z
  .object({
    ts,
    type: z.literal("viewport.set"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    ok: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

/* ----- services lifecycle (docker / seed / tmux / teardown / stash) ----- */

/**
 * Every `services.<phase>.<event>` type the services layer emits. The
 * services layer keeps `phase` and `event` separate (ServicesEvent); the
 * writer joins them and drops anything outside this list (a unit test pins
 * every emit site in services.ts to this list).
 */
export const ServicesEventTypeSchema = z.enum([
  "services.docker.start",
  "services.docker.reuse",
  "services.docker.ready",
  "services.docker.fail",
  "services.docker.healthcheck",
  "services.docker.readiness-check",
  "services.seed.start",
  "services.seed.skip",
  "services.seed.complete",
  "services.seed.fail",
  "services.seed.freshness-check",
  "services.tmux.start",
  "services.tmux.session-created",
  "services.tmux.recreate",
  "services.tmux.reuse",
  "services.tmux.create-window",
  "services.tmux.skip",
  "services.tmux.relaunch",
  "services.tmux.ready-wait",
  "services.tmux.ready",
  "services.tmux.fail",
  "services.tmux.healthcheck",
  "services.teardown.complete",
  "services.teardown.fail",
  "services.teardown.failure-cleanup",
  "services.teardown.signal",
  "services.stash.complete",
]);
export type ServicesEventType = z.infer<typeof ServicesEventTypeSchema>;

const SERVICES_EVENT_TYPES: ReadonlySet<string> = new Set<string>(
  ServicesEventTypeSchema.options,
);

/** Type guard for joined `services.<phase>.<event>` strings. */
export function isServicesEventType(value: string): value is ServicesEventType {
  return SERVICES_EVENT_TYPES.has(value);
}

export const ServicesLifecycleEventSchema = z
  .object({
    ts,
    type: ServicesEventTypeSchema,
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/* ----- readiness gates (F2) ----- */

/**
 * Where a gate was waited on: `precondition` (a spec's `preconditions.wait`),
 * `services.docker`, `services.tmux` (a window's `readyOn.gate` / `after`),
 * `webServer` or `wait` (`cairn wait` / MCP `cairn_wait`). Free-form so a new
 * caller is additive.
 */
const gateScope = nonEmpty.optional();

export const GateStartedEventSchema = z
  .object({
    ts,
    type: z.literal("gate.started"),
    name: nonEmpty,
    /** The wait's budget; 0 means it has no deadline. */
    budgetMs: z.number().int().nonnegative(),
    scope: gateScope,
    everyMs: z.number().int().nonnegative().optional(),
    stable: z.number().int().positive().optional(),
  })
  .strict();

/**
 * One attempt's verdict. Repeated identical attempts are coalesced: an
 * attempt is written when it is the first, when ok/detail changed, or at
 * most every 5s otherwise.
 */
export const GateAttemptEventSchema = z
  .object({
    ts,
    type: z.literal("gate.attempt"),
    name: nonEmpty,
    attempt: z.number().int().positive(),
    ok: z.boolean(),
    /** e.g. `GET http://localhost:8080/health → 503 (want 2xx|3xx)`. */
    detail: z.string(),
    scope: gateScope,
  })
  .strict();

const gateEndShape = {
  ts,
  name: nonEmpty,
  attempts: z.number().int().nonnegative(),
  durationMs,
  lastDetail: z.string(),
  scope: gateScope,
};

export const GatePassedEventSchema = z
  .object({ ...gateEndShape, type: z.literal("gate.passed") })
  .strict();

export const GateFailedEventSchema = z
  .object({
    ...gateEndShape,
    type: z.literal("gate.failed"),
    timedOut: z.boolean().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();

/* ----- spec teardown (F3a) ----- */

/**
 * A spec `teardown:` step. Teardown runs after steps and outcomes on every
 * exit path (passed, failed, errored, cancelled; `run` steps also on
 * SIGINT/SIGTERM) and sees the run status in `CAIRN_RUN_STATUS`.
 */
export const TeardownStartedEventSchema = z
  .object({
    ts,
    type: z.literal("teardown.started"),
    /** 1-based position in the spec's `teardown:` list. */
    index: z.number().int().positive(),
    total: z.number().int().positive().optional(),
    /** Step kind: the step's action key (run, request, click, …). */
    kind: nonEmpty,
    stepId: nonEmpty.optional(),
    label: nonEmpty.optional(),
    /** The run status teardown sees (`CAIRN_RUN_STATUS`). */
    runStatus: z.enum(["passed", "failed", "errored"]).optional(),
    /** Set when teardown runs from the SIGINT/SIGTERM handler. */
    signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
  })
  .strict();

export const TeardownFinishedEventSchema = z
  .object({
    ts,
    type: z.literal("teardown.finished"),
    index: z.number().int().positive(),
    kind: nonEmpty,
    stepId: nonEmpty.optional(),
    status: z.enum(["passed", "failed", "skipped"]),
    durationMs,
    error: z.string().optional(),
    timedOut: z.boolean().optional(),
  })
  .strict();

/* ----- fixtures (F3b) ----- */

/**
 * One verb of a config `fixtures:` entry. `status`: `ok`, `failed`,
 * `skipped` (fresh in the ledger, ensured earlier by the invocation, a
 * teardown of a record the ensure found but did not create, or nothing to
 * do) or `dry-run` (a mutating verb where the environment policy keeps
 * fixture writes off: trait `shared` or `protected` without
 * `--allow-fixture-writes` or the spec's `write: true`, or
 * `mutations: deny`). `outputs` are the non-secret outputs after the verb
 * (sensitive keys redacted).
 * Run-scoped fixtures write these to the run's events.ndjson; suite and seed
 * fixtures also to the invocation journal.
 */
const fixtureEventShape = {
  ts,
  name: nonEmpty,
  adapter: z.enum(["exec", "mongo", "http"]),
  status: z.enum(["ok", "failed", "skipped", "dry-run"]),
  durationMs,
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  scope: z.enum(["run", "suite", "seed"]).optional(),
  /** Why it was skipped or dry-run (`fresh: ensured …`, `shared environment`). */
  reason: z.string().optional(),
  timedOut: z.boolean().optional(),
  /** Set when a teardown ran from the SIGINT/SIGTERM handler. */
  signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
};

export const FixtureEnsureEventSchema = z
  .object({ ...fixtureEventShape, type: z.literal("fixture.ensure") })
  .strict();
export const FixtureResetEventSchema = z
  .object({ ...fixtureEventShape, type: z.literal("fixture.reset") })
  .strict();
export const FixtureVerifyEventSchema = z
  .object({ ...fixtureEventShape, type: z.literal("fixture.verify") })
  .strict();
export const FixtureTeardownEventSchema = z
  .object({ ...fixtureEventShape, type: z.literal("fixture.teardown") })
  .strict();

/* ----- the union ----- */

export const RunEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunPassedEventSchema,
  RunFailedEventSchema,
  RunErroredEventSchema,
  RunRefusedEventSchema,
  PhaseChangedEventSchema,
  RunHeartbeatEventSchema,
  StepStartedEventSchema,
  StepFinishedEventSchema,
  StepFailedEventSchema,
  OutcomeStartedEventSchema,
  OutcomeProgressEventSchema,
  OutcomePassedEventSchema,
  OutcomeFailedEventSchema,
  OutcomeSkippedEventSchema,
  ExpectPassedEventSchema,
  ExpectFailedEventSchema,
  PreconditionStartedEventSchema,
  PreconditionRunEventSchema,
  PreconditionProgressEventSchema,
  HookStartedEventSchema,
  HookFinishedEventSchema,
  LogOpenedEventSchema,
  InvocationStartedEventSchema,
  InvocationFinishedEventSchema,
  ArtifactScreenshotEventSchema,
  ArtifactSnapshotEventSchema,
  ArtifactDownloadEventSchema,
  ArtifactTransformEventSchema,
  ArtifactEvalEventSchema,
  ArtifactRequestEventSchema,
  ArtifactDiagnosticsEventSchema,
  ArtifactClipEventSchema,
  ArtifactMonitorEventSchema,
  ArtifactVideoEventSchema,
  ArtifactServicesEventSchema,
  ArtifactStashEventSchema,
  ArtifactPublishEventSchema,
  ArtifactRetentionEventSchema,
  ArtifactTraceEventSchema,
  ViewportSetEventSchema,
  ServicesLifecycleEventSchema,
  GateStartedEventSchema,
  GateAttemptEventSchema,
  GatePassedEventSchema,
  GateFailedEventSchema,
  TeardownStartedEventSchema,
  TeardownFinishedEventSchema,
  FixtureEnsureEventSchema,
  FixtureResetEventSchema,
  FixtureVerifyEventSchema,
  FixtureTeardownEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type FixtureEvent = Extract<
  RunEvent,
  {
    type:
      | "fixture.ensure"
      | "fixture.reset"
      | "fixture.verify"
      | "fixture.teardown";
  }
>;
export type GateEvent = Extract<
  RunEvent,
  { type: "gate.started" | "gate.attempt" | "gate.passed" | "gate.failed" }
>;
export type RunEventType = RunEvent["type"];

/* ----- discovery / accompany session journal (`_sessions/<id>/events.ndjson`) ----- */

/**
 * Events of a session journal at `<artifactRoot>/_sessions/<sessionId>/`
 * (discovery and accompany sessions; Studio's Sessions lane reads them). A
 * separate union from {@link RunEventSchema}: a session is not a run and its
 * journal never sits where run directories do. Same compatibility rules as
 * run events (additive types/fields only). Paths are relative to the
 * session directory.
 */
const SessionKindSchema = z.enum(["discovery", "accompany"]);

export const SessionOpenedEventSchema = z
  .object({
    ts,
    type: z.literal("session.opened"),
    sessionId: nonEmpty,
    kind: SessionKindSchema,
    /** Re-opened by cairn_discover_resume (setup + steps replayed). */
    resumed: z.literal(true).optional(),
  })
  .strict();

/** One request that changed server state during an action. */
export const SessionNetworkMutationSchema = z
  .object({
    method: nonEmpty,
    /** URL path only: no origin, query string or fragment. */
    path: z.string(),
    /** Absent when no response was observed. */
    status: z.number().int().optional(),
  })
  .strict();

export const ActionPerformedEventSchema = z
  .object({
    ts,
    type: z.literal("action.performed"),
    /** 1-based action number (screenshots/NNN.png, network/NNN.json). */
    index: z.number().int().positive(),
    /** setup | open | navigate | click | fill | … | eval | request | wait | assert | choose */
    action: nonEmpty,
    locator: z.record(z.string(), z.unknown()).optional(),
    ok: z.boolean(),
    error: z.string().optional(),
    /** Page URL before / after, without query string or fragment. */
    urlBefore: z.string(),
    urlAfter: z.string(),
    durationMs,
    screenshot: RelativePathSchema.optional(),
    snapshot: RelativePathSchema.optional(),
    network: z
      .object({ mutations: z.array(SessionNetworkMutationSchema) })
      .strict()
      .optional(),
    /** Accompany: the spec step the decision was made for. */
    stepId: nonEmpty.optional(),
  })
  .strict();

export const StepRecordedEventSchema = z
  .object({
    ts,
    type: z.literal("step.recorded"),
    /** The action index that produced the step. */
    index: z.number().int().positive(),
    /** A spec step (StepSchema), placeholders kept, secrets never literal. */
    step: z.record(z.string(), z.unknown()),
    /** Accompany: where the replaced step is declared. */
    origin: z
      .object({
        file: nonEmpty,
        stepIndex: z.number().int().nonnegative(),
        stepId: nonEmpty.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const StepRemovedEventSchema = z
  .object({
    ts,
    type: z.literal("step.removed"),
    index: z.number().int().positive(),
  })
  .strict();

export const SnapshotCapturedEventSchema = z
  .object({
    ts,
    type: z.literal("snapshot.captured"),
    path: RelativePathSchema,
    bytes: z.number().int().nonnegative(),
    /** The mode the caller was answered with (the file is always full). */
    mode: z.enum(["none", "diff", "compact", "full"]),
    elements: z.number().int().nonnegative().optional(),
  })
  .strict();

export const DraftUpdatedEventSchema = z
  .object({
    ts,
    type: z.literal("draft.updated"),
    path: RelativePathSchema,
    /** Steps in the draft. */
    steps: z.number().int().nonnegative(),
  })
  .strict();

export const ExportWrittenEventSchema = z
  .object({
    ts,
    type: z.literal("export.written"),
    /** Spec path as given to the export (absolute or caller-relative). */
    path: nonEmpty,
    verify: z
      .object({
        status: z.enum(["ok", "warnings", "failed"]),
        findings: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

/**
 * A screenshot capture timed out during action `index` (Chromium had no
 * composited frame: a slept or locked display, a headless runner without a
 * rendering surface). The session keeps its browser and stops capturing
 * screenshots; later `action.performed` events carry none.
 */
export const ScreenshotsDisabledEventSchema = z
  .object({
    ts,
    type: z.literal("screenshots.disabled"),
    index: z.number().int().positive(),
    reason: z.string(),
  })
  .strict();

export const SessionClosedEventSchema = z
  .object({
    ts,
    type: z.literal("session.closed"),
    reason: z.enum(["ttl", "close", "shutdown", "export"]),
    /** Why a session ended early (e.g. its setup failed). */
    error: z.string().optional(),
  })
  .strict();

export const SessionEventSchema = z.discriminatedUnion("type", [
  SessionOpenedEventSchema,
  ActionPerformedEventSchema,
  StepRecordedEventSchema,
  StepRemovedEventSchema,
  SnapshotCapturedEventSchema,
  DraftUpdatedEventSchema,
  ExportWrittenEventSchema,
  ScreenshotsDisabledEventSchema,
  SessionClosedEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent["type"];

/**
 * Lenient twin of {@link SessionEventSchema} for readers: fields a newer
 * cairn added are dropped instead of failing the line (a skipped
 * `step.recorded` would silently lose a step on export or resume).
 */
export const SessionEventReadSchema = z.discriminatedUnion(
  "type",
  SessionEventSchema.options.map(ignoreUnknownKeys) as unknown as [
    typeof SessionOpenedEventSchema,
    ...Array<typeof SessionOpenedEventSchema>,
  ],
) as unknown as z.ZodType<SessionEvent>;
export type SessionNetworkMutation = z.infer<
  typeof SessionNetworkMutationSchema
>;
