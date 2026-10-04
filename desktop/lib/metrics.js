/**
 * Metric probes (config `metrics:`): `<runDir>/diagnostics/metrics.json`
 * (`urn:cairntrace.dev:metrics:v1`) as Studio shows it, and the history of
 * one metric across runs.
 *
 * Studio reads what the runner wrote and never samples anything itself. The
 * document is validated field by field (finite numbers only, bounded strings
 * and series), every string goes through the shared credential masker, and a
 * file that is not a metrics document reads as "no metrics". Everything is
 * optional: a run without probes has no file.
 */
const fs = require("node:fs");
const path = require("node:path");
const CairnEvents = require("./events");
const { parseRunId, runIdTimestampMs } = require("./format");

/** metrics.json is a few KB; far more is not one. */
const MAX_METRICS_BYTES = 2 * 1024 * 1024;
/** Most metrics one document lists. */
const MAX_METRICS = 200;
/** Series points kept per metric (for a sparkline): the rest is thinned. */
const MAX_SERIES_POINTS = 120;
/** Runs scanned for a history, newest first. */
const DEFAULT_HISTORY_SCAN = 150;
/** Points kept per metric in a history. */
const DEFAULT_HISTORY_POINTS = 40;

/**
 * @param {unknown} value
 * @returns {number | null} a finite number, else null
 */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string | null}
 */
function text(value, max = 400) {
  if (typeof value !== "string" || !value) return null;
  return CairnEvents.maskValue(null, value, max);
}

/**
 * One sample (`before` / `after`) as `{ value, at, error }`.
 * @param {any} sample
 * @returns {{ value: number | null, at: string | null, error: string | null } | null}
 */
function normalizeSample(sample) {
  if (!sample || typeof sample !== "object") return null;
  return {
    value: finite(sample.value),
    at: typeof sample.at === "string" ? sample.at : null,
    error: text(sample.error, 300),
  };
}

/**
 * Evenly thin a list down to at most `max` entries, keeping first and last.
 * @template T
 * @param {T[]} list
 * @param {number} max
 * @returns {T[]}
 */
function thin(list, max) {
  if (list.length <= max) return list;
  const out = [];
  for (let index = 0; index < max; index += 1)
    out.push(list[Math.round((index * (list.length - 1)) / (max - 1))]);
  return out;
}

/**
 * @param {any} series
 * @returns {{ count: number, min: number | null, max: number | null, mean: number | null, first: number | null, last: number | null, values: number[], truncated: boolean } | null}
 */
function normalizeSeries(series) {
  if (!series || typeof series !== "object") return null;
  const values = (Array.isArray(series.samples) ? series.samples : [])
    .map((/** @type {any} */ sample) => finite(sample?.value))
    .filter((/** @type {number | null} */ value) => value !== null);
  return {
    count: Math.max(0, Math.trunc(finite(series.count) ?? values.length)),
    min: finite(series.min),
    max: finite(series.max),
    mean: finite(series.mean),
    first: finite(series.first),
    last: finite(series.last),
    values: thin(/** @type {number[]} */ (values), MAX_SERIES_POINTS),
    truncated: Boolean(series.truncated),
  };
}

/**
 * @typedef {{
 *   name: string, scope: string, source: string | null, mode: string | null,
 *   unit: string | null, target: string | null,
 *   before: ReturnType<typeof normalizeSample>, after: ReturnType<typeof normalizeSample>,
 *   delta: number | null, failures: number, error: string | null,
 *   iteration: number | null, series: ReturnType<typeof normalizeSeries>,
 * }} MetricRow
 */

/**
 * A metrics document as Studio shows it, or null when it is not one.
 * @param {unknown} doc
 * @returns {{ runId: string | null, invocationId: string | null, environment: string | null, metrics: MetricRow[] } | null}
 */
