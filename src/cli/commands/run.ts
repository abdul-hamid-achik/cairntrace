import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute as isAbsolutePath,
  resolve,
} from "node:path";
import { addEnospcHint } from "../../core/artifacts/retention";
import { renderJUnit } from "../../core/artifacts/renderers/junit";
import { renderRunMarkdown } from "../../core/artifacts/renderers/markdown";
import { runPool } from "../../core/runner/pool";
import { runSpec } from "../../core/runner/Runner";
import type { RunResult } from "../../core/schema/run.v1";
import type { ExitCode } from "../../core/schema/shared";
import { type BackendChoice, createBackend } from "../backendFactory";
import { trackBackend } from "../cleanup";
import { emit, resolveFormat } from "../format";
import { isInteractive, makeInteractiveListener } from "../progress";
import { stampSpecContractHash } from "./spec/verify";

export interface RunCommandOptions {
  env?: string;
  coldStart?: boolean;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  artifactRoot?: string;
  config?: string;
  parallel?: string;
  /** Repeatable `--var key=value` overrides; win over config env vars. */
  var?: string[];
  /** Write a JUnit XML report to this file. */
  junit?: string;
  /** Stamp contract hashes only when the entire run invocation passes. */
  stampIfGreen?: boolean;
  /** Commander sets this to false when `--no-color` is passed. */
  color?: boolean;
}

/**
 * Parse repeatable `--var key=value` flags into a vars bag.
 * Values may contain `=` (split happens on the first one).
 */
