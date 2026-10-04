/**
 * `--mutate` operators (E5): invert one assertion of one outcome in a temp
 * copy of an exported test. A faithful test must then FAIL at that outcome;
 * a mutant that still passes means the assertion is not effective (it is
 * not awaited, swallowed, or never evaluated).
 *
 * Operating on the generated source is deliberate: it tests the artifact a
 * host actually runs. The `test.step` blocks are found on the TypeScript
 * syntax tree, so a host's prettier (single quotes, a call broken over
 * lines) changes nothing; the assertion inside is found by a scanner that
 * skips strings, template literals, comments and regex literals while
 * matching brackets.
 */
import type * as TS from "typescript";

export interface OutcomeBlock {
  id: string;
  /** Index of the first character of the step callback body (after `{`). */
  bodyStart: number;
  /** Index of the `}` that closes the callback. */
  bodyEnd: number;
}

export type MutationResult =
  | { applicable: true; source: string; operator: string }
  | { applicable: false; reason: string };

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Index after a string / template / comment / regex literal starting at `i`, else `i`. */
function skipLiteral(source: string, i: number, prev: string): number {
  const ch = source[i]!;
  if (ch === '"' || ch === "'") {
    let j = i + 1;
    while (j < source.length && source[j] !== ch) {
      j += source[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  }
  if (ch === "`") return skipTemplate(source, i);
  if (ch === "/") {
    const next = source[i + 1];
    if (next === "/") {
      const end = source.indexOf("\n", i);
      return end < 0 ? source.length : end;
    }
    if (next === "*") {
      const end = source.indexOf("*/", i + 2);
      return end < 0 ? source.length : end + 2;
    }
    // A slash after an operator or an opening bracket starts a regex literal.
    if (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") return i + 1;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) return j + 1;
        j += 1;
      }
      return i + 1;
    }
  }
  return i;
}

function skipTemplate(source: string, start: number): number {
  let j = start + 1;
  while (j < source.length) {
    const c = source[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j + 1;
    if (c === "$" && source[j + 1] === "{") {
      j = matchBracket(source, j + 1) + 1;
      continue;
    }
    j += 1;
  }
  return source.length;
}

/** Index of the bracket closing the one at `open` (source.length when unbalanced). */
export function matchBracket(source: string, open: number): number {
  const openers = "([{";
  const closers = ")]}";
  let depth = 0;
  let prev = "";
  let i = open;
  while (i < source.length) {
    const skipped = skipLiteral(source, i, prev);
    if (skipped !== i) {
      prev = '"';
      i = skipped;
      continue;
    }
    const ch = source[i]!;
    if (openers.includes(ch)) depth += 1;
    else if (closers.includes(ch)) {
      depth -= 1;
      if (depth === 0) return i;
    }
    if (!/\s/.test(ch)) prev = ch;
    i += 1;
  }
  return source.length;
}

/** A `test.step(<title>, <function>)` call of a test, in source order. */
export interface StepCall extends OutcomeBlock {
  /** Index of the call (for ordering against the contract marker). */
  start: number;
}

/**
 * Every `test.step(<string>, <function with a block body>)` call of a test
 * file, read from its TypeScript syntax tree: any quote style, any line
 * breaks, a template title without substitutions.
 */
export function findStepCalls(
  ts: typeof TS,
  source: string,
  fileName = "test.ts",
): StepCall[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const calls: StepCall[] = [];
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "step" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "test"
    ) {
      const [title, fn] = node.arguments;
      if (
        title &&
        (ts.isStringLiteral(title) ||
          ts.isNoSubstitutionTemplateLiteral(title)) &&
        fn &&
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        ts.isBlock(fn.body)
      ) {
        calls.push({
          id: title.text,
          start: node.getStart(sourceFile),
          bodyStart: fn.body.getStart(sourceFile) + 1,
          bodyEnd: fn.body.getEnd() - 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls.toSorted((a, b) => a.start - b.start);
}

/** The comment the exporter writes before a test's outcome steps. */
export const OUTCOMES_MARKER = "--- outcomes (the contract) ---";

/**
 * The outcome ids of an exported test, in order. With the spec's own outcome
 * ids (read from the source spec the manifest names) a step is an outcome
 * when its title is one; without them, the steps after the contract marker
 * (never `teardown: …` steps).
 */
export function outcomeStepIds(
  calls: readonly StepCall[],
  source: string,
  specOutcomeIds?: readonly string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const marker = source.indexOf(OUTCOMES_MARKER);
  const wanted = specOutcomeIds ? new Set(specOutcomeIds) : undefined;
  for (const call of calls) {
    if (seen.has(call.id)) continue;
    if (wanted) {
      if (!wanted.has(call.id)) continue;
    } else if (
      marker < 0 ||
      call.start < marker ||
      call.id.startsWith("teardown: ")
    ) {
      continue;
    }
    seen.add(call.id);
    ids.push(call.id);
  }
  return ids;
}

/** The `await test.step("<outcome id>", async () => { … })` blocks of a test. */
export function findOutcomeBlocks(
  source: string,
  outcomeIds: readonly string[],
  /** Read the blocks from the syntax tree (formatting-proof) when given. */
  ts?: typeof TS,
): OutcomeBlock[] {
  if (ts) {
    const calls = findStepCalls(ts, source);
    return outcomeIds.flatMap((id) => {
      const call = calls.find((c) => c.id === id);
      return call
        ? [{ id, bodyStart: call.bodyStart, bodyEnd: call.bodyEnd }]
        : [];
    });
  }
  const blocks: OutcomeBlock[] = [];
  for (const id of outcomeIds) {
    const head = `test.step(${JSON.stringify(id)}, async () => {`;
    const at = source.indexOf(head);
    if (at < 0) continue;
    const open = at + head.length - 1;
    const close = matchBracket(source, open);
    if (close >= source.length) continue;
    blocks.push({ id, bodyStart: open + 1, bodyEnd: close });
  }
  return blocks;
}

interface ExpectSite {
  /** Index of `expect`. */
  start: number;
  /** Index just after the call's closing `)`. */
  afterCall: number;
  matcher: string;
  negated: boolean;
  /** `.not` token range when negated (to remove it). */
  notAt?: number;
}

/**
 * The `expect` a call starts with at `i` (`expect`, or a poll sample's
 * non-retrying `cairnSampleExpect`), else undefined.
 */
function expectNameAt(source: string, i: number): string | undefined {
  if (i > 0 && (IDENT_CHAR.test(source[i - 1]!) || source[i - 1] === ".")) {
    return undefined;
  }
  for (const name of ["expect", "cairnSampleExpect"]) {
    if (
      source.startsWith(name, i) &&
      !IDENT_CHAR.test(source[i + name.length] ?? "")
    ) {
      return name;
    }
  }
  return undefined;
}

/** Every `expect(…)` / `expect.poll(…)` / `expect.soft(…)` call in a body. */
function findExpectSites(
  source: string,
  from: number,
  to: number,
): ExpectSite[] {
  const sites: ExpectSite[] = [];
  let prev = "";
  let i = from;
  while (i < to) {
    const skipped = skipLiteral(source, i, prev);
    if (skipped !== i) {
      prev = '"';
      i = skipped;
      continue;
    }
    const name = expectNameAt(source, i);
    if (name) {
      let j = i + name.length;
      const suffix = /^\.(poll|soft)/.exec(source.slice(j, j + 6));
      if (suffix) j += suffix[0].length;
      if (source[j] === "(") {
        const close = matchBracket(source, j);
        if (close < to) {
          let k = close + 1;
          let negated = false;
          let notAt: number | undefined;
          const not = /^\s*\.not\b/.exec(source.slice(k, k + 12));
          if (not) {
            negated = true;
            notAt = k + not[0].indexOf(".not");
            k += not[0].length;
          }
          const matcher = /^\s*\.(?:resolves\.|rejects\.)?([A-Za-z]+)/.exec(
            source.slice(k, k + 60),
          );
          if (matcher) {
            sites.push({
              start: i,
              afterCall: close + 1,
              matcher: matcher[1]!,
              negated,
              ...(notAt !== undefined ? { notAt } : {}),
            });
          }
          // Keep scanning INSIDE the call: a `toPass` wraps the real assertion.
          prev = "(";
          i = j + 1;
          continue;
        }
      }
    }
    if (!/\s/.test(source[i]!)) prev = source[i]!;
    i += 1;
  }
  return sites;
}

/** Matchers that carry no expectation of their own (they retry a callback). */
const WRAPPER_MATCHERS = new Set(["toPass"]);

/**
 * Invert the first assertion of the outcome's step: `expect(x).toY(…)` becomes
 * `expect(x).not.toY(…)` (and a negated one loses its `.not`). Returns why
 * nothing could be flipped when the outcome has no `expect` to invert (the
 * runner's judge helpers throw on their own; there is no matcher to negate).
 */
export function mutateOutcome(
  source: string,
  block: OutcomeBlock,
): MutationResult {
  const sites = findExpectSites(source, block.bodyStart, block.bodyEnd).filter(
    (site) => !WRAPPER_MATCHERS.has(site.matcher),
  );
  const site = sites[0];
  if (!site) {
    return {
      applicable: false,
      reason:
        "no expect(...) assertion to invert (the outcome is judged by a helper that throws)",
    };
  }
  if (site.negated && site.notAt !== undefined) {
    return {
      applicable: true,
      operator: `not.${site.matcher} -> ${site.matcher}`,
      source: `${source.slice(0, site.notAt)}${source.slice(site.notAt + ".not".length)}`,
    };
  }
  return {
    applicable: true,
    operator: `${site.matcher} -> not.${site.matcher}`,
    source: `${source.slice(0, site.afterCall)}.not${source.slice(site.afterCall)}`,
  };
}

/** `foo.spec.ts` -> `foo-cairn-verify-mutant.spec.ts` (keeps the test-match suffix). */
export function mutantFileName(fileName: string): string {
  const dot = fileName.indexOf(".");
  return dot < 0
    ? `${fileName}-cairn-verify-mutant`
    : `${fileName.slice(0, dot)}-cairn-verify-mutant${fileName.slice(dot)}`;
}

export const MUTANT_FILE_MARKER = "-cairn-verify-mutant";
