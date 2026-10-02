import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { executeRunInvocation } from "./executeRunInvocation";
import { LogCursorError, readLogSlice } from "./logTail";
import {
  KeyedLock,
  RegistryFullError,
  RunInvocationRegistry,
} from "./registry";

/** Let timers and promise chains settle. */
const tick = () => new Promise((resolveTick) => setTimeout(resolveTick, 20));

/** A TCP port nothing listens on (bound, then released). */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * The engine owns no process: a call leaves process.exitCode, process.env,
 * stdout and the signal handlers exactly as it found them.
 */

let dir: string;

const PASSING = `version: 1
name: engine_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const FAILING = PASSING.replace("engine_pass", "engine_fail").replace(
  'matches: "/home"',
  'matches: "/never"',
);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-engine-"));
  await writeFile(join(dir, "pass.yml"), PASSING);
  await writeFile(join(dir, "fail.yml"), FAILING);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("executeRunInvocation process hygiene", () => {
  it("never touches process.exitCode, process.env, stdout, exit or signal handlers", async () => {
    const envBefore = JSON.stringify(process.env);
    const exitCodeBefore = process.exitCode;
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      const passed = await executeRunInvocation(
        {
          specs: [join(dir, "pass.yml")],
          options: {
            mock: true,
            artifactRoot: join(dir, "runs"),
            label: ["suite=hygiene"],
            noServices: true,
            noWebServer: true,
          },
          cwd: dir,
        },
        { origin: "mcp" },
      );
      expect(passed).toMatchObject({ kind: "single", exitCode: 0 });
      expect(RunResultSchema.parse(passed.document).labels).toEqual({
        suite: "hygiene",
      });
      expect(passed.journalDir).toContain("_invocations");

      const failed = await executeRunInvocation(
        {
          specs: [join(dir, "pass.yml"), join(dir, "fail.yml")],
          options: { mock: true, artifactRoot: join(dir, "runs") },
          cwd: dir,
        },
        { origin: "mcp" },
      );
      expect(failed).toMatchObject({ kind: "batch", exitCode: 1 });
      expect(failed.runDirs).toHaveLength(2);

      const errored = await executeRunInvocation(
        { specs: [join(dir, "pass.yml")], options: { repeat: 0 } },
        { origin: "mcp" },
      );
      expect(errored).toMatchObject({
        kind: "errored",
        fatal: true,
        exitCode: 2,
        error: "--repeat must be between 1 and 1000",
      });
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
    expect(exit).not.toHaveBeenCalled();
    expect(writes.filter((chunk) => chunk.includes("urn:cairntrace"))).toEqual(
      [],
    );
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(JSON.stringify(process.env)).toBe(envBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  }, 30_000);

  it("hands each iteration's document to onDocument and aggregates repeat runs", async () => {
    const seen: string[] = [];
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "pass.yml")],
        options: { mock: true, artifactRoot: join(dir, "runs"), repeat: 2 },
        cwd: dir,
      },
      {
        origin: "mcp",
        onDocument: (document, meta) => {
          seen.push(`${meta.kind}#${meta.iteration}:${document.$schema}`);
        },
      },
    );
    expect(seen).toEqual([
      "single#1:urn:cairntrace.dev:run:v1",
      "single#2:urn:cairntrace.dev:run:v1",
    ]);
    expect(result.kind).toBe("batch");
    expect(result.documents).toHaveLength(2);
    expect(result.document).toMatchObject({
      $schema: "urn:cairntrace.dev:run-batch:v1",
      summary: { total: 2, passed: 2 },
      exitCode: 0,
    });
  }, 30_000);

  it("starts nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "pass.yml")],
        options: { mock: true, artifactRoot: join(dir, "runs-aborted") },
        cwd: dir,
      },
      { origin: "mcp", signal: controller.signal },
    );
    expect(result).toMatchObject({
      kind: "errored",
      aborted: true,
      exitCode: 2,
      runDirs: [],
    });
    expect(result.journalDir).toBeUndefined();
  });

  it("returns the errored document for an unknown --env (exit 4)", async () => {
    const configDir = join(dir, "env-config");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "cairntrace.config.yml"),
      "version: 1\nenvironments:\n  local: {}\n",
    );
    await writeFile(join(configDir, "spec.yml"), PASSING);
    const result = await executeRunInvocation(
      {
        specs: [join(configDir, "spec.yml")],
        options: { env: "prod", mock: true },
      },
      { origin: "mcp" },
    );
    expect(result).toMatchObject({ kind: "errored", fatal: true, exitCode: 4 });
    expect(RunResultSchema.parse(result.document).exitCode).toBe(4);
  });
});

