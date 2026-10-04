import { writeSync } from "node:fs";

/**
 * Make stdout and stderr writes synchronous when they are pipes or files.
 *
 * Bun (and Node on macOS) write to a pipe asynchronously, and most commands end
 * with `process.exit(code)` right after printing: whatever the reader had not
 * drained yet was dropped, so `cairn spec verify --json | jq` could get a JSON
 * document cut at the pipe buffer (64 KiB). A blocking write keeps every byte.
 * A reader that went away (EPIPE) ends the writes silently, as a closed pipe
 * should. Terminals keep the runtime's own writer.
 *
 * `cairn mcp` is left alone: its JSON-RPC stream must never block on a client
 * that is busy writing to us.
 */
export function installSyncStdio(argv: readonly string[] = process.argv): void {
  if (argv[2] === "mcp") return;
  if (!process.stdout.isTTY) makeSynchronous(process.stdout, 1);
  if (!process.stderr.isTTY) makeSynchronous(process.stderr, 2);
}

type WriteCallback = (error?: Error | null) => void;

/** Exported for tests: replaces `stream.write` with a blocking write to `fd`. */
export function makeSynchronous(stream: NodeJS.WriteStream, fd: number): void {
  let closed = false;
  const write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    const buffer =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : Buffer.from(chunk);
    if (!closed) closed = !writeAll(fd, buffer);
    done?.(null);
    return true;
  };
  (stream as unknown as { write: typeof write }).write = write;
}

/** Writes every byte (waiting out a full non-blocking pipe); false once the reader is gone. */
function writeAll(fd: number, buffer: Buffer): boolean {
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        sleepSync(2);
        continue;
      }
      // EPIPE (the reader closed), EBADF (the descriptor is gone): stop writing.
      return false;
    }
  }
  return true;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
