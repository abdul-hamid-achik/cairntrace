import { execa } from "execa";
import { fcheapPublisherEnv, targetChildEnv } from "../../core/processEnv";

export interface FcheapProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FcheapProcessOptions {
  json?: boolean;
  timeoutMs?: number;
  /** Explicit child environment. Defaults to a credential-stripped map. */
  env?: NodeJS.ProcessEnv;
}

const FCHEAP_INSTALL_HINT =
  "Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap";

/**
 * Resolve the file.cheap CLI once for every Cairntrace integration surface.
 * `FCHEAP_BIN` supports pinned or non-standard installations; the normal path
 * remains the Homebrew-provided `fcheap` command discovered through `$PATH`.
 */
export function resolveFcheapBinary(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.FCHEAP_BIN?.trim() || "fcheap";
}

/**
 * Execute file.cheap with consistent timeouts, JSON flag handling, and
 * missing-binary diagnostics. Callers still own command-specific exit and
 * response-contract handling.
 */
export async function runFcheap(
  args: string[],
  opts: FcheapProcessOptions = {},
): Promise<FcheapProcessResult> {
  const fullArgs = opts.json ? [...args, "--json"] : args;
  const requestedEnv = opts.env ?? process.env;
  const env =
    args[0] === "publish" && opts.env
      ? fcheapPublisherEnv(requestedEnv)
      : targetChildEnv(requestedEnv);
  try {
    const result = await execa(resolveFcheapBinary(env), fullArgs, {
      reject: false,
      timeout: opts.timeoutMs ?? 60_000,
      env,
    });
    return {
      ok: result.exitCode === 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? -1,
    };
  } catch (error) {
    const cause = error as Error & { code?: string };
    if (cause.code === "ENOENT" || cause.message?.includes("ENOENT")) {
      return {
        ok: false,
        stdout: "",
        stderr: `fcheap not found on $PATH. ${FCHEAP_INSTALL_HINT}`,
        exitCode: -1,
      };
    }
    return {
      ok: false,
      stdout: "",
      stderr: cause.message,
      exitCode: -1,
    };
  }
}

export async function isFcheapAvailable(): Promise<boolean> {
  return (await runFcheap(["--version"], { timeoutMs: 10_000 })).ok;
}
