import { describe, expect, it } from "vitest";
import type { Spec } from "../schema/spec.v1";
import {
  PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS,
  PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS,
  playwrightPreconditionTimeoutBudget,
  playwrightProjectTimeoutBudget,
  playwrightTestTimeoutBudget,
} from "./playwrightTimeout";

function spec(overrides: Partial<Spec> = {}): Spec {
  return {
    version: 1,
    name: "timeout_budget",
    intent: "calculate a bounded Playwright timeout",
    mode: "normal",
    steps: [],
    outcomes: [
      {
        id: "visible",
        description: "page is visible",
        verify: { text: { contains: "ready" }, region: "page" },
      },
    ],
    ...overrides,
  } as Spec;
}

function nodeOutcome(id: string, timeoutMs: number) {
  return {
    id,
    description: `${id} completes`,
    verify: {
      script: {
        runtime: "node" as const,
        file: "../verifiers/check.ts",
        timeoutMs,
      },
    },
  };
}

describe("Playwright export timeout budgets", () => {
  it("keeps short specs on the 30-minute compatibility floor", () => {
    expect(playwrightTestTimeoutBudget(spec())).toMatchObject({
      timeoutMs: PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS,
      capped: false,
    });
  });

  it("adds sequential node verifier budgets plus 10% headroom", () => {
    const budget = playwrightTestTimeoutBudget(
      spec({
        outcomes: [
          nodeOutcome("source", 2_400_000),
          nodeOutcome("cascade", 2_400_000),
          nodeOutcome("connection", 2_400_000),
        ],
      }),
    );

    expect(budget).toEqual({
      declaredMs: 7_200_000,
      overheadMs: 720_000,
      timeoutMs: 7_920_000,
      capped: false,
    });
  });

  it("includes explicit step waits in the sequential budget", () => {
    const budget = playwrightTestTimeoutBudget(
      spec({
        steps: [
          { wait: { load: "networkidle", timeoutMs: 900_000 } },
          { eval: { js: "return true", timeoutMs: 600_000 } },
        ],
        outcomes: [nodeOutcome("processed", 1_200_000)],
      }),
    );

    expect(budget).toEqual({
      declaredMs: 2_700_000,
      overheadMs: 270_000,
      timeoutMs: 2_970_000,
      capped: false,
    });
  });

  it("caps oversized specs at four hours and marks the truncation", () => {
    expect(
      playwrightTestTimeoutBudget(
        spec({ outcomes: [nodeOutcome("oversized", 5 * 60 * 60 * 1000)] }),
      ),
    ).toMatchObject({
      timeoutMs: PLAYWRIGHT_EXPORTED_TEST_MAX_TIMEOUT_MS,
      capped: true,
    });
  });

  it("uses the largest test or sequential precondition hook for a project", () => {
    const preconditionHeavy = spec({
      name: "precondition_heavy",
      preconditions: {
        commands: [
          { run: "first", timeoutMs: 1_200_000 },
          { run: "second", timeoutMs: 1_200_000 },
        ],
      },
    });
    const hook = playwrightPreconditionTimeoutBudget(preconditionHeavy);
    const project = playwrightProjectTimeoutBudget([
      spec({ outcomes: [nodeOutcome("processed", 1_800_000)] }),
      preconditionHeavy,
    ]);

    expect(hook).toMatchObject({
      declaredMs: 2_400_000,
      timeoutMs: 2_640_000,
      capped: false,
    });
    expect(project).toEqual(hook);
  });
});
