/**
 * Run-policy and operations plumbing: suites, config vars, orphan browser
 * sessions, service windows (restart / logs), and the config `run:` lock.
 *
 * Studio owns none of it. Every action is one `cairn` command with an
 * allow-listed argv (`buildSuitesArgv`, `buildConfigVarsArgv`,
 * `buildOrphansArgv`, `buildServicesRestartArgv`, `buildServicesLogsArgv`; a
 * value the renderer typed travels as one entry joined to its flag, never a
 * shell string), and every screen renders the JSON the command printed after
 * a field-by-field normalisation here: arrays default to `[]`, numbers are
 * finite, strings are bounded, credential-shaped text is masked again (the
 * CLI already redacts; this is the second belt), and a payload that is not
 * the expected document reads as null so an older or failing CLI degrades to
 * a message, not an exception.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const CairnEvents = require("./events");
const {
  checkEnvName,
  looksUnsupported,
  describeServicesLock,
} = require("./authoring");
const { checkSuiteName } = require("./cli");
const { parseEtime } = require("./invocations");
const { isPidAlive } = require("./runs");

/** A service window name the renderer may pass on. */
const WINDOW_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,79}$/;
/** `cairn services logs --lines` bounds. */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;
/** One captured log line, before it is cut. */
const MAX_LOG_LINE_CHARS = 2000;
/** A run lock file is a few hundred bytes. */
const MAX_LOCK_BYTES = 64 * 1024;

/**
 * @param {unknown} value
 * @returns {string}
 */
function checkWindowName(value) {
  const name = String(value ?? "").trim();
  if (!WINDOW_NAME_PATTERN.test(name))
    throw new Error(`invalid service window name: ${name || "(empty)"}`);
  return name;
}

/**
 * @param {string | null | undefined} config
 * @returns {string[]} `--config=<abs>` or nothing
 */
function configFlag(config) {
  return config ? [`--config=${path.resolve(config)}`] : [];
}

/**
 * `cairn suites list [--env=<name>] [--config=<file>] --json`.
 * @param {{ env?: unknown, config?: string | null }} [options]
 * @returns {string[]}
 */
function buildSuitesArgv(options = {}) {
  const argv = ["suites", "list"];
  if (options.env !== undefined && options.env !== null && options.env !== "")
    argv.push(`--env=${checkEnvName(options.env)}`);
  argv.push(...configFlag(options.config), "--json");
  return argv;
}

/**
 * `cairn config vars [--env=<name>] [--unused] [--config=<file>] --json`.
 * @param {{ env?: unknown, unused?: boolean, config?: string | null }} [options]
 * @returns {string[]}
 */
function buildConfigVarsArgv(options = {}) {
  const argv = ["config", "vars"];
  if (options.env !== undefined && options.env !== null && options.env !== "")
    argv.push(`--env=${checkEnvName(options.env)}`);
  if (options.unused) argv.push("--unused");
  argv.push(...configFlag(options.config), "--json");
  return argv;
}

/** A session name or pid `--only` may carry (no flag or shell smuggling). */
const ORPHAN_TOKEN_PATTERN = /^(?:[1-9]\d{0,9}|[A-Za-z][A-Za-z0-9_.-]{0,159})$/;

/**
 * `cairn doctor --orphans --json`, or with `kill` also `--kill --yes` (the
 * confirmation is Studio's own native dialog, so the CLI must not prompt).
 * `only` (session names and pids) limits the kill to exactly what the user
 * confirmed: an orphan that appeared or changed after the listing is left
 * alone.
 * @param {{ kill?: boolean, only?: Array<string | number> }} [options]
 * @returns {string[]}
 */
function buildOrphansArgv(options = {}) {
  const argv = ["doctor", "--orphans"];
  if (options.kill) argv.push("--kill", "--yes");
  if (options.only !== undefined) {
    const tokens = options.only.map((token) => String(token));
    for (const token of tokens) {
      if (!ORPHAN_TOKEN_PATTERN.test(token))
        throw new Error(`invalid orphan session or pid: ${token.slice(0, 40)}`);
    }
    if (tokens.length === 0)
      throw new Error("an --only list needs at least one session or pid");
    argv.push(`--only=${tokens.join(",")}`);
  }
  argv.push("--json");
  return argv;
}

