/** One worksheet: a dense grid of the strings Excel stores. */
export interface ParsedSheet {
  name: string;
  /** rows[r][c], 0-based; empty cells are "". Rows are padded to the widest row. */
  rows: string[][];
  /** Non-empty cells by uppercase A1 reference. */
  cells: Map<string, string>;
  /** `<dataValidation>` entries: their type (list, whole, …) and target ranges. */
  validations: Array<{ type?: string; sqref: string }>;
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
}

/** Parse .xlsx bytes. Throws on a file that is not a readable workbook. */
export function readWorkbook(bytes: Uint8Array): ParsedWorkbook;
