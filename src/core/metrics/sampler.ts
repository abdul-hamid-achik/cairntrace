import type { MetricResult, MetricSample } from "../schema/metrics.v1";
import { displayTarget, runProbe, type ProbeEnvironment } from "./probes";
import type { MetricScope, NormalizedProbe } from "./schema";

/**
 * The samples of one scope (one spec run, or one iteration's specs): take
 * the `before` samples when the scope starts, tick the `every:` probes
 * while it runs, take the `after` samples when it ends, and fold all of it
 * into {@link MetricResult} rows with deltas.
 *
 * Nothing outlives {@link MetricsScope.stop} / {@link MetricsScope.dispose}:
 * the tick timer is cleared, an in-flight tick is aborted (its command's
 * process group is killed) and awaited. A probe never throws: a failed
 * sample is recorded and the run goes on.
 */

/** Samples kept per probe (more are counted, and `truncated` says so). */
export const MAX_SERIES_SAMPLES = 500;

export type SamplePhase = "before" | "after" | "tick";

export interface SampleNotice {
  name: string;
  scope: MetricScope;
  phase: SamplePhase;
  sample: MetricSample;
  iteration?: number;
}

export interface MetricsScopeOptions {
  probes: readonly NormalizedProbe[];
  scope: MetricScope;
  env: ProbeEnvironment;
  /** Invocation cancel: aborts the running sample and skips later ones. */
  signal?: AbortSignal;
  /** Called after each sample (journal events, narration). */
  onSample?: (notice: SampleNotice) => void;
  /** `--repeat` / `--matrix` iteration stamped on invocation-scope rows. */
  iteration?: number;
  /** Extra `CAIRN_*` values for command probes of this scope. */
  extraEnv?: Readonly<Record<string, string>>;
}

interface ProbeState {
  normalized: NormalizedProbe;
  before?: MetricSample;
  after?: MetricSample;
  /** `every:` — every sample in time order (start, ticks, end). */
  series: MetricSample[];
  failures: number;
  firstError?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class MetricsScope {
  private readonly states: ProbeState[];
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private started = false;
  private stopped = false;
  private extraEnv: Readonly<Record<string, string>>;

  constructor(private readonly opts: MetricsScopeOptions) {
    this.states = opts.probes.map((normalized) => ({
      normalized,
      series: [],
      failures: 0,
    }));
    this.extraEnv = opts.extraEnv ?? {};
  }

  get active(): boolean {
    return this.states.length > 0;
  }

  /** Take the `before` samples and start the `every:` ticks. */
  async start(extraEnv?: Readonly<Record<string, string>>): Promise<void> {
    if (this.started || this.stopped || !this.active) return;
    this.started = true;
    if (extraEnv) this.extraEnv = { ...this.extraEnv, ...extraEnv };
    await this.takePhase("before");
    for (const state of this.states) {
      if (state.normalized.everyMs !== undefined) this.schedule(state);
    }
  }

  /**
   * Stop ticking, take the `after` samples and return the rows. Safe to
   * call twice (the second call returns the same rows).
   */
  async stop(
    extraEnv?: Readonly<Record<string, string>>,
  ): Promise<MetricResult[]> {
    if (!this.stopped) {
      await this.halt();
      if (extraEnv) this.extraEnv = { ...this.extraEnv, ...extraEnv };
      if (this.started && !this.opts.signal?.aborted) {
        await this.takePhase("after");
      }
    }
    return this.results();
  }

  /** Stop without the `after` samples (an errored spec, a cancel). */
  async dispose(): Promise<void> {
    await this.halt();
  }

  /**
   * One sample per probe of the phase, taken concurrently and recorded in
   * config order (a stable journal).
   */
  private async takePhase(phase: "before" | "after"): Promise<void> {
    // `before` samples belong to the scope: dispose() (or stop()) aborts and
    // awaits them like ticks. `after` runs once the scope is halted.
    const stopSignal = phase === "before" ? this.controller.signal : undefined;
    const taken = await Promise.all(
      this.states
        .filter((state) => state.normalized.phases.includes(phase))
        .map((state) => {
          const pending = this.sample(state, stopSignal).then((sample) => ({
            state,
            sample,
          }));
          if (stopSignal) {
            this.inFlight.add(pending);
            void pending.finally(() => this.inFlight.delete(pending));
          }
          return pending;
        }),
    );
    for (const { state, sample } of taken) {
      if (sample) this.record(state, phase, sample);
    }
  }

  private async halt(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const state of this.states) {
      if (state.timer) clearTimeout(state.timer);
      delete state.timer;
    }
    this.controller.abort();
    await Promise.allSettled(this.inFlight);
  }

