import { z } from "zod";
import {
  AbsolutePathSchema,
  ContractHashSchema,
  ExitCodeSchema,
  HealStatusSchema,
  RelativePathSchema,
} from "./shared";

/**
 * Wire schema for `cairn spec heal --json` (plan §13c).
 *
 * `patch.ops` are RFC-6902-shaped JSON Pointer ops against the parsed YAML AST.
 * Agents that apply via their own file editor can replay the ops; Cairntrace's
 * --apply replays them in place.
 *
 * Mechanical guarantee: `contractHash` never changes during heal — heal aborts
 * with exit code 5 before writing anything that would mutate intent/outcomes.
 */

export const PatchOpSchema = z.union([
  z
    .object({
      op: z.literal("replace"),
      path: z.string().min(1).startsWith("/"),
      from: z.unknown(),
      to: z.unknown(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("insert"),
      path: z.string().min(1).startsWith("/"),
      value: z.unknown(),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("remove"),
      path: z.string().min(1).startsWith("/"),
      from: z.unknown().optional(),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchSchema = z
  .object({
    format: z.literal("json-pointer-ops"),
    ops: z.array(PatchOpSchema),
  })
  .strict();
export type Patch = z.infer<typeof PatchSchema>;

export const HealSpecRefSchema = z
  .object({
    path: AbsolutePathSchema,
    contractHash: ContractHashSchema.optional(),
  })
  .strict();
export type HealSpecRef = z.infer<typeof HealSpecRefSchema>;

export const HealResultSchema = z
  .object({
    $schema: z
      .literal("https://cairntrace.dev/schemas/heal.v1.json")
      .default("https://cairntrace.dev/schemas/heal.v1.json"),
    version: z.literal("1"),
    spec: HealSpecRefSchema,
    basedOnRunId: z.string().min(1),
    status: HealStatusSchema,
    /**
     * If false, the failure is a real behavior regression, not UI drift.
     * Heal will not produce a patch; exit code is 5 and the agent must escalate.
     */
    outcomesStillReachable: z.boolean(),
    patch: PatchSchema.optional(),
    /** Present iff status === "patch-applied" (i.e., --apply was used). */
    appliedPath: AbsolutePathSchema.optional(),
    /** Human-readable diff for review; path relative to the run dir of basedOnRunId. */
    diffPreview: RelativePathSchema.optional(),
    exitCode: ExitCodeSchema,
  })
  .strict()
  .refine((h) => (h.status === "patch-applied" ? !!h.appliedPath : true), {
    message: "appliedPath required when status is patch-applied",
  })
  .refine((h) => (h.status === "no-heal-possible" ? !h.patch : true), {
    message: "patch must be absent when status is no-heal-possible",
  });
export type HealResult = z.infer<typeof HealResultSchema>;
