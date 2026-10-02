import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { EvidenceTransferError } from "../artifacts/retention";
import { RunEventSchema, type RunEvent } from "../schema/events.v1";
import { ArtifactManifestSchema } from "../schema/run.v1";
import { runSpec } from "./Runner";

/** Mock backend that answers trace start/stop like agent-browser does. */
class TracingBackend extends MockBrowserBackend {
  constructor(private readonly traceBody: string | undefined) {
    super();
    Object.defineProperty(this, "name", { value: "agent-browser" });
  }
  async startTrace(): Promise<void> {}
  async stopTrace(path: string): Promise<{ ok: boolean; path: string }> {
    if (this.traceBody === undefined) return { ok: false, path };
    await writeFile(path, this.traceBody);
    return { ok: true, path };
  }
}

const FAILING_SPEC = `version: 1
name: traced_checkout
intent: a failing run keeps its trace
coldStart: guest
artifacts:
  capture: { trace: on-failure, traceMaxBytes: 4096 }
redaction:
  headers: [X-Tenant-Key]
outcomes:
  - id: never_there
    description: copy that never renders
    verify: { text: { region: page, contains: "this copy never renders" } }
steps:
  - open: /
`;

async function project(config = "version: 1\nenvironments:\n  local: {}\n") {
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-runner-evidence-"));
  await writeFile(join(dir, "cairntrace.config.yml"), config);
  const specPath = join(dir, "traced.yml");
  await writeFile(specPath, FAILING_SPEC);
  return { dir, specPath, artifactRoot: join(dir, "runs") };
}

async function events(runDir: string): Promise<RunEvent[]> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

describe("runner evidence handling", () => {
  it("writes agent-browser traces as sanitized .json marked sanitized", async () => {
    const { specPath, artifactRoot } = await project();
    const result = await runSpec({
      specPath,
      artifactRoot,
      backend: new TracingBackend(
        JSON.stringify({
          traceEvents: [
            {
              args: {
                data: {
                  headers: { authorization: "Bearer t0k", "X-Tenant-Key": "k" },
                },
              },
            },
          ],
        }),
      ),
    });
    expect(result.status).toBe("failed");
    expect(result.artifacts.trace).toBe("traces/agent-browser-trace.json");
    const trace = await readFile(
      join(result.runDir, "traces/agent-browser-trace.json"),
      "utf8",
    );
    expect(trace).not.toContain("Bearer t0k");
    expect(trace).toContain('"X-Tenant-Key":"[redacted]"');
    const manifest = ArtifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(result.runDir, "artifact-manifest.json"), "utf8"),
      ),
    );
    expect(
      manifest.artifacts.find(
        (a) => a.path === "traces/agent-browser-trace.json",
      ),
    ).toMatchObject({ kind: "trace", sensitivity: "sanitized" });
    expect(await events(result.runDir)).toContainEqual(
      expect.objectContaining({
        type: "artifact.trace",
        action: "saved",
        format: "chrome-trace-json",
        sensitivity: "sanitized",
      }),
    );
    const context = await readFile(
      join(result.runDir, "agent_context.md"),
      "utf8",
    );
    expect(context).toContain("ui.perfetto.dev");
    expect(context).not.toContain("show-trace");
  });

  it("drops an empty or oversized trace without failing differently", async () => {
    const { specPath, artifactRoot } = await project();
    const empty = await runSpec({
      specPath,
      artifactRoot,
      backend: new TracingBackend(""),
    });
    expect(empty.status).toBe("failed");
    expect(empty.artifacts.trace).toBeUndefined();
    expect(await events(empty.runDir)).toContainEqual(
      expect.objectContaining({
        type: "artifact.trace",
        action: "error",
        reason: "empty",
      }),
    );

    const big = await runSpec({
      specPath,
      artifactRoot,
      backend: new TracingBackend("x".repeat(5000)),
    });
    expect(big.artifacts.trace).toBeUndefined();
    expect(await events(big.runDir)).toContainEqual(
      expect.objectContaining({
        action: "dropped",
        reason: "too-large",
        maxBytes: 4096,
      }),
    );
    await expect(
      stat(join(big.runDir, "traces/agent-browser-trace.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records archive outcomes on the pruning run and keeps failed archives on disk", async () => {
    const { specPath, artifactRoot } = await project(`version: 1
environments:
  local: {}
retention:
  keepRuns: 1
  keepFailedRuns: 0
  archiveToStash: true
stash:
  include: [text, screenshots, traces]
  ttl: 14d
`);
    const first = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
    });
    const archived: Array<{
      runId: string;
      include?: readonly string[];
      ttl?: string;
    }> = [];
    const second = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
      onArchiveRun: async (_dir, runId, _tags, evidence) => {
        archived.push({
          runId,
          ...(evidence?.include ? { include: evidence.include } : {}),
          ...(evidence?.ttl ? { ttl: evidence.ttl } : {}),
        });
        return {
          stashId: "archived-1",
          status: "saved",
          excluded: ["videos/"],
        };
      },
    });
    expect(archived).toEqual([
      {
        runId: first.runId,
        include: ["text", "screenshots", "traces"],
        ttl: "14d",
      },
    ]);
    const secondEvents = await events(second.runDir);
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "artifact.stash",
        action: "archive",
        status: "saved",
        runId: first.runId,
        stashId: "archived-1",
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        type: "artifact.retention",
        action: "summary",
        removed: 1,
        archiveFailures: 0,
      }),
    );

    const third = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
      onArchiveRun: async () => {
        throw new EvidenceTransferError("fcheap not found", "fcheap-missing");
      },
    });
    const thirdEvents = await events(third.runDir);
    expect(thirdEvents).toContainEqual(
      expect.objectContaining({
        type: "artifact.stash",
        action: "archive",
        status: "error",
        reason: "fcheap-missing",
        runId: second.runId,
      }),
    );
    expect(thirdEvents).toContainEqual(
      expect.objectContaining({
        type: "artifact.retention",
        action: "warning",
        runId: second.runId,
        reason: "fcheap-missing",
      }),
    );
    // The run whose archive failed is retained on disk.
    expect((await stat(second.runDir)).isDirectory()).toBe(true);
  });

  it("never prunes a pinned run during auto-retention", async () => {
    const { specPath, artifactRoot } = await project(`version: 1
environments:
  local: {}
retention:
  keepRuns: 1
  keepFailedRuns: 0
`);
    const first = await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
    });
    const run = JSON.parse(
      await readFile(join(first.runDir, "run.json"), "utf8"),
    );
    run.pinned = { at: new Date().toISOString(), reason: "keep" };
    await writeFile(join(first.runDir, "run.json"), JSON.stringify(run));
    await mkdir(artifactRoot, { recursive: true });
    await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
    });
    await runSpec({
      specPath,
      artifactRoot,
      backend: new MockBrowserBackend(),
    });
    expect((await stat(first.runDir)).isDirectory()).toBe(true);
  });
});
