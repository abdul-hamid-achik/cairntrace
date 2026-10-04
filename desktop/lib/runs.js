/**
 * Read-side helpers over the cairn artifact root.
 *
 * Everything here is read-only and defensive: a run directory can be missing
 * `run.json` (a run killed by a signal), truncated, or still being written by
 * a live run. The desktop app must render what exists instead of throwing, and
 * must never let a renderer-supplied relative path escape the run directory.
 *
 * Only directories named like a run (`RUN_DIR_PATTERN`, the CLI's own
 * retention pattern) are runs. `_invocations/`, `_diagnostics/`, metrics
 * folders, and anything else a tool drops in the artifact root are ignored.
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseRunId, runIdTimestampMs } = require("./format");
const CairnEvents = require("./events");
const CairnPolicy = require("./policy");
const evidence = require("./evidence");
const dataEvidence = require("./dataEvidence");
const metrics = require("./metrics");

const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** A run-less directory quiet longer than this is no longer "detected". */
const DEFAULT_STALE_MS = 30 * 60_000;
/** A run-less directory written within this window renders as "running". */
const DEFAULT_RUNNING_WINDOW_MS = 5 * 60_000;
/** Bytes read from each end of events.ndjson for liveness signals. */
const LIVENESS_WINDOW_BYTES = 16 * 1024;

/**
 * Copied verbatim from `src/core/artifacts/retention.ts` (RUN_DIR_PATTERN).
 * test/runs.test.js reads that source file and fails if the two drift.
 */
const RUN_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T[\dT-]+Z?_(.+)_[0-9a-f]{6}$/;

/** The invocation journal folder under the artifact root (never a run). */
const INVOCATIONS_DIR = "_invocations";

/**
 * `<ISO with ':'/'.' → '-'>_<pid>_<6 hex>` — also the traversal guard for
 * renderer-supplied ids.
 */
const INVOCATION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_\d+_[0-9a-f]{6}$/;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".webm", ".mp4"]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".ndjson",
  ".yml",
  ".yaml",
  ".log",
  ".csv",
  ".tsv",
  ".html",
  ".css",
  ".js",
  ".xml",
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
function isRunDirName(name) {
  return RUN_DIR_PATTERN.test(String(name ?? ""));
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isInvocationId(value) {
  return INVOCATION_ID_PATTERN.test(String(value ?? ""));
}

/**
 * Join a renderer-supplied relative path onto a base directory, refusing
 * traversal outside it.
 * @param {string} baseDir
 * @param {string} relativePath
 * @returns {string | null} absolute path, or null when it escapes `baseDir`
 */
function safeJoin(baseDir, relativePath) {
  if (!baseDir || typeof relativePath !== "string" || !relativePath)
    return null;
  if (path.isAbsolute(relativePath)) return null;
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, relativePath);
  if (
    resolved !== resolvedBase &&
    !resolved.startsWith(resolvedBase + path.sep)
  )
    return null;
  return resolved;
}

/**
 * Is `target` equal to or inside one of `roots`?
 * @param {string} target
 * @param {Iterable<string | null | undefined>} roots
 * @returns {boolean}
 */
function isWithin(target, roots) {
  if (!target) return false;
  const resolved = path.resolve(target);
  for (const root of roots) {
    if (!root) continue;
    const base = path.resolve(root);
    if (resolved === base || resolved.startsWith(base + path.sep)) return true;
  }
  return false;
}

/**
 * @param {string} file
 * @returns {any} parsed JSON, or null when the file is missing or corrupt
 */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readTextFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Run directories are named `<iso>_<spec>_<hex>` so a lexicographic sort is a
 * chronological one. Anything else in the artifact root is not a run.
 * @param {string} runsRoot
 * @returns {string[]} run ids, newest first
 */
function listRunIds(runsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => isRunDirName(name))
    .toSorted((a, b) => b.localeCompare(a));
}

/**
 * Whether a process id is alive (signal 0). EPERM means it exists but is
 * owned by someone else — still alive.
 * @param {number | null | undefined} pid
 * @returns {boolean | null} null when no pid was given
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return null;
  try {
    process.kill(/** @type {number} */ (pid), 0);
    return true;
  } catch (error) {
    return /** @type {any} */ (error)?.code === "EPERM";
  }
}

/**
 * @typedef {object} RunSummary
 * @property {string} runId
 * @property {string} dir
 * @property {string} spec
 * @property {string | null} specPath
 * @property {string} status
 * @property {boolean} running
 * @property {string | null} summary
 * @property {Record<string, any> | null} failure
 * @property {string | null} startedAt
 * @property {string | null} endedAt
 * @property {number | null} durationMs
 * @property {string | null} backend
 * @property {string | null} environment
 * @property {boolean} coldStart
 * @property {Record<string, string> | null} labels
 * @property {{ id: string, index: number | null, total: number | null, dir: string | null } | null} invocation
 * @property {{ at: string | null, reason: string | null } | null} pinned
 *   run.json `pinned` (retention never prunes it)
 * @property {ReturnType<typeof CairnPolicy.normalizeRefusal>} refusal
 *   run.json `refusal` (status "refused": the environment policy said no)
 * @property {number | null} exitCode
 * @property {boolean} interrupted
 * @property {number} mtimeMs
 * @property {number | null} lastActivityMs
 * @property {Record<string, any> | null} liveness
 * @property {{ total: number, passed: number, failed: number }} outcomes
 * @property {Record<string, any> | null} artifacts
 */

/**
 * When a run directory was last written: the `events.ndjson` heartbeat when
 * present (the runner appends to it all run long), else the directory itself.
 * A finished run's last write is `run.json`, but callers only ask here when
 * `run.json` is missing.
 * @param {string} runDir
 * @returns {number | null} epoch millis, or null when nothing is readable
 */
function lastActivityMs(runDir) {
  for (const candidate of ["events.ndjson", "."]) {
    try {
      return fs.statSync(path.join(runDir, candidate)).mtimeMs;
    } catch {
      // try the next signal
    }
  }
  return null;
}

/**
 * Parse whole JSON lines out of a byte window of events.ndjson.
 * @param {string} runDir
 * @param {"head" | "tail"} end
 * @param {number} [maxBytes]
 * @returns {Array<Record<string, any>>}
 */
