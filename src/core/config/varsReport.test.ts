import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ConfigVarsResultSchema,
  type ConfigVarRow,
} from "../schema/configVars.v1";
import { configVarsToMarkdown } from "../../cli/commands/config/vars";
import { validateConfigFile } from "../../cli/commands/config/validate";
import { buildConfigVars } from "./varsReport";

let root: string;

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cairntrace-config-vars-"));
  await write(
    "cairntrace.config.yml",
    `version: 1
include: [conf/*.yml]
vars:
  tenant: acme
  apiUrl: "\${vars.host}/api"
  adminPassword: hunter2-not-real
  pathToken: "\${env.CAIRN_TEST_SESSION_TOKEN:-none}"
  regions: [eu, us]
  deadVar: nobody-reads-me
environments:
  local:
    baseUrl: http://localhost:3000
    vars:
      host: http://localhost:3000
      loginUser: local-user
    auth:
      login:
        url: "\${vars.apiUrl}/login"
        method: POST
        body: { user: "\${vars.loginUser}" }
  staging:
    extends: local
    baseUrl: https://staging.example.test
    vars:
      host: https://staging.example.test
`,
  );
  await write(
    "conf/data.yml",
    `vars:
  supplier: { name: Example Supplier, id: s-1 }
fixtures:
  supplier:
    kind: exec
    ensure: { shell: "echo '{\\"id\\":\\"\${vars.supplier.id}\\"}'" }
datasources:
  app: { kind: http, baseUrl: "\${vars.host}" }
`,
  );
  await write(
    "flows/home.yml",
    `version: 1
name: home
intent: open the home page
coldStart: guest
imports: [../actions/visit.yml]
fixtures: [supplier]
steps:
  - use: visit
  - open: "/t/\${vars.tenant}"
outcomes:
  - id: ok
    description: it renders
    verify:
      script:
        runtime: node
        file: ../verifiers/check.mjs
`,
  );
  await write(
    "flows/login.yml",
    `version: 1
name: signed-in
intent: sign in through the environment login
steps:
  - use: login
outcomes:
  - { id: ok, description: d, verify: { console: { errorsMax: 0 } } }
`,
  );
  await write(
    "actions/visit.yml",
    `version: 1
name: visit
steps:
  - open: "/regions/\${vars.regions.0}"
`,
  );
  await write(
    "verifiers/check.mjs",
    "export default async (ctx) => ctx.vars.apiUrl && ctx.vars['tenant'];\n",
  );
});

