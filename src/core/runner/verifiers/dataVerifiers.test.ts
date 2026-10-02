import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../../adapters/mock/MockBrowserBackend";
import { resolveEnvironmentDatasources } from "../../datasources/resolve";
import { DatasourcesConfigSchema } from "../../datasources/schema";
import { OutcomeSchema, type Outcome } from "../../schema/spec.v1";
import { VerifierSchema } from "../../schema/verifier.v1";
import { evaluateOutcomes } from "../OutcomeEvaluator";
import { matchPaths, matchValue, readPath } from "./matchers";
import { runPolled } from "./poll";
import type { VerifierContext, VerifierEvaluation } from "./types";

function outcome(raw: unknown): Outcome {
  return OutcomeSchema.parse(raw);
}

async function evaluateOne(
  raw: unknown,
  ctx: VerifierContext = {},
  backend = new MockBrowserBackend(),
): Promise<VerifierEvaluation> {
  const [result] = await evaluateOutcomes(
    [outcome({ id: "check", description: "check", verify: raw })],
    backend,
    ctx,
  );
  return result!.evaluation;
}

/** A value verifier whose `expect` is the matcher map under test. */
function parse(expectation: unknown) {
  return VerifierSchema.safeParse({
    value: { actual: "${captures.x}", expect: expectation },
  });
}

/** Whether a text verifier with this `poll` modifier parses. */
function poll(p: unknown): boolean {
  return VerifierSchema.safeParse({ text: { contains: "x" }, poll: p }).success;
}

