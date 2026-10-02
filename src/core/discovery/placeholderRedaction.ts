import type { Document } from "yaml";
import type { ArtifactRedactor } from "../artifacts/ArtifactWriter";

/**
 * Session journals hold recorded steps, and a recorded step names its
 * secrets as placeholders: `open: …/cb?token=${secrets.CB_TOKEN}`,
 * `headers: { Authorization: "Bearer ${env.API_TOKEN}" }`. The artifact
 * redactor's heuristics (token-like query parameters, sensitive keys) would
 * replace those values with `[redacted]` even though they hold no secret,
 * and the journal could then neither resume nor export the step. This
 * wrapper keeps values made only of placeholders and redacts everything else
 * exactly as the wrapped redactor does.
 */

const TEMPLATE_SOURCE = String.raw`\$\{(?:secrets|env|vars|config|evals|requests|artifacts)\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\}`;
const TEMPLATE_RE = new RegExp(TEMPLATE_SOURCE, "g");
const HAS_TEMPLATE_RE = new RegExp(TEMPLATE_SOURCE);
const QUERY_PARAM_RE = /([?&])([^=&#\s]+)=([^&#\s]*)/g;
const KEEP_PREFIX = "__cairn_keep_";
const KEEP_VALUE_RE = /^\$\{vars\.__cairn_keep_(\d+)\}$/;
const KEEP_QUERY_RE = /\uE001(\d+)\uE001/g;
const MANGLED_QUERY_RE = /\uE001[^\uE001]*\uE001/g;

/** The marker the redactor writes in place of a value. */
export const REDACTED = "[redacted]";

/**
 * A value that names secrets without holding one: one or more placeholders
 * (no `:-default`, which could hold a literal), joined only by punctuation,
 * optionally after an auth scheme word (`Bearer ${env.X}`).
 */
export function isTemplateOnly(value: string): boolean {
  if (!HAS_TEMPLATE_RE.test(value)) return false;
  const rest = value
    .replace(TEMPLATE_RE, "\uE000")
    .replace(/^\s*[A-Za-z][A-Za-z0-9-]*\s+(?=\uE000)/, "");
  return /^[\s\uE000:._/-]*$/.test(rest);
}

/** Whether a (redacted) value holds the redaction marker anywhere. */
export function holdsRedacted(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(REDACTED);
}

function protectQuery(text: string, kept: string[]): string {
  if (!text.includes("=")) return text;
  return text.replace(
    QUERY_PARAM_RE,
    (match, separator: string, name: string, value: string) => {
      if (!isTemplateOnly(value)) return match;
      kept.push(`${name}=${value}`);
      return `${separator}\uE001${kept.length - 1}\uE001`;
    },
  );
}

function restoreQuery(text: string, kept: readonly string[]): string {
  if (!text.includes("\uE001")) return text;
  return text
    .replace(KEEP_QUERY_RE, (match, n: string) => kept[Number(n)] ?? match)
    .replace(MANGLED_QUERY_RE, REDACTED);
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}

/** `base`, except that placeholder-only values survive (see above). */
export function placeholderSafeRedactor(
  base: ArtifactRedactor,
): ArtifactRedactor {
  return {
    value: <T>(input: T): T => {
      const keptValues: string[] = [];
      const keptQueries: string[] = [];
      const protectedInput = mapStrings(input, (text) => {
        if (isTemplateOnly(text)) {
          keptValues.push(text);
          // A bare `${vars.X}` is what the redactor keeps under a sensitive
          // key; it stands in for the real value until restored.
          return `\${vars.${KEEP_PREFIX}${keptValues.length - 1}}`;
        }
        return protectQuery(text, keptQueries);
      });
      if (keptValues.length === 0 && keptQueries.length === 0) {
        return base.value(input);
      }
      return mapStrings(base.value(protectedInput), (text) => {
        const kept = KEEP_VALUE_RE.exec(text);
        if (kept) return keptValues[Number(kept[1])] ?? REDACTED;
        // A literal secret that matched part of a stand-in: over-redact.
        if (text.includes(KEEP_PREFIX)) return REDACTED;
        return restoreQuery(text, keptQueries);
      }) as T;
    },
    text: (input: string): string => {
      const kept: string[] = [];
      const protectedText = protectQuery(input, kept);
      if (kept.length === 0) return base.text(input);
      return restoreQuery(base.text(protectedText), kept);
    },
  };
}

/**
 * A YAML document with `redactValue` applied node by node: only scalars the
 * redactor changes are replaced, so comments, key order and placeholders of
 * the rest survive. Returns the input document when nothing changed.
 */
export function redactYamlDocument(
  doc: Document,
  redactValue: <T>(value: T) => T,
): Document {
  const before = doc.toJS() as unknown;
  const after = redactValue(before);
  const changes: Array<{ path: Array<string | number>; value: unknown }> = [];
  collectChanges(before, after, [], changes);
  if (changes.length === 0) return doc;
  const copy = doc.clone();
  for (const change of changes) {
    if (change.path.length === 0) return copy;
    copy.setIn(change.path, change.value);
  }
  return copy;
}

function collectChanges(
  before: unknown,
  after: unknown,
  path: Array<string | number>,
  out: Array<{ path: Array<string | number>; value: unknown }>,
): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    before.forEach((item, index) =>
      collectChanges(item, after[index], [...path, index], out),
    );
    return;
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    for (const [key, item] of Object.entries(before)) {
      collectChanges(
        item,
        (after as Record<string, unknown>)[key],
        [...path, key],
        out,
      );
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path, value: after });
  }
}
