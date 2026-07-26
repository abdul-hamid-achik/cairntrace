import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { ArtifactManifestSchema } from "../../core/schema/run.v1";
import { fcheapPublisherEnv } from "../../core/processEnv";
import { CAIRN_VERSION } from "../version";
import {
  CAIRNTRACE_PUBLISH_ENTRYPOINT,
  CAIRNTRACE_PUBLISH_KIND,
  CAIRNTRACE_PUBLISH_NATIVE_SCHEMA,
  parseFcheapPublishOutput,
} from "./fcheapContract";
import { runFcheap } from "./fcheapClient";

/**
 * The file.cheap publisher quota assigned to the `cairntrace` producer.
 * file.cheap's global artifact ceiling is 64 MiB, but every producer is
 * additionally capped by its own server-side `maxSizeBytes`; publishing above
 * that quota is rejected with 413. Raise this only together with the Cairntrace
 * entry in FILECHEAP_PUBLISHER_TOKENS.
 */
export const MAX_PUBLISH_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REMOTE_RETENTION_DAYS = 7;
const MAX_PUBLISH_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_PUBLISH_ENTRIES = 10_000;
const TAR_BLOCK_BYTES = 512;

interface SnapshotEntry {
  absolutePath: string;
  relativePath: string;
  kind: "directory" | "file";
  stat: BigIntStats;
}

export interface PackagedRunArchive {
  path: string;
  sha256: string;
  sizeBytes: number;
  cleanup(): Promise<void>;
}

export class PublicationArchiveError extends Error {
  override name = "PublicationArchiveError";
}

/**
 * Publish a completed run only through fcheap's bounded-file interface.
 * Cairntrace first packages the complete run directory into a private
 * temporary tar.gz. The local run may be pruned only after the strict receipt
 * matches those exact archive bytes and producer metadata.
 */
export async function publishRunDirectory(
  runDir: string,
  runId: string,
  opts: { env?: NodeJS.ProcessEnv; retentionDays?: number } = {},
): Promise<{
  artifactRef: Record<string, unknown>;
  sha256: string;
  sizeBytes: number;
}> {
  assertPortableNativeId(runId);
  const retentionDays = opts.retentionDays ?? DEFAULT_REMOTE_RETENTION_DAYS;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 31
  ) {
    throw new PublicationArchiveError(
      "remote artifact retention must be between 1 and 31 days",
    );
  }
  await validateCompletedManifest(runDir);
  const archive = await createRunArchive(runDir);
  try {
    const result = await runFcheap(
      [
        "publish",
        archive.path,
        "--content-type",
        "application/gzip",
        "--expires-in",
        `${retentionDays * 24}h`,
        "--kind",
        CAIRNTRACE_PUBLISH_KIND,
        "--producer-tool",
        "cairntrace",
        "--producer-version",
        CAIRN_VERSION,
        "--native-schema",
        CAIRNTRACE_PUBLISH_NATIVE_SCHEMA,
        "--native-id",
        runId,
        "--entrypoint",
        CAIRNTRACE_PUBLISH_ENTRYPOINT,
      ],
      {
        json: true,
        timeoutMs: 120_000,
        env: fcheapPublisherEnv(opts.env ?? process.env),
      },
    );
    if (!result.ok) {
      // fcheap stderr is deliberately not surfaced: a broken implementation
      // must not make a signed URL or credential part of Cairntrace output.
      throw new Error(
        `fcheap publish failed with exit ${result.exitCode}; local run retained`,
      );
    }
    const receipt = parseFcheapPublishOutput(result.stdout);
    if (
      receipt.sha256 !== archive.sha256 ||
      receipt.sizeBytes !== archive.sizeBytes
    ) {
      throw new Error(
        "fcheap publish receipt does not match the exact local archive bytes",
      );
    }
    if (
      receipt.artifactRef.kind !== CAIRNTRACE_PUBLISH_KIND ||
      receipt.artifactRef.producer.tool !== "cairntrace" ||
      receipt.artifactRef.producer.version !== CAIRN_VERSION ||
      receipt.artifactRef.producer.native_schema !==
        CAIRNTRACE_PUBLISH_NATIVE_SCHEMA ||
      receipt.artifactRef.producer.native_id !== runId ||
      receipt.artifactRef.producer.entrypoint !== CAIRNTRACE_PUBLISH_ENTRYPOINT
    ) {
      throw new Error(
        "fcheap publish receipt does not match the requested Cairntrace producer metadata",
      );
    }
    return {
      artifactRef: receipt.artifactRef,
      sha256: receipt.sha256,
      sizeBytes: receipt.sizeBytes,
    };
  } finally {
    await archive.cleanup();
  }
}

