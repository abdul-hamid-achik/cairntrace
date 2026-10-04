import { deflateRawSync } from "node:zlib";

/**
 * Test-only .xlsx writer: just enough OOXML for the read-only parser
 * (src/sdk/workbook.js) — shared and inline strings, numbers, cell / row /
 * column styles with number formats, and data validations (classic and
 * the Excel 2010 `x14` extension). Not shipped (package.json excludes
 * src/testing).
 */

/** A cell: a string (shared string), or `{ v, s?, t? }`; "" is no cell. */
export type FixtureCell =
  | string
  | {
      /** Value; omitted = an empty cell that only carries a style. */
      v?: string | number;
      /** Style index into `styles.xfs`. */
      s?: number;
      /** `inlineStr` writes an inline string instead of a shared one. */
      t?: "inlineStr";
    };

export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
  /** `<col>` defaults: 1-based column ranges with a style index. */
  cols?: Array<{ min: number; max: number; style: number }>;
  /** Classic `<dataValidation>` entries. */
  validations?: Array<{
    type?: string;
    sqref: string;
    formula1?: string;
    formula2?: string;
  }>;
  /** Excel 2010 `<x14:dataValidation>` entries (in `<extLst>`). */
  x14Validations?: Array<{ type?: string; sqref: string; formula1: string }>;
}

export interface FixtureStyles {
  /** Custom number formats (ids ≥ 164). */
  numFmts?: Array<{ id: number; code: string }>;
  /** `cellXfs`: one numFmtId per style index (index 0 is the default). */
  xfs: number[];
}

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const letter = (index: number): string => {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

export function buildXlsxFixture(
  sheets: FixtureSheet[],
  styles?: FixtureStyles,
): Buffer {
  const shared: string[] = [];
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map(
        (sheet, i) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  };
  sheets.forEach((sheet, i) => {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        const ref = `${letter(c)}${r + 1}`;
        if (cell === "") return "";
        const spec = typeof cell === "string" ? { v: cell } : cell;
        const style = spec.s !== undefined ? ` s="${spec.s}"` : "";
        if (spec.v === undefined) return `<c r="${ref}"${style}/>`;
        if (typeof spec.v === "number") {
          return `<c r="${ref}"${style}><v>${spec.v}</v></c>`;
        }
        if (spec.t === "inlineStr") {
          return `<c r="${ref}"${style} t="inlineStr"><is><t>${escapeXml(spec.v)}</t></is></c>`;
        }
        shared.push(spec.v);
        return `<c r="${ref}"${style} t="s"><v>${shared.length - 1}</v></c>`;
      });
      return `<row r="${r + 1}">${cells.join("")}</row>`;
    });
    const cols = sheet.cols?.length
      ? `<cols>${sheet.cols
          .map(
            (col) =>
              `<col min="${col.min}" max="${col.max}" width="20" style="${col.style}" customWidth="1"/>`,
          )
          .join("")}</cols>`
      : "";
    const validations = sheet.validations?.length
      ? `<dataValidations count="${sheet.validations.length}">${sheet.validations
          .map(
            (v) =>
              `<dataValidation${
                v.type ? ` type="${v.type}"` : ""
              } allowBlank="1" sqref="${v.sqref}">${
                v.formula1 !== undefined
                  ? `<formula1>${escapeXml(v.formula1)}</formula1>`
                  : ""
              }${
                v.formula2 !== undefined
                  ? `<formula2>${escapeXml(v.formula2)}</formula2>`
                  : ""
              }</dataValidation>`,
          )
          .join("")}</dataValidations>`
      : "";
    const x14 = sheet.x14Validations?.length
      ? `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="${sheet.x14Validations.length}" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">${sheet.x14Validations
          .map(
            (v) =>
              `<x14:dataValidation${
                v.type ? ` type="${v.type}"` : ""
              } allowBlank="1"><x14:formula1><xm:f>${escapeXml(v.formula1)}</xm:f></x14:formula1><xm:sqref>${v.sqref}</xm:sqref></x14:dataValidation>`,
          )
          .join("")}</x14:dataValidations></ext></extLst>`
      : "";
    files[`xl/worksheets/sheet${i + 1}.xml`] =
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows.join("")}</sheetData>${validations}${x14}</worksheet>`;
  });
  files["xl/sharedStrings.xml"] =
    `<?xml version="1.0"?><sst count="${shared.length}">${shared
      .map(
        (value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`,
      )
      .join("")}</sst>`;
  const xfs = styles?.xfs ?? [0];
  const numFmts = styles?.numFmts ?? [];
  files["xl/styles.xml"] = `<?xml version="1.0"?><styleSheet>${
    numFmts.length
      ? `<numFmts count="${numFmts.length}">${numFmts
          .map(
            (f) =>
              `<numFmt numFmtId="${f.id}" formatCode="${escapeXml(f.code)}"/>`,
          )
          .join("")}</numFmts>`
      : ""
  }<cellXfs count="${xfs.length}">${xfs
    .map(
      (id) =>
        `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0"${
          id ? ' applyNumberFormat="1"' : ""
        }/>`,
    )
    .join("")}</cellXfs></styleSheet>`;
  return zip(files);
}

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
