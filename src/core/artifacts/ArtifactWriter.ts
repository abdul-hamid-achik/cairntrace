import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportConfig } from "../schema/config.v1";
import type { RunResult } from "../schema/run.v1";
import type { Spec } from "../schema/spec.v1";
import { renderAgentContext } from "./agentContext";
import { renderEvidenceMarkdown, type EvidenceInput } from "./evidence";
import { renderJson } from "./renderers/json";
import { renderRunMarkdown } from "./renderers/markdown";
import {
  buildReportModel,
  renderReportHtml,
  renderReportJson,
} from "./renderers/report";
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
    | "outcome.skipped"
    | "artifact.screenshot"
    | "artifact.snapshot"
    | "artifact.download"
    | "artifact.transform"
    | "artifact.diagnostics"
    | "artifact.clip"
    | "artifact.request"
    | "artifact.eval"
    | "artifact.monitor"
    | "artifact.video"
    | "viewport.set"
    | "services.docker.start"
    | "services.docker.reuse"
    | "services.docker.ready"
    | "services.docker.fail"
    | "services.docker.healthcheck"
    | "services.seed.start"
    | "services.seed.skip"
    | "services.seed.complete"
    | "services.seed.fail"
    | "services.tmux.session-created"
    | "services.tmux.reuse"
    | "services.tmux.ready"
    | "services.teardown.complete"
    | "services.stash.complete";
  [extra: string]: unknown;
}

export interface ArtifactRedactor {
  value<T>(input: T): T;
  text(input: string): string;
}

export interface ArtifactWriterOptions {
  report?: ReportConfig;
}

const IDENTITY_REDACTOR: ArtifactRedactor = {
  value: <T>(input: T) => input,
  text: (input: string) => input,
};

/**
 * Writes artifacts to the per-run directory.
 *
 * Path convention:
 *   runDir/                            (absolute; created lazily)
 *   ├── run.json | run.yaml | run.md
 *   ├── report.html | report.json
 *   ├── events.ndjson
 *   ├── agent_context.md
 *   ├── screenshots/                   (created on first capture)
 *   ├── snapshots/
 *   ├── videos/                        (when video capture is enabled)
 *   └── outcomes/
 *       ├── results.json | .yaml | .md
 *       ├── <outcomeId>.md
 *       └── <outcomeId>.raw.json       (when a verifier emits raw data)
 */
export class ArtifactWriter {
  constructor(
    public readonly runDir: string,
    private readonly redactor: ArtifactRedactor = IDENTITY_REDACTOR,
    private readonly opts: ArtifactWriterOptions = {},
  ) {}

  async ensureDirs(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await mkdir(join(this.runDir, "screenshots"), { recursive: true });
    await mkdir(join(this.runDir, "snapshots"), { recursive: true });
    await mkdir(join(this.runDir, "videos"), { recursive: true });
    await mkdir(join(this.runDir, "videos", "clips"), { recursive: true });
    await mkdir(join(this.runDir, "downloads"), { recursive: true });
    await mkdir(join(this.runDir, "transforms"), { recursive: true });
    await mkdir(join(this.runDir, "evals"), { recursive: true });
    await mkdir(join(this.runDir, "diagnostics"), { recursive: true });
    await mkdir(join(this.runDir, "outcomes"), { recursive: true });
  }

  resolve(relative: string): string {
    return join(this.runDir, relative);
  }

  async writeRun(result: RunResult): Promise<void> {
    const redacted = this.redactor.value(result);
    await writeFile(this.resolve("run.json"), renderJson(redacted));
    await writeFile(this.resolve("run.yaml"), renderYaml(redacted));
    await writeFile(
      this.resolve("run.md"),
      this.redactor.text(renderRunMarkdown(redacted)),
    );

    const report = this.redactor.value(
      buildReportModel(redacted, { config: this.opts.report }),
    );
    await writeFile(this.resolve("report.json"), renderReportJson(report));
    await writeFile(
      this.resolve("report.html"),
      this.redactor.text(renderReportHtml(report)),
    );
  }

  async writeOutcomesIndex(result: RunResult): Promise<void> {
    const summary = {
      runId: result.runId,
      status: result.status,
      outcomes: result.outcomes,
    };
    await writeFile(
      this.resolve("outcomes/results.json"),
      renderJson(this.redactor.value(summary)),
    );
    await writeFile(
      this.resolve("outcomes/results.yaml"),
      renderYaml(this.redactor.value(summary)),
    );
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
    await writeFile(
      this.resolve("outcomes/results.md"),
      this.redactor.text(md),
    );
  }

  async writeOutcomeEvidence(evidence: EvidenceInput): Promise<void> {
    const redacted = this.redactor.value(evidence);
    const md = renderEvidenceMarkdown(redacted);
    await writeFile(this.resolve(`outcomes/${evidence.outcomeId}.md`), md);
    if (redacted.raw !== undefined) {
      await writeFile(
        this.resolve(`outcomes/${evidence.outcomeId}.raw.json`),
        renderJson(redacted.raw),
      );
    }
  }

  async writeAgentContext(spec: Spec, result: RunResult): Promise<void> {
    await writeFile(
      this.resolve("agent_context.md"),
      this.redactor.text(renderAgentContext(spec, result)),
    );
  }

  async appendEvent(event: RunEvent): Promise<void> {
    await appendFile(
      this.resolve("events.ndjson"),
      JSON.stringify(this.redactor.value(event)) + "\n",
    );
  }

  /**
   * Write services lifecycle events (from startServices) to events.ndjson.
   * Each ServicesEvent is mapped to a `services.<phase>.<event>` RunEvent.
   */
  async appendServicesEvents(
    events: Array<{
      phase: string;
      event: string;
      message: string;
      timestamp: string;
      data?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    for (const e of events) {
      const type = `services.${e.phase}.${e.event}` as RunEvent["type"];
      await appendFile(
        this.resolve("events.ndjson"),
        JSON.stringify(
          this.redactor.value({
            ts: e.timestamp,
            type,
            message: e.message,
            ...(e.data ? { data: e.data } : {}),
          }),
        ) + "\n",
      );
    }
  }

  /** Used by the runner to write a resolved snapshot of the spec for this run. */
  async writeResolvedSpec(spec: Spec): Promise<void> {
    await writeFile(
      this.resolve("spec.resolved.yml"),
      renderYaml(this.redactor.value(spec)),
    );
  }
}
