/**
 * Differential comparison (E5): the same spec judged by `cairn run` and by
 * its exported Playwright test, with the same `CAIRN_RUN_TOKEN`. Pure: it
 * takes the two reduced sides and says precisely where they disagree.
 */
import type {
  ExportVerifyDifferentialSpec,
  ExportVerifyMismatch,
} from "../schema/exportVerify.v1";
import type {
  CairnSide,
  ExportSide,
  StepVerdict,
  Verdict,
} from "./exportVerifyRun";

/** Warn when slower/faster exceeds this and the gap is at least `MIN_GAP_MS`. */
export const DEFAULT_DURATION_RATIO = 3;
/** Below this absolute gap a ratio is browser start-up noise, not a finding. */
export const MIN_GAP_MS = 2000;

/** Group by id: an id that appears once is comparable, one that repeats is not. */
function uniqueById(steps: StepVerdict[]): {
  unique: Map<string, Verdict>;
  ambiguous: number;
} {
  const seen = new Map<string, Verdict[]>();
  for (const step of steps) {
    seen.set(step.id, [...(seen.get(step.id) ?? []), step.status]);
  }
  const unique = new Map<string, Verdict>();
  let ambiguous = 0;
  for (const [id, statuses] of seen) {
    if (statuses.length === 1) unique.set(id, statuses[0]!);
    else ambiguous += 1;
  }
  return { unique, ambiguous };
}

/** Export steps repeat the same title when an action is called twice; failed wins. */
function exportVerdicts(steps: StepVerdict[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const step of steps) {
    const prev = out.get(step.id);
    out.set(
      step.id,
      prev === "failed" || step.status === "failed" ? "failed" : "passed",
    );
  }
  return out;
}

export interface CompareInput {
  spec: string;
  testFile: string;
  cairn: CairnSide;
  export: ExportSide;
  /** Outcome ids in spec order (from the exported manifest's spec). */
  outcomeIds: string[];
  threshold: number;
}

function exportOverall(side: ExportSide): Verdict {
  if (side.status === "passed") return "passed";
  if (side.status === "skipped") return "skipped";
  return "failed";
}

