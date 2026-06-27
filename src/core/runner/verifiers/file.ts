import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { FileVerifier } from "../../schema/verifier.v1";
import type { VerifierContext, VerifierEvaluation } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/**
 * Poll a glob until a matching file exists and (optionally) its text contains
 * the needle. Built for file-based test doubles — e.g. a local email driver
 * writing `<ts>-welcome-<recipient>.json` captures the spec needs to await.
 *
 * Glob semantics are deliberately small: the directory part is literal, and
 * `*` / `?` wildcards apply to the filename only. Relative globs resolve
 * against the spec's directory.
 */
export async function evaluateFile(
  verifier: FileVerifier,
  ctx: VerifierContext = {},
): Promise<VerifierEvaluation> {
  const { glob, contains } = verifier.file;
  const timeoutMs = verifier.file.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const absGlob = isAbsolute(glob)
    ? glob
    : resolve(ctx.specDir ?? process.cwd(), glob);
  const dir = dirname(absGlob);
  const namePattern = globToRegExp(basename(absGlob));

  const expected = contains
    ? `a file matching ${glob} containing ${JSON.stringify(contains)} within ${timeoutMs}ms`
    : `a file matching ${glob} within ${timeoutMs}ms`;

  const deadline = Date.now() + timeoutMs;
  let lastMatches: string[] = [];
  while (true) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    lastMatches = entries.filter((f) => namePattern.test(f)).toSorted();
    for (const name of lastMatches) {
      const path = resolve(dir, name);
      if (contains === undefined) {
        return {
          passed: true,
          expected,
          actual: `matched ${path}`,
        };
      }
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text !== undefined && text.includes(contains)) {
        return {
          passed: true,
          expected,
          actual: `matched ${path} containing ${JSON.stringify(contains)}`,
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(
      Math.min(POLL_INTERVAL_MS, Math.max(25, deadline - Date.now())),
    );
  }

  const detail =
    lastMatches.length === 0
      ? `no files matching ${basename(absGlob)} in ${dir}`
      : `${lastMatches.length} file(s) matched the glob but none contained ${JSON.stringify(contains)}: ${lastMatches.slice(0, 5).join(", ")}`;
  return {
    passed: false,
    expected,
    actual: `timed out after ${timeoutMs}ms — ${detail}`,
  };
}

/** Translate a filename glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
