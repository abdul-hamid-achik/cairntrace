import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile as readTextFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditResultSchema } from "../core/schema/audit.v1";
import { DocsResultSchema } from "../core/schema/docs.v1";
import { ExplainResultSchema } from "../core/schema/explain.v1";
import { HealResultSchema } from "../core/schema/heal.v1";
import { InvestigateResultSchema } from "../core/schema/investigate.v1";
import {
  ConfigValidateResultSchema,
  DiscoveryActionResultSchema,
  DiscoveryOpenResultSchema,
  DiscoverySnapshotResultSchema,
  ServicesStatusResultSchema,
  StashInfoResultSchema,
  StashRestoreResultSchema,
  StashToolErrorSchema,
} from "../core/schema/mcp.v1";
import {
  buildRunNextActions,
  RunResultSchema,
  type RunResult,
} from "../core/schema/run.v1";
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
      "cairn_checkpoint_capture",
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
      "cairn_export_playwright",
      "cairn_investigate",
      "cairn_run",
      "cairn_secrets_status",
      "cairn_services_status",
      "cairn_snapshot",
      "cairn_spec_heal",
      "cairn_spec_scaffold",
      "cairn_spec_verify",
      "cairn_stash_info",
      "cairn_stash_list",
      "cairn_stash_restore",
      "cairn_stash_save",
      "cairn_stash_search",
    ]);
    const investigateSchema = list.tools.find(
      (tool) => tool.name === "cairn_investigate",
    )?.inputSchema;
    expect(investigateSchema).toMatchObject({
      required: ["runId"],
      properties: {
        codebase: { type: "string" },
        connect: { type: "boolean" },
        clips: { type: "boolean" },
        query: { type: "string" },
        mode: { type: "string" },
        limit: { type: "integer" },
        index: { type: "boolean" },
        config: { type: "string" },
        artifactRoot: { type: "string" },
      },
    });
    expect(
      list.tools.find((tool) => tool.name === "cairn_audit")?.inputSchema,
    ).toMatchObject({
      required: ["specPath"],
      properties: {
        codebase: { type: "string" },
        connect: { type: "boolean" },
        speed: { type: "number" },
        slowMo: { type: "number" },
        mode: { type: "string" },
        limit: { type: "integer" },
        index: { type: "boolean" },
        coldStart: { type: "boolean" },
      },
    });
    expect(
      list.tools.find((tool) => tool.name === "cairn_stash_info")?.outputSchema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "schemaVersion",
        "id",
        "createdAt",
        "fileCount",
        "sizeBytes",
        "contentHash",
      ]),
    });
    expect(
      list.tools.find((tool) => tool.name === "cairn_stash_restore")
        ?.outputSchema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "stashId",
        "restoredTo",
        "fileCount",
        "verified",
        "mismatches",
        "status",
      ]),
    });
    expect(
      list.tools.find((tool) => tool.name === "cairn_investigate")
        ?.outputSchema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining([
        "version",
        "runId",
        "runDir",
        "codeMatches",
      ]),
      properties: {
        version: { const: "1" },
        codeMatches: { type: "array" },
      },
    });
    expect(
      list.tools.find((tool) => tool.name === "cairn_audit")?.outputSchema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["version", "specPath", "codeMatches"]),
      properties: {
        version: { const: "1" },
        codeMatches: { type: "array" },
      },
    });
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
    // Contract (SPEC §7.1): structuredContent must validate against the v1
    // RunResult schema (no blind cast), and carry the additive nextActions
    // array — read from the parsed, typed value, not an inline cast.
    const runSc = RunResultSchema.parse(r.structuredContent);
    expect(Array.isArray(runSc.nextActions)).toBe(true);
    await c.close();
  });

  it("cairn_run scopes TinyVault values without mutating process.env", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cairntrace-mcp-tvault-"));
    const bin = join(fixture, "bin");
    const calls = join(fixture, "tvault-calls.txt");
    await mkdir(bin);
    const fakeTvault = join(bin, "tvault");
    await writeFile(
      fakeTvault,
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'tvault test'; exit 0; fi\n" +
        'printf \'%s\\n\' "$*" >> "$TVAULT_CALLS"\n' +
        "printf '%s\\n' '{\"MCP_SCOPED_SECRET\":\"mcp-secret-value\"}'\n",
    );
    await chmod(fakeTvault, 0o755);
    const configPath = join(fixture, "cairntrace.config.yml");
    const specPath = join(fixture, "mcp-tvault.yml");
    await writeFile(
      configPath,
      "version: 1\ndefaultEnvironment: local\nenvironments: { local: {} }\nsecrets:\n  provider: tvault\n  tvault: { project: mcp-project, identity: mcp-reader }\n",
    );
    await writeFile(
      specPath,
      "version: 1\nname: mcp_tvault_scope\nintent: MCP run has a scoped secret.\noutcomes:\n  - id: clean\n    description: Mock console remains clean.\n    verify: { console: { errorsMax: 0 } }\nsteps:\n  - open: 'data:text/html,${env.MCP_SCOPED_SECRET}'\n",
    );
    const previousPath = process.env.PATH;
    const previousCalls = process.env.TVAULT_CALLS;
    delete process.env.MCP_SCOPED_SECRET;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.TVAULT_CALLS = calls;
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_run",
        arguments: {
          path: specPath,
          mock: true,
          artifactRoot: join(fixture, "runs"),
        },
      });
      expect(result.isError).toBeFalsy();
      expect(process.env.MCP_SCOPED_SECRET).toBeUndefined();
      expect(await readTextFile(calls, "utf8")).toContain(
        "--identity mcp-reader",
      );
      expect(await readTextFile(calls, "utf8")).toContain(
        "--only MCP_SCOPED_SECRET",
      );
      const run = RunResultSchema.parse(result.structuredContent);
      const resolved = await readTextFile(
        join(run.runDir, "spec.resolved.yml"),
        "utf8",
      );
      expect(resolved).toContain("[redacted]");
      expect(resolved).not.toContain("mcp-secret-value");
    } finally {
      await c.close();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCalls === undefined) delete process.env.TVAULT_CALLS;
      else process.env.TVAULT_CALLS = previousCalls;
      await rm(fixture, { recursive: true, force: true });
    }
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

  it("cairn_stash_save maps canonical file.cheap id and resolves latest", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-fcheap-contract-"),
    );
    const runsRoot = join(fixtureRoot, "runs");
    const runId = "checkout-2026-07-23T130000Z";
    const runDir = join(runsRoot, runId);
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(runDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });

    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap test'
  exit 0
fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"mcp-stash-20260723","schema_version":"1.0","status":"saved"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_stash_save",
        arguments: { runId: "latest", artifactRoot: runsRoot },
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        runId,
        stashId: "mcp-stash-20260723",
        runDir,
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain(`Stashed run ${runId}`);
    } finally {
      await c.close();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("cairn_stash_save preserves a saved_with_failures receipt as a structured MCP error", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-fcheap-partial-save-"),
    );
    const runsRoot = join(fixtureRoot, "runs");
    const runId = "audit-2026-07-24T010203Z";
    const runDir = join(runsRoot, runId);
    const fakeFcheap = join(fixtureRoot, "fcheap");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap 0.30.0'
  exit 0
fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"mcp-stash-partial","status":"saved_with_failures","failed":[{"id":"mcp-stash-partial","stage":"index","error":"vecgrep unavailable"}]}'
  printf '%s\\n' 'stash saved with 1 failed post-save operation' >&2
  exit 2
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const previousBinary = process.env.FCHEAP_BIN;
    process.env.FCHEAP_BIN = fakeFcheap;
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_stash_save",
        arguments: { runId: "latest", artifactRoot: runsRoot },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        runId,
        runDir,
        stashId: "mcp-stash-partial",
        status: "saved_with_failures",
        failures: [
          {
            id: "mcp-stash-partial",
            stage: "index",
            error: "vecgrep unavailable",
          },
        ],
        warning: expect.stringContaining("failed post-save operation"),
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("mcp-stash-partial");
      expect(content[0]?.text).toContain("post-save failures");
    } finally {
      await c.close();
      if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
      else process.env.FCHEAP_BIN = previousBinary;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("cairn_stash_save rejects a successful response without an id", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-fcheap-invalid-receipt-"),
    );
    const runsRoot = join(fixtureRoot, "runs");
    const runDir = join(runsRoot, "checkout-2026-07-23T140000Z");
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(runDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });

    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap test'
  exit 0
fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"status":"saved"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_stash_save",
        arguments: { runId: "latest", artifactRoot: runsRoot },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toMatch(/expected a non-empty id/i);
      expect(result.structuredContent).toMatchObject({
        runDir,
        tags: [],
        error: expect.stringContaining("expected a non-empty id"),
      });
    } finally {
      await c.close();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("normalizes file.cheap v0.30 list and search responses", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-fcheap-read-contract-"),
    );
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(fakeBin, { recursive: true });

    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap 0.30.0'
  exit 0
fi
if [ "$1" = "list" ]; then
  printf '%s\\n' '[{"id":"stash-list","tool":"cairntrace","tags":["failed"],"file_count":3,"total_size":4096,"created_at":"2026-07-24T03:01:59Z"}]'
  exit 0
fi
if [ "$1" = "search" ]; then
  printf '%s\\n' '[{"stash_id":"stash-list","score":0.91,"text":"checkout redirect failed","file":"outcomes/redirect.md"}]'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const c = await connectInMemory();
    try {
      const listResult = await c.callTool({
        name: "cairn_stash_list",
        arguments: {},
      });
      expect(listResult.isError).toBeFalsy();
      expect(listResult.structuredContent).toEqual({
        stashes: [
          {
            id: "stash-list",
            tool: "cairntrace",
            tags: ["failed"],
            fileCount: 3,
            sizeBytes: 4096,
            createdAt: "2026-07-24T03:01:59Z",
          },
        ],
      });
      expect(
        (listResult.content as Array<{ text: string }>)[0]?.text,
      ).not.toContain("undefined");

      const searchResult = await c.callTool({
        name: "cairn_stash_search",
        arguments: { query: "redirect" },
      });
      expect(searchResult.isError).toBeFalsy();
      expect(searchResult.structuredContent).toEqual({
        query: "redirect",
        results: [
          {
            stashId: "stash-list",
            snippet: "checkout redirect failed",
            score: 0.91,
            file: "outcomes/redirect.md",
          },
        ],
      });
      expect(
        (searchResult.content as Array<{ text: string }>)[0]?.text,
      ).toContain("stash-list (0.91): checkout redirect failed");
    } finally {
      await c.close();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("exposes validated file.cheap v0.30 info and restore receipts", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-fcheap-info-restore-"),
    );
    const fakeFcheap = join(fixtureRoot, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "info" ]; then
  printf '%s\\n' '{"schema_version":"1.0","id":"stash-detail","created_at":"2026-07-24T04:05:06Z","source_path":"/private/run","tool":"cairntrace","tags":["failed"],"file_count":2,"total_size":2048,"content_hash":"abc123","files":[{"path":"run.json","size":512,"hash":"def456"}],"custom":{"source":"local-run"}}'
  exit 0
fi
if [ "$1" = "restore" ]; then
  printf '%s\\n' '{"stash_id":"stash-detail","target":"/tmp/restored-stash-detail","file_count":2,"verified":true,"mismatches":[],"status":"restored"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const previousBinary = process.env.FCHEAP_BIN;
    process.env.FCHEAP_BIN = fakeFcheap;
    const c = await connectInMemory();
    try {
      const infoResult = await c.callTool({
        name: "cairn_stash_info",
        arguments: { stashId: "stash-detail" },
      });
      expect(infoResult.isError).toBeFalsy();
      expect(
        StashInfoResultSchema.parse(infoResult.structuredContent),
      ).toMatchObject({
        schemaVersion: "1.0",
        id: "stash-detail",
        sourcePath: "/private/run",
        source: "local-run",
        tool: "cairntrace",
        tags: ["failed"],
        fileCount: 2,
        sizeBytes: 2048,
        contentHash: "abc123",
        files: [{ path: "run.json", size: 512, hash: "def456" }],
      });

      const restoreResult = await c.callTool({
        name: "cairn_stash_restore",
        arguments: { stashId: "stash-detail", to: "/tmp/restored-stash" },
      });
      expect(restoreResult.isError).toBeFalsy();
      expect(
        StashRestoreResultSchema.parse(restoreResult.structuredContent),
      ).toEqual({
        stashId: "stash-detail",
        restoredTo: "/tmp/restored-stash-detail",
        fileCount: 2,
        verified: true,
        mismatches: [],
        status: "restored",
      });
    } finally {
      await c.close();
      if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
      else process.env.FCHEAP_BIN = previousBinary;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("returns structured errors for invalid info and unverified restores", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-fcheap-errors-"),
    );
    const fakeFcheap = join(fixtureRoot, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "info" ]; then
  printf '%s\\n' '{"id":"missing-required-manifest-fields"}'
  exit 0
fi
if [ "$1" = "restore" ]; then
  printf '%s\\n' '{"stash_id":"stash-mismatch","target":"/tmp/restored-mismatch","file_count":1,"verified":false,"mismatches":["report.json"],"status":"restored_with_mismatches"}'
  printf '%s\\n' 'restore verification failed' >&2
  exit 2
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const previousBinary = process.env.FCHEAP_BIN;
    process.env.FCHEAP_BIN = fakeFcheap;
    const c = await connectInMemory();
    try {
      const infoResult = await c.callTool({
        name: "cairn_stash_info",
        arguments: { stashId: "stash-invalid" },
      });
      expect(infoResult.isError).toBe(true);
      expect(
        StashToolErrorSchema.parse(infoResult.structuredContent),
      ).toMatchObject({
        code: "FCHEAP_INVALID_RESPONSE",
        command: "info",
        stashId: "stash-invalid",
        message: expect.stringContaining("Invalid fcheap info JSON"),
        hint: expect.stringContaining("v0.30"),
      });

      const restoreResult = await c.callTool({
        name: "cairn_stash_restore",
        arguments: { stashId: "stash-mismatch" },
      });
      expect(restoreResult.isError).toBe(true);
      expect(
        StashToolErrorSchema.parse(restoreResult.structuredContent),
      ).toEqual({
        code: "FCHEAP_RESTORE_UNVERIFIED",
        command: "restore",
        message: "Restored 1 file(s), but integrity verification failed.",
        hint: "Treat the restored directory as forensic-only; inspect `restore.mismatches` and retry from a known-good stash.",
        stashId: "stash-mismatch",
        restore: {
          stashId: "stash-mismatch",
          restoredTo: "/tmp/restored-mismatch",
          fileCount: 1,
          verified: false,
          mismatches: ["report.json"],
          status: "restored_with_mismatches",
        },
      });
      expect(
        (restoreResult.content as Array<{ text: string }>)[0]?.text,
      ).toContain("Next:");
    } finally {
      await c.close();
      if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
      else process.env.FCHEAP_BIN = previousBinary;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("makes a missing file.cheap binary actionable", async () => {
    const previousBinary = process.env.FCHEAP_BIN;
    process.env.FCHEAP_BIN = join(tmpdir(), "cairntrace-fcheap-does-not-exist");
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_stash_info",
        arguments: { stashId: "stash-missing-bin" },
      });
      expect(result.isError).toBe(true);
      expect(
        StashToolErrorSchema.parse(result.structuredContent),
      ).toMatchObject({
        code: "FCHEAP_UNAVAILABLE",
        command: "info",
        hint: expect.stringContaining("FCHEAP_BIN"),
      });
    } finally {
      await c.close();
      if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
      else process.env.FCHEAP_BIN = previousBinary;
    }
  });

  it("cairn_doctor includes browser and investigation readiness checks", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({ name: "cairn_doctor", arguments: {} });
    const checks = (r.structuredContent as { checks: Array<{ name: string }> })
      .checks;
    const names = checks.map((ch) => ch.name);
    expect(names).toContain("fcheap");
    expect(names).toContain("vecgrep");
    expect(names).toContain("vidtrace");
    expect(names).toContain("monitor");
    expect(names).toContain("ffmpeg");
    expect(names).toContain("playwright-package");
    expect(names).toContain("playwright-chromium");
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

  it("cairn_investigate returns structuredContent when latest has no run", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-investigate-missing-run-"),
    );
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_investigate",
        arguments: { runId: "latest", artifactRoot: fixtureRoot },
      });

      expect(result.isError).toBe(true);
      const structured = InvestigateResultSchema.parse(
        result.structuredContent,
      );
      expect(structured).toMatchObject({
        $schema: "urn:cairntrace.dev:investigate:v1",
        version: "1",
        runId: "latest",
        runDir: "",
        codeMatches: [],
        error: expect.stringContaining("no run available at slot latest"),
      });
      const cli = await execa(
        join(process.cwd(), "bin", "cairn"),
        ["investigate", "latest", "--artifact-root", fixtureRoot, "--json"],
        { reject: false },
      );
      expect(cli.exitCode).toBe(2);
      expect(structured).toEqual(JSON.parse(cli.stdout));
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("no run available at slot latest");
    } finally {
      await c.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("cairn_audit maps setup errors to structured MCP errors", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-mcp-audit-missing-spec-"),
    );
    const missingSpec = join(fixtureRoot, "missing-spec.yml");
    const c = await connectInMemory();
    try {
      const result = await c.callTool({
        name: "cairn_audit",
        arguments: {
          specPath: missingSpec,
          artifactRoot: join(fixtureRoot, "runs"),
        },
      });

      expect(result.isError).toBe(true);
      const structured = AuditResultSchema.parse(result.structuredContent);
      expect(structured).toMatchObject({
        $schema: "urn:cairntrace.dev:audit:v1",
        version: "1",
        specPath: missingSpec,
        codeMatches: [],
        error: expect.stringContaining("no such file or directory"),
      });
      const cli = await execa(
        join(process.cwd(), "bin", "cairn"),
        [
          "audit",
          missingSpec,
          "--artifact-root",
          join(fixtureRoot, "runs"),
          "--json",
        ],
        { reject: false },
      );
      expect(cli.exitCode).toBe(2);
      expect(structured).toEqual(JSON.parse(cli.stdout));
    } finally {
      await c.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
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
    // Contract (SPEC §7.1): structuredContent validates against the declared schema.
    expect(
      ConfigValidateResultSchema.safeParse(r.structuredContent).success,
    ).toBe(true);
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
    // Contract (SPEC §7.1): structuredContent validates against the declared schema.
    expect(
      ServicesStatusResultSchema.safeParse(r.structuredContent).success,
    ).toBe(true);
    await c.close();
  });

  it("cairn_snapshot returns a one-shot locator inventory (mock backend)", async () => {
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_snapshot",
      arguments: { url: "http://localhost/login", mock: true },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as {
      url: string;
      backend: string;
      roles?: unknown[];
    };
    expect(sc.backend).toBe("mock");
    expect(sc.url).toBeTruthy();
    expect(Array.isArray(sc.roles)).toBe(true);
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
    // Contract (SPEC §7.1): structuredContent validates against the declared schema.
    expect(
      DiscoveryOpenResultSchema.safeParse(r.structuredContent).success,
    ).toBe(true);
    await c.close();
  });

  it("cairn_checkpoint_capture refuses a mock session and a missing session", async () => {
    const c = await connectInMemory();

    // A mock session can't produce a resumable checkpoint.
    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    const mockCapture = await c.callTool({
      name: "cairn_checkpoint_capture",
      arguments: { sessionId, name: "auth" },
    });
    expect(mockCapture.isError).toBe(true);
    const mockContent = mockCapture.content as Array<{
      type: string;
      text: string;
    }>;
    expect(mockContent[0]?.text).toContain("real browser session");

    // A non-existent session is rejected.
    const missing = await c.callTool({
      name: "cairn_checkpoint_capture",
      arguments: { sessionId: "nonexistent", name: "auth" },
    });
    expect(missing.isError).toBe(true);

    await c.callTool({
      name: "cairn_discover_close",
      arguments: { sessionId },
    });
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
    // Contract (SPEC §7.1): each discovery structuredContent validates against
    // its declared schema (no blind cast).
    expect(
      DiscoveryOpenResultSchema.safeParse(openResult.structuredContent).success,
    ).toBe(true);
    expect(
      DiscoveryActionResultSchema.safeParse(fillResult.structuredContent)
        .success,
    ).toBe(true);
    expect(
      DiscoverySnapshotResultSchema.safeParse(snapResult.structuredContent)
        .success,
    ).toBe(true);

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

  it("cairn_discover_open enforces the session cap", async () => {
    const c = await connectInMemory();
    const sessionIds: string[] = [];

    // Open the maximum (8) sessions.
    for (let i = 0; i < 8; i++) {
      const r = await c.callTool({
        name: "cairn_discover_open",
        arguments: { url: `/page${i}`, mock: true },
      });
      expect(r.isError).toBeFalsy();
      sessionIds.push(
        (r.structuredContent as Record<string, unknown>).sessionId as string,
      );
    }

    // The 9th open is refused.
    const overflow = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/overflow", mock: true },
    });
    expect(overflow.isError).toBe(true);
    const overflowContent = overflow.content as Array<{
      type: string;
      text: string;
    }>;
    expect(overflowContent[0]?.text).toContain("too many open discovery");

    for (const sessionId of sessionIds) {
      await c.callTool({
        name: "cairn_discover_close",
        arguments: { sessionId },
      });
    }
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

    // A freshly exported spec parses but is neither stamped nor
    // cold-start-satisfied — the tool must surface both warnings so the agent
    // knows the spec isn't fully ready to run.
    const warnings = sc.warnings as string[];
    expect(warnings).toBeDefined();
    expect(warnings.some((w) => w.includes("contractHash"))).toBe(true);
    expect(warnings.some((w) => w.includes("cold-start"))).toBe(true);

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

  it("cairn_discover_export refuses to clobber a stamped spec without overwrite", async () => {
    const c = await connectInMemory();
    const specPath = join(dir, "stamped-spec.yml");

    // Simulate an established (stamped) spec already on disk.
    await writeFile(
      specPath,
      [
        "version: 1",
        "name: stamped_spec",
        "intent: locked contract",
        "contractHash: abc123",
        "outcomes:",
        "  - id: o",
        "    description: d",
        "    verify:",
        "      text:",
        "        contains: X",
        "steps: []",
        "",
      ].join("\n"),
      "utf8",
    );

    const openResult = await c.callTool({
      name: "cairn_discover_open",
      arguments: { url: "/login", mock: true },
    });
    const sessionId = (openResult.structuredContent as Record<string, unknown>)
      .sessionId as string;

    const outcomes = [
      {
        id: "page_loads",
        description: "Page loads",
        verify: { text: { contains: "Welcome" } },
      },
    ];

    // Without overwrite: refused, and the stamped file is left intact.
    const refused = await c.callTool({
      name: "cairn_discover_export",
      arguments: { sessionId, path: specPath, intent: "New intent", outcomes },
    });
    expect(refused.isError).toBe(true);
    const refusedContent = refused.content as Array<{
      type: string;
      text: string;
    }>;
    expect(refusedContent[0]?.text).toContain("overwrite");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(specPath, "utf8")).toContain("contractHash: abc123");

    // With overwrite: succeeds and replaces the stamped spec.
    const ok = await c.callTool({
      name: "cairn_discover_export",
      arguments: {
        sessionId,
        path: specPath,
        intent: "New intent",
        outcomes,
        overwrite: true,
      },
    });
    expect(ok.isError).toBeFalsy();
    const replaced = await readFile(specPath, "utf8");
    expect(replaced).toContain("intent: New intent");
    expect(replaced).not.toContain("contractHash: abc123");

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
    // SPEC §7.3: truncation honesty — total + truncated are always present.
    expect(typeof invSc.total).toBe("number");
    expect(typeof invSc.truncated).toBe("boolean");

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

describe("Cairntrace MCP contract (SPEC §7.1) — heal + nextActions", () => {
  it("cairn_spec_heal with mock=true returns a HealResult-shaped structuredContent", async () => {
    // A minimal spec with a text outcome; heal runs it against the mock
    // backend and returns a HealResult. The structuredContent must validate
    // against the declared heal.v1 schema (no blind cast).
    const specPath = join(dir, "heal-demo.yml");
    await writeFile(
      specPath,
      `version: 1
name: heal_demo
intent: heal smoke
outcomes:
  - id: ok
    description: ok
    verify: { text: { contains: "x" } }
steps:
  - open: /
`,
    );
    const c = await connectInMemory();
    const r = await c.callTool({
      name: "cairn_spec_heal",
      arguments: { path: specPath, mock: true },
    });
    expect(r.structuredContent).toBeDefined();
    expect(HealResultSchema.safeParse(r.structuredContent).success).toBe(true);
    await c.close();
  });

  it("buildRunNextActions: passed → none; failed-with-step → one non-auto action", () => {
    const specPath = join(dir, "any.yml");
    const passed: RunResult = {
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: "r1",
      runDir: dir,
      spec: { name: "s", path: specPath },
      environment: "local",
      backend: "mock",
      coldStart: false,
      status: "passed",
      startedAt: "2026-07-10T00:00:00Z",
      endedAt: "2026-07-10T00:00:00Z",
      durationMs: 1,
      outcomes: [],
      steps: [],
      artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
      exitCode: 0,
    };
    expect(buildRunNextActions(passed)).toEqual([]);

    const failed: RunResult = {
      ...passed,
      status: "failed",
      exitCode: 1,
      failure: { step: "nav", message: "element not found" },
    };
    const acts = buildRunNextActions(failed);
    // A step-level failure suggests both a rerun and a heal (locator drift).
    expect(acts).toHaveLength(2);
    expect(acts[0]!.safeToAutoRun).toBe(false);
    expect(acts[0]!.command).toContain("cairn run");
    expect(acts[0]!.reason).toContain("nav");
    expect(acts[1]!.command).toContain("cairn spec heal");
    expect(acts[1]!.safeToAutoRun).toBe(false);
  });
});
