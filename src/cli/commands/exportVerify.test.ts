import ts from "typescript";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportVerifyReportSchema } from "../../core/schema/exportVerify.v1";
import { readExportManifest } from "../../core/exporters/exportManifest";
import { writeBatchExport, writeProjectExport } from "./export";
import {
  EXPORT_VERIFY_JSON,
  EXPORT_VERIFY_MD,
  baseUrlOfConfig,
  mergeExportExitCodes,
  outcomeIdsOfTest,
  verifyPlaywrightExport,
  verifyToMarkdown,
} from "./exportVerify";

const REPO_NODE_MODULES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "node_modules",
);

/**
 * A tiny app: a page that greets and pings its own API. The greeting text
 * lands 300ms after the ping answers, so the browser has reported the
 * response before any outcome reads the request log.
 */
let app: Server;
let baseUrl = "";
let root = "";

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cairn-export-verify-")));
  app = createServer((req, res) => {
    if (req.url === "/api/ping") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><title>fixture</title><h1>Hello fixture</h1><p id="s"></p><script>fetch("/api/ping").then(() => setTimeout(() => { document.getElementById("s").textContent = "Pinged ok"; }, 300))</script>`,
    );
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => app.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function specYaml(url: string, text = "Hello fixture"): string {
  return [
    "version: 1",
    "name: fixture_page",
    "intent: the fixture page greets and pings its API",
    "outcomes:",
    "  - id: greeting_visible",
    "    description: the page shows the greeting",
    "    verify:",
    "      text:",
    `        contains: ${text}`,
    "  - id: ping_ok",
    "    description: the page pinged the API",
    "    verify:",
    "      network:",
    "        method: GET",
    "        urlContains: /api/ping",
    "        status:",
    "          equals: 200",
    "  - id: still_on_fixture",
    "    description: still on the fixture origin",
    "    verify:",
    "      url:",
    `        startsWith: ${url}`,
    "steps:",
    "  - id: open_home",
    `    open: ${url}/`,
    "  - id: wait_greeting",
    "    wait:",
    "      text: Pinged ok",
    "      timeoutMs: 5000",
    "",
  ].join("\n");
}

let counter = 0;
/** Export the fixture spec as a project and make its tools resolvable. */
async function exportFixture(
  opts: { text?: string; link?: boolean } = {},
): Promise<{ dir: string; specFile: string; testFile: string }> {
  counter += 1;
  const base = join(root, `case-${counter}`);
  mkdirSync(join(base, "specs"), { recursive: true });
  const specFile = join(base, "specs", "fixture.yml");
  writeFileSync(specFile, specYaml(baseUrl, opts.text));
  const dir = join(base, "export");
  await writeProjectExport(
    [specFile],
    "ts",
    { project: true, outDir: dir },
    specFile,
  );
  if (opts.link !== false)
    symlinkSync(REPO_NODE_MODULES, join(dir, "node_modules"));
  return {
    dir,
    specFile,
    testFile: join(dir, "tests", "fixture_page.spec.ts"),
  };
}

function replaceInTest(
  testFile: string,
  from: string | RegExp,
  to: string,
): void {
  const source = readFileSync(testFile, "utf8");
  const next = source.replace(from, to);
  expect(next).not.toBe(source);
  writeFileSync(testFile, next);
}

describe("verifyPlaywrightExport (static gates)", () => {
  it("passes a fresh export, writes the report and a manifest summary, and keeps it across an identical re-export", async () => {
    const { dir, specFile } = await exportFixture();
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
    });
    expect(exitCode).toBe(0);
    expect(() => ExportVerifyReportSchema.parse(report)).not.toThrow();
    expect(report.status).toBe("passed");
    expect(
      Object.fromEntries(report.gates.map((g) => [g.id, g.status])),
    ).toEqual({
      sentinels: "passed",
      freshness: "passed",
      typecheck: "passed",
      lint: "skipped",
      list: "passed",
    });
    expect(report.summary.gates).toEqual({ passed: 4, failed: 0, skipped: 1 });
    expect(report.differential).toBeUndefined();

    expect(existsSync(join(dir, EXPORT_VERIFY_JSON))).toBe(true);
    expect(readFileSync(join(dir, EXPORT_VERIFY_MD), "utf8")).toContain(
      "A skipped gate proves nothing",
    );
    const manifest = readExportManifest(dir);
    expect(manifest.verify).toMatchObject({
      status: "passed",
      gates: { lint: "skipped", list: "passed" },
      report: EXPORT_VERIFY_JSON,
    });

    // The same sources re-export to the same files: the verify result stays.
    await writeProjectExport(
      [specFile],
      "ts",
      { project: true, outDir: dir },
      specFile,
    );
    expect(readExportManifest(dir).verify?.verifiedAt).toBe(
      manifest.verify?.verifiedAt,
    );
    // A changed spec changes the export: the stale result is dropped.
    writeFileSync(specFile, specYaml(baseUrl, "Hello again"));
    await writeProjectExport(
      [specFile],
      "ts",
      { project: true, outDir: dir },
      specFile,
    );
    expect(readExportManifest(dir).verify).toBeUndefined();
  }, 120_000);

  it("fails on a hand-edited, stale export and on a leaked sentinel", async () => {
    const { dir, testFile } = await exportFixture();
    writeFileSync(
      testFile,
      `${readFileSync(testFile, "utf8")}\nconst leak = "__CAIRN_RUN_TOKEN__";\n`,
    );
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      write: false,
    });
    expect(exitCode).toBe(1);
    const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
    expect(gates["sentinels"]).toMatchObject({ status: "failed" });
    expect(gates["sentinels"]!.findings?.[0]).toContain(
      "tests/fixture_page.spec.ts:",
    );
    expect(gates["freshness"]).toMatchObject({ status: "failed" });
    expect(gates["freshness"]!.findings).toContain(
      "stale: tests/fixture_page.spec.ts",
    );
    expect(gates["typecheck"]).toMatchObject({ status: "failed" });
    expect(existsSync(join(dir, EXPORT_VERIFY_JSON))).toBe(false);
  }, 120_000);

  it("removes a mutant an interrupted --mutate left behind before any gate (never listed or run)", async () => {
    const { dir, testFile } = await exportFixture();
    const mutant = join(
      dir,
      "tests",
      "fixture_page-cairn-verify-mutant.spec.ts",
    );
    writeFileSync(
      mutant,
      readFileSync(testFile, "utf8").replace(
        ".toContainText(",
        ".not.toContainText(",
      ),
    );
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      write: false,
    });
    expect(existsSync(mutant)).toBe(false);
    expect(report.warnings.join("\n")).toContain(
      "removed 1 leftover mutant file(s) of an interrupted --mutate: tests/fixture_page-cairn-verify-mutant.spec.ts",
    );
    expect(exitCode).toBe(0);
    expect(
      Object.fromEntries(report.gates.map((g) => [g.id, g.status])),
    ).toMatchObject({ typecheck: "passed", list: "passed" });
  }, 120_000);

  it("--verify-strict counts a skipped gate as a failure", async () => {
    const { dir } = await exportFixture();
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      strict: true,
      write: false,
    });
    expect(exitCode).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.warnings.join(" ")).toContain("--verify-strict");
  }, 120_000);

  it("is exit 2 without a manifest, and for a differential on a standalone or unreachable export", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const none = await verifyPlaywrightExport({ exportDir: empty });
    expect(none.exitCode).toBe(2);
    expect(none.report.error).toContain(".cairn-export.json");

    const { dir } = await exportFixture();
    const config = join(dir, "playwright.config.ts");
    const text = readFileSync(config, "utf8");
    writeFileSync(
      config,
      text.replace("use: {", 'use: {\n    baseURL: "http://127.0.0.1:1",'),
    );
    const down = await verifyPlaywrightExport({
      exportDir: dir,
      differential: true,
    });
    expect(down.exitCode).toBe(2);
    expect(down.report.status).toBe("error");
    expect(down.report.error).toContain("not reachable");
    expect(down.report.gates).toEqual([]);
  }, 120_000);

  it("verifies a standalone --out-dir export statically, and refuses a differential on it (exit 2)", async () => {
    counter += 1;
    const base = join(root, `case-${counter}`);
    mkdirSync(join(base, "specs"), { recursive: true });
    const specFile = join(base, "specs", "fixture.yml");
    writeFileSync(specFile, specYaml(baseUrl));
    const dir = join(base, "export");
    await writeBatchExport([specFile], "ts", { outDir: dir }, specFile);
    const stat = await verifyPlaywrightExport({ exportDir: dir, write: false });
    // A standalone export has no Playwright config to --list, and no tsc is
    // next to it here: nothing ran over the generated code.
    expect(stat.exitCode).toBe(3);
    expect(stat.report.status).toBe("inconclusive");
    const gates = Object.fromEntries(stat.report.gates.map((g) => [g.id, g]));
    expect(gates["freshness"]).toMatchObject({ status: "passed" });
    expect(gates["sentinels"]).toMatchObject({ status: "passed" });
    expect(gates["list"]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("standalone"),
    });
    const diff = await verifyPlaywrightExport({
      exportDir: dir,
      differential: true,
    });
    expect(diff.exitCode).toBe(2);
    expect(diff.report.error).toContain("--project or --into");
  }, 120_000);

  it("markdown names failed gates, findings and the skipped-is-not-pass rule", async () => {
    const { dir, testFile } = await exportFixture();
    writeFileSync(
      testFile,
      `${readFileSync(testFile, "utf8")}\n// __CAIRN_X__\n`,
    );
    const { report } = await verifyPlaywrightExport({
      exportDir: dir,
      write: false,
    });
    const md = verifyToMarkdown(report);
    expect(md).toContain("# Export verify: failed");
    expect(md).toContain("- **sentinels**: failed");
    expect(md).toContain("  - tests/fixture_page.spec.ts:");
    expect(md).toContain("- **lint**: skipped — no eslint config");
  }, 120_000);
});