/**
 * The `--only` set of a confirmed orphan listing: every session name and
 * every pid it showed.
 * @param {{ orphans: Array<{ session: string, processes: Array<{ pid: number }> }> }} listing
 * @returns {Array<string | number>}
 */
function confirmedOrphanSet(listing) {
  /** @type {Array<string | number>} */
  const out = [];
  for (const orphan of listing.orphans) {
    if (ORPHAN_TOKEN_PATTERN.test(orphan.session)) out.push(orphan.session);
    for (const proc of orphan.processes) out.push(proc.pid);
  }
  return out;
}

/**
 * `cairn services restart <window> --env=<name> [--config=<file>] --json`.
 * One window per call.
 * @param {{ window: unknown, env: unknown, config?: string | null }} options
 * @returns {string[]}
 */
function buildServicesRestartArgv(options) {
  return [
    "services",
    "restart",
    checkWindowName(options?.window),
    `--env=${checkEnvName(options?.env)}`,
    ...configFlag(options?.config),
    "--json",
  ];
}

/**
 * `cairn services logs <window> --env=<name> [--since-restart] --lines=<n>
 * [--config=<file>] --json` (never `--follow` / `--wait`: a read, bounded).
 * @param {{ window: unknown, env: unknown, config?: string | null, sinceRestart?: boolean, lines?: unknown }} options
 * @returns {string[]}
 */
function buildServicesLogsArgv(options) {
  const asked = Math.trunc(Number(options?.lines));
  const lines = Number.isFinite(asked)
    ? Math.min(MAX_LOG_LINES, Math.max(1, asked))
    : DEFAULT_LOG_LINES;
  const argv = [
    "services",
    "logs",
    checkWindowName(options?.window),
    `--env=${checkEnvName(options?.env)}`,
  ];
  if (options?.sinceRestart) argv.push("--since-restart");
  argv.push(`--lines=${lines}`, ...configFlag(options?.config), "--json");
  return argv;
}

// ── payload normalisers ──────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string | null}
 */
function line(value, max = 400) {
  if (typeof value !== "string" || !value) return null;
  return CairnEvents.maskValue(null, value, max);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function strings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `cairn suites list --json` (`urn:cairntrace.dev:suites:v1`) as Studio
 * shows it; null when it is not that document.
 * @param {unknown} payload
 * @returns {{ project: string | null, root: string | null, env: string | null, suites: Array<{ name: string, description: string | null, specs: string[], tags: string[], order: string[], parallel: number | null, bail: boolean, requiresEnv: string[], requiresVars: string[], seedSkip: string[], envs: Array<{ env: string, specs: string[], problem: string | null, vars: string[], before: number, after: number, hookTimeoutMs: number | null }> }>, warnings: string[] } | null}
 */
function normalizeSuites(payload) {
  const doc = /** @type {any} */ (payload);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.suites))
    return null;
  const suites = [];
  for (const suite of doc.suites) {
    if (!suite || typeof suite !== "object" || typeof suite.name !== "string")
      continue;
    suites.push({
      name: suite.name,
      description: line(suite.description, 600),
      specs: strings(suite.specs),
      tags: strings(suite.tags),
      order: strings(suite.order),
      parallel: finiteNumber(suite.parallel),
      bail: suite.bail === true,
      requiresEnv: strings(suite.requires?.env),
      requiresVars: strings(suite.requires?.vars),
      seedSkip: strings(suite.seedSkip),
      envs: (Array.isArray(suite.envs) ? suite.envs : [])
        .filter(
          (/** @type {any} */ entry) =>
            entry && typeof entry === "object" && typeof entry.env === "string",
        )
        .map((/** @type {any} */ entry) => ({
          env: entry.env,
          specs: strings(entry.specs),
          problem: line(entry.problem, 600),
          vars: strings(entry.vars),
          before: Math.max(0, Math.trunc(finiteNumber(entry.before) ?? 0)),
          after: Math.max(0, Math.trunc(finiteNumber(entry.after) ?? 0)),
          hookTimeoutMs: finiteNumber(entry.hookTimeoutMs),
        })),
    });
  }
  return {
    project: typeof doc.project === "string" ? doc.project : null,
    root: typeof doc.root === "string" ? doc.root : null,
    env: typeof doc.env === "string" ? doc.env : null,
    suites,
    warnings: strings(doc.warnings).map((entry) => line(entry, 400) ?? ""),
  };
}

