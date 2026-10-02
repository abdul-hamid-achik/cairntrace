import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServices, type ServicesEvent } from "./services";

// Seed freshness state normally lives under ~/.cairntrace; keep tests local.
vi.mock("./seedState", () => ({
  SeedStateStore: vi.fn().mockImplementation(() => ({
    read: vi.fn(async () => undefined),
    checkFreshness: vi.fn(() => ({
      shouldRun: true,
      reason: "no-previous-seed",
    })),
    recordRun: vi.fn(async () => undefined),
    fingerprint: vi.fn(() => "test-fp"),
  })),
}));

/**
 * The SIGINT/SIGTERM path (terminateSync) with real child processes: a boot
 * command still running is stopped before the teardown runs, a teardown
 * command already running is not started twice, and every step lands in the
 * signal evidence sink with redacted output.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-services-signal-"));
  vi.stubEnv("CAIRN_SERVICES_SIGNAL_GRACE_MS", "300");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownProcessGroup(): number {
  return Number(
    spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
    }).stdout.trim(),
  );
}

/** A live (non-zombie) member of process group `pgid` exists. */
function groupAlive(pgid: number): boolean {
  const out = spawnSync("ps", ["-A", "-o", "pgid=,stat="], {
    encoding: "utf8",
  }).stdout;
  return out.split("\n").some((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && !!stat && !stat.startsWith("Z");
  });
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (/^\d+\s*$/.test(text)) return Number(text.trim());
    if (Date.now() > deadline) throw new Error(`no pid in ${path}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

function sink(): {
  events: ServicesEvent[];
  lines: string[];
  onSignalTeardown: { event(e: ServicesEvent): void; output(l: string): void };
} {
  const events: ServicesEvent[] = [];
  const lines: string[] = [];
  return {
    events,
    lines,
    onSignalTeardown: {
      event: (e) => events.push(e),
      output: (l) => lines.push(l),
    },
  };
}

describe("services terminateSync (signal path)", () => {
  it("waits for a boot command that is exiting, then runs the teardown once with redacted evidence", async () => {
    const pidFile = join(dir, "shell.pid");
    const bootDone = join(dir, "boot.done");
    const downLog = join(dir, "down.log");
    vi.stubEnv("CAIRN_SERVICES_SIGNAL_GRACE_MS", "5000");
    const evidence = sink();
    let terminate: (() => void) | undefined;
    const pending = startServices(
      {
        docker: {
          // Stands in for a provisioner still cancelling when the signal lands.
          command: `echo $$ > "${pidFile}"; sleep 0.6; touch "${bootDone}"`,
          reuseExisting: false,
          readyTimeoutMs: 0,
        },
        teardown: [
          `if [ -f "${bootDone}" ]; then echo after-boot; else echo during-boot; fi >> "${downLog}"; echo "token=$DEMO_TOKEN"`,
        ],
      },
      {
        configDir: dir,
        project: "signal-boot",
        coldStart: true,
        env: { PATH: process.env.PATH, DEMO_TOKEN: "s3cr3t-signal-token" },
        secretValues: ["s3cr3t-signal-token"],
        onSpawn: (fn) => {
          terminate = fn;
        },
        onSignalTeardown: evidence.onSignalTeardown,
      },
    );
    await readPid(pidFile);
    expect(terminate).toBeDefined();

    const startedAt = Date.now();
    terminate!();
    // It waited for the boot command (~0.6s), not the whole 5s grace.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect((await readFile(downLog, "utf8")).trim().split("\n")).toEqual([
      "after-boot",
    ]);
    expect(evidence.events.find((e) => e.data?.kind === "boot")).toMatchObject({
      phase: "teardown",
      event: "signal",
      data: { kind: "boot", exited: true, stillRunning: 0 },
    });
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: expect.objectContaining({
          index: 0,
          status: "completed",
          exitCode: 0,
        }),
      }),
    );
    expect(evidence.lines.join("\n")).toContain("[exit 0]");
    expect(evidence.lines.join("\n")).not.toContain("s3cr3t-signal-token");

    // The boot then completes; stop() must not run the teardown again.
    const handle = await pending;
    await handle.stop();
    expect((await readFile(downLog, "utf8")).trim().split("\n")).toEqual([
      "after-boot",
    ]);
  }, 30_000);

  it("sends no signal to a boot command that outlives the grace, and tears down anyway", async () => {
    const pidFile = join(dir, "sleep.pid");
    const downLog = join(dir, "down.log");
    const evidence = sink();
    const controller = new AbortController();
    let terminate: (() => void) | undefined;
    const pending = startServices(
      {
        docker: {
          command: `sleep 30 & echo $! > "${pidFile}"; wait`,
          reuseExisting: false,
          readyTimeoutMs: 0,
        },
        teardown: [`echo down >> "${downLog}"`],
      },
      {
        configDir: dir,
        project: "signal-boot-slow",
        coldStart: true,
        env: { PATH: process.env.PATH },
        signal: controller.signal,
        onSpawn: (fn) => {
          terminate = fn;
        },
        onSignalTeardown: evidence.onSignalTeardown,
      },
    );
    pending.catch(() => undefined);
    const sleeper = await readPid(pidFile);
    terminate!();
    // Grace is 300ms here; the boot command was not signalled.
    expect(alive(sleeper)).toBe(true);
    expect(evidence.events.find((e) => e.data?.kind === "boot")).toMatchObject({
      data: { kind: "boot", exited: false, graceMs: 300 },
    });
    expect((await readFile(downLog, "utf8")).trim()).toBe("down");
    // What the CLI does right after terminateSync: abort kills the tree.
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitFor(() => !alive(sleeper), "the boot tree to die after abort");
    expect((await readFile(downLog, "utf8")).trim().split("\n")).toEqual([
      "down",
    ]);
  }, 30_000);

  it("waits for a teardown command stop() is running (in its own process group), then runs only the rest", async () => {
    const order = join(dir, "order.log");
    const firstStarted = join(dir, "first.started");
    const groupFile = join(dir, "first.pgid");
    const evidence = sink();
    const handle = await startServices(
      {
        teardown: [
          `ps -o pgid= -p $$ > "${groupFile}"; touch "${firstStarted}"; sleep 1; echo first >> "${order}"; echo first-output`,
          `echo second >> "${order}"`,
        ],
      },
      {
        configDir: dir,
        project: "signal-teardown",
        coldStart: true,
        env: { PATH: process.env.PATH },
        onSignalTeardown: evidence.onSignalTeardown,
      },
    );
    const stopping = handle.stop();
    await waitFor(() => existsSync(firstStarted), "the first teardown command");
    handle.terminateSync();
    await stopping;

    // Not started twice, and not raced: the second ran after the first.
    expect((await readFile(order, "utf8")).trim().split("\n")).toEqual([
      "first",
      "second",
    ]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: expect.objectContaining({ index: 0, status: "finished" }),
      }),
    );
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: expect.objectContaining({ index: 1, status: "completed" }),
      }),
    );
    expect(evidence.lines).toContain("first-output");
    // A Ctrl-C / group SIGTERM aimed at cairn does not reach it.
    expect(Number((await readFile(groupFile, "utf8")).trim())).not.toBe(
      ownProcessGroup(),
    );
  }, 30_000);

  it("leaves a teardown command still running after the cap to finish in the background", async () => {
    vi.stubEnv("CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS", "300");
    const order = join(dir, "order.log");
    const firstStarted = join(dir, "first.started");
    const evidence = sink();
    const handle = await startServices(
      {
        teardown: [
          `touch "${firstStarted}"; sleep 1.5; echo first >> "${order}"`,
          `echo second >> "${order}"`,
        ],
      },
      {
        configDir: dir,
        project: "signal-teardown-slow",
        coldStart: true,
        env: { PATH: process.env.PATH },
        onSignalTeardown: evidence.onSignalTeardown,
      },
    );
    const stopping = handle.stop();
    await waitFor(() => existsSync(firstStarted), "the first teardown command");
    handle.terminateSync();
    await stopping;

    expect((await readFile(order, "utf8")).trim().split("\n")).toEqual([
      "second",
      "first",
    ]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: expect.objectContaining({
          index: 0,
          status: "in-flight",
          timeoutMs: 300,
        }),
      }),
    );
  }, 30_000);

  it("runs a teardown command again when the signal killed the running copy", async () => {
    vi.stubEnv("CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS", "5000");
    const log = join(dir, "down.log");
    const marker = join(dir, "first.marker");
    const pidFile = join(dir, "first.pid");
    const evidence = sink();
    const handle = await startServices(
      {
        teardown: [
          `if [ -f "${marker}" ]; then echo again >> "${log}"; else touch "${marker}"; echo $$ > "${pidFile}"; echo started >> "${log}"; sleep 30; fi`,
        ],
      },
      {
        configDir: dir,
        project: "signal-teardown-killed",
        coldStart: true,
        env: { PATH: process.env.PATH },
        onSignalTeardown: evidence.onSignalTeardown,
      },
    );
    const stopping = handle.stop();
    const pid = await readPid(pidFile);
    // The group signal that stops cairn also took the running copy (as a
    // non-detached one would be). Wait synchronously until it is gone, so
    // stop() has not seen the exit yet when the signal path runs.
    process.kill(-pid, "SIGKILL");
    const until = Date.now() + 5_000;
    while (groupAlive(pid) && Date.now() < until) sleepSyncMs(20);
    expect(groupAlive(pid)).toBe(false);
    handle.terminateSync();
    await stopping;

    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "started",
      "again",
    ]);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: { index: 0, status: "re-run" },
      }),
    );
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: expect.objectContaining({
          index: 0,
          status: "completed",
          exitCode: 0,
        }),
      }),
    );
  }, 30_000);

  it("caps a teardown command at CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS", async () => {
    vi.stubEnv("CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS", "300");
    const evidence = sink();
    const handle = await startServices(
      { teardown: ["sleep 5"] },
      {
        configDir: dir,
        project: "signal-timeout",
        coldStart: true,
        env: { PATH: process.env.PATH },
        onSignalTeardown: evidence.onSignalTeardown,
      },
    );
    const startedAt = Date.now();
    handle.terminateSync();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(evidence.events).toContainEqual(
      expect.objectContaining({
        event: "signal",
        data: expect.objectContaining({
          index: 0,
          status: "timed-out",
          timeoutMs: 300,
        }),
      }),
    );
    expect(evidence.lines.at(-1)).toMatch(/^\[timed out after 300ms/);
  }, 30_000);
});

describe("services failure cleanup evidence", () => {
  it("emits one teardown event per command and logs its output", async () => {
    const events: ServicesEvent[] = [];
    const output: string[] = [];
    await expect(
      startServices(
        {
          docker: { command: "exit 3", reuseExisting: false },
          teardown: ["echo cleaned", "exit 5"],
        },
        {
          configDir: dir,
          project: "cleanup-evidence",
          coldStart: true,
          env: { PATH: process.env.PATH },
          onEvent: (e) => events.push(e),
          onServiceOutput: (source, line) => {
            if (source === "teardown") output.push(line);
          },
        },
      ),
    ).rejects.toThrow();
    const teardown = events.filter((e) => e.phase === "teardown");
    expect(teardown.map((e) => e.event)).toEqual([
      "failure-cleanup",
      "complete",
      "fail",
    ]);
    expect(teardown[1]?.data).toMatchObject({ index: 0, exitCode: 0 });
    expect(teardown[2]?.data).toMatchObject({ index: 1, exitCode: 5 });
    expect(output).toEqual(
      expect.arrayContaining(["$ echo cleaned", "cleaned", "[exit 0]"]),
    );
  }, 30_000);
});
