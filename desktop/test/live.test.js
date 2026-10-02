/**
 * Live run tracking: run-directory discovery and the poller that tails a run
 * in flight (event description + roll-up live in events.test.js).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const live = require("../lib/live");
const { cleanup, makeRun, tempDir } = require("./helpers");

after(cleanup);

/**
 * A run id stamped `now`, in cairn's `<iso-ish>_<spec>_<hex>` shape.
 * @param {string} spec
 * @param {Date} [when]
 */
function runIdNow(spec = "demo_spec", when = new Date()) {
  const iso = when.toISOString().replace(/:/g, "-").replace(".", "-");
  return `${iso}_${spec}_${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
}

describe("runIdTimestampMs", () => {
  it("parses the run-id prefix as UTC", () => {
    assert.equal(
      live.runIdTimestampMs("2026-09-01T10-00-00-000Z"),
      Date.parse("2026-09-01T10:00:00.000Z"),
    );
  });

  it("returns null for anything else", () => {
    assert.equal(live.runIdTimestampMs("nonsense"), null);
    assert.equal(live.runIdTimestampMs(null), null);
  });
});

describe("pickNewRunId", () => {
  it("ignores run ids that already existed", () => {
    const known = new Set(["2026-09-01T10-00-00-000Z_a_aaaaaa"]);
    assert.equal(
      live.pickNewRunId([...known], {
        knownIds: known,
        startedAtMs: Date.parse("2026-09-01T10:00:00Z"),
      }),
      null,
    );
  });

  it("picks the newest run for the requested spec", () => {
    const now = Date.now();
    const mine = runIdNow("checkout", new Date(now));
    const other = runIdNow("login", new Date(now));
    const ids = [mine, other].toSorted((a, b) => b.localeCompare(a));
    assert.equal(
      live.pickNewRunId(ids, {
        specNames: ["checkout"],
        knownIds: [],
        startedAtMs: now,
      }),
      mine,
    );
  });

  it("accepts any of several candidate names (file basename vs spec name)", () => {
    const now = Date.now();
    const mine = runIdNow("dashboard_nav", new Date(now));
    const ids = [mine];
    assert.equal(
      live.pickNewRunId(ids, {
        specNames: new Set(["01-dashboard-nav", "dashboard_nav"]),
        knownIds: [],
        startedAtMs: now,
      }),
      mine,
    );
    assert.equal(
      live.pickNewRunId(ids, {
        specNames: new Set(["unrelated"]),
        knownIds: [],
        startedAtMs: now,
      }),
      null,
    );
  });

  it("rejects a directory older than the run we started", () => {
    const stale = "2020-01-01T00-00-00-000Z_demo_spec_aaaaaa";
    assert.equal(live.pickNewRunId([stale], { startedAtMs: Date.now() }), null);
  });

  it("rejects a directory stamped too far in the future", () => {
    const future = runIdNow("demo_spec", new Date(Date.now() + 10 * 60_000));
    assert.equal(
      live.pickNewRunId([future], { startedAtMs: Date.now() }),
      null,
    );
  });

  it("accepts a run id it cannot timestamp-parse", () => {
    assert.equal(
      live.pickNewRunId(["weird-dir-name"], { startedAtMs: Date.now() }),
      "weird-dir-name",
    );
  });
});

describe("createLiveTail", () => {
  it("finds the new run directory, streams events, and ends on run.json", async () => {
    const runsRoot = tempDir("cairn-live-");
    const preexisting = makeRun(
      runsRoot,
      "2026-08-01T00-00-00-000Z_old_spec_aaaaaa",
    );
    const knownIds = new Set([path.basename(preexisting)]);
    const runId = runIdNow("live_spec");

    /** @type {string[]} */
    const seenDirs = [];
    /** @type {any[]} */
    const seenEvents = [];
    let ended = 0;

    const tail = live.createLiveTail({
      runsRoot,
      specNames: ["live_spec"],
      knownIds,
      pollMs: 60,
      lingerMs: 300,
      onRunDir: (dir, id) => seenDirs.push(id),
      onEvents: (events) => seenEvents.push(...events),
      onEnd: () => {
        ended += 1;
      },
    });

    try {
      // The run directory appears first, with events still being appended.
      const dir = path.join(runsRoot, runId);
      fs.mkdirSync(dir, { recursive: true });
      await waitFor(() => seenDirs.length === 1, 3000);
      assert.equal(seenDirs[0], runId);

      fs.appendFileSync(
        path.join(dir, "events.ndjson"),
        `${JSON.stringify({ ts: new Date().toISOString(), type: "step.started", stepId: "s1" })}\n`,
      );
      await waitFor(() => seenEvents.length >= 1, 3000);
      assert.equal(seenEvents[0].stepId, "s1");

      fs.appendFileSync(
        path.join(dir, "events.ndjson"),
        `${JSON.stringify({ ts: new Date().toISOString(), type: "step.failed", stepId: "s1", durationMs: 9, error: "locator not found" })}\n`,
      );
      fs.writeFileSync(
        path.join(dir, "run.json"),
        JSON.stringify({ runId, status: "passed" }),
        "utf8",
      );
      await waitFor(() => ended === 1, 4000);
      assert.equal(tail.runDir(), dir);
      assert.ok(
        seenEvents.length >= 2,
        "trailing events must be drained before onEnd",
      );
    } finally {
      tail.stop();
    }
  });

  it("keeps draining for the linger window after run.json (stash lands late)", async () => {
    const runsRoot = tempDir("cairn-live-");
    const runId = runIdNow("linger_spec");
    /** @type {any[]} */
    const seen = [];
    let ended = false;
    const tail = live.createLiveTail({
      runsRoot,
      specNames: ["linger_spec"],
      knownIds: new Set(),
      pollMs: 50,
      lingerMs: 600,
      onEvents: (events) => seen.push(...events),
      onEnd: () => {
        ended = true;
      },
    });
    try {
      const dir = path.join(runsRoot, runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "events.ndjson"),
        `${JSON.stringify({ ts: new Date().toISOString(), type: "run.failed", durationMs: 10 })}\n`,
      );
      fs.writeFileSync(
        path.join(dir, "run.json"),
        JSON.stringify({ runId, status: "failed" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(ended, false, "must not end before the linger window");
      fs.appendFileSync(
        path.join(dir, "events.ndjson"),
        `${JSON.stringify({ ts: new Date().toISOString(), type: "artifact.stash", action: "auto-stash", stashId: "stash_1", status: "saved" })}\n`,
      );
      await waitFor(() => ended, 3000);
      assert.ok(seen.some((event) => event.type === "artifact.stash"));
      assert.equal(tail.ended(), true);
    } finally {
      tail.stop();
    }
  });

  it("ignores a run directory for a different spec", async () => {
    const runsRoot = tempDir("cairn-live-");
    /** @type {string[]} */
    const seenDirs = [];
    const tail = live.createLiveTail({
      runsRoot,
      specNames: ["wanted"],
      knownIds: new Set(),
      pollMs: 50,
      onRunDir: (_dir, id) => seenDirs.push(id),
    });
    try {
      fs.mkdirSync(path.join(runsRoot, runIdNow("other")), { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(seenDirs, []);
    } finally {
      tail.stop();
    }
  });

  it("stop() is idempotent and quiet", () => {
    const tail = live.createLiveTail({
      runsRoot: tempDir("cairn-live-"),
      pollMs: 50,
    });
    tail.stop();
    tail.stop();
    assert.equal(tail.runDir(), null);
  });
});

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}
