/**
 * The authoring lane: discovery / accompany session journals, draft
 * promotion, the project catalog, and the services lifecycle an author
 * keeps warm while exploring.
 *
 * A session journal lives at `<artifactRoot>/_sessions/<sessionId>/`
 * (`src/core/discovery/sessionJournal.ts`): `session.json` (rewritten
 * atomically), `events.ndjson` (session.opened, action.performed,
 * step.recorded, step.removed, snapshot.captured, draft.updated,
 * export.written, session.closed), `screenshots/NNN.png`,
 * `snapshots/NNN.txt`, `network/NNN.json` and `draft.spec.yml`. The CLI
 * redacts everything before it reaches disk; Studio only reads it.
 *
 * Studio never writes a journal, a draft or a spec contract itself, and never
 * invents a contract. It spawns what an agent would: `cairn discover export
 * --from-session <dir> --intent … --outcomes <file> --json` (a re-export,
 * with the contract session.json kept from the agent's export), `cairn spec
 * promote <draft> --json`, `cairn catalog --json`, `cairn services
 * up|down|status --env <name> --json`. This module owns the reads (bounded,
 * inside one journal), the liveness verdict, the dialog texts, and the argv
 * builders (a renderer-supplied value is one argv entry joined to its flag,
 * so it can never read as another flag).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { formatDuration, formatTimestamp } = require("./format");
const { journalClient, journalOrigin } = require("./invocations");
const { isPidAlive, safeJoin } = require("./runs");

/** Directory under the artifact root holding one journal per session. */
const SESSIONS_DIR = "_sessions";
/** The CLI's session id rule: never a path, never a run-dir id. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const SESSION_FILE = "session.json";
const DRAFT_FILE = "draft.spec.yml";
/** session.json is small; anything bigger is not one. */
const MAX_SESSION_FILE_BYTES = 1024 * 1024;
/** A spec draft shown in a confirmation dialog. */
const MAX_DRAFT_BYTES = 512 * 1024;
/** Journal files the renderer may read as text, by extension. */
const TEXT_EXTENSIONS = new Set([".txt", ".json", ".yml", ".yaml"]);
/** Journal files the renderer may read as images. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** Environment names the services/catalog commands accept from the renderer. */
const ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Longest catalog query Studio passes on. */
const MAX_QUERY_CHARS = 200;
/** An open session idle this long, with no TTL and no live pid, is stale. */
const STALE_WITHOUT_TTL_MS = 30 * 60_000;
/** The CLI's default `authoring.draftsDir` (relative to the config dir). */
const DEFAULT_DRAFTS_DIR = "flows/_drafts";
/** Longest intent Studio passes back to `discover export`. */
const MAX_INTENT_CHARS = 4000;
/** Most outcomes a re-export carries (a contract, not a dump). */
const MAX_OUTCOMES = 200;
/** One outcome's `verify:` in a dialog line, before it is cut (and marked). */
const MAX_VERIFY_CHARS = 400;
/** A refusal shown to the user: the CLI's stderr from the start, bounded. */
const MAX_ERROR_CHARS = 2000;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * The journal directory of one session, or null for an id that could name
 * anything else.
 * @param {string} runsRoot
 * @param {unknown} sessionId
 * @returns {string | null}
 */
function sessionDir(runsRoot, sessionId) {
  if (!runsRoot || !isSessionId(sessionId)) return null;
  return path.join(path.resolve(runsRoot), SESSIONS_DIR, String(sessionId));
}

/**
 * Resolve a renderer reference to a journal directory: a session id, or an
 * absolute directory that is exactly `<runsRoot>/_sessions/<id>` (a path
 * check: nothing deeper, nothing beside it).
 * @param {string} runsRoot
 * @param {unknown} ref
 * @returns {string | null}
 */
