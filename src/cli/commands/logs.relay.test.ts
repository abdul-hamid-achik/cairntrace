import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RunEventSchema, type RunEvent } from "../../core/schema/events.v1";
import {
  delegateConfig,
  writeDelegateProject,
} from "../../testing/delegateFixtures";
import { executeRunInvocation } from "../invocation/executeRunInvocation";
import { logsCommand } from "./logs";

/**
 * `cairn logs --invocation <ref> [--follow] --relay`: the producer side of
 * the delegated-runner contract, run where the invocation really runs. It
 * prints the journal's events plus `invocation.run.*` and
 * `invocation.summary` lines (all events.v1), and `label:<key>=<value>`
 * finds the journal a runner stamped with `cairn.delegate=<id>`.
 */

let dir: string;
let root: string;
let journalDir: string;
let captured: string[];
let errors: string[];
let spies: Array<{ mockRestore(): void }>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-logs-relay-"));
  root = join(dir, "runs");
  await writeDelegateProject(dir);
  const config = join(dir, "cairntrace.config.yml");
  await writeFile(config, delegateConfig("      command: [bun, unused]"));
  const result = await executeRunInvocation(
    {
      specs: [],
      options: {
        suite: "mixed",
        env: "worker",
        mock: true,
        config,
        artifactRoot: root,
        noWebServer: true,
        noServices: true,
        label: ["cairn.delegate=local-123"],
      },
      cwd: dir,
    },
    { origin: "cli" },
  );
  journalDir = result.journalDir!;
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture(): void {
  captured = [];
  errors = [];
  spies = [
    vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        captured.push(String(chunk));
        return true;
      }),
    vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        errors.push(String(chunk));
        return true;
      }),
  ];
  process.exitCode = 0;
}

afterEach(() => {
  for (const spy of spies ?? []) spy.mockRestore();
  process.exitCode = 0;
});

function streamed(): RunEvent[] {
  return captured
    .join("")
    .trim()
    .split("\n")
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

describe("cairn logs --relay", () => {
  it("prints the delegate stream of a settled invocation found by label", async () => {
    capture();
    await logsCommand(undefined, {
      artifactRoot: root,
      invocation: "label:cairn.delegate=local-123",
      relay: true,
    });
    expect(process.exitCode).toBe(0);
    const events = streamed();
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("invocation.started");
    expect(types.filter((t) => t === "invocation.run.started")).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === "invocation.run.finished")
        .map((event) => (event as { status: string }).status),
    ).toEqual(["passed", "failed"]);
    expect(types.at(-1)).toBe("invocation.summary");
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      summary: { total: 2, passed: 1, failed: 1, exitCode: 1 },
    });
    // The relay lines sit in time order between the journal's own lines.
    const stamps = events.map((event) => event.ts);
    expect(stamps).toEqual(stamps.toSorted());
  });

  it("follows a settled invocation to the end and exits 0", async () => {
    capture();
    await logsCommand(undefined, {
      artifactRoot: root,
      invocation: journalDir,
      relay: true,
      follow: true,
      pollMs: 10,
    });
    expect(process.exitCode).toBe(0);
    expect(streamed().at(-1)?.type).toBe("invocation.summary");
  });

  it("is a usage error without --invocation, and an unknown label is exit 2", async () => {
    capture();
    await logsCommand(undefined, { artifactRoot: root, relay: true });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("--relay streams an invocation journal");
    capture();
    await mkdir(join(root, "_invocations"), { recursive: true });
    await logsCommand(undefined, {
      artifactRoot: root,
      invocation: "label:cairn.delegate=nobody",
      relay: true,
    });
    expect(process.exitCode).toBe(2);
  });
});

