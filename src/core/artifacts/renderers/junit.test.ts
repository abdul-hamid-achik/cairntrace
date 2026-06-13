import { describe, expect, it } from "vitest";
import type { RunResult } from "../../schema/run.v1";
import { renderJUnit } from "./junit";

describe("renderJUnit", () => {
  it("renders outcome statuses and XML-escapes metadata", () => {
    const result: RunResult = {
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: "run1",
      runDir: "/tmp/cairn&trace/run1",
      spec: { name: "checkout_flow", path: "/tmp/checkout.yml" },
      environment: "local",
      backend: "agent-browser",
      coldStart: true,
      status: "failed",
      startedAt: "2026-06-13T00:00:00.000Z",
      endedAt: "2026-06-13T00:00:01.000Z",
      durationMs: 1000,
      outcomes: [
        { id: "paid", status: "passed" },
        {
          id: "receipt",
          status: "failed",
          evidence: "outcomes/receipt.md",
        },
        {
          id: "email",
          status: "skipped",
          evidence: "outcomes/email.md",
        },
      ],
      steps: [],
      artifacts: {
        agentContext: "agent_context.md",
        events: "events.ndjson",
      },
      exitCode: 1,
    };

    const xml = renderJUnit([result]);
    expect(xml).toContain(
      '<testsuites tests="3" failures="1" errors="0" skipped="1" time="1.000">',
    );
    expect(xml).toContain(
      '<property name="runDir" value="/tmp/cairn&amp;trace/run1"/>',
    );
    expect(xml).toContain(
      '<failure message="failed: outcomes/receipt.md">failed: outcomes/receipt.md</failure>',
    );
    expect(xml).toContain('<skipped message="skipped: outcomes/email.md"/>');
  });

  it("renders a run-level error when no outcomes exist", () => {
    const result: RunResult = {
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: "run2",
      runDir: "/tmp/run2",
      spec: { name: "parse_error", path: "/tmp/missing.yml" },
      environment: "local",
      backend: "agent-browser",
      coldStart: false,
      status: "errored",
      startedAt: "2026-06-13T00:00:00.000Z",
      endedAt: "2026-06-13T00:00:00.000Z",
      durationMs: 0,
      outcomes: [],
      steps: [
        {
          id: "parse",
          status: "failed",
          durationMs: 0,
          error: "could not read <file>",
        },
      ],
      artifacts: {
        agentContext: "agent_context.md",
        events: "events.ndjson",
      },
      exitCode: 2,
    };

    const xml = renderJUnit([result]);
    expect(xml).toContain(
      '<testsuites tests="1" failures="0" errors="1" skipped="0" time="0.000">',
    );
    expect(xml).toContain(
      '<error message="could not read &lt;file&gt;">could not read &lt;file&gt;</error>',
    );
  });
});
