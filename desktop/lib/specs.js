/**
 * Project + spec inspection for the desktop app.
 *
 * Mirrors the CLI's own resolution rules (config discovery by walking up from
 * the spec, artifact root defaulting to `~/.cairntrace/runs`) so the UI never
 * disagrees with what `cairn run` would actually do. Parsing is best-effort:
 * a spec with a YAML error still shows up in the list, flagged, because
 * "which of my specs is broken" is one of the things this view is for.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");

const CONFIG_FILENAMES = ["cairntrace.config.yml", "cairntrace.config.yaml"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".cairntrace",
  ".next",
  ".nuxt",
  ".venv",
  "vendor",
  ".turbo",
  ".playwright",
]);
const SPEC_EXTENSIONS = new Set([".yml", ".yaml"]);

/** Step keys in authoring order — the first match names the step's kind. */
const STEP_KINDS = [
  "use",
  "open",
  "click",
  "fill",
  "type",
  "press",
  "hover",
  "focus",
  "select",
  "check",
  "upload",
  "scroll",
  "wait",
  "batch",
  "request",
  "eval",
  "assign",
  "download",
  "script",
  "checkpoint",
  "viewport",
  "monitor",
];

/**
 * Walk up from `startDir` looking for a cairntrace config file.
 * @param {string} startDir
 * @param {number} [maxDepth]
 * @returns {string | null}
 */
function findConfig(startDir, maxDepth = 8) {
  let dir = path.resolve(startDir || ".");
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * @param {string | null} configPath
 * @returns {{ path: string | null, project: string | null, defaultEnvironment: string | null, environments: Array<{ name: string, baseUrl: string | null, waitScale: number | null, services: boolean, disabled: boolean }>, artifactRoot: string | null, backend: string | null, testIdAttribute: string | null, hasWebServer: boolean, hasServices: boolean, retention: Record<string, unknown> | null, parseError: string | null, raw: Record<string, any> | null }}
 */
function readProjectConfig(configPath) {
  const empty = {
    path: null,
    project: null,
    defaultEnvironment: null,
    environments: [],
    artifactRoot: null,
    backend: null,
    testIdAttribute: null,
    hasWebServer: false,
    hasServices: false,
    retention: null,
    parseError: null,
    raw: null,
  };
  if (!configPath) return empty;
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return {
      ...empty,
      path: configPath,
      parseError: String(error?.message ?? error),
    };
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    return {
      ...empty,
      path: configPath,
      parseError: String(error?.message ?? error),
    };
  }
  if (!doc || typeof doc !== "object")
    return { ...empty, path: configPath, parseError: "config is empty" };

  const environmentsRecord =
    doc.environments && typeof doc.environments === "object"
      ? doc.environments
      : {};
  const environments = Object.entries(environmentsRecord).map(
    ([name, value]) => {
      const env = value && typeof value === "object" ? value : {};
      return {
        name,
        baseUrl: typeof env.baseUrl === "string" ? env.baseUrl : null,
        waitScale: typeof env.waitScale === "number" ? env.waitScale : null,
        services: env.services !== false,
        disabled: env.services === false,
      };
    },
  );

  return {
    path: configPath,
    project: typeof doc.project === "string" ? doc.project : null,
    defaultEnvironment:
      typeof doc.defaultEnvironment === "string"
        ? doc.defaultEnvironment
        : null,
    environments,
    artifactRoot:
      typeof doc.artifactRoot === "string" ? doc.artifactRoot : null,
    backend:
      typeof doc.browser?.backend === "string" ? doc.browser.backend : null,
    testIdAttribute:
      typeof doc.browser?.testIdAttribute === "string"
        ? doc.browser.testIdAttribute
        : null,
    hasWebServer: Boolean(doc.webServer),
    hasServices: Boolean(doc.services),
    retention:
      doc.retention && typeof doc.retention === "object" ? doc.retention : null,
    parseError: null,
    raw: doc,
  };
}

/**
 * Resolve the runs root the same way the CLI does:
 * explicit setting → config `artifactRoot` → `~/.cairntrace/runs`.
 * @param {{ configured?: string | null, configArtifactRoot?: string | null, home?: string }} [options]
 * @returns {{ runsRoot: string, source: "settings" | "config" | "default" }}
 */
function resolveRunsRoot(options = {}) {
  const home = options.home ?? os.homedir();
  if (options.configured?.trim())
    return {
      runsRoot: path.resolve(options.configured.trim()),
      source: "settings",
    };
  if (options.configArtifactRoot?.trim()) {
    const configured = options.configArtifactRoot.trim();
    return {
      runsRoot: path.isAbsolute(configured)
        ? configured
        : path.resolve(home, configured),
      source: "config",
    };
  }
  return {
    runsRoot: path.join(home, ".cairntrace", "runs"),
    source: "default",
  };
}

/**
 * Discover spec YAML files under a project directory.
 * @param {string} projectDir
 * @param {{ maxDepth?: number, limit?: number, followSymlinks?: boolean }} [options]
 * @returns {Array<{ path: string, rel: string, name: string, bytes: number, mtimeMs: number, spec: boolean }>}
 */
