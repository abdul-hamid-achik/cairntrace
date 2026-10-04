import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { RunEvent } from "../../core/schema/events.v1";
import { RunEventSchema } from "../../core/schema/events.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import { RunResultSchema } from "../../core/schema/run.v1";
import { acquireRunLock, runLockLabel } from "../../core/runPolicy/lock";
import type { ProcessProbe } from "../../core/runPolicy/processProbe";
import { canonicalConfigPath } from "../../core/runner/services";
import {
  executeRunInvocation,
  startRunInvocation,
  type RunInvocationResult,
} from "./executeRunInvocation";
import type { RunPolicyDeps } from "./runPolicy";
import type { CommandRunner } from "../../core/runPolicy/cleanliness";

/**
 * The run engine's enforcement of the config `run:` block and `--bail`:
 * lock, preflight, verifyClean, finally, critical teardown (exit 8 > 9) and
 * skipped-after-bail — all against the mock backend, stub commands and a
 * temp dir (never a real stack).
 */

let dir: string;
let lockRoot: string;
let ledgerRoot: string;
let counter = 0;

const PASSING = `version: 1
name: policy_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;
const FAILING = PASSING.replace("policy_pass", "policy_fail").replace(
  'matches: "/home"',
  'matches: "/never"',
);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-run-policy-"));
  await writeFile(join(dir, "pass.yml"), PASSING);
  await writeFile(
    join(dir, "pass2.yml"),
    PASSING.replace("policy_pass", "policy_pass2"),
  );
  await writeFile(join(dir, "fail.yml"), FAILING);
  // Parses to an error: an errored run, exit 2.
  await writeFile(join(dir, "broken.yml"), "version: 1\nname: policy_broken\n");
  await writeFile(
    join(dir, "fail2.yml"),
    FAILING.replace("policy_fail", "policy_fail2"),
  );
  await writeFile(
    join(dir, "posture.json"),
    JSON.stringify({ engine: { mode: "durable", workers: 2 } }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  lockRoot = join(dir, `locks-${++counter}`);
  ledgerRoot = join(dir, `ledger-${counter}`);
  vi.stubEnv("CAIRN_VERIFY_CLEAN_GRACE_MS", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function config(name: string, body: string): Promise<string> {
  const path = join(dir, `${name}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: policy-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${body}`,
  );
  return path;
}

async function run(
  configPath: string,
  specs: string[],
  options: Record<string, unknown> = {},
  deps: Partial<RunPolicyDeps> = {},
  callerEnv?: Record<string, string | undefined>,
): Promise<RunInvocationResult> {
  return executeRunInvocation(
    {
      specs: specs.map((spec) => join(dir, spec)),
      options: {
        mock: true,
        config: configPath,
        artifactRoot: join(dir, `runs-${counter}`),
        noWebServer: true,
        ...options,
      },
      cwd: dir,
      ...(callerEnv ? { callerEnv } : {}),
    },
    { origin: "cli", runPolicyDeps: { lockRoot, ledgerRoot, ...deps } },
  );
}

async function events(result: RunInvocationResult): Promise<RunEvent[]> {
  const text = await readFile(
    join(result.journalDir!, "events.ndjson"),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

const types = (all: RunEvent[]): string[] => all.map((event) => event.type);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lines(path: string): Promise<string[]> {
  return existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter(Boolean)
    : [];
}

const lockFiles = (): string[] =>
  existsSync(lockRoot)
    ? readdirSync(lockRoot).filter((name) => name.endsWith(".run.lock.json"))
    : [];

async function summary(result: RunInvocationResult) {
  const journal = JSON.parse(
    await readFile(join(result.journalDir!, "invocation.json"), "utf8"),
  ) as { summary: Record<string, unknown>; status: string };
  return journal;
}

describe("run.lock", () => {
  it("takes the lock before anything starts and releases it before the journal settles", async () => {
    const cfg = await config("lock-basic", "run:\n  lock: true\n");
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(0);
    const all = await events(result);
    const lockTypes = types(all).filter(
      (t) => t.startsWith("run.lock.") || t.startsWith("invocation."),
    );
    expect(lockTypes).toEqual([
      "invocation.started",
      "run.lock.acquired",
      "run.lock.released",
      "invocation.finished",
    ]);
    for (const event of all)
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    // The lock file is gone.
    expect(existsSync(lockRoot) ? readdirSync(lockRoot) : []).toEqual([]);
    expect((await summary(result)).summary.runPolicy).toMatchObject({
      lock: { scope: "config" },
    });
  });

  it("refuses with exit 4 while a live foreign owner holds it, naming owner and age; nothing runs", async () => {
    const cfg = await config("lock-held", "run:\n  lock: true\n");
    const canonical = await canonicalConfigPath(cfg);
    const held = acquireRunLock({
      scope: "config",
      key: canonical,
      label: runLockLabel(cfg, dir),
      displayName: cfg,
      argv: ["run", "flows/other.yml"],
      cwd: dir,
      root: lockRoot,
      invocationId: "other-invocation",
      origin: "cli",
      env: "local",
    });
    try {
      const result = await run(cfg, ["pass.yml"]);
      expect(result).toMatchObject({
        kind: "errored",
        exitCode: 4,
        fatal: true,
      });
      expect(result.error).toContain("another cairn run holds the run lock");
      expect(result.error).toContain(`pid ${process.pid}`);
      expect(result.error).toContain("other-invocation");
      expect(result.error).toContain("cairn run flows/other.yml");
      expect(result.runDirs).toEqual([]);
      const all = await events(result);
      const refused = all.find((e) => e.type === "run.lock.refused");
      expect(refused).toMatchObject({ reason: "held", scope: "config" });
      // The foreign lock is untouched.
      expect(JSON.parse(await readFile(held.path, "utf8")).invocationId).toBe(
        "other-invocation",
      );
    } finally {
      held.release();
    }
  });

  it("reclaims a dead owner's lock with a warning and runs", async () => {
    const cfg = await config("lock-stale", "run:\n  lock: true\n");
    const canonical = await canonicalConfigPath(cfg);
    // An owner that is gone: a pid nothing uses, written under the fake probe.
    const gone: ProcessProbe = {
      list: () => [],
      cwd: () => undefined,
      elapsedSeconds: () => 100,
      isAlive: () => true,
      command: () => undefined,
    };
    acquireRunLock({
      scope: "config",
      key: canonical,
      label: runLockLabel(cfg, dir),
      displayName: cfg,
      argv: ["run", "x.yml"],
      cwd: dir,
      root: lockRoot,
      pid: 999_991,
      probe: gone,
    });
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(0);
    const all = await events(result);
    expect(types(all).filter((t) => t.startsWith("run.lock."))).toEqual([
      "run.lock.reclaimed",
      "run.lock.acquired",
      "run.lock.released",
    ]);
    expect(all.find((e) => e.type === "run.lock.reclaimed")).toMatchObject({
      previousOwner: { pid: 999_991, alive: false },
    });
    expect((await summary(result)).summary.runPolicy).toMatchObject({
      lock: { reclaimed: true },
    });
  });

  it("releases the lock when the run fails", async () => {
    const cfg = await config("lock-fail", "run:\n  lock: true\n");
    const result = await run(cfg, ["fail.yml"]);
    expect(result.exitCode).toBe(1);
    expect(readdirSync(lockRoot)).toEqual([]);
  });

  it("an environment can turn the lock off", async () => {
    const cfg = await config(
      "lock-env-off",
      "run:\n  lock: true\n    \n".replace("    \n", ""),
    );
    // environments.local.run.lock: false
    await writeFile(
      cfg,
      (await readFile(cfg, "utf8")).replace(
        "    baseUrl: https://demo.example.test\n",
        "    baseUrl: https://demo.example.test\n    run:\n      lock: false\n",
      ),
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(
      types(await events(result)).some((t) => t.startsWith("run.lock.")),
    ).toBe(false);
  });
});

describe("run.preflight", () => {
  it("refuses with exit 4 naming the failed check, before services start", async () => {
    const marker = join(dir, `booted-${counter}`);
    const cfg = await config(
      "preflight-fail",
      `run:
  preflight:
    - { secret: PRESENT_SECRET }
    - name: engine posture
      json: posture.json
      assert: .engine.workers >= 4
