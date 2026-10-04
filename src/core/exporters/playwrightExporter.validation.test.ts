/**
 * Semantic validation of exporter output — properties stronger than
 * "it parses":
 *
 *  1. TYPE-CHECK: every golden type-checks against the REAL @playwright/test
 *     types (devDependency) under `strict` + `noUnusedLocals`, so an emitted
 *     call that drifts from Playwright's API — or an unused import/binding —
 *     fails here, not in the user's CI. Environment-dependent dynamic
 *     imports (absolute verifier paths that only exist on the exporting
 *     machine) are the one filtered diagnostic.
 *
 *  2. PROJECT TYPE-CHECK: a whole `--project` export (actions with late-bound
 *     vars, lib/, tests) compiles with the generated tsconfig options plus
 *     `noUnusedLocals`.
 *
 *  3. ROUND-TRIP: `cairn import playwright` over exported output maps the
 *     core actions back to Cairntrace steps. The importer is best-effort, so
 *     this asserts a floor (basic steps survive), not isomorphism.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { importPlaywright } from "../importers/playwrightImporter";
import type { LoadedAction, ParseResult } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";

const HERE = dirname(new URL(import.meta.url).pathname);
const GOLDEN_DIR = join(HERE, "goldens");
// Inside the repo so `import "@playwright/test"` resolves via node_modules.
const TMP_DIR = join(GOLDEN_DIR, ".typecheck-tmp");

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

/** The generated project's tsconfig options, tightened with noUnusedLocals. */
const STRICT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: ["node"],
  strict: true,
  noUnusedLocals: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  skipLibCheck: true,
};