describe("outcomeIdsOfTest", () => {
  it("lists the outcome steps after the contract marker, never teardown steps", () => {
    const source = `await test.step("open", async () => {});
// --- outcomes (the contract) ---
await test.step("a", async () => {});
await test.step("b \\"q\\"", async () => {});
await test.step("teardown: x", async () => {});`;
    expect(outcomeIdsOfTest(source)).toEqual(["a", 'b "q"']);
    expect(outcomeIdsOfTest("no marker")).toEqual([]);
  });

  it("reads a test the host's prettier reformatted (syntax tree), preferring the spec's outcome ids", () => {
    const source = `test('t', async () => {
  await test.step('open', async () => {});
  // --- outcomes (the contract) ---
  await test.step(
    'heading_visible',
    async () => {},
  );
});`;
    // The old one-line, double-quote reading finds nothing here.
    expect(outcomeIdsOfTest(source)).toEqual([]);
    expect(outcomeIdsOfTest(source, { ts })).toEqual(["heading_visible"]);
    expect(
      outcomeIdsOfTest(
        source.replace("// --- outcomes (the contract) ---", ""),
        {
          ts,
          specOutcomeIds: ["heading_visible", "never_exported"],
        },
      ),
    ).toEqual(["heading_visible"]);
  });
});

/*
 * The runs below start one Chromium at a time (cairn run, then the exported
 * test, then each mutant) against the in-process fixture app. They are the
 * slow tests of this file: each is bounded by an explicit timeout.
 */
