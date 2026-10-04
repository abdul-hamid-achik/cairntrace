import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RunResultSchema } from "../core/schema/run.v1";
import { writeCjsHost } from "../testing/hostTrees";
import { buildMcpServer } from "./server";

// MCP ↔ CLI parity for the authoring loop: the MCP tools must resolve config
// and validate specs exactly like their CLI counterparts.

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-mcp-parity-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  configPath = join(dir, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
environments:
  local:
    baseUrl: http://localhost:8787
    vars: { landing: /home }
secrets:
  provider: env
  required: [DECLARED_SECRET]
browser:
  testIdAttribute: data-qa
`,
  );
});

async function connect(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), c.connect(client)]);
  return c;
}

function text(r: unknown): string {
  return ((r as { content?: unknown }).content as Array<{ text?: string }>)
    .map((p) => p.text ?? "")
    .join("\n");
}

const SPEC_WITH_BAD_REFS = `version: 1
name: bad_refs
intent: reference audit parity
coldStart: guest
preconditions:
  commands:
    - run: "echo \${env.PARITY_NOT_SUPPLIED_REF} \${secrets.UNDECLARED}"
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.landing}"
`;

describe("cairn_spec_verify parity with `cairn spec verify`", () => {
  it("runs the placeholder reference audit (invalid, exit 4)", async () => {
    const specPath = join(dir, "flows", "bad-refs.yml");
    await writeFile(specPath, SPEC_WITH_BAD_REFS);
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_spec_verify",
        arguments: { path: specPath },
      });
      expect(r.isError).toBe(true);
      const sc = r.structuredContent as {
        status: string;
        referenceFindings: number;
        errors: string[];
        exitCode: number;
      };
      expect(sc.status).toBe("invalid");
      expect(sc.exitCode).toBe(4);
      expect(sc.referenceFindings).toBe(2);
      expect(
        sc.errors.some((e) => e.includes("${env.PARITY_NOT_SUPPLIED_REF}")),
      ).toBe(true);
      expect(sc.errors.some((e) => e.includes("${secrets.UNDECLARED}"))).toBe(
        true,
      );
    } finally {
      await c.close();
    }
  });

  it("accepts var overrides and reports a clean spec as valid", async () => {
    const specPath = join(dir, "flows", "clean.yml");
    await writeFile(
      specPath,
      SPEC_WITH_BAD_REFS.replace(
        '"echo ${env.PARITY_NOT_SUPPLIED_REF} ${secrets.UNDECLARED}"',
        '"echo ${secrets.DECLARED_SECRET} ${vars.extra}"',
      ),
    );
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_spec_verify",
        arguments: { path: specPath, var: ["extra=1"] },
      });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({
        status: "valid",
        referenceFindings: 0,
        coldStartSatisfied: true,
        exitCode: 0,
      });
    } finally {
      await c.close();
    }
  });

  it("fails an unknown env with exit 4", async () => {
    const specPath = join(dir, "flows", "env.yml");
    await writeFile(
      specPath,
      SPEC_WITH_BAD_REFS.replace(
        '"echo ${env.PARITY_NOT_SUPPLIED_REF} ${secrets.UNDECLARED}"',
        '"true"',
      ),
    );
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_spec_verify",
        arguments: { path: specPath, env: "prod" },
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({ exitCode: 4 });
      expect(text(r)).toContain('unknown environment "prod"');
    } finally {
      await c.close();
    }
  });
});

describe("environment policy over MCP (same answers as the CLI)", () => {
  const POLICY_CONFIG = `version: 1
environments:
  local:
    baseUrl: http://localhost:8787
  dev:
    baseUrl: http://localhost:8788
    policy: { trait: shared, mutations: deny }
`;
  const LOCAL_ONLY = `version: 1
