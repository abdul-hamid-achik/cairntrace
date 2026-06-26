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

/**
 * Readiness signal for a tmux service window. At least one of `url` or `text`
 * should be set; `url` is an HTTP probe, `text` is a substring scanned from the
 * tmux pane's captured output. If neither is set, the window is considered
 * ready immediately (fire-and-forget services).
 */
export const TmuxReadyOnSchema = z
  .object({
    /** HTTP URL to probe (any response = ready). */
    url: z.string().url().optional(),
    /** Substring to scan for in the tmux pane's output. */
    text: z.string().min(1).optional(),
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

/** A single tmux window running one service. */
export const TmuxWindowSchema = z
  .object({
    /** Window name (becomes the tmux window title; must be unique within the session). */
    name: z.string().min(1),
    /** Working directory (relative to configDir or absolute). */
    cwd: z.string().optional(),
    /** Command to send to the window's shell (sent via `tmux send-keys ... Enter`). */
    command: z.string().min(1),
    /** How cairn knows this window's service is ready. */
    readyOn: TmuxReadyOnSchema.optional(),
    /** Extra env vars for this window's command (merged over process.env + session env). */
    env: z.record(z.string()).optional(),
    /**
     * Optional pre-commands to run before the main `command` in the same pane
     * (e.g. `yarn build` before `yarn start`). Each is sent via `tmux send-keys ... Enter`
     * and cairn waits for it to finish before sending the next. A pre-command that
     * blocks will prevent the main command from running — use only for commands
     * that exit (build, migrate, etc).
     */
    preCommands: z.array(z.string().min(1)).optional(),
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
    /** Max ms to wait for the command to finish. Default 120000. */
    readyTimeoutMs: z.number().int().positive().optional(),
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
    /** Max ms to wait for the seed command. Default 300000 (5 min). */
    timeoutMs: z.number().int().positive().optional(),
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
    /** Max ms to wait for all windows to become ready. Default 90000. */
    readyTimeoutMs: z.number().int().positive().optional(),
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
  );
export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

/**
 * Controls how services session artifacts are stashed to the fcheap vault
 * after a run completes. When enabled, cairn captures tmux pane output, docker
 * logs, and seed output into a directory and stashes it to fcheap. The stash
 * is best-effort — if fcheap isn't installed, a warning is logged and the run
 * continues normally.
 */
export const ServicesStashConfigSchema = z
  .object({
    /** Enable stashing services artifacts to fcheap (default: false). */
    enabled: z.boolean().default(false),
    /**
     * When to stash: always (after every run) | on-failure (only when the
     * run has at least one failed outcome) | never (default).
     */
    autoStash: z.enum(["always", "on-failure", "never"]).default("never"),
    /** Tags applied to every services stash (e.g. [graphite, services]). */
    tags: z.array(z.string()).optional(),
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
        if (win.readyOn && !win.readyOn.url && !win.readyOn.text) {
          return false;
        }
      }
      return true;
    },
    {
      message:
        "tmux window readyOn must specify at least one of `url` or `text`",
    },
  );
export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

export const StashConfigSchema = z
  .object({
    /** Enable fcheap stash integration (default: false). */
    enabled: z.boolean().default(false),
    /** Auto-stash failed runs: on-failure | never (default: never). */
    autoStash: z.enum(["on-failure", "never"]).default("never"),
    /** Tags applied to every auto-stashed run. */
    tags: z.array(z.string()).optional(),
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

export const InvestigateConfigSchema = z
  .object({
    /** Default codebase directory for `cairn investigate --connect`. */
    codebaseDir: z.string().optional(),
    /** Default vecgrep search mode: semantic | keyword | hybrid. */
    mode: z.enum(["semantic", "keyword", "hybrid"]).optional(),
    /** Max code matches to return from fcheap connect. */
    limit: z.number().int().positive().optional(),
    /** Auto-investigate failed runs after they complete (best-effort). */
    autoInvestigate: z.enum(["on-failure", "never"]).default("never"),
  })
  .strict();
export type InvestigateConfig = z.infer<typeof InvestigateConfigSchema>;

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
    /** Multi-service environment lifecycle (docker/seed/tmux). */
    services: ServicesConfigSchema.optional(),
    /** fcheap stash integration (save/list/search run artifacts). */
    stash: StashConfigSchema.optional(),
    /** Video clip integration with vidtrace. */
    clips: ClipConfigSchema.optional(),
    /** Code investigation via fcheap connect (vecgrep) + vidtrace. */
    investigate: InvestigateConfigSchema.optional(),
    /** codemap annotation integration (pin run findings to code symbols). */
    annotate: AnnotateConfigSchema.optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
