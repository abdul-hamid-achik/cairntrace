import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndexSchema } from "../../core/artifacts/__fixtures__/filecheapRunIndexContract";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { buildRunIndex, RUN_INDEX_MAX_BYTES } from "./publishRunIndex";

const RUN_ID = "2026-10-02T10-00-00-000Z_checkout_a1b2c3";

async function run(
  opts: {
    screenshots?: number;
    status?: string;
    outcomes?: Array<{ id: string; status: string }>;
  } = {},
) {
  const runDir = await mkdtemp(join(tmpdir(), "cairntrace-run-index-"));
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  await writer.writeText(
    "run.json",
    JSON.stringify({
      runId: RUN_ID,
      status: opts.status ?? "failed",
      environment: "local",
      backend: "playwright",
      spec: { name: "checkout", path: "/private/project/flows/checkout.yml" },
      startedAt: "2026-10-02T10:00:00.000Z",
      endedAt: "2026-10-02T10:00:05.000Z",
      durationMs: 5000,
      exitCode: 1,
      summary: "outcome 'paid' failed: secret text",
      failure: { phase: "outcome", message: "do not index this message" },
      outcomes: opts.outcomes ?? [
        { id: "paid", status: "failed" },
        { id: "receipt_shown", status: "skipped" },
        { id: "bad id with spaces", status: "passed" },
      ],
      steps: [{ id: "a" }, { id: "b" }],
    }),
    "run",
  );
  await writer.writeText("agent_context.md", "# ctx\n", "agent-context");
  await writer.writeText(
    "events.ndjson",
    '{"type":"run.failed"}\n',
    "event-log",
  );
  await writer.writeText("outcomes/paid.md", "# paid\n", "outcome");
  for (let i = 0; i < (opts.screenshots ?? 2); i++) {
    await writeFile(
      await writer.preparePath(
        `screenshots/${String(i).padStart(3, "0")}_step.png`,
        "screenshot",
      ),
      "png",
    );
  }
  const manifest = await writer.writeManifest();
  return { runDir, files: manifest.artifacts.map((entry) => entry.path) };
}

describe("RunIndexV1 sidecar", () => {
  it("builds a contract-valid, metadata-only index", async () => {
    const { runDir, files } = await run();
    const index = await buildRunIndex(runDir, RUN_ID, [
      ...files,
      "artifact-manifest.json",
    ]);
    expect(runIndexSchema.safeParse(index).success).toBe(true);
    expect(index.run).toMatchObject({
      nativeId: RUN_ID,
      status: "failed",
      specName: "checkout",
      environment: "local",
      backend: "playwright",
      errorKind: "outcome",
      exitCode: 1,
      durationMs: 5000,
    });
    expect(index.outcomes).toEqual([
      { id: "paid", status: "failed" },
      { id: "receipt_shown", status: "skipped" },
    ]);
    expect(index.counts).toMatchObject({ outcomes: 3, steps: 2 });
    expect(index.health.state).toBe("ok");
    const body = JSON.stringify(index);
    expect(body).not.toContain("do not index this message");
    expect(body).not.toContain("secret text");
    expect(body).not.toContain("/private/project");
    const screenshots = index.evidence.find((e) => e.path === "screenshots");
    expect(screenshots).toMatchObject({
      role: "screenshot",
      medium: "image",
      presence: "present",
      integrity: "verified",
      sensitivity: "potentially-sensitive",
    });
    expect(index.evidence.find((e) => e.path === "run.json")).toMatchObject({
      role: "run",
      sensitivity: "redacted",
    });
  });

  it("stays within 12 KiB and 200 entries for a large run", async () => {
    const { runDir, files } = await run({ screenshots: 400 });
    const index = await buildRunIndex(runDir, RUN_ID, files);
    expect(runIndexSchema.safeParse(index).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThanOrEqual(
      RUN_INDEX_MAX_BYTES,
    );
    expect(index.counts.artifacts).toBeGreaterThan(400);
  });

  it("trims outcomes, passed first, when run metadata alone is over 12 KiB", async () => {
    const outcomes = Array.from({ length: 80 }, (_, i) => ({
      id: `outcome_${String(i).padStart(2, "0")}_${"x".repeat(125)}`,
      status: i % 10 === 0 ? "failed" : "passed",
    }));
    const { runDir, files } = await run({ outcomes });
    const index = await buildRunIndex(runDir, RUN_ID, files);
    expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThanOrEqual(
      RUN_INDEX_MAX_BYTES,
    );
    expect(runIndexSchema.safeParse(index).success).toBe(true);
    expect(index.counts.outcomes).toBe(80);
    expect(index.outcomes.length).toBeLessThan(80);
    // Every failed outcome survives; passed ones fill what is left, in order.
    expect(index.outcomes.filter((o) => o.status === "failed")).toHaveLength(8);
    expect(index.outcomes.map((o) => o.id)).toEqual(
      outcomes
        .map((o) => o.id)
        .filter((id) => index.outcomes.some((kept) => kept.id === id)),
    );
  });

  it("tolerates an appended event log but flags changed members", async () => {
    const { runDir, files } = await run({ status: "refused" });
    await appendFile(
      join(runDir, "events.ndjson"),
      '{"type":"artifact.stash"}\n',
    );
    let index = await buildRunIndex(runDir, RUN_ID, files);
    expect(index.health.state).toBe("ok");
    expect(index.run.status).toBe("cancelled");
    await writeFile(join(runDir, "outcomes", "paid.md"), "# tampered\n");
    index = await buildRunIndex(runDir, RUN_ID, files);
    expect(index.health).toMatchObject({
      state: "degraded",
      changed: 1,
      reasons: ["hash-mismatch"],
    });
    expect(runIndexSchema.safeParse(index).success).toBe(true);
  });

  it("leaves excluded members out of the inventory", async () => {
    const { runDir, files } = await run();
    const index = await buildRunIndex(
      runDir,
      RUN_ID,
      files.filter((file) => !file.startsWith("screenshots/")),
    );
    expect(index.evidence.some((e) => e.path.startsWith("screenshots"))).toBe(
      false,
    );
  });
});
