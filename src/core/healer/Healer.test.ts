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

  it("does nothing for non-role locators (v0 scope)", () => {
    const snap = parseSnapshot(SNAPSHOT_WITH_RENAMED_LINK);
    expect(
      proposeOps({ click: { by: "selector", selector: "#missing" } }, 0, snap),
    ).toHaveLength(0);
  });
});
