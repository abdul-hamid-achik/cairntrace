import { Document, isMap, isSeq } from "yaml";
import type { Spec } from "../schema/spec.v1";

/**
 * What the importers share: the coverage model, secret-shaped name heuristics
 * (a typed secret must become a `${secrets.X}` placeholder, never a literal),
 * slugging, and the YAML rendering with inline TODO comments.
 */

export type ImportItemKind = "mapped" | "approximated" | "unmapped";

/** One thing the importer looked at and what it did with it. */
export interface ImportItem {
  kind: ImportItemKind;
  /** The source construct (code or trace call) in one line. */
  source: string;
  /** Why it was approximated or not mapped. */
  note?: string;
  /** Index of the step this item precedes (steps.length at the time). */
  beforeStep: number;
}

export interface ImportCoverage {
  mapped: number;
  approximated: number;
  unmapped: number;
  total: number;
}

export function summarizeCoverage(
  items: readonly ImportItem[],
): ImportCoverage {
  const count = (kind: ImportItemKind): number =>
    items.filter((item) => item.kind === kind).length;
  return {
    mapped: count("mapped"),
    approximated: count("approximated"),
    unmapped: count("unmapped"),
    total: items.length,
  };
}

/**
 * A name's words, lowercased: separators and camelCase split it
 * (`X-CSRFToken` → x csrf token, `passwordField` → password field,
 * `Mot de passe` → mot de passe). Credential words are matched against
 * whole words, never substrings: `Compass`, `passengers`, `tokenizer`,
 * `secretary` carry none.
 */
export function nameWords(name: string): string[] {
  return (
    name.match(/\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+/gu) ?? []
  ).map((word) => word.toLowerCase());
}

/** A word that alone makes a name a credential's. */
const CREDENTIAL_WORDS = new Set([
  "password",
  "passwords",
  "passwd",
  "passwort",
  "kennwort",
  "wachtwoord",
  "senha",
  "contrasena",
  "contraseña",
  "passphrase",
  "passcode",
  "pass",
  "passe",
  "pwd",
  "pw",
  "pin",
  "otp",
  "totp",
  "mfa",
  "cvv",
  "cvc",
  "jwt",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "authorization",
  "authorisation",
  "bearer",
  "cookie",
  "apikey",
  "sessionid",
  "jsessionid",
  "phpsessid",
]);
/** `token` is a credential's name when last, or followed by one of these (`token_count`, `token_type` are not). */
const TOKEN_TAIL = new Set(["value", "string", "secret", "key", "data"]);
/** `key` is a credential's name after one of these (`api_key`, `privateKey`). */
const KEY_HEAD = new Set([
  "api",
  "auth",
  "private",
  "secret",
  "access",
  "signing",
  "client",
  "encryption",
]);
/** `session` is a credential's name before one of these (`session_id`, not `x-session-locale`). */
const SESSION_TAIL = new Set(["id", "token", "key", "secret", "cookie"]);

function credentialWordAt(words: readonly string[], i: number): boolean {
  const word = words[i]!;
  const next = words[i + 1];
  const last = i === words.length - 1;
  if (CREDENTIAL_WORDS.has(word)) return true;
  if (word === "token") return last || TOKEN_TAIL.has(next!);
  if (word === "key") return i > 0 && KEY_HEAD.has(words[i - 1]!);
  if (word === "session") return next !== undefined && SESSION_TAIL.has(next);
  if (word === "time") return i > 0 && words[i - 1] === "one";
  return false;
}

/** Names that carry a credential: a typed value or header there is a secret. */
export function looksSecretName(name: string | undefined): boolean {
  if (name === undefined) return false;
  const words = nameWords(name);
  return words.some((_, i) => credentialWordAt(words, i));
}

/**
 * A body key, query or path name that carries a credential: a secret-shaped
 * name or a credential header word (`auth`, `csrf`, a `session` that
 * names one). `signature` is a credential only as a header name: a body
 * `signature` is as often an e-mail sign-off (its value's shape decides).
 */
export function looksCredentialKey(name: string | undefined): boolean {
  if (name === undefined || name === "") return false;
  if (looksSecretName(name)) return true;
  const words = nameWords(name);
  return words.some(
    (word, i) =>
      word === "auth" ||
      word === "csrf" ||
      word === "xsrf" ||
      (word === "session" && i === words.length - 1),
  );
}

