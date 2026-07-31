import type {
  BrowserBackend,
  NetworkEntry,
} from "../../../adapters/browserBackend";
import type { NetworkVerifier, StatusMatcher } from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

export async function evaluateNetwork(
  verifier: NetworkVerifier,
  backend: BrowserBackend,
  capturedEntries?: NetworkEntry[],
): Promise<VerifierEvaluation> {
  const { method, urlContains, status } = verifier.network;
  const all = capturedEntries
    ? filterNetworkEntries(capturedEntries, method, urlContains)
    : await backend.getNetworkRequests({ method, filter: urlContains });
  const matching = all.filter((e) =>
    e.status !== undefined ? matchesStatus(e.status, status) : false,
  );

  const expectedStatusDesc = describeStatus(status);
  const expected =
    `at least one ${method ?? "any"} request with urlContains ${JSON.stringify(urlContains)} ` +
    `and status ${expectedStatusDesc}`;

  if (matching.length > 0) {
    const sample = matching.slice(0, 5);
    return {
      passed: true,
      expected,
      actual: `${matching.length} matching request(s):\n${formatEntries(sample)}`,
    };
  }

  return {
    passed: false,
    expected,
    actual:
      all.length === 0
        ? "no requests were captured (consider whether the step actually triggered the call)"
        : `${all.length} request(s) matched the method and URL, but none matched the expected status ${expectedStatusDesc}:\n${formatEntries(all.slice(0, 10))}`,
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

function matchesStatus(status: number, m: StatusMatcher): boolean {
  if (m.equals !== undefined) return status === m.equals;
  if (m.below !== undefined) return status < m.below;
  if (m.atLeast !== undefined) return status >= m.atLeast;
  if (m.in !== undefined) return m.in.includes(status);
  return false;
}

function describeStatus(m: StatusMatcher): string {
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
