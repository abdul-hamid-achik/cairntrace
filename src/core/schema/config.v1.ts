import { z } from "zod";
import {
  gateRefNames,
  GateRefListSchema,
  GateRefSchema,
  GatesRegistrySchema,
  type GateRefList,
} from "../gates/schema";
import {
  DatasourcesConfigSchema,
  EnvironmentDatasourcesSchema,
  type EnvironmentDatasources,
} from "../datasources/schema";
import { resolveEnvironmentDatasources } from "../datasources/resolve";
import { FixturesRegistrySchema } from "../fixtures/schema";

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

// Forward-declared as an interface so ConfigSchema (below) and runtimeContext
// can reference EnvironmentConfig before EnvironmentConfigSchema is assigned
// (it depends on ServicesConfigSchema + SecretsConfigSchema, defined later).
export interface EnvironmentConfig {
  baseUrl?: string;
  vars?: Record<string, ConfigVarValue>;
  viewport?: ViewportConfig;
  /** Multiplier for browser waits, settles, and network-idle quiet windows. */
  waitScale?: number;
  /** Per-env services override: false disables all; partial ServicesConfig
   * is deep-merged over the top-level services block. `tmux: false` removes
   * only inherited local tmux windows while retaining docker/seed phases. */
  services?: false | EnvironmentServicesConfig;
  /** Per-env secrets override (replaces the top-level secrets block). */
  secrets?: SecretsConfig;
  /** What runs here: ownership trait and whether specs may mutate data. */
  policy?: EnvironmentPolicy;
  /** Per-env datasource overrides (partial entries merge; `false` disables). */
  datasources?: EnvironmentDatasources;
}

/**
 * Environment policy (`environments.<name>.policy`), enforced by `cairn run`
 * before anything starts:
 *
 * - `trait`: `owned` (yours alone), `shared` (others use it) or `protected`
 *   (a spec must list this environment in `requires.env` to run here).
 * - `mutations: deny` refuses specs that declare `requires.mutates: true`.
 * - `description`: shown in refusals and `cairn spec verify`.
 */
export const EnvironmentPolicySchema = z
  .object({
    trait: z.enum(["owned", "shared", "protected"]).optional(),
    mutations: z.enum(["allow", "deny"]).optional(),
    description: z.string().min(1).optional(),
  })
  .strict();
export type EnvironmentPolicy = z.infer<typeof EnvironmentPolicySchema>;

export const SecretsProviderSchema = z.enum(["env", "tvault"]);
export type SecretsProvider = z.infer<typeof SecretsProviderSchema>;

export const TvaultConfigSchema = z
  .object({
    /** TinyVault project name (direct mode). Mutually exclusive with group+env. */
    project: z.string().min(1).optional(),
    /** TinyVault environment group name (inheritance mode). Requires `env`. */
    group: z.string().min(1).optional(),
    /** Environment name within the group (requires `group`). */
    env: z.string().min(1).optional(),
    /** TinyVault identity name for sealed secrets (optional). */
    identity: z.string().optional(),
  })
  .strict()
  .refine((cfg) => {
    const hasProject = !!cfg.project;
    const hasGroup = !!cfg.group;
    const hasEnv = !!cfg.env;
    if (hasProject) return !hasGroup && !hasEnv;
    if (hasGroup) return hasEnv;
    return false;
  }, "tvault: specify either `project` (direct) or both `group` + `env` (inheritance) — not both");
export type TvaultConfig = z.infer<typeof TvaultConfigSchema>;

export const SecretsConfigSchema = z
  .object({
    provider: SecretsProviderSchema.default("env"),
    /**
     * Explicit TinyVault allowlist. Cairntrace resolves only these keys (plus
     * keys referenced by `${env.X}` / `${secrets.X}` in the spec), never an
     * entire project merely to populate a child environment.
     */
    keys: z.array(z.string().min(1)).optional(),
    required: z.array(z.string()).optional(),
    /** TinyVault config when provider is tvault. */
    tvault: TvaultConfigSchema.optional(),
  })
  .strict()
  .refine((cfg) => cfg.provider !== "tvault" || cfg.tvault !== undefined, {
    message:
      "secrets.provider: tvault requires a `tvault:` block with either `project` or `group`+`env`",
  });
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

/**
 * Evidence categories a stash, retention archive or publish may carry:
 * `text` (run records, events, logs, snapshots, network/console — always
 * redacted), `screenshots`, `traces`, `videos` and `downloads` (downloads and
 * transform outputs). Default {@link DEFAULT_EVIDENCE_INCLUDE}.
 */
export const EVIDENCE_CATEGORIES = [
  "text",
  "screenshots",
  "traces",
  "videos",
  "downloads",
] as const;
export const EvidenceCategorySchema = z.enum(EVIDENCE_CATEGORIES);
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;
export const DEFAULT_EVIDENCE_INCLUDE: readonly EvidenceCategory[] = [
  "text",
  "screenshots",
];

export const EvidenceIncludeSchema = z
  .array(EvidenceCategorySchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "include categories must be unique",
  })
  .refine((values) => values.includes("text"), {
    message:
      "include must contain `text` (run.json, events and logs make the copy usable)",
  });

/** file.cheap TTL: `24h`, `7d`, `2w`, … or an ISO date `2026-12-31`. */
export const StashTtlSchema = z
  .string()
  .regex(
    /^(?:[1-9][0-9]*[mhdw]|\d{4}-\d{2}-\d{2})$/,
    "ttl must look like 24h, 7d, 2w or 2026-12-31",
  );

