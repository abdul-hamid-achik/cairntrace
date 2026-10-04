import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SuitesListResultSchema } from "../../core/catalog/catalog.v1";

/**
 * The real `bin/cairn` against config suites: `cairn run --suite` (mock
 * backend, hooks, label), the usage error next to spec paths (exit 2) and
 * with no spec at all, an unknown suite (exit 4), `cairn suites list --json`
 * and `cairn config validate` on a suite that resolves to nothing.
 */

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

let dir: string;
let runs: string;
const spawned: ChildProcess[] = [];

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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-suite-cli-"));
  runs = await mkdtemp(join(tmpdir(), "cairn-suite-cli-runs-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", "one.yml"), spec("cli_one"));
  await writeFile(join(dir, "flows", "two.yml"), spec("cli_two"));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
project: suite-cli
defaultEnvironment: local
artifactRoot: ${JSON.stringify(runs)}
environments:
  local:
    baseUrl: https://demo.example.test
suites:
  both:
    specs: [flows]
    after: ['echo done > "${join(dir, "after.mark")}"']
  broken:
    specs: [flows/missing.yml]
`,
  );
});

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(runs, { recursive: true, force: true });
});

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cairn(args: string[]): Promise<Finished> {
  const child = spawn("bun", [BIN, ...args], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const MOCK = ["--mock", "--no-services", "--no-web-server"];

describe("cairn run --suite", () => {
  it("runs the suite, labels the runs and runs its after hook", async () => {
    const done = await cairn(["run", "--suite", "both", ...MOCK, "--json"]);
    expect(done.code).toBe(0);
    const batch = JSON.parse(done.stdout) as {
      results: Array<{
        spec: { name: string };
        labels?: Record<string, string>;
      }>;
    };
    expect(batch.results.map((r) => r.spec.name)).toEqual([
      "cli_one",
      "cli_two",
    ]);
    expect(batch.results[0]!.labels).toMatchObject({ suite: "both" });
    expect((await readFile(join(dir, "after.mark"), "utf8")).trim()).toBe(
      "done",
    );
    expect(done.stderr).toContain('starting suite "both"');
  }, 60_000);

  it("narrows to a spec path of its own, and is a usage error (exit 2) for another one or nothing to run", async () => {
    const both = await cairn([
      "run",
      "--suite",
      "both",
      "flows/one.yml",
      ...MOCK,
    ]);
    // A path next to --suite narrows it to that spec; one outside it is a
    // usage error.
    expect(both.code).toBe(0);
    const outside = await cairn([
      "run",
      "--suite",
      "both",
      "flows/elsewhere.yml",
      ...MOCK,
    ]);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("is not among them");
    const none = await cairn(["run", ...MOCK]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain(
      "at least one spec path is required (or --suite <name>)",
    );
  }, 60_000);

  it("exits 4 for an unknown suite and for one whose spec is missing", async () => {
    const unknown = await cairn(["run", "--suite", "nope", ...MOCK]);
    expect(unknown.code).toBe(4);
    expect(unknown.stderr).toContain('unknown suite "nope"');
    const broken = await cairn(["run", "--suite", "broken", ...MOCK]);
    expect(broken.code).toBe(4);
    expect(broken.stderr).toContain("flows/missing.yml");
  }, 60_000);
});

describe("cairn suites list / config validate", () => {
  it("lists suites as JSON with their resolved specs", async () => {
    const done = await cairn(["suites", "list", "--json"]);
    expect(done.code).toBe(0);
    const list = SuitesListResultSchema.parse(JSON.parse(done.stdout));
    const both = list.suites.find((s) => s.name === "both")!;
    expect(both.envs[0]).toMatchObject({
      env: "local",
      specs: ["flows/one.yml", "flows/two.yml"],
      after: 1,
    });
    const broken = list.suites.find((s) => s.name === "broken")!;
    expect(broken.envs[0]!.problem).toContain("flows/missing.yml");
    const md = await cairn(["suites", "list"]);
    expect(md.stdout).toContain("## both");
  }, 60_000);

  it("config validate reports the suite that resolves to nothing (exit 4)", async () => {
    const done = await cairn(["config", "validate", "--json"]);
    expect(done.code).toBe(4);
    const result = JSON.parse(done.stdout) as { errors: string[] };
    expect(result.errors.join("\n")).toContain("suites.broken");
  }, 60_000);
});