function readEventsWindow(runDir, end, maxBytes = LIVENESS_WINDOW_BYTES) {
  const file = path.join(runDir, "events.ndjson");
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (!size) return [];
    const length = Math.min(size, maxBytes);
    const start = end === "head" ? 0 : size - length;
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString("utf8").split("\n");
    // A window edge can cut a line in half; drop the partial ones.
    if (end === "tail" && start > 0) lines.shift();
    if (end === "head" && length < size) lines.pop();
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") out.push(parsed);
      } catch {
        // partial line
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The local journal of a delegated invocation (`delegate` in its
 * invocation.json) that lists `runId`: a run directory its runner copies
 * here from another machine. Newest first among the last `limit` journals.
 * @param {string} runsRoot
 * @param {string} runId
 * @param {number} [limit]
 * @returns {{ id: string, pid: number | null, status: string | null } | null}
 */
function delegatedRunOwner(runsRoot, runId, limit = 50) {
  let names;
  try {
    names = fs
      .readdirSync(path.join(runsRoot, INVOCATIONS_DIR))
      .filter(isInvocationId)
      .toSorted((a, b) => b.localeCompare(a))
      .slice(0, limit);
  } catch {
    return null;
  }
  for (const name of names) {
    const journal = readJsonFile(
      path.join(runsRoot, INVOCATIONS_DIR, name, "invocation.json"),
    );
    if (
      journal?.delegate &&
      Array.isArray(journal.runs) &&
      journal.runs.some((/** @type {any} */ run) => run?.runId === runId)
    ) {
      return {
        id: name,
        pid: Number.isInteger(journal.pid) ? journal.pid : null,
        status: typeof journal.status === "string" ? journal.status : null,
      };
    }
  }
  return null;
}

/**
 * Liveness of a run directory without `run.json`: heartbeat → owning pid
 * (heartbeat or invocation journal) → mtime windows. A run a delegated
 * runner copies here (its invocation journal is on another machine, and
 * its heartbeats name a pid there) lives and dies with the LOCAL delegated
 * invocation that lists it: that process's pid and journal status decide.
 * @param {string} runsRoot
 * @param {string} runDir
 * @param {{ now?: number, runningWindowMs?: number, staleMs?: number, pidAlive?: (pid: number) => boolean | null, lastActivityMs?: number | null }} [options]
 * @returns {{ state: string, reason: string, heartbeatAgeMs: number | null, pid: number | null, invocation: Record<string, any> | null, heartbeatPhase: string | null }}
 */
function runLiveness(runsRoot, runDir, options = {}) {
  const tail = readEventsWindow(runDir, "tail");
  const heartbeat = tail.findLast((event) => event?.type === "run.heartbeat");
  const started = readEventsWindow(runDir, "head").find(
    (event) => event?.type === "run.started",
  );
  const invocation =
    started?.invocation && typeof started.invocation === "object"
      ? started.invocation
      : null;
  const localJournalDir =
    typeof invocation?.dir === "string"
      ? safeJoin(runsRoot, invocation.dir)
      : null;
  const owner =
    invocation && !(localJournalDir && fs.existsSync(localJournalDir))
      ? delegatedRunOwner(runsRoot, path.basename(runDir))
      : null;
  if (owner) {
    const ownerAlive =
      owner.status === "running" && owner.pid
        ? (options.pidAlive ?? isPidAlive)(owner.pid)
        : false;
    const verdict = CairnEvents.classifyLiveness({
      hasRunJson: false,
      heartbeatTs: null,
      pid: owner.pid,
      pidAlive: ownerAlive,
      lastActivityMs:
        options.lastActivityMs === undefined
          ? lastActivityMs(runDir)
          : options.lastActivityMs,
      now: options.now,
      runningWindowMs: options.runningWindowMs,
      staleMs: options.staleMs,
    });
    return {
      ...verdict,
      reason:
        owner.status !== "running"
          ? `its delegated invocation ${owner.id} settled (${owner.status ?? "unknown"}) without the runner copying run.json`
          : `delegated: ${verdict.reason} (local invocation ${owner.id})`,
      pid: owner.pid,
      invocation,
      heartbeatPhase:
        typeof heartbeat?.phase === "string" ? heartbeat.phase : null,
    };
  }
  let pid = Number.isInteger(heartbeat?.pid) ? heartbeat.pid : null;
  if (!pid && typeof invocation?.dir === "string") {
    const journalDir = safeJoin(runsRoot, invocation.dir);
    const journal = journalDir
      ? readJsonFile(path.join(journalDir, "invocation.json"))
      : null;
    if (Number.isInteger(journal?.pid)) pid = journal.pid;
  }
  const pidAlive = pid ? (options.pidAlive ?? isPidAlive)(pid) : null;
  const activity =
    options.lastActivityMs === undefined
      ? lastActivityMs(runDir)
      : options.lastActivityMs;
  const verdict = CairnEvents.classifyLiveness({
    hasRunJson: false,
    heartbeatTs: heartbeat?.ts ?? null,
    pid,
    pidAlive,
    lastActivityMs: activity,
    now: options.now,
    runningWindowMs: options.runningWindowMs,
    staleMs: options.staleMs,
  });
  return {
    ...verdict,
    pid,
    invocation,
    heartbeatPhase:
      typeof heartbeat?.phase === "string" ? heartbeat.phase : null,
  };
}

/**
 * @param {any} value
 * @returns {{ id: string, index: number | null, total: number | null, dir: string | null } | null}
 */
function invocationRef(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string")
    return null;
  return {
    id: value.id,
    index: Number.isFinite(value.index) ? value.index : null,
    total: Number.isFinite(value.total) ? value.total : null,
    dir: typeof value.dir === "string" ? value.dir : null,
  };
}

/**
 * ISO start time recovered from a run id (for runs without run.json).
 * @param {string | null} value
 * @returns {string | null}
 */
function runIdStartedIso(value) {
  const ms = runIdTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * @param {string} runsRoot
 * @param {string} runId
 * @param {{ now?: number, runningWindowMs?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {RunSummary}
 */
function summarizeRun(runsRoot, runId, options = {}) {
  const dir = path.join(runsRoot, runId);
  const run = readJsonFile(path.join(dir, "run.json"));
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(dir).mtimeMs;
  } catch {
    // directory vanished between readdir and stat
  }
  const parsed = parseRunId(runId);
  const record = run && typeof run === "object" ? run : null;
  const outcomes = Array.isArray(record?.outcomes) ? record.outcomes : [];
  const activity = record ? null : lastActivityMs(dir);
  const liveness = record
    ? null
    : runLiveness(runsRoot, dir, {
        now: options.now,
        runningWindowMs: options.runningWindowMs ?? DEFAULT_RUNNING_WINDOW_MS,
        pidAlive: options.pidAlive,
        lastActivityMs: activity,
      });
  const running =
    !record && (liveness?.state === "running" || liveness?.state === "quiet");
  return {
    runId,
    dir,
    spec: record?.spec?.name ?? parsed.spec ?? runId,
    specPath: record?.spec?.path ?? null,
    status: record?.status ?? (running ? "running" : "interrupted"),
    running,
    summary: record?.summary ?? null,
    failure: record?.failure ?? null,
    startedAt: record?.startedAt ?? runIdStartedIso(parsed.startedAt),
    endedAt: record?.endedAt ?? null,
    durationMs:
      typeof record?.durationMs === "number" ? record.durationMs : null,
    backend: record?.backend ?? null,
    environment: record?.environment ?? null,
    coldStart: Boolean(record?.coldStart),
    labels:
      record?.labels && typeof record.labels === "object"
        ? record.labels
        : null,
    invocation: invocationRef(record?.invocation ?? liveness?.invocation),
    pinned: evidence.normalizePinned(record?.pinned),
    refusal: CairnPolicy.normalizeRefusal(record?.refusal),
    exitCode: record?.exitCode ?? null,
    interrupted: !record || !record.status,
    mtimeMs,
    lastActivityMs: activity,
    liveness,
    outcomes: {
      total: outcomes.length,
      passed: outcomes.filter((o) => o?.status === "passed").length,
      failed: outcomes.filter(
        (o) => o?.status === "failed" || o?.status === "errored",
      ).length,
    },
    artifacts: record?.artifacts ?? null,
  };
}

/**
 * `key=value` (exact) or `key` (present) label filters.
 * @param {Array<string> | Record<string, string> | null | undefined} filters
 * @returns {Array<{ key: string, value: string | null }>}
 */
function parseLabelFilters(filters) {
  if (!filters) return [];
  const entries = Array.isArray(filters)
    ? filters
    : Object.entries(filters).map(([key, value]) =>
        value === null || value === undefined || value === ""
          ? key
          : `${key}=${value}`,
      );
  const out = [];
  for (const entry of entries) {
    const text = String(entry ?? "").trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    if (eq === -1) out.push({ key: text, value: null });
    else out.push({ key: text.slice(0, eq).trim(), value: text.slice(eq + 1) });
  }
  return out.filter((entry) => entry.key);
}

/**
 * @param {Record<string, string> | null} labels
 * @param {Array<{ key: string, value: string | null }>} filters
 * @returns {boolean}
 */
function labelsMatch(labels, filters) {
  for (const filter of filters) {
    const value = labels?.[filter.key];
    if (value === undefined) return false;
    if (filter.value !== null && String(value) !== filter.value) return false;
  }
  return true;
}

/**
 * @param {Record<string, string> | null} labels
 * @returns {string}
 */
function labelText(labels) {
  return labels
    ? Object.entries(labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
}

/**
 * @param {string} runsRoot
 * @param {{ limit?: number, status?: string | null, spec?: string | null, search?: string | null, labels?: string[] | Record<string, string> | null, invocation?: string | null, now?: number, runningWindowMs?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {Array<ReturnType<typeof summarizeRun>>}
 */
function listRuns(runsRoot, options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  const status = options.status?.trim().toLowerCase() || null;
  const spec = options.spec?.trim().toLowerCase() || null;
  const search = options.search?.trim().toLowerCase() || null;
  const labelFilters = parseLabelFilters(options.labels);
  const invocation = options.invocation?.trim() || null;
  const out = [];
  for (const runId of listRunIds(runsRoot)) {
    if (out.length >= limit) break;
    const summary = summarizeRun(runsRoot, runId, options);
    if (status && String(summary.status).toLowerCase() !== status) continue;
    if (spec && String(summary.spec).toLowerCase() !== spec) continue;
    if (labelFilters.length && !labelsMatch(summary.labels, labelFilters))
      continue;
    if (invocation && summary.invocation?.id !== invocation) continue;
    if (search) {
      const haystack =
        `${summary.runId} ${summary.spec} ${summary.summary ?? ""} ${labelText(summary.labels)} ${summary.refusal?.reason ?? ""} ${summary.pinned?.reason ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    out.push(summary);
  }
  return out;
}

/**
 * Label keys and values discovered from `run.json` files, so filters and
 * cohort pickers offer what actually exists.
 * @param {string} runsRoot
 * @param {{ scanLimit?: number, maxValues?: number }} [options]
 * @returns {Array<{ key: string, count: number, values: string[] }>}
 */
function listRunLabels(runsRoot, options = {}) {
  const scanLimit = options.scanLimit ?? 400;
  const maxValues = options.maxValues ?? 60;
  /** @type {Map<string, { count: number, values: Set<string> }>} */
  const keys = new Map();
  for (const runId of listRunIds(runsRoot).slice(0, scanLimit)) {
    const record = readJsonFile(path.join(runsRoot, runId, "run.json"));
    const labels = record?.labels;
    if (!labels || typeof labels !== "object") continue;
    for (const [key, value] of Object.entries(labels)) {
      const entry = keys.get(key) ?? { count: 0, values: new Set() };
      entry.count += 1;
      if (entry.values.size < maxValues) entry.values.add(String(value));
      keys.set(key, entry);
    }
  }
  return [...keys.entries()]
    .map(([key, entry]) => ({
      key,
      count: entry.count,
      values: [...entry.values].toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

/**
 * Run directories still in flight (or crashed without a record): no
 * `run.json` yet, and either alive by heartbeat/pid or written recently
 * enough to be worth watching. This is how the desktop app finds runs
 * started outside itself — `run.json` is written last.
 * @param {string} runsRoot
 * @param {{ staleMs?: number, limit?: number, now?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {Array<{ runId: string, runDir: string, spec: string, startedAt: string | null, startedAtMs: number | null, lastActivityMs: number | null, ageMs: number, liveness: Record<string, any>, invocation: Record<string, any> | null }>}
 */
function listDetectedRuns(runsRoot, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const limit = Math.max(1, options.limit ?? 20);
  const now = options.now ?? Date.now();
  const out = [];
  for (const runId of listRunIds(runsRoot)) {
    if (out.length >= limit) break;
    const runDir = path.join(runsRoot, runId);
    if (fs.existsSync(path.join(runDir, "run.json"))) continue;
    const activity = lastActivityMs(runDir);
    const recent = activity !== null && now - activity <= staleMs;
    // A quiet-but-alive run (old runner, long precondition) stays detected
    // while its process lives; a quiet run with no pid ages out as before.
    const liveness = runLiveness(runsRoot, runDir, {
      now,
      staleMs,
      pidAlive: options.pidAlive,
      lastActivityMs: activity,
    });
    const alive = liveness.state === "running" || liveness.state === "quiet";
    if (!recent && !alive) continue;
    const parsed = parseRunId(runId);
    out.push({
      runId,
      runDir,
      spec: parsed.spec ?? runId,
      startedAt: parsed.startedAt,
      startedAtMs: runIdTimestampMs(parsed.startedAt),
      lastActivityMs: activity,
      ageMs: activity === null ? 0 : Math.max(0, now - activity),
      liveness,
      invocation: invocationRef(liveness.invocation),
    });
  }
  return out;
}

/**
 * Distinct spec names present in the artifact root, newest first.
 * @param {string} runsRoot
 * @param {number} [scanLimit]
 * @returns {string[]}
 */
function listRunSpecs(runsRoot, scanLimit = 400) {
  const seen = new Set();
  for (const runId of listRunIds(runsRoot).slice(0, scanLimit)) {
    const parsed = parseRunId(runId);
    if (parsed.spec) seen.add(parsed.spec);
  }
  return [...seen].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Spec keys a run can be matched by: its `name:`, its file basename, and
 * its path.
 * @param {Record<string, any> | null} record
 * @param {string} runId
 * @returns {string[]}
 */
function specKeysOf(record, runId) {
  const keys = new Set();
  const name = record?.spec?.name ?? parseRunId(runId).spec;
  if (name) keys.add(String(name));
  const specPath = record?.spec?.path;
  if (typeof specPath === "string" && specPath) {
    keys.add(specPath);
    keys.add(path.basename(specPath, path.extname(specPath)));
  }
  return [...keys];
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * p50 duration per spec key from local history — the basis for batch ETAs.
 * @param {string} runsRoot
 * @param {{ scanLimit?: number, perSpec?: number }} [options]
 * @returns {Record<string, { p50: number, n: number }>}
 */
function specDurationHistory(runsRoot, options = {}) {
  const scanLimit = options.scanLimit ?? 400;
  const perSpec = options.perSpec ?? 20;
  /** @type {Map<string, number[]>} */
  const samples = new Map();
  for (const runId of listRunIds(runsRoot).slice(0, scanLimit)) {
    const record = readJsonFile(path.join(runsRoot, runId, "run.json"));
    if (!record || typeof record.durationMs !== "number") continue;
    if (record.status !== "passed" && record.status !== "failed") continue;
    for (const key of specKeysOf(record, runId)) {
      const list = samples.get(key) ?? [];
      if (list.length < perSpec) list.push(record.durationMs);
      samples.set(key, list);
    }
  }
  /** @type {Record<string, { p50: number, n: number }>} */
  const out = {};
  for (const [key, list] of samples) {
    const p50 = median(list);
    if (p50 !== null) out[key] = { p50, n: list.length };
  }
  return out;
}

/**
 * The last N runs of one spec (newest first): the flakiness strip.
 * @param {string} runsRoot
 * @param {string} spec spec name, file basename, or path
 * @param {{ limit?: number, scanLimit?: number }} [options]
 * @returns {Array<{ runId: string, status: string, durationMs: number | null, startedAt: string | null }>}
 */
function runHistory(runsRoot, spec, options = {}) {
  const limit = Math.max(1, options.limit ?? 20);
  const scanLimit = options.scanLimit ?? 600;
  const wanted = String(spec ?? "").trim();
  if (!wanted) return [];
  const wantedKeys = new Set([
    wanted,
    path.basename(wanted, path.extname(wanted)),
  ]);
  const out = [];
  for (const runId of listRunIds(runsRoot).slice(0, scanLimit)) {
    if (out.length >= limit) break;
    const record = readJsonFile(path.join(runsRoot, runId, "run.json"));
    if (!specKeysOf(record, runId).some((key) => wantedKeys.has(key))) continue;
    out.push({
      runId,
      status: String(record?.status ?? "interrupted"),
      durationMs:
        typeof record?.durationMs === "number" ? record.durationMs : null,
      startedAt: record?.startedAt ?? null,
    });
  }
  return out;
}

/**
 * Is this directory a run folder: named like one (`<iso>_<spec>_<hex>`), or
 * holding the run record / event stream (a stash restored flat)?
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeRunDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  if (isRunDirName(path.basename(dir))) return true;
  return ["run.json", "events.ndjson"].some((name) =>
    fs.existsSync(path.join(dir, name)),
  );
}

/**
 * Resolve `latest`, `previous`, a run id, or an absolute run directory.
 * Absolute directories are only accepted inside `allowedRoots` when given,
 * and only when they look like a run folder, never an arbitrary directory
 * that happens to sit under an allowed root.
 * @param {string} runsRoot
 * @param {string} ref
 * @param {{ allowedRoots?: Array<string | null | undefined> }} [options]
 * @returns {string | null} absolute run directory
 */
function resolveRunRef(runsRoot, ref, options = {}) {
  const value = String(ref ?? "").trim();
  if (!value) return null;
  if (path.isAbsolute(value)) {
    if (options.allowedRoots && !isWithin(value, options.allowedRoots))
      return null;
    return looksLikeRunDir(value) ? path.resolve(value) : null;
  }
  const ids = listRunIds(runsRoot);
  if (value === "latest") return ids[0] ? path.join(runsRoot, ids[0]) : null;
  if (value === "previous") return ids[1] ? path.join(runsRoot, ids[1]) : null;
  const exact = ids.find((id) => id === value);
  if (exact) return path.join(runsRoot, exact);
  const partial = ids.find((id) => id.includes(value));
  return partial ? path.join(runsRoot, partial) : null;
}

/**
 * Group the artifact manifest by kind so the UI can offer sensible tabs.
 * @param {Record<string, any> | null} manifest
 * @returns {Record<string, Array<{ path: string, kind: string, bytes: number, sha256?: string }>>}
 */
function groupArtifacts(manifest) {
  /** @type {Record<string, Array<{ path: string, kind: string, bytes: number, sha256?: string }>>} */
  const groups = {};
  for (const entry of Array.isArray(manifest?.artifacts)
    ? manifest.artifacts
    : []) {
    if (!entry || typeof entry.path !== "string") continue;
    const kind = String(entry.kind ?? "other");
    (groups[kind] ??= []).push(entry);
  }
  for (const kind of Object.keys(groups))
    groups[kind] = groups[kind].toSorted((a, b) =>
      a.path.localeCompare(b.path),
    );
  return groups;
}

/**
 * Evidence text for a run-relative artifact, or null when it is unreadable.
 * @param {string} runDir
 * @param {string | null} relativePath
 * @param {number} maxBytes
 * @returns {string | null}
 */
function evidenceText(runDir, relativePath, maxBytes) {
  if (!relativePath) return null;
  const result = readBoundedText(runDir, relativePath, maxBytes);
  return result.ok ? result.text : null;
}

/**
 * Pull the `## Expected` / `## Actual` sections out of an outcome evidence
 * file (`src/core/artifacts/evidence.ts` writes them).
 * @param {string | null | undefined} text
 * @param {number} [maxChars]
 * @returns {{ expected: string | null, actual: string | null }}
 */
function parseOutcomeEvidence(text, maxChars = 2000) {
  const out = { expected: null, actual: null };
  if (!text) return out;
  /** @type {"expected" | "actual" | null} */
  let section = null;
  /** @type {Record<string, string[]>} */
  const buckets = { expected: [], actual: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1].toLowerCase();
      section = name === "expected" || name === "actual" ? name : null;
      continue;
    }
    if (section) buckets[section].push(line);
  }
  for (const key of /** @type {const} */ (["expected", "actual"])) {
    const value = buckets[key].join("\n").trim();
    if (value)
      out[key] =
        value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  }
  return out;
}

/**
 * First `max` non-empty strings mapped out of a diagnostics list.
 * @param {any} list
 * @param {number} max
 * @param {(entry: any) => string} map
 * @returns {string[]}
 */
function pickStrings(list, max, map) {
  return (Array.isArray(list) ? list : [])
    .map(map)
    .filter((value) => typeof value === "string" && value.trim())
    .slice(0, max);
}

/**
 * Compact view of a `diagnostics/<NN>_<step>.json` capture for the failure
 * panel: where the page was and what it offered.
 * @param {any} diagnostics
 * @returns {Record<string, any> | null}
 */
function summarizeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  return {
    url: typeof diagnostics.url === "string" ? diagnostics.url : null,
    title: typeof diagnostics.title === "string" ? diagnostics.title : null,
    readyState:
      typeof diagnostics.readyState === "string"
        ? diagnostics.readyState
        : null,
    stepError:
      typeof diagnostics.stepError === "string" && diagnostics.stepError
        ? diagnostics.stepError
        : null,
    selectorCount: diagnostics.selectorCount ?? null,
    diagnosticsError:
      typeof diagnostics.diagnosticsError === "string"
        ? diagnostics.diagnosticsError
        : null,
    buttons: pickStrings(
      diagnostics.visibleButtons,
      20,
      (entry) => `${entry?.text ?? ""}${entry?.disabled ? " (disabled)" : ""}`,
    ),
    links: pickStrings(
      diagnostics.visibleLinks,
      12,
      (entry) => entry?.text ?? "",
    ),
    inputs: pickStrings(
      diagnostics.visibleInputs,
      12,
      (entry) =>
        entry?.label || entry?.placeholder || entry?.name || entry?.type || "",
    ),
    excerpts: (Array.isArray(diagnostics.expectedTextExcerpts)
      ? diagnostics.expectedTextExcerpts
      : []
    )
      .slice(0, 6)
      .map((entry) => ({
        needle: String(entry?.needle ?? ""),
        found: Boolean(entry?.found),
        excerpt: String(entry?.excerpt ?? ""),
      })),
  };
}

/**
 * What Run detail's Failure panel shows first on a failed/errored run.
 * @param {string} runDir
 * @param {any} run
 * @param {Record<string, any>} model reduced events.ndjson
 * @param {Array<Record<string, any>>} outcomes
 * @param {Array<{ path: string }>} files
 * @param {Set<string>} [journalLogs] hook logs that exist in the run's
 *   invocation journal (paths relative to the journal folder)
 * @returns {Record<string, any> | null}
 */
function buildFailurePanel(
  runDir,
  run,
  model,
  outcomes,
  files,
  journalLogs,
  expects = [],
) {
  // A refused run never started: it gets a refusal panel, not a failure one.
  if (
    !run ||
    typeof run !== "object" ||
    run.status === "passed" ||
    run.status === "refused"
  )
    return null;
  const failure =
    run.failure && typeof run.failure === "object" ? run.failure : {};
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const record =
    // a looped step has a result per execution: the failed one first
    steps.find(
      (step) =>
        step?.id && step.id === failure.step && step.status === "failed",
    ) ??
    steps.find((step) => step?.id && step.id === failure.step) ??
    steps.find((step) => step?.status === "failed") ??
    null;
  // F14: a looped step has one row per execution; the failed one is it.
  const failedId = record?.id ?? failure.step;
  const row =
    model.steps.findLast(
      (entry) =>
        entry.stepId === failedId &&
        entry.status === "failed" &&
        !entry.superseded,
    ) ??
    model.steps.findLast((entry) => entry.stepId === failedId) ??
    (record
      ? null
      : model.steps.find(
          (entry) => entry.status === "failed" && !entry.superseded,
        )) ??
    null;
  const stepId = record?.id ?? row?.stepId ?? null;
  const artifacts = [
    ...(Array.isArray(record?.artifacts) ? record.artifacts : []),
    ...(row?.artifacts ?? []),
  ].filter((entry) => typeof entry === "string");
  const screenshot =
    row?.screenshot ??
    artifacts.find((entry) =>
      /^screenshots\/.+\.(png|jpe?g|webp)$/i.test(entry),
    ) ??
    null;
  const diagnosticsPath =
    row?.diagnostics ??
    artifacts.find(
      (entry) =>
        /^diagnostics\/.+\.json$/i.test(entry) &&
        !/_screenshot\.json$/i.test(entry),
    ) ??
    null;
  const diagnosticsFile = diagnosticsPath
    ? safeJoin(runDir, diagnosticsPath)
    : null;
  const rawDiagnostics = diagnosticsFile ? readJsonFile(diagnosticsFile) : null;
  const diagnostics = summarizeDiagnostics(rawDiagnostics);
  const fileSet = new Set(files.map((entry) => entry.path));
  /** An artifact path the panel may link, only when it exists on disk. */
  const exists = (/** @type {string | null} */ rel) =>
    rel && (fileSet.has(rel) || !fileSet.size) ? rel : null;

  const failedOutcomes = outcomes
    .filter(
      (outcome) => outcome.status === "failed" || outcome.status === "errored",
    )
    .map((outcome) => {
      // outcome.* events carry no expected/actual: the evidence file does.
      const parsed = parseOutcomeEvidence(outcome.evidenceText);
      return {
        id: outcome.id,
        status: outcome.status,
        evidence: outcome.evidence,
        expected: parsed.expected,
        actual: parsed.actual,
        logPath:
          model.logs.find(
            (entry) => entry.kind === "outcome" && entry.name === outcome.id,
          )?.path ??
          (fileSet.has(`logs/outcome-${outcome.id}.log`)
            ? `logs/outcome-${outcome.id}.log`
            : null),
      };
    });

  const failedPrecondition =
    model.preconditions.findLast((entry) => entry.status === "failed") ?? null;
  const failedHooks = model.hooks.filter((entry) => entry.status === "failed");
  // F2: a `preconditions.wait` gate that never got ready settles the run as
  // the precondition `wait <gate>`; its attempts are the evidence.
  const gateName =
    typeof failure.name === "string" && failure.name.startsWith("wait ")
      ? failure.name.slice("wait ".length)
      : null;
  const failedGate =
    model.gates.findLast(
      (entry) =>
        entry.status !== "passed" &&
        entry.status !== "waiting" &&
        (gateName === null || entry.name === gateName),
    ) ?? null;
  // F16: the failing step was an `expect` (its verdict file says what).
  const failedExpect = stepId
    ? (expects.find(
        (entry) => entry.stepId === stepId && entry.status === "failed",
      ) ??
      (row?.expect?.status === "failed"
        ? {
            path: row.expect.path,
            id: row.expect.expectId,
            stepId,
            status: "failed",
            kind: row.expect.kind,
            expected: row.expect.expected,
            actual: row.expect.actual,
            attempts: row.expect.attempts,
            durationMs: row.expect.durationMs,
            table: null,
            observed: null,
            readable: false,
          }
        : null))
    : null;
  // F3a: teardown items that failed (they keep the verdict unless the spec
  // says `failRun: true`, so they show next to whatever else failed).
  const failedTeardown = model.teardown.filter(
    (entry) => entry.status === "failed",
  );

  return {
    status: run.status,
    summary: typeof run.summary === "string" ? run.summary : null,
    message: typeof failure.message === "string" ? failure.message : null,
    phase: typeof failure.phase === "string" ? failure.phase : null,
    name: typeof failure.name === "string" ? failure.name : null,
    timedOut: Boolean(failure.timedOut),
    step: stepId
      ? {
          id: stepId,
          index: row?.index ?? (record ? steps.indexOf(record) + 1 : null),
          kind:
            row?.kind ??
            (typeof rawDiagnostics?.step?.kind === "string"
              ? rawDiagnostics.step.kind
              : null),
          label: row?.label ?? null,
          error: record?.error ?? row?.error ?? failure.message ?? null,
          durationMs: record?.durationMs ?? row?.durationMs ?? null,
          url: row?.url ?? diagnostics?.url ?? null,
          screenshot: exists(screenshot),
          diagnosticsPath: exists(diagnosticsPath),
          // F14: where a nested step ran (`in visit_rows #3`)
          place: CairnEvents.placeText(record ?? row),
          // its evidence files (F15 widgets/, F18 requests/ …)
          artifacts: [...new Set(artifacts)].slice(0, 50),
          // F15: the interaction path it took and why
          via:
            (typeof record?.via === "string" ? record.via : null) ??
            row?.via ??
            null,
          detail:
            (typeof record?.detail === "string" ? record.detail : null) ??
            row?.detail ??
            null,
        }
      : null,
    lastScreenshot: exists(model.latestScreenshot?.path ?? null),
    diagnostics,
    outcomes: failedOutcomes,
    precondition: failedPrecondition
      ? {
          name: failedPrecondition.name,
          exitCode: failedPrecondition.exitCode,
          durationMs: failedPrecondition.durationMs,
          timedOut: failedPrecondition.timedOut,
          outputTail: failedPrecondition.outputTail,
          logPath:
            failedPrecondition.logPath &&
            fileSet.has(failedPrecondition.logPath)
              ? failedPrecondition.logPath
              : null,
        }
      : null,
    hooks: failedHooks.map((entry) => {
      const inJournal = Boolean(
        entry.logPath && journalLogs?.has(entry.logPath),
      );
      return {
        hook: entry.hook,
        index: entry.index,
        command: entry.command,
        exitCode: entry.exitCode,
        durationMs: entry.durationMs,
        timedOut: Boolean(entry.timedOut),
        outputTail: entry.outputTail,
        logPath:
          inJournal || (entry.logPath && fileSet.has(entry.logPath))
            ? entry.logPath
            : null,
        logSource: inJournal ? "invocation" : null,
      };
    }),
    servicesLogs: files
      .map((entry) => entry.path)
      .filter((entry) => entry.startsWith("services/")),
    gate: failedGate
      ? {
          name: failedGate.name,
          scope: failedGate.scope,
          status: failedGate.status,
          budgetMs: failedGate.budgetMs,
          durationMs: failedGate.durationMs,
          attempts: failedGate.attempts,
          lastDetail: failedGate.lastDetail,
          timedOut: failedGate.timedOut,
          cancelled: failedGate.cancelled,
          attemptLog: failedGate.attemptLog.slice(-15),
        }
      : null,
    expect: failedExpect,
    teardown: failedTeardown.map((entry) => ({
      index: entry.index,
      stepId: entry.stepId,
      kind: entry.kind,
      label: entry.label,
      error: entry.error,
      timedOut: entry.timedOut,
      durationMs: entry.durationMs,
    })),
  };
}

/**
 * run.json `teardown` (when the runner records one):
 * `[{index, stepId, kind, status, durationMs, error?}]`.
 * @param {any} value
 * @returns {Array<{ index: number | null, stepId: string | null, kind: string | null, status: string, durationMs: number | null, error: string | null }> | null}
 */
function normalizeTeardownRecord(value) {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.items)
      ? value.items
      : null;
  if (!list) return null;
  return list
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 200)
    .map((entry) => ({
      index: typeof entry.index === "number" ? entry.index : null,
      stepId: typeof entry.stepId === "string" ? entry.stepId : null,
      kind: typeof entry.kind === "string" ? entry.kind : null,
      status: typeof entry.status === "string" ? entry.status : "unknown",
      durationMs:
        typeof entry.durationMs === "number" ? entry.durationMs : null,
      error: typeof entry.error === "string" ? entry.error : null,
    }));
}

/**
 * The invocation journal a run belongs to: `run.json` (or, for a run killed
 * before writing it, `run.started`) names `invocation.id`, and the journal
 * sits next to the run under the artifact root. Null when the run carries no
 * link, the id is malformed, or the folder is gone (a restored stash).
 * @param {string} runDir
 * @param {Record<string, any> | null} [run] parsed run.json
 * @param {Array<Record<string, any>>} [events] the run's events
 * @returns {{ id: string, dir: string } | null}
 */
function runJournal(runDir, run, events) {
  const started = (
    events ?? readEventsFrom(runDir, 0, LIVENESS_WINDOW_BYTES).events
  ).find((event) => event?.type === "run.started");
  const ref =
    invocationRef(run?.invocation) ?? invocationRef(started?.invocation);
  if (!ref || !isInvocationId(ref.id)) return null;
  const dir = safeJoin(
    path.dirname(path.resolve(runDir)),
    path.join(INVOCATIONS_DIR, ref.id),
  );
  if (!dir) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { id: ref.id, dir };
}

/**
 * Absolute journal directory of a run (see `runJournal`), reading run.json
 * itself; for the IPC that serves hook logs.
 * @param {string} runDir
 * @returns {string | null}
 */
function runJournalDir(runDir) {
  return (
    runJournal(runDir, readJsonFile(path.join(runDir, "run.json")))?.dir ?? null
  );
}

/**
 * @param {unknown} value
 * @returns {value is number} a 1-based `--repeat`/`--matrix` iteration
 */
function isIteration(value) {
  return typeof value === "number" && value > 0;
}

/**
 * The hook executions that belong to one run. The runner writes `hook.*`
 * only to the invocation journal's events.ndjson: an `--after` hook carries
 * the `runId` it ran for; a `--before` hook runs once per invocation, or
 * once per iteration under `--repeat`/`--matrix` (`iteration`), before
 * that iteration's runs start. Log paths are relative to the journal folder.
 * @param {string} runDir
 * @param {Record<string, any> | null} run parsed run.json
 * @param {Array<Record<string, any>>} events the run's own events
 * @returns {{ invocationId: string, before: Array<Record<string, any>>, after: Array<Record<string, any>>, logs: Array<{ path: string, bytes: number }> } | null}
 */
function readRunHooks(runDir, run, events) {
  const journal = runJournal(runDir, run, events);
  if (!journal) return null;
  const started = events.find((event) => event?.type === "run.started");
  const runId =
    (typeof run?.runId === "string" && run.runId) ||
    (typeof started?.runId === "string" && started.runId) ||
    path.basename(runDir);
  const hookEvents = readEventsFrom(
    journal.dir,
    0,
    8 * 1024 * 1024,
  ).events.filter(
    (event) =>
      event?.type === "hook.started" || event?.type === "hook.finished",
  );
  const after = hookEvents.filter(
    (event) => event.hook === "after" && event.runId === runId,
  );
  const beforeAll = hookEvents.filter((event) => event.hook === "before");
  // The run's iteration: from its own after hooks, else the iteration of
  // the last before hook that started before the run did.
  let iteration = after.find((event) =>
    isIteration(event.iteration),
  )?.iteration;
  if (!isIteration(iteration)) {
    const startedAtMs =
      Date.parse(String(started?.ts ?? "")) ||
      runIdTimestampMs(parseRunId(runId).startedAt);
    iteration = beforeAll
      .filter(
        (event) =>
          event.type === "hook.started" &&
          isIteration(event.iteration) &&
          Number.isFinite(startedAtMs) &&
          Date.parse(String(event.ts)) <= /** @type {number} */ (startedAtMs),
      )
      .at(-1)?.iteration;
  }
  const before = beforeAll.filter(
    (event) =>
      !isIteration(iteration) ||
      !isIteration(event.iteration) ||
      event.iteration === iteration,
  );
  /** @type {Array<{ path: string, bytes: number }>} */
  const logs = [];
  for (const event of [...before, ...after]) {
    const rel = typeof event.logPath === "string" ? event.logPath : null;
    if (!rel || logs.some((entry) => entry.path === rel)) continue;
    const absolute = safeJoin(journal.dir, rel);
    if (!absolute) continue;
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile()) logs.push({ path: rel, bytes: stat.size });
    } catch {
      // not written (yet)
    }
  }
  return { invocationId: journal.id, before, after, logs };
}

