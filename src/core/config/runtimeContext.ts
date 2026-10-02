import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, substituteEnv, type LoadedConfig } from "./loader";
import type {
  BrowserConfig,
  Config,
  ConfigVarValue,
  EnvironmentServicesConfig,
  SecretsConfig,
  ServicesConfig,
  ViewportConfig,
} from "../schema/config.v1";

export interface RuntimeContextOptions {
  /** Override the spec/config default environment. */
  envOverride?: string;
  /** Explicit cairntrace.config.yml path. */
  configPath?: string;
  /** Runtime vars passed by the caller; these override config env vars. */
  vars?: Record<string, ConfigVarValue>;
  /** Defaults to process.cwd(). Used to resolve a relative spec path. */
  cwd?: string;
  /** Forwarded to loadConfig: substitute for `${env.X}` unset with no default. */
  envRef?: (name: string) => string;
  /** Scoped environment used for config interpolation. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Receives each non-fatal resolution warning as it is produced (they are
   * also returned on `warnings`). The core stays logger-free; CLI callers
   * route this to their logger.
   */
  onWarning?: (message: string) => void;
}

/**
 * How the active environment name was chosen. `override` (CLI `--env`, MCP
 * `env`) is an explicit request and must name a configured environment.
 * `spec` (the spec's `environment:`), `config-default` and `fallback` are
 * defaults: an undefined one runs as before, with a warning.
 */
export type EnvironmentSource =
  | "override"
  | "spec"
  | "config-default"
  | "fallback";

/** The spec-independent part of a run: config + selected environment. */
export interface ProjectRuntimeContext {
  envName: string;
  envSource: EnvironmentSource;
  baseUrl?: string;
  vars: Record<string, ConfigVarValue>;
  /** Environment-level viewport from config (spec-level `viewport:` wins). */
  viewport?: ViewportConfig;
  /** Environment-level multiplier for waits/settles. */
  waitScale?: number;
  config?: Config;
  configPath?: string;
  /**
   * Directory of the resolved cairntrace.config.yml, or the cwd when there is
   * no config. This is what `${config.dir}` resolves to.
   */
  configDir: string;
  /** Config `browser:` block (backend tuning, `testIdAttribute`), if any. */
  browser?: BrowserConfig;
  /** Effective services config after merging top-level + per-env override.
   * undefined when no services are configured or the env disables them. */
  services?: ServicesConfig;
  /** Effective secrets config after applying per-env override. */
  secrets?: SecretsConfig;
  /** Non-fatal resolution warnings (e.g. the implicit environment is not defined). */
  warnings: string[];
}

export interface SpecRuntimeContext extends ProjectRuntimeContext {
  specPath: string;
}

/**
 * An explicitly requested environment (CLI `--env`, MCP `env`) is not
 * defined in the resolved config. Running anyway would silently drop that
 * environment's baseUrl and vars, so this is a config error (exit 4), not a
 * run failure. A spec's own `environment:` is a default, not a request: it
 * only warns, so one spec's stale default cannot abort a whole batch.
 */
export class UnknownEnvironmentError extends Error {
  readonly exitCode = 4 as const;
  constructor(
    public readonly envName: string,
    /** Kept for compatibility; only `override` is thrown today. */
    public readonly source: "override" | "spec",
    public readonly knownEnvironments: string[],
    public readonly configPath: string,
  ) {
    const from =
      source === "override"
        ? "requested via --env / the env input"
        : "requested by the spec's `environment:`";
    const known =
      knownEnvironments.length > 0 ? knownEnvironments.join(", ") : "(none)";
    super(
      `unknown environment "${envName}" (${from}); ${configPath} defines: ${known}. ` +
        `Use one of those or add environments.${envName} to the config.`,
    );
    this.name = "UnknownEnvironmentError";
  }
}

/**
 * Resolve config/env/runtime variables before the spec is fully parsed.
 *
 * This intentionally performs only a raw YAML peek to read `environment`;
 * it does not call parseSpec(), because parseSpec() may need the vars we are
 * resolving here to satisfy schema-required fields like `open`.
 *
 * Throws {@link UnknownEnvironmentError} when a config exists and the
 * `envOverride` names an environment it does not define.
 */
