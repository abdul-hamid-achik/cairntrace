/**
 * Invocation journals: one `cairn run` process = one invocation.
 *
 * Newer runners write `<artifactRoot>/_invocations/<invocationId>/` with an
 * `invocation.json` (pid, redacted argv, the planned spec list, status, the
 * runs it produced) plus its own `events.ndjson` and `logs/` for the
 * batch-level work that happens outside any run directory (services,
 * before/after hooks). Studio groups live cards by invocation, shows
 * "spec 3/7" and a simple ETA, and checks the pid to tell a dead process from
 * a quiet one. An artifact root without `_invocations/` (older runners) just
 * yields an empty list.
 *
 * The Invocations view's Stop action is gated here too (`checkStoppable`):
 * SIGINT goes only to a live pid whose command line is a `cairn run` /
 * `cairn mcp` process that agrees with the journal and started no later than
 * it did; it reaches the whole process group only when cairn leads its own.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const CairnEvents = require("./events");
const {
  INVOCATIONS_DIR,
  INVOCATION_ID_PATTERN,
  isInvocationId,
  isPidAlive,
  lastActivityMs,
  readEventsWindow,
  readJsonFile,
  safeJoin,
} = require("./runs");

/** Longest MCP client name kept from a journal (it is display text only). */
const MAX_CLIENT_CHARS = 80;

/**
 * Absolute journal directory for an id, or null for an invalid id.
 * @param {string} runsRoot
 * @param {string} invocationId
 * @returns {string | null}
 */
function invocationDir(runsRoot, invocationId) {
  if (!isInvocationId(invocationId)) return null;
  return safeJoin(runsRoot, path.join(INVOCATIONS_DIR, invocationId));
}

/**
 * @typedef {{ state: string, reason: string, heartbeatAgeMs: number | null, heartbeatTs: string | null }} InvocationLiveness
 */

/**
 * @typedef {{
 *   invocationId: string,
 *   dir: string,
 *   updatedAtMs: number | null,
 *   pid: number | null,
 *   pidAlive: boolean | null,
 *   status: string,
 *   alive: boolean,
 *   startedAt: string | null,
 *   endedAt: string | null,
 *   argv: string[],
 *   parallel: number | null,
 *   labels: Record<string, string> | null,
 *   planned: Array<{ index: number, spec: string, labels?: Record<string, string> }>,
 *   current: { index: number, spec: string, runId?: string } | null,
 *   runs: Array<{ index: number, spec: string, runId: string, runDir: string, status?: string }>,
 *   summary: any,
 *   origin: string | null,
 *   client: string | null,
 *   env: string | null,
 *   suite: string | null,
 *   delegate: InvocationDelegate | null,
 *   cwd: string | null,
 *   signal: string | null,
 *   liveness: InvocationLiveness,
 *   logs: Array<{ path: string, bytes: number, mtimeMs: number }>,
 * }} InvocationSummary
 */

/**
 * @typedef {{
 *   remoteInvocationId: string | null,
 *   command: string[],
 *   exitCode: number | null,
 *   cancelled: boolean,
 *   timedOut: boolean,
 *   idle?: boolean,
 *   diagnostics: number,
 * }} InvocationDelegate
 */

/**
 * `delegate` from the journal: the environment has a runner
 * (`environments.<n>.runner`, urn:cairntrace.dev:delegate:v1) — this
 * process owns the invocation (pid, Stop, journal) and the runs execute
 * elsewhere. Display data only; null for an ordinary invocation.
 * @param {unknown} value
 * @returns {InvocationDelegate | null}
 */
function journalDelegate(value) {
  if (!value || typeof value !== "object") return null;
  const block = /** @type {Record<string, unknown>} */ (value);
  if (typeof block.contract !== "string") return null;
  return {
    remoteInvocationId:
      typeof block.remoteInvocationId === "string"
        ? journalClient(block.remoteInvocationId)
        : null,
    command: Array.isArray(block.command)
      ? block.command.filter((part) => typeof part === "string").slice(0, 32)
      : [],
    exitCode: Number.isInteger(block.exitCode)
      ? /** @type {number} */ (block.exitCode)
      : null,
    cancelled: block.cancelled === true,
    timedOut: block.timedOut === true,
    // cancelled after runner.idleTimeoutMs without a stream line
    idle: block.idle === true,
    diagnostics: Number.isInteger(block.diagnostics)
      ? /** @type {number} */ (block.diagnostics)
      : 0,
  };
}