export function parseVarFlags(
  pairs: string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--var expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * `cairn run <spec...> [--parallel N]`
 *
 * - Single spec, parallel=1 → rich interactive progress, RunResult output
 *   (back-compat with v0.0 — existing JSON consumers still get RunResult).
 * - Multiple specs OR parallel>1 → BatchRunResult, per-spec one-liners only.
 */
export async function runCommand(
  specs: string[],
  opts: RunCommandOptions,
): Promise<void> {
  const parallel = Math.max(1, Number(opts.parallel ?? "1"));
  let expandedSpecs: string[];

  try {
    expandedSpecs = await expandSpecArgs(specs);
  } catch (e) {
    process.stderr.write(`cairn run: ${(e as Error).message}\n`);
    process.exit(2);
  }

  if (expandedSpecs.length === 0) {
    process.stderr.write("cairn run: at least one spec path is required\n");
    process.exit(2);
  }

  try {
    parseVarFlags(opts.var);
  } catch (e) {
    process.stderr.write(`cairn run: ${(e as Error).message}\n`);
    process.exit(2);
  }

  if (expandedSpecs.length === 1 && parallel === 1) {
    await runSingle(expandedSpecs[0]!, opts);
    return;
  }

  await runBatch(expandedSpecs, parallel, opts);
}

/* ----- single-spec path (preserves v0.0 behavior) ----- */

async function runSingle(
  specPath: string,
  opts: RunCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const backend = createBackend(backendOpts(opts));
  const untrack = trackBackend(backend);
  const interactive = format === "md" && isInteractive();
  const listener = interactive
    ? makeInteractiveListener({ color: colorEnabled(opts) })
    : undefined;

  let exitCode: ExitCode = 2;
  try {
    const vars = parseVarFlags(opts.var);
    const result = await runSpec({
      specPath,
      backend,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(listener ? { listener } : {}),
    });
    exitCode = result.exitCode;
    if (!(await stampIfGreen(opts, [result]))) {
      exitCode = 2;
      return;
    }
    if (!(await writeJUnitIfRequested(opts, [result]))) {
      exitCode = 2;
      return;
    }

    if (!interactive) {
      process.stdout.write(emit(format, result, renderRunMarkdown));
      if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    }
  } catch (e) {
    const result = synthesizeErroredResult(specPath, e as Error);
    exitCode = result.exitCode;
    if (!(await writeJUnitIfRequested(opts, [result]))) {
      exitCode = 2;
      return;
    }
    emitErroredResult(result, format);
  } finally {
    untrack();
    await backend.close().catch(() => undefined);
  }
  process.exit(exitCode);
}

/* ----- multi-spec path ----- */

// BatchRunResult is the v1 wire schema in src/core/schema/runBatch.v1.ts.
// Re-export for convenience so callers don't need to know the file path.
export type { BatchRunResult } from "../../core/schema/runBatch.v1";
import type { BatchRunResult } from "../../core/schema/runBatch.v1";

async function runBatch(
  specs: string[],
  parallel: number,
  opts: RunCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const interactive = format === "md" && isInteractive();
  const tStart = Date.now();

  if (interactive) {
    process.stdout.write(
      `\x1b[1mRunning\x1b[0m ${specs.length} spec${
        specs.length === 1 ? "" : "s"
      } (parallel: ${parallel})\n\n`,
    );
  }

  // Each worker gets its own session id so parallel runs don't share an
  // agent-browser session (which would cross-contaminate cookies, storage,
  // and network logs across specs). Playwright/Mock ignore the field but
  // it's harmless for them.
  const sessionRoot = `cairntrace-${process.pid}`;
  const results = await runPool(specs, parallel, async (specPath, idx) => {
    const backend = createBackend({
      ...backendOpts(opts),
      session: `${sessionRoot}-w${idx}`,
    });
    const untrack = trackBackend(backend);
    try {
      const vars = parseVarFlags(opts.var);
      const r = await runSpec({
        specPath,
        backend,
        ...(opts.artifactRoot !== undefined
          ? { artifactRoot: opts.artifactRoot }
          : {}),
        ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
        ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(Object.keys(vars).length > 0 ? { vars } : {}),
      });
      if (interactive) {
        const mark =
          r.status === "passed"
            ? "\x1b[32m✓\x1b[0m"
            : r.status === "failed"
              ? "\x1b[31m✗\x1b[0m"
              : "\x1b[33m·\x1b[0m";
        process.stdout.write(
          `  ${mark} [${idx + 1}/${specs.length}] ${r.spec.name} (${formatMs(r.durationMs)}, ${
            r.outcomes.filter((o) => o.status === "passed").length
          }/${r.outcomes.length} outcomes)\n`,
        );
      }
      return r;
    } catch (e) {
      // Synthesize an errored RunResult so the batch survives.
      const err = e as Error;
      if (interactive) {
        process.stdout.write(
          `  \x1b[33m·\x1b[0m [${idx + 1}/${specs.length}] ${specPath}: ${err.message}\n`,
        );
      }
      return synthesizeErroredResult(specPath, err);
    } finally {
      untrack();
      await backend.close().catch(() => undefined);
    }
  });

  const totalDurationMs = Date.now() - tStart;
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    errored: results.filter((r) => r.status === "errored").length,
  };
  const exitCode: ExitCode =
    summary.failed > 0 ? 1 : summary.errored > 0 ? 2 : 0;

  const batch: BatchRunResult = {
    $schema: "urn:cairntrace.dev:run-batch:v1",
    version: "1",
    parallel,
    totalDurationMs,
    summary,
    results,
    exitCode,
  };

  if (!(await stampIfGreen(opts, results))) {
    process.exit(2);
  }
  if (!(await writeJUnitIfRequested(opts, results))) {
    process.exit(2);
  }

  if (format === "json" || format === "yaml") {
    process.stdout.write(emit(format, batch, () => ""));
  } else {
    process.stdout.write(renderBatchMarkdown(batch));
    process.stdout.write("\n");
  }

  process.exit(exitCode);
}

/* ----- helpers ----- */

function backendOpts(
  opts: RunCommandOptions,
): Parameters<typeof createBackend>[0] {
  return {
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
  };
}

function colorEnabled(opts: RunCommandOptions): boolean {
  return (
    opts.color !== false && !process.env.NO_COLOR && process.env.TERM !== "dumb"
  );
}

