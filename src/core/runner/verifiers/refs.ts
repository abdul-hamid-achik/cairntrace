import type { VerifierContext } from "./types";

/**
 * Runtime references verifiers (and `expect` / `capture` steps) can read:
 *
 *   ${artifacts.<name>.path|relativePath}   named artifacts
 *   ${requests.<name>.status|body.…}        request-step responses
 *   ${evals.<name>.value.…}                 eval-step values
 *   ${captures.<name>.…}                    capture steps + verifier assigns
 *   ${network.<name>.at|firstAt|count|…}    network verifier assigns
 *   ${fixtures.<name>.<key>}                fixture outputs
 *   ${runs.<name>.…}                        run-step outputs
 *   ${run.startedAt}                        ISO start of the run
 *
 * A string that is exactly one reference keeps the referenced value's type
 * (object, number, array); references inside a longer string interpolate
 * (objects as JSON). Unresolved references are reported, never silently
 * turned into "" — a verifier that queried with an empty id would pass or
 * fail for the wrong reason.
 */

const REF_PATTERN =
  /\$\{(artifacts|requests|evals|captures|network|fixtures|runs|run)\.([^}]+)\}/g;
const WHOLE_REF =
  /^\$\{(artifacts|requests|evals|captures|network|fixtures|runs|run)\.([^}]+)\}$/;

export type RefScope = Pick<
  VerifierContext,
  | "artifacts"
  | "responses"
  | "evals"
  | "captures"
  | "networkAssigns"
  | "fixtureOutputs"
  | "runOutputs"
  | "runStartedAt"
>;

export function lookupRef(
  ns: string,
  path: string,
  scope: RefScope,
): { found: boolean; value: unknown } {
  const parts = path.split(".").filter((part) => part.length > 0);
  if (ns === "run") {
    if (path === "startedAt" && scope.runStartedAt) {
      return { found: true, value: scope.runStartedAt };
    }
    return { found: false, value: undefined };
  }
  const roots: Record<string, Record<string, unknown> | undefined> = {
    artifacts: scope.artifacts as Record<string, unknown> | undefined,
    requests: scope.responses,
    evals: scope.evals,
    captures: scope.captures,
    network: scope.networkAssigns as Record<string, unknown> | undefined,
    fixtures: scope.fixtureOutputs,
    runs: scope.runOutputs,
  };
  let value: unknown = roots[ns];
  for (const part of parts) {
    if (Array.isArray(value)) {
      if (part === "length") {
        value = value.length;
        continue;
      }
      if (!/^\d+$/.test(part) || Number(part) >= value.length) {
        return { found: false, value: undefined };
      }
      value = value[Number(part)];
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, part)
    ) {
      value = (value as Record<string, unknown>)[part];
      continue;
    }
    return { found: false, value: undefined };
  }
  return value === undefined
    ? { found: false, value: undefined }
    : { found: true, value };
}

export interface Resolved<T> {
  value: T;
  /** `${…}` references that did not resolve, as written. */
  missing: string[];
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Resolve references in one string (typed when it is a whole reference). */
export function resolveRefString(
  text: string,
  scope: RefScope,
): Resolved<unknown> {
  const whole = WHOLE_REF.exec(text);
  if (whole) {
    const hit = lookupRef(whole[1]!, whole[2]!, scope);
    return hit.found
      ? { value: hit.value, missing: [] }
      : { value: text, missing: [text] };
  }
  const missing: string[] = [];
  const value = text.replace(REF_PATTERN, (match, ns: string, path: string) => {
    const hit = lookupRef(ns, path, scope);
    if (!hit.found) {
      missing.push(match);
      return match;
    }
    return render(hit.value);
  });
  return { value, missing };
}

/** Resolve references in every string of a JSON-ish value. */
export function resolveRefsDeep<T>(value: T, scope: RefScope): Resolved<T> {
  const missing: string[] = [];
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const resolved = resolveRefString(node, scope);
      missing.push(...resolved.missing);
      return resolved.value;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = visit(item);
      return out;
    }
    return node;
  };
  const resolved = visit(value) as T;
  return { value: resolved, missing: [...new Set(missing)] };
}

/**
 * Like resolveRefsDeep, but every string stays a string (a whole reference
 * renders as text, objects as JSON): for fields the schema types as text,
 * such as locator names and text assertions.
 */
export function resolveRefsText<T>(value: T, scope: RefScope): Resolved<T> {
  const missing: string[] = [];
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") {
      const resolved = resolveRefString(node, scope);
      missing.push(...resolved.missing);
      return typeof resolved.value === "string"
        ? resolved.value
        : render(resolved.value);
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = visit(item);
      return out;
    }
    return node;
  };
  const resolved = visit(value) as T;
  return { value: resolved, missing: [...new Set(missing)] };
}

/**
 * Names referenced through `captures` / `network` / `fixtures` / `runs`
 * that are not available — the outcome is blocked (not failed) when a step
 * failure stopped the run before they were produced.
 */
export function collectMissingProducedRefs(
  value: unknown,
  scope: RefScope,
): string[] {
  const missing = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(REF_PATTERN)) {
        const ns = match[1]!;
        if (!["captures", "network", "fixtures", "runs"].includes(ns)) continue;
        const name = match[2]!.split(".")[0]!;
        if (!lookupRef(ns, name, scope).found) missing.add(`${ns}.${name}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return [...missing];
}

/**
 * `${captures.<name>…}` placeholders in a step string (string context: values
 * render as text, objects as JSON, unknown names as ""), matching how the
 * runner splices `${requests.…}` / `${evals.…}` into steps.
 */
export function resolveCapturePlaceholders(
  input: string,
  captures: Record<string, unknown> = {},
): string {
  return input.replace(
    /\$\{captures\.([a-z][A-Za-z0-9_]*)((?:\.[^.}]+)*)\}/g,
    (_match, name: string, pathStr: string) => {
      const hit = lookupRef("captures", `${name}${pathStr}`, { captures });
      return hit.found ? render(hit.value) : "";
    },
  );
}
