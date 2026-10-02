import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  StepSchema,
  type Locator,
  type WaitCondition,
} from "../schema/spec.v1";
import type { DiscoveryAction } from "../schema/discovery.v1";

/**
 * Translate a discovery interaction into a spec-compatible step object.
 * The recorded step uses the exact same shape as a real spec step — no
 * translation needed when exporting to YAML.
 */

export interface RecordInput {
  action: DiscoveryAction;
  target?: Locator | string;
  value?: string;
  /** select action: the option's visible text (alternative to `value`). */
  label?: string;
  /** upload action: the file path to set on the file input. */
  path?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollPixels?: number;
  /** eval action: the spec `eval` body (`js` | `file`, args, assign). */
  eval?: Record<string, unknown>;
  /** wait action: a spec wait condition. */
  wait?: WaitCondition;
  /** assert action: a wait condition, recorded as a `wait` step. */
  assert?: WaitCondition;
  /** request action: the spec `request` body. */
  request?: Record<string, unknown>;
  /** Optional step `id`. */
  id?: string;
}

/**
 * Record an open step (navigation to a URL).
 */
export function recordOpen(url: string): Record<string, unknown> {
  return { open: url };
}

/**
 * Record an open step with waitUntil.
 */
export function recordOpenWithWait(
  url: string,
  waitUntil: "networkidle" | "load" | "domcontentloaded",
): Record<string, unknown> {
  return { open: { path: url, waitUntil } };
}

/**
 * Record a discovery interaction as a spec step object.
 * Returns undefined when the action+target combination is invalid.
 */
export function recordInteraction(
  input: RecordInput,
): Record<string, unknown> | undefined {
  const step = buildStep(input);
  if (!step) return undefined;
  return input.id ? { id: input.id, ...step } : step;
}

function buildStep(input: RecordInput): Record<string, unknown> | undefined {
  const { action, target, value, label, path, scrollDirection, scrollPixels } =
    input;

  // Snapshot @refs execute live but can never replay — refuse to record them
  // so the exported spec stays replayable (see isEphemeralTarget).
  if (isEphemeralTarget(target)) return undefined;

  switch (action) {
    case "click":
      if (!target) return undefined;
      return { click: normalizeTarget(target) };

    case "hover":
      if (!target) return undefined;
      return { hover: normalizeTarget(target) };

    case "focus":
      if (!target) return undefined;
      return { focus: normalizeTarget(target) };

    case "fill":
      if (!target || value === undefined) return undefined;
      return { fill: { ...normalizeTargetToObject(target), value } };

    case "type":
      if (!target || value === undefined) return undefined;
      return { type: { ...normalizeTargetToObject(target), value } };

    case "select": {
      // A native <select> needs exactly one of value | label (clicking the
      // option doesn't work under automation — see SelectStepSchema).
      if (!target) return undefined;
      if (value !== undefined) {
        return { select: { ...normalizeTargetToObject(target), value } };
      }
      if (label !== undefined) {
        return { select: { ...normalizeTargetToObject(target), label } };
      }
      return undefined;
    }

    case "upload":
      if (!target || path === undefined) return undefined;
      return { upload: { ...normalizeTargetToObject(target), path } };

    case "scroll": {
      if (target) {
        return { scroll: { to: normalizeTarget(target) } };
      }
      // Must match ScrollStepSchema: { direction, px } with a positive px — a
      // directional `{ [dir]: px }` shape is rejected by the strict schema, and
      // a non-positive px (e.g. scrollPixels: 0) is too, so fall back to the
      // 500 default rather than emit an invalid step.
      const direction = scrollDirection ?? "down";
      const px =
        scrollPixels !== undefined && scrollPixels > 0 ? scrollPixels : 500;
      return { scroll: { direction, px } };
    }

    case "press":
      if (!value) return undefined;
      return target
        ? { press: value, target: normalizeTarget(target) }
        : { press: value };

    case "eval":
      if (!input.eval) return undefined;
      return { eval: { ...input.eval } };

    case "wait":
      if (!input.wait) return undefined;
      return { wait: input.wait };

    case "assert":
      // An assertion replays as a bounded wait: it holds now, and the spec
      // waits for it to hold at the same point of the journey.
      if (!input.assert || "ms" in input.assert) return undefined;
      return { wait: input.assert };

    case "request":
      if (!input.request) return undefined;
      return { request: { ...input.request } };

    default:
      return undefined;
  }
}

/** Why `recordInteraction` refused an input (for the caller's error). */
export function missingInputMessage(input: RecordInput): string {
  switch (input.action) {
    case "fill":
    case "type":
      return `action=${input.action} requires target and value`;
    case "select":
      return "action=select requires target and exactly one of value | label";
    case "upload":
      return "action=upload requires target and path";
    case "press":
      return "action=press requires value (the key, e.g. Enter); target is optional";
    case "eval":
      return "action=eval requires eval: { js | file, args?, assign? }";
    case "wait":
      return "action=wait requires wait: { text | notText | url | value | selector | load | ms }";
    case "assert":
      return "action=assert requires assert: { text | notText | url | value | selector } (not ms)";
    case "request":
      return "action=request requires request: { method?, url, headers?, body?, expectStatus?, assign? }";
    default:
      return `action=${input.action} requires target`;
  }
}

