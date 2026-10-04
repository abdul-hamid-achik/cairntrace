/**
 * A small assertion language for `run.preflight[].assert` (and anything else
 * that needs "is this JSON document in the expected shape"). It is parsed by
 * a real tokenizer + recursive-descent parser and evaluated by a tree walk:
 * nothing here is ever handed to `eval` / `new Function`.
 *
 * Grammar (lowest to highest precedence):
 *
 *   expr     := or
 *   or       := and ( ("or" | "||") and )*
 *   and      := not ( ("and" | "&&") not )*
 *   not      := ("not" | "!") not | compare
 *   compare  := operand ( cmpOp operand | "in" list | "exists" )?
 *   cmpOp    := "==" | "!=" | "<" | "<=" | ">" | ">="
 *   operand  := path | literal | "(" expr ")"
 *   list     := "[" ( literal ( "," literal )* )? "]"
 *   literal  := number | string | "true" | "false" | "null"
 *   path     := "."? name ( "." name | "[" integer "]" | "[" string "]" )*
 *
 * A bare path is truthy when its value is present, not null, not false, not
 * 0 and not "". A missing path compares unequal to everything (so
 * `.a == null` is false when `.a` is absent; use `not (.a exists)`), and an
 * ordering comparison against a missing path or a type mismatch is false.
 * `exists` is true for a present, non-null value.
 */

export class ExpressionSyntaxError extends Error {
  override name = "ExpressionSyntaxError";
  constructor(
    message: string,
    /** 0-based offset into the source. */
    readonly offset: number,
  ) {
    super(message);
  }
}

type Token =
  | { kind: "path"; segments: Array<string | number>; at: number }
  | { kind: "number"; value: number; at: number }
  | { kind: "string"; value: string; at: number }
  | { kind: "word"; value: string; at: number }
  | { kind: "op"; value: string; at: number }
  | { kind: "end"; at: number };

const NAME_START = /[A-Za-z_$]/;
const NAME_PART = /[A-Za-z0-9_$-]/;

/**
 * Bounds that keep a hostile or runaway assertion from exhausting the stack:
 * nesting (`(`, `not`, `!`) deeper than {@link MAX_NESTING} and more than
 * {@link MAX_TOKENS} tokens are syntax errors, never a RangeError.
 */
export const MAX_NESTING = 64;
export const MAX_TOKENS = 1024;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const at = i;
    if (ch === '"' || ch === "'") {
      const { value, next } = readString(source, i);
      tokens.push({ kind: "string", value, at });
      i = next;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      const text = m![0];
      tokens.push({ kind: "number", value: Number(text), at });
      i += text.length;
      continue;
    }
    if (ch === "." || NAME_START.test(ch)) {
      // A path, or a keyword (and / or / not / in / exists / true / false / null).
      const { segments, next } = readPath(source, i);
      const only = segments.length === 1 ? segments[0] : undefined;
      const text = source.slice(i, next);
      if (
        typeof only === "string" &&
        !text.startsWith(".") &&
        KEYWORDS.has(only)
      ) {
        tokens.push({ kind: "word", value: only, at });
      } else {
        tokens.push({ kind: "path", segments, at });
      }
      i = next;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ kind: "op", value: two, at });
      i += 2;
      continue;
    }
    if ("<>()[],!".includes(ch)) {
      tokens.push({ kind: "op", value: ch, at });
      i += 1;
      continue;
    }
    throw new ExpressionSyntaxError(
      `unexpected character ${JSON.stringify(ch)}`,
      at,
    );
  }
  tokens.push({ kind: "end", at: n });
  return tokens;
}

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "in",
  "exists",
  "true",
  "false",
  "null",
]);

function readString(
  source: string,
  start: number,
): { value: string; next: number } {
  const quote = source[start]!;
  let i = start + 1;
  let value = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      const esc = source[i + 1];
      if (esc === undefined) break;
      value +=
        esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, next: i + 1 };
    value += ch;
    i += 1;
  }
  throw new ExpressionSyntaxError("unterminated string", start);
}

function readPath(
  source: string,
  start: number,
): { segments: Array<string | number>; next: number } {
  const segments: Array<string | number> = [];
  let i = start;
  let first = true;
  for (;;) {
    const ch = source[i];
    if (ch === ".") {
      i += 1;
      const name = readName(source, i);
      if (name === undefined) {
        throw new ExpressionSyntaxError("expected a name after '.'", i);
      }
      segments.push(name);
      i += name.length;
    } else if (ch === "[") {
      const close = source.indexOf("]", i);
      if (close < 0) throw new ExpressionSyntaxError("unterminated '['", i);
      const inner = source.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else if (inner.startsWith('"') || inner.startsWith("'")) {
        const { value, next } = readString(inner, 0);
        if (next !== inner.length) {
          throw new ExpressionSyntaxError("bad key inside '[...]'", i);
        }
        segments.push(value);
      } else {
        throw new ExpressionSyntaxError(
          "expected an integer or a quoted key inside '[...]'",
          i,
        );
      }
      i = close + 1;
    } else if (first) {
      const name = readName(source, i);
      if (name === undefined) {
        throw new ExpressionSyntaxError("expected a path", i);
      }
      segments.push(name);
      i += name.length;
    } else {
      break;
    }
    first = false;
  }
  return { segments, next: i };
}

