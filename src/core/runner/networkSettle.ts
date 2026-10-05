import type {
  BrowserBackend,
  NetworkEntry,
} from "../../adapters/browserBackend";
import type { Outcome } from "../schema/spec.v1";
import {
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
} from "../schema/verifier.v1";
import {
  filterNetworkEntries,
  isInFlight,
  NETWORK_SETTLE_POLL_MS,
  NETWORK_SETTLE_TIMEOUT_MS,
} from "./verifiers/networkJudge";

/** The method + URL filter of a network-judged outcome. */
export interface JudgedNetworkFilter {
  method?: string;
  urlContains: string;
}

/** Filters of the outcomes judged over the request log (`network`, `noFailedRequests`). */
export function judgedNetworkFilters(
  outcomes: readonly Outcome[],
): JudgedNetworkFilter[] {
  const filters: JudgedNetworkFilter[] = [];
  for (const outcome of outcomes) {
    const v = outcome.verify;
    if (isNetworkVerifier(v)) {
      filters.push({
        urlContains: v.network.urlContains,
        ...(v.network.method ? { method: v.network.method } : {}),
      });
    } else if (isNoFailedRequestsVerifier(v)) {
      filters.push({
        urlContains: v.noFailedRequests.urlContains,
        ...(v.noFailedRequests.method
          ? { method: v.noFailedRequests.method }
          : {}),
      });
    }
  }
  return filters;
}

/**
 * The end-of-steps request log the outcomes are judged (and the evidence
 * written) from. A request an outcome judges that is still in flight — no
 * status and no error — may only be waiting for its response event to reach
 * the backend (the page already saw the fetch resolve), so the log is read
 * again every 100ms for up to 2s until those candidates settle. Nothing
 * waits when no judged request is in flight, so a normal run pays nothing;
 * a request that is genuinely still open stays pending after the bound. On a
 * backend that does not report failures (`reportsRequestFailures: false`)
 * the bound is one poll: a refused or cancelled request never settles there.
 */
export async function settledNetworkSnapshot(
  backend: Pick<
    BrowserBackend,
    "getNetworkRequests" | "reportsRequestFailures"
  >,
  filters: readonly JudgedNetworkFilter[],
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<NetworkEntry[]> {
  let entries = await backend.getNetworkRequests();
  if (filters.length === 0) return entries;
  const pollMs = opts.pollMs ?? NETWORK_SETTLE_POLL_MS;
  const unsettled = (log: NetworkEntry[]): boolean =>
    filters.some((filter) =>
      filterNetworkEntries(log, filter.method, filter.urlContains).some(
        isInFlight,
      ),
    );
  // A backend that never marks a failed or cancelled request (agent-browser)
  // would keep such an entry "in flight" for the whole bound: exactly one
  // re-read catches a response that was just being recorded, nothing more. A
  // count, not a deadline: a timer that fires a few ms early must not buy a
  // second re-read.
  if (backend.reportsRequestFailures === false) {
    if (!unsettled(entries)) return entries;
    const waitMs = Math.min(
      pollMs,
      opts.timeoutMs ?? NETWORK_SETTLE_TIMEOUT_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return backend.getNetworkRequests();
  }
  const boundMs = opts.timeoutMs ?? NETWORK_SETTLE_TIMEOUT_MS;
  const deadline = Date.now() + boundMs;
  while (unsettled(entries)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, remaining)),
    );
    entries = await backend.getNetworkRequests();
  }
  return entries;
}
