import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocsResultSchema } from "../core/schema/docs.v1";
import { ExplainResultSchema } from "../core/schema/explain.v1";
import { buildMcpServer } from "./server";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-mcp-test-"));
});

afterAll(async () => {
  // best-effort; tmp is fine to leak
});

async function connectInMemory(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

describe("Cairntrace MCP server", () => {
  it("removes its signal listeners when the server closes (no listener leak)", async () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const server = buildMcpServer();
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverSide), c.connect(client)]);
    // While live, the server has registered exactly one handler per signal.
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    await c.close();
    await new Promise((r) => setTimeout(r, 0));
    // Closing disposes them — listeners return to baseline (so building many
    // servers in one process can't exceed Node's MaxListeners limit).
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("lists the expected tool surface", async () => {
    const c = await connectInMemory();
    const list = await c.listTools();
    const names = list.tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      "cairn_annotate",
      "cairn_audit",
      "cairn_checkpoint_delete",
      "cairn_checkpoint_list",
      "cairn_checkpoint_show",
      "cairn_clip",
      "cairn_config_validate",
      "cairn_context",
      "cairn_discover_close",
      "cairn_discover_export",
      "cairn_discover_interact",
      "cairn_discover_inventory",
      "cairn_discover_list",
      "cairn_discover_navigate",
      "cairn_discover_open",
      "cairn_discover_snapshot",
      "cairn_discover_suggest",
      "cairn_docs",
      "cairn_doctor",
      "cairn_explain",
      "cairn_investigate",
      "cairn_run",
      "cairn_secrets_status",
      "cairn_services_status",
      "cairn_spec_heal",
      "cairn_spec_scaffold",
      "cairn_spec_verify",
      "cairn_stash_list",
      "cairn_stash_save",
      "cairn_stash_search",
    ]);
    await c.close();
  });

  it("cairn_explain returns the v1 ExplainResult shape (parity with `cairn explain --json`)", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_explain", arguments: {} });
    const structured = ExplainResultSchema.parse(r.structuredContent);
    const verifiers = structured.verifiers;
    const ids = verifiers.map((v) => v.id);
    expect(ids).toContain("text");
    expect(ids).toContain("script");
    expect(structured.steps.map((s) => s.id)).toContain("hover");
    // Video capture policy should be visible to agents on first contact
    expect(structured.config.capture?.video?.default).toBe("never");
    expect(structured.config.capture?.video?.slowMo).toBeTruthy();
    expect(structured.config.capture?.trace?.default).toBe("on-failure");
    await c.close();
  });

  it("cairn_docs returns focused docs for a topic", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "downloads" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("downloads");
    expect(structured.sections.length).toBeGreaterThan(0);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Download Capture"),
    });
    await c.close();
  });

  it("cairn_docs artifacts topic includes video and slowMo guidance", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "artifacts" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("artifacts");
    const content = r.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("video");
    expect(text).toContain("slowMo");
    expect(text).toContain("vidtrace");
    await c.close();
  });

  it("cairn_docs backends topic mentions video recording for Playwright", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "backends" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("backends");
    const content = r.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("video");
    await c.close();
  });

  it("cairn_run with mock=true returns a RunResult", async () => {
    const specPath = join(dir, "demo.yml");
    await writeFile(
      specPath,
      `version: 1
name: mcp_demo
intent: smoke test from MCP
outcomes:
  - id: ok
    description: console clean
    verify:
      console: { errorsMax: 0 }
steps:
  - id: nav
    open: /
`,
    );

    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_run",
      arguments: {
        path: specPath,
        mock: true,
        artifactRoot: join(dir, "runs"),
      },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      $schema: "urn:cairntrace.dev:run:v1",
      status: "passed",
      backend: "mock",
    });
    await c.close();
  });

  it("cairn_spec_verify resolves config vars before validation", async () => {
    const configPath = join(dir, "mcp.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      connectionPath: /connection/from-mcp
`,
    );
    const specPath = join(dir, "mcp-config-var.yml");
    await writeFile(
      specPath,
      `version: 1
name: mcp_config_var
intent: mcp verify resolves config vars
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_spec_verify",
      arguments: { path: specPath, config: configPath },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      status: "valid",
      path: specPath,
    });
    await c.close();
  });

  it("cairn_spec_scaffold writes a starter file", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_spec_scaffold",
      arguments: {
        name: "mcp_scaffold_test",
        intent: "smoke test scaffold via MCP",
        out: dir,
      },
    });
    expect(r.isError).toBeFalsy();
    const path = (r.structuredContent as { path: string }).path;
    expect(path).toMatch(/mcp_scaffold_test\.yml$/);
    await c.close();
  });

  it("cairn_explain includes stash commands in the command list", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_explain", arguments: {} });
    const structured = ExplainResultSchema.parse(r.structuredContent);
    const commandNames = structured.commands.map((cmd) => cmd.name);
    expect(commandNames).toContain("stash save");
    expect(commandNames).toContain("stash list");
    expect(commandNames).toContain("stash search");
    await c.close();
  });

  it("cairn_docs stash topic includes fcheap and auto-stash guidance", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "stash" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("stash");
    expect(structured.sections.length).toBeGreaterThan(0);
    const content = r.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("fcheap");
    expect(text).toContain("auto-stash");
    expect(text).toContain("--stash-on-failure");
    await c.close();
  });

  it("cairn_doctor includes fcheap in health checks", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_doctor", arguments: {} });
    const checks = (r.structuredContent as { checks: Array<{ name: string }> })
      .checks;
    const names = checks.map((ch) => ch.name);
    expect(names).toContain("fcheap");
    expect(names).toContain("vecgrep");
    expect(names).toContain("vidtrace");
    await c.close();
  });

  it("cairn_explain includes investigate and audit commands", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_explain", arguments: {} });
    const structured = ExplainResultSchema.parse(r.structuredContent);
    const commandNames = structured.commands.map((cmd) => cmd.name);
    expect(commandNames).toContain("investigate");
    expect(commandNames).toContain("audit");
    await c.close();
  });

  it("cairn_docs investigate topic includes fcheap connect and vecgrep", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "investigate" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("investigate");
    expect(structured.sections.length).toBeGreaterThan(0);
    const content = r.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("fcheap connect");
    expect(text).toContain("vecgrep");
    expect(text).toContain("vidtrace");
    expect(text).toContain("agent_context");
    await c.close();
  });

  it("cairn_explain includes annotate and secrets commands", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_explain", arguments: {} });
    const structured = ExplainResultSchema.parse(r.structuredContent);
    const commandNames = structured.commands.map((cmd) => cmd.name);
    expect(commandNames).toContain("annotate");
    expect(commandNames).toContain("secrets");
    await c.close();
  });

  it("cairn_docs annotate topic includes codemap", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_docs",
      arguments: { topic: "annotate" },
    });
    const structured = DocsResultSchema.parse(r.structuredContent);
    expect(structured.topic).toBe("annotate");
    const content = r.content as Array<{ type: string; text: string }>;
    const text = content[0]?.text ?? "";
    expect(text).toContain("codemap");
    await c.close();
  });

  it("cairn_doctor includes codemap and tvault in health checks", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_doctor", arguments: {} });
    const checks = (r.structuredContent as { checks: Array<{ name: string }> })
      .checks;
    const names = checks.map((ch) => ch.name);
    expect(names).toContain("codemap");
    expect(names).toContain("tvault");
    await c.close();
  });

  it("cairn_config_validate validates a config file", async () => {
    const c = await connectInMemory();
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      "version: 1\nproject: test\ndefaultEnvironment: local\nenvironments:\n  local:\n    baseUrl: http://localhost:8080\nservices:\n  tmux:\n    session: test\n    windows:\n      - name: web\n        command: yarn start\n",
    );
    const r = await c.callTool({
      name: "cairn_config_validate",
      arguments: { config: configPath },
    });
    const sc = r.structuredContent as { ok: boolean; errors: string[] };
    expect(sc.ok).toBe(true);
    expect(sc.errors).toEqual([]);
    await c.close();
  });

  it("cairn_config_validate reports errors for invalid config", async () => {
    const c = await connectInMemory();
    const configPath = join(dir, "bad.config.yml");
    await writeFile(
      configPath,
      "version: 1\nenvironments:\n  local:\n    baseUrl: http://localhost:8080\nservices:\n  tmux:\n    session: test\n    windows:\n      - name: web\n        command: yarn start\n      - name: web\n        command: yarn start2\n",
    );
    const r = await c.callTool({
      name: "cairn_config_validate",
      arguments: { config: configPath },
    });
    const sc = r.structuredContent as { ok: boolean; errors: string[] };
    expect(sc.ok).toBe(false);
    expect(sc.errors.length).toBeGreaterThan(0);
    expect(r.isError).toBe(true);
    await c.close();
  });

  it("cairn_services_status returns a status result", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_services_status",
      arguments: {},
    });
    const sc = r.structuredContent as {
      hasServices: boolean;
      project: string;
      docker: { configured: boolean; running: boolean };
      seed: { configured: boolean; expired: boolean };
      tmux: { configured: boolean; sessionExists: boolean; windows: unknown[] };
      errors: string[];
    };
    expect(sc).toHaveProperty("hasServices");
    expect(sc).toHaveProperty("docker");
    expect(sc).toHaveProperty("seed");
    expect(sc).toHaveProperty("tmux");
    expect(Array.isArray(sc.errors)).toBe(true);
    await c.close();
  });
});

