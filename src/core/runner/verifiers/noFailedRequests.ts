import type {
  BrowserBackend,
  NetworkEntry,
} from "../../../adapters/browserBackend";
import type { NoFailedRequestsVerifier } from "../../schema/verifier.v1";
import {
  filterNetworkEntries,
  isInFlight,
  judgeNoFailedRequests,
} from "./networkJudge";
import type { VerifierEvaluation } from "./types";

/**
 * `noFailedRequests` over the end-of-steps snapshot (or the live log under
 * poll). The verdict is the runner's `judgeNoFailedRequests`, which the
 * Playwright export embeds too (single-sourced, network errors included).
 */
export async function evaluateNoFailedRequests(
  verifier: NoFailedRequestsVerifier,
  backend: BrowserBackend,
  capturedEntries?: NetworkEntry[],
): Promise<VerifierEvaluation> {
  const { urlContains, method } = verifier.noFailedRequests;
  const all = capturedEntries
    ? filterNetworkEntries(capturedEntries, method, urlContains)
    : await backend.getNetworkRequests({ method, filter: urlContains });
  const judged = judgeNoFailedRequests(all, verifier.noFailedRequests);
  // A backend that never marks a failed or cancelled request cannot judge
  // the requests that did not complete: say so instead of a silent pass.
  const unjudged =
    backend.reportsRequestFailures === false
      ? all.filter(isInFlight).length
      : 0;
  return {
    passed: judged.passed,
    expected: judged.expected,
    actual:
      unjudged > 0
        ? `${judged.actual}; ${unjudged} matching request(s) never completed (no status): ${backend.name} does not report failed or cancelled requests, so a refused, blocked or cancelled one cannot be told from one still in flight (use the playwright backend to judge them)`
        : judged.actual,
  };
}
