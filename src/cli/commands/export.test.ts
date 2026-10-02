import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPORT_MANIFEST_FILE,
  type ExportManifestV1,
} from "../../core/exporters/exportManifest";
import {
  buildProjectExport,
  checkPlaywrightExport,
  writeBatchExport,
  writeProjectExport,
} from "./export";
import { expandSpecArgs } from "./run";

const REPO_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const CAIRN = join(REPO_ROOT, "bin", "cairn");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

const SPEC_A = `version: 1
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
`;

const SPEC_B = `version: 1
name: beta_flow
intent: beta shows its heading
coldStart: guest
outcomes:
  - id: heading
    description: heading visible
    verify:
      text: { contains: Beta }
steps:
  - id: open_beta
    open: http://localhost:8787/beta.html
`;

async function sourceTree(): Promise<{ root: string; flows: string }> {
  const root = await tempDir("cairn-export-src-");
  const flows = join(root, "flows");
  await mkdir(flows, { recursive: true });
  await writeFile(join(flows, "alpha.yml"), SPEC_A);
  await writeFile(join(flows, "beta.yml"), SPEC_B);
  return { root, flows };
}

describe("export manifest + --check (E6)", () => {
  it("writes .cairn-export.json for a project export and reports fresh/stale/missing/orphaned", async () => {
    const { root, flows } = await sourceTree();
    const outDir = join(root, "exports");
    const paths = await expandSpecArgs([flows]);
    const report = await writeProjectExport(
      paths,
      "ts",
      { project: true, outDir },
      flows,
    );
    expect(report.manifest).toBe(join(outDir, EXPORT_MANIFEST_FILE));

    const manifest = JSON.parse(
      await readFile(report.manifest, "utf8"),
    ) as ExportManifestV1;
    expect(manifest).toMatchObject({
      version: 1,
      mode: "project",
      lang: "ts",
      source: { input: "../flows", varKeys: [] },
    });
    expect(manifest.exporterVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.specs.map((spec) => [spec.spec, spec.testFile])).toEqual([
      ["../flows/alpha.yml", "tests/alpha_flow.spec.ts"],
      ["../flows/beta.yml", "tests/beta_flow.spec.ts"],
    ]);
    expect(manifest.specs[0]?.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.specs[0]?.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.files.map((file) => file.path)).toContain(
      "tests/alpha_flow.spec.ts",
    );
    expect(
      manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)),
    ).toBe(true);

    const fresh = await checkPlaywrightExport(outDir, undefined, {});
    expect(fresh.exitCode).toBe(0);
    expect(fresh.report.status).toBe("fresh");
    expect(fresh.report.files.stale).toEqual([]);

    // Source drift: alpha's steps change, beta is deleted, a test is removed.
    await writeFile(
      join(flows, "alpha.yml"),
      SPEC_A.replace("alpha.html", "alpha-v2.html"),
    );
    await unlink(join(flows, "beta.yml"));
    await writeFile(
      join(flows, "gamma.yml"),
      SPEC_B.replace("beta_flow", "gamma_flow"),
    );
    await unlink(join(outDir, "README.md"));

    const stale = await checkPlaywrightExport(outDir, undefined, {
      json: true,
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.report.status).toBe("stale");
    expect(stale.report.files.stale).toContain("tests/alpha_flow.spec.ts");
    expect(stale.report.files.missing).toEqual(
      expect.arrayContaining(["README.md", "tests/gamma_flow.spec.ts"]),
    );
    expect(stale.report.files.orphaned).toContain("tests/beta_flow.spec.ts");
    expect(stale.report.specs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spec: "../flows/alpha.yml",
          status: "changed",
          sourceChanged: true,
        }),
        expect.objectContaining({
          spec: "../flows/beta.yml",
          status: "removed",
        }),
        expect.objectContaining({ spec: "../flows/gamma.yml", status: "new" }),
      ]),
    );
  });

  it("flags hand edits as stale and modified", async () => {
    const { root, flows } = await sourceTree();
    const outDir = join(root, "exports");
    await writeProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir },
      flows,
    );
    const testPath = join(outDir, "tests", "alpha_flow.spec.ts");
    await writeFile(testPath, `${await readFile(testPath, "utf8")}// edited\n`);
    const result = await checkPlaywrightExport(outDir, undefined, {});
    expect(result.exitCode).toBe(1);
    expect(result.report.files.stale).toEqual(["tests/alpha_flow.spec.ts"]);
    expect(result.report.files.modified).toEqual(["tests/alpha_flow.spec.ts"]);
    expect(result.report.specs.every((spec) => spec.status === "fresh")).toBe(
      true,
    );
  });

  it("checks --out-dir batch exports too", async () => {
    const { root, flows } = await sourceTree();
    const outDir = join(root, "batch");
    const written = await writeBatchExport(
      await expandSpecArgs([flows]),
      "ts",
      { outDir },
      flows,
    );
    expect(written.report?.manifest).toBe(join(outDir, EXPORT_MANIFEST_FILE));
    const manifest = JSON.parse(
      await readFile(join(outDir, EXPORT_MANIFEST_FILE), "utf8"),
    ) as ExportManifestV1;
    expect(manifest.mode).toBe("files");
    expect(manifest.specs.map((spec) => spec.testFile)).toEqual([
      "alpha_flow.spec.ts",
      "beta_flow.spec.ts",
    ]);
    expect(manifest.specs.map((spec) => spec.spec)).toEqual([
      "../flows/alpha.yml",
      "../flows/beta.yml",
    ]);

    expect((await checkPlaywrightExport(outDir, undefined, {})).exitCode).toBe(
      0,
    );
    await writeFile(join(flows, "beta.yml"), SPEC_B.replace("Beta", "Beta 2"));
    const stale = await checkPlaywrightExport(outDir, undefined, {});
    expect(stale.exitCode).toBe(1);
    expect(stale.report.files.stale).toEqual(["beta_flow.spec.ts"]);
    expect(stale.report.specs).toContainEqual(
      expect.objectContaining({
        spec: "../flows/beta.yml",
        status: "changed",
        contractChanged: true,
      }),
    );
  });

  it("runs through the CLI: cairn export playwright --check <dir> (exit 0/1/2, JSON)", async () => {
    const { root, flows } = await sourceTree();
    const outDir = join(root, "exports");
    const cli = (args: string[]) =>
      execa(CAIRN, ["export", "playwright", ...args], {
        reject: false,
        timeout: 30_000,
        env: { NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
      });

    const written = await cli([
      flows,
      "--project",
      "--out-dir",
      outDir,
      "--json",
    ]);
    expect(written.exitCode, written.stderr).toBe(0);

    // No spec argument: the manifest's recorded input is regenerated.
    const fresh = await cli(["--check", outDir, "--json"]);
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({
      status: "fresh",
      files: { stale: [], missing: [], orphaned: [] },
    });

    await writeFile(
      join(flows, "alpha.yml"),
      SPEC_A.replace("alpha.html", "alpha-v2.html"),
    );
    const stale = await cli(["--check", outDir, "--json"]);
    expect(stale.exitCode, stale.stderr).toBe(1);
    const staleReport = JSON.parse(stale.stdout) as {
      status: string;
      files: { stale: string[] };
    };
    expect(staleReport.status).toBe("stale");
    expect(staleReport.files.stale).toContain("tests/alpha_flow.spec.ts");

    const missing = await cli([
      "--check",
      await tempDir("cairn-export-nomanifest-"),
      "--json",
    ]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: "error" });

    // Without --check a spec argument is still required.
    const noSpec = await cli(["--json"]);
    expect(noSpec.exitCode).toBe(2);
  }, 60_000);

  it("errors (exit 2) when the directory has no manifest", async () => {
    const empty = await tempDir("cairn-export-empty-");
    const result = await checkPlaywrightExport(empty, undefined, {});
    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe("error");
    expect(result.report.error).toContain(EXPORT_MANIFEST_FILE);
  });
});

