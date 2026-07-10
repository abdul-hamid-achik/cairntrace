import { z } from "zod";
import {
  AbsolutePathSchema,
  BackendSchema,
  ContractHashSchema,
  ExitCodeSchema,
  IsoTimestampSchema,
  OutcomeStatusSchema,
  RelativePathSchema,
  RunStatusSchema,
  StepStatusSchema,
} from "./shared";

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
  })
  .strict();
export type StepResult = z.infer<typeof StepResultSchema>;

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
export const RunFailureSchema = z
  .object({
    /** Outcome id whose verifier failed (absent when the failure is step-level or a crash). */
    outcome: z.string().min(1).optional(),
    /** Step id that failed (absent when the failure is outcome-level or a crash). */
    step: z.string().min(1).optional(),
    /** Canonical one-liner reason the run did not pass. Populated on status=failed|errored. */
    message: z.string().min(1),
  })
  .strict();
export type RunFailure = z.infer<typeof RunFailureSchema>;

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
  if (f?.step) {
    return [
      {
        command: rerun,
        reason: `step "${f.step}" failed: ${f.message} — inspect the step evidence and run artifacts, fix the spec or app, then rerun`,
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
    spec: RunSpecRefSchema,
    environment: z.string().min(1),
    backend: BackendSchema,
    coldStart: z.boolean(),
    status: RunStatusSchema,
    /**
     * Canonical one-liner describing the run outcome. Always populated by
     * `cairn run`; agents can surface it directly without opening per-step or
     * per-outcome evidence. Concise, not a substitute for the structured
     * `failure` object on non-passing runs.
     */
    summary: z.string().min(1).optional(),
    /**
     * Structured failure reason, populated on `status=failed|errored`. Holds
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
    exitCode: ExitCodeSchema,
    nextActions: z.array(NextActionSchema).optional(),
  })
  .strict();
export type RunResult = z.infer<typeof RunResultSchema>;

/** Convenience: derive the canonical absolute path for an artifact reference. */
export const absoluteArtifactPath = (
  result: RunResult,
  relative: string,
): string => `${result.runDir}/${relative}`;
