import {
  DEFAULT_REQUEST_RETRY_DELAY_MS,
  DEFAULT_REQUEST_UNTIL_TIMEOUT_MS,
  matrixCombinationCount,
} from "../schema/request.v1";
import {
  isBuiltinLoginUse,
  teardownPlan,
  type Outcome,
  type Spec,
  type Step,
} from "../schema/spec.v1";
import { verifierPoll } from "../schema/verifier.v1";
import { comment, raw, type Stmt } from "./codegen";
import type { ExportVerifiersMode } from "./exportModes";

/**
 * Playwright defaults each test to 30 seconds. Exported Cairntrace specs get
 * an explicit timeout derived from their sequential step/outcome budgets.
 * The 30-minute floor is reserved for work that is legitimately slow and
 * whose authored budget is not the whole story: durable-processing node
 * verifiers (test budget) and long precondition commands (beforeAll budget).
 * It depends on what the export EMITS: with `--verifiers drop` (or no node
 * file verifier) no test gets it, and a precondition that is not run
 * (`skip` / `manifest` / `global`) never reaches a beforeAll budget. A plain
 * UI spec gets its derived budget, so a hung step fails in minutes, not half
 * an hour.
 */
export const PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** A precondition whose own budget reaches this is "long" (gets the floor). */
export const PLAYWRIGHT_LONG_PRECONDITION_MS = 5 * 60 * 1000;

const DEFAULT_STEP_BUDGET_MS = 30_000;
const DEFAULT_OUTCOME_BUDGET_MS = 30_000;
/** The `http` verifier's per-request deadline (`requestTimeoutMs`). */
const DEFAULT_HTTP_VERIFIER_BUDGET_MS = 15_000;
/** The `file` verifier's wait (`timeoutMs`). */
const DEFAULT_FILE_VERIFIER_BUDGET_MS = 10_000;
/** `value` / `xlsx` judge data the test already holds. */
const DEFAULT_DATA_VERIFIER_BUDGET_MS = 5_000;
const DEFAULT_PRECONDITION_BUDGET_MS = 120_000;
/** Matches the exporter's `waitForResponse` default for postconditions. */
const DEFAULT_POSTCONDITION_BUDGET_MS = 30_000;
const MIN_OVERHEAD_MS = 60_000;
const OVERHEAD_RATIO = 0.1;

export type PlaywrightTimeoutFloorReason = "nodeVerifier" | "longPrecondition";

/** What the export emits, so the budget covers exactly that. */
export interface TimeoutBudgetOptions {
  /** `--verifiers`: `drop` removes node / datasource verifiers. */
  verifiers?: ExportVerifiersMode;
  /** `--preconditions inline|global`: `run:` steps and teardown are emitted. */
  hostCommands?: boolean;
}

