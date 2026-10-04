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
 * - `widgets/NNN_<id>.json` (F15: a set / check / choose / form step's
 *   per-field expected vs committed values, driver and failures, plus the
 *   unanswered-fields dump) and `requests/<assign>.json` (F18: status,
 *   retry / poll attempts, captures, matrix combinations);
 * - the xlsx verifier's raw sidecar (F17: sheets, header columns and every
 *   check it ran);
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
/** One widgets/ or requests/ file at most (the runner bounds values). */
const MAX_STEP_FILE_BYTES = 512 * 1024;
/** All widgets/ (or requests/) files of one run together. */
const MAX_STEP_EVIDENCE_BYTES = 8 * 1024 * 1024;
/** Widget fields listed per step file. */
const MAX_WIDGET_FIELDS = 100;
/** Matrix combinations listed per request (the schema allows 200). */
const MAX_MATRIX_ROWS = 200;

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
 *   checks?: EvidenceCheck[] | null,
 * }} DataEvidence
 * @typedef {{ ok: boolean | null, label: string, detail: string | null }} EvidenceCheck
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
  if (isXlsxRaw(raw)) return normalizeXlsxEvidence(raw);
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

// ── F17 xlsx verifier evidence ────────────────────────────────────────────

/**
 * The xlsx verifier's raw sidecar: `{path, sheets, sheet?, columns?,
 * checks}` (no `kind`; a poll adds `attempts` / `polledMs`).
 * @param {Record<string, any>} raw
 * @returns {boolean}
 */
function isXlsxRaw(raw) {
  return (
    (str(raw.kind) === null || raw.kind === "xlsx") &&
    Array.isArray(raw.checks) &&
    Array.isArray(raw.sheets)
  );
}

/**
 * @param {unknown} list
 * @param {number} [max]
 * @returns {string}
 */