/** What a masked config var shows in place of its value. */
const MASKED = "••••••";

/**
 * `cairn config vars --json` (`urn:cairntrace.dev:config-vars:v1`) as Studio
 * shows it. A value the CLI masked stays masked (`display` is bullets, the
 * value never leaves this function), and Studio masks a value whose var name
 * looks like a credential even when the CLI did not flag it, plus any
 * credential-shaped text. Null when it is not that document.
 * @param {unknown} payload
 * @returns {{ ok: boolean, path: string | null, files: string[], environments: string[], filter: Record<string, any> | null, totals: Record<string, number>, vars: Array<{ name: string, kind: string, sameInAllEnvironments: boolean, unused: boolean, values: Array<{ env: string, display: string, masked: boolean, scope: string, at: string, template: string | null }>, definedAt: Array<{ scope: string, at: string, inheritedFrom: string | null }>, overriddenBy: Array<{ scope: string, at: string, envs: string[] }>, usedBy: Array<{ kind: string, name: string, file: string }> }>, findings: Array<{ level: string, code: string, message: string, at: string | null }>, errors: string[], warnings: string[] } | null}
 */
function normalizeConfigVars(payload) {
  const doc = /** @type {any} */ (payload);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.vars)) return null;
  const vars = [];
  for (const row of doc.vars) {
    if (!row || typeof row !== "object" || typeof row.name !== "string")
      continue;
    const secretName = CairnEvents.isSecretKey(row.name);
    const values = Object.entries(
      row.values && typeof row.values === "object" ? row.values : {},
    ).map(([env, entry]) => {
      const value = /** @type {any} */ (entry) ?? {};
      const masked = value.masked === true || secretName;
      return {
        env,
        display: masked
          ? MASKED
          : CairnEvents.maskValue(row.name, value.value, 300),
        masked,
        scope: String(value.scope ?? ""),
        at: String(value.at ?? ""),
        // the authored text keeps `${…}` references; masked when it was
        template: masked ? null : line(value.template, 300),
      };
    });
    vars.push({
      name: row.name,
      kind: typeof row.kind === "string" ? row.kind : "mixed",
      sameInAllEnvironments: row.sameInAllEnvironments === true,
      unused: row.unused === true,
      values,
      definedAt: (Array.isArray(row.definedAt) ? row.definedAt : []).map(
        (/** @type {any} */ entry) => ({
          scope: String(entry?.scope ?? ""),
          at: String(entry?.at ?? ""),
          inheritedFrom:
            typeof entry?.inheritedFrom === "string"
              ? entry.inheritedFrom
              : null,
        }),
      ),
      overriddenBy: (Array.isArray(row.overriddenBy)
        ? row.overriddenBy
        : []
      ).map((/** @type {any} */ entry) => ({
        scope: String(entry?.scope ?? ""),
        at: String(entry?.at ?? ""),
        envs: strings(entry?.envs),
      })),
      usedBy: (Array.isArray(row.usedBy) ? row.usedBy : []).map(
        (/** @type {any} */ entry) => ({
          kind: String(entry?.kind ?? ""),
          name: String(entry?.name ?? ""),
          file: String(entry?.file ?? ""),
        }),
      ),
    });
  }
  const totals = /** @type {Record<string, number>} */ ({});
  for (const [key, value] of Object.entries(doc.totals ?? {})) {
    const number = finiteNumber(value);
    if (number !== null) totals[key] = number;
  }
  return {
    ok: doc.ok !== false,
    path: typeof doc.path === "string" ? doc.path : null,
    files: strings(doc.files),
    environments: strings(doc.environments),
    filter:
      doc.filter && typeof doc.filter === "object"
        ? {
            env: typeof doc.filter.env === "string" ? doc.filter.env : null,
            unused: doc.filter.unused === true,
          }
        : null,
    totals,
    vars,
    findings: (Array.isArray(doc.findings) ? doc.findings : []).map(
      (/** @type {any} */ entry) => ({
        level: String(entry?.level ?? "info"),
        code: String(entry?.code ?? ""),
        message: line(entry?.message, 500) ?? "",
        at: typeof entry?.at === "string" ? entry.at : null,
      }),
    ),
    errors: strings(doc.errors).map((entry) => line(entry, 500) ?? ""),
    warnings: strings(doc.warnings).map((entry) => line(entry, 500) ?? ""),
  };
}

