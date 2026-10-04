/**
 * E8 on `--into`: what a host profile changes in the generated tree — the test
 * layout and names, `test.setTimeout`, test id locators, how a module finds its
 * own directory, identifier spelling — without touching test logic.
 */
import { describe, expect, it } from "vitest";
import type { ParseResult } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import type { HostEmit } from "./hostProfile";
import { exportPlaywrightProject } from "./playwrightProject";
import { envDefaultSentinel } from "./templateValue";
import {
  renderFixturesRuntime,
  renderProjectRootRuntime,
} from "./playwrightRuntime";

const ROOT = "/proj";
const OUT = "/proj/exports";

const HOST: HostEmit = {
  moduleSystem: "cjs",
  moduleReason: "test",
  importExt: "",
  tsExtensions: false,
  testTimeoutMs: 120_000,
  testIdAttribute: "data-testid",
  testsDir: "",
  testSuffix: ".spec",
  bypassCsp: true,
  bypassCspDynamic: false,
  lintDisableVendored: false,
  notes: [],
};

function spec(raw: Record<string, unknown>): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "host_spec",
    intent: "a spec exported into a host tree",
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

function parsed(authored: Spec, path = `${ROOT}/flows/a.yml`): ParseResult {
  return {
    spec: authored,
    resolved: authored,
    path,
    contractHash: "sha256:x",
    contractHashValid: true,
    origins: [],
    actionsByName: new Map(),
  } as unknown as ParseResult;
}

function exportInto(
  authored: Spec,
  host: Partial<HostEmit> | undefined,
  extra: Record<string, unknown> = {},
) {
  return exportPlaywrightProject([parsed(authored)], {
    into: true,
    projectRoot: ROOT,
    sourceRoot: `${ROOT}/flows`,
    outDir: OUT,
    ...(host ? { host: { ...HOST, ...host } } : {}),
    ...extra,
  });
}

const file = (
  result: ReturnType<typeof exportInto>,
  relPath: string,
): string | undefined =>
  result.files.find((f) => f.relPath === relPath)?.source;

const SMALL = spec({
  steps: [{ id: "open_home", open: "/" }],
});

describe("test layout and naming", () => {
  it("writes tests flat under --into with the host's suffix", () => {
    const result = exportInto(SMALL, { testsDir: "", testSuffix: ".e2e" });
    expect(result.specs[0]!.file).toBe("host_spec.e2e.ts");
    expect(file(result, "host_spec.e2e.ts")).toBeDefined();
  });

  it("keeps folders of the source tree and the testDir prefix the profile gives", () => {
    const result = exportPlaywrightProject(
      [parsed(SMALL, `${ROOT}/flows/resilience/a.yml`)],
      {
        into: true,
        projectRoot: ROOT,
        sourceRoot: `${ROOT}/flows`,
        outDir: OUT,
        host: { ...HOST, testsDir: "specs", testSuffix: ".test" },
      },
    );
    expect(result.specs[0]!.file).toBe("specs/resilience/host_spec.test.ts");
  });

  it("is `tests/<name>.spec.ts` without a host profile", () => {
    expect(exportInto(SMALL, undefined).specs[0]!.file).toBe(
      "tests/host_spec.spec.ts",
    );
  });

  it("imports the runtime relative to the test's own depth", () => {
    const gated = spec({
      steps: [
        {
          id: "grab",
          capture: { assign: "total", table: { by: "role", role: "table" } },
        },
      ],
    });
    const flat = exportInto(gated, { testsDir: "" });
    const nested = exportInto(gated, { testsDir: "specs" });
    expect(file(flat, "host_spec.spec.ts")).toContain(`from "./lib/probe"`);
    expect(file(nested, "specs/host_spec.spec.ts")).toContain(
      `from "../lib/probe"`,
    );
  });
});

