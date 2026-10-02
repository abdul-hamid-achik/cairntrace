/**
 * Invocation journals: listing, pid liveness ("aborted" when the process is
 * gone), id validation, and the history-based ETA.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const invocations = require("../lib/invocations");
const { cleanup, tempDir, write } = require("./helpers");

after(cleanup);

const ID_A = "2026-10-01T08-59-50-000Z_4242_abc123";
const ID_B = "2026-10-01T10-00-00-000Z_5151_def456";

/**
 * @param {string} root
 * @param {string} id
 * @param {Record<string, any>} [overrides]
 */
function journal(root, id, overrides = {}) {
  write(
    root,
    `_invocations/${id}/invocation.json`,
    JSON.stringify({
      version: 1,
      invocationId: id,
      pid: 4242,
      argv: [
        "cairn",
        "run",
        "flows/a.yml",
        "flows/b.yml",
        "--label",
        "token=[redacted]",
      ],
      cwd: "/tmp/project",
      parallel: 1,
      planned: [
        { index: 1, spec: "flows/a.yml" },
        { index: 2, spec: "flows/b.yml", labels: { round: "2" } },
        { index: 3, spec: "flows/c.yml" },
      ],
      status: "running",
      startedAt: "2026-10-01T08:59:50.000Z",
      current: {
        index: 2,
        spec: "flows/b.yml",
        runId: "2026-10-01T09-01-00-000Z_b_aaaaaa",
      },
      runs: [
        {
          index: 1,
          spec: "flows/a.yml",
          runId: "2026-10-01T09-00-00-000Z_a_bbbbbb",
          runDir: "x",
          status: "passed",
        },
      ],
      ...overrides,
    }),
  );
}

describe("invocation ids", () => {
  it("accepts the runner's id shape and rejects traversal", () => {
    assert.equal(invocations.isInvocationId(ID_A), true);
    assert.equal(invocations.isInvocationId("../etc"), false);
    assert.equal(invocations.isInvocationId(`${ID_A}/..`), false);
    assert.equal(invocations.invocationDir("/tmp/runs", "../../x"), null);
    assert.equal(
      invocations.invocationDir("/tmp/runs", ID_A),
      path.resolve("/tmp/runs/_invocations", ID_A),
    );
  });
});

describe("listInvocations", () => {
  it("lists journals newest first and ignores junk", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A);
    journal(root, ID_B, {
      status: "passed",
      endedAt: "2026-10-01T10:05:00.000Z",
    });
    fs.mkdirSync(path.join(root, "_invocations", "not-an-id"), {
      recursive: true,
    });
    write(
      root,
      `_invocations/${"2026-10-01T11-00-00-000Z_1_aaaaaa"}/invocation.json`,
      "{broken",
    );
    const list = invocations.listInvocations(root, { pidAlive: () => true });
    assert.deepEqual(
      list.map((entry) => [entry.invocationId, entry.status, entry.alive]),
      [
        [ID_B, "passed", false],
        [ID_A, "running", true],
      ],
    );
    assert.equal(list[1].planned[1].labels.round, "2");
    assert.equal(list[1].current.index, 2);
  });

  it("reports a running journal whose pid is gone as aborted", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A);
    const [entry] = invocations.listInvocations(root, {
      pidAlive: () => false,
    });
    assert.equal(entry.status, "aborted");
    assert.equal(entry.alive, false);
    assert.equal(entry.pidAlive, false);
  });

  it("returns [] for an artifact root without journals", () => {
    assert.deepEqual(invocations.listInvocations(tempDir("cairn-inv-")), []);
  });
});