/**
 * `cairn doctor --orphans --json` (`urn:cairntrace.dev:doctor-orphans:v1`)
 * as Studio shows it; null when it is not that document.
 * @param {unknown} payload
 * @returns {{ ok: boolean, exitCode: number | null, orphans: Array<{ session: string, backend: string, invocationId: string, ownerPid: number | null, startedAt: string | null, projectDir: string | null, killed: boolean | null, processes: Array<{ pid: number, command: string }> }>, staleEntriesRemoved: number, liveSessions: number, killRequested: boolean, killed: number, remaining: number[], error: string | null } | null}
 */
function normalizeOrphans(payload) {
  const doc = /** @type {any} */ (payload);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.orphans))
    return null;
  return {
    ok: doc.ok === true,
    exitCode: finiteNumber(doc.exitCode),
    orphans: doc.orphans
      .filter(
        (/** @type {any} */ entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.session === "string",
      )
      .map((/** @type {any} */ entry) => ({
        session: entry.session,
        backend: typeof entry.backend === "string" ? entry.backend : "?",
        invocationId:
          typeof entry.invocationId === "string" ? entry.invocationId : "?",
        ownerPid: finiteNumber(entry.ownerPid),
        startedAt: typeof entry.startedAt === "string" ? entry.startedAt : null,
        projectDir:
          typeof entry.projectDir === "string" ? entry.projectDir : null,
        killed: typeof entry.killed === "boolean" ? entry.killed : null,
        processes: (Array.isArray(entry.processes) ? entry.processes : [])
          .filter(
            (/** @type {any} */ proc) =>
              proc && Number.isInteger(proc.pid) && proc.pid > 0,
          )
          .map((/** @type {any} */ proc) => ({
            pid: proc.pid,
            command: line(proc.command, 300) ?? "",
          })),
      })),
    staleEntriesRemoved: Math.max(
      0,
      Math.trunc(finiteNumber(doc.staleEntriesRemoved) ?? 0),
    ),
    liveSessions: Math.max(0, Math.trunc(finiteNumber(doc.liveSessions) ?? 0)),
    killRequested: doc.killRequested === true,
    killed: Math.max(0, Math.trunc(finiteNumber(doc.killed) ?? 0)),
    remaining: (Array.isArray(doc.remaining) ? doc.remaining : []).filter(
      (/** @type {any} */ pid) => Number.isInteger(pid) && pid > 0,
    ),
    error: line(doc.error, 500),
  };
}

/**
 * The parts of `cairn services status --json` the service-windows panel
 * shows: tmux windows (name and health; never the pane text), tunnels,
 * the provisioner's export *names*, seed and docker state. Null when the
 * payload is not a status document.
 * @param {unknown} payload
 * @returns {{ hasServices: boolean, project: string | null, env: string | null, tmux: { configured: boolean, sessionExists: boolean, session: string | null, windows: Array<{ name: string, healthy: boolean | null }> }, docker: { configured: boolean, running: boolean }, seed: { configured: boolean, expired: boolean, lastRunAt: string | null }, tunnels: Array<{ name: string, state: string, running: boolean, pid: number | null, restarts: number }>, provisioner: { exports: string[] } | null, errors: string[] } | null}
 */
