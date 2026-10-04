import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTmux, type FakeTmux } from "../../testing/fakeTmux";
import type { ServicesConfig, TmuxConfig } from "../schema/config.v1";
import { ServicesConfigSchema } from "../schema/config.v1";
import { verifyClean } from "../runPolicy/cleanliness";
import { tmuxCapture } from "../servicesOps/logs";
import { supervisorMarkerPath } from "../servicesOps/supervisorMarker";
import { tunnelStateKey, tunnelStatePath } from "../servicesOps/tunnels";
import {
  checkServicesLive,
  evaluateProvisionerExports,
  restartTmuxWindows,
  teardownServices,
  ServicesError,
  ServicesRefusedError,
  startServices,
  type ServicesEvent,
  type ServicesHandle,
  type StartServicesContext,
} from "./services";

/**
 * Services operations against a stub tmux (a bash script on PATH), real
 * shell commands and real helper processes, all in a temp dir: restart,
 * supervision, tunnels, provisioner, files and the seed transaction. Nothing
 * here starts a real tmux server, docker, or a billable resource.
 */

let dir: string;
let fake: FakeTmux;
let undo: () => void;
let events: ServicesEvent[];
let handles: ServicesHandle[];
let spawned: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-ops-int-"));
  mkdirSync(join(dir, "state"));
  fake = createFakeTmux();
  undo = fake.activate();
  events = [];
  handles = [];
  spawned = [];
});

