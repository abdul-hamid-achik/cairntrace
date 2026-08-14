/**
 * Golden-file tests for the Playwright exporter.
 *
 * Each fixture spec renders to a checked-in `.golden.ts` snapshot; any change
 * to emission shows up as a reviewable diff instead of slipping through
 * substring asserts. Regenerate intentionally with:
 *
 *   UPDATE_GOLDENS=1 bun test src/core/exporters/playwrightExporter.golden.test.ts
 *
 * Every golden is ALSO parsed with the TypeScript compiler — the exporter can
 * never ship output that does not parse.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";

const GOLDEN_DIR = join(dirname(new URL(import.meta.url).pathname), "goldens");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

function spec(raw: unknown): Spec {
  return SpecSchema.parse(raw);
}

/** Assert the generated source parses as a TS module (no syntax errors). */
function assertParses(source: string, name: string): void {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  const syntactic = (out.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  expect(
    syntactic.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    `${name}: generated source must parse`,
  ).toEqual([]);
}

function checkGolden(name: string, source: string): void {
  assertParses(source, name);
  const goldenPath = join(GOLDEN_DIR, `${name}.golden.ts.txt`);
  if (UPDATE || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, source);
    return;
  }
  const expected = readFileSync(goldenPath, "utf8");
  expect(source).toBe(expected);
}

describe("exportPlaywright goldens", () => {
  it("kitchen-sink steps and outcomes", () => {
    const s = spec({
      version: 1,
      name: "golden_kitchen_sink",
      intent: "cover every commonly exported step and outcome shape",
      steps: [
        { id: "go", open: "https://example.com/app" },
        { id: "wait_text", wait: { text: "Welcome", timeoutMs: 5000 } },
        {
          id: "maybe_dismiss",
          when: "text:Accept cookies",
          click: { by: "role", role: "button", name: "Accept" },
        },
        { id: "hover_row", hover: { by: "selector", selector: ".row" } },
        { id: "fill_name", fill: { by: "label", name: "Name", value: "Ada" } },
        {
          id: "pick",
          select: { by: "selector", selector: "#plan", value: "pro" },
        },
        { id: "press_enter", press: "Enter" },
        { id: "scroll_down", scroll: { direction: "down", px: 300 } },
        {
          id: "eval_probe",
          eval: { js: "return document.title;", assign: "title" },
        },
      ],
      outcomes: [
        {
          id: "greets",
          description: "greeting is visible",
          verify: { text: { contains: "Hello" } },
        },
        {
          id: "on_dashboard",
          description: "landed on the dashboard",
          verify: { url: { startsWith: "https://example.com/dash" } },
        },
        {
          id: "rows_present",
          description: "at least 3 rows",
          verify: { count: { selector: ".row", atLeast: 3 } },
        },
        {
          id: "api_ok",
          description: "list API succeeded",
          verify: {
            network: { urlContains: "/api/list", status: { below: 400 } },
          },
        },
      ],
    });
    checkGolden(
      "kitchen-sink",
      exportPlaywright(s, { sourcePath: "/tmp/spec.yml" }).source,
    );
  });

  it("late-bound refs, reload rescue, node verifier, preconditions", () => {
    const s = spec({
      version: 1,
      name: "golden_late_bound",
      intent: "secrets/run-token stay late-bound; reload rescue; node verifier",
      preconditions: {
        commands: [
          { name: "reset_status", run: "mongosh --eval 'db.x.updateOne(...)'" },
        ],
      },
      steps: [
        { id: "go", open: "https://example.com/login" },
        {
          id: "fill_password",
          fill: {
            by: "selector",
            selector: "input[type=password]",
            value: "__CAIRN_SECRET_REF__APP_PASSWORD__",
          },
        },
        {
          id: "fill_unique",
          fill: {
            by: "selector",
            selector: "#site",
            value: "site-__CAIRN_RUN_TOKEN__.example.com",
          },
        },
        {
          id: "rescue_blank",
          eval: {
            js: "if (!document.querySelector('#card')) { location.reload(); }\nreturn 'ok';",
            assign: "rescued",
          },
        },
      ],
      outcomes: [
        {
          id: "durably_processed",
          description: "node verifier proves durable processing",
          verify: {
            script: {
              runtime: "node",
              file: "../verifiers/check.ts",
              fixtures: {
                expectedRoute: "next",
                token: "prefix-__CAIRN_RUN_TOKEN__",
                secret: "__CAIRN_SECRET_REF__API_KEY__",
              },
            },
          },
        },
      ],
    });
    checkGolden(
      "late-bound",
      exportPlaywright(s, {
        sourcePath: "/specs/flows/late.yml",
        outPath: "/specs/export/tests/late.spec.ts",
      }).source,
    );
  });
});