describe("estimateInvocationEta", () => {
  it("sums p50 of unfinished planned specs minus the current run's elapsed time", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A);
    const [entry] = invocations.listInvocations(root, { pidAlive: () => true });
    const now = Date.parse("2026-10-01T09:02:00.000Z");
    const eta = invocations.estimateInvocationEta(
      entry,
      { b: { p50: 90_000, n: 4 }, "flows/c.yml": { p50: 30_000, n: 2 } },
      { now, currentStartedAtMs: Date.parse("2026-10-01T09:01:00.000Z") },
    );
    // b: 90s - 60s elapsed = 30s; c: 30s → 60s
    assert.deepEqual(eta, {
      etaMs: 60_000,
      known: 2,
      unknown: 0,
      done: 1,
      total: 3,
    });
  });

  it("counts specs without history as unknown and divides by parallelism", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A, { parallel: 2, runs: [], current: null });
    const [entry] = invocations.listInvocations(root, { pidAlive: () => true });
    const eta = invocations.estimateInvocationEta(entry, {
      a: { p50: 40_000, n: 1 },
    });
    assert.deepEqual(eta, {
      etaMs: 20_000,
      known: 1,
      unknown: 2,
      done: 0,
      total: 3,
    });
    assert.equal(invocations.estimateInvocationEta(entry, {}).etaMs, null);
  });
});

describe("readInvocation — origin, liveness, logs", () => {
  it("passes origin/client through and treats them as optional", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A, { origin: "mcp", client: "claude-code\u0007 \n v2" });
    journal(root, ID_B, { status: "passed" });
    const [b, a] = invocations.listInvocations(root, { pidAlive: () => true });
    assert.equal(a.origin, "mcp");
    assert.equal(a.client, "claude-code v2");
    assert.equal(b.origin, null);
    assert.equal(b.client, null);
    // Junk origins are dropped, long client names capped.
    journal(root, ID_A, { origin: "<b>x</b>", client: "c".repeat(300) });
    const again = invocations.readInvocation(root, ID_A, {
      pidAlive: () => true,
    });
    assert.equal(again?.origin, null);
    assert.equal(again?.client?.length, 80);
  });

  it("classifies liveness heartbeat → pid → mtime", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A);
    const now = Date.parse("2026-10-01T09:00:20.000Z");
    write(
      root,
      `_invocations/${ID_A}/events.ndjson`,
      `${JSON.stringify({
        ts: "2026-10-01T09:00:05.000Z",
        type: "run.heartbeat",
        phase: "services",
        elapsedMs: 15000,
        pid: 4242,
      })}\n`,
    );
    const fresh = invocations.readInvocation(root, ID_A, {
      pidAlive: () => true,
      now,
    });
    assert.equal(fresh?.liveness.state, "running");
    assert.equal(fresh?.liveness.reason, "heartbeat");
    assert.equal(fresh?.liveness.heartbeatTs, "2026-10-01T09:00:05.000Z");
    const quiet = invocations.readInvocation(root, ID_A, {
      pidAlive: () => true,
      now: now + 10 * 60_000,
    });
    assert.equal(quiet?.liveness.state, "quiet");
    const dead = invocations.readInvocation(root, ID_A, {
      pidAlive: () => false,
      now,
    });
    assert.equal(dead?.liveness.state, "dead");
    assert.equal(dead?.status, "aborted");
    journal(root, ID_B, { status: "failed" });
    const done = invocations.readInvocation(root, ID_B);
    assert.equal(done?.liveness.state, "finished");
  });

  it("lists journal logs in reading order", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A);
    const dir = `_invocations/${ID_A}/logs`;
    write(root, `${dir}/hook-after-01-run_x.log`, "after\n");
    write(root, `${dir}/hook-before-01.log`, "before\n");
    write(root, `${dir}/services-docker.log`, "up\n");
    write(root, `${dir}/narration.log`, "[09:00:00] start\n");
    write(root, `${dir}/.tmp`, "hidden");
    const entry = invocations.readInvocation(root, ID_A, {
      pidAlive: () => true,
    });
    assert.deepEqual(
      entry?.logs.map((log) => log.path),
      [
        "logs/narration.log",
        "logs/services-docker.log",
        "logs/hook-before-01.log",
        "logs/hook-after-01-run_x.log",
      ],
    );
    assert.equal(entry?.logs[0].bytes, 17);
  });
});

