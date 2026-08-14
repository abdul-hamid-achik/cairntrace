import { describe, expect, it } from "vitest";
import { parseSnapshot } from "./healer/snapshotParser";
import { pickNearestSnapshotMatches } from "./locatorNear";

describe("pickNearestSnapshotMatches", () => {
  it("keeps the Open button that shares a card with the company name", () => {
    const snap = parseSnapshot(
      [
        "- main",
        "  - generic",
        '    - heading "Acme Corp" [ref=e1]',
        '    - button "Open" [ref=e2]',
        "  - generic",
        '    - heading "Beta Inc" [ref=e3]',
        '    - button "Open" [ref=e4]',
      ].join("\n"),
    );
    const opens = [3, 6];
    expect(pickNearestSnapshotMatches(opens, snap, "Acme Corp")).toEqual([3]);
    expect(pickNearestSnapshotMatches(opens, snap, "Beta Inc")).toEqual([6]);
  });

  it("on a flat list picks the closest sibling by snapshot distance", () => {
    const snap = parseSnapshot(
      [
        "- main",
        '  - heading "Acme Corp" [ref=e1]',
        '  - button "Open" [ref=e2]',
        '  - heading "Beta Inc" [ref=e3]',
        '  - button "Open" [ref=e4]',
      ].join("\n"),
    );
    const opens = [2, 4];
    expect(pickNearestSnapshotMatches(opens, snap, "Acme Corp")).toEqual([2]);
    expect(pickNearestSnapshotMatches(opens, snap, "Beta Inc")).toEqual([4]);
  });

  it("returns nothing when the near text is absent", () => {
    const snap = parseSnapshot('- main\n  - button "Open" [ref=e1]\n');
    expect(pickNearestSnapshotMatches([1], snap, "Acme Corp")).toEqual([]);
  });
});
