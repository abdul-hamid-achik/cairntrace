import { z } from "zod";
import { IsoTimestampSchema } from "./shared";

/**
 * `<runDir>/diagnostics/metrics.json` and `<journalDir>/metrics.json` (F11):
 * what the config `metrics:` probes measured. Additive: new optional fields
 * may appear, existing ones keep their meaning. Values are finite numbers;
 * a failed sample carries a redacted `error` instead of a value.
 */
export const METRICS_SCHEMA_ID = "urn:cairntrace.dev:metrics:v1";

export const MetricSampleSchema = z
  .object({
    at: IsoTimestampSchema,
    /** Absent when the sample failed. */
    value: z.number().finite().optional(),
    /** Why the sample failed (redacted, bounded). */
    error: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type MetricSample = z.infer<typeof MetricSampleSchema>;

export const MetricSeriesSchema = z
  .object({
    /** Samples taken (failed ones included). */
    count: z.number().int().nonnegative(),
    /** The samples kept (at most 500; `truncated` when more were taken). */
    samples: z.array(MetricSampleSchema),
    truncated: z.literal(true).optional(),
    /** Over the successful samples. */
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    mean: z.number().finite().optional(),
    first: z.number().finite().optional(),
    last: z.number().finite().optional(),
  })
  .strict();

export const MetricResultSchema = z
  .object({
    name: z.string().min(1),
    scope: z.enum(["spec", "invocation"]),
    source: z.enum(["command", "http"]),
    /** `every`: sampled periodically; `sample`: at the listed phases. */
    mode: z.enum(["sample", "every"]),
    unit: z.string().min(1).optional(),
    /** Redacted: the command line, or the URL without its query. */
    target: z.string().optional(),
    before: MetricSampleSchema.optional(),
    after: MetricSampleSchema.optional(),
    /** `after - before` (`every`: last successful - first successful). */
    delta: z.number().finite().optional(),
    series: MetricSeriesSchema.optional(),
    /** Samples that failed. */
    failures: z.number().int().nonnegative(),
    /** The first failure, redacted. */
    error: z.string().optional(),
    /** `--repeat` / `--matrix`: the 1-based iteration (invocation scope). */
    iteration: z.number().int().positive().optional(),
  })
  .strict();
export type MetricResult = z.infer<typeof MetricResultSchema>;

export const MetricsDocumentSchema = z
  .object({
    $schema: z.literal(METRICS_SCHEMA_ID),
    version: z.literal("1"),
    runId: z.string().min(1).optional(),
    invocationId: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    metrics: z.array(MetricResultSchema),
  })
  .strict();
export type MetricsDocument = z.infer<typeof MetricsDocumentSchema>;
