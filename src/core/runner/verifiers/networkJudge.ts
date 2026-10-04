import type { ValueMatcher } from "../../schema/verifier.v1";
import {
  deepEqual,
  describeMatcher,
  matchValue,
  subsetMatch,
} from "./matchers";
import { resolveRefsDeep, type RefScope } from "./refs";

/**
 * The judging half of the `network` verifier: filter a request log, match
 * status / JSON body / count, and build the `assign` record. Pure (no
 * backend): the Playwright export embeds this file's source
 * (src/core/exporters/runtimeSources.ts) over its own request log, so an
 * exported test judges requests exactly like `cairn run` does.
 */

/** The request fields the verifier reads (`NetworkEntry` is a superset). */
export interface NetworkJudgeEntry {
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  /** Unix epoch milliseconds. */
  timestamp?: number;
  startedAt?: string;
  /** Bounded request body text when the backend could observe it. */
  postData?: string;
  postDataTruncated?: boolean;
  /**
   * A network-level failure (aborted, blocked, DNS, connection refused, a
   * request step that threw): such a request never gets a status.
   */
  error?: unknown;
}

/** `{ equals } | { below } | { atLeast } | { in }` (see StatusMatcher). */
export interface NetworkStatusMatcher {
  equals?: number;
  below?: number;
  atLeast?: number;
  in?: number[];
}

/** The fields of `verify: { network: … }` the judge reads. */
export interface NetworkSpec {
  method?: string;
  urlContains: string;
  status?: NetworkStatusMatcher;
  body?: { json?: unknown; match?: "subset" | "exact" };
  count?: ValueMatcher;
  assign?: string;
}

/** What a `network` verifier with `assign` exposes to later outcomes. */
export interface NetworkAssignment {
  /** ISO time of the last matching request. */
  at?: string;
  /** ISO time of the first matching request. */
  firstAt?: string;
  count: number;
  url?: string;
  method?: string;
  status?: number;
  /** Parsed JSON request body of the last match, when there was one. */
  body?: unknown;
}

export interface NetworkJudgement {
  passed: boolean;
  expected: string;
  actual: string;
  /** A `body.json` reference did not resolve: nothing was matched. */
  unresolved: boolean;
  /** Entries matching method + URL. */
  all: NetworkJudgeEntry[];
  /** Entries matching method, URL, status and body. */
  matching: NetworkJudgeEntry[];
  bodyJson: unknown;
  bodyMode: "subset" | "exact";
  /** The `assign` record (when `assign` is set and references resolved). */
  assignment?: NetworkAssignment;
}

export function filterNetworkEntries<T extends NetworkJudgeEntry>(
  entries: T[],
  method: string | undefined,
  urlContains: string,
): T[] {
  const normalizedMethod = method?.toUpperCase();
  return entries.filter(
    (entry) =>
      (!normalizedMethod || entry.method.toUpperCase() === normalizedMethod) &&
      entry.url.includes(urlContains),
  );
}

export function matchesStatus(
  status: number,
  m: NetworkStatusMatcher,
): boolean {
  if (m.equals !== undefined) return status === m.equals;
  if (m.below !== undefined) return status < m.below;
  if (m.atLeast !== undefined) return status >= m.atLeast;
  if (m.in !== undefined) return m.in.includes(status);
  return false;
}

export function describeStatus(m: NetworkStatusMatcher): string {
  if (m.equals !== undefined) return `== ${m.equals}`;
  if (m.below !== undefined) return `< ${m.below}`;
  if (m.atLeast !== undefined) return `>= ${m.atLeast}`;
  if (m.in !== undefined) return `in [${m.in.join(", ")}]`;
  return "<invalid>";
}

export function formatEntries(entries: NetworkJudgeEntry[]): string {
  return entries
    .map(
      (e) =>
        `- ${e.method} ${e.url} → ${
          e.status ??
          (e.error !== undefined ? `failed (${String(e.error)})` : "<pending>")
        }${e.resourceType ? ` (${e.resourceType})` : ""}`,
    )
    .join("\n");
}

/**
 * Still in flight: neither a status nor an error yet. A request the page
 * already saw complete can be in this state for a moment, until its response
 * event reaches the listener, so a verdict waits (bounded) for such entries.
 */
export function isInFlight(entry: NetworkJudgeEntry): boolean {
  return entry.status === undefined && entry.error === undefined;
}

/** The longest a verdict waits for in-flight candidates to settle. */
export const NETWORK_SETTLE_TIMEOUT_MS = 2000;
/** How often a settling request log is read again. */
export const NETWORK_SETTLE_POLL_MS = 100;

/**
 * `noFailedRequests`: a request failed when it answered 4xx/5xx OR carries
 * an error marker (aborted / blocked / DNS-failed / connection-refused /
 * request-step failure) — those never get a >=400 status, so a status-only
 * check would silently miss the most severe failures. A merely-pending
 * request has neither, so it is not flagged.
 */
export function isFailedRequest(entry: NetworkJudgeEntry): boolean {
  return (
    entry.error !== undefined ||
    (entry.status !== undefined && entry.status >= 400)
  );
}

/** The fields of `verify: { noFailedRequests: … }` the judge reads. */
export interface NoFailedRequestsSpec {
  method?: string;
  urlContains: string;
}

export interface NoFailedRequestsJudgement {
  passed: boolean;
  expected: string;
  actual: string;
  /** Entries matching method + URL that failed. */
  failed: NetworkJudgeEntry[];
}

