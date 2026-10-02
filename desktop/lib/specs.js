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
const { INVOCATIONS_DIR, isRunDirName, isWithin } = require("./runs");
/** Session journals under an artifact root (`cairn discover`). */
const SESSIONS_DIR = "_sessions";
const { whenText } = require("./events");
const CairnPolicy = require("./policy");
const registries = require("./registries");

const CONFIG_FILENAMES = ["cairntrace.config.yml", "cairntrace.config.yaml"];
/**
 * Directories that never hold authored specs, at any depth: dependency trees,
 * build output, and cairn's own bookkeeping. Run-shaped directories
 * (`<iso>_<spec>_<hex>`) and the resolved artifact root are skipped too,
 * wherever they live.
 */
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
  INVOCATIONS_DIR,
  // session journals: draft.spec.yml there is a session's working copy
  SESSIONS_DIR,
]);
/**
 * Names cairn (and the tooling around it) gives to output folders that hold
 * spec copies. Skipped at the project root, and deeper only when the folder
 * looks like output (see `looksLikeOutputDir`): `flows/exports/` or
 * `flows/reports/` can just as well be an authored feature folder, and
 * `cairn run flows/` runs those.
 */
const OUTPUT_DIR_NAMES = new Set([
  "runs",
  "exports",
  "playwright-export",
  "reports",
]);
/** Files that mark a folder as cairn output (run copies, `cairn export`). */
const OUTPUT_MARKERS = [
  ".cairn-export.json",
  "spec.resolved.yml",
  "spec.resolved.yaml",
  "run.json",
];
/** Files cairn writes next to a run that look like specs but are copies. */
const SKIP_FILES = new Set([
  "spec.resolved.yml",
  "spec.resolved.yaml",
  "run.yaml",
  ...CONFIG_FILENAMES,
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
  // wave 4: host processes, typed assertions and captured values
  "run",
  "expect",
  "capture",
  "transform",
  "snapshot",
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

const CONFIG_DIR_TOKEN = "${config.dir}";

/**
 * The CLI's `${env.X}` / `${env.X:-default}` config substitution
 * (src/core/config/loader.ts substituteEnv), so values like
 * `artifactRoot: ${env.RUNS_DIR:-runs}` resolve the way `cairn` sees them.
 * @param {string} text
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
function substituteConfigEnv(text, env = process.env) {
  return String(text ?? "").replace(
    /\$\{env\.(\w+)(?::-([^}]+))?\}/g,
    (_match, name, fallback) => {
      const value = env[name];
      if (value === undefined || value === "")
        return fallback !== undefined ? fallback : "";
      return value;
    },
  );
}

/**
 * Deep-copy `value`, replacing `token` in every string (keys included).
 * @param {unknown} value
 * @param {string} token
 * @param {string} replacement
 * @returns {any}
 */
function replaceInStrings(value, token, replacement) {
  if (typeof value === "string")
    return value.includes(token)
      ? value.replaceAll(token, () => replacement)
      : value;
  if (Array.isArray(value))
    return value.map((item) => replaceInStrings(item, token, replacement));
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value))
      out[key.replaceAll(token, () => replacement)] = replaceInStrings(
        item,
        token,
        replacement,
      );
    return out;
  }
  return value;
}

/**
 * Parse config text WITHOUT `${env.X}` substitution (`${config.dir}` is
 * still filled): references stay references, so a summary built from it can
 * name `${env.MONGO_URI}` without ever holding its value.
 * @param {string} text
 * @param {string} configPath
 * @returns {any}
 */
function parseConfigTemplate(text, configPath) {
  const source = String(text ?? "");
  const parsed = YAML.parse(source, { merge: true });
  return source.includes(CONFIG_DIR_TOKEN)
    ? replaceInStrings(parsed, CONFIG_DIR_TOKEN, path.dirname(configPath))
    : parsed;
}

/**
 * Parse config text the way the CLI loader does (parseConfigText in
 * src/core/config/loader.ts): `${env.X}` substitution, YAML with merge
 * keys, then `${config.dir}` (the config file's directory) inserted into the
 * parsed strings, so `artifactRoot: ${config.dir}/runs` resolves where cairn
 * writes.
 * @param {string} text
 * @param {string} configPath
 * @param {Record<string, string | undefined>} [env]
 * @returns {any}
 */
