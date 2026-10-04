/**
 * E8: the last pass over a generated file when it joins a host Playwright
 * tree. It only touches module plumbing, never test logic:
 *
 *  - imports: a named import nothing in the file uses is dropped, and the
 *    leading import block is ordered the way import-order lint rules expect
 *    (packages first, then relative paths, each alphabetical; specifiers
 *    alphabetical, case-insensitive);
 *  - relative imports of generated modules go through the host's tsconfig
 *    path alias when one covers the export root, and gain `.js` where the
 *    host's module resolution requires an extension;
 *  - vendored runtime files (`lib/`, the command runner, the global setup)
 *    start with an `eslint-disable` banner when the host lints: they are
 *    copies of the runner's own modules, not code written for the host's
 *    style rules. Tests, actions and the generated page objects
 *    (`lib/pages/`) are NOT exempted.
 */
import { dirname, join, relative, resolve, sep } from "node:path";
import type { HostEmit } from "./hostProfile";

export interface HostPostprocessOptions {
  host: HostEmit;
  /** Absolute export root the file's `relPath` is relative to. */
  outDir: string;
}

// `lib/pages/` (E9) holds the generated page objects: code written for the
// host's style rules like a test, not a copy of the runner's modules.
const VENDORED_FILE =
  /^(?:lib\/(?!pages\/)|preconditions\.(?:ts|js)$|global-setup\.(?:ts|js)$)/;

/** A runtime file copied from the runner, not a test or an action. */
export function isVendoredExportFile(relPath: string): boolean {
  return VENDORED_FILE.test(relPath);
}

interface ParsedImport {
  line: string;
  source: string;
  /** Present for `{ a, b as c }` imports. */
  named?: string[];
  typeOnly: boolean;
  /** The text before the specifier list (`import type {` / `import {`). */
  clause: string;
}

