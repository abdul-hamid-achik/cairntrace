import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCatalog } from "../catalog/buildCatalog";
import {
  CatalogResultSchema,
  SuitesListResultSchema,
} from "../catalog/catalog.v1";
import { composeConfigText } from "../config/compose";
import { SuiteError, SuiteResolver, selectSuite } from "./resolve";
import { SuiteSchema, SuitesRegistrySchema } from "./schema";
import { validateSuites } from "./validate";

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-suites-unit-"));
});

const spec = (name: string, tags: string[] = []): string => `version: 1
name: ${name}
intent: Check ${name}.
${tags.length > 0 ? `metadata:\n  tags: [${tags.join(", ")}]\n` : ""}steps:
  - open: https://demo.example.test/${name}
outcomes:
  - id: ok
    description: it is open
    verify: { url: { matches: "/${name}" } }
`;

async function project(
  files: Record<string, string>,
): Promise<{ root: string; configPath: string }> {
  const root = join(dir, `p${++counter}`);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return { root, configPath: join(root, "cairntrace.config.yml") };
}

const FLOWS = {
  "flows/a.yml": spec("alpha", ["smoke"]),
  "flows/b.yml": spec("bravo"),
  "flows/sub/c.yml": spec("charlie", ["smoke", "slow"]),
  "flows/sub/_draft.yml": spec("wip"),
  "flows/_old/d.yml": spec("delta"),
  "flows/actions/shared.yml":
    "version: 1\nname: shared_action\nsteps:\n  - open: https://demo.example.test/x\n",
};

const CONFIG_HEAD = `version: 1
project: unit
defaultEnvironment: local
environments:
  local: { baseUrl: https://demo.example.test }
  staging: { baseUrl: https://staging.example.test }
`;

describe("suite schema", () => {
  it("needs something to select specs with", () => {
    expect(SuiteSchema.safeParse({ parallel: 2 }).success).toBe(false);
    expect(SuiteSchema.safeParse({ tags: ["x"] }).success).toBe(true);
    expect(SuiteSchema.safeParse({ order: ["a"] }).success).toBe(true);
    // Only an environment lists specs: still a selection.
    expect(
      SuiteSchema.safeParse({ env: { staging: { specs: ["a.yml"] } } }).success,
    ).toBe(true);
  });

  it("is strict, names suites safely and bounds hook timeouts", () => {
    expect(SuiteSchema.safeParse({ specs: ["a"], nope: 1 }).success).toBe(
      false,
    );
    expect(
      SuitesRegistrySchema.safeParse({ "bad name": { specs: ["a"] } }).success,
    ).toBe(false);
    expect(
      SuiteSchema.safeParse({ specs: ["a"], hookTimeoutMs: 8_000_000 }).success,
    ).toBe(false);
    expect(
      SuiteSchema.safeParse({
        specs: ["a"],
        env: {
          staging: { vars: { n: 1, b: true, s: "x" }, hookTimeoutMs: 100 },
        },
        requires: { env: ["staging"], vars: ["n"] },
        seed: { postCommands: { skip: ["x"] } },
      }).success,
    ).toBe(true);
  });
});