/** Judge `all` (already filtered to method + URL) for `noFailedRequests`. */
export function judgeNoFailedRequests(
  all: NetworkJudgeEntry[],
  spec: NoFailedRequestsSpec,
): NoFailedRequestsJudgement {
  const failed = all.filter(isFailedRequest);
  const expected = `no ${spec.method ?? "any"}-method requests matching ${JSON.stringify(spec.urlContains)} returned 4xx/5xx or failed to complete`;
  if (failed.length === 0) {
    return {
      passed: true,
      expected,
      actual:
        all.length === 0
          ? "no matching requests observed (the filter produced an empty set)"
          : `all ${all.length} matching request(s) had no captured 4xx/5xx status or explicit network error`,
      failed,
    };
  }
  return {
    passed: false,
    expected,
    actual: `${failed.length} failing request(s):\n${formatEntries(failed.slice(0, 10))}`,
    failed,
  };
}

function parsePostData(entry: NetworkJudgeEntry): unknown {
  if (typeof entry.postData !== "string" || entry.postDataTruncated) {
    return undefined;
  }
  try {
    return JSON.parse(entry.postData);
  } catch {
    return undefined;
  }
}

/** ISO time a request was made, from whichever timestamp the backend set. */
export function entryTime(entry: NetworkJudgeEntry): string | undefined {
  if (typeof entry.startedAt === "string" && entry.startedAt.length > 0) {
    return entry.startedAt;
  }
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    return new Date(entry.timestamp).toISOString();
  }
  return undefined;
}

function networkAssignment(matching: NetworkJudgeEntry[]): NetworkAssignment {
  // A sorted copy without toSorted: vendored into exports built against lib
  // ES2022.
  const sorted = [...matching];
  sorted.sort(
    (a, b) => Date.parse(entryTime(a) ?? "") - Date.parse(entryTime(b) ?? ""),
  );
  const ordered = sorted.every((entry) => entryTime(entry) !== undefined)
    ? sorted
    : matching;
  const last = ordered.at(-1);
  const first = ordered[0];
  const lastAt = last ? entryTime(last) : undefined;
  const firstAt = first ? entryTime(first) : undefined;
  const parsedBody = last ? parsePostData(last) : undefined;
  return {
    count: matching.length,
    ...(lastAt ? { at: lastAt } : {}),
    ...(firstAt ? { firstAt } : {}),
    ...(last ? { url: last.url, method: last.method } : {}),
    ...(last?.status !== undefined ? { status: last.status } : {}),
    ...(parsedBody !== undefined ? { body: parsedBody } : {}),
  };
}

/**
 * Judge `all` (the entries already filtered to method + URL) against the
 * verifier: status, body and count. `scope` resolves `${…}` references in
 * `body.json`.
 */
export function judgeNetwork(
  all: NetworkJudgeEntry[],
  network: NetworkSpec,
  scope: RefScope,
): NetworkJudgement {
  const { method, urlContains, status, body, count, assign } = network;

  let bodyJson: unknown;
  if (body !== undefined) {
    const resolved = resolveRefsDeep(body.json, scope);
    if (resolved.missing.length > 0) {
      return {
        passed: false,
        expected: `network ${urlContains} request body with resolved references`,
        actual: `unresolved ${resolved.missing.join(", ")}`,
        unresolved: true,
        all,
        matching: [],
        bodyJson: undefined,
        bodyMode: body.match ?? "subset",
      };
    }
    bodyJson = resolved.value;
  }
  const bodyMode = body?.match ?? "subset";

  const statusMatching = all.filter((e) =>
    status === undefined
      ? true
      : e.status !== undefined
        ? matchesStatus(e.status, status)
        : false,
  );
  const matching =
    body === undefined
      ? statusMatching
      : statusMatching.filter((e) => {
          const parsed = parsePostData(e);
          if (parsed === undefined) return false;
          return bodyMode === "exact"
            ? deepEqual(parsed, bodyJson)
            : subsetMatch(parsed, bodyJson);
        });

  const qualifiers = [
    status !== undefined ? `status ${describeStatus(status)}` : undefined,
    body !== undefined
      ? `a request body ${
          bodyMode === "exact" ? "equal to" : "containing"
        } ${JSON.stringify(bodyJson)}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const subject = `${method ?? "any"} request(s) with urlContains ${JSON.stringify(urlContains)}${
    qualifiers.length > 0 ? ` and ${qualifiers.join(" and ")}` : ""
  }`;
  const expected =
    count !== undefined
      ? `the number of ${subject} ${describeMatcher(count)}`
      : `at least one ${subject}`;

  const assignment = assign ? networkAssignment(matching) : undefined;
  const base = {
    unresolved: false,
    all,
    matching,
    bodyJson,
    bodyMode,
    ...(assignment ? { assignment } : {}),
  };

  if (count !== undefined) {
    const result = matchValue(matching.length, true, count, "count");
    return {
      passed: result.passed,
      expected,
      actual: `${matching.length} matching request(s)${
        matching.length > 0
          ? `:\n${formatEntries(matching.slice(0, 5))}`
          : all.length > 0
            ? `; ${all.length} matched method+URL:\n${formatEntries(all.slice(0, 5))}`
            : ""
      }`,
      ...base,
    };
  }

  if (matching.length > 0) {
    const sample = matching.slice(0, 5);
    return {
      passed: true,
      expected,
      actual: `${matching.length} matching request(s):\n${formatEntries(sample)}`,
      ...base,
    };
  }

  return {
    passed: false,
    expected,
    actual:
      all.length === 0
        ? "no requests were captured (consider whether the step actually triggered the call)"
        : statusMatching.length > 0 && body !== undefined
          ? `${statusMatching.length} request(s) matched the method, URL${
              status ? " and status" : ""
            }, but none had the expected body:\n${formatEntries(statusMatching.slice(0, 10))}`
          : `${all.length} request(s) matched the method and URL, but none matched the expected status ${
              status ? describeStatus(status) : ""
            }:\n${formatEntries(all.slice(0, 10))}`,
    ...base,
  };
}
