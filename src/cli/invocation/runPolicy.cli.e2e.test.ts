import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished as onTeardown,
} from "vitest";
import { recordLedgerSession } from "../../core/runPolicy/sessionLedger";

/**
 * The real `bin/cairn run` processes against the config `run:` block: two
 * concurrent runs of one config (the second refuses with exit 4 while the
 * first holds the lock), exit 8 for a critical teardown, exit 9 for a
 * survivor of the run, and --bail's skipped specs in the markdown summary.
 * Mock backend, stub commands, a temp dir.
 */

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

let dir: string;
const spawned: ChildProcess[] = [];

const PASSING = `version: 1
name: cli_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;
const FAILING = PASSING.replace("cli_pass", "cli_fail").replace(
  'matches: "/home"',
  'matches: "/never"',
);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-policy-cli-"));
  await writeFile(join(dir, "pass.yml"), PASSING);
  await writeFile(
    join(dir, "pass2.yml"),
    PASSING.replace("cli_pass", "cli_pass2"),
  );
  await writeFile(join(dir, "fail.yml"), FAILING);
});

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cairn(
  args: string[],
  env: Record<string, string> = {},
): {
  child: ChildProcess;
  done: Promise<Finished>;
} {
  const child = spawn("bun", [BIN, "run", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CAIRN_LOG_LEVEL: "info",
      CAIRN_VERIFY_CLEAN_GRACE_MS: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<Finished>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function writeConfig(name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: cli-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${body}`,
  );
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const lockDir = (): string => join(homedir(), ".cairntrace", "locks");

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("cairn run: the run lock across processes", () => {
  it("refuses the second concurrent run of one config with exit 4 and runs after the first finishes", async () => {
    const config = await writeConfig(
      "concurrent",
      `run:
  lock: true
  preflight:
    # Keeps the first run inside its lock for a while.
    - { command: "sleep 3" }
`,
    );
    const first = cairn([
      "pass.yml",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-a"),
    ]);
    await until(
      () =>
        existsSync(lockDir()) &&
        readdirSync(lockDir()).some((name) => name.endsWith(".run.lock.json")),
    );

    const second = await cairn([
      "pass.yml",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-b"),
    ]).done;
    expect(second.code).toBe(4);
    expect(second.stderr).toContain("another cairn run holds the run lock");
    expect(second.stderr).toContain(`pid ${first.child.pid}`);

    const firstResult = await first.done;
    expect(firstResult.code).toBe(0);
    // The lock is released: nothing left, and a third run is not refused.
    expect(
      readdirSync(lockDir()).filter((n) => n.endsWith(".run.lock.json")),
    ).toEqual([]);
    const config2 = await writeConfig(
      "concurrent-fast",
      `run:
  lock: true
`,
    );
    const third = await cairn([
      "pass.yml",
      "--mock",
      "--config",
      config2,
      "--artifact-root",
      join(dir, "runs-c"),
    ]).done;
    expect(third.code).toBe(0);
  }, 60_000);
});

describe("cairn run: the run lock on a signal", () => {
  it("releases the lock when the process is terminated mid-run", async () => {
    const config = await writeConfig(
      "signal",
      `run:
  lock: true
  preflight:
    - { command: "sleep 30" }
`,
    );
    const lockFiles = (): string[] =>
      existsSync(lockDir())
        ? readdirSync(lockDir()).filter((name) =>
            name.endsWith(".run.lock.json"),
          )
        : [];
    // Other tests of this file leave no lock behind, so any file is ours.
    const before = lockFiles().length;
    const run = cairn([
      "pass.yml",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-sig"),
    ]);
    await until(() => lockFiles().length > before);
    run.child.kill("SIGTERM");
    const result = await run.done;
    expect(result.code).toBe(143);
    expect(lockFiles()).toHaveLength(before);
  }, 60_000);

  it("runs run.finally (CAIRN_EXIT_CODE=143) and ends the run's commands before releasing the lock", async () => {
    const marks = join(dir, "signal-finally.txt");
    const started = join(dir, "signal-started.txt");
    await writeFile(
      join(dir, "sleepy.yml"),
      PASSING.replace(
        "name: cli_pass",
        `name: cli_sleepy
preconditions:
  commands:
    - run: 'sleep 30 & echo $! > "${started}"; wait'`,
      ),
    );
    const config = await writeConfig(
      "signal-finally",
      `run:
  lock: true
  finally:
    - 'echo "finally exit=$CAIRN_EXIT_CODE" >> "${marks}"'
`,
    );
    const run = cairn([
      "sleepy.yml",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-sig-finally"),
    ]);
    await until(() => existsSync(started));
    let sleeper = 0;
    await until(() => {
      sleeper = Number(readFileSync(started, "utf8").trim());
      return sleeper > 0;
    });
    run.child.kill("SIGTERM");
    const result = await run.done;
    expect(result.code).toBe(143);
    expect((await readFile(marks, "utf8")).trim()).toBe("finally exit=143");
    // The precondition did not outlive the run (nor its lock).
    await until(() => !alive(sleeper), 5_000);
  }, 60_000);
});

