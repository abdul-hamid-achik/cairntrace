/**
 * Structured string emission for generated sources.
 *
 * The spec parser resolves `${secrets.X}` / unset-`${env.X}` / `${run.token}`
 * to SENTINELS (see ParseOptions.secretRef and the exporter's runtime option),
 * and project export re-parses reusable actions with `${vars.X}` bound to a
 * var sentinel. This module is the single place that understands those
 * sentinels: every user-derived string is emitted through emitStr()/emitValue(),
 * which returns either a plain JSON string literal or a template literal
 * splicing `process.env.X` / `RUN_TOKEN` / an action parameter — so secret
 * VALUES never land in generated files, exported tests stay re-runnable, and
 * no post-hoc regex over the generated source is ever needed to substitute.
 *
 * Runtime splices (`${requests.<name>…}`, `${evals.<name>…}`,
 * `${artifacts.<name>.path|relativePath}`) are resolved here too: a splice
 * whose producing step was bound earlier in the same scope becomes a
 * `cairnSplice(binding, path)` call that mirrors the runner's rendering; an
 * unbound splice becomes a `cairnUnresolvedSplice(...)` call that throws, and
 * is reported so the exporter can mark the test `test.fixme`. Where the
 * runner does NOT splice (most outcome fields), `RefUsage.spliceSources`
 * keeps the reference as literal text, exactly as `cairn run` compares it.
 *
 * findLateBoundLeak() is the safety net: generated files are scanned for any
 * surviving sentinel and the export fails instead of shipping one.
 */
import { normalizeTextForMatching } from "../textMatching";

export const SECRET_REF_SENTINEL = /__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__/;
export const RUN_TOKEN_SENTINEL = "__CAIRN_RUN_TOKEN__";

const SPLIT_RE =
  /__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__|__CAIRN_RUN_TOKEN__|__CAIRN_VAR_REF__([A-Za-z0-9_]+)__|\$\{(requests|evals)\.([a-z][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}|\$\{artifacts\.([a-z][A-Za-z0-9_]*)\.(path|relativePath)\}/g;

/** Same reference grammar the runner splices at run time. */
const RUNTIME_REF_RE =
  /\$\{(requests|evals)\.([a-z][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_]+)*\}|\$\{artifacts\.([a-z][A-Za-z0-9_]*)\.(?:path|relativePath)\}/g;

/** Any late-bound sentinel, in any letter case (normalization lowercases). */
const LEAK_RE = /__CAIRN_[A-Z_]+__/i;

export type RuntimeRefSource = "requests" | "evals" | "artifacts";

export type TemplatePart =
  | { kind: "lit"; text: string }
  | { kind: "env"; name: string }
  | { kind: "var"; name: string }
  | { kind: "runToken" }
  | {
      kind: "runtime";
      source: RuntimeRefSource;
      name: string;
      path: string[];
      /** Reference without the `${…}` wrapper, e.g. `evals.state.value.id`. */
      ref: string;
    };

export function varRefSentinel(name: string): string {
  return `__CAIRN_VAR_REF__${name}__`;
}

/** Binding key for a runtime reference: `requests:login`, `evals:state`. */
export function runtimeRefKey(source: RuntimeRefSource, name: string): string {
  return `${source}:${name}`;
}

export interface TemplateParseOptions {
  /**
   * Recognize runtime splices (default true). Disable for sources the runner
   * never splices (e.g. browser verifier `script.run`), so their `\${…}` text
   * stays literal JavaScript.
   */
  runtimeRefs?: boolean;
  /**
   * Only these runtime sources splice; a reference to any other source stays
   * literal text and is reported through `onLiteralRef`.
   */
  sources?: ReadonlySet<RuntimeRefSource>;
  onLiteralRef?: (ref: string) => void;
}

/** Split a resolved spec string into literal / late-bound reference parts. */
export function parseTemplateValue(
  s: string,
  opts: TemplateParseOptions = {},
): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of s.matchAll(SPLIT_RE)) {
    const runtimeSource: RuntimeRefSource | undefined =
      m[3] !== undefined
        ? (m[3] as RuntimeRefSource)
        : m[6] !== undefined
          ? "artifacts"
          : undefined;
    if (runtimeSource && opts.runtimeRefs === false) continue;
    if (runtimeSource && opts.sources && !opts.sources.has(runtimeSource)) {
      opts.onLiteralRef?.(m[0].slice(2, -1));
      continue;
    }
    if (m.index > last)
      parts.push({ kind: "lit", text: s.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ kind: "env", name: m[1] });
    else if (m[2] !== undefined) parts.push({ kind: "var", name: m[2] });
    else if (m[3] !== undefined) {
      const path = m[5] ? m[5].slice(1).split(".") : [];
      parts.push({
        kind: "runtime",
        source: m[3] as RuntimeRefSource,
        name: m[4]!,
        path,
        ref: `${m[3]}.${m[4]}${m[5] ?? ""}`,
      });
    } else if (m[6] !== undefined) {
      parts.push({
        kind: "runtime",
        source: "artifacts",
        name: m[6],
        path: [m[7]!],
        ref: `artifacts.${m[6]}.${m[7]}`,
      });
    } else parts.push({ kind: "runToken" });
    last = m.index + m[0].length;
  }
  if (last < s.length || parts.length === 0) {
    parts.push({ kind: "lit", text: s.slice(last) });
  }
  return parts;
}

