import type { Locator } from "../schema/spec.v1";

/**
 * Playwright locators, reduced to what a Cairntrace locator can say. Both
 * importers build a `LocChain` (the AST importer from `getByRole(...)` call
 * chains, the trace importer from the protocol's `internal:` selector
 * strings) and turn it into one `Locator` here, noting every approximation.
 */

export type LocPart =
  | { kind: "role"; role: string; name?: string; exact?: boolean }
  | { kind: "label"; name: string; exact?: boolean }
  | { kind: "text"; text: string; exact?: boolean }
  | { kind: "testid"; testid: string }
  | { kind: "css"; selector: string; hasText?: string };

export interface LocChain {
  parts: LocPart[];
  /** 0-based position among matches (`.nth(n)`, `.first()`). */
  nth?: number;
  /** `.filter({ hasText })` applied after the last part. */
  hasText?: string;
  /** Things lost on the way (`.last()`, scope, `exact`, regex names...). */
  approx: string[];
}

export interface ResolvedLocator {
  locator?: Locator;
  approx: string[];
  /** Set when no Cairntrace locator can express the chain. */
  error?: string;
}

export function emptyChain(): LocChain {
  return { parts: [], approx: [] };
}

export function cssForTestId(
  testid: string,
  attribute = "data-testid",
): string {
  return `[${attribute}="${testid.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

/** A regex source that is really a plain phrase (`Sign in`, `\\/home$` is not). */
export function plainRegexText(source: string): string | undefined {
  return /^[\w\s'.,!?:;&@#%-]+$/.test(source) && source.trim()
    ? source
    : undefined;
}

export function chainToLocator(chain: LocChain): ResolvedLocator {
  const approx = [...chain.approx];
  const parts = chain.parts;
  if (parts.length === 0) {
    return { approx, error: "no locator" };
  }
  let base: LocPart = parts[parts.length - 1]!;
  const scope = parts.slice(0, -1);
  let selectorOverride: string | undefined;
  if (scope.length > 0) {
    if (parts.every((part) => part.kind === "css")) {
      selectorOverride = parts
        .map((part) => (part as { selector: string }).selector)
        .join(" ");
      // the last part's :has-text() filters the merged selector; a scope's cannot
      const lastText = base.kind === "css" ? base.hasText : undefined;
      for (const part of scope) {
        if (part.kind === "css" && part.hasText)
          approx.push(
            `:has-text(${JSON.stringify(part.hasText)}) on scope ${part.selector} dropped`,
          );
      }
      base = {
        kind: "css",
        selector: selectorOverride,
        ...(lastText ? { hasText: lastText } : {}),
      };
    } else {
      approx.push(
        `scope ${describePart(scope[scope.length - 1]!)} dropped; the locator is ${describePart(base)} anywhere on the page`,
      );
    }
  }
  const hasText =
    chain.hasText ?? (base.kind === "css" ? base.hasText : undefined);
  const nth = chain.nth;
  const near = {
    ...(hasText ? { hasText } : {}),
    ...(nth !== undefined ? { nth } : {}),
  };
  switch (base.kind) {
    case "role":
      return {
        approx,
        locator: {
          by: "role",
          role: base.role,
          ...(base.name ? { name: base.name } : {}),
          ...(base.exact ? { exact: true } : {}),
          ...near,
        },
      };
    case "label":
      return {
        approx,
        locator: {
          by: "label",
          name: base.name,
          ...(base.exact ? { exact: true } : {}),
          ...near,
        },
      };
    case "text":
      return {
        approx,
        locator: {
          by: "text",
          text: base.text,
          ...(base.exact ? { exact: true } : {}),
          ...near,
        },
      };
    case "testid":
      return {
        approx,
        locator: { by: "testid", testid: base.testid, ...near },
      };
    case "css":
      return {
        approx,
        locator: { by: "selector", selector: base.selector, ...near },
      };
  }
}

export function describePart(part: LocPart): string {
  switch (part.kind) {
    case "role":
      return `role ${part.role}${part.name ? ` "${part.name}"` : ""}`;
    case "label":
      return `label "${part.name}"`;
    case "text":
      return `text "${part.text}"`;
    case "testid":
      return `test id "${part.testid}"`;
    case "css":
      return `selector ${part.selector}`;
  }
}

/** Playwright-only CSS that plain `querySelector` cannot run. */
const PLAYWRIGHT_ONLY_PSEUDO =
  /:(text|text-is|text-matches|visible|nth-match|light|right-of|left-of|above|below|near|has-not|scope)\b/i;

/**
 * One source selector string (`page.locator("...")`): CSS, `text=`, `id=`,
 * `css=`, `role=`, `button:has-text("x")`. Chains (` >> `) become several
 * parts. Returns an error for engines with no Cairntrace equivalent.
 */
export function parseSourceSelector(
  selector: string,
  approx: string[],
): { parts: LocPart[]; nth?: number } | { error: string } {
  const segments = splitEngineChain(selector);
  const parts: LocPart[] = [];
  let nth: number | undefined;
  for (const raw of segments) {
    const segment = raw.trim();
    const nthMatch = /^nth=(-?\d+)$/.exec(segment);
    if (nthMatch) {
      const n = Number(nthMatch[1]);
      if (n < 0) {
        approx.push(`nth=${n} (from the end) dropped; the first match is used`);
      } else {
        nth = n;
      }
      continue;
    }
    if (segment === "visible=true" || segment === "visible=false") continue;
    if (/^xpath=|^\/\//.test(segment) || segment.startsWith("..")) {
      return {
        error: `XPath selector ${JSON.stringify(segment)} has no Cairntrace locator`,
      };
    }
    const text = /^text\s*=\s*(.+)$/is.exec(segment);
    if (text) {
      const t = unquote(text[1]!);
      const exact = text[1]!.trim().startsWith('"');
      parts.push({ kind: "text", text: t, ...(exact ? { exact: true } : {}) });
      continue;
    }
    const quotedText = /^(["'])(.*)\1$/s.exec(segment);
    if (quotedText) {
      parts.push({ kind: "text", text: quotedText[2]!, exact: true });
      continue;
    }
    const role =
      /^role\s*=\s*([\w-]+)(?:\[name\s*=\s*(["'])(.*?)\2(i|s)?\])?$/s.exec(
        segment,
      );
    if (role) {
      parts.push({
        kind: "role",
        role: role[1]!,
        ...(role[3] ? { name: role[3] } : {}),
        ...(role[4] === "s" ? { exact: true } : {}),
      });
      continue;
    }
    const id = /^id\s*=\s*(.+)$/s.exec(segment);
    if (id) {
      parts.push({ kind: "css", selector: `#${unquote(id[1]!)}` });
      continue;
    }
    const css = segment.replace(/^css\s*=\s*/, "");
    const hasText = /^(.*?):has-text\(\s*(["'])(.*?)\2\s*\)$/s.exec(css);
    if (hasText) {
      const base = hasText[1]!.trim();
      if (PLAYWRIGHT_ONLY_PSEUDO.test(base)) {
        return {
          error: `selector ${JSON.stringify(segment)} uses Playwright-only CSS`,
        };
      }
      parts.push({ kind: "css", selector: base || "*", hasText: hasText[3]! });
      approx.push(
        `:has-text(${JSON.stringify(hasText[3])}) became a hasText filter (case-insensitive substring)`,
      );
      continue;
    }
    if (PLAYWRIGHT_ONLY_PSEUDO.test(css)) {
      return {
        error: `selector ${JSON.stringify(segment)} uses Playwright-only CSS (:text/:visible/:nth-match/...) that plain CSS cannot run`,
      };
    }
    if (css.length === 0) return { error: "empty selector" };
    parts.push({ kind: "css", selector: css });
  }
  if (parts.length === 0) return { error: "empty selector" };
  return { parts, ...(nth !== undefined ? { nth } : {}) };
}

/** Split on ` >> ` outside quotes and brackets. */
export function splitEngineChain(selector: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && i + 1 < selector.length) {
        current += selector[i + 1]!;
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (depth === 0 && selector.startsWith(" >> ", i)) {
      out.push(current);
      current = "";
      i += 3;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function unquote(text: string): string {
  const t = text.trim();
  const m = /^(["'])(.*)\1$/s.exec(t);
  return m ? m[2]! : t;
}

/**
 * A selector in Playwright's wire syntax (what a trace stores):
 * `internal:role=button[name="Sign in"i]`, `internal:label="Email"i`,
 * `internal:testid=[data-testid="x"s]`, `internal:text="..."i`,
 * `internal:attr=[placeholder="x"i]`, `internal:has-text="x"i`, plus CSS and
 * `nth=`, joined with ` >> `.
 */
export function parseWireSelector(
  selector: string,
  testIdAttribute: string,
): { chain: LocChain } | { error: string } {
  const chain = emptyChain();
  for (const raw of splitEngineChain(selector)) {
    const segment = raw.trim();
    const nth = /^nth=(-?\d+)$/.exec(segment);
    if (nth) {
      const n = Number(nth[1]);
      if (n < 0) {
        chain.approx.push(
          `nth=${n} (from the end) dropped; the first match is used`,
        );
      } else {
        chain.nth = n;
      }
      continue;
    }
    if (segment === "visible=true" || segment === "visible=false") continue;
    const internal = /^internal:([a-z-]+)=(.*)$/s.exec(segment);
    if (!internal) {
      const sub = parseSourceSelector(segment, chain.approx);
      if ("error" in sub) return { error: sub.error };
      chain.parts.push(...sub.parts);
      if (sub.nth !== undefined) chain.nth = sub.nth;
      continue;
    }
    const engine = internal[1]!;
    const body = internal[2]!;
    if (engine === "label") {
      const v = wireString(body);
      if (v === undefined)
        return { error: `label locator ${body} is a pattern` };
      chain.parts.push({
        kind: "label",
        name: v.value,
        ...(v.exact ? { exact: true } : {}),
      });
    } else if (engine === "text") {
      const v = wireString(body);
      if (v === undefined)
        return { error: `text locator ${body} is a pattern` };
      chain.parts.push({
        kind: "text",
        text: v.value,
        ...(v.exact ? { exact: true } : {}),
      });
    } else if (engine === "testid") {
      const m = /^\[([\w-]+)=(.*)\]$/s.exec(body);
      const v = m ? wireString(m[2]!) : undefined;
      if (!m || v === undefined)
        return { error: `test id locator ${body} is a pattern` };
      if (m[1] !== testIdAttribute) {
        chain.parts.push({
          kind: "css",
          selector: cssForTestId(v.value, m[1]),
        });
      } else {
        chain.parts.push({ kind: "testid", testid: v.value });
      }
    } else if (engine === "role") {
      const m = /^([\w-]+)((?:\[[^\]]*\])*)$/s.exec(body);
      if (!m) return { error: `role locator ${body} not understood` };
      const props = m[2]!;
      const name =
        /\[name=((?:"(?:\\.|[^"])*"|\/(?:\\.|[^/])*\/)[is]?)\]/s.exec(props);
      let roleName: string | undefined;
      let exact: boolean | undefined;
      if (name) {
        const v = wireString(name[1]!);
        if (v === undefined) {
          chain.approx.push(`role name pattern ${name[1]} dropped`);
        } else {
          roleName = v.value;
          exact = v.exact;
        }
      }
      const extra = props.replace(
        /\[name=(?:"(?:\\.|[^"])*"|\/(?:\\.|[^/])*\/)[is]?\]/s,
        "",
      );
      if (extra) {
        chain.approx.push(`role state filters ${extra} dropped`);
      }
      chain.parts.push({
        kind: "role",
        role: m[1]!,
        ...(roleName ? { name: roleName } : {}),
        ...(exact ? { exact: true } : {}),
      });
    } else if (engine === "attr") {
      const m = /^\[([\w-]+)=(.*)\]$/s.exec(body);
      const v = m ? wireString(m[2]!) : undefined;
      if (!m || v === undefined)
        return { error: `attribute locator ${body} not understood` };
      chain.parts.push({
        kind: "css",
        selector: `[${m[1]}="${v.value.replace(/"/g, '\\"')}"]`,
      });
      chain.approx.push(
        `${m[1]} locator became an exact attribute selector (Playwright matches a case-insensitive substring)`,
      );
    } else if (engine === "has-text") {
      const v = wireString(body);
      if (v === undefined)
        return { error: `has-text filter ${body} is a pattern` };
      chain.hasText = v.value;
    } else if (engine === "control") {
      return { error: `control selector ${body} has no locator` };
    } else {
      return {
        error: `selector engine internal:${engine} (${
          engine === "has" ||
          engine === "has-not" ||
          engine === "and" ||
          engine === "or" ||
          engine === "chain"
            ? "locator composition"
            : "unsupported"
        }) has no Cairntrace locator`,
      };
    }
  }
  if (chain.parts.length === 0) return { error: "empty selector" };
  return { chain };
}

/** `"text"i` / `"text"s` / `"text"` (JSON string + case flag). */
function wireString(
  body: string,
): { value: string; exact: boolean } | undefined {
  const m = /^("(?:\\.|[^"\\])*")([is]?)$/s.exec(body.trim());
  if (!m) return undefined;
  try {
    return { value: JSON.parse(m[1]!) as string, exact: m[2] === "s" };
  } catch {
    return undefined;
  }
}
