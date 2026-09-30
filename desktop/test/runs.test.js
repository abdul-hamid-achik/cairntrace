/**
 * Artifact-root read side: indexing, detail assembly, bounded artifact reads,
 * event tailing, and the path-traversal guard that keeps a renderer-supplied
 * relative path inside the run directory.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const runs = require("../lib/runs");
const { cleanup, makeRun, tempDir, write } = require("./helpers");

after(cleanup);

const RUN_A = "2026-09-01T10-00-00-000Z_demo_spec_aaaaaa";
const RUN_B = "2026-09-02T11-30-00-000Z_demo_spec_bbbbbb";
const RUN_C = "2026-09-03T09-15-00-000Z_other_spec_cccccc";

describe("safeJoin", () => {
  it("accepts a nested relative path", () => {
    const joined = runs.safeJoin("/tmp/run", "outcomes/a.md");
    assert.equal(joined, path.resolve("/tmp/run/outcomes/a.md"));
  });

  it("rejects traversal, absolute paths, and empty input", () => {
    assert.equal(runs.safeJoin("/tmp/run", "../../etc/passwd"), null);
    assert.equal(runs.safeJoin("/tmp/run", "/etc/passwd"), null);
    assert.equal(runs.safeJoin("/tmp/run", ""), null);
    assert.equal(runs.safeJoin("", "a.md"), null);
  });

  it("rejects a sibling directory that merely shares a prefix", () => {
    assert.equal(runs.safeJoin("/tmp/run", "../run-secrets/token"), null);
  });
});

describe("listRunIds", () => {
  it("returns run directories newest first and ignores files", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    makeRun(root, RUN_B);
    write(root, RUN_C, "not a directory");
    write(root, "stray.log", "noise");
    assert.deepEqual(runs.listRunIds(root), [RUN_B, RUN_A]);
  });

  it("returns [] for a missing root", () => {
    assert.deepEqual(runs.listRunIds(path.join(tempDir(), "nope")), []);
  });
});

describe("summarizeRun", () => {
  it("reads the run record into a list row", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    const summary = runs.summarizeRun(root, RUN_A);
    assert.equal(summary.runId, RUN_A);
    assert.equal(summary.spec, "demo_spec");
    assert.equal(summary.status, "passed");
    assert.equal(summary.durationMs, 4250);
    assert.equal(summary.interrupted, false);
    assert.deepEqual(summary.outcomes, { total: 1, passed: 1, failed: 0 });
  });

  it("flags a quiet run-less directory as interrupted", () => {
    const root = tempDir("cairn-runs-");
    fs.mkdirSync(path.join(root, RUN_B), { recursive: true });
    // A run-less directory only means "in progress" while it is still being
    // written; age it past the running window to model a killed run.
    const stale = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.join(root, RUN_B), stale, stale);
    const summary = runs.summarizeRun(root, RUN_B);
    assert.equal(summary.status, "interrupted");
    assert.equal(summary.interrupted, true);
    assert.equal(summary.running, false);
    assert.equal(summary.spec, "demo_spec"); // recovered from the run id
  });

  it("renders a freshly written run-less directory as running", () => {
    const root = tempDir("cairn-runs-");
    const dir = path.join(root, RUN_B);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ ts: new Date().toISOString(), type: "run.started" })}\n`,
      "utf8",
    );
    const summary = runs.summarizeRun(root, RUN_B);
    assert.equal(summary.status, "running");
    assert.equal(summary.running, true);
    assert.equal(summary.interrupted, true); // still no final record
    assert.ok(summary.lastActivityMs !== null);
  });

  it("tolerates a corrupt run.json", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    fs.writeFileSync(path.join(root, RUN_A, "run.json"), "{not json", "utf8");
    // A corrupt record counts as "no record": the directory still parses out
    // of the run id, and once it goes quiet it renders as interrupted.
    const stale = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.join(root, RUN_A, "events.ndjson"), stale, stale);
    const summary = runs.summarizeRun(root, RUN_A);
    assert.equal(summary.interrupted, true);
    assert.equal(summary.status, "interrupted");
  });
});

describe("listRuns", () => {
  const build = () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    makeRun(root, RUN_B, {
      run: { status: "failed", summary: "outcome 'x' failed" },
    });
    makeRun(root, RUN_C, {
      specName: "other_spec",
      run: { status: "errored" },
    });
    return root;
  };

  it("lists every run newest first", () => {
    const root = build();
    const list = runs.listRuns(root);
    assert.deepEqual(
      list.map((run) => run.runId),
      [RUN_C, RUN_B, RUN_A],
    );
  });

  it("filters by status, spec, and free text", () => {
    const root = build();
    assert.deepEqual(
      runs.listRuns(root, { status: "failed" }).map((r) => r.runId),
      [RUN_B],
    );
    assert.deepEqual(
      runs.listRuns(root, { spec: "other_spec" }).map((r) => r.runId),
      [RUN_C],
    );
    assert.deepEqual(
      runs.listRuns(root, { search: "outcome 'x'" }).map((r) => r.runId),
      [RUN_B],
    );
    assert.deepEqual(runs.listRuns(root, { search: "nothing matches" }), []);
  });

  it("honours the limit", () => {
    const root = build();
    assert.equal(runs.listRuns(root, { limit: 2 }).length, 2);
  });
});

describe("listRunSpecs", () => {
  it("collects distinct spec names from run ids", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    makeRun(root, RUN_B);
    makeRun(root, RUN_C);
    assert.deepEqual(runs.listRunSpecs(root), ["demo_spec", "other_spec"]);
  });
});

describe("listDetectedRuns", () => {
  const LIVE_RUN = "2026-09-05T12-00-00-000Z_live_spec_dddddd";

  /** A run directory mid-flight: no run.json, events still landing. */
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

  it("finds run-less directories written recently, newest first", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A); // finished — never detected
    makeRunningRun(root, LIVE_RUN);
    const detected = runs.listDetectedRuns(root);
    assert.deepEqual(
      detected.map((run) => run.runId),
      [LIVE_RUN],
    );
    assert.equal(detected[0].spec, "live_spec");
    assert.equal(
      detected[0].startedAtMs,
      Date.parse("2026-09-05T12:00:00.000Z"),
    );
    assert.ok(detected[0].lastActivityMs !== null);
    assert.equal(detected[0].ageMs < 60_000, true);
  });

  it("ignores directories quiet past the stale window", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRunningRun(root, LIVE_RUN);
    const old = new Date(Date.now() - 2 * runs.DEFAULT_STALE_MS);
    fs.utimesSync(path.join(dir, "events.ndjson"), old, old);
    fs.utimesSync(dir, old, old);
    assert.deepEqual(runs.listDetectedRuns(root), []);
  });

  it("honours the limit and accepts explicit now", () => {
    const root = tempDir("cairn-runs-");
    makeRunningRun(root, LIVE_RUN);
    makeRunningRun(root, RUN_C);
    assert.equal(runs.listDetectedRuns(root, { limit: 1 }).length, 1);
    assert.equal(runs.listDetectedRuns(root).length, 2);
  });
});

