import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { CaptureStep, Expect } from "../../schema/spec.v1";
import type { StatusMatcher } from "../../schema/verifier.v1";
import { textContains, textEquals } from "../../textMatching";
import {
  describeProbeLocator,
  runProbe,
  singleTarget,
  type ProbeLocator,
  type ProbeResult,
} from "./domProbe";
import { boundValue } from "./evidence";
import { matchPaths, matchValue, show, type MatchOutcome } from "./matchers";
import { describeStatus, matchesStatus } from "./network";
import { resolveRefsDeep, resolveRefsText, type RefScope } from "./refs";

/**
 * `expect` and `capture` steps: typed, evidence-producing replacements for
 * eval steps that throw on a bad state or scrape values for later steps.
 */

export interface ExpectRequestCall {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export type ExpectRequestResult =
  | {
      ok: true;
      response: { status: number; body: unknown; url: string };
    }
  | { ok: false; error: string };

export interface StepCheckDeps {
  backend: BrowserBackend;
  scope: RefScope;
  testIdAttribute?: string;
  waitScale?: number;
  /** Sends `expect.request` through the runner's request-step transport. */
  request?: (call: ExpectRequestCall) => Promise<ExpectRequestResult>;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ExpectRunResult {
  passed: boolean;
  /** visible | hidden | count | text | value | attribute | enabled | request (joined). */
  kind: string;
  expected: string;
  actual: string;
  attempts: number;
  durationMs: number;
  /** Bounded observation for `expects/<id>.json`. */
  observed?: unknown;
}

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_EVERY_MS = 250;

const ASSERTION_KEYS = [
  "id",
  "visible",
  "hidden",
  "count",
  "text",
  "value",
  "attribute",
  "enabled",
  "timeoutMs",
] as const;

/** The locator part of an `expect` (assertion keys removed). */
export function expectLocator(expect: Expect): ProbeLocator | undefined {
  if ("request" in expect) return undefined;
  const locator: Record<string, unknown> = { ...expect };
  for (const key of ASSERTION_KEYS) {
    // `by: text` keeps `text` as its locator field.
    if (key === "text" && expect.by === "text") continue;
    delete locator[key];
  }
  return locator as ProbeLocator;
}

export function expectKinds(expect: Expect): string {
  if ("request" in expect) return "request";
  const fields = expect as Record<string, unknown>;
  return ASSERTION_KEYS.filter(
    (key) =>
      key !== "id" &&
      key !== "timeoutMs" &&
      !(key === "text" && expect.by === "text") &&
      fields[key] !== undefined,
  ).join("+");
}

function budget(timeoutMs: number | undefined, waitScale = 1): number {
  return Math.max(1, Math.round((timeoutMs ?? DEFAULT_TIMEOUT_MS) * waitScale));
}

async function retryUntil<T extends { passed: boolean }>(
  attempt: () => Promise<T>,
  timeoutMs: number,
  deps: StepCheckDeps,
  retry = true,
): Promise<{ last: T; attempts: number; durationMs: number }> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const last = await attempt();
    const elapsed = now() - started;
    if (
      last.passed ||
      !retry ||
      elapsed >= timeoutMs ||
      deps.signal?.aborted === true
    ) {
      return { last, attempts, durationMs: elapsed };
    }
    await sleep(Math.min(RETRY_EVERY_MS, timeoutMs - elapsed));
  }
}

/* ----- expect ----- */

/**
 * Resolve `${captures|requests|evals|runs|fixtures|artifacts|run.…}` in a
 * locator `expect`: text fields as text, `count` typed (a whole reference
 * to a number stays a number). Unknown names are reported, never "".
 */
function resolveLocatorExpect(
  expect: Exclude<Expect, { request: unknown }>,
  scope: RefScope,
): { value: Exclude<Expect, { request: unknown }>; missing: string[] } {
  const { count, ...rest } = expect;
  const text = resolveRefsText(rest, scope);
  const typed = count !== undefined ? resolveRefsDeep(count, scope) : undefined;
  return {
    value: {
      ...text.value,
      ...(typed ? { count: typed.value } : {}),
    } as Exclude<Expect, { request: unknown }>,
    missing: [...new Set([...text.missing, ...(typed?.missing ?? [])])],
  };
}

