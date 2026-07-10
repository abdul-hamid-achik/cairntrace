import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Step } from "../schema/spec.v1";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { parse as parseYaml } from "yaml";
import { applyPatchOps, healSpec, healVerify, proposeOps } from "./Healer";
import { parseSnapshot } from "./snapshotParser";

const SNAPSHOT_WITH_RENAMED_LINK = `
- banner
  - heading "Home" [level=1, ref=e1]
- main
  - link "Open dashboard" [ref=e2]
`;

describe("proposeOps", () => {
  it("proposes a name replacement when a single role match exists", () => {
    const step: Step = {
      id: "click_link",
      click: { by: "role", role: "link", name: "Dashboard link" },
    };
    const snap = parseSnapshot(SNAPSHOT_WITH_RENAMED_LINK);
    const ops = proposeOps(step, 1, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/1/click/name",
      from: "Dashboard link",
      to: "Open dashboard",
    });
  });

  it("returns no ops when the locator already matches", () => {
    const step: Step = {
      click: { by: "role", role: "link", name: "Open dashboard" },
    };
    const snap = parseSnapshot(SNAPSHOT_WITH_RENAMED_LINK);
    expect(proposeOps(step, 0, snap)).toHaveLength(0);
  });

  it("returns no ops when no element with the requested role exists", () => {
    const step: Step = {
      click: { by: "role", role: "button", name: "Anything" },
    };
    const snap = parseSnapshot(SNAPSHOT_WITH_RENAMED_LINK);
    expect(proposeOps(step, 0, snap)).toHaveLength(0);
  });

  it("picks the closest name when multiple candidates exist", () => {
    const snap = parseSnapshot(`
- main
  - button "Cancel"
  - button "Apply coupon"
  - button "Reset filters"
`);
    const step: Step = {
      click: { by: "role", role: "button", name: "Apply" },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { to: string }).to).toBe("Apply coupon");
  });

  it("heals hover locator drift", () => {
    const snap = parseSnapshot(`
- main
  - button "Table options"
`);
    const step: Step = {
      hover: { by: "role", role: "button", name: "Table actions" },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/0/hover/name",
      from: "Table actions",
      to: "Table options",
    });
  });

  it("heals download locator drift", () => {
    const snap = parseSnapshot(`
- main
  - button "Download template"
`);
    const step: Step = {
      download: {
        by: "role",
        role: "button",
        name: "Download xlsx",
        saveAs: "template.xlsx",
        assign: "template",
      },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/0/download/name",
      from: "Download xlsx",
      to: "Download template",
    });
  });

  it("does nothing for selector locators (v0 scope)", () => {
    const snap = parseSnapshot(SNAPSHOT_WITH_RENAMED_LINK);
    expect(
      proposeOps({ click: { by: "selector", selector: "#missing" } }, 0, snap),
    ).toHaveLength(0);
  });

  /* --- v0.4: label / text / wait-insertion --- */

  it("heals by: label drift via name", () => {
    const snap = parseSnapshot(`
- main
  - textbox "Email address" [ref=e1]
`);
    const step: Step = {
      fill: { by: "label", name: "Email", value: "a@b.c" },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/0/fill/name",
      from: "Email",
      to: "Email address",
    });
  });

  it("heals by: text drift via text", () => {
    const snap = parseSnapshot(`
- main
  - link "Open dashboard"
`);
    const step: Step = {
      click: { by: "text", text: "Open dash" },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/0/click/text",
      from: "Open dash",
      to: "Open dashboard",
    });
  });

  it("proposes a wait insertion when no candidate matches and previous step isn't a wait", () => {
    // Snapshot has no `link` at all.
    const snap = parseSnapshot(`
- main
  - heading "Loading…"
`);
    const step: Step = {
      click: { by: "role", role: "link", name: "Open dashboard" },
    };
    const ops = proposeOps(step, 1, snap, {
      allSteps: [{ open: "/" }, step],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "insert",
      path: "/steps/1",
    });
    expect(
      (ops[0] as { value: { wait: { text: string } } }).value.wait.text,
    ).toBe("Open dashboard");
  });

  it("does not propose a wait insertion if previous step is already a wait", () => {
    const snap = parseSnapshot(`- main\n  - heading "Loading…"`);
    const step: Step = {
      click: { by: "role", role: "link", name: "Open dashboard" },
    };
    const ops = proposeOps(step, 1, snap, {
      allSteps: [{ wait: { text: "Anything" } }, step],
    });
    expect(ops).toHaveLength(0);
  });
});

