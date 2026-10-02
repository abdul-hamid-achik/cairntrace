import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsCommand } from "./logs";

/**
 * `cairn logs --follow` / `--log` / `--invocation`: tail until the run or
 * invocation settles, stop (exit 2) when its process died without settling.
 */
let runsRoot: string;
let captured: string[];
let errors: string[];
let spies: Array<{ mockRestore(): void }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEAD_PID = 2_147_483_000;
const INVOCATION_ID = "2026-10-01T00-00-00-000Z_4242_a1b2c3";

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-logs-follow-"));
  captured = [];
  errors = [];
  spies = [
    vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        captured.push(String(chunk));
        return true;
      }),
    vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        errors.push(String(chunk));
        return true;
      }),
  ];
  process.exitCode = 0;
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  process.exitCode = 0;
});

async function makeRun(name: string, events: string[]): Promise<string> {
  const dir = join(runsRoot, name);
  await mkdir(join(dir, "logs"), { recursive: true });
  await writeFile(join(dir, "events.ndjson"), events.join(""));
  return dir;
}

async function writeJournal(status: string, pid: number): Promise<string> {
  const dir = join(runsRoot, "_invocations", INVOCATION_ID);
  await mkdir(join(dir, "logs"), { recursive: true });
  await writeFile(
    join(dir, "invocation.json"),
    JSON.stringify({
      version: 1,
      invocationId: INVOCATION_ID,
      pid,
      argv: ["run", "a.yml"],
      cwd: "/work",
      parallel: 1,
      planned: [{ index: 1, spec: "a.yml" }],
      status,
      startedAt: "2026-10-01T00:00:00.000Z",
      runs: [],
      ...(status !== "running"
        ? {
            endedAt: "2026-10-01T00:00:05.000Z",
            summary: {
              total: 1,
              passed: 1,
              failed: 0,
              errored: 0,
              durationMs: 5000,
              exitCode: 0,
            },
          }
        : {}),
    }),
  );
  return dir;
}

describe("cairn logs --follow", () => {
  it("tails events.ndjson until the run's manifest lands", async () => {
    const dir = await makeRun("live_run", ['{"type":"run.started"}\n']);
    const following = logsCommand("live_run", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    await sleep(80);
    expect(captured.join("")).toBe('{"type":"run.started"}\n');
    await appendFile(join(dir, "events.ndjson"), '{"type":"step.star');
    await sleep(60);
    // A torn line is held back until its newline lands.
    expect(captured.join("")).not.toContain("step.star");
    await appendFile(
      join(dir, "events.ndjson"),
      'ted"}\n{"type":"run.passed"}\n',
    );
    await writeFile(join(dir, "artifact-manifest.json"), "{}");
    await following;
    expect(process.exitCode).toBe(0);
    expect(captured.join("")).toBe(
      '{"type":"run.started"}\n{"type":"step.started"}\n{"type":"run.passed"}\n',
    );
  });

  it("stops with exit 2 when the writer process is gone", async () => {
    await makeRun("dead_run", [
      '{"type":"run.started"}\n',
      `{"type":"run.heartbeat","pid":${DEAD_PID}}\n`,
    ]);
    await logsCommand("dead_run", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(2);
    expect(captured.join("")).toContain("run.heartbeat");
    expect(errors.join("")).toContain("interrupted");
  });

  it("follows a group of live logs with tail-style headers", async () => {
    const dir = await makeRun("log_run", []);
    await writeFile(join(dir, "logs", "precondition-01-seed.log"), "seeding\n");
    const following = logsCommand("log_run", {
      artifactRoot: runsRoot,
      follow: true,
      log: "precondition",
      pollMs: 20,
    });
    await sleep(60);
    await writeFile(join(dir, "logs", "precondition-02-quiesce.log"), "idle");
    await writeFile(join(dir, "artifact-manifest.json"), "{}");
    await following;
    expect(captured.join("")).toBe(
      "==> logs/precondition-01-seed.log <==\nseeding\n" +
        "==> logs/precondition-02-quiesce.log <==\nidle\n",
    );
  });

  it("prints one log once without --follow", async () => {
    const dir = await makeRun("once_run", []);
    await writeFile(join(dir, "run.log"), "[00:00:01] run start: demo\n");
    await logsCommand("once_run", { artifactRoot: runsRoot, log: "run" });
    expect(process.exitCode).toBe(0);
    expect(captured.join("")).toBe("[00:00:01] run start: demo\n");

    captured.length = 0;
    await logsCommand("once_run", { artifactRoot: runsRoot, log: "outcome" });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("no outcome log");
  });

  it("follows an invocation until its journal settles", async () => {
    const jdir = await writeJournal("running", process.pid);
    await writeFile(
      join(jdir, "events.ndjson"),
      '{"type":"invocation.started"}\n',
    );
    await writeFile(join(jdir, "logs", "narration.log"), "[00:00:00] start\n");
    const following = logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: "latest",
      follow: true,
      log: "narration",
      pollMs: 20,
    });
    await sleep(60);
    await appendFile(join(jdir, "logs", "narration.log"), "[00:00:05] end\n");
    await writeJournal("passed", process.pid);
    await following;
    expect(process.exitCode).toBe(0);
    expect(captured.join("")).toBe("[00:00:00] start\n[00:00:05] end\n");
  });

  it("stops following an invocation whose process died", async () => {
    const jdir = await writeJournal("running", DEAD_PID);
    await writeFile(
      join(jdir, "events.ndjson"),
      '{"type":"invocation.started"}\n',
    );
    await logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: INVOCATION_ID,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(2);
    expect(captured.join("")).toBe('{"type":"invocation.started"}\n');
  });

  it("summarizes an invocation as JSON or markdown", async () => {
    await writeJournal("passed", DEAD_PID);
    await logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: "latest",
      format: "json",
    });
    expect(JSON.parse(captured.join(""))).toMatchObject({
      invocationId: INVOCATION_ID,
      status: "passed",
    });
    captured.length = 0;
    await logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: "latest",
    });
    expect(captured.join("")).toContain("1/1 passed");

    await logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: "previous",
    });
    expect(process.exitCode).toBe(2);
  });

  it("does not list the invocation journals as a run", async () => {
    await makeRun("2026-10-01T00-00-00-000Z_demo_aaaaaa", []);
    await writeJournal("passed", DEAD_PID);
    const now = new Date();
    await utimes(join(runsRoot, "_invocations"), now, now);
    await logsCommand(undefined, { artifactRoot: runsRoot });
    const text = captured.join("");
    expect(text).toContain("_demo_aaaaaa");
    expect(text).not.toContain("_invocations");
  });
});

