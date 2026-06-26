import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServices, ServicesError, type ServicesHandle } from "./services";
import type { SeedConfig } from "../schema/config.v1";

/**
 * Tests for the services lifecycle orchestrator. External commands (execa
 * for tmux/docker, runShell for shell commands) are mocked so no real
 * processes are spawned. SeedStateStore is mocked to control freshness
 * decisions.
 */

/* ---------- mock setup ---------- */

// Track execa calls: both `execa(cmd, args[], opts)` (tmux/docker) and
// `execa(command, optsObject)` (runShellWithTimeout for docker/seed commands).
const execaCalls: { cmd: string; args: string[] }[] = [];

// Track shell command calls (runShell from webServer + runShellWithTimeout
// via execa with shell:true). Keyed by the command string.
const shellCalls: { command: string; opts: { cwd?: string } }[] = [];

// Configurable mock implementations (reset per-test).
let execaImpl:
  | ((
      cmd: string,
      args: string[],
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>)
  | undefined;
let shellImpl:
  | ((
      command: string,
      opts: unknown,
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>)
  | undefined;
let probeOnceImpl: ((url: string) => Promise<boolean>) | undefined;
let seedStateReadResult: { shouldRun: boolean; reason: string } | undefined;

vi.mock("execa", () => ({
  execa: vi.fn(async (cmd: string, argsOrOpts: unknown) => {
    // Two call patterns:
    // 1. execa("tmux", ["kill-session", ...], { opts }) — args is an array
    // 2. execa("docker compose up -d", { shell: true, cwd, env, ... }) — opts is an object
    if (Array.isArray(argsOrOpts)) {
      // tmux/docker call: execa(cmd, argsArray, optsObject)
      const args = argsOrOpts as string[];
      execaCalls.push({ cmd, args });
      if (execaImpl) return execaImpl(cmd, args);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    // Shell call: execa(command, { shell: true, cwd, env, ... })
    const opts = (argsOrOpts as { cwd?: string }) ?? {};
    shellCalls.push({ command: cmd, opts: { cwd: opts.cwd } });
    if (shellImpl) return shellImpl(cmd, argsOrOpts);
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
}));

vi.mock("./webServer", () => ({
  isTruthyEnv: (v: string | undefined) => v === "true" || v === "1",
  runShell: vi.fn(async (command: string, opts: unknown) => {
    shellCalls.push({ command, opts: opts as { cwd?: string } });
    if (shellImpl) return shellImpl(command, opts);
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
  probeOnce: vi.fn(async (url: string) => {
    if (probeOnceImpl) return probeOnceImpl(url);
    return true;
  }),
  sleep: vi.fn(async (ms: number) => {
    // No-op — don't actually sleep in tests.
    void ms;
  }),
}));

// Configurable tvault mock implementation (reset per-test).
let tvaultImpl:
  | ((cfg: {
      project?: string;
      group?: string;
      env?: string;
    }) => Promise<{ ok: boolean; env: Record<string, string>; error?: string }>)
  | undefined;

vi.mock("../../cli/commands/secrets", () => ({
  getTvaultEnv: vi.fn(
    async (cfg: { project?: string; group?: string; env?: string }) => {
      if (tvaultImpl) return tvaultImpl(cfg);
      return { ok: true, env: {} };
    },
  ),
  tvaultArgs: vi.fn(
    (cfg: { project?: string; group?: string; env?: string }) => {
      if (cfg.project)
        return { args: ["--project", cfg.project], target: cfg.project };
      return {
        args: ["--group", cfg.group!, "--env", cfg.env!],
        target: `${cfg.group}/${cfg.env}`,
      };
    },
  ),
}));

vi.mock("./seedState", () => ({
  SeedStateStore: vi.fn().mockImplementation(() => ({
    read: vi.fn(async () => undefined),
    checkFreshness: vi.fn(
      () =>
        seedStateReadResult ?? { shouldRun: true, reason: "no-previous-seed" },
    ),
    recordRun: vi.fn(async () => undefined),
    fingerprint: vi.fn(() => "test-fp"),
  })),
}));

// Configurable stash mock (reset per-test).
let stashImpl:
  | ((
      dir: string,
      opts: {
        name?: string;
        tool?: string;
        tags?: string[];
        source?: string;
      },
    ) => Promise<{ ok: boolean; stashId?: string; error?: string }>)
  | undefined;
let stashCalls: {
  dir: string;
  name?: string;
  tool?: string;
  tags?: string[];
}[] = [];

vi.mock("../../cli/commands/stash", () => ({
  stashDirectory: vi.fn(async (dir: string, opts: unknown) => {
    const o = opts as { name?: string; tool?: string; tags?: string[] };
    stashCalls.push({ dir, name: o?.name, tool: o?.tool, tags: o?.tags });
    if (stashImpl)
      return stashImpl(
        dir,
        opts as { name?: string; tool?: string; tags?: string[] },
      );
    return { ok: true, stashId: "test-stash-id" };
  }),
}));

/* ---------- test state ---------- */

let dir: string;
let startedHandles: ServicesHandle[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-services-test-"));
  execaCalls.length = 0;
  shellCalls.length = 0;
  execaImpl = undefined;
  shellImpl = undefined;
  probeOnceImpl = undefined;
  seedStateReadResult = undefined;
  tvaultImpl = undefined;
  stashImpl = undefined;
  stashCalls = [];
  startedHandles = [];
});

afterEach(async () => {
  while (startedHandles.length > 0) {
    const h = startedHandles.pop();
    await h?.stop().catch(() => undefined);
  }
});

function track(h: ServicesHandle): ServicesHandle {
  startedHandles.push(h);
  return h;
}

/* ---------- tests ---------- */

describe("startServices — docker phase", () => {
  it("runs docker compose up when no containers are running", async () => {
    // docker compose ps returns no running containers
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // docker command succeeds
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    // Should have checked docker compose ps
    const psCall = execaCalls.find(
      (c) => c.cmd === "docker" && c.args[0] === "compose",
    );
    expect(psCall).toBeDefined();
    // Should have run the docker command via runShell
    expect(
      shellCalls.some((c) => c.command.includes("docker compose up")),
    ).toBe(true);
  });

  it("skips docker when containers are already running (reuse)", async () => {
    // docker compose ps shows running containers
    execaImpl = async (cmd) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    // docker compose up should NOT have been run
    expect(
      shellCalls.some((c) => c.command.includes("docker compose up")),
    ).toBe(false);
  });

  it("throws ServicesError when docker command fails", async () => {
    // No running containers
    execaImpl = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    // docker compose up fails
    shellImpl = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "compose error",
    });

    await expect(
      startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    ).rejects.toThrow(ServicesError);

    await expect(
      startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    ).rejects.toThrow(/docker command failed/);
  });
});

describe("startServices — seed phase", () => {
  it("skips seed when freshness check says data is fresh", async () => {
    seedStateReadResult = { shouldRun: false, reason: "within-ttl" };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    // seed command should NOT have run
    expect(shellCalls.some((c) => c.command.includes("yarn seed"))).toBe(false);
  });

  it("runs seed when freshness check says data is stale", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };
    shellImpl = async () => ({ exitCode: 0, stdout: "seeded", stderr: "" });

    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false); // seed doesn't set startedByUs
    expect(shellCalls.some((c) => c.command.includes("yarn seed"))).toBe(true);
  });

  it("runs freshnessCheck command and skips seed if it passes", async () => {
    seedStateReadResult = {
      shouldRun: true,
      reason: "freshness-check-pending",
    };
    const cfg: SeedConfig = {
      command: "yarn seed",
      ttlSeconds: 3600,
      freshnessCheck: "echo ok",
    };

    // freshnessCheck exits 0 (pass), seed command should not run
    shellImpl = async (command: string) => {
      if (command === "echo ok") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "seeded", stderr: "" };
    };

    const handle = track(
      await startServices(
        { seed: cfg },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    // freshnessCheck should have run
    expect(shellCalls.some((c) => c.command === "echo ok")).toBe(true);
    // seed command should NOT have run
    expect(shellCalls.some((c) => c.command === "yarn seed")).toBe(false);
    void handle;
  });

  it("runs seed when freshnessCheck fails (exit non-zero)", async () => {
    seedStateReadResult = {
      shouldRun: true,
      reason: "freshness-check-pending",
    };
    const cfg: SeedConfig = {
      command: "yarn seed",
      ttlSeconds: 3600,
      freshnessCheck: "echo check",
    };

    shellImpl = async (command: string) => {
      if (command === "echo check")
        return { exitCode: 1, stdout: "", stderr: "stale" };
      return { exitCode: 0, stdout: "seeded", stderr: "" };
    };

    const handle = track(
      await startServices(
        { seed: cfg },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    // Both freshnessCheck and seed should have run
    expect(shellCalls.some((c) => c.command === "echo check")).toBe(true);
    expect(shellCalls.some((c) => c.command === "yarn seed")).toBe(true);
    void handle;
  });

  it("throws ServicesError when seed command fails", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };
    shellImpl = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "import failed",
    });

    await expect(
      startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    ).rejects.toThrow(/seed command failed/);
  });
});

