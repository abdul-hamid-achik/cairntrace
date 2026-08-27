/**
 * Minimal OOXML workbook writer (no dependencies): the zip/crc plumbing plus
 * a tiny sheet builder used by /template.xlsx and /export/products.xlsx.
 */
import { deflateRawSync } from "node:zlib";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries: Record<string, Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of Object.entries(entries)) {
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localData.length, 16);

  return Buffer.concat([localData, centralDirectory, eocd]);
}

function xml(input: string): Buffer {
  return Buffer.from(input.replaceAll(/^\s+/gm, "").trim(), "utf8");
}

export type WorkbookSheet = {
  name: string;
  /** Rows of cell values. Strings become shared strings; numbers stay numeric. */
  rows: Array<Array<string | number>>;
  /** Column-letter → dataValidation type, e.g. { A: "textLength" }. */
  validations?: Record<string, string>;
};

export function makeWorkbook(sheets: WorkbookSheet[]): Buffer {
  const strings: string[] = [];
  const indexOf = (value: string) => {
    const found = strings.indexOf(value);
    if (found >= 0) {
      return found;
    }
    strings.push(value);
    return strings.length - 1;
  };

  const sheetXml = (sheet: WorkbookSheet): Buffer => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, colIndex) => {
            const ref = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`;
            if (typeof value === "number") {
              return `<c r="${ref}"><v>${value}</v></c>`;
            }
            return `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join("");
    const validations = sheet.validations
      ? `<dataValidations count="${Object.keys(sheet.validations).length}">${Object.entries(
          sheet.validations,
        )
          .map(([column, type]) => `<dataValidation type="${type}" sqref="${column}2:${column}1048576"/>`)
          .join("")}</dataValidations>`
      : "";
    return xml(`<worksheet><sheetData>${rows}</sheetData>${validations}</worksheet>`);
  };

  const sheetEntries = sheets.map((sheet) => sheetXml(sheet));

  const entries: Record<string, Buffer> = {
    "[Content_Types].xml": xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
    ),
    "xl/workbook.xml": xml(`
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          ${sheets
            .map(
              (sheet, i) =>
                `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
            )
            .join("")}
        </sheets>
      </workbook>
    `),
    "xl/_rels/workbook.xml.rels": xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("")}
      </Relationships>
    `),
    // Built AFTER the sheet XMLs above so the shared-string table is complete.
    "xl/sharedStrings.xml": xml(`
      <sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>
    `),
  };
  sheetEntries.forEach((sheetXmlBuffer, i) => {
    entries[`xl/worksheets/sheet${i + 1}.xml`] = sheetXmlBuffer;
  });

  return makeZip(entries);
}
