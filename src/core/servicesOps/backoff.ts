import { durationMs } from "../gates/schema";
import type { Backoff } from "./schema";

/** Delay before the n-th consecutive restart (1-based). */
export interface BackoffPlan {
  initialMs: number;
  maxMs: number;
  factor: number;
}

const DEFAULT_INITIAL_MS = 1_000;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_FACTOR = 2;

export function resolveBackoff(backoff: Backoff | undefined): BackoffPlan {
  if (backoff === undefined) {
    return {
      initialMs: DEFAULT_INITIAL_MS,
      maxMs: DEFAULT_MAX_MS,
      factor: DEFAULT_FACTOR,
    };
  }
  if (typeof backoff === "number" || typeof backoff === "string") {
    const fixed = durationMs(backoff) ?? DEFAULT_INITIAL_MS;
    return { initialMs: fixed, maxMs: fixed, factor: 1 };
  }
  const initialMs = durationMs(backoff.initial) ?? DEFAULT_INITIAL_MS;
  return {
    initialMs,
    maxMs: Math.max(initialMs, durationMs(backoff.max) ?? DEFAULT_MAX_MS),
    factor: backoff.factor ?? DEFAULT_FACTOR,
  };
}

export function backoffDelayMs(plan: BackoffPlan, attempt: number): number {
  const raw = plan.initialMs * plan.factor ** Math.max(0, attempt - 1);
  return Math.min(plan.maxMs, Math.round(raw));
}
