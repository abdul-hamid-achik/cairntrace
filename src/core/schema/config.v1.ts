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

/**
 * Server lifecycle for the whole `cairn run` invocation (build → boot →
 * readiness → setup → teardown), the same role Playwright's `webServer` plays.
 * One server is shared by all specs; it starts once before the pool and stops
 * once after (parallel-safe). See `src/core/runner/webServer.ts`.
 *
 * Readiness is satisfied by `url` (an HTTP probe), `waitForText` (a stdout/stderr
 * substring), or — when neither is set — the resolved environment `baseUrl`. The
 * schema is structural only; the run-scope loader rejects a block that supplies
 * none of the three once the baseUrl is known (a schema `.refine` can't see it,
 * because `baseUrl` lives on the environment, not on `webServer`).
 */
export const WebServerConfigSchema = z
  .object({
    /** Command that starts the server, e.g. "node .output/server/index.mjs". */
    command: z.string().min(1),
    /**
     * Optional one-shot build/prepare command, run ONCE before `command` —
     * but skipped when an existing server is reused. e.g. "bun run build".
     */
    build: z.string().min(1).optional(),
    /**
     * Readiness probe URL: cairn polls it until it answers (any HTTP response,
     * incl. 3xx/4xx — "the socket accepts and the app replies"). Defaults to the
     * resolved environment `baseUrl`. Usable together with `waitForText`.
     */
    url: z.string().url().optional(),
    /** Or treat the server ready once this substring appears on stdout/stderr. */
    waitForText: z.string().min(1).optional(),
    /** Extra env for the spawned process, merged over process.env. ${env.X} ok. */
    env: z.record(z.string()).optional(),
    /** Working directory for build/command (default: the config file's dir). */
    cwd: z.string().optional(),
    /**
     * Reuse a server already answering `url` instead of spawning one (and skip
     * `build`/`setup`/`teardown` of a server cairn didn't start). Default: true,
     * except it flips to false under `--cold-start` or a truthy `CI` so CI always
     * boots fresh. An explicit value here always wins.
     */
    reuseExisting: z.boolean().optional(),
    /** Max ms to wait for readiness before failing the run. Default 60000. */
    readyTimeoutMs: z.number().int().positive().optional(),
    /** Shell commands run AFTER the server is ready, BEFORE specs. */
    setup: z.array(z.string().min(1)).optional(),
    /** Shell commands run AFTER specs (teardown), best-effort, non-fatal. */
    teardown: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type WebServerConfig = z.infer<typeof WebServerConfigSchema>;

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
    /** Optional server lifecycle for `cairn run` (build/boot/ready/teardown). */
    webServer: WebServerConfigSchema.optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
