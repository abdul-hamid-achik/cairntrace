/**
 * Tiny statement-level IR for generated test sources.
 *
 * The exporter builds STRUCTURE (statements with children) instead of
 * concatenating indented strings; this printer is the only place that knows
 * about indentation and line joining. Correctness properties this buys:
 *
 *  - indentation can never drift (children are indented by construction);
 *  - block open/close tokens can never mismatch;
 *  - comments are comment NODES, so they can never be half-escaped into code.
 *
 * String QUOTING is owned by templateValue.ts (emitStr/emitValue) — raw()
 * lines receive already-emitted expressions, never raw user text.
 */

export type Stmt =
  /** One already-rendered line of code. Must not contain newlines. */
  | { kind: "raw"; code: string }
  /** A `// ...` comment; multi-line text becomes one comment line per line. */
  | { kind: "comment"; text: string }
  /** Verbatim (non-comment) lines, e.g. embedded user JS. Indented as a unit. */
  | { kind: "verbatim"; lines: string[] }
  | { kind: "blank" }
  /** Generic `open ... close` construct: if/braces/call-with-body. */
  | { kind: "block"; open: string; body: Stmt[]; close: string }
  | { kind: "tryCatch"; body: Stmt[]; errName: string; handler: Stmt[] };

export function raw(code: string): Stmt {
  return { kind: "raw", code };
}

export function comment(text: string): Stmt {
  return { kind: "comment", text };
}

export function verbatim(lines: string[]): Stmt {
  return { kind: "verbatim", lines };
}

export const blank: Stmt = { kind: "blank" };

export function block(open: string, body: Stmt[], close = "}"): Stmt {
  return { kind: "block", open, body, close };
}

export function iff(condition: string, body: Stmt[]): Stmt {
  return block(`if (${condition}) {`, body);
}

export function braces(body: Stmt[]): Stmt {
  return block(`{`, body);
}

export function tryCatch(body: Stmt[], errName: string, handler: Stmt[]): Stmt {
  return { kind: "tryCatch", body, errName, handler };
}

const INDENT = "  ";

/** Print a statement list to source text at the given indent depth. */
export function print(stmts: Stmt[], depth = 0): string {
  const out: string[] = [];
  emitInto(stmts, depth, out);
  return out.join("\n");
}

function emitInto(stmts: Stmt[], depth: number, out: string[]): void {
  const pad = INDENT.repeat(depth);
  for (const s of stmts) {
    switch (s.kind) {
      case "raw":
        out.push(pad + s.code);
        break;
      case "comment":
        for (const line of s.text.split("\n")) {
          out.push(line ? `${pad}// ${line}` : `${pad}//`);
        }
        break;
      case "verbatim":
        for (const line of s.lines) out.push(line ? pad + line : "");
        break;
      case "blank":
        out.push("");
        break;
      case "block":
        out.push(pad + s.open);
        emitInto(s.body, depth + 1, out);
        out.push(pad + s.close);
        break;
      case "tryCatch":
        out.push(`${pad}try {`);
        emitInto(s.body, depth + 1, out);
        out.push(`${pad}} catch (${s.errName}) {`);
        emitInto(s.handler, depth + 1, out);
        out.push(`${pad}}`);
        break;
    }
  }
}
