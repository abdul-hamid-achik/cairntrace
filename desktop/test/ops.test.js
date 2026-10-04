/**
 * Run-policy and operations plumbing (lib/ops.js, lib/metrics.js, the run
 * policy in lib/runs.js): allow-listed argv, payload normalisers that keep
 * credentials masked and degrade on a payload that is not the expected
 * document, the config run lock, metrics documents and their history.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const cli = require("../lib/cli");
const metrics = require("../lib/metrics");
const ops = require("../lib/ops");
const runs = require("../lib/runs");
const specs = require("../lib/specs");
const { cleanup, makeRun, tempDir, write } = require("./helpers");

after(cleanup);

describe("argv builders", () => {
  it("builds the suites, config vars and orphans commands", () => {
    assert.deepEqual(ops.buildSuitesArgv(), ["suites", "list", "--json"]);
    assert.deepEqual(
      ops.buildSuitesArgv({
        env: "staging",
        config: "/p/cairntrace.config.yml",
      }),
      [
        "suites",
        "list",
        "--env=staging",
        "--config=/p/cairntrace.config.yml",
        "--json",
      ],
    );
    assert.deepEqual(ops.buildConfigVarsArgv({ env: "local", unused: true }), [
      "config",
      "vars",
      "--env=local",
      "--unused",
      "--json",
    ]);
    assert.deepEqual(ops.buildOrphansArgv(), ["doctor", "--orphans", "--json"]);
    assert.deepEqual(ops.buildOrphansArgv({ kill: true }), [
      "doctor",
      "--orphans",
      "--kill",
      "--yes",
      "--json",
    ]);
    assert.deepEqual(
      ops.buildOrphansArgv({ kill: true, only: ["cairntrace-77", 4321] }),
      [
        "doctor",
        "--orphans",
        "--kill",
        "--yes",
        "--only=cairntrace-77,4321",
        "--json",
      ],
    );
  });

  it("only passes session names and pids to --only (no flag smuggling)", () => {
    for (const token of ["--help", "a,b", "x;rm", "a b", "0", "-1"]) {
      assert.throws(
        () => ops.buildOrphansArgv({ kill: true, only: [token] }),
        /invalid orphan session or pid/,
      );
    }
    assert.throws(
      () => ops.buildOrphansArgv({ kill: true, only: [] }),
      /at least one/,
    );
    assert.deepEqual(
      ops.confirmedOrphanSet({
        orphans: [
          {
            session: "cairntrace-77-w0-s1",
            processes: [{ pid: 4321 }, { pid: 4322 }],
          },
        ],
      }),
      ["cairntrace-77-w0-s1", 4321, 4322],
    );
  });

  it("refuses an environment name that is not one (no flag smuggling)", () => {
    for (const env of ["--help", "a b", "x;rm", "", "../etc"]) {
      if (env === "") continue; // empty means "default"
      assert.throws(() => ops.buildSuitesArgv({ env }), /invalid environment/);
      assert.throws(
        () => ops.buildConfigVarsArgv({ env }),
        /invalid environment/,
      );
    }
    assert.throws(
      () => ops.buildServicesRestartArgv({ window: "web", env: "--x" }),
      /invalid environment/,
    );
  });

  it("restarts and reads logs of one window, joined to its flags, bounded", () => {
    assert.deepEqual(
      ops.buildServicesRestartArgv({
        window: "web",
        env: "local",
        config: "/p/c.yml",
      }),
      [
        "services",
        "restart",
        "web",
        "--env=local",
        "--config=/p/c.yml",
        "--json",
      ],
    );
    assert.deepEqual(
      ops.buildServicesLogsArgv({
        window: "api:1",
        env: "local",
        sinceRestart: true,
        lines: 99999,
      }),
      [
        "services",
        "logs",
        "api:1",
        "--env=local",
        "--since-restart",
        "--lines=1000",
        "--json",
      ],
    );
    assert.deepEqual(
      ops.buildServicesLogsArgv({ window: "web", env: "local", lines: "nope" }),
      ["services", "logs", "web", "--env=local", "--lines=200", "--json"],
    );
    // no --follow / --wait: a read is bounded
    const argv = ops.buildServicesLogsArgv({ window: "web", env: "local" });
    assert.ok(
      !argv.includes("--follow") && !argv.some((a) => a.startsWith("--wait")),
    );
  });

  it("refuses a window name that could be a flag, a path or a shell string", () => {
    for (const window of [
      "--force",
      "-x",
      "a b",
      "web;ls",
      "$(id)",
      "",
      "../x",
      "a".repeat(81),
    ])
      assert.throws(
        () => ops.checkWindowName(window),
        /invalid service window/,
        window,
      );
    assert.equal(ops.checkWindowName(" web "), "web");
  });

  it("runs a suite as one --suite=<name> entry in place of spec paths", () => {
    const argv = cli.buildRunArgv({ specs: [], suite: "smoke", env: "local" });
    assert.deepEqual(argv.slice(0, 2), ["run", "--suite=smoke"]);
    assert.ok(argv.includes("--env"));
    assert.throws(
      () => cli.buildRunArgv({ specs: ["/p/a.yml"], suite: "smoke" }),
      /not both/,
    );
    assert.throws(() => cli.buildRunArgv({ specs: [] }), /at least one spec/);
    for (const name of ["-x", "--env=prod", "", "a\nb", "x".repeat(121)])
      assert.throws(() => cli.checkSuiteName(name), /invalid suite name/);
    assert.equal(cli.checkSuiteName("nightly smoke"), "nightly smoke");
  });
});

describe("normalizers", () => {
  it("reads a suites document, tolerating missing optionals", () => {
    const doc = ops.normalizeSuites({
      $schema: "urn:cairntrace.dev:suites:v1",
      project: "demo",
      root: "/p",
      suites: [
        {
          name: "smoke",
          description: "fast",
          bail: true,
          requires: { env: ["local"] },
          envs: [
            {
              env: "local",
              specs: ["a.yml", "b.yml"],
              before: 1,
              after: 0,
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
        { nope: true },
      ],
      warnings: [],
    });
    assert.ok(doc);
    assert.equal(doc.suites.length, 1);
    assert.equal(doc.suites[0].parallel, null);
    assert.deepEqual(doc.suites[0].requiresEnv, ["local"]);
    assert.equal(doc.suites[0].envs[1].problem, "requires.env rules prod out");
    assert.equal(doc.root, "/p");
    assert.equal(ops.normalizeSuites({ ok: true }), null);
    assert.equal(ops.normalizeSuites(null), null);
    assert.equal(ops.normalizeSuites("text"), null);
  });

  it("keeps a masked config var masked and masks a credential-named one the CLI did not", () => {
    const doc = ops.normalizeConfigVars({
      $schema: "urn:cairntrace.dev:config-vars:v1",
      ok: true,
      path: "/p/c.yml",
      files: ["c.yml"],
      environments: ["local", "staging"],
      totals: { vars: 3, unused: 1, differing: 1 },
      vars: [
        {
          name: "apiUrl",
          kind: "string",
          values: {
            local: {
              value: "http://localhost:3000",
              scope: "vars",
              at: "c.yml:3",
            },
            staging: {
              value: "https://user:hunter2@staging.example/api",
              scope: "environments.staging.vars",
              at: "c.yml:9",
            },
          },
          definedAt: [{ scope: "vars", at: "c.yml:3" }],
          overriddenBy: [
            {
              scope: "environments.staging.vars",
              at: "c.yml:9",
              envs: ["staging"],
            },
          ],
          usedBy: [{ kind: "spec", name: "login", file: "flows/login.yml" }],
        },
        {
          name: "dbPassword",
          kind: "string",
          values: {
            local: { value: "hunter2-actual", scope: "vars", at: "c.yml:4" },
          },
          definedAt: [{ scope: "vars", at: "c.yml:4" }],
          overriddenBy: [],
          usedBy: [],
          unused: true,
        },
        {
          name: "token",
          kind: "string",
          values: {
            local: {
              value: "••••",
              masked: true,
              scope: "vars",
              at: "c.yml:5",
              template: "${env.TOKEN}",
            },
          },
          definedAt: [],
          overriddenBy: [],
          usedBy: [],
        },
      ],
      findings: [],
    });
    assert.ok(doc);
    const dump = JSON.stringify(doc);
    assert.ok(
      !dump.includes("hunter2"),
      "no credential value, including userinfo",
    );
    assert.ok(
      !dump.includes("${env.TOKEN}"),
      "a masked var's template is dropped too",
    );
    const [api, password, token] = doc.vars;
    assert.equal(api.values[0].display, "http://localhost:3000");
    assert.equal(api.values[1].display, "https://***@staging.example/api");
    assert.equal(api.values[1].masked, false);
    assert.equal(password.values[0].masked, true);
    assert.equal(password.values[0].display, ops.MASKED);
    assert.equal(password.unused, true);
    assert.equal(token.values[0].masked, true);
    assert.equal(token.values[0].display, ops.MASKED);
    assert.equal(ops.normalizeConfigVars({ suites: [] }), null);
  });

  it("reads orphan sessions and drops a malformed entry", () => {
    const doc = ops.normalizeOrphans({
      $schema: "urn:cairntrace.dev:doctor-orphans:v1",
      ok: false,
      exitCode: 1,
      orphans: [
        {
          session: "cairn-1",
          backend: "agent-browser",
          invocationId: "inv-1",
          ownerPid: 99,
          startedAt: "2026-10-03T10:00:00.000Z",
          processes: [
            { pid: 123, command: "chrome --remote-debugging-port=0" },
            { pid: -1, command: "x" },
          ],
        },
        { backend: "playwright" },
      ],
      staleEntriesRemoved: 2,
      liveSessions: 1,
      killRequested: false,
      killed: 0,
      remaining: [],
    });
    assert.ok(doc);
    assert.equal(doc.orphans.length, 1);
    assert.deepEqual(doc.orphans[0].processes, [
      { pid: 123, command: "chrome --remote-debugging-port=0" },
    ]);
    assert.equal(doc.exitCode, 1);
    assert.equal(ops.normalizeOrphans({ ok: true }), null);
  });

  it("reads service windows, tunnels and the provisioner's export names, never pane text", () => {
    const status = ops.normalizeServicesStatus({
      hasServices: true,
      project: "demo",
      env: "local",
      docker: { configured: true, running: true },
      seed: { configured: true, expired: false },
      tmux: {
        configured: true,
        sessionExists: true,
        session: "demo-local",
        windows: [
          { name: "web", healthy: true, paneTail: "SECRET=hunter2" },
          { name: "--bad", healthy: false },
        ],
      },
      tunnels: [
        { name: "db", state: "ready", running: true, pid: 4, restarts: 1 },
      ],
      provisioner: { exports: ["OPS_HOST"] },
      errors: [],
    });
    assert.ok(status);
    assert.deepEqual(status.tmux.windows, [{ name: "web", healthy: true }]);
    assert.ok(!JSON.stringify(status).includes("hunter2"));
    assert.deepEqual(status.provisioner, { exports: ["OPS_HOST"] });
    assert.equal(status.tunnels[0].restarts, 1);
    assert.equal(ops.normalizeServicesStatus({}), null);
  });

  it("reads restart and logs results, masks a credential in a log line again, and bounds the lines", () => {
    const restart = ops.normalizeRestart({
      ok: true,
      exitCode: 0,
      windows: [
        { window: "web", ok: true, alreadyStopped: false, durationMs: 1200 },
      ],
      warnings: [],
      durationMs: 1300,
    });
    assert.equal(restart?.windows[0].window, "web");
    assert.equal(ops.normalizeRestart({ ok: true }), null);
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    lines.push("connecting to postgres://admin:s3cret@db:5432/app");
    const logs = ops.normalizeLogs({
      ok: true,
      exitCode: 0,
      window: "web",
      lines,
      totalLines: 1501,
      sinceRestart: { requested: true, found: true },
      warnings: [],
    });
    assert.ok(logs);
    assert.equal(logs.lines.length, 1000);
    assert.ok(!logs.lines.join("\n").includes("s3cret"));
    assert.match(logs.lines.at(-1), /postgres:\/\/\*\*\*@db/);
    assert.equal(ops.normalizeLogs({ ok: false }), null);
  });
});

describe("run lock", () => {
  /**
   * @param {string} dir
   * @param {string} name
   * @param {Record<string, any>} lock
   */
  function lockFile(dir, name, lock) {
    write(dir, `${name}.run.lock.json`, JSON.stringify(lock));
  }

  const NOW = Date.parse("2026-10-03T10:05:00.000Z");

  it("finds a live lock for this project's config (or project name) and nothing else", () => {
    const dir = tempDir("cairn-locks-");
    lockFile(dir, "a", {
      version: 1,
      token: "t",
      pid: 4242,
      startedAt: "2026-10-03T10:00:00.000Z",
      argv: ["run", "flows/a.yml", "--var", "x=1"],
      cwd: "/p",
      scope: "config",
      key: "/p/cairntrace.config.yml",
      invocationId: "inv-1",
      origin: "cli",
      env: "local",
    });
    lockFile(dir, "b", {
      version: 1,
      token: "t",
      pid: 4243,
      startedAt: "2026-10-03T10:00:00.000Z",
      argv: [],
      cwd: "/q",
      scope: "config",
      key: "/q/cairntrace.config.yml",
    });
    lockFile(dir, "c", {
      version: 1,
      token: "t",
      pid: 4244,
      startedAt: "2026-10-03T10:04:00.000Z",
      argv: [],
      cwd: "/p",
      scope: "project",
      key: "project:demo",
      origin: "mcp",
    });
    write(dir, "d.run.lock.json", "not json");
    write(dir, "ignored.txt", "x");
    const held = ops.readRunLocks({
      lockDir: dir,
      keys: ["/p/cairntrace.config.yml", "project:demo"],
      now: NOW,
      pidAlive: () => true,
      elapsedMs: () => null,
    });
    assert.deepEqual(
      held.map((entry) => [entry.pid, entry.scope, entry.origin]),
      [
        [4242, "config", "cli"],
        [4244, "project", "mcp"],
      ],
    );
    assert.equal(held[0].kind, "run-lock");
    assert.equal(held[0].ageMs, 300_000);
    assert.match(
      held[0].owner,
      /^pid 4242 \(cli, invocation inv-1, env "local"\), running for 5m$/,
    );
    assert.equal(held[0].command, "cairn run flows/a.yml --var x=1");
  });

  it("does not count a dead owner, or a recycled pid, as held", () => {
    const dir = tempDir("cairn-locks-");
    const base = {
      version: 1,
      token: "t",
      startedAt: "2026-10-03T10:00:00.000Z",
      argv: [],
      cwd: "/p",
      scope: "config",
      key: "/p/c.yml",
    };
    lockFile(dir, "dead", { ...base, pid: 11 });
    lockFile(dir, "recycled", { ...base, pid: 12 });
    lockFile(dir, "real", { ...base, pid: 13 });
    const held = ops.readRunLocks({
      lockDir: dir,
      keys: ["/p/c.yml"],
      now: NOW,
      pidAlive: (pid) => pid !== 11,
      // pid 12 is younger than the lock it supposedly wrote
      elapsedMs: (pid) => (pid === 12 ? 30_000 : 300_000),
    });
    assert.deepEqual(
      held.map((entry) => entry.pid),
      [13],
    );
  });

  it("reads nothing when the lock directory is missing or the project has no keys", () => {
    assert.deepEqual(
      ops.readRunLocks({ lockDir: "/nonexistent/locks", keys: ["x"] }),
      [],
    );
    assert.deepEqual(ops.readRunLocks({ lockDir: tempDir(), keys: [] }), []);
  });

  it("derives the keys from the config path (canonical) and project name", () => {
    const dir = tempDir("cairn-lockkeys-");
    const config = write(dir, "cairntrace.config.yml", "project: demo\n");
    const keys = ops.runLockKeys({ configPath: config, project: "demo" });
    assert.equal(keys[0], fs.realpathSync(config));
    assert.equal(keys[1], "project:demo");
    assert.deepEqual(ops.runLockKeys({ configPath: null, project: null }), []);
  });

  it("is only checked when the config declares run.lock", () => {
    const on = tempDir("cairn-runlock-");
    write(on, "cairntrace.config.yml", "project: demo\nrun:\n  lock: true\n");
    assert.deepEqual(
      specs.readProjectConfig(path.join(on, "cairntrace.config.yml")).runLock,
      { configured: true, scopes: ["config"] },
    );
    const project = tempDir("cairn-runlock-");
    write(
      project,
      "cairntrace.config.yml",
      "project: demo\nenvironments:\n  local:\n    run:\n      lock:\n        scope: project\n",
    );
    assert.deepEqual(
      specs.readProjectConfig(path.join(project, "cairntrace.config.yml"))
        .runLock,
      { configured: true, scopes: ["project"] },
    );
    const off = tempDir("cairn-runlock-");
    write(off, "cairntrace.config.yml", "project: demo\nrun:\n  lock: false\n");
    assert.deepEqual(
      specs.readProjectConfig(path.join(off, "cairntrace.config.yml")).runLock,
      { configured: false, scopes: [] },
    );
    assert.deepEqual(specs.readProjectConfig(null).runLock, {
      configured: false,
      scopes: [],
    });
  });
});