function listText(list, max = 12) {
  const items = Array.isArray(list)
    ? list.map((item) =>
        typeof item === "string" ? item : CairnEvents.maskValue(null, item, 80),
      )
    : [];
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, … +${items.length - max}` : shown;
}

/**
 * One xlsx check as display lines (a headers or rows block holds several).
 * @param {unknown} check
 * @returns {EvidenceCheck[]}
 */
function xlsxChecks(check) {
  if (!isRecord(check)) return [];
  /** @type {EvidenceCheck[]} */
  const out = [];
  const line = (
    /** @type {boolean | null} */ ok,
    /** @type {string} */ label,
    /** @type {string | null} */ detail = null,
  ) =>
    out.push({
      ok,
      label: CairnEvents.maskValue(null, label, 300),
      detail: detail ? CairnEvents.maskValue(null, detail, 600) : null,
    });
  if (Array.isArray(check.contains) && "scope" in check) {
    const missing = Array.isArray(check.missingText) ? check.missingText : [];
    line(
      missing.length === 0,
      `${str(check.scope) ?? "workbook"} contains ${listText(check.contains)}`,
      missing.length ? `missing ${listText(missing)}` : null,
    );
  } else if ("sheet" in check && "found" in check && !("cell" in check)) {
    const missing = Array.isArray(check.missingText) ? check.missingText : [];
    if (check.found === false)
      line(false, `sheet ${check.sheet}`, "no such sheet");
    else
      line(
        missing.length === 0,
        `sheet ${check.sheet}${
          Array.isArray(check.contains) && check.contains.length
            ? ` contains ${listText(check.contains)}`
            : ""
        }`,
        missing.length ? `missing ${listText(missing)}` : null,
      );
  } else if (isRecord(check.headers)) {
    const headers = check.headers;
    const rows = `label row ${headers.labelRow ?? 1}${
      headers.keyRow !== undefined ? `, key row ${headers.keyRow}` : ""
    }`;
    if (num(headers.columnCount) === 0)
      line(false, "header columns", `none in ${rows}`);
    if (isRecord(headers.present)) {
      const missing = Array.isArray(headers.present.missing)
        ? headers.present.missing
        : [];
      line(
        missing.length === 0,
        "headers present",
        missing.length ? `missing ${listText(missing)}` : rows,
      );
    }
    if (isRecord(headers.absent)) {
      const found = Array.isArray(headers.absent.found)
        ? headers.absent.found
        : [];
      line(
        found.length === 0,
        "headers absent",
        found.length ? `found ${listText(found)}` : null,
      );
    }
    if (isRecord(headers.labels)) {
      const mismatches = Array.isArray(headers.labels.mismatches)
        ? headers.labels.mismatches
        : [];
      line(
        mismatches.length === 0,
        "header labels by key",
        mismatches.length ? listText(mismatches, 6) : null,
      );
    }
    for (const key of ["includesInOrder", "withinListInOrder"]) {
      const result = headers[key];
      if (!isRecord(result)) continue;
      const missing = Array.isArray(result.missing) ? result.missing : [];
      const extra = Array.isArray(result.extra) ? result.extra : [];
      const outOfOrder = Array.isArray(result.outOfOrder)
        ? result.outOfOrder
        : [];
      const problems = [
        missing.length ? `missing ${listText(missing)}` : null,
        extra.length ? `not in the list ${listText(extra)}` : null,
        outOfOrder.length ? `out of order ${listText(outOfOrder)}` : null,
      ].filter(Boolean);
      line(
        problems.length === 0,
        `${key} ${listText(result.list)}`,
        problems.length
          ? problems.join("; ")
          : Array.isArray(result.positions)
            ? `at ${listText(result.positions)}`
            : null,
      );
    }
  } else if (isRecord(check.rows)) {
    const rows = check.rows;
    if (isRecord(rows.afterKeyRow)) {
      const expected = isRecord(rows.afterKeyRow.expected)
        ? rows.afterKeyRow.expected
        : {};
      const want =
        expected.count !== undefined
          ? `count ${expected.count}`
          : [
              expected.atLeast !== undefined ? `≥ ${expected.atLeast}` : null,
              expected.atMost !== undefined ? `≤ ${expected.atMost}` : null,
            ]
              .filter(Boolean)
              .join(" and ") || "any";
      const actual = num(rows.afterKeyRow.actual);
      const ok =
        actual === null
          ? null
          : expected.count !== undefined
            ? actual === expected.count
            : (expected.atLeast === undefined || actual >= expected.atLeast) &&
              (expected.atMost === undefined || actual <= expected.atMost);
      line(
        ok,
        `data rows after row ${(num(rows.firstDataRow) ?? 2) - 1}: ${want}`,
        `${actual ?? "?"} row(s)`,
      );
    }
    if (isRecord(rows.match)) {
      line(
        rows.match.matched === true,
        `a row where ${str(rows.match.wanted) ?? "?"}`,
        rows.match.matched === true
          ? `row ${rows.match.row ?? "?"}`
          : `no match in ${num(rows.dataRows) ?? "?"} row(s)`,
      );
    }
  } else if ("cell" in check) {
    if (check.found === false)
      line(false, `cell ${check.cell}`, "sheet not found");
    else {
      const fmtCode = isRecord(check.numFmt)
        ? (str(check.numFmt.code) ?? `#${check.numFmt.id ?? "?"}`)
        : null;
      line(
        typeof check.passed === "boolean" ? check.passed : null,
        `cell ${check.cell}`,
        `${JSON.stringify(String(check.value ?? ""))}${
          fmtCode ? ` · numFmt ${fmtCode}` : ""
        }`,
      );
    }
  } else if (isRecord(check.validation)) {
    const v = check.validation;
    const covering = Array.isArray(check.covering) ? check.covering : [];
    line(
      check.found === true,
      `validation ${str(v.column) ?? "?"}${v.type ? ` (${v.type})` : ""}${
        v.formulaMatches !== undefined
          ? ` formula ~ ${listText([v.formulaMatches].flat())}`
          : ""
      }`,
      covering.length
        ? `covering: ${covering
            .slice(0, 4)
            .map((entry) =>
              isRecord(entry)
                ? `${entry.type ?? "any"} ${entry.sqref ?? ""}${
                    entry.formula1 !== undefined ? ` ${entry.formula1}` : ""
                  }`
                : String(entry),
            )
            .join("; ")}`
        : check.columnIndex === undefined
          ? "column not found"
          : "none covers the column",
    );
  }
  return out;
}

/**
 * F17 xlsx evidence: the workbook (file name only), its sheets, the checked
 * sheet's header columns as a table, and one line per check.
 * @param {Record<string, any>} raw
 * @returns {DataEvidence}
 */
