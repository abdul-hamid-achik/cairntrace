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

  it("late-bound needles, eval, fill, and bound runtime splices", () => {
    const s = spec({
      version: 1,
      name: "golden_late_bound_text",
      intent:
        "run tokens and secrets in waits, when, eval, fill; bound splices",
      steps: [
        { id: "go", open: "https://example.com/orders" },
        {
          id: "create",
          request: {
            method: "POST",
            url: "/api/orders",
            body: { ref: "order-__CAIRN_RUN_TOKEN__" },
            assign: "created",
            expectStatus: 201,
          },
        },
        {
          id: "read_state",
          eval: {
            js: "return { id: window.__orderId, token: '__CAIRN_RUN_TOKEN__' };",
            assign: "state",
          },
        },
        {
          id: "wait_order",
          wait: { text: "Order __CAIRN_RUN_TOKEN__ created", timeoutMs: 5000 },
        },
        {
          id: "dismiss_banner",
          when: "text:Welcome back __CAIRN_SECRET_REF__DEMO_USER__",
          click: { by: "role", role: "button", name: "Dismiss" },
        },
        {
          id: "fill_reference",
          fill: {
            by: "label",
            name: "Reference",
            value: "${requests.created.body.id}-__CAIRN_RUN_TOKEN__",
          },
        },
        {
          id: "open_detail",
          open: "/orders/${evals.state.value.id}",
        },
      ],
      outcomes: [
        {
          id: "detail_shows_token",
          description: "detail page shows the run token",
          verify: { text: { contains: "__CAIRN_RUN_TOKEN__" } },
        },
      ],
    });
    const source = exportPlaywright(s, {
      sourcePath: "/tmp/late-text.yml",
    }).source;
    expect(source).not.toMatch(/__CAIRN_[A-Z_]+__/i);
    checkGolden("late-bound-text", source);
  });

  it("host commands: inline preconditions, run + teardown, capture, poll, env default", () => {
    const s = spec({
      version: 1,
      name: "golden_host_commands",
      intent:
        "preconditions, a run step, a capture, a polled outcome and a teardown through the bounded helper",
      vars: {},
      preconditions: {
        env: { APP_TOKEN: "__CAIRN_SECRET_REF__APP_TOKEN__" },
        commands: [
          { name: "reset", run: "bun run reset", timeoutMs: 45000 },
          { run: "psql -c 'select 1' | head -1" },
        ],
      },
      steps: [
        {
          id: "seed",
          run: {
            node: "../scripts/seed.mjs",
            args: ["create", "__CAIRN_RUN_TOKEN__"],
            assign: "seeded",
            timeoutMs: 30000,
          },
        },
        {
          id: "open_item",
          open: "/items?id=${runs.seeded.id}&region=__CAIRN_ENV_DEFAULT__524547494f4e_6575__",
        },
        {
          id: "read_title",
          capture: {
            assign: "title",
            text: { by: "role", role: "heading", name: "Item" },
          },
        },
        {
          id: "echo_title",
          fill: { by: "label", name: "Echo", value: "${captures.title}" },
        },
      ],
      outcomes: [
        {
          id: "banner",
          description: "the saved banner shows and stays",
          verify: {
            text: { contains: "Saved" },
            poll: { timeoutMs: 15000, everyMs: 500 },
          },
        },
        {
          id: "stays",
          description: "the status stays done",
          verify: {
            text: { contains: "Done" },
            poll: { timeoutMs: 10000, stableMs: 2000 },
          },
        },
      ],
      teardown: {
        steps: [{ id: "cleanup", run: "node ../scripts/clean.mjs" }],
        failRun: true,
        timeoutMs: 60000,
      },
    });
    const source = exportPlaywright(s, {
      sourcePath: "/tmp/flows/host.yml",
      outPath: "/tmp/exports/host.spec.ts",
      preconditions: "inline",
      testIdAttribute: "data-answer-key",
    }).source;
    expect(source).not.toMatch(/__CAIRN_[A-Z_]+__/i);
    checkGolden("host-commands", source);
  });

  it("verifier gate: a node verifier gated on env, a datasource verifier recorded as skipped", () => {
    const s = spec({
      version: 1,
      name: "golden_verifier_gate",
      intent:
        "node and datasource verifiers are reported skipped, never passed",
      steps: [{ id: "go", open: "https://example.com/" }],
      outcomes: [
        {
          id: "page_ok",
          description: "the page loads",
          verify: { text: { contains: "Example" } },
        },
        {
          id: "durable",
          description: "the durable processing finished",
          verify: {
            script: {
              runtime: "node",
              file: "./verify.mjs",
              fixtures: { uri: "__CAIRN_SECRET_REF__MONGO_URI__" },
            },
          },
        },
        {
          id: "db_row",
          description: "the row exists",
          verify: {
            mongo: {
              source: "main",
              collection: "items",
              filter: {},
              expect: { count: 1 },
            },
          },
        },
      ],
    });
    const source = exportPlaywright(s, {
      sourcePath: "/tmp/flows/gate.yml",
      outPath: "/tmp/exports/gate.spec.ts",
      verifiers: "gate",
      gateEnv: ["TEMPORAL_API_BASE"],
      datasourceEnv: { main: ["MONGO_URI"] },
    }).source;
    expect(source).not.toMatch(/__CAIRN_[A-Z_]+__/i);
    checkGolden("verifier-gate", source);
  });

  it("strict locators (no .first(); nth and raw selectors unchanged)", () => {
    const s = spec({
      version: 1,
      name: "strict_locators",
      intent: "Locators fail on ambiguity instead of taking the first match",
      coldStart: "guest",
      steps: [
        { id: "go", open: "https://example.com/form" },
        { id: "save", click: { by: "role", role: "button", name: "Save" } },
        {
          id: "second_save",
          click: { by: "role", role: "button", name: "Save", nth: 1 },
        },
        { id: "email", fill: { by: "label", name: "Email", value: "a@b.c" } },
        { id: "raw", click: { by: "selector", selector: "#plain" } },
        { id: "plan", click: { by: "text", text: "Pro plan" } },
      ],
      outcomes: [
        {
          id: "saved",
          description: "the toast says Saved",
          verify: { text: { contains: "Saved" } },
        },
        {
          id: "on_form",
          description: "still on the form",
          verify: { url: { startsWith: "https://example.com/form" } },
        },
      ],
    });
    const source = exportPlaywright(s, {
      sourcePath: "/tmp/flows/strict.yml",
      outPath: "/tmp/exports/strict.spec.ts",
      strictLocators: true,
    }).source;
    expect(source).not.toContain(".first()");
    checkGolden("strict-locators", source);
  });
});
