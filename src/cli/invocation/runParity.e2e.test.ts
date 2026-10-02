import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Command } from "commander";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InvocationJournalSchema } from "../../core/schema/events.v1";
import { RunResultSchema, type RunResult } from "../../core/schema/run.v1";
import { configureRunCommand, runCommand } from "../commands/run";
import { buildMcpServer } from "../../mcp/server";

/**
 * End-to-end parity: the same spec through `cairn run` (the CLI adapter,
 * in-process with stdout captured) and MCP `cairn_run` (in-memory
 * transport), mock backend. Both must apply the config `browser:` block
 * (testIdAttribute), config + --var vars and labels, run the config
 * auto-stash for a failing spec (fake fcheap → stash-receipt.json in both),
 * and write equivalent run.json documents.
 */

const backendCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../backendFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../backendFactory")>();
  return {
    ...actual,
    createBackend: (options: Parameters<typeof actual.createBackend>[0]) => {
      backendCalls.push({ ...options });
      return actual.createBackend(options);
    },
  };
});

let dir: string;
let configPath: string;
let specPath: string;
let artifactRoot: string;
const previousFcheap = process.env.FCHEAP_BIN;

const SPEC = `version: 1
name: parity_probe
intent: One spec through cairn run and MCP cairn_run produces equivalent evidence.
coldStart: guest
outcomes:
  - id: greeting_visible
    description: the greeting from --var is visible
    verify: { text: { contains: "\${vars.greeting}" } }
steps:
  - id: open_landing
    open: "\${vars.landing}"
  - id: press_submit
    click: { by: testid, testid: submit-button }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-run-parity-"));
  artifactRoot = join(dir, "runs");
  configPath = join(dir, "cairntrace.config.yml");
  specPath = join(dir, "parity_probe.yml");
  await mkdir(join(dir, "bin"), { recursive: true });
  const fakeFcheap = join(dir, "bin", "fcheap");
  await writeFile(
    fakeFcheap,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'fcheap 0.30.0'; exit 0; fi
if [ "$1" = "save" ]; then echo '{"id":"stash-parity","status":"saved"}'; exit 0; fi
exit 2
`,
  );
  await chmod(fakeFcheap, 0o755);
  process.env.FCHEAP_BIN = fakeFcheap;
  await writeFile(
    configPath,
    `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8787
    vars: { landing: /home }
artifactRoot: ${JSON.stringify(artifactRoot)}
retention: { enabled: false }
browser:
  testIdAttribute: data-qa-id
stash:
  enabled: true
  autoStash: on-failure
  tags: [parity]
`,
  );
  await writeFile(specPath, SPEC);
});

afterAll(async () => {
  if (previousFcheap === undefined) delete process.env.FCHEAP_BIN;
  else process.env.FCHEAP_BIN = previousFcheap;
  await rm(dir, { recursive: true, force: true });
});

/** Replace per-invocation values so two runs of one spec compare equal. */
function normalize(value: unknown, subs: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const [from, to] of subs) text = text.split(from).join(to);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) ? "<ts>" : text;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, subs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /durationMs$/i.test(key) ? 0 : normalize(item, subs),
      ]),
    );
  }
  return value;
}

async function normalizedRunJson(run: RunResult): Promise<unknown> {
  const runJson = JSON.parse(
    await readFile(join(run.runDir, "run.json"), "utf8"),
  ) as RunResult;
  return normalize(runJson, [
    [run.runDir, "<runDir>"],
    [run.runId, "<runId>"],
    [run.invocation?.id ?? "<none>", "<invocationId>"],
  ]);
}

async function runViaCli(args: string[]): Promise<{
  stdout: string;
  exitCode: typeof process.exitCode;
}> {
  let stdout = "";
  const write = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
  const previousExitCode = process.exitCode;
  try {
    const program = new Command();
    program.exitOverride();
    configureRunCommand(program.command("run").argument("<spec...>")).action(
      (specs: string[], opts) => runCommand(specs, opts),
    );
    await program.parseAsync(["run", ...args], { from: "user" });
    return { stdout, exitCode: process.exitCode };
  } finally {
    write.mockRestore();
    process.exitCode = previousExitCode;
  }
}

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity-client", version: "1.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("cairn run ↔ MCP cairn_run end-to-end parity", () => {
  it("applies config, vars, labels, browser.testIdAttribute and auto-stash identically", async () => {
    backendCalls.length = 0;
    const cli = await runViaCli([
      specPath,
      "--config",
      configPath,
      "--var",
      "greeting=hi-from-var",
      "--label",
      "suite=parity",
      "--mock",
      "--json",
    ]);
    expect(cli.exitCode).toBe(1);
    const cliRun = RunResultSchema.parse(JSON.parse(cli.stdout));
    const cliBackend = backendCalls.splice(0);
    expect(cliBackend).toHaveLength(1);
    expect(cliBackend[0]).toMatchObject({
      mock: true,
      testIdAttribute: "data-qa-id",
    });

    const client = await connect();
    let mcpRun: RunResult;
    try {
      const result = await client.callTool({
        name: "cairn_run",
        arguments: {
          specs: [specPath],
          config: configPath,
          var: ["greeting=hi-from-var"],
          label: ["suite=parity"],
          mock: true,
        },
      });
      expect(result.isError).toBe(true);
      mcpRun = RunResultSchema.parse(result.structuredContent);
      expect(mcpRun.nextActions?.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
    const mcpBackend = backendCalls.splice(0);
    expect(mcpBackend).toHaveLength(1);
    expect(mcpBackend[0]).toMatchObject({
      mock: true,
      testIdAttribute: "data-qa-id",
    });
    // Same backend options except the session name, which MCP makes unique
    // per invocation so concurrent invocations never share a daemon (and
    // commander's explicit `headed: false` default, which is the backend
    // default anyway).
    const { session: cliSession, ...cliOptions } = cliBackend[0]!;
    const { session: mcpSession, ...mcpOptions } = mcpBackend[0]!;
    expect({ headed: false, ...mcpOptions }).toEqual({
      headed: false,
      ...cliOptions,
    });
    expect(cliSession).toBe(`cairntrace-${process.pid}`);
    expect(String(mcpSession)).toMatch(
      new RegExp(`^cairntrace-mcp-${process.pid}-[0-9a-f]{6}$`),
    );

    for (const run of [cliRun, mcpRun]) {
      expect(run.status).toBe("failed");
      expect(run.labels).toEqual({ suite: "parity" });
      expect(run.failure?.message).toContain("hi-from-var");
      expect(existsSync(join(run.runDir, "stash-receipt.json"))).toBe(true);
      const resolved = await readFile(
        join(run.runDir, "spec.resolved.yml"),
        "utf8",
      );
      expect(resolved).toContain("http://localhost:8787/home");
    }
    expect(await normalizedRunJson(mcpRun)).toEqual(
      await normalizedRunJson(cliRun),
    );

    // Both invocations are journaled, stamped with their origin.
    const journals = await Promise.all(
      [cliRun, mcpRun].map(async (run) =>
        InvocationJournalSchema.parse(
          JSON.parse(
            await readFile(
              join(artifactRoot, run.invocation!.dir, "invocation.json"),
              "utf8",
            ),
          ),
        ),
      ),
    );
    expect(journals[0]).toMatchObject({ origin: "cli", status: "failed" });
    expect(journals[1]).toMatchObject({
      origin: "mcp",
      client: "parity-client/1.0",
      status: "failed",
      labels: { suite: "parity" },
    });
    expect(journals[1]!.argv).toEqual(
      expect.arrayContaining(["run", specPath, "--config", configPath]),
    );
  }, 60_000);
});
