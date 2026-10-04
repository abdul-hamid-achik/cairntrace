import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import {
  CANCEL_KILL_WAIT_MS,
  CANCEL_TERM_GRACE_MS,
} from "../schema/delegate.v1";

/**
 * The delegated runner process: spawned in a process group of its own
 * (`detached`) so a terminal Ctrl-C reaches cairn alone and cairn decides
 * what the runner gets. A cancel sends SIGINT to the runner's pid ONLY —
 * the helpers it already runs (an ssh connection following the remote
 * stream, an rsync mirroring run directories) keep working while it cancels
 * remotely and copies the results back — and only after `cancelGraceMs`
 * SIGTERM, then SIGKILL, to the whole group. stdout and stderr go straight
 * to a file — never a pipe that a busy (or synchronously waiting) cairn
 * could leave full, blocking the runner in the middle of its cancel.
 */

export interface RunnerExit {
  /** The runner's exit code (absent when a signal ended it). */
  exitCode?: number;
  signal?: string;
  /** It never started (ENOENT, EACCES, a bad cwd…). */
  spawnError?: string;
}

export interface CancelOutcome {
  /** The runner exited before any escalation. */
  graceful: boolean;
  /** Still alive after SIGKILL and its wait. */
  stillRunning: boolean;
}

type Escalation = (signal: "SIGTERM" | "SIGKILL", afterMs: number) => void;

/** How {@link processRunningSync} looks at a process (injectable for tests). */
export interface ProcessProbe {
  platform: NodeJS.Platform;
  /** `process.kill(pid, 0)`. */
  kill: (pid: number) => void;
  /** `/proc/<pid>/stat` (Linux). */
  readProcStat: (pid: number) => string;
  /** `ps -o stat= -p <pid>`. */
  ps: (pid: number) => {
    error?: unknown;
    status: number | null;
    stdout: string;
  };
}

const systemProbe: ProcessProbe = {
  platform: process.platform,
  kill: (pid) => process.kill(pid, 0),
  readProcStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  ps: (pid) => {
    const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return {
      ...(ps.error ? { error: ps.error } : {}),
      status: ps.status,
      stdout: ps.stdout ?? "",
    };
  },
};

/**
 * Is `pid` a live (not zombie) process, decided without the event loop?
 * The synchronous signal path blocks it, so an exited child is not reaped
 * yet and `kill(pid, 0)` still succeeds on the zombie: Linux's
 * `/proc/<pid>/stat` (state `Z` / `X`) tells, elsewhere `ps -o stat=`. When
 * neither can tell (no /proc, a `ps` that fails or prints nothing — BusyBox
 * has no `-o stat=`), the process counts as running: a cancel then waits
 * the full grace and escalates, instead of skipping straight to SIGTERM and
 * losing the runner's remote cancel and final copy.
 */