export function compareSides(
  input: CompareInput,
): ExportVerifyDifferentialSpec {
  const { cairn, export: exp } = input;
  const base = {
    spec: input.spec,
    testFile: input.testFile,
    mismatches: [] as ExportVerifyMismatch[],
    warnings: [] as string[],
  };
  const cairnSummary = {
    status: cairn.status,
    ...(cairn.exitCode !== undefined ? { exitCode: cairn.exitCode } : {}),
    ...(cairn.durationMs !== undefined ? { durationMs: cairn.durationMs } : {}),
    ...(cairn.runDir ? { runDir: cairn.runDir } : {}),
  };
  const exportSummary = {
    status: exp.status,
    ...(exp.durationMs !== undefined ? { durationMs: exp.durationMs } : {}),
  };
  if (cairn.error) {
    return {
      ...base,
      status: "error",
      reason: cairn.error,
      cairn: cairnSummary,
      export: exportSummary,
    };
  }
  if (exp.error) {
    return {
      ...base,
      status: "error",
      reason: exp.error,
      cairn: cairnSummary,
      export: exportSummary,
    };
  }
  if (exp.status === "skipped" && !exp.fixme) {
    // A gated test runs everything else, then ends skipped: what it did
    // judge is compared first. The runner failing an outcome the export
    // passed (or the reverse) is a real mismatch, never hidden by the skip.
    const executed = executedMismatches(cairn, exp, input.outcomeIds);
    if (executed.length > 0) {
      return {
        ...base,
        status: "mismatch",
        reason: `the exported test ended skipped (a gated verifier or test.skip), but ${executed.length} verdict(s) it did judge differ from cairn run`,
        mismatches: executed,
        cairn: cairnSummary,
        export: exportSummary,
      };
    }
  }
  if (exp.status === "skipped" && cairn.status !== "passed") {
    // The export cannot show what failed: nothing is proven either way, and
    // the failure must not hide behind a skip.
    return {
      ...base,
      status: "inconclusive",
      reason: `cairn run ${cairn.status} while the exported test is ${
        exp.fixme
          ? "test.fixme (a hard skip in the export's coverage)"
          : "skipped (a gated verifier or test.skip)"
      }: the export cannot reproduce the failure`,
      warnings: [
        `cairn run ${cairn.status}, but the exported test is skipped and would not report it`,
      ],
      cairn: cairnSummary,
      export: exportSummary,
    };
  }
  if (exp.status === "skipped") {
    return {
      ...base,
      status: "skipped",
      reason: exp.fixme
        ? "the exported test is test.fixme (a hard skip recorded in the export's coverage)"
        : "the exported test ended skipped (a gated verifier or test.skip); nothing was judged",
      cairn: cairnSummary,
      export: exportSummary,
    };
  }
  if (exp.extraTests > 0) {
    base.warnings.push(
      `${exp.extraTests} other test(s) also matched the file filter and ran`,
    );
  }

  const mismatches = base.mismatches;
  const cairnVerdict: Verdict = cairn.status === "passed" ? "passed" : "failed";
  const exportVerdict = exportOverall(exp);
  if (cairnVerdict !== exportVerdict) {
    mismatches.push({
      kind: "verdict",
      cairn: cairn.status,
      export: exp.status,
      detail: `cairn run ${cairn.status}, the exported test ${exp.status}`,
    });
  }

  // Steps: comparable when the id appears once on the cairn side (action
  // steps repeat ids) and the export reports it as its own test.step.
  const cairnSteps = uniqueById(cairn.steps);
  const exportSteps = exportVerdicts(exp.steps);
  const outcomeSet = new Set(input.outcomeIds);
  let comparedSteps = 0;
  for (const [id, cairnStatus] of cairnSteps.unique) {
    if (outcomeSet.has(id)) continue;
    const exportStatus = exportSteps.get(id);
    if (exportStatus === undefined) continue;
    comparedSteps += 1;
    if ((cairnStatus === "failed") !== (exportStatus === "failed")) {
      mismatches.push({
        kind: "step",
        id,
        cairn: cairnStatus,
        export: exportStatus,
        detail: `step ${id}: cairn run ${cairnStatus}, the exported test ${exportStatus}`,
      });
    }
  }
  const unmappedCairn =
    [...cairnSteps.unique.keys()].filter(
      (id) => !outcomeSet.has(id) && !exportSteps.has(id),
    ).length + cairnSteps.ambiguous;
  const unmappedExport = [...exportSteps.keys()].filter(
    (id) => !outcomeSet.has(id) && !cairnSteps.unique.has(id),
  ).length;

  // Outcomes: every one the runner judged. An outcome the export never
  // reached is "skipped" when the test stopped earlier (a failed step),
  // otherwise the export is missing an assertion.
  const testStoppedEarly = exp.status !== "passed";
  let comparedOutcomes = 0;
  for (const outcome of cairn.outcomes) {
    const exportStatus = exportSteps.get(outcome.id);
    if (exportStatus === undefined) {
      if (outcome.status === "skipped" && testStoppedEarly) continue;
      if (testStoppedEarly) {
        mismatches.push({
          kind: "outcome",
          id: outcome.id,
          cairn: outcome.status,
          export: "skipped",
          detail: `outcome ${outcome.id}: cairn run ${outcome.status}, the exported test stopped before evaluating it`,
        });
      } else {
        mismatches.push({
          kind: "missing-outcome",
          id: outcome.id,
          cairn: outcome.status,
          export: "absent",
          detail: `outcome ${outcome.id}: cairn run ${outcome.status}, but the exported test has no step for it`,
        });
      }
      continue;
    }
    comparedOutcomes += 1;
    if (outcome.status !== exportStatus) {
      mismatches.push({
        kind: "outcome",
        id: outcome.id,
        cairn: outcome.status,
        export: exportStatus,
        detail: `outcome ${outcome.id}: cairn run ${outcome.status}, the exported test ${exportStatus}`,
      });
    }
  }

  // Network evidence: requests each side matched per network outcome.
  const network: Array<{ outcome: string; cairn: number; export: number }> = [];
  for (const [outcome, cairnCount] of Object.entries(cairn.network)) {
    const exportCount = exp.network[outcome];
    if (exportCount === undefined) continue;
    network.push({ outcome, cairn: cairnCount, export: exportCount });
    if ((cairnCount === 0) !== (exportCount === 0)) {
      mismatches.push({
        kind: "network",
        id: outcome,
        cairn: String(cairnCount),
        export: String(exportCount),
        detail: `network outcome ${outcome}: cairn run matched ${cairnCount} request(s), the exported test ${exportCount}`,
      });
    } else if (cairnCount !== exportCount) {
      base.warnings.push(
        `network outcome ${outcome}: request counts differ (cairn run ${cairnCount}, export ${exportCount}); both matched, so only the count moved`,
      );
    }
  }

  // Duration: report the ratio, warn on a large one that is not start-up noise.
  let durationRatio: number | undefined;
  if (
    cairn.durationMs &&
    exp.durationMs &&
    cairn.durationMs > 0 &&
    exp.durationMs > 0
  ) {
    durationRatio = Number((exp.durationMs / cairn.durationMs).toFixed(2));
    const slow = Math.max(cairn.durationMs, exp.durationMs);
    const fast = Math.min(cairn.durationMs, exp.durationMs);
    if (slow / fast > input.threshold && slow - fast >= MIN_GAP_MS) {
      base.warnings.push(
        `duration ratio ${(slow / fast).toFixed(1)}x exceeds ${input.threshold}x (cairn run ${cairn.durationMs}ms, export ${exp.durationMs}ms): the ${
          exp.durationMs > cairn.durationMs ? "export" : "runner"
        } is slower`,
      );
    }
  }

  const baselineFailed = cairn.status !== "passed";
  const status: ExportVerifyDifferentialSpec["status"] =
    mismatches.length > 0
      ? "mismatch"
      : baselineFailed
        ? "inconclusive"
        : "match";
  return {
    ...base,
    status,
    ...(status === "inconclusive"
      ? {
          reason: `cairn run itself ${cairn.status}: the two sides agree, but the app or the spec is unhealthy, so this proves nothing`,
        }
      : {}),
    cairn: cairnSummary,
    export: exportSummary,
    compared: { steps: comparedSteps, outcomes: comparedOutcomes },
    unmapped: { cairnSteps: unmappedCairn, exportSteps: unmappedExport },
    ...(network.length > 0 ? { network } : {}),
    ...(durationRatio !== undefined ? { durationRatio } : {}),
  };
}

