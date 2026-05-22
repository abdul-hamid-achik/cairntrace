import { describe, expect, it } from "vitest";
import type { Step } from "../schema/spec.v1";
import { proposeOps } from "./Healer";
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
