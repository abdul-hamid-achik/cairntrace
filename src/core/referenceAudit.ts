// Static placeholder reference audit for `cairn spec verify`.
//
// Catches, in seconds, the failures that otherwise surface deep into a run
// (or not at all):
//   1. `${env.Y}` without a `:-default` that will substitute to an EMPTY
//      string at run time — parseSpec resolves unset env refs to "" silently
//      (the env branch returns "" when no default and no secretRef).
//   2. `${secrets.Y}` not declared in the config `secrets.required` — no
//      provider will ever supply it, so it also lands as "".
//
// `${vars.X}` is deliberately NOT audited here: parseSpec already throws
// MissingTemplateVariableError on undefined vars, so a spec that parses
// cleanly has no unresolved var refs.

const ENV_TOKEN = /\$\{env\.([A-Za-z0-9_]+)(:-[^}]*)?\}/g;
const SECRET_TOKEN = /\$\{secrets\.([A-Za-z0-9_]+)\}/g;

export interface ReferenceFinding {
  /** File the token appeared in (spec or imported action). */
  file: string;
  /** The literal `${...}` token as written. */
  token: string;
  /** Why it is a problem. */
  message: string;
}

export interface ReferenceAuditOptions {
  /** Declared secrets from config `secrets.required` (providers supply these). */
  secretsRequired?: readonly string[];
  /** Ambient env at verify time; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Audit every `${env.X}` / `${secrets.X}` reference in the given files
 * (spec + its imported actions). Full-line YAML comments are skipped so doc
 * examples inside `#` comments never count as real usage.
 */
export function auditPlaceholderReferences(
  files: ReadonlyArray<{ path: string; text: string }>,
  options: ReferenceAuditOptions = {},
): ReferenceFinding[] {
  const env = options.env ?? process.env;
  const required = new Set(options.secretsRequired ?? []);
  const findings: ReferenceFinding[] = [];

  for (const file of files) {
    const body = stripFullLineComments(file.text);
    for (const match of body.matchAll(ENV_TOKEN)) {
      const name = match[1]!;
      if (match[2] !== undefined) continue; // carries a `:-default`
      if (envRefIsSupplied(name, env, required)) continue;
      findings.push({
        file: file.path,
        token: `\${env.${name}}`,
        message:
          `${name} has no \`:-default\` and is not supplied ` +
          `(process.env, config secrets.required, or the CAIRN_* framework ` +
          `namespace) — it substitutes to an empty string at run time`,
      });
    }
    for (const match of body.matchAll(SECRET_TOKEN)) {
      const name = match[1]!;
      if (required.has(name)) continue;
      findings.push({
        file: file.path,
        token: `\${secrets.${name}}`,
        message:
          `${name} is not in the config \`secrets.required\` list — ` +
          `no provider will supply it (substitutes to an empty string)`,
      });
    }
  }
  return findings;
}

function envRefIsSupplied(
  name: string,
  env: Record<string, string | undefined>,
  required: ReadonlySet<string>,
): boolean {
  if (required.has(name)) return true;
  // CAIRN_* is the framework-managed namespace (CAIRN_TVAULT_ENV, CAIRN_PROGRESS,
  // CAIRN_WAIT_SCALE, ...) — the harness documents and supplies it.
  if (name.startsWith("CAIRN_")) return true;
  const value = env[name];
  return typeof value === "string" && value.length > 0;
}

function stripFullLineComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}