/**
 * `origin` from the journal: who launched the invocation. The runner writes
 * "cli" or "mcp"; any other short lowercase token is kept as-is (a newer
 * runner), and anything else is dropped. Optional: older journals have none.
 * @param {unknown} value
 * @returns {string | null}
 */
function journalOrigin(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,23}$/.test(text) ? text : null;
}

/**
 * `client` from the journal (e.g. the MCP client's name): display text only,
 * so control characters are collapsed and the length is capped.
 * @param {unknown} value
 * @returns {string | null}
 */
function journalClient(value) {
  if (typeof value !== "string") return null;
  // Control characters (C0 and DEL) become spaces, then runs collapse.
  const text = Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > MAX_CLIENT_CHARS
    ? `${text.slice(0, MAX_CLIENT_CHARS - 1)}…`
    : text;
}

/**
 * Reading order of a journal log by file name: narration, services, before
 * hooks, after hooks, anything else.
 * @param {string} name
 * @returns {number}
 */
function logRank(name) {
  if (name === "narration.log") return 0;
  if (name.startsWith("services-")) return 1;
  if (name.startsWith("hook-before-")) return 2;
  if (name.startsWith("hook-after-")) return 3;
  return 4;
}

/**
 * Log files under `<journal>/logs/`, in reading order: narration, services,
 * before hooks, after hooks, anything else.
 * @param {string} dir journal directory
 * @returns {Array<{ path: string, bytes: number, mtimeMs: number }>}
 */
