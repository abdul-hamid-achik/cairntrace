import { z } from "zod";

/**
 * Common primitive schemas shared across run / heal / explain / spec.
 * No version suffix — these types are stable and reused across schema versions.
 * Spec/result schemas reference these by import.
 */

/**
 * `refused`: the environment policy refused the spec before anything started
 * (no services, preconditions or browser, and no run directory). Additive;
 * readers that switch on status should treat an unknown value as "did not
 * pass".
 */
export const RunStatusSchema = z.enum([
  "passed",
  "failed",
  "errored",
  "refused",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const OutcomeStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>;

export const StepStatusSchema = z.enum(["passed", "failed", "skipped"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/**
 * F15 built-in widget driver names, in default detection order (config
 * `browser.widgets: [{ use: … }]`, step `driver:`). Lives here so both the
 * spec and the config schema can import it without a cycle.
 */
export const BUILTIN_WIDGET_DRIVERS = [
  "vue-multiselect",
  "primevue-autocomplete",
  "primevue-calendar",
  "pills",
  "radio-group",
  "checkbox-group",
  "native-select",
  "native-input",
] as const;
export type BuiltinWidgetDriver = (typeof BUILTIN_WIDGET_DRIVERS)[number];

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

/**
 * The delegated-runner contract (`environments.<n>.runner`): the request a
 * runner reads, the events stream it writes and the run directories it
 * places. Versioned; v1 changes only additively. See
 * `src/core/schema/delegate.v1.ts` and `docs/delegate.md`.
 */
export const DELEGATE_CONTRACT = "urn:cairntrace.dev:delegate:v1";

export const BackendSchema = z.enum([
  "agent-browser",
  "playwright",
  "playwright-cli",
  "chrome-devtools-mcp",
  "mock",
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
  z.literal(7), // refused by the environment policy (requires.env / mutates)
  z.literal(8), // a critical teardown failed (outranks every verdict)
  z.literal(9), // dirty state after the run (run.verifyClean)
]);
export type ExitCode = z.infer<typeof ExitCodeSchema>;
