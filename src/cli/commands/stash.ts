import { lstat, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  resolveArtifactRoot,
  resolveArtifactRootContext,
  resolveRunRef,
} from "../runRefs";
import { emit, resolveFormat } from "../format";
import { log } from "../logger";
import type { OutputFormat } from "../format";
import { type CodemapDeps, defaultCodemapDeps } from "./annotate.js";
import { expandSymbolQuery } from "./codemap.js";
import {
  FcheapContractError,
  parseFcheapInfoOutput,
  parseFcheapListOutput,
  parseFcheapRestoreOutput,
  parseFcheapSaveOutput,
  parseFcheapSearchOutput,
  type FcheapInfo,
  type FcheapListItem,
  type FcheapRestoreResult,
  type FcheapSearchResult,
} from "./fcheapContract.js";
import {
  classifyFcheapFailure,
  fcheapSupportsSaveMeta,
  runFcheap,
} from "./fcheapClient.js";
import {
  ArtifactWriter,
  type ArtifactRedactor,
} from "../../core/artifacts/ArtifactWriter.js";
import {
  selectRunEvidence,
  stageRunEvidence,
} from "../../core/artifacts/evidenceSelection.js";
import { createArtifactRedactor } from "../../core/artifacts/redaction.js";
import { pathFreeMessage } from "../../core/artifacts/retention.js";
import {
  EvidenceCategorySchema,
  type EvidenceCategory,
  type StashConfig,
} from "../../core/schema/config.v1.js";
import type { EvidenceFailureReason } from "../../core/schema/events.v1.js";
import {
  StashReceiptSchema,
  type StashReceipt,
} from "../../core/schema/stash.v1.js";
import { CAIRN_VERSION } from "../version.js";

export { isFcheapAvailable } from "./fcheapClient.js";

/* ---------------------------------------------------------------------------
 * Stash types
 * ------------------------------------------------------------------------- */

export interface StashSaveResult {
  runId: string;
  stashId: string;
  path: string;
  tags: string[];
  tool: string;
  source?: string;
  status?: "saved" | "saved_with_failures";
  failures?: Array<{ id: string; stage: string; error: string }>;
  /** Relative paths/dirs the evidence gate left out (`traces/`). */
  excluded?: string[];
  /** Secret-scanner findings file.cheap reported for the saved copy. */
  secretsFound?: number;
  ttl?: string;
  expiresAt?: string;
  /** Run-relative receipt written into the run (`stash-receipt.json`). */
  receipt?: string;
}

export type StashListItem = FcheapListItem;
export type StashInfo = FcheapInfo;
export type StashSearchResult = FcheapSearchResult;

/** Default TTL of a PASSED run's auto-stash (`stash.passTtl`). */
export const DEFAULT_PASS_STASH_TTL = "7d";
/**
 * Default TTL of a FAILED run's auto-stash (`stash.failTtl`). Pinned runs
 * (`cairn pin --stash`) are saved separately without a TTL; `failTtl: never`
 * opts out.
 */
export const DEFAULT_FAIL_STASH_TTL = "90d";

/* ---------------------------------------------------------------------------
 * Stash commands
 * ------------------------------------------------------------------------- */

/**
 * Labels stamped by `cairn run --label key=value`, as sorted `key=value`
 * tags. Entries that would make an ambiguous tag (an `=` in the key, a comma,
 * which file.cheap splits tag flags on, or whitespace) are skipped.
 */
export function tagsFromLabels(
  labels: Record<string, string> | undefined,
): string[] {
  if (!labels) return [];
  return Object.entries(labels)
    .filter(
      ([key, value]) =>
        key.length > 0 &&
        !/[=,\s]/.test(key) &&
        typeof value === "string" &&
        !/[,\s]/.test(value),
    )
    .map(([key, value]) => `${key}=${value}`)
    .toSorted();
}

/** Read `labels` from a run directory's run.json; missing or invalid yields {}. */
export async function readRunLabels(
  runDir: string,
): Promise<Record<string, string>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  } catch {
    return {};
  }
  const labels = (raw as { labels?: unknown } | null)?.labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Explicit tags first, then (optionally) run.json labels, without duplicates. */
export async function stashTagsForRun(
  runDir: string,
  explicit: string[] | undefined,
  labelsAsTags: boolean | undefined,
): Promise<string[]> {
  const tags = [...(explicit ?? [])];
  if (labelsAsTags) {
    for (const tag of tagsFromLabels(await readRunLabels(runDir))) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

/** A spec's `stash.tags` as recorded in the run's spec.resolved.yml. */
export async function readSpecStashTags(runDir: string): Promise<string[]> {
  try {
    const spec = parseYaml(
      await readFile(join(runDir, "spec.resolved.yml"), "utf8"),
    ) as { stash?: { tags?: unknown } } | null;
    const tags = spec?.stash?.tags;
    return Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === "string" && !!tag)
      : [];
  } catch {
    return [];
  }
}

/**
 * file.cheap's `--meta` rules (internal/stash/metadata.go): at most 32
 * entries, keys `^[a-z0-9][a-z0-9_.-]{0,63}$`, values at most 256 BYTES with
 * no control characters (Unicode Cc: C0, DEL, C1), and a few reserved keys
 * the vault writes itself. One violation makes fcheap refuse the whole save.
 */
const FCHEAP_META_MAX_ENTRIES = 32;
const FCHEAP_META_MAX_VALUE_BYTES = 256;
const FCHEAP_META_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const FCHEAP_META_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "source",
  "indexed",
  "indexed_files",
  "secrets_found",
  "secrets_rules",
  "source_video",
  "duration_seconds",
  "frame_rate",
]);

