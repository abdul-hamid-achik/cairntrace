import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../schema/config.v1";
import {
  ConfigCompositionError,
  composeConfigText,
  indexLocations,
  resolveVarReferences,
} from "./compose";
import { loadConfig } from "./loader";
import { resolveProjectRuntimeContext } from "./runtimeContext";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "composition");

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-compose-test-"));
});

/** Write `files` (relative path → text) into a fresh project dir. */
async function project(files: Record<string, string>): Promise<string> {
  const root = join(dir, `p${++counter}`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

async function compose(files: Record<string, string>) {
  const root = await project(files);
  const configPath = join(root, "cairntrace.config.yml");
  const { readFile } = await import("node:fs/promises");
  return {
    root,
    configPath,
    result: await composeConfigText(await readFile(configPath, "utf8"), {
      configPath,
      env: {},
    }),
  };
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `expected ok, got: ${JSON.stringify((result as unknown as { errors: string[] }).errors)}`,
    );
  }
  return result as Extract<T, { ok: true }>;
}

function errorsOf(result: { ok: boolean }): string[] {
  expect(result.ok).toBe(false);
  return (result as unknown as { errors: string[] }).errors;
}

describe("config composition — back-compat", () => {
  it("leaves a config without include / top-level vars / extends exactly as the schema parsed it (anchors + merge keys included)", async () => {
    const text = `version: 1
environments:
  local:
    baseUrl: http://localhost:3000
    vars: &shared
      tenant: acme
      retries: 3
      sandbox: true
  preview:
    baseUrl: http://localhost:4000
    vars:
      <<: *shared
      tenant: preview
  remote:
    vars: *shared
`;
    const { configPath, result } = await compose({
      "cairntrace.config.yml": text,
    });
    const composed = ok(result);
    expect(composed.config).toEqual(
      ConfigSchema.parse(parseYaml(text, { merge: true })),
    );
    // provenance still says where each var lives (merge keys and aliases
    // point at the anchor's environment)
    const preview = composed.composition.environments.preview!.vars;
    expect(preview.tenant!.definitions).toEqual([
      expect.objectContaining({
        scope: "environments.preview.vars",
        file: configPath,
        line: 13,
      }),
    ]);
    expect(preview.retries!.definitions[0]).toMatchObject({
      line: 7,
      inheritedFrom: "local",
    });
    expect(
      composed.composition.environments.remote!.vars.sandbox!.definitions[0],
    ).toMatchObject({ line: 8, inheritedFrom: "local" });
  });

  it("keeps a var value that holds no reference as written (runtime placeholders untouched)", () => {
    const resolved = resolveVarReferences({
      token: "run-${run.token}-${worker.index}",
      env: "${env.UNSET:-x}",
    });
    expect(resolved.vars).toEqual({
      token: "run-${run.token}-${worker.index}",
      env: "${env.UNSET:-x}",
    });
    expect(resolved.changed).toBe(false);
    expect(resolved.problems).toEqual([]);
  });
});

