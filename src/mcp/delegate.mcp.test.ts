import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchRunResultSchema } from "../core/schema/runBatch.v1";
import {
  RunInvocationStatusResultSchema,
  type RunInvocationStatusResult,
} from "../core/schema/runInvocation.v1";
import {
  afterFirstRun,
  recordDelegateSuite,
  writeDelegateProject,
  writeScenarioConfig,
  type DelegateRecording,
} from "../testing/delegateFixtures";
import { buildMcpServer } from "./server";

/**
 * MCP `cairn_run` on an environment with a runner: the same engine, so the
 * same delegated invocation — a background handle, `cairn_run_status` read
 * from the local journal (with its `delegate` block), and
 * `cairn_run_cancel` reaching the runner as SIGINT.
 */

let dir: string;
let remoteRoot: string;
let recording: DelegateRecording;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-delegate-mcp-"));
  remoteRoot = await mkdtemp(join(tmpdir(), "cairn-delegate-mcp-remote-"));
  await writeDelegateProject(dir);
  recording = await recordDelegateSuite(dir, remoteRoot, "both");
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(remoteRoot, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "delegate-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function status(
  client: Client,
  invocationId: string,
): Promise<RunInvocationStatusResult> {
  const r = await client.callTool({
    name: "cairn_run_status",
    arguments: { invocationId },
  });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return RunInvocationStatusResultSchema.parse(r.structuredContent);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cairn_run on a delegated environment", () => {
  it("runs in the background; status comes from the local journal", async () => {
    const { config } = await writeScenarioConfig(dir, "mcp-bg", {
      lines: recording.lines,
      runDirs: recording.runDirs,
      delayMs: 20,
    });
    const artifactRoot = join(dir, "runs-bg");
    const client = await connect();
    try {
      const started = await client.callTool({
        name: "cairn_run",
        arguments: {
          suite: "both",
          env: "remote",
          config,
          artifactRoot,
          wait: false,
        },
      });
      expect(started.isError, JSON.stringify(started.content)).toBeFalsy();
      const id = RunInvocationStatusResultSchema.parse(
        started.structuredContent,
      ).invocationId;
      let current = await status(client, id);
      for (let i = 0; i < 400 && current.status === "running"; i++) {
        await sleep(50);
        current = await status(client, id);
      }
      expect(current).toMatchObject({
        status: "passed",
        exitCode: 0,
        delegate: {
          contract: "urn:cairntrace.dev:delegate:v1",
          remoteInvocationId: recording.invocationId,
          exitCode: 0,
        },
        summary: { total: 2, passed: 2 },
      });
      expect(current.runs.map((run) => run.status)).toEqual([
        "passed",
        "passed",
      ]);
      const batch = BatchRunResultSchema.parse(current.document);
      expect(batch.invocationOutcome?.delegate?.remoteInvocationId).toBe(
        recording.invocationId,
      );
    } finally {
      await client.close();
    }
  }, 60_000);

  it("cairn_run_cancel reaches the runner as SIGINT", async () => {
    const cut = afterFirstRun(recording.lines);
    const { config, recordTo } = await writeScenarioConfig(dir, "mcp-cancel", {
      lines: recording.lines,
      runDirs: recording.runDirs,
      hangAfter: cut,
      onSigint: { lines: recording.lines.slice(cut), exitCode: 130 },
    });
    const client = await connect();
    try {
      const started = await client.callTool({
        name: "cairn_run",
        arguments: {
          suite: "both",
          env: "remote",
          config,
          artifactRoot: join(dir, "runs-cancel"),
          wait: false,
        },
      });
      const id = RunInvocationStatusResultSchema.parse(
        started.structuredContent,
      ).invocationId;
      for (let i = 0; i < 400 && !existsSync(recordTo); i++) await sleep(25);
      for (let i = 0; i < 400; i++) {
        const current = await status(client, id);
        if (current.runs.some((run) => run.status === "passed")) break;
        await sleep(25);
      }
      const cancelled = await client.callTool({
        name: "cairn_run_cancel",
        arguments: { invocationId: id },
      });
      expect(cancelled.isError).toBeFalsy();
      const after = RunInvocationStatusResultSchema.parse(
        cancelled.structuredContent,
      );
      expect(after).toMatchObject({
        status: "aborted",
        cancelRequested: true,
        exitCode: 130,
        delegate: { cancelled: true },
      });
    } finally {
      await client.close();
    }
  }, 60_000);
});
