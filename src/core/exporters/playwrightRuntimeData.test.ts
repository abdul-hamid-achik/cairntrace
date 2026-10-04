/**
 * Equivalence of the export's test-time data runtime with the cairn runner:
 * the same inputs must give the same verdict through the generated JavaScript
 * (the exact code a `--lang js` project writes under `lib/`) as through the
 * runner's own implementation — for every matcher, every reference form and
 * every exported verifier. The judging code IS the runner's source (see
 * runtimeSources.ts), so these tests guard the glue, the generation and the
 * runtime-only seams (Playwright's request context, the request log, the
 * workbook reader).
 */
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
  copyFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { buildXlsxFixture } from "../../testing/xlsxFixture";
import { OutcomeSchema, type Outcome } from "../schema/spec.v1";
import { evaluateOutcomes } from "../runner/OutcomeEvaluator";
import { matchPaths } from "../runner/verifiers/matchers";
import { resolveRefsDeep } from "../runner/verifiers/refs";
import { runExpect } from "../runner/verifiers/expect";
import type { VerifierContext } from "../runner/verifiers/types";
import {
  DATA_PIECES,
  dataNeedsWorkbook,
  dataRuntimeModules,
  renderDataPieceModule,
  type DataPiece,
} from "./playwrightRuntimeData";
import { renderRuntimeModule } from "./runtimeSources";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Runtime = Record<string, any>;

/** Write the generated JS of `pieces` (and what they import) and import it. */
async function loadRuntime(pieces: DataPiece[]): Promise<Runtime> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-data-rt-"));
  directories.push(dir);
  await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
  // The glue imports the runner's modules from ./runtime (lib/runtime).
  await mkdir(join(dir, "runtime"), { recursive: true });
  for (const name of dataRuntimeModules(pieces)) {
    await writeFile(
      join(dir, "runtime", `${name}.js`),
      renderRuntimeModule(name, "js"),
    );
  }
  if (dataNeedsWorkbook(pieces)) {
    await copyFile(
      join(repoRoot, "src/sdk/workbook.js"),
      join(dir, "runtime", "workbook.js"),
    );
  }
  const merged: Runtime = {};
  const stamp = Date.now();
  for (const piece of pieces) {
    await writeFile(
      join(dir, `${piece}.js`),
      renderDataPieceModule(piece, "js"),
    );
    Object.assign(
      merged,
      (await import(
        `${pathToFileURL(join(dir, `${piece}.js`)).href}?t=${stamp}`
      )) as Runtime,
    );
  }
  for (const name of dataRuntimeModules(pieces)) {
    Object.assign(
      merged,
      (await import(
        `${pathToFileURL(join(dir, "runtime", `${name}.js`)).href}?t=${stamp}`
      )) as Runtime,
    );
  }
  return merged;
}

function outcome(verify: unknown): Outcome {
  return OutcomeSchema.parse({ id: "check", description: "check", verify });
}

/** The runner's verdict for one verifier. */
async function runner(
  verify: unknown,
  ctx: VerifierContext = {},
  backend = new MockBrowserBackend(),
): Promise<{ passed: boolean; expected: string; actual: string }> {
  const [result] = await evaluateOutcomes([outcome(verify)], backend, ctx);
  const { passed, expected, actual } = result!.evaluation;
  return { passed, expected, actual };
}

/** The export's verdict: it throws when the check does not hold. */
async function exported(run: () => unknown): Promise<{
  passed: boolean;
  message: string;
}> {
  try {
    await run();
    return { passed: true, message: "" };
  } catch (error) {
    return { passed: false, message: (error as Error).message };
  }
}

/* ----- matchers ----- */

const DOC = {
  status: "COMPLETED",
  total: "12",
  count: 3,
  tags: ["a", "b"],
  items: [
    { sku: "A-1", qty: 2, tags: ["x"] },
    { sku: "B-2", qty: 0, tags: [] },
  ],
  rows: [
    { id: 1, name: "ann", done: true },
    { id: 2, name: "bob", done: false },
    { id: 3, name: "cy", done: true },
  ],
  meta: { "with.dot": true, empty: [], nested: { deep: { x: 1 } } },
  nothing: null,
  text: "Hello World",
  num: 42,
  flag: false,
};

