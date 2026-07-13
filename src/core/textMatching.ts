/**
 * Normalize rendered text before human-facing equality/containment checks.
 *
 * Browsers expose CSS-transformed text through `innerText`, and layout often
 * turns one logical space into newlines/tabs. Cairntrace therefore collapses
 * whitespace and compares case-insensitively by default. Callers can opt back
 * into case-sensitive matching, while regex matchers deliberately bypass this
 * helper and retain their raw semantics.
 */
export function normalizeTextForMatching(
  value: string,
  caseSensitive = false,
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return caseSensitive ? normalized : normalized.toLowerCase();
}

export function textContains(
  haystack: string,
  needle: string,
  caseSensitive = false,
): boolean {
  return normalizeTextForMatching(haystack, caseSensitive).includes(
    normalizeTextForMatching(needle, caseSensitive),
  );
}

export function textEquals(
  actual: string,
  expected: string,
  caseSensitive = false,
): boolean {
  return (
    normalizeTextForMatching(actual, caseSensitive) ===
    normalizeTextForMatching(expected, caseSensitive)
  );
}

/**
 * JavaScript expression for a browser-side whole-page `contains` check.
 *
 * The returned string is an expression, not a function. Playwright can pass it
 * directly to `waitForFunction`; agent-browser wraps it in `() => ...` for its
 * `wait --fn` command.
 */
export function bodyTextContainsExpression(
  needle: string,
  caseSensitive = false,
): string {
  const normalizedNeedle = normalizeTextForMatching(needle, caseSensitive);
  const normalizedBody =
    `String(document.body?.innerText ?? "")` +
    `.replace(/\\s+/g, " ").trim()` +
    (caseSensitive ? "" : ".toLowerCase()");
  return `${normalizedBody}.includes(${JSON.stringify(normalizedNeedle)})`;
}
