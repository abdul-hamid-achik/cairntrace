import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixturesResultSchema } from "../../core/fixtures/result";
import { buildMcpServer } from "../../mcp/server";
import { runFixtures, type FixturesRequest } from "./fixtures";

/**
 * `cairn fixtures list|status|ensure|reset|teardown|sweep` and the MCP
 * `cairn_fixtures_*` tools against a temp config with exec fixtures.
 */

let dir: string;
let log: string;
let ledgerRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-fixtures-cli-"));
  log = join(dir, "fixture.log");
  ledgerRoot = join(dir, "ledger");
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
project: clidemo
defaultEnvironment: local
environments:
  local: {}
  staging:
    policy: { trait: shared }
fixtures:
  tenant:
    kind: exec
    description: A demo tenant.
    ensure:
      shell: 'echo "ensure $1" >> "${log}"; echo "{\\"id\\":\\"t-$1\\",\\"token\\":\\"tok-$1-hidden\\"}"'
      args: ["\${with.suffix}"]
    verify: 'test -f "${join(dir, "present")}"'
    teardown: 'echo "teardown \${fixtures.tenant.id}" >> "${log}"'
    reset: 'echo "reset" >> "${log}"'
    with: { suffix: one }
    outputs: { id: "$.id", token: { from: "$.token", secret: true } }
  kit:
    kind: exec
    scope: seed
    ttl: 6h
    ensure: 'echo "{}"'
