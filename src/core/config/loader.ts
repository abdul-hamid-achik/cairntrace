import { access } from "node:fs/promises";
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "../schema/config.v1";

export interface LoadedConfig {
  config: Config;
  path: string;
}

/**
 * Find a `cairntrace.config.yml` (or `.yaml`) by walking up from `startDir`
 * to filesystem root. Returns the first match or undefined.
 */
export async function findConfigFile(
  startDir: string,
): Promise<string | undefined> {
  const root = parsePath(startDir).root;
  let dir = startDir;
  while (true) {
    for (const name of ["cairntrace.config.yml", "cairntrace.config.yaml"]) {
      const candidate = resolve(dir, name);
      if (await exists(candidate)) return candidate;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load + validate config. Discovery starts from `specPath`'s directory unless
 * `explicitPath` is provided. Returns `undefined` if no config exists — that's
 * a supported state.
 *
 * `${env.X}` placeholders in the config TEXT are substituted from
 * process.env before parsing, so dynamic-port runners can write
 * `baseUrl: http://localhost:${env.APP_PORT}` instead of materializing a
 * per-run YAML. Missing env vars substitute as "" (same as spec parsing).
 */
export async function loadConfig(
  specPath: string,
  explicitPath?: string,
): Promise<LoadedConfig | undefined> {
  let configPath: string | undefined;
  if (explicitPath) {
    configPath = isAbsolute(explicitPath)
      ? explicitPath
      : resolve(process.cwd(), explicitPath);
    if (!(await exists(configPath))) {
      throw new Error(`config file not found: ${configPath}`);
    }
  } else {
    const startDir = isAbsolute(specPath)
      ? dirname(specPath)
      : dirname(resolve(process.cwd(), specPath));
    configPath = await findConfigFile(startDir);
  }

  if (!configPath) return undefined;

  const text = await readFile(configPath, "utf8");
  const raw = parseYaml(substituteEnv(text));
  const config = ConfigSchema.parse(raw);
  return { config, path: configPath };
}

function substituteEnv(text: string): string {
  return text.replace(
    /\$\{env\.(\w+)(?::-([^}]+))?\}/g,
    (_match, name: string, fallback?: string) =>
      process.env[name] ?? fallback ?? "",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