afterEach(async () => {
  for (const handle of handles) {
    await handle.stop().catch(() => undefined);
  }
  for (const pid of spawned) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  undo();
  fake.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function ctxFor(
  extra: Partial<StartServicesContext> = {},
): StartServicesContext {
  return {
    configDir: dir,
    project: "ops-demo",
    envName: "local",
    stateRoot: join(dir, "state"),
    serviceLogRoot: join(dir, "state"),
    supervisionIntervalMs: 50,
    env: { ...process.env, OPS_DIR: dir } as NodeJS.ProcessEnv,
    onEvent: (event) => events.push(event),
    ...extra,
  };
}

async function boot(
  cfg: ServicesConfig,
  extra: Partial<StartServicesContext> = {},
): Promise<ServicesHandle> {
  const parsed = ServicesConfigSchema.parse(cfg);
  const handle = await startServices(parsed, ctxFor(extra));
  handles.push(handle);
  return handle;
}

const types = (): string[] => events.map((e) => `${e.phase}.${e.event}`);
const line = (name: string): string[] =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
    : [];

async function waitFor(
  condition: () => boolean,
  ms = 10_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The state file of a tunnel of the test project (project + env + config dir). */
function tunnelFile(name: string): string {
  return tunnelStatePath(
    join(dir, "state"),
    tunnelStateKey({ project: "ops-demo", env: "local", configDir: dir }),
    name,
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const WEB: TmuxConfig = {
  session: "ops",
  windows: [
    {
      name: "web",
      command: "run-web",
      readyOn: { text: "listening on 3000" },
    },
  ],
};

/* Config builders shared by the tests below. */

const supervisedWeb = (restart: object, extra: object = {}): ServicesConfig =>
  ({
    tmux: {
      session: "ops",
      windows: [
        {
          name: "web",
          command: "run-web",
          readyOn: { text: "listening on 3000" },
          restart,
          ...extra,
        },
      ],
    },
  }) as ServicesConfig;

/**
 * A teardown probe: the stub tunnel records its pid; this says whether it was
 * up (a killed process stays a zombie until its parent reaps it: not "up").
 */
const probe = (label: string): string =>
  `st=$(ps -o stat= -p "$(cat "$OPS_DIR/tunnel.pid")" 2>/dev/null); case "$st" in ""|Z*) echo "${label}:down" >> "$OPS_DIR/probe.log";; *) echo "${label}:up" >> "$OPS_DIR/probe.log";; esac`;

const provisionerBase = (
  extra: Partial<ServicesConfig> = {},
): ServicesConfig => ({
  provisioner: {
    up: 'echo up >> "$OPS_DIR/prov.log"',
    down: { run: 'echo down >> "$OPS_DIR/prov.log"' },
    exports: {
      REMOTE_HOST: "echo 10.1.2.3",
      REMOTE_API_TOKEN: "echo opaque-value-1",
    },
  },
  ...extra,
});

const provisionerWithExport = (up: string): ServicesConfig => ({
  provisioner: {
    up,
    down: 'echo "down $SANDBOX_ID" >> "$OPS_DIR/prov.log"',
    exports: { SANDBOX_ID: "echo sbx-7" },
  },
});

const seedPhase = (name: string, extra: object = {}) => ({
  name,
  run: `echo ${name} >> "$OPS_DIR/seed.log"`,
  ...extra,
});

const phasedSeed = (phases: object[]): ServicesConfig =>
  ({ seed: { phases, ttlSeconds: 600 } }) as ServicesConfig;

const committedSeed = (post: string): ServicesConfig =>
  ({
    seed: {
      command: 'echo seed >> "$OPS_DIR/seed.log"',
      ttlSeconds: 600,
      commit: "afterPostCommands",
      postCommands: [post],
    },
  }) as ServicesConfig;

const seedWithPost = (post: string): ServicesConfig =>
  ({
    seed: {
      command: 'echo seed >> "$OPS_DIR/seed.log"',
      ttlSeconds: 600,
      postCommands: [post],
    },
  }) as ServicesConfig;

const seedPostCommands = (
  postCommands: Array<object | string>,
): ServicesConfig =>
  ({ seed: { command: "true", postCommands } }) as ServicesConfig;

describe("services restart", () => {
  it("interrupts, clears, marks the new generation and waits for its output", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.setPane("ops", "web", "listening on 3000\nstale request log\n");
    fake.setOutput("ops", "web", "compiling\nlistening on 3000\n");
    const report = await restartTmuxWindows(WEB, ctxFor(), ["web"], {
      stopTimeoutMs: 5_000,
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      window: "web",
      ok: true,
      alreadyStopped: false,
    });
    expect(report.results[0]!.generation).toMatch(/^[0-9a-f]{8}$/);
    expect(fake.sent("ops", "web")).toEqual(["run-web"]);
    const calls = fake.calls();
    const at = (needle: string): number =>
      calls.findIndex((c) => c.includes(needle));
    expect(at("C-c")).toBeGreaterThan(-1);
    expect(at("clear-history")).toBeGreaterThan(at("C-c"));
    expect(
      at(`@@cairn-restart:${report.results[0]!.generation}@@`),
    ).toBeGreaterThan(at("clear-history"));
    expect(at("run-web")).toBeGreaterThan(at("@@cairn-restart:"));
    const pane = fake.pane("ops", "web");
    expect(pane).not.toContain("stale request log");
    expect(pane.indexOf("@@cairn-restart:")).toBeLessThan(
      pane.indexOf("listening on 3000"),
    );
    expect(report.events.map((e) => `${e.phase}.${e.event}`)).toEqual([
      "restart.start",
      "restart.stop",
      "restart.ready",
    ]);
  });

  it("does not take stale scrollback for the new process' readiness", async () => {
    process.env.FAKE_TMUX_KEEP_HISTORY = "1";
    try {
      fake.seedRunning("ops", ["web"]);
      fake.setPane("ops", "web", "listening on 3000\nold gen\n");
      fake.setOutput("ops", "web", "listening on 3000\n");
      fake.setDelay("ops", "web", 3);
      const report = await restartTmuxWindows(WEB, ctxFor(), ["web"], {
        stopTimeoutMs: 5_000,
        readyTimeoutMs: 1_500,
      });
      expect(report.results[0]).toMatchObject({ ok: false });
      expect(report.results[0]!.error).toMatch(/did not become ready/);
      expect(report.events.map((e) => e.event)).toContain("fail");
      // The old text is still there above the marker: readiness ignored it.
      expect(fake.pane("ops", "web")).toContain("old gen");
    } finally {
      delete process.env.FAKE_TMUX_KEEP_HISTORY;
    }
  });

  it("waits for the new generation when it does print the text", async () => {
    process.env.FAKE_TMUX_KEEP_HISTORY = "1";
    try {
      fake.seedRunning("ops", ["web"]);
      fake.setPane("ops", "web", "listening on 3000\n");
      fake.setOutput("ops", "web", "listening on 3000\n");
      fake.setDelay("ops", "web", 2);
      const report = await restartTmuxWindows(WEB, ctxFor(), ["web"], {
        stopTimeoutMs: 5_000,
        readyTimeoutMs: 10_000,
      });
      expect(report.results[0]).toMatchObject({ ok: true });
      expect(report.results[0]!.durationMs).toBeGreaterThanOrEqual(1_800);
    } finally {
      delete process.env.FAKE_TMUX_KEEP_HISTORY;
    }
  });

  it("fails after the stop timeout when the process ignores Ctrl-C, never killing it", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.ignoreInterrupts("ops", "web", 100);
    const report = await restartTmuxWindows(WEB, ctxFor(), ["web"], {
      stopTimeoutMs: 1_200,
    });
    expect(report.results[0]).toMatchObject({ ok: false });
    expect(report.results[0]!.error).toMatch(
      /did not exit within 1s after Ctrl-C/,
    );
    const interrupts = fake
      .callsOf("send-keys")
      .filter((c) => c.endsWith("C-c"));
    expect(interrupts).toHaveLength(2);
    expect(fake.callsOf("kill-session")).toHaveLength(0);
    expect(fake.sent("ops", "web")).toHaveLength(0);
  });

  it("restarts several windows in order and skips the rest after a failure", async () => {
    const cfg: TmuxConfig = {
      session: "ops",
      windows: [
        { name: "a", command: "run-a" },
        { name: "b", command: "run-b" },
        { name: "c", command: "run-c" },
      ],
    };
    fake.seedRunning("ops", ["a", "b", "c"]);
    fake.ignoreInterrupts("ops", "b", 100);
    const report = await restartTmuxWindows(cfg, ctxFor(), ["a", "b", "c"], {
      stopTimeoutMs: 800,
    });
    expect(
      report.results.map((r) => [r.window, r.ok, r.skipped ?? false]),
    ).toEqual([
      ["a", true, false],
      ["b", false, false],
      ["c", false, true],
    ]);
    expect(fake.sent("ops", "a")).toEqual(["run-a"]);
    expect(fake.sent("ops", "c")).toHaveLength(0);
  });

  it("restarts a window that already exited without sending Ctrl-C", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.exit("ops", "web");
    fake.setOutput("ops", "web", "listening on 3000\n");
    const report = await restartTmuxWindows(WEB, ctxFor(), ["web"]);
    expect(report.results[0]).toMatchObject({ ok: true, alreadyStopped: true });
    expect(
      fake.callsOf("send-keys").filter((c) => c.endsWith("C-c")),
    ).toHaveLength(0);
  });

  it("refuses unowned windows, a missing session and a missing live window, touching nothing", async () => {
    fake.seedRunning("ops", ["web"]);
    await expect(restartTmuxWindows(WEB, ctxFor(), ["ghost"])).rejects.toThrow(
      /not a window of the configured tmux session "ops" \(configured: web\)/,
    );
    await expect(restartTmuxWindows(WEB, ctxFor(), [])).rejects.toBeInstanceOf(
      ServicesRefusedError,
    );
    const two: TmuxConfig = {
      session: "ops",
      windows: [...WEB.windows, { name: "api", command: "run-api" }],
    };
    await expect(
      restartTmuxWindows(two, ctxFor(), ["web", "api"]),
    ).rejects.toThrow(/window "api" is missing from the running session "ops"/);
    await expect(
      restartTmuxWindows({ ...WEB, session: "other" }, ctxFor(), ["web"]),
    ).rejects.toThrow(/session "other" is not running/);
    expect(fake.callsOf("send-keys")).toHaveLength(0);
  });
});

describe("exact tmux targets: a foreign session whose name starts with ours", () => {
  // tmux resolves a bare `-t ops` to `ops-wt` when `ops` does not exist
  // (and `ops:web` to a window `web-worker`); the fake does the same.
  beforeEach(() => {
    fake.seedRunning("ops-wt", ["web"]);
    fake.setPane("ops-wt", "web", "foreign request log\n");
  });

  it("restart refuses and never types into the foreign session", async () => {
    await expect(restartTmuxWindows(WEB, ctxFor(), ["web"])).rejects.toThrow(
      /session "ops" is not running/,
    );
    expect(fake.callsOf("send-keys")).toHaveLength(0);
    expect(fake.callsOf("clear-history")).toHaveLength(0);
    expect(fake.pane("ops-wt", "web")).toBe("foreign request log\n");
  });

  it("restart refuses a missing window even when another window starts with its name", async () => {
    fake.seedRunning("ops", ["web-worker"]);
    await expect(restartTmuxWindows(WEB, ctxFor(), ["web"])).rejects.toThrow(
      /window "web" is missing from the running session "ops"/,
    );
    expect(fake.callsOf("send-keys")).toHaveLength(0);
  });

  it("logs do not capture the foreign session", async () => {
    expect(await tmuxCapture("ops", "web")()).toBeUndefined();
    fake.seedRunning("ops", ["web-worker"]);
    expect(await tmuxCapture("ops", "web")()).toBeUndefined();
  });

  it("services down does not kill the foreign session", async () => {
    const report = await teardownServices(
      ServicesConfigSchema.parse({ tmux: WEB }),
      ctxFor(),
    );
    expect(report.tmuxKilled).toBe(false);
    expect(fake.callsOf("kill-session")).toHaveLength(0);
    expect(
      readFileSync(join(fake.dir, "sessions"), "utf8").split("\n"),
    ).toContain("ops-wt");
  });

  it("status reports our session as down, not the foreign one as up", async () => {
    const live = await checkServicesLive(
      ServicesConfigSchema.parse({ tmux: WEB }),
      ctxFor(),
    );
    expect(live.problems.join("\n")).toMatch(/session "ops" is not running/);
  });

  it("status reports a missing window when only a prefix-named window runs", async () => {
    fake.seedRunning("ops", ["web-worker"]);
    const live = await checkServicesLive(
      ServicesConfigSchema.parse({ tmux: WEB }),
      ctxFor(),
    );
    expect(live.problems.join("\n")).toMatch(/window "web" is missing/);
  });

  it("run.verifyClean does not count the foreign session as ours", () => {
    const env = {
      PATH: process.env.PATH,
      FAKE_TMUX_DIR: fake.dir,
    };
    const [finding] = verifyClean([{ kind: "tmux", name: "ops" }], {
      projectDir: dir,
      env,
      redact: (text) => text,
      ignorePids: [],
    });
    expect(finding).toMatchObject({ kind: "tmux", name: "ops", clean: true });
    const [ours] = verifyClean([{ kind: "tmux", name: "ops-wt" }], {
      projectDir: dir,
      env,
      redact: (text) => text,
      ignorePids: [],
    });
    expect(ours).toMatchObject({ clean: false });
  });
});

describe("a shell-named service (`bash start.sh`)", () => {
  it("restart interrupts it instead of reading the shell name as stopped", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.foregroundJob("ops", "web", "bash");
    fake.setOutput("ops", "web", "listening on 3000\n");
    const report = await restartTmuxWindows(WEB, ctxFor(), ["web"], {
      stopTimeoutMs: 5_000,
      readyTimeoutMs: 10_000,
    });
    expect(report.results[0]).toMatchObject({
      ok: true,
      alreadyStopped: false,
    });
    expect(
      fake.callsOf("send-keys").filter((c) => c.endsWith("C-c")),
    ).toHaveLength(1);
    expect(fake.sent("ops", "web")).toEqual(["run-web"]);
  });

  it("status reads it as running, not as an idle shell", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.foregroundJob("ops", "web", "bash");
    const live = await checkServicesLive(
      ServicesConfigSchema.parse({
        tmux: { session: "ops", windows: [{ name: "web", command: "x" }] },
      }),
      ctxFor(),
    );
    expect(live.problems).toEqual([]);
    // The job ended: the same shell name is now an idle shell.
    fake.exit("ops", "web");
    const after = await checkServicesLive(
      ServicesConfigSchema.parse({
        tmux: { session: "ops", windows: [{ name: "web", command: "x" }] },
      }),
      ctxFor(),
    );
    expect(after.problems.join("\n")).toMatch(/back at an idle shell \(zsh\)/);
  });
});

