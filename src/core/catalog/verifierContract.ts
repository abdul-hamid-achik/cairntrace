import { sdkContractFromSource } from "../../sdk/contract";

/**
 * Static reading of a `script` verifier file for `cairn catalog`: its header
 * doc comment and the fixtures it expects. Nothing is executed or imported;
 * the source is scanned as text, so only statically readable contracts are
 * found:
 *
 * 1. a `Fixtures:` (or `Contract:` / `Inputs:`) block in the header comment,
 *    one key per line (`name: description`, `- name (required) — …`) or an
 *    inline list (`Fixtures: a, b, c`), and JSDoc `@fixture name description`;
 * 2. an exported object literal `export const fixtures = { … }` or
 *    `export const contract = { fixtures: { … } }` (or a string array);
 * 3. otherwise the keys the code reads (`fixtures.x`, `fixtures["x"]`,
 *    `const { x } = ctx.fixtures`).
 *
 * A verifier written with the SDK (`defineVerifier({ fixtures: z.object(…) })`)
 * declares its contract in code: when that schema is statically readable it
 * wins (source `sdk`, with types); otherwise the readable SDK keys are merged
 * with the sources above and the contract is marked dynamic.
 */

export interface FixtureKey {
  name: string;
  description?: string;
  required?: boolean;
  /** SDK contracts: the declared type (`string`, `number[]`, `enum`, …). */
  type?: string;
  source: "header" | "export" | "usage" | "sdk";
}

export interface VerifierAnalysis {
  description?: string;
  /** Best source the contract came from. */
  source: "header" | "export" | "usage" | "sdk" | "none";
  /** Fixtures are read dynamically (spread, Object.keys, computed index). */
  dynamic: boolean;
  /** SDK contracts: unknown fixture keys fail the verifier at runtime. */
  strict?: boolean;
  keys: FixtureKey[];
}

const IDENT = "[A-Za-z_$][\\w$]*";
const MAX_DESCRIPTION = 600;

export function analyzeVerifierSource(source: string): VerifierAnalysis {
  const text = source.replace(/^\uFEFF/, "").replace(/^#![^\n]*\n/, "");
  const header = headerComment(text);
  const sdk = sdkContractFromSource(text);
  const sdkKeys: FixtureKey[] = (sdk?.keys ?? []).map((key) => ({
    name: key.name,
    ...(key.description ? { description: key.description } : {}),
    ...(key.required !== undefined ? { required: key.required } : {}),
    type: key.type,
    source: "sdk",
  }));
  if (sdk?.mode === "static") {
    const description =
      sdk.description ?? (header ? describe(header) : undefined);
    return {
      ...(description ? { description } : {}),
      source: "sdk",
      // A schema without .strict() semantics (passthrough, no schema) accepts
      // any key: nothing to flag.
      dynamic: !sdk.strict,
      strict: sdk.strict,
      keys: sdkKeys,
    };
  }
  const code = stripComments(text);

  const headerKeys = header ? headerFixtureKeys(header) : [];
  const exportKeys = exportedFixtureKeys(code);
  const usage = usageFixtureKeys(stripComments(text, true));

  const keys = new Map<string, FixtureKey>();
  for (const key of [...sdkKeys, ...headerKeys, ...exportKeys, ...usage.keys]) {
    const existing = keys.get(key.name);
    if (!existing) {
      keys.set(key.name, key);
    } else if (!existing.description && key.description) {
      keys.set(key.name, { ...existing, description: key.description });
    }
  }
  const best =
    sdkKeys.length > 0
      ? "sdk"
      : headerKeys.length > 0
        ? "header"
        : exportKeys.length > 0
          ? "export"
          : keys.size > 0
            ? "usage"
            : "none";
  const description =
    sdk?.description ?? (header ? describe(header) : undefined);
  return {
    ...(description ? { description } : {}),
    source: best,
    // An SDK schema that is not fully readable may declare more keys.
    dynamic: usage.dynamic || sdk !== undefined,
    keys: [...keys.values()],
  };
}

/**
 * The first comment block of the file: at the very top, or right after the
 * import statements. `//` runs and `/* … *\/` blocks are both read; the
 * comment markers and JSDoc `*` gutters are removed.
 */
function headerComment(text: string): string | undefined {
  const lines = text.split("\n");
  let i = 0;
  // Skip blank lines and (possibly multi-line) import statements.
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*(?:\/\/|\/\*)/.test(line)) break;
    if (!skippable(line)) return undefined;
    if (
      /^\s*import\b/.test(line) &&
      !/;\s*$|from\s+["'][^"']+["']/.test(line)
    ) {
      // Multi-line import: advance to its `from "…"` line.
      while (i < lines.length && !/from\s+["'][^"']+["']/.test(lines[i]!)) i++;
    }
    i++;
  }
  const out: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) {
      out.push(line.replace(/^\s*\/\/\/?\s?/, ""));
      i++;
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      const block: string[] = [];
      let current = line.replace(/^\s*\/\*\*?\s?/, "");
      while (true) {
        const end = current.indexOf("*/");
        if (end >= 0) {
          block.push(current.slice(0, end));
          break;
        }
        block.push(current);
        i++;
        if (i >= lines.length) break;
        current = lines[i]!;
      }
      out.push(...block.map((l) => l.replace(/^\s*\*\s?/, "")));
      i++;
      continue;
    }
    break;
  }
  const joined = out.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

