import type {
  ValueMatcher,
  XlsxSheetSelector,
  XlsxVerifier,
} from "../../schema/verifier.v1";
import {
  headerColumns,
  sqrefCoversColumn,
  type HeaderColumn,
  type ParsedSheet,
  type ParsedValidation,
  type ParsedWorkbook,
} from "../../../sdk/workbook.js";
import { describeMatcher, matchValue } from "./matchers";

/**
 * The judging half of the `xlsx` verifier: every check against an already
 * parsed workbook (`contains`, `sheets[]`, `headers`, `rows`, `cells`,
 * `validations`). Pure (no file or run context): the Playwright export embeds
 * this file's source (src/core/exporters/runtimeSources.ts) next to the same
 * workbook reader, so an exported test judges a workbook exactly like
 * `cairn run` does. Operands arrive with runtime references resolved.
 *
 * Every failure is listed; `checksRaw` is what the raw sidecar records.
 */

type HeaderSpec = NonNullable<XlsxVerifier["xlsx"]["headers"]>;
type HeaderName = NonNullable<HeaderSpec["present"]>[number];

const HEADER_ASSERTIONS = [
  "present",
  "absent",
  "labels",
  "withinListInOrder",
  "includesInOrder",
] as const;

/** The checks of `verify: { xlsx: … }` (everything but `path`). */
export type XlsxChecks = Omit<XlsxVerifier["xlsx"], "path">;

/** Most header columns / list entries echoed into the raw sidecar. */
export const RAW_LIST_CAP = 60;

export interface XlsxJudgement {
  failures: string[];
  checksRaw: Record<string, unknown>[];
  sheetNames: string[];
  mainSheet: ParsedSheet | undefined;
  mainColumns: HeaderColumn[];
}