const JWT_RE = /^eyJ[\w-]{2,}(?:\.[\w-]*){2,4}$/;

/**
 * A value whose shape alone says credential, whatever its name: a JWT, a long
 * hex digest (reset links, API keys) or a long mixed-case base64 token.
 */
export function looksSecretValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  if (v.length < 16) return false;
  if (JWT_RE.test(v)) return true;
  if (/^[0-9a-f]{32,}$/i.test(v)) return true;
  return (
    /^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(v) &&
    /[A-Z]/.test(v) &&
    /[a-z]/.test(v) &&
    /\d/.test(v)
  );
}

/**
 * Credential-shaped substrings of free text: JWTs, and long hex digests
 * unless `hexDigests` is false (a commit SHA, a request id or a record id
 * is hex too: the trace importer, whose final pass replaces every found value
 * in steps, only takes a hex value where its context says credential).
 */
export function secretShapedSubstrings(
  text: string,
  opts: { hexDigests?: boolean } = {},
): string[] {
  return [
    ...text.matchAll(/eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g),
    ...(opts.hexDigests === false
      ? []
      : text.matchAll(/(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi)),
  ].map((m) => m[0]);
}

/** Header (or key) words that make its value a credential besides a credential's name. */
const CREDENTIAL_HEADER_WORDS = new Set([
  "auth",
  "csrf",
  "xsrf",
  "signature",
  "sig",
]);

/**
 * Header names whose values are credentials and must never be written: a
 * credential's name, `auth` / `csrf` / `xsrf` / `signature` words, and a
 * `session` that names one (`x-session`, `x-session-id`; not
 * `x-session-locale`).
 */
export function isCredentialHeader(name: string): boolean {
  if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name))
    return true;
  const words = nameWords(name);
  return words.some(
    (word, i) =>
      credentialWordAt(words, i) ||
      CREDENTIAL_HEADER_WORDS.has(word) ||
      (word === "session" && i === words.length - 1),
  );
}

/**
 * Headers that carry an identifier, never a credential (`x-request-id`,
 * `traceparent`, `etag`): a hex value there is a request / trace id, not a
 * key. A credential's name still wins.
 */
export function isIdentifierHeader(name: string): boolean {
  if (
    /^(traceparent|tracestate|baggage|etag|if-none-match|if-match)$/i.test(name)
  )
    return true;
  const words = nameWords(name);
  return (
    words.some((word) => /^(request|correlation|trace|span)id$/.test(word)) ||
    (words.at(-1) === "id" &&
      words.some((word) =>
        [
          "request",
          "correlation",
          "trace",
          "span",
          "transaction",
          "message",
        ].includes(word),
      ))
  );
}

/** `Password` / `x-api-key` / `login.passwordField` → `PASSWORD` / `X_API_KEY` / `LOGIN_PASSWORDFIELD`. */
export function placeholderKey(hint: string, fallback: string): string {
  const key = hint
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 48);
  return /^[A-Z]/.test(key) ? key : fallback;
}

/**
 * A number under a credential key (`pin: 482913`) becomes a
 * `${secrets.X}` reference, which always resolves to text: the request
 * sends `"482913"`. Cairn has no typed secret reference, so the importer
 * says so instead of silently changing the type.
 */
export function numberAsSecretNote(hint: string): string {
  return `${hint} was a number in the recording; a \${secrets.X} reference is always text, so the request sends it as a string — check the API accepts that`;
}

export function secretPlaceholder(hint: string): string {
  return `\${secrets.${placeholderKey(hint, "SECRET")}}`;
}

export function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withLetter = /^[a-z]/.test(s) ? s : `imported_${s}`;
  return withLetter.slice(0, 80) || "imported_playwright";
}

/** A valid snake_case id from free text, or undefined when nothing usable. */
export function snakeId(text: string): string | undefined {
  const id = slug(text)
    .replace(/^imported_/, "")
    .slice(0, 60);
  return /^[a-z][a-z0-9_]*$/.test(id) ? id : undefined;
}

