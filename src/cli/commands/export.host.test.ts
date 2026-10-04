/**
 * E8 / E12 through the CLI code paths: exporting `--into` a CommonJS and an ES
 * module host tree adapts the generated code to the host's Playwright config
 * (and proves it with the host's own tsc), `export.targets` profiles resolve
 * under the command line, and `--max-eval-ratio` refuses over-limit specs.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPORT_MANIFEST_FILE,
  type ExportManifestV1,
} from "../../core/exporters/exportManifest";
import {
  linkHostToolchain,
  writeCjsHost,
  writeEsmHost,
  type HostTree,
} from "../../testing/hostTrees";
import {
  buildProjectExport,
  checkPlaywrightExport,
  writeBatchExport,
  writeProjectExport,
} from "./export";
import { applyExportTarget, ExportRefusedError } from "./exportHost";
import { verifyPlaywrightExport } from "./exportVerify";
import { expandSpecArgs } from "./run";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const CAIRN = join(REPO_ROOT, "bin", "cairn");

const roots: string[] = [];
function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cairn-host-export-")));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const ALPHA = `version: 1
name: alpha_flow
intent: alpha shows its heading
coldStart: guest
outcomes:
  - id: heading
    description: heading visible
    verify:
      text: { contains: Alpha }
steps:
  - id: open_alpha
    open: http://localhost:8787/alpha.html
  - id: pick_save
    click: { by: testid, testid: save-button }
`;

/** Uses the page probe (lib/) and a precondition (lib/projectRoot + preconditions). */
const CAPTURE = `version: 1
name: capture_flow
intent: a table capture and a precondition
coldStart: guest
preconditions:
  commands:
    - run: node --version
outcomes:
  - id: heading
    description: heading visible
    verify:
      text: { contains: Totals }
steps:
  - id: open_table
    open: http://localhost:8787/table.html
  - id: grab
    capture:
      assign: rows
      table: { by: role, role: table }
`;

/** Two of its three steps are page eval. */
const EVALS = `version: 1
name: eval_flow
intent: seeds state through page evals
coldStart: guest
outcomes:
  - id: heading
    description: heading visible
    verify:
      text: { contains: Seeded }
steps:
  - id: open_it
    open: http://localhost:8787/
  - id: seed_a
    eval: { js: "window.__a = 1;" }
  - id: seed_b
    eval: { js: "window.__b = 2;" }
`;

function sourceTree(root: string, specs: Record<string, string>): string {
  const flows = join(root, "flows");
  mkdirSync(flows, { recursive: true });
  for (const [name, text] of Object.entries(specs)) {
    writeFileSync(join(flows, `${name}.yml`), text);
  }
  return flows;
}

function hostScenario(
  kind: "cjs" | "esm",
  specs: Record<string, string>,
  prettier = false,
): { tree: HostTree; flows: string; source: string; log: string } {
  const root = tmpRoot();
  const hostRoot = join(root, "host");
  const tree = kind === "cjs" ? writeCjsHost(hostRoot) : writeEsmHost(hostRoot);
  const log = join(root, "prettier.log");
  linkHostToolchain(hostRoot, { eslint: true, prettier, prettierLog: log });
  const source = join(root, "src");
  return { tree, flows: sourceTree(source, specs), source, log };
}

const text = (path: string): string => readFileSync(path, "utf8");

async function exportInto(
  scenario: { tree: HostTree; flows: string },
  extra: Record<string, unknown> = {},
) {
  const paths = await expandSpecArgs([scenario.flows]);
  return writeProjectExport(
    paths,
    "ts",
    {
      into: scenario.tree.into,
      outDir: scenario.tree.into,
      hostConfig: scenario.tree.config,
      ...extra,
    },
    scenario.flows,
  );
}

async function tsc(
  tree: HostTree,
  project: string,
): Promise<{ exitCode: number; output: string }> {
  const bin = join(tree.root, "node_modules", ".bin", "tsc");
  const run = await execa(
    bin,
    ["--noEmit", "--pretty", "false", "-p", project],
    {
      cwd: dirname(project),
      reject: false,
      timeout: 120_000,
    },
  );
  return {
    exitCode: run.exitCode ?? 1,
    output: `${run.stdout}\n${run.stderr}`,
  };
}

