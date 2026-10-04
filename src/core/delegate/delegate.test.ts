import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvocationJournal } from "../artifacts/invocationJournal";
import { RunEventSchema, type RunEvent } from "../schema/events.v1";
import {
  DelegateRelay,
  delegateVerdict,
  isSafeRunId,
  isUnsafeRelativePath,
  type RelayedRun,
} from "./relay";
import { DelegateStreamProducer } from "./remoteStream";
import { processRunningSync, type ProcessProbe } from "./runnerProcess";
import {
  FileLineTail,
  MAX_STREAM_LINE_BYTES,
  parseStreamLine,
  recoverTornLine,
} from "./stream";

/**
 * The delegate stream parser, the file tail, the relay's mapping onto the
 * local plan and journal, and the exit-code verdict — without a runner.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-delegate-unit-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ts = "2026-10-03T10:00:00.000Z";

const runStartedLine = (
  runId: string,
  index: number,
  spec: string,
  at = ts,
): string =>
  JSON.stringify({
    ts: at,
    type: "invocation.run.started",
    index,
    spec,
    runId,
  });

const runFinishedLine = (
  runId: string,
  index: number,
  spec: string,
  status: "passed" | "failed" | "errored",
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    ts,
    type: "invocation.run.finished",
    index,
    spec,
    runId,
    status,
    ...extra,
  });

/** A run directory the runner placed: run.json (+ the manifest). */
async function placeRun(
  root: string,
  runId: string,
  runJson: Record<string, unknown>,
): Promise<void> {
  await mkdir(join(root, runId), { recursive: true });
  await writeFile(
    join(root, runId, "run.json"),
    JSON.stringify({ runId, ...runJson }),
  );
  await writeFile(join(root, runId, "artifact-manifest.json"), "{}");
}

const delegateLabel = (id: string): Record<string, string> => ({
  "cairn.delegate": id,
});

const startedLineOf = (lines: string[]): string | undefined =>
  lines.find((line) => line.includes('"invocation.run.started"'));

const probeWith = (over: Partial<ProcessProbe>): ProcessProbe => ({
  platform: "darwin",
  kill: () => undefined,
  readProcStat: () => {
    throw Object.assign(new Error("no /proc"), { code: "ENOENT" });
  },
  ps: () => ({ status: 0, stdout: "S+\n" }),
  ...over,
});

describe("parseStreamLine", () => {
  it("accepts events.v1 lines and drops a newer producer's unknown fields", () => {
    expect(
      parseStreamLine(
        JSON.stringify({ ts, type: "suite.finished", name: "s", exitCode: 0 }),
      ),
    ).toMatchObject({ kind: "event", lenient: false });
    const lenient = parseStreamLine(
      JSON.stringify({
        ts,
        type: "suite.finished",
        name: "s",
        exitCode: 0,
        x: 1,
      }),
    );
    expect(lenient).toMatchObject({ kind: "event", lenient: true });
    expect(lenient.kind === "event" && "x" in lenient.event).toBe(false);
  });

  it("classifies bad lines without throwing", () => {
    expect(parseStreamLine("{nope")).toMatchObject({
      kind: "invalid",
      code: "malformed-line",
      level: "error",
    });
    expect(parseStreamLine("null")).toMatchObject({ code: "malformed-line" });
    expect(parseStreamLine(JSON.stringify({ ts }))).toMatchObject({
      code: "invalid-event",
    });
    expect(
      parseStreamLine(JSON.stringify({ ts, type: "brand.new.thing" })),
    ).toMatchObject({ code: "unknown-event", level: "warn" });
    expect(
      parseStreamLine(JSON.stringify({ ts, type: "suite.finished", name: 1 })),
    ).toMatchObject({ code: "invalid-event" });
    expect(
      parseStreamLine(
        JSON.stringify({
          ts,
          type: "x",
          pad: "a".repeat(MAX_STREAM_LINE_BYTES),
        }),
      ),
    ).toMatchObject({ code: "line-too-long" });
  });
});

