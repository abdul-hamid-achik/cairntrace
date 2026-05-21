import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../../adapters/mock/MockBrowserBackend";
import { evaluateConsole } from "./console";
import { evaluateCount } from "./count";
import { evaluateNetwork } from "./network";
import { evaluateNoFailedRequests } from "./noFailedRequests";
import { evaluateNotText } from "./notText";
import { evaluateScript } from "./script";
import { evaluateText } from "./text";
import { evaluateUrl } from "./url";

describe("text", () => {
  it("passes when contains matches", async () => {
    const b = new MockBrowserBackend();
    b.setPageText("Coupon applied successfully");
    const r = await evaluateText(
      { text: { contains: "Coupon applied" }, region: "page" },
      b,
    );
    expect(r.passed).toBe(true);
  });

  it("fails when the text is absent", async () => {
    const b = new MockBrowserBackend();
    b.setPageText("Invalid campaign");
    const r = await evaluateText(
      { text: { contains: "Coupon applied" }, region: "page" },
      b,
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain("not found");
  });
});

describe("notText", () => {
  it("passes when the disallowed text is absent", async () => {
    const b = new MockBrowserBackend();
    b.setPageText("All good");
    const r = await evaluateNotText(
      { notText: { contains: "Something went wrong" }, region: "page" },
      b,
    );
    expect(r.passed).toBe(true);
  });

  it("fails when the disallowed text appears", async () => {
    const b = new MockBrowserBackend();
    b.setPageText("Something went wrong");
    const r = await evaluateNotText(
      { notText: { contains: "Something went wrong" }, region: "page" },
      b,
    );
    expect(r.passed).toBe(false);
  });
});

describe("url", () => {
  it("passes when endsWith matches", async () => {
    const b = new MockBrowserBackend();
    b.setUrl("http://localhost/invoices?imported=42");
    const r = await evaluateUrl({ url: { endsWith: "imported=42" } }, b);
    expect(r.passed).toBe(true);
  });

  it("fails when no matcher hits", async () => {
    const b = new MockBrowserBackend();
    b.setUrl("http://localhost/somewhere");
    const r = await evaluateUrl({ url: { endsWith: "imported=42" } }, b);
    expect(r.passed).toBe(false);
  });
});

describe("network", () => {
  it("passes when a matching request hits", async () => {
    const b = new MockBrowserBackend();
    b.pushNetworkEntry({
      url: "/api/invoices/import",
      method: "POST",
      status: 200,
    });
    const r = await evaluateNetwork(
      {
        network: {
          method: "POST",
          urlContains: "/api/invoices/import",
          status: { in: [200, 201] },
        },
      },
      b,
    );
    expect(r.passed).toBe(true);
  });

  it("fails when no request matches", async () => {
    const b = new MockBrowserBackend();
    const r = await evaluateNetwork(
      {
        network: {
          method: "POST",
          urlContains: "/api/invoices/import",
          status: { in: [200, 201] },
        },
      },
      b,
    );
    expect(r.passed).toBe(false);
  });
});

describe("noFailedRequests", () => {
  it("passes when no matching request failed", async () => {
    const b = new MockBrowserBackend();
    b.pushNetworkEntry({ url: "/api/x", method: "GET", status: 200 });
    const r = await evaluateNoFailedRequests(
      { noFailedRequests: { urlContains: "/api/" } },
      b,
    );
    expect(r.passed).toBe(true);
  });

  it("fails when at least one matching request returned 5xx", async () => {
    const b = new MockBrowserBackend();
    b.pushNetworkEntry({ url: "/api/x", method: "GET", status: 200 });
    b.pushNetworkEntry({ url: "/api/y", method: "POST", status: 500 });
    const r = await evaluateNoFailedRequests(
      { noFailedRequests: { urlContains: "/api/" } },
      b,
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain("/api/y");
  });
});

describe("console", () => {
  it("passes when error count ≤ max", async () => {
    const b = new MockBrowserBackend();
    const r = await evaluateConsole({ console: { errorsMax: 0 } }, b);
    expect(r.passed).toBe(true);
  });

  it("fails when error count > max", async () => {
    const b = new MockBrowserBackend();
    b.pushConsoleEntry({ type: "error", text: "boom" });
    const r = await evaluateConsole({ console: { errorsMax: 0 } }, b);
    expect(r.passed).toBe(false);
  });
});

describe("count", () => {
  it("passes when equals matches", async () => {
    const b = new MockBrowserBackend();
    b.setCount("[role=row]", 42);
    const r = await evaluateCount({ count: { role: "row", equals: 42 } }, b);
    expect(r.passed).toBe(true);
  });

  it("fails when count is off", async () => {
    const b = new MockBrowserBackend();
    b.setCount("[role=row]", 41);
    const r = await evaluateCount({ count: { role: "row", equals: 42 } }, b);
    expect(r.passed).toBe(false);
  });

  it("supports atLeast / atMost / between", async () => {
    const b = new MockBrowserBackend();
    b.setCount("#x", 5);
    expect(
      (await evaluateCount({ count: { selector: "#x", atLeast: 3 } }, b))
        .passed,
    ).toBe(true);
    expect(
      (await evaluateCount({ count: { selector: "#x", atMost: 4 } }, b)).passed,
    ).toBe(false);
    expect(
      (await evaluateCount({ count: { selector: "#x", between: [4, 6] } }, b))
        .passed,
    ).toBe(true);
  });
});

describe("script", () => {
  it("passes when the queued evaluation returns ok", async () => {
    const b = new MockBrowserBackend();
    b.enqueueScriptResult({ ok: true, evidence: { rows: 0 } });
    const r = await evaluateScript(
      {
        script: {
          run: "return { ok: true, evidence: { rows: 0 } };",
        },
      },
      b,
    );
    expect(r.passed).toBe(true);
    expect(r.raw).toEqual({ rows: 0 });
  });

  it("fails and preserves evidence when ok is false", async () => {
    const b = new MockBrowserBackend();
    b.enqueueScriptResult({
      ok: false,
      evidence: { mismatches: [{ row: 3, expected: 10, actual: 9 }] },
    });
    const r = await evaluateScript(
      { script: { run: "return { ok: false, evidence: {} };" } },
      b,
    );
    expect(r.passed).toBe(false);
    expect(r.raw).toMatchObject({ mismatches: [{ row: 3 }] });
  });
});
