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
  const failed = all.filter((e) => e.status !== undefined && e.status >= 400);

  const expected = `no ${method ?? "any"}-method requests matching ${JSON.stringify(urlContains)} returned 4xx/5xx`;

  if (failed.length === 0) {
    return {
      passed: true,
      expected,
      actual:
        all.length === 0
          ? "no matching requests observed (the filter produced an empty set)"
          : `all ${all.length} matching request(s) returned <400`,
    };
  }

  return {
    passed: false,
    expected,
    actual: `${failed.length} failing request(s):\n${formatEntries(failed.slice(0, 10))}`,
  };
}
