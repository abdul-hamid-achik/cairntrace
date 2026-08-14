import { describe, expect, it } from "vitest";
import { isLocatorMissError, replaceStepLocator } from "./replaceStepLocator";
import type { Step } from "../schema/spec.v1";

const next = { by: "role" as const, role: "textbox", name: "Email" };

describe("isLocatorMissError", () => {
  it("treats unresolved locators as misses", () => {
    expect(isLocatorMissError("0 visible matches")).toBe(true);
    expect(isLocatorMissError("selector '#x' not found")).toBe(true);
    expect(isLocatorMissError("mock step failure")).toBe(true);
  });

  it("does not treat a delivered click.until failure as a miss", () => {
    expect(
      isLocatorMissError(
        'click.until text="Done" was not satisfied after 4 click attempts within 30000ms',
      ),
    ).toBe(false);
  });

  it("treats a Playwright locator resolution timeout as a miss", () => {
    expect(
      isLocatorMissError(
        "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Go' })",
      ),
    ).toBe(true);
    expect(
      isLocatorMissError(
        "locator.fill: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByLabel('Password')",
      ),
    ).toBe(true);
  });

  it("does not treat a screenshot or navigation timeout as a miss", () => {
    expect(
      isLocatorMissError("page.screenshot: Timeout 15000ms exceeded"),
    ).toBe(false);
    expect(isLocatorMissError("page.goto: Timeout 30000ms exceeded")).toBe(
      false,
    );
  });
});

describe("replaceStepLocator", () => {
  it("keeps fill value when swapping the locator", () => {
    const step = {
      fill: { by: "selector", selector: "#old", value: "admin@example.com" },
    } as Step;
    const replaced = replaceStepLocator(step, next);
    expect("fill" in replaced && replaced.fill).toMatchObject({
      by: "role",
      role: "textbox",
      name: "Email",
      value: "admin@example.com",
    });
  });

  it("keeps click.until", () => {
    const step = {
      click: {
        by: "selector",
        selector: "#go",
        until: { text: "Done" },
      },
    } as Step;
    const replaced = replaceStepLocator(step, {
      by: "role",
      role: "button",
      name: "Go",
    });
    expect("click" in replaced && replaced.click).toMatchObject({
      by: "role",
      name: "Go",
      until: { text: "Done" },
    });
  });
});
