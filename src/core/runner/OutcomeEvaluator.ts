import type { BrowserBackend } from "../../adapters/browserBackend";
import type { Outcome } from "../schema/spec.v1";
import {
  isConsoleVerifier,
  isCountVerifier,
  isFileVerifier,
  isHttpJsonVerifier,
  isHttpVerifier,
  isMongoVerifier,
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
  isNotTextVerifier,
  isProcessVerifier,
  isScriptVerifier,
  isTableVerifier,
  isTemporalVerifier,
  isTextVerifier,
  isUrlVerifier,
  isValueVerifier,
  isXlsxVerifier,
  verifierKind,
  verifierPoll,
  type Poll,
  type Verifier,
} from "../schema/verifier.v1";
import { evaluateConsole } from "./verifiers/console";
import { evaluateCount } from "./verifiers/count";
import { evaluateFile } from "./verifiers/file";
import { evaluateHttp } from "./verifiers/http";
import { evaluateHttpJson } from "./verifiers/httpJson";
import { evaluateMongo, type PollRunner } from "./verifiers/mongo";
import { evaluateNetwork } from "./verifiers/network";
import { evaluateNoFailedRequests } from "./verifiers/noFailedRequests";
import { evaluateNotText } from "./verifiers/notText";
import { runPolled, withPollEvidence } from "./verifiers/poll";
import { evaluateProcess } from "./verifiers/process";
import { collectMissingProducedRefs, resolveRefsDeep } from "./verifiers/refs";
import { evaluateScript } from "./verifiers/script";
import { evaluateTable } from "./verifiers/table";
import { evaluateTemporal } from "./verifiers/temporal";
import { evaluateText } from "./verifiers/text";
import { evaluateUrl } from "./verifiers/url";
import { evaluateValue } from "./verifiers/value";
import { evaluateXlsx } from "./verifiers/xlsx";
import { collectUnresolvedRuntimeRefs } from "./runtimePlaceholders";
import type { VerifierContext, VerifierEvaluation } from "./verifiers/types";

export interface EvaluatedOutcome {
  outcome: Outcome;
  evaluation: VerifierEvaluation;
}

export interface OutcomeHooks {
  onStart?(outcome: Outcome): void;
  onFinish?(outcome: Outcome, evaluation: VerifierEvaluation): void;
  /** Live narration while a verifier polls (`outcome.progress`). */
  onProgress?(outcome: Outcome, message: string): void;
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
  hooks?: OutcomeHooks,
): Promise<EvaluatedOutcome[]> {
  const results: EvaluatedOutcome[] = [];
  for (const outcome of outcomes) {
    hooks?.onStart?.(outcome);
    const evaluation = await dispatch(outcome, backend, ctx, (message) =>
      hooks?.onProgress?.(outcome, message),
    );
    hooks?.onFinish?.(outcome, evaluation);
    results.push({ outcome, evaluation });
  }
  return results;
}

/**
 * The poll a verifier runs under: its `poll` modifier, widened for a
 * temporal `absent: { stableMs }` (which is a stability window by nature).
 */
export function effectivePoll(v: Verifier): Poll | undefined {
  const poll = verifierPoll(v);
  if (isTemporalVerifier(v)) {
    const absent = v.temporal.expect.absent;
    if (absent !== null && typeof absent === "object") {
      const stable = absent.stableMs;
      const everyMs =
        poll?.everyMs ?? Math.min(1000, Math.max(100, Math.floor(stable / 5)));
      return {
        ...poll,
        everyMs,
        stableMs: Math.max(poll?.stableMs ?? 0, stable),
        timeoutMs: Math.max(poll?.timeoutMs ?? 0, stable + everyMs * 2),
      };
    }
  }
  return poll;
}