describe("cairn config vars", () => {
  it("lists kind, effective value per environment, definitions, overrides and uses", async () => {
    const { result, exitCode } = await buildConfigVars({
      cwd: root,
      processEnv: { CAIRN_TEST_SESSION_TOKEN: "live-session-value" },
    });
    expect(exitCode).toBe(0);
    ConfigVarsResultSchema.parse(result);
    expect(result.files).toEqual(["cairntrace.config.yml", "conf/data.yml"]);
    expect(result.environments).toEqual(["local", "staging"]);
    const row = (name: string) => {
      const found = result.vars.find((r) => r.name === name);
      if (!found) throw new Error(`no row ${name}`);
      return found;
    };

    expect(row("apiUrl")).toMatchObject({
      kind: "string",
      sameInAllEnvironments: false,
      values: {
        local: {
          value: "http://localhost:3000/api",
          scope: "vars",
          at: "cairntrace.config.yml:5",
          template: "${vars.host}/api",
        },
        staging: { value: "https://staging.example.test/api" },
      },
    });
    expect(row("apiUrl").usedBy.map((u) => `${u.kind}:${u.name}`)).toEqual([
      "auth:environments.local.auth",
      "auth:environments.staging.auth",
      "script:verifiers/check.mjs",
    ]);
    // host: defined by local, overridden by staging's own entry
    expect(row("host")).toMatchObject({
      definedAt: [
        { scope: "environments.local.vars", at: "cairntrace.config.yml:14" },
        { scope: "environments.staging.vars", at: "cairntrace.config.yml:25" },
      ],
      overriddenBy: [
        {
          scope: "environments.staging.vars",
          at: "cairntrace.config.yml:25",
          envs: ["staging"],
        },
      ],
    });
    expect(
      row("host")
        .usedBy.map((u) => u.kind)
        .toSorted(),
    ).toEqual(["datasource", "var"]);
    // typed vars
    expect(row("regions")).toMatchObject({
      kind: "list",
      sameInAllEnvironments: true,
      values: { local: { value: ["eu", "us"] } },
      usedBy: [{ kind: "action", name: "visit", file: "actions/visit.yml" }],
    });
    expect(row("supplier")).toMatchObject({
      kind: "object",
      definedAt: [{ scope: "vars", at: "conf/data.yml:2" }],
      usedBy: [{ kind: "fixture", name: "supplier", file: "conf/data.yml" }],
    });
    // masking: a credential-like name, and a value spliced from a sensitive env var
    expect(row("adminPassword").values.local).toMatchObject({
      value: "[redacted]",
      masked: true,
    });
    expect(row("pathToken").values.local).toMatchObject({
      value: "[redacted]",
      masked: true,
    });
    expect(JSON.stringify(result)).not.toContain("live-session-value");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    // dead vars
    expect(row("deadVar").unused).toBe(true);
    expect(row("tenant").unused).toBeUndefined();
    expect(result.vars.filter((r) => r.unused).map((r) => r.name)).toEqual([
      "adminPassword",
      "pathToken",
      "deadVar",
    ]);
    expect(result.totals).toEqual({
      vars: 9,
      unused: 3,
      sameInAllEnvironments: 7,
      differing: 2,
      sameWhereDefined: 7,
    });
    expect(result.findings.filter((f) => f.code === "unused-var")).toHaveLength(
      3,
    );
  });

  it("filters by environment, unused and the spec that uses them", async () => {
    const staging = await buildConfigVars({ cwd: root, env: "staging" });
    expect(staging.result.environments).toEqual(["staging"]);
    expect(
      staging.result.vars.every(
        (row) =>
          Object.keys(row.values).join() === "staging" &&
          row.sameInAllEnvironments === undefined,
      ),
    ).toBe(true);

    const unused = await buildConfigVars({ cwd: root, unused: true });
    expect(unused.result.vars.map((r) => r.name)).toEqual([
      "adminPassword",
      "pathToken",
      "deadVar",
    ]);
    expect(unused.result.filter).toEqual({ unused: true });

    const home = await buildConfigVars({
      cwd: root,
      usedBy: "flows/home.yml",
    });
    // own refs, the imported action, the listed fixture, the script verifier,
    // and the vars those are built from
    expect(home.result.vars.map((r) => r.name).toSorted()).toEqual([
      "apiUrl",
      "host",
      "regions",
      "supplier",
      "tenant",
    ]);
    const login = await buildConfigVars({ cwd: root, usedBy: "signed-in" });
    expect(login.result.vars.map((r) => r.name).toSorted()).toEqual([
      "apiUrl",
      "host",
      "loginUser",
    ]);
  });

  it("exits 4 for an unknown environment, an unknown spec or a missing config", async () => {
    const env = await buildConfigVars({ cwd: root, env: "prod" });
    expect(env.exitCode).toBe(4);
    expect(env.result.errors?.[0]).toMatch(/unknown environment "prod"/);
    const spec = await buildConfigVars({ cwd: root, usedBy: "nope.yml" });
    expect(spec.exitCode).toBe(4);
    const missing = await buildConfigVars({
      cwd: root,
      config: "does-not-exist.yml",
    });
    expect(missing.exitCode).toBe(4);
    expect(ConfigVarsResultSchema.parse(missing.result).ok).toBe(false);
  });

  it("renders a markdown table", async () => {
    const { result } = await buildConfigVars({ cwd: root });
    const md = configVarsToMarkdown(result);
    expect(md).toContain(
      "| var | kind | local | staging | defined at | used by |",
    );
    expect(md).toContain(
      "| deadVar | string | nobody-reads-me | nobody-reads-me |",
    );
    expect(md).toContain("## Overrides");
    expect(md).toContain("**unused**");
  });
});