const NAMED_IMPORT = /^import (type )?\{([^}]*)\} from (["'])([^"']+)\3;?$/;
const OTHER_IMPORT =
  /^import (?:type )?(?:\* as [A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)(?:, \{[^}]*\})? from (["'])([^"']+)\1;?$/;
const SIDE_EFFECT_IMPORT = /^import (["'])([^"']+)\1;?$/;

function parseImportLine(line: string): ParsedImport | undefined {
  const named = NAMED_IMPORT.exec(line);
  if (named) {
    const specifiers = named[2]!
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return {
      line,
      source: named[4]!,
      named: specifiers,
      typeOnly: named[1] !== undefined,
      clause: named[1] ? "import type" : "import",
    };
  }
  const other = OTHER_IMPORT.exec(line);
  if (other) {
    return { line, source: other[2]!, typeOnly: false, clause: "import" };
  }
  const side = SIDE_EFFECT_IMPORT.exec(line);
  if (side) {
    return { line, source: side[2]!, typeOnly: false, clause: "import" };
  }
  return undefined;
}

/** The name a specifier brings into scope (`a as b` → b, `type T` → T). */
function localName(specifier: string): string {
  const withoutType = specifier.replace(/^type\s+/, "");
  const alias = /\s+as\s+(\S+)$/.exec(withoutType);
  return alias ? alias[1]! : withoutType;
}

/** The name a specifier is sorted by (`a as b` → a, `type T` → T). */
function importedName(specifier: string): string {
  return specifier
    .replace(/^type\s+/, "")
    .replace(/\s+as\s+\S+$/, "")
    .trim();
}

const isRelative = (source: string): boolean =>
  source.startsWith(".") || source.startsWith("/");

function compareText(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase());
  if (lower !== 0) return lower < 0 ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSources(a: string, b: string): number {
  const aRelative = isRelative(a);
  const bRelative = isRelative(b);
  if (aRelative !== bRelative) return aRelative ? 1 : -1;
  return compareText(a, b);
}

/** Source text with comments removed (enough for a "is this name used" probe). */
function stripComments(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function rewriteSpecifier(
  specifier: string,
  fileAbs: string,
  options: HostPostprocessOptions,
): string {
  if (!specifier.startsWith(".")) return specifier;
  const { host, outDir } = options;
  let result = specifier;
  const target = resolve(dirname(fileAbs), specifier);
  const insideExport =
    target === outDir || target.startsWith(`${outDir}${sep}`);
  if (host.alias && insideExport) {
    const aliasRel = relative(host.alias.dir, target).split(sep).join("/");
    if (!aliasRel.startsWith("..")) result = `${host.alias.prefix}${aliasRel}`;
  }
  // `./x.ts` needs allowImportingTsExtensions; a host without it gets the
  // extensionless (or, under node16 / nodenext, `.js`) specifier.
  const ts = /\.([cm]?)tsx?$/.exec(result);
  if (ts && !host.tsExtensions) {
    const base = result.slice(0, ts.index);
    const jsExt = ts[1] === "c" ? ".cjs" : ts[1] === "m" ? ".mjs" : ".js";
    result = host.importExt === ".js" ? `${base}${jsExt}` : base;
  } else if (
    host.importExt === ".js" &&
    insideExport &&
    !/\.(?:[cm]?[jt]s|json)$/.test(result)
  ) {
    result = `${result}.js`;
  }
  return result;
}

/**
 * Apply the host adaptations to one generated file. Non-code files pass
 * through unchanged.
 */
export function postprocessHostFile(
  relPath: string,
  source: string,
  options: HostPostprocessOptions,
): string {
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(relPath) || relPath.endsWith(".d.ts")) {
    return source;
  }
  const fileAbs = join(options.outDir, relPath);
  const vendored = isVendoredExportFile(relPath);
  let text = source;

  // Relative specifiers: alias + extension, anywhere a module is named.
  text = text.replaceAll(
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g,
    (_match, lead: string, quote: string, specifier: string) =>
      `${lead}${quote}${rewriteSpecifier(specifier, fileAbs, options)}${quote}`,
  );

  if (!vendored) text = orderImports(text);

  if (vendored && options.host.lintDisableVendored) {
    text = `/* eslint-disable -- generated runtime copied from the runner; not written to this tree's lint rules */\n${text}`;
  }
  return text;
}

/** Drop unused named imports and order the leading import block. */
function orderImports(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("import "));
  if (first === -1) return text;
  let end = first;
  const imports: ParsedImport[] = [];
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    if (!line.startsWith("import ")) break;
    const parsed = parseImportLine(line);
    // A multi-line or unfamiliar import: leave the whole file's imports as written.
    if (!parsed) return text;
    imports.push(parsed);
    end += 1;
  }
  // Trailing blank lines belong after the block, not to it.
  let blockEnd = end;
  while (blockEnd > first && lines[blockEnd - 1]!.trim() === "") blockEnd -= 1;

  const body = stripComments(
    [...lines.slice(0, first), ...lines.slice(blockEnd)].join("\n"),
  );
  const kept: ParsedImport[] = [];
  for (const entry of imports) {
    if (!entry.named) {
      kept.push(entry);
      continue;
    }
    const used = entry.named.filter((specifier) =>
      new RegExp(
        `(?<![\\w$.])${localName(specifier).replaceAll("$", "\\$")}(?![\\w$])`,
      ).test(body),
    );
    if (used.length === 0) continue;
    const sorted = used.toSorted((a, b) =>
      compareText(importedName(a), importedName(b)),
    );
    const source = JSON.stringify(entry.source);
    kept.push({
      ...entry,
      named: sorted,
      line: `${entry.clause} { ${sorted.join(", ")} } from ${source};`,
    });
  }
  const ordered = kept
    .map((entry, index) => ({ entry, index }))
    .toSorted(
      (a, b) =>
        compareSources(a.entry.source, b.entry.source) || a.index - b.index,
    )
    .map(({ entry }) => entry.line);
  return [...lines.slice(0, first), ...ordered, ...lines.slice(blockEnd)].join(
    "\n",
  );
}