describe("verifyPlaywrightExport (differential and mutation, real Chromium)", () => {
  it("matches the runner on every compared verdict, and kills every inverted outcome", async () => {
    const { dir } = await exportFixture();
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      differential: true,
      mutate: "all",
    });
    expect(() => ExportVerifyReportSchema.parse(report)).not.toThrow();
    expect(report.gates.filter((g) => g.status === "failed")).toEqual([]);
    expect(report.differential).toMatchObject({
      status: "passed",
      summary: { match: 1, mismatch: 0 },
      order: "cairn-then-export",
    });
    const spec = report.differential!.specs[0]!;
    expect(spec).toMatchObject({
      status: "match",
      mismatches: [],
      compared: { steps: 2, outcomes: 3 },
      network: [{ outcome: "ping_ok", cairn: 1, export: 1 }],
    });
    expect(report.mutation).toMatchObject({
      status: "passed",
      scope: "all",
      summary: { killed: 3, survived: 0, invalid: 0 },
    });
    expect(
      report.mutation!.specs[0]!.mutants.map((m) => [m.outcome, m.status]),
    ).toEqual([
      ["greeting_visible", "killed"],
      ["ping_ok", "killed"],
      ["still_on_fixture", "killed"],
    ]);
    expect(exitCode).toBe(0);
    expect(report.status).toBe("passed");
    expect(readFileSync(join(dir, EXPORT_VERIFY_MD), "utf8")).toContain(
      "Specs that are not idempotent need a reset",
    );
    expect(readExportManifest(dir).verify).toMatchObject({
      differential: "passed",
      mutation: "passed",
    });
    // no mutant copy is left in the export
    expect(
      readdirSync(join(dir, "tests")).filter((f) => f.includes("mutant")),
    ).toEqual([]);
  }, 180_000);

  it("reports the outcome an unfaithful export judges differently", async () => {
    const { dir, testFile } = await exportFixture();
    replaceInTest(
      testFile,
      /toContainText\("Hello fixture"/,
      'toContainText("Goodbye fixture"',
    );
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      differential: true,
      write: false,
    });
    expect(exitCode).toBe(1);
    expect(report.differential?.status).toBe("failed");
    // the evidence of a disagreement is kept for inspection
    expect(report.warnings.join(" ")).toContain("kept the run artifacts");
    const spec = report.differential!.specs[0]!;
    expect(spec.status).toBe("mismatch");
    expect(
      spec.mismatches.map((m) => [m.kind, m.id ?? null, m.cairn, m.export]),
    ).toEqual([
      ["verdict", null, "passed", "failed"],
      ["outcome", "greeting_visible", "passed", "failed"],
      ["outcome", "ping_ok", "passed", "skipped"],
      ["outcome", "still_on_fixture", "passed", "skipped"],
    ]);
  }, 180_000);

  it("finds an assertion that is not effective (a swallowed outcome survives its mutant) and sweeps stale mutants", async () => {
    const { dir, testFile } = await exportFixture();
    // Swallow the first outcome's assertion: the test can never fail there.
    replaceInTest(
      testFile,
      /await test\.step\("greeting_visible", async \(\) => \{\n([\s\S]*?)\n {2}\}\);/,
      'await test.step("greeting_visible", async () => {\n    try {\n$1\n    } catch {}\n  });',
    );
    const stale = join(
      dir,
      "tests",
      "fixture_page-cairn-verify-mutant.spec.ts",
    );
    writeFileSync(stale, "this file is a leftover and must be swept\n");
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      mutate: "one",
      write: false,
    });
    expect(exitCode).toBe(1);
    expect(report.mutation).toMatchObject({
      status: "failed",
      scope: "one",
      summary: { killed: 0, survived: 1 },
    });
    expect(report.mutation!.specs[0]).toMatchObject({
      status: "ineffective",
      mutants: [
        {
          outcome: "greeting_visible",
          status: "survived",
          operator: "toContainText -> not.toContainText",
          detail: expect.stringContaining("assertion not effective"),
        },
      ],
    });
    expect(existsSync(stale)).toBe(false);
  }, 180_000);

  it("skips a test.fixme export instead of judging it", async () => {
    const { dir, testFile } = await exportFixture();
    replaceInTest(testFile, 'test("fixture_page"', 'test.fixme("fixture_page"');
    const { report } = await verifyPlaywrightExport({
      exportDir: dir,
      differential: true,
      mutate: "one",
      write: false,
    });
    expect(report.differential!.specs[0]).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("test.fixme"),
    });
    expect(report.differential!.status).toBe("inconclusive");
    expect(report.mutation!.specs[0]).toMatchObject({
      status: "skipped",
      mutants: [],
    });
  }, 180_000);
});

