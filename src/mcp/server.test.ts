import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocsResultSchema } from "../core/schema/docs.v1";
import { ExplainResultSchema } from "../core/schema/explain.v1";
import { buildMcpServer } from "./server";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-mcp-test-"));
});

afterAll(async () => {
  // best-effort; tmp is fine to leak
});

async function connectInMemory(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

describe("Cairntrace MCP server", () => {
  it("lists the expected tool surface", async () => {
    const c = await connectInMemory();
    const list = await c.listTools();
    const names = list.tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "cairn_checkpoint_delete",
      "cairn_checkpoint_list",
      "cairn_checkpoint_show",
      "cairn_context",
      "cairn_docs",
      "cairn_doctor",
      "cairn_explain",
      "cairn_run",
      "cairn_spec_heal",
      "cairn_spec_scaffold",
      "cairn_spec_verify",
    ]);
    await c.close();
  });

  it("cairn_explain returns the v1 ExplainResult shape (parity with `cairn explain --json`)", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_explain", arguments: {} });
    const structured = ExplainResultSchema.parse(r.structuredContent);
    const verifiers = structured.verifiers;
    const ids = verifiers.map((v) => v.id);
    expect(ids).toContain("text");
    expect(ids).toContain("script");
    await c.close();
  });

  it("cairn_docs returns focused docs for a topic", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "downloads" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("downloads");
    expect(structured.sections.length).toBeGreaterThan(0);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Download Capture"),
    });
    await c.close();
  });

  it("cairn_run with mock=true returns a RunResult", async () => {
    const specPath = join(dir, "demo.yml");
    await writeFile(
      specPath,
      `version: 1
name: mcp_demo
intent: smoke test from MCP
outcomes:
  - id: ok
    description: console clean
    verify:
      console: { errorsMax: 0 }
steps:
  - id: nav
    open: /
`,
    );

    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_run",
      arguments: {
        path: specPath,
        mock: true,
        artifactRoot: join(dir, "runs"),
      },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      $schema: "urn:cairntrace.dev:run:v1",
      status: "passed",
      backend: "mock",
    });
    await c.close();
  });

  it("cairn_spec_scaffold writes a starter file", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_spec_scaffold",
      arguments: {
        name: "mcp_scaffold_test",
        intent: "smoke test scaffold via MCP",
        out: dir,
      },
    });
    expect(r.isError).toBeFalsy();
    const path = (r.structuredContent as { path: string }).path;
    expect(path).toMatch(/mcp_scaffold_test\.yml$/);
    await c.close();
  });
});