function resolveSessionRef(runsRoot, ref) {
  if (typeof ref !== "string" || !ref) return null;
  if (!path.isAbsolute(ref)) return sessionDir(runsRoot, ref);
  const resolved = path.resolve(ref);
  const id = path.basename(resolved);
  const expected = sessionDir(runsRoot, id);
  return expected && expected === resolved ? expected : null;
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
function int(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * @param {string} file
 * @returns {any}
 */
function readSmallJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SESSION_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The intent + outcomes a session.json carries from its last export, or
 * null when there is none (or it does not look like one).
 * @param {any} raw parsed session.json
 * @returns {{ intent: string, outcomes: Array<Record<string, unknown>> } | null}
 */
function contractOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const intent = typeof raw.intent === "string" ? raw.intent : "";
  if (!intent.trim() || intent.length > MAX_INTENT_CHARS) return null;
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
  if (!outcomes.length || outcomes.length > MAX_OUTCOMES) return null;
  if (
    !outcomes.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.id === "string" &&
        entry.id,
    )
  )
    return null;
  return { intent, outcomes };
}

/**
 * The contract of a journal's last export (read from its session.json).
 * @param {string} dir the journal directory (already validated)
 * @returns {{ intent: string, outcomes: Array<Record<string, unknown>> } | null}
 */
function sessionContract(dir) {
  return contractOf(readSmallJson(path.join(dir, SESSION_FILE)));
}

/**
 * How alive a session is. Only an `open` journal can be live: its process
 * must still exist (`kill(pid, 0)`), and its last activity must be younger
 * than its TTL (the CLI expires idle sessions on its next sweep).
 *
 *   live      open, pid alive (or unknown) and active within the TTL
 *   idle      open and pid alive, but idle past its TTL (about to expire)
 *   dead      open, but the process is gone (it never closed the journal)
 *   stale     open, no pid answer and no TTL, idle for 30 min
 *   ended     expired / closed / exported
 *
 * @param {Record<string, any>} session normalized (see `normalizeSession`)
 * @param {{ now?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {{ state: "live" | "idle" | "dead" | "stale" | "ended", reason: string, idleMs: number | null, ttlMs: number | null, expiresAt: string | null, pidAlive: boolean | null }}
 */
function sessionLiveness(session, options = {}) {
  const now = options.now ?? Date.now();
  const last =
    Date.parse(session?.lastActivityAt ?? "") ||
    Date.parse(session?.openedAt ?? "");
  const idleMs = Number.isFinite(last) ? Math.max(0, now - last) : null;
  const ttlMs = Number(session?.ttlMs) > 0 ? Number(session.ttlMs) : null;
  const expiresAt =
    ttlMs !== null && Number.isFinite(last)
      ? new Date(last + ttlMs).toISOString()
      : null;
  const base = { idleMs, ttlMs, expiresAt };
  if (session?.status !== "open")
    return {
      ...base,
      state: "ended",
      reason: String(session?.status ?? "unknown"),
      expiresAt: null,
      pidAlive: null,
    };
  const probe = options.pidAlive ?? isPidAlive;
  const alive = Number.isInteger(session?.pid) ? probe(session.pid) : null;
  if (alive === false)
    return {
      ...base,
      state: "dead",
      reason: `process ${session.pid} is gone; the journal was never closed`,
      pidAlive: false,
    };
  if (ttlMs !== null && idleMs !== null && idleMs > ttlMs)
    return {
      ...base,
      state: "idle",
      reason: "idle past its TTL: the session expires on the next sweep",
      pidAlive: alive,
    };
  if (
    alive === null &&
    ttlMs === null &&
    idleMs !== null &&
    idleMs > STALE_WITHOUT_TTL_MS
  )
    return {
      ...base,
      state: "stale",
      reason: "no process answer and no activity for 30 min",
      pidAlive: null,
    };
  return {
    ...base,
    state: "live",
    reason: alive ? `pid ${session.pid} alive` : "recent activity",
    pidAlive: alive,
  };
}