export async function runExpect(
  rawExpect: Expect,
  deps: StepCheckDeps,
): Promise<ExpectRunResult> {
  const timeoutMs = budget(rawExpect.timeoutMs, deps.waitScale);
  if ("request" in rawExpect) {
    return runRequestExpect(rawExpect, timeoutMs, deps);
  }
  const refs = resolveLocatorExpect(rawExpect, deps.scope);
  if (refs.missing.length > 0) {
    return {
      passed: false,
      kind: expectKinds(rawExpect),
      expected: `${describeProbeLocator(expectLocator(rawExpect)!)}: ${expectKinds(rawExpect)} with resolved references`,
      actual: `unresolved ${refs.missing.join(", ")}`,
      attempts: 0,
      durationMs: 0,
    };
  }
  const expect = refs.value;
  const locator = expectLocator(expect)!;
  const target = describeProbeLocator(locator);
  const { last, attempts, durationMs } = await retryUntil(
    async () => {
      let probe: ProbeResult;
      try {
        probe = await runProbe(deps.backend, locator, {
          ...(deps.testIdAttribute
            ? { testIdAttribute: deps.testIdAttribute }
            : {}),
          ...(expect.attribute ? { attribute: expect.attribute.name } : {}),
        });
      } catch (error) {
        return {
          passed: false,
          expected: `${target}: ${expectKinds(expect)}`,
          actual: `error: ${(error as Error).message}`,
          observed: undefined as unknown,
        };
      }
      const checks = judgeLocatorExpect(expect, locator, probe);
      const failing = checks.filter((check) => !check.passed);
      return {
        passed: failing.length === 0,
        expected: `${target}: ${checks.map((check) => check.expected).join("; ")}`,
        actual: (failing.length > 0 ? failing : checks)
          .map((check) => check.actual)
          .join("; "),
        observed: {
          total: probe.total,
          visible: probe.visibleCount,
          matches: probe.matches.slice(0, 5),
        } as unknown,
      };
    },
    timeoutMs,
    deps,
  );
  return {
    passed: last.passed,
    kind: expectKinds(expect),
    expected: last.expected,
    actual: last.actual,
    attempts,
    durationMs,
    ...(last.observed !== undefined
      ? { observed: boundValue(last.observed).value }
      : {}),
  };
}

function judgeLocatorExpect(
  expect: Exclude<Expect, { request: unknown }>,
  locator: ProbeLocator,
  probe: ProbeResult,
): MatchOutcome[] {
  const checks: MatchOutcome[] = [];
  const nth = "nth" in locator ? locator.nth : undefined;
  const nthVisible =
    nth !== undefined ? probe.nthMatch?.visible === true : undefined;
  if (expect.visible === true) {
    const ok = nthVisible ?? probe.visibleCount > 0;
    checks.push({
      passed: ok,
      expected: "visible",
      actual: ok
        ? "visible"
        : probe.total === 0
          ? "no match"
          : `${probe.total} match(es), none visible`,
    });
  }
  if (expect.hidden === true || expect.visible === false) {
    const ok =
      nth !== undefined ? nthVisible !== true : probe.visibleCount === 0;
    checks.push({
      passed: ok,
      expected: "hidden or absent",
      actual: ok
        ? probe.total === 0
          ? "absent"
          : "hidden"
        : `${probe.visibleCount} visible match(es)`,
    });
  }
  if (expect.hidden === false) {
    const ok = nthVisible ?? probe.visibleCount > 0;
    checks.push({
      passed: ok,
      expected: "not hidden",
      actual: ok ? "visible" : "hidden or absent",
    });
  }
  if (expect.count !== undefined) {
    checks.push({
      ...matchValue(probe.poolCount, true, expect.count, "count"),
      actual: `count=${probe.poolCount}`,
    });
  }
  // `by: text` uses `text` as its locator, never as an assertion.
  const textAssertion = expect.by === "text" ? undefined : expect.text;
  const needsTarget =
    textAssertion !== undefined ||
    expect.value !== undefined ||
    expect.attribute !== undefined ||
    expect.enabled !== undefined;
  if (!needsTarget) return checks;
  const target = singleTarget(probe, locator);
  if (!target.match) {
    checks.push({
      passed: false,
      expected: "a single target element",
      actual: target.error ?? "no target",
    });
    return checks;
  }
  const match = target.match;
  if (textAssertion !== undefined) {
    const m =
      typeof textAssertion === "string"
        ? { equals: textAssertion }
        : textAssertion;
    const caseSensitive = "caseSensitive" in m && m.caseSensitive === true;
    const ok =
      m.equals !== undefined
        ? textEquals(match.text, m.equals, caseSensitive)
        : m.contains !== undefined
          ? textContains(match.text, m.contains, caseSensitive)
          : new RegExp(m.matches!).test(match.text);
    checks.push({
      passed: ok,
      expected:
        m.equals !== undefined
          ? `text equals ${show(m.equals)}`
          : m.contains !== undefined
            ? `text contains ${show(m.contains)}`
            : `text matches /${m.matches}/`,
      actual: `text ${show(match.text, 160)}`,
    });
  }
  if (expect.value !== undefined) {
    const m =
      typeof expect.value === "string"
        ? { equals: expect.value }
        : expect.value;
    const value = match.value;
    const ok =
      value !== null &&
      (m.equals !== undefined
        ? value === m.equals
        : m.contains !== undefined
          ? value.includes(m.contains)
          : new RegExp(m.matches!).test(value));
    checks.push({
      passed: ok,
      expected:
        m.equals !== undefined
          ? `value equals ${show(m.equals)}`
          : m.contains !== undefined
            ? `value contains ${show(m.contains)}`
            : `value matches /${m.matches}/`,
      actual:
        value === null
          ? `not a form control (${match.tag})`
          : `value ${show(value, 160)}`,
    });
  }
  if (expect.attribute !== undefined) {
    const a = expect.attribute;
    const value = match.attribute;
    const ok =
      a.exists !== undefined
        ? match.hasAttribute === a.exists
        : value !== null &&
          (a.equals !== undefined
            ? value === a.equals
            : a.contains !== undefined
              ? value.includes(a.contains)
              : new RegExp(a.matches!).test(value));
    checks.push({
      passed: ok,
      expected:
        a.exists !== undefined
          ? `attribute ${a.name} ${a.exists ? "present" : "absent"}`
          : a.equals !== undefined
            ? `${a.name} equals ${show(a.equals)}`
            : a.contains !== undefined
              ? `${a.name} contains ${show(a.contains)}`
              : `${a.name} matches /${a.matches}/`,
      actual:
        match.hasAttribute && value !== null
          ? `${a.name}=${show(value, 160)}`
          : `${a.name} absent`,
    });
  }
  if (expect.enabled !== undefined) {
    checks.push({
      passed: match.enabled === expect.enabled,
      expected: expect.enabled ? "enabled" : "disabled",
      actual: match.enabled ? "enabled" : "disabled",
    });
  }
  return checks;
}

