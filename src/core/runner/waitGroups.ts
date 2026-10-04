import type {
  BrowserBackend,
  InvocationResult,
} from "../../adapters/browserBackend";
import { describeWaitUrl, matchWaitUrl } from "../locators";
import {
  appCheckExpression,
  appHandleName,
  parseAppCheckResult,
  type AppCheck,
  type AppHandles,
} from "../prelude/prelude";
import {
  describeAppWait,
  isAppWaitCondition,
  isWaitGroup,
  plainWaitCondition,
  type Locator,
  type RunnerWaitCondition,
  type WaitAppCondition,
  type WaitStepCondition,
} from "../schema/spec.v1";
import { textContains } from "../textMatching";
import { evalDocumentPredicate } from "./conditions";
import { runProbe, singleTarget } from "./verifiers/domProbe";

/**
 * F14 runner-driven waits: `wait.any`, `wait.all` and `optional: true`.
 *
 * A native backend wait that runs out of time may stop the browser
 * (Playwright treats a page-operation timeout as a wedge), which an optional
 * miss or a group's losing branch must never do. These waits therefore poll
 * the page from the runner instead: each attempt reads every condition once
 * with a short, bounded probe (page text, URL, a DOM predicate, a control
 * value), and the loop ends when the group holds or its budget is spent.
 * The probes match the native waits' semantics: text/notText are
 * whitespace-normalized and case-insensitive unless `caseSensitive`;
 * `selector` honors `state` (default visible) and `hasText`; `load` reads
 * `document.readyState` (network idle cannot be observed in one probe, so
 * `networkidle` means a complete document); `ms` holds once that much time
 * has passed (a timer branch).
 */

export const DEFAULT_RUNNER_WAIT_TIMEOUT_MS = 30_000;
/** Pause between two polls of a runner-driven wait. */
export const RUNNER_WAIT_POLL_MS = 250;

/** What a runner-driven wait needs beyond the backend. */
export interface RunnerWaitOptions {
  /** Config `browser.appHandle`, for `wait: { app }` (F20). */
  appHandles?: AppHandles;
  /** Config `browser.testIdAttribute`, for a `value` condition's locator. */
  testIdAttribute?: string;
}

/** Most time one app probe may take in the page. */
const APP_PROBE_TIMEOUT_MS = 5_000;
/** Most time one value probe may take in the page (one evaluate, no locator wait). */
const VALUE_PROBE_TIMEOUT_MS = 5_000;

/**
 * F20 `wait: { app }`: install the prelude and test the handle value in the
 * page. The value never leaves the page — only a bounded, masked preview for
 * the failure message (credential-like keys `[redacted]`, long or
 * token-shaped strings by length, a credential-like path by type and length
 * only).
 */
async function probeAppCondition(
  cond: WaitAppCondition,
  backend: BrowserBackend,
  options: RunnerWaitOptions,
): Promise<WaitConditionProbe> {
  const { path, ...check } = cond.app;
  const result = await backend.evaluate(
    appCheckExpression(path, check as AppCheck, options.appHandles),
    { timeoutMs: APP_PROBE_TIMEOUT_MS },
  );
  if (!result.ok) {
    return {
      ok: false,
      detail: `read failed: ${(result.stderr || `exit ${result.exitCode}`).split("\n")[0]}`,
    };
  }
  const answer = parseAppCheckResult(result.stdout);
  if (answer.error) return { ok: false, detail: answer.error };
  return {
    ok: answer.ok,
    detail: answer.found ? `value was ${answer.preview}` : "value is undefined",
  };
}

/** The failure for app waits whose handle is not configured, if any. */
function unknownAppHandles(
  conditions: readonly RunnerWaitCondition[],
  appHandles: AppHandles | undefined,
): string | undefined {
  const configured = Object.keys(appHandles ?? {});
  const missing = conditions
    .filter(isAppWaitCondition)
    .map((cond) => appHandleName(cond.app.path))
    .filter((name) => !configured.includes(name));
  if (missing.length === 0) return undefined;
  return `wait.app: no browser.appHandle named ${[...new Set(missing)]
    .map((name) => JSON.stringify(name))
    .join(", ")} (configured: ${configured.join(", ") || "none"})`;
}

export interface WaitConditionProbe {
  ok: boolean;
  /** What was observed, for the failure message (never a typed value). */
  detail: string;
}

export interface RunnerWaitResult {
  /** The step's verdict: false only for a non-optional wait that missed. */
  ok: boolean;
  /** any: one condition held; all: every condition held at the same poll. */
  matched: boolean;
  /** wait.any: 0-based index of the condition that held first. */
  index?: number;
  /** One line describing the result (the error of a failed step). */
  detail: string;
  durationMs: number;
}

