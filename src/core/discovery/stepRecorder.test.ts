import { describe, expect, it } from "vitest";
import { StepSchema } from "../schema/spec.v1";
import {
  isEphemeralTarget,
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

    it("returns undefined when hover has no target", () => {
      expect(recordInteraction({ action: "hover" })).toBeUndefined();
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

    it("returns undefined when type has no value", () => {
      expect(
        recordInteraction({ action: "type", target: "#search-box" }),
      ).toBeUndefined();
    });

    it("returns undefined when type has no target", () => {
      expect(
        recordInteraction({ action: "type", value: "hello" }),
      ).toBeUndefined();
    });
  });

  describe("recordInteraction — select", () => {
    it("records a select by value", () => {
      const step = recordInteraction({
        action: "select",
        target: { by: "label", name: "Country" },
        value: "ar",
      });
      expect(step).toEqual({
        select: { by: "label", name: "Country", value: "ar" },
      });
    });

    it("records a select by label", () => {
      const step = recordInteraction({
        action: "select",
        target: "#country",
        label: "Argentina",
      });
      expect(step).toEqual({
        select: { by: "selector", selector: "#country", label: "Argentina" },
      });
    });

    it("returns undefined when select has neither value nor label", () => {
      expect(
        recordInteraction({ action: "select", target: "#country" }),
      ).toBeUndefined();
    });

    it("returns undefined when select has no target", () => {
      expect(
        recordInteraction({ action: "select", value: "ar" }),
      ).toBeUndefined();
    });
  });

  describe("recordInteraction — upload", () => {
    it("records an upload with a path", () => {
      const step = recordInteraction({
        action: "upload",
        target: { by: "role", role: "button", name: "Choose file" },
        path: "/tmp/report.pdf",
      });
      expect(step).toEqual({
        upload: {
          by: "role",
          role: "button",
          name: "Choose file",
          path: "/tmp/report.pdf",
        },
      });
    });

    it("returns undefined when upload has no path", () => {
      expect(
        recordInteraction({ action: "upload", target: "#file" }),
      ).toBeUndefined();
    });

    it("returns undefined when upload has no target", () => {
      expect(
        recordInteraction({ action: "upload", path: "/tmp/x.png" }),
      ).toBeUndefined();
    });
  });

  describe("recordInteraction — scroll", () => {
    it("records a scroll with direction and pixels", () => {
      const step = recordInteraction({
        action: "scroll",
        scrollDirection: "down",
        scrollPixels: 500,
      });
      expect(step).toEqual({ scroll: { direction: "down", px: 500 } });
    });

    it("defaults to 500px when no pixels given", () => {
      const step = recordInteraction({
        action: "scroll",
        scrollDirection: "up",
      });
      expect(step).toEqual({ scroll: { direction: "up", px: 500 } });
    });

    it("treats a non-positive scrollPixels as the 500 default", () => {
      // ScrollStepSchema requires a positive px, so 0 must not be emitted.
      expect(recordInteraction({ action: "scroll", scrollPixels: 0 })).toEqual({
        scroll: { direction: "down", px: 500 },
      });
    });

    it("defaults to down 500 when no direction given", () => {
      const step = recordInteraction({ action: "scroll" });
      expect(step).toEqual({ scroll: { direction: "down", px: 500 } });
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

  describe("ephemeral snapshot @ref rejection", () => {
    it("returns undefined for a click targeting an @ref", () => {
      expect(
        recordInteraction({ action: "click", target: "@e2" }),
      ).toBeUndefined();
    });

    it("returns undefined for a fill targeting an @ref", () => {
      expect(
        recordInteraction({ action: "fill", target: "@e5", value: "x" }),
      ).toBeUndefined();
    });

    it("returns undefined when the @ref has leading whitespace", () => {
      expect(
        recordInteraction({ action: "click", target: "  @e2" }),
      ).toBeUndefined();
    });

    it("still records a real CSS selector", () => {
      expect(recordInteraction({ action: "click", target: "#submit" })).toEqual(
        { click: { by: "selector", selector: "#submit" } },
      );
    });

    it("isEphemeralTarget flags @refs only", () => {
      expect(isEphemeralTarget("@e2")).toBe(true);
      expect(isEphemeralTarget("  @e2")).toBe(true);
      expect(isEphemeralTarget("#btn")).toBe(false);
      expect(isEphemeralTarget("e2")).toBe(false);
      expect(isEphemeralTarget(".item")).toBe(false);
      expect(
        isEphemeralTarget({ by: "role", role: "button", name: "Go" }),
      ).toBe(false);
      expect(isEphemeralTarget(undefined)).toBe(false);
    });
  });

  // Contract: everything the recorder emits must be a step the real backends
  // accept — i.e. it must satisfy StepSchema. This is the guard that the
  // invalid `{ scroll: { down: N } }` shape lacked.
  describe("recorded steps satisfy StepSchema", () => {
    const cases: { name: string; step: Record<string, unknown> | undefined }[] =
      [
        { name: "open", step: recordOpen("/login") },
        {
          name: "open+wait",
          step: recordOpenWithWait("/login", "networkidle"),
        },
        {
          name: "click",
          step: recordInteraction({ action: "click", target: "#go" }),
        },
        {
          name: "hover",
          step: recordInteraction({ action: "hover", target: "#menu" }),
        },
        {
          name: "fill",
          step: recordInteraction({
            action: "fill",
            target: "#email",
            value: "a@b.com",
          }),
        },
        {
          name: "type",
          step: recordInteraction({
            action: "type",
            target: "#search",
            value: "hi",
          }),
        },
        {
          name: "scroll-direction",
          step: recordInteraction({
            action: "scroll",
            scrollDirection: "down",
            scrollPixels: 300,
          }),
        },
        {
          name: "scroll-default",
          step: recordInteraction({ action: "scroll" }),
        },
        {
          name: "scroll-to",
          step: recordInteraction({
            action: "scroll",
            target: { by: "role", role: "button", name: "Submit" },
          }),
        },
        {
          name: "press",
          step: recordInteraction({ action: "press", value: "Enter" }),
        },
        {
          name: "select-value",
          step: recordInteraction({
            action: "select",
            target: "#country",
            value: "ar",
          }),
        },
        {
          name: "select-label",
          step: recordInteraction({
            action: "select",
            target: { by: "label", name: "Country" },
            label: "Argentina",
          }),
        },
        {
          name: "upload",
          step: recordInteraction({
            action: "upload",
            target: "#file",
            path: "/tmp/report.pdf",
          }),
        },
      ];

    for (const { name, step } of cases) {
      it(`${name} parses as a valid spec step`, () => {
        const result = StepSchema.safeParse(step);
        expect(
          result.success,
          result.success ? "" : JSON.stringify(result.error.issues),
        ).toBe(true);
      });
    }
  });
});