const MATCHER_CASES: Array<[string, unknown]> = [
  ["status", "COMPLETED"],
  ["status", { equals: "completed", ignoreCase: true }],
  ["status", { equals: "completed" }],
  ["status", { oneOf: ["RUNNING", "COMPLETED"] }],
  ["status", { oneOf: ["RUNNING"] }],
  ["status", { matches: "^COMP" }],
  ["status", { matches: "^comp", ignoreCase: true }],
  ["status", { matches: "^comp" }],
  ["total", { atLeast: 10, atMost: 12 }],
  ["total", { atLeast: 13 }],
  ["total", { atMost: 11 }],
  ["status", { atLeast: 1 }],
  ["flag", { atLeast: 0 }],
  ["tags", { contains: "b" }],
  ["tags", { contains: "z" }],
  ["items", { contains: { sku: "A-1" } }],
  ["items", { contains: { sku: "Z" } }],
  ["meta", { contains: { "with.dot": true } }],
  ["text", { contains: "world", ignoreCase: true }],
  ["text", { contains: "world" }],
  ["items", { all: { exists: true } }],
  ["rows[*].id", { each: { atLeast: 1 } }],
  ["rows[*].id", { each: { atLeast: 2 } }],
  ["rows[*].done", { each: true }],
  ["status", { each: "x" }],
  ["meta.empty", { empty: true }],
  ["meta.empty", { empty: false }],
  ["missing", { empty: true }],
  ["missing", { exists: false }],
  ["missing", { exists: true }],
  ["missing", { equals: null }],
  ["missing", "x"],
  ["nothing", { exists: true }],
  ["nothing", null],
  ["nothing", { equals: null }],
  ["count", 3],
  ["count", "3"],
  ["flag", false],
  ["flag", true],
  ["num", { equals: 42 }],
  ["num", { oneOf: [41, 42] }],
  ["num", { matches: "^4" }],
  ["items[0].tags", { equals: ["x"] }],
  ["items[1].tags", { equals: [] }],
  ["meta.nested", { equals: { deep: { x: 1 } } }],
  ["meta.nested", { equals: { deep: { x: 2 } } }],
  ["items.length", 2],
  ["items[-1].sku", "B-2"],
  ["items[5].sku", { exists: false }],
  ["$.meta['with.dot']", true],
  ["rows[?(@.done==true)].name", { equals: ["ann", "cy"] }],
  ['rows[?(@.name == "bob" || @.id >= 3)].id', { equals: [2, 3] }],
  ["rows[?(@.id != 2 && @.done)].name", { contains: "cy" }],
  ["rows[?(!@.done)].name", { equals: ["bob"] }],
  ["rows[?(@.id > 99)].name", { exists: false }],
  ["$", { contains: { status: "COMPLETED" } }],
  ["", { contains: { status: "COMPLETED" } }],
];

describe("matchers: the generated runtime judges like the runner", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataValue"]);
  });

  it.each(MATCHER_CASES)("%s %j", (path, matcher) => {
    const real = matchPaths(DOC, { [path]: matcher as never });
    const generated = rt["matchPaths"](DOC, { [path]: matcher }) as ReturnType<
      typeof matchPaths
    >;
    expect(generated).toEqual(real);
  });

  it("reports an invalid path filter exactly like the runner", () => {
    const run = (fn: (root: unknown, m: never) => unknown): string => {
      try {
        fn(DOC, { "rows[?(@.id ==)].x": 1 } as never);
        return "no error";
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }
    };
    expect(run(rt["matchPaths"])).toBe(run(matchPaths as never));
    expect(run(rt["matchPaths"])).toContain("PathSyntaxError");
  });

  it("assertValue throws the runner's expected / actual text", async () => {
    const expectation = { status: "RUNNING", "items.0.qty": 2 };
    const real = await runner(
      { value: { actual: "${captures.doc}", expect: expectation } },
      { captures: { doc: DOC } },
    );
    expect(real.passed).toBe(false);
    const verdict = await exported(() =>
      rt["cairnAssertValue"](DOC, expectation, "${captures.doc}"),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.message).toContain(real.actual);
    expect(verdict.message).toContain(
      real.expected.replace("${captures.doc}: ", ""),
    );
    expect(
      (
        await exported(() =>
          rt["cairnAssertValue"](DOC, { status: "COMPLETED" }, "x"),
        )
      ).passed,
    ).toBe(true);
  });
});

/* ----- references ----- */

