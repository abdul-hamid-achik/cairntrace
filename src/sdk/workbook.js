// Read-only .xlsx reader for verifier code (`ctx.xlsx(path)`) and the typed
// `xlsx` outcome verifier: both read workbooks through this one parser.
//
// Plain ESM JavaScript on purpose: the verifier SDK runs inside the Node child
// of a `script.runtime: node` verifier, and Node refuses to strip TypeScript
// types from files under node_modules (where a published Cairntrace lives).
// Types live in workbook.d.ts.
//
// No dependency: an .xlsx file is a ZIP of XML parts. Only stored (0) and
// deflated (8) entries are supported, which is what every spreadsheet writer
// produces. Values are returned as the strings Excel stores (numbers and
// dates unformatted, booleans as "1"/"0", shared strings resolved). Number
// formats and data validations (with their formulas) are read too, so a
// check can assert that a column is text-formatted or carries a custom rule.

import { inflateRawSync } from "node:zlib";

/**
 * Built-in number formats (ECMA-376 §18.8.30): ids below 164 that have no
 * `<numFmt>` entry use these codes.
 * @type {Record<number, string>}
 */
const BUILTIN_NUM_FMTS = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

/**
 * Most cells a sheet's dense row grid may span (rows × the widest column):
 * one stray far-off cell (`XFD1000`) would otherwise allocate a grid of
 * millions of empty cells. A sheet past it is refused with a clear error.
 */
const MAX_GRID_CELLS = 5_000_000;
/** Most bytes one zip entry may inflate to (a zip bomb is refused). */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/**
 * Parse workbook bytes into sheets with a dense row grid, number formats
 * and data validations.
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
  const rels = parseRelationships(relsXml);
  const stylesPath =
    [...rels.values()].find((rel) => /\/styles$/i.test(rel.type))?.target ??
    "xl/styles.xml";
  const styles = entries.has(stylesPath.toLowerCase())
    ? parseStyles(readZipText(entries, stylesPath))
    : { xfNumFmtIds: [], customNumFmts: new Map() };
  const sheets = [];
  for (const ref of parseWorkbookSheets(workbookXml)) {
    const target = rels.get(ref.relId)?.target;
    if (!target || !entries.has(target.toLowerCase())) continue;
    sheets.push(
      parseSheet(ref.name, readZipText(entries, target), sharedStrings, styles),
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
    let inflated = data;
    if (method === 8) {
      try {
        inflated = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (e) {
        const code = /** @type {{ code?: string }} */ (e).code;
        throw new Error(
          code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE"
            ? `invalid xlsx: ${name} inflates past ${MAX_ENTRY_BYTES} bytes`
            : `invalid xlsx: ${name}: ${/** @type {Error} */ (e).message}`,
          { cause: e },
        );
      }
    }
    // Lowercase keys: part names are case-insensitive in OPC packages.
    entries.set(name.toLowerCase(), inflated);
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
  /** @type {Map<string, { target: string, type: string }>} */
  const out = new Map();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs = parseAttributes(match[0]);
    if (!attrs["Id"] || !attrs["Target"]) continue;
    const target = attrs["Target"].replace(/^\/+/, "");
    out.set(attrs["Id"], {
      target: normalizePath(target.startsWith("xl/") ? target : `xl/${target}`),
      type: attrs["Type"] ?? "",
    });
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
 * `cellXfs` number-format ids by style index, plus custom `<numFmt>` codes.
 * @param {string} xml
 */
