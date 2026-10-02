// Narration renderers for non-interactive output.
//
// The interactive (tty) renderer lives in src/cli/ui (Ink + @inkjs/ui); this
// module keeps the plain sequential renderer for pipes/tee/CI plus shared
// glyph/mark helpers used by non-run commands (login, heal) and the plain
// batch lines.
import { log as clackLog, S_ERROR, S_SUCCESS, S_WARN } from "@clack/prompts";
import {
  formatPreconditionStatus,
  makePlainNarration,
  summarizeStepError,
  truncate,
} from "../core/artifacts/narration";
import type { ProgressListener } from "../core/runner/Runner";
import { formatWhen } from "../core/runner/conditions";
import { log } from "./logger";

export { summarizeStepError };

/* ----- Color helpers ----- */

// String-concatenation coloring (${c.green}text${c.reset}) needs raw ANSI
// strings rather than picocolors' function-based API. picocolors is used for
// the logger; here we keep the palette pattern.
export const ansiColors: Palette = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  clearEOL: "\x1b[K",
};

export interface Palette {
  reset: string;
  bold: string;
  dim: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  cyan: string;
  clearEOL: string;
}

export type ProgressMode = "tty" | "plain";

/**
 * Rendering mode is its own axis, not a side effect of TTY detection: `tty`
 * is the Ink renderer (src/cli/ui), `plain` is a designed sequential
 * renderer (timestamped milestone lines, no control codes) that is safe to
 * pipe, tee, and diff — not "tty minus colors". `auto` (the default) picks by
 * the progress sink itself — stderr, exactly like docker --progress —
 * because stdout stays reserved for the structured `--format` document and
 * says nothing about where narration renders.
 */
export function resolveProgressMode(flag?: string): ProgressMode {
  const requested = flag ?? process.env.CAIRN_PROGRESS;
  if (requested === "tty" || requested === "plain") return requested;
  if (requested !== undefined && requested !== "auto") {
    throw new Error(`--progress expects auto|tty|plain, got "${requested}"`);
  }
  // CAIRN_FORCE_TTY predates --progress; honour it as an explicit tty vote.
  if (process.env.CAIRN_FORCE_TTY === "1") return "tty";
  return process.stderr.isTTY ? "tty" : "plain";
}

/**
 * Sequential milestone renderer for pipes, tee, and CI. Every line is
 * timestamped and final — nothing is redrawn. The formatting lives in the
 * core narration module so each run's `run.log` carries the same lines.
 */
export function makePlainListener(
  options: { write?: (s: string) => void } = {},
): ProgressListener {
  return makePlainNarration({ write: options.write ?? out });
}

