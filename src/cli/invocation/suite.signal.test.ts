import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CriticalSuiteHookFailure,
  runSuiteAfterHooksSync,
  runSuiteHooks,
} from "./suite";

/**
 * Suite `afterCritical` on the signal path and on a cancel: the optional
 * hooks share one bounded budget, critical cleanup never depends on it.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-suite-signal-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = () => ({
  suite: "demo",
  cwd: dir,
  env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
  journal: undefined,
  redact: (text: string) => text,
  note: () => undefined,
  timeoutMs: 5_000,
});

describe("runSuiteAfterHooksSync with the optional budget spent", () => {
  const spent = { perCommandMs: 10_000, deadline: Date.now() - 1 };

  it("skips the optional hooks but still runs every critical one on its own bound", async () => {
    const failures: CriticalSuiteHookFailure[] = [];
    const failed = runSuiteAfterHooksSync({
      ...base(),
      commands: [
        `touch "${dir}/optional"`,
        `touch "${dir}/critical-1"`,
        "exit 4",
        `touch "${dir}/critical-3"`,
      ],
      criticalFrom: 2,
      onCritical: (failure) => failures.push(failure),
      from: 1,
      budget: spent,
    });
    expect(existsSync(join(dir, "optional"))).toBe(false);
    expect(existsSync(join(dir, "critical-1"))).toBe(true);
    // A failing critical hook does not stop the next critical one.
    expect(existsSync(join(dir, "critical-3"))).toBe(true);
    expect(failures).toEqual([
      expect.objectContaining({ index: 1, command: "exit 4", exitCode: 4 }),
    ]);
    // Skipped optional + failed critical.
    expect(failed).toBe(2);
  });

  it("bounds a critical hook by the hook timeout, not the budget", () => {
    const failures: CriticalSuiteHookFailure[] = [];
    runSuiteAfterHooksSync({
      ...base(),
      timeoutMs: 300,
      commands: ["sleep 30"],
      criticalFrom: 1,
      onCritical: (failure) => failures.push(failure),
      from: 1,
      budget: spent,
    });
    expect(failures).toEqual([
      expect.objectContaining({ index: 0, timedOut: true }),
    ]);
  });
});

describe("runSuiteHooks on a cancelled invocation", () => {
  it("skips optional hooks but reaches and runs the critical ones", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSuiteHooks({
      ...base(),
      phase: "after",
      fatal: false,
      commands: [`touch "${dir}/optional"`, `echo ran > "${dir}/critical"`],
      criticalFrom: 2,
      signal: controller.signal,
    });
    expect(outcome.cancelled).toBe(true);
    expect(existsSync(join(dir, "optional"))).toBe(false);
    expect((await readFile(join(dir, "critical"), "utf8")).trim()).toBe("ran");
    expect(outcome.critical).toBeUndefined();
  });
});
