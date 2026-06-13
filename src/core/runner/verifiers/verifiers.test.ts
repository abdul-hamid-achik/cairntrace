import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../../adapters/mock/MockBrowserBackend";
import { evaluateConsole } from "./console";
import { evaluateCount } from "./count";
import { evaluateHttpJson } from "./httpJson";
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

describe("httpJson", () => {
  it("fetches JSON with baseUrl and matches a JSON path", async () => {
    const b = new MockBrowserBackend();
    b.enqueueEvalResult({
      status: 200,
      ok: true,
      body: { roshan: { alive: false } },
    });

    const r = await evaluateHttpJson(
      {
        httpJson: {
          url: "/api/test/state",
          jsonPath: "$.roshan.alive",
          equals: false,
        },
      },
      b,
      { baseUrl: "http://host" },
    );

    expect(r.passed).toBe(true);
    expect(b.lastEvaluatedScript).toContain(
      'fetch("http://host/api/test/state"',
    );
    expect(r.raw).toMatchObject({
      url: "http://host/api/test/state",
      actual: false,
    });
  });

  it("resolves relative URLs against the current page when baseUrl is absent", async () => {
    const b = new MockBrowserBackend();
    b.setUrl("http://host/admin/page");
    b.enqueueEvalResult({
      status: 200,
      ok: true,
      body: { count: 4 },
    });

    const r = await evaluateHttpJson(
      {
        httpJson: {
          url: "api/state",
          jsonPath: "$.count",
          atLeast: 3,
        },
      },
      b,
    );

    expect(r.passed).toBe(true);
    expect(b.lastEvaluatedScript).toContain(
      'fetch("http://host/admin/api/state"',
    );
  });

  it("supports contains, matches, atMost, and exists matchers", async () => {
    const cases = [
      {
        verifier: {
          httpJson: {
            url: "https://host/state",
            jsonPath: "$.tags",
            contains: "ready",
          },
        },
        body: { tags: ["ready", "live"] },
      },
      {
        verifier: {
          httpJson: {
            url: "https://host/state",
            jsonPath: "$.name",
            matches: "^game-",
          },
        },
        body: { name: "game-123" },
      },
      {
        verifier: {
          httpJson: {
            url: "https://host/state",
            jsonPath: "$.score",
            atMost: 10,
          },
        },
        body: { score: 10 },
      },
      {
        verifier: {
          httpJson: {
            url: "https://host/state",
            jsonPath: "$.missing",
            exists: false,
          },
        },
        body: { score: 10 },
      },
    ] as const;

    for (const c of cases) {
      const b = new MockBrowserBackend();
      b.enqueueEvalResult({ status: 200, ok: true, body: c.body });
      const r = await evaluateHttpJson(c.verifier, b);
      expect(r.passed).toBe(true);
    }
  });

  it("fails clearly when a relative URL has no origin", async () => {
    const b = new MockBrowserBackend();
    const r = await evaluateHttpJson(
      {
        httpJson: {
          url: "/api/state",
          jsonPath: "$.ok",
          equals: true,
        },
      },
      b,
    );

    expect(r.passed).toBe(false);
    expect(r.actual).toContain("needs a baseUrl");
    expect(b.lastEvaluatedScript).toBe("");
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

  it("runs runtime: node scripts outside the browser with filesystem access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-node-verifier-"));
    const artifactPath = join(dir, "template.txt");
    const verifierPath = join(dir, "check-template.ts");
    await writeFile(artifactPath, "template body");
    await writeFile(
      verifierPath,
      `import { readFile } from "node:fs/promises";

export default async function verify(ctx) {
  const text = await readFile(ctx.fixtures.templatePath, "utf8");
  return {
    ok: text === "template body" && ctx.artifacts.template.relativePath === "downloads/template.txt",
    evidence: { text, templatePath: ctx.fixtures.templatePath }
  };
}
`,
    );

    const b = new MockBrowserBackend();
    const r = await evaluateScript(
      {
        script: {
          runtime: "node",
          file: "./check-template.ts",
          fixtures: {
            templatePath: "${artifacts.template.path}",
          },
        },
      },
      b,
      {
        specDir: dir,
        runDir: dir,
        artifacts: {
          template: {
            kind: "download",
            path: artifactPath,
            relativePath: "downloads/template.txt",
          },
        },
      },
    );

    expect(r.passed).toBe(true);
    expect(r.raw).toMatchObject({ text: "template body" });
    expect(b.lastEvaluatedScript).toBe("");
  });

  it("keeps node verifier stack traces in raw evidence on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-node-fail-"));
    await writeFile(
      join(dir, "fail.ts"),
      `export default async function verify() {
  throw new Error("workbook parse failed");
}
`,
    );
    const r = await evaluateScript(
      { script: { runtime: "node", file: "./fail.ts" } },
      new MockBrowserBackend(),
      { specDir: dir, runDir: dir },
    );
    expect(r.passed).toBe(false);
    expect(r.raw).toMatchObject({
      error: { message: "workbook parse failed" },
    });
    expect(JSON.stringify(r.raw)).toContain("workbook parse failed");
  });
});

describe("file", () => {
  it("passes when a file matching the glob exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-file-verifier-"));
    await writeFile(join(dir, "1717000-welcome-user@example.com.json"), "{}");
    const { evaluateFile } = await import("./file");

    const r = await evaluateFile(
      { file: { glob: "./*-welcome-*.json", timeoutMs: 500 } },
      { specDir: dir },
    );
    expect(r.passed).toBe(true);
    expect(r.actual).toContain("welcome");
  });

  it("matches on contained text and reports near-misses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-file-contains-"));
    await writeFile(
      join(dir, "mail-1.json"),
      JSON.stringify({ subject: "Your QR code", to: "a@b.co" }),
    );
    const { evaluateFile } = await import("./file");

    const hit = await evaluateFile(
      { file: { glob: "mail-*.json", contains: "QR code", timeoutMs: 500 } },
      { specDir: dir },
    );
    expect(hit.passed).toBe(true);

    const miss = await evaluateFile(
      {
        file: {
          glob: "mail-*.json",
          contains: "password reset",
          timeoutMs: 250,
        },
      },
      { specDir: dir },
    );
    expect(miss.passed).toBe(false);
    expect(miss.actual).toContain("none contained");
    expect(miss.actual).toContain("mail-1.json");
  });

  it("polls until the file appears", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-file-poll-"));
    const { evaluateFile } = await import("./file");

    setTimeout(() => {
      void writeFile(join(dir, "late.txt"), "arrived");
    }, 150);
    const r = await evaluateFile(
      { file: { glob: "late.txt", contains: "arrived", timeoutMs: 3000 } },
      { specDir: dir },
    );
    expect(r.passed).toBe(true);
  });

  it("times out with a clear directory diagnosis", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-file-timeout-"));
    const { evaluateFile } = await import("./file");

    const r = await evaluateFile(
      { file: { glob: "never-*.json", timeoutMs: 200 } },
      { specDir: dir },
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain("timed out");
    expect(r.actual).toContain("no files matching");
  });
});
