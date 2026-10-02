import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
  INVOCATION_ID_PATTERN,
  INVOCATIONS_DIR,
  invocationIdPid,
  isPidAlive,
  listInvocationIds,
  readInvocationJournal,
} from "../../core/artifacts/invocationJournal";
import type { RunLogsResult } from "../../core/schema/runInvocation.v1";

/**
 * Incremental, cursor-based reads of a run's or an invocation's live logs
 * (the files `cairn logs` follows), for pollers that cannot hold a stream
 * open: MCP `cairn_logs`. Every file keeps its own byte position, so files
 * that appear or grow out of name order never shift what was already read.
 * Files on disk are already redacted by their writers; nothing here writes.
 */

export type SettleState = "running" | "settled" | "dead";

/** Default and maximum slice sizes. */
export const DEFAULT_LOG_SLICE_BYTES = 64 * 1024;
export const MAX_LOG_SLICE_BYTES = 1024 * 1024;

/** Silence after which a run without writer identity counts as gone. */
const STALE_RUN_MS = 120_000;

/** `logs/<name>` (with or without `.log`), confined to the logs directory. */
function namedLogFile(root: string, name: string): string {
  const safe = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  const file = safe.endsWith(".log") ? safe : `${safe}.log`;
  return join(root, "logs", file);
}

async function listLogFiles(dir: string, prefix: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .toSorted()
    .map((name) => join(dir, name));
}

/**
 * The files a selection names (absolute paths). `multi` selections
 * (precondition, outcome, services, hook) are a set of files that appear
 * and grow independently — a shared `hook-before-NN.log` keeps growing
 * after `hook-after-*` files appeared — so they are read with a per-file
 * cursor, never one byte offset.
 */
async function logSelectionFiles(
  target: "run" | "invocation",
  dir: string,
  selection: string,
): Promise<{ files: string[]; multi: boolean }> {
  if (selection === "events") {
    return { files: [join(dir, "events.ndjson")], multi: false };
  }
  if (target === "run") {
    if (selection === "run") {
      return { files: [join(dir, "run.log")], multi: false };
    }
    if (selection === "precondition" || selection === "outcome") {
      return {
        files: await listLogFiles(join(dir, "logs"), `${selection}-`),
        multi: true,
      };
    }
  } else {
    if (selection === "narration") {
      return { files: [join(dir, "logs", "narration.log")], multi: false };
    }
    if (selection === "services" || selection === "hook") {
      return {
        files: await listLogFiles(join(dir, "logs"), `${selection}-`),
        multi: true,
      };
    }
  }
  return { files: [namedLogFile(dir, selection)], multi: false };
}

/**
 * A run is settled once its artifact manifest exists: the runner writes it
 * last, after the final run.* event. A run whose invocation ended (or whose
 * writer process is gone) without a manifest was interrupted.
 */
export async function runSettleState(runDir: string): Promise<SettleState> {
  if (existsSync(join(runDir, "artifact-manifest.json"))) return "settled";
  const owner = await runOwner(runDir);
  if (owner.invocationDir) {
    const journal = await readInvocationJournal(owner.invocationDir);
    if (journal && journal.status !== "running") {
      return existsSync(join(runDir, "artifact-manifest.json"))
        ? "settled"
        : "dead";
    }
    if (journal && !isPidAlive(journal.pid)) return "dead";
  }
  if (owner.pid !== undefined && !isPidAlive(owner.pid)) return "dead";
  if (owner.pid === undefined && !owner.invocationDir) {
    const modified = (
      await stat(join(runDir, "events.ndjson")).catch(() => undefined)
    )?.mtimeMs;
    if (modified !== undefined && Date.now() - modified > STALE_RUN_MS) {
      return "dead";
    }
  }
  return "running";
}

/** Writer pid (latest heartbeat) and invocation journal of a run, if known. */
async function runOwner(
  runDir: string,
): Promise<{ pid?: number; invocationDir?: string }> {
  const text = await readFile(join(runDir, "events.ndjson"), "utf8").catch(
    () => "",
  );
  let pid: number | undefined;
  let invocationDir: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"run.started"') && !line.includes('"run.heartbeat"')) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: string;
        pid?: number;
        invocation?: { dir?: string };
      };
      if (event.type === "run.heartbeat" && typeof event.pid === "number") {
        pid = event.pid;
      }
      if (
        event.type === "run.started" &&
        typeof event.invocation?.dir === "string"
      ) {
        invocationDir = join(runDir, "..", event.invocation.dir);
      }
    } catch {
      // A torn last line while the run is writing; skip it.
    }
  }
  return {
    ...(pid !== undefined ? { pid } : {}),
    ...(invocationDir ? { invocationDir } : {}),
  };
}

/** Settled once invocation.json leaves `running`; dead when its writer is gone. */
export async function invocationSettleState(dir: string): Promise<SettleState> {
  const journal = await readInvocationJournal(dir);
  if (journal) {
    if (journal.status !== "running") return "settled";
    return isPidAlive(journal.pid) ? "running" : "dead";
  }
  const eventsPath = join(dir, "events.ndjson");
  const events = await readFile(eventsPath, "utf8").catch(() => "");
  if (events.includes('"invocation.finished"')) return "settled";
  const pid = invocationIdPid(basename(dir));
  if (pid !== undefined) return isPidAlive(pid) ? "running" : "dead";
  const modified = (await stat(eventsPath).catch(() => undefined))?.mtimeMs;
  return modified === undefined || Date.now() - modified > STALE_RUN_MS
    ? "dead"
    : "running";
}

