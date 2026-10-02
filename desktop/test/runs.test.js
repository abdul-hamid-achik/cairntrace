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
const {
  cleanup,
  makeRun,
  tempDir,
  useEventsFixture,
  write,
} = require("./helpers");

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

describe("RUN_DIR_PATTERN", () => {
  it("is the CLI's retention pattern, verbatim", () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "..",
        "src",
        "core",
        "artifacts",
        "retention.ts",
      ),
      "utf8",
    );
    const match = /const RUN_DIR_PATTERN = (\/.+\/[a-z]*);/.exec(source);
    assert.ok(match, "RUN_DIR_PATTERN not found in retention.ts");
    assert.equal(runs.RUN_DIR_PATTERN.toString(), match[1]);
  });

  it("only lists run-shaped directories (no _invocations, metrics, diagnostics)", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    fs.mkdirSync(
      path.join(root, "_invocations", "2026-10-01T08-59-50-000Z_4242_abc123"),
      { recursive: true },
    );
    fs.mkdirSync(path.join(root, "engine-metrics"), { recursive: true });
    fs.mkdirSync(path.join(root, "_diagnostics"), { recursive: true });
    assert.deepEqual(runs.listRunIds(root), [RUN_A]);
    assert.deepEqual(runs.listDetectedRuns(root), []);
    assert.equal(runs.resolveRunRef(root, "metrics"), null);
  });
});

describe("labels", () => {
  const build = () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A, { run: { labels: { cohort: "legacy", round: "1" } } });
    makeRun(root, RUN_B, { run: { labels: { cohort: "next", round: "2" } } });
    makeRun(root, RUN_C, { specName: "other_spec" });
    return root;
  };

  it("filters by key=value and by key presence", () => {
    const root = build();
    assert.deepEqual(
      runs.listRuns(root, { labels: ["cohort=next"] }).map((run) => run.runId),
      [RUN_B],
    );
    assert.deepEqual(
      runs.listRuns(root, { labels: ["round"] }).map((run) => run.runId),
      [RUN_B, RUN_A],
    );
    assert.deepEqual(
      runs
        .listRuns(root, { labels: { cohort: "legacy", round: "1" } })
        .map((run) => run.runId),
      [RUN_A],
    );
  });

  it("includes labels in free-text search", () => {
    const root = build();
    assert.deepEqual(
      runs.listRuns(root, { search: "cohort=legacy" }).map((run) => run.runId),
      [RUN_A],
    );
  });

  it("discovers label keys and values from run.json", () => {
    const root = build();
    assert.deepEqual(runs.listRunLabels(root), [
      { key: "cohort", count: 2, values: ["legacy", "next"] },
      { key: "round", count: 2, values: ["1", "2"] },
    ]);
  });
});

