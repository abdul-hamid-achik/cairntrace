/**
 * Launch safety: per-project launch templates and suite lock files.
 *
 * Some projects must never run a spec as a bare `cairn run` — their task
 * runner takes a suite lock, checks preconditions, and passes its own flags.
 * A project can set a launch template such as
 *
 *     task run FLOW={spec} ENV={env} -- {cairnArgs}
 *
 * and Studio spawns that instead (no shell: the template is tokenized and
 * each placeholder substituted into argv). Lock files (or lock directories)
 * listed for the project disable Run while they exist, and show the owner
 * when the lock carries one. Nothing here changes the default behaviour: an
 * unset template spawns `cairn run` as before, and no locks means no gate.
 */
const fs = require("node:fs");
const path = require("node:path");
const { isWithin, safeJoin } = require("./runs");

const PLACEHOLDERS = new Set([
  "spec",
  "specs",
  "specName",
  "env",
  "cairnArgs",
  "projectDir",
]);
/** Tokens that only mean something to a shell — templates run without one. */
const SHELL_OPERATORS = new Set(["|", "||", "&&", ";", ">", ">>", "<", "&"]);
/** Files inside a lock directory that may name its owner, in order. */
const OWNER_FILES = ["owner", "owner.json", "owner.txt", "info", "pid"];

/**
 * Split a template into argv tokens. Single and double quotes group;
 * a backslash escapes the next character outside single quotes.
 * @param {string} template
 * @returns {string[]}
 */
function tokenizeTemplate(template) {
  const tokens = [];
  let current = "";
  let inToken = false;
  /** @type {'"' | "'" | null} */
  let quote = null;
  const text = String(template ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index];
      } else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      current += text[index];
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) throw new Error("unterminated quote in launch template");
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * @param {string} template
 * @returns {{ ok: boolean, tokens?: string[], error?: string }}
 */
function validateTemplate(template) {
  let tokens;
  try {
    tokens = tokenizeTemplate(template);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  if (!tokens.length) return { ok: false, error: "launch template is empty" };
  if (/\{\w+\}/.test(tokens[0]))
    return {
      ok: false,
      error: "the first token must be a command, not a placeholder",
    };
  for (const token of tokens) {
    if (SHELL_OPERATORS.has(token))
      return {
        ok: false,
        error: `"${token}" needs a shell; launch templates run without one — wrap the pipeline in a script`,
      };
    for (const match of token.matchAll(/\{(\w+)\}/g))
      if (!PLACEHOLDERS.has(match[1]))
        return {
          ok: false,
          error: `unknown placeholder {${match[1]}} (known: ${[...PLACEHOLDERS].map((name) => `{${name}}`).join(" ")})`,
        };
  }
  if (!tokens.some((token) => /\{specs?\}/.test(token)))
    return {
      ok: false,
      error: "the template must pass the spec: use {spec} or {specs}",
    };
  return { ok: true, tokens };
}

/**
 * Spec path as the task runner expects it: relative to the project when the
 * spec lives inside it.
 * @param {string} spec
 * @param {string} projectDir
 * @returns {string}
 */
function specForTemplate(spec, projectDir) {
  if (projectDir && isWithin(spec, [projectDir]))
    return path.relative(projectDir, spec) || spec;
  return spec;
}

/**
 * Turn a template into `{ command, args }`.
 * `cairnArgs` are the `cairn run` flags Studio would have passed (everything
 * after `run <specs…>`), minus `--env` when the template routes `{env}`
 * itself.
 * @param {string} template
 * @param {{ specs: string[], env?: string | null, runArgv: string[], projectDir: string }} input
 * @returns {{ command: string, args: string[] }}
 */
function buildLaunchCommand(template, input) {
  const checked = validateTemplate(template);
  if (!checked.ok || !checked.tokens) throw new Error(checked.error);
  const tokens = checked.tokens;
  const specs = input.specs ?? [];
  if (!specs.length) throw new Error("launch template needs at least one spec");
  // Standalone (`{specs}`) or embedded (`FLOWS={specs}`, joined with spaces).
  const usesSpecs = tokens.some((token) => token.includes("{specs}"));
  if (specs.length > 1 && !usesSpecs)
    throw new Error(
      "this launch template runs one spec at a time ({spec}); use {specs} to pass several",
    );
  const routesEnv = tokens.some((token) => token.includes("{env}"));
  const specSet = new Set(specs);
  const flags = [];
  const argv = input.runArgv ?? [];
  for (let index = argv[0] === "run" ? 1 : 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (specSet.has(value)) continue;
    if (routesEnv && value === "--env") {
      index += 1;
      continue;
    }
    flags.push(value);
  }
  const relSpecs = specs.map((spec) => specForTemplate(spec, input.projectDir));
  const first = relSpecs[0];
  const values = {
    spec: first,
    specName: path.basename(first, path.extname(first)),
    env: input.env ?? "",
    projectDir: input.projectDir ?? "",
  };
  /** @type {string[]} */
  const out = [];
  for (const token of tokens) {
    if (token === "{specs}") {
      out.push(...relSpecs);
      continue;
    }
    if (token === "{cairnArgs}") {
      out.push(...flags);
      continue;
    }
    // Embedded in a larger token (FLOW={spec}), list placeholders join.
    out.push(
      token.replace(/\{(\w+)\}/g, (_match, name) => {
        if (name === "specs") return relSpecs.join(" ");
        if (name === "cairnArgs") return flags.join(" ");
        return String(values[name] ?? "");
      }),
    );
  }
  const [command, ...args] = out;
  return { command, args };
}

/**
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string | null}
 */
function readSmall(file, maxBytes = 2048) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * One-line owner description from a lock's owner text (JSON or plain).
 * @param {string | null} text
 * @returns {string | null}
 */
function describeOwner(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = [];
      for (const [key, value] of Object.entries(parsed)) {
        if (value === null || typeof value === "object") continue;
        parts.push(`${key}=${String(value).slice(0, 80)}`);
        if (parts.length >= 6) break;
      }
      return parts.join(" ") || null;
    }
  } catch {
    // plain text owner
  }
  return trimmed.split(/\r?\n/).slice(0, 3).join(" · ").slice(0, 300);
}

