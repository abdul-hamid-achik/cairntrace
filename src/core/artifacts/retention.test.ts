import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addEnospcHint,
  pruneRuns,
  specNameOfRunId,
  DEFAULT_KEEP_RUNS,
} from "./retention";

async function makeRunDir(root: string, runId: string): Promise<void> {
  const dir = join(root, runId);
  await mkdir(join(dir, "snapshots"), { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({ runId }));
  await writeFile(join(dir, "snapshots", "001_step.txt"), "snapshot body");
}

describe("specNameOfRunId", () => {
  it("extracts snake_case spec names (with underscores) from run ids", () => {
    expect(
      specNameOfRunId("2026-06-04T10-00-00-000Z_member_checkout_a1b2c3"),
    ).toBe("member_checkout");
  });

  it("rejects non-run directory names", () => {
    expect(specNameOfRunId("checkpoints")).toBeUndefined();
    expect(specNameOfRunId(".DS_Store")).toBeUndefined();
  });
});

describe("pruneRuns", () => {
  it("keeps the newest N runs per spec and reports freed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-retention-"));
    // Three runs of spec_a (different times), two of spec_b, one foreign dir.
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa");
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb");
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");
    await makeRunDir(root, "2026-06-01T11-00-00-000Z_spec_b_dddddd");
    await makeRunDir(root, "2026-06-02T11-00-00-000Z_spec_b_eeeeee");
    await mkdir(join(root, "not-a-run-dir"));

    const result = await pruneRuns(root, { keepRuns: 1 });

    expect(result.removed).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-01T11-00-00-000Z_spec_b_dddddd",
      "2026-06-02T10-00-00-000Z_spec_a_bbbbbb",
    ]);
    expect(result.kept).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(0);

    const remaining = (await readdir(root)).toSorted();
    expect(remaining).toEqual([
      "2026-06-02T11-00-00-000Z_spec_b_eeeeee",
      "2026-06-03T10-00-00-000Z_spec_a_cccccc",
      "not-a-run-dir",
    ]);
  });

  it("keepRuns: 0 removes every run dir but leaves foreign entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-retention-all-"));
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa");
    await mkdir(join(root, "keepme"));

    const result = await pruneRuns(root, { keepRuns: 0 });
    expect(result.removed).toHaveLength(1);
    expect(await readdir(root)).toEqual(["keepme"]);
  });

  it("tolerates a missing artifact root", async () => {
    const result = await pruneRuns("/nonexistent/cairntrace-root", {
      keepRuns: 5,
    });
    expect(result).toEqual({ removed: [], freedBytes: 0, kept: 0 });
  });

  it("archives pruned runs via onArchive before deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-retention-archive-"));
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa");
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb");
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");

    const archived: string[] = [];
    const result = await pruneRuns(root, {
      keepRuns: 1,
      onArchive: async (runDir, runId) => {
        archived.push(runId);
        // Sanity: the dir still exists at archive time (move, not delete-first).
        expect(await readdir(runDir)).toContain("run.json");
      },
    });

    // Oldest two runs were archived then removed; newest kept.
    expect(archived.toSorted()).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-02T10-00-00-000Z_spec_a_bbbbbb",
    ]);
    expect(result.removed.toSorted()).toEqual(archived);
    expect(result.kept).toBe(1);
    const remaining = (await readdir(root)).toSorted();
    expect(remaining).toEqual(["2026-06-03T10-00-00-000Z_spec_a_cccccc"]);
  });

  it("retains a run on disk when onArchive rejects (no data loss)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-retention-keep-"));
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa");
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb");
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");

    const result = await pruneRuns(root, {
      keepRuns: 1,
      onArchive: async () => {
        throw new Error("fcheap down");
      },
    });

    // Nothing removed — archive failed, runs retained to avoid data loss.
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    const remaining = (await readdir(root)).toSorted();
    expect(remaining).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-02T10-00-00-000Z_spec_a_bbbbbb",
      "2026-06-03T10-00-00-000Z_spec_a_cccccc",
    ]);
  });
});

describe("DEFAULT_KEEP_RUNS", () => {
  it("defaults to 3 (keep latest 3 runs per spec unless configured)", () => {
    expect(DEFAULT_KEEP_RUNS).toBe(3);
  });
});

describe("addEnospcHint", () => {
  it("appends the clean hint to ENOSPC messages only", () => {
    expect(addEnospcHint("ENOSPC: no space left on device, write")).toContain(
      "cairn clean",
    );
    expect(addEnospcHint("selector not found")).toBe("selector not found");
  });
});
