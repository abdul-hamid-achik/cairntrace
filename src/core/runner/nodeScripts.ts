import { pathToFileURL } from "node:url";
import { execa, execaSync } from "execa";
import {
  descendantPidsSync,
  killProcessTreeSync,
} from "../../adapters/agent-browser/processTree";
import { LineSplitter } from "../artifacts/liveLog";
import { targetChildEnvWithSelectedTvaultKeys } from "../processEnv";

const RESULT_MARKER = "__CAIRNTRACE_RESULT__";

export interface NodeScriptInvocation {
  file?: string;
  source?: string;
  ctx: unknown;
  cwd?: string;
  entryNames: string[];
  /** Kill the child past this budget. Absent = unbounded (legacy behavior). */
  timeoutMs?: number;
  /** Invocation-scoped environment authorized for this target child. */
  env?: Record<string, string | undefined>;
  /** TinyVault-prefixed keys explicitly selected as target input. */
  selectedTvaultKeys?: Iterable<string>;
  /**
   * Live output: each complete stdout/stderr line while the child runs. The
   * result protocol line is not forwarded. Never serialized to the child.
   */
  onOutputLine?: (stream: "stdout" | "stderr", line: string) => void;
  /**
   * Cancellation: on abort the script's whole process tree (anything it
   * spawned too) is SIGKILLed and the result reports it as cancelled.
   */
  signal?: AbortSignal;
  /**
   * Polite cancel window. When > 0, an abort first sends SIGTERM to the
   * script (the verifier SDK aborts `ctx.signal` on it) and SIGKILLs the
   * whole tree only after this many ms — or right away if the parent exits
   * first. Absent/0 keeps the immediate tree kill.
   */
  cancelGraceMs?: number;
  /**
   * Absolute path of the verifier SDK runtime. When set, the child resolves
   * `@thelacanians/cairntrace/verifier` to it, so a verifier gets the
   * runner's own SDK whether or not the package is installed next to it —
   * imported by the entry file or by a helper module it imports.
   */
  sdkEntry?: string;
}

/** The bare specifier SDK verifiers import. */
export const VERIFIER_SDK_SPECIFIER = "@thelacanians/cairntrace/verifier";

