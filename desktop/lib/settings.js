/**
 * Persistent desktop settings.
 *
 * A single JSON document under Electron's `userData` directory. Every function
 * takes the file path explicitly so the store is testable with a temp file and
 * never touches the real user profile during tests.
 */
const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_VERSION = 1;
const MAX_RECENT_PROJECTS = 12;

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
      density: "comfortable",
      screenshotMaxWidth: 720,
      autoRefreshRuns: true,
      livePollMs: 400,
    },
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

module.exports = {
  SETTINGS_VERSION,
  MAX_RECENT_PROJECTS,
  defaultSettings,
  mergeDeep,
  loadSettings,
  saveSettings,
  updateSettings,
  withRecentProject,
  withoutProject,
};
