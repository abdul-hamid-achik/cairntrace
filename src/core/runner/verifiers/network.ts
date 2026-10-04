import type {
  BrowserBackend,
  NetworkEntry,
} from "../../../adapters/browserBackend";
import type { NetworkVerifier } from "../../schema/verifier.v1";
import { boundValue } from "./evidence";
import {
  entryTime,
  filterNetworkEntries,
  judgeNetwork,
  type NetworkJudgeEntry,
} from "./networkJudge";
import type { VerifierContext, VerifierEvaluation } from "./types";

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

  const judged = judgeNetwork(all, verifier.network, ctx);
  if (judged.unresolved) {
    return {
      passed: false,
      expected: judged.expected,
      actual: judged.actual,
    };
  }
  const { matching, bodyJson, bodyMode } = judged;

  if (assign && judged.assignment) {
    ctx.networkAssigns ??= {};
    ctx.networkAssigns[assign] = judged.assignment;
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

  return {
    passed: judged.passed,
    expected: judged.expected,
    actual: judged.actual,
    ...(raw ? { raw } : {}),
  };
}

function entrySummary(entry: NetworkJudgeEntry): Record<string, unknown> {
  const at = entryTime(entry);
  return {
    method: entry.method,
    url: entry.url,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(at ? { at } : {}),
  };
}
