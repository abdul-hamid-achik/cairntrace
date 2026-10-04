/**
 * F18 request v2 + environment login in the Playwright exporter: v2 request
 * steps become `cairnRequest` / `cairnRequestMatrix` calls, `use: login`
 * becomes `cairnLogin(page, CAIRN_AUTH)` with secrets as `process.env`
 * reads, and `--project` writes `lib/request` + `lib/auth`. The golden is
 * type-checked under strict + noUnusedLocals by
 * playwrightExporter.validation.test.ts. Regenerate with UPDATE_GOLDENS=1.
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
import { matchValue, readPath } from "../runner/verifiers/matchers";
import { EnvAuthSchema } from "../schema/request.v1";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import type { ValueMatcher } from "../schema/verifier.v1";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";
import {
  prepareExportAuth,
  renderRequestHelperLines,
  type ExportEnvAuth,
} from "./requestRuntime";
import { inlineRuntimeModule } from "./runtimeSources";

const HERE = dirname(new URL(import.meta.url).pathname);
const GOLDEN_DIR = join(HERE, "goldens");
const TMP_DIR = join(GOLDEN_DIR, ".typecheck-request-tmp");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const ENV_AUTH: ExportEnvAuth = {
  envName: "local",
  vars: { loginPath: "/api/login", mfa: "on" },
  configDir: HERE,
  auth: EnvAuthSchema.parse({
    alreadyAuthenticated: {
      method: "POST",
      url: "/api/check",
      json: { "$.user.email": "${secrets.E2E_EMAIL}" },
    },
    login: {
      url: "${vars.loginPath}",
      body: {
        email: "${secrets.E2E_EMAIL}",
        password: "${secrets.E2E_PASSWORD}",
      },
      expectStatus: 200,
    },
    after: [
      {
        id: "otp",
        when: { var: "requests.login.body.user.mfa", equals: "otp" },
        request: {
          method: "PUT",
          url: "/api/otp/${secrets.E2E_OTP}",
          headers: { authorization: "Bearer ${requests.login.body.token}" },
          expectStatus: 200,
        },
      },
      {
        id: "plain_var_gate",
        when: { var: "mfa", equals: "off" },
        request: { method: "POST", url: "/api/never" },
      },
    ],
    hydrate: { eval: "window.__session = args.login; return true;" },
  }),
};

function requestSpec(): Spec {
  return SpecSchema.parse({
    version: 1,
    name: "golden_request_v2",
    intent: "request v2 and the environment login export to Playwright",
    coldStart: "guest",
    outcomes: [
      {
        id: "tasks_ok",
        description: "no task call failed",
        verify: { noFailedRequests: { urlContains: "/api/tasks" } },
      },
    ],
    steps: [
      { use: "login" },
      {
        id: "wait_task",
        request: {
          url: "/api/tasks",
          until: {
            json: { "$.tasks[?(@.title == 'Report')]": { exists: true } },
            every: 100,
            timeoutMs: 10000,
          },
          capture: { taskId: "$.tasks[?(@.title == 'Report')].id" },
          assign: "tasks",
        },
      },
      {
        id: "open_task",
        request: {
          url: "/api/tasks/${requests.tasks.captures.taskId}",
          headers: { authorization: "Bearer ${requests.login.body.token}" },
          retry: { times: 2, on: ["5xx"], delayMs: 50 },
          expectStatus: 200,
        },
      },
      {
        id: "denied",
        request: {
          method: "${matrix.route.method}",
          url: "${matrix.route.path}",
          body: "${matrix.route.body}",
          headers: { authorization: "${matrix.auth}" },
          credentials: "omit",
          matrix: {
            route: [
              { method: "GET", path: "/api/admin/list" },
              { method: "POST", path: "/api/admin/create", body: { a: 1 } },
            ],
            auth: ["", "Bearer invalid-value"],
          },
          expectStatus: 401,
        },
      },
    ],
  });
}

function transpileDiagnostics(source: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  return (out.diagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

function checkGolden(name: string, source: string): void {
  expect(transpileDiagnostics(source)).toEqual([]);
  const goldenPath = join(GOLDEN_DIR, `${name}.golden.ts.txt`);
  if (UPDATE || !existsSync(goldenPath)) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, source);
    return;
  }
  expect(source).toBe(readFileSync(goldenPath, "utf8"));
}

describe("request v2 export", () => {
  it("renders cairnRequest / cairnRequestMatrix / cairnLogin (golden)", () => {
    const result = exportPlaywright(requestSpec(), { envAuth: ENV_AUTH });
    const source = result.source;
    expect(result.coverage.skips).toEqual([]);
    expect(source).toContain("await cairnLogin(page, CAIRN_AUTH);");
    expect(source).toContain("await cairnRequest(page, {");
    expect(source).toContain("await cairnRequestMatrix(page, {");
    // noFailedRequests is judged by cairnAssertNoFailedRequests: no expect left.
    expect(source).toContain(
      'import { request, test, type APIRequestContext, type Page } from "@playwright/test";',
    );
    expect(source).toContain(
      'await cairnAssertNoFailedRequests(requests, { "urlContains": "/api/tasks" });',
    );
    // Secrets are process.env reads; ${requests.login…} stays for the helper.
    expect(source).toContain('`${process.env.E2E_PASSWORD ?? ""}`');
    expect(source).toContain('"Bearer ${requests.login.body.token}"');
    expect(result.requiredEnv).toEqual([
      "E2E_EMAIL",
      "E2E_OTP",
      "E2E_PASSWORD",
    ]);
    // A plain-var `when` is decided at export time.
    expect(source).toContain('"when": { "holds": false }');
    // The captured bearer and capture splice bind the login / tasks envelopes.
    expect(source).toContain("cairnRequests_login = await cairnLogin(");
    expect(source).toContain(
      'cairnSplice(cairnRequests_tasks, ["captures","taskId"])',
    );
    checkGolden("request-v2", source);
  });

  it("keeps a v1 request on page.request.fetch with no helper", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "plain_request",
      intent: "a v1 request",
      outcomes: [
        { id: "ok", description: "ok", verify: { text: { contains: "x" } } },
      ],
      steps: [{ request: { url: "/api/x", expectStatus: 200 } }],
    });
    const source = exportPlaywright(spec).source;
    expect(source).toContain('page.request.fetch("/api/x"');
    expect(source).not.toContain("cairnRequest");
    expect(source).toContain(
      'import { expect, test } from "@playwright/test";',
    );
  });

  it("marks use: login test.fixme without an environment auth block", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "login_no_auth",
      intent: "login without auth config",
      outcomes: [
        { id: "ok", description: "ok", verify: { text: { contains: "x" } } },
      ],
      steps: [{ use: "login" }],
    });
    const result = exportPlaywright(spec);
    expect(result.source).toContain("test.fixme(");
    expect(result.coverage.skips[0]?.reason).toContain(
      "use: login not exportable",
    );
  });

  it("inlines the call's own vars instead of CAIRN_AUTH", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "login_vars",
      intent: "login with a use-site var",
      outcomes: [
        { id: "ok", description: "ok", verify: { text: { contains: "x" } } },
      ],
      steps: [
        { use: { action: "login", vars: { loginPath: "/api/v2/login" } } },
      ],
    });
    const source = exportPlaywright(spec, { envAuth: ENV_AUTH }).source;
    expect(source).toContain('await cairnLogin(page, { "login": {');
    expect(source).toContain('"url": "/api/v2/login"');
    expect(source).not.toContain("const CAIRN_AUTH");
  });

  it("writes lib/request + lib/auth for --project and the result type-checks strictly", () => {
    const projectDir = join(TMP_DIR, "project");
    rmSync(projectDir, { recursive: true, force: true });
    const spec = requestSpec();
    const parsed: ParseResult = {
      spec,
      resolved: spec,
      path: join(projectDir, "flows", "golden_request_v2.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const result = exportPlaywrightProject([parsed], { envAuth: ENV_AUTH });
    const lib = result.files.find((f) => f.relPath === "lib/request.ts");
    expect(lib!.source).toContain("export async function cairnLoginState(");
    const auth = result.files.find((f) => f.relPath === "lib/auth.ts");
    expect(auth!.source).toContain("export const CAIRN_AUTH: CairnAuth = {");
    expect(auth!.source).toContain("process.env.E2E_PASSWORD");
    const test = result.files.find((f) => f.relPath.endsWith(".spec.ts"));
    expect(test!.source).toContain(
      'import { cairnRequest, cairnRequestMatrix, cairnLogin } from "../lib/request";',
    );
    expect(test!.source).toContain('import { CAIRN_AUTH } from "../lib/auth";');
    expect(result.requiredEnv).toEqual(
      expect.arrayContaining(["E2E_EMAIL", "E2E_OTP", "E2E_PASSWORD"]),
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

  it("cairnLoginState writes the session owner-only (0600) and atomically, no temp file left (M10)", async () => {
    const projectDir = join(TMP_DIR, "login-state");
    rmSync(projectDir, { recursive: true, force: true });
    const spec = requestSpec();
    const parsed: ParseResult = {
      spec,
      resolved: spec,
      path: join(projectDir, "flows", "golden_request_v2.yml"),
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };
    const result = exportPlaywrightProject([parsed], { envAuth: ENV_AUTH });
    for (const file of result.files) {
      const abs = join(projectDir, file.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.source);
    }
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `sid=${process.pid}-${Date.now()}; Path=/; HttpOnly`,
      });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const port = (server.address() as { port: number }).port;
      const lib = (await import(join(projectDir, "lib", "request.ts"))) as {
        cairnLoginState: (
          auth: unknown,
          opts: { baseURL: string; path: string },
        ) => Promise<void>;
      };
      const statePath = join(projectDir, ".auth", "member.json");
      await lib.cairnLoginState(
        { login: { method: "POST", url: "/login", timeout: 5000 } },
        { baseURL: `http://127.0.0.1:${port}`, path: statePath },
      );
      const fs = await import("node:fs");
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
        cookies: Array<{ name: string }>;
      };
      expect(state.cookies.map((c) => c.name)).toEqual(["sid"]);
      expect(
        fs.readdirSync(dirname(statePath)).filter((f) => f.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("prepares the auth literal without credential values", () => {
    const prepared = prepareExportAuth(ENV_AUTH);
    const text = JSON.stringify(prepared);
    expect(text).toContain("__CAIRN_SECRET_REF__E2E_PASSWORD__");
    expect(text).not.toContain("${secrets.");
    expect(prepared).toMatchObject({
      login: { method: "POST", url: "/api/login", expectStatus: [200] },
      hydrate: { eval: "window.__session = args.login; return true;" },
    });
  });
});

/**
 * The request runtime reads paths and matches through the runner's OWN
 * matcher module (lib/runtime/matchers; never a copy): wired with the generated JS
 * module, the same cases must agree with the runner's functions.
 */
