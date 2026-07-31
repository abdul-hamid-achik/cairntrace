import {
  intro,
  log as clackLog,
  outro,
  S_BAR,
  S_ERROR,
  S_STEP_SUBMIT,
  S_SUCCESS,
  S_WARN,
  unicode,
} from "@clack/prompts";
import type { ProgressListener } from "../core/runner/Runner";
import type { RunResult } from "../core/schema/run.v1";
import { setProgressMarkerActive } from "./logger";

/* ----- Color helpers ----- */

// The tty renderer uses string-concatenation coloring (${c.green}text${c.reset}),
// so it needs raw ANSI strings rather than picocolors' function-based API.
// picocolors is used for the logger; here we keep the palette pattern.
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

export const noColors: Palette = {
  reset: "",
  bold: "",
  dim: "",
  red: "",
  green: "",
  yellow: "",
  blue: "",
  cyan: "",
  clearEOL: "",
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
 * is the cursor-redraw renderer (spinner, overwritten lines), `plain` is a
 * designed sequential renderer (timestamped milestone lines, no control
 * codes) that is safe to pipe, tee, and diff — not "tty minus colors".
 * `auto` (the default) picks by the progress sink itself — stderr, exactly
 * like docker --progress — because stdout stays reserved for the structured
 * `--format` document and says nothing about where narration renders.
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

export function makeProgressListener(
  mode: ProgressMode,
  options: { color?: boolean } = {},
): ProgressListener {
  return mode === "tty"
    ? makeInteractiveListener(options)
    : makePlainListener();
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
          `  actual:   ${truncate(evaluation.actual.split("\n")[0] ?? "", 200)}\n`,
        );
      }
    },
    onRunEnd(result) {
      const passed = result.outcomes.filter(
        (o) => o.status === "passed",
      ).length;
      line(
        `run ${result.status.toUpperCase()}: ${passed}/${result.outcomes.length} outcomes in ${formatMs(result.durationMs)}`,
      );
    },
  };
}

/**
 * Build a TTY-aware progress listener for `cairn run`.
 *
 * Renders through @clack/prompts (docker-style flat marks — ✔/✖/⚠/◇ — plus
 * guide bars around the run header and the closing outro box), with three
 * deliberate deviations from clack's defaults:
 *
 * - Output is pinned to stderr everywhere (clack defaults to stdout) — stdout
 *   stays reserved for the structured `--format` document.
 * - The in-flight animation is a local ticker, NOT clack's `spinner()`:
 *   clack's spinner grabs stdin (readline + raw mode) and intercepts keys
 *   (Esc → `process.exit(0)`, Ctrl+C swallowed while raw), which would break
 *   cairn's signal-time cleanup and the ability to interrupt a run.
 * - clack hardcodes its marks through `node:util` styleText, which Bun does
 *   not disable via NO_COLOR; every symbol is colored through the project
 *   palette so `--no-color` still means zero ANSI (guide bars are dropped
 *   with it, since clack draws those gray unconditionally).
 */