/**
 * Verdicts an export that ended skipped DID judge (its test.step results)
 * that differ from cairn run's: steps whose id is unique on the runner's
 * side and outcomes, only where the export reported a step for the id.
 */
function executedMismatches(
  cairn: CairnSide,
  exp: ExportSide,
  outcomeIds: string[],
): ExportVerifyMismatch[] {
  const exportSteps = exportVerdicts(exp.steps);
  const outcomeSet = new Set(outcomeIds);
  const out: ExportVerifyMismatch[] = [];
  for (const [id, cairnStatus] of uniqueById(cairn.steps).unique) {
    if (outcomeSet.has(id)) continue;
    const exportStatus = exportSteps.get(id);
    if (exportStatus === undefined) continue;
    if ((cairnStatus === "failed") !== (exportStatus === "failed")) {
      out.push({
        kind: "step",
        id,
        cairn: cairnStatus,
        export: exportStatus,
        detail: `step ${id}: cairn run ${cairnStatus}, the exported test ${exportStatus} (before it ended skipped)`,
      });
    }
  }
  for (const outcome of cairn.outcomes) {
    const exportStatus = exportSteps.get(outcome.id);
    if (exportStatus === undefined || outcome.status === "skipped") continue;
    if (outcome.status !== exportStatus) {
      out.push({
        kind: "outcome",
        id: outcome.id,
        cairn: outcome.status,
        export: exportStatus,
        detail: `outcome ${outcome.id}: cairn run ${outcome.status}, the exported test ${exportStatus} (before it ended skipped)`,
      });
    }
  }
  return out;
}

export function summarizeDifferential(specs: ExportVerifyDifferentialSpec[]): {
  summary: Record<
    "match" | "mismatch" | "inconclusive" | "skipped" | "error",
    number
  >;
  status: "passed" | "failed" | "inconclusive";
} {
  const summary = {
    match: 0,
    mismatch: 0,
    inconclusive: 0,
    skipped: 0,
    error: 0,
  };
  for (const spec of specs) summary[spec.status] += 1;
  // error: a side could not run (an environment problem, exit 2 unless
  // something also failed); inconclusive: nothing was proven either way.
  const status =
    summary.mismatch > 0
      ? "failed"
      : summary.match === 0 || summary.error > 0
        ? "inconclusive"
        : "passed";
  return { summary, status };
}

/**
 * The cairn side of the differential is `cairn run --backend playwright`,
 * which fails an ambiguous locator. An export that kept the default
 * `.first()` can pass where that run fails, so a spec the run failed and
 * the export passed carries the way out. A strict export (`--strict-locators`)
 * judges locators like the run does: nothing to add.
 */
export function annotateLocatorMode(
  specs: ExportVerifyDifferentialSpec[],
  strictLocators: boolean,
): void {
  if (strictLocators) return;
  for (const result of specs) {
    if (
      result.status === "mismatch" &&
      result.cairn?.status === "failed" &&
      result.export?.status === "passed"
    ) {
      result.warnings.push(
        "cairn run (Playwright backend) is strict about an ambiguous locator and this export keeps .first() on every locator without nth: if the failing step's locator matches several elements, re-export with --strict-locators so the exported test fails there too",
      );
    }
  }
}
