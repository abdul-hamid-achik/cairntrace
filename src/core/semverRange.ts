/**
 * A small semver range matcher (no dependency): enough for config
 * `requires.cairntrace` and `runtimes.node.version`.
 *
 * Supported: comparators (`>=1.2.3`, `>1`, `<=2.0`, `<3`, `=1.2.3`, a bare
 * version), caret (`^1.2.3`), tilde (`~1.2.3`), x-ranges (`1.x`, `1.2.*`, `*`),
 * hyphen ranges (`1.2.3 - 2.3.4`), AND (whitespace) and OR (`||`). A
 * pre-release (`3.1.0-rc.1`) sorts below its release and never satisfies a
 * range that does not name a pre-release of the same version.
 *
 * Validity follows npm's `semver`: no leading zeros (`03.0.1`,
 * `^3.0.01`, `1.0.0-rc.01`), a pre-release only after a third part
 * (`*-3` and `1.2-rc.1` are invalid; `1.2.x-rc.1` drops it), and once a
 * part is `x` the rest must be too (`3.x.1`, `x.1.2`, `>=1.x.3` are
 * invalid) — except in a caret, a tilde or a hyphen end, which read them as
 * `x` (`^1.x.3` = `^1.x`). Like npm, a `>=0.0.0` bound is dropped.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const NUM = "0|[1-9]\\d*";
const PART = `${NUM}|[xX*]`;
const PRE_ID = "0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*";
const PRE = `(?:${PRE_ID})(?:\\.(?:${PRE_ID}))*`;
const BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
/** A partial version (`1`, `1.x`, `1.2.3-rc.1`): a pre-release only after a third part. */
const VERSION_RE = new RegExp(
  `^v?(${PART})(?:\\.(${PART})(?:\\.(${PART})(?:-(${PRE}))?)?)?(?:\\+${BUILD})?$`,
);
const FULL_VERSION_RE = new RegExp(
  `^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}))?(?:\\+${BUILD})?$`,
);

/** Parse a full `1.2.3[-pre]` version (a leading `v` is accepted). */
export function parseVersion(text: string): SemVer | undefined {
  const match = FULL_VERSION_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) {
      if (Number(left) !== Number(right)) {
        return Number(left) < Number(right) ? -1 : 1;
      }
    } else if (leftNumber !== rightNumber) {
      return leftNumber ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  version: SemVer;
}

interface Partial3 {
  major: number | "x";
  minor: number | "x";
  patch: number | "x";
  prerelease: string[];
}

function wildcardPart(raw: string | undefined): number | "x" {
  return raw === undefined || /^[xX*]$/.test(raw) ? "x" : Number(raw);
}

/**
 * A partial version. Once a part is `x`, a later number is invalid unless
 * `lenient` (a caret, a tilde, a hyphen end), which reads it as `x`. A
 * pre-release next to an `x` is dropped, as npm does.
 */
function parsePartial(text: string, lenient = false): Partial3 | undefined {
  const match = VERSION_RE.exec(text.trim());
  if (!match) return undefined;
  let seenX = false;
  for (const raw of [match[1], match[2], match[3]]) {
    if (raw === undefined) break;
    if (/^[xX*]$/.test(raw)) seenX = true;
    else if (seenX && !lenient) return undefined;
  }
  const part = wildcardPart;
  const major = part(match[1]);
  const minor = major === "x" ? "x" : part(match[2]);
  const patch = minor === "x" ? "x" : part(match[3]);
  return {
    major,
    minor,
    patch,
    prerelease: match[4] && patch !== "x" ? match[4].split(".") : [],
  };
}

function floor(p: Partial3): SemVer {
  return {
    major: p.major === "x" ? 0 : p.major,
    minor: p.minor === "x" ? 0 : p.minor,
    patch: p.patch === "x" ? 0 : p.patch,
    prerelease: p.prerelease,
  };
}

/** The first version above everything `p` covers. */
function ceilingExclusive(p: Partial3): SemVer | undefined {
  if (p.major === "x") return undefined;
  if (p.minor === "x") {
    return { major: p.major + 1, minor: 0, patch: 0, prerelease: [] };
  }
  if (p.patch === "x") {
    return { major: p.major, minor: p.minor + 1, patch: 0, prerelease: [] };
  }
  return undefined;
}

