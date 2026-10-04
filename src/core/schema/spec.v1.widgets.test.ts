import { describe, expect, it } from "vitest";
import { BrowserConfigSchema } from "./config.v1";
import {
  StepSchema,
  TeardownSchema,
  clickLocator,
  fillLocator,
  widgetTargetRef,
  type ClickStep,
  type FillStep,
  type SetStep,
} from "./spec.v1";

const ok = (step: unknown) => StepSchema.safeParse(step).success;
const issues = (step: unknown): string[] => {
  const parsed = StepSchema.safeParse(step);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

describe("F15 widget steps", () => {
  it("accepts field and locator targets with values, options and flags", () => {
    expect(ok({ set: { field: "country", value: "Spain" } })).toBe(true);
    expect(ok({ set: { field: "qty", value: 3 } })).toBe(true);
    expect(ok({ set: { field: "terms", value: true } })).toBe(true);
    expect(ok({ set: { field: "regions", value: ["EMEA", "APAC"] } })).toBe(
      true,
    );
    expect(
      ok({
        set: {
          field: "contact",
          value: { query: "Ada", option: "Ada Lovelace" },
          driver: "vue-multiselect",
          optional: true,
          timeoutMs: 5000,
        },
      }),
    ).toBe(true);
    expect(ok({ set: { by: "label", name: "Plan", value: "Pro" } })).toBe(true);
    expect(ok({ check: { field: "terms" } })).toBe(true);
    expect(ok({ check: { field: "services", option: "Hardware" } })).toBe(true);
    expect(ok({ uncheck: { by: "testid", testid: "news", option: 2 } })).toBe(
      true,
    );
    expect(ok({ choose: { field: "owner", option: "No" } })).toBe(true);
  });

  it("rejects unknown keys, a choose without option and an empty value object", () => {
    expect(ok({ set: { field: "x", value: "y", label: "z" } })).toBe(false);
    expect(ok({ choose: { field: "owner" } })).toBe(false);
    expect(ok({ set: { field: "x" } })).toBe(false);
    expect(ok({ set: { field: "x", value: { option: "y" } } })).toBe(false);
    expect(ok({ set: { field: "x", value: "y", driver: "has space" } })).toBe(
      false,
    );
  });

  it("validates form fields: dependsOn must name an earlier key, keys are not integers", () => {
    expect(
      ok({
        form: {
          fields: {
            owner: "No",
            contact: { value: "Ada", dependsOn: "owner" },
            legacy: { value: "No", optional: true },
            reason: { value: "x", dependsOn: ["owner", "legacy"] },
          },
          verify: "none",
          onFailure: "dumpUnanswered",
          timeoutMs: 20000,
        },
      }),
    ).toBe(true);
    expect(
      ok({
        form: {
          fields: { a: "1" },
          onFailure: { dumpUnanswered: true },
        },
      }),
    ).toBe(true);
    expect(
      issues({
        form: { fields: { contact: { value: "x", dependsOn: "owner" } } },
      }).join(" "),
    ).toContain('dependsOn "owner" must name an earlier field');
    expect(
      issues({
        form: {
          fields: {
            contact: { value: "x", dependsOn: "owner" },
            owner: "No",
          },
        },
      }).join(" "),
    ).toContain("earlier field");
    expect(issues({ form: { fields: { "1": "x" } } }).join(" ")).toContain(
      "must not be integers",
    );
    expect(issues({ form: { fields: {} } }).join(" ")).toContain(
      "at least one field",
    );
  });

  it("refuses widget steps in teardown", () => {
    expect(
      TeardownSchema.safeParse([{ set: { field: "x", value: "y" } }]).success,
    ).toBe(false);
    expect(
      TeardownSchema.safeParse([
        {
          click: {
            by: "role",
            role: "button",
            name: "Discard",
            optional: true,
          },
        },
      ]).success,
    ).toBe(true);
  });

  it("widgetTargetRef keeps only the field or the locator", () => {
    const step = StepSchema.parse({
      set: {
        by: "label",
        name: "Plan",
        value: "Pro",
        driver: "native-select",
        optional: true,
        timeoutMs: 100,
      },
    }) as SetStep;
    expect(widgetTargetRef(step.set)).toEqual({
      locator: { by: "label", name: "Plan" },
    });
    expect(widgetTargetRef({ field: "x", value: 1 })).toEqual({ field: "x" });
  });
});

describe("F15 click and fill flags", () => {
  it("accepts optional / dispatch / fallback and strips them from the locator", () => {
    const step = StepSchema.parse({
      click: {
        by: "role",
        role: "button",
        name: "Save",
        optional: true,
        fallback: "dispatch",
      },
    }) as ClickStep;
    expect(clickLocator(step)).toEqual({
      by: "role",
      role: "button",
      name: "Save",
    });
    expect(
      ok({ click: { by: "selector", selector: "#x", dispatch: true } }),
    ).toBe(true);
  });

  it("rejects dispatch with fallback, and either with until or a postcondition", () => {
    expect(
      issues({
        click: {
          by: "selector",
          selector: "#x",
          dispatch: true,
          fallback: "dispatch",
        },
      }).join(" "),
    ).toContain("not both");
    expect(
      issues({
        click: {
          by: "selector",
          selector: "#x",
          dispatch: true,
          until: { text: "Saved" },
        },
      }).join(" "),
    ).toContain("click.until cannot be combined");
    expect(
      issues({
        click: { by: "selector", selector: "#x", fallback: "dispatch" },
        postcondition: { network: { urlContains: "/api" } },
      }).join(" "),
    ).toContain("postcondition.network cannot be combined");
    expect(
      ok({ click: { by: "selector", selector: "#x", fallback: "pointer" } }),
    ).toBe(false);
  });

  it("accepts fill mode set / optional and strips them from the locator", () => {
    const step = StepSchema.parse({
      fill: {
        by: "label",
        name: "Address",
        value: "10 Main",
        mode: "set",
        optional: true,
      },
    }) as FillStep;
    expect(fillLocator(step)).toEqual({ by: "label", name: "Address" });
    expect(
      ok({ fill: { by: "label", name: "A", value: "x", mode: "type" } }),
    ).toBe(false);
    expect(
      issues({
        fill: { by: "label", name: "A", value: "x", mode: "set" },
        postcondition: { network: { urlContains: "/api" } },
      }).join(" "),
    ).toContain("fill mode: set");
  });
});

describe("F15 browser config", () => {
  it("accepts fieldRoot templates and widget driver entries", () => {
    expect(
      BrowserConfigSchema.safeParse({
        fieldRoot: ['[data-field$=".{key}"]', '[data-field="{key}"]'],
        widgets: [{ use: "vue-multiselect" }, { file: "./drivers/x.js" }],
      }).success,
    ).toBe(true);
    expect(
      BrowserConfigSchema.safeParse({ fieldRoot: "[data-qa]" }).success,
    ).toBe(false);
    expect(
      BrowserConfigSchema.safeParse({ widgets: [{ use: "jquery-ui" }] })
        .success,
    ).toBe(false);
    expect(BrowserConfigSchema.safeParse({ widgets: [] }).success).toBe(false);
  });
});