const LOGIN_ACTION = `version: 1
name: login_demo
steps:
  - id: open_login
    open: http://localhost:8787/login.html
  - id: submit
    click: { by: role, role: button, name: Sign in }
`;

const SPEC_WITH_ACTION = `# a YAML comment the export ignores
version: 1
name: gated_flow
intent: a signed-in user sees the dashboard
coldStart: guest
imports:
  - ../actions/login_demo.yml
outcomes:
  - id: heading
    description: dashboard visible
    verify:
      text: { contains: Dashboard }
steps:
  - use: login_demo
  - id: open_dashboard
    open: http://localhost:8787/dashboard.html
`;

async function treeWithAction(): Promise<{ root: string; flows: string }> {
  const root = await tempDir("cairn-export-reloc-");
  const flows = join(root, "flows");
  await mkdir(flows, { recursive: true });
  await mkdir(join(root, "actions"), { recursive: true });
  await writeFile(join(root, "actions", "login_demo.yml"), LOGIN_ACTION);
  await writeFile(join(flows, "gated.yml"), SPEC_WITH_ACTION);
  await writeFile(join(flows, "alpha.yml"), SPEC_A);
  return { root, flows };
}

describe("export manifest is relocatable and stable", () => {
  it("stays fresh after the whole tree is copied elsewhere (specs importing actions)", async () => {
    const { root, flows } = await treeWithAction();
    const outDir = join(root, "exports");
    await writeProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir },
      flows,
    );
    expect((await checkPlaywrightExport(outDir, undefined, {})).exitCode).toBe(
      0,
    );
    const copy = join(await tempDir("cairn-export-moved-"), "clone");
    await cp(root, copy, { recursive: true });
    const moved = await checkPlaywrightExport(
      join(copy, "exports"),
      undefined,
      {},
    );
    expect(moved.report.files.stale).toEqual([]);
    expect(moved.report.specs.every((spec) => spec.status === "fresh")).toBe(
      true,
    );
    expect(moved.report.specs.some((spec) => spec.sourceChanged)).toBe(false);
    expect(moved.exitCode).toBe(0);
  });

  it("treats a YAML comment edit as informational, not stale", async () => {
    const { root, flows } = await treeWithAction();
    const outDir = join(root, "exports");
    await writeProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir },
      flows,
    );
    await writeFile(
      join(flows, "gated.yml"),
      SPEC_WITH_ACTION.replace("# a YAML comment", "# an edited comment"),
    );
    const result = await checkPlaywrightExport(outDir, undefined, {});
    expect(result.exitCode).toBe(0);
    expect(result.report.status).toBe("fresh");
    expect(result.report.specs).toContainEqual(
      expect.objectContaining({
        spec: "../flows/gated.yml",
        status: "fresh",
        sourceChanged: true,
      }),
    );
  });

  it("reports an action edit as stale through the regenerated files", async () => {
    const { root, flows } = await treeWithAction();
    const outDir = join(root, "exports");
    await writeProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir },
      flows,
    );
    await writeFile(
      join(root, "actions", "login_demo.yml"),
      LOGIN_ACTION.replace("Sign in", "Log in"),
    );
    const result = await checkPlaywrightExport(outDir, undefined, {});
    expect(result.exitCode).toBe(1);
    expect(result.report.files.stale).toEqual(["actions/login_demo.ts"]);
  });

  it("keeps generatedAt when a re-export changes nothing, and refreshes it when it does", async () => {
    const { root, flows } = await treeWithAction();
    const outDir = join(root, "exports");
    const exportOnce = async () => {
      await writeProjectExport(
        await expandSpecArgs([flows]),
        "ts",
        { project: true, outDir },
        flows,
      );
      return readFile(join(outDir, EXPORT_MANIFEST_FILE), "utf8");
    };
    const first = await exportOnce();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    expect(await exportOnce()).toBe(first);

    await writeFile(join(flows, "alpha.yml"), SPEC_A.replace("Alpha", "Alef"));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    const third = JSON.parse(await exportOnce()) as ExportManifestV1;
    expect(third.generatedAt).not.toBe(
      (JSON.parse(first) as ExportManifestV1).generatedAt,
    );
  });

  it("uses the export input (not the first spec's folder) as the project root without a config", async () => {
    const root = await tempDir("cairn-export-noconfig-");
    const flows = join(root, "flows");
    await mkdir(join(flows, "a"), { recursive: true });
    await mkdir(join(flows, "b"), { recursive: true });
    await writeFile(join(flows, "a", "alpha.yml"), SPEC_A);
    await writeFile(join(flows, "b", "beta.yml"), SPEC_B);
    const outDir = join(root, "exports");
    const built = await buildProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir },
      flows,
    );
    for (const file of built.result.files) {
      expect(file.source, file.relPath).not.toContain(root);
    }
    const header = built.result.files.find(
      (file) => file.relPath === "tests/b/beta_flow.spec.ts",
    );
    expect(header?.source).toContain("Source: b/beta.yml");
  });
});

