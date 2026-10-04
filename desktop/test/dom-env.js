/**
 * A browser-like environment for mounting renderer views under node:test.
 *
 * happy-dom provides the DOM; the real renderer scripts are loaded in the
 * order index.html loads them (they are IIFEs that publish onto
 * `globalThis.Studio`), and `window.cairn` is a stub bridge whose handlers
 * the test supplies, usually backed by the same lib/ functions ipc.js uses,
 * so a view renders exactly the shapes the main process would send.
 *
 * node:test runs every test file in its own process, so these globals never
 * leak into the other suites.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Window } = require("happy-dom");

const RENDERER = path.join(__dirname, "..", "renderer");

/** Scripts in index.html order, minus app.js (booted only on request). */
const SCRIPTS = [
  "../lib/format.js",
  "../lib/events.js",
  "../lib/policy.js",
  "dom.js",
  "markdown.js",
  "state.js",
  "components.js",
  "panes.js",
  "ops.js",
  "views/runs.js",
  "views/run-detail.js",
  "views/specs.js",
  "views/catalog.js",
  "views/suites.js",
  "views/config-vars.js",
  "views/live.js",
  "views/invocations.js",
  "views/sessions.js",
  "views/stashes.js",
  "views/stats.js",
  "views/docs.js",
  "views/environment.js",
  "views/settings.js",
];

/** @type {Array<ReturnType<typeof setInterval>>} */
const intervals = [];
/** @type {Array<ReturnType<typeof setTimeout>>} */
const timeouts = [];

/**
 * Install the DOM globals and the page skeleton (index.html without its
 * scripts), then load the renderer scripts.
 * @param {{ app?: boolean }} [options] also load app.js (boots the shell)
 * @returns {{ window: any, document: Document, Studio: any }}
 */
function installDom(options = {}) {
  const window = new Window({
    url: "file:///studio/renderer/index.html",
    width: 1440,
    height: 920,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  const html = fs
    .readFileSync(path.join(RENDERER, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  window.document.write(html);

  const g = /** @type {any} */ (globalThis);
  g.window = window;
  g.document = window.document;
  for (const name of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLTextAreaElement",
    "HTMLDialogElement",
    "HTMLDetailsElement",
    "HTMLImageElement",
    "DocumentFragment",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "CustomEvent",
    "getComputedStyle",
  ])
    g[name] = window[name];
  g.requestAnimationFrame = (/** @type {() => void} */ fn) =>
    setTimeout(() => fn(), 0);
  g.cancelAnimationFrame = (/** @type {any} */ id) => clearTimeout(id);
  // Track intervals and long timers (toast lifetimes) the renderer starts,
  // so a test file ends as soon as its tests do.
  const nativeSetInterval = setInterval;
  const nativeClearInterval = clearInterval;
  const nativeSetTimeout = setTimeout;
  g.setInterval = (/** @type {any[]} */ ...args) => {
    const id = nativeSetInterval(.../** @type {[any, any]} */ (args));
    intervals.push(id);
    return id;
  };
  g.clearInterval = (/** @type {any} */ id) => {
    const index = intervals.indexOf(id);
    if (index >= 0) intervals.splice(index, 1);
    nativeClearInterval(id);
  };
  g.setTimeout = (/** @type {any[]} */ ...args) => {
    const id = nativeSetTimeout(.../** @type {[any, any]} */ (args));
    if (Number(args[1]) >= 1000) timeouts.push(id);
    return id;
  };

  const scripts = options.app ? [...SCRIPTS, "app.js"] : SCRIPTS;
  for (const script of scripts) require(path.join(RENDERER, script));
  return { window, document: window.document, Studio: g.Studio };
}

/**
 * Point `window.cairn` at a table of channel handlers. Every call is
 * recorded; an unhandled channel rejects (a view asking for something the
 * test did not expect is a failure, not a silent undefined).
 * @param {Record<string, (...args: any[]) => any>} handlers
 * @returns {Array<[string, ...any[]]>} the recorded calls
 */
function installBridge(handlers) {
  /** @type {Array<[string, ...any[]]>} */
  const calls = [];
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const listeners = new Map();
  /** @type {any} */ (globalThis).cairn = {
    async call(/** @type {string} */ channel /** @type {any[]} */, ...args) {
      calls.push([channel, ...args]);
      const fn = handlers[channel];
      if (!fn) throw new Error(`unhandled channel in test: ${channel}`);
      return fn(...args);
    },
    on(
      /** @type {string} */ channel,
      /** @type {(payload: any) => void} */ listener,
    ) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    /** Test helper: deliver a push to subscribers. */
    push(/** @type {string} */ channel, /** @type {any} */ payload) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
    smokeReady(/** @type {any} */ payload) {
      /** @type {any} */ (globalThis).studioSmoke = payload;
    },
    versions: { electron: "test", node: process.versions.node, chrome: "test" },
  };
  return calls;
}

/*
 * Assertion note for DOM tests: compare nodes by identity
 * (`assert.ok(a === b)`), never with assert.equal/deepEqual. On failure
 * node:assert inspects both values, and inspecting a happy-dom node walks
 * the whole document synchronously, which hangs the test process.
 */

/** Let pending promises and 0ms timers run. */
async function settle(rounds = 5) {
  for (let index = 0; index < rounds; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait until `predicate()` holds (or fail after `timeoutMs`).
 * @param {() => unknown} predicate
 * @param {string} what
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Dispatch a keydown on an element (bubbles, like a real key press).
 * @param {Element} target
 * @param {string} key
 */
function press(target, key) {
  const KeyboardEvent = /** @type {any} */ (globalThis).KeyboardEvent;
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

/** How many intervals the renderer has started and not cleared. */
function activeIntervals() {
  return intervals.length;
}

/** Stop every interval the renderer started and close the window. */
function teardown() {
  for (const id of intervals.splice(0)) clearInterval(id);
  for (const id of timeouts.splice(0)) clearTimeout(id);
  const g = /** @type {any} */ (globalThis);
  try {
    g.window?.happyDOM?.abort?.();
    g.window?.close?.();
  } catch {
    // best effort
  }
}

/**
 * Read an events fixture: desktop/test/fixtures/<name>, or a runner golden
 * from src/core/schema/__fixtures__/events/<name> with its `<ts>` / `<runId>`
 * placeholders filled.
 * @param {string} name
 * @param {{ golden?: boolean, runId?: string, ts?: string }} [options]
 * @returns {Array<Record<string, any>>}
 */
function readEvents(name, options = {}) {
  const file = options.golden
    ? path.join(
        __dirname,
        "..",
        "..",
        "src",
        "core",
        "schema",
        "__fixtures__",
        "events",
        name,
      )
    : path.join(__dirname, "fixtures", name);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) =>
      JSON.parse(
        line
          .replaceAll("<ts>", options.ts ?? new Date().toISOString())
          .replaceAll("<runId>", options.runId ?? "run"),
      ),
    );
}

module.exports = {
  installDom,
  installBridge,
  activeIntervals,
  settle,
  waitFor,
  press,
  teardown,
  readEvents,
};
