import { execa } from "execa";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";
import { emit, resolveFormat } from "../format";
import { maybeAutoStash, isFcheapAvailable } from "./stash";
import { type CodemapDeps, defaultCodemapDeps } from "./annotate.js";
import { codemapRisk, type CodemapRiskFactor } from "./codemap.js";
import { join, resolve } from "node:path";
import type { RunResult } from "../../core/schema/run.v1.js";

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface CodeMatch {
  file: string;
  line: number;
  score: number;
  snippet?: string;
  /** Enclosing symbol resolved by `codemap symbol-at` (item 3). */
  symbol?: string;
  /** Number of inbound callers (`codemap callers` depth). */
  callers?: number;
  /** Blast-radius size (`codemap impact` affected-node count). */
  blastRadius?: number;
  /** Graph-derived rank: hotspot centrality + caller depth + blast radius. */
  codemapScore?: number;
  /** Change-risk score from `codemap risk` (item 8): 0..1; absent when codemap unavailable. */
  riskScore?: number;
  /** Risk level: low | medium | high | unknown (item 8). */
  riskLevel?: string;
  /** Risk factors from `codemap risk` (item 8). */
  riskFactors?: CodemapRiskFactor[];
}

export interface InvestigateResult {
  runId: string;
  runDir: string;
  stashId?: string;
  codeMatches: CodeMatch[];
  query?: string;
  mode?: string;
  /**
   * Entry→failure call trace reconstructed from the ranked code matches via
   * `codemap callers` (FEATURES item 4). Ordered list of symbols; empty when
   * no chain could be built or codemap is absent.
   */
  failureTrace?: string[];
  /** Number of codemap path annotations emitted for the failure trace edges. */
  pathAnnotations?: number;
  error?: string;
}

