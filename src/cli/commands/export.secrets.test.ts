/**
 * No environment value that is set while exporting may reach anything an
 * export writes or prints: generated code, the manifest, the README, the
 * export / check / verify reports, stderr. The config is loaded late-bound:
 * config vars, baseUrl, `auth:` (the built-in `use: login`, also as an export
 * map `apiLogin`), datasources and preconditions all read process.env when
 * the test runs. Every mode is exported with the same secret in every
 * variable, and the whole output tree plus every stream is scanned for it.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { writeCjsHost } from "../../testing/hostTrees";

const REPO_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const CAIRN = join(REPO_ROOT, "bin", "cairn");

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Built at run time so no secret-shaped literal sits in the repo. */
const SECRET = ["late", "Bound", "Leak", String(4096 + 7)].join("");

const LEAK_ENV: Record<string, string> = {
  LEAK_APP_URL: `http://${SECRET.toLowerCase()}.invalid:1/`,
  LEAK_TOKEN: `${SECRET}-token`,
  LEAK_REGION: `${SECRET}-region`,
  LEAK_BASE: `http://${SECRET.toLowerCase()}.invalid:2`,
  LEAK_TENANT: `${SECRET}-tenant`,
  LEAK_CLIENT: `${SECRET}-client`,
  LEAK_PW: `${SECRET}-password`,
  LEAK_DS_BASE: `http://${SECRET.toLowerCase()}.invalid:3`,
  LEAK_KEY: `${SECRET}-key`,
  LEAK_BEARER: `${SECRET}-bearer`,
  LEAK_CMD: `${SECRET}-command`,
  LEAK_RUN: `${SECRET}-run`,
  // A typed field the export never emits: it must not block the late load.
  LEAK_READY_MS: "4096",
};

const CONFIG = `version: 1
webServer:
  command: "echo hi"
  url: \${env.LEAK_APP_URL:-http://localhost:9}
  readyTimeoutMs: \${env.LEAK_READY_MS}
vars:
  apiToken: \${env.LEAK_TOKEN}
  region: \${env.LEAK_REGION:-eu}
environments:
  local:
    baseUrl: \${env.LEAK_BASE:-http://localhost:9}
    include: [vars/local.yml]
    auth:
      login:
        url: /api/login
        headers: { content-type: application/json, x-client: "\${env.LEAK_CLIENT}" }
        body: { email: "a@b.c", password: "\${env.LEAK_PW}", token: "\${vars.apiToken}" }
        expectStatus: 200
    datasources:
      api:
        kind: http
        baseUrl: \${env.LEAK_DS_BASE:-http://localhost:9}
        headers: { X-Api-Key: "\${env.LEAK_KEY}", X-Tenant: "\${vars.tenantKey}" }
        auth: { bearer: "\${env.LEAK_BEARER}" }
`;

/** The environment's own vars, from a file `environments.local.include` lists. */
const ENV_VARS = `vars:
  tenantKey: "k-\${env.LEAK_TENANT}"
`;

const SPEC = `version: 1
name: leak_check
intent: no environment value set while exporting reaches the export
preconditions:
  commands:
    - run: echo \${env.LEAK_CMD} \${vars.apiToken}
steps:
  - id: login
    use: login
  - id: go
    open: /?t=\${vars.apiToken}&r=\${vars.region}
  - id: fill_tenant
    fill: { by: testid, testid: tenant, value: "\${vars.tenantKey}" }
  - id: note
    run: echo \${env.LEAK_RUN} \${vars.apiToken}
outcomes:
  - id: api_ok
    description: the api answers
    verify:
      http:
        source: api
        url: /health
  - id: body
    description: body
    verify:
      text: { contains: "\${vars.region}" }
`;

const MAP = "version: 1\nactions:\n  login:\n    apiLogin: {}\n";