function normalizeServicesStatus(payload) {
  const doc = /** @type {any} */ (payload);
  if (!doc || typeof doc !== "object" || typeof doc.hasServices !== "boolean")
    return null;
  return {
    hasServices: doc.hasServices,
    project: typeof doc.project === "string" ? doc.project : null,
    env: typeof doc.env === "string" ? doc.env : null,
    tmux: {
      configured: doc.tmux?.configured === true,
      sessionExists: doc.tmux?.sessionExists === true,
      session: typeof doc.tmux?.session === "string" ? doc.tmux.session : null,
      windows: (Array.isArray(doc.tmux?.windows) ? doc.tmux.windows : [])
        .filter(
          (/** @type {any} */ entry) =>
            entry &&
            typeof entry.name === "string" &&
            WINDOW_NAME_PATTERN.test(entry.name),
        )
        .map((/** @type {any} */ entry) => ({
          name: entry.name,
          healthy: typeof entry.healthy === "boolean" ? entry.healthy : null,
        })),
    },
    docker: {
      configured: doc.docker?.configured === true,
      running: doc.docker?.running === true,
    },
    seed: {
      configured: doc.seed?.configured === true,
      expired: doc.seed?.expired !== false,
      lastRunAt:
        typeof doc.seed?.lastRunAt === "string" ? doc.seed.lastRunAt : null,
    },
    tunnels: (Array.isArray(doc.tunnels) ? doc.tunnels : [])
      .filter(
        (/** @type {any} */ entry) =>
          entry && typeof entry === "object" && typeof entry.name === "string",
      )
      .map((/** @type {any} */ entry) => ({
        name: entry.name,
        state: typeof entry.state === "string" ? entry.state : "unknown",
        running: entry.running === true,
        pid: Number.isInteger(entry.pid) ? entry.pid : null,
        restarts: Math.max(0, Math.trunc(finiteNumber(entry.restarts) ?? 0)),
      })),
    provisioner:
      doc.provisioner && typeof doc.provisioner === "object"
        ? { exports: strings(doc.provisioner.exports) }
        : null,
    errors: strings(doc.errors).map((entry) => line(entry, 400) ?? ""),
  };
}

/**
 * `cairn services restart --json` (`urn:cairntrace.dev:services-restart:v1`).
 * @param {unknown} payload
 * @returns {{ ok: boolean, exitCode: number | null, session: string | null, windows: Array<{ window: string, ok: boolean, alreadyStopped: boolean, durationMs: number | null, error: string | null, skipped: boolean }>, warnings: string[], error: string | null, durationMs: number | null } | null}
 */
function normalizeRestart(payload) {
  const doc = /** @type {any} */ (payload);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.windows))
    return null;
  return {
    ok: doc.ok === true,
    exitCode: finiteNumber(doc.exitCode),
    session: typeof doc.session === "string" ? doc.session : null,
    windows: doc.windows
      .filter(
        (/** @type {any} */ entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.window === "string",
      )
      .map((/** @type {any} */ entry) => ({
        window: entry.window,
        ok: entry.ok === true,
        alreadyStopped: entry.alreadyStopped === true,
        durationMs: finiteNumber(entry.durationMs),
        error: line(entry.error, 500),
        skipped: entry.skipped === true,
      })),
    warnings: strings(doc.warnings).map((entry) => line(entry, 400) ?? ""),
    error: line(doc.error, 600),
    durationMs: finiteNumber(doc.durationMs),
  };
}

/**
 * `cairn services logs --json` (`urn:cairntrace.dev:services-logs:v1`): the
 * redacted pane text, masked again and bounded.
 * @param {unknown} payload
 * @returns {{ ok: boolean, exitCode: number | null, window: string | null, session: string | null, lines: string[], totalLines: number, sinceRestart: { requested: boolean, found: boolean }, warnings: string[], error: string | null } | null}
 */
function normalizeLogs(payload) {
  const doc = /** @type {any} */ (payload);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.lines)) return null;
  const lines = doc.lines
    .slice(-MAX_LOG_LINES)
    .map((/** @type {unknown} */ entry) =>
      CairnEvents.maskValue(null, String(entry ?? ""), MAX_LOG_LINE_CHARS),
    );
  return {
    ok: doc.ok === true,
    exitCode: finiteNumber(doc.exitCode),
    window: typeof doc.window === "string" ? doc.window : null,
    session: typeof doc.session === "string" ? doc.session : null,
    lines,
    totalLines: Math.max(
      0,
      Math.trunc(finiteNumber(doc.totalLines) ?? lines.length),
    ),
    sinceRestart: {
      requested: doc.sinceRestart?.requested === true,
      found: doc.sinceRestart?.found === true,
    },
    warnings: strings(doc.warnings).map((entry) => line(entry, 400) ?? ""),
    error: line(doc.error, 600),
  };
}

