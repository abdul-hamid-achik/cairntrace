import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WaitResultSchema } from "../../core/gates/schema";
import { runWait } from "./wait";

/**
 * `cairn wait` / MCP `cairn_wait` (runWait): config gate names, URL targets
 * with --status, stable/timeout overrides, and the exit-code contract.
 */

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-wait-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
  await rm(dir, { recursive: true, force: true });
});

async function sequenceServer(statuses: number[]): Promise<string> {
  let hits = 0;
  const server = createServer((_req, res) => {
    res.statusCode = statuses[Math.min(hits, statuses.length - 1)]!;
    hits += 1;
    res.end("x");
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("runWait", () => {
  it("waits a config gate by name and a URL, in order", async () => {
    const api = await sequenceServer([503, 200]);
    const web = await sequenceServer([200]);
    const config = join(dir, "cairntrace.config.yml");
    await writeFile(
      config,
      `version: 1
environments:
  local: {}
gates:
  api:
    http: { url: "${api}/ready" }
    every: 20ms
`,
    );
    const result = await runWait({
      targets: ["api", `${web}/`],
      config,
      stable: 1,
    });
    expect(WaitResultSchema.parse(result)).toMatchObject({
      ok: true,
      exitCode: 0,
      config,
    });
    expect(
      result.gates.map((gate) => [gate.name, gate.ok, gate.attempts]),
    ).toEqual([
      ["api", true, 2],
      [`${web}/`, true, 1],
    ]);
  });

  it("applies --status to URL targets and stops at the first failure", async () => {
    const unauthorized = await sequenceServer([401]);
    const accepted = await runWait({
      targets: [`${unauthorized}/`],
      status: "2xx,401",
    });
    expect(accepted.ok).toBe(true);
    const rejected = await runWait({
      targets: [`${unauthorized}/`, "tcp://127.0.0.1:1"],
      timeout: "200ms",
      every: "50ms",
    });
    expect(rejected).toMatchObject({ ok: false, exitCode: 1 });
    expect(rejected.gates).toHaveLength(1);
    expect(rejected.gates[0]).toMatchObject({ timedOut: true, budgetMs: 200 });
    expect(rejected.gates[0]?.lastDetail).toContain("→ 401 (want 2xx|3xx)");
  });

  it("reports invalid input as exit 4 without waiting", async () => {
    expect(await runWait({ targets: [] })).toMatchObject({ exitCode: 4 });
    expect(
      await runWait({ targets: ["http://127.0.0.1:1/"], status: "2x" }),
    ).toMatchObject({
      exitCode: 4,
      error: expect.stringContaining("--status"),
    });
    expect(
      await runWait({ targets: ["http://127.0.0.1:1/"], timeout: "soon" }),
    ).toMatchObject({ exitCode: 4 });
    const config = join(dir, "cairntrace.config.yml");
    await writeFile(config, "version: 1\nenvironments:\n  local: {}\n");
    expect(
      await runWait({ targets: ["missing"], config, cwd: dir }),
    ).toMatchObject({
      exitCode: 4,
      error: expect.stringContaining('unknown gate "missing"'),
    });
    await writeFile(
      config,
      "version: 1\nenvironments:\n  local: {}\ngates:\n  bad: { stable: 2 }\n",
    );
    expect(await runWait({ targets: ["bad"], config })).toMatchObject({
      exitCode: 4,
      error: expect.stringContaining("invalid config"),
    });
  });

  it("does not read a config for URL and tcp:// targets", async () => {
    // An unrelated, invalid config above the cwd must not fail a port wait.
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      "version: 1\nproject: x\nenvironments: {}\nwebServer: { command: 1 }\n",
    );
    const url = await sequenceServer([200]);
    const result = await runWait({
      targets: [`${url}/`, "tcp://127.0.0.1:1"],
      timeout: "300ms",
      every: "50ms",
      cwd: dir,
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.error).toBeUndefined();
    expect(result.config).toBeUndefined();
    expect(result.gates.map((gate) => gate.ok)).toEqual([true, false]);
  });

  it("is cancellable", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runWait({
      targets: ["tcp://127.0.0.1:1"],
      timeout: "30s",
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.gates[0]?.cancelled).toBe(true);
  });
});

describe("cairn wait (CLI)", () => {
  it("prints the wait:v1 document and exits 0 / 1", async () => {
    const url = await sequenceServer([200]);
    const runCli = (
      args: string[],
    ): Promise<{ code: number | null; stdout: string }> =>
      new Promise((resolveRun) => {
        const child = spawn("bun", [BIN, "wait", ...args], {
          cwd: dir,
          env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
        });
        let stdout = "";
        child.stdout.on(
          "data",
          (chunk: Buffer) => (stdout += chunk.toString()),
        );
        child.on("close", (code) => resolveRun({ code, stdout }));
      });
    const ready = await runCli([`${url}/health`, "--json"]);
    expect(ready.code).toBe(0);
    expect(WaitResultSchema.parse(JSON.parse(ready.stdout))).toMatchObject({
      ok: true,
    });
    const notReady = await runCli([
      "tcp://127.0.0.1:1",
      "--timeout",
      "200ms",
      "--every",
      "50ms",
      "--json",
    ]);
    expect(notReady.code).toBe(1);
  }, 30_000);
});
