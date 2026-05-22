import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../schema/run.v1";
import type { Spec } from "../schema/spec.v1";
import { renderAgentContext } from "./agentContext";
import { renderEvidenceMarkdown, type EvidenceInput } from "./evidence";
import { renderJson } from "./renderers/json";
import { renderRunMarkdown } from "./renderers/markdown";
import { renderYaml } from "./renderers/yaml";

/**
 * Event emitted to events.ndjson during a run. Append-only.
 */
export interface RunEvent {
  ts: string;
  type:
    | "run.started"
    | "run.failed"
    | "run.passed"
    | "run.errored"
    | "step.started"
    | "step.finished"
    | "step.failed"
    | "outcome.passed"
    | "outcome.failed"
    | "artifact.screenshot"
    | "artifact.snapshot"
    | "artifact.download"
    | "artifact.diagnostics";
  [extra: string]: unknown;
}

/**
 * Writes artifacts to the per-run directory.
 *
 * Path convention:
 *   runDir/                            (absolute; created lazily)
 *   ├── run.json | run.yaml | run.md
 *   ├── events.ndjson
 *   ├── agent_context.md
 *   ├── screenshots/                   (created on first capture)
 *   ├── snapshots/
 *   └── outcomes/
 *       ├── results.json | .yaml | .md
 *       ├── <outcomeId>.md
 *       └── <outcomeId>.raw.json       (only for `script` verifier with raw data)
 */
export class ArtifactWriter {
  constructor(public readonly runDir: string) {}

  async ensureDirs(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await mkdir(join(this.runDir, "screenshots"), { recursive: true });
    await mkdir(join(this.runDir, "snapshots"), { recursive: true });
    await mkdir(join(this.runDir, "downloads"), { recursive: true });
    await mkdir(join(this.runDir, "diagnostics"), { recursive: true });
    await mkdir(join(this.runDir, "outcomes"), { recursive: true });
  }

  resolve(relative: string): string {
    return join(this.runDir, relative);
  }

  async writeRun(result: RunResult): Promise<void> {
    await writeFile(this.resolve("run.json"), renderJson(result));
    await writeFile(this.resolve("run.yaml"), renderYaml(result));
    await writeFile(this.resolve("run.md"), renderRunMarkdown(result));
  }

  async writeOutcomesIndex(result: RunResult): Promise<void> {
    const summary = {
      runId: result.runId,
      status: result.status,
      outcomes: result.outcomes,
    };
    await writeFile(this.resolve("outcomes/results.json"), renderJson(summary));
    await writeFile(this.resolve("outcomes/results.yaml"), renderYaml(summary));
    const md =
      [
        `# Outcomes — ${result.status}`,
        `Run: ${result.runId}`,
        "",
        ...result.outcomes.map((o) => {
          const mark =
            o.status === "passed" ? "✓" : o.status === "failed" ? "✗" : "·";
          return `- ${mark} ${o.id}${o.evidence ? ` → ${o.evidence}` : ""}`;
        }),
      ].join("\n") + "\n";
    await writeFile(this.resolve("outcomes/results.md"), md);
  }

  async writeOutcomeEvidence(evidence: EvidenceInput): Promise<void> {
    const md = renderEvidenceMarkdown(evidence);
    await writeFile(this.resolve(`outcomes/${evidence.outcomeId}.md`), md);
    if (evidence.raw !== undefined) {
      await writeFile(
        this.resolve(`outcomes/${evidence.outcomeId}.raw.json`),
        renderJson(evidence.raw),
      );
    }
  }

  async writeAgentContext(spec: Spec, result: RunResult): Promise<void> {
    await writeFile(
      this.resolve("agent_context.md"),
      renderAgentContext(spec, result),
    );
  }

  async appendEvent(event: RunEvent): Promise<void> {
    await appendFile(
      this.resolve("events.ndjson"),
      JSON.stringify(event) + "\n",
    );
  }

  /** Used by the runner to write a resolved snapshot of the spec for this run. */
  async writeResolvedSpec(spec: Spec): Promise<void> {
    await writeFile(this.resolve("spec.resolved.yml"), renderYaml(spec));
  }
}
