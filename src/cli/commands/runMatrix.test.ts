import { describe, expect, it } from "vitest";
import {
  describeIteration,
  expandMatrix,
  iterationEnv,
  iterationLabels,
  matrixEnvName,
  parseMatrix,
  parseRepeat,
  planIterations,
} from "./runMatrix";

describe("parseRepeat", () => {
  it("accepts positive integers and absence", () => {
    expect(parseRepeat(undefined)).toBeUndefined();
    expect(parseRepeat("3")).toBe(3);
  });
  it("rejects zero, negatives, junk, and huge values", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", "100000"]) {
      expect(() => parseRepeat(bad)).toThrow(/--repeat/);
    }
  });
});

describe("parseMatrix", () => {
  it("parses multiple axes and trims whitespace", () => {
    expect(parseMatrix("workers=1, 2 ;flag=on,off")).toEqual([
      { key: "workers", values: ["1", "2"] },
      { key: "flag", values: ["on", "off"] },
    ]);
  });
  it("dedupes values", () => {
    expect(parseMatrix("a=1,1,2")[0]!.values).toEqual(["1", "2"]);
  });
  it("rejects malformed input", () => {
    expect(() => parseMatrix("novalue")).toThrow(/key=a,b/);
    expect(() => parseMatrix("a=")).toThrow(/empty value/);
    expect(() => parseMatrix("a=1,,2")).toThrow(/empty value/);
    expect(() => parseMatrix("1bad=x")).toThrow(/must start with a letter/);
    expect(() => parseMatrix("a=1;a=2")).toThrow(/more than once/);
    expect(() => parseMatrix("a-b=1;a_b=2")).toThrow(/more than once/);
    expect(() => parseMatrix("repeat=1,2")).toThrow(/reserved/);
    expect(() => parseMatrix(" ; ")).toThrow(/at least one/);
  });
});

describe("expandMatrix / planIterations", () => {
  const axes = parseMatrix("a=1,2;b=x,y");

  it("builds the cartesian product, first axis slowest", () => {
    expect(expandMatrix(axes)).toEqual([
      { a: "1", b: "x" },
      { a: "1", b: "y" },
      { a: "2", b: "x" },
      { a: "2", b: "y" },
    ]);
  });

  it("returns a single empty combination without axes", () => {
    expect(planIterations(undefined, [])).toEqual([{ index: 1, matrix: {} }]);
  });

  it("repeat is the outer loop so cohorts interleave", () => {
    const plan = planIterations(2, parseMatrix("m=a,b"));
    expect(plan.map((p) => `${p.repeat}:${p.matrix.m}`)).toEqual([
      "1:a",
      "1:b",
      "2:a",
      "2:b",
    ]);
    expect(plan.map((p) => p.index)).toEqual([1, 2, 3, 4]);
  });

  it("caps the expansion", () => {
    expect(() => planIterations(1000, parseMatrix("a=1,2,3,4,5,6"))).toThrow(
      /maximum/,
    );
  });
});

describe("iteration labels and env", () => {
  const [it1] = planIterations(5, parseMatrix("my-key=v1"));

  it("stamps repeat=<i> and key=value labels", () => {
    expect(iterationLabels(it1!)).toEqual(["repeat=1", "my-key=v1"]);
    expect(describeIteration(it1!)).toBe("repeat=1 my-key=v1");
  });

  it("omits repeat when --repeat was not given", () => {
    const [only] = planIterations(undefined, parseMatrix("k=v"));
    expect(iterationLabels(only!)).toEqual(["k=v"]);
    expect(iterationEnv(only!)).toEqual({ CAIRN_MATRIX_K: "v" });
  });

  it("exports CAIRN_MATRIX_<KEY> (normalized) and CAIRN_REPEAT", () => {
    expect(matrixEnvName("my-key")).toBe("CAIRN_MATRIX_MY_KEY");
    expect(iterationEnv(it1!)).toEqual({
      CAIRN_REPEAT: "1",
      CAIRN_MATRIX_MY_KEY: "v1",
    });
  });
});