/** A fake clock for the poll loop (sleep advances time). */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("data matchers", () => {
  const doc = {
    status: "COMPLETED",
    total: "12",
    tags: ["a", "b"],
    items: [
      { sku: "A-1", qty: 2 },
      { sku: "B-2", qty: 0 },
    ],
    meta: { "with.dot": true, empty: [] },
    nothing: null,
  };

  it("reads JSONPath-ish paths", () => {
    expect(readPath(doc, "$")).toEqual({ exists: true, value: doc });
    expect(readPath(doc, "$.items[1].sku").value).toBe("B-2");
    expect(readPath(doc, "items.0.qty").value).toBe(2);
    expect(readPath(doc, "items[-1].qty").value).toBe(0);
    expect(readPath(doc, "items.length").value).toBe(2);
    expect(readPath(doc, "items[*].sku").value).toEqual(["A-1", "B-2"]);
    expect(readPath(doc, "$.meta['with.dot']").value).toBe(true);
    expect(readPath(doc, "nothing")).toEqual({ exists: true, value: null });
    expect(readPath(doc, "missing.deep").exists).toBe(false);
  });

  it("applies scalar shorthand and combined matcher keys", () => {
    const check = (path: string, matcher: unknown) => {
      const read = readPath(doc, path);
      return matchValue(read.value, read.exists, matcher as never, path).passed;
    };
    expect(check("status", "COMPLETED")).toBe(true);
    expect(check("status", { equals: "completed", ignoreCase: true })).toBe(
      true,
    );
    expect(check("status", { oneOf: ["RUNNING", "COMPLETED"] })).toBe(true);
    expect(check("status", { matches: "^COMP" })).toBe(true);
    expect(check("total", { atLeast: 10, atMost: 12 })).toBe(true);
    expect(check("total", { atLeast: 13 })).toBe(false);
    expect(check("tags", { contains: "b" })).toBe(true);
    expect(check("items", { contains: { sku: "A-1" } })).toBe(true);
    expect(check("items", { all: { exists: true } })).toBe(true);
    expect(check("items[*].qty", { each: { atLeast: 1 } })).toBe(false);
    expect(check("meta.empty", { empty: true })).toBe(true);
    expect(check("missing", { empty: true })).toBe(true);
    expect(check("missing", { exists: false })).toBe(true);
    expect(check("nothing", { exists: true })).toBe(true);
    expect(check("missing", { equals: null })).toBe(false);
    expect(check("meta", { contains: { "with.dot": true } })).toBe(true);
  });

  it("does not coerce booleans/arrays into numbers", () => {
    expect(matchValue([], true, { atMost: 0 }, "x")).toMatchObject({
      passed: false,
      actual: "[] (not a number)",
    });
  });

  it("reports every failing path", () => {
    const report = matchPaths(doc, { status: "RUNNING", "items.0.qty": 2 });
    expect(report.passed).toBe(false);
    expect(report.results.map((r) => r.passed)).toEqual([false, true]);
  });

  it("validates matcher shapes in the schema", () => {
    expect(parse({ a: { atLeast: 1, atMost: 3 } }).success).toBe(true);
    expect(parse({ a: {} }).success).toBe(false);
    expect(parse({ a: { all: 1, each: 1 } }).success).toBe(false);
    expect(parse({ a: { matches: "(" } }).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });
});

describe("poll modifier", () => {
  it("runs once without poll", async () => {
    let calls = 0;
    const ev = await runPolled(async () => {
      calls++;
      return { passed: false, expected: "x", actual: "y" };
    }, undefined);
    expect(calls).toBe(1);
    expect(ev.attempts).toBeUndefined();
  });

  it("polls every everyMs until green and narrates progress", async () => {
    const c = clock();
    const progress: string[] = [];
    let n = 0;
    const ev = await runPolled(
      async () => {
        n++;
        return n < 3
          ? { passed: false, expected: "count 1", actual: "count=0" }
          : { passed: true, expected: "count 1", actual: "count=1" };
      },
      { timeoutMs: 10_000, everyMs: 500 },
      { now: c.now, sleep: c.sleep, onProgress: (m) => progress.push(m) },
    );
    expect(ev).toMatchObject({ passed: true, attempts: 3, polledMs: 1000 });
    expect(progress).toEqual([
      "attempt 1/~20: count=0 (want count 1)",
      "attempt 2/~20: count=0 (want count 1)",
    ]);
    expect(ev.attemptLog?.map((a) => a.ok)).toEqual([false, false, true]);
  });

  it("requires green to hold for stableMs; a red sample restarts the window", async () => {
    const c = clock();
    const pattern = [true, true, false, true, true, true, true];
    let i = 0;
    const ev = await runPolled(
      async () => {
        const ok = pattern[Math.min(i++, pattern.length - 1)]!;
        return {
          passed: ok,
          expected: "absent",
          actual: ok ? "absent" : "found",
        };
      },
      { timeoutMs: 10_000, everyMs: 1000, stableMs: 2000 },
      { now: c.now, sleep: c.sleep },
    );
    expect(ev.passed).toBe(true);
    // Green at t=3s (after the red at 2s), held through t=5s.
    expect(ev.attempts).toBe(6);
    expect(ev.actual).toContain("held for 2000ms over 3 samples");
  });

  it("rejects a stability window that leaves no room for its closing sample", () => {
    expect(poll({ timeoutMs: 1000, stableMs: 1000, everyMs: 200 })).toBe(false);
    expect(poll({ timeoutMs: 3000, stableMs: 2500 })).toBe(false);
    expect(poll({ timeoutMs: 3000, stableMs: 2000 })).toBe(true);
    expect(poll({ timeoutMs: 1200, stableMs: 1000, everyMs: 200 })).toBe(true);
    // No window: everyMs may exceed the budget (it runs once or twice).
    expect(poll({ timeoutMs: 500 })).toBe(true);
  });

  it("fails when the window cannot complete before the deadline", async () => {
    const c = clock();
    let i = 0;
    const ev = await runPolled(
      async () => {
        i++;
        return {
          passed: i >= 3,
          expected: "absent",
          actual: i >= 3 ? "absent" : "found",
        };
      },
      { timeoutMs: 3000, everyMs: 1000, stableMs: 2000 },
      { now: c.now, sleep: c.sleep },
    );
    expect(ev.passed).toBe(false);
    expect(ev.actual).toMatch(/green for only \d+ms of the required 2000ms/);
  });

  it("fails fast once when a step failed, and blocks an unconfirmed stability window", async () => {
    const c = clock();
    let calls = 0;
    const red = await runPolled(
      async () => {
        calls++;
        return { passed: false, expected: "row", actual: "none" };
      },
      { timeoutMs: 60_000 },
      { now: c.now, sleep: c.sleep, failedStep: "save" },
    );
    expect(calls).toBe(1);
    expect(red.actual).toContain(
      'step "save" failed; evaluated once without polling',
    );
    const green = await runPolled(
      async () => ({ passed: true, expected: "absent", actual: "absent" }),
      { timeoutMs: 60_000, stableMs: 5000 },
      { now: c.now, sleep: c.sleep, failedStep: "save" },
    );
    expect(green).toMatchObject({ passed: false, skipped: true });
    const optedOut = await runPolled(
      async () => ({ passed: false, expected: "x", actual: "y" }),
      { timeoutMs: 2000, everyMs: 1000, failFastOnStepFailure: false },
      { now: c.now, sleep: c.sleep, failedStep: "save" },
    );
    expect(optedOut.attempts).toBe(3);
  });

  it("turns thrown errors into red samples and stops on permanent ones", async () => {
    const c = clock();
    let calls = 0;
    const transient = await runPolled(
      async () => {
        calls++;
        throw new Error("ECONNREFUSED");
      },
      { timeoutMs: 2000, everyMs: 1000 },
      { now: c.now, sleep: c.sleep },
    );
    expect(transient).toMatchObject({ passed: false, attempts: 3 });
    expect(transient.actual).toContain("error: ECONNREFUSED");
    calls = 0;
    const permanent = await runPolled(
      async () => {
        calls++;
        throw Object.assign(new Error("unknown datasource"), {
          permanent: true,
        });
      },
      { timeoutMs: 60_000 },
      { now: c.now, sleep: c.sleep },
    );
    expect(calls).toBe(1);
    expect(permanent.actual).toContain("not retried");
  });

  it("wraps any verifier: a polled text outcome records attempts in its raw evidence", async () => {
    const backend = new MockBrowserBackend();
    backend.setPageText("Saving…");
    setTimeout(() => backend.setPageText("Saved"), 120);
    const ev = await evaluateOne(
      {
        text: { contains: "Saved" },
        poll: { timeoutMs: 3000, everyMs: 50 },
      },
      {},
      backend,
    );
    expect(ev.passed).toBe(true);
    expect(ev.attempts).toBeGreaterThan(1);
    expect(ev.raw).toMatchObject({ kind: "text", attempts: expect.any(Array) });
  });
});

/* ----- http verifier against a local JSON API ----- */

let server: Server;
let baseUrl: string;
/** A second origin: where a spliced URL or a redirect could leak credentials. */
let other: Server;
let otherBase: string;
const otherSeen: Array<{ path: string; headers: Record<string, unknown> }> = [];
const seen: Array<{
  method: string;
  path: string;
  headers: Record<string, unknown>;
  body: string;
}> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/ready")
        return res.end(JSON.stringify({ ready: true, workers: 3 }));
      if (req.url === "/private") {
        res.statusCode =
          req.headers.authorization === "Bearer t0ken" ? 200 : 403;
        return res.end(JSON.stringify({ ok: res.statusCode === 200 }));
      }
      if (req.url === "/text") {
        res.setHeader("content-type", "text/plain");
        return res.end("plain body");
      }
      if (req.method === "POST" && req.url === "/echo") return res.end(body);
      if (req.url === "/redirect-home") {
        res.statusCode = 302;
        res.setHeader("location", "/private");
        return res.end();
      }
      if (req.url === "/redirect-away") {
        res.statusCode = 302;
        res.setHeader("location", `${otherBase}/landing`);
        return res.end();
      }
      if (req.url === "/post-away") {
        res.statusCode = 307;
        res.setHeader("location", `${otherBase}/landing`);
        return res.end();
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "nope" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  other = createServer((req, res) => {
    otherSeen.push({ path: req.url ?? "", headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ landed: true }));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => other.close(resolve));
});