describe("references: the generated resolver reads like the runner", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataValue"]);
  });

  const scope = {
    responses: {
      login: { status: 200, body: { token: "t-1", ids: [10, 20] } },
    },
    evals: { state: { value: { count: 3, list: ["a", "b"] } } },
    captures: { row: { rows: [{ SKU: "A" }], rowCount: 1 }, name: "Ada" },
    networkAssigns: {
      sent: { count: 2, at: "2026-01-01T00:00:00.000Z", status: 202 },
    },
    fixtureOutputs: { product: { sku: "FX-1", stock: 5 } },
    runOutputs: { seeded: { sku: "RS-1", nested: { n: 7 } } },
    artifacts: {
      wb: { path: "/tmp/x.xlsx", relativePath: "downloads/x.xlsx" },
    },
    runStartedAt: "2026-01-01T00:00:00.000Z",
  };

  const VALUES: unknown[] = [
    "${requests.login.body.token}",
    "${requests.login.body.ids}",
    "${requests.login.body.ids.1}",
    "${requests.login.body.ids.length}",
    "token ${requests.login.body.token} for ${captures.name}",
    "${evals.state.value.count}",
    "${evals.state.value}",
    "n=${evals.state.value.count}",
    "${captures.row}",
    "${captures.row.rowCount}",
    "${captures.name}",
    "${network.sent.count}",
    "${network.sent.at}",
    "${fixtures.product.sku}",
    "${fixtures.product.stock}",
    "SKU ${fixtures.product.sku}",
    "${runs.seeded.nested.n}",
    "${runs.seeded}",
    "${artifacts.wb.path}",
    "${artifacts.wb.relativePath}",
    "${run.startedAt}",
    "${requests.login.body.nope}",
    "${requests.nope.x}",
    "${captures.nope}",
    "${fixtures.product.nope}",
    "${runs.nope}",
    {
      "rows[0].SKU": "${captures.row.rows.0.SKU}",
      n: "${network.sent.count}",
      ok: true,
    },
    ["${captures.name}", "${fixtures.product.sku}", 3],
    "plain text",
    42,
    null,
  ];

  it.each(VALUES.map((v) => [JSON.stringify(v), v] as const))(
    "%s",
    (_name, value) => {
      const real = resolveRefsDeep(value, {
        responses: scope.responses,
        evals: scope.evals,
        captures: scope.captures,
        networkAssigns: scope.networkAssigns,
        fixtureOutputs: scope.fixtureOutputs,
        runOutputs: scope.runOutputs,
        artifacts: scope.artifacts as never,
        runStartedAt: scope.runStartedAt,
      });
      const generated = rt["resolveRefsDeep"](value, scope) as typeof real;
      expect(generated).toEqual(real);
    },
  );

  it("cairnRefs throws on an unresolved reference and returns typed values otherwise", () => {
    expect(rt["cairnRefs"]("${fixtures.product.stock}", scope, "x")).toBe(5);
    expect(() =>
      rt["cairnRefs"]("${captures.nope}", scope, "value actual"),
    ).toThrow("value actual: unresolved ${captures.nope}");
  });
});

/* ----- value verifier end to end ----- */

describe("value verifier: export vs runner", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataValue"]);
  });

  const scope = {
    captures: { row: { rowCount: 1, rows: [{ SKU: "FX-1", Stock: "5" }] } },
    fixtureOutputs: { product: { sku: "FX-1" } },
    responses: { job: { body: { status: "done", quantity: 5 } } },
  };
  const ctx: VerifierContext = {
    captures: scope.captures,
    fixtureOutputs: scope.fixtureOutputs,
    responses: scope.responses,
  };
  const CASES: Array<{ actual: string; expect: Record<string, unknown> }> = [
    {
      actual: "${captures.row}",
      expect: {
        rowCount: 1,
        "rows[0].SKU": "${fixtures.product.sku}",
        "rows[0].Stock": "5",
      },
    },
    {
      actual: "${captures.row}",
      expect: { rowCount: 2, "rows[0].SKU": "${fixtures.product.sku}" },
    },
    { actual: "${requests.job.body}", expect: { status: "done", quantity: 5 } },
    {
      actual: "${requests.job.body}",
      expect: { status: "done", quantity: { atLeast: 6 } },
    },
    {
      actual: "${captures.row}",
      expect: { "rows[0].Missing": { exists: true } },
    },
  ];

  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s",
    async (_name, c) => {
      const real = await runner({ value: c }, ctx);
      const verdict = await exported(() => {
        const expectation = rt["cairnRefs"](
          c.expect,
          scope,
          "value expectations",
        );
        const actual = rt["cairnRefs"](c.actual, scope, "value actual");
        rt["cairnAssertValue"](actual, expectation, c.actual);
      });
      expect(verdict.passed).toBe(real.passed);
      if (!real.passed) expect(verdict.message).toContain(real.actual);
    },
  );

  it("fails on an unresolved reference like the runner", async () => {
    const c = { actual: "${captures.gone}", expect: { x: 1 } };
    const real = await runner({ value: c }, ctx);
    expect(real.passed).toBe(false);
    const verdict = await exported(() =>
      rt["cairnRefs"](c.actual, scope, "value actual"),
    );
    expect(verdict.passed).toBe(false);
    expect(real.actual).toContain("unresolved");
    expect(verdict.message).toContain("unresolved ${captures.gone}");
  });
});

/* ----- httpJson ----- */

