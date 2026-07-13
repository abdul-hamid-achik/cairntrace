import { describe, expect, it } from "vitest";
import {
  bodyTextContainsExpression,
  normalizeTextForMatching,
  textContains,
  textEquals,
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

  it("builds the same normalized browser expression used by both backends", () => {
    expect(bodyTextContainsExpression(" Disponible\n ahora ")).toBe(
      'String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().toLowerCase().includes("disponible ahora")',
    );
    expect(bodyTextContainsExpression("Disponible", true)).not.toContain(
      "toLowerCase",
    );
  });
});