describe("config composition — top-level vars and extends", () => {
  it("gives every environment the top-level vars, overridden by name", async () => {
    const composed = ok(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
vars:
  tenant: acme
  regions: [eu, us]
  limits: { maxRows: 50, strict: true }
environments:
  local:
    vars: { tenant: local-tenant }
  staging: {}
`,
        })
      ).result,
    );
    expect(composed.config.environments.local!.vars).toEqual({
      tenant: "local-tenant",
      regions: ["eu", "us"],
      limits: { maxRows: 50, strict: true },
    });
    expect(composed.config.environments.staging!.vars).toEqual({
      tenant: "acme",
      regions: ["eu", "us"],
      limits: { maxRows: 50, strict: true },
    });
    // the top-level block itself stays as authored
    expect(composed.config.vars).toEqual({
      tenant: "acme",
      regions: ["eu", "us"],
      limits: { maxRows: 50, strict: true },
    });
    expect(
      composed.composition.environments.local!.vars.tenant!.definitions.map(
        (d) => d.scope,
      ),
    ).toEqual(["vars", "environments.local.vars"]);
  });

  it("deep-merges an extends chain: objects by key, lists and scalars replace, vars by name, false replaces", async () => {
    const composed = ok(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
services:
  docker: { command: "docker compose up -d" }
environments:
  base:
    baseUrl: http://localhost:3000
    waitScale: 2
    viewport: { width: 1280, height: 800 }
    policy: { trait: owned, mutations: allow }
    vars: { tenant: base, regions: [eu, us], nested: { a: 1, b: 2 } }
    services: { docker: { command: "docker compose up -d", reuseExisting: true } }
  middle:
    extends: base
    policy: { trait: shared }
    vars: { regions: [ap], nested: { a: 9 } }
  leaf:
    extends: middle
    baseUrl: https://leaf.example.test
    services: false
`,
        })
      ).result,
    );
    const leaf = composed.config.environments.leaf!;
    expect(leaf.extends).toBe("middle");
    expect(leaf.baseUrl).toBe("https://leaf.example.test");
    expect(leaf.waitScale).toBe(2);
    expect(leaf.viewport).toEqual({ width: 1280, height: 800 });
    expect(leaf.policy).toEqual({ trait: "shared", mutations: "allow" });
    expect(leaf.services).toBe(false);
    // a var's value is replaced whole, never merged into
    expect(leaf.vars).toEqual({
      tenant: "base",
      regions: ["ap"],
      nested: { a: 9 },
    });
    expect(composed.config.environments.middle!.services).toEqual({
      docker: { command: "docker compose up -d", reuseExisting: true },
    });
    expect(composed.composition.environments.leaf!.chain).toEqual([
      "base",
      "middle",
      "leaf",
    ]);
  });

  it("validates the merged environment (an extends that breaks the schema is a config error)", async () => {
    const errors = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  base:
    secrets: { provider: tvault, tvault: { project: shop } }
  child:
    extends: base
    secrets: { provider: tvault, tvault: { group: shop, env: dev } }
`,
        })
      ).result,
    );
    expect(errors.join("\n")).toMatch(
      /environments\.child\.secrets.*after extends/,
    );
  });

  it("reports an unknown extends target and an extends cycle", async () => {
    const unknown = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  dev: { extends: staging }
  local: {}
`,
        })
      ).result,
    );
    expect(unknown).toEqual([
      'environments.dev.extends: unknown environment "staging" (defined: dev, local)',
    ]);
    const cycle = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  a: { extends: b }
  b: { extends: c }
  c: { extends: a }
  d: { extends: a }
  self: { extends: self }
`,
        })
      ).result,
    );
    expect(cycle).toEqual([
      "environments.c.extends: cycle a → b → c → a",
      "environments.self.extends: cycle self → self",
    ]);
  });

  it("an environment the config does not define still gets the top-level vars at run time", async () => {
    const root = await project({
      "cairntrace.config.yml": `version: 1
