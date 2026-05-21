import { describe, expect, it } from "vitest";
import { findByRole, parseSnapshot } from "./snapshotParser";

const SAMPLE = `- banner
  - heading "Dashboard" [level=1, ref=e1]
  - paragraph
    - StaticText "All systems normal"
- main
  - paragraph
    - StaticText "Inventory:"
  - table "Inventory"
    - rowgroup
      - row
        - columnheader "Item" [ref=e8]
        - columnheader "Total" [ref=e9]
    - row
      - cell "Apples" [ref=e2]
      - cell "$1.00" [ref=e3]
`;

describe("parseSnapshot", () => {
  it("parses role-only lines", () => {
    const els = parseSnapshot("- banner\n- main");
    expect(els).toHaveLength(2);
    expect(els[0]).toMatchObject({ role: "banner", level: 0 });
    expect(els[1]).toMatchObject({ role: "main", level: 0 });
  });

  it("parses role + quoted name", () => {
    const els = parseSnapshot('  - heading "Hello"');
    expect(els[0]).toMatchObject({ role: "heading", name: "Hello", level: 1 });
  });

  it("parses attributes and extracts ref", () => {
    const els = parseSnapshot('  - link "Open dashboard" [ref=e2]');
    expect(els[0]).toMatchObject({
      role: "link",
      name: "Open dashboard",
      level: 1,
      ref: "e2",
    });
    expect(els[0]?.attrs).toEqual({ ref: "e2" });
  });

  it("handles multiple attributes including level", () => {
    const els = parseSnapshot('- heading "Dashboard" [level=1, ref=e1]');
    expect(els[0]?.attrs).toEqual({ level: "1", ref: "e1" });
    expect(els[0]?.ref).toBe("e1");
  });

  it("preserves nesting depth via indentation", () => {
    const els = parseSnapshot(SAMPLE);
    const main = els.find((e) => e.role === "main");
    expect(main?.level).toBe(0);
    const table = els.find((e) => e.role === "table");
    expect(table?.level).toBe(1);
    const cells = els.filter((e) => e.role === "cell");
    expect(cells).toHaveLength(2);
    // <table> (1) → <rowgroup or row sibling> (2) → <cell> (3)
    expect(cells.every((c) => c.level === 3)).toBe(true);
  });

  it("ignores blank lines and lines without the dash marker", () => {
    expect(parseSnapshot("\n\n  random text without dash\n- main\n")).toEqual([
      { role: "main", level: 0 },
    ]);
  });
});

describe("findByRole", () => {
  it("returns all elements of the given role", () => {
    const els = parseSnapshot(SAMPLE);
    expect(findByRole(els, "row")).toHaveLength(2);
    expect(findByRole(els, "link")).toHaveLength(0);
  });
});

describe("parseSnapshot — Playwright ariaSnapshot format", () => {
  const PLAYWRIGHT_SAMPLE = `- document:
  - banner:
    - heading "Cairntrace demo home" [level=1]
  - main:
    - paragraph: Tiny static app for testing.
    - paragraph:
      - link "Open dashboard":
        - /url: /dashboard.html
`;

  it("strips trailing colons from role names", () => {
    const els = parseSnapshot(PLAYWRIGHT_SAMPLE);
    const banner = els.find((e) => e.role === "banner");
    expect(banner).toBeDefined();
    expect(banner?.role).toBe("banner");
  });

  it("captures heading + level from Playwright snapshot", () => {
    const els = parseSnapshot(PLAYWRIGHT_SAMPLE);
    const heading = els.find((e) => e.role === "heading");
    expect(heading).toMatchObject({
      role: "heading",
      name: "Cairntrace demo home",
    });
    expect(heading?.attrs?.["level"]).toBe("1");
  });

  it("captures the link name even when followed by a colon", () => {
    const els = parseSnapshot(PLAYWRIGHT_SAMPLE);
    const link = findByRole(els, "link");
    expect(link).toHaveLength(1);
    expect(link[0]?.name).toBe("Open dashboard");
  });

  it("ignores leaf lines that start with /", () => {
    const els = parseSnapshot(PLAYWRIGHT_SAMPLE);
    // `/url: /dashboard.html` shouldn't show up as a node.
    expect(els.find((e) => e.role.startsWith("/"))).toBeUndefined();
  });
});
