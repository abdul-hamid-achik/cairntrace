import type { NetworkEntry } from "../adapters/browserBackend";
import type { NetworkPostcondition, Postcondition } from "./schema/spec.v1";
import type { StatusMatcher } from "./schema/verifier.v1";

export const DEFAULT_NETWORK_POSTCONDITION_TIMEOUT_MS = 30_000;
export const NETWORK_POSTCONDITION_POLL_MS = 100;

export function matchesNetworkPostcondition(
  entry: NetworkEntry,
  postcondition: NetworkPostcondition,
): boolean {
  if (
    postcondition.method !== undefined &&
    entry.method.toUpperCase() !== postcondition.method
  ) {
    return false;
  }
  if (!entry.url.includes(postcondition.urlContains)) return false;
  return postcondition.status === undefined
    ? true
    : matchesStatus(entry.status, postcondition.status);
}

export function matchesStatus(
  actual: number | undefined,
  matcher: StatusMatcher,
): boolean {
  if (actual === undefined) return false;
  if (matcher.equals !== undefined) return actual === matcher.equals;
  if (matcher.below !== undefined) return actual < matcher.below;
  if (matcher.atLeast !== undefined) return actual >= matcher.atLeast;
  return matcher.in?.includes(actual) ?? false;
}

export function networkPostconditionFromStep(step: {
  postcondition?: Postcondition;
}): NetworkPostcondition | undefined {
  return step.postcondition?.network;
}

/**
 * A stable identity for backends that expose a snapshot instead of a native
 * response event. Timestamps are preferred; the fallback count handles old
 * agent-browser captures that did not include one.
 */
export function networkEntryKey(entry: NetworkEntry): string {
  return [
    entry.method.toUpperCase(),
    entry.url,
    entry.status ?? "",
    entry.responseTimestamp ?? "",
  ].join("\u0000");
}

export function describeNetworkPostcondition(
  postcondition: NetworkPostcondition,
): string {
  const method = postcondition.method ? `${postcondition.method} ` : "";
  const status = postcondition.status
    ? ` status ${describeStatus(postcondition.status)}`
    : "";
  return `${method}*${postcondition.urlContains}*${status}`.trim();
}

function describeStatus(matcher: StatusMatcher): string {
  if (matcher.equals !== undefined) return `== ${matcher.equals}`;
  if (matcher.below !== undefined) return `< ${matcher.below}`;
  if (matcher.atLeast !== undefined) return `>= ${matcher.atLeast}`;
  return `in [${matcher.in?.join(", ") ?? ""}]`;
}
