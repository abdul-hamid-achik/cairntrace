import type { OutcomeResult, RunResult, StepResult } from "../../schema/run.v1";
import { stepResultLabel } from "../stepLabel";

/**
 * Human-readable markdown render of a RunResult. Same in-memory object as the
 * JSON output. Designed to be short enough to drop into an agent's chat context.
 */
export function renderRunMarkdown(r: RunResult): string {
  if (r.status === "refused") return renderRefusedMarkdown(r);
  const statusBadge =
    r.status === "passed"
      ? "PASSED"
      : r.status === "failed"
        ? "FAILED"
        : "ERRORED";
  const passed = r.outcomes.filter((o) => o.status === "passed").length;
  const total = r.outcomes.length;

  const lines: string[] = [
    `# Run: ${r.spec.name} — ${statusBadge}`,
    "",
    `- env: ${r.environment} | backend: ${r.backend} | cold-start: ${
      r.coldStart ? "yes" : "no"
    }`,
    `- duration: ${formatDuration(r.durationMs)} | outcomes: ${passed}/${total} passed`,
    `- run id: ${r.runId}`,
    ...reasonLines(r),
    "",
    "## Outcomes",
    ...r.outcomes.map(renderOutcomeLine),
  ];

  if (r.steps.length > 0) {
    lines.push("", "## Steps", ...r.steps.map(renderStepLine));
  }

  lines.push(
    "",
    "## Reproduce",
    "```bash",
    `cairn run ${r.spec.path} --env ${r.environment}`,
    "```",
    "",
    // A synthesized result (errored or cancelled before its run started)
    // has a placeholder runDir: never point an agent at it.
    ...(r.synthetic
      ? ["Run dir: none — the run never started"]
      : [
          `Run dir: ${r.runDir}`,
          `Agent context: ${r.runDir}/${r.artifacts.agentContext}`,
        ]),
  );

  return lines.join("\n") + "\n";
}

/**
 * Why a run that did not pass did not: `failure.message`, and the
 * invocation's verdict when it is not the specs' own (exit 8 / 9 after a
 * passed spec, or a signal). Without these an ERRORED run whose every
 * outcome and step passed says nothing about why.
 */
function reasonLines(r: RunResult): string[] {
  const lines: string[] = [];
  const reason = r.status !== "passed" ? r.failure?.message : undefined;
  if (reason) lines.push(`- reason: ${truncate(oneLine(reason), 300)}`);
  const outcome = r.invocationOutcome;
  if (outcome && outcome.exitCode !== outcome.specsExitCode) {
    const why =
      outcome.error && outcome.error !== reason
        ? ` — ${truncate(oneLine(outcome.error), 300)}`
        : "";
    lines.push(
      `- invocation: exit ${outcome.exitCode} (the specs alone: exit ${outcome.specsExitCode})${why}`,
    );
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A spec the environment policy refused: nothing ran, no run directory. */
function renderRefusedMarkdown(r: RunResult): string {
  return [
    `# Run: ${r.spec.name} — REFUSED`,
    "",
    `- env: ${r.environment} | nothing ran (no services, preconditions or browser; no run directory)`,
    `- reason: ${r.refusal?.reason ?? r.failure?.message ?? "refused"}`,
    "",
    "## Where it may run",
    "```bash",
    `cairn spec verify ${r.spec.path} --format md`,
    "```",
    "",
  ].join("\n");
}

function renderOutcomeLine(o: OutcomeResult): string {
  const mark = o.status === "passed" ? "✓" : o.status === "failed" ? "✗" : "·";
  const tail = o.evidence ? ` → ${o.evidence}` : "";
  return `- ${mark} ${o.id}${tail}`;
}

function renderStepLine(s: StepResult): string {
  const mark = s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : "·";
  const dur = ` (${formatDuration(s.durationMs)})`;
  const err = s.error ? ` — ${truncate(s.error, 120)}` : "";
  return `- ${mark} ${stepResultLabel(s)}${dur}${err}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem}s`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
