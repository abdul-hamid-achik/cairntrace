// Narration renderers for non-interactive output.
//
// The interactive (tty) renderer lives in src/cli/ui (Ink + @inkjs/ui); this
// module keeps the plain sequential renderer for pipes/tee/CI plus shared
// glyph/mark helpers used by non-run commands (login, heal) and the plain
// batch lines.
import { log as clackLog, S_ERROR, S_SUCCESS, S_WARN } from "@clack/prompts";
import type { ProgressListener } from "../core/runner/Runner";

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
 * timestamped and final — nothing is redrawn. Short steps report only on
 * completion; long waits (preconditions, verifier polls) announce themselves
 * so a many-minute gate is attributable from the log alone.
 */
export function makePlainListener(
  options: { write?: (s: string) => void } = {},
): ProgressListener {
  const write = options.write ?? out;
  const line = (s: string) =>
    write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);
  // The when: gate of the step in flight, for the skip line.
  let currentWhen: string | undefined;
  return {
    onStepStart(_idx, step) {
      currentWhen = "when" in step ? step.when : undefined;
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
}

/**
 * Completion mark for the batch narration (run.ts plain path): the same glyph
 * family as the Ink view, so `cairn run` speaks one visual language in both
 * the live and the plain paths. `color: false` yields the bare glyph.
 */
export function completionMark(
  status: "passed" | "failed" | "errored",
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

function formatPreconditionStatus(
  exitCode: number | undefined,
  details: { timedOut?: boolean; signal?: string } | undefined,
): string {
  if (details?.timedOut) {
    return `timed out${details.signal ? ` (${details.signal})` : ""}`;
  }
  return exitCode === 0 ? "ok" : `failed (exit ${exitCode ?? "unknown"})`;
}

// Progress goes to stderr — stdout is reserved for structured results.
function out(s: string): void {
  process.stderr.write(s);
}

function formatMs(ms: number): string {
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
