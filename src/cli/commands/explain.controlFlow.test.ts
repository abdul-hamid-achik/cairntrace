import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { StepSchema } from "../../core/schema/spec.v1";
import { buildDocs } from "./docs";
import { buildExplain } from "./explain";

/** The `steps:` list of a YAML example (`steps:\n  - …`). */
function exampleSteps(yaml: string): unknown[] {
  const doc = parseYaml(yaml) as { steps?: unknown[] };
  return doc.steps ?? [];
}

describe("F14 control flow in explain and docs", () => {
  it("documents repeat and if, and every control-flow example parses", () => {
    const steps = buildExplain().steps;
    for (const id of ["repeat", "if", "wait", "use"] as const) {
      const doc = steps.find((step) => step.id === id);
      expect(doc, id).toBeDefined();
      for (const step of exampleSteps(doc!.yamlExample)) {
        expect(
          StepSchema.safeParse(step).success,
          `${id}: ${JSON.stringify(step)}`,
        ).toBe(true);
      }
    }
    expect(steps.find((step) => step.id === "repeat")?.kind).toBe(
      "control-flow",
    );
    expect(steps.find((step) => step.id === "wait")?.summary).toContain(
      "wait.any",
    );
    expect(steps.find((step) => step.id === "use")?.summary).toContain(
      "retry:",
    );
  });

  it("the steps topic carries a Control Flow section and a valid example", () => {
    const doc = buildDocs("steps");
    expect(doc.sections.map((section) => section.title)).toContain(
      "Control Flow",
    );
    const example = doc.examples.find((entry) =>
      entry.title.startsWith("control flow"),
    );
    expect(example).toBeDefined();
    for (const step of exampleSteps(example!.code)) {
      expect(StepSchema.safeParse(step).success, JSON.stringify(step)).toBe(
        true,
      );
    }
  });
});
