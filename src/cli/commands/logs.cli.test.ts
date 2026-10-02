import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

/**
 * `cairn logs --follow/--log/--invocation` through the real CLI (option
 * parsing included), not only `logsCommand()` in-process. The options are
 * registered in src/cli/index.ts.
 */
const CAIRN = join(process.cwd(), "bin", "cairn");

const RUN_ID = "2026-10-01T00-00-00-000Z_demo_cli_aaaaaa";
const INVOCATION_ID = "2026-10-01T00-00-00-000Z_2147483000_a1b2c3";

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cairn-logs-cli-"));
  const runDir = join(root, RUN_ID);
  await mkdir(join(runDir, "logs"), { recursive: true });
  await writeFile(
    join(runDir, "events.ndjson"),
    '{"type":"run.started"}\n{"type":"run.passed"}\n',
  );
  await writeFile(join(runDir, "run.log"), "[00:00:01] run start: demo\n");
  await writeFile(join(runDir, "artifact-manifest.json"), "{}");
  const journalDir = join(root, "_invocations", INVOCATION_ID);
  await mkdir(join(journalDir, "logs"), { recursive: true });
  await writeFile(
    join(journalDir, "invocation.json"),
    JSON.stringify({
      version: 1,
      invocationId: INVOCATION_ID,
      pid: 2_147_483_000,
      argv: ["run", "a.yml"],
      cwd: "/work",
      parallel: 1,
      planned: [{ index: 1, spec: "a.yml" }],
      status: "passed",
      startedAt: "2026-10-01T00:00:00.000Z",
      endedAt: "2026-10-01T00:00:05.000Z",
      runs: [],
    }),
  );
  await writeFile(
    join(journalDir, "logs", "narration.log"),
    "[00:00:00] start\n",
  );
  return root;
}

describe("cairn logs live flags (CLI)", () => {
  it("registers --follow, --log, --invocation and --format/--json", async () => {
    const help = await execa(CAIRN, ["logs", "--help"], {
      reject: false,
      timeout: 20_000,
    });
    for (const flag of [
      "--follow",
      "--log <",
      "--invocation <",
      "--format <",
      "--json",
    ]) {
      expect(help.stdout).toContain(flag);
    }
  }, 30_000);

  it("follows a settled run, prints one log, and reads an invocation", async () => {
    const root = await artifactRoot();
    const cli = (args: string[]) =>
      execa(CAIRN, ["logs", ...args, "--artifact-root", root], {
        reject: false,
        timeout: 20_000,
      });

    const follow = await cli([RUN_ID, "--follow"]);
    expect(follow.exitCode, follow.stderr).toBe(0);
    expect(follow.stdout).toBe('{"type":"run.started"}\n{"type":"run.passed"}');

    const runLog = await cli(["latest", "--log", "run"]);
    expect(runLog.exitCode, runLog.stderr).toBe(0);
    expect(runLog.stdout).toBe("[00:00:01] run start: demo");

    const summary = await cli(["--invocation", "latest", "--json"]);
    expect(summary.exitCode, summary.stderr).toBe(0);
    expect(JSON.parse(summary.stdout)).toMatchObject({
      invocationId: INVOCATION_ID,
      status: "passed",
    });

    const narration = await cli([
      "--invocation",
      INVOCATION_ID,
      "--follow",
      "--log",
      "narration",
    ]);
    expect(narration.exitCode, narration.stderr).toBe(0);
    expect(narration.stdout).toBe("[00:00:00] start");
  }, 40_000);
});