/** Blank lines, import statements and a "use strict" directive. */
function skippable(line: string): boolean {
  return (
    line.trim() === "" ||
    /^\s*(?:import\b|export\s+\*\s+from\b|["']use strict["'];?\s*$)/.test(line)
  );
}

/** The prose part of the header: everything before a fixtures block or tag. */
function describe(header: string): string | undefined {
  const lines: string[] = [];
  for (const line of header.split("\n")) {
    if (FIXTURES_HEADING_RE.test(line) || /^\s*@\w/.test(line)) break;
    lines.push(line);
  }
  const prose = lines.join("\n").trim();
  if (!prose) return undefined;
  return prose.length > MAX_DESCRIPTION
    ? `${prose.slice(0, MAX_DESCRIPTION - 1)}…`
    : prose;
}

const FIXTURES_HEADING_RE =
  /^\s*(?:fixtures?|contract|inputs?)\s*(?:\([^)]*\))?\s*:\s*(.*)$/i;
/** `name`, `a / b` (several keys sharing a description), optional backticks and bullet. */
const KEY_LINE_RE = new RegExp(
  `^(\\s*)(?:[-*•]\\s*)?(\`?${IDENT}\`?(?:\\s*/\\s*\`?${IDENT}\`?)*)\\s*(?:\\((required|optional)\\))?\\s*(?:(?::|—|–|-{1,2}|=)\\s*(.*))?$`,
);
const IDENT_RE = new RegExp(`^${IDENT}$`);

function headerFixtureKeys(header: string): FixtureKey[] {
  const keys: FixtureKey[] = [];
  const lines = header.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const tag = /^\s*@fixture\s+(\S+)\s*(.*)$/.exec(lines[i]!);
    if (tag) {
      keys.push(headerKey(tag[1]!, tag[2]));
      continue;
    }
    const heading = FIXTURES_HEADING_RE.exec(lines[i]!);
    if (!heading) continue;
    const inline = heading[1]!.trim();
    if (inline) {
      keys.push(...inlineKeys(inline));
      continue;
    }
    // One key per line; a deeper-indented line that is not a key continues
    // the previous key's description. A blank line ends the block.
    let last:
      | { indent: number; names: string[]; text: string[]; flag?: string }
      | undefined;
    const flush = (): void => {
      if (!last) return;
      for (const name of last.names)
        keys.push(headerKey(name, last.text.join(" "), last.flag));
      last = undefined;
    };
    for (i = i + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        // A paragraph break inside the block: keep going when the next
        // non-blank line is another indented key.
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === "") j++;
        const next = lines[j] ?? "";
        const nextKey = KEY_LINE_RE.exec(next);
        if (last && nextKey?.[4] !== undefined && /^\s+/.test(next)) {
          i = j - 1;
          continue;
        }
        break;
      }
      const indent = line.length - line.trimStart().length;
      const m = KEY_LINE_RE.exec(line);
      const bulleted = /^\s*[-*•]/.test(line);
      if (
        m &&
        (bulleted || m[4] !== undefined || indent > 0) &&
        !(last && indent > last.indent && m[4] === undefined)
      ) {
        flush();
        last = {
          indent,
          names: m[2]!.split("/").map((n) => n.trim().replace(/`/g, "")),
          text: m[4] !== undefined ? [m[4]] : [],
          ...(m[3] ? { flag: m[3] } : {}),
        };
        continue;
      }
      if (last && indent > last.indent) {
        last.text.push(line.trim());
        continue;
      }
      break;
    }
    flush();
    i--;
  }
  return keys;
}

/**
 * `Fixtures: a, b, c` lists keys; `Fixtures: name is the …` documents one
 * key in prose.
 */
function inlineKeys(inline: string): FixtureKey[] {
  const pieces = inline
    .replace(/\.$/, "")
    .split(",")
    .map((p) => p.trim().replace(/[`'"]/g, ""));
  if (pieces.every((p) => IDENT_RE.test(p)))
    return pieces.map((p) => headerKey(p));
  const lead = new RegExp(
    `^\`?(${IDENT})\`?\\s*(?::|—|–|-{1,2}|\\s)\\s*(.+)$`,
  ).exec(inline);
  return lead ? [headerKey(lead[1]!, lead[2])] : [];
}

function headerKey(name: string, rest?: string, flag?: string): FixtureKey {
  let description = rest?.trim() ?? "";
  let required: boolean | undefined =
    flag === "required" ? true : flag === "optional" ? false : undefined;
  const marker =
    /\((required|optional)\)/i.exec(description) ??
    /^(required|optional)\b[:.,]?/i.exec(description);
  if (marker) {
    required ??= marker[1]!.toLowerCase() === "required";
    description = description.replace(marker[0], "").trim();
  }
  if (description.length > MAX_DESCRIPTION) {
    description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;
  }
  return {
    name,
    ...(description ? { description } : {}),
    ...(required !== undefined ? { required } : {}),
    source: "header",
  };
}

function exportedFixtureKeys(code: string): FixtureKey[] {
  const decl = new RegExp(
    `export\\s+(?:const|let|var)\\s+(fixtures|contract)\\s*(?::[^=]+)?=\\s*`,
    "g",
  );
  const keys: FixtureKey[] = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code))) {
    const start = m.index + m[0].length;
    const literal = balanced(code, start);
    if (!literal) continue;
    if (m[1] === "contract") {
      if (!literal.startsWith("{")) continue;
      const fixtures = topLevelEntries(literal).find(
        (e) => e.key === "fixtures",
      );
      if (fixtures) keys.push(...entriesToKeys(fixtures.value));
    } else {
      keys.push(...entriesToKeys(literal));
    }
  }
  return keys;
}

function entriesToKeys(literal: string): FixtureKey[] {
  const trimmed = literal.trim();
  if (trimmed.startsWith("[")) {
    return [...trimmed.matchAll(/["'`]([^"'`]+)["'`]/g)].map((s) => ({
      name: s[1]!,
      source: "export" as const,
    }));
  }
  if (!trimmed.startsWith("{")) return [];
  return topLevelEntries(trimmed).map(({ key, value }) => {
    const v = value.trim();
    let description: string | undefined;
    let required: boolean | undefined;
    const str = /^["'`]([^"'`]*)["'`]$/.exec(v);
    if (str) description = str[1];
    if (v.startsWith("{")) {
      const inner = topLevelEntries(v);
      const desc = inner.find((e) => e.key === "description");
      const d = desc ? /^["'`]([^"'`]*)["'`]$/.exec(desc.value.trim()) : null;
      if (d) description = d[1];
      const req = inner.find((e) => e.key === "required");
      if (req) required = req.value.trim() === "true";
    }
    return {
      name: key,
      ...(description ? { description } : {}),
      ...(required !== undefined ? { required } : {}),
      source: "export" as const,
    };
  });
}

/** The bracketed literal starting at `start` (`{…}` or `[…]`), strings respected. */
function balanced(code: string, start: number): string | undefined {
  const open = code[start];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < code.length; i++) {
    const ch = code[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return undefined;
}

/** `key: value` pairs at depth 1 of an object literal (shorthand keys too). */
function topLevelEntries(
  literal: string,
): Array<{ key: string; value: string }> {
  const body = literal.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += body[++i] ?? "";
      } else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const out: Array<{ key: string; value: string }> = [];
  for (const part of parts) {
    const m = new RegExp(
      `^\\s*["'\`]?(${IDENT}|[\\w-]+)["'\`]?\\s*(?::\\s*([\\s\\S]*))?$`,
    ).exec(part);
    if (!m || part.trim() === "" || part.trim().startsWith("...")) continue;
    out.push({ key: m[1]!, value: m[2] ?? "" });
  }
  return out;
}

/**
 * Keys the code reads from `fixtures` or an alias of it
 * (`const f = ctx.fixtures`, `({ fixtures: f })`). Reads that cannot be
 * listed statically (Object.keys, a spread, a computed key, `for … in`, or
 * the whole object handed to a call that is not a local function taking it
 * as a plain parameter) mark the contract `dynamic`.
 */
function usageFixtureKeys(code: string): {
  keys: FixtureKey[];
  dynamic: boolean;
} {
  const aliases = new Set(["fixtures"]);
  for (const m of code.matchAll(
    new RegExp(
      `\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*(?:[\\w$]+\\s*(?:\\?\\.|\\.)\\s*)*fixtures\\b(?!\\s*(?:\\?\\.|\\.|\\[))`,
      "g",
    ),
  )) {
    aliases.add(m[1]!);
  }
  // Destructuring rename: `{ fixtures: f }` (lowercase, so a `fixtures: Fixtures` type is not one).
  for (const m of code.matchAll(/\bfixtures\s*:\s*([a-z_$][\w$]*)\s*[,}=]/g)) {
    aliases.add(m[1]!);
  }
  const locals = localFunctionParams(code);
  const names = new Set<string>();
  let dynamic = false;
  for (const alias of aliases) {
    // `ctx.fixtures.x` counts; an alias only stands alone (`f.x`, not `obj.f.x`).
    const a =
      alias === "fixtures"
        ? "\\bfixtures"
        : `(?<![\\w$.])${alias.replace(/\$/g, "\\$")}`;
    for (const m of code.matchAll(
      new RegExp(`${a}\\s*(?:\\?\\.|\\.)\\s*(${IDENT})`, "g"),
    )) {
      names.add(m[1]!);
    }
    for (const m of code.matchAll(
      new RegExp(
        `${a}\\s*(?:\\?\\.)?\\[\\s*["'\`]([^"'\`]+)["'\`]\\s*\\]`,
        "g",
      ),
    )) {
      names.add(m[1]!);
    }
    for (const m of code.matchAll(
      new RegExp(
        `\\{([^{}]*)\\}\\s*(?::[^=]+)?=\\s*(?:[\\w$]+\\s*(?:\\?\\.|\\.)\\s*)*${a}\\b(?!\\s*(?:\\?\\.|\\.|\\[))`,
        "g",
      ),
    )) {
      for (const part of m[1]!.split(",")) {
        const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
        if (name && !part.trim().startsWith("...")) names.add(name[1]!);
      }
    }
    const ref = `(?:[\\w$]+\\s*\\.\\s*)*${a}\\b`;
    if (
      new RegExp(
        `\\bObject\\s*\\.\\s*(?:keys|values|entries)\\s*\\(\\s*${ref}`,
      ).test(code) ||
      new RegExp(`\\.\\.\\.\\s*${ref}`).test(code) ||
      new RegExp(`${a}\\s*(?:\\?\\.)?\\[\\s*(?!["'\`])`).test(code) ||
      new RegExp(`\\bfor\\s*\\([^)]*\\bin\\s+${ref}`).test(code)
    ) {
      dynamic = true;
    }
    // The whole object passed to a call. A local function whose matching
    // parameter is a plain name reads it under that name (followed as an
    // alias); any other callee (an import, a builtin such as
    // JSON.stringify, a destructuring parameter) reads it unseen: dynamic.
    const bare = new RegExp(`${a}\\b(?!\\s*(?:\\?\\.|\\.|\\[))`);
    const whole = new RegExp(
      `^\\s*(?:[\\w$]+\\s*(?:\\?\\.|\\.)\\s*)*${a}\\s*$`,
    );
    for (const m of code.matchAll(
      new RegExp(`\\b(${IDENT})\\s*\\(([^()]*)\\)`, "g"),
    )) {
      const callee = m[1]!;
      if (!bare.test(m[2]!) || NOT_CALLS.has(callee)) continue;
      if (isDeclaration(code, m.index, m.index + m[0].length)) continue;
      const args = splitTopLevel(m[2]!);
      const index = args.findIndex((arg) => whole.test(arg));
      const param =
        index >= 0 ? plainParam(locals.get(callee)?.[index]) : undefined;
      if (param) aliases.add(param);
      else dynamic = true;
    }
  }
  return {
    keys: [...names].map((name) => ({ name, source: "usage" as const })),
    dynamic,
  };
}

/** Words directly followed by `(` that are not calls. */
const NOT_CALLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "void",
  "delete",
  "function",
  "async",
  "await",
  "yield",
  "in",
  "of",
  "do",
  "else",
  "default",
]);

/**
 * Parameter lists of local functions: `function f(a, b)`,
 * `const f = (a) => …`, `const f = function (a) {…}`, `const f = a => …`.
 */
function localFunctionParams(code: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of code.matchAll(
    new RegExp(`\\bfunction\\s*\\*?\\s*(${IDENT})\\s*\\(([^()]*)\\)`, "g"),
  )) {
    out.set(m[1]!, splitTopLevel(m[2]!));
  }
  for (const m of code.matchAll(
    new RegExp(
      `\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*(?:async\\s+)?(?:function\\s*\\*?\\s*(?:${IDENT})?\\s*)?\\(([^()]*)\\)(?=\\s*(?::[^=;{]+)?(?:=>|\\{))`,
      "g",
    ),
  )) {
    out.set(m[1]!, splitTopLevel(m[2]!));
  }
  for (const m of code.matchAll(
    new RegExp(
      `\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:async\\s+)?(${IDENT})\\s*=>`,
      "g",
    ),
  )) {
    out.set(m[1]!, [m[2]!]);
  }
  return out;
}

/** A plain parameter name (`fx`, `fx = {}`, `fx: Fixtures`); not a destructuring or rest one. */
function plainParam(param: string | undefined): string | undefined {
  if (param === undefined) return undefined;
  return new RegExp(`^\\s*(${IDENT})\\s*(?:\\??\\s*:[^=]*)?(?:=[\\s\\S]*)?$`)
    .exec(param)
    ?.at(1);
}

/** `name(params)` that declares a function or method instead of calling one. */
function isDeclaration(code: string, start: number, end: number): boolean {
  if (/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, start - 40), start)))
    return true;
  return new RegExp(
    `^\\s*(?::\\s*${IDENT}(?:<[^>]*>)?(?:\\[\\])?\\s*)?(?:\\{|=>)`,
  ).test(code.slice(end, end + 200));
}

/** Split an argument or parameter list on its top-level commas. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Remove `//` and `/* *\/` comments and blank out regex literals (whose
 * quotes would otherwise read as strings). With `blankStrings`, string
 * contents are blanked too, except a string right after `[` (a computed
 * key such as `fixtures["x"]`). String-aware, best effort.
 */
function stripComments(text: string, blankStrings = false): string {
  let out = "";
  let quote: string | undefined;
  let keep = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") {
        if (keep) out += ch + (text[i + 1] ?? "");
        i++;
      } else if (ch === quote) {
        quote = undefined;
        out += ch;
      } else if (keep) {
        out += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      keep = !blankStrings || /\[\s*$/.test(out);
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === "/" && startsRegex(out)) {
      let inClass = false;
      let j = i + 1;
      for (; j < text.length && text[j] !== "\n"; j++) {
        const c = text[j];
        if (c === "\\") j++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
      }
      if (j < text.length && text[j] === "/") {
        out += "/re/";
        i = j;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** A `/` after one of these (or a keyword) opens a regex, not a division. */
function startsRegex(before: string): boolean {
  const trimmed = before.trimEnd();
  if (trimmed === "") return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(trimmed)) return true;
  return /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(
    trimmed,
  );
}
