import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import {
  createProcessTreeWatchdog,
  killProcessTreeSync,
} from "../../adapters/agent-browser/processTree";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import {
  describeLostExit,
  watchChildExit,
  type ChildExit,
} from "../../core/runner/childExit";
import {
  cairnContextEnv,
  targetChildEnvWithSelectedTvaultKeys,
  type CairnContextEnvInput,
} from "../../core/processEnv";
import { HOOK_OUTPUT_TAIL_CHARS } from "../../core/schema/events.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import { log } from "../logger";
import type { ScopedSecrets } from "../commands/secrets";
import {
  absoluteSpecPath,
  parseHookTimeoutMs,
  resolveRunRuntime,
} from "./options";

/** Scoped logger for the run lifecycle (hooks, post-run integrations). */
const runLog = log.scope("run");

/** Batch-level narration sink (journal + TUI or logger in the engine). */
export type NoteFn = (kind: "info" | "warn", message: string) => void;

/** Standalone default: the run logger. The engine passes its own sink. */
const defaultNote: NoteFn = (kind, message) =>
  kind === "warn" ? runLog.warn(message) : runLog.info(message);

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Where a hook's events and live log go (the invocation journal). */
export interface HookObserver {
  journal: InvocationJournal;
  /** `--after` hooks: the run the hook ran for. */
  runId?: string;
  /** `--repeat`/`--matrix`: the 1-based iteration. */
  iteration?: number;
}

/**
 * After the deadline killed a hook's tree, how long its exit may take to be
 * reported before the hook is given up on.
 */
const HOOK_KILL_SETTLE_MS = 5_000;
/** Output kept for a hook whose exit the runtime lost. */
const LOST_HOOK_OUTPUT_CHARS = 64 * 1024;

/** The fields of an execa result a hook verdict reads. */
interface HookRunResult {
  exitCode?: number;
  timedOut: boolean;
  all?: unknown;
  stderr?: unknown;
  /** Why the verdict did not come from execa (the exit was lost). */
  lost?: string;
}

function lostHookResult(exit: ChildExit, output: string): HookRunResult {
  return {
    ...(exit.code !== null ? { exitCode: exit.code } : {}),
    timedOut: exit.via === "abandoned",
    all: output,
    stderr: "",
    lost: describeLostExit(exit.via, exit.code),
  };
}

/** A `signal` cancelled the hooks (thrown for fatal `--before` hooks). */
export class HookCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookCancelledError";
  }
}

/**
 * Run repeatable `--before` / `--after` shell hooks.
 * `before` failures are fatal (default); `after` can be non-fatal.
 * When `signal` aborts, the running hook's process tree is killed and the
 * remaining hooks are skipped: fatal hooks throw {@link HookCancelledError},
 * non-fatal ones return.
 */