export interface RenderSpecOptions {
  generator: string;
  sourceLabel?: string;
  /** TODOs not tied to a step position (header). */
  headerTodos: string[];
  /** Approximations, one comment line each. */
  approximations: string[];
  /** Extra header lines (without the leading `# `). */
  headerNotes?: string[];
  items: readonly ImportItem[];
}

/** YAML for the spec: header comments + inline `# TODO:` before the step an unmapped item precedes. */
export function renderSpecYaml(spec: Spec, opts: RenderSpecOptions): string {
  const coverage = summarizeCoverage(opts.items);
  const header = [
    `# Generated by \`${opts.generator}\`.`,
    ...(opts.sourceLabel ? [`# Source: ${opts.sourceLabel}`] : []),
    `# Coverage: ${coverage.mapped} mapped, ${coverage.approximated} approximated, ${coverage.unmapped} unmapped.`,
    "# Review TODO comments before treating this as a finished behavioral spec.",
    ...(opts.headerNotes ?? []).map((note) => `# ${note}`),
    ...opts.approximations.map((note) => `# APPROXIMATED: ${oneLine(note)}`),
    ...opts.headerTodos.map((todo) => `# TODO: ${oneLine(todo)}`),
    "",
  ].join("\n");

  const doc = new Document(spec);
  const stepsNode = doc.get("steps", true);
  const unmapped = opts.items.filter((item) => item.kind === "unmapped");
  if (unmapped.length > 0 && isSeq(stepsNode)) {
    const byStep = new Map<number, string[]>();
    for (const item of unmapped) {
      const at = Math.min(item.beforeStep, stepsNode.items.length);
      const list = byStep.get(at) ?? [];
      list.push(
        ` TODO: ${oneLine(item.source)}${
          item.note ? ` (${oneLine(item.note)})` : ""
        }`,
      );
      byStep.set(at, list);
    }
    const trailing: string[] = [];
    for (const [at, lines] of byStep) {
      const node = stepsNode.items[at];
      if (node !== undefined && typeof node === "object" && node !== null) {
        (node as { commentBefore?: string }).commentBefore = lines.join("\n");
      } else {
        trailing.push(...lines);
      }
    }
    if (trailing.length > 0 && isMap(doc.contents)) {
      const pair = doc.contents.items.find(
        (p) => (p.key as { value?: unknown }).value === "outcomes",
      );
      if (pair && typeof pair.key === "object" && pair.key !== null) {
        (pair.key as { commentBefore?: string }).commentBefore =
          trailing.join("\n");
      }
    }
  } else if (unmapped.length > 0) {
    // No steps section to attach to: keep the TODOs in the header.
    return (
      header +
      unmapped
        .map(
          (item) =>
            `# TODO: ${oneLine(item.source)}${
              item.note ? ` (${oneLine(item.note)})` : ""
            }\n`,
        )
        .join("") +
      doc.toString({
        indent: 2,
        lineWidth: 100,
        defaultStringType: "PLAIN",
        defaultKeyType: "PLAIN",
      })
    );
  }
  return (
    header +
    doc.toString({
      indent: 2,
      lineWidth: 100,
      defaultStringType: "PLAIN",
      defaultKeyType: "PLAIN",
    })
  );
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * Where a credential found in a URL goes: returns its replacement text
 * (`${secrets.X}` or `<redacted>`). `scrubElsewhere: false` marks a value
 * (a URL user name) that is too often a plain word to scrub from other text.
 */
export type SecretSink = (
  hint: string,
  value: string,
  what: string,
  scrubElsewhere?: boolean,
) => string;

/**
 * A URL with every credential it carries handed to `sink`: user:password,
 * query and fragment parameters with a credential name or a credential-shaped
 * value, credential-shaped path segments, and a token-like segment after a
 * credential-named one (`/reset-password/<token>`). Relative URLs keep
 * their shape; nothing is normalized.
 */
export function redactUrlCredentials(url: string, sink: SecretSink): string {
  const abs = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^]*)$/i.exec(url);
  let head = "";
  let rest = url;
  let host = "url";
  if (abs) {
    let authority = abs[2]!;
    rest = abs[3]!;
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      authority = authority.slice(at + 1);
      host = authority.split(/[.:]/)[0] || "url";
      const colon = userinfo.indexOf(":");
      const user = colon < 0 ? userinfo : userinfo.slice(0, colon);
      const pass = colon < 0 ? "" : userinfo.slice(colon + 1);
      const parts = [
        user
          ? sink(
              `${host}_user`,
              safeDecode(user),
              "URL user name",
              // a user name is often a plain word; a lone one is a token
              !pass || looksSecretValue(safeDecode(user)),
            )
          : "",
        ...(pass
          ? [sink(`${host}_password`, safeDecode(pass), "URL password")]
          : []),
      ];
      authority = `${parts.join(":")}@${authority}`;
    }
    head = `${abs[1]!}${authority}`;
  }
  const hashAt = rest.indexOf("#");
  const beforeHash = hashAt < 0 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt < 0 ? undefined : rest.slice(hashAt + 1);
  const qAt = beforeHash.indexOf("?");
  const path = qAt < 0 ? beforeHash : beforeHash.slice(0, qAt);
  const query = qAt < 0 ? undefined : beforeHash.slice(qAt + 1);

  const segments = path.split("/");
  const outPath = segments
    .map((seg, i) => {
      const value = safeDecode(seg);
      const prev = i > 0 ? safeDecode(segments[i - 1]!) : "";
      const tokenAfterName = i > 0 && tokenAfterCredentialName(prev, seg);
      if (!looksSecretPathSegment(value) && !tokenAfterName) return seg;
      return sink(
        `${prev && looksCredentialKey(prev) ? prev : "path"}_token`,
        value,
        "a credential-shaped path segment",
      );
    })
    .join("/");
  const params = (text: string, where: string): string =>
    text
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return pair;
        const name = safeDecode(pair.slice(0, eq));
        const value = safeDecode(pair.slice(eq + 1));
        if (!value || (!looksCredentialKey(name) && !looksSecretValue(value)))
          return pair;
        return `${pair.slice(0, eq)}=${sink(name, value, `${where} value of ${name}`)}`;
      })
      .join("&");
  const outQuery = query === undefined ? "" : `?${params(query, "query")}`;
  let outFragment = "";
  if (fragment !== undefined) {
    if (fragment.includes("=")) {
      outFragment = `#${params(fragment, "fragment")}`;
    } else if (looksSecretValue(safeDecode(fragment))) {
      outFragment = `#${sink("fragment_token", safeDecode(fragment), "a credential-shaped fragment")}`;
    } else {
      outFragment = `#${fragment}`;
    }
  }
  return `${head}${outPath}${outQuery}${outFragment}`;
}

