import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InvocationJournalSchema,
  RunEventSchema,
  type RunEvent,
} from "../../core/schema/events.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import {
  afterFirstRun,
  delegateConfig,
  delegateSpec,
  recordDelegateSuite,
  writeDelegateProject,
  writeScenarioConfig,
  type DelegateRecording,
} from "../../testing/delegateFixtures";
import type { FakeRunnerScenario } from "../../testing/fakeDelegateRunner";
import {
  executeRunInvocation,
  type RunInvocationResult,
} from "./executeRunInvocation";

/**
 * The delegated runner (`environments.<n>.runner`, contract
 * urn:cairntrace.dev:delegate:v1) against the reference fake runner: a real
 * mock-backend invocation of the "remote" environment is recorded once
 * (its run directories and the stream `cairn logs --relay` would print),
 * then a local `--env remote` invocation hands its execution to the fake
 * runner, which replays that recording — or misbehaves on purpose.
 */

let dir: string;
let remoteRoot: string;
let counter = 0;
const recordings = new Map<string, DelegateRecording>();

async function writeConfig(
  scenario: FakeRunnerScenario,
  options: Parameters<typeof writeScenarioConfig>[3] = {},
): Promise<{ config: string; scenarioPath: string; recordTo: string }> {
  counter += 1;
  return writeScenarioConfig(dir, String(counter), scenario, options);
}

/** Record `suite` once (a real mock invocation of the "worker" environment). */
async function record(suite: string): Promise<DelegateRecording> {
  const cached = recordings.get(suite);
  if (cached) return cached;
  const recording = await recordDelegateSuite(dir, remoteRoot, suite);
  recordings.set(suite, recording);
  return recording;
}

async function runRemote(
  config: string,
  options: Record<string, unknown> = {},
  io: { signal?: AbortSignal } = {},
): Promise<RunInvocationResult> {
  return executeRunInvocation(
    {
      specs: [],
      options: {
        env: "remote",
        config,
        artifactRoot: join(dir, `local-${counter}`),
        ...options,
      },
      cwd: dir,
    },
    { origin: "cli", ...io },
  );
}

async function journalEvents(journalDir: string): Promise<RunEvent[]> {
  const text = await readFile(join(journalDir, "events.ndjson"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const parsed = RunEventSchema.safeParse(JSON.parse(line));
      expect(parsed.success, line).toBe(true);
      return parsed.data!;
    });
}

