import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { evaluateWhen, parseWhen } from "./conditions";

describe("parseWhen", () => {
  it("parses each supported kind", () => {
    expect(parseWhen("urlContains:/login")).toEqual({
      kind: "urlContains",
      arg: "/login",
    });
    expect(parseWhen("urlNotContains:/login")).toEqual({
      kind: "urlNotContains",
      arg: "/login",
    });
    expect(parseWhen("urlMatches:^/dashboard")).toEqual({
      kind: "urlMatches",
      arg: "^/dashboard",
    });
    expect(parseWhen("text:Welcome")).toEqual({ kind: "text", arg: "Welcome" });
    expect(parseWhen("notText:Loading")).toEqual({
      kind: "notText",
      arg: "Loading",
    });
  });

  it("rejects unknown kinds", () => {
    expect(() => parseWhen("nope:x")).toThrow();
    expect(() => parseWhen("urlContains")).toThrow();
    expect(() => parseWhen("urlContains:")).toThrow();
  });

  it("argument can contain colons (only the first one delimits)", () => {
    expect(parseWhen("urlContains:http://localhost:8787/x")).toEqual({
      kind: "urlContains",
      arg: "http://localhost:8787/x",
    });
  });
});

describe("evaluateWhen", () => {
  it("urlContains true / false", async () => {
    const b = new MockBrowserBackend();
    b.setUrl("http://localhost/login");
    expect(await evaluateWhen("urlContains:/login", b)).toBe(true);
    expect(await evaluateWhen("urlContains:/dashboard", b)).toBe(false);
  });

  it("urlNotContains is the negation", async () => {
    const b = new MockBrowserBackend();
    b.setUrl("http://localhost/login");
    expect(await evaluateWhen("urlNotContains:/login", b)).toBe(false);
    expect(await evaluateWhen("urlNotContains:/dashboard", b)).toBe(true);
  });

  it("urlMatches uses regex", async () => {
    const b = new MockBrowserBackend();
    b.setUrl("http://localhost:9999/checkout/cart?id=42");
    expect(await evaluateWhen("urlMatches:/checkout/cart\\?id=\\d+", b)).toBe(
      true,
    );
    expect(await evaluateWhen("urlMatches:^http://other", b)).toBe(false);
  });

  it("text / notText use page body", async () => {
    const b = new MockBrowserBackend();
    b.setPageText("Welcome back");
    expect(await evaluateWhen("text:Welcome", b)).toBe(true);
    expect(await evaluateWhen("notText:Loading", b)).toBe(true);
    expect(await evaluateWhen("notText:Welcome", b)).toBe(false);
  });
});