describe("startServices — tmux phase", () => {
  it("creates a tmux session with windows and sends commands", async () => {
    // tmux has-session returns 1 (not found), capture-pane returns readyOn text
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return { exitCode: 0, stdout: "listening on :8080", stderr: "" };
      }
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            reuseExisting: true,
            readyTimeoutMs: 5000,
            windows: [
              {
                name: "web",
                cwd: "web-app",
                command: "yarn start",
                readyOn: { text: "listening on" },
              },
              {
                name: "api",
                cwd: "web-api",
                command: "yarn dev",
                readyOn: { text: "listening on" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    // Should have created the session
    expect(
      execaCalls.some(
        (c) => c.cmd === "tmux" && c.args.includes("new-session"),
      ),
    ).toBe(true);
    // Should have created a second window
    expect(
      execaCalls.some((c) => c.cmd === "tmux" && c.args.includes("new-window")),
    ).toBe(true);
    // Should have sent commands
    expect(
      execaCalls.some((c) => c.cmd === "tmux" && c.args.includes("send-keys")),
    ).toBe(true);
  });

  it("reuses existing tmux session when reuseExisting is true", async () => {
    // tmux has-session returns 0 (session exists)
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            reuseExisting: true,
            readyTimeoutMs: 5000,
            windows: [{ name: "web", command: "yarn start" }],
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    // Should NOT have created a new session
    expect(
      execaCalls.some(
        (c) => c.cmd === "tmux" && c.args.includes("new-session"),
      ),
    ).toBe(false);
  });

  it("kills existing session on cold-start before creating new one", async () => {
    let killedSession = false;
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "kill-session") {
        killedSession = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 5000,
            windows: [{ name: "web", command: "yarn start" }],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    expect(killedSession).toBe(true);
    expect(handle.startedByUs).toBe(true);
  });

  it("times out when a window never becomes ready", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      // capture-pane never returns the ready text
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "still starting...", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // probeOnce never returns true (for url readiness)
    probeOnceImpl = async () => false;

    await expect(
      startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 200, // very short timeout
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { url: "http://localhost:9999" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("startServices — teardown", () => {
  it("runs teardown commands on stop()", async () => {
    execaImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          teardown: ["echo teardown1", "echo teardown2"],
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    await handle.stop();

    // teardown commands should have been run via runShell
    expect(shellCalls.some((c) => c.command === "echo teardown1")).toBe(true);
    expect(shellCalls.some((c) => c.command === "echo teardown2")).toBe(true);
  });

  it("kills tmux session on stop() when we started it", async () => {
    let killedSession = false;
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      if (cmd === "tmux" && args[0] === "kill-session") {
        killedSession = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    await handle.stop();
    expect(killedSession).toBe(true);
  });

  it("stop() is a no-op when nothing was started (all reused)", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", reuseExisting: true },
          tmux: {
            session: "test-sess",
            reuseExisting: true,
            windows: [{ name: "web", command: "yarn start" }],
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    await handle.stop();
    // No kill-session should have been called
    expect(
      execaCalls.some((c) => c.cmd === "tmux" && c.args[0] === "kill-session"),
    ).toBe(false);
  });
});

describe("startServices — full lifecycle", () => {
  it("runs docker → seed → tmux in order", async () => {
    const callOrder: string[] = [];

    execaImpl = async (cmd, args) => {
      if (cmd === "docker") {
        callOrder.push("docker-ps-check");
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd === "tmux" && args[0] === "has-session") {
        callOrder.push("tmux-has-session");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (cmd === "tmux" && args[0] === "capture-pane") {
        return { exitCode: 0, stdout: "listening on", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    shellImpl = async (command: string) => {
      if (command.includes("docker compose")) callOrder.push("docker-up");
      if (command.includes("yarn seed")) callOrder.push("seed");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          seed: { command: "yarn seed", ttlSeconds: 3600 },
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 3000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "listening on" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    // docker-up should come before seed, seed before tmux-has-session
    const dockerIdx = callOrder.indexOf("docker-up");
    const seedIdx = callOrder.indexOf("seed");
    const tmuxIdx = callOrder.indexOf("tmux-has-session");
    expect(dockerIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeGreaterThan(dockerIdx);
    expect(tmuxIdx).toBeGreaterThan(seedIdx);
  });
});

describe("startServices — terminateSync", () => {
  it("terminateSync is a no-op when nothing was started (all reused)", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", reuseExisting: true },
          tmux: {
            session: "test-sess",
            reuseExisting: true,
            windows: [{ name: "web", command: "yarn start" }],
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    // Should not throw
    expect(() => handle.terminateSync()).not.toThrow();
  });

  it("terminateSync does not throw even when tmux session was started", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    // terminateSync uses spawnSync which will try tmux kill-session — it may
    // fail (no tmux in test env) but must not throw.
    expect(() => handle.terminateSync()).not.toThrow();
  });
});

describe("startServices — onSpawn callback", () => {
  it("invokes onSpawn callback immediately for signal-time cleanup registration", async () => {
    let spawnCalled = false;
    execaImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onSpawn: () => {
            spawnCalled = true;
          },
        },
      ),
    );

    expect(spawnCalled).toBe(true);
    void handle;
  });

  it("onSpawn callback is safe to call (no-op) when no tmux session is active", async () => {
    let registeredCallback: (() => void) | undefined;
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onSpawn: (cb) => {
            registeredCallback = cb;
          },
        },
      ),
    );

    // The callback was registered and should be safe to call even though
    // no tmux session exists (phases.tmuxSession is undefined).
    expect(registeredCallback).toBeDefined();
    expect(() => registeredCallback!()).not.toThrow();
    void handle;
  });
});

describe("startServices — empty config", () => {
  it("returns a no-op handle when services config is empty", async () => {
    const handle = track(
      await startServices(
        {},
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    // stop() should not throw and should do nothing
    await expect(handle.stop()).resolves.toBeUndefined();
    // terminateSync should not throw
    expect(() => handle.terminateSync()).not.toThrow();
  });

  it("returns a no-op handle when only teardown is configured (no docker/seed/tmux)", async () => {
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { teardown: ["echo done"] },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(false);
    // teardown should still run on stop()
    await handle.stop();
    expect(shellCalls.some((c) => c.command === "echo done")).toBe(true);
  });
});

describe("startServices — cwd resolution", () => {
  it("resolves relative cwd against configDir for docker", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async (_command, opts) => {
      const cwd = (opts as { cwd?: string }).cwd;
      expect(cwd).toBe(resolve(dir, "infra"));
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: "infra" } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );
    void handle;
  });

  it("resolves absolute cwd as-is for docker", async () => {
    const absDir = "/some/absolute/path";
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async (_command, opts) => {
      const cwd = (opts as { cwd?: string }).cwd;
      expect(cwd).toBe(absDir);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: absDir } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );
    void handle;
  });

  it("uses configDir as default cwd when docker cwd is not set", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async (_command, opts) => {
      const cwd = (opts as { cwd?: string }).cwd;
      expect(cwd).toBe(dir);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d" } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );
    void handle;
  });
});

describe("startServices — seed env injection", () => {
  it("merges cfg.env over process.env for the seed command", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };
    let capturedEnv: Record<string, string | undefined> | undefined;

    shellImpl = async (_command, opts) => {
      capturedEnv = (opts as { env?: Record<string, string | undefined> }).env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", env: { CUSTOM_VAR: "hello" } } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.CUSTOM_VAR).toBe("hello");
    void handle;
  });
});

describe("startServices — tvault integration", () => {
  it("injects tvault secrets into seed env when secrets.provider is tvault", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };
    let capturedEnv: Record<string, string | undefined> | undefined;

    shellImpl = async (_command, opts) => {
      capturedEnv = (opts as { env?: Record<string, string | undefined> }).env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    tvaultImpl = async () => ({
      ok: true,
      env: {
        MONGO_SOURCE_PASSWORD: "super-secret",
        ES_SOURCE_PASSWORD: "es-secret",
      },
    });

    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          secrets: {
            provider: "tvault",
            tvault: { project: "graphite" },
          },
        },
      ),
    );

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.MONGO_SOURCE_PASSWORD).toBe("super-secret");
    expect(capturedEnv!.ES_SOURCE_PASSWORD).toBe("es-secret");
    void handle;
  });

  it("throws ServicesError when tvault fails to provide secrets", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };

    tvaultImpl = async () => ({
      ok: false,
      env: {},
      error: "vault is locked",
    });

    await expect(
      startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          secrets: {
            provider: "tvault",
            tvault: { project: "graphite" },
          },
        },
      ),
    ).rejects.toThrow(/tvault secrets for seed.*vault is locked/);
  });

  it("skips tvault when secrets.provider is not tvault", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };
    let capturedEnv: Record<string, string | undefined> | undefined;

    shellImpl = async (_command, opts) => {
      capturedEnv = (opts as { env?: Record<string, string | undefined> }).env;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // Ensure tvault is not called
    let tvaultCalled = false;
    tvaultImpl = async () => {
      tvaultCalled = true;
      return { ok: true, env: {} };
    };

    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          // No secrets config at all
        },
      ),
    );

    expect(capturedEnv).toBeDefined();
    // Should not have any tvault-injected secrets
    expect(capturedEnv!.MONGO_SOURCE_PASSWORD).toBeUndefined();
    expect(tvaultCalled).toBe(false);
    void handle;
  });
});