name: local_only
intent: only runs on local
coldStart: guest
requires: { env: [local] }
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: /home
`;

  it("cairn_spec_heal exits 7 on a spec the policy refuses", async () => {
    const policyConfig = join(dir, "policy.config.yml");
    await writeFile(policyConfig, POLICY_CONFIG);
    const specPath = join(dir, "flows", "local-only.yml");
    await writeFile(specPath, LOCAL_ONLY);
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_spec_heal",
        arguments: {
          path: specPath,
          env: "dev",
          config: policyConfig,
          mock: true,
        },
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        status: "no-heal-possible",
        error: { name: "SpecRefusedError" },
        exitCode: 7,
      });
    } finally {
      await c.close();
    }
  });

  it("cairn_spec_verify returns findings, environment and environments", async () => {
    const policyConfig = join(dir, "policy.config.yml");
    await writeFile(policyConfig, POLICY_CONFIG);
    const specPath = join(dir, "flows", "local-only.yml");
    await writeFile(specPath, LOCAL_ONLY);
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_spec_verify",
        arguments: { path: specPath, env: "dev", config: policyConfig },
      });
      expect(r.isError).toBe(true);
      const content = r.structuredContent as {
        exitCode: number;
        findings?: Array<{ kind: string; severity: string }>;
        environment?: { name: string; allowed: boolean; explicit: boolean };
        environments?: Array<{ name: string; allowed: boolean }>;
      };
      expect(content.exitCode).toBe(4);
      expect(content.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "env-not-allowed",
            severity: "error",
          }),
        ]),
      );
      expect(content.environment).toMatchObject({
        name: "dev",
        allowed: false,
        explicit: true,
      });
      expect(content.environments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "local", allowed: true }),
          expect.objectContaining({ name: "dev", allowed: false }),
        ]),
      );
    } finally {
      await c.close();
    }
  });
});

describe("cairn_spec_heal / cairn_run config inputs", () => {
  it("cairn_spec_heal refuses an unknown env before starting a browser", async () => {
    const specPath = join(dir, "flows", "heal.yml");
    await writeFile(specPath, SPEC_WITH_BAD_REFS);
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_spec_heal",
        arguments: { path: specPath, env: "prod", mock: true },
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        status: "no-heal-possible",
        exitCode: 4,
      });
    } finally {
      await c.close();
    }
  });

  it("cairn_run accepts config + var and reports an unknown env as exit 4", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "cairntrace-mcp-run-"));
    const specPath = join(elsewhere, "run.yml");
    await writeFile(
      specPath,
      `version: 1
