/**
 * E10 / export v2 on `--project` / `--into`: how each `--preconditions` mode
 * shapes the generated tree, and what `--verifiers` / `${env.X:-default}` /
 * run steps / teardown / capture / fixtures / gates / poll emit there.
 */
import { describe, expect, it } from "vitest";
import type { ParseResult } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywrightProject } from "./playwrightProject";
import { envDefaultSentinel } from "./templateValue";

const ROOT = "/proj";

function spec(raw: Record<string, unknown>): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "host_modes",
    intent: "host commands export per mode",
    outcomes: [
      {
        id: "page_ok",
        description: "the page says hello",
        verify: { text: { contains: "hello" } },
      },
    ],
    ...raw,
  });
}

function parsed(authored: Spec, path = `${ROOT}/flows/a.yml`): ParseResult {
  return {
    spec: authored,
    resolved: authored,
    path,
    contractHashValid: true,
    origins: [],
    actionsByName: new Map(),
  };
}

type Result = ReturnType<typeof exportPlaywrightProject>;

const file = (result: Result, relPath: string): string | undefined =>
  result.files.find((f) => f.relPath === relPath)?.source;

const BASE = { projectRoot: ROOT, outDir: "/proj/exports" } as const;

const SPEC = spec({
  preconditions: {
    env: { TOKEN: "__CAIRN_SECRET_REF__API_TOKEN__" },
    wait: ["app_ready"],
    commands: [
      { name: "reset", run: "bun run reset", timeoutMs: 45_000 },
      { run: "psql -c 'select 1' | head -1", cwd: "../tools" },
      { run: "echo docs only" },
    ],
  },
  fixtures: [
    { use: "thing", with: { sku: "G-__CAIRN_RUN_TOKEN__" } },
    "other.reset",
  ],
  steps: [
    {
      id: "seed",
      run: { node: "../scripts/seed.mjs", args: ["create"], assign: "seeded" },
    },
    {
      open: "/p?sku=${fixtures.thing.sku}&id=${runs.seeded.id}",
    },
  ],
  teardown: [{ id: "clean", run: "node ../scripts/clean.mjs" }],
});

describe("default (no --preconditions): today's behavior", () => {
  const result = exportPlaywrightProject([parsed(SPEC)], BASE);

  it("keeps the per-file beforeAll with shell strings and cairnProjectRoot cwd", () => {
    const test = file(result, "tests/host_modes.spec.ts")!;
    expect(test).toContain(
      'import { runPrecondition } from "../preconditions";',
    );
    expect(test).toContain(
      'await runPrecondition("bun run reset", { cwd: join(cairnProjectRoot(), "flows"), timeoutMs: 45000',
    );
    expect(test).not.toContain("{ argv:");
    expect(test).not.toContain("docs only");
  });

  it("leaves run steps, teardown, fixtures and gates unexported", () => {
    const coverage = result.specs[0]!.coverage;
    expect(coverage.fixme).toBe(true);
    const reasons = coverage.skips.map((skip) => skip.reason).join("\n");
    expect(reasons).toContain("run step not exported");
    expect(reasons).toContain("fixtures not exported");
    expect(reasons).toContain(
      "only --preconditions global ensures them (through `cairn fixtures ensure`",
    );
    expect(
      coverage.diagnosticSkips.map((skip) => skip.reason).join("\n"),
    ).toContain("teardown not exported");
    expect(file(result, "global-setup.ts")).toContain(
      "per-spec preconditions run in each file's beforeAll",
    );
  });
});

describe("--preconditions inline", () => {
  const result = exportPlaywrightProject([parsed(SPEC)], {
    ...BASE,
    preconditions: "inline",
  });
  const test = file(result, "tests/host_modes.spec.ts")!;

  it("runs the preconditions through the bounded helper: argv spawn, cairnProjectPath cwd", () => {
    expect(test).toContain(
      'import { cairnCommand, cairnLastJson, cairnTestContext, runPrecondition } from "../preconditions";',
    );
    expect(test).toContain(
      'await runPrecondition({ argv: ["bun", "run", "reset"] }, { cwd: cairnProjectPath("flows"), timeoutMs: 45000',
    );
    expect(test).toContain(
      `await runPrecondition("psql -c 'select 1' | head -1", { cwd: cairnProjectPath("tools")`,
    );
    expect(test).toContain(
      'env: { "TOKEN": String(`${process.env.API_TOKEN ?? ""}`) }',
    );
    expect(test).toContain(
      'import { cairnProjectPath } from "../lib/projectRoot";',
    );
  });

  it("exports the run step and the teardown (finally) with ${runs.…} bound", () => {
    expect(test).toContain("let cairnRuns_seeded: unknown;");
    expect(test).toContain(
      'cairnRuns_seeded = cairnLastJson(await cairnCommand({ argv: ["node", cairnProjectPath("scripts/seed.mjs"), "create"] }',
    );
    expect(test).toContain('cairnSplice(cairnRuns_seeded, ["id"])');
    expect(test).toContain("finally {");
    expect(test).toContain(
      "cairnTestContext(test.info(), RUN_TOKEN, cairnRunStatus)",
    );
    expect(test).toContain('await test.step("teardown: clean", async () => {');
  });

  it("writes the helper module with every piece the unit calls", () => {
    const runtime = file(result, "preconditions.ts")!;
    for (const name of [
      "export async function cairnCommand(",
      "export async function runPrecondition(",
      "export function cairnLastJson(",
      "export function cairnTestContext(",
      "export function targetPreconditionEnv(",
    ]) {
      expect(runtime).toContain(name);
    }
    // Fixtures and gates are a global-mode feature.
    expect(
      result.specs[0]!.coverage.skips.map((skip) => skip.reason).join("\n"),
    ).toContain("fixtures not exported");
  });

  it("keeps command text and secrets out of the generated code", () => {
    const text = result.files.map((f) => f.source).join("\n");
    expect(text).toContain("process.env.API_TOKEN");
    expect(text).not.toMatch(/__CAIRN_[A-Z_]+__/i);
  });
});

