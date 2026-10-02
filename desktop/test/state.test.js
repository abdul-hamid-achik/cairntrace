/**
 * The renderer's detected-runs state machine: watcher snapshot sync, event
 * application, finish marking, and the session suppression set that keeps
 * app-owned runs and user-hidden cards from surfacing.
 *
 * state.js is renderer code but loads clean under node:test (browser APIs are
 * only touched inside functions the tests never call). The suppression set is
 * module-private and never cleared, so every test uses its own run ids.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

require("../lib/format"); // dom.js reads Studio.fmt off the global
require("../lib/events"); // state.js folds events with window.CairnEvents
require("../renderer/dom"); // renderer scripts publish onto window/globalThis
require("../renderer/state");
require("../renderer/components");
require("../renderer/panes"); // live.js reads Studio.panes at load
require("../renderer/views/live"); // pure layout helpers on Studio.live
const Studio = /** @type {any} */ (globalThis).Studio;
const fs = require("node:fs");
const path = require("node:path");

/** @param {string} name */
const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** Unique run id per test — the suppression set never resets. */
let counter = 0;
function makeRunId() {
  counter += 1;
  return `2026-09-05T12-00-00-000Z_live_spec_${counter.toString(16).padStart(6, "0")}`;
}

/** @param {string[]} runIds */
const snapshot = (runIds) =>
  runIds.map((runId) => ({
    runId,
    runDir: `/tmp/runs/${runId}`,
    spec: "live_spec",
    startedAtMs: Date.parse("2026-09-05T12:00:00.000Z"),
    lastActivityMs: Date.now(),
  }));

describe("detected-run state", () => {
  it("syncs a snapshot into records and reports visible changes", () => {
    const run = makeRunId();
    assert.equal(Studio.syncDetected(snapshot([run])), true);
    assert.equal(Studio.state.detected.get(run).spec, "live_spec");
    assert.equal(Studio.syncDetected(snapshot([run])), false);
    // A field-only refresh (last activity) is not a visible change.
    const touched = snapshot([run]).map((entry) => ({
      ...entry,
      lastActivityMs: Date.now() + 5,
    }));
    assert.equal(Studio.syncDetected(touched), false);
  });

  it("marks records missing from the snapshot as stale instead of dropping them", () => {
    const run = makeRunId();
    const other = makeRunId();
    Studio.syncDetected(snapshot([run]));
    Studio.syncDetected(snapshot([other]));
    assert.equal(Studio.state.detected.get(run).stale, true);
    // Re-appearance clears the stale flag.
    Studio.syncDetected(snapshot([run]));
    assert.equal(Studio.state.detected.get(run).stale, false);
  });

  it("applies external events with the runner's real vocabulary", () => {
    const run = makeRunId();
    const other = makeRunId();
    Studio.syncDetected(snapshot([run]));
    const record = Studio.applyExternalEvents(
      run,
      fixture("events-failed-step.ndjson"),
    );
    assert.deepEqual(
      record.steps.map((row) => [row.stepId, row.status]),
      [
        ["open_cart", "passed"],
        ["click_pay", "failed"],
      ],
    );
    assert.match(record.steps[1].error, /Pay now/);
    assert.equal(record.model.status, "failed");
    assert.equal(record.model.stash.stashId, "stash_7f3a9c");
    assert.ok(record.dirty.has("steps") && record.dirty.has("badges"));
    assert.equal(record.eventTotal, 12);
    // A stub is created when events race ahead of the first snapshot.
    const stub = Studio.applyExternalEvents(other, [
      { type: "run.started", spec: "other" },
    ]);
    assert.equal(stub.runId, other);
  });

  it("marks a run finished exactly once, with the payload's status", () => {
    const run = makeRunId();
    Studio.syncDetected(snapshot([run]));
    const record = Studio.markExternalFinished({
      runId: run,
      runDir: "/tmp/runs/x",
      status: "passed",
      summary: "all good",
    });
    assert.equal(record.done.ok, true);
    assert.equal(Studio.markExternalFinished({ runId: run }), null);
  });

  it("suppresses run ids claimed by an app-owned tail (no ghost cards)", () => {
    // The watcher saw the run before the app's tail claimed it.
    const run = makeRunId();
    const other = makeRunId();
    Studio.syncDetected(snapshot([run]));
    Studio.suppressDetectedRun(run);
    assert.equal(Studio.state.detected.has(run), false);
    // Every later path must keep it hidden for the session.
    assert.equal(Studio.syncDetected(snapshot([run, other])), true);
    assert.equal(Studio.state.detected.has(run), false);
    assert.equal(Studio.state.detected.has(other), true);
    assert.equal(
      Studio.applyExternalEvents(run, [{ type: "step.started", stepId: "s1" }]),
      null,
    );
    assert.equal(
      Studio.markExternalFinished({ runId: run, status: "passed" }),
      null,
    );
  });

  it("keeps a hidden run hidden across snapshots", () => {
    const run = makeRunId();
    Studio.syncDetected(snapshot([run]));
    Studio.hideDetected(run);
    assert.equal(Studio.state.detected.has(run), false);
    Studio.syncDetected(snapshot([run]));
    assert.equal(Studio.state.detected.has(run), false);
  });
});

