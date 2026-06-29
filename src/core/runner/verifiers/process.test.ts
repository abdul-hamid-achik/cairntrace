import { describe, expect, it } from "vitest";
import { evaluateProcess } from "./process";
import type { ProcessMetricsSummary } from "../../monitor/processSampler";

function summary(
  over: Partial<ProcessMetricsSummary> = {},
): ProcessMetricsSummary {
  return {
    pid: 123,
    samples: [
      {
        timestampMs: 0,
        treeRssBytes: 300 * 1024 * 1024,
        treeCpuPercent: 60,
        processCount: 3,
      },
      {
        timestampMs: 1000,
        treeRssBytes: 400 * 1024 * 1024,
        treeCpuPercent: 85,
        processCount: 3,
      },
    ],
    peakRssBytes: 400 * 1024 * 1024,
    meanRssBytes: 350 * 1024 * 1024,
    finalRssBytes: 400 * 1024 * 1024,
    peakCpuPercent: 85,
    meanCpuPercent: 72.5,
    tree: [],
    durationMs: 1000,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    ...over,
  };
}

describe("process verifier", () => {
  it("is skipped when no sampler ran (no --monitor)", async () => {
    const r = await evaluateProcess(
      { process: { peakRss: { below: 500 } } },
      {},
    );
    expect(r.passed).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.actual).toContain("no sampler ran");
  });

  it("passes when all matchers hold (RSS in MB, CPU in percent)", async () => {
    const r = await evaluateProcess(
      {
        process: {
          peakRss: { below: 500 },
          meanCpu: { below: 90 },
          samples: { atLeast: 2 },
        },
      },
      { processMetrics: summary() },
    );
    expect(r.passed).toBe(true);
    expect(r.actual).toContain("peakRss=400.0MB");
    expect(r.actual).toContain("samples=2");
  });

  it("fails when peakRss exceeds the budget", async () => {
    const r = await evaluateProcess(
      { process: { peakRss: { below: 350 } } },
      { processMetrics: summary() },
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain("peakRss 400.0MB not below 350MB");
  });

  it("fails when meanCpu is not at least the threshold", async () => {
    const r = await evaluateProcess(
      { process: { meanCpu: { atLeast: 80 } } },
      { processMetrics: summary() },
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain("meanCpu 72.50% not at least 80%");
  });

  it("reports a real failure (not skipped) when metrics exist but a matcher is wrong", async () => {
    const r = await evaluateProcess(
      { process: { samples: { equals: 5 } } },
      { processMetrics: summary() },
    );
    expect(r.skipped).toBeUndefined();
    expect(r.passed).toBe(false);
  });

  it("fails when no matchers are provided", async () => {
    const r = await evaluateProcess(
      { process: {} },
      { processMetrics: summary() },
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain("no matchers provided");
  });

  it("honors equals on finalRss", async () => {
    const r = await evaluateProcess(
      { process: { finalRss: { equals: 400 } } },
      { processMetrics: summary() },
    );
    expect(r.passed).toBe(true);
  });
});
