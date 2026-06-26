import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, type LoadedConfig } from "./loader";
import type {
  Config,
  ConfigVarValue,
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
}

export interface SpecRuntimeContext {
  specPath: string;
  envName: string;
  baseUrl?: string;
  vars: Record<string, ConfigVarValue>;
  /** Environment-level viewport from config (spec-level `viewport:` wins). */
  viewport?: ViewportConfig;
  config?: Config;
  configPath?: string;
  /** Effective services config after merging top-level + per-env override.
   * undefined when no services are configured or the env disables them. */
  services?: ServicesConfig;
  /** Effective secrets config after applying per-env override. */
  secrets?: SecretsConfig;
}

/**
 * Resolve config/env/runtime variables before the spec is fully parsed.
 *
 * This intentionally performs only a raw YAML peek to read `environment`;
 * it does not call parseSpec(), because parseSpec() may need the vars we are
 * resolving here to satisfy schema-required fields like `open`.
 */
export async function resolveSpecRuntimeContext(
  specPath: string,
  opts: RuntimeContextOptions = {},
): Promise<SpecRuntimeContext> {
  const absSpecPath = isAbsolute(specPath)
    ? specPath
    : resolve(opts.cwd ?? process.cwd(), specPath);
  const loaded = await loadConfig(absSpecPath, opts.configPath);
  const specSettings = await peekSpecSettings(absSpecPath);
  const envName =
    opts.envOverride ??
    specSettings.environment ??
    loaded?.config.defaultEnvironment ??
    "local";
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

  return {
    specPath: absSpecPath,
    envName,
    vars,
    ...(envConfig?.baseUrl ? { baseUrl: envConfig.baseUrl } : {}),
    ...(envConfig?.viewport ? { viewport: envConfig.viewport } : {}),
    ...(loaded ? loadedConfigFields(loaded) : {}),
    ...(services ? { services } : {}),
    ...(secrets ? { secrets } : {}),
  };
}

/**
 * Deep-merge two ServicesConfig objects. The env-level override takes
 * precedence: any defined field in `override` replaces the corresponding
 * field from `base`. Nested objects (docker, seed, tmux, stash) are merged
 * field-by-field; teardown arrays are replaced (not concatenated).
 */
function mergeServicesConfig(
  base: ServicesConfig,
  override: Partial<ServicesConfig>,
): ServicesConfig {
  return {
    ...base,
    ...(override.docker !== undefined
      ? { docker: { ...base.docker, ...override.docker } }
      : {}),
    ...(override.seed !== undefined
      ? { seed: { ...base.seed, ...override.seed } }
      : {}),
    ...(override.tmux !== undefined
      ? { tmux: { ...base.tmux, ...override.tmux } }
      : {}),
    ...(override.teardown !== undefined ? { teardown: override.teardown } : {}),
    ...(override.stash !== undefined
      ? { stash: { ...base.stash, ...override.stash } }
      : {}),
  };
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
  envServices: false | Partial<ServicesConfig> | undefined,
): ServicesConfig | undefined {
  if (!topLevel) return undefined;
  if (envServices === false) return undefined;
  if (envServices === undefined) return topLevel;
  return mergeServicesConfig(topLevel, envServices as Partial<ServicesConfig>);
}

async function peekSpecSettings(specPath: string): Promise<{
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
    ...(isVarsRecord(vars) ? { vars } : {}),
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
