import type { Locator, Outcome } from "../schema/spec.v1";
import { cssForTestId } from "./playwrightLocators";

/**
 * Locator assertions → outcome verifiers, shared by both importers. A count
 * or text verifier can only name a role or CSS selector, so a role with a
 * name, a label or a test id is approximated; the notes say how.
 */

export interface OutcomeDraft {
  baseId: string;
  description: string;
  verify: Outcome["verify"];
  approx: string[];
}

export type OutcomeResult = OutcomeDraft | { unmapped: string };

export type TextMatcherDraft = {
  equals?: string;
  contains?: string;
  matches?: string;
  caseSensitive?: boolean;
};

/** The CSS for a test id: the project's attribute when known, else the default (noted). */
function testIdCss(
  l: { testid: string },
  attr: string | undefined,
  approx: string[],
): string {
  if (attr === undefined)
    approx.push("test id assumes the default data-testid attribute");
  return cssForTestId(l.testid, attr);
}

export function visibilityOutcome(
  l: Locator,
  visible: boolean,
  baseApprox: readonly string[] = [],
  testIdAttr?: string,
): OutcomeResult {
  const approx = [...baseApprox];
  if ("nth" in l && l.nth !== undefined) {
    approx.push("nth was dropped from the visibility check");
  }
  if (l.by === "selector" || l.by === "testid") {
    const selector =
      l.by === "selector" ? l.selector : testIdCss(l, testIdAttr, approx);
    return visible
      ? {
          baseId: "element_visible",
          description: "expected element is visible",
          verify: { count: { selector, atLeast: 1 } },
          approx,
        }
      : {
          baseId: "element_hidden",
          description: "expected element is absent",
          verify: { count: { selector, equals: 0 } },
          approx,
        };
  }
  if (l.by === "role" && !l.name) {
    return visible
      ? {
          baseId: "role_visible",
          description: "expected role is visible",
          verify: { count: { role: l.role, atLeast: 1 } },
          approx,
        }
      : {
          baseId: "role_hidden",
          description: "expected role is absent",
          verify: { count: { role: l.role, equals: 0 } },
          approx,
        };
  }
  const text =
    l.by === "text"
      ? l.text
      : l.by === "label"
        ? l.name
        : l.by === "role"
          ? l.name
          : undefined;
  if (!text)
    return { unmapped: "visibility of this locator has no mapped outcome" };
  if (l.by !== "text") {
    approx.push(
      `${l.by} ${JSON.stringify(text)} became a page-text check (counts cannot filter by name)`,
    );
  }
  return visible
    ? {
        baseId: "text_visible",
        description: "expected text is visible",
        verify: { text: { contains: text } },
        approx,
      }
    : {
        baseId: "text_hidden",
        description: "expected text is absent",
        verify: { notText: { contains: text } },
        approx,
      };
}

export function countOutcome(
  l: Locator,
  n: number,
  baseApprox: readonly string[] = [],
  testIdAttr?: string,
): OutcomeResult {
  const approx = [...baseApprox];
  if ("nth" in l && l.nth !== undefined)
    approx.push("nth was dropped from the count");
  if (l.by === "selector" || l.by === "testid") {
    const selector =
      l.by === "selector" ? l.selector : testIdCss(l, testIdAttr, approx);
    return {
      baseId: "element_count",
      description: "expected element count",
      verify: { count: { selector, equals: n } },
      approx,
    };
  }
  if (l.by === "role") {
    if (l.name) approx.push("role name was dropped from the count");
    return {
      baseId: "role_count",
      description: "expected role count",
      verify: { count: { role: l.role, equals: n } },
      approx,
    };
  }
  return {
    unmapped: `toHaveCount on a ${l.by} locator has no mapped outcome (count verifiers take a role or selector)`,
  };
}

/** The region a locator can name for a text verifier (CSS only). */
function regionOf(
  l: Locator,
  approx: string[],
  testIdAttr: string | undefined,
): string | undefined {
  if (l.by === "selector") {
    if ("nth" in l && l.nth !== undefined)
      approx.push("nth was dropped from the text region");
    return l.selector === "body" ? undefined : l.selector;
  }
  if (l.by === "testid") return testIdCss(l, testIdAttr, approx);
  approx.push(
    `text region for ${l.by} locators is not expressible; the whole page text is checked`,
  );
  return undefined;
}

export function textOutcome(
  l: Locator,
  matcher: TextMatcherDraft,
  negated: boolean,
  baseApprox: readonly string[] = [],
  testIdAttr?: string,
): OutcomeResult {
  const approx = [...baseApprox];
  const region = regionOf(l, approx, testIdAttr);
  let final = { ...matcher };
  if (final.equals !== undefined && region === undefined) {
    // No region to scope an exact match to: a page-wide equals would never hold.
    final = {
      contains: final.equals,
      ...(final.caseSensitive !== undefined
        ? { caseSensitive: final.caseSensitive }
        : {}),
    };
    approx.push("exact text became contains (no region to scope it to)");
  }
  const withRegion = { ...final, ...(region ? { region } : {}) };
  if (negated) {
    return {
      baseId: "text_absent",
      description: "expected text is absent",
      verify: { notText: withRegion },
      approx,
    };
  }
  const contains = matcher.contains !== undefined && !matcher.equals;
  return {
    baseId: contains ? "text_contains" : "text_matches",
    description: "expected text is present",
    verify: { text: withRegion },
    approx,
  };
}