describe("httpJson: the generated judge matches evaluateHttpJson", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataHttpJson"]);
  });

  const BODY = {
    owner: "ada",
    n: 7,
    list: [1, 2, 3],
    text: "abc",
    nested: { k: [] },
  };
  const CASES: Array<Record<string, unknown>> = [
    { jsonPath: "$.owner", equals: "ada" },
    { jsonPath: "$.owner", equals: "bob" },
    { jsonPath: "$.owner", contains: "d" },
    { jsonPath: "$.list", contains: 2 },
    { jsonPath: "$.list", contains: 9 },
    { jsonPath: "$.owner", matches: "^a" },
    { jsonPath: "$.owner", matches: "^b" },
    { jsonPath: "$.n", matches: "^7$" },
    { jsonPath: "$.n", atLeast: 7 },
    { jsonPath: "$.n", atLeast: 8 },
    { jsonPath: "$.n", atMost: 7 },
    { jsonPath: "$.n", atMost: 6 },
    { jsonPath: "$.owner", atLeast: 1 },
    { jsonPath: "$.missing", exists: false },
    { jsonPath: "$.missing", exists: true },
    { jsonPath: "$.owner", exists: true },
    { jsonPath: "$.missing", equals: 1 },
    { jsonPath: "$", exists: true },
    { jsonPath: "nested.k", equals: [] },
  ];

  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s",
    async (_name, c) => {
      const backend = new MockBrowserBackend();
      backend.enqueueEvalResult({ status: 200, ok: true, body: BODY });
      const real = await runner(
        { httpJson: { url: "http://app.test/x", ...c } },
        {},
        backend,
      );
      const verdict = await exported(() => rt["cairnAssertHttpJson"](BODY, c));
      expect(verdict.passed).toBe(real.passed);
      if (!real.passed) {
        expect(verdict.message).toContain(real.expected);
        expect(verdict.message).toContain(real.actual);
      }
    },
  );
});

/* ----- network ----- */

describe("network: the generated judge matches evaluateNetwork", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataNetwork"]);
  });

  const T0 = Date.parse("2026-03-01T10:00:00.000Z");
  const LOG = [
    {
      url: "http://app.test/api/restock",
      method: "POST",
      status: 202,
      timestamp: T0,
      postData: '{"sku":"S-1","quantity":5}',
    },
    {
      url: "http://app.test/api/restock",
      method: "POST",
      status: 202,
      timestamp: T0 + 1000,
      postData: '{"sku":"S-2","quantity":1}',
    },
    {
      url: "http://app.test/api/restock",
      method: "POST",
      status: 500,
      timestamp: T0 + 2000,
      postData: '{"sku":"S-1","quantity":5}',
    },
    {
      url: "http://app.test/api/restock",
      method: "POST",
      timestamp: T0 + 3000,
      postData: "not json",
    },
    {
      url: "http://app.test/api/products",
      method: "GET",
      status: 200,
      timestamp: T0 + 4000,
    },
  ];
  const scope = { captures: { sku: "S-1" } };

  const CASES: Array<Record<string, unknown>> = [
    { urlContains: "/api/products" },
    { urlContains: "/api/missing" },
    { method: "POST", urlContains: "/api/restock", status: { equals: 202 } },
    { method: "POST", urlContains: "/api/restock", status: { equals: 404 } },
    { method: "POST", urlContains: "/api/restock", status: { atLeast: 500 } },
    {
      method: "POST",
      urlContains: "/api/restock",
      status: { below: 300 },
      count: 2,
    },
    {
      method: "POST",
      urlContains: "/api/restock",
      status: { in: [202, 500] },
      count: { atLeast: 3 },
    },
    { method: "POST", urlContains: "/api/restock", count: 4 },
    { method: "POST", urlContains: "/api/restock", count: 0 },
    { method: "POST", urlContains: "/api/restock", count: { atMost: 3 } },
    {
      method: "POST",
      urlContains: "/api/restock",
      status: { equals: 202 },
      body: { json: { sku: "S-1", quantity: 5 } },
      count: 1,
    },
    {
      method: "POST",
      urlContains: "/api/restock",
      body: { json: { sku: "S-1" } },
    },
    {
      method: "POST",
      urlContains: "/api/restock",
      body: { json: { sku: "S-1" }, match: "exact" },
    },
    {
      method: "POST",
      urlContains: "/api/restock",
      body: { json: { sku: "${captures.sku}" } },
      count: 2,
    },
    {
      method: "POST",
      urlContains: "/api/restock",
      body: { json: { sku: "${captures.nope}" } },
    },
    { method: "POST", urlContains: "/api/restock", assign: "sent" },
    { urlContains: "/api/nothing", assign: "none" },
  ];

  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s",
    async (_name, c) => {
      // The runner's verdict over the same captured log.
      const backend = new MockBrowserBackend();
      for (const entry of LOG) backend.pushNetworkEntry(entry);
      const ctx2: VerifierContext = { captures: scope.captures };
      const viaBackend = await runner({ network: c }, ctx2, backend);
      let assignment: unknown;
      // settleMs 0: the runner judges this snapshot as given (its bounded
      // settle runs when the snapshot is taken; see networkSettle.test.ts).
      const verdict = await exported(async () => {
        assignment = await rt["cairnAssertNetwork"](LOG, c, scope, 0);
      });
      expect(verdict.passed).toBe(viaBackend.passed);
      if (!viaBackend.passed) {
        expect(verdict.message).toContain(viaBackend.expected);
        expect(verdict.message).toContain(viaBackend.actual);
      } else if (c["assign"]) {
        expect(assignment).toEqual(
          ctx2.networkAssigns?.[c["assign"] as string],
        );
      }
    },
  );

  it("cairnTrackRequests joins the status to the request that carried the body", async () => {
    const handlers: Record<string, Array<(arg: unknown) => void>> = {};
    const page = {
      on(event: string, handler: (arg: unknown) => void) {
        (handlers[event] ??= []).push(handler);
      },
    };
    const log = rt["cairnTrackRequests"](page) as Array<
      Record<string, unknown>
    >;
    const request = {
      url: () => "http://app.test/api/x",
      method: () => "POST",
      postData: () => '{"a":1}',
    };
    handlers["request"]![0]!(request);
    handlers["response"]![0]!({ request: () => request, status: () => 201 });
    handlers["request"]![0]!({ ...request, postData: () => null });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      url: "http://app.test/api/x",
      method: "POST",
      status: 201,
      postData: '{"a":1}',
    });
    expect(log[0]!["timestamp"]).toEqual(expect.any(Number));
    expect(log[1]).not.toHaveProperty("postData");
    expect(log[1]).not.toHaveProperty("status");
  });

  it("cairnTrackRequests records network failures (requestfailed, finished without a response)", () => {
    const handlers: Record<string, Array<(arg: unknown) => void>> = {};
    const page = {
      on(event: string, handler: (arg: unknown) => void) {
        (handlers[event] ??= []).push(handler);
      },
    };
    const log = rt["cairnTrackRequests"](page) as Array<
      Record<string, unknown>
    >;
    const refused = failingRequest("http://app.test/api/a");
    const blank = {
      ...failingRequest("http://app.test/api/b"),
      failure: () => null,
    };
    handlers["request"]![0]!(refused);
    handlers["request"]![0]!(blank);
    handlers["requestfailed"]![0]!(refused);
    handlers["requestfinished"]![0]!(blank);
    expect(log[0]).toMatchObject({ error: "net::ERR_CONNECTION_REFUSED" });
    expect(log[1]).toMatchObject({
      error: "request finished without response status",
    });
  });
});

