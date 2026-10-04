import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { durationMs } from "../gates/schema";
import { runBoundedCommand } from "../runner/boundedCommand";
import type { RunFinallyEntry } from "./schema";

/**
 * `run.finally`: belt commands that run after the services / webServer
 * teardown, whatever the verdict. Non-fatal: a failure is journaled and
 * never changes the exit code. Each command sees `CAIRN_EXIT_CODE` (the
 * code the run settled on, critical-teardown failures included, before the
 * cleanliness check) and `CAIRN_INVOCATION_DIR` (the journal directory).
 */

export const DEFAULT_FINALLY_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 2000;

export interface FinallyResult {
  /** 1-based position in `run.finally`. */
  index: number;
  command: string;
  ok: boolean;
  exitCode?: number;
  timedOut?: boolean;
  durationMs: number;
  /** TAIL of the redacted combined output. */
  outputTail?: string;
}

export interface FinallyContext {
  cwd: string;
  /** The scoped child environment; `CAIRN_*` values are layered on top. */
  env: Record<string, string | undefined>;
  exitCode: number;
  invocationDir?: string;
  redact: (text: string) => string;
  /** Skip the first `skip` entries (already run, e.g. on the signal path). */
  skip?: number;
  onStart?: (index: number, total: number) => void;
  onFinish?: (result: FinallyResult) => void;
}

/* ----- the signal path ----- */

/**
 * The budget of the synchronous cleanup a SIGINT / SIGTERM still runs
 * (suite `after` hooks, then `run.finally`): each command gets at most
 * `perCommandMs` (`CAIRN_SIGNAL_HOOK_TIMEOUT_MS`, default 10s) and all of
 * them together at most three times that, so a signal always ends cairn
 * within a bounded time.
 */
export interface SignalBudget {
  perCommandMs: number;
  deadline: number;
}

export function signalBudget(now: number = Date.now()): SignalBudget {
  const raw = Number(process.env.CAIRN_SIGNAL_HOOK_TIMEOUT_MS);
  const perCommandMs = Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
  return { perCommandMs, deadline: now + perCommandMs * 3 };
}

/** What one command may still take on the signal path (0: none left). */
export function signalTimeout(
  budget: SignalBudget,
  ownTimeoutMs: number,
  now: number = Date.now(),
): number {
  return Math.max(
    0,
    Math.min(ownTimeoutMs, budget.perCommandMs, budget.deadline - now),
  );
}

export interface SyncShellResult {
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
  /** The output's tail, when it went to `outputFile`. */
  outputTail?: string;
}

/**
 * One shell command, synchronously, for the signal path (where an async
 * continuation never runs): its own process group (killed whole at the
 * deadline), output to a file (never a pipe a background grandchild could
 * hold open past the deadline).
 */
export function runShellCommandSync(
  command: string,
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    /** Where the output goes (created; parent directories too). */
    outputFile?: string;
  },
): SyncShellResult {
  let fd: number | undefined;
  if (opts.outputFile) {
    try {
      mkdirSync(dirname(opts.outputFile), { recursive: true, mode: 0o700 });
      fd = openSync(opts.outputFile, "a", 0o600);
    } catch {
      fd = undefined;
    }
  }
  const startedAt = Date.now();
  let result: ReturnType<typeof spawnSync> | undefined;
  try {
    // `detached` is honored by spawnSync (setsid) though the typings only
    // declare it for spawn: a second Ctrl-C stops cairn, not the command.
    const options: SpawnSyncOptions & { detached: boolean } = {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      timeout: Math.max(1, opts.timeoutMs),
      killSignal: "SIGKILL",
      stdio: fd !== undefined ? ["ignore", fd, fd] : "ignore",
    };
    result = spawnSync("/bin/sh", ["-c", command], options);
  } catch (error) {
    return {
      timedOut: false,
      durationMs: Date.now() - startedAt,
      spawnError: (error as Error).message,
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  const timedOut =
    (result?.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  // The deadline killed the shell; whatever it started goes with its group.
  if (timedOut && result?.pid) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  let outputTail: string | undefined;
  if (opts.outputFile) {
    try {
      outputTail = readFileSync(opts.outputFile, "utf8")
        .trim()
        .slice(-OUTPUT_TAIL_CHARS);
    } catch {
      outputTail = undefined;
    }
  }
  const spawnError =
    result?.error && !timedOut ? (result.error as Error).message : undefined;
  return {
    ...(typeof result?.status === "number" ? { exitCode: result.status } : {}),
    ...(result?.signal ? { signal: result.signal } : {}),
    timedOut,
    durationMs: Date.now() - startedAt,
    ...(spawnError ? { spawnError } : {}),
    ...(outputTail ? { outputTail } : {}),
  };
}

/** The timeout of one `run.finally` entry (default 60s). */
export function finallyTimeoutMs(entry: RunFinallyEntry): number {
  return (
    (typeof entry === "string" ? undefined : durationMs(entry.timeout)) ??
    DEFAULT_FINALLY_TIMEOUT_MS
  );
}

export async function runFinallyCommands(
  entries: readonly RunFinallyEntry[],
  ctx: FinallyContext,
): Promise<FinallyResult[]> {
  const results: FinallyResult[] = [];
  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    CAIRN_EXIT_CODE: String(ctx.exitCode),
    ...(ctx.invocationDir ? { CAIRN_INVOCATION_DIR: ctx.invocationDir } : {}),
  };
  for (const [i, entry] of entries.entries()) {
    const index = i + 1;
    if (index <= (ctx.skip ?? 0)) continue;
    const command = typeof entry === "string" ? entry : entry.run;
    const timeoutMs = finallyTimeoutMs(entry);
    ctx.onStart?.(index, entries.length);
    const startedAt = Date.now();
    let result: FinallyResult;
    try {
      const run = await runBoundedCommand("/bin/sh", ["-c", command], {
        cwd: ctx.cwd,
        env,
        timeoutMs: Math.max(1, timeoutMs),
        ownProcessGroup: true,
        killLeftovers: false,
      });
      const tail = ctx.redact(run.all.trim()).slice(-OUTPUT_TAIL_CHARS);
      result = {
        index,
        command: ctx.redact(command),
        ok: run.exitCode === 0 && !run.timedOut && !run.spawnError,
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
        ...(run.timedOut ? { timedOut: true } : {}),
        durationMs: Date.now() - startedAt,
        ...(tail ? { outputTail: tail } : {}),
        ...(run.spawnError
          ? { outputTail: ctx.redact(`could not start: ${run.spawnError}`) }
          : {}),
      };
    } catch (error) {
      result = {
        index,
        command: ctx.redact(command),
        ok: false,
        durationMs: Date.now() - startedAt,
        outputTail: ctx.redact((error as Error).message),
      };
    }
    results.push(result);
    ctx.onFinish?.(result);
  }
  return results;
}
