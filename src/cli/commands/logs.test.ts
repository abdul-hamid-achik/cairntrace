import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsCommand } from "./logs";

let runsRoot: string;
let servicesRoot: string;
let captured: string[];
// Only mockRestore is touched; the concrete overloaded write() spy type is
// noise this test never uses.
let writeSpy: { mockRestore(): void };

async function writeRun(
  name: string,
  mtimeOffsetMs: number,
  runJson?: Record<string, unknown>,
): Promise<string> {
  const dir = join(runsRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.ndjson"), '{"type":"run.started"}\n');
  if (runJson) {
    await writeFile(join(dir, "run.json"), JSON.stringify(runJson));
  }
  // Stagger mtimes so "newest first" is deterministic.
  const at = new Date(Date.now() - mtimeOffsetMs);
  const { utimes } = await import("node:fs/promises");
  await utimes(dir, at, at);
  return dir;
}

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-logs-runs-"));
  servicesRoot = await mkdtemp(join(tmpdir(), "cairn-logs-services-"));
  process.env.CAIRN_SERVICES_LOG_ROOT = servicesRoot;
  captured = [];
  writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.push(String(chunk));
      return true;
    });
  process.exitCode = 0;
});

afterEach(() => {
  writeSpy.mockRestore();
  delete process.env.CAIRN_SERVICES_LOG_ROOT;
  process.exitCode = 0;
});

describe("cairn logs", () => {
  it("lists runs newest first with a verdict or in-progress marker", async () => {
    await writeRun("older_run", 60_000, {
      status: "passed",
      durationMs: 84_000,
      outcomes: [{ status: "passed" }],
    });
    await writeRun("newer_run", 1_000);

    await logsCommand(undefined, { artifactRoot: runsRoot });

    const text = captured.join("");
    expect(text.indexOf("newer_run")).toBeLessThan(text.indexOf("older_run"));
    // run.json absent = the run is live or was killed; say so instead of
    // pretending a verdict exists.
    expect(text).toContain("in progress / interrupted");
    expect(text).toContain("passed 1/1 in 1m 24s");
  });

  it("shows one run's files with sizes and its replay hint", async () => {
    const dir = await writeRun("solo_run", 0, {
      status: "failed",
      durationMs: 5_000,
      outcomes: [{ status: "failed" }],
    });
    await mkdir(join(dir, "diagnostics"), { recursive: true });
    await writeFile(join(dir, "diagnostics", "001_step.json"), "{}");

    await logsCommand("solo_run", { artifactRoot: runsRoot });

    const text = captured.join("");
    expect(text).toContain("failed 0/1 in 5.0s");
    expect(text).toContain("events.ndjson");
    expect(text).toContain("diagnostics/");
    expect(text).toContain("1 file");
    expect(text).toContain("cairn logs solo_run --events");
  });

  it("replays events.ndjson verbatim with --events", async () => {
    await writeRun("event_run", 0);

    await logsCommand("event_run", { artifactRoot: runsRoot, events: true });

    expect(captured.join("")).toContain('{"type":"run.started"}');
    expect(process.exitCode).toBe(0);
  });

  it("streams a pane log matched by tmux window name", async () => {
    await writeFile(
      join(servicesRoot, "graphite-web-api.pane.log"),
      "Listening on port 9001\n",
    );

    await logsCommand(undefined, { service: "web-api" });

    expect(captured.join("")).toContain("Listening on port 9001");
    expect(process.exitCode).toBe(0);
  });

  it("fails loudly when the window has no captured pane log", async () => {
    await logsCommand(undefined, { service: "nope" });
    expect(process.exitCode).toBe(2);
  });
});
