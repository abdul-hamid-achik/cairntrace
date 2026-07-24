import { basename } from "node:path";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";
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
import { runFcheap } from "./fcheapClient.js";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter.js";
import { createArtifactRedactor } from "../../core/artifacts/redaction.js";
import {
  StashReceiptSchema,
  type StashReceipt,
} from "../../core/schema/stash.v1.js";

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
}

export type StashListItem = FcheapListItem;
export type StashInfo = FcheapInfo;
export type StashSearchResult = FcheapSearchResult;

/* ---------------------------------------------------------------------------
 * Stash commands
 * ------------------------------------------------------------------------- */

export interface StashSaveOptions {
  artifactRoot?: string;
  config?: string;
  tag?: string[];
  tool?: string;
  source?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn stash save <run-id>` — stash a run directory to fcheap.
 *
 * Wraps `fcheap save <runDir> --tool cairntrace --tag <spec-name> [--tag ...]
 * --source <spec-path> --json`.
 */
export async function stashSaveCommand(
  runRef: string,
  opts: StashSaveOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const root = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  const runDir = await resolveRunRef(runRef, root);
  const runId = basename(runDir);

  // Derive spec name from run.json if available for a default tag.
  const tags = opts.tag ?? [];
  const tool = opts.tool ?? "cairntrace";

  const saved = await stashDirectory(runDir, {
    tool,
    tags,
    ...(opts.source ? { source: opts.source } : {}),
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
  };

  if (saved.warning) {
    process.stderr.write(`cairn stash save: warning: ${saved.warning}\n`);
    process.exitCode = 2;
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
    ...(r.failures ?? []).map(
      (failure) => `- ${failure.stage} failed: ${failure.error}`,
    ),
  ].join("\n");
}

/* ----- list ----- */

export interface StashListOptions {
  tag?: string;
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
  if (opts.tag) args.push("--tag", opts.tag);
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

/* ----- reusable stash helper (used by services lifecycle) ----- */

/**
 * Stash a directory to the fcheap vault. Best-effort: returns a result
 * object instead of throwing. Used by the services lifecycle to persist
 * session artifacts (tmux captures, docker logs, seed output) after a run.
 */
export interface StashDirectoryResult {
  ok: boolean;
  stashId?: string;
  status?: "saved" | "saved_with_failures";
  failures?: Array<{ id: string; stage: string; error: string }>;
  warning?: string;
  error?: string;
}

export async function stashDirectory(
  dir: string,
  opts: {
    name?: string;
    tool?: string;
    tags?: string[];
    source?: string;
  } = {},
): Promise<StashDirectoryResult> {
  const tool = opts.tool ?? "cairntrace";
  const args = [
    "save",
    dir,
    "--tool",
    tool,
    ...(opts.name ? ["--name", opts.name] : []),
    ...(opts.tags ?? []).flatMap((t) => ["--tag", t]),
    ...(opts.source ? ["--source", opts.source] : []),
  ];
  const r = await runFcheap(args, { json: true });
  try {
    const receipt = parseFcheapSaveOutput(r.stdout);
    const receiptFields = {
      stashId: receipt.stashId,
      ...(receipt.status ? { status: receipt.status } : {}),
      ...(receipt.failed?.length ? { failures: receipt.failed } : {}),
    };
    if (!r.ok && receipt.status !== "saved_with_failures") {
      return {
        ok: false,
        ...receiptFields,
        error: r.stderr || "fcheap failed after emitting a save receipt",
      };
    }
    const warning =
      receipt.status === "saved_with_failures"
        ? r.stderr ||
          `stash saved with ${receipt.failed?.length ?? 0} failed post-save operation(s)`
        : undefined;
    return {
      ok: true,
      ...receiptFields,
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: !r.ok
        ? r.stderr || (error as Error).message
        : error instanceof FcheapContractError
          ? error.message
          : `Invalid fcheap save response: ${(error as Error).message}`,
    };
  }
}

/* ----- auto-stash (called from Runner/run.ts) ----- */

/**
 * Auto-stash a failed run to fcheap if config.stash.autoStash is "on-failure"
 * or --stash-on-failure was passed. Best-effort: failures are logged to stderr
 * but never crash the run.
 */
export async function maybeAutoStash(
  runDir: string,
  runId: string,
  specName: string,
  opts: {
    stashOnFailure?: boolean;
    configStash?: { enabled?: boolean; autoStash?: string; tags?: string[] };
  },
): Promise<StashDirectoryResult | undefined> {
  const shouldStash =
    opts.stashOnFailure ||
    (opts.configStash?.enabled && opts.configStash.autoStash === "on-failure");

  if (!shouldStash) return undefined;

  const tags = [specName, ...(opts.configStash?.tags ?? [])];
  const result = await stashDirectory(runDir, {
    tool: "cairntrace",
    tags,
  });
  if (!result.ok) {
    log
      .scope("stash")
      .warn(`auto-stash failed (non-fatal): ${result.error ?? "unknown"}`);
    return result;
  }
  if (result.warning) {
    log.scope("stash").warn(`auto-stash warning: ${result.warning}`);
  }
  try {
    await writeAutoStashReceipt(runDir, result);
  } catch (error) {
    log
      .scope("stash")
      .warn(
        `auto-stash receipt was not written (non-fatal): ${(error as Error).message}`,
      );
  }
  const logSafeStashId = result.stashId
    ? createArtifactRedactor(undefined).text(result.stashId)
    : undefined;
  log
    .scope("stash")
    .info(`auto-stashed run ${runId}`, { stashId: logSafeStashId });
  return result;
}

/**
 * Add the local post-save receipt without reopening or changing run.json,
 * reports, or any semantic result field. The file and event contain only the
 * safe stash identifier plus bounded status metadata. The manifest is rebuilt
 * so its checksummed inventory remains truthful after this append-only
 * enrichment.
 */
export async function writeAutoStashReceipt(
  runDir: string,
  result: StashDirectoryResult,
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
  });
  const redactor = createArtifactRedactor(undefined);
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
    action: "auto-stash",
    receipt: "stash-receipt.json",
    stashId: receipt.stashId,
    status: receipt.status,
    postSaveFailureCount: receipt.postSaveFailureCount,
  });
  await writer.writeManifest();
  return receipt;
}

/* ----- fcheap availability check ----- */

/* ----- format helper (unused but keeps the import for type-safety) ----- */

export type { OutputFormat };