function parseStyles(xml) {
  /** @type {Map<number, string>} */
  const customNumFmts = new Map();
  const numFmts = /<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/.exec(xml)?.[1] ?? "";
  for (const m of numFmts.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const attrs = parseAttributes(m[0]);
    const id = Number(attrs["numFmtId"]);
    if (Number.isInteger(id) && attrs["formatCode"] !== undefined) {
      customNumFmts.set(id, attrs["formatCode"]);
    }
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const xfNumFmtIds = [...cellXfs.matchAll(/<xf\b[^>]*\/?>/g)].map((m) => {
    const id = Number(parseAttributes(m[0])["numFmtId"] ?? "0");
    return Number.isInteger(id) ? id : 0;
  });
  return { xfNumFmtIds, customNumFmts };
}

/**
 * @param {string} name
 * @param {string} xml
 * @param {string[]} sharedStrings
 * @param {{ xfNumFmtIds: number[], customNumFmts: Map<number, string> }} styles
 */
function parseSheet(name, xml, sharedStrings, styles) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {Map<string, string>} */
  const cells = new Map();
  /** Style index of every cell that names one (empty styled cells too). */
  /** @type {Map<string, number>} */
  const cellStyles = new Map();
  /** Row default styles (`<row s customFormat="1">`): 1-based row → style. */
  /** @type {Map<number, number>} */
  const rowStyles = new Map();
  let width = 0;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>/g)) {
    const attrs = parseAttributes(rowMatch[0]);
    const r = Number(attrs["r"]);
    const s = Number(attrs["s"]);
    const custom = attrs["customFormat"];
    if (
      Number.isInteger(r) &&
      attrs["s"] !== undefined &&
      Number.isInteger(s) &&
      (custom === "1" || custom === "true")
    ) {
      rowStyles.set(r, s);
    }
  }
  // Self-closing (empty, styled) cells must not swallow the next cell's body.
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = parseAttributes(`<c ${match[1]}>`);
    const ref = attrs["r"];
    if (!ref) continue;
    const pos = parseRef(ref);
    if (!pos) continue;
    const upper = ref.toUpperCase();
    const style = Number(attrs["s"]);
    if (attrs["s"] !== undefined && Number.isInteger(style)) {
      cellStyles.set(upper, style);
    }
    const body = match[2];
    if (body === undefined) continue;
    const value = cellValue(body, attrs["t"], sharedStrings);
    if (value === "") continue;
    cells.set(upper, value);
    const row = (rows[pos.row] ??= []);
    row[pos.column] = value;
    width = Math.max(width, pos.column + 1);
  }
  if (rows.length * Math.max(width, 1) > MAX_GRID_CELLS) {
    throw new Error(
      `xlsx: sheet ${JSON.stringify(name)} spans ${rows.length} rows × ${width} columns (more than ${MAX_GRID_CELLS} cells); the workbook is too sparse or too large to read`,
    );
  }
  for (let r = 0; r < rows.length; r++) {
    const row = (rows[r] ??= []);
    for (let c = 0; c < width; c++) row[c] ??= "";
  }
  /** Column default styles (`<col min max style>`), 1-based ranges. */
  const columnStyles = [...xml.matchAll(/<col\b[^>]*\/?>/g)]
    .map((m) => parseAttributes(m[0]))
    .map((attrs) => ({
      min: Number(attrs["min"]),
      max: Number(attrs["max"]),
      style: Number(attrs["style"]),
    }))
    .filter(
      (col) =>
        Number.isInteger(col.min) &&
        Number.isInteger(col.max) &&
        Number.isInteger(col.style),
    );

  /**
   * The number format Excel applies to `ref`: the cell's own style, else its
   * row's (`customFormat`), else its column's, else General.
   * @param {string} ref
   */
  const numFmt = (ref) => {
    const upper = String(ref).replaceAll("$", "").toUpperCase();
    const pos = parseRef(upper);
    let style = cellStyles.get(upper);
    if (style === undefined && pos) {
      style =
        rowStyles.get(pos.row + 1) ??
        columnStyles.find(
          (col) => pos.column + 1 >= col.min && pos.column + 1 <= col.max,
        )?.style;
    }
    const id = style === undefined ? 0 : (styles.xfNumFmtIds[style] ?? 0);
    const code = styles.customNumFmts.get(id) ?? BUILTIN_NUM_FMTS[id];
    return code === undefined ? { id } : { id, code };
  };
  return { name, rows, cells, validations: parseDataValidations(xml), numFmt };
}

/**
 * `<dataValidation>` entries (with formula1/formula2) plus the Excel 2010
 * extension form (`<x14:dataValidation>` with `<xm:f>` / `<xm:sqref>`), which
 * list validations that reference another sheet use.
 * @param {string} xml
 */
