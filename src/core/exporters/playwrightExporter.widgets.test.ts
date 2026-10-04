/**
 * F15 widget kit in the Playwright exporter: set / check / uncheck / choose
 * / form become `cairnWidget` / `cairnWidgetForm` calls that embed the same
 * in-page runtime `cairn run` uses; click optional / dispatch / fallback and
 * fill mode: set / optional get native Playwright equivalents. The golden is
 * type-checked under strict + noUnusedLocals by
 * playwrightExporter.validation.test.ts (the embedded runtime string is
 * replaced by a placeholder in the golden). Regenerate with UPDATE_GOLDENS=1.
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
import { SpecSchema, type Spec } from "../schema/spec.v1";
import {
  defaultWidgets,
  driverModuleExpression,
  widgetScriptParts,
  type PreparedWidgets,
} from "../widgets/runtime";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";

const HERE = dirname(new URL(import.meta.url).pathname);
const GOLDEN_DIR = join(HERE, "goldens");
const TMP_DIR = join(GOLDEN_DIR, ".typecheck-widgets-tmp");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** The two embedded runtime strings, swapped for a placeholder. */
function withoutRuntime(source: string): string {
  return source
    .replace(
      /^const CAIRN_WIDGETS_PREFIX = ".*";$/m,
      'const CAIRN_WIDGETS_PREFIX = "<widget runtime prefix>";',
    )
    .replace(
      /^const CAIRN_WIDGETS_SUFFIX = ".*";$/m,
      'const CAIRN_WIDGETS_SUFFIX = "<widget runtime suffix>";',
    );
}

function embedded(source: string, name: string): string {
  const match = new RegExp(`^const ${name} = (".*");$`, "m").exec(source);
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
  const normalized = withoutRuntime(source);
  if (UPDATE || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, normalized);
    return;
  }
  expect(normalized).toBe(readFileSync(goldenPath, "utf8"));
}

function widgetSpec(): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "golden_widgets",
    intent: "export widget steps and interaction flags",
    steps: [
      { id: "go", open: "https://example.com/form" },
      { id: "country", set: { field: "country", value: "Spain" } },
      {
        id: "contact",
        set: {
          by: "label",
          name: "Contact",
          value: { query: "Ada", option: "Ada Lovelace" },
          driver: "vue-multiselect",
          timeoutMs: 15000,
        },
      },
      { id: "terms", check: { field: "terms" } },
      { id: "no_news", uncheck: { field: "services", option: "News" } },
      {
        id: "owner",
        choose: { field: "owner", option: "No", optional: true },
      },
      {
        id: "answers",
        form: {
          fields: {
            setup: "Shared entity",
            entity_code: { value: "C100", dependsOn: "setup" },
            start_date: "today",
            products: ["Widget A", "Widget B"],
            legacy: { value: "No", optional: true },
          },
          onFailure: "dumpUnanswered",
        },
      },
      {
        id: "start",
        click: { by: "role", role: "button", name: "Start", optional: true },
      },
      {
        id: "save",
        click: {
          by: "role",
          role: "button",
          name: "Save",
          fallback: "dispatch",
        },
      },
      {
        id: "close",
        click: { by: "selector", selector: ".close", dispatch: true },
      },
      {
        id: "address",
        fill: {
          by: "label",
          name: "Address",
          value: "10 Main Street",
          mode: "set",
        },
      },
      {
        id: "referral",
        fill: {
          by: "label",
          name: "Referral",
          value: "SPRING",
          optional: true,
        },
      },
    ],
    outcomes: [
      {
        id: "saved",
        description: "saved",
        verify: { text: { contains: "Saved" } },
      },
    ],
  });
}