vars: { tenant: acme, apiUrl: "\${vars.host}/api" }
environments:
  local: { vars: { host: http://localhost:3000 } }
`,
    });
    const runtime = await resolveProjectRuntimeContext({ cwd: root });
    expect(runtime.vars).toEqual({
      tenant: "acme",
      host: "http://localhost:3000",
      apiUrl: "http://localhost:3000/api",
    });
    const fallback = await resolveProjectRuntimeContext({
      cwd: root,
      envOverride: undefined,
      configPath: join(root, "cairntrace.config.yml"),
    });
    expect(fallback.envName).toBe("local");
    const other = await project({
      "cairntrace.config.yml": `version: 1
defaultEnvironment: ghost
vars: { tenant: acme, apiUrl: "\${vars.host}/api" }
environments:
  local: { vars: { host: http://localhost:3000 } }
`,
    });
    const ghost = await resolveProjectRuntimeContext({ cwd: other });
    expect(ghost.envName).toBe("ghost");
    // the reference no environment satisfies stays as written
    expect(ghost.vars).toEqual({ tenant: "acme", apiUrl: "${vars.host}/api" });
  });
});

describe("config composition — vars that reference vars", () => {
  it("resolves embedded, whole (typed), dotted and defaulted references once per environment", async () => {
    const composed = ok(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
vars:
  host: http://localhost:3000
  apiUrl: "\${vars.host}/api"
  ids: [7, 8]
  idsCopy: "\${vars.ids}"
  label: "ids=\${vars.ids} first=\${vars.ids.0}"
  admin: { email: admin@example.test, role: owner }
  adminEmail: "\${vars.admin.email}"
  region: "\${vars.missingRegion:-eu}"
environments:
  local: {}
  staging:
    vars: { host: https://staging.example.test }
`,
        })
      ).result,
    );
    expect(composed.config.environments.staging!.vars).toMatchObject({
      apiUrl: "https://staging.example.test/api",
      idsCopy: [7, 8],
      label: "ids=[7,8] first=7",
      adminEmail: "admin@example.test",
      region: "eu",
    });
    expect(composed.config.environments.local!.vars!.apiUrl).toBe(
      "http://localhost:3000/api",
    );
    // the top-level block keeps the template
    expect(composed.config.vars!.apiUrl).toBe("${vars.host}/api");
  });

  it("defers an undefined reference (a warning naming the environments, left for --var) and errors on a cycle", async () => {
    const missing = ok(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
vars:
  apiUrl: "\${vars.host}/api"
environments:
  local: {}
  dev: {}
  prod: { vars: { host: https://prod.example.test } }
`,
        })
      ).result,
    );
    expect(
      missing.composition.findings.filter((f) => f.code === "var-reference"),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        key: "vars.apiUrl",
        message: expect.stringContaining(
          "vars.apiUrl: ${vars.host} is not defined by the config (environments local, dev)",
        ),
      }),
    ]);
    expect(missing.composition.environments.local!.deferred).toEqual([
      { name: "apiUrl", ref: "host" },
    ]);
    expect(missing.config.environments.local!.vars!.apiUrl).toBe(
      "${vars.host}/api",
    );
    expect(missing.config.environments.prod!.vars!.apiUrl).toBe(
      "https://prod.example.test/api",
    );
    const cycle = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  local:
    vars:
      a: "\${vars.b}-x"
      b: "\${vars.c}"
      c: "\${vars.a}"
      ok: fine
`,
        })
      ).result,
    );
    expect(cycle).toEqual([
      "environments.local.vars.a: reference cycle vars.a → vars.b → vars.c → vars.a (environment local)",
    ]);
    const badPath = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  local:
    vars:
      admin: { email: a@example.test }
      who: "\${vars.admin.name}"
`,
        })
      ).result,
    );
    expect(badPath).toEqual([
      "environments.local.vars.who: ${vars.admin.name} does not exist (vars.admin has no name) (environment local)",
    ]);
  });

  it("loadConfig throws a ConfigCompositionError for composition problems and the ZodError for schema ones", async () => {
    const bad = await project({
      "cairntrace.config.yml": `version: 1
environments:
  dev: { extends: nowhere }
`,
    });
    await expect(
      loadConfig("x", join(bad, "cairntrace.config.yml")),
    ).rejects.toBeInstanceOf(ConfigCompositionError);
    const invalid = await project({
      "cairntrace.config.yml":
        "version: 1\nenvironments:\n  local: { waitScale: -1 }\n",
    });
    await expect(
      loadConfig("x", join(invalid, "cairntrace.config.yml")),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("config composition — include", () => {
  it("merges vars / fixtures / gates / datasources from globs and paths: later files win, the config wins, overrides are findings", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
include:
  - shared/*.yml
  - extra/gates.yaml
vars:
  tenant: from-config
environments:
  local: {}
`,
      "shared/a.yml": `vars:
  tenant: from-a
  region: eu
fixtures:
  supplier:
    kind: exec
    ensure: { shell: "echo '{}'" }
`,
      "shared/b.yml": `vars:
  region: us
  only: b
datasources:
  app: { kind: http, baseUrl: http://localhost:3000 }
`,
      "shared/notes.md": "not yaml, not matched",
      "extra/gates.yaml": `gates:
  api: { http: http://localhost:3000/health }
`,
    });
    const composed = ok(result);
    expect(composed.config.environments.local!.vars).toEqual({
      tenant: "from-config",
      region: "us",
      only: "b",
    });
    expect(Object.keys(composed.config.fixtures ?? {})).toEqual(["supplier"]);
    expect(Object.keys(composed.config.gates ?? {})).toEqual(["api"]);
    expect(Object.keys(composed.config.datasources ?? {})).toEqual(["app"]);
    expect(
      composed.composition.files.map((f) => f.split("/").slice(-2).join("/")),
    ).toEqual([
      "p" + counter + "/cairntrace.config.yml",
      "shared/a.yml",
      "shared/b.yml",
      "extra/gates.yaml",
    ]);
    const overrides = composed.composition.findings.filter(
      (f) => f.code === "include-override",
    );
    expect(overrides.map((f) => f.message)).toEqual([
      "vars.region from shared/a.yml:3 is overridden by shared/b.yml:2",
      "vars.tenant from shared/a.yml:2 is overridden by cairntrace.config.yml:6",
    ]);
    expect(composed.composition.topLevel.tenant!.map((d) => d.line)).toEqual([
      2, 6,
    ]);
    expect(composed.composition.entries["fixtures.supplier"]?.file).toMatch(
      /shared\/a\.yml$/,
    );
  });

  it("resolves nested includes against the including file and validates included entries (cross-entry rules on the merged config)", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
include: [conf/fixtures.yml]
fixtures:
  account:
    kind: exec
    ensure: { shell: "echo '{}'" }
environments:
  local: {}
`,
      "conf/fixtures.yml": `include: [more/vars.yml]
fixtures:
  order:
    kind: exec
    needs: [account]
    ensure: { shell: "echo '{}'" }
`,
      "conf/more/vars.yml": "vars: { nested: yes-please }\n",
    });
    const composed = ok(result);
    expect(composed.config.environments.local!.vars).toEqual({
      nested: "yes-please",
    });
    expect(Object.keys(composed.config.fixtures ?? {}).toSorted()).toEqual([
      "account",
      "order",
    ]);
  });

  it("reports include cycles, missing files, disallowed keys and bad entries with the file name", async () => {
    const cycle = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: [a.yml]
environments: { local: {} }
`,
          "a.yml": "include: [b.yml]\n",
          "b.yml": "include: [a.yml]\n",
        })
      ).result,
    );
    expect(cycle).toEqual([
      "include cycle: cairntrace.config.yml → a.yml → b.yml → a.yml",
    ]);
    const self = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: [cairntrace.config.yml]
