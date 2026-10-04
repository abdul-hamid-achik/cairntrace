/**
 * Cairntrace Studio — Electron main process.
 *
 * Responsibilities are deliberately narrow: own the windows, own the settings
 * file location, register the IPC surface (`ipc.js`), and keep the renderer
 * sandboxed. All product behaviour lives in the `cairn` CLI it spawns.
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, Menu, protocol, shell } = require("electron");

const { registerIpc } = require("./ipc");
const {
  MEDIA_SCHEME,
  createMediaHandler,
  createMediaRegistry,
} = require("./lib/media");
const { closeReportWindows } = require("./windows");

// Videos stream through cairn-artifact://media/<token> (range requests, no
// data URLs). Privileges must be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true },
  },
]);
const mediaRegistry = createMediaRegistry();

const isMac = process.platform === "darwin";
// Packaged apps get argv = [exe, ...flags]; dev gets [electron, ., ...flags].
// Slice from the first argument so both shapes see the same flags.
const argv = process.argv.slice(1);
const smokeMode = argv.includes("--smoke");
/** A spec file dropped on the dock icon / passed on the command line. */
const pendingFiles = argv.filter(
  (entry) => !entry.startsWith("--") && /\.(ya?ml)$/i.test(entry),
);

const repoRoot = fs.existsSync(path.join(__dirname, "..", "bin", "cairn"))
  ? path.resolve(__dirname, "..")
  : path.resolve(__dirname);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {ReturnType<typeof registerIpc> | null} */
let ipcHandle = null;

/** @returns {BrowserWindow | null} */
function getWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/**
 * @param {string} channel
 * @param {unknown} payload
 */
function send(channel, payload) {
  const win = getWindow();
  if (win) win.webContents.send(channel, payload);
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: "#0f1115",
    title: "Cairntrace Studio",
    ...(isMac
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 16 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    if (!smokeMode) win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = `file://${path.join(__dirname, "renderer", "index.html")}`;
    if (url !== allowed) event.preventDefault();
  });
  // The renderer registers its watcher push subscriptions while scripts
  // evaluate (before this event), so starting here drops nothing. start() is
  // idempotent, so a reload re-fires this harmlessly.
  win.webContents.on("did-finish-load", () => {
    ipcHandle?.runWatcher?.start();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  void win.loadFile(path.join(__dirname, "renderer", "index.html"));
  return win;
}

function buildMenu() {
  /** @type {any[]} */
  const template = [
    ...(isMac ? [{ role: /** @type {const} */ ("appMenu") }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => send("menu:open-project", {}),
        },
        {
          label: "Open Spec…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => send("menu:open-spec", {}),
        },
        { type: "separator" },
        {
          label: "Run Focused Spec",
          accelerator: "CmdOrCtrl+R",
          click: () => send("menu:run-focused", {}),
        },
        {
          label: "Verify Focused Spec",
          accelerator: "CmdOrCtrl+Shift+V",
          click: () => send("menu:verify-focused", {}),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Runs",
          accelerator: "CmdOrCtrl+1",
          click: () => send("menu:navigate", { view: "runs" }),
        },
        {
          label: "Specs",
          accelerator: "CmdOrCtrl+2",
          click: () => send("menu:navigate", { view: "specs" }),
        },
        {
          label: "Live",
          accelerator: "CmdOrCtrl+3",
          click: () => send("menu:navigate", { view: "live" }),
        },
        {
          label: "Invocations",
          accelerator: "CmdOrCtrl+8",
          click: () => send("menu:navigate", { view: "invocations" }),
        },
        {
          label: "Sessions",
          accelerator: "CmdOrCtrl+9",
          click: () => send("menu:navigate", { view: "sessions" }),
        },
        {
          label: "Catalog",
          accelerator: "CmdOrCtrl+Shift+C",
          click: () => send("menu:navigate", { view: "catalog" }),
        },
        {
          label: "Suites",
          click: () => send("menu:navigate", { view: "suites" }),
        },
        {
          label: "Config vars",
          click: () => send("menu:navigate", { view: "config-vars" }),
        },
        {
          label: "Stashes",
          accelerator: "CmdOrCtrl+7",
          click: () => send("menu:navigate", { view: "stashes" }),
        },
        {
          label: "Cohorts",
          accelerator: "CmdOrCtrl+4",
          click: () => send("menu:navigate", { view: "stats" }),
        },
        {
          label: "Docs",
          accelerator: "CmdOrCtrl+5",
          click: () => send("menu:navigate", { view: "docs" }),
        },
        {
          label: "Environment",
          accelerator: "CmdOrCtrl+6",
          click: () => send("menu:navigate", { view: "doctor" }),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [{ type: "separator" }, { role: "front" }] : []),
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Cairntrace docs",
          click: () =>
            void shell.openExternal("https://cairntrace.dev/").catch(() => {}),
        },
        {
          label: "Repository",
          click: () =>
            void shell
              .openExternal("https://github.com/abdul-hamid-achik/cairntrace")
              .catch(() => {}),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Smoke mode boots the real window (hidden), waits for the renderer to report
 * it finished first paint, prints one JSON line, and exits. This is how CI and
 * `bun run smoke` prove the main/preload/renderer wiring works.
 */
function installSmokeHarness() {
  const finish = (code, payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    app.exit(code);
  };
  const timer = setTimeout(() => {
    finish(1, {
      ok: false,
      reason: "renderer did not report ready within 25s",
    });
  }, 25_000);
  require("electron").ipcMain.on("smoke:ready", (_event, payload) => {
    clearTimeout(timer);
    const ok = Boolean(payload?.ok);
    finish(ok ? 0 : 1, {
      ok,
      reason: payload?.reason ?? null,
      checks: payload?.checks ?? null,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: "Cairntrace Studio",
      applicationVersion: app.getVersion(),
      copyright: "MIT © Cairntrace",
    });

    const settingsFile = path.join(app.getPath("userData"), "settings.json");
    protocol.handle(MEDIA_SCHEME, createMediaHandler(mediaRegistry));
    ipcHandle = registerIpc({
      settingsFile,
      repoRoot,
      getWindow,
      send,
      media: mediaRegistry,
    });

    buildMenu();
    mainWindow = createMainWindow();
    if (smokeMode) installSmokeHarness();

    if (pendingFiles.length) {
      const files = pendingFiles.map((f) => path.resolve(f));
      // Files handed to the app by the user are readable even outside the
      // open project (the IPC boundary otherwise confines reads to it).
      ipcHandle.allowFiles(files);
      send("app:open-files", { files });
    }

    app.on("open-file", (event, file) => {
      event.preventDefault();
      if (!/\.(ya?ml)$/i.test(file)) return;
      ipcHandle?.allowFiles([path.resolve(file)]);
      const win = getWindow();
      if (win) send("app:open-files", { files: [path.resolve(file)] });
      else pendingFiles.push(file);
    });

    app.on("activate", () => {
      if (!getWindow()) mainWindow = createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    closeReportWindows();
    if (!isMac) app.quit();
  });
  app.on("before-quit", () => {
    ipcHandle?.shutdown();
  });
}

// A renderer crash must never take the whole app down silently.
process.on("uncaughtException", (error) => {
  send("app:error", { message: String(error?.message ?? error) });
});
