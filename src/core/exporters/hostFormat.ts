/**
 * E8: format generated files with the HOST's prettier. Only a local binary
 * (`node_modules/.bin/prettier`, found by the host profile) is ever run, and
 * only when the host has a prettier config: cairn never installs a formatter
 * and never picks a style the host did not choose. Each file goes through
 * `prettier --stdin-filepath <the file's final path>` from the export root, so
 * the host's config, overrides and `.prettierignore` apply exactly as they do
 * to its own files.
 *
 * The output is deterministic for a given prettier + config, so the export
 * manifest hashes (and `--check` / `--verify` freshness) cover the FORMATTED
 * text; a host that upgrades prettier sees its generated files go stale, not
 * silently different.
 */
import { extname, join } from "node:path";
import { targetChildEnv } from "../processEnv";
import { runBoundedCommand } from "../runner/boundedCommand";

const FORMATTABLE = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);
const PRETTIER_TIMEOUT_MS = 60_000;
/** Prettier is not always idempotent (member chains); formatted output is fed back until stable. */
const MAX_PASSES = 4;

export interface HostFormatFile {
  relPath: string;
  source: string;
}

export interface HostFormatResult {
  files: HostFormatFile[];
  /** Files prettier rewrote. */
  formatted: number;
  /** Files left as generated, with why (an ignored or unparseable file is not an error). */
  skipped: Array<{ relPath: string; reason: string }>;
}

/**
 * Format `files` (paths relative to `outDir`) with the host's prettier. A file
 * prettier cannot format is kept as generated and reported in `skipped`.
 */
export async function formatWithHostPrettier(
  files: readonly HostFormatFile[],
  prettier: { bin: string },
  /** Where the files will live (their final paths decide the config that applies). */
  outDir: string,
  /** An existing directory to run prettier from (`outDir` may not exist yet). */
  cwd: string = outDir,
): Promise<HostFormatResult> {
  const out: HostFormatFile[] = [];
  const skipped: HostFormatResult["skipped"] = [];
  let formatted = 0;
  for (const file of files) {
    if (!FORMATTABLE.has(extname(file.relPath))) {
      out.push(file);
      continue;
    }
    let text = file.source;
    let failure: string | undefined;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const result = await runBoundedCommand(
        prettier.bin,
        ["--stdin-filepath", join(outDir, file.relPath)],
        {
          cwd,
          env: targetChildEnv(),
          timeoutMs: PRETTIER_TIMEOUT_MS,
          ownProcessGroup: true,
          killLeftovers: true,
          input: text,
        },
      );
      if (
        result.spawnError ||
        result.timedOut ||
        result.cancelled ||
        result.exitCode !== 0
      ) {
        failure =
          (result.stderr.trim().split("\n")[0] ?? "").slice(0, 160) ||
          result.spawnError ||
          (result.timedOut ? "prettier timed out" : "prettier failed");
        break;
      }
      // The bounded runner strips one final newline; prettier always ends a file with one.
      const next = result.stdout === "" ? "" : `${result.stdout}\n`;
      if (next === text) break;
      text = next;
    }
    if (failure !== undefined) {
      skipped.push({ relPath: file.relPath, reason: failure });
      out.push(file);
      continue;
    }
    if (text !== file.source) formatted += 1;
    out.push({ relPath: file.relPath, source: text });
  }
  return { files: out, formatted, skipped };
}
