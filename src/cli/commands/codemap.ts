import { type CodemapDeps, defaultCodemapDeps } from "./annotate.js";

/* ---------------------------------------------------------------------------
 * Shared codemap query helpers (FEATURES items 5, 6, 7)
 *
 * Centralizes the defensive parsing + codemap subcommand wrappers used by the
 * codemap-integration features that live outside `investigate.ts` (which has
 * its own copies from merged item 3). All codemap JSON shapes are parsed
 * defensively — a missing/renamed field degrades to a no-op, never a crash.
 * Every wrapper goes through the `CodemapDeps` seam so tests inject a fake
 * codemap without touching $PATH.
 *
 * ALLOWED codemap commands used here: semantic, find, orphans, projects.
 * (annotate/callers/etc. are wrapped at their call sites.)
 * ------------------------------------------------------------------------- */

/** Parse codemap JSON that may be a bare array or { results/symbols/...: [] }. */
export function parseJsonArray(stdout: string): unknown[] {
  if (!stdout) return [];
  try {
    const data = JSON.parse(stdout);
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      for (const key of [
        "results",
        "symbols",
        "hotspots",
        "callers",
        "matches",
        "affected",
        "orphans",
        "projects",
        "items",
      ]) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[];
      }
    }
  } catch {
    // not JSON — caller treats as empty
  }
  return [];
}

