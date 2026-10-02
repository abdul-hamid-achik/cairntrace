import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { stepKind } from "../artifacts/stepLabel";
import type { RunEvent } from "../schema/events.v1";
import type { RunStep, Step } from "../schema/spec.v1";
import {
  executeRunStepSync,
  runStepLabel,
  type RunStepInvocation,
} from "./runStep";

/**
 * Spec `teardown:` (F3a). The async path runs after the outcomes (or after
 * an early stop: a failed precondition or gate, a cancel) and executes every
 * item, each bounded by what is left of the teardown budget. The signal path
 * runs the `run` items that have not started yet, synchronously, from the
 * SIGINT/SIGTERM handler — before the CLI's cleanup kills browsers and
 * services and exits.
 */

export type TeardownRunStatus = "passed" | "failed" | "errored";
type TeardownItemStatus = "passed" | "failed" | "skipped";

/** Teardown budget on the SIGINT/SIGTERM path (the process is exiting). */
const SIGNAL_TEARDOWN_BUDGET_MS = 30_000;

export interface TeardownItemResult {
  status: TeardownItemStatus;
  error?: string;
  timedOut?: boolean;
}

export interface TeardownSummary {
  ran: number;
  failed: Array<{ index: number; stepId: string; error: string }>;
}

function teardownStepId(step: Step, index: number): string {
  return step.id ?? `teardown_${index + 1}`;
}

function teardownKind(step: Step): string {
  return "run" in step ? "run" : stepKind(step);
}

function teardownLabel(step: Step): string | undefined {
  return "run" in step ? runStepLabel(step as RunStep) : undefined;
}

interface TeardownOptions {
  steps: readonly Step[];
  budgetMs: number;
  runStatus: TeardownRunStatus;
  /** Append an event (events.ndjson, redacted by the writer). */
  emit: (event: RunEvent) => Promise<void>;
  /** One narration line (run.log). */
  log: (line: string) => void;
  /** A teardown item failed (CLI/MCP narration). */
  warn: (message: string) => void;
  /** The tracker's item for phase.changed. */
  enter: (item: string, budgetMs: number) => Promise<void>;
  /** Execute one item within `remainingMs`. */
  execute: (
    step: Step,
    index: number,
    remainingMs: number,
  ) => Promise<TeardownItemResult>;
  /**
   * Claim the item at `index` before it starts; false when the signal path
   * already ran it (a host that survives SIGINT/SIGTERM, e.g. `cairn mcp`).
   * See {@link createTeardownClaims}.
   */
  claim?: (index: number) => boolean;
}

/**
 * Which path runs each teardown item: the async teardown or the
 * SIGINT/SIGTERM handler, whichever claims the index first. A host that
 * survives the signal (`cairn mcp`, an SDK host with its own listener)
 * keeps running the aborted run to its end, so both paths reach the same
 * items; the shared claims keep every item to one execution and one
 * teardown.started/finished pair.
 */
export function createTeardownClaims(): (index: number) => boolean {
  const claimed = new Set<number>();
  return (index) => {
    if (claimed.has(index)) return false;
    claimed.add(index);
    return true;
  };
}