services:
  docker:
    command: "touch ${marker}"
    reuseExisting: false
`,
    );
    const result = await run(cfg, ["pass.yml"], {}, {}, undefined);
    // PRESENT_SECRET is unset in the process env: the first check fails.
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain("preflight[1] secret PRESENT_SECRET");
    expect(existsSync(marker)).toBe(false);
    const all = await events(result);
    expect(all.find((e) => e.type === "preflight.failed")).toMatchObject({
      index: 1,
      check: "secret",
    });
    expect(types(all)).not.toContain("run.lock.acquired");
  });

  it("names the second check when the first passes, and still starts nothing", async () => {
    const marker = join(dir, `booted2-${counter}`);
    vi.stubEnv("CAIRN_TEST_PREFLIGHT_SECRET", "present");
    const cfg = await config(
      "preflight-second",
      `run:
  lock: true
  preflight:
    - { secret: CAIRN_TEST_PREFLIGHT_SECRET }
    - name: engine posture
      json: posture.json
      assert: .engine.workers >= 4
services:
  docker:
    command: "touch ${marker}"
    reuseExisting: false
`,
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain('preflight[2] "engine posture" failed');
    expect(result.error).toContain(".engine.workers = 2");
    expect(existsSync(marker)).toBe(false);
    const all = await events(result);
    expect(types(all).filter((t) => t.startsWith("preflight."))).toEqual([
      "preflight.started",
      "preflight.passed",
      "preflight.failed",
    ]);
    // The lock taken for the refused run is released again.
    expect(types(all)).toContain("run.lock.released");
  });

  it("lets a run through when every check passes", async () => {
    const marker = join(dir, `booted3-${counter}`);
    const cfg = await config(
      "preflight-pass",
      `run:
  preflight:
    - { json: posture.json, assert: ".engine.mode == \\"durable\\" and .engine.workers == 2" }
    - { command: "true" }
