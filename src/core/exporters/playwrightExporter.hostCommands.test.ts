/**
 * E10 / export v2 on the standalone exporter: `--preconditions` modes, `run:`
 * steps and `teardown:` through the bounded helper, `capture`, `poll:`, the
 * `--verifiers` modes and `${env.X:-default}` as a run-time read.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { envDefaultSentinel } from "./templateValue";

function spec(raw: Record<string, unknown>): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "host_cmds",
    intent: "host commands export through the bounded helper",
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

const OPTS = {
  sourcePath: "/proj/flows/a.yml",
  outPath: "/proj/exports/a.spec.ts",
} as const;

describe("--preconditions in a standalone file", () => {
  const withPre = spec({
    preconditions: {
      commands: [
        { name: "reset", run: "bun run reset", timeoutMs: 45_000 },
        { run: "psql -c 'select 1' | head -1" },
        { run: "echo docs only" },
      ],
    },
  });

  it("inline: a beforeAll through the bounded helper (argv where no shell is needed)", () => {
    const result = exportPlaywright(withPre, {
      ...OPTS,
      preconditions: "inline",
    });
    const src = result.source;
    expect(src).toContain("test.beforeAll(async () => {");
    expect(src).toContain(
      `if (process.env.SKIP_PRECONDITIONS === "1") {\n    return;\n  }`,
    );
    expect(src).toContain(
      `await runPrecondition({ argv: ["bun", "run", "reset"] }, { cwd: resolve(dirname(test.info().file), "../flows"), timeoutMs: 45000, label: "Precondition \\"reset\\"", context: cairnTestContext(test.info(), RUN_TOKEN) });`,
    );
    // A pipe needs the shell: the script stays one string for /bin/sh -c.
    expect(src).toContain(
      `await runPrecondition("psql -c 'select 1' | head -1"`,
    );
    // Documentary echo never runs.
    expect(src).not.toContain('docs only"');
    expect(src).toContain(
      `import { dirname, join, resolve } from "node:path";`,
    );
    expect(src).toContain("async function cairnCommand(");
    expect(src).toContain("async function runPrecondition(");
    expect(src).toContain("function cairnTestContext(");
    // Only the pieces that are called are inlined (noUnusedLocals).
    expect(src).not.toContain("function cairnLastJson(");
    expect(result.coverage.fixme).toBe(false);
    expect(result.coverage.skips.map((skip) => skip.id)).not.toContain(
      "preconditions",
    );
    expect(
      result.coverage.semanticRisks.some(
        (risk) => risk.kind === "requiredSetup",
      ),
    ).toBe(false);
  });

  it("inline: a command with a late-bound placeholder reads process.env at run time", () => {
    // A value that is set while exporting must never reach the generated code.
    const name = ["CAIRN", "EXPORT", "PROBE", "VALUE"].join("_");
    const secret = `value-${Math.random().toString(36).slice(2)}`;
    const previous = process.env[name];
    process.env[name] = secret;
    try {
      const result = exportPlaywright(
        spec({
          preconditions: {
            commands: [{ run: `deploy --token __CAIRN_SECRET_REF__${name}__` }],
          },
        }),
        { ...OPTS, preconditions: "inline" },
      );
      expect(result.source).toContain(`process.env.${name}`);
      expect(result.source).not.toContain(secret);
      expect(result.requiredEnv).toContain(name);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("skip and the default list the commands as a soft skip, never a hook", () => {
    for (const preconditions of [undefined, "skip"] as const) {
      const result = exportPlaywright(withPre, {
        ...OPTS,
        ...(preconditions ? { preconditions } : {}),
      });
      expect(result.source).not.toContain("test.beforeAll");
      expect(result.source).toContain("PRECONDITIONS (NOT exported");
      expect(result.coverage.diagnosticSkips.map((skip) => skip.id)).toContain(
        "preconditions",
      );
      expect(result.coverage.fixme).toBe(false);
      expect(
        result.coverage.semanticRisks.some(
          (risk) => risk.kind === "requiredSetup",
        ),
      ).toBe(true);
    }
  });

  it("manifest: nothing runs, and the structured commands are returned for the manifest", () => {
    const result = exportPlaywright(withPre, {
      ...OPTS,
      preconditions: "manifest",
    });
    expect(result.source).not.toContain("test.beforeAll");
    expect(result.source).toContain("listed in .cairn-export.json");
    expect(result.setup.preconditions).toEqual([
      {
        name: "reset",
        run: "bun run reset",
        cwd: "/proj/flows",
        timeoutMs: 45_000,
      },
      {
        run: "psql -c 'select 1' | head -1",
        cwd: "/proj/flows",
        timeoutMs: 120_000,
      },
    ]);
  });

  it("global needs a project: a standalone file has no global setup", () => {
    expect(() =>
      exportPlaywright(withPre, { ...OPTS, preconditions: "global" }),
    ).toThrow(/--preconditions global needs --project or --into/);
  });
});

describe("run: steps", () => {
  const runSpec = spec({
    steps: [
      {
        id: "seed",
        run: {
          node: "../fixtures/seed.mjs",
          args: ["create", "7"],
          assign: "seeded",
          timeoutMs: 30_000,
        },
      },
      { id: "plain", run: "touch /tmp/marker" },
      { id: "piped", run: "echo '{\"a\":1}' | cat" },
      { open: "https://example.com/?id=${runs.seeded.id}" },
    ],
  });

  it("exports through the helper with --preconditions inline, binding assign for ${runs.…} splices", () => {
    const result = exportPlaywright(runSpec, {
      ...OPTS,
      preconditions: "inline",
    });
    const src = result.source;
    expect(result.coverage.fixme).toBe(false);
    expect(src).toContain("let cairnRuns_seeded: unknown;");
    expect(src).toContain(
      `cairnRuns_seeded = cairnLastJson(await cairnCommand({ argv: ["node", resolve(dirname(test.info().file), "../fixtures/seed.mjs"), "create", "7"] }, { cwd: resolve(dirname(test.info().file), "../flows"), timeoutMs: 30000, label: "run node seed.mjs → seeded", context: cairnTestContext(test.info(), RUN_TOKEN), capture: true }), "run node seed.mjs → seeded");`,
    );
    // No shell for a plain command; the shell for a pipe.
    expect(src).toContain(
      `await cairnCommand({ argv: ["touch", "/tmp/marker"] }, {`,
    );
    expect(src).toContain(`await cairnCommand("echo '{\\"a\\":1}' | cat", {`);
    expect(src).toContain(
      'await page.goto(`https://example.com/?id=${cairnSplice(cairnRuns_seeded, ["id"])}`);',
    );
    expect(src).toContain("function cairnLastJson(");
    // A run step's default budget is its own 120s timeout.
    expect(src).toContain("const RUN_TOKEN =");
  });

  it("stays a hard skip (test.fixme) without an explicit mode, with a precise reason", () => {
    for (const preconditions of [undefined, "skip", "manifest"] as const) {
      const result = exportPlaywright(runSpec, {
        ...OPTS,
        ...(preconditions ? { preconditions } : {}),
      });
      expect(result.coverage.fixme).toBe(true);
      const reasons = result.coverage.skips.map((skip) => skip.reason);
      expect(
        reasons.some((r) => r.includes("--preconditions inline|global")),
      ).toBe(true);
      expect(result.source).toContain("test.fixme(");
      expect(result.source).not.toContain("cairnCommand");
    }
  });

  it("never prints the command text into code comments or the report", () => {
    const marker = "TOPSECRETARG";
    const result = exportPlaywright(
      spec({ steps: [{ id: "s", run: `deploy --flag ${marker}` }] }),
      { ...OPTS },
    );
    expect(result.source).not.toContain(marker);
    expect(JSON.stringify(result.coverage)).not.toContain(marker);
  });

  it("falls back to a baked absolute path (and says so) when there is no output location", () => {
    const result = exportPlaywright(runSpec, {
      sourcePath: "/proj/flows/a.yml",
      preconditions: "inline",
    });
    expect(result.source).toContain(`"/proj/fixtures/seed.mjs"`);
    expect(
      result.coverage.semanticRisks.some(
        (risk) => risk.kind === "absolutePath",
      ),
    ).toBe(true);
  });
});

describe("teardown:", () => {
  const teardownSpec = spec({
    steps: [{ id: "go", open: "https://example.com/" }],
    teardown: {
      steps: [
        { id: "drop_data", run: "node cleanup.mjs" },
        { id: "reload", open: "https://example.com/reset" },
      ],
      failRun: true,
      timeoutMs: 90_000,
    },
  });

  it("runs after the outcomes on every exit path (finally), each item isolated", () => {
    const result = exportPlaywright(teardownSpec, {
      ...OPTS,
      preconditions: "inline",
    });
    const src = result.source;
    expect(src).toContain(`let cairnRunStatus: string = "failed";`);
    expect(src).toContain("try {");
    expect(src).toContain(`cairnRunStatus = "passed";`);
    expect(src).toContain("finally {");
    expect(src).toContain("const cairnTeardownDeadline = Date.now() + 90000;");
    // CAIRN_RUN_STATUS reaches run items; the deadline bounds their timeout.
    expect(src).toContain(
      "cairnTestContext(test.info(), RUN_TOKEN, cairnRunStatus)",
    );
    expect(src).toContain("cairnTeardownDeadline - Date.now()");
    // A failed item is reported, not thrown; failRun fails a passed test.
    expect(src).toContain(`type: "teardown-failed"`);
    expect(src).toContain(
      `if (cairnTeardownErrors.length > 0 && cairnRunStatus === "passed") {`,
    );
    // Teardown steps render like steps (the browser item too).
    expect(src).toContain(`await page.goto("https://example.com/reset");`);
    expect(result.coverage.fixme).toBe(false);
    expect(src.indexOf("--- outcomes")).toBeLessThan(src.indexOf("finally {"));
    // What cannot be honored is said, not silent.
    const risk = result.coverage.semanticRisks.find(
      (r) => r.kind === "teardownBestEffort",
    );
    expect(risk?.detail).toContain("test timeout");
    expect(risk?.detail).toContain("SIGINT");
    expect(risk?.detail).toContain("failRun");
  });

  it("without failRun a failed item never fails the test", () => {
    const result = exportPlaywright(
      spec({ teardown: [{ run: "node cleanup.mjs" }] }),
      { ...OPTS, preconditions: "inline" },
    );
    expect(result.source).not.toContain("(failRun)");
    expect(result.source).toContain("Date.now() + 300000");
  });

  it("is a soft skip with a pointer to the mode when not exported", () => {
    const result = exportPlaywright(teardownSpec, { ...OPTS });
    expect(result.source).not.toContain("finally {");
    const skip = result.coverage.diagnosticSkips.find(
      (s) => s.id === "teardown",
    );
    expect(skip?.reason).toContain("--preconditions inline|global");
  });
});

describe("capture steps", () => {
  const captureSpec = spec({
    steps: [
      { id: "open", open: "https://example.com/" },
      {
        id: "cap_text",
        capture: {
          assign: "title",
          text: { by: "role", role: "heading", name: "Welcome" },
        },
      },
      {
        id: "cap_attr",
        capture: {
          assign: "href",
          attribute: {
            by: "selector",
            selector: "a.cta",
            attributeName: "href",
          },
          timeoutMs: 1500,
        },
      },
      {
        id: "cap_table",
        capture: { assign: "rows", table: { by: "role", role: "table" } },
      },
      {
        id: "cap_value",
        capture: { assign: "who", value: { by: "label", name: "Name" } },
      },
      {
        id: "reuse",
        open: "https://example.com/?t=${captures.title}&n=${captures.rows.rowCount}",
      },
    ],
  });

  it("exports page-derived captures through the same in-page probe, binding ${captures.…}", () => {
    const result = exportPlaywright(captureSpec, {
      ...OPTS,
      testIdAttribute: "data-answer-key",
    });
    const src = result.source;
    expect(result.coverage.fixme).toBe(false);
    expect(src).toContain(
      `cairnCaptures_title = await cairnCapture(page, "text", { "by": "role", "role": "heading", "name": "Welcome" }, { timeoutMs: 5000, includeHidden: false, testIdAttribute: "data-answer-key" });`,
    );
    expect(src).toContain(
      `await cairnCapture(page, "attribute", { "by": "selector", "selector": "a.cta" }, { timeoutMs: 1500, includeHidden: true, attribute: "href", testIdAttribute: "data-answer-key" });`,
    );
    expect(src).toContain(`"table"`);
    // A capture nobody splices is still taken (a missing target fails the step).
    expect(src).toMatch(/^ {2}await cairnCapture\(page, "value"/m);
    expect(src).toContain("cairnSplice(cairnCaptures_title, [])");
    expect(src).toContain('cairnSplice(cairnCaptures_rows, ["rowCount"])');
    expect(src).toContain("const CAIRN_PROBE_PREFIX =");
    expect(src).toMatch(
      /import \{ [^}]*type Page[^}]* \} from "@playwright\/test";/,
    );
  });

  it("a ${captures.…} reference with no capture step stays an unresolved splice (hard skip)", () => {
    const result = exportPlaywright(
      spec({ steps: [{ open: "https://example.com/?t=${captures.nothing}" }] }),
      { ...OPTS },
    );
    expect(result.coverage.fixme).toBe(true);
    expect(
      result.coverage.skips.map((skip) => skip.reason).join("\n"),
    ).toContain("unresolved splice ${captures.nothing}");
  });
});

describe("table verifier", () => {
  it("exports through the probe: cairnReadTable + cairnJudgeTable, inlining only what it calls", () => {
    const result = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "grid",
            description: "the table lists the rows",
            verify: {
              table: {
                locator: { by: "role", role: "table", name: "Orders" },
                rows: { equals: 2 },
                contains: [{ Customer: "Acme" }],
                timeoutMs: 3000,
              },
            },
          },
        ],
      }),
      { ...OPTS, testIdAttribute: "data-answer-key" },
    );
    const src = result.source;
    expect(result.coverage.fixme).toBe(false);
    expect(src).toContain(
      `const cairnTable = await cairnReadTable(page, { "by": "role", "role": "table", "name": "Orders" }, { timeoutMs: 3000, includeHidden: false, testIdAttribute: "data-answer-key" });`,
    );
    expect(src).toContain(
      `expect(cairnJudgeTable(cairnTable, { "rows": { "equals": 2 }, "contains": [{ "Customer": "Acme" }] }), "table checks").toEqual([]);`,
    );
    expect(src).toContain("async function cairnReadTable(");
    expect(src).toContain("function cairnJudgeTable(");
    // A table-only unit has no use for the capture helpers (noUnusedLocals).
    expect(src).not.toContain("function cairnCapture(");
    expect(src).not.toContain("function cairnSingleTarget(");
  });
});

describe("poll:", () => {
  it("exports a verifier poll as expect(...).toPass with the same timeoutMs / everyMs", () => {
    const result = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "eventually",
            description: "the banner shows up",
            verify: {
              text: { contains: "ready" },
              poll: { timeoutMs: 20_000, everyMs: 500 },
            },
          },
        ],
      }),
      { ...OPTS },
    );
    expect(result.source).toContain("await expect(async () => {");
    expect(result.source).toContain(
      "}).toPass({ timeout: 20000, intervals: [500] });",
    );
    expect(
      result.coverage.diagnosticSkips.map((skip) => skip.id),
    ).not.toContain("eventually");
    expect(result.source).not.toContain("cairnPoll");
  });

  it("emulates stableMs with cairnPoll and reports the approximation", () => {
    const result = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "stays_done",
            description: "the banner stays",
            verify: {
              text: { contains: "done" },
              poll: { timeoutMs: 10_000, stableMs: 2_000 },
            },
          },
        ],
      }),
      { ...OPTS },
    );
    expect(result.source).toContain(
      "}, { timeoutMs: 10000, everyMs: 1000, stableMs: 2000 });",
    );
    expect(result.source).toContain("async function cairnPoll(");
    // Each sample checks once: a web-first assertion would retry a red
    // sample until it turns green and report a flapping state as stable.
    const body = result.source.slice(
      result.source.indexOf("await cairnPoll(async () => {"),
    );
    const sample = body.slice(0, body.indexOf("}, { timeoutMs: 10000"));
    expect(sample).toContain(
      "const cairnSampleExpect = expect.configure({ timeout: 1 });",
    );
    expect(sample).toContain(
      'await cairnSampleExpect(page.locator("body")).toContainText("done"',
    );
    expect(sample).not.toMatch(/^\s*await expect\(/m);
    expect(result.source).toMatch(/^import \{[^}]*\bexpect\b/m);
    expect(
      result.coverage.semanticRisks.find(
        (risk) => risk.kind === "pollApproximated",
      )?.detail,
    ).toMatch(/stableMs 2000ms.*each sample checks once/);
  });
});

describe("--verifiers", () => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-verifiers-mode-"));
  writeFileSync(
    join(dir, "check.mjs"),
    `export async function verify() { return { ok: true }; }\n`,
  );
  const infraSpec = spec({
    outcomes: [
      {
        id: "page_ok",
        description: "the page says hello",
        verify: { text: { contains: "hello" } },
      },
      {
        id: "node_check",
        description: "a node verifier",
        verify: {
          script: {
            runtime: "node",
            file: "./check.mjs",
            fixtures: {
              uri: "${secrets.MONGO_URI}",
              other: "${env.DEBUG_LEVEL:-info}",
            },
          },
        },
      },
      {
        id: "db_check",
        description: "a mongo verifier",
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
  const base = {
    sourcePath: join(dir, "spec.yml"),
    outPath: join(dir, "out", "a.spec.ts"),
  };

  it("keep (default): node file verifiers run, datasource verifiers hard-skip", () => {
    const result = exportPlaywright(infraSpec, { ...base });
    expect(result.coverage.fixme).toBe(true);
    expect(result.source).not.toContain("cairnSkipped");
    expect(result.source).not.toContain("test.skip(");
    expect(result.source).toContain("await verify({");
  });

  it("gate: a node verifier runs only when its env is present; an unrunnable one is recorded skipped", () => {
    const result = exportPlaywright(infraSpec, {
      ...base,
      verifiers: "gate",
      gateEnv: ["MONGO_URI", "TEMPORAL_API_BASE"],
      datasourceEnv: { main: ["MONGO_URI"] },
    });
    const src = result.source;
    expect(result.coverage.fixme).toBe(false);
    expect(src).toContain("const cairnSkipped: string[] = [];");
    // fixtures env (MONGO_URI) + --gate-env, sorted and unique; the `:-default` one is optional.
    expect(src).toContain(
      `const cairnMissing = ["MONGO_URI","TEMPORAL_API_BASE"].filter((name) => !process.env[name]);`,
    );
    expect(src).toContain(
      `cairnSkipped.push("node_check" + ": needs " + cairnMissing.join(", "));`,
    );
    expect(src).toContain("await verify({");
    // The datasource verifier can never run in an export: always recorded.
    expect(src).toContain(
      `cairnSkipped.push("db_check: it queries config datasource \\"main\\", which only cairn run can open (needs MONGO_URI, TEMPORAL_API_BASE)");`,
    );
    // The closing skip comes after every assertion (and any teardown).
    expect(src).toContain(
      `test.skip(cairnSkipped.length > 0, "verifier(s) not run: " + cairnSkipped.join("; "));`,
    );
    expect(src.lastIndexOf("test.skip(")).toBeGreaterThan(
      src.indexOf("await expect(page"),
    );
    const kinds = result.coverage.semanticRisks.map((risk) => risk.kind);
    expect(kinds).toContain("verifierGated");
    // Reported skipped at run time, never a coverage hole that fixmes the test.
    expect(result.coverage.skips.filter((skip) => !skip.soft)).toEqual([]);
  });

  it("gate without any known env runs the verifier unconditionally and says so", () => {
    const noEnv = spec({
      outcomes: [
        {
          id: "node_check",
          description: "a node verifier",
          verify: { script: { runtime: "node", file: "./check.mjs" } },
        },
      ],
    });
    const result = exportPlaywright(noEnv, { ...base, verifiers: "gate" });
    expect(result.source).not.toContain("cairnMissing");
    expect(result.source).toContain("await verify({");
    expect(
      result.coverage.diagnosticSkips.map((skip) => skip.reason).join("\n"),
    ).toContain("--gate-env");
  });

  it("drop: the verifiers are omitted with a diagnostic and a risk", () => {
    const result = exportPlaywright(infraSpec, { ...base, verifiers: "drop" });
    expect(result.source).not.toContain("await verify({");
    expect(result.coverage.fixme).toBe(false);
    expect(
      result.coverage.semanticRisks.filter(
        (risk) => risk.kind === "verifierDropped",
      ),
    ).toHaveLength(2);
    expect(result.coverage.outcomesExported).toBe(1);
  });

  it("drop removes the 30-minute floor: only an exported node verifier gets it", () => {
    const kept = exportPlaywright(infraSpec, { ...base });
    const dropped = exportPlaywright(infraSpec, { ...base, verifiers: "drop" });
    expect(kept.source).toContain("30m floor for durable node verifiers");
    expect(kept.source).toContain("test.setTimeout(1800000);");
    expect(dropped.source).not.toContain("30m floor");
    expect(dropped.source).toContain("test.setTimeout(90000);");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("${env.X:-default} is read when the test runs", () => {
  it("emits process.env.X || default (an empty value falls back, like cairn run)", () => {
    const result = exportPlaywright(
      spec({
        steps: [
          {
            open: `https://example.com/?r=${envDefaultSentinel("EXPORT_REGION", "eu")}`,
          },
        ],
      }),
      { ...OPTS },
    );
    expect(result.source).toContain(
      '`https://example.com/?r=${(process.env.EXPORT_REGION || "eu")}`',
    );
    expect(result.optionalEnv).toEqual(["EXPORT_REGION"]);
    expect(result.requiredEnv).toEqual([]);
    expect(result.source).toContain(
      "Optional env (a default applies when unset): EXPORT_REGION",
    );
  });

  it("keeps cairn's `:-` semantics for unset, empty and set values", async () => {
    // The same placeholder resolved by the spec parser (what `cairn run` does)
    // and by the emitted expression must agree for every shape of the value.
    const dir = mkdtempSync(join(tmpdir(), "cairn-env-default-"));
    try {
      const file = join(dir, "s.yml");
      writeFileSync(
        file,
        `version: 1
name: env_default
intent: parity of the :- default
outcomes:
  - id: o
    description: d
    verify: { text: { contains: x } }
steps:
  - open: "https://example.com/?r=\${env.EXPORT_PARITY:-fallback-\${run.token}}"
`,
      );
      const name = "EXPORT_PARITY";
      const exported = await parseSpec(file, {
        env: {},
        secretRef: (n) => `__CAIRN_SECRET_REF__${n}__`,
        envDefaultRef: envDefaultSentinel,
        lateEnv: true,
        runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
      });
      const result = exportPlaywright(exported.resolved, { ...OPTS });
      const match = /await page\.goto\((.*)\);/.exec(result.source);
      expect(match).not.toBeNull();
      for (const value of [undefined, "", "set-value"]) {
        const env: Record<string, string> =
          value === undefined ? {} : { [name]: value };
        const cairn = await parseSpec(file, {
          env,
          runtime: { runToken: "TOK" },
        });
        const expected = (cairn.resolved.steps![0] as { open: string }).open;
        const evaluate = new Function(
          "process",
          "RUN_TOKEN",
          `return ${match![1]};`,
        ) as (p: unknown, t: string) => string;
        expect(evaluate({ env }, "TOK")).toBe(expected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never bakes an env value that is set while exporting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-env-baked-"));
    const name = ["CAIRN", "EXPORT", "BAKED", "PROBE"].join("_");
    const value = `v-${Math.random().toString(36).slice(2)}`;
    const previous = process.env[name];
    process.env[name] = value;
    try {
      const file = join(dir, "s.yml");
      writeFileSync(
        file,
        `version: 1
name: env_baked
intent: no baked env
outcomes:
  - id: o
    description: d
    verify: { text: { contains: x } }
steps:
  - open: "https://example.com/?a=\${env.${name}}&b=\${env.${name}:-dflt}"
`,
      );
      const parsed = await parseSpec(file, {
        secretRef: (n) => `__CAIRN_SECRET_REF__${n}__`,
        envDefaultRef: envDefaultSentinel,
        lateEnv: true,
        runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
      });
      const result = exportPlaywright(parsed.resolved, {
        ...OPTS,
        lateBoundEnv: true,
      });
      expect(result.source).not.toContain(value);
      expect(result.source).toContain(`process.env.${name} ?? ""`);
      expect(result.source).toContain(`(process.env.${name} || "dflt")`);
      expect(
        result.coverage.semanticRisks.some((risk) => risk.kind === "envBaked"),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
