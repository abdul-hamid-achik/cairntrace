import { z } from "zod";
import { AbsolutePathSchema, RunStatusSchema } from "./shared";

/**
 * Wire schema for `cairn stats`.
 * Aggregate run cohorts (by label) for A/B comparisons such as rabbit vs temporal.
 */

export const StatsRunRefSchema = z
  .object({
    runId: z.string().min(1),
    runDir: AbsolutePathSchema,
    specName: z.string().min(1),
    status: RunStatusSchema,
    durationMs: z.number().int().nonnegative(),
    startedAt: z.string().min(1).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    /** Harvested domain metric (e.g. processingDurationMS from outcome raw). */
    metricMs: z.number().nonnegative().optional(),
  })
  .strict();
export type StatsRunRef = z.infer<typeof StatsRunRefSchema>;

export const StatsPercentilesSchema = z
  .object({
    n: z.number().int().nonnegative(),
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    mean: z.number().nonnegative().optional(),
    p50: z.number().nonnegative().optional(),
    p95: z.number().nonnegative().optional(),
    p99: z.number().nonnegative().optional(),
  })
  .strict();
export type StatsPercentiles = z.infer<typeof StatsPercentilesSchema>;

export const StatsGroupSchema = z
  .object({
    /** Value of the group-by label for this cohort (e.g. "rabbit"). */
    key: z.string().min(1),
    runs: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    /** Wall-clock run duration (browser suite time). */
    duration: StatsPercentilesSchema,
    /**
     * Domain metric harvested from outcomes/*.raw.json when available
     * (e.g. EventLog.processingDurationMS). Absent when no samples.
     */
    metric: StatsPercentilesSchema.optional(),
    metricName: z.string().optional(),
  })
  .strict();
export type StatsGroup = z.infer<typeof StatsGroupSchema>;

export const StatsDeltaSchema = z
  .object({
    /** Baseline group key (first after sort, or --baseline). */
    baseline: z.string().min(1),
    /** Compared group key. */
    against: z.string().min(1),
    passRateDelta: z.number(),
    durationP50Ratio: z.number().optional(),
    durationP95Ratio: z.number().optional(),
    metricP50Ratio: z.number().optional(),
    metricP95Ratio: z.number().optional(),
  })
  .strict();
export type StatsDelta = z.infer<typeof StatsDeltaSchema>;

export const StatsResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:stats:v1")
      .default("urn:cairntrace.dev:stats:v1"),
    version: z.literal("1"),
    artifactRoot: AbsolutePathSchema,
    groupBy: z.string().min(1),
    /** Label filters applied (AND). */
    filter: z.record(z.string(), z.string()).optional(),
    metricName: z.string().optional(),
    scanned: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    groups: z.array(StatsGroupSchema),
    /** Pairwise deltas vs baseline group (when ≥2 groups). */
    deltas: z.array(StatsDeltaSchema).optional(),
    runs: z.array(StatsRunRefSchema).optional(),
  })
  .strict();
export type StatsResult = z.infer<typeof StatsResultSchema>;
