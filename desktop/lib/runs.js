/**
 * Read-side helpers over the cairn artifact root.
 *
 * Everything here is read-only and defensive: a run directory can be missing
 * `run.json` (a run killed by a signal), truncated, or still being written by
 * a live run. The desktop app must render what exists instead of throwing, and
 * must never let a renderer-supplied relative path escape the run directory.
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseRunId } = require("./format");

const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
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
 * chronological one.
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
    .filter((name) => !name.startsWith("."))
    .toSorted((a, b) => b.localeCompare(a));
}

/**
 * @typedef {object} RunSummary
 * @property {string} runId
 * @property {string} dir
 * @property {string} spec
 * @property {string | null} specPath
 * @property {string} status
 * @property {string | null} summary
 * @property {Record<string, any> | null} failure
 * @property {string | null} startedAt
 * @property {string | null} endedAt
 * @property {number | null} durationMs
 * @property {string | null} backend
 * @property {string | null} environment
 * @property {boolean} coldStart
 * @property {Record<string, string> | null} labels
 * @property {number | null} exitCode
 * @property {boolean} interrupted
 * @property {number} mtimeMs
 * @property {{ total: number, passed: number, failed: number }} outcomes
 * @property {Record<string, any> | null} artifacts
 */

/**
 * @param {string} runsRoot
 * @param {string} runId
 * @returns {RunSummary}
 */
function summarizeRun(runsRoot, runId) {
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
  return {
    runId,
    dir,
    spec: record?.spec?.name ?? parsed.spec ?? runId,
    specPath: record?.spec?.path ?? null,
    status: record?.status ?? "interrupted",
    summary: record?.summary ?? null,
    failure: record?.failure ?? null,
    startedAt: record?.startedAt ?? null,
    endedAt: record?.endedAt ?? null,
    durationMs:
      typeof record?.durationMs === "number" ? record.durationMs : null,
    backend: record?.backend ?? null,
    environment: record?.environment ?? null,
    coldStart: Boolean(record?.coldStart),
    labels: record?.labels ?? null,
    exitCode: record?.exitCode ?? null,
    interrupted: !record || !record.status,
    mtimeMs,
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
 * @param {string} runsRoot
 * @param {{ limit?: number, status?: string | null, spec?: string | null, search?: string | null }} [options]
 * @returns {Array<ReturnType<typeof summarizeRun>>}
 */
function listRuns(runsRoot, options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  const status = options.status?.trim().toLowerCase() || null;
  const spec = options.spec?.trim().toLowerCase() || null;
  const search = options.search?.trim().toLowerCase() || null;
  const out = [];
  for (const runId of listRunIds(runsRoot)) {
    if (out.length >= limit) break;
    const summary = summarizeRun(runsRoot, runId);
    if (status && String(summary.status).toLowerCase() !== status) continue;
    if (spec && String(summary.spec).toLowerCase() !== spec) continue;
    if (search) {
      const haystack =
        `${summary.runId} ${summary.spec} ${summary.summary ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    out.push(summary);
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
 * Resolve `latest`, `previous`, a run id, or an absolute run directory.
 * @param {string} runsRoot
 * @param {string} ref
 * @returns {string | null} absolute run directory
 */
function resolveRunRef(runsRoot, ref) {
  const value = String(ref ?? "").trim();
  if (!value) return null;
  if (path.isAbsolute(value))
    return fs.existsSync(path.join(value, "run.json")) || fs.existsSync(value)
      ? value
      : null;
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
 * Full detail for one run directory: the run payload, per-outcome evidence
 * text, the manifest grouping, and the files that exist on disk.
 * @param {string} runDir
 * @param {{ evidenceLimit?: number }} [options]
 */
function readRunDetail(runDir, options = {}) {
  const run = readJsonFile(path.join(runDir, "run.json"));
  const manifest = readJsonFile(path.join(runDir, "artifact-manifest.json"));
  const report = readJsonFile(path.join(runDir, "report.json"));
  const evidenceLimit = options.evidenceLimit ?? 64_000;

  const outcomes = [];
  for (const outcome of Array.isArray(run?.outcomes) ? run.outcomes : []) {
    if (!outcome || typeof outcome !== "object") continue;
    const evidenceRel =
      typeof outcome.evidence === "string" ? outcome.evidence : null;
    const rawRel =
      typeof outcome.evidenceRaw === "string" ? outcome.evidenceRaw : null;
    outcomes.push({
      id: String(outcome.id ?? "unknown"),
      status: String(outcome.status ?? "unknown"),
      evidence: evidenceRel,
      evidenceText: evidenceText(runDir, evidenceRel, evidenceLimit),
      evidenceRaw: rawRel,
      evidenceRawText: evidenceText(runDir, rawRel, evidenceLimit),
    });
  }

  return {
    runDir,
    runId: run?.runId ?? path.basename(runDir),
    run,
    report,
    manifest,
    outcomes,
    steps: Array.isArray(run?.steps) ? run.steps : [],
    artifacts: groupArtifacts(manifest),
    hasReportHtml: fs.existsSync(path.join(runDir, "report.html")),
    hasAgentContext: fs.existsSync(path.join(runDir, "agent_context.md")),
    hasEvents: fs.existsSync(path.join(runDir, "events.ndjson")),
    hasVideo: Boolean(run?.artifacts?.video),
    hasTrace: Boolean(run?.artifacts?.trace),
  };
}

/**
 * Read a text artifact with a byte bound; longer files are truncated and flagged.
 * @param {string} runDir
 * @param {string} relativePath
 * @param {number} [maxBytes]
 * @returns {{ ok: boolean, text: string | null, truncated: boolean, bytes: number, error?: string }}
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
  const readBytes = Math.min(stat.size, maxBytes);
  let text = "";
  let fd;
  try {
    fd = fs.openSync(absolute, "r");
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, 0);
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
 * Read a binary artifact as a data URL (screenshots, videos frames).
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
  if (ext === ".webm" || ext === ".mp4") return "video";
  if (ext === ".ndjson") return "ndjson";
  if (ext === ".json") return "json";
  if (ext === ".html") return "html";
  if (TEXT_EXTENSIONS.has(ext) || ext === "") return "text";
  return "binary";
}

/**
 * Read `events.ndjson` from a byte offset — the live-progress feed for a run
 * that is still executing.
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
 * List files in a run directory (bounded, one level deep plus known subdirs).
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
  DEFAULT_MAX_TEXT_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  safeJoin,
  readJsonFile,
  readTextFileOrNull,
  listRunIds,
  summarizeRun,
  listRuns,
  listRunSpecs,
  resolveRunRef,
  groupArtifacts,
  evidenceText,
  readRunDetail,
  readBoundedText,
  readAsDataUrl,
  mimeFor,
  classifyArtifact,
  readEventsFrom,
  listRunFiles,
};