describe("suite processEnv, labels, per-environment bail and seed skips", () => {
  it("validates process env names and label keys", () => {
    const ok = SuiteSchema.safeParse({
      specs: ["a"],
      processEnv: {
        ENGINE_MODE: "durable",
        RETRIES: 3,
        CAIRN_RUNTIME_ROUND: "r",
      },
      labels: { cohort: "a", round: 2 },
      env: {
        staging: {
          bail: false,
          processEnv: { ENGINE_MODE: "x" },
          labels: { cohort: "b" },
          seed: { postCommands: { skip: ["kit"] } },
        },
      },
    });
    expect(ok.success).toBe(true);
    for (const name of [
      "PATH",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "TVAULT_TOKEN",
      "CAIRN_SUITE",
      "CAIRN_SUITE_VAR_X",
      "CAIRN_EXIT_CODE",
      "CAIRN_RUN_LOCK",
      "1BAD",
      "has-dash",
    ]) {
      expect(
        SuiteSchema.safeParse({ specs: ["a"], processEnv: { [name]: "x" } })
          .success,
        name,
      ).toBe(false);
    }
    expect(
      SuiteSchema.safeParse({ specs: ["a"], labels: { "a=b": "x" } }).success,
    ).toBe(false);
    expect(
      SuiteSchema.safeParse({ specs: ["a"], labels: { "a b": "x" } }).success,
    ).toBe(false);
  });

  it("resolves them per environment (the environment's win; skips add up)", async () => {
    const { root } = await project(FLOWS);
    const suite = SuiteSchema.parse({
      specs: ["flows/a.yml"],
      bail: true,
      processEnv: { MODE: "base", KEEP: 1 },
      labels: { cohort: "a", round: "r1" },
      seed: { postCommands: { skip: ["s0"] } },
      env: {
        staging: {
          bail: false,
          processEnv: { MODE: "staging" },
          labels: { round: "r2" },
          seed: { postCommands: { skip: ["s1", "s0"] } },
        },
      },
    });
    const resolver = new SuiteResolver({ configDir: root });
    const staging = await resolver.resolve({
      name: "p",
      suite,
      envName: "staging",
    });
    expect(staging).toMatchObject({
      bail: false,
      processEnv: { MODE: "staging", KEEP: "1" },
      labels: { cohort: "a", round: "r2" },
      seedSkip: ["s0", "s1"],
    });
    const local = await resolver.resolve({
      name: "p",
      suite,
      envName: "local",
    });
    expect(local).toMatchObject({
      bail: true,
      processEnv: { MODE: "base", KEEP: "1" },
      labels: { cohort: "a", round: "r1" },
      seedSkip: ["s0"],
    });
  });
});

describe("config integration", () => {
  it("rejects a suite that names an environment the config lacks", async () => {
    const { configPath } = await project({
      "cairntrace.config.yml": `${CONFIG_HEAD}suites:
  s:
    specs: [flows/a.yml]
    env: { prod: { vars: { a: b } } }
    requires: { env: [local, qa] }
`,
    });
    const composed = await composeConfigText(
      await readFile(configPath, "utf8"),
      { configPath, env: {} },
    );
    expect(composed.ok).toBe(false);
    const errors = (composed as unknown as { errors: string[] }).errors.join(
      "\n",
    );
    expect(errors).toContain('unknown environment "prod"');
    expect(errors).toContain('unknown environment "qa"');
  });

  it("merges suites through include: (later wins, the including file wins, overrides are findings)", async () => {
    const { configPath } = await project({
      "cairntrace.config.yml": `${CONFIG_HEAD}include: [suites/*.yml]
suites:
  mine: { specs: [flows/b.yml] }
  shared: { specs: [flows/a.yml], description: from the config }
`,
      "suites/one.yml": `suites:
  shared: { specs: [flows/b.yml] }
  only-one: { specs: [flows/a.yml] }
`,
      "suites/two.yml": `suites:
  only-one: { specs: [flows/b.yml], parallel: 3 }
`,
    });
    const composed = await composeConfigText(
      await readFile(configPath, "utf8"),
      { configPath, env: {} },
    );
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(Object.keys(composed.config.suites ?? {}).toSorted()).toEqual([
      "mine",
      "only-one",
      "shared",
    ]);
    expect(composed.config.suites!["only-one"]).toMatchObject({
      specs: ["flows/b.yml"],
      parallel: 3,
    });
    expect(composed.config.suites!.shared!.description).toBe("from the config");
    const overrides = composed.composition.findings
      .filter((f) => f.code === "include-override")
      .map((f) => f.key);
    expect(overrides).toEqual(
      expect.arrayContaining(["suites.only-one", "suites.shared"]),
    );
  });
});