// ── native confirmations ─────────────────────────────────────────────────────

/**
 * The confirmation for `cairn services restart`.
 * @param {{ window: string, env: string, lock: Record<string, any> | null, policy?: Record<string, any> | null, cli: string }} input
 * @returns {{ message: string, detail: string, confirmLabel: string }}
 */
function restartDialog(input) {
  const trait = input.policy?.trait ?? null;
  const lines = [
    `cairn services restart sends Ctrl-C to the "${input.window}" window, waits for its process to exit (never a hard kill), clears the history, starts the window's command again and waits for its readyOn. Anything that service is doing right now is interrupted.`,
    "",
    `Environment: ${input.env}${trait ? ` (${trait})` : ""}`,
    `Services lock now: ${describeServicesLock(input.lock)}`,
  ];
  if (trait === "shared" || trait === "protected")
    lines.push(
      `This environment is ${trait}: other people may depend on this service.`,
    );
  lines.push("", input.cli);
  return {
    message: `Restart "${input.window}" in "${input.env}"?`,
    detail: lines.join("\n"),
    confirmLabel: "Restart",
  };
}

/**
 * The confirmation for `cairn doctor --orphans --kill --yes`: every session
 * and every process it would end, as the CLI just listed them.
 * @param {{ orphans: Array<{ session: string, backend: string, invocationId: string, ownerPid: number | null, processes: Array<{ pid: number, command: string }> }>, cli: string }} input
 * @returns {{ message: string, detail: string, confirmLabel: string }}
 */
function orphansDialog(input) {
  const processes = input.orphans.reduce(
    (total, entry) => total + entry.processes.length,
    0,
  );
  const lines = [
    "These browser sessions were started by cairn runs that are gone, and their browsers are still running. Ending a process cannot be undone.",
    "",
  ];
  for (const entry of input.orphans.slice(0, 12)) {
    lines.push(
      `${entry.session} (${entry.backend}) — invocation ${entry.invocationId}, owner pid ${entry.ownerPid ?? "?"} gone`,
    );
    for (const proc of entry.processes.slice(0, 4))
      lines.push(`  pid ${proc.pid}  ${proc.command.slice(0, 120)}`);
    if (entry.processes.length > 4)
      lines.push(`  … and ${entry.processes.length - 4} more`);
  }
  if (input.orphans.length > 12)
    lines.push(`… and ${input.orphans.length - 12} more session(s)`);
  lines.push(
    "",
    "Only processes the owned-session ledger names, and that still look like a browser, are signalled; sessions whose run is still going are never touched.",
    "",
    input.cli,
  );
  return {
    message: `End ${processes} browser process(es) of ${input.orphans.length} orphaned session(s)?`,
    detail: lines.join("\n"),
    confirmLabel: "End processes",
  };
}

// ── the config `run:` lock ───────────────────────────────────────────────────

/**
 * The directory the CLI keeps run locks in (`~/.cairntrace/locks`).
 * @param {string} [home]
 * @returns {string}
 */
function runLockRoot(home = os.homedir()) {
  return path.join(home, ".cairntrace", "locks");
}

/**
 * The scope keys one project's lock files carry: the config file's canonical
 * path (`run.lock.scope: config`, the default) and `project:<name>`
 * (`scope: project`). The lock file stores its key, so Studio matches on it
 * and never needs the CLI's hashed file name.
 * @param {{ configPath: string | null, project: string | null }} input
 * @returns {string[]}
 */
function runLockKeys(input) {
  const keys = [];
  if (input.configPath) {
    let canonical = path.resolve(input.configPath);
    try {
      canonical = fs.realpathSync(canonical);
    } catch {
      // the config vanished: the resolved path still matches a lock that named it so
    }
    keys.push(canonical);
  }
  if (input.project) keys.push(`project:${input.project}`);
  return keys;
}

