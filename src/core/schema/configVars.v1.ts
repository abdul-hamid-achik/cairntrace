import { z } from "zod";

/**
 * `cairn config vars` / MCP `cairn_config_vars` (F7): every config var with
 * its kind, effective value per environment (secret-looking values masked),
 * where it is defined (file:line), what overrides it and what uses it.
 */
export const CONFIG_VARS_SCHEMA_ID = "urn:cairntrace.dev:config-vars:v1";

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const ConfigVarKindSchema = z.enum([
  "string",
  "number",
  "boolean",
  "list",
  "object",
  "mixed",
]);

export const ConfigVarUseKindSchema = z.enum([
  "spec",
  "action",
  "script",
  "fixture",
  "datasource",
  "gate",
  "suite",
  "auth",
  "config",
  "var",
]);
export type ConfigVarUseKind = z.infer<typeof ConfigVarUseKindSchema>;

export const ConfigVarUseSchema = z
  .object({
    kind: ConfigVarUseKindSchema,
    /** Spec / action / fixture / datasource / var name, or a config key. */
    name: z.string().min(1),
    /** Relative to the config directory. */
    file: z.string().min(1),
  })
  .strict();
export type ConfigVarUse = z.infer<typeof ConfigVarUseSchema>;

const DefinitionSchema = z
  .object({
    /** `vars` (top-level, also from an included file) or `environments.<env>.vars`. */
    scope: z.string().min(1),
    /** `file:line` relative to the config directory (`file` alone when the line is unknown). */
    at: z.string().min(1),
    /** Came through a YAML merge key / alias: the anchor's environment (or `&anchor`). */
    inheritedFrom: z.string().optional(),
  })
  .strict();

const EnvValueSchema = z
  .object({
    /**
     * Effective value (masked when it looks like a credential). For a var
     * whose value carries environment data — `${env.X}` / `${secrets.X}` at
     * any depth of its definition, or a reference to such a var or to a
     * credential-named one — the authored template instead
     * (`fromEnvironment: true`): an environment value is never shown.
     */
    value: JsonValueSchema,
    masked: z.literal(true).optional(),
    /** `value` is the authored template, not the resolved value. Additive. */
    fromEnvironment: z.literal(true).optional(),
    /** The definition that wins in this environment. */
    scope: z.string().min(1),
    at: z.string().min(1),
    /** Authored text when it held placeholders (`${env.X}`, `${vars.X}`), masked. */
    template: z.string().optional(),
  })
  .strict();

export const ConfigVarRowSchema = z
  .object({
    name: z.string().min(1),
    kind: ConfigVarKindSchema,
    /** Every environment's value is the same (only with 2+ environments). */
    sameInAllEnvironments: z.boolean().optional(),
    /** Environment → effective value. */
    values: z.record(EnvValueSchema),
    /** Every definition, lowest precedence first. */
    definedAt: z.array(DefinitionSchema),
    /** Definitions that win over an earlier one, with the environments where they do. */
    overriddenBy: z.array(
      DefinitionSchema.extend({ envs: z.array(z.string().min(1)) }).strict(),
    ),
    usedBy: z.array(ConfigVarUseSchema),
    /** No spec, action, script verifier, fixture, datasource, gate or config value uses it. */
    unused: z.literal(true).optional(),
  })
  .strict();
export type ConfigVarRow = z.infer<typeof ConfigVarRowSchema>;

export const ConfigFindingSchema = z
  .object({
    level: z.enum(["error", "warning", "info"]),
    code: z.enum([
      "include-override",
      "include-empty",
      "unused-var",
      "var-reference",
      "literal-var-ref",
      "suite-env-fallback",
    ]),
    message: z.string().min(1),
    key: z.string().optional(),
    /** `file:line` relative to the config directory. */
    at: z.string().optional(),
    overriddenBy: z.string().optional(),
    identical: z.literal(true).optional(),
  })
  .strict();
export type ConfigFindingRow = z.infer<typeof ConfigFindingSchema>;

export const ConfigVarsResultSchema = z
  .object({
    $schema: z.literal(CONFIG_VARS_SCHEMA_ID),
    version: z.literal("1"),
    ok: z.boolean(),
    /** The config file (absolute). */
    path: z.string(),
    /** Config files read: the config, then included files (relative). */
    files: z.array(z.string()),
    /** Environments covered (all, or the `--env` one). */
    environments: z.array(z.string()),
    filter: z
      .object({
        env: z.string().optional(),
        /** `--env` named an `alias:` environment: `env` is its target. Additive. */
        envAlias: z.string().optional(),
        unused: z.literal(true).optional(),
        usedBy: z.string().optional(),
      })
      .strict()
      .optional(),
    totals: z
      .object({
        vars: z.number().int().nonnegative(),
        unused: z.number().int().nonnegative(),
        sameInAllEnvironments: z.number().int().nonnegative(),
        differing: z.number().int().nonnegative(),
        /** Defined in 2+ environments with the same value everywhere it is defined: candidates for top-level `vars:` or `extends`. */
        sameWhereDefined: z.number().int().nonnegative(),
      })
      .strict(),
    vars: z.array(ConfigVarRowSchema),
    findings: z.array(ConfigFindingSchema),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type ConfigVarsResult = z.infer<typeof ConfigVarsResultSchema>;
