/**
 * E12: how much of a spec is opaque page JavaScript. An `eval` step cannot be
 * healed, reviewed as a Playwright action, or run without `bypassCSP` against
 * an app with a strict CSP, so the share of them is a number worth gating on:
 * `cairn export playwright --max-eval-ratio <0..1>` refuses a spec above it.
 *
 * Counted over the spec as it runs and exports: reusable actions expanded
 * (`use:` steps replaced by their steps), control-flow blocks (`if`,
 * `repeat`) walked into, the spec's `teardown:` steps included (they run in
 * the exported test too). A container step counts as one step. Typed steps
 * that evaluate in the page (`wait: { app }`) are not opaque, so they do not
 * count toward the ratio; they do count as page-eval sites for `bypassCSP`.
 */
import {
  teardownPlan,
  walkSteps,
  type Spec,
  type Step,
} from "../schema/spec.v1";

export interface EvalRatio {
  /** `eval` steps, including those inside expanded actions and blocks. */
  evalSteps: number;
  /** Every step in the same walk. */
  totalSteps: number;
  /** `evalSteps / totalSteps` (0 for a spec with no steps). */
  ratio: number;
}

export function evalStepRatio(
  spec: Pick<Spec, "steps"> & Partial<Pick<Spec, "teardown">>,
): EvalRatio {
  const steps = [
    ...walkSteps(spec.steps ?? []),
    ...walkSteps(teardownPlan(spec.teardown).steps),
  ];
  const evalSteps = steps.filter((step) => "eval" in step).length;
  return {
    evalSteps,
    totalSteps: steps.length,
    ratio: steps.length === 0 ? 0 : evalSteps / steps.length,
  };
}

/** `wait: { app }` (alone or in a wait.any / wait.all group): the check is string-evaluated in the page. */
function waitsOnApp(step: Step): boolean {
  if (!("wait" in step)) return false;
  const wait = step.wait as Record<string, unknown>;
  const conditions = Array.isArray(wait["any"])
    ? (wait["any"] as Array<Record<string, unknown>>)
    : Array.isArray(wait["all"])
      ? (wait["all"] as Array<Record<string, unknown>>)
      : [wait];
  return conditions.some((cond) => cond !== null && "app" in cond);
}

/**
 * Where a spec runs JavaScript in the page: `eval` steps, `wait: { app }`
 * checks (spec, expanded actions, teardown) and `script` outcomes without
 * `runtime: node`. Each is a string evaluation (`new AsyncFunction`) a
 * strict CSP blocks unless the host sets `bypassCSP`.
 */
export function pageEvalSites(
  spec: Pick<Spec, "steps" | "outcomes" | "teardown">,
): string[] {
  const sites: string[] = [];
  const steps = [
    ...walkSteps(spec.steps ?? []),
    ...walkSteps(teardownPlan(spec.teardown).steps),
  ];
  for (const step of steps) {
    if ("eval" in step) sites.push(`step ${step.id ?? "eval"}`);
    else if (waitsOnApp(step))
      sites.push(`step ${step.id ?? "wait"} (wait: { app })`);
  }
  for (const outcome of spec.outcomes) {
    const verify = outcome.verify as { script?: { runtime?: string } };
    if (verify.script && verify.script.runtime !== "node") {
      sites.push(`outcome ${outcome.id}`);
    }
  }
  return sites;
}

/** The spec is over the limit (an equal ratio passes). */
export function exceedsEvalRatio(ratio: EvalRatio, limit: number): boolean {
  return ratio.ratio > limit;
}

export function formatEvalRatio(ratio: EvalRatio): string {
  return `${ratio.evalSteps}/${ratio.totalSteps} step(s) (${Math.round(ratio.ratio * 100)}%)`;
}

/** The refusal message the export reports for a spec over the limit. */
export function evalRatioRefusal(
  name: string,
  ratio: EvalRatio,
  limit: number,
): string {
  return `spec ${name} refused: ${formatEvalRatio(ratio)} are page eval, over --max-eval-ratio ${limit} (${Math.round(limit * 100)}%); replace evals with typed steps (see \`cairn spec lint\`) or raise the limit`;
}

/** Parse `--max-eval-ratio` (a number in 0..1). */
export function parseMaxEvalRatio(
  raw: string | number | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    (typeof raw === "string" && raw.trim() === "") ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(
      `--max-eval-ratio must be a number between 0 and 1 (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}
