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
      click: { by: "role", role: "link", name: "Open dashboards" },
    };
    const snap = parseSnapshot(SNAPSHOT_WITH_RENAMED_LINK);
    const ops = proposeOps(step, 1, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/1/click/name",
      from: "Open dashboards",
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

  /* --- similarity / uniqueness gate --- */

  it("refuses a rename when the only candidate is dissimilar (no confident match)", () => {
    // The real target ("Apply") is gone and only an unrelated same-role button
    // remains. Healing to it would retarget a clean failure onto the wrong
    // element — a passing-but-WRONG spec.
    const snap = parseSnapshot(`
- main
  - button "Cancel"
`);
    const step: Step = {
      click: { by: "role", role: "button", name: "Apply" },
    };
    expect(proposeOps(step, 0, snap)).toHaveLength(0);
  });

  it("still heals a genuinely similar rename", () => {
    const snap = parseSnapshot(`
- main
  - button "Submit Form"
`);
    const step: Step = {
      click: { by: "role", role: "button", name: "Submit" },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/0/click/name",
      from: "Submit",
      to: "Submit Form",
    });
  });

  it("refuses a rename when multiple candidates tie for closest", () => {
    // "Sage" and "Safe" are equidistant from "Save" — ambiguous, so heal must
    // not guess between them.
    const snap = parseSnapshot(`
- main
  - button "Sage"
  - button "Safe"
`);
    const step: Step = {
      click: { by: "role", role: "button", name: "Save" },
    };
    expect(proposeOps(step, 0, snap)).toHaveLength(0);
  });

  it("does not retarget a by: label locator onto a non-control role", () => {
    // Only a heading carries a similar name; labels bind to form controls, so
    // the heading must not be treated as a heal candidate.
    const snap = parseSnapshot(`
- main
  - heading "Email address" [level=1]
`);
    const step: Step = {
      fill: { by: "label", name: "Email", value: "a@b.c" },
    };
    expect(proposeOps(step, 0, snap)).toHaveLength(0);
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

  it("heals select locator drift", () => {
    const snap = parseSnapshot(`
- main
  - combobox "Billing plan" [ref=e3]
`);
    const step: Step = {
      select: { by: "label", name: "Plan", value: "pro" },
    };
    const ops = proposeOps(step, 0, snap);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "replace",
      path: "/steps/0/select/name",
      from: "Plan",
      to: "Billing plan",
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

const snapOf = (role: string, names: string[]) =>
  parseSnapshot(names.map((n) => `- ${role} "${n}"`).join("\n"));

describe("proposeOps — rename safety", () => {
  const healTo = (
    role: string,
    name: string,
    names: string[],
  ): string | undefined => {
    const step: Step = { click: { by: "role", role, name } };
    const op = proposeOps(step, 0, snapOf(role, names))[0];
    return op?.op === "replace" ? String(op.to) : undefined;
  };

  it("heals the demo rename: 'Dashboard' → 'Open dashboard' among other links", () => {
    expect(
      healTo("link", "Dashboard", [
        "Open dashboard",
        "Products",
        "Documents",
        "Form controls",
        "Vendor profile",
        "Sign in",
      ]),
    ).toBe("Open dashboard");
  });

  // Reordered or re-qualified words are NOT healed: "Open issues" may be a
  // status filter, "Open account" a create action, "Celsius to Fahrenheit"
  // the opposite direction. A wrong heal leaves a passing-but-wrong spec.
  it.each([
    [
      "two candidates contain the words",
      "link",
      "Dashboard link",
      ["Open the dashboard", "Go to dashboard"],
    ],
    [
      "the name has no trailing role word",
      "link",
      "Reports overview",
      ["Overview of reports", "Help"],
    ],
    [
      "the trailing word is another role",
      "button",
      "Dashboard link",
      ["Open dashboard"],
    ],
    ["only the role word is left", "link", "Link", ["Open dashboard"]],
    [
      "the content word is a number",
      "link",
      "2 link",
      ["Page 12", "Step 2 of 5"],
    ],
    [
      "the content word is one letter",
      "button",
      "A button",
      ["Option A", "Help"],
    ],
    ["a sign differs", "button", "+1 button", ["-1", "+2"]],
    [
      "the candidate deletes",
      "link",
      "Account link",
      ["Delete account", "Products"],
    ],
    [
      "the candidate cancels",
      "link",
      "Subscription link",
      ["Cancel subscription"],
    ],
    [
      "the candidate disables",
      "link",
      "Notifications link",
      ["Disable notifications"],
    ],
    ["the candidate negates", "button", "Save button", ["Don't save", "Help"]],
    [
      "the candidate negates without an apostrophe",
      "button",
      "Save button",
      ["Dont save"],
    ],
    ["the candidate ends the session", "link", "Session link", ["End session"]],
    [
      "the candidate signs out",
      "link",
      "Account link",
      ["Sign out of account"],
    ],
    ["the words are missing", "button", "Submit button", ["Cancel", "Reset"]],
    ["a sign differs on a word", "button", "+ab button", ["-ab", "Help"]],
    [
      "the candidate negates with a curly apostrophe",
      "button",
      "Save button",
      ["Don\u2019t save", "Help"],
    ],
    [
      "the candidate signs out (hyphenated)",
      "link",
      "Account link",
      ["Sign-out of account", "Products"],
    ],
    [
      "the candidate refunds",
      "button",
      "Order button",
      ["Refund order", "Help", "Print invoice"],
    ],
    [
      "the candidate pauses",
      "button",
      "Subscription button",
      ["Pause subscription", "Billing history"],
    ],
    [
      "the candidate turns off",
      "switch",
      "Notifications switch",
      ["Turn off notifications", "Dark mode"],
    ],
    [
      "the candidate unlinks",
      "link",
      "Bank account link",
      ["Unlink bank account", "Cards"],
    ],
    [
      "the candidate widens the scope",
      "button",
      "Save button",
      ["Save and publish", "Preview"],
    ],
    [
      "the candidate is another settings page",
      "link",
      "Settings link",
      ["Cookie settings", "Home", "Privacy"],
    ],
    [
      "the candidate creates instead",
      "link",
      "Account link",
      ["Create account", "Sign in", "Pricing"],
    ],
    [
      "the candidate is another 'next'",
      "link",
      "Next link",
      ["Previous", "1", "2", "Read next article"],
    ],
    [
      "the candidate picks a provider",
      "button",
      "Login button",
      ["Login with Google", "Help"],
    ],
    ["the candidate goes back", "button", "Go button", ["Go back", "Help"]],
    [
      "the role word is part of the real name",
      "tab",
      "New tab",
      ["New document", "Settings"],
    ],
    [
      "the words are reordered",
      "link",
      "Dashboard link",
      ["Open dashboard", "Products"],
    ],
    [
      "'open' is a status filter",
      "tab",
      "Issues tab",
      ["Open issues", "Closed issues", "All issues"],
    ],
    [
      "'open' creates",
      "link",
      "Account link",
      ["Open account", "Sign in", "Help"],
    ],
    [
      "the direction is reversed",
      "button",
      "Celsius to Fahrenheit button",
      ["Fahrenheit to Celsius", "Reset"],
    ],
    [
      "'my' narrows the scope",
      "tab",
      "Tasks tab",
      ["My tasks", "Team tasks", "All tasks"],
    ],
  ])("refuses when %s", (_why, role, name, names) => {
    expect(healTo(role, name, names)).toBeUndefined();
  });

  it("never overrides the character rule when a close candidate exists", () => {
    // 'Overview tab' is close to 'Overview table' by characters: that rule
    // decides, exactly as before this word rule existed.
    expect(healTo("tab", "Overview tab", ["Overview", "Overview table"])).toBe(
      "Overview table",
    );
  });

  it("refuses an empty or blank name instead of matching everything", () => {
    expect(healTo("button", "", ["Save"])).toBeUndefined();
    expect(healTo("button", "   ", ["Save"])).toBeUndefined();
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