describe("liveness of run-less directories", () => {
  /**
   * @param {string} root
   * @param {string} runId
   * @param {Array<Record<string, any>>} events
   */
  function runningRun(root, runId, events) {
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    return dir;
  }

  it("a fresh heartbeat is running even when the directory is old", () => {
    const root = tempDir("cairn-runs-");
    const now = Date.now();
    const dir = runningRun(root, RUN_B, [
      {
        ts: new Date(now - 60 * 60_000).toISOString(),
        type: "run.started",
        spec: "demo_spec",
      },
      {
        ts: new Date(now - 5_000).toISOString(),
        type: "run.heartbeat",
        phase: "preconditions",
        elapsedMs: 3_600_000,
        pid: 999_999,
      },
    ]);
    const old = new Date(now - 60 * 60_000);
    fs.utimesSync(dir, old, old);
    const summary = runs.summarizeRun(root, RUN_B, {
      now,
      pidAlive: () => false,
    });
    assert.equal(summary.status, "running");
    assert.equal(summary.liveness.state, "running");
    assert.equal(summary.liveness.reason, "heartbeat");
  });

  it("a stale heartbeat whose pid is gone is dead, not running", () => {
    const root = tempDir("cairn-runs-");
    const now = Date.now();
    runningRun(root, RUN_B, [
      {
        ts: new Date(now - 120_000).toISOString(),
        type: "run.heartbeat",
        phase: "steps",
        pid: 4242,
      },
    ]);
    const summary = runs.summarizeRun(root, RUN_B, {
      now,
      pidAlive: (pid) => pid !== 4242,
    });
    assert.equal(summary.status, "interrupted");
    assert.equal(summary.liveness.state, "dead");
    assert.equal(summary.liveness.pid, 4242);
  });

  it("falls back to the invocation journal pid, and keeps a quiet live run detected", () => {
    const root = tempDir("cairn-runs-");
    const invocationId = "2026-10-01T08-59-50-000Z_4242_abc123";
    write(
      root,
      `_invocations/${invocationId}/invocation.json`,
      JSON.stringify({
        version: 1,
        invocationId,
        pid: 4242,
        status: "running",
      }),
    );
    const dir = runningRun(root, RUN_B, [
      {
        ts: "2026-10-01T09:00:00.000Z",
        type: "run.started",
        spec: "demo_spec",
        invocation: {
          id: invocationId,
          index: 2,
          total: 5,
          dir: `_invocations/${invocationId}`,
        },
      },
    ]);
    const old = new Date(Date.now() - 2 * runs.DEFAULT_STALE_MS);
    fs.utimesSync(path.join(dir, "events.ndjson"), old, old);
    fs.utimesSync(dir, old, old);
    const detected = runs.listDetectedRuns(root, { pidAlive: () => true });
    assert.equal(detected.length, 1);
    assert.equal(detected[0].liveness.state, "running");
    assert.equal(detected[0].liveness.pid, 4242);
    assert.deepEqual(detected[0].invocation, {
      id: invocationId,
      index: 2,
      total: 5,
      dir: `_invocations/${invocationId}`,
    });
    assert.deepEqual(
      runs.listDetectedRuns(root, { pidAlive: () => false }),
      [],
    );
  });
});

describe("history", () => {
  it("computes p50 per spec key and the per-spec strip", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A, { run: { durationMs: 1000 } });
    makeRun(root, RUN_B, { run: { durationMs: 3000, status: "failed" } });
    makeRun(root, "2026-09-02T12-00-00-000Z_demo_spec_eeeeee", {
      run: { durationMs: 2000 },
    });
    const history = runs.specDurationHistory(root);
    assert.deepEqual(history.demo_spec, { p50: 2000, n: 3 });
    const strip = runs.runHistory(root, "demo_spec", { limit: 2 });
    assert.deepEqual(
      strip.map((entry) => [entry.status, entry.durationMs]),
      [
        ["passed", 2000],
        ["failed", 3000],
      ],
    );
    assert.deepEqual(runs.runHistory(root, ""), []);
  });
});

describe("resolveRunRef allowed roots", () => {
  it("refuses absolute directories outside the allowed roots", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    const elsewhere = tempDir("cairn-elsewhere-");
    assert.equal(runs.resolveRunRef(root, dir, { allowedRoots: [root] }), dir);
    assert.equal(
      runs.resolveRunRef(root, elsewhere, { allowedRoots: [root] }),
      null,
    );
    assert.equal(
      runs.resolveRunRef(root, "/etc", { allowedRoots: [root] }),
      null,
    );
  });

  it("refuses an absolute directory under an allowed root that is not a run folder", () => {
    const root = tempDir("cairn-runs-");
    makeRun(root, RUN_A);
    const notARun = path.join(root, "notes");
    fs.mkdirSync(notARun);
    write(root, "notes/secret.txt", "x");
    assert.equal(
      runs.resolveRunRef(root, notARun, { allowedRoots: [root] }),
      null,
    );
    // The root itself is not a run either.
    assert.equal(
      runs.resolveRunRef(root, root, { allowedRoots: [root] }),
      null,
    );
    // A stash restored flat (run.json directly inside) still counts.
    const flat = tempDir("cairn-studio-restore-");
    write(flat, "run.json", "{}");
    assert.equal(
      runs.resolveRunRef(root, flat, { allowedRoots: [root, flat] }),
      flat,
    );
  });
});

