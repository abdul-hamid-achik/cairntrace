import type { Poll } from "../../schema/verifier.v1";
import type { PollAttemptRecord, VerifierEvaluation } from "./types";

/**
 * The `poll` modifier, shared by every verifier: re-evaluate every `everyMs`
 * until green or `timeoutMs`; with `stableMs`, green must HOLD for that
 * window (≥2 green samples spanning it; a red sample restarts it). Errors
 * thrown by an attempt are red samples, never crashes. Without `poll` the
 * attempt runs exactly once.
 */

export interface AttemptInfo {
  /** 1-based attempt number. */
  attempt: number;
  /** Epoch ms the attempt's I/O must finish by. */
  deadline: number;
}

export type Attempt = (info: AttemptInfo) => Promise<VerifierEvaluation>;

export interface PollRunOptions {
  /** Step the run stopped at; with failFastOnStepFailure, poll does not wait. */
  failedStep?: string;
  signal?: AbortSignal;
  /** Live narration while polling (`outcome.progress`). */
  onProgress?: (message: string) => void;
  /** Budget of the single attempt when there is no poll (default 30000ms). */
  singleAttemptBudgetMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PolledEvaluation extends VerifierEvaluation {
  /** Bounded attempt log (first 5 + last 15) when polled. */
  attemptLog?: PollAttemptRecord[];
}

const DEFAULT_EVERY_MS = 1000;
const DEFAULT_SINGLE_BUDGET_MS = 30_000;
const LOG_HEAD = 5;
const LOG_TAIL = 15;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * An attempt error that waiting cannot fix (unknown datasource, guard
 * refusal, unresolved reference): polling stops at once.
 */
function isPermanent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { permanent?: unknown }).permanent === true
  );
}

async function safeAttempt(
  attempt: Attempt,
  info: AttemptInfo,
): Promise<VerifierEvaluation & { permanent?: boolean }> {
  try {
    return await attempt(info);
  } catch (error) {
    return {
      passed: false,
      expected: "the verifier to evaluate",
      actual: `error: ${(error as Error).message}`,
      ...(isPermanent(error) ? { permanent: true } : {}),
    };
  }
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function runPolled(
  attempt: Attempt,
  poll: Poll | undefined,
  opts: PollRunOptions = {},
): Promise<PolledEvaluation> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  if (!poll) {
    const { permanent: _permanent, ...single } = await safeAttempt(attempt, {
      attempt: 1,
      deadline:
        now() + (opts.singleAttemptBudgetMs ?? DEFAULT_SINGLE_BUDGET_MS),
    });
    return single;
  }

  const startedAt = now();
  const deadline = startedAt + poll.timeoutMs;
  const everyMs = poll.everyMs ?? DEFAULT_EVERY_MS;
  const stableMs = poll.stableMs ?? 0;
  const failFast =
    (poll.failFastOnStepFailure ?? true) && opts.failedStep !== undefined;
  const estimate = Math.max(1, Math.ceil(poll.timeoutMs / everyMs));
  const head: PollAttemptRecord[] = [];
  const tailLog: PollAttemptRecord[] = [];
  let total = 0;
  const record = (ev: VerifierEvaluation): void => {
    const entry = {
      at: new Date(now()).toISOString(),
      ok: ev.passed,
      summary: oneLine(ev.actual),
    };
    if (head.length < LOG_HEAD) head.push(entry);
    else {
      tailLog.push(entry);
      if (tailLog.length > LOG_TAIL) tailLog.shift();
    }
  };
  const finish = (ev: VerifierEvaluation, note?: string): PolledEvaluation => ({
    ...ev,
    ...(note ? { actual: `${ev.actual} — ${note}` } : {}),
    attempts: total,
    polledMs: Math.max(0, now() - startedAt),
    attemptLog: [...head, ...tailLog],
  });

  let greenSince: number | undefined;
  let greenSamples = 0;
  let last: VerifierEvaluation | undefined;
  for (;;) {
    total++;
    // A stability window may need its last sample right at the deadline:
    // give each attempt at least a second of I/O budget.
    const { permanent, ...ev } = await safeAttempt(attempt, {
      attempt: total,
      deadline: Math.max(deadline, now() + 1000),
    });
    last = ev;
    record(ev);
    const observedAt = now();
    if (permanent) return finish(ev, "not retried: waiting cannot fix this");

    if (failFast) {
      const note = `step "${opts.failedStep}" failed; evaluated once without polling`;
      if (!ev.passed || stableMs === 0) return finish(ev, note);
      return finish(
        {
          ...ev,
          passed: false,
          skipped: true,
          actual: `blocked: green once, but the ${stableMs}ms stability window was not observed`,
        },
        note,
      );
    }

    if (ev.passed) {
      greenSamples++;
      greenSince ??= observedAt;
      const held = observedAt - greenSince;
      if (stableMs === 0) return finish(ev);
      if (held >= stableMs && greenSamples >= 2) {
        return finish(
          ev,
          `held for ${held}ms over ${greenSamples} samples (stableMs ${stableMs})`,
        );
      }
    } else {
      greenSince = undefined;
      greenSamples = 0;
    }

    if (opts.signal?.aborted) return finish(ev, "cancelled");
    const remaining = deadline - now();
    if (remaining <= 0) break;

    if (greenSince !== undefined) {
      opts.onProgress?.(
        `attempt ${total}/~${estimate}: green, holding ${now() - greenSince}/${stableMs}ms`,
      );
    } else {
      opts.onProgress?.(
        `attempt ${total}/~${estimate}: ${oneLine(ev.actual, 120)} (want ${oneLine(ev.expected, 120)})`,
      );
    }
    const untilStable =
      greenSince !== undefined
        ? Math.max(50, greenSince + stableMs - now())
        : everyMs;
    await sleep(Math.min(everyMs, untilStable, remaining), opts.signal);
  }

  if (greenSince !== undefined && last?.passed) {
    const held = now() - greenSince;
    return finish({
      ...last,
      passed: false,
      expected: `${last.expected}, holding for ${stableMs}ms`,
      actual: `green for only ${held}ms of the required ${stableMs}ms before the ${poll.timeoutMs}ms deadline`,
    });
  }
  return finish(last!, `after ${total} attempt(s) over ${poll.timeoutMs}ms`);
}

/**
 * Merge the poll log into an evaluation's raw evidence: object evidence gains
 * `attempts` / `polledMs`; anything else is wrapped.
 */
export function withPollEvidence(
  ev: PolledEvaluation,
  kind: string,
): VerifierEvaluation {
  const { attemptLog, ...rest } = ev;
  if (attemptLog === undefined) return rest;
  const pollFields = {
    attempts: attemptLog,
    ...(ev.polledMs !== undefined ? { polledMs: ev.polledMs } : {}),
  };
  const raw =
    rest.raw !== null &&
    typeof rest.raw === "object" &&
    !Array.isArray(rest.raw)
      ? { ...(rest.raw as Record<string, unknown>), ...pollFields }
      : rest.raw === undefined
        ? { kind, ...pollFields }
        : { kind, evidence: rest.raw, ...pollFields };
  return { ...rest, raw };
}
