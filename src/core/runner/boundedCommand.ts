import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTreeSync } from "../../adapters/agent-browser/processTree";

/**
 * A host command with a hard deadline that a background process cannot
 * stretch. Waiting for the child's stdout/stderr to close is not enough: a
 * command like `server & echo started` exits at once while the background
 * process keeps both pipes open, so "wait for EOF" waits as long as that
 * process lives — past any timeout, and past a cancel that kills the
 * (already dead) direct child.
 *
 * Here the verdict comes from the direct child: its exit settles the
 * command, and the pipes then get a short grace before they are destroyed.
 * `timedOut` means the child itself was still running at the deadline.
 *
 * With `ownProcessGroup` the child leads a new process group, so the
 * deadline, a cancel and the process exiting kill the whole group —
 * background processes included, even after they were re-parented. Without
 * it the child shares the caller's terminal (and group); the deadline kills
 * the process tree that is still attached to the child.
 */

/** How long the pipes may stay open after the child exited. */
const DEFAULT_DRAIN_MS = 500;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface BoundedCommandOptions {
  cwd: string;
  /** The complete child environment (nothing is merged in). */
  env: NodeJS.ProcessEnv;
  /** Hard deadline of the direct child. */
  timeoutMs: number;
  /** Cancel: kills the command (the group with `ownProcessGroup`). */
  signal?: AbortSignal;
  /**
   * Run the command in its own process group (`detached`), killed as a
   * whole at the deadline, on cancel and when this process exits.
   */
  ownProcessGroup?: boolean;
  /**
   * Kill what is left of the group once the child exited (probes: a check
   * must not leave processes behind). Needs `ownProcessGroup`.
   */
  killLeftovers?: boolean;
  /** Live output chunks (stdout and stderr, as they arrive). */
  onOutput?: (chunk: string) => void;
  /** Kept per stream (the tail survives). Default 16 MiB. */
  maxBufferBytes?: number;
  /** Grace for the pipes after the child exited. Default 500ms. */
  drainMs?: number;
  /** Written to the child's stdin, then closed (stdin is closed empty otherwise). */
  input?: string;
}

export interface BoundedCommandResult {
  /** Exit code of the direct child (absent when a signal ended it). */
  exitCode?: number;
  /** The signal that ended the direct child. */
  exitSignal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved as they arrived. */
  all: string;
  /** The direct child was still running at the deadline (and was killed). */
  timedOut: boolean;
  /** Cancelled through `signal` before the child exited. */
  cancelled: boolean;
  /** The command could not be started (ENOENT, EACCES…). */
  spawnError?: string;
  /** A background process still held the output open when the child exited. */
  outputHeld?: boolean;
  durationMs: number;
}

/* Process groups still running, killed if this process exits first. */
const liveGroups = new Set<number>();
/* Commands without their own group still running (preconditions, steps). */
const liveChildren = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    killLiveCommandsSync();
  });
}

function trackGroup(pid: number): void {
  liveGroups.add(pid);
  installExitHook();
}

function trackChild(pid: number): void {
  liveChildren.add(pid);
  installExitHook();
}

/**
 * Kill every bounded command of this process that is still running — the
 * process tree of each, and the whole group of a command that leads one.
 * The signal path calls it before the run lock is released, so no
 * precondition, hook, preflight or `run:` step of a dying run is left
 * working (reparented to pid 1) while the next run of the config starts.
 * Synchronous; process-wide (only the exit path calls it).
 */
export function killLiveCommandsSync(): void {
  for (const pid of liveChildren) {
    try {
      killProcessTreeSync(pid);
    } catch {
      // gone
    }
  }
  liveChildren.clear();
  for (const group of liveGroups) killGroup(group);
  liveGroups.clear();
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the group is gone.
  }
}

/** Like execa: one trailing newline is not part of the output. */
function stripFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function append(buffer: string, chunk: string, max: number): string {
  const next = buffer + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

function streamClosed(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolveClosed) => {
    const done = (): void => resolveClosed();
    stream.once("close", done);
    stream.once("end", done);
    stream.once("error", done);
  });
}

/** Run `file args…` (no shell unless `file` is one) within `timeoutMs`. */
export async function runBoundedCommand(
  file: string,
  args: readonly string[],
  opts: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const startedAt = Date.now();
  const empty = { stdout: "", stderr: "", all: "", timedOut: false };
  if (opts.signal?.aborted) {
    return { ...empty, cancelled: true, durationMs: 0 };
  }
  const max = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const ownGroup = opts.ownProcessGroup === true;
  let child: ChildProcess;
  try {
    child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      detached: ownGroup,
    });
  } catch (error) {
    return {
      ...empty,
      cancelled: false,
      spawnError: (error as Error).message,
      durationMs: Date.now() - startedAt,
    };
  }
  const pid = child.pid;
  if (opts.input !== undefined) {
    // A child that exits without reading its stdin must not crash us (EPIPE).
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input);
  }
  let stdout = "";
  let stderr = "";
  let all = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = append(stdout, chunk, max);
    all = append(all, chunk, max);
    opts.onOutput?.(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = append(stderr, chunk, max);
    all = append(all, chunk, max);
    opts.onOutput?.(chunk);
  });
  const pipesClosed = Promise.all([
    streamClosed(child.stdout),
    streamClosed(child.stderr),
  ]);

  let running = pid !== undefined;
  let timedOut = false;
  let cancelled = false;
  if (ownGroup && pid !== undefined) trackGroup(pid);
  else if (pid !== undefined) trackChild(pid);
  const kill = (): void => {
    if (pid === undefined) return;
    // The tree first (it needs the parent links), then the group: a
    // process re-parented away from the tree is still in the group.
    if (running) killProcessTreeSync(pid);
    if (ownGroup) killGroup(pid);
  };
  const timer = setTimeout(
    () => {
      if (!running) return;
      timedOut = true;
      kill();
    },
    Math.max(1, opts.timeoutMs),
  );
  const onAbort = (): void => {
    if (!running) return;
    cancelled = true;
    kill();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", (error) =>
      resolveExit({ code: null, signal: null, error }),
    );
  });
  running = false;
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  if (pid !== undefined) liveChildren.delete(pid);
  if (ownGroup && pid !== undefined) {
    liveGroups.delete(pid);
    if (opts.killLeftovers) killGroup(pid);
  }

  // The child's exit is the verdict; a background process that still holds
  // the pipes gets a short grace, then the pipes are closed on our side.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    pipesClosed.then(() => true),
    new Promise<boolean>((resolveDrain) => {
      drainTimer = setTimeout(
        () => resolveDrain(false),
        opts.drainMs ?? DEFAULT_DRAIN_MS,
      );
    }),
  ]);
  clearTimeout(drainTimer);
  if (!drained) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  return {
    ...(exit.code !== null ? { exitCode: exit.code } : {}),
    ...(exit.signal ? { exitSignal: exit.signal } : {}),
    stdout: stripFinalNewline(stdout),
    stderr: stripFinalNewline(stderr),
    all: stripFinalNewline(all),
    timedOut,
    cancelled,
    ...(exit.error && !timedOut && !cancelled
      ? { spawnError: exit.error.message }
      : {}),
    ...(drained ? {} : { outputHeld: true }),
    durationMs: Date.now() - startedAt,
  };
}
