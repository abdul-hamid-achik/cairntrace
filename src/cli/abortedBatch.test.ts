import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AbortedBatchRunResultSchema } from "../core/schema/runBatch.v1";
import type { RunResult } from "../core/schema/run.v1";
import {
  buildAbortedBatchSummary,
  writeAbortedBatchSummary,
} from "./abortedBatch";

function completedResult(root: string, name: string): RunResult {
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId: `${name}-run`,
    runDir: join(root, `${name}-run`),
    spec: { name, path: join(root, `${name}.yml`) },
    environment: "test",
    backend: "mock",
    coldStart: false,
    status: "passed",
    summary: "1/1 outcomes passed",
    startedAt: "2026-07-13T10:00:00.000Z",
    endedAt: "2026-07-13T10:00:01.000Z",
    durationMs: 1000,
    outcomes: [{ id: "ok", status: "passed" }],
    steps: [],
    artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
    exitCode: 0,
  };
}

describe("aborted batch summary", () => {
  it("writes an atomic strict summary without touching completed run dirs", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-aborted-batch-"));
    const existingRun = join(root, "existing-run");
    await mkdir(existingRun);
    await writeFile(join(existingRun, "report.json"), '{"kept":true}\n');
    const first = completedResult(root, "first");
    const third = completedResult(root, "third");

    const written = writeAbortedBatchSummary(
      root,
      {
        signal: "SIGTERM",
        startedAt: "2026-07-13T09:00:00.000Z",
        parallel: 2,
        requestedTotal: 4,
        completed: [first, third],
      },
      {
        now: () => new Date("2026-07-13T10:25:17.628Z"),
        pid: 4242,
      },
    );

    expect(written.path).toBe(
      join(root, "aborted-2026-07-13T10-25-17-628Z-4242.json"),
    );
    const parsed = AbortedBatchRunResultSchema.parse(
      JSON.parse(await readFile(written.path, "utf8")),
    );
    expect(parsed).toMatchObject({
      aborted: true,
      signal: "SIGTERM",
      requestedTotal: 4,
      pending: 2,
    });
    expect(parsed.completed.map((result) => result.spec.name)).toEqual([
      "first",
      "third",
    ]);
    expect(await readFile(join(existingRun, "report.json"), "utf8")).toBe(
      '{"kept":true}\n',
    );
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("rejects impossible requested/pending counts", () => {
    const root = "/tmp/cairntrace-aborted-schema";
    const summary = buildAbortedBatchSummary(
      {
        signal: "SIGINT",
        startedAt: "2026-07-13T09:00:00.000Z",
        parallel: 1,
        requestedTotal: 1,
        completed: [completedResult(root, "one")],
      },
      new Date("2026-07-13T09:01:00.000Z"),
    );

    expect(() =>
      AbortedBatchRunResultSchema.parse({ ...summary, pending: 1 }),
    ).toThrow(/completed\.length \+ pending/);
  });
});
