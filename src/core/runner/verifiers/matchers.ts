import type {
  PathMatchers,
  ValueMatcher,
  ValueMatcherObject,
} from "../../schema/verifier.v1";

/**
 * Data matchers shared by the mongo / temporal / http / value / network
 * verifiers and the `expect` step. Raw, case-sensitive comparisons (data is
 * not rendered text) unless the matcher says `ignoreCase: true`.
 */

export interface MatchOutcome {
  passed: boolean;
  /** What the matcher wanted, e.g. `status equals "COMPLETED"`. */
  expected: string;
  /** What was there, e.g. `"RUNNING"` or `missing`. */
  actual: string;
}

/* ----- paths ----- */

type PathToken =
  | { key: string }
  | { index: number }
  | { wildcard: true }
  | { filter: FilterExpr };

/**
 * Parse `$`, `$.a.b`, `a.b`, `items[0].id`, `items.0.id`, `rows[*].name`,
 * `$['key with.dots']`, and a filter `tasks[?(@.title=="x")].id` (see
 * parseFilter). An empty path (or `$`) is the root.
 */
export function parsePath(path: string): PathToken[] {
  let rest = path.trim();
  if (rest.startsWith("$")) rest = rest.slice(1);
  const tokens: PathToken[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === ".") {
      i++;
      continue;
    }
    if (ch === "[") {
      const close = findClosingBracket(rest, i);
      const inner = rest.slice(i + 1, close).trim();
      i = close + 1;
      if (inner === "*") tokens.push({ wildcard: true });
      else if (inner.startsWith("?")) {
        tokens.push({ filter: parseFilter(inner.slice(1), path) });
      } else if (/^-?\d+$/.test(inner)) tokens.push({ index: Number(inner) });
      else tokens.push({ key: inner.replace(/^(['"])(.*)\1$/, "$2") });
      continue;
    }
    let end = i;
    while (end < rest.length && rest[end] !== "." && rest[end] !== "[") end++;
    const segment = rest.slice(i, end);
    i = end;
    if (segment === "*") tokens.push({ wildcard: true });
    else tokens.push({ key: segment });
  }
  return tokens;
}

function findClosingBracket(text: string, open: number): number {
  let quote: string | undefined;
  let depth = 0;
  for (let j = open + 1; j < text.length; j++) {
    const ch = text[j]!;
    if (quote) {
      if (ch === "\\") j++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return text.length;
}

/* ----- filter expressions ([?(…)]) ----- */

type FilterOperand =
  | { kind: "path"; tokens: PathToken[] }
  | { kind: "literal"; value: unknown };

type FilterOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

type FilterExpr =
  | { kind: "or" | "and"; left: FilterExpr; right: FilterExpr }
  | { kind: "not"; expr: FilterExpr }
  | { kind: "exists"; operand: FilterOperand }
  | {
      kind: "compare";
      op: FilterOp;
      left: FilterOperand;
      right: FilterOperand;
    };

/** A filter that does not parse: the whole path is reported. */
export class PathSyntaxError extends Error {
  constructor(path: string, detail: string) {
    super(`invalid path ${JSON.stringify(path)}: ${detail}`);
    this.name = "PathSyntaxError";
  }
}

/**
 * Parse a JSONPath-style filter body (after `?`): `(@.title == "x")`,
 * `@.done != true && @.count >= 2`, `!(@.archived)`, `@.owner` (present).
 * Operands are `@` paths (`@.a.b`, `@.items[0]`, `@['key']`, `@` itself)
 * or literals (quoted strings, numbers, true, false, null). Comparisons are
 * strict (no type coercion); `<` / `>` compare numbers or strings.
 */
function parseFilter(source: string, path: string): FilterExpr {
  let i = 0;
  const fail = (detail: string): never => {
    throw new PathSyntaxError(path, detail);
  };
  const skip = (): void => {
    while (i < source.length && /\s/.test(source[i]!)) i++;
  };
  const peek = (text: string): boolean => {
    skip();
    return source.startsWith(text, i);
  };
  const operand = (): FilterOperand => {
    skip();
    const ch = source[i];
    if (ch === "@") {
      i++;
      let end = i;
      let depth = 0;
      let quote: string | undefined;
      while (end < source.length) {
        const c = source[end]!;
        if (quote) {
          if (c === "\\") end++;
          else if (c === quote) quote = undefined;
        } else if (c === "'" || c === '"') quote = c;
        else if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (depth === 0 && /[\s=!<>&|)]/.test(c)) break;
        end++;
      }
      const rest = source.slice(i, end);
      i = end;
      return { kind: "path", tokens: parsePath(`$${rest}`) };
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\" && j + 1 < source.length) j++;
        text += source[j];
        j++;
      }
      if (j >= source.length) fail("unterminated string in filter");
      i = j + 1;
      return { kind: "literal", value: text };
    }
    const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      source.slice(i),
    );
    if (!word)
      fail(`unexpected ${JSON.stringify(source.slice(i, i + 12))} in filter`);
    i += word![0].length;
    const raw = word![0];
    const value =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : raw === "null"
            ? null
            : Number(raw);
    return { kind: "literal", value };
  };
  const primary = (): FilterExpr => {
    if (peek("!") && !peek("!=")) {
      i++;
      return { kind: "not", expr: primary() };
    }
    if (peek("(")) {
      i++;
      const inner = or();
      if (!peek(")")) fail("missing ) in filter");
      i++;
      return inner;
    }
    const left = operand();
    skip();
    const op = (["==", "!=", "<=", ">=", "<", ">"] as const).find((candidate) =>
      source.startsWith(candidate, i),
    );
    if (!op) {
      if (left.kind !== "path") fail("a filter literal needs a comparison");
      return { kind: "exists", operand: left };
    }
    i += op.length;
    return { kind: "compare", op, left, right: operand() };
  };
  const and = (): FilterExpr => {
    let left = primary();
    while (peek("&&")) {
      i += 2;
      left = { kind: "and", left, right: primary() };
    }
    return left;
  };
  const or = (): FilterExpr => {
    let left = and();
    while (peek("||")) {
      i += 2;
      left = { kind: "or", left, right: and() };
    }
    return left;
  };
  if (source.trim() === "") fail("empty filter");
  const expr = or();
  skip();
  if (i < source.length)
    fail(`unexpected ${JSON.stringify(source.slice(i, i + 12))} in filter`);
  return expr;
}

function filterOperandValue(
  operand: FilterOperand,
  item: unknown,
): { exists: boolean; value: unknown } {
  return operand.kind === "literal"
    ? { exists: true, value: operand.value }
    : walk(item, operand.tokens);
}

function filterHolds(expr: FilterExpr, item: unknown): boolean {
  switch (expr.kind) {
    case "or":
      return filterHolds(expr.left, item) || filterHolds(expr.right, item);
    case "and":
      return filterHolds(expr.left, item) && filterHolds(expr.right, item);
    case "not":
      return !filterHolds(expr.expr, item);
    case "exists":
      return filterOperandValue(expr.operand, item).exists;
    case "compare": {
      const left = filterOperandValue(expr.left, item);
      const right = filterOperandValue(expr.right, item);
      if (!left.exists || !right.exists) return expr.op === "!=";
      const a = left.value;
      const b = right.value;
      if (expr.op === "==") return deepEqual(a, b);
      if (expr.op === "!=") return !deepEqual(a, b);
      const comparable =
        (typeof a === "number" && typeof b === "number") ||
        (typeof a === "string" && typeof b === "string");
      if (!comparable) return false;
      const x = a as number | string;
      const y = b as number | string;
      if (expr.op === "<") return x < y;
      if (expr.op === "<=") return x <= y;
      if (expr.op === ">") return x > y;
      return x >= y;
    }
  }
}

/** True when `path` can select several values (a wildcard or a filter). */
export function isMultiValuePath(path: string): boolean {
  return parsePath(path).some(
    (token) => "wildcard" in token || "filter" in token,
  );
}

/**
 * Read `path` from `root`. A numeric key also indexes arrays (`items.0`);
 * `length` of an array is its size. A wildcard maps over array elements (or
 * object values) and yields an array of whatever the rest of the path finds.
 */
export function readPath(
  root: unknown,
  path: string,
): { exists: boolean; value: unknown } {
  return walk(root, parsePath(path));
}

function walk(
  value: unknown,
  tokens: PathToken[],
): { exists: boolean; value: unknown } {
  if (tokens.length === 0) return { exists: value !== undefined, value };
  const [head, ...tail] = tokens as [PathToken, ...PathToken[]];
  if ("filter" in head) {
    // Like a wildcard over the items the filter keeps — but a filter that
    // keeps nothing (or whose tail finds nothing) selects nothing at all,
    // so `exists: true` on it means "some item matched".
    const items = Array.isArray(value)
      ? value
      : value !== null && typeof value === "object"
        ? Object.values(value)
        : undefined;
    if (items === undefined) return { exists: false, value: undefined };
    const found: unknown[] = [];
    for (const item of items) {
      if (!filterHolds(head.filter, item)) continue;
      const next = walk(item, tail);
      if (next.exists) found.push(next.value);
    }
    return found.length > 0
      ? { exists: true, value: found }
      : { exists: false, value: undefined };
  }
  if ("wildcard" in head) {
    const items = Array.isArray(value)
      ? value
      : value !== null && typeof value === "object"
        ? Object.values(value)
        : undefined;
    if (items === undefined) return { exists: false, value: undefined };
    const found: unknown[] = [];
    for (const item of items) {
      const next = walk(item, tail);
      if (next.exists) found.push(next.value);
    }
    return { exists: true, value: found };
  }
  if ("index" in head) {
    if (!Array.isArray(value)) return { exists: false, value: undefined };
    const index = head.index < 0 ? value.length + head.index : head.index;
    if (index < 0 || index >= value.length) {
      return { exists: false, value: undefined };
    }
    return walk(value[index], tail);
  }
  if (Array.isArray(value)) {
    if (head.key === "length") return walk(value.length, tail);
    if (/^\d+$/.test(head.key)) {
      return walk(value, [{ index: Number(head.key) }, ...tail]);
    }
    return { exists: false, value: undefined };
  }
  if (value !== null && typeof value === "object") {
    if (!Object.hasOwn(value, head.key)) {
      return { exists: false, value: undefined };
    }
    return walk((value as Record<string, unknown>)[head.key], tail);
  }
  return { exists: false, value: undefined };
}

/* ----- comparison helpers ----- */

/** Structural equality; object key order ignored, array order significant. */
export function deepEqual(a: unknown, b: unknown, ignoreCase = false): boolean {
  if (ignoreCase && typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index], ignoreCase));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (key) =>
        Object.hasOwn(b, key) &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          ignoreCase,
        ),
    );
  }
  return false;
}