describe("verifyPlaywrightExport on a multi-project host (setup project + dependencies)", () => {
  /**
   * The shape `npm init playwright` and auth-by-setup hosts share: one
   * project per browser (Firefox / WebKit are not even installed here),
   * each depending on a setup project.
   */
  async function multiProjectHost(
    exportOpts: { verifyProject?: string } = {},
  ): Promise<{ host: string; dir: string }> {
    counter += 1;
    const host = join(root, `host-${counter}`);
    mkdirSync(join(host, "specs"), { recursive: true });
    mkdirSync(join(host, "tests"), { recursive: true });
    writeFileSync(join(host, "package.json"), '{"name":"host"}');
    mkdirSync(join(host, ".git"));
    symlinkSync(REPO_NODE_MODULES, join(host, "node_modules"));
    writeFileSync(
      join(host, "playwright.config.ts"),
      `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  projects: [
    { name: "setup", testMatch: /.*\\.setup\\.ts/ },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, dependencies: ["setup"] },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, dependencies: ["setup"] },
  ],
});
`,
    );
    // The dependency proves it ran: it appends a line per run.
    writeFileSync(
      join(host, "tests", "prepare.setup.ts"),
      `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { test as setup } from "@playwright/test";
setup("prepare", async () => { appendFileSync(join(__dirname, "..", "setup-runs.txt"), "ran\\n"); });
`,
    );
    const specFile = join(host, "specs", "fixture.yml");
    writeFileSync(specFile, specYaml(baseUrl));
    const dir = join(host, "tests", "cairn");
    await writeProjectExport(
      [specFile],
      "ts",
      {
        into: dir,
        outDir: dir,
        hostConfig: join(host, "playwright.config.ts"),
        ...exportOpts,
      },
      specFile,
    );
    return { host, dir };
  }

  it("lists, runs and mutates under one Chromium project; its setup dependency runs every time", async () => {
    const { host, dir } = await multiProjectHost();
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: dir,
      differential: true,
      mutate: "one",
      write: false,
    });
    expect(() => ExportVerifyReportSchema.parse(report)).not.toThrow();
    expect(report.playwrightProject).toMatchObject({
      name: "chromium",
      source: "auto",
      projects: ["setup", "firefox", "chromium", "webkit"],
      discovering: ["firefox", "chromium", "webkit"],
    });
    expect(report.gates.find((g) => g.id === "list")).toMatchObject({
      status: "passed",
      summary:
        "1 of 1 exported specs listed as one test each in project chromium (--project)",
    });
    expect(report.differential).toMatchObject({
      status: "passed",
      summary: { match: 1, mismatch: 0, error: 0 },
    });
    expect(report.differential!.specs[0]!.warnings).toEqual([]);
    expect(report.mutation).toMatchObject({
      status: "passed",
      summary: { killed: 1, survived: 0, invalid: 0 },
    });
    expect(exitCode).toBe(0);
    // the differential's run, the mutation baseline is the differential's, the mutant
    expect(
      readFileSync(join(host, "setup-runs.txt"), "utf8").trim().split("\n"),
    ).toHaveLength(2);
  }, 240_000);

  it("uses the project recorded at export time, and an unknown one is exit 2", async () => {
    const { dir } = await multiProjectHost({ verifyProject: "webkit" });
    expect(readExportManifest(dir).source.verifyProject).toBe("webkit");
    const recorded = await verifyPlaywrightExport({
      exportDir: dir,
      write: false,
    });
    expect(recorded.report.playwrightProject).toMatchObject({
      name: "webkit",
      source: "manifest",
    });
    expect(recorded.exitCode).toBe(0);
    const flag = await verifyPlaywrightExport({
      exportDir: dir,
      project: "firefox",
      write: false,
    });
    expect(flag.report.playwrightProject).toMatchObject({
      name: "firefox",
      source: "flag",
    });
    const unknown = await verifyPlaywrightExport({
      exportDir: dir,
      project: "edge",
      write: false,
    });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.report.error).toBe(
      '--verify-project "edge": the Playwright config has no such project (setup, firefox, chromium, webkit)',
    );
  }, 120_000);
});