environments: { local: {} }
`,
        })
      ).result,
    );
    expect(self[0]).toMatch(
      /^include cycle: cairntrace\.config\.yml → cairntrace\.config\.yml/,
    );
    const missing = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: [nope.yml]
environments: { local: {} }
`,
        })
      ).result,
    );
    expect(missing[0]).toMatch(/^include: nope\.yml does not exist/);
    const disallowed = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: [env.yml]
environments: { local: {} }
`,
          "env.yml": "environments:\n  local: {}\nvars:\n  bad: ~\n",
        })
      ).result,
    );
    expect(disallowed.join("\n")).toMatch(
      /env\.yml: \(root\): Unrecognized key\(s\) in object: 'environments' \(an included file may carry vars, fixtures, gates, datasources/,
    );
    expect(disallowed.join("\n")).toMatch(/env\.yml: vars\.bad: /);
  });

  it("warns when a glob matches no YAML file", async () => {
    const composed = ok(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: ["vars/**/*.yml"]
environments: { local: {} }
`,
        })
      ).result,
    );
    expect(composed.composition.findings).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "include-empty",
      }),
    ]);
  });

  it("matches ** across directories and keeps the order deterministic", async () => {
    const composed = ok(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: ["vars/**/*.yml"]
environments: { local: {} }
`,
          "vars/z.yml": "vars: { z: 1 }\n",
          "vars/deep/a.yml": "vars: { a: 1 }\n",
          "vars/deep/deeper/b.yml": "vars: { b: 1, z: 2 }\n",
          "vars/.hidden/c.yml": "vars: { c: 1 }\n",
        })
      ).result,
    );
    expect(composed.config.environments.local!.vars).toEqual({
      a: 1,
      b: 1,
      z: 1,
    });
  });
});

describe("config composition — environment-scoped include", () => {
  it("folds each environment's included files into its own vars: files in order, the environment's own vars last, overrides are findings", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
vars:
  tenant: top
  region: top
environments:
  local:
    include:
      - vars/local/*.yml
      - vars/extra.yml
    vars:
      region: own
  dev:
    include: [vars/dev.yml]
`,
      "vars/local/a.yml": `vars:
  host: http://a.example.test
  region: a
  only: a
`,
      "vars/local/b.yml": `vars:
  host: http://b.example.test
`,
      "vars/extra.yml": `vars:
  only: extra
`,
      "vars/dev.yml": `vars:
  host: http://dev.example.test
`,
    });
    const composed = ok(result);
    expect(composed.config.environments.local!.vars).toEqual({
      tenant: "top",
      region: "own",
      host: "http://b.example.test",
      only: "extra",
    });
    expect(composed.config.environments.dev!.vars).toEqual({
      tenant: "top",
      region: "top",
      host: "http://dev.example.test",
    });
    // the environment's include key never reaches the effective config
    expect("include" in composed.config.environments.local!).toBe(false);
    const overrides = composed.composition.findings
      .filter((f) => f.code === "include-override")
      .map((f) => f.message);
    expect(overrides).toEqual([
      "environments.local.vars.host from vars/local/a.yml:2 is overridden by vars/local/b.yml:2",
      "environments.local.vars.only from vars/local/a.yml:4 is overridden by vars/extra.yml:2",
      "environments.local.vars.region from vars/local/a.yml:3 is overridden by cairntrace.config.yml:11",
    ]);
    const region = composed.composition.environments.local!.vars.region!;
    expect(region.definitions.map((d) => [d.scope, d.line])).toEqual([
      ["vars", 4],
      ["environments.local.vars", 3],
      ["environments.local.vars", 11],
    ]);
    const host = composed.composition.environments.local!.vars.host!;
    expect(
      host.definitions.map((d) => [
        d.file.split("/").slice(-2).join("/"),
        d.line,
      ]),
    ).toEqual([
      ["local/a.yml", 2],
      ["local/b.yml", 2],
    ]);
    expect(
      composed.composition.files.map((f) => f.split("/").slice(-2).join("/")),
    ).toEqual([
      "p" + counter + "/cairntrace.config.yml",
      "local/a.yml",
      "local/b.yml",
      "vars/extra.yml",
      "vars/dev.yml",
    ]);
  });

  it("precedence: top-level vars < extended environment (its includes, then its own vars) < the environment (its includes, then its own vars)", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
include: [shared.yml]
vars:
  a: top
  b: top
  c: top
  d: top
  e: top
environments:
  base:
    include: [base.yml]
    vars:
      c: base-own
  child:
    extends: base
    include: [child.yml]
    vars:
      d: child-own
`,
      "shared.yml": "vars:\n  a: shared\n",
      "base.yml": `vars:
  b: base-inc
  c: base-inc
  d: base-inc
`,
      "child.yml": `vars:
  d: child-inc
  e: child-inc
`,
    });
    const composed = ok(result);
    expect(composed.config.environments.child!.vars).toEqual({
      a: "top",
      b: "base-inc",
      c: "base-own",
      d: "child-own",
      e: "child-inc",
    });
    expect(composed.config.environments.base!.vars).toEqual({
      a: "top",
      b: "base-inc",
      c: "base-own",
      d: "base-inc",
      e: "top",
    });
    // definitions list lowest precedence first
    expect(
      composed.composition.environments.child!.vars.d!.definitions.map(
        (d) => d.scope + ":" + d.file.split("/").pop(),
      ),
    ).toEqual([
      "vars:cairntrace.config.yml",
      "environments.base.vars:base.yml",
      "environments.child.vars:child.yml",
      "environments.child.vars:cairntrace.config.yml",
    ]);
    // an include inside an environment include stays scoped to that environment
    expect(composed.composition.environments.base!.chain).toEqual(["base"]);
  });

  it("resolves var-to-var references across files and environments, once per environment", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
vars:
  apiUrl: "\${vars.host}/api"
environments:
  local:
    include: [local.yml]
  dev:
    include: [dev.yml]
`,
      "local.yml": "vars:\n  host: http://localhost\n",
      "dev.yml": "vars:\n  host: https://dev.example.test\n",
    });
    const composed = ok(result);
    expect(composed.config.environments.local!.vars!.apiUrl).toBe(
      "http://localhost/api",
    );
    expect(composed.config.environments.dev!.vars!.apiUrl).toBe(
      "https://dev.example.test/api",
    );
  });

  it("supports nested environment includes, globs, a file shared by two environments and ${config.dir}", async () => {
    const { result, root } = await compose({
      "cairntrace.config.yml": `version: 1
environments:
  one:
    include: [vars/one.yml]
  two:
    include: [vars/**/*.yml]
`,
      "vars/one.yml": `include: [common/shared.yml]
vars:
  own: one
  dir: "\${config.dir}/data"
`,
      "vars/common/shared.yml": "vars:\n  shared: yes\n",
      "vars/two/t.yml": "vars:\n  own: two\n",
    });
    const composed = ok(result);
    expect(composed.config.environments.one!.vars).toEqual({
      shared: "yes",
      own: "one",
      dir: `${root}/data`,
    });
    // the glob of "two" matches every file under vars/, one.yml included
    expect(composed.config.environments.two!.vars).toMatchObject({
      shared: "yes",
      own: "two",
    });
  });

  it("an environment with only an include (no inline vars) and an empty include file are valid", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
environments:
  local:
    include: [empty.yml]
`,
      "empty.yml": "",
    });
    const composed = ok(result);
    expect(composed.config.environments.local).toEqual({});
  });

  it("errors name the file: cycles, missing files, keys an environment file may not carry, a bad include shape", async () => {
    const cycle = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  local:
    include: [a.yml]
`,
          "a.yml": "include: [b.yml]\n",
          "b.yml": "include: [a.yml]\n",
        })
      ).result,
    );
    expect(cycle).toEqual([
      "include cycle: cairntrace.config.yml → a.yml → b.yml → a.yml",
    ]);
    const missing = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  local:
    include: [nope.yml]
