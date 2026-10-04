import { inflateRawSync } from "node:zlib";

/**
 * A minimal in-memory ZIP reader for Playwright trace archives: stored and
 * deflated entries from the central directory, nothing else (no ZIP64, no
 * encryption, no extraction to disk). A trace is a few hundred KB to a few MB
 * of `.trace` / `.network` JSON-lines plus resources; this reads only the
 * entries the caller asks for. Entry sizes are bounded so a hostile archive
 * cannot balloon memory.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** The decompressed bytes of one entry. */
  read(name: string): Buffer;
  has(name: string): boolean;
}

/** Largest single entry this reader decompresses (default). */
export const ZIP_MAX_ENTRY_BYTES = 128 * 1024 * 1024;

/** Decompression bounds for one opened archive. */
export interface ZipLimits {
  /** Largest single entry (default {@link ZIP_MAX_ENTRY_BYTES}). */
  maxEntryBytes?: number;
  /** Most bytes all reads of this archive may decompress together (default: unbounded). */
  maxTotalBytes?: number;
}
const MAX_ENTRIES = 20_000;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface CentralRecord extends ZipEntry {
  method: number;
  localOffset: number;
}

export function openZip(buffer: Buffer, limits: ZipLimits = {}): ZipArchive {
  const maxEntry = limits.maxEntryBytes ?? ZIP_MAX_ENTRY_BYTES;
  const maxTotal = limits.maxTotalBytes ?? Number.POSITIVE_INFINITY;
  let total = 0;
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff || centralSize === 0xffffffff) {
    throw new ZipError("ZIP64 archives are not supported");
  }
  if (count > MAX_ENTRIES) {
    throw new ZipError(`archive has ${count} entries (limit ${MAX_ENTRIES})`);
  }
  const records = new Map<string, CentralRecord>();
  for (let i = 0; i < count; i += 1) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== CENTRAL_SIG
    ) {
      throw new ZipError("corrupt central directory");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    if ((flags & 1) !== 0) {
      throw new ZipError(`entry ${name} is encrypted`);
    }
    records.set(name, { name, compressedSize, size, method, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return {
    entries: [...records.values()].map(({ name, compressedSize, size }) => ({
      name,
      compressedSize,
      size,
    })),
    has: (name) => records.has(name),
    read(name) {
      const record = records.get(name);
      if (!record) throw new ZipError(`no entry ${name} in the archive`);
      if (total + record.size > maxTotal) {
        throw new ZipError(
          `reading ${record.name} would decompress more than ${maxTotal} bytes from this archive`,
        );
      }
      const bytes = readEntry(buffer, record, maxEntry);
      total += bytes.length;
      if (total > maxTotal) {
        throw new ZipError(
          `reading ${record.name} decompressed more than ${maxTotal} bytes from this archive`,
        );
      }
      return bytes;
    },
  };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes plus an optional comment of up to 65535 bytes.
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError("not a ZIP archive (no end-of-central-directory record)");
}

function readEntry(
  buffer: Buffer,
  record: CentralRecord,
  maxEntry: number,
): Buffer {
  if (
    record.size > maxEntry ||
    (record.method === 0 && record.compressedSize > maxEntry)
  ) {
    throw new ZipError(
      `entry ${record.name} is ${Math.max(record.size, record.method === 0 ? record.compressedSize : 0)} bytes (limit ${maxEntry})`,
    );
  }
  const at = record.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIG) {
    throw new ZipError(`corrupt local header for ${record.name}`);
  }
  const nameLen = buffer.readUInt16LE(at + 26);
  const extraLen = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + record.compressedSize);
  if (record.method === 0) return Buffer.from(raw);
  if (record.method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: maxEntry });
    } catch (e) {
      throw new ZipError(
        `cannot inflate ${record.name}: ${(e as Error).message}`,
      );
    }
  }
  throw new ZipError(
    `entry ${record.name} uses unsupported compression method ${record.method}`,
  );
}
