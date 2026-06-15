import { z } from "zod";

/**
 * Project-level Cairntrace config (plan §12).
 * Lives at `cairntrace.config.yml` somewhere in the spec's ancestor directory.
 * Discovery walks upward from the spec's directory.
 *
 * Config is OPTIONAL — specs with absolute URLs work without one.
 */

export const ConfigVarValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);
export type ConfigVarValue = z.infer<typeof ConfigVarValueSchema>;

export const ViewportConfigSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type ViewportConfig = z.infer<typeof ViewportConfigSchema>;

export const EnvironmentConfigSchema = z
  .object({
    /** Base URL prepended to `open:` steps that begin with `/`. */
    baseUrl: z.string().optional(),
    /** Variables substituted as `${vars.X}` inside specs. */
    vars: z.record(ConfigVarValueSchema).optional(),
    /** Browser viewport applied at run start. Spec-level `viewport:` wins. */
    viewport: ViewportConfigSchema.optional(),
  })
  .strict();
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

export const SecretsConfigSchema = z
  .object({
    provider: z.enum(["env"]),
    required: z.array(z.string()).optional(),
  })
  .strict();
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

export const RetentionConfigSchema = z
  .object({
    /** Keep only the newest N runs per spec; pruned after every run. */
    keepRuns: z.number().int().positive(),
  })
  .strict();
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

export const ReportThemeNameSchema = z.enum([
  "cairn",
  "graphite",
  "midnight",
  "contrast",
]);
export type ReportThemeName = z.infer<typeof ReportThemeNameSchema>;

const ReportColorValueSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[;{}<>]/.test(value),
    "report colors must be CSS color values without ; { } < >",
  );

export const ReportColorOverridesSchema = z
  .object({
    background: ReportColorValueSchema.optional(),
    surface: ReportColorValueSchema.optional(),
    surfaceAlt: ReportColorValueSchema.optional(),
    ink: ReportColorValueSchema.optional(),
    muted: ReportColorValueSchema.optional(),
    line: ReportColorValueSchema.optional(),
    accent: ReportColorValueSchema.optional(),
    accentText: ReportColorValueSchema.optional(),
    success: ReportColorValueSchema.optional(),
    warning: ReportColorValueSchema.optional(),
    danger: ReportColorValueSchema.optional(),
    info: ReportColorValueSchema.optional(),
    codeBg: ReportColorValueSchema.optional(),
  })
  .strict();
export type ReportColorOverrides = z.infer<typeof ReportColorOverridesSchema>;

export const ReportConfigSchema = z
  .object({
    /** Theme used by generated report.html / report.json artifacts. */
    theme: ReportThemeNameSchema.optional(),
    /** Optional CSS color token overrides for the selected report theme. */
    colors: ReportColorOverridesSchema.optional(),
  })
  .strict();
export type ReportConfig = z.infer<typeof ReportConfigSchema>;

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    project: z.string().optional(),
    defaultEnvironment: z.string().optional(),
    /** Override `~/.cairntrace/runs` for this project. */
    artifactRoot: z.string().optional(),
    workflowRoots: z.array(z.string()).optional(),
    environments: z.record(EnvironmentConfigSchema),
    secrets: SecretsConfigSchema.optional(),
    /** Artifact-root pruning policy (see `cairn clean`). */
    retention: RetentionConfigSchema.optional(),
    /** Human-readable report artifact styling. */
    report: ReportConfigSchema.optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