async function journalFile(journalDir: string) {
  return InvocationJournalSchema.parse(
    JSON.parse(await readFile(join(journalDir, "invocation.json"), "utf8")),
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-delegate-"));
  remoteRoot = await mkdtemp(join(tmpdir(), "cairn-delegate-remote-"));
  await writeDelegateProject(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(remoteRoot, { recursive: true, force: true });
});

describe("delegated runner: happy path", () => {
  it("relays the remote invocation into the local journal and verifies the run directories", async () => {
    const recording = await record("both");
    const { config, recordTo } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      stdout: ["runner: booting the remote machine"],
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(0);
    expect(result.kind).toBe("batch");
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status)).toEqual(["passed", "passed"]);
    // The documents point at the local copies, not the remote run dirs.
    for (const run of batch.results) {
      expect(run.runDir.startsWith(join(dir, `local-${counter}`))).toBe(true);
    }
    expect(batch.invocationOutcome).toMatchObject({
      exitCode: 0,
      specsExitCode: 0,
      delegate: {
        contract: "urn:cairntrace.dev:delegate:v1",
        remoteInvocationId: recording.invocationId,
        runnerExitCode: 0,
        diagnostics: 0,
      },
    });

    const journal = await journalFile(result.journalDir!);
    expect(journal.status).toBe("passed");
    expect(journal.delegate).toMatchObject({
      contract: "urn:cairntrace.dev:delegate:v1",
      remoteInvocationId: recording.invocationId,
      remoteStatus: "passed",
      exitCode: 0,
      diagnostics: 0,
    });
    expect(journal.runs).toHaveLength(2);
    for (const run of journal.runs) {
      expect(run.status).toBe("passed");
      expect(run.runDir.startsWith(join(dir, `local-${counter}`))).toBe(true);
      expect(existsSync(join(run.runDir, "run.json"))).toBe(true);
    }
    expect(journal.summary).toMatchObject({ total: 2, passed: 2, exitCode: 0 });

    const events = await journalEvents(result.journalDir!);
    const types = events.map((e) => e.type);
    expect(types).toContain("delegate.started");
    expect(types).toContain("delegate.remote.started");
    expect(types).toContain("delegate.remote.finished");
    expect(types).toContain("delegate.finished");
    expect(types.at(-1)).toBe("invocation.finished");
    const relayed = events.filter((e) => e.delegated);
    expect(relayed.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "invocation.run.started",
        "invocation.run.finished",
        "invocation.summary",
        "suite.started",
      ]),
    );
    // Remote heartbeats and the remote invocation's own start/finish are
    // never relayed as such.
    expect(
      events.filter(
        (e) =>
          e.delegated &&
          (e.type === "run.heartbeat" ||
            e.type === "invocation.started" ||
            e.type === "invocation.finished"),
      ),
    ).toEqual([]);
    const finished = events.find((e) => e.type === "delegate.finished");
    expect(finished).toMatchObject({ exitCode: 0, runs: 2, missingRunDirs: 0 });

    // The runner got the request, the env, and its output went to the log.
    const received = JSON.parse(await readFile(recordTo, "utf8")) as {
      request: { cairnArgs: string[]; suite: string; specs: string[] };
      env: Record<string, string>;
    };
    expect(received.request.suite).toBe("both");
    expect(received.request.specs).toEqual([
      "flows/alpha.yml",
      "flows/bravo.yml",
    ]);
    expect(received.request.cairnArgs).toEqual([
      "run",
      "--suite",
      "both",
      "--label",
      `cairn.delegate=${result.invocationId}`,
    ]);
    expect(received.env).toMatchObject({
      contract: "urn:cairntrace.dev:delegate:v1",
      invocationId: result.invocationId,
      invocationDir: result.journalDir,
      cairnEnv: "remote",
    });
    const log = await readFile(
      join(result.journalDir!, "logs", "delegate.log"),
      "utf8",
    );
    expect(log).toContain("runner: booting the remote machine");
    const masked = JSON.parse(
      await readFile(
        join(result.journalDir!, "delegate", "request.json"),
        "utf8",
      ),
    ) as { invocationId: string };
    expect(masked.invocationId).toBe(result.invocationId);
  }, 60_000);
});

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

function diagnosticCodes(events: RunEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "delegate.diagnostic" ? [event.code] : [],
  );
}

describe("delegated runner: verdicts", () => {
  it("passes a failing spec's exit code through (1)", async () => {
    const recording = await record("mixed");
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      exitCode: 1,
    });
    const result = await runRemote(config, { suite: "mixed" });
    expect(result.exitCode).toBe(1);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status)).toEqual(["passed", "failed"]);
    expect((await journalFile(result.journalDir!)).status).toBe("failed");
  }, 60_000);

  it("never reports a false pass: a runner that exits 0 over a failed run is exit 1", async () => {
    const recording = await record("mixed");
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "mixed" });
    expect(result.exitCode).toBe(1);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toContain(
      "exit-mismatch",
    );
  }, 60_000);

  it("a runner that exits 0 without relaying any run is exit 2", async () => {
    const { config } = await writeConfig({ lines: [], exitCode: 0 });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toContain(
      "exit-mismatch",
    );
    // Schema-valid errored stand-ins for the specs it was to run.
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status)).toEqual(["errored", "errored"]);
  }, 60_000);

  it("an exit code cairn does not use is exit 2 with a diagnostic", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      exitCode: 42,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toContain(
      "invalid-exit-code",
    );
    expect((await journalFile(result.journalDir!)).delegate?.exitCode).toBe(42);
  }, 60_000);

  it("a runner that crashes (a signal cairn did not send) is exit 2 with diagnostics", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: recording.lines.slice(0, afterFirstRun(recording.lines) + 2),
      runDirs: [],
      killSelf: "SIGKILL",
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    const events = await journalEvents(result.journalDir!);
    expect(diagnosticCodes(events)).toEqual(
      expect.arrayContaining(["runner-signal", "missing-run-dir"]),
    );
    const journal = await journalFile(result.journalDir!);
    expect(journal.status).toBe("errored");
    expect(journal.delegate).toMatchObject({ signal: "SIGKILL" });
    expect(journal.summary?.error).toContain("SIGKILL");
  }, 60_000);

  it("a runner that cannot start is exit 2 (spawn-failed)", async () => {
    counter += 1;
    const config = join(dir, `cfg-${counter}.config.yml`);
    await writeFile(
      config,
      delegateConfig(
        `      command: [${JSON.stringify(join(dir, "no-such-runner"))}]`,
      ),
    );
    const result = await runRemote(config, { suite: "one" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toContain(
      "spawn-failed",
    );
  }, 60_000);
});

