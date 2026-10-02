import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findRunBySlot,
  listRunDirsNewestFirst,
  resolveArtifactRoot,
  resolveArtifactRootContext,
  resolveRunRef,
} from "./runRefs";

describe("runRefs", () => {
  it("resolves artifactRoot from project config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-runrefs-"));
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
artifactRoot: tests/bdd/runs
retention: { keepRuns: 3 }
environments:
  local: {}
`,
    );

    await expect(resolveArtifactRoot({ cwd: dir })).resolves.toBe(
      "tests/bdd/runs",
    );
    await expect(
      resolveArtifactRoot({ cwd: dir, artifactRoot: "/tmp/explicit-runs" }),
    ).resolves.toBe("/tmp/explicit-runs");

    const resolved = await resolveArtifactRootContext({
      cwd: dir,
      artifactRoot: "/tmp/explicit-runs",
    });
    expect(resolved.artifactRoot).toBe("/tmp/explicit-runs");
    expect(resolved.loaded?.config.retention?.keepRuns).toBe(3);
  });

  it("resolves latest and previous inside the selected runs root", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-runs-"));
    const OLD = "2026-01-01T00-00-00-000Z_old_run_aaaaaa";
    const NEW = "2026-01-02T00-00-00-000Z_new_run_bbbbbb";
    const older = join(root, OLD);
    const newer = join(root, NEW);
    await mkdir(older);
    await mkdir(newer);
    await utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(newer, new Date("2026-01-02"), new Date("2026-01-02"));

    await expect(findRunBySlot(root, 0)).resolves.toBe(NEW);
    await expect(findRunBySlot(root, 1)).resolves.toBe(OLD);
    await expect(resolveRunRef("latest", root)).resolves.toBe(newer);
    await expect(resolveRunRef("previous", root)).resolves.toBe(older);
    await expect(resolveRunRef(OLD, root)).resolves.toBe(older);
  });

  it("never resolves latest/previous to _invocations or other non-run folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-runs-nonrun-"));
    const RUN = "2026-01-01T00-00-00-000Z_only_run_cccccc";
    await mkdir(join(root, RUN));
    await utimes(
      join(root, RUN),
      new Date("2026-01-01"),
      new Date("2026-01-01"),
    );
    // Newer than the run, and not run directories.
    for (const name of ["_invocations", "scratch", "metrics-2026"]) {
      await mkdir(join(root, name));
    }
    await writeFile(join(root, "aborted-1-2.json"), "{}");

    expect(await listRunDirsNewestFirst(root)).toEqual([join(root, RUN)]);
    await expect(resolveRunRef("latest", root)).resolves.toBe(join(root, RUN));
    await expect(resolveRunRef("previous", root)).rejects.toThrow();
    // An explicit name still resolves, run-shaped or not.
    await expect(resolveRunRef("scratch", root)).resolves.toBe(
      join(root, "scratch"),
    );
  });
});