describe("window supervision", () => {
  it("restarts a window that exits (on-exit), then gives up after max", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    await boot(supervisedWeb({ policy: "on-exit", backoff: "100ms", max: 1 }));
    expect(fake.sent("ops", "web")).toHaveLength(1);
    fake.exit("ops", "web");
    await waitFor(
      () => fake.sent("ops", "web").length === 2,
      15_000,
      "the first restart",
    );
    await waitFor(() => types().includes("restart.ready"), 15_000, "readiness");
    fake.exit("ops", "web");
    await waitFor(
      () => types().includes("restart.giveup"),
      15_000,
      "the give-up",
    );
    const sentBefore = fake.sent("ops", "web").length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.sent("ops", "web")).toHaveLength(sentBefore);
  }, 40_000);

  it("leaves a window alone when its policy is never, and when supervise is false", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    await boot(supervisedWeb({ policy: "never" }));
    fake.exit("ops", "web");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fake.sent("ops", "web")).toHaveLength(1);
  });

  it("does not supervise under supervise: false (services up)", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    await boot(supervisedWeb({ policy: "on-exit", backoff: "50ms" }), {
      supervise: false,
    });
    fake.exit("ops", "web");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fake.sent("ops", "web")).toHaveLength(1);
  });

  it("stops supervising before the teardown", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    const handle = await boot(
      supervisedWeb({ policy: "on-exit", backoff: "50ms" }),
    );
    // While it supervises, a marker names this process (services restart
    // from another process refuses); the stop removes it.
    const marker = supervisorMarkerPath(join(dir, "state"), "ops");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      session: "ops",
      pid: process.pid,
      windows: ["web"],
    });
    await handle.stop();
    expect(existsSync(marker)).toBe(false);
    fake.exit("ops", "web");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.sent("ops", "web")).toHaveLength(1);
  });

  it("onUnhealthy: restart restarts a window whose healthcheck keeps failing", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    const healthy = join(dir, "healthy");
    await boot(
      supervisedWeb(
        { policy: "never" },
        {
          healthcheck: {
            command: `test -f ${healthy}`,
            intervalSeconds: 1,
            retries: 1,
            onUnhealthy: "restart",
          },
        },
      ),
    );
    await waitFor(
      () => fake.sent("ops", "web").length === 2,
      20_000,
      "the unhealthy restart",
    );
    writeFileSync(healthy, "");
    expect(types()).toContain("tmux.healthcheck");
    await waitFor(() => types().includes("restart.ready"), 15_000, "readiness");
    const sent = fake.sent("ops", "web").length;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(fake.sent("ops", "web")).toHaveLength(sent);
  }, 40_000);

  it("onUnhealthy: warn only reports", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    const warnings: string[] = [];
    await boot(
      supervisedWeb(
        { policy: "never" },
        {
          healthcheck: {
            command: "false",
            intervalSeconds: 1,
            retries: 1,
            onUnhealthy: "warn",
          },
        },
      ),
      { warn: (m) => warnings.push(m) },
    );
    await waitFor(
      () => warnings.some((w) => /unhealthy/.test(w)),
      10_000,
      "the warning",
    );
    expect(fake.sent("ops", "web")).toHaveLength(1);
    expect(types()).not.toContain("restart.start");
  }, 20_000);
});

