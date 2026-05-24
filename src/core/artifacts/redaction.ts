import type { ArtifactRedactor } from "./ArtifactWriter";
import type { RedactionConfig } from "../schema/spec.v1";

const SENSITIVE_KEY_RE =
  /authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token/i;

export function createArtifactRedactor(
  config: RedactionConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ArtifactRedactor {
  const literalSecrets = collectLiteralSecrets(config, env);
  return {
    value: <T>(input: T): T => redactUnknown(input, literalSecrets) as T,
    text: (input: string): string => redactString(input, literalSecrets),
  };
}

export function redactString(
  input: string,
  literalSecrets: readonly string[],
): string {
  let output = input;
  for (const secret of literalSecrets) {
    output = output.split(secret).join("[redacted]");
  }
  output = output.replace(
    /\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    (_match, name: string) => `${name}: [redacted]`,
  );
  output = output.replace(
    /([?&](?:access_token|refresh_token|token|api_key|apikey|password|secret)=)[^&#\s]+/gi,
    "$1[redacted]",
  );
  return output;
}

function redactUnknown(
  input: unknown,
  literalSecrets: readonly string[],
): unknown {
  if (typeof input === "string") return redactString(input, literalSecrets);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input))
    return input.map((item) => redactUnknown(item, literalSecrets));

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = SENSITIVE_KEY_RE.test(key)
      ? "[redacted]"
      : redactUnknown(value, literalSecrets);
  }
  return output;
}

function collectLiteralSecrets(
  config: RedactionConfig | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const values = new Set<string>();
  for (const value of config?.values ?? []) addSecret(values, value);

  for (const [key, value] of Object.entries(env)) {
    if (value && SENSITIVE_KEY_RE.test(key)) addSecret(values, value);
  }

  return [...values].toSorted((a, b) => b.length - a.length);
}

function addSecret(values: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length >= 4) values.add(trimmed);
}