services:
  docker:
    command: "touch ${marker}"
    reuseExisting: false
`,
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("never prints a secret value in the message or the journal", async () => {
    const leaked = `${["sk", "live"].join("_")}_${"0123456789abcdef"}`;
    vi.stubEnv("CAIRN_TEST_PREFLIGHT_TOKEN", leaked);
    const cfg = await config(
      "preflight-redact",
      `secrets:
  provider: env
  required: [CAIRN_TEST_PREFLIGHT_TOKEN]
run:
  preflight:
    - { command: "echo token=$CAIRN_TEST_PREFLIGHT_TOKEN; exit 1" }
`,
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(4);
    expect(result.error).not.toContain(leaked);
    const journalText = await readFile(
      join(result.journalDir!, "events.ndjson"),
      "utf8",
    );
    expect(journalText).not.toContain(leaked);
  });
});

/** A tmux/docker stand-in answering clean or dirty per call. */
const runner = (states: Array<"clean" | "dirty">): CommandRunner => {
  let call = 0;
  return () => {
    const state = states[Math.min(call, states.length - 1)];
    call += 1;
    return { status: state === "dirty" ? 0 : 1, stdout: "", stderr: "" };
  };
};

describe("run.verifyClean", () => {
  it("refuses to start (exit 4) when the machine is dirty before the run", async () => {
    const marker = join(dir, `booted4-${counter}`);
    const cfg = await config(
      "clean-before",
      `run:
  lock: true
  verifyClean: [{ tmux: demo-session }]
services:
  docker:
    command: "touch ${marker}"
    reuseExisting: false
`,
    );
    const result = await run(cfg, ["pass.yml"], {}, { run: runner(["dirty"]) });
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain("not clean before the run");
    expect(result.error).toContain(
      'tmux demo-session: tmux session "demo-session" exists',
    );
    expect(existsSync(marker)).toBe(false);
    expect(
      (await events(result)).find((e) => e.type === "cleanliness.dirty"),
    ).toMatchObject({ phase: "before", kind: "tmux", name: "demo-session" });
  });

  it("exit 9 when the run passed but something survived it, reporting what", async () => {
    const cfg = await config(
      "clean-after",
      `run:
  verifyClean: [{ tmux: demo-session }]
`,
    );
    const result = await run(
      cfg,
      ["pass.yml"],
      {},
      { run: runner(["clean", "dirty"]) },
    );
    expect(result.exitCode).toBe(9);
    expect(result.error).toContain("state is not clean after the run");
    expect(result.error).toContain('tmux session "demo-session" exists');
    const all = await events(result);
    expect(
      all
        .filter((e) => e.type.startsWith("cleanliness."))
        .map((e) => `${e.type}:${(e as { phase: string }).phase}`),
    ).toEqual(["cleanliness.clean:before", "cleanliness.dirty:after"]);
    const journal = await summary(result);
    expect(journal.status).toBe("errored");
    expect(journal.summary).toMatchObject({
      exitCode: 9,
      passed: 1,
      runPolicy: {
        dirty: [{ phase: "after", kind: "tmux", name: "demo-session" }],
      },
    });
  });

  it("under --reuse-services skips tmux / docker-project (the stack is not the run's) but still checks browsers", async () => {
    const cfg = await config(
      "clean-reuse",
      `run:
  verifyClean: [{ tmux: demo-session }, browsers]
`,
    );
    const idle: ProcessProbe = {
      list: () => [],
      cwd: () => undefined,
      elapsedSeconds: () => 100,
      isAlive: () => false,
      command: () => undefined,
    };
    // The tmux runner would report the session as present: never asked.
    const result = await run(
      cfg,
      ["pass.yml"],
      { reuseServices: true, noServices: true },
      { run: runner(["dirty"]), probe: idle },
    );
    const cleanliness = (await events(result)).filter((e) =>
      e.type.startsWith("cleanliness."),
    );
    expect(
      cleanliness.map((e) => `${(e as { kind: string }).kind}`),
    ).not.toContain("tmux");
    expect(cleanliness.length).toBeGreaterThan(0);
    expect(
      cleanliness.every((e) => (e as { kind: string }).kind === "browsers"),
    ).toBe(true);
  });
});

const servicesBody = (teardown: string, extra = "") => `services:
  docker:
    command: "true"
    reuseExisting: false
  teardown:
