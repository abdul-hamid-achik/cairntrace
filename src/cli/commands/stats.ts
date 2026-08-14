import type { StatsGroup, StatsResult } from "../../core/schema/stats.v1";
import { aggregateRunStats, parseLabelFlags } from "../../core/stats/runStats";
import { emit, resolveFormat } from "../format";
import { resolveArtifactRoot } from "../runRefs";

export interface StatsCommandOptions {
  artifactRoot?: string;
  config?: string;
  /** Label key to cohort by (required). */
  groupBy?: string;
  /** Repeatable `--label key=value` filters (AND). */
  label?: string[];
  /** Preferred metric field to harvest from outcomes/*.raw.json. */
  metric?: string;
  /** Baseline group key for ratios (default: first sorted group). */
  baseline?: string;
  /** Max run dirs to scan (newest first). */
  limit?: string;
  /** Include per-run rows in the JSON/YAML payload. */
  includeRuns?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn stats --group-by path [--label suite=…]`
 *
 * Aggregate labeled runs into cohorts for A/B comparison (e.g. legacy vs
 * next). Reads run.json under the artifact root; optionally harvests
 * processingDurationMS from outcomes/*.raw.json.
 */
export async function statsCommand(opts: StatsCommandOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const groupBy = opts.groupBy?.trim();
  if (!groupBy) {
    process.stderr.write(
      "cairn stats: --group-by <label-key> is required (e.g. --group-by path)\n",
    );
    process.exit(2);
  }

  let filter: Record<string, string> = {};
  try {
    filter = parseLabelFlags(opts.label);
  } catch (e) {
    process.stderr.write(`cairn stats: ${(e as Error).message}\n`);
    process.exit(2);
  }

  let artifactRoot: string;
  try {
    artifactRoot = await resolveArtifactRoot(opts);
  } catch (e) {
    process.stderr.write(`cairn stats: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    process.stderr.write("cairn stats: --limit must be a positive integer\n");
    process.exit(2);
  }

  const result = await aggregateRunStats({
    artifactRoot,
    groupBy,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(opts.metric ? { metricNames: [opts.metric] } : {}),
    ...(opts.baseline ? { baseline: opts.baseline } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(opts.includeRuns ? { includeRuns: true } : {}),
  });

  process.stdout.write(emit(format, result, renderStatsMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");

  // Exit 0 always for a successful aggregation (empty cohorts are still ok —
  // agents inspect groups[].runs / matched). Non-zero only on usage/IO errors.
  process.exitCode = 0;
}

/** Markdown renderer (exported for unit tests). */
export function renderStatsMarkdown(s: StatsResult): string {
  const lines: string[] = [
    `# Stats by \`${s.groupBy}\``,
    "",
    `- Artifact root: \`${s.artifactRoot}\``,
    `- Scanned: ${s.scanned} run dirs · matched: ${s.matched}`,
  ];
  if (s.filter && Object.keys(s.filter).length > 0) {
    lines.push(
      `- Filter: ${Object.entries(s.filter)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  if (s.metricName) lines.push(`- Domain metric: \`${s.metricName}\``);
  lines.push("");

  if (s.groups.length === 0) {
    lines.push(
      "_No matching runs. Stamp cohorts with `cairn run --label key=value` and re-run stats._",
    );
    return lines.join("\n");
  }

  lines.push(
    "| group | runs | pass% | dur p50 | dur p95 | metric p50 | metric p95 |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const g of s.groups) {
    lines.push(
      `| ${g.key} | ${g.runs} | ${(g.passRate * 100).toFixed(1)}% | ${fmtMs(g.duration.p50)} | ${fmtMs(g.duration.p95)} | ${fmtMs(g.metric?.p50)} | ${fmtMs(g.metric?.p95)} |`,
    );
  }

  const charts = renderStatsCharts(s.groups);
  if (charts.length > 0) {
    lines.push("", "## Charts", ...charts);
  }

  if (s.deltas && s.deltas.length > 0) {
    lines.push("", "## Deltas vs baseline");
    for (const d of s.deltas) {
      lines.push(
        `- **${d.against}** vs **${d.baseline}**: passRate Δ ${fmtSigned(d.passRateDelta, true)}` +
          (d.durationP50Ratio !== undefined
            ? `, duration p50 ×${d.durationP50Ratio}`
            : "") +
          (d.metricP50Ratio !== undefined
            ? `, metric p50 ×${d.metricP50Ratio}`
            : ""),
      );
    }
  }

  return lines.join("\n");
}

/**
 * ASCII bar charts for pass rate, duration p50, and optional domain metric p50.
 * Terminal/markdown friendly — no image deps.
 */
export function renderStatsCharts(
  groups: StatsGroup[],
  barWidth = 24,
): string[] {
  if (groups.length === 0) return [];
  const lines: string[] = [];
  const labelWidth = Math.max(6, ...groups.map((g) => g.key.length));

  lines.push("", "### Pass rate");
  lines.push("```");
  for (const g of groups) {
    lines.push(
      formatBarLine(
        g.key,
        g.passRate * 100,
        100,
        labelWidth,
        barWidth,
        (v) => `${v.toFixed(1)}%`,
      ),
    );
  }
  lines.push("```");

  const durVals = groups
    .map((g) => g.duration.p50)
    .filter((n): n is number => typeof n === "number" && n >= 0);
  if (durVals.length > 0) {
    const maxDur = Math.max(...durVals, 1);
    lines.push("", "### Duration p50 (run wall-clock)");
    lines.push("```");
    for (const g of groups) {
      const v = g.duration.p50 ?? 0;
      lines.push(formatBarLine(g.key, v, maxDur, labelWidth, barWidth, fmtMs));
    }
    lines.push("```");
  }

  const metricVals = groups
    .map((g) => g.metric?.p50)
    .filter((n): n is number => typeof n === "number" && n >= 0);
  if (metricVals.length > 0) {
    const maxMetric = Math.max(...metricVals, 1);
    const metricLabel = groups.find((g) => g.metricName)?.metricName;
    lines.push(
      "",
      `### Metric p50${metricLabel ? ` (\`${metricLabel}\`)` : ""}`,
    );
    lines.push("```");
    for (const g of groups) {
      const v = g.metric?.p50;
      if (v === undefined) {
        lines.push(`${g.key.padEnd(labelWidth)}  ${"·".repeat(barWidth)}  —`);
        continue;
      }
      lines.push(
        formatBarLine(g.key, v, maxMetric, labelWidth, barWidth, fmtMs),
      );
    }
    lines.push("```");
  }

  return lines;
}

/** Build one bar row: `label  ████░░░░  value`. Exported for unit tests. */
export function formatBarLine(
  label: string,
  value: number,
  max: number,
  labelWidth: number,
  barWidth: number,
  formatValue: (v: number) => string,
): string {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled));
  return `${label.padEnd(labelWidth)}  ${bar}  ${formatValue(value)}`;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtSigned(n: number, isRate = false): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (isRate) return `${sign}${(abs * 100).toFixed(1)}pp`;
  return `${sign}${abs}`;
}