function httpCtx(): VerifierContext {
  return {
    baseUrl,
    datasources: resolveEnvironmentDatasources(
      DatasourcesConfigSchema.parse({
        api: {
          kind: "http",
          baseUrl,
          headers: { "x-tenant": "demo" },
          auth: { bearer: "${secrets.API_TOKEN}" },
        },
      }),
      undefined,
    ),
    childEnv: { API_TOKEN: "t0ken" },
  };
}

describe("http verifier", () => {
  it("checks status and JSON paths through a datasource with auth headers", async () => {
    const ev = await evaluateOne(
      {
        http: {
          source: "api",
          url: "/private",
          expect: { status: 200, json: { ok: true } },
        },
      },
      httpCtx(),
    );
    expect(ev).toMatchObject({ passed: true, actual: "status 200" });
    expect(seen.at(-1)?.headers).toMatchObject({
      authorization: "Bearer t0ken",
      "x-tenant": "demo",
    });
    expect(JSON.stringify(ev.raw)).not.toContain("t0ken");
    expect(ev.raw).toMatchObject({
      kind: "http",
      source: { name: "api", kind: "http" },
      request: { method: "GET", url: `${baseUrl}/private` },
      observed: { status: 200, body: { ok: true } },
    });
  });

  it("defaults to 2xx, resolves relative URLs against baseUrl, splices captures into the body", async () => {
    const ctx = { ...httpCtx(), captures: { order: { id: 42 } } };
    const ready = await evaluateOne(
      {
        http: { url: "/ready", expect: { json: { workers: { atLeast: 2 } } } },
      },
      ctx,
    );
    expect(ready.passed).toBe(true);
    const echoed = await evaluateOne(
      {
        http: {
          url: `${baseUrl}/echo`,
          method: "POST",
          body: {
            orderId: "${captures.order.id}",
            note: "id ${captures.order.id}",
          },
          assign: "echo",
          expect: { json: { orderId: 42, note: "id 42" } },
        },
      },
      ctx,
    );
    expect(echoed.passed).toBe(true);
    expect(ctx.captures).toMatchObject({
      echo: { status: 200, body: { orderId: 42 } },
    });
    const missing = await evaluateOne({ http: { url: "/gone" } }, ctx);
    expect(missing).toMatchObject({ passed: false, actual: "status 404" });
    const notJson = await evaluateOne(
      { http: { url: "/text", expect: { json: { a: 1 } } } },
      ctx,
    );
    expect(notJson.actual).toContain("non-JSON body: plain body");
    const anonymous = await evaluateOne(
      { http: { url: "/private", expect: { status: { in: [401, 403] } } } },
      ctx,
    );
    expect(anonymous.passed).toBe(true);
  });
});

