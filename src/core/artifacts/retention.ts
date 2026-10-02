import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceCategory } from "../schema/config.v1";
import type { EvidenceFailureReason } from "../schema/events.v1";
import {
  DEFAULT_KEEP_INVOCATIONS,
  pruneInvocations,
} from "./invocationJournal";
import { pruneSessions } from "../discovery/sessionJournal";
import { DEFAULT_KEEP_SESSIONS } from "../schema/discovery.v1";

/**
 * Evidence gate handed to the retention archive/publish adapters: which
 * categories leave the machine (`stash.include` / `retention.publish.include`)
 * and the archive TTL.
 */
export interface RetentionEvidencePolicy {
  include?: readonly EvidenceCategory[];
  unsafeIncludeRawTraces?: boolean;
  ttl?: string;
}

/** What a successful retention archive (file.cheap save) produced. */
export interface RetentionArchiveOutcome {
  stashId?: string;
  status?: "saved" | "saved_with_failures";
  excluded?: string[];
  secretsFound?: number;
  ttl?: string;
  expiresAt?: string;
  tags?: string[];
}

/** What a successful retention publication produced. */
export interface RetentionPublishOutcome {
  artifactRef?: Record<string, unknown>;
  webUrl?: string;
  excluded?: string[];
}

/**
 * A stash/archive/publish failure with a short, path-free reason code
 * (`fcheap-missing`, `save-failed`, `auth`, `too-large`, `timeout`,
 * `secrets-blocked`, `unknown`). Adapters throw it so the retention pass can
 * record the reason in `artifact.*` events.
 */
export class EvidenceTransferError extends Error {
  override name = "EvidenceTransferError";
  constructor(
    message: string,
    readonly reason: EvidenceFailureReason,
  ) {
    super(message);
  }
}

/** The reason code of any thrown value (`unknown` when not classified). */
export function evidenceFailureReason(error: unknown): EvidenceFailureReason {
  return error instanceof EvidenceTransferError ? error.reason : "unknown";
}

/**
 * One line of an error message fit for events and terminal output: the
 * first line, absolute and home-relative paths replaced by `<path>` (a path
 * with spaces collapses to one `<path>`), at most 200 chars.
 */
export function pathFreeMessage(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let output = first
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`:,;()[\]{}]+){2,}/g, "<path>")
    .replace(/~\/[^\s'"`:,;]*/g, "<path>");
  // `/Users/Jane Doe/app/x` → `<path> Doe<path>`: the words between two
  // path pieces glued to the second one belong to the same path.
  let previous: string;
  do {
    previous = output;
    output = output.replace(/<path>(?: +[^\s<>'"`:,;]+)+<path>/g, "<path>");
  } while (output !== previous);
  return output.slice(0, 200);
}

/**
 * Artifact-root retention. One evening of dogfood runs produced 12GB under
 * artifactRoot and a hard ENOSPC, so run dirs can now be pruned:
 *
 *   - automatically after each run when `retention.keepRuns` is set in
 *     cairntrace.config.yml (newest N runs kept PER SPEC), and
 *   - manually via `cairn clean`.
 *
 * Run dirs are identified by the `<iso>_<spec_name>_<6hex>` id shape; the ISO
 * prefix makes lexicographic order chronological. Anything else under the
 * root is never treated as a run: in particular `_invocations/` (the
 * invocation journals) is pruned by its own rule, see `pruneInvocations`.
 */

/** Default keep-count when no `retention.keepRuns` is configured. */
export const DEFAULT_KEEP_RUNS = 3;

/**
 * Default keep-count for the failed-run carve-out when no
 * `retention.keepFailedRuns` is configured. See `PruneOptions.keepFailedRuns`.
 */
export const DEFAULT_KEEP_FAILED_RUNS = 10;

/**
 * Name of a run directory the runner creates: `<ISO timestamp>_<spec>_<hex6>`.
 * Anything else under the artifact root (`_invocations/`, aborted batch
 * summaries, a user's scratch folder) is not a run. Studio keeps a verbatim
 * copy in desktop/lib/runs.js.
 */
export const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T[\dT-]+Z?_(.+)_[0-9a-f]{6}$/;

/** True when `name` (a directory basename) is a run directory name. */
export function isRunDirName(name: string): boolean {
  return RUN_DIR_PATTERN.test(name);
}

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
   * corrupt, or statusless run.json (an aborted/in-flight run interrupted by
   * SIGINT/SIGTERM before ArtifactWriter finished) are NOT carve-out protected
   * and count toward the `keepRuns` window like an ordinary run — the newest
   * interrupted run is preserved up to the cap, but old ones are pruned so
   * they cannot accumulate unbounded.
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
  /**
   * Invocation journals (`_invocations/<id>`) always kept. Older journals
   * are removed once none of their runs exists any more (a journal whose
   * process is still running is never removed). Defaults to
   * DEFAULT_KEEP_INVOCATIONS (20), or 0 when `keepRuns` is 0.
   */
  keepInvocations?: number;
  /**
   * Discovery/accompany session journals (`_sessions/<id>`) always kept.
   * Older ones go unless still open (live process) or referenced by a draft
   * (an exported spec that still exists and names the session). Defaults to
   * DEFAULT_KEEP_SESSIONS (50), or 0 when `keepRuns` is 0.
   */
  keepSessions?: number;
  /**
   * Treat pinned runs (`cairn pin`, run.json `pinned`) like any other run.
   * Default false: a pinned run is never pruned and does not count toward
   * `keepRuns` or `keepFailedRuns` (`cairn clean --include-pinned`).
   */
  includePinned?: boolean;
}

/**
 * Whether a run dir's run.json reports a non-passed status ("failed" or
 * "errored"). A missing file, invalid JSON, or a run.json without a status
 * field all count as passed (prunable) — the carve-out only protects runs we
 * can positively confirm failed. An interrupted run left mid-flight by a
 * signal therefore counts toward the ordinary `keepRuns` window rather than
 * being preserved forever.
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

/** Whether run.json carries a `pinned` object (`cairn pin`). */
export async function isPinnedRun(dir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, "run.json"), "utf8");
    const pinned = (JSON.parse(raw) as { pinned?: unknown }).pinned;
    return pinned !== null && typeof pinned === "object";
  } catch {
    return false;
  }
}