describe("SuiteResolver", () => {
  it("resolves paths, directories, globs, names and tags; drafts only by explicit path", async () => {
    const { root } = await project(FLOWS);
    const resolver = new SuiteResolver({ configDir: root });
    const names = async (suite: Record<string, unknown>, envName = "local") =>
      (
        await resolver.resolve({
          name: "t",
          suite: SuiteSchema.parse(suite),
          envName,
        })
      ).specs.map((p) => p.slice(root.length + 1));
    expect(await names({ specs: ["flows"] })).toEqual([
      "flows/a.yml",
      "flows/b.yml",
      "flows/sub/c.yml",
    ]);
    expect(await names({ specs: ["flows/**"] })).toEqual([
      "flows/a.yml",
      "flows/b.yml",
      "flows/sub/c.yml",
    ]);
    expect(await names({ specs: ["flows/*/*.yml"] })).toEqual([
      "flows/sub/c.yml",
    ]);
    expect(await names({ specs: ["alpha", "charlie"] })).toEqual([
      "flows/a.yml",
      "flows/sub/c.yml",
    ]);
    expect(await names({ tags: ["SMOKE"] })).toEqual([
      "flows/a.yml",
      "flows/sub/c.yml",
    ]);
    expect(await names({ specs: ["flows"], tags: ["smoke", "slow"] })).toEqual([
      "flows/sub/c.yml",
    ]);
    // Naming a draft file by path runs it.
    expect(await names({ specs: ["flows/sub/_draft.yml"] })).toEqual([
      "flows/sub/_draft.yml",
    ]);
    // A draft folder named explicitly is a directory like any other.
    expect(await names({ specs: ["flows/_old"] })).toEqual([
      "flows/_old/d.yml",
    ]);
    // De-duplicated, first mention wins; order puts named specs first.
    expect(
      await names({
        specs: ["flows/b.yml", "flows"],
        order: ["charlie", "alpha"],
      }),
    ).toEqual(["flows/sub/c.yml", "flows/a.yml", "flows/b.yml"]);
    // An environment's `specs` replaces the base list.
    expect(
      await names(
        {
          specs: ["flows/a.yml"],
          env: { staging: { specs: ["flows/b.yml"] } },
        },
        "staging",
      ),
    ).toEqual(["flows/b.yml"]);
  });

  it("merges hooks (suite then environment), vars and timeouts", async () => {
    const { root } = await project(FLOWS);
    const resolved = await new SuiteResolver({ configDir: root }).resolve({
      name: "h",
      suite: SuiteSchema.parse({
        specs: ["flows/a.yml"],
        before: ["b0"],
        after: ["a0"],
        vars: { x: 1, y: "base" },
        hookTimeoutMs: 1000,
        parallel: 2,
        bail: true,
        seed: { postCommands: { skip: ["s"] } },
        env: {
          staging: {
            before: ["b1"],
            after: ["a1"],
            vars: { y: "env", z: true },
            hookTimeoutMs: 2000,
          },
        },
      }),
      envName: "staging",
    });
    expect(resolved).toMatchObject({
      before: ["b0", "b1"],
      after: ["a0", "a1"],
      vars: { x: "1", y: "env", z: "true" },
      hookTimeoutMs: 2000,
      parallel: 2,
      bail: true,
      seedSkip: ["s"],
    });
  });

  it("explains what it cannot resolve", async () => {
    const { root } = await project(FLOWS);
    const resolver = new SuiteResolver({ configDir: root });
    const fail = async (suite: Record<string, unknown>) =>
      resolver
        .resolve({
          name: "t",
          suite: SuiteSchema.parse(suite),
          envName: "local",
        })
        .then(
          () => undefined,
          (error: unknown) => error as SuiteError,
        );
    expect((await fail({ specs: ["nope.yml"] }))!.message).toContain(
      "is not a spec file, directory, glob or spec name",
    );
    expect((await fail({ specs: ["flows/zzz/*.yml"] }))!.message).toContain(
      "matches no spec file",
    );
    expect((await fail({ specs: ["wip"] }))!.message).toContain("is a draft");
    expect(
      (await fail({ specs: ["flows"], tags: ["none"] }))!.message,
    ).toContain("selects no specs");
    expect(
      (await fail({ specs: ["flows/a.yml"], order: ["bravo"] }))!.message,
    ).toContain("is not in the suite's selection");
    const refused = await fail({
      specs: ["flows/a.yml"],
      requires: { env: "staging" },
    });
    expect(refused).toMatchObject({ exitCode: 7 });
    expect(() => selectSuite(undefined, "x", "cfg.yml")).toThrow(
      'unknown suite "x" (cfg.yml defines: none)',
    );
  });

  it("ignores spec copies inside run directories and skipped directories", async () => {
    const { root } = await project({
      ...FLOWS,
      "runs/2026-01-01_alpha_abc/spec.resolved.yml": spec("alpha"),
      "other-runs/x/y.yml": spec("alpha"),
    });
    const resolver = new SuiteResolver({
      configDir: root,
      skipDirs: [join(root, "other-runs")],
    });
    const resolved = await resolver.resolve({
      name: "t",
      suite: SuiteSchema.parse({ specs: ["alpha"] }),
      envName: "local",
    });
    expect(resolved.specs).toEqual([join(root, "flows", "a.yml")]);
  });
});