export function judgeXlsx(
  workbook: ParsedWorkbook,
  spec: XlsxChecks,
): XlsxJudgement {
  const failures: string[] = [];
  const checksRaw: Record<string, unknown>[] = [];
  const sheetNames = workbook.sheets.map((sheet) => sheet.name);
  const missingSheet = (selector: XlsxSheetSelector): string =>
    `no sheet ${describeSheet(selector)} (sheets: ${sheetNames.join(", ") || "none"})`;

  // ----- contains (workbook-wide unless a sheet is selected) -----
  if (spec.contains) {
    const selected =
      spec.sheet !== undefined ? selectSheet(workbook, spec.sheet) : undefined;
    if (spec.sheet !== undefined && !selected) {
      failures.push(missingSheet(spec.sheet));
    } else {
      const scope = selected ? [selected] : workbook.sheets;
      const where = selected ? selected.name : "workbook";
      const text = scope.map(sheetText).join("\n");
      const missingText = spec.contains.filter(
        (needle) => !text.includes(needle),
      );
      if (missingText.length > 0) {
        failures.push(`${where} missing text: ${missingText.join(", ")}`);
      }
      checksRaw.push({ contains: spec.contains, scope: where, missingText });
    }
  }

  // ----- sheets[].contains (by name) -----
  for (const sheetCheck of spec.sheets ?? []) {
    const sheet = workbook.sheets.find((s) => s.name === sheetCheck.name);
    if (!sheet) {
      failures.push(`missing sheet ${sheetCheck.name}`);
      checksRaw.push({ sheet: sheetCheck.name, found: false });
      continue;
    }
    const text = sheetText(sheet);
    const missingText = (sheetCheck.contains ?? []).filter(
      (needle) => !text.includes(needle),
    );
    if (missingText.length > 0) {
      failures.push(
        `${sheetCheck.name} missing text: ${missingText.join(", ")}`,
      );
    }
    checksRaw.push({
      sheet: sheetCheck.name,
      found: true,
      contains: sheetCheck.contains ?? [],
      missingText,
    });
  }

  // ----- the selected sheet (headers / rows / cells / validations) -----
  const headerSpec: HeaderSpec = spec.headers ?? {};
  const norm = headerNormalizer(headerSpec);
  const needsSheet =
    spec.headers !== undefined ||
    spec.rows !== undefined ||
    (spec.cells ?? []).some((cell) => cell.sheet === undefined) ||
    (spec.validations ?? []).some((v) => v.sheet === undefined);
  const selector: XlsxSheetSelector = spec.sheet ?? 0;
  const mainSheet = needsSheet ? selectSheet(workbook, selector) : undefined;
  if (needsSheet && !mainSheet) failures.push(missingSheet(selector));
  const columnsOf = (sheet: ParsedSheet): HeaderColumn[] =>
    headerColumns(sheet.rows, {
      labelRow: headerSpec.labelRow ?? 1,
      ...(headerSpec.keyRow !== undefined ? { keyRow: headerSpec.keyRow } : {}),
    });
  const mainColumns = mainSheet ? columnsOf(mainSheet) : [];

  // A headers block without assertions only places the label/key rows for
  // rows / validations.
  const assertsHeaders = HEADER_ASSERTIONS.some(
    (key) => headerSpec[key] !== undefined,
  );
  if (mainSheet && assertsHeaders) {
    const result = checkHeaders(headerSpec, mainColumns, norm);
    failures.push(...result.failures.map((f) => `${mainSheet.name}: ${f}`));
    checksRaw.push({ headers: result.raw });
  }

  if (mainSheet && spec.rows) {
    const headerEnd = headerSpec.keyRow ?? headerSpec.labelRow ?? 1;
    const dataRows = mainSheet.rows
      .slice(headerEnd)
      .map((cells, offset) => ({ row: headerEnd + offset + 1, cells }))
      .filter(({ cells }) => cells.some((cell) => cell.trim() !== ""));
    const raw: Record<string, unknown> = {
      dataRows: dataRows.length,
      firstDataRow: headerEnd + 1,
    };
    const bound = spec.rows.afterKeyRow;
    if (bound) {
      const n = dataRows.length;
      const ok =
        bound.count !== undefined
          ? n === bound.count
          : (bound.atLeast === undefined || n >= bound.atLeast) &&
            (bound.atMost === undefined || n <= bound.atMost);
      if (!ok) {
        failures.push(
          `${mainSheet.name}: ${n} data row(s) after row ${headerEnd}, expected ${describeBound(bound)}`,
        );
      }
      raw["afterKeyRow"] = { expected: bound, actual: n };
    }
    if (spec.rows.match) {
      const matchResult = checkRowMatch(
        spec.rows.match,
        dataRows,
        mainColumns,
        norm,
      );
      if (matchResult.failure) {
        failures.push(`${mainSheet.name}: ${matchResult.failure}`);
      }
      raw["match"] = matchResult.raw;
    }
    checksRaw.push({ rows: raw });
  }

  for (const cell of spec.cells ?? []) {
    const sheet =
      cell.sheet !== undefined ? selectSheet(workbook, cell.sheet) : mainSheet;
    if (!sheet) {
      if (cell.sheet !== undefined) failures.push(missingSheet(cell.sheet));
      checksRaw.push({ cell: cell.ref, found: false });
      continue;
    }
    const ref = cell.ref.replaceAll("$", "").toUpperCase();
    const value = sheet.cells.get(ref) ?? "";
    const fmt = sheet.numFmt(ref);
    const problems: string[] = [];
    if (cell.equals !== undefined && value !== String(cell.equals)) {
      problems.push(`equals ${JSON.stringify(String(cell.equals))}`);
    }
    if (cell.matches !== undefined && !new RegExp(cell.matches).test(value)) {
      problems.push(`matches /${cell.matches}/`);
    }
    if (cell.numFmt !== undefined && !numFmtMatches(fmt, cell.numFmt)) {
      problems.push(`numFmt ${JSON.stringify(cell.numFmt)}`);
    }
    if (problems.length > 0) {
      failures.push(
        `${sheet.name}!${ref} expected ${problems.join(" and ")}, got ${JSON.stringify(value)} (numFmt ${describeNumFmt(fmt)})`,
      );
    }
    checksRaw.push({
      cell: `${sheet.name}!${ref}`,
      value,
      numFmt: fmt,
      passed: problems.length === 0,
    });
  }

  for (const check of spec.validations ?? []) {
    const sheet =
      check.sheet !== undefined
        ? selectSheet(workbook, check.sheet)
        : mainSheet;
    if (!sheet) {
      if (check.sheet !== undefined) failures.push(missingSheet(check.sheet));
      checksRaw.push({ validation: check, found: false });
      continue;
    }
    const columns = sheet === mainSheet ? mainColumns : columnsOf(sheet);
    const columnIndex = findValidationColumn(
      sheet,
      columns,
      check.column,
      norm,
    );
    if (columnIndex === undefined) {
      failures.push(`${sheet.name} missing column ${check.column}`);
      checksRaw.push({ validation: check, found: false });
      continue;
    }
    const patterns =
      check.formulaMatches === undefined
        ? []
        : Array.isArray(check.formulaMatches)
          ? check.formulaMatches
          : [check.formulaMatches];
    const covering = sheet.validations.filter((v) =>
      sqrefCoversColumn(v.sqref, columnIndex),
    );
    const matching = covering.filter(
      (v) =>
        (!check.type || v.type === check.type) &&
        patterns.every((p) => formulaMatches(v, p)),
    );
    if (matching.length === 0) {
      const what = [
        check.type ?? "data",
        "validation",
        ...(patterns.length > 0
          ? [
              `with a formula matching ${patterns.map((p) => `/${p}/`).join(" and ")}`,
            ]
          : []),
      ].join(" ");
      const seen =
        covering.length === 0
          ? "none covers the column"
          : `covering: ${covering
              .map(
                (v) =>
                  `${v.type ?? "any"}${
                    v.formula1 !== undefined
                      ? ` ${JSON.stringify(v.formula1)}`
                      : ""
                  }`,
              )
              .join("; ")}`;
      failures.push(`${sheet.name}.${check.column} missing ${what} (${seen})`);
    }
    checksRaw.push({
      validation: check,
      columnIndex,
      found: matching.length > 0,
      matching,
      covering,
    });
  }
  return { failures, checksRaw, sheetNames, mainSheet, mainColumns };
}