/** Journal event types the run-policy panel reads (besides services.*). */
const POLICY_EVENT_PATTERN =
  /^(run\.lock\.|preflight\.|cleanliness\.|finally\.|suite\.|metric\.sampled$|invocation\.bailed$|services\.teardown\.)/;

/**
 * What the run policy did to the invocation a run belongs to, from its
 * journal: the config `run:` lock, preflight checks, cleanliness (verifyClean)
 * findings, `finally` hooks, `--bail`, the suite and its hooks, and the
 * settled summary's `runPolicy` / `skipped` / exit code. These describe the
 * whole invocation (the run is one spec of it). Null when the journal holds
 * none of it, so a run from before the run policy shows no panel.
 * @param {string | null | undefined} journalDir
 * @returns {{ invocationId: string, suite: string | null, summary: { runPolicy: Record<string, any> | null, skipped: number | null, exitCode: number | null, error: string | null }, policy: Record<string, any>, services: Array<Record<string, any>> } | null}
 */
function readRunPolicy(journalDir) {
  if (!journalDir) return null;
  const journal = readJsonFile(path.join(journalDir, "invocation.json"));
  const events = readEventsFrom(journalDir, 0, 8 * 1024 * 1024).events.filter(
    (event) => POLICY_EVENT_PATTERN.test(String(event?.type ?? "")),
  );
  const model = CairnEvents.reduceEvents(events);
  const policy = model.policy;
  const summary =
    journal?.summary && typeof journal.summary === "object"
      ? journal.summary
      : null;
  const runPolicy =
    summary?.runPolicy && typeof summary.runPolicy === "object"
      ? summary.runPolicy
      : null;
  const suite =
    typeof journal?.suite === "string"
      ? journal.suite
      : (policy.suite?.name ?? null);
  const notable =
    Boolean(policy.lock) ||
    policy.preflight.checks.length > 0 ||
    policy.cleanliness.length > 0 ||
    policy.finally.length > 0 ||
    Boolean(policy.bailed) ||
    Boolean(policy.suite) ||
    policy.suiteHooks.length > 0 ||
    Boolean(runPolicy) ||
    (typeof summary?.skipped === "number" && summary.skipped > 0);
  if (!notable) return null;
  return {
    invocationId:
      typeof journal?.invocationId === "string"
        ? journal.invocationId
        : path.basename(journalDir),
    suite,
    summary: {
      runPolicy,
      skipped: typeof summary?.skipped === "number" ? summary.skipped : null,
      exitCode: Number.isInteger(summary?.exitCode) ? summary.exitCode : null,
      error: typeof summary?.error === "string" ? summary.error : null,
    },
    policy,
    // only the critical teardown failures are of interest here
    services: model.services.filter(
      (/** @type {Record<string, any>} */ row) =>
        row.phase === "teardown" && row.event === "fail",
    ),
  };
}

