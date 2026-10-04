import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightAdapter } from "../../adapters/playwright/PlaywrightAdapter";
import { runSpec } from "../runner/Runner";
import { RunEventSchema } from "../schema/events.v1";
import { RunResultSchema } from "../schema/run.v1";
import {
  runWidgetOp,
  type PreparedWidgets,
  type WidgetOpInput,
  type WidgetOpResult,
} from "./runtime";

/**
 * The widget runtime against faithful DOM replicas of each widget (vanilla
 * JS re-implementations of vue-multiselect, PrimeVue Calendar /
 * AutoComplete / Chips / RadioButton, a "+Add" multi-text list, native
 * controls) in a real Chromium through the Playwright backend. One browser
 * for the whole file; the runSpec cases at the end launch their own, one at
 * a time.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixtureUrl = (name: string): string =>
  pathToFileURL(join(FIXTURES, name)).href;

const PREPARED: PreparedWidgets = {
  config: {
    fieldRoot: ['[data-field-key$=".{key}"]', '[name="{key}"]'],
  },
  customDrivers: [],
};

let adapter: PlaywrightAdapter;

async function op(
  input: Omit<WidgetOpInput, "timeoutMs"> & { timeoutMs?: number },
  prepared: PreparedWidgets = PREPARED,
): Promise<WidgetOpResult> {
  return runWidgetOp(adapter, prepared, {
    timeoutMs: 8000,
    mountMs: input.optional ? 500 : 3000,
    readBackMs: 2000,
    ...input,
  });
}

async function models(): Promise<Record<string, unknown>> {
  const r = await adapter.evaluate("window.__models");
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

async function events(): Promise<string[]> {
  const r = await adapter.evaluate("window.__events");
  return JSON.parse(r.stdout) as string[];
}

async function open(name: string): Promise<void> {
  const opened = await adapter.runStep({ open: fixtureUrl(name) });
  expect(opened.ok).toBe(true);
}

beforeAll(() => {
  adapter = new PlaywrightAdapter({});
});
afterAll(async () => {
  await adapter?.close();
});

describe("vue-multiselect driver (Chromium)", () => {
  beforeAll(() => open("vue-multiselect.html"), 60_000);

  it("picks an option in a long list, skips the hidden duplicate root, and is idempotent", async () => {
    const first = await op({
      op: "set",
      target: { field: "country" },
      value: "Russia",
    });
    expect(first).toMatchObject({
      ok: true,
      status: "committed",
      driver: "vue-multiselect",
      actual: "Russia",
    });
    const again = await op({
      op: "set",
      target: { field: "country" },
      value: "russia",
    });
    expect(again).toMatchObject({ ok: true, status: "already" });
    expect((await models())["country"]).toBe("Russia");
    expect((await models())["country-hidden"]).toBeUndefined();
  });

  it("clicks an option whose search filter would hide it (no typing for a short list)", async () => {
    const spend = await op({
      op: "set",
      target: { field: "spend" },
      value: "Up to 5k",
    });
    expect(spend).toMatchObject({ ok: true, actual: "Up to 5k" });
  });

  it("waits for a remote list, types the query and picks the option", async () => {
    const contact = await op({
      op: "set",
      target: { field: "owner_contact" },
      value: { query: "Grace", option: "Grace Hopper" },
    });
    expect(contact).toMatchObject({ ok: true, actual: "Grace Hopper" });
  });

  it("sets and trims a multiple selection (tags)", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "regions" },
        value: ["EMEA", "APAC"],
      }),
    ).toMatchObject({ ok: true, actual: ["EMEA", "APAC"] });
    expect(
      await op({ op: "set", target: { field: "regions" }, value: ["APAC"] }),
    ).toMatchObject({ ok: true, actual: ["APAC"] });
    expect((await models())["regions"]).toEqual(["APAC"]);
  });

  it("waits for a field that mounts after another answer (dependsOn)", async () => {
    await op({ op: "set", target: { field: "setup" }, value: "Shared entity" });
    const entity = await op({
      op: "set",
      target: { field: "entity" },
      value: "C100",
    });
    expect(entity).toMatchObject({ ok: true, actual: "C100" });
  });

  it("fails with the option list when the option does not exist", async () => {
    const missing = await op({
      op: "set",
      target: { field: "country" },
      value: "Atlantis",
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('option "Atlantis" not found');
    expect(missing.actual).toBe("Russia");
    expect(missing.root).toContain("div");
  });
});

describe("PrimeVue calendar and autocomplete drivers (Chromium)", () => {
  beforeAll(() => open("primevue.html"), 60_000);

  it("sets today through the Today button and an ISO date through month navigation", async () => {
    const today = await op({
      op: "set",
      target: { field: "start_date" },
      value: "today",
    });
    expect(today).toMatchObject({
      ok: true,
      driver: "primevue-calendar",
      via: "picker",
    });
    const future = await op({
      op: "set",
      target: { field: "start_date" },
      value: "2027-03-15",
    });
    expect(future).toMatchObject({ ok: true, actual: "03/15/2027" });
    const past = await op({
      op: "set",
      target: { field: "start_date" },
      value: "2025-12-01",
    });
    expect(past).toMatchObject({ ok: true, actual: "12/01/2025" });
    expect((await models())["start_date"]).toBe("2025-12-01");
  });

  it("types a formatted date, and reports a value the calendar dropped", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "start_date" },
        value: "04/20/2026",
      }),
    ).toMatchObject({ ok: true, via: "typed", actual: "04/20/2026" });
    const dropped = await op({
      op: "set",
      target: { field: "start_date" },
      value: "not a date",
      readBackMs: 300,
    });
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toContain("did not commit");
    expect(dropped.actual).toBe("04/20/2026");
  });

  it("uses the picker on a read-only calendar and explains a typed value", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "end_date" },
        value: "2026-11-30",
      }),
    ).toMatchObject({ ok: true, actual: "11/30/2026" });
    const typed = await op({
      op: "set",
      target: { field: "end_date" },
      value: "11/29/2026",
    });
    expect(typed.ok).toBe(false);
    expect(typed.error).toContain("read-only");
  });

  it("picks an autocomplete suggestion (query + option) and fills chips in multiple mode", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "address" },
        value: { query: "10 Ma", option: "10 Maple Avenue, Shelbyville" },
      }),
    ).toMatchObject({
      ok: true,
      driver: "primevue-autocomplete",
      actual: "10 Maple Avenue, Shelbyville",
    });
    expect(
      await op({
        op: "set",
        target: { field: "tags" },
        value: ["beta", "delta"],
      }),
    ).toMatchObject({ ok: true, actual: ["beta", "delta"] });
    const ambiguous = await op({
      op: "set",
      target: { field: "address" },
      value: "10 Ma",
    });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toContain("ambiguous");
  });
});

describe("choice, native and pills drivers (Chromium)", () => {
  beforeAll(() => open("choices.html"), 60_000);

  it("chooses radios by label or value and never re-clicks an allow-unset radio", async () => {
    expect(
      await op({ op: "choose", target: { field: "owner" }, option: "No" }),
    ).toMatchObject({ ok: true, driver: "radio-group", actual: "No" });
    expect(
      await op({ op: "choose", target: { field: "owner" }, option: "y" }),
    ).toMatchObject({ ok: true, actual: "Yes" });
    expect(
      await op({ op: "check", target: { field: "certify" }, option: "Yes" }),
    ).toMatchObject({ ok: true, status: "committed" });
    expect(
      await op({ op: "check", target: { field: "certify" }, option: "Yes" }),
    ).toMatchObject({ ok: true, status: "already" });
    expect((await models())["certify"]).toBe("Yes");
    const unset = await op({
      op: "uncheck",
      target: { field: "certify" },
      option: "Yes",
    });
    expect(unset.ok).toBe(false);
    expect(unset.error).toContain("single-choice");
    expect(
      await op({ op: "choose", target: { field: "tier" }, option: "Silver" }),
    ).toMatchObject({ ok: true, actual: "Silver" });
    expect(
      await op({ op: "choose", target: { field: "color" }, option: "Blue" }),
    ).toMatchObject({ ok: true, actual: "Blue" });
  });

  it("checks and unchecks checkbox-group options and a single checkbox", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "services" },
        value: ["Consulting", "Software"],
      }),
    ).toMatchObject({ ok: true, actual: ["Consulting", "Software"] });
    expect(
      await op({
        op: "check",
        target: { field: "services" },
        option: "Hardware",
      }),
    ).toMatchObject({
      ok: true,
      actual: ["Consulting", "Hardware", "Software"],
    });
    expect(
      await op({
        op: "uncheck",
        target: { field: "services" },
        option: "Consulting",
      }),
    ).toMatchObject({ ok: true, actual: ["Hardware", "Software"] });
    expect(await op({ op: "check", target: { field: "terms" } })).toMatchObject(
      { ok: true, actual: true },
    );
    expect(
      await op({ op: "uncheck", target: { field: "terms" } }),
    ).toMatchObject({ ok: true, actual: false });
    const choose = await op({
      op: "choose",
      target: { field: "services" },
      option: "Software",
    });
    expect(choose.error).toContain("choose picks one option");
  });

  it("sets native controls with input/change only (no focus, no keydown) and flags passwords", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "legal_name" },
        value: "Example Corp",
      }),
    ).toMatchObject({
      ok: true,
      driver: "native-input",
      actual: "Example Corp",
    });
    expect(
      await op({ op: "set", target: { field: "employees" }, value: 42 }),
    ).toMatchObject({ ok: true, actual: "42" });
    expect(
      await op({
        op: "set",
        target: { field: "founded" },
        value: "2001-02-03",
      }),
    ).toMatchObject({ ok: true, actual: "2001-02-03" });
    const secret = await op({
      op: "set",
      target: { field: "passcode" },
      value: "not-a-real-pass",
    });
    expect(secret).toMatchObject({ ok: true, sensitive: true });
    expect(
      await op({ op: "set", target: { field: "plan" }, value: "Pro" }),
    ).toMatchObject({ ok: true, driver: "native-select", actual: "Pro plan" });
    expect(
      await op({
        op: "set",
        target: { field: "languages" },
        value: ["English", "French"],
      }),
    ).toMatchObject({ ok: true, actual: ["English", "French"] });
    expect(
      await op({
        op: "set",
        target: { locator: { by: "label", name: "Legal name" } },
        value: "By Label Inc",
      }),
    ).toMatchObject({ ok: true, actual: "By Label Inc" });
    const legal = (await events()).filter((e) => e.startsWith("form.legal"));
    expect(legal).toEqual([
      "form.legal_name:input",
      "form.legal_name:change",
      "form.legal_name:input",
      "form.legal_name:change",
    ]);
  });

  it("refuses to guess between several inputs and skips an absent optional field", async () => {
    const block = await op({
      op: "set",
      target: { field: "address_block" },
      value: "x",
    });
    expect(block.ok).toBe(false);
    expect(block.error).toContain("no widget driver matches");
    expect(
      await op({
        op: "set",
        target: { field: "missing" },
        value: "x",
        optional: true,
      }),
    ).toMatchObject({ ok: true, status: "skipped", reason: "absent" });
  });

  it("adds pills through +Add (Tab commit) and PrimeVue Chips (Enter)", async () => {
    expect(
      await op({
        op: "set",
        target: { field: "products" },
        value: ["Widget A", "Widget B"],
      }),
    ).toMatchObject({ ok: true, driver: "pills" });
    expect((await models())["products"]).toEqual(["Widget A", "Widget B"]);
    expect(
      await op({
        op: "set",
        target: { field: "keywords" },
        value: ["fast", "cheap"],
      }),
    ).toMatchObject({ ok: true, actual: ["fast", "cheap"] });
  });

  it("runs a custom driver module in the page", async () => {
    const { driverModuleExpression } = await import("./runtime");
    const prepared: PreparedWidgets = {
      config: {
        ...PREPARED.config,
        drivers: [{ custom: 0, file: "drivers/title.js" }],
      },
      customDrivers: [
        {
          file: "drivers/title.js",
          expression: driverModuleExpression(
            [
              "export default {",
              '  name: "upper-text",',
              '  match: (root) => root.matches("[data-field-key$=\\".legal_name\\"]"),',
              '  read: (root) => root.querySelector("input").value.toLowerCase(),',
              "  write(root, value, ctx) {",
              '    ctx.nativeSet(root.querySelector("input"), String(value).toUpperCase());',
              "  },",
              "};",
            ].join("\n"),
            "drivers/title.js",
          ),
        },
      ],
    };
    expect(
      await op(
        { op: "set", target: { field: "legal_name" }, value: "acme" },
        prepared,
      ),
    ).toMatchObject({ ok: true, driver: "upper-text", actual: "acme" });
  });
});

describe("interaction flags (Chromium)", () => {
  beforeAll(() => open("interactions.html"), 60_000);

  it("hit-tests a covered button and dispatches a DOM click", async () => {
    const hit = await op({
      op: "click",
      mode: "hit",
      target: { locator: { by: "role", role: "button", name: "Save draft" } },
    });
    expect(hit).toMatchObject({ ok: true, status: "present" });
    expect(hit.blockedBy).toContain("p-dialog-mask");
    const clicked = await op({
      op: "click",
      mode: "dispatch",
      target: { locator: { by: "role", role: "button", name: "Save draft" } },
    });
    expect(clicked).toMatchObject({ ok: true, via: "dispatch" });
    expect((await adapter.getText("#status")).trim()).toBe("saved");
    const disabled = await op({
      op: "click",
      mode: "dispatch",
      target: { locator: { by: "selector", selector: "#disabled" } },
    });
    expect(disabled.error).toContain("is disabled");
    expect(
      await op({
        op: "probe",
        target: { locator: { by: "role", role: "button", name: "Nope" } },
        optional: true,
        mountMs: 0,
      }),
    ).toMatchObject({ ok: true, status: "skipped" });
  });

  it("fill mode: set writes without focus or keydown", async () => {
    const filled = await op({
      op: "fill",
      target: { locator: { by: "label", name: "Address line 1" } },
      value: "10 Main Street",
      settleMs: 50,
    });
    expect(filled).toMatchObject({ ok: true, via: "set" });
    const seen = await events();
    expect(seen).toEqual(["address:input", "address:change"]);
    expect(
      (await adapter.evaluate("document.getElementById('overlay').hidden"))
        .stdout,
    ).toBe("true");
  });
});

describe("read-back edge cases (Chromium)", () => {
  beforeAll(() => open("edge-cases.html"), 60_000);

  it("fails a single autocomplete whose suggestion click never selects", async () => {
    const result = await op({
      op: "set",
      target: { field: "address" },
      value: "Main Street 1",
    });
    expect(result).toMatchObject({ ok: false, status: "failed" });
    expect(result.error).toContain("stayed open");
    expect((await models())["address"]).toBeNull();
    // The typed text left in the input is not a committed value either.
    const again = await op({
      op: "set",
      target: { field: "address" },
      value: "Main Street 1",
    });
    expect(again.status).not.toBe("already");
  }, 20_000);

  it("does not count an item the +Add list rejected on blur", async () => {
    const rejected = await op({
      op: "set",
      target: { field: "emails" },
      value: ["not-an-email"],
    });
    expect(rejected).toMatchObject({ ok: false, status: "failed" });
    expect((await models())["emails"]).toEqual([]);
    const accepted = await op({
      op: "set",
      target: { field: "emails" },
      value: ["ada@example.test"],
    });
    expect(accepted).toMatchObject({ ok: true, status: "committed" });
  }, 20_000);

  it("resolves check / uncheck options like set does (partial label, typo, value attribute)", async () => {
    const checked = async (value: string): Promise<boolean> =>
      JSON.parse(
        (
          await adapter.evaluate(
            `document.querySelector('input[name=prefs][value=${value}]').checked`,
          )
        ).stdout,
      ) as boolean;
    expect(
      await op({ op: "check", target: { field: "prefs" }, option: "News" }),
    ).toMatchObject({ ok: true, status: "already" });
    const typo = await op({
      op: "uncheck",
      target: { field: "prefs" },
      option: "Newsleter",
    });
    expect(typo).toMatchObject({ ok: false });
    expect(typo.error).toContain('option "Newsleter" not found');
    expect(await checked("n")).toBe(true);
    expect(
      await op({ op: "uncheck", target: { field: "prefs" }, option: "News" }),
    ).toMatchObject({ ok: true, status: "committed" });
    expect(await checked("n")).toBe(false);
    expect(
      await op({ op: "check", target: { field: "prefs" }, option: "SMS" }),
    ).toMatchObject({ ok: true, status: "committed" });
    expect(await checked("s")).toBe(true);
    // A radio option given by its value attribute ("y" is "Yes").
    const radio = await op({
      op: "uncheck",
      target: { field: "owner_answer" },
      option: "y",
    });
    expect(radio.error).toContain("single-choice");
  }, 20_000);

  it("never toggles a single visible checkbox for another (hidden) option", async () => {
    const result = await op({
      op: "check",
      target: { field: "consent" },
      option: "Marketing emails",
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("1 hidden option(s) not considered");
    const states = JSON.parse(
      (
        await adapter.evaluate(
          "[...document.querySelectorAll('input[name=consent]')].map((i) => i.checked)",
        )
      ).stdout,
    ) as boolean[];
    expect(states).toEqual([false, false]);
    expect(
      await op({
        op: "check",
        target: { field: "consent" },
        option: "Accept terms",
      }),
    ).toMatchObject({ ok: true, status: "committed" });
  }, 20_000);

  it("searches a remote multiselect before trusting a partial-label hit", async () => {
    const result = await op({
      op: "set",
      target: { field: "owner" },
      value: "Ana",
    });
    expect(result).toMatchObject({ ok: true, actual: "Ana" });
    expect((await models())["owner"]).toBe("Ana");
  }, 20_000);

  it("finds optional targets in open shadow roots and by image alt", async () => {
    const probe = (name: string) =>
      op({
        op: "probe",
        target: { locator: { by: "role", role: "button", name } },
        optional: true,
        mountMs: 0,
      });
    expect(await probe("Continue")).toMatchObject({ status: "present" });
    expect(await probe("Dismiss")).toMatchObject({ status: "present" });
    expect(await probe("Nope")).toMatchObject({ status: "skipped" });
  }, 20_000);

  it("bounds project driver calls and refuses an async match()", async () => {
    const { driverModuleExpression } = await import("./runtime");
    const driver = (file: string, source: string[]) => ({
      file,
      expression: driverModuleExpression(source.join("\n"), file),
    });
    const hanging: PreparedWidgets = {
      config: {
        ...PREPARED.config,
        drivers: [{ custom: 0, file: "drivers/hang.js" }],
      },
      customDrivers: [
        driver("drivers/hang.js", [
          "export default {",
          '  name: "hang",',
          '  match: (root) => !!root.querySelector(".custom-widget"),',
          "  read: () => new Promise(() => {}),",
          "  write() {},",
          "};",
        ]),
      ],
    };
    const started = Date.now();
    const hung = await op(
      { op: "set", target: { field: "custom" }, value: "x", timeoutMs: 1500 },
      hanging,
    );
    expect(hung).toMatchObject({ ok: false });
    expect(hung.error).toContain("did not settle within the step budget");
    expect(Date.now() - started).toBeLessThan(6000);
    const asyncMatch: PreparedWidgets = {
      config: {
        ...PREPARED.config,
        drivers: [{ custom: 0, file: "drivers/async.js" }],
      },
      customDrivers: [
        driver("drivers/async.js", [
          "export default {",
          '  name: "async-match",',
          "  match: async () => false,",
          '  read: () => "",',
          "  write() {},",
          "};",
        ]),
      ],
    };
    const refused = await op(
      { op: "set", target: { field: "consent" }, value: true },
      asyncMatch,
    );
    expect(refused.error).toContain(
      "match() must synchronously return true or false (got a Promise)",
    );
    // The page and browser are still usable.
    expect((await adapter.evaluate("1 + 1")).stdout).toBe("2");
  }, 20_000);
});

/* ----- end to end through the runner (Playwright backend) ----- */

