import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderJson } from "../core/artifacts/renderers/json";
import {
  AbortedBatchRunResultSchema,
  type AbortedBatchRunResult,
} from "../core/schema/runBatch.v1";
import type { RunResult } from "../core/schema/run.v1";

export interface AbortedBatchInput {
  signal: "SIGINT" | "SIGTERM";
  startedAt: string;
  parallel: number;
  requestedTotal: number;
  /** Fully-written per-spec results, already ordered by original input index. */
  completed: RunResult[];
}

export interface AbortedBatchWriteOptions {
  now?: () => Date;
  pid?: number;
}

export interface AbortedBatchWriteResult {
  path: string;
  summary: AbortedBatchRunResult;
}

/** Build and validate the strict signal-time partial batch summary. */
export function buildAbortedBatchSummary(
  input: AbortedBatchInput,
  abortedAt = new Date(),
): AbortedBatchRunResult {
  return AbortedBatchRunResultSchema.parse({
    $schema: "urn:cairntrace.dev:run-batch-aborted:v1",
    version: "1",
    aborted: true,
    signal: input.signal,
    startedAt: input.startedAt,
    abortedAt: abortedAt.toISOString(),
    parallel: input.parallel,
    requestedTotal: input.requestedTotal,
    pending: input.requestedTotal - input.completed.length,
    completed: input.completed,
  });
}

/**
 * Atomically persist a partial batch summary under artifactRoot. This function
 * is deliberately synchronous: signal-exit can terminate the process as soon
 * as the signal handler returns, before any promise continuation has a chance
 * to flush. Existing run directories are never touched.
 */
export function writeAbortedBatchSummary(
  artifactRoot: string,
  input: AbortedBatchInput,
  options: AbortedBatchWriteOptions = {},
): AbortedBatchWriteResult {
  const now = (options.now ?? (() => new Date()))();
  const pid = options.pid ?? process.pid;
  const root = resolve(artifactRoot);
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const filename = `aborted-${timestamp}-${pid}.json`;
  const target = join(root, filename);
  const temporary = join(root, `.${filename}.tmp`);
  const summary = buildAbortedBatchSummary(input, now);

  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(temporary, `${renderJson(summary)}\n`, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created. Preserve the root cause.
    }
    throw error;
  }

  return { path: target, summary };
}
