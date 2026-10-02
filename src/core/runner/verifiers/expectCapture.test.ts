import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InvocationResult } from "../../../adapters/browserBackend";
import { MockBrowserBackend } from "../../../adapters/mock/MockBrowserBackend";
import { PlaywrightAdapter } from "../../../adapters/playwright/PlaywrightAdapter";
import { exportPlaywright } from "../../exporters/playwrightExporter";
import { clearRegisteredSecretValues } from "../../artifacts/redaction";
import { RunEventSchema, type RunEvent } from "../../schema/events.v1";
import {
  OutcomeSchema,
  SpecSchema,
  StepSchema,
  type Spec,
} from "../../schema/spec.v1";
import { evaluateOutcomes } from "../OutcomeEvaluator";
import { runSpec } from "../Runner";
import type { ProbeMatch, ProbeResult } from "./domProbe";
import { runProbe } from "./domProbe";
import { runCapture, runExpect } from "./expect";

/* ----- a mock backend whose page probe answers from a tiny DOM model ----- */

interface FakeElement {
  match: (cfg: ProbeConfig) => boolean;
  visible?: boolean;
  text?: string;
  value?: string | null;
  attributes?: Record<string, string>;
  enabled?: boolean;
  tag?: string;
  table?: { headers: string[]; rows: string[][] };
}

interface ProbeConfig {
  locator: Record<string, unknown>;
  attribute: string | null;
  table: boolean;
  includeHidden: boolean;
}