describe("http verifier: datasource credentials stay on the datasource origin", () => {
  it("refuses an absolute URL (written or spliced from captures) on another origin, at once", async () => {
    otherSeen.length = 0;
    const ctx = {
      ...httpCtx(),
      captures: { next: `${otherBase}/from-capture` },
    };
    const refused = await evaluateOne(
      {
        http: { source: "api", url: "${captures.next}" },
        poll: { timeoutMs: 3000, everyMs: 50 },
      },
      ctx,
    );
    expect(refused).toMatchObject({ passed: false, attempts: 1 });
    expect(refused.actual).toContain("must stay on baseUrl's origin");
    expect(refused.actual).toContain("not retried");
    expect(refused.raw).toMatchObject({
      request: { url: `${otherBase}/from-capture` },
    });
    expect(otherSeen).toEqual([]);
    // The same origin, written absolute, is fine.
    const same = await evaluateOne(
      { http: { source: "api", url: `${baseUrl}/private` } },
      ctx,
    );
    expect(same).toMatchObject({ passed: true });
  });

  it("keeps credentials on same-origin redirects and drops them on a cross-origin hop", async () => {
    otherSeen.length = 0;
    const home = await evaluateOne(
      {
        http: {
          source: "api",
          url: "/redirect-home",
          expect: { status: 200, json: { ok: true } },
        },
      },
      httpCtx(),
    );
    expect(home.passed).toBe(true);
    const away = await evaluateOne(
      {
        http: {
          source: "api",
          url: "/redirect-away",
          expect: { json: { landed: true } },
        },
      },
      httpCtx(),
    );
    expect(away.passed).toBe(true);
    expect(otherSeen).toHaveLength(1);
    expect(otherSeen[0]!.headers["authorization"]).toBeUndefined();
    expect(otherSeen[0]!.headers["x-tenant"]).toBeUndefined();
    // A body is never re-sent to another origin: the 307 comes back as-is.
    const posted = await evaluateOne(
      {
        http: {
          source: "api",
          url: "/post-away",
          method: "POST",
          body: { secret: "payload" },
          expect: { status: 307 },
        },
      },
      httpCtx(),
    );
    expect(posted.passed).toBe(true);
    expect(otherSeen).toHaveLength(1);
  });
});

