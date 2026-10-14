import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../../core/schema/events.v1";
import {
  executeRunInvocation,
  type RunInvocationResult,
} from "./executeRunInvocation";

/**
 * Critical cleanup (`afterCritical`, suite or `--after-critical`): a failed,
 * timed-out or unspawnable critical command settles the invocation on exit 8
 * (above the specs' own code), while plain `after` hooks never change the
 * exit code. Against the mock backend, stub shell commands and a temp dir.
 */

let dir: string;
/** Run artifacts live outside the project (as a real artifact root does). */
let runsRoot: string;
let counter = 0;

const spec = (name: string): string => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;
const failing = (name: string): string =>
  spec(name).replace('matches: "/home"', 'matches: "/never"');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-after-critical-"));
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-after-critical-runs-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", "alpha.yml"), spec("alpha"));
  await writeFile(join(dir, "flows", "broken.yml"), failing("broken"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(runsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
});

async function config(body: string, name = `cfg-${counter}`): Promise<string> {
  const path = join(dir, `${name}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: after-critical-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${body}`,
  );
  return path;
}

async function run(
  configPath: string,
  options: Record<string, unknown> = {},
  specs: string[] = [],
): Promise<RunInvocationResult> {
  return executeRunInvocation(
    {
      specs: specs.map((s) => join(dir, s)),
      options: {
        mock: true,
        config: configPath,
        artifactRoot: join(runsRoot, `runs-${counter}`),
        noWebServer: true,
        noServices: true,
        ...options,
      },
      cwd: dir,
    },
    { origin: "cli" },
  );
}

async function events(result: RunInvocationResult): Promise<RunEvent[]> {
  const text = await readFile(
    join(result.journalDir!, "events.ndjson"),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

async function lines(path: string): Promise<string[]> {
  return existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter(Boolean)
    : [];
}

interface CriticalEntry {
  index: number;
  command: string;
  path: string;
  exitCode?: number;
  timedOut?: boolean;
  source?: string;
  runId?: string;
}

/** The printed document, with the fields these tests read. */
interface PrintedDocument {
  exitCode: number;
  status: string;
  runId: string;
  invocationOutcome?: {
    exitCode: number;
    specsExitCode: number;
    error?: string;
    runPolicy?: { criticalTeardown?: CriticalEntry[] };
  };
}

function printed(result: RunInvocationResult): PrintedDocument {
  return result.document as unknown as PrintedDocument;
}

function criticalOf(result: RunInvocationResult): CriticalEntry[] {
  return printed(result).invocationOutcome?.runPolicy?.criticalTeardown ?? [];
}

describe("suite afterCritical", () => {
  it("keeps cleanup critical when optional suite hooks are blank", async () => {
    const cfg = await config(`suites:
  held:
    specs: [flows/alpha.yml]
    after: ["   "]
    afterCritical: ["   ", "exit 4"]
`);
    const result = await run(cfg, { suite: "held" });
    expect(result.exitCode).toBe(8);
    expect(criticalOf(result)).toEqual([
      expect.objectContaining({ source: "suite.afterCritical", exitCode: 4 }),
    ]);
  });

  it("settles a passing invocation on exit 8 when an afterCritical command exits non-zero", async () => {
    const cfg = await config(`suites:
  held:
    specs: [flows/alpha.yml]
    afterCritical: ["exit 3"]
`);
    const result = await run(cfg, { suite: "held" });
    expect(result.exitCode).toBe(8);
    expect(result.documents).toHaveLength(1);
    const doc = printed(result);
    expect(doc.exitCode).toBe(8);
    expect(doc.status).toBe("errored");
    expect(doc.invocationOutcome).toMatchObject({
      exitCode: 8,
      specsExitCode: 0,
      error: expect.stringContaining("critical teardown failed"),
    });
    expect(criticalOf(result)).toHaveLength(1);
    expect(criticalOf(result)[0]).toMatchObject({
      index: 0,
      path: "teardown",
      source: "suite.afterCritical",
      exitCode: 3,
    });
    const all = await events(result);
    expect(all.find((e) => e.type === "suite.finished")).toMatchObject({
      exitCode: 8,
    });
  });

  it("keeps a plain suite after hook at exit 0 when it exits non-zero (regression)", async () => {
    const cfg = await config(`suites:
  forgiving:
    specs: [flows/alpha.yml]
    after: ["exit 3"]
`);
    const result = await run(cfg, { suite: "forgiving" });
    expect(result.exitCode).toBe(0);
    expect(criticalOf(result)).toEqual([]);
  });

  it("settles on exit 8 when an afterCritical command times out, and names it timed out", async () => {
    const cfg = await config(`suites:
  stuck:
    specs: [flows/alpha.yml]
    afterCritical: ["sleep 30"]
    hookTimeoutMs: 400
`);
    const started = Date.now();
    const result = await run(cfg, { suite: "stuck" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.exitCode).toBe(8);
    expect(criticalOf(result)[0]).toMatchObject({
      source: "suite.afterCritical",
      timedOut: true,
    });
  });

  it("settles on exit 8 when an afterCritical command cannot be spawned", async () => {
    const cfg = await config(`suites:
  unspawnable:
    specs: [flows/alpha.yml]
    afterCritical: ["/nonexistent/cmd-xyz"]
`);
    const result = await run(cfg, { suite: "unspawnable" });
    expect(result.exitCode).toBe(8);
    expect(criticalOf(result)).toHaveLength(1);
    expect(criticalOf(result)[0]).toMatchObject({
      source: "suite.afterCritical",
    });
  });

  it("stays at exit 0 when afterCritical succeeds, and runs it once", async () => {
    const marks = join(dir, `marks-ok-${counter}.txt`);
    const cfg = await config(`suites:
  clean:
    specs: [flows/alpha.yml]
    afterCritical: ['echo critical >> "${marks}"']
`);
    const result = await run(cfg, { suite: "clean" });
    expect(result.exitCode).toBe(0);
    expect(criticalOf(result)).toEqual([]);
    expect(await lines(marks)).toEqual(["critical"]);
  });

  it("settles a failed spec on exit 8 (above its own exit 1) when afterCritical fails too", async () => {
    const cfg = await config(`suites:
  red-held:
    specs: [flows/broken.yml]
    afterCritical: ["exit 3"]
`);
    const result = await run(cfg, { suite: "red-held" });
    expect(result.exitCode).toBe(8);
    expect(printed(result).invocationOutcome).toMatchObject({
      exitCode: 8,
      specsExitCode: 1,
    });
  });

  it("runs afterCritical after the plain after hooks, in the suite's order", async () => {
    const marks = join(dir, `marks-order-${counter}.txt`);
    const cfg = await config(`suites:
  ordered:
    specs: [flows/alpha.yml]
    after: ['echo plain >> "${marks}"']
    afterCritical: ['echo critical >> "${marks}"']
`);
    const result = await run(cfg, { suite: "ordered" });
    expect(result.exitCode).toBe(0);
    expect(await lines(marks)).toEqual(["plain", "critical"]);
  });
});

describe("--after-critical option", () => {
  it("settles a passing run on exit 8, naming the run it ran for", async () => {
    const cfg = await config("");
    const result = await run(cfg, { afterCritical: ["exit 5"] }, [
      "flows/alpha.yml",
    ]);
    expect(result.exitCode).toBe(8);
    const doc = printed(result);
    expect(doc.exitCode).toBe(8);
    expect(doc.invocationOutcome).toMatchObject({
      exitCode: 8,
      specsExitCode: 0,
    });
    expect(criticalOf(result)[0]).toMatchObject({
      source: "afterCritical",
      exitCode: 5,
      runId: doc.runId,
    });
  });

  it("stays at exit 0 when the command succeeds", async () => {
    const cfg = await config("");
    const result = await run(cfg, { afterCritical: ["true"] }, [
      "flows/alpha.yml",
    ]);
    expect(result.exitCode).toBe(0);
    expect(criticalOf(result)).toEqual([]);
  });

  it("keeps a plain --after failure at exit 0", async () => {
    const cfg = await config("");
    const result = await run(cfg, { after: ["exit 5"] }, ["flows/alpha.yml"]);
    expect(result.exitCode).toBe(0);
    expect(criticalOf(result)).toEqual([]);
  });
});

describe("--after-critical documents", () => {
  it("hands over a passed document only after the cleanup finished", async () => {
    const cfg = await config("");
    const marker = join(dir, `cleaned-${counter}`);
    const seen: Array<{ cleaned: boolean; status: string; exitCode: number }> =
      [];
    const result = await executeRunInvocation(
      {
        specs: [join(dir, "flows", "alpha.yml")],
        options: {
          mock: true,
          config: cfg,
          artifactRoot: join(runsRoot, `runs-${counter}`),
          noWebServer: true,
          noServices: true,
          afterCritical: [`sleep 0.4; touch "${marker}"`],
        },
        cwd: dir,
      },
      {
        origin: "cli",
        onDocument: (document) => {
          const doc = document as unknown as PrintedDocument;
          seen.push({
            cleaned: existsSync(marker),
            status: doc.status,
            exitCode: doc.exitCode,
          });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([{ cleaned: true, status: "passed", exitCode: 0 }]);
  });

  it("holds every document of a batch and of --repeat until the verdict", async () => {
    const cfg = await config("");
    const batch = await run(cfg, { afterCritical: ["exit 2"] }, [
      "flows/alpha.yml",
      "flows/broken.yml",
    ]);
    expect(batch.exitCode).toBe(8);
    expect(batch.documents).toHaveLength(1);
    const batchDoc = batch.document as unknown as PrintedDocument;
    expect(batchDoc.exitCode).toBe(8);
    expect(
      batchDoc.invocationOutcome?.runPolicy?.criticalTeardown,
    ).toHaveLength(2);
    counter += 1;
    const repeated = await run(cfg, { afterCritical: ["exit 2"], repeat: 2 }, [
      "flows/alpha.yml",
    ]);
    expect(repeated.exitCode).toBe(8);
    for (const doc of repeated.documents) {
      expect((doc as unknown as PrintedDocument).exitCode).toBe(8);
    }
    expect(
      (repeated.document as unknown as PrintedDocument).invocationOutcome
        ?.specsExitCode,
    ).toBe(0);
  });
});