async function runRequestExpect(
  expect: Extract<Expect, { request: unknown }>,
  timeoutMs: number,
  deps: StepCheckDeps,
): Promise<ExpectRunResult> {
  const spec = expect.request;
  const label = `${spec.method} ${spec.url}`;
  if (!deps.request) {
    return {
      passed: false,
      kind: "request",
      expected: label,
      actual: "this runner cannot send expect.request",
      attempts: 0,
      durationMs: 0,
    };
  }
  const resolved = resolveRefsDeep(
    {
      url: spec.url,
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      // Matcher values keep the referenced type (a captured number stays
      // a number).
      ...(spec.json !== undefined ? { json: spec.json } : {}),
    },
    deps.scope,
  );
  if (resolved.missing.length > 0) {
    return {
      passed: false,
      kind: "request",
      expected: label,
      actual: `unresolved ${resolved.missing.join(", ")}`,
      attempts: 0,
      durationMs: 0,
    };
  }
  const call: ExpectRequestCall = {
    method: spec.method,
    url: String(resolved.value.url),
    ...(resolved.value.headers
      ? { headers: resolved.value.headers as Record<string, string> }
      : {}),
    ...(resolved.value.body !== undefined ? { body: resolved.value.body } : {}),
  };
  // Only idempotent reads are repeated while waiting for the expectation.
  const retry = spec.method === "GET" || spec.method === "HEAD";
  const { last, attempts, durationMs } = await retryUntil(
    async () => {
      const result = await deps.request!(call);
      if (!result.ok) {
        return {
          passed: false,
          expected: label,
          actual: result.error,
          observed: undefined as unknown,
        };
      }
      const checks = judgeResponse(
        spec.status,
        resolved.value.json as Record<string, unknown> | undefined,
        result.response,
      );
      const failing = checks.filter((check) => !check.passed);
      return {
        passed: failing.length === 0,
        expected: `${label}: ${checks.map((check) => check.expected).join("; ")}`,
        actual: (failing.length > 0 ? failing : checks)
          .map((check) => check.actual)
          .join("; "),
        observed: {
          status: result.response.status,
          body: boundValue(result.response.body).value,
        } as unknown,
      };
    },
    timeoutMs,
    deps,
    retry,
  );
  return {
    passed: last.passed,
    kind: "request",
    expected: last.expected,
    actual: last.actual,
    attempts,
    durationMs,
    ...(last.observed !== undefined ? { observed: last.observed } : {}),
  };
}