describe("FileLineTail", () => {
  it("returns whole lines, holds a torn one until its newline, and flushes it when final", () => {
    const path = join(dir, "tail.ndjson");
    writeFileSync(path, "");
    const tail = new FileLineTail(path);
    appendFileSync(path, "one\ntw");
    expect(tail.read()).toEqual(["one"]);
    appendFileSync(path, "o\n\nthree");
    expect(tail.read()).toEqual(["two"]);
    expect(tail.read(true)).toEqual(["three"]);
    writeFileSync(path, "again\n");
    expect(tail.read()).toEqual(["again"]);
    expect(new FileLineTail(join(dir, "missing")).read(true)).toEqual([]);
  });
});

describe("isSafeRunId", () => {
  it("allows one directory name under the artifact root, nothing else", () => {
    expect(isSafeRunId("2026-10-03T10-00-00-000Z_alpha_abc123")).toBe(true);
    for (const bad of ["..", ".", "a/b", "_invocations", ".hidden", "a\\b"]) {
      expect(isSafeRunId(bad), bad).toBe(false);
    }
  });
});

describe("DelegateRelay", () => {
  async function relayWith(planned: Array<{ index: number; spec: string }>) {
    const root = await mkdtemp(join(dir, "root-"));
    const journal = InvocationJournal.create({
      artifactRoot: root,
      argv: ["run"],
      cwd: dir,
      parallel: 1,
      planned,
      heartbeatIntervalMs: 0,
    })!;
    const relay = new DelegateRelay({
      journal,
      artifactRoot: root,
      planned,
      configDir: "/project",
    });
    const events = async (): Promise<RunEvent[]> =>
      (await readFile(join(journal.dir, "events.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => RunEventSchema.parse(JSON.parse(line)));
    return { root, journal, relay, events };
  }

  it("maps a remote plan shifted by a locally refused spec onto the local plan", async () => {
    const { relay, journal } = await relayWith([
      { index: 1, spec: "/project/flows/refused.yml" },
      { index: 2, spec: "/project/flows/alpha.yml" },
    ]);
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.run.started",
        index: 1,
        spec: "/remote/checkout/flows/alpha.yml",
        runId: "r1",
      }),
    );
    const run = relay.runList()[0]!;
    expect(run).toMatchObject({
      index: 2,
      spec: "/project/flows/alpha.yml",
      remoteSpec: "/remote/checkout/flows/alpha.yml",
    });
    expect(journal.snapshot.runs[0]).toMatchObject({
      index: 2,
      runId: "r1",
      status: "running",
    });
    expect(relay.diagnostics).toEqual([]);
  });

  it("drops exact repeats, heartbeats and remote log paths; flags unknown runs", async () => {
    const { relay, events } = await relayWith([
      { index: 1, spec: "/project/flows/alpha.yml" },
    ]);
    const line = JSON.stringify({
      ts,
      type: "suite.started",
      name: "s",
      env: "e",
      specs: 1,
    });
    relay.consume(line);
    relay.consume(line);
    relay.consume(
      JSON.stringify({
        ts,
        type: "run.heartbeat",
        phase: "steps",
        elapsedMs: 1,
        pid: 1,
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "log.opened",
        kind: "narration",
        name: "invocation",
        path: "logs/narration.log",
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.run.finished",
        index: 1,
        spec: "flows/alpha.yml",
        runId: "r9",
        status: "passed",
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.run.started",
        index: 2,
        spec: "flows/zulu.yml",
        runId: "../escape",
      }),
    );
    expect(relay.duplicates).toBe(1);
    expect(relay.dropped).toBe(2);
    expect(relay.diagnostics.map((d) => d.code)).toEqual([
      "unknown-run",
      "invalid-event",
    ]);
    const relayed = (await events()).filter((e) => e.delegated);
    expect(relayed.map((e) => e.type)).toEqual([
      "suite.started",
      "invocation.run.finished",
    ]);
  });

  it("verifies run directories after the runner exited", async () => {
    const { relay, root } = await relayWith([
      { index: 1, spec: "/project/flows/a.yml" },
      { index: 2, spec: "/project/flows/b.yml" },
      { index: 3, spec: "/project/flows/c.yml" },
    ]);
    relay.consume(runStartedLine("ra", 1, "flows/a.yml"));
    relay.consume(runStartedLine("rb", 2, "flows/b.yml"));
    relay.consume(runStartedLine("rc", 3, "flows/c.yml"));
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.run.finished",
        index: 1,
        spec: "flows/a.yml",
        runId: "ra",
        status: "passed",
      }),
    );
    // rb: never finished, but its run.json made it; rc: nothing at all.
    await mkdir(join(root, "ra"), { recursive: true });
    await writeFile(
      join(root, "ra", "run.json"),
      JSON.stringify({ runId: "ra", status: "passed" }),
    );
    await mkdir(join(root, "rb"), { recursive: true });
    await writeFile(
      join(root, "rb", "run.json"),
      JSON.stringify({ runId: "rb", status: "failed" }),
    );
    const verification = relay.verify();
    expect(verification.missing).toEqual([]);
    expect(verification.unfinished.map((run) => run.runId)).toEqual(["rc"]);
    expect(relay.runList().map((run) => run.status)).toEqual([
      "passed",
      "failed",
      "errored",
    ]);
    expect(relay.diagnostics.map((d) => `${d.level}:${d.code}`)).toEqual([
      "warn:incomplete-run-dir",
      "warn:unfinished-run",
      "error:unfinished-run",
    ]);
    // Idempotent.
    expect(relay.verify()).toBe(verification);
  });

  it("caps journaled diagnostics and keeps counting", async () => {
    const root = await mkdtemp(join(dir, "cap-"));
    const journal = InvocationJournal.create({
      artifactRoot: root,
      argv: ["run"],
      cwd: dir,
      parallel: 1,
      planned: [],
      heartbeatIntervalMs: 0,
    })!;
    const relay = new DelegateRelay({
      journal,
      artifactRoot: root,
      planned: [],
      maxDiagnosticEvents: 2,
    });
    for (let i = 0; i < 5; i++) relay.consume(`garbage ${i}`);
    expect(relay.diagnostics).toHaveLength(5);
    const lines = (await readFile(join(journal.dir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.includes("delegate.diagnostic"));
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain('"suppressed"');
  });
});

