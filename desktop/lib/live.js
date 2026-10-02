/**
 * Live run tracking.
 *
 * `cairn run` writes `events.ndjson` into the run directory as the run
 * progresses (append-only, one JSON object per event). The desktop app gets
 * step-level live progress by finding the run directory the child process
 * created and tailing that file — no extra CLI flags, no log scraping, and it
 * works identically for every backend.
 */
const fs = require("node:fs");
const path = require("node:path");
const { listRunIds, readEventsFrom } = require("./runs");
const { parseRunId, runIdTimestampMs } = require("./format");

/**
 * Pick the run directory a just-started run created.
 *
 * @param {string[]} runIds newest-first run ids currently in the artifact root
 * @param {{ specNames?: Iterable<string> | string | null, knownIds?: Set<string> | Iterable<string>, startedAtMs?: number, skewMs?: number, now?: () => Date }} [options]
 * @returns {string | null} the matching run id
 */
function pickNewRunId(runIds, options = {}) {
  const known = new Set(options.knownIds ?? []);
  const specNames =
    options.specNames === null || options.specNames === undefined
      ? null
      : new Set(
          typeof options.specNames === "string"
            ? [options.specNames]
            : options.specNames,
        );
  const skewMs = options.skewMs ?? 30_000;
  const earliest = (options.startedAtMs ?? Date.now()) - skewMs;
  const now = (options.now ?? (() => new Date()))();
  for (const runId of runIds) {
    if (known.has(runId)) continue;
    const parsed = parseRunId(runId);
    // Run ids embed the spec's `name:` field, which need not match the file
    // basename — accept any of the caller's candidate names.
    if (specNames && parsed.spec && !specNames.has(parsed.spec)) continue;
    const started = runIdTimestampMs(parsed.startedAt);
    // A pre-existing (or clock-skewed) directory is not ours.
    if (started !== null && started < earliest) continue;
    if (started !== null && started > now.getTime() + skewMs) continue;
    return runId;
  }
  return null;
}

/** Keep tailing this long after `run.json` lands (stash/retention events). */
const DEFAULT_LINGER_MS = 10_000;

/**
 * Start polling the artifact root for a new run directory, then tail its
 * events file. Calls back on the same thread; `stop()` is idempotent.
 *
 * `run.json` is written before auto-stash and retention append their events,
 * so the tail keeps draining for `lingerMs` after it appears and only then
 * calls `onEnd`.
 *
 * @param {{
 *   runsRoot: string,
 *   specNames?: Iterable<string> | string | null,
 *   knownIds?: Iterable<string>,
 *   pollMs?: number,
 *   lingerMs?: number,
 *   onRunDir?: (runDir: string, runId: string) => void,
 *   onEvents?: (events: Array<Record<string, any>>, runDir: string) => void,
 *   onEnd?: () => void,
 * }} options
 * @returns {{ stop: () => void, runDir: () => string | null, ended: () => boolean }}
 */
function createLiveTail(options) {
  const pollMs = Math.max(100, options.pollMs ?? 400);
  const lingerMs = Math.max(0, options.lingerMs ?? DEFAULT_LINGER_MS);
  const startedAtMs = Date.now();
  let stopped = false;
  let ended = false;
  /** @type {string | null} */
  let runId = null;
  /** @type {string | null} */
  let runDir = null;
  let offset = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {number | null} when run.json was first seen */
  let finishedAt = null;

  const drain = () => {
    if (!runDir) return;
    const result = readEventsFrom(runDir, offset);
    offset = result.offset;
    if (result.events.length) options.onEvents?.(result.events, runDir);
  };

  const poll = () => {
    if (stopped) return;
    if (!runDir) {
      const ids = listRunIds(options.runsRoot);
      const found = pickNewRunId(ids, {
        specNames: options.specNames,
        knownIds: options.knownIds,
        startedAtMs,
      });
      if (found) {
        runId = found;
        runDir = path.join(options.runsRoot, found);
        options.onRunDir?.(runDir, runId);
      }
    }
    if (runDir) {
      drain();
      if (finishedAt === null && fs.existsSync(path.join(runDir, "run.json")))
        finishedAt = Date.now();
      // At least one more poll after run.json drains trailing events; the
      // linger window catches the stash/retention events written later.
      if (
        finishedAt !== null &&
        Date.now() - finishedAt >= Math.max(pollMs, lingerMs)
      ) {
        drain();
        ended = true;
        options.onEnd?.();
        stop();
        return;
      }
    }
    if (!stopped) timer = setTimeout(poll, pollMs);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  timer = setTimeout(poll, 50);
  return { stop, runDir: () => runDir, ended: () => ended };
}

module.exports = {
  DEFAULT_LINGER_MS,
  runIdTimestampMs,
  pickNewRunId,
  createLiveTail,
};
