/**
 * The renderer views, mounted in a DOM (happy-dom) with fixture data.
 *
 * Every view renders from the shapes the main process sends; here those
 * shapes come from the same lib/ functions ipc.js calls (listRuns,
 * readRunDetail, listInvocations, the offset readers) over temp artifact
 * roots built from the runner's goldens and the desktop fixtures. Each test
 * asserts the view renders without throwing and shows its key elements,
 * plus the keyboard paths (roving lists, tablists) a mouse-free user needs.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const env = require("./dom-env");
const {
  cleanup,
  makeRun,
  tempDir,
  useEventsFixture,
  write,
} = require("./helpers");
const runs = require("../lib/runs");
const invocations = require("../lib/invocations");

const { Studio, document } = env.installDom();

after(() => {
  env.teardown();
  cleanup();
});

/** @param {Element | null | undefined} node */
const text = (node) => node?.textContent ?? "";
/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
const all = (root, selector) => [...root.querySelectorAll(selector)];

/** A clean #view to mount into. */
function mountPoint() {
  const root = /** @type {HTMLElement} */ (document.getElementById("view"));
  Studio.clear(root);
  return root;
}

/** Record `navigate` emissions (app.js is not loaded, so nothing mounts). */
function recordNavigation() {
  /** @type {Array<{ view: string, params: Record<string, any> }>} */
  const seen = [];
  const off = Studio.on("navigate", (payload) => seen.push(payload));
  return { seen, off };
}

/** A configured project + resolved cairn, so no setup notice shows. */
function configuredState() {
  Studio.state.booted = true;
  Studio.state.info = {
    cairn: { command: "/usr/local/bin/cairn", source: "path" },
    userData: "/tmp/studio-test",
  };
  Studio.state.settings = {
    activeProject: "/tmp/project",
    run: {},
    ui: {},
    projects: [],
  };
  Studio.state.project = {
    dir: "/tmp/project",
    configPath: "/tmp/project/cairntrace.config.yml",
    specs: [],
    config: { project: "fixture", environments: [] },
  };
}

// ── fixture artifact roots ─────────────────────────────────────────────────

/** Recorded with `cairn run … --repeat 2 --parallel 2 --before … --after …`. */
const HOOK_RUN = "2026-10-02T06-03-44-062Z_orders_flow_ec1d04";
const HOOK_INVOCATION = "2026-10-02T06-03-43-993Z_12486_5f0347";
const PLAIN_RUN = "2026-10-01T10-00-00-000Z_landing_aaaaaa";

/** Running journal owned by this test process (its pid is alive). */
const LIVE_INVOCATION = `2026-10-02T09-00-00-000Z_${process.pid}_abc123`;
const DONE_INVOCATION = "2026-10-01T08-00-00-000Z_4242_def456";
const LIVE_RUN_A = "2026-10-02T09-00-01-000Z_alpha_111111";
const LIVE_RUN_B = "2026-10-02T09-00-30-000Z_beta_222222";
const DONE_RUN_Y = "2026-10-01T08-01-00-000Z_yankee_333333";

/** @type {string} */
let runsRoot;
/** @type {string} */
let hookRunDir;

