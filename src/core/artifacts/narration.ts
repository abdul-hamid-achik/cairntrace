import type { ProgressListener } from "../runner/Runner";
import { formatWhen } from "../runner/conditions";

export interface PlainNarrationOptions {
  /** Receives finished text (one or more complete lines). */
  write: (text: string) => void;
  /** Also narrate the run's end (status, duration, summary). */
  runEnd?: boolean;
  /** Clock for the `[HH:MM:SS]` prefix (tests). */
  now?: () => Date;
}

/**
 * The plain sequential narration: timestamped milestone lines with no
 * control codes, safe to pipe, tee, diff, and keep on disk. The CLI prints it
 * to stderr in `--progress plain`; the runner writes the same lines to each
 * run's `run.log` regardless of `--format`. Short steps report only on
 * completion; long waits (preconditions, verifier polls) announce themselves
 * so a many-minute gate is attributable from the log alone.
 */
export function makePlainNarration(
  options: PlainNarrationOptions,
): ProgressListener {
  const write = options.write;
  const now = options.now ?? (() => new Date());
  const line = (s: string) =>
    write(`[${now().toISOString().slice(11, 19)}] ${s}\n`);
  // The when: gate of the step in flight, for the skip line.
  let currentWhen: string | undefined;
  const listener: ProgressListener = {
    onStepStart(_idx, step) {
      currentWhen =
        "when" in step && step.when !== undefined
          ? formatWhen(step.when)
          : undefined;
    },
    onRunStart(spec, _runId, runDir, backendName, environment) {
      line(
        `run start: ${spec.name} (env=${environment}, backend=${backendName})`,
      );
      line(`run dir: ${runDir}`);
    },
    onPreconditionStart(name, timeoutMs) {
      line(`precondition ${name} started (budget ${formatMs(timeoutMs)})`);
    },
    onPreconditionProgress(name, message) {
      line(`precondition ${name}: ${message}`);
    },
    onPreconditionFinish(name, exitCode, durationMs, details) {
      line(
        `precondition ${name} ${formatPreconditionStatus(
          exitCode,
          details,
        )} ${formatMs(durationMs)}`,
      );
    },
    onStepFinish(_idx, stepId, status, durationMs, error) {
      const skipReason =
        status === "skipped"
          ? ` (when ${currentWhen ? `"${currentWhen}"` : "condition"} not met)`
          : "";
      line(`step ${stepId} ${status}${skipReason} ${formatMs(durationMs)}`);
      if (status === "failed" && error) {
        for (const errorLine of summarizeStepError(error)) {
          write(`  ${errorLine}\n`);
        }
      }
    },
    onOutcomesStart(total) {
      line(`outcomes: evaluating ${total}`);
    },
    onOutcomeStart(outcome) {
      line(`outcome ${outcome.id} verifying…`);
    },
    onOutcomeProgress(outcome, message) {
      line(`outcome ${outcome.id}: ${message}`);
    },
    onOutcomeFinish(outcome, evaluation) {
      if (evaluation.skipped) {
        line(`outcome ${outcome.id} blocked`);
        return;
      }
      line(`outcome ${outcome.id} ${evaluation.passed ? "passed" : "failed"}`);
      if (!evaluation.passed) {
        write(`  expected: ${truncate(evaluation.expected, 200)}\n`);
        write(
          `  actual:   ${truncate(
            evaluation.actual.split("\n")[0] ?? "",
            200,
          )}\n`,
        );
      }
    },
  };
  if (options.runEnd) {
    listener.onRunEnd = (result) => {
      line(
        `run end: ${result.status} in ${formatMs(result.durationMs)}${
          result.summary ? ` (${truncate(result.summary, 200)})` : ""
        }`,
      );
    };
  }
  return listener;
}

/**
 * Fan one runner callback out to several listeners, in order. Errors are
 * NOT swallowed: a caller's listener that throws still aborts the run, as it
 * did before run.log existed. Put sinks that must never throw first.
 */
export function combineListeners(
  ...listeners: Array<ProgressListener | undefined>
): ProgressListener {
  const active = listeners.filter(
    (listener): listener is ProgressListener => listener !== undefined,
  );
  const fan =
    <K extends keyof ProgressListener>(key: K) =>
    (...args: Parameters<NonNullable<ProgressListener[K]>>): void => {
      for (const listener of active) {
        const handler = listener[key] as
          | ((...handlerArgs: typeof args) => void)
          | undefined;
        if (handler) handler.apply(listener, args);
      }
    };
  return {
    onRunStart: fan("onRunStart"),
    onPreconditionStart: fan("onPreconditionStart"),
    onPreconditionProgress: fan("onPreconditionProgress"),
    onPreconditionFinish: fan("onPreconditionFinish"),
    onStepStart: fan("onStepStart"),
    onStepFinish: fan("onStepFinish"),
    onOutcomesStart: fan("onOutcomesStart"),
    onOutcomeStart: fan("onOutcomeStart"),
    onOutcomeProgress: fan("onOutcomeProgress"),
    onOutcomeFinish: fan("onOutcomeFinish"),
    onRunEnd: fan("onRunEnd"),
  };
}

export function formatPreconditionStatus(
  exitCode: number | undefined,
  details: { timedOut?: boolean; signal?: string } | undefined,
): string {
  if (details?.timedOut) {
    return `timed out${details.signal ? ` (${details.signal})` : ""}`;
  }
  return exitCode === 0 ? "ok" : `failed (exit ${exitCode ?? "unknown"})`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Keep ordinary step errors to the existing 200-character terminal budget;
 * ambiguity reports keep their candidate list (bounded) so a multi-match
 * selector tells the author what to disambiguate with `nth:`.
 */
export function summarizeStepError(error: string): string[] {
  const lines = error.split(/\r?\n/);
  const header = lines[0] ?? error;
  const totalMatch = /:\s*(\d+) visible matches\b/i.exec(header);
  if (!/^ambiguous\b/i.test(header) || !totalMatch) {
    return [truncate(error, 200)];
  }

  const candidates = lines.filter((line) => /^\s+-\s+/.test(line)).slice(0, 3);
  if (candidates.length === 0) return [truncate(error, 200)];

  const rendered = [
    truncate(header, 200),
    ...candidates.map((line) => truncate(line, 200)),
  ];
  const total = Number(totalMatch[1]);
  const omitted = Math.max(0, total - candidates.length);
  if (omitted > 0) rendered.push(`  …and ${omitted} more`);
  return rendered;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
