import type {
  ClickStep,
  ClickUntil,
  FillStep,
  Locator,
  NetworkPostcondition,
  Step,
  TypeStep,
  WaitStep,
} from "../schema/spec.v1";
import { clickLocator, withoutPostcondition } from "../schema/spec.v1";
import { describeWaitUrl, matchWaitUrl } from "../locators";
import { textContains } from "../textMatching";
import {
  DEFAULT_NETWORK_POSTCONDITION_TIMEOUT_MS,
  NETWORK_POSTCONDITION_POLL_MS,
  describeNetworkPostcondition,
  matchesNetworkPostcondition,
  networkEntryKey,
  networkPostconditionFromStep,
} from "../networkPostcondition";
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
export const VALUE_WAIT_POLL_MS = 100;

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

  if (step.postcondition?.network) {
    return {
      ...step,
      postcondition: {
        network: {
          ...step.postcondition.network,
          timeoutMs: scale(
            step.postcondition.network.timeoutMs ??
              DEFAULT_NETWORK_POSTCONDITION_TIMEOUT_MS,
          ),
        },
      },
    } as Step;
  }

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
  const postcondition = networkPostconditionFromStep(step);
  if (postcondition !== undefined) {
    return runNetworkPostconditionStep(step, postcondition, backend, waitScale);
  }
  if ("fill" in step && step.verifyFill !== false) {
    return runVerifiedInputStep(step, backend, waitScale);
  }
  if ("type" in step && step.verifyFill !== false) {
    return runVerifiedInputStep(step, backend, waitScale);
  }
  if ("click" in step && step.click.until) {
    return runClickUntilStep(step, backend, waitScale);
  }
  if ("wait" in step && "value" in step.wait) {
    return runWaitValueStep(step, backend);
  }
  if ("wait" in step && "url" in step.wait) {
    return runWaitUrlStep(step, backend);
  }
  return backend.runStep(step);
}

/**
 * Run exactly one browser mutation, then wait for its network response.
 *
 * This deliberately bypasses fill hydration retries and click-until retries:
 * once a postcondition is attached, repeating the mutation could create a
 * duplicate upload, duplicate event, or duplicate server-side effect.
 */
