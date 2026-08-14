/**
 * Shared locator helpers used by schema consumers, adapters, and inventory.
 * Keep this file free of adapter imports so parse-time code can use it.
 */

export const DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";

const ATTR_NAME_RE = /^[A-Za-z_][\w:-]*$/;

/** Validate a Playwright-style test id attribute name (e.g. data-qa). */
export function isTestIdAttribute(value: string): boolean {
  return ATTR_NAME_RE.test(value);
}

export function resolveTestIdAttribute(configured: string | undefined): string {
  const trimmed = configured?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : DEFAULT_TEST_ID_ATTRIBUTE;
}

/** CSS attribute selector for a test id, with quotes escaped. */
export function testIdSelector(
  testid: string,
  attribute: string = DEFAULT_TEST_ID_ATTRIBUTE,
): string {
  const escaped = testid.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${attribute}="${escaped}"]`;
}

export interface WaitUrlMatcher {
  includes?: string;
  equals?: string;
  pattern?: string;
}

export function matchWaitUrl(url: string, matcher: WaitUrlMatcher): boolean {
  if (matcher.equals !== undefined) return url === matcher.equals;
  if (matcher.includes !== undefined) return url.includes(matcher.includes);
  if (matcher.pattern !== undefined) {
    try {
      return new RegExp(matcher.pattern).test(url);
    } catch {
      return false;
    }
  }
  return false;
}

export function describeWaitUrl(matcher: WaitUrlMatcher): string {
  if (matcher.equals !== undefined) {
    return `equals ${JSON.stringify(matcher.equals)}`;
  }
  if (matcher.includes !== undefined) {
    return `includes ${JSON.stringify(matcher.includes)}`;
  }
  if (matcher.pattern !== undefined) {
    return `pattern /${matcher.pattern}/`;
  }
  return "url";
}