describe("DelegateRelay: evidence", () => {
  const ALPHA = "/project/flows/alpha.yml";
  const BRAVO = "/project/flows/bravo.yml";

  async function relayFor(
    planned: Array<{ index: number; spec: string }>,
    extra: Partial<ConstructorParameters<typeof DelegateRelay>[0]> = {},
    rootDir?: string,
  ) {
    const root = rootDir ?? (await mkdtemp(join(dir, "ev-")));
    const journal = InvocationJournal.create({
      artifactRoot: root,
      argv: ["run"],
      cwd: dir,
      parallel: 1,
      planned,
      heartbeatIntervalMs: 0,
    })!;
    const relay = new DelegateRelay({
      journal,
      artifactRoot: root,
      planned,
      configDir: "/project",
      ...extra,
    });
    const events = async (): Promise<RunEvent[]> =>
      (await readFile(join(journal.dir, "events.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => RunEventSchema.parse(JSON.parse(line)));
    return { root, journal, relay, events };
  }

  it("M2: a re-streamed run never goes back to running, and a settled run keeps its first status", async () => {
    const { relay, journal } = await relayFor([{ index: 1, spec: ALPHA }]);
    relay.consume(runStartedLine("ra", 1, "flows/alpha.yml"));
    relay.consume(runFinishedLine("ra", 1, "flows/alpha.yml", "passed"));
    // The reconnect: the same run lines again, derived with other fields.
    relay.consume(
      runStartedLine("ra", 1, "flows/alpha.yml", "2026-10-03T10:00:00.120Z"),
    );
    relay.consume(
      runFinishedLine("ra", 1, "flows/alpha.yml", "passed", {
        durationMs: 120,
      }),
    );
    expect(journal.snapshot.runs).toEqual([
      expect.objectContaining({ runId: "ra", status: "passed" }),
    ]);
    expect(relay.duplicates).toBe(2);
    expect(relay.diagnostics).toEqual([]);
    relay.consume(runFinishedLine("ra", 1, "flows/alpha.yml", "failed"));
    expect(relay.diagnostics.map((d) => `${d.level}:${d.code}`)).toEqual([
      "error:status-mismatch",
    ]);
    expect(journal.snapshot.runs[0]!.status).toBe("passed");
  });

  it("recovers the whole event after a torn line (a reconnect mid-line)", async () => {
    const { relay, events } = await relayFor([{ index: 1, spec: ALPHA }]);
    const whole = JSON.stringify({
      ts,
      type: "suite.started",
      name: "s",
      env: "e",
      specs: 1,
    });
    relay.consume(`${whole.slice(0, 20)}${whole}`);
    expect(relay.diagnostics.map((d) => `${d.level}:${d.code}`)).toEqual([
      "warn:malformed-line",
    ]);
    expect((await events()).filter((e) => e.delegated)).toEqual([
      expect.objectContaining({ type: "suite.started" }),
    ]);
  });

  it("L5: refuses cairn's own delegate.* records and paths that leave their directory", async () => {
    const { relay, events } = await relayFor([{ index: 1, spec: ALPHA }]);
    relay.consume(
      JSON.stringify({
        ts,
        type: "delegate.finished",
        durationMs: 1,
        relayed: 0,
        runs: 0,
        missingRunDirs: 0,
        diagnostics: 0,
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "artifact.screenshot",
        stepId: "s1",
        path: "../../../etc/escape.png",
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "artifact.screenshot",
        stepId: "s2",
        path: "/etc/escape.png",
      }),
    );
    // Absolute paths a schema does not declare relative are fine.
    relay.consume(
      JSON.stringify({
        ts,
        type: "run.refused",
        spec: "gated",
        reason: "not here",
        env: "worker",
        path: "/remote/flows/gated.yml",
      }),
    );
    relay.consume(
      JSON.stringify({ ts, type: "delegate.progress", message: "copying" }),
    );
    expect(relay.diagnostics.map((d) => `${d.level}:${d.code}`)).toEqual([
      "error:invalid-event",
      "error:invalid-event",
      "error:invalid-event",
    ]);
    expect(
      (await events()).filter((e) => e.delegated).map((e) => e.type),
    ).toEqual(["run.refused", "delegate.progress"]);
    expect(relay.remoteRefusals).toBe(1);
  });

  it("H4: a remote run of a locally refused spec is refused-run and never relayed", async () => {
    const { relay, journal } = await relayFor(
      [
        { index: 1, spec: "/project/flows/gated.yml" },
        { index: 2, spec: ALPHA },
      ],
      { refusedIndexes: new Set([1]) },
    );
    relay.consume(runStartedLine("rg", 1, "flows/gated.yml"));
    relay.consume(runFinishedLine("rg", 1, "flows/gated.yml", "passed"));
    relay.consume(runStartedLine("ra", 2, "flows/alpha.yml"));
    expect(relay.diagnostics.map((d) => `${d.level}:${d.code}`)).toEqual([
      "error:refused-run",
    ]);
    expect(relay.runList().map((run) => run.runId)).toEqual(["ra"]);
    expect(journal.snapshot.runs.map((run) => run.runId)).toEqual(["ra"]);
  });

  it("H2: a synthetic pass is no pass", async () => {
    const { relay } = await relayFor([{ index: 1, spec: ALPHA }]);
    relay.consume(runStartedLine("ra", 1, "flows/alpha.yml"));
    relay.consume(
      runFinishedLine("ra", 1, "flows/alpha.yml", "passed", {
        synthetic: true,
      }),
    );
    expect(relay.runList()[0]).toMatchObject({
      status: "errored",
      synthetic: true,
    });
    expect(relay.diagnostics.map((d) => d.code)).toEqual(["synthetic-pass"]);
  });

  it("H1: only the named remote invocation's finish and summary count", async () => {
    const { relay } = await relayFor([{ index: 1, spec: ALPHA }]);
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.started",
        invocationId: "remote-a",
        pid: 7,
        planned: 1,
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.summary",
        invocationId: "remote-old",
        status: "passed",
        summary: {
          total: 1,
          passed: 1,
          failed: 0,
          errored: 0,
          durationMs: 1,
          exitCode: 0,
        },
      }),
    );
    relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.finished",
        invocationId: "remote-old",
        status: "passed",
      }),
    );
    expect(relay.remoteSummary).toBeUndefined();
    expect(relay.remoteStatus).toBeUndefined();
    expect(relay.diagnostics.map((d) => `${d.level}:${d.code}`)).toEqual([
      "warn:unknown-run",
      "warn:unknown-run",
    ]);
  });

  it("H2/H3: verify checks every copied run.json (label, freshness, status)", async () => {
    const planned = [
      { index: 1, spec: ALPHA },
      { index: 2, spec: BRAVO },
      { index: 3, spec: "/project/flows/charlie.yml" },
      { index: 4, spec: "/project/flows/delta.yml" },
    ];
    const root = await mkdtemp(join(dir, "verify-"));
    // A run from before the runner started, then the runner's copies.
    await placeRun(root, "r-stale", {
      status: "passed",
      labels: delegateLabel("local-1"),
    });
    const { relay } = await relayFor(
      planned,
      { invocationId: "local-1", preexisting: new Set(["r-stale"]) },
      root,
    );
    await placeRun(root, "r-ok", {
      status: "passed",
      labels: delegateLabel("local-1"),
    });
    await placeRun(root, "r-foreign", {
      status: "passed",
      labels: delegateLabel("someone-else"),
    });
    await placeRun(root, "r-flip", {
      status: "failed",
      labels: delegateLabel("local-1"),
    });
    const specs = ["alpha", "bravo", "charlie", "delta"];
    ["r-ok", "r-foreign", "r-flip", "r-stale"].forEach((runId, at) => {
      relay.consume(runStartedLine(runId, at + 1, `flows/${specs[at]}.yml`));
      relay.consume(
        runFinishedLine(runId, at + 1, `flows/${specs[at]}.yml`, "passed"),
      );
    });
    const verification = relay.verify({ coverage: true });
    expect(verification.foreign.map((run) => run.runId)).toEqual([
      "r-foreign",
      "r-stale",
    ]);
    expect(verification.unsettled).toEqual([]);
    const byId = Object.fromEntries(
      relay.runList().map((run) => [run.runId, run]),
    );
    expect(byId["r-ok"]).toMatchObject({ status: "passed", verified: true });
    expect(byId["r-flip"]).toMatchObject({ status: "failed", verified: true });
    expect(byId["r-foreign"]!.verified).toBeUndefined();
    expect(
      relay.diagnostics.map((d) => `${d.level}:${d.code}:${d.runId}`),
    ).toEqual([
      "error:foreign-run:r-foreign",
      "error:status-mismatch:r-flip",
      "error:stale-run:r-stale",
    ]);
  });

  it("H1: coverage counts planned runs the stream never settled, minus what the remote summary accounts for", async () => {
    const planned = [
      { index: 1, spec: ALPHA },
      { index: 2, spec: BRAVO },
    ];
    const first = await relayFor(planned);
    first.relay.consume(runStartedLine("ra", 1, "flows/alpha.yml"));
    first.relay.consume(runFinishedLine("ra", 1, "flows/alpha.yml", "passed"));
    await placeRun(first.root, "ra", { status: "passed" });
    expect(first.relay.verify({ coverage: true }).unsettled).toEqual([
      { index: 2, spec: BRAVO },
    ]);
    expect(first.relay.diagnostics.map((d) => d.code)).toEqual(["missing-run"]);

    const second = await relayFor(planned);
    second.relay.consume(
      JSON.stringify({
        ts,
        type: "invocation.summary",
        invocationId: "remote-b",
        status: "failed",
        summary: {
          total: 2,
          passed: 0,
          failed: 1,
          errored: 0,
          skipped: 1,
          durationMs: 1,
          exitCode: 1,
        },
      }),
    );
    second.relay.consume(runStartedLine("ra", 1, "flows/alpha.yml"));
    second.relay.consume(runFinishedLine("ra", 1, "flows/alpha.yml", "failed"));
    await placeRun(second.root, "ra", { status: "failed" });
    expect(second.relay.verify({ coverage: true }).unsettled).toEqual([]);
    expect(second.relay.diagnostics).toEqual([]);
  });

  it("L1/L2: rate-limits narration and forgets the oldest lines it remembers", async () => {
    let notes = 0;
    const { relay } = await relayFor([], {
      maxDiagnosticNotes: 3,
      maxSeenLines: 2,
      onDiagnostic: () => {
        notes += 1;
      },
    });
    for (let i = 0; i < 10; i++) relay.consume(`ssh: banner ${i}`);
    expect(relay.diagnostics).toHaveLength(10);
    expect(notes).toBe(4);
    const line = (name: string) =>
      JSON.stringify({ ts, type: "suite.started", name, env: "e", specs: 1 });
    relay.consume(line("a"));
    relay.consume(line("a"));
    relay.consume(line("b"));
    relay.consume(line("c"));
    relay.consume(line("a"));
    expect(relay.duplicates).toBe(1);
    expect(relay.relayed).toBe(4);
  });
});

