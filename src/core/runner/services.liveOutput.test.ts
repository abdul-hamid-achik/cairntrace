import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startServices } from "./services";

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

describe("startServices live output (onServiceOutput)", () => {
  it("streams redacted docker and seed lines with command headers and exit footers", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-services-live-"));
    const lines: Array<{ source: string; line: string }> = [];
    const handle = await startServices(
      {
        docker: {
          command: 'printf "pulling\\nusing %s\\n" "$DEMO_API_TOKEN"',
          reuseExisting: false,
        },
        seed: {
          command: 'echo "seeding with $DEMO_API_TOKEN"; echo seeded',
          postCommands: ['echo "fixture ok"'],
        },
      },
      {
        configDir,
        project: "demo-live-output",
        coldStart: true,
        env: { PATH: process.env.PATH, DEMO_API_TOKEN: SECRET },
        onServiceOutput: (source, line) => lines.push({ source, line }),
      },
    );
    await handle.stop();

    const docker = lines
      .filter((l) => l.source === "docker")
      .map((l) => l.line);
    const seed = lines.filter((l) => l.source === "seed").map((l) => l.line);
    expect(docker).toEqual([
      '$ printf "pulling\\nusing %s\\n" "$DEMO_API_TOKEN"',
      "pulling",
      "using [redacted]",
      "[exit 0]",
    ]);
    expect(seed).toEqual([
      '$ echo "seeding with $DEMO_API_TOKEN"; echo seeded',
      "seeding with [redacted]",
      "seeded",
      "[exit 0]",
      '$ echo "fixture ok"',
      "fixture ok",
      "[exit 0]",
    ]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it("keeps the docker phase silent when no sink is given", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cairn-services-quiet-"));
    const handle = await startServices(
      { docker: { command: "echo quiet", reuseExisting: false } },
      { configDir, project: "demo-quiet", coldStart: true },
    );
    expect(handle.events.map((e) => `${e.phase}.${e.event}`)).toEqual([
      "docker.start",
      "docker.ready",
    ]);
    await handle.stop();
  });

  it("captures the same seed record whether or not output streams live", async () => {
    const contents: string[][] = [];
    for (const streaming of [true, false]) {
      const configDir = await mkdtemp(join(tmpdir(), "cairn-services-same-"));
      const handle = await startServices(
        {
          seed: { command: "echo seeded", postCommands: ['echo "fixture ok"'] },
        },
        {
          configDir,
          project: "demo-same-record",
          coldStart: true,
          env: { PATH: process.env.PATH },
          ...(streaming ? { onServiceOutput: () => undefined } : {}),
        },
      );
      const bundle = await handle.captureRunArtifacts("failed");
      contents.push(
        bundle.files.filter((f) => f.source === "seed").map((f) => f.content),
      );
      await handle.stop();
    }
    expect(contents[0]).toEqual(contents[1]);
    expect(contents[0]?.[0]).toContain(
      "--- stdout ---\nseeded\n--- stderr ---",
    );
  });

  it("never passes the parent's withheld credentials to service commands", async () => {
    const saved = process.env.FILECHEAP_INGEST_TOKEN;
    process.env.FILECHEAP_INGEST_TOKEN = "canary-ingest-1234";
    try {
      const configDir = await mkdtemp(join(tmpdir(), "cairn-services-env-"));
      const lines: string[] = [];
      // No ctx.env: the services layer filters process.env itself.
      const handle = await startServices(
        {
          docker: {
            command: 'echo "ingest=$FILECHEAP_INGEST_TOKEN"',
            reuseExisting: false,
          },
        },
        {
          configDir,
          project: "demo-withheld",
          coldStart: true,
          onServiceOutput: (_source, line) => lines.push(line),
        },
      );
      await handle.stop();
      expect(lines).toContain("ingest=");
    } finally {
      if (saved === undefined) delete process.env.FILECHEAP_INGEST_TOKEN;
      else process.env.FILECHEAP_INGEST_TOKEN = saved;
    }
  });
});
