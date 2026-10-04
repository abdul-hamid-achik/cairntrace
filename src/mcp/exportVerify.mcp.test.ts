import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeProjectExport } from "../cli/commands/export";
import { ExportVerifyReportSchema } from "../core/schema/exportVerify.v1";
import { buildMcpServer } from "./server";

/**
 * `cairn_export_verify` is `cairn export playwright --verify` over MCP: the
 * same report, `isError` when it is not a pass. Static gates only here (the
 * browser-backed differential / mutation are covered next to the CLI code).
 */

let root: string;
let exportDir: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cairn-mcp-verify-")));
  await mkdir(join(root, "specs"));
  const spec = join(root, "specs", "tiny.yml");
  await writeFile(
    spec,
    `version: 1
name: tiny
intent: tiny
outcomes:
  - id: greeted
    description: the page greets
    verify: { text: { contains: Hello } }
steps:
  - id: open_page
    open: http://127.0.0.1:9/
`,
  );
  exportDir = join(root, "export");
  await writeProjectExport(
    [spec],
    "ts",
    { project: true, outDir: exportDir },
    spec,
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>) {
  const server = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "verify-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return await client.callTool({
      name: "cairn_export_verify",
      arguments: args,
    });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("cairn_export_verify", () => {
  it("returns the verify report for an export (passed gates, skipped ones named; inconclusive when no toolchain gate ran)", async () => {
    const result = await call({ exportDir });
    expect(result.isError).toBe(true);
    const report = ExportVerifyReportSchema.parse(result.structuredContent);
    expect(report).toMatchObject({ status: "inconclusive", exitCode: 3 });
    // no node_modules next to the export: typecheck and list cannot run
    expect(
      Object.fromEntries(report.gates.map((g) => [g.id, g.status])),
    ).toMatchObject({
      sentinels: "passed",
      freshness: "passed",
      typecheck: "skipped",
      list: "skipped",
    });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("# Export verify: inconclusive");
  });

  it("is isError with exit 1 when strict turns a skipped gate into a failure", async () => {
    const result = await call({ exportDir, strict: true });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "failed",
      exitCode: 1,
    });
  });

  it("passes verifyProject through (the multi-project host's project, named in the report)", async () => {
    const result = await call({ exportDir, verifyProject: "chromium" });
    const report = ExportVerifyReportSchema.parse(result.structuredContent);
    // no local Playwright here: the request is recorded, not checked
    expect(report.playwrightProject).toMatchObject({
      name: "chromium",
      source: "flag",
      reason: expect.stringContaining("not checked"),
    });
  });

  it("is isError with exit 2 and the cause when there is no manifest", async () => {
    const result = await call({ exportDir: root });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "error",
      exitCode: 2,
    });
    expect((result.structuredContent as { error: string }).error).toContain(
      ".cairn-export.json",
    );
  });
});