/* ----- sheets ----- */

function selectSheet(
  workbook: ParsedWorkbook,
  selector: XlsxSheetSelector,
): ParsedSheet | undefined {
  if (typeof selector === "number") return workbook.sheets[selector];
  if (typeof selector === "string") {
    return workbook.sheets.find((sheet) => sheet.name === selector);
  }
  const pattern = new RegExp(selector.match);
  return workbook.sheets.find((sheet) => pattern.test(sheet.name));
}

function describeSheet(selector: XlsxSheetSelector): string {
  if (typeof selector === "number") return `at index ${selector}`;
  if (typeof selector === "string") return JSON.stringify(selector);
  return `matching /${selector.match}/`;
}

function sheetText(sheet: ParsedSheet): string {
  return [...sheet.cells.values()].join("\n");
}

/* ----- header names ----- */

interface Normalizer {
  (text: string): string;
  caseSensitive: boolean;
}

/** Collapse whitespace, remove `strip`, trim; lowercase unless caseSensitive. */
function headerNormalizer(spec: HeaderSpec): Normalizer {
  const strip =
    spec.strip !== undefined ? new RegExp(spec.strip, "g") : undefined;
  const caseSensitive = spec.caseSensitive === true;
  const fn = ((text: string) => {
    let out = String(text).replace(/\s+/g, " ").trim();
    if (strip) out = out.replace(strip, "").replace(/\s+/g, " ").trim();
    return caseSensitive ? out : out.toLowerCase();
  }) as Normalizer;
  fn.caseSensitive = caseSensitive;
  return fn;
}

/** Whether a column's label or key answers to `name`. */
function columnAnswers(
  column: HeaderColumn,
  name: HeaderName,
  norm: Normalizer,
): boolean {
  const candidates = [column.label, column.key ?? ""].filter((t) => t !== "");
  if (typeof name === "string") {
    const wanted = norm(name);
    return wanted !== "" && candidates.some((text) => norm(text) === wanted);
  }
  const pattern = new RegExp(name.matches, norm.caseSensitive ? "" : "i");
  return candidates.some((text) =>
    pattern.test(text.replace(/\s+/g, " ").trim()),
  );
}

function describeName(name: HeaderName): string {
  return typeof name === "string" ? JSON.stringify(name) : `/${name.matches}/`;
}

function columnName(column: HeaderColumn): string {
  const parts = [column.label, column.key].filter(
    (t): t is string => t !== undefined && t !== "",
  );
  return `${column.letter} ${JSON.stringify(parts.join(" / "))}`;
}

/** A header list operand after reference resolution, or an error. */
function headerList(
  value: unknown,
  field: string,
): { names: string[] } | { error: string } {
  if (!Array.isArray(value)) {
    return {
      error: `headers.${field} must resolve to a list, got ${
        value === null ? "null" : typeof value
      }`,
    };
  }
  return {
    names: value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => String(item))
      .filter((item) => item.trim() !== ""),
  };
}

/* ----- headers ----- */

