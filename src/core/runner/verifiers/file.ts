import { isAbsolute, resolve } from "node:path";
import type { FileVerifier } from "../../schema/verifier.v1";
import { resolveRuntimeFilePath } from "../runtimePlaceholders";
import { FILE_DEFAULT_TIMEOUT_MS, waitForFile } from "./fileWait";
import type { VerifierContext, VerifierEvaluation } from "./types";

/**
 * Poll a glob until a matching file exists and (optionally) its text contains
 * the needle. Built for file-based test doubles — e.g. a local email driver
 * writing `<ts>-welcome-<recipient>.json` captures the spec needs to await.
 *
 * Glob semantics are deliberately small: the directory part is literal, and
 * `*` / `?` wildcards apply to the filename only. Relative globs resolve
 * against the spec's directory; `${artifacts.<name>.path}` placeholders
 * resolve like the xlsx verifier's path (run-artifact downloads included).
 * The wait itself lives in ./fileWait (shared with the Playwright export).
 */
export async function evaluateFile(
  verifier: FileVerifier,
  ctx: VerifierContext = {},
): Promise<VerifierEvaluation> {
  const { glob, contains } = verifier.file;
  const timeoutMs = verifier.file.timeoutMs ?? FILE_DEFAULT_TIMEOUT_MS;
  const resolvedGlob = resolveRuntimeFilePath(glob, {
    artifacts: ctx.artifacts,
    runDir: ctx.runDir,
    specDir: ctx.specDir,
  });
  const absGlob = isAbsolute(resolvedGlob)
    ? resolvedGlob
    : resolve(ctx.specDir ?? process.cwd(), resolvedGlob);
  return waitForFile(glob, absGlob, contains, timeoutMs);
}