/**
 * `expected` is contained in `actual`: every key of an expected object is
 * present and subset-matches; arrays match element-wise with equal length;
 * scalars are equal.
 */
export function subsetMatch(
  actual: unknown,
  expected: unknown,
  ignoreCase = false,
): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) =>
        subsetMatch(actual[index], item, ignoreCase),
      )
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual)
    ) {
      return false;
    }
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(actual, key) &&
        subsetMatch(
          (actual as Record<string, unknown>)[key],
          value,
          ignoreCase,
        ),
    );
  }
  return deepEqual(actual, expected, ignoreCase);
}

/** Numbers and numeric strings only — never `Number([])` / `Number(null)`. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** Compact one-line rendering for expected/actual strings. */
export function show(value: unknown, max = 200): string {
  if (value === undefined) return "missing";
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toMatcherObject(matcher: ValueMatcher): ValueMatcherObject {
  if (matcher === null || typeof matcher !== "object") {
    return { equals: matcher };
  }
  return matcher;
}

export function describeMatcher(matcher: ValueMatcher): string {
  const m = toMatcherObject(matcher);
  const parts: string[] = [];
  if (Object.hasOwn(m, "equals")) parts.push(`equals ${show(m.equals)}`);
  if (Object.hasOwn(m, "contains")) parts.push(`contains ${show(m.contains)}`);
  if (m.matches !== undefined) parts.push(`matches /${m.matches}/`);
  if (m.oneOf !== undefined) parts.push(`one of ${show(m.oneOf)}`);
  if (m.atLeast !== undefined) parts.push(`>= ${m.atLeast}`);
  if (m.atMost !== undefined) parts.push(`<= ${m.atMost}`);
  if (m.exists !== undefined) parts.push(m.exists ? "exists" : "is missing");
  if (m.empty !== undefined) parts.push(m.empty ? "is empty" : "is not empty");
  const each = m.all ?? m.each;
  if (each !== undefined) parts.push(`every item ${describeMatcher(each)}`);
  const text = parts.join(" and ");
  return m.ignoreCase ? `${text} (ignoring case)` : text;
}

/**
 * Apply one matcher to a value read from a path. `exists` is whether the path
 * was present at all (a missing path fails everything except
 * `exists: false` and `empty: true`).
 */
export function matchValue(
  value: unknown,
  exists: boolean,
  matcher: ValueMatcher,
  label: string,
): MatchOutcome {
  const m = toMatcherObject(matcher);
  const expected = `${label} ${describeMatcher(matcher)}`;
  const actual = exists ? show(value) : "missing";
  const ignoreCase = m.ignoreCase === true;
  const fail = (detail?: string): MatchOutcome => ({
    passed: false,
    expected,
    actual: detail ? `${actual} (${detail})` : actual,
  });

  if (m.exists !== undefined && exists !== m.exists) return fail();
  if (m.empty !== undefined) {
    const empty = !exists || isEmptyValue(value);
    if (empty !== m.empty) return fail();
  }
  const valueChecks =
    Object.hasOwn(m, "equals") ||
    Object.hasOwn(m, "contains") ||
    m.matches !== undefined ||
    m.oneOf !== undefined ||
    m.atLeast !== undefined ||
    m.atMost !== undefined ||
    m.all !== undefined ||
    m.each !== undefined;
  if (!valueChecks) return { passed: true, expected, actual };
  if (!exists) return fail();

  if (Object.hasOwn(m, "equals") && !deepEqual(value, m.equals, ignoreCase)) {
    return fail();
  }
  if (
    Object.hasOwn(m, "contains") &&
    !containsValue(value, m.contains, ignoreCase)
  ) {
    return fail();
  }
  if (m.matches !== undefined) {
    const subject =
      typeof value === "string"
        ? value
        : value === null
          ? "null"
          : show(value, 10_000);
    if (!new RegExp(m.matches, ignoreCase ? "i" : "").test(subject))
      return fail();
  }
  if (
    m.oneOf !== undefined &&
    !m.oneOf.some((candidate) => deepEqual(value, candidate, ignoreCase))
  ) {
    return fail();
  }
  if (m.atLeast !== undefined || m.atMost !== undefined) {
    const n = asNumber(value);
    if (n === undefined) return fail("not a number");
    if (m.atLeast !== undefined && n < m.atLeast) return fail();
    if (m.atMost !== undefined && n > m.atMost) return fail();
  }
  const each = m.all ?? m.each;
  if (each !== undefined) {
    if (!Array.isArray(value)) return fail("not an array");
    for (let index = 0; index < value.length; index++) {
      const item = matchValue(value[index], true, each, `${label}[${index}]`);
      if (!item.passed) return fail(`item ${index}: ${item.actual}`);
    }
  }
  return { passed: true, expected, actual };
}

function containsValue(
  value: unknown,
  needle: unknown,
  ignoreCase: boolean,
): boolean {
  if (typeof value === "string") {
    const hay = ignoreCase ? value.toLowerCase() : value;
    const n = String(needle);
    return hay.includes(ignoreCase ? n.toLowerCase() : n);
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      needle !== null && typeof needle === "object"
        ? subsetMatch(item, needle, ignoreCase)
        : deepEqual(item, needle, ignoreCase),
    );
  }
  if (value !== null && typeof value === "object") {
    return subsetMatch(value, needle, ignoreCase);
  }
  return false;
}

export interface PathMatchReport {
  passed: boolean;
  results: Array<MatchOutcome & { path: string }>;
}

/** Evaluate every `path → matcher` entry against one root value. */
export function matchPaths(
  root: unknown,
  matchers: PathMatchers,
  labelPrefix = "",
): PathMatchReport {
  const results = Object.entries(matchers).map(([path, matcher]) => {
    const read = readPath(root, path);
    const label = `${labelPrefix}${path === "" ? "$" : path}`;
    return { path, ...matchValue(read.value, read.exists, matcher, label) };
  });
  return { passed: results.every((r) => r.passed), results };
}

/** `a; b; c` for the failing (or, when all pass, every) result. */
export function summarizeReport(report: PathMatchReport): {
  expected: string;
  actual: string;
} {
  const shown = report.passed
    ? report.results
    : report.results.filter((r) => !r.passed);
  return {
    expected: report.results.map((r) => r.expected).join("; "),
    actual: shown.map((r) => `${r.path || "$"}=${r.actual}`).join("; "),
  };
}