function listJournalLogs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, "logs"), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    try {
      const stat = fs.statSync(path.join(dir, "logs", entry.name));
      out.push({
        path: `logs/${entry.name}`,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out.toSorted(
    (a, b) =>
      logRank(path.basename(a.path)) - logRank(path.basename(b.path)) ||
      a.path.localeCompare(b.path),
  );
}

/**
 * Liveness of an invocation: a finished journal is finished; a running one
 * is classified heartbeat → pid → mtime, like a run without `run.json`
 * (`CairnEvents.classifyLiveness`), except that a pid known to be gone is
 * always "dead": that process will never finish the journal.
 * @param {{ dir: string, declared: string, pid: number | null, pidAlive: boolean | null, updatedAtMs: number | null, now?: number }} input
 * @returns {InvocationLiveness}
 */
function invocationLiveness(input) {
  if (input.declared !== "running")
    return {
      state: "finished",
      reason: `journal status ${input.declared}`,
      heartbeatAgeMs: null,
      heartbeatTs: null,
    };
  const beat = readEventsWindow(input.dir, "tail").findLast(
    (event) => event?.type === "run.heartbeat",
  );
  const heartbeatTs = typeof beat?.ts === "string" ? beat.ts : null;
  if (input.pid && input.pidAlive === false)
    return {
      state: "dead",
      reason: `process ${input.pid} exited without finishing the journal`,
      heartbeatAgeMs: null,
      heartbeatTs,
    };
  const activity = Math.max(
    input.updatedAtMs ?? 0,
    lastActivityMs(input.dir) ?? 0,
  );
  const verdict = CairnEvents.classifyLiveness({
    hasRunJson: false,
    heartbeatTs,
    pid: input.pid,
    pidAlive: input.pidAlive,
    lastActivityMs: activity || null,
    now: input.now,
  });
  return { ...verdict, heartbeatTs };
}

/**
 * Read one journal. Status "running" with a dead pid is reported as
 * "aborted" (the process is gone and will never update it).
 * @param {string} runsRoot
 * @param {string} invocationId
 * @param {{ pidAlive?: (pid: number) => boolean | null, now?: number }} [options]
 * @returns {InvocationSummary | null}
 */
function readInvocation(runsRoot, invocationId, options = {}) {
  const dir = invocationDir(runsRoot, invocationId);
  if (!dir) return null;
  const file = path.join(dir, "invocation.json");
  const journal = readJsonFile(file);
  if (!journal || typeof journal !== "object") return null;
  let updatedAtMs = null;
  try {
    updatedAtMs = fs.statSync(file).mtimeMs;
  } catch {
    // vanished between read and stat
  }
  const pid = Number.isInteger(journal.pid) ? journal.pid : null;
  const declared =
    typeof journal.status === "string" ? journal.status : "unknown";
  const pidAlive =
    declared === "running" && pid
      ? (options.pidAlive ?? isPidAlive)(pid)
      : null;
  const status =
    declared === "running" && pidAlive === false ? "aborted" : declared;
  return {
    invocationId,
    dir,
    pid,
    pidAlive,
    status,
    updatedAtMs,
    alive: declared === "running" && pidAlive !== false,
    startedAt: typeof journal.startedAt === "string" ? journal.startedAt : null,
    endedAt: typeof journal.endedAt === "string" ? journal.endedAt : null,
    argv: Array.isArray(journal.argv) ? journal.argv.map(String) : [],
    parallel: Number.isFinite(journal.parallel) ? journal.parallel : null,
    labels:
      journal.labels && typeof journal.labels === "object"
        ? journal.labels
        : null,
    planned: (Array.isArray(journal.planned) ? journal.planned : [])
      .filter((entry) => entry && typeof entry.spec === "string")
      .map((entry, index) => ({
        index: Number.isFinite(entry.index) ? entry.index : index + 1,
        spec: entry.spec,
        ...(entry.labels && typeof entry.labels === "object"
          ? { labels: entry.labels }
          : {}),
      })),
    current:
      journal.current && typeof journal.current === "object"
        ? journal.current
        : null,
    runs: (Array.isArray(journal.runs) ? journal.runs : []).filter(
      (entry) => entry && typeof entry.runId === "string",
    ),
    summary: journal.summary ?? null,
    origin: journalOrigin(journal.origin),
    client: journalClient(journal.client),
    env: typeof journal.env === "string" ? journal.env : null,
    // `cairn run --suite <name>`: the config suite the specs came from
    suite: typeof journal.suite === "string" ? journal.suite : null,
    delegate: journalDelegate(journal.delegate),
    cwd: typeof journal.cwd === "string" ? journal.cwd : null,
    signal: typeof journal.signal === "string" ? journal.signal : null,
    liveness: invocationLiveness({
      dir,
      declared,
      pid,
      pidAlive,
      updatedAtMs,
      now: options.now,
    }),
    logs: listJournalLogs(dir),
  };
}

/**
 * Journals under the artifact root, newest first.
 * @param {string} runsRoot
 * @param {{ limit?: number, pidAlive?: (pid: number) => boolean | null, now?: number }} [options]
 * @returns {InvocationSummary[]}
 */
function listInvocations(runsRoot, options = {}) {
  const limit = Math.max(1, options.limit ?? 20);
  let names;
  try {
    names = fs
      .readdirSync(path.join(runsRoot, INVOCATIONS_DIR), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isDirectory() && isInvocationId(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (out.length >= limit) break;
    const summary = readInvocation(runsRoot, name, options);
    if (summary) out.push(summary);
  }
  return out;
}

/**
 * The running invocation journal `pid` owns (newest first among the last
 * `limit`), or null. Studio's Live Cancel asks it whether the run it
 * launched is delegated (`delegate` in the journal).
 * @param {string} runsRoot
 * @param {number | null | undefined} pid
 * @param {{ limit?: number, pidAlive?: (pid: number) => boolean | null }} [options]
 * @returns {InvocationSummary | null}
 */
function findRunningInvocationByPid(runsRoot, pid, options = {}) {
  if (!Number.isInteger(pid) || !pid) return null;
  for (const summary of listInvocations(runsRoot, {
    limit: options.limit ?? 20,
    ...(options.pidAlive ? { pidAlive: options.pidAlive } : {}),
  })) {
    if (summary.pid === pid && summary.status === "running") return summary;
  }
  return null;
}

/**
 * @param {string} spec
 * @returns {string[]}
 */
function specLookupKeys(spec) {
  const value = String(spec ?? "");
  return [value, path.basename(value, path.extname(value))];
}

/**
 * Remaining time for an invocation from local history: the p50 of every
 * planned spec not yet finished, minus the time the current one has already
 * spent, divided by the parallelism. Specs with no history are counted as
 * unknown rather than guessed.
 * @param {InvocationSummary} invocation
 * @param {Record<string, { p50: number, n: number }>} history
 * @param {{ now?: number, currentStartedAtMs?: number | null }} [options]
 * @returns {{ etaMs: number | null, known: number, unknown: number, done: number, total: number }}
 */
function estimateInvocationEta(invocation, history, options = {}) {
  const now = options.now ?? Date.now();
  const planned = invocation?.planned ?? [];
  const finished = new Set(
    (invocation?.runs ?? [])
      .filter((entry) => entry.status && entry.status !== "running")
      .map((entry) => entry.index),
  );
  const currentIndex = invocation?.current?.index ?? null;
  let remaining = 0;
  let known = 0;
  let unknown = 0;
  for (const entry of planned) {
    if (finished.has(entry.index)) continue;
    const sample = specLookupKeys(entry.spec)
      .map((key) => history?.[key])
      .find(Boolean);
    if (!sample) {
      unknown += 1;
      continue;
    }
    known += 1;
    let left = sample.p50;
    if (entry.index === currentIndex && options.currentStartedAtMs)
      left = Math.max(0, left - Math.max(0, now - options.currentStartedAtMs));
    remaining += left;
  }
  const parallel = Math.max(1, invocation?.parallel ?? 1);
  return {
    etaMs: known ? Math.round(remaining / parallel) : null,
    known,
    unknown,
    done: finished.size,
    total: planned.length,
  };
}

// ── Stop (SIGINT) safety checks ────────────────────────────────────────────

/** Interpreters a `cairn` script may run under (`bun bin/cairn …`). */
const INTERPRETER = /^(bun|node|nodejs|sh|bash|zsh|dash)(\d[\w.-]*)?$/;
/** How much later than the journal's startedAt its process may have started. */
const START_SLACK_MS = 2000;

/**
 * The writer pid encoded in an invocation id (`<iso>_<pid>_<hex6>`).
 * @param {string} invocationId
 * @returns {number | null}
 */
function invocationIdPid(invocationId) {
  if (!isInvocationId(invocationId)) return null;
  const pid = Number(String(invocationId).split("_").at(-2));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * `ps` elapsed time (`[[dd-]hh:]mm:ss`) in milliseconds.
 * @param {string} value
 * @returns {number | null}
 */
function parseEtime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) *
      60 +
      Number(seconds)) *
    1000
  );
}

/**
 * @typedef {{ pgid: number | null, elapsedMs: number, command: string }} ProcessInfo
 */

/**
 * Parse the first line of `ps -o pgid=,etime=,command= -p <pid>`.
 * @param {string} text
 * @returns {ProcessInfo | null}
 */
function parsePsLine(text) {
  const first = String(text ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!first) return null;
  const match = /^(\d+)\s+(\S+)\s+(.+)$/.exec(first);
  if (!match) return null;
  const elapsedMs = parseEtime(match[2]);
  if (elapsedMs === null) return null;
  const pgid = Number(match[1]);
  return {
    pgid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null,
    elapsedMs,
    command: match[3].trim(),
  };
}

/**
 * Last path segment of a command-line token.
 * @param {string} token
 * @returns {string}
 */
function baseName(token) {
  return token.split("/").pop() ?? "";
}

/** A script file an interpreter flag's value is never mistaken for. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
/** cairn's global options that take a value (`cairn --log-level debug run`). */
const CAIRN_VALUE_FLAGS = new Set(["--log-level", "--log-format"]);

/**
 * @param {string} file
 * @returns {boolean}
 */
function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Do `tokens[from..to]` spell the cairn executable or script? One token
 * must merely end in `cairn`; several (`ps` joins argv with spaces, so a
 * path with spaces arrives split) must form an absolute path to a file that
 * exists, which `/usr/bin/vim /tmp/cairn` never does.
 * @param {string[]} tokens
 * @param {number} from
 * @param {number} to
 * @param {(file: string) => boolean} fileExists
 */
function spellsCairn(tokens, from, to, fileExists) {
  if (from === to) return true;
  const joined = tokens.slice(from, to + 1).join(" ");
  return joined.startsWith("/") && fileExists(joined);
}

/**
 * Can `tokens[1..end)` be the interpreter's own flags? Each is a `-flag`,
 * or the value right after a `-flag` without `=` (`bun --cwd /tmp …`) as
 * long as it does not look like a script (`node --inspect server.js` is
 * running server.js, not cairn).
 * @param {string[]} tokens
 * @param {number} end
 */
function interpreterFlags(tokens, end) {
  for (let index = 1; index < end; index += 1) {
    const token = tokens[index];
    if (token.startsWith("-")) continue;
    const previous = tokens[index - 1];
    const flagValue =
      index > 1 &&
      previous.startsWith("-") &&
      !previous.includes("=") &&
      !SCRIPT_FILE.test(token);
    if (!flagValue) return false;
  }
  return true;
}

/**
 * The cairn subcommand: the first argument after the script that is not a
 * global flag (or a global flag's value).
 * @param {string[]} rest
 * @returns {string | null}
 */
function subcommandOf(rest) {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (CAIRN_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

/**
 * Parse a `ps` command line as a cairn process, or null when it is not one.
 * The executable itself is `cairn` (the compiled binary, `…/bin/cairn`), or
 * an interpreter (bun, node, a shell) whose script — after the
 * interpreter's own flags — is. Only the head of the command counts:
 * `vim bin/cairn` is not cairn. Paths with spaces are accepted when they
 * name an existing file.
 * @param {string} command
 * @param {{ fileExists?: (file: string) => boolean }} [options]
 * @returns {{ subcommand: string | null } | null}
 */
function parseCairnCommand(command, options = {}) {
  const fileExists = options.fileExists ?? isRegularFile;
  const tokens = String(command ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const interpreted = INTERPRETER.test(baseName(tokens[0]));
  for (let end = 0; end < tokens.length; end += 1) {
    if (baseName(tokens[end]) !== "cairn") continue;
    const rest = () => ({ subcommand: subcommandOf(tokens.slice(end + 1)) });
    // The compiled binary (or a `cairn` on PATH) is the executable.
    if (spellsCairn(tokens, 0, end, fileExists)) return rest();
    if (!interpreted) continue;
    for (let start = 1; start <= end; start += 1)
      if (
        interpreterFlags(tokens, start) &&
        spellsCairn(tokens, start, end, fileExists)
      )
        return rest();
  }
  return null;
}

/**
 * Is this command line a cairn process? (See `parseCairnCommand`.)
 * @param {string} command
 * @param {{ fileExists?: (file: string) => boolean }} [options]
 * @returns {boolean}
 */
function isCairnCommand(command, options) {
  return parseCairnCommand(command, options) !== null;
}

/**
 * `ps` facts about a pid (no shell), or null when no such process exists.
 * `pgid` tells whether the process leads its own process group (a terminal
 * job, a Studio run), so Stop can signal that group the way Ctrl-C does.
 * @param {number} pid
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<ProcessInfo | null>}
 */
function readProcessInfo(pid, options = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(null);
      return;
    }
    execFile(
      "ps",
      ["-o", "pgid=,etime=,command=", "-p", String(pid)],
      { timeout: options.timeoutMs ?? 5000, windowsHide: true },
      (error, stdout) => {
        // ps exits 1 (and prints nothing) when the pid does not exist.
        if (error && !String(stdout ?? "").trim()) {
          resolve(null);
          return;
        }
        resolve(parsePsLine(String(stdout ?? "")));
      },
    );
  });
}

/** The cairn subcommands that write invocation journals. */
const JOURNAL_SUBCOMMANDS = new Set(["run", "mcp"]);

/**
 * @typedef {{
 *   ok: boolean,
 *   pid?: number,
 *   command?: string,
 *   subcommand?: string,
 *   mcp?: boolean,
 *   group?: boolean,
 *   reason?: string,
 * }} StopVerdict
 */

/**
 * May Studio send SIGINT to this invocation's process? Only when the journal
 * says "running" and has a start time, its pid is alive and matches the pid
 * in its own id, the process is a `cairn run` or `cairn mcp` command line
 * that agrees with the journal's origin, and that process started no later
 * than the journal did (a pid the OS reused for a newer process fails that;
 * so does a journal without a start time, since the runner always writes
 * one). Anything else is refused with the reason.
 *
 * An `ok` verdict also says what the signal reaches. `mcp`: the process is
 * an MCP server (from its command line, or the journal's origin), so SIGINT
 * ends every run it drives. `group`: the process leads its own process
 * group (a terminal job, a Studio-launched run) and Studio is not in it, so
 * the group is signalled like Ctrl-C does, hook subprocesses included; when
 * false, the group belongs to whatever launched cairn (an agent host, a
 * non-interactive shell) and only the pid is signalled.
 * @param {InvocationSummary | null} invocation
 * @param {ProcessInfo | null} processInfo
 * @param {{ now?: number, selfPid?: number, selfPgid?: number | null, fileExists?: (file: string) => boolean }} [options]
 * @returns {StopVerdict}
 */
function checkStoppable(invocation, processInfo, options = {}) {
  if (!invocation) return { ok: false, reason: "unknown invocation" };
  if (invocation.status !== "running" || !invocation.alive)
    return {
      ok: false,
      reason: `invocation already ended (status ${invocation.status})`,
    };
  const pid = invocation.pid;
  const selfPid = options.selfPid ?? process.pid;
  if (!pid || pid <= 1 || pid === selfPid)
    return { ok: false, reason: `refusing to signal pid ${pid ?? "?"}` };
  const idPid = invocationIdPid(invocation.invocationId);
  if (idPid !== null && idPid !== pid)
    return {
      ok: false,
      reason: `journal pid ${pid} does not match the pid in its id (${idPid})`,
    };
  const startedAtMs = Date.parse(invocation.startedAt ?? "");
  if (!Number.isFinite(startedAtMs))
    return {
      ok: false,
      reason:
        "the journal has no start time, so a reused pid cannot be ruled out",
    };
  if (!processInfo) return { ok: false, reason: `process ${pid} is gone` };
  const parsed = parseCairnCommand(processInfo.command, {
    fileExists: options.fileExists,
  });
  if (!parsed)
    return {
      ok: false,
      reason: `process ${pid} is not a cairn process: ${processInfo.command.slice(0, 160)}`,
    };
  const subcommand = parsed.subcommand ?? "";
  if (!JOURNAL_SUBCOMMANDS.has(subcommand))
    return {
      ok: false,
      reason: `process ${pid} is \`cairn ${subcommand || "(no command)"}\`, which runs no invocations`,
    };
  const origin = invocation.origin;
  const expected = origin === "cli" ? "run" : origin === "mcp" ? "mcp" : null;
  if (expected && subcommand !== expected)
    return {
      ok: false,
      reason: `the journal says origin "${origin}" but process ${pid} is \`cairn ${subcommand}\``,
    };
  const now = options.now ?? Date.now();
  if (now - processInfo.elapsedMs > startedAtMs + START_SLACK_MS)
    return {
      ok: false,
      reason: `process ${pid} started after this invocation did (pid reused)`,
    };
  return {
    ok: true,
    pid,
    command: processInfo.command,
    subcommand,
    mcp: subcommand === "mcp" || origin === "mcp",
    group: processInfo.pgid === pid && options.selfPgid !== pid,
  };
}

module.exports = {
  findRunningInvocationByPid,
  INVOCATION_ID_PATTERN,
  isInvocationId,
  invocationDir,
  journalOrigin,
  journalClient,
  readInvocation,
  listInvocations,
  listJournalLogs,
  estimateInvocationEta,
  invocationIdPid,
  parseEtime,
  parsePsLine,
  parseCairnCommand,
  isCairnCommand,
  readProcessInfo,
  checkStoppable,
};
