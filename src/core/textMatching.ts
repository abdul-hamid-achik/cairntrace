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
/**
 * Accessible-name matching for semantic locators. Whole-name,
 * whitespace-normalized, case-insensitive unless `exact`. A trailing
 * count badge (`Tasks 11`) matches `Tasks`; `Pay` still does not match
 * `Pay for plan`.
 */
export function accessibleNameMatches(
  elName: string | undefined,
  wanted: string,
  exact?: boolean,
): boolean {
  const a = normalizeTextForMatching(elName ?? "", true);
  const b = normalizeTextForMatching(wanted, true);
  if (exact) return a === b;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (!bl || !al.startsWith(`${bl} `)) return false;
  return /^\d+$/.test(al.slice(bl.length + 1));
}

/** Playwright `name`/`text` regex with the same contract as accessibleNameMatches. */
export function wholeNameRegex(name: string, exact?: boolean): RegExp {
  const body = escapeRegExp(normalizeTextForMatching(name, true));
  if (exact) return new RegExp(`^${body}$`);
  return new RegExp(`^${body}(?: \\d+)?$`, "i");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/**
 * Live DOM predicate: a visible `querySelectorAll(selector)` node contains
 * `hasText` (whitespace-collapsed, case-insensitive). Shared by
 * `wait.selector`+`hasText` and `when: { selector, hasText }`.
 */
export function visibleSelectorHasTextExpression(
  selector: string,
  hasText: string,
): string {
  const sel = JSON.stringify(selector);
  const needle = JSON.stringify(hasText);
  return `[].some.call(document.querySelectorAll(${sel}),function(el){var s=window.getComputedStyle(el);if(s.display==="none"||s.visibility==="hidden")return false;var t=String(el.textContent||"").replace(/\\s+/g," ").trim().toLowerCase();return t.indexOf(String(${needle}).replace(/\\s+/g," ").trim().toLowerCase())!==-1;})`;
}