function findSpecFiles(projectDir, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const limit = options.limit ?? 500;
  const root = path.resolve(projectDir || ".");
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (SKIP_DIRS.has(entry.name)) continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SPEC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        continue;
      let stat = null;
      try {
        stat = fs.statSync(absolute);
      } catch {
        // ignore unreadable file
      }
      const text = readHead(absolute, 8192);
      const looksLikeSpec = isSpecText(text);
      if (!looksLikeSpec && depth > 0) continue;
      out.push({
        path: absolute,
        rel: path.relative(root, absolute),
        name: path.basename(entry.name, path.extname(entry.name)),
        bytes: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
        spec: looksLikeSpec,
      });
    }
  };
  walk(root, 0);
  return out.toSorted((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string}
 */
function readHead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Heuristic: a cairn spec declares steps plus either intent or outcomes.
 * @param {string} text
 * @returns {boolean}
 */
function isSpecText(text) {
  if (!text) return false;
  const hasSteps = /^\s*steps\s*:/m.test(text);
  if (!hasSteps) return false;
  return /^\s*(intent|outcomes)\s*:/m.test(text);
}

/**
 * Name the step from its action key, falling back to `step`.
 * @param {Record<string, any> | null | undefined} step
 * @returns {string}
 */
function stepKind(step) {
  if (!step || typeof step !== "object") return "step";
  for (const kind of STEP_KINDS) if (kind in step) return kind;
  const keys = Object.keys(step).filter(
    (key) =>
      ![
        "id",
        "when",
        "artifacts",
        "settleMs",
        "timeoutMs",
        "optional",
        "description",
      ].includes(key),
  );
  return keys[0] ?? "step";
}

/**
 * Structured summary of a spec's YAML text — enough to render a spec list and
 * a read-only overview without running the CLI.
 * @param {string} text
 * @param {string} [filePath]
 */
function summarizeSpecText(text, filePath) {
  const fallbackName = filePath
    ? path.basename(filePath, path.extname(filePath))
    : null;
  const base = {
    name: fallbackName,
    intent: null,
    description: null,
    environment: null,
    version: null,
    contractHash: null,
    coldStart: null,
    imports: [],
    session: null,
    tags: [],
    outcomes: [],
    steps: [],
    parseError: null,
  };
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (error) {
    return { ...base, parseError: String(error?.message ?? error) };
  }
  if (!doc || typeof doc !== "object")
    return { ...base, parseError: "spec is empty" };

  const outcomes = Array.isArray(doc.outcomes) ? doc.outcomes : [];
  const steps = Array.isArray(doc.steps) ? doc.steps : [];
  return {
    ...base,
    name: typeof doc.name === "string" ? doc.name : fallbackName,
    intent: typeof doc.intent === "string" ? doc.intent : null,
    description: typeof doc.description === "string" ? doc.description : null,
    environment: typeof doc.environment === "string" ? doc.environment : null,
    version: doc.version ?? null,
    contractHash:
      typeof doc.contractHash === "string" ? doc.contractHash : null,
    coldStart:
      doc.coldStart === undefined || doc.coldStart === null
        ? null
        : String(doc.coldStart),
    imports: Array.isArray(doc.imports)
      ? doc.imports.filter((entry) => typeof entry === "string")
      : [],
    session:
      doc.session && typeof doc.session === "object"
        ? {
            resume:
              typeof doc.session.resume === "string"
                ? doc.session.resume
                : null,
          }
        : null,
    tags: Array.isArray(doc.metadata?.tags)
      ? doc.metadata.tags.filter((tag) => typeof tag === "string")
      : [],
    outcomes: outcomes.map((outcome, index) => ({
      id: typeof outcome?.id === "string" ? outcome.id : `outcome_${index + 1}`,
      description:
        typeof outcome?.description === "string" ? outcome.description : null,
      verifiers:
        outcome?.verify && typeof outcome.verify === "object"
          ? Object.keys(outcome.verify)
          : [],
    })),
    steps: steps.map((step, index) => ({
      id: typeof step?.id === "string" ? step.id : `step_${index + 1}`,
      kind: stepKind(step),
      when: typeof step?.when === "string" ? step.when : null,
      optional: Boolean(step?.optional),
      description:
        typeof step?.description === "string" ? step.description : null,
    })),
    parseError: null,
  };
}

/**
 * Where `cairn spec scaffold --out <dir>` would write for a given name.
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function scaffoldTarget(dir, name) {
  const safe = String(name ?? "spec").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(path.resolve(dir || "."), `${safe}.yml`);
}

/**
 * @param {string} projectDir
 * @returns {{ dir: string, configPath: string | null, isGit: boolean, hasPackageJson: boolean }}
 */
function inspectProjectDir(projectDir) {
  const dir = path.resolve(projectDir || ".");
  return {
    dir,
    configPath: findConfig(dir),
    isGit: fs.existsSync(path.join(dir, ".git")),
    hasPackageJson: fs.existsSync(path.join(dir, "package.json")),
  };
}

module.exports = {
  CONFIG_FILENAMES,
  SKIP_DIRS,
  STEP_KINDS,
  findConfig,
  readProjectConfig,
  resolveRunsRoot,
  findSpecFiles,
  isSpecText,
  stepKind,
  summarizeSpecText,
  scaffoldTarget,
  inspectProjectDir,
};