function emitErroredResult(result: RunResult, format: string): void {
  // Errored runs go through the same synthesizeErroredResult path as
  // mid-run failures so consumers see a schema-valid RunResult either way.
  if (format === "json" || format === "yaml") {
    process.stdout.write(emit(format, result, renderRunMarkdown));
  } else {
    const failed = result.steps.find((s) => s.status === "failed");
    process.stderr.write(`cairn run: ${failed?.error ?? "run errored"}\n`);
  }
}

export async function expandSpecArgs(
  args: string[],
  cwd = process.cwd(),
): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    const abs = isAbsolutePath(arg) ? arg : resolve(cwd, arg);
    const s = await stat(abs).catch(() => undefined);
    if (!s) {
      out.push(arg);
      continue;
    }
    if (!s.isDirectory()) {
      out.push(arg);
      continue;
    }
    out.push(...(await collectSpecFiles(abs)));
  }
  return out;
}

async function collectSpecFiles(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).toSorted(
    (a, b) => a.name.localeCompare(b.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "actions") continue;
      out.push(...(await collectSpecFiles(path)));
      continue;
    }
    if (
      entry.isFile() &&
      /\.ya?ml$/i.test(entry.name) &&
      !basename(entry.name).startsWith("_")
    ) {
      out.push(path);
    }
  }
  return out;
}

async function writeJUnitIfRequested(
  opts: RunCommandOptions,
  results: RunResult[],
): Promise<boolean> {
  if (!opts.junit) return true;
  const outPath = isAbsolutePath(opts.junit)
    ? opts.junit
    : resolve(process.cwd(), opts.junit);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, renderJUnit(results));
    return true;
  } catch (e) {
    process.stderr.write(
      `cairn run: could not write JUnit report: ${(e as Error).message}\n`,
    );
    return false;
  }
}

async function stampIfGreen(
  opts: RunCommandOptions,
  results: RunResult[],
): Promise<boolean> {
  if (!opts.stampIfGreen) return true;
  if (results.some((r) => r.status !== "passed")) return true;
  try {
    const paths = new Set(results.map((r) => r.spec.path));
    for (const specPath of paths) await stampSpecContractHash(specPath);
    return true;
  } catch (e) {
    process.stderr.write(
      `cairn run: could not stamp contract hash: ${(e as Error).message}\n`,
    );
    return false;
  }
}

export function synthesizeErroredResult(
  specPath: string,
  err: Error,
): RunResult {
  const now = new Date().toISOString();
  const runId = `errored_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const absoluteSpecPath = isAbsolutePath(specPath)
    ? specPath
    : `${process.cwd()}/${specPath}`;
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    // runDir is the absolute anchor for all relative artifact paths in
    // RunResult; use a synthetic dir under the artifact root so consumers
    // joining paths don't crash. The dir itself is never written.
    runDir: `${process.cwd()}/.cairntrace/errored/${runId}`,
    spec: {
      name:
        specPath
          .split("/")
          .pop()
          ?.replace(/\.ya?ml$/, "") ?? "errored",
      path: absoluteSpecPath,
    },
    environment: "local",
    backend: "agent-browser",
    coldStart: false,
    status: "errored",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    outcomes: [],
    steps: [
      {
        id: "parse",
        status: "failed",
        durationMs: 0,
        error: addEnospcHint(err.message),
      },
    ],
    artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
    exitCode: 2,
  };
}

function renderBatchMarkdown(b: BatchRunResult): string {
  const bannerColor =
    b.exitCode === 0 ? "\x1b[32m" : b.exitCode === 1 ? "\x1b[31m" : "\x1b[33m";
  const lines: string[] = [
    "",
    `${bannerColor}\x1b[1m${b.summary.passed}/${b.summary.total} passed\x1b[0m  ${b.summary.failed} failed  ${b.summary.errored} errored  in ${formatMs(b.totalDurationMs)}`,
    "",
  ];
  const failed = b.results.filter((r) => r.status !== "passed");
  if (failed.length > 0) {
    lines.push("Failing specs:");
    for (const r of failed) {
      lines.push(
        `  - ${r.spec.name} → ${r.runDir}/${r.artifacts.agentContext}`,
      );
    }
  }
  return lines.join("\n");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}
