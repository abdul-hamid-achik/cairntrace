import { describe, expect, it } from "vitest";
import type { RunResult } from "../../schema/run.v1";
import { renderRunMarkdown } from "./markdown";

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId: "2026-10-03T00-00-00-000Z_green_abc123",
    spec: {
      name: "green",
      path: "/p/flows/green.yml",
      contractHash: "sha256:x",
    },
    environment: "local",
    backend: "mock",
    coldStart: false,
    status: "passed",
    exitCode: 0,
    startedAt: "2026-10-03T00:00:00.000Z",
    durationMs: 12,
    runDir: "/p/runs/green",
    outcomes: [{ id: "home", status: "passed", evidence: "outcomes/home.md" }],
    steps: [],
    artifacts: { agentContext: "agent_context.md" },
    summary: "passed",
    ...overrides,
  } as RunResult;
}

describe("renderRunMarkdown", () => {
  it("says why a passed spec reads ERRORED after a critical teardown failed (exit 8)", () => {
    const md = renderRunMarkdown(
      run({
        status: "errored",
        exitCode: 8,
        failure: {
          phase: "invocation",
          message: "critical teardown failed: services.teardown[0] exit 3",
        },
        invocationOutcome: {
          exitCode: 8,
          specsExitCode: 0,
          error: "critical teardown failed: services.teardown[0] exit 3",
        },
      }),
    );
    expect(md).toContain("# Run: green — ERRORED");
    expect(md).toContain("- ✓ home");
    expect(md).toContain(
      "- reason: critical teardown failed: services.teardown[0] exit 3",
    );
    // The same text is not repeated on the invocation line.
    expect(md).toContain("- invocation: exit 8 (the specs alone: exit 0)\n");
  });

  it("names a failed run's reason, one line, and keeps a passed run unchanged", () => {
    const failed = renderRunMarkdown(
      run({
        status: "failed",
        exitCode: 1,
        failure: { message: "outcome home:\n  url did not match /home" },
      }),
    );
    expect(failed).toContain("- reason: outcome home: url did not match /home");
    const passed = renderRunMarkdown(run());
    expect(passed).not.toContain("- reason:");
    expect(passed).not.toContain("- invocation:");
  });

  it("shows a signal's 130 that ended cairn before the verdict", () => {
    const md = renderRunMarkdown(
      run({
        invocationOutcome: {
          exitCode: 130,
          specsExitCode: 0,
          error: "interrupted by SIGINT before the invocation settled",
        },
      }),
    );
    expect(md).toContain("# Run: green — PASSED");
    expect(md).toContain(
      "- invocation: exit 130 (the specs alone: exit 0) — interrupted by SIGINT before the invocation settled",
    );
  });
});