describe("DelegateStreamProducer: deterministic run lines (M2)", () => {
  it("derives the same invocation.run.started line before and after the run settled", async () => {
    const root = await mkdtemp(join(dir, "producer-"));
    const runId = "2026-10-03T10-00-00-000Z_alpha_abc123";
    const runDir = join(root, runId);
    const journal = InvocationJournal.create({
      artifactRoot: root,
      argv: ["run"],
      cwd: dir,
      parallel: 1,
      planned: [{ index: 1, spec: "flows/alpha.yml" }],
      heartbeatIntervalMs: 0,
    })!;
    journal.runStarted(1, "flows/alpha.yml", runId, runDir);
    // A live follower prints the start before run.json exists…
    const live = await new DelegateStreamProducer(journal.dir).poll(false);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId,
        status: "passed",
        startedAt: "2026-10-03T10:00:00.250Z",
        endedAt: "2026-10-03T10:00:01.000Z",
        durationMs: 750,
      }),
    );
    journal.runFinished({
      index: 1,
      spec: "flows/alpha.yml",
      runId,
      runDir,
      status: "passed",
    });
    // …and a reconnected one replays it after run.json was written.
    const replay = await new DelegateStreamProducer(journal.dir).poll(true);
    expect(startedLineOf(live)).toBeDefined();
    expect(startedLineOf(replay)).toBe(startedLineOf(live));
    expect(JSON.parse(startedLineOf(live)!)).toMatchObject({
      ts: "2026-10-03T10:00:00.000Z",
    });
    expect(
      JSON.parse(
        replay.find((line) => line.includes('"invocation.run.finished"'))!,
      ),
    ).toMatchObject({ ts: "2026-10-03T10:00:01.000Z", durationMs: 750 });
  });
});

