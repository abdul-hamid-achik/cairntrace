/**
 * IPC surface for Cairntrace Studio.
 *
 * Everything the renderer can ask for is declared here, and every handler is a
 * thin wrapper over `lib/*` plus a spawned `cairn` process. The renderer is
 * sandboxed with context isolation, so this file is the whole trust boundary:
 * paths are validated before they touch the filesystem, external opens are
 * limited to http(s), and no handler exposes a shell.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, dialog, ipcMain, shell } = require("electron");

const cli = require("./lib/cli");
const live = require("./lib/live");
const runs = require("./lib/runs");
const settingsStore = require("./lib/settings");
const specs = require("./lib/specs");
const { createRunWatcher } = require("./lib/watcher");

/**
 * @typedef {object} IpcContext
 * @property {string} settingsFile
 * @property {string} repoRoot
 * @property {() => import("electron").BrowserWindow | null} getWindow
 * @property {(channel: string, payload: unknown) => void} send
 */

let tokenCounter = 0;

/** @returns {string} */
function nextToken() {
  tokenCounter += 1;
  return `run_${Date.now().toString(36)}_${tokenCounter}`;
}

/**
 * @param {IpcContext} ctx
 */
function registerIpc(ctx) {
  /** @type {Map<string, { controller: AbortController, tail: { stop: () => void, runDir?: () => string | null } | null, specs: string[], startedAt: number, argv: string[], command: string }>} */
  const activeRuns = new Map();
  /** @type {Map<string, { at: number, value: unknown }>} */
  const cache = new Map();

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

  /**
   * @param {string | null | undefined} projectDir
   * @returns {{ dir: string, configPath: string | null, config: ReturnType<typeof specs.readProjectConfig> }}
   */
  function projectContext(projectDir) {
    const settings = getSettings();
    const dir = path.resolve(
      projectDir ||
        settings.activeProject ||
        ctx.repoRoot ||
        app.getPath("home"),
    );
    const info = specs.inspectProjectDir(dir);
    const config = specs.readProjectConfig(info.configPath);
    return { dir, configPath: info.configPath, config };
  }

  /**
   * @param {string | null | undefined} projectDir
   */
  function runsRootFor(projectDir) {
    const settings = getSettings();
    const { config } = projectContext(projectDir);
    return specs.resolveRunsRoot({
      configured: settings.artifactRoot,
      configArtifactRoot: config.artifactRoot,
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
      repoRoot: fs.existsSync(path.join(ctx.repoRoot, "bin", "cairn"))
        ? ctx.repoRoot
        : null,
      env: cli.augmentedEnv(),
    });
    return { ...resolved, cwd: dir };
  }

  /**
   * Reject paths that are not inside an allowed root.
   * @param {string} target
   * @param {string[]} roots
   * @returns {string}
   */
  function assertWithin(target, roots) {
    const resolved = path.resolve(target);
    const allowed = roots
      .filter(Boolean)
      .map((root) => path.resolve(root))
      .some(
        (root) => resolved === root || resolved.startsWith(root + path.sep),
      );
    if (!allowed) throw new Error(`path outside project: ${resolved}`);
    return resolved;
  }

  /**
   * @param {string} runRef
   * @param {string | null | undefined} projectDir
   * @returns {string} absolute run directory
   */
  function runDirFor(runRef, projectDir) {
    const { runsRoot } = runsRootFor(projectDir);
    const resolved = runs.resolveRunRef(runsRoot, runRef);
    if (!resolved) throw new Error(`unknown run: ${runRef}`);
    return resolved;
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

  handle("settings:get", () => getSettings());

  handle("settings:update", (_event, patch) => {
    if (!patch || typeof patch !== "object") throw new Error("patch required");
    cache.clear();
    return writeSettings(patch);
  });

  handle("settings:reset", () => {
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

  handle("cairn:version", async (_event, projectDir) => {
    const cairn = cairnFor(projectDir);
    if (!cairn.command)
      return { version: null, error: "cairn binary not found" };
    const result = await cli.execCairn({
      command: cairn.command,
      argv: ["--version"],
      cwd: cairn.cwd,
      timeoutMs: 20_000,
    });
    return {
      version: String(result.stdout ?? result.stderr ?? "").trim() || null,
      exitCode: result.exitCode,
    };
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
    return dir;
  });

  handle("projects:open-recent", (_event, dir) => {
    if (!fs.existsSync(String(dir)))
      throw new Error(`missing directory: ${dir}`);
    writeSettings(settingsStore.withRecentProject(getSettings(), String(dir)));
    cache.clear();
    return String(dir);
  });

  handle("projects:forget", (_event, dir) => {
    writeSettings(settingsStore.withoutProject(getSettings(), String(dir)));
    cache.clear();
    return getSettings().projects;
  });

  handle("project:inspect", (_event, projectDir) => {
    const context = projectContext(projectDir);
    const info = specs.inspectProjectDir(context.dir);
    const runsRoot = runsRootFor(context.dir);
    const specFiles = specs.findSpecFiles(context.dir);
    return {
      ...info,
      config: context.config,
      runsRoot,
      specs: specFiles.map((file) => ({
        ...file,
        summary: summarizeFile(file.path),
      })),
      specNames: runs.listRunSpecs(runsRoot.runsRoot),
    };
  });

  /**
   * @param {string} file
   */
  function summarizeFile(file) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      return { parseError: String(error?.message ?? error) };
    }
    return specs.summarizeSpecText(text, file);
  }

  // ── specs ─────────────────────────────────────────────────────────────────
  handle("specs:list", (_event, projectDir) => {
    const context = projectContext(projectDir);
    return specs
      .findSpecFiles(context.dir)
      .map((file) => ({ ...file, summary: summarizeFile(file.path) }));
  });

  handle("spec:read", (_event, file, projectDir) => {
    const context = projectContext(projectDir);
    const target = assertWithin(String(file), [
      context.dir,
      app.getPath("home"),
    ]);
    const text = fs.readFileSync(target, "utf8");
    return {
      path: target,
      text,
      summary: specs.summarizeSpecText(text, target),
      bytes: Buffer.byteLength(text),
    };
  });

  handle("spec:write", (_event, file, text, projectDir) => {
    const context = projectContext(projectDir);
    const target = assertWithin(String(file), [context.dir]);
    if (typeof text !== "string") throw new Error("text required");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    return {
      path: target,
      bytes: Buffer.byteLength(text),
      summary: specs.summarizeSpecText(text, target),
    };
  });

  handle("spec:scaffold", async (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command) throw new Error("cairn binary not found");
    const name = String(options?.name ?? "").trim();
    if (!name) throw new Error("name required");
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
    const specPath = assertWithin(String(options?.spec), [
      context.dir,
      app.getPath("home"),
    ]);
    const argv = cli.buildVerifyArgv({
      spec: specPath,
      config: options?.config
        ? assertWithin(String(options.config), [context.dir])
        : context.configPath,
      env: options?.env ?? getSettings().run?.env ?? null,
      stamp: Boolean(options?.stamp),
      vars: options?.vars ?? getSettings().run?.vars ?? [],
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
    const specPath = assertWithin(String(options?.spec), [
      context.dir,
      app.getPath("home"),
    ]);
    const argv = cli.buildHealArgv({
      spec: specPath,
      backend: options?.backend ?? getSettings().run?.backend ?? null,
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

  // ── runs ──────────────────────────────────────────────────────────────────
  handle("run:start", (_event, options, projectDir) => {
    const context = projectContext(projectDir);
    const cairn = cairnFor(context.dir);
    if (!cairn.command)
      throw new Error("cairn binary not found — set it in Settings");
    const settings = getSettings();
    const runSettings = settings.run ?? {};
    const requested = Array.isArray(options?.specs) ? options.specs : [];
    if (!requested.length) throw new Error("no spec selected");
    const specPaths = requested.map((spec) =>
      assertWithin(String(spec), [context.dir, app.getPath("home")]),
    );
    const runsRoot = runsRootFor(context.dir);
    const merged = { ...runSettings, ...options?.overrides };
    const argv = cli.buildRunArgv({
      specs: specPaths,
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
      junit: merged.junit ?? null,
      vars: merged.vars ?? [],
      labels: merged.labels ?? [],
      tags: merged.tags ?? [],
      logLevel: merged.logLevel ?? "info",
    });

    const token = nextToken();
    const controller = new AbortController();
    const knownIds = new Set(runs.listRunIds(runsRoot.runsRoot));
    // Run ids embed the spec's `name:` field, not the file basename — offer
    // both so the live tail recognises the directory the child creates.
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
      argv,
      command: cairn.command,
      cwd: context.dir,
      runsRoot: runsRoot.runsRoot,
      specs: specPaths,
      startedAt: new Date().toISOString(),
    });

    const tail = live.createLiveTail({
      runsRoot: runsRoot.runsRoot,
      specNames,
      knownIds,
      pollMs: Math.max(150, Number(settings.ui?.livePollMs ?? 400)),
      onRunDir: (runDir, runId) =>
        ctx.send("run:live", { token, runDir, runId }),
      onEvents: (events, runDir) =>
        ctx.send("run:events", { token, runDir, events }),
    });

    activeRuns.set(token, {
      controller,
      tail,
      specs: specPaths,
      startedAt: Date.now(),
      argv,
      command: cairn.command,
    });

    void cli
      .execCairn({
        command: cairn.command,
        argv,
        cwd: context.dir,
        timeoutMs: 0,
        signal: controller.signal,
        onLog: (entry) => ctx.send("run:log", { token, entry }),
      })
      .then((result) => {
        // Give the tail one last chance to drain events written at the finish.
        setTimeout(() => {
          tail.stop();
          activeRuns.delete(token);
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

    return { token, argv, command: cairn.command, cwd: context.dir };
  });

  handle("run:cancel", (_event, token) => {
    const entry = activeRuns.get(String(token));
    if (!entry) return { cancelled: false };
    entry.tail?.stop();
    entry.controller.abort();
    activeRuns.delete(String(token));
    return { cancelled: true };
  });

  handle("run:active", () =>
    [...activeRuns.entries()].map(([token, entry]) => ({
      token,
      specs: entry.specs,
      argv: entry.argv,
      command: entry.command,
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
    });
    return {
      runsRoot,
      source,
      exists: fs.existsSync(runsRoot),
      runs: list,
      specNames: runs.listRunSpecs(runsRoot),
    };
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

  handle("run:detail", (_event, runRef, projectDir) => {
    const runDir = runDirFor(String(runRef), projectDir);
    return runs.readRunDetail(runDir);
  });

  handle("run:artifact-text", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    return runs.readBoundedText(
      runDir,
      String(options?.path ?? ""),
      Number(options?.maxBytes ?? runs.DEFAULT_MAX_TEXT_BYTES),
    );
  });

  handle("run:artifact-image", (_event, options, projectDir) => {
    const runDir = runDirFor(
      String(options?.runDir ?? options?.runRef),
      projectDir,
    );
    return runs.readAsDataUrl(runDir, String(options?.path ?? ""));
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
      a: String(options?.a ?? "previous"),
      b: String(options?.b ?? "latest"),
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
    const argv = ["clean", "--artifact-root", runsRoot, "--format", "json"];
    if (options?.all) argv.push("--all");
    else if (options?.keepRuns)
      argv.push("--keep-runs", String(options.keepRuns));
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
    return canceled || !filePaths[0] ? null : filePaths[0];
  });

  handle("dialog:open-spec", async (_event, projectDir) => {
    const context = projectContext(projectDir);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Choose a spec YAML",
      defaultPath: context.dir,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Cairntrace specs", extensions: ["yml", "yaml"] }],
    });
    return canceled ? [] : filePaths;
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

  handle("fs:exists", (_event, target) => fs.existsSync(String(target)));

  handle("fs:reveal", (_event, target) => {
    const resolved = path.resolve(String(target ?? ""));
    if (!resolved || !fs.existsSync(resolved))
      throw new Error(`nothing to reveal at ${resolved}`);
    shell.showItemInFolder(resolved);
    return resolved;
  });

  handle("app:quit", () => {
    for (const entry of activeRuns.values()) {
      entry.tail?.stop();
      entry.controller.abort();
    }
    activeRuns.clear();
    app.quit();
    return true;
  });

  // ── external-run watcher ─────────────────────────────────────────────────
  // Polls the artifact root for runs started outside the app (terminal,
  // agents) and streams their events.ndjson into the renderer. main.js starts
  // it once the window has finished loading: the renderer registers its push
  // subscriptions during script evaluation, so that ordering guarantees no
  // event is consumed before anyone can receive it.
  const runWatcher = createRunWatcher({
    runsRoot: () => {
      try {
        return cached(
          "watch:runsRoot",
          10_000,
          () => runsRootFor(null).runsRoot,
        );
      } catch {
        return null;
      }
    },
    pollMs: 2000,
    excludes: appTrackedRunIds,
    onSnapshot: (list) => ctx.send("runs:detected", { runs: list }),
    onEvents: (runId, events) =>
      ctx.send("run:external-events", { runId, events }),
    onFinished: (runId, info) =>
      ctx.send("run:external-finished", { runId, ...info }),
  });

  /** Cancel every spawned cairn process before the app disappears. */
  const shutdown = () => {
    runWatcher.stop();
    for (const entry of activeRuns.values()) {
      entry.tail?.stop();
      try {
        entry.controller.abort();
      } catch {
        // already dead
      }
    }
    activeRuns.clear();
  };
  app.on("before-quit", shutdown);
  return { shutdown, activeRuns, runWatcher };
}

module.exports = { registerIpc, nextToken };