export async function runHookCommands(
  phase: "before" | "after",
  commands: string[] | undefined,
  /** Invocation journal (observer): hook.* events and live logs/hook-*.log. */
  /** Non-fatal failure narration (default: the run logger). */
  opts: {
    fatal?: boolean;
    cwd?: string;
    env?: Record<string, string | undefined>;
    selectedTvaultKeys?: Iterable<string>;
    timeoutMs?: number;
    observer?: HookObserver;
    note?: NoteFn;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const list = (commands ?? []).map((c) => c.trim()).filter(Boolean);
  if (list.length === 0) return;
  const fatal = opts.fatal ?? true;
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const note = opts.note ?? defaultNote;
  // The command line and its output reach stderr (and, as NDJSON narration,
  // whatever collects it): scrub them like the journal does.
  const observer = opts.observer;
  const redact = observer
    ? (text: string) => observer.journal.redactText(text)
    : createArtifactRedactor(undefined, opts.env ?? process.env).text;
  const signal = opts.signal;
  const cancelled = (msg: string): void => {
    if (fatal) throw new HookCancelledError(msg);
    note("info", msg);
  };
  for (const [position, command] of list.entries()) {
    if (signal?.aborted) {
      cancelled(
        `${phase} hooks skipped: invocation cancelled (${list.length - position} not run)`,
      );
      return;
    }
    runLog.info(`${phase}: ${redact(command)}`);
    const hook = startHookObservation(
      opts.observer,
      phase,
      position + 1,
      command,
      timeoutMs,
    );
    try {
      const subprocess = execa(command, {
        shell: true,
        cwd,
        env: targetChildEnvWithSelectedTvaultKeys(
          opts.env ?? process.env,
          opts.selectedTvaultKeys ?? [],
        ),
        // The filtered env is the whole env: execa's default would merge the
        // parent's process.env back in, publisher/TinyVault credentials too.
        extendEnv: false,
        // Cairn's tree watchdog owns the exact deadline. Execa remains a
        // slightly-later fallback if the event loop cannot run the watchdog.
        timeout: timeoutMs + 2_000,
        reject: false,
        all: true,
      });
      let collected = "";
      subprocess.all?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        collected = (collected + text).slice(-LOST_HOOK_OUTPUT_CHARS);
        hook?.write(text);
      });
      const watchdog = createProcessTreeWatchdog(subprocess.pid, timeoutMs);
      // execa settles on the child's exit event, which the runtime can lose
      // (a <defunct> hook, see core/runner/childExit.ts): the process table
      // settles it then, and a hook killed at its deadline is given up on
      // after a short grace instead of being awaited forever.
      const exitWatch = watchChildExit(subprocess);
      const settleTimer = setTimeout(
        () => exitWatch.abandon(),
        timeoutMs + HOOK_KILL_SETTLE_MS,
      );
      // Cancel: hard-kill the hook's whole tree (a shell's children too).
      let killedByCancel = false;
      let cancelSettleTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        killedByCancel = true;
        killProcessTreeSync(subprocess.pid);
        cancelSettleTimer = setTimeout(
          () => exitWatch.abandon(),
          HOOK_KILL_SETTLE_MS,
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const r: HookRunResult = await (async () => {
        try {
          return await Promise.race([
            subprocess.then((result): HookRunResult => result),
            exitWatch.exited.then(
              (exit): Promise<HookRunResult> | HookRunResult =>
                exit.via === "event"
                  ? subprocess.then((result): HookRunResult => result)
                  : lostHookResult(exit, collected),
            ),
          ]);
        } finally {
          watchdog.cancel();
          clearTimeout(settleTimer);
          clearTimeout(cancelSettleTimer);
          exitWatch.abandon();
          signal?.removeEventListener("abort", onAbort);
        }
      })();
      if (r.lost) {
        note("warn", `${phase} hook: ${r.lost}: ${redact(command)}`);
      }
      hook?.finish({
        ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
        timedOut: !killedByCancel && (watchdog.timedOut || r.timedOut),
        ...(killedByCancel ? { cancelled: true } : {}),
        output: String(r.all ?? r.stderr ?? ""),
      });
      if (killedByCancel) {
        cancelled(
          `${phase} hook cancelled and its process tree killed: ${redact(command)}`,
        );
        return;
      }
      if (watchdog.timedOut || r.timedOut) {
        const tail = redact(String(r.all ?? r.stderr ?? ""))
          .trim()
          .slice(-2000);
        const msg = `${phase} hook timed out after ${timeoutMs}ms and its process tree was killed: ${redact(command)}${
          tail ? `\n${tail}` : ""
        }`;
        if (fatal) throw new Error(msg);
        note("warn", msg);
        continue;
      }
      if (r.exitCode !== 0) {
        const tail = redact(String(r.all ?? r.stderr ?? ""))
          .trim()
          .slice(-2000);
        const msg = `${phase} hook failed (exit ${r.exitCode ?? "unknown"}): ${redact(command)}${
          tail ? `\n${tail}` : ""
        }`;
        if (fatal) throw new Error(msg);
        note("warn", msg);
      }
    } catch (e) {
      if (e instanceof HookCancelledError) throw e;
      hook?.finish({ output: (e as Error).message });
      if (fatal) throw e;
      note("warn", `${phase} hook error: ${redact((e as Error).message)}`);
    }
  }
}

/**
 * Announce one hook execution in the invocation journal: phase.changed,
 * hook.started, a separator in its live log (logs/hook-before-NN.log, shared
 * by every iteration, or logs/hook-after-NN-<runId>.log, one per run so
 * concurrent `--parallel` runs never interleave), and later hook.finished
 * with the redacted output tail.
 */
