import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunEventSchema } from "../schema/events.v1";
import { RunResultSchema } from "../schema/run.v1";
import { runSpec } from "./Runner";

async function workspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cairn-observability-${prefix}-`));
}

async function readEvents(runDir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(runDir, "events.ndjson"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectSchemaValid(events: Record<string, unknown>[]): void {
  for (const event of events) {
    const parsed = RunEventSchema.safeParse(event);
    expect(
      parsed.success,
      `${JSON.stringify(event)} ${parsed.success ? "" : parsed.error.message}`,
    ).toBe(true);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runner observability", () => {
  it("keeps the TAIL of precondition output in the event and failure message", async () => {
    const dir = await workspace("tail");
    const specPath = join(dir, "tail.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_tail
intent: A noisy failing guard keeps its last lines.
coldStart: guest
preconditions:
  commands:
    - name: noisy_guard
      run: "for i in $(seq 1 600); do echo banner-line-$i; done; echo FINAL_ERROR_LINE; exit 4"
steps: []
outcomes:
  - id: never
    description: never evaluated
    verify: { url: { matches: "." } }
`,
    );
    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: { PATH: process.env.PATH },
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("errored");
    expect(result.failure?.message).toContain("FINAL_ERROR_LINE");
    expect(result.failure?.message).not.toContain("banner-line-1\n");

    const events = await readEvents(result.runDir);
    expectSchemaValid(events);
    const run = events.find((e) => e.type === "precondition.run")!;
    const output = String(run.output);
    expect(output.length).toBe(4000);
    expect(output.endsWith("FINAL_ERROR_LINE")).toBe(true);
    expect(output).not.toContain("banner-line-1\n");
    expect(run.outputTruncated).toBe(true);
    expect(run.exitCode).toBe(4);
  });

  it("exports non-secret run context to precondition shells", async () => {
    const dir = await workspace("env");
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: staging
environments:
  staging:
    baseUrl: https://demo.example.test
`,
    );
    const specPath = join(dir, "env.yml");
    const outFile = join(dir, "context.txt");
    await writeFile(
      specPath,
      `version: 1
name: demo_context_env
intent: Setup commands can address the run they prepare.
coldStart: guest
preconditions:
  commands:
    - name: capture_context
      run: >-
        printf '%s\\n' "$CAIRN_ENV" "$CAIRN_BASE_URL" "$CAIRN_RUN_TOKEN"
        "$CAIRN_RUN_ID" "$CAIRN_RUN_DIR" "$CAIRN_CONFIG_DIR"
        "\${CAIRN_TVAULT_ENV:-stripped}" > ${JSON.stringify(outFile)}
steps: []
outcomes:
  - id: clean_console
    description: mock console stays clean
    verify: { console: { errorsMax: 0 } }
`,
    );
    const result = await runSpec({
      specPath,
      configPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: {
        PATH: process.env.PATH,
        CAIRN_TVAULT_ENV: "preview",
        CAIRN_RUN_ID: "stale-from-parent",
      },
      runToken: "tok_fixed",
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("passed");
    const lines = (await readFile(outFile, "utf8")).trim().split("\n");
    expect(lines).toEqual([
      "staging",
      "https://demo.example.test",
      "tok_fixed",
      result.runId,
      result.runDir,
      dir,
      "stripped",
    ]);
  });

  it("writes heartbeats during a long precondition and stops them when the run settles", async () => {
    const dir = await workspace("heartbeat");
    const specPath = join(dir, "beat.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_heartbeat
intent: A slow guard stays visibly alive.
coldStart: guest
preconditions:
  commands:
    - name: slow_guard
      run: sleep 0.5
      timeoutMs: 20000
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: { PATH: process.env.PATH },
      heartbeatIntervalMs: 40,
    });
    expect(result.status).toBe("passed");
    const events = await readEvents(result.runDir);
    expectSchemaValid(events);
    const beats = events.filter((e) => e.type === "run.heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]).toMatchObject({
      phase: "preconditions",
      item: "slow_guard",
      budgetMs: 20_000,
      pid: process.pid,
    });
    // Nothing follows the final run.* event: the manifest checksums the log.
    expect(events.at(-1)!.type).toBe("run.passed");

    const before = await readFile(join(result.runDir, "events.ndjson"), "utf8");
    await sleep(150);
    const after = await readFile(join(result.runDir, "events.ndjson"), "utf8");
    expect(after).toBe(before);
  });

  it("stops heartbeats when the run throws", async () => {
    const dir = await workspace("throw");
    const specPath = join(dir, "throw.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_throw
intent: A crashing listener must not leave a live heartbeat timer.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    let runDir = "";
    await expect(
      runSpec({
        specPath,
        backend: new MockBrowserBackend(),
        artifactRoot: join(dir, "runs"),
        env: { PATH: process.env.PATH },
        heartbeatIntervalMs: 20,
        listener: {
          onRunStart(_spec, _runId, dirOfRun) {
            runDir = dirOfRun;
          },
          onStepStart() {
            throw new Error("listener crashed");
          },
        },
      }),
    ).rejects.toThrow("listener crashed");
    await sleep(60);
    const before = await readFile(join(runDir, "events.ndjson"), "utf8");
    await sleep(120);
    const after = await readFile(join(runDir, "events.ndjson"), "utf8");
    expect(after).toBe(before);
  });

  it("stamps the invocation link on run.started and run.json", async () => {
    const dir = await workspace("invocation");
    const specPath = join(dir, "inv.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_invocation
intent: Runs know the invocation that planned them.
coldStart: guest
steps: []
outcomes:
  - id: clean_console
    description: mock console stays clean
    verify: { console: { errorsMax: 0 } }
`,
    );
    const invocation = {
      id: "2026-01-01T00-00-00-000Z_4242_a1b2c3",
      index: 2,
      total: 3,
      dir: "_invocations/2026-01-01T00-00-00-000Z_4242_a1b2c3",
    };
    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: { PATH: process.env.PATH },
      heartbeatIntervalMs: 0,
      invocation,
    });
    expect(result.invocation).toEqual(invocation);
    expect(RunResultSchema.safeParse(result).success).toBe(true);
    const runJson = JSON.parse(
      await readFile(join(result.runDir, "run.json"), "utf8"),
    ) as { invocation?: unknown };
    expect(runJson.invocation).toEqual(invocation);
    const events = await readEvents(result.runDir);
    expect(events.find((e) => e.type === "run.started")).toMatchObject({
      invocation,
    });
  });

  it("announces outcome kind and budget, and records invalid when: gates as step.failed", async () => {
    const dir = await workspace("outcome");
    await writeFile(join(dir, "marker.txt"), "ready");
    const specPath = join(dir, "outcome.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_outcome_budget
intent: Outcome budgets are visible before the verdict.
coldStart: guest
steps:
  - id: gated
    when: "sometimes:maybe"
    click: { by: role, role: button, name: Go }
outcomes:
  - id: marker_written
    description: The marker file exists.
    verify: { file: { glob: marker.txt, timeoutMs: 2000 } }
`,
    );
    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: { PATH: process.env.PATH },
      heartbeatIntervalMs: 0,
    });
    const events = await readEvents(result.runDir);
    expectSchemaValid(events);
    expect(events.find((e) => e.type === "step.failed")).toMatchObject({
      stepId: "gated",
      error: expect.stringContaining("when:"),
    });
    expect(events.find((e) => e.type === "outcome.started")).toMatchObject({
      outcomeId: "marker_written",
      kind: "file",
      timeoutMs: 2000,
    });
    const started = events.findIndex((e) => e.type === "outcome.started");
    const verdict = events.findIndex((e) => e.type === "outcome.passed");
    expect(verdict).toBeGreaterThan(started);
  });
});
