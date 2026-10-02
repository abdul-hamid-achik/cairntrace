import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "./server";

/** MCP mirrors of `cairn pin`, `cairn publish` and the stash evidence gate. */

const RUN_ID = "2026-10-02T12-00-00-000Z_checkout_0a1b2c";
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    FCHEAP_BIN: process.env.FCHEAP_BIN,
    FILECHEAP_INGEST_TOKEN: process.env.FILECHEAP_INGEST_TOKEN,
  };
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

async function runsRoot(): Promise<{ root: string; runDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "cairntrace-mcp-evidence-"));
  const runDir = join(root, RUN_ID);
  await mkdir(join(runDir, "traces"), { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify({ runId: RUN_ID, status: "failed" }),
  );
  await writeFile(
    join(runDir, "artifact-manifest.json"),
    JSON.stringify({ version: "1", artifacts: [] }),
  );
  await writeFile(join(runDir, "traces", "playwright-trace.zip"), "raw");
  return { root, runDir };
}

async function fakeFcheap(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-mcp-fake-fcheap-"));
  const bin = join(dir, "fcheap");
  const log = join(dir, "args.log");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${script}\n`,
  );
  await chmod(bin, 0o755);
  process.env.FCHEAP_BIN = bin;
  return log;
}

describe("MCP evidence tools", () => {
  it("cairn_pin pins and unpins a run", async () => {
    const { root, runDir } = await runsRoot();
    const c = await connect();
    try {
      const pinned = await c.callTool({
        name: "cairn_pin",
        arguments: { runId: "latest", artifactRoot: root, reason: "keep it" },
      });
      expect(pinned.isError).toBeFalsy();
      expect(pinned.structuredContent).toMatchObject({
        runId: RUN_ID,
        changed: true,
        pinned: { reason: "keep it" },
      });
      expect(
        JSON.parse(await readFile(join(runDir, "run.json"), "utf8")).pinned
          .reason,
      ).toBe("keep it");

      const unpinned = await c.callTool({
        name: "cairn_pin",
        arguments: { runId: RUN_ID, artifactRoot: root, unpin: true },
      });
      expect(unpinned.structuredContent).toMatchObject({
        pinned: false,
        changed: true,
      });
    } finally {
      await c.close();
    }
  });

  it("cairn_stash_save applies the evidence gate and reports what it left out", async () => {
    const { root, runDir } = await runsRoot();
    const log =
      await fakeFcheap(`if [ "$1" = "--version" ]; then echo "fcheap test"; exit 0; fi
if [ "$1" = "save" ] && [ "$2" != "--help" ]; then
  printf '%s\\n' '{"id":"mcp-gate-1","status":"saved"}'
  exit 0
fi
exit 2`);
    const c = await connect();
    try {
      const result = await c.callTool({
        name: "cairn_stash_save",
        arguments: { runId: "latest", artifactRoot: root },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        stashId: "mcp-gate-1",
        excluded: ["traces/"],
        receipt: "stash-receipt.json",
      });
      const save = (await readFile(log, "utf8"))
        .split("\n")
        .find((line) => line.startsWith("save ") && !line.includes("--help"));
      expect(save?.split(" ")[1]).not.toBe(runDir);
    } finally {
      await c.close();
    }
  });

  it("cairn_publish returns a structured error with a reason code", async () => {
    const { root, runDir } = await runsRoot();
    await fakeFcheap(`echo "403 forbidden" >&2; exit 1`);
    process.env.FILECHEAP_INGEST_TOKEN = "mcp-test-ingest-token";
    const c = await connect();
    try {
      const result = await c.callTool({
        name: "cairn_publish",
        arguments: { runId: RUN_ID, artifactRoot: root, retentionDays: 2 },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "error",
        reason: "auth",
        retentionDays: 2,
      });
      expect(await readFile(join(runDir, "events.ndjson"), "utf8")).toContain(
        '"type":"artifact.publish"',
      );
    } finally {
      await c.close();
    }
  });
});
