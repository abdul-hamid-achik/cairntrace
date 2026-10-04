import {
  createArtifactRedactor,
  isSensitiveEnvKey,
} from "../artifacts/redaction";

type Scalar = string | number | boolean;

const MASK = "[redacted]";

/** Well-known credential prefixes (cloud keys, VCS tokens, chat tokens, …). */
const TOKEN_PREFIX_RE =
  /^(?:sk|pk|rk)_(?:live|test)_|^(?:ghp|gho|ghu|ghs|ghr)_|^github_pat_|^glpat-|^xox[abeoprs]-|^AKIA[0-9A-Z]{12}|^AIza[0-9A-Za-z_-]{20}|^(?:Bearer|Basic)\s+\S/;
const JWT_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
/** One opaque run of 32+ id characters mixing letters and digits. */
const OPAQUE_RE = /^[A-Za-z0-9_-]{32,}$/;
const BASE64_RE = /^[A-Za-z0-9+/]{40,}={0,2}$/;
/** A bare `${env.X}` / `${secrets.X}` (no `:-default`, which could hold a literal). */
const PLACEHOLDER_ONLY_RE =
  /^\s*\$\{(?:env|secrets)\.[A-Za-z_][A-Za-z0-9_]*\}\s*$/;
/** The literal fallback of a `${env.X:-default}` / `${secrets.X:-default}`. */
const PLACEHOLDER_DEFAULT_RE =
  /\$\{(?:env|secrets)\.[A-Za-z_][A-Za-z0-9_]*:-([^}]*)\}/g;

/**
 * Whole words of a var name that mark it as a credential. Short, ambiguous
 * ones (`otp`, `pwd`, `pw`, `pass`, `jwt`) only count as whole words, so
 * `footprint`, `cwdPath`, `bypass` or `compass` stay visible; plurals
 * (`tokens`, `cookies`) count too.
 */
const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "pass",
  "pw",
  "pword",
  "pwd",
  "passphrase",
  "passcode",
  "secret",
  "token",
  "credential",
  "otp",
  "cookie",
  "authorization",
  "apikey",
  "jwt",
  "bearer",
]);
/** Substrings the redactor's key check matches anywhere that count here only as whole words. */
const WHOLE_WORD_ONLY_RE = /otp/gi;

/**
 * True when a var NAME marks a credential: a credential word (`adminPassword`,
 * `api_key`, `SESSION_TOKEN`, `accessTokens`), or anything the artifact
 * redactor's key check flags (`DBPASSWORD`, `SECRETKEY`, `codeVerifier`,
 * `samlAssertion`), except that `otp` must be a whole word so `footprint`
 * is not mistaken for an OTP.
 */
export function isSensitiveName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (SENSITIVE_WORDS.has(word) || SENSITIVE_WORDS.has(singular(word))) {
      return true;
    }
    const next = words[i + 1];
    if (
      (next === "key" || next === "keys") &&
      (word === "api" || word === "private")
    ) {
      return true;
    }
  }
  return isSensitiveEnvKey(name.replace(WHOLE_WORD_ONLY_RE, "_"));
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * True when a literal value reads like a credential: a known token prefix,
 * a JWT, or a long opaque letter+digit string, also as the literal default
 * of a `${env.X:-default}` placeholder. Paths, selectors, URLs and prose are
 * left alone (24-hex database ids stay visible).
 */
export function looksLikeSecretValue(value: string): boolean {
  for (const m of value.matchAll(PLACEHOLDER_DEFAULT_RE)) {
    if (looksLikeSecretValue(m[1]!)) return true;
  }
  const v = value.trim();
  if (TOKEN_PREFIX_RE.test(v) || JWT_RE.test(v)) return true;
  if (OPAQUE_RE.test(v)) return /[0-9]/.test(v) && /[A-Za-z]/.test(v);
  // Base64 also matches paths (`/`): demand mixed case and digits, no leading `/`.
  if (BASE64_RE.test(v) && !v.startsWith("/")) {
    return /[0-9]/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v);
  }
  return false;
}

export interface Masker {
  /**
   * A catalog-safe rendering of an authored value. A placeholder-only value
   * (`${env.X}`, `${secrets.X}`) is kept as written — it never holds the
   * secret — while a literal under a credential-like name, or one that looks
   * like a token (also as a `${env.X:-default}` fallback), becomes
   * `[redacted]`. URL userinfo and known secret values (sensitive env vars,
   * values registered this process) are scrubbed.
   */
  value(name: string, value: Scalar): { value: Scalar; masked?: true };
  /** Scrub URL userinfo and known secret values from free text. */
  text(text: string): string;
}

export function createMasker(): Masker {
  const redactor = createArtifactRedactor(undefined);
  return {
    value(name, value) {
      if (typeof value !== "string") {
        return isSensitiveName(name)
          ? { value: MASK, masked: true }
          : { value };
      }
      if (
        !PLACEHOLDER_ONLY_RE.test(value) &&
        (isSensitiveName(name) || looksLikeSecretValue(value))
      ) {
        return { value: MASK, masked: true };
      }
      const scrubbed = redactor.text(value);
      return scrubbed === value ? { value } : { value: scrubbed, masked: true };
    },
    text: (text) => redactor.text(text),
  };
}