describe("export --into a CommonJS host (--host-config)", () => {
  it("adapts layout, imports, timeouts and test ids, and compiles under the host's tsconfig", async () => {
    const scenario = hostScenario("cjs", {
      alpha: ALPHA,
      capture: CAPTURE,
    });
    const report = await exportInto(scenario);
    const { into } = scenario.tree;

    // Layout: tests flat in the --into folder (inside the host's testDir).
    expect(report.specs.map((spec) => spec.file).toSorted()).toEqual([
      "alpha_flow.spec.ts",
      "capture_flow.spec.ts",
    ]);
    expect(report.host).toMatchObject({
      config: "../../playwright.config.ts",
      moduleSystem: "cjs",
      testTimeoutMs: 120000,
      testIdAttribute: "data-qa-key",
      testsDir: ".",
      testSuffix: ".spec",
      bypassCsp: true,
      alias: "@e2e/",
    });

    const alpha = text(join(into, "alpha_flow.spec.ts"));
    // The derived budget (150s) is above the host's 120s: raised for this spec.
    expect(alpha).toContain("test.setTimeout(150000);");
    expect(alpha).toContain("Above the host's test timeout (120000ms)");
    // The host reads data-qa-key; the spec means data-testid: explicit selector.
    expect(alpha).not.toContain("getByTestId");
    expect(alpha).toContain(`[data-testid=\\"save-button\\"]`);

    // Module plumbing for a CommonJS host.
    const capture = text(join(into, "capture_flow.spec.ts"));
    expect(capture).toContain(`from "@e2e/tests/cairn/lib/probe"`);
    const projectRoot = text(join(into, "lib", "projectRoot.ts"));
    expect(projectRoot).toContain("__dirname");
    expect(projectRoot).not.toContain("import.meta");

    // The host's own tsc (strict + noUnusedLocals + noImplicitReturns, paths).
    const compiled = await tsc(
      scenario.tree,
      join(scenario.tree.e2e, "tsconfig.json"),
    );
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("verifies on the host profile: tsc with the host tsconfig, the host's eslint, playwright --list with the host config", async () => {
    const scenario = hostScenario("cjs", {
      alpha: ALPHA,
      capture: CAPTURE,
    });
    await exportInto(scenario);
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: scenario.tree.into,
    });
    const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
    expect(gates["sentinels"]?.status).toBe("passed");
    expect(gates["freshness"]?.status).toBe("passed");
    expect(gates["typecheck"]).toMatchObject({ status: "passed" });
    expect(gates["typecheck"]?.summary).toContain("tsconfig.json");
    expect(gates["lint"]).toMatchObject({ status: "passed" });
    expect(gates["list"]?.status, gates["list"]?.summary).toBe("passed");
    expect(exitCode).toBe(0);
  }, 240_000);

  it("fails the host's lint when the tree is not what the host's rules accept", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    await exportInto(scenario);
    // Hand edit: an unbraced if (the host's `curly` rule), then verify.
    const file = join(scenario.tree.into, "alpha_flow.spec.ts");
    writeFileSync(
      file,
      `${text(file)}\nif (process.env.X) console.log("x");\n`,
    );
    const { report } = await verifyPlaywrightExport({
      exportDir: scenario.tree.into,
      write: false,
    });
    const lint = report.gates.find((gate) => gate.id === "lint");
    expect(lint?.status).toBe("failed");
    expect(lint?.findings?.join("\n")).toContain("curly");
  }, 120_000);

  it("fails the typecheck gate on a type error, under the host's tsconfig (not a vacuous pass)", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    await exportInto(scenario);
    const file = join(scenario.tree.into, "alpha_flow.spec.ts");
    writeFileSync(
      file,
      `${text(file)}\nexport const wrong: number = "text";\n`,
    );
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: scenario.tree.into,
      write: false,
    });
    const typecheck = report.gates.find((gate) => gate.id === "typecheck");
    expect(typecheck?.status).toBe("failed");
    expect(typecheck?.findings?.[0]).toMatch(
      /^alpha_flow\.spec\.ts:\d+: TS2322 /,
    );
    expect(exitCode).toBe(1);
  }, 120_000);

  it("formats generated and copied files with the host's local prettier (a fixed point --check reproduces)", async () => {
    const scenario = hostScenario(
      "cjs",
      { alpha: ALPHA, capture: CAPTURE },
      true,
    );
    const report = await exportInto(scenario);
    expect(report.host?.formatted).toBeGreaterThan(0);
    const alpha = text(join(scenario.tree.into, "alpha_flow.spec.ts"));
    expect(alpha.endsWith("// formatted by host prettier\n")).toBe(true);
    // Each file went through `--stdin-filepath <its final path>`.
    const logged = readFileSync(scenario.log, "utf8");
    expect(logged).toContain(join(scenario.tree.into, "alpha_flow.spec.ts"));
    expect(logged).toContain(join(scenario.tree.into, "lib", "probe.ts"));
    // The manifest hashes the formatted text, so the check regenerates it identically.
    const { report: check, exitCode } = await checkPlaywrightExport(
      scenario.tree.into,
      undefined,
      {},
    );
    expect(check.status, JSON.stringify(check.files)).toBe("fresh");
    expect(exitCode).toBe(0);
    const manifest = JSON.parse(
      text(join(scenario.tree.into, EXPORT_MANIFEST_FILE)),
    ) as ExportManifestV1;
    expect(manifest.source.hostConfig).toBe("../../playwright.config.ts");
  }, 120_000);

  it("leaves files as generated when prettier is configured but not installed", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA }, false);
    const report = await exportInto(scenario);
    expect(report.host?.formatted).toBe(0);
    expect(report.host?.notes.join("\n")).toContain(
      "no local node_modules/.bin/prettier",
    );
  });

  it("emits no test.setTimeout when the host's timeout covers the budget", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    const config = scenario.tree.config;
    writeFileSync(
      config,
      text(config).replace("timeout: 120000", "timeout: 600000"),
    );
    await exportInto(scenario);
    const alpha = text(join(scenario.tree.into, "alpha_flow.spec.ts"));
    expect(alpha).not.toContain("test.setTimeout");
    expect(alpha).toContain("The host's test timeout (600000ms) covers");
  });

  it("refuses an --into outside the host's testDir", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    const elsewhere = join(scenario.tree.e2e, "scratch");
    const paths = await expandSpecArgs([scenario.flows]);
    await expect(
      writeProjectExport(
        paths,
        "ts",
        {
          into: elsewhere,
          outDir: elsewhere,
          hostConfig: scenario.tree.config,
        },
        scenario.flows,
      ),
    ).rejects.toThrow(/neither contains nor sits inside/);
  });

  it("is unchanged without --host-config (tests/<name>.spec.ts, import.meta in lib)", async () => {
    const scenario = hostScenario("cjs", { capture: CAPTURE });
    const paths = await expandSpecArgs([scenario.flows]);
    const report = await writeProjectExport(
      paths,
      "ts",
      { into: scenario.tree.into, outDir: scenario.tree.into },
      scenario.flows,
    );
    expect(report.specs[0]?.file).toBe("tests/capture_flow.spec.ts");
    expect(report.host).toBeUndefined();
    expect(text(join(scenario.tree.into, "lib", "projectRoot.ts"))).toContain(
      "import.meta.url",
    );
  });
});