describe("exportPlaywright — F15 widget kit", () => {
  it("renders widget calls and interaction flags (golden)", () => {
    const result = exportPlaywright(widgetSpec());
    checkGolden("widgets", result.source);
    expect(result.coverage.skips.filter((skip) => !skip.soft)).toEqual([]);
    expect(result.coverage.stepsExported).toBe(result.coverage.stepsTotal);
    expect(result.source).toContain(
      'import { expect, test, type Page } from "@playwright/test";',
    );
    expect(result.source).toContain(
      'await cairnWidget(page, { op: "set", target: { "field": "country" }, value: "Spain", timeoutMs: 10000, mountMs: 10000 });',
    );
    expect(result.source).toContain(
      'await cairnWidget(page, { op: "choose", target: { "field": "owner" }, option: "No", optional: true, timeoutMs: 10000, mountMs: 750 });',
    );
    expect(result.source).toContain("await cairnWidgetForm(page, [");
    expect(result.source).toContain(
      '{ key: "entity_code", value: "C100", dependsOn: ["setup"] },',
    );
    // Dispatch and fill mode: set run the runner's own in-page ops.
    expect(result.source).toContain(
      'await cairnWidget(page, { op: "click", mode: "dispatch", target: { "locator": { "by": "selector", "selector": ".close" } }, mountMs: 5000 });',
    );
    expect(result.source).toMatch(/catch \(pointerError\)/);
    expect(result.source).toContain(".isVisible().catch(() => true)");
    expect(result.source).toMatch(
      /await cairnWidget\(page, \{ op: "fill", target: .*settleMs: 500, attempts: 4/,
    );
    expect(result.source).not.toContain('dispatchEvent("click")');
  });

  it("embeds exactly the script parts cairn run evaluates, custom drivers included", () => {
    const prepared: PreparedWidgets = {
      config: {
        fieldRoot: ['[data-field="{key}"]'],
        drivers: [{ custom: 0, file: "drivers/x.js" }],
      },
      customDrivers: [
        {
          file: "drivers/x.js",
          expression: driverModuleExpression(
            "export default { name: 'x', match: () => false, read: () => '', write() {} };",
            "drivers/x.js",
          ),
        },
      ],
    };
    const source = exportPlaywright(widgetSpec(), { widgets: prepared }).source;
    const parts = widgetScriptParts(prepared);
    expect(embedded(source, "CAIRN_WIDGETS_PREFIX")).toBe(parts.prefix);
    expect(embedded(source, "CAIRN_WIDGETS_SUFFIX")).toBe(parts.suffix);
    expect(source).toContain(
      `const CAIRN_WIDGETS_CONFIG = ${JSON.stringify(prepared.config)};`,
    );
    const plain = exportPlaywright(widgetSpec()).source;
    expect(embedded(plain, "CAIRN_WIDGETS_PREFIX")).toBe(
      widgetScriptParts(defaultWidgets()).prefix,
    );
  });

  it("emits no widget helper when the spec has no widget step", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "plain",
      intent: "no widgets",
      steps: [{ click: { by: "selector", selector: "#a" } }],
      outcomes: [
        { id: "ok", description: "ok", verify: { text: { contains: "x" } } },
      ],
    });
    const source = exportPlaywright(spec).source;
    expect(source).not.toContain("cairnWidget");
    expect(source).not.toContain("type Page");
  });

  it("writes lib/widgets for --project and the result type-checks strictly", () => {
    const projectDir = join(TMP_DIR, "project");
    rmSync(projectDir, { recursive: true, force: true });
    const spec = widgetSpec();
    const parsed: ParseResult = {
      spec,
      resolved: spec,
      path: join(projectDir, "flows", "golden_widgets.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const result = exportPlaywrightProject([parsed], {
      widgets: {
        config: { fieldRoot: ['[data-field="{key}"]'] },
        customDrivers: [],
      },
    });
    const lib = result.files.find((f) => f.relPath === "lib/widgets.ts");
    expect(lib).toBeDefined();
    expect(lib!.source).toContain("export async function cairnWidget(");
    expect(lib!.source).toContain("export async function cairnWidgetForm(");
    expect(lib!.source).toContain(
      'const CAIRN_WIDGETS_CONFIG = {"fieldRoot":["[data-field=\\"{key}\\"]"]};',
    );
    const test = result.files.find((f) => f.relPath.endsWith(".spec.ts"));
    expect(test!.source).toMatch(
      /import \{ cairnWidget, cairnWidgetForm \} from "\.\.\/lib\/widgets";/,
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
