/**
 * Artifact-root watcher: find runs started outside the app.
 *
 * `cairn run` creates its run directory at the start and writes `run.json`
 * last, so a directory without `run.json` is a run still executing (or one a
 * signal killed). The watcher polls the artifact root for such directories,
 * tails each one's `events.ndjson` from a per-run offset, and reports:
 *
 *   - `onEvents(runId, events)`  — newly appended events, per run
 *   - `onFinished(runId, info)`  — `run.json` appeared; final drain included
 *   - `onSnapshot(runs)`         — the full detected list (with liveness), every tick
 *   - `onInvocations(list)`      — invocation journals that are running or just ended
 *   - `onInvocationEvents(id, events)` — journal events (services, hooks, phase)
 *
 * A finished run keeps being tailed for `lingerMs` (default 10s) after its
 * `run.json` lands: auto-stash and retention append their events *after* the
 * run record, and a watcher that stopped at `run.json` would never show them.
 * An upload can outlast that window, so while the run's process (the pid from
 * its heartbeat or invocation journal) is still alive the tail keeps going,
 * up to `lingerCapMs` (default 10 min); once the process is gone, one final
 * drain picks up whatever it appended last.
 *
 * Like `lib/live.js`, this is pure Node fs polling — no fs.watch, no fsevents
 * — so it behaves identically on local and network volumes and stays
 * unit-testable against temp fixtures.
 */
const fs = require("node:fs");
const path = require("node:path");
const { normalizeRefusal } = require("./policy");
const {
  isPidAlive,
  listDetectedRuns,
  readEventsFrom,
  readJsonFile,
  runLiveness,
} = require("./runs");
const { listInvocations } = require("./invocations");

/** Keep tailing a run (or invocation) this long after it finished. */
const DEFAULT_LINGER_MS = 10_000;
/** …and up to this long while its process is still alive (slow auto-stash). */
const DEFAULT_LINGER_CAP_MS = 10 * 60_000;

/**
 * @param {string} runDir
 * @returns {{ status: string | null, summary: string | null, invocation: Record<string, any> | null, refusal: ReturnType<typeof normalizeRefusal> }}
 */
function readFinishInfo(runDir) {
  const run = readJsonFile(path.join(runDir, "run.json"));
  return {
    status: typeof run?.status === "string" ? run.status : null,
    summary: typeof run?.summary === "string" ? run.summary : null,
    invocation:
      run?.invocation && typeof run.invocation === "object"
        ? run.invocation
        : null,
    // status "refused": why the environment policy said no
    refusal: normalizeRefusal(run?.refusal),
  };
}

/**
 * Start polling. `stop()` is idempotent; callbacks fire on the timer tick.
 *
 * @param {{
 *   runsRoot: string | (() => string | null),
 *   pollMs?: number,
 *   staleMs?: number,
 *   lingerMs?: number,
 *   lingerCapMs?: number,
 *   limit?: number,
 *   now?: () => number,
 *   pidAlive?: (pid: number) => boolean | null,
 *   excludes?: () => Iterable<string>,
 *   onSnapshot?: (runs: Array<Record<string, any>>) => void,
 *   onEvents?: (runId: string, events: Array<Record<string, any>>) => void,
 *   onFinished?: (runId: string, info: { runDir: string, status: string | null, summary: string | null, invocation: Record<string, any> | null, refusal: Record<string, any> | null }) => void,
 *   onDropped?: (runId: string) => void,
 *   onInvocations?: (invocations: Array<Record<string, any>>) => void,
 *   onInvocationEvents?: (invocationId: string, events: Array<Record<string, any>>) => void,
 * }} options
 * @returns {{ start: () => void, stop: () => void, tick: () => void, runsRoot: () => string | null }}
 */
