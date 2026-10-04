/**
 * The export-v2 runtime helpers behave like the runner they mirror:
 *  - `cairnCapture` against `runCapture` (same in-page probe, same single
 *    target rule, same table shaping, same errors);
 *  - `cairnPoll` against the runner's `poll` semantics (stability window);
 *  - `cairnFixtureOutputs` fails like an unresolved `${fixtures.…}` reference.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { InvocationResult } from "../../adapters/browserBackend";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { CaptureStep } from "../schema/spec.v1";
import type { TableVerifier } from "../schema/verifier.v1";
import { evaluateTable } from "../runner/verifiers/table";
import { runCapture } from "../runner/verifiers/expect";
import type { ProbeMatch, ProbeResult } from "../runner/verifiers/domProbe";
import {
  renderFixtureOutputsRuntime,
  renderPollRuntime,
  renderProbeRuntime,
} from "./playwrightRuntimeHost";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function load<T>(file: string, source: string): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-runtime-host-"));
  directories.push(dir);
  const path = join(dir, file);
  await writeFile(path, source);
  return (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as T;
}

/* ----- capture parity ----- */

interface FakeElement {
  match: (cfg: ProbeConfig) => boolean;
  visible?: boolean;
  text?: string;
  value?: string | null;
  attributes?: Record<string, string>;
  tag?: string;
  table?: { headers: string[]; rows: string[][] };
}

interface ProbeConfig {
  locator: Record<string, unknown>;
  attribute: string | null;
  table: boolean;
  includeHidden: boolean;
}

function probeAnswer(elements: FakeElement[], cfg: ProbeConfig): ProbeResult {
  const all = elements.filter((element) => element.match(cfg));
  const pool = cfg.includeHidden
    ? all
    : all.filter((element) => element.visible !== false);
  const describeElement = (element: FakeElement): ProbeMatch => ({
    visible: element.visible !== false,
    text: element.text ?? "",
    value: element.value ?? null,
    attribute: cfg.attribute
      ? (element.attributes?.[cfg.attribute] ?? null)
      : null,
    hasAttribute: cfg.attribute
      ? cfg.attribute in (element.attributes ?? {})
      : false,
    enabled: true,
    tag: element.tag ?? "div",
  });
  const nth = cfg.locator["nth"] as number | undefined;
  const target = nth !== undefined ? pool[nth] : pool[0];
  return {
    total: all.length,
    visibleCount: all.filter((element) => element.visible !== false).length,
    poolCount: pool.length,
    matches: pool.map(describeElement),
    ...(nth !== undefined
      ? { nthMatch: pool[nth] ? describeElement(pool[nth]!) : null }
      : {}),
    ...(cfg.table
      ? {
          table: target?.table
            ? { ...target.table, rowCount: target.table.rows.length }
            : null,
        }
      : {}),
  };
}

const CFG = /const cfg = (.*);\n/;

class ProbeBackend extends MockBrowserBackend {
  constructor(private readonly elements: FakeElement[]) {
    super();
  }
  override async evaluate(js: string): Promise<InvocationResult> {
    const found = CFG.exec(js);
    if (!found) return super.evaluate(js);
    const result = probeAnswer(this.elements, JSON.parse(found[1]!));
    return {
      ok: true,
      stdout: JSON.stringify(result),
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      argv: ["eval"],
    };
  }
}