export const RetentionConfigSchema = z
  .object({
    /** Enable artifact-root pruning after every run (default: true). */
    enabled: z.boolean().default(true),
    /** Keep only the newest N runs per spec; pruned after every run. Default 3. */
    keepRuns: z.number().int().positive().default(3),
    /**
     * Keep the newest N failed/errored runs per spec even past `keepRuns` —
     * added after the 2026-07-12 incident where evidence for a genuine
     * streamed-SSR /dashboard failure was lost to routine pruning before it
     * could be inspected. Default 10.
     */
    keepFailedRuns: z.number().int().nonnegative().default(10),
    /** Archive pruned run dirs to fcheap before deletion (default: false). */
    archiveToStash: z.boolean().default(false),
    /** Tags applied to every run archived by `archiveToStash`. */
    archiveTags: z.array(z.string()).optional(),
    /** Explicit remote publication before a pruned run is removed. */
    publish: z
      .object({
        enabled: z.boolean().default(false),
        /** Remote file.cheap retention for published run packages. */
        retentionDays: z.number().int().min(1).max(31).default(7),
        /**
         * Evidence categories published (default [text, screenshots]).
         * Secret-bearing and sanitized members (every trace) are never
         * published.
         */
        include: EvidenceIncludeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Logging configuration for the CLI diagnostic/lifecycle output. All logs go
 * to stderr (stdout is reserved for structured results). Resolved with CLI
 * flags (--log-level/--log-format/--quiet/--verbose/--no-color) and env
 * (CAIRN_LOG_LEVEL, CAIRN_LOG_FORMAT, NO_COLOR) overriding this block.
 */
export const LoggingConfigSchema = z
  .object({
    /** Minimum level to show: debug | info | warn | error | silent. */
    level: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
    /** Line format: human (colored, scoped) | json (one NDJSON object per line). */
    format: z.enum(["human", "json"]).optional(),
    /** Enable ANSI colors in human format (default: TTY-aware). */
    color: z.boolean().optional(),
  })
  .strict();
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

export const ReportThemeNameSchema = z.enum([
  "cairn",
  "slate",
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
     * Readiness probe URL: cairn polls it until it answers 2xx or 3xx
     * (redirects are not followed). Without `url` and `waitForText`, the
     * resolved environment `baseUrl` is probed under the same rule. Usable
     * together with `waitForText` and `ready`. Any HTTP answer (a 503
     * included) used to count — `anyResponse: true` keeps that rule.
     */
    url: z.string().url().optional(),
    /** Accept any HTTP answer from the readiness URL (the old rule). Default false. */
    anyResponse: z.boolean().optional(),
    /** Or treat the server ready once this substring appears on stdout/stderr. */
    waitForText: z.string().min(1).optional(),
    /**
     * Gates (registry names or inline) waited in order after `url` /
     * `waitForText` succeed — also when an existing server is reused. A gate
     * without its own `timeout` gets what is left of `readyTimeoutMs`.
     */
    ready: GateRefListSchema.optional(),
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

/**
 * Readiness signal for a tmux service window. At least one of `url`, `text`
 * or `gate` should be set; `url` is an HTTP probe (2xx/3xx unless
 * `anyResponse`), `text` is a substring scanned from the tmux pane's captured
 * output, `gate` is a readiness gate (registry name or inline). `url` and
 * `text` are alternatives: either one signals the window. A `gate` must pass
 * IN ADDITION (alone, it decides). Without `readyOn` the window is
 * considered ready immediately (fire-and-forget services).
 */
export const TmuxReadyOnSchema = z
  .object({
    /** HTTP URL to probe: ready on a 2xx/3xx answer (redirects not followed). */
    url: z.string().url().optional(),
    /** Accept any HTTP answer from `url` (the old rule). Default false. */
    anyResponse: z.boolean().optional(),
    /** Substring to scan for in the tmux pane's output. */
    text: z.string().min(1).optional(),
    /**
     * A readiness gate polled with the pane checks; its `stable` applies, the
     * window's readiness deadline (tmux `readyTimeoutMs`) replaces its
     * `timeout`.
     */
    gate: GateRefSchema.optional(),
  })
  .strict();
export type TmuxReadyOn = z.infer<typeof TmuxReadyOnSchema>;

/**
 * Healthcheck config for docker and tmux windows. Like Docker's HEALTHCHECK:
 * a command that is run periodically, and the service is considered unhealthy
 * after `retries` consecutive failures (with `interval` between checks).
 * `startPeriod` gives the service time to boot before the first check.
 *
 * If the healthcheck fails (unhealthy), cairn logs a warning but does NOT
 * automatically stop the services — it surfaces the failure in the run output
 * so the user can act on it. The initial readiness is still handled by
 * `readyOn` (url/text) or `readinessCheck` (docker).
 */
export const HealthcheckSchema = z
  .object({
    /** Shell command whose exit 0 means healthy, non-zero means unhealthy. */
    command: z.string().min(1),
    /** Seconds between health checks (default 30). */
    intervalSeconds: z.number().int().positive().optional(),
    /** Seconds to wait before the first check (boot grace, default 0). */
    startPeriodSeconds: z.number().int().nonnegative().optional(),
    /** Consecutive failures before marking unhealthy (default 3). */
    retries: z.number().int().positive().optional(),
    /** Seconds before a single check is considered failed (default 10). */
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();
export type Healthcheck = z.infer<typeof HealthcheckSchema>;

/**
 * A tmux pre-command: a plain command string, or `{run, skipIf}` where
 * `skipIf` is a shell probe run HOST-SIDE (cwd = the window's cwd) before
 * sending `run` to the pane. Probe exit 0 means "already fresh — skip run"
 * (mirrors the seed freshnessCheck pattern, e.g. skip a minutes-long
 * `yarn build` when dist/ is newer than every source file). Probe exit
 * non-zero (or probe failure) means the pre-command runs.
 */
export const TmuxPreCommandSchema = z.union([
  z.string().min(1),
  z
    .object({
      /** The pre-command to send to the pane (e.g. "yarn build"). */
      run: z.string().min(1),
      /** Host-side freshness probe; exit 0 = skip `run`. */
      skipIf: z.string().min(1).optional(),
    })
    .strict(),
]);
export type TmuxPreCommand = z.infer<typeof TmuxPreCommandSchema>;

function serviceArtifactWindowSegment(value: string): string | undefined {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return safe && safe !== "." && safe !== ".." ? safe : undefined;
}

/** A single tmux window running one service. */
export const TmuxWindowSchema = z
  .object({
    /** Window name (becomes the tmux window title; must be unique within the session). */
    name: z
      .string()
      .min(1)
      .max(100)
      .refine(
        (name) => serviceArtifactWindowSegment(name) !== undefined,
        "tmux window name must produce a safe service-artifact filename",
      ),
    /** Working directory (relative to configDir or absolute). */
    cwd: z.string().optional(),
    /** Command to send to the window's shell (sent via `tmux send-keys ... Enter`). */
    command: z.string().min(1),
    /** How cairn knows this window's service is ready. */
    readyOn: TmuxReadyOnSchema.optional(),
    /**
     * Gates waited before this window is booted (e.g. the database it
     * connects to), with the window's env (session env + window env). Each
     * gate uses its own `timeout`, else the tmux `readyTimeoutMs` — per gate,
     * not shared with the windows' readiness wait. A window that is already
     * live is not re-booted, so it does not wait.
     */
    after: GateRefListSchema.optional(),
    /** Extra env vars for this window's command (merged over process.env + session env). */
    env: z.record(z.string()).optional(),
    /**
     * Optional pre-commands to run before the main `command` in the same pane
     * (e.g. `yarn build` before `yarn start`). Each is sent via `tmux send-keys ... Enter`
     * and cairn waits for it to finish before sending the next. A pre-command that
     * blocks will prevent the main command from running — use only for commands
     * that exit (build, migrate, etc). Entries may be objects `{run, skipIf}`
     * to skip expensive builds when a host-side freshness probe passes — see
     * TmuxPreCommandSchema.
     */
    preCommands: z.array(TmuxPreCommandSchema).optional(),
    /**
     * Periodic healthcheck run after the window becomes ready. If the check
     * fails `retries` consecutive times, cairn logs a warning. Does NOT
     * auto-stop services — see HealthcheckSchema.
     */
    healthcheck: HealthcheckSchema.optional(),
  })
  .strict();
export type TmuxWindow = z.infer<typeof TmuxWindowSchema>;

/**
 * tmux session-level options applied via `tmux set-option -t <session> <key> <value>`.
 * Common options: `mouse on`, `base-index 1`, `history-limit 50000`, `default-shell /bin/zsh`.
 */
export const TmuxSessionOptionSchema = z
  .object({
    /** tmux option name (e.g. `mouse`, `base-index`, `history-limit`). */
    key: z.string().min(1),
    /** Option value as a string (tmux accepts string values). */
    value: z.string(),
  })
  .strict();
export type TmuxSessionOption = z.infer<typeof TmuxSessionOptionSchema>;

/** Docker infrastructure step (e.g. `docker compose up -d`). */
export const DockerConfigSchema = z
  .object({
    /** Command to start infrastructure (run once, shell, completes). */
    command: z.string().min(1),
    /** Working directory (default: configDir). */
    cwd: z.string().optional(),
    /** Extra env merged over process.env. */
    env: z.record(z.string()).optional(),
    /** Max ms to wait for the command to finish. Default 120000. 0 = wait indefinitely. */
    readyTimeoutMs: z.number().int().nonnegative().optional(),
    /**
     * Reuse if containers are already running (default: true, false in CI).
     * When true, cairn checks `docker compose ps` for running containers and
     * skips the command if any are found.
     */
    reuseExisting: z.boolean().optional(),
    /**
     * Optional readiness check command whose exit 0 means infra is ready
     * (e.g. `docker compose ps --format json | grep running`). Run after the
     * start command completes. If not set, the command's exit code is the signal.
     */
    readinessCheck: z.string().min(1).optional(),
    /**
     * Gates (registry names or inline) waited in order after the start
     * command and `readinessCheck` — also when running containers are
     * reused. A gate without its own `timeout` gets what `readinessCheck`
     * left of `readyTimeoutMs` (all of it on reuse; 0 = no deadline; default
     * 120000).
     */
    ready: GateRefListSchema.optional(),
    /**
     * Periodic healthcheck for docker infra, run after the readiness check
     * passes. If the check fails `retries` consecutive times, cairn logs a
     * warning. Does NOT auto-stop services — see HealthcheckSchema.
     */
    healthcheck: HealthcheckSchema.optional(),
  })
  .strict();
export type DockerConfig = z.infer<typeof DockerConfigSchema>;

/**
 * Conditional seed step. Runs once per `cairn run` invocation, but only if the
 * data is stale (fingerprint changed, TTL expired, or freshnessCheck failed).
 * State is tracked in `~/.cairntrace/services/<project>.seed.json`.
 *
 * `postCommands` always run after the seed decision (whether the heavy seed
 * command ran or was skipped as fresh). Use them for lightweight fixture
 * ensure scripts that must re-apply after every demo-import *and* when seed
 * is skipped (e.g. clone a missing kit document the import does not ship).
 */
export const SeedConfigSchema = z
  .object({
    /** The seed command (shell, completes, potentially long-running). */
    command: z.string().min(1),
    /** Working directory (default: configDir). */
    cwd: z.string().optional(),
    /** Extra env merged over process.env + tvault secrets. */
    env: z.record(z.string()).optional(),
    /** Re-seed if the last run was more than this many seconds ago. Default 0 (always). */
    ttlSeconds: z.number().int().nonnegative().optional(),
    /**
     * Optional command whose exit 0 means "data is fresh, skip seed".
     * Run after the TTL check passes. Exit non-zero triggers a re-seed.
     */
    freshnessCheck: z.string().min(1).optional(),
    /**
     * Shell commands that ALWAYS run after the seed phase, even when the main
     * seed command was skipped as fresh. Failures are fatal (abort startup).
     * Ideal for mongosh/ensure scripts that materialize test fixtures the
     * bulk import does not include.
     */
    postCommands: z.array(z.string().min(1)).optional(),
    /** Max ms to wait for the seed command. Default 300000 (5 min). 0 = wait indefinitely. */
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SeedConfig = z.infer<typeof SeedConfigSchema>;

/**
 * tmux session config — creates a session with N windows, each running a service.
 * Cairn creates the session from scratch via `tmux new-session -d`, sends commands
 * to each window, and optionally waits for readiness signals. The session is
 * killed on teardown (or Ctrl-C via the signal cleanup path).
 */
export const TmuxConfigSchema = z
  .object({
    /** tmux session name. */
    session: z.string().min(1),
    /** Windows to create, each running one service. */
    windows: z.array(TmuxWindowSchema).min(1),
    /** Reuse if the session already exists (default: true, false in CI). */
    reuseExisting: z.boolean().optional(),
    /**
     * Boot windows in declaration order, waiting for each window's `readyOn`
     * before booting the next. Opt-in; the default boots all windows first.
     */
    waitForReadyBeforeNext: z.boolean().optional(),
    /** Max ms to wait for all windows to become ready. Default 90000. 0 = wait indefinitely. */
    readyTimeoutMs: z.number().int().nonnegative().optional(),
    /**
     * Session-level options applied after session creation via
     * `tmux set-option -t <session> <key> <value>`. Common options:
     * `mouse`, `base-index`, `history-limit`, `default-shell`, `status`.
     */
    options: z.array(TmuxSessionOptionSchema).optional(),
    /**
     * Extra env vars applied to ALL windows via `tmux set-environment`.
     * Per-window `env` overrides these for that window only.
     */
    env: z.record(z.string()).optional(),
    /**
     * Shell to use for the tmux session (passed as the last positional arg
     * to `tmux new-session -d -s <name> <shell>` when set). Defaults to the
     * user's default shell.
     */
    defaultShell: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (cfg) => {
      const names = cfg.windows.map((w) => w.name);
      return new Set(names).size === names.length;
    },
    { message: "tmux window names must be unique within a session" },
  )
  .refine(
    (cfg) => {
      const artifactNames = cfg.windows.map((window) =>
        serviceArtifactWindowSegment(window.name),
      );
      return new Set(artifactNames).size === artifactNames.length;
    },
    {
      message:
        "tmux window names must remain unique after service-artifact filename sanitization",
    },
  );
export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

export const SERVICES_ARTIFACT_CAPTURE_SOURCES = [
  "lifecycle",
  "tmux",
  "docker",
  "seed",
] as const;
export const DEFAULT_SERVICES_ARTIFACT_MAX_LINES_PER_SOURCE = 2_000;
export const DEFAULT_SERVICES_ARTIFACT_MAX_BYTES_PER_SOURCE = 512 * 1024;
export const DEFAULT_SERVICES_ARTIFACT_MAX_BYTES_PER_RUN = 8 * 1024 * 1024;

/**
 * Local, per-run service diagnostics. This is deliberately independent from
 * `services.stash`: local evidence is useful even when fcheap is unavailable,
 * while stash remains an optional publication mechanism.
 *
 * The `services.artifacts` block itself is optional. Runtime callers resolve a
 * missing block through this schema (`parse({})`), so the effective default is
 * still `when: on-failure` without making `ServicesConfig` awkward for direct
 * programmatic callers.
 */
export const ServicesArtifactsConfigSchema = z
  .object({
    /** Capture never, only for failed/errored runs, or for every run. */
    when: z.enum(["never", "on-failure", "always"]).default("on-failure"),
    /** Service evidence sources to include in the returned bundle. */
    capture: z
      .array(z.enum(SERVICES_ARTIFACT_CAPTURE_SOURCES))
      .min(1)
      .max(SERVICES_ARTIFACT_CAPTURE_SOURCES.length)
      .default([...SERVICES_ARTIFACT_CAPTURE_SOURCES])
      .refine(
        (sources) => new Set(sources).size === sources.length,
        "services.artifacts.capture sources must be unique",
      ),
    /** Tail lines requested from each tmux pane / Docker Compose log. */
    maxLinesPerSource: z
      .number()
      .int()
      .min(1)
      .max(50_000)
      .default(DEFAULT_SERVICES_ARTIFACT_MAX_LINES_PER_SOURCE),
    /** Hard UTF-8 byte cap for one returned artifact. */
    maxBytesPerSource: z
      .number()
      .int()
      .min(256)
      .max(16 * 1024 * 1024)
      .default(DEFAULT_SERVICES_ARTIFACT_MAX_BYTES_PER_SOURCE),
    /** Hard aggregate UTF-8 byte cap for the complete per-run bundle. */
    maxBytesPerRun: z
      .number()
      .int()
      .min(256)
      .max(128 * 1024 * 1024)
      .default(DEFAULT_SERVICES_ARTIFACT_MAX_BYTES_PER_RUN),
  })
  .strict()
  .refine((cfg) => cfg.maxBytesPerSource <= cfg.maxBytesPerRun, {
    message: "services.artifacts.maxBytesPerSource must be <= maxBytesPerRun",
    path: ["maxBytesPerSource"],
  });
export type ServicesArtifactsConfig = z.infer<
  typeof ServicesArtifactsConfigSchema
>;
export type ServicesArtifactCaptureSource =
  (typeof SERVICES_ARTIFACT_CAPTURE_SOURCES)[number];

/** Resolve the effective policy when the optional block is absent. */
export function resolveServicesArtifactsConfig(
  config: ServicesArtifactsConfig | undefined,
): ServicesArtifactsConfig {
  return ServicesArtifactsConfigSchema.parse(config ?? {});
}

/**
 * DEPRECATED — use `services.artifacts` (bounded, redacted service logs inside
 * each run directory, which `stash.autoStash` then carries) instead; `cairn
 * config validate` warns. Until removal: stashes tmux pane output, docker logs
 * and seed output to fcheap as a separate stash after the services stop,
 * honoring `autoStash` (unset keeps the old behavior: after every
 * invocation), redacting every capture with the run redactor, and passing
 * `ttl` (default 7d). Best-effort — a missing fcheap only warns.
 */
export const ServicesStashConfigSchema = z
  .object({
    /** Enable stashing services artifacts to fcheap (default: false). */
    enabled: z.boolean().default(false),
    /**
     * When to stash: always (after every run) | on-failure (only when a run
     * of the invocation failed or errored) | never. Unset: `always`, the
     * behavior `enabled: true` had before autoStash was honored (the
     * services stop prints a deprecation line).
     */
    autoStash: z.enum(["always", "on-failure", "never"]).optional(),
    /** Tags applied to every services stash (e.g. [sample-app, services]). */
    tags: z.array(z.string()).optional(),
    /** file.cheap TTL for the services stash (default 7d). */
    ttl: StashTtlSchema.optional(),
    /**
     * What to capture: tmux (pane captures for each window), docker (compose
     * logs), seed (seed command output). Default: ["tmux", "docker", "seed"].
     * Only the configured/running phases are captured.
     */
    capture: z
      .array(z.enum(["tmux", "docker", "seed"]))
      .default(["tmux", "docker", "seed"]),
  })
  .strict();
export type ServicesStashConfig = z.infer<typeof ServicesStashConfigSchema>;

/**
 * Multi-service environment lifecycle for `cairn run`: docker infra →
 * conditional seed → tmux session with service windows → teardown. Starts once
 * before the spec pool, stops once after. See `src/core/runner/services.ts`.
 *
 * Each phase is optional — configure only what you need. Phases run in order:
 * docker → seed → tmux. Teardown runs in reverse: tmux kill → docker down.
 */
export const ServicesConfigSchema = z
  .object({
    /** Docker infrastructure step (optional). */
    docker: DockerConfigSchema.optional(),
    /** Conditional seed step (optional). */
    seed: SeedConfigSchema.optional(),
    /** tmux session with service windows (optional). */
    tmux: TmuxConfigSchema.optional(),
    /** Shell commands run AFTER specs (teardown), best-effort, non-fatal. */
    teardown: z.array(z.string().min(1)).optional(),
    /** Bounded local service evidence returned for attachment to each run. */
    artifacts: ServicesArtifactsConfigSchema.optional(),
    /** Stash services session artifacts to fcheap after the run. */
    stash: ServicesStashConfigSchema.optional(),
  })
  .strict()
  .refine(
    (cfg) => {
      // Validate: if tmux is configured with readiness probes, each window
      // with readyOn must have at least one of url or text.
      if (!cfg.tmux) return true;
      for (const win of cfg.tmux.windows) {
        if (
          win.readyOn &&
          !win.readyOn.url &&
          !win.readyOn.text &&
          win.readyOn.gate === undefined
        ) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        "tmux window readyOn must specify at least one of `url`, `text` or `gate`",
    },
  );
export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

/**
 * Environment service overlays accept the normal optional phases plus a
 * targeted `tmux: false` escape hatch. This is needed when applications run
 * remotely but the same environment still owns docker/seed through a tunnel.
 */
export const EnvironmentServicesConfigSchema = z
  .object({
    docker: DockerConfigSchema.optional(),
    seed: SeedConfigSchema.optional(),
    tmux: z.union([TmuxConfigSchema, z.literal(false)]).optional(),
    teardown: z.array(z.string().min(1)).optional(),
    artifacts: ServicesArtifactsConfigSchema.optional(),
    stash: ServicesStashConfigSchema.optional(),
  })
  .strict()
  .refine(
    (cfg) => {
      if (!cfg.tmux) return true;
      return cfg.tmux.windows.every(
        (win) =>
          !win.readyOn ||
          win.readyOn.url ||
          win.readyOn.text ||
          win.readyOn.gate !== undefined,
      );
    },
    {
      message:
        "tmux window readyOn must specify at least one of `url`, `text` or `gate`",
    },
  );
export type EnvironmentServicesConfig = z.infer<
  typeof EnvironmentServicesConfigSchema
>;

export const EnvironmentConfigSchema = z
  .object({
    /** Base URL prepended to `open:` steps that begin with `/`. */
    baseUrl: z.string().optional(),
    /** Variables substituted as `${vars.X}` inside specs. */
    vars: z.record(ConfigVarValueSchema).optional(),
    /** Browser viewport applied at run start. Spec-level `viewport:` wins. */
    viewport: ViewportConfigSchema.optional(),
    /** Multiply waits/settles for high-latency environments. Default 1. */
    waitScale: z.number().positive().finite().optional(),
    /** Per-env services override: false disables all; partial ServicesConfig
     * is deep-merged over the top-level services block. */
    services: z
      .union([z.literal(false), EnvironmentServicesConfigSchema])
      .optional(),
    /** Per-env secrets override (replaces the top-level secrets block). */
    secrets: SecretsConfigSchema.optional(),
    /** Environment policy: trait + mutations (see EnvironmentPolicySchema). */
    policy: EnvironmentPolicySchema.optional(),
    /**
     * Per-env datasource overrides: a partial entry merges over the
     * top-level `datasources.<name>`; `<name>: false` disables it here.
     */
    datasources: EnvironmentDatasourcesSchema.optional(),
  })
  .strict();

export const StashConfigSchema = z
  .object({
    /** Enable fcheap stash integration (default: false). */
    enabled: z.boolean().default(false),
    /**
     * Auto-stash runs: always (every run) | on-failure (failed/errored) |
     * never (default). Refused runs are never stashed.
     */
    autoStash: z.enum(["always", "on-failure", "never"]).default("never"),
    /** Tags applied to every auto-stashed run (a spec's `stash.tags` add to them). */
    tags: z.array(z.string()).optional(),
    /**
     * Evidence categories stashed and archived (default [text, screenshots]):
     * traces, videos and downloads stay local unless listed here.
     */
    include: EvidenceIncludeSchema.optional(),
    /**
     * Stash/archive secret-bearing members: a trace that could not be
     * sanitized, a raw monitor profile, text cairn did not write itself.
     * Never applies to publish. Default false.
     */
    unsafeIncludeRawTraces: z.boolean().optional(),
    /** TTL for every auto-stash unless passTtl/failTtl is set. */
    ttl: StashTtlSchema.optional(),
    /** TTL for passed runs (autoStash: always / --stash). Default 7d. */
    passTtl: StashTtlSchema.optional(),
    /** TTL for failed/errored runs. Default: ttl, else never expires. */
    failTtl: StashTtlSchema.optional(),
    /**
     * Tag auto-stashes with every `cairn run --label key=value` (default
     * false: labels are free-form cohort values; `meta` already records the
     * run identity as structured manifest fields).
     */
    labelsAsTags: z.boolean().optional(),
    /**
     * Pass `--meta run_id= status= spec= env= backend= cairn_version=` to
     * fcheap save when the installed fcheap supports it (default true).
     */
    meta: z.boolean().optional(),
  })
  .strict();
export type StashConfig = z.infer<typeof StashConfigSchema>;

export const ClipPointSchema = z
  .object({
    /** Human-readable label used in the clip filename. */
    label: z.string().min(1),
    /** Start timestamp (SS, MM:SS, or HH:MM:SS). */
    start: z.string().min(1),
    /** End timestamp (SS, MM:SS, or HH:MM:SS). */
    end: z.string().min(1),
  })
  .strict();
export type ClipPoint = z.infer<typeof ClipPointSchema>;

export const ClipConfigSchema = z
  .object({
    /** Pre-defined clip points for this spec. */
    points: z.array(ClipPointSchema).optional(),
    /** Default tags applied to auto-generated clips. */
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type ClipConfig = z.infer<typeof ClipConfigSchema>;

/**
 * Browser-backend tuning knobs for the agent-browser adapter.
 */
export const BrowserConfigSchema = z
  .object({
    /**
     * Confirm same-tab link delivery from URL, document, or DOM evidence.
     * Default: true.
     */
    verifyAfterClick: z.boolean().optional(),
    /** Opt-in project-level budget in ms for post-click networkidle settling. */
    postClickSettleMs: z.number().int().positive().optional(),
    /**
     * agent-browser provider (`-p`): `ios` (Mobile Safari via Appium), or a
     * cloud provider (`browserbase`, `kernel`, …). Unset uses local Chromium.
     */
    provider: z.string().optional(),
    /** iOS device name (`--device`), e.g. "iPhone 15 Pro" (with `provider: ios`). */
    device: z.string().optional(),
    /**
     * Attribute used by `by: testid` and Playwright `getByTestId`.
     * Default `data-testid`. Set to `data-qa` (or similar) when the
     * product's stable hook is not the Playwright default.
     */
    testIdAttribute: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z_][\w:-]*$/,
        "browser.testIdAttribute must be a valid HTML attribute name",
      )
      .optional(),
  })
  .strict();
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const InvestigateConfigSchema = z
  .object({
    /** Default codebase directory for `cairn investigate --connect`. */
    codebaseDir: z.string().optional(),
    /** Default vecgrep search mode: semantic | keyword | hybrid. */
    mode: z.enum(["semantic", "keyword", "hybrid"]).optional(),
    /** Max code matches to return from fcheap connect. */
    limit: z.number().int().positive().optional(),
    /** Build or refresh the vecgrep index before connecting. */
    index: z.boolean().default(false),
    /** Auto-investigate failed runs after they complete (best-effort). */
    autoInvestigate: z.enum(["on-failure", "never"]).default("never"),
  })
  .strict();
export type InvestigateConfig = z.infer<typeof InvestigateConfigSchema>;

/** Stable identity selectors for a non-browser process managed alongside a run. */
export const MonitorTargetConfigSchema = z
  .object({
    runtime: z.enum(["node", "bun", "deno", "go", "python"]),
    /** Exact codebase root detected from the live process cwd/entrypoint. */
    codebaseRoot: z.string().min(1),
    /** Optional suffix that disambiguates wrappers such as yarn from the app. */
    mainScriptSuffix: z.string().min(1).optional(),
  })
  .strict();
export type MonitorTargetConfig = z.infer<typeof MonitorTargetConfigSchema>;

export const DiagnosticsConfigSchema = z
  .object({
    monitor: z
      .object({
        /** Monitor CLI used for explicit diagnostics (defaults to PATH/env). */
        binary: z.string().min(1).optional(),
        targets: z
          .record(
            z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
            MonitorTargetConfigSchema,
          )
          .default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;

export const AnnotateConfigSchema = z
  .object({
    /** Enable codemap annotate integration (default: false). */
    enabled: z.boolean().default(false),
    /** Auto-annotate mode: on-run annotates every run (pass+fail) with run
     * context; on-investigate annotates code matches from investigate results;
     * never disables auto-annotation. */
    autoAnnotate: z
      .enum(["on-run", "on-investigate", "never"])
      .default("never"),
    /** Default source label for annotations (default: cairntrace). */
    source: z.string().optional(),
  })
  .strict();
export type AnnotateConfig = z.infer<typeof AnnotateConfigSchema>;

/**
 * `authoring.template.requires` — the same shape as a spec's `requires:`
 * (`env` entries: a name, or `{ <env>: { optIn: VAR } }`; `mutates`).
 * Declared here because spec.v1 imports this module; exports validate the
 * written spec with the spec schema.
 */
const AuthoringRequiresSchema = z
  .object({
    env: z
      .array(
        z.union([
          z.string().min(1),
          z.record(
            z.string().min(1),
            z.object({ optIn: z.string().min(1) }).strict(),
          ),
        ]),
      )
      .min(1)
      .optional(),
    mutates: z.boolean().optional(),
  })
  .strict();

/**
 * Discovery session settings (`discovery:`), read by `cairn discover`,
 * `cairn_discover_open` and `cairn_discover_resume`. Declared here (not in
 * discovery.v1) because spec.v1 imports this module and discovery.v1 imports
 * spec.v1.
 *
 * - `sessionTtlMs`: idle time before a session's browser closes (default
 *   30 min); the journal under `_sessions/` stays.
 * - `backend`: browser backend for discovery sessions (default
 *   agent-browser).
 */
export const DiscoveryConfigSchema = z
  .object({
    sessionTtlMs: z.number().int().positive().optional(),
    backend: z.enum(["agent-browser", "playwright"]).optional(),
  })
  .strict();
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/** Default drafts directory, relative to the config directory. */
export const DEFAULT_DRAFTS_DIR = "flows/_drafts";

/**
 * Spec authoring conventions (`authoring:`), read by `cairn discover export`
 * / `cairn_discover_export` and `cairn spec promote`:
 *
 * - `draftsDir`: where convention exports land (default `flows/_drafts`,
 *   relative to the config directory). Its folder name must start with `_`:
 *   folders and files starting with `_` are what `cairn run <dir>` skips,
 *   so that is what keeps drafts out of a suite.
 * - `template`: what every exported spec starts with — `requires`,
 *   `metadata.tags`, and `imports` (action files exports look in first and
 *   import when a step uses one of their actions).
 */
export const AuthoringConfigSchema = z
  .object({
    draftsDir: z
      .string()
      .min(1)
      .refine(
        (dir) =>
          (
            dir
              .replace(/[\\/]+$/, "")
              .split(/[\\/]/)
              .pop() ?? ""
          ).startsWith("_"),
        {
          message:
            "must name a folder starting with _ (e.g. flows/_drafts): `cairn run <dir>` skips only _ folders and files, so any other name would let drafts run with the suite",
        },
      )
      .optional(),
    template: z
      .object({
        requires: AuthoringRequiresSchema.optional(),
        metadata: z
          .object({ tags: z.array(z.string().min(1)).optional() })
          .strict()
          .optional(),
        imports: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AuthoringConfig = z.infer<typeof AuthoringConfigSchema>;

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
    /** CLI logging (level/format/color); flags + env override this. */
    logging: LoggingConfigSchema.optional(),
    /** Human-readable report artifact styling. */
    report: ReportConfigSchema.optional(),
    /** Browser-backend tuning (verify-after-click settle). */
    browser: BrowserConfigSchema.optional(),
    /** Optional server lifecycle for `cairn run` (build/boot/ready/teardown). */
    webServer: WebServerConfigSchema.optional(),
    /**
     * Named readiness gates (tcp / http / command, `all` / `any`, `stable`,
     * `every`, `timeout`) referenced from `services.docker.ready`, tmux
     * `readyOn.gate` / `after`, `webServer.ready`, a spec's
     * `preconditions.wait` and `cairn wait`.
     */
    gates: GatesRegistrySchema.optional(),
    /** Multi-service environment lifecycle (docker/seed/tmux). */
    services: ServicesConfigSchema.optional(),
    /** fcheap stash integration (save/list/search run artifacts). */
    stash: StashConfigSchema.optional(),
    /** Video clip integration with vidtrace. */
    clips: ClipConfigSchema.optional(),
    /** Code investigation via fcheap connect (vecgrep) + vidtrace. */
    investigate: InvestigateConfigSchema.optional(),
    /** Process targets available to explicit `monitor:` spec steps. */
    diagnostics: DiagnosticsConfigSchema.optional(),
    /** codemap annotation integration (pin run findings to code symbols). */
    annotate: AnnotateConfigSchema.optional(),
    /** Spec authoring conventions: drafts dir + export template. */
    authoring: AuthoringConfigSchema.optional(),
    /** Discovery session settings: idle TTL + backend. */
    discovery: DiscoveryConfigSchema.optional(),
    /**
     * Named connections for the mongo / temporal / http verifiers (and
     * fixtures): `kind: mongo` (uri or docker compose service), `kind:
     * temporal` (UI/HTTP API + namespace), `kind: http` (baseUrl). Secrets
     * via `${secrets.X}`; credentials never reach artifacts.
     */
    datasources: DatasourcesConfigSchema.optional(),
    /**
     * Named test data specs reference with `fixtures: [name | name.reset |
     * {use, with, write}]`: `kind: exec | mongo | http` with ensure / reset
     * / verify / teardown verbs, `scope: run | suite | seed`, `needs`,
     * `outputs` (`${fixtures.<name>.<key>}`), `owner` and `ttl`. See
     * `cairn docs fixtures`.
     */
    fixtures: FixturesRegistrySchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    // F2: a gate name in services / webServer must exist in `gates:` —
    // reported here, not after `docker compose up` or a server boot.
    const known = config.gates ?? {};
    for (const { path, refs } of configGateRefs(config)) {
      for (const name of gateRefNames(refs)) {
        if (Object.hasOwn(known, name)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `unknown gate "${name}" (${
            Object.keys(known).length > 0
              ? `defined: ${Object.keys(known).toSorted().join(", ")}`
              : "the config defines no gates:"
          })`,
        });
      }
    }
  });
export type Config = z.infer<typeof ConfigSchema>;

/** Every gate reference field of a config, with its path. */
function configGateRefs(config: {
  webServer?: WebServerConfig | undefined;
  services?: ServicesConfig | undefined;
  environments: Record<string, EnvironmentConfig>;
}): Array<{ path: Array<string | number>; refs: GateRefList | undefined }> {
  const out: Array<{
    path: Array<string | number>;
    refs: GateRefList | undefined;
  }> = [];
  const services = (
    prefix: Array<string | number>,
    block: {
      docker?: DockerConfig | undefined;
      tmux?: TmuxConfig | false | undefined;
    },
  ): void => {
    if (block.docker?.ready !== undefined) {
      out.push({
        path: [...prefix, "docker", "ready"],
        refs: block.docker.ready,
      });
    }
    if (!block.tmux) return;
    block.tmux.windows.forEach((win, index) => {
      const at = [...prefix, "tmux", "windows", index];
      if (win.readyOn?.gate !== undefined) {
        out.push({ path: [...at, "readyOn", "gate"], refs: win.readyOn.gate });
      }
      if (win.after !== undefined) {
        out.push({ path: [...at, "after"], refs: win.after });
      }
    });
  };
  if (config.webServer?.ready !== undefined) {
    out.push({ path: ["webServer", "ready"], refs: config.webServer.ready });
  }
  if (config.services) services(["services"], config.services);
  for (const [name, environment] of Object.entries(config.environments)) {
    if (environment.services) {
      services(["environments", name, "services"], environment.services);
    }
  }
  return out;
}

/**
 * Datasource entries that only break after an environment's override is
 * merged over the top-level entry (the schema validates each half alone;
 * runs report a broken merge lazily, on the verifier that uses it). For
 * `cairn config validate`: `environments.<env>.datasources.<name>: <why>`.
 */
export function environmentDatasourceProblems(config: Config): string[] {
  const problems: string[] = [];
  for (const [envName, environment] of Object.entries(config.environments)) {
    if (!environment.datasources) continue;
    const set = resolveEnvironmentDatasources(
      config.datasources,
      environment.datasources,
    );
    for (const [name, why] of Object.entries(set.errors)) {
      problems.push(`environments.${envName}.datasources.${name}: ${why}`);
    }
  }
  return problems;
}
