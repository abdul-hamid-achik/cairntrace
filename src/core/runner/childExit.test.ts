import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  childStateSync,
  decodeWaitStatus,
  parseProcStat,
  watchChildExit,
  type ExitProbe,
} from "./childExit";

/**
 * A runtime can lose a child's exit notification (Bun on Linux: the child
 * stays `<defunct>`, `exit` never fires). These tests pin the fallback that
 * settles such a wait from the process table instead of awaiting forever.
 */

/** A `/proc/<pid>/stat` line: fields 3..52 after `(comm)`. */
function procStat(state: string, exitCode: number, comm = "sh"): string {
  const rest = Array.from({ length: 50 }, () => "0");
  rest[0] = state;
  rest[49] = String(exitCode);
  return `4242 (${comm}) ${rest.join(" ")}\n`;
}

const esrch = (): never => {
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
};
const eperm = (): never => {
  throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
};

function probe(over: Partial<ExitProbe>): ExitProbe {
  return {
    platform: "linux",
    kill: () => undefined,
    readProcStat: () => procStat("S", 0),
    ...over,
  };
}

/** A child whose runtime never reports anything: no exit, no error. */
function silentChild(pid: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid, unref: () => undefined });
  return child;
}

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

describe("parseProcStat / decodeWaitStatus", () => {
  it("reads the state and the waitpid exit status (field 52)", () => {
    expect(parseProcStat(procStat("Z", 7 << 8))).toEqual({
      state: "Z",
      exitStatus: 7 << 8,
    });
    // comm may hold spaces and parentheses: fields count after the last `)`.
    expect(parseProcStat(procStat("S", 0, "a (b) c"))).toMatchObject({
      state: "S",
    });
    // A kernel without field 52 (< 3.5): the state alone.
    expect(parseProcStat("42 (sh) Z 1 42")).toEqual({ state: "Z" });
    expect(parseProcStat("garbage")).toBeUndefined();
  });

  it("decodes an exit code, a terminating signal, and ignores a stop", () => {
    expect(decodeWaitStatus(0)).toEqual({ exitCode: 0 });
    expect(decodeWaitStatus(3 << 8)).toEqual({ exitCode: 3 });
    expect(decodeWaitStatus(9)).toEqual({ signal: "SIGKILL" });
    expect(decodeWaitStatus(15)).toEqual({ signal: "SIGTERM" });
    expect(decodeWaitStatus((19 << 8) | 0x7f)).toEqual({});
  });
});

describe("childStateSync", () => {
  it("treats a pid gone from the process table as ended", () => {
    expect(childStateSync(1, probe({ kill: esrch }))).toEqual({
      running: false,
    });
  });

  it("reads a Linux zombie's exit status from /proc", () => {
    expect(
      childStateSync(1, probe({ readProcStat: () => procStat("Z", 3 << 8) })),
    ).toEqual({ running: false, exitCode: 3 });
    expect(
      childStateSync(1, probe({ readProcStat: () => procStat("Z", 9) })),
    ).toEqual({ running: false, signal: "SIGKILL" });
    expect(
      childStateSync(1, probe({ readProcStat: () => procStat("R", 0) })),
    ).toEqual({ running: true });
  });

  it("counts a process it cannot judge as running", () => {
    expect(childStateSync(1, probe({ kill: eperm }))).toEqual({
      running: true,
    });
    // No /proc (macOS): a zombie looks alive; the caller's deadline bounds it.
    expect(childStateSync(1, probe({ platform: "darwin" }))).toEqual({
      running: true,
    });
    expect(
      childStateSync(
        1,
        probe({
          readProcStat: () => {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          },
        }),
      ),
    ).toEqual({ running: true });
  });
});

describe("watchChildExit", () => {
  it("settles from the exit event when the runtime delivers it", async () => {
    const child = silentChild(4242);
    const watch = watchChildExit(child, { pollMs: 10, probe: probe({}) });
    child.emit("exit", 2, null);
    await expect(watch.exited).resolves.toEqual({
      code: 2,
      signal: null,
      via: "event",
    });
  });

  it("settles a lost exit from a zombie's /proc status after the grace", async () => {
    const child = silentChild(4242);
    const started = Date.now();
    const watch = watchChildExit(child, {
      pollMs: 10,
      lostGraceMs: 50,
      probe: probe({ readProcStat: () => procStat("Z", 0) }),
    });
    await expect(watch.exited).resolves.toEqual({
      code: 0,
      signal: null,
      via: "poll",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("lets a late exit event win inside the grace", async () => {
    const child = silentChild(4242);
    const watch = watchChildExit(child, {
      pollMs: 5,
      lostGraceMs: 10_000,
      probe: probe({ kill: esrch }),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    child.emit("exit", 1, null);
    await expect(watch.exited).resolves.toMatchObject({
      code: 1,
      via: "event",
    });
  });

  it("settles an exit the runtime reaped but never reported (real child)", async () => {
    const real = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    spawned.push(real);
    // The watched handle never hears about it; the real one reaps it.
    const watch = watchChildExit(silentChild(real.pid!), {
      pollMs: 20,
      lostGraceMs: 20,
    });
    await expect(watch.exited).resolves.toMatchObject({ via: "poll" });
  });

  it.runIf(process.platform === "linux")(
    "recovers the exit code of a real unreaped zombie",
    async () => {
      // `(exit 7) &` forks a subshell whose parent then execs `sleep`, which
      // never waits for it: a zombie holding exit status 7.
      const parent = spawn(
        "/bin/sh",
        ["-c", "(exit 7) & echo $!; exec sleep 30"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      spawned.push(parent);
      const zombie = await new Promise<number>((resolve) => {
        parent.stdout!.once("data", (chunk: Buffer) =>
          resolve(Number.parseInt(String(chunk), 10)),
        );
      });
      const watch = watchChildExit(silentChild(zombie), {
        pollMs: 20,
        lostGraceMs: 20,
      });
      await expect(watch.exited).resolves.toEqual({
        code: 7,
        signal: null,
        via: "poll",
      });
    },
  );

  it("abandon() settles a wait nothing will ever end", async () => {
    const watch = watchChildExit(silentChild(4242), {
      pollMs: 10,
      probe: probe({ platform: "darwin" }),
    });
    setTimeout(() => watch.abandon(), 30);
    await expect(watch.exited).resolves.toEqual({
      code: null,
      signal: null,
      via: "abandoned",
    });
  });
});