/** `latest` / `previous` (by id, i.e. start time) or an invocation id. */
export async function resolveInvocationDir(
  artifactRoot: string,
  ref: string,
): Promise<string | undefined> {
  let id: string | undefined;
  if (ref === "latest" || ref === "previous") {
    const ids = await listInvocationIds(artifactRoot);
    id = ids.at(ref === "latest" ? -1 : -2);
  } else if (INVOCATION_ID_PATTERN.test(ref)) {
    id = ref;
  }
  if (!id) return undefined;
  const dir = join(artifactRoot, INVOCATIONS_DIR, id);
  return (await stat(dir).catch(() => undefined))?.isDirectory()
    ? dir
    : undefined;
}

/** True for a run reference safe to join under the artifact root. */
export function isSafeRunRef(ref: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(ref) && !/^\.+$/.test(ref);
}

/** Byte length of the leading part of `buf` that ends on a whole UTF-8 char. */
function utf8SafeLength(buf: Buffer): number {
  let end = buf.length;
  // Walk back over at most 3 continuation bytes to the lead byte.
  let i = end - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i]! & 0xc0) === 0x80) {
    i -= 1;
    continuation += 1;
  }
  if (i < 0) return 0;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (end - i < need) end = i;
  return end;
}

async function readRange(
  path: string,
  start: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return Buffer.alloc(0);
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Per-file read positions of a selection: `{ "logs/hook-before-01.log": 120 }`. */
export type LogCursor = Record<string, number>;

/** A multi-file selection was asked to continue from a bare byte offset. */
export class LogCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogCursorError";
  }
}

/**
 * Trim one file's chunk to what is safe to hand out. Unless the chunk
 * reaches the end of a settled file, it may stop mid-line (the writer is
 * still appending, or the byte budget cut it): end it on its last newline,
 * hold a torn line back entirely, and cut only a single line longer than
 * `maxBytes` (on a UTF-8 boundary).
 */
function safeChunk(
  chunk: Buffer,
  input: { settled: boolean; reachesEnd: boolean; maxBytes: number },
): Buffer {
  let out = chunk;
  if (!(input.settled && input.reachesEnd)) {
    const lastNewline = out.lastIndexOf(0x0a);
    if (lastNewline >= 0) out = out.subarray(0, lastNewline + 1);
    else if (out.length < input.maxBytes) return Buffer.alloc(0);
  }
  if (out.length > 0 && out[out.length - 1] !== 0x0a) {
    out = out.subarray(0, utf8SafeLength(out));
  }
  return out;
}

/**
 * One slice of a log selection. Every file is read from its own position:
 * `cursor[file]` (a previous `nextCursor`), or `offset` for a single-file
 * selection. Multi-file selections (precondition, outcome, services, hook)
 * put a `==> <file> <==` header before each file's new bytes, like
 * `tail -f`; a file that appears or grows later is picked up at its own
 * position, so continuing with `nextCursor` never repeats or skips bytes.
 * Slices end on whole lines unless a settled file ends without a newline or
 * one line is longer than `maxBytes`.
 *
 * `offset`, `nextOffset` and `size` are byte totals over the selection's
 * files; only a single-file selection may continue from `offset` (a
 * multi-file one throws {@link LogCursorError} for a non-zero offset
 * without a cursor).
 */
export async function readLogSlice(input: {
  target: "run" | "invocation";
  id: string;
  dir: string;
  log: string;
  offset?: number;
  cursor?: LogCursor;
  maxBytes?: number;
  state: SettleState;
}): Promise<RunLogsResult> {
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const maxBytes = Math.min(
    MAX_LOG_SLICE_BYTES,
    Math.max(1, Math.floor(input.maxBytes ?? DEFAULT_LOG_SLICE_BYTES)),
  );
  const { files, multi } = await logSelectionFiles(
    input.target,
    input.dir,
    input.log,
  );
  if (multi && input.cursor === undefined && offset > 0) {
    throw new LogCursorError(
      `log "${input.log}" spans several files that grow independently: continue with the previous slice's nextCursor as cursor (offset addresses single-file logs only)`,
    );
  }
  const present: Array<{ file: string; path: string; size: number }> = [];
  for (const path of files) {
    const size = (await stat(path).catch(() => undefined))?.size;
    if (size === undefined) continue;
    present.push({ file: relative(input.dir, path), path, size });
  }
  const settled = input.state !== "running";
  const parts: Buffer[] = [];
  const nextCursor: LogCursor = {};
  let budget = maxBytes;
  let start = 0;
  let next = 0;
  let size = 0;
  for (const entry of present) {
    const requested =
      input.cursor !== undefined ? (input.cursor[entry.file] ?? 0) : offset;
    const from = Math.min(entry.size, Math.max(0, Math.floor(requested)));
    let to = from;
    if (budget > 0 && from < entry.size) {
      const length = Math.min(budget, entry.size - from);
      const chunk = safeChunk(await readRange(entry.path, from, length), {
        settled,
        reachesEnd: from + length >= entry.size,
        maxBytes,
      });
      if (chunk.length > 0) {
        if (multi) parts.push(Buffer.from(`==> ${entry.file} <==\n`));
        parts.push(chunk);
        if (multi && chunk[chunk.length - 1] !== 0x0a) {
          parts.push(Buffer.from("\n"));
        }
        budget -= chunk.length;
        to = from + chunk.length;
      }
    }
    nextCursor[entry.file] = to;
    start += from;
    next += to;
    size += entry.size;
  }
  return {
    $schema: "urn:cairntrace.dev:run-logs:v1",
    version: "1",
    target: input.target,
    id: input.id,
    dir: input.dir,
    log: input.log,
    files: present.map((entry) => entry.file),
    text: Buffer.concat(parts).toString("utf8"),
    offset: start,
    nextOffset: next,
    nextCursor,
    size,
    eof: next >= size,
    settled,
    state: input.state,
  };
}