/* ----- noFailedRequests ----- */

/** A Playwright request whose failure() names a network error. */
function failingRequest(url: string) {
  return {
    url: () => url,
    method: () => "GET",
    postData: () => null,
    failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
  };
}

describe("noFailedRequests: the generated judge matches evaluateNoFailedRequests", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataNetwork"]);
  });

  const LOG = [
    { url: "http://app.test/api/a", method: "GET", status: 200 },
    { url: "http://app.test/api/b", method: "POST", status: 503 },
    {
      url: "http://app.test/api/c",
      method: "GET",
      error: "net::ERR_CONNECTION_REFUSED",
    },
    { url: "http://app.test/api/d", method: "GET" },
    { url: "http://app.test/static/x.js", method: "GET", status: 404 },
  ];
  const CASES: Array<Record<string, unknown>> = [
    { urlContains: "/api/" },
    { urlContains: "/api/a" },
    { urlContains: "/api/c" },
    { urlContains: "/api/d" },
    { urlContains: "/api/", method: "POST" },
    { urlContains: "/api/", method: "DELETE" },
    { urlContains: "/static/" },
  ];

  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s",
    async (_name, c) => {
      const backend = new MockBrowserBackend();
      for (const entry of LOG) backend.pushNetworkEntry(entry);
      const viaBackend = await runner({ noFailedRequests: c }, {}, backend);
      const verdict = await exported(() =>
        rt["cairnAssertNoFailedRequests"](LOG, c, 0),
      );
      expect(verdict.passed).toBe(viaBackend.passed);
      if (!viaBackend.passed) {
        expect(verdict.message).toContain(viaBackend.expected);
        expect(verdict.message).toContain(viaBackend.actual);
      }
    },
  );

  it("waits (bounded) for a judged request whose response has not arrived", async () => {
    const entry: Record<string, unknown> = {
      url: "http://app.test/api/late",
      method: "GET",
    };
    setTimeout(() => {
      entry["status"] = 500;
    }, 150);
    const started = Date.now();
    const verdict = await exported(() =>
      rt["cairnAssertNoFailedRequests"]([entry], { urlContains: "/api/" }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.message).toContain("GET http://app.test/api/late → 500");
    expect(Date.now() - started).toBeLessThan(1500);
    // A request that never settles is judged pending after the bound.
    const still = await exported(() =>
      rt["cairnAssertNoFailedRequests"](
        [{ url: "http://app.test/api/open", method: "GET" }],
        { urlContains: "/api/" },
        200,
      ),
    );
    expect(still.passed).toBe(true);
  });
});

