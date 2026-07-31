import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { ServicesArtifactBundle } from "./services";
import { runSpec } from "./Runner";

let testRoot: string | undefined;

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

async function writeSpec(precondition?: string): Promise<{
  specPath: string;
  artifactRoot: string;
}> {
  testRoot = await mkdtemp(join(tmpdir(), "cairn-services-artifacts-"));
  const specPath = join(testRoot, "service-artifacts.yml");
  await writeFile(
    specPath,
    `version: 1
name: service_artifacts
intent: service evidence stays attached to its behavioral run
${
  precondition
    ? `preconditions:\n  commands:\n    - name: setup\n      run: ${precondition}\n`
    : ""
}outcomes:
  - id: clean
    description: the mock console stays clean
    verify: { console: { errorsMax: 0 } }
steps: []
`,
  );
  return { specPath, artifactRoot: join(testRoot, "runs") };
}

function serviceBundle(
  status: ServicesArtifactBundle["status"],
): ServicesArtifactBundle {
  return {
    version: "1",
    status,
    captured: true,
    reason: "captured",
    capturedAt: "2026-07-29T12:00:01.000Z",
    policy: {
      when: "always",
      capture: ["lifecycle", "tmux"],
      maxLinesPerSource: 2_000,
      maxBytesPerSource: 512 * 1024,
      maxBytesPerRun: 8 * 1024 * 1024,
    },
    runWindow: {
      startedAt: "2026-07-29T12:00:00.000Z",
      endedAt: "2026-07-29T12:00:01.000Z",
    },
    ownership: { tmux: "reused" },
    files: [
      {
        source: "lifecycle",
        relativePath: "services/lifecycle.ndjson",
        label: "services/lifecycle",
        content: '{"event":"ready"}\n',
        bytes: 18,
        truncated: false,
      },
      {
        source: "tmux",
        relativePath: "services/tmux/web-api.log",
        label: "tmux/web-api",
        content: "listening with service-log-secret\n",
        bytes: 34,
        truncated: false,
        metadata: { window: "web-api", disposition: "reused" },
      },
    ],
    errors: [],
    totalBytes: 52,
    truncated: false,
  };
}

describe("run-local service artifacts", () => {
  it("writes a redacted service pack before the run reports and checksum manifest", async () => {
    const { specPath, artifactRoot } = await writeSpec();
    const calls: Array<{
      status: string;
      startedAt?: string;
      endedAt?: string;
    }> = [];

    const result = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
      secretValues: ["service-log-secret"],
      captureServicesArtifacts: async (status, window) => {
        calls.push({
          status,
          ...(typeof window.startedAt === "string"
            ? { startedAt: window.startedAt }
            : {}),
          ...(typeof window.endedAt === "string"
            ? { endedAt: window.endedAt }
            : {}),
        });
        return serviceBundle(status);
      },
    });

    expect(result.status).toBe("passed");
    expect(result.artifacts.services).toBe("services/manifest.json");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "passed",
      startedAt: expect.any(String),
      endedAt: expect.any(String),
    });

    const pane = await readFile(
      join(result.runDir, "services/tmux/web-api.log"),
      "utf8",
    );
    expect(pane).toContain("[redacted]");
    expect(pane).not.toContain("service-log-secret");

    const serviceManifest = JSON.parse(
      await readFile(join(result.runDir, "services/manifest.json"), "utf8"),
    ) as { files: Array<{ path: string; content?: string }> };
    expect(serviceManifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "services/tmux/web-api.log" }),
      ]),
    );
    expect(
      serviceManifest.files.every((file) => file.content === undefined),
    ).toBe(true);

    const runManifest = JSON.parse(
      await readFile(join(result.runDir, "artifact-manifest.json"), "utf8"),
    ) as { artifacts: Array<{ path: string }> };
    expect(runManifest.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        "services/lifecycle.ndjson",
        "services/manifest.json",
        "services/tmux/web-api.log",
      ]),
    );
    expect(
      await readFile(join(result.runDir, "agent_context.md"), "utf8"),
    ).toContain("services/manifest.json");
    expect(
      await readFile(join(result.runDir, "report.json"), "utf8"),
    ).toContain('"label": "Service logs"');
    expect(
      await readFile(join(result.runDir, "events.ndjson"), "utf8"),
    ).toContain('"type":"artifact.services"');
  });

  it("keeps the behavioral verdict when service collection itself fails", async () => {
    const { specPath, artifactRoot } = await writeSpec();
    const result = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
      secretValues: ["service-log-secret"],
      captureServicesArtifacts: async () => {
        throw new Error("capture failed for service-log-secret");
      },
    });

    expect(result.status).toBe("passed");
    expect(result.artifacts.services).toBeUndefined();
    const events = await readFile(join(result.runDir, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"artifact.services"');
    expect(events).toContain('"action":"error"');
    expect(events).toContain("[redacted]");
    expect(events).not.toContain("service-log-secret");
  });

  it("captures service evidence for a failed precondition run", async () => {
    const { specPath, artifactRoot } = await writeSpec("'exit 7'");
    const result = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
      captureServicesArtifacts: async (status) => serviceBundle(status),
    });

    expect(result.status).toBe("errored");
    expect(result.failure).toMatchObject({
      phase: "precondition",
      name: "setup",
    });
    expect(result.artifacts.services).toBe("services/manifest.json");
    expect(
      JSON.parse(
        await readFile(join(result.runDir, "services/manifest.json"), "utf8"),
      ),
    ).toMatchObject({ status: "errored" });
  });
});