describe("cairn run: a second signal during the signal cleanup", () => {
  it("never cuts the provisioner's down, run.finally or the lock release short", async () => {
    const marks = join(dir, "double-signal.txt");
    const resource = join(dir, "double-signal-resource");
    const started = join(dir, "double-signal-started.txt");
    await writeFile(
      join(dir, "double-sleepy.yml"),
      PASSING.replace(
        "name: cli_pass",
        `name: cli_double_sleepy
preconditions:
  commands:
    - run: 'sleep 30 & echo $! > "${started}"; wait'`,
      ),
    );
    const config = await writeConfig(
      "double-signal",
      `run:
  lock: true
  finally:
    - 'echo "finally exit=$CAIRN_EXIT_CODE" >> "${marks}"'
services:
  provisioner:
    up: 'echo droplet-7 > "${resource}"'
    down: 'echo "down id=$DROPLET_ID" >> "${marks}"; rm -f "${resource}"'
    exports:
      DROPLET_ID: 'cat "${resource}"'
suites:
  dbl:
    specs: [double-sleepy.yml]
    after: ['echo after >> "${marks}"; sleep 3']
`,
    );
    const lockFiles = (): string[] =>
      existsSync(lockDir())
        ? readdirSync(lockDir()).filter((name) =>
            name.endsWith(".run.lock.json"),
          )
        : [];
    const before = lockFiles().length;
    const run = cairn([
      "--suite",
      "dbl",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-double-signal"),
    ]);
    await until(() => existsSync(started));
    let sleeper = 0;
    await until(() => {
      sleeper = Number(readFileSync(started, "utf8").trim());
      return sleeper > 0;
    });
    const startedAt = Date.now();
    run.child.kill("SIGINT");
    // The suite's after hook (services still up) is running: hit it again.
    await until(
      () => existsSync(marks) && readFileSync(marks, "utf8").includes("after"),
    );
    run.child.kill("SIGINT");
    run.child.kill("SIGTERM");
    run.child.kill("SIGHUP");
    const result = await run.done;
    expect(result.code, result.stderr).toBe(130);
    expect((await readFile(marks, "utf8")).trim().split("\n")).toEqual([
      "after",
      "down id=droplet-7",
      "finally exit=130",
    ]);
    expect(existsSync(resource)).toBe(false);
    expect(lockFiles()).toHaveLength(before);
    expect(result.stderr).toContain(
      "cleanup in progress (critical teardown pending)",
    );
    // Bounded: the after hook's 3s, not a hang.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    await until(() => !alive(sleeper), 5_000);
  }, 60_000);

  it("prints the documents of the iterations that finished, with invocationOutcome exit 130", async () => {
    const gate = join(dir, "held-gate");
    const started = join(dir, "held-started.txt");
    await writeFile(
      join(dir, "held-sleepy.yml"),
      PASSING.replace(
        "name: cli_pass",
        `name: cli_held
preconditions:
  commands:
    - run: 'if [ -f "${gate}" ]; then sleep 30 & echo $! > "${started}"; wait; else touch "${gate}"; fi'`,
      ),
    );
    const config = await writeConfig("held", "run:\n  lock: true\n");
    const run = cairn([
      "held-sleepy.yml",
      "--mock",
      "--json",
      "--repeat",
      "3",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-held"),
    ]);
    await until(() => existsSync(started));
    run.child.kill("SIGINT");
    const result = await run.done;
    expect(result.code, result.stderr).toBe(130);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "passed",
      exitCode: 0,
      invocationOutcome: { exitCode: 130, specsExitCode: 0 },
    });
  }, 60_000);
});

