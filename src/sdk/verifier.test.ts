import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, expectTypeOf, it } from "vitest";
import { MockBrowserBackend } from "../adapters/mock/MockBrowserBackend";
import { runSpec } from "../core/runner/Runner";
import {
  evaluateScript,
  type ScriptVerifierContext,
} from "../core/runner/verifiers/script";
import {
  defineVerifier,
  describeFixtures,
  inspectVerifier,
  VerifierFailure,
  z,
} from "./verifier.js";
import { readWorkbook } from "./workbook.js";
import { buildXlsxFixture } from "../testing/xlsxFixture";
import { z as z4 } from "zod/v4";

type Result = {
  ok: boolean;
  evidence?: unknown;
  message?: string;
  attempts?: number;
  polledMs?: number;
  sdk?: number;
};

const run = async (
  verify: (ctx: unknown) => Promise<unknown>,
  ctx: Record<string, unknown> = {},
): Promise<Result> => (await verify(ctx)) as Result;

describe("defineVerifier: fixtures contract", () => {
  const Orders = defineVerifier({
    description: "orders",
    fixtures: z.object({
      orderId: z.string(),
      count: z.number().int().default(1),
      strictMode: z.boolean().optional(),
      since: z.date().optional(),
      owners: z.array(z.string()).default([]),
      expected: z.object({ status: z.string() }).optional(),
      retries: z.number().optional(),
    }),
    run: (ctx) => ctx.result.ok({ fixtures: ctx.fixtures }),
  });

  it("types ctx.fixtures from the schema", () => {
    defineVerifier({
      fixtures: z.object({ a: z.string(), n: z.number().default(2) }),
      run(ctx) {
        expectTypeOf(ctx.fixtures.a).toEqualTypeOf<string>();
        expectTypeOf(ctx.fixtures.n).toEqualTypeOf<number>();
        return true;
      },
    });
  });

  it("parses, applies defaults and coerces strings to the declared types", async () => {
    const result = await run(Orders, {
      fixtures: {
        orderId: "o-1",
        count: "3",
        strictMode: "TRUE",
        since: "2026-01-02T03:04:05.000Z",
        owners: '["a","b"]',
        expected: { status: "done" },
        retries: "",
      },
    });
    expect(result.ok).toBe(true);
    const fixtures = (result.evidence as { fixtures: Record<string, unknown> })
      .fixtures;
    expect(fixtures).toMatchObject({
      orderId: "o-1",
      count: 3,
      strictMode: true,
      owners: ["a", "b"],
      expected: { status: "done" },
    });
    expect(fixtures["since"]).toEqual(new Date("2026-01-02T03:04:05.000Z"));
    expect(fixtures).not.toHaveProperty("retries");
  });

  it("fails with every issue — wrong type, missing key, unknown key — without values", async () => {
    const result = await run(Orders, {
      fixtures: { count: "many", ordreId: "secret-value-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.sdk).toBe(1);
    expect(result.message).toContain("fixtures do not match");
    expect(result.message).toContain("unknown fixture key(s): ordreId");
    expect(result.message).toContain("orderId: Required");
    expect(result.message).toContain("count: Expected number");
    const evidence = result.evidence as { issues: Array<{ path: string }> };
    expect(evidence.issues.map((i) => i.path).toSorted()).toEqual([
      "count",
      "orderId",
      "ordreId",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-value-1");
  });

  it("accepts extra keys when the schema opts in with .passthrough()", async () => {
    const verify = defineVerifier({
      fixtures: z.object({ a: z.string() }).passthrough(),
      run: (ctx) => ctx.result.ok(ctx.fixtures),
    });
    expect((await run(verify, { fixtures: { a: "x", extra: "y" } })).ok).toBe(
      true,
    );
  });

  it("passes fixtures through unvalidated without a schema", async () => {
    const verify = defineVerifier({
      run: (ctx) => ctx.result.ok(ctx.fixtures),
    });
    const result = await run(verify, { fixtures: { anything: "1" } });
    expect(result).toMatchObject({ ok: true, evidence: { anything: "1" } });
  });

  it("describes the contract (what --load reports)", () => {
    expect(inspectVerifier(Orders)).toEqual({
      protocol: 1,
      description: "orders",
      fixtures: {
        strict: true,
        dynamic: false,
        keys: [
          { name: "orderId", type: "string", required: true },
          { name: "count", type: "number", required: false, default: 1 },
          { name: "strictMode", type: "boolean", required: false },
          { name: "since", type: "date", required: false },
          { name: "owners", type: "string[]", required: false, default: [] },
          { name: "expected", type: "object", required: false },
          { name: "retries", type: "number", required: false },
        ],
      },
    });
    expect(inspectVerifier(() => true)).toBeNull();
    expect(
      describeFixtures(z.object({ k: z.enum(["a", "b"]).describe("pick") })),
    ).toEqual({
      strict: true,
      dynamic: false,
      keys: [
        {
          name: "k",
          type: "enum",
          required: true,
          description: "pick",
          values: ["a", "b"],
        },
      ],
    });
  });

  it("rejects a definition without run or with a non-zod fixtures value", () => {
    expect(() => defineVerifier({} as never)).toThrow(/run\(ctx\)/);
    expect(() =>
      defineVerifier({ fixtures: { a: 1 } as never, run: () => true }),
    ).toThrow(/zod schema/);
  });

  it("refuses zod v4 schemas instead of silently skipping coercion and strictness", () => {
    expect(() =>
      defineVerifier({
        fixtures: z4.object({ count: z4.number() }) as never,
        run: () => true,
      }),
    ).toThrow(/zod v4 schema; build it with the z re-exported/);
  });

  it("never echoes a rejected enum value", async () => {
    const verify = defineVerifier({
      fixtures: z.object({ mode: z.enum(["fast", "slow"]) }),
      run: () => true,
    });
    const result = await run(verify, { fixtures: { mode: "hunter2-secret" } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      "mode: Invalid enum value. Expected 'fast' | 'slow'",
    );
    expect(JSON.stringify(result)).not.toContain("hunter2-secret");
  });

  it("coerces and rejects unknown keys across an intersection of objects", async () => {
    const verify = defineVerifier({
      fixtures: z
        .object({ orderId: z.string() })
        .and(z.object({ count: z.number(), note: z.any() })),
      run: (ctx) => ctx.result.ok(ctx.fixtures),
    });
    expect(
      await run(verify, { fixtures: { orderId: "o-1", count: "3" } }),
    ).toMatchObject({
      ok: true,
      evidence: { orderId: "o-1", count: 3 },
    });
    const typo = await run(verify, {
      fixtures: { orderId: "o-1", count: "3", cuont: "4" },
    });
    expect(typo.ok).toBe(false);
    expect(typo.message).toContain("unknown fixture key(s): cuont");
    expect(inspectVerifier(verify)?.fixtures).toEqual({
      strict: true,
      dynamic: false,
      keys: [
        { name: "orderId", type: "string", required: true },
        { name: "count", type: "number", required: true },
        // A key whose schema accepts undefined may be left out.
        { name: "note", type: "any", required: false },
      ],
    });
  });
});

describe("defineVerifier: results", () => {
  it("maps ctx.result.fail, ctx.fail, VerifierFailure and booleans", async () => {
    const viaResult = defineVerifier({
      run: (ctx) => ctx.result.fail("count was 0", { count: 0 }),
    });
    expect(await run(viaResult)).toEqual({
      sdk: 1,
      ok: false,
      message: "count was 0",
      evidence: { message: "count was 0", count: 0 },
    });
    const viaThrow = defineVerifier({
      run(ctx) {
        return ctx.fail("nope", ["a"]);
      },
    });
    expect(await run(viaThrow)).toMatchObject({
      ok: false,
      message: "nope",
      evidence: { message: "nope", details: ["a"] },
    });
    const viaClass = defineVerifier({
      run() {
        throw new VerifierFailure("bad state");
      },
    });
    expect(await run(viaClass)).toMatchObject({
      ok: false,
      message: "bad state",
    });
    const viaBool = defineVerifier({ run: () => true });
    expect(await run(viaBool)).toEqual({ sdk: 1, ok: true, evidence: null });
  });

  it("reports a run(ctx) still pending at the deadline instead of waiting for the kill", async () => {
    const verify = defineVerifier({
      run: () => new Promise<never>(() => {}),
    });
    const started = Date.now();
    const result = await run(verify, {
      runtime: { protocol: 1, startedAtMs: Date.now(), timeoutMs: 1_000 },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "run(ctx) was still running at the verifier deadline (script.timeoutMs 1000ms)",
      ),
      evidence: { reason: "deadline" },
    });
  });

  it("fails clearly when run returns nothing, and rethrows real errors", async () => {
    const empty = defineVerifier({ run: () => undefined as never });
    expect((await run(empty)).message).toContain(
      "run(ctx) must return ctx.result.ok",
    );
    const crash = defineVerifier({
      run() {
        throw new TypeError("boom");
      },
    });
    await expect(run(crash)).rejects.toThrow("boom");
  });
});

const progressCtx = () => {
  const lines: string[] = [];
  return { lines, ctx: { progress: (m: string) => lines.push(m) } };
};

describe("ctx.poll", () => {
  it("polls until the condition holds and reports attempts and polledMs", async () => {
    const { lines, ctx } = progressCtx();
    const verify = defineVerifier({
      async run(c) {
        let n = 0;
        const value = await c.poll(() => ++n, {
          until: (v) => v >= 3,
          every: 5,
          within: 2_000,
          describe: (v) => `count=${v}`,
          want: "3",
        });
        return c.result.ok({ value });
      },
    });
    const result = await run(verify, ctx);
    expect(result).toMatchObject({
      ok: true,
      evidence: { value: 3 },
      attempts: 3,
    });
    expect(typeof result.polledMs).toBe("number");
    expect(lines[0]).toMatch(/^poll attempt 1\/\d+: count=1 \(want 3\)$/);
    expect(lines).toHaveLength(3);
  });

  it("times out with the last observation and a bounded attempt log", async () => {
    const verify = defineVerifier({
      async run(c) {
        await c.poll(() => Array.from({ length: 30 }, (_, i) => ({ i })), {
          until: () => false,
          every: 1,
          within: 60,
          label: "rows",
        });
        return true;
      },
    });
    const result = await run(verify);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^rows timed out after \d+ms \(\d+ attempt/);
    const evidence = result.evidence as {
      reason: string;
      observed: { rows: unknown[]; total: number; truncated: boolean };
      attempts: Array<{ at: string; ok: boolean; summary: string }>;
      attemptCount: number;
    };
    expect(evidence.reason).toBe("timeout");
    expect(evidence.observed).toMatchObject({ total: 30, truncated: true });
    expect(evidence.observed.rows).toHaveLength(20);
    expect(evidence.attempts.length).toBeLessThanOrEqual(20);
    expect(evidence.attempts[0]).toMatchObject({ ok: false });
    expect(result.attempts).toBe(evidence.attemptCount);
  });

  it("requires stableFor to hold continuously; a red sample restarts the window", async () => {
    const samples = [true, false, true, true, true, true, true, true];
    let i = 0;
    const seen: boolean[] = [];
    const verify = defineVerifier({
      async run(c) {
        await c.poll(
          () => {
            const v = samples[Math.min(i++, samples.length - 1)]!;
            seen.push(v);
            return v;
          },
          { every: 50, stableFor: 120, within: 2_000 },
        );
        return true;
      },
    });
    const result = await run(verify);
    expect(result.ok).toBe(true);
    // The first green alone never passes, the red resets, then ≥3 greens span 120ms.
    expect(seen.slice(0, 2)).toEqual([true, false]);
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  it("stops at once on failWhen and treats thrown attempts as not-yet", async () => {
    let n = 0;
    const verify = defineVerifier({
      async run(c) {
        await c.poll(
          () => {
            n++;
            if (n === 1) throw new Error("connection refused");
            return { status: n === 2 ? "RUNNING" : "FAILED" };
          },
          {
            until: (w) => w.status === "COMPLETED",
            failWhen: (w) => w.status === "FAILED" && "workflow FAILED",
            every: 1,
            within: 2_000,
          },
        );
        return true;
      },
    });
    const result = await run(verify);
    expect(result).toMatchObject({
      ok: false,
      message: "poll failed: workflow FAILED",
      attempts: 3,
    });
    const attempts = (
      result.evidence as { attempts: Array<{ summary: string }> }
    ).attempts;
    expect(attempts[0]!.summary).toBe("error: connection refused");
  });

  it("ends the poll at once on ctx.fail, network.findOne or a nested poll's failure", async () => {
    let n = 0;
    const viaFail = defineVerifier({
      async run(c) {
        await c.poll(
          () => {
            n++;
            return c.fail("workflow terminated: FAILED", { status: "FAILED" });
          },
          { every: 50, within: 5_000 },
        );
        return true;
      },
    });
    const started = Date.now();
    const result = await run(viaFail);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(n).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      message: "workflow terminated: FAILED",
      evidence: { status: "FAILED" },
      attempts: 1,
    });
    const viaFindOne = defineVerifier({
      async run(c) {
        await c.poll(() => c.network.findOne({ method: "POST" }), {
          every: 50,
          within: 5_000,
        });
        return true;
      },
    });
    expect((await run(viaFindOne)).message).toMatch(
      /^network: no request matched POST/,
    );
    const nested = defineVerifier({
      async run(c) {
        await c.poll(
          () => c.poll(() => false, { within: 60, every: 50, label: "inner" }),
          { every: 50, within: 5_000, label: "outer" },
        );
        return true;
      },
    });
    const nestedResult = await run(nested);
    expect(nestedResult.message).toMatch(/^inner timed out/);
    // One outer attempt carrying the inner poll's own attempts — no retry.
    expect(nestedResult.attempts).toBeLessThanOrEqual(1 + 3);
  });

  it("treats a throwing until() (a document not there yet) as not-yet", async () => {
    let n = 0;
    const verify = defineVerifier({
      async run(c) {
        const doc = await c.poll(
          () => (++n < 3 ? null : { status: "shipped" }),
          {
            until: (d) => (d as { status: string }).status === "shipped",
            every: 50,
            within: 2_000,
          },
        );
        return c.result.ok(doc);
      },
    });
    expect(await run(verify)).toMatchObject({ ok: true, attempts: 3 });
  });

  it("clamps every to 50ms so every: 0 cannot spin", async () => {
    const { lines, ctx } = progressCtx();
    const verify = defineVerifier({
      async run(c) {
        await c.poll(() => false, { every: 0, within: 200 });
        return true;
      },
    });
    const result = await run(verify, ctx);
    expect(result.attempts).toBeLessThanOrEqual(6);
    expect(lines[0]).toMatch(/^poll attempt 1\/5: /);
  });

  it("abandons an attempt still running at within and keeps the last observation", async () => {
    let attemptSignal: AbortSignal | undefined;
    const verify = defineVerifier({
      async run(c) {
        await c.poll(
          ({
            attempt,
            signal,
          }): { count: number } | Promise<{ count: number }> => {
            if (attempt === 1) return { count: 0 };
            attemptSignal = signal;
            return new Promise(() => {}); // a hung docker exec / fetch
          },
          {
            until: (r) => r.count === 1,
            every: 50,
            within: 1_500,
            describe: (r) => `count=${r.count}`,
            want: "1",
          },
        );
        return true;
      },
    });
    const started = Date.now();
    const result = await run(verify);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_400);
    expect(took).toBeLessThan(2_200);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /^poll timed out after \d+ms \(2 attempt\(s\)\): attempt 2 was still running after \d+ms; last count=0 \(want 1\)$/,
    );
    expect(result.evidence).toMatchObject({
      reason: "timeout",
      observed: { count: 0 },
      attempts: [
        { ok: false, summary: "count=0" },
        { ok: false, summary: expect.stringMatching(/abandoned$/) },
      ],
    });
    expect(attemptSignal?.aborted).toBe(true);
  });

  it("gives an attempt started at the edge of within max(every, 1s) to answer", async () => {
    const verify = defineVerifier({
      async run(c) {
        const value = await c.poll(
          async ({ attempt }) => {
            if (attempt < 3) return 0;
            await new Promise((r) => setTimeout(r, 300));
            return 1;
          },
          { every: 50, within: 100 },
        );
        return c.result.ok({ value });
      },
    });
    expect(await run(verify)).toMatchObject({
      ok: true,
      evidence: { value: 1 },
    });
  });

  it("abandons a hung attempt at the deadline and still reports evidence", async () => {
    const verify = defineVerifier({
      async run(c) {
        await c.poll(
          ({ attempt }) => (attempt === 1 ? "first" : new Promise(() => {})),
          { every: 50, within: 60_000, until: () => false },
        );
        return true;
      },
    });
    const started = Date.now();
    const result = await run(verify, {
      runtime: { protocol: 1, startedAtMs: Date.now(), timeoutMs: 1_000 },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /stopped: verifier deadline reached|timed out after/,
    );
    expect(result.evidence).toMatchObject({ observed: "first" });
  });

  it("fails fast when a step failed and the poll opts in", async () => {
    let called = false;
    const verify = defineVerifier({
      async run(c) {
        await c.poll(() => (called = true), { failFastOnStepFailure: true });
        return true;
      },
    });
    const result = await run(verify, {
      run: { failedStep: "submit_form", lastSuccessfulStep: "open" },
    });
    expect(called).toBe(false);
    expect(result.message).toContain('step "submit_form" failed');
  });

  it("never polls past the deadline: the budget is capped and the signal aborts", async () => {
    const verify = defineVerifier({
      async run(c) {
        expect(c.deadline).toBeGreaterThan(Date.now());
        expect(c.remainingMs()).toBeLessThanOrEqual(1_000);
        await c.poll(() => false, { every: 50, within: 60_000 });
        return true;
      },
    });
    const started = Date.now();
    const result = await run(verify, {
      runtime: { protocol: 1, startedAtMs: Date.now(), timeoutMs: 1_000 },
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timed out|stopped: verifier deadline/);
  });
});

describe("ctx.network", () => {
  const entries = [
    {
      method: "GET",
      url: "http://app.test/api/orders?page=1",
      status: 200,
      timestamp: 1_000,
    },
    {
      method: "PATCH",
      url: "http://app.test/api/orders/7",
      status: 200,
      timestamp: 2_000,
      postData: '{"status":"shipped"}',
    },
    {
      method: "PATCH",
      url: "http://app.test/api/orders/8",
      status: 500,
      timestamp: 3_000,
    },
  ];

  it("finds, finds one (unique or fail with candidates) and parses bodies", async () => {
    const verify = defineVerifier({
      run(c) {
        const patches = c.network.find({
          method: "patch",
          url: "/api/orders/",
        });
        const ok = c.network.findOne({
          method: "PATCH",
          status: { atLeast: 200, below: 300 },
        });
        const recent = c.network.find({ since: 2_500 });
        const byPath = c.network.find({ path: "/api/orders" });
        return c.result.ok({
          patches: patches.length,
          ok: c.network.json(ok),
          recent: recent.length,
          byPath: byPath.length,
          regex: c.network.find({ url: /orders\/\d+$/ }).length,
        });
      },
    });
    expect(await run(verify, { networkEntries: entries })).toMatchObject({
      ok: true,
      evidence: {
        patches: 2,
        ok: { status: "shipped" },
        recent: 1,
        byPath: 1,
        regex: 2,
      },
    });

    const ambiguous = defineVerifier({
      run(c) {
        c.network.findOne({ method: "PATCH" });
        return true;
      },
    });
    const result = await run(ambiguous, { networkEntries: entries });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "network: 2 requests matched PATCH; expected exactly one",
    );
    expect(
      (result.evidence as { candidates: unknown[] }).candidates,
    ).toHaveLength(2);
  });
});

describe("ctx.xlsx", () => {
  it("reads sheets as rows, cells and header records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-xlsx-"));
    try {
      await writeFile(
        join(dir, "book.xlsx"),
        buildXlsx({
          Workers: [
            ["Name", "Country", "Age"],
            ["Ada", "CH", "36"],
            [],
            ["Lin", "", "41"],
          ],
        }),
      );
      const verify = defineVerifier({
        async run(c) {
          const book = await c.xlsx("book.xlsx");
          const sheet = book.sheet("Workers")!;
          return c.result.ok({
            names: book.sheetNames,
            b2: sheet.cell("b2"),
            rows: sheet.rows.length,
            records: sheet.records(),
          });
        },
      });
      const result = await run(verify, { specDir: dir });
      expect(result).toMatchObject({
        ok: true,
        evidence: {
          names: ["Workers"],
          b2: "CH",
          rows: 4,
          records: [
            { Name: "Ada", Country: "CH", Age: "36" },
            { Name: "Lin", Country: "", Age: "41" },
          ],
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ctx.xlsx workbook model (F17)", () => {
  it("exposes header columns, number formats and validation formulas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-xlsx-model-"));
    try {
      await writeFile(
        join(dir, "template.xlsx"),
        buildXlsxFixture(
          [
            {
              name: "Import Template",
              rows: [
                ["Name *", "Email"],
                ["Staff_Name", "Staff_Email"],
                ["", { s: 1 }],
              ],
              validations: [
                {
                  type: "custom",
                  sqref: "B3:B100",
                  formula1: "COUNTIF($B$3:$B$100,B3)=1",
                },
              ],
            },
          ],
          { xfs: [0, 49] },
        ),
      );
      const verify = defineVerifier({
        async run(c) {
          const sheet = (await c.xlsx("template.xlsx")).sheet(
            "Import Template",
          )!;
          return c.result.ok({
            columns: sheet.columns({ keyRow: 2 }),
            emailFormat: sheet.numFmt("B3"),
            nameFormat: sheet.numFmt("A3"),
            validation: sheet.validations[0],
          });
        },
      });
      const result = await run(verify, { specDir: dir });
      expect(result).toMatchObject({
        ok: true,
        evidence: {
          columns: [
            { index: 0, letter: "A", label: "Name *", key: "Staff_Name" },
            { index: 1, letter: "B", label: "Email", key: "Staff_Email" },
          ],
          emailFormat: { id: 49, code: "@" },
          nameFormat: { id: 0, code: "General" },
          validation: {
            type: "custom",
            sqref: "B3:B100",
            formula1: "COUNTIF($B$3:$B$100,B3)=1",
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readWorkbook", () => {
  it("keeps an empty styled cell from swallowing the next cell's value", () => {
    const book = readWorkbook(
      buildXlsx({
        Sheet1: [
          ["", "B1 value", "C1"],
          ["A2", "", "C2"],
        ],
      }),
    );
    expect(book.sheets[0]!.rows).toEqual([
      ["", "B1 value", "C1"],
      ["A2", "", "C2"],
    ]);
    expect(book.sheets[0]!.cells.get("A1")).toBeUndefined();
    expect(() => readWorkbook(Buffer.from("not a zip"))).toThrow(/not a zip/);
  });

  it("refuses a sheet whose dense grid would be huge (one stray far-off cell)", () => {
    const sheet = (far: string) =>
      zip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>${far}</sheetData></worksheet>`,
      });
    const before = process.memoryUsage().rss;
    expect(() =>
      readWorkbook(
        sheet(
          `<row r="2000"><c r="XFD2000" t="inlineStr"><is><t>far</t></is></c></row>`,
        ),
      ),
    ).toThrow(
      /sheet "Data" spans 2000 rows × 16384 columns.*too sparse or too large/,
    );
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
    // A wide but shallow sheet is still read.
    const wide = readWorkbook(
      sheet(
        `<row r="2"><c r="XFD2" t="inlineStr"><is><t>far</t></is></c></row>`,
      ),
    );
    expect(wide.sheets[0]!.rows[1]![16383]).toBe("far");
    expect(wide.sheets[0]!.rows[0]!).toHaveLength(16384);
  });
});

describe("ctx.datasources without a channel", () => {
  it("rejects calls with a message that says why", async () => {
    const verify = defineVerifier({
      async run(c) {
        await c.datasources["app"]!["find"]!("orders", {});
        return true;
      },
    });
    await expect(run(verify)).rejects.toThrow(/no datasource channel/);
  });
});

describe("ctx.progress fallback", () => {
  it("appends to CAIRN_PROGRESS_FILE when the bootstrap gave no progress()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-progress-"));
    const file = join(dir, "p.txt");
    const previous = process.env["CAIRN_PROGRESS_FILE"];
    process.env["CAIRN_PROGRESS_FILE"] = file;
    try {
      const verify = defineVerifier({
        run(c) {
          c.progress("step\none");
          return true;
        },
      });
      await run(verify);
      expect(await readFile(file, "utf8")).toBe("step one\n");
    } finally {
      if (previous === undefined) delete process.env["CAIRN_PROGRESS_FILE"];
      else process.env["CAIRN_PROGRESS_FILE"] = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A minimal .xlsx (ZIP of XML parts) with one sheet per entry. */
function buildXlsx(sheets: Record<string, string[][]>): Buffer {
  const names = Object.keys(sheets);
  const shared: string[] = [];
  const files: Record<string, string> = {
    "xl/workbook.xml": `<workbook><sheets>${names
      .map(
        (n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${names
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
  };
  names.forEach((name, i) => {
    const rows = sheets[name]!.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
        if (value === "") return `<c r="${ref}" s="1"/>`;
        // Alternate shared and inline strings to cover both.
        if ((r + c) % 2 === 0) {
          shared.push(value);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
      });
      return `<row r="${r + 1}">${cells.join("")}</row>`;
    });
    files[`xl/worksheets/sheet${i + 1}.xml`] =
      `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
  });
  files["xl/sharedStrings.xml"] = `<sst>${shared
    .map((v) => `<si><t>${v}</t></si>`)
    .join("")}</sst>`;
  return zip(files);
}

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ------------------------------------------------------------------ */
/* through the runner: a node child, the SDK resolved by the bootstrap */
/* ------------------------------------------------------------------ */

const FULL_VERIFIER = `import { writeFileSync } from "node:fs";
import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";

type Reply = { status: number; body: { count: number } };

export default defineVerifier({
  description: "Every ctx feature",
  fixtures: z.object({
    orderId: z.string(),
    owners: z.array(z.string()),
    expected: z.object({ status: z.string(), count: z.number() }),
    threshold: z.number(),
    workbook: z.string(),
    marker: z.string().optional(),
  }),
  async run(ctx) {
    ctx.log("checking order", ctx.fixtures.orderId);
    ctx.progress("starting");
    const patch = ctx.network.findOne({
      method: "PATCH",
      path: "/api/orders/" + ctx.fixtures.orderId,
    });
    const docs = await ctx.datasources.db.find("orders", { orderId: ctx.fixtures.orderId }, { limit: 5 });
    const total = await ctx.datasources.db.count("orders", {});
    const reply: Reply = await ctx.poll(
      () => ctx.datasources.api.get("/status/" + ctx.fixtures.orderId),
      {
        until: (r: Reply) => r.body.count >= ctx.fixtures.threshold,
        every: 20,
        within: 10_000,
        describe: (r: Reply) => "count=" + r.body.count,
        want: ">=" + ctx.fixtures.threshold,
      },
    );
    const book = await ctx.xlsx(ctx.fixtures.workbook);
    if (ctx.fixtures.marker) writeFileSync(ctx.fixtures.marker, "ran");
    return ctx.result.ok({
      fixtures: ctx.fixtures,
      vars: ctx.vars,
      run: ctx.run,
      body: ctx.network.json(patch),
      docs,
      total,
      count: reply.body.count,
      evals: ctx.evals,
      requests: ctx.requests,
      captures: ctx.captures,
      fixturesOutputs: ctx.fixturesOutputs,
      artifact: ctx.artifacts.report?.relativePath,
      records: book.sheet("Workers")?.records(),
      deadline: typeof ctx.deadline,
      remaining: ctx.remainingMs() > 0,
      aborted: ctx.signal.aborted,
      datasources: Object.keys(ctx.datasources).sort(),
    });
  },
});
`;

function fakeMongoDriver() {
  const queries: unknown[] = [];
  class MongoClient {
    async connect() {}
    db() {
      return {
        command: async () => ({ ok: 1 }),
        collection: (name: string) => ({
          find: (filter: unknown, options: unknown) => {
            queries.push({ name, filter, options });
            return {
              toArray: async () => [{ orderId: "7", status: "shipped" }],
            };
          },
          countDocuments: async () => 42,
        }),
      };
    }
    async close() {}
  }
  return { queries, driver: { MongoClient } as never };
}

async function statusServer(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  let count = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, count: ++count }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("SDK verifier through the node script runner", () => {
  it("gives a typed verifier every ctx feature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-full-"));
    const api = await statusServer();
    try {
      await mkdir(join(dir, "verifiers"), { recursive: true });
      await writeFile(join(dir, "verifiers", "full.ts"), FULL_VERIFIER);
      await writeFile(
        join(dir, "book.xlsx"),
        buildXlsx({
          Workers: [
            ["Name", "Country"],
            ["Ada", "CH"],
          ],
        }),
      );
      const progressFile = join(dir, "outcome.progress");
      await writeFile(progressFile, "");
      const lines: string[] = [];
      const mongo = fakeMongoDriver();
      const runDir = join(dir, "runs", "demo-20261002-000000");
      const ctx: ScriptVerifierContext = {
        specDir: dir,
        runDir,
        vars: { region: "eu" },
        runInfo: {
          id: "demo-run",
          token: "tok123",
          startedAt: "2026-10-02T00:00:00.000Z",
          labels: { cohort: "a" },
        },
        failedStep: undefined,
        lastSuccessfulStep: "save",
        networkEntries: [
          { method: "GET", url: "http://app.test/api/orders/7", status: 200 },
          {
            method: "PATCH",
            url: "http://app.test/api/orders/7",
            status: 200,
            postData: '{"status":"shipped"}',
          },
        ],
        evals: { before: { value: 1 } },
        responses: { order: { status: 200, body: { id: "7" } } },
        captures: { total: "3" },
        fixtureOutputs: { order: { id: "7" } },
        artifacts: {
          report: {
            kind: "download",
            path: join(dir, "book.xlsx"),
            relativePath: "downloads/book.xlsx",
          },
        },
        datasources: {
          datasources: {
            api: { kind: "http", baseUrl: api.url },
            db: {
              kind: "mongo",
              uri: "mongodb://127.0.0.1:27017/app",
              database: "app",
              transport: "driver",
            },
          },
          disabled: [],
          errors: {},
        } as never,
        loadMongoDriver: async () => mongo.driver,
        childEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
        scriptRun: {
          progressFile,
          onOutputLine: (_stream, line) => lines.push(line),
        },
      };
      const evaluation = await evaluateScript(
        {
          script: {
            runtime: "node",
            file: "./verifiers/full.ts",
            timeoutMs: 30_000,
            fixtures: {
              orderId: "7",
              owners: ["ada", "lin"],
              expected: { status: "shipped", count: 1 },
              threshold: "3",
              workbook: "book.xlsx",
            },
          },
        },
        new MockBrowserBackend(),
        ctx,
      );
      expect(evaluation.passed, JSON.stringify(evaluation)).toBe(true);
      expect(evaluation.raw).toEqual({
        fixtures: {
          orderId: "7",
          owners: ["ada", "lin"],
          expected: { status: "shipped", count: 1 },
          threshold: 3,
          workbook: "book.xlsx",
        },
        vars: { region: "eu" },
        run: {
          id: "demo-run",
          token: "tok123",
          startedAt: "2026-10-02T00:00:00.000Z",
          labels: { cohort: "a" },
          failedStep: null,
          lastSuccessfulStep: "save",
          dir: runDir,
        },
        body: { status: "shipped" },
        docs: [{ orderId: "7", status: "shipped" }],
        total: 42,
        count: 3,
        evals: { before: { value: 1 } },
        requests: { order: { status: 200, body: { id: "7" } } },
        captures: { total: "3" },
        fixturesOutputs: { order: { id: "7" } },
        artifact: "downloads/book.xlsx",
        records: [{ Name: "Ada", Country: "CH" }],
        deadline: "number",
        remaining: true,
        aborted: false,
        datasources: ["api", "db"],
      });
      expect(evaluation.attempts).toBe(3);
      expect(typeof evaluation.polledMs).toBe("number");
      expect(mongo.queries[0]).toMatchObject({
        name: "orders",
        filter: { orderId: "7" },
        options: { limit: 5 },
      });
      const progress = (await readFile(progressFile, "utf8"))
        .trim()
        .split("\n");
      expect(progress[0]).toBe("starting");
      expect(progress[1]).toMatch(
        /^poll attempt 1\/\d+: count=1 \(want >=3\)$/,
      );
      expect(lines).toContain("[verifier] checking order 7");
      expect(
        lines.some((l) =>
          /^\[datasource\] db\.find ok \d+ms \(1 rows\)$/.test(l),
        ),
      ).toBe(true);
      expect(lines.some((l) => l.startsWith("[datasource] api.get ok"))).toBe(
        true,
      );
      // Connection details never reach the child or its output.
      expect(lines.join("\n")).not.toContain("mongodb://");
    } finally {
      await api.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports a fixture mismatch as the outcome's observed value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-mismatch-"));
    try {
      await writeFile(join(dir, "v.ts"), FULL_VERIFIER);
      const evaluation = await evaluateScript(
        {
          script: {
            runtime: "node",
            file: "./v.ts",
            fixtures: { orderId: "7", owners: "ada|lin", threshold: "x" },
          },
        },
        new MockBrowserBackend(),
        {
          specDir: dir,
          childEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
        },
      );
      expect(evaluation.passed).toBe(false);
      expect(evaluation.actual).toContain("fixtures do not match");
      expect(evaluation.actual).toContain(
        "owners: Expected array, received string",
      );
      expect(evaluation.actual).toContain("threshold: Expected number");
      expect(evaluation.actual).toContain("expected: Required");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("aborts ctx.signal on cancel and lets the verifier clean up before the kill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-cancel-"));
    try {
      const marker = join(dir, "cleaned-up.txt");
      await writeFile(
        join(dir, "slow.ts"),
        `import { writeFileSync } from "node:fs";
import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";
export default defineVerifier({
  fixtures: z.object({ marker: z.string() }),
  async run(ctx) {
    ctx.progress("ready");
    const keepAlive = setInterval(() => {}, 1_000);
    await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
    clearInterval(keepAlive);
    writeFileSync(ctx.fixtures.marker, String(ctx.signal.reason?.message));
    return ctx.result.fail("cancelled");
  },
});
`,
      );
      const progressFile = join(dir, "p.txt");
      await writeFile(progressFile, "");
      const controller = new AbortController();
      const pending = evaluateScript(
        {
          script: { runtime: "node", file: "./slow.ts", fixtures: { marker } },
        },
        new MockBrowserBackend(),
        {
          specDir: dir,
          childEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
          signal: controller.signal,
          scriptRun: { progressFile },
        },
      );
      const deadline = Date.now() + 20_000;
      while (!(await readFile(progressFile, "utf8")).includes("ready")) {
        if (Date.now() > deadline) throw new Error("verifier never started");
        await new Promise((r) => setTimeout(r, 25));
      }
      controller.abort();
      const evaluation = await pending;
      expect(evaluation.passed).toBe(false);
      expect(evaluation.actual).toContain("cancelled");
      expect(await readFile(marker, "utf8")).toBe(
        "verifier cancelled (SIGTERM)",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a verifier that gets defineVerifier through a helper module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-helper-"));
    try {
      await mkdir(join(dir, "support"), { recursive: true });
      await writeFile(
        join(dir, "support", "make.ts"),
        `import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";
export const make = (label: string) =>
  defineVerifier({
    fixtures: z.object({ count: z.number() }),
    run: (ctx) =>
      ctx.result.ok({
        label,
        count: ctx.fixtures.count,
        deadline: typeof ctx.deadline,
        requests: ctx.network.find().length,
      }),
  });
`,
      );
      await writeFile(
        join(dir, "via-helper.ts"),
        `import { make } from "./support/make.ts";\nexport default make("shared");\n`,
      );
      const evaluation = await evaluateScript(
        {
          script: {
            runtime: "node",
            file: "./via-helper.ts",
            fixtures: { count: "3" },
            timeoutMs: 20_000,
          },
        },
        new MockBrowserBackend(),
        {
          specDir: dir,
          childEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
          networkEntries: [
            { method: "GET", url: "http://app.test/", status: 200 },
          ],
        },
      );
      expect(evaluation).toMatchObject({
        passed: true,
        // The helper import is followed: deadline metadata and the network
        // snapshot reach it too.
        raw: { label: "shared", count: 3, deadline: "number", requests: 1 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("exits with its result when an abandoned poll attempt still holds the process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-hung-"));
    try {
      await writeFile(
        join(dir, "hung.ts"),
        `import { defineVerifier } from "@thelacanians/cairntrace/verifier";
export default defineVerifier({
  async run(ctx) {
    await ctx.poll(
      ({ attempt }) =>
        attempt === 1
          ? { count: 0 }
          : new Promise((resolve) => setTimeout(() => resolve({ count: 1 }), 60_000)),
      { until: (r) => r.count === 1, within: 1_500, every: 100, describe: (r) => "count=" + r.count },
    );
    return ctx.result.ok();
  },
});
`,
      );
      const started = Date.now();
      const evaluation = await evaluateScript(
        { script: { runtime: "node", file: "./hung.ts", timeoutMs: 15_000 } },
        new MockBrowserBackend(),
        {
          specDir: dir,
          childEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
        },
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(evaluation.passed).toBe(false);
      expect(evaluation.actual).toMatch(
        /^poll timed out after \d+ms \(2 attempt\(s\)\): attempt 2 was still running after \d+ms; last count=0$/,
      );
      expect(evaluation.raw).toMatchObject({ observed: { count: 0 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps old-style verify(ctx) scripts unchanged (strings, no SDK payload)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-legacy-"));
    try {
      await writeFile(
        join(dir, "legacy.mjs"),
        `export default async function verify(ctx) {
  return {
    ok: ctx.fixtures.count === "0" && ctx.fixtures.flag === "true",
    message: "ignored for legacy scripts",
    evidence: {
      fixtures: ctx.fixtures,
      run: ctx.run,
      keys: Object.keys(ctx).sort(),
      deadline: ctx.deadline,
    },
  };
}
`,
      );
      const evaluation = await evaluateScript(
        {
          script: {
            runtime: "node",
            file: "./legacy.mjs",
            fixtures: { count: "0", flag: "true", list: ["a", 1] },
          },
        },
        new MockBrowserBackend(),
        {
          specDir: dir,
          runDir: join(dir, "runs", "legacy-run-1"),
          failedStep: "submit",
          childEnv: {
            PATH: process.env["PATH"],
            HOME: process.env["HOME"],
            CAIRN_RUN_TOKEN: "t0k",
          },
        },
      );
      expect(evaluation).toMatchObject({
        passed: true,
        actual: "script returned ok=true",
      });
      expect(evaluation.raw).toEqual({
        fixtures: { count: "0", flag: "true", list: ["a", 1] },
        run: {
          failedStep: "submit",
          lastSuccessfulStep: null,
          id: "legacy-run-1",
          token: "t0k",
        },
        keys: [
          "artifacts",
          "captures",
          "deadline",
          "evals",
          "fixtures",
          "fixturesOutputs",
          "progress",
          "requests",
          "run",
          "runDir",
          "runs",
          "specDir",
          "vars",
        ],
        deadline: null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("SDK verifier in a real run (mock backend)", () => {
  it("evaluates an outcome end to end: evidence, message, progress events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-sdk-run-"));
    try {
      await mkdir(join(dir, "verifiers"), { recursive: true });
      await writeFile(
        join(dir, "verifiers", "order.ts"),
        `import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";
export default defineVerifier({
  fixtures: z.object({ orderId: z.string(), owners: z.array(z.string()), minAttempts: z.number() }),
  async run(ctx) {
    const patch = ctx.network.findOne({ method: "PATCH", url: "/api/orders/" + ctx.fixtures.orderId });
    let n = 0;
    await ctx.poll(() => ++n, { until: (v) => v >= ctx.fixtures.minAttempts, every: 10, within: 5_000 });
    if (ctx.vars.region !== "eu") return ctx.result.fail("wrong region", { vars: ctx.vars });
    return ctx.result.ok({ status: patch.status, owners: ctx.fixtures.owners, runId: ctx.run.id, marker: ctx.run.token, labels: ctx.run.labels });
  },
});
`,
      );
      const specPath = join(dir, "order.yml");
      await writeFile(
        specPath,
        `version: 1
name: sdk_order
intent: An SDK verifier reads fixtures, vars and the network snapshot.
coldStart: guest
steps:
  - id: open_home
    open: http://app.test/
outcomes:
  - id: order_saved
    description: the order PATCH was sent
    verify:
      script:
        runtime: node
        file: ./verifiers/order.ts
        timeoutMs: 30000
        fixtures:
          orderId: "7"
          owners: [ada, lin]
          minAttempts: \${vars.attempts}
`,
      );
      const backend = new MockBrowserBackend();
      const original = backend.runStep.bind(backend);
      backend.runStep = async (step) => {
        const stepResult = await original(step);
        backend.pushNetworkEntry({
          method: "PATCH",
          url: "http://app.test/api/orders/7",
          status: 204,
        });
        return stepResult;
      };
      const result = await runSpec({
        specPath,
        backend,
        artifactRoot: join(dir, "runs"),
        env: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
        vars: { region: "eu", attempts: 2 },
        labels: { cohort: "b" },
        runToken: "tok7e2e",
        heartbeatIntervalMs: 0,
      });
      expect(
        result.status,
        result.status === "passed"
          ? ""
          : await readFile(
              join(result.runDir, "outcomes", "order_saved.md"),
              "utf8",
            ),
      ).toBe("passed");
      const raw = JSON.parse(
        await readFile(
          join(result.runDir, "outcomes", "order_saved.raw.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(JSON.stringify(raw)).toContain('"owners":["ada","lin"]');
      expect(JSON.stringify(raw)).toContain('"status":204');
      // ctx.run carries the runner's identity, not only CAIRN_RUN_* fallbacks.
      expect(JSON.stringify(raw)).toContain(`"runId":"${result.runId}"`);
      expect(JSON.stringify(raw)).toContain('"marker":"tok7e2e"');
      expect(JSON.stringify(raw)).toContain('"labels":{"cohort":"b"}');
      const events = (
        await readFile(join(result.runDir, "events.ndjson"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(
        events.some(
          (e) =>
            e.type === "outcome.progress" &&
            (e.message ?? "").startsWith("poll attempt 1/"),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