/* ----- value verifier ----- */

describe("value verifier", () => {
  it("asserts on eval/request/capture values with typed whole placeholders", async () => {
    const ctx: VerifierContext = {
      evals: {
        finalState: { value: { blankRowCount: 0, rows: [{ name: "Acme" }] } },
      },
      responses: { save: { status: 200, body: { id: "r-1", saved: true } } },
      captures: { table: { rowCount: 3 } },
      runStartedAt: "2026-10-02T00:00:00.000Z",
    };
    const ev = await evaluateOne(
      {
        value: {
          actual: "${evals.finalState.value}",
          expect: { blankRowCount: 0, "rows[*].name": { contains: "Acme" } },
        },
      },
      ctx,
    );
    expect(ev.passed).toBe(true);
    expect(ev.raw).toMatchObject({
      kind: "value",
      request: { actual: "${evals.finalState.value}" },
      observed: { value: { blankRowCount: 0 } },
    });
    expect(
      (
        await evaluateOne(
          {
            value: {
              actual: {
                saved: "${requests.save.body.saved}",
                rows: "${captures.table.rowCount}",
                since: "${run.startedAt}",
              },
              expect: {
                saved: true,
                rows: { atLeast: 3 },
                since: { matches: "^2026-10-02" },
              },
            },
          },
          ctx,
        )
      ).passed,
    ).toBe(true);
    const failed = await evaluateOne(
      { value: { actual: "${requests.save.status}", expect: { $: 201 } } },
      ctx,
    );
    expect(failed).toMatchObject({ passed: false, actual: "$=200" });
  });

  it("resolves runtime references in matcher operands", async () => {
    const ctx: VerifierContext = {
      captures: { row: { rowCount: 1, rows: [{ SKU: "FX-1", Stock: "5" }] } },
      fixtureOutputs: { product: { sku: "FX-1", stock: 5 } },
    };
    const ev = await evaluateOne(
      {
        value: {
          actual: "${captures.row}",
          expect: {
            "rows[0].SKU": "${fixtures.product.sku}",
            // embedded in text: rendered as text
            "rows[*].SKU": { each: { matches: "^${fixtures.product.sku}$" } },
          },
        },
      },
      ctx,
    );
    expect(ev.passed).toBe(true);
    const missing = await evaluateOne(
      {
        value: {
          actual: "${captures.row}",
          expect: { "rows[0].SKU": "${fixtures.ghost.sku}" },
        },
      },
      ctx,
    );
    expect(missing).toMatchObject({
      passed: false,
      actual: "unresolved ${fixtures.ghost.sku}",
    });
  });

  it("reads JSON files and fails (without polling) on an unresolved reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-value-"));
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify({ recovered: true, attempts: 2 }),
    );
    const fromFile = await evaluateOne(
      {
        value: {
          file: "./result.json",
          expect: { recovered: true, attempts: { atMost: 3 } },
        },
      },
      { specDir: dir },
    );
    expect(fromFile.passed).toBe(true);
    const started = Date.now();
    const unresolved = await evaluateOne(
      {
        value: { actual: "${captures.nope}", expect: { $: 1 } },
        poll: { timeoutMs: 5000 },
      },
      {},
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(unresolved.actual).toContain("unresolved ${captures.nope}");
  });
});

