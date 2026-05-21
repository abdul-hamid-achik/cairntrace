import { z } from "zod";
import {
  AbsolutePathSchema,
  OutcomeStatusSchema,
  RunStatusSchema,
  StepStatusSchema,
} from "./shared";

/**
 * Wire schema for `cairn diff <runA> <runB>`.
 * v1 wire contract.
 */

export const RunDiffRefSchema = z
  .object({
    id: z.string().min(1),
    runDir: AbsolutePathSchema,
    status: RunStatusSchema,
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type RunDiffRef = z.infer<typeof RunDiffRefSchema>;

export const OutcomeFlipSchema = z
  .object({
    id: z.string().min(1),
    from: OutcomeStatusSchema,
    to: OutcomeStatusSchema,
  })
  .strict();
export type OutcomeFlip = z.infer<typeof OutcomeFlipSchema>;

export const StepFlipSchema = z
  .object({
    id: z.string().min(1),
    from: StepStatusSchema,
    to: StepStatusSchema,
  })
  .strict();
export type StepFlip = z.infer<typeof StepFlipSchema>;

export const StepSlowdownSchema = z
  .object({
    id: z.string().min(1),
    fromMs: z.number().int().nonnegative(),
    toMs: z.number().int().nonnegative(),
    factor: z.number().positive(),
    deltaMs: z.number().int(),
  })
  .strict();
export type StepSlowdown = z.infer<typeof StepSlowdownSchema>;

export const ConsoleErrorEntrySchema = z
  .object({
    type: z.string(),
    text: z.string(),
  })
  .passthrough();
export type ConsoleErrorEntry = z.infer<typeof ConsoleErrorEntrySchema>;

export const NetworkFailureEntrySchema = z
  .object({
    url: z.string(),
    method: z.string(),
    status: z.number().int().optional(),
  })
  .passthrough();
export type NetworkFailureEntry = z.infer<typeof NetworkFailureEntrySchema>;

export const RunDiffSchema = z
  .object({
    $schema: z
      .literal("https://cairntrace.dev/schemas/diff.v1.json")
      .default("https://cairntrace.dev/schemas/diff.v1.json"),
    version: z.literal("1"),
    a: RunDiffRefSchema,
    b: RunDiffRefSchema,
    overall: z
      .object({
        statusChanged: z.boolean(),
        durationDeltaMs: z.number().int(),
      })
      .strict(),
    outcomes: z
      .object({
        flipped: z.array(OutcomeFlipSchema),
        addedInB: z.array(z.string()),
        removedInB: z.array(z.string()),
      })
      .strict(),
    steps: z
      .object({
        flipped: z.array(StepFlipSchema),
        slowdowns: z.array(StepSlowdownSchema),
      })
      .strict(),
    console: z
      .object({
        errorCountDelta: z.number().int(),
        newErrors: z.array(ConsoleErrorEntrySchema),
      })
      .strict(),
    network: z
      .object({
        failureCountDelta: z.number().int(),
        newFailures: z.array(NetworkFailureEntrySchema),
      })
      .strict(),
  })
  .strict();
export type RunDiff = z.infer<typeof RunDiffSchema>;