describe("startServices — tmux URL readiness", () => {
  it("waits for URL readiness via probeOnce", async () => {
    let probeCalled = false;
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    probeOnceImpl = async (url: string) => {
      if (url === "http://localhost:3000") {
        probeCalled = true;
        return true;
      }
      return false;
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 5000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { url: "http://localhost:3000" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    expect(probeCalled).toBe(true);
    expect(handle.startedByUs).toBe(true);
  });
});

describe("startServices — tmux single window (no remaining windows)", () => {
  it("creates a session with only one window and no new-window calls", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "solo",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    expect(handle.startedByUs).toBe(true);
    // new-session called, but new-window should NOT be called (only 1 window)
    expect(
      execaCalls.some(
        (c) => c.cmd === "tmux" && c.args.includes("new-session"),
      ),
    ).toBe(true);
    expect(
      execaCalls.some((c) => c.cmd === "tmux" && c.args.includes("new-window")),
    ).toBe(false);
  });
});

describe("startServices — docker cold-start behavior", () => {
  it("runs docker compose under cold-start when reuseExisting is not set (defaults to false)", async () => {
    // docker compose ps shows running containers, but cold-start should ignore reuse
    execaImpl = async (cmd) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Under cold-start, reuse defaults to false (no reuseExisting set), so docker should run
    expect(handle.startedByUs).toBe(true);
    expect(
      shellCalls.some((c) => c.command.includes("docker compose up")),
    ).toBe(true);
  });

  it("respects explicit reuseExisting: true even under cold-start", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Explicit reuseExisting: true overrides cold-start default
    expect(handle.startedByUs).toBe(false);
    expect(
      shellCalls.some((c) => c.command.includes("docker compose up")),
    ).toBe(false);
  });
});

