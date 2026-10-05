import { afterEach, describe, expect, it } from "vitest";
import { dropExitEvents } from "../../testing/lostExit";
import { runBoundedCommand } from "./boundedCommand";
import type { ExitProbe } from "./childExit";

/**
 * runBoundedCommand when the runtime loses the child's exit event (the
 * production hang: a suite `after` hook's shell exited, stayed `<defunct>`,
 * and `--hook-timeout-ms` never ended the wait). The command must settle
 * from the process table, and a deadline kill must end the wait even when
 * no exit is ever observed.
 */

const MARK = "cairn-lost-exit-probe";
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("runBoundedCommand with a lost exit event", () => {
  it("still reports a normal exit through the event", async () => {
    const result = await runBoundedCommand(
      "/bin/sh",
      ["-c", `echo ok; exit 3 # ${MARK}`],
      { cwd: process.cwd(), env, timeoutMs: 10_000, ownProcessGroup: true },
    );
    expect(result).toMatchObject({
      exitCode: 3,
      stdout: "ok",
      timedOut: false,
    });
    expect(result.exitLost).toBeUndefined();
    expect(result.abandoned).toBeUndefined();
  });

  it("settles from the process table when the exit event never arrives", async () => {
    restore = dropExitEvents(MARK);
    const started = Date.now();
    const result = await runBoundedCommand(
      "/bin/sh",
      ["-c", `echo collected; exit 0 # ${MARK}`],
      {
        cwd: process.cwd(),
        env,
        timeoutMs: 60_000,
        ownProcessGroup: true,
        exitPollMs: 20,
      },
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({
      exitLost: true,
      timedOut: false,
      cancelled: false,
      stdout: "collected",
    });
  });

  it("ends the wait at the deadline even when the killed child never reports an exit", async () => {
    restore = dropExitEvents(MARK);
    // The production case on any platform: the child is a zombie the
    // runtime never reaps, so the process table keeps showing it.
    const zombieForever: ExitProbe = {
      platform: "darwin",
      kill: () => undefined,
      readProcStat: () => "",
    };
    const started = Date.now();
    const result = await runBoundedCommand(
      "/bin/sh",
      ["-c", `sleep 30 # ${MARK}`],
      {
        cwd: process.cwd(),
        env,
        timeoutMs: 200,
        killSettleMs: 200,
        ownProcessGroup: true,
        exitPollMs: 20,
        exitProbe: zombieForever,
      },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ timedOut: true, abandoned: true });
    expect(result.exitCode).toBeUndefined();
  });

  it("ends a cancelled wait the same way", async () => {
    restore = dropExitEvents(MARK);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runBoundedCommand(
      "/bin/sh",
      ["-c", `sleep 30 # ${MARK}`],
      {
        cwd: process.cwd(),
        env,
        timeoutMs: 60_000,
        killSettleMs: 200,
        signal: controller.signal,
        ownProcessGroup: true,
        exitPollMs: 20,
        exitProbe: {
          platform: "darwin",
          kill: () => undefined,
          readProcStat: () => "",
        },
      },
    );
    expect(result).toMatchObject({ cancelled: true, abandoned: true });
  });
});
