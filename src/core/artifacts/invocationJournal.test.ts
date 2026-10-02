import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvocationJournalSchema, RunEventSchema } from "../schema/events.v1";
import {
  INVOCATIONS_DIR,
  INVOCATION_ID_PATTERN,
  InvocationJournal,
  generateInvocationId,
  invocationIdPid,
  listInvocationIds,
  pruneInvocations,
  readInvocationJournal,
  redactArgv,
} from "./invocationJournal";
import { createArtifactRedactor } from "./redaction";
import { pruneRuns, specNameOfRunId } from "./retention";

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cairn-invocations-"));
}

function create(
  artifactRoot: string,
  overrides: Partial<Parameters<typeof InvocationJournal.create>[0]> = {},
): InvocationJournal {
  const journal = InvocationJournal.create({
    artifactRoot,
    argv: ["run", "a.yml", "b.yml"],
    cwd: "/work",
    parallel: 1,
    planned: [
      { index: 1, spec: "a.yml" },
      { index: 2, spec: "b.yml" },
    ],
    heartbeatIntervalMs: 0,
    ...overrides,
  });
  if (!journal) throw new Error("journal not created");
  return journal;
}

async function readJournal(journal: InvocationJournal) {
  return InvocationJournalSchema.parse(
    JSON.parse(await readFile(join(journal.dir, "invocation.json"), "utf8")),
  );
}