/** One whitespace-free token → comparators, or undefined when malformed. */
function tokenComparators(token: string): Comparator[] | undefined {
  const caret = /^\^(.+)$/.exec(token);
  const tilde = /^~>?(.+)$/.exec(token);
  const op = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (caret) {
    const p = parsePartial(caret[1]!, true);
    if (!p) return undefined;
    if (p.major === "x") return [];
    const lower = floor(p);
    const minor = p.minor === "x" ? undefined : p.minor;
    const patch = p.patch === "x" ? undefined : p.patch;
    let upper: SemVer;
    if (p.major > 0 || minor === undefined) {
      upper = { major: p.major + 1, minor: 0, patch: 0, prerelease: [] };
    } else if (minor > 0 || patch === undefined) {
      upper = { major: 0, minor: minor + 1, patch: 0, prerelease: [] };
    } else {
      upper = { major: 0, minor: 0, patch: patch + 1, prerelease: [] };
    }
    return [
      { op: ">=", version: lower },
      { op: "<", version: upper },
    ];
  }
  if (tilde) {
    const p = parsePartial(tilde[1]!, true);
    if (!p) return undefined;
    if (p.major === "x") return [];
    const upper: SemVer =
      p.minor === "x"
        ? { major: p.major + 1, minor: 0, patch: 0, prerelease: [] }
        : { major: p.major, minor: p.minor + 1, patch: 0, prerelease: [] };
    return [
      { op: ">=", version: floor(p) },
      { op: "<", version: upper },
    ];
  }
  if (!op) return undefined;
  const p = parsePartial(op[2]!);
  if (!p) return undefined;
  const operator = op[1] ?? "=";
  const wildcard = p.major === "x" || p.minor === "x" || p.patch === "x";
  if (!wildcard) {
    return [{ op: operator as Comparator["op"], version: floor(p) }];
  }
  if (p.major === "x") {
    // `*`, `>=*` match everything; `<*` / `>*` match nothing.
    return operator === "<" || operator === ">"
      ? [
          {
            op: "<",
            version: { major: 0, minor: 0, patch: 0, prerelease: [] },
          },
        ]
      : [];
  }
  const lower = floor(p);
  const upper = ceilingExclusive(p)!;
  switch (operator) {
    case "=":
      return [
        { op: ">=", version: lower },
        { op: "<", version: upper },
      ];
    case ">=":
      return [{ op: ">=", version: lower }];
    case ">":
      return [{ op: ">=", version: upper }];
    case "<":
      return [{ op: "<", version: lower }];
    case "<=":
      return [{ op: "<", version: upper }];
    default:
      return undefined;
  }
}

/** Parse a range into OR-groups of AND-ed comparators; undefined when invalid. */
function parseRange(range: string): Comparator[][] | undefined {
  const groups: Comparator[][] = [];
  for (const rawGroup of range.split("||")) {
    const group = rawGroup.trim();
    if (group === "") {
      groups.push([]);
      continue;
    }
    // Hyphen range: `1.2.3 - 2.3.4`.
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(group);
    if (hyphen) {
      const from = parsePartial(hyphen[1]!, true);
      const to = parsePartial(hyphen[2]!, true);
      if (!from || !to) return undefined;
      const comparators: Comparator[] = [];
      if (from.major !== "x")
        comparators.push({ op: ">=", version: floor(from) });
      if (to.major !== "x") {
        const ceiling = ceilingExclusive(to);
        comparators.push(
          ceiling
            ? { op: "<", version: ceiling }
            : { op: "<=", version: floor(to) },
        );
      }
      groups.push(withoutGte0(comparators));
      continue;
    }
    // `>= 1.2` (operator separated from its version) joins up first.
    const tokens = group
      .replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean);
    const comparators: Comparator[] = [];
    for (const token of tokens) {
      const parsed = tokenComparators(token);
      if (!parsed) return undefined;
      comparators.push(...parsed);
    }
    groups.push(withoutGte0(comparators));
  }
  return groups;
}

/**
 * npm drops a `>=0.0.0` bound (it only excludes pre-releases of 0.0.0, which
 * the pre-release rule handles): `0.x - 0.0.0-rc.2` admits `0.0.0-0`.
 */
function withoutGte0(comparators: Comparator[]): Comparator[] {
  return comparators.filter(
    ({ op, version }) =>
      !(
        op === ">=" &&
        version.major === 0 &&
        version.minor === 0 &&
        version.patch === 0 &&
        version.prerelease.length === 0
      ),
  );
}

/** A range problem message, or undefined when `range` is valid. */
export function rangeProblem(range: string): string | undefined {
  if (range.trim() === "") return "a version range cannot be empty";
  return parseRange(range)
    ? undefined
    : `"${range}" is not a valid semver range (examples: ">=3.0", "^3.1.0", "3.x", ">=3.0 <4")`;
}

/** True when `version` satisfies `range`. An invalid range or version never does. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const groups = parseRange(range);
  if (!parsed || !groups) return false;
  return groups.some((group) => {
    const matches = group.every(({ op, version: bound }) => {
      const cmp = compareVersions(parsed, bound);
      switch (op) {
        case ">=":
          return cmp >= 0;
        case ">":
          return cmp > 0;
        case "<=":
          return cmp <= 0;
        case "<":
          return cmp < 0;
        case "=":
          return cmp === 0;
      }
    });
    if (!matches) return false;
    // A pre-release only satisfies a range that names a pre-release of the
    // same major.minor.patch.
    if (parsed.prerelease.length > 0) {
      return group.some(
        ({ version: bound }) =>
          bound.prerelease.length > 0 &&
          bound.major === parsed.major &&
          bound.minor === parsed.minor &&
          bound.patch === parsed.patch,
      );
    }
    return true;
  });
}
