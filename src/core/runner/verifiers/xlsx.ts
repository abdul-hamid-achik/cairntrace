import { readFile } from "node:fs/promises";
import { posix as pathPosix } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { XlsxVerifier } from "../../schema/verifier.v1";
import { resolveRuntimeFilePath } from "../runtimePlaceholders";
import type { VerifierContext, VerifierEvaluation } from "./types";

interface WorkbookData {
  sheets: Map<string, SheetData>;
}

interface SheetData {
  name: string;
  values: string[];
  headers: Map<string, number>;
  validations: DataValidation[];
}

interface DataValidation {
  type?: string;
  sqref: string;
}

interface ZipEntry {
  method: number;
  compressed: Buffer;
}

export async function evaluateXlsx(
  verifier: XlsxVerifier,
  ctx: VerifierContext,
): Promise<VerifierEvaluation> {
  const workbookPath = resolveRuntimeFilePath(verifier.xlsx.path, {
    artifacts: ctx.artifacts,
    runDir: ctx.runDir,
    specDir: ctx.specDir,
  });

  let workbook: WorkbookData;
  try {
    workbook = parseWorkbook(await readFile(workbookPath));
  } catch (e) {
    return {
      passed: false,
      expected: `read xlsx workbook at ${workbookPath}`,
      actual: `failed to read workbook: ${(e as Error).message}`,
      raw: { path: workbookPath, error: (e as Error).stack ?? String(e) },
    };
  }

  const failures: string[] = [];
  const checks: Record<string, unknown>[] = [];

  for (const sheetCheck of verifier.xlsx.sheets ?? []) {
    const sheet = workbook.sheets.get(sheetCheck.name);
    if (!sheet) {
      failures.push(`missing sheet ${sheetCheck.name}`);
      checks.push({ sheet: sheetCheck.name, found: false });
      continue;
    }
    const allText = sheet.values.join("\n");
    const missingText = (sheetCheck.contains ?? []).filter(
      (needle) => !allText.includes(needle),
    );
    if (missingText.length > 0) {
      failures.push(
        `${sheetCheck.name} missing text: ${missingText.join(", ")}`,
      );
    }
    checks.push({
      sheet: sheetCheck.name,
      found: true,
      contains: sheetCheck.contains ?? [],
      missingText,
    });
  }

  for (const validationCheck of verifier.xlsx.validations ?? []) {
    const sheet = workbook.sheets.get(validationCheck.sheet);
    if (!sheet) {
      failures.push(`missing sheet ${validationCheck.sheet}`);
      checks.push({ validation: validationCheck, found: false });
      continue;
    }
    const columnIndex = sheet.headers.get(
      normalizeHeader(validationCheck.column),
    );
    if (columnIndex === undefined) {
      failures.push(
        `${validationCheck.sheet} missing column ${validationCheck.column}`,
      );
      checks.push({ validation: validationCheck, found: false });
      continue;
    }
    const matching = sheet.validations.filter(
      (validation) =>
        validationCoversColumn(validation, columnIndex) &&
        (!validationCheck.type || validation.type === validationCheck.type),
    );
    if (matching.length === 0) {
      failures.push(
        `${validationCheck.sheet}.${validationCheck.column} missing ${validationCheck.type ?? "data"} validation`,
      );
    }
    checks.push({
      validation: validationCheck,
      columnIndex,
      found: matching.length > 0,
      matching,
    });
  }

  return {
    passed: failures.length === 0,
    expected: `xlsx checks pass for ${workbookPath}`,
    actual:
      failures.length === 0
        ? "all xlsx checks passed"
        : failures.map((failure) => `- ${failure}`).join("\n"),
    raw: {
      path: workbookPath,
      sheets: [...workbook.sheets.keys()],
      checks,
    },
  };
}

function parseWorkbook(buffer: Buffer): WorkbookData {
  const entries = readZipEntries(buffer);
  const workbookXml = readZipText(entries, "xl/workbook.xml");
  const relsXml = readZipText(entries, "xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(
    entries.has("xl/sharedStrings.xml")
      ? readZipText(entries, "xl/sharedStrings.xml")
      : "",
  );
  const relTargets = parseWorkbookRelationships(relsXml);
  const sheets = new Map<string, SheetData>();

  for (const sheetRef of parseWorkbookSheets(workbookXml)) {
    const target = relTargets.get(sheetRef.relId);
    if (!target) continue;
    const sheetXml = readZipText(entries, target);
    const sheet = parseSheet(sheetRef.name, sheetXml, sharedStrings);
    sheets.set(sheet.name, sheet);
  }

  return { sheets };
}

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocd = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("invalid zip central directory");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = normalizeZipPath(
      buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8"),
    );
    const entry = readLocalEntry(buffer, localOffset, method, compressedSize);
    entries.set(name, decompress(entry));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readLocalEntry(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
): ZipEntry {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error("invalid zip local header");
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + nameLength + extraLength;
  return {
    method,
    compressed: buffer.slice(dataOffset, dataOffset + compressedSize),
  };
}

