import { describe, it, expect } from "vitest";
import { VerifierSchema, ScriptVerifierSchema } from "./verifier.v1";

// 1.13.0 regression: a `script` verifier whose `fixtures` carried a non-string value (commonly a
// number/boolean from ${var} interpolation, e.g. an expected row count of 0) used to fail the
// strict ScriptVerifierSchema member, which surfaced through the VerifierSchema z.union as a
// MISLEADING "Unrecognized key(s) in object: 'script'" — making a valid-looking spec read as
// "the script verifier isn't supported". Fixtures now accept string|number|boolean and stringify.
describe("ScriptVerifierSchema fixtures (1.13.0)", () => {
  it("accepts string fixture values", () => {
    const result = VerifierSchema.safeParse({
      script: { file: "v.ts", fixtures: { a: "x" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts number/boolean fixture values and stringifies them", () => {
    const result = ScriptVerifierSchema.safeParse({
      script: { file: "v.ts", fixtures: { count: 0, flag: true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.script.fixtures).toEqual({ count: "0", flag: "true" });
    }
  });

  it("surfaces through the full VerifierSchema union (no misleading 'unrecognized script')", () => {
    const result = VerifierSchema.safeParse({
      script: { file: "v.ts", fixtures: { expectedRowCount: 0 } },
    });
    expect(result.success).toBe(true);
  });

  it("still rejects object/array fixture values as genuine errors", () => {
    expect(
      VerifierSchema.safeParse({
        script: { file: "v.ts", fixtures: { bad: { nested: 1 } } },
      }).success,
    ).toBe(false);
  });

  it("still enforces exactly one of run/file", () => {
    expect(
      VerifierSchema.safeParse({ script: { fixtures: { a: "x" } } }).success,
    ).toBe(false);
    expect(
      VerifierSchema.safeParse({ script: { run: "x", file: "y" } }).success,
    ).toBe(false);
  });
});
