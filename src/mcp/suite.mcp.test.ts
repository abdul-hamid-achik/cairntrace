import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogResultSchema } from "../core/catalog/catalog.v1";
import { BatchRunResultSchema } from "../core/schema/runBatch.v1";
import { RunResultSchema } from "../core/schema/run.v1";
import { buildMcpServer } from "./server";

/**
 * MCP `cairn_run { suite }` runs a config suite through the shared engine:
 * the spec list and order, the suite's before/after hooks (declared in the
 * config, so they need no `--allow-hooks`), the usage error next to spec
 * paths, and the suite rows of `cairn_catalog`.
 */

let dir: string;
let runs: string;

const spec = (name: string): string => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-mcp-suite-"));
  runs = await mkdtemp(join(tmpdir(), "cairn-mcp-suite-runs-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", "first.yml"), spec("first"));
  await writeFile(join(dir, "flows", "second.yml"), spec("second"));
  await writeFile(
    join(dir, "flows", "broken.yml"),
    spec("broken").replace('matches: "/home"', 'matches: "/nowhere"'),
  );
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
project: mcp-suite
defaultEnvironment: local
artifactRoot: ${JSON.stringify(runs)}
environments:
  local:
    baseUrl: https://demo.example.test
suites:
  pair:
    specs: [flows/first.yml, flows/second.yml]
    order: [second]
    before: ['echo before > "${join(dir, "before.mark")}"']
    after: ['echo after > "${join(dir, "after.mark")}"']
  strict:
    specs: [flows/broken.yml, flows/first.yml]
    bail: true
    vars: { mode: suite }
    labels: { cohort: mcp }
    processEnv: { MCP_SUITE_MODE: exported }
    before: ['printf "%s %s" "$CAIRN_SUITE_VAR_MODE" "$MCP_SUITE_MODE" > "${join(dir, "strict.mark")}"']
`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(runs, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "suite-test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("cairn_run with a suite", () => {
  it("runs the suite's specs in order and its hooks, without specs in the request", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "cairn_run",
        arguments: {
          suite: "pair",
          config: join(dir, "cairntrace.config.yml"),
          mock: true,
          noServices: true,
          noWebServer: true,
        },
      });
      expect(result.isError).toBeFalsy();
      const batch = BatchRunResultSchema.parse(result.structuredContent);
      expect(batch.results.map((r) => r.spec.name)).toEqual([
        "second",
        "first",
      ]);
      expect(batch.results[0]!.labels).toMatchObject({ suite: "pair" });
      expect((await readFile(join(dir, "before.mark"), "utf8")).trim()).toBe(
        "before",
      );
      expect(existsSync(join(dir, "after.mark"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("bail: false runs every spec of a bailing suite; var, labels and processEnv match the CLI", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "cairn_run",
        arguments: {
          suite: "strict",
          bail: false,
          var: ["mode=caller"],
          config: join(dir, "cairntrace.config.yml"),
          mock: true,
          noServices: true,
          noWebServer: true,
        },
      });
      expect(result.isError).toBe(true);
      const batch = BatchRunResultSchema.parse(result.structuredContent);
      expect(batch.results.map((r) => r.spec.name)).toEqual([
        "broken",
        "first",
      ]);
      expect(batch.skipped ?? []).toEqual([]);
      expect(batch.results[1]!.labels).toEqual({
        cohort: "mcp",
        suite: "strict",
      });
      expect((await readFile(join(dir, "strict.mark"), "utf8")).trim()).toBe(
        "caller exported",
      );
    } finally {
      await client.close();
    }
  });

  it("refuses a suite next to a spec path that is not its own, and a request with neither", async () => {
    const client = await connect();
    try {
      const both = await client.callTool({
        name: "cairn_run",
        arguments: {
          suite: "pair",
          path: join(dir, "flows", "broken.yml"),
          config: join(dir, "cairntrace.config.yml"),
          mock: true,
          noServices: true,
          noWebServer: true,
        },
      });
      expect(both.isError).toBe(true);
      expect(RunResultSchema.parse(both.structuredContent)).toMatchObject({
        status: "errored",
        exitCode: 2,
      });
      expect(JSON.stringify(both.content)).toContain("is not among them");
      const neither = await client.callTool({
        name: "cairn_run",
        arguments: { mock: true },
      });
      expect(neither.isError).toBe(true);
      expect(JSON.stringify(neither.content)).toContain("or `suite`");
    } finally {
      await client.close();
    }
  });

  it("lists suites in cairn_catalog", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "cairn_catalog",
        arguments: {
          config: join(dir, "cairntrace.config.yml"),
          kind: "suites",
        },
      });
      const catalog = CatalogResultSchema.parse(result.structuredContent);
      expect(catalog.suites).toHaveLength(2);
      expect(catalog.suites![0]).toMatchObject({
        name: "pair",
        envs: [
          {
            env: "local",
            specs: ["flows/second.yml", "flows/first.yml"],
            before: 1,
            after: 1,
          },
        ],
      });
      expect(JSON.stringify(result.content)).toContain("suites 2: pair");
    } finally {
      await client.close();
    }
  });
});
