import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  runEventSchemaOf,
  type DelegateDiagnosticCode,
  type RunEvent,
} from "../schema/events.v1";

/**
 * The delegate events stream (`urn:cairntrace.dev:delegate:v1`): an NDJSON
 * file a runner appends to (CAIRN_DELEGATE_EVENTS) and cairn tails. A file,
 * not a pipe: the runner never blocks on a reader that is busy (the
 * synchronous signal path keeps reading it while it waits for the runner),
 * a reconnecting runner can re-append from the start (the relay drops exact
 * duplicates), and nothing is lost when cairn is slow.
 */

/** Longest line the relay reads as an event (longer lines are diagnostics). */
export const MAX_STREAM_LINE_BYTES = 1024 * 1024;
/** Characters of a bad line quoted in its diagnostic (then redacted). */
const EXCERPT_CHARS = 160;

export type ParsedStreamLine =
  | { kind: "event"; event: RunEvent; lenient: boolean }
  | {
      kind: "invalid";
      level: "warn" | "error";
      code: DelegateDiagnosticCode;
      message: string;
    };

function excerpt(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS
    ? `${flat.slice(0, EXCERPT_CHARS)}…`
    : flat;
}

/**
 * One stream line → an events.v1 event (strict producer schema first; a
 * known type with fields this cairn does not know is accepted with them
 * dropped) or the reason it is not one. Never throws.
 */
export function parseStreamLine(line: string): ParsedStreamLine {
  if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES) {
    return {
      kind: "invalid",
      level: "error",
      code: "line-too-long",
      message: `a line longer than ${MAX_STREAM_LINE_BYTES} bytes was dropped: ${excerpt(line)}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      kind: "invalid",
      level: "error",
      code: "malformed-line",
      message: `not JSON: ${excerpt(line)}`,
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "invalid",
      level: "error",
      code: "malformed-line",
      message: `not a JSON object: ${excerpt(line)}`,
    };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    return {
      kind: "invalid",
      level: "error",
      code: "invalid-event",
      message: `an object without a "type": ${excerpt(line)}`,
    };
  }
  const strict = runEventSchemaOf(type);
  if (!strict) {
    return {
      kind: "invalid",
      level: "warn",
      code: "unknown-event",
      message: `unknown event type "${excerpt(type)}" (a newer runner or cairn?); not relayed`,
    };
  }
  const parsed = strict.safeParse(value);
  if (parsed.success) {
    return { kind: "event", event: parsed.data as RunEvent, lenient: false };
  }
  const lenient = runEventSchemaOf(type, "lenient")?.safeParse(value);
  if (lenient?.success) {
    return { kind: "event", event: lenient.data as RunEvent, lenient: true };
  }
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return {
    kind: "invalid",
    level: "error",
    code: "invalid-event",
    message: `${excerpt(type)} does not validate against events.v1${where}: ${issue?.message ?? "invalid"}`,
  };
}

/** Starts a torn line's recovery tries at most. */
const MAX_TORN_CANDIDATES = 32;

/**
 * The event a torn line still carries: a runner that lost its connection
 * in the middle of a line and re-streamed from the start leaves the torn
 * head glued to the first re-streamed line (`{"ts":"…","type":"sui{"ts":…}`).
 * Returns the trailing whole JSON object when one starts after the head
 * (the earliest `{"` that parses as an object with a `type`), else
 * undefined. Bounded: at most {@link MAX_TORN_CANDIDATES} starts are tried.
 */
export function recoverTornLine(line: string): string | undefined {
  let from = 1;
  for (let tries = 0; tries < MAX_TORN_CANDIDATES; tries++) {
    const start = line.indexOf('{"', from);
    if (start < 0) return undefined;
    const tail = line.slice(start);
    try {
      const value: unknown = JSON.parse(tail);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { type?: unknown }).type === "string"
      ) {
        return tail;
      }
    } catch {
      // Not this one: the next `{"` may start the whole line.
    }
    from = start + 2;
  }
  return undefined;
}

/** Bytes read per call at most (a runner that floods is read over several ticks). */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Bytes read from the file per `readSync`. */
const READ_BUFFER_BYTES = 1024 * 1024;

/**
 * Tail of an append-only text file by byte offset, read synchronously (the
 * async poller and the synchronous signal path share it). Lines come back
 * whole; a torn last line waits for its newline unless `final`. A file that
 * shrinks is read again from the start.
 *
 * Memory is bounded: a line keeps at most `maxLineBytes + 1` bytes — the
 * rest of an overlong line is dropped up to its newline, and the line comes
 * back truncated, still longer than the limit, so the relay reports it
 * (`line-too-long`) instead of the tail buffering it without end.
 */
export class FileLineTail {
  private offset = 0;
  /** The current (unterminated) line, at most `cap` bytes. */
  private parts: Buffer[] = [];
  private partBytes = 0;
  private readonly cap: number;

  constructor(
    readonly path: string,
    maxLineBytes: number = MAX_STREAM_LINE_BYTES,
  ) {
    this.cap = maxLineBytes + 1;
  }

  read(final = false): string[] {
    const lines: string[] = [];
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.parts = [];
        this.partBytes = 0;
      }
      let budget = final ? Number.POSITIVE_INFINITY : READ_CHUNK_BYTES;
      while (this.offset < size && budget > 0) {
        const length = Math.min(size - this.offset, budget, READ_BUFFER_BYTES);
        const buffer = Buffer.alloc(length);
        const read = readSync(fd, buffer, 0, length, this.offset);
        if (read <= 0) break;
        this.offset += read;
        budget -= read;
        this.split(buffer.subarray(0, read), lines);
      }
    } catch {
      // Not there yet (or gone): whatever is pending stays pending.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
      }
    }
    if (final && this.partBytes > 0) this.emit(lines);
    return lines
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim().length > 0);
  }

  /** Cut `chunk` at its newlines into `lines`, keeping the rest pending. */
  private split(chunk: Buffer, lines: string[]): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      this.keep(chunk.subarray(start, newline < 0 ? chunk.length : newline));
      if (newline < 0) return;
      this.emit(lines);
      start = newline + 1;
    }
  }

  /** Add to the current line, up to the cap (the rest of it is dropped). */
  private keep(piece: Buffer): void {
    const room = this.cap - this.partBytes;
    if (room <= 0 || piece.length === 0) return;
    const kept = piece.length > room ? piece.subarray(0, room) : piece;
    // A copy: the read buffer is reused for the next chunk's lines.
    this.parts.push(Buffer.from(kept));
    this.partBytes += kept.length;
  }

  private emit(lines: string[]): void {
    lines.push(Buffer.concat(this.parts, this.partBytes).toString("utf8"));
    this.parts = [];
    this.partBytes = 0;
  }
}
