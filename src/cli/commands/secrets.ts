import { execa } from "execa";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import {
  targetChildEnv,
  targetChildEnvWithSelectedTvaultKeys,
} from "../../core/processEnv";
import type {
  ConfigVarValue,
  SecretsConfig,
  TvaultConfig,
} from "../../core/schema/config.v1";

/* ---------------------------------------------------------------------------
 * TinyVault secrets provider
 *
 * `tvault run --only KEY_A,KEY_B -- <command>` injects a selected key set
 * into a subprocess without exporting an entire project.
 *
 * Cairntrace uses tvault in two ways:
 * 1. `cairn run` with `secrets.provider: tvault` — resolves only selected keys
 * 2. `cairn secrets status` — check which keys are available
 * ------------------------------------------------------------------------- */

/** TinyVault's documented daemon unlock path (launchd / MCP / GUI hosts). */
export function conventionalTvaultPassphraseFile(): string {
  return join(homedir(), ".config", "secrets", "env");
}

/**
 * Env for spawning `tvault`. GUI-launched MCP hosts do not inherit a login
 * shell, so TVAULT_PASSPHRASE is usually missing. Point tvault at the
 * conventional 0600 passphrase file when the caller did not set one.
 */
export function tvaultProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (base.TVAULT_PASSPHRASE || base.TVAULT_PASSPHRASE_FILE) return { ...base };
  const path = conventionalTvaultPassphraseFile();
  try {
    if (statSync(path).isFile()) {
      return { ...base, TVAULT_PASSPHRASE_FILE: path };
    }
  } catch {
    // no conventional file
  }
  return { ...base };
}

