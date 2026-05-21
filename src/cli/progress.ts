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

/**
 * Build a TTY-aware progress listener for `cairn run`.
 * Returns `null` when the environment doesn't want progress (non-TTY or JSON/YAML mode).
 */
export function makeInteractiveListener(
  options: { color?: boolean } = {},
): ProgressListener {
  const c: Palette = options.color === false ? noColors : ANSI;
  const out = (s: string): void => {
    process.stdout.write(s);
  };

  let stepCount = 0;

  return {
    onRunStart(spec, runId, runDir) {
      out(
        `${c.bold}Running:${c.reset} ${c.cyan}${spec.name}${c.reset}  ${c.dim}(env=${spec.environment ?? "local"}, backend=${spec.backend ?? "agent-browser"})${c.reset}\n`,
      );
      out(`${c.dim}Run id:${c.reset} ${runId}\n`);
      out(`${c.dim}Run dir:${c.reset} ${runDir}\n\n`);
    },

    onStepStart(_idx, _step, stepId) {
      stepCount++;
      // Print start marker; the finish callback will overwrite this line.
      out(`  ${c.dim}▸ ${stepId}…${c.reset}`);
    },

    onStepFinish(_idx, stepId, status, durationMs, error) {
      // Clear and re-print the same line with the result.
      const mark =
        status === "passed"
          ? `${c.green}✓${c.reset}`
          : status === "failed"
            ? `${c.red}✗${c.reset}`
            : `${c.yellow}·${c.reset}`;
      const dur = `${c.dim}${formatMs(durationMs)}${c.reset}`;
      const tail =
        status === "skipped" ? ` ${c.dim}(skipped by when:)${c.reset}` : "";
      out(`\r${c.clearEOL}  ${mark} ${stepId} ${dur}${tail}`);
      if (status === "failed" && error) {
        out(`\n    ${c.red}${truncate(error, 200)}${c.reset}`);
      }
      out("\n");
    },

    onOutcomesStart(total) {
      if (stepCount > 0) out("\n");
      out(`${c.bold}Outcomes${c.reset} ${c.dim}(${total})${c.reset}\n`);
    },

    onOutcomeFinish(outcome, evaluation) {
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
  out: (s: string) => void,
): void {
  out(
    `${c.dim}Reproduce:${c.reset}    cairn run ${result.spec.path} --env ${result.environment}\n`,
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