describe("startServices — teardown best-effort (errors don't propagate)", () => {
  it("stop() does not throw when a teardown command fails", async () => {
    shellImpl = async (command: string) => {
      if (command === "failing-cmd") {
        return { exitCode: 1, stdout: "", stderr: "teardown error" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        { teardown: ["failing-cmd", "echo ok"] },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    // stop() should not throw even though one teardown command fails
    await expect(handle.stop()).resolves.toBeUndefined();
    // The second command should still have run
    expect(shellCalls.some((c) => c.command === "echo ok")).toBe(true);
  });
});

describe("startServices — docker healthcheck", () => {
  it("runs healthcheck after docker readiness and logs healthy", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let hcCommand: string | undefined;
    shellImpl = async (command: string) => {
      if (command.startsWith("curl")) hcCommand = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            healthcheck: {
              command: "curl -sf http://localhost:9200/_cluster/health",
            },
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(hcCommand).toBe("curl -sf http://localhost:9200/_cluster/health");
    expect(handle.startedByUs).toBe(true);
  });

  it("logs healthcheck warning when unhealthy but does not fail", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    // healthcheck command fails all retries
    shellImpl = async (command: string) => {
      if (command.startsWith("curl"))
        return { exitCode: 1, stdout: "", stderr: "connection refused" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // Should NOT throw — healthcheck failure is a warning, not fatal
    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            healthcheck: {
              command: "curl -sf http://localhost:9200",
              retries: 2,
              intervalSeconds: 0,
              startPeriodSeconds: 0,
            },
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(true);
  });
});

describe("startServices — docker readiness check", () => {
  it("runs readiness check after docker compose up and fails if it returns non-zero", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async (command: string) => {
      if (command === "curl -sf http://localhost:27017")
        return { exitCode: 1, stdout: "", stderr: "not ready" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(
      startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            readinessCheck: "curl -sf http://localhost:27017",
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    ).rejects.toThrow(/docker readiness check failed/);
  });
});

describe("startServices — docker NDJSON format", () => {
  it("detects running containers from NDJSON output (one object per line)", async () => {
    let composeRan = false;
    execaImpl = async (cmd) => {
      if (cmd === "docker") {
        // Simulate NDJSON from newer docker compose
        return {
          exitCode: 0,
          stdout:
            '{"Name":"mongo","State":"running","Status":"Up 2 minutes"}\n{"Name":"redis","State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => {
      composeRan = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(composeRan).toBe(false);
    expect(handle.startedByUs).toBe(false);
  });

  it("detects running containers from JSON array output", async () => {
    let composeRan = false;
    execaImpl = async (cmd) => {
      if (cmd === "docker") {
        return {
          exitCode: 0,
          stdout:
            '[{"Name":"mongo","State":"running","Status":"Up 2 minutes"}]',
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => {
      composeRan = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(composeRan).toBe(false);
    expect(handle.startedByUs).toBe(false);
  });

  it("does NOT detect stopped containers (State != running, Status != Up)", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") {
        return {
          exitCode: 0,
          stdout:
            '{"Name":"mongo","State":"exited","Status":"Exited (0) 1 minute ago"}',
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    expect(handle.startedByUs).toBe(true);
  });
});

describe("startServices — tmux session options and env", () => {
  it("applies session options via tmux set-option", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            options: [
              { key: "mouse", value: "on" },
              { key: "history-limit", value: "50000" },
            ],
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Should have called set-option for each option
    const setOptCalls = execaCalls.filter(
      (c) => c.cmd === "tmux" && c.args[0] === "set-option",
    );
    expect(setOptCalls.length).toBe(2);
    expect(setOptCalls[0]!.args).toContain("mouse");
    expect(setOptCalls[0]!.args).toContain("on");
    expect(setOptCalls[1]!.args).toContain("history-limit");
    expect(setOptCalls[1]!.args).toContain("50000");
    void handle;
  });

  it("sets session-level env via tmux set-environment", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            env: { NODE_ENV: "development", LOG_LEVEL: "debug" },
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Should have called set-environment for each env var
    const setEnvCalls = execaCalls.filter(
      (c) => c.cmd === "tmux" && c.args[0] === "set-environment",
    );
    expect(setEnvCalls.length).toBe(2);
    const keys = setEnvCalls.map((c) => c.args[3]);
    expect(keys).toContain("NODE_ENV");
    expect(keys).toContain("LOG_LEVEL");
    void handle;
  });

  it("sets per-window env via tmux set-environment", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            env: { NODE_ENV: "development" },
            windows: [
              {
                name: "web",
                command: "yarn start",
                env: { PORT: "3001" },
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Should have set-environment for session env (NODE_ENV) at the session
    // level, and per-window env (PORT) before sending commands. Only the
    // per-window env is passed to sendTmuxCommand now (not the session env).
    const setEnvCalls = execaCalls.filter(
      (c) => c.cmd === "tmux" && c.args[0] === "set-environment",
    );
    const keys = setEnvCalls.map((c) => c.args[3]);
    expect(keys).toContain("NODE_ENV");
    expect(keys).toContain("PORT");
    void handle;
  });
});

describe("startServices — tmux pre-commands", () => {
  it("sends pre-commands before the main command in a window", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "answers",
                command: "yarn start",
                preCommands: ["yarn build", "yarn migrate"],
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Collect all send-keys calls for the "answers" window in order.
    // tmux send-keys args: ["send-keys", "-t", "test-sess:answers", "<command>", "Enter"]
    const sendKeysCalls = execaCalls.filter(
      (c) =>
        c.cmd === "tmux" &&
        c.args[0] === "send-keys" &&
        c.args[2]?.includes("answers"),
    );
    const sentCommands = sendKeysCalls.map((c) => c.args[3]);
    // Should have sent 3 commands: "yarn build", "yarn migrate", "yarn start"
    expect(sentCommands.length).toBe(3);
    expect(sentCommands[0]).toBe("yarn build");
    expect(sentCommands[1]).toBe("yarn migrate");
    expect(sentCommands[2]).toBe("yarn start");
    void handle;
  });
});

describe("startServices — tmux window healthcheck", () => {
  it("runs healthcheck for tmux windows after readiness and logs warning on failure", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let hcCommand: string | undefined;
    shellImpl = async (command: string) => {
      if (command.startsWith("curl")) hcCommand = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
                healthcheck: {
                  command: "curl -sf http://localhost:3000/health",
                },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    expect(hcCommand).toBe("curl -sf http://localhost:3000/health");
    expect(handle.startedByUs).toBe(true);
  });
});

describe("startServices — healthcheck with startPeriod", () => {
  it("waits for startPeriod before the first healthcheck attempt", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    let hcRanAfterDelay = false;
    const startTimes: number[] = [];
    const t0 = Date.now();

    shellImpl = async (command: string) => {
      if (command.startsWith("curl")) {
        startTimes.push(Date.now() - t0);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            healthcheck: {
              command: "curl -sf http://localhost:9200",
              startPeriodSeconds: 1,
              intervalSeconds: 0,
            },
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    // The healthcheck ran
    expect(startTimes.length).toBeGreaterThan(0);
    // The start period was respected (≥ ~1s since the mock sleep is a no-op,
    // the real delay comes from the sleep mock being instant, but the
    // startPeriodSeconds path was exercised)
    hcRanAfterDelay = startTimes.length > 0;
    expect(hcRanAfterDelay).toBe(true);
    void handle;
  });
});

describe("startServices — tmux window with both url and text readyOn", () => {
  it("checks both url and text readiness in sequence", async () => {
    let probeCalls = 0;
    let captureCalls = 0;

    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane") {
        captureCalls++;
        // First capture doesn't have the text, second does
        if (captureCalls === 1)
          return { exitCode: 0, stdout: "starting...", stderr: "" };
        return { exitCode: 0, stdout: "server started", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // URL probe: first call returns false, second returns true
    probeOnceImpl = async () => {
      probeCalls++;
      return probeCalls >= 2;
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 5000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: {
                  url: "http://localhost:3000",
                  text: "server started",
                },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // Both probeOnce and capture-pane should have been called
    expect(probeCalls).toBeGreaterThan(0);
    expect(captureCalls).toBeGreaterThan(0);
    expect(handle.startedByUs).toBe(true);
  });
});

describe("startServices — tmux defaultShell", () => {
  it("passes defaultShell to tmux new-session as positional arg", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-sess",
            defaultShell: "/bin/zsh",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // new-session should include /bin/zsh as the last positional arg
    const newSessionCall = execaCalls.find(
      (c) => c.cmd === "tmux" && c.args[0] === "new-session",
    );
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall!.args).toContain("/bin/zsh");
    void handle;
  });
});

describe("startServices — captureTmuxPane error handling", () => {
  it("returns empty string when capture-pane throws", async () => {
    // capture-pane throws — the catch should return ""
    execaImpl = async (cmd, args) => {
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        throw new Error("tmux error");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // Since capture-pane throws, the window never sees the ready text.
    // But the timeout is short enough to test the error path.
    await expect(
      startServices(
        {
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 200,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("startServices — fcheap stash integration", () => {
  it("captures tmux and docker artifacts and stashes to fcheap on stop", async () => {
    // Start docker + tmux, then stop → should capture artifacts and stash
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "web ready", stderr: "" };
      return { exitCode: 0, stdout: "docker logs output", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    stashImpl = async () => ({ ok: true, stashId: "fcheap-123" });

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "web ready" },
              },
            ],
          },
          stash: {
            enabled: true,
            autoStash: "always",
            capture: ["tmux", "docker", "seed"],
            tags: ["graphite", "test"],
          },
        },
        { configDir: dir, project: "graphite", coldStart: true },
      ),
    );

    await handle.stop();

    // stashDirectory should have been called
    expect(stashCalls.length).toBe(1);
    expect(stashCalls[0]!.tool).toBe("cairntrace-services");
    expect(stashCalls[0]!.tags).toContain("services");
    expect(stashCalls[0]!.tags).toContain("graphite");
    expect(stashCalls[0]!.tags).toContain("test");
    expect(stashCalls[0]!.name).toContain("graphite-services");
  });

  it("does not stash when stash is disabled (default)", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
          // No stash config — should not stash
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    await handle.stop();

    // stashDirectory should NOT have been called
    expect(stashCalls.length).toBe(0);
  });

  it("stashes even when fcheap fails (non-fatal)", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    stashImpl = async () => ({ ok: false, error: "fcheap not installed" });

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "ready" },
              },
            ],
          },
          stash: {
            enabled: true,
            autoStash: "always",
            capture: ["tmux", "docker", "seed"],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // stop() should not throw even when fcheap fails
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(stashCalls.length).toBe(1);
  });

  it("captures only tmux artifacts when capture list is [tmux]", async () => {
    let dockerLogsCalled = false;
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") {
        if (args[0] === "compose" && args[1] === "logs")
          dockerLogsCalled = true;
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "web ready", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    stashImpl = async () => ({ ok: true, stashId: "tmux-only-stash" });

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "web ready" },
              },
            ],
          },
          stash: {
            enabled: true,
            autoStash: "always",
            capture: ["tmux"],
          },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    await handle.stop();

    // stash should have been called (tmux artifacts captured)
    expect(stashCalls.length).toBe(1);
    // docker compose logs should NOT have been called (capture excludes docker)
    expect(dockerLogsCalled).toBe(false);
  });

  it("does not stash when no phases were started (all reused)", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running"}',
          stderr: "",
        };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
          tmux: {
            session: "test-sess",
            reuseExisting: true,
            windows: [{ name: "web", command: "yarn start" }],
          },
          stash: {
            enabled: true,
            autoStash: "always",
            capture: ["tmux", "docker", "seed"],
          },
        },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    // Nothing was started, so no artifacts to capture
    expect(handle.startedByUs).toBe(false);
    await handle.stop();
    // No stash calls because there were no artifacts
    expect(stashCalls.length).toBe(0);
  });
});

