import { z } from "zod";
import { LocatorSchema } from "./spec.v1";

/**
 * Agent-neutral journey brief (v1).
 *
 * Compiled from a spec (+ optional last green run). The harness uses this to
 * complete a journey when authored locators do not replay. Intent + outcomes
 * stay the contract; steps are search approximations + authored values.
 */

export const BRIEF_RULES = [
  "Do not change the contract (intent / outcomes).",
  "Do not invent values or extra navigation.",
  "Prefer role / accessible name / label over CSS.",
  "Authored by: selector is a stale hint unless it hits.",
  "Stop when every outcome holds.",
] as const;

export const BriefActionSchema = z.enum([
  "open",
  "click",
  "fill",
  "type",
  "select",
  "hover",
  "focus",
  "wait",
  "upload",
  "download",
  "scroll",
  "press",
  "batch",
  "machine",
]);

export const BriefValueSchema = z.union([
  z.object({ kind: z.literal("literal"), text: z.string() }).strict(),
  z.object({ kind: z.literal("secret"), name: z.string().min(1) }).strict(),
]);

export const BriefStepSchema = z
  .object({
    id: z.string().min(1),
    action: BriefActionSchema,
    goal: z.string().min(1),
    value: BriefValueSchema.optional(),
    authored: LocatorSchema.optional(),
    seenLocally: z
      .object({
        role: z.string().min(1),
        name: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    approximations: z.array(z.string().min(1)),
    doneWhen: z.string().min(1),
    brittle: z.boolean().optional(),
    skip: z.string().min(1).optional(),
  })
  .strict();

export const BriefOutcomeSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    doneWhen: z.string().min(1),
  })
  .strict();

export const BriefCoverageSkipSchema = z
  .object({
    kind: z.enum(["step", "outcome"]),
    id: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();

export const BriefCoverageSchema = z
  .object({
    steps: z.number().int().nonnegative(),
    stepsBriefed: z.number().int().nonnegative(),
    skips: z.array(BriefCoverageSkipSchema),
  })
  .strict();

export const BriefSetupSchema = z
  .object({
    environment: z.string().min(1).optional(),
    coldStart: z.enum([
      "guest",
      "checkpoint",
      "imports",
      "preconditions",
      "unspecified",
    ]),
    detail: z.string().min(1).optional(),
  })
  .strict();

export const BriefDocumentSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:brief:v1")
      .default("urn:cairntrace.dev:brief:v1"),
    version: z.literal("1"),
    spec: z
      .object({
        name: z.string().min(1),
        path: z.string().min(1),
        contractHash: z.string().min(1).optional(),
      })
      .strict(),
    intent: z.string().min(1),
    setup: BriefSetupSchema.optional(),
    rules: z.array(z.string().min(1)).min(1),
    outcomes: z.array(BriefOutcomeSchema).min(1),
    steps: z.array(BriefStepSchema),
    requiredSecrets: z.array(z.string().min(1)),
    coverage: BriefCoverageSchema,
    fromRun: z
      .object({
        runId: z.string().min(1),
        runDir: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const BriefMissPacketSchema = z
  .object({
    step: BriefStepSchema,
    error: z.string().min(1),
    inventory: z.unknown().optional(),
    snapshot: z.string().optional(),
  })
  .strict();

export type BriefAction = z.infer<typeof BriefActionSchema>;
export type BriefValue = z.infer<typeof BriefValueSchema>;
export type BriefStep = z.infer<typeof BriefStepSchema>;
export type BriefOutcome = z.infer<typeof BriefOutcomeSchema>;
export type BriefCoverage = z.infer<typeof BriefCoverageSchema>;
export type BriefSetup = z.infer<typeof BriefSetupSchema>;
export type BriefDocument = z.infer<typeof BriefDocumentSchema>;
export type BriefMissPacket = z.infer<typeof BriefMissPacketSchema>;