describe("tunnels", () => {
  const tunnelState = (name: string): { pid: number; state: string } =>
    JSON.parse(readFileSync(tunnelFile(name), "utf8"));

  it("starts, records pid and state, waits for its gate, and stops on stop()", async () => {
    const marker = join(dir, "tunnel-up");
    const handle = await boot({
      tunnels: [
        {
          name: "db",
          command: `touch ${marker}; exec sleep 41`,
          ready: { command: `test -f ${marker}`, every: "50ms", timeout: "5s" },
        },
      ],
    });
    const { pid, state } = tunnelState("db");
    spawned.push(pid);
    expect(state).toBe("running");
    expect(alive(pid)).toBe(true);
    expect(types()).toEqual(
      expect.arrayContaining(["tunnel.start", "tunnel.ready"]),
    );
    await handle.stop();
    await waitFor(() => !alive(pid), 5_000, "the tunnel to stop");
    expect(existsSync(tunnelFile("db"))).toBe(false);
    expect(types()).toContain("tunnel.stop");
  });

  it("fails the boot when the tunnel exits before it is ready, with its output", async () => {
    await expect(
      boot({
        tunnels: [
          {
            name: "db",
            command: "echo boom-from-tunnel; exit 3",
            ready: { command: "false", every: "50ms", timeout: "5s" },
          },
        ],
      }),
    ).rejects.toThrow(
      /tunnel "db": exited \(exit 3\) before it was ready[\s\S]*boom-from-tunnel/,
    );
    expect(types()).toContain("tunnel.fail");
  });

  it("stops tunnels already started when a later phase fails", async () => {
    await expect(
      boot({
        tunnels: [{ name: "db", command: "exec sleep 42" }],
        seed: { command: "exit 1" },
      }),
    ).rejects.toBeInstanceOf(ServicesError);
    const started = events.find(
      (e) => e.phase === "tunnel" && e.event === "start",
    );
    const pid = Number(started?.data?.pid);
    spawned.push(pid);
    // The cleanup removed the state file and ended the process.
    expect(existsSync(tunnelFile("db"))).toBe(false);
    await waitFor(() => !alive(pid), 5_000, "the tunnel to stop");
    expect(types()).toContain("tunnel.stop");
  });

  it("restarts an exiting tunnel (restart: always) and gives up after giveUpAfter", async () => {
    await boot({
      tunnels: [
        {
          name: "flaky",
          command: "sleep 0.4; exit 1",
          restart: "always",
          giveUpAfter: 2,
          backoff: "50ms",
        },
      ],
    });
    await waitFor(
      () => types().includes("tunnel.giveup"),
      15_000,
      "tunnel give-up",
    );
    const names = types().filter((t) => t.startsWith("tunnel."));
    expect(names.filter((t) => t === "tunnel.restart")).toHaveLength(2);
    expect(names.filter((t) => t === "tunnel.exit")).toHaveLength(3);
    expect(tunnelState("flaky").state).toBe("gave-up");
  }, 30_000);

  it("does not restart under restart: never", async () => {
    await boot({
      tunnels: [
        { name: "once", command: "sleep 0.4; exit 1", restart: "never" },
      ],
    });
    await waitFor(() => types().includes("tunnel.exit"), 10_000, "tunnel exit");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(types()).not.toContain("tunnel.restart");
  });

  it("stops a copy an earlier crashed run left behind", async () => {
    const command = "exec sleep 4343";
    const old = spawn("sh", ["-c", command], {
      detached: true,
      stdio: "ignore",
    });
    old.unref();
    spawned.push(old.pid!);
    writeFileSync(
      tunnelFile("db"),
      JSON.stringify({
        version: 1,
        name: "db",
        pid: old.pid,
        startedAt: new Date().toISOString(),
        state: "running",
        restarts: 0,
        logFile: "x",
      }),
    );
    const warnings: string[] = [];
    await boot(
      { tunnels: [{ name: "db", command }] },
      { warn: (m) => warnings.push(m), log: () => undefined },
    );
    await waitFor(() => !alive(old.pid!), 5_000, "the old copy to stop");
    const now = tunnelState("db");
    spawned.push(now.pid);
    expect(now.pid).not.toBe(old.pid);
    expect(warnings.join("\n")).toMatch(/left by an earlier run/);
  });

  it("never reclaims a tunnel another live cairn process owns, nor removes its state", async () => {
    const command = "exec sleep 4545";
    const other = spawn("sh", ["-c", command], {
      detached: true,
      stdio: "ignore",
    });
    other.unref();
    spawned.push(other.pid!);
    // The owner: a live process that is not this one.
    const owner = spawn("sh", ["-c", "exec sleep 4546"], {
      detached: true,
      stdio: "ignore",
    });
    owner.unref();
    spawned.push(owner.pid!);
    const foreign = {
      version: 1,
      name: "db",
      pid: other.pid,
      startedAt: new Date().toISOString(),
      state: "running",
      restarts: 0,
      logFile: "x",
      owner: { pid: owner.pid },
    };
    writeFileSync(tunnelFile("db"), JSON.stringify(foreign));
    await expect(boot({ tunnels: [{ name: "db", command }] })).rejects.toThrow(
      /tunnel "db": it is running for another live cairn process \(pid \d+\)/,
    );
    expect(alive(other.pid!)).toBe(true);
    expect(JSON.parse(readFileSync(tunnelFile("db"), "utf8")).pid).toBe(
      other.pid,
    );
    // `services down` leaves it to its owner too.
    const report = await teardownServices(
      ServicesConfigSchema.parse({ tunnels: [{ name: "db", command }] }),
      ctxFor(),
    );
    expect(report.tunnels).toEqual([{ name: "db", result: "skipped" }]);
    expect(alive(other.pid!)).toBe(true);
  });

  it("keys the state by environment and config: two of them never stop each other", async () => {
    const cfg: ServicesConfig = {
      tunnels: [{ name: "db", command: "exec sleep 4547" }],
    };
    const local = await boot(cfg);
    const staging = await boot(cfg, { envName: "staging" });
    const stagingFile = tunnelStatePath(
      join(dir, "state"),
      tunnelStateKey({ project: "ops-demo", env: "staging", configDir: dir }),
      "db",
    );
    const localPid = JSON.parse(readFileSync(tunnelFile("db"), "utf8")).pid;
    const stagingPid = JSON.parse(readFileSync(stagingFile, "utf8")).pid;
    spawned.push(localPid, stagingPid);
    expect(localPid).not.toBe(stagingPid);
    await local.stop();
    await waitFor(() => !alive(localPid), 5_000, "the local tunnel to stop");
    expect(alive(stagingPid)).toBe(true);
    expect(existsSync(stagingFile)).toBe(true);
    expect(existsSync(tunnelFile("db"))).toBe(false);
    await staging.stop();
  });

  it("stop() leaves a state file another process rewrote", async () => {
    const handle = await boot({
      tunnels: [{ name: "db", command: "exec sleep 4548" }],
    });
    const ours = JSON.parse(readFileSync(tunnelFile("db"), "utf8"));
    spawned.push(ours.pid);
    const rewritten = { ...ours, pid: 1, owner: { pid: 1 } };
    writeFileSync(tunnelFile("db"), JSON.stringify(rewritten));
    await handle.stop();
    await waitFor(() => !alive(ours.pid), 5_000, "our tunnel to stop");
    expect(JSON.parse(readFileSync(tunnelFile("db"), "utf8")).pid).toBe(1);
  });

  it("never signals the pid of a tunnel that already exited (it may be reused)", async () => {
    const handle = await boot({
      tunnels: [
        { name: "once", command: "sleep 0.4; exit 0", restart: "never" },
      ],
    });
    const { pid } = JSON.parse(readFileSync(tunnelFile("once"), "utf8"));
    await waitFor(() => types().includes("tunnel.exit"), 10_000, "tunnel exit");
    // The pid now belongs to an unrelated, live process.
    fake.setProcess(pid, { stat: "S", lstart: "Mon Jan  1 00:00:00 2024" });
    const kills: Array<number> = [];
    const realKill = process.kill.bind(process);
    const spy = vi
      .spyOn(process, "kill")
      .mockImplementation((target: number, signal?: string | number) => {
        if (Math.abs(target) !== pid) return realKill(target, signal);
        if (signal !== 0) kills.push(pid);
        return true;
      });
    try {
      await handle.stop();
    } finally {
      spy.mockRestore();
    }
    expect(kills).not.toContain(pid);
  });

  it("stops tunnels on the signal path", async () => {
    const handle = await boot({
      tunnels: [{ name: "db", command: "exec sleep 44" }],
    });
    const { pid } = tunnelState("db");
    spawned.push(pid);
    handle.terminateSync();
    expect(existsSync(tunnelFile("db"))).toBe(false);
    await waitFor(() => !alive(pid), 5_000, "the tunnel to stop");
  });

  it("keeps tunnels up for the teardown commands on the signal path, then stops them before the provisioner's down", async () => {
    const handle = await boot({
      tunnels: [
        {
          name: "db",
          command: 'echo $$ > "$OPS_DIR/tunnel.pid"; exec sleep 46',
        },
      ],
      teardown: [probe("teardown")],
      provisioner: {
        up: "true",
        down: { run: `${probe("down")}; echo down >> "$OPS_DIR/prov.log"` },
      },
    });
    const { pid } = tunnelState("db");
    spawned.push(pid);
    expect(alive(pid)).toBe(true);
    handle.terminateSync();
    // The teardown command reached the tunnel; the provisioner's down (last)
    // did not need it any more, and the tunnel is gone.
    expect(line("probe.log")).toEqual(["teardown:up", "down:down"]);
    expect(line("prov.log")).toEqual(["down"]);
    expect(existsSync(tunnelFile("db"))).toBe(false);
    await waitFor(() => !alive(pid), 5_000, "the tunnel to stop");
  });

  it("still stops the tunnels on the signal path when nothing is configured to tear down", async () => {
    const handle = await boot({
      tunnels: [{ name: "db", command: "exec sleep 47" }],
    });
    const { pid } = tunnelState("db");
    spawned.push(pid);
    handle.terminateSync();
    await waitFor(() => !alive(pid), 5_000, "the tunnel to stop");
  });
});

