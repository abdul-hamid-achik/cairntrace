import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import type { ArtifactRedactor } from "../../core/artifacts/ArtifactWriter";
import {
  mergeReportMetrics,
  writeMetricsFile,
} from "../../core/metrics/artifacts";
import type { ProbeEnvironment } from "../../core/metrics/probes";
import { MetricsScope, type SampleNotice } from "../../core/metrics/sampler";
import {
  normalizeProbe,
  type MetricScope,
  type NormalizedProbe,
} from "../../core/metrics/schema";
import {
  cairnContextEnv,
  targetChildEnvWithSelectedTvaultKeys,
} from "../../core/processEnv";
import type { MetricResult } from "../../core/schema/metrics.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import type { ScopedSecrets } from "../commands/secrets";
import { absoluteSpecPath, resolveRunRuntime } from "./options";

/**
 * The run engine's side of config `metrics:` (F11): resolve the effective
 * probes of the invocation, and sample them around each spec (`scope: spec`)
 * or around each iteration's specs (`scope: invocation`) into
 * `<runDir>/diagnostics/metrics.json`, `diagnostics/report.json` (flat
 * numerics for `cairn stats --metric`) and the invocation journal.
 *
 * A probe never fails a run: every sample is bounded, failures are recorded,
 * and a sampler is always stopped (no timer or child process outlives it).
 */

export interface ResolvedRunMetrics {
  probes: NormalizedProbe[];
  vars: Record<string, unknown>;
  configDir: string;
  envName: string;
}

/**
 * The effective probes of the invocation (first spec that runs), or
 * undefined when the config declares none. Never throws: an unreadable
 * config already failed earlier, in the environment preflight.
 */
export async function resolveRunMetrics(
  firstSpec: string,
  opts: Pick<RunInvocationOptions, "env" | "config" | "var">,
  scopedSecrets: ScopedSecrets,
  cwd: string,
): Promise<ResolvedRunMetrics | undefined> {
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  const ctx = await resolveRunRuntime(firstSpecAbs, opts, {
    env: scopedSecrets.env,
  }).catch(() => undefined);
  if (!ctx?.metrics?.length) return undefined;
  return {
    probes: ctx.metrics.map(normalizeProbe),
    vars: ctx.vars,
    configDir: ctx.configPath ? dirname(ctx.configPath) : dirname(firstSpecAbs),
    envName: ctx.envName,
  };
}

export interface EngineMetricsOptions {
  resolved: ResolvedRunMetrics;
  invocationId: string;
  journal: InvocationJournal | undefined;
  redactor: ArtifactRedactor;
  note: (kind: "info" | "warn", message: string) => void;
  /** Graceful cancel of the invocation. */
  signal: AbortSignal;
  /** Non-secret context for command probes (`CAIRN_ENV`, `CAIRN_BASE_URL`, …). */
  context: Record<string, string>;
}

export class EngineMetrics {
  private readonly specProbes: NormalizedProbe[];
  private readonly invocationProbes: NormalizedProbe[];
  private readonly warned = new Set<string>();
  /** Samplers not yet stopped (disposed with the invocation). */
  private readonly live = new Set<MetricsScope>();

  constructor(private readonly opts: EngineMetricsOptions) {
    const { probes } = opts.resolved;
    this.specProbes = probes.filter((p) => p.scope === "spec");
    this.invocationProbes = probes.filter((p) => p.scope === "invocation");
  }

  get hasSpecScope(): boolean {
    return this.specProbes.length > 0;
  }

  get hasInvocationScope(): boolean {
    return this.invocationProbes.length > 0;
  }

  private environment(scoped: ScopedSecrets): ProbeEnvironment {
    return {
      placeholderEnv: scoped.env,
      vars: this.opts.resolved.vars,
      childEnv: targetChildEnvWithSelectedTvaultKeys(
        scoped.childEnv,
        scoped.selectedKeys ?? [],
      ),
      cwd: this.opts.resolved.configDir,
      redact: (text) => this.opts.redactor.text(text),
    };
  }

  private scope(
    probes: NormalizedProbe[],
    scope: MetricScope,
    scoped: ScopedSecrets,
    onNotice: (notice: SampleNotice) => void,
    extra: { iteration?: number; extraEnv: Record<string, string> },
  ): MetricsScope {
    const sampler = new MetricsScope({
      probes,
      scope,
      env: this.environment(scoped),
      signal: this.opts.signal,
      onSample: onNotice,
      ...(extra.iteration !== undefined ? { iteration: extra.iteration } : {}),
      extraEnv: { ...this.opts.context, ...extra.extraEnv },
    });
    this.live.add(sampler);
    return sampler;
  }

