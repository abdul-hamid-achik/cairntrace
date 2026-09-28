/**
 * CLI plumbing: argv construction, stream decoding, binary resolution.
 *
 * These are the contracts the whole app rests on — a wrong flag means the
 * desktop app silently does something other than what its UI claims.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const cli = require("../lib/cli");
const { cleanup, tempDir, write } = require("./helpers");

after(cleanup);

describe("buildRunArgv", () => {
  it("always pins the machine-readable output contract", () => {
    const argv = cli.buildRunArgv({ specs: ["/p/flows/a.yml"] });
    assert.deepEqual(argv.slice(0, 2), ["run", "/p/flows/a.yml"]);
    assert.ok(argv.includes("--format"));
    assert.equal(argv[argv.indexOf("--format") + 1], "json");
    assert.equal(argv[argv.indexOf("--log-format") + 1], "json");
    assert.equal(argv[argv.indexOf("--progress") + 1], "plain");
    assert.equal(argv[argv.indexOf("--log-level") + 1], "info");
  });

  it("maps every run option onto its flag", () => {
    const argv = cli.buildRunArgv({
      specs: ["/p/a.yml", "/p/b.yml"],
      env: "staging",
      backend: "playwright",
      provider: "browserbase",
      device: "iPhone 15 Pro",
      config: "/p/cairntrace.config.yml",
      artifactRoot: "/tmp/runs",
      junit: "/tmp/junit.xml",
      headed: true,
      coldStart: true,
      monitor: true,
      noWebServer: true,
      noServices: true,
      stashOnFailure: true,
      parallel: 3,
      vars: ["user=casey"],
      labels: ["path=legacy", "cohort=a"],
      tags: ["smoke"],
      logLevel: "debug",
    });
    const joined = argv.join(" ");
    for (const expected of [
      "--env staging",
      "--backend playwright",
      "--provider browserbase",
      "--device iPhone 15 Pro",
      "--config /p/cairntrace.config.yml",
      "--artifact-root /tmp/runs",
      "--junit /tmp/junit.xml",
      "--headed",
      "--cold-start",
      "--monitor",
      "--no-web-server",
      "--no-services",
      "--stash-on-failure",
      "--parallel 3",
      "--var user=casey",
      "--label path=legacy",
      "--label cohort=a",
      "--tag smoke",
      "--log-level debug",
    ])
      assert.ok(joined.includes(expected), `missing ${expected} in ${joined}`);
    assert.equal(argv[1], "/p/a.yml");
    assert.equal(argv[2], "/p/b.yml");
  });

  it("drops empty specs, blank repeatables, and parallel=1", () => {
    const argv = cli.buildRunArgv({
      specs: ["/p/a.yml", "", null],
      parallel: 1,
      vars: ["", "  ", "ok=1"],
      labels: [],
    });
    assert.equal(argv.filter((entry) => entry === "/p/a.yml").length, 1);
    assert.ok(!argv.includes("--parallel"));
    assert.deepEqual(argv.slice(argv.indexOf("--var")), [
      "--var",
      "ok=1",
      "--progress",
      "plain",
      "--format",
      "json",
      "--log-format",
      "json",
      "--log-level",
      "info",
    ]);
  });
});

describe("other argv builders", () => {
  it("builds spec verify with config, env, vars, and --stamp", () => {
    assert.deepEqual(
      cli.buildVerifyArgv({
        spec: "/p/a.yml",
        config: "/p/c.yml",
        env: "local",
        stamp: true,
        vars: ["k=v"],
      }),
      [
        "spec",
        "verify",
        "/p/a.yml",
        "--config",
        "/p/c.yml",
        "--env",
        "local",
        "--stamp",
        "--var",
        "k=v",
        "--format",
        "json",
      ],
    );
  });

  it("builds spec heal with apply/verify gating", () => {
    const argv = cli.buildHealArgv({
      spec: "/p/a.yml",
      backend: "playwright",
      apply: true,
      verify: true,
    });
    assert.ok(argv.includes("--apply"));
    assert.ok(argv.includes("--verify"));
    assert.equal(argv[argv.indexOf("--backend") + 1], "playwright");
    assert.equal(argv[argv.length - 1], "json");
  });

  it("builds stats and diff argv", () => {
    assert.deepEqual(
      cli.buildStatsArgv({
        groupBy: "path",
        metric: "ms",
        baseline: "legacy",
        limit: 25,
        includeRuns: true,
        artifactRoot: "/tmp/runs",
        labels: ["cohort=a"],
      }),
      [
        "stats",
        "--group-by",
        "path",
        "--metric",
        "ms",
        "--baseline",
        "legacy",
        "--limit",
        "25",
        "--include-runs",
        "--artifact-root",
        "/tmp/runs",
        "--label",
        "cohort=a",
        "--format",
        "json",
      ],
    );
    assert.deepEqual(cli.buildDiffArgv({ a: "latest", b: "previous" }), [
      "diff",
      "latest",
      "previous",
      "--format",
      "json",
    ]);
  });

  it("rejects a stats argv without a group-by key", () => {
    assert.throws(() => cli.buildStatsArgv({ groupBy: "" }), /group/);
  });
});

describe("createLineDecoder", () => {
  it("buffers partial lines across chunks", () => {
    const decoder = cli.createLineDecoder();
    assert.deepEqual(decoder.push('{"level":"info","msg":"he'), []);
    const events = decoder.push('llo"}\n{"level":"warn","msg":"x"}\n');
    assert.deepEqual(events, [
      { level: "info", msg: "hello" },
      { level: "warn", msg: "x" },
    ]);
    assert.deepEqual(decoder.flush(), []);
  });

  it("wraps non-JSON noise instead of dropping it", () => {
    const decoder = cli.createLineDecoder();
    const events = decoder.push("panic: runtime error\n");
    assert.deepEqual(events, [{ level: "raw", msg: "panic: runtime error" }]);
  });

  it("flushes a trailing unterminated line", () => {
    const decoder = cli.createLineDecoder();
    decoder.push('{"level":"error","msg":"cut off"');
    const flushed = decoder.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].level, "raw");
  });
});

describe("parseJsonPayload", () => {
  it("parses a pretty-printed run payload", () => {
    const payload = cli.parseJsonPayload(
      JSON.stringify({ runId: "abc", steps: [1, 2] }, null, 2),
    );
    assert.deepEqual(payload, { runId: "abc", steps: [1, 2] });
  });

  it("recovers the outermost document when noise precedes it", () => {
    const noise = "warning: something odd\n";
    const payload = cli.parseJsonPayload(
      `${noise}${JSON.stringify({ ok: true }, null, 2)}`,
    );
    assert.deepEqual(payload, { ok: true });
  });

  it("ignores braces inside strings while scanning", () => {
    const payload = cli.parseJsonPayload(
      `junk\n${JSON.stringify({ note: "a } b { c" })}`,
    );
    assert.deepEqual(payload, { note: "a } b { c" });
  });

  it("returns null for empty or hopeless input", () => {
    assert.equal(cli.parseJsonPayload(""), null);
    assert.equal(cli.parseJsonPayload("   \n"), null);
    assert.equal(cli.parseJsonPayload("not json at all"), null);
  });
});

describe("describeExitCode", () => {
  it("matches the documented exit-code contract", () => {
    assert.equal(cli.describeExitCode(0), "success");
    assert.equal(cli.describeExitCode(1), "outcome failure");
    assert.equal(cli.describeExitCode(2), "errored");
    assert.equal(cli.describeExitCode(3), "cold-start gate");
    assert.equal(cli.describeExitCode(4), "lint failure");
    assert.equal(cli.describeExitCode(5), "heal made no progress");
    assert.equal(cli.describeExitCode(6), "contract-hash mismatch");
    assert.equal(cli.describeExitCode(null), "terminated by signal");
    assert.equal(cli.describeExitCode(9), "exit 9");
  });
});

describe("resolveCairn", () => {
  const makeFakeBin = () => {
    const dir = tempDir("cairn-bin-");
    const bin = write(dir, "cairn", "#!/bin/sh\necho 9.9.9\n");
    fs.chmodSync(bin, 0o755);
    return { dir, bin };
  };

  it("prefers an explicit configured binary", () => {
    const { bin } = makeFakeBin();
    const resolved = cli.resolveCairn({
      configured: bin,
      env: { PATH: "/usr/bin" },
    });
    assert.equal(resolved.command, bin);
    assert.equal(resolved.source, "settings");
  });

  it("falls back to PATH when the configured binary is missing", () => {
    const { dir, bin } = makeFakeBin();
    const resolved = cli.resolveCairn({
      configured: path.join(dir, "nope"),
      env: { PATH: dir },
    });
    assert.equal(resolved.command, bin);
    assert.equal(resolved.source, "path");
  });

  it("falls back to a repo checkout's bin/cairn", () => {
    const repo = tempDir("cairn-repo-");
    const bin = write(repo, "bin/cairn", "#!/bin/sh\n");
    fs.chmodSync(bin, 0o755);
    const resolved = cli.resolveCairn({
      env: { PATH: "/nonexistent" },
      repoRoot: repo,
    });
    assert.equal(resolved.command, bin);
    assert.equal(resolved.source, "repo");
  });

  it("reports none (with candidates) when nothing resolves", () => {
    const resolved = cli.resolveCairn({
      configured: "/nope/cairn",
      env: { PATH: "/nonexistent" },
      repoRoot: "/nope",
    });
    assert.equal(resolved.command, null);
    assert.equal(resolved.source, "none");
    assert.ok(resolved.candidates.includes("/nope/cairn"));
  });

  it("augments PATH with the toolchain dirs a GUI app never inherits", () => {
    const env = cli.augmentedEnv({ PATH: "/usr/bin" });
    const dirs = String(env.PATH).split(":");
    assert.ok(dirs.includes("/usr/bin"));
    for (const extra of cli.EXTRA_PATH_DIRS)
      assert.ok(dirs.includes(extra), `missing ${extra}`);
    assert.equal(env.NO_COLOR, "1");
  });
});

describe("execCairn", () => {
  it("collects stdout payload, stderr logs, and the exit code", async () => {
    const dir = tempDir("cairn-exec-");
    const bin = write(
      dir,
      "fake-cairn",
      [
        "#!/bin/sh",
        'echo \'{"level":"info","scope":"run","msg":"starting"}\' 1>&2',
        'echo "not json noise" 1>&2',
        'printf "{\\n  \\"runId\\": \\"r1\\",\\n  \\"status\\": \\"passed\\"\\n}\\n"',
        "exit 1",
      ].join("\n"),
    );
    fs.chmodSync(bin, 0o755);
    const result = await cli.execCairn({
      command: bin,
      argv: [],
      timeoutMs: 15_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.payload, { runId: "r1", status: "passed" });
    assert.equal(result.logs[0].msg, "starting");
    assert.equal(result.logs[1].level, "raw");
  });

  it("kills a wedged child at the deadline", async () => {
    const dir = tempDir("cairn-hang-");
    const bin = write(dir, "hang", ["#!/bin/sh", "sleep 30"].join("\n"));
    fs.chmodSync(bin, 0o755);
    const started = Date.now();
    const result = await cli.execCairn({
      command: bin,
      argv: [],
      timeoutMs: 400,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 8_000, "deadline was not enforced");
  });

  it("cancels the whole process tree on abort", async () => {
    const dir = tempDir("cairn-abort-");
    // The grandchild inherits our pipes, which is exactly the case that used
    // to keep a cancelled run alive.
    const bin = write(
      dir,
      "spawn-child",
      ["#!/bin/sh", "sleep 30 &", "wait"].join("\n"),
    );
    fs.chmodSync(bin, 0o755);
    const controller = new AbortController();
    const started = Date.now();
    const pending = cli.execCairn({
      command: bin,
      argv: [],
      timeoutMs: 0,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 8_000, "abort did not settle promptly");
  });

  it("reports a spawn failure instead of hanging", async () => {
    await assert.rejects(
      () =>
        cli.execCairn({
          command: "/definitely/not/here",
          argv: [],
          timeoutMs: 1000,
        }),
      /not|exist|ENOENT/i,
    );
  });
});
