import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffRuns } from "./runDiff";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cairntrace-diff-test-"));
});

afterAll(async () => {
  // best-effort; tmp is fine to leak
});

async function writeRun(
  name: string,
  run: Record<string, unknown>,
  consoleErrors: Array<{ type: string; text: string }> = [],
  failedRequests: Array<{ url: string; method: string; status?: number }> = [],
): Promise<string> {
  const runDir = join(root, name);
  await mkdir(join(runDir, "console"), { recursive: true });
  await mkdir(join(runDir, "network"), { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify(run, null, 2));
  await writeFile(
    join(runDir, "console", "errors.ndjson"),
    consoleErrors.map((e) => JSON.stringify(e)).join("\n"),
  );
  await writeFile(
    join(runDir, "network", "failed_requests.ndjson"),
    failedRequests.map((f) => JSON.stringify(f)).join("\n"),
  );
  return runDir;
}

const stepShape = (
  id: string,
  status: "passed" | "failed" | "skipped",
  durationMs: number,
) => ({ id, status, durationMs });

const outcomeShape = (id: string, status: "passed" | "failed" | "skipped") => ({
  id,
  status,
});

describe("diffRuns", () => {
  it("flags outcome flips and status change", async () => {
    const a = await writeRun("a", {
      runId: "A",
      status: "passed",
      durationMs: 1000,
      outcomes: [outcomeShape("ok", "passed"), outcomeShape("count", "passed")],
      steps: [stepShape("nav", "passed", 200)],
    });
    const b = await writeRun("b", {
      runId: "B",
      status: "failed",
      durationMs: 1100,
      outcomes: [outcomeShape("ok", "passed"), outcomeShape("count", "failed")],
      steps: [stepShape("nav", "passed", 200)],
    });
    const d = await diffRuns(a, b);
    expect(d.overall.statusChanged).toBe(true);
    expect(d.outcomes.flipped).toEqual([
      { id: "count", from: "passed", to: "failed" },
    ]);
  });

  it("flags step slowdowns above the 1.5x / 100ms threshold", async () => {
    const a = await writeRun("a-slow", {
      runId: "A",
      status: "passed",
      durationMs: 500,
      outcomes: [outcomeShape("ok", "passed")],
      steps: [
        stepShape("fast", "passed", 50),
        stepShape("slow", "passed", 200),
      ],
    });
    const b = await writeRun("b-slow", {
      runId: "B",
      status: "passed",
      durationMs: 1500,
      outcomes: [outcomeShape("ok", "passed")],
      steps: [
        stepShape("fast", "passed", 60), // small change; not a slowdown
        stepShape("slow", "passed", 1500), // 7.5×, +1300ms → slowdown
      ],
    });
    const d = await diffRuns(a, b);
    expect(d.steps.slowdowns).toHaveLength(1);
    expect(d.steps.slowdowns[0]).toMatchObject({
      id: "slow",
      fromMs: 200,
      toMs: 1500,
      factor: 7.5,
    });
  });

  it("reports new console errors only (preserving existing ones)", async () => {
    const a = await writeRun(
      "a-cons",
      {
        runId: "A",
        status: "passed",
        durationMs: 500,
        outcomes: [outcomeShape("ok", "passed")],
        steps: [],
      },
      [{ type: "error", text: "ignore-me" }],
    );
    const b = await writeRun(
      "b-cons",
      {
        runId: "B",
        status: "failed",
        durationMs: 500,
        outcomes: [outcomeShape("ok", "failed")],
        steps: [],
      },
      [
        { type: "error", text: "ignore-me" }, // present in A; not new
        { type: "error", text: "BRAND NEW ERROR" },
      ],
    );
    const d = await diffRuns(a, b);
    expect(d.console.errorCountDelta).toBe(1);
    expect(d.console.newErrors).toEqual([
      { type: "error", text: "BRAND NEW ERROR" },
    ]);
  });

  it("reports new network failures keyed by method+url+status", async () => {
    const a = await writeRun(
      "a-net",
      {
        runId: "A",
        status: "passed",
        durationMs: 500,
        outcomes: [outcomeShape("ok", "passed")],
        steps: [],
      },
      [],
      [{ url: "https://x/already", method: "GET", status: 500 }],
    );
    const b = await writeRun(
      "b-net",
      {
        runId: "B",
        status: "failed",
        durationMs: 500,
        outcomes: [outcomeShape("ok", "failed")],
        steps: [],
      },
      [],
      [
        { url: "https://x/already", method: "GET", status: 500 }, // pre-existing
        { url: "https://x/new", method: "POST", status: 502 },
      ],
    );
    const d = await diffRuns(a, b);
    expect(d.network.failureCountDelta).toBe(1);
    expect(d.network.newFailures).toEqual([
      { url: "https://x/new", method: "POST", status: 502 },
    ]);
  });
});
