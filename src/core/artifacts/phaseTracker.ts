import type { RunEvent, RunPhase } from "../schema/events.v1";

/** Default cadence of `run.heartbeat` events while a run is active. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface PhaseTrackerOptions {
  /** Appends one event to an events.ndjson. Failures are swallowed. */
  append: (event: RunEvent) => Promise<unknown>;
  /** Heartbeat cadence; defaults to {@link HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
  /** PID stamped on heartbeats; defaults to this process. */
  pid?: number;
  /** Clock (epoch ms) for tests. */
  now?: () => number;
}

interface ActivePhase {
  phase: RunPhase;
  item?: string;
  budgetMs?: number;
  /** When the current phase OR item started (heartbeat elapsedMs base). */
  sinceMs: number;
}

/**
 * Tracks the current lifecycle phase of a run (or invocation) and keeps a
 * liveness signal in its event log:
 *
 *   - `enter()` writes `phase.changed {phase, item?, budgetMs?, deadline?}`;
 *   - `setItem()` moves to another item inside the same phase without an
 *     event (steps and outcomes already announce themselves);
 *   - while active, an unref'd timer writes `run.heartbeat` every 15s with
 *     the elapsed time in the current phase/item, so a long precondition poll
 *     or verifier is distinguishable from a dead process.
 *
 * `stop()` is idempotent and must run on every exit path; after it, nothing
 * is appended (the event log may already be sealed by the artifact
 * manifest).
 */
export class PhaseTracker {
  private readonly append: PhaseTrackerOptions["append"];
  private readonly intervalMs: number;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private active: ActivePhase | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(opts: PhaseTrackerOptions) {
    this.append = opts.append;
    this.intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /** The phase currently in progress, if any. */
  get phase(): RunPhase | undefined {
    return this.active?.phase;
  }

  /** Enter a phase (or a new budgeted item of it) and record it. */
  enter(
    phase: RunPhase,
    details: { item?: string; budgetMs?: number } = {},
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const sinceMs = this.now();
    this.active = {
      phase,
      ...(details.item !== undefined ? { item: details.item } : {}),
      ...(details.budgetMs !== undefined ? { budgetMs: details.budgetMs } : {}),
      sinceMs,
    };
    this.ensureTimer();
    return this.safeAppend({
      ts: new Date(sinceMs).toISOString(),
      type: "phase.changed",
      phase,
      ...(details.item !== undefined ? { item: details.item } : {}),
      ...(details.budgetMs !== undefined
        ? {
            budgetMs: details.budgetMs,
            deadline: new Date(sinceMs + details.budgetMs).toISOString(),
          }
        : {}),
    });
  }

  /** Switch the item inside the current phase without writing an event. */
  setItem(item: string | undefined, budgetMs?: number): void {
    if (this.stopped || !this.active) return;
    this.active = {
      phase: this.active.phase,
      ...(item !== undefined ? { item } : {}),
      ...(budgetMs !== undefined ? { budgetMs } : {}),
      sinceMs: this.now(),
    };
  }

  /** Write one heartbeat for the active phase now (the timer calls this). */
  beat(): Promise<void> {
    const active = this.active;
    if (this.stopped || !active) return Promise.resolve();
    const nowMs = this.now();
    return this.safeAppend({
      ts: new Date(nowMs).toISOString(),
      type: "run.heartbeat",
      phase: active.phase,
      ...(active.item !== undefined ? { item: active.item } : {}),
      elapsedMs: Math.max(0, nowMs - active.sinceMs),
      ...(active.budgetMs !== undefined ? { budgetMs: active.budgetMs } : {}),
      runElapsedMs: Math.max(0, nowMs - this.startedAtMs),
      pid: this.pid,
    });
  }

  /** Stop heartbeats and ignore later phase changes. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.beat();
    }, this.intervalMs);
    // A heartbeat must never keep the CLI alive after the run settles.
    this.timer.unref?.();
  }

  private async safeAppend(event: RunEvent): Promise<void> {
    try {
      await this.append(event);
    } catch {
      // Liveness signals are best-effort; they never fail the run.
    }
  }
}
