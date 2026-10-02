/**
 * Structured evidence the wave-4 verifiers and steps write into a run
 * directory, normalized into shapes the renderer can lay out as tables:
 *
 * - `outcomes/<id>.raw.json` of the datasource / value / http / table /
 *   network verifiers (and SDK script verifiers that polled):
 *   `{kind, source?, request, observed, attempts?, polledMs?}` — the runner
 *   bounds `observed` (≤20 rows, ≤4KB per row, a `truncated` flag);
 * - `expects/NNN_<id>.json` (the `expect` step's verdict);
 * - `captures/<assign>.json` (the `capture` step's value);
 * - `fixtures.json` (the run's fixture ledger) and the per-project
 *   `~/.cairntrace/fixtures/<project>.ledger.jsonl` (folded into the live
 *   state per environment and fixture, like `cairn fixtures status`).
 *
 * Main process only. The runner redacts these files before they land; this
 * module still never passes on a credential-shaped value (a secret-looking
 * key, URI userinfo, a Basic/Bearer header value, a JWT), and every shape is
 * optional: an older or unknown file degrades to "no table", never an error.
 */
const fs = require("node:fs");
const path = require("node:path");

const CairnEvents = require("./events");

/** Cells per row and characters per cell in a rendered table. */
const MAX_COLUMNS = 12;
const MAX_ROWS = 50;
const MAX_CELL_CHARS = 160;
/** A JSON preview (request, a scalar/object observation). */
const MAX_PREVIEW_CHARS = 2400;
/** Attempts kept for the timeline (the runner keeps first 5 + last 15). */
const MAX_ATTEMPTS = 60;
/** Biggest evidence JSON file read whole. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** Expect / capture files listed per run. */
const MAX_STEP_FILES = 300;
/** Tail of a fixtures ledger read for the latest state per fixture. */
const MAX_LEDGER_BYTES = 512 * 1024;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
 * A URL safe to show: userinfo masked, the query string dropped (its values
 * are where tokens hide). `${secrets.X}` placeholders stay as written.
 * @param {unknown} value
 * @returns {string | null}
 */
