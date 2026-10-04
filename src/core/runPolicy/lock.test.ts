import {
  existsSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRunLock,
  peekRunLock,
  RunLockRefusedError,
  runLockOwnerAlive,
  runLockPath,
  runLockTarget,
  type AcquireRunLockOptions,
} from "./lock";
import type { ProcessProbe } from "./processProbe";

/** A probe over a table of fake processes: pid → elapsed seconds. */
function fakeProbe(table: Record<number, number>): ProcessProbe {
  return {
    list: () => [],
    cwd: () => undefined,
    elapsedSeconds: (pid) => table[pid],
    isAlive: (pid) => Object.hasOwn(table, pid),
    command: () => undefined,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-run-lock-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function options(
  over: Partial<AcquireRunLockOptions> = {},
): AcquireRunLockOptions {
  return {
    scope: "config",
    key: "/work/project/cairntrace.config.yml",
    label: "project",
    displayName: "/work/project/cairntrace.config.yml",
    argv: ["run", "flows/a.yml"],
    cwd: "/work/project",
    root,
    invocationId: "inv-1",
    origin: "cli",
    env: "local",
    ...over,
  };
}

describe("run lock holders and targets", () => {
  it("names a services command that holds the lock, and peeks without touching it", () => {
    const probe = fakeProbe({ 4301: 5, 4302: 1 });
    const held = acquireRunLock(
      options({ pid: 4301, probe, command: "services down" }),
    );
    expect(JSON.parse(readFileSync(held.path, "utf8"))).toMatchObject({
      command: "services down",
    });
    // A run is the default holder: `command` stays out of its lock file.
    let refused: unknown;
    try {
      acquireRunLock(options({ pid: 4302, probe }));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RunLockRefusedError);
    expect((refused as Error).message).toContain(
      "another cairn services down holds the run lock",
    );
    const peek = peekRunLock(held.path, probe);
    expect(peek).toMatchObject({
      state: "live",
      owner: { pid: 4301, alive: true, command: "services down" },
    });
    expect(peekRunLock(held.path, fakeProbe({}))).toMatchObject({
      state: "dead",
    });
    held.release();
    expect(peekRunLock(held.path, probe)).toEqual({
      state: "absent",
      path: held.path,
    });
    writeFileSync(held.path, "{");
    expect(peekRunLock(held.path, probe).state).toBe("unreadable");
  });

  it("resolves a config or project target, falling back to the config without a project", () => {
    const base = {
      configKey: "/work/p/cairntrace.config.yml",
      configPath: "/work/p/cairntrace.config.yml",
      configDir: "/work/p",
    };
    expect(runLockTarget({ ...base, scope: "config" })).toMatchObject({
      scope: "config",
      key: base.configKey,
      label: "p",
      fellBack: false,
    });
    expect(
      runLockTarget({ ...base, scope: "project", project: "shop" }),
    ).toMatchObject({
      scope: "project",
      key: "project:shop",
      label: "shop",
      displayName: 'project "shop"',
    });
    expect(runLockTarget({ ...base, scope: "project" })).toMatchObject({
      scope: "config",
      fellBack: true,
    });
  });
});

describe("run lock", () => {
  it("takes an atomic lock file and releases only its own", () => {
    const lock = acquireRunLock(
      options({ pid: 4101, probe: fakeProbe({ 4101: 10 }) }),
    );
    expect(existsSync(lock.path)).toBe(true);
    const written = JSON.parse(readFileSync(lock.path, "utf8"));
    expect(written).toMatchObject({
      version: 1,
      pid: 4101,
      scope: "config",
      argv: ["run", "flows/a.yml"],
      invocationId: "inv-1",
      origin: "cli",
      env: "local",
    });
    expect(lock.release()).toBe(true);
    expect(existsSync(lock.path)).toBe(false);
    // Idempotent.
    expect(lock.release()).toBe(false);
  });

  it("refuses a live foreign owner with exit 4, naming the owner and its age", () => {
    const probe = fakeProbe({ 4101: 600, 4102: 5 });
    const first = acquireRunLock(
      options({
        pid: 4101,
        probe,
        now: () => Date.parse("2026-01-01T00:00:00Z"),
      }),
    );
    const refusal = (() => {
      try {
        acquireRunLock(
          options({
            pid: 4102,
            probe,
            invocationId: "inv-2",
            now: () => Date.parse("2026-01-01T00:05:00Z"),
          }),
        );
      } catch (error) {
        return error as RunLockRefusedError;
      }
      throw new Error("expected a refusal");
    })();
    expect(refusal).toBeInstanceOf(RunLockRefusedError);
    expect(refusal.exitCode).toBe(4);
    expect(refusal.reason).toBe("held");
    expect(refusal.owner).toMatchObject({
      pid: 4101,
      alive: true,
      ageSeconds: 300,
    });
    expect(refusal.message).toContain("pid 4101");
    expect(refusal.message).toContain("5m ago");
    expect(refusal.message).toContain("cairn run flows/a.yml");
    // The first lock is untouched.
    expect(JSON.parse(readFileSync(first.path, "utf8")).pid).toBe(4101);
    first.release();
  });

  it("reclaims a dead owner's lock and reports the previous owner", () => {
    const dead = acquireRunLock(
      options({ pid: 4101, probe: fakeProbe({ 4101: 10 }) }),
    );
    // Owner 4101 is gone: only 4102 exists now.
    const lock = acquireRunLock(
      options({
        pid: 4102,
        probe: fakeProbe({ 4102: 3 }),
        invocationId: "inv-2",
      }),
    );
    expect(lock.reclaimed).toMatchObject({ pid: 4101, alive: false });
    expect(JSON.parse(readFileSync(lock.path, "utf8")).invocationId).toBe(
      "inv-2",
    );
    // The dead owner's release must not remove the new lock.
    expect(dead.release()).toBe(false);
    expect(existsSync(lock.path)).toBe(true);
    lock.release();
  });

  it("treats a recycled pid (younger than the lock) as a dead owner", () => {
    const started = Date.parse("2026-01-01T00:00:00Z");
    acquireRunLock(
      options({
        pid: 4101,
        probe: fakeProbe({ 4101: 10 }),
        now: () => started,
      }),
    );
    // Ten minutes later pid 4101 is alive again but only 20s old: recycled.
    const lock = acquireRunLock(
      options({
        pid: 4102,
        probe: fakeProbe({ 4101: 20, 4102: 1 }),
        now: () => started + 600_000,
      }),
    );
    expect(lock.reclaimed?.pid).toBe(4101);
    lock.release();
  });

  it("refuses a dead owner's lock when staleAfterPidDead is false", () => {
    acquireRunLock(options({ pid: 4101, probe: fakeProbe({ 4101: 10 }) }));
    expect(() =>
      acquireRunLock(
        options({
          pid: 4102,
          probe: fakeProbe({ 4102: 1 }),
          staleAfterPidDead: false,
        }),
      ),
    ).toThrow(/staleAfterPidDead is false/);
  });

  it("refuses an unreadable lock file instead of overwriting it", () => {
    const path = runLockPath(options().key, options().label, root);
    writeFileSync(path, "not json");
    // Age the file so it is not mistaken for a half-written lock.
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const error = (() => {
      try {
        acquireRunLock(options({ pid: 4102, probe: fakeProbe({ 4102: 1 }) }));
      } catch (e) {
        return e as RunLockRefusedError;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.reason).toBe("unreadable");
    expect(error.exitCode).toBe(4);
    expect(readFileSync(path, "utf8")).toBe("not json");
  });

  it("scopes locks by key: two configs do not exclude each other", () => {
    const probe = fakeProbe({ 4101: 10 });
    const a = acquireRunLock(
      options({ pid: 4101, probe, key: "/a/config.yml" }),
    );
    const b = acquireRunLock(
      options({ pid: 4101, probe, key: "/b/config.yml" }),
    );
    expect(a.path).not.toBe(b.path);
    a.release();
    b.release();
  });

  it("leaves no temp files behind", () => {
    const lock = acquireRunLock(
      options({ pid: 4101, probe: fakeProbe({ 4101: 10 }) }),
    );
    lock.release();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("run lock: --var values never reach the lock file or a refusal", () => {
  it("keeps the keys of --var and drops the values", () => {
    // Built at runtime: never a credential-shaped literal in the source.
    const value = ["pw", "Zq9", String(Date.now()).slice(-4)].join("-");
    const probe = fakeProbe({ 4201: 600, 4202: 5 });
    const first = acquireRunLock(
      options({
        pid: 4201,
        probe,
        argv: [
          "run",
          "flows/a.yml",
          "--var",
          `adminPass=${value}`,
          `--var=ticket=${value}`,
          "--label",
          "suite=smoke",
        ],
      }),
    );
    const text = readFileSync(first.path, "utf8");
    expect(text).not.toContain(value);
    expect(JSON.parse(text).argv).toEqual([
      "run",
      "flows/a.yml",
      "--var",
      "adminPass=…",
      "--var=ticket=…",
      "--label",
      "suite=smoke",
    ]);
    let message = "";
    try {
      acquireRunLock(options({ pid: 4202, probe, invocationId: "inv-2" }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("--var adminPass=…");
    expect(message).not.toContain(value);
    first.release();
  });

  it("does not echo values a lock written by an older cairn still holds", () => {
    const value = ["tok", "Xy7", String(Date.now()).slice(-4)].join("-");
    const path = runLockPath(options().key, options().label, root);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        token: "t",
        pid: 4301,
        startedAt: new Date().toISOString(),
        argv: ["run", "--var", `secretish=${value}`],
        cwd: "/work/project",
        scope: "config",
        key: options().key,
      }),
    );
    let message = "";
    try {
      acquireRunLock(
        options({ pid: 4302, probe: fakeProbe({ 4301: 600, 4302: 1 }) }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("--var secretish=…");
    expect(message).not.toContain(value);
  });
});

describe("runLockOwnerAlive", () => {
  it("is false when the pid does not exist", () => {
    expect(
      runLockOwnerAlive(
        { pid: 9, startedAt: "2026-01-01T00:00:00Z" },
        fakeProbe({}),
      ),
    ).toBe(false);
  });

  it("is true for a live process at least as old as the lock", () => {
    expect(
      runLockOwnerAlive(
        { pid: 9, startedAt: "2026-01-01T00:00:00Z" },
        fakeProbe({ 9: 400 }),
        Date.parse("2026-01-01T00:05:00Z"),
      ),
    ).toBe(true);
  });
});