  private notify(notice: SampleNotice, runId?: string): void {
    const { sample } = notice;
    // The `every:` ticks live in metrics.json only: a journal line per
    // second would drown the run.
    if (notice.phase !== "tick") {
      this.opts.journal?.appendEvent({
        ts: sample.at,
        type: "metric.sampled",
        name: notice.name,
        scope: notice.scope,
        phase: notice.phase,
        ...(sample.value !== undefined ? { value: sample.value } : {}),
        ...(sample.error !== undefined ? { error: sample.error } : {}),
        durationMs: sample.durationMs,
        ...(runId ? { runId } : {}),
        ...(notice.iteration !== undefined
          ? { iteration: notice.iteration }
          : {}),
      });
    }
    if (sample.error !== undefined) {
      const key = `${notice.scope}:${notice.name}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.opts.note(
          "warn",
          `metric ${notice.name} (${notice.scope}) sample failed: ${sample.error}`,
        );
      }
    }
  }

  private redactDocument<T>(document: T): T {
    return this.opts.redactor.value(document);
  }

  /** Samplers for one spec run, or undefined without spec-scope probes. */
  forSpec(scoped: ScopedSecrets, runToken: string): SpecMetrics | undefined {
    if (!this.hasSpecScope) return undefined;
    let runId: string | undefined;
    const sampler = this.scope(
      this.specProbes,
      "spec",
      scoped,
      (notice) =>
        this.notify(notice, notice.phase === "before" ? undefined : runId),
      { extraEnv: cairnContextEnv({ runToken }) },
    );
    return new SpecMetrics(this, sampler, (id) => {
      runId = id;
    });
  }

  /** Samplers around one iteration's specs, or undefined without invocation-scope probes. */
  forIteration(
    scoped: ScopedSecrets,
    iteration: number | undefined,
  ): InvocationMetrics | undefined {
    if (!this.hasInvocationScope) return undefined;
    const sampler = this.scope(
      this.invocationProbes,
      "invocation",
      scoped,
      (notice) => this.notify(notice),
      {
        ...(iteration !== undefined ? { iteration } : {}),
        extraEnv: this.opts.journal
          ? { CAIRN_INVOCATION_DIR: this.opts.journal.dir }
          : {},
      },
    );
    return new InvocationMetrics(this, sampler);
  }

  /** @internal Used by the scope handles. */
  release(sampler: MetricsScope): void {
    this.live.delete(sampler);
  }

  /** @internal */
  async writeRunDir(
    runDir: string,
    runId: string,
    rows: readonly MetricResult[],
    environment: string | undefined,
  ): Promise<void> {
    if (rows.length === 0 || !existsSync(runDir)) return;
    try {
      await writeMetricsFile(
        join(runDir, "diagnostics"),
        rows,
        { runId, ...(environment ? { environment } : {}) },
        (document) => this.redactDocument(document),
      );
    } catch (error) {
      this.opts.note(
        "warn",
        `could not write metrics for run ${runId}: ${(error as Error).message}`,
      );
    }
  }

  /** @internal */
  async mergeRunReport(
    runDir: string,
    rows: readonly MetricResult[],
  ): Promise<void> {
    if (rows.length === 0 || !existsSync(runDir)) return;
    try {
      const merged = await mergeReportMetrics(runDir, rows);
      if (!merged) {
        this.opts.note(
          "warn",
          `diagnostics/report.json in ${runDir} is not a JSON object: metrics stay in diagnostics/metrics.json only`,
        );
      }
    } catch (error) {
      this.opts.note(
        "warn",
        `could not merge metrics into diagnostics/report.json: ${(error as Error).message}`,
      );
    }
  }

  /** @internal */
  async writeJournal(rows: readonly MetricResult[]): Promise<void> {
    const journal = this.opts.journal;
    if (!journal || rows.length === 0) return;
    try {
      await writeMetricsFile(
        journal.dir,
        rows,
        {
          invocationId: this.opts.invocationId,
          environment: this.opts.resolved.envName,
        },
        (document) => this.redactDocument(document),
      );
    } catch (error) {
      this.opts.note(
        "warn",
        `could not write the invocation metrics: ${(error as Error).message}`,
      );
    }
  }

  /** Stop every sampler still running (the invocation is over). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.live].map((sampler) => sampler.dispose()));
    this.live.clear();
  }
}

/** Samplers around one spec run. */
export class SpecMetrics {
  private rows: MetricResult[] = [];
  private runDir: string | undefined;

  constructor(
    private readonly engine: EngineMetrics,
    private readonly sampler: MetricsScope,
    private readonly setRunId: (runId: string) => void,
  ) {}

  /** Take the `before` samples and start the `every:` ticks. */
  async start(): Promise<void> {
    await this.sampler.start();
  }

  /** The spec finished: take the `after` samples and write `diagnostics/metrics.json`. */
  async finish(result: RunResult): Promise<void> {
    this.setRunId(result.runId);
    this.runDir = result.runDir;
    this.rows = await this.sampler.stop(
      cairnContextEnv({
        runId: result.runId,
        runDir: result.runDir,
      }),
    );
    this.engine.release(this.sampler);
    await this.engine.writeRunDir(
      result.runDir,
      result.runId,
      this.rows,
      result.environment,
    );
  }

  /** Merge the flat numerics into `diagnostics/report.json` (after `--after` hooks). */
  async mergeReport(): Promise<void> {
    if (this.runDir) await this.engine.mergeRunReport(this.runDir, this.rows);
  }

  /** Stop without `after` samples (an errored spec, a cancel). Idempotent. */
  async dispose(): Promise<void> {
    await this.sampler.dispose();
    this.engine.release(this.sampler);
  }
}

/** Samplers around one iteration's specs. */
export class InvocationMetrics {
  constructor(
    private readonly engine: EngineMetrics,
    private readonly sampler: MetricsScope,
  ) {}

  async start(): Promise<void> {
    await this.sampler.start();
  }

  /**
   * The iteration's specs finished: take the `after` samples, write the
   * invocation journal's `metrics.json`, and give every run of the
   * iteration the same rows (`diagnostics/metrics.json` and the report
   * numerics).
   */
  async finish(results: readonly RunResult[]): Promise<void> {
    const rows = await this.sampler.stop();
    this.engine.release(this.sampler);
    await this.engine.writeJournal(rows);
    for (const result of results) {
      if (result.status === "refused") continue;
      await this.engine.writeRunDir(
        result.runDir,
        result.runId,
        rows,
        result.environment,
      );
      await this.engine.mergeRunReport(result.runDir, rows);
    }
  }

  async dispose(): Promise<void> {
    await this.sampler.dispose();
    this.engine.release(this.sampler);
  }
}