function parseConfigText(text, configPath, env = process.env) {
  const source = String(text ?? "");
  if (!source.includes(CONFIG_DIR_TOKEN))
    return YAML.parse(substituteConfigEnv(source, env), { merge: true });
  let sentinel = "__CAIRNTRACE_CONFIG_DIR__";
  while (source.includes(sentinel)) sentinel = `_${sentinel}_`;
  const parsed = YAML.parse(
    substituteConfigEnv(
      source.replaceAll(CONFIG_DIR_TOKEN, () => sentinel),
      env,
    ),
    { merge: true },
  );
  return replaceInStrings(parsed, sentinel, path.dirname(configPath));
}

/**
 * @param {string | null} configPath
 * @returns {{ path: string | null, project: string | null, defaultEnvironment: string | null, environments: Array<{ name: string, baseUrl: string | null, waitScale: number | null, services: boolean, disabled: boolean, policy: ReturnType<typeof CairnPolicy.normalizePolicy> }>, artifactRoot: string | null, backend: string | null, testIdAttribute: string | null, hasWebServer: boolean, hasServices: boolean, retention: Record<string, unknown> | null, parseError: string | null, raw: Record<string, any> | null, registries: ReturnType<typeof registries.summarizeRegistries> }}
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
    registries: registries.summarizeRegistries(null),
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
    doc = parseConfigText(text, configPath);
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
        // environments.<name>.policy (trait / mutations / description)
        policy: CairnPolicy.normalizePolicy(env.policy),
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
    // datasources (per environment) / gates / fixtures, redacted; from the
    // unsubstituted text so env values never enter the summary
    registries: registries.summarizeRegistries(templateOf(text, configPath)),
  };
}

/**
 * The unsubstituted config document, or null when it does not parse.
 * @param {string} text
 * @param {string} configPath
 * @returns {any}
 */
function templateOf(text, configPath) {
  try {
    return parseConfigTemplate(text, configPath);
  } catch {
    return null;
  }
}

/**
 * The project config as the renderer may see it: everything
 * `readProjectConfig` summarizes, minus the parsed document (`raw`), whose
 * `${env.X}` values are substituted and may carry credentials. Each
 * environment's `baseUrl` is env-substituted too, so it goes out redacted
 * (userinfo masked, query dropped): `https://qa:${env.PW}@staging…` shows
 * as `https://***@staging…`.
 * @param {ReturnType<typeof readProjectConfig>} config
 */
function publicConfig(config) {
  if (!config || typeof config !== "object") return config;
  const { raw: _raw, ...rest } = config;
  return {
    ...rest,
    environments: (rest.environments ?? []).map((env) => ({
      ...env,
      baseUrl: env.baseUrl ? registries.redactTarget(env.baseUrl) : null,
    })),
  };
}

/**
 * Resolve the runs root the same way the CLI does:
 * explicit setting → config `artifactRoot` → `~/.cairntrace/runs`.
 *
 * The CLI keeps a relative config `artifactRoot` as-is and `resolve()`s it
 * against its working directory (src/cli/commands/run.ts,
 * src/cli/runRefs.ts) — not against the config file's directory. Studio
 * spawns every `cairn` with the open project as its cwd, so a relative value
 * resolves against `baseDir` (the project directory) here. `home` is only
 * the fallback when no base is known.
 * @param {{ configured?: string | null, configArtifactRoot?: string | null, home?: string, baseDir?: string | null }} [options]
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
        ? path.resolve(configured)
        : path.resolve(options.baseDir || home, configured),
      source: "config",
    };
  }
  return {
    runsRoot: path.join(home, ".cairntrace", "runs"),
    source: "default",
  };
}

/**
 * Does this folder hold cairn output: a run-shaped child directory, an
 * `_invocations` or `_sessions` journal folder, a resolved spec / run record, or a
 * `cairn export` manifest?
 * @param {string} absolute
 * @returns {boolean}
 */