function normalizeMetrics(doc) {
  const source = /** @type {any} */ (doc);
  if (!source || typeof source !== "object" || !Array.isArray(source.metrics))
    return null;
  /** @type {MetricRow[]} */
  const metrics = [];
  for (const row of source.metrics.slice(0, MAX_METRICS)) {
    if (!row || typeof row !== "object" || typeof row.name !== "string")
      continue;
    metrics.push({
      name: row.name,
      scope: row.scope === "invocation" ? "invocation" : "spec",
      source: typeof row.source === "string" ? row.source : null,
      mode: typeof row.mode === "string" ? row.mode : null,
      unit: typeof row.unit === "string" ? row.unit : null,
      target: text(row.target, 300),
      before: normalizeSample(row.before),
      after: normalizeSample(row.after),
      delta: finite(row.delta),
      failures: Math.max(0, Math.trunc(finite(row.failures) ?? 0)),
      error: text(row.error, 300),
      iteration:
        finite(row.iteration) !== null
          ? Math.trunc(/** @type {number} */ (finite(row.iteration)))
          : null,
      series: normalizeSeries(row.series),
    });
  }
  return {
    runId: typeof source.runId === "string" ? source.runId : null,
    invocationId:
      typeof source.invocationId === "string" ? source.invocationId : null,
    environment:
      typeof source.environment === "string" ? source.environment : null,
    metrics,
  };
}

/**
 * The run's `diagnostics/metrics.json`, or null when it has none.
 * @param {string} runDir
 * @returns {ReturnType<typeof normalizeMetrics>}
 */
function readRunMetrics(runDir) {
  const file = path.join(runDir, "diagnostics", "metrics.json");
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_METRICS_BYTES) return null;
    return normalizeMetrics(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The value a metric is plotted by: its delta, else its `after` sample.
 * @param {MetricRow} row
 * @returns {{ value: number, basis: "delta" | "after" } | null}
 */
function plotValue(row) {
  if (row.delta !== null) return { value: row.delta, basis: "delta" };
  const after = row.after?.value;
  if (after !== null && after !== undefined)
    return { value: after, basis: "after" };
  return null;
}

/**
 * @typedef {{
 *   runId: string, at: string | null, value: number, basis: "delta" | "after",
 *   before: number | null, after: number | null, iteration: number | null,
 * }} MetricPoint
 */

/**
 * One metric's values across the artifact root's runs, oldest first: what a
 * sparkline plots. Optionally limited to one spec (a run id carries the
 * spec's name). Only runs that have a metrics document are read.
 * @param {string} runsRoot
 * @param {{ spec?: string | null, limit?: number, scan?: number }} [options]
 * @returns {{ metrics: Record<string, { unit: string | null, basis: "delta" | "after", scope: string, points: MetricPoint[] }>, scanned: number, spec: string | null }}
 */
function metricsHistory(runsRoot, options = {}) {
  const { listRunIds } = require("./runs");
  const limit = Math.max(2, options.limit ?? DEFAULT_HISTORY_POINTS);
  const scan = Math.max(1, options.scan ?? DEFAULT_HISTORY_SCAN);
  const spec = options.spec ? String(options.spec) : null;
  // Keyed by metric name: `constructor` or `toString` is a valid name, so
  // the map has no prototype.
  /** @type {Record<string, { unit: string | null, basis: "delta" | "after", scope: string, points: MetricPoint[] }>} */
  const out = Object.create(null);
  let scanned = 0;
  // newest first; points are prepended so each list ends up oldest first
  for (const runId of listRunIds(runsRoot).slice(0, scan)) {
    const parsed = parseRunId(runId);
    if (spec && parsed.spec !== spec) continue;
    scanned += 1;
    const doc = readRunMetrics(path.join(runsRoot, runId));
    if (!doc) continue;
    const startedMs = runIdTimestampMs(parsed.startedAt);
    for (const row of doc.metrics) {
      const plotted = plotValue(row);
      if (!plotted) continue;
      const entry =
        out[row.name] ??
        (out[row.name] = {
          unit: row.unit,
          basis: plotted.basis,
          scope: row.scope,
          points: [],
        });
      if (entry.points.length >= limit) continue;
      entry.points.unshift({
        runId,
        at: startedMs === null ? null : new Date(startedMs).toISOString(),
        value: plotted.value,
        basis: plotted.basis,
        before: row.before?.value ?? null,
        after: row.after?.value ?? null,
        iteration: row.iteration,
      });
    }
  }
  // the newest point decides what is plotted: older points of another basis
  // (an `after` once, a `delta` later) are not comparable and are dropped
  for (const entry of Object.values(out)) {
    const basis = entry.points.at(-1)?.basis ?? entry.basis;
    entry.basis = basis;
    entry.points = entry.points.filter((point) => point.basis === basis);
  }
  return { metrics: out, scanned, spec };
}

module.exports = {
  MAX_METRICS_BYTES,
  MAX_SERIES_POINTS,
  normalizeMetrics,
  readRunMetrics,
  plotValue,
  metricsHistory,
  thin,
};
