import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

/**
 * Waiting for a child process to exit without trusting the runtime's `exit`
 * event alone.
 *
 * Bun can lose a subprocess exit notification on Linux (the child exits, the
 * event loop keeps cycling, but the runtime never calls waitpid: the child
 * stays a `<defunct>` zombie and `exit` never fires — oven-sh/bun#43697,
 * seen on 1.3.x and 1.4.0). An `await` on that event alone then never
 * settles, and a deadline that only sends SIGKILL cannot help: signalling a
 * zombie produces no new event. {@link watchChildExit} therefore also polls
 * the process table and settles once the child is gone or a zombie, and
 * {@link ChildExitWatch.abandon} lets a caller whose deadline already killed
 * the child stop waiting for an exit that may never be reported.
 */

/** How the process table is read (injectable for tests). */
export interface ExitProbe {
  platform: NodeJS.Platform;
  /** `process.kill(pid, 0)`. */
  kill: (pid: number) => void;
  /** `/proc/<pid>/stat` (Linux). */
  readProcStat: (pid: number) => string;
}

const systemExitProbe: ExitProbe = {
  platform: process.platform,
  kill: (pid) => process.kill(pid, 0),
  readProcStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
};

export type ChildState =
  | { running: true }
  | {
      running: false;
      /** Recovered from a Linux zombie's `/proc/<pid>/stat` exit_code. */
      exitCode?: number;
      signal?: NodeJS.Signals;
    };

/**
 * The state field and the waitpid-style `exit_code` (field 52, Linux 3.5+)
 * of a `/proc/<pid>/stat` line. `comm` may hold spaces and parentheses, so
 * the fields are counted after the LAST `)`.
 */
export function parseProcStat(
  text: string,
): { state: string; exitStatus?: number } | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  if (!state) return undefined;
  // fields[0] is field 3 (state), so field 52 sits at index 49.
  const raw = fields[49];
  const exitStatus = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return {
    state: state.charAt(0),
    ...(Number.isInteger(exitStatus) && exitStatus >= 0 ? { exitStatus } : {}),
  };
}

/** A waitpid(2) status word as an exit code or the signal that ended it. */
export function decodeWaitStatus(status: number): {
  exitCode?: number;
  signal?: NodeJS.Signals;
} {
  const low = status & 0x7f;
  if (low === 0) return { exitCode: (status >> 8) & 0xff };
  if (low === 0x7f) return {}; // stopped, not ended
  const name = (
    Object.entries(osConstants.signals) as [NodeJS.Signals, number][]
  ).find(([, number]) => number === low)?.[0];
  return name ? { signal: name } : {};
}

/**
 * Has `pid` (a direct child of this process) ended, decided without the
 * event loop? Gone from the process table (ESRCH) or a Linux zombie
 * (`Z` / `X` in `/proc/<pid>/stat`, with its exit status when the kernel
 * shows it). Elsewhere a zombie is indistinguishable from a live process
 * here; callers bound that case with their own deadline.
 */
export function childStateSync(
  pid: number,
  probe: ExitProbe = systemExitProbe,
): ChildState {
  try {
    probe.kill(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { running: false };
    }
    return { running: true };
  }
  if (probe.platform !== "linux") return { running: true };
  let stat: ReturnType<typeof parseProcStat>;
  try {
    stat = parseProcStat(probe.readProcStat(pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { running: false };
    }
    return { running: true };
  }
  if (!stat || (stat.state !== "Z" && stat.state !== "X")) {
    return { running: true };
  }
  return {
    running: false,
    ...(stat.exitStatus !== undefined ? decodeWaitStatus(stat.exitStatus) : {}),
  };
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  /**
   * `event`: the runtime reported it. `poll`: the process table says the
   * child ended but the runtime never delivered its exit (the code is only
   * known from a Linux zombie). `abandoned`: the caller stopped waiting.
   */
  via: "event" | "poll" | "abandoned";
}

export interface ChildExitWatch {
  readonly exited: Promise<ChildExit>;
  /** Settle now (`via: "abandoned"`) unless the exit was already seen. */
  abandon(): void;
}

/**
 * What a hook narrates when its exit did not come from the runtime, or
 * undefined for an ordinary exit.
 */
export function describeLostExit(
  via: ChildExit["via"],
  exitCode: number | null | undefined,
): string | undefined {
  if (via === "abandoned") {
    return "no exit was reported after it was killed at its deadline; stopped waiting for it";
  }
  if (via === "poll") {
    return `the runtime never reported its exit; the process table shows it ended${
      exitCode !== null && exitCode !== undefined
        ? ` with exit ${exitCode}`
        : ""
    }`;
  }
  return undefined;
}

/** How often the process table is checked while a child runs. */
const CHILD_EXIT_POLL_MS = 1_000;
/**
 * How long an ended child may wait for its `exit` event before the poll
 * settles it: a normal exit is reaped and reported within one loop turn.
 */
const CHILD_EXIT_LOST_GRACE_MS = 1_000;

export interface WatchChildExitOptions {
  pollMs?: number;
  /** See {@link CHILD_EXIT_LOST_GRACE_MS}. */
  lostGraceMs?: number;
  probe?: ExitProbe;
}

/**
 * Wait for `child` to exit: its `exit` (or spawn `error`) event, or — when
 * the runtime loses that event — the process table. A settled watch stops
 * polling; one not settled by the event unrefs the child so a lost exit
 * cannot keep this process alive.
 */
export function watchChildExit(
  child: ChildProcess,
  opts: WatchChildExitOptions = {},
): ChildExitWatch {
  const pid = child.pid;
  const probe = opts.probe ?? systemExitProbe;
  const lostGraceMs = opts.lostGraceMs ?? CHILD_EXIT_LOST_GRACE_MS;
  let settle!: (exit: ChildExit) => void;
  let settled = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  const exited = new Promise<ChildExit>((resolve) => {
    settle = (exit) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (exit.via !== "event") {
        try {
          child.unref();
        } catch {
          // best-effort
        }
      }
      resolve(exit);
    };
  });
  // `on`, not `once`: a late 'error' must never become an uncaught one.
  child.on("error", (error) =>
    settle({ code: null, signal: null, error, via: "event" }),
  );
  child.once("exit", (code, signal) => settle({ code, signal, via: "event" }));
  if (pid !== undefined) {
    let endedAt: number | undefined;
    poll = setInterval(
      () => {
        const state = childStateSync(pid, probe);
        if (state.running) {
          endedAt = undefined;
          return;
        }
        endedAt ??= Date.now();
        if (Date.now() - endedAt < lostGraceMs) return;
        settle({
          code: state.exitCode ?? null,
          signal: state.signal ?? null,
          via: "poll",
        });
      },
      Math.max(1, opts.pollMs ?? CHILD_EXIT_POLL_MS),
    );
  }
  return {
    exited,
    abandon: () => settle({ code: null, signal: null, via: "abandoned" }),
  };
}