describe("cairn run: exit codes 8 and 9", () => {
  it("exit 8: a critical teardown that failed outranks a green run", async () => {
    const config = await writeConfig(
      "exit8",
      `services:
  docker:
    command: "true"
    reuseExisting: false
  teardown:
    - { run: "exit 3", critical: true }
`,
    );
    const result = await cairn([
      "pass.yml",
      "--mock",
      "--json",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-8"),
    ]).done;
    expect(result.code).toBe(8);
    expect(result.stderr).toContain("exit 8: critical teardown failed");
    // The document is printed after the verdict and agrees with the exit.
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "errored",
      exitCode: 8,
      failure: { phase: "invocation" },
      invocationOutcome: { exitCode: 8, specsExitCode: 0 },
    });
  }, 60_000);

  it("exit 9: a project browser that outlived the run is reported, never killed", async () => {
    const pidFile = join(dir, "survivor.pid");
    // A daemon of a cairn run session (its pid file in agent-browser's state
    // directory) left working inside the project.
    const stateDir = join(homedir(), ".agent-browser");
    await writeFile(
      join(dir, "spawns.yml"),
      `version: 1
name: cli_spawns
intent: A run that leaves a browser-looking process of this project behind.
coldStart: guest
preconditions:
  commands:
    - name: leave_survivor
      run: cd "${dir}"; nohup "${process.execPath}" -e "setTimeout(() => {}, 60000)" ms-playwright-fake-browser >/dev/null 2>&1 & echo $! > "${pidFile}"; mkdir -p "${stateDir}"; cp "${pidFile}" "${join(stateDir, "cairntrace-424242.pid")}"
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const config = await writeConfig(
      "exit9",
      `run:
  verifyClean: [browsers]
`,
    );
    const result = await cairn([
      "spawns.yml",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-9"),
    ]).done;
    const survivor = Number((await readFile(pidFile, "utf8")).trim());
    try {
      expect(result.code).toBe(9);
      expect(result.stderr).toContain(
        "exit 9: state is not clean after the run",
      );
      expect(result.stderr).toContain(`pid ${survivor}`);
      // Reported, not killed.
      expect(() => process.kill(survivor, 0)).not.toThrow();
    } finally {
      try {
        process.kill(survivor, "SIGKILL");
      } catch {
        // already gone
      }
      await rm(join(stateDir, "cairntrace-424242.pid"), { force: true });
    }
  }, 60_000);

  it("the same survivor refuses the next run before it starts (exit 4)", async () => {
    const survivor = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", "ms-playwright-fake-browser"],
      { cwd: dir, stdio: "ignore" },
    );
    spawned.push(survivor);
    const stateDir = join(homedir(), ".agent-browser");
    await mkdir(stateDir, { recursive: true });
    const pidFile = join(stateDir, "cairntrace-424243.pid");
    await writeFile(pidFile, `${survivor.pid}\n`);
    onTeardown(() => rm(pidFile, { force: true }));
    const config = await writeConfig(
      "exit4-dirty",
      `run:
  verifyClean: [browsers]
`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await cairn([
      "pass.yml",
      "--mock",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-4d"),
    ]).done;
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("not clean before the run");
    expect(result.stderr).toContain(`pid ${survivor.pid}`);
  }, 60_000);
});

describe("cairn run --bail", () => {
  it("skips the rest after the first failure and exits with its code", async () => {
    const config = await writeConfig("bail", "");
    const result = await cairn([
      "fail.yml",
      "pass.yml",
      "pass2.yml",
      "--mock",
      "--bail",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-bail"),
    ]).done;
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("2 skipped (bailed)");
    expect(result.stdout).toContain("Skipped (--bail):");
    const json = await cairn([
      "fail.yml",
      "pass.yml",
      "pass2.yml",
      "--mock",
      "--bail",
      "--json",
      "--config",
      config,
      "--artifact-root",
      join(dir, "runs-bail"),
    ]).done;
    const batch = JSON.parse(json.stdout);
    expect(batch.summary).toMatchObject({ total: 1, failed: 1, skipped: 2 });
    expect(batch.skipped.map((s: { reason: string }) => s.reason)).toEqual([
      "bailed",
      "bailed",
    ]);
    expect(batch.exitCode).toBe(1);
  }, 60_000);
});

describe("cairn doctor --orphans (the real binary)", () => {
  it("lists a ledger survivor, refuses --kill without --yes, and ends it with --yes", async () => {
    const survivor = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", "ms-playwright-fake-browser"],
      { stdio: "ignore" },
    );
    spawned.push(survivor);
    // An owner that is gone.
    const owner = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => owner.once("exit", () => resolve()));
    const entry = recordLedgerSession({
      session: "cairntrace-e2e-orphan",
      backend: "playwright",
      invocationId: "2026-01-01T00-00-00-000Z_1_abcdef",
      projectDir: dir,
      pid: owner.pid!,
    });
    entry.setPids([survivor.pid!]);
    const doctor = (args: string[]): Promise<Finished> => {
      const argv = [BIN, "doctor", "--orphans", ...args];
      const child = spawn("bun", argv, {
        cwd: dir,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
    };
    try {
      const listed = await doctor(["--json"]);
      expect(listed.code).toBe(1);
      const parsed = JSON.parse(listed.stdout);
      expect(parsed).toMatchObject({
        $schema: "urn:cairntrace.dev:doctor-orphans:v1",
        ok: false,
        exitCode: 1,
      });
      expect(
        parsed.orphans[0].processes.map((p: { pid: number }) => p.pid),
      ).toContain(survivor.pid);
      const refused = await doctor(["--kill", "--json"]);
      expect(refused.code).toBe(2);
      expect(JSON.parse(refused.stdout).error).toContain("--yes");
      expect(alive(survivor.pid!)).toBe(true);
      const killed = await doctor(["--kill", "--yes", "--json"]);
      expect(killed.code).toBe(0);
      await until(() => !alive(survivor.pid!), 5_000);
      const again = await doctor(["--json"]);
      expect(again.code).toBe(0);
    } finally {
      entry.remove();
    }
  }, 60_000);
});