/** Words of a path segment after which the next segment is a credential (`/reset-password/<token>`, `/verify/<code>`). */
const PATH_CONTEXT_WORDS = new Set([
  "reset",
  "verify",
  "verification",
  "confirm",
  "activate",
  "activation",
  "invite",
  "invitation",
  "magic",
  "unlock",
  "recover",
  "recovery",
  "auth",
  "login",
  "signin",
]);

/**
 * A path segment that makes the next one a credential: a credential's name
 * (`reset-password`, `token`) or a one-time-link word (`reset`, `verify`,
 * `invite`). A plural collection (`/api/tokens/<id>`) names records.
 */
export function credentialPathContext(prev: string): boolean {
  const words = nameWords(safeDecode(prev));
  return (
    words.some((word) => PATH_CONTEXT_WORDS.has(word)) ||
    looksSecretName(safeDecode(prev))
  );
}

/** `/reset-password/<token>`: a token-like segment after a credential-context one. */
export function tokenAfterCredentialName(prev: string, seg: string): boolean {
  const value = safeDecode(seg);
  return (
    credentialPathContext(prev) &&
    /^[\w.~-]{8,}$/.test(value) &&
    /\d/.test(value)
  );
}

/**
 * A path segment whose shape alone says credential: a JWT or a long
 * mixed-case base64 token. A hex-only segment is a commit SHA, a digest or
 * a record id (`/commit/<sha>`, `/avatar/<md5>`) unless the segment before
 * makes it a token (`tokenAfterCredentialName`).
 */
export function looksSecretPathSegment(seg: string): boolean {
  const value = safeDecode(seg).trim();
  if (/^[0-9a-f]+$/i.test(value)) return false;
  return looksSecretValue(value);
}

export function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
