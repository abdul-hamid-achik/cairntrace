/**
 * Cairn CLI plumbing for the desktop app.
 *
 * The app never reimplements cairn behaviour: every action shells out to the
 * same `cairn` binary an agent would use, with `--format json` on stdout and
 * `--log-format json` narration on stderr. This module owns binary discovery,
 * argv construction, and stream decoding so both stay reviewable and testable
 * without spawning anything.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Directories a Finder-launched app never inherits but a dev shell always has.
 * Computed per call so a changed `$HOME` (tests, portable setups) is honoured.
 * @param {string} [home]
 * @returns {string[]}
 */
function extraPathDirs(home = os.homedir()) {
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, "bin"),
    "/usr/local/go/bin",
  ];
}

/** Directories a Finder-launched app never inherits but a dev shell always has. */
const EXTRA_PATH_DIRS = extraPathDirs();

/**
 * Build an env whose PATH also covers the usual per-user/toolchain bin dirs.
 * GUI processes on macOS start with a near-empty PATH, which would hide
 * `cairn`, `bun`, `docker`, `agent-browser`, and Go tools like `codemap`
 * from every spawned command.
 *
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
function augmentedEnv(base = process.env) {
  const sep = process.platform === "win32" ? ";" : ":";
  const extra = extraPathDirs();
  const current = String(base.PATH ?? base.Path ?? "")
    .split(sep)
    .filter(Boolean);
  const merged = [...current];
  for (const dir of extra) if (!merged.includes(dir)) merged.push(dir);
  return {
    ...base,
    PATH: merged.join(sep),
    // Never let a spawned cairn inherit a TTY-only progress renderer.
    NO_COLOR: base.NO_COLOR ?? "1",
    FORCE_COLOR: "0",
    CI: base.CI ?? "",
  };
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable by name on PATH.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
function which(name, env = process.env) {
  if (!name) return null;
  if (name.includes(path.sep) || name.startsWith("."))
    return isExecutableFile(name) ? path.resolve(name) : null;
  const sep = process.platform === "win32" ? ";" : ":";
  const extensions =
    process.platform === "win32"
      ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const dir of String(env.PATH ?? "")
    .split(sep)
    .filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve which `cairn` the app should drive.
 *
 * Order: explicit user setting → PATH → the repo checkout this app was
 * launched from (dev mode) → an installed npm global copy.
 *
 * @param {{ configured?: string | null, repoRoot?: string | null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ command: string | null, source: "settings" | "path" | "repo" | "none", candidates: string[] }}
 */
function resolveCairn(options = {}) {
  const env = options.env ?? process.env;
  const candidates = [];
  const configured = options.configured?.trim();
  if (configured) {
    const resolved =
      configured.includes(path.sep) || configured.startsWith(".")
        ? path.resolve(configured)
        : which(configured, env);
    if (resolved && isExecutableFile(resolved))
      return { command: resolved, source: "settings", candidates };
    candidates.push(configured);
  }
  const onPath = which("cairn", env);
  if (onPath) return { command: onPath, source: "path", candidates };
  if (options.repoRoot) {
    const repoBin = path.join(options.repoRoot, "bin", "cairn");
    if (isExecutableFile(repoBin))
      return { command: repoBin, source: "repo", candidates };
    candidates.push(repoBin);
  }
  return { command: null, source: "none", candidates };
}

/**
 * Turn `key=value` strings (or a plain array of values) into repeated flags.
 * @param {string} flag
 * @param {Array<string | { key?: string, value?: string }> | undefined} values
 * @returns {string[]}
 */
function repeated(flag, values) {
  const out = [];
  for (const entry of values ?? []) {
    if (entry === undefined || entry === null) continue;
    const text =
      typeof entry === "string"
        ? entry.trim()
        : `${entry.key ?? ""}=${entry.value ?? ""}`.trim();
    if (!text || text === "=") continue;
    out.push(flag, text);
  }
  return out;
}

/**
 * @param {{
 *   specs: string[],
 *   env?: string | null,
 *   backend?: string | null,
 *   provider?: string | null,
 *   device?: string | null,
 *   config?: string | null,
 *   artifactRoot?: string | null,
 *   headed?: boolean,
 *   coldStart?: boolean,
 *   mock?: boolean,
 *   monitor?: boolean,
 *   parallel?: number | null,
 *   noWebServer?: boolean,
 *   noServices?: boolean,
 *   stashOnFailure?: boolean,
 *   junit?: string | null,
 *   vars?: string[],
 *   labels?: string[],
 *   tags?: string[],
 *   logLevel?: string | null,
 * }} options
 * @returns {string[]}
 */
