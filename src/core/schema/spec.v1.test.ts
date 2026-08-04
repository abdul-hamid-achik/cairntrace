import { describe, expect, it } from "vitest";
import { StepSchema, withoutPostcondition } from "./spec.v1";

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
