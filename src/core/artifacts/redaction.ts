import type { ArtifactRedactor } from "./ArtifactWriter";
import type { RedactionConfig } from "../schema/spec.v1";

const SENSITIVE_KEY_RE =
  /authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|code[_-]?verifier|otp|passcode|credential|assertion/i;
const STRUCTURED_POST_DATA_KEY_RE = /^postData$/i;
const BUILT_IN_SENSITIVE_HEADERS = ["Authorization", "Cookie", "Set-Cookie"];
const BUILT_IN_QUERY_PARAM_RE =
  /^(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret|code[_-]?verifier|otp|passcode|credential|assertion)$/i;

interface RedactionRules {
  headerNames: readonly string[];
  queryParamNames: ReadonlySet<string>;
  structuredKeyNames: ReadonlySet<string>;
  namedValueKeyNames: ReadonlySet<string>;
}

const DEFAULT_REDACTION_RULES: RedactionRules = {
  headerNames: [],
  queryParamNames: new Set(),
  structuredKeyNames: new Set(),
  namedValueKeyNames: new Set(),
};

/**
 * Process-wide registry of literal secret values that must ALWAYS be redacted
 * from artifacts, regardless of the env key name. A vault provider (e.g.
 * tvault) supplies secrets whose keys (`MONGO_URI`, `DATABASE_URL`, …) do not
 * match `SENSITIVE_KEY_RE`, so key-name heuristics alone would leak their
 * plaintext into resolved specs, run.json, report.html, etc. Injection
 * registers the values here so every later redactor scrubs them.
 */
const registeredSecretValues = new Set<string>();

/**
 * Register secret values (e.g. all values pulled from a vault) so that every
 * artifact redactor created afterwards scrubs them, independent of key naming.
 */
export function registerSecretValues(values: Iterable<string>): void {
  for (const value of values) {
    if (value) registeredSecretValues.add(value);
  }
}

/** Clear the registered-secret-value set. Intended for test isolation. */
export function clearRegisteredSecretValues(): void {
  registeredSecretValues.clear();
}

export function createArtifactRedactor(
  config: RedactionConfig | undefined,
  env: Record<string, string | undefined> = process.env,
  knownSecretValues: Iterable<string> = [],
): ArtifactRedactor {
  const literalSecrets = collectLiteralSecrets(config, env, knownSecretValues);
  const rules = createRedactionRules(config);
  return {
    value: <T>(input: T): T => redactUnknown(input, literalSecrets, rules) as T,
    text: (input: string): string =>
      redactStringWithRules(input, literalSecrets, rules),
  };
}

export function redactString(
  input: string,
  literalSecrets: readonly string[],
): string {
  return redactStringWithRules(input, literalSecrets, DEFAULT_REDACTION_RULES);
}

function redactStringWithRules(
  input: string,
  literalSecrets: readonly string[],
  rules: RedactionRules,
): string {
  let output = input;
  for (const secret of literalSecrets) {
    output = output.split(secret).join("[redacted]");
  }
  output = redactHeaderValues(output, rules.headerNames);
  output = redactQueryParamValues(output, rules.queryParamNames);
  return output;
}

function redactUnknown(
  input: unknown,
  literalSecrets: readonly string[],
  rules: RedactionRules = DEFAULT_REDACTION_RULES,
): unknown {
  if (typeof input === "string")
    return redactStringWithRules(input, literalSecrets, rules);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input))
    return input.map((item) => redactUnknown(item, literalSecrets, rules));

  const output: Record<string, unknown> = {};
  const namedValueIsSensitive =
    typeof (input as Record<string, unknown>).name === "string" &&
    isSensitiveNamedValue(
      (input as Record<string, unknown>).name as string,
      rules,
    );
  for (const [key, value] of Object.entries(input)) {
    if (namedValueIsSensitive && key === "value") {
      output[key] = "[redacted]";
    } else if (
      SENSITIVE_KEY_RE.test(key) ||
      rules.structuredKeyNames.has(normalizeConfiguredName(key))
    ) {
      output[key] = "[redacted]";
    } else if (
      STRUCTURED_POST_DATA_KEY_RE.test(key) &&
      typeof value === "string"
    ) {
      output[key] = redactStructuredPostData(value, literalSecrets, rules);
    } else {
      output[key] = redactUnknown(value, literalSecrets, rules);
    }
  }
  return output;
}

/**
 * Network evidence uses Playwright/agent-browser compatible `postData` text.
 * Parse JSON bodies back to structure before redaction so a nested `password`
 * or `accessToken` cannot hide inside an otherwise ordinary string field.
 */
