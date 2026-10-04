import { z } from "zod";
import {
  AbsolutePathSchema,
  BackendSchema,
  ContractHashSchema,
  DELEGATE_CONTRACT,
  ExitCodeSchema,
  IsoTimestampSchema,
  OutcomeStatusSchema,
  RelativePathSchema,
  RunStatusSchema,
  StepStatusSchema,
} from "./shared";
import { BriefMissPacketSchema } from "./brief.v1";
import { SpecRequiresSchema } from "./spec.v1";

/**
 * Wire schema for `cairn run --json` (plan §13c).
 * Treat as a v1 contract — bumping is a breaking change for in-session agents.
 *
 * All paths inside outcomes/steps/artifacts are RELATIVE to `runDir`.
 * Agents construct absolute paths by joining runDir + relativePath.
 */

export const OutcomeResultSchema = z
  .object({
    id: z.string().min(1),
    status: OutcomeStatusSchema,
    /** Path to the per-outcome evidence markdown file (§13b shape). */
    evidence: RelativePathSchema.optional(),
    /** Untruncated deep data — present when a verifier emits raw evidence. */
    evidenceRaw: RelativePathSchema.optional(),
  })
  .strict();
export type OutcomeResult = z.infer<typeof OutcomeResultSchema>;

export const StepResultSchema = z
  .object({
    id: z.string().min(1),
    status: StepStatusSchema,
    durationMs: z.number().int().nonnegative(),
    error: z.string().optional(),
    artifacts: z.array(RelativePathSchema).optional(),
    /** The snapshot element a semantic locator resolved to before acting. */
    resolved: z
      .object({
        role: z.string().min(1),
        name: z.string().optional(),
        ref: z.string().optional(),
      })
      .strict()
      .optional(),
    /*
     * F14 control flow (all absent for the steps of a flat spec). Nested
     * executions are recorded in post-order: a block's steps come before the
     * block's own result, so the first failed entry is the innermost failure.
     */
    /** Id of the enclosing repeat / if / retried use step. */
    parentId: z.string().min(1).optional(),
    /** 1-based iteration (repeat) or attempt (retry) of the innermost loop. */
    iteration: z.number().int().positive().optional(),
    /** The if branch this execution ran in. */
    branch: z.enum(["then", "else"]).optional(),
    /** repeat: iterations that ran; retried use: attempts that ran. */
    iterations: z.number().int().nonnegative().optional(),
    /** if step: the branch that ran (`none`: false without else). */
    taken: z.enum(["then", "else", "none"]).optional(),
    /** Optional / grouped wait: whether its condition held. */
    matched: z.boolean().optional(),
    /**
     * F15: the interaction path the step took (click `pointer` | `dispatch`,
     * fill `set`, upload `setInputFiles` | `dataTransfer`, a widget driver's
     * write path).
     */
    via: z.string().min(1).optional(),
    /** F15: the widget driver of a single-field set / check / choose step. */
    driver: z.string().min(1).optional(),
    /** F15: why that path was taken (`pointer blocked by div.p-dialog-mask`). */
    detail: z.string().min(1).optional(),
    /** F15: why a step that ran was skipped (`absent`). */
    skipReason: z.string().min(1).optional(),
    /**
     * Retried use: the attempts that failed and were retried (their step
     * results are dropped from `steps`; their artifacts move to this step).
     */
    retries: z
      .array(
        z
          .object({
            attempt: z.number().int().positive(),
            error: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type StepResult = z.infer<typeof StepResultSchema>;

export const ArtifactManifestEntrySchema = z
  .object({
    /** Portable path relative to runDir. */
    path: RelativePathSchema,
    /** Stable semantic category assigned by ArtifactWriter. */
    kind: z.string().min(1),
    /** Exact file size used when calculating sha256. */
    bytes: z.number().int().nonnegative(),
    /** Lowercase SHA-256 digest of the artifact bytes. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * `redacted` — written by cairn through the run redactor;
     * `safe` — browser-produced media/files with no credential structure
     * (screenshots, videos, downloads); `sanitized` — a backend trace the
     * best-effort trace sanitizer rewrote (stashable when `traces` is
     * included, never published); `secret-bearing` — raw bytes that may
     * carry credentials (an unsanitized trace, a raw monitor/heap profile,
     * text cairn did not write itself). Stash and publish gate on it.
     */
    sensitivity: z
      .enum(["redacted", "secret-bearing", "safe", "sanitized"])
      .optional(),
  })
  .strict();
export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;
export type ArtifactSensitivity = NonNullable<
  ArtifactManifestEntry["sensitivity"]
>;

export const ArtifactManifestSchema = z
  .object({
    version: z.literal("1"),
    artifacts: z.array(ArtifactManifestEntrySchema),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export const RunArtifactsSchema = z
  .object({
    report: RelativePathSchema.optional(),
    reportJson: RelativePathSchema.optional(),
    agentContext: RelativePathSchema,
    events: RelativePathSchema,
    screenshots: z.array(RelativePathSchema).optional(),
    snapshots: z.array(RelativePathSchema).optional(),
    downloads: z.record(z.string(), RelativePathSchema).optional(),
    transforms: z.record(z.string(), RelativePathSchema).optional(),
    /** request-step response envelopes (requests/<assign>.json), by assign name. */
    requests: z.record(z.string(), RelativePathSchema).optional(),
    /** eval-step captured values (evals/<assign>.json), by assign name. */
    evals: z.record(z.string(), RelativePathSchema).optional(),
    diagnostics: z.array(RelativePathSchema).optional(),
    /** Manifest for bounded, redacted service logs captured with this run. */
    services: RelativePathSchema.optional(),
    /** `diagnostics/process.json` from a --monitor run (browser process metrics). */
    processMetrics: RelativePathSchema.optional(),
    console: RelativePathSchema.optional(),
    network: RelativePathSchema.optional(),
    trace: RelativePathSchema.optional(),
    video: RelativePathSchema.optional(),
    /** Named video clips produced by vidtrace from the run video. */
    clips: z.record(z.string(), RelativePathSchema).optional(),
    /** Exact-replay manifest (SPEC §7.3). */
    replay: RelativePathSchema.optional(),
    /** Deterministic checksummed inventory of files in this run directory. */
    manifest: RelativePathSchema.optional(),
  })
  .strict();
export type RunArtifacts = z.infer<typeof RunArtifactsSchema>;

export const RunSpecRefSchema = z
  .object({
    name: z.string().min(1),
    path: AbsolutePathSchema,
    contractHash: ContractHashSchema.optional(),
  })
  .strict();

/**
 * Link from a run to the `cairn run` invocation that produced it (the
 * invocation journal at `<artifactRoot>/<dir>/invocation.json`). Optional and
 * additive: runs started outside an invocation journal omit it.
 */
export const RunInvocationRefSchema = z
  .object({
    /** `<ISO timestamp with ':'/'.' → '-'>_<pid>_<6 hex>`. */
    id: z.string().min(1),
    /** Position of this run in the invocation's plan (1-based). */
    index: z.number().int().nonnegative(),
    /** Number of planned runs in the invocation. */
    total: z.number().int().nonnegative(),
    /** Journal directory relative to artifactRoot, e.g. `_invocations/<id>`. */
    dir: RelativePathSchema,
  })
  .strict();
export type RunInvocationRef = z.infer<typeof RunInvocationRefSchema>;

/**
 * What the config `run:` block did, when it did anything notable: the lock,
 * critical teardown entries that failed (exit 8), what survived the run
 * (exit 9) and `finally` commands that failed. The journal summary's
 * `runPolicy`, and `invocationOutcome.runPolicy` of a printed document.
 */
export const InvocationRunPolicySchema = z
  .object({
    lock: z
      .object({
        path: z.string().min(1),
        scope: z.enum(["project", "config"]),
        reclaimed: z.literal(true).optional(),
      })
      .strict()
      .optional(),
    criticalTeardown: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            command: z.string(),
            exitCode: z.number().int().optional(),
            timedOut: z.boolean().optional(),
            signal: z.string().optional(),
            error: z.string().optional(),
            path: z.enum(["teardown", "signal"]),
          })
          .strict(),
      )
      .optional(),
    dirty: z
      .array(
        z
          .object({
            phase: z.enum(["before", "after"]),
            kind: z.enum(["browsers", "tmux", "docker-project"]),
            name: z.string().min(1).optional(),
            survivors: z.array(z.string()),
          })
          .strict(),
      )
      .optional(),
    finallyFailed: z.number().int().positive().optional(),
  })
  .strict();
export type InvocationRunPolicy = z.infer<typeof InvocationRunPolicySchema>;

/**
 * How the whole invocation settled, on a document `cairn run` prints (and
 * MCP `cairn_run` returns) when the invocation's lifecycle can change the
 * exit code after the specs ran: a config `run:` policy, or a critical
 * `services.teardown` entry / provisioner `down`. Such a document is held
 * until that verdict, so its top-level `exitCode` IS the process exit code
 * (8 critical teardown failed, 9 dirty machine after the run, precedence
 * 8 > 9 > the specs' own code). A SIGINT / SIGTERM that ends cairn before
 * the verdict hands over the documents that finished with `exitCode` 130 /
 * 143 (the top-level `exitCode` stays the specs'). Additive.
 */
export const InvocationOutcomeSchema = z
  .object({
    /**
     * The invocation's exit code (the process exit code): a stable exit
     * code, or 130 / 143 when SIGINT / SIGTERM ended cairn first.
     */
    exitCode: z.union([ExitCodeSchema, z.literal(130), z.literal(143)]),
    /** The code the specs alone produced, before the teardown verdict. */
    specsExitCode: ExitCodeSchema,
    /** Why `exitCode` differs from `specsExitCode` (redacted). */
    error: z.string().min(1).optional(),
    /** What the config `run:` block did (see the journal summary). */
    runPolicy: InvocationRunPolicySchema.optional(),
    /**
     * The invocation ran on a delegated runner (`environments.<n>.runner`):
     * `exitCode` is the runner's, unless a diagnostic overrode it (an
     * invalid code, a missing run directory, a false pass). Additive.
     */
    delegate: z
      .object({
        contract: z.literal(DELEGATE_CONTRACT),
        remoteInvocationId: z.string().min(1).optional(),
        /** The runner's own exit code (absent when a signal ended it). */
        runnerExitCode: z.number().int().optional(),
        runnerSignal: z.string().min(1).optional(),
        /** `delegate.diagnostic` events of the invocation journal. */
        diagnostics: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type InvocationOutcome = z.infer<typeof InvocationOutcomeSchema>;

export const RunFailureSchema = z
  .object({
    /** Execution phase that failed before/around a browser step. */
    phase: z.string().min(1).optional(),
    /** Authored phase item name (for example a named precondition). */
    name: z.string().min(1).optional(),
    /** Outcome id whose verifier failed (absent when the failure is step-level or a crash). */
    outcome: z.string().min(1).optional(),
    /** Step id that failed (absent when the failure is outcome-level or a crash). */
    step: z.string().min(1).optional(),
    /** Canonical one-liner reason the run did not pass. Populated on status=failed|errored|refused. */
    message: z.string().min(1),
    /** Actual elapsed time in the failed phase. */
    durationMs: z.number().int().nonnegative().optional(),
    /** True when the phase was terminated by its configured deadline. */
    timedOut: z.boolean().optional(),
    /** Termination signal reported by the child-process runner, when present. */
    signal: z.string().min(1).optional(),
    /**
     * Agent brief for the failed interactive step (search approximations +
     * authored values). Present on locator-style step failures.
     */
    brief: BriefMissPacketSchema.optional(),
  })
  .strict();
export type RunFailure = z.infer<typeof RunFailureSchema>;

/**
 * Why the environment policy refused a spec (`status: "refused"`). Refused
 * specs never start services, preconditions or a browser and have no run
 * directory: the result carries `synthetic: true` and its `runId` / `runDir`
 * are never-written placeholders.
 */
export const RunRefusalCodeSchema = z.enum([
  /** `requires.env` does not list the resolved environment. */
  "env-not-listed",
  /** Listed with `optIn`, but that variable is not `1`/`true`. */
  "opt-in-missing",
  /** `requires.mutates: true` where `policy.mutations: deny`. */
  "mutations-denied",
  /** `policy.trait: protected` and the spec does not list the environment. */
  "protected-env",
]);
export type RunRefusalCode = z.infer<typeof RunRefusalCodeSchema>;

export const RunRefusalSchema = z
  .object({
    /** One-line human reason (also the run summary). */
    reason: z.string().min(1),
    /** The resolved environment the spec was refused in. */
    env: z.string().min(1),
    /** The spec's `requires:` block as authored (empty object when absent). */
    requires: SpecRequiresSchema,
    /** Machine-readable reason. */
    code: RunRefusalCodeSchema.optional(),
    /** The environment's `policy:` block, when the config defines one. */
    policy: z
      .object({
        trait: z.enum(["owned", "shared", "protected"]).optional(),
        mutations: z.enum(["allow", "deny"]).optional(),
        description: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RunRefusal = z.infer<typeof RunRefusalSchema>;

/** `cairn pin <run>`: retention never prunes a pinned run. */
export const RunPinSchema = z
  .object({
    at: IsoTimestampSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export type RunPin = z.infer<typeof RunPinSchema>;

/**
 * One actionable next step an agent can take after a non-passing run, derived
 * from the run's failure so a weak model gets a concrete command instead of
 * treating the error as ambiguous (SPEC §7.1 verification contracts — mirrors
 * glyphrun's nextActions convention). safeToAutoRun is always false: no
 * repair is safe without the operator.
 */
export const NextActionSchema = z
  .object({
    tool: z.string().optional(),
    command: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().min(1),
    safeToAutoRun: z.boolean(),
  })
  .strict();
export type NextAction = z.infer<typeof NextActionSchema>;

/** Build the nextActions for a run result from its status + failure. */
export const buildRunNextActions = (
  result: Pick<RunResult, "status" | "failure" | "spec">,
): NextAction[] => {
  if (result.status === "passed") return [];
  const rerun = `cairn run ${result.spec.path} --json`;
  const f = result.failure;
  if (result.status === "refused") {
    return [
      {
        command: `cairn spec verify ${result.spec.path} --json`,
        reason: `refused by the environment policy: ${f?.message ?? "refused"} — verify lists the environments this spec may run in; rerun with --env <one of them>`,
        safeToAutoRun: false,
      },
    ];
  }
  if (f?.phase === "session") {
    return [
      {
        command: "cairn checkpoint list --json",
        reason: `checkpoint "${f.name ?? "unknown"}" cannot be resumed: ${f.message} — recapture it with \`cairn login ${f.name ?? "<name>"} --url <login-url> --env <env>\`, then rerun`,
        safeToAutoRun: false,
      },
    ];
  }
  if (f?.phase === "precondition") {
    return [
      {
        command: rerun,
        reason: `precondition "${f.name ?? "unknown"}" failed: ${f.message} — inspect events.ndjson and fix the environment or precondition before rerunning`,
        safeToAutoRun: false,
      },
    ];
  }
  if (f?.step) {
    // A step that did not complete is the classic locator-drift case: heal
    // repairs the selector from a fresh snapshot. Outcome failures (all steps
    // ran, an assertion failed) are behavior regressions, not drift, so heal
    // is only suggested here.
    return [
      {
        command: rerun,
        reason: `step "${f.step}" failed: ${f.message} — inspect the step evidence and run artifacts, fix the spec or app, then rerun`,
        safeToAutoRun: false,
      },
      {
        command: `cairn spec heal ${result.spec.path} --verify --json`,
        reason: `step "${f.step}" did not complete (likely locator drift): heal repairs the selector from a fresh snapshot and re-verifies before writing`,
        safeToAutoRun: false,
      },
      {
        command: `cairn export brief ${result.spec.path} --format md`,
        reason: `step "${f.step}" failed: emit an agent brief (search approximations + authored values) with cairn export brief`,
        safeToAutoRun: false,
      },
    ];
  }
  if (f?.outcome) {
    return [
      {
        command: rerun,
        reason: `outcome "${f.outcome}" verifier failed: ${f.message} — inspect the outcome evidence, fix the spec or app, then rerun`,
        safeToAutoRun: false,
      },
    ];
  }
  return [
    {
      command: rerun,
      reason: `run ${result.status}: ${f?.message ?? result.status} — inspect the run artifacts, then rerun`,
      safeToAutoRun: false,
    },
  ];
};

export const RunResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:run:v1")
      .default("urn:cairntrace.dev:run:v1"),
    version: z.literal("1"),
    runId: z.string().min(1),
    runDir: AbsolutePathSchema,
    /**
     * `true` when cairn never created this run: `runId` and `runDir` are
     * placeholders that name nothing on disk (a spec the environment policy
     * refused, or one that errored or was cancelled before its run started).
     * Do not open them; there is no run directory, artifact or log to read.
     * Absent on every run that wrote a run directory. Additive.
     */
    synthetic: z.literal(true).optional(),
    spec: RunSpecRefSchema,
    environment: z.string().min(1),
    /**
     * The `environments.<name>: { alias }` name `--env` used, when it named
     * one: `environment` is then the alias target. Additive.
     */
    envAlias: z.string().min(1).optional(),
    backend: BackendSchema,
    coldStart: z.boolean(),
    /**
     * Optional free-form labels stamped by `cairn run --label key=value`
     * (repeatable). Used by `cairn stats --group-by <key>` to build A/B
     * cohorts (e.g. path=legacy vs path=next) without inventing a separate
     * benchmark format. Keys/values are plain strings; empty object is omitted.
     */
    labels: z.record(z.string(), z.string()).optional(),
    /** The `cairn run` invocation this run belongs to, when journaled. */
    invocation: RunInvocationRefSchema.optional(),
    status: RunStatusSchema,
    /** Present on `status: "refused"`: what the environment policy refused. */
    refusal: RunRefusalSchema.optional(),
    /** Set by `cairn pin`; retention never prunes a pinned run. */
    pinned: RunPinSchema.optional(),
    /**
     * Canonical one-liner describing the run outcome. Always populated by
     * `cairn run`; agents can surface it directly without opening per-step or
     * per-outcome evidence. Concise, not a substitute for the structured
     * `failure` object on non-passing runs.
     */
    summary: z.string().min(1).optional(),
    /**
     * Structured failure reason, populated on `status=failed|errored|refused`. Holds
     * the single canonical "why" — the first failed step (with its id + error)
     * or the first failed outcome (with its id) — so a consumer doesn't have
     * to scan steps[]/outcomes[] to synthesize a reason. Absent on `passed`.
     */
    failure: RunFailureSchema.optional(),
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
    durationMs: z.number().int().nonnegative(),
    outcomes: z.array(OutcomeResultSchema),
    steps: z.array(StepResultSchema),
    artifacts: RunArtifactsSchema,
    /**
     * The spec's exit code — on a document `cairn run` prints for an
     * invocation with a `run:` policy or a critical teardown, the
     * invocation's (see `invocationOutcome`).
     */
    exitCode: ExitCodeSchema,
    /**
     * Present on a printed document whose invocation could change the exit
     * code after the spec ran (config `run:` policy, critical teardown). A
     * spec that passed while the invocation settled on 8 or 9 reads
     * `status: "errored"` with `failure.phase: "invocation"`;
     * `invocationOutcome.specsExitCode` keeps the spec's own code (run.json
     * in the run directory is never rewritten). Additive.
     */
    invocationOutcome: InvocationOutcomeSchema.optional(),
    nextActions: z.array(NextActionSchema).optional(),
  })
  .strict();
export type RunResult = z.infer<typeof RunResultSchema>;

/** Convenience: derive the canonical absolute path for an artifact reference. */
export const absoluteArtifactPath = (
  result: RunResult,
  relative: string,
): string => `${result.runDir}/${relative}`;
