/**
 * The whole renderer shell booted in a DOM (happy-dom) against a stub
 * bridge: a first-run machine with no cairn binary and no project. Boot must
 * still report ready (the --smoke contract), every view must register, the
 * nav must be keyboard-navigable, and the empty states must say what to do.
 */
const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");

const env = require("./dom-env");

/** @type {Array<[string, ...any[]]>} */
let calls = [];
/** How long `invocations:list` takes to answer (a slow artifact root). */
let listDelayMs = 0;

before(() => {
  calls = env.installBridge({
    "app:info": () => ({
      appVersion: "0.0.0-test",
      userData: "/tmp/studio-test",
      cairn: { command: null, source: "none", candidates: ["cairn"] },
      settings: { activeProject: null, projects: [], run: {}, ui: {} },
      runsRoot: { runsRoot: "/tmp/no-runs", source: "default" },
    }),
    "project:inspect": () => ({
      dir: "/tmp/home",
      configPath: null,
      config: {},
      specs: [],
      specNames: [],
      runsRoot: { runsRoot: "/tmp/no-runs", source: "default" },
      launch: { launchTemplate: null, lockFiles: [] },
    }),
    "runs:list": () => ({
      runsRoot: "/tmp/no-runs",
      source: "default",
      exists: false,
      runs: [],
      specNames: [],
      labels: [],
    }),
    "runs:detected": () => [],
    "project:locks": () => ({
      launchTemplate: null,
      lockFiles: [],
      active: [],
    }),
    "cairn:versions": () => ({
      resolved: { command: null, source: "none", version: null },
      path: null,
      repo: null,
      mismatch: false,
      warning: null,
    }),
    // The Environment view's slow probe (it spawns `cairn doctor`).
    "cairn:doctor": async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { ok: true, checks: [] };
    },
    "invocations:list": async () => {
      if (listDelayMs)
        await new Promise((resolve) => setTimeout(resolve, listDelayMs));
      return { runsRoot: "/tmp/no-runs", invocations: [] };
    },
  });
  env.installDom({ app: true });
});

after(() => env.teardown());

/** @param {Element | null | undefined} node */
const text = (node) => node?.textContent ?? "";