describe("isUnsafeRelativePath", () => {
  it("allows paths inside their directory only", () => {
    for (const ok of ["screens/a.png", "logs/hook-1.log", "a..b/c", "x"]) {
      expect(isUnsafeRelativePath(ok), ok).toBe(false);
    }
    for (const bad of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "\\\\server\\share",
      "C:\\x",
      "a\\..\\b",
      "a\u0000b",
    ]) {
      expect(isUnsafeRelativePath(bad), bad).toBe(true);
    }
  });
});

describe("FileLineTail: bounded lines (L1)", () => {
  it("keeps at most limit+1 bytes of an overlong line and drops the rest up to its newline", () => {
    const path = join(dir, "long.ndjson");
    writeFileSync(path, "");
    const tail = new FileLineTail(path, 10);
    for (let i = 0; i < 50; i++) appendFileSync(path, "x".repeat(1000));
    expect(tail.read()).toEqual([]);
    appendFileSync(path, "\nshort\n");
    const lines = tail.read();
    expect(lines).toEqual(["x".repeat(11), "short"]);
  });

  it("an overlong line of the real stream reads as line-too-long", () => {
    const path = join(dir, "long2.ndjson");
    writeFileSync(path, "");
    const tail = new FileLineTail(path);
    appendFileSync(path, `${"y".repeat(MAX_STREAM_LINE_BYTES * 3)}\n`);
    const lines = tail.read(true);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!)).toBe(MAX_STREAM_LINE_BYTES + 1);
    expect(parseStreamLine(lines[0]!)).toMatchObject({ code: "line-too-long" });
  });
});