function createRunWatcher(options) {
  const pollMs = Math.max(100, options.pollMs ?? 2000);
  const lingerMs = Math.max(0, options.lingerMs ?? DEFAULT_LINGER_MS);
  const lingerCapMs = Math.max(
    lingerMs,
    options.lingerCapMs ?? DEFAULT_LINGER_CAP_MS,
  );
  const now = options.now ?? (() => Date.now());
  const pidAlive = options.pidAlive ?? isPidAlive;
  /** @type {Map<string, number>} run id → read offset into events.ndjson */
  const offsets = new Map();
  /** @type {Set<string>} */
  const tracked = new Set();
  /** @type {Map<string, { runDir: string, until: number, cap: number, pid: number | null }>} finished, still draining */
  const lingering = new Map();
  /** @type {Map<string, number>} run id → owning pid seen while it ran */
  const pids = new Map();
  /** @type {Map<string, number>} invocation id → read offset */
  const invocationOffsets = new Map();
  /** @type {Map<string, number>} invocation id → when it was first seen ended */
  const invocationEnded = new Map();
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
   * @param {string} runId
   * @param {string} runDir
   */
  function drain(runId, runDir) {
    const result = readEventsFrom(runDir, offsets.get(runId) ?? 0);
    offsets.set(runId, result.offset);
    if (result.events.length) options.onEvents?.(runId, result.events);
  }

  /** Tail invocation journals that are running or ended within the linger. */
  function tickInvocations(runsRoot) {
    if (!options.onInvocations && !options.onInvocationEvents) return;
    const at = now();
    const journals = listInvocations(runsRoot, {
      limit: 12,
      pidAlive: options.pidAlive,
    });
    const visible = [];
    for (const journal of journals) {
      let endedMs = null;
      if (journal.alive) invocationEnded.delete(journal.invocationId);
      else {
        // When it ended: the journal's own endedAt, else its last write (an
        // aborted process never stamps endedAt), else first sight.
        endedMs =
          Date.parse(journal.endedAt ?? "") ||
          journal.updatedAtMs ||
          invocationEnded.get(journal.invocationId) ||
          at;
        invocationEnded.set(journal.invocationId, endedMs);
      }
      const sinceEnd = endedMs === null ? 0 : Math.max(0, at - endedMs);
      // Ended journals stay listed for a while so their cards still group.
      if (journal.alive || sinceEnd <= Math.max(lingerMs, 10 * 60_000))
        visible.push(journal);
      if (!journal.alive && sinceEnd > lingerMs) {
        invocationOffsets.delete(journal.invocationId);
        continue;
      }
      const result = readEventsFrom(
        journal.dir,
        invocationOffsets.get(journal.invocationId) ?? 0,
      );
      invocationOffsets.set(journal.invocationId, result.offset);
      if (result.events.length)
        options.onInvocationEvents?.(journal.invocationId, result.events);
    }
    options.onInvocations?.(visible);
  }

  /**
   * One poll: refresh the detected list, tail new events, settle runs whose
   * `run.json` landed, keep draining finished runs for the linger window,
   * drop tracking for directories that vanished, and tail invocations.
   */
  function tick() {
    const runsRoot = resolveRoot();
    if (!runsRoot) return;
    if (runsRoot !== currentRoot) {
      // The artifact root moved (project or settings change): start fresh.
      currentRoot = runsRoot;
      offsets.clear();
      tracked.clear();
      lingering.clear();
      pids.clear();
      invocationOffsets.clear();
      invocationEnded.clear();
    }
    const at = now();

    const excluded = new Set(options.excludes?.() ?? []);
    const detected = listDetectedRuns(runsRoot, {
      staleMs: options.staleMs,
      limit: options.limit,
      now: at,
      pidAlive: options.pidAlive,
    }).filter((run) => !excluded.has(run.runId));
    const detectedIds = new Set(detected.map((run) => run.runId));

    for (const run of detected) {
      drain(run.runId, run.runDir);
      tracked.add(run.runId);
      const pid = run.liveness?.pid;
      if (Number.isInteger(pid) && pid > 0) pids.set(run.runId, pid);
    }

    // A tracked id absent from the detected list either finished (run.json
    // landed), moved under an app-owned tail (excluded), or disappeared
    // (deleted / quiet past the stale window). Deleting the current entry
    // during Set iteration is safe.
    for (const runId of tracked) {
      if (detectedIds.has(runId)) continue;
      if (excluded.has(runId)) continue;
      const runDir = path.join(runsRoot, runId);
      if (fs.existsSync(path.join(runDir, "run.json"))) {
        const info = readFinishInfo(runDir);
        // A torn (partially visible) run.json parses to null — settle it on a
        // later tick instead of reporting status "unknown".
        if (!info.status) continue;
        tracked.delete(runId);
        drain(runId, runDir);
        options.onFinished?.(runId, { runDir, ...info });
        const pid = pids.get(runId) ?? ownerPid(runsRoot, runDir);
        pids.delete(runId);
        if (lingerMs > 0)
          lingering.set(runId, {
            runDir,
            until: at + lingerMs,
            cap: at + lingerCapMs,
            pid,
          });
        else offsets.delete(runId);
      } else {
        // Dropped, not finished: the directory may come back (quiet run that
        // appends again, or a re-entering capped list), so keep the read
        // offset — only the tracking entry is released, or a vanished dir
        // would re-report onDropped every tick.
        tracked.delete(runId);
        pids.delete(runId);
        options.onDropped?.(runId);
      }
    }

    // Finished runs keep streaming late events (stash, retention): for the
    // linger window, and beyond it while their process is still alive.
    for (const [runId, entry] of lingering) {
      if (excluded.has(runId)) continue;
      drain(runId, entry.runDir);
      if (at < entry.until) continue;
      const stillWriting =
        entry.pid !== null && at < entry.cap && pidAlive(entry.pid) === true;
      if (stillWriting) continue;
      lingering.delete(runId);
      offsets.delete(runId);
    }

    options.onSnapshot?.(detected);
    tickInvocations(runsRoot);
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

/**
 * The pid that owns a run directory (heartbeat, else invocation journal).
 * @param {string} runsRoot
 * @param {string} runDir
 * @returns {number | null}
 */
function ownerPid(runsRoot, runDir) {
  try {
    const pid = runLiveness(runsRoot, runDir, { pidAlive: () => null }).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

module.exports = {
  createRunWatcher,
  DEFAULT_LINGER_MS,
  DEFAULT_LINGER_CAP_MS,
};
