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
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