describe("delegated runner: stream and run directories", () => {
  it("records malformed, unknown and invalid lines as diagnostics, keeps relaying, and does not pass over them (L2)", async () => {
    const recording = await record("both");
    const ts = new Date().toISOString();
    const lines = [
      "this is not json",
      "[1, 2, 3]",
      JSON.stringify({ no: "type" }),
      JSON.stringify({ ts, type: "future.event", value: 1 }),
      JSON.stringify({ ts, type: "suite.started", name: 3 }),
      ...recording.lines,
      // A runner that re-streams after a reconnect: exact repeats are dropped.
      ...recording.lines.slice(0, 4),
      // A newer producer's extra field is dropped, the event relayed.
      JSON.stringify({
        ts,
        type: "delegate.progress",
        message: "copying results",
        extraField: true,
      }),
    ];
    const { config } = await writeConfig({
      lines,
      runDirs: recording.runDirs,
    });
    const result = await runRemote(config, { suite: "both" });
    // Every run passed, but the contract channel carried garbage: no pass.
    expect(result.exitCode).toBe(2);
    const events = await journalEvents(result.journalDir!);
    expect(diagnosticCodes(events)).toEqual([
      "malformed-line",
      "malformed-line",
      "invalid-event",
      "unknown-event",
      "invalid-event",
      "exit-mismatch",
    ]);
    expect(
      BatchRunResultSchema.parse(result.document).invocationOutcome?.error,
    ).toContain("not a valid events.v1 event");
    const runStarts = events.filter((e) => e.type === "invocation.run.started");
    expect(runStarts).toHaveLength(2);
    expect(events.find((e) => e.type === "delegate.progress")).toMatchObject({
      message: "copying results",
      delegated: true,
    });
    expect(
      events.find((e) => e.type === "delegate.progress"),
    ).not.toHaveProperty("extraField");
  }, 60_000);

  it("a newer producer's unknown event type is a warning, not a failure", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: [
        JSON.stringify({
          ts: new Date().toISOString(),
          type: "future.event",
        }),
        ...recording.lines,
      ],
      runDirs: recording.runDirs,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(0);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual([
      "unknown-event",
    ]);
  }, 60_000);

  it("M2: a runner that reconnects mid-line and re-streams from the start passes, and no run goes back to running", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      reconnectAfter: afterFirstRun(recording.lines) + 1,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(0);
    const events = await journalEvents(result.journalDir!);
    // The torn line is a warning; its tail is a repeat and dropped.
    expect(diagnosticCodes(events)).toEqual(["malformed-line"]);
    expect(
      events.filter((e) => e.type === "invocation.run.started"),
    ).toHaveLength(2);
    expect(
      events.filter((e) => e.type === "invocation.run.finished"),
    ).toHaveLength(2);
    const journal = await journalFile(result.journalDir!);
    expect(journal.runs.map((run) => run.status)).toEqual(["passed", "passed"]);
  }, 60_000);

  it("a finished run without a run directory is exit 2 (missing-run-dir)", async () => {
    const recording = await record("both");
    const lost = recording.runDirs[0]!.split("/").pop()!;
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      skipRunDirs: [lost],
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    const events = await journalEvents(result.journalDir!);
    expect(diagnosticCodes(events)).toContain("missing-run-dir");
    expect(events.find((e) => e.type === "delegate.finished")).toMatchObject({
      runs: 2,
      missingRunDirs: 1,
    });
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results[0]).toMatchObject({
      status: "errored",
      synthetic: true,
    });
    expect(batch.results[1]!.status).toBe("passed");
    expect(batch.invocationOutcome?.error).toContain("no run directory");
  }, 60_000);
});