/**
 * `setup` as written: a list of `{use, vars?}` or `{fromSpec, untilStep}`.
 * Kept as data (the CLI already redacted secret vars); unknown shapes drop.
 * @param {unknown} value
 * @returns {Array<{ use: string, vars: string[] }> | { fromSpec: string, untilStep: string } | null}
 */
function normalizeSetup(value) {
  if (Array.isArray(value)) {
    const list = value
      .filter((entry) => entry && typeof entry.use === "string")
      .map((entry) => ({
        use: entry.use,
        vars:
          entry.vars && typeof entry.vars === "object"
            ? Object.keys(entry.vars)
            : [],
      }));
    return list.length ? list : null;
  }
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, any>} */ (value);
    if (typeof record.fromSpec === "string")
      return {
        fromSpec: record.fromSpec,
        untilStep: String(record.untilStep ?? ""),
      };
  }
  return null;
}

/**
 * A session.json as Studio shows it: every field type-checked and optional
 * beyond the identity (a newer cairn's extra fields are ignored).
 * @param {any} raw parsed session.json
 * @param {string} dir the journal directory
 * @param {{ now?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {Record<string, any> | null}
 */
function normalizeSession(raw, dir, options = {}) {
  if (!raw || typeof raw !== "object") return null;
  const sessionId = str(raw.sessionId) ?? path.basename(dir);
  if (!isSessionId(sessionId)) return null;
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes : [];
  const exportedTo = Array.isArray(raw.exportedTo)
    ? raw.exportedTo.filter((entry) => typeof entry === "string" && entry)
    : [];
  const session = {
    sessionId,
    dir,
    kind: str(raw.kind) ?? "discovery",
    status: str(raw.status) ?? "unknown",
    origin: journalOrigin(raw.origin),
    client: journalClient(raw.client),
    pid: int(raw.pid),
    startUrl: typeof raw.startUrl === "string" ? raw.startUrl : "",
    currentUrl: str(raw.currentUrl),
    backend: str(raw.backend),
    headed: raw.headed === true,
    env: str(raw.env),
    configPath: str(raw.configPath),
    openedAt: str(raw.openedAt),
    lastActivityAt: str(raw.lastActivityAt),
    closedAt: str(raw.closedAt),
    ttlMs: int(raw.ttlMs),
    setup: normalizeSetup(raw.setup),
    resume: str(raw.resume),
    exportedTo,
    // Exports moved since (promoted, renamed, deleted): nothing to promote.
    exportedMissing: exportedTo.filter(
      (entry) => path.isAbsolute(entry) && !fs.existsSync(entry),
    ),
    stepCount: int(raw.stepCount),
    actionCount: int(raw.actionCount),
    specPath: str(raw.specPath),
    draftPath: str(raw.draftPath),
    intent: str(raw.intent),
    outcomeIds: outcomes
      .map((entry) =>
        entry && typeof entry === "object" ? str(entry.id) : null,
      )
      .filter(Boolean),
    hasDraft: fs.existsSync(path.join(dir, DRAFT_FILE)),
    // Studio re-exports only with the contract of an earlier export: the
    // CLI needs --intent/--outcomes and Studio never invents them.
    reexportable: str(raw.kind) === "discovery" && contractOf(raw) !== null,
    liveness: /** @type {ReturnType<typeof sessionLiveness> | null} */ (null),
  };
  session.liveness = sessionLiveness(session, options);
  return session;
}

/**
 * One journal by id (null when missing or unreadable).
 * @param {string} runsRoot
 * @param {unknown} sessionId
 * @param {{ now?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {Record<string, any> | null}
 */
function readSession(runsRoot, sessionId, options = {}) {
  const dir = sessionDir(runsRoot, sessionId);
  return dir ? readSessionDir(dir, options) : null;
}

/**
 * One journal by its (already validated) directory.
 * @param {string} dir
 * @param {{ now?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {Record<string, any> | null}
 */
function readSessionDir(dir, options = {}) {
  return normalizeSession(
    readSmallJson(path.join(dir, SESSION_FILE)),
    dir,
    options,
  );
}

