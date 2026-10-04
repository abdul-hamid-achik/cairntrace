/** A `<dataValidation>` (or Excel 2010 `x14:dataValidation`) entry. */
export interface ParsedValidation {
  /** list, whole, decimal, date, time, textLength, custom (absent = any). */
  type?: string;
  /** Target ranges, space-separated (`B3:B1048576 D3`). */
  sqref: string;
  operator?: string;
  /** First formula (a list source, a bound, or a custom rule). */
  formula1?: string;
  formula2?: string;
}

/** The number format Excel applies to a cell: built-in id and format code. */
export interface ParsedNumFmt {
  id: number;
  /** `@` (text), `yyyy-mm-dd`, `General`, … (absent for an unknown id). */
  code?: string;
}

/** One worksheet: a dense grid of the strings Excel stores. */
export interface ParsedSheet {
  name: string;
  /** rows[r][c], 0-based; empty cells are "". Rows are padded to the widest row. */
  rows: string[][];
  /** Non-empty cells by uppercase A1 reference. */
  cells: Map<string, string>;
  /** Data validations with their target ranges and formulas. */
  validations: ParsedValidation[];
  /**
   * Number format of an A1 reference: the cell's own style, else its row's,
   * else its column's, else General (id 0). Works for empty cells.
   */
  numFmt(ref: string): ParsedNumFmt;
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
}

/** Parse .xlsx bytes. Throws on a file that is not a readable workbook. */
export function readWorkbook(bytes: Uint8Array): ParsedWorkbook;

/** `A` → 0, `AA` → 26 (0-based column index). */
export function columnIndex(letters: string): number;

/** 0 → `A`, 26 → `AA`. */
export function columnLetter(index: number): string;

/** One header column: 0-based index, letter, label and (with a key row) key. */
export interface HeaderColumn {
  index: number;
  letter: string;
  label: string;
  key?: string;
}

/**
 * Columns whose label (`labelRow`, default 1) or key (`keyRow`) cell is not
 * blank. Rows are 1-based like Excel's.
 */
export function headerColumns(
  rows: string[][],
  options?: { labelRow?: number; keyRow?: number },
): HeaderColumn[];

/** Whether a validation `sqref` covers the 0-based column. */
export function sqrefCoversColumn(sqref: string, column: number): boolean;
