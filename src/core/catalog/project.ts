import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isMap, parseDocument, type Document } from "yaml";
import { FileCache } from "./fileCache";
import { allComments, leadingComment } from "./yamlComments";

/**
 * Loose, comment-preserving reading of the spec and action YAML files under
 * a project. Nothing is substituted, validated against the run schema, or
 * executed: the catalog describes files as authored, so a spec that needs a
 * var to parse still shows up.
 */

const MAX_FILES = 5_000;
const MAX_DIRS = 10_000;
const MAX_DEPTH = 10;
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "dist",
  "build",
  "_invocations",
]);

export interface UseRef {
  action: string;
  /** Keys passed under `use: { action, vars }`. */
  vars: string[];
}

export interface ScriptRef {
  outcome: string;
  /** As authored. */
  file: string;
  /** Absolute path when it resolves statically. */
  path?: string;
  runtime: "browser" | "node";
  fixtureKeys: string[];
}

interface ParsedBase {
  path: string;
  name: string;
  /** Absolute paths of `imports:` (statically resolvable ones). */
  imports: string[];
  uses: UseRef[];
  /** Names referenced as `${vars.X}` in any value. */
  varRefs: Set<string>;
  comments: string;
  leading?: string;
}

export interface ParsedSpec extends ParsedBase {
  kind: "spec";
  intent: string;
  tags: string[];
  requires?: unknown;
  environment?: string;
  resume?: string;
  scripts: ScriptRef[];
  outcomeText: string;
  /** Fixture names under `fixtures:` (`.reset` stripped). */
  fixtures: string[];
}

export interface ParsedAction extends ParsedBase {
  kind: "action";
  description?: string;
  vars: Record<string, string | number | boolean>;
  inputs: Record<
    string,
    {
      description?: string;
      required?: boolean;
      default?: string | number | boolean;
    }
  >;
  steps: number;
}

export type ParsedFile =
  | ParsedSpec
  | ParsedAction
  | { kind: "other"; path: string }
  | { kind: "error"; path: string; message: string };

/**
 * Parsed files per config directory (`${config.dir}` resolves against it),
 * so cataloging the same tree under another config never reuses paths
 * resolved for the first one.
 */
const yamlCaches = new Map<string, FileCache<ParsedFile>>();

function yamlCacheFor(configDir: string): FileCache<ParsedFile> {
  let cache = yamlCaches.get(configDir);
  if (!cache) {
    if (yamlCaches.size >= 8) {
      const oldest = yamlCaches.keys().next().value;
      if (oldest !== undefined) yamlCaches.delete(oldest);
    }
    cache = new FileCache<ParsedFile>(5_000);
    yamlCaches.set(configDir, cache);
  }
  return cache;
}

/** Read (cached by path + mtime) and classify one YAML file. */
export async function readProjectFile(
  path: string,
  configDir: string,
): Promise<ParsedFile | undefined> {
  return yamlCacheFor(configDir).get(
    path,
    (text) => classify(text, path, configDir),
    512 * 1024,
  );
}

/**
 * YAML files under the scan roots, sorted, bounded by depth and count.
 * Hidden folders, dependency/build folders and `skip` (the artifact root)
 * are not entered.
 */
export async function walkYaml(
  roots: string[],
  skip: ReadonlySet<string>,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_DEPTH || seen.has(dir) || skip.has(dir))
      return;
    if (seen.size >= MAX_DIRS) {
      truncated = true;
      return;
    }
    seen.add(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        if (/^cairntrace\.config\.ya?ml$/i.test(entry.name)) continue;
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(full);
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  return { files, truncated };
}

