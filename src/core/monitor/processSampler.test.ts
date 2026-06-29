import { describe, expect, it, vi } from "vitest";
import {
  ProcessSampler,
  reduceProcessMetrics,
  renderProcessMarkdown,
} from "./processSampler";
import {
  flattenTree,
  type MonitorClient,
  type ProcessTreeNode,
} from "./monitorClient";

function fakeClient(tree: ProcessTreeNode[]): MonitorClient {
  return {
    available: async () => true,
    sampleProcess: async (pid) => ({
      pid,
      name: "chromium",
      cpuPercent: 50,
      memoryBytes: 100 * 1024 * 1024,
      memoryPercent: 5,
      threads: 10,
      timestampMs: Date.now(),
    }),
    processTree: async () => tree,
    captureProfile: async (pid, type) => ({
      pid,
      type,
      taken: "2026-01-01T00:00:00Z",
    }),
  };
}

const tree: ProcessTreeNode = {
  pid: 123,
  name: "chromium",
  cpu_percent: 50,
  memory: 100 * 1024 * 1024,
  memory_percent: 5,
  threads: 10,
  is_system: false,
  is_protected: false,
  children: [
    {
      pid: 124,
      name: "renderer",
      cpu_percent: 30,
      memory: 50 * 1024 * 1024,
      memory_percent: 2,
      threads: 5,
      is_system: false,
      is_protected: false,
    },
  ],
};

describe("flattenTree", () => {
  it("walks the forest depth-first, root-first", () => {
    expect(flattenTree([tree]).map((n) => n.pid)).toEqual([123, 124]);
  });

  it("handles an empty forest", () => {
    expect(flattenTree([])).toEqual([]);
  });
});

describe("reduceProcessMetrics", () => {
  it("computes peak/mean RSS+CPU and final tree RSS", () => {
    const samples = [
      {
        timestampMs: 0,
        treeRssBytes: 200,
        treeCpuPercent: 40,
        processCount: 2,
      },
      {
        timestampMs: 1000,
        treeRssBytes: 400,
        treeCpuPercent: 80,
        processCount: 2,
      },
      {
        timestampMs: 2000,
        treeRssBytes: 300,
        treeCpuPercent: 60,
        processCount: 2,
      },
    ];
    const summary = reduceProcessMetrics(samples, [tree], {
      pid: 123,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:02Z",
      durationMs: 2000,
    });
    expect(summary.peakRssBytes).toBe(400);
    expect(summary.meanRssBytes).toBe(300);
    expect(summary.peakCpuPercent).toBe(80);
    expect(summary.meanCpuPercent).toBe(60);
    expect(summary.finalRssBytes).toBe(150 * 1024 * 1024);
    expect(summary.samples).toHaveLength(3);
  });

  it("returns zeros for an empty sample set without dividing by zero", () => {
    const summary = reduceProcessMetrics([], [], {
      pid: 1,
      startedAt: "s",
      endedAt: "e",
      durationMs: 0,
    });
    expect(summary.peakRssBytes).toBe(0);
    expect(summary.meanRssBytes).toBe(0);
    expect(summary.peakCpuPercent).toBe(0);
    expect(summary.meanCpuPercent).toBe(0);
    expect(summary.samples).toEqual([]);
  });
});

describe("renderProcessMarkdown", () => {
  it("renders peak/mean rows and the sample timeline", () => {
    const summary = reduceProcessMetrics(
      [
        {
          timestampMs: 0,
          treeRssBytes: 400,
          treeCpuPercent: 80,
          processCount: 2,
        },
      ],
      [tree],
      {
        pid: 123,
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
        durationMs: 1000,
      },
    );
    const md = renderProcessMarkdown(summary);
    expect(md).toContain("# Process metrics — PID 123");
    expect(md).toContain("| peak RSS |");
    expect(md).toContain("## Sample timeline");
    expect(md).toContain("## Final process tree");
  });
});

describe("ProcessSampler", () => {
  it("samples the process tree at each tick and reduces on stop", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient([tree]);
      const sampler = new ProcessSampler({
        pid: 123,
        intervalMs: 1000,
        client,
      });
      sampler.start();
      // Immediate tick + two interval ticks.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      const summary = await sampler.stop();

      expect(summary.pid).toBe(123);
      expect(summary.samples.length).toBeGreaterThanOrEqual(2);
      // Every sample sums the tree: 100MB + 50MB = 150MB.
      expect(summary.peakRssBytes).toBe(150 * 1024 * 1024);
      expect(summary.meanRssBytes).toBe(150 * 1024 * 1024);
      // CPU sums to 80 across the two-node tree.
      expect(summary.peakCpuPercent).toBe(80);
      expect(summary.finalRssBytes).toBe(150 * 1024 * 1024);
    } finally {
      vi.useRealTimers();
    }
  });

  it("produces an empty summary when the tree never resolves", async () => {
    vi.useFakeTimers();
    try {
      const client: MonitorClient = {
        available: async () => true,
        sampleProcess: async () => undefined,
        processTree: async () => undefined,
        captureProfile: async () => undefined,
      };
      const sampler = new ProcessSampler({ pid: 999, intervalMs: 500, client });
      sampler.start();
      await vi.advanceTimersByTimeAsync(1500);
      const summary = await sampler.stop();
      expect(summary.samples).toEqual([]);
      expect(summary.peakRssBytes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
