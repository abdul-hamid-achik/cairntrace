/* oxlint-disable unicorn/no-thenable -- `if.then` in spec fixtures is a step list, never a function */
/**
 * F14 control flow in the Playwright exporter: repeat → bounded for loops,
 * if/else → if blocks, wait.any → Promise.any, wait.all → one expect.poll
 * over every condition, optional/assign waits,
 * a retried use → a try/catch retry loop. The golden is also type-checked
 * under strict + noUnusedLocals by playwrightExporter.validation.test.ts
 * (every `*.golden.ts.txt` in goldens/). Regenerate intentionally with
 * UPDATE_GOLDENS=1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../parser/parseSpec";
import { SpecSchema, type RetryUseStep, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";

const GOLDEN_DIR = join(dirname(new URL(import.meta.url).pathname), "goldens");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

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
  if (UPDATE || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, source);
    return;
  }
  expect(source).toBe(readFileSync(goldenPath, "utf8"));
}

const click = (selector: string) => ({
  click: { by: "selector" as const, selector },
});

function controlFlowSpec(): Spec {
  const spec = SpecSchema.parse({
    version: 1,
    name: "golden_control_flow",
    intent: "export repeat, if, wait groups, optional waits and retries",
    steps: [
      { id: "go", open: "https://example.com/rows" },
      {
        id: "maybe_banner",
        wait: {
          text: "Maintenance",
          timeoutMs: 2000,
          optional: true,
          assign: "banner",
        },
      },
      {
        id: "dismiss",
        if: {
          condition: { var: "waits.banner.matched", equals: true },
          then: [{ click: { by: "role", role: "button", name: "Dismiss" } }],
          else: [{ wait: { ms: 100 } }],
        },
      },
      {
        id: "load_more",
        repeat: {
          max: 5,
          indexVar: "page",
          until: { text: "All rows loaded" },
          steps: [
            click("#more-${repeat.index}"),
            {
              if: {
                condition: { var: "repeat.page", in: [0, 2] },
                then: [
                  {
                    fill: {
                      by: "label",
                      name: "Note",
                      value: "page ${repeat.iteration}",
                    },
                    verifyFill: false,
                  },
                ],
              },
            },
          ],
        },
      },
      { id: "fixed", repeat: { max: 3, steps: [{ press: "ArrowDown" }] } },
      {
        id: "soft",
        repeat: {
          max: 2,
          until: { url: { includes: "/done" } },
          onMax: "continue",
          steps: [{ press: "Enter" }],
        },
      },
      {
        id: "outcome",
        wait: {
          any: [{ text: "Saved" }, { selector: ".error", state: "visible" }],
          timeoutMs: 5000,
          assign: "saved",
        },
      },
      {
        id: "on_error",
        when: { var: "waits.saved.index", equals: 1 },
        ...click(".retry"),
      },
      {
        id: "both",
        wait: {
          all: [{ url: { includes: "/done" } }, { notText: "Loading" }],
          timeoutMs: 4000,
        },
      },
      {
        id: "unread_optional",
        wait: { selector: ".toast", optional: true, timeoutMs: 1000 },
      },
      {
        id: "mode_gate",
        when: { var: "mode", equals: "fast", resolved: "fast" },
        ...click("#fast"),
      },
    ],
    outcomes: [
      {
        id: "done",
        description: "the list reports completion",
        verify: { text: { contains: "Done" } },
      },
    ],
  });
  // What parseSpec().resolved holds for `use: { action, retry }`.
  const retried: RetryUseStep = {
    id: "submit",
    use: {
      action: "submit_form",
      retry: { times: 2, until: "text:Thanks", delayMs: 250 },
    },
    steps: [
      {
        id: "press_submit",
        click: { by: "role", role: "button", name: "Submit" },
      },
    ],
  };
  return { ...spec, steps: [...(spec.steps ?? []), retried] };
}

describe("exportPlaywright — F14 control flow", () => {
  it("renders loops, branches, wait groups and retries (golden)", () => {
    const result = exportPlaywright(controlFlowSpec());
    checkGolden("control-flow", result.source);
    expect(result.coverage.skips.filter((skip) => !skip.soft)).toEqual([]);
    expect(result.source).toContain(
      "for (let cairnRepeat1 = 0; cairnRepeat1 < 5; cairnRepeat1++) {",
    );
    expect(result.source).toContain("await Promise.any([");
    // wait.all holds only when every condition holds at the same poll.
    expect(result.source).toContain("await expect.poll(async () => [(");
    expect(result.source).toContain(
      "].every(Boolean), { timeout: 4000 }).toBe(true);",
    );
    expect(result.source).not.toContain("Promise.all(");
    expect(result.source).toMatch(/} else \{/);
    expect(result.source).toContain("catch (error)");
  });

  it("hard-skips a condition with no Playwright equivalent instead of dropping it", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "untranslatable",
      intent: "a capture-based condition",
      steps: [
        {
          id: "gate",
          if: {
            condition: { var: "captures.order.status", equals: "shipped" },
            then: [click("#x")],
          },
        },
        {
          id: "poll",
          repeat: {
            max: 2,
            until: { var: "runs.seed.count", exists: true },
            steps: [click("#y")],
          },
        },
      ],
      outcomes: [
        { id: "o", description: "d", verify: { console: { errorsMax: 0 } } },
      ],
    });
    const result = exportPlaywright(spec);
    const hard = result.coverage.skips.filter((skip) => !skip.soft);
    expect(hard.map((skip) => skip.id)).toEqual(["gate", "poll"]);
    expect(hard[0]!.reason).toContain("has no Playwright translation");
    expect(result.source).toContain('test.fixme("untranslatable"');
    expect(result.source).toContain("if skipped —");
    expect(result.source).toContain("repeat skipped —");
  });

  it("exports a parsed spec: nested uses inlined, var values from the use site", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-export-f14-"));
    await mkdir(join(dir, "actions"), { recursive: true });
    await writeFile(
      join(dir, "actions/pick.yml"),
      `version: 1
name: pick
vars:
  size: small
steps:
  - id: pick_size
    when: { var: size, equals: large }
    click: { by: selector, selector: "#large" }
`,
    );
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: parsed_nested
intent: nested use in a loop
imports: [actions/pick.yml]
outcomes:
  - id: o
    description: d
    verify: { console: { errorsMax: 0 } }
steps:
  - id: loop
    repeat:
      max: 2
      steps:
        - use: { action: pick, vars: { size: large } }
`,
    );
    const parsed = await parseSpec(join(dir, "spec.yml"));
    const result = exportPlaywright(parsed.resolved, {
      sourcePath: parsed.path,
      stepOrigins: parsed,
    });
    expect(result.source).toContain('if (String("large") === "large") {');
    expect(result.coverage.skips.filter((skip) => !skip.soft)).toEqual([]);

    // --project: the nested use becomes a call to the action module, a
    // retried use a retry loop around that call.
    const retryDir = join(dir, "retry.yml");
    await writeFile(
      retryDir,
      `version: 1
name: project_retry
intent: retried action call
imports: [actions/pick.yml]
vars:
  mode: fast
outcomes:
  - id: o
    description: d
    verify: { console: { errorsMax: 0 } }
steps:
  - id: loop
    repeat:
      max: 2
      steps:
        - use: { action: pick, vars: { size: large } }
  - id: again
    use: { action: pick, retry: { times: 1 } }
  - id: gated
    when: { var: mode, in: [fast, turbo] }
    click: { by: selector, selector: "#go" }
`,
    );
    const project = exportPlaywrightProject([await parseSpec(retryDir)]);
    const test = project.files.find((file) =>
      file.relPath.endsWith("retry.spec.ts"),
    );
    expect(test?.source).toContain("for (let cairnRepeat1 = 0;");
    expect(test?.source).toMatch(/for \(let cairnRepeat1[^]*await pick\(/);
    expect(test?.source).toContain(
      "for (let cairnAttempt2 = 1; ; cairnAttempt2++) {",
    );
    // The spec's own var predicates resolve against the spec's vars.
    expect(test?.source).toContain(
      'if (["fast", "turbo"].includes(String("fast"))) {',
    );
    const module = project.files.find((file) => file.relPath.includes("pick"));
    expect(module?.source).toContain("String(size)");
  });
});