/** Signal-time partial batch summaries written at the artifact root. */
const ABORTED_SUMMARY_PATTERN = /^aborted-.*\.json$/;

export interface PruneResult {
  /** Run ids (and swept aborted-batch summary filenames) removed, oldest first. */
  removed: string[];
  /** Total bytes reclaimed (best-effort walk before deletion). */
  freedBytes: number;
  /** Run dirs remaining after the prune. */
  kept: number;
  /** Runs retained because their archive step failed. */
  archiveFailures: Array<{
    runId: string;
    error: string;
    reason?: EvidenceFailureReason;
  }>;
  /** Pinned runs skipped by this pass (present only when some were). */
  pinned?: string[];
  /** Invocation journal ids removed (present only when some were). */
  removedInvocations?: string[];
  /** Session journal ids removed (present only when some were). */
  removedSessions?: string[];
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

  const keepCount = Math.max(0, opts.keepRuns);
  const result: PruneResult = {
    removed: [],
    freedBytes: 0,
    kept: 0,
    archiveFailures: [],
  };
  const pinned: string[] = [];
  for (const allRuns of bySpec.values()) {
    allRuns.sort(); // ISO prefix → chronological

    // Pinned runs are invisible to the windows below: never pruned, and they
    // take no keepRuns/keepFailedRuns slot from the runs around them.
    const runs: string[] = [];
    for (const runId of allRuns) {
      if (
        opts.includePinned !== true &&
        (await isPinnedRun(join(artifactRoot, runId)))
      ) {
        pinned.push(runId);
        result.kept++;
      } else {
        runs.push(runId);
      }
    }

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

    // Newest `keepRuns` runs of ANY status (passed, failed, or interrupted)
    // are kept; everything older is prunable unless the failed-run carve-out
    // protects it. An interrupted/aborted run therefore counts toward the cap
    // instead of being retained forever.
    const cutoff = Math.max(0, runs.length - keepCount);
    for (let i = 0; i < runs.length; i++) {
      const runId = runs[i]!;
      if (i >= cutoff || protectedFailed.has(runId)) {
        result.kept++;
        continue;
      }
      const dir = join(artifactRoot, runId);
      // `cairn pin` can land while an earlier run's archive (a multi-second
      // fcheap save) is in flight: check again right before acting on it.
      const pinnedMeanwhile = async (): Promise<boolean> => {
        if (opts.includePinned === true || !(await isPinnedRun(dir))) {
          return false;
        }
        pinned.push(runId);
        result.kept++;
        return true;
      };
      if (await pinnedMeanwhile()) continue;
      // Archive before deletion when configured. On archive failure, retain
      // the run on disk so no artifacts are lost (move, not copy-and-lose).
      if (opts.onArchive) {
        try {
          await opts.onArchive(dir, runId);
        } catch (error) {
          // Archive failed — keep the run, skip deletion.
          result.kept++;
          result.archiveFailures.push({
            runId,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof EvidenceTransferError
              ? { reason: error.reason }
              : {}),
          });
          continue;
        }
        if (await pinnedMeanwhile()) continue;
      }
      result.freedBytes += await dirSize(dir);
      await rm(dir, { recursive: true, force: true });
      result.removed.push(runId);
    }
  }

  // Sweep signal-time partial batch summaries (aborted-<ts>-<pid>.json at the
  // root) under the same `keepRuns` cap so they cannot accumulate unbounded.
  // These are small JSON files, not run dirs, so they are deleted directly
  // (never archived) — the completed run dirs they reference are archived on
  // their own schedule above.
  const abortedSummaries = entries
    .filter((entry) => ABORTED_SUMMARY_PATTERN.test(entry))
    .toSorted(); // ISO-ish timestamp prefix → chronological
  const abortedCutoff = Math.max(0, abortedSummaries.length - keepCount);
  for (let i = 0; i < abortedCutoff; i++) {
    const name = abortedSummaries[i]!;
    const path = join(artifactRoot, name);
    result.freedBytes += (await stat(path).catch(() => undefined))?.size ?? 0;
    await rm(path, { force: true });
    result.removed.push(name);
  }

  result.removed.sort();
  if (pinned.length > 0) result.pinned = pinned.toSorted();

  // Journals go after the runs they reference, so a journal whose last run
  // was pruned above is collectable in the same pass.
  const removedInvocations = await pruneInvocations(artifactRoot, {
    keep:
      opts.keepInvocations ?? (keepCount === 0 ? 0 : DEFAULT_KEEP_INVOCATIONS),
  }).catch(() => [] as string[]);
  if (removedInvocations.length > 0) {
    result.removedInvocations = removedInvocations;
  }
  const removedSessions = await pruneSessions(artifactRoot, {
    keep: opts.keepSessions ?? (keepCount === 0 ? 0 : DEFAULT_KEEP_SESSIONS),
  }).catch(() => [] as string[]);
  if (removedSessions.length > 0) result.removedSessions = removedSessions;
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