describe("app shell", () => {
  it("boots ready with every view registered, even without cairn or a project", async () => {
    const g = /** @type {any} */ (globalThis);
    await env.waitFor(() => g.studioSmoke, "the smoke-ready report");
    assert.equal(g.studioSmoke.ok, true, g.studioSmoke.reason);
    assert.deepEqual(g.studioSmoke.checks.missingViews, []);
    assert.ok(g.studioSmoke.checks.views.includes("invocations"));
    assert.ok(g.studioSmoke.checks.views.includes("sessions"));
    assert.ok(g.studioSmoke.checks.views.includes("catalog"));
    assert.equal(g.studioSmoke.checks.userData, "/tmp/studio-test");
    assert.ok(!calls.some(([channel]) => channel === "projects:open-recent"));
  });

  it("tells a first-run user what to do next", () => {
    const view = document.getElementById("view");
    const notice = view?.querySelector(".setup-notice");
    assert.match(text(notice), /cairn binary not found/);
    assert.match(text(notice), /No project open/);
    assert.match(text(view?.querySelector(".empty")), /No runs yet/);
    assert.equal(
      text(document.getElementById("cairn-status")),
      "cairn not found",
    );
  });

  it("marks the current view and moves through the nav with the arrow keys", async () => {
    const items = [
      ...document.querySelectorAll("#sidebar button.nav-item[data-view]"),
    ];
    assert.equal(items.length, 13);
    const current = items.filter((item) => item.getAttribute("aria-current"));
    assert.deepEqual(
      current.map((item) => /** @type {HTMLElement} */ (item).dataset.view),
      ["runs"],
    );
    for (const glyph of document.querySelectorAll("#sidebar .nav-glyph"))
      assert.equal(glyph.getAttribute("aria-hidden"), "true");

    /** @type {HTMLElement} */ (items[0]).focus();
    env.press(items[0], "ArrowDown");
    assert.ok(document.activeElement === items[1], "focus moved to items[1]");
    // End reaches the last nav button: the project switcher below the views.
    env.press(items[1], "End");
    const last = [...document.querySelectorAll("#sidebar button.nav-item")].at(
      -1,
    );
    assert.ok(
      document.activeElement === last,
      "End moves to the last nav item",
    );

    // The nav survives repaints: focus stays on the same node.
    const invocations = /** @type {HTMLElement} */ (
      items.find(
        (item) =>
          /** @type {HTMLElement} */ (item).dataset.view === "invocations",
      )
    );
    invocations.focus();
    invocations.click();
    await env.waitFor(
      () => /No invocations yet/.test(text(document.getElementById("view"))),
      "the Invocations empty state",
    );
    assert.ok(
      document.activeElement === invocations,
      "focus moved to invocations",
    );
    assert.equal(invocations.getAttribute("aria-current"), "page");
  });

  it("starts no pollers for a view the user left while it was loading", async () => {
    const g = /** @type {any} */ (globalThis);
    g.Studio.navigate("runs");
    await env.waitFor(
      () => /No runs yet/.test(text(document.getElementById("view"))),
      "the Runs view",
    );
    await env.settle();
    const baseline = env.activeIntervals();
    const listCalls = () =>
      calls.filter(([channel]) => channel === "invocations:list").length;
    const firstList = listCalls();
    listDelayMs = 150;
    try {
      g.Studio.navigate("invocations");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(listCalls(), firstList + 1, "Invocations started loading");
      g.Studio.navigate("runs");
      // Long enough for the slow list to answer and the late render to end.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await env.settle();
    } finally {
      listDelayMs = 0;
    }
    assert.equal(g.Studio.state.view, "runs");
    assert.match(text(document.getElementById("view")), /No runs yet/);
    assert.equal(
      env.activeIntervals(),
      baseline,
      "the abandoned Invocations render left its pollers running",
    );
    // No list poll either (the list poller runs every 2.5s).
    const seen = listCalls();
    await new Promise((resolve) => setTimeout(resolve, 2700));
    assert.equal(listCalls(), seen, "no invocations:list poll after leaving");
  });

  it("never lets a late render paint over the view on screen", async () => {
    const g = /** @type {any} */ (globalThis);
    g.Studio.navigate("doctor");
    await new Promise((resolve) => setTimeout(resolve, 20));
    g.Studio.navigate("runs");
    await env.waitFor(
      () => /No runs yet/.test(text(document.getElementById("view"))),
      "the Runs view",
    );
    // The doctor probe answers after the user left Environment.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await env.settle();
    assert.equal(g.Studio.state.view, "runs");
    const view = text(document.getElementById("view"));
    assert.match(view, /No runs yet/);
    assert.doesNotMatch(view, /Environment/);
  });

  it("keeps the newer render when the user leaves and comes back mid-load", async () => {
    const g = /** @type {any} */ (globalThis);
    const baseline = env.activeIntervals();
    listDelayMs = 150;
    try {
      g.Studio.navigate("invocations");
      await new Promise((resolve) => setTimeout(resolve, 20));
      g.Studio.navigate("runs");
      await new Promise((resolve) => setTimeout(resolve, 20));
      g.Studio.navigate("invocations");
      // Both slow lists answer; the first render's late handle must not
      // tear down the second one.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await env.settle();
    } finally {
      listDelayMs = 0;
    }
    assert.equal(g.Studio.state.view, "invocations");
    assert.match(
      text(document.getElementById("view")),
      /No invocations yet/,
      "the Invocations view on screen painted its list",
    );
    // List poller, detail poller and clock of exactly one render.
    assert.equal(env.activeIntervals(), baseline + 3);
    g.Studio.navigate("runs");
    await env.settle();
    assert.equal(env.activeIntervals(), baseline);
  });
});