/**
 * State of each configured lock (relative to the project directory).
 * Paths escaping the project are reported as invalid, never read.
 * @param {string} projectDir
 * @param {string[]} lockFiles
 * @param {{ now?: number }} [options]
 * @returns {Array<{ path: string, absolute: string | null, exists: boolean, kind: "file" | "dir" | null, owner: string | null, ageMs: number | null, error?: string }>}
 */
function readLockState(projectDir, lockFiles, options = {}) {
  const now = options.now ?? Date.now();
  /** @type {Array<any>} */
  const out = [];
  for (const raw of Array.isArray(lockFiles) ? lockFiles : []) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    const absolute = path.isAbsolute(entry)
      ? isWithin(entry, [projectDir])
        ? path.resolve(entry)
        : null
      : safeJoin(projectDir, entry);
    if (!absolute) {
      out.push({
        path: entry,
        absolute: null,
        exists: false,
        kind: null,
        owner: null,
        ageMs: null,
        error: "lock path must stay inside the project",
      });
      continue;
    }
    let stat = null;
    try {
      stat = fs.statSync(absolute);
    } catch {
      // no lock
    }
    if (!stat) {
      out.push({
        path: entry,
        absolute,
        exists: false,
        kind: null,
        owner: null,
        ageMs: null,
      });
      continue;
    }
    let owner = null;
    if (stat.isDirectory()) {
      for (const name of OWNER_FILES) {
        const text = readSmall(path.join(absolute, name));
        if (text !== null) {
          owner = describeOwner(text);
          break;
        }
      }
    } else owner = describeOwner(readSmall(absolute));
    out.push({
      path: entry,
      absolute,
      exists: true,
      kind: stat.isDirectory() ? "dir" : "file",
      owner,
      ageMs: Math.max(0, now - stat.mtimeMs),
    });
  }
  return out;
}

/**
 * The project's launch settings out of the settings document.
 * @param {Record<string, any>} settings
 * @param {string} projectDir
 * @returns {{ launchTemplate: string | null, lockFiles: string[] }}
 */
function projectLaunchSettings(settings, projectDir) {
  const entry = settings?.projectSettings?.[path.resolve(projectDir)] ?? {};
  return {
    launchTemplate:
      typeof entry.launchTemplate === "string" && entry.launchTemplate.trim()
        ? entry.launchTemplate.trim()
        : null,
    lockFiles: Array.isArray(entry.lockFiles)
      ? entry.lockFiles.filter(
          (value) => typeof value === "string" && value.trim(),
        )
      : [],
  };
}

module.exports = {
  PLACEHOLDERS,
  tokenizeTemplate,
  validateTemplate,
  buildLaunchCommand,
  describeOwner,
  readLockState,
  projectLaunchSettings,
};