${teardown}
${extra}`;

describe("critical teardown (exit 8) and precedence", () => {
  it("a failed critical teardown entry fails an otherwise green run with exit 8", async () => {
    const cfg = await config(
      "critical-pass",
      servicesBody('    - { run: "exit 5", critical: true }'),
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(8);
    expect(result.error).toContain("critical teardown failed");
    expect(result.error).toContain("services.teardown[0] (exit 5) exit 5");
    const journal = await summary(result);
    expect(journal.summary).toMatchObject({
      exitCode: 8,
      passed: 1,
      runPolicy: {
        criticalTeardown: [{ index: 0, exitCode: 5, path: "teardown" }],
      },
    });
    const teardownFail = (await events(result)).find(
      (e) => e.type === "services.teardown.fail",
    );
    expect(teardownFail).toMatchObject({
      data: { critical: true, exitCode: 5 },
    });
  });

  it("is never masked by an earlier failing verdict (8 outranks 1)", async () => {
    const cfg = await config(
      "critical-fail",
      servicesBody('    - { run: "exit 5", critical: true }'),
    );
    const result = await run(cfg, ["fail.yml"]);
    expect(result.exitCode).toBe(8);
    expect((await summary(result)).summary).toMatchObject({
      failed: 1,
      exitCode: 8,
    });
  });

  it("8 outranks 9 when the machine is dirty too", async () => {
    const cfg = await config(
      "critical-and-dirty",
      servicesBody(
        '    - { run: "exit 5", critical: true }',
        `run:
  verifyClean: [{ tmux: demo-session }]
`,
      ),
    );
    let call = 0;
    const result = await run(
      cfg,
      ["pass.yml"],
      {},
      { run: () => ({ status: call++ === 0 ? 1 : 0, stdout: "", stderr: "" }) },
    );
    expect(result.exitCode).toBe(8);
    expect(result.error).toContain("critical teardown failed");
    expect(result.error).toContain("not clean after the run");
  });

  it("a non-critical teardown failure keeps the verdict", async () => {
    const cfg = await config("plain-teardown", servicesBody('    - "exit 5"'));
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(0);
  });

  it("a timed-out critical entry is exit 8", async () => {
    const cfg = await config(
      "critical-timeout",
      servicesBody('    - { run: "sleep 30", critical: true, timeout: 300ms }'),
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(8);
    expect(result.error).toContain("timed out");
  });
});

describe("run.finally", () => {
  it("runs after the teardown with CAIRN_EXIT_CODE and CAIRN_INVOCATION_DIR, and is non-fatal", async () => {
    const log = join(dir, `finally-${counter}.log`);
    const cfg = await config(
      "finally",
      `run:
  finally:
    - "echo finally-1 code=$CAIRN_EXIT_CODE dir=$(basename $CAIRN_INVOCATION_DIR) env=$CAIRN_ENV >> ${log}"
    - "exit 7"
    - "echo finally-3 >> ${log}"
services:
  docker:
    command: "true"
    reuseExisting: false
  teardown:
    - "echo teardown >> ${log}"
`,
    );
    const result = await run(cfg, ["fail.yml"]);
    // The verdict is untouched by a failing belt.
    expect(result.exitCode).toBe(1);
    const written = (await readFile(log, "utf8")).trim().split("\n");
    expect(written[0]).toBe("teardown");
    expect(written[1]).toMatch(/^finally-1 code=1 dir=\S+ env=local$/);
    expect(written[1]).toContain(`dir=${result.invocationId}`);
    expect(written[2]).toBe("finally-3");
    const all = await events(result);
    expect(
      all
        .filter((e) => e.type.startsWith("finally."))
        .map((e) => `${e.type}:${(e as { index: number }).index}`),
    ).toEqual([
      "finally.started:1",
      "finally.finished:1",
      "finally.started:2",
      "finally.finished:2",
      "finally.started:3",
      "finally.finished:3",
    ]);
    expect(
      all.find(
        (e) =>
          e.type === "finally.finished" && (e as { index: number }).index === 2,
      ),
    ).toMatchObject({ exitCode: 7 });
    expect((await summary(result)).summary.runPolicy).toMatchObject({
      finallyFailed: 1,
    });
  });

  it("sees exit 8 when a critical teardown failed", async () => {
    const log = join(dir, `finally8-${counter}.log`);
    const cfg = await config(
      "finally-8",
      `run:
  finally:
    - "echo code=$CAIRN_EXIT_CODE >> ${log}"
services:
  docker:
    command: "true"
    reuseExisting: false
  teardown:
    - { run: "exit 2", critical: true }
`,
    );
    const result = await run(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(8);
    expect((await readFile(log, "utf8")).trim()).toBe("code=8");
  });

  it("does not receive the parent's vault controls or secrets outside the scoped env", async () => {
    const log = join(dir, `finally-env-${counter}.log`);
    vi.stubEnv("TVAULT_PASSPHRASE", "should-not-leak");
    const cfg = await config(
      "finally-env",
      `run:
  finally:
    - "echo [$TVAULT_PASSPHRASE] >> ${log}"
