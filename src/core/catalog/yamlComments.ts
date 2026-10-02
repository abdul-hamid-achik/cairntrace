import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Node,
  type Pair,
  type YAMLMap,
} from "yaml";

const MAX_COMMENT = 600;

/** Normalize a yaml-library comment (`" line 1\n line 2"`) to trimmed text. */
export function cleanComment(
  comment: string | null | undefined,
): string | undefined {
  if (!comment) return undefined;
  const text = comment
    .split("\n")
    .map((line) => line.replace(/^ ?/, "").trimEnd())
    .join("\n")
    .trim();
  if (!text) return undefined;
  return text.length > MAX_COMMENT
    ? `${text.slice(0, MAX_COMMENT - 1)}…`
    : text;
}

/**
 * The file's leading comment block: the document comment at the top, else
 * the first comment written before a top-level key (actions often put it
 * after `name:`), stopping at `steps:`.
 */
export function leadingComment(doc: Document): string | undefined {
  const top = cleanComment(doc.commentBefore);
  if (top) return top;
  const contents = doc.contents;
  if (!isMap(contents)) return undefined;
  const mapComment = cleanComment(contents.commentBefore);
  if (mapComment) return mapComment;
  for (const pair of contents.items) {
    const key = isScalar(pair.key) ? pair.key : undefined;
    const before = cleanComment(key?.commentBefore);
    if (before) return before;
    if (key?.value === "steps") break;
  }
  return undefined;
}

/** Every comment in the document joined, for query ranking only. */
export function allComments(doc: Document): string {
  const out: string[] = [];
  const add = (c: string | null | undefined): void => {
    const clean = cleanComment(c);
    if (clean) out.push(clean);
  };
  add(doc.commentBefore);
  add(doc.comment);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    add(n.commentBefore);
    add(n.comment);
    if (isMap(n) || isSeq(n)) {
      for (const item of n.items as unknown[]) {
        if (item && typeof item === "object" && "key" in item) {
          const pair = item as Pair;
          visit(pair.key);
          visit(pair.value);
        } else {
          visit(item);
        }
      }
    }
  };
  visit(doc.contents);
  return out.join("\n");
}

export interface MapEntry {
  key: string;
  /** The YAML node of the value (aliases resolved for merges only). */
  value: unknown;
  comment?: string;
  /** Set when the entry came in through a `<<:` merge key. */
  inheritedFrom?: string;
}

/**
 * The entries of a YAML map with the comment above (or after) each key.
 * Keys pulled in through `<<: *anchor` merge keys are listed after the
 * map's own keys as inherited (own keys win), with the anchor's owner as
 * `inheritedFrom` (via `ownerOf`, else `&anchor`).
 */
export function mapEntries(
  map: YAMLMap,
  doc: Document,
  ownerOf: (anchor: string) => string | undefined = () => undefined,
): MapEntry[] {
  const own: MapEntry[] = [];
  const inherited: MapEntry[] = [];
  map.items.forEach((pair, index) => {
    const keyNode = isScalar(pair.key) ? pair.key : undefined;
    const rawKey = keyNode?.value;
    if (typeof rawKey === "symbol" || rawKey === "<<") {
      const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
      for (const source of sources) {
        if (!isAlias(source)) continue;
        const target = source.resolve(doc);
        if (!isMap(target)) continue;
        const from = ownerOf(source.source) ?? `&${source.source}`;
        for (const entry of mapEntries(target, doc, ownerOf)) {
          inherited.push({
            ...entry,
            inheritedFrom: entry.inheritedFrom ?? from,
          });
        }
      }
      return;
    }
    if (rawKey === undefined || rawKey === null) return;
    const comment =
      cleanComment(keyNode?.commentBefore) ??
      (index === 0 ? cleanComment(map.commentBefore) : undefined) ??
      cleanComment(
        (pair.value as Node | null | undefined)?.comment ?? undefined,
      );
    own.push({
      key: String(rawKey),
      value: pair.value,
      ...(comment ? { comment } : {}),
    });
  });
  const seen = new Set(own.map((e) => e.key));
  const out = [...own];
  for (const entry of inherited) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry);
  }
  return out;
}

/** The plain JS value of a YAML value node (aliases resolved). */
export function nodeValue(node: unknown, doc: Document): unknown {
  if (isAlias(node)) return nodeValue(node.resolve(doc), doc);
  if (isScalar(node)) return node.value;
  if (isMap(node) || isSeq(node)) return node.toJSON();
  return node;
}