/**
 * Seconds a process has run (`ps -o etime=`), or null. No shell.
 * @param {number} pid
 * @returns {number | null}
 */
function processElapsedMs(pid) {
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseEtime(out);
  } catch {
    return null;
  }
}

/**
 * @param {number} ms
 * @returns {string}
 */
function ageText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * @typedef {{
 *   path: string, absolute: string, exists: true, kind: "run-lock",
 *   owner: string, ageMs: number, pid: number, alive: true,
 *   origin: string | null, env: string | null, invocationId: string | null,
 *   startedAt: string | null, scope: string | null, command: string | null,
 * }} RunLockEntry
 */

/**
 * The live run locks held for a project: lock files under `lockDir` whose
 * key is the project's config path (or `project:<name>`) and whose owner
 * process is still the one that took it (a recycled pid, a process younger
 * than the lock, does not count — the CLI's own rule). A dead owner's lock
 * does not block: `cairn run` reclaims it. The entries are shaped like the
 * suite-lock entries (`path`, `owner`, `ageMs`), so every gate that already
 * handles a held suite lock handles these.
 * @param {{ lockDir?: string, keys: string[], now?: number, pidAlive?: (pid: number) => boolean | null, elapsedMs?: (pid: number) => number | null }} options
 * @returns {RunLockEntry[]}
 */
function readRunLocks(options) {
  const dir = options.lockDir ?? runLockRoot();
  const now = options.now ?? Date.now();
  const alive = options.pidAlive ?? isPidAlive;
  const elapsedOf = options.elapsedMs ?? processElapsedMs;
  if (!options.keys.length) return [];
  let names;
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".run.lock.json"));
  } catch {
    return [];
  }
  /** @type {RunLockEntry[]} */
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let doc;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) continue;
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;
    if (typeof doc.key !== "string" || !options.keys.includes(doc.key))
      continue;
    const pid = doc.pid;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (alive(pid) !== true) continue;
    const startedMs = Date.parse(String(doc.startedAt ?? ""));
    const ageMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
    // a recycled pid: the live process is younger than the lock it wrote
    const elapsed = elapsedOf(pid);
    if (elapsed !== null && elapsed + 5000 < ageMs) continue;
    const origin =
      doc.origin === "cli" || doc.origin === "mcp" ? doc.origin : null;
    const env = typeof doc.env === "string" ? doc.env : null;
    const invocationId =
      typeof doc.invocationId === "string" ? doc.invocationId : null;
    const bits = [
      origin,
      invocationId ? `invocation ${invocationId}` : null,
      env ? `env "${env}"` : null,
    ].filter(Boolean);
    const argv = Array.isArray(doc.argv)
      ? doc.argv.filter((/** @type {unknown} */ arg) => typeof arg === "string")
      : [];
    out.push({
      path: file,
      absolute: file,
      exists: true,
      kind: "run-lock",
      owner: `pid ${pid}${
        bits.length ? ` (${bits.join(", ")})` : ""
      }, running for ${ageText(ageMs)}`,
      ageMs,
      pid,
      alive: true,
      origin,
      env,
      invocationId,
      startedAt: typeof doc.startedAt === "string" ? doc.startedAt : null,
      scope: doc.scope === "project" ? "project" : "config",
      command: argv.length
        ? CairnEvents.maskValue(null, `cairn ${argv.join(" ")}`, 240)
        : null,
    });
  }
  return out.toSorted((a, b) => b.ageMs - a.ageMs);
}

module.exports = {
  WINDOW_NAME_PATTERN,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  MASKED,
  checkSuiteName,
  checkWindowName,
  buildSuitesArgv,
  buildConfigVarsArgv,
  buildOrphansArgv,
  confirmedOrphanSet,
  buildServicesRestartArgv,
  buildServicesLogsArgv,
  normalizeSuites,
  normalizeConfigVars,
  normalizeOrphans,
  normalizeServicesStatus,
  normalizeRestart,
  normalizeLogs,
  looksUnsupported,
  restartDialog,
  orphansDialog,
  runLockRoot,
  runLockKeys,
  readRunLocks,
};
