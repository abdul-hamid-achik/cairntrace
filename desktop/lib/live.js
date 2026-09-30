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

/**
 * Summarize an events.ndjson entry for the timeline UI.
 * @param {Record<string, any>} event
 * @returns {{ ts: string | null, type: string, stepId: string | null, label: string, tone: "ok" | "bad" | "muted" | "info" }}
 */
function describeEvent(event) {
  const type = String(event?.type ?? "unknown");
  const ts = typeof event?.ts === "string" ? event.ts : null;
  const stepId = typeof event?.stepId === "string" ? event.stepId : null;
  switch (type) {
    case "run.started":
      return {
        ts,
        type,
        stepId: null,
        label: `run started (${event?.spec ?? ""})`.trim(),
        tone: "info",
      };
    case "run.finished":
      return {
        ts,
        type,
        stepId: null,
        label: `run finished: ${event?.status ?? "unknown"}`,
        tone: event?.status === "passed" ? "ok" : "bad",
      };
    case "step.started":
      return {
        ts,
        type,
        stepId,
        label: `step ${stepId ?? ""} started`.trim(),
        tone: "info",
      };
    case "step.finished":
      return {
        ts,
        type,
        stepId,
        label:
          `step ${stepId ?? ""} finished in ${event?.durationMs ?? 0}ms`.trim(),
        tone: event?.status === "failed" ? "bad" : "ok",
      };
    case "step.skipped":
      return {
        ts,
        type,
        stepId,
        label: `step ${stepId ?? ""} skipped (when:)`.trim(),
        tone: "muted",
      };
    case "outcome.evaluated":
      return {
        ts,
        type,
        stepId: null,
        label:
          `outcome ${event?.outcomeId ?? event?.id ?? ""}: ${event?.status ?? ""}`.trim(),
        tone: event?.status === "passed" ? "ok" : "bad",
      };
    case "artifact.screenshot":
      return {
        ts,
        type,
        stepId,
        label: `screenshot ${event?.path ?? ""}`.trim(),
        tone: "muted",
      };
    case "artifact.snapshot":
      return {
        ts,
        type,
        stepId,
        label: `snapshot ${event?.path ?? ""}`.trim(),
        tone: "muted",
      };
    case "viewport.set":
      return {
        ts,
        type,
        stepId: null,
        label: `viewport ${event?.width ?? "?"}×${event?.height ?? "?"}`,
        tone: "muted",
      };
    default:
      return { ts, type, stepId, label: type, tone: "muted" };
  }
}

/**
 * Roll events up into per-step progress rows.
 * @param {Array<Record<string, any>>} events
 * @returns {Array<{ stepId: string, status: "running" | "passed" | "failed" | "skipped", startedAt: string | null, durationMs: number | null, artifacts: string[] }>}
 */
function stepProgress(events) {
  /** @type {Map<string, any>} */
  const steps = new Map();
  for (const event of events) {
    const stepId = typeof event?.stepId === "string" ? event.stepId : null;
    if (!stepId) continue;
    const row = steps.get(stepId) ?? {
      stepId,
      status: "running",
      startedAt: null,
      durationMs: null,
      artifacts: [],
    };
    switch (String(event?.type ?? "")) {
      case "step.started":
        row.status = "running";
        row.startedAt = typeof event.ts === "string" ? event.ts : row.startedAt;
        break;
      case "step.finished":
        row.status = event?.status === "failed" ? "failed" : "passed";
        row.durationMs =
          typeof event?.durationMs === "number"
            ? event.durationMs
            : row.durationMs;
        break;
      case "step.skipped":
        row.status = "skipped";
        break;
      case "artifact.snapshot":
      case "artifact.screenshot":
        if (
          typeof event?.path === "string" &&
          !row.artifacts.includes(event.path)
        )
          row.artifacts.push(event.path);
        break;
      default:
        break;
    }
    steps.set(stepId, row);
  }
  return [...steps.values()];
}

/**
 * Start polling the artifact root for a new run directory, then tail its
 * events file. Calls back on the same thread; `stop()` is idempotent.
 *
 * @param {{
 *   runsRoot: string,
 *   specNames?: Iterable<string> | string | null,
 *   knownIds?: Iterable<string>,
 *   pollMs?: number,
 *   onRunDir?: (runDir: string, runId: string) => void,
 *   onEvents?: (events: Array<Record<string, any>>, runDir: string) => void,
 *   onEnd?: () => void,
 * }} options
 * @returns {{ stop: () => void, runDir: () => string | null }}
 */
function createLiveTail(options) {
  const pollMs = Math.max(100, options.pollMs ?? 400);
  const startedAtMs = Date.now();
  let stopped = false;
  let runId = null;
  let runDir = null;
  let offset = 0;
  let timer = null;
  let endedTimer = null;

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
      const result = readEventsFrom(runDir, offset);
      offset = result.offset;
      if (result.events.length) options.onEvents?.(result.events, runDir);
      if (fs.existsSync(path.join(runDir, "run.json"))) {
        // The run payload is written last; one more tick drains trailing events.
        if (!endedTimer)
          endedTimer = setTimeout(() => {
            const drained = readEventsFrom(runDir, offset);
            offset = drained.offset;
            if (drained.events.length)
              options.onEvents?.(drained.events, runDir);
            options.onEnd?.();
            stop();
          }, pollMs);
      }
    }
    if (!stopped) timer = setTimeout(poll, pollMs);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (endedTimer) clearTimeout(endedTimer);
    timer = null;
    endedTimer = null;
  };

  timer = setTimeout(poll, 50);
  return { stop, runDir: () => runDir };
}

module.exports = {
  runIdTimestampMs,
  pickNewRunId,
  describeEvent,
  stepProgress,
  createLiveTail,
};