describe("native confirmations", () => {
  it("names the window, environment, lock owner and the exact command", () => {
    const dialog = ops.restartDialog({
      window: "web",
      env: "staging",
      lock: null,
      policy: { trait: "shared" },
      cli: "cairn services restart web --env=staging --json",
    });
    assert.equal(dialog.confirmLabel, "Restart");
    assert.match(dialog.message, /Restart "web" in "staging"\?/);
    assert.match(dialog.detail, /never a hard kill/);
    assert.match(dialog.detail, /shared: other people may depend/);
    assert.match(
      dialog.detail,
      /cairn services restart web --env=staging --json/,
    );
  });

  it("lists every session and process an orphan kill would end", () => {
    const dialog = ops.orphansDialog({
      orphans: [
        {
          session: "cairn-1",
          backend: "agent-browser",
          invocationId: "inv-1",
          ownerPid: 99,
          processes: [
            { pid: 123, command: "chrome --headless" },
            { pid: 124, command: "chrome --type=renderer" },
          ],
        },
      ],
      cli: "cairn doctor --orphans --kill --yes --json",
    });
    assert.equal(dialog.confirmLabel, "End processes");
    assert.match(
      dialog.message,
      /End 2 browser process\(es\) of 1 orphaned session\(s\)\?/,
    );
    assert.match(dialog.detail, /cairn-1 \(agent-browser\)/);
    assert.match(dialog.detail, /pid 123 {2}chrome --headless/);
    assert.match(dialog.detail, /never touched/);
  });
});

