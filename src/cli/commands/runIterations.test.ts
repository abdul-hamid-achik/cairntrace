import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../core/schema/run.v1";
import {
  mergeExitCodes,
  renderIterationSummary,
  runAfterHooksForResult,
  withIterationEnv,
} from "./run";
import { parseMatrix, planIterations } from "./runMatrix";

const itPosix = process.platform === "win32" ? it.skip : it;

function fakeResult(status: "passed" | "failed", runDir: string): RunResult {
  return {
    runDir,
    runId: "run_x",
    status,
    spec: { name: "s", path: "/abs/s.yml" },
  } as unknown as RunResult;
}

describe("--after per-spec hooks (CAIRN_RUN_DIR contract)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cairntrace-after-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  itPosix(
    "runs with CAIRN_RUN_DIR and drops files into diagnostics/",
    async () => {
      const runDir = join(dir, "run1");
      await mkdir(runDir);
      await runAfterHooksForResult(fakeResult("passed", runDir), {
        after: [
          'echo \'{"rootMs": 12}\' > "$CAIRN_RUN_DIR/diagnostics/report.json"',
          'echo "$CAIRN_RUN_STATUS $CAIRN_RUN_ID $CAIRN_SPEC_PATH" > "$CAIRN_RUN_DIR/diagnostics/env.txt"',
        ],
      });
      expect(
        JSON.parse(
          await readFile(join(runDir, "diagnostics", "report.json"), "utf8"),
        ),
      ).toEqual({ rootMs: 12 });
      expect(
        (await readFile(join(runDir, "diagnostics", "env.txt"), "utf8")).trim(),
      ).toBe("passed run_x /abs/s.yml");
    },
  );

  itPosix("also runs for failed specs and never throws", async () => {
    const runDir = join(dir, "run2");
    await mkdir(runDir);
    await expect(
      runAfterHooksForResult(fakeResult("failed", runDir), {
        after: ['touch "$CAIRN_RUN_DIR/diagnostics/ran"', "exit 9"],
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(join(runDir, "diagnostics", "ran"))).toBe(true);
  });

  itPosix("exports matrix/repeat env to the hook", async () => {
    const runDir = join(dir, "run3");
    await mkdir(runDir);
    const [it1] = planIterations(2, parseMatrix("workers=4"));
    const secrets = withIterationEnv(
      {
        env: {},
        childEnv: { PATH: process.env.PATH },
        secretValues: [],
        injectedKeys: [],
        shadowedKeys: [],
      },
      it1!,
    );
    expect(secrets.env.CAIRN_MATRIX_WORKERS).toBe("4");
    await runAfterHooksForResult(
      fakeResult("passed", runDir),
      {
        after: [
          'echo "$CAIRN_MATRIX_WORKERS/$CAIRN_REPEAT" > "$CAIRN_RUN_DIR/diagnostics/m"',
        ],
      },
      secrets,
    );
    expect(
      (await readFile(join(runDir, "diagnostics", "m"), "utf8")).trim(),
    ).toBe("4/1");
  });

  it("is a no-op without hooks and skips non-existent run dirs", async () => {
    const missing = join(dir, "nope");
    await runAfterHooksForResult(fakeResult("passed", missing), {});
    await runAfterHooksForResult(fakeResult("passed", missing), {
      after: ["touch should-not-exist"],
    });
    expect(existsSync(missing)).toBe(false);
  });

  itPosix("honors --hook-timeout-ms and stays non-fatal", async () => {
    const runDir = join(dir, "run4");
    await mkdir(runDir);
    const t0 = Date.now();
    await expect(
      runAfterHooksForResult(fakeResult("passed", runDir), {
        after: ["exec sleep 5"],
        hookTimeoutMs: "100",
      }),
    ).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(4500);
  });
});

describe("--repeat/--matrix iteration helpers", () => {
  it("withIterationEnv leaves secrets untouched without repeat/matrix", () => {
    const secrets = {
      env: {},
      childEnv: {},
      secretValues: [],
      injectedKeys: [],
      shadowedKeys: [],
    };
    const [only] = planIterations(undefined, []);
    expect(withIterationEnv(secrets, only!)).toBe(secrets);
  });

  it("mergeExitCodes keeps the most severe code", () => {
    expect(mergeExitCodes(2, 0, true)).toBe(0);
    expect(mergeExitCodes(0, 1, false)).toBe(1);
    expect(mergeExitCodes(1, 0, false)).toBe(1);
    expect(mergeExitCodes(1, 2, false)).toBe(1);
    expect(mergeExitCodes(2, 1, false)).toBe(1);
    expect(mergeExitCodes(1, 6, false)).toBe(6);
  });

  it("renderIterationSummary lists every run with labels and totals", () => {
    const plan = planIterations(1, parseMatrix("m=a,b"));
    const text = renderIterationSummary(
      [
        { it: plan[0]!, exitCode: 0, results: [] },
        { it: plan[1]!, exitCode: 1, results: [] },
      ],
      4,
    );
    expect(text).toContain("2/4 run(s) executed");
    expect(text).toContain("PASS #1 repeat=1 m=a");
    expect(text).toContain("FAIL #2 repeat=1 m=b");
    expect(text).toContain("1 passed, 1 failed");
  });
});
