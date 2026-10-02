import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunEventSchema } from "../schema/events.v1";
import { runSpec, type ProgressListener } from "./Runner";

/**
 * Live logs of a run: run.log (plain narration, always), the precondition
 * and node-verifier logs under logs/, and the CAIRN_PROGRESS_FILE channel.
 * Every file is redacted line by line with the run's redactor.
 */
const SECRET = "hunter2-demo-secret";

async function workspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `cairn-run-logs-${prefix}-`));
}

async function readEvents(runDir: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SPEC = `version: 1
name: demo_live_logs
intent: Setup and verifier output stream to live, redacted logs.
coldStart: guest
preconditions:
  commands:
    - name: seed fixtures
      run: 'echo "using $DEMO_API_TOKEN"; echo 1/2 seeded >> "$CAIRN_PROGRESS_FILE"; echo 2/2 seeded $DEMO_API_TOKEN >> "$CAIRN_PROGRESS_FILE"; echo done'
      timeoutMs: 30000
steps:
  - open: https://demo.example.test/tasks
outcomes:
  - id: tasks_terminal
    description: Every task reached a terminal state.
    verify:
      script:
        runtime: node
        run: |
          console.log("polling with " + process.env.DEMO_API_TOKEN);
          console.error("stderr line");
          ctx.progress("47/120 tasks terminal");
          ctx.progress(\`token \${process.env.DEMO_API_TOKEN}\`);
          return { ok: true, evidence: { terminal: 120 } };
  - id: on_tasks
    description: The tasks page is open.
    verify: { url: { matches: "/tasks" } }
`;

describe("run live logs", () => {
  it("writes redacted precondition, verifier, and run logs with progress events", async () => {
    const dir = await workspace("all");
    const specPath = join(dir, "logs.yml");
    await writeFile(specPath, SPEC);
    const progress: string[] = [];
    const listener: ProgressListener = {
      onPreconditionProgress: (name, message) =>
        progress.push(`${name}: ${message}`),
      onOutcomeProgress: (outcome, message) =>
        progress.push(`${outcome.id}: ${message}`),
    };
    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: { PATH: process.env.PATH, DEMO_API_TOKEN: SECRET },
      heartbeatIntervalMs: 0,
      listener,
    });
    expect(result.status).toBe("passed");

    const precondition = await readFile(
      join(result.runDir, "logs", "precondition-01-seed-fixtures.log"),
      "utf8",
    );
    expect(precondition).toBe("using [redacted]\ndone\n");

    const outcomeLog = await readFile(
      join(result.runDir, "logs", "outcome-tasks_terminal.log"),
      "utf8",
    );
    expect(outcomeLog).toContain("polling with [redacted]");
    expect(outcomeLog).toContain("stderr line");
    expect(outcomeLog).not.toContain("__CAIRNTRACE_RESULT__");
    expect(outcomeLog.endsWith("\n\n")).toBe(false);

    const runLog = await readFile(join(result.runDir, "run.log"), "utf8");
    const lines = runLog.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] run start: demo_live_logs/);
    expect(runLog).toContain(
      "precondition seed fixtures started (budget 30.0s)",
    );
    expect(runLog).toContain("precondition seed fixtures: 1/2 seeded");
    expect(runLog).toContain("outcome tasks_terminal: 47/120 tasks terminal");
    expect(lines.at(-1)).toMatch(
      /run end: passed in .+ \(2\/2 outcomes passed\)$/,
    );
    expect(runLog).not.toContain("\u001b[");

    for (const text of [
      precondition,
      outcomeLog,
      runLog,
      progress.join("\n"),
    ]) {
      expect(text).not.toContain(SECRET);
    }
    expect(progress).toEqual([
      "seed fixtures: 1/2 seeded",
      "seed fixtures: 2/2 seeded [redacted]",
      "tasks_terminal: 47/120 tasks terminal",
      "tasks_terminal: token [redacted]",
    ]);

    const events = await readEvents(result.runDir);
    for (const event of events) {
      expect(
        RunEventSchema.safeParse(event).success,
        JSON.stringify(event),
      ).toBe(true);
    }
    expect(JSON.stringify(events)).not.toContain(SECRET);
    const types = events.map((event) => event.type);
    expect(types.indexOf("log.opened")).toBe(types.indexOf("run.started") + 1);
    expect(events.filter((e) => e.type === "precondition.progress")).toEqual([
      expect.objectContaining({ name: "seed fixtures", message: "1/2 seeded" }),
      expect.objectContaining({
        name: "seed fixtures",
        message: "2/2 seeded [redacted]",
      }),
    ]);
    expect(events.find((e) => e.type === "precondition.started")).toMatchObject(
      { logPath: "logs/precondition-01-seed-fixtures.log" },
    );
    const outcomeEvents = events.filter(
      (e) =>
        (e as { outcomeId?: string }).outcomeId === "tasks_terminal" ||
        (e.type === "log.opened" && e.kind === "outcome"),
    );
    expect(outcomeEvents.map((e) => e.type)).toEqual([
      "outcome.started",
      "log.opened",
      "outcome.progress",
      "outcome.progress",
      "outcome.passed",
    ]);

    // The manifest lists the logs with their kinds (run.log is complete).
    const manifest = JSON.parse(
      await readFile(join(result.runDir, "artifact-manifest.json"), "utf8"),
    ) as { artifacts: Array<{ path: string; kind: string; bytes: number }> };
    const byPath = new Map(manifest.artifacts.map((a) => [a.path, a]));
    expect(byPath.get("run.log")).toMatchObject({
      kind: "run-log",
      bytes: Buffer.byteLength(runLog),
    });
    expect(byPath.get("logs/outcome-tasks_terminal.log")?.kind).toBe("log");
    expect(byPath.get("logs/precondition-01-seed-fixtures.log")?.kind).toBe(
      "log",
    );
  });

  it("finishes run.log for a failed precondition before the manifest", async () => {
    const dir = await workspace("pre-fail");
    const specPath = join(dir, "fail.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_guard_fail
intent: A failing guard stops the run.
coldStart: guest
preconditions:
  commands:
    - name: guard
      run: "echo fixture database unreachable; exit 3"
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
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("errored");
    const runLog = await readFile(join(result.runDir, "run.log"), "utf8");
    expect(runLog).toContain("precondition guard failed (exit 3)");
    expect(runLog.trimEnd().split("\n").at(-1)).toContain("run end: errored");
    const manifest = JSON.parse(
      await readFile(join(result.runDir, "artifact-manifest.json"), "utf8"),
    ) as { artifacts: Array<{ path: string; bytes: number }> };
    expect(manifest.artifacts.find((a) => a.path === "run.log")?.bytes).toBe(
      Buffer.byteLength(runLog),
    );
    expect(
      await readFile(
        join(result.runDir, "logs", "precondition-01-guard.log"),
        "utf8",
      ),
    ).toBe("fixture database unreachable\n");
    // No progress scratch files are left inside the run.
    expect(
      existsSync(join(result.runDir, "logs", "precondition-01.progress")),
    ).toBe(false);
  });

  it("redacts precondition output before cutting its tails", async () => {
    const dir = await workspace("tail-cut");
    const specPath = join(dir, "tail.yml");
    // Each command puts the secret right where a tail cut used to land: 4000
    // characters for precondition.run.output, 500 for the failure message.
    await writeFile(
      specPath,
      `version: 1
name: demo_tail_cut
intent: A secret straddling a tail cut never survives as a fragment.
coldStart: guest
preconditions:
  commands:
    - name: chatty
      run: 'printf "%s" "$DEMO_API_TOKEN"; head -c 3995 < /dev/zero | tr "\\0" x; echo'
    - name: failing
      run: 'printf "%s" "$DEMO_API_TOKEN"; head -c 490 < /dev/zero | tr "\\0" x; echo; exit 1'
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      env: { PATH: process.env.PATH, DEMO_API_TOKEN: token },
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("errored");
    const runs = (await readEvents(result.runDir)).filter(
      (event) => event.type === "precondition.run",
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ outputTruncated: true });
    for (const file of ["events.ndjson", "run.json"]) {
      // The mkdtemp suffix (e.g. "...-S3C1Ox") can itself look like a token
      // fragment followed by padding, so drop the workspace path first.
      const text = (
        await readFile(join(result.runDir, file), "utf8")
      ).replaceAll(basename(dir), "<workspace>");
      // Not even the last few characters of the token.
      expect(text, file).not.toMatch(/[A-Z0-9]{4}x/);
    }
  });

  it("never passes the parent's withheld credentials to preconditions", async () => {
    const dir = await workspace("withheld");
    const specPath = join(dir, "withheld.yml");
    await writeFile(
      specPath,
      `version: 1
name: demo_withheld
intent: Publisher and TinyVault credentials stay out of setup commands.
coldStart: guest
preconditions:
  commands:
    - name: show
      run: 'echo "ingest=$FILECHEAP_INGEST_TOKEN tvault=$TVAULT_TOKEN"'
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const saved = {
      FILECHEAP_INGEST_TOKEN: process.env.FILECHEAP_INGEST_TOKEN,
      TVAULT_TOKEN: process.env.TVAULT_TOKEN,
    };
    process.env.FILECHEAP_INGEST_TOKEN = "canary-ingest-1234";
    process.env.TVAULT_TOKEN = "canary-tvault-5678";
    try {
      // No explicit env: the runner filters process.env itself.
      const result = await runSpec({
        specPath,
        backend: new MockBrowserBackend(),
        artifactRoot: join(dir, "runs"),
        heartbeatIntervalMs: 0,
      });
      expect(result.status).toBe("passed");
      expect(
        await readFile(
          join(result.runDir, "logs", "precondition-01-show.log"),
          "utf8",
        ),
      ).toBe("ingest= tvault=\n");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