function project(): { root: string; flows: string; spec: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cairn-export-leak-")));
  roots.push(root);
  const source = join(root, "src");
  const flows = join(source, "flows");
  mkdirSync(flows, { recursive: true });
  writeFileSync(join(source, "cairntrace.config.yml"), CONFIG);
  mkdirSync(join(source, "vars"), { recursive: true });
  writeFileSync(join(source, "vars", "local.yml"), ENV_VARS);
  const spec = join(flows, "leak_check.yml");
  writeFileSync(spec, SPEC);
  writeFileSync(join(source, "export.map.yml"), MAP);
  return { root, flows, spec };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === "node_modules") continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

async function cairn(args: string[]): Promise<{
  exitCode: number;
  output: string;
}> {
  const run = await execa(CAIRN, args, {
    reject: false,
    timeout: 120_000,
    env: { ...LEAK_ENV, NO_COLOR: "1" },
  });
  return {
    exitCode: run.exitCode ?? 1,
    output: `${run.stdout}\n${run.stderr}`,
  };
}

describe("export: no environment value set while exporting leaks", () => {
  it("every mode keeps config vars, baseUrl, auth, datasources and commands late-bound", async () => {
    const { root, flows, spec } = project();
    const src = join(root, "src");
    const out = (name: string): string => join(root, "out", name);
    const hostA = writeCjsHost(join(root, "host-a"));
    const hostB = writeCjsHost(join(root, "host-b"));
    const map = join(src, "export.map.yml");
    const runs: Array<{ args: string[]; ok?: boolean }> = [
      { args: [spec, "--stdout"] },
      { args: [spec, "--stdout", "--preconditions", "skip"] },
      { args: [flows, "--out-dir", out("batch"), "--json"] },
      { args: [flows, "--project", "--out-dir", out("default"), "--json"] },
      {
        args: [
          flows,
          "--project",
          "--out-dir",
          out("inline"),
          "--preconditions",
          "inline",
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--project",
          "--out-dir",
          out("global"),
          "--preconditions",
          "global",
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--project",
          "--out-dir",
          out("manifest"),
          "--preconditions",
          "manifest",
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--project",
          "--out-dir",
          out("gate"),
          "--verifiers",
          "gate",
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--project",
          "--out-dir",
          out("map"),
          "--map",
          map,
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--project",
          "--out-dir",
          out("map-global"),
          "--map",
          map,
          "--preconditions",
          "global",
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--into",
          hostA.into,
          "--host-config",
          hostA.config,
          "--preconditions",
          "inline",
          "--json",
        ],
      },
      {
        args: [
          flows,
          "--into",
          hostB.into,
          "--host-config",
          hostB.config,
          "--map",
          map,
          "--json",
        ],
      },
      { args: ["--check", out("default"), "--json"] },
      { args: ["--check", out("map"), "--json"] },
      { args: ["--check", hostB.into, "--json"] },
      { args: ["--verify", out("inline"), "--json"], ok: false },
      { args: ["--verify", hostB.into, "--json"], ok: false },
    ];
    const streams: string[] = [];
    for (const { args, ok } of runs) {
      const result = await cairn([
        "export",
        "playwright",
        ...args,
        "--env",
        "local",
      ]);
      streams.push(result.output);
      if (ok !== false) {
        expect(result.exitCode, `${args.join(" ")}\n${result.output}`).toBe(0);
      }
    }
    for (const stream of streams) {
      expect(stream).not.toContain(SECRET);
      expect(stream.toLowerCase()).not.toContain(SECRET.toLowerCase());
    }
    const files = filesUnder(root).filter(
      (file) => !file.startsWith(join(root, "src")),
    );
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(
        text.toLowerCase().includes(SECRET.toLowerCase()),
        `${file} holds an export-time environment value`,
      ).toBe(false);
    }

    // The values are read when the suite runs instead.
    const test = readFileSync(
      join(out("default"), "tests", "leak_check.spec.ts"),
      "utf8",
    );
    expect(test).toContain("process.env.LEAK_TOKEN");
    expect(test).toContain('(process.env.LEAK_REGION || "eu")');
    expect(test).toContain("process.env.LEAK_TENANT");
    expect(test).toContain('cairnDatasourceEnv("api", "secrets.LEAK_KEY"');
    expect(
      readFileSync(join(out("default"), "playwright.config.ts"), "utf8"),
    ).toContain('baseURL: (process.env.LEAK_BASE || "http://localhost:9"),');
    const auth = readFileSync(join(out("default"), "lib", "auth.ts"), "utf8");
    expect(auth).toContain("process.env.LEAK_PW");
    expect(auth).toContain("process.env.LEAK_CLIENT");
    // The late-bound datasources still name the env a gated verifier needs
    // (a failed late load used to leave this list empty).
    expect(
      readFileSync(join(out("gate"), "tests", "leak_check.spec.ts"), "utf8"),
    ).toContain('const cairnMissing = ["LEAK_BEARER","LEAK_KEY"]');
    // An export map `apiLogin` of the built-in login: the storageState
    // sign-in reads the password when it runs (7B H4).
    for (const authState of [
      join(out("map"), "lib", "authState.ts"),
      join(hostB.into, "lib", "authState.ts"),
    ]) {
      const text = readFileSync(authState, "utf8");
      expect(text).toContain("process.env.LEAK_PW");
      expect(text).toContain("process.env.LEAK_TOKEN");
    }
    // The freshness check does not depend on the environment's values.
    const check = await execa(
      CAIRN,
      ["export", "playwright", "--check", out("default"), "--json"],
      {
        reject: false,
        env: { ...LEAK_ENV, LEAK_TOKEN: "another", NO_COLOR: "1" },
      },
    );
    expect(check.exitCode, check.stdout + check.stderr).toBe(0);
  }, 180_000);

  it("refuses a typed field it emits that only an environment value could fill", async () => {
    const { root, spec } = project();
    writeFileSync(
      join(root, "src", "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://localhost:9
    viewport: { width: \${env.LEAK_WIDTH}, height: 720 }
`,
    );
    writeFileSync(
      spec,
      `version: 1
name: typed_leak
intent: a typed config field
steps:
  - { id: go, open: / }
outcomes:
  - id: body
    description: body
    verify: { text: { contains: x } }
`,
    );
    const result = await execa(
      CAIRN,
      ["export", "playwright", spec, "--stdout", "--env", "local"],
      { reject: false, env: { LEAK_WIDTH: "4107", NO_COLOR: "1" } },
    );
    // A config problem: exit 4 for a single file, like any other one.
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("environments.local.viewport.width");
    expect(result.stderr).not.toContain("4107");
    expect(result.stdout).not.toContain("4107");
  }, 60_000);

  it("refuses a late-bound browser.testIdAttribute by name in every mode (not only the sentinel backstop)", async () => {
    const { root, spec, flows } = project();
    writeFileSync(
      join(root, "src", "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://localhost:9
browser:
  testIdAttribute: \${env.LEAK_TID:-data-qa}
`,
    );
    writeFileSync(
      spec,
      `version: 1
name: tid_leak
intent: a late-bound test id attribute
steps:
  - { id: go, open: / }
  - { id: press, click: { by: testid, testid: go } }
outcomes:
  - id: body
    description: body
    verify: { text: { contains: x } }
`,
    );
    const env = { LEAK_TID: "data-leak-4108", NO_COLOR: "1" };
    const single = await execa(
      CAIRN,
      ["export", "playwright", spec, "--stdout", "--env", "local"],
      { reject: false, env },
    );
    const projectOut = join(root, "out");
    const asProject = await execa(
      CAIRN,
      [
        "export",
        "playwright",
        flows,
        "--project",
        "--out-dir",
        projectOut,
        "--env",
        "local",
      ],
      { reject: false, env },
    );
    // Single file: a config problem (4); --project: 2 (its refusal code).
    expect(single.exitCode).toBe(4);
    expect(asProject.exitCode).toBe(2);
    for (const result of [single, asProject]) {
      expect(result.stderr).toContain(
        "cannot export: browser.testIdAttribute reads ${env.…} / ${secrets.…}",
      );
      // the named refusal, not the leaked-sentinel backstop
      expect(result.stderr).not.toContain("would leak");
      expect(result.stderr + result.stdout).not.toContain("data-leak-4108");
    }
  }, 60_000);
});