/** Short label of one condition for messages. */
export function describeWaitCondition(cond: RunnerWaitCondition): string {
  if ("ms" in cond) return `${cond.ms}ms elapsed`;
  if (isAppWaitCondition(cond)) return describeAppWait(cond);
  if ("text" in cond) return `text ${JSON.stringify(cond.text)}`;
  if ("notText" in cond) return `notText ${JSON.stringify(cond.notText)}`;
  if ("load" in cond) return `load=${cond.load}`;
  if ("selector" in cond) {
    return `selector ${JSON.stringify(cond.selector)} ${cond.state ?? "visible"}${
      cond.hasText !== undefined
        ? ` hasText ${JSON.stringify(cond.hasText)}`
        : ""
    }`;
  }
  if ("value" in cond) {
    const { equals: _equals, ...locator } = cond.value;
    return `value of ${describeLocator(locator as Locator)}`;
  }
  return `url ${describeWaitUrl(cond.url)}`;
}

function describeLocator(locator: Locator): string {
  switch (locator.by) {
    case "role":
      return `role=${locator.role}${
        locator.name !== undefined ? ` ${JSON.stringify(locator.name)}` : ""
      }`;
    case "label":
      return `label ${JSON.stringify(locator.name)}`;
    case "text":
      return `text ${JSON.stringify(locator.text)}`;
    case "testid":
      return `testid ${JSON.stringify(locator.testid)}`;
    case "selector":
      return `selector ${JSON.stringify(locator.selector)}`;
  }
}

/**
 * Browser expression: does `selector` (optionally filtered by `hasText`)
 * reach `state`? Visible means rendered (not display:none or
 * visibility:hidden) with a non-empty box; hidden means no visible match
 * (detached counts as hidden, like Playwright).
 */
export function selectorStateExpression(
  selector: string,
  state: "attached" | "visible" | "hidden" | "detached",
  hasText?: string,
): string {
  const sel = JSON.stringify(selector);
  const needle = hasText === undefined ? "null" : JSON.stringify(hasText);
  return `(function(){var n=${needle};var norm=function(s){return String(s||"").replace(/\\s+/g," ").trim().toLowerCase();};var els=[].filter.call(document.querySelectorAll(${sel}),function(el){return n===null||norm(el.textContent).indexOf(norm(n))!==-1;});var shown=els.some(function(el){var s=window.getComputedStyle(el);if(s.display==="none"||s.visibility==="hidden")return false;var r=el.getBoundingClientRect();return r.width>0||r.height>0;});switch(${JSON.stringify(state)}){case "attached":return els.length>0;case "detached":return els.length===0;case "hidden":return !shown;default:return shown;}})()`;
}

/** Read one condition once. Throws only when the backend read itself fails. */
export async function probeWaitCondition(
  cond: RunnerWaitCondition,
  backend: BrowserBackend,
  elapsedMs: number,
  options: RunnerWaitOptions = {},
): Promise<WaitConditionProbe> {
  if (isAppWaitCondition(cond))
    return probeAppCondition(cond, backend, options);
  if ("ms" in cond) {
    return {
      ok: elapsedMs >= cond.ms,
      detail: `${Math.round(elapsedMs)}ms of ${cond.ms}ms elapsed`,
    };
  }
  if ("text" in cond || "notText" in cond) {
    const expected = "text" in cond;
    const needle = expected ? cond.text : cond.notText;
    const found = textContains(
      await backend.getText("page"),
      needle,
      cond.caseSensitive ?? false,
    );
    return {
      ok: found === expected,
      detail: `page text ${
        found ? "contained" : "did not contain"
      } ${JSON.stringify(needle)}`,
    };
  }
  if ("url" in cond) {
    const url = await backend.getUrl();
    const ok = matchWaitUrl(url, cond.url);
    return {
      ok,
      detail: `url ${ok ? "matched" : "was"} ${JSON.stringify(url)}`,
    };
  }
  if ("selector" in cond) {
    const state = cond.state ?? "visible";
    const ok = await evalDocumentPredicate(
      backend,
      selectorStateExpression(cond.selector, state, cond.hasText),
    );
    return {
      ok,
      detail: `selector ${JSON.stringify(cond.selector)} ${
        ok ? "is" : "is not"
      } ${state}`,
    };
  }
  if ("value" in cond) {
    // One in-page read through the shared locator resolver: an absent
    // control answers at once instead of blocking for the backend's locator
    // timeout (`getValue` waits up to 10s for the element), which would
    // overrun the wait's budget and break `any` ("first to hold").
    const { equals, ...locator } = cond.value;
    const probe = await runProbe(
      backend,
      locator as Locator,
      options.testIdAttribute
        ? { testIdAttribute: options.testIdAttribute }
        : {},
      VALUE_PROBE_TIMEOUT_MS,
    );
    const target = singleTarget(probe, locator as Locator);
    if (!target.match) {
      return { ok: false, detail: target.error ?? "no control matched" };
    }
    const ok = target.match.value === equals;
    return {
      ok,
      detail: ok ? "value matched" : "value did not match yet",
    };
  }
  const expression =
    cond.load === "domcontentloaded"
      ? `document.readyState !== "loading"`
      : `document.readyState === "complete"`;
  const ok = await evalDocumentPredicate(backend, expression);
  return {
    ok,
    detail: `document ${ok ? "reached" : "has not reached"} ${cond.load}`,
  };
}

