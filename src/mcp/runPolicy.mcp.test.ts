import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatchRunResultSchema } from "../core/schema/runBatch.v1";
import { RunResultSchema } from "../core/schema/run.v1";
import {
  RunInvocationStatusResultSchema,
  type RunInvocationStatusResult,
} from "../core/schema/runInvocation.v1";
import { buildMcpServer, type McpServerOptions } from "./server";

/**
 * MCP `cairn_run` through the shared engine takes the config `run:` policy:
 * a refusal before anything starts (exit 4), exit 8 for a critical teardown,
 * the run lock across invocations of one server, and `bail`.
 */

let dir: string;

const PASSING = `version: 1
name: mcp_policy_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;
const FAILING = PASSING.replace("mcp_policy_pass", "mcp_policy_fail").replace(
  'matches: "/home"',
  'matches: "/never"',
);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-mcp-policy-"));
  await writeFile(join(dir, "pass.yml"), PASSING);
  await writeFile(
    join(dir, "pass2.yml"),
    PASSING.replace("mcp_policy_pass", "mcp_policy_pass2"),
  );
  await writeFile(join(dir, "fail.yml"), FAILING);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect(options: McpServerOptions = {}): Promise<Client> {
  const server = buildMcpServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "run-policy-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function config(name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: mcp-policy
defaultEnvironment: local
artifactRoot: ${JSON.stringify(join(dir, `runs-${name}`))}
environments:
  local:
    baseUrl: https://demo.example.test
${body}`,
  );
  return path;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(
  client: Client,
  invocationId: string,
): Promise<RunInvocationStatusResult> {
  for (let i = 0; i < 200; i += 1) {
    const r = await client.callTool({
      name: "cairn_run_status",
      arguments: { invocationId },
    });
    const parsed = RunInvocationStatusResultSchema.parse(r.structuredContent);
    if (parsed.status !== "running" && parsed.status !== "cancelling")
      return parsed;
    await sleep(50);
  }
  throw new Error("invocation did not settle");
}

describe("cairn_run with the run policy", () => {
  it("a failed preflight refuses the run with exit 4 and names the check", async () => {
    const cfg = await config(
      "preflight",
      `run:
  preflight:
    - { command: "exit 3" }
`,
    );
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "cairn_run",
        arguments: { path: join(dir, "pass.yml"), config: cfg, mock: true },
      });
      expect(result.isError).toBe(true);
      expect(RunResultSchema.parse(result.structuredContent)).toMatchObject({
        status: "errored",
        exitCode: 4,
      });
      expect(JSON.stringify(result.content)).toContain(
        "preflight[1] command exit 3 failed",
      );
    } finally {
      await client.close();
    }
  });

  it("a failed critical teardown is exit 8: isError, status errored, recorded in the journal summary", async () => {
    const cfg = await config(
      "critical",
      `services:
  docker:
    command: "true"
    reuseExisting: false
  teardown:
    - { run: "exit 5", critical: true }
`,
    );
    const client = await connect({ allowServices: true });
    try {
      const sync = await client.callTool({
        name: "cairn_run",
        arguments: { path: join(dir, "pass.yml"), config: cfg, mock: true },
      });
      expect(sync.isError).toBe(true);
      expect(JSON.stringify(sync.content)).toContain(
        "critical teardown failed",
      );
      // The document agrees with the exit code: the spec passed, the
      // invocation did not.
      const run = RunResultSchema.parse(sync.structuredContent);
      expect(run).toMatchObject({
        status: "errored",
        exitCode: 8,
        failure: { phase: "invocation" },
        invocationOutcome: {
          exitCode: 8,
          specsExitCode: 0,
          runPolicy: { criticalTeardown: [{ index: 0, exitCode: 5 }] },
        },
      });
      expect(run.invocationOutcome?.error).toContain(
        "critical teardown failed",
      );

      const started = await client.callTool({
        name: "cairn_run",
        arguments: {
          path: join(dir, "pass.yml"),
          config: cfg,
          mock: true,
          wait: false,
        },
      });
      const settled = await settle(
        client,
        RunInvocationStatusResultSchema.parse(started.structuredContent)
          .invocationId,
      );
      expect(settled).toMatchObject({
        status: "errored",
        exitCode: 8,
        summary: {
          exitCode: 8,
          passed: 1,
          runPolicy: { criticalTeardown: [{ index: 0, exitCode: 5 }] },
        },
        document: { exitCode: 8, invocationOutcome: { exitCode: 8 } },
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("the run lock refuses a second invocation of one config while the first runs", async () => {
    const cfg = await config(
      "lock",
      `run:
  lock: true
  preflight:
    - { command: "sleep 1.5" }
`,
    );
    const client = await connect();
    try {
      const first = await client.callTool({
        name: "cairn_run",
        arguments: {
          path: join(dir, "pass.yml"),
          config: cfg,
          mock: true,
          wait: false,
        },
      });
      const firstId = RunInvocationStatusResultSchema.parse(
        first.structuredContent,
      ).invocationId;
      await sleep(400);
      const second = await client.callTool({
        name: "cairn_run",
        arguments: { path: join(dir, "pass2.yml"), config: cfg, mock: true },
      });
      expect(second.isError).toBe(true);
      expect(RunResultSchema.parse(second.structuredContent).exitCode).toBe(4);
      expect(JSON.stringify(second.content)).toContain(
        "another cairn run holds the run lock",
      );
      const finished = await settle(client, firstId);
      expect(finished).toMatchObject({ status: "passed", exitCode: 0 });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("bail skips the rest of a batch and reports it", async () => {
    const cfg = await config("bail", "");
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "cairn_run",
        arguments: {
          specs: [
            join(dir, "fail.yml"),
            join(dir, "pass.yml"),
            join(dir, "pass2.yml"),
          ],
          config: cfg,
          mock: true,
          bail: true,
        },
      });
      expect(result.isError).toBe(true);
      const batch = BatchRunResultSchema.parse(result.structuredContent);
      expect(batch.exitCode).toBe(1);
      expect(batch.summary).toMatchObject({ total: 1, failed: 1, skipped: 2 });
      expect(batch.skipped?.map((s) => s.reason)).toEqual(["bailed", "bailed"]);
      expect(JSON.stringify(result.content)).toContain("2 skipped (bailed)");
    } finally {
      await client.close();
    }
  });
});
