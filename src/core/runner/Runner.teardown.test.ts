import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunEventSchema } from "../schema/events.v1";
import { RunResultSchema } from "../schema/run.v1";
import { SpecSchema } from "../schema/spec.v1";
import { runSpec } from "./Runner";
import { parseAssignedJson, resolveRunPlaceholders } from "./runStep";

/**
 * F2 `preconditions.wait` + F3a `run:` steps and spec `teardown:` against
 * real child processes and local listeners: teardown runs on pass, fail,
 * early stops, cancel and SIGTERM, and sees CAIRN_RUN_STATUS.
 */

let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-teardown-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
  await rm(dir, { recursive: true, force: true });
});

type Event = Record<string, unknown> & { type: string };

async function events(runDir: string): Promise<Event[]> {
  const stream = (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
  for (const event of stream) RunEventSchema.parse(event);
  return stream;
}

async function statusServer(statuses: number[]): Promise<string> {
  let hits = 0;
  const server = createServer((_req, res) => {
    res.statusCode = statuses[Math.min(hits, statuses.length - 1)]!;
    hits += 1;
    res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function closedPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolveListen) =>
    probe.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

async function run(spec: string, extra: { signal?: AbortSignal } = {}) {
  const specPath = join(dir, "spec.yml");
  await writeFile(specPath, spec);
  const backend = new MockBrowserBackend();
  const result = await runSpec({
    specPath,
    backend,
    artifactRoot: join(dir, "runs"),
    heartbeatIntervalMs: 0,
    ...extra,
  });
  return { result, backend };
}

const OUTCOME = `outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

describe("run step", () => {
  it("assigns the last stdout JSON line and splices ${runs.x} into later steps and teardown", async () => {
    const seen = join(dir, "teardown-saw.txt");
    const { result, backend } = await run(`version: 1
name: run_assign
intent: A run step provisions a fixture that later steps use.
coldStart: guest
steps:
  - id: provision
    run:
      shell: 'echo "progress on stderr" >&2; echo noise; echo "{\\"entity\\":{\\"id\\":\\"e-42\\"},\\"env\\":\\"$CAIRN_RUN_ID\\",\\"arg\\":\\"$1\\"}"'
      args: [first-arg]
      assign: fixture
  - open: https://demo.example.test/home/\${runs.fixture.entity.id}
teardown:
  - run:
      shell: 'printf "%s %s %s" "$CAIRN_RUN_STATUS" "$1" "$ARG2" > "${seen}"'
      args: ["\${runs.fixture.entity.id}"]
      env: { ARG2: "\${runs.fixture.arg}" }
${OUTCOME}`);
    expect(RunResultSchema.parse(result)).toMatchObject({ status: "passed" });
    expect(backend.stepLog).toEqual([
      expect.objectContaining({ open: "https://demo.example.test/home/e-42" }),
    ]);
    expect(await readFile(seen, "utf8")).toBe("passed e-42 first-arg");
    const stream = await events(result.runDir);
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "step.started",
        stepId: "provision",
        kind: "run",
        label: "run shell → fixture",
      }),
    );
    const teardown = stream.filter((e) => e.type.startsWith("teardown."));
    expect(teardown).toEqual([
      expect.objectContaining({
        type: "teardown.started",
        index: 1,
        total: 1,
        kind: "run",
        runStatus: "passed",
      }),
      expect.objectContaining({ type: "teardown.finished", status: "passed" }),
    ]);
    expect(stream).toContainEqual(
      expect.objectContaining({ type: "phase.changed", phase: "teardown" }),
    );
  });

  it("fails the step on a non-zero exit and still runs teardown with CAIRN_RUN_STATUS=failed", async () => {
    const seen = join(dir, "status.txt");
    const { result, backend } = await run(`version: 1
name: run_fails
intent: A failing run step stops the steps.
coldStart: guest
steps:
  - id: seed
    run: 'echo "boom: fixture database unreachable" >&2; exit 3'
  - open: https://demo.example.test/home
teardown:
  - run: 'echo "$CAIRN_RUN_STATUS" > "${seen}"'
${OUTCOME}`);
    expect(result.status).toBe("failed");
    expect(result.failure?.step).toBe("seed");
    expect(result.failure?.message).toContain("exit 3");
    expect(result.failure?.message).toContain("fixture database unreachable");
    expect(backend.stepLog).toEqual([]);
    expect((await readFile(seen, "utf8")).trim()).toBe("failed");
  });

  it("kills a hung run step's process tree at timeoutMs", async () => {
    const pidFile = join(dir, "sleeper.pid");
    const startedAt = Date.now();
    const { result } = await run(`version: 1
name: run_timeout
intent: A hung run step is killed at its deadline.
coldStart: guest
steps:
  - id: hang
    run:
      shell: 'sleep 30 & echo $! > "${pidFile}"; wait'
      timeoutMs: 400
${OUTCOME}`);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("timed out after 400ms");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("settles a run step on the shell's exit when a background process holds stdout", async () => {
    const pidFile = join(dir, "bg.pid");
    const startedAt = Date.now();
    const { result } = await run(`version: 1
name: run_background
intent: A background process cannot stretch a run step.
coldStart: guest
steps:
  - run:
      shell: 'sleep 30 & echo $! > "${pidFile}"; echo started'
      timeoutMs: 5000
  - open: https://demo.example.test/home
${OUTCOME}`);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.status).toBe("passed");
    try {
      process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    } catch {
      // already gone
    }
  }, 20_000);

  it("passes args to the shell form's $1… only through the object form", async () => {
    const seen = join(dir, "args.txt");
    const { result } = await run(`version: 1
name: run_args
intent: args reach the object form as positional parameters.
coldStart: guest
steps:
  - run:
      shell: 'printf "%s|%s" "$1" "$CAIRN_RUN_STATUS" > "${seen}"'
      args: [demo-entity-1]
  - open: https://demo.example.test/home
${OUTCOME}`);
    expect(result.status).toBe("passed");
    expect(await readFile(seen, "utf8")).toBe("demo-entity-1|");
  });

  it("runs a node script resolved against the spec and rejects non-JSON assigns", async () => {
    await writeFile(
      join(dir, "fixture.mjs"),
      "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
    );
    const { result } = await run(`version: 1
name: run_node
intent: A node run step gets its args.
coldStart: guest
steps:
  - run: { node: ./fixture.mjs, args: [--count, 3], assign: made }
  - open: https://demo.example.test/home?count=\${runs.made.argv.1}
${OUTCOME}`);
    expect(result.status).toBe("passed");
    expect(parseAssignedJson("x\n")).toMatchObject({ ok: false });
    expect(
      resolveRunPlaceholders("${runs.made.argv}", { made: { argv: [1] } }),
    ).toBe("[1]");
    expect(resolveRunPlaceholders("${runs.nope.x}", {})).toBe("");
  });
});

describe("spec teardown", () => {
  it("keeps the run status when teardown fails, unless failRun", async () => {
    const lenient = await run(`version: 1
name: teardown_lenient
intent: A failing cleanup is reported but not fatal.
coldStart: guest
steps:
  - open: https://demo.example.test/home
teardown:
  - id: cleanup
    run: 'exit 9'
  - id: after_cleanup
    run: 'true'
${OUTCOME}`);
    expect(lenient.result.status).toBe("passed");
    const stream = await events(lenient.result.runDir);
    expect(
      stream.filter((e) => e.type === "teardown.finished").map((e) => e.status),
    ).toEqual(["failed", "passed"]);
    const runLog = await readFile(
      join(lenient.result.runDir, "run.log"),
      "utf8",
    );
    expect(runLog).toContain("teardown 1/2 cleanup (run): failed");

    const strict = await run(`version: 1
name: teardown_strict
intent: A failing cleanup errors a passed run with failRun.
coldStart: guest
steps:
  - open: https://demo.example.test/home
teardown:
  failRun: true
  steps:
    - id: cleanup
      run: 'exit 9'
${OUTCOME}`);
    expect(RunResultSchema.parse(strict.result)).toMatchObject({
      status: "errored",
      exitCode: 2,
      failure: { phase: "teardown", name: "cleanup" },
    });
    expect(strict.result.outcomes[0]?.status).toBe("passed");
  });

  it("runs teardown after a failed precondition gate, with CAIRN_RUN_STATUS=errored", async () => {
    const port = await closedPort();
    const seen = join(dir, "status.txt");
    const { result, backend } = await run(`version: 1
name: gate_fails
intent: A gate that never opens stops the run before the browser.
coldStart: guest
preconditions:
  wait:
    - { tcp: "127.0.0.1:${port}", timeout: 300ms, every: 50ms, name: db }
steps:
  - open: https://demo.example.test/home
teardown:
  - run: 'echo "$CAIRN_RUN_STATUS" > "${seen}"'
  - open: https://demo.example.test/cleanup
${OUTCOME}`);
    expect(RunResultSchema.parse(result)).toMatchObject({
      status: "errored",
      failure: { phase: "precondition", name: "wait db", timedOut: true },
    });
    expect(result.failure?.message).toContain(
      'gate "db" not ready within 300ms',
    );
    expect((await readFile(seen, "utf8")).trim()).toBe("errored");
    // The spec's steps never ran; the teardown's browser step did.
    expect(backend.stepLog).toEqual([
      expect.objectContaining({ open: "https://demo.example.test/cleanup" }),
    ]);
    const stream = await events(result.runDir);
    const types = stream.map((e) => e.type);
    expect(types).toContain("gate.started");
    expect(types).toContain("gate.failed");
    expect(types.indexOf("teardown.started")).toBeLessThan(
      types.indexOf("run.errored"),
    );
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "phase.changed",
        phase: "preconditions",
        item: "db",
        budgetMs: 300,
      }),
    );
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "gate.failed",
        name: "db",
        timedOut: true,
      }),
    );
  });

  it("settles a precondition command on the shell's exit when a background process holds stdout", async () => {
    const pidFile = join(dir, "bg.pid");
    const startedAt = Date.now();
    const { result } = await run(`version: 1
name: precondition_background
intent: A background process cannot stretch a precondition.
coldStart: guest
preconditions:
  commands:
    - name: guard
      run: 'sleep 30 & echo $! > "${pidFile}"; echo guard-ok'
      timeoutMs: 5000
steps:
  - open: https://demo.example.test/home
${OUTCOME}`);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.status).toBe("passed");
    try {
      process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    } catch {
      // already gone
    }
  }, 20_000);

  it("waits config gates by name before the commands", async () => {
    const url = await statusServer([503, 503, 200]);
    const marker = join(dir, "command-ran");
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
gates:
  api:
    http: { url: "${url}/ready", status: 2xx }
    every: 20ms
    timeout: 5s
`,
    );
    const { result } = await run(`version: 1
name: gate_by_name
intent: A named gate passes after the 503s.
coldStart: guest
preconditions:
  wait: [api]
  commands:
    - run: 'touch "${marker}"'
steps:
  - open: https://demo.example.test/home
${OUTCOME}`);
    expect(result.status).toBe("passed");
    expect(existsSync(marker)).toBe(true);
    const stream = await events(result.runDir);
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "gate.passed",
        name: "api",
        attempts: 3,
      }),
    );
    expect(stream).toContainEqual(
      expect.objectContaining({ type: "gate.started", scope: "precondition" }),
    );
  });

  it("reports an unknown gate name as a precondition failure", async () => {
    const { result } = await run(`version: 1
name: gate_unknown
intent: An unknown gate fails fast.
coldStart: guest
preconditions:
  wait: [nope]
${OUTCOME}`);
    expect(result.status).toBe("errored");
    expect(result.failure?.message).toContain('unknown gate "nope"');
  });

  it("runs teardown run steps after a cancel and skips its browser steps", async () => {
    const pidFile = join(dir, "slow.pid");
    const seen = join(dir, "status.txt");
    const controller = new AbortController();
    const pending = run(
      `version: 1
name: teardown_cancel
intent: A cancel still cleans up.
coldStart: guest
steps:
  - id: slow
    run: 'sleep 30 & echo $! > "${pidFile}"; wait'
teardown:
  - run: 'echo "$CAIRN_RUN_STATUS" > "${seen}"'
  - open: https://demo.example.test/cleanup
${OUTCOME}`,
      { signal: controller.signal },
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    controller.abort();
    const { result, backend } = await pending;
    expect(result.status).toBe("errored");
    expect(result.failure?.phase).toBe("cancelled");
    expect((await readFile(seen, "utf8")).trim()).toBe("errored");
    expect(backend.stepLog).toEqual([]);
    const finished = (await events(result.runDir)).filter(
      (e) => e.type === "teardown.finished",
    );
    expect(finished.map((e) => [e.kind, e.status])).toEqual([
      ["run", "passed"],
      ["open", "skipped"],
    ]);
  }, 20_000);

  it("runs teardown run steps from the SIGTERM handler", async () => {
    const pidFile = join(dir, "slow.pid");
    const seen = join(dir, "signal.txt");
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: teardown_signal
intent: SIGTERM still cleans up.
coldStart: guest
steps:
  - id: slow
    run: 'sleep 30 & echo $! > "${pidFile}"; wait'
teardown:
  - run: 'echo "$CAIRN_RUN_STATUS $CAIRN_RUN_SIGNAL" > "${seen}"'
${OUTCOME}`,
    );
    const script = join(dir, "child.ts");
    await writeFile(
      script,
      `import { runSpec } from ${JSON.stringify(join(import.meta.dirname, "Runner.ts"))};
import { MockBrowserBackend } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "adapters", "mock", "MockBrowserBackend.ts"))};
await runSpec({ specPath: ${JSON.stringify(specPath)}, backend: new MockBrowserBackend(), artifactRoot: ${JSON.stringify(join(dir, "runs"))}, heartbeatIntervalMs: 0 });
`,
    );
    const child = spawn("bun", [script], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((resolveExit) =>
      child.on("exit", (_code, signal) => resolveExit(signal)),
    );
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");
    expect((await readFile(seen, "utf8")).trim()).toBe("errored SIGTERM");
    // Kill the orphaned sleeper the child left behind.
    try {
      process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    } catch {
      // already gone
    }
  }, 30_000);

  it("runs each teardown item once when the host survives SIGTERM (cairn mcp)", async () => {
    const pidFile = join(dir, "slow.pid");
    const counter = join(dir, "count.txt");
    const specPath = join(dir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: teardown_host_survives
intent: A host that keeps running after SIGTERM cleans up once.
coldStart: guest
steps:
  - id: slow
    run: 'echo $$ > "${pidFile}"; sleep 30'
teardown:
  - run: 'echo "cleanup $CAIRN_RUN_STATUS \${CAIRN_RUN_SIGNAL:-none}" >> "${counter}"'
  - open: https://demo.example.test/cleanup
${OUTCOME}`,
    );
    const script = join(dir, "host.ts");
    await writeFile(
      script,
      `import { runSpec } from ${JSON.stringify(join(import.meta.dirname, "Runner.ts"))};
import { MockBrowserBackend } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "adapters", "mock", "MockBrowserBackend.ts"))};
const controller = new AbortController();
// Like the MCP server: SIGTERM cancels the in-process run, the host lives on.
process.on("SIGTERM", () => controller.abort());
const result = await runSpec({ specPath: ${JSON.stringify(specPath)}, backend: new MockBrowserBackend(), artifactRoot: ${JSON.stringify(join(dir, "runs"))}, heartbeatIntervalMs: 0, signal: controller.signal });
console.log(JSON.stringify({ status: result.status, runDir: result.runDir }));
process.exit(0);
`,
    );
    const child = spawn("bun", [script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) =>
      child.on("exit", (code) => resolveExit(code)),
    );
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    const settled = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      status: string;
      runDir: string;
    };
    expect(settled.status).toBe("errored");
    // One execution, from the signal handler.
    expect((await readFile(counter, "utf8")).trim().split("\n")).toEqual([
      "cleanup errored SIGTERM",
    ]);
    const stream = await events(settled.runDir);
    const started = stream.filter((e) => e.type === "teardown.started");
    expect(started.map((e) => [e.index, e.signal ?? null])).toEqual([
      [1, "SIGTERM"],
      [2, null],
    ]);
    const finished = stream.filter((e) => e.type === "teardown.finished");
    expect(finished.map((e) => [e.index, e.status])).toEqual([
      [1, "passed"],
      [2, "skipped"],
    ]);
  }, 30_000);
});

