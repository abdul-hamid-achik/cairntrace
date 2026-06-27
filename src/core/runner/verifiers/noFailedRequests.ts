import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { NoFailedRequestsVerifier } from "../../schema/verifier.v1";
import { formatEntries } from "./network";
import type { VerifierEvaluation } from "./types";

export async function evaluateNoFailedRequests(
  verifier: NoFailedRequestsVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const { urlContains, method } = verifier.noFailedRequests;
  const all = await backend.getNetworkRequests({ method, filter: urlContains });
  // A request is "failed" if it returned 4xx/5xx OR carries an error marker
  // (aborted / blocked / DNS-failed / connection-refused / request-step
  // failure) — those never get a >=400 status, so a status-only check would
  // silently miss the most severe failures. A merely-pending request has
  // neither, so it is not flagged.
  const failed = all.filter(
    (e) => e.error !== undefined || (e.status !== undefined && e.status >= 400),
  );

  const expected = `no ${method ?? "any"}-method requests matching ${JSON.stringify(urlContains)} returned 4xx/5xx or failed to complete`;

  if (failed.length === 0) {
    return {
      passed: true,
      expected,
      actual:
        all.length === 0
          ? "no matching requests observed (the filter produced an empty set)"
          : `all ${all.length} matching request(s) completed with status <400`,
    };
  }

  return {
    passed: false,
    expected,
    actual: `${failed.length} failing request(s):\n${formatEntries(failed.slice(0, 10))}`,
  };
}
