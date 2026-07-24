import { execa } from "execa";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  readdir,
  readFile as readFileAsync,
  rm,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import { resolveArtifactRootContext, resolveRunRef } from "../runRefs";
import { emit, resolveFormat } from "../format";
import { maybeAutoStash, stashDirectory } from "./stash";
import { isFcheapAvailable, runFcheap } from "./fcheapClient.js";
import { type CodemapDeps, defaultCodemapDeps } from "./annotate.js";
import { codemapRisk } from "./codemap.js";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { RunResult } from "../../core/schema/run.v1.js";
import type { BrowserBackend } from "../../adapters/browserBackend.js";
import type { ServicesHandle } from "../../core/runner/services.js";
import type { WebServerHandle } from "../../core/runner/webServer.js";
import { refreshAgentContextCodeMatches } from "../../core/artifacts/agentContext.js";
import { createArtifactRedactor } from "../../core/artifacts/redaction.js";
import { loadConfig } from "../../core/config/loader.js";
import { trackBackend, trackServices, trackWebServer } from "../cleanup.js";
import { parseFcheapConnectOutput } from "./fcheapContract.js";
import {
  AuditResultSchema,
  type AuditResult,
} from "../../core/schema/audit.v1.js";
import {
  InvestigateResultSchema,
  type CodeMatch,
  type InvestigateResult,
} from "../../core/schema/investigate.v1.js";

export type { AuditResult } from "../../core/schema/audit.v1.js";
export type {
  CodeMatch,
  InvestigateResult,
} from "../../core/schema/investigate.v1.js";

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface InvestigateOptions {
  codebase?: string;
  mode?: string;
  limit?: number | string;
  index?: boolean;
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
 * `fcheap connect <stash-id> <codebase> [--mode hybrid] [--limit N]
 *   [--query text] --json` returns an envelope containing code matches.
 * ------------------------------------------------------------------------- */

export interface FcheapConnectOptions {
  mode?: string;
  limit?: number;
  query?: string;
  index?: boolean;
}

export function buildFcheapConnectArgs(
  stashId: string,
  codebase: string,
  opts: FcheapConnectOptions,
): string[] {
  const args = ["connect", stashId, codebase, "--json"];
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.limit) args.push("--limit", String(opts.limit));
  if (opts.query) args.push("--query", opts.query);
  if (opts.index) args.push("--index");
  return args;
}

async function runFcheapConnect(
  stashId: string,
  codebase: string,
  opts: FcheapConnectOptions,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const args = buildFcheapConnectArgs(stashId, codebase, opts);
  const result = await runFcheap(args, { timeoutMs: 120_000 });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function parseCodeMatches(stdout: string): CodeMatch[] {
  return normalizeCodeMatches(parseFcheapConnectOutput(stdout).matches);
}

function normalizeCodeMatches(
  matches: ReturnType<typeof parseFcheapConnectOutput>["matches"],
): CodeMatch[] {
  return matches.map((match) => ({
    file: match.file ?? "(unknown)",
    line: match.line ?? 0,
    score: match.score,
    ...(match.snippet ? { snippet: match.snippet } : {}),
  }));
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
  let inputPath = videoPath;
  let compatibilityInput: string | undefined;
  try {
    const probe = await execa(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        videoPath,
      ],
      { reject: false, timeout: 30_000 },
    );
    if (probe.exitCode === 0 && !String(probe.stdout).trim()) {
      // Playwright recordings are video-only, while vidtrace's Whisper stage
      // expects an audio stream. Add silence to a disposable copy so browser
      // audits still produce frame/OCR evidence without mutating the source.
      compatibilityInput = join(
        dirname(videoPath),
        `.vidtrace-input-${process.pid}-${Date.now()}.webm`,
      );
      const remux = await execa(
        "ffmpeg",
        [
          "-y",
          "-i",
          videoPath,
          "-f",
          "lavfi",
          "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-shortest",
          "-c:v",
          "copy",
          "-c:a",
          "libopus",
          compatibilityInput,
        ],
        { reject: false, timeout: 120_000 },
      );
      if (remux.exitCode !== 0) {
        return {
          ok: false,
          stdout: typeof remux.stdout === "string" ? remux.stdout : "",
          stderr:
            typeof remux.stderr === "string" && remux.stderr.trim()
              ? `could not prepare video-only recording for vidtrace: ${remux.stderr}`
              : "could not prepare video-only recording for vidtrace",
        };
      }
      inputPath = compatibilityInput;
    }

    const r = await execa(
      "vidtrace",
      [
        "extract",
        inputPath,
        "--out",
        join(dirname(videoPath), "vidtrace"),
        "--name",
        basename(videoPath, ".webm"),
        "--json",
      ],
      {
        reject: false,
        timeout: 300_000,
      },
    );
    return {
      ok: r.exitCode === 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
    };
  } catch (e) {
    const err = e as Error;
    return { ok: false, stdout: "", stderr: err.message };
  } finally {
    if (compatibilityInput) {
      await rm(compatibilityInput, { force: true }).catch(() => undefined);
    }
  }
}

