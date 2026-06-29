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

/** First boolean value found under any of the candidate keys on an object. */
export function pickBoolean(obj: unknown, keys: string[]): boolean | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
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

/** Per-project index drift from `codemap status --json` (`stale` field). */
export interface CodemapStaleness {
  changed: number;
  new: number;
  deleted: number;
}

/** Defensively-parsed `codemap status --json` report (feature 7 freshness). */
export interface CodemapStatusReport {
  project: string;
  root: string;
  registered: boolean;
  nodes: number;
  files: number;
  vectors: number;
  stale?: CodemapStaleness;
}

/**
 * `codemap status --json` — the current project's index status + freshness
 * (`stale`: changed/new/deleted file counts). Used by `cairn doctor` (feature 7)
 * to report "indexed: yes (N symbols, fresh|stale)". Returns null when codemap
 * is absent.
 */
export async function codemapStatus(
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<CodemapStatusReport | null> {
  if (!(await deps.isAvailable())) return null;
  const obj = parseJsonObject(
    await safeCodemapExec(deps, ["status", "--json"]),
  );
  const staleRaw = obj.stale ?? obj.Stale;
  const stale =
    staleRaw && typeof staleRaw === "object"
      ? {
          changed:
            pickNumber(staleRaw as Record<string, unknown>, ["changed"]) ?? 0,
          new: pickNumber(staleRaw as Record<string, unknown>, ["new"]) ?? 0,
          deleted:
            pickNumber(staleRaw as Record<string, unknown>, ["deleted"]) ?? 0,
        }
      : undefined;
  return {
    project: pickString(obj, ["project", "name"]) ?? "",
    root: pickString(obj, ["root", "path"]) ?? "",
    registered: Boolean(obj.registered ?? obj.Registered ?? false),
    nodes: pickNumber(obj, ["nodes", "symbols", "symbolCount"]) ?? 0,
    files: pickNumber(obj, ["files"]) ?? 0,
    vectors: pickNumber(obj, ["vectors"]) ?? 0,
    ...(stale ? { stale } : {}),
  };
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

/* ---------------------------------------------------------------------------
 * codemap review / risk / read-order (FEATURES items 1, 8, 9)
 *
 * codemap v0.19.0 ships three diff/impact-scoped commands the previously-
 * blocked cairntrace features consume:
 *   - `codemap review --since <ref> --json` → diff-scoped blast radius (item 1)
 *   - `codemap risk <symbol> --json`        → change-risk score (items 8 + 9)
 *   - `codemap read-order [query] --json`   → ranked entrypoints (item 9)
 * All shapes are parsed defensively (alias field names + bare-array vs
 * object-wrapped tolerated); every wrapper degrades to an empty/no-op report
 * when codemap is absent, so callers never crash on a missing codemap.
 * ------------------------------------------------------------------------- */

/** A blast-radius / covering-test node from `codemap review`. */
export interface CodemapImpactNode {
  symbol?: string;
  file?: string;
}

/** Defensively-parsed `codemap review --since <ref> --json` report (item 1). */
export interface CodemapReviewReport {
  /** File paths extracted from `blast_radius` (each entry's file/path). */
  blastRadiusFiles: string[];
  /** Symbol names extracted from `blast_radius` (each entry's symbol/name). */
  blastRadiusSymbols: string[];
  /** File paths from `changed_files` (each entry's path, or bare strings). */
  changedFiles: string[];
  /** Symbol names from `changed_symbols` (each entry's symbol/name). */
  changedSymbols: string[];
  /** Whether codemap reported the codebase as indexed. */
  indexed: boolean;
  /** Staleness flag from the report (false when absent). */
  stale: boolean;
}

const EMPTY_REVIEW: CodemapReviewReport = {
  blastRadiusFiles: [],
  blastRadiusSymbols: [],
  changedFiles: [],
  changedSymbols: [],
  indexed: false,
  stale: false,
};

function impactNodes(raw: unknown): CodemapImpactNode[] {
  if (!Array.isArray(raw)) return [];
  return raw as CodemapImpactNode[];
}

/**
 * Parse a `codemap review` report object into a CodemapReviewReport. Tolerates
 * `blast_radius` / `blastRadius`, `changed_files` / `changedFiles`, and
 * `changed_symbols` / `changedSymbols` alias pairs. Returns an empty report
 * on non-JSON / non-object input.
 */
export function parseReviewReport(stdout: string): CodemapReviewReport {
  const obj = parseJsonObject(stdout);
  if (Object.keys(obj).length === 0) return { ...EMPTY_REVIEW };

  const blast = impactNodes(obj.blast_radius ?? obj.blastRadius);
  const blastRadiusFiles: string[] = [];
  const blastRadiusSymbols: string[] = [];
  for (const row of blast) {
    const file = pickString(row, ["file", "path"]);
    const symbol = pickString(row, ["symbol", "name", "id"]);
    if (file) blastRadiusFiles.push(file);
    if (symbol) blastRadiusSymbols.push(symbol);
  }

  const changed = impactNodes(obj.changed_files ?? obj.changedFiles);
  const changedFiles: string[] = [];
  for (const row of changed) {
    const file =
      typeof row === "string" ? row : pickString(row, ["path", "file"]);
    if (file) changedFiles.push(file);
  }

  const changedSyms = impactNodes(obj.changed_symbols ?? obj.changedSymbols);
  const changedSymbols: string[] = [];
  for (const row of changedSyms) {
    const symbol = pickString(row, ["symbol", "name", "id"]);
    if (symbol) changedSymbols.push(symbol);
  }

  return {
    blastRadiusFiles,
    blastRadiusSymbols,
    changedFiles,
    changedSymbols,
    indexed: obj.indexed === true,
    stale: obj.stale === true,
  };
}

/**
 * `codemap review --since <ref> --json` — diff-scoped blast radius + changed
 * symbols for impact-driven spec selection (feature 1). Best-effort: empty
 * report when codemap is absent or `since` is empty.
 */
export async function codemapReview(
  since: string,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<CodemapReviewReport> {
  if (!since || !(await deps.isAvailable())) return { ...EMPTY_REVIEW };
  return parseReviewReport(
    await safeCodemapExec(deps, ["review", "--since", since, "--json"]),
  );
}

/** A single change-risk factor from `codemap risk`. */
export interface CodemapRiskFactor {
  factor?: string;
  severity?: string;
  detail?: string;
}

/** Defensively-parsed `codemap risk <symbol> --json` report (items 8 + 9). */
export interface CodemapRiskReport {
  symbol: string;
  found: boolean;
  /** Change-risk score in [0, 1] (0 when unknown / not found). */
  score: number;
  level: "low" | "medium" | "high" | "unknown";
  callers: number;
  coveringTests: number;
  factors: CodemapRiskFactor[];
  note?: string;
}

/** An empty (codemap-absent / unknown-symbol) risk report. */
export function emptyRiskReport(symbol: string): CodemapRiskReport {
  return {
    symbol,
    found: false,
    score: 0,
    level: "unknown",
    callers: 0,
    coveringTests: 0,
    factors: [],
  };
}

/**
 * Parse a `codemap risk` report object into a CodemapRiskReport. Tolerates
 * `score` / `risk` / `risk_score`, `level` / `severity` / `risk_level`, and
 * `covering_tests` / `coveringTests` / `tests` aliases. Returns an empty
 * report on non-JSON / non-object input.
 */
export function parseRiskReport(
  stdout: string,
  symbol: string,
): CodemapRiskReport {
  const obj = parseJsonObject(stdout);
  if (Object.keys(obj).length === 0) return emptyRiskReport(symbol);

  const found = obj.found === true;
  const score = pickNumber(obj, ["score", "risk", "risk_score"]) ?? 0;
  const levelRaw = pickString(obj, ["level", "severity", "risk_level"]);
  const level: CodemapRiskReport["level"] =
    levelRaw === "low" || levelRaw === "medium" || levelRaw === "high"
      ? levelRaw
      : "unknown";
  const callers = pickNumber(obj, ["callers", "caller_count", "fan_in"]) ?? 0;
  const coveringTests =
    pickNumber(obj, ["covering_tests", "coveringTests", "tests"]) ?? 0;

  const factorsRaw = Array.isArray(obj.factors) ? obj.factors : [];
  const factors: CodemapRiskFactor[] = [];
  for (const f of factorsRaw) {
    const factor = pickString(f, ["factor", "name"]);
    const severity = pickString(f, ["severity", "level"]);
    const detail = pickString(f, ["detail", "description"]);
    factors.push({
      ...(factor ? { factor } : {}),
      ...(severity ? { severity } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  const note = pickString(obj, ["note"]);
  return {
    symbol,
    found,
    score,
    level,
    callers,
    coveringTests,
    factors,
    ...(note ? { note } : {}),
  };
}

/**
 * `codemap risk <symbol> --json` — change-risk score (untested + fan-in +
 * cross-package + ambiguity) for one symbol. Powers risk-ranked investigate
 * (feature 8) and cover-the-riskiest scaffolding (feature 9). Best-effort:
 * empty report (found:false, score:0) when codemap is absent or the symbol is
 * empty.
 */
export async function codemapRisk(
  symbol: string,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<CodemapRiskReport> {
  if (!symbol || !(await deps.isAvailable())) return emptyRiskReport(symbol);
  return parseRiskReport(
    await safeCodemapExec(deps, ["risk", symbol, "--json"]),
    symbol,
  );
}

/** A ranked entrypoint row from `codemap read-order`. */
export interface CodemapReadOrderEntry {
  rank: number;
  symbol: string;
  fqn?: string;
  kind?: string;
  file?: string;
  startLine?: number;
  /** Graph-derived rank score (centrality + in-degree). */
  score: number;
  inDegree: number;
  entrypoint: boolean;
  reason?: string;
}

/** Defensively-parsed `codemap read-order [query] --json` report (item 9). */
export interface CodemapReadOrderReport {
  entries: CodemapReadOrderEntry[];
  indexed: boolean;
}

/** Parse a `codemap read-order` report into entries (tolerates bare arrays). */
export function parseReadOrderReport(stdout: string): CodemapReadOrderReport {
  if (!stdout) return { entries: [], indexed: false };
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { entries: [], indexed: false };
  }
  const obj =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const entriesRaw = Array.isArray(data)
    ? data
    : Array.isArray(obj.entries)
      ? obj.entries
      : Array.isArray(obj.results)
        ? obj.results
        : [];
  const indexed = obj.indexed === true;

  const entries: CodemapReadOrderEntry[] = [];
  for (const row of entriesRaw) {
    const symbol = pickString(row, ["symbol", "name", "id"]);
    if (!symbol) continue;
    const fqn = pickString(row, ["fqn", "qualified_name", "qualified"]);
    const kind = pickString(row, ["kind", "type"]);
    const file = pickString(row, ["file", "path"]);
    const startLine = pickNumber(row, ["start_line", "line", "lineno"]);
    const score = pickNumber(row, ["score", "rank_score"]) ?? 0;
    const inDegree = pickNumber(row, ["in_degree", "inDegree", "fan_in"]) ?? 0;
    const entrypoint =
      pickBoolean(row, ["entrypoint", "is_entrypoint", "is_entry"]) ?? false;
    const reason = pickString(row, ["reason", "rationale"]);
    entries.push({
      rank: pickNumber(row, ["rank", "index"]) ?? entries.length,
      symbol,
      ...(fqn ? { fqn } : {}),
      ...(kind ? { kind } : {}),
      ...(file ? { file } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      score,
      inDegree,
      entrypoint,
      ...(reason ? { reason } : {}),
    });
  }
  return { entries, indexed };
}

/**
 * `codemap read-order [query] --json` — entrypoints ranked by graph centrality
 * + in-degree. Powers cover-the-riskiest scaffolding (feature 9). Best-effort:
 * empty report when codemap is absent.
 */
export async function codemapReadOrder(
  deps: CodemapDeps = defaultCodemapDeps,
  query?: string,
): Promise<CodemapReadOrderReport> {
  if (!(await deps.isAvailable())) return { entries: [], indexed: false };
  const args = ["read-order"];
  if (query && query.trim().length > 0) args.push(query.trim());
  args.push("--json");
  return parseReadOrderReport(await safeCodemapExec(deps, args));
}