function diagnosticsFor(files: string[], ownFiles: Set<string>): string[] {
  const program = ts.createProgram(files, STRICT_OPTIONS);
  return (
    ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && ownFiles.has(d.file.fileName))
      // Dynamic imports of verifier PATHS (absolute or relative) point at
      // files that only exist in the exporting project, not this repo —
      // every unresolved BARE module (e.g. @playwright/test) is a bug.
      .filter(
        (d) =>
          !(
            d.code === 2307 &&
            /['"][./]/.test(ts.flattenDiagnosticMessageText(d.messageText, " "))
          ),
      )
      .map(
        (d) =>
          `${
            d.file ? `${d.file.fileName.slice(TMP_DIR.length + 1)}: ` : ""
          }TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      )
  );
}

describe("exporter output type-checks against @playwright/test (strict + noUnusedLocals)", () => {
  const goldens = readdirSync(GOLDEN_DIR).filter((f) =>
    f.endsWith(".golden.ts.txt"),
  );
  expect(goldens.length).toBeGreaterThan(0);

  for (const golden of goldens) {
    it(golden, () => {
      const source = readFileSync(join(GOLDEN_DIR, golden), "utf8");
      mkdirSync(TMP_DIR, { recursive: true });
      const file = join(TMP_DIR, golden.replace(".golden.ts.txt", ".spec.ts"));
      writeFileSync(file, source);
      expect(
        diagnosticsFor([file], new Set([file.replaceAll("\\", "/")])),
      ).toEqual([]);
    });
  }
});

describe("a --project export type-checks as a whole", () => {
  it("compiles actions with late-bound vars, splice bindings, lib/, and tests", () => {
    const projectDir = join(TMP_DIR, "project");
    const action = {
      version: 1 as const,
      name: "open_record",
      steps: [
        { id: "go", open: "/records" },
        {
          id: "wait_named",
          wait: {
            text: "Record __CAIRN_VAR_REF__recordName__",
            timeoutMs: 5000,
          },
        },
        {
          id: "maybe_banner",
          when: "text:Hello __CAIRN_VAR_REF__recordName__",
          click: { by: "role", role: "button", name: "Dismiss" },
        },
        {
          id: "fill_name",
          fill: {
            by: "label",
            name: "Name",
            value: "__CAIRN_VAR_REF__recordName__-__CAIRN_RUN_TOKEN__",
          },
        },
        {
          id: "probe",
          eval: {
            js: "return { name: '__CAIRN_VAR_REF__recordName__' };",
            assign: "probe",
          },
        },
        {
          id: "session",
          request: { url: "/api/session", assign: "session" },
        },
      ],
    } as unknown as LoadedAction["action"];
    const authored = SpecSchema.parse({
      version: 1,
      name: "typed_project",
      intent: "a full project export compiles strictly",
      imports: ["../actions/open_record.yml"],
      steps: [
        { id: "open", use: "open_record" },
        {
          id: "echo",
          fill: {
            by: "label",
            name: "Echo",
            value: "${evals.probe.value.name}/${requests.session.status}",
          },
        },
      ],
      outcomes: [
        {
          id: "shown",
          description: "record shown",
          verify: { text: { contains: "Record" } },
        },
      ],
    }) as Spec;
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: join(projectDir, "src-flows", "typed_project.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map([
        [
          "open_record",
          {
            path: join(projectDir, "src-actions", "open_record.yml"),
            rawSource: "",
            actionDefaults: { recordName: "alpha" },
            action,
          },
        ],
      ]),
    };
    const result = exportPlaywrightProject([parsed]);
    const written = new Set<string>();
    for (const file of result.files) {
      const abs = join(projectDir, file.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.source);
      if (abs.endsWith(".ts")) written.add(abs.replaceAll("\\", "/"));
    }
    const testFile = join(projectDir, "tests", "typed_project.spec.ts");
    const actionSource = readFileSync(
      join(projectDir, "actions", "open_record.ts"),
      "utf8",
    );
    expect(actionSource).not.toMatch(/__CAIRN_[A-Z_]+__/i);
    expect(actionSource).toContain("Promise<CairnActionBindings>");
    expect(readFileSync(testFile, "utf8")).toContain(
      "const cairnAction1 = await open_record(page, {}, RUN_TOKEN);",
    );
    expect(diagnosticsFor([...written], written)).toEqual([]);
  });
});

describe("review regressions type-check (strict + noUnusedLocals)", () => {
  it("a request assign named `requests` next to network evidence compiles", () => {
    const authored = SpecSchema.parse({
      version: 1,
      name: "assign_named_requests",
      intent: "assign names never shadow generated identifiers",
      steps: [
        {
          id: "login",
          request: { method: "POST", url: "/api/login", assign: "requests" },
        },
        {
          id: "fill_name",
          fill: {
            by: "label",
            name: "Name",
            value: "${requests.requests.body.name}",
          },
        },
      ],
      outcomes: [
        {
          id: "login_ok",
          description: "the login api answered as we expect.",
          verify: {
            network: { urlContains: "/api/login", status: { equals: 200 } },
          },
        },
      ],
    }) as Spec;
    const dir = join(TMP_DIR, "regressions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "assign_named_requests.spec.ts");
    writeFileSync(file, exportPlaywright(authored).source);
    expect(diagnosticsFor([file], new Set([file]))).toEqual([]);
  });

  it("an outcome described 'as we expect.' with no assertion compiles", () => {
    const authored = SpecSchema.parse({
      version: 1,
      name: "comment_mentions_expect",
      intent: "comments never drive imports",
      steps: [{ id: "go", open: "/" }],
      outcomes: [
        {
          id: "report",
          description: "the file looks as we expect.",
          verify: { file: { glob: "reports/*.csv", contains: "ok" } },
        },
      ],
    }) as Spec;
    const dir = join(TMP_DIR, "regressions");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "comment_mentions_expect.spec.ts");
    writeFileSync(file, exportPlaywright(authored).source);
    expect(diagnosticsFor([file], new Set([file]))).toEqual([]);
  });

  it("a caller of an action that consumes its own capture declares no unused binding", () => {
    const projectDir = join(TMP_DIR, "own-capture");
    const action = {
      version: 1 as const,
      name: "csrf_login",
      steps: [
        { id: "csrf", request: { url: "/api/csrf", assign: "csrf" } },
        {
          id: "token",
          fill: {
            by: "label",
            name: "Token",
            value: "${requests.csrf.body.token}",
          },
        },
      ],
    } as unknown as LoadedAction["action"];
    const authored = SpecSchema.parse({
      version: 1,
      name: "uses_csrf_login",
      intent: "the caller only calls the action",
      imports: ["../actions/csrf_login.yml"],
      steps: [{ id: "login", use: "csrf_login" }],
      outcomes: [
        {
          id: "in",
          description: "signed in",
          verify: { text: { contains: "Welcome" } },
        },
      ],
    }) as Spec;
    // `resolved` carries the expanded action steps, as parseSpec produces.
    const resolved = {
      ...authored,
      steps: action.steps,
    } as unknown as Spec;
    const parsed: ParseResult = {
      spec: authored,
      resolved,
      path: join(projectDir, "src-flows", "uses_csrf_login.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map([
        [
          "csrf_login",
          {
            path: join(projectDir, "src-actions", "csrf_login.yml"),
            rawSource: "",
            actionDefaults: {},
            action,
          },
        ],
      ]),
    };
    const result = exportPlaywrightProject([parsed]);
    const written = new Set<string>();
    for (const file of result.files) {
      const abs = join(projectDir, file.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.source);
      if (abs.endsWith(".ts")) written.add(abs.replaceAll("\\", "/"));
    }
    const testSource = readFileSync(
      join(projectDir, "tests", "uses_csrf_login.spec.ts"),
      "utf8",
    );
    expect(testSource).not.toContain("cairnRequests_csrf");
    expect(testSource).toContain("await csrf_login(page);");
    expect(diagnosticsFor([...written], written)).toEqual([]);
  });
});

describe("export → import round-trip floor", () => {
  it("core actions survive the round trip", () => {
    const s = SpecSchema.parse({
      version: 1,
      name: "roundtrip_basics",
      intent: "basic actions must survive export → import",
      steps: [
        { id: "go", open: "https://example.com/app" },
        {
          id: "click_btn",
          click: { by: "role", role: "button", name: "Save" },
        },
        {
          id: "fill_name",
          fill: { by: "selector", selector: "#name", value: "Ada" },
        },
      ],
      outcomes: [
        {
          id: "saved",
          description: "confirmation shows",
          verify: { text: { contains: "Saved" } },
        },
      ],
    });
    const exported = exportPlaywright(s).source;
    const imported = importPlaywright(exported);

    const kinds = imported.spec.steps?.map((st) => {
      if ("open" in st) return "open";
      if ("click" in st) return "click";
      if ("fill" in st) return "fill";
      return "other";
    });
    expect(kinds).toContain("open");
    expect(kinds).toContain("click");
    expect(kinds).toContain("fill");
    // The text outcome must survive as a contains matcher.
    const outcomeJson = JSON.stringify(imported.spec.outcomes ?? []);
    expect(outcomeJson).toContain("Saved");
  });
});

describe("--verifiers modes type-check a standalone file with a node verifier", () => {
  const dir = join(TMP_DIR, "verifier-modes");
  for (const mode of ["keep", "gate", "drop"] as const) {
    it(mode, () => {
      mkdirSync(join(dir, "verifiers"), { recursive: true });
      writeFileSync(
        join(dir, "verifiers", "check.ts"),
        "export async function verify(): Promise<{ ok: boolean }> { return { ok: true }; }\n",
      );
      const authored = SpecSchema.parse({
        version: 1,
        name: `verifier_${mode}`,
        intent: "a node verifier with a binding it reads",
        steps: [
          {
            id: "create",
            request: { method: "POST", url: "/api/x", assign: "created" },
          },
        ],
        outcomes: [
          {
            id: "node",
            description: "the node verifier passes",
            verify: {
              script: {
                runtime: "node",
                file: "./verifiers/check.ts",
                fixtures: {
                  id: "${requests.created.body.id}",
                  uri: "__CAIRN_SECRET_REF__MONGO_URI__",
                },
              },
            },
          },
        ],
      }) as Spec;
      const file = join(dir, `verifier_${mode}.spec.ts`);
      writeFileSync(
        file,
        exportPlaywright(authored, {
          sourcePath: join(dir, "spec.yml"),
          outPath: file,
          verifiers: mode,
        }).source,
      );
      expect(
        diagnosticsFor([file], new Set([file.replaceAll("\\", "/")])),
      ).toEqual([]);
    });
  }
});

describe("export v2 projects type-check (strict + noUnusedLocals)", () => {
  const authored = SpecSchema.parse({
    version: 1,
    name: "v2_project",
    intent: "host commands, capture, poll, fixtures and gates compile strictly",
    preconditions: {
      wait: ["app_ready"],
      env: { TOKEN: "__CAIRN_SECRET_REF__API_TOKEN__" },
      commands: [
        { name: "reset", run: "bun run reset" },
        { run: "psql -c 'select 1' | head -1" },
      ],
    },
    fixtures: [{ use: "thing", with: { sku: "S-__CAIRN_RUN_TOKEN__" } }],
    steps: [
      {
        id: "seed",
        run: {
          node: "../scripts/seed.mjs",
          args: ["create"],
          assign: "seeded",
        },
      },
      {
        id: "open",
        open: "/p?sku=${fixtures.thing.sku}&id=${runs.seeded.id}&r=__CAIRN_ENV_DEFAULT__52454749_6575__",
      },
      {
        id: "read",
        capture: { assign: "title", text: { by: "role", role: "heading" } },
      },
      { id: "again", open: "/q?t=${captures.title}" },
    ],
    outcomes: [
      {
        id: "stays",
        description: "stays done",
        verify: {
          text: { contains: "done" },
          poll: { timeoutMs: 5000, stableMs: 1000 },
        },
      },
      {
        id: "soon",
        description: "shows soon",
        verify: {
          text: { contains: "soon" },
          poll: { timeoutMs: 5000 },
        },
      },
      {
        id: "grid",
        description: "the table lists the rows",
        verify: {
          table: {
            locator: { by: "role", role: "table" },
            rows: { atLeast: 1, noBlank: true },
            headers: { includes: ["Name"] },
            contains: [{ Name: "Acme" }, "Globex"],
            timeoutMs: 2000,
          },
          poll: { timeoutMs: 3000 },
        },
      },
      {
        id: "db",
        description: "the row exists",
        verify: {
          mongo: {
            source: "main",
            collection: "c",
            filter: {},
            expect: { count: 1 },
          },
        },
      },
    ],
    teardown: {
      steps: [{ id: "clean", run: "node ../scripts/clean.mjs" }],
      failRun: true,
    },
  }) as Spec;

  for (const [label, options] of [
    ["inline + gate", { preconditions: "inline", verifiers: "gate" }],
    [
      "global + gate",
      {
        preconditions: "global",
        verifiers: "gate",
        configPath: "/proj/cairntrace.config.yml",
        envName: "local",
        fixtureScopes: { thing: "run" },
      },
    ],
    ["manifest + drop", { preconditions: "manifest", verifiers: "drop" }],
    ["skip", { preconditions: "skip" }],
    ["default", {}],
  ] as const) {
    it(label, () => {
      const projectDir = join(TMP_DIR, `v2-${label.replaceAll(/\W+/g, "-")}`);
      const parsed: ParseResult = {
        spec: authored,
        resolved: authored,
        path: "/proj/flows/v2_project.yml",
        contractHashValid: true,
        origins: [],
        actionsByName: new Map(),
      };
      const result = exportPlaywrightProject([parsed], {
        projectRoot: "/proj",
        outDir: projectDir,
        datasourceEnv: { main: ["MONGO_URI"] },
        lateBoundEnv: true,
        ...options,
      });
      const written = new Set<string>();
      for (const file of result.files) {
        const abs = join(projectDir, file.relPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, file.source);
        if (abs.endsWith(".ts")) written.add(abs.replaceAll("\\", "/"));
      }
      expect(result.files.map((file) => file.source).join("\n")).not.toMatch(
        /__CAIRN_[A-Z_]+__/i,
      );
      expect(diagnosticsFor([...written], written)).toEqual([]);
    });
  }
});

describe("an action with run and capture steps returns what a caller splices", () => {
  it("compiles, returns { runs, captures } and the caller binds them (inline)", () => {
    const projectDir = join(TMP_DIR, "action-run-capture");
    const action = {
      version: 1 as const,
      name: "provision",
      steps: [
        {
          id: "seed",
          run: { shell: "node seed.mjs create", assign: "seeded" },
        },
        {
          id: "read",
          capture: { assign: "title", text: { by: "role", role: "heading" } },
        },
      ],
    } as unknown as LoadedAction["action"];
    const authored = SpecSchema.parse({
      version: 1,
      name: "uses_provision",
      intent: "a caller splices an action's run output and capture",
      imports: ["../actions/provision.yml"],
      steps: [
        { id: "go", use: "provision" },
        { id: "next", open: "/x?id=${runs.seeded.id}&t=${captures.title}" },
      ],
      outcomes: [
        {
          id: "ok",
          description: "shown",
          verify: { text: { contains: "done" } },
        },
      ],
    }) as Spec;
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: join(projectDir, "src", "flows", "uses_provision.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map([
        [
          "provision",
          {
            path: join(projectDir, "src", "actions", "provision.yml"),
            rawSource: "",
            actionDefaults: {},
            action,
          },
        ],
      ]),
    };
    const result = exportPlaywrightProject([parsed], {
      projectRoot: join(projectDir, "src"),
      outDir: projectDir,
      preconditions: "inline",
    });
    const written = new Set<string>();
    for (const file of result.files) {
      const abs = join(projectDir, file.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.source);
      if (abs.endsWith(".ts")) written.add(abs.replaceAll("\\", "/"));
    }
    const actionSource = readFileSync(
      join(projectDir, "actions", "provision.ts"),
      "utf8",
    );
    expect(actionSource).toContain(
      'import { cairnCommand, cairnLastJson, cairnTestContext } from "../preconditions";',
    );
    expect(actionSource).toContain(
      'return { requests: {}, evals: {}, artifacts: {}, runs: { "seeded": cairnRuns_seeded }, captures: { "title": cairnCaptures_title } };',
    );
    expect(actionSource).toContain("Promise<CairnActionBindings>");
    const test = readFileSync(
      join(projectDir, "tests", "uses_provision.spec.ts"),
      "utf8",
    );
    expect(test).toContain('cairnRuns_seeded = cairnAction1.runs["seeded"];');
    expect(test).toContain(
      'cairnCaptures_title = cairnAction1.captures["title"];',
    );
    expect(diagnosticsFor([...written], written)).toEqual([]);
  });
});