function parseDataValidations(xml) {
  const out = [];
  for (const m of xml.matchAll(
    /<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g,
  )) {
    const attrs = parseAttributes(`<v ${m[1]}>`);
    if (!attrs["sqref"]) continue;
    const body = m[2] ?? "";
    out.push(
      validationEntry(attrs, attrs["sqref"], {
        formula1: /<formula1\b[^>]*>([\s\S]*?)<\/formula1>/.exec(body)?.[1],
        formula2: /<formula2\b[^>]*>([\s\S]*?)<\/formula2>/.exec(body)?.[1],
      }),
    );
  }
  for (const m of xml.matchAll(
    /<(\w+):dataValidation\b([^>]*)>([\s\S]*?)<\/\1:dataValidation>/g,
  )) {
    const attrs = parseAttributes(`<v ${m[2]}>`);
    const body = m[3] ?? "";
    const sqref = /<(?:\w+:)?sqref>([\s\S]*?)<\/(?:\w+:)?sqref>/.exec(
      body,
    )?.[1];
    if (!sqref) continue;
    out.push(
      validationEntry(attrs, decodeXml(sqref.trim()), {
        formula1: extensionFormula(body, "formula1"),
        formula2: extensionFormula(body, "formula2"),
      }),
    );
  }
  return out;
}

/** @param {string} body @param {string} name */
function extensionFormula(body, name) {
  const inner = new RegExp(
    `<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`,
  ).exec(body)?.[1];
  if (inner === undefined) return undefined;
  return /<(?:\w+:)?f>([\s\S]*?)<\/(?:\w+:)?f>/.exec(inner)?.[1] ?? inner;
}

/**
 * @param {Record<string, string>} attrs
 * @param {string} sqref
 * @param {{ formula1?: string, formula2?: string }} formulas
 */
function validationEntry(attrs, sqref, formulas) {
  return {
    ...(attrs["type"] ? { type: attrs["type"] } : {}),
    sqref,
    ...(attrs["operator"] ? { operator: attrs["operator"] } : {}),
    ...(formulas.formula1 !== undefined
      ? { formula1: decodeXml(formulas.formula1.trim()) }
      : {}),
    ...(formulas.formula2 !== undefined
      ? { formula2: decodeXml(formulas.formula2.trim()) }
      : {}),
  };
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
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  if (!m) return undefined;
  return { row: Number(m[2]) - 1, column: columnIndex(m[1]) };
}

/** `A` → 0, `AA` → 26 (0-based). @param {string} letters */
export function columnIndex(letters) {
  let column = 0;
  for (const ch of letters.toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 64);
  }
  return column - 1;
}

/** 0 → `A`, 26 → `AA`. @param {number} index */
export function columnLetter(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * The header columns of a sheet: one entry per column whose label (the
 * `labelRow` cell) or key (the `keyRow` cell, when given) is not blank.
 * Rows are 1-based like Excel's; labels and keys are trimmed.
 * @param {string[][]} rows
 * @param {{ labelRow?: number, keyRow?: number }} [options]
 */
export function headerColumns(rows, options = {}) {
  const labelRow = options.labelRow ?? 1;
  const labels = rows[labelRow - 1] ?? [];
  const keys =
    options.keyRow !== undefined ? (rows[options.keyRow - 1] ?? []) : [];
  const width = Math.max(labels.length, keys.length);
  const out = [];
  for (let index = 0; index < width; index++) {
    const label = String(labels[index] ?? "").trim();
    const key = String(keys[index] ?? "").trim();
    if (label === "" && key === "") continue;
    out.push({
      index,
      letter: columnLetter(index),
      label,
      ...(options.keyRow !== undefined ? { key } : {}),
    });
  }
  return out;
}

/**
 * Whether a validation's `sqref` (space-separated ranges such as
 * `B3:B1048576 D3`) covers the 0-based `column`.
 * @param {string} sqref
 * @param {number} column
 */
export function sqrefCoversColumn(sqref, column) {
  for (const range of String(sqref).split(/\s+/).filter(Boolean)) {
    const [start = "", end = start] = range.replaceAll("$", "").split(":");
    const from = /^([A-Z]+)/i.exec(start)?.[1];
    const to = /^([A-Z]+)/i.exec(end)?.[1] ?? from;
    if (!from || !to) continue;
    const a = columnIndex(from);
    const b = columnIndex(to);
    if (column >= Math.min(a, b) && column <= Math.max(a, b)) return true;
  }
  return false;
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
