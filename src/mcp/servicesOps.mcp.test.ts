import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ServicesLogsResultSchema,
  ServicesRestartResultSchema,
} from "../core/schema/services.v1";
import { createFakeTmux, type FakeTmux } from "../testing/fakeTmux";
import { buildMcpServer } from "./server";

/**
 * MCP `cairn_services_restart` (gated by --allow-services) and
 * `cairn_services_logs` (read-only) against a stub tmux.
 */

let dir: string;
let configPath: string;
let fake: FakeTmux;
let undo: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-mcp-ops-"));
  configPath = join(dir, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
project: mcp-ops
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
services:
  tmux:
    session: mcp-ops
    windows:
      - name: web
        command: run-web
        readyOn: { text: "listening on 3000" }
`,
  );
  fake = createFakeTmux();
  undo = fake.activate();
});
afterEach(async () => {
  undo();
  fake.cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function connect(allowServices: boolean): Promise<Client> {
  const server = buildMcpServer({ allowServices });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ops-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("MCP services restart / logs", () => {
  it("restarts a window on a server that allows services", async () => {
    fake.seedRunning("mcp-ops", ["web"]);
    fake.setOutput("mcp-ops", "web", "listening on 3000\n");
    const client = await connect(true);
    try {
      const result = await client.callTool({
        name: "cairn_services_restart",
        arguments: { windows: ["web"], config: configPath, stopTimeout: "5s" },
      });
      expect(result.isError).toBeFalsy();
      expect(
        ServicesRestartResultSchema.parse(result.structuredContent),
      ).toMatchObject({
        ok: true,
        windows: [{ window: "web", ok: true }],
      });
    } finally {
      await client.close();
    }
  });

  it("refuses to restart without --allow-services, and touches nothing", async () => {
    fake.seedRunning("mcp-ops", ["web"]);
    const client = await connect(false);
    try {
      const result = await client.callTool({
        name: "cairn_services_restart",
        arguments: { windows: ["web"], config: configPath },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("--allow-services");
      expect(fake.callsOf("send-keys")).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("reads logs without the gate", async () => {
    fake.seedRunning("mcp-ops", ["web"]);
    fake.setPane("mcp-ops", "web", "one\ntwo\n");
    const client = await connect(false);
    try {
      const result = await client.callTool({
        name: "cairn_services_logs",
        arguments: { window: "web", config: configPath, lines: 1 },
      });
      expect(result.isError).toBeFalsy();
      expect(
        ServicesLogsResultSchema.parse(result.structuredContent),
      ).toMatchObject({
        ok: true,
        lines: ["two"],
        totalLines: 2,
      });
      const missing = await client.callTool({
        name: "cairn_services_logs",
        arguments: { window: "ghost", config: configPath },
      });
      expect(missing.isError).toBe(true);
      expect(
        ServicesLogsResultSchema.parse(missing.structuredContent).exitCode,
      ).toBe(4);
    } finally {
      await client.close();
    }
  });
});
