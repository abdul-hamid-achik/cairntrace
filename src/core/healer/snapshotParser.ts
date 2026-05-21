/**
 * Parser for agent-browser's compact accessibility-tree snapshot format.
 *
 * Sample input:
 *   - banner
 *     - heading "Dashboard" [level=1, ref=e1]
 *     - paragraph
 *       - StaticText "All systems normal"
 *   - main
 *     - link "Open dashboard" [ref=e2]
 *
 * Each line describes one element via: indentation (2 spaces per level), role,
 * optional quoted name, and optional bracketed attributes like `[ref=e1, level=2]`.
 */

export interface SnapshotElement {
  role: string;
  name?: string;
  level: number;
  ref?: string;
  attrs?: Record<string, string>;
}

const LINE_RE =
  /^(?<indent>\s*)- (?<role>\S+)(?:\s+"(?<name>[^"]*)")?(?:\s+\[(?<attrs>[^\]]+)\])?\s*$/;

export function parseSnapshot(text: string): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = LINE_RE.exec(line);
    if (!m?.groups) continue;
    const {
      indent,
      role,
      name,
      attrs: attrsRaw,
    } = m.groups as {
      indent: string;
      role: string;
      name?: string;
      attrs?: string;
    };
    const level = Math.floor(indent.length / 2);
    const attrs = attrsRaw ? parseAttrs(attrsRaw) : undefined;
    out.push({
      role,
      ...(name !== undefined ? { name } : {}),
      level,
      ...(attrs?.["ref"] ? { ref: attrs["ref"] } : {}),
      ...(attrs ? { attrs } : {}),
    });
  }
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
  return out;
}

/** All elements with the given role (case-sensitive). */
export function findByRole(
  snapshot: SnapshotElement[],
  role: string,
): SnapshotElement[] {
  return snapshot.filter((e) => e.role === role);
}
