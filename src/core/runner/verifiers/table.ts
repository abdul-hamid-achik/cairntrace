import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { TableVerifier } from "../../schema/verifier.v1";
import { describeProbeLocator, runProbe, type ProbeTable } from "./domProbe";
import type { PollRunner } from "./mongo";
import { judgeTable } from "./tableJudge";
import type { VerifierContext, VerifierEvaluation } from "./types";

const DEFAULT_TABLE_TIMEOUT_MS = 5000;
const RENDER_RETRY_MS = 250;

/**
 * `table` verifier: read a rendered table once it exists, then check the
 * row count, blank rows, required rows and headers.
 */
export async function evaluateTable(
  verifier: TableVerifier,
  backend: BrowserBackend,
  ctx: VerifierContext,
  run: PollRunner,
): Promise<VerifierEvaluation> {
  const spec = verifier.table;
  const target = describeProbeLocator(spec.locator);
  let observed: ProbeTable | undefined;
  const polled = await run(async () => {
    const table = await readTable(spec, backend, ctx);
    if (!table) {
      return {
        passed: false,
        expected: `a table at ${target}`,
        actual: `no table found within ${spec.timeoutMs ?? DEFAULT_TABLE_TIMEOUT_MS}ms`,
      };
    }
    observed = table;
    return judgeTable(spec, table, target);
  });
  return {
    ...polled,
    raw: {
      kind: "table",
      request: { locator: spec.locator },
      ...(observed
        ? {
            observed: {
              headers: observed.headers,
              rowCount: observed.rowCount,
              rows: observed.rows.slice(0, 20),
              truncated: observed.rowCount > 20,
            },
          }
        : {}),
      ...(polled.attemptLog ? { attempts: polled.attemptLog } : {}),
      ...(polled.polledMs !== undefined ? { polledMs: polled.polledMs } : {}),
    },
  };
}

async function readTable(
  spec: TableVerifier["table"],
  backend: BrowserBackend,
  ctx: VerifierContext,
): Promise<ProbeTable | undefined> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TABLE_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    const probe = await runProbe(backend, spec.locator, {
      table: true,
      ...(ctx.testIdAttribute ? { testIdAttribute: ctx.testIdAttribute } : {}),
    });
    if (probe.table) return probe.table;
    if (Date.now() - started >= timeoutMs || ctx.signal?.aborted) {
      return undefined;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(RENDER_RETRY_MS, timeoutMs)),
    );
  }
}