describe("recoverTornLine", () => {
  it("finds the whole event after a torn head, or nothing", () => {
    const whole = JSON.stringify({ ts, type: "x.y", labels: { a: "b" } });
    expect(recoverTornLine(`{"ts":"2026","type":"sui${whole}`)).toBe(whole);
    expect(recoverTornLine(`{"ts":"2026","labels":{"a":"b${whole}`)).toBe(
      whole,
    );
    expect(recoverTornLine("not json at all")).toBeUndefined();
    expect(recoverTornLine(whole)).toBeUndefined();
  });
});

describe("processRunningSync (M3)", () => {
  it("tells a zombie from a live process, and counts an unknown state as running", () => {
    const gone = Object.assign(new Error("gone"), { code: "ESRCH" });
    expect(
      processRunningSync(
        1,
        probeWith({
          kill: () => {
            throw gone;
          },
        }),
      ),
    ).toBe(false);
    expect(processRunningSync(1, probeWith({}))).toBe(true);
    expect(
      processRunningSync(
        1,
        probeWith({ ps: () => ({ status: 0, stdout: "Z\n" }) }),
      ),
    ).toBe(false);
    // BusyBox: `ps -o stat= -p` is an error and prints nothing.
    expect(
      processRunningSync(
        1,
        probeWith({ ps: () => ({ status: 1, stdout: "" }) }),
      ),
    ).toBe(true);
    expect(
      processRunningSync(
        1,
        probeWith({
          ps: () => ({ error: new Error("ENOENT"), status: null, stdout: "" }),
        }),
      ),
    ).toBe(true);
    // Linux reads /proc and never needs ps.
    const linux = (stat: string) =>
      probeWith({
        platform: "linux",
        readProcStat: () => stat,
        ps: () => {
          throw new Error("ps must not run");
        },
      });
    expect(processRunningSync(1, linux("42 (a (b) c) Z 1 42"))).toBe(false);
    expect(processRunningSync(1, linux("42 (bun) S 1 42"))).toBe(true);
  });
});

