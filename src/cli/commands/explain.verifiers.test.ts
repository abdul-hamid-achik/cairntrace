import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ExplainResultSchema } from "../../core/schema/explain.v1";
import { StepSchema } from "../../core/schema/spec.v1";
import {
  VerifierKindSchema,
  VerifierSchema,
} from "../../core/schema/verifier.v1";
import { buildExplain } from "./explain";

describe("cairn explain: verifier and expect/capture vocabulary", () => {
  const doc = ExplainResultSchema.parse(buildExplain());

  it("documents every verifier kind exactly once, each with the poll modifier", () => {
    expect(doc.verifiers.map((v) => v.id).toSorted()).toEqual(
      [...VerifierKindSchema.options].toSorted(),
    );
    for (const verifier of doc.verifiers) {
      expect(verifier.parameters.map((p) => p.name)).toContain("poll");
    }
  });

  it("ships verifier examples that parse against VerifierSchema", () => {
    for (const id of ["mongo", "temporal", "http", "value", "table"]) {
      const entry = doc.verifiers.find((v) => v.id === id)!;
      const parsed = parseYaml(entry.yamlExample) as { verify: unknown };
      expect(VerifierSchema.safeParse(parsed.verify).success, id).toBe(true);
    }
  });

  it("documents expect and capture steps with parseable examples", () => {
    for (const id of ["expect", "capture"] as const) {
      const entry = doc.steps.find((s) => s.id === id)!;
      expect(entry.kind).toBe("assertion");
      const parsed = parseYaml(entry.yamlExample) as { steps: unknown[] };
      for (const step of parsed.steps) {
        expect(StepSchema.safeParse(step).success, JSON.stringify(step)).toBe(
          true,
        );
      }
    }
  });
});