describe("suite globs", () => {
  it("expand past the config include cap, skip the artifact root, and keep only specs", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 620; i++) {
      files[`flows/many/s${String(i).padStart(3, "0")}.yml`] = spec(`s${i}`);
    }
    // Run copies and other YAML under the artifact root never count.
    for (let i = 0; i < 50; i++) {
      files[`flows/runs/r${i}/run.yaml`] = "status: passed\n";
      files[`flows/runs/r${i}/spec.resolved.yml`] = spec("copy");
    }
    files["flows/many/notes.yml"] = "just: data\n";
    const { root } = await project(files);
    const resolver = new SuiteResolver({
      configDir: root,
      skipDirs: [join(root, "flows", "runs")],
    });
    const resolved = await resolver.resolve({
      name: "t",
      suite: SuiteSchema.parse({ specs: ["flows/**/*.yml"] }),
      envName: "local",
    });
    expect(resolved.specs).toHaveLength(620);
    expect(resolved.specs.some((path) => path.includes("runs"))).toBe(false);
  });

  it("is an error, never a silent cut, when a glob matches more than the cap", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5_001; i++) {
      files[`flows/huge/x${i}.yml`] = "a: 1\n";
    }
    const { root } = await project(files);
    const resolver = new SuiteResolver({ configDir: root });
    await expect(
      resolver.resolve({
        name: "t",
        suite: SuiteSchema.parse({ specs: ["flows/huge/*.yml"] }),
        envName: "local",
      }),
    ).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringMatching(/matches more than 5000 YAML files/),
    });
  }, 30_000);
});

