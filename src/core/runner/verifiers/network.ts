import type {
  BrowserBackend,
  NetworkEntry,
} from "../../../adapters/browserBackend";
import type { NetworkVerifier, StatusMatcher } from "../../schema/verifier.v1";
import { boundValue } from "./evidence";
import {
  deepEqual,
  describeMatcher,
  matchValue,
  subsetMatch,
} from "./matchers";
import { resolveRefsDeep } from "./refs";
import type {
  NetworkAssignment,
  VerifierContext,
  VerifierEvaluation,
} from "./types";

export async function evaluateNetwork(
  verifier: NetworkVerifier,
  backend: BrowserBackend,
  capturedEntries?: NetworkEntry[],
  ctx: VerifierContext = {},
): Promise<VerifierEvaluation> {
  const { method, urlContains, status, body, count, assign } = verifier.network;
  const all = capturedEntries
    ? filterNetworkEntries(capturedEntries, method, urlContains)
    : await backend.getNetworkRequests({ method, filter: urlContains });

  let bodyJson: unknown;
  if (body !== undefined) {
    const resolved = resolveRefsDeep(body.json, ctx);
    if (resolved.missing.length > 0) {
      return {
        passed: false,
        expected: `network ${urlContains} request body with resolved references`,
        actual: `unresolved ${resolved.missing.join(", ")}`,
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

  if (assign) {
    ctx.networkAssigns ??= {};
    ctx.networkAssigns[assign] = networkAssignment(matching);
  }

  const raw =
    body !== undefined || count !== undefined || assign !== undefined
      ? {
          kind: "network",
          request: {
            ...(method ? { method } : {}),
            urlContains,
            ...(status ? { status } : {}),
            ...(body !== undefined
              ? { body: { json: boundValue(bodyJson).value, match: bodyMode } }
              : {}),
          },
          observed: {
            candidates: all.length,
            matching: matching.length,
            requests: matching.slice(0, 20).map(entrySummary),
            truncated: matching.length > 20,
          },
          ...(assign
            ? { assign: { name: assign, ...ctx.networkAssigns?.[assign] } }
            : {}),
        }
      : undefined;

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
      ...(raw ? { raw } : {}),
    };
  }

  if (matching.length > 0) {
    const sample = matching.slice(0, 5);
    return {
      passed: true,
      expected,
      actual: `${matching.length} matching request(s):\n${formatEntries(sample)}`,
      ...(raw ? { raw } : {}),
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
    ...(raw ? { raw } : {}),
  };
}

export function filterNetworkEntries(
  entries: NetworkEntry[],
  method: string | undefined,
  urlContains: string,
): NetworkEntry[] {
  const normalizedMethod = method?.toUpperCase();
  return entries.filter(
    (entry) =>
      (!normalizedMethod || entry.method.toUpperCase() === normalizedMethod) &&
      entry.url.includes(urlContains),
  );
}

export function matchesStatus(status: number, m: StatusMatcher): boolean {
  if (m.equals !== undefined) return status === m.equals;
  if (m.below !== undefined) return status < m.below;
  if (m.atLeast !== undefined) return status >= m.atLeast;
  if (m.in !== undefined) return m.in.includes(status);
  return false;
}

export function describeStatus(m: StatusMatcher): string {
  if (m.equals !== undefined) return `== ${m.equals}`;
  if (m.below !== undefined) return `< ${m.below}`;
  if (m.atLeast !== undefined) return `>= ${m.atLeast}`;
  if (m.in !== undefined) return `in [${m.in.join(", ")}]`;
  return "<invalid>";
}

export function formatEntries(entries: NetworkEntry[]): string {
  return entries
    .map(
      (e) =>
        `- ${e.method} ${e.url} → ${e.status ?? "<pending>"}${
          e.resourceType ? ` (${e.resourceType})` : ""
        }`,
    )
    .join("\n");
}

function parsePostData(entry: NetworkEntry): unknown {
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
function entryTime(entry: NetworkEntry): string | undefined {
  if (typeof entry.startedAt === "string" && entry.startedAt.length > 0) {
    return entry.startedAt;
  }
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
    return new Date(entry.timestamp).toISOString();
  }
  return undefined;
}

function entrySummary(entry: NetworkEntry): Record<string, unknown> {
  const at = entryTime(entry);
  return {
    method: entry.method,
    url: entry.url,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(at ? { at } : {}),
  };
}

function networkAssignment(matching: NetworkEntry[]): NetworkAssignment {
  const sorted = matching.toSorted(
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