function vidtraceFailureMessage(result: {
  stdout: string;
  stderr: string;
}): string {
  if (result.stderr.trim()) return result.stderr.trim();
  try {
    const parsed = JSON.parse(result.stdout) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Fall through to a bounded plain-text diagnostic.
  }
  return result.stdout.trim().slice(0, 500) || "unknown error";
}

const VIDTRACE_TEXT_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".log",
  ".md",
  ".srt",
  ".tsv",
  ".txt",
  ".vtt",
  ".yaml",
  ".yml",
]);

export function pathIsWithin(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

export async function redactVidtraceTextArtifacts(
  bundleDir: string,
): Promise<void> {
  const redactor = createArtifactRedactor(undefined);
  for (const entry of await readdir(bundleDir, { withFileTypes: true })) {
    const entryPath = join(bundleDir, entry.name);
    if (entry.isDirectory()) {
      await redactVidtraceTextArtifacts(entryPath);
      continue;
    }
    if (
      !entry.isFile() ||
      !VIDTRACE_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    const original = await readFileAsync(entryPath, "utf8");
    const redacted = redactor.text(original);
    if (redacted !== original) await writeFileAsync(entryPath, redacted);
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
    const parsed = JSON.parse(
      readFileSync(join(runDir, "run.json"), "utf8"),
    ) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { outcomes?: unknown }).outcomes)
    ) {
      return undefined;
    }
    return parsed as RunResult;
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

export interface InvestigateRunOptions {
  codebase?: string;
  mode?: "semantic" | "keyword" | "hybrid";
  limit?: number;
  index?: boolean;
  query?: string;
  connect?: boolean;
  clips?: boolean;
  /** Reuse a receipt from an earlier auto-stash instead of saving twice. */
  stashId?: string;
}

/**
 * Run the investigation pipeline for an already-resolved run directory.
 * This is the shared CLI/MCP/auto-investigate implementation: it returns data
 * and never writes command output, so MCP stdio cannot be polluted.
 */
export async function investigateRunDirectory(
  runDir: string,
  runId: string,
  opts: InvestigateRunOptions,
): Promise<InvestigateResult> {
  const result: InvestigateResult = {
    $schema: "urn:cairntrace.dev:investigate:v1",
    version: "1",
    runId,
    runDir,
    codeMatches: [],
  };

  const fcheapOk = await isFcheapAvailable();
  if (!fcheapOk) {
    result.error =
      "fcheap not on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap";
    return InvestigateResultSchema.parse(
      createArtifactRedactor(undefined).value(result),
    );
  }

  if (opts.stashId) {
    result.stashId = opts.stashId;
  } else {
    const stashPath =
      opts.clips && existsSync(join(runDir, "videos", "clips"))
        ? resolve(join(runDir, "videos", "clips"))
        : runDir;
    const saved = await stashDirectory(stashPath, {
      tool: "cairntrace",
      tags: [`investigate-${runId}`],
    });
    if (!saved.ok || !saved.stashId) {
      result.stashId = saved.stashId;
      result.error = `fcheap save failed: ${saved.error ?? "missing stash id"}`;
      return InvestigateResultSchema.parse(
        createArtifactRedactor(undefined).value(result),
      );
    }
    result.stashId = saved.stashId;
    if (saved.warning) {
      result.warnings = [
        `fcheap save completed with post-save failures: ${saved.warning}`,
      ];
    }
  }

  if (opts.connect) {
    if (!opts.codebase) {
      result.error =
        "--connect requires --codebase <dir> or investigate.codebaseDir in config";
      return InvestigateResultSchema.parse(
        createArtifactRedactor(undefined).value(result),
      );
    }
    const connectR = await runFcheapConnect(result.stashId, opts.codebase, {
      mode: opts.mode,
      limit: opts.limit,
      query: opts.query,
      index: opts.index,
    });

    if (connectR.ok) {
      try {
        const connectResult = parseFcheapConnectOutput(connectR.stdout);
        result.codeMatches = normalizeCodeMatches(connectResult.matches);
        result.query = connectResult.query ?? opts.query;
        result.indexStatus = connectResult.indexStatus;
        if (connectResult.indexStatus === "missing") {
          result.error =
            "file.cheap could not search this codebase because its vecgrep index is missing; rerun with --index to build it";
        }
      } catch (error) {
        result.error = (error as Error).message;
        result.codeMatches = [];
      }
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
    }
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
  const publicResult = InvestigateResultSchema.parse(
    createArtifactRedactor(undefined).value(result),
  );
  try {
    writeFileSync(
      join(runDir, "investigate.json"),
      JSON.stringify(publicResult, null, 2),
    );
    refreshAgentContextCodeMatches(runDir);
  } catch {
    // best-effort — the run dir might be read-only or gone
  }

  return publicResult;
}

function resolveCodebasePath(
  codebase: string | undefined,
  configPath: string | undefined,
): string | undefined {
  if (!codebase) return undefined;
  if (isAbsolute(codebase)) return codebase;
  return resolve(configPath ? dirname(configPath) : process.cwd(), codebase);
}

function positiveLimit(
  value: number | string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--limit expects a positive integer, got "${value}"`);
  }
  return parsed;
}

type SearchMode = NonNullable<InvestigateRunOptions["mode"]>;

function searchMode(
  value: string | undefined,
  fallback: SearchMode,
): SearchMode {
  const resolved = value ?? fallback;
  if (!["semantic", "keyword", "hybrid"].includes(resolved)) {
    throw new Error(
      `--mode expects semantic, keyword, or hybrid, got "${resolved}"`,
    );
  }
  return resolved as SearchMode;
}

export async function investigateRunRef(
  runRef: string,
  opts: InvestigateOptions,
): Promise<InvestigateResult> {
  const resolved = await resolveArtifactRootContext({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });
  const runDir = await resolveRunRef(runRef, resolved.artifactRoot);
  const runId = basename(runDir);
  const config = resolved.loaded?.config.investigate;
  const connect = opts.connect === true || opts.codebase !== undefined;
  const codebase = opts.codebase
    ? resolveCodebasePath(opts.codebase, undefined)
    : resolveCodebasePath(
        opts.connect ? config?.codebaseDir : undefined,
        resolved.loaded?.path,
      );
  return investigateRunDirectory(runDir, runId, {
    connect,
    codebase,
    mode: searchMode(opts.mode, config?.mode ?? "hybrid"),
    limit: positiveLimit(opts.limit ?? config?.limit, 10),
    index: opts.index === true || config?.index === true,
    query: opts.query,
    clips: opts.clips,
  });
}

export async function investigateCommand(
  runRef: string,
  opts: InvestigateOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let result: InvestigateResult;
  try {
    result = InvestigateResultSchema.parse(
      await investigateRunRef(runRef, opts),
    );
  } catch (error) {
    result = InvestigateResultSchema.parse({
      $schema: "urn:cairntrace.dev:investigate:v1",
      version: "1",
      runId: runRef,
      runDir: "",
      codeMatches: [],
      error: (error as Error).message,
    });
  }
  if (result.error) {
    process.stderr.write(`cairn investigate: ${result.error}\n`);
  }
  for (const warning of result.warnings ?? []) {
    process.stderr.write(`cairn investigate: warning: ${warning}\n`);
  }
  if (result.error || result.warnings?.length) process.exitCode = 2;
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

  if (r.warnings?.length) {
    lines.push("", "## Warnings", "", ...r.warnings.map((w) => `- ${w}`));
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
  limit?: number | string;
  index?: boolean;
  connect?: boolean;
  speed?: number | string;
  slowMo?: number | string;
  env?: string;
  coldStart?: boolean;
  artifactRoot?: string;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

function boundedNumber(
  value: number | string | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} expects a number from ${min} to ${max}`);
  }
  return parsed;
}

