import { describe, expect, it } from "vitest";
import { extractRoleInventory, parseTestIdInventory } from "./locatorInventory";

describe("locator inventory", () => {
  it("extracts grouped role locators from agent-browser and Playwright snapshots", () => {
    const roles = extractRoleInventory(
      [
        "- document",
        "  - generic",
        '    - heading "Dashboard" [level=1, ref=e1]',
        '    - button "Save" [ref=e2]',
        '    - button "Save" [ref=e3]',
        '    - link "Open dashboard":',
        "      - /url: /dashboard",
        "    - table [ref=e4]",
      ].join("\n"),
    );

    expect(roles).toEqual([
      {
        role: "button",
        name: "Save",
        count: 2,
        refs: ["e2", "e3"],
        locator: { by: "role", role: "button", name: "Save" },
      },
      {
        role: "heading",
        name: "Dashboard",
        count: 1,
        refs: ["e1"],
        locator: { by: "role", role: "heading", name: "Dashboard" },
      },
      {
        role: "link",
        name: "Open dashboard",
        count: 1,
        refs: [],
        locator: { by: "role", role: "link", name: "Open dashboard" },
      },
      {
        role: "table",
        count: 1,
        refs: ["e4"],
        locator: { by: "role", role: "table" },
      },
    ]);
  });

  it("groups data-testid inventory and keeps selector-safe values", () => {
    const testids = parseTestIdInventory(
      JSON.stringify([
        {
          testId: "save-button",
          tagName: "button",
          text: "Save",
          selector: '[data-testid="save-button"]',
        },
        {
          testId: "save-button",
          tagName: "span",
          text: "Save",
          selector: '[data-testid="save-button"]',
        },
        {
          testId: 'quote"value',
          tagName: "div",
          text: "",
          selector: '[data-testid="quote\\"value"]',
        },
      ]),
    );

    expect(testids).toEqual([
      {
        testId: 'quote"value',
        count: 1,
        selector: '[data-testid="quote\\"value"]',
        tagNames: ["div"],
        textSamples: [],
      },
      {
        testId: "save-button",
        count: 2,
        selector: '[data-testid="save-button"]',
        tagNames: ["button", "span"],
        textSamples: ["Save"],
      },
    ]);
  });
});
