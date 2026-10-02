/**
 * Find runs of recorded steps that an existing reusable action already
 * performs, so an export writes `use: { action, vars }` instead of
 * re-recording the action's steps with literals.
 *
 * An action step is a template: every `${vars.X}` in it binds to the
 * recorded literal at the same place (whole strings or parts of one), and
 * the same var must bind the same value everywhere. Locators compare
 * equivalently: a semantic (role/label/text) name is whitespace- and
 * case-insensitive unless the action says `exact: true`, and
 * `open: /x` equals `open: { path: /x, waitUntil: … }`. Ids and
 * postconditions are ignored.
 */

type Scalar = string | number | boolean;

/** A reusable action as the matcher sees it. */
export interface ActionTemplate {
  name: string;
  /** Absolute action file. */
  file: string;
  steps: Record<string, unknown>[];
  /** The action's own `vars:` defaults. */
  defaults: Record<string, Scalar>;
}

export interface ActionMatch {
  action: string;
  file: string;
  /** Index of the first matched step. */
  start: number;
  /** Index after the last matched step. */
  end: number;
  /** Every var the action's steps read, as bound from the recorded literals. */
  bindings: Record<string, string>;
  /** 1 = literal match; lower when names matched only equivalently. */
  confidence: number;
  /** Replaced by a `use:` step (multi-step match at ≥ MIN_CONFIDENCE). */
  applied: boolean;
  /** Why a match was reported but not applied. */
  reason?: string;
}

/** Below this confidence a match is reported, never applied. */
export const MIN_APPLY_CONFIDENCE = 0.8;

interface UnifyState {
  bindings: Map<string, string>;
  /** Comparisons that needed normalization (case, whitespace, open form). */
  approximate: number;
}

const VAR_RE = /\$\{vars\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Keys whose values are names compared case-insensitively. */
const SEMANTIC_NAME_KEYS = new Set([
  "name",
  "label",
  "text",
  "near",
  "hasText",
]);
/** Keys a match ignores. */
const IGNORED_KEYS = new Set(["id", "postcondition"]);

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Unify a template string (may hold `${vars.X}`) with a recorded string. */
function unifyString(
  template: string,
  value: string,
  state: UnifyState,
  caseInsensitive: boolean,
): boolean {
  const names: string[] = [];
  let pattern = "";
  let last = 0;
  for (const match of template.matchAll(VAR_RE)) {
    pattern += escapeRegExp(template.slice(last, match.index));
    pattern += "([\\s\\S]*?)";
    names.push(match[1]!);
    last = match.index! + match[0].length;
  }
  pattern += escapeRegExp(template.slice(last));
  if (names.length === 0) {
    if (template === value) return true;
    if (caseInsensitive && normalizeText(template) === normalizeText(value)) {
      state.approximate++;
      return true;
    }
    return false;
  }
  const re = new RegExp(`^${pattern}$`, caseInsensitive ? "is" : "s");
  const m = re.exec(value);
  if (!m) return false;
  for (const [i, name] of names.entries()) {
    const bound = m[i + 1]!;
    const prior = state.bindings.get(name);
    if (prior !== undefined && prior !== bound) return false;
    state.bindings.set(name, bound);
  }
  return true;
}

function unify(
  template: unknown,
  value: unknown,
  state: UnifyState,
  key = "",
  exact = false,
): boolean {
  if (typeof template === "string") {
    if (typeof value === "string") {
      return unifyString(
        template,
        value,
        state,
        SEMANTIC_NAME_KEYS.has(key) && !exact,
      );
    }
    // `${vars.n}` standing for a number/boolean the recording wrote typed.
    if (
      (typeof value === "number" || typeof value === "boolean") &&
      /^\$\{vars\.[A-Za-z_][A-Za-z0-9_]*\}$/.test(template)
    ) {
      return unifyString(template, String(value), state, false);
    }
    return false;
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length !== template.length) return false;
    return template.every((item, i) => unify(item, value[i], state, key));
  }
  if (template && typeof template === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const t = template as Record<string, unknown>;
    const v = value as Record<string, unknown>;
    const isExact = t["exact"] === true;
    const keys = new Set(
      [...Object.keys(t), ...Object.keys(v)].filter(
        (k) => !IGNORED_KEYS.has(k),
      ),
    );
    for (const k of keys) {
      if (!(k in t) || !(k in v)) return false;
      if (!unify(t[k], v[k], state, k, isExact)) return false;
    }
    return true;
  }
  return template === value;
}

