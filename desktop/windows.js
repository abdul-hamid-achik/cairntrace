/**
 * Secondary windows (the self-contained `report.html` viewer).
 *
 * Reports are opened in their own window instead of an iframe: they are
 * fully self-contained HTML the runner already redacted, and a separate
 * window keeps them printable and independently resizable.
 */
const path = require("node:path");
const { BrowserWindow, shell } = require("electron");

/** @type {BrowserWindow[]} */
const reportWindows = [];
/** window id → report path, so focus-deduping never monkey-patches a window */
const reportPaths = new Map();

/**
 * @param {string} reportPath absolute path to a run's report.html
 * @param {string} title
 * @returns {BrowserWindow}
 */
function openReportWindow(reportPath, title) {
  const existing = reportWindows.find(
    (win) => !win.isDestroyed() && reportPaths.get(win.id) === reportPath,
  );
  if (existing) {
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    title: `Report · ${title}`,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A report is a static document; it never needs the preload bridge.
      preload: undefined,
    },
  });
  reportPaths.set(win.id, reportPath);
  win.setMenuBarVisibility(false);
  // Keep outbound clicks in the system browser rather than hijacking the report.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = `file://${path.resolve(reportPath)}`;
    if (url !== allowed) event.preventDefault();
  });
  win.on("closed", () => {
    const index = reportWindows.indexOf(win);
    if (index !== -1) reportWindows.splice(index, 1);
    reportPaths.delete(win.id);
  });
  reportWindows.push(win);
  void win.loadFile(reportPath);
  return win;
}

/** Close every report window (used on quit and before a project switch). */
function closeReportWindows() {
  for (const win of reportWindows.splice(0))
    if (!win.isDestroyed()) win.close();
}

module.exports = { openReportWindow, closeReportWindows };
