import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/**
 * The polling half of the `file` verifier: wait for a file whose name matches
 * a glob (`*` / `?` in the filename only) and, optionally, whose text contains
 * a needle. Only node built-ins on purpose: the Playwright export embeds this
 * file's source (src/core/exporters/runtimeSources.ts), so the exported test
 * waits and judges exactly like `cairn run` does.
 */

export const FILE_DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

export interface FileWaitResult {
  passed: boolean;
  expected: string;
  actual: string;
}

/**
 * `absGlob` is the absolute glob; `glob` is the authored text (shown in
 * `expected`).
 */
export async function waitForFile(
  glob: string,
  absGlob: string,
  contains: string | undefined,
  timeoutMs: number,
): Promise<FileWaitResult> {
  const dir = dirname(absGlob);
  const namePattern = globToRegExp(basename(absGlob));

  const expected = contains
    ? `a file matching ${glob} containing ${JSON.stringify(contains)} within ${timeoutMs}ms`
    : `a file matching ${glob} within ${timeoutMs}ms`;

  const deadline = Date.now() + timeoutMs;
  let lastMatches: string[] = [];
  while (true) {
    const entries = await readdir(dir).catch(() => [] as string[]);
    // filter() already copies; no toSorted (vendored into lib ES2022 hosts).
    lastMatches = entries.filter((f) => namePattern.test(f));
    lastMatches.sort();
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
