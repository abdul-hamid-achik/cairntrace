import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  expressionPaths,
  expressionProblem,
  ExpressionSyntaxError,
  formatPath,
  parseExpression,
  readExpressionPath,
} from "./expression";

const doc = {
  temporal: {
    enabled: true,
    sweeper: false,
    maxConcurrent: 2,
    name: "primary",
    nothing: null,
    workers: [{ id: "w1" }, { id: "w2" }],
    "odd-key": 7,
  },
  mode: "strict",
  list: [1, 2, 3],
  empty: "",
};

function check(source: string, document: unknown = doc): boolean {
  return evaluateExpression(parseExpression(source), document);
}

describe("assertion language: comparisons", () => {
  it("compares with ==, != and the ordering operators", () => {
    expect(check(".temporal.enabled == true")).toBe(true);
    expect(check(".temporal.sweeper == true")).toBe(false);
    expect(check(".temporal.maxConcurrent == 2")).toBe(true);
    expect(check(".temporal.maxConcurrent != 3")).toBe(true);
    expect(check(".temporal.maxConcurrent >= 2")).toBe(true);
    expect(check(".temporal.maxConcurrent > 2")).toBe(false);
    expect(check(".temporal.maxConcurrent < 3")).toBe(true);
    expect(check(".temporal.maxConcurrent <= 1")).toBe(false);
    expect(check('.mode == "strict"')).toBe(true);
    expect(check(".mode == 'strict'")).toBe(true);
    expect(check('.mode < "t"')).toBe(true);
  });

  it("does not coerce types", () => {
    expect(check('.temporal.maxConcurrent == "2"')).toBe(false);
    expect(check('.temporal.maxConcurrent < "3"')).toBe(false);
    expect(check(".temporal.enabled == 1")).toBe(false);
  });

  it("reads null, nested keys, indexes and quoted keys", () => {
    expect(check(".temporal.nothing == null")).toBe(true);
    expect(check('.temporal.workers[1].id == "w2"')).toBe(true);
    expect(check('.temporal.workers[-1].id == "w2"')).toBe(true);
    expect(check('.temporal["odd-key"] == 7')).toBe(true);
    expect(check("temporal.maxConcurrent == 2")).toBe(true);
  });

  it("treats a missing path as unequal to everything and unordered", () => {
    expect(check(".nope == null")).toBe(false);
    expect(check(".nope == 1")).toBe(false);
    expect(check(".nope != 1")).toBe(true);
    expect(check(".nope < 1")).toBe(false);
    expect(check(".temporal.nope.deeper == 1")).toBe(false);
    expect(check(".list[9] == 1")).toBe(false);
  });
});

describe("assertion language: in, exists, boolean logic", () => {
  it("supports in with a literal list", () => {
    expect(check('.mode in ["strict", "lenient"]')).toBe(true);
    expect(check('.mode in ["lenient"]')).toBe(false);
    expect(check(".temporal.maxConcurrent in [1, 2]")).toBe(true);
    expect(check(".nope in [1, 2]")).toBe(false);
    expect(check(".mode in []")).toBe(false);
  });

  it("supports exists (present and not null)", () => {
    expect(check(".temporal.enabled exists")).toBe(true);
    expect(check(".temporal.sweeper exists")).toBe(true);
    expect(check(".temporal.nothing exists")).toBe(false);
    expect(check(".nope exists")).toBe(false);
    expect(check("not .nope exists")).toBe(true);
  });

  it("combines with and / or / not, parentheses and the symbol forms", () => {
    expect(
      check(".temporal.enabled == true and .temporal.maxConcurrent == 2"),
    ).toBe(true);
    expect(
      check(".temporal.enabled == true and .temporal.sweeper == true"),
    ).toBe(false);
    expect(check('.temporal.sweeper == true or .mode == "strict"')).toBe(true);
    expect(check("not .temporal.sweeper")).toBe(true);
    expect(check("!.temporal.enabled")).toBe(false);
    expect(check(".temporal.enabled && .temporal.maxConcurrent == 2")).toBe(
      true,
    );
    expect(check(".temporal.sweeper || .temporal.enabled")).toBe(true);
    // and binds tighter than or
    expect(check("true or false and false")).toBe(true);
    expect(check("(true or false) and false")).toBe(false);
  });

  it("truthiness of a bare path", () => {
    expect(check(".temporal.enabled")).toBe(true);
    expect(check(".temporal.sweeper")).toBe(false);
    expect(check(".empty")).toBe(false);
    expect(check(".temporal.nothing")).toBe(false);
    expect(check(".temporal.workers")).toBe(true);
    expect(check(".nope")).toBe(false);
  });
});

