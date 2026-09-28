/**
 * Preload bridge.
 *
 * The renderer is sandboxed with context isolation, so this file is the only
 * door into Node. It exposes a channel allowlist rather than `ipcRenderer`
 * itself: a compromised renderer can call cairn commands the app already
 * offers, and nothing else.
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Request/response channels the renderer may invoke. */
const INVOKE_CHANNELS = new Set([
  "app:info",
  "app:quit",
  "settings:get",
  "settings:update",
  "settings:reset",
  "settings:reveal",
  "cairn:resolve",
  "cairn:version",
  "cairn:doctor",
  "cairn:choose-binary",
  "projects:list",
  "projects:choose",
  "projects:open-recent",
  "projects:forget",
  "project:inspect",
  "specs:list",
  "spec:read",
  "spec:write",
  "spec:scaffold",
  "spec:verify",
  "spec:heal",
  "run:start",
  "run:cancel",
  "run:active",
  "runs:list",
  "run:detail",
  "run:artifact-text",
  "run:artifact-image",
  "run:files",
  "run:events",
  "run:reveal",
  "run:open-report",
  "run:open-context",
  "runs:diff",
  "stats:get",
  "docs:get",
  "explain:get",
  "services:status",
  "checkpoints:list",
  "clean:runs",
  "shell:open-external",
  "dialog:open-directory",
  "dialog:open-spec",
  "dialog:save-spec",
  "fs:exists",
  "fs:reveal",
]);

/** Push channels the renderer may subscribe to. */
const RECEIVE_CHANNELS = new Set([
  "run:started",
  "run:log",
  "run:live",
  "run:events",
  "run:done",
  "menu:navigate",
  "menu:open-project",
  "menu:open-spec",
  "menu:run-focused",
  "menu:verify-focused",
  "app:open-files",
  "app:error",
]);

/**
 * @param {string} channel
 * @param {Set<string>} allowed
 */
function assertChannel(channel, allowed) {
  if (typeof channel !== "string" || !allowed.has(channel))
    throw new Error(`ipc channel not allowed: ${String(channel)}`);
}

contextBridge.exposeInMainWorld("cairn", {
  /**
   * Invoke a handler and unwrap the envelope it returns.
   * @param {string} channel
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async call(channel, ...args) {
    assertChannel(channel, INVOKE_CHANNELS);
    const result = await ipcRenderer.invoke(channel, ...args);
    if (result && result.ok === false) {
      const error = new Error(String(result.error ?? "cairn ipc failure"));
      error.stack = result.stack
        ? `${error.message}\n${result.stack}`
        : error.stack;
      throw error;
    }
    return result?.data;
  },
  /**
   * Subscribe to a push channel.
   * @param {string} channel
   * @param {(payload: any) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(channel, listener) {
    assertChannel(channel, RECEIVE_CHANNELS);
    if (typeof listener !== "function") throw new Error("listener required");
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  /**
   * Tell the main process the renderer finished booting (`--smoke` harness).
   * @param {{ ok: boolean, reason?: string | null, checks?: Record<string, unknown> | null }} payload
   */
  smokeReady(payload) {
    ipcRenderer.send("smoke:ready", payload);
  },
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
});