describe("readTextFrom", () => {
  it("starts at the tail, then returns only what was appended", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    write(
      dir,
      "logs/precondition-01-seed.log",
      "a".repeat(100) + "\nlast line\n",
    );
    const first = runs.readTextFrom(
      dir,
      "logs/precondition-01-seed.log",
      0,
      20,
    );
    assert.equal(first.ok, true);
    assert.equal(first.text.endsWith("last line\n"), true);
    assert.ok(first.text.length <= 20);
    assert.equal(first.skipped, true);
    fs.appendFileSync(
      path.join(dir, "logs/precondition-01-seed.log"),
      "more\n",
    );
    const next = runs.readTextFrom(
      dir,
      "logs/precondition-01-seed.log",
      first.offset,
    );
    assert.equal(next.text, "more\n");
    assert.equal(next.skipped, false);
  });

  it("restarts at the tail when the file shrank, and reports a missing file", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    write(dir, "logs/x.log", "short\n");
    const result = runs.readTextFrom(dir, "logs/x.log", 999);
    assert.equal(result.reset, true);
    assert.equal(result.text, "short\n");
    assert.equal(runs.readTextFrom(dir, "logs/none.log").missing, true);
    assert.equal(runs.readTextFrom(dir, "../../etc/hosts").ok, false);
  });
});

describe("binary safety", () => {
  it("never reads media or binary content as text", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    write(dir, "videos/run.webm", "\u001aE\u00df\u00a3 webm");
    fs.mkdirSync(path.join(dir, "traces"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "traces", "trace.zip"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]),
    );
    fs.writeFileSync(
      path.join(dir, "blob.txt"),
      Buffer.from([0x61, 0x00, 0x62]),
    );
    for (const rel of ["videos/run.webm", "traces/trace.zip", "blob.txt"]) {
      const result = runs.readBoundedText(dir, rel);
      assert.equal(result.ok, false, rel);
      assert.equal(result.binary, true, rel);
    }
  });

  it("sniffs trace kinds from their first bytes", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    fs.mkdirSync(path.join(dir, "traces"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "traces", "pw.zip"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]),
    );
    write(dir, "traces/ab.zip", '{"traceEvents":[]}');
    write(dir, "traces/empty.zip", "");
    assert.equal(
      runs.sniffArtifact(dir, "traces/pw.zip").kind,
      "playwright-zip",
    );
    assert.equal(
      runs.sniffArtifact(dir, "traces/ab.zip").kind,
      "chrome-trace-json",
    );
    assert.equal(runs.sniffArtifact(dir, "traces/empty.zip").kind, "empty");
    assert.equal(runs.sniffArtifact(dir, "traces/none.zip").kind, "missing");
  });
});

describe("parseOutcomeEvidence", () => {
  it("extracts the Expected and Actual sections", () => {
    const parsed = runs.parseOutcomeEvidence(
      [
        "# Outcome: rows",
        "**Status:** failed",
        "",
        "## Expected",
        "3 rows",
        "",
        "## Actual",
        "- 0 rows",
        "",
        "## Source",
        "- snapshot: x",
      ].join("\n"),
    );
    assert.deepEqual(parsed, { expected: "3 rows", actual: "- 0 rows" });
    assert.deepEqual(runs.parseOutcomeEvidence(null), {
      expected: null,
      actual: null,
    });
  });
});