describe("cairn config validate — composition", () => {
  it("reports dead vars as warnings and the included files", async () => {
    const { result, exitCode } = await validateConfigFile(
      join(root, "cairntrace.config.yml"),
    );
    expect(exitCode).toBe(0);
    expect(result.includes).toEqual(["conf/data.yml"]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/^vars\.adminPassword is not used/),
      expect.stringMatching(/^vars\.pathToken is not used/),
      expect.stringMatching(
        /^vars\.deadVar is not used .*\(defined at cairntrace\.config\.yml:9\)$/,
      ),
    ]);
    expect(result.config?.environments.staging?.vars?.apiUrl).toBe(
      "https://staging.example.test/api",
    );
  });

  it("fails on include cycles and unknown extends targets; warns on undefined var references", async () => {
    const cyclic = join(root, "cyclic");
    await mkdir(cyclic, { recursive: true });
    await writeFile(
      join(cyclic, "cairntrace.config.yml"),
      "version: 1\ninclude: [a.yml]\nenvironments: { local: {} }\n",
    );
    await writeFile(
      join(cyclic, "a.yml"),
      "include: [cairntrace.config.yml]\n",
    );
    const cycle = await validateConfigFile(
      join(cyclic, "cairntrace.config.yml"),
    );
    expect(cycle.exitCode).toBe(4);
    expect(cycle.result.errors).toEqual([
      "include cycle: cairntrace.config.yml → a.yml → cairntrace.config.yml",
    ]);
    expect(cycle.result.keys).toEqual(["version", "include", "environments"]);

    const broken = join(root, "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(
      join(broken, "cairntrace.config.yml"),
      'version: 1\nvars: { a: "${vars.b}" }\nenvironments:\n  dev: { extends: ghost }\n',
    );
    const extendsError = await validateConfigFile(
      join(broken, "cairntrace.config.yml"),
    );
    expect(extendsError.exitCode).toBe(4);
    expect(extendsError.result.errors).toEqual([
      'environments.dev.extends: unknown environment "ghost" (defined: dev)',
    ]);
    await writeFile(
      join(broken, "cairntrace.config.yml"),
      'version: 1\nvars: { a: "${vars.b}" }\nenvironments:\n  dev: {}\n',
    );
    const refWarning = await validateConfigFile(
      join(broken, "cairntrace.config.yml"),
    );
    // `b` may come from --var at run time: a warning, not an error.
    expect(refWarning.exitCode).toBe(0);
    expect(refWarning.result.errors ?? []).toEqual([]);
    expect(refWarning.result.findings).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "var-reference",
        key: "vars.a",
      }),
    );
  });

  it("never shows a value that came from the environment: at any depth, through var references, or under pass / pw names", async () => {
    const dir = join(root, "env-derived");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
vars:
  adminPassword: "\${env.REVIEW_ADMIN_PASSWORD}"
  seedLogin: "\${vars.adminPassword}"
  dbPass: "\${env.REVIEW_DB_PASS}"
  seedUser:
    email: qa@example.test
    pass: "\${env.REVIEW_SEED_PASS}"
  seedUserJson: "\${vars.seedUser}"
  literalPw: literal-pw-value
  loginEcho: "\${vars.literalPw}"
  label: "\${env.REVIEW_LABEL}"
  labelCopy: "\${vars.label}-copy"
  plain: visible-value
environments:
  local:
    baseUrl: http://localhost:1
`,
    );
    // Built at runtime: no credential-shaped literal in the source.
    const stamp = String(Date.now()).slice(-5);
    const secrets = {
      REVIEW_ADMIN_PASSWORD: `admin-${stamp}-Zx`,
      REVIEW_DB_PASS: `db-${stamp}-Qy`,
      REVIEW_SEED_PASS: `seed-${stamp}-Wv`,
      REVIEW_LABEL: `label-${stamp}-Uu`,
    };
    const { result, exitCode } = await buildConfigVars({
      cwd: dir,
      processEnv: secrets,
    });
    expect(exitCode).toBe(0);
    ConfigVarsResultSchema.parse(result);
    const text = [JSON.stringify(result), configVarsToMarkdown(result)].join(
      "\n",
    );
    for (const value of [...Object.values(secrets), "literal-pw-value"]) {
      expect(text).not.toContain(value);
    }
    const value = (name: string) =>
      result.vars.find((r) => r.name === name)?.values.local;
    expect(value("seedLogin")).toMatchObject({
      value: "${vars.adminPassword}",
      fromEnvironment: true,
    });
    expect(value("seedUser")).toMatchObject({
      value: { email: "qa@example.test", pass: "${env.REVIEW_SEED_PASS}" },
      fromEnvironment: true,
    });
    expect(value("seedUserJson")).toMatchObject({ fromEnvironment: true });
    expect(value("labelCopy")).toMatchObject({
      value: "${vars.label}-copy",
      fromEnvironment: true,
    });
    expect(value("loginEcho")).toMatchObject({ fromEnvironment: true });
    expect(value("plain")).toEqual(
      expect.objectContaining({ value: "visible-value" }),
    );
    expect(value("plain")!.fromEnvironment).toBeUndefined();
  });

  it("lists include overrides as info findings", async () => {
    const dir = join(root, "overrides");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      "version: 1\ninclude: [base.yml]\nvars: { a: 2 }\nenvironments: { local: {} }\n",
    );
    await writeFile(join(dir, "base.yml"), "vars:\n  a: 1\n");
    const { result } = await validateConfigFile(
      join(dir, "cairntrace.config.yml"),
    );
    expect(result.findings).toContainEqual({
      level: "info",
      code: "include-override",
      key: "vars.a",
      at: "base.yml:2",
      overriddenBy: "cairntrace.config.yml:3",
      message:
        "vars.a from base.yml:2 is overridden by cairntrace.config.yml:3",
    });
  });
});

describe("environment-scoped include", () => {
  let dir: string;
  beforeAll(async () => {
    dir = join(root, "env-scoped");
    const put = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await put(
      "cairntrace.config.yml",
      `version: 1
vars:
  tenant: acme
environments:
  local:
    baseUrl: "\${vars.host}/app"
    include: [vars/local.yml]
  dev:
    include: [vars/dev.yml]
    vars:
      region: dev-own
`,
    );
    await put(
      "vars/local.yml",
      `vars:
  host: http://localhost:3000
  region: local
  orphan: nobody-reads-me
`,
    );
    await put(
      "vars/dev.yml",
      `vars:
  host: https://dev.example.test
  region: dev-inc
`,
    );
    await put(
      "flows/home.yml",
      `version: 1
name: home
intent: open the home page
coldStart: guest
steps:
  - open: "\${vars.host}/t/\${vars.tenant}?r=\${vars.region}"
`,
    );
  });

  it("reports definedAt, effective scope and file:line for vars that come from environment includes", async () => {
    const { result, exitCode } = await buildConfigVars({
      config: join(dir, "cairntrace.config.yml"),
    });
    expect(exitCode).toBe(0);
    expect(result.files).toEqual([
      "cairntrace.config.yml",
      "vars/local.yml",
      "vars/dev.yml",
    ]);
    const row = (name: string) => result.vars.find((v) => v.name === name)!;
    expect(row("host").values.local).toMatchObject({
      value: "http://localhost:3000",
      scope: "environments.local.vars",
      at: "vars/local.yml:2",
    });
    expect(row("host").values.dev).toMatchObject({
      scope: "environments.dev.vars",
      at: "vars/dev.yml:2",
    });
    expect(row("host").definedAt).toEqual([
      { scope: "environments.local.vars", at: "vars/local.yml:2" },
      { scope: "environments.dev.vars", at: "vars/dev.yml:2" },
    ]);
    // dev writes region itself, over its included file
    expect(row("region").values.dev).toMatchObject({
      value: "dev-own",
      at: "cairntrace.config.yml:11",
    });
    expect(row("region").values.local).toMatchObject({
      at: "vars/local.yml:3",
    });
    expect(row("region").overriddenBy).toEqual([
      {
        scope: "environments.dev.vars",
        at: "cairntrace.config.yml:11",
        envs: ["dev"],
      },
    ]);
    // `tenant` stays top-level in both
    expect(row("tenant").values.dev).toMatchObject({ scope: "vars" });
    // environments keep their own var sets: host is not top-level
    expect(row("orphan").values.dev).toBeUndefined();
    expect(row("orphan").unused).toBe(true);
    expect(row("orphan").definedAt[0]).toEqual({
      scope: "environments.local.vars",
      at: "vars/local.yml:4",
    });
    expect(row("host").usedBy.map((u) => u.name)).toContain("home");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        level: "info",
        code: "include-override",
        key: "environments.dev.vars.region",
        at: "vars/dev.yml:3",
        overriddenBy: "cairntrace.config.yml:11",
      }),
    );
  });

  it("config validate lists the files, warns on dead vars with their include location and keeps literal-var-ref", async () => {
    const { result, exitCode } = await validateConfigFile(
      join(dir, "cairntrace.config.yml"),
    );
    expect(exitCode).toBe(0);
    expect(result.includes).toEqual(["vars/local.yml", "vars/dev.yml"]);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /^vars\.orphan is not used .*\(defined at vars\/local\.yml:4\)$/,
      ),
    );
    expect(result.warnings).toContainEqual(
      expect.stringMatching(
        /^environments\.local\.baseUrl holds \$\{vars\.host\}/,
      ),
    );
  });
});

/** Var name → environment → effective value. */
const effective = (r: { vars: ConfigVarRow[] }) =>
  Object.fromEntries(
    r.vars.map((v) => [
      v.name,
      Object.fromEntries(
        Object.entries(v.values).map(([env, entry]) => [env, entry.value]),
      ),
    ]),
  );

describe("environment-scoped include — parity with the unsplit config", () => {
  it("config vars shows the same vars and effective values in every environment", async () => {
    const base = join(import.meta.dirname, "__fixtures__", "composition-env");
    const read = async (side: "before" | "after") => {
      const { result, exitCode } = await buildConfigVars({
        config: join(base, side, "cairntrace.config.yml"),
      });
      expect(exitCode).toBe(0);
      return result;
    };
    const before = await read("before");
    const after = await read("after");
    expect(after.environments).toEqual(before.environments);
    expect(effective(after)).toEqual(effective(before));
    expect(after.totals).toEqual(before.totals);
    // only where each definition lives differs
    const hostAfter = after.vars.find((v) => v.name === "host")!;
    expect(hostAfter.values.test!.at).toBe("config/vars/test.yml:2");
    expect(before.vars.find((v) => v.name === "host")!.values.test!.at).toBe(
      "cairntrace.config.yml:32",
    );
  });
});
