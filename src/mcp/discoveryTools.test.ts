import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  DiscoveryActionResultSchema,
  DiscoveryOpenResultSchema,
} from "../core/schema/mcp.v1";
import { buildMcpServer } from "./server";

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client(
    { name: "discovery-test", version: "1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

async function project(): Promise<{
  dir: string;
  config: string;
  root: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-mcp-discovery-"));
  const root = join(dir, "runs");
  await mkdir(join(dir, "actions"), { recursive: true });
  await writeFile(
    join(dir, "actions", "sign_in.yml"),
    `version: 1
name: sign_in
steps:
  - open: /login
  - click: { by: role, role: button, name: Sign In }
`,
  );
  const config = join(dir, "cairntrace.config.yml");
  await writeFile(
    config,
    `version: 1
artifactRoot: ${root}
environments:
  local: {}
`,
  );
  return { dir, config, root };
}

type Structured = Record<string, unknown>;

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = await c.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    sc: (result.structuredContent ?? {}) as Structured,
    text: (result.content as Array<{ text: string }>)[0]?.text ?? "",
  };
}

describe("MCP discovery tools (setup, journal, network, export, resume)", () => {
  it("opens with setup, records richer steps, exports from the journal after close, resumes", async () => {
    const p = await project();
    const c = await connect();
    const opened = await call(c, "cairn_discover_open", {
      url: "/dashboard",
      mock: true,
      config: p.config,
      setup: [{ use: "sign_in" }],
      snapshotMode: "compact",
      ttlMs: 600000,
    });
    expect(opened.isError, opened.text).toBe(false);
    expect(DiscoveryOpenResultSchema.safeParse(opened.sc).success).toBe(true);
    const sessionId = opened.sc["sessionId"] as string;
    expect(opened.sc).toMatchObject({
      backend: "mock",
      ttlMs: 600000,
      setup: { ok: true, steps: 2 },
      snapshotInfo: { mode: "compact" },
    });
    const journal = opened.sc["journal"] as string;
    expect(journal).toBe(join(p.root, "_sessions", sessionId));
    const session = JSON.parse(
      await readFile(join(journal, "session.json"), "utf8"),
    );
    expect(session).toMatchObject({
      origin: "mcp",
      client: "discovery-test/1",
      setup: [{ use: "sign_in" }],
      configPath: p.config,
    });

    const asserted = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "assert",
      assert: { url: { includes: "/dashboard" } },
    });
    expect(asserted.isError).toBe(false);
    expect(DiscoveryActionResultSchema.safeParse(asserted.sc).success).toBe(
      true,
    );
    expect(asserted.sc["recordedStep"]).toEqual({
      wait: { url: { includes: "/dashboard" } },
    });
    expect(asserted.sc["network"]).toEqual({ mutations: [] });

    const evaluated = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "eval",
      eval: { js: "return 1" },
    });
    expect(evaluated.isError).toBe(false);
    expect(evaluated.sc["result"]).toBeDefined();

    const wrong = await call(c, "cairn_discover_interact", {
      sessionId,
      action: "click",
      target: "#wrong",
    });
    const removed = await call(c, "cairn_discover_remove_step", {
      sessionId,
      index: wrong.sc["index"] as number,
    });
    expect(removed.sc).toMatchObject({ removed: true });

    const network = await call(c, "cairn_discover_network", { sessionId });
    expect(network.isError).toBe(false);
    expect(network.sc).toMatchObject({ sessionId, total: expect.any(Number) });

    const suggested = await call(c, "cairn_discover_suggest", { sessionId });
    expect(suggested.sc["stepCount"]).toBe(3);

    expect((await call(c, "cairn_discover_close", { sessionId })).isError).toBe(
      false,
    );
    // Closed: no live session, but the journal answers.
    expect((await call(c, "cairn_discover_list", {})).sc["sessions"]).toEqual(
      [],
    );
    const listed = await call(c, "cairn_discover_list", { all: true });
    expect(listed.sc["sessions"]).toEqual([]); // the server's cwd config is not this project's
    const fromJournal = await call(c, "cairn_discover_suggest", { sessionId });
    expect(fromJournal.sc["stepCount"]).toBe(3);

    const out = join(p.dir, "flows", "_drafts", "dashboard.yml");
    const exported = await call(c, "cairn_discover_export", {
      sessionId,
      path: out,
      intent: "A signed-in user reaches the dashboard",
      outcomes: [
        {
          id: "on_dashboard",
          description: "on the dashboard",
          verify: { url: { endsWith: "/dashboard" } },
        },
      ],
    });
    expect(exported.isError).toBe(false);
    expect(exported.sc).toMatchObject({
      verifyOk: true,
      sessionId,
      stepCount: 4,
    });
    const spec = parseYaml(await readFile(out, "utf8"));
    expect(spec.imports).toEqual(["../../actions/sign_in.yml"]);
    expect(spec.steps).toEqual([
      { use: "sign_in" },
      { open: "/dashboard" },
      { wait: { url: { includes: "/dashboard" } } },
      { eval: { js: "return 1" } },
    ]);

    const resumed = await call(c, "cairn_discover_resume", { sessionId });
    expect(resumed.isError).toBe(false);
    expect(resumed.sc).toMatchObject({ sessionId, replayed: 3 });
    expect(
      (await call(c, "cairn_discover_list", {})).sc["sessions"],
    ).toHaveLength(1);
    expect(
      (await call(c, "cairn_discover_resume", { sessionId })).text,
    ).toContain("is open");
    await call(c, "cairn_discover_close", { sessionId });
    await c.close();
  });

  it("explains a missing url/setup and an unknown session", async () => {
    const c = await connect();
    expect(
      (await call(c, "cairn_discover_open", { mock: true })).text,
    ).toContain("pass url, setup, or resume");
    expect(
      (
        await call(c, "cairn_discover_network", {
          sessionId: "no-such-session",
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call(c, "cairn_discover_resume", { sessionId: "no-such-session" }))
        .isError,
    ).toBe(true);
    await c.close();
  });

  it("accompany open/choose/close report the journal and draft", async () => {
    const p = await project();
    const specPath = join(p.dir, "go.yml");
    await writeFile(
      specPath,
      `version: 1
name: go
intent: press go
coldStart: guest
outcomes:
  - id: clean
    description: clean console
    verify: { console: { errorsMax: 0 } }
steps:
  - id: go
    click: { by: role, role: button, name: Go }
`,
    );
    const c = await connect();
    const opened = await call(c, "cairn_accompany_open", {
      path: specPath,
      mock: true,
      config: p.config,
    });
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.sc["journal"]).toBe(
      join(p.root, "_sessions", opened.sc["sessionId"] as string),
    );
    await call(c, "cairn_accompany_close", {
      sessionId: opened.sc["sessionId"],
    });
    await c.close();
  });
});
