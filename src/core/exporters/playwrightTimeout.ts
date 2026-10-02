import type { Outcome, Spec, Step } from "../schema/spec.v1";

/**
 * Playwright defaults each test to 30 seconds. Exported Cairntrace specs get
 * an explicit timeout derived from their sequential step/outcome budgets.
 * The 30-minute floor is reserved for work that is legitimately slow and
 * whose authored budget is not the whole story: durable-processing node
 * verifiers (test budget) and long precondition commands (beforeAll budget).
 * A plain UI spec gets its derived budget, so a hung step fails in minutes,
 * not half an hour.
 */
export const PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** A precondition whose own budget reaches this is "long" (gets the floor). */
export const PLAYWRIGHT_LONG_PRECONDITION_MS = 5 * 60 * 1000;

const DEFAULT_STEP_BUDGET_MS = 30_000;
const DEFAULT_OUTCOME_BUDGET_MS = 30_000;
const DEFAULT_PRECONDITION_BUDGET_MS = 120_000;
/** Matches the exporter's `waitForResponse` default for postconditions. */
const DEFAULT_POSTCONDITION_BUDGET_MS = 30_000;
const MIN_OVERHEAD_MS = 60_000;
const OVERHEAD_RATIO = 0.1;

export type PlaywrightTimeoutFloorReason = "nodeVerifier" | "longPrecondition";

export interface PlaywrightTimeoutBudget {
  /** Sum of sequential authored/default operation budgets, before overhead. */
  declaredMs: number;
  /** Scheduling, module-load, assertion, and browser-operation headroom. */
  overheadMs: number;
  /** Final timeout emitted into generated Playwright source. */
  timeoutMs: number;
  /** True when the requested budget exceeded the four-hour safety ceiling. */
  capped: boolean;
  /** Why the 30-minute floor applied; absent when purely derived. */
  floorReason?: PlaywrightTimeoutFloorReason;
}

/**
 * Derive the timeout for one exported Playwright test.
 *
 * Steps and outcomes execute serially, so their budgets are summed rather than
 * maxed. A node file verifier contributes its full `script.timeoutMs`; this is
 * the important distinction for specs with several long-running observers.
 */
export function playwrightTestTimeoutBudget(
  spec: Spec,
): PlaywrightTimeoutBudget {
  const declaredMs = safeSum([
    ...(spec.steps ?? []).map((step) => stepBudgetMs(step, spec.settleMs)),
    ...spec.outcomes.map(outcomeBudgetMs),
  ]);
  return finishBudget(
    declaredMs,
    hasExportedNodeVerifier(spec) ? "nodeVerifier" : undefined,
  );
}

/**
 * `--project` executes a spec's executable (non-`echo`) precondition
 * commands in one beforeAll hook, which sets its own timeout from their
 * sequential budget.
 */
export function playwrightPreconditionTimeoutBudget(
  spec: Spec,
): PlaywrightTimeoutBudget {
  const budgets = (spec.preconditions?.commands ?? [])
    .filter((command) => !isDocumentaryPrecondition(commandRun(command)))
    .map((command) =>
      typeof command === "string"
        ? DEFAULT_PRECONDITION_BUDGET_MS
        : (command.timeoutMs ?? DEFAULT_PRECONDITION_BUDGET_MS),
    );
  const long = budgets.some(
    (budget) => budget >= PLAYWRIGHT_LONG_PRECONDITION_MS,
  );
  return finishBudget(safeSum(budgets), long ? "longPrecondition" : undefined);
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

/** One-line explanation emitted above `test.setTimeout(...)`. */
export function timeoutBudgetComment(budget: PlaywrightTimeoutBudget): string {
  if (budget.floorReason === "nodeVerifier") {
    return `Derived from sequential step/outcome budgets; 30m floor for durable node verifiers; 4h ceiling.`;
  }
  if (budget.floorReason === "longPrecondition") {
    return `Derived from sequential precondition budgets; 30m floor for long preconditions; 4h ceiling.`;
  }
  return `Derived from sequential step/outcome budgets (+10% headroom, at least 1m); 4h ceiling.`;
}

function finishBudget(
  declaredMs: number,
  floorReason?: PlaywrightTimeoutFloorReason,
): PlaywrightTimeoutBudget {
  const overheadMs = Math.max(
    MIN_OVERHEAD_MS,
    Math.ceil(declaredMs * OVERHEAD_RATIO),
  );
  const requestedMs = safeAdd(declaredMs, overheadMs);
  const floorMs = floorReason ? PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS : 0;
  return {
    declaredMs,
    overheadMs,
    timeoutMs: Math.min(
      PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS,
      Math.max(floorMs, requestedMs),
    ),
    capped: requestedMs > PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS,
    ...(floorReason ? { floorReason } : {}),
  };
}

/**
 * A documentary precondition is ONE plain `echo` that only states an
 * assumption ("demo-app must be running"). Exports never execute it, so any
 * shell control or substitution outside single quotes (`&&`, `||`, `;`,
 * `|`, `&`, newline, redirection, `$(…)`, backticks) makes the command
 * executable: `echo "resetting" && psql …` is a real reset that must run (or
 * be reported), never a note.
 */
export function isDocumentaryPrecondition(run: string): boolean {
  const command = run.trim();
  if (!/^echo(\s|$)/.test(command)) return false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") return false;
    if (ch === "$" && command[i + 1] === "(") return false;
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (";&|<>\n\r".includes(ch)) return false;
  }
  return quote === undefined;
}

function commandRun(command: string | { run: string }): string {
  return typeof command === "string" ? command : command.run;
}

function hasExportedNodeVerifier(spec: Spec): boolean {
  return spec.outcomes.some((outcome) => {
    const verifier = outcome.verify;
    return (
      "script" in verifier &&
      verifier.script.runtime === "node" &&
      verifier.script.file !== undefined
    );
  });
}

function stepBudgetMs(step: Step, specSettleMs: number | undefined): number {
  const actionMs = actionBudgetMs(step, specSettleMs);
  // A network postcondition is armed BEFORE the action and awaited after it,
  // so the step can take as long as the longer of the two deadlines.
  const postcondition = step.postcondition?.network;
  if (!postcondition || actionMs === 0) return actionMs;
  return Math.max(
    actionMs,
    postcondition.timeoutMs ?? DEFAULT_POSTCONDITION_BUDGET_MS,
  );
}

function actionBudgetMs(step: Step, specSettleMs: number | undefined): number {
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
    if ("ms" in step.wait) return step.wait.ms;
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