function looksLikeOutputDir(absolute) {
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (
        entry.name === INVOCATIONS_DIR ||
        entry.name === SESSIONS_DIR ||
        isRunDirName(entry.name)
      )
        return true;
    } else if (OUTPUT_MARKERS.includes(entry.name)) return true;
  }
  return false;
}

/**
 * Should the spec walk descend into this directory?
 * @param {string} name
 * @param {string} absolute
 * @param {string[]} excludeDirs absolute directories to skip (artifact root)
 * @param {{ atRoot?: boolean }} [options] `atRoot`: a direct child of the project
 * @returns {boolean}
 */
function shouldSkipDir(name, absolute, excludeDirs, options = {}) {
  if (SKIP_DIRS.has(name)) return true;
  // A copied run directory (`<iso>_<spec>_<hex>`) anywhere in the tree.
  if (isRunDirName(name)) return true;
  if (excludeDirs.length > 0 && isWithin(absolute, excludeDirs)) return true;
  // runs/, exports/, reports/: output at the project root; deeper, only when
  // the folder's contents say so.
  if (OUTPUT_DIR_NAMES.has(name))
    return Boolean(options.atRoot) || looksLikeOutputDir(absolute);
  return false;
}

/**
 * Is this file a spec candidate by name alone?
 * @param {string} name
 * @returns {boolean}
 */
function isSpecCandidateName(name) {
  if (SKIP_FILES.has(name)) return false;
  return SPEC_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * @param {Array<string | null | undefined> | undefined} dirs
 * @returns {string[]}
 */
function normalizeExcludes(dirs) {
  return (dirs ?? [])
    .filter((dir) => typeof dir === "string" && dir.trim())
    .map((dir) => path.resolve(/** @type {string} */ (dir)));
}

/**
 * Discover spec YAML files under a project directory.
 * @param {string} projectDir
 * @param {{ maxDepth?: number, limit?: number, excludeDirs?: Array<string | null | undefined> }} [options]
 * @returns {Array<{ path: string, rel: string, name: string, bytes: number, mtimeMs: number, spec: boolean }>}
 */
function findSpecFiles(projectDir, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const limit = options.limit ?? 500;
  const root = path.resolve(projectDir || ".");
  const excludeDirs = normalizeExcludes(options.excludeDirs);
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
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          shouldSkipDir(entry.name, absolute, excludeDirs, {
            atRoot: depth === 0,
          })
        )
          continue;
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isSpecCandidateName(entry.name)) continue;
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
 * Async twin of `findSpecFiles` + summaries, for the main process: the walk
 * and every read are non-blocking, YAML parsing yields to the event loop
 * every few files, and summaries are cached by path + mtime + size so a
 * rescan only re-parses what changed.
 * @param {string} projectDir
 * @param {{ maxDepth?: number, limit?: number, excludeDirs?: Array<string | null | undefined>, cache?: Map<string, { mtimeMs: number, bytes: number, summary: any, spec: boolean }> }} [options]
 * @returns {Promise<Array<{ path: string, rel: string, name: string, bytes: number, mtimeMs: number, spec: boolean, summary: any }>>}
 */
