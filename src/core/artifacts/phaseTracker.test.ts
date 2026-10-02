import { afterEach, describe, expect, it, vi } from "vitest";
import { RunEventSchema, type RunEvent } from "../schema/events.v1";
import { HEARTBEAT_INTERVAL_MS, PhaseTracker } from "./phaseTracker";

function collector(): {
  events: RunEvent[];
  append: (e: RunEvent) => Promise<void>;
} {
  const events: RunEvent[] = [];
  return {
    events,
    append: async (event) => {
      events.push(event);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PhaseTracker", () => {
  it("writes phase.changed with budget and deadline", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const sink = collector();
    const tracker = new PhaseTracker({
      append: sink.append,
      intervalMs: 0,
      now: () => now,
    });
    await tracker.enter("preconditions", { item: "quiesce", budgetMs: 1500 });
    now += 10;
    await tracker.enter("steps");
    tracker.stop();

    expect(sink.events).toEqual([
      {
        ts: "2026-01-01T00:00:00.000Z",
        type: "phase.changed",
        phase: "preconditions",
        item: "quiesce",
        budgetMs: 1500,
        deadline: "2026-01-01T00:00:01.500Z",
      },
      {
        ts: "2026-01-01T00:00:00.010Z",
        type: "phase.changed",
        phase: "steps",
      },
    ]);
    for (const event of sink.events) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("beats with elapsed time in the current item and total run time", async () => {
    let now = 1_000;
    const sink = collector();
    const tracker = new PhaseTracker({
      append: sink.append,
      intervalMs: 0,
      pid: 4242,
      now: () => now,
    });
    await tracker.enter("outcomes");
    now = 3_000;
    tracker.setItem("tasks_terminal", 300_000);
    now = 18_000;
    await tracker.beat();
    tracker.stop();

    expect(sink.events.at(-1)).toEqual({
      ts: new Date(18_000).toISOString(),
      type: "run.heartbeat",
      phase: "outcomes",
      item: "tasks_terminal",
      elapsedMs: 15_000,
      budgetMs: 300_000,
      runElapsedMs: 17_000,
      pid: 4242,
    });
    expect(RunEventSchema.safeParse(sink.events.at(-1)).success).toBe(true);
  });

  it("heartbeats on the interval and stops for good", async () => {
    vi.useFakeTimers();
    const sink = collector();
    const tracker = new PhaseTracker({ append: sink.append });
    await tracker.enter("preconditions", { item: "seed", budgetMs: 60_000 });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 10);
    const beats = sink.events.filter((e) => e.type === "run.heartbeat");
    expect(beats).toHaveLength(2);
    expect(beats[0]).toMatchObject({
      phase: "preconditions",
      item: "seed",
      budgetMs: 60_000,
      pid: process.pid,
    });

    tracker.stop();
    tracker.stop();
    const count = sink.events.length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    await tracker.enter("outcomes");
    await tracker.beat();
    expect(sink.events).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never throws when the sink fails", async () => {
    const tracker = new PhaseTracker({
      append: async () => {
        throw new Error("disk full");
      },
      intervalMs: 0,
    });
    await expect(tracker.enter("steps")).resolves.toBeUndefined();
    await expect(tracker.beat()).resolves.toBeUndefined();
    tracker.stop();
  });
});