/**
 * Create a bounded tar.gz containing every directory and regular file in the
 * run. Links and special files are rejected. Files are opened with O_NOFOLLOW,
 * checked before/after reading, and the directory snapshot is compared again
 * after packaging so a concurrent mutation fails closed.
 */
export async function createRunArchive(
  runDir: string,
): Promise<PackagedRunArchive> {
  const root = resolve(runDir);
  const entries = await snapshotRunDirectory(root);
  const tempDir = await mkdtemp(join(tmpdir(), "cairntrace-publish-"));
  await chmod(tempDir, 0o700);
  const archivePath = join(tempDir, `${safeArchiveStem(root)}.tar.gz`);
  let compressedBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > MAX_PUBLISH_ARCHIVE_BYTES) {
        callback(
          new PublicationArchiveError(
            `run archive exceeds the ${MAX_PUBLISH_ARCHIVE_BYTES}-byte fcheap publish limit`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.from(tarChunks(entries), { objectMode: false }),
      createGzip({ level: 9 }),
      limiter,
      createWriteStream(archivePath, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    if (compressedBytes <= 0) {
      throw new PublicationArchiveError("run archive is empty");
    }
    const after = await snapshotRunDirectory(root);
    if (!sameSnapshot(entries, after)) {
      throw new PublicationArchiveError(
        "run directory changed while its publication archive was being created",
      );
    }
    // Digest the finished archive incrementally so memory stays constant even
    // at the top of the producer quota.
    const digest = createHash("sha256");
    let hashedBytes = 0;
    for await (const chunk of createReadStream(archivePath)) {
      hashedBytes += (chunk as Buffer).length;
      if (hashedBytes > MAX_PUBLISH_ARCHIVE_BYTES) {
        throw new PublicationArchiveError(
          "run archive changed after it was written",
        );
      }
      digest.update(chunk as Buffer);
    }
    if (hashedBytes !== compressedBytes) {
      throw new PublicationArchiveError(
        "run archive changed after it was written",
      );
    }
    return {
      path: archivePath,
      sha256: digest.digest("hex"),
      sizeBytes: hashedBytes,
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function validateCompletedManifest(runDir: string): Promise<void> {
  const raw = await readFile(join(runDir, "artifact-manifest.json"), "utf8");
  ArtifactManifestSchema.parse(JSON.parse(raw));
  const entrypoint = await lstat(join(runDir, CAIRNTRACE_PUBLISH_ENTRYPOINT), {
    bigint: true,
  });
  if (!entrypoint.isFile() || entrypoint.isSymbolicLink()) {
    throw new PublicationArchiveError(
      `publication entrypoint ${CAIRNTRACE_PUBLISH_ENTRYPOINT} must be a regular file`,
    );
  }
}

async function snapshotRunDirectory(root: string): Promise<SnapshotEntry[]> {
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PublicationArchiveError(
      "publication source must be a real run directory",
    );
  }

  const entries: SnapshotEntry[] = [];
  let sourceBytes = 0;
  const visit = async (absoluteDir: string, relativeDir: string) => {
    const names = await readdir(absoluteDir);
    names.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    for (const name of names) {
      if (name.includes("\0")) {
        throw new PublicationArchiveError(
          "run directory contains an invalid path",
        );
      }
      const absolutePath = join(absoluteDir, name);
      const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
      const info = await lstat(absolutePath, { bigint: true });
      if (info.isSymbolicLink()) {
        throw new PublicationArchiveError(
          `run archive rejects symbolic link: ${relativePath}`,
        );
      }
      if (info.isDirectory()) {
        entries.push({
          absolutePath,
          relativePath,
          kind: "directory",
          stat: info,
        });
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        sourceBytes += Number(info.size);
        if (sourceBytes > MAX_PUBLISH_SOURCE_BYTES) {
          throw new PublicationArchiveError(
            `run contents exceed the ${MAX_PUBLISH_SOURCE_BYTES}-byte packaging limit`,
          );
        }
        entries.push({
          absolutePath,
          relativePath,
          kind: "file",
          stat: info,
        });
      } else {
        throw new PublicationArchiveError(
          `run archive rejects special file: ${relativePath}`,
        );
      }
      if (entries.length > MAX_PUBLISH_ENTRIES) {
        throw new PublicationArchiveError(
          `run contains more than ${MAX_PUBLISH_ENTRIES} archive entries`,
        );
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function* tarChunks(
  entries: readonly SnapshotEntry[],
): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    if (entry.kind === "directory") {
      yield tarHeader(entry, 0);
      continue;
    }
    const handle = await open(
      entry.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameStat(entry.stat, before)) {
        throw new PublicationArchiveError(
          `run file changed before packaging: ${entry.relativePath}`,
        );
      }
      const size = Number(before.size);
      yield tarHeader(entry, size);
      let offset = 0;
      while (offset < size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
        const read = await handle.read(chunk, 0, chunk.length, offset);
        if (read.bytesRead <= 0) {
          throw new PublicationArchiveError(
            `run file changed while packaging: ${entry.relativePath}`,
          );
        }
        offset += read.bytesRead;
        yield chunk.subarray(0, read.bytesRead);
      }
      const after = await handle.stat({ bigint: true });
      if (!sameStat(before, after)) {
        throw new PublicationArchiveError(
          `run file changed while packaging: ${entry.relativePath}`,
        );
      }
      const padding =
        (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      if (padding > 0) yield Buffer.alloc(padding);
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(TAR_BLOCK_BYTES * 2);
}

function tarHeader(entry: SnapshotEntry, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const tarPath =
    entry.kind === "directory"
      ? `${entry.relativePath.replace(/\/+$/, "")}/`
      : entry.relativePath;
  const { name, prefix } = splitTarPath(tarPath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, Number(entry.stat.mode & 0o777n));
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.kind === "directory" ? 0x35 : 0x30;
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix };
    }
  }
  throw new PublicationArchiveError(
    `run archive path is too long for the safe tar format: ${path}`,
  );
}

function writeTarString(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) {
    throw new PublicationArchiveError("run archive contains an oversized path");
  }
  encoded.copy(header, offset);
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) {
    throw new PublicationArchiveError(
      "run archive metadata exceeds tar limits",
    );
  }
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function sameSnapshot(
  before: readonly SnapshotEntry[],
  after: readonly SnapshotEntry[],
): boolean {
  return (
    before.length === after.length &&
    before.every((entry, index) => {
      const candidate = after[index];
      return (
        candidate !== undefined &&
        entry.relativePath === candidate.relativePath &&
        entry.kind === candidate.kind &&
        sameStat(entry.stat, candidate.stat)
      );
    })
  );
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function safeArchiveStem(runDir: string): string {
  const stem = basename(runDir).replace(/[^A-Za-z0-9._-]/g, "_");
  return stem && stem !== "." && stem !== ".." ? stem : "cairntrace-run";
}

function assertPortableNativeId(runId: string): void {
  if (
    runId.length < 1 ||
    runId.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
    runId === "." ||
    runId === ".."
  ) {
    throw new PublicationArchiveError(
      "run id is not valid publication producer metadata",
    );
  }
}