export async function isTvaultAvailable(): Promise<boolean> {
  try {
    const r = await execa("tvault", ["--version"], {
      reject: false,
      env: tvaultProcessEnv(),
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Build the `--project` or `--group`/`--env` CLI args for tvault commands.
 * Returns the "target" string for logging/error messages.
 */
export function tvaultArgs(cfg: TvaultConfig): {
  args: string[];
  target: string;
} {
  if (cfg.project) {
    return { args: ["--project", cfg.project], target: cfg.project };
  }
  return {
    args: ["--group", cfg.group!, "--env", cfg.env!],
    target: `${cfg.group}/${cfg.env}`,
  };
}

export interface TvaultSecretsResult {
  ok: boolean;
  keys: string[];
  error?: string;
}

/**
 * Get the list of secret keys from a TinyVault project (metadata only —
 * values are never returned to the caller). Used for `cairn secrets status`
 * and for pre-flight checks.
 *
 * Group mode uses TinyVault's metadata-only `env inherited` command. It must
 * never fall back to `tvault env`: that command decrypts plaintext merely to
 * discover names.
 */
export async function getTvaultKeys(
  cfg: TvaultConfig,
  opts: { skipAvailabilityCheck?: boolean } = {},
): Promise<TvaultSecretsResult> {
  const available = opts.skipAvailabilityCheck || (await isTvaultAvailable());
  if (!available) {
    return {
      ok: false,
      keys: [],
      error:
        "tvault not on $PATH. Install: brew install abdul-hamid-achik/tap/tvault",
    };
  }

  try {
    if (cfg.project) {
      const r = await execa(
        "tvault",
        ["list", ...tvaultArgs(cfg).args, "--json", "--names-only"],
        {
          reject: false,
          timeout: 10_000,
          env: tvaultProcessEnv(),
        },
      );
      if (r.exitCode !== 0) {
        return { ok: false, keys: [], error: r.stderr || "tvault list failed" };
      }
      const data = JSON.parse(r.stdout);
      const keys = Array.isArray(data)
        ? data
            .map((k: string | { key?: string }) =>
              typeof k === "string" ? k : (k.key ?? ""),
            )
            .filter(Boolean)
        : (data?.secrets?.map((s: { key: string }) => s.key) ?? []);
      return { ok: true, keys };
    }

    const r = await execa(
      "tvault",
      ["env", "inherited", "--group", cfg.group!, "--env", cfg.env!, "--json"],
      { reject: false, timeout: 10_000, env: tvaultProcessEnv() },
    );
    if (r.exitCode !== 0) {
      return {
        ok: false,
        keys: [],
        error: r.stderr || "tvault env inherited failed",
      };
    }
    return { ok: true, keys: extractMetadataKeyNames(JSON.parse(r.stdout)) };
  } catch (e) {
    return { ok: false, keys: [], error: (e as Error).message };
  }
}

export interface TvaultEnvResult {
  ok: boolean;
  env: Record<string, string>;
  error?: string;
}

/**
 * Remove TinyVault control variables before spawning target processes. A
 * secret whose configured key itself starts with TVAULT_ is an explicit
 * exception; everything else is a client-control setting, not target input.
 */
export function childEnvWithoutTvaultControls(
  env: Record<string, string | undefined>,
  selectedKeys: Iterable<string> = [],
): Record<string, string | undefined> {
  return targetChildEnvWithSelectedTvaultKeys(env, selectedKeys);
}

/**
 * Resolve only an invocation's declared/referenced keys through TinyVault's
 * selected-key subprocess surface. This never asks `tvault env` to decrypt a
 * complete project. The helper emits only the selected key/value JSON, so the
 * parent process sees neither inherited ambient variables nor unrelated vault
 * values.
 */
export async function getTvaultSelectedEnv(
  cfg: TvaultConfig,
  keys: readonly string[],
): Promise<TvaultEnvResult> {
  if (keys.length === 0) return { ok: true, env: {} };
  const ok = await isTvaultAvailable();
  if (!ok) {
    return {
      ok: false,
      env: {},
      error:
        "tvault not on $PATH. Install: brew install abdul-hamid-achik/tap/tvault",
    };
  }

  const uniqueKeys = [...new Set(keys)].toSorted();
  const { args, target } = tvaultArgs(cfg);
  // `process.argv.at(-1)` works for both Bun and Node's `-e` mode. Keys are
  // serialized as data rather than interpolated into a shell command.
  const emitSelected =
    "const keys=JSON.parse(process.argv.at(-1));const out={};for(const key of keys){if(process.env[key]!==undefined)out[key]=process.env[key];}process.stdout.write(JSON.stringify(out));";
  try {
    const r = await execa(
      "tvault",
      [
        "run",
        ...args,
        ...(cfg.identity ? ["--identity", cfg.identity] : []),
        "--only",
        uniqueKeys.join(","),
        "--",
        process.execPath,
        "-e",
        emitSelected,
        JSON.stringify(uniqueKeys),
      ],
      { reject: false, timeout: 10_000, env: tvaultProcessEnv() },
    );
    if (r.exitCode !== 0) {
      return {
        ok: false,
        env: {},
        error: r.stderr || `tvault selected-key injection failed for ${target}`,
      };
    }
    const parsed: unknown = JSON.parse(r.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        env: {},
        error: "tvault returned invalid selected-key JSON",
      };
    }
    const env = Object.fromEntries(
      uniqueKeys.flatMap((key) => {
        const value = (parsed as Record<string, unknown>)[key];
        return typeof value === "string" ? [[key, value]] : [];
      }),
    );
    return { ok: true, env };
  } catch (e) {
    return { ok: false, env: {}, error: (e as Error).message };
  }
}

/**
 * A per-invocation secret environment. It is deliberately an ordinary object,
 * never a mutation of process.env, so concurrent MCP calls cannot inherit one
 * another's vault values.
 */
export interface ScopedSecrets {
  env: Record<string, string | undefined>;
  /** Environment authorized for target children (without vault controls). */
  childEnv: Record<string, string | undefined>;
  secretValues: string[];
  secrets?: SecretsConfig;
  target?: string;
  injectedKeys: string[];
  shadowedKeys: string[];
  /** Explicit TinyVault names authorized for target children. */
  selectedKeys?: string[];
}

export async function resolveScopedSecrets(
  specPath: string,
  opts: {
    environmentOverride?: string;
    configPath?: string;
    vars?: Record<string, ConfigVarValue>;
    baseEnv?: Record<string, string | undefined>;
  } = {},
): Promise<ScopedSecrets> {
  const env: Record<string, string | undefined> = targetChildEnv(
    opts.baseEnv ?? process.env,
  );
  if (
    opts.environmentOverride !== undefined &&
    env.CAIRN_TVAULT_ENV === undefined
  ) {
    env.CAIRN_TVAULT_ENV = opts.environmentOverride;
  }
  const runtime = await resolveSpecRuntimeContext(specPath, {
    ...(opts.environmentOverride
      ? { envOverride: opts.environmentOverride }
      : {}),
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.vars ? { vars: opts.vars } : {}),
    env,
  });
  const secrets = runtime.secrets;
  if (!secrets || secrets.provider !== "tvault" || !secrets.tvault) {
    return {
      env,
      childEnv: childEnvWithoutTvaultControls(env),
      secrets,
      secretValues: [],
      injectedKeys: [],
      shadowedKeys: [],
      selectedKeys: [],
    };
  }

  const { target } = tvaultArgs(secrets.tvault);
  const selectedKeys = await selectedSecretKeys(specPath, secrets);
  const resolved = await getTvaultSelectedEnv(secrets.tvault, selectedKeys);
  if (!resolved.ok) {
    throw new Error(
      `tvault secrets injection failed: ${resolved.error ?? "unknown error"}`,
    );
  }

  const injectedKeys = Object.keys(resolved.env).filter(
    (key) => env[key] === undefined,
  );
  const shadowedKeys = Object.keys(resolved.env).filter(
    (key) => env[key] !== undefined && env[key] !== resolved.env[key],
  );
  // Base env control variables were stripped above. Preserve a selected
  // `TVAULT_*` value here only when it came from the explicit vault allowlist;
  // ordinary client controls must still never become target input.
  const scopedEnv: Record<string, string | undefined> =
    targetChildEnvWithSelectedTvaultKeys(
      { ...resolved.env, ...env },
      selectedKeys,
    );
  const missing = (secrets.required ?? []).filter(
    (key) => scopedEnv[key] === undefined || scopedEnv[key] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `tvault "${target}" is missing required secrets: ${missing.join(", ")}`,
    );
  }
  return {
    env: scopedEnv,
    childEnv: childEnvWithoutTvaultControls(scopedEnv, selectedKeys),
    secrets,
    target,
    secretValues: Object.values(resolved.env),
    injectedKeys,
    shadowedKeys,
    selectedKeys,
  };
}

async function selectedSecretKeys(
  specPath: string,
  secrets: SecretsConfig,
): Promise<string[]> {
  const names = new Set([...(secrets.keys ?? []), ...(secrets.required ?? [])]);
  const visited = new Set<string>();
  const collect = async (path: string): Promise<void> => {
    const absPath = resolve(path);
    if (visited.has(absPath)) return;
    visited.add(absPath);
    const source = await readFile(absPath, "utf8");
    for (const match of source.matchAll(
      /\$\{(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\}/g,
    )) {
      names.add(match[1]!);
    }

    // `imports:` are executable spec input: action placeholders are resolved
    // in the same invocation as the root flow, so their selected key names
    // must not silently turn into empty strings before parsing.
    const parsed: unknown = parseYaml(source);
    if (!isRecord(parsed) || !Array.isArray(parsed.imports)) return;
    for (const importPath of parsed.imports) {
      if (typeof importPath !== "string") continue;
      await collect(resolveImportPath(importPath, dirname(absPath)));
    }
  };
  await collect(specPath);
  return [...names].toSorted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveImportPath(importPath: string, baseDir: string): string {
  if (importPath.startsWith("~/")) {
    return resolve(homedir(), importPath.slice(2));
  }
  return isAbsolute(importPath) ? importPath : resolve(baseDir, importPath);
}

function extractMetadataKeyNames(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      names.add(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (key === "key" && typeof child === "string") names.add(child);
      else if (key === "keys" || key === "local" || key === "inherited")
        visit(child);
    }
  };
  visit(value);
  return [...names].toSorted();
}
