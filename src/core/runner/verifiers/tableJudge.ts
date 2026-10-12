import { normalizeTextForMatching } from "../../textMatching";

/** One check's outcome, structurally (the runner's `MatchOutcome`). */
interface TableCheck {
  passed: boolean;
  expected: string;
  actual: string;
}

/**
 * The checks of a `table` verifier, structurally: the runner's zod type and
 * the Playwright export's emitted `CairnTableSpec` both feed this.
 */
export interface TableChecks {
  rows?: {
    equals?: number;
    atLeast?: number;
    atMost?: number;
    noBlank?: boolean;
    ignoreCells?: string[];
  };
  headers?: { includes: string[]; inOrder?: boolean };
  contains?: Array<string | Record<string, string>>;
}

/** A table as the probe reads it: header labels, cell rows, row count. */
export interface JudgedTable {
  headers: string[];
  rows: string[][];
  rowCount: number;
}

export interface TableVerdict {
  passed: boolean;
  expected: string;
  actual: string;
}

/**
 * The `table` verifier's checks against an already-read table: row count,
 * blank rows, required headers (optionally in order) and required rows.
 * Pure — the runner reads the table from the browser, the Playwright export
 * from its own probe, and both judge here.
 */
export function judgeTable(
  spec: TableChecks,
  table: JudgedTable,
  target: string,
): TableVerdict {
  const checks: TableCheck[] = [];
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
    const ignored = new Set(
      (rows.ignoreCells ?? []).map((cell) => normalizeTextForMatching(cell)),
    );
    const headerIgnored = table.headers.map((header) =>
      ignored.has(normalizeTextForMatching(header)),
    );
    const blank: number[] = [];
    table.rows.forEach((cells, index) => {
      const meaningful = cells.filter(
        (cell, column) =>
          !headerIgnored[column] &&
          !ignored.has(normalizeTextForMatching(cell)) &&
          normalizeTextForMatching(cell) !== "",
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
    const have = table.headers.map((header) =>
      normalizeTextForMatching(header),
    );
    const wanted = spec.headers.includes.map((header) =>
      normalizeTextForMatching(header),
    );
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
      const needle = normalizeTextForMatching(wanted);
      const hit = table.rows.some((cells) =>
        normalizeTextForMatching(cells.join(" ")).includes(needle),
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
      index: table.headers
        .map((header_) => normalizeTextForMatching(header_))
        .indexOf(normalizeTextForMatching(header)),
      text: normalizeTextForMatching(text),
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
        normalizeTextForMatching(cells[column.index] ?? "").includes(
          column.text,
        ),
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
