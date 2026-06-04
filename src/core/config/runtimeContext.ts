import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, type LoadedConfig } from "./loader";
import type {
  Config,
  ConfigVarValue,
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
  const specEnvironment = await peekSpecEnvironment(absSpecPath);
  const envName =
    opts.envOverride ??
    specEnvironment ??
    loaded?.config.defaultEnvironment ??
    "local";
  const envConfig = loaded?.config.environments[envName];
  const vars = { ...envConfig?.vars, ...opts.vars };

  return {
    specPath: absSpecPath,
    envName,
    vars,
    ...(envConfig?.baseUrl ? { baseUrl: envConfig.baseUrl } : {}),
    ...(envConfig?.viewport ? { viewport: envConfig.viewport } : {}),
    ...(loaded ? loadedConfigFields(loaded) : {}),
  };
}

async function peekSpecEnvironment(
  specPath: string,
): Promise<string | undefined> {
  const text = await readFile(specPath, "utf8");
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object") return undefined;
  const environment = (raw as { environment?: unknown }).environment;
  return typeof environment === "string" && environment.length > 0
    ? environment
    : undefined;
}

function loadedConfigFields(
  loaded: LoadedConfig,
): Pick<SpecRuntimeContext, "config" | "configPath"> {
  return { config: loaded.config, configPath: loaded.path };
}
