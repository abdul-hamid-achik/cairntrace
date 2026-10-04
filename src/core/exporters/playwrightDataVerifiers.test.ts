/**
 * Export coverage of the data verifiers: `value`, `http`, `network` with a
 * body / count / assign, `file`, `xlsx`, `httpJson` matchers, the
 * `expect.request` step and `transform` — what is emitted, what stays a
 * precise hard skip, how `--verifiers` treats them, and that nothing secret
 * or non-compiling reaches the generated code.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import type { ParseResult } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";
import { renderDataPieceModule } from "./playwrightRuntimeData";
import { renderRuntimeModule } from "./runtimeSources";
import type { ExportHttpDatasource } from "./playwrightDataVerifiers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function spec(raw: Record<string, unknown>): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "data_checks",
    intent: "data verifiers export",
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

const DATASOURCES: Record<string, ExportHttpDatasource> = {
  demo_api: { baseUrl: "http://localhost:8787" },
  secured: {
    baseUrl: "${env.SECURED_URL:-https://svc.example.test}",
    headers: { "x-key": "${secrets.SECURED_KEY}" },
    auth: { bearer: "${secrets.SECURED_TOKEN}" },
  },
};

const OPTS = {
  sourcePath: "/proj/flows/data.yml",
  outPath: "/proj/exports/data.spec.ts",
  httpDatasources: DATASOURCES,
  datasourceEnv: {
    demo_api: [],
    secured: ["SECURED_KEY", "SECURED_TOKEN"],
  },
} as const;

/** A spec that touches every exported data kind except xlsx (project only). */
const FULL = spec({
  outcomes: [
    {
      id: "row_is_there",
      description: "the captured row",
      verify: {
        value: {
          actual: "${captures.row}",
          expect: {
            rowCount: 1,
            "rows[0].SKU": "${requests.created.body.sku}",
          },
        },
      },
    },
    {
      id: "api_says_done",
      description: "the API",
      verify: {
        http: {
          source: "demo_api",
          url: "/api/jobs/${requests.created.body.id}",
          expect: { status: 200, json: { status: "done" } },
          assign: "job",
        },
        poll: { timeoutMs: 5000, everyMs: 250 },
      },
    },
    {
      id: "job_value",
      description: "the job reply",
      verify: {
        value: { actual: "${captures.job.body}", expect: { quantity: 5 } },
      },
    },
    {
      id: "one_post",
      description: "one restock was sent",
      verify: {
        network: {
          method: "POST",
          urlContains: "/api/restock",
          status: { equals: 202 },
          body: { json: { quantity: 5 } },
          count: 1,
          assign: "sent",
        },
      },
    },
    {
      id: "sent_at",
      description: "the send time is known",
      verify: {
        value: { actual: "${network.sent.count}", expect: { $: 1 } },
      },
    },
    {
      id: "exports_a_file",
      description: "the export landed",
      verify: {
        file: {
          glob: "${artifacts.csv.path}",
          contains: "sku",
          timeoutMs: 2000,
        },
      },
    },
    {
      id: "json_matches",
      description: "httpJson with a regex",
      verify: {
        httpJson: { url: "/api/me", jsonPath: "$.name", matches: "^A" },
      },
    },
  ],
  steps: [
    { id: "open", open: "/start" },
    {
      id: "row",
      capture: { assign: "row", table: { by: "role", role: "table" } },
    },
    {
      id: "create",
      request: {
        method: "POST",
        url: "/api/restock",
        body: { quantity: 5 },
        assign: "created",
      },
    },
    {
      id: "poll_job",
      expect: {
        request: {
          url: "/api/jobs/${requests.created.body.id}",
          json: { status: "done" },
        },
      },
    },
    {
      id: "download",
      download: {
        by: "role",
        role: "button",
        name: "Export",
        saveAs: "x.csv",
        assign: "csv",
      },
    },
  ],
});