describe("app shell: refused runs and ⌘R", () => {
  it("never adopts the synthetic refused_… run id of a refused Studio run", async () => {
    const g = /** @type {any} */ (globalThis);
    const token = "tok-app-refused";
    g.cairn.push("run:started", {
      token,
      specs: ["/tmp/home/flows/refused.yml"],
      argv: ["run", "/tmp/home/flows/refused.yml", "--format", "json"],
      command: "cairn",
      launcher: "cairn",
      cwd: "/tmp/home",
      runsRoot: "/tmp/no-runs",
      startedAt: new Date().toISOString(),
    });
    // What main forwards for `cairn run refused.yml --format json` (exit 7):
    // the tail found no run directory, and the document's runId/runDir name
    // nothing on disk.
    g.cairn.push("run:done", {
      token,
      kind: "run",
      ok: false,
      exitCode: 7,
      meaning: "refused by environment policy",
      timedOut: false,
      runDir: null,
      stderr: "",
      payload: {
        $schema: "urn:cairntrace.dev:run:v1",
        runId: "refused_1790934496527_gtewiz",
        runDir: "/tmp/home/.cairntrace/refused/refused_1790934496527_gtewiz",
        status: "refused",
        refusal: {
          reason:
            'requires.env allows "staging"; the resolved environment is "local"',
          env: "local",
          requires: { env: ["staging"] },
          code: "env-not-listed",
        },
        summary: 'refused: requires.env allows "staging"',
        exitCode: 7,
      },
    });
    const record = g.Studio.state.live.get(token);
    assert.equal(record.runId, null, "no run id that names nothing");
    assert.equal(record.runDir, null);
    assert.match(
      text(document.getElementById("toasts")),
      /Refused · refused\.yml/,
    );
    g.Studio.navigate("live");
    await env.waitFor(
      () =>
        document.querySelector(
          `.live-card[data-key="app:${token}"] .card-actions`,
        )?.childElementCount,
      "the refused card's actions",
    );
    const card = document.querySelector(`.live-card[data-key="app:${token}"]`);
    const labels = [
      ...(card?.querySelectorAll(".card-actions button") ?? []),
    ].map((node) => text(node));
    assert.ok(!labels.includes("Open evidence"), labels.join(","));
    assert.equal(text(card?.querySelector(".panel-head .tag")), "refused");
    g.Studio.state.live.delete(token);
    g.Studio.navigate("runs");
    await env.settle();
  });

  it("never adopts the run id of a synthetic errored document (no run directory)", async () => {
    const g = /** @type {any} */ (globalThis);
    const token = "tok-app-synthetic";
    g.cairn.push("run:started", {
      token,
      specs: ["/tmp/home/flows/broken.yml"],
      argv: ["run", "/tmp/home/flows/broken.yml", "--format", "json"],
      command: "cairn",
      launcher: "cairn",
      cwd: "/tmp/home",
      runsRoot: "/tmp/no-runs",
      startedAt: new Date().toISOString(),
    });
    // `cairn run` on a spec that fails to parse (exit 2): the CLI marks the
    // document `synthetic: true` — its errored_… run id names nothing.
    g.cairn.push("run:done", {
      token,
      kind: "run",
      ok: false,
      exitCode: 2,
      meaning: "errored",
      timedOut: false,
      runDir: null,
      stderr: "",
      payload: {
        $schema: "urn:cairntrace.dev:run:v1",
        runId: "errored_1790934496527_abcdef",
        runDir: "/tmp/home/.cairntrace/errored/errored_1790934496527_abcdef",
        synthetic: true,
        status: "errored",
        summary: "errored at step 'parse': bad yaml",
        exitCode: 2,
      },
    });
    const record = g.Studio.state.live.get(token);
    assert.equal(record.runId, null, "no run id that names nothing");
    g.Studio.state.live.delete(token);
    await env.settle();
  });

  it("reads a Studio run that exited 8 / 9 as errored though its events say passed", async () => {
    const g = /** @type {any} */ (globalThis);
    const cases = [
      // The process exit code (what main forwards for `cairn run`).
      { token: "tok-app-exit8", exitCode: 8, outcome: 8, badge: /exit 8/ },
      // No usable exit code: the printed document's invocationOutcome.
      { token: "tok-app-exit9", exitCode: null, outcome: 9, badge: /exit 9/ },
    ];
    for (const item of cases) {
      g.cairn.push("run:started", {
        token: item.token,
        specs: ["/tmp/home/flows/green.yml"],
        argv: ["run", "/tmp/home/flows/green.yml", "--format", "json"],
        command: "cairn",
        launcher: "cairn",
        cwd: "/tmp/home",
        runsRoot: "/tmp/no-runs",
        startedAt: new Date().toISOString(),
      });
      // The spec itself passed: its events say so.
      g.cairn.push("run:events", {
        token: item.token,
        events: [
          { type: "run.passed", ts: new Date().toISOString(), durationMs: 5 },
        ],
      });
      g.cairn.push("run:done", {
        token: item.token,
        kind: "run",
        ok: false,
        exitCode: item.exitCode,
        meaning: "critical teardown failed",
        timedOut: false,
        runDir: null,
        stderr: "",
        payload: {
          $schema: "urn:cairntrace.dev:run:v1",
          status: "errored",
          exitCode: item.outcome,
          failure: {
            phase: "invocation",
            message: "a critical teardown failed",
          },
          invocationOutcome: {
            exitCode: item.outcome,
            specsExitCode: 0,
            error: "a critical teardown failed",
          },
        },
      });
    }
    g.Studio.navigate("live");
    for (const item of cases) {
      const selector = `.live-card[data-key="app:${item.token}"]`;
      await env.waitFor(
        () => text(document.querySelector(`${selector} .panel-head .tag`)),
        `the ${item.token} card's status`,
      );
      const card = document.querySelector(selector);
      assert.equal(text(card?.querySelector(".panel-head .tag")), "errored");
      const exit = card?.querySelector(".ops-exit");
      assert.ok(exit && !exit.classList.contains("hidden"), "exit badge shown");
      assert.match(text(exit), item.badge);
    }
    for (const item of cases) g.Studio.state.live.delete(item.token);
    g.Studio.navigate("runs");
    await env.settle();
  });

  it("sends ⌘R through the Specs view's Run path", async () => {
    const g = /** @type {any} */ (globalThis);
    const original = g.Studio.specsView;
    /** @type {string[]} */
    const runs = [];
    g.Studio.specsView = {
      runFocused: async () => {
        runs.push(g.Studio.state.selectedSpec);
      },
    };
    const callsBefore = calls.length;
    try {
      g.Studio.state.selectedSpec = "/tmp/home/flows/demo.yml";
      g.cairn.push("menu:run-focused", {});
      await env.settle();
      assert.deepEqual(runs, ["/tmp/home/flows/demo.yml"]);
      assert.ok(
        !calls.slice(callsBefore).some(([channel]) => channel === "run:start"),
        "no run:start that bypasses the picker and the policy warning",
      );
    } finally {
      g.Studio.specsView = original;
      g.Studio.state.selectedSpec = null;
    }
  });
});
