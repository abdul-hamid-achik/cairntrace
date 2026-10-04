import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalConfigPath } from "../../../core/runner/services";
import {
  acquireRunLock,
  RUN_LOCK_ENV,
  runLockLabel,
  runLockPath,
  type RunLockHandle,
} from "../../../core/runPolicy/lock";
import {
  ServicesDownResultSchema,
  ServicesRestartResultSchema,
  ServicesUpResultSchema,
} from "../../../core/schema/services.v1";
import { buildMcpServer } from "../../../mcp/server";
import { servicesDown, renderServicesDownMarkdown } from "./down";
import { servicesRestart } from "./restart";
import { servicesUp } from "./up";

/**
 * `cairn services up | down | restart` under the config `run: { lock }`: a
 * live run of the same config owns the stack, so they refuse (exit 4,
 * nothing touched — no provisioner `down` of a live run's billable
 * resource); a dead owner's lock is reclaimed; a command the owner started
 * (`CAIRN_RUN_LOCK`) runs under its lock; otherwise they hold the lock for
 * their own duration. Stub commands only (no docker, no tmux).
 */

let dir: string;
let configPath: string;
let log: string;
let counter = 0;
const held: RunLockHandle[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-svc-runlock-"));
  configPath = join(dir, "cairntrace.config.yml");
  log = join(dir, "calls.log");
});