describe("KeyedLock", () => {
  it("serializes holders of one key in FIFO order and frees aborted waiters", async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const waits: Array<string | undefined> = [];
    const releaseA = await lock.acquire("k", "a");
    const b = lock.acquire("k", "b", { onWait: (h) => waits.push(h) });
    const controller = new AbortController();
    const c = lock.acquire("k", "c", { signal: controller.signal });
    const d = lock.acquire("k", "d");
    const other = await lock.acquire("other", "x");
    order.push("other acquired");
    other();
    controller.abort();
    await expect(c).rejects.toThrow("cancelled while waiting");
    order.push("a release");
    releaseA();
    const releaseB = await b;
    order.push("b acquired");
    releaseB();
    const releaseD = await d;
    order.push("d acquired");
    releaseD();
    expect(order).toEqual([
      "other acquired",
      "a release",
      "b acquired",
      "d acquired",
    ]);
    expect(waits).toEqual(["a"]);
    expect(lock.holder("k")).toBeUndefined();
  });

  it("keeps later waiters queued behind the holder when the last waiter aborts", async () => {
    const lock = new KeyedLock();
    const releaseA = await lock.acquire("k", "a");
    const controller = new AbortController();
    const b = lock.acquire("k", "b", { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(b).rejects.toThrow("cancelled while waiting");
    let cAcquired = false;
    const c = lock.acquire("k", "c").then((release) => {
      cAcquired = true;
      return release;
    });
    await tick();
    // The aborted waiter was the newest link: c must still wait for a.
    expect(cAcquired).toBe(false);
    expect(lock.holder("k")).toBe("a");
    releaseA();
    const releaseC = await c;
    expect(lock.holder("k")).toBe("c");
    releaseC();
    await tick();
    // The chain is gone once it settled: the next acquire is immediate.
    let dAcquired = false;
    const d = lock.acquire("k", "d").then((release) => {
      dAcquired = true;
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(dAcquired).toBe(true);
    (await d)();
  });
});

describe("graceful cancel", () => {
  it("kills a running --before hook and never starts the spec", async () => {
    const cancelDir = await mkdtemp(join(tmpdir(), "cairn-engine-cancel-"));
    const marker = join(cancelDir, "precondition-ran");
    await writeFile(
      join(cancelDir, "spec.yml"),
      PASSING.replace(
        "coldStart: guest",
        `coldStart: guest\npreconditions:\n  commands:\n    - name: mark\n      run: 'touch "${marker}"'`,
      ),
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 700);
    try {
      const result = await executeRunInvocation(
        {
          specs: [join(cancelDir, "spec.yml")],
          options: {
            mock: true,
            artifactRoot: join(cancelDir, "runs"),
            before: ["sleep 8"],
          },
          cwd: cancelDir,
        },
        { origin: "mcp", signal: controller.signal },
      );
      expect(Date.now() - startedAt).toBeLessThan(6_000);
      expect(result).toMatchObject({
        kind: "errored",
        aborted: true,
        exitCode: 2,
        error: "invocation cancelled before its specs ran",
        runDirs: [],
      });
      expect(existsSync(marker)).toBe(false);
      const journal = JSON.parse(
        await readFile(join(result.journalDir!, "invocation.json"), "utf8"),
      ) as { status: string; runs: unknown[] };
      expect(journal.status).toBe("aborted");
      expect(journal.runs).toEqual([]);
    } finally {
      await rm(cancelDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("kills a booting webServer instead of waiting for its readiness timeout", async () => {
    const cancelDir = await mkdtemp(join(tmpdir(), "cairn-engine-websrv-"));
    const port = await freePort();
    await writeFile(join(cancelDir, "spec.yml"), PASSING);
    await writeFile(
      join(cancelDir, "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://127.0.0.1:${port}
artifactRoot: ${JSON.stringify(join(cancelDir, "runs"))}
webServer:
  command: "sleep 60"
  url: http://127.0.0.1:${port}/
  readyTimeoutMs: 60000
`,
    );
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 1_000);
    try {
      const result = await executeRunInvocation(
        {
          specs: [join(cancelDir, "spec.yml")],
          options: { mock: true, noServices: true },
          cwd: cancelDir,
        },
        { origin: "mcp", signal: controller.signal },
      );
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(result).toMatchObject({
        kind: "errored",
        aborted: true,
        error: "invocation cancelled before its specs ran",
        runDirs: [],
      });
    } finally {
      await rm(cancelDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("post-run failures", () => {
  it("names a failed JUnit write in the result error", async () => {
    const blocker = join(dir, "junit-blocker");
    await writeFile(blocker, "not a directory");
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "pass.yml")],
        options: {
          mock: true,
          artifactRoot: join(dir, "runs"),
          junit: join(blocker, "report.xml"),
        },
        cwd: dir,
      },
      { origin: "mcp" },
    );
    expect(result).toMatchObject({ kind: "single", exitCode: 2 });
    expect(RunResultSchema.parse(result.document).status).toBe("passed");
    expect(result.error).toContain("could not write JUnit report");
  }, 30_000);
});

describe("RunInvocationRegistry capacity", () => {
  it("refuses to start past its maximum of running invocations", async () => {
    const registry = new RunInvocationRegistry({ maxRunning: 1 });
    const first = registry.start(
      {
        specs: [join(dir, "pass.yml")],
        options: { mock: true, artifactRoot: join(dir, "runs") },
        cwd: dir,
      },
      { origin: "mcp" },
    );
    expect(() =>
      registry.start(
        { specs: [join(dir, "pass.yml")], options: { mock: true }, cwd: dir },
        { origin: "mcp" },
      ),
    ).toThrow(RegistryFullError);
    await first.settled;
    const second = registry.start(
      {
        specs: [join(dir, "pass.yml")],
        options: { mock: true, artifactRoot: join(dir, "runs") },
        cwd: dir,
      },
      { origin: "mcp" },
    );
    await second.settled;
    expect(second.result?.exitCode).toBe(0);
  }, 30_000);
});

describe("RunInvocationRegistry", () => {
  it("tracks an invocation to settlement and treats cancel as idempotent", async () => {
    const registry = new RunInvocationRegistry();
    const entry = registry.start(
      {
        specs: [join(dir, "pass.yml")],
        options: { mock: true, artifactRoot: join(dir, "runs") },
        cwd: dir,
      },
      { origin: "mcp" },
    );
    expect(registry.get(entry.id)).toBe(entry);
    await entry.settled;
    expect(entry.result?.exitCode).toBe(0);
    expect(registry.cancel(entry.id)?.cancelRequested).toBe(false);
    expect(registry.cancel("missing")).toBeUndefined();
    await registry.shutdown();
  }, 30_000);
});

describe("readLogSlice", () => {
  it("returns whole lines while running, everything once settled, and chains offsets", async () => {
    const runDir = join(dir, "fake-run");
    await mkdir(join(runDir, "logs"), { recursive: true });
    const events = join(runDir, "events.ndjson");
    await writeFile(events, '{"n":1}\n{"n":2}\n{"n":');
    const first = await readLogSlice({
      target: "run",
      id: "fake-run",
      dir: runDir,
      log: "events",
      state: "running",
    });
    expect(first.text).toBe('{"n":1}\n{"n":2}\n');
    expect(first.eof).toBe(false);
    const torn = await readLogSlice({
      target: "run",
      id: "fake-run",
      dir: runDir,
      log: "events",
      offset: first.nextOffset,
      state: "running",
    });
    expect(torn.text).toBe("");
    expect(torn.nextOffset).toBe(first.nextOffset);
    await appendFile(events, "3}\n");
    const last = await readLogSlice({
      target: "run",
      id: "fake-run",
      dir: runDir,
      log: "events",
      offset: torn.nextOffset,
      state: "settled",
    });
    expect(last).toMatchObject({ text: '{"n":3}\n', eof: true, settled: true });

    // Multi-file selections: a header before each file's new bytes, whole
    // lines per file, chained with the per-file cursor.
    await writeFile(join(runDir, "logs", "precondition-01-a.log"), "a1\na2\n");
    await writeFile(join(runDir, "logs", "precondition-02-b.log"), "b1\n");
    let cursor: Record<string, number> | undefined;
    let text = "";
    for (let i = 0; i < 20; i++) {
      const slice = await readLogSlice({
        target: "run",
        id: "fake-run",
        dir: runDir,
        log: "precondition",
        ...(cursor ? { cursor } : {}),
        maxBytes: 8,
        state: "settled",
      });
      text += slice.text;
      cursor = slice.nextCursor;
      if (slice.eof) break;
    }
    expect(text).toBe(
      "==> logs/precondition-01-a.log <==\na1\na2\n==> logs/precondition-02-b.log <==\nb1\n",
    );
    expect(cursor).toEqual({
      "logs/precondition-01-a.log": 6,
      "logs/precondition-02-b.log": 3,
    });
    await expect(
      readLogSlice({
        target: "run",
        id: "fake-run",
        dir: runDir,
        log: "precondition",
        offset: 4,
        state: "settled",
      }),
    ).rejects.toThrow(LogCursorError);
  });

  it("never repeats or skips bytes when files appear or grow out of name order", async () => {
    const journalDir = join(dir, "fake-invocation");
    const logs = join(journalDir, "logs");
    await mkdir(logs, { recursive: true });
    const read = (cursor?: Record<string, number>) =>
      readLogSlice({
        target: "invocation",
        id: "fake-invocation",
        dir: journalDir,
        log: "hook",
        ...(cursor ? { cursor } : {}),
        state: "running",
      });
    await writeFile(join(logs, "hook-before-01.log"), "before 1\n");
    const first = await read();
    // A single file still gets its header: the stream never changes shape.
    expect(first.text).toBe("==> logs/hook-before-01.log <==\nbefore 1\n");

    // An --after hook file sorts BEFORE the before file, and the shared
    // before file keeps growing (the next --repeat iteration).
    await writeFile(join(logs, "hook-after-01-r1.log"), "after r1\n");
    await appendFile(join(logs, "hook-before-01.log"), "before 2\npartial");
    const second = await read(first.nextCursor);
    expect(second.text).toBe(
      "==> logs/hook-after-01-r1.log <==\nafter r1\n==> logs/hook-before-01.log <==\nbefore 2\n",
    );
    expect(second.eof).toBe(false); // "partial" waits for its newline

    await appendFile(join(logs, "hook-before-01.log"), " line\n");
    const third = await read(second.nextCursor);
    expect(third.text).toBe("==> logs/hook-before-01.log <==\npartial line\n");
    expect(third).toMatchObject({ eof: true, nextOffset: third.size });
    const idle = await read(third.nextCursor);
    expect(idle.text).toBe("");
  });

  it("never splits a UTF-8 character", async () => {
    const runDir = join(dir, "utf8-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.log"), "ñññ\n");
    const slice = await readLogSlice({
      target: "run",
      id: "utf8-run",
      dir: runDir,
      log: "run",
      maxBytes: 3,
      state: "settled",
    });
    expect(slice.text).toBe("ñ");
    expect(slice.nextOffset).toBe(2);
  });
});
