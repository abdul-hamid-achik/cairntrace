import { describe, expect, it } from "vitest";
import { isRelativeUrl, joinUrl, normalizeUrl, resolveUrl } from "./url";

describe("URL helpers", () => {
  it("detects path-like URLs", () => {
    expect(isRelativeUrl("/play?id=1")).toBe(true);
    expect(isRelativeUrl("play?id=1")).toBe(true);
    expect(isRelativeUrl("https://example.com/play")).toBe(false);
    expect(isRelativeUrl("about:blank")).toBe(false);
    expect(isRelativeUrl("//cdn.example.com/app.js")).toBe(false);
  });

  it("joins base URLs without duplicate path slashes", () => {
    expect(joinUrl("http://host/", "/play?id=1")).toBe("http://host/play?id=1");
    expect(joinUrl("http://host/app", "play?id=1")).toBe(
      "http://host/app/play?id=1",
    );
  });

  it("normalizes duplicate path slashes without touching the scheme", () => {
    expect(normalizeUrl("http://host//play///x")).toBe("http://host/play/x");
    expect(normalizeUrl("https://host/a//b")).toBe("https://host/a/b");
  });

  it("resolves paths against a current page URL", () => {
    expect(resolveUrl("http://host/admin/page", "/api/x")).toBe(
      "http://host/api/x",
    );
    expect(resolveUrl("http://host/admin/page", "api/x")).toBe(
      "http://host/admin/api/x",
    );
  });
});
