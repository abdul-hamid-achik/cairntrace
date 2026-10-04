import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunResultSchema } from "../core/schema/run.v1";
import { buildMcpServer } from "./server";

/**
 * The engine pin (F19) over MCP: a config whose `requires.cairntrace` this
 * cairn does not satisfy refuses `cairn_run` with exit 4 and a message naming
 * both versions, and starts nothing.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-mcp-pin-"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
project: mcp-pin
defaultEnvironment: local
requires:
  cairntrace: ">=99.0"
environments:
  local:
    baseUrl: https://demo.example.test
`,
  );
  await writeFile(
    join(dir, "s.yml"),
    `version: 1
name: pin_spec
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cairn_run with an unmet requires.cairntrace", () => {
  it("is exit 4 with both versions in the message", async () => {
    const server = buildMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "pin-test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const result = await client.callTool({
        name: "cairn_run",
        arguments: {
          path: join(dir, "s.yml"),
          config: join(dir, "cairntrace.config.yml"),
          mock: true,
          noServices: true,
          noWebServer: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(RunResultSchema.parse(result.structuredContent)).toMatchObject({
        status: "errored",
        exitCode: 4,
      });
      expect(JSON.stringify(result.content)).toContain(
        "requires cairntrace >=99.0",
      );
    } finally {
      await client.close();
    }
  });
});
