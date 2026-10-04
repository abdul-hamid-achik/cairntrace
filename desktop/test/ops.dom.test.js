/**
 * Wave 6 in a DOM (happy-dom): the Suites view, the Config vars browser, the
 * Environment view's service windows and orphan sessions, Run detail's Run
 * policy and Metrics tabs (with exit 8 / exit 9 styling and the sparkline),
 * and the Live and Invocations views' run-policy panel and bail plan.
 *
 * Payloads come from the same lib/ readers ipc.js uses, so a view renders
 * exactly the shapes main would send; credentials are planted wherever they
 * must never surface.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const env = require("./dom-env");
const { cleanup, makeRun, tempDir, write } = require("./helpers");
const metrics = require("../lib/metrics");
const ops = require("../lib/ops");
const runs = require("../lib/runs");

const { Studio, document } = env.installDom();

after(() => {
  env.teardown();
  cleanup();
});

const SECRET = "hunter2-very-secret";

/** @param {Element | null | undefined} node */
const text = (node) => node?.textContent ?? "";
/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
const all = (root, selector) => [...root.querySelectorAll(selector)];

function mountPoint() {
  const root = /** @type {HTMLElement} */ (document.getElementById("view"));
  Studio.clear(root);
  return root;
}

/** @param {Record<string, any>} [config] */
function configuredState(config = {}) {
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
  Studio.state.locks = null;
  Studio.state.project = {
    dir: "/tmp/project",
    configPath: "/tmp/project/cairntrace.config.yml",
    specs: [],
    config: {
      project: "fixture",
      defaultEnvironment: "local",
      environments: [
        { name: "local", baseUrl: "http://localhost:3000", policy: null },
        { name: "prod", baseUrl: "https://prod.example.test", policy: null },
      ],
      ...config,
    },
  };
}

const NO_LOCKS = {
  launchTemplate: null,
  lockFiles: [],
  locks: [],
  runLock: { configured: false, scopes: [], held: [] },
  active: [],
};

// ── Suites ───────────────────────────────────────────────────────────────────

const SUITES_PAYLOAD = {
  $schema: "urn:cairntrace.dev:suites:v1",
  version: "1",
  project: "fixture",
  root: "/tmp/project",
  suites: [
    {
      name: "smoke",
      description: "fast checks before a deploy",
      parallel: 2,
      bail: true,
      tags: ["smoke"],
      requires: { env: ["local"] },
      envs: [
        {
          env: "local",
          specs: ["flows/a.yml", "flows/b.yml"],
          before: 1,
          after: 1,
          vars: ["PORT"],
        },
        {
          env: "prod",
          specs: [],
          problem: "requires.env rules prod out",
          before: 0,
          after: 0,
        },
      ],
    },
    {
      name: "nightly",
      envs: [{ env: "local", specs: ["flows/c.yml"], before: 0, after: 0 }],
    },
  ],
  warnings: [],
};

/** @param {Array<any>} calls */
function suitesBridge(calls = [], locks = NO_LOCKS) {
  return env.installBridge({
    "project:locks": () => locks,
    "suites:list": () => ({
      ok: true,
      exitCode: 0,
      suites: ops.normalizeSuites(SUITES_PAYLOAD),
      cli: "cairn suites list --json",
    }),
    "run:start": (/** @type {any} */ options) => {
      calls.push(options);
      return { token: "tok-suite", argv: [], command: "cairn", cwd: "/tmp" };
    },
  });
}