before(() => {
  runsRoot = tempDir("cairn-dom-");

  // A failed run whose hooks live in its invocation journal.
  hookRunDir = makeRun(runsRoot, HOOK_RUN, {
    specName: "orders_flow",
    run: {
      status: "failed",
      summary: "outcome order_saved failed",
      failure: { outcome: "order_saved", message: "outcome failed" },
      labels: { round: "2", variant: "b" },
      outcomes: [
        {
          id: "order_saved",
          status: "failed",
          evidence: "outcomes/order_saved.md",
        },
      ],
      invocation: {
        id: HOOK_INVOCATION,
        index: 3,
        total: 4,
        dir: `_invocations/${HOOK_INVOCATION}`,
      },
    },
  });
  useEventsFixture(hookRunDir, "events-recorded-run.ndjson");
  const hookJournal = path.join(runsRoot, "_invocations", HOOK_INVOCATION);
  fs.mkdirSync(hookJournal, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "fixtures", "invocation-recorded-repeat.ndjson"),
    path.join(hookJournal, "events.ndjson"),
  );
  write(hookJournal, "logs/hook-before-01.log", "warming cache\n[exit 0]\n");
  write(
    hookJournal,
    `logs/hook-after-01-${HOOK_RUN}.log`,
    `collecting metrics for ${HOOK_RUN}\n[exit 3 after 4ms]\n`,
  );

  // A passed run with no invocation (an older runner).
  makeRun(runsRoot, PLAIN_RUN, { specName: "landing" });

  // A running invocation started by an agent (origin mcp).
  const live = path.join(runsRoot, "_invocations", LIVE_INVOCATION);
  write(
    live,
    "invocation.json",
    JSON.stringify({
      version: 1,
      invocationId: LIVE_INVOCATION,
      pid: process.pid,
      origin: "mcp",
      client: "an-agent",
      argv: ["run", "flows/alpha.yml", "flows/beta.yml", "flows/gamma.yml"],
      cwd: "/tmp/project",
      env: "local",
      parallel: 1,
      planned: [
        { index: 1, spec: "flows/alpha.yml" },
        { index: 2, spec: "flows/beta.yml" },
        { index: 3, spec: "flows/gamma.yml" },
      ],
      status: "running",
      startedAt: "2026-10-02T09:00:00.000Z",
      current: { index: 2, spec: "flows/beta.yml", runId: LIVE_RUN_B },
      runs: [
        {
          index: 1,
          spec: "flows/alpha.yml",
          runId: LIVE_RUN_A,
          runDir: path.join(runsRoot, LIVE_RUN_A),
          status: "passed",
        },
        {
          index: 2,
          spec: "flows/beta.yml",
          runId: LIVE_RUN_B,
          runDir: path.join(runsRoot, LIVE_RUN_B),
          status: "running",
        },
      ],
    }),
  );
  write(
    live,
    "events.ndjson",
    `${env
      .readEvents("invocation-events.ndjson")
      .filter((event) => event.type !== "invocation.finished")
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );
  write(live, "logs/narration.log", "[09:00:00] starting 3 specs\n");
  write(
    live,
    "logs/services-docker.log",
    "docker compose up -d\ncontainer db healthy\n",
  );
  write(live, "logs/hook-before-01.log", "cache warm\n");

  // A finished CLI invocation that failed.
  write(
    path.join(runsRoot, "_invocations", DONE_INVOCATION),
    "invocation.json",
    JSON.stringify({
      version: 1,
      invocationId: DONE_INVOCATION,
      pid: 4242,
      origin: "cli",
      argv: ["run", "flows/xray.yml", "flows/yankee.yml"],
      cwd: "/tmp/project",
      parallel: 1,
      planned: [
        { index: 1, spec: "flows/xray.yml" },
        { index: 2, spec: "flows/yankee.yml" },
      ],
      status: "failed",
      startedAt: "2026-10-01T08:00:00.000Z",
      endedAt: "2026-10-01T08:02:00.000Z",
      runs: [
        {
          index: 1,
          spec: "flows/xray.yml",
          runId: "2026-10-01T08-00-01-000Z_xray_444444",
          runDir: "x",
          status: "passed",
        },
        {
          index: 2,
          spec: "flows/yankee.yml",
          runId: DONE_RUN_Y,
          runDir: "y",
          status: "failed",
        },
      ],
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        errored: 0,
        durationMs: 120000,
        exitCode: 1,
      },
    }),
  );
});

/**
 * Bridge handlers backed by the real lib readers over `runsRoot`.
 * @param {Record<string, (...args: any[]) => any>} [extra]
 */
function libBridge(extra = {}) {
  const journalDir = (/** @type {any} */ options) => {
    const dir = invocations.invocationDir(
      runsRoot,
      String(options?.invocationId ?? ""),
    );
    if (!dir) throw new Error("invalid invocation id");
    return dir;
  };
  return env.installBridge({
    "runs:list": () => ({
      runsRoot,
      source: "settings",
      exists: true,
      runs: runs.listRuns(runsRoot),
      specNames: runs.listRunSpecs(runsRoot),
      labels: runs.listRunLabels(runsRoot),
    }),
    "invocations:list": () => ({
      runsRoot,
      invocations: invocations.listInvocations(runsRoot).map((journal) => ({
        ...journal,
        eta: invocations.estimateInvocationEta(journal, {}),
      })),
    }),
    "invocation:get": (/** @type {any} */ options) =>
      invocations.readInvocation(runsRoot, String(options?.invocationId)),
    "invocation:events": (/** @type {any} */ options) =>
      runs.readEventsFrom(journalDir(options), Number(options?.offset ?? 0)),
    "invocation:tail-text": (/** @type {any} */ options) =>
      runs.readTextFrom(
        journalDir(options),
        String(options?.path ?? ""),
        Number(options?.offset ?? 0),
      ),
    "run:tail-text": (/** @type {any} */ options) =>
      runs.readTextFrom(
        String(options?.runDir),
        String(options?.path ?? ""),
        Number(options?.offset ?? 0),
      ),
    "run:media-url": () => {
      throw new Error("no media in tests");
    },
    "run:artifact-image": () => ({ ok: false, error: "no images in tests" }),
    ...extra,
  });
}

// ── Runs ───────────────────────────────────────────────────────────────────

describe("Runs view", () => {
  it("shows the labels column, keyboard-navigable rows, and invocation groups", async () => {
    configuredState();
    Studio.state.filters.groupByInvocation = false;
    libBridge();
    const root = mountPoint();
    await Studio.views.runs.render(root);

    assert.ok(all(root, "th").map(text).includes("labels"));
    const rows = all(root, "tr.run-row");
    assert.equal(rows.length, 2);
    const labels = all(root, ".cell-labels .label-tag").map(text);
    assert.deepEqual(labels.toSorted(), ["round=2", "variant=b"]);
    assert.ok(root.querySelector("time.rel-time"), "relative start times");
    assert.ok(!root.querySelector(".setup-notice"), "no setup notice");

    // One Tab stop; arrows move focus; Enter opens the focused run.
    assert.equal(
      rows.filter((row) => row.getAttribute("tabindex") === "0").length,
      1,
    );
    rows[0].focus();
    env.press(rows[0], "ArrowDown");
    assert.ok(document.activeElement === rows[1], "focus moved to rows[1]");
    assert.equal(rows[1].getAttribute("tabindex"), "0");
    const nav = recordNavigation();
    env.press(rows[1], "Enter");
    nav.off();
    assert.equal(nav.seen[0]?.view, "run");
    assert.equal(nav.seen[0]?.params.runRef, rows[1].dataset.runId);

    // Group by invocation: one group per invocation id, the rest last.
    const toggle =
      /** @type {HTMLInputElement} */ (root.querySelector("label.check input"));
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event("change"));
    const groups = all(root, "tr.group-row");
    assert.equal(groups.length, 2);
    assert.match(text(groups[0]), new RegExp(`invocation ${HOOK_INVOCATION}`));
    assert.match(text(groups[0]), /1\/4 run/);
    const open = groups[0].querySelector("button.group-open");
    assert.ok(open, "an invocation group links to the Invocations view");
    const jump = recordNavigation();
    /** @type {HTMLElement} */ (open).click();
    jump.off();
    assert.deepEqual(jump.seen[0], {
      view: "invocations",
      params: { invocationId: HOOK_INVOCATION },
    });
    assert.match(text(groups[1]), /no invocation recorded/);
    Studio.state.filters.groupByInvocation = false;
  });

  it("explains what to do when there are no runs", async () => {
    configuredState();
    env.installBridge({
      "runs:list": () => ({
        runsRoot: "/tmp/empty-runs",
        source: "default",
        exists: false,
        runs: [],
        specNames: [],
        labels: [],
      }),
    });
    const root = mountPoint();
    await Studio.views.runs.render(root);
    const empty = root.querySelector(".empty");
    assert.match(text(empty), /No runs yet/);
    assert.match(text(empty), /\/tmp\/empty-runs/);
    assert.deepEqual(
      all(/** @type {HTMLElement} */ (empty), "button").map(text),
      ["Open Specs", "Live"],
    );

    Studio.state.filters.status = "failed";
    await Studio.views.runs.render(root);
    assert.match(text(root.querySelector(".empty")), /No runs match/);
    const nav = recordNavigation();
    /** @type {HTMLElement} */ (
      all(root, ".empty button").find((b) => text(b) === "Clear filters")
    ).click();
    nav.off();
    assert.equal(Studio.state.filters.status, "");
    assert.equal(nav.seen[0]?.view, "runs");
  });
});

// ── Run detail ─────────────────────────────────────────────────────────────

describe("Run detail view", () => {
  it("opens a failed run on the failure panel and shows its hooks", async () => {
    configuredState();
    const journalDir = path.join(runsRoot, "_invocations", HOOK_INVOCATION);
    libBridge({
      "run:detail": () => runs.readRunDetail(hookRunDir),
      "runs:history": (/** @type {any} */ options) =>
        runs.runHistory(runsRoot, String(options?.spec ?? ""), { limit: 20 }),
      "run:artifact-text": (/** @type {any} */ options) =>
        runs.readBoundedText(hookRunDir, String(options?.path ?? ""), 400_000),
      "run:journal-text": (/** @type {any} */ options) =>
        runs.readBoundedText(journalDir, String(options?.path ?? ""), 400_000),
      "fs:exists": () => true,
    });
    const root = mountPoint();
    await Studio.views.run.render(root, {
      runRef: hookRunDir,
      from: "invocations",
      invocationId: HOOK_INVOCATION,
    });

    const tablist = root.querySelector('[role="tablist"]');
    assert.ok(tablist, "tabs are an ARIA tablist");
    const selected = root.querySelector('[role="tab"][aria-selected="true"]');
    assert.equal(text(selected), "Failure");
    await env.waitFor(
      () => root.querySelector("#tab-host .error-box"),
      "the failure panel",
    );
    assert.match(text(root.querySelector("#tab-host .error-box")), /failed/);
    const tabs = all(root, '[role="tab"]').map((tab) => tab.dataset.tab);
    assert.ok(tabs.includes("hooks"), `hooks tab in ${tabs.join(",")}`);
    // Opened from an invocation's plan: "back" returns there.
    assert.ok(
      all(root, ".detail-actions button").some(
        (button) => text(button) === "← Invocation",
      ),
    );

    // Arrow keys move between tabs and select them.
    const failureTab = /** @type {HTMLElement} */ (selected);
    failureTab.focus();
    env.press(failureTab, "ArrowRight");
    await env.settle();
    assert.equal(
      root
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-tab"),
      tabs[1],
    );

    /** @type {HTMLElement} */ (
      root.querySelector('[data-tab="hooks"]')
    ).click();
    await env.waitFor(
      () => /collecting metrics/.test(text(root.querySelector("#tab-host"))),
      "the after hook's log from the invocation journal",
    );
    const hookTitles = all(root, "#tab-host .outcome-id").map(text);
    assert.ok(hookTitles.some((title) => /after hook #1/.test(title)));
    assert.ok(hookTitles.some((title) => /before hook #1/.test(title)));
  });
});

// ── Live ───────────────────────────────────────────────────────────────────

describe("Live view", () => {
  it("groups a detected run under its invocation with origin, phase, steps, and log tails", async () => {
    configuredState();
    libBridge();
    const journal = invocations.readInvocation(runsRoot, LIVE_INVOCATION);
    assert.ok(journal?.alive, "fixture journal is running");
    Studio.syncInvocations([
      { ...journal, eta: invocations.estimateInvocationEta(journal, {}) },
    ]);
    Studio.applyInvocationEvents(
      LIVE_INVOCATION,
      env
        .readEvents("invocation-events.ndjson")
        .filter((event) => event.type !== "invocation.finished"),
    );
    const runDir = path.join(runsRoot, LIVE_RUN_B);
    fs.mkdirSync(runDir, { recursive: true });
    write(runDir, "run.log", "[09:00:31] open https://demo.example.test\n");
    Studio.syncDetected([
      {
        runId: LIVE_RUN_B,
        runDir,
        spec: "beta",
        startedAtMs: Date.now() - 5000,
        lastActivityMs: Date.now(),
        liveness: { state: "running", reason: "heartbeat" },
        invocation: { id: LIVE_INVOCATION, index: 2, total: 3 },
      },
    ]);
    // The step-fail golden minus its terminal event: a run mid-flight.
    Studio.applyExternalEvents(
      LIVE_RUN_B,
      env
        .readEvents("step-fail.ndjson", { golden: true, runId: LIVE_RUN_B })
        .filter((event) => event.type !== "run.failed"),
    );

    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      const group = root.querySelector(".live-group");
      assert.ok(group, "an invocation group");
      assert.match(
        text(group?.querySelector(".origin-tag")),
        /MCP agent · an-agent/,
      );
      assert.match(text(group?.querySelector(".group-head")), /spec 2\/3/);
      const card = group?.querySelector(".group-members .live-card");
      assert.ok(card, "the run card sits inside its invocation group");

      // Phase banners: always present (no layout jump), showing the phase.
      const cardBanner = card?.querySelector(".phase-banner");
      assert.ok(cardBanner && !cardBanner.classList.contains("hidden"));
      assert.match(text(cardBanner), /outcome/);
      const groupBanner = group?.querySelector(":scope > .phase-banner");
      assert.match(text(groupBanner), /step/);
      // Only the phase/item part may be cut short: the elapsed time sits in
      // its own part, and the whole line is the tooltip.
      for (const banner of [cardBanner, groupBanner]) {
        const head = text(banner?.querySelector(".phase-head"));
        const detail = text(banner?.querySelector(".phase-detail"));
        assert.ok(head, "a phase head");
        assert.match(detail, /^ · \S/, "elapsed time in the detail part");
        assert.equal(banner?.getAttribute("title"), head + detail);
      }

      // Step rows with position and the inline error.
      const steps = all(/** @type {HTMLElement} */ (card), ".step-live");
      assert.equal(steps.length, 2);
      assert.match(text(steps[1]), /2\/3/);
      assert.ok(steps[1].querySelector(".inline-error"));
      // The screenshot frame is reserved before any screenshot loads.
      assert.ok(card?.querySelector(".live-shot .shot-frame .shot-empty"));

      // Log tails: the group's services log and the run's narration log.
      await Studio.live.flush();
      await env.waitFor(
        () =>
          /docker compose up -d/.test(text(group)) &&
          /open https:\/\/demo\.example\.test/.test(text(card)),
        "the tailed logs",
      );
      const tabs = all(
        /** @type {HTMLElement} */ (group),
        ':scope > .group-body [role="tab"]',
      ).map(text);
      assert.ok(tabs.includes("services docker"), tabs.join(","));
      assert.ok(
        all(/** @type {HTMLElement} */ (group), '[role="log"]').length >= 2,
      );

      // "Details" opens the invocation in the Invocations view.
      const details = /** @type {HTMLElement | null} */ (
        group?.querySelector(".group-details") ?? null
      );
      assert.ok(details, "a Details button in the group head");
      const nav = recordNavigation();
      details.click();
      nav.off();
      assert.deepEqual(nav.seen[0], {
        view: "invocations",
        params: { invocationId: LIVE_INVOCATION },
      });
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.detected.clear();
      Studio.state.invocations.clear();
    }
  });

  it("shows an actionable empty state when nothing runs", () => {
    configuredState();
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      const empty = root.querySelector(".empty");
      assert.match(text(empty), /Nothing running/);
      assert.deepEqual(
        all(/** @type {HTMLElement} */ (empty), "button").map(text),
        ["Open Specs", "Invocations"],
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

// ── Invocations ────────────────────────────────────────────────────────────

describe("Invocations view", () => {
  it("lists journals newest first and details the running one", async () => {
    configuredState();
    /** @type {any[]} */
    const stops = [];
    libBridge({
      "invocation:stop": (/** @type {any} */ options) => {
        stops.push(options);
        return { stopped: true, pid: process.pid, signal: "SIGINT" };
      },
      "fs:reveal": () => null,
    });
    Studio.state.view = "invocations";
    const root = mountPoint();
    const handle = await Studio.views.invocations.render(root, {});
    try {
      const items = all(root, '.inv-list [role="option"]');
      // The hook fixture journal has no invocation.json, so it is not listed.
      assert.equal(items.length, 2);
      assert.equal(items[0].dataset.id, LIVE_INVOCATION);
      assert.equal(items[0].getAttribute("aria-selected"), "true");
      assert.match(text(items[0]), /MCP agent · an-agent/);
      assert.match(text(items[0]), /1\/3/);
      const done = items.find((item) => item.dataset.id === DONE_INVOCATION);
      assert.match(text(done), /CLI/);
      assert.match(text(done), /failed/);

      const detail =
        /** @type {HTMLElement} */ (root.querySelector(".inv-detail"));
      const stop = /** @type {HTMLElement} */ (
        all(detail, "button").find((button) => text(button) === "Stop")
      );
      assert.ok(stop && !stop.classList.contains("hidden"), "Stop offered");
      const plan = all(detail, ".inv-plan .planned-item");
      assert.deepEqual(
        plan.map((row) => text(row.querySelector(".planned-status"))),
        ["passed", "running", "pending"],
      );
      assert.equal(
        all(detail, ".inv-plan button").filter((b) => text(b) === "Open run")
          .length,
        2,
      );

      // Phase from the journal's heartbeat; tails of the journal logs.
      await env.waitFor(
        () => /step/.test(text(detail.querySelector(".phase-banner"))),
        "the phase banner",
      );
      await env.waitFor(
        () => /docker compose up -d/.test(text(detail)),
        "the services log tail",
      );
      const tabs = all(detail, '[role="tab"]').map(text);
      assert.deepEqual(tabs.slice(0, 3), [
        "narration",
        "services docker",
        "before hook #1",
      ]);
      assert.equal(tabs.at(-1), "events");
      assert.match(text(detail), /starting 3 specs/);

      // Open run → Run detail, remembering where to come back to.
      const nav = recordNavigation();
      /** @type {HTMLElement} */ (
        all(detail, ".inv-plan button").find((b) => text(b) === "Open run")
      ).click();
      nav.off();
      assert.deepEqual(nav.seen[0], {
        view: "run",
        params: {
          runRef: LIVE_RUN_A,
          from: "invocations",
          invocationId: LIVE_INVOCATION,
        },
      });

      // Stop: the request goes to main (which confirms natively).
      stop.click();
      await env.waitFor(() => stops.length === 1, "the stop request");
      assert.deepEqual(stops[0], { invocationId: LIVE_INVOCATION });
      await env.waitFor(
        () => /SIGINT sent/.test(text(document.getElementById("toasts"))),
        "the SIGINT toast",
      );

      // Arrow keys move the selection; a finished one has no Stop.
      items[0].focus();
      env.press(items[0], "ArrowDown");
      const second = all(root, '.inv-list [role="option"]')[1];
      assert.equal(second.getAttribute("aria-selected"), "true");
      assert.ok(document.activeElement === second, "focus moved to second");
      const next =
        /** @type {HTMLElement} */ (root.querySelector(".inv-detail"));
      assert.equal(
        all(next, "button")
          .find((b) => text(b) === "Stop")
          ?.classList.contains("hidden"),
        true,
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("shows the finished invocation's result and plan without Stop", async () => {
    configuredState();
    libBridge();
    // Rendered as the current view, as app.js mounts it.
    Studio.state.view = "invocations";
    const root = mountPoint();
    const handle = await Studio.views.invocations.render(root, {
      invocationId: DONE_INVOCATION,
    });
    try {
      const detail =
        /** @type {HTMLElement} */ (root.querySelector(".inv-detail"));
      assert.match(text(detail), /1 passed · 1 failed · 0 errored of 2/);
      assert.match(text(detail.querySelector(".phase-banner")), /finished/);
      assert.deepEqual(all(detail, ".inv-plan .planned-status").map(text), [
        "passed",
        "failed",
      ]);
      assert.equal(
        all(detail, "button")
          .find((b) => text(b) === "Stop")
          ?.classList.contains("hidden"),
        true,
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("explains what invocations are when there are none", async () => {
    configuredState();
    env.installBridge({
      "invocations:list": () => ({ runsRoot: "/tmp/none", invocations: [] }),
    });
    Studio.state.view = "invocations";
    const root = mountPoint();
    const handle = await Studio.views.invocations.render(root, {});
    try {
      assert.match(text(root.querySelector(".empty")), /No invocations yet/);
      assert.match(text(root.querySelector(".empty")), /_invocations/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

// ── Stashes ────────────────────────────────────────────────────────────────

describe("Stashes view", () => {
  it("lists stashes with their CLI line, tags, and restore actions", async () => {
    configuredState();
    env.installBridge({
      "stash:list": () => ({
        ok: true,
        exitCode: 0,
        cli: "cairn stash list --tool cairntrace --format json",
        payload: {
          stashes: [
            {
              id: "stash_7f3a9c",
              name: "checkout failed",
              tags: ["cairntrace", "env:local"],
              fileCount: 12,
              sizeBytes: 34567,
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
              expiresAt: null,
            },
          ],
        },
      }),
    });
    const root = mountPoint();
    await Studio.views.stashes.render(root);
    assert.match(text(root), /cairn stash list --tool cairntrace/);
    const rows = all(root, "table.grid tbody tr");
    assert.equal(rows.length, 1);
    assert.match(text(rows[0]), /stash_7f3a9c/);
    assert.deepEqual(all(rows[0], ".label-tag").map(text), [
      "cairntrace",
      "env:local",
    ]);
    assert.ok(all(rows[0], "button").some((b) => text(b) === "Restore & open"));
  });

  it("says how stashes are made when there are none", async () => {
    configuredState();
    env.installBridge({
      "stash:list": () => ({
        ok: true,
        exitCode: 0,
        cli: "cairn stash list --format json",
        payload: { stashes: [] },
      }),
    });
    const root = mountPoint();
    await Studio.views.stashes.render(root);
    assert.match(text(root.querySelector(".empty")), /cairn stash save/);
  });
});

// ── Settings ───────────────────────────────────────────────────────────────

describe("Settings view", () => {
  it("renders every settings panel from the stored settings", async () => {
    configuredState();
    Studio.state.settings = {
      activeProject: "/tmp/project",
      cairnBin: null,
      artifactRoot: null,
      run: { backend: null, env: null, parallel: 1, vars: [], labels: [] },
      ui: { density: "comfortable", screenshotMaxWidth: 720 },
      projects: [{ path: "/tmp/project" }],
    };
    env.installBridge({
      "project:locks": () => ({
        launchTemplate: null,
        lockFiles: [],
        active: [],
      }),
    });
    const root = mountPoint();
    await Studio.views.settings.render(root);
    await env.settle();
    const titles = all(root, ".panel-title").map(text);
    for (const title of [
      "cairn binary",
      "artifact root",
      "interface",
      "recent projects",
    ])
      assert.ok(titles.includes(title), `${title} in ${titles.join(", ")}`);
    assert.match(text(root), /\/usr\/local\/bin\/cairn/);
  });
});

// ── shared pieces ──────────────────────────────────────────────────────────

describe("shared renderer pieces", () => {
  it("shows the setup notice when cairn or the project is missing", () => {
    Studio.state.booted = true;
    Studio.state.info = { cairn: { command: null } };
    Studio.state.settings = { activeProject: null };
    Studio.state.project = { dir: "/tmp/home", configPath: null, specs: [] };
    const notice = Studio.setupNotice();
    assert.ok(notice);
    assert.match(text(notice), /cairn binary not found/);
    assert.match(text(notice), /No project open/);
    configuredState();
    assert.equal(Studio.setupNotice(), null);
  });

  it("keeps every relative time on one clock", () => {
    const root = mountPoint();
    const at = Date.now() - 5 * 60_000;
    root.appendChild(Studio.relTime(at, { prefix: "started " }));
    const node = /** @type {HTMLElement} */ (root.querySelector("time"));
    assert.equal(text(node), "started 5m ago");
    assert.equal(node.getAttribute("datetime"), new Date(at).toISOString());
    Studio.refreshRelativeTimes(root, at + 2 * 3_600_000);
    assert.equal(text(node), "started 2h ago");
  });

  it("labels origins and journal logs for people", () => {
    assert.equal(text(Studio.originBadge({ origin: "cli" })), "CLI");
    assert.equal(
      text(Studio.originBadge({ origin: "mcp", client: "an-agent" })),
      "MCP agent · an-agent",
    );
    assert.equal(
      text(Studio.originBadge({ origin: "cli" }, { fromApp: true })),
      "Studio",
    );
    assert.equal(Studio.originBadge({}), null);
    const { logLabel, plannedRows } = Studio.invocationsView;
    assert.equal(logLabel("logs/narration.log"), "narration");
    assert.equal(logLabel("logs/services-seed.log"), "services seed");
    assert.equal(logLabel("logs/hook-before-02.log"), "before hook #2");
    assert.equal(
      logLabel(`logs/hook-after-01-${HOOK_RUN}.log`),
      "after hook #1 · orders_flow",
    );
    assert.deepEqual(
      plannedRows({
        status: "aborted",
        planned: [
          { index: 1, spec: "a" },
          { index: 2, spec: "b" },
          { index: 3, spec: "c" },
        ],
        current: { index: 2, spec: "b", runId: "r2" },
        runs: [
          { index: 1, runId: "r1", status: "passed" },
          { index: 2, runId: "r2", status: "running" },
        ],
      }).map((row) => row.status),
      ["passed", "interrupted", "not run"],
    );
  });
});

// ── Cohorts ────────────────────────────────────────────────────────────────

describe("Cohorts view", () => {
  it("renders the cohort table, the baseline deltas, and the run list", async () => {
    configuredState();
    env.installBridge({
      "runs:labels": () => [{ key: "variant", count: 4, values: ["a", "b"] }],
      "stats:get": () => ({
        ok: true,
        exitCode: 0,
        payload: {
          scanned: 4,
          matched: 4,
          groupBy: "variant",
          artifactRoot: "/tmp/runs",
          groups: [
            {
              key: "a",
              runs: 2,
              passRate: 1,
              failed: 0,
              errored: 0,
              duration: { p50: 1000, p95: 1200 },
            },
            {
              key: "b",
              runs: 2,
              passRate: 0.5,
              failed: 1,
              errored: 0,
              duration: { p50: 1500, p95: 2000 },
            },
          ],
          deltas: [
            {
              baseline: "a",
              against: "b",
              passRateDelta: -0.5,
              durationP50Ratio: 1.5,
              durationP95Ratio: 1.67,
              metricP50Ratio: null,
            },
          ],
          runs: [
            {
              runId: "2026-10-01T10-00-00-000Z_landing_aaaaaa",
              specName: "landing",
              status: "failed",
              durationMs: 1500,
            },
          ],
        },
      }),
    });
    const root = mountPoint();
    Studio.views.stats.render(root);
    /** @type {HTMLElement} */ (
      all(root, "button").find((button) => text(button) === "Aggregate")
    ).click();
    await env.waitFor(
      () => /Deltas vs baseline/.test(text(root)),
      "the deltas section",
    );
    // Regression: the deltas table and the run list used to be dropped by
    // appendChild(title, table) (appendChild takes one node).
    const tables = all(root, "table.grid");
    assert.equal(tables.length, 2, "cohort table + deltas table");
    assert.match(text(tables[1]), /-0\.5.*1\.5×/);
    assert.match(text(root), /Runs \(1\)/);
    assert.ok(all(root, ".list-row").some((row) => /landing/.test(text(row))));
  });
});

// ── Specs ──────────────────────────────────────────────────────────────────

describe("Specs view", () => {
  it("lists specs as a keyboard listbox and opens the chosen one", async () => {
    configuredState();
    Studio.state.selectedSpec = null;
    const specs = ["checkout", "landing", "profile"].map((name, index) => ({
      path: `/tmp/project/flows/${name}.yml`,
      rel: `flows/${name}.yml`,
      name,
      mtimeMs: Date.now() - (index + 1) * 60_000,
      summary: { name, intent: `${name} works`, outcomes: [{}], steps: [{}] },
    }));
    /** @type {string[]} */
    const opened = [];
    env.installBridge({
      "specs:list": () => specs,
      "spec:read": (/** @type {string} */ file) => {
        opened.push(file);
        return {
          path: file,
          text: "intent: x\nsteps:\n  - open: /\noutcomes: []\n",
          summary: { name: "x", outcomes: [], steps: [{}] },
          bytes: 40,
        };
      },
    });
    const root = mountPoint();
    const handle = await Studio.views.specs.render(root, {});
    try {
      const list = root.querySelector('[role="listbox"]');
      assert.ok(list, "the spec list is a listbox");
      const items = all(root, '[role="option"]');
      assert.equal(items.length, 3);
      assert.equal(items[0].getAttribute("aria-selected"), "true");
      assert.equal(items[0].getAttribute("tabindex"), "0");
      assert.ok(items[0].querySelector("time.rel-time"));

      items[0].focus();
      env.press(items[0], "ArrowDown");
      env.press(items[1], "ArrowDown");
      assert.ok(document.activeElement === items[2], "arrows move focus");
      env.press(items[2], "Enter");
      await env.waitFor(
        () => opened.includes("/tmp/project/flows/profile.yml"),
        "the spec read for the activated item",
      );
      const selected = root.querySelector(
        '[role="option"][aria-selected="true"]',
      );
      assert.equal(
        /** @type {HTMLElement} */ (selected).dataset.path,
        "/tmp/project/flows/profile.yml",
      );
      assert.ok(document.activeElement === selected, "focus follows the pick");
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});
