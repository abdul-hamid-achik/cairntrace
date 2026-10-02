/**
 * The shared run-event describer + reducer, exercised against fixtures that
 * copy the runner's real event shapes (src/core/runner/Runner.ts,
 * services.ts, cli/commands/stash.ts) plus the additive v1 contract
 * (phase/heartbeat/outcome.started/log.opened/hook/invocation). The
 * `*-recorded-*` fixtures are real `cairn run --mock` output, and every
 * fixture is validated against events.v1 by
 * src/core/schema/desktopFixtures.test.ts (a run stream never carries
 * hook.* or invocation.*: those live in the invocation journal).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const events = require("../lib/events");

/**
 * @param {string} name
 * @returns {Array<Record<string, any>>}
 */
function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const ALL_FIXTURES = fs
  .readdirSync(path.join(__dirname, "fixtures"))
  .filter((name) => name.endsWith(".ndjson"));

describe("describeEvent", () => {
  it("never yields a blank or bare-muted label for any fixture line", () => {
    for (const name of ALL_FIXTURES) {
      for (const event of fixture(name)) {
        const described = events.describeEvent(event);
        assert.ok(described.label.trim(), `${name}: ${event.type} blank`);
        if (described.tone === "muted" && described.label === event.type)
          assert.fail(`${name}: ${event.type} rendered as a bare muted label`);
      }
    }
  });

  it("renders a failed step as bad with its error and duration", () => {
    const failed = fixture("events-failed-step.ndjson").find(
      (event) => event.type === "step.failed",
    );
    const described = events.describeEvent(failed);
    assert.equal(described.tone, "bad");
    assert.equal(described.stepId, "click_pay");
    assert.match(described.label, /step click_pay failed · 5\.25s/);
    assert.match(described.detail, /locator not found/);
  });

  it("renders a when: skip as skipped, not passed", () => {
    const skipped = fixture("events-passed.ndjson").find(
      (event) => event.type === "step.finished" && event.skipped,
    );
    const described = events.describeEvent(skipped);
    assert.equal(described.tone, "muted");
    assert.match(described.label, /skipped \(when: text:Accept cookies\)/);
  });

  it("maps run.passed / run.failed / run.errored to terminal tones", () => {
    assert.equal(events.describeEvent({ type: "run.passed" }).tone, "ok");
    assert.equal(events.describeEvent({ type: "run.failed" }).tone, "bad");
    const errored = fixture("events-precondition-errored.ndjson").at(-1);
    const described = events.describeEvent(errored);
    assert.equal(described.tone, "bad");
    assert.match(
      described.label,
      /errored in precondition quiesce \(timed out\)/,
    );
  });

  it("describes preconditions with name, exit code, duration, and output tail", () => {
    const [, , , , timedOut] = fixture("events-precondition-errored.ndjson");
    const described = events.describeEvent(timedOut);
    assert.equal(described.tone, "bad");
    assert.match(described.label, /precondition quiesce timed out · 1m 0s/);
    assert.equal(described.detail, "waiting for 2 jobs");
    const ok = events.describeEvent(
      fixture("events-precondition-errored.ndjson")[2],
    );
    assert.equal(ok.tone, "ok");
    assert.match(ok.label, /exit 0 · 1\.50s/);
  });

  it("renders a failed outcome from what the event carries (no expected/actual)", () => {
    const failed = fixture("events-contract-v1.ndjson").find(
      (event) => event.type === "outcome.failed",
    );
    const described = events.describeEvent(failed);
    assert.equal(described.tone, "bad");
    assert.match(described.label, /^outcome order_persisted failed/);
    assert.equal(described.detail, null);
  });

  it("covers the v1 contract additions", () => {
    const lines = fixture("events-contract-v1.ndjson").map(
      (event) => events.describeEvent(event).label,
    );
    assert.ok(lines.some((line) => /spec 3\/7/.test(line)));
    assert.ok(
      lines.some((line) =>
        /\[2\/2\] step save_order started · click role=button "Save"/.test(
          line,
        ),
      ),
    );
    assert.ok(
      lines.some((line) => /phase → precondition · quiesce/.test(line)),
    );
    assert.ok(
      lines.some((line) => /heartbeat · precondition quiesce/.test(line)),
    );
    assert.ok(
      lines.some((line) => /verifying… \(script, timeout 30\.0s\)/.test(line)),
    );
    assert.ok(lines.some((line) => /polling orders table/.test(line)));
    assert.ok(
      lines.some((line) =>
        line.startsWith(
          "stashed · stash_91d0e2 (saved_with_failures) · 1 post-save failure",
        ),
      ),
    );
    const journal = fixture("invocation-recorded-repeat.ndjson").map(
      (event) => events.describeEvent(event).label,
    );
    assert.ok(journal.some((line) => line.startsWith("after hook #1 exit 3")));
    assert.ok(journal.some((line) => line.startsWith("before hook #1 exit 0")));
  });

  it("describes stash, retention, services, and video events", () => {
    const stash = events.describeEvent(
      fixture("events-failed-step.ndjson").at(-1),
    );
    assert.equal(stash.tone, "ok");
    assert.equal(stash.label, "stashed · stash_7f3a9c");
    const services = fixture("events-outcome-failed.ndjson").map((event) =>
      events.describeEvent(event),
    );
    assert.equal(
      services[0].label,
      "services docker start · docker compose up -d",
    );
    assert.equal(services[2].tone, "ok");
    assert.equal(services[3].tone, "muted");
    assert.equal(services.at(-1).tone, "warn");
    assert.ok(
      services.some((entry) => entry.label === "video saved · videos/run.webm"),
    );
    const seedFail = events.describeEvent(
      fixture("invocation-events.ndjson").find(
        (event) => event.type === "services.seed.fail",
      ),
    );
    assert.equal(seedFail.tone, "bad");
    assert.equal(seedFail.label, "services seed fail · exit 3");
  });

  it("marks a timed-out hook as failed", () => {
    const described = events.describeEvent({
      type: "hook.finished",
      hook: "after",
      index: 2,
      exitCode: 0,
      timedOut: true,
      durationMs: 30_000,
    });
    assert.equal(described.tone, "bad");
    assert.equal(described.label, "after hook #2 timed out · 30.0s");
    const model = events.reduceEvents([
      { type: "hook.started", hook: "after", index: 2, command: "x" },
      {
        type: "hook.finished",
        hook: "after",
        index: 2,
        exitCode: 0,
        timedOut: true,
        durationMs: 1,
      },
    ]);
    assert.equal(model.hooks[0].status, "failed");
  });

  it("falls back to type + compact fields for unknown types", () => {
    const [future, hologram, tunnel] = fixture("unknown-events.ndjson").map(
      (event) => events.describeEvent(event),
    );
    assert.equal(future.label, "future.thing · answer=42 label=something new");
    assert.equal(hologram.label, "artifact.hologram · path=holo/1.bin");
    assert.equal(
      tunnel.label,
      "services tunnel restart · tunnel re-established",
    );
    assert.equal(events.describeEvent({}).label, "unknown");
  });
});