describe("Suites view", () => {
  it("lists each suite with its environments, picks the default environment and runs one", async () => {
    configuredState();
    /** @type {any[]} */
    const started = [];
    suitesBridge(started);
    /** @type {any[]} */
    const navigations = [];
    const off = Studio.on("navigate", (payload) => navigations.push(payload));
    try {
      const root = mountPoint();
      await Studio.views.suites.render(root);
      const smoke = /** @type {HTMLElement} */ (
        root.querySelector('.suite-card[data-suite="smoke"]')
      );
      assert.ok(smoke, "the smoke card");
      assert.match(text(smoke), /parallel 2/);
      assert.match(text(smoke), /bail/);
      assert.match(text(smoke), /tags smoke/);
      assert.match(text(smoke), /fast checks before a deploy/);
      const rows = all(smoke, "tr.suite-env");
      assert.equal(rows.length, 2);
      assert.match(
        text(rows[0]),
        /local\s*2\s*1 before \/ 1 after\s*PORT\s*✓ ready/,
      );
      assert.match(
        text(rows[1]),
        /prod.*⚠ cannot run: requires\.env rules prod out/,
      );
      // the default environment (config defaultEnvironment) is the current row
      assert.equal(rows[0].getAttribute("aria-current"), "true");
      assert.equal(rows[1].getAttribute("aria-current"), null);
      assert.match(
        text(smoke.querySelector(".suite-specs")),
        /2 spec\(s\) on local, in run order/,
      );

      const run = /** @type {HTMLButtonElement} */ (
        smoke.querySelector("button[data-run-suite]")
      );
      assert.equal(text(run), "Run on local");
      assert.equal(run.disabled, false);
      run.click();
      await env.waitFor(() => started.length === 1, "run:start");
      assert.deepEqual(started[0], { suite: "smoke", overrides: undefined });
      await env.waitFor(
        () => navigations.some((entry) => entry.view === "live"),
        "navigation to Live",
      );
      assert.match(text(document.getElementById("toasts")), /Suite started/);
    } finally {
      off();
    }
  });

  it("disables Run for an environment the suite cannot run on, and passes a picked one as the env override", async () => {
    configuredState();
    /** @type {any[]} */
    const started = [];
    suitesBridge(started);
    const root = mountPoint();
    await Studio.views.suites.render(root);
    const picker =
      /** @type {HTMLSelectElement} */ (root.querySelector("#suite-env"));
    picker.value = "prod";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    const smoke = /** @type {HTMLElement} */ (
      root.querySelector('.suite-card[data-suite="smoke"]')
    );
    const run = /** @type {HTMLButtonElement} */ (
      smoke.querySelector("button[data-run-suite]")
    );
    assert.equal(text(run), "Run on prod");
    assert.equal(run.disabled, true);
    assert.match(run.title, /cannot run on prod: requires\.env rules prod out/);
    // nightly has no row for prod: it is not blocked by a problem here
    const nightly = /** @type {HTMLButtonElement} */ (
      root.querySelector('[data-suite="nightly"] button[data-run-suite]')
    );
    assert.equal(nightly.disabled, false);
    nightly.click();
    await env.waitFor(() => started.length === 1, "run:start");
    assert.deepEqual(started[0], {
      suite: "nightly",
      overrides: { env: "prod" },
    });
    // the pick survives a re-render
    picker.value = "";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("disables Run, naming the owner, while a run lock or a suite lock is held", async () => {
    configuredState();
    suitesBridge([], {
      ...NO_LOCKS,
      runLock: { configured: true, scopes: ["config"], held: [] },
      active: [
        {
          kind: "run-lock",
          path: "/locks/x.run.lock.json",
          owner: 'pid 4242 (cli, env "local"), running for 5m',
          command: "cairn run flows/other.yml",
        },
      ],
    });
    const root = mountPoint();
    await Studio.views.suites.render(root);
    for (const button of all(root, "button[data-run-suite]")) {
      assert.equal(/** @type {HTMLButtonElement} */ (button).disabled, true);
      assert.match(button.title, /run in progress/);
      assert.match(button.title, /a cairn run holds the run lock: pid 4242/);
    }
  });

  it("disables Run when the project runs through a launch template", async () => {
    configuredState();
    suitesBridge([], { ...NO_LOCKS, launchTemplate: "task run FLOW={spec}" });
    const root = mountPoint();
    await Studio.views.suites.render(root);
    const run = /** @type {HTMLButtonElement} */ (
      root.querySelector("button[data-run-suite]")
    );
    assert.equal(run.disabled, true);
    assert.match(run.title, /launch template/);
  });

  it("degrades when cairn has no suites command, fails, or the config has none", async () => {
    configuredState();
    env.installBridge({
      "project:locks": () => NO_LOCKS,
      "suites:list": () => ({
        ok: false,
        unsupported: true,
        suites: null,
        error: null,
      }),
    });
    let root = mountPoint();
    await Studio.views.suites.render(root);
    assert.match(
      text(root.querySelector(".empty")),
      /This cairn has no suites/,
    );

    env.installBridge({
      "project:locks": () => NO_LOCKS,
      "suites:list": () => ({
        ok: false,
        suites: null,
        error: "invalid cairntrace.config.yml: version",
      }),
    });
    root = mountPoint();
    await Studio.views.suites.render(root);
    assert.match(
      text(root.querySelector(".error-box")),
      /cairn suites list failed/,
    );
    assert.match(
      text(root.querySelector(".error-box")),
      /invalid cairntrace\.config\.yml/,
    );

    env.installBridge({
      "project:locks": () => NO_LOCKS,
      "suites:list": () => ({
        ok: true,
        suites: ops.normalizeSuites({ suites: [], warnings: [] }),
      }),
    });
    root = mountPoint();
    await Studio.views.suites.render(root);
    assert.match(text(root.querySelector(".empty")), /No suites/);

    env.installBridge({
      "project:locks": () => NO_LOCKS,
      "suites:list": () => {
        throw new Error("spawn failed");
      },
    });
    root = mountPoint();
    await Studio.views.suites.render(root);
    assert.match(text(root.querySelector(".error-box")), /spawn failed/);
  });
});

// ── Config vars ──────────────────────────────────────────────────────────────

const VARS_PAYLOAD = {
  $schema: "urn:cairntrace.dev:config-vars:v1",
  version: "1",
  ok: true,
  path: "/tmp/project/cairntrace.config.yml",
  files: ["cairntrace.config.yml", "vars.shared.yml"],
  environments: ["local", "staging"],
  totals: {
    vars: 3,
    unused: 1,
    sameInAllEnvironments: 1,
    differing: 2,
    sameWhereDefined: 0,
  },
  vars: [
    {
      name: "apiUrl",
      kind: "string",
      values: {
        local: {
          value: "http://localhost:3000",
          scope: "vars",
          at: "cairntrace.config.yml:3",
        },
        staging: {
          value: "https://staging.example.test",
          scope: "environments.staging.vars",
          at: "cairntrace.config.yml:11",
          template: "https://${vars.host}",
        },
      },
      definedAt: [
        { scope: "vars", at: "cairntrace.config.yml:3" },
        { scope: "environments.staging.vars", at: "cairntrace.config.yml:11" },
      ],
      overriddenBy: [
        {
          scope: "environments.staging.vars",
          at: "cairntrace.config.yml:11",
          envs: ["staging"],
        },
      ],
      usedBy: [
        { kind: "spec", name: "login", file: "flows/login.yml" },
        { kind: "fixture", name: "seed", file: "cairntrace.config.yml" },
      ],
    },
    {
      name: "dbPassword",
      kind: "string",
      values: {
        local: { value: SECRET, scope: "vars", at: "cairntrace.config.yml:4" },
        staging: {
          value: "••••",
          masked: true,
          scope: "vars",
          at: "cairntrace.config.yml:4",
          template: `\${env.${SECRET}}`,
        },
      },
      definedAt: [{ scope: "vars", at: "cairntrace.config.yml:4" }],
      overriddenBy: [],
      usedBy: [
        { kind: "datasource", name: "app_db", file: "cairntrace.config.yml" },
      ],
    },
    {
      name: "legacyFlag",
      kind: "boolean",
      sameInAllEnvironments: true,
      values: {
        local: { value: true, scope: "vars", at: "vars.shared.yml:2" },
      },
      definedAt: [{ scope: "vars", at: "vars.shared.yml:2" }],
      overriddenBy: [],
      usedBy: [],
      unused: true,
    },
  ],
  findings: [
    {
      level: "warning",
      code: "include-override",
      message:
        "vars.legacyFlag in vars.shared.yml is overridden by the including file",
      at: "cairntrace.config.yml:6",
    },
  ],
};

describe("Config vars view", () => {
  /** @param {Array<any>} asked @param {any} [result] */
  function varsBridge(asked, result) {
    return env.installBridge({
      "config:vars": (/** @type {any} */ options) => {
        asked.push(options);
        return (
          result ?? {
            ok: true,
            exitCode: 0,
            vars: ops.normalizeConfigVars(VARS_PAYLOAD),
            cli: "cairn config vars --json",
          }
        );
      },
    });
  }

  it("shows each var per environment with where it is defined, overrides and uses; masked values stay masked", async () => {
    configuredState();
    /** @type {any[]} */
    const asked = [];
    varsBridge(asked);
    const root = mountPoint();
    await Studio.views["config-vars"].render(root);
    assert.deepEqual(asked[0], { env: null, unused: false });
    assert.match(text(root), /3 var\(s\) · 1 unused · 2 differ by environment/);
    const api = /** @type {HTMLElement} */ (
      root.querySelector('tr[data-var="apiUrl"]')
    );
    assert.match(
      text(api.querySelector(".cv-values")),
      /local\s*http:\/\/localhost:3000/,
    );
    assert.match(
      text(api.querySelector(".cv-values")),
      /staging\s*https:\/\/staging\.example\.test/,
    );
    assert.match(
      text(api.querySelector(".cv-defined")),
      /vars · cairntrace\.config\.yml:3/,
    );
    assert.match(
      text(api.querySelector(".cv-overrides")),
      /overridden by environments\.staging\.vars · cairntrace\.config\.yml:11 \(staging\)/,
    );
    assert.match(text(api.querySelector(".cv-used")), /2 uses/);
    assert.match(text(api.querySelector(".cv-used-list")), /spec login/);
    assert.match(text(api.querySelector(".cv-used-list")), /fixture seed/);

    const password = /** @type {HTMLElement} */ (
      root.querySelector('tr[data-var="dbPassword"]')
    );
    const shown = all(password, ".cv-display");
    assert.equal(shown.length, 2);
    for (const node of shown) {
      assert.equal(text(node), "••••••");
      assert.ok(node.classList.contains("cv-masked"));
    }
    assert.equal(
      all(password, ".tag").filter((tag) => /masked/.test(text(tag))).length,
      2,
    );
    assert.ok(
      !document.body.textContent.includes(SECRET),
      "the credential is nowhere in the page",
    );
    assert.ok(!document.body.innerHTML.includes(SECRET));

    const legacy = /** @type {HTMLElement} */ (
      root.querySelector('tr[data-var="legacyFlag"]')
    );
    assert.ok(legacy.classList.contains("cv-row-unused"));
    const unused =
      /** @type {HTMLElement} */ (legacy.querySelector(".cv-unused"));
    assert.match(
      text(unused),
      /⚠ unused/,
      "a glyph and a word, not colour alone",
    );
    assert.match(text(legacy), /same everywhere/);
    assert.match(text(legacy.querySelector(".cv-used")), /nothing/);
    assert.match(text(root.querySelector(".cv-findings")), /1 finding\(s\)/);
    assert.match(
      text(root.querySelector(".cv-findings")),
      /overridden by the including file/,
    );
  });

  it("filters by name locally, and asks the CLI for one environment or only the unused", async () => {
    configuredState();
    /** @type {any[]} */
    const asked = [];
    varsBridge(asked);
    const root = mountPoint();
    await Studio.views["config-vars"].render(root);
    const search =
      /** @type {HTMLInputElement} */ (root.querySelector("#cv-search"));
    search.value = "legacy";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    assert.deepEqual(
      all(root, "tr.cv-row").map((row) => row.dataset.var),
      ["legacyFlag"],
    );
    assert.equal(asked.length, 1, "filtering by name does not ask again");
    search.value = "zzz";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    assert.match(text(root.querySelector(".empty")), /No vars match/);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    const pick =
      /** @type {HTMLSelectElement} */ (root.querySelector("#cv-env"));
    pick.value = "staging";
    pick.dispatchEvent(new Event("change", { bubbles: true }));
    await env.waitFor(() => asked.length === 2, "second fetch");
    assert.deepEqual(asked[1], { env: "staging", unused: false });
  });

  it("degrades: no command, a composition error, no document", async () => {
    configuredState();
    /** @type {any[]} */
    const asked = [];
    varsBridge(asked, { ok: false, unsupported: true, vars: null });
    let root = mountPoint();
    await Studio.views["config-vars"].render(root);
    assert.match(
      text(root.querySelector(".empty")),
      /This cairn has no config vars/,
    );

    varsBridge(asked, {
      ok: false,
      exitCode: 4,
      vars: ops.normalizeConfigVars({
        ...VARS_PAYLOAD,
        ok: false,
        errors: ["environment staging extends unknown environment base"],
      }),
    });
    root = mountPoint();
    await Studio.views["config-vars"].render(root);
    assert.match(
      text(root.querySelector(".error-box")),
      /does not compose cleanly/,
    );
    assert.match(
      text(root.querySelector(".error-box")),
      /extends unknown environment base/,
    );
    assert.ok(
      root.querySelector("tr.cv-row"),
      "the vars it did read still list",
    );

    varsBridge(asked, { ok: false, vars: null, error: "no config found" });
    root = mountPoint();
    await Studio.views["config-vars"].render(root);
    assert.match(text(root.querySelector(".error-box")), /no config found/);
  });
});

// ── Environment: service windows, tunnels, provisioner, orphans ─────────────

const WINDOWS_STATUS = ops.normalizeServicesStatus({
  hasServices: true,
  project: "fixture",
  env: "local",
  docker: { configured: true, running: true },
  seed: { configured: true, expired: false },
  tmux: {
    configured: true,
    sessionExists: true,
    session: "fixture-local",
    windows: [
      { name: "web", healthy: true },
      { name: "worker", healthy: false },
      { name: "cron" },
    ],
  },
  tunnels: [
    { name: "db", state: "ready", running: true, pid: 411, restarts: 0 },
    { name: "queue", state: "giveup", running: false, restarts: 5 },
  ],
  provisioner: { exports: ["OPS_HOST", "OPS_TOKEN"] },
  errors: [],
});

const ORPHANS_DOC = ops.normalizeOrphans({
  ok: false,
  exitCode: 1,
  orphans: [
    {
      session: "cairn-gone-1",
      backend: "agent-browser",
      invocationId: "inv-1",
      ownerPid: 99999,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      processes: [
        { pid: 4321, command: "chrome --headless --user-data-dir=/tmp/x" },
      ],
    },
  ],
  staleEntriesRemoved: 1,
  liveSessions: 2,
  killRequested: false,
  killed: 0,
  remaining: [],
});

/**
 * @param {Record<string, (...args: any[]) => any>} extra
 */
function environmentBridge(extra) {
  return env.installBridge({
    "app:info": () => ({
      appVersion: "0.0.0-test",
      cairn: { command: "/usr/local/bin/cairn", source: "path" },
      runsRoot: { runsRoot: "/tmp/runs", source: "default" },
    }),
    "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
    "services:status": () => ({ ok: true, payload: { hasServices: true } }),
    "checkpoints:list": () => ({ ok: true, payload: { checkpoints: [] } }),
    "services:lock": () => ({
      ok: true,
      busy: null,
      lock: { state: "absent", path: "/l" },
    }),
    "orphans:list": () => ({ ok: true, exitCode: 1, orphans: ORPHANS_DOC }),
    "services:windows": (/** @type {any} */ options) => ({
      env: options.env,
      ok: true,
      busy: null,
      status: WINDOWS_STATUS,
      lock: { state: "absent", path: "/l" },
    }),
    ...extra,
  });
}

describe("Environment: service windows", () => {
  it("shows window health, tunnels and the provisioner's export names", async () => {
    configuredState({ hasServices: true });
    environmentBridge({});
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    const panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="service-windows"]')
    );
    await env.waitFor(
      () => panel.querySelector("tr.svc-window"),
      "the windows",
    );
    const rows = all(panel, "tr.svc-window");
    assert.deepEqual(
      rows.map((row) => row.dataset.window),
      ["web", "worker", "cron"],
    );
    assert.match(text(rows[0]), /✓ healthy/);
    assert.match(text(rows[1]), /✗ unhealthy/);
    assert.match(text(rows[2]), /no healthcheck/);
    const tunnels = all(panel, "tr.svc-tunnel");
    assert.match(text(tunnels[0]), /db\s*ready\s*✓ running\s*411\s*0/);
    assert.match(text(tunnels[1]), /queue\s*giveup\s*⚠ not running\s*—\s*5/);
    const provisioner = text(panel.querySelector(".svc-provisioner"));
    assert.match(provisioner, /provisioner exports \(names only\)/);
    assert.match(provisioner, /OPS_HOST/);
    assert.match(provisioner, /OPS_TOKEN/);
    assert.match(
      text(panel.querySelector(".svc-facts")),
      /tmux fixture-local running/,
    );
  });

  it("restarts a window through a native confirmation (cancel does nothing) and shows its log after", async () => {
    configuredState({ hasServices: true });
    /** @type {any[]} */
    const restarts = [];
    /** @type {any[]} */
    const logCalls = [];
    let cancel = true;
    environmentBridge({
      "services:restart": (/** @type {any} */ options) => {
        restarts.push(options);
        return cancel
          ? { cancelled: true }
          : {
              cancelled: false,
              ok: true,
              exitCode: 0,
              restart: ops.normalizeRestart({
                ok: true,
                windows: [
                  {
                    window: options.window,
                    ok: true,
                    alreadyStopped: false,
                    durationMs: 1500,
                  },
                ],
              }),
            };
      },
      "services:logs": (/** @type {any} */ options) => {
        logCalls.push(options);
        return {
          ok: true,
          logs: ops.normalizeLogs({
            ok: true,
            window: options.window,
            lines: [
              "server restarted",
              "listening on :3000",
              "db postgres://app:topsecret@db/x",
            ],
            totalLines: 3,
            sinceRestart: { requested: options.sinceRestart, found: true },
          }),
        };
      },
    });
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    const panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="service-windows"]')
    );
    await env.waitFor(
      () => panel.querySelector("tr.svc-window"),
      "the windows",
    );
    const restart = /** @type {HTMLButtonElement} */ (
      panel.querySelector('button[data-action="restart"][data-window="web"]')
    );
    assert.match(
      restart.getAttribute("aria-label") ?? "",
      /restart service window web \(asks first\)/,
    );
    restart.click();
    await env.waitFor(() => restarts.length === 1, "services:restart");
    assert.deepEqual(restarts[0], { env: "local", window: "web" });
    await env.waitFor(() => !restart.disabled, "the button back");
    assert.equal(logCalls.length, 0, "cancelled: no log, no toast");
    assert.ok(!/Restarted web/.test(text(document.getElementById("toasts"))));

    cancel = false;
    restart.click();
    await env.waitFor(() => restarts.length === 2, "second restart");
    await env.waitFor(
      () => panel.querySelector(".svc-log-pane"),
      "the log after the restart",
    );
    assert.match(
      text(document.getElementById("toasts")),
      /Restarted web · local/,
    );
    assert.match(text(document.getElementById("toasts")), /1\.50s/);
    assert.deepEqual(logCalls[0], {
      env: "local",
      window: "web",
      sinceRestart: true,
      lines: 200,
    });
    const pane =
      /** @type {HTMLElement} */ (panel.querySelector(".svc-log-pane"));
    assert.equal(pane.getAttribute("role"), "log");
    assert.match(text(pane), /listening on :3000/);
    assert.ok(!text(pane).includes("topsecret"));
    const since =
      /** @type {HTMLInputElement} */ (panel.querySelector("#svc-since"));
    assert.equal(since.checked, true);
    // Close empties the log host
    const close = all(panel, ".svc-log-head button").find(
      (b) => text(b) === "Close",
    );
    close?.click();
    assert.equal(panel.querySelector(".svc-log-pane"), null);
  });

  it("opens a window's log on its own, and says when cairn has no logs or restart command", async () => {
    configuredState({ hasServices: true });
    environmentBridge({
      "services:logs": () => ({ ok: false, unsupported: true, logs: null }),
      "services:restart": () => ({
        cancelled: false,
        ok: false,
        unsupported: true,
        exitCode: 1,
        stderr: "error: unknown command 'restart'",
      }),
    });
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    const panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="service-windows"]')
    );
    await env.waitFor(
      () => panel.querySelector("tr.svc-window"),
      "the windows",
    );
    /** @type {HTMLElement} */ (
      panel.querySelector('button[data-action="logs"][data-window="web"]')
    ).click();
    await env.waitFor(
      () => panel.querySelector(".svc-logs-host .error-box"),
      "the log error",
    );
    assert.match(
      text(panel.querySelector(".svc-logs-host .error-box")),
      /this cairn has no `cairn services logs`/,
    );
    /** @type {HTMLElement} */ (
      panel.querySelector('button[data-action="restart"][data-window="worker"]')
    ).click();
    await env.waitFor(
      () =>
        /Restart failed · worker/.test(text(document.getElementById("toasts"))),
      "the failure toast",
    );
    assert.match(
      text(document.getElementById("toasts")),
      /no `cairn services restart`/,
    );
  });

  it("degrades to the error message when the status gives no document, and hides itself without services", async () => {
    configuredState({ hasServices: true });
    environmentBridge({
      "services:windows": () => ({
        ok: false,
        status: null,
        error: "cairn exploded",
      }),
    });
    let root = mountPoint();
    await Studio.views.doctor.render(root);
    let panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="service-windows"]')
    );
    await env.waitFor(() => panel.querySelector(".error-box"), "the error");
    assert.match(text(panel.querySelector(".error-box")), /cairn exploded/);

    configuredState({ hasServices: false });
    environmentBridge({});
    root = mountPoint();
    await Studio.views.doctor.render(root);
    assert.equal(root.querySelector('[data-panel="service-windows"]'), null);
  });
});