export function processRunningSync(
  pid: number,
  probe: ProcessProbe = systemProbe,
): boolean {
  try {
    probe.kill(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (probe.platform === "linux") {
    try {
      const stat = probe.readProcStat(pid);
      // `pid (comm) S …`: comm may hold spaces and parentheses.
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .charAt(0);
      if (state) return state !== "Z" && state !== "X";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      // Unreadable /proc (hidepid…): ask ps.
    }
  }
  let ps: ReturnType<ProcessProbe["ps"]>;
  try {
    ps = probe.ps(pid);
  } catch {
    return true;
  }
  const stat = ps.stdout.trim();
  if (ps.error !== undefined || ps.status !== 0 || !stat) return true;
  return !stat.startsWith("Z");
}

const liveRunners = new Set<RunnerProcess>();
let exitHookInstalled = false;

/**
 * A runner still running when this process exits (a crash, an unexpected
 * exit path) gets SIGINT so it cancels its remote invocation instead of
 * running on without an owner.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const runner of liveRunners) runner.interrupt();
  });
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Atomics.wait is unavailable: spin (bounded by the caller).
    }
  }
}

export class RunnerProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<RunnerExit>;
  private result: RunnerExit | undefined;

  private constructor(
    child: ChildProcess | undefined,
    exited: Promise<RunnerExit>,
  ) {
    this.pid = child?.pid;
    this.exited = exited.then((result) => {
      this.result = result;
      liveRunners.delete(this);
      return result;
    });
    if (this.pid !== undefined) {
      liveRunners.add(this);
      installExitHook();
    }
  }

  /**
   * Start `command` (argv, no shell) in its own process group, its output
   * appended to `outputPath`. A runner that cannot start settles `exited`
   * with `spawnError`.
   */
  static spawn(input: {
    command: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputPath: string;
  }): RunnerProcess {
    let fd: number | undefined;
    try {
      fd = openSync(input.outputPath, "a", 0o600);
    } catch {
      fd = undefined;
    }
    try {
      const child = spawn(input.command[0]!, input.command.slice(1), {
        cwd: input.cwd,
        env: input.env,
        detached: true,
        stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
      });
      const exited = new Promise<RunnerExit>((resolveExit) => {
        child.once("error", (error) =>
          resolveExit({ spawnError: error.message }),
        );
        child.once("exit", (code, signal) =>
          resolveExit({
            ...(code !== null ? { exitCode: code } : {}),
            ...(signal ? { signal } : {}),
          }),
        );
      });
      return new RunnerProcess(child, exited);
    } catch (error) {
      return new RunnerProcess(
        undefined,
        Promise.resolve({ spawnError: (error as Error).message }),
      );
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The child holds its own copy.
        }
      }
    }
  }

  /** How it ended, once the event loop saw it exit. */
  get settled(): RunnerExit | undefined {
    return this.result;
  }

  /** Still running, decided without the event loop ({@link processRunningSync}). */
  isRunningSync(): boolean {
    if (this.result || this.pid === undefined) return false;
    return processRunningSync(this.pid);
  }

  /**
   * SIGINT to the runner's pid only: its helpers (same process group) keep
   * running so it can use them to cancel remotely and copy the results.
   */
  interrupt(): void {
    if (this.result || this.pid === undefined) return;
    try {
      process.kill(this.pid, "SIGINT");
    } catch {
      // gone
    }
  }

  /** Signal the runner's process group (the runner alone if that fails). */
  signal(signal: NodeJS.Signals): void {
    if (this.result || this.pid === undefined) return;
    try {
      process.kill(-this.pid, signal);
      return;
    } catch {
      // No group (it already exited, or setsid failed): the child itself.
    }
    try {
      process.kill(this.pid, signal);
    } catch {
      // gone
    }
  }

  /** Resolves true once the runner exited, false after `ms`. */
  async waitFor(ms: number): Promise<boolean> {
    if (this.result) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), Math.max(0, ms));
    });
    try {
      return await Promise.race([this.exited.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Block until the runner exited or `ms` passed, calling `tick` every
   * `pollMs` (the signal path relays the stream and beats the heartbeat
   * from it). True once it exited.
   */
  waitSync(ms: number, tick: () => void, pollMs = 250): boolean {
    const deadline = Date.now() + Math.max(0, ms);
    for (;;) {
      try {
        tick();
      } catch {
        // The relay never stops the wait.
      }
      if (!this.isRunningSync()) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      sleepSync(Math.min(pollMs, left));
    }
  }

  /**
   * SIGINT (pid) → `graceMs` → SIGTERM (group) → 10s → SIGKILL (group) →
   * 5s, asynchronously.
   */
  async cancel(
    graceMs: number,
    onEscalate: Escalation,
    termGraceMs = CANCEL_TERM_GRACE_MS,
  ): Promise<CancelOutcome> {
    const start = Date.now();
    this.interrupt();
    if (await this.waitFor(graceMs))
      return { graceful: true, stillRunning: false };
    onEscalate("SIGTERM", Date.now() - start);
    this.signal("SIGTERM");
    if (await this.waitFor(termGraceMs))
      return { graceful: false, stillRunning: false };
    onEscalate("SIGKILL", Date.now() - start);
    this.signal("SIGKILL");
    const gone = await this.waitFor(CANCEL_KILL_WAIT_MS);
    return { graceful: false, stillRunning: !gone };
  }

  /** {@link cancel} for the synchronous signal path; `tick` keeps relaying. */
  cancelSync(
    graceMs: number,
    onEscalate: Escalation,
    tick: () => void,
    termGraceMs = CANCEL_TERM_GRACE_MS,
  ): CancelOutcome {
    const start = Date.now();
    this.interrupt();
    if (this.waitSync(graceMs, tick))
      return { graceful: true, stillRunning: false };
    onEscalate("SIGTERM", Date.now() - start);
    this.signal("SIGTERM");
    if (this.waitSync(termGraceMs, tick))
      return { graceful: false, stillRunning: false };
    onEscalate("SIGKILL", Date.now() - start);
    this.signal("SIGKILL");
    const gone = this.waitSync(CANCEL_KILL_WAIT_MS, tick);
    return { graceful: false, stillRunning: !gone };
  }

  /** After the runner exited: end whatever it left in its group. */
  killLeftovers(): void {
    if (this.pid === undefined) return;
    try {
      process.kill(-this.pid, "SIGTERM");
    } catch {
      // The group is empty.
    }
  }
}
