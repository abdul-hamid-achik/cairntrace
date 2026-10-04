/**
 * The pure half of the `httpJson` verifier: walk a dotted `jsonPath` and judge
 * the value against one matcher. No imports on purpose: the Playwright export
 * embeds this file's source (src/core/exporters/runtimeSources.ts), so the
 * exported test judges a response exactly like `cairn run` does.
 */

/** The matcher fields of `verify: { httpJson: … }` (see HttpJsonVerifier). */
export interface HttpJsonMatcher {
  jsonPath: string;
  equals?: unknown;
  contains?: unknown;
  matches?: string;
  atLeast?: number;
  atMost?: number;
  exists?: boolean;
}

export function readJsonPath(
  value: unknown,
  jsonPath: string,
): { exists: boolean; value: unknown } {
  if (jsonPath === "$") return { exists: true, value };
  const parts = jsonPath.startsWith("$.")
    ? jsonPath.slice(2).split(".")
    : jsonPath.split(".");
  let current = value;
  for (const part of parts) {
    if (part.length === 0) return { exists: false, value: undefined };
    if (current !== null && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return { exists: false, value: undefined };
    }
  }
  return { exists: true, value: current };
}

export function matchHttpJson(
  actual: unknown,
  exists: boolean,
  matcher: HttpJsonMatcher,
): { passed: boolean; expected: string; actual: string } {
  const actualText = JSON.stringify(actual);
  if (matcher.exists !== undefined) {
    return {
      passed: exists === matcher.exists,
      expected: `${matcher.jsonPath} exists to be ${matcher.exists}`,
      actual: exists ? `exists: ${actualText}` : "missing",
    };
  }
  if (!exists) {
    return {
      passed: false,
      expected: `${matcher.jsonPath} to match`,
      actual: "missing",
    };
  }
  if (matcher.equals !== undefined) {
    const expected = matcher.equals;
    return {
      passed: jsonDeepEqual(actual, expected),
      expected: `${matcher.jsonPath} equals ${JSON.stringify(expected)}`,
      actual: actualText,
    };
  }
  if (matcher.contains !== undefined) {
    const needle = matcher.contains;
    const passed = Array.isArray(actual)
      ? actual.some((item) => jsonDeepEqual(item, needle))
      : String(actual).includes(String(needle));
    return {
      passed,
      expected: `${matcher.jsonPath} contains ${JSON.stringify(needle)}`,
      actual: actualText,
    };
  }
  if (matcher.matches !== undefined) {
    const re = new RegExp(matcher.matches);
    return {
      passed: re.test(String(actual)),
      expected: `${matcher.jsonPath} matches /${matcher.matches}/`,
      actual: actualText,
    };
  }
  if (matcher.atLeast !== undefined) {
    const n = jsonAsNumber(actual);
    return {
      passed: n !== undefined && n >= matcher.atLeast,
      expected: `${matcher.jsonPath} at least ${matcher.atLeast}`,
      actual: n === undefined ? `${actualText} (not a number)` : actualText,
    };
  }
  const n = jsonAsNumber(actual);
  return {
    passed: n !== undefined && n <= matcher.atMost!,
    expected: `${matcher.jsonPath} at most ${matcher.atMost}`,
    actual: n === undefined ? `${actualText} (not a number)` : actualText,
  };
}

/**
 * Numeric view of a JSON value for atLeast/atMost. Only a real number or a
 * numeric string qualifies — booleans, null, arrays, and objects are NOT
 * coerced (JS `Number([])`=0, `Number([42])`=42, `Number(null)`=0 would make a
 * bound vacuously pass). Returns undefined for anything non-numeric.
 */
function jsonAsNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Structural deep equality — order-insensitive for object keys (so
 * `{a:1,b:2}` equals `{b:2,a:1}`), order-sensitive for arrays. Replaces a
 * `JSON.stringify` compare that failed on differing key order.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        jsonDeepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    );
  }
  return false;
}