describe("export --into an ES module host (--host-config)", () => {
  it("names tests per testMatch, keeps import.meta, adds .js extensions, and compiles under nodenext", async () => {
    const scenario = hostScenario("esm", { alpha: ALPHA, capture: CAPTURE });
    const report = await exportInto(scenario);
    const { into } = scenario.tree;
    expect(report.specs.map((spec) => spec.file).toSorted()).toEqual([
      "alpha_flow.e2e.ts",
      "capture_flow.e2e.ts",
    ]);
    expect(report.host).toMatchObject({
      moduleSystem: "esm",
      testSuffix: ".e2e",
      testTimeoutMs: 45000,
      testIdAttribute: "data-test",
      bypassCsp: true,
    });
    const capture = text(join(into, "capture_flow.e2e.ts"));
    expect(capture).toContain(`from "./lib/probe.js"`);
    const projectRoot = text(join(into, "lib", "projectRoot.ts"));
    expect(projectRoot).toContain("import.meta.url");
    expect(projectRoot).not.toContain("__dirname");

    const compiled = await tsc(
      scenario.tree,
      join(scenario.tree.e2e, "tsconfig.json"),
    );
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("verifies with the host config named by the manifest", async () => {
    const scenario = hostScenario("esm", { alpha: ALPHA });
    await exportInto(scenario);
    const { report } = await verifyPlaywrightExport({
      exportDir: scenario.tree.into,
      write: false,
    });
    const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
    expect(gates["typecheck"]?.status, gates["typecheck"]?.summary).toBe(
      "passed",
    );
    expect(gates["list"]?.status, gates["list"]?.summary).toBe("passed");
    expect(gates["freshness"]?.status).toBe("passed");
  }, 240_000);
});

describe("bypassCSP and page evals", () => {
  function withoutBypass(scenario: { tree: HostTree }): void {
    const config = scenario.tree.config;
    writeFileSync(config, text(config).replace("    bypassCSP: true,\n", ""));
  }

  it("refuses page evals when the host does not set bypassCSP", async () => {
    const scenario = hostScenario("cjs", { evals: EVALS });
    withoutBypass(scenario);
    await expect(exportInto(scenario)).rejects.toThrow(
      /2 page eval\(s\) \(eval_flow: step seed_a; eval_flow: step seed_b\) but the host Playwright config does not set `use\.bypassCSP: true`/,
    );
  });

  it("exports them with --allow-eval-without-bypass, and when the host sets bypassCSP", async () => {
    const withFlag = hostScenario("cjs", { evals: EVALS });
    withoutBypass(withFlag);
    const report = await exportInto(withFlag, { allowEvalWithoutBypass: true });
    expect(report.host?.bypassCsp).toBe(false);
    const manifest = JSON.parse(
      text(join(withFlag.tree.into, EXPORT_MANIFEST_FILE)),
    ) as ExportManifestV1;
    expect(manifest.source.allowEvalWithoutBypass).toBe(true);

    const hostSets = hostScenario("cjs", { evals: EVALS });
    expect((await exportInto(hostSets)).host?.bypassCsp).toBe(true);
  });

  it("does not ask when the specs hold no page eval", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    withoutBypass(scenario);
    await expect(exportInto(scenario)).resolves.toBeDefined();
  });

  it("only applies to --into with a host config", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    const run = await execa(
      CAIRN,
      [
        "export",
        "playwright",
        scenario.flows,
        "--project",
        "--out-dir",
        join(scenario.tree.root, "out"),
        "--host-config",
        scenario.tree.config,
      ],
      { reject: false, timeout: 60_000, env: { NO_COLOR: "1" } },
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("--host-config adapts");
  });
});

describe("--max-eval-ratio (E12)", () => {
  it("refuses the over-limit spec, exports the others, and reports the ratio", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA, evals: EVALS });
    const report = await exportInto(scenario, { maxEvalRatio: 0.5 });
    expect(report.specs.map((spec) => spec.name)).toEqual(["alpha_flow"]);
    expect(report.maxEvalRatio).toBe(0.5);
    expect(report.refused).toHaveLength(1);
    expect(report.refused?.[0]).toMatchObject({
      name: "eval_flow",
      evalSteps: 2,
      totalSteps: 3,
      limit: 0.5,
    });
    expect(report.refused?.[0]?.message).toContain(
      "spec eval_flow refused: 2/3 step(s) (67%) are page eval, over --max-eval-ratio 0.5 (50%)",
    );
    // Nothing of the refused spec was written.
    const manifest = JSON.parse(
      text(join(scenario.tree.into, EXPORT_MANIFEST_FILE)),
    ) as ExportManifestV1;
    expect(manifest.specs.map((spec) => spec.testFile)).toEqual([
      "alpha_flow.spec.ts",
    ]);
    expect(manifest.source.maxEvalRatio).toBe(0.5);
    // --check regenerates with the same gate: still fresh.
    const { report: check } = await checkPlaywrightExport(
      scenario.tree.into,
      undefined,
      {},
    );
    expect(check.status).toBe("fresh");
  });

  it("exports a spec exactly at the limit, and shows the ratio in its coverage", async () => {
    const scenario = hostScenario("cjs", { evals: EVALS });
    const report = await exportInto(scenario, { maxEvalRatio: 2 / 3 });
    expect(report.refused).toBeUndefined();
    expect(report.specs[0]?.coverage.evalRatio).toEqual({
      evalSteps: 2,
      totalSteps: 3,
      ratio: 2 / 3,
    });
  });

  it("writes nothing and throws when every spec is over the limit", async () => {
    const scenario = hostScenario("cjs", { evals: EVALS });
    await expect(exportInto(scenario, { maxEvalRatio: 0.1 })).rejects.toThrow(
      ExportRefusedError,
    );
    await expect(
      buildProjectExport(
        await expandSpecArgs([scenario.flows]),
        "ts",
        {
          into: scenario.tree.into,
          outDir: scenario.tree.into,
          maxEvalRatio: 0,
        },
        scenario.flows,
      ),
    ).rejects.toThrow(/spec eval_flow refused/);
  });

  it("applies to batch --out-dir exports too", async () => {
    const root = tmpRoot();
    const flows = sourceTree(root, { alpha: ALPHA, evals: EVALS });
    const outDir = join(root, "out");
    const written = await writeBatchExport(
      await expandSpecArgs([flows]),
      "ts",
      { outDir, maxEvalRatio: "0.5" },
      flows,
    );
    expect(written.report?.files.map((file) => file.name)).toEqual([
      "alpha_flow",
    ]);
    expect(written.refused.map((refusal) => refusal.name)).toEqual([
      "eval_flow",
    ]);
    expect(written.report?.refused).toHaveLength(1);
    expect(written.failed).toBe(0);
  });

  it("rejects a value outside 0..1", async () => {
    const scenario = hostScenario("cjs", { alpha: ALPHA });
    for (const bad of ["1.5", "-0.1", "abc", ""]) {
      await expect(exportInto(scenario, { maxEvalRatio: bad })).rejects.toThrow(
        /--max-eval-ratio must be a number between 0 and 1/,
      );
    }
  });

  it("exits 1 with the refusal on stderr while the other specs are written", async () => {
    const root = tmpRoot();
    const flows = sourceTree(root, { alpha: ALPHA, evals: EVALS });
    const outDir = join(root, "out");
    const run = await execa(
      CAIRN,
      [
        "export",
        "playwright",
        flows,
        "--out-dir",
        outDir,
        "--max-eval-ratio",
        "0.5",
        "--format",
        "json",
      ],
      { reject: false, timeout: 60_000, env: { NO_COLOR: "1" } },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("spec eval_flow refused");
    const report = JSON.parse(run.stdout) as {
      files: Array<{ name: string }>;
      refused: Array<{ name: string }>;
    };
    expect(report.files.map((file) => file.name)).toEqual(["alpha_flow"]);
    expect(report.refused.map((refusal) => refusal.name)).toEqual([
      "eval_flow",
    ]);
    expect(text(join(outDir, "alpha_flow.spec.ts"))).toContain("alpha_flow");
  });

  it("exits 1 when every spec is refused", async () => {
    const root = tmpRoot();
    const flows = sourceTree(root, { evals: EVALS });
    const run = await execa(
      CAIRN,
      [
        "export",
        "playwright",
        join(flows, "evals.yml"),
        "--stdout",
        "--max-eval-ratio",
        "0",
      ],
      { reject: false, timeout: 60_000, env: { NO_COLOR: "1" } },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("spec eval_flow refused");
  });
});