/**
 * Cut `value` to at most `maxBytes` UTF-8 bytes without splitting a code
 * point (a 4-byte emoji that does not fit is dropped whole).
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    out += character;
    used += size;
  }
  return out;
}

/** A `--meta` value fcheap accepts: control characters out, bytes bounded. */
function cleanMetaValue(value: string): string {
  return truncateUtf8(
    // eslint-disable-next-line no-control-regex
    value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
    FCHEAP_META_MAX_VALUE_BYTES,
  );
}

/**
 * Make `--meta` pairs acceptable to file.cheap: drop keys it rejects (or
 * reserves), clean and byte-truncate values, drop empty values, keep at most
 * 32 entries. Metadata is an index aid, never a reason to lose evidence.
 */
export function sanitizeStashMeta(
  meta: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (Object.keys(out).length >= FCHEAP_META_MAX_ENTRIES) break;
    if (!FCHEAP_META_KEY.test(key) || FCHEAP_META_RESERVED_KEYS.has(key)) {
      continue;
    }
    if (typeof value !== "string") continue;
    const clean = cleanMetaValue(value);
    if (clean) out[key] = clean;
  }
  return out;
}

/**
 * Non-secret run identity passed as `fcheap save --meta key=value` (keys
 * file.cheap accepts: `[a-z0-9][a-z0-9_.-]*`, values ≤ 256 bytes).
 */
export function stashMetaForRun(run: {
  runId?: string;
  status?: string;
  spec?: { name?: string };
  environment?: string;
  backend?: string;
}): Record<string, string> {
  const meta: Record<string, string> = { cairn_version: CAIRN_VERSION };
  const put = (key: string, value: string | undefined): void => {
    if (value) meta[key] = value;
  };
  put("run_id", run.runId);
  put("status", run.status);
  put("spec", run.spec?.name);
  put("env", run.environment);
  put("backend", run.backend);
  return sanitizeStashMeta(meta);
}

/** run.json fields the stash metadata needs (missing/invalid → {}). */
async function readRunIdentity(
  runDir: string,
): Promise<Parameters<typeof stashMetaForRun>[0]> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    return {
      ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(typeof raw.environment === "string"
        ? { environment: raw.environment }
        : {}),
      ...(typeof raw.backend === "string" ? { backend: raw.backend } : {}),
      ...(raw.spec &&
      typeof raw.spec === "object" &&
      typeof (raw.spec as { name?: unknown }).name === "string"
        ? { spec: { name: (raw.spec as { name: string }).name } }
        : {}),
    };
  } catch {
    return {};
  }
}