describe("--preconditions global", () => {
  const result = exportPlaywrightProject([parsed(SPEC)], {
    ...BASE,
    preconditions: "global",
    configPath: `${ROOT}/cairntrace.config.yml`,
    envName: "local",
    fixtureScopes: { thing: "run", other: "suite" },
  });
  const setup = file(result, "global-setup.ts")!;
  const test = file(result, "tests/host_modes.spec.ts")!;

  it("runs gates, preconditions and fixtures once, in cairn's order", () => {
    const wait = setup.indexOf('"wait", "app_ready"');
    const pre = setup.indexOf("await runPrecondition({ argv:");
    const ensure = setup.indexOf('"fixtures", "ensure", "thing"');
    expect(wait).toBeGreaterThan(0);
    expect(pre).toBeGreaterThan(wait);
    expect(ensure).toBeGreaterThan(pre);
    expect(setup).toContain(
      '"--config", cairnProjectPath("cairntrace.config.yml"), "--env", "local"',
    );
    expect(setup).toContain('"--with", `sku=G-${RUN_TOKEN}`');
    // A reset runs after its ensure.
    expect(setup.indexOf('"fixtures", "reset", "other"')).toBeGreaterThan(
      setup.indexOf('"fixtures", "ensure", "other"'),
    );
    // One token for the setup and the workers.
    expect(setup).toContain("process.env.CAIRN_RUN_TOKEN ??=");
    expect(setup).toContain("process.env.CAIRN_FIXTURES_FILE = fixturesFile;");
    expect(setup).toContain(
      'const CAIRN_BIN = process.env.CAIRN_BIN ?? "cairn";',
    );
  });

  it("tears down only run-scoped fixtures, in a cleanup that also removes the outputs file", () => {
    expect(setup).toContain('"fixtures", "teardown", "thing"');
    expect(setup).not.toContain('"fixtures", "teardown", "other"');
    expect(setup).toContain("not run-scoped: cairn keeps it between runs");
    expect(setup).toContain("rmSync(fixturesDir");
    // A failing setup still cleans up what it created.
    expect(setup).toContain("await runCleanups();");
  });

  it("the test reads fixture outputs instead of a per-file hook", () => {
    expect(test).not.toContain("test.beforeAll");
    expect(test).toContain(
      'const cairnFixtures_thing = cairnFixtureOutputs("thing", ["sku"]);',
    );
    expect(test).toContain('cairnSplice(cairnFixtures_thing, ["sku"])');
    expect(test).toContain("Preconditions run once in global-setup");
    expect(file(result, "lib/fixtureOutputs.ts")).toContain(
      "CAIRN_FIXTURES_FILE",
    );
    // Run steps and teardown still run in the test body.
    expect(test).toContain("cairnLastJson(await cairnCommand(");
    expect(test).toContain("finally {");
  });

  it("reports what a global run loses against cairn run", () => {
    const risks = result.specs[0]!.coverage.semanticRisks.filter(
      (risk) => risk.kind === "globalPreconditions",
    )
      .map((risk) => risk.detail)
      .join("\n");
    expect(risks).toContain("run once in global-setup for the whole suite");
    expect(risks).toContain("stay live for the whole suite");
    expect(result.specs[0]!.coverage.fixme).toBe(false);
  });

  it("lists the secrets the setup reads, never their values", () => {
    expect(result.requiredEnv).toContain("API_TOKEN");
    expect(setup).toContain("process.env.API_TOKEN");
    expect(file(result, "README.md")).toContain("`CAIRN_BIN`");
  });

  it("--into writes the global setup too, with wiring instructions", () => {
    const into = exportPlaywrightProject([parsed(SPEC)], {
      ...BASE,
      into: true,
      preconditions: "global",
    });
    expect(file(into, "global-setup.ts")).toContain("fixtures");
    expect(file(into, "playwright.config.ts")).toBeUndefined();
    expect(file(into, "README.md")).toContain("globalSetup");
  });
});

