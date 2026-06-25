import { describe, expect, it } from "vitest";
import { isCodemapAvailable, maybeAutoAnnotateRun } from "./annotate.js";
import { isTvaultAvailable } from "./secrets.js";
import type { RunResult } from "../../core/schema/run.v1.js";

describe("annotate module", () => {
  it("isCodemapAvailable returns a boolean", async () => {
    expect(typeof (await isCodemapAvailable())).toBe("boolean");
  });
});

describe("secrets module", () => {
  it("isTvaultAvailable returns a boolean", async () => {
    expect(typeof (await isTvaultAvailable())).toBe("boolean");
  });
});

/* ---------------------------------------------------------------------------
 * maybeAutoAnnotateRun — per-run (pass + fail) annotation
 * ------------------------------------------------------------------------- */

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId: "test-run-001",
    runDir: "/tmp/fake-run-dir",
    spec: {
      name: "login_flow",
      path: "/tmp/login_flow.yml",
      contractHash: "abc123",
    },
    environment: "local",
    backend: "agent-browser",
    coldStart: false,
    status: "failed",
    startedAt: "2026-06-25T00:00:00.000Z",
    endedAt: "2026-06-25T00:00:05.000Z",
    durationMs: 5000,
    outcomes: [
      { id: "page-loads", status: "passed" },
      {
        id: "redirect-check",
        status: "failed",
        evidence: "outcomes/redirect-check.md",
      },
    ],
    steps: [],
    artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
    exitCode: 1,
    ...overrides,
  };
}

describe("maybeAutoAnnotateRun", () => {
  it("is a no-op when autoAnnotate is not on-run", async () => {
    const result = makeRunResult();
    const out = await maybeAutoAnnotateRun(result, { autoAnnotate: "never" });
    expect(out.annotated).toBe(0);
    expect(out.skipped).toBe(0);
  });

  it("is a no-op when autoAnnotate is on-investigate (not on-run)", async () => {
    const result = makeRunResult();
    const out = await maybeAutoAnnotateRun(result, {
      autoAnnotate: "on-investigate",
    });
    expect(out.annotated).toBe(0);
  });

  it("skips and records an error when codemap is not available", async () => {
    const result = makeRunResult();
    const out = await maybeAutoAnnotateRun(result, { autoAnnotate: "on-run" });
    // We can't guarantee codemap is installed in CI, but the function should
    // either annotate (if available) or skip with an error (if not).
    if (await isCodemapAvailable()) {
      expect(out.annotated).toBe(1);
    } else {
      expect(out.annotated).toBe(0);
      expect(out.skipped).toBe(1);
      expect(out.errors.length).toBeGreaterThan(0);
    }
  });

  it("works for a passed run (not just failures)", async () => {
    const result = makeRunResult({
      status: "passed",
      exitCode: 0,
      outcomes: [
        { id: "page-loads", status: "passed" },
        {
          id: "redirect-check",
          status: "passed",
          evidence: "outcomes/redirect-check.md",
        },
      ],
    });
    const out = await maybeAutoAnnotateRun(result, { autoAnnotate: "on-run" });
    if (await isCodemapAvailable()) {
      expect(out.annotated).toBe(1);
    } else {
      expect(out.skipped).toBe(1);
    }
  });
});
