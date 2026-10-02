import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  deflateRawSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
} from "node:zlib";
import type { ArtifactRedactor } from "./ArtifactWriter";
import { isSensitiveEnvKey } from "./redaction";

/**
 * Trace sanitizer for the evidence gate (stash/publish). Browser traces are
 * written by the backend, outside the ArtifactWriter redactor:
 *
 *   - Playwright: a Trace Viewer zip whose `*.network` members hold HAR-like
 *     request/response records (Authorization, Cookie, Set-Cookie headers,
 *     cookies), `*.trace` holds actions and DOM snapshots, `resources/` holds
 *     response bodies.
 *   - agent-browser: Chrome trace-event JSON (Perfetto / chrome://tracing).
 *
 * Sanitizing walks every JSON value and keeps its SHAPE (viewers index into
 * arrays and objects):
 *
 *   - a sensitive `{name, value}` pair (header, cookie, query/form param,
 *     storage entry) keeps its name and gets `"[redacted]"` as value;
 *   - every string under a sensitive key, and the whole `storageState` /
 *     `localStorage` / `sessionStorage` / `origins` subtrees, become
 *     `"[redacted]"`;
 *   - values typed into password fields are harvested first (the
 *     `__playwright_value_` of a `type=password` input in a DOM snapshot, a
 *     `fill`/`type` call whose selector names a password/secret/otp field)
 *     and then replaced everywhere they appear (call params, log lines,
 *     snapshots);
 *   - every other string goes through the run redactor (registered secret
 *     values, credential header lines, URI userinfo), then through a
 *     key-based scrub of `name=value` parameters (URL queries, fragments,
 *     form bodies, including a leading parameter), and a string holding a
 *     JSON document is scrubbed structurally.
 *
 * Non-JSON text members are scrubbed as text; binary members (images,
 * fonts) are copied unchanged. This is best effort, not a guarantee: a
 * credential with an unrecognizable name in free text survives. A trace it
 * rewrote is therefore labeled `sanitized` (stashable on opt-in, never
 * published), not `redacted`.
 */

export type TraceFormat = "playwright-zip" | "chrome-trace-json";

export interface TraceSanitizeOptions {
  redactor: ArtifactRedactor;
  /** Extra header/key names to redact (spec `redaction.headers`/`storageKeys`). */
  sensitiveNames?: readonly string[];
}

export type TraceSanitizeResult =
  | { ok: true; format: TraceFormat; bytes: number }
  | { ok: false; error: string };

const REDACTED = "[redacted]";
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
/** Refuse to inflate more than this while sanitizing (zip-bomb bound). */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;

/** Detect a trace's real format from its bytes (legacy `.zip` names lie). */
export function detectTraceFormat(bytes: Buffer): TraceFormat | undefined {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL) {
    return "playwright-zip";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "chrome-trace-json";
  }
  for (const byte of bytes.subarray(0, 64)) {
    if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) {
      continue;
    }
    return byte === 0x7b || byte === 0x5b ? "chrome-trace-json" : undefined;
  }
  return undefined;
}

/**
 * Sanitize a trace file in place (atomic rename). Fails closed: on any
 * error the original file is left untouched and the caller must treat it
 * as secret-bearing.
 */
