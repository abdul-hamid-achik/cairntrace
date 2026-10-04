import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  XlsxVerifierSchema,
  type XlsxVerifier,
} from "../../schema/verifier.v1";
import {
  buildXlsxFixture,
  type FixtureSheet,
} from "../../../testing/xlsxFixture";
import { headerColumns, readWorkbook } from "../../../sdk/workbook.js";
import { evaluateOutcomes } from "../OutcomeEvaluator";
import { MockBrowserBackend } from "../../../adapters/mock/MockBrowserBackend";
import type { VerifierContext } from "./types";
import { evaluateXlsx } from "./xlsx";

/**
 * F17 xlsx v2 against workbooks written by the test-only fixture writer:
 * an import template (label row + key row, styled data cells, column
 * styles, classic + x14 validations) and a guide sheet.
 */

const TEXT = 1; // style index → numFmt 49 "@"
const DATE = 2; // style index → custom 164 "yyyy-mm-dd"

const TEMPLATE: FixtureSheet = {
  name: "Import Template",
  rows: [
    ["Name *", "Country", "Email", "Start Date", "Extra Column"],
    [
      "Staff_Name",
      "Staff_Country",
      "Staff_Email",
      "Staff_Start",
      "Staff_Extra",
    ],
    ["", "", { s: TEXT }, { s: DATE }, ""],
  ],
  cols: [{ min: 4, max: 4, style: DATE }],
  validations: [
    {
      type: "custom",
      sqref: "C3:C1048576",
      formula1:
        'AND(ISNUMBER(SEARCH("@",C3)),ISNUMBER(SEARCH(".",C3)),COUNTIF($C$3:$C$1048576,C3)=1)',
    },
    { type: "date", sqref: "D3:D1048576", formula1: "1", formula2: "73051" },
  ],
  x14Validations: [
    { type: "list", sqref: "B3:B1048576", formula1: "Lists!$A$1:$A$3" },
  ],
};

const GUIDE: FixtureSheet = {
  name: "Template Guide",
  rows: [
    ["Field", "Required", "Guidance"],
    ["Name *", "Yes", "Full name"],
    ["Start Date", "No", "Use a date value in YYYY-MM-DD format"],
  ],
};

const LISTS: FixtureSheet = {
  name: "Lists",
  rows: [["CH"], ["DE"], ["MX"]],
};

const STYLES = {
  numFmts: [{ id: 164, code: "yyyy-mm-dd" }],
  xfs: [0, 49, 164],
};

