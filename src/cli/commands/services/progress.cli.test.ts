import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Live boot progress of the real `bin/cairn`: `services up --json` and the
 * service boot of `cairn run --json` show the provisioner's `up` output on
 * stderr WHILE it runs (stdout stays one document), and the logger's
 * --quiet / --log-format json / config `logging:` rules apply. A temp HOME,
 * a temp project and a fake shell `up` command; no docker, tmux or network.
 */

const BIN = join(import.meta.dirname, "..", "..", "..", "..", "bin", "cairn");

let dir: string;
let home: string;
let gate: string;
const spawned: ChildProcess[] = [];

const SPEC = `version: 1
name: progress_demo
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-progress-cli-"));
  home = await mkdtemp(join(tmpdir(), "cairn-progress-home-"));
  gate = join(dir, "gate");
  await writeFile(join(dir, "pass.yml"), SPEC);
});

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(logging = ""): Promise<string> {
  const path = join(dir, "cairntrace.config.yml");
  await writeFile(
    path,
    `version: 1
project: progress-cli-${process.pid}
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${logging}services:
  provisioner:
    up: 'printf "early-%s\\n" progress; while [ ! -f "${gate}" ]; do sleep 0.05; done; printf "late-%s\\n" progress'
    down: "true"
`,
  );
  return path;
}

interface Live {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: () => boolean;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function cairn(args: string[]): Live {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    NO_COLOR: "1",
  };
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "CAIRN_CI",
    "CAIRN_LOG_LEVEL",
    "CAIRN_LOG_FORMAT",
  ]) {
    delete env[key];
  }
  const child = spawn("bun", [BIN, ...args], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  let stdout = "";
  let stderr = "";
  let exited = false;
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      exited = true;
      resolve({ code, stdout, stderr });
    });
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: () => exited,
    done,
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Run to completion: release the `up` command once its first line showed. */
async function runWithGate(
  args: string[],
  opts: { expectLive: boolean },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const live = cairn(args);
  if (opts.expectLive) {
    await until(
      () => live.stderr().includes("early-progress") || live.exited(),
      "live progress on stderr",
    );
    // Seen BEFORE the child finished, and stdout holds nothing yet.
    expect(live.exited()).toBe(false);
    expect(existsSync(gate)).toBe(false);
    expect(live.stdout()).toBe("");
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  await writeFile(gate, "go");
  return live.done;
}

const SERVICES_UP = ["services", "up", "--json"];

describe("cairn services up --json boot progress", () => {
  it("streams the up command's lines on stderr before it finishes; stdout is one document", async () => {
    const config = await writeConfig();
    const out = await runWithGate([...SERVICES_UP, "--config", config], {
      expectLive: true,
    });
    expect(out.code).toBe(0);
    const doc = JSON.parse(out.stdout) as { ok: boolean };
    expect(doc.ok).toBe(true);
    expect(out.stderr).toContain("early-progress");
    expect(out.stderr).toContain("late-progress");
    expect(out.stdout).not.toContain("early-progress");
  });

  it("--quiet shows no progress", async () => {
    const config = await writeConfig();
    const out = await runWithGate(
      ["--quiet", ...SERVICES_UP, "--config", config],
      { expectLive: false },
    );
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true });
    expect(out.stderr).not.toContain("early-progress");
  });

  it("--log-format json writes the progress as NDJSON entries", async () => {
    const config = await writeConfig();
    const out = await runWithGate(
      ["--log-format", "json", ...SERVICES_UP, "--config", config],
      { expectLive: true },
    );
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true });
    const entries = out.stderr
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { msg: string; stream?: string });
    expect(entries).toContainEqual(
      expect.objectContaining({ msg: "early-progress", stream: "raw" }),
    );
  });

  it("config logging.level warn hides the progress", async () => {
    const config = await writeConfig("logging:\n  level: warn\n");
    const out = await runWithGate([...SERVICES_UP, "--config", config], {
      expectLive: false,
    });
    expect(out.code).toBe(0);
    expect(out.stderr).not.toContain("early-progress");
  });

  it("config logging.level debug shows the progress", async () => {
    const config = await writeConfig("logging:\n  level: debug\n");
    const out = await runWithGate([...SERVICES_UP, "--config", config], {
      expectLive: true,
    });
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("early-progress");
  });

  it("flags win over config logging.level debug: --quiet hides the progress", async () => {
    const config = await writeConfig("logging:\n  level: debug\n");
    const out = await runWithGate(
      ["--quiet", ...SERVICES_UP, "--config", config],
      { expectLive: false },
    );
    expect(out.code).toBe(0);
    expect(out.stderr).not.toContain("early-progress");
  });
});

describe("cairn run --json service boot progress", () => {
  it("shows the same live progress; stdout stays one document", async () => {
    const config = await writeConfig();
    const out = await runWithGate(
      [
        "run",
        "pass.yml",
        "--json",
        "--mock",
        "--no-web-server",
        "--config",
        config,
        "--artifact-root",
        join(dir, "runs"),
      ],
      { expectLive: true },
    );
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ status: "passed" });
    expect(out.stderr).toContain("early-progress");
    expect(out.stdout).not.toContain("early-progress");
  });

  it("--quiet hides it", async () => {
    const config = await writeConfig();
    const out = await runWithGate(
      [
        "--quiet",
        "run",
        "pass.yml",
        "--json",
        "--mock",
        "--no-web-server",
        "--config",
        config,
        "--artifact-root",
        join(dir, "runs"),
      ],
      { expectLive: false },
    );
    expect(out.code).toBe(0);
    expect(out.stderr).not.toContain("early-progress");
  });
});