function readName(source: string, at: number): string | undefined {
  if (!NAME_START.test(source[at] ?? "")) return undefined;
  let end = at + 1;
  while (end < source.length && NAME_PART.test(source[end]!)) end += 1;
  return source.slice(at, end);
}

/* ----- AST ----- */

export type Literal = string | number | boolean | null;

export type ExpressionNode =
  | { type: "path"; segments: Array<string | number> }
  | { type: "literal"; value: Literal }
  | { type: "list"; items: Literal[] }
  | { type: "not"; operand: ExpressionNode }
  | { type: "and" | "or"; left: ExpressionNode; right: ExpressionNode }
  | {
      type: "compare";
      op: "==" | "!=" | "<" | "<=" | ">" | ">=";
      left: ExpressionNode;
      right: ExpressionNode;
    }
  | { type: "in"; left: ExpressionNode; list: ExpressionNode }
  | { type: "exists"; operand: ExpressionNode };

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  /** One more level of `(` / `not` nesting; a syntax error past the bound. */
  private enter(at: number): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING) {
      throw new ExpressionSyntaxError(
        `the expression nests deeper than ${MAX_NESTING} levels`,
        at,
      );
    }
  }

  parse(): ExpressionNode {
    const node = this.or();
    const t = this.peek();
    if (t.kind !== "end") {
      throw new ExpressionSyntaxError(`unexpected ${describe(t)}`, t.at);
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private isWord(value: string): boolean {
    const t = this.peek();
    return t.kind === "word" && t.value === value;
  }

  private isOp(...values: string[]): boolean {
    const t = this.peek();
    return t.kind === "op" && values.includes(t.value);
  }

  private or(): ExpressionNode {
    let left = this.and();
    while (this.isWord("or") || this.isOp("||")) {
      this.next();
      left = { type: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): ExpressionNode {
    let left = this.not();
    while (this.isWord("and") || this.isOp("&&")) {
      this.next();
      left = { type: "and", left, right: this.not() };
    }
    return left;
  }

  private not(): ExpressionNode {
    if (this.isWord("not") || this.isOp("!")) {
      this.enter(this.next().at);
      const operand = this.not();
      this.depth -= 1;
      return { type: "not", operand };
    }
    return this.compare();
  }

  private compare(): ExpressionNode {
    const left = this.operand();
    if (this.isOp("==", "!=", "<", "<=", ">", ">=")) {
      const op = (this.next() as { value: string }).value as
        | "=="
        | "!="
        | "<"
        | "<="
        | ">"
        | ">=";
      return { type: "compare", op, left, right: this.operand() };
    }
    if (this.isWord("in")) {
      this.next();
      return { type: "in", left, list: this.list() };
    }
    if (this.isWord("exists")) {
      this.next();
      return { type: "exists", operand: left };
    }
    return left;
  }

  private list(): ExpressionNode {
    const open = this.next();
    if (open.kind !== "op" || open.value !== "[") {
      throw new ExpressionSyntaxError(
        '\'in\' needs a list such as [1, 2] or ["a", "b"]',
        open.at,
      );
    }
    const items: Literal[] = [];
    if (this.isOp("]")) {
      this.next();
      return { type: "list", items };
    }
    for (;;) {
      const t = this.next();
      const literal = literalOf(t);
      if (literal === undefined) {
        throw new ExpressionSyntaxError(
          `a list holds literals, got ${describe(t)}`,
          t.at,
        );
      }
      items.push(literal.value);
      if (this.isOp(",")) {
        this.next();
        continue;
      }
      const close = this.next();
      if (close.kind !== "op" || close.value !== "]") {
        throw new ExpressionSyntaxError("expected ',' or ']'", close.at);
      }
      return { type: "list", items };
    }
  }

  private operand(): ExpressionNode {
    const t = this.next();
    if (t.kind === "path") return { type: "path", segments: t.segments };
    const literal = literalOf(t);
    if (literal) return { type: "literal", value: literal.value };
    if (t.kind === "op" && t.value === "(") {
      this.enter(t.at);
      const inner = this.or();
      this.depth -= 1;
      const close = this.next();
      if (close.kind !== "op" || close.value !== ")") {
        throw new ExpressionSyntaxError("expected ')'", close.at);
      }
      return inner;
    }
    throw new ExpressionSyntaxError(`unexpected ${describe(t)}`, t.at);
  }
}

function literalOf(t: Token): { value: Literal } | undefined {
  if (t.kind === "number") return { value: t.value };
  if (t.kind === "string") return { value: t.value };
  if (t.kind === "word") {
    if (t.value === "true") return { value: true };
    if (t.value === "false") return { value: false };
    if (t.value === "null") return { value: null };
  }
  return undefined;
}

function describe(t: Token): string {
  switch (t.kind) {
    case "end":
      return "end of expression";
    case "path":
      return "a path";
    case "number":
      return `number ${t.value}`;
    case "string":
      return "a string";
    case "word":
      return `'${t.value}'`;
    case "op":
      return `'${t.value}'`;
  }
}

/** Parse an assertion. Throws {@link ExpressionSyntaxError}. */
export function parseExpression(source: string): ExpressionNode {
  if (source.trim() === "") {
    throw new ExpressionSyntaxError("empty expression", 0);
  }
  const tokens = tokenize(source);
  // The trailing `end` token does not count.
  if (tokens.length - 1 > MAX_TOKENS) {
    throw new ExpressionSyntaxError(
      `the expression has more than ${MAX_TOKENS} tokens`,
      tokens[MAX_TOKENS]!.at,
    );
  }
  return new Parser(tokens).parse();
}

/** `parseExpression` as a message for schema refinements; undefined when valid. */
export function expressionProblem(source: string): string | undefined {
  try {
    parseExpression(source);
    return undefined;
  } catch (error) {
    if (error instanceof ExpressionSyntaxError) {
      return `${error.message} (at offset ${error.offset})`;
    }
    throw error;
  }
}

/* ----- evaluation ----- */

const MISSING = Symbol("missing");
type Value = unknown | typeof MISSING;

function readPathValue(root: unknown, segments: Array<string | number>): Value {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return MISSING;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return MISSING;
      const index = segment < 0 ? current.length + segment : segment;
      if (index < 0 || index >= current.length) return MISSING;
      current = current[index];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return MISSING;
      if (!Object.hasOwn(current as object, segment)) return MISSING;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function valueOf(node: ExpressionNode, root: unknown): Value {
  switch (node.type) {
    case "path":
      return readPathValue(root, node.segments);
    case "literal":
      return node.value;
    case "list":
      return node.items;
    default:
      return evaluateNode(node, root);
  }
}

function truthy(value: Value): boolean {
  if (value === MISSING || value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  return true;
}

function looselySame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function evaluateNode(node: ExpressionNode, root: unknown): boolean {
  switch (node.type) {
    case "path":
    case "literal":
    case "list":
      return truthy(valueOf(node, root));
    case "not":
      return !evaluateNode(node.operand, root);
    case "and":
      return evaluateNode(node.left, root) && evaluateNode(node.right, root);
    case "or":
      return evaluateNode(node.left, root) || evaluateNode(node.right, root);
    case "exists": {
      const v = valueOf(node.operand, root);
      return v !== MISSING && v !== null && v !== undefined;
    }
    case "in": {
      const v = valueOf(node.left, root);
      if (v === MISSING) return false;
      const list = valueOf(node.list, root);
      return Array.isArray(list) && list.some((item) => looselySame(item, v));
    }
    case "compare": {
      const a = valueOf(node.left, root);
      const b = valueOf(node.right, root);
      if (a === MISSING || b === MISSING) return node.op === "!=";
      switch (node.op) {
        case "==":
          return looselySame(a, b);
        case "!=":
          return !looselySame(a, b);
        default: {
          const ordered =
            (typeof a === "number" && typeof b === "number") ||
            (typeof a === "string" && typeof b === "string");
          if (!ordered) return false;
          const x = a as number | string;
          const y = b as number | string;
          if (node.op === "<") return x < y;
          if (node.op === "<=") return x <= y;
          if (node.op === ">") return x > y;
          return x >= y;
        }
      }
    }
  }
}

/** Evaluate a parsed expression against a JSON document. */
export function evaluateExpression(
  node: ExpressionNode,
  document: unknown,
): boolean {
  return evaluateNode(node, document);
}

/** Every path the expression reads, in order (for failure messages). */
export function expressionPaths(
  node: ExpressionNode,
): Array<Array<string | number>> {
  const out: Array<Array<string | number>> = [];
  const walk = (n: ExpressionNode): void => {
    switch (n.type) {
      case "path":
        out.push(n.segments);
        return;
      case "literal":
      case "list":
        return;
      case "not":
        walk(n.operand);
        return;
      case "exists":
        walk(n.operand);
        return;
      case "in":
        walk(n.left);
        return;
      case "and":
      case "or":
      case "compare":
        walk(n.left);
        walk(n.right);
        return;
    }
  };
  walk(node);
  return out;
}

/** `.temporal.workers[0].name` for a parsed path. */
export function formatPath(segments: ReadonlyArray<string | number>): string {
  return segments
    .map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`))
    .join("");
}

/** The value at a parsed path, or `undefined` when absent. */
export function readExpressionPath(
  document: unknown,
  segments: Array<string | number>,
): { found: boolean; value?: unknown } {
  const v = readPathValue(document, segments);
  return v === MISSING ? { found: false } : { found: true, value: v };
}
