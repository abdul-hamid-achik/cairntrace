/**
 * Artifact-root watcher: find runs started outside the app.
 *
 * `cairn run` creates its run directory at the start and writes `run.json`
 * last, so a directory without `run.json` is a run still executing (or one a
 * signal killed). The watcher polls the artifact root for such directories,
 * tails each one's `events.ndjson` from a per-run offset, and reports three
 * things to its callbacks:
 *
 *   - `onEvents(runId, events)`  — newly appended events, per run
 *   - `onFinished(runId, info)`  — `run.json` appeared; final drain included
 *   - `onSnapshot(runs)`         — the full detected list, every tick
 *
 * Like `lib/live.js`, this is pure Node fs polling — no fs.watch, no fsevents
 * — so it behaves identically on local and network volumes and stays
 * unit-testable against temp fixtures.
 */
const fs = require("node:fs");
const path = require("node:path");
const { listDetectedRuns, readEventsFrom, readJsonFile } = require("./runs");

/**
 * @param {string} runDir
 * @returns {{ status: string | null, summary: string | null }}
 */
function readFinishInfo(runDir) {
  const run = readJsonFile(path.join(runDir, "run.json"));
  return {
    status: typeof run?.status === "string" ? run.status : null,
    summary: typeof run?.summary === "string" ? run.summary : null,
  };
}

/**
 * Start polling. `stop()` is idempotent; callbacks fire on the timer tick.
 *
 * @param {{
 *   runsRoot: string | (() => string | null),
 *   pollMs?: number,
 *   staleMs?: number,
 *   limit?: number,
 *   excludes?: () => Iterable<string>,
 *   onSnapshot?: (runs: Array<Record<string, any>>) => void,
 *   onEvents?: (runId: string, events: Array<Record<string, any>>) => void,
 *   onFinished?: (runId: string, info: { runDir: string, status: string | null, summary: string | null }) => void,
 *   onDropped?: (runId: string) => void,
 * }} options
 * @returns {{ start: () => void, stop: () => void, tick: () => void, runsRoot: () => string | null }}
 */
function createRunWatcher(options) {
  const pollMs = Math.max(100, options.pollMs ?? 2000);
  /** @type {Map<string, number>} run id → read offset into events.ndjson */
  const offsets = new Map();
  /** @type {Set<string>} */
  const tracked = new Set();
  let stopped = true;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {string | null} */
  let currentRoot = null;

  const resolveRoot = () =>
    typeof options.runsRoot === "function"
      ? options.runsRoot()
      : options.runsRoot;

  /**
   * One poll: refresh the detected list, tail new events, settle runs whose
   * `run.json` landed, and drop tracking for directories that vanished.
   */
  function tick() {
    const runsRoot = resolveRoot();
    if (!runsRoot) return;
    if (runsRoot !== currentRoot) {
      // The artifact root moved (project or settings change): start fresh.
      currentRoot = runsRoot;
      offsets.clear();
      tracked.clear();
    }

    const excluded = new Set(options.excludes?.() ?? []);
    const detected = listDetectedRuns(runsRoot, {
      staleMs: options.staleMs,
      limit: options.limit,
    }).filter((run) => !excluded.has(run.runId));

    for (const run of detected) {
      const result = readEventsFrom(run.runDir, offsets.get(run.runId) ?? 0);
      offsets.set(run.runId, result.offset);
      if (result.events.length) options.onEvents?.(run.runId, result.events);
      tracked.add(run.runId);
    }

    // A tracked id absent from the detected list either finished (run.json
    // landed), moved under an app-owned tail (excluded), or disappeared
    // (deleted / quiet past the stale window). Deleting the current entry
    // during Set iteration is safe.
    for (const runId of tracked) {
      if (detected.some((run) => run.runId === runId)) continue;
      if (excluded.has(runId)) continue;
      const runDir = path.join(runsRoot, runId);
      if (fs.existsSync(path.join(runDir, "run.json"))) {
        const info = readFinishInfo(runDir);
        // A torn (partially visible) run.json parses to null — settle it on a
        // later tick instead of reporting status "unknown".
        if (!info.status) continue;
        tracked.delete(runId);
        const drained = readEventsFrom(runDir, offsets.get(runId) ?? 0);
        if (drained.events.length) options.onEvents?.(runId, drained.events);
        offsets.delete(runId);
        options.onFinished?.(runId, { runDir, ...info });
      } else {
        // Dropped, not finished: the directory may come back (quiet run that
        // appends again, or a re-entering capped list), so keep the read
        // offset — only the tracking entry is released, or a vanished dir
        // would re-report onDropped every tick.
        tracked.delete(runId);
        options.onDropped?.(runId);
      }
    }

    options.onSnapshot?.(detected);
  }

  function loop() {
    if (stopped) return;
    try {
      tick();
    } catch {
      // a transient fs error must not kill the poll loop
    }
    timer = setTimeout(loop, pollMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      loop();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick,
    runsRoot: () => currentRoot,
  };
}

module.exports = { createRunWatcher };