describe("single-file export of the data verifiers", () => {
  const result = exportPlaywright(FULL, OPTS);
  const source = result.source;

  it("exports everything: no hard skip, not test.fixme", () => {
    expect(result.coverage.skips.filter((skip) => !skip.soft)).toEqual([]);
    expect(source).toContain('test("data_checks"');
  });

  it("inlines the runner's own judge modules, not a re-implementation", () => {
    expect(source).toContain("export function matchPaths");
    expect(source).toContain("export function judgeNetwork");
    expect(source).toContain("export function judgeHttp");
    expect(source).toContain("export async function followRedirects");
    expect(source).toContain("export function matchHttpJson");
    expect(source).toContain("export function resolveRefsDeep");
  });

  it("resolves references through a typed scope of the bindings the steps produced", () => {
    expect(source).toContain(
      'const cairnScope = { responses: { "created": cairnRequests_created }, captures: { "row": cairnCaptures_row } };',
    );
    expect(source).toContain("let cairnRequests_created: unknown;");
    expect(source).toContain("let cairnCaptures_job: unknown;");
    expect(source).toContain("let cairnNetwork_sent: unknown;");
    // The reference text stays literal for cairnRefs to resolve (typed).
    expect(source).toContain('"rows[0].SKU": "${requests.created.body.sku}"');
    // …and is never reported as compared-as-text.
    expect(
      result.coverage.semanticRisks.filter(
        (risk) => risk.kind === "literalSplice",
      ),
    ).toEqual([]);
  });

  it("http: datasource literal, per-call deadline, assign binding, poll", () => {
    expect(source).toContain(
      'source: { name: "demo_api", baseUrl: "http://localhost:8787" }',
    );
    expect(source).toContain("baseUrl: test.info().project.use.baseURL");
    expect(source).toContain(
      "cairnCaptures_job = { status: cairnReply.status, body: cairnReply.body };",
    );
    expect(source).toContain("}).toPass({ timeout: 5000, intervals: [250] });");
  });

  it("network body / count / assign judges a rich request log, request steps included", () => {
    expect(source).toContain("const requests = cairnTrackRequests(page);");
    expect(source).toContain(
      "cairnNetwork_sent = await cairnAssertNetwork(requests,",
    );
    expect(source).toMatch(
      /requests\.push\(\{ url: cairnResponse\.url\(\), method: "POST", status: cairnResponse\.status\(\), timestamp: Date\.now\(\), postData: JSON\.stringify\(\{ "quantity": 5 \}\) \}\);/,
    );
  });

  it("expect.request goes through cairnExpectRequest, retried by the helper", () => {
    expect(source).toContain(
      'await cairnExpectRequest(page, { method: "GET", url: String(cairnCall.url) }, { json: cairnCall.json }, 5000);',
    );
  });

  it("file resolves an artifact path like the runner", () => {
    expect(source).toContain(
      'await cairnAssertFile("${artifacts.csv.path}", cairnFilePath(`${cairnSplice(cairnArtifacts_csv, ["path"])}`, true, test.info().outputPath("cairn-run"), "/proj/flows"), "sku", 2000);',
    );
  });

  it("httpJson judges every matcher kind through the runner's httpJson judge", () => {
    expect(source).toContain(
      'cairnAssertHttpJson(body, { jsonPath: "$.name", matches: "^A" });',
    );
    expect(
      result.coverage.skips.some((skip) =>
        /matches\/atLeast/.test(skip.reason),
      ),
    ).toBe(false);
  });

  it("xlsx needs the workbook reader: a single file says so (hard skip)", () => {
    const withXlsx = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "wb",
            description: "workbook",
            verify: { xlsx: { path: "/tmp/x.xlsx", contains: ["a"] } },
          },
        ],
      }),
      OPTS,
    );
    expect(withXlsx.coverage.fixme).toBe(true);
    expect(withXlsx.coverage.skips).toContainEqual(
      expect.objectContaining({
        id: "wb",
        reason: expect.stringContaining("export with --project"),
      }),
    );
  });

  it("an http verifier on a datasource that is not exportable is a precise hard skip", () => {
    const out = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "svc",
            description: "svc",
            verify: { http: { source: "ghost", url: "/x" } },
          },
        ],
      }),
      OPTS,
    );
    expect(out.coverage.skips).toContainEqual(
      expect.objectContaining({
        id: "svc",
        reason: expect.stringContaining('datasource "ghost"'),
      }),
    );
  });

  it("references without a producer in the export are hard skips naming them", () => {
    const out = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "v",
            description: "v",
            verify: {
              value: {
                actual: "${captures.nobody}",
                expect: { a: "${fixtures.thing.id}", b: "${run.startedAt}" },
              },
            },
          },
        ],
      }),
      OPTS,
    );
    const reasons = out.coverage.skips.map((skip) => skip.reason).join("\n");
    expect(reasons).toContain("captures.nobody");
    expect(reasons).toContain("fixtures.thing.id");
    expect(reasons).toContain("${run.startedAt}");
    expect(out.coverage.fixme).toBe(true);
  });

  it("a simple network outcome keeps the plain response log", () => {
    const out = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "n",
            description: "n",
            verify: {
              network: { urlContains: "/api/x", status: { equals: 200 } },
            },
          },
        ],
      }),
      OPTS,
    );
    expect(out.source).toContain('page.on("response", (r) => requests.push(');
    expect(out.source).not.toContain("cairnTrackRequests");
  });
});