name: run_config_var
intent: run resolves an explicit config and var overrides
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.landing}"
`,
    );
    const c = await connect();
    try {
      const ok = await c.callTool({
        name: "cairn_run",
        arguments: {
          path: specPath,
          config: configPath,
          var: ["landing=/from-var"],
          mock: true,
          artifactRoot: join(elsewhere, "runs"),
        },
      });
      expect(ok.isError).toBeFalsy();
      expect((ok.structuredContent as { status: string }).status).toBe(
        "passed",
      );

      const bad = await c.callTool({
        name: "cairn_run",
        arguments: { path: specPath, config: configPath, env: "prod" },
      });
      expect(bad.isError).toBe(true);
      const result = RunResultSchema.parse(bad.structuredContent);
      expect(result.status).toBe("errored");
      expect(result.exitCode).toBe(4);
      expect(result.failure?.message).toContain('unknown environment "prod"');
    } finally {
      await c.close();
    }
  });
});

describe("discovery honors the project config", () => {
  it("cairn_snapshot scans browser.testIdAttribute", async () => {
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_snapshot",
        arguments: { url: "/home", config: configPath, mock: true },
      });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({
        url: "http://localhost:8787/home",
        testIdAttribute: "data-qa",
      });
    } finally {
      await c.close();
    }
  });

  it("cairn_discover_open resolves baseUrl/vars from config and records testIdAttribute", async () => {
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_discover_open",
        arguments: {
          url: "${vars.landing}",
          config: configPath,
          mock: true,
        },
      });
      expect(r.isError).toBeFalsy();
      const sc = r.structuredContent as {
        sessionId: string;
        url: string;
        env: string;
        testIdAttribute: string;
      };
      expect(sc.url).toBe("http://localhost:8787/home");
      expect(sc.env).toBe("local");
      expect(sc.testIdAttribute).toBe("data-qa");

      const inv = await c.callTool({
        name: "cairn_discover_inventory",
        arguments: { sessionId: sc.sessionId, testids: true },
      });
      expect(inv.structuredContent).toMatchObject({
        testIdAttribute: "data-qa",
      });
      await c.callTool({
        name: "cairn_discover_close",
        arguments: { sessionId: sc.sessionId },
      });
    } finally {
      await c.close();
    }
  });

  it("cairn_discover_open fails loudly for a relative URL with no baseUrl on a real browser", async () => {
    const bare = await mkdtemp(join(tmpdir(), "cairntrace-mcp-bare-"));
    const bareConfig = join(bare, "cairntrace.config.yml");
    await writeFile(bareConfig, "version: 1\nenvironments:\n  local: {}\n");
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_discover_open",
        // No mock: the target is rejected before any browser is created.
        arguments: { url: "/login", config: bareConfig },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(
        /relative discover URL "\/login" requires environments\.local\.baseUrl/,
      );
    } finally {
      await c.close();
    }
  });

  it("cairn_discover_open rejects an unknown env", async () => {
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_discover_open",
        arguments: { url: "/x", config: configPath, env: "prod", mock: true },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('unknown environment "prod"');
    } finally {
      await c.close();
    }
  });
});

describe("discovery never writes resolved secrets", () => {
  const SECRET = "s3cr3t-value-for-parity";
  beforeEach(() => {
    process.env["CAIRN_PARITY_CB_TOKEN"] = SECRET;
    return () => {
      delete process.env["CAIRN_PARITY_CB_TOKEN"];
    };
  });

  it("navigates with ${secrets.X} resolved but exports and returns only the placeholder", async () => {
    const out = join(dir, "flows", "secret-open.yml");
    const c = await connect();
    try {
      const opened = await c.callTool({
        name: "cairn_discover_open",
        arguments: {
          url: "https://example.test/cb?t=${secrets.CAIRN_PARITY_CB_TOKEN}",
          config: configPath,
          mock: true,
        },
      });
      expect(opened.isError).toBeFalsy();
      const sc = opened.structuredContent as { sessionId: string; url: string };
      expect(JSON.stringify(opened)).not.toContain(SECRET);
      expect(sc.url).toBe("https://example.test/cb?t=[redacted]");

      const list = await c.callTool({
        name: "cairn_discover_list",
        arguments: {},
      });
      expect(JSON.stringify(list)).not.toContain(SECRET);

      const exported = await c.callTool({
        name: "cairn_discover_export",
        arguments: {
          sessionId: sc.sessionId,
          path: out,
          intent: "secret-bearing callback opens",
          outcomes: [
            {
              id: "ok",
              description: "ok",
              verify: { console: { errorsMax: 0 } },
            },
          ],
        },
      });
      expect(exported.isError).toBeFalsy();
      const yaml = await readFile(out, "utf8");
      expect(yaml).not.toContain(SECRET);
      expect(yaml).toContain(
        "https://example.test/cb?t=${secrets.CAIRN_PARITY_CB_TOKEN}",
      );
      await c.callTool({
        name: "cairn_discover_close",
        arguments: { sessionId: sc.sessionId },
      });
    } finally {
      await c.close();
    }
  });

  it("exports ${vars.X} and relative URLs as written and verifies them with the session inputs", async () => {
    const out = join(dir, "flows", "vars-open.yml");
    const c = await connect();
    try {
      const opened = await c.callTool({
        name: "cairn_discover_open",
        arguments: {
          url: "/items/${vars.itemId}",
          config: configPath,
          var: ["itemId=i-7"],
          mock: true,
        },
      });
      const sc = opened.structuredContent as { sessionId: string; url: string };
      expect(sc.url).toBe("http://localhost:8787/items/i-7");
      await c.callTool({
        name: "cairn_discover_navigate",
        arguments: { sessionId: sc.sessionId, url: "/settings" },
      });
      const exported = await c.callTool({
        name: "cairn_discover_export",
        arguments: {
          sessionId: sc.sessionId,
          path: out,
          intent: "templated discovery exports portably",
          outcomes: [
            {
              id: "ok",
              description: "ok",
              verify: { console: { errorsMax: 0 } },
            },
          ],
        },
      });
      expect(exported.isError).toBeFalsy();
      const esc = exported.structuredContent as {
        verifyOk: boolean;
        warnings?: string[];
      };
      expect(esc.verifyOk).toBe(true);
      expect(esc.warnings?.join("\n")).toContain("pass them with --var");
      const yaml = await readFile(out, "utf8");
      expect(yaml).toContain("/items/${vars.itemId}");
      expect(yaml).toContain("open: /settings");
      expect(yaml).not.toContain("localhost:8787");
      await c.callTool({
        name: "cairn_discover_close",
        arguments: { sessionId: sc.sessionId },
      });
    } finally {
      await c.close();
    }
  });
});

describe("cairn_export_playwright parity with `cairn export playwright`", () => {
  const UPLOAD_SPEC = `version: 1