/** A Playwright-shaped page whose evaluate runs the same probe model. */
function fakePage(elements: FakeElement[]) {
  return {
    async evaluate(script: string): Promise<unknown> {
      const found = CFG.exec(script);
      if (!found) throw new Error("not a probe script");
      return probeAnswer(elements, JSON.parse(found[1]!));
    },
    async waitForTimeout(ms: number): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

const byRole = (role: string, name?: string) => (cfg: ProbeConfig) =>
  cfg.locator["by"] === "role" &&
  cfg.locator["role"] === role &&
  (name === undefined ||
    String(cfg.locator["name"] ?? "").toLowerCase() === name.toLowerCase());
const bySelector = (selector: string) => (cfg: ProbeConfig) =>
  cfg.locator["by"] === "selector" && cfg.locator["selector"] === selector;

const MODEL: FakeElement[] = [
  { match: byRole("status"), text: "Order saved" },
  { match: bySelector(".row"), text: "row 1" },
  { match: bySelector(".row"), text: "row 2" },
  { match: bySelector(".once"), text: "visible one" },
  { match: bySelector(".once"), text: "hidden one", visible: false },
  { match: bySelector("#email"), value: "ops@example.test", tag: "input" },
  {
    match: byRole("link", "Next"),
    text: "Next",
    attributes: { href: "/orders?page=2" },
    tag: "a",
  },
  {
    match: bySelector("table.orders"),
    tag: "table",
    table: {
      headers: ["Customer", "Country", ""],
      rows: [
        ["Acme", "Mexico", "Edit"],
        ["Globex", "Chile", "Edit"],
      ],
    },
  },
];

function captureReason(message: string): string {
  return message.slice(message.indexOf(": ", message.indexOf("capture")) + 2);
}

interface ProbeModule {
  cairnCapture(
    page: ReturnType<typeof fakePage>,
    kind: "text" | "value" | "attribute" | "table",
    locator: Record<string, unknown>,
    options: {
      timeoutMs: number;
      includeHidden: boolean;
      attribute?: string;
    },
  ): Promise<unknown>;
}

describe("cairnCapture mirrors runCapture", () => {
  const cases: Array<{
    name: string;
    capture: CaptureStep["capture"];
    kind: "text" | "value" | "attribute" | "table";
    locator: Record<string, unknown>;
    attribute?: string;
    includeHidden?: boolean;
  }> = [
    {
      name: "text of the single match",
      capture: {
        assign: "x",
        text: { by: "role", role: "status" },
        timeoutMs: 40,
      },
      kind: "text",
      locator: { by: "role", role: "status" },
    },
    {
      name: "text narrowed to the one visible match",
      capture: {
        assign: "x",
        text: { by: "selector", selector: ".once" },
        timeoutMs: 40,
      },
      kind: "text",
      locator: { by: "selector", selector: ".once" },
      includeHidden: true,
    },
    {
      name: "nth of several matches",
      capture: {
        assign: "x",
        text: { by: "selector", selector: ".row", nth: 1 },
        timeoutMs: 40,
      },
      kind: "text",
      locator: { by: "selector", selector: ".row", nth: 1 },
      includeHidden: true,
    },
    {
      name: "value of a form control",
      capture: {
        assign: "x",
        value: { by: "selector", selector: "#email" },
        timeoutMs: 40,
      },
      kind: "value",
      locator: { by: "selector", selector: "#email" },
      includeHidden: true,
    },
    {
      name: "attribute",
      capture: {
        assign: "x",
        attribute: {
          by: "role",
          role: "link",
          name: "Next",
          attributeName: "href",
        },
        timeoutMs: 40,
      },
      kind: "attribute",
      locator: { by: "role", role: "link", name: "Next" },
      attribute: "href",
    },
    {
      name: "table (blank header gets a column name)",
      capture: {
        assign: "x",
        table: { by: "selector", selector: "table.orders" },
        timeoutMs: 40,
      },
      kind: "table",
      locator: { by: "selector", selector: "table.orders" },
      includeHidden: true,
    },
    {
      name: "ambiguous: several matches and no nth",
      capture: {
        assign: "x",
        text: { by: "selector", selector: ".row" },
        timeoutMs: 40,
      },
      kind: "text",
      locator: { by: "selector", selector: ".row" },
      includeHidden: true,
    },
    {
      name: "no element",
      capture: {
        assign: "x",
        text: { by: "role", role: "alert" },
        timeoutMs: 40,
      },
      kind: "text",
      locator: { by: "role", role: "alert" },
    },
    {
      name: "value of something that is not a form control",
      capture: {
        assign: "x",
        value: { by: "role", role: "status" },
        timeoutMs: 40,
      },
      kind: "value",
      locator: { by: "role", role: "status" },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const probe = await load<ProbeModule>(
        "probe.mjs",
        renderProbeRuntime("js"),
      );
      const runner = await runCapture(c.capture, {
        backend: new ProbeBackend(MODEL),
        scope: {},
      });
      const exported = await probe
        .cairnCapture(fakePage(MODEL), c.kind, c.locator, {
          timeoutMs: 40,
          includeHidden: c.includeHidden ?? false,
          ...(c.attribute ? { attribute: c.attribute } : {}),
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: Error) => ({ ok: false as const, error: error.message }),
        );
      expect(exported.ok).toBe(runner.ok);
      if (runner.ok && exported.ok) {
        expect(exported.value).toEqual(runner.value);
      } else if (!runner.ok && !exported.ok) {
        // `capture <kind> <assign>: <why>` vs `capture <kind>: <why>`.
        expect(captureReason(exported.error)).toBe(
          captureReason(runner.error).replace(/^x: /, ""),
        );
      }
    });
  }
});

/* ----- table verifier parity ----- */

interface TableModule {
  cairnReadTable(
    page: ReturnType<typeof fakePage>,
    locator: Record<string, unknown>,
    options: { timeoutMs: number; includeHidden: boolean },
  ): Promise<{ headers: string[]; rows: string[][]; rowCount: number }>;
  cairnJudgeTable(
    table: { headers: string[]; rows: string[][]; rowCount: number },
    spec: Record<string, unknown>,
  ): string[];
}

describe("cairnJudgeTable mirrors the table verifier", () => {
  const orders: FakeElement = {
    match: bySelector("table.orders"),
    tag: "table",
    table: {
      headers: ["Customer", "Country", " ", "Total"],
      rows: [
        ["Acme", "Mexico", "Edit", "10"],
        ["Globex", "Chile", "Edit", "20"],
        ["", "", "Edit", ""],
      ],
    },
  };
  const locator = { by: "selector", selector: "table.orders" } as const;
  const specs: Array<[string, TableVerifier["table"]]> = [
    ["row count equals", { locator, rows: { equals: 3 } }],
    ["row count equals (wrong)", { locator, rows: { equals: 2 } }],
    ["at least / at most", { locator, rows: { atLeast: 2, atMost: 3 } }],
    ["at most (wrong)", { locator, rows: { atMost: 1 } }],
    [
      "no blank rows (the Edit-only row is blank once ignored)",
      { locator, rows: { noBlank: true, ignoreCells: ["edit"] } },
    ],
    ["no blank rows without ignoring", { locator, rows: { noBlank: true } }],
    [
      "headers present, any order",
      { locator, headers: { includes: ["total", "CUSTOMER"] } },
    ],
    [
      "headers in order",
      { locator, headers: { includes: ["Customer", "Total"], inOrder: true } },
    ],
    [
      "headers out of order",
      { locator, headers: { includes: ["Total", "Customer"], inOrder: true } },
    ],
    ["a header that is missing", { locator, headers: { includes: ["Nope"] } }],
    [
      "a row containing text (normalized)",
      { locator, contains: ["  acme   MEXICO "] },
    ],
    ["a row containing text (absent)", { locator, contains: ["Initech"] }],
    [
      "a row by column",
      { locator, contains: [{ Customer: "glob", Country: "chile" }] },
    ],
    [
      "a row by column (no such combination)",
      { locator, contains: [{ Customer: "Acme", Country: "Chile" }] },
    ],
    ["a row by an unknown column", { locator, contains: [{ Planet: "Mars" }] }],
  ];
  for (const [name, spec] of specs) {
    it(name, async () => {
      const mod = await load<TableModule>(
        "probe.mjs",
        renderProbeRuntime("js"),
      );
      const model = [orders];
      const runner = await evaluateTable(
        { table: spec },
        new ProbeBackend(model),
        {},
        (attempt) => attempt({ attempt: 1, deadline: Date.now() + 1000 }),
      );
      const table = await mod.cairnReadTable(
        fakePage(model),
        { ...spec.locator },
        { timeoutMs: 50, includeHidden: true },
      );
      const { locator: _locator, timeoutMs: _timeout, ...checks } = spec;
      expect(mod.cairnJudgeTable(table, checks).length === 0).toBe(
        runner.passed,
      );
    });
  }

  it("waits for the table, then fails with the locator when it never renders", async () => {
    const mod = await load<TableModule>("probe.mjs", renderProbeRuntime("js"));
    await expect(
      mod.cairnReadTable(
        fakePage([]),
        { by: "role", role: "table" },
        { timeoutMs: 60, includeHidden: false },
      ),
    ).rejects.toThrow(/no table found within 60ms at role=table/);
  });
});

/* ----- poll ----- */

describe("cairnPoll", () => {
  it("returns once green holds for stableMs over at least two samples", async () => {
    const { cairnPoll } = await load<{
      cairnPoll(
        attempt: () => Promise<void>,
        options: { timeoutMs: number; everyMs: number; stableMs: number },
      ): Promise<void>;
    }>("poll.mjs", renderPollRuntime("js"));
    let calls = 0;
    const started = Date.now();
    await cairnPoll(
      async () => {
        calls += 1;
      },
      { timeoutMs: 2000, everyMs: 20, stableMs: 120 },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("a red sample restarts the window, and the last error surfaces at the deadline", async () => {
    const { cairnPoll } = await load<{
      cairnPoll(
        attempt: () => Promise<void>,
        options: { timeoutMs: number; everyMs: number; stableMs: number },
      ): Promise<void>;
    }>("poll.mjs", renderPollRuntime("js"));
    let calls = 0;
    await expect(
      cairnPoll(
        async () => {
          calls += 1;
          if (calls % 3 === 0) throw new Error("flapped");
        },
        { timeoutMs: 400, everyMs: 20, stableMs: 200 },
      ),
    ).rejects.toThrow(/flapped|green for only/);
  });

  it("never green: throws the last attempt's error", async () => {
    const { cairnPoll } = await load<{
      cairnPoll(
        attempt: () => Promise<void>,
        options: { timeoutMs: number; everyMs: number; stableMs: number },
      ): Promise<void>;
    }>("poll.mjs", renderPollRuntime("js"));
    await expect(
      cairnPoll(
        async () => {
          throw new Error("always red");
        },
        { timeoutMs: 120, everyMs: 20, stableMs: 50 },
      ),
    ).rejects.toThrow("always red");
  });
});

/* ----- fixture outputs ----- */

describe("cairnFixtureOutputs", () => {
  it("reads the global setup's file and fails on a missing fixture or key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-fixture-outputs-"));
    directories.push(dir);
    const file = join(dir, "fixtures.json");
    await writeFile(file, JSON.stringify({ thing: { sku: "S-1", n: 2 } }));
    const mod = await load<{
      cairnFixtureOutputs(
        name: string,
        keys: string[],
      ): Record<string, unknown>;
    }>("fixtureOutputs.mjs", renderFixtureOutputsRuntime("js"));
    const previous = process.env.CAIRN_FIXTURES_FILE;
    try {
      delete process.env.CAIRN_FIXTURES_FILE;
      expect(() => mod.cairnFixtureOutputs("thing", ["sku"])).toThrow(
        /CAIRN_FIXTURES_FILE is not set/,
      );
      process.env.CAIRN_FIXTURES_FILE = file;
      expect(mod.cairnFixtureOutputs("thing", ["sku", "n"])).toEqual({
        sku: "S-1",
        n: 2,
      });
      expect(() => mod.cairnFixtureOutputs("other", ["sku"])).toThrow(
        /fixture other is not in/,
      );
      expect(() => mod.cairnFixtureOutputs("thing", ["secret"])).toThrow(
        /no output secret.*available: sku, n/,
      );
    } finally {
      if (previous === undefined) delete process.env.CAIRN_FIXTURES_FILE;
      else process.env.CAIRN_FIXTURES_FILE = previous;
    }
  });
});
