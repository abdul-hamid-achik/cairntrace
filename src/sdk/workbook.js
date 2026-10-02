// Read-only .xlsx reader for verifier code (`ctx.xlsx(path)`).
//
// Plain ESM JavaScript on purpose: the verifier SDK runs inside the Node child
// of a `script.runtime: node` verifier, and Node refuses to strip TypeScript
// types from files under node_modules (where a published Cairntrace lives).
// Types live in workbook.d.ts.
//
// No dependency: an .xlsx file is a ZIP of XML parts. Only stored (0) and
// deflated (8) entries are supported, which is what every spreadsheet writer
// produces. Values are returned as the strings Excel stores (numbers and
// dates unformatted, booleans as "1"/"0", shared strings resolved).

import { inflateRawSync } from "node:zlib";

/**
 * Parse workbook bytes into sheets with a dense row grid.
 * @param {Uint8Array} bytes
 */
export function readWorkbook(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readZipEntries(buffer);
  const workbookXml = readZipText(entries, "xl/workbook.xml");
  const relsXml = readZipText(entries, "xl/_rels/workbook.xml.rels");
  const sharedStrings = entries.has("xl/sharedstrings.xml")
    ? parseSharedStrings(readZipText(entries, "xl/sharedStrings.xml"))
    : [];
  const targets = parseRelationships(relsXml);
  const sheets = [];
  for (const ref of parseWorkbookSheets(workbookXml)) {
    const target = targets.get(ref.relId);
    if (!target || !entries.has(target.toLowerCase())) continue;
    sheets.push(
      parseSheet(ref.name, readZipText(entries, target), sharedStrings),
    );
  }
  return { sheets };
}

/** @param {Buffer} buffer */
function readZipEntries(buffer) {
  const entries = new Map();
  const eocd = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid xlsx: bad zip central directory");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = normalizePath(
      buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
    );
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("invalid xlsx: bad zip local header");
    }
    const dataOffset =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
    if (method !== 0 && method !== 8) {
      throw new Error(`invalid xlsx: unsupported zip compression ${method}`);
    }
    // Lowercase keys: part names are case-insensitive in OPC packages.
    entries.set(name.toLowerCase(), method === 0 ? data : inflateRawSync(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** @param {Buffer} buffer */
function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("invalid xlsx: not a zip file");
}

/** @param {Map<string, Buffer>} entries @param {string} path */
function readZipText(entries, path) {
  const entry = entries.get(normalizePath(path).toLowerCase());
  if (!entry) throw new Error(`invalid xlsx: missing ${path}`);
  return entry.toString("utf8");
}

/** @param {string} xml */
function parseWorkbookSheets(xml) {
  const out = [];
  for (const match of xml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const attrs = parseAttributes(match[0]);
    const relId = attrs["r:id"] ?? attrs["id"];
    if (attrs["name"] && relId) out.push({ name: attrs["name"], relId });
  }
  return out;
}

/** @param {string} xml */
function parseRelationships(xml) {
  const out = new Map();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs = parseAttributes(match[0]);
    if (!attrs["Id"] || !attrs["Target"]) continue;
    const target = attrs["Target"].replace(/^\/+/, "");
    out.set(
      attrs["Id"],
      normalizePath(target.startsWith("xl/") ? target : `xl/${target}`),
    );
  }
  return out;
}

/** @param {string} xml */
function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    textNodes(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")),
  );
}

/**
 * @param {string} name
 * @param {string} xml
 * @param {string[]} sharedStrings
 */
function parseSheet(name, xml, sharedStrings) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {Map<string, string>} */
  const cells = new Map();
  let width = 0;
  // Self-closing (empty, styled) cells must not swallow the next cell's body.
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = parseAttributes(`<c ${match[1]}>`);
    const ref = attrs["r"];
    const body = match[2];
    if (!ref || body === undefined) continue;
    const value = cellValue(body, attrs["t"], sharedStrings);
    if (value === "") continue;
    const pos = parseRef(ref);
    if (!pos) continue;
    cells.set(ref.toUpperCase(), value);
    const row = (rows[pos.row] ??= []);
    row[pos.column] = value;
    width = Math.max(width, pos.column + 1);
  }
  for (let r = 0; r < rows.length; r++) {
    const row = (rows[r] ??= []);
    for (let c = 0; c < width; c++) row[c] ??= "";
  }
  const validations = [
    ...xml.matchAll(
      /<dataValidation\b[^>]*(?:\/>|>[\s\S]*?<\/dataValidation>)/g,
    ),
  ]
    .map((m) => parseAttributes(m[0]))
    .filter((attrs) => attrs["sqref"])
    .map((attrs) => ({
      ...(attrs["type"] ? { type: attrs["type"] } : {}),
      sqref: attrs["sqref"],
    }));
  return { name, rows, cells, validations };
}

/**
 * @param {string} body
 * @param {string | undefined} type
 * @param {string[]} sharedStrings
 */
function cellValue(body, type, sharedStrings) {
  if (type === "inlineStr") return textNodes(body);
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) return "";
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) ? (sharedStrings[index] ?? "") : "";
  }
  return decodeXml(raw);
}

/** `B12` → { row: 11, column: 1 } (0-based). @param {string} ref */
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!m) return undefined;
  let column = 0;
  for (const ch of m[1].toUpperCase())
    column = column * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, column: column - 1 };
}

/** @param {string} xml */
function textNodes(xml) {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((m) => decodeXml(m[1]))
    .join("");
}

/** @param {string} tag */
function parseAttributes(tag) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = decodeXml(m[2]);
  }
  return attrs;
}

/** @param {string} path */
function normalizePath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** @param {string} input */
function decodeXml(input) {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
