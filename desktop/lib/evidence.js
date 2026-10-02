/**
 * Evidence actions on one run: publish to file.cheap, pin against retention.
 *
 * Studio never talks to fcheap or edits run.json itself. It spawns the same
 * commands an agent would (`cairn publish <runDir> --json`, `cairn pin
 * <runDir> [--reason=<text>] --json`, `cairn unpin <runDir> --json`) and
 * reads what the CLI wrote back: `publish-receipt.json` and run.json's
 * `pinned` block. This module owns those argv builders (a run reference is an
 * absolute directory, never something that reads as a flag) and the readers
 * that turn the CLI's files into display shapes.
 *
 * Contract (2b, additive):
 *   publish-receipt.json { version: 1, artifactRef, sha256, sizeBytes,
 *                          publishedAt, expiresAt?, webUrl?, excluded?,
 *                          runIndexSkipped? }
 *   run.json             pinned?: { at, reason? }
 */
const fs = require("node:fs");
const path = require("node:path");

/** Longest pin reason Studio passes on (the CLI may bound it further). */
const MAX_PIN_REASON = 200;
/** Longest web URL Studio will open. */
const MAX_WEB_URL = 2048;
/** `publish-receipt.json` `runIndexSkipped` values the CLI writes. */
const RUN_INDEX_SKIPPED_CODES = ["unsupported", "too-large", "build-failed"];

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function str(value) {
  return typeof value === "string" && value.length ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A run directory as a CLI argument: absolute, and never readable as a flag.
 * @param {unknown} runDir
 * @returns {string}
 */
function runDirArg(runDir) {
  const value = String(runDir ?? "");
  if (!value || !path.isAbsolute(value))
    throw new Error("run directory must be absolute");
  return path.resolve(value);
}

/**
 * A pin reason the CLI can take as one argv entry: trimmed, one line, no
 * control characters, bounded. Empty means "no reason".
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanPinReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("pin reason must be text");
  const oneLine = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine) return null;
  if (oneLine.length > MAX_PIN_REASON)
    throw new Error(`pin reason is longer than ${MAX_PIN_REASON} characters`);
  return oneLine;
}

/**
 * `cairn publish <runDir> --json`
 * @param {string} runDir
 * @returns {string[]}
 */
function buildPublishArgv(runDir) {
  return ["publish", runDirArg(runDir), "--json"];
}

/**
 * `cairn pin <runDir> [--reason=<text>] --json`. The reason is joined to its
 * flag (`--reason=…`) so a reason starting with "-" is still a value.
 * @param {string} runDir
 * @param {{ reason?: string | null }} [options]
 * @returns {string[]}
 */
function buildPinArgv(runDir, options = {}) {
  const argv = ["pin", runDirArg(runDir)];
  const reason = cleanPinReason(options.reason);
  if (reason) argv.push(`--reason=${reason}`);
  argv.push("--json");
  return argv;
}

/**
 * `cairn unpin <runDir> --json`
 * @param {string} runDir
 * @returns {string[]}
 */
function buildUnpinArgv(runDir) {
  return ["unpin", runDirArg(runDir), "--json"];
}

/**
 * A web URL Studio may open in the browser: the CLI's own receipt rule
 * (`isStableHttpsUrl`: https, a host, no credentials, no query string or
 * fragment — never a signed URL), bounded. Anything else is null (no
 * button, no open).
 * @param {unknown} value
 * @returns {string | null}
 */
function safeWebUrl(value) {
  const text = str(value);
  if (!text || text.length > MAX_WEB_URL) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  // `?` / `#` alone parse to an empty search/hash: reject the raw text too
  if (parsed.search || parsed.hash || /[?#]/.test(text)) return null;
  return parsed.toString();
}

/**
 * run.json's `pinned` block, or null when the run is not pinned.
 * @param {unknown} raw
 * @returns {{ at: string | null, reason: string | null } | null}
 */
function normalizePinned(raw) {
  if (raw === true) return { at: null, reason: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, any>} */ (raw);
  return {
    at: str(record.at),
    reason: str(record.reason)
      ? String(record.reason).replace(/\s+/g, " ").trim().slice(0, 400)
      : null,
  };
}

/**
 * The `artifactRef` of a receipt as text: a string as-is, else the
 * artifact-ref:v1 URI / id.
 * @param {unknown} ref
 * @returns {string | null}
 */
function artifactRefText(ref) {
  if (typeof ref === "string") return ref.length ? ref.slice(0, 300) : null;
  if (!ref || typeof ref !== "object") return null;
  const record = /** @type {Record<string, any>} */ (ref);
  return str(record.uri) ?? str(record.artifact_id) ?? str(record.id) ?? null;
}

/**
 * A `publish-receipt.json` document as Studio shows it, or null when it is
 * not one. `webUrl` survives only when it is a safe https URL.
 * @param {unknown} raw
 * @returns {{ ok: true, status: "published", artifactRef: string | null, sha256: string | null, sizeBytes: number | null, publishedAt: string | null, expiresAt: string | null, webUrl: string | null, excluded: string[], runIndexSkipped: string | null } | null}
 */
function normalizePublishReceipt(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, any>} */ (raw);
  const artifactRef = artifactRefText(record.artifactRef);
  if (!artifactRef) return null;
  return {
    ok: true,
    status: "published",
    artifactRef,
    sha256: str(record.sha256),
    sizeBytes: num(record.sizeBytes),
    publishedAt: str(record.publishedAt),
    expiresAt: str(record.expiresAt),
    webUrl: safeWebUrl(record.webUrl),
    // members the evidence gate left out of the package (`traces/`)
    excluded: Array.isArray(record.excluded)
      ? record.excluded
          .filter((entry) => typeof entry === "string" && entry)
          .slice(0, 50)
      : [],
    // why no RunIndexV1 sidecar was sent: the console does not list the run
    runIndexSkipped: RUN_INDEX_SKIPPED_CODES.includes(record.runIndexSkipped)
      ? record.runIndexSkipped
      : null,
  };
}

/**
 * The run's `publish-receipt.json`, normalized, or null.
 * @param {string} runDir
 */
function readPublishReceipt(runDir) {
  return normalizePublishReceipt(
    readJson(path.join(runDir, "publish-receipt.json")),
  );
}

/**
 * Remote retention for a published package, from the project config
 * (`retention.publish.retentionDays`, default 7, 1–31) — what the confirm
 * dialog tells the user before an upload.
 * @param {Record<string, any> | null | undefined} retention config `retention`
 * @returns {number}
 */
function publishRetentionDays(retention) {
  const days = retention?.publish?.retentionDays;
  return Number.isInteger(days) && days >= 1 && days <= 31 ? days : 7;
}

/**
 * What `cairn clean` uploads for every run it prunes, from the project
 * config: an archive to the stash (`retention.archiveToStash`) and/or a
 * publication (`retention.publish.enabled`, kept `retentionDays`).
 * @param {Record<string, any> | null | undefined} retention config `retention`
 * @returns {{ archive: boolean, publish: boolean, days: number, any: boolean }}
 */
function retentionUploads(retention) {
  const archive = retention?.archiveToStash === true;
  const publish = retention?.publish?.enabled === true;
  return {
    archive,
    publish,
    days: publishRetentionDays(retention),
    any: archive || publish,
  };
}

/**
 * One sentence naming those uploads, or null when pruning uploads nothing.
 * @param {ReturnType<typeof retentionUploads>} uploads
 * @returns {string | null}
 */
function retentionUploadText(uploads) {
  if (!uploads?.any) return null;
  const what = [
    uploads.archive ? "archives it to your file.cheap stash" : null,
    uploads.publish
      ? `publishes it to file.cheap, kept ${uploads.days} day${
          uploads.days === 1 ? "" : "s"
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return `Before deleting each pruned run, cairn clean ${what} (retention.${
    uploads.archive && uploads.publish
      ? "archiveToStash and retention.publish.enabled"
      : uploads.archive
        ? "archiveToStash"
        : "publish.enabled"
  } in the project config).`;
}

module.exports = {
  MAX_PIN_REASON,
  cleanPinReason,
  buildPublishArgv,
  buildPinArgv,
  buildUnpinArgv,
  safeWebUrl,
  normalizePinned,
  normalizePublishReceipt,
  readPublishReceipt,
  publishRetentionDays,
  retentionUploads,
  retentionUploadText,
  artifactRefText,
};
