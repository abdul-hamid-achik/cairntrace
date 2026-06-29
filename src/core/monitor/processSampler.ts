/**
 * Polls the browser process tree's CPU/RSS at a fixed interval while a run's
 * step loop executes, then reduces the samples into a summary the
 * `process` verifier can assert on and `diagnostics/process.{md,json}`
 * artifacts can render.
 *
 * The sampler is tree-based: each tick calls `monitor tree <pid> --json` and
 * sums `memory` (bytes) and `cpu_percent` across the whole subtree, so
 * renderer/GPU/worker children of Chromium are counted — a single-PID sample
 * would undercount browser RSS badly. CPU% is a sum across the tree and may
 * exceed 100 on multi-core hosts; that is total browser-tree CPU usage.
 *
 * Zero-cost when never started: the Runner only constructs a sampler when
 * `--monitor` is passed (or `MONITOR=1` is detected) and a browser PID is
 * available.
 */

import {
  type MonitorClient,
  type ProcessTreeNode,
  flattenTree,
} from "./monitorClient";

export interface ProcessSamplePoint {
  /** Epoch milliseconds when the sample was taken. */
  timestampMs: number;
  /** Summed RSS (bytes) across the process tree at this tick. */
  treeRssBytes: number;
  /** Summed CPU% across the process tree at this tick (may exceed 100). */
  treeCpuPercent: number;
  /** Number of processes in the tree at this tick. */
  processCount: number;
}

export interface ProcessMetricsSummary {
  /** Root PID the sampler targeted (the browser process tree root). */
  pid: number;
  /** Per-tick samples, in collection order. */
  samples: ProcessSamplePoint[];
  /** Peak tree RSS observed across all samples (bytes). */
  peakRssBytes: number;
  /** Mean tree RSS across samples (bytes). */
  meanRssBytes: number;
  /** Peak summed tree CPU% observed across all samples. */
  peakCpuPercent: number;
  /** Mean summed tree CPU% across samples. */
  meanCpuPercent: number;
  /** Final tree RSS from the last successful sample (bytes). */
  finalRssBytes: number;
  /** Final `monitor tree <pid>` forest, for the diagnostics artifact. */
  tree: ProcessTreeNode[];
  /** Wall-clock sampling duration (ms). */
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

export interface ProcessSamplerOptions {
  pid: number;
  /** Polling interval in milliseconds. Default 1000. */
  intervalMs?: number;
  client: MonitorClient;
  /** Inject a clock for deterministic tests. */
  now?: () => Date;
}

export class ProcessSampler {
  private readonly pid: number;
  private readonly intervalMs: number;
  private readonly client: MonitorClient;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private startedAtMs = 0;
  private startedAtIso = "";
  private readonly samples: ProcessSamplePoint[] = [];

  constructor(opts: ProcessSamplerOptions) {
    this.pid = opts.pid;
    this.intervalMs = opts.intervalMs ?? 1_000;
    this.client = opts.client;
    this.now = opts.now ?? (() => new Date());
  }

  /** Begin polling. Safe to call once; subsequent calls are a no-op. */
  start(): void {
    if (this.timer !== undefined) return;
    this.startedAtMs = Date.now();
    this.startedAtIso = this.now().toISOString();
    // Take one immediate sample so a short run still has data, then poll.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't keep the event loop alive solely for sampling.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const tree = await this.client.processTree(this.pid);
      if (!tree || tree.length === 0) return;
      const flat = flattenTree(tree);
      const treeRssBytes = flat.reduce((sum, n) => sum + (n.memory ?? 0), 0);
      const treeCpuPercent = flat.reduce(
        (sum, n) => sum + (n.cpu_percent ?? 0),
        0,
      );
      this.samples.push({
        timestampMs: Date.now(),
        treeRssBytes,
        treeCpuPercent,
        processCount: flat.length,
      });
    } finally {
      this.inFlight = false;
    }
  }