/** Collects which late-bound references the generated file actually uses. */
export interface RefUsage {
  envNames: Set<string>;
  varNames: Set<string>;
  runToken: boolean;
  /**
   * Runtime-splice bindings visible at the current emission point, keyed by
   * runtimeRefKey() → generated identifier holding the captured value.
   */
  bindings: Map<string, string>;
  /** Runtime references emitted without a binding (render as a throw). */
  unresolved: Set<string>;
  /** Every unbound emission, in order (callers diff its length per step). */
  unresolvedLog: string[];
  /** True when emitted code calls `cairnSplice` / `cairnUnresolvedSplice`. */
  splice: boolean;
  unresolvedHelper: boolean;
  /**
   * Runtime sources the runner splices at the current emission point;
   * undefined means all (steps). Outcomes narrow it: `cairn run` compares
   * text/url/count/network needles with the raw `${…}` text.
   */
  spliceSources?: ReadonlySet<RuntimeRefSource>;
  /** References kept literal because of `spliceSources`, in order. */
  literalLog: string[];
}

export function newRefUsage(): RefUsage {
  return {
    envNames: new Set(),
    varNames: new Set(),
    runToken: false,
    bindings: new Map(),
    unresolved: new Set(),
    unresolvedLog: [],
    splice: false,
    unresolvedHelper: false,
    literalLog: [],
  };
}

/** Parse options for an emission point, honoring `usage.spliceSources`. */
function usageParseOptions(
  usage: RefUsage,
  opts: TemplateParseOptions = {},
): TemplateParseOptions {
  if (opts.runtimeRefs === false || !usage.spliceSources) return opts;
  return {
    ...opts,
    sources: usage.spliceSources,
    onLiteralRef: (ref) => usage.literalLog.push(ref),
  };
}

/** A safe JS identifier for a user-provided name. */
export function toIdent(name: string): string {
  const cleaned = name.replaceAll(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function escapeTemplateLiteral(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
}

/** Source expression for one non-literal template part. */
function partExpr(
  p: Exclude<TemplatePart, { kind: "lit" }>,
  usage: RefUsage,
): string {
  if (p.kind === "env") {
    usage.envNames.add(p.name);
    return `process.env.${p.name} ?? ""`;
  }
  if (p.kind === "var") {
    usage.varNames.add(p.name);
    return toIdent(p.name);
  }
  if (p.kind === "runToken") {
    usage.runToken = true;
    return `RUN_TOKEN`;
  }
  const binding = usage.bindings.get(runtimeRefKey(p.source, p.name));
  if (binding) {
    usage.splice = true;
    return `cairnSplice(${binding}, ${JSON.stringify(p.path)})`;
  }
  usage.unresolved.add(p.ref);
  usage.unresolvedLog.push(p.ref);
  usage.unresolvedHelper = true;
  return `cairnUnresolvedSplice(${JSON.stringify(p.ref)})`;
}

/**
 * Emit a string as a source expression: a JSON literal when purely literal,
 * otherwise a template literal splicing late-bound references.
 */
export function emitStr(
  s: string,
  usage: RefUsage,
  opts: TemplateParseOptions = {},
): string {
  const parts = parseTemplateValue(s, usageParseOptions(usage, opts));
  if (parts.length === 1 && parts[0]!.kind === "lit") {
    return JSON.stringify(s);
  }
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.kind === "var") {
    usage.varNames.add(only.name);
    return toIdent(only.name);
  }
  let out = "`";
  for (const p of parts) {
    if (p.kind === "lit") out += escapeTemplateLiteral(p.text);
    else out += `\${${partExpr(p, usage)}}`;
  }
  return `${out}\``;
}

/**
 * Emit any JSON-shaped value (string/number/boolean/null/array/object) as a
 * source expression, routing every nested string through emitStr so
 * late-bound references survive inside objects (e.g. verifier fixtures).
 */
export function emitValue(v: unknown, usage: RefUsage): string {
  if (typeof v === "string") return emitStr(v, usage);
  if (v === null || typeof v === "number" || typeof v === "boolean") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map((x) => emitValue(x, usage)).join(", ")}]`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${JSON.stringify(k)}: ${emitValue(val, usage)}`,
    );
    return entries.length === 0 ? `{}` : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Emit a text needle with Cairntrace's rendered-text normalization
 * (whitespace collapsed, case-insensitive unless `caseSensitive`).
 *
 * A purely literal needle is normalized at export time. A needle carrying any
 * late-bound part is normalized AT RUN TIME: normalizing first would lowercase
 * the sentinel itself (`__cairn_var_ref__x__`), which then no longer matches
 * the sentinel grammar and leaks into the generated source.
 */
