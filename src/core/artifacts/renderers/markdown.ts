import type { OutcomeResult, RunResult, StepResult } from "../../schema/run.v1";

/**
 * Human-readable markdown render of a RunResult. Same in-memory object as the
 * JSON output. Designed to be short enough to drop into an agent's chat context.
 */
export function renderRunMarkdown(r: RunResult): string {
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
    `Run dir: ${r.runDir}`,
    `Agent context: ${r.runDir}/${r.artifacts.agentContext}`,
  );

  return lines.join("\n") + "\n";
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
  return `- ${mark} ${s.id}${dur}${err}`;
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