function decompress(entry: ZipEntry): Buffer {
  if (entry.method === 0) return entry.compressed;
  if (entry.method === 8) return inflateRawSync(entry.compressed);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("invalid zip: missing end of central directory");
}

function readZipText(entries: Map<string, Buffer>, path: string): string {
  const entry = entries.get(normalizeZipPath(path));
  if (!entry) throw new Error(`missing ${path} in workbook`);
  return entry.toString("utf8");
}

function parseWorkbookSheets(xml: string): { name: string; relId: string }[] {
  return [...xml.matchAll(/<sheet\b[^>]*\/?>/g)]
    .map((match) => parseAttributes(match[0]))
    .map((attrs) => ({
      name: attrs["name"] ?? "",
      relId: attrs["r:id"] ?? attrs["id"] ?? "",
    }))
    .filter((sheet) => sheet.name && sheet.relId);
}

function parseWorkbookRelationships(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs = parseAttributes(match[0]);
    const id = attrs["Id"];
    const target = attrs["Target"];
    if (!id || !target) continue;
    rels.set(id, normalizeWorkbookTarget(target));
  }
  return rels;
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) =>
    extractTextNodes(match[0]),
  );
}

function parseSheet(
  name: string,
  xml: string,
  sharedStrings: string[],
): SheetData {
  const values: string[] = [];
  const headers = new Map<string, number>();

  for (const match of xml.matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/g)) {
    const cellXml = match[0];
    const attrs = parseAttributes(cellXml);
    const ref = attrs["r"];
    if (!ref) continue;
    const value = cellValue(cellXml, attrs["t"], sharedStrings);
    if (value === "") continue;
    values.push(value);
    const cell = parseCellRef(ref);
    if (cell && cell.row <= 20) {
      const normalized = normalizeHeader(value);
      if (normalized && !headers.has(normalized)) {
        headers.set(normalized, cell.column);
      }
    }
  }

  const validations = [
    ...xml.matchAll(
      /<dataValidation\b[^>]*(?:\/>|>[\s\S]*?<\/dataValidation>)/g,
    ),
  ]
    .map((match) => parseAttributes(match[0]))
    .filter((attrs) => attrs["sqref"])
    .map((attrs) => ({
      ...(attrs["type"] ? { type: attrs["type"] } : {}),
      sqref: attrs["sqref"]!,
    }));

  return { name, values, headers, validations };
}

function cellValue(
  cellXml: string,
  type: string | undefined,
  sharedStrings: string[],
): string {
  if (type === "s") {
    const index = Number(firstMatch(cellXml, /<v>([\s\S]*?)<\/v>/));
    return Number.isInteger(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (type === "inlineStr") return extractTextNodes(cellXml);
  return decodeXml(firstMatch(cellXml, /<v>([\s\S]*?)<\/v>/) ?? "");
}

function validationCoversColumn(
  validation: DataValidation,
  columnIndex: number,
): boolean {
  for (const range of validation.sqref.split(/\s+/).filter(Boolean)) {
    const [start, end = start] = range.replaceAll("$", "").split(":");
    const startColumn = columnIndexFromRef(start ?? "");
    const endColumn = columnIndexFromRef(end ?? start ?? "");
    if (
      startColumn !== undefined &&
      endColumn !== undefined &&
      columnIndex >= Math.min(startColumn, endColumn) &&
      columnIndex <= Math.max(startColumn, endColumn)
    ) {
      return true;
    }
  }
  return false;
}

function parseCellRef(
  ref: string,
): { column: number; row: number } | undefined {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref);
  if (!match) return undefined;
  const column = columnIndexFromRef(match[1]!);
  if (column === undefined) return undefined;
  return { column, row: Number(match[2]) };
}

function columnIndexFromRef(ref: string): number | undefined {
  const match = /^([A-Z]+)/i.exec(ref);
  if (!match) return undefined;
  let column = 0;
  for (const ch of match[1]!.toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 64);
  }
  return column;
}

function extractTextNodes(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attrs[match[1]!] = decodeXml(match[2] ?? "");
  }
  return attrs;
}

function firstMatch(input: string, regex: RegExp): string | undefined {
  return regex.exec(input)?.[1];
}

function normalizeZipPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

function normalizeWorkbookTarget(target: string): string {
  const normalized = normalizeZipPath(target);
  if (normalized.startsWith("xl/")) return pathPosix.normalize(normalized);
  return pathPosix.normalize(`xl/${normalized}`);
}

function normalizeHeader(header: string): string {
  return header.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function decodeXml(input: string): string {
  return input
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
