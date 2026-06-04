import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Artifact-root retention. One evening of dogfood runs produced 12GB under
 * artifactRoot and a hard ENOSPC, so run dirs can now be pruned:
 *
 *   - automatically after each run when `retention.keepRuns` is set in
 *     cairntrace.config.yml (newest N runs kept PER SPEC), and
 *   - manually via `cairn clean`.
 *
 * Run dirs are identified by the `<iso>_<spec_name>_<6hex>` id shape; the ISO
 * prefix makes lexicographic order chronological.
 */

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T[\dT-]+Z?_(.+)_[0-9a-f]{6}$/;

export interface PruneOptions {
  /** Keep the newest N runs per spec. 0 removes everything. */
  keepRuns: number;
}

export interface PruneResult {
  /** Run ids removed, oldest first. */
  removed: string[];
  /** Total bytes reclaimed (best-effort walk before deletion). */
  freedBytes: number;
  /** Run dirs remaining after the prune. */
  kept: number;
}

/** The spec-name segment of a run id, or undefined for non-run entries. */
export function specNameOfRunId(runId: string): string | undefined {
  const m = RUN_DIR_PATTERN.exec(runId);
  return m?.[1];
}

export async function pruneRuns(
  artifactRoot: string,
  opts: PruneOptions,
): Promise<PruneResult> {
  const entries = await readdir(artifactRoot).catch(() => [] as string[]);
  const bySpec = new Map<string, string[]>();
  for (const entry of entries) {
    const spec = specNameOfRunId(entry);
    if (!spec) continue; // not a run dir — never touch it
    const list = bySpec.get(spec) ?? [];
    list.push(entry);
    bySpec.set(spec, list);
  }

  const result: PruneResult = { removed: [], freedBytes: 0, kept: 0 };
  for (const runs of bySpec.values()) {
    runs.sort(); // ISO prefix → chronological
    const cutoff = Math.max(0, runs.length - Math.max(0, opts.keepRuns));
    for (let i = 0; i < runs.length; i++) {
      const runId = runs[i]!;
      if (i >= cutoff) {
        result.kept++;
        continue;
      }
      const dir = join(artifactRoot, runId);
      result.freedBytes += await dirSize(dir);
      await rm(dir, { recursive: true, force: true });
      result.removed.push(runId);
    }
  }
  result.removed.sort();
  return result;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    () => [] as never[],
  );
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(p);
    } else {
      total += (await stat(p).catch(() => undefined))?.size ?? 0;
    }
  }
  return total;
}

/**
 * Append an actionable hint when an error is really "the disk is full" —
 * the raw `step parse: ENOSPC: no space left on device, write` (exit 2) sent
 * the dogfood migration hunting a parser bug.
 */
export function addEnospcHint(message: string): string {
  if (!/ENOSPC/.test(message)) return message;
  return `${message} — the disk is full; run \`cairn clean\` or set retention.keepRuns in cairntrace.config.yml to reclaim artifact space`;
}
