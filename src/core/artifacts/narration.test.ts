import { describe, expect, it } from "vitest";
import type { RunResult } from "../schema/run.v1";
import type { ProgressListener } from "../runner/Runner";
import { combineListeners, makePlainNarration } from "./narration";

describe("makePlainNarration", () => {
  it("adds a run-end line only when asked (run.log)", () => {
    const lines: string[] = [];
    const narration = makePlainNarration({
      write: (text) => lines.push(text),
      runEnd: true,
      now: () => new Date("2026-10-01T12:34:56.000Z"),
    });
    narration.onRunEnd?.({
      status: "failed",
      durationMs: 61_500,
      summary: "outcome 'welcome_copy' failed",
    } as RunResult);
    expect(lines).toEqual([
      "[12:34:56] run end: failed in 1m 1s (outcome 'welcome_copy' failed)\n",
    ]);
    expect(
      makePlainNarration({ write: () => undefined }).onRunEnd,
    ).toBeUndefined();
  });
});

describe("combineListeners", () => {
  it("calls every listener in order and propagates a caller's error", () => {
    const calls: string[] = [];
    const first: ProgressListener = {
      onOutcomesStart: (total) => calls.push(`first ${total}`),
    };
    const second: ProgressListener = {
      onOutcomesStart: (total) => calls.push(`second ${total}`),
      onPreconditionStart: () => {
        throw new Error("caller listener crashed");
      },
    };
    const combined = combineListeners(first, undefined, second);
    combined.onOutcomesStart?.(2);
    expect(calls).toEqual(["first 2", "second 2"]);
    expect(() => combined.onPreconditionStart?.("guard", 10)).toThrow(
      "caller listener crashed",
    );
    // Callbacks no listener implements are harmless no-ops.
    expect(() =>
      combined.onStepStart?.(0, { wait: { ms: 1 } }, "s"),
    ).not.toThrow();
  });
});
