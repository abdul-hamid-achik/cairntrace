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
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
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
