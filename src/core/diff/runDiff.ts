import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ConsoleErrorEntry as ConsoleError,
  NetworkFailureEntry as NetworkFailure,
  OutcomeFlip,
  RunDiff,
  StepFlip,
  StepSlowdown,
} from "../schema/diff.v1";
import type { RunResult } from "../schema/run.v1";

/**
 * Structural diff between two Cairntrace runs. Designed for triage when a
 * spec starts failing in CI: load both runs, point at what changed.
 *
 * Inputs are run *directories* (containing run.json, console/, network/).
 * Either argument can be passed to the CLI as a run id or absolute path.
 *
 * The output shape is the v1 wire schema in `src/core/schema/diff.v1.ts`.
 */
export type {
  ConsoleErrorEntry as ConsoleError,
  NetworkFailureEntry as NetworkFailure,
  OutcomeFlip,
  RunDiff,
  RunDiffRef as RunRef,
  StepFlip,
  StepSlowdown,
} from "../schema/diff.v1";

export interface DiffOptions {
  /**
   * A step is flagged as a slowdown if its B duration is at least this factor
   * times the A duration (e.g., 1.5 = 50% slower) AND the absolute delta is
   * at least `slowdownMinDeltaMs`. Defaults: 1.5× / 100ms.
   */
  slowdownFactor?: number;
  slowdownMinDeltaMs?: number;
}

export async function diffRuns(
  runDirA: string,
  runDirB: string,
  opts: DiffOptions = {},
): Promise<RunDiff> {
  const slowdownFactor = opts.slowdownFactor ?? 1.5;
  const slowdownMinDelta = opts.slowdownMinDeltaMs ?? 100;

  const [a, b] = await Promise.all([loadRun(runDirA), loadRun(runDirB)]);

  /* ----- outcomes ----- */
  const outcomesByA = new Map(a.run.outcomes.map((o) => [o.id, o.status]));
  const outcomesByB = new Map(b.run.outcomes.map((o) => [o.id, o.status]));
  const flippedOutcomes: OutcomeFlip[] = [];
  const addedInB: string[] = [];
  const removedInB: string[] = [];
  for (const [id, statusB] of outcomesByB) {
    const statusA = outcomesByA.get(id);
    if (statusA === undefined) addedInB.push(id);
    else if (statusA !== statusB)
      flippedOutcomes.push({ id, from: statusA, to: statusB });
  }
  for (const id of outcomesByA.keys()) {
    if (!outcomesByB.has(id)) removedInB.push(id);
  }

  /* ----- steps ----- */
  const stepsByA = new Map(a.run.steps.map((s) => [s.id, s]));
  const stepsByB = new Map(b.run.steps.map((s) => [s.id, s]));
  const flippedSteps: StepFlip[] = [];
  const slowdowns: StepSlowdown[] = [];
  for (const [id, stepB] of stepsByB) {
    const stepA = stepsByA.get(id);
    if (!stepA) continue; // new step, skip — not a regression signal
    if (stepA.status !== stepB.status) {
      flippedSteps.push({ id, from: stepA.status, to: stepB.status });
    }
    if (
      stepA.durationMs > 0 &&
      stepB.durationMs >= stepA.durationMs * slowdownFactor &&
      stepB.durationMs - stepA.durationMs >= slowdownMinDelta
    ) {
      slowdowns.push({
        id,
        fromMs: stepA.durationMs,
        toMs: stepB.durationMs,
        factor: Number((stepB.durationMs / stepA.durationMs).toFixed(2)),
        deltaMs: stepB.durationMs - stepA.durationMs,
      });
    }
  }

  /* ----- console errors ----- */
  const errorsA = await loadConsoleErrors(a.runDir);
  const errorsB = await loadConsoleErrors(b.runDir);
  const errorTextsA = new Set(errorsA.map((e) => e.text));
  const newErrors = errorsB.filter((e) => !errorTextsA.has(e.text));

  /* ----- network failures ----- */
  const failuresA = await loadFailedRequests(a.runDir);
  const failuresB = await loadFailedRequests(b.runDir);
  const failureKeysA = new Set(failuresA.map(keyOf));
  const newFailures = failuresB.filter((f) => !failureKeysA.has(keyOf(f)));

  return {
    $schema: "https://cairntrace.dev/schemas/diff.v1.json",
    version: "1",
    a: {
      id: a.run.runId,
      runDir: a.runDir,
      status: a.run.status,
      durationMs: a.run.durationMs,
    },
    b: {
      id: b.run.runId,
      runDir: b.runDir,
      status: b.run.status,
      durationMs: b.run.durationMs,
    },
    overall: {
      statusChanged: a.run.status !== b.run.status,
      durationDeltaMs: b.run.durationMs - a.run.durationMs,
    },
    outcomes: { flipped: flippedOutcomes, addedInB, removedInB },
    steps: { flipped: flippedSteps, slowdowns },
    console: {
      errorCountDelta: errorsB.length - errorsA.length,
      newErrors,
    },
    network: {
      failureCountDelta: failuresB.length - failuresA.length,
      newFailures,
    },
  };
}

/* ----- helpers ----- */

interface LoadedRun {
  run: RunResult;
  runDir: string;
}

async function loadRun(runDir: string): Promise<LoadedRun> {
  const text = await readFile(join(runDir, "run.json"), "utf8");
  const run = JSON.parse(text) as RunResult;
  return { run, runDir };
}

async function loadConsoleErrors(runDir: string): Promise<ConsoleError[]> {
  return loadNdjson<ConsoleError>(join(runDir, "console", "errors.ndjson"));
}

async function loadFailedRequests(runDir: string): Promise<NetworkFailure[]> {
  return loadNdjson<NetworkFailure>(
    join(runDir, "network", "failed_requests.ndjson"),
  );
}

async function loadNdjson<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function keyOf(f: NetworkFailure): string {
  return `${f.method} ${f.url} ${f.status ?? "?"}`;
}