export interface NodeScriptResult {
  ok: boolean;
  result?: unknown;
  error?: { name?: string; message: string; stack?: string };
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Node 22.6–25 accept `--experimental-transform-types` (enums, parameter
 * properties). Node 26 removed that flag; type *stripping* is the default
 * and the old flag is a hard "bad option" that failed every verifier.
 */
let transformTypesArgs: string[] | undefined;

function nodeTransformTypesArgs(): string[] {
  if (transformTypesArgs) return transformTypesArgs;
  try {
    execaSync("node", ["--experimental-transform-types", "--version"], {
      reject: true,
      extendEnv: false,
      env: process.env,
    });
    transformTypesArgs = ["--experimental-transform-types"];
  } catch {
    transformTypesArgs = [];
  }
  return transformTypesArgs;
}

export async function runNodeScript(
  invocation: NodeScriptInvocation,
): Promise<NodeScriptResult> {
  // Environment values configure the child process; they must not also be
  // serialized into the authored script payload on stdin.
  const {
    env,
    selectedTvaultKeys,
    onOutputLine,
    signal,
    cancelGraceMs,
    sdkEntry,
    ...rest
  } = invocation;
  const payload = {
    ...rest,
    ...(sdkEntry ? { sdk: pathToFileURL(sdkEntry).href } : {}),
  };
  const subprocess = execa(
    "node",
    [...nodeTransformTypesArgs(), "--input-type=module", "-e", NODE_BOOTSTRAP],
    {
      cwd: invocation.cwd,
      input: JSON.stringify(payload),
      reject: false,
      all: false,
      extendEnv: false,
      env: targetChildEnvWithSelectedTvaultKeys(
        env ?? process.env,
        selectedTvaultKeys ?? [],
      ),
      ...(invocation.timeoutMs ? { timeout: invocation.timeoutMs } : {}),
      // A polite-cancel child (the verifier SDK) handles SIGTERM itself and
      // has already met its own deadline; the budget kill must not wait on
      // that handler (or on a busy loop that never yields to it).
      ...(invocation.timeoutMs && cancelGraceMs && cancelGraceMs > 0
        ? { killSignal: "SIGKILL" as const }
        : {}),
    },
  );
  // The bootstrap prints "\n<marker><json>\n": hold blank stdout lines back
  // until a real line follows, so the protocol never leaks into the log.
  let heldBlankLines = 0;
  const splitters = onOutputLine
    ? {
        stdout: new LineSplitter((line) => {
          if (line.trim() === "") {
            heldBlankLines += 1;
            return;
          }
          if (line.startsWith(RESULT_MARKER)) {
            heldBlankLines = 0;
            return;
          }
          for (; heldBlankLines > 0; heldBlankLines -= 1) {
            onOutputLine("stdout", "");
          }
          onOutputLine("stdout", line);
        }),
        stderr: new LineSplitter((line) => onOutputLine("stderr", line)),
      }
    : undefined;
  if (splitters) {
    subprocess.stdout?.on("data", (chunk: Buffer | string) =>
      splitters.stdout.push(String(chunk)),
    );
    subprocess.stderr?.on("data", (chunk: Buffer | string) =>
      splitters.stderr.push(String(chunk)),
    );
  }
  let killedByCancel = false;
  let sweep: ((rootAlive: boolean) => void) | undefined;
  const onAbort = (): void => {
    killedByCancel = true;
    const pid = subprocess.pid;
    if (!cancelGraceMs || cancelGraceMs <= 0 || !pid) {
      killProcessTreeSync(pid);
      return;
    }
    // Remember the descendants now: a SIGTERMed script can exit and orphan them.
    const descendants = descendantPidsSync(pid);
    const onExit = (): void => sweep?.(true);
    const timer = setTimeout(() => sweep?.(true), cancelGraceMs);
    sweep = (rootAlive) => {
      sweep = undefined;
      clearTimeout(timer);
      process.off("exit", onExit);
      if (rootAlive) killProcessTreeSync(pid);
      for (const child of descendants.toReversed()) {
        try {
          process.kill(child, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    process.once("exit", onExit);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      sweep(false);
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let r: Awaited<typeof subprocess>;
  try {
    r = await subprocess;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // The script exited inside its grace window: sweep what it left behind.
    sweep?.(false);
  }
  splitters?.stdout.flush();
  splitters?.stderr.flush();

  const stdout = String(r.stdout ?? "");
  const stderr = String(r.stderr ?? "");
  const exitCode =
    typeof r.exitCode === "number" ? r.exitCode : r.failed ? 1 : 0;
  if (killedByCancel) {
    return {
      ok: false,
      error: {
        name: "CancelledError",
        message: "node script cancelled: its process tree was killed",
        stack: stderr || stdout,
      },
      stdout,
      stderr,
      exitCode,
    };
  }
  if (r.timedOut) {
    return {
      ok: false,
      error: {
        message: `node script exceeded its ${invocation.timeoutMs}ms timeout and was killed`,
        stack: stderr || stdout,
      },
      stdout,
      stderr,
      exitCode,
    };
  }
  const markerIdx = stdout.lastIndexOf(RESULT_MARKER);
  if (markerIdx < 0) {
    return {
      ok: false,
      error: {
        message: "node script did not emit a Cairntrace result",
        stack: stderr || stdout,
      },
      stdout,
      stderr,
      exitCode,
    };
  }

  const beforeMarker = stdout.slice(0, markerIdx);
  const afterMarker = stdout.slice(markerIdx + RESULT_MARKER.length);
  const newlineIdx = afterMarker.search(/\r?\n/);
  const resultText = (
    newlineIdx < 0 ? afterMarker : afterMarker.slice(0, newlineIdx)
  ).trim();
  const afterResult =
    newlineIdx < 0 ? "" : afterMarker.slice(newlineIdx).trim();
  try {
    const parsed = JSON.parse(resultText) as {
      ok: boolean;
      result?: unknown;
      error?: { name?: string; message: string; stack?: string };
    };
    return {
      ok: parsed.ok && exitCode === 0,
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      stdout: [beforeMarker.trimEnd(), afterResult].filter(Boolean).join("\n"),
      stderr,
      exitCode,
    };
  } catch (e) {
    return {
      ok: false,
      error: {
        message: `failed to parse node script result: ${(e as Error).message}`,
        stack: resultText,
      },
      stdout: [beforeMarker.trimEnd(), afterResult].filter(Boolean).join("\n"),
      stderr,
      exitCode,
    };
  }
}

const NODE_BOOTSTRAP = `
import { appendFileSync } from "node:fs";
import Module from "node:module";
import { pathToFileURL } from "node:url";
import process from "node:process";

const marker = ${JSON.stringify(RESULT_MARKER)};
const sdkSpecifier = ${JSON.stringify(VERIFIER_SDK_SPECIFIER)};
const sdkVerifierMarker = Symbol.for("cairntrace.verifier");
// The entry is a defineVerifier() verifier (directly or via a helper module).
let sdkVerifier = false;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function serializeError(error) {
  if (error && typeof error === "object") {
    return {
      name: typeof error.name === "string" ? error.name : undefined,
      message: typeof error.message === "string" ? error.message : String(error),
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }
  return { message: String(error) };
}

// ctx.progress(message): one line appended to $CAIRN_PROGRESS_FILE, which
// the runner tails into outcome.progress events. A no-op without the file.
function progress(message) {
  const file = process.env.CAIRN_PROGRESS_FILE;
  if (!file) return;
  try {
    appendFileSync(file, String(message).replace(/\\r?\\n/g, " ") + "\\n");
  } catch {
    // Progress is best-effort; it must never fail the script.
  }
}

// Resolve the SDK specifier to the runner's own SDK, so a verifier needs no
// local install and always speaks the runner's protocol version.
function registerSdk(sdkUrl) {
  if (typeof sdkUrl !== "string" || !sdkUrl) return;
  if (typeof Module.registerHooks === "function") {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === sdkSpecifier) {
          return { url: sdkUrl, format: "module", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    return;
  }
  if (typeof Module.register === "function") {
    const hooks =
      "export async function resolve(s, c, n) { if (s === " +
      JSON.stringify(sdkSpecifier) +
      ") return { url: " +
      JSON.stringify(sdkUrl) +
      ", format: 'module', shortCircuit: true }; return n(s, c); }";
    Module.register("data:text/javascript," + encodeURIComponent(hooks));
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  registerSdk(payload.sdk);
  const ctx =
    payload.ctx && typeof payload.ctx === "object" && !Array.isArray(payload.ctx)
      ? { ...payload.ctx, progress }
      : payload.ctx;
  let fn;
  if (payload.file) {
    const mod = await import(pathToFileURL(payload.file).href + "?cairntrace=" + Date.now());
    for (const name of payload.entryNames) {
      if (typeof mod[name] === "function") {
        fn = mod[name];
        break;
      }
    }
    if (!fn && typeof mod.default === "function") fn = mod.default;
  } else if (payload.source) {
    fn = new AsyncFunction("ctx", payload.source);
  }
  if (typeof fn !== "function") {
    throw new Error("node script must export a function or provide script.run source");
  }
  sdkVerifier = Boolean(fn[sdkVerifierMarker]);
  return await fn(ctx);
}

// An SDK verifier is done once its result is out: work it abandoned (a poll
// attempt still running, a hung child process) must not hold the process
// until the runner's hard kill throws the result away. Flush, then exit.
// Plain scripts keep running until their event loop drains, as always.
function finish(code) {
  process.exitCode = code;
  if (!sdkVerifier) return;
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

try {
  const result = await main();
  process.stdout.write("\\n" + marker + JSON.stringify({ ok: true, result }) + "\\n");
  finish(0);
} catch (error) {
  const serialized = serializeError(error);
  if (serialized.stack) process.stderr.write(serialized.stack + "\\n");
  else process.stderr.write(serialized.message + "\\n");
  process.stdout.write("\\n" + marker + JSON.stringify({ ok: false, error: serialized }) + "\\n");
  finish(1);
}
`;