describe("reduceEvents", () => {
  it("rolls a passing run into steps (with the when: skip) and a terminal status", () => {
    const model = events.reduceEvents(fixture("events-passed.ndjson"));
    assert.equal(model.status, "passed");
    assert.equal(model.terminal.durationMs, 2200);
    assert.deepEqual(
      model.steps.map((row) => [row.stepId, row.status]),
      [
        ["open_home", "passed"],
        ["dismiss_banner", "skipped"],
        ["click_orders", "passed"],
      ],
    );
    assert.equal(model.steps[2].screenshot, "screenshots/003_click_orders.png");
    assert.deepEqual(model.steps[2].artifacts, [
      "screenshots/003_click_orders.png",
      "requests/orders.json",
    ]);
    assert.equal(
      model.latestScreenshot.path,
      "screenshots/003_click_orders.png",
    );
    assert.equal(model.outcomes[0].status, "passed");
  });

  it("marks a step.failed row failed with its error, never leaves it running", () => {
    const model = events.reduceEvents(fixture("events-failed-step.ndjson"));
    const failed = model.steps.find((row) => row.stepId === "click_pay");
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /Pay now/);
    assert.equal(failed.diagnostics, "diagnostics/002_click_pay.json");
    assert.equal(model.outcomes[0].status, "skipped");
    assert.deepEqual(model.stash, {
      ok: true,
      action: "auto-stash",
      stashId: "stash_7f3a9c",
      status: "saved",
      postSaveFailureCount: 0,
      reason: null,
    });
    assert.equal(events.stashBadge(model.stash).tone, "ok");
  });

  it("renders an object-form when: as key: value text and keeps it on the row", () => {
    const skipped = {
      type: "step.finished",
      stepId: "dismiss",
      skipped: true,
      when: { selector: ".banner", hasText: "Accept" },
    };
    assert.equal(
      events.describeEvent(skipped).label,
      "step dismiss skipped (when: selector: .banner, hasText: Accept)",
    );
    const model = events.reduceEvents([
      { type: "step.started", stepId: "dismiss", index: 1 },
      skipped,
    ]);
    assert.equal(model.steps[0].status, "skipped");
    assert.equal(model.steps[0].when, "selector: .banner, hasText: Accept");
    assert.equal(events.whenText("text:Accept cookies"), "text:Accept cookies");
    assert.equal(events.whenText(null), null);
  });

  it("shows a stash saved with post-save failures as a warning, not green", () => {
    const partial = {
      type: "artifact.stash",
      action: "auto-stash",
      stashId: "stash_abc",
      status: "saved_with_failures",
      postSaveFailureCount: 2,
    };
    const described = events.describeEvent(partial);
    assert.equal(described.tone, "warn");
    assert.match(described.label, /saved_with_failures/);
    assert.match(described.label, /2 post-save failure/);
    const model = events.reduceEvents([partial]);
    const badge = events.stashBadge(model.stash);
    assert.equal(badge.tone, "warn");
    assert.equal(badge.text, "stashed with failures stash_abc");
    // A failure count alone (status "saved") is still partial.
    assert.equal(
      events.stashBadge({
        ok: true,
        stashId: "s",
        status: "saved",
        postSaveFailureCount: 1,
      }).tone,
      "warn",
    );
    assert.equal(
      events.stashBadge({ ok: false, reason: "upload refused" }).text,
      "not stashed",
    );
    assert.equal(events.stashBadge(null), null);
  });

  it("tracks preconditions and the errored run", () => {
    const model = events.reduceEvents(
      fixture("events-precondition-errored.ndjson"),
    );
    assert.equal(model.status, "errored");
    assert.equal(model.terminal.phase, "precondition");
    assert.deepEqual(
      model.preconditions.map((row) => [row.name, row.status, row.exitCode]),
      [
        ["seed_fixture", "passed", 0],
        ["quiesce", "failed", null],
      ],
    );
    assert.equal(model.preconditions[1].timedOut, true);
    assert.match(model.preconditions[1].outputTail, /waiting for 2 jobs/);
  });

  it("keeps the services lifecycle and the retention warning", () => {
    const model = events.reduceEvents(fixture("events-outcome-failed.ndjson"));
    assert.equal(model.services.length, 6);
    assert.equal(model.services[0].phase, "docker");
    assert.equal(model.services[4].data.window, "web");
    assert.equal(model.video, "videos/run.webm");
    assert.match(model.retention.warning, /archiveToStash/);
    assert.deepEqual(
      model.outcomes.map((row) => [row.outcomeId, row.status]),
      [
        ["report_downloaded", "passed"],
        ["report_rows", "failed"],
      ],
    );
  });

  it("folds the v1 contract: invocation, phase, logs, step labels, outcome progress, hooks", () => {
    const model = events.reduceEvents(fixture("events-contract-v1.ndjson"));
    assert.equal(model.invocationId, "2026-10-01T08-59-50-000Z_4242_abc123");
    assert.equal(model.invocation.total, 7);
    assert.equal(model.stepTotal, 2);
    assert.deepEqual(
      {
        kind: model.steps[1].kind,
        label: model.steps[1].label,
        index: model.steps[1].index,
        url: model.steps[1].url,
        screenshot: model.steps[1].screenshot,
      },
      {
        kind: "click",
        label: 'click role=button "Save"',
        index: 2,
        url: "http://localhost:8787/orders/new",
        screenshot: "screenshots/002_save_order.png",
      },
    );
    assert.equal(model.latestScreenshot.path, "screenshots/002_save_order.png");
    assert.equal(
      model.preconditions[0].logPath,
      "logs/precondition-01-quiesce.log",
    );
    assert.deepEqual(model.preconditions[0].progress, [
      "47/120 tasks terminal",
    ]);
    assert.deepEqual(
      model.logs.map((entry) => [entry.kind, entry.path]),
      [
        ["narration", "run.log"],
        ["precondition", "logs/precondition-01-quiesce.log"],
        ["outcome", "logs/outcome-order_persisted.log"],
      ],
    );
    const outcome = model.outcomes[0];
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.kind, "script");
    assert.deepEqual(outcome.progress, ["polling orders table (1/10)"]);
    // hook.* live in the invocation journal, never in a run's stream.
    assert.deepEqual(model.hooks, []);
    assert.equal(model.stash.ok, true);
    assert.equal(model.stash.status, "saved_with_failures");
    assert.equal(events.stashBadge(model.stash).tone, "warn");
  });

  it("finishes each parallel --after hook on its own run's row (recorded journal)", () => {
    const lines = fixture("invocation-recorded-repeat.ndjson");
    const model = events.reduceEvents(lines);
    assert.equal(model.planned, 4);
    assert.deepEqual(
      model.hooks
        .filter((row) => row.hook === "before")
        .map((row) => [row.iteration, row.status, row.exitCode]),
      [
        [1, "passed", 0],
        [2, "passed", 0],
      ],
    );
    const after = model.hooks.filter((row) => row.hook === "after");
    const runIds = lines
      .filter((event) => event.type === "hook.started" && event.runId)
      .map((event) => event.runId);
    assert.equal(after.length, 4);
    assert.deepEqual(
      after.map((row) => row.runId),
      runIds,
    );
    for (const row of after) {
      assert.equal(row.status, "failed");
      assert.equal(row.exitCode, 3);
      // The hook echoed its own run id: a mismatched row would show another.
      assert.equal(row.outputTail, `collecting metrics for ${row.runId}`);
      assert.ok(row.logPath.endsWith(`${row.runId}.log`));
    }
  });

  it("reduces an invocation journal stream", () => {
    const model = events.reduceEvents(fixture("invocation-events.ndjson"));
    assert.equal(model.planned, 7);
    assert.equal(model.status, "failed");
    assert.equal(model.hooks[0].hook, "before");
    assert.equal(model.services.at(-1).event, "fail");
    assert.equal(model.logs[0].path, "logs/services-docker.log");
  });

  it("reports the sections each event touched", () => {
    const model = events.createRunModel();
    assert.deepEqual(
      events.applyEvent(model, { type: "step.started", stepId: "a" }),
      ["steps", "phase"],
    );
    assert.deepEqual(
      events.applyEvent(model, {
        type: "step.finished",
        stepId: "a",
        screenshot: "screenshots/1.png",
      }),
      ["steps", "screenshot"],
    );
    assert.deepEqual(events.applyEvent(model, { type: "nope" }), []);
    assert.deepEqual(events.applyEvent(model, null), []);
  });
});

