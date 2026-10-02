import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import {
  InvocationJournalSchema,
  RunEventSchema,
} from "../../core/schema/events.v1";
import { SelectionResultSchema } from "../../core/schema/selection.v1";
import { RunCancelledError, SpecRefusedError } from "../../core/runner/Runner";
import { executeRunInvocation } from "./executeRunInvocation";
import { mergeExitCodes } from "./iterations";
import { adoptStartedRun, synthesizeErroredResult } from "./results";

/**
 * Environment policy in the run engine (F1): a refused spec never starts
 * services, a webServer, hooks, preconditions or a browser, never gets a run
 * directory, ends `refused`; the run exits 7 when every spec was refused,
 * and a batch where other specs ran fails only under --strict-requires.
 */

let dir: string;

const spec = (name: string, extra: string, marker: string): string =>
  `version: 1
name: ${name}
intent: A mock run guarded by the environment policy.
${extra}
preconditions:
  commands:
    - name: mark
      run: 'touch "${marker}"'
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

async function runDirsUnder(root: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.filter((e) => /^\d/.test(e));
}

async function journalEvents(
  journalDir: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(journalDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-policy-"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
artifactRoot: ${JSON.stringify(join(dir, "runs"))}
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
    policy: { trait: owned }
  dev:
    baseUrl: https://demo.example.test
    policy: { trait: shared, mutations: deny, description: team QA }
  prod:
    baseUrl: https://demo.example.test
    policy: { trait: protected }
webServer:
  command: "sleep 60"
  url: http://127.0.0.1:9/
  readyTimeoutMs: 60000
`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("environment policy in the run engine", () => {
  it("refuses a single spec before anything starts (exit 7, no run dir)", async () => {
    const marker = join(dir, "precondition-ran");
    const hookMarker = join(dir, "hook-ran");
    await writeFile(
      join(dir, "local-only.yml"),
      spec("local_only", "requires: { env: [local] }", marker),
    );
    const startedAt = Date.now();
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "local-only.yml")],
        // The config webServer (sleep 60, never ready) would hang the run
        // if anything booted it.
        options: { mock: true, env: "dev", before: [`touch "${hookMarker}"`] },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.kind).toBe("single");
    expect(result.exitCode).toBe(7);
    expect(result.runDirs).toEqual([]);
    const doc = RunResultSchema.parse(result.document);
    expect(doc).toMatchObject({
      status: "refused",
      exitCode: 7,
      environment: "dev",
      refusal: {
        env: "dev",
        code: "env-not-listed",
        requires: { env: ["local"] },
        policy: { trait: "shared", mutations: "deny" },
      },
      outcomes: [{ id: "home", status: "skipped" }],
      steps: [],
      // runId/runDir are placeholders: agents and Studio must not open them.
      synthetic: true,
    });
    expect(existsSync(doc.runDir)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(hookMarker)).toBe(false);
    expect(await runDirsUnder(join(dir, "runs"))).toEqual([]);
    // The journal records the refusal as a run.refused event, no run entry.
    const events = await journalEvents(result.journalDir!);
    const refused = events.filter((e) => e.type === "run.refused");
    expect(refused).toHaveLength(1);
    expect(RunEventSchema.parse(refused[0])).toMatchObject({
      spec: "local_only",
      env: "dev",
      code: "env-not-listed",
      index: 1,
    });
    // The strict writer schema accepts the journal: exit 7 settles as
    // "failed" with a refused count, and `current` no longer points at the
    // refused spec.
    const journal = InvocationJournalSchema.parse(
      JSON.parse(
        await readFile(join(result.journalDir!, "invocation.json"), "utf8"),
      ),
    );
    expect(journal.runs).toEqual([]);
    expect(journal.status).toBe("failed");
    expect(journal.summary).toMatchObject({
      total: 1,
      passed: 0,
      refused: 1,
      exitCode: 7,
    });
    expect(journal.current).toBeUndefined();
  }, 30_000);

  it("keeps a batch going past a refused spec unless --strict-requires", async () => {
    const markerA = join(dir, "a-ran");
    const markerB = join(dir, "b-ran");
    await writeFile(
      join(dir, "a-mutates.yml"),
      spec("a_mutates", "requires: { mutates: true }", markerA),
    );
    await writeFile(
      join(dir, "b-reads.yml"),
      spec("b_reads", "coldStart: guest", markerB),
    );
    const specs = [join(dir, "a-mutates.yml"), join(dir, "b-reads.yml")];
    const lenient = await executeRunInvocation(
      {
        specs,
        options: { mock: true, env: "dev", noWebServer: true },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(lenient.exitCode).toBe(0);
    const batch = BatchRunResultSchema.parse(lenient.document);
    expect(batch.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      errored: 0,
      refused: 1,
    });
    expect(batch.results.map((r) => r.status)).toEqual(["refused", "passed"]);
    expect(batch.results[0]?.refusal?.code).toBe("mutations-denied");
    expect(existsSync(markerA)).toBe(false);
    expect(existsSync(markerB)).toBe(true);
    expect(lenient.runDirs).toHaveLength(1);

    const strict = await executeRunInvocation(
      {
        specs,
        options: {
          mock: true,
          env: "dev",
          noWebServer: true,
          strictRequires: true,
        },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(strict.exitCode).toBe(7);
    expect(BatchRunResultSchema.parse(strict.document).exitCode).toBe(7);
  }, 30_000);

  it("honors opt-in variables and protected environments", async () => {
    const marker = join(dir, "ran");
    await writeFile(
      join(dir, "opt-in.yml"),
      spec(
        "opt_in",
        "requires: { env: [local, { prod: { optIn: CAIRN_ALLOW_PROD } }] }",
        marker,
      ),
    );
    await writeFile(
      join(dir, "unlisted.yml"),
      spec("unlisted", "coldStart: guest", marker),
    );
    const refusedProd = await executeRunInvocation(
      {
        specs: [join(dir, "opt-in.yml")],
        options: { mock: true, env: "prod", noWebServer: true },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(refusedProd.exitCode).toBe(7);
    expect(RunResultSchema.parse(refusedProd.document).refusal?.code).toBe(
      "opt-in-missing",
    );

    const optedIn = await executeRunInvocation(
      {
        specs: [join(dir, "opt-in.yml")],
        options: { mock: true, env: "prod", noWebServer: true },
        cwd: dir,
        callerEnv: { CAIRN_ALLOW_PROD: "1" },
      },
      { origin: "mcp" },
    );
    expect(optedIn.exitCode).toBe(0);
    expect(RunResultSchema.parse(optedIn.document).status).toBe("passed");

    const protectedEnv = await executeRunInvocation(
      {
        specs: [join(dir, "unlisted.yml")],
        options: { mock: true, env: "prod", noWebServer: true },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(RunResultSchema.parse(protectedEnv.document).refusal?.code).toBe(
      "protected-env",
    );
  }, 30_000);

  it("lists refused specs under skipped with --select-only", async () => {
    const marker = join(dir, "ran");
    await writeFile(
      join(dir, "local-only.yml"),
      spec("local_only", "requires: { env: [local] }", marker),
    );
    await writeFile(
      join(dir, "anywhere.yml"),
      spec("anywhere", "coldStart: guest", marker),
    );
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "local-only.yml"), join(dir, "anywhere.yml")],
        options: { mock: true, env: "dev", selectOnly: true },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    const selection = SelectionResultSchema.parse(result.document);
    expect(selection.selected.map((s) => s.name)).toEqual(["anywhere"]);
    expect(selection.skipped).toEqual([
      expect.objectContaining({
        name: "local-only",
        reason: expect.stringContaining('refused in environment "dev"'),
      }),
    ]);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("exits 7 when every spec was refused, whatever --parallel", async () => {
    const marker = join(dir, "ran");
    await writeFile(
      join(dir, "a.yml"),
      spec("a_local", "requires: { env: [local] }", marker),
    );
    await writeFile(
      join(dir, "b.yml"),
      spec("b_mutates", "requires: { mutates: true }", marker),
    );
    const all = await executeRunInvocation(
      {
        specs: [join(dir, "a.yml"), join(dir, "b.yml")],
        options: { mock: true, env: "dev", noWebServer: true },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(all.exitCode).toBe(7);
    const batch = BatchRunResultSchema.parse(all.document);
    expect(batch.exitCode).toBe(7);
    expect(batch.summary).toMatchObject({ total: 2, passed: 0, refused: 2 });
    expect(batch.results.every((r) => r.synthetic === true)).toBe(true);
    const journal = InvocationJournalSchema.parse(
      JSON.parse(
        await readFile(join(all.journalDir!, "invocation.json"), "utf8"),
      ),
    );
    expect(journal.status).toBe("failed");
    expect(journal.summary).toMatchObject({ exitCode: 7, refused: 2 });

    // One spec through the batch path (--parallel 2) exits like runSingle.
    const parallel = await executeRunInvocation(
      {
        specs: [join(dir, "a.yml")],
        options: { mock: true, env: "dev", noWebServer: true, parallel: 2 },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(parallel.kind).toBe("batch");
    expect(parallel.exitCode).toBe(7);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("reports runSpec's own refusal (preflight passed) as refused with run.refused", async () => {
    const marker = join(dir, "ran");
    const flip = join(dir, "flip.yml");
    const refusedSource = spec(
      "flipped_local",
      "requires: { env: [local] }",
      marker,
    );
    await writeFile(join(dir, "refused.src"), refusedSource);
    // Allowed at preflight; a --before hook rewrites it into a spec the
    // policy refuses, so only runSpec's own guard sees the refusal.
    await writeFile(flip, spec("flip", "coldStart: guest", marker));
    const result = await executeRunInvocation(
      {
        specs: [flip],
        options: {
          mock: true,
          env: "dev",
          noWebServer: true,
          before: [`cp "${join(dir, "refused.src")}" "${flip}"`],
        },
        cwd: dir,
        callerEnv: {},
      },
      { origin: "mcp" },
    );
    expect(result.exitCode).toBe(7);
    const doc = RunResultSchema.parse(result.document);
    expect(doc).toMatchObject({
      status: "refused",
      spec: { name: "flipped_local" },
      refusal: { code: "env-not-listed", env: "dev" },
      outcomes: [{ id: "home", status: "skipped" }],
    });
    expect(existsSync(marker)).toBe(false);
    const events = await journalEvents(result.journalDir!);
    expect(events.filter((e) => e.type === "run.refused")).toEqual([
      expect.objectContaining({ spec: "flipped_local", env: "dev", index: 1 }),
    ]);
    const journal = JSON.parse(
      await readFile(join(result.journalDir!, "invocation.json"), "utf8"),
    ) as { runs: unknown[] };
    expect(journal.runs).toEqual([]);
  }, 30_000);

  it("maps runSpec's refusal and parse-window cancel errors", () => {
    const refused = synthesizeErroredResult(
      "/tmp/flows/x.yml",
      new SpecRefusedError(
        {
          reason: "nope",
          env: "dev",
          requires: { env: ["local"] },
          code: "env-not-listed",
        },
        "/tmp/flows/x.yml",
        { name: "real_name", outcomeIds: ["a", "b"] },
      ),
    );
    expect(refused).toMatchObject({
      status: "refused",
      exitCode: 7,
      spec: { name: "real_name" },
      outcomes: [
        { id: "a", status: "skipped" },
        { id: "b", status: "skipped" },
      ],
    });
    const cancelled = synthesizeErroredResult(
      "/tmp/flows/x.yml",
      new RunCancelledError(),
    );
    expect(cancelled).toMatchObject({
      status: "errored",
      failure: { phase: "cancelled" },
      synthetic: true,
    });
    expect(cancelled.failure?.step).toBeUndefined();
  });

  it("marks a synthesized result synthetic unless its run had started", () => {
    const errored = synthesizeErroredResult(
      "/tmp/flows/x.yml",
      new Error("boom"),
    );
    expect(errored.synthetic).toBe(true);
    expect(RunResultSchema.parse(errored).synthetic).toBe(true);
    // runSpec threw after run.started: the document points at the real
    // run directory and is no longer synthetic.
    const adopted = adoptStartedRun(errored, {
      runId: "2026-10-01T00-00-00-000Z_x_abc123",
      runDir: "/artifacts/2026-10-01T00-00-00-000Z_x_abc123",
    });
    expect(adopted).toMatchObject({
      status: "errored",
      runId: "2026-10-01T00-00-00-000Z_x_abc123",
      runDir: "/artifacts/2026-10-01T00-00-00-000Z_x_abc123",
    });
    expect(adopted.synthetic).toBeUndefined();
    expect(adoptStartedRun(errored, undefined)).toBe(errored);
  });

  it("ranks exit 7 between success and errored when merging iterations", () => {
    expect(mergeExitCodes(0, 7, false)).toBe(7);
    expect(mergeExitCodes(7, 2, false)).toBe(2);
    expect(mergeExitCodes(1, 7, false)).toBe(1);
    expect(mergeExitCodes(7, 0, false)).toBe(7);
  });
});
