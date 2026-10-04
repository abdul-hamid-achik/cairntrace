/**
 * F20 page prelude in the Playwright exporter: an eval or browser verifier
 * that mentions `__cairn` runs `CAIRN_PRELUDE` (the same installer `cairn
 * run` prepends, with the config's `browser.appHandle` getters) first;
 * `wait: { app }` becomes `expect.poll(() => cairnAppCheck(…))`. The golden
 * (embedded prelude replaced by a placeholder) is type-checked under strict
 * + noUnusedLocals by playwrightExporter.validation.test.ts. Regenerate
 * with UPDATE_GOLDENS=1.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import type { ParseResult } from "../parser/parseSpec";
import { preludeInstallExpression } from "../prelude/prelude";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";

const HERE = dirname(new URL(import.meta.url).pathname);
const GOLDEN_DIR = join(HERE, "goldens");
const TMP_DIR = join(GOLDEN_DIR, ".typecheck-prelude-tmp");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const HANDLES = {
  store: "window.appStore",
  user: "window.appStore.state.user",
};

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function preludeSpec(): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "golden_prelude",
    intent: "export page helpers and app handle waits",
    steps: [
      { id: "go", open: "https://example.com/app" },
      {
        id: "signed_in",
        wait: { app: { path: "user.id", equals: 7 }, timeoutMs: 5000 },
      },
      {
        id: "saved_or_ready",
        wait: {
          any: [
            { text: "Saved" },
            { app: { path: "store.state.ready", exists: true } },
          ],
          timeoutMs: 8000,
        },
      },
      {
        id: "rows",
        eval: {
          js: "return __cairn.rows('#people').length;",
          assign: "rowCount",
        },
      },
      { id: "plain", eval: { js: "return document.title;" } },
    ],
    outcomes: [
      {
        id: "heading",
        description: "heading read through the prelude",
        verify: {
          script: {
            run: "return { ok: __cairn.text('h1') === 'Team', evidence: null };",
          },
        },
      },
    ],
  });
}

function embeddedPrelude(source: string): string {
  const match = /^const CAIRN_PRELUDE = (".*");$/m.exec(source);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as string;
}

function checkGolden(name: string, source: string): void {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  expect(
    (out.diagnostics ?? []).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    ),
  ).toEqual([]);
  const goldenPath = join(GOLDEN_DIR, `${name}.golden.ts.txt`);
  const normalized = source.replace(
    /^const CAIRN_PRELUDE = ".*";$/m,
    'const CAIRN_PRELUDE = "<cairn prelude>";',
  );
  if (UPDATE || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, normalized);
    return;
  }
  expect(normalized).toBe(readFileSync(goldenPath, "utf8"));
}

describe("exportPlaywright — F20 prelude", () => {
  it("prepends CAIRN_PRELUDE where __cairn is used and polls app checks (golden)", () => {
    const result = exportPlaywright(preludeSpec(), { appHandles: HANDLES });
    checkGolden("prelude", result.source);
    expect(result.coverage.skips.filter((skip) => !skip.soft)).toEqual([]);
    expect(result.coverage.stepsExported).toBe(result.coverage.stepsTotal);
    expect(embeddedPrelude(result.source)).toBe(
      `${preludeInstallExpression(HANDLES)};\n`,
    );
    expect(result.source.match(/^const CAIRN_PRELUDE = /gm)).toHaveLength(1);
    expect(result.source).toContain(
      'import { expect, test, type Page } from "@playwright/test";',
    );
    expect(result.source).toContain(
      'await expect.poll(() => cairnAppCheck(page, "user.id", {"equals":7}), { timeout: 5000 }).toBe(true);',
    );
    expect(result.source).toContain(
      'expect.poll(() => cairnAppCheck(page, "store.state.ready", {"exists":true}), { timeout: 8000 }).toBe(true).then(() => 1)',
    );
    expect(result.source).toContain(
      `{ source: CAIRN_PRELUDE + "return __cairn.rows('#people').length;", args: {} }`,
    );
    expect(result.source).toContain(
      '{ source: "return document.title;", args: {} }',
    );
    expect(result.source).toContain(
      `{ source: CAIRN_PRELUDE + "return { ok: __cairn.text('h1') === 'Team', evidence: null };"`,
    );
  });

  it("leaves exports without __cairn or app waits unchanged", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "plain",
      intent: "no prelude",
      steps: [{ eval: { js: "return window.__cairnOther;" } }],
      outcomes: [
        { id: "ok", description: "ok", verify: { text: { contains: "x" } } },
      ],
    });
    const source = exportPlaywright(spec, { appHandles: HANDLES }).source;
    expect(source).not.toContain("CAIRN_PRELUDE");
    expect(source).not.toContain("cairnAppCheck");
    expect(source).not.toContain("type Page");
  });

  it("writes lib/prelude for --project and the result type-checks strictly", () => {
    const projectDir = join(TMP_DIR, "project");
    rmSync(projectDir, { recursive: true, force: true });
    const spec = preludeSpec();
    const parsed: ParseResult = {
      spec,
      resolved: spec,
      path: join(projectDir, "flows", "golden_prelude.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const result = exportPlaywrightProject([parsed], { appHandles: HANDLES });
    const lib = result.files.find((f) => f.relPath === "lib/prelude.ts");
    expect(lib).toBeDefined();
    expect(lib!.source).toContain("export const CAIRN_PRELUDE = ");
    expect(lib!.source).toContain("export async function cairnAppCheck(");
    expect(embeddedPrelude(lib!.source.replace("export const", "const"))).toBe(
      `${preludeInstallExpression(HANDLES)};\n`,
    );
    const test = result.files.find((f) => f.relPath.endsWith(".spec.ts"));
    expect(test!.source).toContain(
      'import { CAIRN_PRELUDE, cairnAppCheck } from "../lib/prelude";',
    );
    const written: string[] = [];
    for (const file of result.files) {
      const abs = join(projectDir, file.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.source);
      if (abs.endsWith(".ts") && !abs.endsWith("playwright.config.ts")) {
        written.push(abs);
      }
    }
    const program = ts.createProgram(written, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      types: ["node"],
      strict: true,
      noUnusedLocals: true,
      noEmit: true,
      skipLibCheck: true,
    });
    const own = new Set(written);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && own.has(d.file.fileName))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
    expect(diagnostics).toEqual([]);
  });
});

const rejecting = (message: string) => ({
  evaluate: () => Promise.reject(new Error(message)),
});

describe("cairnAppCheck under a strict CSP (M6)", () => {
  it("fails at once naming the CSP instead of polling to a timeout; other errors still read false", async () => {
    const { renderPreludeRuntime } = await import("./playwrightRuntime");
    const dir = join(HERE, "goldens", ".prelude-csp-tmp");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      const file = join(dir, "prelude.mjs");
      writeFileSync(file, renderPreludeRuntime("js", undefined));
      const { cairnAppCheck } = (await import(file)) as {
        cairnAppCheck: (
          page: { evaluate: () => Promise<unknown> },
          path: string,
          check: Record<string, unknown>,
        ) => Promise<boolean>;
      };
      await expect(
        cairnAppCheck(
          rejecting(
            "EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive",
          ),
          "store.ready",
          { equals: true },
        ),
      ).rejects.toThrow(
        /wait: \{ app \} cannot run: the page's Content Security Policy blocks string evaluation .*bypassCSP: true/,
      );
      await expect(
        cairnAppCheck(
          rejecting("Execution context was destroyed"),
          "store.ready",
          { equals: true },
        ),
      ).resolves.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
