import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunEventSchema } from "../schema/events.v1";
import { RunResultSchema } from "../schema/run.v1";
import { RUN_CANCELLED_MESSAGE, runSpec } from "./Runner";

/**
 * runSpec cancellation: an abort kills the running precondition / node
 * verifier process TREE (real children, not mocks), skips what is left and
 * still writes a consistent, errored run.json (failure.phase "cancelled").
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-run-cancel-"));
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

/** The pid a child wrote to `path` (waits until the file holds one). */
async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (/^\d+\s*$/.test(text)) return Number(text.trim());
    if (Date.now() > deadline) throw new Error(`no pid in ${path}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

async function events(runDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runSpec cancellation", () => {
  it("kills a running precondition's process tree and skips the rest", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const after = join(dir, "second-ran");
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: cancel_precondition
intent: A slow precondition is killed by a cancel.
coldStart: guest
preconditions:
  commands:
    - name: slow
      run: 'sleep 30 & echo $! > "${pidFile}"; wait'
      timeoutMs: 60000
    - name: second
      run: 'touch "${after}"'
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const controller = new AbortController();
    const backend = new MockBrowserBackend();
    const startedAt = Date.now();
    const pending = runSpec({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      signal: controller.signal,
      heartbeatIntervalMs: 0,
    });
    const grandchild = await readPid(pidFile);
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(RunResultSchema.parse(result)).toMatchObject({
      status: "errored",
      exitCode: 2,
      failure: { phase: "cancelled", name: "slow" },
      steps: [],
    });
    expect(result.failure?.message).toContain(RUN_CANCELLED_MESSAGE);
    await waitFor(() => !alive(grandchild), 5_000);
    expect(existsSync(after)).toBe(false);
    expect(backend.stepLog).toEqual([]);
    // run.json on disk is the same consistent, errored document.
    const onDisk = JSON.parse(
      await readFile(join(result.runDir, "run.json"), "utf8"),
    ) as { status: string; failure: { phase: string } };
    expect(onDisk.status).toBe("errored");
    expect(onDisk.failure.phase).toBe("cancelled");
    const stream = await events(result.runDir);
    for (const event of stream) RunEventSchema.parse(event);
    expect(stream.at(-1)).toMatchObject({
      type: "run.errored",
      phase: "cancelled",
      name: "slow",
    });
  }, 30_000);

  it("kills a node script verifier and reports the remaining outcomes skipped", async () => {
    const pidFile = join(dir, "verifier.pid");
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: cancel_verifier
intent: A long node verifier is killed by a cancel.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: slow_poll
    description: polls an external system for a long time
    verify:
      script:
        runtime: node
        run: |
          const { writeFileSync } = await import("node:fs");
          const { spawn } = await import("node:child_process");
          const child = spawn("sleep", ["30"], { stdio: "ignore" });
          writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
          await new Promise((r) => setTimeout(r, 30000));
          return { ok: true, evidence: {} };
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      signal: controller.signal,
      heartbeatIntervalMs: 0,
    });
    const sleeper = await readPid(pidFile);
    expect(alive(sleeper)).toBe(true);
    controller.abort();
    const result = await pending;
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result.status).toBe("errored");
    expect(result.failure).toMatchObject({
      phase: "cancelled",
      message: RUN_CANCELLED_MESSAGE,
    });
    expect(result.outcomes.map((o) => [o.id, o.status])).toEqual([
      ["slow_poll", "skipped"],
      ["home", "skipped"],
    ]);
    await waitFor(() => !alive(sleeper), 5_000);
    const stream = await events(result.runDir);
    for (const event of stream) RunEventSchema.parse(event);
    expect(
      stream
        .filter((e) => String(e.type).startsWith("outcome."))
        .map((e) => [e.type, e.outcomeId]),
    ).toEqual([
      ["outcome.started", "slow_poll"],
      ["outcome.skipped", "slow_poll"],
      ["outcome.skipped", "home"],
    ]);
    // Nothing is appended after the run settled.
    expect(stream.at(-1)?.type).toBe("run.errored");
  }, 30_000);

  it("skips the remaining steps after a cancel mid-run", async () => {
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: cancel_steps
intent: Steps after a cancel never run.
coldStart: guest
steps:
  - id: first
    open: https://demo.example.test/home
  - id: second
    open: https://demo.example.test/next
  - id: third
    open: https://demo.example.test/last
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const controller = new AbortController();
    const backend = new MockBrowserBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      signal: controller.signal,
      heartbeatIntervalMs: 0,
      listener: {
        onStepFinish: (idx) => {
          if (idx === 0) controller.abort();
        },
      },
    });
    expect(result.steps.map((s) => s.id)).toEqual(["first"]);
    expect(backend.stepLog).toHaveLength(1);
    expect(result.status).toBe("errored");
    expect(result.summary).toContain("cancelled");
    expect(result.outcomes).toEqual([
      expect.objectContaining({ id: "home", status: "skipped" }),
    ]);
  });

  it("throws before creating a run directory when already cancelled", async () => {
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: cancel_early
intent: Cancelled before it started.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSpec({
        specPath,
        backend: new MockBrowserBackend(),
        artifactRoot: join(dir, "runs"),
        signal: controller.signal,
      }),
    ).rejects.toThrow(RUN_CANCELLED_MESSAGE);
    expect(await readdir(join(dir, "runs")).catch(() => [])).toEqual([]);
  });
});
