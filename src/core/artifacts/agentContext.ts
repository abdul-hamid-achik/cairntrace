import type { Spec } from "../schema/spec.v1";
import type { RunResult } from "../schema/run.v1";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifactRedactor } from "./redaction";

const CODE_MATCHES_START = "<!-- cairntrace:code-matches:start -->";
const CODE_MATCHES_END = "<!-- cairntrace:code-matches:end -->";

function codeMatchesLines(runDir: string): string[] {
  const investigatePath = join(runDir, "investigate.json");
  if (!existsSync(investigatePath)) return [];

  try {
    const inv = createArtifactRedactor(undefined).value(
      JSON.parse(readFileSync(investigatePath, "utf-8")),
    );
    const matches: Array<{
      file?: string;
      line?: number;
      score?: number;
    }> = inv?.codeMatches ?? [];
    if (matches.length === 0) return [];

    const lines = [
      CODE_MATCHES_START,
      "## Code Matches",
      "From `cairn investigate` — ranked `file:line` candidates responsible for the failure:",
      "",
    ];
    for (const match of matches) {
      const score =
        typeof match.score === "number"
          ? ` (score: ${match.score.toFixed(2)})`
          : "";
      lines.push(`- ${match.file ?? "(unknown)"}:${match.line ?? 0}${score}`);
    }
    lines.push(
      "",
      'Annotate these symbols with: `codemap annotate <symbol> --source cairntrace --note "<run-id> failed here"`',
      CODE_MATCHES_END,
    );
    return lines;
  } catch {
    return [];
  }
}

/**
 * Refresh only the generated code-match section after `cairn investigate`.
 * This preserves the original run narrative without needing to parse the
 * source spec again (which may have moved or require project config).
 */
export function refreshAgentContextCodeMatches(runDir: string): boolean {
  const contextPath = join(runDir, "agent_context.md");
  if (!existsSync(contextPath)) return false;

  const current = readFileSync(contextPath, "utf8");
  const markedSection = new RegExp(
    `\\n?${CODE_MATCHES_START}[\\s\\S]*?${CODE_MATCHES_END}\\n?`,
  );
  let base = current.replace(markedSection, "\n");

  // Compatibility with contexts rendered before the section markers existed.
  const legacyStart = base.indexOf("\n## Code Matches\n");
  if (legacyStart >= 0) base = base.slice(0, legacyStart);

  const lines = codeMatchesLines(runDir);
  const updated =
    lines.length > 0
      ? `${base.trimEnd()}\n\n${lines.join("\n")}\n`
      : `${base.trimEnd()}\n`;
  writeFileSync(contextPath, updated);
  return true;
}

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
  const preconditionFailure =
    result.failure?.phase === "precondition" ? result.failure : undefined;
  const emptyOutcomeLines =
    result.outcomes.length === 0
      ? [
          preconditionFailure
            ? `- · Not evaluated — precondition "${preconditionFailure.name ?? "unknown"}" ${
                preconditionFailure.timedOut ? "timed out" : "failed"
              }: ${preconditionFailure.message}`
            : `- · No outcomes were evaluated (run status: ${result.status}).`,
        ]
      : [];

  let suggestedNextStep: string;
  if (preconditionFailure) {
    suggestedNextStep = `- Fix precondition "${preconditionFailure.name ?? "unknown"}" before rerunning: ${preconditionFailure.message}`;
  } else if (result.status === "errored") {
    suggestedNextStep = `- The run errored before its contract completed${
      result.failure?.message ? `: ${result.failure.message}` : "."
    } Inspect events.ndjson and the captured diagnostics, then re-run.`;
  } else if (failed.length > 0) {
    suggestedNextStep =
      "- Read each failing outcome's evidence file (paths above). Each contains Expected/Actual/Source. Edit code, re-run.";
  } else if (skipped.length > 0) {
    suggestedNextStep =
      "- Blocked outcomes were never evaluated — fix the failed step first (see step results), then re-run.";
  } else if (result.status !== "passed") {
    suggestedNextStep = `- The run did not pass${
      result.failure?.message ? `: ${result.failure.message}` : "."
    } Inspect events.ndjson and the captured diagnostics, then re-run.`;
  } else if (result.outcomes.length === 0) {
    suggestedNextStep =
      "- No outcomes were evaluated; add or restore contract outcomes before treating this run as evidence.";
  } else {
    suggestedNextStep =
      "- All outcomes passed. If you arrived here from a bug report, double-check that the failing scenario is captured by an outcome.";
  }

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
  if (result.artifacts.services)
    evidenceRefs.push(`- ${result.artifacts.services}`);
  if (result.artifacts.downloads) {
    for (const [name, path] of Object.entries(result.artifacts.downloads))
      evidenceRefs.push(`- ${name}: ${path}`);
  }
  if (result.artifacts.transforms) {
    for (const [name, path] of Object.entries(result.artifacts.transforms))
      evidenceRefs.push(`- ${name}: ${path}`);
  }
  if (result.artifacts.evals) {
    for (const [name, path] of Object.entries(result.artifacts.evals))
      evidenceRefs.push(`- ${name}: ${path}`);
  }
  if (result.artifacts.trace) evidenceRefs.push(`- ${result.artifacts.trace}`);
  if (result.artifacts.video) evidenceRefs.push(`- ${result.artifacts.video}`);
  if (result.artifacts.clips) {
    for (const [name, path] of Object.entries(result.artifacts.clips))
      evidenceRefs.push(`- clip "${name}": ${path}`);
  }

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
    ...emptyOutcomeLines,
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

  // Video hint — .webm files can be opened directly or fed to vidtrace for
  // timestamped evidence extraction.
  if (result.artifacts.video) {
    lines.push(
      "",
      "## View the video",
      "```bash",
      `open ${result.runDir}/${result.artifacts.video}`,
      "# or extract evidence with vidtrace:",
      `vidtrace extract ${result.runDir}/${result.artifacts.video} --json`,
      "```",
    );
  }

  lines.push(
    "",
    "## Suggested next steps",
    suggestedNextStep,
    "- If steps failed because of UI drift rather than a real regression, run: cairn spec heal " +
      `${result.spec.path}`,
  );

  const matches = codeMatchesLines(result.runDir);
  if (matches.length > 0) lines.push("", ...matches);

  return lines.join("\n") + "\n";
}