describe("resolveRunRef", () => {
  it("resolves latest, previous, exact ids, partial ids, and absolute dirs", () => {
    const root = tempDir("cairn-runs-");
    const dirA = makeRun(root, RUN_A);
    makeRun(root, RUN_B);
    assert.equal(runs.resolveRunRef(root, "latest"), path.join(root, RUN_B));
    assert.equal(runs.resolveRunRef(root, "previous"), dirA);
    assert.equal(runs.resolveRunRef(root, RUN_A), dirA);
    assert.equal(runs.resolveRunRef(root, "aaaaaa"), dirA);
    assert.equal(runs.resolveRunRef(root, dirA), dirA);
    assert.equal(runs.resolveRunRef(root, "nope"), null);
    assert.equal(runs.resolveRunRef(root, ""), null);
  });
});

describe("groupArtifacts", () => {
  it("buckets manifest entries by kind, sorted by path", () => {
    const groups = runs.groupArtifacts({
      version: "1",
      artifacts: [
        { path: "b.txt", kind: "snapshot", bytes: 1 },
        { path: "a.txt", kind: "snapshot", bytes: 1 },
        { path: "run.json", kind: "run-metadata", bytes: 1 },
      ],
    });
    assert.deepEqual(Object.keys(groups).toSorted(), [
      "run-metadata",
      "snapshot",
    ]);
    assert.deepEqual(
      groups.snapshot.map((entry) => entry.path),
      ["a.txt", "b.txt"],
    );
  });

  it("tolerates a missing or malformed manifest", () => {
    assert.deepEqual(runs.groupArtifacts(null), {});
    assert.deepEqual(runs.groupArtifacts({ artifacts: "nope" }), {});
  });
});