export async function runTeardown(
  opts: TeardownOptions,
): Promise<TeardownSummary> {
  const summary: TeardownSummary = { ran: 0, failed: [] };
  const total = opts.steps.length;
  const deadline = Date.now() + opts.budgetMs;
  for (const [index, step] of opts.steps.entries()) {
    const stepId = teardownStepId(step, index);
    const kind = teardownKind(step);
    const label = teardownLabel(step);
    const remaining = deadline - Date.now();
    if (opts.claim && !opts.claim(index)) {
      // Its teardown.started/finished came from the signal path.
      opts.log(
        `teardown ${index + 1}/${total} ${stepId} (${kind}): already ran from the signal handler`,
      );
      continue;
    }
    await opts.enter(stepId, Math.max(0, remaining));
    await opts.emit({
      ts: new Date().toISOString(),
      type: "teardown.started",
      index: index + 1,
      total,
      kind,
      stepId,
      ...(label ? { label } : {}),
      runStatus: opts.runStatus,
    });
    const startedAt = Date.now();
    let result: TeardownItemResult;
    if (remaining <= 0) {
      result = {
        status: "skipped",
        error: `teardown budget of ${opts.budgetMs}ms exhausted`,
      };
    } else {
      try {
        result = await opts.execute(step, index, remaining);
      } catch (error) {
        result = { status: "failed", error: (error as Error).message };
      }
    }
    const durationMs = Date.now() - startedAt;
    await opts.emit({
      ts: new Date().toISOString(),
      type: "teardown.finished",
      index: index + 1,
      kind,
      stepId,
      status: result.status,
      durationMs,
      ...(result.error ? { error: result.error } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    });
    if (result.status !== "skipped") summary.ran += 1;
    opts.log(
      `teardown ${index + 1}/${total} ${stepId} (${kind}): ${result.status} in ${durationMs}ms${
        result.error ? ` — ${result.error}` : ""
      }`,
    );
    if (result.status === "failed") {
      const error = result.error ?? "failed";
      summary.failed.push({ index: index + 1, stepId, error });
      opts.warn(`teardown step '${stepId}' failed: ${error}`);
    }
  }
  return summary;
}

/* ----- SIGINT / SIGTERM ----- */

interface SignalTeardownOptions {
  steps: readonly Step[];
  budgetMs: number;
  runDir: string;
  /** Redact an event before it is written synchronously. */
  redact: (event: RunEvent) => unknown;
  /** Invocation of a `run` item for the signal path. */
  invocation: (
    step: RunStep,
    index: number,
    signal: "SIGINT" | "SIGTERM",
  ) => Omit<RunStepInvocation, "signal">;
  /**
   * Claim an item before running it; false when the async teardown already
   * started it. Shared with {@link runTeardown} (see createTeardownClaims).
   */
  claim: (index: number) => boolean;
}

/**
 * Arm the signal-path teardown for this run. Returns the disposer. The
 * handler is prepended so it runs before the CLI's cleanup (which kills the
 * browser and services, then exits); with no other listener left it
 * re-raises the signal so the default termination still happens.
 */
export function armSignalTeardown(opts: SignalTeardownOptions): () => void {
  const runItems = opts.steps
    .map((step, index) => ({ step, index }))
    .filter(
      (item): item is { step: RunStep; index: number } => "run" in item.step,
    );
  if (runItems.length === 0) return () => undefined;
  let fired = false;
  const handlers = new Map<"SIGINT" | "SIGTERM", () => void>();
  const dispose = (): void => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      dispose();
      if (!fired) {
        fired = true;
        runSignalTeardown(opts, runItems, signal);
      }
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler);
    process.prependListener(signal, handler);
  }
  return dispose;
}

function runSignalTeardown(
  opts: SignalTeardownOptions,
  items: Array<{ step: RunStep; index: number }>,
  signal: "SIGINT" | "SIGTERM",
): void {
  const deadline =
    Date.now() + Math.min(opts.budgetMs, SIGNAL_TEARDOWN_BUDGET_MS);
  const write = (event: RunEvent): void => {
    try {
      appendFileSync(
        join(opts.runDir, "events.ndjson"),
        `${JSON.stringify(opts.redact(event))}\n`,
      );
    } catch {
      // The process is exiting; evidence is best-effort here.
    }
  };
  for (const { step, index } of items) {
    if (!opts.claim(index)) continue;
    const stepId = teardownStepId(step, index);
    const remaining = deadline - Date.now();
    write({
      ts: new Date().toISOString(),
      type: "teardown.started",
      index: index + 1,
      total: opts.steps.length,
      kind: "run",
      stepId,
      label: runStepLabel(step),
      runStatus: "errored",
      signal,
    });
    if (remaining <= 0) {
      write({
        ts: new Date().toISOString(),
        type: "teardown.finished",
        index: index + 1,
        kind: "run",
        stepId,
        status: "skipped",
        durationMs: 0,
        error: "signal teardown budget exhausted",
      });
      continue;
    }
    const result = executeRunStepSync({
      ...opts.invocation(step, index, signal),
      maxTimeoutMs: remaining,
    });
    write({
      ts: new Date().toISOString(),
      type: "teardown.finished",
      index: index + 1,
      kind: "run",
      stepId,
      status: result.ok ? "passed" : "failed",
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    });
  }
}