class ProbeBackend extends MockBrowserBackend {
  public probes: ProbeConfig[] = [];
  constructor(public elements: FakeElement[]) {
    super();
  }
  override async evaluate(js: string): Promise<InvocationResult> {
    const found = /const cfg = (.*);\n/.exec(js);
    if (!found) return super.evaluate(js);
    const cfg = JSON.parse(found[1]!) as ProbeConfig;
    this.probes.push(cfg);
    const all = this.elements.filter((element) => element.match(cfg));
    const pool = cfg.includeHidden
      ? all
      : all.filter((e) => e.visible !== false);
    const describeElement = (e: FakeElement): ProbeMatch => ({
      visible: e.visible !== false,
      text: e.text ?? "",
      value: e.value ?? null,
      attribute: cfg.attribute ? (e.attributes?.[cfg.attribute] ?? null) : null,
      hasAttribute: cfg.attribute
        ? cfg.attribute in (e.attributes ?? {})
        : false,
      enabled: e.enabled !== false,
      tag: e.tag ?? "div",
    });
    const nth = cfg.locator["nth"] as number | undefined;
    const target = nth !== undefined ? pool[nth] : pool[0];
    const result: ProbeResult = {
      total: all.length,
      visibleCount: all.filter((e) => e.visible !== false).length,
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

const byRole = (role: string, name?: string) => (cfg: ProbeConfig) =>
  cfg.locator["by"] === "role" &&
  cfg.locator["role"] === role &&
  (name === undefined ||
    String(cfg.locator["name"] ?? "").toLowerCase() === name.toLowerCase());
const bySelector = (selector: string) => (cfg: ProbeConfig) =>
  cfg.locator["by"] === "selector" && cfg.locator["selector"] === selector;
const byTestid = (testid: string) => (cfg: ProbeConfig) =>
  cfg.locator["by"] === "testid" && cfg.locator["testid"] === testid;

function pageModel(): FakeElement[] {
  return [
    { match: byRole("status"), text: "Order saved", tag: "div" },
    {
      match: byRole("button", "Save"),
      text: "Save",
      enabled: false,
      tag: "button",
    },
    { match: bySelector(".row"), text: "row 1" },
    { match: bySelector(".row"), text: "row 2" },
    { match: bySelector(".row"), text: "hidden row", visible: false },
    { match: bySelector("h1"), text: "Acme Corp" },
    {
      match: byRole("link", "Next"),
      text: "Next",
      attributes: { href: "/orders?page=2" },
      tag: "a",
    },
    { match: bySelector("#email"), value: "ops@example.test", tag: "input" },
    {
      match: byTestid("orders"),
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
}

const parseExpect = (raw: unknown) =>
  (StepSchema.parse({ expect: raw }) as { expect: never }).expect;
const parseCapture = (raw: unknown) =>
  (StepSchema.parse({ capture: raw }) as { capture: never }).capture;

const deps = (backend: MockBrowserBackend) => ({
  backend,
  scope: {},
  sleep: async () => undefined,
});

describe("expect step", () => {
  it("checks visible, text, enabled, count, value and attribute in one probe per attempt", async () => {
    const backend = new ProbeBackend(pageModel());
    expect(
      await runExpect(
        parseExpect({
          by: "role",
          role: "status",
          visible: true,
          text: { contains: "SAVED" },
        }),
        deps(backend),
      ),
    ).toMatchObject({ passed: true, kind: "visible+text", attempts: 1 });
    expect(
      await runExpect(
        parseExpect({
          by: "role",
          role: "button",
          name: "Save",
          enabled: false,
        }),
        deps(backend),
      ),
    ).toMatchObject({ passed: true, actual: "disabled" });
    expect(
      await runExpect(
        parseExpect({ by: "selector", selector: ".row", count: 3 }),
        deps(backend),
      ),
    ).toMatchObject({ passed: true, actual: "count=3" });
    expect(
      await runExpect(
        parseExpect({
          by: "selector",
          selector: "#email",
          value: "ops@example.test",
        }),
        deps(backend),
      ),
    ).toMatchObject({ passed: true });
    expect(
      await runExpect(
        parseExpect({
          by: "role",
          role: "link",
          name: "Next",
          attribute: { name: "href", contains: "page=2" },
        }),
        deps(backend),
      ),
    ).toMatchObject({ passed: true, actual: 'href="/orders?page=2"' });
    expect(backend.probes.at(-1)?.attribute).toBe("href");
  });

  it("retries until timeoutMs and explains ambiguity and absence", async () => {
    const backend = new ProbeBackend(pageModel());
    let now = 0;
    const timed = {
      backend,
      scope: {},
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    const ambiguous = await runExpect(
      parseExpect({
        by: "selector",
        selector: ".row",
        text: "row 1",
        timeoutMs: 1000,
      }),
      timed,
    );
    // Two visible .row matches: ambiguity is not narrowed away.
    expect(ambiguous.passed).toBe(false);
    expect(ambiguous.actual).toContain("3 elements match .row; add nth");
    expect(ambiguous.attempts).toBe(5);
    const nth = await runExpect(
      parseExpect({ by: "selector", selector: ".row", nth: 1, text: "row 2" }),
      timed,
    );
    expect(nth.passed).toBe(true);
    const absent = await runExpect(
      parseExpect({ by: "role", role: "dialog", hidden: true }),
      timed,
    );
    expect(absent).toMatchObject({ passed: true, actual: "absent" });
    const missing = await runExpect(
      parseExpect({
        by: "role",
        role: "dialog",
        visible: true,
        timeoutMs: 250,
      }),
      timed,
    );
    expect(missing).toMatchObject({ passed: false, actual: "no match" });
  });

  it("checks expect.request through the injected request transport", async () => {
    const backend = new ProbeBackend([]);
    const calls: unknown[] = [];
    const step = StepSchema.parse({
      expect: {
        request: {
          url: "/api/orders/${captures.order.id}",
          json: { status: "shipped" },
        },
      },
    }) as { expect: never };
    const result = await runExpect(step.expect, {
      backend,
      scope: { captures: { order: { id: 7 } } },
      sleep: async () => undefined,
      request: async (call) => {
        calls.push(call);
        return {
          ok: true,
          response: { status: 200, body: { status: "shipped" }, url: call.url },
        };
      },
    });
    expect(result).toMatchObject({ passed: true, kind: "request" });
    expect(calls).toEqual([{ method: "GET", url: "/api/orders/7" }]);
  });

  it("resolves references itself: text fields as text, count and request json typed, unknown names reported", async () => {
    const backend = new ProbeBackend(pageModel());
    const scope = {
      captures: { rows: { rowCount: 3 }, label: "Save", order: { total: 12 } },
    };
    const withScope = { ...deps(backend), scope };
    expect(
      await runExpect(
        parseExpect({
          by: "selector",
          selector: ".row",
          count: "${captures.rows.rowCount}",
        }),
        withScope,
      ),
    ).toMatchObject({ passed: true, actual: "count=3" });
    expect(
      await runExpect(
        parseExpect({
          by: "role",
          role: "button",
          name: "${captures.label}",
          enabled: false,
        }),
        withScope,
      ),
    ).toMatchObject({ passed: true });
    const typo = await runExpect(
      parseExpect({
        by: "role",
        role: "button",
        name: "${captures.lable}",
        visible: true,
      }),
      withScope,
    );
    expect(typo).toMatchObject({
      passed: false,
      actual: "unresolved ${captures.lable}",
      attempts: 0,
    });
    const calls: unknown[] = [];
    const request = async (call: { url: string }) => {
      calls.push(call);
      return {
        ok: true as const,
        response: { status: 200, body: { total: 12 }, url: call.url },
      };
    };
    const typed = await runExpect(
      parseExpect({
        request: {
          url: "/api/orders/1",
          json: { total: "${captures.order.total}" },
        },
      }),
      { ...withScope, request },
    );
    expect(typed).toMatchObject({ passed: true, kind: "request" });
    const unknownId = await runExpect(
      parseExpect({ request: { url: "/api/items/${captures.itemId}" } }),
      { ...withScope, request },
    );
    expect(unknownId).toMatchObject({
      passed: false,
      actual: "unresolved ${captures.itemId}",
    });
    expect(calls).toHaveLength(1);
    expect(
      await runCapture(
        parseCapture({
          assign: "x",
          text: { by: "role", role: "button", name: "${captures.nope}" },
        }),
        withScope,
      ),
    ).toMatchObject({
      ok: false,
      error: "capture text x: unresolved ${captures.nope}",
    });
  });

  it("rejects expect shapes without assertions or with both visible and hidden", () => {
    expect(
      StepSchema.safeParse({ expect: { by: "role", role: "button" } }).success,
    ).toBe(false);
    expect(
      StepSchema.safeParse({
        expect: { by: "role", role: "button", visible: true, hidden: true },
      }).success,
    ).toBe(false);
    expect(
      StepSchema.safeParse({
        capture: {
          assign: "x",
          text: { by: "selector", selector: "h1" },
          value: { by: "selector", selector: "h1" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("capture step", () => {
  it("captures text, value, attribute and table rows keyed by header", async () => {
    const backend = new ProbeBackend(pageModel());
    expect(
      await runCapture(
        parseCapture({
          assign: "title",
          text: { by: "selector", selector: "h1" },
        }),
        deps(backend),
      ),
    ).toMatchObject({ ok: true, value: "Acme Corp" });
    expect(
      await runCapture(
        parseCapture({
          assign: "next",
          attribute: {
            by: "role",
            role: "link",
            name: "Next",
            attributeName: "href",
          },
        }),
        deps(backend),
      ),
    ).toMatchObject({ ok: true, value: "/orders?page=2" });
    expect(
      await runCapture(
        parseCapture({
          assign: "orders",
          table: { by: "testid", testid: "orders" },
        }),
        deps(backend),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        headers: ["Customer", "Country", ""],
        rowCount: 2,
        rows: [
          { Customer: "Acme", Country: "Mexico", column3: "Edit" },
          { Customer: "Globex", Country: "Chile", column3: "Edit" },
        ],
      },
    });
    expect(
      await runCapture(
        parseCapture({
          assign: "x",
          value: { by: "selector", selector: "h1" },
          timeoutMs: 1,
        }),
        deps(backend),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("is not a form control"),
    });
  });
});

describe("table verifier", () => {
  it("checks rows, blank rows (ignoring action cells), required rows and headers", async () => {
    const backend = new ProbeBackend([
      {
        match: byTestid("workers"),
        table: {
          headers: ["Name", "Country", "Actions"],
          rows: [
            ["Ada", "Mexico", "Edit Delete"],
            ["", "", "Edit Delete"],
          ],
        },
      },
    ]);
    const evaluate = async (table: unknown) => {
      const [result] = await evaluateOutcomes(
        [OutcomeSchema.parse({ id: "t", description: "t", verify: { table } })],
        backend,
        {},
      );
      return result!.evaluation;
    };
    const locator = { by: "testid", testid: "workers" };
    const blank = await evaluate({
      locator,
      rows: { noBlank: true, ignoreCells: ["Actions"] },
    });
    expect(blank).toMatchObject({ passed: false });
    expect(blank.actual).toContain("blank row(s) at index 1");
    const ok = await evaluate({
      locator,
      rows: { atLeast: 1, atMost: 2 },
      contains: [{ name: "ada", country: "mex" }, "Delete"],
      headers: { includes: ["Name", "Country"], inOrder: true },
    });
    expect(ok.passed).toBe(true);
    expect(ok.raw).toMatchObject({
      kind: "table",
      observed: { rowCount: 2, headers: ["Name", "Country", "Actions"] },
    });
    const wrong = await evaluate({
      locator,
      contains: [{ Region: "x" }],
      headers: { includes: ["Country", "Name"], inOrder: true },
    });
    expect(wrong.actual).toContain('no column "Region"');
    expect(wrong.actual).toContain("out of order");
  });
});

/* ----- runner integration ----- */

async function events(runDir: string): Promise<RunEvent[]> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

async function project(spec: string) {
  const dir = await mkdtemp(join(tmpdir(), "cairn-expect-capture-"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    "version: 1\nenvironments:\n  local: {}\n",
  );
  const specPath = join(dir, "flow.yml");
  await writeFile(specPath, spec);
  return { specPath, artifactRoot: join(dir, "runs") };
}

const FLOW = `version: 1
name: expect_capture_flow
intent: assert mid-flow and reuse captured values
coldStart: guest
outcomes:
  - id: captured_orders
    description: the captured table has the two orders
    verify:
      value:
        actual: "\${captures.orders}"
        expect: { rowCount: 2, "rows[0].Customer": Acme }
  - id: ready_banner
    description: the banner eventually says ready
    verify:
      text: { contains: Ready }
      poll: { timeoutMs: 2000, everyMs: 50 }
steps:
  - open: http://app.test/orders
  - id: saved_banner
    expect: { by: role, role: status, visible: true, text: { contains: saved } }
  - id: grab_orders
    capture: { assign: orders, table: { by: testid, testid: orders } }
  - id: grab_name
    capture: { assign: company, text: { by: selector, selector: h1 } }
  - fill: { by: label, name: Search, value: "\${captures.company} \${captures.orders.rowCount}" }
`;

describe("runner: expect and capture steps", () => {
  it("redacts a capture whose assign name is a credential from its evidence", async () => {
    const { specPath, artifactRoot } = await project(`version: 1
name: secret_capture_flow
intent: a captured token never reaches the artifacts
coldStart: guest
outcomes:
  - id: token_seen
    description: the token was captured
    verify:
      value: { actual: "\${captures.apiToken}", expect: { $: { exists: true } } }
steps:
  - open: http://app.test/orders
  - id: grab_token
    capture: { assign: apiToken, text: { by: selector, selector: h1 } }
`);
    try {
      const backend = new ProbeBackend(pageModel());
      const result = await runSpec({ specPath, artifactRoot, backend });
      expect(result.status).toBe("passed");
      const captured = await readFile(
        join(result.runDir, "captures/apiToken.json"),
        "utf8",
      );
      expect(captured).not.toContain("Acme Corp");
      expect(JSON.parse(captured)).toMatchObject({ assign: "apiToken" });
    } finally {
      clearRegisteredSecretValues();
    }
  });

  it("records expect evidence/events, stores captures, splices them into later steps and outcomes", async () => {
    const { specPath, artifactRoot } = await project(FLOW);
    const backend = new ProbeBackend(pageModel());
    backend.setPageText("Loading");
    setTimeout(() => backend.setPageText("Ready"), 150);
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    const fill = backend.stepLog.find((step) => "fill" in step) as {
      fill: { value: string };
    };
    expect(fill.fill.value).toBe("Acme Corp 2");

    const evidence = JSON.parse(
      await readFile(
        join(result.runDir, "expects/002_saved_banner.json"),
        "utf8",
      ),
    );
    expect(evidence).toMatchObject({
      version: 1,
      id: "saved_banner",
      stepId: "saved_banner",
      status: "passed",
      kind: "visible+text",
    });
    const captured = JSON.parse(
      await readFile(join(result.runDir, "captures/orders.json"), "utf8"),
    );
    expect(captured).toMatchObject({
      assign: "orders",
      kind: "table",
      value: { rowCount: 2 },
    });

    const log = await events(result.runDir);
    expect(log.find((e) => e.type === "expect.passed")).toMatchObject({
      stepId: "saved_banner",
      expectId: "saved_banner",
      path: "expects/002_saved_banner.json",
      attempts: 1,
    });
    const polled = log.find(
      (e) => e.type === "outcome.passed" && e.outcomeId === "ready_banner",
    ) as { attempts?: number; polledMs?: number } | undefined;
    expect(polled?.attempts).toBeGreaterThan(1);
    expect(polled?.polledMs).toBeGreaterThan(0);
    expect(
      log.some(
        (e) => e.type === "outcome.progress" && e.outcomeId === "ready_banner",
      ),
    ).toBe(true);
    expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
      ["captured_orders", "passed"],
      ["ready_banner", "passed"],
    ]);
  });

  it("fails the step on a mismatched expect and blocks outcomes that need its later captures", async () => {
    const { specPath, artifactRoot } = await project(
      FLOW.replace(
        "expect: { by: role, role: status, visible: true, text: { contains: saved } }",
        "expect: { id: banner_says_failed, by: role, role: status, text: { contains: failed }, timeoutMs: 100 }",
      ),
    );
    const backend = new ProbeBackend(pageModel());
    backend.setPageText("Ready");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    const step = result.steps.find((s) => s.id === "saved_banner");
    expect(step).toMatchObject({ status: "failed" });
    expect(step?.error).toMatch(
      /^expect banner_says_failed: expected role=status: text contains "failed"; got text "Order saved"/,
    );
    const log = await events(result.runDir);
    expect(log.find((e) => e.type === "expect.failed")).toMatchObject({
      expectId: "banner_says_failed",
      path: "expects/002_banner_says_failed.json",
    });
    expect(
      result.outcomes.find((o) => o.id === "captured_orders")?.status,
    ).toBe("skipped");
  });
});

describe("runner: expect references", () => {
  it("does not splice a misspelled capture into an expect step as an empty string", async () => {
    const { specPath, artifactRoot } = await project(
      FLOW.replace(
        '  - fill: { by: label, name: Search, value: "${captures.company} ${captures.orders.rowCount}" }',
        '  - id: item_state\n    expect: { request: { url: "/api/items/${captures.compnay}" } }',
      ),
    );
    const backend = new ProbeBackend(pageModel());
    backend.setPageText("Ready");
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    expect(result.steps.find((s) => s.id === "item_state")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("unresolved ${captures.compnay}"),
    });
  });
});

/* ----- export ----- */

describe("export: expect, capture and data verifiers", () => {
  it("renders expect as web-first assertions and skips capture/data verifiers with reasons", () => {
    const spec: Spec = SpecSchema.parse({
      version: 1,
      name: "export_expect",
      intent: "export coverage",
      coldStart: "guest",
      outcomes: [
        {
          id: "db_row",
          description: "row stored",
          verify: { mongo: { source: "app", collection: "rows" } },
        },
        {
          id: "polled_text",
          description: "text eventually",
          verify: { text: { contains: "Done" }, poll: { timeoutMs: 1000 } },
        },
        {
          id: "export_body",
          description: "export body",
          verify: {
            network: { urlContains: "/export", body: { json: { a: 1 } } },
          },
        },
      ],
      steps: [
        { open: "https://app.test/" },
        {
          expect: {
            by: "role",
            role: "button",
            name: "Save",
            visible: true,
            enabled: true,
            timeoutMs: 2000,
          },
        },
        { expect: { by: "selector", selector: ".row", count: { atLeast: 2 } } },
        {
          expect: {
            by: "label",
            name: "Email",
            value: { contains: "@" },
            attribute: { name: "type", equals: "email" },
          },
        },
        { expect: { by: "role", role: "dialog", hidden: true } },
        { expect: { request: { url: "/api/state" } } },
        {
          capture: {
            assign: "rows",
            table: { by: "selector", selector: "table" },
          },
        },
      ],
    });
    const result = exportPlaywright(spec);
    expect(result.source).toContain(
      'await expect(page.getByRole("button", { name: "Save" }).first()).toBeVisible({ timeout: 2000 });',
    );
    expect(result.source).toContain(
      'await expect(page.getByRole("button", { name: "Save" }).first()).toBeEnabled({ timeout: 2000 });',
    );
    expect(result.source).toContain(
      'await expect.poll(async () => page.locator(".row").count(), { timeout: 5000 }).toBeGreaterThanOrEqual(2);',
    );
    expect(result.source).toContain(".toHaveValue(new RegExp(");
    expect(result.source).toContain(
      '.toHaveAttribute("type", "email", { timeout: 5000 });',
    );
    expect(result.source).toContain(
      'await expect(page.getByRole("dialog").filter({ visible: true })).toHaveCount(0, { timeout: 5000 });',
    );
    const reasons = result.coverage.skips.map(
      (s) => `${s.kind}:${s.soft ? "soft" : "hard"}:${s.reason}`,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^step:hard:expect\.request not exported/),
        expect.stringMatching(
          /^step:hard:capture step not exportable \(rows\)/,
        ),
        expect.stringMatching(
          /^outcome:hard:mongo verifier not exported: it queries config datasource "app"/,
        ),
        expect.stringMatching(/^outcome:soft:poll not exported/),
        expect.stringMatching(
          /^outcome:hard:network body\/count matching not exported/,
        ),
      ]),
    );
  });

  it("names run steps, fixtures, teardown and gates the export does not reproduce", () => {
    const spec: Spec = SpecSchema.parse({
      version: 1,
      name: "export_setup",
      intent: "export coverage of run-time setup",
      coldStart: "guest",
      preconditions: { wait: "api_ready" },
      fixtures: ["demo_item"],
      outcomes: [
        { id: "ok", description: "ok", verify: { url: { matches: "/" } } },
      ],
      steps: [
        { open: "https://app.test/" },
        {
          id: "seed",
          run: {
            node: "./seed.mjs",
            args: ["${secrets.SEED_TOKEN}"],
            assign: "seeded",
          },
        },
      ],
      teardown: [{ run: { shell: 'echo "$1"', args: ["x"] } }],
    });
    const result = exportPlaywright(spec);
    const reasons = result.coverage.skips.map(
      (s) => `${s.kind}:${s.soft ? "soft" : "hard"}:${s.reason}`,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^step:hard:run step not exported \(node seed\.mjs\).*\$\{runs\.seeded…\}/,
        ),
        expect.stringMatching(/^step:hard:fixtures not exported \(demo_item\)/),
        expect.stringMatching(/^step:soft:teardown not exported \(1 item/),
        expect.stringMatching(/^step:soft:preconditions\.wait not exported/),
      ]),
    );
    expect(result.coverage.fixme).toBe(true);
    expect(result.coverage.semanticRisks.map((r) => r.id)).toEqual(
      expect.arrayContaining(["fixtures", "teardown", "preconditions"]),
    );
    // The run step's command and args never reach the generated code.
    expect(result.source).not.toContain("SEED_TOKEN");
    expect(result.source).not.toContain("unhandled step");
  });
});

function exportSteps(steps: unknown[]) {
  const spec: Spec = SpecSchema.parse({
    version: 1,
    name: "count_export",
    intent: "count export semantics",
    coldStart: "guest",
    outcomes: [
      { id: "ok", description: "ok", verify: { url: { matches: "/" } } },
    ],
    steps: [{ open: "https://app.test/" }, ...steps],
  });
  return exportPlaywright(spec);
}

describe("export: expect count semantics", () => {
  it("counts whole-name, visible-only matches for semantic locators", () => {
    const result = exportSteps([
      { expect: { by: "text", text: "Error", count: 0 } },
      {
        expect: {
          by: "role",
          role: "row",
          name: "Order  saved",
          count: { atLeast: 1 },
        },
      },
      { expect: { by: "label", name: "Email", exact: true, count: 1 } },
    ]);
    expect(result.source).toContain(
      'await expect(page.getByText(new RegExp("^\\\\s*Error\\\\s*$", "i")).filter({ visible: true })).toHaveCount(0, { timeout: 5000 });',
    );
    expect(result.source).toContain(
      'page.getByRole("row", { name: new RegExp("^\\\\s*Order\\\\s+saved\\\\s*$", "i") }).filter({ visible: true }).count()',
    );
    expect(result.source).toContain(
      'await expect(page.getByLabel("Email", { exact: true }).filter({ visible: true })).toHaveCount(1, { timeout: 5000 });',
    );
    expect(result.coverage.fixme).toBe(false);
  });

  it("renders non-numeric count matchers as a predicate and hard-skips what it cannot render", () => {
    const rendered = exportSteps([
      {
        expect: { by: "testid", testid: "rows", count: { oneOf: [1, 2] } },
      },
      {
        expect: {
          by: "selector",
          selector: ".row",
          count: { matches: "^[12]$" },
        },
      },
    ]);
    expect(rendered.source).toContain(
      'await expect.poll(async () => { const n = await page.getByTestId("rows").count(); return [1,2].includes(n); }, { message: "count one of [1,2]", timeout: 5000 }).toBe(true);',
    );
    expect(rendered.source).toContain(
      'return new RegExp("^[12]$").test(String(n));',
    );
    expect(rendered.coverage.fixme).toBe(false);
    expect(rendered.coverage.stepsExported).toBe(3);

    const dropped = exportSteps([
      { click: { by: "role", role: "button", name: "Load" } },
      {
        expect: {
          by: "role",
          role: "row",
          count: { atLeast: 1 },
          near: "Orders",
        },
      },
    ]);
    expect(dropped.coverage.fixme).toBe(true);
    expect(
      dropped.coverage.skips.find((skip) => skip.kind === "step"),
    ).toMatchObject({
      reason: expect.stringContaining("count >= 1 with near not exported"),
    });
    expect(
      dropped.coverage.skips.find((skip) => skip.kind === "step")?.soft,
    ).toBeUndefined();
    expect(dropped.source).toContain(
      "// expect count >= 1 with near not exported — verify with cairn run",
    );
  });
});

/* ----- the page probe against a real Chromium ----- */

describe("page probe (Playwright Chromium)", () => {
  let adapter: PlaywrightAdapter;
  beforeAll(async () => {
    adapter = new PlaywrightAdapter({ testIdAttribute: "data-qa" });
    const html = `
      <h1>Orders</h1>
      <label>Email <input id="email" type="email" value="ops@example.test"></label>
      <label for="country">Country</label><select id="country"><option selected>Chile</option></select>
      <button disabled>Save</button>
      <button aria-label="Close dialog">x</button>
      <div style="display:none"><button>Save</button></div>
      <article><h2>Acme</h2><button>Open</button></article>
      <article><h2>Globex</h2><button>Open</button></article>
      <a href="/orders?page=2">Next page</a>
      <p>  Order   <b>saved</b> </p>
      <div data-qa="workers">
        <table>
          <thead><tr><th>Name</th><th>Country</th><th>Actions</th></tr></thead>
          <tbody>
            <tr><td>Ada</td><td>Mexico</td><td><button>Edit</button></td></tr>
            <tr><td> </td><td></td><td><button>Edit</button></td></tr>
            <tr style="display:none"><td>Ghost</td><td>-</td><td></td></tr>
          </tbody>
        </table>
      </div>`;
    const opened = await adapter.runStep({
      open: `data:text/html,${encodeURIComponent(html)}`,
    });
    expect(opened.ok).toBe(true);
  }, 60_000);
  afterAll(async () => {
    await adapter?.close();
  });

  it("resolves role/name, label, text, testid, near and hidden matches like the authoring rules", async () => {
    const save = await runProbe(adapter, {
      by: "role",
      role: "button",
      name: "save",
    });
    expect(save).toMatchObject({ total: 2, visibleCount: 1, poolCount: 1 });
    expect(save.matches[0]).toMatchObject({ enabled: false, tag: "button" });
    const exact = await runProbe(adapter, {
      by: "role",
      role: "button",
      name: "save",
      exact: true,
    });
    expect(exact.total).toBe(0);
    const close = await runProbe(adapter, {
      by: "role",
      role: "button",
      name: "Close dialog",
    });
    expect(close.poolCount).toBe(1);
    const email = await runProbe(adapter, { by: "label", name: "Email" });
    expect(email.matches[0]).toMatchObject({
      tag: "input",
      value: "ops@example.test",
    });
    const country = await runProbe(adapter, {
      by: "role",
      role: "combobox",
      name: "Country",
    });
    expect(country.matches[0]?.value).toBe("Chile");
    const text = await runProbe(adapter, { by: "text", text: "order saved" });
    expect(text).toMatchObject({ poolCount: 1 });
    expect(text.matches[0]?.tag).toBe("p");
    const near = await runProbe(adapter, {
      by: "role",
      role: "button",
      name: "Open",
      near: "Globex",
    });
    expect(near.poolCount).toBe(1);
    const link = await runProbe(
      adapter,
      { by: "role", role: "link", name: "Next page" },
      { attribute: "href" },
    );
    expect(link.matches[0]).toMatchObject({
      attribute: "/orders?page=2",
      hasAttribute: true,
    });
    const bad = await runProbe(adapter, {
      by: "selector",
      selector: "[[",
    }).catch((e: Error) => e.message);
    expect(bad).toContain("invalid selector");
  });

  it("extracts tables (visible rows only) for capture and the table verifier", async () => {
    const probe = await runProbe(
      adapter,
      { by: "testid", testid: "workers" },
      { table: true, testIdAttribute: "data-qa" },
    );
    expect(probe.table).toEqual({
      headers: ["Name", "Country", "Actions"],
      rows: [
        ["Ada", "Mexico", "Edit"],
        ["", "", "Edit"],
      ],
      rowCount: 2,
    });
    const [blank] = await evaluateOutcomes(
      [
        OutcomeSchema.parse({
          id: "no_blank",
          description: "no blank worker row",
          verify: {
            table: {
              locator: { by: "testid", testid: "workers" },
              rows: { noBlank: true, ignoreCells: ["Edit"] },
            },
          },
        }),
      ],
      adapter,
      { testIdAttribute: "data-qa" },
    );
    expect(blank!.evaluation.actual).toContain("blank row(s) at index 1");
    const expectText = await runExpect(
      (
        StepSchema.parse({
          expect: { by: "text", text: "Order saved", visible: true },
        }) as { expect: never }
      ).expect,
      { backend: adapter, scope: {} },
    );
    expect(expectText.passed).toBe(true);
  });
});