function normalizeXlsxEvidence(raw) {
  /** @type {Array<[string, string]>} */
  const facts = [];
  const fact = (/** @type {string} */ label, /** @type {unknown} */ item) => {
    if (item === null || item === undefined || item === "") return;
    facts.push([label, CairnEvents.maskValue(label, item, 300)]);
  };
  const file = str(raw.path);
  fact("workbook", file ? path.basename(file) : null);
  fact("sheets", listText(raw.sheets));
  fact("checked sheet", str(raw.sheet));
  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter(isRecord)
    : [];
  const table = columns.length
    ? tableFromObjects(
        columns.map((column) => ({
          column: column.letter,
          label: column.label,
          ...(column.key !== undefined ? { key: column.key } : {}),
        })),
        { unit: "columns", prefer: ["column", "label", "key"] },
      )
    : null;
  const checks = raw.checks.flatMap(xlsxChecks).slice(0, 120);
  const failed = checks.filter((entry) => entry.ok === false).length;
  fact(
    "checks",
    `${checks.length}${failed ? ` (${failed} failed)` : " passed"}`,
  );
  return {
    kind: "xlsx",
    source: null,
    request: null,
    facts,
    table,
    value: null,
    truncated: false,
    note: null,
    attempts: normalizeAttempts(raw.attempts),
    attemptCount: num(raw.attemptCount),
    polledMs: num(raw.polledMs),
    checks,
  };
}

/**
 * Read and parse a JSON file inside a run directory (bounded); null when it
 * is missing, too big or not JSON.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
function readJsonBounded(file, maxBytes = MAX_JSON_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
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

// ── F15 widget evidence / F18 request evidence ────────────────────────────

/** A masked value, as the runner masks one. */
const MASKED = "••••••";

/**
 * One widget value (expected / committed) as a display line: masked when
 * the field looks like a credential or the runner already redacted it.
 * @param {unknown} value
 * @param {boolean} masked
 * @returns {string | null}
 */
function widgetValue(value, masked) {
  if (value === undefined) return null;
  if (masked || value === "[redacted]") return MASKED;
  // an empty read-back is the evidence: say so instead of a blank cell
  if (value === "") return '""';
  return CairnEvents.maskValue(null, value, 300);
}

/**
 * The step's `widgets/NNN_<id>.json` evidence (F15): per field, what the
 * spec asked for and what the page committed, the driver and path it took,
 * the form verify pass, and — when a form failed with `dumpUnanswered` —
 * the fields still empty. Values of credential-looking fields never show.
 * @param {string} runDir
 */
function readWidgets(runDir) {
  let budget = MAX_STEP_EVIDENCE_BYTES;
  return jsonFilesIn(runDir, "widgets").map((file) => {
    const target = insideRun(runDir, file);
    let doc = null;
    if (target && budget > 0) {
      doc = readJsonBounded(target, Math.min(MAX_STEP_FILE_BYTES, budget));
      try {
        budget -= fs.statSync(target).size;
      } catch {
        // gone meanwhile
      }
    }
    const record = isRecord(doc) ? doc : {};
    const list = Array.isArray(record.fields) ? record.fields : [];
    const fields = list
      .filter(isRecord)
      .slice(0, MAX_WIDGET_FIELDS)
      .map((entry) => {
        const field = str(entry.field) ?? "?";
        const masked =
          CairnEvents.isSecretKey(field) ||
          entry.expected === "[redacted]" ||
          entry.actual === "[redacted]";
        const final = isRecord(entry.final) ? entry.final : null;
        return {
          field: CairnEvents.maskValue(null, field, 200),
          status: str(entry.status) ?? "unknown",
          driver: str(entry.driver),
          via: str(entry.via),
          expected: widgetValue(entry.expected, masked),
          actual: widgetValue(entry.actual, masked),
          final: final
            ? {
                status: str(final.status) ?? "?",
                actual: widgetValue(final.actual, masked),
                matches:
                  typeof final.matches === "boolean" ? final.matches : null,
              }
            : null,
          error: str(entry.error)
            ? CairnEvents.maskValue(null, entry.error, 600)
            : null,
          reason: str(entry.reason)
            ? CairnEvents.maskValue(null, entry.reason, 200)
            : null,
          root: str(entry.root)
            ? CairnEvents.maskValue(null, entry.root, 120)
            : null,
          rootText:
            !masked && str(entry.rootText)
              ? CairnEvents.maskValue(null, entry.rootText, 300)
              : null,
          notes:
            !masked && Array.isArray(entry.notes)
              ? entry.notes
                  .slice(0, 8)
                  .map((note) => CairnEvents.maskValue(null, note, 200))
              : [],
          durationMs: num(entry.durationMs),
          masked,
        };
      });
    const dump = isRecord(record.unanswered) ? record.unanswered : null;
    return {
      path: file,
      stepId: str(record.stepId),
      kind: str(record.kind),
      status: str(record.status) ?? "unknown",
      error: str(record.error)
        ? CairnEvents.maskValue(null, record.error, 1200)
        : null,
      fields,
      fieldsTotal: list.length,
      unanswered: dump
        ? {
            total: num(dump.total),
            error: str(dump.error)
              ? CairnEvents.maskValue(null, dump.error, 300)
              : null,
            fields: (Array.isArray(dump.fields) ? dump.fields : [])
              .filter(isRecord)
              .slice(0, MAX_ROWS)
              .map((entry) => ({
                key: CairnEvents.maskValue(null, entry.key ?? "?", 160),
                driver: str(entry.driver),
                required: entry.required === true,
                label: str(entry.label)
                  ? CairnEvents.maskValue(null, entry.label, 160)
                  : null,
              })),
            listed: Array.isArray(dump.fields) ? dump.fields.length : 0,
          }
        : null,
      readable: isRecord(doc),
    };
  });
}