/** Parse a codemap JSON object (non-array); {} on failure. */
export function parseJsonObject(stdout: string): Record<string, unknown> {
  if (!stdout) return {};
  try {
    const data = JSON.parse(stdout);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** First string value found under any of the candidate keys on an object. */
export function pickString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** First numeric value found under any of the candidate keys on an object. */
export function pickNumber(obj: unknown, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Run a codemap subcommand via the deps seam; never throws. Returns stdout or "". */
export async function safeCodemapExec(
  deps: CodemapDeps,
  args: string[],
): Promise<string> {
  try {
    const r = await deps.exec(args);
    return r.exitCode === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

/* ---------------------------------------------------------------------------
 * CodemapSymbol — a defensively-parsed symbol row shared by items 5 + 6
 * ------------------------------------------------------------------------- */

export interface CodemapSymbol {
  symbol: string;
  file?: string;
  line?: number;
  /** Function/declaration signature, e.g. `login(email, pw): Promise<User>`. */
  signature?: string;
  /** Leading docstring / comment above the symbol. */
  docstring?: string;
  /** Symbol kind: function | method | handler | class | … */
  kind?: string;
}

/** Coerce a raw codemap row into a CodemapSymbol; undefined if no symbol name. */
export function toCodemapSymbol(row: unknown): CodemapSymbol | undefined {
  const symbol = pickString(row, ["symbol", "name", "id", "qualified"]);
  if (!symbol) return undefined;
  const file = pickString(row, ["file", "path"]);
  const line = pickNumber(row, ["line", "lineno"]);
  const signature = pickString(row, [
    "signature",
    "sig",
    "decl",
    "declaration",
  ]);
  const docstring = pickString(row, [
    "docstring",
    "doc",
    "description",
    "comment",
  ]);
  const kind = pickString(row, ["kind", "type"]);
  return {
    symbol,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(signature ? { signature } : {}),
    ...(docstring ? { docstring } : {}),
    ...(kind ? { kind } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * codemap semantic / find / orphans / projects
 * ------------------------------------------------------------------------- */

/**
 * `codemap semantic <query> --json` (with an optional `codemap find` pass).
 * Returns defensively-parsed symbols matching the query. Best-effort: [] when
 * codemap is absent or the query is empty.
 */
export async function codemapSemantic(
  query: string,
  deps: CodemapDeps = defaultCodemapDeps,
  includeFind = true,
): Promise<CodemapSymbol[]> {
  if (!query) return [];
  if (!(await deps.isAvailable())) return [];
  const out: CodemapSymbol[] = [];
  const seen = new Set<string>();
  const commands: string[] = ["semantic"];
  if (includeFind) commands.push("find");
  for (const cmd of commands) {
    for (const row of parseJsonArray(
      await safeCodemapExec(deps, [cmd, query, "--json"]),
    )) {
      const sym = toCodemapSymbol(row);
      if (!sym) continue;
      const key = `${sym.symbol}@${sym.file ?? ""}:${sym.line ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sym);
    }
  }
  return out;
}

/**
 * `codemap orphans --json` — untested / unreferenced entrypoints. These are the
 * symbols `cairn spec scaffold --from-codemap` targets first (feature 6).
 */
export async function codemapOrphans(
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<CodemapSymbol[]> {
  if (!(await deps.isAvailable())) return [];
  const rows = parseJsonArray(
    await safeCodemapExec(deps, ["orphans", "--json"]),
  );
  const out: CodemapSymbol[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const sym = toCodemapSymbol(row);
    if (!sym) continue;
    const key = `${sym.symbol}@${sym.file ?? ""}:${sym.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sym);
  }
  return out;
}

/** A codebase entry in the `codemap projects` XDG registry. */
export interface CodemapProject {
  name: string;
  path?: string;
  symbols?: number;
  indexedAt?: string;
}

/**
 * `codemap projects --json` — the registry of indexed codebases. Used by
 * `cairn doctor` (feature 7) to resolve the target codebase without a hardcoded
 * `codemap.path`.
 */
export async function codemapProjects(
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<CodemapProject[]> {
  if (!(await deps.isAvailable())) return [];
  const rows = parseJsonArray(
    await safeCodemapExec(deps, ["projects", "--json"]),
  );
  const out: CodemapProject[] = [];
  for (const row of rows) {
    const name = pickString(row, ["name", "project", "id"]);
    if (!name) continue;
    const path = pickString(row, ["path", "root", "dir"]);
    const symbols = pickNumber(row, [
      "symbols",
      "symbolCount",
      "symbol_count",
      "count",
      "size",
    ]);
    const indexedAt = pickString(row, [
      "indexedAt",
      "indexed_at",
      "updatedAt",
      "updated_at",
    ]);
    out.push({
      name,
      ...(path ? { path } : {}),
      ...(symbols !== undefined ? { symbols } : {}),
      ...(indexedAt ? { indexedAt } : {}),
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * expandSymbolQuery — feature 5 (seed `cairn stash search <symbol>`)
 *
 * Expand a symbol name into fcheap search terms using `codemap semantic` +
 * `codemap find`: the symbol itself plus its file path and a short docstring
 * excerpt. Best-effort: returns just [symbol] when codemap is absent or knows
 * nothing about the symbol, so plain `fcheap search` behaviour is unchanged.
 * ------------------------------------------------------------------------- */

export async function expandSymbolQuery(
  symbol: string,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<string[]> {
  if (!symbol) return [];
  const terms = new Set<string>([symbol]);
  if (!(await deps.isAvailable())) return [...terms];
  for (const sym of await codemapSemantic(symbol, deps)) {
    // Only enrich from rows that actually refer to this symbol — a free-text
    // query that isn't a symbol name won't pull in unrelated terms.
    const a = sym.symbol.toLowerCase();
    const b = symbol.toLowerCase();
    if (a !== b && !a.includes(b) && !b.includes(a)) continue;
    if (sym.file) terms.add(sym.file);
    if (sym.signature) terms.add(sym.signature);
    if (sym.docstring) {
      const doc = sym.docstring
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 6)
        .join(" ");
      if (doc) terms.add(doc);
    }
  }
  return [...terms];
}

/* ---------------------------------------------------------------------------
 * resolveCodemapSymbolForScaffold — feature 6 (pre-fill coversSymbol)
 *
 * Given a query (the spec name or an explicit --from-codemap query), find the
 * best symbol to bind the scaffold to: prefer untested entrypoints (`codemap
 * orphans`) whose name matches the query, then fall back to `codemap semantic`.
 * Uses ONLY semantic + orphans — `codemap read-order` is not yet shipped here
 * and is noted as a future enhancement in FEATURES.md.
 * ------------------------------------------------------------------------- */

export async function resolveCodemapSymbolForScaffold(
  query: string,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<CodemapSymbol | undefined> {
  if (!query) return undefined;
  if (!(await deps.isAvailable())) return undefined;
  const orphans = await codemapOrphans(deps);
  const semantic = await codemapSemantic(query, deps);
  const q = query.toLowerCase();
  const exact = (s: CodemapSymbol) => s.symbol.toLowerCase() === q;
  const substring = (s: CodemapSymbol) =>
    s.symbol.toLowerCase().includes(q) || q.includes(s.symbol.toLowerCase());
  return (
    orphans.find(exact) ??
    semantic.find(exact) ??
    orphans.find(substring) ??
    semantic.find(substring) ??
    orphans[0] ??
    semantic[0]
  );
}