function judgeResponse(
  status: number | StatusMatcher | undefined,
  json: Record<string, unknown> | undefined,
  response: { status: number; body: unknown },
): MatchOutcome[] {
  const checks: MatchOutcome[] = [];
  const ok =
    status === undefined
      ? response.status >= 200 && response.status < 300
      : typeof status === "number"
        ? response.status === status
        : matchesStatus(response.status, status);
  checks.push({
    passed: ok,
    expected: `status ${
      status === undefined
        ? "2xx"
        : typeof status === "number"
          ? `== ${status}`
          : describeStatus(status)
    }`,
    actual: `status ${response.status}`,
  });
  if (json) {
    const report = matchPaths(
      response.body,
      json as Parameters<typeof matchPaths>[1],
    );
    for (const result of report.results) {
      checks.push({
        passed: result.passed,
        expected: result.expected,
        actual: `${result.path || "$"}=${result.actual}`,
      });
    }
  }
  return checks;
}

/* ----- capture ----- */

export type CaptureRunResult =
  | { ok: true; assign: string; kind: string; value: unknown }
  | { ok: false; assign: string; kind: string; error: string };

export async function runCapture(
  capture: CaptureStep["capture"],
  deps: StepCheckDeps,
): Promise<CaptureRunResult> {
  const kind =
    capture.text !== undefined
      ? "text"
      : capture.value !== undefined
        ? "value"
        : capture.attribute !== undefined
          ? "attribute"
          : "table";
  const written = (capture.text ??
    capture.value ??
    capture.attribute ??
    capture.table) as Record<string, unknown>;
  const refs = resolveRefsText(written, deps.scope);
  if (refs.missing.length > 0) {
    return {
      ok: false,
      assign: capture.assign,
      kind,
      error: `capture ${kind} ${capture.assign}: unresolved ${refs.missing.join(", ")}`,
    };
  }
  const { attributeName, ...locatorFields } = refs.value;
  const locator = locatorFields as ProbeLocator;
  const timeoutMs = budget(capture.timeoutMs, deps.waitScale);
  const { last } = await retryUntil(
    async () => {
      try {
        const probe = await runProbe(deps.backend, locator, {
          ...(deps.testIdAttribute
            ? { testIdAttribute: deps.testIdAttribute }
            : {}),
          ...(typeof attributeName === "string"
            ? { attribute: attributeName }
            : {}),
          ...(kind === "table" ? { table: true } : {}),
        });
        if (kind === "table") {
          if (!probe.table) {
            return {
              passed: false,
              error: `no element matches ${describeProbeLocator(locator)}`,
            };
          }
          return { passed: true, value: tableCapture(probe.table) };
        }
        const target = singleTarget(probe, locator);
        if (!target.match) {
          return { passed: false, error: target.error ?? "no target" };
        }
        const value =
          kind === "text"
            ? target.match.text
            : kind === "value"
              ? target.match.value
              : target.match.attribute;
        if (kind === "value" && value === null) {
          return {
            passed: false,
            error: `${describeProbeLocator(locator)} is not a form control (${target.match.tag})`,
          };
        }
        return { passed: true, value };
      } catch (error) {
        return { passed: false, error: (error as Error).message };
      }
    },
    timeoutMs,
    deps,
  );
  if (!last.passed) {
    return {
      ok: false,
      assign: capture.assign,
      kind,
      error: `capture ${kind} ${capture.assign}: ${
        "error" in last ? last.error : "failed"
      }`,
    };
  }
  return {
    ok: true,
    assign: capture.assign,
    kind,
    value: "value" in last ? last.value : null,
  };
}

/** `{headers, rows: [{header: cell}], cells, rowCount}` for `${captures.x…}`. */
function tableCapture(table: {
  headers: string[];
  rows: string[][];
  rowCount: number;
}): Record<string, unknown> {
  const headers = table.headers.map((header, index) =>
    header.length > 0 ? header : `column${index + 1}`,
  );
  const rows = table.rows.map((cells) => {
    const row: Record<string, string> = {};
    cells.forEach((cell, index) => {
      row[headers[index] ?? `column${index + 1}`] = cell;
    });
    return row;
  });
  return {
    headers: table.headers,
    rows,
    cells: table.rows,
    rowCount: table.rowCount,
  };
}
