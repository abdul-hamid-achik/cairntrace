import { execa } from "execa";
import { existsSync, writeFileSync } from "node:fs";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";
import { emit, resolveFormat } from "../format";
import { maybeAutoStash, isFcheapAvailable } from "./stash";
import { join, resolve } from "node:path";

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export interface CodeMatch {
  file: string;
  line: number;
  score: number;
  snippet?: string;
}

export interface InvestigateResult {
  runId: string;
  runDir: string;
  stashId?: string;
  codeMatches: CodeMatch[];
  query?: string;
  mode?: string;
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
    } else {
      result.error = `fcheap connect failed: ${connectR.stderr}`;
      process.stderr.write(`cairn investigate: ${result.error}\n`);
    }
  } else if (opts.connect && !opts.codebase) {
    result.error =
      "--connect requires --codebase <dir> (or set investigate.codebaseDir in config)";
    process.stderr.write(`cairn investigate: ${result.error}\n`);
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