describe("provisioner", () => {
  it("exports values to later phases and keeps their values out of the events", async () => {
    const handle = await boot(
      provisionerBase({
        seed: { command: 'echo "$REMOTE_HOST" > "$OPS_DIR/seen-host"' },
      }),
    );
    expect(line("seen-host")).toEqual(["10.1.2.3"]);
    expect(handle.exportedEnv).toEqual({
      REMOTE_HOST: "10.1.2.3",
      REMOTE_API_TOKEN: "opaque-value-1",
    });
    const exported = events.find(
      (e) => e.phase === "provisioner" && e.event === "exports",
    );
    expect(exported?.data).toEqual({
      names: ["REMOTE_HOST", "REMOTE_API_TOKEN"],
    });
    expect(JSON.stringify(events)).not.toContain("10.1.2.3");
    expect(JSON.stringify(events)).not.toContain("opaque-value-1");
    expect(types().indexOf("provisioner.ready")).toBeLessThan(
      types().indexOf("seed.start"),
    );
  });

  it("runs down on stop, after the tunnels, and a failed down is a critical failure", async () => {
    const handle = await boot(
      provisionerBase({
        tunnels: [{ name: "db", command: "exec sleep 45" }],
        provisioner: {
          up: "true",
          down: {
            run: 'echo down >> "$OPS_DIR/prov.log"; exit 5',
            timeout: "10s",
          },
        },
      }),
    );
    spawned.push(JSON.parse(readFileSync(tunnelFile("db"), "utf8")).pid);
    await handle.stop();
    expect(line("prov.log")).toEqual(["down"]);
    expect(types().indexOf("tunnel.stop")).toBeLessThan(
      events.findIndex(
        (e) => e.phase === "teardown" && e.data?.provisioner === true,
      ),
    );
    expect(handle.criticalTeardownFailures?.()).toEqual([
      expect.objectContaining({ exitCode: 5, path: "teardown" }),
    ]);
    const down = events.find(
      (e) => e.phase === "teardown" && e.data?.provisioner === true,
    );
    expect(down).toMatchObject({
      event: "fail",
      data: { critical: true, provisioner: true },
    });
  });

  it("runs down after a failed boot (a later phase failed) and reports a failed down", async () => {
    const error = await boot(
      provisionerBase({
        provisioner: {
          up: "true",
          down: 'echo down >> "$OPS_DIR/prov.log"; exit 7',
        },
        seed: { command: "exit 1" },
      }),
    ).catch((e) => e as Error & { criticalTeardownFailures?: unknown[] });
    expect(error).toBeInstanceOf(ServicesError);
    expect(line("prov.log")).toEqual(["down"]);
    expect(
      (error as { criticalTeardownFailures?: unknown[] })
        .criticalTeardownFailures,
    ).toHaveLength(1);
  });

  it("runs down after a failed up, and after a failed export", async () => {
    await expect(
      boot({
        provisioner: {
          up: 'echo up >> "$OPS_DIR/prov.log"; exit 3',
          down: 'echo down >> "$OPS_DIR/prov.log"',
        },
      }),
    ).rejects.toThrow(/provisioner up failed \(exit 3\)/);
    expect(line("prov.log")).toEqual(["up", "down"]);
    rmSync(join(dir, "prov.log"));
    await expect(
      boot({
        provisioner: {
          up: 'echo up >> "$OPS_DIR/prov.log"',
          down: 'echo down >> "$OPS_DIR/prov.log"',
          exports: { TWO_LINES: "printf 'a\\nb\\n'" },
        },
      }),
    ).rejects.toThrow(/export TWO_LINES: the command printed 2 lines/);
    expect(line("prov.log")).toEqual(["up", "down"]);
  });

  it("a failed or cancelled up still gives the down its exports", async () => {
    await expect(boot(provisionerWithExport("exit 3"))).rejects.toThrow(
      /provisioner up failed \(exit 3\)/,
    );
    expect(line("prov.log")).toEqual(["down sbx-7"]);
    const controller = new AbortController();
    const cancelled = boot(provisionerWithExport("sleep 20"), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    await expect(cancelled).rejects.toThrow();
    expect(line("prov.log")).toEqual(["down sbx-7", "down sbx-7"]);
  });

  it("the signal path waits for a running up (SIGTERM forwarded), then downs with the exports", async () => {
    let terminate: (() => void) | undefined;
    const booting = boot(
      {
        provisioner: {
          // Exits on SIGTERM (after a moment), not before.
          up: `trap 'sleep 0.3; echo up-stopped >> "$OPS_DIR/prov.log"; exit 0' TERM; echo started > "$OPS_DIR/up.started"; sleep 30 & wait`,
          down: 'echo "down $SANDBOX_ID" >> "$OPS_DIR/prov.log"',
          exports: { SANDBOX_ID: "echo sbx-9" },
        },
      },
      {
        onSpawn: (terminateSync) => {
          terminate = terminateSync;
        },
      },
    ).catch((error: unknown) => error);
    await waitFor(() => existsSync(join(dir, "up.started")), 10_000, "up");
    terminate!();
    // The up stopped before the down ran, and the down saw the export.
    expect(line("prov.log")).toEqual(["up-stopped", "down sbx-9"]);
    await booting;
  });

  it("runs down on the signal path", async () => {
    const handle = await boot(provisionerBase());
    handle.terminateSync();
    expect(line("prov.log")).toEqual(["up", "down"]);
    // The async stop that follows does not run it twice.
    await handle.stop();
    expect(line("prov.log")).toEqual(["up", "down"]);
  });

  it("never reuses a tmux session of a provisioned environment", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.setOutput("ops", "web", "listening on 3000\n");
    await boot({ ...provisionerBase(), tmux: WEB });
    expect(fake.callsOf("kill-session").length).toBeGreaterThan(0);
    expect(fake.callsOf("new-session")).toHaveLength(1);
    expect(types()).not.toContain("tmux.reuse");
  });

  it("evaluates exports again for a reused environment", async () => {
    const parsed = ServicesConfigSchema.parse(provisionerBase());
    expect(await evaluateProvisionerExports(parsed, ctxFor())).toEqual({
      REMOTE_HOST: "10.1.2.3",
      REMOTE_API_TOKEN: "opaque-value-1",
    });
    expect(line("prov.log")).toEqual([]);
  });
});