describe("mergeExportExitCodes", () => {
  it("ranks error (2) over failure (1) over inconclusive (3) over success (0)", () => {
    expect(mergeExportExitCodes(0, 3)).toBe(3);
    expect(mergeExportExitCodes(3, 1)).toBe(1);
    expect(mergeExportExitCodes(1, 3)).toBe(1);
    expect(mergeExportExitCodes(2, 1)).toBe(2);
    expect(mergeExportExitCodes(3, 2)).toBe(2);
    expect(mergeExportExitCodes(0, 0)).toBe(0);
  });
});

describe("baseUrlOfConfig (the differential's reachability check)", () => {
  it("reads a literal and the late-bound forms the exporter writes", () => {
    const saved = process.env["VERIFY_BASE_PORT"];
    try {
      delete process.env["VERIFY_BASE_PORT"];
      expect(
        baseUrlOfConfig('  use: {\n    baseURL: "http://localhost:8787",\n'),
      ).toBe("http://localhost:8787");
      expect(
        baseUrlOfConfig(
          '    baseURL: (process.env.VERIFY_BASE_URL_UNSET || "http://localhost:9"),\n',
        ),
      ).toBe("http://localhost:9");
      const template =
        '    baseURL: `http://localhost:${(process.env.VERIFY_BASE_PORT || "8787")}`,\n';
      expect(baseUrlOfConfig(template)).toBe("http://localhost:8787");
      process.env["VERIFY_BASE_PORT"] = "9000";
      expect(baseUrlOfConfig(template)).toBe("http://localhost:9000");
      expect(baseUrlOfConfig("    baseURL: someFunction(),\n")).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["VERIFY_BASE_PORT"];
      else process.env["VERIFY_BASE_PORT"] = saved;
    }
  });
});