export async function auditSpec(
  specPath: string,
  opts: AuditOptions,
): Promise<AuditResult> {
  const result: AuditResult = {
    $schema: "urn:cairntrace.dev:audit:v1",
    version: "1",
    specPath,
    codeMatches: [],
    warnings: [],
  };

  let backend: BrowserBackend | undefined;
  let stopTrackingBackend: (() => void) | undefined;
  let server: WebServerHandle | undefined;
  let stopTrackingServer: (() => void) | undefined;
  let services: ServicesHandle | undefined;
  let stopTrackingServices: (() => void) | undefined;

  try {
    const { runSpec } = await import("../../core/runner/Runner");
    const { createBackend } = await import("../backendFactory");
    const lifecycle = await import("./run");
    const coldStart = opts.coldStart ?? true;
    const runOptions = {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      coldStart,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
    };
    if (opts.env !== undefined && process.env.CAIRN_TVAULT_ENV === undefined) {
      process.env.CAIRN_TVAULT_ENV = opts.env;
    }
    server = await lifecycle.maybeStartWebServer(
      specPath,
      runOptions,
      (terminateSync) => {
        stopTrackingServer = trackWebServer({ terminateSync });
      },
    );
    services = await lifecycle.maybeStartServices(
      specPath,
      runOptions,
      (terminateSync) => {
        stopTrackingServices = trackServices({ terminateSync });
      },
    );
    await lifecycle.maybeInjectTvaultSecrets(specPath, runOptions);
    const browser = await lifecycle.resolveBrowserConfig(specPath, runOptions);
    backend = createBackend(
      lifecycle.backendOpts({ ...runOptions, backend: "playwright" }, browser),
    );
    stopTrackingBackend = trackBackend(backend);

    const loaded = await loadConfig(specPath, opts.config);
    const investigateConfig = loaded?.config.investigate;
    const stashConfig = loaded?.config.stash;
    const connect = opts.connect === true || opts.codebase !== undefined;
    const codebase = opts.codebase
      ? resolveCodebasePath(opts.codebase, undefined)
      : resolveCodebasePath(
          opts.connect ? investigateConfig?.codebaseDir : undefined,
          loaded?.path,
        );
    const mode = searchMode(opts.mode, investigateConfig?.mode ?? "hybrid");
    const limit = positiveLimit(opts.limit ?? investigateConfig?.limit, 10);
    const index = opts.index === true || investigateConfig?.index === true;
    const speed = boundedNumber(opts.speed, "--speed", 0.25, 4);
    const slowMo = boundedNumber(opts.slowMo, "--slow-mo", 0, 5_000);

    const runResult = await runSpec({
      specPath,
      backend,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      coldStart,
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      captureOverride: { video: "always" },
      videoOptions: {
        ...(speed !== undefined ? { speed } : {}),
        ...(slowMo !== undefined ? { slowMo } : {}),
      },
      ...(services && services.events.length > 0
        ? { servicesEvents: services.events }
        : {}),
      onArchiveRun: async (runDir, _runId, tags) => {
        const archived = await stashDirectory(runDir, {
          tool: "cairntrace",
          tags,
        });
        if (!archived.ok) {
          throw new Error(
            `file.cheap archive failed: ${archived.error ?? "unknown error"}`,
          );
        }
      },
      workerIndex: 0,
    });

    result.runId = runResult.runId;
    result.runDir = runResult.runDir;
    result.status = runResult.status;
    result.exitCode = runResult.exitCode;

    if (runResult.artifacts.video) {
      result.videoPath = `${runResult.runDir}/${runResult.artifacts.video}`;
    }

    if (result.videoPath) {
      const vidtraceOk = await isVidtraceAvailable();
      if (vidtraceOk) {
        const vidR = await runVidtraceExtract(result.videoPath);
        if (vidR.ok) {
          try {
            const vidData = JSON.parse(vidR.stdout) as {
              output_dir?: unknown;
              bundle_dir?: unknown;
            };
            const bundle = vidData.output_dir ?? vidData.bundle_dir;
            if (typeof bundle === "string" && bundle.trim()) {
              const requestedOutputRoot = join(
                dirname(result.videoPath),
                "vidtrace",
              );
              if (!pathIsWithin(requestedOutputRoot, bundle)) {
                result.warnings?.push(
                  "vidtrace returned a bundle outside the requested run directory; ignored it",
                );
              } else {
                result.vidtraceBundle = resolve(bundle);
                await redactVidtraceTextArtifacts(result.vidtraceBundle).catch(
                  (error) => {
                    result.warnings?.push(
                      `could not redact vidtrace text artifacts: ${(error as Error).message}`,
                    );
                  },
                );
              }
            } else {
              result.warnings?.push(
                "vidtrace returned JSON without output_dir or bundle_dir",
              );
            }
          } catch (error) {
            result.warnings?.push(
              `vidtrace returned invalid JSON: ${(error as Error).message}`,
            );
          }
        } else {
          result.warnings?.push(
            `vidtrace extract failed: ${vidtraceFailureMessage(vidR)}`,
          );
        }
      } else {
        result.warnings?.push(
          "vidtrace not on $PATH; skipped video evidence extraction",
        );
      }
    } else {
      result.error =
        "Playwright did not produce the required audit video; vidtrace extraction was skipped";
    }

    if (connect) {
      if (!codebase) {
        result.error =
          "--connect requires --codebase <dir> or investigate.codebaseDir in config";
      } else if (result.runDir && result.runId) {
        const runStash = await stashDirectory(result.runDir, {
          tool: "cairntrace",
          tags: [`audit-${result.runId}`],
        });
        if (!runStash.ok || !runStash.stashId) {
          result.error = `fcheap save failed: ${runStash.error ?? "missing stash id"}`;
        } else {
          result.stashId = runStash.stashId;
          if (runStash.warning) {
            result.warnings?.push(
              `run stash completed with post-save failures: ${runStash.warning}`,
            );
          }
          let connectStashId = runStash.stashId;
          if (result.vidtraceBundle && existsSync(result.vidtraceBundle)) {
            const evidenceStash = await stashDirectory(result.vidtraceBundle, {
              tool: "cairntrace",
              tags: [`audit-evidence-${result.runId}`],
              source: result.runDir,
            });
            if (evidenceStash.ok && evidenceStash.stashId) {
              result.evidenceStashId = evidenceStash.stashId;
              connectStashId = evidenceStash.stashId;
              if (evidenceStash.warning) {
                result.warnings?.push(
                  `vidtrace evidence stash completed with post-save failures: ${evidenceStash.warning}`,
                );
              }
            } else {
              result.warnings?.push(
                `vidtrace evidence stash failed; connected the run stash instead: ${
                  evidenceStash.error ?? "missing stash id"
                }`,
              );
            }
          }

          const investigation = await investigateRunDirectory(
            result.runDir,
            result.runId,
            {
              stashId: connectStashId,
              connect: true,
              codebase,
              mode,
              limit,
              index,
            },
          );
          result.codeMatches = investigation.codeMatches;
          result.warnings?.push(...(investigation.warnings ?? []));
          if (investigation.error) result.error = investigation.error;
        }
      }
    } else if (runResult.status !== "passed" && result.runDir) {
      const autoStash = await maybeAutoStash(
        result.runDir,
        result.runId,
        runResult.spec.name,
        {
          stashOnFailure: false,
          ...(stashConfig ? { configStash: stashConfig } : {}),
        },
      );
      if (autoStash?.ok && autoStash.stashId) {
        result.stashId = autoStash.stashId;
      } else if (autoStash && !autoStash.ok) {
        result.warnings?.push(
          `failed-run stash failed: ${autoStash.error ?? "unknown error"}`,
        );
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    await backend?.close().catch(() => undefined);
    stopTrackingBackend?.();
    await services?.stop().catch(() => undefined);
    stopTrackingServices?.();
    await server?.stop().catch(() => undefined);
    stopTrackingServer?.();
  }

  if (result.warnings?.length === 0) delete result.warnings;
  return AuditResultSchema.parse(
    createArtifactRedactor(undefined).value(result),
  );
}

export function auditResultExitCode(result: AuditResult): number {
  if (result.error) return 2;
  return result.exitCode ?? 0;
}

export async function auditCommand(
  specPath: string,
  opts: AuditOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const result = AuditResultSchema.parse(await auditSpec(specPath, opts));
  for (const warning of result.warnings ?? []) {
    process.stderr.write(`cairn audit: warning: ${warning}\n`);
  }
  if (result.error) {
    process.stderr.write(`cairn audit: ${result.error}\n`);
  }
  process.exitCode = auditResultExitCode(result);
  process.stdout.write(emit(format, result, () => auditMarkdown(result)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function auditMarkdown(r: AuditResult): string {
  const lines = [
    `# Audit: ${r.specPath}`,
    "",
    ...(r.runId ? [`- runId: ${r.runId}`] : []),
    ...(r.runDir ? [`- runDir: ${r.runDir}`] : []),
    ...(r.status ? [`- status: ${r.status}`] : []),
    ...(r.videoPath ? [`- video: ${r.videoPath}`] : []),
    ...(r.vidtraceBundle ? [`- vidtrace bundle: ${r.vidtraceBundle}`] : []),
    ...(r.stashId ? [`- stashId: ${r.stashId}`] : []),
    ...(r.evidenceStashId ? [`- evidence stashId: ${r.evidenceStashId}`] : []),
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

  if (r.warnings?.length) {
    lines.push("", "## Warnings", "", ...r.warnings.map((w) => `- ${w}`));
  }

  return lines.join("\n");
}

/* ----- format helper ----- */

export type { OutputFormat } from "../format";