async function readEvents(
  dir: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(dir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("generateInvocationId", () => {
  it("never looks like a run directory id", () => {
    const id = generateInvocationId(
      new Date("2026-10-01T12:34:56.789Z"),
      4242,
      "a1b2c3",
    );
    expect(id).toBe("2026-10-01T12-34-56-789Z_4242_a1b2c3");
    expect(INVOCATION_ID_PATTERN.test(id)).toBe(true);
    expect(specNameOfRunId(INVOCATIONS_DIR)).toBeUndefined();
  });
});

describe("InvocationJournal", () => {
  it("journals a batch from start to a failed finish", async () => {
    const artifactRoot = await root();
    const journal = create(artifactRoot, { labels: { suite: "smoke" } });
    expect(journal.relativeDir).toBe(`_invocations/${journal.id}`);
    expect(journal.ref(2)).toEqual({
      id: journal.id,
      index: 2,
      total: 2,
      dir: journal.relativeDir,
    });

    let state = await readJournal(journal);
    expect(state).toMatchObject({
      version: 1,
      status: "running",
      pid: process.pid,
      parallel: 1,
      labels: { suite: "smoke" },
      runs: [],
    });

    journal.runStarting(1, "a.yml");
    journal.runStarted(1, "a.yml", "run-a", join(artifactRoot, "run-a"));
    state = await readJournal(journal);
    expect(state.current).toEqual({ index: 1, spec: "a.yml", runId: "run-a" });
    expect(state.runs).toEqual([
      {
        index: 1,
        spec: "a.yml",
        runId: "run-a",
        runDir: join(artifactRoot, "run-a"),
        status: "running",
      },
    ]);
    journal.runFinished({
      index: 1,
      spec: "a.yml",
      runId: "run-a",
      runDir: join(artifactRoot, "run-a"),
      status: "passed",
    });
    journal.runStarted(2, "b.yml", "run-b", join(artifactRoot, "run-b"));
    journal.runFinished({
      index: 2,
      spec: "b.yml",
      runId: "run-b",
      runDir: join(artifactRoot, "run-b"),
      status: "failed",
    });
    journal.narrate("[1/2] a.yml — starting…\n");
    journal.finish("failed", {
      total: 2,
      passed: 1,
      failed: 1,
      errored: 0,
      durationMs: 1200,
      exitCode: 1,
    });
    // The first terminal status wins.
    journal.abortSync("SIGINT");

    state = await readJournal(journal);
    expect(state.status).toBe("failed");
    expect(state.endedAt).toBeDefined();
    expect(state.summary).toMatchObject({ total: 2, failed: 1, exitCode: 1 });
    expect(state.runs.map((run) => run.status)).toEqual(["passed", "failed"]);

    const events = await readEvents(journal.dir);
    for (const event of events) {
      expect(
        RunEventSchema.safeParse(event).success,
        JSON.stringify(event),
      ).toBe(true);
    }
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "log.opened",
      "invocation.finished",
    ]);
    expect(events.at(-1)).toMatchObject({ status: "failed" });
    const narration = await readFile(
      join(journal.dir, "logs", "narration.log"),
      "utf8",
    );
    expect(narration).toMatch(
      /^\[\d\d:\d\d:\d\d\] \[1\/2\] a\.yml — starting…\n$/,
    );
  });

  it("marks the journal aborted synchronously on a signal", async () => {
    const journal = create(await root());
    journal.runStarted(1, "a.yml", "run-a", "/tmp/run-a");
    journal.abortSync("SIGTERM");
    const state = await readJournal(journal);
    expect(state).toMatchObject({ status: "aborted", signal: "SIGTERM" });
    expect(state.runs[0]?.status).toBe("running");
    const events = await readEvents(journal.dir);
    expect(events.at(-1)).toMatchObject({
      type: "invocation.finished",
      status: "aborted",
      signal: "SIGTERM",
    });
    // Nothing is rewritten after the terminal status.
    journal.runFinished({
      index: 1,
      spec: "a.yml",
      runId: "run-a",
      runDir: "/tmp/run-a",
      status: "passed",
    });
    expect((await readJournal(journal)).runs[0]?.status).toBe("running");
  });

  it("records the signal-path services teardown after the abort", async () => {
    const journal = create(await root());
    journal.abortSync("SIGINT");
    // The services teardown runs after the journal reporter aborted it.
    journal.appendServicesEvent({
      phase: "teardown",
      event: "signal",
      message: "teardown[0] completed (signal path)",
      timestamp: new Date().toISOString(),
      data: { index: 0, status: "completed", exitCode: 0 },
    });
    journal.appendServicesLogSync("teardown", "$ ./down.sh");
    journal.appendServicesLogSync("teardown", "[exit 0]");
    const events = await readEvents(journal.dir);
    const last = events.at(-1);
    expect(RunEventSchema.safeParse(last).success, JSON.stringify(last)).toBe(
      true,
    );
    expect(last).toMatchObject({
      type: "services.teardown.signal",
      data: { index: 0, status: "completed" },
    });
    expect(
      await readFile(
        join(journal.dir, "logs", "services-teardown.log"),
        "utf8",
      ),
    ).toBe("$ ./down.sh\n[exit 0]\n");
  });

  it("writes live services events, hook logs, and redacts everything", async () => {
    const redactor = createArtifactRedactor(undefined, {
      DEMO_API_TOKEN: "hunter2-demo-secret",
    });
    const journal = create(await root(), {
      argv: [
        "run",
        "a.yml",
        "--var",
        "password=plain-pass",
        "--before",
        "seed --token hunter2-demo-secret",
      ],
      redactor,
    });
    journal.appendServicesEvent({
      phase: "docker",
      event: "start",
      message: "docker compose up -d",
      timestamp: "2026-10-01T00:00:00.000Z",
    });
    journal.appendServicesEvent({
      phase: "docker",
      event: "not-a-real-event",
      message: "dropped",
      timestamp: "2026-10-01T00:00:00.000Z",
    });
    journal.servicesLog("seed").writeLine("seeding with hunter2-demo-secret");
    const { log, path } = journal.hookLog("before", 1);
    expect(path).toBe("logs/hook-before-01.log");
    log.write("token=hunter2-demo-secret\n");
    expect(journal.hookLog("before", 1).log).toBe(log);
    journal.finish("passed");

    const state = await readJournal(journal);
    expect(state.argv).toEqual([
      "run",
      "a.yml",
      "--var",
      "password=[redacted]",
      "--before",
      "seed --token [redacted]",
    ]);
    const events = await readEvents(journal.dir);
    expect(events.map((event) => event.type)).toEqual([
      "invocation.started",
      "log.opened",
      "services.docker.start",
      "log.opened",
      "log.opened",
      "invocation.finished",
    ]);
    expect(events[3]).toMatchObject({
      kind: "services",
      name: "seed",
      path: "logs/services-seed.log",
    });
    const seedLog = await readFile(
      join(journal.dir, "logs", "services-seed.log"),
      "utf8",
    );
    const hookLog = await readFile(
      join(journal.dir, "logs", "hook-before-01.log"),
      "utf8",
    );
    expect(seedLog).toBe("seeding with [redacted]\n");
    expect(hookLog).toBe("token=[redacted]\n");
  });

  it("gives each --after run its own hook log and closes it on release", async () => {
    const journal = create(await root());
    const runA = "2026-10-01T00-00-00-000Z_demo_a_aaaaaa";
    const first = journal.hookLog("after", 1, runA);
    expect(first.path).toBe(`logs/hook-after-01-${runA}.log`);
    const other = journal.hookLog(
      "after",
      1,
      "2026-10-01T00-00-01-000Z_demo_b_bbbbbb",
    );
    expect(other.log).not.toBe(first.log);
    first.log.write("from a, ");
    other.log.write("from b\n");
    first.log.write("done\n");
    first.release();
    other.release();
    // A released per-run log is closed, and its name is never handed out
    // again: a second execution for the same run gets its own file.
    first.log.writeLine("dropped");
    const again = journal.hookLog("after", 1, runA);
    expect(again.path).toBe(`logs/hook-after-01-${runA}-2.log`);
    again.log.writeLine("again");
    journal.finish("passed");
    expect(await readFile(join(journal.dir, first.path), "utf8")).toBe(
      "from a, done\n",
    );
    expect(await readFile(join(journal.dir, again.path), "utf8")).toBe(
      "again\n",
    );
    expect(await readFile(join(journal.dir, other.path), "utf8")).toBe(
      "from b\n",
    );
    // Shared before-hook logs ignore release and stay open.
    const before = journal.hookLog("before", 1);
    before.release();
    expect(journal.hookLog("before", 1).log).toBe(before.log);
  });

  it("keeps the random suffix of long run ids started in the same millisecond", async () => {
    const journal = create(await root());
    const stamp = "2026-10-01T00-00-00-000Z";
    const spec =
      "checkout_flow_with_discount_code_applied_for_every_region_and_currency_in_the_catalog";
    const suffixes = ["a1a1a1", "b2b2b2", "c3c3c3", "d4d4d4"];
    const hooks = suffixes.map((hex) =>
      journal.hookLog("after", 1, `${stamp}_${spec}_${hex}`),
    );
    const paths = hooks.map((hook) => hook.path);
    expect(new Set(paths).size).toBe(suffixes.length);
    for (const [i, path] of paths.entries()) {
      expect(path.startsWith(`logs/hook-after-01-${stamp}_checkout_flow`)).toBe(
        true,
      );
      expect(path.endsWith(`_in_the_catalog_${suffixes[i]}.log`)).toBe(true);
      expect(path.length).toBeLessThan(130);
    }
    // Even an identical id (never produced, but possible in theory) gets its
    // own file while the first execution is still open.
    const twin = journal.hookLog("after", 1, `${stamp}_${spec}_${suffixes[0]}`);
    expect(twin.path).toBe(paths[0]!.replace(/\.log$/, "-2.log"));
    twin.release();
    // Interleaved writes from concurrent executions stay in their own file.
    for (const [i, hook] of hooks.entries()) hook.log.write(`first ${i}\n`);
    hooks[0]!.release();
    for (const [i, hook] of hooks.entries()) hook.log.write(`second ${i}\n`);
    for (const hook of hooks.slice(1)) hook.release();
    journal.finish("passed");
    expect(await readFile(join(journal.dir, paths[0]!), "utf8")).toBe(
      "first 0\n",
    );
    for (const [i, path] of paths.entries()) {
      if (i === 0) continue;
      expect(await readFile(join(journal.dir, path), "utf8")).toBe(
        `first ${i}\nsecond ${i}\n`,
      );
    }
  });

  it("returns undefined when the artifact root is not writable", () => {
    expect(
      InvocationJournal.create({
        artifactRoot: "/dev/null/not-a-dir",
        argv: [],
        cwd: "/",
        parallel: 1,
        planned: [],
      }),
    ).toBeUndefined();
  });

  it("keeps _invocations out of mtime-ordered 'latest' listings", async () => {
    const artifactRoot = await root();
    create(artifactRoot);
    expect((await stat(join(artifactRoot, INVOCATIONS_DIR))).mtimeMs).toBe(0);
  });
});

