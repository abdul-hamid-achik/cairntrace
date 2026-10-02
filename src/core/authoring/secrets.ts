import { isSensitiveEnvKey } from "../artifacts/redaction";
import {
  secretPlaceholders,
  type SecretPlaceholder,
} from "../discovery/stepRecorder";

/**
 * Secret hygiene shared by convention exports and `cairn spec lint`: a spec
 * holds `${secrets.X}` / `${env.X}` placeholders, never the values.
 */

/** Words that mark an input as a credential field. */
const PASSWORD_WORDS =
  /\b(?:pass(?:word|wd|phrase|code)|pwd|pin\s*code|pincode|otp|one[\s-]*time[\s-]*(?:code|password)|secret|api[\s_-]*key|token|2fa|mfa)\b/i;
/** A bare PIN field (`PIN`, `Pin:`), not the verb ("Pin to top"). */
const PIN_ONLY = /^\s*pin\s*[*:]?\s*$/i;
/**
 * A trailing word that makes the field about a credential rather than the
 * credential itself: "Token name", "API key name", "Password hint".
 */
const NOT_THE_SECRET =
  /\b(?:name|label|title|hint|reminder|question|description|note|id|prefix|type|scope|scopes|expiry|expiration|expires|length|count|policy|strength|rules|requirements)\s*[*:]?\s*$/i;
/** CSS that targets a password input. */
const PASSWORD_SELECTOR =
  /type\s*=\s*["']?password|[#.[_-](?:password|passwd|pwd|passcode)\b|name\s*=\s*["']?(?:password|passwd|pwd)/i;

/**
 * True when a fill/type target looks like a password-type field: its
 * accessible name, label, text or test id names a credential, or its CSS
 * selector targets `type=password` / a `#password` input. Heuristic (the
 * recorded step does not carry the input type); a false positive only asks
 * for a placeholder.
 */
export function looksLikePasswordField(locator: unknown): boolean {
  if (!locator || typeof locator !== "object") return false;
  const l = locator as Record<string, unknown>;
  for (const key of ["name", "label", "text", "testid", "testId"]) {
    const value = l[key];
    if (typeof value !== "string") continue;
    const words = spaced(value);
    if (PIN_ONLY.test(words)) return true;
    if (PASSWORD_WORDS.test(words) && !NOT_THE_SECRET.test(words)) {
      return true;
    }
  }
  const selector = l["selector"];
  return typeof selector === "string" && PASSWORD_SELECTOR.test(selector);
}

/** `currentPassword` / `current_password` → `current Password` for \b tests. */
function spaced(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
}

/** True when a value is (or holds) a `${…}` placeholder rather than a literal. */
export function isPlaceholder(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

/**
 * Known secret values with their placeholders: config secrets names served
 * by the environment (`${secrets.X}`) and secret-looking environment
 * variables (`${env.X}`). Longest first.
 */
export function knownSecrets(
  env: Record<string, string | undefined>,
  secretNames: Iterable<string> = [],
): SecretPlaceholder[] {
  return secretPlaceholders(env, {
    secretNames,
    isSensitiveKey: isSensitiveEnvKey,
  });
}

/** One literal replaced by its placeholder. */
export interface SecretReplacement {
  /** Dotted location, e.g. `steps[3].fill.value`. */
  where: string;
  placeholder: string;
}

/**
 * Replace every known secret literal inside string values of `value` by its
 * placeholder. Returns the new value and where replacements happened.
 */
export function placeholderSecrets<T>(
  value: T,
  secrets: readonly SecretPlaceholder[],
  where = "",
): { value: T; replaced: SecretReplacement[] } {
  const replaced: SecretReplacement[] = [];
  const map = (node: unknown, path: string): unknown => {
    if (typeof node === "string") {
      let out = node;
      for (const secret of secrets) {
        if (out.includes(secret.value)) {
          out = out.split(secret.value).join(secret.placeholder);
          replaced.push({ where: path, placeholder: secret.placeholder });
        }
      }
      return out;
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => map(item, `${path}[${i}]`));
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [
          k,
          map(v, path ? `${path}.${k}` : k),
        ]),
      );
    }
    return node;
  };
  return { value: map(value, where) as T, replaced };
}

/** The locator + typed value of a fill/type step (undefined for others). */
export function typedValueOf(
  step: Record<string, unknown>,
):
  | { kind: "fill" | "type"; locator: Record<string, unknown>; value: string }
  | undefined {
  for (const kind of ["fill", "type"] as const) {
    const body = step[kind];
    if (body && typeof body === "object") {
      const { value, ...locator } = body as Record<string, unknown>;
      if (typeof value === "string") return { kind, locator, value };
    }
  }
  return undefined;
}
