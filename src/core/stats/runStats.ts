import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult } from "../schema/run.v1";
import type {
  StatsDelta,
  StatsGroup,
  StatsPercentiles,
  StatsResult,
  StatsRunRef,
} from "../schema/stats.v1";

export interface AggregateRunStatsOptions {
  artifactRoot: string;
  /** Label key to cohort by (e.g. "path"). */
  groupBy: string;
  /** AND filters: only runs whose labels include every pair. */
  filter?: Record<string, string>;
  /**
   * Preferred metric field names to harvest from outcomes/*.raw.json
   * (depth-limited search). Default includes processingDurationMS.
   */
  metricNames?: string[];
  /** Prefer this group as baseline for deltas (else first sorted key). */
  baseline?: string;
  /** Cap how many run dirs to inspect (newest first). Default 500. */
  limit?: number;
  /** When true, include per-run rows in the result. */
  includeRuns?: boolean;
}

// Prefer domain processing latency. Do NOT include generic `durationMs` —
// many raw sidecars carry unrelated duration fields that would skew A/B stats.
const DEFAULT_METRIC_NAMES = [
  "processingDurationMS",
  "processingMs",
  "latencyMs",
];

/**
 * Scan an artifact root for run.json files, filter/group by labels, and
 * compute pass rates + latency percentiles (run wall-clock and optional
 * domain metric from outcome raw sidecars).
 */
export async function aggregateRunStats(
  opts: AggregateRunStatsOptions,
): Promise<StatsResult> {
  const metricNames = opts.metricNames?.length
    ? opts.metricNames
    : DEFAULT_METRIC_NAMES;
  const limit = opts.limit ?? 500;
  const filter = opts.filter ?? {};

  const dirs = await listRunDirsNewestFirst(opts.artifactRoot, limit);
  const matched: StatsRunRef[] = [];
  let scanned = 0;

  for (const name of dirs) {
    const runDir = join(opts.artifactRoot, name);
    const run = await loadRunJson(runDir);
    if (!run) continue;
    scanned += 1;

    const labels = run.labels ?? {};
    if (!labelsMatch(labels, filter)) continue;
    if (!(opts.groupBy in labels)) continue;

    const metricMs = await harvestMetricFromRun(runDir, run, metricNames);
    matched.push({
      runId: run.runId,
      runDir,
      specName: run.spec.name,
      status: run.status,
      durationMs: run.durationMs,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(metricMs !== undefined ? { metricMs } : {}),
    });
  }

  const byGroup = new Map<string, StatsRunRef[]>();
  for (const r of matched) {
    const key = r.labels?.[opts.groupBy] ?? "(missing)";
    const list = byGroup.get(key) ?? [];
    list.push(r);
    byGroup.set(key, list);
  }

  const groupKeys = [...byGroup.keys()].toSorted();
  const groups: StatsGroup[] = groupKeys.map((key) => {
    const runs = byGroup.get(key)!;
    return buildGroup(key, runs, metricNames[0]);
  });

  const baseline =
    opts.baseline && byGroup.has(opts.baseline)
      ? opts.baseline
      : (groupKeys[0] ?? "");
  const deltas =
    groupKeys.length >= 2 && baseline
      ? buildDeltas(baseline, groups)
      : undefined;

  const primaryMetricName = matched.some((r) => r.metricMs !== undefined)
    ? metricNames[0]
    : undefined;

  return {
    $schema: "urn:cairntrace.dev:stats:v1",
    version: "1",
    artifactRoot: opts.artifactRoot,
    groupBy: opts.groupBy,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(primaryMetricName ? { metricName: primaryMetricName } : {}),
    scanned,
    matched: matched.length,
    groups,
    ...(deltas && deltas.length > 0 ? { deltas } : {}),
    ...(opts.includeRuns ? { runs: matched } : {}),
  };
}

