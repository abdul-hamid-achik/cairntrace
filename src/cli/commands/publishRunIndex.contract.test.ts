import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndexSchema } from "../../core/artifacts/__fixtures__/filecheapRunIndexContract";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { buildRunIndex, RUN_INDEX_MAX_BYTES } from "./publishRunIndex";

/**
 * Cross-repo contract: `buildRunIndex` output for representative runs must
 * parse with the vendored file.cheap console schema and stay within the
 * 12 KiB sidecar limit. See the fixture header for the source and sync date.
 */

const RUN_ID = "2026-10-04T09-00-00-000Z_contract_a1b2c3";

interface RunShape {
  status: string;
  specName: string;
  environment?: string;
  outcomes: Array<{ id: string; status: string }>;
  /** Distinct directories, each holding one screenshot. */
  screenshotDirs?: number;
}

async function buildRun(shape: RunShape) {
  const runDir = await mkdtemp(
    join(tmpdir(), "cairntrace-run-index-contract-"),
  );
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  await writer.writeText(
    "run.json",
    JSON.stringify({
      runId: RUN_ID,
      status: shape.status,
      environment: shape.environment ?? "local",
      backend: "playwright",
      spec: { name: shape.specName },
      startedAt: "2026-10-04T09:00:00.000Z",
      endedAt: "2026-10-04T09:00:07.500Z",
      durationMs: 7500,
      exitCode: shape.status === "passed" ? 0 : 1,
      failure: shape.status === "passed" ? undefined : { phase: "outcome" },
      outcomes: shape.outcomes,
      steps: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` })),
    }),
    "run",
  );
  await writer.writeText("agent_context.md", "# ctx\n", "agent-context");
  await writer.writeText("events.ndjson", '{"type":"run.done"}\n', "event-log");
  for (let i = 0; i < (shape.screenshotDirs ?? 0); i++) {
    await writeFile(
      await writer.preparePath(
        `evidence/step-${String(i).padStart(4, "0")}/shot.png`,
        "screenshot",
      ),
      "png",
    );
  }
  const manifest = await writer.writeManifest();
  return { runDir, files: manifest.artifacts.map((entry) => entry.path) };
}

function expectContract(index: unknown): void {
  const parsed = runIndexSchema.safeParse(index);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(index), "utf8")).toBeLessThanOrEqual(
    RUN_INDEX_MAX_BYTES,
  );
}

describe("RunIndexV1 against the vendored file.cheap contract", () => {
  it("a small passed run", async () => {
    const { runDir, files } = await buildRun({
      status: "passed",
      specName: "login",
      outcomes: [
        { id: "signed_in", status: "passed" },
        { id: "greeting_shown", status: "passed" },
      ],
    });
    const index = await buildRunIndex(runDir, RUN_ID, files);
    expectContract(index);
    expect(index.run).toMatchObject({ status: "passed", exitCode: 0 });
    expect(index.health.state).toBe("ok");
  });

  it("a failed run with far more outcomes and evidence than the caps", async () => {
    const outcomes = Array.from({ length: 160 }, (_, i) => ({
      id: `outcome_${String(i).padStart(3, "0")}`,
      status: i % 7 === 0 ? "failed" : "passed",
    }));
    const { runDir, files } = await buildRun({
      status: "failed",
      specName: "checkout",
      outcomes,
      screenshotDirs: 320,
    });
    const index = await buildRunIndex(runDir, RUN_ID, files);
    expectContract(index);
    expect(index.outcomes.length).toBeLessThanOrEqual(100);
    expect(index.evidence.length).toBeLessThanOrEqual(200);
    // Counts keep the real totals so the console can say "N more".
    expect(index.counts.outcomes).toBe(160);
    expect(index.counts.artifacts).toBeGreaterThan(300);
  });

  it("unicode spec, environment and outcome names", async () => {
    const { runDir, files } = await buildRun({
      status: "failed",
      // Multi-byte and astral characters; longer than the 240-unit cap.
      specName: `Überweisung 日本語 ✅ ${"😀".repeat(150)}`,
      environment: "стейджинг-東京",
      outcomes: [
        { id: "ascii_outcome", status: "failed" },
        { id: "résultat_ünïcode", status: "failed" },
        { id: "日本語", status: "passed" },
      ],
      screenshotDirs: 20,
    });
    const index = await buildRunIndex(runDir, RUN_ID, files);
    expectContract(index);
    expect(index.outcomes).toEqual([{ id: "ascii_outcome", status: "failed" }]);
    expect(String(index.run.specName).length).toBeLessThanOrEqual(240);
    // The index survives a JSON round trip unchanged (no lone surrogates).
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });
});
