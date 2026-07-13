import { z } from "zod";
import { RunResultSchema } from "./run.v1";
import { ExitCodeSchema } from "./shared";

/**
 * Wire schema for `cairn run <spec...> --parallel N` (multi-spec mode).
 * v1 wire contract.
 *
 * Single-spec runs still emit RunResult v1 directly (back-compat). Multi-spec
 * runs emit this batch envelope so the wire shape is unambiguous.
 */
export const BatchSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
  })
  .strict();
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

export const BatchRunResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:run-batch:v1")
      .default("urn:cairntrace.dev:run-batch:v1"),
    version: z.literal("1"),
    /** Worker concurrency the runner used; 1 means serial. */
    parallel: z.number().int().positive(),
    /** Wall-clock duration for the whole batch in ms. */
    totalDurationMs: z.number().int().nonnegative(),
    summary: BatchSummarySchema,
    /** Per-spec results in *input order* (not completion order). */
    results: z.array(RunResultSchema),
    exitCode: ExitCodeSchema,
  })
  .strict();
export type BatchRunResult = z.infer<typeof BatchRunResultSchema>;

/**
 * Signal-time partial summary for a batch that did not reach its normal
 * BatchRunResult. This is written synchronously under artifactRoot before
 * browser/service teardown. `completed` contains only fully-written RunResult
 * objects and preserves their original input order.
 */
export const AbortedBatchRunResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:run-batch-aborted:v1")
      .default("urn:cairntrace.dev:run-batch-aborted:v1"),
    version: z.literal("1"),
    aborted: z.literal(true),
    signal: z.enum(["SIGINT", "SIGTERM"]),
    startedAt: z.string().datetime({ offset: true }),
    abortedAt: z.string().datetime({ offset: true }),
    parallel: z.number().int().positive(),
    requestedTotal: z.number().int().positive(),
    pending: z.number().int().nonnegative(),
    completed: z.array(RunResultSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.completed.length + value.pending !== value.requestedTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["pending"],
        message:
          "completed.length + pending must equal requestedTotal for an aborted batch",
      });
    }
  });
export type AbortedBatchRunResult = z.infer<typeof AbortedBatchRunResultSchema>;
