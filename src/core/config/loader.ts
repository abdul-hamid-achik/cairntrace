import { access } from "node:fs/promises";
import { dirname, isAbsolute, parse as parsePath, resolve } from "node:path";
import type { Config } from "../schema/config.v1";
import { assertEngineRequirement } from "../engineRequirements";
import type { EnvLateBinding } from "./text";
import {
  ConfigCompositionError,
  composeConfigFile,
  type ConfigComposition,
} from "./compose";

export { parseConfigText, substituteEnv } from "./text";

export interface LoadedConfig {
  config: Config;
  path: string;
  /**
   * F7: how the config was composed — included files, top-level vars,
   * `extends` chains and where every var is defined. Absent only for
   * configs built in memory.
   */
  composition?: ConfigComposition;
  /**
   * Exporter late binding only: typed fields whose late-bound value only a
   * validation stand-in could fill (see `EnvLateBinding.standIns`).
   */
  lateUnbound?: string[];
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
 *
 * F7: `include:`, top-level `vars:`, `environments.<n>.extends` and
 * `${vars.X}` inside var values are composed here (see `compose.ts`), so
 * every reader sees each environment's effective vars. A schema violation
 * throws the ZodError (as before); a composition problem (missing include,
 * include or extends cycle, undefined var reference) throws a
 * {@link ConfigCompositionError}. F19: a config whose `requires.cairntrace`
 * range this cairn does not satisfy throws an `EngineRequirementError`
 * (exit 4).
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
    /** Do not enforce `requires.cairntrace` (doctor and validate report it). */
    skipRequires?: boolean;
    /** Exporter late binding: no env VALUE is substituted (see EnvLateBinding). */
    late?: EnvLateBinding;
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

  const result = await composeConfigFile({
    configPath,
    ...(opts?.envRef ? { envRef: opts.envRef } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.late ? { late: opts.late } : {}),
  });
  if (!result.ok) {
    if (
      (result.stage === "yaml" || result.stage === "schema") &&
      result.cause !== undefined
    ) {
      throw result.cause;
    }
    throw new ConfigCompositionError(configPath, result.errors);
  }
  // F19: a config that needs a newer cairn is refused here, so every reader
  // (run, verify, MCP, catalog, …) fails the same way (exit 4).
  if (!opts?.skipRequires) {
    assertEngineRequirement(result.config, configPath);
  }
  return {
    config: result.config,
    path: configPath,
    composition: result.composition,
    ...(result.lateUnbound ? { lateUnbound: result.lateUnbound } : {}),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