describe("Environment: orphan browser sessions", () => {
  it("lists them, and ends their processes only through the confirmed kill", async () => {
    configuredState();
    let kills = 0;
    let cancel = true;
    environmentBridge({
      "orphans:kill": () => {
        kills += 1;
        return cancel
          ? { cancelled: true }
          : {
              cancelled: false,
              killed: true,
              ok: true,
              exitCode: 0,
              orphans: ops.normalizeOrphans({
                ok: true,
                exitCode: 0,
                orphans: [],
                staleEntriesRemoved: 0,
                liveSessions: 2,
                killRequested: true,
                killed: 1,
                remaining: [],
              }),
            };
      },
    });
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    const panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="orphans"]')
    );
    await env.waitFor(
      () => panel.querySelector("tr.orphan-row"),
      "the orphan row",
    );
    assert.match(
      text(panel.querySelector(".orphans-summary")),
      /⚠ 1 orphaned session\(s\)/,
    );
    assert.match(
      text(panel.querySelector(".orphans-summary")),
      /2 live session\(s\) of running runs are never touched/,
    );
    assert.match(
      text(panel.querySelector(".orphans-summary")),
      /1 stale ledger entry removed/,
    );
    const row =
      /** @type {HTMLElement} */ (panel.querySelector("tr.orphan-row"));
    assert.match(text(row), /cairn-gone-1\s*agent-browser/);
    assert.match(text(row), /99999 \(gone\)/);
    assert.match(text(row), /4321 chrome --headless/);

    const kill = /** @type {HTMLButtonElement} */ (
      panel.querySelector('button[data-action="kill-orphans"]')
    );
    kill.click();
    await env.waitFor(() => kills === 1, "orphans:kill");
    await env.waitFor(() => !kill.disabled, "kill button back");
    assert.ok(
      panel.querySelector("tr.orphan-row"),
      "cancelled: nothing changed",
    );

    cancel = false;
    kill.click();
    await env.waitFor(() => kills === 2, "second kill");
    await env.waitFor(
      () =>
        /Orphaned browsers ended/.test(text(document.getElementById("toasts"))),
      "the toast",
    );
    await env.waitFor(
      () => !panel.querySelector("tr.orphan-row"),
      "the list cleared",
    );
    assert.match(
      text(panel.querySelector(".orphans-summary")),
      /✓ no orphaned browser sessions/,
    );
    assert.match(
      text(panel.querySelector(".orphans-body")),
      /ended 1 process\(es\)/,
    );
  });

  it("reports survivors, and degrades on an older cairn", async () => {
    configuredState();
    environmentBridge({
      "orphans:list": () => ({ ok: false, unsupported: true, orphans: null }),
    });
    let root = mountPoint();
    await Studio.views.doctor.render(root);
    let panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="orphans"]')
    );
    await env.waitFor(
      () => /no `cairn doctor --orphans`/.test(text(panel)),
      "the old-cairn note",
    );

    environmentBridge({
      "orphans:list": () => ({
        ok: false,
        orphans: null,
        error: "ledger unreadable",
      }),
    });
    root = mountPoint();
    await Studio.views.doctor.render(root);
    panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="orphans"]')
    );
    await env.waitFor(() => panel.querySelector(".error-box"), "the error");
    assert.match(text(panel.querySelector(".error-box")), /ledger unreadable/);

    environmentBridge({
      "orphans:list": () => ({
        ok: true,
        exitCode: 1,
        orphans: ops.normalizeOrphans({
          ok: false,
          exitCode: 1,
          orphans: [],
          staleEntriesRemoved: 0,
          liveSessions: 0,
          killRequested: true,
          killed: 1,
          remaining: [4321],
        }),
      }),
    });
    root = mountPoint();
    await Studio.views.doctor.render(root);
    panel = /** @type {HTMLElement} */ (
      root.querySelector('[data-panel="orphans"]')
    );
    await env.waitFor(
      () => /still alive: 4321/.test(text(panel)),
      "the survivors",
    );
  });
});