/**
 * A `stash-receipt.json` as Studio shows it: the original four fields plus
 * whatever the 2b contract adds (contentHash, fileCount, sizeBytes,
 * expiresAt, tags, excluded, secretsFound), only when present. Null when it
 * names no stash.
 * @param {any} receipt
 * @returns {Record<string, any> | null}
 */
function normalizeStashReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    typeof receipt.stashId !== "string"
  )
    return null;
  return {
    stashId: receipt.stashId,
    status: typeof receipt.status === "string" ? receipt.status : null,
    recordedAt:
      typeof receipt.recordedAt === "string" ? receipt.recordedAt : null,
    postSaveFailureCount:
      typeof receipt.postSaveFailureCount === "number"
        ? receipt.postSaveFailureCount
        : null,
    ...(typeof receipt.action === "string" ? { action: receipt.action } : {}),
    ...CairnEvents.stashExtras(receipt),
  };
}

/**
 * Local runs that carry a `stash-receipt.json`, newest first: how the
 * Stashes view links a file.cheap stash back to the run it came from (and
 * shows the receipt's excluded members, secret findings, TTL and tags).
 * @param {string} runsRoot
 * @param {{ scanLimit?: number }} [options]
 * @returns {Array<{ stashId: string, runId: string, runDir: string, spec: string, status: string | null, pinned: boolean, receipt: Record<string, any> }>}
 */
