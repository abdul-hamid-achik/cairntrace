import { describe, expect, it } from "vitest";
import {
  isCodemapAvailable,
  maybeAutoAnnotateRun,
  type CodemapDeps,
} from "./annotate.js";
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
 *
 * Tests inject a fake `CodemapDeps` so the pass-case annotation and graceful
 * degradation are verified deterministically — independent of whether codemap
 * happens to be on $PATH in CI.
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

  it("skips and records an error when codemap is not available (fake/missing codemap)", async () => {
    const result = makeRunResult();
    const missing: CodemapDeps = {
      isAvailable: async () => false,
      exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    };
    const out = await maybeAutoAnnotateRun(
      result,
      { autoAnnotate: "on-run" },
      missing,
    );
    // Graceful degradation: never crashes the run, records a skip + error.
    expect(out.annotated).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0]).toMatch(/codemap not on \$PATH/);
  });

  it("annotates a passing run (green badge) with the per-run data payload", async () => {
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

    const calls: string[][] = [];
    const fake: CodemapDeps = {
      isAvailable: async () => true,
      exec: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ id: 42 }), stderr: "" };
      },
    };

    const out = await maybeAutoAnnotateRun(
      result,
      { autoAnnotate: "on-run" },
      fake,
    );

    // A passing run leaves an annotation too (not just failures).
    expect(out.annotated).toBe(1);
    expect(out.skipped).toBe(0);
    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args[0]).toBe("annotate");
    expect(args[1]).toBe(result.spec.name); // symbol = spec name
    // --source cairntrace
    expect(args).toContain("cairntrace");
    // --data carries the per-run contract: specName, contractHash, runId,
    // status, outcomes, failedVerifier.
    const dataIdx = args.indexOf("--data");
    expect(dataIdx).toBeGreaterThan(-1);
    const payload = JSON.parse(args[dataIdx + 1]!);
    expect(payload).toMatchObject({
      specName: result.spec.name,
      contractHash: result.spec.contractHash,
      runId: result.runId,
      status: "passed",
    });
    // JSON.stringify drops undefined, so a passing run carries no
    // failedVerifier field — the green badge has no failing verifier.
    expect(payload.failedVerifier).toBeUndefined();
    expect(payload.outcomes).toEqual([
      { id: "page-loads", status: "passed" },
      { id: "redirect-check", status: "passed" },
    ]);
  });

  it("annotates a failing run and records the failed verifier", async () => {
    const result = makeRunResult(); // status: failed, redirect-check failed
    const calls: string[][] = [];
    const fake: CodemapDeps = {
      isAvailable: async () => true,
      exec: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ id: 7 }), stderr: "" };
      },
    };
    const out = await maybeAutoAnnotateRun(
      result,
      { autoAnnotate: "on-run" },
      fake,
    );
    expect(out.annotated).toBe(1);
    const failArgs = calls[0]!;
    const dataIdx = failArgs.indexOf("--data");
    const payload = JSON.parse(failArgs[dataIdx + 1]!);
    expect(payload.status).toBe("failed");
    expect(payload.failedVerifier).toBe("redirect-check");
  });

  it("records a codemap exec failure without throwing", async () => {
    const result = makeRunResult();
    const fake: CodemapDeps = {
      isAvailable: async () => true,
      exec: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "symbol not indexed",
      }),
    };
    const out = await maybeAutoAnnotateRun(
      result,
      { autoAnnotate: "on-run" },
      fake,
    );
    expect(out.annotated).toBe(0);
    expect(out.errors.length).toBeGreaterThan(0);
  });
});