function classify(text: string, path: string, configDir: string): ParsedFile {
  let doc: Document;
  try {
    doc = parseDocument(text);
  } catch (e) {
    return { kind: "error", path, message: (e as Error).message };
  }
  if (doc.errors.length > 0) {
    return {
      kind: "error",
      path,
      message: doc.errors[0]!.message.split("\n")[0]!,
    };
  }
  if (!isMap(doc.contents)) return { kind: "other", path };
  const data = doc.toJS() as Record<string, unknown>;
  if (data.version !== 1 || typeof data.name !== "string") {
    return { kind: "other", path };
  }
  const isSpec =
    typeof data.intent === "string" && Array.isArray(data.outcomes);
  const isAction =
    !isSpec && Array.isArray(data.steps) && data.outcomes === undefined;
  if (!isSpec && !isAction) return { kind: "other", path };
  if (data.name.trim() === "") {
    return {
      kind: "error",
      path,
      message: `${isSpec ? "spec" : "action"} name is empty`,
    };
  }

  const dir = dirname(path);
  const leading = leadingComment(doc);
  const base: ParsedBase = {
    path,
    name: data.name,
    imports: stringList(data.imports)
      .map((p) => resolveStaticPath(p, dir, configDir))
      .filter((p): p is string => p !== undefined),
    uses: collectUses(data.steps),
    varRefs: collectVarRefs(data),
    comments: allComments(doc),
    ...(leading ? { leading } : {}),
  };

  if (isSpec) {
    const metadata = record(data.metadata);
    const session = record(data.session);
    return {
      ...base,
      kind: "spec",
      intent: data.intent as string,
      tags: stringList(metadata?.tags),
      ...(data.requires !== undefined ? { requires: data.requires } : {}),
      ...(typeof data.environment === "string"
        ? { environment: data.environment }
        : {}),
      ...(typeof session?.resume === "string"
        ? { resume: session.resume }
        : {}),
      scripts: collectScripts(data.outcomes as unknown[], dir, configDir),
      fixtures: collectFixtureRefs(data.fixtures),
      outcomeText: (data.outcomes as unknown[])
        .map((o) => {
          const desc = record(o)?.description;
          return typeof desc === "string" ? desc : "";
        })
        .join("\n"),
    };
  }
  const inputs: ParsedAction["inputs"] = {};
  for (const [name, raw] of Object.entries(record(data.inputs) ?? {})) {
    const input = record(raw) ?? {};
    inputs[name] = {
      ...(typeof input.description === "string"
        ? { description: input.description }
        : {}),
      ...(typeof input.required === "boolean"
        ? { required: input.required }
        : {}),
      ...(isScalarValue(input.default) ? { default: input.default } : {}),
    };
  }
  const vars: ParsedAction["vars"] = {};
  for (const [name, value] of Object.entries(record(data.vars) ?? {})) {
    if (isScalarValue(value)) vars[name] = value;
  }
  return {
    ...base,
    kind: "action",
    ...(typeof data.description === "string"
      ? { description: data.description }
      : {}),
    vars,
    inputs,
    steps: (data.steps as unknown[]).length,
  };
}

/**
 * Resolve an authored path the way a run would when it holds no runtime
 * placeholder: `~/`, absolute, `${config.dir}`, `${project.root}` /
 * `${file.dir}` (the declaring file's folder), else relative to `dir`.
 * Undefined when another placeholder makes it run-dependent.
 */
export function resolveStaticPath(
  authored: string,
  dir: string,
  configDir: string,
): string | undefined {
  const value = authored
    .replaceAll("${config.dir}", configDir)
    .replaceAll("${project.root}", dir)
    .replaceAll("${file.dir}", dir);
  if (value.includes("${")) return undefined;
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(dir, value);
}

function collectFixtureRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .map((ref) =>
      typeof ref === "string" ? ref : (record(ref)?.use as unknown),
    )
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(/\.reset$/, ""));
  return [...new Set(names)];
}

function collectUses(steps: unknown): UseRef[] {
  if (!Array.isArray(steps)) return [];
  const out: UseRef[] = [];
  for (const step of steps) {
    const use = record(step)?.use;
    if (typeof use === "string") out.push({ action: use, vars: [] });
    else {
      const obj = record(use);
      if (obj && typeof obj.action === "string") {
        out.push({
          action: obj.action,
          vars: Object.keys(record(obj.vars) ?? {}),
        });
      }
    }
  }
  return out;
}

function collectScripts(
  outcomes: unknown[],
  dir: string,
  configDir: string,
): ScriptRef[] {
  const out: ScriptRef[] = [];
  for (const outcome of outcomes) {
    const o = record(outcome);
    const script = record(record(o?.verify)?.script);
    if (
      !o ||
      !script ||
      typeof script.file !== "string" ||
      script.file.trim() === ""
    ) {
      continue;
    }
    const path = resolveStaticPath(script.file, dir, configDir);
    out.push({
      outcome:
        typeof o.id === "string" && o.id.trim() !== "" ? o.id : "(unnamed)",
      file: script.file,
      ...(path ? { path } : {}),
      runtime: script.runtime === "node" ? "node" : "browser",
      fixtureKeys: Object.keys(record(script.fixtures) ?? {}),
    });
  }
  return out;
}

const VAR_REF_RE = /\$\{vars\.([^}\s]+)\}/g;

/** Every `${vars.X}` name used in a value (keys and comments are ignored). */
function collectVarRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(VAR_REF_RE)) out.add(m[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) collectVarRefs(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectVarRefs(item, out);
  }
  return out;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function isScalarValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** True when the file or one of its folders below `root` starts with `_`. */
export function isDraftPath(path: string, root: string): boolean {
  if (basename(path).startsWith("_")) return true;
  const rel = path.startsWith(root + sep) ? path.slice(root.length + 1) : "";
  return rel
    .split(sep)
    .slice(0, -1)
    .some((segment) => segment.startsWith("_"));
}
