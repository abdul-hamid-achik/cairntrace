import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServicesConfigSchema } from "../schema/config.v1";
import { startServices, type ServicesEvent } from "./services";

vi.mock("./seedState", () => ({
  SeedStateStore: vi.fn().mockImplementation(() => ({
    read: vi.fn(async () => undefined),
    checkFreshness: vi.fn(() => ({
      shouldRun: true,
      reason: "no-previous-seed",
    })),
    recordRun: vi.fn(async () => undefined),
    fingerprint: vi.fn(() => "test-fp"),
  })),
}));

/**
 * `services.teardown` entries with `critical: true` (exit 8 at the engine
 * level): a failed or timed-out critical entry is recorded on the handle and
 * in its teardown events; a plain entry still never fails anything.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-critical-teardown-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function boot(
  teardown: unknown[],
  extra: {
    events?: ServicesEvent[];
    signalEvents?: ServicesEvent[];
  } = {},
) {
  const cfg = ServicesConfigSchema.parse({
    docker: { command: "true", reuseExisting: false },
    teardown,
  });
  let terminate: (() => void) | undefined;
  const handle = await startServices(cfg, {
    configDir: dir,
    project: "critical-teardown",
    coldStart: true,
    env: { PATH: process.env.PATH },
    onSpawn: (fn) => {
      terminate = fn;
    },
    ...(extra.events ? { onEvent: (e) => extra.events!.push(e) } : {}),
    ...(extra.signalEvents
      ? {
          onSignalTeardown: {
            event: (e) => extra.signalEvents!.push(e),
            output: () => undefined,
          },
        }
      : {}),
  });
  return { handle, terminate: terminate! };
}

describe("critical teardown entries (async path)", () => {
  it("records a failed critical entry and keeps running the rest", async () => {
    const events: ServicesEvent[] = [];
    const { handle } = await boot(
      [
        { run: "exit 3", critical: true },
        `touch "${join(dir, "after-critical")}"`,
        "exit 4",
      ],
      { events },
    );
    await handle.stop();
    expect(existsSync(join(dir, "after-critical"))).toBe(true);
    const failures = handle.criticalTeardownFailures?.() ?? [];
    expect(failures).toEqual([
      expect.objectContaining({
        index: 0,
        exitCode: 3,
        path: "teardown",
        command: "exit 3",
      }),
    ]);
    const fails = events.filter(
      (e) => e.phase === "teardown" && e.event === "fail",
    );
    expect(fails.map((e) => e.data?.critical)).toEqual([true, undefined]);
  });

  it("a passing critical entry and failing plain entries add no critical failure", async () => {
    const { handle } = await boot([{ run: "true", critical: true }, "exit 9"]);
    await handle.stop();
    expect(handle.criticalTeardownFailures?.() ?? []).toEqual([]);
  });

  it("kills a critical entry at its timeout and records it as timed out", async () => {
    const started = Date.now();
    const { handle } = await boot([
      { run: "sleep 30", critical: true, timeout: "300ms" },
    ]);
    await handle.stop();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(handle.criticalTeardownFailures?.()).toEqual([
      expect.objectContaining({ index: 0, timedOut: true }),
    ]);
  });

  it("applies the timeout to non-critical entries too, without failing the run", async () => {
    const { handle } = await boot([{ run: "sleep 30", timeout: "200ms" }]);
    await handle.stop();
    expect(handle.criticalTeardownFailures?.() ?? []).toEqual([]);
  });
});

describe("critical teardown entries (signal path)", () => {
  it("onSignal: wait waits for the entry's own timeout, not the short signal cap", async () => {
    vi.stubEnv("CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS", "200");
    const marker = join(dir, "waited");
    const signalEvents: ServicesEvent[] = [];
    const { handle, terminate } = await boot(
      [
        {
          run: `sleep 1; touch "${marker}"`,
          critical: true,
          onSignal: "wait",
          timeout: "10s",
        },
      ],
      { signalEvents },
    );
    terminate();
    expect(existsSync(marker)).toBe(true);
    expect(handle.criticalTeardownFailures?.() ?? []).toEqual([]);
    expect(signalEvents.at(-1)?.data).toMatchObject({
      status: "completed",
      critical: true,
    });
  });

  it("without onSignal: wait the cap applies, and a critical entry that hits it is a failure", async () => {
    vi.stubEnv("CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS", "300");
    const marker = join(dir, "never");
    const signalEvents: ServicesEvent[] = [];
    const { handle, terminate } = await boot(
      [{ run: `sleep 2; touch "${marker}"`, critical: true }],
      { signalEvents },
    );
    terminate();
    expect(existsSync(marker)).toBe(false);
    expect(handle.criticalTeardownFailures?.()).toEqual([
      expect.objectContaining({ index: 0, timedOut: true, path: "signal" }),
    ]);
    expect(signalEvents.at(-1)?.data).toMatchObject({
      status: "timed-out",
      critical: true,
    });
  });
});

describe("services.teardown schema", () => {
  it("accepts strings and the object form, and rejects unknown keys", () => {
    expect(
      ServicesConfigSchema.safeParse({
        teardown: [
          "docker compose down",
          { run: "x", critical: true, timeout: "30s", onSignal: "wait" },
        ],
      }).success,
    ).toBe(true);
    expect(
      ServicesConfigSchema.safeParse({ teardown: [{ run: "x", nope: 1 }] })
        .success,
    ).toBe(false);
    expect(
      ServicesConfigSchema.safeParse({
        teardown: [{ run: "x", onSignal: "skip" }],
      }).success,
    ).toBe(false);
    expect(
      ServicesConfigSchema.safeParse({ teardown: [{ critical: true }] })
        .success,
    ).toBe(false);
  });
});