describe("examples/flows --project export (E4)", () => {
  it("type-checks under strict + noUnusedLocals with only used imports", async () => {
    const outDir = await tempDir("cairn-export-examples-");
    const flows = join(REPO_ROOT, "examples", "flows");
    const built = await buildProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir },
      flows,
    );
    for (const file of built.generated) {
      const abs = join(outDir, file.relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.content);
    }
    await symlink(
      join(REPO_ROOT, "node_modules"),
      join(outDir, "node_modules"),
    );
    for (const file of built.result.files) {
      expect(file.source, file.relPath).not.toMatch(/__CAIRN_[A-Z_]+__/i);
    }

    const tsFiles = built.generated
      .map((file) => join(outDir, file.relPath))
      .filter((path) => path.endsWith(".ts"));
    const program = ts.createProgram(tsFiles, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      types: ["node"],
      typeRoots: [join(REPO_ROOT, "node_modules", "@types")],
      strict: true,
      noUnusedLocals: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      skipLibCheck: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.startsWith(outDir))
      .map(
        (d) =>
          `${d.file?.fileName.slice(outDir.length + 1)}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      );
    expect(diagnostics).toEqual([]);
    expect(built.result.specs.length).toBeGreaterThanOrEqual(10);
  }, 60_000);
});

describe("${config.dir} in exports honours --config", () => {
  it("resolves to the explicit config's directory (specs and imported actions)", async () => {
    const configRoot = await tempDir("cairn-export-cfgdir-cfg-");
    const specRoot = await tempDir("cairn-export-cfgdir-spec-");
    const configPath = join(configRoot, "cairntrace.config.yml");
    await writeFile(configPath, "version: 1\nenvironments:\n  local: {}\n");
    await mkdir(join(specRoot, "actions"), { recursive: true });
    await writeFile(
      join(specRoot, "actions", "attach.yml"),
      `version: 1
name: attach
vars: { file: a.txt }
steps:
  - id: attach_file
    upload: { by: selector, selector: "#f", path: "\${config.dir}/fixtures/\${vars.file}" }
`,
    );
    const specPath = join(specRoot, "upload.yml");
    await writeFile(
      specPath,
      `version: 1
name: cfgdir_flow
intent: fixtures live next to the explicit config
coldStart: guest
imports:
  - actions/attach.yml
outcomes:
  - id: ok
    description: ok
    verify: { text: { contains: Done } }
steps:
  - id: open_page
    open: http://localhost:8787/upload.html
  - use: attach
  - id: own_upload
    upload: { by: selector, selector: "#g", path: "\${config.dir}/fixtures/b.txt" }
`,
    );
    const { parseForExport } = await import("./export");
    const r = await parseForExport(specPath, { config: configPath });
    expect(r.configDir).toBe(configRoot);
    const uploads = JSON.stringify(r.parsed.resolved.steps);
    expect(uploads).toContain(`${configRoot}/fixtures/b.txt`);
    expect(uploads).toContain(`${configRoot}/fixtures/a.txt`);
    expect(uploads).not.toContain(process.cwd() + "/fixtures");

    // --project re-parses actions with declared vars; same ${config.dir}.
    const built = await buildProjectExport(
      [specPath],
      "ts",
      { project: true, outDir: join(specRoot, "pw"), config: configPath },
      specPath,
    );
    const action = built.result.files.find(
      (f) => f.relPath === "actions/attach.ts",
    );
    expect(action?.source).toContain(`${configRoot}/fixtures/`);
    expect(action?.source).not.toContain(`${process.cwd()}/fixtures/`);
  });
});