describe("cairn logs --invocation label:… --follow --wait-timeout (M4)", () => {
  it("stops waiting for a label no journal carries (exit 2) instead of waiting forever", async () => {
    capture();
    const started = Date.now();
    await logsCommand(undefined, {
      artifactRoot: root,
      invocation: "label:cairn.delegate=never-started",
      relay: true,
      follow: true,
      pollMs: 10,
      waitTimeout: "150ms",
    });
    expect(process.exitCode).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(errors.join("")).toContain("appeared within");
  });

  it("finds a journal that appears while it waits", async () => {
    capture();
    const following = logsCommand(undefined, {
      artifactRoot: root,
      invocation: "label:cairn.delegate=late-1",
      relay: true,
      follow: true,
      pollMs: 10,
      waitTimeout: "10s",
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    const config = join(dir, "cairntrace.config.yml");
    await executeRunInvocation(
      {
        specs: [],
        options: {
          suite: "one",
          env: "worker",
          mock: true,
          config,
          artifactRoot: root,
          noWebServer: true,
          noServices: true,
          label: ["cairn.delegate=late-1"],
        },
        cwd: dir,
      },
      { origin: "cli" },
    );
    await following;
    expect(process.exitCode).toBe(0);
    expect(streamed().at(-1)?.type).toBe("invocation.summary");
  });

  it("refuses a bad --wait-timeout, and one without --invocation (exit 2)", async () => {
    capture();
    await logsCommand(undefined, {
      artifactRoot: root,
      invocation: "label:cairn.delegate=x",
      follow: true,
      relay: true,
      waitTimeout: "soon",
    });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("--wait-timeout soon");
    capture();
    await logsCommand(undefined, { artifactRoot: root, waitTimeout: "1s" });
    expect(process.exitCode).toBe(2);
    expect(errors.join("")).toContain("--wait-timeout applies to");
  });
});

describe("cairn logs <run> --follow on a delegated run", () => {
  it("follows the local owner's liveness, not the remote heartbeat pid", async () => {
    const runsRoot = join(dir, "delegated-root");
    const runId = "2026-10-03T10-00-00-000Z_alpha_abc123";
    const runDir = join(runsRoot, runId);
    const invocationId = `2026-10-03T10-00-00-000Z_${process.pid}_d1e2f3`;
    const ownerDir = join(runsRoot, "_invocations", invocationId);
    await mkdir(ownerDir, { recursive: true });
    await writeFile(
      join(ownerDir, "invocation.json"),
      JSON.stringify({
        version: 1,
        invocationId,
        pid: process.pid,
        argv: ["run"],
        cwd: dir,
        parallel: 1,
        planned: [{ index: 1, spec: "flows/alpha.yml" }],
        status: "running",
        startedAt: "2026-10-03T10:00:00.000Z",
        runs: [
          {
            index: 1,
            spec: "flows/alpha.yml",
            runId,
            runDir,
            status: "running",
          },
        ],
        delegate: {
          contract: "urn:cairntrace.dev:delegate:v1",
          command: ["runner"],
        },
      }),
    );
    capture();
    const following = logsCommand(runId, {
      artifactRoot: runsRoot,
      follow: true,
      pollMs: 10,
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 60));
    // The runner copies the run: a heartbeat from a pid that is not alive
    // here, then the manifest.
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify({ ts: "2026-10-03T10:00:01.000Z", type: "run.heartbeat", phase: "steps", elapsedMs: 1, pid: 2_147_483_000 })}\n`,
    );
    await new Promise((resolveTick) => setTimeout(resolveTick, 60));
    await writeFile(join(runDir, "artifact-manifest.json"), "{}");
    await following;
    expect(process.exitCode).toBe(0);
    expect(errors.join("")).toContain("waiting for the delegated runner");
    expect(captured.join("")).toContain('"run.heartbeat"');
  });
});

describe("cairn stats --invocation on delegated runs", () => {
  it("matches runs by the cairn.delegate label the runner stamped", async () => {
    const { aggregateRunStats } = await import("../../core/stats/runStats");
    const stats = await aggregateRunStats({
      artifactRoot: root,
      invocation: "local-123",
      groupBy: "suite",
    });
    expect(stats.matched).toBe(2);
  });
});
