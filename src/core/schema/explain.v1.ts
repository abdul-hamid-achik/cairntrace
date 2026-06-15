import { z } from "zod";
import { AbsolutePathSchema, BackendSchema } from "./shared";
import { VerifierKindSchema } from "./verifier.v1";

/**
 * Wire schema for `cairn explain --json` (plan §13c).
 * Bootstrapping document — an agent calls this once at session start and
 * learns the full command surface, step/verifier vocabulary, and rules.
 */

export const CommandFlagSchema = z
  .object({
    name: z.string().min(1).startsWith("--"),
    type: z.enum(["boolean", "string", "number", "enum"]),
    values: z.array(z.string()).optional(), // present iff type === "enum"
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().min(1),
  })
  .strict();
export type CommandFlag = z.infer<typeof CommandFlagSchema>;

export const CommandDocSchema = z
  .object({
    name: z.string().min(1), // e.g. "run", "spec scaffold", "spec heal"
    summary: z.string().min(1),
    synopsis: z.string().min(1),
    flags: z.array(CommandFlagSchema).default([]),
    /** exit code → meaning */
    exitCodes: z.record(z.string().regex(/^\d+$/), z.string()),
    /** URN or URL identifying the command's structured output schema, if any. */
    outputSchema: z.string().min(1).optional(),
  })
  .strict();
export type CommandDoc = z.infer<typeof CommandDocSchema>;

export const VerifierParamSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum([
      "string",
      "number",
      "boolean",
      "regex",
      "enum",
      "array",
      "tuple",
    ]),
    values: z.array(z.string()).optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
    /** When multiple fields belong to a "one of" group (e.g. equals/contains/matches). */
    oneOfGroup: z.string().optional(),
  })
  .strict();
export type VerifierParam = z.infer<typeof VerifierParamSchema>;

export const VerifierDocSchema = z
  .object({
    id: VerifierKindSchema,
    kind: z.enum([
      "ui",
      "navigation",
      "network",
      "console",
      "file",
      "escape-hatch",
    ]),
    summary: z.string().min(1),
    yamlExample: z.string().min(1),
    parameters: z.array(VerifierParamSchema),
  })
  .strict();
export type VerifierDoc = z.infer<typeof VerifierDocSchema>;

export const StepDocSchema = z
  .object({
    id: z.enum([
      "open",
      "click",
      "hover",
      "fill",
      "upload",
      "download",
      "transform",
      "request",
      "wait",
      "press",
      "scroll",
      "snapshot",
      "use",
      "batch",
    ]),
    kind: z.enum([
      "navigation",
      "interaction",
      "file",
      "network",
      "wait",
      "artifact",
    ]),
    summary: z.string().min(1),
    yamlExample: z.string().min(1),
  })
  .strict();
export type StepDoc = z.infer<typeof StepDocSchema>;

export const RulesDocSchema = z
  .object({
    coldStart: z
      .object({
        summary: z.string(),
        satisfyVia: z.array(z.string()),
        authoringGate: z.string(),
      })
      .strict(),
    contractImmutability: z
      .object({
        summary: z.string(),
        enforcedBy: z.string(),
      })
      .strict(),
    evidenceBudget: z
      .object({
        maxLines: z.number().int().positive(),
        maxListItems: z.number().int().positive(),
        deepDataLocation: z.string(),
      })
      .strict(),
    /** Optional (added in 1.6): Cairn-enforced per-step deadlines. */
    stepTimeouts: z
      .object({
        summary: z.string(),
        defaultMs: z.number().int().positive(),
        graceMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /** Optional (added in 1.6): blocked artifact-dependent outcomes report skipped. */
    blockedOutcomes: z
      .object({
        summary: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RulesDoc = z.infer<typeof RulesDocSchema>;

export const ConfigDocSchema = z
  .object({
    artifactRoot: AbsolutePathSchema,
    workflowRoots: z.array(z.string()),
    defaultEnvironment: z.string(),
    defaultBackend: BackendSchema,
    report: z
      .object({
        defaultTheme: z.string(),
        themes: z.array(z.string()),
        artifacts: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConfigDoc = z.infer<typeof ConfigDocSchema>;

export const ExplainResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:explain:v1")
      .default("urn:cairntrace.dev:explain:v1"),
    version: z.literal("1"),
    cairntrace: z
      .object({
        version: z.string().min(1),
        binary: AbsolutePathSchema,
      })
      .strict(),
    commands: z.array(CommandDocSchema),
    steps: z.array(StepDocSchema),
    verifiers: z.array(VerifierDocSchema),
    rules: RulesDocSchema,
    config: ConfigDocSchema,
  })
  .strict();
export type ExplainResult = z.infer<typeof ExplainResultSchema>;
