import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAIRN_VERSION } from "../version";

const { runFcheapMock } = vi.hoisted(() => ({ runFcheapMock: vi.fn() }));
vi.mock("./fcheapClient", () => ({ runFcheap: runFcheapMock }));

import {
  createRunArchive,
  MAX_PUBLISH_ARCHIVE_BYTES,
  publishRunDirectory,
} from "./publish";

describe("remote artifact publication", () => {
  beforeEach(() => {
    runFcheapMock.mockReset();
  });

  it("publishes one complete bounded archive and validates exact receipt bytes", async () => {
    const dir = await completedRun("run-123");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "run.json"), '{"status":"passed"}');
    await writeFile(join(dir, "nested", "evidence.txt"), "complete evidence");
    let archivedPaths: string[] = [];
    let archivePath = "";

    runFcheapMock.mockImplementation(
      async (args: string[], _opts: { env?: NodeJS.ProcessEnv }) => {
        archivePath = args[1]!;
        const info = await lstat(archivePath);
        expect(info.isFile()).toBe(true);
        expect(info.mode & 0o777).toBe(0o600);
        const bytes = await readFile(archivePath);
        archivedPaths = listTarPaths(gunzipSync(bytes));
        return {
          ok: true,
          exitCode: 0,
          stdout: JSON.stringify(
            publishReceipt(
              createHash("sha256").update(bytes).digest("hex"),
              bytes.length,
              "run-123",
            ),
          ),
          stderr: "",
        };
      },
    );

    await expect(
      publishRunDirectory(dir, "run-123", {
        env: {
          PATH: process.env.PATH,
          FILECHEAP_INGEST_TOKEN: "publisher-only-token",
        },
      }),
    ).resolves.toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sizeBytes: expect.any(Number),
    });

    expect(archivedPaths).toEqual([
      "artifact-manifest.json",
      "nested/",
      "nested/evidence.txt",
      "run.json",
    ]);
    expect(runFcheapMock).toHaveBeenCalledWith(
      [
        "publish",
        expect.stringMatching(/\.tar\.gz$/),
        "--content-type",
        "application/gzip",
        "--expires-in",
        "168h",
        "--kind",
        "cairntrace.run",
        "--producer-tool",
        "cairntrace",
        "--producer-version",
        CAIRN_VERSION,
        "--native-schema",
        "urn:cairntrace.dev:run:v1",
        "--native-id",
        "run-123",
        "--entrypoint",
        "run.json",
      ],
      expect.objectContaining({
        json: true,
        env: expect.objectContaining({
          FILECHEAP_INGEST_TOKEN: "publisher-only-token",
        }),
      }),
    );
    await expect(lstat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinks and never invokes fcheap", async () => {
    const dir = await completedRun("run-link");
    await symlink("artifact-manifest.json", join(dir, "linked-manifest"));

    await expect(publishRunDirectory(dir, "run-link")).rejects.toThrow(
      /rejects symbolic link/,
    );
    expect(runFcheapMock).not.toHaveBeenCalled();
  });

  it("rejects remote retention outside file.cheap's bounded window", async () => {
    const dir = await completedRun("run-retention");
    await expect(
      publishRunDirectory(dir, "run-retention", { retentionDays: 32 }),
    ).rejects.toThrow(/between 1 and 31 days/);
    expect(runFcheapMock).not.toHaveBeenCalled();
  });

  it("retains an incompressible run whose archive exceeds the producer quota", async () => {
    const dir = await completedRun("run-large");
    await writeFile(
      join(dir, "evidence.bin"),
      randomBytes(MAX_PUBLISH_ARCHIVE_BYTES + 128 * 1024),
    );

    await expect(createRunArchive(dir)).rejects.toThrow(/fcheap publish limit/);
    await expect(readFile(join(dir, "evidence.bin"))).resolves.toHaveLength(
      MAX_PUBLISH_ARCHIVE_BYTES + 128 * 1024,
    );
    expect(runFcheapMock).not.toHaveBeenCalled();
  });

  it("rejects a receipt with different bytes and retains the run", async () => {
    const dir = await completedRun("run-mismatch");
    runFcheapMock.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify(publishReceipt("b".repeat(64), 8, "run-mismatch")),
      stderr: "",
    });

    await expect(publishRunDirectory(dir, "run-mismatch")).rejects.toThrow(
      /exact local archive bytes/,
    );
    await expect(
      readFile(join(dir, "artifact-manifest.json"), "utf8"),
    ).resolves.toContain('"version":"1"');
  });

  it("does not surface publisher stderr that may contain a credential or signed URL", async () => {
    const dir = await completedRun("run-failed");
    runFcheapMock.mockResolvedValue({
      ok: false,
      exitCode: 3,
      stdout: "",
      stderr:
        "FILECHEAP_INGEST_TOKEN=do-not-print https://blob.test/x?token=signed",
    });

    let message = "";
    try {
      await publishRunDirectory(dir, "run-failed");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("local run retained");
    expect(message).not.toContain("do-not-print");
    expect(message).not.toContain("token=signed");
  });
});

async function completedRun(runId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `cairntrace-${runId}-`));
  await writeFile(
    join(dir, "artifact-manifest.json"),
    JSON.stringify({
      version: "1",
      artifacts: [
        { path: "run.json", kind: "run", bytes: 0, sha256: "a".repeat(64) },
      ],
    }),
  );
  await writeFile(join(dir, "run.json"), `{"runId":"${runId}"}`);
  return dir;
}

function publishReceipt(sha256: string, sizeBytes: number, runId: string) {
  return {
    version: "filecheap-publish/1",
    artifact_ref: {
      $schema: "urn:filecheap.dev:artifact-ref:v1",
      version: 1,
      provider: "fcheap-cloud",
      uri: "fcheap://cloud/vaults/private/artifacts/art-123",
      artifact_id: "art-123",
      kind: "cairntrace.run",
      producer: {
        tool: "cairntrace",
        version: CAIRN_VERSION,
        native_schema: "urn:cairntrace.dev:run:v1",
        native_id: runId,
        entrypoint: "run.json",
      },
    },
    sha256,
    size_bytes: sizeBytes,
    verification: "server-sha256",
    published_at: "2026-07-24T00:00:00Z",
  };
}

function listTarPaths(tar: Buffer): string[] {
  const paths: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    paths.push(prefix ? `${prefix}/${name}` : name);
    const sizeText = tarString(header.subarray(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

function tarString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}