describe("failure panel", () => {
  it("leads with the failing step, its screenshot, and the diagnostics capture", () => {
    const root = tempDir("cairn-runs-");
    const runId = "2026-09-01T11-00-00-000Z_checkout_d4e5f6";
    const dir = makeRun(root, runId, {
      specName: "checkout",
      run: {
        status: "failed",
        summary: "step click_pay failed",
        failure: { step: "click_pay", message: "locator not found" },
        steps: [
          { id: "open_cart", status: "passed", durationMs: 600 },
          {
            id: "click_pay",
            status: "failed",
            durationMs: 5250,
            error: 'locator not found: role=button name="Pay now"',
            artifacts: [
              "snapshots/002_click_pay.txt",
              "screenshots/002_click_pay.png",
              "diagnostics/002_click_pay.json",
            ],
          },
        ],
        outcomes: [{ id: "order_saved", status: "skipped" }],
      },
    });
    useEventsFixture(dir, "events-failed-step.ndjson");
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "screenshots", "002_click_pay.png"),
      Buffer.from("89504e47", "hex"),
    );
    write(
      dir,
      "stash-receipt.json",
      JSON.stringify({
        stashId: "stash_7f3a9c",
        status: "saved",
        recordedAt: "2026-09-01T11:00:07.000Z",
        postSaveFailureCount: 0,
      }),
    );
    write(
      dir,
      "diagnostics/002_click_pay.json",
      JSON.stringify({
        url: "http://localhost:8787/cart",
        title: "Cart",
        readyState: "complete",
        step: { kind: "click" },
        visibleButtons: [
          { text: "Pay later", disabled: false },
          { text: "Pay now", disabled: true },
        ],
        visibleLinks: [{ text: "Home" }],
        visibleInputs: [{ label: "Coupon" }],
        expectedTextExcerpts: [
          { needle: "Pay now", found: true, excerpt: "… Pay now …" },
        ],
      }),
    );
    const detail = runs.readRunDetail(dir);
    const failure = detail.failure;
    assert.equal(failure.status, "failed");
    assert.equal(failure.step.id, "click_pay");
    assert.equal(failure.step.kind, "click");
    assert.equal(failure.step.index, 2);
    assert.equal(failure.step.screenshot, "screenshots/002_click_pay.png");
    assert.equal(failure.step.url, "http://localhost:8787/cart");
    assert.deepEqual(failure.diagnostics.buttons, [
      "Pay later",
      "Pay now (disabled)",
    ]);
    assert.deepEqual(detail.stashReceipt.stashId, "stash_7f3a9c");
    assert.equal(detail.eventsModel.steps[1].status, "failed");
    assert.equal(detail.eventsModel.stash.stashId, "stash_7f3a9c");
  });

  it("surfaces the failed precondition with its output tail", () => {
    const root = tempDir("cairn-runs-");
    const runId = "2026-09-01T12-00-00-000Z_reset_data_0a0b0c";
    const dir = makeRun(root, runId, {
      specName: "reset_data",
      run: {
        status: "errored",
        summary: "precondition quiesce timed out",
        failure: {
          phase: "precondition",
          name: "quiesce",
          message: "timed out after 60000ms",
          timedOut: true,
        },
        steps: [],
        outcomes: [],
      },
    });
    useEventsFixture(dir, "events-precondition-errored.ndjson");
    const failure = runs.readRunDetail(dir).failure;
    assert.equal(failure.phase, "precondition");
    assert.equal(failure.step, null);
    assert.equal(failure.precondition.name, "quiesce");
    assert.equal(failure.precondition.timedOut, true);
    assert.match(failure.precondition.outputTail, /waiting for 2 jobs/);
  });

  it("pulls expected/actual for failed outcomes and lists services evidence", () => {
    const root = tempDir("cairn-runs-");
    const runId = "2026-09-01T13-00-01-000Z_report_export_112233";
    const dir = makeRun(root, runId, {
      specName: "report_export",
      run: {
        status: "failed",
        summary: "outcome report_rows failed",
        failure: {
          outcome: "report_rows",
          message: "outcome report_rows failed",
        },
        outcomes: [
          {
            id: "report_downloaded",
            status: "passed",
            evidence: "outcomes/report_downloaded.md",
          },
          {
            id: "report_rows",
            status: "failed",
            evidence: "outcomes/report_rows.md",
          },
        ],
      },
    });
    useEventsFixture(dir, "events-outcome-failed.ndjson");
    write(
      dir,
      "outcomes/report_rows.md",
      "# Outcome: report_rows\n\n## Expected\n12 rows\n\n## Actual\n- 0 rows\n\n## Source\n- x\n",
    );
    write(dir, "services/docker.log", "web_1 | listening\n");
    write(dir, "videos/run.webm", "\u001aE\u00df\u00a3");
    const detail = runs.readRunDetail(dir);
    assert.deepEqual(
      detail.failure.outcomes.map((outcome) => [
        outcome.id,
        outcome.expected,
        outcome.actual,
      ]),
      [["report_rows", "12 rows", "- 0 rows"]],
    );
    assert.deepEqual(detail.failure.servicesLogs, ["services/docker.log"]);
    assert.deepEqual(
      detail.videos.map((video) => video.path),
      ["videos/run.webm"],
    );
    assert.equal(detail.eventsModel.services.length, 6);
  });

  it("is null for a passing run", () => {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN_A);
    assert.equal(runs.readRunDetail(dir).failure, null);
  });
});