function buildRunArgv(options) {
  const specs = (options.specs ?? []).filter(Boolean);
  if (!specs.length) throw new Error("run requires at least one spec");
  const argv = ["run", ...specs];
  if (options.env) argv.push("--env", options.env);
  if (options.backend) argv.push("--backend", options.backend);
  if (options.provider) argv.push("--provider", options.provider);
  if (options.device) argv.push("--device", options.device);
  if (options.config) argv.push("--config", options.config);
  if (options.artifactRoot) argv.push("--artifact-root", options.artifactRoot);
  if (options.junit) argv.push("--junit", options.junit);
  if (options.headed) argv.push("--headed");
  if (options.coldStart) argv.push("--cold-start");
  if (options.mock) argv.push("--mock");
  if (options.monitor) argv.push("--monitor");
  if (options.noWebServer) argv.push("--no-web-server");
  if (options.noServices) argv.push("--no-services");
  if (options.stashOnFailure) argv.push("--stash-on-failure");
  if (typeof options.parallel === "number" && options.parallel > 1)
    argv.push("--parallel", String(options.parallel));
  argv.push(...repeated("--var", options.vars));
  argv.push(...repeated("--label", options.labels));
  argv.push(...repeated("--tag", options.tags));
  // Non-TTY narration + machine-readable logs: stdout stays the run payload.
  argv.push("--progress", "plain", "--format", "json", "--log-format", "json");
  argv.push("--log-level", options.logLevel ?? "info");
  return argv;
}

/**
 * @param {{ spec: string, config?: string | null, env?: string | null, stamp?: boolean, vars?: string[] }} options
 * @returns {string[]}
 */
function buildVerifyArgv(options) {
  const argv = ["spec", "verify", options.spec];
  if (options.config) argv.push("--config", options.config);
  if (options.env) argv.push("--env", options.env);
  if (options.stamp) argv.push("--stamp");
  argv.push(...repeated("--var", options.vars));
  argv.push("--format", "json");
  return argv;
}

/**
 * @param {{ spec: string, backend?: string | null, mock?: boolean, headed?: boolean, apply?: boolean, verify?: boolean, config?: string | null }} options
 * @returns {string[]}
 */
function buildHealArgv(options) {
  const argv = ["spec", "heal", options.spec];
  if (options.backend) argv.push("--backend", options.backend);
  if (options.config) argv.push("--config", options.config);
  if (options.mock) argv.push("--mock");
  if (options.headed) argv.push("--headed");
  if (options.apply) argv.push("--apply");
  if (options.verify) argv.push("--verify");
  argv.push("--format", "json");
  return argv;
}

/**
 * @param {{ groupBy: string, metric?: string | null, baseline?: string | null, limit?: number | null, labels?: string[], includeRuns?: boolean, artifactRoot?: string | null, config?: string | null }} options
 * @returns {string[]}
 */
function buildStatsArgv(options) {
  const groupBy = String(options.groupBy ?? "").trim();
  if (!groupBy) throw new Error("stats requires a --group-by label key");
  const argv = ["stats", "--group-by", groupBy];
  if (options.metric) argv.push("--metric", options.metric);
  if (options.baseline) argv.push("--baseline", options.baseline);
  if (typeof options.limit === "number" && options.limit > 0)
    argv.push("--limit", String(options.limit));
  if (options.includeRuns) argv.push("--include-runs");
  if (options.artifactRoot) argv.push("--artifact-root", options.artifactRoot);
  if (options.config) argv.push("--config", options.config);
  argv.push(...repeated("--label", options.labels));
  argv.push("--format", "json");
  return argv;
}

/**
 * @param {{ a: string, b: string, artifactRoot?: string | null, config?: string | null }} options
 * @returns {string[]}
 */
function buildDiffArgv(options) {
  const argv = ["diff", options.a, options.b];
  if (options.artifactRoot) argv.push("--artifact-root", options.artifactRoot);
  if (options.config) argv.push("--config", options.config);
  argv.push("--format", "json");
  return argv;
}

/**
 * Incremental NDJSON decoder. Tolerates partial trailing lines and non-JSON
 * noise (a stack trace printed by a crashing child, for example) by surfacing
 * it as a synthetic `{ level: "raw", msg }` entry instead of dropping it.
 */
function createLineDecoder() {
  let buffer = "";
  return {
    /**
     * @param {string} chunk
     * @returns {Array<Record<string, unknown>>}
     */
    push(chunk) {
      buffer += String(chunk ?? "");
      const out = [];
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        out.push(decodeLine(line));
      }
      return out;
    },
    /** @returns {Array<Record<string, unknown>>} */
    flush() {
      const line = buffer.trim();
      buffer = "";
      return line ? [decodeLine(line)] : [];
    },
  };
}

/**
 * @param {string} line
 * @returns {Record<string, unknown>}
 */
function decodeLine(line) {
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through to the raw wrapper
    }
  }
  return { level: "raw", msg: line };
}

/**
 * The last complete JSON document on stdout. `cairn --format json` pretty
 * prints, so the payload spans many lines and can be preceded by noise.
 * @param {string} stdout
 * @returns {unknown | null}
 */