describe("--verifiers with the exported http verifier", () => {
  const httpSpec = spec({
    outcomes: [
      {
        id: "secured_api",
        description: "secured",
        verify: {
          http: { source: "secured", url: "/health", expect: { status: 200 } },
        },
      },
      {
        id: "open_api",
        description: "open",
        verify: { http: { url: "http://localhost:9/x" } },
      },
    ],
  });

  it("keep: runs with the datasource read from the environment when the test runs", () => {
    const out = exportPlaywright(httpSpec, { ...OPTS, verifiers: "keep" });
    expect(out.source).toContain(
      'source: { name: "secured", baseUrl: cairnDatasourceEnv("secured", "env.SECURED_URL", "SECURED_URL", "https://svc.example.test"), headers: { "x-key": cairnDatasourceEnv("secured", "secrets.SECURED_KEY", "SECURED_KEY") }, bearer: cairnDatasourceEnv("secured", "secrets.SECURED_TOKEN", "SECURED_TOKEN") }',
    );
    expect(out.requiredEnv).toEqual(["SECURED_KEY", "SECURED_TOKEN"]);
    expect(out.optionalEnv).toEqual(["SECURED_URL"]);
    expect(out.coverage.fixme).toBe(false);
    expect(out.source).not.toContain("cairnSkipped");
  });

  it("gate: runs only when the datasource's env is present, else the test is reported skipped", () => {
    const out = exportPlaywright(httpSpec, { ...OPTS, verifiers: "gate" });
    expect(out.source).toContain(
      'const cairnMissing = ["SECURED_KEY","SECURED_TOKEN"].filter((name) => !process.env[name]);',
    );
    expect(out.source).toContain("test.skip(cairnSkipped.length > 0");
    expect(out.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "verifierGated", id: "secured_api" }),
    );
  });

  it("drop: the outcome is omitted and reported", () => {
    const out = exportPlaywright(httpSpec, { ...OPTS, verifiers: "drop" });
    expect(out.source).not.toContain("cairnHttpVerify");
    expect(out.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "verifierDropped", id: "secured_api" }),
    );
  });

  it("never bakes a credential: the generated source holds env names only", () => {
    const token = ["tok", "en-", "ZZ-91"].join("");
    process.env["SECURED_TOKEN"] = token;
    try {
      const out = exportPlaywright(httpSpec, OPTS);
      expect(out.source).not.toContain(token);
    } finally {
      delete process.env["SECURED_TOKEN"];
    }
  });
});

