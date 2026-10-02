import { describe, expect, it } from "vitest";
import type { Step } from "../schema/spec.v1";
import { describeStep, stepKind, withoutQuery } from "./stepLabel";

const label = (step: Step) => describeStep(step).label;

describe("describeStep", () => {
  it("labels locator steps by kind and locator", () => {
    expect(
      describeStep({ click: { by: "role", role: "button", name: "Save" } }),
    ).toEqual({ kind: "click", label: 'click role=button "Save"' });
    expect(label({ hover: { by: "text", text: "Menu" } })).toBe(
      'hover text "Menu"',
    );
    expect(label({ focus: { by: "testid", testid: "search" } })).toBe(
      'focus testid "search"',
    );
    expect(
      label({ click: { by: "selector", selector: ".row button", nth: 2 } }),
    ).toBe('click selector ".row button" nth=2');
  });

  it("never includes fill, type, or select values", () => {
    const fill = label({
      fill: { by: "label", name: "Password", value: "hunter2-secret" },
    });
    const typed = label({
      type: { by: "label", name: "Token", value: "tok-secret" },
    });
    const selected = label({
      select: { by: "label", name: "Plan", value: "enterprise-secret" },
    });
    expect(fill).toBe('fill label "Password"');
    expect(typed).toBe('type label "Token"');
    expect(selected).toBe('select label "Plan"');
    for (const text of [fill, typed, selected]) {
      expect(text).not.toMatch(/secret/);
    }
  });

  it("drops query strings and fragments from navigation and requests", () => {
    expect(
      label({ open: "https://demo.example.test/login?token=abc#top" }),
    ).toBe("open https://demo.example.test/login");
    expect(
      label({
        open: { path: "/admin?x=1", waitUntil: "networkidle" },
      }),
    ).toBe("open /admin");
    expect(
      label({
        request: {
          method: "POST",
          url: "/api/items?key=secret",
          body: { secret: true },
        },
      }),
    ).toBe("request POST /api/items");
  });

  it("describes waits, presses, scrolls, and composite steps", () => {
    expect(label({ wait: { ms: 500 } })).toBe("wait 500ms");
    expect(label({ wait: { text: "Saved" } })).toBe('wait text "Saved"');
    expect(label({ wait: { load: "networkidle" } })).toBe(
      "wait load=networkidle",
    );
    expect(label({ wait: { selector: "#done", state: "visible" } })).toBe(
      'wait selector "#done" visible',
    );
    expect(label({ wait: { url: { includes: "/done" } } })).toBe(
      'wait url includes "/done"',
    );
    expect(
      label({
        wait: { value: { by: "label", name: "Total", equals: "42" } },
      }),
    ).toBe('wait value label "Total"');
    expect(label({ press: "Enter" })).toBe("press Enter");
    expect(
      label({ press: "Escape", target: { by: "role", role: "dialog" } }),
    ).toBe("press Escape on role=dialog");
    expect(label({ scroll: { direction: "down", px: 400 } })).toBe(
      "scroll down 400px",
    );
    expect(label({ use: "login_admin" })).toBe("use login_admin");
    expect(
      label({
        batch: [
          { hover: { by: "selector", selector: ".menu" } },
          { click: { by: "selector", selector: ".item" } },
        ],
      }),
    ).toBe("batch (2 sub-steps)");
    expect(label({ eval: { file: "scripts/read-store.ts" } })).toBe(
      "eval read-store.ts",
    );
    expect(label({ eval: { js: "1 + 1", assign: "sum" } })).toBe("eval → sum");
    expect(label({ monitor: { action: "profile", type: "cpu" } })).toBe(
      "monitor profile cpu",
    );
  });

  it("truncates long labels", () => {
    const long = label({ wait: { text: "x".repeat(400) } });
    expect(long.length).toBe(160);
    expect(long.endsWith("…")).toBe(true);
  });

  it("reports the action key as the step kind", () => {
    expect(stepKind({ snapshot: { interactive: false } })).toBe("snapshot");
    expect(stepKind({ wait: { ms: 1 } })).toBe("wait");
  });
});

describe("withoutQuery", () => {
  it("keeps origin and path only", () => {
    expect(withoutQuery("https://a.test/p?q=1#f")).toBe("https://a.test/p");
    expect(withoutQuery("/plain")).toBe("/plain");
  });
});
