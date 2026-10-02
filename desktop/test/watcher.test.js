/**
 * The external-run watcher: run-directory discovery outside the app, event
 * tailing, finish detection, and tracking cleanup.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const { createRunWatcher } = require("../lib/watcher");
const { cleanup, tempDir } = require("./helpers");

after(cleanup);

const LIVE_RUN = "2026-09-05T12-00-00-000Z_live_spec_dddddd";
const OTHER_RUN = "2026-09-06T08-30-00-000Z_other_spec_eeeeee";

/**
 * A run directory mid-flight: no run.json, events still landing.
 * @param {string} root
 * @param {string} runId
 * @returns {string} the run directory
 */
function makeRunningRun(root, runId) {
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${JSON.stringify({ ts: new Date().toISOString(), type: "run.started" })}\n`,
    "utf8",
  );
  return dir;
}

/** @param {string} dir */
function finishRun(dir) {
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({ status: "passed", summary: "all outcomes passed" }),
    "utf8",
  );
}

describe("createRunWatcher", () => {
  it("discovers a run in flight, streams its events, and finishes it", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);

    /** @type {Array<[string, Record<string, any>]>} */
    const events = [];
    /** @type {string[][]} */
    const snapshots = [];
    /** @type {Array<[string, Record<string, any>]>} */
    const finished = [];

    const watcher = createRunWatcher({
      runsRoot: root,
      onEvents: (runId, batch) =>
        events.push(
          ...batch.map((e) => /** @type {[string, any]} */ ([runId, e])),
        ),
      onSnapshot: (runs) => snapshots.push(runs.map((run) => run.runId)),
      onFinished: (runId, info) => finished.push([runId, info]),
    });

    watcher.tick();
    assert.deepEqual(snapshots.at(-1), [LIVE_RUN]);
    assert.equal(events.length, 1);
    assert.equal(events[0][0], LIVE_RUN);
    assert.equal(events[0][1].type, "run.started");

    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "step.started", stepId: "s1" })}\n`,
      "utf8",
    );
    watcher.tick();
    assert.equal(events.length, 2);
    assert.equal(events[1][1].stepId, "s1");
    // already-read events are not re-delivered
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "step.finished", stepId: "s1" })}\n`,
      "utf8",
    );
    watcher.tick();
    assert.equal(events.length, 3);
    assert.equal(events[2][1].type, "step.finished");

    finishRun(dir);
    watcher.tick();
    assert.equal(finished.length, 1);
    assert.equal(finished[0][0], LIVE_RUN);
    assert.equal(finished[0][1].status, "passed");
    assert.equal(finished[0][1].summary, "all outcomes passed");
    assert.equal(finished[0][1].runDir, dir);
    assert.equal(finished[0][1].refusal, null, "no refusal on a passed run");
    assert.deepEqual(snapshots.at(-1), [], "finished runs leave the snapshot");
    // tracking is cleaned up: a later tick does not re-finish or re-report
    watcher.tick();
    assert.equal(finished.length, 1);
    assert.deepEqual(snapshots.at(-1), []);
  });

  it("drains trailing events written before run.json", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    /** @type {string[]} */
    const seen = [];
    let finished = 0;
    const watcher = createRunWatcher({
      runsRoot: root,
      onEvents: (_runId, batch) => seen.push(...batch.map((e) => e.type)),
      onFinished: () => {
        finished += 1;
      },
    });
    watcher.tick();
    assert.deepEqual(seen, ["run.started"]);

    // The runner appends its last events, then writes run.json — the finish
    // tick must deliver both the trailing event and the finish.
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "step.started", stepId: "s9" })}\n`,
      "utf8",
    );
    finishRun(dir);
    watcher.tick();
    assert.deepEqual(seen, ["run.started", "step.started"]);
    assert.equal(finished, 1);
  });

  it("excludes run ids the app's own tails already track", () => {
    const root = tempDir("cairn-watch-");
    makeRunningRun(root, LIVE_RUN);
    /** @type {string[][]} */
    const snapshots = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      excludes: () => new Set([LIVE_RUN]),
      onSnapshot: (runs) => snapshots.push(runs.map((run) => run.runId)),
    });
    watcher.tick();
    assert.deepEqual(snapshots.at(-1), []);
  });

  it("does not drop a tracked run that merely became excluded", () => {
    const root = tempDir("cairn-watch-");
    makeRunningRun(root, LIVE_RUN);
    let excluded = false;
    let dropped = 0;
    let finished = 0;
    const watcher = createRunWatcher({
      runsRoot: root,
      excludes: () => (excluded ? new Set([LIVE_RUN]) : new Set()),
      onDropped: () => {
        dropped += 1;
      },
      onFinished: () => {
        finished += 1;
      },
    });
    watcher.tick();
    excluded = true;
    watcher.tick();
    assert.equal(dropped, 0, "an app-claimed run is not 'dropped'");
    // when the app's tail releases it, the watcher settles it normally
    excluded = false;
    watcher.tick(); // still run-less: stays tracked, no events
    assert.equal(dropped, 0);
    finishRun(path.join(root, LIVE_RUN));
    watcher.tick();
    assert.equal(finished, 1);
  });

  it("drops tracking when the directory vanishes without run.json", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    let dropped = 0;
    let finished = 0;
    const watcher = createRunWatcher({
      runsRoot: root,
      onDropped: () => {
        dropped += 1;
      },
      onFinished: () => {
        finished += 1;
      },
    });
    watcher.tick();
    fs.rmSync(dir, { recursive: true, force: true });
    watcher.tick();
    assert.equal(dropped, 1);
    assert.equal(finished, 0);
  });

  it("resumes from the previous offset when a dropped run comes back", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    /** @type {string[]} */
    const seen = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      onEvents: (_runId, batch) => seen.push(...batch.map((e) => e.type)),
    });
    watcher.tick();
    assert.deepEqual(seen, ["run.started"]);

    // The run goes away (deleted, quiet past the stale window, rotated out of
    // the capped list) and then re-appears with more events appended.
    fs.rmSync(dir, { recursive: true, force: true });
    watcher.tick();
    makeRunningRun(root, LIVE_RUN);
    fs.appendFileSync(
      path.join(root, LIVE_RUN, "events.ndjson"),
      `${JSON.stringify({ type: "step.started", stepId: "s2" })}\n`,
      "utf8",
    );
    watcher.tick();
    // Only the newly appended event — not the whole history from offset 0.
    assert.deepEqual(seen, ["run.started", "step.started"]);
  });

  it("retries a torn run.json instead of reporting an unknown status", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    let finished = 0;
    /** @type {string | null} */
    let finishStatus = null;
    /** @type {string[]} */
    const seen = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      onEvents: (_runId, batch) => seen.push(...batch.map((e) => e.type)),
      onFinished: (_runId, info) => {
        finished += 1;
        finishStatus = info.status;
      },
    });
    watcher.tick();

    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "step.finished", stepId: "s1" })}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "run.json"), "{not json yet", "utf8");
    watcher.tick();
    assert.equal(finished, 0, "torn run.json is not settled");
    assert.deepEqual(seen, ["run.started"], "no drain fires for a torn read");

    // The write completes; the next tick settles the run with the drain.
    finishRun(dir);
    watcher.tick();
    assert.equal(finished, 1);
    assert.equal(finishStatus, "passed");
    assert.deepEqual(seen, ["run.started", "step.finished"]);
  });

  it("resets tracking when the artifact root changes", () => {
    const rootA = tempDir("cairn-watch-a-");
    const rootB = tempDir("cairn-watch-b-");
    makeRunningRun(rootA, LIVE_RUN);
    let current = rootA;
    /** @type {string[][]} */
    const snapshots = [];
    /** @type {string[]} */
    const finished = [];
    const watcher = createRunWatcher({
      runsRoot: () => current,
      onSnapshot: (runs) => snapshots.push(runs.map((run) => run.runId)),
      onFinished: (runId) => {
        finished.push(runId);
      },
    });
    watcher.tick();
    assert.deepEqual(snapshots.at(-1), [LIVE_RUN]);

    current = rootB;
    makeRunningRun(rootB, OTHER_RUN);
    watcher.tick();
    assert.deepEqual(snapshots.at(-1), [OTHER_RUN]);
    finishRun(path.join(rootB, OTHER_RUN));
    watcher.tick();
    assert.deepEqual(finished, [OTHER_RUN]);
  });

  it("tolerates a missing artifact root", () => {
    const missing = path.join(tempDir("cairn-watch-"), "nope");
    const watcher = createRunWatcher({ runsRoot: missing });
    assert.doesNotThrow(() => watcher.tick());
    assert.equal(watcher.runsRoot(), missing);
  });

  it("start/stop drive the poll loop and stop is idempotent", async () => {
    const root = tempDir("cairn-watch-");
    makeRunningRun(root, LIVE_RUN);
    let ticks = 0;
    const watcher = createRunWatcher({
      runsRoot: root,
      pollMs: 20,
      onSnapshot: () => {
        ticks += 1;
      },
    });
    watcher.start();
    await waitFor(() => ticks >= 2, 3000);
    watcher.stop();
    watcher.stop();
    const atStop = ticks;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ticks, atStop, "no ticks after stop()");
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

describe("createRunWatcher — linger, liveness, invocations", () => {
  it("keeps tailing a finished run for the linger window (late stash event)", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    let clock = Date.now();
    /** @type {any[]} */
    const events = [];
    let finishedCount = 0;
    const watcher = createRunWatcher({
      runsRoot: root,
      lingerMs: 10_000,
      now: () => clock,
      onEvents: (_runId, batch) => events.push(...batch),
      onFinished: () => {
        finishedCount += 1;
      },
    });
    watcher.tick();
    finishRun(dir);
    watcher.tick();
    assert.equal(finishedCount, 1);
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "artifact.stash", action: "auto-stash", stashId: "stash_1", status: "saved" })}\n`,
    );
    clock += 4_000;
    watcher.tick();
    assert.ok(events.some((event) => event.type === "artifact.stash"));
    assert.equal(finishedCount, 1, "finish is reported once");
    // Past the window nothing more is read.
    clock += 20_000;
    watcher.tick();
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "artifact.retention", action: "warning", warning: "late" })}\n`,
    );
    watcher.tick();
    assert.ok(!events.some((event) => event.type === "artifact.retention"));
  });

  it("keeps draining past the linger window while the run's process lives (slow auto-stash)", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ ts: new Date().toISOString(), type: "run.heartbeat", phase: "steps", pid: 42424 })}\n`,
    );
    let clock = Date.now();
    let alive = true;
    /** @type {any[]} */
    const events = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      lingerMs: 10_000,
      lingerCapMs: 120_000,
      now: () => clock,
      pidAlive: (pid) => (pid === 42424 ? alive : null),
      onEvents: (_runId, batch) => events.push(...batch),
    });
    watcher.tick();
    finishRun(dir);
    watcher.tick();
    // 30s later the upload is still going: past lingerMs, but the pid lives.
    clock += 30_000;
    watcher.tick();
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "artifact.stash", action: "auto-stash", stashId: "stash_slow", status: "saved" })}\n`,
    );
    // The process exits right after appending: one final drain still reads it.
    alive = false;
    clock += 2_000;
    watcher.tick();
    assert.ok(
      events.some((event) => event.stashId === "stash_slow"),
      "late stash event read after the linger window",
    );
    // Then the tail is released.
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "artifact.retention", action: "warning", warning: "after exit" })}\n`,
    );
    clock += 2_000;
    watcher.tick();
    assert.ok(!events.some((event) => event.warning === "after exit"));
  });

  it("stops lingering at the cap even if the pid still answers (pid reuse)", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ ts: new Date().toISOString(), type: "run.heartbeat", phase: "steps", pid: 42425 })}\n`,
    );
    let clock = Date.now();
    /** @type {any[]} */
    const events = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      lingerMs: 10_000,
      lingerCapMs: 60_000,
      now: () => clock,
      pidAlive: () => true,
      onEvents: (_runId, batch) => events.push(...batch),
    });
    watcher.tick();
    finishRun(dir);
    watcher.tick();
    clock += 61_000;
    watcher.tick();
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ type: "artifact.retention", action: "warning", warning: "past cap" })}\n`,
    );
    clock += 2_000;
    watcher.tick();
    assert.ok(!events.some((event) => event.warning === "past cap"));
  });

  it("snapshots carry liveness (dead pid stops a run counting as running)", () => {
    const root = tempDir("cairn-watch-");
    const dir = makeRunningRun(root, LIVE_RUN);
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ ts: new Date(Date.now() - 120_000).toISOString(), type: "run.heartbeat", phase: "steps", pid: 31337 })}\n`,
    );
    // events.ndjson was just written, so mtime keeps it detected …
    /** @type {any[]} */
    let snapshot = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      pidAlive: () => false,
      onSnapshot: (runs) => {
        snapshot = runs;
      },
    });
    watcher.tick();
    // … but the stale heartbeat + dead pid say it is not running.
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].liveness.state, "dead");
  });

  it("tails running invocation journals and reports them", () => {
    const root = tempDir("cairn-watch-");
    const id = "2026-10-01T08-59-50-000Z_4242_abc123";
    const journalDir = path.join(root, "_invocations", id);
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(
      path.join(journalDir, "invocation.json"),
      JSON.stringify({
        version: 1,
        invocationId: id,
        pid: 4242,
        status: "running",
        planned: [{ index: 1, spec: "a.yml" }],
        runs: [],
      }),
    );
    fs.writeFileSync(
      path.join(journalDir, "events.ndjson"),
      fs
        .readFileSync(
          path.join(__dirname, "fixtures", "invocation-events.ndjson"),
          "utf8",
        )
        .split("\n")
        .slice(0, 4)
        .join("\n") + "\n",
    );
    /** @type {any[]} */
    let listed = [];
    /** @type {any[]} */
    const streamed = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      pidAlive: () => true,
      onInvocations: (list) => {
        listed = list;
      },
      onInvocationEvents: (invocationId, batch) =>
        streamed.push(...batch.map((event) => [invocationId, event.type])),
    });
    watcher.tick();
    assert.deepEqual(
      listed.map((entry) => entry.invocationId),
      [id],
    );
    assert.deepEqual(
      streamed.map((entry) => entry[1]),
      [
        "invocation.started",
        "phase.changed",
        "log.opened",
        "services.docker.start",
      ],
    );
    watcher.tick();
    assert.equal(streamed.length, 4, "no re-delivery");
  });
});

describe("createRunWatcher — refused runs", () => {
  it("reports why the environment policy refused an external run", () => {
    const root = tempDir("cairn-watch-refused-");
    const dir = makeRunningRun(root, LIVE_RUN);
    /** @type {Array<Record<string, any>>} */
    const finished = [];
    const watcher = createRunWatcher({
      runsRoot: root,
      lingerMs: 0,
      onFinished: (_runId, info) => finished.push(info),
    });
    watcher.tick();
    fs.writeFileSync(
      path.join(dir, "run.json"),
      JSON.stringify({
        status: "refused",
        summary: "refused by environment policy",
        refusal: { reason: "mutations denied", env: "staging" },
      }),
      "utf8",
    );
    watcher.tick();
    watcher.stop();
    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, "refused");
    assert.deepEqual(finished[0].refusal, {
      reason: "mutations denied",
      env: "staging",
      requires: null,
      requiresText: null,
    });
  });
});