describe("metrics", () => {
  const DOC = {
    $schema: "urn:cairntrace.dev:metrics:v1",
    version: "1",
    runId: "r",
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
        after: { at: "2026-10-03T10:00:09.000Z", value: 9, durationMs: 4 },
        delta: 5,
        failures: 0,
      },
      {
        name: "rss",
        scope: "spec",
        source: "http",
        mode: "every",
        unit: "MB",
        before: { at: "x", value: 100, durationMs: 1 },
        after: { at: "y", value: 130, durationMs: 1 },
        delta: 30,
        series: {
          count: 3,
          samples: [
            { at: "a", value: 100, durationMs: 1 },
            { at: "b", error: "boom", durationMs: 1 },
            { at: "c", value: 130, durationMs: 1 },
          ],
          min: 100,
          max: 130,
          mean: 115,
          first: 100,
          last: 130,
        },
        failures: 1,
        error: "request to http://u:pw@h/x failed",
      },
      {
        name: "broken",
        scope: "invocation",
        source: "command",
        mode: "sample",
        failures: 1,
        error: "command exited 1",
      },
      { scope: "spec" },
    ],
  };

  it("normalizes a metrics document: finite numbers, series values, masked errors", () => {
    const doc = metrics.normalizeMetrics(DOC);
    assert.ok(doc);
    assert.deepEqual(
      doc.metrics.map((row) => [row.name, row.delta, row.failures]),
      [
        ["queue_depth", 5, 0],
        ["rss", 30, 1],
        ["broken", null, 1],
      ],
    );
    assert.deepEqual(doc.metrics[1].series.values, [100, 130]);
    assert.equal(doc.metrics[1].series.mean, 115);
    assert.ok(!JSON.stringify(doc).includes("u:pw"), "userinfo masked");
    assert.equal(doc.metrics[2].scope, "invocation");
    assert.equal(metrics.normalizeMetrics({ metrics: "x" }), null);
    assert.equal(metrics.normalizeMetrics(null), null);
    // a non-finite value is not a number
    const odd = metrics.normalizeMetrics({
      metrics: [
        { name: "n", delta: Number.NaN, before: { value: "7" }, failures: 0 },
      ],
    });
    assert.equal(odd?.metrics[0].delta, null);
    assert.equal(odd?.metrics[0].before?.value, null);
  });

  it("thins a long series to at most 120 points, keeping first and last", () => {
    const samples = Array.from({ length: 500 }, (_, i) => ({
      at: "t",
      value: i,
      durationMs: 1,
    }));
    const doc = metrics.normalizeMetrics({
      metrics: [{ name: "n", series: { count: 500, samples }, failures: 0 }],
    });
    const values = doc?.metrics[0].series?.values ?? [];
    assert.equal(values.length, metrics.MAX_SERIES_POINTS);
    assert.equal(values[0], 0);
    assert.equal(values.at(-1), 499);
  });

  it("reads a run's diagnostics/metrics.json, and nothing when it is missing or oversized", () => {
    const root = tempDir("cairn-metrics-");
    const dir = makeRun(root, "2026-10-03T10-00-00-000Z_demo_aaaa11");
    assert.equal(metrics.readRunMetrics(dir), null);
    write(dir, "diagnostics/metrics.json", JSON.stringify(DOC));
    assert.equal(metrics.readRunMetrics(dir)?.metrics.length, 3);
    write(
      dir,
      "diagnostics/metrics.json",
      "x".repeat(metrics.MAX_METRICS_BYTES + 1),
    );
    assert.equal(metrics.readRunMetrics(dir), null);
  });

  it("builds a history per metric, oldest first, for one spec, from the newest runs", () => {
    const root = tempDir("cairn-metrics-history-");
    const values = [2, 4, 8];
    values.forEach((delta, index) => {
      const dir = makeRun(
        root,
        `2026-10-0${index + 1}T10-00-00-000Z_demo_aaaa0${index}`,
        {
          specName: "demo",
        },
      );
      write(
        dir,
        "diagnostics/metrics.json",
        JSON.stringify({
          metrics: [
            { name: "depth", scope: "spec", unit: "jobs", delta, failures: 0 },
          ],
        }),
      );
    });
    // another spec's run never joins the history of this one
    const other = makeRun(root, "2026-10-04T10-00-00-000Z_other_bbbb00", {
      specName: "other",
    });
    write(
      other,
      "diagnostics/metrics.json",
      JSON.stringify({
        metrics: [{ name: "depth", scope: "spec", delta: 999, failures: 0 }],
      }),
    );
    const history = metrics.metricsHistory(root, { spec: "demo" });
    assert.equal(history.scanned, 3);
    const depth = history.metrics.depth;
    assert.deepEqual(
      depth.points.map((point) => point.value),
      [2, 4, 8],
    );
    assert.equal(depth.unit, "jobs");
    assert.equal(depth.basis, "delta");
    assert.match(String(depth.points[0].at), /^2026-10-01T10:00:00/);
    const all = metrics.metricsHistory(root, {});
    assert.deepEqual(
      all.metrics.depth.points.map((point) => point.value),
      [2, 4, 8, 999],
    );
    const limited = metrics.metricsHistory(root, { spec: "demo", limit: 2 });
    assert.deepEqual(
      limited.metrics.depth.points.map((point) => point.value),
      [4, 8],
    );
  });

  it("keeps metrics named like Object.prototype members (constructor, toString)", () => {
    const root = tempDir("cairn-metrics-proto-");
    const dir = makeRun(root, "2026-10-01T10-00-00-000Z_demo_aaaa00", {
      specName: "demo",
    });
    write(
      dir,
      "diagnostics/metrics.json",
      JSON.stringify({
        metrics: ["constructor", "toString", "valueOf", "__proto__"].map(
          (name, index) => ({ name, delta: index + 1, failures: 0 }),
        ),
      }),
    );
    const history = metrics.metricsHistory(root, { spec: "demo" });
    assert.deepEqual(
      ["constructor", "toString", "valueOf", "__proto__"].map((name) =>
        history.metrics[name]?.points.map((point) => point.value),
      ),
      [[1], [2], [3], [4]],
    );
  });

  it("drops history points whose basis differs from the newest", () => {
    const root = tempDir("cairn-metrics-basis-");
    const older = makeRun(root, "2026-10-01T10-00-00-000Z_demo_aaaa00", {
      specName: "demo",
    });
    write(
      older,
      "diagnostics/metrics.json",
      JSON.stringify({
        metrics: [{ name: "m", after: { value: 50 }, failures: 0 }],
      }),
    );
    const newer = makeRun(root, "2026-10-02T10-00-00-000Z_demo_aaaa00", {
      specName: "demo",
    });
    write(
      newer,
      "diagnostics/metrics.json",
      JSON.stringify({ metrics: [{ name: "m", delta: 3, failures: 0 }] }),
    );
    const history = metrics.metricsHistory(root, { spec: "demo" });
    assert.deepEqual(
      history.metrics.m.points.map((point) => point.value),
      [3],
    );
    assert.equal(history.metrics.m.basis, "delta");
  });
});

