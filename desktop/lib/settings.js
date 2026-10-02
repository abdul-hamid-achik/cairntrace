/**
 * Persistent desktop settings.
 *
 * A single JSON document under Electron's `userData` directory. Every function
 * takes the file path explicitly so the store is testable with a temp file and
 * never touches the real user profile during tests.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isWithin } = require("./runs");

const SETTINGS_VERSION = 1;
const MAX_RECENT_PROJECTS = 12;

/**
 * The only settings sections the renderer may patch wholesale
 * (`settings:update`). Everything else — the cairn binary, the artifact root,
 * projects, per-project launch settings — has its own validated IPC handler.
 */
const RENDERER_SETTINGS_KEYS = ["run", "ui"];
/** `run` keys passed to cairn as a flag's value. */
const RUN_VALUE_KEYS = ["backend", "env", "provider", "device", "logLevel"];
/** `run` keys that toggle a bare cairn flag. */
const RUN_BOOLEAN_KEYS = [
  "headed",
  "coldStart",
  "mock",
  "monitor",
  "noWebServer",
  "noServices",
  "stashOnFailure",
];
/** `run` keys passed as repeated flags (`--var k=v`, `--label k=v`, `--tag t`). */
const RUN_LIST_KEYS = ["vars", "labels", "tags"];
const MAX_PARALLEL = 32;

/** @returns {Record<string, any>} */
function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    projects: [],
    activeProject: null,
    cairnBin: null,
    artifactRoot: null,
    run: {
      backend: null,
      env: null,
      provider: null,
      device: null,
      headed: false,
      coldStart: false,
      mock: false,
      monitor: false,
      parallel: 1,
      noWebServer: false,
      noServices: false,
      stashOnFailure: false,
      logLevel: "info",
      vars: [],
      labels: [],
      tags: [],
    },
    ui: {
      /** "comfortable" | "compact" — row height and padding across tables. */
      density: "comfortable",
      /** Max rendered width (px) of screenshots in run detail and Live. */
      screenshotMaxWidth: 720,
      /** Reload the Runs view when a run finishes. */
      autoRefreshRuns: true,
      /** How often an app-started run's tail polls its run directory. */
      livePollMs: 400,
    },
    /**
     * Per-project launch safety, keyed by absolute project directory:
     * `{ launchTemplate: string | null, lockFiles: string[] }`.
     */
    projectSettings: {},
  };
}

/**
 * Deep-merge plain objects; arrays and scalars replace wholesale.
 * @param {any} target
 * @param {any} patch
 * @returns {any}
 */
function mergeDeep(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = Array.isArray(target) ? {} : { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeDeep(out[key], value)
        : value;
  }
  return out;
}

/**
 * @param {string} file
 * @returns {Record<string, any>}
 */
function loadSettings(file) {
  const defaults = defaultSettings();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return defaults;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const merged = mergeDeep(defaults, raw);
  if (!Array.isArray(merged.projects)) merged.projects = [];
  return merged;
}

/**
 * @param {string} file
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
function saveSettings(file, settings) {
  const next = mergeDeep(defaultSettings(), settings);
  next.version = SETTINGS_VERSION;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return next;
}

/**
 * @param {string} file
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
function updateSettings(file, patch) {
  return saveSettings(file, mergeDeep(loadSettings(file), patch));
}

/**
 * Remember a project directory as recently used, most recent first.
 * @param {Record<string, any>} settings
 * @param {string} projectDir
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
function withRecentProject(settings, projectDir, now = new Date()) {
  const resolved = path.resolve(projectDir);
  const projects = Array.isArray(settings?.projects) ? settings.projects : [];
  const kept = projects.filter(
    (entry) =>
      entry &&
      typeof entry.path === "string" &&
      path.resolve(entry.path) !== resolved,
  );
  const previous = projects.find(
    (entry) =>
      entry &&
      typeof entry.path === "string" &&
      path.resolve(entry.path) === resolved,
  );
  kept.unshift({
    path: resolved,
    name: path.basename(resolved),
    lastOpenedAt: now.toISOString(),
    openedCount: Number(previous?.openedCount ?? 0) + 1,
  });
  return {
    ...settings,
    projects: kept.slice(0, MAX_RECENT_PROJECTS),
    activeProject: resolved,
  };
}

/**
 * @param {Record<string, any>} settings
 * @param {string} projectDir
 * @returns {Record<string, any>}
 */
function withoutProject(settings, projectDir) {
  const resolved = path.resolve(projectDir);
  const projects = (
    Array.isArray(settings?.projects) ? settings.projects : []
  ).filter(
    (entry) => !(entry && path.resolve(String(entry.path)) === resolved),
  );
  const activeProject =
    settings?.activeProject &&
    path.resolve(String(settings.activeProject)) === resolved
      ? (projects[0]?.path ?? null)
      : (settings?.activeProject ?? null);
  return { ...settings, projects, activeProject };
}

/**
 * A value Studio passes to cairn as a flag's argument: a short single-line
 * string that cannot be mistaken for another flag.
 * @param {unknown} value
 * @param {string} key
 * @returns {string | null}
 */
function flagValue(value, key) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("-"))
    throw new Error(`${key} cannot start with "-": ${trimmed}`);
  if (trimmed.length > 500 || trimmed.includes("\0") || /[\r\n]/.test(trimmed))
    throw new Error(`${key} must be a single line under 500 characters`);
  return trimmed;
}

