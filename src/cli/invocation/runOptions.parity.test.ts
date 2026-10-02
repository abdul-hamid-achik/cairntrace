import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  RunInvocationOptionsSchema,
  RunInvocationOptionsShape,
} from "../../core/schema/runInvocation.v1";
import {
  configureRunCommand,
  runInvocationOptionsFromCli,
  type RunCommandOptions,
} from "../commands/run";
import { buildMcpServer } from "../../mcp/server";
import {
  CAIRN_RUN_INPUT_SHAPE,
  runOptionsFromMcpInput,
} from "../../mcp/runTools";
import { runOptionsToArgv } from "./options";

/**
 * MCP ↔ CLI parity by construction: every `cairn run` flag is a
 * RunInvocationOptions key (one engine, one options schema), and every key
 * is a `cairn_run` input. Only presentation flags stay CLI-only.
 */

/** Flags that change how a result is rendered, never what the run does. */
const PRESENTATION_ONLY = new Set([
  "--progress",
  "--format",
  "--json",
  "--yaml",
  "--md",
  "--help",
  // Global logging/color flags (registered on the program, listed for
  // completeness should they ever be repeated on the command).
  "--log-level",
  "--log-format",
  "--quiet",
  "--verbose",
  "--no-color",
]);

/** `--no-web-server` → `noWebServer`, `--since-codemap` → `sinceCodemap`. */
function schemaKey(longFlag: string): string {
  return longFlag
    .replace(/^--/, "")
    .replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

function runCommandDefinition(): Command {
  return configureRunCommand(new Command("run").argument("<spec...>"));
}

function registeredLongFlags(command: Command): string[] {
  return command.options
    .map((option) => option.long)
    .filter((flag): flag is string => typeof flag === "string");
}

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

function runHelp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [BIN, "run", "--help"], {
      env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

describe("cairn run ↔ RunInvocationOptions ↔ cairn_run parity", () => {
  it("represents every registered run flag in the options schema", () => {
    const flags = registeredLongFlags(runCommandDefinition());
    expect(flags.length).toBeGreaterThan(20);
    const schemaKeys = new Set(Object.keys(RunInvocationOptionsShape));
    const missing = flags
      .filter((flag) => !PRESENTATION_ONLY.has(flag))
      .filter((flag) => !schemaKeys.has(schemaKey(flag)));
    expect(missing).toEqual([]);
  });

  it("has no schema key without a run flag (no MCP-only run options)", () => {
    const flagKeys = new Set(
      registeredLongFlags(runCommandDefinition()).map(schemaKey),
    );
    const orphan = Object.keys(RunInvocationOptionsShape).filter(
      (key) => !flagKeys.has(key),
    );
    expect(orphan).toEqual([]);
  });

  it("matches the flags the real binary registers (`cairn run --help`)", async () => {
    const help = await runHelp();
    const flags = new Set<string>();
    for (const line of help.split("\n")) {
      const m = /^ {2}(?:-[A-Za-z], )?(--[a-z0-9][a-z0-9-]*)/.exec(line);
      if (m) flags.add(m[1]!);
    }
    expect(flags.size).toBeGreaterThan(20);
    const schemaKeys = new Set(Object.keys(RunInvocationOptionsShape));
    const missing = [...flags]
      .filter((flag) => !PRESENTATION_ONLY.has(flag))
      .filter((flag) => !schemaKeys.has(schemaKey(flag)));
    expect(missing).toEqual([]);
  }, 60_000);

  it("maps every flag through the one CLI mapping function", async () => {
    const command = runCommandDefinition();
    command.exitOverride();
    let captured: RunCommandOptions | undefined;
    command.action((_specs: string[], opts: RunCommandOptions) => {
      captured = opts;
    });
    await command.parseAsync(
      [
        "a.yml",
        "--env",
        "staging",
        "--config",
        "c.yml",
        "--var",
        "k=v",
        "--cold-start",
        "--headed",
        "--mock",
        "--backend",
        "playwright",
        "--provider",
        "ios",
        "--device",
        "iPhone 15 Pro",
        "--parallel",
        "3",
        "--artifact-root",
        "runs",
        "--junit",
        "junit.xml",
        "--stamp-if-green",
        "--no-web-server",
        "--no-services",
        "--services-dry-run",
        "--reuse-services",
        "--stash-on-failure",
        "--stash",
        "--auto-annotate",
        "on-run",
        "--monitor",
        "--since-codemap",
        "HEAD~1",
        "--select-only",
        "--tag",
        "smoke",
        "--label",
        "suite=ab",
        "--before",
        "echo before",
        "--after",
        "echo after",
        "--hook-timeout-ms",
        "1000",
        "--repeat",
        "2",
        "--matrix",
        "cfg=a,b",
        "--stop-on-fail",
        "--strict-requires",
        "--allow-fixture-writes",
        "--progress",
        "plain",
        "--json",
      ],
      { from: "user" },
    );
    const options = runInvocationOptionsFromCli(captured!);
    // Every schema key was produced from its flag, validated by the schema.
    expect(Object.keys(options).toSorted()).toEqual(
      Object.keys(RunInvocationOptionsShape).toSorted(),
    );
    expect(RunInvocationOptionsSchema.parse(options)).toMatchObject({
      env: "staging",
      parallel: 3,
      noWebServer: true,
      noServices: true,
      hookTimeoutMs: 1000,
      repeat: 2,
      autoAnnotate: "on-run",
      label: ["suite=ab"],
      allowFixtureWrites: true,
    });
    // The journal's argv for a non-CLI invocation round-trips the flags.
    const argv = runOptionsToArgv(["a.yml"], options);
    expect(argv).toContain("--no-web-server");
    expect(argv).toContain("--stop-on-fail");
    expect(argv).toContain("--strict-requires");
    expect(argv).toContain("--allow-fixture-writes");
  });

  it("keeps the legacy flag errors (exit-2 messages) in the mapping", () => {
    expect(() =>
      runInvocationOptionsFromCli({ hookTimeoutMs: "soon" }),
    ).toThrow('--hook-timeout-ms expects an integer, got "soon"');
    expect(() => runInvocationOptionsFromCli({ repeat: "0" })).toThrow(
      "--repeat must be between 1 and 1000",
    );
  });

  it("accepts every schema key in the cairn_run input schema", async () => {
    for (const key of Object.keys(RunInvocationOptionsShape)) {
      expect(CAIRN_RUN_INPUT_SHAPE, key).toHaveProperty(key);
    }
    const server = buildMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "parity", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const tools = await client.listTools();
      const run = tools.tools.find((tool) => tool.name === "cairn_run");
      expect(run).toBeDefined();
      const inputSchema = run!.inputSchema as {
        properties?: Record<string, unknown>;
      };
      const properties = Object.keys(inputSchema.properties ?? {});
      for (const key of Object.keys(RunInvocationOptionsShape)) {
        expect(properties, key).toContain(key);
      }
      // Transport-only keys on top of the shared shape.
      for (const key of ["specs", "path", "wait", "labels", "since"]) {
        expect(properties, key).toContain(key);
      }
    } finally {
      await client.close();
    }
  });

  it("folds MCP transport aliases into the shared options", () => {
    expect(
      runOptionsFromMcpInput({
        path: "a.yml",
        specs: ["b.yml"],
        labels: { suite: "ab" },
        label: ["path=next"],
        since: "HEAD~2",
        mock: true,
        wait: false,
      }),
    ).toEqual({
      specs: ["b.yml", "a.yml"],
      options: {
        mock: true,
        label: ["path=next", "suite=ab"],
        sinceCodemap: "HEAD~2",
      },
    });
  });
});