const DEFAULT_RUN_STEP_BUDGET_MS = 120_000;
const DEFAULT_CAPTURE_BUDGET_MS = 5_000;

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
  options: TimeoutBudgetOptions = {},
): PlaywrightTimeoutBudget {
  const verifiers = options.verifiers ?? "keep";
  const teardown = options.hostCommands
    ? teardownPlan(spec.teardown)
    : undefined;
  const declaredMs = safeSum([
    ...(spec.steps ?? []).map((step) =>
      stepBudgetMs(step, spec.settleMs, options),
    ),
    ...spec.outcomes.map((outcome) => outcomeBudgetMs(outcome, verifiers)),
    // The teardown runs in the test body's `finally`: its items count, bounded
    // by the teardown's own budget.
    ...(teardown && teardown.steps.length > 0
      ? [
          Math.min(
            teardown.timeoutMs,
            safeSum(
              teardown.steps.map((step) =>
                stepBudgetMs(step, spec.settleMs, options),
              ),
            ),
          ),
        ]
      : []),
  ]);
  return finishBudget(
    declaredMs,
    hasExportedNodeVerifier(spec, verifiers) ? "nodeVerifier" : undefined,
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
  /** Preconditions run in each file's beforeAll (their budget counts). */
  options: TimeoutBudgetOptions & {
    inlinePreconditions?: boolean;
  } = {},
): PlaywrightTimeoutBudget {
  const budgets = specs.flatMap((spec) => [
    playwrightTestTimeoutBudget(spec, options),
    ...(options.inlinePreconditions === false
      ? []
      : [playwrightPreconditionTimeoutBudget(spec)]),
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

/**
 * The statements that set a test's (or hook's) timeout. Without a host
 * profile: the derived budget comment and `test.setTimeout(...)`. Against a
 * host whose own `timeout` already covers the budget, no call at all: the
 * generated test inherits what the host configured and never fights it. A
 * budget above the host's still sets the timeout, and says why.
 */
export function setTimeoutStmts(
  budget: PlaywrightTimeoutBudget,
  explanation: string,
  hostTimeoutMs?: number,
): Stmt[] {
  if (hostTimeoutMs === undefined) {
    return [comment(explanation), raw(`test.setTimeout(${budget.timeoutMs});`)];
  }
  if (budget.timeoutMs <= hostTimeoutMs) {
    return [
      comment(
        `The host's test timeout (${hostTimeoutMs}ms) covers the derived budget (${budget.timeoutMs}ms); it is not overridden.`,
      ),
    ];
  }
  return [
    comment(explanation),
    comment(
      `Above the host's test timeout (${hostTimeoutMs}ms): raised for this spec only.`,
    ),
    raw(`test.setTimeout(${budget.timeoutMs});`),
  ];
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

function hasExportedNodeVerifier(
  spec: Spec,
  verifiers: ExportVerifiersMode,
): boolean {
  if (verifiers === "drop") return false;
  return spec.outcomes.some((outcome) => {
    const verifier = outcome.verify;
    return (
      "script" in verifier &&
      verifier.script.runtime === "node" &&
      verifier.script.file !== undefined
    );
  });
}

function stepBudgetMs(
  step: Step,
  specSettleMs: number | undefined,
  options: TimeoutBudgetOptions,
): number {
  const actionMs = actionBudgetMs(step, specSettleMs, options);
  // A network postcondition is armed BEFORE the action and awaited after it,
  // so the step can take as long as the longer of the two deadlines.
  const postcondition = step.postcondition?.network;
  if (!postcondition || actionMs === 0) return actionMs;
  return Math.max(
    actionMs,
    postcondition.timeoutMs ?? DEFAULT_POSTCONDITION_BUDGET_MS,
  );
}

function actionBudgetMs(
  step: Step,
  specSettleMs: number | undefined,
  options: TimeoutBudgetOptions,
): number {
  // F14 control flow: a loop can run its body every iteration / attempt;
  // an if runs the longer branch.
  const listMs = (steps: readonly Step[]): number =>
    safeSum(steps.map((nested) => stepBudgetMs(nested, specSettleMs, options)));
  if ("repeat" in step) {
    return safeMul(listMs(step.repeat.steps), step.repeat.max);
  }
  if ("if" in step) {
    return Math.max(listMs(step.if.then), listMs(step.if.else ?? []));
  }
  if ("use" in step && typeof step.use !== "string" && step.use.retry) {
    const nested = (step as { steps?: Step[] }).steps;
    if (!nested) return 0;
    const { times, delayMs = 0 } = step.use.retry;
    return safeAdd(safeMul(listMs(nested), times + 1), safeMul(delayMs, times));
  }
  if ("wait" in step && ("any" in step.wait || "all" in step.wait)) {
    return step.wait.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
  }
  if ("batch" in step) {
    return safeSum(
      step.batch.map((subStep) =>
        stepBudgetMs(subStep as unknown as Step, specSettleMs, options),
      ),
    );
  }

  // F18: the built-in login — a probe, the login and its follow-ups.
  if (isBuiltinLoginUse(step)) return safeMul(DEFAULT_STEP_BUDGET_MS, 3);

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

  // E10: a run step exports only through the host-command helper.
  if ("run" in step) {
    if (!options.hostCommands) return 0;
    return (
      (typeof step.run === "string" ? undefined : step.run.timeoutMs) ??
      DEFAULT_RUN_STEP_BUDGET_MS
    );
  }
  if ("capture" in step) {
    return step.capture.timeoutMs ?? DEFAULT_CAPTURE_BUDGET_MS;
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
    const r = step.request;
    const each = r.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
    // F18: an until polls for its own budget (plus the last attempt); a
    // retry sends up to times + 1; a matrix sends one per combination.
    if (r.until) {
      return safeAdd(
        r.until.timeoutMs ?? DEFAULT_REQUEST_UNTIL_TIMEOUT_MS,
        each,
      );
    }
    const attempts = 1 + (r.retry?.times ?? 0);
    const one = safeAdd(
      safeMul(each, attempts),
      safeMul(r.retry?.delayMs ?? DEFAULT_REQUEST_RETRY_DELAY_MS, attempts - 1),
    );
    return r.matrix ? safeMul(one, matrixCombinationCount(r.matrix)) : one;
  }
  if ("eval" in step) {
    return step.eval.timeoutMs ?? DEFAULT_STEP_BUDGET_MS;
  }
  // F15: one widget op per field, each bounded by its own budget.
  if ("form" in step) {
    return safeSum(
      Object.values(step.form.fields).map(
        (field) =>
          (typeof field === "object" &&
          field !== null &&
          !Array.isArray(field) &&
          "value" in field
            ? field.timeoutMs
            : undefined) ??
          step.form.timeoutMs ??
          WIDGET_STEP_BUDGET_MS,
      ),
    );
  }
  for (const key of ["set", "check", "uncheck", "choose"] as const) {
    if (key in step) {
      const target = (step as Record<string, { timeoutMs?: number }>)[key]!;
      return target.timeoutMs ?? WIDGET_STEP_BUDGET_MS;
    }
  }

  return DEFAULT_STEP_BUDGET_MS;
}

/** Default in-page budget of one widget field (mount + write + read back). */
const WIDGET_STEP_BUDGET_MS = 10_000;

function outcomeBudgetMs(
  outcome: Outcome,
  verifiers: ExportVerifiersMode,
): number {
  const base = outcomeAttemptBudgetMs(outcome, verifiers);
  if (base === 0) return 0;
  // A polled outcome re-runs until it holds or its `timeoutMs` passes.
  const poll = verifierPoll(outcome.verify);
  return poll ? safeAdd(base, poll.timeoutMs) : base;
}

function outcomeAttemptBudgetMs(
  outcome: Outcome,
  verifiers: ExportVerifiersMode,
): number {
  const verifier = outcome.verify;
  if ("script" in verifier) {
    // Only node+file and browser+inline scripts are emitted. The other two
    // combinations become coverage skips and must not inflate the test;
    // `--verifiers drop` removes the node ones.
    const exported =
      (verifier.script.runtime === "node" &&
        verifier.script.file !== undefined &&
        verifiers !== "drop") ||
      (verifier.script.runtime !== "node" &&
        verifier.script.file === undefined);
    if (!exported) return 0;
    return verifier.script.timeoutMs ?? DEFAULT_OUTCOME_BUDGET_MS;
  }

  // `process`, `mongo` and `temporal` have no translation (coverage skips).
  if ("process" in verifier || "mongo" in verifier || "temporal" in verifier) {
    return 0;
  }
  // `http` sends a request per attempt (`--verifiers drop` removes it);
  // `file` waits for the file; `value` / `xlsx` judge what the test holds.
  if ("http" in verifier) {
    return verifiers === "drop"
      ? 0
      : (verifier.http.requestTimeoutMs ?? DEFAULT_HTTP_VERIFIER_BUDGET_MS);
  }
  if ("file" in verifier) {
    return verifier.file.timeoutMs ?? DEFAULT_FILE_VERIFIER_BUDGET_MS;
  }
  if ("value" in verifier || "xlsx" in verifier) {
    return DEFAULT_DATA_VERIFIER_BUDGET_MS;
  }
  // The table verifier waits for the rendered table (default 5s).
  if ("table" in verifier) return verifier.table.timeoutMs ?? 5_000;

  return DEFAULT_OUTCOME_BUDGET_MS;
}

function safeSum(values: number[]): number {
  return values.reduce(safeAdd, 0);
}

function safeMul(value: number, times: number): number {
  let total = 0;
  for (let i = 0; i < times; i++) total = safeAdd(total, value);
  return total;
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
