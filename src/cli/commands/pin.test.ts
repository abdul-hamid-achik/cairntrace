import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { pruneRuns } from "../../core/artifacts/retention";
import { ArtifactManifestSchema } from "../../core/schema/run.v1";
import { pinRunRef, unpinRunRef } from "./pin";

let previousBinary: string | undefined;
beforeEach(() => {
  previousBinary = process.env.FCHEAP_BIN;
});
afterEach(() => {
  if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
  else process.env.FCHEAP_BIN = previousBinary;
});

async function runAt(root: string, runId: string, status = "passed") {
  const writer = new ArtifactWriter(
    join(root, runId),
    createArtifactRedactor(undefined),
  );
  await writer.writeText(
    "run.json",
    `${JSON.stringify({ runId, status, spec: { name: "checkout" } }, null, 2)}\n`,
    "run",
  );
  await writer.writeManifest();
  return join(root, runId);
}

const RUN = (n: number) =>
  `2026-10-0${n}T10-00-00-000Z_checkout_${String(n).repeat(6)}`;

describe("cairn pin / unpin", () => {
  it("stamps run.json, rebuilds the manifest and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-pin-"));
    const runDir = await runAt(root, RUN(1));
    const pinned = await pinRunRef("latest", {
      artifactRoot: root,
      reason: "evidence for a bug report",
    });
    expect(pinned).toMatchObject({
      runId: RUN(1),
      changed: true,
      pinned: { reason: "evidence for a bug report" },
    });
    const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    expect(run.pinned.reason).toBe("evidence for a bug report");
    expect(run.status).toBe("passed");

    const manifest = ArtifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(runDir, "artifact-manifest.json"), "utf8"),
      ),
    );
    const entry = manifest.artifacts.find((a) => a.path === "run.json");
    expect(entry?.bytes).toBe((await stat(join(runDir, "run.json"))).size);

    const again = await pinRunRef(RUN(1), {
      artifactRoot: root,
      reason: "evidence for a bug report",
    });
    expect(again.changed).toBe(false);
    expect(again.pinned).toEqual(pinned.pinned);

    const unpinned = await unpinRunRef(RUN(1), { artifactRoot: root });
    expect(unpinned).toMatchObject({ pinned: false, changed: true });
    expect(
      JSON.parse(await readFile(join(runDir, "run.json"), "utf8")).pinned,
    ).toBeUndefined();
    expect((await unpinRunRef(RUN(1), { artifactRoot: root })).changed).toBe(
      false,
    );
  });

  it("retention never prunes a pinned run unless includePinned", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-pin-retention-"));
    for (const n of [1, 2, 3, 4]) await runAt(root, RUN(n));
    await pinRunRef(RUN(1), { artifactRoot: root });

    const kept = await pruneRuns(root, { keepRuns: 1, keepFailedRuns: 0 });
    // The pin takes no keepRuns slot: newest unpinned (4) + the pinned (1).
    expect(kept.removed).toEqual([RUN(2), RUN(3)]);
    expect(kept.pinned).toEqual([RUN(1)]);
    expect((await stat(join(root, RUN(1)))).isDirectory()).toBe(true);

    const all = await pruneRuns(root, {
      keepRuns: 0,
      keepFailedRuns: 0,
      includePinned: true,
    });
    expect(all.removed).toEqual([RUN(1), RUN(4)]);
  });

  it("retention keeps a run pinned while an earlier archive was in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-pin-race-"));
    for (const n of [1, 2, 3]) await runAt(root, RUN(n));
    const archived: string[] = [];
    const result = await pruneRuns(root, {
      keepRuns: 1,
      keepFailedRuns: 0,
      onArchive: async (_dir, runId) => {
        archived.push(runId);
        // Pinned from another terminal during the first (slow) archive:
        // RUN(2) was already listed as prunable.
        if (runId === RUN(1)) await pinRunRef(RUN(2), { artifactRoot: root });
      },
    });
    expect(archived).toEqual([RUN(1)]);
    expect(result.removed).toEqual([RUN(1)]);
    expect(result.pinned).toEqual([RUN(2)]);
    expect((await stat(join(root, RUN(2)))).isDirectory()).toBe(true);

    // Pinned during its own archive: archived, but not deleted.
    const second = await mkdtemp(join(tmpdir(), "cairntrace-pin-race-"));
    for (const n of [1, 2]) await runAt(second, RUN(n));
    const self = await pruneRuns(second, {
      keepRuns: 1,
      keepFailedRuns: 0,
      onArchive: async (_dir, runId) => {
        await pinRunRef(runId, { artifactRoot: second });
      },
    });
    expect(self.removed).toEqual([]);
    expect(self.pinned).toEqual([RUN(1)]);
  });

  it("pin --stash saves with the keep tag and no TTL", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "cairntrace-pin-fake-"));
    const log = join(fakeRoot, "args.log");
    const bin = join(fakeRoot, "fcheap");
    await writeFile(
      bin,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$1" = "save" ] && [ "$2" != "--help" ]; then
  printf '%s\\n' '{"id":"pin-stash-1","status":"saved"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(bin, 0o755);
    process.env.FCHEAP_BIN = bin;
    const root = await mkdtemp(join(tmpdir(), "cairntrace-pin-stash-"));
    const runDir = await runAt(root, RUN(5), "failed");
    await mkdir(join(runDir, "videos"), { recursive: true });
    await writeFile(join(runDir, "videos", "playwright-video.webm"), "webm");

    const outcome = await pinRunRef(RUN(5), {
      artifactRoot: root,
      stash: true,
    });
    expect(outcome.stash).toMatchObject({
      ok: true,
      stashId: "pin-stash-1",
      excluded: ["videos/"],
    });
    const save = (await readFile(log, "utf8"))
      .split("\n")
      .find((line) => line.startsWith("save ") && !line.includes("--help"));
    expect(save).toContain("--tag keep");
    expect(save).not.toContain("--ttl");
    expect(
      JSON.parse(await readFile(join(runDir, "stash-receipt.json"), "utf8")),
    ).toMatchObject({ action: "manual", stashId: "pin-stash-1" });
  });

  it("refuses a run without a readable run.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-pin-broken-"));
    await mkdir(join(root, RUN(6)), { recursive: true });
    await expect(pinRunRef(RUN(6), { artifactRoot: root })).rejects.toThrow(
      /run.json is missing or invalid/,
    );
  });
});