/**
 * Poll a runner-driven wait (see the module comment) until it holds or its
 * budget (`timeoutMs`, already scaled by the caller) runs out. A miss fails
 * only a non-optional wait. Budget accounting follows the other runner
 * polls: elapsed time is the larger of the wall clock and the sum of the
 * pauses, so a backend whose pauses return at once (the mock) still ends.
 */
export async function runRunnerDrivenWait(
  wait: WaitStepCondition,
  backend: BrowserBackend,
  options: RunnerWaitOptions = {},
): Promise<RunnerWaitResult> {
  const group = isWaitGroup(wait);
  const mode: "any" | "all" = group && "all" in wait ? "all" : "any";
  const conditions: RunnerWaitCondition[] = group
    ? "any" in wait
      ? wait.any
      : wait.all
    : [plainWaitCondition(wait)];
  const optional = "optional" in wait && wait.optional === true;
  const timeoutMs =
    "ms" in wait ? wait.ms : (wait.timeoutMs ?? DEFAULT_RUNNER_WAIT_TIMEOUT_MS);
  const started = Date.now();
  let paused = 0;
  const elapsed = (): number => Math.max(paused, Date.now() - started);
  const last = conditions.map(() => "not observed");
  // An app wait naming a handle the config lacks cannot start holding:
  // fail at once instead of polling out the budget.
  const unknown = unknownAppHandles(conditions, options.appHandles);
  if (unknown) {
    return {
      ok: false,
      matched: false,
      detail: unknown,
      durationMs: Date.now() - started,
    };
  }

  for (;;) {
    const now = elapsed();
    const held: boolean[] = [];
    for (const [index, cond] of conditions.entries()) {
      let probe: WaitConditionProbe;
      try {
        probe = await probeWaitCondition(cond, backend, now, options);
      } catch (error) {
        probe = {
          ok: false,
          detail: `read failed: ${(error as Error).message.split("\n")[0]}`,
        };
      }
      last[index] = probe.detail;
      held[index] = probe.ok;
      if (mode === "any" && probe.ok) {
        return {
          ok: true,
          matched: true,
          index,
          detail: `${describeWaitCondition(cond)} held`,
          durationMs: Date.now() - started,
        };
      }
    }
    if (mode === "all" && held.every(Boolean)) {
      return {
        ok: true,
        matched: true,
        detail: `all ${conditions.length} conditions held`,
        durationMs: Date.now() - started,
      };
    }
    const spent = elapsed();
    if (spent >= timeoutMs) break;
    const delay = Math.max(1, Math.min(RUNNER_WAIT_POLL_MS, timeoutMs - spent));
    try {
      await backend.waitForTimeout(delay);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    paused += delay;
  }

  const observed = conditions
    .map((cond, index) => `${describeWaitCondition(cond)}: ${last[index]}`)
    .join("; ");
  const what = group
    ? `wait.${mode}: ${
        mode === "any" ? "none" : "not all"
      } of ${conditions.length} condition(s) held within ${timeoutMs}ms`
    : `wait: ${describeWaitCondition(conditions[0]!)} did not hold within ${timeoutMs}ms`;
  return {
    ok: optional,
    matched: false,
    detail: `${what}${
      optional ? " (optional — step passes)" : ""
    } (${observed})`,
    durationMs: Date.now() - started,
  };
}

/** The same result as a backend invocation (teardown and generic callers). */
export function runnerWaitInvocation(
  result: RunnerWaitResult,
): InvocationResult {
  return {
    ok: result.ok,
    stdout: JSON.stringify({
      matched: result.matched,
      ...(result.index !== undefined ? { index: result.index } : {}),
    }),
    stderr: result.ok ? "" : result.detail,
    exitCode: result.ok ? 0 : 1,
    durationMs: result.durationMs,
    argv: ["wait", "runner"],
  };
}