name: upload_flow
intent: upload a document
coldStart: guest
outcomes:
  - id: done
    description: upload confirmed
    verify:
      text: { contains: Uploaded }
steps:
  - id: open_upload
    open: /upload
  - id: choose
    upload:
      by: label
      name: Choose file
      path: ../fixtures/doc.txt
`;

  it("stdout export resolves an imported action's files next to the action (F13)", async () => {
    await mkdir(join(dir, "flows", "actions"), { recursive: true });
    await mkdir(join(dir, "flows", "sub"), { recursive: true });
    await writeFile(
      join(dir, "flows", "actions", "helper.yml"),
      `version: 1
name: helper
steps:
  - eval: { file: ./helper.js }
`,
    );
    await writeFile(
      join(dir, "flows", "actions", "helper.js"),
      "window.__fromActionDir = true;",
    );
    await writeFile(
      join(dir, "flows", "sub", "uses-helper.yml"),
      `version: 1
name: uses_helper
intent: Uses an action whose file sits next to it.
coldStart: guest
imports: [../actions/helper.yml]
steps:
  - open: /home
  - use: helper
outcomes:
  - id: page
    description: page is open
    verify: { url: { matches: "/home" } }
`,
    );
    const c = await connect();
    try {
      const r = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "sub", "uses-helper.yml"),
          stdout: true,
          config: configPath,
        },
      });
      expect(r.isError, text(r)).toBeFalsy();
      const sc = r.structuredContent as {
        source: string;
        coverage: { skips: unknown[] };
      };
      expect(sc.source).toContain("__fromActionDir");
      expect(sc.coverage.skips).toEqual([]);
    } finally {
      await c.close();
    }
  });

  it("project exports copy fixtures and write .cairn-export.json like the CLI", async () => {
    await mkdir(join(dir, "fixtures"), { recursive: true });
    await writeFile(join(dir, "fixtures", "doc.txt"), "hello\n");
    await writeFile(join(dir, "flows", "upload.yml"), UPLOAD_SPEC);
    const outDir = join(dir, "pw-export");
    const c = await connect();
    const r = await c.callTool({
      name: "cairn_export_playwright",
      arguments: {
        path: join(dir, "flows"),
        project: true,
        outDir,
        config: configPath,
      },
    });
    expect(r.isError, text(r)).toBeFalsy();
    const sc = r.structuredContent as {
      status: string;
      manifest: string;
      fixturesCopied: string[];
      files: string[];
    };
    expect(sc.status).toBe("written");
    expect(sc.manifest).toBe(join(outDir, ".cairn-export.json"));
    expect(sc.fixturesCopied).toEqual(["fixtures/doc.txt"]);
    expect(await readFile(join(outDir, "fixtures", "doc.txt"), "utf8")).toBe(
      "hello\n",
    );
    const manifest = JSON.parse(await readFile(sc.manifest, "utf8")) as {
      mode: string;
      files: Array<{ path: string }>;
    };
    expect(manifest.mode).toBe("project");
    expect(manifest.files.map((f) => f.path)).toContain("fixtures/doc.txt");
    const test = await readFile(
      join(outDir, "tests", "upload_flow.spec.ts"),
      "utf8",
    );
    expect(test).toContain("cairnFixturePath");
    expect(test).not.toContain(join(dir, "fixtures"));

    // The MCP export is checkable exactly like a CLI export.
    const { checkPlaywrightExport } = await import("../cli/commands/export");
    const check = await checkPlaywrightExport(outDir, undefined, {});
    expect(check.report.status, JSON.stringify(check.report)).toBe("fresh");
    expect(check.exitCode).toBe(0);
  });

  it("batch outDir exports write the README and manifest; failures are reported", async () => {
    await writeFile(join(dir, "flows", "upload.yml"), UPLOAD_SPEC);
    await writeFile(join(dir, "flows", "broken.yml"), "version: 1\nname: [\n");
    const outDir = join(dir, "pw-batch");
    const c = await connect();
    const r = await c.callTool({
      name: "cairn_export_playwright",
      arguments: { path: join(dir, "flows"), outDir, config: configPath },
    });
    const sc = r.structuredContent as {
      status: string;
      manifest: string;
      summary: { written: number; partial: number; failed: number };
      errors: Array<{ source: string; message: string }>;
    };
    expect(sc.manifest).toBe(join(outDir, ".cairn-export.json"));
    expect(sc.summary.failed).toBe(1);
    expect(sc.status).toBe("error");
    expect(sc.errors[0]!.source).toBe(join(dir, "flows", "broken.yml"));
    expect(text(r)).toContain("broken.yml");
    expect(await readFile(join(outDir, "README.md"), "utf8")).toContain(
      "upload_flow",
    );
  });

  it("preconditions / verifiers / gateEnv reach the same code path as the CLI flags (E10)", async () => {
    await writeFile(
      join(dir, "flows", "host.yml"),
      `version: 1
