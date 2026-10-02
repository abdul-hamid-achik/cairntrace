import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  InvocationJournalSchema,
  RunEventSchema,
  type InvocationJournalFile,
} from "../../core/schema/events.v1";
import { RunResultSchema } from "../../core/schema/run.v1";

/**
 * The invocation journal (`_invocations/<id>/`) end to end through the real
 * CLI with the mock backend: a 2-spec batch with one failure (plus services,
 * hooks, redaction), and a SIGTERM abort.
 */
const CAIRN = join(process.cwd(), "bin", "cairn");
const SECRET = "hunter2-demo-secret";

const PASSING_SPEC = `version: 1
name: demo_journal_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const FAILING_SPEC = `version: 1
name: demo_journal_fail
intent: The welcome copy regressed.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: welcome_copy
    description: The welcome copy is visible.
    verify: { text: { contains: Welcome back } }
`;

const SLOW_SPEC = `version: 1
name: demo_journal_slow
intent: A slow setup command keeps the run busy until it is interrupted.
coldStart: guest
preconditions:
  commands:
    - name: slow_setup
      run: "sleep 4"
      timeoutMs: 30000
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

async function journalDir(artifactRoot: string): Promise<string> {
  const ids = await readdir(join(artifactRoot, "_invocations"));
  expect(ids).toHaveLength(1);
  return join(artifactRoot, "_invocations", ids[0]!);
}

async function readJournal(dir: string): Promise<InvocationJournalFile> {
  return InvocationJournalSchema.parse(
    JSON.parse(await readFile(join(dir, "invocation.json"), "utf8")),
  );
}

