/**
 * Media streaming for the sandboxed renderer: the `cairn-artifact://`
 * protocol.
 *
 * Videos (`.webm` / `.mp4`) are too large for data URLs and need HTTP range
 * requests to seek, so the main process registers a privileged scheme and
 * serves files through it. The renderer never names a path: an IPC handler
 * validates the run directory and relative path first, registers the file
 * here, and hands back an opaque `cairn-artifact://media/<token>` URL. The
 * protocol handler only serves tokens it issued — an arbitrary path or a
 * guessed token is a 404.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { mimeFor } = require("./runs");

const MEDIA_SCHEME = "cairn-artifact";
const MEDIA_HOST = "media";

/**
 * @param {{ max?: number }} [options]
 */
function createMediaRegistry(options = {}) {
  const max = Math.max(8, options.max ?? 256);
  /** @type {Map<string, string>} token → absolute file */
  const byToken = new Map();
  /** @type {Map<string, string>} absolute file → token */
  const byFile = new Map();
  return {
    /**
     * @param {string} file an absolute path the caller already validated
     * @returns {string} the URL to hand to the renderer
     */
    register(file) {
      let token = byFile.get(file);
      if (!token) {
        token = crypto.randomBytes(16).toString("hex");
        byToken.set(token, file);
        byFile.set(file, token);
        while (byToken.size > max) {
          const [oldToken, oldFile] = byToken.entries().next().value;
          byToken.delete(oldToken);
          byFile.delete(oldFile);
        }
      }
      return `${MEDIA_SCHEME}://${MEDIA_HOST}/${token}`;
    },
    /**
     * @param {string} token
     * @returns {string | null}
     */
    resolve(token) {
      return byToken.get(token) ?? null;
    },
    /** Forget every token (project switch). */
    clear() {
      byToken.clear();
      byFile.clear();
    },
    size: () => byToken.size,
  };
}

/**
 * Parse a single-range `Range: bytes=…` header.
 * @param {string | null | undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | "unsatisfiable"}
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  let start;
  let end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!suffix) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * Serve one registered file, honouring a byte range.
 * @param {string} file
 * @param {{ headers: { get(name: string): string | null } }} request
 * @returns {Promise<Response>}
 */
async function fileResponse(file, request) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!stat.isFile()) return new Response("not found", { status: 404 });
  const size = stat.size;
  const type = mimeFor(file);
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable")
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const body =
    size === 0
      ? null
      : /** @type {any} */ (
          Readable.toWeb(fs.createReadStream(file, { start, end }))
        );
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(size === 0 ? 0 : end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

/**
 * The protocol handler: only `cairn-artifact://media/<token>` for tokens the
 * registry issued.
 * @param {ReturnType<typeof createMediaRegistry>} registry
 * @returns {(request: { url: string, headers: { get(name: string): string | null } }) => Promise<Response>}
 */
function createMediaHandler(registry) {
  return async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== MEDIA_HOST)
      return new Response("not found", { status: 404 });
    const token = url.pathname.replace(/^\/+/, "");
    const file = /^[0-9a-f]{32}$/.test(token) ? registry.resolve(token) : null;
    if (!file) return new Response("not found", { status: 404 });
    return fileResponse(file, request);
  };
}

module.exports = {
  MEDIA_SCHEME,
  MEDIA_HOST,
  createMediaRegistry,
  parseRange,
  fileResponse,
  createMediaHandler,
};
