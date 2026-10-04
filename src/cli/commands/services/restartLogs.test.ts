import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { supervisorMarkerPath } from "../../../core/servicesOps/supervisorMarker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServicesLogsResultSchema,
  ServicesRestartResultSchema,
} from "../../../core/schema/services.v1";
import { generationMarker } from "../../../core/servicesOps/generation";
import { createFakeTmux, type FakeTmux } from "../../../testing/fakeTmux";
import { newLines, renderServicesLogsMarkdown, servicesLogs } from "./logs";
import {
  parseDurationFlag,
  renderServicesRestartMarkdown,
  servicesRestart,
} from "./restart";
import { ServicesCommandError } from "./target";

/**
 * `cairn services restart` and `cairn services logs` against a stub tmux:
 * the stable JSON results, the exit codes (0 / 1 / 2 / 4) and redaction.
 */

let dir: string;
let configPath: string;
let fake: FakeTmux;
let undo: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-services-cli-"));
  configPath = join(dir, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
project: cli-ops
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
  bare:
    baseUrl: http://localhost:8081
    services: false
services:
  tmux:
    session: cli-ops
    windows:
      - name: web
        command: run-web
        readyOn: { text: "listening on 3000" }
      - name: worker
        command: run-worker
`,
  );
  fake = createFakeTmux();
  undo = fake.activate();
});
afterEach(async () => {
  undo();
  fake.cleanup();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("services restart", () => {
  it("restarts windows and returns the stable result", async () => {
    fake.seedRunning("cli-ops", ["web", "worker"]);
    fake.setOutput("cli-ops", "web", "listening on 3000\n");
    const result = await servicesRestart({
      config: configPath,
      windows: ["web"],
      stopTimeout: "5s",
      readyTimeout: "10s",
    });
    expect(ServicesRestartResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      project: "cli-ops",
      env: "local",
      session: "cli-ops",
      windows: [{ window: "web", ok: true, alreadyStopped: false }],
    });
    expect(result.events.map((e) => e.event)).toEqual([
      "start",
      "stop",
      "ready",
    ]);
    expect(renderServicesRestartMarkdown(result)).toContain("web: ready in");
    expect(fake.sent("cli-ops", "worker")).toHaveLength(0);
  });

  it("refuses with exit 4: unknown window, no session, an environment without services", async () => {
    fake.seedRunning("cli-ops", ["web", "worker"]);
    const unknown = await servicesRestart({
      config: configPath,
      windows: ["ghost"],
    });
    expect(unknown).toMatchObject({ ok: false, exitCode: 4 });
    expect(unknown.error).toMatch(
      /not a window of the configured tmux session "cli-ops"/,
    );
    expect(fake.callsOf("send-keys")).toHaveLength(0);

    const none = await servicesRestart({
      config: configPath,
      env: "bare",
      windows: ["web"],
    });
    expect(none).toMatchObject({ ok: false, exitCode: 4 });
    expect(none.error).toMatch(/no services configured for env "bare"/);

    fake.cleanup();
    undo();
    const emptyFake = createFakeTmux();
    fake = emptyFake;
    undo = emptyFake.activate();
    const noSession = await servicesRestart({
      config: configPath,
      windows: ["web"],
    });
    expect(noSession).toMatchObject({ ok: false, exitCode: 4 });
    expect(noSession.error).toMatch(/session "cli-ops" is not running/);
  });

  it("is exit 2 for usage errors and a window that does not restart", async () => {
    expect(
      await servicesRestart({
        config: configPath,
        windows: ["web"],
        stopTimeout: "soon",
      }),
    ).toMatchObject({ ok: false, exitCode: 2 });
    expect(
      await servicesRestart({ config: configPath, windows: [] }),
    ).toMatchObject({
      ok: false,
      exitCode: 2,
    });
    fake.seedRunning("cli-ops", ["web", "worker"]);
    fake.ignoreInterrupts("cli-ops", "worker", 99);
    const stuck = await servicesRestart({
      config: configPath,
      windows: ["worker"],
      stopTimeout: "1s",
    });
    expect(stuck).toMatchObject({ ok: false, exitCode: 2 });
    expect(stuck.windows[0]).toMatchObject({ window: "worker", ok: false });
    expect(stuck.error).toMatch(/did not exit within 1s/);
  });

  it("parses duration flags", () => {
    expect(parseDurationFlag("--x", "30s")).toBe(30_000);
    expect(parseDurationFlag("--x", "1500")).toBe(1500);
    expect(parseDurationFlag("--x", undefined)).toBeUndefined();
    expect(() => parseDurationFlag("--x", "soon")).toThrow(
      ServicesCommandError,
    );
  });
});

describe("services restart while a run supervises the session", () => {
  it("refuses with exit 4 when the supervisor is alive, and goes ahead when it is gone", async () => {
    fake.seedRunning("cli-ops", ["web", "worker"]);
    fake.setOutput("cli-ops", "web", "listening on 3000\n");
    const owner = spawn("sh", ["-c", "exec sleep 30"], {
      detached: true,
      stdio: "ignore",
    });
    owner.unref();
    const marker = supervisorMarkerPath(
      join(process.env.HOME!, ".cairntrace", "services"),
      "cli-ops",
    );
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(
      marker,
      JSON.stringify({
        version: 1,
        session: "cli-ops",
        pid: owner.pid,
        windows: ["web"],
      }),
    );
    try {
      const refused = await servicesRestart({
        config: configPath,
        windows: ["web"],
      });
      expect(refused).toMatchObject({ ok: false, exitCode: 4 });
      expect(refused.error).toMatch(
        /a cairn run \(pid \d+\) is supervising tmux session "cli-ops"/,
      );
      expect(fake.callsOf("send-keys")).toHaveLength(0);
    } finally {
      process.kill(-owner.pid!, "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const done = await servicesRestart({
      config: configPath,
      windows: ["web"],
      stopTimeout: "5s",
      readyTimeout: "10s",
    });
    expect(done).toMatchObject({ ok: true, exitCode: 0 });
    await rm(marker, { force: true });
  });
});

describe("services logs", () => {
  it("never reads (or restarts) a foreign session whose name starts with ours (exit 4)", async () => {
    fake.seedRunning("cli-ops-wt", ["web", "worker"]);
    fake.setPane("cli-ops-wt", "web", "foreign line\n");
    const logs = await servicesLogs({ config: configPath, window: "web" });
    expect(logs).toMatchObject({ ok: false, exitCode: 4 });
    expect(logs.error).toMatch(/tmux session "cli-ops" is not running/);
    expect(JSON.stringify(logs)).not.toContain("foreign line");
    const restart = await servicesRestart({
      config: configPath,
      windows: ["web"],
    });
    expect(restart).toMatchObject({ ok: false, exitCode: 4 });
    expect(fake.callsOf("send-keys")).toHaveLength(0);
  });

  it("returns the joined, redacted lines and the restart view", async () => {
    const secret = ["tok", "en", "-value-", String(process.pid)].join("");
    vi.stubEnv("OPS_API_TOKEN", secret);
    fake.seedRunning("cli-ops", ["web"]);
    fake.setPane(
      "cli-ops",
      "web",
      `old line\n${generationMarker("deadbeef")}\nnew line one\nbearer ${secret}\nnew line two\n`,
    );
    const all = await servicesLogs({ config: configPath, window: "web" });
    expect(ServicesLogsResultSchema.safeParse(all).success).toBe(true);
    expect(all).toMatchObject({
      ok: true,
      exitCode: 0,
      window: "web",
      session: "cli-ops",
    });
    expect(all.lines).toContain("old line");
    expect(JSON.stringify(all)).not.toContain(secret);
    const since = await servicesLogs({
      config: configPath,
      window: "web",
      sinceRestart: true,
    });
    expect(since.sinceRestart).toEqual({
      requested: true,
      found: true,
      generation: "deadbeef",
    });
    expect(since.lines).toEqual([
      "new line one",
      "bearer [redacted]",
      "new line two",
    ]);
    const tail = await servicesLogs({
      config: configPath,
      window: "web",
      sinceRestart: true,
      lines: 1,
    });
    expect(tail.lines).toEqual(["new line two"]);
    expect(tail.totalLines).toBe(3);
    expect(renderServicesLogsMarkdown(since)).toContain("new line one");
  });

  it("without a marker --since-restart shows everything and says so", async () => {
    fake.seedRunning("cli-ops", ["web"]);
    fake.setPane("cli-ops", "web", "only\nold\n");
    const result = await servicesLogs({
      config: configPath,
      window: "web",
      sinceRestart: true,
    });
    expect(result.sinceRestart).toEqual({ requested: true, found: false });
    expect(result.lines).toEqual(["only", "old"]);
    expect(renderServicesLogsMarkdown(result)).toContain("no restart marker");
  });

  it("--wait matches (exit 0), times out (exit 1), and refuses a bad regex (exit 2)", async () => {
    fake.seedRunning("cli-ops", ["web"]);
    fake.setPane("cli-ops", "web", "booting\nlistening on 3000\n");
    const matched = await servicesLogs({
      config: configPath,
      window: "web",
      wait: "listening on \\d+",
      timeout: "5s",
    });
    expect(matched).toMatchObject({ ok: true, exitCode: 0 });
    expect(matched.wait).toMatchObject({
      matched: true,
      line: "listening on 3000",
      timedOut: false,
    });
    const missed = await servicesLogs({
      config: configPath,
      window: "web",
      wait: "never printed",
      timeout: "600ms",
    });
    expect(missed).toMatchObject({ ok: false, exitCode: 1 });
    expect(missed.wait).toMatchObject({ matched: false, timedOut: true });
    expect(missed.error).toMatch(/no line matched/);
    const stale = await servicesLogs({
      config: configPath,
      window: "web",
      sinceRestart: true,
      wait: "listening on 3000",
      timeout: "400ms",
    });
    // No marker: the whole pane is the view, so the line is found.
    expect(stale.exitCode).toBe(0);
    expect(
      await servicesLogs({ config: configPath, window: "web", wait: "(" }),
    ).toMatchObject({ ok: false, exitCode: 2 });
  });

  it("refuses with exit 4: unknown window, no session, no tmux", async () => {
    fake.seedRunning("cli-ops", ["web"]);
    expect(
      await servicesLogs({ config: configPath, window: "ghost" }),
    ).toMatchObject({
      ok: false,
      exitCode: 4,
    });
    expect(
      await servicesLogs({ config: configPath, env: "bare", window: "web" }),
    ).toMatchObject({ ok: false, exitCode: 4 });
    fake.cleanup();
    undo();
    fake = createFakeTmux();
    undo = fake.activate();
    const noSession = await servicesLogs({ config: configPath, window: "web" });
    expect(noSession).toMatchObject({ ok: false, exitCode: 4 });
    expect(noSession.error).toMatch(/is not running/);
  });

  it("newLines finds what follows the previous view, and everything after a clear", () => {
    expect(newLines(["a", "b", "c"], ["a", "b", "c", "d", "e"])).toEqual([
      "d",
      "e",
    ]);
    expect(newLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
    expect(newLines(["a", "b", "c"], ["x", "y"])).toEqual(["x", "y"]);
    expect(newLines([], ["x"])).toEqual(["x"]);
    expect(newLines(["a"], ["a"])).toEqual([]);
  });
});
