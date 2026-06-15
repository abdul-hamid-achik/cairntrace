import { describe, expect, it } from "vitest";
import type { RunResult } from "../../schema/run.v1";
import { buildReportModel, renderReportHtml, renderReportJson } from "./report";

describe("report renderer", () => {
  it("builds a structured report model with summary counts and artifact links", () => {
    const model = buildReportModel(sampleRun(), {
      generatedAt: "2026-06-15T12:00:00.000Z",
    });

    expect(model.generatedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(model.summary.outcomes).toMatchObject({
      passed: 1,
      failed: 1,
      skipped: 1,
      total: 3,
    });
    expect(model.summary.steps).toMatchObject({
      passed: 1,
      failed: 1,
      skipped: 0,
      total: 2,
    });
    expect(model.artifactLinks.map((link) => link.path)).toContain(
      "report.html",
    );
    expect(model.artifactLinks.map((link) => link.path)).toContain(
      "outcomes/login.raw.json",
    );
  });

  it("renders printable HTML with escaped run content", () => {
    const run = sampleRun({
      specName: "<script>alert(1)</script>",
      stepError: "<img src=x onerror=alert(1)>",
    });
    const model = buildReportModel(run, {
      generatedAt: "2026-06-15T12:00:00.000Z",
    });

    const html = renderReportHtml(model);

    expect(html).toContain("Print / Save PDF");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("applies selected theme and color overrides to HTML and theme metadata", () => {
    const model = buildReportModel(sampleRun(), {
      generatedAt: "2026-06-15T12:00:00.000Z",
      config: {
        theme: "midnight",
        colors: {
          accent: "#ff00aa",
          surface: "rgb(10, 20, 30)",
        },
      },
    });

    const html = renderReportHtml(model);
    const reportJson = JSON.parse(renderReportJson(model));

    expect(model.theme.selected).toBe("midnight");
    expect(html).toContain('data-theme="midnight"');
    expect(html).toContain("--accent: #ff00aa;");
    expect(html).toContain("--surface: rgb(10, 20, 30);");
    expect(reportJson.theme.tokens.accent).toBe("#ff00aa");
    expect(reportJson.theme.available.cairn.label).toBe("Cairn");
    expect(reportJson.theme.tokens.surface).toBe("rgb(10, 20, 30)");
  });

  it("ignores unsafe color overrides when rendering directly", () => {
    const model = buildReportModel(sampleRun(), {
      generatedAt: "2026-06-15T12:00:00.000Z",
      config: {
        colors: {
          accent: "red; background: url(javascript:alert(1))",
        },
      },
    });

    const html = renderReportHtml(model);

    expect(model.theme.tokens.accent).toBe("#0f766e");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("red; background");
  });
});

function sampleRun(
  overrides: { specName?: string; stepError?: string } = {},
): RunResult {
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId: "checkout-2026-06-15T120000Z",
    runDir: "/tmp/cairntrace/checkout-2026-06-15T120000Z",
    spec: {
      name: overrides.specName ?? "checkout",
      path: "/repo/flows/checkout.yml",
    },
    environment: "local",
    backend: "agent-browser",
    coldStart: true,
    status: "failed",
    startedAt: "2026-06-15T12:00:00.000Z",
    endedAt: "2026-06-15T12:00:02.500Z",
    durationMs: 2500,
    outcomes: [
      {
        id: "landing",
        status: "passed",
        evidence: "outcomes/landing.md",
      },
      {
        id: "login",
        status: "failed",
        evidence: "outcomes/login.md",
        evidenceRaw: "outcomes/login.raw.json",
      },
      {
        id: "receipt",
        status: "skipped",
        evidence: "outcomes/receipt.md",
      },
    ],
    steps: [
      {
        id: "open",
        status: "passed",
        durationMs: 500,
      },
      {
        id: "submit",
        status: "failed",
        durationMs: 2000,
        error: overrides.stepError ?? "button not found",
        resolved: {
          role: "button",
          name: "Submit",
          ref: "@e12",
        },
      },
    ],
    artifacts: {
      report: "report.html",
      reportJson: "report.json",
      agentContext: "agent_context.md",
      events: "events.ndjson",
      screenshots: ["screenshots/step_submit.png"],
      snapshots: ["snapshots/step_submit.json"],
      diagnostics: ["diagnostics/step_submit.json"],
      console: "console/errors.ndjson",
      network: "network/failed_requests.ndjson",
    },
    exitCode: 1,
  };
}