function checkHeaders(
  spec: HeaderSpec,
  columns: HeaderColumn[],
  norm: Normalizer,
): { failures: string[]; raw: Record<string, unknown> } {
  const failures: string[] = [];
  const raw: Record<string, unknown> = {
    labelRow: spec.labelRow ?? 1,
    ...(spec.keyRow !== undefined ? { keyRow: spec.keyRow } : {}),
    columnCount: columns.length,
  };
  if (columns.length === 0) {
    failures.push(`no header columns in row ${spec.labelRow ?? 1}`);
  }

  if (spec.present) {
    const missing = spec.present.filter(
      (name) => !columns.some((column) => columnAnswers(column, name, norm)),
    );
    if (missing.length > 0) {
      failures.push(
        `missing column(s) ${missing.map(describeName).join(", ")}`,
      );
    }
    raw["present"] = { missing: missing.map(describeName) };
  }

  if (spec.absent) {
    const hits = spec.absent.flatMap((name) =>
      columns
        .filter((column) => columnAnswers(column, name, norm))
        .map((column) => `${describeName(name)} at ${columnName(column)}`),
    );
    if (hits.length > 0) {
      failures.push(`unexpected column(s) ${hits.join(", ")}`);
    }
    raw["absent"] = { found: hits };
  }

  if (spec.labels) {
    const mismatches: string[] = [];
    for (const [key, label] of Object.entries(spec.labels)) {
      const column = columns.find(
        (c) => c.key !== undefined && c.key !== "" && norm(c.key) === norm(key),
      );
      if (!column) {
        mismatches.push(`key ${JSON.stringify(key)} not found`);
        continue;
      }
      if (norm(column.label) !== norm(label)) {
        mismatches.push(
          `${column.letter} key ${JSON.stringify(key)} labelled ${JSON.stringify(column.label)}, expected ${JSON.stringify(label)}`,
        );
      }
    }
    if (mismatches.length > 0) {
      failures.push(`labels: ${mismatches.join("; ")}`);
    }
    raw["labels"] = { mismatches };
  }

  if (spec.includesInOrder !== undefined) {
    const list = headerList(spec.includesInOrder, "includesInOrder");
    if ("error" in list) failures.push(list.error);
    else {
      const result = includesInOrder(list.names, columns, norm);
      if (result.missing.length > 0 || result.outOfOrder.length > 0) {
        failures.push(
          [
            "headers do not include the list in order",
            ...(result.missing.length > 0
              ? [
                  `missing ${result.missing.map((n) => JSON.stringify(n)).join(", ")}`,
                ]
              : []),
            ...(result.outOfOrder.length > 0
              ? [`out of order ${result.outOfOrder.join(", ")}`]
              : []),
          ].join(": "),
        );
      }
      raw["includesInOrder"] = {
        list: list.names.slice(0, RAW_LIST_CAP),
        ...result,
      };
    }
  }

  if (spec.withinListInOrder !== undefined) {
    const list = headerList(spec.withinListInOrder, "withinListInOrder");
    if ("error" in list) failures.push(list.error);
    else {
      const result = withinListInOrder(list.names, columns, norm);
      if (result.extra.length > 0 || result.outOfOrder.length > 0) {
        failures.push(
          [
            "headers are not an ordered subset of the list",
            ...(result.extra.length > 0
              ? [`not in the list ${result.extra.join(", ")}`]
              : []),
            ...(result.outOfOrder.length > 0
              ? [`out of order ${result.outOfOrder.join(", ")}`]
              : []),
          ].join(": "),
        );
      }
      raw["withinListInOrder"] = {
        list: list.names.slice(0, RAW_LIST_CAP),
        ...result,
      };
    }
  }
  return { failures, raw };
}

/**
 * Every name is a column, at increasing positions (extra columns allowed).
 * Greedy: each name takes the first matching column after the previous one.
 */
function includesInOrder(
  names: string[],
  columns: HeaderColumn[],
  norm: Normalizer,
): {
  missing: string[];
  outOfOrder: string[];
  positions: Array<string | null>;
} {
  const missing: string[] = [];
  const outOfOrder: string[] = [];
  const positions: Array<string | null> = [];
  let after = -1;
  for (const name of names) {
    const next = columns.findIndex(
      (column, i) => i > after && columnAnswers(column, name, norm),
    );
    if (next >= 0) {
      after = next;
      positions.push(columns[next]!.letter);
      continue;
    }
    positions.push(null);
    const anywhere = columns.find((column) =>
      columnAnswers(column, name, norm),
    );
    if (anywhere) {
      outOfOrder.push(
        `${JSON.stringify(name)} (at ${anywhere.letter}, before the name listed ahead of it)`,
      );
    } else {
      missing.push(name);
    }
  }
  return { missing, outOfOrder, positions };
}

/**
 * Every header column appears in the list, at increasing list positions
 * (the list may hold names the sheet lacks).
 */