describe("services.files", () => {
  it("writes before the seed, records fingerprints, and restarts only already-live windows", async () => {
    fake.seedRunning("ops", ["web"]);
    fake.setPane("ops", "web", "listening on 3000\n");
    fake.setOutput("ops", "web", "listening on 3000\n");
    const cfg: ServicesConfig = {
      files: [{ path: "app.json", json: { port: 3000 }, restart: ["web"] }],
      tmux: WEB,
    };
    await boot(cfg);
    const written = events.find(
      (e) => e.phase === "files" && e.event === "write",
    );
    expect(written?.data).toMatchObject({
      path: "app.json",
      changed: true,
      existed: false,
    });
    expect(String(written?.data?.after)).toMatch(/^hmac-sha256:/);
    expect(JSON.parse(readFileSync(join(dir, "app.json"), "utf8"))).toEqual({
      port: 3000,
    });
    // The window was live in a reused session: the change restarted it.
    expect(types()).toContain("restart.ready");
    expect(fake.sent("ops", "web")).toEqual(["run-web"]);
    // Unchanged on the second boot: no write, no restart.
    events.length = 0;
    await boot(cfg);
    expect(types()).toContain("files.unchanged");
    expect(types()).not.toContain("restart.start");
  }, 30_000);

  it("does not restart a window the same boot launched", async () => {
    fake.setOutput("ops", "web", "listening on 3000\n");
    await boot({
      files: [{ path: "app.json", json: { port: 1 }, restart: ["web"] }],
      tmux: WEB,
    });
    expect(types()).not.toContain("restart.start");
    expect(fake.sent("ops", "web")).toHaveLength(1);
  });

  it("fails the boot (and says which file) on a file it cannot merge", async () => {
    writeFileSync(join(dir, "bad.json"), "not json");
    await expect(
      boot({ files: [{ path: "bad.json", json: { a: 1 } }] }),
    ).rejects.toThrow(
      /services.files bad.json: the existing file is not valid JSON/,
    );
    expect(types()).toContain("files.fail");
    expect(readFileSync(join(dir, "bad.json"), "utf8")).toBe("not json");
  });

  it("substitutes env exported by the provisioner", async () => {
    await boot({
      provisioner: {
        up: "true",
        down: "true",
        exports: { REMOTE_HOST: "echo 10.9.8.7" },
      },
      files: [{ path: "env.txt", text: "host=${exports.REMOTE_HOST}\n" }],
    });
    expect(readFileSync(join(dir, "env.txt"), "utf8")).toBe("host=10.9.8.7\n");
  });
});

