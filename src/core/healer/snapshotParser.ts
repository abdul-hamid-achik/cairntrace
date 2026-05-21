/**
 * Parser for accessibility-tree snapshots. Accepts both:
 *
 *   agent-browser format (no trailing colons):
 *     - banner
 *       - heading "Dashboard" [level=1, ref=e1]
 *       - link "Open dashboard" [ref=e2]
 *
 *   Playwright ariaSnapshot format (trailing colons, optional ": <content>"):
 *     - banner:
 *       - heading "Dashboard" [level=1]:
 *       - link "Open dashboard":
 *         - /url: /dashboard.html
 *     - paragraph: Tiny static app for testing.
 *
 * Each line describes one element via: indentation (2 spaces per level), role,
 * optional quoted name, optional bracketed attributes, optional trailing
 * `: <stuff>` content (discarded by the parser).
 */

export interface SnapshotElement {
  role: string;
  name?: string;
  level: number;
  ref?: string;
  attrs?: Record<string, string>;
}

export function parseSnapshot(text: string): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const el = parseSnapshotLine(line);
    if (el) out.push(el);
  }
  return out;
}

/**
 * Parse one snapshot line into a SnapshotElement, or return undefined when
 * the line doesn't start with the `- ` marker (e.g., a YAML key like `/url:`).
 */
function parseSnapshotLine(line: string): SnapshotElement | undefined {
  // Indent + leading `- `.
  const indentMatch = /^(?<indent>\s*)- /.exec(line);
  if (!indentMatch) return undefined;
  const indent = indentMatch.groups!["indent"]!;
  const level = Math.floor(indent.length / 2);
  let rest = line.slice(indentMatch[0].length);

  // Role: a contiguous non-whitespace token, with an optional trailing colon
  // (Playwright). Stop at the first whitespace.
  const roleMatch = /^(?<role>[^\s"]+?):?(?=\s|$)/.exec(rest);
  if (!roleMatch) return undefined;
  const role = roleMatch.groups!["role"]!;
  // If the role itself contains a `/` (like `/url:` from Playwright's url lines),
  // that's a value line, not a node — skip.
  if (role.startsWith("/")) return undefined;
  rest = rest.slice(roleMatch[0].length).trimStart();

  // Optional `"name"`, possibly with a trailing colon.
  let name: string | undefined;
  const nameMatch = /^"(?<n>[^"]*)":?/.exec(rest);
  if (nameMatch) {
    name = nameMatch.groups!["n"];
    rest = rest.slice(nameMatch[0].length).trimStart();
  }

  // Optional `[attrs]`.
  let attrs: Record<string, string> | undefined;
  const attrsMatch = /^\[(?<a>[^\]]+)\]/.exec(rest);
  if (attrsMatch) {
    attrs = parseAttrs(attrsMatch.groups!["a"]!);
  }

  return {
    role,
    ...(name !== undefined ? { name } : {}),
    level,
    ...(attrs?.["ref"] ? { ref: attrs["ref"] } : {}),
    ...(attrs ? { attrs } : {}),
  };
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