/** `open: /x` and `open: { path: /x, waitUntil }` compare as the same step. */
function canonicalStep(step: Record<string, unknown>): {
  step: Record<string, unknown>;
  normalized: boolean;
} {
  const open = step["open"];
  if (open && typeof open === "object" && !Array.isArray(open)) {
    const path = (open as Record<string, unknown>)["path"];
    if (typeof path === "string") {
      return { step: { ...step, open: path }, normalized: true };
    }
  }
  return { step, normalized: false };
}

function unifyStep(
  template: Record<string, unknown>,
  recorded: Record<string, unknown>,
  state: UnifyState,
): boolean {
  const t = canonicalStep(template);
  const r = canonicalStep(recorded);
  if (t.normalized !== r.normalized) state.approximate++;
  return unify(t.step, r.step, state);
}

/** Try one action at one position. */
function matchAt(
  action: ActionTemplate,
  steps: readonly Record<string, unknown>[],
  start: number,
): ActionMatch | undefined {
  if (start + action.steps.length > steps.length) return undefined;
  const state: UnifyState = { bindings: new Map(), approximate: 0 };
  for (const [offset, template] of action.steps.entries()) {
    if (!unifyStep(template, steps[start + offset]!, state)) return undefined;
  }
  const confidence = Math.max(
    0.5,
    Math.round((1 - 0.1 * state.approximate) * 100) / 100,
  );
  const multi = action.steps.length >= 2;
  const applied = multi && confidence >= MIN_APPLY_CONFIDENCE;
  return {
    action: action.name,
    file: action.file,
    start,
    end: start + action.steps.length,
    bindings: Object.fromEntries(state.bindings),
    confidence,
    applied,
    ...(applied
      ? {}
      : {
          reason: multi
            ? `confidence ${confidence} is below ${MIN_APPLY_CONFIDENCE}`
            : "one-step action: reported, not replaced",
        }),
  };
}

/** Steps that can never be part of an action match. */
function matchable(step: Record<string, unknown>): boolean {
  return !("use" in step);
}

/**
 * Non-overlapping matches over `steps`, scanning left to right and taking
 * the longest (then most confident) applicable action at each position.
 * Unapplied candidates (one-step actions, low confidence) are reported too
 * when no applicable match covers their position.
 */
export function findActionMatches(
  steps: readonly Record<string, unknown>[],
  actions: readonly ActionTemplate[],
): ActionMatch[] {
  const usable = actions.filter(
    (action) => action.steps.length > 0 && action.steps.every(matchable),
  );
  const out: ActionMatch[] = [];
  let i = 0;
  while (i < steps.length) {
    if (!matchable(steps[i]!)) {
      i++;
      continue;
    }
    const candidates = usable
      .map((action) => matchAt(action, steps, i))
      .filter((m): m is ActionMatch => m !== undefined)
      .toSorted(
        (a, b) =>
          Number(b.applied) - Number(a.applied) ||
          b.end - b.start - (a.end - a.start) ||
          b.confidence - a.confidence ||
          a.action.localeCompare(b.action),
      );
    const best = candidates[0];
    if (!best) {
      i++;
      continue;
    }
    out.push(best);
    i = best.applied ? best.end : i + 1;
  }
  return out;
}

/**
 * The `vars` a `use:` call must pass: bindings whose value differs from what
 * the action would read without them (a config environment var of the same
 * name, else the action's default). `resolveDefault` resolves placeholders
 * in a default (`${env.X}`, `${vars.X}`, `${secrets.X}`): a default that
 * resolves to the recorded literal is not passed, so the call keeps its
 * indirection instead of hardcoding the value.
 */
export function callVars(
  match: Pick<ActionMatch, "bindings">,
  action: Pick<ActionTemplate, "defaults">,
  configVars: Record<string, Scalar>,
  resolveDefault?: (value: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(match.bindings)) {
    const effective = Object.hasOwn(configVars, name)
      ? configVars[name]
      : action.defaults[name];
    if (effective !== undefined) {
      if (String(effective) === value) continue;
      if (
        typeof effective === "string" &&
        effective.includes("${") &&
        resolveDefault?.(effective) === value
      ) {
        continue;
      }
    }
    out[name] = value;
  }
  return out;
}