name: host_flow
intent: a command and a polled outcome
coldStart: guest
preconditions:
  commands:
    - run: bun run reset
outcomes:
  - id: soon
    description: shows soon
    verify:
      text: { contains: ready }
      poll: { timeoutMs: 5000 }
steps:
  - open: /home
  - id: seed
    run: echo seeded
`,
    );
    const c = await connect();
    try {
      // stdout: inline exports the run step through the bounded helper.
      const inline = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "host.yml"),
          stdout: true,
          preconditions: "inline",
          config: configPath,
        },
      });
      expect(inline.isError, text(inline)).toBeFalsy();
      const source = (inline.structuredContent as { source: string }).source;
      expect(source).toContain("test.beforeAll");
      expect(source).toContain("await cairnCommand(");
      expect(source).toContain(".toPass({ timeout: 5000, intervals: [1000] })");

      // The same combination errors exactly like the CLI: global needs a project.
      const global = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "host.yml"),
          stdout: true,
          preconditions: "global",
          config: configPath,
        },
      });
      expect(global.isError).toBe(true);
      expect(text(global)).toContain(
        "--preconditions global needs --project or --into",
      );

      // manifest lists the commands in .cairn-export.json (project export).
      const outDir = join(dir, "pw-manifest");
      const project = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "host.yml"),
          project: true,
          outDir,
          preconditions: "manifest",
          verifiers: "drop",
          config: configPath,
        },
      });
      expect(project.isError, text(project)).toBeFalsy();
      const manifest = JSON.parse(
        await readFile(join(outDir, ".cairn-export.json"), "utf8"),
      ) as {
        source: { preconditions?: string; verifiers?: string };
        preconditions?: Array<{ run: string }>;
      };
      expect(manifest.source).toMatchObject({
        preconditions: "manifest",
        verifiers: "drop",
      });
      expect(manifest.preconditions?.map((p) => p.run)).toEqual([
        "bun run reset",
      ]);

      const gateEnv = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "host.yml"),
          stdout: true,
          gateEnv: ["MONGO_URI"],
          config: configPath,
        },
      });
      expect(gateEnv.isError).toBe(true);
      expect(text(gateEnv)).toContain(
        "--gate-env only applies with --verifiers gate",
      );
    } finally {
      await c.close();
    }
  });

  it("mapFile reaches the same code path as --map (E9): a fixture binding, the report, and the refusal outside a structured export", async () => {
    const tree = writeCjsHost(join(dir, "host"));
    await mkdir(join(dir, "actions"), { recursive: true });
    await writeFile(
      join(dir, "actions", "login_member.yml"),
      `version: 1
name: login_member
steps:
  - id: open_login
    open: /login
`,
    );
    await writeFile(
      join(dir, "flows", "mapped.yml"),
      `version: 1
name: mapped_flow
intent: a mapped login
coldStart: guest
imports:
  - ../actions/login_member.yml
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: Hi }
steps:
  - use: login_member
`,
    );
    const mapFile = join(tree.e2e, "export.map.yml");
    await writeFile(
      mapFile,
      `version: 1
test: { import: ./fixtures }
actions:
  login_member:
    fixture: { name: memberSession }