describe("export.targets profiles (--target)", () => {
  function targetScenario(extraTargets = "") {
    const scenario = hostScenario("cjs", { alpha: ALPHA, evals: EVALS });
    const configDir = join(scenario.tree.root, "..");
    const config = join(configDir, "cairntrace.config.yml");
    writeFileSync(
      config,
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8787
export:
  targets:
    ui:
      input: src/flows
      into: host/e2e/tests/cairn
      hostConfig: host/e2e/playwright.config.ts
      preconditions: inline
      maxEvalRatio: 0.5
      lang: ts
      mapFile: export.map.yml
      verifyProject: chromium
${extraTargets}`,
    );
    // The profile's map: nothing is bound, so it only has to exist and parse.
    writeFileSync(join(configDir, "export.map.yml"), "version: 1\n");
    return { ...scenario, config, configDir };
  }

  it("fills what the command line leaves out, paths relative to the config", async () => {
    const scenario = targetScenario();
    const applied = await applyExportTarget(
      { target: "ui" },
      undefined,
      scenario.configDir,
    );
    expect(applied.opts).toMatchObject({
      target: "ui",
      into: join(scenario.configDir, "host/e2e/tests/cairn"),
      hostConfig: join(scenario.configDir, "host/e2e/playwright.config.ts"),
      preconditions: "inline",
      maxEvalRatio: 0.5,
      lang: "ts",
      mapFile: join(scenario.configDir, "export.map.yml"),
      verifyProject: "chromium",
      config: scenario.config,
    });
    expect(applied.inputPath).toBe(join(scenario.configDir, "src/flows"));
    expect(applied.target).toMatchObject({
      name: "ui",
      configPath: scenario.config,
      mapFile: join(scenario.configDir, "export.map.yml"),
    });
  });

  it("lets a flag override the profile field", async () => {
    const scenario = targetScenario();
    const applied = await applyExportTarget(
      {
        target: "ui",
        maxEvalRatio: 0.9,
        preconditions: "skip",
        into: "/elsewhere",
        lang: "js",
        config: scenario.config,
      },
      "/some/spec.yml",
      scenario.configDir,
    );
    expect(applied.opts).toMatchObject({
      maxEvalRatio: 0.9,
      preconditions: "skip",
      into: "/elsewhere",
      lang: "js",
      // Not given: still from the profile.
      hostConfig: join(scenario.configDir, "host/e2e/playwright.config.ts"),
    });
    expect(applied.inputPath).toBe("/some/spec.yml");
  });

  it("names the defined targets for an unknown one, and the missing config", async () => {
    const scenario = targetScenario();
    await expect(
      applyExportTarget({ target: "nope" }, undefined, scenario.configDir),
    ).rejects.toThrow(/unknown export target \(defined in .*: ui\)/);
    const bare = tmpRoot();
    await expect(
      applyExportTarget({ target: "ui" }, undefined, bare),
    ).rejects.toThrow(/no cairntrace\.config\.yml found/);
  });

  it("a profile's lang is not overridden by a default (--lang has none)", async () => {
    const scenario = targetScenario(`    js_tree:
      input: src/flows/alpha.yml
      into: out-js
      lang: js
`);
    const run = await execa(
      CAIRN,
      ["export", "playwright", "--target", "js_tree"],
      {
        cwd: scenario.configDir,
        reject: false,
        timeout: 60_000,
        env: { NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
      },
    );
    expect(run.exitCode, run.stderr).toBe(0);
    expect(
      text(join(scenario.configDir, "out-js", "tests", "alpha_flow.spec.js")),
    ).toContain("alpha_flow");
  });

  it("exports with --target end to end (profile + host + eval limit), exit 1 for the refusal", async () => {
    const scenario = targetScenario();
    const run = await execa(
      CAIRN,
      ["export", "playwright", "--target", "ui", "--format", "json"],
      {
        cwd: scenario.configDir,
        reject: false,
        timeout: 120_000,
        env: { NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
      },
    );
    expect(run.stderr).toContain("spec eval_flow refused");
    expect(run.exitCode).toBe(1);
    const report = JSON.parse(run.stdout) as {
      target: string;
      host: { moduleSystem: string; config: string };
      specs: Array<{ name: string; file: string }>;
      maxEvalRatio: number;
    };
    expect(report).toMatchObject({
      target: "ui",
      maxEvalRatio: 0.5,
      host: { moduleSystem: "cjs", config: "../../playwright.config.ts" },
    });
    expect(report.specs.map((spec) => spec.file)).toEqual([
      "alpha_flow.spec.ts",
    ]);
    const manifest = JSON.parse(
      text(join(scenario.tree.into, EXPORT_MANIFEST_FILE)),
    ) as ExportManifestV1;
    expect(manifest.source).toMatchObject({
      target: "ui",
      hostConfig: "../../playwright.config.ts",
      maxEvalRatio: 0.5,
      preconditions: "inline",
    });
  }, 180_000);
});
