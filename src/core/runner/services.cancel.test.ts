import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeRunInvocation } from "../../cli/invocation/executeRunInvocation";
import { ServicesCancelledError, startServices } from "./services";

// Seed freshness state normally lives under ~/.cairntrace; keep tests local.
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
 * Services boot cancellation with real child processes: an abort kills the
 * running command's whole tree, stops readiness polls at once, tears down
 * what started and rejects with ServicesCancelledError.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-services-cancel-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (/^\d+\s*$/.test(text)) return Number(text.trim());
    if (Date.now() > deadline) throw new Error(`no pid in ${path}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

describe("startServices cancellation", () => {
  it("kills a running boot command's process tree and tears down", async () => {
    const pidFile = join(dir, "sleep.pid");
    const teardownMarker = join(dir, "teardown-ran");
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = startServices(
      {
        docker: {
          command: `sleep 30 & echo $! > "${pidFile}"; wait`,
          reuseExisting: false,
          readyTimeoutMs: 120_000,
        },
        teardown: [`touch "${teardownMarker}"`],
      },
      {
        configDir: dir,
        project: "cancel-boot",
        coldStart: true,
        env: { PATH: process.env.PATH },
        signal: controller.signal,
      },
    );
    const sleeper = await readPid(pidFile);
    expect(alive(sleeper)).toBe(true);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ServicesCancelledError);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await waitDead(sleeper);
    // Failure cleanup runs the configured teardown.
    expect(existsSync(teardownMarker)).toBe(true);
  }, 30_000);

  it("stops a readiness poll at once instead of at its deadline", async () => {
    const controller = new AbortController();
    const attempts = join(dir, "attempts");
    await writeFile(attempts, "");
    const startedAt = Date.now();
    const pending = startServices(
      {
        docker: {
          command: "true",
          reuseExisting: false,
          readinessCheck: `echo x >> "${attempts}"; false`,
          readyTimeoutMs: 120_000,
        },
      },
      {
        configDir: dir,
        project: "cancel-readiness",
        coldStart: true,
        env: { PATH: process.env.PATH },
        signal: controller.signal,
      },
    );
    // Let the poll fail at least once, then cancel.
    const deadline = Date.now() + 10_000;
    while ((await readFile(attempts, "utf8")).length === 0) {
      if (Date.now() > deadline) throw new Error("readiness never polled");
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ServicesCancelledError);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 30_000);

  it("refuses to start when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = join(dir, "ran");
    await expect(
      startServices(
        { docker: { command: `touch "${marker}"`, reuseExisting: false } },
        {
          configDir: dir,
          project: "cancel-early",
          coldStart: true,
          env: { PATH: process.env.PATH },
          signal: controller.signal,
        },
      ),
    ).rejects.toBeInstanceOf(ServicesCancelledError);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("run engine: cancel during the services boot", () => {
  it("kills the boot and reports the invocation cancelled before its specs", async () => {
    const pidFile = join(dir, "boot.pid");
    const precondition = join(dir, "precondition-ran");
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: engine_services_cancel
intent: A spec behind a slow services boot.
coldStart: guest
preconditions:
  commands:
    - run: 'touch "${precondition}"'
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
artifactRoot: ${JSON.stringify(join(dir, "runs"))}
environments: {}
services:
  docker:
    command: 'sleep 30 & echo $! > "${pidFile}"; wait'
    reuseExisting: false
    readyTimeoutMs: 120000
`,
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = executeRunInvocation(
      {
        specs: [join(dir, "spec.yml")],
        options: { mock: true, noWebServer: true, coldStart: true },
        cwd: dir,
      },
      { origin: "mcp", signal: controller.signal },
    );
    const sleeper = await readPid(pidFile);
    controller.abort();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result).toMatchObject({
      kind: "errored",
      aborted: true,
      exitCode: 2,
      error: "invocation cancelled before its specs ran",
      runDirs: [],
    });
    await waitDead(sleeper);
    expect(existsSync(precondition)).toBe(false);
  }, 30_000);
});