`,
    );
    const c = await connect();
    try {
      const mapped = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "mapped.yml"),
          into: tree.into,
          hostConfig: tree.config,
          mapFile,
          config: configPath,
        },
      });
      expect(mapped.isError, text(mapped)).toBeFalsy();
      const report = mapped.structuredContent as {
        map: {
          file: string;
          actions: Array<{ action: string; treatment: string; target: string }>;
        };
      };
      expect(report.map.file).toBe("../../export.map.yml");
      expect(report.map.actions).toMatchObject([
        {
          action: "login_member",
          treatment: "fixture",
          target: "memberSession",
        },
      ]);
      const spec = await readFile(
        join(tree.into, "mapped_flow.spec.ts"),
        "utf8",
      );
      expect(spec).toContain("async ({ page, memberSession }) => {");

      const stray = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "mapped.yml"),
          stdout: true,
          mapFile,
          config: configPath,
        },
      });
      expect(stray.isError).toBe(true);
      expect(text(stray)).toContain("--map binds actions");
    } finally {
      await c.close();
    }
  });

  it("host profile, export target and maxEvalRatio reach the same code path as the CLI flags (E8 / E12)", async () => {
    const tree = writeCjsHost(join(dir, "host"));
    await writeFile(
      join(dir, "flows", "plain.yml"),
      `version: 1
name: plain_flow
intent: a plain page
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: Plain }
steps:
  - id: open_it
    open: /plain
  - id: pick
    click: { by: testid, testid: go }
`,
    );
    await writeFile(
      join(dir, "flows", "evals.yml"),
      `version: 1
name: eval_flow
intent: evals
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: Evals }
steps:
  - id: open_it
    open: /evals
  - id: a
    eval: { js: "window.a = 1;" }
  - id: b
    eval: { js: "window.b = 1;" }
`,
    );
    const c = await connect();
    try {
      // host profile: tests flat in the host's testDir, the host's test id attribute.
      const adapted = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "plain.yml"),
          into: tree.into,
          hostConfig: tree.config,
          config: configPath,
        },
      });
      expect(adapted.isError, text(adapted)).toBeFalsy();
      const report = adapted.structuredContent as {
        host: { moduleSystem: string; testIdAttribute: string };
        specs: Array<{ file: string }>;
      };
      expect(report.host).toMatchObject({
        moduleSystem: "cjs",
        testIdAttribute: "data-qa-key",
      });
      expect(report.specs.map((s) => s.file)).toEqual(["plain_flow.spec.ts"]);
      // The config's browser.testIdAttribute (data-qa) is what the spec means.
      expect(
        await readFile(join(tree.into, "plain_flow.spec.ts"), "utf8"),
      ).toContain('[data-qa=\\"go\\"]');

      // maxEvalRatio: the over-limit spec is refused (isError), the other written.
      const outDir = join(dir, "pw-eval");
      const limited = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows"),
          outDir,
          maxEvalRatio: 0.5,
          config: configPath,
        },
      });
      expect(limited.isError).toBe(true);
      const limitedReport = limited.structuredContent as {
        files: Array<{ name: string }>;
        refused: Array<{ name: string; ratio: number }>;
      };
      expect(limitedReport.files.map((f) => f.name)).toEqual(["plain_flow"]);
      expect(limitedReport.refused.map((r) => r.name)).toEqual(["eval_flow"]);

      // --host-config only makes sense with into.
      const stray = await c.callTool({
        name: "cairn_export_playwright",
        arguments: {
          path: join(dir, "flows", "plain.yml"),
          stdout: true,
          hostConfig: tree.config,
          config: configPath,
        },
      });
      expect(stray.isError).toBe(true);
      expect(text(stray)).toContain("--host-config adapts");

      // target: a named profile from the config; the path comes from it.
      await writeFile(
        configPath,
        `${await readFile(configPath, "utf8")}export:
  targets:
    ui:
      input: flows/plain.yml
      into: host/e2e/tests/cairn
      hostConfig: host/e2e/playwright.config.ts
`,
      );
      const viaTarget = await c.callTool({
        name: "cairn_export_playwright",
        arguments: { target: "ui", config: configPath },
      });
      expect(viaTarget.isError, text(viaTarget)).toBeFalsy();
      expect((viaTarget.structuredContent as { target: string }).target).toBe(
        "ui",
      );
      const unknown = await c.callTool({
        name: "cairn_export_playwright",
        arguments: { target: "nope", config: configPath },
      });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain("unknown export target");
    } finally {
      await c.close();
    }
  });
});