/**
 * A matrix combination's values as one line (`route={…} auth=••••••`).
 * @param {unknown} values
 * @returns {string}
 */
function combinationText(values) {
  if (!isRecord(values)) return "";
  return Object.entries(values)
    .map(([key, value]) => `${key}=${CairnEvents.maskValue(key, value, 120)}`)
    .join(" ")
    .slice(0, 400);
}

/**
 * The run's `requests/<assign>.json` envelopes (F18), summarized: method,
 * URL (query dropped, userinfo masked), status, attempts a retry / until
 * sent, capture names with masked values, and a matrix's combinations with
 * their status. Bodies and headers stay in the file, one click away.
 * @param {string} runDir
 */
function readRequests(runDir) {
  let budget = MAX_STEP_EVIDENCE_BYTES;
  return jsonFilesIn(runDir, "requests").map((file) => {
    const target = insideRun(runDir, file);
    let doc = null;
    if (target && budget > 0) {
      doc = readJsonBounded(target, Math.min(MAX_STEP_FILE_BYTES, budget));
      try {
        budget -= fs.statSync(target).size;
      } catch {
        // gone meanwhile
      }
    }
    const record = isRecord(doc) ? doc : {};
    const matrix = Array.isArray(record.matrix)
      ? record.matrix.filter(isRecord)
      : null;
    return {
      path: file,
      assign: path.basename(file, ".json"),
      method: str(record.method)
        ? CairnEvents.maskValue(null, record.method, 40)
        : null,
      url: redactUrl(record.url),
      status: num(record.status),
      ok: typeof record.ok === "boolean" ? record.ok : null,
      attempts: num(record.attempts),
      captures: isRecord(record.captures)
        ? Object.entries(record.captures)
            .slice(0, 30)
            .map(([key, value]) => [
              key,
              CairnEvents.maskValue(key, value, 160),
            ])
        : [],
      matrix: matrix
        ? {
            total: matrix.length,
            mismatched: matrix.filter((entry) => entry.matched === false)
              .length,
            rows: matrix.slice(0, MAX_MATRIX_ROWS).map((entry) => ({
              values: combinationText(entry.values),
              method: str(entry.method) ?? "?",
              url: redactUrl(entry.url),
              status: num(entry.status),
              matched: entry.matched !== false,
              error: str(entry.error)
                ? CairnEvents.maskValue(null, entry.error, 300)
                : null,
            })),
          }
        : null,
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
  readWidgets,
  readRequests,
  readRunFixtures,
  readFixtureLedger,
  foldLedgerRecords,
  normalizeLedgerEntry,
  redactUrl,
  maskDeep,
  preview,
};
