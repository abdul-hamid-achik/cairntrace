import type { Locator } from "../schema/spec.v1";
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
      return { press: value };

    default:
      return undefined;
  }
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
  return typeof target === "string" && target.trimStart().startsWith("@");
}