describe("readRunDetail: hooks from the invocation journal", () => {
  // Recorded with `cairn run a.yml b.yml --repeat 2 --parallel 2 --mock
  // --before … --after '…; exit 3'`: hook.* exist only in the journal.
  const RUN = "2026-10-02T06-03-44-062Z_orders_flow_ec1d04";
  const INVOCATION = "2026-10-02T06-03-43-993Z_12486_5f0347";
  const OTHER_RUN = "2026-10-02T06-03-44-062Z_orders_list_5daa0b";

  /**
   * @param {{ withRunJson?: boolean }} [options]
   */
  function layout(options = {}) {
    const root = tempDir("cairn-runs-");
    const dir = makeRun(root, RUN, {
      specName: "orders_flow",
      run: {
        status: "failed",
        summary: "outcome order_saved failed",
        failure: { outcome: "order_saved", message: "outcome failed" },
        outcomes: [
          {
            id: "order_saved",
            status: "failed",
            evidence: "outcomes/order_saved.md",
          },
        ],
        invocation: {
          id: INVOCATION,
          index: 3,
          total: 4,
          dir: `_invocations/${INVOCATION}`,
        },
      },
    });
    if (options.withRunJson === false) fs.rmSync(path.join(dir, "run.json"));
    useEventsFixture(dir, "events-recorded-run.ndjson");
    const journal = path.join(root, "_invocations", INVOCATION);
    fs.mkdirSync(journal, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "fixtures", "invocation-recorded-repeat.ndjson"),
      path.join(journal, "events.ndjson"),
    );
    write(journal, "logs/hook-before-01.log", "warming cache\n[exit 0]\n");
    write(
      journal,
      `logs/hook-after-01-${RUN}.log`,
      `collecting metrics for ${RUN}\n[exit 3 after 4ms]\n`,
    );
    write(
      journal,
      `logs/hook-after-01-${OTHER_RUN}.log`,
      `collecting metrics for ${OTHER_RUN}\n`,
    );
    return { root, dir, journal };
  }

  it("merges this run's after hook and its iteration's before hook", () => {
    const { dir } = layout();
    const detail = runs.readRunDetail(dir);
    assert.deepEqual(
      detail.eventsModel.hooks.map((row) => [
        row.hook,
        row.iteration,
        row.runId,
        row.status,
        row.exitCode,
        row.logSource,
      ]),
      [
        ["before", 2, null, "passed", 0, "invocation"],
        ["after", 2, RUN, "failed", 3, "invocation"],
      ],
    );
    assert.equal(detail.journal.invocationId, INVOCATION);
    assert.deepEqual(
      detail.journal.logs.map((entry) => entry.path),
      ["logs/hook-before-01.log", `logs/hook-after-01-${RUN}.log`],
    );
    // The run's own counters are untouched by the merged journal events.
    assert.equal(detail.eventCount, 14);
    assert.equal(detail.eventsModel.status, "failed");

    assert.deepEqual(detail.failure.hooks, [
      {
        hook: "after",
        index: 1,
        command: "echo collecting metrics for $CAIRN_RUN_ID; exit 3",
        exitCode: 3,
        durationMs: 4,
        timedOut: false,
        outputTail: `collecting metrics for ${RUN}`,
        logPath: `logs/hook-after-01-${RUN}.log`,
        logSource: "invocation",
      },
    ]);
  });

  it("finds the journal from run.started when run.json is missing", () => {
    const { dir, journal } = layout({ withRunJson: false });
    const detail = runs.readRunDetail(dir);
    assert.equal(detail.eventsModel.hooks.length, 2);
    assert.equal(runs.runJournalDir(dir), journal);
  });

  it("serves hook logs only through the run's own journal link", () => {
    const { dir, journal } = layout();
    assert.equal(runs.runJournalDir(dir), journal);
    const text = runs.readBoundedText(
      /** @type {string} */ (runs.runJournalDir(dir)),
      `logs/hook-after-01-${RUN}.log`,
    );
    assert.equal(text.ok, true);
    assert.match(String(text.text), /collecting metrics/);
    // A forged invocation id never escapes the artifact root.
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, "run.json"), "utf8"),
    );
    record.invocation.id = "../../etc";
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(record));
    assert.equal(runs.runJournalDir(dir), null);
  });

  it("has no hooks or journal when the journal folder is gone", () => {
    const { dir, journal } = layout();
    fs.rmSync(journal, { recursive: true });
    const detail = runs.readRunDetail(dir);
    assert.deepEqual(detail.eventsModel.hooks, []);
    assert.equal(detail.journal, null);
    assert.deepEqual(detail.failure.hooks, []);
  });
});