export async function sanitizeTraceFile(
  absolutePath: string,
  options: TraceSanitizeOptions,
): Promise<TraceSanitizeResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    return { ok: false, error: `cannot read trace: ${errorText(error)}` };
  }
  let sanitized: { format: TraceFormat; bytes: Buffer };
  try {
    sanitized = sanitizeTraceBytes(bytes, options);
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
  const temp = join(
    dirname(absolutePath),
    `.${basename(absolutePath)}.sanitizing-${process.pid}`,
  );
  try {
    await rm(temp, { force: true });
    await writeFile(temp, sanitized.bytes, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, absolutePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    return { ok: false, error: `cannot rewrite trace: ${errorText(error)}` };
  }
  return { ok: true, format: sanitized.format, bytes: sanitized.bytes.length };
}

/** Pure form of {@link sanitizeTraceFile}; throws on unsupported input. */
export function sanitizeTraceBytes(
  bytes: Buffer,
  options: TraceSanitizeOptions,
): { format: TraceFormat; bytes: Buffer } {
  const format = detectTraceFormat(bytes);
  if (format === "playwright-zip") {
    return { format, bytes: sanitizeZip(bytes, options) };
  }
  if (format === "chrome-trace-json") {
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const text = (gzipped ? gunzipSync(bytes) : bytes).toString("utf8");
    const document = JSON.parse(text) as unknown;
    const harvested = new Set<string>();
    if (HARVEST_HINT_RE.test(text)) harvestSecretInputs(document, harvested);
    const scrubber = makeScrubber(options, harvested);
    const out = Buffer.from(JSON.stringify(scrubber.value(document)), "utf8");
    return { format, bytes: gzipped ? gzipSync(out) : out };
  }
  throw new Error("unrecognized trace format (neither a zip nor JSON)");
}

/* ----- JSON scrubbing ----- */

/**
 * Names whose values are credentials in `{name, value}` pairs and in
 * `name=value` parameters, beyond the run redactor's key list: OAuth/OIDC
 * (`id_token`, `client_secret`, `code`), SAML, sessions, signed URLs.
 */
const SENSITIVE_PARAM_NAME_RE =
  /session|saml|jwt|bearer|pwd|nonce|^(?:auth|code|key|sig|signature|sid|ticket|pin)$|^x-auth|[-_]auth$|^auth[-_]/i;
/** Keys whose whole subtree is hidden (Playwright storage state). */
const HIDDEN_SUBTREE_KEY_RE =
  /^(?:storagestate|localstorage|sessionstorage|origins)$/i;
/** Keys that hold an entry's name / value in Playwright trace records. */
const PAIR_NAME_KEYS = ["name", "k"] as const;
const PAIR_VALUE_KEYS = new Set(["value", "v", "__playwright_value_"]);
/** A selector or field label that names a password/secret input. */
const SECRET_FIELD_RE =
  /pass(?:word|wd|code|phrase)?|pwd|\bpw\b|secret|token|otp|one-time|\bpin\b|cvv|cvc|ssn/i;
/** Input methods whose `params.value` / `params.text` is typed text. */
const TYPING_METHODS = new Set(["fill", "type", "pressSequentially"]);
/** `name=value` after a start, `?`, `&`, `#`, `;`, `,` or whitespace. */
const PARAM_RE = /(^|[?&#;,\s])([^=&#;,\s?]+)=([^&#;,\s]*)/g;
/**
 * Harvested values shorter than this are replaced only where a string IS
 * the value, not inside longer strings (a 2-char value would shred text).
 */
const MIN_HARVESTED_CHARS = 4;
/** Members/lines the harvest pass parses (a cheap prefilter). */
const HARVEST_HINT_RE =
  /password|one-time-code|"method":"(?:fill|type|pressSequentially)"/i;

interface Scrubber {
  value(input: unknown): unknown;
  text(input: string): string;
}

function makeScrubber(
  options: TraceSanitizeOptions,
  harvested: ReadonlySet<string> = new Set(),
): Scrubber {
  const extra = new Set(
    (options.sensitiveNames ?? []).map((name) => name.trim().toLowerCase()),
  );
  const sensitiveKey = (name: string): boolean =>
    isSensitiveEnvKey(name) || extra.has(name.trim().toLowerCase());
  const sensitiveName = (name: string): boolean =>
    sensitiveKey(name) || SENSITIVE_PARAM_NAME_RE.test(name.trim());
  const literals = [...harvested]
    .filter((value) => value.length >= MIN_HARVESTED_CHARS)
    .toSorted((a, b) => b.length - a.length);
  const redactor = options.redactor.text;

  const scrubParams = (input: string): string =>
    input.replace(PARAM_RE, (match, separator: string, encodedName: string) => {
      const name = decodeName(encodedName);
      return name !== undefined && sensitiveName(name)
        ? `${separator}${encodedName}=${REDACTED}`
        : match;
    });

  const text = (input: string): string => {
    let output = input;
    for (const literal of literals)
      output = output.split(literal).join(REDACTED);
    return scrubParams(redactor(output));
  };

  const walk = (value: unknown, hidden: boolean): unknown => {
    if (typeof value === "string") {
      if (hidden || harvested.has(value)) return REDACTED;
      if (value.length < 4) return value;
      const embedded = parseEmbeddedJson(value);
      return embedded === undefined
        ? text(value)
        : JSON.stringify(walk(embedded, false));
    }
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, hidden));
    const record = value as Record<string, unknown>;
    const namedSecret = PAIR_NAME_KEYS.some(
      (key) => typeof record[key] === "string" && sensitiveName(record[key]),
    );
    const secretInput = isSecretInput(record);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if ((namedSecret || secretInput) && PAIR_VALUE_KEYS.has(key)) {
        // An empty value stays empty: it holds nothing and the viewer
        // should not show a filled field.
        output[key] =
          typeof child === "string"
            ? child === ""
              ? child
              : REDACTED
            : walk(child, true);
      } else {
        output[key] = walk(
          child,
          hidden || sensitiveKey(key) || HIDDEN_SUBTREE_KEY_RE.test(key),
        );
      }
    }
    return output;
  };
  return { value: (input) => walk(input, false), text };
}

/** A DOM-snapshot input whose value is a credential (type=password, …). */
function isSecretInput(record: Record<string, unknown>): boolean {
  const type = record.type;
  if (typeof type === "string" && type.toLowerCase() === "password") {
    return true;
  }
  const autocomplete = record.autocomplete;
  return (
    typeof autocomplete === "string" &&
    /password|one-time-code/i.test(autocomplete)
  );
}

/** A string that is itself a JSON object/array (a JSON request body). */
function parseEmbeddedJson(value: string): unknown {
  const first = value.trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decodeName(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return undefined;
  }
}

/**
 * Collect values typed into password fields so they can be replaced
 * everywhere: the `__playwright_value_`/`value` of a `type=password` (or
 * password/one-time-code autocomplete) input, and the value of a
 * `fill`/`type` call whose selector names a secret field.
 */