describe("redactArgv", () => {
  it("redacts sensitive key=value pairs in any flag form", () => {
    expect(
      redactArgv([
        "--var=api_key=abc",
        "--label",
        "suite=nightly",
        "--matrix",
        "token=a,b",
        "plain",
      ]),
    ).toEqual([
      "--var=api_key=[redacted]",
      "--label",
      "suite=nightly",
      "--matrix",
      "token=[redacted]",
      "plain",
    ]);
  });
});

async function journalAt(
  artifactRoot: string,
  id: string,
  state: Record<string, unknown>,
): Promise<void> {
  const dir = join(artifactRoot, INVOCATIONS_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "invocation.json"),
    JSON.stringify({
      version: 1,
      invocationId: id,
      pid: 2_147_483_000,
      argv: [],
      cwd: "/",
      parallel: 1,
      planned: [],
      status: "passed",
      startedAt: "2026-10-01T00:00:00.000Z",
      runs: [],
      ...state,
    }),
  );
}

/** Journal ids whose writer pid (in the id) is not a live process. */
const id = (n: number) =>
  `2026-10-01T00-00-${String(n).padStart(2, "0")}-000Z_2147483000_aaaaaa`;

describe("readInvocationJournal", () => {
  it("ignores fields it does not know (a journal from a newer cairn)", async () => {
    const artifactRoot = await root();
    await journalAt(artifactRoot, id(1), {
      futureField: { nested: true },
      runs: [
        {
          index: 1,
          spec: "a.yml",
          runId: "r1",
          runDir: "/runs/r1",
          status: "passed",
          futureRunField: 3,
        },
      ],
    });
    const journal = await readInvocationJournal(
      join(artifactRoot, INVOCATIONS_DIR, id(1)),
    );
    expect(journal).toMatchObject({
      invocationId: id(1),
      status: "passed",
      runs: [{ index: 1, runId: "r1", status: "passed" }],
    });
    expect(journal).not.toHaveProperty("futureField");
    expect(journal?.runs[0]).not.toHaveProperty("futureRunField");
  });

  it("reads the writer pid from an invocation id", () => {
    expect(invocationIdPid(id(1))).toBe(2_147_483_000);
    expect(invocationIdPid("not-an-id")).toBeUndefined();
  });
});