  /** One sample, undefined when the scope was stopped meanwhile. */
  private async sample(
    state: ProbeState,
    stopSignal: AbortSignal | undefined,
  ): Promise<MetricSample | undefined> {
    const signals = [this.opts.signal, stopSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    if (this.opts.signal?.aborted) return undefined;
    const startedAt = new Date();
    const outcome = await runProbe(state.normalized, this.opts.env, {
      extraEnv: this.extraEnv,
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
    });
    // A cancelled invocation (or an ended scope) measures nothing.
    if (this.opts.signal?.aborted || stopSignal?.aborted) return undefined;
    return {
      at: startedAt.toISOString(),
      ...(outcome.value !== undefined ? { value: outcome.value } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      durationMs: outcome.durationMs,
    };
  }

  private record(
    state: ProbeState,
    phase: SamplePhase,
    sample: MetricSample,
  ): void {
    if (phase === "before") state.before = sample;
    if (phase === "after") state.after = sample;
    if (state.normalized.everyMs !== undefined) state.series.push(sample);
    if (sample.error !== undefined) {
      state.failures += 1;
      state.firstError ??= sample.error;
    }
    try {
      this.opts.onSample?.({
        name: state.normalized.probe.name,
        scope: this.opts.scope,
        phase,
        sample,
        ...(this.opts.iteration !== undefined
          ? { iteration: this.opts.iteration }
          : {}),
      });
    } catch {
      // A narration failure never fails a probe.
    }
  }

  private schedule(state: ProbeState): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      delete state.timer;
      if (this.stopped) return;
      const tick = this.sample(state, this.controller.signal)
        .then((sample) => {
          // A tick the end of the scope aborted measures nothing.
          if (sample && !this.stopped) this.record(state, "tick", sample);
        })
        .finally(() => {
          this.inFlight.delete(tick);
          this.schedule(state);
        });
      this.inFlight.add(tick);
    }, state.normalized.everyMs);
    // A probe never keeps the process alive.
    timer.unref?.();
    state.timer = timer;
  }

  /** The rows, one per probe. */
  results(): MetricResult[] {
    return this.states.map((state) => this.rowOf(state));
  }

  private rowOf(state: ProbeState): MetricResult {
    const { normalized } = state;
    const { probe } = normalized;
    const every = normalized.everyMs !== undefined;
    const target =
      probe.command !== undefined
        ? this.opts.env.redact(probe.command)
        : probe.http
          ? displayTarget(probe.http.url)
          : undefined;
    const row: MetricResult = {
      name: probe.name,
      scope: this.opts.scope,
      source: probe.command !== undefined ? "command" : "http",
      mode: every ? "every" : "sample",
      ...(normalized.unit ? { unit: normalized.unit } : {}),
      ...(target ? { target } : {}),
      ...(state.before ? { before: state.before } : {}),
      ...(state.after ? { after: state.after } : {}),
      failures: state.failures,
      ...(state.firstError ? { error: state.firstError } : {}),
      ...(this.opts.iteration !== undefined
        ? { iteration: this.opts.iteration }
        : {}),
    };
    if (!every) {
      if (
        state.before?.value !== undefined &&
        state.after?.value !== undefined
      ) {
        row.delta = clean(state.after.value - state.before.value);
      }
      return row;
    }
    const values = state.series.flatMap((sample) =>
      sample.value === undefined ? [] : [sample.value],
    );
    const kept = state.series.slice(0, MAX_SERIES_SAMPLES);
    row.series = {
      count: state.series.length,
      samples: kept,
      ...(state.series.length > kept.length
        ? { truncated: true as const }
        : {}),
      ...(values.length > 0
        ? {
            min: Math.min(...values),
            max: Math.max(...values),
            mean: clean(values.reduce((a, b) => a + b, 0) / values.length),
            first: values[0]!,
            last: values[values.length - 1]!,
          }
        : {}),
    };
    if (values.length >= 2) {
      row.delta = clean(values[values.length - 1]! - values[0]!);
    }
    return row;
  }
}

/** No `-0`, no float dust from a subtraction. */
function clean(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}
