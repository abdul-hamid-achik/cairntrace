import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunEventSchema } from "../../core/schema/events.v1";
import { executeRunInvocation } from "./executeRunInvocation";
import { runOptionsToArgv } from "./options";

/**
 * F3b at the invocation level: a suite fixture is ensured once for the
 * whole `cairn run` (whichever run needs it first; parallel runs wait on
 * the same ensure), shared by every run, and torn down when the invocation
 * ends — journaled in `_invocations/<id>/events.ndjson`.
 */

let dir: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-fixture-invocation-"));
  log = join(dir, "fixture.log");
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
project: suitedemo
defaultEnvironment: local
environments:
  local: {}
  shared:
    policy: { trait: shared }
fixtures:
  workspace:
    kind: exec
    scope: suite
    ensure: 'echo "ensure" >> "${log}"; echo "{\\"id\\":\\"w-1\\"}"'
    teardown: 'echo "teardown \${fixtures.workspace.id}" >> "${log}"'
    outputs: { id: "$.id" }
`,
  );
  for (const name of ["first", "second", "third"]) {
    await writeFile(
      join(dir, `${name}.yml`),
      `version: 1
name: ${name}_flow
intent: A flow in a workspace shared by the suite.
coldStart: guest
fixtures: [workspace]
steps:
  - open: https://demo.example.test/w/\${fixtures.workspace.id}/${name}
outcomes:
  - id: opened
    description: the workspace page is open
    verify: { url: { matches: "/w/w-1/${name}" } }
`,
    );
  }
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("suite fixtures across an invocation", () => {
  it("ensures once for parallel runs and tears down at the end", async () => {
    const result = await executeRunInvocation(
      {
        specs: ["first.yml", "second.yml", "third.yml"].map((f) =>
          join(dir, f),
        ),
        options: {
          mock: true,
          parallel: 2,
          artifactRoot: join(dir, "runs"),
          noServices: true,
          noWebServer: true,
        },
        cwd: dir,
      },
      { origin: "mcp" },
    );
    expect(result).toMatchObject({ kind: "batch", exitCode: 0 });
    expect(await lines(log)).toEqual(["ensure", "teardown w-1"]);
    const journal = (
      await lines(join(result.journalDir!, "events.ndjson"))
    ).map((line) => RunEventSchema.parse(JSON.parse(line)));
    expect(
      journal
        .filter((event) => event.type.startsWith("fixture."))
        .map(
          (event) => `${event.type}:${(event as { status: string }).status}`,
        ),
    ).toEqual(["fixture.ensure:ok", "fixture.teardown:ok"]);
    // Every run recorded the fixture it used.
    for (const runDir of result.runDirs ?? []) {
      const ledger = JSON.parse(
        await readFile(join(runDir, "fixtures.json"), "utf8"),
      );
      expect(ledger.entries).toEqual([
        expect.objectContaining({
          name: "workspace",
          scope: "suite",
          outputs: { id: "w-1" },
        }),
      ]);
    }
  }, 60_000);

  it("passes --allow-fixture-writes through to the runs (shared environment)", async () => {
    const dry = await executeRunInvocation(
      {
        specs: [join(dir, "first.yml")],
        options: {
          mock: true,
          env: "shared",
          artifactRoot: join(dir, "runs"),
          noServices: true,
          noWebServer: true,
        },
        cwd: dir,
      },
      { origin: "mcp" },
    );
    // Dry-run: no outputs to splice — the run errors in phase fixture
    // before the browser, instead of opening a page with a literal
    // placeholder.
    expect(dry.exitCode).toBe(2);
    const dryRun = JSON.parse(
      await readFile(join(dry.runDirs![0]!, "run.json"), "utf8"),
    );
    expect(dryRun.failure).toMatchObject({
      phase: "fixture",
      name: "workspace",
    });
    expect(dryRun.failure.message).toMatch(
      /\$\{fixtures\.workspace\.id\} has no value/,
    );
    expect(await lines(log)).toEqual([]);
    const options = {
      mock: true,
      env: "shared",
      allowFixtureWrites: true,
      artifactRoot: join(dir, "runs"),
      noServices: true,
      noWebServer: true,
    };
    expect(runOptionsToArgv(["first.yml"], options)).toContain(
      "--allow-fixture-writes",
    );
    const wrote = await executeRunInvocation(
      { specs: [join(dir, "first.yml")], options, cwd: dir },
      { origin: "mcp" },
    );
    expect(wrote.exitCode).toBe(0);
    expect(await lines(log)).toEqual(["ensure", "teardown w-1"]);
  }, 60_000);
});