describe("transform and xlsx in a project", () => {
  async function project() {
    const dir = await mkdtemp(join(tmpdir(), "cairn-data-project-"));
    directories.push(dir);
    await mkdir(join(dir, "flows"), { recursive: true });
    await mkdir(join(dir, "transforms"), { recursive: true });
    await writeFile(
      join(dir, "transforms", "shape.ts"),
      "export default async function transform(ctx: { output: { path: string } }) {\n  return { ok: true, path: ctx.output.path };\n}\n",
    );
    const authored = spec({
      name: "shaped",
      outcomes: [
        {
          id: "wb",
          description: "workbook",
          verify: {
            xlsx: {
              path: "${artifacts.shaped.path}",
              sheets: [{ name: "Products", contains: ["SKU"] }],
              headers: { includesInOrder: "${captures.cols.headers}" },
            },
          },
        },
      ],
      steps: [
        { id: "open", open: "/p" },
        {
          id: "cols",
          capture: { assign: "cols", table: { by: "role", role: "table" } },
        },
        {
          id: "get",
          download: {
            by: "role",
            role: "button",
            name: "Export",
            saveAs: "raw.xlsx",
            assign: "raw",
          },
        },
        {
          id: "shape",
          transform: {
            file: "../transforms/shape.ts",
            input: "${artifacts.raw.path}",
            saveAs: "shaped.xlsx",
            assign: "shaped",
          },
        },
      ],
    });
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: join(dir, "flows", "shaped.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    return { dir, parsed };
  }

  it("copies the transform next to the project and exports the xlsx check with its reader", async () => {
    const { dir, parsed } = await project();
    const out = exportPlaywrightProject([parsed], {
      projectRoot: dir,
      sourceRoot: join(dir, "flows"),
      outDir: join(dir, "out"),
    });
    const test = out.files.find(
      (f) => f.relPath === "tests/shaped.spec.ts",
    )!.source;
    expect(out.specs[0]!.coverage.skips.filter((s) => !s.soft)).toEqual([]);
    expect(test).toContain('await import("../verifiers/shape.ts")');
    expect(test).toContain("cairnRunTransform(");
    expect(test).toContain(
      'output: { path: cairnTransformOut, relativePath: "transforms/shaped.xlsx" }',
    );
    expect(test).toContain("cairnAssertXlsx(");
    expect(out.verifierFiles.map((f) => f.relPath)).toContain(
      "verifiers/shape.ts",
    );
    const names = out.files.map((f) => f.relPath);
    expect(names).toEqual(
      expect.arrayContaining([
        "lib/dataXlsx.ts",
        "lib/dataValue.ts",
        "lib/dataTransform.ts",
        "lib/runtime/xlsxJudge.ts",
        "lib/runtime/matchers.ts",
        "lib/runtime/refs.ts",
        "lib/runtime/workbook.js",
        "lib/runtime/workbook.d.ts",
      ]),
    );
    // The runtime modules are the generated copies of the runner's.
    expect(
      out.files.find((f) => f.relPath === "lib/runtime/matchers.ts")!.source,
    ).toBe(renderRuntimeModule("matchers", "ts"));
    expect(out.specs[0]!.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "transformInProcess" }),
    );
  });

  it("a JavaScript project writes plain modules and the reader without declarations", async () => {
    const { dir, parsed } = await project();
    const out = exportPlaywrightProject([parsed], {
      projectRoot: dir,
      sourceRoot: join(dir, "flows"),
      outDir: join(dir, "out"),
      lang: "js",
    });
    const names = out.files.map((f) => f.relPath);
    expect(names).toContain("lib/runtime/workbook.js");
    expect(names).not.toContain("lib/runtime/workbook.d.ts");
    expect(names).toContain("lib/runtime/xlsxJudge.js");
    const judge = out.files.find(
      (f) => f.relPath === "lib/runtime/xlsxJudge.js",
    )!.source;
    expect(judge).toContain('from "./matchers.js"');
    expect(judge).toContain('from "./workbook.js"');
    for (const file of out.files.filter((f) => f.relPath.endsWith(".js"))) {
      const syntax = ts.transpileModule(file.source, {
        reportDiagnostics: true,
        fileName: file.relPath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          allowJs: true,
        },
      });
      expect(
        (syntax.diagnostics ?? []).map((d) =>
          ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        ),
        file.relPath,
      ).toEqual([]);
      expect(
        file.source,
        `${file.relPath} must not carry TypeScript syntax`,
      ).not.toMatch(/\bas unknown\b|: Promise<|\binterface \w+ \{/);
    }
  });

  it("the whole project compiles strictly with noUnusedLocals", async () => {
    const { dir, parsed } = await project();
    const full = exportPlaywrightProject([parsed], {
      projectRoot: dir,
      sourceRoot: join(dir, "flows"),
      outDir: join(dir, "out"),
    });
    const out = join(dir, "out");
    await mkdir(out, { recursive: true });
    await symlink(join(repoRoot, "node_modules"), join(out, "node_modules"));
    const files: string[] = [];
    for (const file of [
      ...full.files,
      ...full.verifierFiles.map((f) => ({
        relPath: f.relPath,
        source: readFileSync(f.sourcePath, "utf8"),
      })),
    ]) {
      const path = join(out, file.relPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.source);
      if (/\.(ts|d\.ts)$/.test(path)) files.push(path);
    }
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      strict: true,
      noUnusedLocals: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && !d.file.fileName.includes("/node_modules/"))
      .map(
        (d) =>
          `${d.file?.fileName.split("/out/")[1]}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      );
    expect(diagnostics).toEqual([]);
  }, 60_000);
});

describe("the full single-file export compiles strictly and parses as JavaScript", () => {
  it("TypeScript: strict + noUnusedLocals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-data-single-"));
    directories.push(dir);
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const path = join(dir, "data.spec.ts");
    await writeFile(
      path,
      exportPlaywright(FULL, {
        ...OPTS,
        sourcePath: join(dir, "data.yml"),
        outPath: path,
      }).source,
    );
    const program = ts.createProgram([path], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      strict: true,
      noUnusedLocals: true,
      noEmit: true,
      skipLibCheck: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && !d.file.fileName.includes("/node_modules/"))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("JavaScript: no TypeScript syntax survives", () => {
    const source = exportPlaywright(FULL, {
      ...OPTS,
      lang: "js",
      outPath: "/proj/exports/data.spec.js",
    }).source;
    const syntax = ts.transpileModule(source, {
      reportDiagnostics: true,
      fileName: "data.spec.js",
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
      },
    });
    expect(
      (syntax.diagnostics ?? []).map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ),
    ).toEqual([]);
    expect(source).not.toMatch(
      /\bas unknown\b|: Promise<|\binterface \w+ \{|<T>\(/,
    );
    expect(source).toContain("export function matchPaths(");
  });
});

/* ----- goldens ----- */

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "goldens");

/** `.golden.ts.txt` goldens are type-checked as specs; glue modules import `lib/` siblings, so theirs are `.glue.ts.txt`. */
function checkGolden(name: string, source: string, kind = "golden"): void {
  const goldenPath = join(GOLDEN_DIR, `${name}.${kind}.ts.txt`);
  if (process.env["UPDATE_GOLDENS"] === "1" || !existsSync(goldenPath)) {
    writeFileSync(goldenPath, source);
    return;
  }
  expect(source).toBe(readFileSync(goldenPath, "utf8"));
}

describe("goldens", () => {
  it("a project test file with every data verifier (the glue stays in lib/)", () => {
    const parsed: ParseResult = {
      spec: FULL,
      resolved: FULL,
      path: "/proj/flows/data.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const out = exportPlaywrightProject([parsed], {
      projectRoot: "/proj",
      sourceRoot: "/proj/flows",
      outDir: "/proj/export",
      httpDatasources: DATASOURCES,
    });
    checkGolden(
      "data-verifiers",
      out.files.find((f) => f.relPath === "tests/data_checks.spec.ts")!.source,
    );
  });

  it.each(["dataHttp", "dataValue", "dataNetwork", "dataTransform"] as const)(
    "the %s glue (TypeScript, as lib/ writes it)",
    (piece) => {
      checkGolden(`data-${piece}`, renderDataPieceModule(piece, "ts"), "glue");
    },
  );
});