async function runNetworkPostconditionStep(
  step: Step,
  postcondition: NetworkPostcondition,
  backend: BrowserBackend,
  waitScale: number,
): Promise<InvocationResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(
    1,
    Math.round(
      (postcondition.timeoutMs ?? DEFAULT_NETWORK_POSTCONDITION_TIMEOUT_MS) *
        waitScale,
    ),
  );
  const action = withoutPostcondition(step);

  if (backend.runStepWithNetworkPostcondition) {
    return backend.runStepWithNetworkPostcondition(action, {
      ...postcondition,
      timeoutMs,
    });
  }

  let before: Awaited<ReturnType<BrowserBackend["getNetworkRequests"]>>;
  try {
    before = await backend.getNetworkRequests();
  } catch (error) {
    return postconditionFailure(
      startedAt,
      `could not arm network postcondition: ${(error as Error).message}`,
    );
  }
  const armedAt = Date.now();
  const baselineCounts = countEntries(before);

  // Important: direct backend dispatch, intentionally bypassing all mutation
  // retry policies. The action is invoked once even if the response times out.
  const actionResult = await backend.runStep(action);
  if (!actionResult.ok) return actionResult;

  const deadline = armedAt + timeoutMs;
  for (;;) {
    let observed: Awaited<ReturnType<BrowserBackend["getNetworkRequests"]>>;
    try {
      observed = await backend.getNetworkRequests();
    } catch (error) {
      return postconditionFailure(
        startedAt,
        `could not observe network postcondition after the action: ${(error as Error).message}`,
      );
    }
    const match = observed.find((entry, index) => {
      if (!matchesNetworkPostcondition(entry, postcondition)) return false;
      if (entry.timestamp !== undefined) return entry.timestamp >= armedAt;
      return (
        index >= before.length ||
        (countEntries(observed).get(networkEntryKey(entry)) ?? 0) >
          (baselineCounts.get(networkEntryKey(entry)) ?? 0)
      );
    });
    if (match) {
      return {
        ...actionResult,
        durationMs: Date.now() - startedAt,
        stdout: `network postcondition matched ${describeNetworkPostcondition(postcondition)}`,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await backend.waitForTimeout(
      Math.min(NETWORK_POSTCONDITION_POLL_MS, remaining),
    );
  }

  return postconditionFailure(
    startedAt,
    `network postcondition timed out after ${timeoutMs}ms: ${describeNetworkPostcondition(postcondition)}`,
  );
}

function countEntries(
  entries: Awaited<ReturnType<BrowserBackend["getNetworkRequests"]>>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = networkEntryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function postconditionFailure(
  startedAt: number,
  error: string,
): InvocationResult {
  return {
    ok: false,
    stdout: "",
    stderr: error,
    exitCode: 1,
    durationMs: Date.now() - startedAt,
    argv: [],
  };
}

async function runWaitValueStep(
  step: WaitStep,
  backend: BrowserBackend,
): Promise<InvocationResult> {
  if (!("value" in step.wait)) return backend.runStep(step);

  const { equals, ...locator } = step.wait.value;
  const timeoutMs = step.wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  let remaining = timeoutMs;
  let actual = "";
  let readError: string | undefined;

  for (;;) {
    try {
      actual = await backend.getValue(locator as Locator);
      readError = undefined;
      if (actual === equals) {
        return {
          ok: true,
          stdout: actual,
          stderr: "",
          exitCode: 0,
          durationMs: timeoutMs - remaining,
          argv: ["wait", "value"],
        };
      }
    } catch (error) {
      readError = (error as Error).message;
    }

    if (remaining <= 0) break;
    const delay = Math.min(remaining, VALUE_WAIT_POLL_MS);
    await backend.waitForTimeout(delay);
    remaining -= delay;
  }

  return {
    ok: false,
    stdout: actual,
    stderr: readError
      ? `wait.value could not read ${JSON.stringify(equals)} within ${timeoutMs}ms: ${readError}`
      : `wait.value expected ${JSON.stringify(equals)}, got ${JSON.stringify(actual)} after ${timeoutMs}ms`,
    exitCode: 1,
    durationMs: timeoutMs,
    argv: ["wait", "value"],
  };
}

async function runWaitUrlStep(
  step: WaitStep,
  backend: BrowserBackend,
): Promise<InvocationResult> {
  if (!("url" in step.wait)) return backend.runStep(step);

  const matcher = step.wait.url;
  const timeoutMs = step.wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  let remaining = timeoutMs;
  let actual = "";
  let readError: string | undefined;

  for (;;) {
    try {
      actual = await backend.getUrl();
      readError = undefined;
      if (matchWaitUrl(actual, matcher)) {
        return {
          ok: true,
          stdout: actual,
          stderr: "",
          exitCode: 0,
          durationMs: timeoutMs - remaining,
          argv: ["wait", "url"],
        };
      }
    } catch (error) {
      readError = (error as Error).message;
    }

    if (remaining <= 0) break;
    const delay = Math.min(remaining, VALUE_WAIT_POLL_MS);
    await backend.waitForTimeout(delay);
    remaining -= delay;
  }

  const expected = describeWaitUrl(matcher);
  return {
    ok: false,
    stdout: actual,
    stderr: readError
      ? `wait.url could not read URL ${expected} within ${timeoutMs}ms: ${readError}`
      : `wait.url expected ${expected}, got ${JSON.stringify(actual)} after ${timeoutMs}ms`,
    exitCode: 1,
    durationMs: timeoutMs,
    argv: ["wait", "url"],
  };
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