/**
 * Validate a recorded step against the spec StepSchema: a step the session
 * records must be a step the exported spec can run. Returns the issues.
 */
export function stepSchemaIssues(step: unknown): string | undefined {
  const parsed = StepSchema.safeParse(step);
  if (parsed.success) return undefined;
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "step"}: ${issue.message}`)
    .join("; ");
}

/**
 * Normalize a target (Locator or string selector) to a Locator-shaped object
 * suitable for click/hover steps.
 */
function normalizeTarget(target: Locator | string): Locator {
  if (typeof target === "string") {
    return { by: "selector", selector: target };
  }
  return target;
}

/**
 * Normalize a target to a plain object for spread into fill/type steps
 * (which need the locator fields + value on the same object).
 */
function normalizeTargetToObject(
  target: Locator | string,
): Record<string, unknown> {
  if (typeof target === "string") {
    return { by: "selector", selector: target };
  }
  return target as Record<string, unknown>;
}

/**
 * True when `target` is an ephemeral snapshot `@ref` (e.g. `"@e2"`).
 *
 * agent-browser resolves a `@`-prefixed target against the *current*
 * snapshot's element handles, which are regenerated on every snapshot and do
 * not survive a page reload — a spec step that records one can never replay.
 * `@` is also never a valid CSS selector start, so this rejection has no
 * false positives against real selectors. A bare ref without the `@` (e.g.
 * `"e2"`) is treated as a CSS selector and simply fails to resolve, so it is
 * not a replayability trap.
 */
export function isEphemeralTarget(
  target: Locator | string | undefined,
): boolean {
  if (typeof target === "string") return target.trimStart().startsWith("@");
  return (
    target?.by === "selector" && target.selector.trimStart().startsWith("@")
  );
}

/* ----- secrets stay placeholders ----- */

/** A literal secret value and the placeholder that resolves to it. */
export interface SecretPlaceholder {
  value: string;
  placeholder: string;
}

/** Shorter values are too likely to collide with ordinary copy. */
const MIN_SECRET_LENGTH = 6;

/**
 * Known secret values with their placeholders: `${secrets.NAME}` for the
 * configured provider's keys, `${env.NAME}` for secret-looking environment
 * variables. Longest first, so a value containing another is replaced whole.
 */
export function secretPlaceholders(
  env: Record<string, string | undefined>,
  opts: {
    /** Names served by the secrets provider / `secrets.required`. */
    secretNames?: Iterable<string>;
    isSensitiveKey: (key: string) => boolean;
  },
): SecretPlaceholder[] {
  const secretNames = new Set(opts.secretNames ?? []);
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (secretNames.has(key)) out.set(value, `\${secrets.${key}}`);
    else if (opts.isSensitiveKey(key) && !out.has(value)) {
      out.set(value, `\${env.${key}}`);
    }
  }
  return [...out.entries()]
    .map(([value, placeholder]) => ({ value, placeholder }))
    .toSorted((a, b) => b.value.length - a.value.length);
}

/** Replace literal secret values in every string of `step` by placeholders. */
export function withSecretPlaceholders<T>(
  step: T,
  secrets: readonly SecretPlaceholder[],
): T {
  if (secrets.length === 0) return step;
  const map = (value: unknown): unknown => {
    if (typeof value === "string") {
      let out = value;
      for (const secret of secrets) {
        if (out.includes(secret.value)) {
          out = out.split(secret.value).join(secret.placeholder);
        }
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(map);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          map(v),
        ]),
      );
    }
    return value;
  };
  return map(step) as T;
}

/* ----- portable file paths ----- */

/**
 * Make the file paths a step declares portable: a relative `upload.path` or
 * `eval.file` is resolved against the caller's cwd and recorded as
 * `${config.dir}/…` (the config directory, or the cwd without a config), so
 * the session can execute it and the exported spec still finds the file
 * wherever it is written. Absolute and placeholder paths are kept.
 */
export function withPortableFilePaths(
  step: Record<string, unknown>,
  opts: { cwd: string; configDir: string },
): Record<string, unknown> {
  const portable = (path: unknown): unknown => {
    if (typeof path !== "string" || path.includes("${") || isAbsolute(path)) {
      return path;
    }
    const abs = resolve(opts.cwd, path);
    const rel = relative(opts.configDir, abs).split(sep).join("/");
    return `\${config.dir}/${rel}`;
  };
  if (step["upload"] && typeof step["upload"] === "object") {
    const upload = step["upload"] as Record<string, unknown>;
    return { ...step, upload: { ...upload, path: portable(upload["path"]) } };
  }
  if (step["eval"] && typeof step["eval"] === "object") {
    const body = step["eval"] as Record<string, unknown>;
    if (typeof body["file"] === "string") {
      return { ...step, eval: { ...body, file: portable(body["file"]) } };
    }
  }
  return step;
}
