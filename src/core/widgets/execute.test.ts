import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InvocationResult } from "../../adapters/browserBackend";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { runSpec } from "../runner/Runner";
import { RunEventSchema, type RunEvent } from "../schema/events.v1";
import { RunResultSchema } from "../schema/run.v1";
import type { Step } from "../schema/spec.v1";
import {
  widgetRuntimeSource,
  type WidgetOpInput,
  type WidgetOpResult,
} from "./runtime";

/**
 * Runner glue for the widget kit and the click / fill flags against a mock
 * backend that answers widget-runtime evaluations from a script: evidence
 * files, run.json fields, events, form ordering, re-read, dumps, masking.
 */

type Answer = (input: WidgetOpInput & { config?: unknown }) => WidgetOpResult;

/** Mock whose evaluate() decodes widget-runtime calls and answers them. */
class WidgetBackend extends MockBrowserBackend {
  readonly ops: Array<WidgetOpInput & { config?: unknown }> = [];
  constructor(private readonly answer: Answer) {
    super();
  }
  override async evaluate(
    js: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<InvocationResult> {
    const runtime = widgetRuntimeSource();
    const at = js.indexOf(runtime);
    if (at < 0) return super.evaluate(js, opts);
    const start = at + runtime.length + 2; // `)(`
    const end = js.lastIndexOf(", __cairnCustomDrivers");
    const input = JSON.parse(js.slice(start, end)) as WidgetOpInput;
    this.ops.push(input);
    return {
      ok: true,
      stdout: JSON.stringify(this.answer(input)),
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      argv: ["eval"],
    };
  }
}

async function project(
  steps: string,
  config = "",
): Promise<{ specPath: string; artifactRoot: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-widgets-"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1\nenvironments:\n  local: {}\n${config}`,
  );
  const specPath = join(dir, "flow.yml");
  await writeFile(
    specPath,
    `version: 1
name: widgets
intent: widget steps
coldStart: guest
steps:
${steps}
outcomes:
  - id: no_errors
    description: no console errors
    verify: { console: { errorsMax: 0 } }
`,
  );
  return { specPath, artifactRoot: join(dir, "runs"), dir };
}

async function runJson(runDir: string) {
  return RunResultSchema.parse(
    JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
  );
}

async function events(runDir: string): Promise<RunEvent[]> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

const committed = (
  input: WidgetOpInput,
  extra: Partial<WidgetOpResult> = {},
): WidgetOpResult => ({
  ok: true,
  status: "committed",
  driver: "native-input",
  expected: input.value,
  actual: input.value,
  durationMs: 3,
  ...extra,
});