function relayedRun(
  status: RelayedRun["status"],
  extra: Partial<RelayedRun> = {},
): RelayedRun {
  return {
    index: 1,
    spec: "a.yml",
    remoteSpec: "a.yml",
    runId: "r",
    runDir: "/r",
    ...(status
      ? { status, streamStatus: status, verified: true as const }
      : {}),
    ...extra,
  };
}

describe("delegateVerdict", () => {
  const base = {
    cancelled: false,
    timedOut: false,
    planned: 1,
  };

  it("passes a cairn exit code through when the evidence supports it", () => {
    for (const code of [0, 1, 3, 4, 7, 8, 9]) {
      const runs = [relayedRun(code === 1 ? "failed" : "passed")];
      expect(
        delegateVerdict({ ...base, exit: { exitCode: code }, runs }).exitCode,
        String(code),
      ).toBe(code);
    }
    expect(
      delegateVerdict({ ...base, exit: { exitCode: 130 }, runs: [] }),
    ).toMatchObject({ exitCode: 130, status: "aborted" });
  });

  it("overrides what it cannot trust", () => {
    const passed = [relayedRun("passed")];
    expect(
      delegateVerdict({ ...base, exit: { exitCode: 77 }, runs: passed }),
    ).toMatchObject({
      exitCode: 2,
      diagnostics: [{ code: "invalid-exit-code" }],
    });
    expect(
      delegateVerdict({ ...base, exit: { signal: "SIGKILL" }, runs: passed }),
    ).toMatchObject({ exitCode: 2, diagnostics: [{ code: "runner-signal" }] });
    expect(
      delegateVerdict({ ...base, exit: { spawnError: "ENOENT" }, runs: [] }),
    ).toMatchObject({ exitCode: 2, diagnostics: [{ code: "spawn-failed" }] });
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: passed,
        verification: { missing: 1, unfinished: 0 },
      }),
    ).toMatchObject({ exitCode: 2, diagnostics: [{ code: "exit-mismatch" }] });
    // A code that is not a pass is never lowered.
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 8 },
        runs: passed,
        verification: { missing: 1, unfinished: 0 },
      }).exitCode,
    ).toBe(8);
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: [relayedRun("errored")],
      }),
    ).toMatchObject({ exitCode: 2, diagnostics: [{ code: "exit-mismatch" }] });
    expect(
      delegateVerdict({ ...base, exit: { exitCode: 0 }, runs: [] }).exitCode,
    ).toBe(2);
    expect(
      delegateVerdict({ ...base, exit: { exitCode: 0 }, runs: [], planned: 0 })
        .exitCode,
    ).toBe(0);
    expect(
      delegateVerdict({ ...base, exit: {}, runs: passed, timedOut: true }),
    ).toMatchObject({ exitCode: 2, status: "errored" });
    expect(
      delegateVerdict({ ...base, exit: {}, runs: passed, idle: true }),
    ).toMatchObject({ exitCode: 2, status: "errored" });
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 2 },
        runs: passed,
        cancelled: true,
      }),
    ).toMatchObject({ exitCode: 130, status: "aborted" });
  });

  it("H1: a runner 0 over a remote invocation that did not pass takes the remote code", () => {
    const passed = [relayedRun("passed")];
    const summary = {
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      durationMs: 5,
      exitCode: 8,
    };
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: passed,
        remote: { status: "errored", summary },
      }),
    ).toMatchObject({
      exitCode: 8,
      diagnostics: [{ code: "exit-mismatch" }],
    });
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: passed,
        remote: { status: "failed" },
      }).exitCode,
    ).toBe(1);
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: passed,
        remote: { status: "aborted" },
      }).exitCode,
    ).toBe(2);
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: passed,
        remote: { status: "passed", summary: { ...summary, exitCode: 0 } },
      }),
    ).toMatchObject({ exitCode: 0, diagnostics: [] });
  });

  it("H1: a runner 0 with planned runs never settled is exit 2 (missing-run)", () => {
    const result = delegateVerdict({
      ...base,
      planned: 2,
      exit: { exitCode: 0 },
      runs: [relayedRun("passed")],
      verification: { missing: 0, unfinished: 0, unsettled: 1 },
    });
    expect(result.exitCode).toBe(2);
    expect(result.errors.join(" ")).toContain("never settled");
  });

  it("H2/H3: contradicting or foreign evidence is never a pass (2)", () => {
    for (const diagnostic of [
      "status-mismatch",
      "synthetic-pass",
      "refused-run",
    ] as const) {
      expect(
        delegateVerdict({
          ...base,
          exit: { exitCode: 0 },
          runs: [relayedRun("passed")],
          diagnostics: [{ level: "error", code: diagnostic, message: "x" }],
        }).exitCode,
        diagnostic,
      ).toBe(2);
    }
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: [relayedRun("passed")],
        verification: { missing: 0, unfinished: 0, foreign: 1 },
      }),
    ).toMatchObject({
      exitCode: 2,
      errors: [expect.stringContaining("foreign-run")],
    });
    // …and a 1 over wrong evidence is an infrastructure failure too.
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 1 },
        runs: [relayedRun("failed")],
        verification: { missing: 0, unfinished: 0, foreign: 1 },
      }).exitCode,
    ).toBe(2);
  });

  it("M5: a runner 1 that relayed no failure is an infrastructure failure (2)", () => {
    expect(
      delegateVerdict({
        ...base,
        planned: 3,
        exit: { exitCode: 1 },
        runs: [],
      }),
    ).toMatchObject({
      exitCode: 2,
      diagnostics: [{ code: "exit-mismatch" }],
    });
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 1 },
        runs: [relayedRun("passed")],
      }).exitCode,
    ).toBe(2);
    // The remote summary's own 1 is evidence of a failure.
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 1 },
        runs: [relayedRun("passed")],
        remote: { status: "failed" },
      }).exitCode,
    ).toBe(1);
    // --bail: a failure that stopped the rest stays 1.
    expect(
      delegateVerdict({
        ...base,
        planned: 3,
        exit: { exitCode: 1 },
        runs: [relayedRun("failed")],
        verification: { missing: 0, unfinished: 0, unsettled: 2 },
      }).exitCode,
    ).toBe(1);
  });

  it("L2: error diagnostics of the stream keep a 0 from passing", () => {
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: [relayedRun("passed")],
        diagnostics: [
          { level: "error", code: "malformed-line", message: "x" },
          { level: "warn", code: "unknown-event", message: "y" },
        ],
      }),
    ).toMatchObject({
      exitCode: 2,
      errors: [expect.stringContaining("1 line of its events stream")],
    });
    expect(
      delegateVerdict({
        ...base,
        exit: { exitCode: 0 },
        runs: [relayedRun("passed")],
        diagnostics: [
          { level: "warn", code: "malformed-line", message: "torn" },
          { level: "warn", code: "unknown-event", message: "y" },
        ],
      }).exitCode,
    ).toBe(0);
  });
});