`,
        })
      ).result,
    );
    expect(missing[0]).toMatch(/^include: nope\.yml does not exist/);
    const disallowed = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  local:
    include: [env.yml]
`,
          "env.yml": `fixtures:
  f: { kind: exec }
environments:
  other: {}
vars:
  bad: ~
`,
        })
      ).result,
    );
    expect(disallowed.join("\n")).toMatch(
      /env\.yml: \(root\): Unrecognized key\(s\) in object: 'fixtures', 'environments' \(a file listed by environments\.local\.include may carry vars and include/,
    );
    expect(disallowed.join("\n")).toMatch(/env\.yml: vars\.bad: /);
    const shape = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
environments:
  local:
    include: nope.yml
`,
        })
      ).result,
    );
    expect(shape[0]).toMatch(/^environments\.local\.include: /);
  });

  it("an environment declared only in an included file is an error that points at environments.<name>.include (no accidental environments)", async () => {
    const errors = errorsOf(
      (
        await compose({
          "cairntrace.config.yml": `version: 1
include: [more.yml]
environments:
  local: {}
`,
          "more.yml": "environments:\n  staging:\n    vars: { host: x }\n",
        })
      ).result,
    );
    expect(errors.join("\n")).toMatch(
      /more\.yml: \(root\): Unrecognized key\(s\) in object: 'environments'.*per-environment vars go in a file listed by environments\.<name>\.include/,
    );
  });

  it("warns when an environment glob matches no file", async () => {
    const { result } = await compose({
      "cairntrace.config.yml": `version: 1
environments:
  local:
    include: [vars/*.yml]
`,
    });
    const composed = ok(result);
    expect(composed.composition.findings.map((f) => f.code)).toEqual([
      "include-empty",
    ]);
  });

  it("keeps ${env.X} late-bound (never the value) when the vars come from an environment include", async () => {
    const root = await project({
      "cairntrace.config.yml": `version: 1
environments:
  local:
    include: [vars/local.yml]
`,
      "vars/local.yml": `vars:
  token: "\${env.SERVICE_TOKEN}"
  base: "\${env.SERVICE_URL:-http://localhost:9}"
  both: "\${vars.base}/x"
`,
    });
    const configPath = join(root, "cairntrace.config.yml");
    const { readFile } = await import("node:fs/promises");
    const result = await composeConfigText(await readFile(configPath, "utf8"), {
      configPath,
      env: {
        SERVICE_TOKEN: "super-secret-value",
        SERVICE_URL: "http://real.example",
      },
      envRef: (name) => `__LATE_${name}__`,
      late: {
        defaultRef: (name: string, fallback: string) =>
          `__LATE_${name}_DEFAULT_${fallback}__`,
        all: true,
      },
    });
    const composed = ok(result);
    expect(composed.config.environments.local!.vars).toEqual({
      token: "__LATE_SERVICE_TOKEN__",
      base: "__LATE_SERVICE_URL_DEFAULT_http://localhost:9__",
      both: "__LATE_SERVICE_URL_DEFAULT_http://localhost:9__/x",
    });
    expect(JSON.stringify(composed)).not.toContain("super-secret-value");
    expect(JSON.stringify(composed)).not.toContain("real.example");
  });

  it("splitting per-environment vars into files leaves every environment's effective vars unchanged", async () => {
    const fixture = join(FIXTURES, "..", "composition-env");
    const before = await loadConfig(
      "x",
      join(fixture, "before", "cairntrace.config.yml"),
    );
    const after = await loadConfig(
      "x",
      join(fixture, "after", "cairntrace.config.yml"),
    );
    const envs = ["local", "tunnel", "dev", "test"];
    expect(Object.keys(after!.config.environments)).toEqual(envs);
    for (const env of envs) {
      expect(after!.config.environments[env]!.vars, env).toEqual(
        before!.config.environments[env]!.vars,
      );
      expect(after!.config.environments[env]!.baseUrl, env).toBe(
        before!.config.environments[env]!.baseUrl,
      );
    }
    // different var sets per environment: nothing leaked into the others
    expect(
      Object.keys(after!.config.environments.test!.vars!).toSorted(),
    ).toEqual(["host", "tenant"]);
    expect(after!.config.environments.test!.vars).not.toHaveProperty(
      "devOnlyFlag",
    );
    expect(after!.composition!.files.map((f) => f.split("/").pop())).toEqual([
      "cairntrace.config.yml",
      "local.yml",
      "dev.yml",
      "test.yml",
    ]);
  });
});

describe("config composition — the automations-shaped fixture", () => {
  it("top-level vars + extends + include reproduce the anchored config's effective vars in every environment", async () => {
    const before = await loadConfig(
      "x",
      join(FIXTURES, "before", "cairntrace.config.yml"),
    );
    const after = await loadConfig(
      "x",
      join(FIXTURES, "after", "cairntrace.config.yml"),
    );
    const envs = ["local", "remote", "dev", "test"];
    expect(Object.keys(after!.config.environments)).toEqual(envs);
    const normalize = (
      vars: Record<string, unknown> | undefined,
      side: string,
    ) =>
      Object.fromEntries(
        Object.entries(vars ?? {})
          .map(([key, value]) => [
            key,
            // ${config.dir} differs by design (two fixture directories)
            typeof value === "string"
              ? value.replace(join(FIXTURES, side), "<config.dir>")
              : value,
          ])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      );
    for (const env of envs) {
      const b = before!.config.environments[env]!;
      const a = after!.config.environments[env]!;
      expect(normalize(a.vars, "after"), env).toEqual(
        normalize(b.vars, "before"),
      );
      expect(a.baseUrl, env).toBe(b.baseUrl);
      expect(a.waitScale, env).toBe(b.waitScale);
      expect(a.services, env).toEqual(b.services);
    }
    // from fewer written definitions (28 → 23 here; a large anchored config
    // shrinks the same way)
    expect(writtenDefinitions(before)).toBe(28);
    expect(writtenDefinitions(after)).toBe(23);
  });
});

/** Distinct `file:line` var definitions every environment reads. */
function writtenDefinitions(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
): number {
  return new Set(
    Object.values(loaded!.composition!.environments).flatMap((env) =>
      Object.values(env.vars).flatMap((v) =>
        v.definitions.map((d) => `${d.file}:${d.line}`),
      ),
    ),
  ).size;
}

describe("indexLocations", () => {
  it("indexes top-level sections, environment vars (own before merged) and extends lines", () => {
    const locations = indexLocations(`version: 1
vars:
  a: "\${env.X}"
environments:
  local:
    vars: &v
      b: 1
  dev:
    extends: local
    vars:
      <<: *v
      b: 2
fixtures:
  f: { kind: exec }
`);
    expect(locations.get("vars.a")).toEqual({
      line: 3,
      template: "${env.X}",
      fromEnvironment: true,
    });
    expect(locations.get("environments.dev.extends")).toEqual({ line: 9 });
    expect(locations.get("environments.dev.vars.b")).toEqual({ line: 12 });
    expect(locations.get("environments.local.vars.b")).toEqual({ line: 7 });
    expect(locations.get("fixtures.f")).toEqual({ line: 14 });
    expect(indexLocations("::: not yaml").size).toBe(0);
  });
});

const lateRef = (name: string): string => `__LATE_${name}__`;

describe("late binding (exporters)", () => {
  const ref = lateRef;
  const late = {
    defaultRef: (name: string, fallback: string) =>
      `__LATE_${name}_DEFAULT_${fallback}__`,
    all: true,
  };
  const text = `version: 1
webServer:
  command: run-app
  url: \${env.APP_URL:-http://localhost:9}
  readyTimeoutMs: \${env.READY_MS:-5000}
vars:
  token: \${env.API_TOKEN}
environments:
  local:
    baseUrl: http://localhost:9
`;
  const env = { APP_URL: "http://set.example", READY_MS: "1", API_TOKEN: "t" };

  it("fails on a typed field holding a late-bound reference without stand-ins", async () => {
    const result = await composeConfigText(text, {
      configPath: join(dir, "late-a.yml"),
      envRef: ref,
      env,
      late,
    });
    expect(result.ok).toBe(false);
  });

  it("fills typed fields with stand-ins (never env values) and lists their paths", async () => {
    const result = await composeConfigText(text, {
      configPath: join(dir, "late-b.yml"),
      envRef: ref,
      env,
      late: {
        ...late,
        standIns: (value: string) =>
          value.includes("__LATE_")
            ? ["not a url", 5000, "http://stand-in.invalid/"]
            : [],
      },
    });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.lateUnbound).toEqual([
      "webServer.readyTimeoutMs",
      "webServer.url",
    ]);
    expect(result.config.webServer?.url).toBe("http://stand-in.invalid/");
    expect(result.config.webServer?.readyTimeoutMs).toBe(5000);
    // A string field keeps its late-bound reference.
    expect(result.config.environments["local"]?.vars).toMatchObject({
      token: "__LATE_API_TOKEN__",
    });
    expect(JSON.stringify(result.config)).not.toContain("set.example");
  });
});