describe("stop safety checks", () => {
  it("parses ps elapsed times and lines", () => {
    assert.equal(invocations.parseEtime("00:05"), 5000);
    assert.equal(invocations.parseEtime("12:34"), (12 * 60 + 34) * 1000);
    assert.equal(invocations.parseEtime("01:00:00"), 3_600_000);
    assert.equal(invocations.parseEtime("2-00:00:01"), 2 * 86_400_000 + 1000);
    assert.equal(invocations.parseEtime("soon"), null);
    assert.deepEqual(
      invocations.parsePsLine(
        "  812   03:10 /opt/bin/bun /repo/bin/cairn run a.yml\n",
      ),
      {
        pgid: 812,
        elapsedMs: 190_000,
        command: "/opt/bin/bun /repo/bin/cairn run a.yml",
      },
    );
    // No pgid column (or no elapsed time): not a line this reader asked for.
    assert.equal(invocations.parsePsLine("   03:10 /repo/bin/cairn run"), null);
    assert.equal(invocations.parsePsLine(""), null);
  });

  it("recognises cairn command lines and nothing else", () => {
    // `ps` joins argv with spaces: a script path with spaces arrives split
    // and is accepted only when it names a real file.
    const spaced = write(tempDir("cairn-inv-"), "My Projects/bin/cairn", "");
    const yes = [
      "/usr/local/bin/cairn run flows/a.yml",
      "cairn mcp",
      "/opt/homebrew/bin/bun /repo/bin/cairn run a.yml",
      "bun --smol /repo/node_modules/.bin/cairn run",
      "bun --cwd /tmp /repo/bin/cairn run a.yml",
      "node /x/bin/cairn run",
      "/bin/sh /tmp/bin/cairn run",
      `bun ${spaced} run a.yml`,
      `${spaced} run a.yml`,
    ];
    const no = [
      "vim /repo/bin/cairn",
      "/usr/bin/vim /tmp/cairn",
      "/usr/bin/python3 cairn.py",
      "bun run test",
      "node --inspect server.js /repo/bin/cairn",
      "node server /repo/bin/cairn",
      "bun /no/such dir/bin/cairn run",
      "/Applications/Cairntrace Studio.app/Contents/MacOS/Cairntrace Studio",
      "cairn-helper run",
      "",
    ];
    for (const command of yes)
      assert.equal(invocations.isCairnCommand(command), true, command);
    for (const command of no)
      assert.equal(invocations.isCairnCommand(command), false, command);
    const sub = (/** @type {string} */ command) =>
      invocations.parseCairnCommand(command)?.subcommand;
    assert.equal(sub("bun ./bin/cairn mcp"), "mcp");
    assert.equal(sub(`bun ${spaced} run a.yml`), "run");
    assert.equal(sub("cairn --log-level debug --quiet run a.yml"), "run");
    assert.equal(sub("cairn --log-format=json mcp"), "mcp");
    assert.equal(sub("/usr/local/bin/cairn"), null);
  });

  it("allows SIGINT only to a live cairn process that owns the journal", () => {
    const root = tempDir("cairn-inv-");
    journal(root, ID_A);
    const running = invocations.readInvocation(root, ID_A, {
      pidAlive: () => true,
    });
    const now = Date.parse("2026-10-01T09:05:00.000Z");
    // Started 5m10s before `now`: before the journal's startedAt (09:00:50 − 1m).
    const info = {
      pgid: 900,
      elapsedMs: 310_000,
      command: "/usr/local/bin/cairn run a",
    };
    assert.deepEqual(
      invocations.checkStoppable(running, info, { now, selfPid: 1 }),
      {
        ok: true,
        pid: 4242,
        command: info.command,
        subcommand: "run",
        mcp: false,
        group: false,
      },
    );
    // cairn leads its own process group (a terminal job, a Studio run): the
    // group is signalled, unless Studio itself is in it.
    assert.equal(
      invocations.checkStoppable(running, { ...info, pgid: 4242 }, { now })
        .group,
      true,
    );
    assert.equal(
      invocations.checkStoppable(
        running,
        { ...info, pgid: 4242 },
        { now, selfPgid: 4242 },
      ).group,
      false,
    );
    const refuse = (/** @type {any} */ result) => {
      assert.equal(result.ok, false);
      return result.reason;
    };
    assert.match(
      refuse(
        invocations.checkStoppable(
          running,
          { ...info, command: "sleep 99" },
          {
            now,
          },
        ),
      ),
      /not a cairn process/,
    );
    assert.match(
      refuse(invocations.checkStoppable(running, null, { now })),
      /is gone/,
    );
    // A process younger than the journal: the pid was reused.
    assert.match(
      refuse(
        invocations.checkStoppable(
          running,
          { ...info, elapsedMs: 10_000 },
          {
            now,
          },
        ),
      ),
      /pid reused/,
    );
    assert.match(
      refuse(invocations.checkStoppable(running, info, { now, selfPid: 4242 })),
      /refusing to signal/,
    );
    // The journal's pid must match the pid encoded in its id.
    journal(root, ID_A, { pid: 999 });
    assert.match(
      refuse(
        invocations.checkStoppable(
          invocations.readInvocation(root, ID_A, { pidAlive: () => true }),
          info,
          { now },
        ),
      ),
      /does not match/,
    );
    // Finished journals are never stoppable.
    journal(root, ID_B, { status: "passed", pid: 5151 });
    assert.match(
      refuse(
        invocations.checkStoppable(
          invocations.readInvocation(root, ID_B),
          info,
          { now },
        ),
      ),
      /already ended/,
    );
    assert.match(refuse(invocations.checkStoppable(null, info)), /unknown/);
  });

  it("tells an MCP server from its command line, not only the journal", () => {
    const root = tempDir("cairn-inv-");
    const now = Date.parse("2026-10-01T09:05:00.000Z");
    const mcpInfo = {
      pgid: 77,
      elapsedMs: 310_000,
      command: "/opt/homebrew/bin/bun /repo/bin/cairn mcp",
    };
    const read = () =>
      invocations.readInvocation(root, ID_A, { pidAlive: () => true });
    const refuse = (/** @type {any} */ result) => {
      assert.equal(result.ok, false);
      return result.reason;
    };
    // No origin (an older runner, or a journal written by hand): the
    // command line still says MCP server.
    journal(root, ID_A);
    const verdict = invocations.checkStoppable(read(), mcpInfo, { now });
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.mcp, true);
    assert.equal(verdict.subcommand, "mcp");
    // A journal that claims a CLI run but points at an MCP server, or the
    // other way round, is refused.
    journal(root, ID_A, { origin: "cli" });
    assert.match(
      refuse(invocations.checkStoppable(read(), mcpInfo, { now })),
      /origin "cli" but process 4242 is `cairn mcp`/,
    );
    journal(root, ID_A, { origin: "mcp" });
    assert.match(
      refuse(
        invocations.checkStoppable(
          read(),
          { ...mcpInfo, command: "cairn run a.yml" },
          { now },
        ),
      ),
      /origin "mcp" but process 4242 is `cairn run`/,
    );
    // Other cairn commands never own a journal.
    journal(root, ID_A);
    assert.match(
      refuse(
        invocations.checkStoppable(
          read(),
          { ...mcpInfo, command: "cairn studio-helper" },
          { now },
        ),
      ),
      /runs no invocations/,
    );
    // Without a start time a reused pid cannot be ruled out: refused.
    journal(root, ID_A, { startedAt: null });
    assert.match(
      refuse(invocations.checkStoppable(read(), mcpInfo, { now })),
      /no start time/,
    );
  });

  it("reads real process info for this process and null for a free pid", async () => {
    const self = await invocations.readProcessInfo(process.pid);
    assert.ok(self);
    assert.match(self.command, /node/);
    assert.ok(Number.isSafeInteger(self.pgid) && self.pgid > 0, "pgid");
    assert.equal(await invocations.readProcessInfo(-1), null);
    assert.equal(await invocations.readProcessInfo(2 ** 22 + 12345), null);
  });
});