/**
 * Journals under the artifact root, newest `openedAt` first (a journal
 * without one sorts by its folder's mtime).
 * @param {string} runsRoot
 * @param {{ limit?: number, now?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {Array<Record<string, any>>}
 */
function listSessions(runsRoot, options = {}) {
  const limit = Math.max(1, options.limit ?? 50);
  const root = path.join(path.resolve(runsRoot), SESSIONS_DIR);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSessionId(entry.name)) continue;
    const session = readSession(runsRoot, entry.name, options);
    if (!session) continue;
    let sortKey = Date.parse(session.openedAt ?? "");
    if (!Number.isFinite(sortKey)) {
      try {
        sortKey = fs.statSync(session.dir).mtimeMs;
      } catch {
        sortKey = 0;
      }
    }
    out.push({ session, sortKey });
  }
  return out
    .toSorted((a, b) => b.sortKey - a.sortKey)
    .slice(0, limit)
    .map((entry) => entry.session);
}

/**
 * A journal-relative file the renderer may read: no traversal, no dotfile,
 * and a text (or image) extension. Null otherwise.
 * @param {string} dir the journal directory
 * @param {unknown} relativePath
 * @param {"text" | "image"} kind
 * @returns {string | null} the same relative path, normalized
 */
function journalFile(dir, relativePath, kind) {
  if (typeof relativePath !== "string" || !relativePath) return null;
  const rel = relativePath.replaceAll("\\", "/");
  if (rel.split("/").some((part) => !part || part.startsWith("."))) return null;
  if (!safeJoin(dir, rel)) return null;
  const ext = path.extname(rel).toLowerCase();
  const allowed = kind === "image" ? IMAGE_EXTENSIONS : TEXT_EXTENSIONS;
  return allowed.has(ext) ? rel : null;
}

/**
 * Strip control characters and bound a renderer-typed value.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function cleanText(value, max) {
  return Array.from(String(value ?? ""), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * An environment name from the renderer, or a thrown error.
 * @param {unknown} value
 * @returns {string}
 */
function checkEnvName(value) {
  const name = String(value ?? "").trim();
  if (!ENV_NAME_PATTERN.test(name))
    throw new Error(`invalid environment name: ${name || "(empty)"}`);
  return name;
}

/**
 * `cairn discover export --from-session=<dir> --intent=… --outcomes=<file>
 * [--path=<spec>] --json`. Studio passes the intent and outcomes of the
 * session's last export explicitly (a re-export), never its own, so the
 * dialog shows exactly the contract that is written (the CLI would default
 * to the same ones from session.json). `path` (absolute) re-targets that export's file; without it the
 * CLI writes into the config's drafts dir. Every value is one argv entry
 * joined to its flag.
 * @param {{ sessionDir: string, intent: string, outcomesFile: string, path?: string | null, config?: string | null }} options
 * @returns {string[]}
 */
function buildSessionExportArgv(options) {
  if (!path.isAbsolute(String(options?.sessionDir ?? "")))
    throw new Error("session directory must be absolute");
  const intent = String(options?.intent ?? "");
  if (!intent.trim()) throw new Error("an export needs the intent");
  if (!path.isAbsolute(String(options?.outcomesFile ?? "")))
    throw new Error("the outcomes file must be absolute");
  const argv = [
    "discover",
    "export",
    `--from-session=${path.resolve(options.sessionDir)}`,
    `--intent=${intent}`,
    `--outcomes=${path.resolve(options.outcomesFile)}`,
  ];
  if (options.path) {
    if (!path.isAbsolute(options.path))
      throw new Error("the export path must be absolute");
    argv.push(`--path=${path.resolve(options.path)}`);
  }
  if (options.config) argv.push(`--config=${path.resolve(options.config)}`);
  argv.push("--json");
  return argv;
}