export interface InvestigateOptions {
  codebase?: string;
  mode?: string;
  limit?: number;
  query?: string;
  connect?: boolean;
  /**
   * If true, prefer the run's `videos/clips/` directory as the stash source
   * instead of the whole run directory. This is useful when the run produced
   * vidtrace clips and you want to investigate the clips alone.
   */
  clips?: boolean;
  artifactRoot?: string;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/* ---------------------------------------------------------------------------
 * fcheap connect wrapper
 *
 * `fcheap connect <stash-id> <codebase> [--index] [--mode hybrid] [--limit N]
 *   --json` returns an array of code matches: { file, line, score, snippet }.
 * ------------------------------------------------------------------------- */

async function runFcheapConnect(
  stashId: string,
  codebase: string,
  opts: { mode?: string; limit?: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = ["connect", stashId, codebase, "--json"];
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.limit) args.push("--limit", String(opts.limit));
  try {
    const r = await execa("fcheap", args, { reject: false, timeout: 120_000 });
    return {
      ok: r.exitCode === 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (e) {
    const err = e as Error;
    return { ok: false, stdout: "", stderr: err.message };
  }
}

function parseCodeMatches(stdout: string): CodeMatch[] {
  try {
    const data = JSON.parse(stdout);
    // fcheap connect returns an array of matches or { matches: [...] }
    const matches = Array.isArray(data) ? data : (data?.matches ?? []);
    return matches.map(
      (m: {
        file?: string;
        path?: string;
        line?: number;
        score?: number;
        snippet?: string;
      }) => ({
        file: m.file ?? m.path ?? "(unknown)",
        line: m.line ?? 0,
        score: typeof m.score === "number" ? m.score : 0,
        ...(m.snippet ? { snippet: m.snippet } : {}),
      }),
    );
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------------------
 * vidtrace extract wrapper
 *
 * `vidtrace extract <video> --json` returns { output_dir, timeline, ... }.
 * We then stash the vidtrace bundle and connect it too.
 * ------------------------------------------------------------------------- */

async function runVidtraceExtract(
  videoPath: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await execa("vidtrace", ["extract", videoPath, "--json"], {
      reject: false,
      timeout: 300_000,
    });
    return {
      ok: r.exitCode === 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (e) {
    const err = e as Error;
    return { ok: false, stdout: "", stderr: err.message };
  }
}

async function isVidtraceAvailable(): Promise<boolean> {
  try {
    const r = await execa("vidtrace", ["version"], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * codemap structural ranking (CODEMAP-INTEGRATION.md item C / FEATURES item 3)
 *
 * fcheap/vecgrep returns N raw file:line search matches. We re-rank them by
 * the code graph instead of raw search score:
 *   - `codemap hotspots`   → per-symbol centrality
 *   - `codemap callers`    → inbound caller depth
 *   - `codemap impact`     → blast radius
 *   - `codemap symbol-at`  → resolve a file:line to its enclosing symbol
 *   - `codemap semantic` / `codemap find` → confirm a match is on the failing
 *     semantic path (failing-outcome text + failing network URLs are the query)
 * Each match gains { symbol, callers, blastRadius, codemapScore } and the
 * result is sorted by codemapScore desc. When codemap is absent we fall back
 * to the original fcheap ranking (no regression). All codemap JSON shapes are
 * parsed defensively — a missing/changed field degrades to a 0 contribution,
 * never a crash.
 * ------------------------------------------------------------------------- */

export interface FailureContext {
  /** Concatenated text from failed outcomes' evidence files. */
  failingText: string;
  /** URLs from `network/failed_requests.ndjson` (status >= 400). */
  failingUrls: string[];
}

/** Default codemap client for investigate — 30s timeout for graph queries. */
const investigateCodemapDeps: CodemapDeps = {
  isAvailable: defaultCodemapDeps.isAvailable,
  async exec(args) {
    const r = await execa("codemap", args, { reject: false, timeout: 30_000 });
    return {
      exitCode: r.exitCode ?? 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  },
};

/** Best-effort: read `run.json` from a run dir; undefined if missing/invalid. */
function readRunResult(runDir: string): RunResult | undefined {
  try {
    return JSON.parse(
      readFileSync(join(runDir, "run.json"), "utf8"),
    ) as RunResult;
  } catch {
    return undefined;
  }
}

/**
 * Gather failing-outcome evidence text + failing network URLs from a run dir.
 * Feeds `codemap semantic` / `codemap find` so the re-rank favours matches on
 * the failing call path.
 */
export async function gatherFailureContext(
  runDir: string,
): Promise<FailureContext> {
  const ctx: FailureContext = { failingText: "", failingUrls: [] };
  const run = readRunResult(runDir);

  // Failing outcome evidence text (best-effort read of each evidence md).
  if (run) {
    const chunks: string[] = [];
    for (const o of run.outcomes) {
      if (o.status !== "failed" || !o.evidence) continue;
      try {
        const text = readFileSync(join(runDir, o.evidence), "utf8");
        chunks.push(text);
      } catch {
        // evidence file may be absent — skip
      }
    }
    ctx.failingText = chunks.join("\n").slice(0, 2000);
  }

  // Failing network request URLs from network/failed_requests.ndjson.
  try {
    const raw = readFileSync(
      join(runDir, "network/failed_requests.ndjson"),
      "utf8",
    );
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { url?: string; status?: number };
        if (typeof entry.url === "string") ctx.failingUrls.push(entry.url);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no network log — fine
  }

  return ctx;
}

/** Parse codemap JSON that may be a bare array or { results/symbols/...: [] }. */
function parseJsonArray(stdout: string): unknown[] {
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

/** First numeric value found under any of the candidate keys on an object. */
function pickNumber(obj: unknown, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** First string value found under any of the candidate keys on an object. */
function pickString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Re-rank fcheap code matches by codemap graph centrality + caller depth +
 * blast radius. Returns a new array sorted by `codemapScore` desc (stable on
 * ties — original fcheap order preserved). When codemap is unavailable, the
 * input matches are returned unchanged (graceful fallback, no regression).
 */
export async function rankCodeMatches(
  matches: CodeMatch[],
  ctx: FailureContext,
  deps: CodemapDeps = investigateCodemapDeps,
): Promise<CodeMatch[]> {
  if (matches.length === 0) return matches;

  if (!(await deps.isAvailable())) return matches;

  // 1. Hotspot centrality table keyed by symbol and by file.
  const centralityBySymbol = new Map<string, number>();
  const centralityByFile = new Map<string, number>();
  const hotspotRows = await safeExec(deps, ["hotspots", "--json"]);
  for (const row of parseJsonArray(hotspotRows)) {
    const sym = pickString(row, ["symbol", "name", "id"]);
    const file = pickString(row, ["file", "path"]);
    const cent =
      pickNumber(row, ["score", "centrality", "weight", "rank"]) ?? 0;
    if (sym) centralityBySymbol.set(sym, cent);
    if (file) centralityByFile.set(file, cent);
  }
  // Normalize by the observed max (not a floor of 1 — centrality is a [0,1]
  // float, so flooring at 1 would shrink every score). Guard div-by-zero.
  const maxCentrality = Math.max(...centralityBySymbol.values(), 0) || 1;

  // 2. Semantic/find confirmation set — symbols & file:line that codemap's
  //    semantic search surfaces for the failing context. Matches present here
  //    get a small bonus so the failing call path floats up.
  const query = buildSemanticQuery(ctx);
  const semanticSymbols = new Set<string>();
  const semanticLocations = new Set<string>();
  if (query) {
    for (const cmd of ["semantic", "find"] as const) {
      const rows = await safeExec(deps, [cmd, query, "--json"]);
      for (const row of parseJsonArray(rows)) {
        const sym = pickString(row, ["symbol", "name", "id"]);
        const file = pickString(row, ["file", "path"]);
        const line = pickNumber(row, ["line", "lineno"]);
        if (sym) semanticSymbols.add(sym);
        if (file && typeof line === "number")
          semanticLocations.add(`${file}:${line}`);
      }
    }
  }

  // 3. Per-match: resolve symbol, fetch callers + impact, compute codemapScore.
  const enriched = await Promise.all(
    matches.map(async (m) => {
      const symbol = await resolveSymbolAt(deps, m.file, m.line);
      let centrality = 0;
      let callers: number | undefined;
      let blastRadius: number | undefined;
      if (symbol) {
        centrality = centralityBySymbol.get(symbol) ?? 0;
        const callersR = await safeExec(deps, ["callers", symbol, "--json"]);
        const callerRows = parseJsonArray(callersR);
        // Prefer an explicit depth field; otherwise count returned callers.
        callers =
          pickNumber(parseJsonObject(callersR), ["depth", "callerDepth"]) ??
          callerRows.length;
        const impactOut = await safeExec(deps, ["impact", symbol, "--json"]);
        const impactRows = parseJsonArray(impactOut);
        blastRadius =
          pickNumber(parseJsonObject(impactOut), [
            "blastRadius",
            "blast_radius",
            "affectedCount",
          ]) ?? impactRows.length;
      }
      // Item 8: change-risk per resolved symbol (`codemap risk`). Absent/unknown
      // symbols get no risk fields, so ranking falls back to codemapScore.
      const risk = symbol ? await codemapRisk(symbol, deps) : null;
      if (centrality === 0) {
        centrality = centralityByFile.get(m.file) ?? 0;
      }

      const onSemanticPath =
        (symbol !== undefined && semanticSymbols.has(symbol)) ||
        semanticLocations.has(`${m.file}:${m.line}`);

      return {
        ...m,
        ...(symbol ? { symbol } : {}),
        ...(callers !== undefined ? { callers } : {}),
        ...(blastRadius !== undefined ? { blastRadius } : {}),
        ...(risk && risk.found
          ? {
              riskScore: risk.score,
              riskLevel: risk.level,
              riskFactors: risk.factors,
            }
          : {}),
        onSemanticPath,
        centrality,
      } as CodeMatch & { onSemanticPath: boolean; centrality: number };
    }),
  );

  const maxCallers = Math.max(...enriched.map((e) => e.callers ?? 0), 0) || 1;
  const maxBlast = Math.max(...enriched.map((e) => e.blastRadius ?? 0), 0) || 1;

  const scored = enriched.map((e) => {
    const normCentrality = e.centrality / maxCentrality;
    const normCallers = (e.callers ?? 0) / maxCallers;
    const normBlast = (e.blastRadius ?? 0) / maxBlast;
    const semanticBonus = e.onSemanticPath ? 1 : 0;
    // Graph-driven blend: centrality dominates, caller depth + blast radius
    // break ties toward load-bearing code, semantic bonus nudges the failing
    // call path to the top. Original `score` is preserved untouched.
    const codemapScore =
      0.45 * normCentrality +
      0.25 * normCallers +
      0.15 * normBlast +
      0.15 * semanticBonus;
    const { onSemanticPath: _onPath, centrality: _cent, ...rest } = e;
    return { ...rest, codemapScore };
  });

  // Item 8: sort by change-risk first (a risky untested hub floats to the top),
  // then codemapScore, then original fcheap order. When codemap is absent every
  // risk/codemap score is 0, so this collapses to the original order (no regression).
  return scored
    .map((m, i) => ({ m, i }))
    .toSorted(
      (a, b) =>
        (b.m.riskScore ?? 0) - (a.m.riskScore ?? 0) ||
        (b.m.codemapScore ?? 0) - (a.m.codemapScore ?? 0) ||
        a.i - b.i,
    )
    .map((x) => x.m);
}

/** Run a codemap subcommand via the deps seam; never throws. */
async function safeExec(deps: CodemapDeps, args: string[]): Promise<string> {
  try {
    const r = await deps.exec(args);
    return r.exitCode === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

/** Parse a codemap JSON object (non-array); {} on failure. */
function parseJsonObject(stdout: string): Record<string, unknown> {
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

/** Resolve a file:line to its enclosing symbol via `codemap symbol-at`. */
async function resolveSymbolAt(
  deps: CodemapDeps,
  file: string,
  line: number,
): Promise<string | undefined> {
  const out = await safeExec(deps, ["symbol-at", `${file}:${line}`, "--json"]);
  const obj = parseJsonObject(out);
  return pickString(obj, ["symbol", "name", "id"]);
}

/** Build a compact semantic query from failing text + failing URLs. */
function buildSemanticQuery(ctx: FailureContext): string {
  const parts: string[] = [];
  if (ctx.failingText) {
    // Take the first few whitespace-normalized lines of evidence text.
    const text = ctx.failingText.replace(/\s+/g, " ").trim().slice(0, 200);
    if (text) parts.push(text);
  }
  for (const url of ctx.failingUrls.slice(0, 3)) parts.push(url);
  return parts.join(" ").trim();
}

/* ---------------------------------------------------------------------------
 * Call-trace reconstruction + per-edge path annotations
 * (CODEMAP-INTEGRATION.md item D / FEATURES item 4)
 *
 * Once `rankCodeMatches` has resolved a `symbol` per match, reconstruct the
 * entry→failure call chain from `codemap callers` edges among those symbols,
 * then emit one codemap **path** annotation per edge:
 *   `codemap annotate <from> <to> --source cairntrace --note … --data … --json`
 * The annotation `data` carries a `stashId` pointer (feature 5) so a codemap
 * consumer can `fcheap restore` the full evidence bundle. Best-effort: codemap
 * absent → no trace, no annotations, never crashes the run.
 * ------------------------------------------------------------------------- */

export interface CallPathAnnotateResult {
  /** The ordered symbol trace the annotations were emitted for. */
  trace: string[];
  /** Number of per-edge path annotations successfully written. */
  annotated: number;
  skipped: number;
  errors: string[];
}

/**
 * Reconstruct an entry→failure call trace from ranked code matches. Uses
 * `codemap callers <sym> --json` to build edges among the resolved candidate
 * symbols (a→b when a is in b's caller list), then returns the longest path
 * through that DAG. Returns [] when fewer than two candidates have resolved
 * symbols, when codemap is absent, or when no edges connect the candidates.
 * Best-effort: never throws.
 */
export async function reconstructFailureTrace(
  matches: CodeMatch[],
  deps: CodemapDeps = investigateCodemapDeps,
): Promise<string[]> {
  // Candidate symbols = resolved symbols from ranked matches, deduped,
  // preserving rank order.
  const candidates: string[] = [];
  for (const m of matches) {
    if (m.symbol && !candidates.includes(m.symbol)) candidates.push(m.symbol);
  }
  if (candidates.length < 2) return [];
  if (!(await deps.isAvailable())) return [];

  // Build caller-name sets per candidate symbol.
  const callersOf = new Map<string, Set<string>>();
  for (const s of candidates) {
    const out = await safeExec(deps, ["callers", s, "--json"]);
    const names = new Set<string>();
    for (const row of parseJsonArray(out)) {
      const name = pickString(row, ["symbol", "name", "id", "caller"]);
      if (name) names.add(name);
    }
    // Also tolerate { callers: [...] } object-wrapped output.
    const obj = parseJsonObject(out);
    const arr = obj.callers;
    if (Array.isArray(arr)) {
      for (const row of arr) {
        const name = pickString(row, ["symbol", "name", "id", "caller"]);
        if (name) names.add(name);
      }
    }
    callersOf.set(s, names);
  }

  // Edges a→b (a calls b) restricted to candidate symbols.
  const outEdges = new Map<string, string[]>();
  for (const s of candidates) outEdges.set(s, []);
  for (const b of candidates) {
    for (const a of callersOf.get(b) ?? []) {
      if (candidates.includes(a)) outEdges.get(a)!.push(b);
    }
  }

  const trace = longestDagPath(candidates, outEdges);
  return trace.length >= 2 ? trace : [];
}

/**
 * Longest simple path through a DAG given an adjacency list. Ties break toward
 * earlier candidates (rank order). Cycle-safe via a visiting set. Returns []
 * when no node has an outgoing edge.
 */
function longestDagPath(
  nodes: string[],
  outEdges: Map<string, string[]>,
): string[] {
  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();
  function bestFrom(n: string): string[] {
    if (memo.has(n)) return memo.get(n)!;
    if (visiting.has(n)) return [n]; // cycle guard — stop here
    visiting.add(n);
    let best: string[] = [n];
    for (const next of outEdges.get(n) ?? []) {
      const sub = bestFrom(next);
      if (sub.length + 1 > best.length) best = [n, ...sub];
    }
    visiting.delete(n);
    memo.set(n, best);
    return best;
  }
  let best: string[] = [];
  for (const n of nodes) {
    const p = bestFrom(n);
    if (p.length > best.length) best = p;
  }
  return best;
}

/**
 * Emit one codemap path annotation per consecutive edge of `trace`:
 * `codemap annotate <from> <to> --source cairntrace --note … --data … --json`.
 * The `data` payload carries `{ runId, stashId?, from, to, edge, traceLength }`
 * — the `stashId` pointer (feature 5) lets a codemap consumer hydrate the full
 * evidence bundle via `fcheap restore`. Best-effort: codemap absent → skipped,
 * never throws.
 */
export async function annotateCallPath(
  trace: string[],
  runId: string,
  opts: { source?: string; stashId?: string },
  deps: CodemapDeps = investigateCodemapDeps,
): Promise<CallPathAnnotateResult> {
  const out: CallPathAnnotateResult = {
    trace,
    annotated: 0,
    skipped: 0,
    errors: [],
  };
  if (trace.length < 2) return out;
  if (!(await deps.isAvailable())) {
    out.skipped = 1;
    return out;
  }
  const source = opts.source ?? "cairntrace";
  for (let i = 0; i < trace.length - 1; i++) {
    const from = trace[i]!;
    const to = trace[i + 1]!;
    const note = `cairntrace failure trace ${runId}: ${from} → ${to}`;
    const data = JSON.stringify({
      runId,
      ...(opts.stashId ? { stashId: opts.stashId } : {}),
      from,
      to,
      edge: `${from}->${to}`,
      traceLength: trace.length,
    });
    try {
      const r = await deps.exec([
        "annotate",
        from,
        to,
        "--source",
        source,
        "--note",
        note,
        "--data",
        data,
        "--json",
      ]);
      if (r.exitCode === 0) {
        out.annotated++;
      } else {
        out.errors.push(
          `${from}->${to}: ${r.stderr || "codemap annotate failed"}`,
        );
      }
    } catch (e) {
      out.errors.push(`${from}->${to}: ${(e as Error).message}`);
    }
  }
  if (out.annotated > 0) {
    process.stderr.write(
      `cairn: annotated ${out.annotated} call-path edge(s) into codemap\n`,
    );
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * investigate command
 *
 * `cairn investigate <run-id> [--codebase <dir>] [--connect] [--query <q>]
 *   [--mode hybrid] [--limit 10]`
 *
 * Flow:
 * 1. Resolve the run directory
 * 2. Stash it to fcheap (if not already stashed)
 * 3. If --connect, run `fcheap connect <stash-id> <codebase>` to get code matches
 * 4. Return structured results with file:line:score matches
 * ------------------------------------------------------------------------- */

export async function investigateCommand(
  runRef: string,
  opts: InvestigateOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const root = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  const runDir = await resolveRunRef(runRef, root);
  const runId =
    runRef === "latest" || runRef === "previous"
      ? (runDir.split("/").pop() ?? runRef)
      : runRef;

  const result: InvestigateResult = {
    runId,
    runDir,
    codeMatches: [],
  };

  // Check fcheap availability
  const fcheapOk = await isFcheapAvailable();
  if (!fcheapOk) {
    result.error =
      "fcheap not on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap";
    process.stderr.write(`cairn investigate: ${result.error}\n`);
    process.stdout.write(
      emit(format, result, () => investigateMarkdown(result)),
    );
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    return;
  }

  // Stash the run directory
  const stashPath =
    opts.clips && existsSync(join(runDir, "videos", "clips"))
      ? resolve(join(runDir, "videos", "clips"))
      : runDir;
  const stashR = await execa(
    "fcheap",
    [
      "save",
      stashPath,
      "--tool",
      "cairntrace",
      "--tag",
      `investigate-${runId}`,
      "--json",
    ],
    { reject: false, timeout: 60_000 },
  );

  if (stashR.exitCode !== 0) {
    result.error = `fcheap save failed: ${stashR.stderr}`;
    process.stderr.write(`cairn investigate: ${result.error}\n`);
    process.stdout.write(
      emit(format, result, () => investigateMarkdown(result)),
    );
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    return;
  }

  const stashData = JSON.parse(stashR.stdout);
  result.stashId =
    stashData.stashId ?? stashData.id ?? stashData.path ?? "(unknown)";

  // Connect to codebase if requested
  if (opts.connect && opts.codebase) {
    const connectR = await runFcheapConnect(result.stashId!, opts.codebase, {
      mode: opts.mode,
      limit: opts.limit,
    });

    if (connectR.ok) {
      result.codeMatches = parseCodeMatches(connectR.stdout);
      result.mode = opts.mode;
      // Re-rank the raw search matches by the codemap graph (centrality +
      // caller depth + blast radius). Best-effort: falls back to the fcheap
      // ranking unchanged when codemap isn't installed. (FEATURES item 3)
      result.codeMatches = await rankCodeMatches(
        result.codeMatches,
        await gatherFailureContext(runDir),
      );
    } else {
      result.error = `fcheap connect failed: ${connectR.stderr}`;
      process.stderr.write(`cairn investigate: ${result.error}\n`);
    }
  } else if (opts.connect && !opts.codebase) {
    result.error =
      "--connect requires --codebase <dir> (or set investigate.codebaseDir in config)";
    process.stderr.write(`cairn investigate: ${result.error}\n`);
  }

  // Reconstruct the entry→failure call trace from the ranked matches and
  // emit one codemap path annotation per edge. Best-effort: skipped when
  // codemap is absent or no trace can be reconstructed. (FEATURES item 4)
  if (result.codeMatches.length > 0) {
    const trace = await reconstructFailureTrace(result.codeMatches);
    result.failureTrace = trace;
    if (trace.length >= 2) {
      const cp = await annotateCallPath(
        trace,
        runId,
        result.stashId ? { stashId: result.stashId } : {},
      );
      result.pathAnnotations = cp.annotated;
    }
  }

  // Write investigate.json to the run directory so agent_context.md can
  // surface the code matches on the next render.
  try {
    writeFileSync(
      join(runDir, "investigate.json"),
      JSON.stringify(result, null, 2),
    );
  } catch {
    // best-effort — the run dir might be read-only or gone
  }

  process.stdout.write(emit(format, result, () => investigateMarkdown(result)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function investigateMarkdown(r: InvestigateResult): string {
  const lines = [
    `# Investigate run ${r.runId}`,
    "",
    `- runDir: ${r.runDir}`,
    ...(r.stashId ? [`- stashId: ${r.stashId}`] : []),
    ...(r.mode ? [`- mode: ${r.mode}`] : []),
  ];

  if (r.codeMatches.length > 0) {
    lines.push("", "## Code Matches", "");
    for (const m of r.codeMatches) {
      const score = ` (score: ${m.score.toFixed(2)})`;
      const codemap = m.codemapScore
        ? ` · codemap: ${m.codemapScore.toFixed(2)}`
        : "";
      // Item 8: surface change-risk. A `high` level gets a ⚠ marker so risky
      // matches stand out in agent_context.md / the markdown report.
      const risk = m.riskScore
        ? ` · risk:${m.riskLevel ?? "?"}(${m.riskScore.toFixed(2)})` +
          (m.riskLevel === "high" ? " ⚠ high" : "")
        : "";
      const sym = m.symbol ? ` [${m.symbol}]` : "";
      const callers = m.callers !== undefined ? ` ←${m.callers}` : "";
      const blast =
        m.blastRadius !== undefined ? ` · blast:${m.blastRadius}` : "";
      const snippet = m.snippet ? `: ${m.snippet}` : "";
      lines.push(
        `- ${m.file}:${m.line}${sym}${score}${codemap}${risk}${callers}${blast}${snippet}`,
      );
    }
  } else if (r.error) {
    lines.push("", "## Error", "", r.error);
  } else {
    lines.push(
      "",
      "No code matches. Use --connect --codebase <dir> to run fcheap connect.",
    );
  }

  if (r.failureTrace && r.failureTrace.length >= 2) {
    lines.push(
      "",
      "## Failure trace",
      "",
      `- ${r.failureTrace.join(" → ")}`,
      ...(r.pathAnnotations
        ? [`- path annotations: ${r.pathAnnotations}`]
        : []),
    );
  }

  return lines.join("\n");
}

/* ---------------------------------------------------------------------------
 * audit command
 *
 * `cairn audit <spec> [--codebase <dir>] [--connect]`
 *
 * Flow:
 * 1. Run the spec with video recording enabled (--backend playwright)
 * 2. If the run has a video, extract vidtrace evidence from it
 * 3. Stash the run + vidtrace bundle to fcheap
 * 4. If --connect, run fcheap connect to find code matches
 * 5. Return structured results
 * ------------------------------------------------------------------------- */

export interface AuditOptions {
  codebase?: string;
  mode?: string;
  limit?: number;
  connect?: boolean;
  env?: string;
  coldStart?: boolean;
  artifactRoot?: string;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface AuditResult {
  specPath: string;
  runId?: string;
  runDir?: string;
  videoPath?: string;
  vidtraceBundle?: string;
  stashId?: string;
  codeMatches: CodeMatch[];
  error?: string;
}

export async function auditCommand(
  specPath: string,
  opts: AuditOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const result: AuditResult = {
    specPath,
    codeMatches: [],
  };

  // Lazy import to avoid circular dependency at module load time
  const { runSpec } = await import("../../core/runner/Runner");
  const { createBackend } = await import("../backendFactory");

  // Run the spec with video recording
  const backend = createBackend({
    backend: "playwright",
    ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
  });

  try {
    const runResult = await runSpec({
      specPath,
      backend,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      workerIndex: 0,
    });

    result.runId = runResult.runId;
    result.runDir = runResult.runDir;

    if (runResult.artifacts.video) {
      result.videoPath = `${runResult.runDir}/${runResult.artifacts.video}`;
    }

    // If the run failed, auto-stash it
    if (runResult.status !== "passed" && result.runDir) {
      await maybeAutoStash(result.runDir, result.runId, runResult.spec.name, {
        stashOnFailure: true,
      });
    }

    // If we have a video, try vidtrace extract
    if (result.videoPath) {
      const vidtraceOk = await isVidtraceAvailable();
      if (vidtraceOk) {
        const vidR = await runVidtraceExtract(result.videoPath);
        if (vidR.ok) {
          try {
            const vidData = JSON.parse(vidR.stdout);
            result.vidtraceBundle = vidData.output_dir ?? vidData.bundle_dir;
          } catch {
            // vidtrace extract returned non-JSON; skip
          }
        }
      } else {
        process.stderr.write(
          "cairn audit: vidtrace not on $PATH — skipping video evidence extraction\n",
        );
      }
    }

    // If --connect and --codebase, stash and connect
    if (opts.connect && opts.codebase && result.runDir) {
      const fcheapOk = await isFcheapAvailable();
      if (!fcheapOk) {
        result.error =
          "fcheap not on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap";
        process.stderr.write(`cairn audit: ${result.error}\n`);
      } else {
        const stashR = await execa(
          "fcheap",
          [
            "save",
            result.runDir,
            "--tool",
            "cairntrace",
            "--tag",
            `audit-${result.runId}`,
            "--json",
          ],
          { reject: false, timeout: 60_000 },
        );
        if (stashR.exitCode === 0) {
          const stashData = JSON.parse(stashR.stdout);
          result.stashId = stashData.stashId ?? stashData.id ?? stashData.path;

          const connectR = await runFcheapConnect(
            result.stashId!,
            opts.codebase,
            {
              mode: opts.mode,
              limit: opts.limit,
            },
          );
          if (connectR.ok) {
            result.codeMatches = parseCodeMatches(connectR.stdout);
          }
        }
      }
    } else if (opts.connect && !opts.codebase) {
      result.error = "--connect requires --codebase <dir>";
      process.stderr.write(`cairn audit: ${result.error}\n`);
    }
  } catch (e) {
    result.error = (e as Error).message;
    process.stderr.write(`cairn audit: ${result.error}\n`);
  } finally {
    await backend.close().catch(() => undefined);
  }

  process.stdout.write(emit(format, result, () => auditMarkdown(result)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function auditMarkdown(r: AuditResult): string {
  const lines = [
    `# Audit: ${r.specPath}`,
    "",
    ...(r.runId ? [`- runId: ${r.runId}`] : []),
    ...(r.runDir ? [`- runDir: ${r.runDir}`] : []),
    ...(r.videoPath ? [`- video: ${r.videoPath}`] : []),
    ...(r.vidtraceBundle ? [`- vidtrace bundle: ${r.vidtraceBundle}`] : []),
    ...(r.stashId ? [`- stashId: ${r.stashId}`] : []),
  ];

  if (r.codeMatches.length > 0) {
    lines.push("", "## Code Matches", "");
    for (const m of r.codeMatches) {
      const score = ` (score: ${m.score.toFixed(2)})`;
      const snippet = m.snippet ? `: ${m.snippet}` : "";
      lines.push(`- ${m.file}:${m.line}${score}${snippet}`);
    }
  } else if (r.error) {
    lines.push("", "## Error", "", r.error);
  } else {
    lines.push(
      "",
      "No code matches. Use --connect --codebase <dir> to run fcheap connect.",
    );
  }

  return lines.join("\n");
}

/* ----- format helper ----- */

export type { OutputFormat } from "../format";