async function readEvents(dir: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(dir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cairn run invocation journal", () => {
  it("journals a 2-spec batch with one failure, services, hooks, and redaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-journal-batch-"));
    const artifactRoot = join(dir, "runs");
    // A spec-declared literal must be scrubbed from every journal surface,
    // including services output and --before hooks that run before that
    // spec's run registers it.
    await writeFile(
      join(dir, "a_pass.yml"),
      `${PASSING_SPEC}redaction:\n  values: [spec-literal-0042]\n`,
    );
    await writeFile(join(dir, "b_fail.yml"), FAILING_SPEC);
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
services:
  docker:
    command: 'echo starting containers; echo "token $DEMO_API_TOKEN"; echo "literal spec-literal-0042"'
    reuseExisting: false
`,
    );

    const result = await execa(
      CAIRN,
      [
        "run",
        "a_pass.yml",
        "b_fail.yml",
        "--mock",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--json",
        "--var",
        "password=plain-pass",
        "--label",
        "suite=journal",
        "--before",
        'echo "before $DEMO_API_TOKEN spec-literal-0042"',
        "--after",
        'echo "after $CAIRN_RUN_ID spec-literal-0042"',
      ],
      {
        cwd: dir,
        reject: false,
        timeout: 30_000,
        env: { CI: "true", DEMO_API_TOKEN: SECRET },
      },
    );
    expect(result.exitCode).toBe(1);
    const batch = JSON.parse(result.stdout) as {
      results: Array<{ runId: string; runDir: string; status: string }>;
    };
    expect(batch.results.map((r) => r.status)).toEqual(["passed", "failed"]);

    const jdir = await journalDir(artifactRoot);
    const journal = await readJournal(jdir);
    expect(journal).toMatchObject({
      version: 1,
      status: "failed",
      parallel: 1,
      labels: { suite: "journal" },
      planned: [
        { index: 1, spec: "a_pass.yml" },
        { index: 2, spec: "b_fail.yml" },
      ],
      summary: { total: 2, passed: 1, failed: 1, errored: 0, exitCode: 1 },
    });
    expect(journal.endedAt).toBeDefined();
    expect(journal.argv).toContain("password=[redacted]");
    expect(journal.argv).toContain('echo "before $DEMO_API_TOKEN [redacted]"');
    expect(journal.runs).toEqual([
      {
        index: 1,
        spec: "a_pass.yml",
        runId: batch.results[0]!.runId,
        runDir: batch.results[0]!.runDir,
        status: "passed",
      },
      {
        index: 2,
        spec: "b_fail.yml",
        runId: batch.results[1]!.runId,
        runDir: batch.results[1]!.runDir,
        status: "failed",
      },
    ]);

    // Each run links back to the journal (run.json + run.started).
    for (const [i, run] of batch.results.entries()) {
      const runJson = RunResultSchema.parse(
        JSON.parse(await readFile(join(run.runDir, "run.json"), "utf8")),
      );
      expect(runJson.invocation).toEqual({
        id: journal.invocationId,
        index: i + 1,
        total: 2,
        dir: `_invocations/${journal.invocationId}`,
      });
      const runEvents = await readEvents(run.runDir);
      expect(runEvents.find((e) => e.type === "run.started")).toMatchObject({
        invocation: { id: journal.invocationId, index: i + 1, total: 2 },
      });
      // The back-dated services copy stays in every run for compatibility.
      expect(runEvents.some((e) => e.type === "services.docker.start")).toBe(
        true,
      );
      expect(existsSync(join(run.runDir, "run.log"))).toBe(true);
    }

    const events = await readEvents(jdir);
    for (const event of events) {
      expect(
        RunEventSchema.safeParse(event).success,
        JSON.stringify(event),
      ).toBe(true);
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("invocation.started");
    expect(types.at(-1)).toBe("invocation.finished");
    expect(events.at(-1)).toMatchObject({ status: "failed" });
    // services.* are written live, inside the services phase.
    expect(types.indexOf("phase.changed")).toBeLessThan(
      types.indexOf("services.docker.start"),
    );
    expect(types).toContain("services.docker.ready");
    expect(events.filter((e) => e.type === "hook.started")).toEqual([
      expect.objectContaining({ hook: "before", index: 1 }),
      expect.objectContaining({
        hook: "after",
        index: 1,
        runId: batch.results[0]!.runId,
      }),
      expect.objectContaining({
        hook: "after",
        index: 1,
        runId: batch.results[1]!.runId,
      }),
    ]);
    expect(
      events.find((e) => e.type === "hook.started" && e.hook === "before"),
    ).toMatchObject({
      command: 'echo "before $DEMO_API_TOKEN [redacted]"',
      logPath: "logs/hook-before-01.log",
    });
    expect(
      events.find((e) => e.type === "hook.finished" && e.hook === "before"),
    ).toMatchObject({
      exitCode: 0,
      outputTail: "before [redacted] [redacted]",
    });
    // --after hooks get one log per run (concurrent runs never interleave).
    for (const run of batch.results) {
      expect(
        events.find((e) => e.type === "hook.started" && e.runId === run.runId),
      ).toMatchObject({ logPath: `logs/hook-after-01-${run.runId}.log` });
    }
    const phases = events
      .filter((e) => e.type === "phase.changed")
      .map((e) => e.phase);
    expect(phases).toEqual([
      "services",
      "before-hooks",
      "steps",
      "after-hooks",
      "steps",
      "after-hooks",
      "teardown",
    ]);

    const logs = join(jdir, "logs");
    const docker = await readFile(join(logs, "services-docker.log"), "utf8");
    expect(docker).toContain("starting containers");
    expect(docker).toContain("token [redacted]");
    expect(docker).toContain("literal [redacted]");
    expect(docker).toContain("[exit 0]");
    const before = await readFile(join(logs, "hook-before-01.log"), "utf8");
    expect(before).toContain("before [redacted] [redacted]");
    for (const [i, run] of batch.results.entries()) {
      const after = await readFile(
        join(logs, `hook-after-01-${run.runId}.log`),
        "utf8",
      );
      expect(after).toContain(`after ${run.runId} [redacted]`);
      expect(after).not.toContain(batch.results[1 - i]!.runId);
    }
    const narration = await readFile(join(logs, "narration.log"), "utf8");
    expect(narration).toContain("[1/2] a_pass.yml — starting…");
    expect(narration).toContain("[2/2] b_fail.yml failed");
    expect(narration).toMatch(/finished: failed, 1\/2 passed/);

    const logFiles = await readdir(logs);
    expect(logFiles).toContain("narration.log");
    for (const file of logFiles) {
      const text = await readFile(join(logs, file), "utf8");
      expect(text, file).not.toContain(SECRET);
      expect(text, file).not.toContain("spec-literal-0042");
    }
    for (const file of ["events.ndjson", "invocation.json"]) {
      const text = await readFile(join(jdir, file), "utf8");
      expect(text, file).not.toContain(SECRET);
      expect(text, file).not.toContain("spec-literal-0042");
    }
    expect(await readFile(join(jdir, "invocation.json"), "utf8")).not.toContain(
      "plain-pass",
    );
  }, 40_000);

  it("gives every parallel --after execution of long-named specs its own complete log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-journal-long-"));
    const artifactRoot = join(dir, "runs");
    // Long names push the run id past the slug budget; parallel runs often
    // start in the same millisecond, so only the random suffix tells them
    // apart.
    const names = ["a1", "b2", "c3", "d4", "e5", "f6"].map(
      (region) =>
        `checkout_flow_with_discount_code_applied_for_every_region_and_currency_${region}`,
    );
    const files: string[] = [];
    for (const [i, name] of names.entries()) {
      const file = `spec_${i}.yml`;
      await writeFile(
        join(dir, file),
        PASSING_SPEC.replace("name: demo_journal_pass", `name: ${name}`),
      );
      files.push(file);
    }
    const result = await execa(
      CAIRN,
      [
        "run",
        ...files,
        "--parallel",
        String(files.length),
        "--mock",
        "--no-services",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--json",
        "--after",
        'for i in 1 2 3; do echo "line-$i $CAIRN_RUN_ID"; sleep 0.1; done',
      ],
      { cwd: dir, reject: false, timeout: 30_000, env: { CI: "true" } },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const runIds = (
      JSON.parse(result.stdout) as { results: Array<{ runId: string }> }
    ).results.map((run) => run.runId);
    expect(runIds).toHaveLength(files.length);

    const jdir = await journalDir(artifactRoot);
    const started = (await readEvents(jdir)).filter(
      (e) => e.type === "hook.started",
    );
    expect(started).toHaveLength(files.length);
    const logPaths = started.map((e) => String(e.logPath));
    expect(new Set(logPaths).size).toBe(files.length);
    for (const runId of runIds) {
      const event = started.find((e) => e.runId === runId);
      expect(event, runId).toBeDefined();
      const text = await readFile(join(jdir, String(event!.logPath)), "utf8");
      const lines = text.trimEnd().split("\n");
      expect(lines.filter((line) => line.startsWith("--- "))).toEqual([
        expect.stringContaining(`run ${runId}`),
      ]);
      for (const i of [1, 2, 3]) expect(text).toContain(`line-${i} ${runId}\n`);
      for (const other of runIds.filter((id) => id !== runId))
        expect(text).not.toContain(other);
      expect(lines.at(-1)).toMatch(/^\[exit 0 after \d+ms\]$/);
    }
  }, 40_000);

  it("marks the journal aborted when the run is interrupted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-journal-abort-"));
    const artifactRoot = join(dir, "runs");
    await writeFile(join(dir, "slow.yml"), SLOW_SPEC);
    await writeFile(join(dir, "pass.yml"), PASSING_SPEC);
    const child = execa(
      CAIRN,
      [
        "run",
        "slow.yml",
        "pass.yml",
        "--mock",
        "--no-services",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--json",
      ],
      { cwd: dir, reject: false, timeout: 30_000, env: { CI: "true" } },
    );

    // Wait until the first run is in flight (its run dir exists).
    let jdir: string | undefined;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const ids = await readdir(join(artifactRoot, "_invocations")).catch(
        () => [] as string[],
      );
      if (ids.length === 0) continue;
      jdir = join(artifactRoot, "_invocations", ids[0]!);
      const journal = await readJournal(jdir).catch(() => undefined);
      if (journal?.runs.some((run) => run.status === "running")) break;
    }
    expect(jdir).toBeDefined();
    child.kill("SIGTERM");
    const result = await child;
    expect(result.exitCode).toBe(143);

    const journal = await readJournal(jdir!);
    expect(journal).toMatchObject({
      status: "aborted",
      signal: "SIGTERM",
      current: { index: 1, spec: "slow.yml" },
    });
    expect(journal.endedAt).toBeDefined();
    const events = await readEvents(jdir!);
    expect(events.at(-1)).toMatchObject({
      type: "invocation.finished",
      status: "aborted",
      signal: "SIGTERM",
    });
  }, 40_000);
});
