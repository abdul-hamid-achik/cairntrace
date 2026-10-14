import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../core/schema/run.v1";
import { runAfterHooksForResult, type CriticalHookFailure } from "./hooks";

/**
 * `--after-critical` while a spec's hook phase is in flight: the signal-path
 * hook (registered on the resource scope in the engine) runs the critical
 * commands not completed yet, synchronously, and reports a failing one.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-hooks-signal-"));
  await mkdir(join(dir, "run"), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const result = (runDir: string): RunResult =>
  ({
    runId: "run_signal",
    runDir,
    status: "passed",
    environment: "local",
    spec: { path: "flows/a.yml" },
  }) as unknown as RunResult;

describe("runAfterHooksForResult trackSignalHook", () => {
  it("registers while the phase runs, runs pending critical commands on a signal and reports failures", async () => {
    const log = join(dir, "log");
    let registered = 0;
    let untracked = 0;
    const failures: CriticalHookFailure[] = [];
    await runAfterHooksForResult(
      result(join(dir, "run")),
      {
        afterCritical: [`echo first >> "${log}"`, "exit 6"],
        hookTimeoutMs: 5_000,
        onCriticalFailure: (failure) => failures.push(failure),
        trackSignalHook: (hook) => {
          registered += 1;
          // The signal lands before any critical command completed.
          hook();
          return () => {
            untracked += 1;
          };
        },
      },
      undefined,
      {},
      undefined,
      () => undefined,
    );
    expect(registered).toBe(1);
    expect(untracked).toBe(1);
    // The signal path ran both pending commands (the async phase then ran
    // them in its own right here; a real signal ends the process instead).
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toContain(
      "first",
    );
    expect(failures.filter((f) => f.path === "signal")).toEqual([
      expect.objectContaining({ index: 1, exitCode: 6, path: "signal" }),
    ]);
  });
});