/**
 * `cairn spec promote <draft> [--force] [--expect-content-hash=<sha256>]
 * --json`. The draft is an absolute path (never readable as a flag); the
 * hash pins the text the dialog showed, so the CLI refuses any other
 * content even under `--force`.
 * @param {string} draft
 * @param {{ force?: boolean, expectContentHash?: string }} [options]
 * @returns {string[]}
 */
function buildPromoteArgv(draft, options = {}) {
  if (!path.isAbsolute(String(draft ?? "")))
    throw new Error("draft path must be absolute");
  const argv = ["spec", "promote", path.resolve(draft)];
  if (options.force) argv.push("--force");
  if (options.expectContentHash !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(String(options.expectContentHash)))
      throw new Error(
        "expectContentHash must be a lowercase sha256 hex digest",
      );
    argv.push(`--expect-content-hash=${options.expectContentHash}`);
  }
  argv.push("--json");
  return argv;
}

/**
 * `cairn catalog --json [--query=…] [--env=…] [--limit=…]`.
 * @param {{ query?: unknown, env?: unknown, limit?: unknown, config?: string | null, artifactRoot?: string | null }} [options]
 * @returns {string[]}
 */
function buildCatalogArgv(options = {}) {
  const argv = ["catalog"];
  const query = cleanText(options.query, MAX_QUERY_CHARS);
  if (query) argv.push(`--query=${query}`);
  if (options.env !== undefined && options.env !== null && options.env !== "")
    argv.push(`--env=${checkEnvName(options.env)}`);
  const limit = Number(options.limit);
  if (Number.isInteger(limit) && limit > 0)
    argv.push(`--limit=${Math.min(limit, 500)}`);
  if (options.config) argv.push(`--config=${path.resolve(options.config)}`);
  if (options.artifactRoot)
    argv.push(`--artifact-root=${path.resolve(options.artifactRoot)}`);
  argv.push("--json");
  return argv;
}

/**
 * `cairn services up|down|status --env=<name> --json`.
 * @param {"up" | "down" | "status"} action
 * @param {{ env: unknown, config?: string | null }} options
 * @returns {string[]}
 */
function buildServicesArgv(action, options) {
  if (action !== "up" && action !== "down" && action !== "status")
    throw new Error(`unknown services action: ${action}`);
  const argv = ["services", action, `--env=${checkEnvName(options?.env)}`];
  if (options?.config) argv.push(`--config=${path.resolve(options.config)}`);
  argv.push("--json");
  return argv;
}

/**
 * Did this cairn not know the command or its flags (an older binary)? Only
 * commander's own parse errors count, and only as the first line: a parse
 * error is printed before any action runs, while a command that did run
 * (`services up` streams docker / seed / tmux output to stderr) can print
 * "unknown option" for reasons of its own.
 * @param {{ ok?: boolean, stderr?: string }} result
 * @returns {boolean}
 */
function looksUnsupported(result) {
  if (result?.ok) return false;
  const first =
    String(result?.stderr ?? "")
      .split("\n")
      .find((line) => line.trim()) ?? "";
  return /^error: (unknown command '|unknown option '|too many arguments)/.test(
    first.trim(),
  );
}

/**
 * A failed command's stderr as the user reads it: from the start (a CLI
 * error leads with its message; a multi-line zod dump follows it), bounded.
 * @param {string | null | undefined} stderr
 * @returns {string | null}
 */
