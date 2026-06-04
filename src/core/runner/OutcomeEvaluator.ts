import type { BrowserBackend } from "../../adapters/browserBackend";
import type { Outcome } from "../schema/spec.v1";
import {
  isConsoleVerifier,
  isCountVerifier,
  isFileVerifier,
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
  isNotTextVerifier,
  isScriptVerifier,
  isTextVerifier,
  isUrlVerifier,
  isXlsxVerifier,
} from "../schema/verifier.v1";
import { evaluateConsole } from "./verifiers/console";
import { evaluateCount } from "./verifiers/count";
import { evaluateFile } from "./verifiers/file";
import { evaluateNetwork } from "./verifiers/network";
import { evaluateNoFailedRequests } from "./verifiers/noFailedRequests";
import { evaluateNotText } from "./verifiers/notText";
import { evaluateScript } from "./verifiers/script";
import { evaluateText } from "./verifiers/text";
import { evaluateUrl } from "./verifiers/url";
import { evaluateXlsx } from "./verifiers/xlsx";
import type { VerifierContext, VerifierEvaluation } from "./verifiers/types";

export interface EvaluatedOutcome {
  outcome: Outcome;
  evaluation: VerifierEvaluation;
}

/**
 * Dispatch each Outcome's verifier to the matching evaluator function and
 * return a per-outcome (outcome, evaluation) pair. Pure dispatch — does not
 * write evidence files; the ArtifactWriter handles that based on these results.
 */
export async function evaluateOutcomes(
  outcomes: Outcome[],
  backend: BrowserBackend,
  ctx: VerifierContext,
): Promise<EvaluatedOutcome[]> {
  const results: EvaluatedOutcome[] = [];
  for (const outcome of outcomes) {
    const evaluation = await dispatch(outcome, backend, ctx);
    results.push({ outcome, evaluation });
  }
  return results;
}

async function dispatch(
  outcome: Outcome,
  backend: BrowserBackend,
  ctx: VerifierContext,
): Promise<VerifierEvaluation> {
  const v = outcome.verify;
  try {
    if (isTextVerifier(v)) return await evaluateText(v, backend);
    if (isNotTextVerifier(v)) return await evaluateNotText(v, backend);
    if (isUrlVerifier(v)) return await evaluateUrl(v, backend);
    if (isNetworkVerifier(v)) return await evaluateNetwork(v, backend);
    if (isNoFailedRequestsVerifier(v))
      return await evaluateNoFailedRequests(v, backend);
    if (isConsoleVerifier(v)) return await evaluateConsole(v, backend);
    if (isCountVerifier(v)) return await evaluateCount(v, backend);
    if (isXlsxVerifier(v)) return await evaluateXlsx(v, ctx);
    if (isFileVerifier(v)) return await evaluateFile(v, ctx);
    if (isScriptVerifier(v)) return await evaluateScript(v, backend, ctx);
  } catch (e) {
    return {
      passed: false,
      expected: `outcome ${outcome.id} to evaluate without throwing`,
      actual: `verifier threw: ${(e as Error).message}`,
    };
  }
  // Should be unreachable given the schema union covers all verifier shapes.
  void ctx;
  return {
    passed: false,
    expected: "a known verifier kind",
    actual: `unrecognized verifier shape: ${JSON.stringify(Object.keys(v))}`,
  };
}
