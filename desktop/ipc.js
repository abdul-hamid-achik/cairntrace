/**
 * IPC surface for Cairntrace Studio.
 *
 * Everything the renderer can ask for is declared here, and every handler is a
 * thin wrapper over `lib/*` plus a spawned `cairn` process. The renderer is
 * sandboxed with context isolation, so this file is the trust boundary, and
 * no renderer argument is trusted:
 *
 *   - a `projectDir` argument must be the active project, a recent project
 *     (added only through the native Open dialog), or Studio's default; any
 *     other directory is refused;
 *   - filesystem reads stay inside that project, the resolved artifact root,
 *     stash restores this session created, and files the user explicitly
 *     picked (open dialogs, files handed to the app, the YAML spec a run
 *     record names); spec writes are `.yml`/`.yaml` files inside the project;
 *   - run references resolve to run-shaped directories inside those roots;
 *   - `settings:update` only patches validated `run`/`ui` defaults; the cairn
 *     binary, the artifact root and launch templates have their own handlers,
 *     and a change the user did not make through a native dialog is confirmed
 *     in one (a binary not named `cairn…`, an artifact root typed by hand, any
 *     new launch template, dropping or resetting a lock file that is held);
 *   - while a configured suite lock exists, or a live owner holds the config
 *     `run: { lock }` (read from ~/.cairntrace/locks, matched on the key the
 *     lock file stores), run:start and spec:heal (which re-runs the spec) and
 *     services up/down/restart are refused, with no override;
 *   - media is streamed through `cairn-artifact://` tokens issued here, never
 *     by path; external opens are limited to http(s), and "Open in
 *     file.cheap" opens only the https web URL main reads from the run's own
 *     publish-receipt.json;
 *   - publishing a run uploads it, so `run:publish` asks in a native dialog
 *     first; pin/unpin only touch runs inside the artifact root;
 *   - a session journal is addressed by its id (or its exact
 *     `<artifactRoot>/_sessions/<id>` folder), and only its own text/image
 *     files are read; the project config reaches the renderer without its
 *     parsed document (env-substituted values may carry credentials): the
 *     datasources / gates / fixtures registries are summarized from the
 *     unsubstituted text, redacted; `fixtures:ledger` takes no path, only
 *     the project, and reads `~/.cairntrace/fixtures/<project>.ledger.jsonl`
 *     with outputs masked; `spec:promote` takes a YAML draft inside the project
 *     and shows its intent + outcomes in a native dialog before cairn stamps
 *     them; `services:up` / `services:down` / `services:restart` ask natively
 *     and are refused while a suite or run lock is held; `orphans:kill` lists
 *     what it would end in a native dialog before it runs `--kill --yes`;
 *     `suites:list`, `config:vars`, `services:windows|logs` and
 *     `metrics:history` take only validated names (environment, suite, a
 *     window the CLI's own status lists) and bounded numbers, each one argv
 *     entry joined to its flag (lib/ops.js), and their results are normalized
 *     and masked before they reach the renderer.
 *
 * What this is NOT: a sandbox against command execution. A spec can declare
 * `preconditions.commands` and the project config can declare services, and
 * Run executes them by design. A compromised renderer that edits a spec in
 * the open project and runs it can therefore run commands as the user, just
 * like the user can.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, dialog, ipcMain, shell } = require("electron");

const authoring = require("./lib/authoring");
const cli = require("./lib/cli");
const dataEvidence = require("./lib/dataEvidence");
const CairnEvents = require("./lib/events");
const CairnPolicy = require("./lib/policy");
const evidence = require("./lib/evidence");
const { parseRunId, runIdTimestampMs } = require("./lib/format");
const invocations = require("./lib/invocations");
const launch = require("./lib/launch");
const live = require("./lib/live");
const registries = require("./lib/registries");
const runs = require("./lib/runs");
const settingsStore = require("./lib/settings");
const specs = require("./lib/specs");
const stash = require("./lib/stash");
const metricsLib = require("./lib/metrics");
const ops = require("./lib/ops");
const { createRunWatcher } = require("./lib/watcher");

/**
 * @typedef {object} IpcContext
 * @property {string} settingsFile
 * @property {string} repoRoot
 * @property {() => import("electron").BrowserWindow | null} getWindow
 * @property {(channel: string, payload: unknown) => void} send
 * @property {{ register: (file: string) => string, clear: () => void }} [media]
 * @property {string} [fixturesLedgerDir] where the CLI keeps per-project
 *   fixture ledgers (default `~/.cairntrace/fixtures`)
 * @property {string} [runLockDir] where the CLI keeps run locks (default
 *   `~/.cairntrace/locks`)
 */

let tokenCounter = 0;

/** @returns {string} */
function nextToken() {
  tokenCounter += 1;
  return `run_${Date.now().toString(36)}_${tokenCounter}`;
}

/** Hard cap on how long a finished app run's tail may linger. */
const TAIL_LINGER_CAP_MS = 15_000;
/** A delegated runner's default `cancelGraceMs` (the CLI's DEFAULT_CANCEL_GRACE_MS). */
const DELEGATE_CANCEL_GRACE_MS = 180_000;

/**
 * @param {string} file
 * @returns {boolean}
 */
function isYamlPath(file) {
  return /\.ya?ml$/i.test(String(file ?? ""));
}

/**
 * Do two environment sets share one? Null is "cannot be told": any.
 * @param {string[] | null} a
 * @param {string[] | null} b
 * @returns {boolean}
 */
function envsOverlap(a, b) {
  if (a === null || b === null) return true;
  return a.some((env) => b.includes(env));
}

/**
 * @param {IpcContext} ctx
 */