describe("request runtime uses the runner's matchers", () => {
  const source = [
    inlineRuntimeModule("matchers", "js").replaceAll(/^export /gm, ""),
    renderRequestHelperLines("js", ["cairnRequest"]).join("\n"),
  ].join("\n");
  const runtime = new Function(
    `${source}\nreturn { cairnReadPath, cairnMatchPaths };`,
  )() as {
    cairnReadPath: (
      root: unknown,
      path: string,
    ) => {
      exists: boolean;
      value: unknown;
    };
    cairnMatchPaths: (
      root: unknown,
      matchers: Record<string, unknown>,
    ) => string | undefined;
  };

  const body = {
    tasks: [
      { id: "t-1", title: "Intro", n: 2, tags: ["x"], owner: null },
      { id: "t-2", title: "Report", n: 5, tags: ["y", "z"] },
      { id: "t-3", title: "a]b", n: 7, meta: { "key.dot": true } },
    ],
    total: 3,
    empty: [],
    note: "Hello World",
  };
  const paths = [
    "$",
    "$.total",
    "tasks[0].id",
    "tasks.1.title",
    "tasks[-1].n",
    "tasks.length",
    "tasks[*].id",
    "$.tasks[?(@.title == 'Report')].id",
    '$.tasks[?(@.n >= 5 && @.title != "Report")].id',
    "$.tasks[?(@.owner)].id",
    "$.tasks[?(!(@.owner))].id",
    "$.tasks[?(@.tags[0] == 'y')]",
    "$.tasks[?(@.title == 'a]b')].n",
    "$.tasks[?(@.n < 3 || @.n > 6)].id",
    "$.tasks[?(@.title == 'none')].id",
    "$.tasks[2].meta['key.dot']",
    "$.missing.deep",
  ];
  it.each(paths)("reads %s like the runner", (path) => {
    expect(runtime.cairnReadPath(body, path)).toEqual(readPath(body, path));
  });

  const matchers: Array<[unknown, ValueMatcher]> = [
    ["done", "done"],
    ["done", { equals: "DONE", ignoreCase: true }],
    ["Hello World", { contains: "World" }],
    [["a", "b"], { contains: "b" }],
    [[{ id: 1, x: 2 }], { contains: { id: 1 } }],
    [{ a: 1, b: 2 }, { contains: { a: 1 } }],
    ["abc-123", { matches: "^abc-\\d+$" }],
    [3, { oneOf: [1, 2, 3] }],
    ["7", { atLeast: 5, atMost: 9 }],
    ["x", { atLeast: 1 }],
    [[], { empty: true }],
    [[1], { empty: false }],
    [[2, 4], { each: { atLeast: 2 } }],
    [[2, 1], { all: { atLeast: 2 } }],
    [null, { exists: true }],
    [{ a: [1, { b: 2 }] }, { equals: { a: [1, { b: 2 }] } }],
  ];
  it.each(matchers)("matches %j with %j like the runner", (value, matcher) => {
    expect(
      runtime.cairnMatchPaths({ v: value }, { v: matcher }) === undefined,
    ).toBe(matchValue(value, true, matcher, "$").passed);
  });
  it("treats a missing value like the runner", () => {
    for (const matcher of [
      { exists: false },
      { empty: true },
      { equals: 1 },
      { exists: true },
    ] as ValueMatcher[]) {
      expect(runtime.cairnMatchPaths({}, { v: matcher }) === undefined).toBe(
        matchValue(undefined, false, matcher, "$").passed,
      );
    }
  });
  it("names the first failing path", () => {
    expect(
      runtime.cairnMatchPaths({ a: 1, b: 2 }, { a: 1, b: { atLeast: 3 } }),
    ).toBe("b = 2 (expected b >= 3)");
  });
});