export function emitNormalizedText(
  s: string,
  caseSensitive: boolean,
  usage: RefUsage,
): string {
  const parts = parseTemplateValue(s, usageParseOptions(usage));
  if (parts.every((p) => p.kind === "lit")) {
    return JSON.stringify(normalizeTextForMatching(s, caseSensitive));
  }
  return `String(${emitStr(s, usage)}).replace(/\\s+/g, " ").trim()${
    caseSensitive ? "" : ".toLowerCase()"
  }`;
}

const REGEX_ESCAPE_CALL = '.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")';

function escapeRegexLiteral(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Emit a RegExp SOURCE expression matching `s` literally, wrapped by the given
 * raw regex prefix/suffix (e.g. `^` / `$`). Late-bound parts are escaped at
 * run time so a spliced value containing regex metacharacters still matches
 * literally.
 */
export function emitEscapedRegexSource(
  prefix: string,
  s: string,
  suffix: string,
  usage: RefUsage,
): string {
  const parts = parseTemplateValue(s, usageParseOptions(usage));
  if (parts.every((p) => p.kind === "lit")) {
    return JSON.stringify(prefix + escapeRegexLiteral(s) + suffix);
  }
  const pieces: string[] = [];
  if (prefix) pieces.push(JSON.stringify(prefix));
  for (const p of parts) {
    if (p.kind === "lit") {
      if (p.text) pieces.push(JSON.stringify(escapeRegexLiteral(p.text)));
    } else {
      pieces.push(`String(${partExpr(p, usage)})${REGEX_ESCAPE_CALL}`);
    }
  }
  if (suffix) pieces.push(JSON.stringify(suffix));
  return pieces.join(" + ");
}

/** True when a string references a secret / unset env sentinel. */
export function hasSecretSentinel(s: string): boolean {
  return SECRET_REF_SENTINEL.test(s);
}

/**
 * Human-readable rendering of sentinels for COMMENTS and docs-like output
 * (README, global-setup notes). Never use for code — emitStr owns code.
 */
export function humanizeSentinels(s: string): string {
  return s
    .replaceAll(/__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__/gi, "process.env.$1")
    .replaceAll(/__CAIRN_RUN_TOKEN__/gi, "RUN_TOKEN")
    .replaceAll(/__CAIRN_VAR_REF__([A-Za-z0-9_]+)__/gi, "vars.$1")
    .replaceAll(/__CAIRN_[A-Z_]+__/gi, "<late-bound>");
}

/** Runtime-ref binding keys (`requests:x`, `evals:y`, `artifacts:z`) used anywhere in `value`. */
export function collectRuntimeRefKeys(
  value: unknown,
  into = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(RUNTIME_REF_RE)) {
      if (m[1] !== undefined) {
        into.add(runtimeRefKey(m[1] as RuntimeRefSource, m[2]!));
      } else if (m[3] !== undefined) {
        into.add(runtimeRefKey("artifacts", m[3]));
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectRuntimeRefKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectRuntimeRefKeys(item, into);
  }
  return into;
}

export interface LateBoundLeak {
  /** The surviving sentinel text, e.g. `__cairn_var_ref__name__`. */
  match: string;
  /** 1-based line number in the generated source. */
  line: number;
  /** Nearest enclosing step/outcome id, when one can be located. */
  stepId?: string;
}

/**
 * Locate the first late-bound sentinel that survived emission. Any hit is an
 * exporter bug or an unsupported construct: callers fail the export instead of
 * writing a test that would type or match the sentinel text literally.
 */
export function findLateBoundLeak(source: string): LateBoundLeak | undefined {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = LEAK_RE.exec(lines[i]!);
    if (!m) continue;
    const leak: LateBoundLeak = { match: m[0], line: i + 1 };
    for (let j = i; j >= 0; j--) {
      const line = lines[j]!;
      const stepCall = /test\.step\((["'])((?:\\.|(?!\1).)*)\1/.exec(line);
      const stepComment = /^\s*\/\/ step: (.+?)(?: \(action\))?$/.exec(line);
      const found = stepCall?.[2] ?? stepComment?.[1];
      if (found) {
        leak.stepId = found;
        break;
      }
    }
    return leak;
  }
  return undefined;
}

/** Error raised when generated source would carry a late-bound sentinel. */
export class LateBoundLeakError extends Error {
  readonly file: string;
  readonly leak: LateBoundLeak;
  constructor(file: string, leak: LateBoundLeak, specName?: string) {
    const context = [
      ...(specName ? [`spec ${specName}`] : []),
      ...(leak.stepId ? [`step ${leak.stepId}`] : []),
    ];
    super(
      `export would leak unresolved late-bound reference ${JSON.stringify(
        leak.match,
      )} into ${file}:${leak.line}${
        context.length > 0 ? ` (${context.join(", ")})` : ""
      }; ${humanizeSentinels(leak.match)} must be emitted as a runtime reference, so the export was refused instead of writing a test that would match the sentinel text literally`,
    );
    this.name = "LateBoundLeakError";
    this.file = file;
    this.leak = leak;
  }
}

/** Throw LateBoundLeakError when `source` still carries a sentinel. */
export function assertNoLateBoundLeak(
  source: string,
  file: string,
  specName?: string,
): void {
  const leak = findLateBoundLeak(source);
  if (leak) throw new LateBoundLeakError(file, leak, specName);
}
