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
    /** Untruncated deep data — present only for the `script` escape hatch. */
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
  })
  .strict();
export type StepResult = z.infer<typeof StepResultSchema>;

export const RunArtifactsSchema = z
  .object({
    agentContext: RelativePathSchema,
    events: RelativePathSchema,
    screenshots: z.array(RelativePathSchema).optional(),
    snapshots: z.array(RelativePathSchema).optional(),
    downloads: z.record(z.string(), RelativePathSchema).optional(),
    diagnostics: z.array(RelativePathSchema).optional(),
    console: RelativePathSchema.optional(),
    network: RelativePathSchema.optional(),
    trace: RelativePathSchema.optional(),
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
export type RunSpecRef = z.infer<typeof RunSpecRefSchema>;

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
    startedAt: IsoTimestampSchema,
    endedAt: IsoTimestampSchema,
    durationMs: z.number().int().nonnegative(),
    outcomes: z.array(OutcomeResultSchema),
    steps: z.array(StepResultSchema),
    artifacts: RunArtifactsSchema,
    exitCode: ExitCodeSchema,
  })
  .strict();
export type RunResult = z.infer<typeof RunResultSchema>;

/** Convenience: derive the canonical absolute path for an artifact reference. */
export const absoluteArtifactPath = (
  result: RunResult,
  relative: string,
): string => `${result.runDir}/${relative}`;