describe("set / check / choose steps", () => {
  it("records driver, evidence and a widget.field event (never the value)", async () => {
    const backend = new WidgetBackend((input) =>
      committed(input, { driver: "vue-multiselect", root: "div.question" }),
    );
    const { specPath, artifactRoot } = await project(
      `  - id: pick_country\n    set: { field: country, value: Spain }`,
      `browser:\n  testIdAttribute: data-qa\n  fieldRoot: '[data-field="{key}"]'\n`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.ops[0]).toMatchObject({
      op: "set",
      target: { field: "country" },
      value: "Spain",
      timeoutMs: 10000,
      mountMs: 10000,
      config: {
        fieldRoot: ['[data-field="{key}"]'],
        testIdAttribute: "data-qa",
      },
    });
    const run = await runJson(result.runDir);
    expect(run.steps[0]).toMatchObject({
      id: "pick_country",
      status: "passed",
      driver: "vue-multiselect",
    });
    expect(run.steps[0]!.artifacts).toContain("widgets/001_pick_country.json");
    const evidence = JSON.parse(
      await readFile(
        join(result.runDir, "widgets/001_pick_country.json"),
        "utf8",
      ),
    );
    expect(evidence).toMatchObject({
      version: 1,
      kind: "set",
      status: "passed",
      fields: [
        {
          field: "country",
          status: "committed",
          driver: "vue-multiselect",
          expected: "Spain",
          actual: "Spain",
        },
      ],
    });
    const fieldEvents = (await events(result.runDir)).filter(
      (e) => e.type === "widget.field",
    );
    expect(fieldEvents).toEqual([
      expect.objectContaining({
        stepId: "pick_country",
        field: "country",
        driver: "vue-multiselect",
        status: "committed",
        path: "widgets/001_pick_country.json",
      }),
    ]);
    expect(JSON.stringify(fieldEvents)).not.toContain("Spain");
    const started = (await events(result.runDir)).find(
      (e) => e.type === "step.started",
    );
    expect(started).toMatchObject({
      kind: "set",
      label: 'set field "country"',
    });
  });

  it("fails the step with the committed value as evidence and writes diagnostics", async () => {
    const backend = new WidgetBackend((input) => ({
      ok: false,
      status: "failed",
      driver: "primevue-calendar",
      expected: input.value,
      actual: "",
      error: 'primevue-calendar did not commit "2026-11-30"; field shows ""',
      rootText: "End date",
    }));
    const { specPath, artifactRoot } = await project(
      `  - id: end_date\n    set: { field: end_date, value: "2026-11-30" }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    const step = (await runJson(result.runDir)).steps[0]!;
    expect(step).toMatchObject({
      status: "failed",
      driver: "primevue-calendar",
    });
    expect(step.error).toBe(
      'set field "end_date": primevue-calendar did not commit "2026-11-30"; field shows ""',
    );
    expect(step.artifacts).toContain("widgets/001_end_date.json");
    expect(step.artifacts?.some((a) => a.startsWith("diagnostics/"))).toBe(
      true,
    );
    expect(
      await readFile(join(result.runDir, "agent_context.md"), "utf8"),
    ).toContain("widgets/001_end_date.json");
  });

  it("skips an optional absent field (status skipped, skipReason) without failure captures", async () => {
    const backend = new WidgetBackend(() => ({
      ok: true,
      status: "skipped",
      reason: "absent",
    }));
    const { specPath, artifactRoot } = await project(
      `  - id: legacy\n    choose: { field: legacy, option: "No", optional: true }\n  - id: after\n    check: { by: label, name: Terms }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.ops[0]).toMatchObject({
      op: "choose",
      option: "No",
      optional: true,
      mountMs: 750,
    });
    expect(backend.ops[1]).toMatchObject({
      op: "check",
      target: { locator: { by: "label", name: "Terms" } },
    });
    const run = await runJson(result.runDir);
    expect(run.steps[0]).toMatchObject({
      status: "skipped",
      skipReason: "absent",
    });
    expect(
      run.steps[0]!.artifacts?.some((a) => a.startsWith("diagnostics/")),
    ).toBeFalsy();
    const finished = (await events(result.runDir)).find(
      (e) => e.type === "step.finished" && e.stepId === "legacy",
    );
    expect(finished).toMatchObject({ skipped: true, skipReason: "absent" });
  });

  it("masks values of sensitive fields and password controls in evidence", async () => {
    const backend = new WidgetBackend((input) =>
      committed(input, {
        sensitive:
          input.target && "field" in input.target
            ? input.target.field === "pin_field"
            : false,
        rootText: "Secret area",
      }),
    );
    const { specPath, artifactRoot } = await project(
      `  - set: { field: api_token, value: abcdef123456 }\n  - set: { field: pin_field, value: "4321" }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    const files = (await runJson(result.runDir)).steps.flatMap(
      (s) => s.artifacts ?? [],
    );
    const text = (
      await Promise.all(
        files
          .filter((f) => f.startsWith("widgets/"))
          .map((f) => readFile(join(result.runDir, f), "utf8")),
      )
    ).join("\n");
    expect(text).not.toContain("abcdef123456");
    expect(text).not.toContain("4321");
    expect(text).not.toContain("Secret area");
    expect(text).toContain("[redacted]");
  });

  it("keeps a sensitive field's value out of the step error", async () => {
    const backend = new WidgetBackend((input) => ({
      ok: false,
      status: "failed",
      driver: "native-input",
      expected: input.value,
      actual: "",
      sensitive: true,
      error: `native-input did not commit ${JSON.stringify(input.value)}; field shows ""`,
    }));
    const { specPath, artifactRoot } = await project(
      `  - id: passcode\n    set: { field: passcode, value: hunter2hunter2 }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    const step = (await runJson(result.runDir)).steps[0]!;
    expect(step.error).toBe(
      'set field "passcode": native-input did not commit [redacted]; field shows ""',
    );
    const log = await readFile(join(result.runDir, "events.ndjson"), "utf8");
    expect(log).not.toContain("hunter2hunter2");
  });

  it("scales budgets by waitScale and honours driver / timeoutMs", async () => {
    const backend = new WidgetBackend((input) => committed(input));
    const { specPath, artifactRoot } = await project(
      `  - set: { by: selector, selector: "#qty", value: 3, driver: native-input, timeoutMs: 4000 }`,
      "",
    );
    await writeFile(
      join(specPath, "..", "cairntrace.config.yml"),
      "version: 1\nenvironments:\n  local:\n    waitScale: 2\n",
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.ops[0]).toMatchObject({
      driver: "native-input",
      timeoutMs: 8000,
      mountMs: 8000,
      readBackMs: 4000,
      target: { locator: { by: "selector", selector: "#qty" } },
      value: 3,
    });
  });

  it("fails clearly when a custom driver module does not load", async () => {
    const backend = new WidgetBackend((input) => committed(input));
    const { specPath, artifactRoot, dir } = await project(
      `  - set: { field: country, value: Spain }`,
      "browser:\n  widgets:\n    - file: ./drivers/broken.js\n",
    );
    await mkdir(join(dir, "drivers"));
    await writeFile(
      join(dir, "drivers", "broken.js"),
      "export const name = 'x';\n",
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    const step = (await runJson(result.runDir)).steps[0]!;
    expect(step.error).toContain("widgets: ./drivers/broken.js");
    expect(step.error).toContain("export default");
    expect(backend.ops).toHaveLength(0);
  });
});

const formSpec = (extra = "") => `  - id: answer_form
    form:
      fields:
        owner: "No"
        contact: { value: { query: Ada, option: Ada Lovelace }, dependsOn: owner }
        legacy: { value: "No", optional: true }
        legacy_reason: { value: x, dependsOn: legacy }
        country: Spain
${extra}`;

describe("form step", () => {
  it("runs fields in order, skips dependents of a skipped field, then re-reads every written field", async () => {
    const backend = new WidgetBackend((input) => {
      if (input.op === "readMany") {
        return {
          ok: true,
          status: "read",
          results: (input.targets ?? []).map(() => ({
            ok: true,
            status: "present",
            matches: true,
          })),
        };
      }
      const key =
        input.target && "field" in input.target ? input.target.field : "";
      if (key === "legacy")
        return { ok: true, status: "skipped", reason: "absent" };
      return committed(input, { driver: "radio-group" });
    });
    const { specPath, artifactRoot } = await project(formSpec());
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(
      backend.ops.map((o) =>
        o.op === "readMany"
          ? `readMany:${(o.targets ?? []).map((t) => ("field" in t.target ? t.target.field : "")).join(",")}`
          : `${o.op}:${
              o.target && "field" in o.target ? o.target.field : ""
            }:${o.mountMs}`,
      ),
    ).toEqual([
      "set:owner:10000",
      "set:contact:10000",
      "set:legacy:750",
      "set:country:10000",
      "readMany:owner,contact,country",
    ]);
    const evidence = JSON.parse(
      await readFile(
        join(result.runDir, "widgets/001_answer_form.json"),
        "utf8",
      ),
    );
    expect(
      evidence.fields.map((f: { field: string; status: string }) => [
        f.field,
        f.status,
      ]),
    ).toEqual([
      ["owner", "committed"],
      ["contact", "committed"],
      ["legacy", "skipped"],
      ["legacy_reason", "skipped"],
      ["country", "committed"],
    ]);
    expect(evidence.fields[3].reason).toBe("dependsOn legacy was skipped");
    expect(evidence.fields[0].final).toEqual({
      status: "present",
      matches: true,
    });
    const fieldEvents = (await events(result.runDir)).filter(
      (e) => e.type === "widget.field",
    );
    expect(
      fieldEvents.map((e) => e.type === "widget.field" && e.field),
    ).toEqual(["owner", "contact", "legacy", "legacy_reason", "country"]);
  });

  it("fails when a later field wiped an earlier one, and dumps unanswered fields", async () => {
    const backend = new WidgetBackend((input) => {
      if (input.op === "readMany") {
        return {
          ok: true,
          status: "read",
          results: (input.targets ?? []).map((t) => ({
            ok: true,
            status: "present",
            actual:
              "field" in t.target && t.target.field === "owner" ? "" : "x",
            matches: !("field" in t.target && t.target.field === "owner"),
          })),
        };
      }
      if (input.op === "dump") {
        return {
          ok: true,
          status: "dumped",
          total: 9,
          unanswered: [
            {
              key: "owner",
              driver: "radio-group",
              required: true,
              label: "Owner *",
            },
          ],
        };
      }
      return committed(input);
    });
    const { specPath, artifactRoot } = await project(
      formSpec("      onFailure: dumpUnanswered\n"),
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    const step = (await runJson(result.runDir)).steps[0]!;
    expect(step.error).toBe(
      'form field "owner" lost its value after later fields were set (shows "")',
    );
    const evidence = JSON.parse(
      await readFile(
        join(result.runDir, "widgets/001_answer_form.json"),
        "utf8",
      ),
    );
    expect(evidence.unanswered).toEqual({
      total: 9,
      fields: [
        {
          key: "owner",
          driver: "radio-group",
          required: true,
          label: "Owner *",
        },
      ],
    });
    expect(evidence.fields[0].final).toMatchObject({ matches: false });
  });

  it("stops at the first failing field and writes only (no re-read) with verify: none", async () => {
    const backend = new WidgetBackend((input) =>
      input.target &&
      "field" in input.target &&
      input.target.field === "contact"
        ? { ok: false, status: "failed", error: "option not found" }
        : { ok: true, status: "written", driver: "native-input" },
    );
    const { specPath, artifactRoot } = await project(
      formSpec("      verify: none\n"),
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("failed");
    expect(backend.ops.map((o) => o.op)).toEqual(["set", "set"]);
    expect(backend.ops[0]).toMatchObject({ verify: false });
    expect((await runJson(result.runDir)).steps[0]!.error).toBe(
      'form field "contact": option not found',
    );
  });
});

describe("click and fill flags", () => {
  /** Answers probes / hit-tests / dispatches; records backend runStep calls. */
  class FlagBackend extends WidgetBackend {
    readonly dispatched: Step[] = [];
  }

  it("skips an absent optional click without touching the backend", async () => {
    const backend = new FlagBackend(() => ({
      ok: true,
      status: "skipped",
      reason: "absent",
    }));
    const { specPath, artifactRoot } = await project(
      `  - id: start\n    click: { by: role, role: button, name: Start task, optional: true }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    // The optional-field presence window (750ms × waitScale), not one look.
    expect(backend.ops[0]).toMatchObject({ op: "probe", mountMs: 750 });
    expect(backend.stepLog.filter((s) => "click" in s)).toHaveLength(0);
    expect((await runJson(result.runDir)).steps[0]).toMatchObject({
      status: "skipped",
      skipReason: "absent",
    });
  });

  it("clicks a present optional target through the backend without the flags", async () => {
    const backend = new FlagBackend(() => ({ ok: true, status: "present" }));
    const { specPath, artifactRoot } = await project(
      `  - click: { by: role, role: button, name: Start task, optional: true }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    const clicks = backend.stepLog.filter((s) => "click" in s);
    expect(clicks).toEqual([
      { click: { by: "role", role: "button", name: "Start task" } },
    ]);
  });

  it("dispatch: true fires the DOM click in the page", async () => {
    const backend = new FlagBackend(() => ({
      ok: true,
      status: "clicked",
      via: "dispatch",
    }));
    const { specPath, artifactRoot } = await project(
      `  - click: { by: selector, selector: "#save", dispatch: true }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.ops[0]).toMatchObject({ op: "click", mode: "dispatch" });
    expect(backend.stepLog.filter((s) => "click" in s)).toHaveLength(0);
    expect((await runJson(result.runDir)).steps[0]).toMatchObject({
      via: "dispatch",
    });
  });

  it("fallback: dispatch records the blocking element when the pointer is covered", async () => {
    const backend = new FlagBackend((input) =>
      input.mode === "hit"
        ? { ok: true, status: "present", blockedBy: "div.p-dialog-mask" }
        : { ok: true, status: "clicked", via: "dispatch" },
    );
    const { specPath, artifactRoot } = await project(
      `  - id: save\n    click: { by: role, role: button, name: Save, fallback: dispatch }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    const step = (await runJson(result.runDir)).steps[0]!;
    expect(step).toMatchObject({
      via: "dispatch",
      detail: "pointer blocked by div.p-dialog-mask",
    });
    const finished = (await events(result.runDir)).find(
      (e) => e.type === "step.finished" && e.stepId === "save",
    );
    expect(finished).toMatchObject({
      via: "dispatch",
      detail: "pointer blocked by div.p-dialog-mask",
    });
  });

  it("fallback: dispatch uses the pointer when nothing covers the target, and falls back when it fails", async () => {
    const ok = new FlagBackend(() => ({ ok: true, status: "present" }));
    const first = await project(
      `  - click: { by: role, role: button, name: Save, fallback: dispatch }`,
    );
    const passed = await runSpec({
      specPath: first.specPath,
      artifactRoot: first.artifactRoot,
      backend: ok,
    });
    expect((await runJson(passed.runDir)).steps[0]).toMatchObject({
      status: "passed",
      via: "pointer",
    });

    const failing = new FlagBackend((input) =>
      input.mode === "hit"
        ? { ok: true, status: "present" }
        : { ok: true, status: "clicked", via: "dispatch" },
    );
    failing.failNextStep("locator.click: Timeout 5000ms exceeded");
    const second = await project(
      `  - click: { by: role, role: button, name: Save, fallback: dispatch }`,
    );
    const fellBack = await runSpec({
      specPath: second.specPath,
      artifactRoot: second.artifactRoot,
      backend: failing,
    });
    const step = (await runJson(fellBack.runDir)).steps[0]!;
    expect(step).toMatchObject({ status: "passed", via: "dispatch" });
    expect(step.detail).toBe(
      "pointer click failed: locator.click: Timeout 5000ms exceeded",
    );
  });

  it("fill mode: set writes in the page; fill.optional skips an absent control", async () => {
    const backend = new FlagBackend((input) =>
      input.op === "probe"
        ? { ok: true, status: "skipped", reason: "absent" }
        : { ok: true, status: "committed", via: "set", actual: "10 Main" },
    );
    const { specPath, artifactRoot } = await project(
      `  - id: address\n    fill: { by: label, name: Address, value: 10 Main, mode: set }\n  - id: referral\n    fill: { by: label, name: Referral, value: X, optional: true }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.ops[0]).toMatchObject({
      op: "fill",
      value: "10 Main",
      verify: true,
      attempts: 4,
    });
    expect(backend.stepLog.filter((s) => "fill" in s)).toHaveLength(0);
    const steps = (await runJson(result.runDir)).steps;
    expect(steps[0]).toMatchObject({ status: "passed", via: "set" });
    expect(steps[1]).toMatchObject({ status: "skipped", skipReason: "absent" });
  });

  it("supports flagged clicks in teardown", async () => {
    const backend = new FlagBackend(() => ({
      ok: true,
      status: "skipped",
      reason: "absent",
    }));
    const { specPath, artifactRoot } = await project(
      `  - open: /x\nteardown:\n  - click: { by: role, role: button, name: Discard, optional: true }`,
    );
    const result = await runSpec({ specPath, artifactRoot, backend });
    expect(result.status).toBe("passed");
    expect(backend.ops.map((o) => o.op)).toEqual(["probe"]);
    expect(backend.stepLog.filter((s) => "click" in s)).toHaveLength(0);
  });
});
