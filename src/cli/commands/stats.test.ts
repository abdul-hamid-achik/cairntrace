import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { StatsGroup, StatsResult } from "../../core/schema/stats.v1";
import { StatsResultSchema } from "../../core/schema/stats.v1";
import {
  formatBarLine,
  fmtMs,
  renderStatsCharts,
  renderStatsMarkdown,
} from "./stats";

function group(partial: Partial<StatsGroup> & { key: string }): StatsGroup {
  return {
    runs: 2,
    passed: 2,
    failed: 0,
    errored: 0,
    passRate: 1,
    duration: {
      n: 2,
      min: 1000,
      max: 2000,
      mean: 1500,
      p50: 1500,
      p95: 2000,
      p99: 2000,
    },
    ...partial,
  };
}

describe("fmtMs", () => {
  it("formats ms/s/m", () => {
    expect(fmtMs(undefined)).toBe("—");
    expect(fmtMs(42)).toBe("42ms");
    expect(fmtMs(1500)).toBe("1.5s");
    expect(fmtMs(90_000)).toBe("1m 30s");
  });
});

describe("formatBarLine", () => {
  it("fills bars proportional to max", () => {
    const full = formatBarLine("a", 100, 100, 4, 10, (v) => String(v));
    expect(full).toContain("█".repeat(10));
    expect(full).toContain("a");
    expect(full).toContain("100");

    const half = formatBarLine("b", 50, 100, 4, 10, (v) => String(v));
    expect(half).toMatch(/█{5}░{5}/);
  });

  it("clamps out-of-range values", () => {
    const over = formatBarLine("x", 200, 100, 1, 4, () => "x");
    expect(over).toContain("█".repeat(4));
    const under = formatBarLine("y", -10, 100, 1, 4, () => "y");
    expect(under).toContain("░".repeat(4));
  });
});

describe("renderStatsCharts", () => {
  it("renders pass-rate and duration charts", () => {
    const charts = renderStatsCharts([
      group({ key: "legacy", passRate: 1, duration: { n: 1, p50: 50_000 } }),
      group({
        key: "next",
        passRate: 0.5,
        duration: { n: 1, p50: 80_000 },
        metric: { n: 1, p50: 12_000 },
        metricName: "processingDurationMS",
      }),
    ]);
    const text = charts.join("\n");
    expect(text).toContain("### Pass rate");
    expect(text).toContain("### Duration p50");
    expect(text).toContain("### Metric p50");
    expect(text).toContain("processingDurationMS");
    expect(text).toContain("legacy");
    expect(text).toContain("next");
    expect(text).toContain("```");
  });

  it("returns empty for no groups", () => {
    expect(renderStatsCharts([])).toEqual([]);
  });
});

describe("renderStatsMarkdown", () => {
  it("renders empty-state guidance", () => {
    const s: StatsResult = {
      $schema: "urn:cairntrace.dev:stats:v1",
      version: "1",
      artifactRoot: "/tmp/runs",
      groupBy: "path",
      scanned: 3,
      matched: 0,
      groups: [],
    };
    const md = renderStatsMarkdown(s);
    expect(md).toContain("No matching runs");
    expect(md).toContain("--label");
    expect(StatsResultSchema.parse(s).matched).toBe(0);
  });

  it("includes table, charts, and deltas", () => {
    const s: StatsResult = {
      $schema: "urn:cairntrace.dev:stats:v1",
      version: "1",
      artifactRoot: "/tmp/runs",
      groupBy: "path",
      filter: { suite: "ab" },
      metricName: "processingDurationMS",
      scanned: 4,
      matched: 3,
      groups: [
        group({
          key: "legacy",
          passRate: 1,
          duration: { n: 2, p50: 50_000, p95: 55_000 },
          metric: { n: 2, p50: 40_000, p95: 45_000 },
          metricName: "processingDurationMS",
        }),
        group({
          key: "next",
          passRate: 0.5,
          passed: 1,
          failed: 1,
          duration: { n: 2, p50: 80_000, p95: 90_000 },
          metric: { n: 1, p50: 70_000, p95: 70_000 },
          metricName: "processingDurationMS",
        }),
      ],
      deltas: [
        {
          baseline: "legacy",
          against: "next",
          passRateDelta: -0.5,
          durationP50Ratio: 1.6,
          metricP50Ratio: 1.75,
        },
      ],
    };
    const md = renderStatsMarkdown(s);
    expect(md).toContain("# Stats by `path`");
    expect(md).toContain("suite=ab");
    expect(md).toContain("| legacy |");
    expect(md).toContain("| next |");
    expect(md).toContain("## Charts");
    expect(md).toContain("## Deltas vs baseline");
    expect(md).toContain("×1.6");
    expect(StatsResultSchema.parse(s).groups).toHaveLength(2);
  });
});

describe("cairn stats CLI", () => {
  it("aggregates labeled runs and prints markdown charts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-stats-cli-"));
    const runs = join(dir, "runs");
    await mkdir(runs, { recursive: true });

    async function putRun(
      id: string,
      labels: Record<string, string>,
      status: string,
      durationMs: number,
      metric?: number,
    ) {
      const runDir = join(runs, id);
      await mkdir(join(runDir, "outcomes"), { recursive: true });
      const outcomes = metric
        ? [
            {
              id: "wf",
              status: "passed",
              evidenceRaw: "outcomes/wf.raw.json",
            },
          ]
        : [];
      await writeFile(
        join(runDir, "run.json"),
        JSON.stringify({
          $schema: "urn:cairntrace.dev:run:v1",
          version: "1",
          runId: id,
          runDir,
          spec: { name: id, path: "/tmp/x.yml" },
          environment: "local",
          backend: "mock",
          coldStart: false,
          labels,
          status,
          startedAt: "2026-07-17T00:00:00.000Z",
          endedAt: "2026-07-17T00:00:01.000Z",
          durationMs,
          outcomes,
          steps: [],
          artifacts: {
            agentContext: "agent_context.md",
            events: "events.ndjson",
          },
          exitCode: status === "passed" ? 0 : 1,
        }),
      );
      if (metric !== undefined) {
        await writeFile(
          join(runDir, "outcomes/wf.raw.json"),
          JSON.stringify({
            event: { processingDurationMS: metric, routedTo: labels.path },
          }),
        );
      }
    }

    await putRun("r1", { path: "legacy", suite: "cli" }, "passed", 1000, 400);
    await putRun("r2", { path: "legacy", suite: "cli" }, "failed", 2000, 500);
    await putRun("t1", { path: "next", suite: "cli" }, "passed", 3000, 900);

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "stats",
        "--group-by",
        "path",
        "--label",
        "suite=cli",
        "--baseline",
        "legacy",
        "--artifact-root",
        runs,
        "--format",
        "md",
      ],
      { reject: false, timeout: 10_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## Charts");
    expect(result.stdout).toContain("Pass rate");
    expect(result.stdout).toContain("legacy");
    expect(result.stdout).toContain("next");
    expect(result.stdout).toContain("Deltas vs baseline");

    const json = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "stats",
        "--group-by",
        "path",
        "--label",
        "suite=cli",
        "--artifact-root",
        runs,
        "--json",
      ],
      { reject: false, timeout: 10_000 },
    );
    const body = StatsResultSchema.parse(JSON.parse(json.stdout));
    expect(body.matched).toBe(3);
    expect(body.groups).toHaveLength(2);
    expect(body.metricName).toBe("processingDurationMS");
  });

  it("exits 2 when --group-by is missing", async () => {
    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      ["stats", "--json"],
      { reject: false, timeout: 5_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/group-by/);
  });
});