async function dispatch(
  outcome: Outcome,
  backend: BrowserBackend,
  ctx: VerifierContext,
  onProgress: (message: string) => void,
): Promise<VerifierEvaluation> {
  const v = outcome.verify;

  // A failed step stops the run before later steps produce their artifacts.
  // Outcomes that verify those artifacts are blocked, not failed — evaluating
  // them anyway yields misleading "missing file" failures (and the file
  // verifier would burn its full poll timeout on a file that can't appear).
  if (ctx.failedStep) {
    const missing = [
      ...collectUnresolvedRuntimeRefs(
        v,
        ctx.artifacts,
        ctx.responses,
        ctx.evals,
      ),
      ...collectMissingProducedRefs(v, ctx),
    ];
    if (missing.length > 0) {
      return {
        passed: false,
        skipped: true,
        expected: `${missing.join(", ")} to be produced by an earlier step`,
        actual: `blocked: ${missing.join(", ")} never produced — run stopped at failed step "${ctx.failedStep}"`,
      };
    }
  }

  const poll = effectivePoll(v);
  const run: PollRunner = (attempt) =>
    runPolled(attempt, poll, {
      ...(ctx.failedStep ? { failedStep: ctx.failedStep } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onProgress,
    });

  try {
    // Datasource / value / table verifiers own their poll loop (they keep a
    // connection or the resolved query across attempts).
    if (isMongoVerifier(v)) return await evaluateMongo(v, ctx, run);
    if (isTemporalVerifier(v)) return await evaluateTemporal(v, ctx, run);
    if (isHttpVerifier(v)) return await evaluateHttp(v, ctx, run);
    if (isValueVerifier(v)) return await evaluateValue(v, ctx, run);
    if (isTableVerifier(v)) return await evaluateTable(v, backend, ctx, run);

    // An unresolved reference in a network body does not appear by
    // waiting (earlier outcomes already ran): evaluate once, no polling.
    if (
      !poll ||
      (isNetworkVerifier(v) &&
        v.network.body !== undefined &&
        resolveRefsDeep(v.network.body.json, ctx).missing.length > 0)
    ) {
      return await evaluateOnce(v, backend, ctx, 1);
    }
    const polled = await run(({ attempt }) =>
      evaluateOnce(v, backend, ctx, attempt),
    );
    return withPollEvidence(polled, verifierKind(v));
  } catch (e) {
    return {
      passed: false,
      expected: `outcome ${outcome.id} to evaluate without throwing`,
      actual: `verifier threw: ${(e as Error).message}`,
    };
  }
}

/**
 * One evaluation of a browser/artifact verifier. Under poll, attempts after
 * the first read the network/console live instead of the end-of-steps
 * snapshot (a polled network check is waiting for a request that has not
 * happened yet).
 */
async function evaluateOnce(
  v: Verifier,
  backend: BrowserBackend,
  ctx: VerifierContext,
  attempt: number,
): Promise<VerifierEvaluation> {
  const live = attempt > 1;
  if (isTextVerifier(v)) return evaluateText(v, backend);
  if (isNotTextVerifier(v)) return evaluateNotText(v, backend);
  if (isUrlVerifier(v)) return evaluateUrl(v, backend);
  if (isNetworkVerifier(v)) {
    return evaluateNetwork(
      v,
      backend,
      live ? undefined : ctx.networkEntries,
      ctx,
    );
  }
  if (isNoFailedRequestsVerifier(v)) {
    return evaluateNoFailedRequests(
      v,
      backend,
      live ? undefined : ctx.networkEntries,
    );
  }
  if (isConsoleVerifier(v)) {
    return evaluateConsole(
      v,
      backend,
      live
        ? {}
        : { errors: ctx.consoleErrors, unavailable: ctx.consoleUnavailable },
    );
  }
  if (isCountVerifier(v)) return evaluateCount(v, backend);
  if (isXlsxVerifier(v)) return evaluateXlsx(v, ctx);
  if (isFileVerifier(v)) return evaluateFile(v, ctx);
  if (isHttpJsonVerifier(v)) return evaluateHttpJson(v, backend, ctx);
  if (isScriptVerifier(v)) return evaluateScript(v, backend, ctx);
  if (isProcessVerifier(v)) return evaluateProcess(v, ctx);
  // Should be unreachable given the schema union covers all verifier shapes.
  return {
    passed: false,
    expected: "a known verifier kind",
    actual: `unrecognized verifier shape: ${JSON.stringify(Object.keys(v))}`,
  };
}