describe("delegated runner: cancel and timeout", () => {
  it("a cancel sends SIGINT; the runner finishes remotely and the invocation is aborted (130)", async () => {
    const recording = await record("both");
    const cut = afterFirstRun(recording.lines);
    const { config, recordTo } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      hangAfter: cut,
      onSigint: { lines: recording.lines.slice(cut), exitCode: 130 },
    });
    const controller = new AbortController();
    const pending = runRemote(
      config,
      { suite: "both" },
      { signal: controller.signal },
    );
    await waitFor(() => existsSync(recordTo));
    const localRoot = join(dir, `local-${counter}`);
    await waitFor(async () => {
      const ids = await import("node:fs/promises").then((fs) =>
        fs.readdir(join(localRoot, "_invocations")).catch(() => [] as string[]),
      );
      if (ids.length === 0) return false;
      const text = await readFile(
        join(localRoot, "_invocations", ids[0]!, "events.ndjson"),
        "utf8",
      ).catch(() => "");
      return text.includes('"invocation.run.finished"');
    });
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(130);
    expect(result.aborted).toBe(true);
    const events = await journalEvents(result.journalDir!);
    expect(
      events.find((e) => e.type === "delegate.cancel.requested"),
    ).toMatchObject({ reason: "cancel", signal: "SIGINT", graceMs: 4000 });
    expect(
      events.find((e) => e.type === "delegate.cancel.finished"),
    ).toMatchObject({ graceful: true });
    const journal = await journalFile(result.journalDir!);
    expect(journal.status).toBe("aborted");
    expect(journal.delegate).toMatchObject({ cancelled: true, exitCode: 130 });
    // What the runner relayed after SIGINT still landed.
    expect(journal.runs.map((run) => run.status)).toEqual(["passed", "passed"]);
  }, 60_000);

  it("escalates to SIGTERM when the runner ignores SIGINT past cancelGraceMs", async () => {
    const recording = await record("one");
    const { config, recordTo } = await writeConfig(
      {
        lines: recording.lines,
        runDirs: recording.runDirs,
        hangAfter: 1,
        onSigint: { ignore: true },
      },
      { cancelGraceMs: 300 },
    );
    const controller = new AbortController();
    const pending = runRemote(
      config,
      { suite: "one" },
      { signal: controller.signal },
    );
    await waitFor(() => existsSync(recordTo));
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(130);
    const events = await journalEvents(result.journalDir!);
    expect(
      events.find((e) => e.type === "delegate.cancel.escalated"),
    ).toMatchObject({ signal: "SIGTERM" });
    expect(
      events.find((e) => e.type === "delegate.cancel.finished"),
    ).toMatchObject({ graceful: false });
  }, 60_000);

  it("runner.timeoutMs cancels the runner and the invocation is exit 2", async () => {
    const recording = await record("one");
    const { config } = await writeConfig(
      {
        lines: recording.lines,
        runDirs: recording.runDirs,
        hangAfter: 2,
        onSigint: { exitCode: 130 },
      },
      { runnerExtra: "      timeoutMs: 1500\n" },
    );
    const result = await runRemote(config, { suite: "one" });
    expect(result.exitCode).toBe(2);
    const events = await journalEvents(result.journalDir!);
    expect(diagnosticCodes(events)).toContain("timeout");
    expect(
      events.find((e) => e.type === "delegate.cancel.requested"),
    ).toMatchObject({ reason: "timeout" });
    const journal = await journalFile(result.journalDir!);
    expect(journal.status).toBe("errored");
    expect(journal.delegate).toMatchObject({ timedOut: true });
  }, 60_000);
});

