import { describe, expect, it } from "vitest";
import {
  annotateLocatorMode,
  compareSides,
  DEFAULT_DURATION_RATIO,
  summarizeDifferential,
} from "./exportVerifyDifferential";
import type { CairnSide, ExportSide } from "./exportVerifyRun";

function cairn(over: Partial<CairnSide> = {}): CairnSide {
  return {
    status: "passed",
    exitCode: 0,
    durationMs: 1000,
    runDir: "run_1",
    steps: [
      { id: "open", status: "passed" },
      { id: "wait", status: "passed" },
    ],
    outcomes: [
      { id: "greeting", status: "passed" },
      { id: "pinged", status: "passed" },
    ],
    network: { pinged: 1 },
    ...over,
  };
}

function exp(over: Partial<ExportSide> = {}): ExportSide {
  return {
    status: "passed",
    fixme: false,
    durationMs: 900,
    steps: [
      { id: "open", status: "passed" },
      { id: "wait", status: "passed" },
      { id: "greeting", status: "passed" },
      { id: "pinged", status: "passed" },
    ],
    network: { pinged: 1 },
    extraTests: 0,
    ...over,
  };
}

function compare(
  c: CairnSide,
  e: ExportSide,
  threshold = DEFAULT_DURATION_RATIO,
) {
  return compareSides({
    spec: "flows/a.yml",
    testFile: "tests/a.spec.ts",
    cairn: c,
    export: e,
    outcomeIds: ["greeting", "pinged"],
    threshold,
  });
}

describe("compareSides", () => {
  it("matches when verdicts, ids and network evidence agree", () => {
    const result = compare(cairn(), exp());
    expect(result.status).toBe("match");
    expect(result.mismatches).toEqual([]);
    expect(result.compared).toEqual({ steps: 2, outcomes: 2 });
    expect(result.network).toEqual([
      { outcome: "pinged", cairn: 1, export: 1 },
    ]);
    expect(result.durationRatio).toBe(0.9);
    expect(result.warnings).toEqual([]);
  });

  it("names the outcome the export judges differently", () => {
    const result = compare(
      cairn(),
      exp({
        status: "failed",
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "passed" },
          { id: "greeting", status: "failed" },
        ],
      }),
    );
    expect(result.status).toBe("mismatch");
    expect(result.mismatches.map((m) => [m.kind, m.id])).toEqual([
      ["verdict", undefined],
      ["outcome", "greeting"],
      ["outcome", "pinged"],
    ]);
    expect(result.mismatches[1]).toMatchObject({
      cairn: "passed",
      export: "failed",
    });
    expect(result.mismatches[2]).toMatchObject({
      export: "skipped",
      detail: expect.stringContaining("stopped before evaluating"),
    });
  });

  it("flags a step whose failed-ness differs, and ignores a step only one side has", () => {
    const result = compare(
      cairn({
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "failed" },
          { id: "cairn_only", status: "passed" },
        ],
      }),
      exp({
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "passed" },
          { id: "greeting", status: "passed" },
          { id: "pinged", status: "passed" },
          { id: "export_only", status: "passed" },
        ],
      }),
    );
    expect(result.mismatches).toEqual([
      expect.objectContaining({ kind: "step", id: "wait" }),
    ]);
    expect(result.unmapped).toEqual({ cairnSteps: 1, exportSteps: 1 });
  });

  it("does not compare a step id that repeats on the cairn side (action steps)", () => {
    const result = compare(
      cairn({
        steps: [
          { id: "submit", status: "passed" },
          { id: "submit", status: "failed" },
        ],
      }),
      exp(),
    );
    expect(result.mismatches).toEqual([]);
    expect(result.compared?.steps).toBe(0);
    expect(result.unmapped?.cairnSteps).toBe(1);
  });

  it("reports an outcome the export has no step for", () => {
    const result = compare(
      cairn(),
      exp({
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "passed" },
          { id: "greeting", status: "passed" },
        ],
      }),
    );
    expect(result.mismatches).toEqual([
      expect.objectContaining({ kind: "missing-outcome", id: "pinged" }),
    ]);
  });

  it("flags a network outcome matched on one side only; a different count is a warning", () => {
    const zero = compare(cairn(), exp({ network: { pinged: 0 } }));
    expect(zero.status).toBe("mismatch");
    expect(zero.mismatches[0]).toMatchObject({ kind: "network", id: "pinged" });
    const more = compare(
      cairn({ network: { pinged: 1 } }),
      exp({ network: { pinged: 3 } }),
    );
    expect(more.status).toBe("match");
    expect(more.warnings[0]).toContain("request counts differ");
  });

  it("warns on a large duration ratio only when the gap is not start-up noise", () => {
    const noisy = compare(cairn({ durationMs: 100 }), exp({ durationMs: 900 }));
    expect(noisy.warnings).toEqual([]);
    const slow = compare(
      cairn({ durationMs: 2000 }),
      exp({ durationMs: 9000 }),
    );
    expect(slow.warnings[0]).toContain("4.5x exceeds 3x");
    const tolerated = compare(
      cairn({ durationMs: 2000 }),
      exp({ durationMs: 9000 }),
      5,
    );
    expect(tolerated.warnings).toEqual([]);
    expect(slow.status).toBe("match");
  });

  it("is inconclusive when the baseline itself did not pass but both agree", () => {
    const result = compare(
      cairn({
        status: "failed",
        outcomes: [
          { id: "greeting", status: "failed" },
          { id: "pinged", status: "skipped" },
        ],
      }),
      exp({
        status: "failed",
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "passed" },
          { id: "greeting", status: "failed" },
        ],
      }),
    );
    expect(result.status).toBe("inconclusive");
    expect(result.reason).toContain("proves nothing");
  });

  it("skips a fixme or gated export, and reports a side that could not run as an error", () => {
    expect(
      compare(cairn(), exp({ status: "skipped", fixme: true })),
    ).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("test.fixme"),
    });
    expect(compare(cairn(), exp({ status: "skipped" })).reason).toContain(
      "gated verifier",
    );
    expect(
      compare(
        cairn({ status: "error", error: "cairn run errored in services" }),
        exp(),
      ),
    ).toMatchObject({
      status: "error",
      reason: "cairn run errored in services",
    });
    expect(
      compare(
        cairn(),
        exp({ status: "error", error: "playwright wrote no JSON report" }),
      ),
    ).toMatchObject({ status: "error" });
  });

  it("never hides a failed cairn run behind a skipped export: inconclusive, with a warning", () => {
    const failedRun = cairn({
      status: "failed",
      exitCode: 1,
      outcomes: [{ id: "greeting", status: "failed" }],
    });
    const fixme = compare(failedRun, exp({ status: "skipped", fixme: true }));
    expect(fixme).toMatchObject({
      status: "inconclusive",
      reason: expect.stringContaining(
        "cairn run failed while the exported test is test.fixme",
      ),
    });
    expect(fixme.warnings[0]).toContain("would not report it");
    // The gated export never judged greeting (the gated verifier): nothing proven.
    const gated = compare(
      failedRun,
      exp({
        status: "skipped",
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "passed" },
          { id: "pinged", status: "passed" },
        ],
      }),
    );
    expect(gated).toMatchObject({
      status: "inconclusive",
      reason: expect.stringContaining("gated verifier"),
    });
  });

  it("compares what a gated export did judge before it ended skipped: a real disagreement is a mismatch, not inconclusive", () => {
    const failedRun = cairn({
      status: "failed",
      exitCode: 1,
      outcomes: [
        { id: "greeting", status: "failed" },
        { id: "pinged", status: "passed" },
      ],
    });
    // greeting ran in the export and passed there, then the gate skipped the test
    const result = compare(failedRun, exp({ status: "skipped" }));
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("ended skipped");
    expect(result.mismatches).toEqual([
      {
        kind: "outcome",
        id: "greeting",
        cairn: "failed",
        export: "passed",
        detail:
          "outcome greeting: cairn run failed, the exported test passed (before it ended skipped)",
      },
    ]);
    // the reverse (export failed a step cairn passed) is one too
    const reverse = compare(
      cairn(),
      exp({
        status: "skipped",
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "failed" },
        ],
      }),
    );
    expect(reverse).toMatchObject({
      status: "mismatch",
      mismatches: [{ kind: "step", id: "wait" }],
    });
    // agreeing verdicts and a skip: still skipped
    expect(compare(cairn(), exp({ status: "skipped" })).status).toBe("skipped");
  });

  it("notes extra tests that matched the file filter", () => {
    expect(compare(cairn(), exp({ extraTests: 2 })).warnings[0]).toContain(
      "2 other test(s)",
    );
  });
});

