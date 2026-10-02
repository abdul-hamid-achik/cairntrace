import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { TableVerifier } from "../../schema/verifier.v1";
import { normalizeTextForMatching } from "../../textMatching";
import { describeProbeLocator, runProbe, type ProbeTable } from "./domProbe";
import type { MatchOutcome } from "./matchers";
import type { PollRunner } from "./mongo";
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

const norm = (text: string): string => normalizeTextForMatching(text);

function judgeTable(
  spec: TableVerifier["table"],
  table: ProbeTable,
  target: string,
): VerifierEvaluation {
  const checks: MatchOutcome[] = [];
  const rows = spec.rows;
  if (rows?.equals !== undefined) {
    checks.push({
      passed: table.rowCount === rows.equals,
      expected: `${rows.equals} row(s)`,
      actual: `${table.rowCount} row(s)`,
    });
  }
  if (rows?.atLeast !== undefined) {
    checks.push({
      passed: table.rowCount >= rows.atLeast,
      expected: `at least ${rows.atLeast} row(s)`,
      actual: `${table.rowCount} row(s)`,
    });
  }
  if (rows?.atMost !== undefined) {
    checks.push({
      passed: table.rowCount <= rows.atMost,
      expected: `at most ${rows.atMost} row(s)`,
      actual: `${table.rowCount} row(s)`,
    });
  }
  if (rows?.noBlank) {
    const ignored = new Set((rows.ignoreCells ?? []).map(norm));
    const headerIgnored = table.headers.map((h) => ignored.has(norm(h)));
    const blank: number[] = [];
    table.rows.forEach((cells, index) => {
      const meaningful = cells.filter(
        (cell, column) =>
          !headerIgnored[column] &&
          !ignored.has(norm(cell)) &&
          norm(cell) !== "",
      );
      if (meaningful.length === 0) blank.push(index);
    });
    checks.push({
      passed: blank.length === 0,
      expected: "no blank row",
      actual:
        blank.length === 0
          ? "no blank row"
          : `blank row(s) at index ${blank.slice(0, 10).join(", ")}`,
    });
  }
  if (spec.headers) {
    const have = table.headers.map(norm);
    const wanted = spec.headers.includes.map(norm);
    const missing = spec.headers.includes.filter(
      (_header, index) => !have.includes(wanted[index]!),
    );
    let inOrder = true;
    if (spec.headers.inOrder && missing.length === 0) {
      const positions = wanted.map((header) => have.indexOf(header));
      inOrder = positions.every(
        (position, index) => index === 0 || position > positions[index - 1]!,
      );
    }
    checks.push({
      passed: missing.length === 0 && inOrder,
      expected: `headers ${
        spec.headers.inOrder ? "in order " : ""
      }[${spec.headers.includes.join(", ")}]`,
      actual:
        missing.length > 0
          ? `missing ${missing.join(", ")} (headers: ${table.headers.join(" | ")})`
          : inOrder
            ? `headers: ${table.headers.join(" | ")}`
            : `out of order (headers: ${table.headers.join(" | ")})`,
    });
  }
  for (const wanted of spec.contains ?? []) {
    if (typeof wanted === "string") {
      const needle = norm(wanted);
      const hit = table.rows.some((cells) =>
        norm(cells.join(" ")).includes(needle),
      );
      checks.push({
        passed: hit,
        expected: `a row containing ${JSON.stringify(wanted)}`,
        actual: hit ? "found" : `no row contains ${JSON.stringify(wanted)}`,
      });
      continue;
    }
    const columns = Object.entries(wanted).map(([header, text]) => ({
      header,
      index: table.headers.map(norm).indexOf(norm(header)),
      text: norm(text),
    }));
    const unknown = columns.filter((column) => column.index < 0);
    if (unknown.length > 0) {
      checks.push({
        passed: false,
        expected: `a row with ${JSON.stringify(wanted)}`,
        actual: `no column ${unknown.map((c) => JSON.stringify(c.header)).join(", ")} (headers: ${table.headers.join(" | ")})`,
      });
      continue;
    }
    const hit = table.rows.some((cells) =>
      columns.every((column) =>
        norm(cells[column.index] ?? "").includes(column.text),
      ),
    );
    checks.push({
      passed: hit,
      expected: `a row with ${JSON.stringify(wanted)}`,
      actual: hit ? "found" : `no such row among ${table.rowCount}`,
    });
  }
  const failing = checks.filter((check) => !check.passed);
  return {
    passed: failing.length === 0,
    expected: `table ${target}: ${checks.map((check) => check.expected).join("; ")}`,
    actual: [
      `${table.rowCount} row(s), headers ${table.headers.join(" | ") || "(none)"}`,
      ...failing.map((check) => check.actual),
    ].join("; "),
  };
}
