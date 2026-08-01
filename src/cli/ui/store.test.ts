import { describe, expect, it } from "vitest";
import {
  createTuiState,
  reduceTui,
  statusVariant,
  TuiStore,
  type RowStatus,
  type TuiEvent,
  type TuiState,
} from "./store";

function run(events: TuiEvent[]): TuiState {
  return events.reduce(reduceTui, createTuiState());
}

describe("reduceTui", () => {
  it("accumulates notes and caps them", () => {
    const events: TuiEvent[] = Array.from({ length: 60 }, (_, i) => ({
      type: "note",
      kind: "info",
      message: `note-${i}`,
    }));
    const state = run(events);
    expect(state.notes).toHaveLength(50);
    expect(state.notes[0]!.message).toBe("note-10");
    expect(state.notes[49]!.message).toBe("note-59");
  });

  it("tracks services phases as a task list with output buffering", () => {
    let state = run([
      { type: "services-start", phase: "docker", message: "docker compose up" },
      {
        type: "services-output",
        chunk: "Container graphite-mongo-1 Started\n",
      },
    ]);
    // Docker status spam is dropped (kept in service-log artifacts).
    expect(state.services.phases[0]!.output).toEqual([]);

    state = reduceTui(state, {
      type: "services-finish",
      phase: "docker",
      status: "passed",
      message: "docker ready",
    });
    state = reduceTui(state, {
      type: "services-start",
      phase: "seed",
      message: "seed — running",
    });
    state = reduceTui(state, {
      type: "services-output",
      chunk: "imported 42 records\nimported 43 records\n",
    });
    state = reduceTui(state, {
      type: "services-finish",
      phase: "seed",
      status: "passed",
      message: "seed complete",
    });

    expect(state.services.phases.map((p) => p.phase)).toEqual([
      "docker",
      "seed",
    ]);
    expect(state.services.phases[0]).toMatchObject({ status: "passed" });
    expect(state.services.phases[1]!.output).toEqual([
      "imported 42 records",
      "imported 43 records",
    ]);
  });

  it("resets the run view on run-start and tracks steps/outcomes", () => {
    const state = run([
      {
        type: "run-start",
        run: {
          specName: "s",
          runId: "r",
          runDir: "d",
          backend: "mock",
          environment: "local",
        },
      },
      { type: "step-start", id: "open_app" },
      { type: "step-finish", id: "open_app", status: "passed", durationMs: 12 },
      { type: "outcome-start", id: "ok" },
      {
        type: "outcome-finish",
        id: "ok",
        status: "failed",
        expected: "x",
        actual: "y",
      },
    ]);
    expect(state.run?.specName).toBe("s");
    expect(state.steps).toEqual([
      { id: "open_app", status: "passed", durationMs: 12 },
    ]);
    expect(state.outcomes).toEqual([
      { id: "ok", status: "failed", expected: "x", actual: "y" },
    ]);
  });

  it("tracks batch rows and builds the summary from run-end for singles", () => {
    const state = run([
      { type: "specs-count", count: 2 },
      { type: "spec-start", idx: 0, total: 2, label: "a" },
      {
        type: "spec-finish",
        idx: 0,
        status: "failed",
        name: "a",
        durationMs: 10,
        passed: 0,
        totalOutcomes: 1,
      },
      { type: "spec-start", idx: 1, total: 2, label: "b" },
      {
        type: "spec-finish",
        idx: 1,
        status: "passed",
        name: "b",
        durationMs: 5,
        passed: 1,
        totalOutcomes: 1,
      },
    ]);
    expect(state.batch).toHaveLength(2);
    expect(state.batch[0]).toMatchObject({ status: "failed", passed: 0 });
    expect(state.batch[1]).toMatchObject({ status: "passed", passed: 1 });

    const single = run([
      {
        type: "run-start",
        run: {
          specName: "s",
          runId: "r",
          runDir: "d",
          backend: "m",
          environment: "l",
        },
      },
      { type: "run-end", status: "passed", durationMs: 42 },
    ]);
    expect(single.summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      durationMs: 42,
    });
  });

  it("tracks startedAt on running rows for the live elapsed", () => {
    const state = run([
      { type: "step-start", id: "slow_step" },
      { type: "precondition-start", id: "gate" },
      { type: "outcome-start", id: "verify" },
      { type: "specs-count", count: 2 },
      { type: "spec-start", idx: 0, total: 2, label: "a" },
      { type: "services-start", phase: "seed", message: "importing" },
    ]);
    expect(state.steps[0]!.startedAt).toBeTypeOf("number");
    expect(state.preconditions[0]!.startedAt).toBeTypeOf("number");
    expect(state.outcomes[0]!.startedAt).toBeTypeOf("number");
    expect(state.batch[0]!.startedAt).toBeTypeOf("number");
    expect(state.services.phases[0]!.startedAt).toBeTypeOf("number");
  });

  it("keeps the phase duration from the first start (postCommands don't reset it)", () => {
    const t0 = Date.now();
    let state = run([
      { type: "services-start", phase: "seed", message: "importing" },
      {
        type: "services-finish",
        phase: "seed",
        status: "passed",
        message: "seed complete",
      },
    ]);
    const firstStart = state.services.phases[0]!.startedAt;
    expect(firstStart).toBeGreaterThanOrEqual(t0);
    // A postCommand re-start must NOT move the phase start forward.
    state = reduceTui(state, {
      type: "services-start",
      phase: "seed",
      message: "postCommand: ensure-fixture",
    });
    state = reduceTui(state, {
      type: "services-finish",
      phase: "seed",
      status: "passed",
      message: "postCommand ok",
    });
    expect(state.services.phases[0]!.startedAt).toBe(firstStart);
  });

  it("stores a fatal error", () => {
    const state = run([{ type: "fatal", message: "seed command failed" }]);
    expect(state.fatal).toBe("seed command failed");
  });
});

describe("statusVariant", () => {
  it("maps row statuses to StatusMessage variants", () => {
    const cases: Array<[RowStatus, string]> = [
      ["passed", "success"],
      ["failed", "error"],
      ["errored", "error"],
      ["warn", "warning"],
      ["running", "info"],
      ["skipped", "info"],
    ];
    for (const [status, variant] of cases) {
      expect(statusVariant(status)).toBe(variant);
    }
  });
});

describe("TuiStore", () => {
  it("notifies subscribers and returns a stable snapshot between pushes", () => {
    const store = new TuiStore();
    const before = store.getSnapshot();
    let notified = 0;
    store.subscribe(() => notified++);
    store.push({ type: "note", kind: "info", message: "hello" });
    expect(notified).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().notes[0]!.message).toBe("hello");
    // Same reference until the next push.
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
});
