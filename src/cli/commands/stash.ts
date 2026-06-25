import { execa } from "execa";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";
import { emit, resolveFormat } from "../format";
import type { OutputFormat } from "../format";

/* ---------------------------------------------------------------------------
 * fcheap shell-out wrapper
 *
 * All fcheap commands support --json output. We parse stdout and return the
 * structured data. If fcheap isn't installed, we return a clear error.
 * ------------------------------------------------------------------------- */

interface FcheapResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runFcheap(
  args: string[],
  opts: { json?: boolean } = {},
): Promise<FcheapResult> {
  const fullArgs = opts.json ? [...args, "--json"] : args;
  try {
    const r = await execa("fcheap", fullArgs, {
      reject: false,
      timeout: 60_000,
    });
    return {
      ok: r.exitCode === 0,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      exitCode: r.exitCode ?? -1,
    };
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "ENOENT" || err.message?.includes("ENOENT")) {
      return {
        ok: false,
        stdout: "",
        stderr:
          "fcheap not found on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap",
        exitCode: -1,
      };
    }
    return {
      ok: false,
      stdout: "",
      stderr: err.message,
      exitCode: -1,
    };
  }
}

function parseJson<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Stash types
 * ------------------------------------------------------------------------- */

export interface StashSaveResult {
  stashId: string;
  path: string;
  tags: string[];
  tool: string;
  source?: string;
}

export interface StashListItem {
  id: string;
  name?: string;
  tool?: string;
  tags?: string[];
  createdAt?: string;
  sizeBytes?: number;
  fileCount?: number;
}

export interface StashInfo {
  id: string;
  name?: string;
  tool?: string;
  source?: string;
  tags?: string[];
  createdAt?: string;
  sizeBytes?: number;
  files?: Array<{ path: string; size?: number }>;
}

export interface StashSearchResult {
  stashId: string;
  snippet: string;
  score?: number;
  file?: string;
}

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
  const runId =
    runRef === "latest" || runRef === "previous"
      ? (runDir.split("/").pop() ?? runRef)
      : runRef;

  // Derive spec name from run.json if available for a default tag.
  const tags = opts.tag ?? [];
  const tool = opts.tool ?? "cairntrace";

  const args = [
    "save",
    runDir,
    "--tool",
    tool,
    ...tags.flatMap((t) => ["--tag", t]),
  ];
  if (opts.source) {
    args.push("--source", opts.source);
  }

  const r = await runFcheap(args, { json: true });

  if (!r.ok) {
    process.stderr.write(`cairn stash save: ${r.stderr || "fcheap failed"}\n`);
    process.exit(2);
  }

  const data = parseJson<StashSaveResult>(r.stdout);
  const result: StashSaveResult = {
    stashId: data?.stashId ?? data?.path ?? "(unknown)",
    path: runDir,
    tags,
    tool,
    ...(opts.source ? { source: opts.source } : {}),
  };

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

  const items = parseJson<StashListItem[]>(r.stdout) ?? [];
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
      const size = s.sizeBytes
        ? ` — ${(s.sizeBytes / 1024).toFixed(1)} KB`
        : "";
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

  const info = parseJson<StashInfo>(r.stdout) ?? {
    id: stashId,
  };

  process.stdout.write(emit(format, info, () => stashInfoMarkdown(info)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function stashInfoMarkdown(info: StashInfo): string {
  const lines = [
    `# Stash ${info.id}`,
    "",
    ...(info.name ? [`- name: ${info.name}`] : []),
    ...(info.tool ? [`- tool: ${info.tool}`] : []),
    ...(info.source ? [`- source: ${info.source}`] : []),
    ...(info.tags?.length ? [`- tags: ${info.tags.join(", ")}`] : []),
    ...(info.createdAt ? [`- created: ${info.createdAt}`] : []),
    ...(info.sizeBytes
      ? [`- size: ${(info.sizeBytes / 1024).toFixed(1)} KB`]
      : []),
  ];
  if (info.files?.length) {
    lines.push("", "## Files", "");
    for (const f of info.files) {
      lines.push(`- ${f.path}${f.size ? ` (${f.size} bytes)` : ""}`);
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

  if (!r.ok) {
    process.stderr.write(
      `cairn stash restore: ${r.stderr || "fcheap failed"}\n`,
    );
    process.exit(2);
  }

  const data = parseJson<{ path?: string; stashId?: string }>(r.stdout);
  const result = {
    stashId,
    restoredTo: data?.path ?? opts.to ?? "(unknown)",
  };

  process.stdout.write(
    emit(format, result, () => stashRestoreMarkdown(result)),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function stashRestoreMarkdown(r: {
  stashId: string;
  restoredTo: string;
}): string {
  return [
    `# Restored stash ${r.stashId}`,
    "",
    `- restoredTo: ${r.restoredTo}`,
  ].join("\n");
}

/* ----- search ----- */

export interface StashSearchOptions {
  mode?: string;
  limit?: number;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn stash search <query>` — search across all stashes.
 */
export async function stashSearchCommand(
  query: string,
  opts: StashSearchOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const args = ["search", query];
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.limit) args.push("--limit", String(opts.limit));

  const r = await runFcheap(args, { json: true });

  if (!r.ok) {
    process.stderr.write(
      `cairn stash search: ${r.stderr || "fcheap failed"}\n`,
    );
    process.exit(2);
  }

  const results = parseJson<StashSearchResult[]>(r.stdout) ?? [];
  const result = { query, results };

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
      const score = s.score ? ` (score: ${s.score.toFixed(2)})` : "";
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
export async function stashDirectory(
  dir: string,
  opts: {
    name?: string;
    tool?: string;
    tags?: string[];
    source?: string;
  } = {},
): Promise<{ ok: boolean; stashId?: string; error?: string }> {
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
  if (!r.ok) {
    return { ok: false, error: r.stderr || "fcheap failed" };
  }
  const data = parseJson<StashSaveResult>(r.stdout);
  return { ok: true, stashId: data?.stashId ?? data?.path };
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
): Promise<void> {
  const shouldStash =
    opts.stashOnFailure ||
    (opts.configStash?.enabled && opts.configStash.autoStash === "on-failure");

  if (!shouldStash) return;

  const tags = [specName, ...(opts.configStash?.tags ?? [])];

  const r = await runFcheap(
    [
      "save",
      runDir,
      "--tool",
      "cairntrace",
      ...tags.flatMap((t) => ["--tag", t]),
    ],
    { json: true },
  );

  if (r.ok) {
    const data = parseJson<StashSaveResult>(r.stdout);
    process.stderr.write(
      `cairn: auto-stashed run ${runId} → ${data?.stashId ?? "(unknown)"}\n`,
    );
  } else {
    process.stderr.write(`cairn: auto-stash failed (non-fatal): ${r.stderr}\n`);
  }
}

/* ----- fcheap availability check ----- */

export async function isFcheapAvailable(): Promise<boolean> {
  const r = await runFcheap(["--version"]);
  return r.ok;
}

/* ----- format helper (unused but keeps the import for type-safety) ----- */

export type { OutputFormat };
