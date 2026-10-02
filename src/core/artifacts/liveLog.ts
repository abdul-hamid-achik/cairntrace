import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
/** Default cap per log file; later lines are dropped after one notice. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** A line longer than this is flushed in pieces even without a newline. */
const MAX_PENDING_CHARS = 64 * 1024;
/**
 * Characters of an over-long line kept back when it is flushed in pieces, so
 * a secret that is still arriving at the cut is completed (and redacted) by
 * the next chunk instead of being split across two writes.
 */
const OVERFLOW_HOLDBACK_CHARS = 8 * 1024;

export interface LineSplitterOptions {
  /**
   * Redacts an over-long line before it is cut into pieces. Without it a
   * secret straddling the cut would reach the line redactor in two halves.
   */
  redact?: (text: string) => string;
}

/**
 * Splits streamed text into complete lines. A trailing partial line is held
 * until the next chunk (or `flush()`), so a value split across two chunks is
 * seen whole by whoever redacts the line.
 */
export class LineSplitter {
  private pending = "";
  private readonly redact: ((text: string) => string) | undefined;

  constructor(
    private readonly onLine: (line: string) => void,
    opts: LineSplitterOptions = {},
  ) {
    this.redact = opts.redact;
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
    const parts = (this.pending + chunk).split("\n");
    this.pending = parts.pop() ?? "";
    for (const part of parts) this.onLine(part);
    if (this.pending.length > MAX_PENDING_CHARS) {
      // Redact the whole pending text first, then emit all but its tail: a
      // secret that is complete is already scrubbed, and one still arriving
      // starts inside the held-back tail (secrets are shorter than it).
      const text = this.redact ? this.redact(this.pending) : this.pending;
      const cut = Math.max(0, text.length - OVERFLOW_HOLDBACK_CHARS);
      this.pending = text.slice(cut);
      if (cut > 0) this.onLine(text.slice(0, cut));
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const line = this.pending;
    this.pending = "";
    this.onLine(line);
  }
}

/**
 * One log line as a plain-text viewer should see it: ANSI escapes removed and
 * carriage-return progress redraws collapsed to their final state.
 */
export function normalizeLogLine(line: string): string {
  let text = line;
  if (text.includes("\r")) {
    const segments = text.split("\r").filter((segment) => segment.length > 0);
    text = segments.at(-1) ?? "";
  }
  let clean = "";
  for (const character of stripVTControlCharacters(text)) {
    const codePoint = character.codePointAt(0)!;
    if (
      character === "\t" ||
      (codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      clean += character;
    }
  }
  return clean;
}

export interface LiveLogOptions {
  /** Redacts one complete line before it reaches the file. */
  redact?: (line: string) => string;
  /** Lines for which this returns false are not written (e.g. a protocol marker). */
  filter?: (line: string) => boolean;
  /** Byte cap for the file; later lines are dropped after one notice. */
  maxBytes?: number;
  /** Characters of redacted output remembered for {@link LiveLog.tail}. */
  tailChars?: number;
}

/**
 * Append-only, line-buffered, redacted log file for live child output
 * (precondition commands, hooks, services, verifier scripts) and narration.
 *
 * Only complete lines are redacted and written. Writes are synchronous: they
 * are small, they keep their order without a promise chain, and they are
 * already on disk when a signal handler exits the process. Logging is
 * best-effort; a filesystem error disables the log instead of failing the run.
 */
export class LiveLog {
  readonly path: string;
  private readonly redact: (line: string) => string;
  private readonly filter: ((line: string) => boolean) | undefined;
  private readonly maxBytes: number;
  private readonly tailChars: number;
  private readonly splitter: LineSplitter;
  private fd: number | undefined;
  private bytes = 0;
  private capped = false;
  private closed = false;
  private recent = "";

  constructor(path: string, opts: LiveLogOptions = {}) {
    this.path = path;
    this.redact = opts.redact ?? ((line) => line);
    this.filter = opts.filter;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.tailChars = opts.tailChars ?? 4000;
    this.splitter = new LineSplitter((line) => this.writeLine(line), {
      redact: this.redact,
    });
    try {
      mkdirSync(dirname(path), { recursive: true, mode: LOG_DIRECTORY_MODE });
      this.fd = openSync(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_APPEND |
          (fsConstants.O_NOFOLLOW ?? 0),
        LOG_FILE_MODE,
      );
    } catch {
      this.fd = undefined;
    }
  }

  /** Whether the file could be opened (a disabled log drops writes). */
  get available(): boolean {
    return this.fd !== undefined;
  }

  /** Stream a raw chunk; complete lines are written as they arrive. */
  write(chunk: string): void {
    if (this.closed) return;
    this.splitter.push(chunk);
  }

  /** Write one line (normalized, filtered, redacted). */
  writeLine(raw: string): void {
    if (this.closed) return;
    const normalized = normalizeLogLine(raw);
    if (this.filter && !this.filter(normalized)) return;
    const line = this.redact(normalized);
    this.remember(line);
    this.append(`${line}\n`);
  }

  /** The last `max` characters of what was written (already redacted). */
  tail(max = this.tailChars): string {
    const text = this.recent.endsWith("\n")
      ? this.recent.slice(0, -1)
      : this.recent;
    return text.length <= max ? text : text.slice(text.length - max);
  }

  /** Write a trailing partial line now (the file stays open). */
  flush(): void {
    if (!this.closed) this.splitter.flush();
  }

  /** Flush a trailing partial line and close the file. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.splitter.flush();
    this.closed = true;
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed or the volume vanished; nothing left to flush.
      }
      this.fd = undefined;
    }
  }

  private remember(line: string): void {
    this.recent += `${line}\n`;
    if (this.recent.length > this.tailChars * 2) {
      this.recent = this.recent.slice(this.recent.length - this.tailChars);
    }
  }

  private append(text: string): void {
    if (this.fd === undefined || this.capped) return;
    const size = Buffer.byteLength(text);
    if (this.bytes + size > this.maxBytes) {
      this.capped = true;
      this.rawWrite(
        `[cairn] log truncated: reached ${this.maxBytes} bytes; later lines were dropped\n`,
      );
      return;
    }
    this.bytes += size;
    this.rawWrite(text);
  }

  private rawWrite(text: string): void {
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, text);
    } catch {
      // Disk full or the file was removed under us: stop logging, keep running.
      try {
        closeSync(this.fd);
      } catch {
        // ignore
      }
      this.fd = undefined;
    }
  }
}

/**
 * Filesystem-safe slug for a log file name (`[A-Za-z0-9._-]`, at most `max`
 * characters, 60 by default).
 */
export function logSlug(value: string, max = 60): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, max);
  return slug.length > 0 ? slug : "item";
}

/** Two-digit (or wider) 1-based position for log file names. */
export function logIndex(index: number): string {
  return String(index).padStart(2, "0");
}
