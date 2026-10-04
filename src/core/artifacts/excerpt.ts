import { isSensitiveName, looksLikeSecretValue } from "../catalog/mask";

/**
 * Credential-safe excerpts of runtime values for error messages (request
 * bodies, captures, matrix combinations).
 *
 * Literal redaction only matches a registered secret when it appears whole,
 * and key-based redaction never looks inside a string, so a plain
 * `JSON.stringify(body).slice(0, n)` can leave a token's prefix in a step
 * error — and from there in run.json, events.ndjson and report.html. An
 * excerpt therefore:
 *
 *   - masks every value under a credential-like key (`[redacted]`);
 *   - shows nested strings that are long or token-shaped by length only
 *     (`<string, N chars>`);
 *   - never cuts inside a JSON string, so whatever survives is whole and the
 *     artifact redactor can still find a registered value in it;
 *   - keeps the words of a plain-text body, minus token-shaped ones, cut at
 *     a word boundary.
 */

const MASK = "[redacted]";
/** Nested strings longer than this are shown by length only. */
const MAX_EXCERPT_STRING_CHARS = 64;
const MAX_DEPTH = 8;
/** A run of id characters long enough to be a token in free text. */
const TOKEN_RUN_RE = /[A-Za-z0-9_\-+/=.~]{20,}/g;

export function safeExcerpt(value: unknown, max = 200): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") return textExcerpt(value, max);
  let text: string | undefined;
  try {
    text = JSON.stringify(maskValue(value, 0));
  } catch {
    text = undefined;
  }
  if (text === undefined) return textExcerpt(String(value), max);
  return cutOutsideStrings(text, max);
}

function shortString(text: string): string {
  return text.length > MAX_EXCERPT_STRING_CHARS || looksLikeSecretValue(text)
    ? `<string, ${text.length} chars>`
    : text;
}

function maskValue(node: unknown, depth: number): unknown {
  if (typeof node === "string") return shortString(node);
  if (node === null || typeof node !== "object") return node;
  if (depth >= MAX_DEPTH) return "…";
  if (Array.isArray(node))
    return node.map((item) => maskValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(node)) {
    out[key] =
      isSensitiveName(key) && item !== null && item !== undefined
        ? MASK
        : maskValue(item, depth + 1);
  }
  return out;
}

/**
 * Free text (a non-JSON body), quoted like JSON: token-shaped words masked,
 * cut at a word boundary.
 */
function textExcerpt(text: string, max: number): string {
  const masked = text.replace(TOKEN_RUN_RE, (word) =>
    looksLikeSecretValue(word) ? `<${word.length} chars>` : word,
  );
  if (masked.length <= max) return JSON.stringify(masked);
  const head = masked.slice(0, max);
  const boundary = Math.max(
    head.lastIndexOf(" "),
    head.lastIndexOf("\n"),
    head.lastIndexOf("\t"),
    head.lastIndexOf(">"),
    head.lastIndexOf(","),
  );
  return `${JSON.stringify(
    boundary > 0 ? head.slice(0, boundary + 1).trimEnd() : head,
  )}…`;
}

/** Cut JSON text at `max` characters or before, never inside a string literal. */
function cutOutsideStrings(text: string, max: number): string {
  if (text.length <= max) return text;
  let inString = false;
  let escaped = false;
  let safe = 0;
  for (let i = 0; i < max; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        safe = i + 1;
      }
    } else if (ch === '"') {
      inString = true;
    } else {
      safe = i + 1;
    }
  }
  return `${text.slice(0, safe)}…`;
}