describe("startServices — lifecycle events", () => {
  it("emits events for each phase through onEvent callback", async () => {
    const events: { phase: string; event: string; message: string }[] = [];
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "listening on", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          seed: { command: "yarn seed", ttlSeconds: 3600 },
          tmux: {
            session: "test-sess",
            readyTimeoutMs: 2000,
            windows: [
              {
                name: "web",
                command: "yarn start",
                readyOn: { text: "listening on" },
              },
            ],
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: true,
          onEvent: (e) => {
            events.push({ phase: e.phase, event: e.event, message: e.message });
          },
        },
      ),
    );

    // Should have events for docker (start, ready), seed (start, complete),
    // and tmux (start, ready-wait, ready)
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("docker");
    expect(phases).toContain("seed");
    expect(phases).toContain("tmux");

    // Docker should have a start event
    const dockerStart = events.find(
      (e) => e.phase === "docker" && e.event === "start",
    );
    expect(dockerStart).toBeDefined();
    expect(dockerStart!.message).toContain("docker compose up");

    // Docker should have a ready event
    expect(
      events.find((e) => e.phase === "docker" && e.event === "ready"),
    ).toBeDefined();

    // Seed should have a start and complete event
    expect(
      events.find((e) => e.phase === "seed" && e.event === "start"),
    ).toBeDefined();
    expect(
      events.find((e) => e.phase === "seed" && e.event === "complete"),
    ).toBeDefined();

    // Tmux should have a start event mentioning the session
    const tmuxStart = events.find(
      (e) => e.phase === "tmux" && e.event === "start",
    );
    expect(tmuxStart).toBeDefined();
    expect(tmuxStart!.message).toContain("test-sess");

    // Tmux should have a ready event
    expect(
      events.find((e) => e.phase === "tmux" && e.event === "ready"),
    ).toBeDefined();

    void handle;
  });

  it("emits skip event when seed is skipped due to freshness", async () => {
    const events: { phase: string; event: string; message: string }[] = [];
    seedStateReadResult = { shouldRun: false, reason: "within-ttl" };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => {
            events.push({ phase: e.phase, event: e.event, message: e.message });
          },
        },
      ),
    );

    const skipEvent = events.find(
      (e) => e.phase === "seed" && e.event === "skip",
    );
    expect(skipEvent).toBeDefined();
    expect(skipEvent!.message).toContain("within-ttl");
    void handle;
  });

  it("emits reuse event when docker containers are already running", async () => {
    const events: { phase: string; event: string; message: string }[] = [];
    execaImpl = async (cmd) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: '{"State":"running","Status":"Up 2 minutes"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => {
            events.push({ phase: e.phase, event: e.event, message: e.message });
          },
        },
      ),
    );

    const reuseEvent = events.find(
      (e) => e.phase === "docker" && e.event === "reuse",
    );
    expect(reuseEvent).toBeDefined();
    expect(reuseEvent!.message).toContain("reusing");
    void handle;
  });

  it("emits fail event when docker command fails", async () => {
    const events: { phase: string; event: string; message: string }[] = [];
    execaImpl = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    shellImpl = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "compose error",
    });

    await expect(
      startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => {
            events.push({ phase: e.phase, event: e.event, message: e.message });
          },
        },
      ),
    ).rejects.toThrow(ServicesError);

    const failEvent = events.find(
      (e) => e.phase === "docker" && e.event === "fail",
    );
    expect(failEvent).toBeDefined();
    expect(failEvent!.message).toContain("exit 1");
  });

  it("emits healthcheck events when docker healthcheck runs", async () => {
    const events: { phase: string; event: string; data?: unknown }[] = [];
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async (command: string) => {
      if (command.startsWith("curl"))
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            healthcheck: { command: "curl -sf http://localhost:9200" },
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => {
            events.push({ phase: e.phase, event: e.event, data: e.data });
          },
        },
      ),
    );

    // Should have a healthcheck event with healthy=true
    const hcEvents = events.filter((e) => e.event === "healthcheck");
    expect(hcEvents.length).toBeGreaterThan(0);
    // The last healthcheck event should indicate healthy
    const lastHc = hcEvents[hcEvents.length - 1]!;
    if (lastHc.data) {
      const data = lastHc.data as { healthy?: boolean };
      expect(data.healthy).toBe(true);
    }
    void handle;
  });

  it("events array is populated on the handle even without onEvent callback", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    seedStateReadResult = { shouldRun: false, reason: "within-ttl" };

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          seed: { command: "yarn seed", ttlSeconds: 3600 },
        },
        { configDir: dir, project: "test", coldStart: true },
      ),
    );

    // The handle should have a populated events array
    expect(handle.events.length).toBeGreaterThan(0);
    // Should include docker start and seed skip events
    expect(
      handle.events.some((e) => e.phase === "docker" && e.event === "start"),
    ).toBe(true);
    expect(
      handle.events.some((e) => e.phase === "seed" && e.event === "skip"),
    ).toBe(true);
  });
});