export interface StashSaveOptions {
  artifactRoot?: string;
  config?: string;
  tag?: string[];
  /** Add every run.json `labels` entry as a `key=value` tag. */
  labelsAsTags?: boolean;
  /** file.cheap TTL such as `30d`; omitted keeps the stash until dropped. */
  ttl?: string;
  /**
   * Evidence categories to carry (repeatable); default config
   * `stash.include`, else [text, screenshots].
   */
  include?: string[];
  tool?: string;
  source?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/** Parse `--include` values; throws on an unknown category or missing `text`. */
export function parseIncludeFlag(
  values: readonly string[] | undefined,
): EvidenceCategory[] | undefined {
  if (!values || values.length === 0) return undefined;
  const categories = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const parsed: EvidenceCategory[] = [];
  for (const category of categories) {
    const result = EvidenceCategorySchema.safeParse(category);
    if (!result.success) {
      throw new Error(
        `--include expects text, screenshots, traces, videos or downloads; got "${category}"`,
      );
    }
    if (!parsed.includes(result.data)) parsed.push(result.data);
  }
  if (!parsed.includes("text")) parsed.unshift("text");
  return parsed;
}

/** The project config `stash` block (undefined when absent or invalid). */
export async function loadStashConfig(
  configPath: string | undefined,
): Promise<StashConfig | undefined> {
  try {
    const context = await resolveArtifactRootContext(
      configPath ? { config: configPath } : {},
    );
    return context.loaded?.config.stash;
  } catch {
    return undefined;
  }
}

/**
 * `cairn stash save <run-id>` — stash a run directory to fcheap through the
 * evidence gate (default [text, screenshots]; `--include` or config
 * `stash.include` opt into traces/videos/downloads) and record a
 * `stash-receipt.json` + `artifact.stash` event (action `manual`).
 */
export async function stashSaveCommand(
  runRef: string,
  opts: StashSaveOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let include: EvidenceCategory[] | undefined;
  try {
    include = parseIncludeFlag(opts.include);
  } catch (error) {
    process.stderr.write(`cairn stash save: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const root = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  const runDir = await resolveRunRef(runRef, root);
  const runId = basename(runDir);
  const config = await loadStashConfig(opts.config);

  const tags = await stashTagsForRun(runDir, opts.tag, opts.labelsAsTags);
  const tool = opts.tool ?? "cairntrace";

  const saved = await stashRunDirectory(runDir, {
    action: "manual",
    tool,
    tags,
    ...(opts.ttl ? { ttl: opts.ttl } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...((include ?? config?.include)
      ? { include: include ?? config?.include }
      : {}),
    ...(config?.unsafeIncludeRawTraces ? { unsafeIncludeRawTraces: true } : {}),
    meta: config?.meta !== false,
  });
  if (!saved.ok || !saved.stashId) {
    process.stderr.write(
      `cairn stash save: ${saved.error ?? "fcheap failed without a stash receipt"}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const result: StashSaveResult = {
    runId,
    stashId: saved.stashId,
    path: runDir,
    tags,
    tool,
    ...(opts.source ? { source: opts.source } : {}),
    ...(saved.status ? { status: saved.status } : {}),
    ...(saved.failures?.length ? { failures: saved.failures } : {}),
    ...(saved.excluded.length > 0 ? { excluded: saved.excluded } : {}),
    ...(saved.secretsFound !== undefined
      ? { secretsFound: saved.secretsFound }
      : {}),
    ...(saved.ttl ? { ttl: saved.ttl } : {}),
    ...(saved.expiresAt ? { expiresAt: saved.expiresAt } : {}),
    ...(saved.receipt ? { receipt: saved.receipt } : {}),
  };

  if (saved.warning) {
    process.stderr.write(`cairn stash save: warning: ${saved.warning}\n`);
    process.exitCode = 2;
  }
  if (saved.secretsFound) {
    process.stderr.write(
      `cairn stash save: warning: ${secretsWarning(saved.secretsFound, saved.secretsRules)}\n`,
    );
  }
  process.stdout.write(
    emit(format, result, () => stashSaveMarkdown(result, runId)),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function stashSaveMarkdown(r: StashSaveResult, runId: string): string {
  return [
    `# Stashed run ${runId}`,
    "",
    `- stashId: ${r.stashId}`,
    `- path: ${r.path}`,
    `- tool: ${r.tool}`,
    ...(r.tags.length > 0 ? [`- tags: ${r.tags.join(", ")}`] : []),
    ...(r.source ? [`- source: ${r.source}`] : []),
    ...(r.status ? [`- status: ${r.status}`] : []),
    ...(r.excluded?.length ? [`- excluded: ${r.excluded.join(", ")}`] : []),
    ...(r.secretsFound !== undefined
      ? [`- secretsFound: ${r.secretsFound}`]
      : []),
    ...(r.ttl ? [`- ttl: ${r.ttl}`] : []),
    ...(r.expiresAt ? [`- expiresAt: ${r.expiresAt}`] : []),
    ...(r.failures ?? []).map(
      (failure) => `- ${failure.stage} failed: ${failure.error}`,
    ),
  ].join("\n");
}

function secretsWarning(count: number, rules: string[] | undefined): string {
  return `file.cheap's secret scan flagged ${count} potential secret(s)${
    rules?.length ? ` (${rules.join(", ")})` : ""
  } in the stashed copy — review it before sharing or restoring elsewhere`;
}

/* ----- list ----- */

export interface StashListOptions {
  /** Repeatable; file.cheap requires every listed tag (AND). */
  tag?: string | string[];
  tool?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn stash list` — list stashes (optionally filtered by tag/tool).
 */
export async function stashListCommand(opts: StashListOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const args = ["list"];
  const listTags = typeof opts.tag === "string" ? [opts.tag] : (opts.tag ?? []);
  for (const tag of listTags) args.push("--tag", tag);
  if (opts.tool) args.push("--tool", opts.tool);

  const r = await runFcheap(args, { json: true });

  if (!r.ok) {
    process.stderr.write(`cairn stash list: ${r.stderr || "fcheap failed"}\n`);
    process.exit(2);
  }

  let items: StashListItem[];
  try {
    items = parseFcheapListOutput(r.stdout);
  } catch (error) {
    process.stderr.write(`cairn stash list: ${(error as Error).message}\n`);
    process.exit(2);
  }
  const result = { stashes: items };

  process.stdout.write(emit(format, result, () => stashListMarkdown(items)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function stashListMarkdown(items: StashListItem[]): string {
  if (items.length === 0) return "# Stashes\n\n(no stashes found)";
  const lines = [
    "# Stashes",
    "",
    ...items.map((s) => {
      const tags = s.tags?.length ? ` [${s.tags.join(", ")}]` : "";
      const tool = s.tool ? ` (${s.tool})` : "";
      const size = ` — ${(s.sizeBytes / 1024).toFixed(1)} KB`;
      return `- ${s.id}${tool}${tags}${size}`;
    }),
  ];
  return lines.join("\n");
}

/* ----- info ----- */

export interface StashInfoOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn stash info <stash-id>` — get detailed info about a stash.
 */
export async function stashInfoCommand(
  stashId: string,
  opts: StashInfoOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const r = await runFcheap(["info", stashId], { json: true });

  if (!r.ok) {
    process.stderr.write(`cairn stash info: ${r.stderr || "fcheap failed"}\n`);
    process.exit(2);
  }

  let info: StashInfo;
  try {
    info = parseFcheapInfoOutput(r.stdout);
  } catch (error) {
    process.stderr.write(`cairn stash info: ${(error as Error).message}\n`);
    process.exit(2);
  }

  process.stdout.write(emit(format, info, () => stashInfoMarkdown(info)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function stashInfoMarkdown(info: StashInfo): string {
  const lines = [
    `# Stash ${info.id}`,
    "",
    ...(info.name ? [`- name: ${info.name}`] : []),
    ...(info.tool ? [`- tool: ${info.tool}`] : []),
    ...(info.sourcePath ? [`- source path: ${info.sourcePath}`] : []),
    ...(info.source ? [`- provenance source: ${info.source}`] : []),
    ...(info.tags.length ? [`- tags: ${info.tags.join(", ")}`] : []),
    `- created: ${info.createdAt}`,
    `- files: ${info.fileCount}`,
    `- size: ${(info.sizeBytes / 1024).toFixed(1)} KB`,
  ];
  if (info.files?.length) {
    lines.push("", "## Files", "");
    for (const f of info.files) {
      lines.push(`- ${f.path} (${f.size} bytes)`);
    }
  }
  return lines.join("\n");
}

/* ----- restore ----- */

export interface StashRestoreOptions {
  to?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn stash restore <stash-id>` — restore a stash to a directory.
 */
export async function stashRestoreCommand(
  stashId: string,
  opts: StashRestoreOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const args = ["restore", stashId];
  if (opts.to) args.push("--to", opts.to);

  const r = await runFcheap(args, { json: true });

  let result: FcheapRestoreResult;
  try {
    result = parseFcheapRestoreOutput(r.stdout);
  } catch (error) {
    process.stderr.write(
      `cairn stash restore: ${
        !r.ok && r.stderr ? r.stderr : (error as Error).message
      }\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    emit(format, result, () => stashRestoreMarkdown(result)),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (!r.ok) {
    process.stderr.write(
      `cairn stash restore: ${
        r.stderr || `verification failed with status ${result.status}`
      }\n`,
    );
    process.exitCode = 2;
  }
}

function stashRestoreMarkdown(r: FcheapRestoreResult): string {
  return [
    `# Restored stash ${r.stashId}`,
    "",
    `- restoredTo: ${r.restoredTo}`,
    `- files: ${r.fileCount}`,
    `- verified: ${r.verified}`,
    `- status: ${r.status}`,
    ...(r.mismatches.length > 0
      ? [`- mismatches: ${r.mismatches.join(", ")}`]
      : []),
  ].join("\n");
}
/* ----- search (FEATURES item 5: codemap-seeded symbol search) ----- */

export interface StashSearchOptions {
  mode?: string;
  limit?: number;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * Injectable seams for `cairn stash search` so tests can substitute a fake
 * codemap (symbol expansion) and a fake fcheap (the search itself) without
 * touching $PATH. Mirrors the CodemapDeps seam from annotate.ts.
 */
export interface StashSearchDeps {
  /** Codemap client for `semantic`/`find` symbol expansion. */
  codemap?: CodemapDeps;
  /** fcheap `search` executor; receives args WITHOUT the trailing --json. */
  fcheapExec?: (args: string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/** Default fcheap executor: shells `fcheap <args> --json` via execa. */
const defaultFcheapExec: NonNullable<StashSearchDeps["fcheapExec"]> = async (
  args,
) => {
  const result = await runFcheap(args, { json: true });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export interface StashSearchOutcome {
  /** The original user query (the symbol or free-text). */
  query: string;
  /** Terms fcheap was searched with (symbol + codemap-expanded terms). */
  expandedTerms: string[];
  results: StashSearchResult[];
  error?: string;
}

/**
 * Core of `cairn stash search <symbol>`: expand the symbol into fcheap search
 * terms via `codemap semantic`/`find` (best-effort — falls back to the bare
 * symbol when codemap is absent), then run `fcheap search`. Exported so tests
 * can verify the codemap seeding + result parsing without a real fcheap.
 * (FEATURES item 5 — fcheap as the run-artifact substrate, reverse direction.)
 */
export async function searchStashesForSymbol(
  symbol: string,
  opts: { mode?: string; limit?: number } = {},
  deps: StashSearchDeps = {},
): Promise<StashSearchOutcome> {
  const expandedTerms = await expandSymbolQuery(
    symbol,
    deps.codemap ?? defaultCodemapDeps,
  );
  const fcheapExec = deps.fcheapExec ?? defaultFcheapExec;
  const args = ["search", expandedTerms.join(" ")];
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.limit) args.push("--limit", String(opts.limit));

  const r = await fcheapExec(args);
  if (r.exitCode !== 0) {
    return {
      query: symbol,
      expandedTerms,
      results: [],
      error: r.stderr || "fcheap failed",
    };
  }
  try {
    const results = parseFcheapSearchOutput(r.stdout);
    return { query: symbol, expandedTerms, results };
  } catch (error) {
    return {
      query: symbol,
      expandedTerms,
      results: [],
      error: (error as Error).message,
    };
  }
}

/**
 * `cairn stash search <query>` — search across all stashes. When codemap is on
 * $PATH the query is seeded with the symbol's file + docstring terms (feature
 * 5) so stashes whose metadata references the symbol surface; otherwise this
 * is plain `fcheap search` (no regression).
 */
export async function stashSearchCommand(
  query: string,
  opts: StashSearchOptions,
  deps: StashSearchDeps = {},
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const outcome = await searchStashesForSymbol(
    query,
    { mode: opts.mode, limit: opts.limit },
    deps,
  );

  if (outcome.error) {
    process.stderr.write(`cairn stash search: ${outcome.error}\n`);
    process.exit(2);
  }

  const result = {
    query: outcome.query,
    results: outcome.results,
    ...(outcome.expandedTerms.length > 1
      ? { expandedTerms: outcome.expandedTerms }
      : {}),
  };

  process.stdout.write(emit(format, result, () => stashSearchMarkdown(result)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function stashSearchMarkdown(r: {
  query: string;
  results: StashSearchResult[];
}): string {
  if (r.results.length === 0) {
    return `# Stash search: "${r.query}"\n\n(no results)`;
  }
  const lines = [
    `# Stash search: "${r.query}"`,
    "",
    ...r.results.map((s) => {
      const score = ` (score: ${s.score.toFixed(2)})`;
      const file = s.file ? ` in ${s.file}` : "";
      return `- ${s.stashId}${file}${score}: ${s.snippet}`;
    }),
  ];
  return lines.join("\n");
}

/* ----- reusable stash helper (services lifecycle, investigate, clip) ----- */

/**
 * Stash a directory to the fcheap vault. Best-effort: returns a result
 * object instead of throwing. A cairn run directory (it holds `run.json`)
 * always goes through the evidence gate ({@link selectRunEvidence}), so no
 * caller can ship its traces, raw profiles or other secret-bearing members
 * by accident; other directories (services captures, clip/vidtrace output)
 * are saved as they are.
 */
export interface StashDirectoryResult {
  ok: boolean;
  stashId?: string;
  status?: "saved" | "saved_with_failures";
  failures?: Array<{ id: string; stage: string; error: string }>;
  warning?: string;
  error?: string;
  /** Path-free failure code when `ok` is false. */
  reason?: EvidenceFailureReason;
  contentHash?: string;
  fileCount?: number;
  sizeBytes?: number;
  expiresAt?: string;
  /** fcheap rejected the `--meta` pairs; the stash was saved without them. */
  metaDropped?: true;
  /** Secret-scanner findings from the save manifest (`custom.secrets_found`). */
  secretsFound?: number;
  secretsRules?: string[];
  /** Run directories: relative paths/dirs the evidence gate left out. */
  excluded?: string[];
}

interface SaveDirectoryOptions {
  name?: string;
  tool?: string;
  tags?: string[];
  source?: string;
  ttl?: string;
  /** `--meta key=value` pairs (caller checked fcheap supports them). */
  meta?: Record<string, string>;
}

export async function stashDirectory(
  dir: string,
  /** Run directories: evidence categories (default [text, screenshots]). */
  /** Run directories: keep secret-bearing members (private vault only). */
  opts: SaveDirectoryOptions & {
    include?: readonly EvidenceCategory[];
    unsafeIncludeRawTraces?: boolean;
  } = {},
): Promise<StashDirectoryResult> {
  if (await isRunDirectory(dir)) {
    const { include, unsafeIncludeRawTraces, ...save } = opts;
    return saveRunEvidence(dir, {
      ...save,
      ...(include ? { include } : {}),
      ...(unsafeIncludeRawTraces ? { unsafeIncludeRawTraces: true } : {}),
    });
  }
  return saveDirectory(dir, opts);
}

/** A cairn run directory: `run.json` is a regular file at its top. */
async function isRunDirectory(dir: string): Promise<boolean> {
  return lstat(join(dir, "run.json")).then(
    (info) => info.isFile(),
    () => false,
  );
}

/**
 * Save a run directory through the evidence gate: when anything is left out
 * a private staged copy named after the run is saved instead (its `--source`
 * is the run directory); otherwise the directory is saved in place.
 */
async function saveRunEvidence(
  runDir: string,
  opts: SaveDirectoryOptions & {
    include?: readonly EvidenceCategory[];
    unsafeIncludeRawTraces?: boolean;
  },
): Promise<StashDirectoryResult & { excluded: string[] }> {
  let staged: Awaited<ReturnType<typeof stageRunEvidence>> | undefined;
  let excluded: string[] = [];
  try {
    const selection = await selectRunEvidence(runDir, {
      purpose: "stash",
      ...(opts.include ? { include: opts.include } : {}),
      ...(opts.unsafeIncludeRawTraces ? { unsafeIncludeRawTraces: true } : {}),
    });
    excluded = selection.excluded;
    if (!selection.complete) {
      staged = await stageRunEvidence(runDir, selection, basename(runDir));
    }
    const { include: _include, unsafeIncludeRawTraces: _unsafe, ...save } =
      opts;
    const result = await saveDirectory(staged?.dir ?? runDir, {
      ...save,
      ...(staged
        ? { name: opts.name ?? basename(runDir), source: opts.source ?? runDir }
        : {}),
    });
    return { ...result, excluded };
  } catch (error) {
    return {
      ok: false,
      error: `could not prepare the run for stashing: ${(error as Error).message}`,
      reason: "unknown",
      excluded,
    };
  } finally {
    await staged?.cleanup().catch(() => undefined);
  }
}

/** `fcheap save <dir>` with no evidence gate (callers gate run dirs). */
async function saveDirectory(
  dir: string,
  opts: SaveDirectoryOptions,
): Promise<StashDirectoryResult> {
  const tool = opts.tool ?? "cairntrace";
  const buildArgs = (meta: Record<string, string>): string[] => [
    "save",
    dir,
    "--tool",
    tool,
    ...(opts.name ? ["--name", opts.name] : []),
    ...(opts.tags ?? []).flatMap((t) => ["--tag", t]),
    ...(opts.source ? ["--source", opts.source] : []),
    ...(opts.ttl ? ["--ttl", opts.ttl] : []),
    ...Object.entries(meta).flatMap(([key, value]) => [
      "--meta",
      `${key}=${value}`,
    ]),
  ];
  const meta = sanitizeStashMeta(opts.meta);
  let r = await runFcheap(buildArgs(meta), { json: true });
  let metaDropped: string | undefined;
  // fcheap validates `--meta` before it saves anything and refuses the whole
  // save on one bad pair: retry once without it so evidence is never lost to
  // metadata (the sanitizer makes this a safety net for rule drift).
  if (
    !r.ok &&
    !r.missing &&
    !r.timedOut &&
    Object.keys(meta).length > 0 &&
    r.stdout.trim() === "" &&
    /\bmetadata\b|--meta\b/i.test(r.stderr)
  ) {
    metaDropped = pathFreeMessage(
      (r.stderr.split(/\r?\n/).find((line) => line.trim()) ?? "").trim(),
    ).slice(0, 200);
    r = await runFcheap(buildArgs({}), { json: true });
  }
  try {
    const receipt = parseFcheapSaveOutput(r.stdout);
    const receiptFields = {
      stashId: receipt.stashId,
      ...(receipt.status ? { status: receipt.status } : {}),
      ...(receipt.failed?.length ? { failures: receipt.failed } : {}),
      ...(receipt.contentHash ? { contentHash: receipt.contentHash } : {}),
      ...(receipt.fileCount !== undefined
        ? { fileCount: receipt.fileCount }
        : {}),
      ...(receipt.sizeBytes !== undefined
        ? { sizeBytes: receipt.sizeBytes }
        : {}),
      ...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : {}),
      // file.cheap records `secrets_found` only when its save-time scan
      // matched something, so an absent field is zero findings.
      secretsFound: receipt.secretsFound ?? 0,
      ...(receipt.secretsRules ? { secretsRules: receipt.secretsRules } : {}),
    };
    if (!r.ok && receipt.status !== "saved_with_failures") {
      return {
        ok: false,
        ...receiptFields,
        error: r.stderr || "fcheap failed after emitting a save receipt",
        reason: classifyFcheapFailure(r),
      };
    }
    const saveWarning =
      receipt.status === "saved_with_failures"
        ? r.stderr ||
          `stash saved with ${receipt.failed?.length ?? 0} failed post-save operation(s)`
        : undefined;
    const warning = [
      saveWarning,
      metaDropped !== undefined
        ? `run metadata was not saved (fcheap rejected --meta${
            metaDropped ? `: ${metaDropped}` : ""
          }); the evidence was saved without it`
        : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    return {
      ok: true,
      ...receiptFields,
      ...(warning ? { warning } : {}),
      ...(metaDropped !== undefined ? { metaDropped: true } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: !r.ok
        ? r.stderr || (error as Error).message
        : error instanceof FcheapContractError
          ? error.message
          : `Invalid fcheap save response: ${(error as Error).message}`,
      reason: r.ok ? "save-failed" : classifyFcheapFailure(r),
    };
  }
}

/* ----- gated run stash (auto-stash, stash save, archive, pin) ----- */

/**
 * The config `stash` evidence options an explicit run stash honors
 * (investigate, audit `--connect`, `clip --stash`): the gate's
 * categories, the unsafe opt-in, and run-identity `--meta`. TTLs are
 * auto-stash/archive settings; an explicit stash keeps none, like
 * `cairn stash save` without `--ttl`.
 */
export type RunStashEvidence = Pick<
  StashConfig,
  "include" | "unsafeIncludeRawTraces" | "meta"
>;

export interface RunStashOptions {
  /** auto-stash / manual write a receipt + event; archive writes neither. */
  action: "auto-stash" | "manual" | "archive";
  tags: string[];
  tool?: string;
  ttl?: string;
  source?: string;
  /** Evidence categories (default [text, screenshots]). */
  include?: readonly EvidenceCategory[];
  unsafeIncludeRawTraces?: boolean;
  /**
   * Pass run identity as `--meta` when fcheap supports it: `true` reads it
   * from run.json, an object is used as-is, false/undefined skips it.
   */
  meta?: boolean | Record<string, string>;
}

export interface RunStashResult extends StashDirectoryResult {
  /** Relative paths/dirs the evidence gate left out. */
  excluded: string[];
  tags: string[];
  ttl?: string;
  /** Run-relative receipt path when one was written. */
  receipt?: string;
}

/**
 * Stash one run directory through the evidence gate. Excluded categories
 * (and secret-bearing members) are left out by saving a private staged copy
 * named after the run; a run with nothing excluded is saved in place. For
 * `auto-stash`/`manual` the outcome is recorded in the run: a
 * `stash-receipt.json` + `artifact.stash` event on success, an
 * `artifact.stash` event with `status: "error"` and a reason code otherwise.
 */
export async function stashRunDirectory(
  runDir: string,
  opts: RunStashOptions,
): Promise<RunStashResult> {
  let meta: Record<string, string> | undefined;
  try {
    meta =
      opts.meta && (await fcheapSupportsSaveMeta())
        ? typeof opts.meta === "object"
          ? opts.meta
          : stashMetaForRun(await readRunIdentity(runDir))
        : undefined;
  } catch {
    meta = undefined;
  }
  const { excluded, ...result } = await saveRunEvidence(runDir, {
    tool: opts.tool ?? "cairntrace",
    tags: opts.tags,
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.ttl ? { ttl: opts.ttl } : {}),
    ...(meta ? { meta } : {}),
    ...(opts.include ? { include: opts.include } : {}),
    ...(opts.unsafeIncludeRawTraces ? { unsafeIncludeRawTraces: true } : {}),
  });
  const outcome: RunStashResult = {
    ...result,
    excluded,
    tags: opts.tags,
    ...(opts.ttl ? { ttl: opts.ttl } : {}),
  };
  if (opts.action === "archive") return outcome;
  try {
    if (outcome.ok && outcome.stashId) {
      await writeStashReceipt(runDir, outcome, opts.action);
      outcome.receipt = "stash-receipt.json";
    } else {
      await appendStashErrorEvent(runDir, opts.action, outcome);
    }
  } catch (error) {
    const message = `stash receipt was not written (non-fatal): ${(error as Error).message}`;
    outcome.warning = outcome.warning
      ? `${outcome.warning}; ${message}`
      : message;
  }
  return outcome;
}

/* ----- auto-stash (called from Runner/run.ts) ----- */

export type AutoStashStatus = "passed" | "failed" | "errored" | "refused";

/**
 * Whether a settled run is auto-stashed: never a refused run; always with
 * `cairn run --stash`; failed/errored runs with `--stash-on-failure`;
 * otherwise per config `stash` (enabled + autoStash always|on-failure).
 */
export function shouldAutoStash(
  status: AutoStashStatus,
  opts: {
    stash?: boolean;
    stashOnFailure?: boolean;
    configStash?: { enabled?: boolean; autoStash?: string };
  },
): boolean {
  if (status === "refused") return false;
  if (opts.stash) return true;
  const failed = status !== "passed";
  if (failed && opts.stashOnFailure) return true;
  if (!opts.configStash?.enabled) return false;
  if (opts.configStash.autoStash === "always") return true;
  return failed && opts.configStash.autoStash === "on-failure";
}

/**
 * TTL for a run's auto-stash: passTtl/failTtl, then ttl, then the default
 * (passes 7d, failures 90d). `failTtl: never` yields no TTL.
 */
export function autoStashTtl(
  status: AutoStashStatus,
  config: Pick<StashConfig, "ttl" | "passTtl" | "failTtl"> | undefined,
): string | undefined {
  if (status === "passed") {
    return config?.passTtl ?? config?.ttl ?? DEFAULT_PASS_STASH_TTL;
  }
  const ttl = config?.failTtl ?? config?.ttl ?? DEFAULT_FAIL_STASH_TTL;
  return ttl === "never" ? undefined : ttl;
}

/**
 * Auto-stash a settled run (see {@link shouldAutoStash}). Best-effort:
 * failures are logged and recorded as an `artifact.stash` error event but
 * never crash the run.
 */
export async function maybeAutoStash(
  runDir: string,
  runId: string,
  specName: string,
  opts: {
    stashOnFailure?: boolean;
    /** `cairn run --stash`: stash regardless of status. */
    stash?: boolean;
    /** Settled run status (default "failed", the historical caller). */
    status?: AutoStashStatus;
    configStash?: Partial<
      Pick<
        StashConfig,
        | "enabled"
        | "tags"
        | "include"
        | "unsafeIncludeRawTraces"
        | "ttl"
        | "passTtl"
        | "failTtl"
        | "labelsAsTags"
        | "meta"
      >
    > & { autoStash?: string };
    /** Run identity for `--meta` (default: read from run.json). */
    meta?: Record<string, string>;
    /** When provided (tty narration), replaces the logger for stash lines. */
    narrate?: (message: string, kind: "info" | "warn") => void;
  },
): Promise<RunStashResult | undefined> {
  const status = opts.status ?? "failed";
  if (!shouldAutoStash(status, opts)) return undefined;
  const say = (message: string, kind: "info" | "warn"): void => {
    if (opts.narrate) opts.narrate(message, kind);
    else if (kind === "warn") log.scope("stash").warn(message);
    else log.scope("stash").info(message);
  };

  const config = opts.configStash;
  const tags = uniqueTags([
    specName,
    ...(config?.tags ?? []),
    ...(await readSpecStashTags(runDir)),
    ...(config?.labelsAsTags
      ? tagsFromLabels(await readRunLabels(runDir))
      : []),
  ]);
  const ttl = autoStashTtl(status, config);
  const result = await stashRunDirectory(runDir, {
    action: "auto-stash",
    tool: "cairntrace",
    tags,
    ...(ttl ? { ttl } : {}),
    ...(config?.include ? { include: config.include } : {}),
    ...(config?.unsafeIncludeRawTraces ? { unsafeIncludeRawTraces: true } : {}),
    meta: config?.meta === false ? false : (opts.meta ?? true),
  });
  if (!result.ok) {
    say(`auto-stash failed (non-fatal): ${result.error ?? "unknown"}`, "warn");
    return result;
  }
  if (result.warning) say(`auto-stash warning: ${result.warning}`, "warn");
  if (result.secretsFound) {
    say(
      `auto-stash: ${secretsWarning(result.secretsFound, result.secretsRules)}`,
      "warn",
    );
  }
  const logSafeStashId = result.stashId
    ? createArtifactRedactor(undefined).text(result.stashId)
    : undefined;
  if (opts.narrate) {
    opts.narrate(
      `auto-stashed run ${runId}${
        logSafeStashId ? ` (stashId: ${logSafeStashId})` : ""
      }`,
      "info",
    );
  } else {
    log
      .scope("stash")
      .info(`auto-stashed run ${runId}`, { stashId: logSafeStashId });
  }
  return result;
}

function uniqueTags(tags: readonly string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.length > 0))];
}

/**
 * Add the local post-save receipt without reopening or changing run.json,
 * reports, or any semantic result field. The file and event contain only the
 * safe stash identifier plus bounded, path-free metadata (content hash,
 * counts, TTL, tags, excluded run-relative paths, secret-scan count). The
 * manifest is rebuilt so its checksummed inventory remains truthful after
 * this append-only enrichment.
 */
export async function writeStashReceipt(
  runDir: string,
  result: StashDirectoryResult & {
    excluded?: string[];
    tags?: string[];
    ttl?: string;
  },
  action: "auto-stash" | "manual",
  now: () => Date = () => new Date(),
): Promise<StashReceipt> {
  if (!result.ok || !result.stashId) {
    throw new Error("a successful stash id is required");
  }

  const receipt = StashReceiptSchema.parse({
    $schema: "urn:cairntrace.dev:stash-receipt:v1",
    version: "1",
    stashId: result.stashId,
    status: result.status ?? "saved",
    postSaveFailureCount: result.failures?.length ?? 0,
    recordedAt: now().toISOString(),
    action,
    ...(result.contentHash ? { contentHash: result.contentHash } : {}),
    ...(result.fileCount !== undefined ? { fileCount: result.fileCount } : {}),
    ...(result.sizeBytes !== undefined ? { sizeBytes: result.sizeBytes } : {}),
    ...(result.ttl ? { ttl: result.ttl } : {}),
    ...(result.expiresAt && isIsoTimestamp(result.expiresAt)
      ? { expiresAt: result.expiresAt }
      : {}),
    tags: result.tags ?? [],
    excluded: result.excluded ?? [],
    ...(result.secretsFound !== undefined
      ? { secretsFound: result.secretsFound }
      : {}),
    ...(result.metaDropped ? { metaDropped: true } : {}),
  });
  const redactor = stringOnlyRedactor();
  if (redactor.text(receipt.stashId) !== receipt.stashId) {
    throw new Error(
      "stash id intersects active secret redaction; recovery receipt was not written",
    );
  }
  const writer = new ArtifactWriter(runDir, redactor);
  await writer.writeJson("stash-receipt.json", receipt, "stash-receipt");
  await writer.appendEvent({
    ts: receipt.recordedAt,
    type: "artifact.stash",
    action,
    receipt: "stash-receipt.json",
    stashId: receipt.stashId,
    status: receipt.status,
    postSaveFailureCount: receipt.postSaveFailureCount,
    ...(receipt.excluded?.length ? { excluded: receipt.excluded } : {}),
    ...(receipt.secretsFound !== undefined
      ? { secretsFound: receipt.secretsFound }
      : {}),
    ...(receipt.metaDropped ? { metaDropped: true } : {}),
    ...(receipt.ttl ? { ttl: receipt.ttl } : {}),
    ...(receipt.expiresAt ? { expiresAt: receipt.expiresAt } : {}),
    ...(receipt.tags?.length ? { tags: receipt.tags } : {}),
  });
  await writer.writeManifest();
  return receipt;
}

/** Back-compat name for the auto-stash receipt writer. */
export async function writeAutoStashReceipt(
  runDir: string,
  result: StashDirectoryResult,
  now: () => Date = () => new Date(),
): Promise<StashReceipt> {
  return writeStashReceipt(runDir, result, "auto-stash", now);
}

/**
 * Record a stash that produced no durable copy: `artifact.stash` with
 * `status: "error"`, a reason code and a path-free one-line message.
 */
async function appendStashErrorEvent(
  runDir: string,
  action: "auto-stash" | "manual",
  result: RunStashResult,
): Promise<void> {
  // Never create a run directory just to report that it could not be read.
  const isDir = await stat(runDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isDir) return;
  const writer = new ArtifactWriter(runDir, stringOnlyRedactor());
  await writer.appendEvent({
    ts: new Date().toISOString(),
    type: "artifact.stash",
    action,
    status: "error",
    reason: result.reason ?? "unknown",
    ...(result.error ? { message: pathFreeMessage(result.error) } : {}),
    ...(result.excluded.length ? { excluded: result.excluded } : {}),
  });
}

/**
 * The stash receipt and its events carry schema-checked metadata whose field
 * NAMES the key-based redactor would misread (`secretsFound` is a count, not
 * a secret). Redact every string VALUE (registered secrets, credential
 * headers, token query params, URI userinfo) and keep the structure.
 */
function stringOnlyRedactor(): ArtifactRedactor {
  const base = createArtifactRedactor(undefined);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return base.text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, walk(child)]),
      );
    }
    return value;
  };
  return { text: base.text, value: <T>(input: T): T => walk(input) as T };
}

export { pathFreeMessage };

function isIsoTimestamp(value: string): boolean {
  return StashReceiptSchema.shape.recordedAt.safeParse(value).success;
}

/* ----- format helper (unused but keeps the import for type-safety) ----- */

export type { OutputFormat };
