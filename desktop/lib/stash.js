/**
 * file.cheap stashes, seen through the `cairn stash` CLI.
 *
 * Studio never talks to fcheap directly: it spawns `cairn stash list|info|
 * restore --format json` like an agent would. This module owns the argv
 * (with stash-id validation — an id is one safe path component and can never
 * be read as a flag) and finding the run directory inside a restored stash so
 * Run detail can open it.
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * Mirrors SafeStashIdSchema (src/core/schema/stash.v1.ts) and additionally
 * refuses a leading "-" so an id can never be parsed as an option.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeStashId(value) {
  if (typeof value !== "string") return false;
  const id = value.trim();
  if (!id || id.length > 255 || id !== value) return false;
  if (id === "." || id === ".." || id.startsWith("-")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  for (const character of id) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

/**
 * Tags are passed as separate argv entries; refuse ones that could be read
 * as flags or that fcheap would split.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSafeTag(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("-") &&
    ![...value].some(
      (character) =>
        /[\s,]/.test(character) || (character.codePointAt(0) ?? 0) < 0x20,
    )
  );
}

/**
 * @param {{ tags?: string[], tool?: string | null }} [options]
 * @returns {string[]}
 */
function buildStashListArgv(options = {}) {
  const argv = ["stash", "list"];
  const tool = options.tool === undefined ? "cairntrace" : options.tool;
  if (tool) {
    if (!isSafeTag(tool)) throw new Error(`invalid tool name: ${tool}`);
    argv.push("--tool", tool);
  }
  for (const tag of options.tags ?? []) {
    if (!isSafeTag(tag)) throw new Error(`invalid tag: ${tag}`);
    argv.push("--tag", tag);
  }
  argv.push("--format", "json");
  return argv;
}

/**
 * @param {string} stashId
 * @returns {string[]}
 */
function buildStashInfoArgv(stashId) {
  if (!isSafeStashId(stashId)) throw new Error("invalid stash id");
  return ["stash", "info", stashId, "--format", "json"];
}

/**
 * @param {string} stashId
 * @param {string} toDir absolute target directory
 * @returns {string[]}
 */
function buildStashRestoreArgv(stashId, toDir) {
  if (!isSafeStashId(stashId)) throw new Error("invalid stash id");
  if (!path.isAbsolute(toDir))
    throw new Error("restore target must be absolute");
  return ["stash", "restore", stashId, "--to", toDir, "--format", "json"];
}

/**
 * The run directory inside a restored stash: the target itself when it holds
 * `run.json`, else the shallowest descendant that does (fcheap may restore
 * the run folder by name under the target).
 * @param {string} dir
 * @param {number} [maxDepth]
 * @returns {string | null}
 */
function locateRestoredRun(dir, maxDepth = 3) {
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = [{ dir: path.resolve(dir), depth: 0 }];
  while (queue.length) {
    const next = /** @type {{ dir: string, depth: number }} */ (queue.shift());
    if (fs.existsSync(path.join(next.dir, "run.json"))) return next.dir;
    if (next.depth >= maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ))
      if (entry.isDirectory() && !entry.isSymbolicLink())
        queue.push({
          dir: path.join(next.dir, entry.name),
          depth: next.depth + 1,
        });
  }
  return null;
}

/**
 * POSIX-shell quoting for one argv entry.
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shell-quoted copy of a cairn command line, for "copy CLI" buttons.
 * @param {string[]} argv
 * @returns {string}
 */
function cliEquivalent(argv) {
  return ["cairn", ...argv].map(shellQuote).join(" ");
}

module.exports = {
  isSafeStashId,
  isSafeTag,
  buildStashListArgv,
  buildStashInfoArgv,
  buildStashRestoreArgv,
  locateRestoredRun,
  cliEquivalent,
};
