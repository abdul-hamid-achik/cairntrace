import type { Outcome, Spec, Step } from "../schema/spec.v1";

/**
 * Playwright defaults each test to 30 seconds. Exported Cairntrace specs often
 * contain durable-processing verifiers whose authored budgets are measured in
 * minutes, so every generated test gets an explicit derived timeout instead.
 */
export const PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const DEFAULT_STEP_BUDGET_MS = 30_000;
const DEFAULT_OUTCOME_BUDGET_MS = 30_000;
const DEFAULT_PRECONDITION_BUDGET_MS = 120_000;
const MIN_OVERHEAD_MS = 60_000;
const OVERHEAD_RATIO = 0.1;

export interface PlaywrightTimeoutBudget {
  /** Sum of sequential authored/default operation budgets, before overhead. */
  declaredMs: number;
  /** Scheduling, module-load, assertion, and browser-operation headroom. */
  overheadMs: number;
  /** Final timeout emitted into generated Playwright source. */
  timeoutMs: number;
  /** True when the requested budget exceeded the four-hour safety ceiling. */
  capped: boolean;
}

/**
 * Derive the timeout for one exported Playwright test.
 *
 * Steps and outcomes execute serially, so their budgets are summed rather than
 * maxed. A node file verifier contributes its full `script.timeoutMs`; this is
 * the important distinction for specs with several long Temporal observers.
 */
export function playwrightTestTimeoutBudget(
  spec: Spec,
): PlaywrightTimeoutBudget {
  const declaredMs = safeSum([
    ...(spec.steps ?? []).map((step) => stepBudgetMs(step, spec.settleMs)),
    ...spec.outcomes.map(outcomeBudgetMs),
  ]);
  return finishBudget(declaredMs);
}

/**
 * `--project` executes all precondition commands for a spec in one beforeAll
 * hook. Its config timeout therefore also needs their sequential budget.
 */
export function playwrightPreconditionTimeoutBudget(
  spec: Spec,
): PlaywrightTimeoutBudget {
  const declaredMs = safeSum(
    (spec.preconditions?.commands ?? []).map((command) =>
      typeof command === "string"
        ? DEFAULT_PRECONDITION_BUDGET_MS
        : (command.timeoutMs ?? DEFAULT_PRECONDITION_BUDGET_MS),
    ),
  );
  return finishBudget(declaredMs);
}

/** Maximum test/hook budget used as the generated project's config fallback. */
export function playwrightProjectTimeoutBudget(
  specs: Spec[],
): PlaywrightTimeoutBudget {
  const budgets = specs.flatMap((spec) => [
    playwrightTestTimeoutBudget(spec),
    playwrightPreconditionTimeoutBudget(spec),
  ]);
  if (budgets.length === 0) return finishBudget(0);

  const winner = budgets.reduce((max, budget) =>
    budget.timeoutMs > max.timeoutMs ? budget : max,
  );
  return {
    ...winner,
    capped: budgets.some((budget) => budget.capped),
  };
}

function finishBudget(declaredMs: number): PlaywrightTimeoutBudget {
  const overheadMs = Math.max(
    MIN_OVERHEAD_MS,
    Math.ceil(declaredMs * OVERHEAD_RATIO),
  );
  const requestedMs = safeAdd(declaredMs, overheadMs);
  return {
    declaredMs,
    overheadMs,
    timeoutMs: Math.min(
      PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS,
      Math.max(PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS, requestedMs),
    ),
    capped: requestedMs > PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS,
  };
}

function stepBudgetMs(step: Step, specSettleMs: number | undefined): number {
  if ("batch" in step) {
    return safeSum(
      step.batch.map((subStep) =>
        stepBudgetMs(subStep as unknown as Step, specSettleMs),
      ),
    );
  }

  // These constructs are comments/skips in Playwright output and consume no
  // generated-test time. Project mode derives from parsed.resolved, so `use:`
  // normally never reaches this branch.
  if (
    "snapshot" in step ||
    "transform" in step ||
    "monitor" in step ||
    "use" in step
  ) {
    return 0;
  }

  if ("open" in step) {
    return typeof step.open === "string"
      ? DEFAULT_STEP_BUDGET_MS
      : (step.open.timeoutMs ?? DEFAULT_STEP_BUDGET_MS);
  }
  if ("click" in step) {
    const actionMs = step.click.until?.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
    const settleMs = step.settleMs ?? specSettleMs ?? 0;
    // click.until can settle after each of its four attempts.
    return safeAdd(actionMs, settleMs * (step.click.until ? 4 : 1));
  }
  if ("download" in step) {
    return Math.max(
      DEFAULT_STEP_BUDGET_MS,
      step.download.timeoutMs ?? DEFAULT_STEP_BUDGET_MS,
    );
  }
  if ("wait" in step) {
    return step.wait.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
  }
  if ("request" in step) {
    return step.request.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
  }
  if ("eval" in step) {
    return step.eval.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
  }

  return DEFAULT_STEP_BUDGET_MS;
}

function outcomeBudgetMs(outcome: Outcome): number {
  const verifier = outcome.verify;
  if ("script" in verifier) {
    // Only node+file and browser+inline scripts are emitted. The other two
    // combinations become coverage skips and must not inflate the test.
    const exported =
      (verifier.script.runtime === "node" &&
        verifier.script.file !== undefined) ||
      (verifier.script.runtime !== "node" &&
        verifier.script.file === undefined);
    if (!exported) return 0;
    return verifier.script.timeoutMs ?? DEFAULT_OUTCOME_BUDGET_MS;
  }

  // These verifier kinds are currently coverage skips in the exporter.
  if ("file" in verifier || "xlsx" in verifier || "process" in verifier) {
    return 0;
  }

  return DEFAULT_OUTCOME_BUDGET_MS;
}

function safeSum(values: number[]): number {
  return values.reduce(safeAdd, 0);
}

function safeAdd(left: number, right: number): number {
  const boundedRight = Number.isFinite(right)
    ? Math.max(0, right)
    : Number.MAX_SAFE_INTEGER;
  if (left >= Number.MAX_SAFE_INTEGER - boundedRight) {
    return Number.MAX_SAFE_INTEGER;
  }
  return left + boundedRight;
}
