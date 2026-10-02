import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpServer } from "./server";

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client(
    { name: "authoring-tools-test", version: "1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = await c.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    sc: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: (result.content as Array<{ text: string }>)[0]?.text ?? "",
  };
}

describe("MCP authoring tools", () => {
  it("cairn_spec_lint reports, fixes and sets exitCode; cairn_spec_promote refuses without a green finish", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-mcp-authoring-"));
    await mkdir(join(dir, "flows", "_drafts"), { recursive: true });
    const config = join(dir, "cairntrace.config.yml");
    await writeFile(
      config,
      `version: 1\nartifactRoot: ${join(dir, "runs")}\nenvironments:\n  local: { baseUrl: http://app.test }\n  dev: { baseUrl: http://dev.app.test, vars: { who: dev } }\n`,
    );
    const spec = join(dir, "flows", "_drafts", "a.yml");
    await writeFile(
      spec,
      `version: 1
name: a_spec
intent: A
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { url: { endsWith: /a } }
steps:
  - click: { by: selector, selector: #go }
  - open: /a/\${vars.who}
`,
    );
    const c = await connect();
    const lint = await call(c, "cairn_spec_lint", {
      path: spec,
      config,
      env: "local,dev",
    });
    expect(lint.isError).toBe(true);
    expect(lint.sc).toMatchObject({
      $schema: "urn:cairntrace.dev:spec-lint:v1",
      exitCode: 4,
      summary: { errors: 1 },
    });
    expect(lint.text).toContain("[unquoted-hash]");

    const fixed = await call(c, "cairn_spec_lint", {
      paths: [spec],
      config,
      env: ["local", "dev"],
      fix: true,
    });
    const findings = (
      fixed.sc["files"] as Array<{
        findings: Array<{ rule: string; env?: string }>;
      }>
    )[0]!.findings;
    // Quoting fixed; the var resolves in dev only.
    expect(findings.filter((f) => f.rule === "unresolved-var")).toEqual([
      expect.objectContaining({ env: "local" }),
    ]);
    expect(await readFile(spec, "utf8")).toContain('selector: "#go"');

    const promote = await call(c, "cairn_spec_promote", { path: spec, config });
    expect(promote.isError).toBe(true);
    expect(promote.sc).toMatchObject({ exitCode: 4 });
    expect(promote.text).toContain("no `cairn spec finish` ran for it");

    const finish = await call(c, "cairn_spec_finish", {
      path: spec,
      config,
      env: "local",
      mock: true,
    });
    expect(finish.isError).toBe(true);
    expect(finish.sc).toMatchObject({ status: "lint-failed", exitCode: 4 });
    await c.close();
  }, 30_000);
});