function redactStructuredPostData(
  postData: string,
  literalSecrets: readonly string[],
  rules: RedactionRules,
): string {
  try {
    const parsed: unknown = JSON.parse(postData);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(redactUnknown(parsed, literalSecrets, rules));
    }
  } catch {
    // Native Playwright capture omits non-JSON request bodies. Retain the
    // normal literal/header scrubber for evidence produced by other backends.
  }
  return redactStringWithRules(postData, literalSecrets, rules);
}

function createRedactionRules(
  config: RedactionConfig | undefined,
): RedactionRules {
  const headerNames = uniqueConfiguredNames(config?.headers);
  const queryParamNames = new Set(
    uniqueConfiguredNames(config?.queryParams).map(normalizeConfiguredName),
  );
  const storageKeyNames = uniqueConfiguredNames(config?.storageKeys);
  const structuredKeyNames = new Set(
    [...headerNames, ...storageKeyNames].map(normalizeConfiguredName),
  );
  const namedValueKeyNames = new Set(
    [
      ...BUILT_IN_SENSITIVE_HEADERS,
      ...headerNames,
      ...storageKeyNames,
      ...queryParamNames,
    ].map(normalizeConfiguredName),
  );
  return {
    headerNames,
    queryParamNames,
    structuredKeyNames,
    namedValueKeyNames,
  };
}

function uniqueConfiguredNames(
  values: readonly string[] | undefined,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const name = value.trim();
    const normalized = normalizeConfiguredName(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(name);
  }
  return names;
}

function normalizeConfiguredName(value: string): string {
  return value.trim().toLowerCase();
}

function redactHeaderValues(
  input: string,
  configuredNames: readonly string[],
): string {
  const names = [...BUILT_IN_SENSITIVE_HEADERS, ...configuredNames]
    .map(escapeRegExp)
    .join("|");
  // RFC HTTP token names may begin with punctuation (`-private`, `!auth`,
  // etc.), where a word boundary does not exist. Match a field name only at
  // the start or after a non-token character and preserve that prefix.
  const httpTokenChars = "A-Za-z0-9!#$%&'*+.^_`|~-";
  const pattern = new RegExp(
    `(^|[^${httpTokenChars}])(${names})\\s*:\\s*[^\\r\\n]+`,
    "gim",
  );
  return input.replace(
    pattern,
    (_match, prefix: string, name: string) => `${prefix}${name}: [redacted]`,
  );
}

function redactQueryParamValues(
  input: string,
  configuredNames: ReadonlySet<string>,
): string {
  return input.replace(
    /([?&])([^=&#\s]+)=([^&#\s]*)/g,
    (match, separator: string, encodedName: string) => {
      const decodedName = decodeQueryParamName(encodedName);
      if (
        decodedName === undefined ||
        (!BUILT_IN_QUERY_PARAM_RE.test(decodedName) &&
          !configuredNames.has(normalizeConfiguredName(decodedName)))
      ) {
        return match;
      }
      return `${separator}${encodedName}=[redacted]`;
    },
  );
}

function decodeQueryParamName(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return undefined;
  }
}

function isSensitiveNamedValue(name: string, rules: RedactionRules): boolean {
  return (
    SENSITIVE_KEY_RE.test(name) ||
    BUILT_IN_QUERY_PARAM_RE.test(name) ||
    rules.namedValueKeyNames.has(normalizeConfiguredName(name))
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectLiteralSecrets(
  config: RedactionConfig | undefined,
  env: Record<string, string | undefined>,
  knownSecretValues: Iterable<string>,
): string[] {
  const values = new Set<string>();
  for (const value of config?.values ?? []) addSecret(values, value);

  for (const [key, value] of Object.entries(env)) {
    if (value && SENSITIVE_KEY_RE.test(key)) addSecret(values, value);
  }

  // Vault-injected secrets are sensitive regardless of their key name.
  for (const value of registeredSecretValues) addSecret(values, value);
  for (const value of knownSecretValues) addSecret(values, value);

  return [...values].toSorted((a, b) => b.length - a.length);
}

function addSecret(values: Set<string>, value: string): void {
  const trimmed = value.trim();
  // Explicit/registered secrets are a contract, even when they are short
  // values such as a PIN, CVV, or one-time code. Over-redaction is safer than
  // silently persisting a caller-declared secret.
  if (trimmed.length > 0) values.add(trimmed);
}