describe("applyPatchOps", () => {
  const source = `steps:
  - id: open_home
    open: /
  - id: click_apply
    click: { by: role, role: button, name: Apply }
  - id: done
    click: { by: role, role: button, name: Done }
`;

  it("splices an inserted wait as a NEW sibling step (does not corrupt steps[N])", () => {
    // Regression: addIn(["steps", 1], …) merged the wait INTO steps[1] as a
    // complex mapping key, producing an unparseable file. Use the real op
    // proposeOps emits.
    const step: Step = {
      click: { by: "role", role: "button", name: "Apply" },
    };
    const ops = proposeOps(
      step,
      1,
      parseSnapshot(`- main\n  - heading "Loading…"`),
      {
        allSteps: [{ open: "/" }, step],
      },
    );
    expect(ops[0]).toMatchObject({ op: "insert", path: "/steps/1" });

    const out = applyPatchOps(source, ops);
    const reparsed = parseYaml(out) as { steps: { id: string }[] };
    expect(reparsed.steps.map((s) => s.id)).toEqual([
      "open_home",
      "wait_for_apply",
      "click_apply",
      "done",
    ]);
    // The shifted step is intact, not merged into.
    expect(reparsed.steps[2]).toMatchObject({ id: "click_apply" });
  });

  it("replace preserves surrounding formatting and other steps", () => {
    const out = applyPatchOps(source, [
      {
        op: "replace",
        path: "/steps/1/click/name",
        from: "Apply",
        to: "Apply coupon",
        reason: "test",
      },
    ]);
    const reparsed = parseYaml(out) as {
      steps: { click?: { name: string } }[];
    };
    expect(reparsed.steps[1]!.click!.name).toBe("Apply coupon");
    expect(reparsed.steps.map((s) => (s as { id: string }).id)).toEqual([
      "open_home",
      "click_apply",
      "done",
    ]);
  });
});

describe("healSpec — eval steps", () => {
  let workDir: string;

  it("returns no-heal-possible when the failed step is an eval step", async () => {
    workDir = await mkdtemp(join(tmpdir(), "cairntrace-heal-eval-"));
    const specPath = join(workDir, "eval_fail.yml");
    await writeFile(
      specPath,
      `version: 1
name: eval_heal_skip
intent: eval steps should not be healed
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: bad_eval
    eval:
      js: "throw new Error('eval boom')"
      assign: broken
`,
    );

    // Override evaluate() to return a failure so the eval step fails.
    const failingBackend = new MockBrowserBackend();
    (
      failingBackend as unknown as { evaluate: () => Promise<unknown> }
    ).evaluate = async () => ({
      ok: false,
      stdout: "",
      stderr: "eval boom",
      exitCode: 1,
      durationMs: 0,
      argv: ["eval"],
    });

    const result = await healSpec({
      specPath,
      backend: failingBackend as MockBrowserBackend,
    });

    expect(result.status).toBe("no-heal-possible");
    expect(result.exitCode).toBe(5);
    expect(result.summary).toContain("eval steps are not healable");
    expect(result.ops).toEqual([]);
  });
});

describe("healVerify — transactional heal (SPEC §7.2)", () => {
  let workDir: string;

  it("verifies and accepts a heal when the rerun passes", async () => {
    workDir = await mkdtemp(join(tmpdir(), "cairntrace-heal-verify-"));
    const specPath = join(workDir, "drift.yml");
    // A spec with a role+name that doesn't match the mock backend's page.
    // The mock backend returns a snapshot with role=button name="Submit Form"
    // when the spec says name="Submit" — heal should propose name → "Submit Form".
    await writeFile(
      specPath,
      `version: 1
name: heal_verify
intent: verify a heal end-to-end
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: click_submit
    click:
      by: role
      role: button
      name: Submit
`,
    );

    // Configure the mock backend to fail the first step (name mismatch) but
    // pass after the heal (name corrected to "Submit Form").
    const backend = new MockBrowserBackend();
    backend.setUrl("/form");
    // The mock will fail the click because the name doesn't match, then the
    // heal proposes the on-page name. After patching, the rerun should pass
    // because the mock doesn't actually check the name on click — it just
    // records the step. So the rerun passes (no step failure).
    //
    // Actually, MockBrowserBackend.click always succeeds (it records the step
    // and returns ok). So the first run should ALSO pass. To get a failing
    // first run, we need to make the step fail. Let's use a failNextStep.
    backend.failNextStep("click failed: element not found");

    const vr = await healVerify({ specPath, backend });

    // The first run fails (failNextStep), heal proposes ops based on the
    // snapshot, the rerun (with the patched spec) should pass because
    // failNextStep only fires once.
    expect(vr.ops.length).toBeGreaterThan(0);
    expect(vr.beforeRun).toBeTruthy();
    expect(vr.afterRun).toBeTruthy();
    // The rerun should pass (failNextStep was consumed by the first run).
    expect(vr.verified).toBe(true);
    expect(vr.confidence).toBe("high");
    expect(vr.evidence).toBeTruthy();
    expect(vr.replay).toContain("cairn run");
  });

  it("rolls back when the rerun still fails", async () => {
    workDir = await mkdtemp(join(tmpdir(), "cairntrace-heal-verify-rollback-"));
    const specPath = join(workDir, "drift_rollback.yml");
    await writeFile(
      specPath,
      `version: 1
name: heal_verify_rollback
intent: verify rollback when rerun still fails
outcomes:
  - id: ok
    description: ok
    verify:
      url: { equals: "https://example.com/never" }
steps:
  - id: click_submit
    click:
      by: role
      role: button
      name: Submit
`,
    );

    const backend = new MockBrowserBackend();
    backend.setUrl("/form");
    backend.failNextStep("click failed: element not found");

    const vr = await healVerify({ specPath, backend });

    // The first run fails (failNextStep). Heal proposes ops. The rerun's
    // step passes (failNextStep consumed), but the outcome (url equals never)
    // fails → verified=false, rollback.
    expect(vr.verified).toBe(false);
    expect(vr.confidence).toBe("low");
    expect(vr.reason).toBeTruthy();

    // The original spec should still have "Submit" (rolled back).
    const afterSpec = await readFile(specPath, "utf8");
    expect(afterSpec).toContain("name: Submit");
  });
});
