import { describe, expect, it } from "vitest";
import {
  accessibleNameMatches,
  bodyTextContainsExpression,
  normalizeTextForMatching,
  textContains,
  textEquals,
  wholeNameRegex,
} from "./textMatching";

describe("text matching", () => {
  it("normalizes whitespace and case by default", () => {
    expect(normalizeTextForMatching("  DISPONIBLE\n\t ahora  ")).toBe(
      "disponible ahora",
    );
    expect(
      textContains("Estado:  DISPONIBLE\n ahora", "Disponible ahora"),
    ).toBe(true);
    expect(textEquals("  WELCOME\n back ", "welcome back")).toBe(true);
  });

  it("preserves case when requested while still normalizing whitespace", () => {
    expect(textContains("DISPONIBLE ahora", "Disponible ahora", true)).toBe(
      false,
    );
    expect(textEquals("Saved\n now", "Saved now", true)).toBe(true);
  });

  it("matches count-badge accessible names without becoming substring match", () => {
    expect(accessibleNameMatches("Tasks 11", "Tasks")).toBe(true);
    expect(accessibleNameMatches("Tasks 11", "Tasks", true)).toBe(false);
    expect(accessibleNameMatches("Pay for plan", "Pay")).toBe(false);
    expect(accessibleNameMatches("Pay", "Pay")).toBe(true);
    expect(wholeNameRegex("Tasks").test("Tasks 11")).toBe(true);
    expect(wholeNameRegex("Pay").test("Pay for plan")).toBe(false);
  });

  it("builds the same normalized browser expression used by both backends", () => {
    expect(bodyTextContainsExpression(" Disponible\n ahora ")).toBe(
      'String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().toLowerCase().includes("disponible ahora")',
    );
    expect(bodyTextContainsExpression("Disponible", true)).not.toContain(
      "toLowerCase",
    );
  });
});