// ── Run detail: run policy and metrics ──────────────────────────────────────

describe("Run detail: run policy and metrics", () => {
  const root = tempDir("cairn-ops-dom-");
  const SPEC = "billing";
  const JOURNAL = "2026-10-03T10-00-00-000Z_4242_abcdef";
  const RUN = "2026-10-03T10-00-00-000Z_billing_c0ffee";
  const RUN_CLEAN = "2026-10-03T11-00-00-000Z_billing_c0ffe1";
  const PRIOR = [
    ["2026-10-01T10-00-00-000Z_billing_c0ff01", 2],
    ["2026-10-02T10-00-00-000Z_billing_c0ff02", 5],
  ];

  /** @param {string} runId @param {number} delta */
  function metricsDoc(runId, delta) {
    return {
      $schema: "urn:cairntrace.dev:metrics:v1",
      version: "1",
      runId,
      environment: "local",
      metrics: [
        {
          name: "queue_depth",
          scope: "spec",
          source: "command",
          mode: "sample",
          unit: "jobs",
          target: "redis-cli llen q",
          before: { at: "2026-10-03T10:00:00.000Z", value: 4, durationMs: 3 },
          after: {
            at: "2026-10-03T10:00:09.000Z",
            value: 4 + delta,
            durationMs: 3,
          },
          delta,
          failures: 0,
        },
        {
          name: "rss",
          scope: "spec",
          source: "http",
          mode: "every",
          unit: "MB",
          before: { at: "a", value: 100, durationMs: 1 },
          after: { at: "b", value: 140, durationMs: 1 },
          delta: 40,
          series: {
            count: 3,
            samples: [
              { at: "a", value: 100, durationMs: 1 },
              { at: "b", error: "timeout", durationMs: 1 },
              { at: "c", value: 140, durationMs: 1 },
            ],
            min: 100,
            max: 140,
            mean: 120,
            first: 100,
            last: 140,
          },
          failures: 1,
          error: `request to http://u:${SECRET}@h/m failed`,
        },
      ],
    };
  }

  const stamp = "2026-10-03T10:00:00.000Z";
  /** @param {Array<Record<string, any>>} list */
  const lines = (list) =>
    list.map((event) => JSON.stringify({ ts: stamp, ...event })).join("\n");

  // a run whose invocation hit exit 8, exit 9, a failed preflight earlier,
  // finally and --bail
  makeRun(root, RUN, {
    specName: SPEC,
    run: { invocation: { id: JOURNAL, index: 1, total: 3 } },
  });
  write(
    path.join(root, RUN),
    "diagnostics/metrics.json",
    JSON.stringify(metricsDoc(RUN, 8)),
  );
  write(
    root,
    `_invocations/${JOURNAL}/invocation.json`,
    JSON.stringify({
      version: 1,
      invocationId: JOURNAL,
      suite: "smoke",
      status: "errored",
      pid: 4242,
      startedAt: stamp,
      summary: {
        total: 3,
        passed: 1,
        failed: 1,
        errored: 0,
        skipped: 1,
        durationMs: 5000,
        exitCode: 8,
        runPolicy: {
          criticalTeardown: [
            {
              index: 0,
              command: "docker compose down",
              exitCode: 3,
              path: "teardown",
            },
          ],
          dirty: [
            {
              phase: "after",
              kind: "tmux",
              name: "fixture-local",
              survivors: ["tmux session fixture-local exists"],
            },
          ],
          finallyFailed: 1,
        },
      },
    }),
  );
  write(
    root,
    `_invocations/${JOURNAL}/events.ndjson`,
    lines([
      { type: "run.lock.acquired", path: "/locks/x", scope: "config" },
      { type: "preflight.started", total: 2 },
      { type: "preflight.passed", index: 1, check: "secret", durationMs: 2 },
      {
        type: "preflight.passed",
        index: 2,
        check: "json",
        name: "api",
        durationMs: 12,
      },
      { type: "suite.started", name: "smoke", env: "local", specs: 3 },
      {
        type: "invocation.bailed",
        spec: "flows/a.yml",
        exitCode: 1,
        skipped: 1,
      },
      { type: "finally.started", index: 1, total: 1 },
      {
        type: "finally.finished",
        index: 1,
        exitCode: 3,
        durationMs: 20,
        outputTail: "cleanup failed",
      },
      {
        type: "cleanliness.dirty",
        phase: "after",
        kind: "tmux",
        name: "fixture-local",
        survivors: ["tmux session fixture-local exists"],
      },
      {
        type: "services.teardown.fail",
        message: "teardown[0] failed",
        data: { index: 0, exitCode: 3, critical: true },
      },
      {
        type: "run.lock.released",
        path: "/locks/x",
        scope: "config",
        heldMs: 4000,
      },
    ]),
  );
  // earlier runs of the same spec, for the history
  for (const [runId, delta] of PRIOR) {
    makeRun(root, String(runId), { specName: SPEC });
    write(
      path.join(root, String(runId)),
      "diagnostics/metrics.json",
      JSON.stringify(metricsDoc(String(runId), Number(delta))),
    );
  }
  // a clean run: no journal, no metrics
  makeRun(root, RUN_CLEAN, { specName: SPEC });

  function bridge() {
    return env.installBridge({
      "run:detail": (/** @type {string} */ ref) => ({
        ...runs.readRunDetail(
          path.isAbsolute(ref) ? ref : path.join(root, ref),
        ),
        restored: false,
      }),
      "runs:history": () => [],
      "metrics:history": (/** @type {any} */ options) =>
        metrics.metricsHistory(root, { spec: options?.spec ?? null }),
      "run:artifact-text": (/** @type {any} */ options) =>
        runs.readBoundedText(
          String(options?.runDir),
          String(options?.path ?? ""),
          400_000,
        ),
      "run:artifact-image": () => ({ ok: false }),
      "run:events": () => ({ events: [], offset: 0 }),
      "fs:exists": () => true,
    });
  }

  it("flags exit 8 and exit 9 above the tabs, by glyph, words and border, and lists them in Run policy", async () => {
    configuredState();
    bridge();
    const view = mountPoint();
    await Studio.views.run.render(view, { runRef: RUN, from: "runs" });
    await env.waitFor(() => view.querySelector(".ops-callout"), "the callouts");
    const critical = /** @type {HTMLElement} */ (
      view.querySelector('[data-callout="critical-teardown"]')
    );
    const dirty = /** @type {HTMLElement} */ (
      view.querySelector('[data-callout="dirty-after"]')
    );
    assert.ok(critical && dirty);
    assert.match(text(critical), /⛔\s*critical teardown failed · exit 8/);
    assert.match(text(dirty), /⚠\s*dirty state after the run · exit 9/);
    assert.notEqual(
      critical.className,
      dirty.className,
      "different shapes, not just colours",
    );
    assert.equal(
      critical.querySelector(".ops-glyph")?.getAttribute("aria-hidden"),
      "true",
    );
    // the badges row under the title says the same, plus finally and bail
    const badges = all(view, ".run-badges .ops-badge").map(
      (node) => node.dataset.badge,
    );
    assert.deepEqual(badges, [
      "critical-teardown",
      "dirty-after",
      "finally-failed",
      "bailed",
    ]);
    assert.match(
      text(view.querySelector('.ops-badge[data-badge="bailed"]')),
      /bailed · 1 skipped/,
    );

    /** @type {HTMLElement} */ (critical.querySelector("button")).click();
    await env.waitFor(
      () => view.querySelector("#tab-host .ops-policy"),
      "the Run policy tab",
    );
    const host = /** @type {HTMLElement} */ (view.querySelector("#tab-host"));
    assert.equal(
      view.querySelector("#run-tab-policy")?.getAttribute("aria-selected"),
      "true",
    );
    assert.match(
      text(host),
      /invocation 2026-10-03T10-00-00-000Z_4242_abcdef \(suite smoke\)/,
    );
    assert.match(
      text(host.querySelector('[data-row="critical"]')),
      /critical teardown failed.*services\.teardown\[0\] \(docker compose down\) exit 3/,
    );
    assert.match(
      text(host.querySelector('[data-row="lock"]')),
      /released.*run lock · config scope · held 4\.00s/,
    );
    const preflight = all(host, '[data-row="preflight"]');
    assert.equal(preflight.length, 2);
    assert.match(text(preflight[1]), /passed.*2 · json api/);
    assert.match(
      text(host.querySelector('[data-row="cleanliness"]')),
      /dirty \(exit 9\).*after the run · tmux fixture-local/,
    );
    assert.match(
      text(host.querySelector('[data-row="cleanliness"]')),
      /tmux session fixture-local exists/,
    );
    assert.match(
      text(host.querySelector('[data-row="finally"]')),
      /failed \(non-fatal\).*1\/1 · exit 3/,
    );
    assert.match(
      text(host.querySelector('[data-row="suite"]')),
      /suite smoke · env local · 3 spec\(s\)/,
    );
    assert.match(
      text(host.querySelector('[data-row="bail"]')),
      /bailed.*1 spec\(s\) skipped after flows\/a\.yml failed \(exit 1\)/,
    );
    // every status is a glyph and a word
    for (const row of all(host, ".ops-row")) {
      assert.ok(text(row.querySelector(".ops-mark")).length > 0);
      assert.ok(text(row.querySelector(".ops-status")).length > 0);
    }
  });

  it("shows the metrics table with deltas, series stats, failures and a labelled sparkline of the history", async () => {
    configuredState();
    bridge();
    const view = mountPoint();
    await Studio.views.run.render(view, { runRef: RUN, tab: "metrics" });
    await env.waitFor(
      () => view.querySelector("#tab-host .metrics-table"),
      "the metrics",
    );
    const depth = /** @type {HTMLElement} */ (
      view.querySelector('tr.metric-row[data-metric="queue_depth"]')
    );
    assert.match(text(depth.children[1]), /4 jobs/);
    assert.match(text(depth.children[2]), /12 jobs/);
    assert.match(text(depth.children[3]), /▲ \+8 jobs/);
    const rss = /** @type {HTMLElement} */ (
      view.querySelector('tr.metric-row[data-metric="rss"]')
    );
    assert.match(
      text(rss.children[4]),
      /min 100 MB · max 140 MB · mean 120 MB · 3 samples/,
    );
    assert.match(text(rss.children[5]), /⚠ 1 sample failed/);
    assert.ok(
      !document.body.textContent.includes(SECRET),
      "a credential in an error never shows",
    );

    await env.waitFor(() => depth.querySelector("svg.spark"), "the sparkline");
    const spark = /** @type {Element} */ (depth.querySelector("svg.spark"));
    assert.equal(spark.getAttribute("role"), "img");
    assert.match(
      spark.getAttribute("aria-label") ?? "",
      /queue_depth \(delta\) across 3 runs: min 2 jobs, max 8 jobs, latest 8 jobs/,
    );
    // labelled axes: max and min on y, the first and last run's time on x
    const labels = all(spark, "text.spark-label").map((node) => text(node));
    assert.equal(labels.length, 4);
    assert.equal(labels[0], "8");
    assert.equal(labels[1], "2");
    // the current run is ringed; the line and the points exist
    assert.equal(spark.querySelectorAll("circle").length, 3);
    assert.equal(spark.querySelectorAll("circle.spark-current").length, 1);
    assert.ok(spark.querySelector("polyline.spark-line"));
    // the numbers are also a table
    const values = all(depth, ".spark-values tbody tr");
    assert.deepEqual(
      values.map((row) => text(row.children[2])),
      ["8 jobs", "5 jobs", "2 jobs"],
    );
    assert.match(text(values[0]), /\(this run\)/);
    assert.match(
      text(depth.querySelector("figcaption")),
      /3 runs · min 2 jobs · max 8 jobs · latest 8 jobs/,
    );
    // an older run in the table opens that run
    /** @type {any[]} */
    const navigations = [];
    const off = Studio.on("navigate", (payload) => navigations.push(payload));
    try {
      /** @type {HTMLElement} */ (values[1].querySelector("button")).click();
      assert.equal(navigations[0].view, "run");
      assert.equal(navigations[0].params.runRef, PRIOR[1][0]);
    } finally {
      off();
    }
  });

  it("has no Run policy or Metrics tab for a run that has neither", async () => {
    configuredState();
    bridge();
    const view = mountPoint();
    await Studio.views.run.render(view, { runRef: RUN_CLEAN, from: "runs" });
    await env.waitFor(() => view.querySelector("#tab-host"), "the tab host");
    assert.equal(view.querySelector("#run-tab-policy"), null);
    assert.equal(view.querySelector("#run-tab-metrics"), null);
    assert.equal(view.querySelector(".ops-callout"), null);
    assert.equal(view.querySelector(".ops-badge"), null);
  });

  it("still shows the metrics table when the history cannot be read", async () => {
    configuredState();
    env.installBridge({
      "run:detail": (/** @type {string} */ ref) => ({
        ...runs.readRunDetail(path.join(root, ref)),
        restored: false,
      }),
      "runs:history": () => [],
      "metrics:history": () => {
        throw new Error("history unreadable");
      },
      "run:events": () => ({ events: [], offset: 0 }),
      "fs:exists": () => true,
    });
    const view = mountPoint();
    await Studio.views.run.render(view, { runRef: RUN, tab: "metrics" });
    await env.waitFor(
      () => view.querySelector("#tab-host .metrics-table"),
      "the metrics",
    );
    assert.match(
      text(view.querySelector(".metric-history")),
      /no earlier runs with this metric|…/,
    );
    assert.equal(view.querySelector("svg.spark"), null);
  });
});