function parseJsonPayload(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Recover by scanning for the outermost balanced object/array.
    for (let start = 0; start < text.length; start += 1) {
      const char = text[start];
      if (char !== "{" && char !== "[") continue;
      const candidate = sliceBalanced(text, start);
      if (!candidate) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // keep scanning
      }
    }
    return null;
  }
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {string | null}
 */
function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Exit-code contract shared with the CLI (AGENTS.md):
 * 0 success, 1 outcome failure, 2 errored, 3 cold-start gate, 4 lint,
 * 5 heal made no progress, 6 contract-hash mismatch.
 * @param {number | null} code
 * @returns {string}
 */
function describeExitCode(code) {
  switch (code) {
    case 0:
      return "success";
    case 1:
      return "outcome failure";
    case 2:
      return "errored";
    case 3:
      return "cold-start gate";
    case 4:
      return "lint failure";
    case 5:
      return "heal made no progress";
    case 6:
      return "contract-hash mismatch";
    case null:
      return "terminated by signal";
    default:
      return `exit ${code}`;
  }
}

/**
 * Spawn cairn and collect a structured result.
 *
 * The child runs in its own process group so a deadline or a user cancel can
 * kill the whole tree — cairn spawns browsers, docker, and tmux, and signaling
 * only the direct child leaves those running (and their inherited pipes keep
 * `close` from firing, which is how a "cancelled" run used to hang the app).
 *
 * @param {{
 *   command: string,
 *   argv: string[],
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   onLog?: (entry: Record<string, unknown>) => void,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ ok: boolean, exitCode: number | null, signal: string | null, payload: unknown, logs: Array<Record<string, unknown>>, stdout: string, stderr: string, timedOut: boolean, cancelled: boolean }>}
 */
function execCairn(options) {
  const {
    command,
    argv,
    cwd,
    env = augmentedEnv(),
    timeoutMs = 120_000,
    onLog,
    signal,
  } = options;
  return new Promise((resolve, reject) => {
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
    let child;
    const detached = process.platform !== "win32";
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const logs = [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exitCode = null;
    let exitSignal = null;
    const stderrDecoder = createLineDecoder();
    const MAX_CAPTURED = 4_000_000;
    /** @type {NodeJS.Timeout[]} */
    const timers = [];

    /** @param {NodeJS.Signals} killSignal */
    const killTree = (killSignal) => {
      const pid = child.pid;
      if (pid && detached) {
        try {
          process.kill(-pid, killSignal);
          return;
        } catch {
          // group already gone — fall through to the direct child
        }
      }
      try {
        child.kill(killSignal);
      } catch {
        // nothing left to kill
      }
    };

    const escalate = () => {
      killTree("SIGTERM");
      const kill = setTimeout(() => killTree("SIGKILL"), 2_000);
      timers.push(kill);
      // A grandchild can still hold the pipes open after the child exits; stop
      // waiting on `close` and settle from `exit` instead.
      const giveUp = setTimeout(() => finish(exitCode, exitSignal), 3_000);
      timers.push(giveUp);
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            escalate();
          }, timeoutMs)
        : null;
    if (timer) timers.push(timer);

    const onAbort = () => {
      cancelled = true;
      escalate();
    };
    if (signal) {
      if (signal.aborted) {
        cancelled = true;
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} killSignal
     */
    const finish = (code, killSignal) => {
      if (settled) return;
      settled = true;
      for (const entry of timers) clearTimeout(entry);
      signal?.removeEventListener("abort", onAbort);
      for (const logEntry of stderrDecoder.flush()) {
        logs.push(logEntry);
        onLog?.(logEntry);
      }
      resolve({
        ok: code === 0,
        exitCode: code,
        signal: killSignal,
        payload: parseJsonPayload(stdout),
        logs,
        stdout,
        stderr,
        timedOut,
        cancelled,
      });
    };

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CAPTURED) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stderr.length < MAX_CAPTURED) stderr += text;
      for (const entry of stderrDecoder.push(text)) {
        logs.push(entry);
        onLog?.(entry);
      }
    });
    child.on("error", (error) => {
      for (const entry of timers) clearTimeout(entry);
      signal?.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("exit", (code, killSignal) => {
      exitCode = code;
      exitSignal = killSignal;
      if (cancelled) killTree("SIGKILL");
    });
    child.on("close", (code, killSignal) => {
      exitCode = code ?? exitCode;
      exitSignal = killSignal ?? exitSignal;
      finish(exitCode, exitSignal);
    });
    if (cancelled) escalate();
  });
}

module.exports = {
  EXTRA_PATH_DIRS,
  extraPathDirs,
  augmentedEnv,
  which,
  resolveCairn,
  repeated,
  buildRunArgv,
  buildVerifyArgv,
  buildHealArgv,
  buildStatsArgv,
  buildDiffArgv,
  createLineDecoder,
  parseJsonPayload,
  describeExitCode,
  execCairn,
};