describe("currentPhase", () => {
  it("prefers the heartbeat and extrapolates its elapsed time", () => {
    const model = events.reduceEvents(
      fixture("events-contract-v1.ndjson").slice(0, 6),
    );
    const now = Date.parse("2026-10-01T09:04:12.040Z");
    const phase = events.currentPhase(model, now);
    assert.equal(phase.phase, "preconditions");
    // The last heartbeat is minutes old: the banner says so.
    assert.equal(
      phase.text,
      "precondition quiesce · 4m 12s of 25m 0s · no heartbeat for 3m 57s",
    );
    assert.equal(phase.stale, true);
    // Its two parts: a narrow banner shortens the head, never the detail.
    assert.equal(phase.head, "precondition quiesce");
    assert.equal(phase.detail, " · 4m 12s of 25m 0s · no heartbeat for 3m 57s");
    const fresh = events.currentPhase(
      model,
      Date.parse("2026-10-01T09:00:20.040Z"),
    );
    assert.equal(fresh.text, "precondition quiesce · 20.0s of 25m 0s");
    assert.equal(fresh.stale, false);
  });

  it("derives a phase from the open row on runners without phase events", () => {
    const model = events.reduceEvents(
      fixture("events-failed-step.ndjson").slice(0, 4),
    );
    const phase = events.currentPhase(
      model,
      Date.parse("2026-09-01T11:00:02.800Z"),
    );
    assert.equal(phase.text, "step click_pay · 2.00s");
  });

  it("names the open row when phase.changed carried no item", () => {
    const lines = fixture("events-contract-v1.ndjson");
    const upToSave = lines.slice(
      0,
      lines.findIndex((e) => e.stepId === "save_order") + 1,
    );
    const phase = events.currentPhase(
      events.reduceEvents(upToSave),
      Date.parse("2026-10-01T09:04:14.100Z"),
    );
    assert.equal(phase.text, 'step 2/2 click role=button "Save" · 2.00s');
  });

  it("is null once the run reached a terminal status", () => {
    const model = events.reduceEvents(fixture("events-passed.ndjson"));
    assert.equal(events.currentPhase(model), null);
  });
});

