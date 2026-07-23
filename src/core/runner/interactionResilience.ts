import type {
  ClickStep,
  ClickUntil,
  FillStep,
  Locator,
  Step,
  TypeStep,
} from "../schema/spec.v1";
import { clickLocator } from "../schema/spec.v1";
import { textContains } from "../textMatching";
import type {
  BrowserBackend,
  InvocationResult,
  ResolvedElement,
} from "../../adapters/browserBackend";

export const FILL_VERIFY_RETRIES = 3;
export const FILL_VERIFY_SETTLE_MS = 500;
export const CLICK_UNTIL_MAX_ATTEMPTS = 4;
export const DEFAULT_CLICK_UNTIL_TIMEOUT_MS = 30_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

const CLICK_RETRY_BACKOFF_MS = [250, 500, 1_000] as const;
const CONDITION_POLL_MS = 100;

/** Resolve config + environment precedence and reject unusable multipliers. */
export function resolveWaitScale(
  configured: number | undefined,
  envOverride: string | undefined,
): number {
  const raw = envOverride !== undefined ? envOverride : (configured ?? 1);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${
        envOverride !== undefined ? "CAIRN_WAIT_SCALE" : "waitScale"
      } must be a finite number greater than 0, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Scale authored wait budgets without changing scale=1 behavior. Defaults are
 * materialized only when a non-default scale needs to widen them.
 */
export function applyWaitScale(step: Step, waitScale: number): Step {
  if (waitScale === 1) return step;
  const scale = (value: number): number =>
    Math.max(1, Math.round(value * waitScale));

  if ("wait" in step) {
    return {
      ...step,
      wait: {
        ...step.wait,
        timeoutMs: scale(step.wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      },
    } as Step;
  }
  if ("open" in step && typeof step.open !== "string") {
    return {
      ...step,
      open: {
        ...step.open,
        timeoutMs: scale(step.open.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      },
    };
  }
  if ("click" in step && step.settleMs !== undefined) {
    return {
      ...step,
      settleMs: step.settleMs === 0 ? 0 : scale(step.settleMs),
    };
  }
  if ("batch" in step) {
    return {
      ...step,
      batch: step.batch.map((sub) => {
        if (!("wait" in sub)) return sub;
        return {
          ...sub,
          wait: {
            ...sub.wait,
            timeoutMs: scale(sub.wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          },
        };
      }),
    };
  }
  return step;
}

/**
 * Execute the interaction policies that must behave identically across
 * browser backends. Backends retain responsibility for strict locator
 * resolution and the actual browser action.
 */
export async function runResilientBrowserStep(
  step: Step,
  backend: BrowserBackend,
  waitScale: number,
): Promise<InvocationResult> {
  if ("fill" in step && step.verifyFill !== false) {
    return runVerifiedInputStep(step, backend, waitScale);
  }
  if ("type" in step && step.verifyFill !== false) {
    return runVerifiedInputStep(step, backend, waitScale);
  }
  if ("click" in step && step.click.until) {
    return runClickUntilStep(step, backend, waitScale);
  }
  return backend.runStep(step);
}

async function runVerifiedInputStep(
  step: FillStep | TypeStep,
  backend: BrowserBackend,
  waitScale: number,
): Promise<InvocationResult> {
  const expected = "fill" in step ? step.fill.value : step.type.value;
  const locator = inputLocator(step);
  let durationMs = 0;
  let lastResult: InvocationResult | undefined;
  let resolvedElement: ResolvedElement | undefined;
  let actual = "";
  let readError: string | undefined;

  for (let attempt = 0; attempt <= FILL_VERIFY_RETRIES; attempt++) {
    if (attempt > 0 && "type" in step) {
      const cleared = await backend.runStep(typeClearStep(step));
      durationMs += cleared.durationMs;
      resolvedElement = cleared.resolvedElement ?? resolvedElement;
      if (!cleared.ok)
        return mergeInvocation(cleared, durationMs, resolvedElement);
    }

    const result = await backend.runStep(step);
    durationMs += result.durationMs;
    lastResult = result;
    resolvedElement = result.resolvedElement ?? resolvedElement;
    if (!result.ok) return mergeInvocation(result, durationMs, resolvedElement);

    await waitForTimeout(
      backend,
      Math.max(1, Math.round(FILL_VERIFY_SETTLE_MS * waitScale)),
    );
    try {
      actual = await backend.getValue(locator);
      readError = undefined;
      if (actual === expected) {
        return {
          ...result,
          durationMs,
          ...(resolvedElement ? { resolvedElement } : {}),
          ...(attempt > 0
            ? {
                stderr: appendDiagnostic(
                  result.stderr,
                  `input value survived hydration after ${attempt + 1} attempts`,
                ),
              }
            : {}),
        };
      }
    } catch (error) {
      readError = (error as Error).message;
    }
  }

  const basis = lastResult ?? emptyFailure();
  const detail = readError
    ? `value could not be re-read: ${readError}`
    : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  return {
    ...basis,
    ok: false,
    exitCode: basis.exitCode === 0 ? 1 : basis.exitCode,
    durationMs,
    stderr: appendDiagnostic(
      basis.stderr,
      `hydration wiped value after ${FILL_VERIFY_RETRIES + 1} attempts: ${detail}`,
    ),
    ...(resolvedElement ? { resolvedElement } : {}),
  };
}

async function runClickUntilStep(
  step: ClickStep,
  backend: BrowserBackend,
  waitScale: number,
): Promise<InvocationResult> {
  const until = step.click.until!;
  const timeoutMs = Math.max(
    1,
    Math.round((until.timeoutMs ?? DEFAULT_CLICK_UNTIL_TIMEOUT_MS) * waitScale),
  );
  const deadline = Date.now() + timeoutMs;
  const baseStep: ClickStep = {
    ...step,
    click: clickLocator(step),
  };
  let durationMs = 0;
  let lastResult: InvocationResult | undefined;
  let resolvedElement: ResolvedElement | undefined;
  let lastObserved = "condition not checked";
  let clickAttempts = 0;

  for (let attempt = 0; attempt < CLICK_UNTIL_MAX_ATTEMPTS; attempt++) {
    const result = await backend.runStep(baseStep);
    clickAttempts++;
    durationMs += result.durationMs;
    lastResult = result;
    resolvedElement = result.resolvedElement ?? resolvedElement;
    if (!result.ok) return mergeInvocation(result, durationMs, resolvedElement);

    const remaining = Math.max(0, deadline - Date.now());
    const waitBudgetMs =
      attempt === CLICK_UNTIL_MAX_ATTEMPTS - 1
        ? remaining
        : Math.min(
            remaining,
            Math.max(
              1,
              Math.round(CLICK_RETRY_BACKOFF_MS[attempt]! * waitScale),
            ),
          );
    const observed = await waitForClickCondition(
      backend,
      until,
      waitBudgetMs,
      waitScale,
    );
    lastObserved = observed.detail;
    if (observed.ok) {
      return {
        ...result,
        durationMs,
        ...(resolvedElement ? { resolvedElement } : {}),
        ...(attempt > 0
          ? {
              stderr: appendDiagnostic(
                result.stderr,
                `click.until satisfied after ${attempt + 1} click attempts`,
              ),
            }
          : {}),
      };
    }
    if (Date.now() >= deadline) break;
  }

  const basis = lastResult ?? emptyFailure();
  return {
    ...basis,
    ok: false,
    exitCode: basis.exitCode === 0 ? 1 : basis.exitCode,
    durationMs,
    stderr: appendDiagnostic(
      basis.stderr,
      `click.until ${describeClickUntil(until)} was not satisfied after ${clickAttempts} click attempts within ${timeoutMs}ms (${lastObserved})`,
    ),
    ...(resolvedElement ? { resolvedElement } : {}),
  };
}

async function waitForClickCondition(
  backend: BrowserBackend,
  until: ClickUntil,
  waitBudgetMs: number,
  waitScale: number,
): Promise<{ ok: boolean; detail: string }> {
  let last = "condition not observed";
  let remaining = waitBudgetMs;
  for (;;) {
    try {
      const observed = await clickConditionHolds(backend, until);
      last = observed.detail;
      if (observed.ok) return observed;
    } catch (error) {
      last = `condition read failed: ${(error as Error).message}`;
    }
    if (remaining <= 0) return { ok: false, detail: last };
    const delay = Math.min(
      remaining,
      Math.max(1, Math.round(CONDITION_POLL_MS * waitScale)),
    );
    await waitForTimeout(backend, delay);
    remaining -= delay;
  }
}

async function clickConditionHolds(
  backend: BrowserBackend,
  until: ClickUntil,
): Promise<{ ok: boolean; detail: string }> {
  if ("selectorGone" in until) {
    const count = await backend.getCount(until.selectorGone);
    return { ok: count === 0, detail: `selector count was ${count}` };
  }
  if ("selector" in until) {
    const count = await backend.getCount(until.selector);
    return { ok: count > 0, detail: `selector count was ${count}` };
  }
  const text = await backend.getText("page");
  if ("text" in until) {
    const ok = textContains(text, until.text);
    return {
      ok,
      detail: `page text ${ok ? "contained" : "did not contain"} the target`,
    };
  }
  const ok = !textContains(text, until.notText);
  return {
    ok,
    detail: `page text ${
      ok ? "did not contain" : "still contained"
    } the target`,
  };
}

function inputLocator(step: FillStep | TypeStep): Locator {
  if ("fill" in step) {
    const { value: _value, ...locator } = step.fill;
    return locator as Locator;
  }
  const { value: _value, delayMs: _delayMs, ...locator } = step.type;
  return locator as Locator;
}

function typeClearStep(step: TypeStep): FillStep {
  const { value: _value, delayMs: _delayMs, ...locator } = step.type;
  return {
    fill: { ...locator, value: "" } as FillStep["fill"],
    verifyFill: false,
  };
}

function describeClickUntil(until: ClickUntil): string {
  if ("selectorGone" in until)
    return `selectorGone=${JSON.stringify(until.selectorGone)}`;
  if ("selector" in until) return `selector=${JSON.stringify(until.selector)}`;
  if ("text" in until) return `text=${JSON.stringify(until.text)}`;
  return `notText=${JSON.stringify(until.notText)}`;
}

function mergeInvocation(
  result: InvocationResult,
  durationMs: number,
  resolvedElement: ResolvedElement | undefined,
): InvocationResult {
  return {
    ...result,
    durationMs,
    ...(resolvedElement ? { resolvedElement } : {}),
  };
}

function appendDiagnostic(stderr: string, diagnostic: string): string {
  return [stderr.trim(), diagnostic].filter(Boolean).join("\n");
}

async function waitForTimeout(
  backend: BrowserBackend,
  timeoutMs: number,
): Promise<void> {
  await backend.waitForTimeout(timeoutMs);
}

function emptyFailure(): InvocationResult {
  return {
    ok: false,
    stdout: "",
    stderr: "",
    exitCode: 1,
    durationMs: 0,
    argv: [],
  };
}
