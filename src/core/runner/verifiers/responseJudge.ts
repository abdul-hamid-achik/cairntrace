import { redactUrl } from "./evidence";
import type { PathMatchers } from "../../schema/verifier.v1";
import { matchPaths, type MatchOutcome } from "./matchers";
import {
  describeStatus,
  matchesStatus,
  type NetworkStatusMatcher,
} from "./networkJudge";

/**
 * Judging an HTTP response against `status` / `json` expectations, shared by
 * the `http` verifier and `expect.request` (and embedded, as source, in the
 * Playwright export: src/core/exporters/runtimeSources.ts). Pure: no I/O.
 */

/** The `expect` of an `http` verifier. */
export interface HttpExpectation {
  status?: number | NetworkStatusMatcher;
  json?: PathMatchers;
}

/** The reply fields the judge reads. */
export interface HttpJudgeReply {
  status: number;
  body: unknown;
  json?: boolean;
  bytes?: number;
  truncated?: boolean;
}

export function judgeHttp(
  expect: HttpExpectation | undefined,
  method: string,
  url: string,
  reply: HttpJudgeReply,
): { passed: boolean; expected: string; actual: string } {
  const checks: MatchOutcome[] = [];
  const status = expect?.status;
  const statusOk =
    status === undefined
      ? reply.status >= 200 && reply.status < 300
      : typeof status === "number"
        ? reply.status === status
        : matchesStatus(reply.status, status);
  checks.push({
    passed: statusOk,
    expected: `${method} ${redactUrl(url)} status ${
      status === undefined
        ? "2xx"
        : typeof status === "number"
          ? `== ${status}`
          : describeStatus(status)
    }`,
    actual: `status ${reply.status}`,
  });
  if (expect?.json) {
    if (!reply.json) {
      checks.push({
        passed: false,
        expected: "a JSON body",
        actual: reply.truncated
          ? `body over the parse limit (${reply.bytes} bytes)`
          : `non-JSON body: ${String(reply.body).slice(0, 120)}`,
      });
    } else {
      const report = matchPaths(reply.body, expect.json);
      for (const result of report.results) {
        checks.push({
          passed: result.passed,
          expected: result.expected,
          actual: `${result.path || "$"}=${result.actual}`,
        });
      }
    }
  }
  const failing = checks.filter((check) => !check.passed);
  return {
    passed: failing.length === 0,
    expected: checks.map((check) => check.expected).join("; "),
    actual: [
      `status ${reply.status}`,
      ...failing
        .map((check) => check.actual)
        .filter((part) => !part.startsWith("status ")),
    ].join("; "),
  };
}

/** `expect.request`: status then every `json` path matcher. */
export function judgeResponse(
  status: number | NetworkStatusMatcher | undefined,
  json: PathMatchers | undefined,
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
    const report = matchPaths(response.body, json);
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