describe("pruneInvocations", () => {
  it("removes old journals whose runs are gone, keeps the rest", async () => {
    const artifactRoot = await root();
    await mkdir(join(artifactRoot, "kept-run"), { recursive: true });
    await journalAt(artifactRoot, id(1), {}); // no runs → prunable
    await journalAt(artifactRoot, id(2), {
      runs: [
        {
          index: 1,
          spec: "a.yml",
          runId: "kept-run",
          runDir: join(artifactRoot, "kept-run"),
          status: "passed",
        },
      ],
    }); // references an existing run → kept
    await journalAt(artifactRoot, id(3), {
      status: "running",
      pid: process.pid,
    }); // live process → kept
    await journalAt(artifactRoot, id(4), { status: "running" }); // dead pid → prunable
    await mkdir(join(artifactRoot, INVOCATIONS_DIR, id(5)), {
      recursive: true,
    }); // no journal → prunable
    await journalAt(artifactRoot, id(6), {}); // newest → kept by count

    const removed = await pruneInvocations(artifactRoot, { keep: 1 });
    expect(removed).toEqual([id(1), id(4), id(5)]);
    expect(await listInvocationIds(artifactRoot)).toEqual([
      id(2),
      id(3),
      id(6),
    ]);
  });

  it("never removes a journal it cannot read, nor a live writer's empty dir", async () => {
    const artifactRoot = await root();
    // An invocation.json this build cannot parse (an unknown status).
    await journalAt(artifactRoot, id(1), { status: "paused" });
    // Not JSON at all.
    await mkdir(join(artifactRoot, INVOCATIONS_DIR, id(2)), {
      recursive: true,
    });
    await writeFile(
      join(artifactRoot, INVOCATIONS_DIR, id(2), "invocation.json"),
      "{not json",
    );
    // No invocation.json yet, but its writer (this process) is alive.
    const liveHusk = `2026-10-01T00-00-03-000Z_${process.pid}_aaaaaa`;
    await mkdir(join(artifactRoot, INVOCATIONS_DIR, liveHusk), {
      recursive: true,
    });
    // No invocation.json and a dead writer: an empty husk.
    await mkdir(join(artifactRoot, INVOCATIONS_DIR, id(4)), {
      recursive: true,
    });
    await journalAt(artifactRoot, id(9), {}); // newest → kept by count

    const removed = await pruneInvocations(artifactRoot, { keep: 1 });
    expect(removed).toEqual([id(4)]);
    expect(await listInvocationIds(artifactRoot)).toEqual(
      [id(1), id(2), liveHusk, id(9)].toSorted(),
    );
  });

  it("runs as part of run retention and never treats _invocations as a run", async () => {
    const artifactRoot = await root();
    const runId = "2026-10-01T00-00-00-000Z_demo_aaaaaa";
    await mkdir(join(artifactRoot, runId), { recursive: true });
    await journalAt(artifactRoot, id(1), {});
    for (let i = 2; i <= 23; i++) await journalAt(artifactRoot, id(i), {});

    const result = await pruneRuns(artifactRoot, { keepRuns: 3 });
    expect(result.removed).toEqual([]);
    expect(result.removedInvocations).toEqual([id(1), id(2), id(3)]);
    expect(existsSync(join(artifactRoot, INVOCATIONS_DIR))).toBe(true);
    expect(await listInvocationIds(artifactRoot)).toHaveLength(20);

    // clean --all (keepRuns 0) also drops journals that reference nothing.
    const all = await pruneRuns(artifactRoot, {
      keepRuns: 0,
      keepFailedRuns: 0,
    });
    expect(all.removed).toEqual([runId]);
    expect(all.removedInvocations).toHaveLength(20);
    expect(existsSync(join(artifactRoot, INVOCATIONS_DIR))).toBe(true);
  });
});
