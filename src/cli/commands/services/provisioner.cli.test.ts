import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ServicesDownResultSchema,
  ServicesUpResultSchema,
} from "../../../core/schema/services.v1";
import {
  tunnelStateKey,
  tunnelStatePath,
} from "../../../core/servicesOps/tunnels";
import { servicesDown } from "./down";
import { servicesUp } from "./up";

/**
 * `cairn services up` / `down` with a provisioner and a tunnel (no docker, no
 * tmux): the provisioner's `up` runs and is left, a tunnel stays up
 * unsupervised, and `down` re-evaluates the exports for the `down` command,
 * stops the tunnel and reports a failed `down` as exit 8.
 */

let dir: string;
let configPath: string;
let counter = 0;
const pids: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function write(down: string, extra = ""): Promise<void> {
  counter += 1;
  await writeFile(
    configPath,
    `version: 1
project: prov-cli-${process.pid}-${counter}
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
services:
  provisioner:
    up: 'echo up >> "${dir}/prov.log"'
    down: '${down}'
    exports:
      SANDBOX_ID: "echo sbx-42"
  tunnels:
    - { name: db, command: "exec sleep 46" }
${extra}`,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-prov-cli-"));
  configPath = join(dir, "cairntrace.config.yml");
});
afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  pids.length = 0;
  await rm(dir, { recursive: true, force: true });
});

describe("services up / down with a provisioner and a tunnel", () => {
  it("up leaves them running; down uses the re-evaluated exports and stops the tunnel", async () => {
    await write(`echo "down $SANDBOX_ID" >> "${dir}/prov.log"`);
    const up = await servicesUp({ config: configPath, by: "cli" });
    expect(ServicesUpResultSchema.safeParse(up).success).toBe(true);
    expect(up).toMatchObject({
      ok: true,
      exitCode: 0,
      phases: { provisioner: "up", tunnels: ["db"] },
    });
    expect(JSON.stringify(up)).not.toContain("sbx-42");
    const state = JSON.parse(
      await readFile(
        tunnelStatePath(
          join(process.env.HOME!, ".cairntrace", "services"),
          tunnelStateKey({
            project: up.project!,
            env: "local",
            configPath,
            configDir: dir,
          }),
          "db",
        ),
        "utf8",
      ),
    ) as { pid: number };
    pids.push(state.pid);
    expect(alive(state.pid)).toBe(true);
    expect((await readFile(join(dir, "prov.log"), "utf8")).trim()).toBe("up");

    const down = await servicesDown({ config: configPath });
    expect(ServicesDownResultSchema.safeParse(down).success).toBe(true);
    expect(down).toMatchObject({ ok: true, exitCode: 0 });
    expect(down.tunnels).toEqual([{ name: "db", result: "stopped" }]);
    expect(down.teardown).toEqual([
      expect.objectContaining({ ok: true, critical: true, provisioner: true }),
    ]);
    expect(
      (await readFile(join(dir, "prov.log"), "utf8")).trim().split("\n"),
    ).toEqual(["up", "down sbx-42"]);
    await waitDead(state.pid);
    expect(alive(state.pid)).toBe(false);
    expect(down.removedLock).toBeDefined();
  });

  it("a failed provisioner down is exit 8, and the rest still ran", async () => {
    await write("exit 6");
    const up = await servicesUp({ config: configPath, by: "cli" });
    expect(up.ok).toBe(true);
    const state = JSON.parse(
      await readFile(
        tunnelStatePath(
          join(process.env.HOME!, ".cairntrace", "services"),
          tunnelStateKey({
            project: up.project!,
            env: "local",
            configPath,
            configDir: dir,
          }),
          "db",
        ),
        "utf8",
      ),
    ) as { pid: number };
    pids.push(state.pid);
    const down = await servicesDown({ config: configPath });
    expect(down).toMatchObject({ ok: false, exitCode: 8 });
    expect(down.teardown[0]).toMatchObject({
      ok: false,
      exitCode: 6,
      critical: true,
      provisioner: true,
    });
    expect(down.error).toMatch(/1 teardown command\(s\) failed/);
    await waitDead(state.pid);
    expect(alive(state.pid)).toBe(false);
    expect(existsSync(down.lockPath!)).toBe(false);
  });

  it("a failed boot after the provisioner ran tears it down and writes no lock", async () => {
    await write(
      `echo down >> "${dir}/prov.log"`,
      `  seed:\n    command: "exit 1"\n`,
    );
    const up = await servicesUp({ config: configPath, by: "cli" });
    expect(up).toMatchObject({ ok: false, exitCode: 2 });
    expect(
      (await readFile(join(dir, "prov.log"), "utf8")).trim().split("\n"),
    ).toEqual(["up", "down"]);
    expect(up.lock).toBeUndefined();
  });

  it("a failed boot whose provisioner down fails too is exit 8 with teardown[] and the boot's events", async () => {
    await write(
      `echo down >> "${dir}/prov.log"; exit 6`,
      `  seed:\n    command: "exit 1"\n`,
    );
    const up = await servicesUp({ config: configPath, by: "cli" });
    expect(ServicesUpResultSchema.safeParse(up).success).toBe(true);
    expect(up).toMatchObject({ ok: false, exitCode: 8 });
    expect(up.teardown).toEqual([
      expect.objectContaining({
        ok: false,
        critical: true,
        provisioner: true,
        exitCode: 6,
      }),
    ]);
    expect(up.error).toMatch(
      /CRITICAL: the failure cleanup could not complete/,
    );
    const seen = up.events.map((e) => `${e.phase}.${e.event}`);
    expect(seen).toContain("provisioner.ready");
    expect(seen).toContain("seed.fail");
    expect(seen).toContain("teardown.fail");
    expect(JSON.stringify(up)).not.toContain("sbx-42");
    expect(up.lock).toBeUndefined();
    expect(
      (await readFile(join(dir, "prov.log"), "utf8")).trim().split("\n"),
    ).toEqual(["up", "down"]);
  });
});