describe("validateSuites and the catalog", () => {
  it("reports unresolvable suites once, skips `requires` refusals and warns on a stray seed skip", async () => {
    const { root, configPath } = await project({
      ...FLOWS,
      "cairntrace.config.yml": `${CONFIG_HEAD}services:
  seed:
    command: "true"
    postCommands: ["echo one", { name: named-two, run: "echo two" }]
suites:
  fine: { specs: [flows/a.yml] }
  by-name:
    specs: [flows/a.yml]
    seed: { postCommands: { skip: [named-two, "echo one"] } }
  broken: { specs: [flows/gone.yml] }
  half:
    specs: [flows/a.yml]
    env: { staging: { specs: [flows/gone.yml] } }
  staging-only:
    specs: [flows/a.yml]
    requires: { env: staging }
  typo:
    specs: [flows/a.yml]
    seed: { postCommands: { skip: ["echo two"] } }
`,
    });
    const composed = await composeConfigText(
      await readFile(configPath, "utf8"),
      { configPath, env: {} },
    );
    if (!composed.ok) throw new Error(JSON.stringify(composed.errors));
    const { errors, warnings } = await validateSuites(composed.config, root);
    expect(errors).toEqual([
      expect.stringContaining(
        'suites.broken: suite "broken" specs: "flows/gone.yml" is not a spec file',
      ),
      expect.stringContaining("suites.half (env staging):"),
    ]);
    expect(warnings).toEqual([
      // A named post-command is matched by its name, never by its command text.
      'suites.typo.seed.postCommands.skip: "echo two" matches no seed postCommand of the config (a plain command is matched by its text, a named one by its name)',
    ]);
  });

  it("errors on suite vars that reach hooks as the same CAIRN_SUITE_VAR_<NAME>", async () => {
    const { root, configPath } = await project({
      ...FLOWS,
      "cairntrace.config.yml": `${CONFIG_HEAD}suites:
  clash:
    specs: [flows/a.yml]
    vars: { a-b: one, a_b: two }
  env-clash:
    specs: [flows/a.yml]
    vars: { region: eu }
    env: { staging: { vars: { Region: us } } }
  fine:
    specs: [flows/a.yml]
    vars: { region: eu }
    env: { staging: { vars: { region: us } } }
`,
    });
    const composed = await composeConfigText(
      await readFile(configPath, "utf8"),
      { configPath, env: {} },
    );
    if (!composed.ok) throw new Error(JSON.stringify(composed.errors));
    const { errors } = await validateSuites(composed.config, root);
    expect(errors).toEqual([
      "suites.clash: vars a-b and a_b both reach hooks as CAIRN_SUITE_VAR_A_B; rename one",
      "suites.env-clash (env staging): vars Region and region both reach hooks as CAIRN_SUITE_VAR_REGION; rename one",
    ]);
  });

  it("lists suites in the catalog with their resolved specs per environment", async () => {
    const { root, configPath } = await project({
      ...FLOWS,
      "cairntrace.config.yml": `${CONFIG_HEAD}suites:
  smoke:
    description: Fast checks
    tags: [smoke]
    parallel: 2
    vars: { region: eu }
    env:
      staging:
        before: ["./warm.sh"]
        after: ["./collect.sh"]
        hookTimeoutMs: 5000
  nightly:
    specs: [flows]
    requires: { env: staging }
    bail: true
`,
    });
    const catalog = await buildCatalog({
      config: configPath,
      kinds: ["suites"],
      artifactRoot: join(root, "runs"),
    });
    expect(CatalogResultSchema.safeParse(catalog).success).toBe(true);
    expect(catalog.totals.suites).toBe(2);
    const byName = Object.fromEntries(
      (catalog.suites ?? []).map((s) => [s.name, s]),
    );
    expect(byName.smoke).toMatchObject({
      description: "Fast checks",
      tags: ["smoke"],
      parallel: 2,
    });
    expect(byName.smoke!.envs).toEqual([
      {
        env: "local",
        specs: ["flows/a.yml", "flows/sub/c.yml"],
        vars: ["region"],
        before: 0,
        after: 0,
      },
      {
        env: "staging",
        specs: ["flows/a.yml", "flows/sub/c.yml"],
        vars: ["region"],
        before: 1,
        after: 1,
        hookTimeoutMs: 5000,
      },
    ]);
    // The hook commands themselves are not in the catalog.
    expect(JSON.stringify(catalog)).not.toContain("warm.sh");
    expect(byName.nightly!.envs[0]).toMatchObject({
      env: "local",
      specs: [],
      problem: expect.stringContaining("requires environment staging"),
    });
    expect(byName.nightly!.envs[1]!.specs).toHaveLength(3);
    expect(
      SuitesListResultSchema.safeParse({
        $schema: "urn:cairntrace.dev:suites:v1",
        version: "1",
        root: catalog.root,
        suites: catalog.suites,
        warnings: [],
      }).success,
    ).toBe(true);
    // Narrowed to one environment.
    const staging = await buildCatalog({
      config: configPath,
      kinds: ["suites"],
      env: "staging",
      artifactRoot: join(root, "runs"),
    });
    expect(staging.suites![0]!.envs.map((e) => e.env)).toEqual(["staging"]);
  });
});
