import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { evaluateXlsx } from "./xlsx";

describe("xlsx", () => {
  it("checks sheet text and data validations in a downloaded workbook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-xlsx-"));
    const workbookPath = join(dir, "template.xlsx");
    await writeFile(workbookPath, makeWorkbook());

    const r = await evaluateXlsx(
      {
        xlsx: {
          path: "${artifacts.template.path}",
          sheets: [
            {
              name: "Template Guide",
              contains: ["Help Text", "Allowed Values", "Examples"],
            },
          ],
          validations: [
            {
              sheet: "RBA Academy Training",
              column: "Email",
              type: "textLength",
            },
          ],
        },
      },
      {
        runDir: dir,
        specDir: dir,
        artifacts: {
          template: {
            kind: "download",
            path: workbookPath,
            relativePath: "downloads/template.xlsx",
          },
        },
      },
    );

    expect(r.passed).toBe(true);
    expect(r.actual).toContain("all xlsx checks passed");
  });

  it("fails when an expected validation is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-xlsx-missing-"));
    const workbookPath = join(dir, "template.xlsx");
    await writeFile(workbookPath, makeWorkbook());

    const r = await evaluateXlsx(
      {
        xlsx: {
          path: workbookPath,
          validations: [
            {
              sheet: "RBA Academy Training",
              column: "Email",
              type: "decimal",
            },
          ],
        },
      },
      { runDir: dir, specDir: dir },
    );

    expect(r.passed).toBe(false);
    expect(r.actual).toContain("missing decimal validation");
  });
});

function makeWorkbook(): Buffer {
  return makeZip({
    "[Content_Types].xml": xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
    ),
    "xl/workbook.xml": xml(`
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Template Guide" sheetId="1" r:id="rId1"/>
          <sheet name="RBA Academy Training" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>
    `),
    "xl/_rels/workbook.xml.rels": xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
      </Relationships>
    `),
    "xl/sharedStrings.xml": xml(`
      <sst>
        <si><t>Help Text</t></si>
        <si><t>Allowed Values</t></si>
        <si><t>Examples</t></si>
        <si><t>Email</t></si>
      </sst>
    `),
    "xl/worksheets/sheet1.xml": xml(`
      <worksheet>
        <sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c></row>
          <row r="3"><c r="A3" t="s"><v>2</v></c></row>
        </sheetData>
      </worksheet>
    `),
    "xl/worksheets/sheet2.xml": xml(`
      <worksheet>
        <sheetData>
          <row r="1"><c r="A1" t="s"><v>3</v></c></row>
        </sheetData>
        <dataValidations count="1">
          <dataValidation type="textLength" sqref="A2:A1048576"/>
        </dataValidations>
      </worksheet>
    `),
  });
}

function xml(input: string): Buffer {
  return Buffer.from(input.replaceAll(/^\s+/gm, "").trim(), "utf8");
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

  const centralDirectory = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localData.length, 16);

  return Buffer.concat([localData, centralDirectory, eocd]);
}

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