describe("pinned, refused, stashed and published runs (contract 2b)", () => {
  const REFUSED = "2026-10-02T09-00-00-000Z_checkout_d00001";
  const PINNED = "2026-10-02T10-00-00-000Z_checkout_d00002";
  const PLAIN = "2026-10-02T11-00-00-000Z_landing_d00003";

  /** @returns {string} */
  function fixtureRoot() {
    const root = tempDir("cairn-runs-2b-");
    const refusedDir = makeRun(root, REFUSED, {
      specName: "checkout",
      run: {
        status: "refused",
        summary: "refused by environment policy",
        exitCode: 7,
        environment: "prod",
        outcomes: [],
        steps: [],
        refusal: {
          reason: "requires.env does not list prod",
          env: "prod",
          requires: { env: ["local", "staging"], mutates: true },
        },
      },
    });
    write(
      refusedDir,
      "events.ndjson",
      `${[
        { type: "run.started", runId: REFUSED, spec: "checkout" },
        {
          type: "run.refused",
          reason: "requires.env does not list prod",
          env: "prod",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    const pinnedDir = makeRun(root, PINNED, {
      specName: "checkout",
      run: {
        status: "failed",
        summary: "outcome failed",
        pinned: { at: "2026-10-02T10-05-00.000Z", reason: "bug 42 evidence" },
      },
    });
    write(
      pinnedDir,
      "stash-receipt.json",
      JSON.stringify({
        $schema: "urn:cairntrace.dev:stash-receipt:v1",
        version: "1",
        stashId: "stash_pin",
        status: "saved",
        postSaveFailureCount: 0,
        recordedAt: "2026-10-02T10:06:00.000Z",
        contentHash: "sha256:abc",
        fileCount: 31,
        sizeBytes: 40960,
        expiresAt: "2026-10-16T10:06:00.000Z",
        tags: ["spec:checkout", "keep"],
        excluded: ["traces/"],
        secretsFound: 1,
      }),
    );
    write(
      pinnedDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "fcheap://cloud/vaults/private/artifacts/pin1",
        sha256: "a".repeat(64),
        sizeBytes: 9000,
        publishedAt: "2026-10-02T10:07:00.000Z",
        expiresAt: "2026-10-09T10:07:00.000Z",
        webUrl: "https://file.cheap/a/pin1",
      }),
    );
    makeRun(root, PLAIN, { specName: "landing" });
    return root;
  }

  it("lists pins and refusals on run summaries (and searches their text)", () => {
    const root = fixtureRoot();
    const list = runs.listRuns(root);
    const refused = list.find((run) => run.runId === REFUSED);
    const pinned = list.find((run) => run.runId === PINNED);
    const plain = list.find((run) => run.runId === PLAIN);
    assert.equal(refused?.status, "refused");
    assert.equal(refused?.refusal?.env, "prod");
    assert.equal(
      refused?.refusal?.requiresText,
      "env local, staging · mutates",
    );
    assert.equal(refused?.pinned, null);
    assert.deepEqual(pinned?.pinned, {
      at: "2026-10-02T10-05-00.000Z",
      reason: "bug 42 evidence",
    });
    assert.equal(plain?.pinned, null);
    assert.equal(plain?.refusal, null);
    assert.deepEqual(
      runs.listRuns(root, { status: "refused" }).map((run) => run.runId),
      [REFUSED],
    );
    assert.deepEqual(
      runs.listRuns(root, { search: "bug 42" }).map((run) => run.runId),
      [PINNED],
    );
    assert.deepEqual(
      runs
        .listRuns(root, { search: "does not list prod" })
        .map((run) => run.runId),
      [REFUSED],
    );
  });

  it("gives a refused run a refusal, not a failure panel", () => {
    const root = fixtureRoot();
    const detail = runs.readRunDetail(path.join(root, REFUSED));
    assert.equal(detail.failure, null);
    assert.equal(detail.refusal?.reason, "requires.env does not list prod");
    assert.equal(detail.refusal?.env, "prod");
    assert.equal(detail.eventsModel.status, "refused");
    assert.equal(detail.stashReceipt, null);
    assert.equal(detail.publishReceipt, null);
    assert.equal(detail.pinned, null);

    // Only the event says why: the event's refusal is used.
    const eventOnly = path.join(root, REFUSED);
    const record = JSON.parse(
      fs.readFileSync(path.join(eventOnly, "run.json"), "utf8"),
    );
    delete record.refusal;
    fs.writeFileSync(path.join(eventOnly, "run.json"), JSON.stringify(record));
    assert.equal(
      runs.readRunDetail(eventOnly).refusal?.reason,
      "requires.env does not list prod",
    );
    // Neither says why: still a (blank) refusal, never a failure.
    fs.writeFileSync(path.join(eventOnly, "events.ndjson"), "");
    const blank = runs.readRunDetail(eventOnly);
    assert.deepEqual(blank.refusal, {
      reason: null,
      env: null,
      requires: null,
      requiresText: null,
    });
    assert.equal(blank.failure, null);
  });

  it("reads the stash receipt's 2b fields, the publish receipt, and the pin", () => {
    const root = fixtureRoot();
    const detail = runs.readRunDetail(path.join(root, PINNED));
    assert.deepEqual(detail.stashReceipt, {
      stashId: "stash_pin",
      status: "saved",
      recordedAt: "2026-10-02T10:06:00.000Z",
      postSaveFailureCount: 0,
      contentHash: "sha256:abc",
      fileCount: 31,
      sizeBytes: 40960,
      expiresAt: "2026-10-16T10:06:00.000Z",
      tags: ["spec:checkout", "keep"],
      excluded: ["traces/"],
      secretsFound: 1,
    });
    assert.equal(detail.publishReceipt?.webUrl, "https://file.cheap/a/pin1");
    assert.equal(
      detail.publishReceipt?.artifactRef,
      "fcheap://cloud/vaults/private/artifacts/pin1",
    );
    assert.equal(detail.pinned?.reason, "bug 42 evidence");
    assert.ok(
      detail.failure,
      "a pinned failed run still has its failure panel",
    );
    // An older receipt keeps exactly its four fields.
    assert.deepEqual(
      runs.normalizeStashReceipt({
        stashId: "s",
        status: "saved",
        recordedAt: "2026-10-02T10:06:00.000Z",
        postSaveFailureCount: 0,
      }),
      {
        stashId: "s",
        status: "saved",
        recordedAt: "2026-10-02T10:06:00.000Z",
        postSaveFailureCount: 0,
      },
    );
    assert.equal(runs.normalizeStashReceipt({ status: "saved" }), null);
  });

  it("links local stash receipts back to their runs", () => {
    const root = fixtureRoot();
    const receipts = runs.listStashReceipts(root);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].stashId, "stash_pin");
    assert.equal(receipts[0].runId, PINNED);
    assert.equal(receipts[0].spec, "checkout");
    assert.equal(receipts[0].status, "failed");
    assert.equal(receipts[0].pinned, true);
    assert.deepEqual(receipts[0].receipt.excluded, ["traces/"]);
  });
});
