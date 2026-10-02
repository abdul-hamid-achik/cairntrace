import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateRunStats, readReportMetrics } from "./runStats";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Write a minimal run dir (+ optional diagnostics/report.json). */
async function writeRun(
  name: string,
  labels: Record<string, string>,
  report: unknown,
  extra: Record<string, unknown> = {},
): Promise<string> {
  // A run-directory name the stats scan accepts (RUN_DIR_PATTERN).
  const dir = join(root, `2026-07-17T00-00-00-000Z_${name}_0a1b2c`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: name,
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
      labels,
      ...extra,
    }),
  );
  if (report !== undefined) {
    await mkdir(join(dir, "diagnostics"), { recursive: true });
    await writeFile(
      join(dir, "diagnostics", "report.json"),
      typeof report === "string" ? report : JSON.stringify(report),
    );
  }
  return dir;
}

describe("diagnostics/report.json metric ingestion", () => {
  it("keeps only finite non-negative numeric top-level fields", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-report-"));
    const dir = await writeRun(
      "r",
      {},
      {
        rootMs: 120,
        gcSeconds: 0.5,
        asString: "7",
        neg: -1,
        flag: true,
        nested: { fullBusinessMs: 9 },
        list: [1],
        nul: null,
      },
    );
    expect(await readReportMetrics(dir)).toEqual({
      rootMs: 120,
      gcSeconds: 0.5,
      asString: 7,
    });
  });

  it("returns {} for missing, malformed, or non-object reports", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-report-"));
    for (const [name, report] of [
      ["none", undefined],
      ["bad", "{not json"],
      ["arr", [1, 2]],
    ] as const) {
      const dir = await writeRun(name, {}, report);
      expect(await readReportMetrics(dir)).toEqual({});
    }
  });

  it("aggregates --metric from report.json per cohort", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-report-"));
    await writeRun("a1", { round: "A" }, { rootMs: 100, gcSeconds: 1 });
    await writeRun("a2", { round: "A" }, { rootMs: 300, gcSeconds: 3 });
    await writeRun("b1", { round: "B" }, { rootMs: 50, gcSeconds: 0.5 });
    await writeRun("b2", { round: "B" }, undefined);

    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "round",
      metricNames: ["gcSeconds"],
      baseline: "A",
    });
    expect(stats.metricName).toBe("gcSeconds");
    const a = stats.groups.find((g) => g.key === "A")!;
    const b = stats.groups.find((g) => g.key === "B")!;
    expect(a.metric?.n).toBe(2);
    expect(a.metric?.max).toBe(3);
    expect(b.metric?.n).toBe(1);
    expect(b.metric?.p50).toBe(0.5);
    expect(stats.deltas?.[0]?.metricP50Ratio).toBeDefined();
  });

  it("report.json wins over outcome sidecars for the same metric name", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-report-"));
    const dir = await writeRun(
      "r1",
      { round: "A" },
      { processingDurationMS: 42 },
      {
        outcomes: [
          { id: "o", status: "passed", evidenceRaw: "outcomes/o.raw.json" },
        ],
      },
    );
    await mkdir(join(dir, "outcomes"), { recursive: true });
    await writeFile(
      join(dir, "outcomes", "o.raw.json"),
      JSON.stringify({ processingDurationMS: 999 }),
    );
    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "round",
      includeRuns: true,
    });
    expect(stats.runs?.[0]?.metricMs).toBe(42);
  });

  it("falls back to outcome sidecars when report.json lacks the metric", async () => {
    root = mkdtempSync(join(tmpdir(), "cairn-report-"));
    const dir = await writeRun(
      "r1",
      { round: "A" },
      { rootMs: 1 },
      {
        outcomes: [
          { id: "o", status: "passed", evidenceRaw: "outcomes/o.raw.json" },
        ],
      },
    );
    await mkdir(join(dir, "outcomes"), { recursive: true });
    await writeFile(
      join(dir, "outcomes", "o.raw.json"),
      JSON.stringify({ processingDurationMS: 999 }),
    );
    const stats = await aggregateRunStats({
      artifactRoot: root,
      groupBy: "round",
      includeRuns: true,
    });
    expect(stats.runs?.[0]?.metricMs).toBe(999);
  });
});
