import { describe, expect, it } from "vitest";
import {
  recordInteraction,
  recordOpen,
  recordOpenWithWait,
} from "./stepRecorder";

describe("stepRecorder", () => {
  describe("recordOpen", () => {
    it("records a simple open step", () => {
      expect(recordOpen("/login")).toEqual({ open: "/login" });
    });

    it("records an absolute URL", () => {
      expect(recordOpen("https://example.com/dashboard")).toEqual({
        open: "https://example.com/dashboard",
      });
    });
  });

  describe("recordOpenWithWait", () => {
    it("records an open step with waitUntil", () => {
      expect(recordOpenWithWait("/login", "networkidle")).toEqual({
        open: { path: "/login", waitUntil: "networkidle" },
      });
    });
  });

  describe("recordInteraction — click", () => {
    it("records a click with a role locator", () => {
      const step = recordInteraction({
        action: "click",
        target: { by: "role", role: "button", name: "Sign In" },
      });
      expect(step).toEqual({
        click: { by: "role", role: "button", name: "Sign In" },
      });
    });

    it("records a click with a selector string", () => {
      const step = recordInteraction({
        action: "click",
        target: "#submit-btn",
      });
      expect(step).toEqual({
        click: { by: "selector", selector: "#submit-btn" },
      });
    });

    it("returns undefined when click has no target", () => {
      expect(recordInteraction({ action: "click" })).toBeUndefined();
    });
  });

  describe("recordInteraction — fill", () => {
    it("records a fill with a role locator and value", () => {
      const step = recordInteraction({
        action: "fill",
        target: { by: "role", role: "textbox", name: "Email" },
        value: "test@test.com",
      });
      expect(step).toEqual({
        fill: {
          by: "role",
          role: "textbox",
          name: "Email",
          value: "test@test.com",
        },
      });
    });

    it("returns undefined when fill has no value", () => {
      expect(
        recordInteraction({
          action: "fill",
          target: { by: "role", role: "textbox", name: "Email" },
        }),
      ).toBeUndefined();
    });

    it("returns undefined when fill has no target", () => {
      expect(
        recordInteraction({ action: "fill", value: "test@test.com" }),
      ).toBeUndefined();
    });
  });

  describe("recordInteraction — hover", () => {
    it("records a hover with a label locator", () => {
      const step = recordInteraction({
        action: "hover",
        target: { by: "label", name: "Menu" },
      });
      expect(step).toEqual({ hover: { by: "label", name: "Menu" } });
    });
  });

  describe("recordInteraction — type", () => {
    it("records a type with a selector and value", () => {
      const step = recordInteraction({
        action: "type",
        target: "#search-box",
        value: "hello",
      });
      expect(step).toEqual({
        type: { by: "selector", selector: "#search-box", value: "hello" },
      });
    });
  });

  describe("recordInteraction — scroll", () => {
    it("records a scroll with direction and pixels", () => {
      const step = recordInteraction({
        action: "scroll",
        scrollDirection: "down",
        scrollPixels: 500,
      });
      expect(step).toEqual({ scroll: { down: 500 } });
    });

    it("defaults to 500px when no pixels given", () => {
      const step = recordInteraction({
        action: "scroll",
        scrollDirection: "up",
      });
      expect(step).toEqual({ scroll: { up: 500 } });
    });

    it("defaults to down 500 when no direction given", () => {
      const step = recordInteraction({ action: "scroll" });
      expect(step).toEqual({ scroll: { down: 500 } });
    });

    it("records a scroll to a locator", () => {
      const step = recordInteraction({
        action: "scroll",
        target: { by: "role", role: "button", name: "Submit" },
      });
      expect(step).toEqual({
        scroll: { to: { by: "role", role: "button", name: "Submit" } },
      });
    });
  });

  describe("recordInteraction — press", () => {
    it("records a press step", () => {
      const step = recordInteraction({ action: "press", value: "Enter" });
      expect(step).toEqual({ press: "Enter" });
    });

    it("returns undefined when press has no value", () => {
      expect(recordInteraction({ action: "press" })).toBeUndefined();
    });
  });
});
