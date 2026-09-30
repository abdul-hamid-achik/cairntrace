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
require("../renderer/dom"); // renderer scripts publish onto window/globalThis
require("../renderer/state");
const Studio = /** @type {any} */ (globalThis).Studio;

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

  it("applies external events, rolling steps up", () => {
    const run = makeRunId();
    const other = makeRunId();
    Studio.syncDetected(snapshot([run]));
    const record = Studio.applyExternalEvents(run, [
      { type: "step.started", stepId: "s1" },
      { type: "step.finished", stepId: "s1", durationMs: 12, status: "passed" },
    ]);
    assert.equal(record.steps.length, 1);
    assert.equal(record.steps[0].status, "passed");
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
