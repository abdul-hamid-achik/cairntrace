import { readFile } from "node:fs/promises";
import type { XlsxVerifier } from "../../schema/verifier.v1";
import { readWorkbook, type ParsedWorkbook } from "../../../sdk/workbook.js";
import { resolveRuntimeFilePath } from "../runtimePlaceholders";
import { boundValue } from "./evidence";
import { resolveRefsDeep } from "./refs";
import { judgeXlsx, RAW_LIST_CAP } from "./xlsxJudge";
import type { VerifierContext, VerifierEvaluation } from "./types";

/**
 * `xlsx` verifier: read-only checks on a downloaded workbook through the
 * same parser as the SDK's `ctx.xlsx(path)` (src/sdk/workbook.js).
 *
 *   - `contains`: text anywhere in `sheet`, or in any sheet without one;
 *   - `sheets[]`: per-sheet `contains` (by name);
 *   - `headers`: label/key rows — present, absent, labels, withinListInOrder,
 *     includesInOrder;
 *   - `rows`: data rows after the key row — count bounds and a row match;
 *   - `cells`: one A1 cell — equals, matches, numFmt;
 *   - `validations`: a data validation covering a column, by type and
 *     formula.
 *
 * Every failure is listed; the raw sidecar records the resolved sheet, the
 * header columns and each check.
 */

export async function evaluateXlsx(
  verifier: XlsxVerifier,
  ctx: VerifierContext,
): Promise<VerifierEvaluation> {
  const workbookPath = resolveRuntimeFilePath(verifier.xlsx.path, {
    artifacts: ctx.artifacts,
    runDir: ctx.runDir,
    specDir: ctx.specDir,
  });

  // Operands may hold runtime references (`${captures.screen.headers}`);
  // a whole reference keeps its type.
  const { path: _path, ...checks } = verifier.xlsx;
  const resolved = resolveRefsDeep(checks, ctx);
  if (resolved.missing.length > 0) {
    return {
      passed: false,
      expected: `xlsx checks for ${workbookPath} with resolved references`,
      actual: `unresolved ${resolved.missing.join(", ")}`,
      raw: { path: workbookPath, missing: resolved.missing },
    };
  }
  const spec = resolved.value;

  let workbook: ParsedWorkbook;
  try {
    workbook = readWorkbook(await readFile(workbookPath));
  } catch (e) {
    return {
      passed: false,
      expected: `read xlsx workbook at ${workbookPath}`,
      actual: `failed to read workbook: ${(e as Error).message}`,
      raw: { path: workbookPath, error: (e as Error).stack ?? String(e) },
    };
  }

  const { failures, checksRaw, sheetNames, mainSheet, mainColumns } = judgeXlsx(
    workbook,
    spec,
  );

  return {
    passed: failures.length === 0,
    expected: `xlsx checks pass for ${workbookPath}`,
    actual:
      failures.length === 0
        ? "all xlsx checks passed"
        : failures.map((failure) => `- ${failure}`).join("\n"),
    raw: {
      path: workbookPath,
      sheets: sheetNames,
      ...(mainSheet
        ? { sheet: mainSheet.name, columns: mainColumns.slice(0, RAW_LIST_CAP) }
        : {}),
      checks: boundValue(checksRaw, 64 * 1024).value,
    },
  };
}
