/**
 * Snapshot-tree "near" scoring for semantic locators.
 *
 * A match is near some visible text when they share a tight ancestor (a card,
 * row, or listitem). When the page is flat (the only shared ancestor is the
 * root), fall back to the closest match by snapshot index so a heading and its
 * sibling button still bind.
 */

export interface NearSnapshotNode {
  level: number;
  name?: string;
}

export function normalizeNearText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function ancestorIndices(
  index: number,
  snapshot: Array<{ level: number }>,
): number[] {
  const node = snapshot[index];
  if (!node) return [];
  const out: number[] = [index];
  let level = node.level;
  for (let i = index - 1; i >= 0; i--) {
    if (snapshot[i]!.level < level) {
      out.push(i);
      level = snapshot[i]!.level;
    }
  }
  return out;
}

export function lcaIndex(
  a: number,
  b: number,
  snapshot: Array<{ level: number }>,
): number | undefined {
  const ancestorsB = new Set(ancestorIndices(b, snapshot));
  for (const idx of ancestorIndices(a, snapshot)) {
    if (ancestorsB.has(idx)) return idx;
  }
  return undefined;
}

/**
 * Keep locator matches that sit nearest to `near` text in the snapshot tree.
 * Returns an empty list when the near text is not present.
 */
export function pickNearestSnapshotMatches(
  matchIndices: number[],
  snapshot: NearSnapshotNode[],
  near: string,
): number[] {
  if (matchIndices.length === 0) return [];
  const needle = normalizeNearText(near);
  if (needle.length === 0) return [];

  const nearIndices: number[] = [];
  for (let i = 0; i < snapshot.length; i++) {
    const name = snapshot[i]!.name;
    if (name && normalizeNearText(name).includes(needle)) nearIndices.push(i);
  }
  if (nearIndices.length === 0) return [];

  const scores = matchIndices.map((matchIdx) => {
    let best = -1;
    for (const nearIdx of nearIndices) {
      const lca = lcaIndex(matchIdx, nearIdx, snapshot);
      if (lca !== undefined) best = Math.max(best, snapshot[lca]!.level);
    }
    return best;
  });
  const max = Math.max(...scores);
  if (max < 0) return [];

  if (max > 0) {
    return matchIndices.filter((_, i) => scores[i] === max);
  }

  // Flat page: pick the match with the smallest index distance to a near-text
  // node. When two matches sit the same distance away (heading between two
  // Opens), prefer the one after the text — heading then button is reading
  // order. Remaining ties stay so `nth:` can disambiguate.
  const scored = matchIndices.map((matchIdx) => {
    let dist = Number.POSITIVE_INFINITY;
    let nearIdx = -1;
    for (const candidate of nearIndices) {
      const next = Math.abs(matchIdx - candidate);
      if (next < dist) {
        dist = next;
        nearIdx = candidate;
      }
    }
    return { matchIdx, dist, nearIdx };
  });
  const min = Math.min(...scored.map((row) => row.dist));
  const tied = scored.filter((row) => row.dist === min);
  const after = tied.filter((row) => row.matchIdx > row.nearIdx);
  return (after.length > 0 ? after : tied).map((row) => row.matchIdx);
}
