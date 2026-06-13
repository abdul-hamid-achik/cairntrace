import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findRunBySlot,
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
    const older = join(root, "old_run");
    const newer = join(root, "new_run");
    await mkdir(older);
    await mkdir(newer);
    await utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(newer, new Date("2026-01-02"), new Date("2026-01-02"));

    await expect(findRunBySlot(root, 0)).resolves.toBe("new_run");
    await expect(findRunBySlot(root, 1)).resolves.toBe("old_run");
    await expect(resolveRunRef("latest", root)).resolves.toBe(newer);
    await expect(resolveRunRef("previous", root)).resolves.toBe(older);
    await expect(resolveRunRef("old_run", root)).resolves.toBe(older);
  });
});