  /** Stop polling and reduce samples into a summary. */
  async stop(): Promise<ProcessMetricsSummary> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Drain any in-flight tick so the final sample isn't dropped.
    if (this.inFlight) {
      await this.client.processTree(this.pid).catch(() => undefined);
      // The tick that was in flight has now resolved and pushed its sample.
    }
    const endedAtIso = this.now().toISOString();
    const finalTree = (await this.client.processTree(this.pid)) ?? [];
    return reduceProcessMetrics(this.samples, finalTree, {
      pid: this.pid,
      startedAt: this.startedAtIso,
      endedAt: endedAtIso,
      durationMs: Date.now() - this.startedAtMs,
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure reduction of sampled process-tree points into a summary. Extracted
 * from `ProcessSampler.stop` so the peak/mean/timeline math is testable
 * without real timers.
 */
export function reduceProcessMetrics(
  samples: ProcessSamplePoint[],
  finalTree: ProcessTreeNode[],
  timings: {
    pid: number;
    startedAt: string;
    endedAt: string;
    durationMs: number;
  },
): ProcessMetricsSummary {
  const count = samples.length;
  const peakRssBytes = count
    ? samples.reduce((m, s) => Math.max(m, s.treeRssBytes), 0)
    : 0;
  const meanRssBytes = count
    ? Math.round(samples.reduce((sum, s) => sum + s.treeRssBytes, 0) / count)
    : 0;
  const peakCpuPercent = count
    ? samples.reduce((m, s) => Math.max(m, s.treeCpuPercent), 0)
    : 0;
  const meanCpuPercent = count
    ? round2(samples.reduce((sum, s) => sum + s.treeCpuPercent, 0) / count)
    : 0;
  return {
    pid: timings.pid,
    samples,
    peakRssBytes,
    meanRssBytes,
    peakCpuPercent: round2(peakCpuPercent),
    meanCpuPercent,
    finalRssBytes: flattenTree(finalTree).reduce(
      (sum, n) => sum + (n.memory ?? 0),
      0,
    ),
    tree: finalTree,
    durationMs: timings.durationMs,
    startedAt: timings.startedAt,
    endedAt: timings.endedAt,
  };
}

function mb(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "0 MB";
}

/** Render a `ProcessMetricsSummary` as a compact Markdown diagnostics report. */
export function renderProcessMarkdown(summary: ProcessMetricsSummary): string {
  const lines: string[] = [
    `# Process metrics — PID ${summary.pid}`,
    "",
    `Sampled ${summary.samples.length} point(s) over ${
      summary.durationMs
    }ms (${summary.startedAt} → ${summary.endedAt}).`,
    "",
    "| metric | value |",
    "| --- | --- |",
    `| peak RSS | ${mb(summary.peakRssBytes)} |`,
    `| mean RSS | ${mb(summary.meanRssBytes)} |`,
    `| final RSS | ${mb(summary.finalRssBytes)} |`,
    `| peak CPU | ${summary.peakCpuPercent.toFixed(1)}% |`,
    `| mean CPU | ${summary.meanCpuPercent.toFixed(1)}% |`,
    "",
    "## Sample timeline",
    "",
    "| t (ms) | RSS | CPU% | procs |",
    "| ---: | ---: | ---: | ---: |",
    ...summary.samples.map(
      (s) =>
        `| ${s.timestampMs - Date.parse(summary.startedAt)} | ${mb(
          s.treeRssBytes,
        )} | ${s.treeCpuPercent.toFixed(1)} | ${s.processCount} |`,
    ),
    "",
    "## Final process tree",
    "",
    "```",
    renderTree(summary.tree, 0),
    "```",
    "",
  ];
  return lines.join("\n");
}

function renderTree(nodes: ProcessTreeNode[], depth: number): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const indent = "  ".repeat(depth);
    lines.push(
      `${indent}- pid ${n.pid} ${n.name} — ${(n.memory / 1024 / 1024).toFixed(
        1,
      )} MB, ${n.cpu_percent.toFixed(1)}% CPU`,
    );
    if (n.children && n.children.length > 0) {
      lines.push(renderTree(n.children, depth + 1));
    }
  }
  return lines.join("\n");
}