describe("seed transaction", () => {
  it("persists each phase and repeats only what changed, expired or is always", async () => {
    await boot(phasedSeed([seedPhase("a"), seedPhase("b")]));
    expect(line("seed.log")).toEqual(["a", "b"]);
    await boot(phasedSeed([seedPhase("a"), seedPhase("b")]));
    expect(line("seed.log")).toEqual(["a", "b"]);
    expect(types().filter((t) => t === "seed.phase.skip")).toHaveLength(2);
    // b's command changed: only b runs; c is new; always repeats.
    await boot(
      phasedSeed([
        seedPhase("a"),
        { name: "b", run: 'echo b2 >> "$OPS_DIR/seed.log"' },
        seedPhase("c"),
        seedPhase("d", { always: true }),
      ]),
    );
    expect(line("seed.log")).toEqual(["a", "b", "b2", "c", "d"]);
    await boot(
      phasedSeed([
        seedPhase("a"),
        { name: "b", run: 'echo b2 >> "$OPS_DIR/seed.log"' },
        seedPhase("c"),
        seedPhase("d", { always: true }),
      ]),
    );
    expect(line("seed.log")).toEqual(["a", "b", "b2", "c", "d", "d"]);
  });

  it("keeps state per environment and per target", async () => {
    const cfg = (target?: string): ServicesConfig =>
      ({
        seed: {
          phases: [seedPhase("a")],
          ttlSeconds: 600,
          ...(target ? { target } : {}),
        },
      }) as ServicesConfig;
    await boot(cfg("db-one"));
    await boot(cfg("db-one"));
    expect(line("seed.log")).toEqual(["a"]);
    await boot(cfg("db-two"));
    expect(line("seed.log")).toEqual(["a", "a"]);
    await boot(cfg("db-one"), { envName: "staging" });
    expect(line("seed.log")).toEqual(["a", "a", "a"]);
  });

  it("skipIf: a passing probe skips, a failing one runs", async () => {
    await boot({
      seed: {
        phases: [
          seedPhase("a", { skipIf: { command: "true" } }),
          seedPhase("b", { skipIf: "false" }),
        ],
      },
    } as ServicesConfig);
    expect(line("seed.log")).toEqual(["b"]);
    expect(events.find((e) => e.event === "phase.skip")?.data).toMatchObject({
      phase: "a",
      reason: "skipIf passed",
    });
  });

  it("records a failed phase at once and resumes after the last success", async () => {
    const seed = (second: string): ServicesConfig =>
      ({
        seed: {
          phases: [seedPhase("a"), { name: "b", run: second }],
          ttlSeconds: 600,
        },
      }) as ServicesConfig;
    await expect(
      boot(seed('echo b-bad >> "$OPS_DIR/seed.log"; exit 4')),
    ).rejects.toThrow(/seed phase b failed \(exit 4\)/);
    expect(line("seed.log")).toEqual(["a", "b-bad"]);
    expect(types()).toContain("seed.phase.fail");
    await boot(seed('echo b-good >> "$OPS_DIR/seed.log"'));
    expect(line("seed.log")).toEqual(["a", "b-bad", "b-good"]);
  });

  it("without a TTL a failed run is resumed after its last success, then the next run starts over", async () => {
    const seed = (second: string): ServicesConfig =>
      ({
        seed: {
          phases: [seedPhase("a"), { name: "b", run: second }, seedPhase("c")],
        },
      }) as ServicesConfig;
    await expect(
      boot(seed('echo b-bad >> "$OPS_DIR/seed.log"; exit 4')),
    ).rejects.toThrow(/seed phase b failed/);
    expect(line("seed.log")).toEqual(["a", "b-bad"]);
    // a is resumed (skipped), b (changed, failed) runs, c runs.
    await boot(seed('echo b-good >> "$OPS_DIR/seed.log"'));
    expect(line("seed.log")).toEqual(["a", "b-bad", "b-good", "c"]);
    expect(events.find((e) => e.event === "phase.skip")?.data?.reason).toMatch(
      /resumed after a failed run/,
    );
    // The transaction completed: nothing to resume, everything runs again.
    await boot(seed('echo b-good >> "$OPS_DIR/seed.log"'));
    expect(line("seed.log")).toEqual([
      "a",
      "b-bad",
      "b-good",
      "c",
      "a",
      "b-good",
      "c",
    ]);
  });

  const failingB = (extra: object = {}): ServicesConfig =>
    ({
      seed: {
        phases: [
          seedPhase("a", extra),
          { name: "b", run: 'echo b-bad >> "$OPS_DIR/seed.log"; exit 4' },
        ],
      },
    }) as ServicesConfig;
  const seedStateFile = (): string => {
    const files = readdirSync(join(dir, "state")).filter((name) =>
      name.endsWith(".seed-state.json"),
    );
    expect(files).toHaveLength(1);
    return join(dir, "state", files[0]!);
  };

  it("a resumed phase with a skipIf runs again when its result is gone", async () => {
    const withProbe = failingB({
      run: 'echo a >> "$OPS_DIR/seed.log"; touch "$OPS_DIR/db"',
      skipIf: 'test -f "$OPS_DIR/db"',
    });
    await expect(boot(withProbe)).rejects.toThrow(/seed phase b failed/);
    // The data a made is gone (a wiped database), the resume still names a.
    rmSync(join(dir, "db"));
    await expect(boot(withProbe)).rejects.toThrow(/seed phase b failed/);
    expect(line("seed.log")).toEqual(["a", "b-bad", "a", "b-bad"]);
    // a ran and its result is there: a third run resumes after it.
    await expect(boot(withProbe)).rejects.toThrow(/seed phase b failed/);
    expect(line("seed.log")).toEqual(["a", "b-bad", "a", "b-bad", "b-bad"]);
    expect(
      events.filter((e) => e.event === "phase.skip").at(-1)?.data?.reason,
    ).toMatch(/resumed after a failed run .*; skipIf passed/);
  });

  it("a phase only carried by a resume is not resumed twice: a stuck seed recovers", async () => {
    await expect(boot(failingB())).rejects.toThrow(/seed phase b failed/);
    await expect(boot(failingB())).rejects.toThrow(/seed phase b failed/);
    await expect(boot(failingB())).rejects.toThrow(/seed phase b failed/);
    // run 1: a, b; run 2: a resumed, b; run 3: a again (not stuck), b.
    expect(line("seed.log")).toEqual(["a", "b-bad", "b-bad", "a", "b-bad"]);
  });

  it("a teardown (failure cleanup) drops the resume", async () => {
    const cfg = {
      ...failingB(),
      teardown: ['echo down >> "$OPS_DIR/teardown.log"'],
    } as ServicesConfig;
    await expect(boot(cfg)).rejects.toThrow(/seed phase b failed/);
    expect(line("teardown.log")).toEqual(["down"]);
    expect(JSON.parse(readFileSync(seedStateFile(), "utf8")).resume).toBe(
      undefined,
    );
    await expect(boot(cfg)).rejects.toThrow(/seed phase b failed/);
    expect(line("seed.log")).toEqual(["a", "b-bad", "a", "b-bad"]);
  });

  it("a resume older than the TTL is not used", async () => {
    const cfg = {
      seed: { ...failingB().seed, ttlSeconds: 600 },
    } as ServicesConfig;
    await expect(boot(cfg)).rejects.toThrow(/seed phase b failed/);
    const file = seedStateFile();
    const state = JSON.parse(readFileSync(file, "utf8"));
    const old = new Date(Date.now() - 3_600_000).toISOString();
    state.resume.at = old;
    state.phases.a.ranAt = old;
    writeFileSync(file, JSON.stringify(state));
    await expect(boot(cfg)).rejects.toThrow(/seed phase b failed/);
    expect(line("seed.log")).toEqual(["a", "b-bad", "a", "b-bad"]);
  });

  it("services down drops the resume", async () => {
    await expect(boot(failingB())).rejects.toThrow(/seed phase b failed/);
    expect(JSON.parse(readFileSync(seedStateFile(), "utf8")).resume).toEqual(
      expect.objectContaining({ done: expect.any(Object) }),
    );
    await teardownServices(ServicesConfigSchema.parse(failingB()), ctxFor());
    expect(JSON.parse(readFileSync(seedStateFile(), "utf8")).resume).toBe(
      undefined,
    );
  });

  it("commit: afterPostCommands stamps freshness only after every post-command succeeded", async () => {
    await expect(boot(committedSeed("exit 1"))).rejects.toThrow(
      /seed postCommand failed/,
    );
    // Not committed: the next run seeds again.
    await boot(committedSeed("true"));
    expect(line("seed.log")).toEqual(["seed", "seed"]);
    expect(
      events.filter((e) => e.event === "commit").map((e) => e.data?.committed),
    ).toEqual([true]);
    // Committed now: the seed is fresh and skipped.
    await boot(committedSeed("true"));
    expect(line("seed.log")).toEqual(["seed", "seed"]);
  });

  it("by default (afterCommand) a failed post-command still leaves the seed stamped fresh", async () => {
    // Legacy state lives under the real HOME (hermetic in tests).
    await expect(
      boot(seedWithPost("exit 1"), { project: `legacy-${process.pid}` }),
    ).rejects.toThrow();
    await boot(seedWithPost("true"), { project: `legacy-${process.pid}` });
    expect(line("seed.log")).toEqual(["seed"]);
  });

  it("post-command objects: when, continueOnError (aggregated), timeout, name", async () => {
    await boot(
      seedPostCommands([
        {
          name: "only-smoke",
          run: 'echo smoke >> "$OPS_DIR/post.log"',
          when: { suite: "smoke" },
        },
        {
          name: "only-staging",
          run: 'echo staging >> "$OPS_DIR/post.log"',
          when: { env: "staging" },
        },
        { name: "tolerated", run: "exit 2", continueOnError: true },
        { name: "always-here", run: 'echo here >> "$OPS_DIR/post.log"' },
        'echo plain >> "$OPS_DIR/post.log"',
      ]),
      { suite: "smoke" },
    );
    expect(line("post.log")).toEqual(["smoke", "here", "plain"]);
    expect(
      events
        .filter((e) => e.event === "postcommand.skip")
        .map((e) => e.data?.postCommand),
    ).toEqual(["only-staging"]);
    await expect(
      boot(
        seedPostCommands([
          { name: "first", run: "exit 2", continueOnError: true },
          {
            name: "second",
            run: "echo bad-output; exit 0",
            expectOutput: { notMatches: ["bad-output"] },
          },
        ]),
      ),
    ).rejects.toThrow(
      /earlier postCommand first failed too \(exit 2; continueOnError\)[\s\S]*postCommand second failed/,
    );
    await expect(
      boot(
        seedPostCommands([{ name: "slow", run: "sleep 5", timeout: "300ms" }]),
      ),
    ).rejects.toThrow(/postCommand slow failed/);
  }, 30_000);

  it("a tolerated post-command's output-check reason never carries a secret", async () => {
    const secret = ["sk", "live", String(process.pid), "x9"].join("-");
    const logs: string[] = [];
    const error = await boot(
      {
        seed: {
          command: "true",
          postCommands: [
            {
              name: "leaky",
              run: 'echo "token rejected: $OPS_API_TOKEN"; exit 0',
              continueOnError: true,
              expectOutput: { notMatches: ["token rejected"] },
            },
            { name: "fatal", run: "exit 3" },
          ],
        },
      } as ServicesConfig,
      {
        env: {
          ...process.env,
          OPS_DIR: dir,
          OPS_API_TOKEN: secret,
        } as NodeJS.ProcessEnv,
        secretValues: [secret],
        log: (m) => logs.push(m),
      },
    ).catch((e: unknown) => e as Error);
    expect((error as Error).message).toMatch(
      /earlier postCommand leaky failed too \(output matches the forbidden pattern/,
    );
    expect((error as Error).message).not.toContain(secret);
    expect(logs.join("\n")).toMatch(/postCommand leaky failed/);
    expect(logs.join("\n")).not.toContain(secret);
  });

  it("fails a seed that prints a forbidden pattern but exits 0, and re-seeds next time", async () => {
    const seed: ServicesConfig = {
      seed: {
        command:
          'echo "COLLECTION ERROR: users"; echo ran >> "$OPS_DIR/seed.log"',
        ttlSeconds: 600,
        target: "expect-output",
        expectOutput: { notMatches: ["COLLECTION ERROR"] },
      },
    } as ServicesConfig;
    await expect(boot(seed)).rejects.toThrow(
      /seed command exited 0 but its output matches the forbidden pattern/,
    );
    await expect(boot(seed)).rejects.toThrow();
    expect(line("seed.log")).toEqual(["ran", "ran"]);
  });

  it("applies a phase-level and a seed-level expectOutput", async () => {
    await expect(
      boot({
        seed: {
          phases: [
            seedPhase("noisy", {
              run: "echo FATAL oops",
              expectOutput: { notMatches: ["FATAL"] },
            }),
          ],
        },
      } as ServicesConfig),
    ).rejects.toThrow(/seed phase noisy exited 0 but its output matches/);
  });
});