export function parseLabelFlags(
  pairs: string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--label expects key=value, got "${pair}"`);
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!key) throw new Error(`--label expects key=value, got "${pair}"`);
    out[key] = value;
  }
  return out;
}

export function percentiles(values: number[]): StatsPercentiles {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].toSorted((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: Number((sum / sorted.length).toFixed(2)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** Nearest-rank percentile on a pre-sorted ascending array. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, rank));
  return sortedAsc[idx]!;
}

function buildGroup(
  key: string,
  runs: StatsRunRef[],
  metricName: string | undefined,
): StatsGroup {
  const passed = runs.filter((r) => r.status === "passed").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const errored = runs.filter((r) => r.status === "errored").length;
  const durationVals = runs.map((r) => r.durationMs);
  const metricVals = runs
    .map((r) => r.metricMs)
    .filter((n): n is number => typeof n === "number");
  const metric = metricVals.length > 0 ? percentiles(metricVals) : undefined;

  return {
    key,
    runs: runs.length,
    passed,
    failed,
    errored,
    passRate: runs.length === 0 ? 0 : Number((passed / runs.length).toFixed(4)),
    duration: percentiles(durationVals),
    ...(metric ? { metric, metricName } : {}),
  };
}

function buildDeltas(baseline: string, groups: StatsGroup[]): StatsDelta[] {
  const base = groups.find((g) => g.key === baseline);
  if (!base) return [];
  const out: StatsDelta[] = [];
  for (const g of groups) {
    if (g.key === baseline) continue;
    out.push({
      baseline,
      against: g.key,
      passRateDelta: Number((g.passRate - base.passRate).toFixed(4)),
      ...(ratio(base.duration.p50, g.duration.p50)
        ? { durationP50Ratio: ratio(base.duration.p50, g.duration.p50)! }
        : {}),
      ...(ratio(base.duration.p95, g.duration.p95)
        ? { durationP95Ratio: ratio(base.duration.p95, g.duration.p95)! }
        : {}),
      ...(ratio(base.metric?.p50, g.metric?.p50)
        ? { metricP50Ratio: ratio(base.metric?.p50, g.metric?.p50)! }
        : {}),
      ...(ratio(base.metric?.p95, g.metric?.p95)
        ? { metricP95Ratio: ratio(base.metric?.p95, g.metric?.p95)! }
        : {}),
    });
  }
  return out;
}

function ratio(
  base: number | undefined,
  against: number | undefined,
): number | undefined {
  if (
    base === undefined ||
    against === undefined ||
    !Number.isFinite(base) ||
    !Number.isFinite(against) ||
    base <= 0
  ) {
    return undefined;
  }
  return Number((against / base).toFixed(3));
}

function labelsMatch(
  labels: Record<string, string>,
  filter: Record<string, string>,
): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

async function listRunDirsNewestFirst(
  artifactRoot: string,
  limit: number,
): Promise<string[]> {
  const entries = await readdir(artifactRoot).catch(() => [] as string[]);
  const stats = await Promise.all(
    entries.map(async (name) => {
      try {
        const s = await stat(join(artifactRoot, name));
        return { name, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } catch {
        return { name, mtime: 0, isDir: false };
      }
    }),
  );
  return stats
    .filter((s) => s.isDir)
    .toSorted((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((s) => s.name);
}

async function loadRunJson(runDir: string): Promise<RunResult | null> {
  try {
    const raw = await readFile(join(runDir, "run.json"), "utf8");
    return JSON.parse(raw) as RunResult;
  } catch {
    return null;
  }
}

async function harvestMetricFromRun(
  runDir: string,
  run: RunResult,
  metricNames: string[],
): Promise<number | undefined> {
  const samples: number[] = [];
  for (const o of run.outcomes ?? []) {
    if (!o.evidenceRaw) continue;
    try {
      const raw = await readFile(join(runDir, o.evidenceRaw), "utf8");
      const json: unknown = JSON.parse(raw);
      const found = findNumericField(json, metricNames, 0, 6);
      if (found !== undefined) samples.push(found);
    } catch {
      /* ignore missing/partial sidecars */
    }
  }
  if (samples.length === 0) return undefined;
  // Prefer the first metric sample (usually the primary duration outcome).
  return samples[0];
}

function findNumericField(
  value: unknown,
  names: string[],
  depth: number,
  maxDepth: number,
): number | undefined {
  if (depth > maxDepth || value === null || value === undefined)
    return undefined;
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericField(item, names, depth + 1, maxDepth);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  for (const name of names) {
    const v = rec[name];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (
      typeof v === "string" &&
      v.trim() !== "" &&
      Number.isFinite(Number(v))
    ) {
      const n = Number(v);
      if (n >= 0) return n;
    }
  }
  for (const v of Object.values(rec)) {
    const found = findNumericField(v, names, depth + 1, maxDepth);
    if (found !== undefined) return found;
  }
  return undefined;
}