async function scanSpecs(projectDir, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const limit = options.limit ?? 500;
  const root = path.resolve(projectDir || ".");
  const excludeDirs = normalizeExcludes(options.excludeDirs);
  const cache = options.cache ?? null;
  const fsp = fs.promises;
  /** @type {Array<{ path: string, rel: string, name: string, bytes: number, mtimeMs: number, spec: boolean, summary: any }>} */
  const out = [];
  let parsed = 0;
  /**
   * @param {string} dir
   * @param {number} depth
   */
  const walk = async (dir, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (out.length >= limit) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          shouldSkipDir(entry.name, absolute, excludeDirs, {
            atRoot: depth === 0,
          })
        )
          continue;
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSpecCandidateName(entry.name)) continue;
      let stat;
      try {
        stat = await fsp.stat(absolute);
      } catch {
        continue;
      }
      const cached = cache?.get(absolute);
      let summary;
      let looksLikeSpec;
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.bytes === stat.size
      ) {
        summary = cached.summary;
        looksLikeSpec = cached.spec;
      } else {
        let text = "";
        try {
          text = await fsp.readFile(absolute, "utf8");
        } catch (error) {
          summary = { parseError: String(error?.message ?? error) };
        }
        looksLikeSpec = isSpecText(text.slice(0, 8192));
        if (!summary && (looksLikeSpec || depth === 0)) {
          summary = summarizeSpecText(text, absolute);
          parsed += 1;
          // Keep the main process responsive on big trees.
          if (parsed % 16 === 0)
            await new Promise((resolve) => setImmediate(resolve));
        }
        if (cache) {
          if (cache.size > 5000) cache.clear();
          cache.set(absolute, {
            mtimeMs: stat.mtimeMs,
            bytes: stat.size,
            summary,
            spec: looksLikeSpec,
          });
        }
      }
      if (!looksLikeSpec && depth > 0) continue;
      out.push({
        path: absolute,
        rel: path.relative(root, absolute),
        name: path.basename(entry.name, path.extname(entry.name)),
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        spec: looksLikeSpec,
        summary: summary ?? summarizeSpecText("", absolute),
      });
    }
  };
  await walk(root, 0);
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
    requires: null,
    outcomes: [],
    steps: [],
    teardown: [],
    teardownFailsRun: false,
    fixtures: [],
    wait: [],
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
    // requires.env / requires.mutates (environment policy, checked by run)
    requires: CairnPolicy.normalizeRequires(doc.requires),
    outcomes: outcomes.map((outcome, index) => ({
      id: typeof outcome?.id === "string" ? outcome.id : `outcome_${index + 1}`,
      description:
        typeof outcome?.description === "string" ? outcome.description : null,
      // `poll` is a modifier on the verifier, not a verifier of its own
      verifiers:
        outcome?.verify && typeof outcome.verify === "object"
          ? Object.keys(outcome.verify).filter((key) => key !== "poll")
          : [],
      polled: Boolean(
        outcome?.verify &&
          typeof outcome.verify === "object" &&
          outcome.verify.poll,
      ),
    })),
    steps: steps.map((step, index) => ({
      id: typeof step?.id === "string" ? step.id : `step_${index + 1}`,
      kind: stepKind(step),
      when: whenText(step?.when),
      optional: Boolean(step?.optional),
      description:
        typeof step?.description === "string" ? step.description : null,
    })),
    // F3a: `teardown:` (a list, or {steps, failRun, timeoutMs})
    teardown: teardownSteps(doc.teardown).map((step, index) => ({
      id: typeof step?.id === "string" ? step.id : `teardown_${index + 1}`,
      kind: stepKind(step),
    })),
    teardownFailsRun: Boolean(
      doc.teardown && typeof doc.teardown === "object" && doc.teardown.failRun,
    ),
    // F3b: `fixtures: [name | name.reset | {use, with}]`
    fixtures: (Array.isArray(doc.fixtures) ? doc.fixtures : [])
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && typeof entry.use === "string"
            ? entry.use
            : null,
      )
      .filter(Boolean),
    // F2: `preconditions.wait` gate names (inline probes as their URL)
    wait: gateRefs(doc.preconditions?.wait),
    parseError: null,
  };
}

/**
 * The steps of a `teardown:` block.
 * @param {unknown} value
 * @returns {Array<Record<string, any>>}
 */
function teardownSteps(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const steps = /** @type {Record<string, any>} */ (value).steps;
    return Array.isArray(steps) ? steps : [];
  }
  return [];
}

/**
 * Gate references of a single-or-list field, as names (inline gates by
 * their `name`, an `http(s)://` / `tcp://` string as itself, query
 * dropped).
 * @param {unknown} value
 * @returns {string[]}
 */
function gateRefs(value) {
  const list = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return list
    .map((ref) =>
      typeof ref === "string"
        ? registries.redactTarget(ref)
        : ref && typeof ref === "object" && typeof ref.name === "string"
          ? ref.name
          : ref && typeof ref === "object"
            ? "(inline gate)"
            : null,
    )
    .filter(Boolean);
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
  OUTPUT_DIR_NAMES,
  SKIP_FILES,
  substituteConfigEnv,
  parseConfigText,
  parseConfigTemplate,
  publicConfig,
  looksLikeOutputDir,
  shouldSkipDir,
  isSpecCandidateName,
  scanSpecs,
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