describe("cairn logs with an invocation journal beside the runs", () => {
  it("never resolves latest/previous to the _invocations directory", async () => {
    // A first invocation that failed before any run: only the journal exists,
    // and it is the newest directory under the artifact root.
    await writeJournal("errored", DEAD_PID);
    const now = new Date();
    await utimes(join(runsRoot, "_invocations"), now, now);
    await logsCommand("latest", { artifactRoot: runsRoot });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toBe(
      "cairn logs: no run available at slot latest\n",
    );

    await makeRun("2026-10-01T00-00-00-000Z_demo_aaaaaa", []);
    await utimes(join(runsRoot, "_invocations"), now, now);
    process.exitCode = 0;
    await logsCommand("previous", { artifactRoot: runsRoot });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("no run available at slot previous");
    process.exitCode = 0;
    await logsCommand("latest", { artifactRoot: runsRoot });
    expect(captured.join("")).toContain("_demo_aaaaaa");
    expect(captured.join("")).not.toContain("_invocations");
  });

  async function unreadableJournal(id: string, events: string): Promise<void> {
    const dir = join(runsRoot, "_invocations", id);
    await mkdir(join(dir, "logs"), { recursive: true });
    // A status this build does not know: unreadable, as from a newer cairn.
    await writeFile(
      join(dir, "invocation.json"),
      JSON.stringify({ version: 1, invocationId: id, status: "paused" }),
    );
    await writeFile(join(dir, "events.ndjson"), events);
  }

  it("settles an unreadable journal once its final event is written", async () => {
    const id = `2026-10-01T00-00-00-000Z_${process.pid}_a1b2c3`;
    await unreadableJournal(
      id,
      '{"type":"invocation.started"}\n{"type":"invocation.finished"}\n',
    );
    await logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: id,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(0);
  });

  it("stops following an unreadable journal whose writer (from its id) died", async () => {
    const id = `2026-10-01T00-00-00-000Z_${DEAD_PID}_a1b2c3`;
    await unreadableJournal(id, '{"type":"invocation.started"}\n');
    await logsCommand(undefined, {
      artifactRoot: runsRoot,
      invocation: id,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(2);
  });
});

describe("cairn logs latest --follow while a cairn run is still booting", () => {
  const OLD_RUN = "2026-10-01T00-00-00-000Z_demo_old_aaaaaa";
  const NEW_RUN = "2026-10-01T00-00-09-000Z_demo_new_bbbbbb";
  const LIVE_ID = `2026-10-01T00-00-05-000Z_${process.pid}_c3c3c3`;

  async function liveJournal(extra: Record<string, unknown>): Promise<void> {
    const dir = join(runsRoot, "_invocations", LIVE_ID);
    await mkdir(join(dir, "logs"), { recursive: true });
    // Atomic like the real journal writer (temp + rename): the follower
    // polls every 20ms and must never see a half-written file.
    const tmp = join(dir, `invocation.json.${process.pid}.tmp`);
    await writeFile(
      tmp,
      JSON.stringify({
        version: 1,
        invocationId: LIVE_ID,
        pid: process.pid,
        argv: ["run", "new.yml", "--before", "sleep 3"],
        cwd: "/work",
        parallel: 1,
        planned: [{ index: 1, spec: "new.yml" }],
        status: "running",
        startedAt: "2026-10-01T00:00:05.000Z",
        runs: [],
        ...extra,
      }),
    );
    await rename(tmp, join(dir, "invocation.json"));
  }

  beforeEach(async () => {
    // The previous run finished long ago: plain `latest` would pick it.
    const old = await makeRun(OLD_RUN, ['{"type":"run.passed","old":true}\n']);
    await writeFile(join(old, "artifact-manifest.json"), "{}");
  });

  it("waits for the live invocation's first run instead of the finished one", async () => {
    await liveJournal({});
    const following = logsCommand("latest", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    await sleep(100);
    expect(captured.join("")).toBe("");
    expect(errors.join("")).toContain(
      `invocation ${LIVE_ID} has not started a run yet`,
    );

    const dir = await makeRun(NEW_RUN, ['{"type":"run.started","new":true}\n']);
    await liveJournal({
      current: { index: 1, spec: "new.yml", runId: NEW_RUN },
      runs: [
        {
          index: 1,
          spec: "new.yml",
          runId: NEW_RUN,
          runDir: dir,
          status: "running",
        },
      ],
    });
    await sleep(100);
    await appendFile(join(dir, "events.ndjson"), '{"type":"run.passed"}\n');
    await writeFile(join(dir, "artifact-manifest.json"), "{}");
    await following;
    expect(process.exitCode).toBe(0);
    expect(captured.join("")).toBe(
      '{"type":"run.started","new":true}\n{"type":"run.passed"}\n',
    );
  });

  it("exits 2 when the invocation ends before it starts a run", async () => {
    await liveJournal({});
    const following = logsCommand("latest", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    await sleep(60);
    await liveJournal({
      status: "errored",
      endedAt: "2026-10-01T00:00:08.000Z",
    });
    await following;
    expect(process.exitCode).toBe(2);
    expect(captured.join("")).toBe("");
    expect(errors.join("")).toContain(
      `invocation ${LIVE_ID} ended (errored) before it started a run`,
    );
  });

  it("follows the newest run when no invocation is live", async () => {
    await writeJournal("passed", DEAD_PID);
    await logsCommand("latest", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(0);
    expect(captured.join("")).toBe('{"type":"run.passed","old":true}\n');
  });
});

describe("cairn logs errors on a run reference", () => {
  it("exits 2 with one line when there is no run to follow", async () => {
    await logsCommand("latest", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toBe(
      "cairn logs: no run available at slot latest\n",
    );
  });

  it("refuses --json/--format json on a run reference instead of ignoring it", async () => {
    await makeRun("2026-10-01T00-00-00-000Z_demo_aaaaaa", []);
    for (const opts of [{ json: true }, { format: "yaml" }]) {
      process.exitCode = 0;
      errors.length = 0;
      await logsCommand("latest", { artifactRoot: runsRoot, ...opts });
      expect(process.exitCode).toBe(2);
      expect(captured.join("")).toBe("");
      expect(errors.join("")).toContain("--invocation <id|latest|previous>");
    }
  });
});

describe("cairn logs --follow on runs without writer identity", () => {
  it("gives up on a run whose event log went silent long ago", async () => {
    const dir = await makeRun("old_run", ['{"type":"run.started"}\n']);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(join(dir, "events.ndjson"), longAgo, longAgo);
    await logsCommand("old_run", {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 20,
    });
    expect(process.exitCode).toBe(2);
    expect(captured.join("")).toBe('{"type":"run.started"}\n');
  });
});