/** Leveled sink for JSON narration (the logger's `progress` scope by default). */
export interface NarrationSink {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Machine-readable narration for `--format json|yaml` + `--log-format json`.
 * stdout stays reserved for the structured document; these entries go to
 * stderr through the leveled logger (scope `progress`), one NDJSON object per
 * milestone: run start, precondition start (with budget) and finish, step
 * finish (with an error summary), outcome verifying / verdict (with
 * expected/actual on failure), run end. Failures log at warn so `--quiet`
 * keeps them. Every entry after run start carries `runId` (and the batch
 * position when given) so parallel batches stay attributable.
 */
export function makeJsonNarrationListener(
  options: {
    sink?: NarrationSink;
    batch?: { index: number; total: number };
  } = {},
): ProgressListener {
  const sink = options.sink ?? log.scope("progress");
  let runId: string | undefined;
  let currentWhen: string | undefined;
  const ctx = (): Record<string, unknown> => ({
    ...(runId ? { runId } : {}),
    ...(options.batch
      ? { specIndex: options.batch.index, specTotal: options.batch.total }
      : {}),
  });
  return {
    onRunStart(spec, id, runDir, backendName, environment) {
      runId = id;
      sink.info("run start", {
        ...ctx(),
        spec: spec.name,
        runDir,
        backend: backendName,
        environment,
      });
    },
    onPreconditionStart(name, timeoutMs) {
      sink.info("precondition started", {
        ...ctx(),
        name,
        budgetMs: timeoutMs,
      });
    },
    onPreconditionProgress(name, message) {
      sink.info("precondition progress", { ...ctx(), name, message });
    },
    onPreconditionFinish(name, exitCode, durationMs, details) {
      const status = formatPreconditionStatus(exitCode, details);
      const fields = {
        ...ctx(),
        name,
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        durationMs,
        ...(details?.timedOut ? { timedOut: true } : {}),
        ...(details?.signal ? { signal: details.signal } : {}),
      };
      if (status === "ok") sink.info("precondition finished", fields);
      else sink.warn("precondition finished", fields);
    },
    onStepStart(_idx, step) {
      currentWhen =
        "when" in step && step.when !== undefined
          ? formatWhen(step.when)
          : undefined;
    },
    onStepFinish(idx, stepId, status, durationMs, error) {
      const fields = {
        ...ctx(),
        stepId,
        index: idx + 1,
        status,
        durationMs,
        ...(status === "skipped" && currentWhen ? { when: currentWhen } : {}),
        ...(status === "failed" && error
          ? { error: summarizeStepError(error).join("\n") }
          : {}),
      };
      if (status === "failed") sink.warn("step finished", fields);
      else sink.info("step finished", fields);
    },
    onOutcomesStart(total) {
      sink.info("outcomes evaluating", { ...ctx(), total });
    },
    onOutcomeStart(outcome) {
      sink.info("outcome verifying", { ...ctx(), outcomeId: outcome.id });
    },
    onOutcomeProgress(outcome, message) {
      sink.info("outcome progress", {
        ...ctx(),
        outcomeId: outcome.id,
        message,
      });
    },
    onOutcomeFinish(outcome, evaluation) {
      const status = evaluation.skipped
        ? "skipped"
        : evaluation.passed
          ? "passed"
          : "failed";
      const fields = {
        ...ctx(),
        outcomeId: outcome.id,
        status,
        ...(status === "failed"
          ? {
              expected: truncate(evaluation.expected, 200),
              actual: truncate(evaluation.actual.split("\n")[0] ?? "", 200),
            }
          : {}),
      };
      if (status === "failed") sink.warn(`outcome ${status}`, fields);
      else sink.info(`outcome ${status}`, fields);
    },
    onRunEnd(result) {
      const fields = {
        ...ctx(),
        status: result.status,
        durationMs: result.durationMs,
        ...(result.summary ? { summary: result.summary } : {}),
        runDir: result.runDir,
      };
      if (result.status === "passed") sink.info("run end", fields);
      else sink.warn("run end", fields);
    },
  };
}

/**
 * Completion mark for the batch narration (run.ts plain path): the same glyph
 * family as the Ink view, so `cairn run` speaks one visual language in both
 * the live and the plain paths. `color: false` yields the bare glyph.
 */
export function completionMark(
  status: "passed" | "failed" | "errored" | "refused",
  color: boolean,
): string {
  const glyph =
    status === "passed" ? S_SUCCESS : status === "failed" ? S_ERROR : S_WARN;
  if (!color) return glyph;
  const code =
    status === "passed"
      ? ansiColors.green
      : status === "failed"
        ? ansiColors.red
        : status === "refused"
          ? ansiColors.dim
          : ansiColors.yellow;
  return `${code}${glyph}${ansiColors.reset}`;
}

/**
 * One clack log line to stderr for non-run commands (login, heal): mark +
 * 2 spaces + text, with no guide bars (those depend on clack's hardcoded
 * gray styleText, which would leak ANSI under `--no-color`). Callers build
 * the symbol from the exported palettes so colors stay fully controllable.
 */
export function clackLine(symbol: string, text: string, spacing = 0): void {
  clackLog.message(`${symbol}  ${text}`, {
    symbol,
    output: process.stderr,
    withGuide: false,
    spacing,
  });
}

// Progress goes to stderr — stdout is reserved for structured results.
function out(s: string): void {
  process.stderr.write(s);
}
