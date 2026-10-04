import { describe, expect, it } from "vitest";
import type { Spec } from "../schema/spec.v1";
import {
  isDocumentaryPrecondition,
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
  it("derives short UI-only specs from their budgets instead of a 30-minute floor", () => {
    const budget = playwrightTestTimeoutBudget(spec());
    expect(budget).toEqual({
      declaredMs: 30_000,
      overheadMs: 60_000,
      timeoutMs: 90_000,
      capped: false,
    });
    expect(budget.floorReason).toBeUndefined();
  });

  it("keeps the 30-minute floor when a durable node verifier runs", () => {
    expect(
      playwrightTestTimeoutBudget(
        spec({ outcomes: [nodeOutcome("processed", 60_000)] }),
      ),
    ).toMatchObject({
      timeoutMs: PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS,
      floorReason: "nodeVerifier",
    });
  });

  it("floors the beforeAll budget only for long preconditions and ignores echo notes", () => {
    const short = playwrightPreconditionTimeoutBudget(
      spec({
        preconditions: {
          commands: [
            { run: "echo app must be running" },
            { run: "bun run seed", timeoutMs: 10_000 },
          ],
        },
      }),
    );
    expect(short).toEqual({
      declaredMs: 10_000,
      overheadMs: 60_000,
      timeoutMs: 70_000,
      capped: false,
    });
    const long = playwrightPreconditionTimeoutBudget(
      spec({
        preconditions: {
          commands: [{ run: "bun run migrate", timeoutMs: 6 * 60_000 }],
        },
      }),
    );
    expect(long).toMatchObject({
      timeoutMs: PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS,
      floorReason: "longPrecondition",
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
      floorReason: "nodeVerifier",
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
      floorReason: "nodeVerifier",
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

  it("budgets a step by its network postcondition deadline when that is longer", () => {
    const budget = playwrightTestTimeoutBudget(
      spec({
        steps: [
          { id: "open", open: "/upload" },
          {
            id: "upload",
            upload: { by: "label", name: "File", path: "./a.txt" },
            postcondition: {
              network: {
                urlContains: "/api/upload",
                status: { equals: 200 },
                timeoutMs: 600_000,
              },
            },
          },
        ] as Spec["steps"],
      }),
    );
    // open 30s + max(upload 30s, postcondition 600s) + text outcome 30s.
    expect(budget.declaredMs).toBe(660_000);
    expect(budget.timeoutMs).toBeGreaterThan(600_000);
    expect(budget.timeoutMs).toBe(726_000);
  });

  it("keeps the action budget when it exceeds the postcondition default", () => {
    const budget = playwrightTestTimeoutBudget(
      spec({
        outcomes: [],
        steps: [
          {
            id: "slow_click",
            click: {
              by: "role",
              role: "button",
              name: "Save",
              until: { text: "Saved", timeoutMs: 90_000 },
            },
            postcondition: {
              network: { urlContains: "/api/save", status: { equals: 200 } },
            },
          },
        ] as Spec["steps"],
      }),
    );
    expect(budget.declaredMs).toBe(90_000);
  });
});

describe("isDocumentaryPrecondition", () => {
  it.each([
    "echo demo-app must be running on :8787",
    'echo "stack is assumed up; seed first"',
    "echo 'uses && and | inside single quotes'",
    "  echo",
  ])("treats %j as a note", (run) => {
    expect(isDocumentaryPrecondition(run)).toBe(true);
  });

  it.each([
    'echo "resetting database" && docker compose exec db psql -c "truncate items"',
    "echo reset || make reset",
    "echo a; make seed",
    "echo a | tee /tmp/log",
    "echo a > /tmp/flag",
    "echo $(make seed)",
    'echo "$(make seed)"',
    "echo `make seed`",
    "echo a & make seed",
    "echo a\nmake seed",
    "echoed-tool --reset",
    "make seed",
  ])("treats %j as executable", (run) => {
    expect(isDocumentaryPrecondition(run)).toBe(false);
  });
});

describe("the 30-minute floor depends on what the export emits (E10)", () => {
  const withNode = spec({
    outcomes: [
      nodeOutcome("durable", 5 * 60 * 1000),
      {
        id: "db",
        description: "db row",
        verify: {
          mongo: {
            source: "main",
            collection: "c",
            filter: {},
            expect: { count: 1 },
          },
        },
      },
    ],
  } as Partial<Spec>);

  it("keeps the floor for an exported node verifier, and for gate (it can run)", () => {
    for (const verifiers of [undefined, "keep", "gate"] as const) {
      const budget = playwrightTestTimeoutBudget(
        withNode,
        verifiers ? { verifiers } : {},
      );
      expect(budget.floorReason).toBe("nodeVerifier");
      expect(budget.timeoutMs).toBe(PLAYWRIGHT_EXPORTED_TEST_MIN_TIMEOUT_MS);
    }
  });

  it("--verifiers drop emits no node verifier: no floor, and the verifier adds no budget", () => {
    const budget = playwrightTestTimeoutBudget(withNode, { verifiers: "drop" });
    expect(budget.floorReason).toBeUndefined();
    expect(budget.declaredMs).toBe(0);
    expect(budget.timeoutMs).toBe(60_000);
  });

  it("a datasource verifier is never emitted, so it never reserves 30 seconds", () => {
    const onlyDb = spec({
      outcomes: [
        {
          id: "db",
          description: "db row",
          verify: {
            mongo: {
              source: "main",
              collection: "c",
              filter: {},
              expect: { count: 1 },
            },
          },
        },
      ],
    } as Partial<Spec>);
    expect(playwrightTestTimeoutBudget(onlyDb).declaredMs).toBe(0);
  });

  it("run steps and teardown count only when they are emitted", () => {
    const authored = spec({
      steps: [
        { id: "seed", run: { shell: "seed", timeoutMs: 40_000 } },
        {
          id: "cap",
          capture: { assign: "t", text: { by: "role", role: "heading" } },
        },
      ],
      teardown: {
        steps: [{ id: "clean", run: { shell: "clean", timeoutMs: 20_000 } }],
        timeoutMs: 90_000,
      },
    } as unknown as Partial<Spec>);
    // Not emitted: only the capture (5s default wait) + the outcome (30s).
    expect(playwrightTestTimeoutBudget(authored).declaredMs).toBe(35_000);
    // Emitted: + the run step's own timeout + the teardown's items (<= its budget).
    expect(
      playwrightTestTimeoutBudget(authored, { hostCommands: true }).declaredMs,
    ).toBe(35_000 + 40_000 + 20_000);
    // A teardown's budget caps what it can add.
    const capped = spec({
      steps: [],
      teardown: {
        steps: [{ id: "clean", run: { shell: "clean", timeoutMs: 200_000 } }],
        timeoutMs: 30_000,
      },
    } as unknown as Partial<Spec>);
    expect(
      playwrightTestTimeoutBudget(capped, { hostCommands: true }).declaredMs,
    ).toBe(30_000 + 30_000);
  });

  it("a polled outcome reserves its poll window", () => {
    const polled = spec({
      outcomes: [
        {
          id: "soon",
          description: "shows soon",
          verify: { text: { contains: "x" }, poll: { timeoutMs: 120_000 } },
        },
      ],
    } as unknown as Partial<Spec>);
    expect(playwrightTestTimeoutBudget(polled).declaredMs).toBe(150_000);
  });

  it("a project does not budget preconditions it does not run in a beforeAll", () => {
    const longPre = spec({
      preconditions: {
        commands: [{ run: "bun run seed", timeoutMs: 10 * 60 * 1000 }],
      },
    } as unknown as Partial<Spec>);
    const inline = playwrightProjectTimeoutBudget([longPre]);
    expect(inline.floorReason).toBe("longPrecondition");
    const elsewhere = playwrightProjectTimeoutBudget([longPre], {
      inlinePreconditions: false,
    });
    expect(elsewhere.floorReason).toBeUndefined();
    expect(elsewhere.timeoutMs).toBe(60_000 + 30_000);
  });
});
