import { describe, it, expect } from "vitest";
import { buildRunNextActions, type RunResult } from "./run.v1";

type NextActionsInput = Pick<RunResult, "status" | "failure" | "spec">;

const specPath = "/tmp/cairntrace/specs/demo.yml";

const input = (
  status: RunResult["status"],
  failure?: RunResult["failure"],
): NextActionsInput => ({
  status,
  failure,
  spec: { name: "demo", path: specPath },
});

describe("buildRunNextActions", () => {
  it("passed → no next actions", () => {
    expect(buildRunNextActions(input("passed"))).toEqual([]);
  });

  it("step-level failure → keeps rerun AND adds a heal action", () => {
    const acts = buildRunNextActions(
      input("failed", { step: "nav", message: "element not found" }),
    );

    // Existing rerun guidance is still present and first.
    expect(acts[0]!.command).toBe(`cairn run ${specPath} --json`);
    expect(acts[0]!.reason).toContain("nav");
    expect(acts[0]!.safeToAutoRun).toBe(false);

    // A heal action points at the actual spec path and is not auto-runnable
    // (heal mutates the spec).
    const heal = acts.find((a) => a.command?.includes("cairn spec heal"));
    expect(heal).toBeDefined();
    expect(heal!.command).toBe(`cairn spec heal ${specPath} --verify --json`);
    expect(heal!.reason).toContain("drift");
    expect(heal!.safeToAutoRun).toBe(false);

    const brief = acts.find((a) => a.command?.includes("cairn export brief"));
    expect(brief?.command).toBe(`cairn export brief ${specPath} --format md`);
    expect(brief?.safeToAutoRun).toBe(false);
  });

  it("outcome-only failure → no heal action (behavior regression, not drift)", () => {
    const acts = buildRunNextActions(
      input("failed", { outcome: "seesCart", message: "expected text 'Cart'" }),
    );

    expect(acts.some((a) => a.command?.includes("cairn spec heal"))).toBe(
      false,
    );
    // Rerun guidance still present.
    expect(acts[0]!.command).toBe(`cairn run ${specPath} --json`);
    expect(acts[0]!.reason).toContain("seesCart");
    expect(acts[0]!.safeToAutoRun).toBe(false);
  });

  it("crash/errored (no step or outcome) → rerun only, no heal", () => {
    const acts = buildRunNextActions(
      input("errored", { message: "browser crashed" }),
    );
    expect(acts.some((a) => a.command?.includes("cairn spec heal"))).toBe(
      false,
    );
    expect(acts[0]!.command).toBe(`cairn run ${specPath} --json`);
  });
});