describe("live records + invocations", () => {
  it("folds app-run events and logs into the model with dirty sections", () => {
    const record = Studio.initLiveRecord({ token: "t1" });
    record.dirty.clear();
    Studio.applyEventsToRecord(
      record,
      fixture("events-contract-v1.ndjson").slice(0, 6),
    );
    assert.equal(record.model.invocation.index, 3);
    assert.ok(record.dirty.has("preconditions"));
    assert.ok(record.dirty.has("logs"));
    Studio.appendLog(record, { level: "info", msg: "hello" });
    assert.equal(record.logTotal, 1);
    assert.ok(record.dirty.has("logs"));
  });

  it("syncs invocation journals and keeps referenced ones", () => {
    const id = "2026-10-01T08-59-50-000Z_4242_abc123";
    assert.equal(
      Studio.syncInvocations([
        { invocationId: id, status: "running", alive: true, pid: 4242 },
      ]),
      true,
    );
    Studio.applyInvocationEvents(id, fixture("invocation-events.ndjson"));
    const record = Studio.state.invocations.get(id);
    assert.equal(record.model.planned, 7);
    assert.equal(record.model.hooks.length, 1);
    // Leaving the snapshot drops an unreferenced journal.
    Studio.syncInvocations([]);
    assert.equal(Studio.state.invocations.has(id), false);
  });
});

describe("computeLiveLayout", () => {
  const id = "2026-10-01T08-59-50-000Z_4242_abc123";

  it("groups by invocation id, joins app runs by pid, and keeps the rest in sections", () => {
    const layout = Studio.live.computeLiveLayout({
      live: [
        { token: "app-1", pid: 4242, invocation: null },
        { token: "app-2", pid: 9, invocation: null },
      ],
      detected: [
        { runId: "run-b", invocation: { id, index: 2 } },
        { runId: "run-a", invocation: { id, index: 1 } },
        { runId: "run-x", invocation: null },
      ],
      invocations: [{ invocationId: id, journal: { pid: 4242, alive: true } }],
    });
    assert.deepEqual(layout, [
      { type: "invocation", id, app: ["app-1"], detected: ["run-a", "run-b"] },
      { type: "app", keys: ["app-2"] },
      { type: "detected", keys: ["run-x"] },
    ]);
  });

  it("shows a running journal before any run exists, and nothing else when idle", () => {
    assert.deepEqual(
      Studio.live.computeLiveLayout({
        live: [],
        detected: [],
        invocations: [{ invocationId: id, journal: { alive: true } }],
      }),
      [{ type: "invocation", id, app: [], detected: [] }],
    );
    assert.deepEqual(
      Studio.live.computeLiveLayout({
        live: [],
        detected: [],
        invocations: [{ invocationId: id, journal: { alive: false } }],
      }),
      [],
    );
  });

  it("runRefOf prefers the run folder (restored stashes live outside the root)", () => {
    assert.equal(
      Studio.runRefOf({
        runId: "2026-09-01T11-00-00-000Z_checkout_d4e5f6",
        runDir:
          "/tmp/cairn-studio-restore-x/2026-09-01T11-00-00-000Z_checkout_d4e5f6",
      }),
      "/tmp/cairn-studio-restore-x/2026-09-01T11-00-00-000Z_checkout_d4e5f6",
    );
    assert.equal(Studio.runRefOf({ runId: "abc" }), "abc");
    assert.equal(Studio.runRefOf(null), null);
  });

  it("follow-pane helpers", () => {
    assert.equal(
      Studio.live.isNearBottom({
        scrollTop: 76,
        scrollHeight: 200,
        clientHeight: 100,
      }),
      true,
    );
    assert.equal(
      Studio.live.isNearBottom({
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 100,
      }),
      false,
    );
    assert.deepEqual(Studio.live.splitChunk("par", "tial\nnext\nhalf"), {
      lines: ["partial", "next"],
      carry: "half",
    });
  });
});
