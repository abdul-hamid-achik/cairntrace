/**
 * Tiny static + JSON server for the Cairntrace demo app.
 *
 * Run with:
 *   bun examples/demo-app/server.ts
 *
 * Listens on http://localhost:8787. Override the port with PORT=NNNN.
 *
 * Routes:
 *   /                  → index.html
 *   /dashboard.html    → static dashboard
 *   /api.html          → page that fetches /api/inventory
 *   /api-broken.html   → page that fetches /api/broken (returns 500)
 *   /import.html       → template download + upload demo
 *   /api/inventory     → 200 JSON with three items
 *   /api/broken        → 500 JSON error
 *   /template.xlsx     → generated workbook fixture
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8787);

const inventory = [
  { id: 1, name: "Apples", total: "$1.00" },
  { id: 2, name: "Bread", total: "$2.00" },
  { id: 3, name: "Cheese", total: "$5.00" },
];

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/inventory") {
      return Response.json({ items: inventory });
    }
    if (url.pathname === "/api/broken") {
      return Response.json(
        { error: "intentional 500 for the demo" },
        { status: 500 },
      );
    }
    if (url.pathname === "/template.xlsx") {
      return new Response(makeTemplateWorkbook(), {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": 'attachment; filename="template.xlsx"',
        },
      });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(here, path));
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Cairntrace demo serving at http://localhost:${server.port}/`);
console.log(`  /                /api.html        /api-broken.html`);
console.log(`  /dashboard.html  /import.html     /template.xlsx`);
console.log(`  /api/inventory   /api/broken`);

function makeTemplateWorkbook(): Buffer {
  return makeZip({
    "[Content_Types].xml": xml(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
    ),
    "xl/workbook.xml": xml(`
      <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>
          <sheet name="Template Guide" sheetId="1" r:id="rId1"/>
          <sheet name="RBA Academy Training" sheetId="2" r:id="rId2"/>
          <sheet name="In Scope Workers" sheetId="3" r:id="rId3"/>
        </sheets>
      </workbook>
    `),
    "xl/_rels/workbook.xml.rels": xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
        <Relationship Id="rId3" Target="worksheets/sheet3.xml"/>
      </Relationships>
    `),
    "xl/sharedStrings.xml": xml(`
      <sst>
        <si><t>Help Text</t></si>
        <si><t>Allowed Values</t></si>
        <si><t>Examples</t></si>
        <si><t>Email</t></si>
        <si><t>FMW</t></si>
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
    "xl/worksheets/sheet3.xml": xml(`
      <worksheet>
        <sheetData>
          <row r="1"><c r="B1" t="s"><v>4</v></c></row>
        </sheetData>
        <dataValidations count="1">
          <dataValidation type="decimal" sqref="B2:B1048576"/>
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