describe("readRunDetail", () => {
  it("assembles run record, outcome evidence, and artifact groups", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const detail = runs.readRunDetail(dir);
    assert.equal(detail.runId, RUN_A);
    assert.equal(detail.run.status, "passed");
    assert.equal(detail.steps.length, 1);
    assert.equal(detail.outcomes.length, 1);
    assert.equal(detail.outcomes[0].id, "landing_loaded");
    assert.match(detail.outcomes[0].evidenceText, /status:\*\* passed/);
    assert.ok(detail.artifacts.snapshot.length >= 1);
    assert.equal(detail.hasEvents, true);
    assert.equal(detail.hasReportHtml, false);
  });

  it("survives a run directory with nothing but a name", () => {
    const dir = fs.mkdtempSync(path.join(tempDir(), "empty-run-"));
    const detail = runs.readRunDetail(dir);
    assert.equal(detail.run, null);
    assert.deepEqual(detail.outcomes, []);
    assert.deepEqual(detail.steps, []);
    assert.equal(detail.runId, path.basename(dir));
  });
});

describe("readBoundedText", () => {
  it("reads text and reports truncation past the bound", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    write(dir, "big.log", "x".repeat(5000));
    const bounded = runs.readBoundedText(dir, "big.log", 100);
    assert.equal(bounded.ok, true);
    assert.equal(bounded.text.length, 100);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.bytes, 5000);
    const whole = runs.readBoundedText(dir, "big.log");
    assert.equal(whole.truncated, false);
  });

  it("refuses traversal and reports missing files", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const traversal = runs.readBoundedText(dir, "../../../etc/hosts");
    assert.equal(traversal.ok, false);
    assert.match(traversal.error, /escapes/);
    const missing = runs.readBoundedText(dir, "nope.txt");
    assert.equal(missing.ok, false);
  });
});

describe("readAsDataUrl", () => {
  it("encodes an image with the right mime type", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(dir, "screenshots", "001.png"), png);
    const result = runs.readAsDataUrl(dir, "screenshots/001.png");
    assert.equal(result.ok, true);
    assert.equal(result.mime, "image/png");
    assert.ok(result.dataUrl.startsWith("data:image/png;base64,"));
    assert.equal(result.bytes, png.length);
  });

  it("refuses traversal and oversize artifacts", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    write(dir, "shots/big.png", "x".repeat(2048));
    assert.equal(runs.readAsDataUrl(dir, "../../etc/hosts").ok, false);
    const tooBig = runs.readAsDataUrl(dir, "shots/big.png", 1024);
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.error, /exceeds/);
  });
});

describe("classifyArtifact", () => {
  it("maps extensions onto viewers", () => {
    assert.equal(runs.classifyArtifact("screenshots/001.png"), "image");
    assert.equal(runs.classifyArtifact("run.json"), "json");
    assert.equal(runs.classifyArtifact("events.ndjson"), "ndjson");
    assert.equal(runs.classifyArtifact("report.html"), "html");
    assert.equal(runs.classifyArtifact("videos/run.webm"), "video");
    assert.equal(runs.classifyArtifact("outcomes/a.md"), "text");
    assert.equal(runs.classifyArtifact("traces/run.zip"), "binary");
  });
});

describe("readEventsFrom", () => {
  it("reads events and advances the offset", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const first = runs.readEventsFrom(dir, 0);
    assert.equal(first.events.length, 3);
    assert.equal(first.events[0].type, "run.started");
    assert.ok(first.offset > 0);
    assert.deepEqual(runs.readEventsFrom(dir, first.offset).events, []);
  });

  it("does not advance past a partially written line", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const before = fs.statSync(path.join(dir, "events.ndjson")).size;
    fs.appendFileSync(path.join(dir, "events.ndjson"), '{"type":"step.star');
    const partial = runs.readEventsFrom(dir, before);
    assert.deepEqual(partial.events, []);
    assert.equal(
      partial.offset,
      before,
      "offset must stay before the partial line",
    );
    fs.appendFileSync(
      path.join(dir, "events.ndjson"),
      'ted","stepId":"step_9"}\n',
    );
    const complete = runs.readEventsFrom(dir, before);
    assert.equal(complete.events.length, 1);
    assert.equal(complete.events[0].stepId, "step_9");
  });

  it("reports a missing events file", () => {
    const dir = fs.mkdtempSync(path.join(tempDir(), "no-events-"));
    const result = runs.readEventsFrom(dir, 0);
    assert.equal(result.missing, true);
    assert.deepEqual(result.events, []);
  });
});

describe("listRunFiles", () => {
  it("walks the run directory and classifies each file", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const files = runs.listRunFiles(dir);
    const paths = files.map((file) => file.path);
    assert.ok(paths.includes("run.json"));
    assert.ok(paths.includes("outcomes/landing_loaded.md"));
    assert.ok(paths.includes("snapshots/001_step_1.txt"));
    const json = files.find((file) => file.path === "run.json");
    assert.equal(json.kind, "json");
    assert.ok(json.bytes > 0);
  });

  it("respects the entry bound", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    assert.ok(runs.listRunFiles(dir, 2).length <= 2);
  });
});
