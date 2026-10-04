import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findOrphans,
  renderOrphansMarkdown,
} from "../../cli/commands/doctorOrphans";
import { OrphansResultSchema } from "../schema/orphans.v1";
import { mkdir, writeFile } from "node:fs/promises";
import {
  BROWSER_COMMAND_RE,
  killOrphans,
  LEDGER_MAX_AGE_MS,
  scanOrphans,
} from "./orphans";
import type { ProcessProbe } from "./processProbe";
import {
  isRunSessionName,
  listLedger,
  recordLedgerSession,
  sessionPids,
} from "./sessionLedger";

let root: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-orphans-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await rm(root, { recursive: true, force: true });
});

/** A real, harmless process whose command line says it is an automation browser. */
function fakeBrowser(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 60000)", "ms-playwright-fake-browser"],
    { stdio: "ignore", detached: false },
  );
  children.push(child);
  return child;
}

/** A pid that existed and is gone (an exited, reaped child). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await until(() => !alive(pid));
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function record(opts: { ownerPid: number; pids: number[]; session?: string }) {
  const handle = recordLedgerSession({
    session: opts.session ?? "cairntrace-ledger-w0-s0",
    backend: "playwright",
    invocationId: "2026-01-01T00-00-00-000Z_1_abcdef",
    projectDir: root,
    root,
    pid: opts.ownerPid,
  });
  handle.setPids(opts.pids);
  return handle;
}

describe("owned browser-session ledger", () => {
  it("records a session, learns pids, and removes the entry once nothing is alive", () => {
    const handle = record({ ownerPid: process.pid, pids: [] });
    expect(listLedger(root)).toHaveLength(1);
    handle.setPids([999_999_001]);
    expect(listLedger(root)[0]!.entry.pids).toEqual([999_999_001]);
    handle.finish({
      list: () => [],
      cwd: () => undefined,
      elapsedSeconds: () => undefined,
      isAlive: () => false,
      command: () => undefined,
    });
    expect(listLedger(root)).toHaveLength(0);
  });

  it("keeps the entry when a recorded pid survives the close", () => {
    const handle = record({ ownerPid: process.pid, pids: [process.pid] });
    handle.finish();
    expect(listLedger(root)).toHaveLength(1);
    handle.remove();
    expect(listLedger(root)).toHaveLength(0);
  });
});

describe("scanOrphans", () => {
  it("lists a survivor whose owner is gone and leaves a live owner's session alone", async () => {
    const orphanBrowser = fakeBrowser();
    const liveBrowser = fakeBrowser();
    await until(() => alive(orphanBrowser.pid!) && alive(liveBrowser.pid!));
    record({
      ownerPid: await deadPid(),
      pids: [orphanBrowser.pid!],
      session: "orphaned",
    });
    record({
      ownerPid: process.pid,
      pids: [liveBrowser.pid!],
      session: "running",
    });
    const scan = scanOrphans({ root });
    expect(scan.live).toBe(1);
    expect(scan.orphans.map((o) => o.session)).toEqual(["orphaned"]);
    expect(scan.orphans[0]!.processes.map((p) => p.pid)).toContain(
      orphanBrowser.pid!,
    );
    expect(scan.stale).toEqual([]);
  });

  it("treats an entry with a dead owner and no surviving process as stale", async () => {
    record({ ownerPid: await deadPid(), pids: [999_999_002], session: "gone" });
    const scan = scanOrphans({ root });
    expect(scan.orphans).toEqual([]);
    expect(scan.stale).toHaveLength(1);
  });

  it("never names a pid that no longer looks like a browser", async () => {
    const probe: ProcessProbe = {
      list: () => [
        { pid: 4242, ppid: 1, command: "/usr/bin/postgres -D data" },
      ],
      cwd: () => undefined,
      elapsedSeconds: () => 100,
      isAlive: (pid) => pid === 4242,
      command: () => "/usr/bin/postgres -D data",
    };
    record({ ownerPid: 999_999_003, pids: [4242] });
    const scan = scanOrphans({ root, probe });
    expect(scan.orphans).toEqual([]);
  });
});

describe("cairn doctor --orphans", () => {
  async function setup(): Promise<{ browser: ChildProcess }> {
    const browser = fakeBrowser();
    await until(() => alive(browser.pid!));
    record({ ownerPid: await deadPid(), pids: [browser.pid!] });
    return { browser };
  }

  it("lists orphans (exit 1) without touching them and validates against the schema", async () => {
    const { browser } = await setup();
    const result = await findOrphans({}, { ledgerRoot: root });
    expect(OrphansResultSchema.parse(result)).toMatchObject({
      ok: false,
      exitCode: 1,
      killRequested: false,
      killed: 0,
    });
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]!.processes[0]!.pid).toBe(browser.pid);
    expect(alive(browser.pid!)).toBe(true);
    expect(renderOrphansMarkdown(result)).toContain(
      "cairn doctor --orphans --kill",
    );
  });

  it("reports a clean machine as exit 0", async () => {
    const result = await findOrphans({}, { ledgerRoot: root });
    expect(result).toMatchObject({ ok: true, exitCode: 0, orphans: [] });
  });

  it("refuses --kill without --yes when the output is structured or there is no terminal", async () => {
    const { browser } = await setup();
    for (const [structured, interactive] of [
      [true, true],
      [false, false],
    ] as const) {
      const result = await findOrphans(
        { kill: true, structured },
        { ledgerRoot: root, interactive },
      );
      expect(result.exitCode).toBe(2);
      expect(result.error).toContain("--yes");
      expect(alive(browser.pid!)).toBe(true);
    }
  });

  it("asks on a terminal and does nothing on a no", async () => {
    const { browser } = await setup();
    const questions: string[] = [];
    const result = await findOrphans(
      { kill: true },
      {
        ledgerRoot: root,
        interactive: true,
        confirm: async (q) => {
          questions.push(q);
          return false;
        },
      },
    );
    expect(questions[0]).toMatch(
      /Kill \d+ process\(es\) of 1 orphaned browser session/,
    );
    expect(result).toMatchObject({ ok: false, exitCode: 1, killed: 0 });
    expect(alive(browser.pid!)).toBe(true);
  });

  it("kills only the orphan after a yes, and drops its ledger entry", async () => {
    const { browser } = await setup();
    const bystander = fakeBrowser();
    await until(() => alive(bystander.pid!));
    const result = await findOrphans(
      { kill: true },
      { ledgerRoot: root, interactive: true, confirm: async () => true },
    );
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      killRequested: true,
    });
    expect(result.killed).toBeGreaterThan(0);
    expect(result.orphans[0]!.killed).toBe(true);
    await until(() => !alive(browser.pid!));
    // A browser no ledger entry names is never touched.
    expect(alive(bystander.pid!)).toBe(true);
    expect(listLedger(root)).toHaveLength(0);
  });

  it("--only kills exactly the confirmed sessions / pids, nothing listed later", async () => {
    const confirmed = fakeBrowser();
    const appeared = fakeBrowser();
    await until(() => alive(confirmed.pid!) && alive(appeared.pid!));
    record({
      ownerPid: await deadPid(),
      pids: [confirmed.pid!],
      session: "confirmed-session",
    });
    record({
      ownerPid: await deadPid(),
      pids: [appeared.pid!],
      session: "appeared-later",
    });
    const result = await findOrphans(
      { kill: true, yes: true, only: [`confirmed-session,${confirmed.pid}`] },
      { ledgerRoot: root, interactive: false },
    );
    expect(result.orphans.map((o) => o.session)).toEqual(["confirmed-session"]);
    await until(() => !alive(confirmed.pid!));
    expect(alive(appeared.pid!)).toBe(true);
    // A pid that is not the confirmed session's is never selected.
    const none = await findOrphans(
      { kill: true, yes: true, only: ["appeared-later", "1"] },
      { ledgerRoot: root, interactive: false },
    );
    expect(none).toMatchObject({ orphans: [], killed: 0, exitCode: 0 });
    expect(alive(appeared.pid!)).toBe(true);
  });

  it("--yes kills without asking", async () => {
    const { browser } = await setup();
    const result = await findOrphans(
      { kill: true, yes: true },
      {
        ledgerRoot: root,
        interactive: false,
        confirm: async () => {
          throw new Error("must not ask");
        },
      },
    );
    expect(result.exitCode).toBe(0);
    await until(() => !alive(browser.pid!));
  });

  it("killOrphans reports what is still alive", () => {
    const probe: ProcessProbe = {
      list: () => [],
      cwd: () => undefined,
      elapsedSeconds: () => undefined,
      isAlive: () => true,
      command: () => undefined,
    };
    const outcome = killOrphans(
      [
        {
          session: "s",
          backend: "playwright",
          invocationId: "i",
          ownerPid: 1,
          startedAt: "2026-01-01T00:00:00Z",
          ledgerFile: join(root, "nope.json"),
          processes: [],
        },
      ],
      probe,
    );
    expect(outcome).toEqual({ killed: 0, remaining: [] });
    expect(existsSync(join(root, "nope.json"))).toBe(false);
  });
});

/** A probe over one fake process (pid 4300). */
const probeFor = (opts: {
  command: string;
  startTime?: string;
  alive?: boolean;
}): ProcessProbe => ({
  list: () => [{ pid: 4300, ppid: 1, command: opts.command }],
  cwd: () => undefined,
  elapsedSeconds: () => 100,
  isAlive: (pid) => pid === 4300 && opts.alive !== false,
  command: (pid) => (pid === 4300 ? opts.command : undefined),
  ...(opts.startTime ? { startTime: () => opts.startTime } : {}),
});