export async function resolveSpecRuntimeContext(
  specPath: string,
  opts: RuntimeContextOptions = {},
): Promise<SpecRuntimeContext> {
  const absSpecPath = isAbsolute(specPath)
    ? specPath
    : resolve(opts.cwd ?? process.cwd(), specPath);
  const loaded = await loadConfig(absSpecPath, opts.configPath, {
    ...(opts.envRef ? { envRef: opts.envRef } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const specSettings = await peekSpecSettings(absSpecPath, opts);
  return {
    specPath: absSpecPath,
    ...buildRuntime(loaded, opts, specSettings),
  };
}

/**
 * Resolve config + environment for commands that have no spec file
 * (`cairn discover`, `cairn snapshot`, MCP discovery). Config discovery walks
 * up from `cwd` (default process.cwd()) unless `configPath` is given. Same
 * environment rules as {@link resolveSpecRuntimeContext}.
 */
export async function resolveProjectRuntimeContext(
  opts: RuntimeContextOptions = {},
): Promise<ProjectRuntimeContext> {
  const cwd = opts.cwd ?? process.cwd();
  // loadConfig discovers from the directory of the path it is given; a
  // placeholder file name inside cwd makes it start the walk at cwd itself.
  const loaded = await loadConfig(
    resolve(cwd, "__cairntrace_project__.yml"),
    opts.configPath,
    {
      ...(opts.envRef ? { envRef: opts.envRef } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    },
  );
  return buildRuntime(loaded, opts, {});
}

function buildRuntime(
  loaded: LoadedConfig | undefined,
  opts: RuntimeContextOptions,
  specSettings: { environment?: string; vars?: Record<string, ConfigVarValue> },
): ProjectRuntimeContext {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.onWarning?.(message);
  };
  const { envName, envSource } = selectEnvironment(
    loaded,
    opts.envOverride,
    specSettings.environment,
  );
  checkEnvironment(loaded, envName, envSource, warn);
  const envConfig = loaded?.config.environments[envName];
  const vars = { ...envConfig?.vars, ...specSettings.vars, ...opts.vars };

  // Resolve effective services: env-level `services: false` disables all;
  // env-level partial services deep-merge over top-level; otherwise top-level.
  const services = resolveEffectiveServices(
    loaded?.config.services,
    envConfig?.services,
  );

  // Resolve effective secrets: env-level secrets replaces top-level entirely.
  const secrets = envConfig?.secrets ?? loaded?.config?.secrets;
  const browser = loaded?.config.browser;

  return {
    envName,
    envSource,
    vars,
    configDir: loaded ? dirname(loaded.path) : (opts.cwd ?? process.cwd()),
    warnings,
    ...(envConfig?.baseUrl ? { baseUrl: envConfig.baseUrl } : {}),
    ...(envConfig?.viewport ? { viewport: envConfig.viewport } : {}),
    ...(envConfig?.waitScale !== undefined
      ? { waitScale: envConfig.waitScale }
      : {}),
    ...(loaded ? loadedConfigFields(loaded) : {}),
    ...(browser ? { browser } : {}),
    ...(services ? { services } : {}),
    ...(secrets ? { secrets } : {}),
  };
}

function selectEnvironment(
  loaded: LoadedConfig | undefined,
  override: string | undefined,
  specEnvironment: string | undefined,
): { envName: string; envSource: EnvironmentSource } {
  if (override !== undefined && override.length > 0) {
    return { envName: override, envSource: "override" };
  }
  if (specEnvironment !== undefined) {
    return { envName: specEnvironment, envSource: "spec" };
  }
  const configDefault = loaded?.config.defaultEnvironment;
  if (configDefault !== undefined && configDefault.length > 0) {
    return { envName: configDefault, envSource: "config-default" };
  }
  return { envName: "local", envSource: "fallback" };
}

/**
 * An explicit `--env` / MCP `env` must exist in the config. Defaults (the
 * spec's `environment:`, `defaultEnvironment`, the `local` fallback) keep
 * the historical lenient behavior — run without that environment's baseUrl /
 * vars — but say so. Without a config there is nothing to check:
 * absolute-URL specs run config-free by design.
 */
function checkEnvironment(
  loaded: LoadedConfig | undefined,
  envName: string,
  envSource: EnvironmentSource,
  warn: (message: string) => void,
): void {
  if (!loaded) return;
  const environments = loaded.config.environments;
  if (Object.hasOwn(environments, envName)) return;
  const known = Object.keys(environments).toSorted();
  // "local" is the scaffolded default and the implicit fallback; against a
  // config that defines no environments at all it means "no environment",
  // not a typo — whether a spec says `environment: local` or a wrapper
  // passes `--env local` to every project.
  if (known.length === 0 && envName === "local") return;
  if (envSource === "override") {
    throw new UnknownEnvironmentError(envName, envSource, known, loaded.path);
  }
  if (envSource === "spec") {
    warn(
      `the spec's environment "${envName}" is not defined in ${loaded.path} ` +
        `(known: ${known.length > 0 ? known.join(", ") : "none"}); running ` +
        `without an environment baseUrl or vars — pass --env <name> or add ` +
        `environments.${envName}`,
    );
    return;
  }
  if (envSource === "config-default") {
    warn(
      `defaultEnvironment "${envName}" is not defined in ${loaded.path} ` +
        `(known: ${known.length > 0 ? known.join(", ") : "none"}); ` +
        `running without an environment baseUrl or vars`,
    );
    return;
  }
  // Implicit "local" fallback: only worth saying when the config does define
  // environments (a config without any is a deliberate no-environments setup).
  if (known.length > 0) {
    warn(
      `no environment selected and ${loaded.path} defines no "local" ` +
        `environment (known: ${known.join(", ")}); running without an ` +
        `environment baseUrl or vars — pass --env <name> or set defaultEnvironment`,
    );
  }
}

/**
 * Deep-merge two ServicesConfig objects. The env-level override takes
 * precedence: any defined field in `override` replaces the corresponding
 * field from `base`. Nested objects (docker, seed, tmux, stash) are merged
 * field-by-field; teardown arrays are replaced (not concatenated). An
 * environment may set `tmux: false` to remove inherited local windows while
 * keeping its docker and seed phases.
 */
function mergeServicesConfig(
  base: ServicesConfig,
  override: EnvironmentServicesConfig,
): ServicesConfig {
  const merged: ServicesConfig = {
    ...base,
    ...(override.docker !== undefined
      ? { docker: { ...base.docker, ...override.docker } }
      : {}),
    ...(override.seed !== undefined
      ? { seed: { ...base.seed, ...override.seed } }
      : {}),
    ...(override.tmux !== undefined && override.tmux !== false
      ? { tmux: { ...base.tmux, ...override.tmux } }
      : {}),
    ...(override.teardown !== undefined ? { teardown: override.teardown } : {}),
    ...(override.stash !== undefined
      ? { stash: { ...base.stash, ...override.stash } }
      : {}),
  };
  if (override.tmux === false) delete merged.tmux;
  return merged;
}

/**
 * Resolve the effective services config for a given environment.
 * - No top-level services → undefined (services not configured)
 * - Env says `services: false` → undefined (explicitly disabled for this env)
 * - Env has a partial services block → deep-merge over top-level
 * - Env has no services key → use top-level as-is
 */
function resolveEffectiveServices(
  topLevel: ServicesConfig | undefined,
  envServices: false | EnvironmentServicesConfig | undefined,
): ServicesConfig | undefined {
  if (!topLevel) return undefined;
  if (envServices === false) return undefined;
  if (envServices === undefined) return topLevel;
  return mergeServicesConfig(
    topLevel,
    envServices as EnvironmentServicesConfig,
  );
}

async function peekSpecSettings(
  specPath: string,
  opts: Pick<RuntimeContextOptions, "env" | "envRef"> = {},
): Promise<{
  environment?: string;
  vars?: Record<string, ConfigVarValue>;
}> {
  const text = await readFile(specPath, "utf8");
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object") return {};
  const environment = (raw as { environment?: unknown }).environment;
  const vars = (raw as { vars?: unknown }).vars;
  return {
    ...(typeof environment === "string" && environment.length > 0
      ? { environment }
      : {}),
    // A spec var's `${env.X:-default}` resolves like a config var's: before
    // it is spliced as ${vars.X} (one pass would leave the env placeholder
    // in the step as literal text).
    ...(isVarsRecord(vars)
      ? {
          vars: Object.fromEntries(
            Object.entries(vars).map(([key, value]) => [
              key,
              typeof value === "string" && value.includes("${env.")
                ? substituteEnv(value, opts.envRef, opts.env ?? process.env)
                : value,
            ]),
          ),
        }
      : {}),
  };
}

function isVarsRecord(value: unknown): value is Record<string, ConfigVarValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (v) =>
      typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
}

function loadedConfigFields(
  loaded: LoadedConfig,
): Pick<SpecRuntimeContext, "config" | "configPath"> {
  return { config: loaded.config, configPath: loaded.path };
}