export function makeInteractiveListener(
  options: { color?: boolean } = {},
): ProgressListener {
  const color = options.color !== false;
  const c: Palette = color ? ansiColors : noColors;
  const guide = color;
  const output = process.stderr;

  /** One clack log line: symbol + 2 spaces + text (docker-style flat marks). */
  function emit(
    symbol: string,
    text: string,
    opts: { spacing?: number } = {},
  ): void {
    // Without guide bars clack drops the symbol entirely; inline it so the
    // mark still reads in --no-color mode.
    const content = guide ? text : `${symbol}  ${text}`;
    clackLog.message(content, {
      symbol,
      output,
      withGuide: guide,
      spacing: opts.spacing ?? 0,
    });
  }

  /** A bare line with no symbol or guide prefix (tail details, hints). */
  function flat(text: string): void {
    clackLog.message(text, {
      symbol: "",
      output,
      withGuide: false,
      spacing: 0,
    });
  }

  /** A blank tree-bar line (or a plain blank line without color). */
  function spacer(): void {
    if (guide) {
      clackLog.message("", {
        symbol: `${c.dim}${S_BAR}${c.reset}`,
        output,
        withGuide: true,
        spacing: 0,
      });
    } else {
      output.write("\n");
    }
  }

  // The when: gate of the step currently in flight, for the skip line.
  let currentWhen: string | undefined;

  // Live line ticker: while a step, precondition, or verifier poll is in
  // flight, redraw its marker line with a spinner frame and elapsed time so
  // a many-minute wait reads as "working, bounded" instead of "dead". Frames
  // animate only on a real TTY — under CAIRN_FORCE_TTY into a pipe every
  // redraw would land as a new log line, so those get the static marker.
  const animate = Boolean(process.stderr.isTTY);
  let ticker: NodeJS.Timeout | undefined;
  let tickerRender: ((frame: string, elapsed: string) => string) | undefined;
  let tickerStart = 0;
  let frameIdx = 0;

  function startTicker(render: (frame: string, elapsed: string) => string) {
    stopTicker();
    setProgressMarkerActive(true);
    tickerRender = render;
    tickerStart = Date.now();
    frameIdx = 0;
    // The marker owns one line slot: the interval redraws it in place and
    // stopTicker retires it, so the next emit starts on a fresh line.
    out(`\r${c.clearEOL}${render(SPINNER_FRAMES[0]!, "")}`);
    if (!animate) return;
    ticker = setInterval(() => {
      if (!tickerRender) return;
      frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
      out(
        `\r${c.clearEOL}${tickerRender(
          SPINNER_FRAMES[frameIdx]!,
          formatMs(Date.now() - tickerStart),
        )}`,
      );
    }, 250);
    ticker.unref?.();
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = undefined;
      out(`\r${c.clearEOL}`);
    }
    setProgressMarkerActive(false);
    tickerRender = undefined;
  }

  /** In-flight marker line: spinner frame + label + live elapsed. */
  const tick = (label: string) => (frame: string, elapsed: string) =>
    `${c.dim}${frame}${c.reset}  ${label}${elapsed ? ` ${elapsed}` : ""}…`;

  return {
    onRunStart(spec, runId, runDir, backendName, environment) {
      intro(
        `${c.bold}Running:${c.reset} ${c.cyan}${spec.name}${c.reset}  ${c.dim}(env=${environment}, backend=${backendName})${c.reset}`,
        { output, withGuide: guide },
      );
      emit(`${c.dim}${S_BAR}${c.reset}`, `${c.dim}Run id:${c.reset} ${runId}`);
      emit(
        `${c.dim}${S_BAR}${c.reset}`,
        `${c.dim}Run dir:${c.reset} ${runDir}`,
      );
      spacer();
    },

    onPreconditionStart(name, timeoutMs) {
      // A quiesce-style precondition can legitimately block for many minutes.
      startTicker(
        (frame, elapsed) =>
          `${c.dim}${frame}${c.reset}  precondition ${name} ${
            elapsed ? `${elapsed} / ` : ""
          }budget ${formatMs(timeoutMs)}…`,
      );
    },

    onPreconditionFinish(name, exitCode, durationMs, details) {
      stopTicker();
      const text = `precondition ${name} ${formatPreconditionStatus(
        exitCode,
        details,
      )} ${c.dim}${formatMs(durationMs)}${c.reset}`;
      if (exitCode === 0 && !details?.timedOut) {
        emit(`${c.green}${S_SUCCESS}${c.reset}`, text);
      } else {
        emit(`${c.red}${S_ERROR}${c.reset}`, text);
      }
    },

    onStepStart(_idx, step, stepId) {
      currentWhen = "when" in step ? step.when : undefined;
      startTicker(tick(stepId));
    },

    onStepFinish(_idx, stepId, status, durationMs, error) {
      stopTicker();
      const dur = `${c.dim}${formatMs(durationMs)}${c.reset}`;
      // Say WHICH gate skipped the step: "(skipped by when:)" read as a
      // rendering glitch, not as the conditional doing its job.
      const tail =
        status === "skipped"
          ? ` ${c.dim}(skipped — when ${
              currentWhen ? `"${currentWhen}"` : "condition"
            } not met)${c.reset}`
          : "";
      if (status === "passed") {
        emit(`${c.green}${S_SUCCESS}${c.reset}`, `${stepId} ${dur}`);
      } else if (status === "failed") {
        const lines = error ? summarizeStepError(error) : [];
        emit(
          `${c.red}${S_ERROR}${c.reset}`,
          [
            `${stepId} ${dur}`,
            ...lines.map((line) => `${c.red}${line}${c.reset}`),
          ].join("\n"),
        );
      } else {
        emit(`${c.yellow}${S_WARN}${c.reset}`, `${stepId} ${dur}${tail}`);
      }
    },

    onOutcomesStart(total) {
      stopTicker();
      emit(`${c.green}${S_STEP_SUBMIT}${c.reset}`, `Outcomes (${total})`, {
        spacing: 1,
      });
    },

    onOutcomeStart(outcome) {
      // Answer-change verifiers legitimately poll for minutes; show whose
      // completion window is burning.
      startTicker(tick(`${outcome.id} verifying`));
    },

    onOutcomeFinish(outcome, evaluation) {
      stopTicker();
      if (evaluation.skipped) {
        emit(
          `${c.yellow}${S_WARN}${c.reset}`,
          [
            `${outcome.id} ${c.dim}(blocked)${c.reset}`,
            `${c.dim}${truncate(evaluation.actual.split("\n")[0] ?? "", 200)}${c.reset}`,
          ].join("\n"),
        );
        return;
      }
      if (evaluation.passed) {
        emit(`${c.green}${S_SUCCESS}${c.reset}`, outcome.id);
      } else {
        emit(
          `${c.red}${S_ERROR}${c.reset}`,
          [
            outcome.id,
            `${c.dim}expected:${c.reset} ${truncate(evaluation.expected, 200)}`,
            `${c.dim}actual:${c.reset}   ${truncate(
              evaluation.actual.split("\n")[0] ?? "",
              200,
            )}`,
          ].join("\n"),
        );
      }
    },

    onRunEnd(result) {
      stopTicker();
      const passed = result.outcomes.filter(
        (o) => o.status === "passed",
      ).length;
      const total = result.outcomes.length;
      const dur = formatMs(result.durationMs);

      const banner =
        result.status === "passed"
          ? `${c.bold}${c.green}PASSED${c.reset}`
          : result.status === "failed"
            ? `${c.bold}${c.red}FAILED${c.reset}`
            : `${c.bold}${c.yellow}ERRORED${c.reset}`;

      outro(
        `${banner}  ${passed}/${total} outcomes  ${c.dim}${dur}${c.reset}`,
        {
          output,
          withGuide: guide,
        },
      );

      if (result.status !== "passed") {
        const failed = result.outcomes.filter((o) => o.status === "failed");
        if (failed.length > 0) {
          flat(`${c.dim}Failed outcomes:${c.reset}`);
          for (const o of failed) {
            flat(
              `  ${c.red}-${c.reset} ${o.id}${
                o.evidence ? `  ${c.dim}→ ${o.evidence}${c.reset}` : ""
              }`,
            );
          }
        }
      }

      flat(
        `${c.dim}Agent context:${c.reset} ${result.runDir}/${result.artifacts.agentContext}`,
      );
      printRerunHint(result, c, flat);
    },
  };
}

/**
 * Completion mark for the batch narration (run.ts): the same glyph family as
 * the tty renderer's clack marks, so `cairn run` speaks one visual language
 * in both the single and batch paths. `color: false` yields the bare glyph.
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

function printRerunHint(
  result: RunResult,
  c: Palette,
  write: (s: string) => void,
): void {
  write(
    `${c.dim}Reproduce:${c.reset}    cairn run ${result.spec.path} --env ${result.environment}`,
  );
}

const SPINNER_FRAMES = unicode
  ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  : ["|", "/", "-", "\\"];

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
 * Keep ordinary step errors to the existing 200-character terminal budget,
 * but make semantic-locator ambiguity actionable: preserve the header and the
 * first three matched elements' accessible role/name lines. The full error is
 * still available in run.json; this is only the bounded TTY rendering.
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