function listStashReceipts(runsRoot, options = {}) {
  const scanLimit = options.scanLimit ?? 600;
  const out = [];
  for (const runId of listRunIds(runsRoot).slice(0, scanLimit)) {
    const runDir = path.join(runsRoot, runId);
    const receipt = normalizeStashReceipt(
      readJsonFile(path.join(runDir, "stash-receipt.json")),
    );
    if (!receipt) continue;
    const record = readJsonFile(path.join(runDir, "run.json"));
    out.push({
      stashId: receipt.stashId,
      runId,
      runDir,
      spec: record?.spec?.name ?? parseRunId(runId).spec ?? runId,
      status: typeof record?.status === "string" ? record.status : null,
      pinned: Boolean(evidence.normalizePinned(record?.pinned)),
      receipt,
    });
  }
  return out;
}

/**
 * Full detail for one run directory: the run payload, per-outcome evidence
 * text, the manifest grouping, the reduced event stream (plus the run's
 * hooks from its invocation journal), the failure panel, and the files that
 * exist on disk.
 * @param {string} runDir
 * @param {{ evidenceLimit?: number }} [options]
 */
function readRunDetail(runDir, options = {}) {
  const run = readJsonFile(path.join(runDir, "run.json"));
  const manifest = readJsonFile(path.join(runDir, "artifact-manifest.json"));
  const report = readJsonFile(path.join(runDir, "report.json"));
  const receipt = readJsonFile(path.join(runDir, "stash-receipt.json"));
  const evidenceLimit = options.evidenceLimit ?? 64_000;

  const outcomes = [];
  for (const outcome of Array.isArray(run?.outcomes) ? run.outcomes : []) {
    if (!outcome || typeof outcome !== "object") continue;
    const evidenceRel =
      typeof outcome.evidence === "string" ? outcome.evidence : null;
    const rawRel =
      typeof outcome.evidenceRaw === "string" ? outcome.evidenceRaw : null;
    const rawFile = rawRel ? safeJoin(runDir, rawRel) : null;
    outcomes.push({
      id: String(outcome.id ?? "unknown"),
      status: String(outcome.status ?? "unknown"),
      evidence: evidenceRel,
      evidenceText: evidenceText(runDir, evidenceRel, evidenceLimit),
      evidenceRaw: rawRel,
      evidenceRawText: evidenceText(runDir, rawRel, evidenceLimit),
      // datasource / value / http / table / network evidence as tables,
      // plus the poll attempt log (null for free-form raw evidence)
      data: rawFile
        ? dataEvidence.normalizeRawEvidence(
            dataEvidence.readJsonBounded(rawFile),
          )
        : null,
    });
  }

  const events = readEventsFrom(runDir, 0, 8 * 1024 * 1024).events;
  const hooks = readRunHooks(runDir, run, events);
  const policyJournal = runJournal(runDir, run, events);
  const model = CairnEvents.reduceEvents(
    hooks ? [...hooks.before, ...events, ...hooks.after] : events,
  );
  const journalLogs = new Set((hooks?.logs ?? []).map((entry) => entry.path));
  for (const row of model.hooks)
    row.logSource =
      row.logPath && journalLogs.has(row.logPath) ? "invocation" : null;
  const files = listRunFiles(runDir, 1500);
  const expects = dataEvidence.readExpects(runDir);
  const captures = dataEvidence.readCaptures(runDir);
  const videos = files
    .filter((entry) => entry.kind === "video")
    .map((entry) => ({ path: entry.path, bytes: entry.bytes }));
  const traces = files
    .filter(
      (entry) =>
        entry.path.startsWith("traces/") ||
        (typeof run?.artifacts?.trace === "string" &&
          entry.path === run.artifacts.trace),
    )
    .map((entry) => sniffArtifact(runDir, entry.path));

  return {
    runDir,
    runId: run?.runId ?? path.basename(runDir),
    run,
    report,
    manifest,
    outcomes,
    steps: Array.isArray(run?.steps) ? run.steps : [],
    artifacts: groupArtifacts(manifest),
    eventsModel: model,
    eventCount: events.length,
    // F16 expect verdicts and captured values (expects/, captures/)
    expects,
    captures,
    // F15 widget fields (widgets/) and F18 request envelopes (requests/),
    // summarized and masked
    widgets: dataEvidence.readWidgets(runDir),
    requests: dataEvidence.readRequests(runDir),
    // F3b: the run's fixture ledger (fixtures.json), outputs masked
    fixtures: dataEvidence.readRunFixtures(runDir),
    // F3a: run.json `teardown` when the runner records it, else null
    // (the events model carries the teardown items either way)
    teardown: normalizeTeardownRecord(run?.teardown),
    failure: buildFailurePanel(
      runDir,
      run,
      model,
      outcomes,
      files,
      journalLogs,
      expects,
    ),
    journal: hooks
      ? { invocationId: hooks.invocationId, logs: hooks.logs }
      : null,
    // F8 run policy of the run's invocation, and F11 metric probes
    runPolicy: readRunPolicy(policyJournal?.dir ?? null),
    metrics: metrics.readRunMetrics(runDir),
    stashReceipt: normalizeStashReceipt(receipt),
    publishReceipt: evidence.readPublishReceipt(runDir),
    pinned: evidence.normalizePinned(run?.pinned),
    // run.json's refusal block, else the run.refused event's; a refused
    // status with neither still gets an (empty) refusal panel.
    refusal:
      CairnPolicy.normalizeRefusal(run?.refusal) ??
      CairnPolicy.normalizeRefusal(model.refusal) ??
      (run?.status === "refused"
        ? { reason: null, env: null, requires: null, requiresText: null }
        : null),
    logs: files.filter((entry) => entry.path.startsWith("logs/")),
    servicesFiles: files.filter((entry) => entry.path.startsWith("services/")),
    hasRunLog: files.some((entry) => entry.path === "run.log"),
    videos,
    traces,
    hasReportHtml: fs.existsSync(path.join(runDir, "report.html")),
    hasAgentContext: fs.existsSync(path.join(runDir, "agent_context.md")),
    hasEvents: fs.existsSync(path.join(runDir, "events.ndjson")),
    hasVideo: Boolean(run?.artifacts?.video) || videos.length > 0,
    hasTrace: Boolean(run?.artifacts?.trace) || traces.length > 0,
  };
}