`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixtures(req: Omit<FixturesRequest, "ledgerRoot" | "cwd">) {
  const result = await runFixtures({ cwd: dir, ledgerRoot, ...req });
  return FixturesResultSchema.parse(result);
}

async function lines(): Promise<string[]> {
  try {
    return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("cairn fixtures", () => {
  it("lists the registry", async () => {
    const result = await fixtures({ action: "list" });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      project: "clidemo",
      env: "local",
      writes: "allowed",
    });
    expect(result.fixtures).toEqual([
      {
        name: "tenant",
        kind: "exec",
        scope: "run",
        description: "A demo tenant.",
        verbs: ["ensure", "reset", "verify", "teardown"],
        needs: [],
        outputs: [{ key: "id" }, { key: "token", secret: true }],
        with: ["suffix"],
      },
      {
        name: "kit",
        kind: "exec",
        scope: "seed",
        verbs: ["ensure"],
        needs: [],
        outputs: [],
        ttlMs: 21_600_000,
      },
    ]);
  });

  it("ensures, reports status and tears down with the recorded outputs", async () => {
    await writeFile(join(dir, "present"), "");
    const ensured = await fixtures({
      action: "ensure",
      names: ["tenant"],
      with: ["suffix=two"],
    });
    expect(ensured).toMatchObject({
      ok: true,
      exitCode: 0,
      outputs: { tenant: { id: "t-two", token: "[redacted]" } },
    });
    // verify runs right after ensure.
    expect(ensured.events?.map((e) => `${e.type}:${e.status}`)).toEqual([
      "fixture.ensure:ok",
      "fixture.verify:ok",
    ]);
    await rm(join(dir, "present"));

    const status = await fixtures({ action: "status" });
    expect(status.status).toEqual([
      expect.objectContaining({
        name: "tenant",
        state: "live",
        outputs: { id: "t-two", token: "[redacted]" },
      }),
      expect.objectContaining({ name: "kit", state: "never" }),
    ]);
    const verified = await fixtures({
      action: "status",
      names: ["tenant"],
      verify: true,
    });
    expect(verified).toMatchObject({ ok: false, exitCode: 1 });
    expect(verified.status?.[0]?.verify).toMatchObject({ ok: false });
    await writeFile(join(dir, "present"), "");
    expect(
      (await fixtures({ action: "status", names: ["tenant"], verify: true }))
        .exitCode,
    ).toBe(0);

    const torn = await fixtures({ action: "teardown", names: ["tenant"] });
    expect(torn).toMatchObject({ ok: true, exitCode: 0 });
    expect(await lines()).toEqual(["ensure two", "teardown t-two"]);
    expect(
      (await fixtures({ action: "status", names: ["tenant"] })).status?.[0],
    ).toMatchObject({
      state: "torn-down",
      lastVerb: "teardown",
    });
  });

  it("exits 4 on unknown fixtures, unknown env or bad flags, and 1 on a failed verb", async () => {
    expect(
      (await fixtures({ action: "ensure", names: ["nope"] })).exitCode,
    ).toBe(4);
    expect((await fixtures({ action: "list", env: "prod" })).exitCode).toBe(4);
    expect(
      (await fixtures({ action: "ensure", names: ["tenant"], with: ["oops"] }))
        .exitCode,
    ).toBe(4);
    expect(
      (await fixtures({ action: "sweep", olderThan: "soon" })).exitCode,
    ).toBe(4);
    const noConfig = await runFixtures({
      action: "list",
      cwd: tmpdir(),
      ledgerRoot,
    });
    expect(noConfig.exitCode).toBe(4);
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
environments: { local: {} }
fixtures:
  broken: { kind: exec, ensure: 'exit 7' }
`,
    );
    const failed = await fixtures({ action: "ensure", names: ["broken"] });
    expect(failed).toMatchObject({ ok: false, exitCode: 1 });
    expect(failed.error).toMatch(/fixture broken ensure failed: .*exit 7/);
  });

  it("dry-runs on a shared environment unless --allow-writes", async () => {
    await writeFile(join(dir, "present"), "");
    const dry = await fixtures({
      action: "ensure",
      names: ["tenant"],
      env: "staging",
    });
    expect(dry).toMatchObject({ ok: true, exitCode: 0, writes: "dry-run" });
    expect(dry.events?.at(-1)).toMatchObject({
      type: "fixture.ensure",
      status: "dry-run",
    });
    expect(await lines()).toEqual([]);
    const wrote = await fixtures({
      action: "ensure",
      names: ["tenant"],
      env: "staging",
      allowWrites: true,
    });
    expect(wrote.writes).toBe("allowed");
    expect(await lines()).toEqual(["ensure one"]);
  });

  it("sweeps live leftovers: dry-run first, --apply tears down, a live owner is left alone", async () => {
    await fixtures({ action: "ensure", names: ["tenant"] });
    // A leftover recorded by a process that is still running.
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    await mkdir(ledgerRoot, { recursive: true });
    await appendFile(
      join(ledgerRoot, "clidemo.ledger.jsonl"),
      `${JSON.stringify({
        v: 1,
        ts: new Date(Date.now() - 7_200_000).toISOString(),
        project: "clidemo",
        env: "local",
        name: "kit",
        adapter: "exec",
        scope: "seed",
        verb: "ensure",
        status: "ok",
        defHash: "x",
        origin: "run",
        pid: sleeper.pid,
        host: hostname(),
      })}\n`,
    );
    try {
      const young = await fixtures({ action: "sweep" });
      expect(young.sweep?.candidates.map((c) => [c.name, c.action])).toEqual([
        ["tenant", "skipped-young"],
        ["kit", "skipped-no-teardown"],
      ]);
      const preview = await fixtures({ action: "sweep", olderThan: "0" });
      expect(preview.sweep).toMatchObject({ applied: false });
      expect(preview.sweep?.candidates[0]).toMatchObject({
        name: "tenant",
        action: "teardown",
      });
      expect(await lines()).toEqual(["ensure one"]);

      const applied = await fixtures({
        action: "sweep",
        olderThan: 0,
        apply: true,
      });
      expect(applied.sweep?.candidates[0]).toMatchObject({
        name: "tenant",
        result: "ok",
      });
      expect(await lines()).toEqual(["ensure one", "teardown t-one"]);
      const records = (
        await readFile(join(ledgerRoot, "clidemo.ledger.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({
        verb: "teardown",
        origin: "sweep",
        status: "ok",
      });
      const after = await fixtures({ action: "sweep", olderThan: 0 });
      expect(after.sweep?.candidates.map((c) => c.name)).toEqual(["kit"]);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("serves the same verbs over MCP", async () => {
    const server = buildMcpServer();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "test", version: "0" },
      { capabilities: {} },
    );
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.callTool({
        name: "cairn_fixtures_list",
        arguments: { config: join(dir, "cairntrace.config.yml") },
      });
      const doc = FixturesResultSchema.parse(listed.structuredContent);
      expect(doc.fixtures?.map((f) => f.name)).toEqual(["tenant", "kit"]);
      expect(
        String((listed.content as Array<{ text: string }>)[0]?.text),
      ).toContain("| tenant | exec | run |");
      const missing = await client.callTool({
        name: "cairn_fixtures_ensure",
        arguments: { config: join(dir, "cairntrace.config.yml"), name: "nope" },
      });
      expect(missing.isError).toBe(true);
      expect(
        FixturesResultSchema.parse(missing.structuredContent).exitCode,
      ).toBe(4);
    } finally {
      await client.close();
    }
  });

  it("prints the JSON document and exits with its code from the CLI", async () => {
    const child = spawn(
      "bun",
      [
        join(import.meta.dirname, "..", "..", "..", "bin", "cairn"),
        "fixtures",
        "list",
        "--json",
      ],
      {
        cwd: dir,
        env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
      },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const code = await new Promise<number | null>((resolveExit) =>
      child.on("close", (exitCode) => resolveExit(exitCode)),
    );
    expect(code).toBe(0);
    expect(FixturesResultSchema.parse(JSON.parse(out)).fixtures).toHaveLength(
      2,
    );
  }, 30_000);
});

