import { readdir, readFile, rm, stat } from "node:fs/promises";
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

/** Default keep-count when no `retention.keepRuns` is configured. */
export const DEFAULT_KEEP_RUNS = 3;

/**
 * Default keep-count for the failed-run carve-out when no
 * `retention.keepFailedRuns` is configured. See `PruneOptions.keepFailedRuns`.
 */
export const DEFAULT_KEEP_FAILED_RUNS = 10;

const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T[\dT-]+Z?_(.+)_[0-9a-f]{6}$/;

export interface PruneOptions {
  /** Keep the newest N runs per spec. 0 removes everything. */
  keepRuns: number;
  /**
   * Keep the newest N runs per spec whose run.json `status` is "failed" or
   * "errored", even past the `keepRuns` cutoff — losing the only evidence of
   * a genuine failure to routine pruning is worse than a few extra kept dirs
   * (2026-07-12: forensics for a real streamed-SSR /dashboard failure were
   * lost to a prune that ran before the run could be inspected). A failed
   * run that already sits inside the `keepRuns` window still counts against
   * this quota — it isn't protected AND kept for free. Runs with a missing,
   * corrupt, or statusless run.json are treated as passed (prunable).
   * Defaults to DEFAULT_KEEP_FAILED_RUNS (10) when unset; 0 disables the
   * carve-out entirely.
   */
  keepFailedRuns?: number;
  /**
   * Best-effort archive of a run dir before deletion (e.g. to fcheap). When
   * set, called once per pruned run; if it rejects, the run is RETAINED on
   * disk (not deleted) so no artifacts are lost — the caller should log the
   * failure. When unset, runs are deleted directly.
   */
  onArchive?: (runDir: string, runId: string) => Promise<void>;
}

/**
 * Whether a run dir's run.json reports a non-passed status ("failed" or
 * "errored"). A missing file, invalid JSON, or a run.json without a status
 * field all count as passed (prunable) — the carve-out only protects runs we
 * can positively confirm failed.
 */
async function isNonPassedRun(dir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, "run.json"), "utf8");
    const parsed = JSON.parse(raw) as { status?: unknown };
    return parsed.status === "failed" || parsed.status === "errored";
  } catch {
    return false;
  }
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

  const keepFailedRuns = Math.max(
    0,
    opts.keepFailedRuns ?? DEFAULT_KEEP_FAILED_RUNS,
  );

  const result: PruneResult = { removed: [], freedBytes: 0, kept: 0 };
  for (const runs of bySpec.values()) {
    runs.sort(); // ISO prefix → chronological

    // Carve-out: protect the newest `keepFailedRuns` failed/errored runs from
    // pruning even past the `keepRuns` cutoff. Scan newest-first so "newest
    // N" is honored, and so a failed run already inside the `keepRuns`
    // window still consumes one slot of the quota instead of being
    // protected for free.
    const protectedFailed = new Set<string>();
    if (keepFailedRuns > 0) {
      for (
        let i = runs.length - 1;
        i >= 0 && protectedFailed.size < keepFailedRuns;
        i--
      ) {
        const runId = runs[i]!;
        if (await isNonPassedRun(join(artifactRoot, runId))) {
          protectedFailed.add(runId);
        }
      }
    }

    const cutoff = Math.max(0, runs.length - Math.max(0, opts.keepRuns));
    for (let i = 0; i < runs.length; i++) {
      const runId = runs[i]!;
      if (i >= cutoff || protectedFailed.has(runId)) {
        result.kept++;
        continue;
      }
      const dir = join(artifactRoot, runId);
      // Archive before deletion when configured. On archive failure, retain
      // the run on disk so no artifacts are lost (move, not copy-and-lose).
      if (opts.onArchive) {
        try {
          await opts.onArchive(dir, runId);
        } catch {
          // Archive failed — keep the run, skip deletion.
          continue;
        }
      }
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