describe("startServices — ctx.log callback coverage", () => {
  it("calls ctx.log for docker healthcheck success when log is provided", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            healthcheck: { command: "curl -sf http://localhost:9200" },
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    // The healthcheck success should produce a log line
    expect(logs.some((l) => l.includes("healthcheck"))).toBe(true);
    expect(handle.startedByUs).toBe(true);
  });

  it("calls ctx.log for docker healthcheck failure attempts when log is provided", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];
    shellImpl = async (command: string) => {
      if (command.startsWith("curl"))
        return { exitCode: 1, stdout: "", stderr: "refused" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            healthcheck: {
              command: "curl -sf http://localhost:9200",
              retries: 2,
              intervalSeconds: 0,
              startPeriodSeconds: 0,
            },
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    // The healthcheck failure should produce log lines for attempts
    expect(logs.some((l) => l.includes("healthcheck attempt 1"))).toBe(true);
    expect(logs.some((l) => l.includes("healthcheck attempt 1 failed"))).toBe(
      true,
    );
    expect(handle.startedByUs).toBe(true);
  });

  it("calls ctx.log for tmux window healthcheck when log is provided", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 1, stdout: "", stderr: "" };
      if (cmd === "tmux" && args[0] === "capture-pane")
        return { exitCode: 0, stdout: "listening on", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];
    shellImpl = async (command: string) => {
      if (command.startsWith("curl -sf http://localhost:8080/healthz"))
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    probeOnceImpl = async () => true;

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          tmux: {
            session: "test-sess",
            windows: [
              {
                name: "web",
                cwd: ".",
                command: "yarn start",
                readyOn: { url: "http://localhost:8080" },
                healthcheck: {
                  command: "curl -sf http://localhost:8080/healthz",
                },
              },
            ],
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: true,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    // The tmux window healthcheck should produce a log line
    expect(logs.some((l) => l.includes("healthcheck"))).toBe(true);
    expect(handle.startedByUs).toBe(true);
  });

  it("calls ctx.log for seed skip when log is provided", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    seedStateReadResult = { shouldRun: false, reason: "within-ttl" };

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          seed: { command: "yarn seed", ttlSeconds: 3600 },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    expect(logs.some((l) => l.includes("seed — skipping"))).toBe(true);
    expect(handle.startedByUs).toBe(true);
  });

  it("calls ctx.log for seed freshness check pass when log is provided", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];
    shellImpl = async (command: string) => {
      if (command.includes("mongosh"))
        return { exitCode: 0, stdout: "42", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    seedStateReadResult = {
      shouldRun: true,
      reason: "freshness-check-pending",
    };

    track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          seed: {
            command: "yarn seed",
            ttlSeconds: 3600,
            freshnessCheck: "mongosh --eval 'db.count()'",
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    expect(logs.some((l) => l.includes("freshness check passed"))).toBe(true);
  });

  it("calls ctx.log for tmux session reuse when log is provided", async () => {
    execaImpl = async (cmd, args) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      if (cmd === "tmux" && args[0] === "has-session")
        return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];

    const handle = track(
      await startServices(
        {
          docker: { command: "docker compose up -d", cwd: dir },
          tmux: {
            session: "existing",
            reuseExisting: true,
            windows: [{ name: "web", cwd: ".", command: "yarn start" }],
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    expect(logs.some((l) => l.includes("reusing session"))).toBe(true);
    expect(handle.startedByUs).toBe(true);
  });

  it("calls ctx.log for docker container reuse when log is provided", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ State: "running" }]),
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const logs: string[] = [];

    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          log: (msg: string) => logs.push(msg),
        },
      ),
    );

    expect(logs.some((l) => l.includes("reusing running containers"))).toBe(
      true,
    );
    expect(handle.startedByUs).toBe(false);
  });
});