describe("delegated runner: plan, policy and config", () => {
  it("--services-dry-run and --select-only print the masked plan and spawn nothing", async () => {
    const secret = ["dlg", "s3cr3t", "value", "77"].join("-");
    const { config, recordTo } = await writeConfig(
      { lines: [] },
      {
        runnerExtra: `      env: { REGION: "\${vars.region}", API_TOKEN: "${secret}" }\n      timeoutMs: 600000\n`,
        extra: "vars: { region: eu-west }\n",
      },
    );
    const dry = await runRemote(config, {
      suite: "both",
      servicesDryRun: true,
      var: [`password=${secret}`, "mode=fast"],
    });
    expect(dry.exitCode).toBe(0);
    expect(dry.kind).toBe("services-dry-run");
    expect(existsSync(recordTo)).toBe(false);
    const plan = (
      dry.document as unknown as {
        plan: string[];
        delegate: {
          command: string[];
          envNames: string[];
          timeoutMs: number;
          request: {
            options: { var: string[] };
            cairnArgs: string[];
            specs: string[];
          };
        };
      }
    ).delegate;
    expect(plan.command[0]).toBe("bun");
    expect(plan.envNames).toEqual(["API_TOKEN", "REGION"]);
    expect(plan.timeoutMs).toBe(600000);
    expect(plan.request.specs).toEqual(["flows/alpha.yml", "flows/bravo.yml"]);
    expect(plan.request.options.var).toEqual([
      "password=[redacted]",
      "mode=fast",
    ]);
    expect(JSON.stringify(dry.document)).not.toContain(secret);

    const select = await runRemote(config, { suite: "both", selectOnly: true });
    expect(select.kind).toBe("selection");
    expect(existsSync(recordTo)).toBe(false);
    expect(
      (select.document as { delegate?: { env: string } }).delegate?.env,
    ).toBe("remote");
  }, 60_000);

  it("resolves runner.env and command templates and keeps secrets out of the journal", async () => {
    const recording = await record("one");
    const secret = ["dlg", "token", "value", "91"].join("-");
    const { config, recordTo } = await writeConfig(
      { lines: recording.lines, runDirs: recording.runDirs },
      {
        runnerExtra: `      env: { FAKE_RUNNER_EXTRA: "\${vars.region}", DEPLOY_TOKEN: "${secret}" }\n`,
        extra: "vars: { region: eu-west }\n",
      },
    );
    const result = await runRemote(config, { suite: "one" });
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(await readFile(recordTo, "utf8")) as {
      env: { extra: string };
    };
    expect(received.env.extra).toBe("eu-west");
    const journalText = await readFile(
      join(result.journalDir!, "invocation.json"),
      "utf8",
    );
    expect(journalText).not.toContain(secret);
  }, 60_000);

  it("takes the run lock for the delegated environment only", async () => {
    const recording = await record("one");
    const { config, recordTo } = await writeConfig(
      {
        lines: recording.lines,
        runDirs: recording.runDirs,
        hangAfter: 1,
        onSigint: { lines: recording.lines.slice(1), exitCode: 130 },
      },
      { extra: "run: { lock: true }\n" },
    );
    const controller = new AbortController();
    const first = runRemote(
      config,
      { suite: "one" },
      { signal: controller.signal },
    );
    await waitFor(() => existsSync(recordTo));
    // Another delegated invocation of the same environment is refused…
    const second = await runRemote(config, { suite: "one" });
    expect(second.exitCode).toBe(4);
    expect(second.error).toContain("delegated environment");
    // …a local environment's run is not.
    const local = await executeRunInvocation(
      {
        specs: [join(dir, "flows", "alpha.yml")],
        options: {
          env: "local",
          mock: true,
          config,
          artifactRoot: join(dir, `local-${counter}-l`),
          noWebServer: true,
          noServices: true,
        },
        cwd: dir,
      },
      { origin: "cli" },
    );
    expect(local.exitCode).toBe(0);
    controller.abort();
    const settled = await first;
    expect(settled.exitCode).toBe(130);
    const events = await journalEvents(settled.journalDir!);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["run.lock.acquired", "run.lock.released"]),
    );
  }, 60_000);

  it("spawns nothing when the environment policy refused every spec (exit 7)", async () => {
    await writeFile(
      join(dir, "flows", "local-only.yml"),
      delegateSpec("local_only").replace(
        "coldStart: guest\n",
        "coldStart: guest\nrequires: { env: [local] }\n",
      ),
    );
    const { config, recordTo } = await writeConfig({ lines: [] });
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "flows", "local-only.yml")],
        options: {
          env: "remote",
          config,
          artifactRoot: join(dir, `local-${counter}`),
        },
        cwd: dir,
      },
      { origin: "cli" },
    );
    expect(result.exitCode).toBe(7);
    expect(existsSync(recordTo)).toBe(false);
    const events = await journalEvents(result.journalDir!);
    expect(events.map((e) => e.type)).toContain("run.refused");
    expect(events.map((e) => e.type)).not.toContain("delegate.started");
  }, 60_000);

  it("refuses a runner environment that owns services (also through extends)", async () => {
    const { loadConfig } = await import("../../core/config/loader");
    const bad = join(dir, "bad-runner.config.yml");
    await writeFile(
      bad,
      `version: 1
environments:
  local:
    baseUrl: https://demo.example.test
    services:
      tmux: { session: demo, windows: [{ name: web, command: "true" }] }
  remote:
    extends: local
    runner: { command: [bun, runner.ts] }
`,
    );
    await expect(
      loadConfig(join(dir, "flows", "alpha.yml"), bad),
    ).rejects.toThrow(/has a runner .*cannot own services/s);
    await writeFile(
      bad,
      `version: 1
environments:
  local:
    baseUrl: https://demo.example.test
    services:
      tmux: { session: demo, windows: [{ name: web, command: "true" }] }
  remote:
    extends: local
    services: false
    runner: { command: [bun, runner.ts], env: { CAIRN_DELEGATE_EVENTS: x } }
`,
    );
    await expect(
      loadConfig(join(dir, "flows", "alpha.yml"), bad),
    ).rejects.toThrow(/set by cairn for the runner/);
  });
});