describe("Cairntrace MCP discovery tools", () => {
  it("cairn_discover_open with mock=true creates a session and returns snapshot", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.sessionId).toBeTruthy();
    expect(sc.url).toBe("/login");
    expect(Array.isArray(sc.snapshot)).toBe(true);
    await c.close();
  });

  it("cairn_discover_open → interact → snapshot → close lifecycle", async () => {
    const c = await connectInMemory();

    // 1. Open
    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    expect(openResult.isError).toBeFalsy();
    const openSc = openResult.structuredContent as Record<string, unknown>;
    const sessionId = openSc.sessionId as string;

    // 2. Interact — fill a textbox
    const fillResult = await c.callTool({
      name: "cairn_discover_interact",
      arguments: {
        sessionId,
        action: "fill",
        target: { by: "selector", selector: "#email" },
        value: "test@test.com",
      },
    });
    expect(fillResult.isError).toBeFalsy();
    const fillSc = fillResult.structuredContent as Record<string, unknown>;
    expect(fillSc.ok).toBe(true);
    expect(fillSc.recordedStep).toEqual({
      fill: { by: "selector", selector: "#email", value: "test@test.com" },
    });

    // 3. Snapshot
    const snapResult = await c.callTool({
      name: "cairn_discover_snapshot",
      arguments: { sessionId },
    });
    expect(snapResult.isError).toBeFalsy();
    const snapSc = snapResult.structuredContent as Record<string, unknown>;
    expect(Array.isArray(snapSc.snapshot)).toBe(true);
    expect(typeof snapSc.url).toBe("string");

    // 4. List sessions
    const listResult = await c.callTool({
      name: "cairn_discover_list",
      arguments: {},
    });
    expect(listResult.isError).toBeFalsy();
    const listSc = listResult.structuredContent as Record<string, unknown>;
    const sessions = listSc.sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionId).toBe(sessionId);
    expect(sessions[0]!.stepCount).toBe(2); // open + fill

    // 5. Close
    const closeResult = await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    expect(closeResult.isError).toBeFalsy();

    // 6. Verify session is gone
    const listAfter = await c.callTool({
      name: "cairn_discover_list",
      arguments: {},
    });
    const listAfterSc = listAfter.structuredContent as Record<string, unknown>;
    expect((listAfterSc.sessions as Array<unknown>).length).toBe(0);

    await c.close();
  });

  it("cairn_discover_interact returns error for non-existent session", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_discover_interact",
      arguments: {
        sessionId: "nonexistent",
        action: "click",
        target: { by: "selector", selector: "#btn" },
      },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it("cairn_discover_suggest returns recorded steps as YAML", async () => {
    const c = await connectInMemory();

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/page", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    await c.callTool({
      name: "cairn_discover_interact",
      arguments: {
        sessionId,
        action: "click",
        target: { by: "selector", selector: "#button" },
      },
    });

    const suggestResult = await c.callTool({
      name: "cairn_discover_suggest",
      arguments: { sessionId },
    });
    expect(suggestResult.isError).toBeFalsy();
    const sc = suggestResult.structuredContent as Record<string, unknown>;
    expect(sc.stepCount).toBe(2); // open + click
    const steps = sc.steps as Array<Record<string, unknown>>;
    expect(steps[0]).toEqual({ open: "/page" });
    expect(steps[1]).toEqual({
      click: { by: "selector", selector: "#button" },
    });

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    await c.close();
  });

  it("cairn_discover_export writes a spec YAML and verifies it", async () => {
    const c = await connectInMemory();
    const specPath = join(dir, "discovered-spec.yml");

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    await c.callTool({
      name: "cairn_discover_interact",
      arguments: {
        sessionId,
        action: "click",
        target: { by: "selector", selector: "#submit" },
      },
    });

    const exportResult = await c.callTool({
      name: "cairn_discover_export",
      arguments: {
        sessionId,
        path: specPath,
        intent: "User can submit the login form",
        outcomes: [
          {
            id: "page_loads",
            description: "Page loads",
            verify: { text: { contains: "Welcome" } },
          },
        ],
      },
    });
    expect(exportResult.isError).toBeFalsy();
    const sc = exportResult.structuredContent as Record<string, unknown>;
    expect(sc.path).toBe(specPath);
    expect(sc.verifyOk).toBe(true);
    expect(sc.stepCount).toBe(2); // open + click

    // Verify the file was written
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(specPath, "utf8");
    expect(content).toContain("version: 1");
    expect(content).toContain("name: discovered_spec");
    expect(content).toContain("open: /login");
    expect(content).toContain("click");
    expect(content).toContain("page_loads");

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    await c.close();
  });

  it("cairn_discover_navigate records a new open step", async () => {
    const c = await connectInMemory();

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    const navResult = await c.callTool({
      name: "cairn_discover_navigate",
      arguments: { sessionId, url: "/dashboard" },
    });
    expect(navResult.isError).toBeFalsy();
    const navSc = navResult.structuredContent as Record<string, unknown>;
    expect(navSc.ok).toBe(true);
    expect(navSc.url).toBe("/dashboard");

    // Verify two steps recorded
    const suggestResult = await c.callTool({
      name: "cairn_discover_suggest",
      arguments: { sessionId },
    });
    const sc = suggestResult.structuredContent as Record<string, unknown>;
    expect(sc.stepCount).toBe(2); // open /login + open /dashboard

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    await c.close();
  });

  it("cairn_discover_close on non-existent session returns error", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId: "nonexistent" },
    });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it("cairn_discover_inventory returns role locators from the page", async () => {
    const c = await connectInMemory();

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    const invResult = await c.callTool({
      name: "cairn_discover_inventory",
      arguments: { sessionId, roles: true, testids: false },
    });
    expect(invResult.isError).toBeFalsy();
    const invSc = invResult.structuredContent as Record<string, unknown>;
    expect(Array.isArray(invSc.roles)).toBe(true);

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    await c.close();
  });

  it("cairn_discover_interact with scroll action", async () => {
    const c = await connectInMemory();

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/long-page", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    const scrollResult = await c.callTool({
      name: "cairn_discover_interact",
      arguments: {
        sessionId,
        action: "scroll",
        scrollDirection: "down",
        scrollPixels: 300,
      },
    });
    expect(scrollResult.isError).toBeFalsy();
    const scrollSc = scrollResult.structuredContent as Record<string, unknown>;
    expect(scrollSc.ok).toBe(true);
    expect(scrollSc.recordedStep).toEqual({
      scroll: { direction: "down", px: 300 },
    });

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    await c.close();
  });

  it("cairn_discover_export with invalid verifier fails validation", async () => {
    const c = await connectInMemory();
    const specPath = join(dir, "bad-discovered-spec.yml");

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    const exportResult = await c.callTool({
      name: "cairn_discover_export",
      arguments: {
        sessionId,
        path: specPath,
        intent: "Bad spec",
        outcomes: [
          {
            id: "bad_outcome",
            description: "Invalid verifier",
            verify: { bogus: { foo: 1 } },
          },
        ],
      },
    });
    // The VerifierSchema should reject { bogus: { foo: 1 } }
    expect(exportResult.isError).toBe(true);

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
    await c.close();
  });
});
