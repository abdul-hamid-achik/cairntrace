import type { ProcessVerifier } from "../../schema/verifier.v1";
import type { ProcessMetricsSummary } from "../../monitor/processSampler";
import type { VerifierContext, VerifierEvaluation } from "./types";

function bytesToMb(bytes: number): number {
  return bytes / 1024 / 1024;
}

/**
 * Assert on monitor-reported browser process metrics collected by the
 * `--monitor` run sampler. Each present matcher must pass; the verifier
 * reports `skipped` (not `failed`) when no sampler ran, so a spec that
 * carries a process budget doesn't fail on every non-monitored run.
 *
 * RSS matchers (peakRss / meanRss / finalRss) compare against megabytes.
 * CPU matchers (peakCpu / meanCpu) compare against summed tree CPU percent.
 * `samples` compares against the number of successful sample points.
 */
export async function evaluateProcess(
  verifier: ProcessVerifier,
  ctx: VerifierContext = {},
): Promise<VerifierEvaluation> {
  const metrics = ctx.processMetrics;
  const m = verifier.process;
  if (!metrics) {
    return {
      passed: false,
      skipped: true,
      expected:
        "process metrics from a --monitor run (peak/mean RSS+CPU, samples)",
      actual:
        "no sampler ran — start the run with `--monitor` (or under MONITOR=1) to collect process metrics",
    };
  }
  const checks: Array<{
    label: string;
    actual: number;
    matcher: { below?: number; atLeast?: number; equals?: number };
    unit: string;
  }> = [];
  if (m.peakRss)
    checks.push({
      label: "peakRss",
      actual: bytesToMb(metrics.peakRssBytes),
      matcher: m.peakRss,
      unit: "MB",
    });
  if (m.meanRss)
    checks.push({
      label: "meanRss",
      actual: bytesToMb(metrics.meanRssBytes),
      matcher: m.meanRss,
      unit: "MB",
    });
  if (m.finalRss)
    checks.push({
      label: "finalRss",
      actual: bytesToMb(metrics.finalRssBytes),
      matcher: m.finalRss,
      unit: "MB",
    });
  if (m.peakCpu)
    checks.push({
      label: "peakCpu",
      actual: metrics.peakCpuPercent,
      matcher: m.peakCpu,
      unit: "%",
    });
  if (m.meanCpu)
    checks.push({
      label: "meanCpu",
      actual: metrics.meanCpuPercent,
      matcher: m.meanCpu,
      unit: "%",
    });
  if (m.samples)
    checks.push({
      label: "samples",
      actual: metrics.samples.length,
      matcher: m.samples,
      unit: "",
    });

  if (checks.length === 0) {
    return {
      passed: false,
      expected: "at least one process metric matcher (peakRss, meanCpu, …)",
      actual: "no matchers provided",
    };
  }

  const failures: string[] = [];
  const observed: string[] = [];
  for (const c of checks) {
    const { below, atLeast, equals } = c.matcher;
    const actualStr = `${c.actual.toFixed(c.unit === "MB" ? 1 : 2)}${c.unit}`;
    observed.push(`${c.label}=${actualStr}`);
    if (below !== undefined && !(c.actual < below)) {
      failures.push(`${c.label} ${actualStr} not below ${below}${c.unit}`);
    } else if (atLeast !== undefined && !(c.actual >= atLeast)) {
      failures.push(`${c.label} ${actualStr} not at least ${atLeast}${c.unit}`);
    } else if (equals !== undefined && !(Math.abs(c.actual - equals) < 1e-9)) {
      failures.push(`${c.label} ${actualStr} not equal to ${equals}${c.unit}`);
    }
  }

  const expected = checks
    .map((c) => {
      const { below, atLeast, equals } = c.matcher;
      const op =
        below !== undefined
          ? `below ${below}${c.unit}`
          : atLeast !== undefined
            ? `at least ${atLeast}${c.unit}`
            : `equals ${equals}${c.unit}`;
      return `${c.label} ${op}`;
    })
    .join("; ");

  if (failures.length === 0) {
    return {
      passed: true,
      expected,
      actual: observed.join("; "),
    };
  }
  return {
    passed: false,
    expected,
    actual: failures.join("; "),
  };
}

/** Re-exported so the dispatcher can pass the summary type without import churn. */
export type { ProcessMetricsSummary };