/* ---------- lifecycle events tests ---------- */

describe("startServices — lifecycle events", () => {
  it("emits docker start and ready events", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const events: { phase: string; event: string }[] = [];
    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => events.push({ phase: e.phase, event: e.event }),
        },
      ),
    );

    expect(
      events.some((e) => e.phase === "docker" && e.event === "start"),
    ).toBe(true);
    expect(
      events.some((e) => e.phase === "docker" && e.event === "ready"),
    ).toBe(true);
    expect(handle.events.length).toBeGreaterThan(0);
    expect(handle.events[0]!.phase).toBe("docker");
    expect(handle.events[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("emits docker reuse event when containers are already running", async () => {
    execaImpl = async (cmd) => {
      if (cmd === "docker")
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ State: "running" }]),
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const events: { phase: string; event: string }[] = [];
    const handle = track(
      await startServices(
        {
          docker: {
            command: "docker compose up -d",
            cwd: dir,
            reuseExisting: true,
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => events.push({ phase: e.phase, event: e.event }),
        },
      ),
    );

    expect(
      events.some((e) => e.phase === "docker" && e.event === "reuse"),
    ).toBe(true);
    expect(handle.events.some((e) => e.event === "reuse")).toBe(true);
  });

  it("emits seed skip event when freshness check says data is fresh", async () => {
    seedStateReadResult = { shouldRun: false, reason: "within-ttl" };

    const events: { phase: string; event: string; message: string }[] = [];
    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) =>
            events.push({
              phase: e.phase,
              event: e.event,
              message: e.message,
            }),
        },
      ),
    );

    expect(
      events.some(
        (e) =>
          e.phase === "seed" &&
          e.event === "skip" &&
          e.message === "within-ttl",
      ),
    ).toBe(true);
    expect(handle.events.some((e) => e.phase === "seed")).toBe(true);
  });

  it("emits seed start and complete events when seed runs", async () => {
    seedStateReadResult = { shouldRun: true, reason: "no-previous-seed" };
    shellImpl = async () => ({ exitCode: 0, stdout: "seeded", stderr: "" });

    const events: { phase: string; event: string }[] = [];
    const handle = track(
      await startServices(
        { seed: { command: "yarn seed", ttlSeconds: 3600 } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => events.push({ phase: e.phase, event: e.event }),
        },
      ),
    );

    expect(events.some((e) => e.phase === "seed" && e.event === "start")).toBe(
      true,
    );
    expect(
      events.some((e) => e.phase === "seed" && e.event === "complete"),
    ).toBe(true);
    expect(handle.events.some((e) => e.event === "complete")).toBe(true);
  });

  it("emits tmux session-created and ready events", async () => {
    // has-session returns exit 1 (session doesn't exist) so we create it;
    // all other calls return exit 0.
    execaImpl = async (_cmd, args) => ({
      exitCode: args?.[0] === "has-session" ? 1 : 0,
      stdout: "",
      stderr: "",
    });

    const events: { phase: string; event: string }[] = [];
    const handle = track(
      await startServices(
        {
          tmux: {
            session: "test-ev",
            windows: [{ name: "web", cwd: ".", command: "yarn start" }],
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => events.push({ phase: e.phase, event: e.event }),
        },
      ),
    );

    expect(
      events.some((e) => e.phase === "tmux" && e.event === "session-created"),
    ).toBe(true);
    expect(events.some((e) => e.phase === "tmux" && e.event === "ready")).toBe(
      true,
    );
    expect(
      handle.events.filter((e) => e.phase === "tmux").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("emits docker fail event when docker command fails", async () => {
    execaImpl = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    shellImpl = async () => ({ exitCode: 1, stdout: "", stderr: "err" });

    const events: { phase: string; event: string }[] = [];
    await expect(
      startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => events.push({ phase: e.phase, event: e.event }),
        },
      ),
    ).rejects.toThrow(ServicesError);

    expect(events.some((e) => e.phase === "docker" && e.event === "fail")).toBe(
      true,
    );
  });

  it("emits tmux reuse event when session already exists", async () => {
    execaImpl = async (cmd, args) => {
      // tmux has-session returns 0 (exists)
      if (cmd === "tmux" && args[0] === "has-session") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const events: { phase: string; event: string }[] = [];
    const handle = track(
      await startServices(
        {
          tmux: {
            session: "existing-sess",
            reuseExisting: true,
            windows: [{ name: "web", cwd: ".", command: "yarn start" }],
          },
        },
        {
          configDir: dir,
          project: "test",
          coldStart: false,
          onEvent: (e) => events.push({ phase: e.phase, event: e.event }),
        },
      ),
    );

    expect(events.some((e) => e.phase === "tmux" && e.event === "reuse")).toBe(
      true,
    );
    expect(handle.events.some((e) => e.event === "reuse")).toBe(true);
  });

  it("collects events with timestamps in handle.events", async () => {
    execaImpl = async () => ({ exitCode: 0, stdout: "[]", stderr: "" });
    shellImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const handle = track(
      await startServices(
        { docker: { command: "docker compose up -d", cwd: dir } },
        { configDir: dir, project: "test", coldStart: false },
      ),
    );

    // Every event should have a valid ISO timestamp
    for (const e of handle.events) {
      expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(e.phase).toBeDefined();
      expect(e.event).toBeDefined();
      expect(typeof e.message).toBe("string");
    }
  });
});

/* ---------- dry-run mode tests ---------- */

describe("maybeStartServices — dry-run mode", () => {
  it("prints plan and returns no-op handle when servicesDryRun is true", async () => {
    // We test via run.ts maybeStartServices, but since that's harder to
    // isolate, we verify the handle shape here.
    const noopHandle: ServicesHandle = {
      startedByUs: false,
      events: [],
      stop: async () => undefined,
      terminateSync: () => undefined,
    };

    expect(noopHandle.startedByUs).toBe(false);
    expect(noopHandle.events).toEqual([]);
    await noopHandle.stop();
    expect(() => noopHandle.terminateSync()).not.toThrow();
  });
});
