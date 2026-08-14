import { describe, expect, it } from "vitest";
import {
  LocatorSchema,
  ReusableActionSchema,
  StepSchema,
  useActionName,
  useActionVars,
  type UseStep,
  WaitConditionSchema,
  withoutPostcondition,
} from "./spec.v1";

describe("authoring locators and waits", () => {
  it("accepts nth on a selector locator", () => {
    expect(
      LocatorSchema.parse({
        by: "selector",
        selector: '[data-testid^="entity-switch-item-"]',
        nth: 1,
      }),
    ).toMatchObject({
      by: "selector",
      selector: '[data-testid^="entity-switch-item-"]',
      nth: 1,
    });
  });

  it("accepts wait.ms", () => {
    expect(WaitConditionSchema.parse({ ms: 20000 })).toEqual({ ms: 20000 });
    expect(WaitConditionSchema.safeParse({ ms: 0 }).success).toBe(false);
  });

  it("accepts hasText and press.target", () => {
    expect(
      LocatorSchema.parse({
        by: "selector",
        selector: '[data-qa="Owner"] .radio-label',
        hasText: "Yes",
      }),
    ).toMatchObject({
      by: "selector",
      selector: '[data-qa="Owner"] .radio-label',
      hasText: "Yes",
    });
    expect(
      StepSchema.parse({
        press: "Enter",
        target: { by: "selector", selector: "#search" },
        until: { selector: ".company-link", timeoutMs: 180000 },
      }),
    ).toMatchObject({
      press: "Enter",
      target: { by: "selector", selector: "#search" },
      until: { selector: ".company-link", timeoutMs: 180000 },
    });
  });

  it("accepts by:testid, near, and wait.url", () => {
    expect(
      LocatorSchema.parse({
        by: "testid",
        testid: "product_name",
        near: "Website",
      }),
    ).toMatchObject({
      by: "testid",
      testid: "product_name",
      near: "Website",
    });
    expect(
      StepSchema.parse({
        click: { by: "role", role: "button", name: "Open", near: "Acme Corp" },
      }),
    ).toMatchObject({
      click: { by: "role", role: "button", name: "Open", near: "Acme Corp" },
    });
    expect(
      WaitConditionSchema.parse({ url: { includes: "/connection/" } }),
    ).toEqual({ url: { includes: "/connection/" } });
    expect(
      WaitConditionSchema.parse({
        url: { equals: "https://app.example/dash" },
      }),
    ).toEqual({ url: { equals: "https://app.example/dash" } });
    expect(WaitConditionSchema.parse({ url: { pattern: "/app/?$" } })).toEqual({
      url: { pattern: "/app/?$" },
    });
  });

  it("rejects wait.url with two matchers or a broken pattern", () => {
    expect(
      WaitConditionSchema.safeParse({
        url: { includes: "/a", equals: "https://x" },
      }).success,
    ).toBe(false);
    expect(
      WaitConditionSchema.safeParse({ url: { pattern: "(" } }).success,
    ).toBe(false);
  });

  it("accepts action-local vars on reusable actions", () => {
    expect(
      ReusableActionSchema.parse({
        version: 1,
        name: "open_named",
        vars: { companyName: "Acme Corp" },
        steps: [
          {
            click: {
              by: "role",
              role: "button",
              name: "Open",
              near: "${vars.companyName}",
            },
          },
        ],
      }).vars,
    ).toEqual({ companyName: "Acme Corp" });
  });

  it("accepts string and object use: forms", () => {
    const asString = StepSchema.parse({ use: "login_admin" }) as UseStep;
    expect(useActionName(asString)).toBe("login_admin");
    expect(useActionVars(asString)).toBeUndefined();

    const asObject = StepSchema.parse({
      use: {
        action: "edit_and_save_text_field",
        vars: { textFieldValue: "https://example.com" },
      },
    }) as UseStep;
    expect(useActionName(asObject)).toBe("edit_and_save_text_field");
    expect(useActionVars(asObject)).toEqual({
      textFieldValue: "https://example.com",
    });
    expect(StepSchema.safeParse({ use: { vars: { x: "y" } } }).success).toBe(
      false,
    );
  });

  it("accepts when object with selector+hasText and rejects hasText without selector", () => {
    expect(
      StepSchema.parse({
        when: {
          selector: ".invite-entity-blade",
          hasText: "Connect as Supplier",
        },
        click: { by: "role", role: "button", name: "Connect as Supplier" },
      }),
    ).toMatchObject({
      when: {
        selector: ".invite-entity-blade",
        hasText: "Connect as Supplier",
      },
    });
    expect(
      StepSchema.safeParse({
        when: { text: "Password", hasText: "x" },
        click: { by: "role", role: "button", name: "Go" },
      }).success,
    ).toBe(false);
  });
});

describe("network postconditions", () => {
  it("accepts a typed upload response postcondition and strips only orchestration metadata", () => {
    const step = {
      id: "upload",
      upload: { by: "selector", selector: "input[type=file]", path: "w9.pdf" },
      postcondition: {
        network: {
          method: "POST",
          urlContains: "/api/files/extract-content-by-package",
          status: { equals: 200 },
          timeoutMs: 45_000,
        },
      },
    } as const;

    expect(StepSchema.parse(step)).toEqual(step);
    expect(withoutPostcondition(step)).toEqual({
      id: "upload",
      upload: { by: "selector", selector: "input[type=file]", path: "w9.pdf" },
    });
  });

  it("accepts postcondition.network.assign and rejects an invalid name", () => {
    expect(
      StepSchema.parse({
        click: { by: "role", role: "button", name: "Save" },
        postcondition: {
          network: {
            urlContains: "/api/answers",
            status: { in: [200, 201, 204] },
            assign: "save",
          },
        },
      }),
    ).toMatchObject({
      postcondition: { network: { assign: "save" } },
    });
    expect(
      StepSchema.safeParse({
        click: { by: "role", role: "button", name: "Save" },
        postcondition: {
          network: { urlContains: "/api/answers", assign: "Save" },
        },
      }).success,
    ).toBe(false);
  });

  it("requires a URL matcher for a network postcondition", () => {
    const result = StepSchema.safeParse({
      upload: { by: "selector", selector: "input[type=file]", path: "w9.pdf" },
      postcondition: { network: { status: { equals: 200 } } },
    });

    expect(result.success).toBe(false);
  });

  it.each(["wait", "request", "eval", "snapshot", "use", "monitor"])(
    "rejects a network postcondition on a non-browser-action %s step",
    (kind) => {
      const bodyByKind: Record<string, unknown> = {
        wait: { text: "Done" },
        request: { method: "GET", url: "/api/status" },
        eval: { js: "return true" },
        snapshot: { interactive: false },
        use: "login",
        monitor: { action: "snapshot" },
      };
      const result = StepSchema.safeParse({
        [kind]: bodyByKind[kind],
        postcondition: { network: { urlContains: "/api/answers" } },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["postcondition"],
              message:
                "postcondition.network is only valid on a browser action step",
            }),
          ]),
        );
      }
    },
  );
});
