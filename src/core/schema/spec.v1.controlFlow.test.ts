/* oxlint-disable unicorn/no-thenable -- `if.then` in spec fixtures is a step list, never a function */
import { describe, expect, it } from "vitest";
import { RunEventSchema } from "./events.v1";
import { StepResultSchema } from "./run.v1";
import {
  backendWaitCondition,
  isControlFlowStep,
  isRunnerDrivenWait,
  nestedStepLists,
  SpecSchema,
  StepSchema,
  TeardownSchema,
  WaitStepConditionSchema,
  walkSteps,
  type Step,
} from "./spec.v1";

const click = { click: { by: "selector", selector: "#go" } };

describe("F14 control-flow steps (schema)", () => {
  it("accepts repeat with until, indexVar and onMax, nesting if inside", () => {
    const step = StepSchema.parse({
      id: "rows",
      repeat: {
        max: 100,
        until: { text: "Done" },
        indexVar: "row",
        onMax: "continue",
        steps: [
          {
            if: {
              condition: { var: "repeat.row", in: [0, 1] },
              then: [click],
              else: [{ wait: { ms: 100 } }],
            },
          },
        ],
      },
    });
    expect(isControlFlowStep(step)).toBe(true);
    expect(walkSteps([step]).map((s) => Object.keys(s).at(-1))).toEqual([
      "repeat",
      "if",
      "click",
      "wait",
    ]);
    expect(nestedStepLists(step).map((list) => list.key)).toEqual(["steps"]);
  });

  it("rejects a repeat over the cap, without steps, or with a reserved indexVar", () => {
    expect(
      StepSchema.safeParse({ repeat: { max: 101, steps: [click] } }).success,
    ).toBe(false);
    expect(
      StepSchema.safeParse({ repeat: { max: 2, steps: [] } }).success,
    ).toBe(false);
    expect(
      StepSchema.safeParse({
        repeat: { max: 2, indexVar: "index", steps: [click] },
      }).success,
    ).toBe(false);
    expect(
      StepSchema.safeParse({ repeat: { max: 2, steps: [click], extra: 1 } })
        .success,
    ).toBe(false);
  });

  it("rejects a nested step that is itself invalid", () => {
    expect(
      StepSchema.safeParse({
        if: { condition: "text:x", then: [{ click: { by: "nope" } }] },
      }).success,
    ).toBe(false);
  });

  it("validates var predicates: exactly one comparison, comparisons only with var", () => {
    for (const when of [
      { var: "mode", equals: "fast" },
      { var: "region", in: ["eu", 2, true] },
      { var: "waits.banner.matched", exists: true },
      { url: { includes: "/done" } },
    ]) {
      expect(StepSchema.safeParse({ ...click, when }).success).toBe(true);
    }
    for (const when of [
      { var: "mode" },
      { var: "mode", equals: "a", exists: true },
      { text: "x", equals: "y" },
      { var: "bad name" },
      { var: "mode", equals: "a", text: "x" },
    ]) {
      expect(StepSchema.safeParse({ ...click, when }).success).toBe(false);
    }
  });

  it("accepts wait.any / wait.all / optional + assign, and keeps budgets on the group", () => {
    expect(
      WaitStepConditionSchema.parse({
        any: [{ text: "Saved" }, { selector: ".error" }],
        timeoutMs: 5000,
        assign: "saved",
      }),
    ).toMatchObject({ assign: "saved" });
    expect(
      WaitStepConditionSchema.safeParse({
        all: [{ text: "A", timeoutMs: 10 }],
      }).success,
    ).toBe(false);
    const optional = WaitStepConditionSchema.parse({
      text: "Banner",
      optional: true,
      assign: "banner",
    });
    expect(isRunnerDrivenWait(optional)).toBe(true);
    expect(() => backendWaitCondition(optional)).toThrow(
      /polled by the runner/,
    );
    expect(
      backendWaitCondition({ text: "Plain", assign: "seen", timeoutMs: 5 }),
    ).toEqual({ text: "Plain", timeoutMs: 5 });
  });

  it("accepts use.retry and rejects an unbounded one", () => {
    expect(
      StepSchema.safeParse({
        use: {
          action: "submit_form",
          retry: { times: 3, until: { text: "Thanks" }, delayMs: 500 },
        },
      }).success,
    ).toBe(true);
    expect(
      StepSchema.safeParse({ use: { action: "x", retry: { times: 0 } } })
        .success,
    ).toBe(false);
    expect(
      StepSchema.safeParse({ use: { action: "x", retry: { times: 11 } } })
        .success,
    ).toBe(false);
  });

  it("keeps flat specs valid and refuses control flow in teardown", () => {
    const flat = SpecSchema.parse({
      version: 1,
      name: "flat",
      intent: "unchanged",
      outcomes: [
        { id: "o", description: "d", verify: { console: { errorsMax: 0 } } },
      ],
      steps: [{ open: "/" }, { wait: { text: "Hi" } }],
    });
    expect(flat.steps).toHaveLength(2);
    expect(
      TeardownSchema.safeParse([{ repeat: { max: 1, steps: [click] } }])
        .success,
    ).toBe(false);
  });

  it("types nested steps as Step (recursive)", () => {
    const steps: Step[] = [
      { if: { condition: "text:x", then: [{ open: "/a" }] } },
    ];
    expect(StepSchema.array().parse(steps)).toEqual(steps);
  });
});

describe("F14 event and result fields are additive", () => {
  it("step events accept parentId / iteration / branch / iterations / matched / taken", () => {
    const ts = "2026-10-02T00:00:00.000Z";
    expect(
      RunEventSchema.parse({
        ts,
        type: "step.started",
        stepId: "loop.1",
        index: 1,
        total: 1,
        kind: "click",
        parentId: "loop",
        iteration: 2,
      }),
    ).toMatchObject({ parentId: "loop", iteration: 2 });
    expect(
      RunEventSchema.parse({
        ts,
        type: "step.finished",
        stepId: "gate",
        durationMs: 3,
        taken: "else",
        iterations: 0,
      }),
    ).toMatchObject({ taken: "else" });
    expect(
      RunEventSchema.safeParse({
        ts,
        type: "step.started",
        stepId: "x",
        branch: "maybe",
      }).success,
    ).toBe(false);
    // An event of a flat spec is unchanged.
    expect(
      RunEventSchema.parse({ ts, type: "step.started", stepId: "x" }),
    ).toEqual({ ts, type: "step.started", stepId: "x" });
  });

  it("run.json step results accept the control-flow fields", () => {
    expect(
      StepResultSchema.parse({
        id: "submit",
        status: "passed",
        durationMs: 10,
        iterations: 2,
        retries: [{ attempt: 1, error: "boom" }],
      }),
    ).toMatchObject({ iterations: 2 });
    expect(
      StepResultSchema.parse({
        id: "w",
        status: "passed",
        durationMs: 1,
        matched: false,
        parentId: "p",
        iteration: 1,
        branch: "then",
      }),
    ).toMatchObject({ matched: false, branch: "then" });
  });
});