describe("assertion language: syntax errors and safety", () => {
  it.each([
    "",
    "   ",
    ".a ==",
    ".a == == 1",
    ".a in 1",
    ".a in [1, .b]",
    "(.a == 1",
    ".a == 1)",
    '.a == "open',
    ".a[x]",
    ".a..b",
    "@",
    ".a == 1 .b == 2",
  ])("rejects %j with a positioned error", (source) => {
    expect(() => parseExpression(source)).toThrow(ExpressionSyntaxError);
    expect(expressionProblem(source)).toMatch(/offset \d+/);
  });

  it("never evaluates code: function-call and statement syntax is a syntax error", () => {
    for (const source of [
      "process.exit(1)",
      "require('fs')",
      ".a = 1",
      "constructor.constructor('return 1')()",
      "1; 2",
      "`x`",
    ]) {
      expect(expressionProblem(source), source).toBeDefined();
    }
  });

  it("does not follow prototype keys", () => {
    expect(check(".constructor exists", {})).toBe(false);
    expect(check(".__proto__ exists", {})).toBe(false);
    expect(check(".toString exists", {})).toBe(false);
    expect(check(".length exists", [1])).toBe(false);
  });

  it("reports no problem for valid input", () => {
    expect(expressionProblem(".a == 1 and .b in [1, 2]")).toBeUndefined();
  });
});

describe("assertion language: path helpers", () => {
  it("lists the paths an expression reads", () => {
    const node = parseExpression(
      ".a.b == 1 and (.c exists or .list[0] in [1]) and not .d",
    );
    expect(expressionPaths(node).map(formatPath)).toEqual([
      ".a.b",
      ".c",
      ".list[0]",
      ".d",
    ]);
  });

  it("reads a path with found / value", () => {
    expect(readExpressionPath(doc, ["temporal", "maxConcurrent"])).toEqual({
      found: true,
      value: 2,
    });
    expect(readExpressionPath(doc, ["temporal", "nope"])).toEqual({
      found: false,
    });
  });
});

describe("assertion language: bounds", () => {
  it("rejects runaway nesting as a syntax error, never a RangeError", () => {
    for (const source of [
      `${"!".repeat(20_000)}.a`,
      `${"(".repeat(20_000)}.a${")".repeat(20_000)}`,
      `${"not ".repeat(100)}.a`,
      `${"(".repeat(65)}.a${")".repeat(65)}`,
    ]) {
      expect(() => parseExpression(source)).toThrow(ExpressionSyntaxError);
      expect(expressionProblem(source)).toMatch(
        /nests deeper than 64 levels|more than 1024 tokens/,
      );
    }
  });

  it("rejects an expression with too many tokens", () => {
    const source = Array.from({ length: 600 }, (_, i) => `.a${i}`).join(
      " and ",
    );
    expect(expressionProblem(source)).toMatch(/more than 1024 tokens/);
  });

  it("still accepts reasonable nesting", () => {
    const source = `${"(".repeat(30)}.a == 1${")".repeat(30)}`;
    expect(evaluateExpression(parseExpression(source), { a: 1 })).toBe(true);
    expect(
      evaluateExpression(parseExpression(`${"not ".repeat(10)}.a`), { a: 1 }),
    ).toBe(true);
  });
});