function startHookObservation(
  observer: HookObserver | undefined,
  phase: "before" | "after",
  index: number,
  command: string,
  timeoutMs: number,
):
  | {
      write(chunk: string): void;
      finish(result: {
        exitCode?: number;
        timedOut?: boolean;
        /** Killed by an invocation cancel. */
        cancelled?: boolean;
        output: string;
      }): void;
    }
  | undefined {
  if (!observer) return undefined;
  const { journal, runId, iteration } = observer;
  void journal.tracker.enter(
    phase === "before" ? "before-hooks" : "after-hooks",
    { item: `${phase}#${index}`, budgetMs: timeoutMs },
  );
  const startedAtMs = Date.now();
  const {
    log: hookFile,
    path,
    release,
  } = journal.hookLog(phase, index, phase === "after" ? runId : undefined);
  const scope = {
    ...(runId ? { runId } : {}),
    ...(iteration !== undefined ? { iteration } : {}),
  };
  hookFile.writeLine(
    `--- ${new Date(startedAtMs).toISOString()}${runId ? ` run ${runId}` : ""}${
      iteration !== undefined ? ` iteration ${iteration}` : ""
    } ---`,
  );
  hookFile.writeLine(`$ ${command}`);
  journal.appendEvent({
    ts: new Date(startedAtMs).toISOString(),
    type: "hook.started",
    hook: phase,
    index,
    command: journal.redactText(command),
    logPath: path,
    timeoutMs,
    ...scope,
  });
  return {
    write: (chunk) => hookFile.write(chunk),
    finish: (result) => {
      hookFile.flush();
      const durationMs = Date.now() - startedAtMs;
      const ending = result.cancelled
        ? "cancelled"
        : result.timedOut
          ? "timed out"
          : `exit ${result.exitCode ?? "unknown"}`;
      hookFile.writeLine(`[${ending} after ${durationMs}ms]`);
      release();
      // Redact the whole output before cutting the tail so a secret that
      // straddles the cut can never survive as a partial literal.
      const redacted = journal.redactText(result.output).trimEnd();
      const outputTail =
        redacted.length > HOOK_OUTPUT_TAIL_CHARS
          ? redacted.slice(redacted.length - HOOK_OUTPUT_TAIL_CHARS)
          : redacted;
      journal.appendEvent({
        ts: new Date().toISOString(),
        type: "hook.finished",
        hook: phase,
        index,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        durationMs,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(outputTail ? { outputTail } : {}),
        ...scope,
      });
      journal.narrate(
        `${phase} hook #${index} ${
          result.cancelled
            ? "cancelled"
            : result.timedOut
              ? "timed out"
              : result.exitCode === 0
                ? "ok"
                : `failed (exit ${result.exitCode ?? "unknown"})`
        } in ${formatMs(durationMs)}`,
      );
    },
  };
}

/** Invocation-level, non-secret hook context (see cairnContextEnv). */
export type HookContext = Pick<
  CairnContextEnvInput,
  "environment" | "baseUrl" | "configDir"
>;

/**
 * Run `--after` hooks for ONE finished spec. Pass or fail, with
 * `CAIRN_RUN_DIR` (and `CAIRN_RUN_ID`, `CAIRN_RUN_STATUS`, `CAIRN_SPEC_PATH`)
 * set so external collectors can write into `$CAIRN_RUN_DIR/diagnostics/`.
 * Best-effort: never throws and never changes the run exit code. Skipped for
 * synthesized errored results (their run dir is never created).
 */
export async function runAfterHooksForResult(
  result: RunResult,
  opts: {
    after?: string[];
    hookTimeoutMs?: string | number;
    /** Cancel: kill the running hook and skip the rest. */
    signal?: AbortSignal;
  },
  scopedSecrets?: ScopedSecrets,
  context: HookContext & { runToken?: string } = {},
  observer?: HookObserver,
  note: NoteFn = defaultNote,
): Promise<void> {
  if (!opts.after || opts.after.every((c) => !c.trim())) return;
  try {
    const diagnostics = join(result.runDir, "diagnostics");
    if (!existsSync(result.runDir)) {
      note(
        "warn",
        `after hooks skipped: run directory does not exist (${result.runDir})`,
      );
      return;
    }
    await mkdir(diagnostics, { recursive: true });
    await runHookCommands("after", opts.after, {
      fatal: false,
      env: {
        ...(scopedSecrets?.childEnv ?? process.env),
        ...cairnContextEnv({
          ...context,
          environment: result.environment,
          runId: result.runId,
          runDir: result.runDir,
        }),
        CAIRN_RUN_STATUS: result.status,
        CAIRN_SPEC_PATH: result.spec.path,
      },
      selectedTvaultKeys: scopedSecrets?.selectedKeys ?? [],
      timeoutMs:
        typeof opts.hookTimeoutMs === "number"
          ? opts.hookTimeoutMs
          : parseHookTimeoutMs(opts.hookTimeoutMs),
      ...(observer ? { observer } : {}),
      note,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    note("warn", `after hook: ${(e as Error).message}`);
  }
}

/**
 * Resolve CAIRN_ENV / CAIRN_BASE_URL / CAIRN_CONFIG_DIR for hooks from the
 * first spec, with the same discovery as webServer/services. Best-effort: an
 * unreadable spec or config yields an empty context (the spec run reports it).
 */
export async function resolveHookContext(
  firstSpec: string,
  opts: Pick<RunInvocationOptions, "env" | "config" | "var">,
  scopedSecrets?: ScopedSecrets,
  cwd: string = process.cwd(),
): Promise<HookContext> {
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return {};
  try {
    const ctx = await resolveRunRuntime(
      firstSpecAbs,
      opts,
      scopedSecrets ? { env: scopedSecrets.env } : {},
    );
    return {
      environment: ctx.envName,
      ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}),
      ...(ctx.configPath ? { configDir: dirname(ctx.configPath) } : {}),
    };
  } catch {
    return {};
  }
}