async function project(spec: string): Promise<{
  specPath: string;
  artifactRoot: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-widgets-e2e-"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    [
      "version: 1",
      "environments:",
      "  local: {}",
      "browser:",
      "  fieldRoot:",
      `    - '[data-field-key$=".{key}"]'`,
      "",
    ].join("\n"),
  );
  const specPath = join(dir, "flow.yml");
  await writeFile(specPath, spec);
  return { specPath, artifactRoot: join(dir, "runs") };
}

describe("widget steps through cairn run (Playwright backend)", () => {
  it("runs a form, check, click fallback and fill mode: set with evidence", async () => {
    const choices = fixtureUrl("choices.html");
    const interactions = fixtureUrl("interactions.html");
    const { specPath, artifactRoot } = await project(`version: 1
name: widgets_e2e
intent: fill a form through widget drivers
coldStart: guest
steps:
  - id: open_form
    open: ${JSON.stringify(choices)}
  - id: answer_form
    form:
      fields:
        owner: "No"
        services: [Consulting, Software]
        legal_name: Example Corp
        plan: Pro
        missing_question: { value: x, optional: true }
        follow_up: { value: y, dependsOn: missing_question }
  - id: accept_terms
    check: { field: terms }
  - id: start_task
    click: { by: role, role: button, name: Start task, optional: true }
  - id: open_flags
    open: ${JSON.stringify(interactions)}
  - id: save_draft
    click: { by: role, role: button, name: Save draft, fallback: dispatch }
  - id: address
    fill: { by: label, name: Address line 1, value: 10 Main Street, mode: set }
outcomes:
  - id: saved
    description: the covered button was clicked
    verify: { text: { contains: saved } }
`);
    const backend = new PlaywrightAdapter({});
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    const run = RunResultSchema.parse(
      JSON.parse(await readFile(join(result.runDir, "run.json"), "utf8")),
    );
    const byId = new Map(run.steps.map((s) => [s.id, s]));
    expect(byId.get("answer_form")).toMatchObject({ status: "passed" });
    expect(byId.get("accept_terms")).toMatchObject({
      status: "passed",
      driver: "checkbox-group",
    });
    expect(byId.get("start_task")).toMatchObject({
      status: "skipped",
      skipReason: "absent",
    });
    expect(byId.get("save_draft")).toMatchObject({
      status: "passed",
      via: "dispatch",
    });
    expect(byId.get("save_draft")?.detail).toContain(
      "pointer blocked by div.p-dialog-mask",
    );
    expect(byId.get("address")).toMatchObject({
      status: "passed",
      via: "set",
    });

    const formEvidence = JSON.parse(
      await readFile(
        join(result.runDir, "widgets/002_answer_form.json"),
        "utf8",
      ),
    ) as { status: string; fields: Array<Record<string, unknown>> };
    expect(formEvidence.status).toBe("passed");
    expect(
      formEvidence.fields.map((f) => [f["field"], f["status"], f["driver"]]),
    ).toEqual([
      ["owner", "committed", "radio-group"],
      ["services", "committed", "checkbox-group"],
      ["legal_name", "committed", "native-input"],
      ["plan", "committed", "native-select"],
      ["missing_question", "skipped", undefined],
      ["follow_up", "skipped", undefined],
    ]);
    expect(formEvidence.fields[3]).toMatchObject({
      expected: "Pro",
      actual: "Pro plan",
      final: { matches: true },
    });

    const runEvents = (
      await readFile(join(result.runDir, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
    const fields = runEvents.filter((e) => e.type === "widget.field");
    expect(fields).toHaveLength(7);
    expect(JSON.stringify(fields)).not.toContain("Example Corp");
    expect(
      runEvents.find(
        (e) => e.type === "step.finished" && e.stepId === "start_task",
      ),
    ).toMatchObject({ skipped: true, skipReason: "absent" });
  }, 120_000);

  it("fails a set step whose value did not commit, with evidence", async () => {
    const { specPath, artifactRoot } = await project(`version: 1
name: widgets_e2e_fail
intent: a calendar drops a typed value
coldStart: guest
steps:
  - id: open_form
    open: ${JSON.stringify(fixtureUrl("primevue.html"))}
  - id: end_date
    set: { field: end_date, value: 11/29/2026, timeoutMs: 3000 }
outcomes:
  - id: page
    description: the form page is open
    verify: { text: { contains: End date } }
`);
    const backend = new PlaywrightAdapter({});
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    const run = RunResultSchema.parse(
      JSON.parse(await readFile(join(result.runDir, "run.json"), "utf8")),
    );
    const step = run.steps.find((s) => s.id === "end_date");
    expect(step?.status).toBe("failed");
    expect(step?.error).toContain('set field "end_date"');
    expect(step?.error).toContain("read-only");
    const evidence = JSON.parse(
      await readFile(join(result.runDir, "widgets/002_end_date.json"), "utf8"),
    ) as { fields: Array<Record<string, unknown>> };
    expect(evidence.fields[0]).toMatchObject({
      field: "end_date",
      status: "failed",
      driver: "primevue-calendar",
      expected: "11/29/2026",
      actual: "",
    });
  }, 120_000);
});
