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
  const { action, target, value, scrollDirection, scrollPixels } = input;

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

    case "scroll": {
      if (target) {
        return { scroll: { to: normalizeTarget(target) } };
      }
      // Must match ScrollStepSchema: { direction, px } — a directional
      // `{ [dir]: px }` shape is rejected by the strict schema and throws on
      // the agent-browser backend.
      const direction = scrollDirection ?? "down";
      const px = scrollPixels ?? 500;
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
