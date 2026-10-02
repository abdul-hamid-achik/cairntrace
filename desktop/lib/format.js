/**
 * Shared presentation helpers.
 *
 * Loaded twice on purpose: the Electron main process and the node:test suites
 * `require()` it, and the renderer includes it as a classic script where the
 * same functions land on `window.CairnFormat`. One copy means the CLI-side and
 * UI-side renderings of a duration or status never drift apart.
 */

const STATUS_TONES = {
  passed: "ok",
  pass: "ok",
  ok: "ok",
  success: "ok",
  ready: "ok",
  skipped: "muted",
  skip: "muted",
  unknown: "muted",
  interrupted: "warn",
  // Refused by the environment policy before anything ran: not a failure,
  // so it has a tone of its own instead of "bad".
  refused: "refused",
  failed: "bad",
  fail: "bad",
  errored: "bad",
  error: "bad",
  missing: "bad",
};

/**
 * @param {number | undefined | null} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * @param {number | undefined | null} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
    return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * @param {string | undefined | null} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * @param {string | number | Date | undefined | null} value
 * @param {Date} [now]
 * @returns {string}
 */
function relativeTime(value, now = new Date()) {
  if (value === undefined || value === null || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return String(value);
  const deltaSeconds = Math.round((now.getTime() - time) / 1000);
  const future = deltaSeconds < 0;
  const abs = Math.abs(deltaSeconds);
  /** @type {string} */
  let label;
  if (abs < 45) label = `${abs}s`;
  else if (abs < 90) label = "1m";
  else if (abs < 45 * 60) label = `${Math.round(abs / 60)}m`;
  else if (abs < 90 * 60) label = "1h";
  else if (abs < 24 * 3600) label = `${Math.round(abs / 3600)}h`;
  else if (abs < 48 * 3600) label = "1d";
  else if (abs < 30 * 24 * 3600) label = `${Math.round(abs / 86400)}d`;
  else if (abs < 365 * 24 * 3600) label = `${Math.round(abs / (30 * 86400))}mo`;
  else label = `${Math.round(abs / (365 * 24 * 3600))}y`;
  return future ? `in ${label}` : `${label} ago`;
}

/**
 * Map a cairn status word onto a CSS tone class.
 * @param {string | undefined | null} status
 * @returns {string}
 */
function statusTone(status) {
  if (!status) return "muted";
  return STATUS_TONES[String(status).toLowerCase()] ?? "muted";
}

/**
 * Run directory names embed the spec name and a random suffix:
 * `<iso-ish>_<spec>_<hex>`.
 * @param {string} runId
 * @returns {{ startedAt: string | null, spec: string | null, suffix: string | null }}
 */
function parseRunId(runId) {
  const match = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_(.*)_([0-9a-f]{4,})$/.exec(
    String(runId ?? ""),
  );
  if (!match) return { startedAt: null, spec: null, suffix: null };
  return {
    startedAt: match[1] ?? null,
    spec: match[2] ?? null,
    suffix: match[3] ?? null,
  };
}

/**
 * `<iso-ish>` prefix of a run id as UTC epoch millis.
 * @param {string | null} value e.g. `2026-08-06T19-27-11-803Z`
 * @returns {number | null}
 */
function runIdTimestampMs(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(
      String(value ?? ""),
    );
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {string} value
 * @param {number} [max]
 * @returns {string}
 */
function truncate(value, max = 160) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Collapse the whitespace runs that make NDJSON/log tails hard to scan.
 * @param {string} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function titleCase(value) {
  const text = String(value ?? "").trim();
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * Percent (0-100, one decimal) of `part` over `total`, or null when total is 0.
 * @param {number} part
 * @param {number} total
 * @returns {number | null}
 */
function percent(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0)
    return null;
  return Math.round((part / total) * 1000) / 10;
}

const CairnFormat = {
  STATUS_TONES,
  formatDuration,
  formatBytes,
  formatTimestamp,
  relativeTime,
  statusTone,
  parseRunId,
  runIdTimestampMs,
  truncate,
  oneLine,
  titleCase,
  percent,
};

if (typeof module === "object" && module.exports) module.exports = CairnFormat;
if (typeof globalThis === "object" && globalThis)
  globalThis.CairnFormat = CairnFormat;