/* ----- network: body, count, assign ----- */

describe("network verifier: body, count, assign", () => {
  const entries = [
    {
      method: "POST",
      url: "http://app.test/api/export",
      status: 200,
      postData: JSON.stringify({
        groupId: "g1",
        connectionId: "c9",
        options: { format: "xlsx" },
      }),
      startedAt: "2026-10-02T10:00:01.000Z",
    },
    {
      method: "POST",
      url: "http://app.test/api/export",
      status: 500,
      postData: JSON.stringify({ groupId: "g2" }),
      timestamp: Date.parse("2026-10-02T10:00:05.000Z"),
    },
    { method: "GET", url: "http://app.test/api/export/status", status: 200 },
  ];

  it("matches a request body subset (refs resolved) and counts matches", async () => {
    const ctx: VerifierContext = {
      networkEntries: entries,
      captures: { conn: "c9" },
    };
    expect(
      (
        await evaluateOne(
          {
            network: {
              method: "POST",
              urlContains: "/api/export",
              status: { equals: 200 },
              body: {
                json: { groupId: "g1", connectionId: "${captures.conn}" },
              },
            },
          },
          ctx,
        )
      ).passed,
    ).toBe(true);
    const exact = await evaluateOne(
      {
        network: {
          method: "POST",
          urlContains: "/api/export",
          body: { json: { groupId: "g1" }, match: "exact" },
        },
      },
      ctx,
    );
    expect(exact.passed).toBe(false);
    expect(exact.actual).toContain("none had the expected body");
    const counted = await evaluateOne(
      { network: { method: "POST", urlContains: "/api/export", count: 2 } },
      ctx,
    );
    expect(counted.passed).toBe(true);
    const none = await evaluateOne(
      { network: { method: "DELETE", urlContains: "/api/export", count: 0 } },
      ctx,
    );
    expect(none.passed).toBe(true);
  });

  it("fails at once, without polling, on an unresolved body reference", async () => {
    const started = Date.now();
    const ev = await evaluateOne(
      {
        network: {
          method: "POST",
          urlContains: "/api/export",
          body: { json: { connectionId: "${captures.typo}" } },
        },
        poll: { timeoutMs: 3000, everyMs: 50 },
      },
      { networkEntries: entries, captures: { conn: "c9" } },
    );
    expect(ev.passed).toBe(false);
    expect(ev.actual).toBe("unresolved ${captures.typo}");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("assigns the last match for ${network.<name>.at} in later outcomes", async () => {
    const ctx: VerifierContext = { networkEntries: entries };
    const [assigned, later] = await evaluateOutcomes(
      [
        outcome({
          id: "export_requested",
          description: "an export was requested",
          verify: {
            network: {
              method: "POST",
              urlContains: "/api/export",
              assign: "exportCall",
            },
          },
        }),
        outcome({
          id: "export_after_start",
          description: "the export happened after the first request",
          verify: {
            value: {
              actual: {
                last: "${network.exportCall.at}",
                first: "${network.exportCall.firstAt}",
                n: "${network.exportCall.count}",
              },
              expect: {
                last: "2026-10-02T10:00:05.000Z",
                first: "2026-10-02T10:00:01.000Z",
                n: 2,
              },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx,
    );
    expect(assigned!.evaluation.passed).toBe(true);
    expect(ctx.networkAssigns?.["exportCall"]).toMatchObject({
      count: 2,
      status: 500,
      body: { groupId: "g2" },
    });
    expect(later!.evaluation.passed).toBe(true);
  });
});