`,
    );
    await run(cfg, ["pass.yml"]);
    expect((await readFile(log, "utf8")).trim()).toBe("[]");
  });
});

describe("--bail", () => {
  it("stops scheduling after the first failure and reports the rest as skipped (bailed)", async () => {
    const cfg = await config("bail", "");
    const result = await run(
      cfg,
      ["pass.yml", "fail.yml", "pass2.yml", "fail2.yml"],
      {
        bail: true,
      },
    );
    expect(result.kind).toBe("batch");
    expect(result.exitCode).toBe(1);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.spec.name)).toEqual([
      "policy_pass",
      "policy_fail",
    ]);
    expect(batch.summary).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 2,
    });
    expect(batch.skipped).toEqual([
      {
        spec: join(dir, "pass2.yml"),
        reason: "bailed",
        bailedBy: join(dir, "fail.yml"),
      },
      {
        spec: join(dir, "fail2.yml"),
        reason: "bailed",
        bailedBy: join(dir, "fail.yml"),
      },
    ]);
    const all = await events(result);
    expect(all.find((e) => e.type === "invocation.bailed")).toMatchObject({
      exitCode: 1,
      skipped: 2,
    });
    expect((await summary(result)).summary).toMatchObject({
      skipped: 2,
      exitCode: 1,
    });
  });

  it("without --bail every spec runs", async () => {
    const cfg = await config("nobail", "");
    const result = await run(cfg, ["fail.yml", "pass.yml", "fail2.yml"]);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results).toHaveLength(3);
    expect(batch.skipped).toBeUndefined();
  });

  it("the exit code is the first failure's when nothing else ran", async () => {
    const cfg = await config("bail-first", "");
    // broken.yml errors (exit 2) first; fail.yml (exit 1) never starts.
    const result = await run(cfg, ["broken.yml", "fail.yml"], { bail: true });
    expect(result.exitCode).toBe(2);
    expect(BatchRunResultSchema.parse(result.document).skipped).toHaveLength(1);
  });

  it("follows the usual precedence over the specs that ran (never lower than without --bail)", async () => {
    const cfg = await config("bail-precedence", "");
    // Under --parallel 2 both start: broken.yml errors (2) while fail.yml
    // fails (1); pass.yml is skipped. Without --bail the batch is exit 1.
    const result = await run(cfg, ["broken.yml", "fail.yml", "pass.yml"], {
      bail: true,
      parallel: 2,
    });
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results.map((r) => r.status).toSorted()).toEqual([
      "errored",
      "failed",
    ]);
    expect(result.exitCode).toBe(1);
    expect(batch.exitCode).toBe(1);
    expect(batch.skipped).toHaveLength(1);
  });

  it("a green batch is untouched by --bail", async () => {
    const cfg = await config("bail-green", "");
    const result = await run(cfg, ["pass.yml", "pass2.yml"], { bail: true });
    expect(result.exitCode).toBe(0);
    const batch = BatchRunResultSchema.parse(result.document);
    expect(batch.results).toHaveLength(2);
    expect(batch.skipped).toBeUndefined();
  });

  it("under --parallel, running specs finish and the rest are skipped", async () => {
    const cfg = await config("bail-parallel", "");
    const result = await run(
      cfg,
      ["fail.yml", "pass.yml", "pass2.yml", "fail2.yml", "pass.yml"],
      { bail: true, parallel: 2 },
    );
    const batch = BatchRunResultSchema.parse(result.document);
    expect(result.exitCode).toBe(1);
    expect(batch.results.length + (batch.skipped?.length ?? 0)).toBe(5);
    expect(batch.results.map((r) => r.status)).toContain("failed");
  });

  it("with --repeat the following iterations do not start", async () => {
    const cfg = await config("bail-repeat", "");
    const result = await run(cfg, ["fail.yml"], { bail: true, repeat: 3 });
    expect(result.exitCode).toBe(1);
    expect(result.runDirs).toHaveLength(1);
  });
});

describe("documents agree with the settled exit code (held until the verdict)", () => {
  async function runCapturing(
    configPath: string,
    specs: string[],
    options: Record<string, unknown> = {},
    deps: Partial<RunPolicyDeps> = {},
  ) {
    const printed: Array<{ document: unknown; kind: string }> = [];
    const result = await executeRunInvocation(
      {
        specs: specs.map((spec) => join(dir, spec)),
        options: {
          mock: true,
          config: configPath,
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
          ...options,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        runPolicyDeps: { lockRoot, ledgerRoot, ...deps },
        onDocument: (document, meta) => {
          printed.push({
            document: JSON.parse(JSON.stringify(document)),
            kind: meta.kind,
          });
        },
      },
    );
    return { result, printed };
  }

  it("a single run that passed but left the machine dirty prints exit 9, status errored, invocationOutcome", async () => {
    const cfg = await config(
      "held-dirty",
      `run:
  verifyClean: [{ tmux: demo-session }]