/**
 * Does this buffer look like binary (a NUL byte in the sampled prefix)?
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

/**
 * Read a text artifact with a byte bound; longer files are truncated and
 * flagged. Media and binary files are refused — they never render as text.
 * @param {string} runDir
 * @param {string} relativePath
 * @param {number} [maxBytes]
 * @returns {{ ok: boolean, text: string | null, truncated: boolean, bytes: number, binary?: boolean, error?: string }}
 */
function readBoundedText(
  runDir,
  relativePath,
  maxBytes = DEFAULT_MAX_TEXT_BYTES,
) {
  const absolute = safeJoin(runDir, relativePath);
  if (!absolute)
    return {
      ok: false,
      text: null,
      truncated: false,
      bytes: 0,
      error: "path escapes run directory",
    };
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    return {
      ok: false,
      text: null,
      truncated: false,
      bytes: 0,
      error: String(error?.message ?? error),
    };
  }
  if (!stat.isFile())
    return {
      ok: false,
      text: null,
      truncated: false,
      bytes: stat.size,
      error: "not a file",
    };
  const kind = classifyArtifact(relativePath);
  if (kind === "image" || kind === "video" || kind === "binary")
    return {
      ok: false,
      text: null,
      truncated: false,
      bytes: stat.size,
      binary: true,
      error: `${kind} artifact — not readable as text`,
    };
  const readBytes = Math.min(stat.size, Math.max(0, maxBytes));
  let text = "";
  let fd;
  try {
    fd = fs.openSync(absolute, "r");
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, 0);
    if (looksBinary(buffer))
      return {
        ok: false,
        text: null,
        truncated: false,
        bytes: stat.size,
        binary: true,
        error: "binary content — not readable as text",
      };
    text = buffer.toString("utf8");
  } catch (error) {
    return {
      ok: false,
      text: null,
      truncated: false,
      bytes: stat.size,
      error: String(error?.message ?? error),
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { ok: true, text, truncated: stat.size > readBytes, bytes: stat.size };
}

/**
 * Incremental tail of a growing text file (precondition/outcome/hook/service
 * logs). Offset 0 starts at the last `maxBytes`; a later call returns what
 * was appended since, skipping ahead (flagged) when it fell further behind
 * than `maxBytes`. A shrunk file (rotated/truncated) restarts at its tail.
 * @param {string} baseDir
 * @param {string} relativePath
 * @param {number} [offset]
 * @param {number} [maxBytes]
 * @returns {{ ok: boolean, text: string, offset: number, size: number, skipped: boolean, reset: boolean, missing: boolean, error?: string }}
 */
function readTextFrom(baseDir, relativePath, offset = 0, maxBytes = 64 * 1024) {
  const absolute = safeJoin(baseDir, relativePath);
  const empty = {
    ok: false,
    text: "",
    offset: Math.max(0, offset),
    size: 0,
    skipped: false,
    reset: false,
    missing: false,
  };
  if (!absolute) return { ...empty, error: "path escapes its directory" };
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { ...empty, ok: true, missing: true };
  }
  if (!stat.isFile()) return { ...empty, error: "not a file" };
  let start = Math.max(0, Number(offset) || 0);
  let reset = false;
  if (start > stat.size) {
    start = 0;
    reset = true;
  }
  let skipped = false;
  if (start === 0 || stat.size - start > maxBytes) {
    const tailStart = Math.max(0, stat.size - maxBytes);
    if (tailStart > start) {
      skipped = start > 0 || tailStart > 0;
      start = tailStart;
    }
  }
  const length = stat.size - start;
  if (length <= 0)
    return {
      ok: true,
      text: "",
      offset: start,
      size: stat.size,
      skipped,
      reset,
      missing: false,
    };
  let fd;
  try {
    fd = fs.openSync(absolute, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    if (looksBinary(buffer))
      return {
        ...empty,
        size: stat.size,
        error: "binary content — not readable as text",
      };
    return {
      ok: true,
      text: buffer.toString("utf8"),
      offset: stat.size,
      size: stat.size,
      skipped,
      reset,
      missing: false,
    };
  } catch (error) {
    return { ...empty, error: String(error?.message ?? error) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Identify what a trace/archive artifact actually is from its first bytes:
 * Playwright traces are zips; agent-browser writes Chrome trace JSON (which
 * may carry a .zip name, or be empty).
 * @param {string} runDir
 * @param {string} relativePath
 * @returns {{ path: string, bytes: number, kind: "playwright-zip" | "chrome-trace-json" | "empty" | "unknown" | "missing" }}
 */
function sniffArtifact(runDir, relativePath) {
  const absolute = safeJoin(runDir, relativePath);
  if (!absolute) return { path: relativePath, bytes: 0, kind: "missing" };
  let fd;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile())
      return { path: relativePath, bytes: 0, kind: "missing" };
    if (stat.size === 0) return { path: relativePath, bytes: 0, kind: "empty" };
    fd = fs.openSync(absolute, "r");
    const head = Buffer.alloc(Math.min(stat.size, 64));
    fs.readSync(fd, head, 0, head.length, 0);
    if (
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      head[2] === 0x03 &&
      head[3] === 0x04
    )
      return { path: relativePath, bytes: stat.size, kind: "playwright-zip" };
    const text = head.toString("utf8").trimStart();
    if (text.startsWith("{") || text.startsWith("["))
      return {
        path: relativePath,
        bytes: stat.size,
        kind: "chrome-trace-json",
      };
    return { path: relativePath, bytes: stat.size, kind: "unknown" };
  } catch {
    return { path: relativePath, bytes: 0, kind: "missing" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read a binary artifact as a data URL (screenshots).
 * @param {string} runDir
 * @param {string} relativePath
 * @param {number} [maxBytes]
 * @returns {{ ok: boolean, dataUrl: string | null, mime: string | null, bytes: number, error?: string }}
 */
function readAsDataUrl(
  runDir,
  relativePath,
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
) {
  const absolute = safeJoin(runDir, relativePath);
  if (!absolute)
    return {
      ok: false,
      dataUrl: null,
      mime: null,
      bytes: 0,
      error: "path escapes run directory",
    };
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (error) {
    return {
      ok: false,
      dataUrl: null,
      mime: null,
      bytes: 0,
      error: String(error?.message ?? error),
    };
  }
  if (!stat.isFile())
    return {
      ok: false,
      dataUrl: null,
      mime: null,
      bytes: stat.size,
      error: "not a file",
    };
  if (classifyArtifact(relativePath) !== "image")
    return {
      ok: false,
      dataUrl: null,
      mime: null,
      bytes: stat.size,
      error: "not an image artifact",
    };
  if (stat.size > maxBytes)
    return {
      ok: false,
      dataUrl: null,
      mime: null,
      bytes: stat.size,
      error: `artifact exceeds ${maxBytes} bytes`,
    };
  const mime = mimeFor(absolute);
  try {
    const data = fs.readFileSync(absolute);
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
      mime,
      bytes: stat.size,
    };
  } catch (error) {
    return {
      ok: false,
      dataUrl: null,
      mime: null,
      bytes: stat.size,
      error: String(error?.message ?? error),
    };
  }
}

/**
 * @param {string} file
 * @returns {string}
 */
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".json":
    case ".ndjson":
      return "application/json";
    case ".html":
      return "text/html";
    case ".md":
      return "text/markdown";
    case ".webm":
      return "video/webm";
    case ".mp4":
      return "video/mp4";
    case ".zip":
      return "application/zip";
    default:
      return "text/plain";
  }
}

/**
 * Classify an artifact path for the UI: which viewer should open it.
 * @param {string} relativePath
 * @returns {"image" | "text" | "json" | "ndjson" | "html" | "video" | "binary"}
 */
function classifyArtifact(relativePath) {
  const ext = path.extname(String(relativePath ?? "")).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ext === ".ndjson") return "ndjson";
  if (ext === ".json") return "json";
  if (ext === ".html") return "html";
  if (TEXT_EXTENSIONS.has(ext) || ext === "") return "text";
  return "binary";
}

/**
 * Read `events.ndjson` from a byte offset — the live-progress feed for a run
 * that is still executing. Works for any directory holding an events file
 * (run dirs and invocation journals).
 * @param {string} runDir
 * @param {number} [offset]
 * @param {number} [maxBytes]
 * @returns {{ events: Array<Record<string, unknown>>, offset: number, missing: boolean }}
 */
function readEventsFrom(runDir, offset = 0, maxBytes = DEFAULT_MAX_TEXT_BYTES) {
  const absolute = path.join(runDir, "events.ndjson");
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { events: [], offset, missing: true };
  }
  const start = Math.max(0, Math.min(offset, stat.size));
  const readBytes = Math.min(stat.size - start, maxBytes);
  if (readBytes <= 0) return { events: [], offset: start, missing: false };
  let fd;
  try {
    fd = fs.openSync(absolute, "r");
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, start);
    const lines = buffer.toString("utf8").split("\n");
    const events = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") events.push(parsed);
      } catch {
        // partial trailing line — it will re-read on the next poll
      }
    }
    // Only advance past whole lines so a partial write is retried next poll.
    const consumed = buffer.toString("utf8");
    const lastNewline = consumed.lastIndexOf("\n");
    const nextOffset =
      lastNewline === -1
        ? start
        : start + Buffer.byteLength(consumed.slice(0, lastNewline + 1), "utf8");
    return { events, offset: nextOffset, missing: false };
  } catch {
    return { events: [], offset: start, missing: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * List files in a run directory (bounded walk).
 * @param {string} runDir
 * @param {number} [maxEntries]
 * @returns {Array<{ path: string, bytes: number, kind: "image" | "text" | "json" | "ndjson" | "html" | "video" | "binary" }>}
 */
function listRunFiles(runDir, maxEntries = 500) {
  const out = [];
  const walk = (dir, prefix) => {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (out.length >= maxEntries) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        // ignore unreadable entry
      }
      out.push({ path: rel, bytes, kind: classifyArtifact(rel) });
    }
  };
  walk(runDir, "");
  return out;
}

module.exports = {
  normalizeStashReceipt,
  listStashReceipts,
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_STALE_MS,
  DEFAULT_RUNNING_WINDOW_MS,
  RUN_DIR_PATTERN,
  INVOCATIONS_DIR,
  INVOCATION_ID_PATTERN,
  isRunDirName,
  isInvocationId,
  safeJoin,
  isWithin,
  readJsonFile,
  readTextFileOrNull,
  listRunIds,
  isPidAlive,
  lastActivityMs,
  readEventsWindow,
  runLiveness,
  delegatedRunOwner,
  summarizeRun,
  parseLabelFilters,
  listRuns,
  listRunLabels,
  listRunSpecs,
  listDetectedRuns,
  specDurationHistory,
  runHistory,
  median,
  looksLikeRunDir,
  resolveRunRef,
  groupArtifacts,
  evidenceText,
  parseOutcomeEvidence,
  summarizeDiagnostics,
  buildFailurePanel,
  runJournalDir,
  readRunHooks,
  readRunPolicy,
  readRunDetail,
  readBoundedText,
  readTextFrom,
  sniffArtifact,
  readAsDataUrl,
  mimeFor,
  classifyArtifact,
  readEventsFrom,
  listRunFiles,
};