describe("--preconditions skip and manifest", () => {
  for (const mode of ["skip", "manifest"] as const) {
    it(`${mode}: no hook, no helper module, the commands are reported`, () => {
      const result = exportPlaywrightProject([parsed(SPEC)], {
        ...BASE,
        preconditions: mode,
      });
      const test = file(result, "tests/host_modes.spec.ts")!;
      expect(test).not.toContain("test.beforeAll");
      expect(file(result, "preconditions.ts")).toBeUndefined();
      expect(file(result, "global-setup.ts")).toContain(
        mode === "skip"
          ? "--preconditions skip"
          : "listed in .cairn-export.json",
      );
      expect(result.specs[0]!.setup.preconditions.map((p) => p.run)).toEqual([
        "bun run reset",
        "psql -c 'select 1' | head -1",
      ]);
      expect(
        result.specs[0]!.coverage.semanticRisks.some(
          (risk) =>
            risk.kind === "requiredSetup" && risk.id === "preconditions",
        ),
      ).toBe(true);
    });
  }
});

describe("late-bound env in a project", () => {
  it("lists optional env separately and reads the default at run time", () => {
    const authored = spec({
      steps: [
        {
          open: `/p?r=${envDefaultSentinel("EXPORT_REGION", "eu")}&t=__CAIRN_SECRET_REF__EXPORT_TOKEN__`,
        },
      ],
    });
    const result = exportPlaywrightProject([parsed(authored)], {
      ...BASE,
      lateBoundEnv: true,
    });
    const test = file(result, "tests/host_modes.spec.ts")!;
    expect(test).toContain('(process.env.EXPORT_REGION || "eu")');
    expect(result.specs[0]!.optionalEnv).toEqual(["EXPORT_REGION"]);
    expect(result.specs[0]!.requiredEnv).toEqual(["EXPORT_TOKEN"]);
    const readme = file(result, "README.md")!;
    expect(readme).toContain("`EXPORT_REGION` — read at run time");
  });
});

describe("--verifiers in a project", () => {
  const authored = spec({
    outcomes: [
      {
        id: "db",
        description: "mongo has it",
        verify: {
          mongo: {
            source: "main",
            collection: "c",
            filter: {},
            expect: { count: 1 },
          },
        },
      },
    ],
  });
  it("gate: reports skipped at run time instead of marking the test fixme", () => {
    const result = exportPlaywrightProject([parsed(authored)], {
      ...BASE,
      verifiers: "gate",
      datasourceEnv: { main: ["MONGO_URI"] },
    });
    const test = file(result, "tests/host_modes.spec.ts")!;
    expect(test).toContain("test.skip(cairnSkipped.length > 0");
    expect(test).not.toContain("test.fixme");
    expect(test).toContain("needs MONGO_URI");
    expect(file(result, "README.md")).toContain("--verifiers gate");
  });

  it("keep (default): the datasource verifier is a hard skip", () => {
    const result = exportPlaywrightProject([parsed(authored)], BASE);
    expect(file(result, "tests/host_modes.spec.ts")).toContain("test.fixme(");
  });

  it("drop: omitted with a risk", () => {
    const result = exportPlaywrightProject([parsed(authored)], {
      ...BASE,
      verifiers: "drop",
    });
    expect(
      result.specs[0]!.coverage.semanticRisks.some(
        (risk) => risk.kind === "verifierDropped",
      ),
    ).toBe(true);
  });
});

describe("capture and poll in a project", () => {
  it("imports the probe and poll helpers from lib/", () => {
    const authored = spec({
      steps: [
        {
          id: "cap",
          capture: { assign: "t", text: { by: "role", role: "heading" } },
        },
        { open: "/x?t=${captures.t}" },
      ],
      outcomes: [
        {
          id: "stays",
          description: "stays",
          verify: {
            text: { contains: "done" },
            poll: { timeoutMs: 5000, stableMs: 1000 },
          },
        },
      ],
    });
    const result = exportPlaywrightProject([parsed(authored)], BASE);
    const test = file(result, "tests/host_modes.spec.ts")!;
    expect(test).toContain('import { cairnCapture } from "../lib/probe";');
    expect(test).toContain('import { cairnPoll } from "../lib/poll";');
    expect(file(result, "lib/probe.ts")).toContain(
      "export async function cairnCapture(",
    );
    expect(file(result, "lib/poll.ts")).toContain(
      "export async function cairnPoll(",
    );
    expect(result.specs[0]!.coverage.fixme).toBe(false);
  });
});