`,
    );
    const { result, printed } = await runCapturing(
      cfg,
      ["pass.yml"],
      {},
      { run: runner(["clean", "dirty"]) },
    );
    expect(result.exitCode).toBe(9);
    expect(printed).toHaveLength(1);
    const doc = RunResultSchema.parse(printed[0]!.document);
    expect(doc).toMatchObject({
      exitCode: 9,
      status: "errored",
      failure: { phase: "invocation" },
      invocationOutcome: {
        exitCode: 9,
        specsExitCode: 0,
        runPolicy: {
          dirty: [{ phase: "after", kind: "tmux", name: "demo-session" }],
        },
      },
    });
    expect(doc.invocationOutcome?.error).toContain("not clean after the run");
    expect(result.document).toEqual(printed[0]!.document);
    // run.json in the run directory still records what the spec did.
    const onDisk = JSON.parse(
      await readFile(join(doc.runDir, "run.json"), "utf8"),
    ) as { status: string; exitCode: number };
    expect(onDisk).toMatchObject({ status: "passed", exitCode: 0 });
  });

  it("a batch with a failed critical teardown prints exit 8; results keep each spec's status", async () => {
    const cfg = await config(
      "held-critical",
      servicesBody('    - { run: "exit 5", critical: true }'),
    );
    const { result, printed } = await runCapturing(cfg, [
      "pass.yml",
      "pass2.yml",
    ]);
    expect(result.exitCode).toBe(8);
    const batch = BatchRunResultSchema.parse(printed[0]!.document);
    expect(batch.exitCode).toBe(8);
    expect(batch.results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(batch.invocationOutcome).toMatchObject({
      exitCode: 8,
      specsExitCode: 0,
      runPolicy: { criticalTeardown: [{ index: 0, exitCode: 5 }] },
    });
  });

  it("without a run: policy or a critical teardown nothing is held or added", async () => {
    const cfg = await config("not-held", "");
    const { result, printed } = await runCapturing(cfg, ["pass.yml"]);
    expect(result.exitCode).toBe(0);
    expect(
      (printed[0]!.document as { invocationOutcome?: unknown })
        .invocationOutcome,
    ).toBeUndefined();
  });

  it("a failed suite before hook does not mask a failed critical teardown (8 outranks 2)", async () => {
    const cfg = await config(
      "before-critical",
      `${servicesBody('    - { run: "exit 5", critical: true }')}
suites:
  s:
    specs: [pass.yml]
    before: ["exit 3"]
`,
    );
    const result = await run(cfg, [], { suite: "s" });
    expect(result.exitCode).toBe(8);
    expect(result.error).toContain("suite s before hook #1 failed");
    expect(result.error).toContain("critical teardown failed");
  });
});

describe("the signal path (SIGINT / SIGTERM)", () => {
  it("kills running commands, runs the suite's after hooks and run.finally (bounded), then releases the lock", async () => {
    const marks = join(dir, `signal-marks-${counter}.txt`);
    const started = join(dir, `signal-started-${counter}.txt`);
    const specName = `sleepy-${counter}.yml`;
    await writeFile(
      join(dir, specName),
      PASSING.replace(
        "name: policy_pass",
        `name: policy_sleepy
preconditions:
  commands:
    - run: 'sleep 30 & echo $! > "${started}"; wait'`,
      ),
    );
    const cfg = await config(
      "signal-path",
      `run:
  lock: true
  finally:
    - 'echo "finally exit=$CAIRN_EXIT_CODE" >> "${marks}"'
suites:
  sig:
    specs: [${specName}]
    after: ['echo "after exit=$CAIRN_EXIT_CODE suite=$CAIRN_SUITE" >> "${marks}"']
`,
    );
    const handle = startRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          suite: "sig",
          config: cfg,
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: dir,
      },
      { origin: "cli", runPolicyDeps: { lockRoot, ledgerRoot } },
    );
    const deadline = Date.now() + 20_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let sleeper = 0;
    while (!sleeper && Date.now() < deadline) {
      sleeper = Number((await readFile(started, "utf8")).trim());
      if (!sleeper) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect({ sleeper, alive: alive(sleeper) }).toMatchObject({ alive: true });
    expect(lockFiles()).toHaveLength(1);

    handle.terminateSync("SIGTERM");

    // Synchronously: after hooks (services still up), then finally, with
    // the code cairn exits with; the precondition is gone; the lock too.
    expect(await lines(marks)).toEqual([
      "after exit=143 suite=sig",
      "finally exit=143",
    ]);
    expect(lockFiles()).toEqual([]);
    const gone = Date.now() + 5_000;
    while (alive(sleeper) && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive(sleeper)).toBe(false);

    // The engine winds down without running them a second time.
    await handle.result;
    expect(await lines(marks)).toHaveLength(2);
  }, 30_000);

  /** Wait for a pid a precondition wrote, alive. */
  async function startedPid(file: string): Promise<number> {
    const deadline = Date.now() + 20_000;
    let pid = 0;
    while (!pid && Date.now() < deadline) {
      pid = existsSync(file)
        ? Number((await readFile(file, "utf8")).trim())
        : 0;
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect({ pid, alive: alive(pid) }).toMatchObject({ alive: true });
    return pid;
  }

  it("after hooks that spend their budget cost neither the critical teardown nor run.finally; one notice says so first", async () => {
    vi.stubEnv("CAIRN_SIGNAL_HOOK_TIMEOUT_MS", "300");
    const marks = join(dir, `budget-marks-${counter}.txt`);
    const started = join(dir, `budget-started-${counter}.txt`);
    const specName = `budget-sleepy-${counter}.yml`;
    await writeFile(
      join(dir, specName),
      PASSING.replace(
        "name: policy_pass",
        `name: policy_budget
preconditions:
  commands:
    - run: 'sleep 30 & echo $! > "${started}"; wait'`,
      ),
    );
    const cfg = await config(
      "signal-budget",
      `run:
  lock: true
  finally:
    - 'echo finally >> "${marks}"'