const spec = (
  status: "match" | "mismatch" | "inconclusive" | "skipped" | "error",
) => ({ status }) as never;
describe("summarizeDifferential", () => {
  it("passes only with at least one match and nothing failed or errored", () => {
    expect(summarizeDifferential([spec("match"), spec("skipped")]).status).toBe(
      "passed",
    );
    expect(
      summarizeDifferential([spec("match"), spec("inconclusive")]).status,
    ).toBe("passed");
    expect(
      summarizeDifferential([spec("match"), spec("mismatch")]).status,
    ).toBe("failed");
    expect(summarizeDifferential([spec("match"), spec("error")]).status).toBe(
      "inconclusive",
    );
    expect(summarizeDifferential([spec("skipped")]).status).toBe(
      "inconclusive",
    );
    expect(summarizeDifferential([]).summary).toEqual({
      match: 0,
      mismatch: 0,
      inconclusive: 0,
      skipped: 0,
      error: 0,
    });
  });
});

describe("annotateLocatorMode", () => {
  const mismatch = () =>
    compare(
      cairn({
        status: "failed",
        outcomes: [
          { id: "greeting", status: "failed" },
          { id: "pinged", status: "passed" },
        ],
      }),
      exp(),
    );

  it("points a default (.first()) export at --strict-locators when cairn failed and the export passed", () => {
    const result = mismatch();
    expect(result.status).toBe("mismatch");
    annotateLocatorMode([result], false);
    expect(result.warnings.join("\n")).toContain("--strict-locators");
  });

  it("adds nothing for a strict export, a match, or a mismatch in the other direction", () => {
    const strict = mismatch();
    annotateLocatorMode([strict], true);
    expect(strict.warnings).toEqual([]);

    const matched = compare(cairn(), exp());
    annotateLocatorMode([matched], false);
    expect(matched.warnings).toEqual([]);

    const exportFailed = compare(
      cairn(),
      exp({
        status: "failed",
        steps: [
          { id: "open", status: "passed" },
          { id: "wait", status: "passed" },
          { id: "greeting", status: "failed" },
          { id: "pinged", status: "passed" },
        ],
      }),
    );
    annotateLocatorMode([exportFailed], false);
    expect(exportFailed.warnings).toEqual([]);
  });
});