/* ----- file ----- */

describe("file: the generated wait matches evaluateFile", () => {
  let rt: Runtime;
  let dir: string;
  beforeAll(async () => {
    rt = await loadRuntime(["dataFile", "dataPath"]);
    dir = await mkdtemp(join(tmpdir(), "cairn-file-"));
    directories.push(dir);
    await writeFile(join(dir, "mail-1.json"), '{"to":"ada@example.test"}');
    await writeFile(join(dir, "mail-2.json"), '{"to":"bob@example.test"}');
  });

  const CASES: Array<{ glob: string; contains?: string; timeoutMs: number }> = [
    { glob: "mail-*.json", timeoutMs: 400 },
    { glob: "mail-?.json", contains: "bob@", timeoutMs: 400 },
    { glob: "mail-*.json", contains: "cy@", timeoutMs: 300 },
    { glob: "none-*.json", timeoutMs: 300 },
  ];

  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s",
    async (_name, c) => {
      const real = await runner(
        {
          file: {
            glob: c.glob,
            ...(c.contains ? { contains: c.contains } : {}),
            timeoutMs: c.timeoutMs,
          },
        },
        { specDir: dir, runDir: dir },
      );
      const verdict = await exported(() =>
        rt["cairnAssertFile"](
          c.glob,
          rt["cairnFilePath"](c.glob, false, dir, dir),
          c.contains,
          c.timeoutMs,
        ),
      );
      expect(verdict.passed).toBe(real.passed);
      if (!real.passed) {
        expect(verdict.message).toContain(real.expected);
        expect(verdict.message).toContain(real.actual);
      }
    },
  );

  it("resolves paths like resolveRuntimeFilePath (artifact references against the run directory)", () => {
    expect(rt["cairnFilePath"]("/abs/x.csv", true, "/run", "/spec")).toBe(
      "/abs/x.csv",
    );
    expect(rt["cairnFilePath"]("downloads/x.csv", true, "/run", "/spec")).toBe(
      "/run/downloads/x.csv",
    );
    expect(rt["cairnFilePath"]("out/x.csv", false, "/run", "/spec")).toBe(
      "/spec/out/x.csv",
    );
  });
});

/* ----- xlsx ----- */