${servicesBody(`    - { run: 'echo down >> "${marks}"', critical: true }`)}
suites:
  sig:
    specs: [${specName}]
    after:
      - 'echo after1 >> "${marks}"; sleep 2'
      - 'echo after2 >> "${marks}"; sleep 2'
      - 'echo after3 >> "${marks}"; sleep 2'
      - 'echo after4 >> "${marks}"; sleep 2'
      - 'echo after5 >> "${marks}"; sleep 2'
`,
    );
    const warnings: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        warnings.push(message);
      },
      error: () => undefined,
      raw: () => undefined,
      scope: () => logger,
    };
    const handle = startRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          suite: "sig",
          config: cfg,
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: dir,
      },
      { origin: "cli", logger, runPolicyDeps: { lockRoot, ledgerRoot } },
    );
    await startedPid(started);

    handle.terminateSync("SIGINT");

    const marked = await lines(marks);
    // The after hooks share 3 x 300ms: some of the five never ran ...
    const after = marked.filter((line) => line.startsWith("after"));
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(5);
    // ... and the critical teardown and run.finally still did, in order.
    expect(marked.slice(after.length)).toEqual(["down", "finally"]);
    expect(lockFiles()).toEqual([]);
    const notices = warnings.filter((w) => w.startsWith("cleanup in progress"));
    expect(notices).toEqual([
      "cleanup in progress (critical teardown pending); further Ctrl-C is ignored until it ends, send SIGKILL to force",
    ]);
    // The notice comes before the first after hook's narration.
    expect(warnings.indexOf(notices[0]!)).toBeLessThan(
      warnings.findIndex((w) => w.includes("after #1")),
    );
    await handle.result;
  }, 30_000);

  it("hands over the documents of the iterations that finished (exit 130 in invocationOutcome), synchronously", async () => {
    const gate = join(dir, `held-gate-${counter}`);
    const started = join(dir, `held-started-${counter}.txt`);
    const specName = `held-sleepy-${counter}.yml`;
    // Iteration 1 passes at once; iteration 2 hangs in its precondition.
    await writeFile(
      join(dir, specName),
      PASSING.replace(
        "name: policy_pass",
        `name: policy_held
preconditions:
  commands:
    - run: 'if [ -f "${gate}" ]; then sleep 30 & echo $! > "${started}"; wait; else touch "${gate}"; fi'`,
      ),
    );
    const cfg = await config("signal-held", "run:\n  lock: true\n");
    const synced: Array<{ document: unknown; kind: string }> = [];
    const awaited: unknown[] = [];
    const handle = startRunInvocation(
      {
        specs: [join(dir, specName)],
        options: {
          mock: true,
          config: cfg,
          repeat: 3,
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        runPolicyDeps: { lockRoot, ledgerRoot },
        onDocument: (document) => {
          awaited.push(document);
        },
        onDocumentSync: (document, meta) => {
          synced.push({
            document: JSON.parse(JSON.stringify(document)),
            kind: meta.kind,
          });
        },
      },
    );
    await startedPid(started);
    // Held: nothing printed while the verdict is open.
    expect(awaited).toEqual([]);

    handle.terminateSync("SIGINT");

    expect(synced).toHaveLength(1);
    const [first] = synced;
    expect(first!.kind).toBe("single");
    expect(RunResultSchema.safeParse(first!.document).success).toBe(true);
    expect(first!.document).toMatchObject({
      status: "passed",
      exitCode: 0,
      invocationOutcome: {
        exitCode: 130,
        specsExitCode: 0,
        error: expect.stringContaining("interrupted by SIGINT"),
      },
    });
    // A host that outlives the signal settles the rest as usual, but never
    // hands the flushed document over a second time.
    await handle.result;
    const firstRunId = (first!.document as { runId: string }).runId;
    expect(
      awaited.map((document) => (document as { runId: string }).runId),
    ).not.toContain(firstRunId);
  }, 30_000);
});

describe("a run: policy guards one config at a time", () => {
  async function twoProjects(bodies: [string, string]): Promise<string[]> {
    const specs: string[] = [];
    for (const [i, body] of bodies.entries()) {
      const root = join(dir, `multi-${counter}-${i}`);
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "cairntrace.config.yml"),
        `version: 1