function redactUrl(value) {
  const text = str(value);
  if (!text) return null;
  const match =
    /^([a-z][a-z0-9+.-]*:\/\/)(?:([^@/?#]*)@)?([^?#]*)(\?[^#]*)?/i.exec(text);
  if (!match) return CairnEvents.maskValue(null, text, 300);
  const [, scheme, userinfo, rest, query] = match;
  return `${scheme}${userinfo ? "***@" : ""}${rest ?? ""}${query ? "?…" : ""}`;
}

/**
 * Deep copy with every secret-looking key's value replaced (for previews);
 * the event reducer's (lib/events.js), so cells, outputs and previews mask
 * alike.
 */
const maskDeep = CairnEvents.maskDeep;

/**
 * A bounded, masked JSON preview of a value.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string | null}
 */
function preview(value, max = MAX_PREVIEW_CHARS) {
  if (value === undefined) return null;
  let text;
  try {
    text = JSON.stringify(maskDeep(value), null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) return null;
  return text.length > max
    ? `${text.slice(0, max)}\n… (cut at ${max} chars)`
    : text;
}

/**
 * One table cell as a single line.
 * @param {string} column
 * @param {unknown} value
 * @returns {string}
 */
function cell(column, value) {
  if (value === undefined) return "";
  return CairnEvents.maskValue(column, value, MAX_CELL_CHARS);
}

/**
 * @typedef {{
 *   columns: string[],
 *   rows: string[][],
 *   shown: number,
 *   total: number | null,
 *   truncated: boolean,
 *   cutBy: "runner" | "studio" | null,
 *   hiddenColumns: number,
 *   unit: string,
 * }} EvidenceTable
 */

/**
 * Who cut a table, and the total to name: the runner (it flagged the
 * evidence truncated, or counted more than it kept) or Studio (more rows
 * than MAX_ROWS in the file; the total is then what the file holds).
 * @param {number} kept rows in the evidence
 * @param {number} shown rows Studio lays out
 * @param {{ total?: number | null, truncated?: boolean }} options
 * @returns {{ total: number | null, truncated: boolean, cutBy: "runner" | "studio" | null }}
 */
function cutOf(kept, shown, options) {
  const counted =
    options.total !== null && options.total !== undefined
      ? options.total
      : null;
  const byRunner =
    Boolean(options.truncated) || (counted !== null && counted > kept);
  const byStudio = kept > shown;
  return {
    total: counted ?? (byStudio ? kept : null),
    truncated: byRunner || byStudio,
    cutBy: byStudio ? "studio" : byRunner ? "runner" : null,
  };
}

/**
 * Objects as a table: columns are the keys in first-seen order (`_id` and
 * the usual identity fields first), at most MAX_COLUMNS of them.
 * @param {unknown[]} list
 * @param {{ total?: number | null, truncated?: boolean, unit?: string, prefer?: string[] }} [options]
 * @returns {EvidenceTable | null}
 */
function tableFromObjects(list, options = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  const records = list.filter(isRecord);
  if (records.length !== list.length) return null;
  /** @type {string[]} */
  const keys = [];
  for (const prefer of options.prefer ?? ["_id", "id"])
    if (records.some((record) => prefer in record)) keys.push(prefer);
  for (const record of records)
    for (const key of Object.keys(record))
      if (!keys.includes(key)) keys.push(key);
  const columns = keys.slice(0, MAX_COLUMNS);
  // A bounded row the runner cut at 4KB is `{truncated, bytes, preview}`.
  const rows = records
    .slice(0, MAX_ROWS)
    .map((record) => columns.map((column) => cell(column, record[column])));
  return {
    columns,
    rows,
    shown: rows.length,
    ...cutOf(records.length, rows.length, options),
    hiddenColumns: Math.max(0, keys.length - columns.length),
    unit: options.unit ?? "rows",
  };
}

/**
 * `{headers, rows: string[][]}` (the table verifier, a captured table).
 * @param {unknown} headers
 * @param {unknown} rows
 * @param {{ total?: number | null, truncated?: boolean }} [options]
 * @returns {EvidenceTable | null}
 */
function tableFromGrid(headers, rows, options = {}) {
  if (!Array.isArray(rows)) return null;
  const head = Array.isArray(headers)
    ? headers.map((entry) => String(entry))
    : [];
  const shownRows = rows.slice(0, MAX_ROWS);
  // A loop, not Math.max(...rows): a hand-made file with ~125k rows would
  // overflow the call stack.
  let width = head.length;
  for (const row of shownRows)
    width = Math.max(width, Array.isArray(row) ? row.length : 1);
  const columns = Array.from(
    { length: Math.min(width, MAX_COLUMNS) },
    (_, index) => head[index] || `#${index + 1}`,
  );
  const out = shownRows.map((row) =>
    columns.map((column, index) =>
      cell(column, Array.isArray(row) ? row[index] : index === 0 ? row : ""),
    ),
  );
  return {
    columns,
    rows: out,
    shown: out.length,
    ...cutOf(rows.length, out.length, options),
    hiddenColumns: Math.max(0, width - columns.length),
    unit: "rows",
  };
}

/**
 * `tableFromValue` that degrades to "no table" instead of throwing on a
 * malformed or oversized hand-made file.
 * @param {unknown} value
 * @param {{ total?: number | null, truncated?: boolean }} [options]
 * @returns {EvidenceTable | null}
 */
function safeTableFromValue(value, options = {}) {
  try {
    return tableFromValue(value, options);
  } catch {
    return null;
  }
}

/**
 * The best table for an arbitrary observed value: an array of objects, a
 * `{headers, rows}` grid, or an object holding one array of objects.
 * @param {unknown} value
 * @param {{ total?: number | null, truncated?: boolean }} [options]
 * @returns {EvidenceTable | null}
 */
function tableFromValue(value, options = {}) {
  if (Array.isArray(value)) return tableFromObjects(value, options);
  if (isRecord(value)) {
    if (
      Array.isArray(value.rows) &&
      (Array.isArray(value.headers) || value.rows.every(Array.isArray))
    )
      return tableFromGrid(value.headers, value.rows, {
        total: num(value.rowCount) ?? options.total ?? null,
        truncated: Boolean(value.truncated) || Boolean(options.truncated),
      });
    const arrays = Object.entries(value).filter(
      ([, item]) => Array.isArray(item) && item.length && item.every(isRecord),
    );
    if (arrays.length === 1)
      return tableFromObjects(arrays[0][1], {
        ...options,
        unit: arrays[0][0],
      });
  }
  return null;
}

/**
 * The source a verifier read, by its descriptor (never a URI).
 * @param {unknown} source
 * @returns {{ name: string | null, kind: string | null, text: string, facts: Array<[string, string]> } | null}
 */
function normalizeSource(source) {
  if (!isRecord(source)) return null;
  const name = str(source.name);
  const kind = str(source.kind);
  /** @type {Array<[string, string]>} */
  const facts = [];
  const add = (/** @type {string} */ label, /** @type {unknown} */ value) => {
    if (value === null || value === undefined || value === "") return;
    facts.push([
      label,
      Array.isArray(value) ? value.join(", ") : String(value),
    ]);
  };
  add("transport", str(source.transport));
  add("database", str(source.database));
  add("hosts", Array.isArray(source.hosts) ? source.hosts.map(String) : null);
  add("compose service", str(source.service));
  add("container", str(source.container));
  add("mode", str(source.mode));
  add("namespace", str(source.namespace));
  add("api", redactUrl(source.api));
  add("baseUrl", redactUrl(source.baseUrl));
  const where =
    kind === "mongo"
      ? [
          str(source.service)
            ? `compose service ${source.service}`
            : str(source.container)
              ? `container ${source.container}`
              : Array.isArray(source.hosts) && source.hosts.length
                ? source.hosts.join(",")
                : null,
          str(source.database) ? `db ${source.database}` : null,
          str(source.mode) === "read-only" ? "read-only" : null,
        ]
      : kind === "temporal"
        ? [
            str(source.namespace) ? `namespace ${source.namespace}` : null,
            redactUrl(source.api),
          ]
        : kind === "http"
          ? [redactUrl(source.baseUrl)]
          : [];
  const text = [
    [kind, name].filter(Boolean).join(" "),
    ...where.filter(Boolean),
  ]
    .filter(Boolean)
    .join(" · ");
  return { name, kind, text: text || "source", facts };
}

/**
 * `{at, ok, summary}` attempt records (typed `poll` and SDK `ctx.poll`), with
 * an offset from the first attempt.
 * @param {unknown} list
 * @returns {Array<{ at: string | null, ok: boolean, summary: string, offsetMs: number | null }> | null}
 */
function normalizeAttempts(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const parsed = list.slice(0, MAX_ATTEMPTS).map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const at =
      typeof record.at === "number"
        ? new Date(record.at).toISOString()
        : str(record.at);
    return {
      at,
      ok: record.ok === true,
      summary: CairnEvents.maskValue(
        null,
        record.summary ?? record.detail ?? record.message ?? "",
        300,
      ),
      atMs: at ? Date.parse(at) : Number.NaN,
    };
  });
  const first = parsed.find((entry) => Number.isFinite(entry.atMs))?.atMs;
  return parsed.map((entry) => ({
    at: entry.at,
    ok: entry.ok,
    summary: entry.summary,
    offsetMs:
      first !== undefined && Number.isFinite(entry.atMs)
        ? Math.max(0, entry.atMs - first)
        : null,
  }));
}

/**
 * @typedef {{
 *   kind: string,
 *   source: ReturnType<typeof normalizeSource>,
 *   request: string | null,
 *   facts: Array<[string, string]>,
 *   table: EvidenceTable | null,
 *   value: string | null,
 *   truncated: boolean,
 *   note: string | null,
 *   attempts: ReturnType<typeof normalizeAttempts>,
 *   attemptCount: number | null,
 *   polledMs: number | null,
 * }} DataEvidence
 */

/**
 * Normalize a parsed `outcomes/<id>.raw.json`. Null when the file carries
 * none of the structured fields (a plain script verifier's free-form raw
 * evidence keeps its JSON view only), and when a malformed file would
 * throw: an unknown file degrades to "no table", never an error.
 * @param {unknown} raw
 * @returns {DataEvidence | null}
 */
function normalizeRawEvidence(raw) {
  try {
    return normalizeRawEvidenceOf(raw);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {DataEvidence | null}
 */
function normalizeRawEvidenceOf(raw) {
  if (!isRecord(raw)) return null;
  const kind = str(raw.kind) ?? "evidence";
  const observed = raw.observed;
  const attempts = normalizeAttempts(raw.attempts);
  // The attempt log is bounded (first 5 + last 15): its length is not the
  // count. Only an explicit `attemptCount` (SDK polls) is; typed verifiers
  // carry theirs on the outcome.* event.
  const attemptCount = num(raw.attemptCount);
  const polledMs = num(raw.polledMs);
  const structured =
    str(raw.kind) !== null &&
    ("observed" in raw || "request" in raw || "source" in raw);
  if (!structured && !attempts && observed === undefined) return null;

  /** @type {Array<[string, string]>} */
  const facts = [];
  /** @type {EvidenceTable | null} */
  let table = null;
  /** @type {string | null} */
  let value = null;
  let truncated = false;
  /** @type {string | null} */
  let note = null;
  const fact = (/** @type {string} */ label, /** @type {unknown} */ item) => {
    if (item === null || item === undefined || item === "") return;
    facts.push([label, CairnEvents.maskValue(label, item, 300)]);
  };

  const obs = isRecord(observed) ? observed : null;
  switch (kind) {
    case "mongo": {
      fact("count", num(obs?.count));
      truncated = Boolean(obs?.truncated);
      table = tableFromObjects(Array.isArray(obs?.docs) ? obs.docs : [], {
        total: num(obs?.count),
        truncated,
        unit: "documents",
      });
      if (obs && Array.isArray(obs.docs) && !obs.docs.length)
        note = "no matching documents";
      break;
    }
    case "temporal": {
      if (obs && "workflow" in obs) {
        const workflow = isRecord(obs.workflow) ? obs.workflow : null;
        if (!workflow) note = "workflow not found (describe answered 404)";
        for (const key of [
          "workflowId",
          "runId",
          "status",
          "type",
          "startTime",
          "closeTime",
          "historyLength",
          "pendingActivities",
          "pendingChildren",
        ])
          fact(key, workflow?.[key]);
      } else if (obs) {
        fact("count", num(obs.count));
        truncated = Boolean(obs.truncated);
        table = tableFromObjects(
          Array.isArray(obs.executions) ? obs.executions : [],
          {
            total: num(obs.count),
            truncated,
            unit: "executions",
            prefer: ["workflowId", "runId", "status", "type"],
          },
        );
      }
      const history = isRecord(obs?.history) ? obs.history : null;
      if (history) {
        if (Array.isArray(history.runs))
          fact(
            "history runs",
            history.runs
              .map((run) =>
                isRecord(run)
                  ? `${run.runId ?? "?"} (${run.events ?? "?"} events)`
                  : String(run),
              )
              .join(", "),
          );
        fact("input bytes", num(history.inputBytes));
        const scheduled = Array.isArray(history.scheduledActivities)
          ? history.scheduledActivities.map(String)
          : [];
        const completed = new Set(
          Array.isArray(history.completedActivities)
            ? history.completedActivities.map(String)
            : [],
        );
        const unsuccessful = new Set(
          Array.isArray(history.unsuccessfulActivities)
            ? history.unsuccessfulActivities.map(String)
            : [],
        );
        const attemptsByType = isRecord(history.maxAttempts)
          ? history.maxAttempts
          : {};
        const names = [
          ...new Set([
            ...scheduled,
            ...completed,
            ...unsuccessful,
            ...Object.keys(attemptsByType),
          ]),
        ];
        // With a describe there is no executions table: the activities are.
        if (!table && names.length)
          table = {
            columns: ["activity", "completed", "unsuccessful", "max attempt"],
            rows: names
              .slice(0, MAX_ROWS)
              .map((name) => [
                cell("activity", name),
                completed.has(name) ? "yes" : "no",
                unsuccessful.has(name) ? "yes" : "no",
                attemptsByType[name] === undefined
                  ? "—"
                  : String(attemptsByType[name]),
              ]),
            shown: Math.min(names.length, MAX_ROWS),
            total: names.length,
            truncated: names.length > MAX_ROWS,
            cutBy: names.length > MAX_ROWS ? "studio" : null,
            hiddenColumns: 0,
            unit: "activities",
          };
      }
      break;
    }
    case "http": {
      fact("status", num(obs?.status));
      fact("bytes", num(obs?.bytes));
      truncated = Boolean(obs?.truncated);
      if (obs && "body" in obs) {
        table = tableFromValue(obs.body, { truncated });
        if (!table) value = preview(obs.body);
      }
      break;
    }
    case "value": {
      truncated = Boolean(obs?.truncated);
      if (obs && "value" in obs) {
        table = tableFromValue(obs.value, { truncated });
        if (!table) value = preview(obs.value);
      }
      break;
    }
    case "table": {
      truncated = Boolean(obs?.truncated);
      if (obs) {
        fact("rows", num(obs.rowCount));
        table = tableFromGrid(obs.headers, obs.rows, {
          total: num(obs.rowCount),
          truncated,
        });
        if (table && !table.rows.length) note = "the table had no rows";
      } else note = "no table matched the locator";
      break;
    }
    case "network": {
      fact("candidates", num(obs?.candidates));
      fact("matching", num(obs?.matching));
      truncated = Boolean(obs?.truncated);
      table = tableFromObjects(
        Array.isArray(obs?.requests) ? obs.requests : [],
        {
          total: num(obs?.matching),
          truncated,
          unit: "requests",
          prefer: ["method", "url", "status", "at"],
        },
      );
      if (isRecord(raw.assign))
        fact(
          "assign",
          `${raw.assign.name ?? "?"}${
            str(raw.assign.at) ? ` · at ${raw.assign.at}` : ""
          }${
            num(raw.assign.count) !== null ? ` · count ${raw.assign.count}` : ""
          }`,
        );
      break;
    }
    default: {
      // SDK verifiers (`ctx.poll` timeouts) and anything newer: a message,
      // an observation, maybe an attempt log.
      fact("message", str(raw.message));
      if (observed !== undefined) {
        truncated = Boolean(obs?.truncated);
        table = tableFromValue(observed, { truncated });
        if (!table) value = preview(observed);
      }
    }
  }
  if (table?.truncated) truncated = true;

  return {
    kind,
    source: normalizeSource(raw.source),
    request: raw.request === undefined ? null : preview(raw.request, 1600),
    facts,
    table,
    value,
    truncated,
    note,
    attempts,
    attemptCount,
    polledMs,
  };
}

/**
 * Read and parse a JSON file inside a run directory (bounded); null when it
 * is missing, too big or not JSON.
 * @param {string} file
 * @returns {unknown}
 */
function readJsonBounded(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Join a run-relative path, refusing anything outside the run directory.
 * @param {string} runDir
 * @param {string} relative
 * @returns {string | null}
 */
function insideRun(runDir, relative) {
  const base = path.resolve(runDir);
  const target = path.resolve(base, relative);
  return target.startsWith(`${base}${path.sep}`) ? target : null;
}

/**
 * `<folder>/*.json` inside a run directory, sorted, bounded.
 * @param {string} runDir
 * @param {string} folder
 * @returns {string[]} run-relative paths
 */
function jsonFilesIn(runDir, folder) {
  try {
    return fs
      .readdirSync(path.join(runDir, folder), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => `${folder}/${entry.name}`)
      .toSorted()
      .slice(0, MAX_STEP_FILES);
  } catch {
    return [];
  }
}

/**
 * The run's `expects/*.json` verdicts, in step order.
 * @param {string} runDir
 */
function readExpects(runDir) {
  return jsonFilesIn(runDir, "expects").map((file) => {
    const target = insideRun(runDir, file);
    const doc = target ? readJsonBounded(target) : null;
    const record = isRecord(doc) ? doc : {};
    const observed = record.observed;
    const table =
      observed === undefined ? null : safeTableFromValue(observed, {});
    return {
      path: file,
      id: str(record.id) ?? path.basename(file, ".json"),
      stepId: str(record.stepId),
      status: str(record.status) ?? "unknown",
      kind: str(record.kind),
      expected: typeof record.expected === "string" ? record.expected : null,
      actual: typeof record.actual === "string" ? record.actual : null,
      attempts: num(record.attempts),
      durationMs: num(record.durationMs),
      table,
      observed:
        observed === undefined || table ? null : preview(observed, 1600),
      readable: isRecord(doc),
    };
  });
}

/**
 * The run's `captures/*.json` values (masked previews / tables). A capture
 * whose `assign` name looks like a credential (`apiToken`, `csrfToken`)
 * shows no value at all: the runner records captured page text as is.
 * @param {string} runDir
 */
function readCaptures(runDir) {
  return jsonFilesIn(runDir, "captures").map((file) => {
    const target = insideRun(runDir, file);
    const doc = target ? readJsonBounded(target) : null;
    const record = isRecord(doc) ? doc : {};
    const assign = str(record.assign) ?? path.basename(file, ".json");
    const masked =
      record.value !== undefined && CairnEvents.isSecretKey(assign);
    const table =
      record.value === undefined || masked
        ? null
        : safeTableFromValue(record.value, {});
    return {
      path: file,
      assign,
      kind: str(record.kind),
      table,
      value: masked
        ? "••••••"
        : record.value === undefined || table
          ? null
          : preview(record.value, 1600),
      masked,
      readable: isRecord(doc),
    };
  });
}

/**
 * A `{status, at, error?}` verb record of a run ledger entry.
 * @param {unknown} value
 * @returns {{ status: string, at: string | null, error: string | null } | null}
 */
function ledgerVerb(value) {
  if (!isRecord(value)) return null;
  return {
    status: str(value.status) ?? "unknown",
    at: str(value.at),
    error: str(value.error)
      ? CairnEvents.maskValue(null, value.error, 400)
      : null,
  };
}

/**
 * One `<runDir>/fixtures.json` entry: `{name, adapter, scope, ensuredAt?,
 * outputs, status?, reason?, reset?, teardown?}` (src/core/fixtures/schema.ts
 * RunFixtureLedgerEntrySchema), outputs masked.
 * @param {unknown} entry
 */
function normalizeLedgerEntry(entry) {
  if (!isRecord(entry)) return null;
  const name = str(entry.name);
  if (!name) return null;
  return {
    name,
    adapter: str(entry.adapter),
    scope: str(entry.scope),
    ensuredAt: str(entry.ensuredAt),
    status: str(entry.status),
    reason: str(entry.reason)
      ? CairnEvents.maskValue(null, entry.reason, 300)
      : null,
    outputs: CairnEvents.safeOutputs(entry.outputs) ?? [],
    reset: ledgerVerb(entry.reset),
    teardown: ledgerVerb(entry.teardown),
  };
}

/**
 * `<runDir>/fixtures.json`: `{version: 1, entries: [...]}`, or null.
 * @param {string} runDir
 */
function readRunFixtures(runDir) {
  const doc = readJsonBounded(path.join(runDir, "fixtures.json"));
  if (!isRecord(doc)) return null;
  const entries = (Array.isArray(doc.entries) ? doc.entries : [])
    .map(normalizeLedgerEntry)
    .filter(Boolean)
    .slice(0, 500);
  return { version: num(doc.version) ?? str(doc.version), entries };
}

/**
 * @typedef {{
 *   env: string, name: string, adapter: string | null, scope: string | null,
 *   instance: string | null,
 *   state: "live" | "failed" | "torn-down" | "released",
 *   fromReset: boolean,
 *   ensuredAt: string | null, expiresAt: string | null, ttlMs: number | null,
 *   lastVerb: string | null, lastStatus: string | null, lastAt: string | null,
 *   lastError: string | null, origin: string | null, runId: string | null,
 *   outputs: Array<[string, string]>,
 * }} FixtureLiveState
 */

/**
 * Fold project ledger records into the live state per (environment,
 * fixture) — per instance for a run-scoped fixture — the way `cairn
 * fixtures status` does (src/core/fixtures/ledger.ts foldLedger): dry-run,
 * skipped and verify lines change nothing, except a skipped teardown that
 * released an adopted fixture (`released`); an ensure makes it live (or
 * failed); a successful teardown tears it down; a failed teardown or a
 * reset keeps the state and records the attempt; an ok reset of a fixture
 * with no state yet makes it live (a reset-only fixture, `fromReset`).
 * @param {Array<Record<string, any>>} records oldest first
 * @returns {FixtureLiveState[]}
 */
function foldLedgerRecords(records) {
  /** @type {Map<string, FixtureLiveState>} */
  const states = new Map();
  for (const record of records) {
    const name = str(record.name);
    const verb = str(record.verb);
    const status = str(record.status);
    if (!name || !verb || !status) continue;
    const released =
      verb === "teardown" && status === "skipped" && record.released === true;
    if (!released && (status === "dry-run" || status === "skipped")) continue;
    if (verb === "verify") continue;
    const env = str(record.env) ?? "?";
    const scope = str(record.scope);
    const instance = scope === "run" ? str(record.instance) : null;
    const key =
      instance === null
        ? `${env}\u0000${name}`
        : `${env}\u0000${name}\u0000${instance}`;
    const previous = states.get(key) ?? null;
    const at = str(record.ts);
    const empty = {
      fromReset: false,
      ensuredAt: null,
      ttlMs: null,
      expiresAt: null,
      outputs: [],
    };
    const base = {
      env,
      name,
      instance,
      adapter: str(record.adapter) ?? previous?.adapter ?? null,
      scope: str(record.scope) ?? previous?.scope ?? null,
      lastVerb: verb,
      lastStatus: status,
      lastAt: at,
      lastError: str(record.error)
        ? CairnEvents.maskValue(null, record.error, 400)
        : null,
      origin: str(record.origin),
      runId: str(record.runId),
    };
    if (verb === "ensure") {
      const ttlMs = num(record.ttlMs);
      states.set(key, {
        ...base,
        state: status === "ok" ? "live" : "failed",
        fromReset: false,
        ensuredAt: at,
        ttlMs,
        expiresAt:
          ttlMs !== null && at && Number.isFinite(Date.parse(at))
            ? new Date(Date.parse(at) + ttlMs).toISOString()
            : null,
        outputs: CairnEvents.safeOutputs(record.outputs) ?? [],
      });
      continue;
    }
    if (verb === "teardown" && (released || status === "ok")) {
      states.set(key, {
        ...empty,
        ...previous,
        ...base,
        state: released ? "released" : "torn-down",
      });
      continue;
    }
    if (previous)
      states.set(key, { ...previous, ...base, state: previous.state });
    else if (verb === "teardown")
      states.set(key, { ...empty, ...base, state: "failed" });
    else if (verb === "reset" && status === "ok")
      // a reset-only fixture is "ensured" by its reset
      states.set(key, {
        ...empty,
        ...base,
        state: "live",
        fromReset: true,
        ensuredAt: at,
      });
  }
  return [...states.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.env.localeCompare(b.env),
  );
}

/**
 * The live state per (environment, fixture) from a project ledger
 * (`~/.cairntrace/fixtures/<project>.ledger.jsonl`, one record per verb,
 * appended). Reads the file's tail only; a torn or invalid line is skipped.
 * @param {string} file
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ path: string, exists: boolean, entries: FixtureLiveState[], lines: number, partial: boolean }}
 */
function readFixtureLedger(file, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_LEDGER_BYTES;
  /** @type {Array<Record<string, any>>} */
  const records = [];
  let lines = 0;
  let partial = false;
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile())
      return { path: file, exists: false, entries: [], lines: 0, partial };
    const length = Math.min(stat.size, maxBytes);
    partial = stat.size > maxBytes;
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    let text = buffer.toString("utf8");
    // A tail read starts mid-line: drop that partial first line.
    if (partial) text = text.slice(text.indexOf("\n") + 1);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // a torn line (crash mid-append)
      }
    }
  } catch {
    return { path: file, exists: false, entries: [], lines: 0, partial: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return {
    path: file,
    exists: true,
    entries: foldLedgerRecords(records),
    lines,
    partial,
  };
}

module.exports = {
  MAX_COLUMNS,
  MAX_ROWS,
  normalizeRawEvidence,
  normalizeAttempts,
  normalizeSource,
  tableFromObjects,
  tableFromGrid,
  tableFromValue,
  readJsonBounded,
  readExpects,
  readCaptures,
  readRunFixtures,
  readFixtureLedger,
  foldLedgerRecords,
  normalizeLedgerEntry,
  redactUrl,
  maskDeep,
  preview,
};
