import { execa } from "execa";

/* ---------------------------------------------------------------------------
 * TinyVault secrets provider
 *
 * `tvault env --project <name> --format json` returns { KEY: "value", ... }.
 * `tvault run --project <name> -- <command>` injects secrets into a subprocess.
 *
 * Cairntrace uses tvault in two ways:
 * 1. `cairn run` with `secrets.provider: tvault` — wraps the backend in tvault env
 * 2. `cairn secrets status` — check which keys are available
 * ------------------------------------------------------------------------- */

export async function isTvaultAvailable(): Promise<boolean> {
  try {
    const r = await execa("tvault", ["version"], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
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
 */
export async function getTvaultKeys(
  project: string,
): Promise<TvaultSecretsResult> {
  const ok = await isTvaultAvailable();
  if (!ok) {
    return {
      ok: false,
      keys: [],
      error:
        "tvault not on $PATH. Install: brew install abdul-hamid-achik/tap/tvault",
    };
  }

  try {
    const r = await execa("tvault", ["list", "--project", project, "--json"], {
      reject: false,
      timeout: 10_000,
    });
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
 * Get secret values as environment variables from TinyVault.
 * Uses `tvault env --project <name> --format json` to get { KEY: "value", ... }.
 * The values are returned for environment injection only — they're never
 * written to artifacts or shown in agent_context.md.
 */
export async function getTvaultEnv(project: string): Promise<TvaultEnvResult> {
  const ok = await isTvaultAvailable();
  if (!ok) {
    return {
      ok: false,
      env: {},
      error:
        "tvault not on $PATH. Install: brew install abdul-hamid-achik/tap/tvault",
    };
  }

  try {
    const r = await execa(
      "tvault",
      ["env", "--project", project, "--format", "json"],
      { reject: false, timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      return { ok: false, env: {}, error: r.stderr || "tvault env failed" };
    }
    const env = JSON.parse(r.stdout);
    return { ok: true, env };
  } catch (e) {
    return { ok: false, env: {}, error: (e as Error).message };
  }
}

/**
 * Run a command with tvault-injected secrets.
 * Uses `tvault run --project <name> -- <command>`.
 * Returns the child process so the caller can control lifecycle.
 */
export async function runWithTvault(
  project: string,
  command: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const args = ["run", "--project", project, "--", ...command];
  try {
    const r = await execa("tvault", args, {
      reject: false,
      timeout: opts.timeoutMs ?? 60_000,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return {
      ok: r.exitCode === 0,
      exitCode: r.exitCode ?? -1,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (e) {
    const err = e as Error;
    return { ok: false, exitCode: -1, stdout: "", stderr: err.message };
  }
}