/* ----- never a false pass: the review's scenarios ----- */

/** The recording's lines with `edit` applied to each parsed event (null drops it). */
function editLines(
  lines: readonly string[],
  edit: (event: Record<string, unknown>) => Record<string, unknown> | null,
): string[] {
  return lines.flatMap((line) => {
    const next = edit(JSON.parse(line) as Record<string, unknown>);
    return next === null ? [] : [JSON.stringify(next)];
  });
}

function runIdOf(runDir: string): string {
  return runDir.split("/").pop()!;
}

describe("delegated runner: evidence beats the runner's exit code", () => {
  it("H1/S1: a runner that drops a failed run's lines and exits 0 is exit 2 (missing-run)", async () => {
    const recording = await record("mixed");
    const broken = recording.runDirs.find((d) => d.includes("broken"))!;
    const { config } = await writeConfig({
      lines: recording.lines.filter((line) => !line.includes(runIdOf(broken))),
      runDirs: recording.runDirs.filter((d) => d !== broken),
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "mixed" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["missing-run", "exit-mismatch"]),
    );
  }, 60_000);

  it("H1/S6: one of two planned runs relayed, runner 0, is exit 2", async () => {
    const recording = await record("both");
    const second = runIdOf(recording.runDirs[1]!);
    const { config } = await writeConfig({
      lines: recording.lines.filter((line) => !line.includes(second)),
      runDirs: [recording.runDirs[0]!],
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["missing-run", "exit-mismatch"]),
    );
  }, 60_000);

  it("H1/S3: runs passed but the remote invocation settled on 8, runner 0: exit 8", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: editLines(recording.lines, (event) => {
        if (event.type === "invocation.summary") {
          return {
            ...event,
            status: "errored",
            summary: {
              ...(event.summary as object),
              exitCode: 8,
              error: "a critical teardown failed",
            },
          };
        }
        if (event.type === "invocation.finished") {
          return { ...event, status: "errored" };
        }
        return event;
      }),
      runDirs: recording.runDirs,
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(8);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(batch.invocationOutcome?.error).toContain("remote invocation");
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual([
      "exit-mismatch",
    ]);
  }, 60_000);

  it("H2/S2: the stream says passed, the copied run.json says failed: exit 2, run.json's status stands", async () => {
    const recording = await record("mixed");
    const { config } = await writeConfig({
      lines: editLines(recording.lines, (event) =>
        event.type === "invocation.run.finished" && event.status === "failed"
          ? { ...event, status: "passed" }
          : event,
      ),
      runDirs: recording.runDirs,
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "mixed" });
    expect(result.exitCode).toBe(2);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status)).toEqual(["passed", "failed"]);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["status-mismatch", "exit-mismatch"]),
    );
    const journal = await journalFile(result.journalDir!);
    expect(journal.runs.map((run) => run.status)).toEqual(["passed", "failed"]);
  }, 60_000);

  it("H2/S2: the same on a single run (the document is the failed run.json, exit 2)", async () => {
    const recording = await record("mixed");
    const brokenId = runIdOf(
      recording.runDirs.find((d) => d.includes("broken"))!,
    );
    // A one-spec plan: only the broken run, its stream status flipped.
    const lines = editLines(recording.lines, (event) => {
      if (event.runId === undefined) return event;
      if (event.runId !== brokenId) return null;
      return event.type === "invocation.run.finished"
        ? { ...event, index: 1, status: "passed" }
        : { ...event, index: 1 };
    });
    const { config } = await writeConfig(
      {
        lines,
        runDirs: recording.runDirs.filter((d) => d.includes("broken")),
        exitCode: 0,
      },
      {
        configText: (text) =>
          text.replace(
            "suites:\n",
            "suites:\n  lone: { specs: [flows/broken.yml] }\n",
          ),
      },
    );
    const result = await runRemote(config, { suite: "lone" });
    expect(result.exitCode).toBe(2);
    expect(result.kind).toBe("single");
    expect(result.document).toMatchObject({ status: "failed", exitCode: 2 });
  }, 60_000);

  it("H2/S5: runs reported passed with synthetic: true and no run directories: exit 2 (synthetic-pass)", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: editLines(recording.lines, (event) =>
        event.type === "invocation.run.finished"
          ? { ...event, synthetic: true }
          : event,
      ),
      runDirs: [],
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["synthetic-pass", "exit-mismatch"]),
    );
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status)).toEqual(["errored", "errored"]);
  }, 60_000);

  it("H3/S4: run directories left by an earlier invocation are stale, not evidence (exit 2)", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: [],
      exitCode: 0,
    });
    // An earlier delegated invocation left these exact run directories.
    const root = join(dir, `local-${counter}`);
    const { copyRunDir } = await import("../../testing/fakeDelegateRunner");
    for (const runDir of recording.runDirs) {
      copyRunDir(runDir, join(root, runIdOf(runDir)), "an-earlier-invocation");
    }
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["stale-run", "exit-mismatch"]),
    );
    const batch = BatchRunResultSchema.parse(result.document);
    // The old run.json files are never handed over as this invocation's.
    expect(batch.results.every((r) => r.synthetic === true)).toBe(true);
  }, 60_000);

  it("H3: run.json without this invocation's cairn.delegate label is foreign (exit 2)", async () => {
    const recording = await record("both");
    const { config } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      labelRuns: false,
      exitCode: 0,
    });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    const events = await journalEvents(result.journalDir!);
    expect(
      diagnosticCodes(events).filter((code) => code === "foreign-run"),
    ).toHaveLength(2);
    expect(events.find((e) => e.type === "delegate.finished")).toMatchObject({
      missingRunDirs: 2,
    });
  }, 60_000);

  it("M5: a runner that exits 1 having relayed nothing is an infrastructure failure (2)", async () => {
    const { config } = await writeConfig({ lines: [], exitCode: 1 });
    const result = await runRemote(config, { suite: "both" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["exit-mismatch"]),
    );
    expect(
      BatchRunResultSchema.parse(result.document).invocationOutcome?.error,
    ).toContain("infrastructure failure");
  }, 60_000);

  it("M4: runner.idleTimeoutMs cancels a runner whose stream went silent (exit 2, idle)", async () => {
    const recording = await record("one");
    const { config } = await writeConfig(
      {
        lines: recording.lines,
        runDirs: recording.runDirs,
        hangAfter: 2,
        onSigint: { exitCode: 130 },
      },
      { runnerExtra: "      idleTimeoutMs: 1000\n" },
    );
    const result = await runRemote(config, { suite: "one" });
    expect(result.exitCode).toBe(2);
    const events = await journalEvents(result.journalDir!);
    expect(diagnosticCodes(events)).toContain("idle");
    expect(
      events.find((e) => e.type === "delegate.cancel.requested"),
    ).toMatchObject({ reason: "idle" });
    const journal = await journalFile(result.journalDir!);
    expect(journal.status).toBe("errored");
    expect(journal.delegate).toMatchObject({ idle: true });
    expect(journal.summary?.error).toContain("idleTimeoutMs");
  }, 60_000);

  it("L4: a cancel sends SIGINT to the runner alone; helpers in its group keep working", async () => {
    const recording = await record("both");
    const cut = afterFirstRun(recording.lines);
    const probe = join(dir, `helper-${counter + 1}.json`);
    const { config, recordTo } = await writeConfig({
      lines: recording.lines,
      runDirs: recording.runDirs,
      hangAfter: cut,
      helperProbe: probe,
      onSigint: { lines: recording.lines.slice(cut), exitCode: 130 },
    });
    const controller = new AbortController();
    const pending = runRemote(
      config,
      { suite: "both" },
      { signal: controller.signal },
    );
    await waitFor(() => existsSync(recordTo));
    await new Promise((resolveTick) => setTimeout(resolveTick, 200));
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(130);
    expect(JSON.parse(await readFile(probe, "utf8"))).toEqual({
      helperAlive: true,
    });
  }, 60_000);
});