describe("test.setTimeout against the host's timeout", () => {
  it("omits it when the host's timeout covers the derived budget", () => {
    const source = file(
      exportInto(SMALL, { testTimeoutMs: 600_000 }),
      "host_spec.spec.ts",
    )!;
    expect(source).not.toContain("test.setTimeout");
    expect(source).toContain("The host's test timeout (600000ms) covers");
  });

  it("raises it for this spec only when the budget is higher", () => {
    const source = file(
      exportInto(SMALL, { testTimeoutMs: 30_000 }),
      "host_spec.spec.ts",
    )!;
    expect(source).toMatch(/test\.setTimeout\(\d+\);/);
    expect(source).toContain("Above the host's test timeout (30000ms)");
  });

  it("sets the spec's own budget when the host's timeout is not statically readable (never a guessed default)", () => {
    const { testTimeoutMs: _unread, ...unread } = HOST;
    const source = file(
      exportPlaywrightProject([parsed(SMALL)], {
        into: true,
        projectRoot: ROOT,
        sourceRoot: `${ROOT}/flows`,
        outDir: OUT,
        host: unread,
      }),
      "host_spec.spec.ts",
    )!;
    expect(source).toMatch(/test\.setTimeout\(\d+\);/);
    expect(source).not.toContain("raised for this spec");
    expect(source).not.toContain("covers the derived budget");
  });

  it("always sets it without a host profile (unchanged)", () => {
    const source = file(
      exportInto(SMALL, undefined),
      "tests/host_spec.spec.ts",
    )!;
    expect(source).toMatch(/test\.setTimeout\(\d+\);/);
    expect(source).not.toContain("host's test timeout");
  });

  it("applies the same rule to a precondition hook's own budget", () => {
    const withHook = spec({
      preconditions: {
        commands: [{ run: "bun run reset", timeoutMs: 45_000 }],
      },
      steps: [{ id: "open_home", open: "/" }],
    });
    const covered = file(
      exportInto(withHook, { testTimeoutMs: 900_000 }),
      "host_spec.spec.ts",
    )!;
    expect(covered).not.toContain("test.setTimeout");
    const tight = file(
      exportInto(withHook, { testTimeoutMs: 30_000 }),
      "host_spec.spec.ts",
    )!;
    expect(tight.match(/test\.setTimeout\(/g)?.length).toBe(2);
  });
});

describe("test id locators", () => {
  const click = spec({
    steps: [{ id: "pick", click: { by: "testid", testid: "save-button" } }],
  });

  it("uses getByTestId when the host reads the attribute the spec means", () => {
    const source = file(
      exportInto(click, { testIdAttribute: "data-testid" }),
      "host_spec.spec.ts",
    )!;
    expect(source).toContain(`page.getByTestId("save-button")`);
  });

  it("uses getByTestId when both name the same custom attribute", () => {
    const source = file(
      exportInto(
        click,
        { testIdAttribute: "data-qa-key" },
        {
          testIdAttribute: "data-qa-key",
        },
      ),
      "host_spec.spec.ts",
    )!;
    expect(source).toContain(`page.getByTestId("save-button")`);
  });

  it("emits an explicit attribute selector when the host reads a different one", () => {
    const source = file(
      exportInto(click, { testIdAttribute: "data-qa-key" }),
      "host_spec.spec.ts",
    )!;
    expect(source).not.toContain("getByTestId");
    expect(source).toContain(
      `page.locator("[data-testid=\\"save-button\\"]").first()`,
    );
  });

  it("emits explicit attribute selectors when the host's attribute is not statically readable", () => {
    const { testIdAttribute: _unread, ...unread } = HOST;
    const source = file(
      exportPlaywrightProject([parsed(click)], {
        into: true,
        projectRoot: ROOT,
        sourceRoot: `${ROOT}/flows`,
        outDir: OUT,
        host: unread,
      }),
      "host_spec.spec.ts",
    )!;
    expect(source).not.toContain("getByTestId");
    expect(source).toContain(`[data-testid=\\"save-button\\"]`);
  });

  it("CSS-escapes a test id that is only known at run time (L2)", () => {
    // `row-${env.ROW_ID:-1}` as the parser hands it over (late-bound)
    const templated = spec({
      steps: [
        {
          id: "pick",
          click: {
            by: "testid",
            testid: `row-${envDefaultSentinel("ROW_ID", "1")}`,
          },
        },
      ],
    });
    const source = file(
      exportInto(templated, { testIdAttribute: "data-qa-key" }),
      "host_spec.spec.ts",
    )!;
    const expr = /page\.locator\((`\[data-testid=[^`]*`)\)/.exec(source)?.[1];
    expect(expr).toBeDefined();
    // the run-time value cannot close the attribute string or the selector
    const run = new Function("process", `return ${expr};`) as (p: {
      env: Record<string, string>;
    }) => string;
    const selector = (row: string) => run({ env: { ROW_ID: row } });
    expect(selector('a"] , [x="y')).toBe('[data-testid="row-a\\"] , [x=\\"y"]');
    expect(selector("b\\c")).toBe('[data-testid="row-b\\\\c"]');
    expect(run({ env: {} })).toBe('[data-testid="row-1"]');
  });

  it("keeps the spec's own configured attribute in the explicit selector", () => {
    const source = file(
      exportInto(
        click,
        { testIdAttribute: "data-test" },
        {
          testIdAttribute: "data-qa",
        },
      ),
      "host_spec.spec.ts",
    )!;
    expect(source).toContain(`[data-qa=\\"save-button\\"]`);
  });
});

describe("module system", () => {
  const withProjectRoot = spec({
    preconditions: { commands: [{ run: "bun run reset" }] },
    steps: [{ id: "open_home", open: "/" }],
  });

  it("reads __dirname in a CommonJS host (no import.meta anywhere)", () => {
    const result = exportInto(withProjectRoot, { moduleSystem: "cjs" });
    const root = file(result, "lib/projectRoot.ts")!;
    expect(root).toContain(`resolve(__dirname, "..", `);
    expect(root).not.toContain("import.meta");
    expect(root).not.toContain("fileURLToPath");
    for (const generated of result.files) {
      expect(generated.source).not.toContain("import.meta");
    }
  });

  it("keeps import.meta.url in an ES module host", () => {
    const root = file(
      exportInto(withProjectRoot, { moduleSystem: "esm" }),
      "lib/projectRoot.ts",
    )!;
    expect(root).toContain("fileURLToPath(new URL(");
    expect(root).toContain("import.meta.url");
  });

  it("renders the fixtures and project-root helpers for both systems", () => {
    expect(renderFixturesRuntime("ts", "cjs")).toContain(
      `resolve(__dirname, "..", "fixtures", encodeURIComponent(name))`,
    );
    expect(renderFixturesRuntime("ts")).toContain("import.meta.url");
    expect(renderProjectRootRuntime("ts", undefined, "cjs")).toContain(
      "process.cwd()",
    );
    expect(renderProjectRootRuntime("js", "../src", "cjs")).toContain(
      `resolve(__dirname, "..", "../src")`,
    );
  });
});

describe("identifiers", () => {
  const named = spec({
    steps: [
      {
        id: "probe",
        eval: { js: "return { id: 7 };", assign: "login_state" },
      },
      {
        id: "login",
        request: { method: "POST", url: "/api/login", assign: "api_login" },
      },
      {
        id: "open_order",
        open: "/orders/${evals.login_state.value.id}?t=${requests.api_login.body.token}",
      },
    ],
  });

  it("spells derived bindings camelCase under a host profile", () => {
    const source = file(exportInto(named, {}), "host_spec.spec.ts")!;
    expect(source).toContain("cairnEvalsLoginState");
    expect(source).toContain("cairnRequestsApiLogin");
    expect(source).not.toMatch(/cairn(?:Evals|Requests)_/);
  });

  it("keeps the underscore spelling without a host profile (unchanged)", () => {
    const source = file(
      exportInto(named, undefined),
      "tests/host_spec.spec.ts",
    )!;
    expect(source).toContain("cairnEvals_login_state");
    expect(source).toContain("cairnRequests_api_login");
  });

  it("keeps names that collapse to the same identifier distinct", () => {
    const colliding = spec({
      steps: [
        { id: "one", eval: { js: "return { v: 1 };", assign: "a_b" } },
        { id: "two", eval: { js: "return { v: 2 };", assign: "aB" } },
        {
          id: "open_it",
          open: "/x?a=${evals.a_b.value.v}&b=${evals.aB.value.v}",
        },
      ],
    });
    const source = file(exportInto(colliding, {}), "host_spec.spec.ts")!;
    expect(source).toContain("let cairnEvalsAB: unknown;");
    expect(source).toContain("let cairnEvalsAB2: unknown;");
    // Each splice reads its own binding.
    expect(source).toMatch(/cairnSplice\(cairnEvalsAB, \["value","v"\]\)/);
    expect(source).toMatch(/cairnSplice\(cairnEvalsAB2, \["value","v"\]\)/);
  });

  it("emits braces on every control-flow statement of a test", () => {
    const source = file(
      exportInto(spec({ steps: [{ id: "open_home", open: "/" }] }), {}),
      "host_spec.spec.ts",
    )!;
    expect(source).not.toMatch(/if \(.*\) [^{\s].*;$/m);
  });
});