describe("classifyLiveness", () => {
  const now = Date.parse("2026-10-01T09:10:00.000Z");

  it("finished wins", () => {
    assert.equal(
      events.classifyLiveness({ hasRunJson: true, now }).state,
      "finished",
    );
  });

  it("a fresh heartbeat is running", () => {
    assert.equal(
      events.classifyLiveness({ heartbeatTs: now - 10_000, now }).state,
      "running",
    );
  });

  it("a stale heartbeat with a live pid is quiet, with a dead pid is dead", () => {
    assert.equal(
      events.classifyLiveness({
        heartbeatTs: now - 120_000,
        pid: 42,
        pidAlive: true,
        now,
      }).state,
      "quiet",
    );
    const dead = events.classifyLiveness({
      heartbeatTs: now - 120_000,
      pid: 42,
      pidAlive: false,
      now,
    });
    assert.equal(dead.state, "dead");
    assert.match(dead.reason, /process 42 exited/);
  });

  it("an invocation pid alone decides when there is no heartbeat", () => {
    assert.equal(
      events.classifyLiveness({ pid: 7, pidAlive: true, now }).state,
      "running",
    );
    assert.equal(
      events.classifyLiveness({ pid: 7, pidAlive: false, now }).state,
      "dead",
    );
  });

  it("falls back to mtime windows only when neither signal exists", () => {
    assert.equal(
      events.classifyLiveness({ lastActivityMs: now - 60_000, now }).state,
      "running",
    );
    assert.equal(
      events.classifyLiveness({ lastActivityMs: now - 10 * 60_000, now }).state,
      "interrupted",
    );
    assert.equal(
      events.classifyLiveness({ lastActivityMs: now - 3_600_000, now }).state,
      "stale",
    );
  });
});

