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
      .literal("https://cairntrace.dev/schemas/run-batch.v1.json")
      .default("https://cairntrace.dev/schemas/run-batch.v1.json"),
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
