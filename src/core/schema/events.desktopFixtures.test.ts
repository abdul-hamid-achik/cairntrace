import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RunEventSchema } from "./events.v1";

/**
 * Cairntrace Studio (desktop/) folds events with its own JS reducer and tests
 * it against hand-written and recorded fixtures. Those fixtures must be
 * events the runner can actually write: every line validates against the
 * strict events.v1 producer schema, a run stream never carries the
 * journal-only `hook.*` / `invocation.*` events (the runner writes those to
 * `_invocations/<id>/events.ndjson`), and a journal stream never carries a
 * run's own events. `unknown-events.ndjson` is the one deliberate exception:
 * it exercises forward compatibility with event types this build lacks.
 */
const FIXTURES = fileURLToPath(
  new URL("../../../desktop/test/fixtures/", import.meta.url),
);
const FORWARD_COMPAT = new Set(["unknown-events.ndjson"]);

const fixtures = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".ndjson") && !FORWARD_COMPAT.has(name))
  .toSorted();

function lines(name: string): Array<Record<string, unknown>> {
  return readFileSync(`${FIXTURES}${name}`, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const JOURNAL_ONLY = /^(hook|invocation)\./;
const RUN_ONLY =
  /^(run\.(started|passed|failed|errored)|step\.|outcome\.|precondition\.|artifact\.|viewport\.)/;

describe("desktop event fixtures", () => {
  it("has fixtures to check", () => {
    expect(fixtures.length).toBeGreaterThan(3);
  });

  it.each(fixtures)("%s validates line by line against events.v1", (name) => {
    for (const [i, event] of lines(name).entries()) {
      const parsed = RunEventSchema.safeParse(event);
      expect(
        parsed.success,
        `${name}:${i + 1} ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    }
  });

  it.each(fixtures)("%s keeps run and journal events apart", (name) => {
    const events = lines(name);
    const types = events.map((event) => String(event.type));
    const isRunStream = types.includes("run.started");
    const isJournal = types.includes("invocation.started");
    expect(isRunStream !== isJournal, `${name}: run stream or journal`).toBe(
      true,
    );
    const misplaced = types.filter((type) =>
      isRunStream ? JOURNAL_ONLY.test(type) : RUN_ONLY.test(type),
    );
    expect(misplaced, name).toEqual([]);
  });
});
