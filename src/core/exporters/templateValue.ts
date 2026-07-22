/**
 * Structured string emission for generated sources.
 *
 * The spec parser resolves `${secrets.X}` / unset-`${env.X}` / `${run.token}`
 * to SENTINELS (see ParseOptions.secretRef and the exporter's runtime option).
 * This module is the single place that understands those sentinels: every
 * user-derived string is emitted through emitStr()/emitValue(), which returns
 * either a plain JSON string literal or a template literal splicing
 * `process.env.X` / `RUN_TOKEN` — so secret VALUES never land in generated
 * files, exported tests stay re-runnable, and no post-hoc regex over the
 * generated source is ever needed.
 */

export const SECRET_REF_SENTINEL = /__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__/;
export const RUN_TOKEN_SENTINEL = "__CAIRN_RUN_TOKEN__";

const SPLIT_RE = /__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__|__CAIRN_RUN_TOKEN__/g;

export type TemplatePart =
  | { kind: "lit"; text: string }
  | { kind: "env"; name: string }
  | { kind: "runToken" };

/** Split a resolved spec string into literal / late-bound reference parts. */
export function parseTemplateValue(s: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of s.matchAll(SPLIT_RE)) {
    if (m.index > last)
      parts.push({ kind: "lit", text: s.slice(last, m.index) });
    if (m[1] !== undefined) parts.push({ kind: "env", name: m[1] });
    else parts.push({ kind: "runToken" });
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
  runToken: boolean;
}

export function newRefUsage(): RefUsage {
  return { envNames: new Set(), runToken: false };
}

/**
 * Emit a string as a source expression: a JSON literal when purely literal,
 * otherwise a template literal splicing late-bound references.
 */
export function emitStr(s: string, usage: RefUsage): string {
  const parts = parseTemplateValue(s);
  if (parts.length === 1 && parts[0]!.kind === "lit") {
    return JSON.stringify(s);
  }
  let out = "`";
  for (const p of parts) {
    if (p.kind === "lit") {
      out += p.text
        .replaceAll("\\", "\\\\")
        .replaceAll("`", "\\`")
        .replaceAll("${", "\\${");
    } else if (p.kind === "env") {
      usage.envNames.add(p.name);
      out += `\${process.env.${p.name} ?? ""}`;
    } else {
      usage.runToken = true;
      out += `\${RUN_TOKEN}`;
    }
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

/** True when a string still carries an unresolved late-bound sentinel. */
export function hasRefSentinel(s: string): boolean {
  return SECRET_REF_SENTINEL.test(s) || s.includes(RUN_TOKEN_SENTINEL);
}
