import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  InvocationJournalSchema,
  RunEventSchema,
  type RunEvent,
} from "../../core/schema/events.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import {
  afterFirstRun,
  recordDelegateSuite,
  writeDelegateProject,
  writeScenarioConfig,
  type DelegateRecording,
} from "../../testing/delegateFixtures";

/**
 * The real `bin/cairn` on a delegated environment, interrupted the way a
 * terminal Ctrl-C or Studio's Stop / Live Cancel (both SIGINT) or a process
 * manager's SIGTERM interrupts it: the synchronous signal path sends SIGINT
 * to the runner (its pid; its helpers keep running), keeps relaying its
 * stream while it cancels remotely and copies the results back, then marks
 * the journal aborted and exits 130 / 143.
 */

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");
const spawned: ChildProcess[] = [];
let dir: string;
let remoteRoot: string;
let recording: DelegateRecording;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-delegate-cli-"));
  remoteRoot = await mkdtemp(join(tmpdir(), "cairn-delegate-cli-remote-"));
  await writeDelegateProject(dir);
  recording = await recordDelegateSuite(dir, remoteRoot, "both");
}, 60_000);

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(remoteRoot, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
}

async function journalDirOf(root: string): Promise<string | undefined> {
  const ids = await readdir(join(root, "_invocations")).catch(
    () => [] as string[],
  );
  return ids[0] ? join(root, "_invocations", ids[0]) : undefined;
}

async function interrupted(
  name: string,
  signal: "SIGINT" | "SIGTERM",
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  journalDir: string;
  helperProbe: string;
}> {
  const cut = afterFirstRun(recording.lines);
  const helperProbe = join(dir, `helper-${name}.json`);
  const { config } = await writeScenarioConfig(dir, name, {
    lines: recording.lines,
    runDirs: recording.runDirs,
    hangAfter: cut,
    helperProbe,
    onSigint: {
      lines: recording.lines.slice(cut),
      exitCode: 130,
      delayMs: 300,
    },
  });
  const root = join(dir, `runs-${name}`);
  const child = spawn(
    "bun",
    [
      BIN,
      "run",
      "--suite",
      "both",
      "--env",
      "remote",
      "--config",
      config,
      "--artifact-root",
      root,
      "--json",
    ],
    {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "info" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  spawned.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = new Promise<number | null>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code) => resolveClose(code));
  });
  await waitFor(async () => {
    const journalDir = await journalDirOf(root);
    if (!journalDir) return false;
    const events = await readFile(
      join(journalDir, "events.ndjson"),
      "utf8",
    ).catch(() => "");
    return events.includes('"invocation.run.finished"');
  });
  child.kill(signal);
  const code = await closed;
  return {
    code,
    stdout,
    stderr,
    journalDir: (await journalDirOf(root))!,
    helperProbe,
  };
}

async function journalEvents(journalDir: string): Promise<RunEvent[]> {
  const text = await readFile(join(journalDir, "events.ndjson"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

describe("cairn run on a delegated environment, interrupted", () => {
  it("Ctrl-C: SIGINT reaches the runner, its last runs still land, exit 130", async () => {
    const done = await interrupted("sigint", "SIGINT");
    expect(done.code).toBe(130);
    expect(done.stderr).toContain("cancelling the delegated runner");
    // SIGINT reached the runner alone: its helper survived to copy results.
    expect(JSON.parse(await readFile(done.helperProbe, "utf8"))).toEqual({
      helperAlive: true,
    });
    const journal = InvocationJournalSchema.parse(
      JSON.parse(
        await readFile(join(done.journalDir, "invocation.json"), "utf8"),
      ),
    );
    expect(journal.status).toBe("aborted");
    expect(journal.signal).toBe("SIGINT");
    expect(journal.delegate).toMatchObject({ cancelled: true });
    // The second run was relayed while cairn waited for the runner.
    expect(journal.runs.map((run) => run.status)).toEqual(["passed", "passed"]);
    const stream = await journalEvents(done.journalDir);
    const types = stream.map((event) => event.type);
    expect(
      stream.find((event) => event.type === "delegate.cancel.requested"),
    ).toMatchObject({ reason: "signal", trigger: "SIGINT", signal: "SIGINT" });
    expect(
      stream.find((event) => event.type === "delegate.cancel.finished"),
    ).toMatchObject({ graceful: true });
    expect(types.indexOf("delegate.finished")).toBeLessThan(
      types.indexOf("invocation.finished"),
    );
    expect(
      stream.find((event) => event.type === "invocation.finished"),
    ).toMatchObject({ status: "aborted", signal: "SIGINT" });
    // The documents of what finished are printed, with the signal's code.
    const batch = BatchRunResultSchema.parse(JSON.parse(done.stdout));
    expect(batch.results).toHaveLength(2);
    expect(batch.invocationOutcome).toMatchObject({
      exitCode: 130,
      delegate: { contract: "urn:cairntrace.dev:delegate:v1" },
    });
  }, 60_000);

  it("SIGTERM (a process manager, `kill`) exits 143", async () => {
    const done = await interrupted("sigterm", "SIGTERM");
    expect(done.code).toBe(143);
    const stream = await journalEvents(done.journalDir);
    expect(
      stream.find((event) => event.type === "delegate.cancel.requested"),
    ).toMatchObject({ trigger: "SIGTERM", signal: "SIGINT" });
    expect(
      stream.find((event) => event.type === "invocation.finished"),
    ).toMatchObject({ status: "aborted", signal: "SIGTERM" });
  }, 60_000);
});
