import { z } from "zod";

/**
 * Common primitive schemas shared across run / heal / explain / spec.
 * No version suffix — these types are stable and reused across schema versions.
 * Spec/result schemas reference these by import.
 */

export const RunStatusSchema = z.enum(["passed", "failed", "errored"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const OutcomeStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>;

export const StepStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const HealStatusSchema = z.enum([
  "patch-proposed",
  "patch-applied",
  "no-heal-possible",
]);
export type HealStatus = z.infer<typeof HealStatusSchema>;

export const ContractHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "must be sha256:<64-hex>");
export type ContractHash = z.infer<typeof ContractHashSchema>;

/** Path relative to a run directory. Resolved by joining with runDir at consumption time. */
export const RelativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), "must be relative to runDir");
export type RelativePath = z.infer<typeof RelativePathSchema>;

export const AbsolutePathSchema = z.string().startsWith("/");
export type AbsolutePath = z.infer<typeof AbsolutePathSchema>;

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const BackendSchema = z.enum([
  "agent-browser",
  "playwright",
  "playwright-cli",
  "chrome-devtools-mcp",
]);
export type Backend = z.infer<typeof BackendSchema>;

/**
 * Stable exit codes across all commands. See plan §13d.
 * Repurposing a code is a breaking change.
 */
export const ExitCodeSchema = z.union([
  z.literal(0), // success
  z.literal(1), // outcome failure
  z.literal(2), // errored (crash, parse, IO)
  z.literal(3), // cold-start gate not satisfied
  z.literal(4), // lint failed
  z.literal(5), // heal-no-progress
  z.literal(6), // contract hash mismatch
]);
export type ExitCode = z.infer<typeof ExitCodeSchema>;
