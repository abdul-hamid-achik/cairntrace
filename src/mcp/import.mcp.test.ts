import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { syntheticTraceEntries, zipOf } from "../testing/traceZip";
import { SpecSchema } from "../core/schema/spec.v1";
import { buildMcpServer } from "./server";

/**
 * `cairn_import_playwright` / `cairn_import_playwright_trace` are the CLI
 * import commands over MCP: the same report (coverage, todos,
 * approximations, remaining lint/verify findings) as structuredContent, the
 * YAML included, `isError` on an unreadable input.
 */

let root: string;
const password = ["pw", process.pid, Date.now()].join("-");
const token = ["tk", process.pid, Date.now()].join("_");

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cairn-mcp-import-")));
  await writeFile(
    join(root, "login.spec.ts"),
    `import { test, expect } from "@playwright/test";
test("member signs in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Password").fill("${password}");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/home$/);
  await page.evaluate(() => 1);
});
`,
  );
  await writeFile(
    join(root, "trace.zip"),
    zipOf(syntheticTraceEntries({ password, token })),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const server = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "import-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("cairn_import_playwright", () => {
  it("writes the draft and returns coverage, TODOs and the findings that remain", async () => {
    const out = join(root, "member_signs_in.yml");
    const result = await call("cairn_import_playwright", {
      path: join(root, "login.spec.ts"),
      out,
    });
    expect(result.isError).toBeFalsy();
    const report = result.structuredContent as {
      status: string;
      path: string;
      coverage: { mapped: number; unmapped: number; total: number };
      todos: string[];
      check: { lint: { errors: number }; verify: { status: string } };
      yaml: string;
    };
    expect(report.status).toBe("written");
    expect(report.path).toBe(out);
    expect(report.coverage).toMatchObject({ unmapped: 1 });
    expect(report.todos[0]).toContain("page.evaluate");
    expect(report.check.verify.status).toBeDefined();
    // the typed password is a placeholder everywhere: file, YAML, report
    const written = await readFile(out, "utf8");
    expect(written).toBe(report.yaml);
    expect(written + JSON.stringify(report)).not.toContain(password);
    expect(SpecSchema.safeParse(parseYaml(written)).success).toBe(true);
  });

  it("returns the YAML without writing when stdout is set, and isError for a missing file", async () => {
    const stdout = await call("cairn_import_playwright", {
      path: join(root, "login.spec.ts"),
      stdout: true,
    });
    expect(stdout.structuredContent).toMatchObject({ status: "printed" });
    expect(
      (stdout.structuredContent as { path?: string }).path,
    ).toBeUndefined();
    const missing = await call("cairn_import_playwright", {
      path: join(root, "nope.spec.ts"),
    });
    expect(missing.isError).toBe(true);
  });
});

describe("cairn_import_playwright_trace", () => {
  it("returns the draft report with the trace summary and secret names, never values", async () => {
    const out = join(root, "draft.yml");
    const result = await call("cairn_import_playwright_trace", {
      path: join(root, "trace.zip"),
      out,
      intent: "A shopper pays with a card",
    });
    expect(result.isError).toBeFalsy();
    const report = result.structuredContent as {
      status: string;
      trace: {
        calls: number;
        secrets: string[];
        network: { candidates: number };
      };
      coverage: { unmapped: number };
      check: { lint: { findings: unknown[] } };
      yaml: string;
    };
    expect(report.status).toBe("written");
    expect(report.trace.secrets).toContain("PASSWORD");
    expect(report.trace.network.candidates).toBe(3);
    expect(report.coverage.unmapped).toBe(2);
    const everything = JSON.stringify(report) + (await readFile(out, "utf8"));
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(token);
    expect(parseYaml(report.yaml)).toMatchObject({
      intent: "A shopper pays with a card",
    });
  });

  it("is isError for something that is not a trace archive", async () => {
    const result = await call("cairn_import_playwright_trace", {
      path: join(root, "login.spec.ts"),
    });
    expect(result.isError).toBe(true);
  });
});