function withinListInOrder(
  names: string[],
  columns: HeaderColumn[],
  norm: Normalizer,
): { extra: string[]; outOfOrder: string[] } {
  const extra: string[] = [];
  const outOfOrder: string[] = [];
  let after = -1;
  for (const column of columns) {
    const next = names.findIndex(
      (name, i) => i > after && columnAnswers(column, name, norm),
    );
    if (next >= 0) {
      after = next;
      continue;
    }
    if (names.some((name) => columnAnswers(column, name, norm))) {
      outOfOrder.push(columnName(column));
    } else {
      extra.push(columnName(column));
    }
  }
  return { extra, outOfOrder };
}

/* ----- rows ----- */

function describeBound(bound: {
  count?: number;
  atLeast?: number;
  atMost?: number;
}): string {
  if (bound.count !== undefined) return `exactly ${bound.count}`;
  return [
    bound.atLeast !== undefined ? `at least ${bound.atLeast}` : "",
    bound.atMost !== undefined ? `at most ${bound.atMost}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

/** Cells are strings: a bare number/boolean matcher compares as text. */
function cellMatcher(matcher: ValueMatcher): ValueMatcher {
  return typeof matcher === "number" || typeof matcher === "boolean"
    ? String(matcher)
    : matcher;
}

function checkRowMatch(
  entries: Array<{ column: string; matcher: ValueMatcher }>,
  dataRows: Array<{ row: number; cells: string[] }>,
  columns: HeaderColumn[],
  norm: Normalizer,
): { failure?: string; raw: Record<string, unknown> } {
  const wanted = entries
    .map(
      (entry) =>
        `${entry.column} ${describeMatcher(cellMatcher(entry.matcher))}`,
    )
    .join(" and ");
  const resolved: Array<{ column: HeaderColumn; matcher: ValueMatcher }> = [];
  const unknown: string[] = [];
  for (const entry of entries) {
    const column = columns.find((c) => columnAnswers(c, entry.column, norm));
    if (column) resolved.push({ column, matcher: cellMatcher(entry.matcher) });
    else unknown.push(JSON.stringify(entry.column));
  }
  if (unknown.length > 0) {
    return {
      failure: `rows.match: missing column(s) ${unknown.join(", ")}`,
      raw: { wanted, matched: false },
    };
  }
  const hit = dataRows.find(({ cells }) =>
    resolved.every(
      ({ column, matcher }) =>
        matchValue(cells[column.index] ?? "", true, matcher, column.label)
          .passed,
    ),
  );
  if (hit) return { raw: { wanted, matched: true, row: hit.row } };
  return {
    failure: `no data row where ${wanted} (${dataRows.length} row(s) checked)`,
    raw: {
      wanted,
      matched: false,
      sample: dataRows.slice(0, 5).map(({ row, cells }) => ({
        row,
        cells: Object.fromEntries(
          resolved.map(({ column }) => [
            column.label || column.letter,
            cells[column.index] ?? "",
          ]),
        ),
      })),
    },
  };
}

/* ----- cells ----- */

function numFmtMatches(
  actual: { id: number; code?: string },
  expected: string | number,
): boolean {
  if (typeof expected === "number") return actual.id === expected;
  return (actual.code ?? "").toLowerCase() === expected.toLowerCase();
}

function describeNumFmt(fmt: { id: number; code?: string }): string {
  return fmt.code !== undefined
    ? `${fmt.id} ${JSON.stringify(fmt.code)}`
    : `${fmt.id}`;
}

/* ----- validations ----- */

/**
 * The 0-based column a validation check names: a header column (label or
 * key on the configured rows), else — as before F17 — a cell with that text
 * in the first 20 rows.
 */
function findValidationColumn(
  sheet: ParsedSheet,
  columns: HeaderColumn[],
  name: string,
  norm: Normalizer,
): number | undefined {
  const fromHeaders = columns.find((column) =>
    columnAnswers(column, name, norm),
  );
  if (fromHeaders) return fromHeaders.index;
  const wanted = norm(name);
  for (const row of sheet.rows.slice(0, 20)) {
    const index = row.findIndex((cell) => cell !== "" && norm(cell) === wanted);
    if (index >= 0) return index;
  }
  return undefined;
}

function formulaMatches(
  validation: ParsedValidation,
  pattern: string,
): boolean {
  const regex = new RegExp(pattern);
  return [validation.formula1, validation.formula2].some(
    (formula) => formula !== undefined && regex.test(formula),
  );
}