function registerIpc(ctx) {
  /**
   * Runs and heals Studio started. `envs`: the environments they use (null
   * when that cannot be told: any), so services up/down and runs on the
   * same project + environment never overlap.
   * @type {Map<string, { controller: AbortController, tail: { stop: () => void, runDir?: () => string | null } | null, specs: string[], suite?: string | null, startedAt: number, argv: string[], command: string, pid?: number | null, projectDir?: string, envs?: string[] | null, runsRoot?: string, delegatedRunner?: { cancelGraceMs: number | null } | null }>}
   */
  const activeRuns = new Map();
  /**
   * run:cancel's decision per token (read by execCairn when it aborts).
   * @type {Map<string, { signal: NodeJS.Signals, killAfterMs: number | null }>}
   */
  const cancelPolicies = new Map();
  /** Finished app runs whose tails still drain late events. */
  /** @type {Set<{ stop: () => void }>} */
  const lingeringTails = new Set();
  /** @type {Map<string, { at: number, value: unknown }>} */
  const cache = new Map();
  /** Spec summaries keyed by path+mtime+size, shared by every scan. */
  const specCache = new Map();
  /** Temp directories `stash:restore` created this session. */
  /** @type {Set<string>} */
  const restoredRoots = new Set();
  /** Individual files the user picked or a run record named. */
  /** @type {Set<string>} */
  const allowedFiles = new Set();
  /** Directories the native directory picker returned this session. */
  /** @type {Set<string>} */
  const pickedDirs = new Set();

  const settingsFile = ctx.settingsFile;
  const getSettings = () => settingsStore.loadSettings(settingsFile);
  const writeSettings = (patch) =>
    settingsStore.updateSettings(settingsFile, patch);

  /**
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => any} compute
   */
  function cached(key, ttlMs, compute) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = compute();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** @param {Iterable<string>} files */
  function allowFiles(files) {
    for (const file of files ?? [])
      if (typeof file === "string" && path.isAbsolute(file))
        allowedFiles.add(path.resolve(file));
    if (allowedFiles.size > 2000) {
      const keep = [...allowedFiles].slice(-1000);
      allowedFiles.clear();
      for (const file of keep) allowedFiles.add(file);
    }
  }

  /**
   * The project Studio falls back to when the renderer names none.
   * @param {Record<string, any>} settings
   * @returns {string}
   */
  function defaultProjectDir(settings) {
    return path.resolve(
      settings.activeProject || ctx.repoRoot || app.getPath("home"),
    );
  }

  /**
   * Directories the renderer may name as the project: the active project,
   * the recent projects (added only via the native Open dialog), and the
   * default. Anything else is a renderer choosing its own root.
   * @param {Record<string, any>} settings
   * @returns {Set<string>}
   */
  function knownProjectDirs(settings) {
    const dirs = new Set([defaultProjectDir(settings)]);
    if (typeof settings.activeProject === "string" && settings.activeProject)
      dirs.add(path.resolve(settings.activeProject));
    for (const entry of Array.isArray(settings.projects)
      ? settings.projects
      : [])
      if (typeof entry?.path === "string" && entry.path)
        dirs.add(path.resolve(entry.path));
    return dirs;
  }

  /**
   * @param {string | null | undefined} projectDir
   * @returns {{ dir: string, configPath: string | null, config: ReturnType<typeof specs.readProjectConfig> }}
   */
  function projectContext(projectDir) {
    const settings = getSettings();
    let dir = defaultProjectDir(settings);
    if (projectDir !== null && projectDir !== undefined && projectDir !== "") {
      const requested = path.resolve(String(projectDir));
      if (!knownProjectDirs(settings).has(requested))
        throw new Error(
          `unknown project: ${requested} (open it with Open project… first)`,
        );
      dir = requested;
    }
    const info = specs.inspectProjectDir(dir);
    const config = specs.readProjectConfig(info.configPath);
    return { dir, configPath: info.configPath, config };
  }

  /**
   * Where the CLI and MCP write session journals: the config's
   * `artifactRoot` (relative to the cwd, i.e. the project) or
   * `~/.cairntrace/runs` — never Studio's own artifact-root override, which
   * only `cairn run` started from Studio is told about
   * (src/cli/commands/discover.ts `journalRootFor`).
   * @param {string | null | undefined} projectDir
   * @returns {string}
   */
  function sessionsRootFor(projectDir) {
    const { dir, config } = projectContext(projectDir);
    return specs.resolveRunsRoot({
      configured: null,
      configArtifactRoot: config.artifactRoot,
      baseDir: dir,
    }).runsRoot;
  }

  /**
   * @param {string | null | undefined} projectDir
   */
  function runsRootFor(projectDir) {
    const settings = getSettings();
    const { dir, config } = projectContext(projectDir);
    return specs.resolveRunsRoot({
      configured: settings.artifactRoot,
      configArtifactRoot: config.artifactRoot,
      // Studio spawns cairn with the project as cwd; the CLI resolves a
      // relative artifactRoot against its cwd.
      baseDir: dir,
    });
  }

  /**
   * @param {string | null | undefined} projectDir
   */
  function cairnFor(projectDir) {
    const settings = getSettings();
    const { dir } = projectContext(projectDir);
    const resolved = cli.resolveCairn({
      configured: settings.cairnBin,
      repoRoot: repoBinExists() ? ctx.repoRoot : null,
      env: cli.augmentedEnv(),
    });
    return { ...resolved, cwd: dir };
  }

  /** @returns {boolean} */
  function repoBinExists() {
    return fs.existsSync(path.join(ctx.repoRoot, "bin", "cairn"));
  }

  /**
   * Reject paths that are not inside an allowed root.
   * @param {string} target
   * @param {Array<string | null | undefined>} roots
   * @returns {string}
   */
  function assertWithin(target, roots) {
    const resolved = path.resolve(String(target ?? ""));
    if (!runs.isWithin(resolved, roots))
      throw new Error(`path outside project: ${resolved}`);
    return resolved;
  }

  /**
   * Directories a renderer may read from for this project.
   * @param {string | null | undefined} projectDir
   * @returns {string[]}
   */
  function readRoots(projectDir) {
    const context = projectContext(projectDir);
    return [
      context.dir,
      runsRootFor(context.dir).runsRoot,
      // journals live under the config's root even with Studio's override
      path.join(sessionsRootFor(context.dir), authoring.SESSIONS_DIR),
      ...restoredRoots,
    ];
  }

  /**
   * A spec path the renderer may read/verify/run: inside the project or a
   * restored stash, or a file the user explicitly picked.
   * @param {unknown} file
   * @param {string} projectDir
   * @returns {string}
   */
  function assertSpecPath(file, projectDir) {
    const resolved = path.resolve(String(file ?? ""));
    if (allowedFiles.has(resolved)) return resolved;
    return assertWithin(resolved, [projectDir, ...restoredRoots]);
  }

  /**
   * @param {string} runRef
   * @param {string | null | undefined} projectDir
   * @returns {string} absolute run directory
   */
  function runDirFor(runRef, projectDir) {
    const { runsRoot } = runsRootFor(projectDir);
    const resolved = runs.resolveRunRef(runsRoot, runRef, {
      allowedRoots: [runsRoot, ...restoredRoots],
    });
    if (!resolved) throw new Error(`unknown run: ${runRef}`);
    return resolved;
  }

  /**
   * A `cairn diff` operand: latest/previous, a run id (or its suffix), or an
   * absolute directory inside the allowed roots.
   * @param {unknown} value
   * @param {string} runsRoot
   * @returns {string}
   */
  function diffOperand(value, runsRoot) {
    const text = String(value ?? "").trim();
    if (text === "latest" || text === "previous") return text;
    if (path.isAbsolute(text)) {
      assertWithin(text, [runsRoot, ...restoredRoots]);
      return path.resolve(text);
    }
    if (!/^[\w.:-]+$/.test(text) || text.startsWith("-"))
      throw new Error(`invalid run reference: ${text}`);
    return text;
  }

  /**
   * @param {string} channel
   * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => any} handler
   */
  const handle = (channel, handler) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await handler(event, ...args) };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? error),
          stack: error?.stack
            ? String(error.stack).split("\n").slice(0, 4).join("\n")
            : undefined,
        };
      }
    });

  // ── app + settings ────────────────────────────────────────────────────────
  handle("app:info", () => {
    const settings = getSettings();
    const cairn = cairnFor(null);
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath("userData"),
      repoRoot: ctx.repoRoot,
      cairn,
      settings,
      runsRoot: runsRootFor(null),
    };
  });

  /**
   * Ask the user in a native dialog the renderer cannot draw or answer.
   * @param {{ message: string, detail: string, confirmLabel: string }} prompt
   * @returns {Promise<boolean>} true when the user confirmed
   */
  async function confirmInMain(prompt) {
    const options = {
      type: /** @type {const} */ ("warning"),
      buttons: [prompt.confirmLabel, "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: prompt.message,
      detail: prompt.detail,
    };
    const win = ctx.getWindow?.() ?? null;
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result?.response === 0;
  }

  handle("settings:get", () => getSettings());

  // Only validated run/ui defaults; everything else has its own handler.
  handle("settings:update", (_event, patch) => {
    const clean = settingsStore.sanitizeRendererPatch(patch);
    cache.clear();
    return writeSettings(clean);
  });

  handle("settings:set-cairn-bin", async (_event, value) => {
    const checked = settingsStore.checkCairnBinary(value);
    const current = getSettings().cairnBin ?? null;
    if (checked.path && checked.path !== current && checked.needsConfirm) {
      const confirmed = await confirmInMain({
        message: "Use this executable as cairn?",
        detail: `${checked.path}\n\nStudio runs it for every action (run, verify, heal, stash, docs). Its name does not start with "cairn".`,
        confirmLabel: "Use it",
      });
      if (!confirmed) throw new Error("cairn binary not changed");
    }
    cache.clear();
    return writeSettings({ cairnBin: checked.path });
  });

  handle("settings:set-artifact-root", async (_event, value) => {
    const next = settingsStore.checkArtifactRoot(value);
    const currentValue = getSettings().artifactRoot;
    const current = currentValue ? path.resolve(currentValue) : null;
    if (next && next !== current && !pickedDirs.has(next)) {
      const confirmed = await confirmInMain({
        message: "Use this folder as the artifact root?",
        detail: `${next}\n\nStudio lists and reads run folders from it and passes it to cairn as --artifact-root.`,
        confirmLabel: "Use folder",
      });
      if (!confirmed) throw new Error("artifact root not changed");
    }
    cache.clear();
    return writeSettings({ artifactRoot: next });
  });

  handle("settings:reset", async () => {
    // Reset clears every project's lock files: while one is held, that is
    // the same as lifting the lock, so it needs a native yes.
    const held = heldLocks(getSettings());
    if (held.length) {
      const confirmed = await confirmInMain({
        message: "Reset while a suite lock is held?",
        detail: `${held.map((lock) => lock.path).join("\n")}\n\nResetting forgets these lock files, so Studio would no longer refuse runs while the suite is in progress.`,
        confirmLabel: "Reset anyway",
      });
      if (!confirmed) throw new Error("settings not reset");
    }
    cache.clear();
    return settingsStore.saveSettings(
      settingsFile,
      settingsStore.defaultSettings(),
    );
  });

  handle("settings:reveal", () => {
    shell.showItemInFolder(settingsFile);
    return settingsFile;
  });

  // ── cairn binary ──────────────────────────────────────────────────────────
  handle("cairn:resolve", (_event, projectDir) => {
    const cairn = cairnFor(projectDir);
    return { ...cairn, settings: getSettings().cairnBin };
  });

  /**
   * `<command> --version` → semver, or null.
   * @param {string | null} command
   * @returns {Promise<string | null>}
   */
  async function versionOf(command) {
    if (!command) return null;
    try {
      const result = await cli.execCairn({
        command,
        argv: ["--version"],
        // A neutral cwd: --version must not discover any project config.
        cwd: os.tmpdir(),
        timeoutMs: 20_000,
      });
      return cli.parseVersionOutput(`${result.stdout}\n${result.stderr}`);
    } catch {
      return null;
    }
  }

  handle("cairn:version", async (_event, projectDir) => {
    const cairn = cairnFor(projectDir);
    if (!cairn.command)
      return { version: null, error: "cairn binary not found" };
    const version = await versionOf(cairn.command);
    return { version, command: cairn.command, source: cairn.source };
  });

  handle("cairn:versions", async () => {
    return cached("cairn:versions", 60_000, async () => {
      const cairn = cairnFor(null);
      const env = cli.augmentedEnv();
      const onPath = cli.which("cairn", env);
      const repoBin = repoBinExists()
        ? path.join(ctx.repoRoot, "bin", "cairn")
        : null;
      const [resolvedVersion, pathVersion, repoVersion] = await Promise.all([
        versionOf(cairn.command),
        onPath && onPath !== cairn.command ? versionOf(onPath) : null,
        repoBin && repoBin !== cairn.command ? versionOf(repoBin) : null,
      ]);
      const pathV = onPath === cairn.command ? resolvedVersion : pathVersion;
      const repoV = repoBin === cairn.command ? resolvedVersion : repoVersion;
      const mismatch = Boolean(pathV && repoV && pathV !== repoV);
      return {
        resolved: {
          command: cairn.command,
          source: cairn.source,
          version: resolvedVersion,
        },
        path: onPath ? { command: onPath, version: pathV } : null,
        repo: repoBin ? { command: repoBin, version: repoV } : null,
        mismatch,
        warning: mismatch
          ? `PATH cairn is ${pathV} but this checkout's bin/cairn is ${repoV}`
          : null,
      };
    });
  });

  handle("cairn:doctor", async (_event, projectDir) => {
    const cairn = cairnFor(projectDir);
    if (!cairn.command)
      throw new Error("cairn binary not found — set it in Settings");
    return cached(`doctor:${cairn.command}`, 15_000, async () => {
      const result = await cli.execCairn({
        command: cairn.command,
        argv: ["doctor", "--json"],
        cwd: cairn.cwd,
        timeoutMs: 90_000,
      });
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        payload: result.payload,
        stderr: cli.parseJsonPayload(result.stdout)
          ? ""
          : result.stderr.slice(-4000),
      };
    });
  });

  handle("cairn:choose-binary", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose the cairn executable",
      buttonLabel: "Use this binary",
      properties: ["openFile"],
    });
    if (canceled || !filePaths[0]) return null;
    const chosen = filePaths[0];
    writeSettings({ cairnBin: chosen });
    cache.clear();
    return chosen;
  });

  // ── projects ──────────────────────────────────────────────────────────────
  handle("projects:list", () => {
    const settings = getSettings();
    return {
      active: settings.activeProject,
      projects: settings.projects.map((entry) => ({
        ...entry,
        exists: fs.existsSync(entry.path),
      })),
    };
  });

  handle("projects:choose", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Open a cairntrace project",
      buttonLabel: "Open project",
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths[0]) return null;
    const dir = filePaths[0];
    writeSettings(settingsStore.withRecentProject(getSettings(), dir));
    cache.clear();
    ctx.media?.clear();
    return dir;
  });

  // Re-opens a project Studio already knows; new ones come from the dialog.
  handle("projects:open-recent", (_event, dir) => {
    const target = path.resolve(String(dir ?? ""));
    if (!knownProjectDirs(getSettings()).has(target))
      throw new Error(
        `not a recent project: ${target} (use Open project… to add it)`,
      );
    if (!fs.existsSync(target)) throw new Error(`missing directory: ${target}`);
    writeSettings(settingsStore.withRecentProject(getSettings(), target));
    cache.clear();
    return target;
  });

  handle("projects:forget", (_event, dir) => {
    writeSettings(settingsStore.withoutProject(getSettings(), String(dir)));
    cache.clear();
    return getSettings().projects;
  });

  /**
   * Async spec scan that skips the artifact root and run copies.
   * @param {string} dir
   * @param {string} runsRoot
   */
  function scanProjectSpecs(dir, runsRoot) {
    return specs.scanSpecs(dir, { excludeDirs: [runsRoot], cache: specCache });
  }

  handle("project:inspect", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const info = specs.inspectProjectDir(context.dir);
    const runsRoot = runsRootFor(context.dir);
    const specFiles = await scanProjectSpecs(context.dir, runsRoot.runsRoot);
    return {
      ...info,
      // never the parsed document: its ${env.X} values may be credentials
      config: specs.publicConfig(context.config),
      runsRoot,
      specs: specFiles,
      specNames: runs.listRunSpecs(runsRoot.runsRoot),
      launch: launch.projectLaunchSettings(getSettings(), context.dir),
    };
  });

  // F3b: the project's fixture ledger, folded into the live state per
  // environment and fixture. The renderer names no path: the file is
  // `<project>.ledger.jsonl` under the CLI's ledger folder, for the config's
  // `project:` (default `cairntrace`, like the runner), and a name that is
  // not a plain file name is refused (the CLI keeps no ledger for it).
  handle("fixtures:ledger", (_event, projectDir) => {
    const context = projectContext(projectDir);
    const dir = path.resolve(
      ctx.fixturesLedgerDir ??
        path.join(os.homedir(), ".cairntrace", "fixtures"),
    );
    const name = registries.ledgerProjectName(context.config?.project);
    const file = name ? path.join(dir, `${name}.ledger.jsonl`) : null;
    if (!file || path.dirname(file) !== dir)
      return {
        path: null,
        exists: false,
        entries: [],
        lines: 0,
        partial: false,
        project: null,
      };
    return { ...dataEvidence.readFixtureLedger(file), project: name };
  });

  // ── specs ─────────────────────────────────────────────────────────────────
  handle("specs:list", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    return scanProjectSpecs(context.dir, runsRootFor(context.dir).runsRoot);
  });

  /** Bound on a project dotenv file read for opt-in answers. */
  const MAX_DOTENV_BYTES = 256 * 1024;

  /**
   * Whether each `requires.env` opt-in variable is granted ("1"/"true", any
   * case) for a cairn spawned in `dir`: the spawn environment first, then
   * the project's dotenv files the way Bun loads them for `bin/cairn`
   * (`.env.local` over `.env.<NODE_ENV|development>` over `.env`;
   * `.env.local` is skipped when NODE_ENV is "test"). Booleans only: no
   * value reaches the renderer.
   * @param {any} requires the spec summary's `requires`
   * @param {string} dir project directory (cairn's cwd)
   * @returns {Record<string, boolean>}
   */
  function optInStatesFor(requires, dir) {
    const names = CairnPolicy.optInNames(requires);
    if (!names.length) return {};
    const spawnEnv = cli.augmentedEnv();
    const nodeEnv = spawnEnv.NODE_ENV || "development";
    const files = [".env", `.env.${nodeEnv}`];
    if (nodeEnv !== "test") files.push(".env.local");
    /** @type {Record<string, string | undefined>} */
    const merged = {};
    for (const name of files) {
      let text = "";
      try {
        const target = path.join(dir, name);
        if (fs.statSync(target).size > MAX_DOTENV_BYTES) continue;
        text = fs.readFileSync(target, "utf8");
      } catch {
        continue;
      }
      Object.assign(merged, CairnPolicy.parseDotEnv(text, names));
    }
    for (const name of names)
      if (spawnEnv[name] !== undefined) merged[name] = spawnEnv[name];
    return CairnPolicy.optInStates(requires, merged);
  }

  handle("spec:read", (_event, file, projectDir) => {
    const context = projectContext(projectDir);
    const target = assertSpecPath(file, context.dir);
    const text = fs.readFileSync(target, "utf8");
    const summary = specs.summarizeSpecText(text, target);
    return {
      path: target,
      text,
      summary,
      bytes: Buffer.byteLength(text),
      optIns: optInStatesFor(summary.requires, context.dir),
    };
  });

  handle("spec:write", (_event, file, text, projectDir) => {
    const context = projectContext(projectDir);
    const target = assertWithin(String(file ?? ""), [context.dir]);
    if (!isYamlPath(target))
      throw new Error(`only .yml/.yaml specs can be written: ${target}`);
    if (typeof text !== "string") throw new Error("text required");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    const summary = specs.summarizeSpecText(text, target);
    return {
      path: target,
      bytes: Buffer.byteLength(text),
      summary,
      // the saved `requires` may name new opt-ins: answer them again
      optIns: optInStatesFor(summary.requires, context.dir),
    };
  });

  handle("spec:scaffold", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const name = String(options?.name ?? "").trim();
    if (!name) throw new Error("name required");
    if (name.startsWith("-")) throw new Error("invalid spec name");
    const outDir = assertWithin(
      path.resolve(context.dir, String(options?.out ?? "flows")),
      [context.dir],
    );
    const argv = ["spec", "scaffold", name, "--out", outDir];
    if (options?.intent) argv.push("--intent", String(options.intent));
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    if (!result.ok)
      throw new Error(
        `scaffold failed (${cli.describeExitCode(result.exitCode)}): ${result.stderr.slice(-800) || result.stdout.slice(-800)}`,
      );
    const created = specs.scaffoldTarget(outDir, name);
    return {
      path: created,
      exists: fs.existsSync(created),
      stdout: result.stdout.slice(0, 4000),
    };
  });

  handle("spec:verify", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const specPath = assertSpecPath(options?.spec, context.dir);
    const flags = settingsStore.sanitizeRunSettings({
      env: options?.env ?? getSettings().run?.env ?? null,
      vars: options?.vars ?? getSettings().run?.vars ?? [],
    });
    const argv = cli.buildVerifyArgv({
      spec: specPath,
      config: options?.config
        ? assertWithin(String(options.config), [context.dir])
        : context.configPath,
      env: flags.env ?? null,
      stamp: Boolean(options?.stamp),
      vars: flags.vars ?? [],
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 120_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      payload: result.payload,
      stderr: result.stderr.slice(-8000),
      stdout: result.stdout.slice(-8000),
    };
  });

  handle("spec:heal", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const specPath = assertSpecPath(options?.spec, context.dir);
    assertUnlocked(context.dir, "Heal");
    // The same environment and vars as Run: every heal rerun resolves them.
    const flags = settingsStore.sanitizeRunSettings({
      backend: options?.backend ?? getSettings().run?.backend ?? null,
      env: options?.env ?? getSettings().run?.env ?? null,
      vars: options?.vars ?? getSettings().run?.vars ?? [],
    });
    const healEnvs = runEnvironments(
      [specPath],
      flags.env ?? null,
      context.config,
    );
    assertServicesIdle(context.dir, healEnvs, "Heal");
    const argv = cli.buildHealArgv({
      spec: specPath,
      backend: flags.backend ?? null,
      env: flags.env ?? null,
      vars: flags.vars ?? [],
      mock: Boolean(options?.mock ?? getSettings().run?.mock),
      headed: Boolean(options?.headed ?? getSettings().run?.headed),
      apply: Boolean(options?.apply),
      verify: Boolean(options?.verify),
      config: context.configPath,
    });
    const token = nextToken();
    const controller = new AbortController();
    activeRuns.set(token, {
      controller,
      tail: null,
      specs: [specPath],
      startedAt: Date.now(),
      argv,
      command: cairn.command,
      projectDir: context.dir,
      envs: healEnvs,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 0,
      signal: controller.signal,
      onLog: (entry) => ctx.send("run:log", { token, entry }),
    });
    activeRuns.delete(token);
    ctx.send("run:done", {
      token,
      kind: "heal",
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      timedOut: result.timedOut,
      payload: result.payload,
      stderr: result.stderr.slice(-8000),
    });
    return {
      token,
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      payload: result.payload,
      stderr: result.stderr.slice(-8000),
    };
  });

  // ── launch safety (templates + locks) ─────────────────────────────────────
  /**
   * @param {string} dir
   */
  function lockStatus(dir) {
    const settings = launch.projectLaunchSettings(getSettings(), dir);
    const locks = launch.readLockState(dir, settings.lockFiles);
    // The config `run: { lock }` the CLI takes for every cairn run (CLI or
    // MCP): a live owner holds it, and the CLI would refuse a second run
    // (exit 4), so Studio treats it like a held suite lock.
    const config = specs.readProjectConfig(
      specs.inspectProjectDir(dir).configPath,
    );
    const runLock = {
      configured: config.runLock.configured,
      scopes: config.runLock.scopes,
      held: config.runLock.configured
        ? ops.readRunLocks({
            lockDir: ctx.runLockDir ?? ops.runLockRoot(),
            keys: ops.runLockKeys({
              configPath: config.path,
              project: config.project,
            }),
          })
        : [],
    };
    return {
      launchTemplate: settings.launchTemplate,
      lockFiles: settings.lockFiles,
      locks,
      runLock,
      active: [...locks.filter((entry) => entry.exists), ...runLock.held],
    };
  }

  /**
   * Locks currently held across every project with configured lock files.
   * @param {Record<string, any>} settings
   * @returns {Array<Record<string, any>>}
   */
  function heldLocks(settings) {
    const held = [];
    for (const dir of Object.keys(settings.projectSettings ?? {})) {
      const { lockFiles } = launch.projectLaunchSettings(settings, dir);
      if (lockFiles.length)
        held.push(
          ...launch.readLockState(dir, lockFiles).filter((lock) => lock.exists),
        );
    }
    return held;
  }

  /**
   * Refuse while a configured suite lock exists. There is no override: heal
   * re-runs the spec (preconditions included), so it is gated like a run.
   * @param {string} dir
   * @param {string} what
   */
  function assertUnlocked(dir, what) {
    const gate = lockStatus(dir);
    if (!gate.active.length) return gate;
    const first = gate.active[0];
    if (first.kind === "run-lock")
      throw new Error(
        `a cairn run holds this project's run lock (${first.owner}${
          first.command ? `: ${first.command}` : ""
        }) — ${what} is disabled until it finishes`,
      );
    throw new Error(
      `suite in progress: ${first.path}${
        first.owner ? ` (owner: ${first.owner})` : ""
      } — ${what} is disabled while the lock exists`,
    );
  }

  /**
   * The environments a run or heal uses: the explicit `--env`, else each
   * spec's `environment:` or the config's `defaultEnvironment` (the CLI's
   * order). Null when one cannot be told, which overlaps every environment.
   * @param {string[]} specPaths
   * @param {string | null} explicitEnv
   * @param {{ defaultEnvironment?: string | null }} config
   * @returns {string[] | null}
   */
  function runEnvironments(specPaths, explicitEnv, config) {
    if (explicitEnv) return [explicitEnv];
    const out = new Set();
    for (const specPath of specPaths) {
      let env = null;
      try {
        env = specs.summarizeSpecText(
          fs.readFileSync(specPath, "utf8"),
          specPath,
        ).environment;
      } catch {
        env = null;
      }
      env = env ?? config?.defaultEnvironment ?? null;
      if (!env) return null;
      out.add(env);
    }
    return [...out];
  }

  /**
   * Refuse while `cairn services up|down` runs for the same project and
   * environment: `services up` writes its lock only after the boot, so a
   * run started meanwhile would start (and later tear down) its own
   * services underneath it; `services down` is pulling them out.
   * @param {string} dir
   * @param {string[] | null} envs
   * @param {string} what
   */
  function assertServicesIdle(dir, envs, what) {
    for (const [key, action] of servicesBusy) {
      const [busyDir, env] = key.split("\0");
      if (busyDir !== dir || !envsOverlap(envs, [env])) continue;
      throw new Error(
        `cairn services ${action} is running for "${env}" — ${what} is disabled until it finishes${
          envs === null
            ? " (this run's environment cannot be told before it starts; pick one in Run settings)"
            : ""
        }`,
      );
    }
  }

  /**
   * Refuse `services up|down` while a run or heal Studio started uses that
   * environment of the project (down would pull its services out; up would
   * boot a second copy that run then tears down).
   * @param {string} dir
   * @param {string} env
   * @param {"up" | "down" | "restart"} action
   */
  function assertNoStudioRunsOn(dir, env, action) {
    const using = [...activeRuns.values()].filter(
      (entry) =>
        entry.projectDir === dir && envsOverlap(entry.envs ?? null, [env]),
    );
    if (!using.length) return;
    const names = using
      .flatMap((entry) => entry.specs)
      .map((spec) => path.basename(spec))
      .slice(0, 3)
      .join(", ");
    throw new Error(
      `a run Studio started is using "${env}" (${names}${
        using.flatMap((entry) => entry.specs).length > 3 ? ", …" : ""
      }) — cancel it or let it finish before cairn services ${action}`,
    );
  }

  handle("project:locks", (_event, projectDir) =>
    lockStatus(projectContext(projectDir).dir),
  );

  handle("project:launch-update", async (_event, patch, projectDir) => {
    const context = projectContext(projectDir);
    const template =
      typeof patch?.launchTemplate === "string" && patch.launchTemplate.trim()
        ? patch.launchTemplate.trim()
        : null;
    if (template) {
      const checked = launch.validateTemplate(template);
      if (!checked.ok) throw new Error(checked.error);
    }
    const lockFiles = (Array.isArray(patch?.lockFiles) ? patch.lockFiles : [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
    for (const entry of lockFiles)
      if (
        path.isAbsolute(entry)
          ? !runs.isWithin(entry, [context.dir])
          : !runs.safeJoin(context.dir, entry)
      )
        throw new Error(`lock path must stay inside the project: ${entry}`);
    // A template replaces `cairn run` for every Run in this project, so a new
    // one needs the user's yes in a dialog the renderer cannot answer.
    const before = launch.projectLaunchSettings(getSettings(), context.dir);
    const previous = before.launchTemplate;
    // Dropping a lock file that is held right now lifts the gate mid-suite.
    const kept = new Set(lockFiles);
    const lifted = launch
      .readLockState(
        context.dir,
        before.lockFiles.filter((entry) => !kept.has(entry)),
      )
      .filter((lock) => lock.exists);
    if (lifted.length) {
      const confirmed = await confirmInMain({
        message: "Remove a suite lock that is held right now?",
        detail: `${lifted.map((lock) => lock.path).join("\n")}\n\nStudio refuses runs while this lock exists. Removing it from the list lets runs start while the suite is still in progress.`,
        confirmLabel: "Remove lock",
      });
      if (!confirmed) throw new Error("lock files not changed");
    }
    if (template && template !== previous) {
      const confirmed = await confirmInMain({
        message: "Run this project's specs through a launch template?",
        detail: `${template}\n\nProject: ${context.dir}\n\nEvery Run in Studio will spawn this command (tokenized, no shell) instead of cairn run.`,
        confirmLabel: "Use template",
      });
      if (!confirmed) throw new Error("launch template not changed");
    }
    const current = getSettings().projectSettings ?? {};
    writeSettings({
      projectSettings: {
        ...current,
        [context.dir]: { launchTemplate: template, lockFiles },
      },
    });
    return lockStatus(context.dir);
  });

  handle("launch:preview", (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const template = String(options?.template ?? "").trim();
    if (!template) return { command: null, args: [] };
    const spec = options?.spec
      ? path.resolve(String(options.spec))
      : path.join(context.dir, "flows", "example.yml");
    const runSettings = getSettings().run ?? {};
    const argv = cli.buildRunArgv({
      specs: [spec],
      env: runSettings.env ?? null,
      backend: runSettings.backend ?? null,
      config: context.configPath,
      labels: runSettings.labels ?? [],
      vars: runSettings.vars ?? [],
      logLevel: runSettings.logLevel ?? "info",
    });
    return launch.buildLaunchCommand(template, {
      specs: [spec],
      env: runSettings.env ?? null,
      runArgv: argv,
      projectDir: context.dir,
    });
  });

  // ── runs ──────────────────────────────────────────────────────────────────
  handle("run:start", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command)
      throw new Error("cairn binary not found — set it in Settings");
    const settings = getSettings();
    const runSettings = settings.run ?? {};
    const requested = Array.isArray(options?.specs) ? options.specs : [];
    // `cairn run --suite <name>` stands in for the spec paths
    const suiteName = options?.suite ? cli.checkSuiteName(options.suite) : null;
    if (suiteName && requested.length)
      throw new Error("run specs or one suite, not both");
    if (!suiteName && !requested.length) throw new Error("no spec selected");
    let specPaths = requested.map((spec) => assertSpecPath(spec, context.dir));
    // No override: while a suite lock exists, nothing Studio starts can run.
    const gate = assertUnlocked(context.dir, "Run");
    if (suiteName && gate.launchTemplate)
      throw new Error(
        "this project runs specs through a launch template, which takes one spec at a time — run the suite from a terminal, or clear the template in Settings",
      );
    const runsRoot = runsRootFor(context.dir);
    // Saved defaults and per-run overrides both become argv: validate them.
    const merged = settingsStore.sanitizeRunSettings({
      ...runSettings,
      ...settingsStore.sanitizeRunSettings(options?.overrides),
    });
    /** @type {string[] | null} */
    let runEnvs;
    if (suiteName) {
      // The suite's specs and environment verdict come from the CLI itself
      // (`cairn suites list`): an unknown suite or an environment its
      // `requires` rules out is refused here, before anything spawns, and
      // the live tail learns which spec names to look for.
      const envName = merged.env ?? context.config.defaultEnvironment ?? null;
      const listArgv = ops.buildSuitesArgv({
        env: envName,
        config: context.configPath,
      });
      const listed = await cli.execCairn({
        command: cairn.command,
        argv: listArgv,
        cwd: context.dir,
        timeoutMs: 60_000,
      });
      const doc = ops.normalizeSuites(listed.payload);
      if (!doc)
        throw new Error(
          authoring.looksUnsupported(listed)
            ? "this cairn has no `cairn suites list` (config suites need a newer cairn)"
            : `cairn suites list failed: ${authoring.refusalText(listed.stderr) ?? "no document"}`,
        );
      const suite = doc.suites.find((entry) => entry.name === suiteName);
      if (!suite) throw new Error(`unknown suite: ${suiteName}`);
      const forEnv = envName
        ? suite.envs.find((entry) => entry.env === envName)
        : null;
      if (forEnv?.problem)
        throw new Error(
          `suite ${suiteName} cannot run on ${envName}: ${forEnv.problem}`,
        );
      const root = doc.root ?? context.dir;
      specPaths = (forEnv?.specs ?? []).map((spec) => path.resolve(root, spec));
      runEnvs = envName ? [envName] : null;
    } else {
      runEnvs = runEnvironments(specPaths, merged.env ?? null, context.config);
    }
    assertServicesIdle(context.dir, runEnvs, "Run");
    const argv = cli.buildRunArgv({
      specs: suiteName ? [] : specPaths,
      suite: suiteName,
      env: merged.env ?? null,
      backend: merged.backend ?? null,
      provider: merged.provider ?? null,
      device: merged.device ?? null,
      config: context.configPath,
      artifactRoot: settings.artifactRoot ? runsRoot.runsRoot : null,
      headed: Boolean(merged.headed),
      coldStart: Boolean(merged.coldStart),
      mock: Boolean(merged.mock),
      monitor: Boolean(merged.monitor),
      parallel: Number(merged.parallel ?? 1),
      noWebServer: Boolean(merged.noWebServer),
      noServices: Boolean(merged.noServices),
      stashOnFailure: Boolean(merged.stashOnFailure),
      vars: merged.vars ?? [],
      labels: merged.labels ?? [],
      tags: merged.tags ?? [],
      logLevel: merged.logLevel ?? "info",
    });

    // A project launch template (task runner, wrapper script) replaces the
    // bare `cairn run`; Studio still tails the artifact root the same way.
    let command = cairn.command;
    let commandArgv = argv;
    let launcher = "cairn";
    if (gate.launchTemplate) {
      const built = launch.buildLaunchCommand(gate.launchTemplate, {
        specs: specPaths,
        env: merged.env ?? null,
        runArgv: argv,
        projectDir: context.dir,
      });
      // A path-like command (./tools/run-suite.sh) is relative to the project.
      const resolved =
        built.command.includes("/") && !path.isAbsolute(built.command)
          ? cli.which(path.resolve(context.dir, built.command))
          : cli.which(built.command, cli.augmentedEnv());
      if (!resolved)
        throw new Error(
          `launch template command not found on PATH: ${built.command}`,
        );
      command = resolved;
      commandArgv = built.args;
      launcher = "template";
    }

    const token = nextToken();
    const controller = new AbortController();
    const knownIds = new Set(runs.listRunIds(runsRoot.runsRoot));
    // Run ids embed the spec's `name:` field, not the file basename — offer
    // both so the live tail recognises the directory the child creates.
    /** @type {Set<string>} */
    const specNames = new Set();
    for (const specPath of specPaths) {
      specNames.add(path.basename(specPath, path.extname(specPath)));
      try {
        const summary = specs.summarizeSpecText(
          fs.readFileSync(specPath, "utf8"),
          specPath,
        );
        if (summary?.name) specNames.add(summary.name);
      } catch {
        // an unreadable spec still runs (and fails) through the CLI
      }
    }

    ctx.send("run:started", {
      token,
      argv: commandArgv,
      command,
      launcher,
      cwd: context.dir,
      runsRoot: runsRoot.runsRoot,
      specs: specPaths,
      suite: suiteName,
      startedAt: new Date().toISOString(),
    });

    const tail = live.createLiveTail({
      runsRoot: runsRoot.runsRoot,
      // a suite whose specs could not be resolved tails any new run dir
      specNames: specNames.size ? specNames : null,
      knownIds,
      pollMs: Math.max(150, Number(settings.ui?.livePollMs ?? 400)),
      onRunDir: (runDir, runId) =>
        ctx.send("run:live", { token, runDir, runId }),
      onEvents: (events, runDir) =>
        ctx.send("run:events", { token, runDir, events }),
    });

    // A run whose environment has a delegated runner (environments.<n>.runner):
    // its cancel must leave cairn the runner's cancelGraceMs (see run:cancel).
    const delegatedRunner =
      (runEnvs ?? [])
        .map(
          (name) =>
            context.config.environments.find((env) => env.name === name)
              ?.runner ?? null,
        )
        .find((runner) => runner !== null) ?? null;
    activeRuns.set(token, {
      controller,
      tail,
      specs: specPaths,
      suite: suiteName,
      startedAt: Date.now(),
      argv: commandArgv,
      command,
      pid: null,
      projectDir: context.dir,
      envs: runEnvs,
      runsRoot: runsRoot.runsRoot,
      delegatedRunner,
    });

    /** Let the tail linger for late stash/retention events, bounded. */
    const releaseTail = () => {
      if (tail.ended()) return;
      lingeringTails.add(tail);
      // Never the reason a process stays up: shutdown() stops it anyway.
      setTimeout(() => {
        tail.stop();
        lingeringTails.delete(tail);
      }, TAIL_LINGER_CAP_MS).unref?.();
    };

    void cli
      .execCairn({
        command,
        argv: commandArgv,
        cwd: context.dir,
        timeoutMs: 0,
        signal: controller.signal,
        // Decided by run:cancel right before it aborts.
        cancelPolicy: () => cancelPolicies.get(token) ?? null,
        onSpawn: (pid) => {
          const entry = activeRuns.get(token);
          if (entry) entry.pid = pid ?? null;
          ctx.send("run:pid", { token, pid: pid ?? null, launcher });
        },
        onLog: (entry) => ctx.send("run:log", { token, entry }),
      })
      .then((result) => {
        // Give the tail a moment to discover the run dir and drain the
        // finish; it keeps draining afterwards for the linger window.
        setTimeout(() => {
          const cancelled = !activeRuns.has(token);
          activeRuns.delete(token);
          cancelPolicies.delete(token);
          if (cancelled) tail.stop();
          else releaseTail();
          ctx.send("run:done", {
            token,
            kind: "run",
            ok: result.ok,
            exitCode: result.exitCode,
            meaning: cli.describeExitCode(result.exitCode),
            timedOut: result.timedOut,
            payload: result.payload,
            runDir: tail.runDir(),
            stderr: result.stderr.slice(-8000),
          });
        }, 600);
      })
      .catch((error) => {
        tail.stop();
        activeRuns.delete(token);
        cancelPolicies.delete(token);
        ctx.send("run:done", {
          token,
          kind: "run",
          ok: false,
          exitCode: null,
          meaning: "spawn failed",
          error: String(error?.message ?? error),
          runDir: tail.runDir(),
        });
      });

    return { token, argv: commandArgv, command, cwd: context.dir, launcher };
  });

  /**
   * Live "Cancel" of a run Studio launched: SIGTERM to its process group,
   * SIGKILL 2s later — except a delegated run (its environment has a
   * runner, from the config or from the run's own journal): it gets SIGINT,
   * like Ctrl-C, and no early SIGKILL, so cairn can give the runner its
   * cancelGraceMs to cancel the remote invocation and copy the results back,
   * then mark the journal aborted and run `run.finally`. A SIGKILL only as a
   * safety net well after cairn's own bound (grace + 15s + 60s).
   */
  handle("run:cancel", (_event, token) => {
    const entry = activeRuns.get(String(token));
    if (!entry) return { cancelled: false };
    const policy = delegatedCancelPolicy(entry);
    if (policy) cancelPolicies.set(String(token), policy);
    entry.tail?.stop();
    entry.controller.abort();
    activeRuns.delete(String(token));
    return {
      cancelled: true,
      ...(policy ? { signal: policy.signal, delegated: true } : {}),
    };
  });

  /**
   * @param {any} entry an activeRuns entry
   * @returns {{ signal: NodeJS.Signals, killAfterMs: number | null } | null}
   */
  function delegatedCancelPolicy(entry) {
    let graceMs = entry.delegatedRunner?.cancelGraceMs ?? null;
    let delegated = Boolean(entry.delegatedRunner);
    if (!delegated && entry.runsRoot && entry.pid) {
      const journal = invocations.findRunningInvocationByPid(
        entry.runsRoot,
        entry.pid,
      );
      delegated = Boolean(journal?.delegate);
    }
    if (!delegated) return null;
    graceMs ??= DELEGATE_CANCEL_GRACE_MS;
    return { signal: "SIGINT", killAfterMs: graceMs + 15_000 + 60_000 };
  }

  handle("run:active", () =>
    [...activeRuns.entries()].map(([token, entry]) => ({
      token,
      specs: entry.specs,
      suite: entry.suite ?? null,
      argv: entry.argv,
      command: entry.command,
      pid: entry.pid ?? null,
      startedAt: new Date(entry.startedAt).toISOString(),
      elapsedMs: Date.now() - entry.startedAt,
    })),
  );

  handle("runs:list", (_event, options, projectDir) => {
    const { runsRoot, source } = runsRootFor(projectDir);
    const list = runs.listRuns(runsRoot, {
      limit: options?.limit ?? 120,
      status: options?.status ?? null,
      spec: options?.spec ?? null,
      search: options?.search ?? null,
      labels: Array.isArray(options?.labels) ? options.labels : null,
      invocation: options?.invocation ?? null,
    });
    return {
      runsRoot,
      source,
      exists: fs.existsSync(runsRoot),
      runs: list,
      specNames: runs.listRunSpecs(runsRoot),
      labels: cached(`labels:${runsRoot}`, 15_000, () =>
        runs.listRunLabels(runsRoot),
      ),
    };
  });

  handle("runs:labels", (_event, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    return cached(`labels:${runsRoot}`, 15_000, () =>
      runs.listRunLabels(runsRoot),
    );
  });

  handle("runs:history", (_event, options, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    return runs.runHistory(runsRoot, String(options?.spec ?? ""), {
      limit: Math.max(1, Math.min(Number(options?.limit ?? 20), 100)),
    });
  });

  handle("runs:detected", () => detectedRunsSnapshot());

  /**
   * Run directories still in flight that the app's own live tails do not
   * already track — i.e. runs started outside Studio.
   * @returns {Array<Record<string, any>>}
   */
  function detectedRunsSnapshot() {
    const excluded = appTrackedRunIds();
    return runs
      .listDetectedRuns(runsRootFor(null).runsRoot)
      .filter((run) => !excluded.has(run.runId));
  }

  /**
   * Run ids the app's own live tails track, so the external-run watcher does
   * not double-report runs Studio itself started.
   * @returns {Set<string>}
   */
  function appTrackedRunIds() {
    const ids = new Set();
    for (const entry of activeRuns.values()) {
      const dir = entry.tail?.runDir?.();
      if (dir) ids.add(path.basename(dir));
    }
    return ids;
  }

  /**
   * @param {string} runsRoot
   */
  function durationHistory(runsRoot) {
    return cached(`history:${runsRoot}`, 60_000, () =>
      runs.specDurationHistory(runsRoot),
    );
  }

  /**
   * Invocation journals plus a history-based ETA for each.
   * @param {Array<Record<string, any>>} list
   * @param {string} runsRoot
   */
  function withEta(list, runsRoot) {
    const history = durationHistory(runsRoot);
    return list.map((journal) => {
      const runId = journal.current?.runId;
      const currentStartedAtMs = runId
        ? runIdTimestampMs(parseRunId(runId).startedAt)
        : null;
      return {
        ...journal,
        eta: invocations.estimateInvocationEta(
          /** @type {any} */ (journal),
          history,
          { currentStartedAtMs },
        ),
      };
    });
  }

  handle("invocations:list", (_event, options, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    const limit = Math.max(1, Math.min(Number(options?.limit) || 40, 200));
    return {
      runsRoot,
      invocations: withEta(
        invocations.listInvocations(runsRoot, { limit }),
        runsRoot,
      ),
    };
  });

  handle("invocation:get", (_event, options, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    const journal = invocations.readInvocation(
      runsRoot,
      String(options?.invocationId ?? ""),
    );
    return journal ? withEta([journal], runsRoot)[0] : null;
  });

  /**
   * Stop a running invocation with SIGINT, which cairn handles like Ctrl-C
   * (current spec stops, cleanup runs, the journal turns "aborted").
   * Refused unless the journal is running, its pid is a live `cairn run` /
   * `cairn mcp` process that agrees with the journal and started no later
   * than it did, and the user confirms in a native dialog; the checks run
   * again after the dialog, right before the signal, because the process may
   * have ended while it was open.
   *
   * When cairn leads its own process group (a terminal job, a run Studio
   * launched), the whole group gets SIGINT, as a terminal Ctrl-C does, so a
   * running --before/--after hook's subprocesses stop too. Otherwise the
   * group belongs to whatever launched cairn (an agent host, a
   * non-interactive shell) and only the cairn pid is signalled; the dialog
   * says that hook subprocesses may then outlive it.
   */
  handle("invocation:stop", async (_event, options, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    const invocationId = String(options?.invocationId ?? "");
    const self = await invocations.readProcessInfo(process.pid);
    const inspect = async () => {
      const journal = invocations.readInvocation(runsRoot, invocationId);
      const info = journal?.pid
        ? await invocations.readProcessInfo(journal.pid)
        : null;
      return {
        journal,
        verdict: invocations.checkStoppable(journal, info, {
          selfPgid: self?.pgid ?? null,
        }),
      };
    };
    const first = await inspect();
    if (!first.verdict.ok)
      throw new Error(`not stopped: ${first.verdict.reason}`);
    const journal =
      /** @type {NonNullable<typeof first.journal>} */ (first.journal);
    const { pid, mcp, group } = first.verdict;
    const position = journal.current
      ? `spec ${journal.current.index}/${journal.planned.length || "?"} · ${journal.current.spec}`
      : `${journal.planned.length} planned spec(s)`;
    const confirmed = await confirmInMain({
      message: mcp
        ? "Stop the MCP server running this invocation?"
        : "Stop this cairn run?",
      detail: [
        `Invocation ${invocationId}`,
        position,
        `pid ${pid}: ${String(first.verdict.command).slice(0, 200)}`,
        "",
        group
          ? `Studio sends SIGINT to the process group pid ${pid} leads, like Ctrl-C in its terminal: the current spec stops, cleanup runs, a running --before/--after hook stops with it, and the invocation is marked aborted.`
          : `Studio sends SIGINT to pid ${pid} only: it does not lead its own process group, so the group belongs to whatever launched it. cairn stops the current spec, runs cleanup and marks the invocation aborted, but subprocesses of a running --before/--after hook may outlive it.`,
        ...(mcp
          ? [
              "",
              `This invocation runs inside a cairn MCP server${
                journal.client ? ` (client: ${journal.client})` : ""
              }. SIGINT stops that whole server: every run it drives ends and the agent loses its cairn tools until it restarts the server.`,
            ]
          : []),
      ].join("\n"),
      confirmLabel: mcp ? "Stop MCP server" : "Stop run",
    });
    if (!confirmed) return { stopped: false, cancelled: true };
    const second = await inspect();
    const changed =
      second.verdict.ok &&
      (second.verdict.pid !== pid ||
        second.verdict.group !== group ||
        second.verdict.mcp !== mcp);
    if (!second.verdict.ok || changed)
      throw new Error(
        `not stopped: ${
          second.verdict.ok
            ? "the process changed while the dialog was open"
            : second.verdict.reason
        }`,
      );
    try {
      process.kill(group ? -pid : pid, "SIGINT");
    } catch (error) {
      // It exited between the last check and the signal: nothing to stop.
      if (/** @type {any} */ (error)?.code === "ESRCH")
        throw new Error(`not stopped: process ${pid} exited`, {
          cause: error,
        });
      throw error;
    }
    return {
      stopped: true,
      pid,
      signal: "SIGINT",
      target: group ? "group" : "process",
    };
  });

  /**
   * @param {unknown} invocationId
   * @param {string | null | undefined} projectDir
   * @returns {string}
   */
  function invocationDirFor(invocationId, projectDir) {
    const { runsRoot } = runsRootFor(projectDir);
    const dir = invocations.invocationDir(runsRoot, String(invocationId ?? ""));
    if (!dir) throw new Error(`invalid invocation id: ${invocationId}`);
    return dir;
  }

  handle("invocation:events", (_event, options, projectDir) =>
    runs.readEventsFrom(
      invocationDirFor(options?.invocationId, projectDir),
      Number(options?.offset ?? 0),
    ),
  );

  handle("invocation:tail-text", (_event, options, projectDir) =>
    runs.readTextFrom(
      invocationDirFor(options?.invocationId, projectDir),
      String(options?.path ?? ""),
      Number(options?.offset ?? 0),
      Math.min(Number(options?.maxBytes ?? 64 * 1024), 512 * 1024),
    ),
  );

  handle("run:detail", (_event, runRef, projectDir) => {
    const runDir = runDirFor(String(runRef), projectDir);
    const detail = runs.readRunDetail(runDir);
    // A run outside the artifact root is a stash restore: retention (and so
    // pinning) does not apply to it.
    detail.restored = !runs.isWithin(runDir, [
      runsRootFor(projectDir).runsRoot,
    ]);
    // The spec a run record names may live outside the project (shared
    // artifact root); opening/re-running it from this run is explicit. A run
    // record can come from a restored stash, so only a YAML spec path counts.
    const specPath = detail.run?.spec?.path;
    if (
      typeof specPath === "string" &&
      path.isAbsolute(specPath) &&
      isYamlPath(specPath)
    )
      allowFiles([specPath]);
    return detail;
  });

  handle("run:artifact-text", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    return runs.readBoundedText(
      runDir,
      String(options?.path ?? ""),
      Math.min(
        Number(options?.maxBytes ?? runs.DEFAULT_MAX_TEXT_BYTES),
        runs.DEFAULT_MAX_TEXT_BYTES * 4,
      ),
    );
  });

  // A hook log of a run: hook.* live in the run's invocation journal, so the
  // path is relative to that journal folder, which is derived from the run's
  // own record (never from the renderer).
  handle("run:journal-text", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    const journalDir = runs.runJournalDir(runDir);
    if (!journalDir)
      return {
        ok: false,
        text: null,
        truncated: false,
        bytes: 0,
        error: "this run has no invocation journal",
      };
    return runs.readBoundedText(
      journalDir,
      String(options?.path ?? ""),
      Math.min(
        Number(options?.maxBytes ?? runs.DEFAULT_MAX_TEXT_BYTES),
        runs.DEFAULT_MAX_TEXT_BYTES * 4,
      ),
    );
  });

  handle("run:artifact-image", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    return runs.readAsDataUrl(runDir, String(options?.path ?? ""));
  });

  handle("run:tail-text", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    return runs.readTextFrom(
      runDir,
      String(options?.path ?? ""),
      Number(options?.offset ?? 0),
      Math.min(Number(options?.maxBytes ?? 64 * 1024), 512 * 1024),
    );
  });

  handle("run:media-url", (_event, options, projectDir) => {
    if (!ctx.media) throw new Error("media streaming unavailable");
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    const rel = String(options?.path ?? "");
    const kind = runs.classifyArtifact(rel);
    if (kind !== "video" && kind !== "image")
      throw new Error("only video and image artifacts stream");
    const absolute = runs.safeJoin(runDir, rel);
    if (!absolute || !fs.existsSync(absolute))
      throw new Error(`missing artifact: ${rel}`);
    return { url: ctx.media.register(absolute), kind };
  });

  handle("run:trace-info", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    const info = runs.sniffArtifact(runDir, String(options?.path ?? ""));
    return {
      ...info,
      canShowTrace:
        info.kind === "playwright-zip" &&
        Boolean(cli.which("bunx", cli.augmentedEnv())),
    };
  });

  handle("run:open-trace", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    const rel = String(options?.path ?? "");
    const absolute = runs.safeJoin(runDir, rel);
    if (!absolute || !fs.existsSync(absolute))
      throw new Error(`missing trace: ${rel}`);
    const info = runs.sniffArtifact(runDir, rel);
    const bunx = cli.which("bunx", cli.augmentedEnv());
    if (info.kind === "playwright-zip" && bunx) {
      cli.spawnDetached(bunx, ["playwright", "show-trace", absolute], {
        cwd: runDir,
      });
      return { mode: "show-trace", kind: info.kind };
    }
    shell.showItemInFolder(absolute);
    return { mode: "revealed", kind: info.kind };
  });

  handle("run:files", (_event, runRef, projectDir) => {
    const runDir = runDirFor(String(runRef), projectDir);
    return runs.listRunFiles(runDir);
  });

  handle("run:events", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    return runs.readEventsFrom(runDir, Number(options?.offset ?? 0));
  });

  handle("run:reveal", (_event, runRef, relative, projectDir) => {
    const runDir = runDirFor(String(runRef), projectDir);
    const target = relative ? runs.safeJoin(runDir, String(relative)) : runDir;
    if (!target) throw new Error("invalid artifact path");
    if (!fs.existsSync(target)) throw new Error(`missing: ${target}`);
    shell.showItemInFolder(target);
    return target;
  });

  handle("run:open-report", (_event, runRef, projectDir, mode) => {
    const runDir = runDirFor(String(runRef), projectDir);
    const report = path.join(runDir, "report.html");
    if (!fs.existsSync(report))
      throw new Error("report.html missing for this run");
    if (mode === "external") {
      shell.openPath(report);
      return { mode: "external", report };
    }
    const { openReportWindow } = require("./windows");
    openReportWindow(report, path.basename(runDir));
    return { mode: "window", report };
  });

  handle("run:open-context", (_event, runRef, projectDir) => {
    const runDir = runDirFor(String(runRef), projectDir);
    const context = path.join(runDir, "agent_context.md");
    if (!fs.existsSync(context)) throw new Error("agent_context.md missing");
    return runs.readBoundedText(runDir, "agent_context.md");
  });

  handle("runs:diff", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const { runsRoot } = runsRootFor(context.dir);
    const argv = cli.buildDiffArgv({
      a: diffOperand(options?.a ?? "previous", runsRoot),
      b: diffOperand(options?.b ?? "latest", runsRoot),
      artifactRoot: runsRoot,
      config: context.configPath,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 120_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      payload: result.payload,
      stderr: result.stderr.slice(-4000),
    };
  });

  handle("stats:get", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const { runsRoot } = runsRootFor(context.dir);
    const groupBy = String(options?.groupBy ?? "").trim();
    if (!groupBy) throw new Error("--group-by key required");
    const argv = cli.buildStatsArgv({
      groupBy,
      metric: options?.metric ?? null,
      baseline: options?.baseline ?? null,
      limit: options?.limit ?? 500,
      labels: options?.labels ?? [],
      includeRuns: Boolean(options?.includeRuns),
      artifactRoot: runsRoot,
      config: context.configPath,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 180_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      payload: result.payload,
      stderr: result.stderr.slice(-4000),
    };
  });

  // ── file.cheap stashes (via `cairn stash`) ────────────────────────────────
  /**
   * @param {string[]} argv
   * @param {string} cwd
   * @param {number} [timeoutMs]
   */
  async function stashCall(argv, cwd, timeoutMs = 120_000) {
    const cairn = cairnFor(cwd);
    if (!cairn.command) throw new Error("cairn binary not found");
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd,
      timeoutMs,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      payload: result.payload,
      stderr: result.stderr.slice(-4000),
      cli: stash.cliEquivalent(argv),
    };
  }

  handle("stash:list", (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const tags = (Array.isArray(options?.tags) ? options.tags : [])
      .map((tag) => String(tag ?? "").trim())
      .filter(Boolean);
    const tool =
      options?.tool === null || options?.tool === ""
        ? null
        : String(options?.tool ?? "cairntrace");
    return stashCall(
      stash.buildStashListArgv({ tags, tool }),
      context.dir,
      60_000,
    );
  });

  handle("stash:info", (_event, stashId, projectDir) => {
    const context = projectContext(projectDir);
    return stashCall(
      stash.buildStashInfoArgv(String(stashId)),
      context.dir,
      60_000,
    );
  });

  handle("stash:restore", async (_event, stashId, projectDir) => {
    const context = projectContext(projectDir);
    const id = String(stashId ?? "");
    if (!stash.isSafeStashId(id)) throw new Error("invalid stash id");
    const target = fs.mkdtempSync(
      path.join(os.tmpdir(), "cairn-studio-restore-"),
    );
    const result = await stashCall(
      stash.buildStashRestoreArgv(id, target),
      context.dir,
      300_000,
    );
    const runDir = stash.locateRestoredRun(target);
    if (runDir) restoredRoots.add(target);
    else if (!result.ok)
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        // best effort
      }
    return { ...result, stashId: id, restoredTo: target, runDir };
  });

  handle("stash:receipts", (_event, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    return cached(`receipts:${runsRoot}`, 10_000, () =>
      runs.listStashReceipts(runsRoot),
    );
  });

  // ── evidence actions on one run: publish, pin ─────────────────────────────
  /**
   * The size of a run's events.ndjson (0 when missing): where events
   * appended by a command we are about to spawn will start.
   * @param {string} runDir
   * @returns {number}
   */
  function eventsSize(runDir) {
    try {
      return fs.statSync(path.join(runDir, "events.ndjson")).size;
    } catch {
      return 0;
    }
  }

  /**
   * The last `artifact.publish` event appended since `fromOffset`, reduced
   * to the model's `publish` shape, or null (an older attempt's event never
   * speaks for this one).
   * @param {string} runDir
   * @param {number} fromOffset
   * @returns {Record<string, any> | null}
   */
  function lastPublishEvent(runDir, fromOffset) {
    const event = runs
      .readEventsFrom(runDir, fromOffset, 8 * 1024 * 1024)
      .events.findLast((entry) => entry?.type === "artifact.publish");
    return event ? CairnEvents.reduceEvents([event]).publish : null;
  }

  /**
   * A run inside the artifact root (not a stash restore): pin/unpin target.
   * @param {unknown} runRef
   * @param {string} projectDir
   * @returns {string}
   */
  function artifactRootRun(runRef, projectDir) {
    const runDir = runDirFor(String(runRef ?? ""), projectDir);
    const { runsRoot } = runsRootFor(projectDir);
    if (!runs.isWithin(runDir, [runsRoot]))
      throw new Error(
        "only runs in the artifact root can be pinned (this one is a restored stash)",
      );
    if (!fs.existsSync(path.join(runDir, "run.json")))
      throw new Error("only a finished run (with run.json) can be pinned");
    return runDir;
  }

  /**
   * Spawn `cairn pin|unpin <runDir> --json` and read the pin back.
   * @param {string[]} argv
   * @param {string} runDir
   * @param {string} cwd
   */
  async function pinCall(argv, runDir, cwd) {
    const cairn = cairnFor(cwd);
    if (!cairn.command) throw new Error("cairn binary not found");
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd,
      timeoutMs: 60_000,
    });
    cache.clear();
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      payload: result.payload,
      pinned: evidence.normalizePinned(
        runs.readJsonFile(path.join(runDir, "run.json"))?.pinned,
      ),
      stderr: result.stderr.slice(-2000),
      cli: stash.cliEquivalent(argv),
    };
  }

  handle("run:pin", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const runDir = artifactRootRun(options?.runRef, context.dir);
    const argv = evidence.buildPinArgv(runDir, {
      reason: options?.reason ?? null,
    });
    return pinCall(argv, runDir, context.dir);
  });

  handle("run:unpin", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const runDir = artifactRootRun(options?.runRef, context.dir);
    return pinCall(evidence.buildUnpinArgv(runDir), runDir, context.dir);
  });

  /**
   * Run directories with a publish in flight (from the confirmation to the
   * CLI's answer): a second publish of the same run is refused, so two
   * uploads never race on one publish-receipt.json and events.ndjson.
   * @type {Set<string>}
   */
  const publishing = new Set();

  /**
   * Publish one finished run to file.cheap: a native confirmation (it
   * uploads), then `cairn publish <runDir> --json`, then the receipt and the
   * `artifact.publish` event the CLI wrote back. One at a time per run.
   */
  handle("run:publish", async (_event, runRef, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const runDir = runDirFor(String(runRef ?? ""), context.dir);
    if (!fs.existsSync(path.join(runDir, "run.json")))
      throw new Error("only a finished run (with run.json) can be published");
    if (publishing.has(runDir))
      throw new Error("a publish of this run is already in progress");
    publishing.add(runDir);
    try {
      return await publishOnce(runDir, context, cairn.command);
    } finally {
      publishing.delete(runDir);
    }
  });

  /**
   * @param {string} runDir
   * @param {{ dir: string, config: Record<string, any> }} context
   * @param {string} command
   */
  async function publishOnce(runDir, context, command) {
    const argv = evidence.buildPublishArgv(runDir);
    const days = evidence.publishRetentionDays(context.config.retention);
    const confirmed = await confirmInMain({
      message: "Publish this run to file.cheap?",
      detail: [
        path.basename(runDir),
        "",
        `cairn publish uploads a sanitized, private package of this run to your file.cheap vault. file.cheap keeps it for ${days} day${
          days === 1 ? "" : "s"
        } (retention.publish.retentionDays in the project config; default 7).`,
        "Members the project does not include are left out, and cairn refuses to publish secret-bearing members.",
        "",
        stash.cliEquivalent(argv),
      ].join("\n"),
      confirmLabel: "Publish",
    });
    if (!confirmed) return { published: false, cancelled: true };
    const eventsBefore = eventsSize(runDir);
    const result = await cli.execCairn({
      command,
      argv,
      cwd: context.dir,
      timeoutMs: 300_000,
    });
    const receipt = evidence.readPublishReceipt(runDir);
    const event = lastPublishEvent(runDir, eventsBefore);
    const payload =
      result.payload && typeof result.payload === "object"
        ? /** @type {Record<string, any>} */ (result.payload)
        : null;
    const failed = !result.ok || event?.ok === false;
    return {
      published: !failed && Boolean(receipt),
      cancelled: false,
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      receipt,
      event,
      error: failed
        ? {
            reason:
              (typeof payload?.reason === "string" && payload.reason) ||
              (event?.ok === false ? event.reason : null),
            // `cairn publish --json` says why in `error` (path-free).
            message:
              (typeof payload?.message === "string" && payload.message) ||
              (typeof payload?.error === "string" && payload.error) ||
              (event?.ok === false ? event.message : null),
          }
        : null,
      retentionDays: days,
      stderr: result.ok ? "" : result.stderr.slice(-2000),
      cli: stash.cliEquivalent(argv),
    };
  }

  // The URL comes from the run's own receipt (https only), never from the
  // renderer.
  handle("run:open-published", async (_event, runRef, projectDir) => {
    const runDir = runDirFor(String(runRef ?? ""), projectDir);
    const receipt = evidence.readPublishReceipt(runDir);
    if (!receipt) throw new Error("this run has no publish-receipt.json");
    if (!receipt.webUrl)
      throw new Error("the publish receipt has no https web URL");
    await shell.openExternal(receipt.webUrl);
    return { opened: true, url: receipt.webUrl };
  });

  // ── authoring: session journals, drafts, catalog ─────────────────────────
  /**
   * The journal directory a renderer names: a session id, or the exact
   * `<artifactRoot>/_sessions/<id>` folder of the root the CLI writes
   * journals to (`sessionsRootFor`). Anything else (a run folder, a path
   * beside or below a journal) is refused.
   * @param {unknown} ref
   * @param {string | null | undefined} projectDir
   * @returns {string}
   */
  function sessionDirFor(ref, projectDir) {
    const runsRoot = sessionsRootFor(projectDir);
    const dir = authoring.resolveSessionRef(runsRoot, ref);
    if (!dir)
      throw new Error(
        `invalid session: ${String(ref ?? "")} (a journal under ${path.join(
          runsRoot,
          authoring.SESSIONS_DIR,
        )})`,
      );
    return dir;
  }

  handle("sessions:list", (_event, options, projectDir) => {
    const runsRoot = sessionsRootFor(projectDir);
    const limit = Math.max(1, Math.min(Number(options?.limit) || 50, 200));
    return {
      runsRoot,
      sessionsDir: path.join(runsRoot, authoring.SESSIONS_DIR),
      sessions: authoring.listSessions(runsRoot, { limit }),
    };
  });

  handle("session:get", (_event, options, projectDir) => {
    return authoring.readSessionDir(
      sessionDirFor(options?.sessionId, projectDir),
    );
  });

  handle("session:events", (_event, options, projectDir) =>
    runs.readEventsFrom(
      sessionDirFor(options?.sessionId, projectDir),
      Number(options?.offset ?? 0),
    ),
  );

  // A journal's own text files (snapshots, network logs, the draft), bounded.
  handle("session:text", (_event, options, projectDir) => {
    const dir = sessionDirFor(options?.sessionId, projectDir);
    const rel = authoring.journalFile(dir, options?.path, "text");
    if (!rel)
      throw new Error(
        `not a journal text file: ${String(options?.path ?? "")}`,
      );
    return runs.readBoundedText(
      dir,
      rel,
      Math.min(Number(options?.maxBytes) || 1024 * 1024, 4 * 1024 * 1024),
    );
  });

  // A screenshot of the journal: a cairn-artifact:// token when media
  // streaming is up (no base64 copies of every PNG), else a data URL.
  handle("session:image", (_event, options, projectDir) => {
    const dir = sessionDirFor(options?.sessionId, projectDir);
    const rel = authoring.journalFile(dir, options?.path, "image");
    if (!rel)
      throw new Error(`not a journal image: ${String(options?.path ?? "")}`);
    if (!ctx.media) return runs.readAsDataUrl(dir, rel);
    const absolute = /** @type {string} */ (runs.safeJoin(dir, rel));
    let bytes = 0;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) throw new Error("not a file");
      bytes = stat.size;
    } catch {
      return { ok: false, url: null, bytes: 0, error: `missing: ${rel}` };
    }
    return { ok: true, url: ctx.media.register(absolute), bytes };
  });

  /** Journals with an export in flight (one at a time per session). */
  const exportingSessions = new Set();

  /**
   * Re-export a journal: `cairn discover export --from-session=<dir>
   * --intent=… --outcomes=<file> [--path=<its last export>] --json`. Studio
   * never invents a contract: it passes the intent and outcomes session.json
   * kept from the session's last export explicitly (what the dialog shows is
   * what is written), so the first export stays the agent's
   * (`cairn_discover_export`). A re-export
   * that rewrites an existing file asks natively first. Nothing is uploaded.
   */
  handle("session:export", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const dir = sessionDirFor(options?.sessionId, context.dir);
    const session = authoring.readSessionDir(dir);
    if (!session) throw new Error("this journal has no readable session.json");
    if (session.kind !== "discovery")
      throw new Error(
        `only a discovery session exports as a spec (this one is ${session.kind})`,
      );
    const contract = authoring.sessionContract(dir);
    if (!contract)
      throw new Error(
        "this session has not been exported yet: the first export names the intent and outcomes, so it comes from the agent (cairn_discover_export, or cairn discover export --from-session … --intent … --outcomes …). Studio re-exports with that contract afterwards.",
      );
    if (exportingSessions.has(dir))
      throw new Error("an export of this session is already running");
    exportingSessions.add(dir);
    /** @type {string | null} */
    let scratch = null;
    try {
      // The last export inside the project is the file a re-export rewrites;
      // without one the CLI picks the config's drafts dir.
      const target =
        [...session.exportedTo]
          .toReversed()
          .find(
            (/** @type {string} */ entry) =>
              path.isAbsolute(entry) &&
              /\.ya?ml$/i.test(entry) &&
              runs.isWithin(entry, [context.dir]),
          ) ?? null;
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-studio-export-"));
      const outcomesFile = path.join(scratch, "outcomes.json");
      fs.writeFileSync(outcomesFile, JSON.stringify(contract.outcomes), {
        mode: 0o600,
      });
      const argv = authoring.buildSessionExportArgv({
        sessionDir: dir,
        intent: contract.intent,
        outcomesFile,
        path: target,
        config: context.configPath,
      });
      if (target && fs.existsSync(target)) {
        const confirmed = await confirmInMain(
          authoring.exportDialog({
            target,
            projectDir: context.dir,
            contract,
            cli: stash.cliEquivalent(argv),
          }),
        );
        if (!confirmed) return { cancelled: true, ok: false, target };
      }
      const result = await cli.execCairn({
        command: cairn.command,
        argv,
        cwd: context.dir,
        timeoutMs: 120_000,
      });
      return {
        cancelled: false,
        ok: result.ok,
        exitCode: result.exitCode,
        meaning: cli.describeExitCode(result.exitCode),
        payload: result.payload,
        target,
        error: result.ok ? null : authoring.refusalText(result.stderr),
        unsupported: authoring.looksUnsupported(result),
        stderr: result.ok ? "" : result.stderr.slice(-4000),
        cli: stash.cliEquivalent(argv),
      };
    } finally {
      exportingSessions.delete(dir);
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  /** Drafts with a promote in flight (one at a time per draft). */
  const promoting = new Set();

  /**
   * `cairn spec promote <draft> [--force] --json`: moves a draft out of the
   * drafts folder and stamps its contract hash. Only a YAML draft inside the
   * project (the CLI's draft rule); the native dialog shows the intent and
   * every outcome with its verify parameters, because a contract is never
   * changed without showing it. What the dialog showed is pinned by its
   * sha256: a draft rewritten while the dialog was open is refused, never
   * promoted unseen.
   */
  handle("spec:promote", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    let session = null;
    if (options?.sessionId !== undefined && options?.sessionId !== null) {
      session = authoring.readSessionDir(
        sessionDirFor(options.sessionId, context.dir),
      );
    }
    const draft = authoring.resolveDraftPath(options?.draft, {
      projectDir: context.dir,
      session,
    });
    if (!draft)
      throw new Error(
        `only an existing .yml/.yaml draft inside the project can be promoted: ${String(
          options?.draft ?? "",
        )}`,
      );
    if (
      !authoring.isPromotableDraft(draft, {
        projectDir: context.dir,
        configPath: context.configPath,
        config: context.config,
      })
    )
      throw new Error(
        `${path.relative(context.dir, draft) || draft} is not a draft inside the project: drafts live in the config's authoring.draftsDir (default flows/_drafts) or under a file/folder starting with _`,
      );
    const force = options?.force === true;
    const shownText = authoring.readDraftText(draft);
    const shownHash = authoring.contentHash(shownText);
    const contract = authoring.draftContract(shownText);
    // The CLI re-checks the hash on its own read, closing the window
    // between Studio's re-read below and the promote itself.
    const argv = authoring.buildPromoteArgv(draft, {
      force,
      expectContentHash: shownHash,
    });
    if (promoting.has(draft))
      throw new Error("a promote of this draft is already in progress");
    promoting.add(draft);
    try {
      const confirmed = await confirmInMain({
        message: force
          ? "Promote this draft without a green spec finish?"
          : "Promote this draft and stamp its contract?",
        detail: authoring.promoteDialogText({
          draft,
          projectDir: context.dir,
          contract,
          force,
          cli: stash.cliEquivalent(argv),
        }),
        confirmLabel: force ? "Promote anyway" : "Promote",
      });
      if (!confirmed) return { promoted: false, cancelled: true, draft };
      // The agent may still be editing: promote only the text shown.
      let nowHash = null;
      try {
        nowHash = authoring.contentHash(authoring.readDraftText(draft));
      } catch {
        nowHash = null;
      }
      if (nowHash !== shownHash)
        return {
          promoted: false,
          cancelled: false,
          changed: true,
          draft,
          to: null,
          ok: false,
          exitCode: null,
          meaning: "not run",
          payload: null,
          error:
            nowHash === null
              ? "the draft moved or became unreadable while you reviewed it; nothing was promoted"
              : "the draft changed while you reviewed it; nothing was promoted. Promote again to review the new content.",
          forceable: false,
          unsupported: false,
          stderr: "",
          cli: stash.cliEquivalent(argv),
        };
      const result = await cli.execCairn({
        command: cairn.command,
        argv,
        cwd: context.dir,
        timeoutMs: 120_000,
      });
      cache.clear();
      const payload =
        result.payload && typeof result.payload === "object"
          ? /** @type {Record<string, any>} */ (result.payload)
          : null;
      const to =
        typeof payload?.to === "string" && payload.to
          ? path.resolve(context.dir, payload.to)
          : null;
      return {
        promoted: result.ok,
        cancelled: false,
        changed: false,
        draft,
        to,
        ok: result.ok,
        exitCode: result.exitCode,
        meaning: cli.describeExitCode(result.exitCode),
        payload,
        warnings: Array.isArray(payload?.warnings)
          ? payload.warnings.filter(
              (/** @type {unknown} */ entry) => typeof entry === "string",
            )
          : [],
        error: result.ok
          ? null
          : (typeof payload?.error === "string" && payload.error) ||
            (typeof payload?.message === "string" && payload.message) ||
            authoring.refusalText(result.stderr),
        // only the green-finish gate yields to --force
        forceable: !force && authoring.promoteForceable(result),
        unsupported: authoring.looksUnsupported(result),
        stderr: result.ok ? "" : result.stderr.slice(-4000),
        cli: stash.cliEquivalent(argv),
      };
    } finally {
      promoting.delete(draft);
    }
  });

  // What the project already has: `cairn catalog --json`, for authors.
  handle("catalog:get", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const settings = getSettings();
    const argv = authoring.buildCatalogArgv({
      query: options?.query ?? "",
      env: options?.env ?? null,
      limit: options?.limit ?? null,
      config: context.configPath,
      // Like run:start: only Studio's own override is passed on.
      artifactRoot: settings.artifactRoot
        ? runsRootFor(context.dir).runsRoot
        : null,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 90_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      meaning: cli.describeExitCode(result.exitCode),
      payload: result.payload,
      unsupported: authoring.looksUnsupported(result),
      stderr: result.ok ? "" : result.stderr.slice(-4000),
      cli: stash.cliEquivalent(argv),
    };
  });

  handle("docs:get", async (_event, topic, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const key = `docs:${topic ?? "overview"}:${cairn.command}`;
    return cached(key, 5 * 60_000, async () => {
      const argv = ["docs", String(topic ?? "overview"), "--format", "json"];
      const result = await cli.execCairn({
        command: cairn.command,
        argv,
        cwd: context.dir,
        timeoutMs: 60_000,
      });
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        payload: result.payload,
        stdout: result.stdout.slice(0, 400_000),
        stderr: result.stderr.slice(-4000),
      };
    });
  });

  handle("explain:get", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    return cached(`explain:${cairn.command}`, 5 * 60_000, async () => {
      const result = await cli.execCairn({
        command: cairn.command,
        argv: ["explain", "--format", "json"],
        cwd: context.dir,
        timeoutMs: 60_000,
      });
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        payload: result.payload,
        stderr: result.stderr.slice(-4000),
      };
    });
  });

  handle("services:status", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const argv = ["services", "status", "--format", "json"];
    if (context.configPath) argv.push("--config", context.configPath);
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      payload: result.payload,
      stdout: result.stdout.slice(0, 200_000),
      stderr: result.stderr.slice(-4000),
    };
  });

  // ── services lifecycle per environment (`cairn services up|down`) ────────
  /** `<projectDir>\0<env>` → the services command running for it. */
  /** @type {Map<string, "up" | "down" | "restart">} */
  const servicesBusy = new Map();
  /** In-flight `services up|down` children, cancelled on quit. */
  /** @type {Set<AbortController>} */
  const servicesControllers = new Set();

  /**
   * `cairn services status --env=<env> --json` for one environment.
   * @param {{ dir: string, configPath: string | null }} context
   * @param {string} command
   * @param {string} env
   * @param {number} timeoutMs
   */
  async function servicesStatusFor(context, command, env, timeoutMs) {
    const argv = authoring.buildServicesArgv("status", {
      env,
      config: context.configPath,
    });
    const result = await cli.execCairn({
      command,
      argv,
      cwd: context.dir,
      timeoutMs,
    });
    const payload =
      result.payload && typeof result.payload === "object"
        ? /** @type {Record<string, any>} */ (result.payload)
        : null;
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      payload,
      lock: payload?.lock ?? null,
      stderr: result.ok ? "" : result.stderr.slice(-2000),
      cli: stash.cliEquivalent(argv),
    };
  }

  // The `services up` owner lock of one environment (owner, age, staleness).
  handle("services:lock", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const env = authoring.checkEnvName(options?.env);
    const status = await servicesStatusFor(context, cairn.command, env, 60_000);
    return {
      env,
      ...status,
      hasServices:
        typeof status.payload?.hasServices === "boolean"
          ? status.payload.hasServices
          : null,
      busy: servicesBusy.get(`${context.dir}\0${env}`) ?? null,
    };
  });

  /**
   * Start or tear down one environment's services: refused while a suite
   * lock is held (like a run) or a run Studio started uses that environment,
   * one command per environment at a time, and only after a native
   * confirmation that names the current lock owner. Both gates are checked
   * again after the dialog: a suite can take its lock, and a run can start
   * in another window, while it is open.
   * @param {"up" | "down"} action
   * @param {any} options
   * @param {string | null | undefined} projectDir
   */
  async function servicesAction(action, options, projectDir) {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const env = authoring.checkEnvName(options?.env);
    assertUnlocked(
      context.dir,
      action === "up" ? "Services up" : "Services down",
    );
    assertNoStudioRunsOn(context.dir, env, action);
    const key = `${context.dir}\0${env}`;
    const running = servicesBusy.get(key);
    if (running)
      throw new Error(
        `cairn services ${running} is already running for ${env}`,
      );
    servicesBusy.set(key, action);
    try {
      const argv = authoring.buildServicesArgv(action, {
        env,
        config: context.configPath,
      });
      const before = await servicesStatusFor(
        context,
        cairn.command,
        env,
        30_000,
      ).catch(() => null);
      const policy =
        context.config.environments.find((entry) => entry.name === env)
          ?.policy ?? null;
      const prompt = authoring.servicesDialog({
        action,
        env,
        lock: before?.lock ?? null,
        policy,
        cli: stash.cliEquivalent(argv),
      });
      if (!(await confirmInMain(prompt)))
        return { cancelled: true, action, env };
      assertUnlocked(
        context.dir,
        action === "up" ? "Services up" : "Services down",
      );
      assertNoStudioRunsOn(context.dir, env, action);
      const controller = new AbortController();
      servicesControllers.add(controller);
      let result;
      try {
        result = await cli.execCairn({
          command: cairn.command,
          argv,
          cwd: context.dir,
          // a cold docker + seed boot can take many minutes
          timeoutMs: 0,
          signal: controller.signal,
        });
      } finally {
        servicesControllers.delete(controller);
      }
      const payload =
        result.payload && typeof result.payload === "object"
          ? /** @type {Record<string, any>} */ (result.payload)
          : null;
      return {
        cancelled: false,
        action,
        env,
        ok: result.ok,
        exitCode: result.exitCode,
        meaning: cli.describeExitCode(result.exitCode),
        payload,
        error: result.ok
          ? null
          : (typeof payload?.error === "string" && payload.error) ||
            result.stderr.trim().split("\n").slice(-3).join("\n") ||
            null,
        unsupported: authoring.looksUnsupported(result),
        stderr: result.ok ? "" : result.stderr.slice(-4000),
        cli: stash.cliEquivalent(argv),
      };
    } finally {
      servicesBusy.delete(key);
    }
  }

  handle("services:up", (_event, options, projectDir) =>
    servicesAction("up", options, projectDir),
  );
  handle("services:down", (_event, options, projectDir) =>
    servicesAction("down", options, projectDir),
  );

  // ── wave 6: suites, config vars, orphans, service windows, metrics ───────
  /**
   * The failure line of a command that gave no usable document: the CLI's
   * own message (stderr from the start), else the payload's `error`.
   * @param {{ ok?: boolean, stderr?: string, exitCode?: number | null }} result
   * @param {unknown} payload
   * @returns {string | null}
   */
  function failureText(result, payload) {
    if (result.ok) return null;
    const fromPayload = /** @type {any} */ (payload)?.error;
    return (
      authoring.refusalText(result.stderr) ??
      (typeof fromPayload === "string" && fromPayload ? fromPayload : null)
    );
  }

  // `cairn suites list [--env] --json`: each suite with the specs it
  // resolves to per environment (or why it does not).
  handle("suites:list", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const argv = ops.buildSuitesArgv({
      env: options?.env ?? null,
      config: context.configPath,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    const suites = ops.normalizeSuites(result.payload);
    return {
      ok: result.ok && Boolean(suites),
      exitCode: result.exitCode,
      suites,
      unsupported: authoring.looksUnsupported(result),
      error: suites ? null : failureText(result, result.payload),
      stderr: result.ok ? "" : result.stderr.slice(-2000),
      cli: stash.cliEquivalent(argv),
    };
  });

  // `cairn config vars [--env] [--unused] --json`: values arrive masked and
  // stay masked (lib/ops.js normalizeConfigVars masks again by name).
  handle("config:vars", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const argv = ops.buildConfigVarsArgv({
      env: options?.env ?? null,
      unused: Boolean(options?.unused),
      config: context.configPath,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    const vars = ops.normalizeConfigVars(result.payload);
    return {
      ok: result.ok && Boolean(vars?.ok),
      exitCode: result.exitCode,
      vars,
      unsupported: authoring.looksUnsupported(result),
      error: vars ? null : failureText(result, result.payload),
      stderr: result.ok ? "" : result.stderr.slice(-2000),
      cli: stash.cliEquivalent(argv),
    };
  });

  // `cairn doctor --orphans --json`: exit 1 means "orphans listed", not a
  // failure; only a missing document is.
  /** @param {{ dir: string }} context @param {string} command */
  async function listOrphans(context, command) {
    const argv = ops.buildOrphansArgv();
    const result = await cli.execCairn({
      command,
      argv,
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    const orphans = ops.normalizeOrphans(result.payload);
    return {
      result,
      argv,
      orphans,
      view: {
        ok:
          Boolean(orphans) && (result.exitCode === 0 || result.exitCode === 1),
        exitCode: result.exitCode,
        orphans,
        unsupported: authoring.looksUnsupported(result),
        error: orphans ? null : failureText(result, result.payload),
        stderr:
          result.exitCode === 0 || result.exitCode === 1
            ? ""
            : result.stderr.slice(-2000),
        cli: stash.cliEquivalent(argv),
      },
    };
  }

  handle("orphans:list", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    return (await listOrphans(context, cairn.command)).view;
  });

  let orphansBusy = false;
  // Ending processes: list first, show exactly what the CLI listed in a
  // native dialog the renderer cannot answer, then `--kill --yes`.
  handle("orphans:kill", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    if (orphansBusy)
      throw new Error("cairn doctor --orphans --kill is already running");
    orphansBusy = true;
    try {
      const listed = await listOrphans(context, cairn.command);
      if (!listed.orphans) return { cancelled: false, ...listed.view };
      if (!listed.orphans.orphans.length)
        return { cancelled: false, nothing: true, ...listed.view };
      // Exactly the sessions and pids the dialog shows: whatever changed
      // between this listing and the kill is left alone (no TOCTOU).
      const argv = ops.buildOrphansArgv({
        kill: true,
        only: ops.confirmedOrphanSet(listed.orphans),
      });
      const confirmed = await confirmInMain(
        ops.orphansDialog({
          orphans: listed.orphans.orphans,
          cli: stash.cliEquivalent(argv),
        }),
      );
      if (!confirmed) return { cancelled: true, ...listed.view };
      const result = await cli.execCairn({
        command: cairn.command,
        argv,
        cwd: context.dir,
        timeoutMs: 120_000,
      });
      const orphans = ops.normalizeOrphans(result.payload);
      return {
        cancelled: false,
        killed: true,
        ok:
          Boolean(orphans) && (result.exitCode === 0 || result.exitCode === 1),
        exitCode: result.exitCode,
        orphans,
        error: orphans ? null : failureText(result, result.payload),
        stderr:
          result.exitCode === 0 || result.exitCode === 1
            ? ""
            : result.stderr.slice(-2000),
        cli: stash.cliEquivalent(argv),
      };
    } finally {
      orphansBusy = false;
    }
  });

  /**
   * One environment's services status, normalised (windows, tunnels,
   * provisioner export names). The windows are what `services:restart`
   * allows.
   * @param {string | null | undefined} projectDir
   * @param {unknown} envName
   */
  async function servicesWindows(projectDir, envName) {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const env = authoring.checkEnvName(envName);
    const status = await servicesStatusFor(context, cairn.command, env, 60_000);
    return {
      context,
      cairn,
      env,
      status,
      view: ops.normalizeServicesStatus(status.payload),
    };
  }

  // Tunnels, provisioner and window health of one environment.
  handle("services:windows", async (_event, options, projectDir) => {
    const { env, status, view } = await servicesWindows(
      projectDir,
      options?.env,
    );
    return {
      env,
      ok: status.ok && Boolean(view),
      exitCode: status.exitCode,
      status: view,
      lock: status.lock,
      busy:
        servicesBusy.get(`${projectContext(projectDir).dir}\0${env}`) ?? null,
      error: view ? null : status.stderr || null,
      cli: status.cli,
    };
  });

  // `cairn services restart <window>`: the window must be one the CLI's own
  // status lists for the environment; refused while a suite or run lock is
  // held or a run Studio started uses that environment; asks natively.
  handle("services:restart", async (_event, options, projectDir) => {
    const { context, cairn, env, status, view } = await servicesWindows(
      projectDir,
      options?.env,
    );
    const window = ops.checkWindowName(options?.window);
    assertUnlocked(context.dir, "Service restart");
    assertNoStudioRunsOn(context.dir, env, "restart");
    if (!view)
      throw new Error(
        `cannot read the services status of ${env}: ${status.stderr || "cairn services status gave no document"}`,
      );
    if (
      !view.hasServices ||
      !view.tmux.windows.some((entry) => entry.name === window)
    )
      throw new Error(
        `"${window}" is not a service window of ${env}${
          view.tmux.windows.length
            ? ` (windows: ${view.tmux.windows.map((entry) => entry.name).join(", ")})`
            : ""
        }`,
      );
    const key = `${context.dir}\0${env}`;
    const running = servicesBusy.get(key);
    if (running)
      throw new Error(
        `cairn services ${running} is already running for ${env}`,
      );
    servicesBusy.set(key, "restart");
    try {
      const argv = ops.buildServicesRestartArgv({
        window,
        env,
        config: context.configPath,
      });
      const policy =
        context.config.environments.find((entry) => entry.name === env)
          ?.policy ?? null;
      const confirmed = await confirmInMain(
        ops.restartDialog({
          window,
          env,
          lock: status.lock ?? null,
          policy,
          cli: stash.cliEquivalent(argv),
        }),
      );
      if (!confirmed) return { cancelled: true, window, env };
      // both gates again: a suite can take its lock, and a run can start in
      // another window, while the dialog is open
      assertUnlocked(context.dir, "Service restart");
      assertNoStudioRunsOn(context.dir, env, "restart");
      const controller = new AbortController();
      servicesControllers.add(controller);
      let result;
      try {
        result = await cli.execCairn({
          command: cairn.command,
          argv,
          cwd: context.dir,
          // a restart waits for the old process and the new readyOn
          timeoutMs: 600_000,
          signal: controller.signal,
        });
      } finally {
        servicesControllers.delete(controller);
      }
      const restart = ops.normalizeRestart(result.payload);
      return {
        cancelled: false,
        window,
        env,
        ok: result.ok && Boolean(restart?.ok),
        exitCode: result.exitCode,
        meaning: cli.describeExitCode(result.exitCode),
        restart,
        error: restart?.ok
          ? null
          : (restart?.error ?? failureText(result, result.payload)),
        unsupported: authoring.looksUnsupported(result),
        stderr: result.ok ? "" : result.stderr.slice(-4000),
        cli: stash.cliEquivalent(argv),
      };
    } finally {
      servicesBusy.delete(key);
    }
  });

  // `cairn services logs <window>`: a bounded, read-only tail (redacted by
  // the CLI, masked again here).
  handle("services:logs", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const argv = ops.buildServicesLogsArgv({
      window: options?.window,
      env: options?.env,
      config: context.configPath,
      sinceRestart: Boolean(options?.sinceRestart),
      lines: options?.lines,
    });
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    const logs = ops.normalizeLogs(result.payload);
    return {
      ok: result.ok && Boolean(logs?.ok),
      exitCode: result.exitCode,
      logs,
      unsupported: authoring.looksUnsupported(result),
      error: logs?.ok
        ? null
        : (logs?.error ?? failureText(result, result.payload)),
      stderr: result.ok ? "" : result.stderr.slice(-2000),
      cli: stash.cliEquivalent(argv),
    };
  });

  // A metric across runs (a sparkline): from each run's
  // diagnostics/metrics.json in the artifact root, optionally one spec.
  handle("metrics:history", (_event, options, projectDir) => {
    const { runsRoot } = runsRootFor(projectDir);
    const spec =
      typeof options?.spec === "string" && options.spec.length <= 200
        ? options.spec
        : null;
    return metricsLib.metricsHistory(runsRoot, {
      spec,
      limit: Number.isInteger(options?.limit)
        ? Math.min(100, Math.max(2, options.limit))
        : undefined,
    });
  });

  handle("checkpoints:list", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const result = await cli.execCairn({
      command: cairn.command,
      argv: ["checkpoint", "list", "--format", "json"],
      cwd: context.dir,
      timeoutMs: 60_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      payload: result.payload,
      stdout: result.stdout.slice(0, 200_000),
      stderr: result.stderr.slice(-4000),
    };
  });

  handle("clean:runs", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const { runsRoot } = runsRootFor(context.dir);
    const argv = cli.buildCleanArgv({
      artifactRoot: runsRoot,
      all: Boolean(options?.all),
      keepRuns: options?.keepRuns ?? null,
    });
    // With retention.archiveToStash / retention.publish.enabled, cairn clean
    // uploads every run it prunes: ask natively, like run:publish does.
    const uploads = evidence.retentionUploads(context.config.retention);
    if (uploads.any) {
      const confirmed = await confirmInMain({
        message: options?.all
          ? "Delete every run and upload each one first?"
          : "Prune old runs and upload each one first?",
        detail: [
          evidence.retentionUploadText(uploads),
          "",
          "Pinned runs are kept and not uploaded.",
          "",
          stash.cliEquivalent(argv),
        ].join("\n"),
        confirmLabel: uploads.publish
          ? "Prune and publish"
          : "Prune and archive",
      });
      if (!confirmed)
        return { ok: false, cancelled: true, exitCode: null, stderr: "" };
    }
    const result = await cli.execCairn({
      command: cairn.command,
      argv,
      cwd: context.dir,
      timeoutMs: 120_000,
    });
    return {
      ok: result.ok,
      exitCode: result.exitCode,
      payload: result.payload,
      stdout: result.stdout.slice(0, 100_000),
      stderr: result.stderr.slice(-4000),
    };
  });

  // ── shell + dialogs ───────────────────────────────────────────────────────
  handle("shell:open-external", (_event, url) => {
    const target = String(url ?? "");
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(`refusing to open ${parsed.protocol} URL`);
    return shell.openExternal(target);
  });

  handle("dialog:open-directory", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose a directory",
      properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths[0]) return null;
    // Chosen by the user in a native dialog: no second confirmation needed.
    pickedDirs.add(path.resolve(filePaths[0]));
    return filePaths[0];
  });

  handle("dialog:open-spec", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose a spec YAML",
      defaultPath: context.dir,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Cairntrace specs", extensions: ["yml", "yaml"] }],
    });
    if (canceled) return [];
    allowFiles(filePaths);
    return filePaths;
  });

  handle("dialog:save-spec", async (_event, projectDir, suggested) => {
    const context = projectContext(projectDir);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Save spec as",
      defaultPath: path.join(context.dir, String(suggested ?? "spec.yml")),
      filters: [{ name: "Cairntrace spec", extensions: ["yml"] }],
    });
    return canceled || !filePath ? null : filePath;
  });

  /**
   * Paths `fs:*` may touch: the read roots, the project config (found by
   * walking up, so possibly above the project), and explicitly picked files.
   * @param {unknown} target
   * @returns {string | null}
   */
  function allowedFsPath(target) {
    const resolved = path.resolve(String(target ?? ""));
    if (!target) return null;
    if (allowedFiles.has(resolved)) return resolved;
    const context = projectContext(null);
    if (context.configPath && resolved === path.resolve(context.configPath))
      return resolved;
    return runs.isWithin(resolved, readRoots(null)) ? resolved : null;
  }

  handle("fs:exists", (_event, target) => {
    const resolved = allowedFsPath(target);
    return resolved ? fs.existsSync(resolved) : false;
  });

  handle("fs:reveal", (_event, target) => {
    const resolved = allowedFsPath(target);
    if (!resolved)
      throw new Error("refusing to reveal a path outside the project");
    if (!fs.existsSync(resolved))
      throw new Error(`nothing to reveal at ${resolved}`);
    shell.showItemInFolder(resolved);
    return resolved;
  });

  handle("app:quit", () => {
    shutdown();
    app.quit();
    return true;
  });

  // ── external-run watcher ─────────────────────────────────────────────────
  // Polls the artifact root for runs started outside the app (terminal,
  // agents) and streams their events.ndjson into the renderer, plus the
  // invocation journals that group them. main.js starts it once the window
  // has finished loading: the renderer registers its push subscriptions
  // during script evaluation, so that ordering guarantees no event is
  // consumed before anyone can receive it.
  const watchRoot = () => {
    try {
      return cached("watch:runsRoot", 10_000, () => runsRootFor(null).runsRoot);
    } catch {
      return null;
    }
  };
  const runWatcher = createRunWatcher({
    runsRoot: watchRoot,
    pollMs: 2000,
    excludes: appTrackedRunIds,
    onSnapshot: (list) => ctx.send("runs:detected", { runs: list }),
    onEvents: (runId, events) =>
      ctx.send("run:external-events", { runId, events }),
    onFinished: (runId, info) =>
      ctx.send("run:external-finished", { runId, ...info }),
    onInvocations: (list) => {
      const root = watchRoot();
      ctx.send("runs:invocations", {
        invocations: root ? withEta(list, root) : list,
      });
    },
    onInvocationEvents: (invocationId, events) =>
      ctx.send("invocation:stream", { invocationId, events }),
  });

  /** Cancel every spawned cairn process before the app disappears. */
  function shutdown() {
    runWatcher.stop();
    for (const [token, entry] of activeRuns.entries()) {
      entry.tail?.stop();
      try {
        // A delegated run gets SIGINT and finishes its cancel on its own
        // (cairn runs in its own process group and outlives the app).
        const policy = delegatedCancelPolicy(entry);
        if (policy) cancelPolicies.set(token, policy);
        entry.controller.abort();
      } catch {
        // already dead
      }
    }
    activeRuns.clear();
    for (const tail of lingeringTails) tail.stop();
    lingeringTails.clear();
    for (const controller of servicesControllers) controller.abort();
    servicesControllers.clear();
  }
  app.on("before-quit", shutdown);
  return { shutdown, activeRuns, runWatcher, allowFiles };
}

module.exports = { registerIpc, nextToken };
