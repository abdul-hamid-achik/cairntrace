import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  aggregateRunStats,
  parseLabelFlags,
  percentile,
  percentiles,
} from "./runStats";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function writeRun(
  dir: string,
  partial: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const base = {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId: partial.runId ?? "run",
    runDir: dir,
    spec: { name: "spec", path: "/tmp/spec.yml" },
    environment: "local",
    backend: "mock",
    coldStart: false,
    status: "passed",
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: "2026-07-17T00:00:01.000Z",
    durationMs: 1000,
    outcomes: [],
    steps: [],
    artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
    exitCode: 0,
    ...partial,
  };
  await writeFile(join(dir, "run.json"), JSON.stringify(base, null, 2));
}

describe("parseLabelFlags", () => {
  it("parses key=value pairs", () => {
    expect(parseLabelFlags(["path=legacy", "suite=ab"])).toEqual({
      path: "legacy",
      suite: "ab",
    });
  });

  it("allows = in values", () => {
    expect(parseLabelFlags(["note=a=b"])).toEqual({ note: "a=b" });
  });

  it("rejects malformed pairs", () => {
    expect(() => parseLabelFlags(["nocolon"])).toThrow(/key=value/);
    expect(() => parseLabelFlags(["=x"])).toThrow(/key=value/);
  });
});

describe("percentiles", () => {
  it("returns empty for no samples", () => {
    expect(percentiles([])).toEqual({ n: 0 });
  });

  it("computes nearest-rank p50/p95", () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const p = percentiles(vals);
    expect(p.n).toBe(10);
    expect(p.min).toBe(10);
    expect(p.max).toBe(100);
    expect(p.p50).toBe(percentile(vals, 50));
    expect(p.p95).toBe(percentile(vals, 95));
  });
});

