import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_ID_ATTRIBUTE,
  describeWaitUrl,
  isTestIdAttribute,
  matchWaitUrl,
  resolveTestIdAttribute,
  testIdSelector,
} from "./locators";

describe("testIdSelector", () => {
  it("quotes the default data-testid attribute", () => {
    expect(testIdSelector("login-btn")).toBe('[data-testid="login-btn"]');
    expect(DEFAULT_TEST_ID_ATTRIBUTE).toBe("data-testid");
  });

  it("honors a configured attribute and escapes quotes", () => {
    expect(testIdSelector("product_name", "data-qa")).toBe(
      '[data-qa="product_name"]',
    );
    expect(testIdSelector('quote"value')).toBe('[data-testid="quote\\"value"]');
  });

  it("validates and defaults the attribute name", () => {
    expect(isTestIdAttribute("data-qa")).toBe(true);
    expect(isTestIdAttribute("data:id")).toBe(true);
    expect(isTestIdAttribute("[onclick]")).toBe(false);
    expect(resolveTestIdAttribute(undefined)).toBe("data-testid");
    expect(resolveTestIdAttribute("  data-qa  ")).toBe("data-qa");
  });
});

describe("matchWaitUrl", () => {
  it("matches equals, includes, and pattern", () => {
    expect(
      matchWaitUrl("http://localhost:8080/dash", {
        equals: "http://localhost:8080/dash",
      }),
    ).toBe(true);
    expect(
      matchWaitUrl("http://localhost:8080/connection/abc", {
        includes: "/connection/",
      }),
    ).toBe(true);
    expect(
      matchWaitUrl("http://localhost:8080/app", { pattern: "/app/?$" }),
    ).toBe(true);
    expect(
      matchWaitUrl("http://localhost:8080/app", { includes: "/admin" }),
    ).toBe(false);
  });

  it("treats a broken pattern as a non-match", () => {
    expect(matchWaitUrl("http://x", { pattern: "(" })).toBe(false);
  });

  it("describes the matcher for diagnostics", () => {
    expect(describeWaitUrl({ includes: "/dash" })).toBe('includes "/dash"');
    expect(describeWaitUrl({ equals: "https://x" })).toBe('equals "https://x"');
    expect(describeWaitUrl({ pattern: "conn" })).toBe("pattern /conn/");
  });
});