afterEach(async () => {
  for (const handle of held.splice(0)) handle.release();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function write(
  run: string,
  extra = "",
  /** A tmux block (only for restart, which refuses before any tmux call). */
  tmux = false,
): Promise<void> {
  counter += 1;
  await writeFile(
    configPath,
    `version: 1
project: svc-runlock-${process.pid}-${counter}
defaultEnvironment: local
${run}
environments:
  local:
    baseUrl: http://localhost:8080
    services:
      provisioner:
        up: 'echo up >> "${log}"'
        down: 'echo down >> "${log}"; cat "$CAIRN_TEST_LOCK" >> "${log}.lock" 2>/dev/null || true'
${
  tmux
    ? `      tmux:
        session: svc-runlock-${counter}
        windows:
          - { name: web, command: "sleep 30" }
`
    : ""
}${extra}`,
  );
}

async function lines(): Promise<string[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.trim() === "" ? [] : text.trim().split("\n");
}

/** The config-scope lock file the run engine takes for this config. */
async function configLock(): Promise<{
  key: string;
  label: string;
  path: string;
}> {
  const key = await canonicalConfigPath(configPath);
  const label = runLockLabel(configPath, dir);
  return { key, label, path: runLockPath(key, label) };
}

/** A live `cairn run` of this config: a lock owned by this (alive) process. */
async function liveRun(env = "local"): Promise<RunLockHandle> {
  const { key, label } = await configLock();
  const handle = acquireRunLock({
    scope: "config",
    key,
    label,
    displayName: configPath,
    origin: "cli",
    env,
    invocationId: "inv-live",
    argv: ["run", "--suite", "smoke", "--var", "token=secret-value"],
    cwd: dir,
  });
  held.push(handle);
  return handle;
}

/** A pid that is certainly not running any more. */
function deadPid(): number {
  const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(child.stdout.trim());
}

describe("services commands under a live run lock", () => {
  it("services down refuses (exit 4): no provisioner down, no teardown, the services lock kept", async () => {
    await write("run: { lock: true }");
    const owner = await liveRun();
    const down = await servicesDown({ config: configPath });
    expect(ServicesDownResultSchema.safeParse(down).success).toBe(true);
    expect(down).toMatchObject({ ok: false, exitCode: 4 });
    expect(down.teardown).toEqual([]);
    expect(down.runLock).toMatchObject({
      state: "refused",
      reason: "held",
      scope: "config",
      path: owner.path,
      owner: { pid: process.pid, alive: true, env: "local" },
    });
    expect(down.error).toContain("another cairn run holds the run lock");
    expect(down.error).toContain(`pid ${process.pid}`);
    expect(down.error).toContain("nothing was torn down");
    // The owner's --var values never reach the refusal.
    expect(down.error).not.toContain("secret-value");
    expect(await lines()).toEqual([]);
    expect(existsSync(owner.path)).toBe(true);
    expect(renderServicesDownMarkdown(down)).toContain(
      "- run lock (config scope): refused (held)",
    );
  });

  it("services up refuses (exit 4) before the provisioner runs", async () => {
    await write("run: { lock: true }");
    await liveRun();
    const up = await servicesUp({ config: configPath, by: "cli" });
    expect(ServicesUpResultSchema.safeParse(up).success).toBe(true);
    expect(up).toMatchObject({
      ok: false,
      exitCode: 4,
      runLock: { state: "refused" },
    });
    expect(up.error).toContain("nothing was started");
    expect(await lines()).toEqual([]);
  });

  it("services restart refuses (exit 4) before touching a window", async () => {
    await write("run: { lock: true }", "", true);
    await liveRun();
    const restart = await servicesRestart({
      config: configPath,
      windows: ["web"],
    });
    expect(ServicesRestartResultSchema.safeParse(restart).success).toBe(true);
    expect(restart).toMatchObject({
      ok: false,
      exitCode: 4,
      windows: [],
      runLock: { state: "refused" },
    });
    expect(restart.error).toContain("nothing was restarted");
  });

  it("a lock the config declares for another environment still refuses (one stack per config)", async () => {
    await write(
      "",
      `  remote:
    baseUrl: http://localhost:8081
    run: { lock: true }
`,
    );
    await liveRun("remote");
    const down = await servicesDown({ config: configPath, env: "local" });
    expect(down).toMatchObject({ ok: false, exitCode: 4 });
    expect(down.runLock).toMatchObject({ state: "refused", reason: "held" });
    expect(await lines()).toEqual([]);
  });

  it("MCP cairn_services_down refuses the same way", async () => {
    await write("run: { lock: true }");
    await liveRun();
    const server = buildMcpServer({ allowServices: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "runlock-test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const down = await client.callTool({
        name: "cairn_services_down",
        arguments: { config: configPath },
      });
      expect(down.isError).toBe(true);
      expect(
        ServicesDownResultSchema.parse(down.structuredContent),
      ).toMatchObject({ exitCode: 4, runLock: { state: "refused" } });
      expect(await lines()).toEqual([]);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("services commands that may run", () => {
  it("hold the run lock for the teardown (a run started meanwhile would refuse) and release it", async () => {
    await write("run: { lock: true }");
    const { path } = await configLock();
    vi.stubEnv("CAIRN_TEST_LOCK", path);
    const down = await servicesDown({ config: configPath, by: "mcp" });
    expect(down).toMatchObject({ ok: true, exitCode: 0 });
    expect(down.runLock).toEqual({ path, scope: "config", state: "held" });
    expect(await lines()).toEqual(["down"]);
    // While `down` ran, the lock named the services command.
    const during = JSON.parse(await readFile(`${log}.lock`, "utf8"));
    expect(during).toMatchObject({
      command: "services down",
      origin: "mcp",
      env: "local",
      pid: process.pid,
    });
    expect(existsSync(path)).toBe(false);
    expect(renderServicesDownMarkdown(down)).toContain(
      "- run lock (config scope): held for this command, released when it ended",
    );
  });

  it("reclaim a dead owner's lock", async () => {
    await write("run: { lock: true }");
    const { key, path } = await configLock();
    const pid = deadPid();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        token: "dead-owner",
        pid,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        argv: ["run"],
        cwd: dir,
        scope: "config",
        key,
      }),
    );
    const down = await servicesDown({ config: configPath });
    expect(down).toMatchObject({ ok: true, exitCode: 0 });
    expect(down.runLock).toMatchObject({
      state: "reclaimed",
      owner: { pid, alive: false },
    });
    expect(await lines()).toEqual(["down"]);
    expect(existsSync(path)).toBe(false);
  });

  it("keep refusing a dead owner's lock under staleAfterPidDead: false", async () => {
    await write("run: { lock: { staleAfterPidDead: false } }");
    const { key, path } = await configLock();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        token: "dead-owner",
        pid: deadPid(),
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        argv: ["run"],
        cwd: dir,
        scope: "config",
        key,
      }),
    );
    const down = await servicesDown({ config: configPath });
    expect(down).toMatchObject({ ok: false, exitCode: 4 });
    expect(down.runLock).toMatchObject({ state: "refused", reason: "stale" });
    expect(await lines()).toEqual([]);
  });

  it("run under the lock of the run that started them (CAIRN_RUN_LOCK)", async () => {
    await write("run: { lock: true }");
    const owner = await liveRun();
    vi.stubEnv(RUN_LOCK_ENV, owner.path);
    const down = await servicesDown({ config: configPath });
    expect(down).toMatchObject({ ok: true, exitCode: 0 });
    expect(down.runLock).toMatchObject({
      state: "nested",
      owner: { pid: process.pid },
    });
    expect(await lines()).toEqual(["down"]);
    // The owner's lock is untouched.
    expect(existsSync(owner.path)).toBe(true);
  });

  it("change nothing without a configured run.lock", async () => {
    await write("");
    await liveRun();
    const down = await servicesDown({ config: configPath });
    expect(down).toMatchObject({ ok: true, exitCode: 0 });
    expect(down.runLock).toBeUndefined();
    expect(await lines()).toEqual(["down"]);
  });
});