// ── Live and Invocations: the run policy of an invocation ───────────────────

describe("Live and Invocations: run policy, suite and bail", () => {
  const id = "2026-10-03T12-00-00-000Z_5151_abcdef";
  const journal = {
    invocationId: id,
    pid: 5151,
    status: "errored",
    alive: false,
    startedAt: "2026-10-03T12:00:00.000Z",
    endedAt: "2026-10-03T12:00:09.000Z",
    argv: ["run", "--suite=smoke", "--bail"],
    suite: "smoke",
    planned: [
      { index: 1, spec: "flows/a.yml" },
      { index: 2, spec: "flows/b.yml" },
      { index: 3, spec: "flows/c.yml" },
    ],
    runs: [
      {
        index: 1,
        spec: "flows/a.yml",
        runId: "r1",
        runDir: "/x/r1",
        status: "failed",
      },
    ],
    current: { index: 1, spec: "flows/a.yml", runId: "r1" },
    summary: {
      total: 3,
      passed: 0,
      failed: 1,
      errored: 0,
      skipped: 2,
      durationMs: 9000,
      exitCode: 9,
      runPolicy: {
        dirty: [
          {
            phase: "after",
            kind: "tmux",
            name: "golden-session",
            survivors: ["tmux session golden-session exists"],
          },
        ],
      },
    },
    logs: [],
  };

  it("shows the policy panel, the suite and the dirty-state badge on the Live invocation group", async () => {
    configuredState();
    // still running: the journal's own summary is not written yet, so the
    // panel is built from the streamed events alone
    Studio.syncInvocations([
      {
        ...journal,
        status: "running",
        alive: true,
        endedAt: null,
        summary: null,
      },
    ]);
    Studio.applyInvocationEvents(
      id,
      env.readEvents("run-policy-dirty-bail.ndjson", { golden: true }),
    );
    env.installBridge({
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
    });
    Studio.state.view = "live";
    const view = mountPoint();
    const handle = Studio.views.live.render(view);
    try {
      await Studio.live.flush();
      const group = /** @type {HTMLElement} */ (
        view.querySelector(`.live-group[data-key="inv:${id}"]`)
      );
      assert.ok(group, "the invocation group");
      assert.match(text(group.querySelector(".group-head")), /suite smoke/);
      const policy = /** @type {HTMLElement} */ (
        group.querySelector(".ops-live .ops-policy")
      );
      assert.ok(policy, "the policy panel");
      assert.match(text(policy), /dirty state after the run · exit 9/);
      assert.ok(
        all(policy, '[data-row="cleanliness"]').some((row) =>
          /dirty \(exit 9\)/.test(text(row)),
        ),
        "the dirty finding",
      );
      assert.match(
        text(policy.querySelector('[data-row="bail"]')),
        /bailed.*\d+ spec\(s\) skipped/,
      );
      assert.match(
        text(policy.querySelector('[data-row="finally"]')),
        /failed \(non-fatal\)/,
      );
      // the plan names the skipped specs? that is the Invocations view's job
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.invocations.clear();
    }
  });

  it("marks the specs --bail never started as skipped in a finished Live invocation group", async () => {
    configuredState();
    Studio.syncInvocations([{ ...journal, logs: [] }]);
    Studio.applyInvocationEvents(
      id,
      env.readEvents("run-policy-dirty-bail.ndjson", { golden: true }),
    );
    // the app run whose process wrote this journal (same pid) groups under it
    Studio.state.live.set(
      "tok-bail",
      Studio.initLiveRecord({
        token: "tok-bail",
        specs: [],
        suite: "smoke",
        argv: [],
        command: "cairn",
        launcher: "cairn",
        startedAt: Date.now() - 1000,
        runDir: null,
        runId: null,
        pid: 5151,
        invocation: null,
        done: {
          ok: false,
          exitCode: 9,
          meaning: "dirty state after the run",
          at: Date.now(),
          payload: null,
        },
      }),
    );
    env.installBridge({
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
    });
    Studio.state.view = "live";
    const view = mountPoint();
    const handle = Studio.views.live.render(view);
    try {
      await Studio.live.flush();
      const group = /** @type {HTMLElement} */ (
        view.querySelector(`.live-group[data-key="inv:${id}"]`)
      );
      assert.ok(group, "the invocation group");
      const items = all(group, ".planned-item");
      assert.equal(items.length, 3);
      assert.ok(items[1].classList.contains("planned-skipped"));
      assert.match(text(items[1]), /flows\/b\.yml skipped · bailed/);
      assert.match(items[2].title, /--bail: <spec> failed first/);
      assert.ok(!items[0].classList.contains("planned-skipped"));
      // the run card says what the exit code means: its own badge, glyph and words
      const card = /** @type {HTMLElement} */ (
        view.querySelector(".ops-exit .ops-badge")
      );
      assert.ok(card, "the exit 9 badge on the app run's card");
      assert.match(text(card), /⚠\s*dirty state after the run · exit 9/);
      // the card is titled by its suite, not an empty spec list
      assert.match(text(view), /suite smoke/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.invocations.clear();
      Studio.state.live.clear();
    }
  });

  it("marks specs that --bail never started as skipped in the Invocations plan, and lists the policy", async () => {
    configuredState();
    const events = env.readEvents("run-policy-dirty-bail.ndjson", {
      golden: true,
    });
    env.installBridge({
      "invocations:list": () => ({ runsRoot: "/x", invocations: [journal] }),
      "invocation:get": () => journal,
      "invocation:events": (/** @type {any} */ options) => {
        const from = Number(options?.offset ?? 0);
        return { events: events.slice(from), offset: events.length };
      },
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
      "invocation:stop": () => ({ stopped: false }),
    });
    Studio.state.view = "invocations";
    const view = mountPoint();
    const handle = await Studio.views.invocations.render(view, {
      invocationId: id,
    });
    try {
      const detail =
        /** @type {HTMLElement} */ (view.querySelector(".inv-detail"));
      await env.waitFor(
        () => detail.querySelector(".inv-policy .ops-policy"),
        "the policy panel",
      );
      const planned = all(detail, ".inv-plan .planned-item");
      assert.equal(planned.length, 3);
      assert.match(
        text(planned[0].querySelector(".planned-status")),
        /^failed$/,
      );
      for (const item of planned.slice(1)) {
        assert.match(
          text(item.querySelector(".planned-status")),
          /^skipped · bailed after <spec>$/,
        );
      }
      assert.match(
        text(detail),
        /0 passed · 1 failed · 0 errored · 2 skipped \(bailed\) of 3 · exit 9 \(dirty state after the run\)/,
      );
      assert.match(text(detail.querySelector(".inv-head")), /suite smoke/);
      assert.match(
        text(detail.querySelector(".inv-policy")),
        /dirty \(exit 9\)/,
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

// ── the topbar lock pill ─────────────────────────────────────────────────────

describe("run lock wording", () => {
  it("names the run lock and a suite lock differently", () => {
    const runLock = {
      kind: "run-lock",
      owner: "pid 7 (cli)",
      command: "cairn run a.yml",
      path: "/l",
    };
    const suiteLock = { path: ".suite.lock", owner: "nightly" };
    assert.equal(Studio.ops.lockHeadline([runLock]), "run in progress");
    assert.equal(Studio.ops.lockHeadline([suiteLock]), "suite in progress");
    assert.equal(
      Studio.ops.lockSentence(runLock),
      "a cairn run holds the run lock: pid 7 (cli) — cairn run a.yml",
    );
    assert.equal(
      Studio.ops.lockSentence(suiteLock),
      ".suite.lock (owner: nightly)",
    );
  });
});