/**
 * Validate run defaults (or per-run overrides) before they become `cairn run`
 * argv. Unknown keys are dropped; a value that could smuggle in another flag
 * is refused.
 * @param {unknown} run
 * @returns {Record<string, any>}
 */
function sanitizeRunSettings(run) {
  if (run === null || run === undefined) return {};
  if (typeof run !== "object" || Array.isArray(run))
    throw new Error("run settings must be an object");
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(run)) {
    if (value === undefined) continue;
    if (RUN_VALUE_KEYS.includes(key)) out[key] = flagValue(value, key);
    else if (RUN_BOOLEAN_KEYS.includes(key)) out[key] = Boolean(value);
    else if (RUN_LIST_KEYS.includes(key)) {
      if (value === null) {
        out[key] = [];
        continue;
      }
      if (!Array.isArray(value)) throw new Error(`${key} must be a list`);
      out[key] = value
        .slice(0, 200)
        .map((entry) => flagValue(entry, key))
        .filter(Boolean);
    } else if (key === "parallel") {
      const count = Math.trunc(Number(value));
      out.parallel = Number.isFinite(count)
        ? Math.max(1, Math.min(count, MAX_PARALLEL))
        : 1;
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(Math.round(number), max))
    : fallback;
}

/**
 * @param {unknown} ui
 * @returns {Record<string, any>}
 */
function sanitizeUiSettings(ui) {
  if (ui === null || ui === undefined) return {};
  if (typeof ui !== "object" || Array.isArray(ui))
    throw new Error("ui settings must be an object");
  const source = /** @type {Record<string, any>} */ (ui);
  /** @type {Record<string, any>} */
  const out = {};
  if (source.density !== undefined)
    out.density = source.density === "compact" ? "compact" : "comfortable";
  if (source.screenshotMaxWidth !== undefined)
    out.screenshotMaxWidth = clamp(source.screenshotMaxWidth, 160, 4000, 720);
  if (source.livePollMs !== undefined)
    out.livePollMs = clamp(source.livePollMs, 150, 5000, 400);
  if (source.autoRefreshRuns !== undefined)
    out.autoRefreshRuns = Boolean(source.autoRefreshRuns);
  return out;
}

/**
 * The patch `settings:update` may apply: only `run` and `ui`, validated.
 * @param {unknown} patch
 * @returns {Record<string, any>}
 */
function sanitizeRendererPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("patch required");
  const refused = Object.keys(patch).filter(
    (key) => !RENDERER_SETTINGS_KEYS.includes(key),
  );
  if (refused.length)
    throw new Error(
      `settings:update cannot change ${refused.join(", ")}; use its own control`,
    );
  const source = /** @type {Record<string, any>} */ (patch);
  /** @type {Record<string, any>} */
  const out = {};
  if (source.run !== undefined) out.run = sanitizeRunSettings(source.run);
  if (source.ui !== undefined) out.ui = sanitizeUiSettings(source.ui);
  return out;
}

/**
 * @param {string} value
 * @param {string} home
 * @returns {string}
 */
function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

/**
 * Validate a typed cairn binary path. `needsConfirm` is true when the file is
 * not named `cairn…`: the main process then asks the user in a native dialog,
 * because Studio spawns this file for every action.
 * @param {unknown} value
 * @param {{ home?: string }} [options]
 * @returns {{ path: string | null, needsConfirm: boolean }}
 */
function checkCairnBinary(value, options = {}) {
  if (value === null || value === undefined)
    return { path: null, needsConfirm: false };
  if (typeof value !== "string") throw new Error("cairn binary must be a path");
  if (!value.trim()) return { path: null, needsConfirm: false };
  const expanded = expandHome(value.trim(), options.home ?? os.homedir());
  if (!path.isAbsolute(expanded))
    throw new Error("cairn binary must be an absolute path");
  const resolved = path.resolve(expanded);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`no file at ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`${resolved} is not a file`);
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw new Error(`${resolved} is not executable`);
  }
  return {
    path: resolved,
    needsConfirm: !/^cairn/i.test(path.basename(resolved)),
  };
}

/**
 * Validate an artifact-root override. Studio reads run folders from it, so it
 * can never be the filesystem root, the home folder, or a parent of home.
 * @param {unknown} value
 * @param {{ home?: string }} [options]
 * @returns {string | null} the resolved directory, or null to clear
 */
function checkArtifactRoot(value, options = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new Error("artifact root must be a path");
  if (!value.trim()) return null;
  const home = path.resolve(options.home ?? os.homedir());
  const expanded = expandHome(value.trim(), home);
  if (!path.isAbsolute(expanded))
    throw new Error("artifact root must be an absolute path");
  const resolved = path.resolve(expanded);
  if (resolved === path.parse(resolved).root)
    throw new Error("the filesystem root cannot be the artifact root");
  if (isWithin(home, [resolved]))
    throw new Error(
      `${resolved} contains your home folder; pick a dedicated runs folder`,
    );
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory())
    throw new Error(`${resolved} is not a directory`);
  return resolved;
}

module.exports = {
  SETTINGS_VERSION,
  MAX_RECENT_PROJECTS,
  RENDERER_SETTINGS_KEYS,
  sanitizeRunSettings,
  sanitizeUiSettings,
  sanitizeRendererPatch,
  checkCairnBinary,
  checkArtifactRoot,
  defaultSettings,
  mergeDeep,
  loadSettings,
  saveSettings,
  updateSettings,
  withRecentProject,
  withoutProject,
};
