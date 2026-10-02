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
 * `${config.dir}` resolves to the directory holding the config file, and YAML
 * merge keys (`<<: *anchor`) are enabled — see {@link parseConfigText}.
 */
export async function loadConfig(
  specPath: string,
  explicitPath?: string,
  opts?: {
    /** Called for `${env.X}` with no value and no `:-default`; its return is
     * substituted instead of "" (exporters use this to keep refs late-bound). */
    envRef?: (name: string) => string;
    /** Environment used for config interpolation. Defaults to process.env. */
    env?: Record<string, string | undefined>;
  },
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
  const raw = parseConfigText(text, {
    configPath,
    ...(opts?.envRef ? { envRef: opts.envRef } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
  });
  const config = ConfigSchema.parse(raw);
  return { config, path: configPath };
}

const CONFIG_DIR_TOKEN = "${config.dir}";

/**
 * Turn raw `cairntrace.config.yml` TEXT into the plain object the schema
 * validates. Every config reader (loadConfig, `cairn config validate`) should
 * go through this so they agree on what a config means:
 *   1. `${env.X}` / `${env.X:-default}` → the invocation environment
 *      (text substitution, as before);
 *   2. YAML parse with merge keys enabled, so `<<: *anchor` can share a
 *      `vars:` map between environments;
 *   3. `${config.dir}` → the directory that holds the config file, inserted
 *      into the PARSED strings. A directory name with YAML-significant
 *      characters (` #`, `: `, quotes, backslashes) can therefore never
 *      truncate or break the config, quoted or not, block or flow style.
 */
export function parseConfigText(
  text: string,
  opts: {
    /** Absolute path of the config file the text came from. */
    configPath: string;
    envRef?: (name: string) => string;
    env?: Record<string, string | undefined>;
  },
): unknown {
  if (!text.includes(CONFIG_DIR_TOKEN)) {
    return parseYaml(substituteEnv(text, opts.envRef, opts.env), {
      merge: true,
    });
  }
  // Swap the placeholder for a YAML-inert token (letters/underscores only, so
  // it is a valid plain scalar anywhere), parse, then put the real directory
  // into the resulting strings. The swap runs before env substitution so an
  // env VALUE that happens to contain `${config.dir}` stays literal.
  const sentinel = uniqueSentinel(text);
  const configDir = dirname(opts.configPath);
  const parsed: unknown = parseYaml(
    substituteEnv(
      text.replaceAll(CONFIG_DIR_TOKEN, () => sentinel),
      opts.envRef,
      opts.env,
    ),
    { merge: true },
  );
  return replaceInStrings(parsed, sentinel, configDir);
}

function uniqueSentinel(text: string): string {
  let sentinel = "__CAIRNTRACE_CONFIG_DIR__";
  while (text.includes(sentinel)) sentinel = `_${sentinel}_`;
  return sentinel;
}

/** Deep-copy `value`, replacing `token` in every string (keys included). */
function replaceInStrings(
  value: unknown,
  token: string,
  replacement: string,
): unknown {
  if (typeof value === "string") {
    return value.includes(token)
      ? value.replaceAll(token, () => replacement)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceInStrings(item, token, replacement));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key.replaceAll(token, () => replacement)] = replaceInStrings(
        item,
        token,
        replacement,
      );
    }
    return out;
  }
  return value;
}

/**
 * `${env.X}` / `${env.X:-default}` in config text (also used for a spec's own
 * `vars:` values, so they resolve like config vars).
 */
export function substituteEnv(
  text: string,
  envRef?: (name: string) => string,
  env: Record<string, string | undefined> = process.env,
): string {
  return text.replace(
    /\$\{env\.(\w+)(?::-([^}]+))?\}/g,
    (_match, name: string, fallback?: string) => {
      const value = env[name];
      // `:-` shell semantics: an empty OR unset env var falls back to the
      // default. Matches the spec-parser placeholder behavior so config and
      // specs resolve `${env.X:-default}` identically.
      if (value === undefined || value === "") {
        if (fallback !== undefined) return fallback;
        return envRef ? envRef(name) : "";
      }
      return value;
    },
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
