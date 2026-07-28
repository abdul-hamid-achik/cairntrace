import type { ProgressListener } from "../core/runner/Runner";
import type { RunResult } from "../core/schema/run.v1";

/* ----- ANSI helpers ----- */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  /** clear from cursor to end of line */
  clearEOL: "\x1b[K",
};

const noColors = {
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

interface Palette {
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

/**
 * True when the output supports ANSI escape codes (real TTY, not a pipe).
 * `CAIRN_FORCE_TTY=1` overrides for use in headless test harnesses where you
 * still want to see the progressive output.
 */
export function isInteractive(): boolean {
  if (process.env.CAIRN_FORCE_TTY === "1") return true;
  return Boolean(process.stdout.isTTY);
}

export type ProgressMode = "tty" | "plain";

/**
 * Rendering mode is its own axis, not a side effect of TTY detection: `tty`
 * is the cursor-redraw renderer (spinner, overwritten lines), `plain` is a
 * designed sequential renderer (timestamped milestone lines, no control
 * codes) that is safe to pipe, tee, and diff — not "tty minus colors".
 * `auto` (the default) picks by stdout, exactly like docker --progress.
 */
export function resolveProgressMode(flag?: string): ProgressMode {
  const requested = flag ?? process.env.CAIRN_PROGRESS;
  if (requested === "tty" || requested === "plain") return requested;
  if (requested !== undefined && requested !== "auto") {
    throw new Error(`--progress expects auto|tty|plain, got "${requested}"`);
  }
  // CAIRN_FORCE_TTY predates --progress; honour it as an explicit tty vote.
  if (process.env.CAIRN_FORCE_TTY === "1") return "tty";
  return process.stdout.isTTY ? "tty" : "plain";
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
    onPreconditionFinish(name, exitCode, durationMs) {
      line(
        `precondition ${name} ${
          exitCode === 0 ? "ok" : `failed (exit ${exitCode})`
        } ${formatMs(durationMs)}`,
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
 * Returns `null` when the environment doesn't want progress (non-TTY or JSON/YAML mode).
 */
export function makeInteractiveListener(
  options: { color?: boolean } = {},
): ProgressListener {
  const c: Palette = options.color === false ? noColors : ANSI;

  let stepCount = 0;
  // The when: gate of the step currently in flight, for the skip line.
  let currentWhen: string | undefined;

  // Live line ticker: while a step, precondition, or verifier poll is in
  // flight, redraw its marker line with a spinner frame and elapsed time so
  // a many-minute wait reads as "working, bounded" instead of "dead". Frames
  // animate only on a real TTY — under CAIRN_FORCE_TTY into a pipe every
  // redraw would land as a new log line, so those get the static marker.
  const animate = Boolean(process.stderr.isTTY);
  let ticker: ReturnType<typeof setInterval> | undefined;
  let tickerRender: ((frame: string, elapsed: string) => string) | undefined;
  let tickerStart = 0;
  let frameIdx = 0;

  function startTicker(render: (frame: string, elapsed: string) => string) {
    stopTicker();
    tickerRender = render;
    tickerStart = Date.now();
    frameIdx = 0;
    out(render(SPINNER_FRAMES[0]!, ""));
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
    }
    tickerRender = undefined;
  }

  return {
    onRunStart(spec, runId, runDir, backendName, environment) {
      out(
        `${c.bold}Running:${c.reset} ${c.cyan}${spec.name}${c.reset}  ${c.dim}(env=${environment}, backend=${backendName})${c.reset}\n`,
      );
      out(`${c.dim}Run id:${c.reset} ${runId}\n`);
      out(`${c.dim}Run dir:${c.reset} ${runDir}\n\n`);
    },

    onPreconditionStart(name, timeoutMs) {
      // A quiesce-style precondition can legitimately block for many minutes.
      startTicker(
        (frame, elapsed) =>
          `  ${c.dim}${frame} precondition ${name} ${
            elapsed ? `${elapsed} / ` : ""
          }budget ${formatMs(timeoutMs)}…${c.reset}`,
      );
    },

    onPreconditionFinish(name, exitCode, durationMs) {
      stopTicker();
      const mark =
        exitCode === 0 ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      out(
        `\r${c.clearEOL}  ${mark} precondition ${name} ${c.dim}${formatMs(durationMs)}${c.reset}\n`,
      );
    },

    onStepStart(_idx, step, stepId) {
      stepCount++;
      currentWhen = "when" in step ? step.when : undefined;
      startTicker(
        (frame, elapsed) =>
          `  ${c.dim}${frame} ${stepId}${
            elapsed ? ` ${elapsed}` : ""
          }…${c.reset}`,
      );
    },

    onStepFinish(_idx, stepId, status, durationMs, error) {
      stopTicker();
      // Clear and re-print the same line with the result.
      const mark =
        status === "passed"
          ? `${c.green}✓${c.reset}`
          : status === "failed"
            ? `${c.red}✗${c.reset}`
            : `${c.yellow}·${c.reset}`;
      const dur = `${c.dim}${formatMs(durationMs)}${c.reset}`;
      // Say WHICH gate skipped the step: "(skipped by when:)" read as a
      // rendering glitch, not as the conditional doing its job.
      const tail =
        status === "skipped"
          ? ` ${c.dim}(skipped — when ${
              currentWhen ? `"${currentWhen}"` : "condition"
            } not met)${c.reset}`
          : "";
      out(`\r${c.clearEOL}  ${mark} ${stepId} ${dur}${tail}`);
      if (status === "failed" && error) {
        for (const line of summarizeStepError(error)) {
          out(`\n    ${c.red}${line}${c.reset}`);
        }
      }
      out("\n");
    },

    onOutcomesStart(total) {
      stopTicker();
      if (stepCount > 0) out("\n");
      out(`${c.bold}Outcomes${c.reset} ${c.dim}(${total})${c.reset}\n`);
    },

    onOutcomeStart(outcome) {
      // Answer-change verifiers legitimately poll for minutes; show whose
      // completion window is burning.
      startTicker(
        (frame, elapsed) =>
          `  ${c.dim}${frame} ${outcome.id} verifying${
            elapsed ? ` ${elapsed}` : ""
          }…${c.reset}`,
      );
    },

    onOutcomeFinish(outcome, evaluation) {
      stopTicker();
      out(`\r${c.clearEOL}`);
      if (evaluation.skipped) {
        out(
          `  ${c.yellow}·${c.reset} ${outcome.id} ${c.dim}(blocked)${c.reset}\n`,
        );
        out(
          `    ${c.dim}${truncate(evaluation.actual.split("\n")[0] ?? "", 200)}${c.reset}\n`,
        );
        return;
      }
      const mark = evaluation.passed
        ? `${c.green}✓${c.reset}`
        : `${c.red}✗${c.reset}`;
      out(`  ${mark} ${outcome.id}\n`);
      if (!evaluation.passed) {
        out(
          `    ${c.dim}expected:${c.reset} ${truncate(evaluation.expected, 200)}\n`,
        );
        out(
          `    ${c.dim}actual:${c.reset}   ${truncate(evaluation.actual.split("\n")[0] ?? "", 200)}\n`,
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
          ? `${c.bold}${c.green}✓ PASSED${c.reset}`
          : result.status === "failed"
            ? `${c.bold}${c.red}✗ FAILED${c.reset}`
            : `${c.bold}${c.yellow}· ERRORED${c.reset}`;

      out(
        `\n${banner}  ${passed}/${total} outcomes  ${c.dim}${dur}${c.reset}\n`,
      );

      if (result.status !== "passed") {
        const failed = result.outcomes.filter((o) => o.status === "failed");
        if (failed.length > 0) {
          out(`\n${c.dim}Failed outcomes:${c.reset}\n`);
          for (const o of failed) {
            out(
              `  ${c.red}-${c.reset} ${o.id}${
                o.evidence ? `  ${c.dim}→ ${o.evidence}${c.reset}` : ""
              }\n`,
            );
          }
        }
      }

      out(
        `\n${c.dim}Agent context:${c.reset} ${result.runDir}/${result.artifacts.agentContext}\n`,
      );
      printRerunHint(result, c, out);
    },
  };
}

function printRerunHint(
  result: RunResult,
  c: Palette,
  write: (s: string) => void,
): void {
  write(
    `${c.dim}Reproduce:${c.reset}    cairn run ${result.spec.path} --env ${result.environment}\n`,
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