describe("teardown schema", () => {
  it("rejects use: and artifact-producing steps in teardown", () => {
    const base = {
      version: 1,
      name: "x",
      intent: "y",
      outcomes: [
        { id: "a", description: "b", verify: { url: { matches: "/" } } },
      ],
    };
    expect(
      SpecSchema.safeParse({ ...base, teardown: [{ use: "cleanup" }] }).success,
    ).toBe(false);
    expect(
      SpecSchema.safeParse({
        ...base,
        teardown: {
          steps: [{ download: { by: "text", text: "x", saveAs: "a" } }],
        },
      }).success,
    ).toBe(false);
    // expect/capture belong to the run's verdict path, not to cleanup.
    const expectInTeardown = SpecSchema.safeParse({
      ...base,
      teardown: [{ expect: { by: "text", text: "Saved", visible: true } }],
    });
    expect(expectInTeardown.success).toBe(false);
    expect(JSON.stringify(expectInTeardown.error?.issues)).toContain(
      "expect steps are not supported in teardown",
    );
    expect(
      SpecSchema.safeParse({
        ...base,
        teardown: { steps: [{ run: "true" }], failRun: true, timeoutMs: 1000 },
      }).success,
    ).toBe(true);
    expect(
      SpecSchema.safeParse({
        ...base,
        steps: [{ run: { shell: "a", node: "b" } }],
      }).success,
    ).toBe(false);
  });
});
