import type {
  InvocationPlannedRun,
  InvocationSummary,
} from "../../core/schema/events.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type { ExitCode } from "../../core/schema/shared";
import { parseLabelFlags } from "../../core/stats/runStats";
import type { ScopedSecrets } from "../commands/secrets";
import {
  describeIteration,
  iterationEnv,
  iterationLabels,
  type RunIteration,
} from "../commands/runMatrix";

/* ----- --repeat / --matrix iteration helpers ----- */

export interface IterationSummary {
  it: RunIteration;
  exitCode: ExitCode;
  results: RunResult[];
  note?: string;
}

/** Every planned spec run: specs × iterations, labeled per iteration. */
export function planInvocationRuns(
  specs: readonly string[],
  iterations: readonly RunIteration[],
  multiRun: boolean,
): InvocationPlannedRun[] {
  const planned: InvocationPlannedRun[] = [];
  for (const it of iterations) {
    const labels = multiRun ? parseLabelFlags(iterationLabels(it)) : {};
    for (const spec of specs) {
      planned.push({
        index: planned.length + 1,
        spec,
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
      });
    }
  }
  return planned;
}

/** The invocation's final summary, from the per-iteration result rows. */
export function buildInvocationSummary(
  rows: readonly IterationSummary[],
  input: {
    exitCode: ExitCode;
    durationMs: number;
    multiRun: boolean;
    error?: string;
  },
): InvocationSummary {
  const results = rows.flatMap((row) => row.results);
  const count = (status: RunResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const refused = count("refused");
  return {
    total: results.length,
    passed: count("passed"),
    failed: count("failed"),
    errored: count("errored"),
    // Additive: only when the environment policy refused a spec.
    ...(refused > 0 ? { refused } : {}),
    durationMs: Math.max(0, input.durationMs),
    exitCode: input.exitCode,
    ...(input.multiRun
      ? {
          iterations: rows.map((row) => ({
            index: row.it.index,
            label: describeIteration(row.it),
            exitCode: row.exitCode,
            specs: row.results.length,
            passed: row.results.filter((r) => r.status === "passed").length,
            ...(row.note ? { note: row.note } : {}),
          })),
        }
      : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

/** Overlay one iteration's CAIRN_MATRIX_<KEY> and CAIRN_REPEAT vars onto the secrets env. */
export function withIterationEnv(
  secrets: ScopedSecrets,
  it: RunIteration,
): ScopedSecrets {
  const extra = iterationEnv(it);
  if (Object.keys(extra).length === 0) return secrets;
  return {
    ...secrets,
    env: { ...secrets.env, ...extra },
    childEnv: { ...secrets.childEnv, ...extra },
  };
}

const EXIT_SEVERITY: Record<number, number> = {
  0: 0,
  7: 0.5,
  2: 1,
  1: 2,
  6: 3,
};

/**
 * Most severe exit wins: 6 (contract changed) > 1 (failed) > 2 (errored) >
 * 7 (refused by the environment policy) > 0.
 */
export function mergeExitCodes(
  current: ExitCode,
  next: ExitCode,
  first: boolean,
): ExitCode {
  if (first) return next;
  return (EXIT_SEVERITY[next] ?? 1) > (EXIT_SEVERITY[current] ?? 1)
    ? next
    : current;
}

/** Plain-text end-of-run summary for --repeat/--matrix (printed to stderr). */
export function renderIterationSummary(
  rows: IterationSummary[],
  planned: number,
): string {
  const lines = [`Summary: ${rows.length}/${planned} run(s) executed`];
  let ok = 0;
  for (const r of rows) {
    if (r.exitCode === 0) ok += 1;
    const specs = r.results.length;
    const passed = r.results.filter((x) => x.status === "passed").length;
    // A refused spec has no run directory (its runDir is synthetic).
    const dirs = r.results
      .filter((x) => x.status !== "refused")
      .map((x) => x.runDir)
      .join(", ");
    lines.push(
      `  ${
        r.exitCode === 0 ? "PASS" : "FAIL"
      } #${r.it.index} ${describeIteration(r.it)}` +
        ` exit=${r.exitCode}` +
        (specs > 0 ? ` specs=${passed}/${specs}` : "") +
        (r.note ? ` (${r.note})` : "") +
        (dirs ? ` ${dirs}` : ""),
    );
  }
  lines.push(`  ${ok} passed, ${rows.length - ok} failed`);
  return lines.join("\n");
}
