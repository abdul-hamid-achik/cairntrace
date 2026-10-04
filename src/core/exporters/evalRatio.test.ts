import { describe, expect, it } from "vitest";
import { SpecSchema } from "../schema/spec.v1";
import {
  evalRatioRefusal,
  evalStepRatio,
  exceedsEvalRatio,
  formatEvalRatio,
  pageEvalSites,
  parseMaxEvalRatio,
} from "./evalRatio";

function spec(raw: Record<string, unknown>) {
  return SpecSchema.parse({
    version: 1,
    name: "ratio_spec",
    intent: "counts evals",
    outcomes: [
      {
        id: "page_ok",
        description: "ok",
        verify: { text: { contains: "ok" } },
      },
    ],
    ...raw,
  });
}

const EVAL = (id: string) => ({ id, eval: { js: "window.x = 1;" } });

describe("evalStepRatio", () => {
  it("is eval steps over steps, a container counting as one step", () => {
    const flat = spec({
      steps: [{ id: "open_it", open: "/" }, EVAL("a"), EVAL("b"), EVAL("c")],
    });
    expect(evalStepRatio(flat)).toEqual({
      evalSteps: 3,
      totalSteps: 4,
      ratio: 0.75,
    });
    const nested = spec({
      steps: [
        { id: "open_it", open: "/" },
        {
          id: "maybe",
          // Parsed from JSON: a literal `then:` key reads as a thenable to the linter.
          if: JSON.parse(
            '{"condition":{"url":{"includes":"/x"}},"then":[{"id":"inner","eval":{"js":"window.x = 1;"}},{"id":"wait_it","wait":{"text":"Hi"}}]}',
          ),
        },
      ],
    });
    // open + if + inner eval + wait
    expect(evalStepRatio(nested)).toMatchObject({
      evalSteps: 1,
      totalSteps: 4,
    });
  });

  it("counts teardown steps like pageEvalSites does (they run in the exported test)", () => {
    const withTeardown = spec({
      steps: [{ id: "open_it", open: "/" }],
      teardown: [EVAL("cleanup")],
    });
    expect(evalStepRatio(withTeardown)).toEqual({
      evalSteps: 1,
      totalSteps: 2,
      ratio: 0.5,
    });
  });

  it("is 0 for a spec without steps", () => {
    expect(evalStepRatio(spec({}))).toEqual({
      evalSteps: 0,
      totalSteps: 0,
      ratio: 0,
    });
  });

  it("an equal ratio is within the limit; formatting and the refusal text name the numbers", () => {
    const ratio = { evalSteps: 1, totalSteps: 4, ratio: 0.25 };
    expect(exceedsEvalRatio(ratio, 0.25)).toBe(false);
    expect(exceedsEvalRatio(ratio, 0.24)).toBe(true);
    expect(formatEvalRatio(ratio)).toBe("1/4 step(s) (25%)");
    expect(evalRatioRefusal("x_flow", ratio, 0.2)).toBe(
      "spec x_flow refused: 1/4 step(s) (25%) are page eval, over --max-eval-ratio 0.2 (20%); replace evals with typed steps (see `cairn spec lint`) or raise the limit",
    );
  });
});

describe("pageEvalSites", () => {
  it("lists eval steps (teardown included) and browser script outcomes, not node scripts", () => {
    const sites = pageEvalSites(
      spec({
        steps: [{ id: "open_it", open: "/" }, EVAL("seed")],
        teardown: [EVAL("cleanup")],
        outcomes: [
          {
            id: "browser_check",
            description: "browser script",
            verify: { script: { run: "return true;" } },
          },
          {
            id: "node_check",
            description: "node script",
            verify: { script: { runtime: "node", file: "./v.mjs" } },
          },
        ],
      }),
    );
    expect(sites).toEqual([
      "step seed",
      "step cleanup",
      "outcome browser_check",
    ]);
  });

  it("lists wait: { app } checks, alone or in a group: they are string-evaluated in the page (M6)", () => {
    const sites = pageEvalSites(
      spec({
        steps: [
          { id: "open_it", open: "/" },
          { id: "ready", wait: { app: { path: "store.ready", equals: true } } },
          {
            id: "either",
            wait: {
              any: [
                { text: "Done" },
                { app: { path: "store.done", exists: true } },
              ],
            },
          },
          { id: "plain", wait: { text: "Hi" } },
        ],
      }),
    );
    expect(sites).toEqual([
      "step ready (wait: { app })",
      "step either (wait: { app })",
    ]);
  });
});

describe("parseMaxEvalRatio", () => {
  it("accepts a number or numeric text in 0..1", () => {
    expect(parseMaxEvalRatio(undefined)).toBeUndefined();
    expect(parseMaxEvalRatio("0.25")).toBe(0.25);
    expect(parseMaxEvalRatio(0)).toBe(0);
    expect(parseMaxEvalRatio("1")).toBe(1);
  });

  it("rejects everything else", () => {
    for (const bad of ["-0.1", "1.01", "abc", "", "  ", NaN, 2]) {
      expect(() => parseMaxEvalRatio(bad as string | number)).toThrow(
        /--max-eval-ratio must be a number between 0 and 1/,
      );
    }
  });
});