describe("pid identity (a recycled pid is never reported or killed)", () => {
  const browser = "/cache/ms-playwright/chromium/headless_shell --remote";

  it("records the start time and command of a learnt pid", () => {
    const handle = recordLedgerSession({
      session: "identity",
      backend: "playwright",
      invocationId: "i",
      root,
      pid: 999_999_010,
      probe: probeFor({
        command: browser,
        startTime: "Thu Oct 1 10:00:00 2026",
      }),
    });
    handle.setPids([4300]);
    expect(listLedger(root)[0]!.entry.processes).toEqual([
      { pid: 4300, startedAt: "Thu Oct 1 10:00:00 2026", command: browser },
    ]);
  });

  it("does not list a pid whose start time changed (recycled)", () => {
    const handle = recordLedgerSession({
      session: "identity",
      backend: "playwright",
      invocationId: "i",
      root,
      pid: 999_999_011,
      probe: probeFor({
        command: browser,
        startTime: "Thu Oct 1 10:00:00 2026",
      }),
    });
    handle.setPids([4300]);
    const later = probeFor({
      command: browser,
      startTime: "Fri Oct 2 10:00:00 2026",
    });
    expect(scanOrphans({ root, probe: later }).orphans).toEqual([]);
    const same = probeFor({
      command: browser,
      startTime: "Thu Oct 1 10:00:00 2026",
    });
    expect(scanOrphans({ root, probe: same }).orphans).toHaveLength(1);
  });

  it("re-checks every pid right before killing it", () => {
    const orphan = {
      session: "s",
      backend: "playwright" as const,
      invocationId: "i",
      ownerPid: 999_999_012,
      startedAt: "2026-10-01T10:00:00.000Z",
      ledgerFile: join(root, "entry.json"),
      processes: [
        { pid: 4300, command: browser, startedAt: "Thu Oct 1 10:00:00 2026" },
      ],
    };
    // Between the listing and the kill the pid became someone else's.
    const recycled = probeFor({
      command: browser,
      startTime: "Fri Oct 2 10:00:00 2026",
    });
    expect(killOrphans([orphan], recycled)).toEqual({
      killed: 0,
      remaining: [],
    });
    const notABrowser = probeFor({ command: "/usr/bin/postgres -D data" });
    expect(killOrphans([orphan], notABrowser)).toEqual({
      killed: 0,
      remaining: [],
    });
  });

  it("resolves agent-browser's pid file only for an entry that never learnt a pid and only for a daemon that started with it", async () => {
    const stateDir = join(root, "ab");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "cairntrace-77.pid"), "4300\n");
    const entry = {
      version: 1 as const,
      session: "cairntrace-77",
      backend: "agent-browser" as const,
      invocationId: "i",
      ownerPid: 999_999_013,
      ownerStartedAt: "2026-10-01T09:59:00.000Z",
      startedAt: "2026-10-01T10:00:00.000Z",
      stateDir,
    };
    const daemon = "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon";
    const startedWith = probeFor({
      command: daemon,
      startTime: new Date("2026-10-01T10:00:02.000Z").toString(),
    });
    expect(sessionPids(entry, startedWith)).toEqual([4300]);
    // A later run reused the session name (pid reuse): not this entry's.
    const startedLater = probeFor({
      command: daemon,
      startTime: new Date("2026-10-03T08:00:00.000Z").toString(),
    });
    expect(sessionPids(entry, startedLater)).toEqual([]);
    // Without a start time the pid file is never trusted (fail closed).
    expect(sessionPids(entry, probeFor({ command: daemon }))).toEqual([]);
    // An entry that learnt its pids never falls back to the pid file.
    expect(sessionPids({ ...entry, pids: [999_999_014] }, startedWith)).toEqual(
      [999_999_014],
    );
  });

  it("expires entries whose owner is long gone without resolving them", () => {
    const old = Date.now() - LEDGER_MAX_AGE_MS - 60_000;
    const handle = recordLedgerSession({
      session: "ancient",
      backend: "playwright",
      invocationId: "i",
      root,
      pid: 999_999_015,
      now: () => old,
      probe: probeFor({ command: browser }),
    });
    handle.setPids([4300]);
    const scan = scanOrphans({ root, probe: probeFor({ command: browser }) });
    expect(scan.orphans).toEqual([]);
    expect(scan.stale).toHaveLength(1);
  });

  it("matches only browsers cairn launches", () => {
    for (const command of [
      "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
      "node /usr/lib/node_modules/agent-browser/dist/daemon.js",
      "/Users/x/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --enable-automation --user-data-dir=/tmp/x",
      "/usr/bin/chromium --remote-debugging-pipe",
    ]) {
      expect(BROWSER_COMMAND_RE.test(command), command).toBe(true);
    }
    for (const command of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      "bun -e console.log(1) agent-browser-notes.md",
      "vim agent-browser.md",
    ]) {
      expect(BROWSER_COMMAND_RE.test(command), command).toBe(false);
    }
  });

  it("knows the run session names from the other cairn sessions", () => {
    for (const name of [
      "cairntrace-4242",
      "cairntrace-4242-w0-s3",
      "cairntrace-mcp-4242-a1b2c3",
      "cairntrace-mcp-4242-a1b2c3-w1-s0",
    ]) {
      expect(isRunSessionName(name), name).toBe(true);
    }
    for (const name of [
      "cairntrace-disc-4242-a1b2c3",
      "cairntrace-accompany-4242-x",
      "cairntrace-snapshot-4242",
      "cairntrace-mcp-heal-4242",
      "default",
    ]) {
      expect(isRunSessionName(name), name).toBe(false);
    }
  });
});
