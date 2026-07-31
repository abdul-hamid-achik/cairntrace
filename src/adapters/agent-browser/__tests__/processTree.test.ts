import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createProcessTreeWatchdog } from "../processTree";

const itPosix = process.platform === "win32" ? it.skip : it;

describe("agent-browser process-tree watchdog", () => {
  itPosix(
    "kills a signal-resistant shim and its native child at the hard deadline",
    async () => {
      const grandchildSource = `
      process.on("SIGTERM", () => {});
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1_000);
    `;
      const parentSource = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.once("data", () => {
        process.stdout.write(String(child.pid) + "\\n");
      });
      setInterval(() => {}, 1_000);
    `;
      const parent = spawn(process.execPath, ["-e", parentSource], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let grandchildPid: number | undefined;

      try {
        grandchildPid = Number(await firstLine(parent));
        expect(Number.isInteger(grandchildPid)).toBe(true);

        // Prove this fixture models the Homebrew/npm shim failure: SIGTERM of
        // the parent does not terminate either the shim or its native child.
        parent.kill("SIGTERM");
        await delay(75);
        expect(isAlive(parent.pid)).toBe(true);
        expect(isAlive(grandchildPid)).toBe(true);

        const parentExit = once(parent, "exit");
        const watchdog = createProcessTreeWatchdog(parent.pid, 50);
        await parentExit;
        await waitUntilDead(grandchildPid);

        expect(watchdog.timedOut).toBe(true);
        expect(isAlive(parent.pid)).toBe(false);
        expect(isAlive(grandchildPid)).toBe(false);
      } finally {
        killIfAlive(grandchildPid);
        killIfAlive(parent.pid);
      }
    },
  );
});

async function firstLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("fixture parent has no stdout pipe");
  let buffered = "";
  for await (const chunk of stdout) {
    buffered += String(chunk);
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline).trim();
  }
  throw new Error("fixture parent exited before reporting its child pid");
}

async function waitUntilDead(pid: number | undefined): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (isAlive(pid) && Date.now() < deadline) await delay(20);
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