describe("xlsx: the generated judge matches evaluateXlsx", () => {
  let rt: Runtime;
  let dir: string;
  let workbookPath: string;
  beforeAll(async () => {
    rt = await loadRuntime(["dataXlsx", "dataValue"]);
    dir = await mkdtemp(join(tmpdir(), "cairn-xlsx-rt-"));
    directories.push(dir);
    workbookPath = join(dir, "products.xlsx");
    await writeFile(
      workbookPath,
      buildXlsxFixture(
        [
          {
            name: "Products",
            rows: [
              ["SKU", "Name", "Category", "Stock (units)"],
              ["AN-HUB-7P", "Hub", "electronics", "5"],
              ["PN-LAB-1", "Printer", "office", "3"],
            ],
            validations: [{ type: "whole", sqref: "D2:D1048576" }],
          },
          {
            name: "Guide",
            rows: [
              ["Field", "Guidance"],
              ["SKU", "Unique code"],
            ],
          },
        ],
        { xfs: [0] },
      ),
    );
  });

  const CASES: Array<Record<string, unknown>> = [
    { sheets: [{ name: "Products", contains: ["SKU", "AN-HUB-7P"] }] },
    { sheets: [{ name: "Products", contains: ["NOPE"] }] },
    { sheets: [{ name: "Missing" }] },
    { contains: ["Unique code"] },
    { contains: ["nowhere"] },
    {
      sheet: "Products",
      headers: { present: ["SKU", "Stock"], strip: "\\s*\\(units\\)$" },
    },
    { sheet: "Products", headers: { absent: ["Supplier"] } },
    { sheet: "Products", headers: { absent: ["Name"] } },
    { sheet: "Products", headers: { includesInOrder: ["SKU", "Category"] } },
    { sheet: "Products", headers: { includesInOrder: ["Category", "SKU"] } },
    {
      sheet: "Products",
      headers: {
        withinListInOrder: ["SKU", "Name", "Category", "Stock (units)", "More"],
      },
    },
    {
      sheet: "Products",
      headers: { includesInOrder: "${captures.screen.headers}" },
    },
    { sheet: "Products", rows: { afterKeyRow: { atLeast: 2 } } },
    { sheet: "Products", rows: { afterKeyRow: { count: 3 } } },
    {
      sheet: "Products",
      rows: {
        match: [
          { column: "SKU", matcher: "AN-HUB-7P" },
          { column: "Category", matcher: "electronics" },
        ],
      },
    },
    {
      sheet: "Products",
      rows: {
        match: [
          { column: "SKU", matcher: "AN-HUB-7P" },
          { column: "Category", matcher: "office" },
        ],
      },
    },
    {
      sheet: "Products",
      cells: [
        { ref: "A1", equals: "SKU" },
        { ref: "D1", matches: "^Stock" },
      ],
    },
    { sheet: "Products", cells: [{ ref: "A1", equals: "Nope" }] },
    {
      sheet: "Products",
      validations: [{ column: "Stock (units)", type: "whole" }],
    },
    { sheet: "Products", validations: [{ column: "Name", type: "whole" }] },
    { sheet: { match: "^Prod" }, headers: { present: ["SKU"] } },
    { sheet: 1, headers: { present: ["Field"] } },
    { sheet: 7, headers: { present: ["Field"] } },
  ];
  const captures = {
    screen: { headers: ["SKU", "Name", "Category", "Stock (units)"] },
  };

  it.each(CASES.map((c) => [JSON.stringify(c), c] as const))(
    "%s",
    async (_name, c) => {
      const real = await runner(
        { xlsx: { path: workbookPath, ...c } },
        { captures },
      );
      const verdict = await exported(() => {
        const checks = rt["cairnRefs"](c, { captures }, "xlsx checks");
        rt["cairnAssertXlsx"](workbookPath, checks);
      });
      expect(verdict.passed).toBe(real.passed);
      if (!real.passed && !real.actual.startsWith("unresolved")) {
        expect(verdict.message).toContain(real.actual);
      }
    },
  );

  it("reports an unreadable workbook", async () => {
    const bad = join(dir, "bad.xlsx");
    await writeFile(bad, "not a zip");
    const real = await runner({ xlsx: { path: bad, contains: ["x"] } });
    expect(real.passed).toBe(false);
    const verdict = await exported(() =>
      rt["cairnAssertXlsx"](bad, { contains: ["x"] }),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.message).toContain("failed to read workbook");
  });
});

/* ----- transform ----- */

const make = (body: string) => ({
  transform: async (ctx: { output: { path: string } }) => {
    await writeFile(ctx.output.path, body);
    return { ok: true };
  },
});

