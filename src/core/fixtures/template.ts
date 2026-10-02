import { isSensitiveEnvKey } from "../artifacts/redaction";
import { readPath } from "../runner/verifiers/matchers";

/**
 * Placeholders inside fixture definitions, resolved when a verb runs:
 *
 *   ${with.X}                 fixture parameters (spec `with:` over defaults)
 *   ${fixtures.<name>.<key>}  outputs of another fixture (or its own)
 *   ${vars.X}                 the environment's vars
 *   ${secrets.X} / ${env.X}   the run environment (`${env.X:-default}`)
 *   ${baseUrl}                the environment's base URL
 *   ${run.token}              the run token (the CLI's own when outside a run)
 *   ${now}                    ISO timestamp of the verb
 *
 * A string that is exactly one placeholder keeps the value's type (an object,
 * a number); inside a longer string values interpolate (objects as JSON). An
 * unresolved reference throws: a fixture written with an empty id would
 * create or delete the wrong data.
 */

export interface FixtureTemplateScope {
  with: Readonly<Record<string, unknown>>;
  fixtures: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  vars: Readonly<Record<string, string | number | boolean>>;
  env: Readonly<Record<string, string | undefined>>;
  baseUrl?: string;
  runToken?: string;
  now: string;
}

export class FixtureTemplateError extends Error {
  constructor(
    readonly reference: string,
    readonly reason: string,
  ) {
    super(`\${${reference}} ${reason}`);
    this.name = "FixtureTemplateError";
  }
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;
const WHOLE = /^\$\{([^}]+)\}$/;

function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Resolve one placeholder body. `secrets` collects every env/secret value
 * that was substituted, so callers can scrub it from errors and evidence.
 */
function lookup(
  body: string,
  scope: FixtureTemplateScope,
  secrets: Set<string>,
): { found: true; value: unknown } | { found: false } {
  if (body === "baseUrl") {
    return scope.baseUrl === undefined
      ? { found: false }
      : { found: true, value: scope.baseUrl };
  }
  if (body === "now") return { found: true, value: scope.now };
  if (body === "run.token") {
    return scope.runToken === undefined
      ? { found: false }
      : { found: true, value: scope.runToken };
  }
  const dot = body.indexOf(".");
  if (dot < 0) return { found: false };
  const ns = body.slice(0, dot);
  const rest = body.slice(dot + 1);
  if (ns === "env" || ns === "secrets") {
    const defaultAt = rest.indexOf(":-");
    const name = defaultAt >= 0 ? rest.slice(0, defaultAt) : rest;
    const value = scope.env[name];
    if (value === undefined || value === "") {
      return defaultAt >= 0
        ? { found: true, value: rest.slice(defaultAt + 2) }
        : { found: false };
    }
    // ${secrets.X} always; ${env.X} only when its name looks sensitive (a
    // path or a port must stay readable in errors and evidence).
    if (value.length >= 4 && (ns === "secrets" || isSensitiveEnvKey(name))) {
      secrets.add(value);
    }
    return { found: true, value };
  }
  if (ns === "vars") {
    return Object.hasOwn(scope.vars, rest)
      ? { found: true, value: scope.vars[rest] }
      : { found: false };
  }
  if (ns === "with") {
    const hit = readPath(scope.with, rest);
    return hit.exists ? { found: true, value: hit.value } : { found: false };
  }
  if (ns === "fixtures") {
    const nameDot = rest.indexOf(".");
    const name = nameDot < 0 ? rest : rest.slice(0, nameDot);
    const outputs = scope.fixtures[name];
    if (!outputs) return { found: false };
    if (nameDot < 0) return { found: true, value: outputs };
    const hit = readPath(outputs, rest.slice(nameDot + 1));
    return hit.exists ? { found: true, value: hit.value } : { found: false };
  }
  return { found: false };
}

function why(body: string, scope: FixtureTemplateScope): string {
  if (body.startsWith("fixtures.")) {
    const name = body.slice("fixtures.".length).split(".")[0]!;
    return scope.fixtures[name]
      ? `is not an output of fixture ${name} (outputs: ${
          Object.keys(scope.fixtures[name]!).join(", ") || "none"
        })`
      : `refers to fixture ${name}, which is not ensured here (add it to needs)`;
  }
  if (body.startsWith("with.")) return "is not a parameter (with:)";
  if (body.startsWith("vars.")) return "is not a var of this environment";
  if (body.startsWith("env.") || body.startsWith("secrets.")) {
    return "is not set — export it or add it to the environment's secrets";
  }
  if (body === "baseUrl") return "is not set: the environment has no baseUrl";
  if (body === "run.token") return "is not available here";
  return "is not a fixture placeholder";
}

function resolveString(
  text: string,
  scope: FixtureTemplateScope,
  secrets: Set<string>,
): unknown {
  if (!text.includes("${")) return text;
  const whole = WHOLE.exec(text);
  if (whole) {
    const hit = lookup(whole[1]!, scope, secrets);
    if (!hit.found)
      throw new FixtureTemplateError(whole[1]!, why(whole[1]!, scope));
    return hit.value;
  }
  return text.replace(PLACEHOLDER, (_match, body: string) => {
    const hit = lookup(body, scope, secrets);
    if (!hit.found) throw new FixtureTemplateError(body, why(body, scope));
    return render(hit.value);
  });
}

/** Resolve every string of a JSON-ish value (object keys stay literal). */
export function resolveFixtureTemplate<T>(
  value: T,
  scope: FixtureTemplateScope,
  secrets: Set<string> = new Set(),
): T {
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") return resolveString(node, scope, secrets);
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = visit(item);
      return out;
    }
    return node;
  };
  return visit(value) as T;
}

/** Fixture names a text references as `${fixtures.<name>…}`. */
export function fixtureNamesReferenced(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\$\{fixtures\.([a-z][A-Za-z0-9_]*)/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

const STEP_REFERENCE = /\$\{fixtures\.([a-z][A-Za-z0-9_]*)((?:\.[^.}]+)*)\}/g;

/**
 * `${fixtures.<name>.<path>}` references of a text that the outputs do not
 * resolve (a dry-run without outputs, a key the fixture never produced), in
 * order of appearance, each once.
 */
export function unresolvedFixtureReferences(
  text: string,
  outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Array<{ name: string; reference: string }> {
  if (!text.includes("${fixtures.")) return [];
  const seen = new Set<string>();
  const missing: Array<{ name: string; reference: string }> = [];
  for (const match of text.matchAll(STEP_REFERENCE)) {
    const [reference, name, pathStr] = match as unknown as [
      string,
      string,
      string,
    ];
    if (seen.has(reference)) continue;
    seen.add(reference);
    const root = outputs[name];
    const resolved =
      root !== undefined &&
      (!pathStr || readPath(root, pathStr.slice(1)).exists);
    if (!resolved) missing.push({ name, reference });
  }
  return missing;
}

/**
 * `${fixtures.<name>.<path>}` in a step string (string context, the way the
 * runner splices `${runs.…}`): values render as text, objects as JSON. A
 * reference that does not resolve is left as written so the caller can
 * report it.
 */
export function resolveFixturePlaceholders(
  input: string,
  outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
  if (!input.includes("${fixtures.")) return input;
  return input.replace(
    STEP_REFERENCE,
    (match, name: string, pathStr: string) => {
      const root = outputs[name];
      if (!root) return match;
      if (!pathStr) return render(root);
      const hit = readPath(root, pathStr.slice(1));
      return hit.exists ? render(hit.value) : match;
    },
  );
}