describe("run detail: run policy and metrics", () => {
  it("reads the run policy from the run's invocation journal, with the settled summary", () => {
    const root = tempDir("cairn-policy-detail-");
    const runId = "2026-10-03T10-00-00-000Z_demo_aaaa11";
    const journal = "2026-10-03T10-00-00-000Z_9999_abcdef";
    makeRun(root, runId, {
      run: { invocation: { id: journal, index: 1, total: 3 } },
    });
    write(
      root,
      `_invocations/${journal}/invocation.json`,
      JSON.stringify({
        version: 1,
        invocationId: journal,
        suite: "smoke",
        status: "errored",
        summary: {
          total: 3,
          passed: 1,
          failed: 1,
          errored: 0,
          skipped: 1,
          exitCode: 9,
          runPolicy: {
            dirty: [
              {
                phase: "after",
                kind: "tmux",
                name: "s",
                survivors: ["tmux session s exists"],
              },
            ],
            finallyFailed: 1,
          },
        },
      }),
    );
    write(
      root,
      `_invocations/${journal}/events.ndjson`,
      [
        { type: "run.lock.acquired", path: "/l", scope: "config" },
        { type: "preflight.started", total: 1 },
        { type: "preflight.passed", index: 1, check: "secret", durationMs: 1 },
        { type: "invocation.bailed", spec: "a.yml", exitCode: 1, skipped: 1 },
        {
          type: "cleanliness.dirty",
          phase: "after",
          kind: "tmux",
          name: "s",
          survivors: ["tmux session s exists"],
        },
        { type: "run.lock.released", path: "/l", scope: "config", heldMs: 5 },
        { type: "hook.started", hook: "before", index: 1 },
      ]
        .map((event) =>
          JSON.stringify({ ts: "2026-10-03T10:00:00.000Z", ...event }),
        )
        .join("\n"),
    );
    const detail = runs.readRunDetail(path.join(root, runId));
    assert.ok(detail.runPolicy);
    assert.equal(detail.runPolicy.suite, "smoke");
    assert.equal(detail.runPolicy.summary.exitCode, 9);
    assert.equal(detail.runPolicy.summary.skipped, 1);
    assert.equal(detail.runPolicy.policy.lock.state, "released");
    assert.equal(detail.runPolicy.policy.bailed.skipped, 1);
    assert.equal(detail.runPolicy.policy.preflight.checks[0].check, "secret");
    assert.equal(detail.metrics, null);
  });

  it("has no run policy for a run whose journal holds none, or no journal at all", () => {
    const root = tempDir("cairn-policy-none-");
    const bare = "2026-10-03T10-00-00-000Z_demo_aaaa22";
    makeRun(root, bare);
    assert.equal(runs.readRunDetail(path.join(root, bare)).runPolicy, null);
    const journal = "2026-10-03T10-01-00-000Z_9998_abcdef";
    const linked = "2026-10-03T10-01-00-000Z_demo_aaaa33";
    makeRun(root, linked, {
      run: { invocation: { id: journal, index: 1, total: 1 } },
    });
    write(
      root,
      `_invocations/${journal}/invocation.json`,
      JSON.stringify({ version: 1, invocationId: journal, status: "passed" }),
    );
    write(
      root,
      `_invocations/${journal}/events.ndjson`,
      JSON.stringify({
        ts: "2026-10-03T10:00:00.000Z",
        type: "invocation.started",
        invocationId: journal,
        planned: 1,
      }),
    );
    assert.equal(runs.readRunDetail(path.join(root, linked)).runPolicy, null);
  });

  it("carries the run's metrics document", () => {
    const root = tempDir("cairn-metrics-detail-");
    const runId = "2026-10-03T10-00-00-000Z_demo_aaaa44";
    const dir = makeRun(root, runId);
    write(
      dir,
      "diagnostics/metrics.json",
      JSON.stringify({
        metrics: [{ name: "depth", scope: "spec", delta: 2, failures: 0 }],
      }),
    );
    const detail = runs.readRunDetail(dir);
    assert.equal(detail.metrics?.metrics[0].name, "depth");
  });
});
