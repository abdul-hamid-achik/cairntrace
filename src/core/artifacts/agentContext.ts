import type { Spec } from "../schema/spec.v1";
import type { RunResult } from "../schema/run.v1";

/**
 * Render the agent-neutral run context (plan §13 `agent_context.md`).
 * No agent-specific phrasing — any agent that can read markdown can use this.
 */
export function renderAgentContext(spec: Spec, result: RunResult): string {
  const passed = result.outcomes.filter((o) => o.status === "passed");
  const failed = result.outcomes.filter((o) => o.status === "failed");
  const skipped = result.outcomes.filter((o) => o.status === "skipped");
  const lastSuccessfulStep = result.steps
    .toReversed()
    .find((s) => s.status === "passed");

  const failureLines = failed.map(
    (o) => `- ✗ ${o.id}${o.evidence ? ` — see ${o.evidence}` : ""}`,
  );
  const passLines = passed.map((o) => `- ✓ ${o.id}`);
  const skippedLines = skipped.map(
    (o) =>
      `- · ${o.id} — blocked by a failed step${
        o.evidence ? `, see ${o.evidence}` : ""
      }`,
  );

  const evidenceRefs: string[] = [];
  for (const o of failed) {
    if (o.evidence) evidenceRefs.push(`- ${o.evidence}`);
    if (o.evidenceRaw) evidenceRefs.push(`- ${o.evidenceRaw}`);
  }
  if (result.artifacts.network)
    evidenceRefs.push(`- ${result.artifacts.network}`);
  if (result.artifacts.console)
    evidenceRefs.push(`- ${result.artifacts.console}`);
  if (result.artifacts.diagnostics) {
    for (const path of result.artifacts.diagnostics)
      evidenceRefs.push(`- ${path}`);
  }
  if (result.artifacts.downloads) {
    for (const [name, path] of Object.entries(result.artifacts.downloads))
      evidenceRefs.push(`- ${name}: ${path}`);
  }
  if (result.artifacts.transforms) {
    for (const [name, path] of Object.entries(result.artifacts.transforms))
      evidenceRefs.push(`- ${name}: ${path}`);
  }
  if (result.artifacts.trace) evidenceRefs.push(`- ${result.artifacts.trace}`);

  const lines: string[] = [
    "# Cairntrace Run Context",
    "",
    "## Run",
    `- spec: ${spec.name}`,
    `- env: ${result.environment}`,
    `- backend: ${result.backend}`,
    `- status: ${result.status}`,
    `- cold start: ${result.coldStart ? "yes" : "no"}`,
    `- run id: ${result.runId}`,
    "",
    "## Intent",
    spec.intent.trim(),
    "",
    "## Outcome results",
    ...passLines,
    ...failureLines,
    ...skippedLines,
  ];

  if (lastSuccessfulStep) {
    lines.push(
      "",
      "## Last successful step",
      `- step: ${lastSuccessfulStep.id}`,
      `- duration: ${lastSuccessfulStep.durationMs}ms`,
    );
  }

  if (evidenceRefs.length > 0) {
    const heading =
      failed.length > 0 ? "## Failure evidence" : "## Captured artifacts";
    lines.push("", heading, ...evidenceRefs);
  }

  lines.push(
    "",
    "## Reproduce",
    "```bash",
    `cairn run ${result.spec.path} --env ${result.environment} --headed`,
    "```",
  );

  // Trace viewer hint — Playwright traces are viewable directly; agent-browser
  // traces ship as a .zip in the same Trace Viewer format.
  if (result.artifacts.trace) {
    lines.push(
      "",
      "## View the trace",
      "```bash",
      `bunx playwright show-trace ${result.runDir}/${result.artifacts.trace}`,
      "```",
    );
  }

  lines.push(
    "",
    "## Suggested next steps",
    failed.length > 0
      ? "- Read each failing outcome's evidence file (paths above). Each contains Expected/Actual/Source. Edit code, re-run."
      : skipped.length > 0
        ? "- Blocked outcomes were never evaluated — fix the failed step first (see step results), then re-run."
        : "- All outcomes passed. If you arrived here from a bug report, double-check that the failing scenario is captured by an outcome.",
    "- If steps failed because of UI drift rather than a real regression, run: cairn spec heal " +
      `${result.spec.path}`,
  );

  return lines.join("\n") + "\n";
}