describe("transform: the module runs with the runner's ctx contract", () => {
  let rt: Runtime;
  let dir: string;
  beforeAll(async () => {
    rt = await loadRuntime(["dataTransform"]);
    dir = await mkdtemp(join(tmpdir(), "cairn-transform-"));
    directories.push(dir);
  });

  it("writes through a named export, a default export and a CJS-style default.default", async () => {
    for (const [name, module] of [
      ["named", make("n")],
      ["default", { default: make("d").transform }],
      ["interop", { default: { default: make("i").transform } }],
    ] as const) {
      const out = join(dir, "sub", `${name}.txt`);
      await rt["cairnRunTransform"](module, { output: { path: out } }, out);
    }
  });

  it("fails like the runner: no entry, ok=false, a throw, no output", async () => {
    const out = join(dir, "x.txt");
    const failure = async (module: unknown): Promise<string> => {
      try {
        await rt["cairnRunTransform"](module, { output: { path: out } }, out);
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await failure({})).toContain("must export a function");
    expect(await failure({ transform: async () => ({ ok: false }) })).toBe(
      "node transform returned ok=false",
    );
    expect(
      await failure({
        transform: async () => {
          throw new Error("boom");
        },
      }),
    ).toBe("node transform failed: boom");
    expect(await failure({ transform: async () => ({ ok: true }) })).toContain(
      "did not write",
    );
  });
});

/* ----- expect.request ----- */

type Reply = { status: number; body: unknown } | "boom";

function pageFor(replies: Reply[]) {
  let i = 0;
  return {
    request: {
      fetch: async () => {
        const reply = replies[Math.min(i++, replies.length - 1)]!;
        if (reply === "boom") {
          throw new Error("connect ECONNREFUSED\nCall log: x");
        }
        return {
          status: () => reply.status,
          text: async () =>
            typeof reply.body === "string"
              ? reply.body
              : JSON.stringify(reply.body),
        };
      },
    },
  };
}

describe("expect.request: the generated check matches runExpect", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await loadRuntime(["dataHttp"]);
  });

  const CASES: Array<{
    name: string;
    request: Record<string, unknown>;
    replies: Reply[];
  }> = [
    {
      name: "2xx by default",
      request: { url: "/api/x" },
      replies: [{ status: 200, body: {} }],
    },
    {
      name: "wrong status",
      request: { url: "/api/x", status: 201 },
      replies: [{ status: 200, body: {} }],
    },
    {
      name: "status matcher",
      request: { url: "/api/x", status: { in: [200, 202] } },
      replies: [{ status: 202, body: {} }],
    },
    {
      name: "json paths hold",
      request: {
        url: "/api/x",
        json: { sku: "S", "items[0].n": { atLeast: 1 } },
      },
      replies: [{ status: 200, body: { sku: "S", items: [{ n: 2 }] } }],
    },
    {
      name: "json path fails",
      request: { url: "/api/x", json: { sku: "T" } },
      replies: [{ status: 200, body: { sku: "S" } }],
    },
    {
      name: "non-JSON body",
      request: { url: "/api/x", json: { a: 1 } },
      replies: [{ status: 200, body: "text" }],
    },
    { name: "transport error", request: { url: "/api/x" }, replies: ["boom"] },
  ];

  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const spec = { method: "GET", ...c.request } as Record<string, unknown>;
    const page = pageFor(c.replies);
    const real = await runExpect({ request: spec } as never, {
      backend: new MockBrowserBackend(),
      scope: {},
      waitScale: 0.01,
      sleep: async () => undefined,
      request: async (call) => {
        const reply = c.replies[0]!;
        if (reply === "boom")
          return { ok: false as const, error: "connect ECONNREFUSED" };
        let body: unknown =
          typeof reply.body === "string" ? reply.body : reply.body;
        if (typeof reply.body === "string") {
          try {
            body = JSON.parse(reply.body);
          } catch {
            body = reply.body;
          }
        }
        return {
          ok: true as const,
          response: { status: reply.status, body, url: call.url },
        };
      },
    });
    const verdict = await exported(() =>
      rt["cairnExpectRequest"](
        page,
        { method: "GET", url: String(spec["url"]) },
        {
          ...(spec["status"] !== undefined ? { status: spec["status"] } : {}),
          ...(spec["json"] ? { json: spec["json"] } : {}),
        },
        20,
      ),
    );
    expect(verdict.passed).toBe(real.passed);
    if (!real.passed && !String(real.actual).includes("ECONNREFUSED")) {
      expect(verdict.message).toContain(real.actual);
    }
    if (c.replies[0] === "boom")
      expect(verdict.message).toContain("ECONNREFUSED");
  });

  it("retries GET until it holds; never retries a write", async () => {
    const slow = pageFor([
      { status: 200, body: { status: "queued" } },
      { status: 200, body: { status: "done" } },
    ]);
    const ok = await exported(() =>
      rt["cairnExpectRequest"](
        slow,
        { method: "GET", url: "/j" },
        { json: { status: "done" } },
        2000,
      ),
    );
    expect(ok.passed).toBe(true);
    const once = pageFor([
      { status: 200, body: { status: "queued" } },
      { status: 200, body: { status: "done" } },
    ]);
    const post = await exported(() =>
      rt["cairnExpectRequest"](
        once,
        { method: "POST", url: "/j" },
        { json: { status: "done" } },
        2000,
      ),
    );
    expect(post.passed).toBe(false);
  });
});

/* ----- compile ----- */

describe("generated glue compiles strictly", () => {
  it("every piece, with the runtime modules it imports, under strict + noUnusedLocals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-data-ts-"));
    directories.push(dir);
    const files: string[] = [];
    await mkdir(join(dir, "runtime"), { recursive: true });
    for (const name of dataRuntimeModules(DATA_PIECES)) {
      const path = join(dir, "runtime", `${name}.ts`);
      await writeFile(path, renderRuntimeModule(name, "ts"));
      files.push(path);
    }
    for (const piece of DATA_PIECES) {
      const path = join(dir, `${piece}.ts`);
      await writeFile(path, renderDataPieceModule(piece, "ts"));
      files.push(path);
    }
    await copyFile(
      join(repoRoot, "src/sdk/workbook.js"),
      join(dir, "runtime", "workbook.js"),
    );
    const declaration = join(dir, "runtime", "workbook.d.ts");
    await copyFile(join(repoRoot, "src/sdk/workbook.d.ts"), declaration);
    files.push(declaration);
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      typeRoots: [join(repoRoot, "node_modules/@types")],
      baseUrl: dir,
      paths: {
        "@playwright/test": [join(repoRoot, "node_modules/@playwright/test")],
      },
      strict: true,
      noUnusedLocals: true,
      noEmit: true,
      skipLibCheck: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && !d.file.fileName.endsWith("workbook.d.ts"))
      .map(
        (d) =>
          `${d.file?.fileName.split("/").pop()}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      );
    expect(diagnostics).toEqual([]);
  }, 60_000);
});