function harvestSecretInputs(value: unknown, into: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) harvestSecretInputs(item, into);
    return;
  }
  const record = value as Record<string, unknown>;
  if (isSecretInput(record)) {
    for (const key of PAIR_VALUE_KEYS) {
      const typed = record[key];
      if (typeof typed === "string" && typed.length > 0) into.add(typed);
    }
  }
  const params = record.params;
  if (
    typeof record.method === "string" &&
    TYPING_METHODS.has(record.method) &&
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params)
  ) {
    const call = params as Record<string, unknown>;
    if (
      typeof call.selector === "string" &&
      SECRET_FIELD_RE.test(call.selector)
    ) {
      for (const key of ["value", "text"]) {
        const typed = call[key];
        if (typeof typed === "string" && typed.length > 0) into.add(typed);
      }
    }
  }
  for (const child of Object.values(record)) harvestSecretInputs(child, into);
}

/** Harvest from JSON text (one document or NDJSON), skipping cheap misses. */
function harvestFromText(content: string, into: Set<string>): void {
  if (!HARVEST_HINT_RE.test(content)) return;
  try {
    harvestSecretInputs(JSON.parse(content) as unknown, into);
    return;
  } catch {
    // NDJSON (trace.trace / trace.network): one record per line.
  }
  for (const line of content.split("\n")) {
    if (!HARVEST_HINT_RE.test(line)) continue;
    try {
      harvestSecretInputs(JSON.parse(line) as unknown, into);
    } catch {
      // A non-JSON line holds no structured input values.
    }
  }
}

function sanitizeNdjson(input: string, scrubber: Scrubber): string {
  return input
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      try {
        return JSON.stringify(scrubber.value(JSON.parse(line) as unknown));
      } catch {
        return scrubber.text(line);
      }
    })
    .join("\n");
}

/* ----- zip read/rewrite (store + deflate, no zip64) ----- */

interface ZipMember {
  name: string;
  data: Buffer;
  dosTime: number;
  dosDate: number;
}

function sanitizeZip(bytes: Buffer, options: TraceSanitizeOptions): Buffer {
  const members = readZip(bytes);
  const harvested = new Set<string>();
  for (const member of members) {
    if (isTextMember(member)) {
      harvestFromText(member.data.toString("utf8"), harvested);
    }
  }
  const scrubber = makeScrubber(options, harvested);
  return writeZip(
    members.map((member) => ({
      ...member,
      data: sanitizeMember(member, scrubber),
    })),
  );
}

function isTextMember(member: ZipMember): boolean {
  return !member.name.endsWith("/") && looksLikeText(member.data);
}

function sanitizeMember(member: ZipMember, scrubber: Scrubber): Buffer {
  if (!isTextMember(member)) return member.data;
  const content = member.data.toString("utf8");
  if (/\.(?:trace|network|ndjson|jsonl)$/.test(member.name)) {
    return Buffer.from(sanitizeNdjson(content, scrubber), "utf8");
  }
  try {
    return Buffer.from(
      JSON.stringify(scrubber.value(JSON.parse(content) as unknown)),
      "utf8",
    );
  } catch {
    return Buffer.from(scrubber.text(content), "utf8");
  }
}

/** Valid UTF-8 without NUL bytes in the first 8 KiB. */
function looksLikeText(data: Buffer): boolean {
  if (data.length === 0) return false;
  const head = data.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    // A multi-byte character cut at the 8 KiB boundary is still text.
    return head.length === 8192;
  }
}

function readZip(bytes: Buffer): ZipMember[] {
  const end = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) {
    throw new Error("zip64 traces are not supported");
  }
  const members: ZipMember[] = [];
  let inflated = 0;
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL) {
      throw new Error("corrupt zip central directory");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const dosTime = bytes.readUInt16LE(offset + 12);
    const dosDate = bytes.readUInt16LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (flags & 0x1) throw new Error("encrypted zip members are not supported");
    if (compressedSize === 0xffffffff || size === 0xffffffff) {
      throw new Error("zip64 traces are not supported");
    }
    if (bytes.readUInt32LE(localOffset) !== ZIP_LOCAL) {
      throw new Error("corrupt zip local header");
    }
    const dataStart =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    inflated += size;
    if (inflated > MAX_INFLATED_BYTES) {
      throw new Error("trace inflates beyond the sanitizer bound");
    }
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip compression method ${method}`);
    if (
      data.length !== size ||
      crc32(data) !== bytes.readUInt32LE(offset + 16)
    ) {
      throw new Error(`zip member failed its integrity check: ${name}`);
    }
    members.push({ name, data, dosTime, dosDate });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= floor; offset--) {
    if (bytes.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new Error("not a zip archive (no end of central directory)");
}

function writeZip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const deflated = deflateRawSync(member.data);
    const stored = deflated.length >= member.data.length;
    const payload = stored ? member.data : deflated;
    const crc = crc32(member.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(member.dosTime, 10);
    local.writeUInt16LE(member.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(member.dosTime, 12);
    central.writeUInt16LE(member.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(member.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
