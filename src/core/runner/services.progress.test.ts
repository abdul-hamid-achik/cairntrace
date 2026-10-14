import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactRedactor } from "../artifacts/redaction";
import { serviceOutput, startServices } from "./services";

// Seed freshness state normally lives under ~/.cairntrace; keep tests local.
vi.mock("./seedState", () => ({
  SeedStateStore: vi.fn().mockImplementation(() => ({
    read: vi.fn(async () => undefined),
    checkFreshness: vi.fn(() => ({
      shouldRun: true,
      reason: "no-previous-seed",
    })),
    recordRun: vi.fn(async () => undefined),
    fingerprint: vi.fn(() => "test-fp"),
  })),
}));

const SECRET = "hunter2-demo-secret";

describe("serviceOutput progress rate limit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (chunks: string[]) =>
    serviceOutput(
      { onOutput: (chunk) => chunks.push(chunk) },
      "docker",
      createArtifactRedactor(undefined, { DEMO_API_TOKEN: SECRET }),
      true,
    )!;

  it("shows a burst up to the window limit, reports the rest once, then shows later lines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const chunks: string[] = [];
    const out = make(chunks);
    for (let i = 1; i <= 300; i += 1) out.push(`line ${i}\n`);
    expect(chunks).toHaveLength(100);
    expect(chunks[0]).toBe("line 1\n");
    // The window closes on its own: a quiet 20-minute startup is not silent
    // about what the burst hid.
    vi.advanceTimersByTime(5_000);
    expect(chunks).toHaveLength(101);
    expect(chunks.at(-1)).toBe("docker — 200 more output line(s) not shown\n");
    // A later line, much later, is visible again.
    vi.advanceTimersByTime(20 * 60_000);
    out.push("Container api Started\n");
    expect(chunks.at(-1)).toBe("Container api Started\n");
    out.finish(0);
    expect(chunks).toHaveLength(102);
  });

  it("bounds output without a newline and redacts before cutting", () => {
    const chunks: string[] = [];
    const out = make(chunks);
    out.push("x".repeat(300_000));
    out.push(`${SECRET}\n`);
    out.finish(0);
    const text = chunks.join("");
    expect(text).not.toContain(SECRET);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1_000);
    }
    expect(chunks.length).toBeLessThanOrEqual(110);
  });
});

describe("startServices progress output (onOutput)", () => {
  it("normalizes ANSI before redacting a secret in progress and artifacts", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-progress-ansi-"));
    const secret = "redaction-edge-dummy";
    const chunks: string[] = [];
    const artifacts: string[] = [];
    const handle = await startServices(
      {
        docker: {
          command: "printf 'redaction-\\033[31medge-dummy\\033[0m\\n'",
          reuseExisting: false,
        },
      },
      {
        configDir,
        project: "demo-progress-ansi",
        env: { PATH: process.env.PATH, DEMO_API_TOKEN: secret },
        onOutput: (chunk) => chunks.push(chunk),
        onServiceOutput: (_source, line) => artifacts.push(line),
      },
    );
    await handle.stop();
    expect(chunks).toEqual(["[redacted]\n"]);
    expect(artifacts).toContain("[redacted]");
    expect([...chunks, ...artifacts].join("")).not.toContain(secret);
  });

  it("streams complete, redacted docker lines and never the secret", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-progress-lines-"));
    const chunks: string[] = [];
    const handle = await startServices(
      {
        docker: {
          command: 'printf "pulling\\nusing %s\\n" "$DEMO_API_TOKEN"',
          reuseExisting: false,
        },
      },
      {
        configDir,
        project: "demo-progress-lines",
        coldStart: true,
        env: { PATH: process.env.PATH, DEMO_API_TOKEN: SECRET },
        onOutput: (chunk) => chunks.push(chunk),
      },
    );
    await handle.stop();

    expect(chunks).toEqual(["pulling\n", "using [redacted]\n"]);
    for (const chunk of chunks) {
      expect(chunk.endsWith("\n")).toBe(true);
    }
    expect(chunks.join("")).not.toContain(SECRET);
  });

  it("redacts a secret that is printed split across two writes", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-progress-split-"));
    const split = "tok-hunter2-demo-secret";
    const chunks: string[] = [];
    const handle = await startServices(
      {
        docker: {
          command: "printf 'tok-hun'; sleep 0.2; printf 'ter2-demo-secret\\n'",
          reuseExisting: false,
        },
      },
      {
        configDir,
        project: "demo-progress-split",
        coldStart: true,
        env: { PATH: process.env.PATH, DEMO_API_TOKEN: split },
        onOutput: (chunk) => chunks.push(chunk),
      },
    );
    await handle.stop();

    // The line is only emitted once complete, so it is redacted whole.
    expect(chunks).toEqual(["[redacted]\n"]);
    expect(JSON.stringify(chunks)).not.toContain("hunter2");
  });

  it("never lets stderr written between two stdout chunks leak a split secret", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-progress-mix-"));
    const split = "tok-hunter2-demo-secret";
    const chunks: string[] = [];
    const handle = await startServices(
      {
        docker: {
          command:
            "printf 'tok-hun'; echo interleaved-stderr >&2; sleep 0.2; printf 'ter2-demo-secret\\n'",
          reuseExisting: false,
        },
      },
      {
        configDir,
        project: "demo-progress-mix",
        coldStart: true,
        env: { PATH: process.env.PATH, DEMO_API_TOKEN: split },
        onOutput: (chunk) => chunks.push(chunk),
      },
    );
    await handle.stop();

    const text = chunks.join("");
    expect(text).toContain("interleaved-stderr");
    expect(text).toContain("[redacted]");
    for (const fragment of [split, "tok-hun", "ter2-demo-secret", "hunter2"]) {
      expect(text).not.toContain(fragment);
    }
  });

  it("keeps seed output off the progress sink (docker output still reaches it)", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-progress-seed-"));
    const chunks: string[] = [];
    const handle = await startServices(
      {
        docker: { command: "echo docker-line", reuseExisting: false },
        seed: { command: "echo seed-only-marker" },
      },
      {
        configDir,
        project: "demo-progress-seed",
        coldStart: true,
        env: { PATH: process.env.PATH },
        onOutput: (chunk) => chunks.push(chunk),
      },
    );
    await handle.stop();

    const text = chunks.join("");
    expect(text).toContain("docker-line");
    expect(text).not.toContain("seed-only-marker");
  });

  it("does not fail startServices when the progress sink throws", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-progress-throw-"));
    const handle = await startServices(
      { docker: { command: "echo still-up", reuseExisting: false } },
      {
        configDir,
        project: "demo-progress-throw",
        coldStart: true,
        env: { PATH: process.env.PATH },
        onOutput: () => {
          throw new Error("progress sink is down");
        },
      },
    );
    expect(handle.events.map((e) => `${e.phase}.${e.event}`)).toContain(
      "docker.ready",
    );
    await handle.stop();
  });
});