describe("delegated runner: the local environment policy (H4) and mixed environments (H5)", () => {
  const GUARDED =
    "suites:\n  guarded: { specs: [flows/gated.yml, flows/alpha.yml] }\n";
  const withGuarded = (text: string): string =>
    text.replace("suites:\n", GUARDED);

  beforeAll(async () => {
    await writeFile(
      join(dir, "flows", "gated.yml"),
      delegateSpec("gated").replace(
        "coldStart: guest\n",
        "coldStart: guest\nrequires: { env: [local, worker] }\n",
      ),
    );
    await writeFile(
      join(dir, "flows", "remoteonly.yml"),
      delegateSpec("remoteonly").replace(
        "coldStart: guest\n",
        "coldStart: guest\nenvironment: remote\n",
      ),
    );
  });

  it("H4: narrows the suite to the specs the local policy allowed; the remote runs them with the suite (exit 0)", async () => {
    // What the remote cairn records for the request's cairnArgs.
    const narrowed = await recordDelegateSuite(dir, remoteRoot, "guarded", {
      configText: withGuarded(delegateConfig("      command: [bun, unused]")),
      specs: ["flows/alpha.yml"],
    });
    expect(narrowed.runDirs).toHaveLength(1);
    const { config, recordTo } = await writeConfig(
      { lines: narrowed.lines, runDirs: narrowed.runDirs },
      { configText: withGuarded },
    );
    const result = await runRemote(config, { suite: "guarded" });
    expect(result.exitCode).toBe(0);
    const received = JSON.parse(await readFile(recordTo, "utf8")) as {
      request: {
        cairnArgs: string[];
        specs: string[];
        planned: Array<{ index: number; spec: string }>;
        refused?: Array<{ index: number; spec: string; reason: string }>;
      };
    };
    expect(received.request.cairnArgs.slice(0, 4)).toEqual([
      "run",
      "flows/alpha.yml",
      "--suite",
      "guarded",
    ]);
    expect(received.request.specs).toEqual(["flows/alpha.yml"]);
    expect(received.request.planned).toEqual([
      { index: 2, spec: "flows/alpha.yml" },
    ]);
    expect(received.request.refused).toEqual([
      {
        index: 1,
        spec: "flows/gated.yml",
        reason: expect.stringContaining('refused in environment "remote"'),
      },
    ]);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => `${r.spec.name}:${r.status}`)).toEqual([
      "alpha:passed",
      "gated:refused",
    ]);
  }, 60_000);

  it("H4: a relayed run of a locally refused spec is refused-run (exit 2), never a second result", async () => {
    const full = await recordDelegateSuite(dir, remoteRoot, "guarded", {
      configText: withGuarded(delegateConfig("      command: [bun, unused]")),
    });
    expect(full.runDirs).toHaveLength(2);
    const { config } = await writeConfig(
      { lines: full.lines, runDirs: full.runDirs },
      { configText: withGuarded },
    );
    const result = await runRemote(config, { suite: "guarded" });
    expect(result.exitCode).toBe(2);
    expect(diagnosticCodes(await journalEvents(result.journalDir!))).toEqual(
      expect.arrayContaining(["refused-run", "exit-mismatch"]),
    );
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => `${r.spec.name}:${r.status}`)).toEqual([
      "alpha:passed",
      "gated:refused",
    ]);
    const journal = await journalFile(result.journalDir!);
    expect(journal.runs.map((run) => run.spec.split("/").pop())).toEqual([
      "alpha.yml",
    ]);
  }, 60_000);

  it("H5: an invocation mixing a runner environment with a local one is refused whatever the order (exit 4)", async () => {
    const { config, recordTo } = await writeConfig({ lines: [] });
    for (const order of [
      ["flows/alpha.yml", "flows/remoteonly.yml"],
      ["flows/remoteonly.yml", "flows/alpha.yml"],
    ]) {
      const result = await executeRunInvocation(
        {
          specs: order.map((spec) => join(dir, spec)),
          options: {
            config,
            mock: true,
            artifactRoot: join(dir, `local-${counter}-mixed`),
            noWebServer: true,
            noServices: true,
          },
          cwd: dir,
        },
        { origin: "cli" },
      );
      expect(result.exitCode, order.join(",")).toBe(4);
      expect(result.error).toContain('environment "remote" has a runner');
      expect(result.runDirs).toEqual([]);
    }
    expect(existsSync(recordTo)).toBe(false);
  }, 60_000);

  it("H5: the local runner never runs a spec in a runner environment", async () => {
    const { runSpec, DelegatedEnvironmentError } = await import(
      "../../core/runner/Runner"
    );
    const { MockBrowserBackend } = await import(
      "../../adapters/mock/MockBrowserBackend"
    );
    const { config } = await writeConfig({ lines: [] });
    await expect(
      runSpec({
        specPath: join(dir, "flows", "remoteonly.yml"),
        backend: new MockBrowserBackend(),
        configPath: config,
        artifactRoot: join(dir, `local-${counter}-guard`),
      }),
    ).rejects.toBeInstanceOf(DelegatedEnvironmentError);
    expect(existsSync(join(dir, `local-${counter}-guard`))).toBe(false);
  }, 60_000);
});
