import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureTmuxSignalArtifactsSync } from "./services";

let testRoot: string | undefined;

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

describe("signal-time tmux artifacts", () => {
  it("writes every redacted pane and its manifest synchronously", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "cairn-signal-tmux-"));
    const targets: string[] = [];

    captureTmuxSignalArtifactsSync(
      {
        runDir: testRoot,
        signal: "SIGINT",
        session: "cairn-test",
        windows: ["web-api", "worker"],
        policy: {
          when: "on-failure",
          capture: ["tmux"],
          maxLinesPerSource: 2_000,
          maxBytesPerSource: 512 * 1024,
          maxBytesPerRun: 8 * 1024 * 1024,
        },
        redactor: {
          value: <T>(value: T): T =>
            JSON.parse(
              JSON.stringify(value).replaceAll("pane-secret", "[redacted]"),
            ) as T,
          text: (value) => value.replaceAll("pane-secret", "[redacted]"),
        },
        disposition: "created",
        startedAt: "2026-07-30T06:00:00.000Z",
      },
      (_command, args) => {
        const target = args[args.indexOf("-t") + 1]!;
        targets.push(target);
        return {
          stdout: `\u001b[31m${target} pane-secret ready\u001b[0m\n`,
          stderr: "",
          status: 0,
        };
      },
    );

    expect(targets).toEqual(["cairn-test:web-api", "cairn-test:worker"]);
    for (const window of ["web-api", "worker"]) {
      const path = join(testRoot, "services", "tmux", `${window}.log`);
      const text = await readFile(path, "utf8");
      expect(text).toContain(`[redacted] ready`);
      expect(text).not.toContain("pane-secret");
      expect(text).not.toContain("\u001b[");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    const manifestPath = join(testRoot, "services", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      interrupted: boolean;
      signal: string;
      status: string;
      files: Array<{ path: string }>;
    };
    expect(manifest).toMatchObject({
      interrupted: true,
      signal: "SIGINT",
      status: "errored",
    });
    expect(manifest.files.map((file) => file.path)).toEqual([
      "services/tmux/web-api.log",
      "services/tmux/worker.log",
    ]);
    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
  });

  it("does nothing when service artifacts are disabled", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "cairn-signal-tmux-off-"));
    let captures = 0;

    captureTmuxSignalArtifactsSync(
      {
        runDir: testRoot,
        signal: "SIGTERM",
        session: "cairn-test",
        windows: ["worker"],
        policy: {
          when: "never",
          capture: ["tmux"],
          maxLinesPerSource: 2_000,
          maxBytesPerSource: 512 * 1024,
          maxBytesPerRun: 8 * 1024 * 1024,
        },
        redactor: {
          value: <T>(value: T): T => value,
          text: (value) => value,
        },
        disposition: "reused",
        startedAt: "2026-07-30T06:00:00.000Z",
      },
      () => {
        captures++;
        return { stdout: "", stderr: "", status: 0 };
      },
    );

    expect(captures).toBe(0);
    await expect(stat(join(testRoot, "services"))).rejects.toThrow();
  });
});
