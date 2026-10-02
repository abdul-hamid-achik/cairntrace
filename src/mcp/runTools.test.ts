import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVOCATION_ID_PATTERN } from "../core/artifacts/invocationJournal";
import { InvocationJournalSchema } from "../core/schema/events.v1";
import { RunResultSchema } from "../core/schema/run.v1";
import { BatchRunResultSchema } from "../core/schema/runBatch.v1";
import {
  RunInvocationStatusResultSchema,
  RunLogsResultSchema,
  type RunInvocationStatusResult,
  type RunLogsResult,
} from "../core/schema/runInvocation.v1";
import { buildMcpServer, type McpServerOptions } from "./server";

/**
 * MCP run tools over the shared engine: background invocations
 * (wait:false → cairn_run_status / cairn_logs → settled), graceful cancel,
 * the --allow-hooks gate, progress notifications and the services queue.
 */

let dir: string;

const PASSING = `version: 1
name: mcp_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const slowSpec = (name: string, seconds: number) => `version: 1
name: ${name}
intent: A slow precondition keeps the run busy.
coldStart: guest
preconditions:
  commands:
    - name: slow_setup
      run: "sleep ${seconds}"
      timeoutMs: 30000
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-mcp-run-tools-"));
  await writeFile(join(dir, "pass.yml"), PASSING);
  await writeFile(join(dir, "slow.yml"), slowSpec("mcp_slow", 2));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function connect(options: McpServerOptions = {}): Promise<Client> {
  const server = buildMcpServer(options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "run-tools-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function logs(
  client: Client,
  args: Record<string, unknown>,
): Promise<RunLogsResult> {
  const r = await client.callTool({ name: "cairn_logs", arguments: args });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return RunLogsResultSchema.parse(r.structuredContent);
}

describe("cairn_run background mode", () => {
  it("returns at once, reports status, streams logs incrementally and settles", async () => {
    const artifactRoot = join(dir, "runs-bg");
    const client = await connect();
    try {
      const started = await client.callTool({
        name: "cairn_run",
        arguments: {
          specs: [join(dir, "slow.yml"), join(dir, "pass.yml")],
          mock: true,
          artifactRoot,
          wait: false,
        },
      });
      expect(started.isError).toBeFalsy();
      const first = RunInvocationStatusResultSchema.parse(
        started.structuredContent,
      );
      expect(first).toMatchObject({
        status: "running",
        owned: true,
        origin: "mcp",
        journalDir: `_invocations/${first.invocationId}`,
        journalDirAbsolute: join(
          artifactRoot,
          "_invocations",
          first.invocationId,
        ),
      });
      const id = first.invocationId;
      expect((await status(client, id)).status).toBe("running");

      // Poll the narration log from offset 0 until the invocation settled.
      let offset = 0;
      let text = "";
      let reads = 0;
      for (;;) {
        const slice = await logs(client, {
          invocationId: id,
          log: "narration",
          offset,
          maxBytes: 128,
        });
        expect(slice.offset).toBe(offset);
        expect(slice.nextOffset).toBeGreaterThanOrEqual(offset);
        // Whole lines while the writer may be mid-line: never a torn tail
        // after a complete line (a single line longer than maxBytes —
        // narration lines carry run dirs — comes back cut on its own).
        if (!slice.settled && slice.text.includes("\n")) {
          expect(slice.text.endsWith("\n")).toBe(true);
        }
        text += slice.text;
        offset = slice.nextOffset;
        reads += 1;
        if (slice.settled && slice.eof) break;
        if (slice.eof) await sleep(100);
        expect(reads).toBeLessThan(500);
      }
      expect(reads).toBeGreaterThan(1);
      expect(text).toContain("[1/2] ");
      expect(text).toMatch(/finished: passed, 2\/2 passed/);

      const done = await status(client, id);
      expect(done).toMatchObject({
        status: "passed",
        exitCode: 0,
        kind: "batch",
        planned: 2,
        summary: { total: 2, passed: 2 },
      });
      expect(done.runs.map((run) => run.status)).toEqual(["passed", "passed"]);
      const batch = BatchRunResultSchema.parse(done.document);
      expect(batch.results).toHaveLength(2);

      // A run of the invocation through cairn_logs (current run → events).
      const events = await logs(client, {
        invocationId: id,
        run: batch.results[1]!.runId,
      });
      expect(events.target).toBe("run");
      expect(events.text).toContain('"run.started"');
      expect(events.settled).toBe(true);
    } finally {
      await client.close();
    }
  }, 40_000);

  it("cancels gracefully: skips what is left, marks the journal aborted, idempotent", async () => {
    const artifactRoot = join(dir, "runs-cancel");
    const client = await connect();
    try {
      const started = await client.callTool({
        name: "cairn_run",
        arguments: {
          specs: [join(dir, "slow.yml"), join(dir, "pass.yml")],
          mock: true,
          artifactRoot,
          wait: false,
        },
      });
      const id = RunInvocationStatusResultSchema.parse(
        started.structuredContent,
      ).invocationId;
      // Wait until the first run is in flight.
      for (let i = 0; i < 400; i++) {
        const current = await status(client, id);
        if (current.runs.some((run) => run.status === "running")) break;
        await sleep(50);
      }
      const cancelled = await client.callTool({
        name: "cairn_run_cancel",
        arguments: { invocationId: id },
      });
      expect(cancelled.isError).toBeFalsy();
      const after = RunInvocationStatusResultSchema.parse(
        cancelled.structuredContent,
      );
      expect(after).toMatchObject({ status: "aborted", cancelRequested: true });
      const journal = InvocationJournalSchema.parse(
        JSON.parse(
          await readFile(
            join(artifactRoot, "_invocations", id, "invocation.json"),
            "utf8",
          ),
        ),
      );
      expect(journal.status).toBe("aborted");
      expect(journal.signal).toBeUndefined();
      // The second spec never started.
      expect(journal.runs.map((run) => run.spec)).toEqual([
        join(dir, "slow.yml"),
      ]);
      const batch = BatchRunResultSchema.parse(after.document);
      expect(batch.results[1]).toMatchObject({
        status: "errored",
        failure: { phase: "cancelled" },
      });
      const again = await client.callTool({
        name: "cairn_run_cancel",
        arguments: { invocationId: id },
      });
      expect(again.isError).toBeFalsy();
      expect(
        RunInvocationStatusResultSchema.parse(again.structuredContent).status,
      ).toBe("aborted");
    } finally {
      await client.close();
    }
  }, 40_000);

  it("refuses to cancel or find what it does not own", async () => {
    const client = await connect();
    try {
      const unknown = "2026-01-01T00-00-00-000Z_1_abcdef";
      const cancel = await client.callTool({
        name: "cairn_run_cancel",
        arguments: { invocationId: unknown },
      });
      expect(cancel.isError).toBe(true);
      const missing = await client.callTool({
        name: "cairn_run_status",
        arguments: { invocationId: unknown, artifactRoot: join(dir, "nope") },
      });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("cairn_run documents", () => {
  it("returns SelectionResult for selectOnly and an errored RunResult for an invocation error", async () => {
    const client = await connect();
    try {
      const selection = await client.callTool({
        name: "cairn_run",
        arguments: { specs: [dir], selectOnly: true, tag: ["nope"] },
      });
      expect(selection.isError).toBeFalsy();
      expect(selection.structuredContent).toMatchObject({
        $schema: "urn:cairntrace.dev:selection:v1",
        tags: ["nope"],
        selected: [],
      });

      const noMatch = await client.callTool({
        name: "cairn_run",
        arguments: {
          path: join(dir, "pass.yml"),
          tag: ["nope"],
          mock: true,
        },
      });
      expect(noMatch.isError).toBe(true);
      const errored = RunResultSchema.parse(noMatch.structuredContent);
      expect(errored).toMatchObject({
        status: "errored",
        exitCode: 2,
        failure: { phase: "invocation" },
      });
      expect(errored.failure?.message).toContain("no specs matched --tag");

      const missing = await client.callTool({
        name: "cairn_run",
        arguments: { mock: true },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("specs");
      // A synthesized document names no run directory on disk.
      expect(errored.synthetic).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("reports refused specs with their reason and never their placeholder run dirs", async () => {
    const project = join(dir, "policy-project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "cairntrace.config.yml"),
      `version: 1
artifactRoot: ${JSON.stringify(join(project, "runs"))}
environments:
  local: { baseUrl: https://demo.example.test }
  dev:
    baseUrl: https://demo.example.test
    policy: { trait: shared, mutations: deny }
`,
    );
    await writeFile(
      join(project, "local-only.yml"),
      PASSING.replace("name: mcp_pass", "name: local_only").replace(
        "coldStart: guest",
        "coldStart: guest\nrequires: { env: [local] }",
      ),
    );
    await writeFile(join(project, "pass.yml"), PASSING);
    const config = join(project, "cairntrace.config.yml");
    const client = await connect();
    try {
      const mixed = await client.callTool({
        name: "cairn_run",
        arguments: {
          specs: [join(project, "local-only.yml"), join(project, "pass.yml")],
          mock: true,
          env: "dev",
          config,
        },
      });
      expect(mixed.isError).toBeFalsy();
      const batch = BatchRunResultSchema.parse(mixed.structuredContent);
      expect(batch.summary).toMatchObject({ total: 2, passed: 1, refused: 1 });
      const refused = batch.results.find((r) => r.status === "refused")!;
      expect(refused.synthetic).toBe(true);
      const text = JSON.stringify(mixed.content);
      expect(text).toContain("1 refused");
      expect(text).toContain("refused in dev");
      expect(text).not.toContain(refused.runDir);

      const all = await client.callTool({
        name: "cairn_run",
        arguments: {
          path: join(project, "local-only.yml"),
          mock: true,
          env: "dev",
          config,
          wait: false,
        },
      });
      const started = RunInvocationStatusResultSchema.parse(
        all.structuredContent,
      );
      let settled = await status(client, started.invocationId);
      for (let i = 0; i < 100 && settled.status === "running"; i++) {
        await sleep(50);
        settled = await status(client, started.invocationId);
      }
      expect(settled).toMatchObject({
        status: "failed",
        exitCode: 7,
        runs: [],
        summary: { total: 1, refused: 1, exitCode: 7 },
      });
      const statusText = await client.callTool({
        name: "cairn_run_status",
        arguments: { invocationId: started.invocationId },
      });
      expect(JSON.stringify(statusText.content)).toContain("1 refused");
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("cairn_run hooks gate", () => {
  it("refuses before/after hooks without --allow-hooks and runs them with it", async () => {
    const marker = join(dir, "hook-ran");
    const args = {
      specs: [join(dir, "pass.yml")],
      mock: true,
      artifactRoot: join(dir, "runs-hooks"),
      noServices: true,
      noWebServer: true,
      before: [`touch "${marker}"`],
    };
    const strict = await connect();
    try {
      const refused = await strict.callTool({
        name: "cairn_run",
        arguments: args,
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("--allow-hooks");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await strict.close();
    }
    const allowed = await connect({ allowHooks: true });
    try {
      const ran = await allowed.callTool({
        name: "cairn_run",
        arguments: args,
      });
      expect(ran.isError).toBeFalsy();
      expect(RunResultSchema.parse(ran.structuredContent).status).toBe(
        "passed",
      );
      expect(existsSync(marker)).toBe(true);
    } finally {
      await allowed.close();
    }
  }, 30_000);
});

describe("cairn_run progress notifications", () => {
  it("sends run/step/outcome milestones for a request with a progressToken", async () => {
    const client = await connect();
    const messages: string[] = [];
    try {
      const result = await client.callTool(
        {
          name: "cairn_run",
          arguments: {
            path: join(dir, "pass.yml"),
            mock: true,
            artifactRoot: join(dir, "runs-progress"),
          },
        },
        undefined,
        {
          onprogress: (progress) => {
            messages.push(progress.message ?? "");
          },
        },
      );
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    expect(messages.some((m) => m.includes("mcp_pass started"))).toBe(true);
    expect(messages.some((m) => m.includes("outcome home passed"))).toBe(true);
    expect(messages.at(-1)).toContain("mcp_pass passed");
  }, 30_000);
});

describe("cairn_run services gate (--allow-services)", () => {
  it("refuses a run that would start config services, before anything starts", async () => {
    const gateDir = await mkdtemp(join(tmpdir(), "cairn-mcp-svc-gate-"));
    const log = join(gateDir, "services.log");
    await writeFile(join(gateDir, "pass.yml"), PASSING);
    await writeFile(
      join(gateDir, "cairntrace.config.yml"),
      `version: 1
project: gate
environments:
  local: {}
  remote:
    services: false
artifactRoot: ${JSON.stringify(join(gateDir, "runs"))}
services:
  docker:
    command: 'echo start >> "${log}"'
    reuseExisting: false
  teardown:
    - 'echo teardown >> "${log}"'
`,
    );
    const config = join(gateDir, "cairntrace.config.yml");
    const spec = join(gateDir, "pass.yml");
    const client = await connect();
    try {
      const refused = await client.callTool({
        name: "cairn_run",
        arguments: { specs: [spec], config, mock: true },
      });
      expect(refused.isError).toBe(true);
      const text = JSON.stringify(refused.content);
      expect(text).toContain("does not boot services");
      expect(text).toContain("--allow-services");
      expect(text).toContain("noServices");
      expect(refused.structuredContent).toMatchObject({
        status: "errored",
        exitCode: 4,
      });
      // Nothing started and no teardown ran.
      await expect(readFile(log, "utf8")).rejects.toThrow();

      const finish = await client.callTool({
        name: "cairn_spec_finish",
        arguments: { path: spec, config, mock: true },
      });
      expect(finish.isError).toBe(true);
      expect(JSON.stringify(finish.content)).toContain("--allow-services");
      await expect(readFile(log, "utf8")).rejects.toThrow();

      // noServices, and an environment without services, are not gated.
      const skipped = await client.callTool({
        name: "cairn_run",
        arguments: { specs: [spec], config, mock: true, noServices: true },
      });
      expect(skipped.isError, JSON.stringify(skipped.content)).toBeFalsy();
      const remote = await client.callTool({
        name: "cairn_run",
        arguments: { specs: [spec], config, mock: true, env: "remote" },
      });
      expect(remote.isError, JSON.stringify(remote.content)).toBeFalsy();
      // A dry run plans without starting anything.
      const dry = await client.callTool({
        name: "cairn_run",
        arguments: { specs: [spec], config, mock: true, servicesDryRun: true },
      });
      expect(dry.isError, JSON.stringify(dry.content)).toBeFalsy();
      await expect(readFile(log, "utf8")).rejects.toThrow();

      for (const [name, args] of [
        ["cairn_services_up", { config }],
        ["cairn_services_down", { config }],
      ] as const) {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain("--allow-services");
      }
      await expect(readFile(log, "utf8")).rejects.toThrow();
    } finally {
      await client.close();
    }

    // With the flag the same run boots and tears the services down.
    const allowed = await connect({ allowServices: true });
    try {
      const ran = await allowed.callTool({
        name: "cairn_run",
        arguments: { specs: [spec], config, mock: true },
      });
      expect(ran.isError, JSON.stringify(ran.content)).toBeFalsy();
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "start",
        "teardown",
      ]);
    } finally {
      await allowed.close();
      await rm(gateDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("cairn_run services queue", () => {
  it("serializes invocations that boot the same services environment; noServices runs at once", async () => {
    const queueDir = await mkdtemp(join(tmpdir(), "cairn-mcp-queue-"));
    const log = join(queueDir, "services.log");
    await writeFile(join(queueDir, "pass.yml"), PASSING);
    await writeFile(
      join(queueDir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
artifactRoot: ${JSON.stringify(join(queueDir, "runs"))}
services:
  docker:
    command: 'echo start >> "${log}"; sleep 2; echo end >> "${log}"'
    reuseExisting: false
`,
    );
    const config = join(queueDir, "cairntrace.config.yml");
    const spec = join(queueDir, "pass.yml");
    const client = await connect({ allowServices: true });
    try {
      const start = async (extra: Record<string, unknown> = {}) =>
        RunInvocationStatusResultSchema.parse(
          (
            await client.callTool({
              name: "cairn_run",
              arguments: {
                specs: [spec],
                config,
                mock: true,
                wait: false,
                ...extra,
              },
            })
          ).structuredContent,
        ).invocationId;
      const a = await start();
      const b = await start();
      // No services → never queues behind a and b.
      const quick = await client.callTool({
        name: "cairn_run",
        arguments: { specs: [spec], config, mock: true, noServices: true },
      });
      expect(quick.isError).toBeFalsy();
      expect((await status(client, a)).status).toBe("running");

      for (const id of [a, b]) {
        for (let i = 0; i < 200; i++) {
          if ((await status(client, id)).status !== "running") break;
          await sleep(100);
        }
        expect((await status(client, id)).status).toBe("passed");
      }
      // Never interleaved: the second boot started after the first released.
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "start",
        "end",
        "start",
        "end",
      ]);
      const narration = await logs(client, {
        invocationId: b,
        log: "narration",
        maxBytes: 1_048_576,
      });
      expect(narration.text).toContain("waiting for the services environment");
    } finally {
      await client.close();
      await rm(queueDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps the queue intact when the last queued invocation is cancelled", async () => {
    const queueDir = await mkdtemp(join(tmpdir(), "cairn-mcp-queue-cancel-"));
    const log = join(queueDir, "services.log");
    await writeFile(join(queueDir, "pass.yml"), PASSING);
    await writeFile(
      join(queueDir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
  e2e: {}
artifactRoot: ${JSON.stringify(join(queueDir, "runs"))}
services:
  docker:
    command: 'echo start >> "${log}"; sleep 2; echo end >> "${log}"'
    reuseExisting: false
  teardown:
    - 'echo teardown >> "${log}"'
`,
    );
    const config = join(queueDir, "cairntrace.config.yml");
    const spec = join(queueDir, "pass.yml");
    const client = await connect({ allowServices: true });
    try {
      const start = async (extra: Record<string, unknown> = {}) =>
        RunInvocationStatusResultSchema.parse(
          (
            await client.callTool({
              name: "cairn_run",
              arguments: {
                specs: [spec],
                config,
                mock: true,
                wait: false,
                ...extra,
              },
            })
          ).structuredContent,
        ).invocationId;
      const a = await start();
      await sleep(300);
      const b = await start();
      await sleep(300);
      const cancelled = RunInvocationStatusResultSchema.parse(
        (
          await client.callTool({
            name: "cairn_run_cancel",
            arguments: { invocationId: b },
          })
        ).structuredContent,
      );
      expect(cancelled).toMatchObject({
        status: "aborted",
        error: "cancelled while waiting for the services environment",
      });
      // Another environment of the same config shares its stack: it queues
      // behind a too, even though b (the newest waiter) left the queue.
      const c = await start({ env: "e2e" });
      for (const id of [a, c]) {
        for (let i = 0; i < 200; i++) {
          if ((await status(client, id)).status !== "running") break;
          await sleep(100);
        }
        expect((await status(client, id)).status).toBe("passed");
      }
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "start",
        "end",
        "teardown",
        "start",
        "end",
        "teardown",
      ]);
    } finally {
      await client.close();
      await rm(queueDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("cairn_logs cursor", () => {
  it("continues multi-file logs with nextCursor and refuses a bare offset", async () => {
    const artifactRoot = join(dir, "runs-logs-cursor");
    const client = await connect({ allowHooks: true });
    try {
      const ran = await client.callTool({
        name: "cairn_run",
        arguments: {
          specs: [join(dir, "pass.yml")],
          mock: true,
          artifactRoot,
          noServices: true,
          noWebServer: true,
          repeat: 2,
          before: ["echo before-hook"],
          after: ["echo after-hook"],
        },
      });
      expect(ran.isError).toBeFalsy();
      const batch = BatchRunResultSchema.parse(ran.structuredContent);
      expect(batch.results).toHaveLength(2);
      const [id] = (await readdir(join(artifactRoot, "_invocations"))).filter(
        (name) => INVOCATION_ID_PATTERN.test(name),
      );
      let text = "";
      let cursor: Record<string, number> | undefined;
      for (let i = 0; i < 50; i++) {
        const slice = await logs(client, {
          invocationId: id,
          log: "hook",
          maxBytes: 64,
          ...(cursor ? { cursor } : {}),
        });
        text += slice.text;
        cursor = slice.nextCursor;
        if (slice.eof) break;
      }
      // Two iterations share hook-before-01; each run has its own after log.
      expect(text.match(/^before-hook$/gm)).toHaveLength(2);
      expect(text.match(/^after-hook$/gm)).toHaveLength(2);
      expect(Object.keys(cursor ?? {})).toHaveLength(3);
      const refused = await client.callTool({
        name: "cairn_logs",
        arguments: { invocationId: id, log: "hook", offset: 10 },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("nextCursor");
    } finally {
      await client.close();
    }
  }, 30_000);
});