function refusalText(stderr) {
  const text = String(stderr ?? "").trim();
  if (!text) return null;
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}…`
    : text;
}

/**
 * Would `--force` change this `spec promote` refusal? Only the missing or
 * stale green `cairn spec finish` gate: "is not a draft", "already
 * exists", a broken stamp or file reference refuse with --force too.
 * @param {{ ok?: boolean, stderr?: string }} result
 * @returns {boolean}
 */
function promoteForceable(result) {
  if (result?.ok) return false;
  return /refusing to promote [\s\S]*\(or pass --force\)/.test(
    String(result?.stderr ?? ""),
  );
}

/**
 * The first readable spec file among `candidates`, inside `projectDir`.
 * @param {string[]} candidates absolute paths
 * @param {string} projectDir
 * @returns {string | null}
 */
function firstSpecInside(candidates, projectDir) {
  const base = path.resolve(projectDir);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) continue;
    if (!/\.ya?ml$/i.test(resolved)) continue;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Where an exported draft lives. `export.written` keeps the path as the
 * exporting caller gave it (absolute, or relative to its cwd), and
 * session.json `exportedTo` holds absolute paths: an absolute path is taken
 * as is; a relative one is tried against the project, the session's config
 * directory, and matched against `exportedTo`. Only a YAML file inside the
 * project counts.
 * @param {unknown} draft
 * @param {{ projectDir: string, session?: Record<string, any> | null }} context
 * @returns {string | null}
 */
function resolveDraftPath(draft, context) {
  const text = String(draft ?? "").trim();
  if (!text) return null;
  if (path.isAbsolute(text)) return firstSpecInside([text], context.projectDir);
  const candidates = [path.join(context.projectDir, text)];
  const configPath = context.session?.configPath;
  if (typeof configPath === "string" && path.isAbsolute(configPath))
    candidates.push(path.join(path.dirname(configPath), text));
  const suffix = `${path.sep}${path.normalize(text)}`;
  for (const exported of context.session?.exportedTo ?? [])
    if (path.isAbsolute(exported) && path.normalize(exported).endsWith(suffix))
      candidates.push(exported);
  return firstSpecInside(candidates, context.projectDir);
}

/**
 * The CLI's draft rule (`src/core/authoring/config.ts isDraftSpec`): inside
 * the config's `authoring.draftsDir` (default `flows/_drafts`, relative to
 * the config dir), or a file/folder below the config dir (the project when
 * there is no config) whose name starts with `_`. `cairn spec promote`
 * refuses anything else, so Studio does not ask about it.
 * @param {string} file absolute
 * @param {{ projectDir: string, configPath?: string | null, config?: Record<string, any> | null }} context
 * @returns {boolean}
 */
function isPromotableDraft(file, context) {
  const root = context.configPath
    ? path.dirname(path.resolve(context.configPath))
    : path.resolve(context.projectDir);
  const configured = context.config?.raw?.authoring?.draftsDir;
  const draftsDir =
    typeof configured === "string" && configured.trim()
      ? path.resolve(root, configured.trim())
      : path.join(root, DEFAULT_DRAFTS_DIR);
  const inside = (/** @type {string} */ dir) => {
    const rel = path.relative(dir, path.resolve(file));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(draftsDir)) return true;
  const rel = path.relative(root, path.resolve(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).some((segment) => segment.startsWith("_"));
}

/**
 * sha256 of a draft's exact text: what the dialog showed is what may be
 * promoted.
 * @param {string} text
 * @returns {string}
 */
function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * The contract a stamp locks (`src/core/contractHash.ts`: intent +
 * outcomes), read from a draft's text as written.
 * @param {string} text
 * @returns {{ intent: string | null, outcomes: Array<{ id: string, description: string | null, verify: unknown }>, parseError: string | null }}
 */
function draftContract(text) {
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    return {
      intent: null,
      outcomes: [],
      parseError: String(/** @type {any} */ (error)?.message ?? error),
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return { intent: null, outcomes: [], parseError: "not a YAML mapping" };
  const outcomes = Array.isArray(doc.outcomes) ? doc.outcomes : [];
  return {
    intent: typeof doc.intent === "string" ? doc.intent : null,
    outcomes: outcomes.map((outcome, index) => ({
      id:
        outcome && typeof outcome.id === "string"
          ? outcome.id
          : `(outcome ${index + 1} has no id)`,
      description:
        outcome && typeof outcome.description === "string"
          ? outcome.description
          : null,
      verify: outcome && typeof outcome === "object" ? outcome.verify : null,
    })),
    parseError: null,
  };
}

/**
 * One value as compact flow YAML (`{ text: { contains: saved } }`), so
 * `contains: ""` and `contains: saved` read differently; cut and marked
 * past `max` characters.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function compactYaml(value, max = MAX_VERIFY_CHARS) {
  if (value === undefined || value === null) return "(none)";
  let text;
  try {
    text = YAML.stringify(value, {
      collectionStyle: "flow",
      lineWidth: 0,
    }).trim();
  } catch {
    text = JSON.stringify(value) ?? String(value);
  }
  text = text.replace(/\s*\n\s*/g, " ");
  return text.length > max
    ? `${text.slice(0, max)}… (${text.length - max} more characters; see the file)`
    : text;
}

/**
 * Every outcome of a contract, each with its `verify:` parameters.
 * @param {{ intent: string | null, outcomes: Array<{ id: string, description?: string | null, verify?: unknown }> }} contract
 * @returns {string[]}
 */
function contractLines(contract) {
  const outcomes = Array.isArray(contract?.outcomes) ? contract.outcomes : [];
  return [
    `intent: ${contract?.intent ?? "(none)"}`,
    "",
    `outcomes (${outcomes.length}):`,
    ...(outcomes.length
      ? outcomes.flatMap((outcome) => [
          `  - ${outcome.id}${
            outcome.description ? `: ${outcome.description}` : ""
          }`,
          `      verify: ${compactYaml(outcome.verify)}`,
        ])
      : ["  (none)"]),
  ];
}

/**
 * The confirmation text for `cairn spec promote`: the contract the stamp
 * will lock (intent and every outcome with its verify parameters), so it is
 * reviewed before it is stamped.
 * @param {{ draft: string, projectDir: string, contract: ReturnType<typeof draftContract>, force?: boolean, cli: string }} input
 * @returns {string}
 */
function promoteDialogText(input) {
  const rel = path.relative(input.projectDir, input.draft) || input.draft;
  const contract = input.contract ?? {
    intent: null,
    outcomes: [],
    parseError: null,
  };
  const lines = [
    rel,
    "",
    ...contractLines(contract),
    "",
    contract.parseError
      ? `The draft does not parse (${contract.parseError}); cairn will refuse it.`
      : "cairn spec promote moves the draft out of the drafts folder and stamps its contract hash over this intent and these outcomes. Changing them later needs a new stamp. If the file changes before cairn runs, Studio refuses and asks again.",
    input.force
      ? "--force: promotes without a green `cairn spec finish`."
      : "cairn refuses a draft without a green `cairn spec finish`.",
    "",
    input.cli,
  ];
  return lines.join("\n");
}

/**
 * The confirmation for a re-export that rewrites an existing file.
 * @param {{ target: string, projectDir: string, contract: { intent: string, outcomes: Array<Record<string, any>> }, cli: string }} input
 * @returns {{ message: string, detail: string, confirmLabel: string }}
 */
function exportDialog(input) {
  const rel = path.relative(input.projectDir, input.target) || input.target;
  return {
    message: "Re-export this session over its draft?",
    detail: [
      rel,
      "",
      "cairn discover export rewrites this file from the journal's recorded steps, with the intent and outcomes of the session's last export (below). Edits made to the file since then are replaced; a file with a stamped contractHash is refused.",
      "",
      ...contractLines({
        intent: input.contract.intent,
        outcomes: input.contract.outcomes.map((outcome) => ({
          id: String(outcome.id),
          description:
            typeof outcome.description === "string"
              ? outcome.description
              : null,
          verify: outcome.verify,
        })),
      }),
      "",
      input.cli,
    ].join("\n"),
    confirmLabel: "Re-export",
  };
}

/**
 * A `services status` lock report (`ServicesLockReport`) in one line.
 * @param {Record<string, any> | null | undefined} report
 * @param {number} [now]
 * @returns {string}
 */
function describeServicesLock(report, now = Date.now()) {
  if (!report || typeof report !== "object")
    return "lock state unknown (cairn services status gave none)";
  if (report.state === "absent") return "no services-up lock";
  if (report.state === "unreadable")
    return `unreadable lock${report.reason ? ` (${report.reason})` : ""}`;
  const lock =
    report.lock && typeof report.lock === "object" ? report.lock : {};
  const started = str(lock.startedAt);
  const ageMs =
    typeof report.ageSeconds === "number"
      ? report.ageSeconds * 1000
      : started
        ? Math.max(0, now - Date.parse(started))
        : null;
  const who = [str(lock.by), int(lock.pid) ? `pid ${lock.pid}` : null]
    .filter(Boolean)
    .join(", ");
  const parts = [
    `held by services up${who ? ` (${who})` : ""}`,
    started ? `since ${formatTimestamp(started)}` : null,
    ageMs !== null && Number.isFinite(ageMs)
      ? `(${formatDuration(ageMs)} ago)`
      : null,
  ].filter(Boolean);
  const problems = Array.isArray(report.problems)
    ? report.problems.filter((entry) => typeof entry === "string")
    : [];
  return `${parts.join(" ")}${
    report.stale
      ? ` — stale${problems.length ? `: ${problems.join("; ")}` : ""}`
      : ""
  }`;
}

/**
 * The native confirmation for `cairn services up|down`.
 * @param {{ action: "up" | "down", env: string, lock: Record<string, any> | null, policy?: Record<string, any> | null, cli: string }} input
 * @returns {{ message: string, detail: string, confirmLabel: string }}
 */
function servicesDialog(input) {
  const trait = input.policy?.trait ?? null;
  const lines =
    input.action === "up"
      ? [
          "cairn services up starts the config services (docker → seed → tmux) the way cairn run does, leaves them running, and writes an owner lock. While the lock exists, cairn run for this environment refuses unless it passes --reuse-services; cairn services down removes it.",
        ]
      : [
          "cairn services down runs every teardown command (docker down included), kills the tmux session, and removes the services-up lock. A run reusing these services (--reuse-services) loses them.",
        ];
  lines.push(
    "",
    `Environment: ${input.env}${trait ? ` (${trait})` : ""}`,
    `Lock now: ${describeServicesLock(input.lock)}`,
  );
  if (trait === "shared" || trait === "protected")
    lines.push(
      `This environment is ${trait}: other people may depend on its services.`,
    );
  lines.push("", input.cli);
  return input.action === "up"
    ? {
        message: `Start the services for "${input.env}"?`,
        detail: lines.join("\n"),
        confirmLabel: "Services up",
      }
    : {
        message: `Tear down the services for "${input.env}"?`,
        detail: lines.join("\n"),
        confirmLabel: "Services down",
      };
}

/**
 * Read a draft for the promote dialog (bounded).
 * @param {string} file
 * @returns {string}
 */
function readDraftText(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`not a file: ${file}`);
  if (stat.size > MAX_DRAFT_BYTES)
    throw new Error(`draft is larger than ${MAX_DRAFT_BYTES} bytes`);
  return fs.readFileSync(file, "utf8");
}

module.exports = {
  SESSIONS_DIR,
  SESSION_ID_PATTERN,
  DRAFT_FILE,
  isSessionId,
  sessionDir,
  resolveSessionRef,
  sessionLiveness,
  normalizeSession,
  readSession,
  readSessionDir,
  listSessions,
  journalFile,
  checkEnvName,
  sessionContract,
  buildSessionExportArgv,
  buildPromoteArgv,
  buildCatalogArgv,
  buildServicesArgv,
  looksUnsupported,
  refusalText,
  promoteForceable,
  resolveDraftPath,
  isPromotableDraft,
  contentHash,
  draftContract,
  contractLines,
  promoteDialogText,
  exportDialog,
  describeServicesLock,
  servicesDialog,
  readDraftText,
};
