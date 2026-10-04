import type { ConfigVarValue } from "../schema/config.v1";

/**
 * F7 typed config vars: shared helpers for every place a `${vars.X}`
 * placeholder is resolved (spec parsing, config fixtures, datasources,
 * environment login, var-to-var references).
 *
 * Rules:
 * - `${vars.name}` reads a var; `${vars.name.key}` / `${vars.name.0}` read
 *   inside an object / list var (the longest defined var name wins, so a var
 *   literally named `a.b` still resolves).
 * - A string context (a placeholder inside a longer string, a quoted YAML
 *   scalar, a header, a URL) renders strings as-is, numbers and booleans
 *   with `String()`, and lists / objects as compact JSON.
 */

export type VarKind = "string" | "number" | "boolean" | "list" | "object";

export function varKind(value: unknown): VarKind {
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value !== null && typeof value === "object") return "object";
  return "string";
}

/** True for a list or object var. */
export function isStructuredVar(
  value: unknown,
): value is ConfigVarValue[] | { [key: string]: ConfigVarValue } {
  return value !== null && typeof value === "object";
}

/** The documented string-context serialization of a var value. */
export function renderVarValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * The var name a reference starts with: the longest dotted prefix of `ref`
 * that `has` accepts, else the first segment.
 */
export function varRefRoot(
  ref: string,
  has: (name: string) => boolean,
): string {
  if (has(ref)) return ref;
  const segments = ref.split(".");
  for (let end = segments.length - 1; end >= 1; end--) {
    const name = segments.slice(0, end).join(".");
    if (has(name)) return name;
  }
  return segments[0]!;
}

/** Read `${vars.<ref>}` from a bag (see the module rules). */
export function lookupVar(
  vars: Readonly<Record<string, unknown>>,
  ref: string,
): { found: true; value: unknown } | { found: false } {
  const root = varRefRoot(ref, (name) => Object.hasOwn(vars, name));
  if (!Object.hasOwn(vars, root)) return { found: false };
  const value = vars[root];
  if (root === ref) {
    return value === undefined ? { found: false } : { found: true, value };
  }
  return readVarPath(value, ref.slice(root.length + 1));
}

/** Walk `a.b.0` inside a var value. */
export function readVarPath(
  value: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  let current = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.hasOwn(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
    if (current === undefined) return { found: false };
  }
  return { found: true, value: current };
}