describe("golden event fixtures (src/core/schema/__fixtures__/events)", () => {
  const goldenDir = path.join(
    __dirname,
    "..",
    "..",
    "src",
    "core",
    "schema",
    "__fixtures__",
    "events",
  );
  const goldens = fs.existsSync(goldenDir)
    ? fs.readdirSync(goldenDir).filter((name) => name.endsWith(".ndjson"))
    : [];

  it("describes every golden line without blank or bare labels", (t) => {
    if (!goldens.length) {
      t.skip("no runner goldens yet");
      return;
    }
    for (const name of goldens) {
      const lines = fs
        .readFileSync(path.join(goldenDir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim());
      const model = events.createRunModel();
      for (const line of lines) {
        const event = JSON.parse(line);
        const described = events.describeEvent(event);
        assert.ok(
          described.label.trim(),
          `${name}: blank label for ${event.type}`,
        );
        assert.ok(
          !(described.tone === "muted" && described.label === event.type),
          `${name}: ${event.type} has no describer and no compact fields`,
        );
        events.applyEvent(model, event);
      }
      assert.ok(model.eventCount === lines.length);
    }
  });

  /**
   * What each runner golden must reduce to. Pinned to the runner's own files,
   * so a vocabulary drift on either side fails here, not in a hand copy.
   * @type {Record<string, (model: Record<string, any>) => void>}
   */
  const EXPECTED = {
    "pass.ndjson": (model) => {
      assert.equal(model.status, "passed");
      assert.deepEqual(
        model.steps.map((row) => [row.stepId, row.status]),
        [
          ["open_profile", "passed"],
          ["step_2", "passed"],
          ["step_3", "passed"],
        ],
      );
      assert.deepEqual(
        model.preconditions.map((row) => [row.name, row.status]),
        [["seed_check", "passed"]],
      );
      assert.deepEqual(
        model.outcomes.map((row) => [row.outcomeId, row.status]),
        [
          ["on_profile", "passed"],
          ["saved_banner", "passed"],
        ],
      );
    },
    "step-fail.ndjson": (model) => {
      assert.equal(model.status, "failed");
      const failed = model.steps.filter((row) => row.status === "failed");
      assert.deepEqual(
        failed.map((row) => row.stepId),
        ["save"],
      );
      assert.match(failed[0].error, /no visible element matches/);
      assert.equal(failed[0].screenshot, "screenshots/002_save.png");
      assert.equal(failed[0].diagnostics, "diagnostics/002_save.json");
      assert.equal(model.steps[0].status, "passed");
      assert.deepEqual(
        model.outcomes.map((row) => [row.outcomeId, row.status]),
        [["on_profile", "passed"]],
      );
    },
    "when-skip.ndjson": (model) => {
      assert.equal(model.status, "passed");
      assert.deepEqual(
        model.steps.map((row) => [row.stepId, row.status]),
        [
          ["step_1", "passed"],
          ["dismiss_banner", "skipped"],
          ["settle", "passed"],
        ],
      );
      assert.equal(model.steps[1].when, "text:Accept cookies");
    },
    "precondition-fail.ndjson": (model) => {
      assert.equal(model.status, "errored");
      assert.equal(model.terminal.phase, "precondition");
      assert.equal(model.terminal.name, "data_guard");
      assert.deepEqual(
        model.preconditions.map((row) => [row.name, row.status, row.exitCode]),
        [["data_guard", "failed", 3]],
      );
      assert.match(
        model.preconditions[0].outputTail,
        /fixture database unreachable/,
      );
      assert.equal(model.steps.length, 0);
    },
    "outcome-fail.ndjson": (model) => {
      assert.equal(model.status, "failed");
      assert.deepEqual(
        model.steps.map((row) => [row.stepId, row.status]),
        [["step_1", "passed"]],
      );
      assert.deepEqual(
        model.outcomes.map((row) => [row.outcomeId, row.status]),
        [
          ["welcome_copy", "failed"],
          ["home", "passed"],
        ],
      );
    },
    "script-progress.ndjson": (model) => {
      assert.equal(model.status, "passed");
      assert.deepEqual(model.preconditions[0].progress, ["3/9 queues idle"]);
      assert.deepEqual(model.outcomes[0].progress, [
        "47/120 tasks terminal",
        "120/120 tasks terminal",
      ]);
      assert.equal(model.outcomes[0].status, "passed");
    },
  };

  it("reduces every runner golden to its expected statuses", (t) => {
    if (!goldens.length) {
      t.skip("no runner goldens yet");
      return;
    }
    for (const name of goldens) {
      const check = EXPECTED[name];
      assert.ok(check, `${name}: new runner golden, add its expectations here`);
      const lines = fs
        .readFileSync(path.join(goldenDir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      check(events.reduceEvents(lines));
    }
  });
});

// ── contract 2b: stash reasons/excluded/secrets/TTL, publish, refusal ──────
// Built inline, not as .ndjson fixtures: every desktop fixture is validated
// against the runner's strict events.v1 schema, which gains these fields in
// the runner lanes of the same wave.

describe("stash, publish and refusal events (contract 2b)", () => {
  it("names a stash failure's reason code and keeps its message", () => {
    const failed = {
      type: "artifact.stash",
      action: "auto-stash",
      status: "error",
      reason: "fcheap-missing",
      message: "fcheap not found on PATH",
    };
    const described = events.describeEvent(failed);
    assert.equal(described.tone, "warn");
    assert.equal(described.label, "not stashed · fcheap-missing");
    assert.match(String(described.detail), /not installed/);
    assert.match(String(described.detail), /fcheap not found on PATH/);

    const model = events.reduceEvents([failed]);
    assert.equal(model.stash.ok, false);
    assert.equal(model.stash.reason, "fcheap-missing");
    assert.equal(model.stash.message, "fcheap not found on PATH");
    const badge = events.stashBadge(model.stash);
    assert.equal(badge?.tone, "warn");
    assert.equal(badge?.text, "not stashed · fcheap-missing");
    assert.match(
      String(badge?.title),
      /reason: fcheap-missing — fcheap is not installed/,
    );
    assert.match(String(badge?.title), /message: fcheap not found on PATH/);
  });

  it("shows excluded members, secret findings, TTL, expiry and tags", () => {
    const saved = {
      type: "artifact.stash",
      action: "auto-stash",
      status: "saved",
      stashId: "stash_2b",
      receipt: "stash-receipt.json",
      postSaveFailureCount: 0,
      excluded: ["traces/", "videos/"],
      secretsFound: 2,
      ttl: "7d",
      expiresAt: "2026-10-09T10:00:00.000Z",
      tags: ["spec:checkout", "env:local"],
    };
    const described = events.describeEvent(saved);
    assert.equal(described.tone, "warn", "secret findings are a warning");
    assert.match(described.label, /stashed · stash_2b · 2 secret finding/);
    assert.match(String(described.detail), /left out traces\/, videos\//);
    assert.match(String(described.detail), /stash\.include/);

    const model = events.reduceEvents([saved]);
    assert.deepEqual(model.stash.excluded, ["traces/", "videos/"]);
    assert.equal(model.stash.secretsFound, 2);
    assert.equal(model.stash.ttl, "7d");
    assert.deepEqual(model.stash.tags, ["spec:checkout", "env:local"]);
    const badge = events.stashBadge(model.stash);
    assert.equal(badge?.tone, "warn");
    assert.equal(badge?.text, "stashed stash_2b · 2 secret finding(s)");
    const lines = events.stashLines(
      model.stash,
      Date.parse("2026-10-02T10:00:00.000Z"),
    );
    assert.ok(
      lines.includes("left out: traces/, videos/ — opt in with stash.include"),
      lines.join("\n"),
    );
    assert.ok(lines.some((line) => line.startsWith("secrets found: 2")));
    assert.ok(lines.includes("ttl: 7d"));
    assert.ok(lines.some((line) => /^expires: .*\(in 7d\)$/.test(line)));
    assert.ok(lines.includes("tags: spec:checkout, env:local"));
    assert.ok(lines.includes("restore: cairn stash restore stash_2b"));
  });

  it("keeps an older stash model exactly as it was", () => {
    const model = events.reduceEvents([
      {
        type: "artifact.stash",
        action: "auto-stash",
        stashId: "s1",
        status: "saved",
        postSaveFailureCount: 0,
      },
    ]);
    assert.deepEqual(Object.keys(model.stash).toSorted(), [
      "action",
      "ok",
      "postSaveFailureCount",
      "reason",
      "stashId",
      "status",
    ]);
    assert.equal(events.stashBadge(model.stash)?.tone, "ok");
    // a legacy free-form failure keeps its text and puts the reason in the tooltip
    const legacy = events.stashBadge({ ok: false, reason: "upload refused" });
    assert.equal(legacy?.text, "not stashed");
    assert.match(String(legacy?.title), /upload refused/);
  });

  it("describes and reduces artifact.publish successes and failures", () => {
    const ok = {
      type: "artifact.publish",
      status: "published",
      artifactRef: {
        uri: "fcheap://cloud/vaults/private/artifacts/abc123",
        artifact_id: "abc123",
      },
      webUrl: "https://file.cheap/a/abc123",
    };
    const described = events.describeEvent(ok);
    assert.equal(described.tone, "ok");
    assert.match(described.label, /published to file.cheap · fcheap:\/\/cloud/);
    const model = events.reduceEvents([ok]);
    assert.deepEqual(model.publish, {
      ok: true,
      status: "published",
      reason: null,
      message: null,
      ts: null,
      artifactRef: "fcheap://cloud/vaults/private/artifacts/abc123",
      webUrl: "https://file.cheap/a/abc123",
    });
    assert.equal(events.publishBadge(model.publish)?.text, "published");
    const withExcluded = events.reduceEvents([
      { ...ok, excluded: ["traces/"] },
    ]).publish;
    assert.deepEqual(withExcluded.excluded, ["traces/"]);
    assert.ok(
      events
        .publishBadge(withExcluded)
        ?.lines.includes(
          "left out: traces/ — opt in with retention.publish.include",
        ),
    );

    const failed = {
      type: "artifact.publish",
      status: "error",
      reason: "auth",
      message: "device token expired",
    };
    assert.equal(events.describeEvent(failed).label, "publish failed · auth");
    assert.match(
      String(events.describeEvent(failed).detail),
      /credentials are missing or expired .* — device token expired/,
    );
    const failedModel = events.reduceEvents([ok, failed]);
    assert.equal(failedModel.publish.ok, false);
    assert.equal(failedModel.publish.reason, "auth");
    const badge = events.publishBadge(failedModel.publish);
    assert.equal(badge?.tone, "warn");
    assert.equal(badge?.text, "publish failed · auth");
    assert.equal(events.publishBadge(null), null);
  });

  it("ends a refused run as refused (not failed) with its reason", () => {
    const refused = {
      type: "run.refused",
      ts: "2026-10-02T10:00:00.000Z",
      reason: "requires.env does not list prod",
      env: "prod",
    };
    const described = events.describeEvent(refused);
    assert.equal(described.tone, "refused");
    assert.equal(described.label, "run refused · env prod");
    assert.equal(described.detail, "requires.env does not list prod");

    const model = events.reduceEvents([
      { type: "run.started", runId: "r", spec: "checkout" },
      refused,
    ]);
    assert.equal(model.status, "refused");
    assert.equal(model.terminal?.status, "refused");
    assert.deepEqual(model.refusal, {
      reason: "requires.env does not list prod",
      env: "prod",
      code: null,
      spec: null,
      index: null,
      path: null,
      requires: null,
    });
    assert.equal(events.currentPhase(model), null, "nothing is running");
    assert.equal(
      events.describeEvent({ type: "invocation.finished", status: "refused" })
        .tone,
      "refused",
    );
  });
});

describe("run.refused in an invocation journal (contract 2b)", () => {
  it("records the refused planned spec without ending the journal", () => {
    const model = events.reduceEvents([
      { type: "invocation.started", invocationId: "inv", planned: 3 },
      {
        type: "phase.changed",
        ts: new Date().toISOString(),
        phase: "steps",
        item: "spec 2/3",
      },
      {
        type: "run.refused",
        spec: "reset",
        reason: "prod is protected",
        env: "prod",
        code: "protected-env",
        index: 1,
        path: "flows/reset.yml",
      },
    ]);
    assert.equal(model.status, "running");
    assert.equal(model.terminal, null);
    assert.equal(model.refusal, null);
    assert.equal(model.refusals.length, 1);
    assert.ok(events.currentPhase(model), "the journal's phase is still live");
    assert.equal(
      events.plannedRefusal(model.refusals, {
        index: 1,
        spec: "flows/reset.yml",
      })?.code,
      "protected-env",
    );
    assert.equal(
      events.plannedRefusal(model.refusals, {
        index: 2,
        spec: "flows/reset.yml",
      }),
      null,
      "an index match is required when both carry one",
    );
    assert.equal(
      events.plannedRefusal([{ path: "/abs/project/flows/reset.yml" }], {
        spec: "flows/reset.yml",
      })?.path,
      "/abs/project/flows/reset.yml",
    );
    assert.equal(
      events.describeEvent(
        model.refusals[0] && {
          type: "run.refused",
          spec: "reset",
          env: "prod",
          index: 1,
          code: "protected-env",
          reason: "prod is protected",
        },
      ).label,
      "[1] run refused · reset · env prod",
    );
  });
});

describe("refused invocations and publish state (2b review fixes)", () => {
  // The journal the real CLI writes for `cairn run <one refused spec>`:
  // status failed, no runs, and a summary without a refused count.
  const SINGLE = {
    status: "failed",
    planned: [{ index: 1, spec: "flows/refused.yml" }],
    runs: [],
    summary: {
      total: 1,
      passed: 0,
      failed: 0,
      errored: 0,
      durationMs: 6,
      exitCode: 7,
    },
  };

  it("derives refusals from the journal summary when it has no refused count", () => {
    assert.equal(events.invocationRefusedCount(SINGLE, []), 1);
    assert.equal(events.invocationStatus(SINGLE, []), "refused");
    // an all-refused batch: the runner journals "passed", exit 0
    const batch = {
      ...SINGLE,
      status: "passed",
      planned: [
        { index: 1, spec: "a.yml" },
        { index: 2, spec: "b.yml" },
      ],
      summary: { ...SINGLE.summary, total: 2, exitCode: 0 },
    };
    assert.equal(events.invocationRefusedCount(batch, []), 2);
    assert.equal(events.invocationStatus(batch, []), "refused");
    // one passed, one refused, no --strict-requires: still passed
    const mixed = {
      ...batch,
      runs: [{ index: 2, spec: "b.yml", status: "passed" }],
      summary: { ...batch.summary, passed: 1 },
    };
    assert.equal(events.invocationRefusedCount(mixed, []), 1);
    assert.equal(events.invocationStatus(mixed, []), "passed");
    // a real failure keeps its status
    const failed = {
      ...mixed,
      status: "failed",
      summary: { ...mixed.summary, passed: 0, failed: 1, exitCode: 1 },
    };
    assert.equal(events.invocationStatus(failed, []), "failed");
    // running, aborted and errored journals are never relabelled
    for (const status of ["running", "aborted", "errored"])
      assert.equal(events.invocationStatus({ ...SINGLE, status }, []), status);
    // a live journal counts its run.refused events, not its summary
    assert.equal(
      events.invocationRefusedCount(
        { ...batch, status: "running", summary: undefined },
        [{ index: 1, path: "a.yml" }],
      ),
      1,
    );
  });

  it("ignores stash and publish events about the runs the retention pass pruned", () => {
    const model = events.reduceEvents([
      { type: "run.started", runId: "r-new", spec: "checkout" },
      {
        type: "artifact.stash",
        action: "archive",
        runId: "r-old",
        status: "saved",
        stashId: "stash_old",
      },
      {
        type: "artifact.publish",
        runId: "r-old",
        status: "published",
        artifactRef: { uri: "fcheap://cloud/vaults/private/artifacts/old" },
      },
    ]);
    assert.equal(model.stash, null);
    assert.equal(model.publish, null);
    const own = events.reduceEvents([
      { type: "run.started", runId: "r-new", spec: "checkout" },
      {
        ts: "2026-10-02T10:00:00.000Z",
        type: "artifact.publish",
        status: "error",
        reason: "save-failed",
      },
    ]);
    assert.equal(own.publish?.reason, "save-failed");
    assert.equal(own.publish?.ts, "2026-10-02T10:00:00.000Z");
    assert.match(
      String(events.publishBadge(own.publish)?.title),
      /save-failed — fcheap could not upload the package/,
    );
  });

  it("shows a newer failed re-publish over the old receipt, and expired packages as expired", () => {
    const receipt = {
      ok: true,
      status: "published",
      artifactRef: "fcheap://cloud/vaults/private/artifacts/e0",
      publishedAt: "2026-10-02T10:00:00.000Z",
      expiresAt: "2026-10-09T10:00:00.000Z",
    };
    const newerFailure = {
      ok: false,
      status: "error",
      reason: "auth",
      ts: "2026-10-02T11:00:00.000Z",
    };
    assert.equal(events.publishState(receipt, newerFailure), newerFailure);
    assert.equal(
      events.publishState(receipt, {
        ...newerFailure,
        ts: "2026-10-02T09:00:00.000Z",
      }),
      receipt,
      "an older failure does not hide the receipt",
    );
    assert.equal(
      events.publishState(receipt, { ...newerFailure, ts: null }),
      receipt,
    );
    assert.equal(events.publishState(null, newerFailure), newerFailure);

    const before = Date.parse("2026-10-05T00:00:00.000Z");
    const afterExpiry = Date.parse("2026-10-10T00:00:00.000Z");
    assert.equal(events.publishExpired(receipt, before), false);
    assert.equal(events.publishExpired(receipt, afterExpiry), true);
    assert.equal(events.publishBadge(receipt, before)?.tone, "ok");
    const expired = events.publishBadge(receipt, afterExpiry);
    assert.equal(expired?.tone, "warn");
    assert.equal(expired?.text, "publish expired");
    assert.match(String(expired?.title), /no longer keeps this package/);
  });
});

describe("evidence sensitivity and traces", () => {
  it("describes artifact.trace saved, dropped and failed", () => {
    const saved = events.describeEvent({
      ts: "2026-10-02T10:00:00.000Z",
      type: "artifact.trace",
      action: "saved",
      path: "traces/agent-browser-trace.json",
      format: "chrome-trace-json",
      sensitivity: "sanitized",
    });
    assert.equal(saved.label, "trace saved · sanitized");
    assert.equal(saved.tone, "muted");
    assert.match(String(saved.detail), /Perfetto/);
    assert.match(String(saved.detail), /never published/);

    const raw = events.describeEvent({
      ts: "2026-10-02T10:00:00.000Z",
      type: "artifact.trace",
      action: "saved",
      path: "traces/playwright-trace.zip",
      format: "playwright-zip",
      sensitivity: "secret-bearing",
    });
    assert.equal(raw.tone, "warn");

    const dropped = events.describeEvent({
      ts: "2026-10-02T10:00:00.000Z",
      type: "artifact.trace",
      action: "dropped",
      reason: "too-large",
      bytes: 80 * 1024 * 1024,
      maxBytes: 50 * 1024 * 1024,
    });
    assert.equal(dropped.label, "trace dropped · too large");
    assert.equal(dropped.tone, "warn");
    assert.match(String(dropped.detail), /traceMaxBytes/);

    const failed = events.describeEvent({
      ts: "2026-10-02T10:00:00.000Z",
      type: "artifact.trace",
      action: "error",
      reason: "stop-failed",
    });
    assert.equal(failed.label, "trace failed · stop-failed");
    assert.match(String(failed.detail), /could not stop/);
  });

  it("summarizes manifest sensitivities, sanitized ones included", () => {
    assert.equal(events.sensitivitySummary(null), null);
    assert.equal(events.sensitivitySummary({ artifacts: [] }), null);
    const summary = events.sensitivitySummary({
      version: "1",
      artifacts: [
        { path: "run.json", sensitivity: "redacted" },
        { path: "screenshots/001.png", sensitivity: "safe" },
        { path: "traces/agent-browser-trace.json", sensitivity: "sanitized" },
        { path: "monitor/001_profile.profile", sensitivity: "secret-bearing" },
        { path: "legacy.txt" },
      ],
    });
    assert.deepEqual(summary?.counts, {
      redacted: 1,
      safe: 1,
      sanitized: 1,
      "secret-bearing": 1,
      unlabeled: 1,
    });
    assert.deepEqual(summary?.sanitized, ["traces/agent-browser-trace.json"]);
    assert.deepEqual(summary?.secretBearing, ["monitor/001_profile.profile"]);
    assert.ok(
      summary?.lines.some((line) =>
        /1 sanitized — .*never published/.test(line),
      ),
    );
    assert.ok(summary?.lines.some((line) => /1 unlabeled/.test(line)));
  });

  it("says why the console does not list a published run", () => {
    const badge = events.publishBadge({
      ok: true,
      status: "published",
      artifactRef: "ref-1",
      runIndexSkipped: "unsupported",
    });
    assert.equal(badge?.tone, "ok");
    assert.ok(
      badge?.lines.some((line) =>
        /not listed in the console: unsupported — .*run-index/.test(line),
      ),
    );
  });
});
