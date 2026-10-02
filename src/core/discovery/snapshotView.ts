import { createHash } from "node:crypto";
import { parseSnapshot, type SnapshotElement } from "../healer/snapshotParser";
import {
  DEFAULT_SNAPSHOT_MAX_BYTES,
  type DiscoverySnapshotElement,
  type SnapshotInfo,
  type SnapshotMode,
} from "../schema/discovery.v1";

/**
 * Context economy for discovery: a full accessibility snapshot of a real app
 * page is 8–128 KB, and an agent exploring a flow takes one per action. The
 * session always journals the full text; the tool result carries only what
 * the caller asked for:
 *
 *   none     no elements (the journal file is still referenced)
 *   diff     elements added or changed since the previous snapshot (default)
 *   compact  every element with a ref (interactive) or a name
 *   full     every element
 *
 * Every mode is cut to `maxBytes` of JSON (the returned elements plus the
 * diff's `removed` list; `removed` takes at most a quarter). Names and
 * attribute values are redacted before anything is keyed, diffed or
 * measured, so no secret on the page reaches the caller — not even in an
 * element that disappeared. Elements carry a `key` that stays
 * the same across snapshots for the same node (role + name + ancestor chain +
 * position among identical siblings) — agent-browser `ref`s are renumbered on
 * every snapshot and cannot correlate two of them.
 */

/**
 * parseSnapshot, plus the bare flags (`checked`, `disabled`, `expanded`)
 * as `"true"` attributes: a state change is what a diff must show, and
 * parseSnapshot keeps only `key=value` attributes.
 */
export function parseSnapshotWithFlags(text: string): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [el] = parseSnapshot(line);
    if (!el) continue;
    const bracket = /^\s*- [^\s"]+:?(?:\s+"[^"]*":?)?\s*\[([^\]]+)\]/.exec(
      line,
    );
    const flags = (bracket?.[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.includes("="));
    if (flags.length > 0) {
      el.attrs = {
        ...el.attrs,
        ...Object.fromEntries(flags.map((flag) => [flag, "true"])),
      };
    }
    out.push(el);
  }
  return out;
}

/** A parsed element plus its stable identity. */
export interface KeyedElement extends SnapshotElement {
  key: string;
}

/** Attach stable keys to a parsed snapshot. */
export function keyElements(
  elements: readonly SnapshotElement[],
): KeyedElement[] {
  const stack: string[] = [];
  const seen = new Map<string, number>();
  return elements.map((el) => {
    stack.length = Math.min(stack.length, el.level);
    const self = `${el.role}:${el.name ?? ""}`;
    const identity = [...stack, self].join(" > ");
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    stack[el.level] = self;
    const key = createHash("sha1")
      .update(`${identity}#${occurrence}`)
      .digest("hex")
      .slice(0, 10);
    return { ...el, key };
  });
}

function attrsSignature(el: SnapshotElement): string {
  if (!el.attrs) return "";
  return JSON.stringify(
    Object.entries(el.attrs)
      .filter(([k]) => k !== "ref")
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

function view(
  el: KeyedElement,
  change?: DiscoverySnapshotElement["change"],
): DiscoverySnapshotElement {
  return {
    role: el.role,
    ...(el.name !== undefined ? { name: el.name } : {}),
    level: el.level,
    ...(el.ref ? { ref: el.ref } : {}),
    ...(el.attrs && Object.keys(el.attrs).length > 0
      ? { attrs: el.attrs }
      : {}),
    key: el.key,
    ...(change ? { change } : {}),
  };
}

export interface SnapshotViewInput {
  current: readonly SnapshotElement[];
  /** The previous snapshot (diff baseline); empty for the first one. */
  previous?: readonly SnapshotElement[];
  mode?: SnapshotMode;
  maxBytes?: number;
  /** Journal file holding the full text. */
  path?: string;
  /** Bytes of the full text. */
  bytes: number;
  /** Applied to every name and attribute value (the session's redactor). */
  redact?: (text: string) => string;
}

function redactElements(
  elements: readonly SnapshotElement[],
  redact: ((text: string) => string) | undefined,
): readonly SnapshotElement[] {
  if (!redact) return elements;
  return elements.map((el) => ({
    ...el,
    ...(el.name !== undefined ? { name: redact(el.name) } : {}),
    ...(el.attrs
      ? {
          attrs: Object.fromEntries(
            Object.entries(el.attrs).map(([key, value]) => [
              key,
              typeof value === "string" ? redact(value) : value,
            ]),
          ),
        }
      : {}),
  }));
}

/** The elements to return for `mode`, cut to `maxBytes`, plus a summary. */
export function snapshotView(input: SnapshotViewInput): {
  snapshot: DiscoverySnapshotElement[];
  info: SnapshotInfo;
} {
  const mode = input.mode ?? "diff";
  const maxBytes = Math.max(256, input.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);
  const current = keyElements(redactElements(input.current, input.redact));
  let selected: DiscoverySnapshotElement[] = [];
  let unchanged: number | undefined;
  let removed: SnapshotInfo["removed"];
  if (mode === "full") {
    selected = current.map((el) => view(el));
  } else if (mode === "compact") {
    selected = current
      .filter((el) => el.ref !== undefined || (el.name ?? "").trim() !== "")
      .map((el) => view(el));
  } else if (mode === "diff") {
    const before = new Map(
      keyElements(redactElements(input.previous ?? [], input.redact)).map(
        (el) => [el.key, el],
      ),
    );
    unchanged = 0;
    for (const el of current) {
      const prior = before.get(el.key);
      if (!prior) {
        selected.push(view(el, "added"));
      } else {
        before.delete(el.key);
        if (attrsSignature(prior) !== attrsSignature(el)) {
          selected.push(view(el, "changed"));
        } else {
          unchanged++;
        }
      }
    }
    removed = [...before.values()].map((el) => ({
      key: el.key,
      role: el.role,
      ...(el.name !== undefined ? { name: el.name } : {}),
    }));
  }
  // `removed` first (at most a quarter), the elements get the rest: the
  // two together stay within maxBytes.
  const removedKept = removed ? fitBytes(removed, maxBytes / 4) : undefined;
  const { kept, truncated } = fitBytes(
    selected,
    maxBytes - (removedKept?.used ?? 0),
  );
  return {
    snapshot: kept,
    info: {
      mode,
      ...(input.path ? { path: input.path } : {}),
      bytes: input.bytes,
      elements: current.length,
      returned: kept.length,
      truncated: truncated || (removedKept?.truncated ?? false),
      ...(unchanged !== undefined ? { unchanged } : {}),
      ...(removedKept ? { removed: removedKept.kept } : {}),
    },
  };
}

/** The longest prefix of `items` whose JSON fits in `maxBytes`. */
function fitBytes<T>(
  items: readonly T[],
  maxBytes: number,
): { kept: T[]; truncated: boolean; used: number } {
  let used = 2;
  const kept: T[] = [];
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (used + size > maxBytes) return { kept, truncated: true, used };
    used += size;
    kept.push(item);
  }
  return { kept, truncated: false, used };
}
