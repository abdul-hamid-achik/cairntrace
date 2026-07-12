import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addEnospcHint,
  pruneRuns,
  specNameOfRunId,
  DEFAULT_KEEP_RUNS,
  DEFAULT_KEEP_FAILED_RUNS,
} from "./retention";

async function makeRunDir(
  root: string,
  runId: string,
  opts: { status?: string; corruptRunJson?: boolean } = {},
): Promise<void> {
  const dir = join(root, runId);
  await mkdir(join(dir, "snapshots"), { recursive: true });
  const runJson = opts.corruptRunJson
    ? "{not valid json"
    : JSON.stringify({
        runId,
        ...(opts.status ? { status: opts.status } : {}),
      });
  await writeFile(join(dir, "run.json"), runJson);
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

describe("pruneRuns — failed-run carve-out", () => {
  it("protects the newest failed run beyond the keepRuns cutoff", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cairntrace-retention-failcarve-"),
    );
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa", {
      status: "failed",
    });
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb");
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");

    const result = await pruneRuns(root, { keepRuns: 1, keepFailedRuns: 1 });

    // aaaaaa is failed and outside the keepRuns=1 cutoff — the carve-out
    // protects it; bbbbbb (passed, also outside the cutoff) is pruned.
    expect(result.removed).toEqual(["2026-06-02T10-00-00-000Z_spec_a_bbbbbb"]);
    expect(result.kept).toBe(2);
    const remaining = (await readdir(root)).toSorted();
    expect(remaining).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-03T10-00-00-000Z_spec_a_cccccc",
    ]);
  });

  it("counts a failed run already inside the keepRuns window against the quota", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cairntrace-retention-failquota-"),
    );
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa", {
      status: "failed",
    });
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb", {
      status: "failed",
    });
    // Newest run is inside the keepRuns=1 window AND failed — it consumes
    // the keepFailedRuns=1 quota on its own, so the older failed run below
    // it is NOT protected.
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc", {
      status: "failed",
    });

    const result = await pruneRuns(root, { keepRuns: 1, keepFailedRuns: 1 });

    expect(result.removed).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-02T10-00-00-000Z_spec_a_bbbbbb",
    ]);
    expect(result.kept).toBe(1);
  });

  it("treats errored status as non-passed, same as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-retention-errored-"));
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa", {
      status: "errored",
    });
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb");
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");

    const result = await pruneRuns(root, { keepRuns: 1, keepFailedRuns: 1 });

    expect(result.removed).toEqual(["2026-06-02T10-00-00-000Z_spec_a_bbbbbb"]);
    const remaining = (await readdir(root)).toSorted();
    expect(remaining).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-03T10-00-00-000Z_spec_a_cccccc",
    ]);
  });

  it("treats a missing status or corrupt run.json as passed (prunable)", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cairntrace-retention-statusless-"),
    );
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa"); // no status
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb", {
      corruptRunJson: true,
    });
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");

    const result = await pruneRuns(root, { keepRuns: 1, keepFailedRuns: 10 });

    // Nothing is confirmed failed/errored, so the carve-out protects
    // nothing beyond the ordinary keepRuns cutoff.
    expect(result.removed).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-02T10-00-00-000Z_spec_a_bbbbbb",
    ]);
    expect(result.kept).toBe(1);
  });

  it("defaults keepFailedRuns to DEFAULT_KEEP_FAILED_RUNS when omitted", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cairntrace-retention-faildefault-"),
    );
    await makeRunDir(root, "2026-06-01T10-00-00-000Z_spec_a_aaaaaa", {
      status: "failed",
    });
    await makeRunDir(root, "2026-06-02T10-00-00-000Z_spec_a_bbbbbb");
    await makeRunDir(root, "2026-06-03T10-00-00-000Z_spec_a_cccccc");

    const result = await pruneRuns(root, { keepRuns: 1 }); // keepFailedRuns omitted

    expect(result.removed).toEqual(["2026-06-02T10-00-00-000Z_spec_a_bbbbbb"]);
    const remaining = (await readdir(root)).toSorted();
    expect(remaining).toEqual([
      "2026-06-01T10-00-00-000Z_spec_a_aaaaaa",
      "2026-06-03T10-00-00-000Z_spec_a_cccccc",
    ]);
  });
});

describe("DEFAULT_KEEP_RUNS", () => {
  it("defaults to 3 (keep latest 3 runs per spec unless configured)", () => {
    expect(DEFAULT_KEEP_RUNS).toBe(3);
  });
});

describe("DEFAULT_KEEP_FAILED_RUNS", () => {
  it("defaults to 10 (keep latest 10 failed/errored runs per spec)", () => {
    expect(DEFAULT_KEEP_FAILED_RUNS).toBe(10);
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