project: multi-${i}
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${body}`,
      );
      await writeFile(join(root, "pass.yml"), PASSING);
      specs.push(join(root, "pass.yml"));
    }
    return specs;
  }

  async function runMany(
    specs: string[],
    options: Record<string, unknown> = {},
  ): Promise<RunInvocationResult> {
    return executeRunInvocation(
      {
        specs,
        options: {
          mock: true,
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
          ...options,
        },
        cwd: dir,
      },
      { origin: "cli", runPolicyDeps: { lockRoot, ledgerRoot } },
    );
  }

  it("refuses (exit 4) specs from two configs when either declares run:, whichever comes first", async () => {
    const [guarded, plain] = await twoProjects(["run:\n  lock: true\n", ""]);
    for (const order of [
      [guarded!, plain!],
      [plain!, guarded!],
    ]) {
      const result = await runMany(order);
      expect(result.exitCode).toBe(4);
      expect(result.error).toContain("come from 2 configs");
      // Each config with the spec that resolves to it.
      expect(result.error).toContain(
        `${join(dirname(guarded!), "cairntrace.config.yml")}: pass.yml`,
      );
      expect(result.error).toContain(
        "run each config's specs in an invocation of their own, or pass --config <path>",
      );
      expect(result.error).not.toContain("--suite");
      expect(result.runDirs).toEqual([]);
    }
  });

  it("a suite reaching into a directory with its own config is refused with a remedy that works", async () => {
    const root = join(dir, `nested-${counter}`);
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(
      join(root, "cairntrace.config.yml"),
      `version: 1
project: nested
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
run:
  lock: true
suites:
  s:
    specs: [a.yml, sub/b.yml]
`,
    );
    await writeFile(
      join(root, "sub", "cairntrace.config.yml"),
      `version: 1
project: nested-sub
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
`,
    );
    await writeFile(join(root, "a.yml"), PASSING);
    await writeFile(
      join(root, "sub", "b.yml"),
      PASSING.replace("name: policy_pass", "name: policy_sub"),
    );
    const refused = await executeRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          suite: "s",
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: root,
      },
      { origin: "cli", runPolicyDeps: { lockRoot, ledgerRoot } },
    );
    expect(refused.exitCode).toBe(4);
    expect(refused.error).toContain(
      `${join(root, "sub", "cairntrace.config.yml")}: b.yml`,
    );
    expect(refused.error).not.toContain("--suite");
    // The remedy it names: --config runs every spec under one config.
    const result = await executeRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          suite: "s",
          config: join(root, "cairntrace.config.yml"),
          artifactRoot: join(dir, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: root,
      },
      { origin: "cli", runPolicyDeps: { lockRoot, ledgerRoot } },
    );
    expect(result.exitCode).toBe(0);
  });

  it("runs specs from two configs that declare no run: policy", async () => {
    const specs = await twoProjects(["", ""]);
    const result = await runMany(specs);
    expect(result.exitCode).toBe(0);
  });

  it("refuses (exit 4) specs from two configs when either pins runtimes.node", async () => {
    const specs = await twoProjects([
      'runtimes: { node: { version: ">=18" } }\n',
      "",
    ]);
    const result = await runMany(specs);
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain("runtimes.node");
    expect(result.error).toContain(
      "run each config's specs in an invocation of their own",
    );
    expect(result.error).not.toContain("--suite");
  });

  it("refuses when the config's environments give the specs different policies", async () => {
    const root = join(dir, `envs-${counter}`);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
  staging:
    baseUrl: https://demo.example.test
    run: { lock: false }
run:
  lock: true
`,
    );
    await writeFile(join(root, "a.yml"), PASSING);
    await writeFile(
      join(root, "b.yml"),
      PASSING.replace(
        "name: policy_pass",
        "name: policy_b\nenvironment: staging",
      ),
    );
    const result = await runMany([join(root, "a.yml"), join(root, "b.yml")]);
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain("different run: policies");
    // One environment at a time is fine.
    const one = await runMany([join(root, "a.yml"), join(root, "b.yml")], {
      env: "local",
    });
    expect(one.exitCode).toBe(0);
  });

  it("a spec that cannot even be read errors on its own; the policy still applies", async () => {
    const cfg = await config("unreadable-spec", "run:\n  lock: true\n");
    await writeFile(join(dir, "garbled.yml"), "version: 1\nname: [unclosed\n");
    const result = await run(cfg, ["pass.yml", "garbled.yml"]);
    expect(result.exitCode).toBe(2);
    expect(
      types(await events(result)).filter((t) => t.startsWith("run.lock.")),
    ).toEqual(["run.lock.acquired", "run.lock.released"]);
  });

  it("refuses (never runs unguarded) when the policy's config does not load", async () => {
    const [guarded] = await twoProjects(["run:\n  lock: true\n", ""]);
    const configPath = join(dirname(guarded!), "cairntrace.config.yml");
    const text = await readFile(configPath, "utf8");
    // Valid until the scoped env is applied: an include that is missing.
    await writeFile(configPath, `${text}include: [gone.yml]\n`);
    const result = await runMany([guarded!]);
    expect(result.exitCode).not.toBe(0);
    expect(result.runDirs).toEqual([]);
  });
});

describe("MCP-origin invocations take the same policy", () => {
  it("runs the lock and preflight through the shared engine", async () => {
    const cfg = await config(
      "mcp",
      `run:
  lock: true
  preflight:
    - { command: "exit 3" }
`,
    );
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "pass.yml")],
        options: {
          mock: true,
          config: cfg,
          artifactRoot: join(dir, `runs-mcp-${counter}`),
          noWebServer: true,
        },
        cwd: dir,
      },
      { origin: "mcp", runPolicyDeps: { lockRoot, ledgerRoot } },
    );
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain("preflight[1] command exit 3 failed");
  });
});
