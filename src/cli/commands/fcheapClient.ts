import { execa } from "execa";
import { pathFreeMessage } from "../../core/artifacts/retention";
import { fcheapPublisherEnv, targetChildEnv } from "../../core/processEnv";

export interface FcheapProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The binary could not be executed (not installed / not on $PATH). */
  missing?: boolean;
  /** The process was killed at `timeoutMs`. */
  timedOut?: boolean;
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
    // extendEnv: false — execa would otherwise merge process.env back in and
    // hand the publisher token / TinyVault controls to every fcheap child.
    // Both filtered maps keep PATH and HOME.
    const result = await execa(resolveFcheapBinary(env), fullArgs, {
      reject: false,
      timeout: opts.timeoutMs ?? 60_000,
      env,
      extendEnv: false,
    });
    const failedToSpawn =
      result.exitCode === undefined &&
      (result as { code?: string }).code === "ENOENT";
    if (failedToSpawn) {
      return {
        ok: false,
        stdout: "",
        stderr: `fcheap not found on $PATH. ${FCHEAP_INSTALL_HINT}`,
        exitCode: -1,
        missing: true,
      };
    }
    return {
      ok: result.exitCode === 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? -1,
      ...(result.timedOut ? { timedOut: true } : {}),
    };
  } catch (error) {
    const cause = error as Error & { code?: string };
    if (cause.code === "ENOENT" || cause.message?.includes("ENOENT")) {
      return {
        ok: false,
        stdout: "",
        stderr: `fcheap not found on $PATH. ${FCHEAP_INSTALL_HINT}`,
        exitCode: -1,
        missing: true,
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

const saveMetaSupport = new Map<string, Promise<boolean>>();

/**
 * Whether the installed `fcheap save` accepts `--meta key=value` (0.36+),
 * detected once per binary from `fcheap save --help`. Any failure means
 * "unsupported" so callers degrade to a plain save.
 */
export function fcheapSupportsSaveMeta(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const binary = resolveFcheapBinary(env);
  let probe = saveMetaSupport.get(binary);
  if (!probe) {
    probe = runFcheap(["save", "--help"], { timeoutMs: 10_000, env }).then(
      (r) => r.ok && /(^|\s)--meta\b/m.test(r.stdout),
      () => false,
    );
    saveMetaSupport.set(binary, probe);
  }
  return probe;
}

const publishRunIndexSupport = new Map<string, Promise<boolean>>();

/**
 * Whether the installed `fcheap publish` accepts `--run-index` (the
 * metadata-only RunIndexV1 sidecar), detected once per binary.
 */
export function fcheapSupportsPublishRunIndex(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const binary = resolveFcheapBinary(env);
  let probe = publishRunIndexSupport.get(binary);
  if (!probe) {
    probe = runFcheap(["publish", "--help"], { timeoutMs: 10_000, env }).then(
      (r) => r.ok && /(^|\s)--run-index\b/m.test(r.stdout),
      () => false,
    );
    publishRunIndexSupport.set(binary, probe);
  }
  return probe;
}

/** Forget cached capability probes (tests swap FCHEAP_BIN). */
export function resetFcheapCapabilityCache(): void {
  saveMetaSupport.clear();
  publishRunIndexSupport.clear();
}

export type FcheapFailureReason =
  | "fcheap-missing"
  | "save-failed"
  | "auth"
  | "too-large"
  | "timeout"
  | "unknown";

/**
 * Map a failed fcheap process to the short, path-free reason code recorded in
 * `artifact.stash` / `artifact.publish` events.
 */
export function classifyFcheapFailure(
  result: Pick<FcheapProcessResult, "missing" | "timedOut" | "stderr">,
  fallback: FcheapFailureReason = "save-failed",
): FcheapFailureReason {
  if (result.missing) return "fcheap-missing";
  if (result.timedOut) return "timeout";
  // Classify the message, not the paths in it: a spec or run named
  // `oauth_login` must not read as an auth failure.
  const stderr = result.stderr
    .split(/\r?\n/)
    .map((line) => pathFreeMessage(line))
    .join("\n")
    .toLowerCase();
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|forbidden|not (?:logged|signed) in|\blogin required\b|\bauth(?:entication|orization)?\b/.test(
      stderr,
    )
  ) {
    return "auth";
  }
  if (/\b413\b|too large|exceeds|\bquota\b/.test(stderr)) return "too-large";
  return fallback;
}
