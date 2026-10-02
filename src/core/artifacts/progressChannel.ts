import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { LineSplitter, logSlug, normalizeLogLine } from "./liveLog";

/** Environment variable naming the per-item progress file. */
export const CAIRN_PROGRESS_FILE_ENV = "CAIRN_PROGRESS_FILE";
/** Poll cadence while a precondition or verifier runs. */
export const PROGRESS_POLL_MS = 1_000;
/** Longest progress message kept; the rest is cut with an ellipsis. */
export const PROGRESS_MESSAGE_MAX_CHARS = 500;
/** Lines emitted per poll; a burst keeps its newest lines. */
const PROGRESS_MAX_LINES_PER_POLL = 20;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Per-run scratch directory for progress files. It lives OUTSIDE the run
 * directory: children write these files unredacted, so they must never become
 * artifacts. Messages reach events.ndjson only through the redacting writer.
 */
export class ProgressFiles {
  private dir: string | undefined;

  /** Create (empty) the progress file for one item and return its path. */
  create(name: string): string | undefined {
    try {
      this.dir ??= mkdtempSync(join(tmpdir(), "cairn-progress-"));
      const path = join(this.dir, `${logSlug(name)}.progress`);
      writeFileSync(path, "", { mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  }

  /** Remove every progress file of the run. Idempotent. */
  dispose(): void {
    if (!this.dir) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of a temp directory.
    }
    this.dir = undefined;
  }
}

export interface ProgressTailOptions {
  /** Called once per new non-empty line (normalized and length-capped). */
  onMessage: (message: string) => void;
  intervalMs?: number;
}

/**
 * Tails a progress file while a child process runs: every `intervalMs` it
 * reads the bytes appended since the last poll and reports each new line.
 * `stop()` drains what is left (including a final line without a newline).
 * Reads are synchronous and small, so `stop()` can run inside a synchronous
 * hook and still deliver the last message before the verdict.
 */
export class ProgressTail {
  private readonly onMessage: (message: string) => void;
  private readonly intervalMs: number;
  private readonly splitter: LineSplitter;
  private readonly decoder = new StringDecoder("utf8");
  private batch: string[] = [];
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly file: string,
    opts: ProgressTailOptions,
  ) {
    this.onMessage = opts.onMessage;
    this.intervalMs = opts.intervalMs ?? PROGRESS_POLL_MS;
    this.splitter = new LineSplitter((line) => {
      const message = normalizeLogLine(line).trim();
      if (message.length > 0) this.batch.push(capMessage(message));
    });
  }

  start(): this {
    if (this.stopped || this.timer !== undefined || this.intervalMs <= 0) {
      return this;
    }
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  /** Read and report what was appended since the last poll. */
  poll(): void {
    if (this.stopped) return;
    this.readNew();
    this.emitBatch();
  }

  /** Stop polling and report everything left in the file. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.readNew();
    this.splitter.push(this.decoder.end());
    this.splitter.flush();
    this.emitBatch();
    this.stopped = true;
  }

  private readNew(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0; // truncated or rewritten
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      while (this.offset < size) {
        const read = readSync(
          fd,
          buffer,
          0,
          Math.min(READ_CHUNK_BYTES, size - this.offset),
          this.offset,
        );
        if (read <= 0) break;
        this.offset += read;
        this.splitter.push(this.decoder.write(buffer.subarray(0, read)));
      }
    } catch {
      // The file may not exist yet or may have been removed; try next poll.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  private emitBatch(): void {
    if (this.batch.length === 0) return;
    const lines =
      this.batch.length > PROGRESS_MAX_LINES_PER_POLL
        ? this.batch.slice(-PROGRESS_MAX_LINES_PER_POLL)
        : this.batch;
    this.batch = [];
    for (const line of lines) {
      try {
        this.onMessage(line);
      } catch {
        // A consumer failure must never break the tail.
      }
    }
  }
}

function capMessage(message: string): string {
  return message.length <= PROGRESS_MESSAGE_MAX_CHARS
    ? message
    : `${message.slice(0, PROGRESS_MESSAGE_MAX_CHARS - 1)}…`;
}