/** One ledger line of a run-scoped `writer` instance, recorded 2h ago. */
function writerRecord(instance: string, verb: "ensure" | "teardown"): string {
  return `${JSON.stringify({
    v: 1,
    ts: new Date(Date.now() - 7_200_000).toISOString(),
    project: "clidemo",
    env: "local",
    name: "writer",
    adapter: "exec",
    scope: "run",
    verb,
    status: "ok",
    defHash: "h",
    origin: "run",
    instance,
    runId: instance,
    ...(verb === "ensure" ? { outputs: { id: `w-${instance}` } } : {}),
    pid: 999_999,
    host: hostname(),
  })}\n`;
}

describe("cairn fixtures: the safety contract", () => {
  async function writeConfig(fixturesBlock: string): Promise<void> {
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
project: clidemo
defaultEnvironment: local
environments:
  local: {}
  qa:
    policy: { trait: protected }
  locked:
    policy: { trait: owned, mutations: deny }
fixtures:
${fixturesBlock}`,
    );
  }

  async function ledgerLines(): Promise<Array<Record<string, unknown>>> {
    return (await readFile(join(ledgerRoot, "clidemo.ledger.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("keeps writes off under mutations: deny (even with --allow-writes) and on a protected env", async () => {
    await writeConfig(`  writer:
    kind: exec
    ensure: 'echo "ensured-writer" >> "${log}"; echo "{}"'
`);
    const locked = await fixtures({
      action: "ensure",
      names: ["writer"],
      env: "locked",
      allowWrites: true,
    });
    expect(locked).toMatchObject({
      ok: true,
      writes: "dry-run",
      writesReason: expect.stringContaining("denies mutations"),
    });
    const qa = await fixtures({
      action: "ensure",
      names: ["writer"],
      env: "qa",
    });
    expect(qa).toMatchObject({
      writes: "dry-run",
      writesReason: expect.stringContaining("is protected"),
    });
    expect(await lines()).toEqual([]);
    const allowed = await fixtures({
      action: "ensure",
      names: ["writer"],
      env: "qa",
      allowWrites: true,
    });
    expect(allowed.writes).toBe("allowed");
    expect(await lines()).toEqual(["ensured-writer"]);
  });

  it("redacts sensitive output fields from the document and the ledger", async () => {
    await writeConfig(`  tok:
    kind: exec
    ensure: 'echo "{\\"id\\":\\"x1\\",\\"apiToken\\":\\"tokSUPERSECRET123\\"}"'
`);
    const ensured = await fixtures({ action: "ensure", names: ["tok"] });
    expect(ensured.outputs).toEqual({
      tok: { id: "x1", apiToken: "[redacted]" },
    });
    expect(JSON.stringify(ensured)).not.toContain("tokSUPERSECRET123");
    const status = await fixtures({ action: "status" });
    expect(JSON.stringify(status)).not.toContain("tokSUPERSECRET123");
    expect(
      await readFile(join(ledgerRoot, "clidemo.ledger.jsonl"), "utf8"),
    ).not.toContain("tokSUPERSECRET123");
  });

  it("sweeps and tears down run instances one by one", async () => {
    await writeConfig(`  writer:
    kind: exec
    ensure: 'echo "{\\"id\\":\\"w-$CAIRN_RUN_ID\\"}"'
    teardown: 'echo "torn \${fixtures.writer.id}" >> "${log}"'
    outputs: { id: "$.id" }
`);
    await mkdir(ledgerRoot, { recursive: true });
    await appendFile(
      join(ledgerRoot, "clidemo.ledger.jsonl"),
      writerRecord("slow", "ensure") +
        writerRecord("fast", "ensure") +
        writerRecord("fast", "teardown") +
        writerRecord("other", "ensure"),
    );
    const status = await fixtures({ action: "status", names: ["writer"] });
    expect(status.status?.[0]).toMatchObject({ state: "live", instances: 2 });
    const preview = await fixtures({ action: "sweep", olderThan: 0 });
    expect(
      preview.sweep?.candidates
        .map((c) => [c.instance, c.state, c.action])
        .toSorted(),
    ).toEqual([
      ["other", "live", "teardown"],
      ["slow", "live", "teardown"],
    ]);
    const applied = await fixtures({
      action: "sweep",
      olderThan: 0,
      apply: true,
    });
    expect(applied.exitCode).toBe(0);
    expect((await lines()).toSorted()).toEqual(["torn w-other", "torn w-slow"]);
    expect(
      (await fixtures({ action: "sweep", olderThan: 0 })).sweep?.candidates,
    ).toEqual([]);
    // `teardown <name>` also takes every open instance.
    await appendFile(
      join(ledgerRoot, "clidemo.ledger.jsonl"),
      writerRecord("a", "ensure") + writerRecord("b", "ensure"),
    );
    const torn = await fixtures({ action: "teardown", names: ["writer"] });
    expect(torn.exitCode).toBe(0);
    expect((await lines()).slice(2).toSorted()).toEqual([
      "torn w-a",
      "torn w-b",
    ]);
  });

  it("reports a failed ensure without outputs as skipped-no-outputs, exit 0, and --apply releases it", async () => {
    await writeConfig(`  buyer:
    kind: exec
    ensure: 'exit 1'
    teardown: 'echo "torn \${fixtures.buyer.id}" >> "${log}"'
    outputs: { id: "$.id" }
`);
    expect(
      (await fixtures({ action: "ensure", names: ["buyer"] })).exitCode,
    ).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const preview = await fixtures({ action: "sweep", olderThan: 0 });
      expect(preview.exitCode).toBe(0);
      expect(preview.sweep?.candidates.map((c) => c.action)).toEqual([
        "skipped-no-outputs",
      ]);
    }
    const applied = await fixtures({
      action: "sweep",
      olderThan: 0,
      apply: true,
    });
    expect(applied).toMatchObject({ ok: true, exitCode: 0 });
    expect(applied.sweep?.candidates[0]).toMatchObject({ result: "skipped" });
    expect((await ledgerLines()).at(-1)).toMatchObject({
      verb: "teardown",
      status: "skipped",
      released: true,
    });
    expect(
      (await fixtures({ action: "sweep", olderThan: 0 })).sweep?.candidates,
    ).toEqual([]);
    expect(
      (await fixtures({ action: "status", names: ["buyer"] })).status?.[0]
        ?.state,
    ).toBe("released");
    expect(await lines()).toEqual([]);
  });
});