let dir: string;
let templatePath: string;
let filledPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-xlsx-v2-"));
  templatePath = join(dir, "template.xlsx");
  filledPath = join(dir, "filled.xlsx");
  await writeFile(
    templatePath,
    buildXlsxFixture([TEMPLATE, GUIDE, LISTS], STYLES),
  );
  await writeFile(
    filledPath,
    buildXlsxFixture(
      [
        {
          ...TEMPLATE,
          rows: [
            TEMPLATE.rows[0]!,
            TEMPLATE.rows[1]!,
            [
              "Ada",
              "CH",
              { v: "ada@example.test", s: TEXT },
              { v: 45658, s: DATE },
              "TOKEN-COND-1",
            ],
            [
              "Lin",
              "DE",
              { v: "lin@example.test", s: TEXT },
              { v: 45659, s: DATE },
              "",
            ],
          ],
        },
        GUIDE,
      ],
      STYLES,
    ),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (extra: Partial<VerifierContext> = {}): VerifierContext => ({
  runDir: dir,
  specDir: dir,
  ...extra,
});

function verifier(
  xlsx: Omit<XlsxVerifier["xlsx"], "path">,
  path = "template.xlsx",
): XlsxVerifier {
  return XlsxVerifierSchema.parse({ xlsx: { path, ...xlsx } });
}

describe("xlsx v2 headers", () => {
  it("checks present / absent / labels on a label row + key row", async () => {
    const r = await evaluateXlsx(
      verifier({
        sheet: "Import Template",
        headers: {
          labelRow: 1,
          keyRow: 2,
          strip: "\\s*\\*$",
          present: ["Staff_Email", "name", { matches: "^start" }],
          absent: ["Address", { matches: "aggregate" }],
          labels: { Staff_Name: "Name", Staff_Country: "Country" },
        },
      }),
      ctx(),
    );
    expect(r.actual).toBe("all xlsx checks passed");
    expect(r.passed).toBe(true);
  });

  it("lists every header problem", async () => {
    const r = await evaluateXlsx(
      verifier({
        headers: {
          keyRow: 2,
          present: ["Staff_Missing"],
          absent: [{ matches: "^Extra" }],
          labels: { Staff_Country: "Country of residence", Staff_Gone: "X" },
        },
      }),
      ctx(),
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain('missing column(s) "Staff_Missing"');
    expect(r.actual).toContain(
      'unexpected column(s) /^Extra/ at E "Extra Column / Staff_Extra"',
    );
    expect(r.actual).toContain(
      'B key "Staff_Country" labelled "Country", expected "Country of residence"',
    );
    expect(r.actual).toContain('key "Staff_Gone" not found');
  });

  it("includesInOrder takes a captured list and tolerates extra workbook columns", async () => {
    const captures = {
      screen: { headers: ["Name", "Country", "", "Start Date"] },
    };
    const pass = await evaluateXlsx(
      verifier({
        headers: {
          strip: "\\s*\\*$",
          includesInOrder: "${captures.screen.headers}",
        },
      }),
      ctx({ captures }),
    );
    expect(pass.actual).toBe("all xlsx checks passed");

    const reordered = await evaluateXlsx(
      verifier({
        headers: {
          strip: "\\s*\\*$",
          includesInOrder: ["Country", "Name", "Unknown"],
        },
      }),
      ctx(),
    );
    expect(reordered.passed).toBe(false);
    expect(reordered.actual).toContain('missing "Unknown"');
    expect(reordered.actual).toContain('out of order "Name" (at A');
  });

  it("withinListInOrder fails on a workbook column the list lacks", async () => {
    const extra = await evaluateXlsx(
      verifier({
        headers: {
          strip: "\\s*\\*$",
          withinListInOrder: ["Name", "Country", "Email", "Start Date"],
        },
      }),
      ctx(),
    );
    expect(extra.passed).toBe(false);
    expect(extra.actual).toContain('not in the list E "Extra Column"');

    const superset = await evaluateXlsx(
      verifier({
        headers: {
          strip: "\\s*\\*$",
          withinListInOrder: [
            "Name",
            "Nickname",
            "Country",
            "Email",
            "Start Date",
            "Extra Column",
          ],
        },
      }),
      ctx(),
    );
    expect(superset.actual).toBe("all xlsx checks passed");

    const swapped = await evaluateXlsx(
      verifier({
        headers: {
          strip: "\\s*\\*$",
          withinListInOrder: [
            "Country",
            "Name",
            "Email",
            "Start Date",
            "Extra Column",
          ],
        },
      }),
      ctx(),
    );
    expect(swapped.actual).toContain("out of order");
  });

  it("fails clearly when a reference does not resolve to a list", async () => {
    const r = await evaluateXlsx(
      verifier({ headers: { includesInOrder: "${captures.screen}" } }),
      ctx({ captures: { screen: "Name" } }),
    );
    expect(r.passed).toBe(false);
    expect(r.actual).toContain(
      "headers.includesInOrder must resolve to a list",
    );

    const missing = await evaluateXlsx(
      verifier({ headers: { includesInOrder: "${captures.nope}" } }),
      ctx(),
    );
    expect(missing.passed).toBe(false);
    expect(missing.actual).toBe("unresolved ${captures.nope}");
  });
});

describe("xlsx v2 rows", () => {
  it("counts data rows after the key row", async () => {
    const empty = await evaluateXlsx(
      verifier({ headers: { keyRow: 2 }, rows: { afterKeyRow: { count: 0 } } }),
      ctx(),
    );
    expect(empty.actual).toBe("all xlsx checks passed");

    const filled = await evaluateXlsx(
      verifier(
        { headers: { keyRow: 2 }, rows: { afterKeyRow: { count: 0 } } },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(filled.passed).toBe(false);
    expect(filled.actual).toContain(
      "Import Template: 2 data row(s) after row 2, expected exactly 0",
    );

    const bounded = await evaluateXlsx(
      verifier(
        {
          headers: { keyRow: 2 },
          rows: { afterKeyRow: { atLeast: 1, atMost: 2 } },
        },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(bounded.passed).toBe(true);
  });

  it("needs one row where every column matcher holds", async () => {
    const hit = await evaluateXlsx(
      verifier(
        {
          headers: { keyRow: 2 },
          rows: {
            match: [
              { column: "Staff_Name", matcher: "Ada" },
              { column: "Email", matcher: { matches: "@example\\.test$" } },
              { column: "Start Date", matcher: 45658 },
            ],
          },
        },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(hit.actual).toBe("all xlsx checks passed");
    expect(
      (hit.raw as { checks: Array<{ rows?: { match?: { row: number } } }> })
        .checks[0]!.rows!.match!.row,
    ).toBe(3);

    const miss = await evaluateXlsx(
      verifier(
        {
          headers: { keyRow: 2 },
          rows: {
            match: [
              { column: "Staff_Name", matcher: "Ada" },
              { column: "Staff_Country", matcher: "DE" },
            ],
          },
        },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(miss.passed).toBe(false);
    expect(miss.actual).toContain(
      'no data row where Staff_Name equals "Ada" and Staff_Country equals "DE" (2 row(s) checked)',
    );

    const unknown = await evaluateXlsx(
      verifier(
        { rows: { match: [{ column: "Nope", matcher: { exists: true } }] } },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(unknown.actual).toContain('rows.match: missing column(s) "Nope"');
  });
});

describe("xlsx v2 cells", () => {
  it("checks values and number formats from cell, column and custom styles", async () => {
    const r = await evaluateXlsx(
      verifier(
        {
          cells: [
            { ref: "A3", equals: "Ada" },
            { ref: "c3", matches: "^ada@" },
            { ref: "C3", numFmt: "@" },
            { ref: "C4", numFmt: 49 },
            { ref: "D9", numFmt: "YYYY-MM-DD" },
            { ref: "A1", numFmt: "General" },
            { ref: "C1", sheet: { match: "^Template" }, equals: "Guidance" },
          ],
        },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(r.actual).toBe("all xlsx checks passed");

    const wrong = await evaluateXlsx(
      verifier({ cells: [{ ref: "A2", equals: "Other", numFmt: "@" }] }),
      ctx(),
    );
    expect(wrong.passed).toBe(false);
    expect(wrong.actual).toContain(
      'Import Template!A2 expected equals "Other" and numFmt "@", got "Staff_Name" (numFmt 0 "General")',
    );
  });
});

describe("xlsx v2 validations", () => {
  it("matches custom formulas and x14 list validations by key column", async () => {
    const r = await evaluateXlsx(
      verifier({
        headers: { keyRow: 2 },
        validations: [
          {
            column: "Staff_Email",
            type: "custom",
            formulaMatches: ['SEARCH\\("@"', 'SEARCH\\("\\."', "COUNTIF"],
          },
          { column: "Country", type: "list", formulaMatches: "^Lists!" },
          { column: "Start Date", type: "date", formulaMatches: "^73051$" },
          { sheet: "Import Template", column: "Email" },
        ],
      }),
      ctx(),
    );
    expect(r.actual).toBe("all xlsx checks passed");

    const missing = await evaluateXlsx(
      verifier({
        headers: { keyRow: 2 },
        validations: [
          { column: "Staff_Email", type: "custom", formulaMatches: "ISEMAIL" },
          { column: "Staff_Name", type: "list" },
        ],
      }),
      ctx(),
    );
    expect(missing.passed).toBe(false);
    expect(missing.actual).toContain(
      "Import Template.Staff_Email missing custom validation with a formula matching /ISEMAIL/ (covering: custom",
    );
    expect(missing.actual).toContain(
      "Import Template.Staff_Name missing list validation (none covers the column)",
    );
  });
});

describe("xlsx v2 sheets and contains", () => {
  it("searches every sheet without a sheet, only the selected one with it", async () => {
    const anywhere = await evaluateXlsx(
      verifier({ contains: ["TOKEN-COND-1", "YYYY-MM-DD"] }, "filled.xlsx"),
      ctx(),
    );
    expect(anywhere.actual).toBe("all xlsx checks passed");

    const scoped = await evaluateXlsx(
      verifier(
        { sheet: { match: "Guide$" }, contains: ["TOKEN-COND-1"] },
        "filled.xlsx",
      ),
      ctx(),
    );
    expect(scoped.passed).toBe(false);
    expect(scoped.actual).toContain(
      "Template Guide missing text: TOKEN-COND-1",
    );

    const byIndex = await evaluateXlsx(
      verifier({ sheet: 1, cells: [{ ref: "A1", equals: "Field" }] }),
      ctx(),
    );
    expect(byIndex.passed).toBe(true);

    const absent = await evaluateXlsx(
      verifier({ sheet: "Nope", headers: { present: ["Name"] } }),
      ctx(),
    );
    expect(absent.actual).toContain(
      'no sheet "Nope" (sheets: Import Template, Template Guide, Lists)',
    );
  });

  it("does not poll an outcome whose operand reference is missing", async () => {
    const [evaluated] = await evaluateOutcomes(
      [
        {
          id: "cols",
          description: "template columns follow the screen",
          verify: {
            ...verifier({
              headers: { includesInOrder: "${captures.screen.headers}" },
            }),
            poll: { timeoutMs: 60_000, everyMs: 1000 },
          },
        },
      ],
      new MockBrowserBackend(),
      ctx(),
    );
    expect(evaluated!.evaluation.passed).toBe(false);
    expect(evaluated!.evaluation.actual).toBe(
      "unresolved ${captures.screen.headers}",
    );
    expect(evaluated!.evaluation.attempts).toBeUndefined();
  });
});

describe("xlsx v2 schema", () => {
  it("keeps the v1 shapes and rejects incomplete v2 ones", () => {
    expect(
      XlsxVerifierSchema.safeParse({
        xlsx: {
          path: "t.xlsx",
          validations: [{ sheet: "S", column: "Email", type: "textLength" }],
        },
      }).success,
    ).toBe(true);
    const noAssertion = XlsxVerifierSchema.safeParse({
      xlsx: { path: "t.xlsx", headers: { labelRow: 1 } },
    });
    expect(noAssertion.success).toBe(false);
    expect(JSON.stringify(noAssertion.error?.issues)).toContain(
      "xlsx verifier requires at least one of",
    );
    const labelsWithoutKeys = XlsxVerifierSchema.safeParse({
      xlsx: { path: "t.xlsx", headers: { labels: { a: "A" } } },
    });
    expect(JSON.stringify(labelsWithoutKeys.error?.issues)).toContain(
      "set headers.keyRow",
    );
    expect(
      XlsxVerifierSchema.safeParse({
        xlsx: { path: "t.xlsx", cells: [{ ref: "A1" }] },
      }).success,
    ).toBe(false);
    expect(
      XlsxVerifierSchema.safeParse({
        xlsx: { path: "t.xlsx", headers: { present: ["a"], strip: "(" } },
      }).success,
    ).toBe(false);
    expect(
      XlsxVerifierSchema.safeParse({
        xlsx: { path: "t.xlsx", headers: { includesInOrder: "not a ref" } },
      }).success,
    ).toBe(false);
    expect(
      XlsxVerifierSchema.safeParse({
        xlsx: {
          path: "t.xlsx",
          rows: { afterKeyRow: { count: 0, atMost: 1 } },
        },
      }).success,
    ).toBe(false);
  });
});

describe("workbook model (shared with ctx.xlsx)", () => {
  it("exposes formulas, number formats and header columns", async () => {
    const { readFile } = await import("node:fs/promises");
    const book = readWorkbook(await readFile(templatePath));
    const sheet = book.sheets[0]!;
    expect(sheet.validations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "date",
          formula1: "1",
          formula2: "73051",
        }),
        expect.objectContaining({
          type: "list",
          sqref: "B3:B1048576",
          formula1: "Lists!$A$1:$A$3",
        }),
      ]),
    );
    expect(sheet.numFmt("C3")).toEqual({ id: 49, code: "@" });
    expect(sheet.numFmt("D500")).toEqual({ id: 164, code: "yyyy-mm-dd" });
    expect(sheet.numFmt("$E$3")).toEqual({ id: 0, code: "General" });
    expect(headerColumns(sheet.rows, { keyRow: 2 }).slice(0, 2)).toEqual([
      { index: 0, letter: "A", label: "Name *", key: "Staff_Name" },
      { index: 1, letter: "B", label: "Country", key: "Staff_Country" },
    ]);
  });
});