describe("aggregateRunStats", () => {
  it("groups by label and computes pass rates + duration stats", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-"));
    await writeRun(join(root, "r1"), {
      runId: "r1",
      labels: { path: "legacy", suite: "ab" },
      status: "passed",
      durationMs: 1000,
      exitCode: 0,
    });
    await writeRun(join(root, "r2"), {
      runId: "r2",
      labels: { path: "legacy", suite: "ab" },
      status: "failed",
      durationMs: 2000,
      exitCode: 1,
    });
    await writeRun(join(root, "t1"), {
      runId: "t1",
      labels: { path: "next", suite: "ab" },
      status: "passed",
      durationMs: 3000,
      exitCode: 0,
    });
    // wrong suite — filtered out
    await writeRun(join(root, "other"), {
      runId: "other",
      labels: { path: "next", suite: "other" },
      status: "passed",
      durationMs: 999,
      exitCode: 0,
    });
    // no labels — ignored
    await writeRun(join(root, "nolabel"), {
      runId: "nolabel",
      status: "passed",
      durationMs: 50,
      exitCode: 0,
    });

    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
      filter: { suite: "ab" },
      includeRuns: true,
    });

    expect(stats.matched).toBe(3);
    expect(stats.groups.map((g) => g.key)).toEqual(["legacy", "next"]);
    const legacy = stats.groups.find((g) => g.key === "legacy")!;
    expect(legacy.runs).toBe(2);
    expect(legacy.passed).toBe(1);
    expect(legacy.failed).toBe(1);
    expect(legacy.passRate).toBe(0.5);
    expect(legacy.duration.n).toBe(2);
    expect(legacy.duration.min).toBe(1000);
    expect(legacy.duration.max).toBe(2000);

    const next = stats.groups.find((g) => g.key === "next")!;
    expect(next.runs).toBe(1);
    expect(next.passRate).toBe(1);

    expect(stats.deltas?.length).toBe(1);
    expect(stats.deltas?.[0]?.baseline).toBe("legacy");
    expect(stats.deltas?.[0]?.against).toBe("next");
    expect(stats.runs?.length).toBe(3);
  });

  it("harvests processingDurationMS from outcome raw sidecars", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-metric-"));
    const runDir = join(root, "m1");
    await writeRun(runDir, {
      runId: "m1",
      labels: { path: "next" },
      status: "passed",
      durationMs: 5000,
      outcomes: [
        {
          id: "wf",
          status: "passed",
          evidenceRaw: "outcomes/wf.raw.json",
        },
      ],
      exitCode: 0,
    });
    await mkdir(join(runDir, "outcomes"), { recursive: true });
    await writeFile(
      join(runDir, "outcomes/wf.raw.json"),
      JSON.stringify({
        event: { processingDurationMS: 12345, routedTo: "next" },
      }),
    );

    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
    });
    expect(stats.groups[0]?.metric?.n).toBe(1);
    expect(stats.groups[0]?.metric?.p50).toBe(12345);
    expect(stats.metricName).toBe("processingDurationMS");
  });

  it("honors baseline group for deltas", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-base-"));
    await writeRun(join(root, "r"), {
      runId: "r",
      labels: { path: "legacy" },
      durationMs: 100,
    });
    await writeRun(join(root, "t"), {
      runId: "t",
      labels: { path: "next" },
      durationMs: 200,
    });
    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
      baseline: "next",
    });
    expect(stats.deltas?.[0]?.baseline).toBe("next");
    expect(stats.deltas?.[0]?.against).toBe("legacy");
  });

  it("does not harvest generic durationMs as domain metric", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-nodur-"));
    const runDir = join(root, "x");
    await writeRun(runDir, {
      runId: "x",
      labels: { path: "legacy" },
      durationMs: 9999,
      outcomes: [
        { id: "o", status: "passed", evidenceRaw: "outcomes/o.raw.json" },
      ],
    });
    await mkdir(join(runDir, "outcomes"), { recursive: true });
    // Only a generic durationMs — must NOT be treated as processingDurationMS.
    await writeFile(
      join(runDir, "outcomes/o.raw.json"),
      JSON.stringify({ durationMs: 42, unrelated: true }),
    );
    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
    });
    expect(stats.groups[0]?.metric).toBeUndefined();
    expect(stats.metricName).toBeUndefined();
  });

  it("honors custom --metric field name", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-custom-metric-"));
    const runDir = join(root, "c");
    await writeRun(runDir, {
      runId: "c",
      labels: { path: "next" },
      outcomes: [
        { id: "o", status: "passed", evidenceRaw: "outcomes/o.raw.json" },
      ],
    });
    await mkdir(join(runDir, "outcomes"), { recursive: true });
    await writeFile(
      join(runDir, "outcomes/o.raw.json"),
      JSON.stringify({ customLatency: 777 }),
    );
    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
      metricNames: ["customLatency"],
    });
    expect(stats.groups[0]?.metric?.p50).toBe(777);
  });

  it("skips corrupt run.json and empty artifact roots", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-corrupt-"));
    await mkdir(join(root, "bad"), { recursive: true });
    await writeFile(join(root, "bad", "run.json"), "{not-json");
    const empty = await aggregateRunStats({
      artifactRoot: join(root, "missing-root-does-not-exist"),
      groupBy: "path",
    });
    expect(empty.scanned).toBe(0);
    expect(empty.matched).toBe(0);

    const withBad = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
    });
    expect(withBad.scanned).toBe(0); // corrupt json skipped before scanned++
    expect(withBad.matched).toBe(0);
  });

  it("counts errored status separately from failed", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-stats-errored-"));
    await writeRun(join(root, "e"), {
      runId: "e",
      labels: { path: "next" },
      status: "errored",
      durationMs: 10,
      exitCode: 2,
    });
    await writeRun(join(root, "f"), {
      runId: "f",
      labels: { path: "next" },
      status: "failed",
      durationMs: 20,
      exitCode: 1,
    });
    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "path",
    });
    const g = stats.groups[0]!;
    expect(g.errored).toBe(1);
    expect(g.failed).toBe(1);
    expect(g.passed).toBe(0);
    expect(g.passRate).toBe(0);
  });
});
