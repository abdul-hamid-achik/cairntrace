import { homedir } from "node:os";
import { execa } from "execa";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ArtifactRef,
  BrowserBackend,
  ResolvedElement,
} from "../../adapters/browserBackend";
import { ArtifactWriter } from "../artifacts/ArtifactWriter";
import {
  addEnospcHint,
  pruneRuns,
  DEFAULT_KEEP_RUNS,
  DEFAULT_KEEP_FAILED_RUNS,
} from "../artifacts/retention";
import {
  createArtifactRedactor,
  registerSecretValues,
} from "../artifacts/redaction";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { resolveSpecRuntimeContext } from "../config/runtimeContext";
import { targetChildEnvWithSelectedTvaultKeys } from "../processEnv";
import { parseSpec } from "../parser/parseSpec";
import { computeContractHash } from "../contractHash";
import { evaluateWhen } from "./conditions";
import {
  cutClipsWithVidtrace,
  isVidtraceAvailable,
  moveClipsIntoRunDir,
  clipPointsToLabels,
} from "../clip/vidtraceClip";
import type { ExitCode } from "../schema/shared";
import {
  openPath,
  type EvalStep,
  type MonitorStep,
  type RequestStep,
  type Spec,
  type Step,
  type TransformStep,
} from "../schema/spec.v1";
import type {
  OutcomeResult,
  RunArtifacts,
  RunFailure,
  RunResult,
  StepResult,
} from "../schema/run.v1";
import { buildReplayManifest } from "../schema/replay.v1";
import type { Outcome } from "../schema/spec.v1";
import { CAIRN_VERSION } from "../../cli/version";
import { evaluateOutcomes } from "./OutcomeEvaluator";
import { runNodeScript } from "./nodeScripts";
import {
  deepMapStrings,
  resolveArtifactPlaceholders,
  resolveEvalPlaceholders,
  resolveFixtureMap,
  resolveResponsePlaceholders,
  resolveRuntimeFilePath,
} from "./runtimePlaceholders";
import { generateRunId } from "./runId";
import {
  applyWaitScale,
  resolveWaitScale,
  runResilientBrowserStep,
} from "./interactionResilience";
import { isRelativeUrl, joinUrl, resolveUrl } from "./url";
import type { VerifierContext, VerifierEvaluation } from "./verifiers/types";
import {
  type MonitorClient,
  type ProfileType,
  defaultMonitorClient,
} from "../monitor/monitorClient";
import {
  ProcessSampler,
  type ProcessMetricsSummary,
  renderProcessMarkdown,
} from "../monitor/processSampler";

/**
 * Optional progress callbacks the runner invokes during execution.
 * The CLI attaches a TTY-aware listener for interactive `cairn run` output;
 * tests typically omit it.
 */
export interface ProgressListener {
  onRunStart?(
    spec: Spec,
    runId: string,
    runDir: string,
    backendName: string,
    /**
     * The environment the run actually resolved to (config default, spec
     * `environment:`, or `--env` override — in that precedence). Not the
     * same as `spec.environment`: that field is only the spec's own
     * unresolved default and ignores a CLI `--env` override.
     */
    environment: string,
  ): void;
  onPreconditionStart?(name: string, timeoutMs: number): void;
  onPreconditionFinish?(
    name: string,
    exitCode: number | undefined,
    durationMs: number,
  ): void;
  onStepStart?(idx: number, step: Step, stepId: string): void;
  onStepFinish?(
    idx: number,
    stepId: string,
    status: StepResult["status"],
    durationMs: number,
    error: string | undefined,
  ): void;
  onOutcomesStart?(total: number): void;
  onOutcomeStart?(outcome: Outcome): void;
  onOutcomeFinish?(outcome: Outcome, evaluation: VerifierEvaluation): void;
  onRunEnd?(result: RunResult): void;
}

export interface RunOptions {
  specPath: string;
  backend: BrowserBackend;
  /** Defaults to ~/.cairntrace/runs */
  artifactRoot?: string;
  /** Cold-start gate from §10.6. Default false for local runs. */
  coldStart?: boolean;
  /** Override default environment from spec. */
  environmentOverride?: string;
  /** ${vars.X} substitution bag. */
  vars?: Record<string, string | number | boolean>;
  /** Override process.env. */
  env?: Record<string, string | undefined>;
  /** Environment authorized for shell target children; vault controls removed. */
  childEnv?: Record<string, string | undefined>;
  /** Explicit TinyVault names that may retain a `TVAULT_` prefix in children. */
  selectedTvaultKeys?: Iterable<string>;
  /** Literal values resolved by a scoped secret provider; artifact-only. */
  secretValues?: Iterable<string>;
  /** Inject a clock for deterministic run ids in tests. */
  now?: () => Date;
  /** Receives progress events during the run. */
  listener?: ProgressListener;
  /** Path to a cairntrace.config.yml. Disables auto-discovery from the spec dir. */
  configPath?: string;
  /** Worker slot for `${worker.index}`. Defaults to 0. */
  workerIndex?: number;
  /** Per-run token for `${run.token}`. Defaults to a generated token. */
  runToken?: string;
  /** Services lifecycle events to prepend to events.ndjson (from startServices). */
  servicesEvents?: Array<{
    phase: string;
    event: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }>;
  /**
   * Opt-in process monitoring. `true` or a config object enables the
   * `--monitor` sampler: the browser process tree's CPU/RSS is sampled during
   * the run and reduced into `diagnostics/process.{md,json}. Zero-cost when
   * absent/false. Implicitly enabled when `MONITOR=1` is in the env (the run
   * was launched under `monitor run`).
   */
  monitor?: boolean | MonitorConfig;
  /** Inject a MonitorClient for tests. Defaults to the real `monitor` CLI. */
  monitorClient?: MonitorClient;
  /**
   * Best-effort archive of a pruned run dir (e.g. to fcheap) before deletion.
   * Only invoked when config `retention.archiveToStash` is true. Injected by
   * the CLI so the core runner stays free of the stash (fcheap) dependency.
   */
  onArchiveRun?: (
    runDir: string,
    runId: string,
    tags: string[],
  ) => Promise<void>;
  /**
   * Explicit remote publication callback. It must validate a server-verified,
   * credential-free, byte-matching receipt before resolving; pruneRuns keeps
   * the source on any failure.
   */
  onPublishRun?: (
    runDir: string,
    runId: string,
    tags: string[],
    retentionDays: number,
  ) => Promise<void>;
  /**
   * Free-form labels stamped into run.json (`cairn run --label key=value`).
   * Used by `cairn stats --group-by` for A/B cohorts. Optional.
   */
  labels?: Record<string, string>;
  /** Internal command-level capture override (used by `cairn audit`). */
  captureOverride?: Partial<{
    screenshots: "always" | "on-failure" | "never";
    snapshots: "always" | "on-failure" | "never";
    trace: "always" | "on-failure" | "never";
    video: "always" | "on-failure" | "never";
  }>;
  /** Internal command-level video settings (used by `cairn audit`). */
  videoOptions?: { slowMo?: number; speed?: number };
}

export interface MonitorConfig {
  /** Sampling interval in milliseconds. Default 1000. */
  intervalMs?: number;
}

/**
 * Run a behavioral spec end-to-end:
 *   parse → make run dir → execute steps (with capture) → evaluate outcomes
 *   → write evidence + run.* artifacts + agent_context.md → return RunResult.
 *
 * The runner is backend-agnostic — it talks only to the `BrowserBackend`
 * interface, so a MockBrowserBackend works for tests and `--mock` runs.
 */
export async function runSpec(opts: RunOptions): Promise<RunResult> {
  const runEnv = targetChildEnvWithSelectedTvaultKeys(
    opts.env ?? (process.env as Record<string, string | undefined>),
    opts.selectedTvaultKeys ?? [],
  );
  const workerIndex = opts.workerIndex ?? 0;
  const runToken = opts.runToken ?? generateRunToken();
  const runtime = await resolveSpecRuntimeContext(opts.specPath, {
    ...(opts.environmentOverride !== undefined
      ? { envOverride: opts.environmentOverride }
      : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
    env: runEnv,
  });
  const resolvedVars = resolveRuntimeVars(runtime.vars, {
    workerIndex,
    runToken,
  });
  const {
    spec,
    resolved,
    path: specPath,
  } = await parseSpec(opts.specPath, {
    env: runEnv,
    vars: resolvedVars,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    runtime: { workerIndex, runToken },
  });

  const env = runtime.envName;
  const waitScale = resolveWaitScale(
    runtime.waitScale,
    runEnv["CAIRN_WAIT_SCALE"],
  );
  opts.backend.setWaitScale(waitScale);
  // The actual backend that ran is authoritative — spec.backend is only
  // advisory metadata that may not match the CLI's --backend choice.
  const backendName = opts.backend.name;
  const artifactRoot =
    opts.artifactRoot ??
    runtime.config?.artifactRoot ??
    join(homedir(), ".cairntrace", "runs");
  const now = (opts.now ?? (() => new Date()))();
  const runId = generateRunId(spec.name, now);
  const runDir = resolve(artifactRoot, runId);

  // Investigation and vidtrace enrichment happen after the core run writer
  // finishes. Register spec-declared literals process-wide so those post-run
  // text artifacts use the same redaction boundary as the main artifact pack.
  registerSecretValues(spec.redaction?.values ?? []);
  const redactor = createArtifactRedactor(
    spec.redaction,
    runEnv,
    opts.secretValues,
  );
  const writer = new ArtifactWriter(
    runDir,
    redactor,
    runtime.config?.report ? { report: runtime.config.report } : {},
  );
  await writer.ensureDirs();
  await writer.writeResolvedSpec(resolved);

  // Prepend services lifecycle events (docker/seed/tmux/teardown) to
  // events.ndjson so post-run diagnostics show the full environment lifecycle.
  if (opts.servicesEvents && opts.servicesEvents.length > 0) {
    await writer.appendServicesEvents(opts.servicesEvents);
  }

  const startedAt = now.toISOString();
  await writer.appendEvent({
    ts: startedAt,
    type: "run.started",
    runId,
    spec: spec.name,
  });
  opts.listener?.onRunStart?.(spec, runId, runDir, backendName, env);

  // Execute spec preconditions (setup/reset shell commands) BEFORE any browser
  // interaction. Until v1.48 the schema accepted `preconditions.commands` but
  // nothing executed them — guards and data resets silently did nothing. Each
  // command runs through the shell with cwd = the spec's directory (or its own
  // `cwd`, resolved against it); `preconditions.env` is layered over
  // process.env. A non-zero exit aborts the run: a failed precondition means
  // the spec's contract cannot be evaluated.
  const preconditionCommands = spec.preconditions?.commands ?? [];
  if (preconditionCommands.length > 0) {
    const specDir = dirname(specPath);
    const preEnv: NodeJS.ProcessEnv = targetChildEnvWithSelectedTvaultKeys(
      {
        ...(opts.childEnv ?? runEnv),
        ...Object.fromEntries(
          Object.entries(spec.preconditions?.env ?? {}).map(([k, v]) => [
            k,
            String(v),
          ]),
        ),
      },
      opts.selectedTvaultKeys ?? [],
    );
    for (const [index, command] of preconditionCommands.entries()) {
      const label = command.name ?? `precondition[${index}]`;
      const cwd = command.cwd ? resolve(specDir, command.cwd) : specDir;
      const startedAtMs = Date.now();
      // precondition.run is a post-mortem event: a long quiesce poll used to
      // leave events.ndjson silent for its whole budget, indistinguishable
      // from a dead run. The started twin bounds the mystery to one command.
      await writer.appendEvent({
        ts: new Date(startedAtMs).toISOString(),
        type: "precondition.started",
        name: label,
        timeoutMs: command.timeoutMs ?? 120_000,
      });
      opts.listener?.onPreconditionStart?.(label, command.timeoutMs ?? 120_000);
      const result = await execa(command.run, {
        shell: true,
        cwd,
        env: preEnv,
        reject: false,
        timeout: command.timeoutMs ?? 120_000,
        all: true,
      });
      const output = String(result.all ?? "");
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "precondition.run",
        name: label,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAtMs,
        output: output.slice(0, 4000),
      });
      opts.listener?.onPreconditionFinish?.(
        label,
        result.exitCode,
        Date.now() - startedAtMs,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Precondition "${label}" failed (exit ${result.exitCode}): ${output.slice(0, 500)}`,
        );
      }
    }
  }

  // Reset backend's network/console logs before the run so we don't pick up
  // leakage from a previous spec on the same session.
  await safe(() => opts.backend.clearNetworkLog());
  await safe(() => opts.backend.clearConsole());

  const policy = mergeCapturePolicy(spec, opts.captureOverride);

  // Surface clip/video misconfigurations that would otherwise silently produce
  // nothing — the marquee "run → video → vidtrace clip" loop only works on the
  // playwright backend with video enabled.
  const clipPointsRequested = (spec.artifacts?.clipPoints?.length ?? 0) > 0;
  if (clipPointsRequested && policy.video === "never") {
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "warning",
      warning:
        "clipPoints are configured but artifacts.capture.video is 'never' — no video is recorded, so no clips can be cut. Set video: on-failure (or always) to enable clips.",
    });
  }
  if (policy.video !== "never" && !opts.backend.startVideo) {
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "warning",
      warning: `video capture is requested but the '${opts.backend.name}' backend does not record video — only the playwright backend does. Run with --backend playwright to produce video${
        clipPointsRequested ? " and clips" : ""
      }.`,
    });
  }

  // Start video recording. Same best-effort pattern as trace: backends
  // without video support no-op. The default policy is `never` so videos are
  // only recorded when the spec explicitly opts in.
  if (policy.video !== "never") {
    const videoConfig = {
      ...spec.artifacts?.video,
      ...opts.videoOptions,
    };
    await safe(async () =>
      opts.backend.startVideo?.({
        slowMo: videoConfig?.slowMo,
        speed: videoConfig?.speed,
      }),
    );
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "start",
      policy: policy.video,
      ...(videoConfig?.slowMo ? { slowMo: videoConfig.slowMo } : {}),
      ...(videoConfig?.speed && videoConfig.speed !== 1
        ? { speed: videoConfig.speed }
        : {}),
    });
  }

  // Start trace after video setup. Playwright creates its context when tracing
  // starts, so video must configure recordVideo + slowMo first or the trace
  // context would be discarded and the recording options ignored.
  if (policy.trace !== "never") {
    await safe(async () => opts.backend.startTrace?.());
  }

  // Cold-start gate (plan §10.6). Default `false` locally, `true` in CI.
  // Resolves before checkpoint resume so the spec's own setup populates state
  // *after* the wipe.
  const coldStart = opts.coldStart ?? runEnv["CI"] === "true";
  if (coldStart) {
    await safe(() => opts.backend.clearBrowserState());
  }

  // Restore checkpoint if spec asks for it. The `resume` field accepts either
  // a literal path or a name registered with `cairn checkpoint capture-from-session`.
  if (spec.session?.resume) {
    const store = new CheckpointStore();
    const resolvedResume = store.resolveResume(spec.session.resume);
    await safe(() => opts.backend.loadState(resolvedResume));
  }

  // Apply the viewport before any step runs. Spec-level wins over the
  // environment's config. Placed after loadState so backends that rebuild
  // their page on state restore still end up at the requested size.
  const viewport = spec.viewport ?? runtime.viewport;
  if (viewport) {
    // Deliberately not routed through safe(): that helper discards the
    // error, and a swallowed setViewport failure previously left the
    // "viewport.set" event looking identical whether the resize actually
    // took effect or the backend rejected/ignored it — silently misleading
    // anyone debugging an off-viewport element. Record the outcome instead.
    let viewportError: string | undefined;
    try {
      await opts.backend.setViewport?.(viewport.width, viewport.height);
    } catch (e) {
      viewportError = (e as Error).message;
    }
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "viewport.set",
      width: viewport.width,
      height: viewport.height,
      ok: viewportError === undefined,
      ...(viewportError ? { error: viewportError } : {}),
    });
  }

  const stepResults: StepResult[] = [];
  let lastSuccessfulStep: Step | undefined;
  let latestScreenshot: string | undefined;
  let latestSnapshot: string | undefined;
  let latestDiagnostics: string | undefined;
  let didError = false;
  const downloads: Record<string, string> = {};
  const transforms: Record<string, string> = {};
  /** request-step artifact paths by assign name (run-relative). */
  const requests: Record<string, string> = {};
  /** Captured request-step responses for ${requests.<name>.…} substitution. */
  const responses: Record<string, unknown> = {};
  /** eval-step artifact paths by assign name (run-relative). */
  const evals: Record<string, string> = {};
  /** Captured eval-step return values for ${evals.<name>.…} substitution. */
  const evalValues: Record<string, unknown> = {};
  const namedArtifacts: Record<string, ArtifactRef> = {};
  const diagnostics: string[] = [];

  // Opt-in process monitoring (`--monitor` or MONITOR=1). The sampler targets
  // the backend's browserPid() and may start lazily — agent-browser spawns its
  // daemon on the first command, so the PID can be unavailable until after the
  // first step. Zero-cost when monitoring is disabled.
  const monitorClient = opts.monitorClient ?? defaultMonitorClient();
  const monitorEnabled =
    opts.monitor !== undefined && opts.monitor !== false
      ? true
      : isTruthyEnv(runEnv["MONITOR"]);
  const monitorIntervalMs =
    typeof opts.monitor === "object" && opts.monitor
      ? opts.monitor.intervalMs
      : undefined;
  let sampler: ProcessSampler | undefined;
  let processMetricsSummary: ProcessMetricsSummary | undefined;
  const maybeStartSampler = (): void => {
    if (!monitorEnabled || sampler) return;
    const pid = opts.backend.browserPid?.();
    if (pid === undefined || pid <= 1) return;
    sampler = new ProcessSampler({
      pid,
      ...(monitorIntervalMs !== undefined
        ? { intervalMs: monitorIntervalMs }
        : {}),
      client: monitorClient,
    });
    sampler.start();
    // When launched under `monitor run`, surface the target PID so the parent
    // monitor can observe the exact browser process tree.
    if (isTruthyEnv(runEnv["MONITOR"])) {
      void writer
        .writeJson(
          "diagnostics/target.json",
          { pid, backend: backendName, writtenAt: new Date().toISOString() },
          "diagnostic",
        )
        .catch(() => undefined);
    }
  };
  maybeStartSampler();
  for (let i = 0; i < (resolved.steps ?? []).length; i++) {
    const step = resolved.steps![i]!;
    const stepId = step.id ?? `step_${i + 1}`;
    const stepStart = Date.now();
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "step.started",
      stepId,
    });
    opts.listener?.onStepStart?.(i, step, stepId);

    // Optional when: predicate — skip the step if the page doesn't match.
    if ("when" in step && step.when) {
      let conditionHolds = false;
      try {
        conditionHolds = await evaluateWhen(step.when, opts.backend);
      } catch (e) {
        // Treat parse errors as a step failure so they surface clearly.
        const durationMs = Date.now() - stepStart;
        stepResults.push({
          id: stepId,
          status: "failed",
          durationMs,
          error: `when: ${(e as Error).message}`,
        });
        opts.listener?.onStepFinish?.(
          i,
          stepId,
          "failed",
          durationMs,
          `when: ${(e as Error).message}`,
        );
        break;
      }
      if (!conditionHolds) {
        const durationMs = Date.now() - stepStart;
        stepResults.push({ id: stepId, status: "skipped", durationMs });
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "step.finished",
          stepId,
          durationMs,
          skipped: true,
          when: step.when,
        });
        opts.listener?.onStepFinish?.(
          i,
          stepId,
          "skipped",
          durationMs,
          undefined,
        );
        continue;
      }
    }

    const stepArtifacts: string[] = [];
    // Splice captured request-response fields (${requests.<name>.…}) and
    // eval return values (${evals.<name>.…}) into any string field of the
    // step before it runs — the hybrid-flow hook ("fetch token via API, fill
    // it into the UI" / "read store value, fill it into the form").
    const substituted =
      Object.keys(responses).length > 0 || Object.keys(evalValues).length > 0
        ? deepMapStrings(step, (s) =>
            resolveEvalPlaceholders(
              resolveResponsePlaceholders(s, responses),
              evalValues,
            ),
          )
        : step;
    let stepToRun = resolveOpenStep(substituted, {
      baseUrl: runtime.baseUrl,
      artifacts: namedArtifacts,
    });
    stepToRun = applySpecClickSettle(stepToRun, resolved.settleMs);
    stepToRun = applyWaitScale(stepToRun, waitScale);
    let pendingDownload:
      | {
          assign: string;
          relativePath: string;
          absolutePath: string;
        }
      | undefined;
    if ("download" in stepToRun) {
      const relativePath = downloadRelativePath(stepToRun.download.saveAs);
      const absolutePath = await writer.preparePath(relativePath, "download");
      pendingDownload = {
        assign: stepToRun.download.assign ?? artifactNameFromPath(relativePath),
        relativePath,
        absolutePath,
      };
      stepToRun = {
        ...stepToRun,
        download: { ...stepToRun.download, saveAs: absolutePath },
      };
    } else if ("upload" in stepToRun) {
      stepToRun = {
        ...stepToRun,
        upload: {
          ...stepToRun.upload,
          path: resolveUploadPath(
            stepToRun.upload.path,
            runDir,
            namedArtifacts,
          ),
        },
      };
    }

    let stepStatus: StepResult["status"] = "passed";
    let stepError: string | undefined;
    let stepResolved: ResolvedElement | undefined;
    try {
      if ("request" in stepToRun) {
        const requested = await runRequestStep({
          step: stepToRun,
          backend: opts.backend,
          requestIndex: i + 1,
          baseUrl: runtime.baseUrl,
        });
        if (!requested.ok) {
          stepStatus = "failed";
          stepError = requested.error;
        } else {
          const relativePath = `requests/${requested.assign}.json`;
          await writer.writeJson(relativePath, requested.response, "request");
          const absolutePath = writer.resolve(relativePath);
          responses[requested.assign] = requested.response;
          requests[requested.assign] = relativePath;
          namedArtifacts[requested.assign] = {
            kind: "request",
            path: absolutePath,
            relativePath,
          };
          stepArtifacts.push(relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.request",
            stepId,
            path: relativePath,
            assign: requested.assign,
            status: requested.response.status,
          });
        }
      } else if ("transform" in stepToRun) {
        const transformed = await runTransformStep({
          step: stepToRun,
          writer,
          specDir: dirname(specPath),
          artifacts: namedArtifacts,
          vars: resolvedVars,
        });
        if (!transformed.ok) {
          stepStatus = "failed";
          stepError = transformed.error;
        } else {
          transforms[transformed.assign] = transformed.relativePath;
          namedArtifacts[transformed.assign] = {
            kind: "transform",
            path: transformed.absolutePath,
            relativePath: transformed.relativePath,
          };
          stepArtifacts.push(transformed.relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.transform",
            stepId,
            path: transformed.relativePath,
            assign: transformed.assign,
          });
        }
      } else if ("eval" in stepToRun) {
        const ev = await runEvalStep({
          step: stepToRun as EvalStep,
          backend: opts.backend,
          specDir: dirname(specPath),
          writer,
        });
        if (!ev.ok) {
          stepStatus = "failed";
          stepError = ev.error;
        } else if (ev.assign) {
          const relativePath = `evals/${ev.assign}.json`;
          evals[ev.assign] = relativePath;
          evalValues[ev.assign] = { value: ev.value };
          namedArtifacts[ev.assign] = {
            kind: "eval",
            path: writer.resolve(relativePath),
            relativePath,
          };
          stepArtifacts.push(relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.eval",
            stepId,
            path: relativePath,
            assign: ev.assign,
          });
        }
      } else if ("monitor" in stepToRun) {
        const mon = await runMonitorStep({
          step: stepToRun as MonitorStep,
          backend: opts.backend,
          client: monitorClient,
          writer,
          index: i + 1,
        });
        if (!mon.ok) {
          stepStatus = "failed";
          stepError = mon.error;
        } else {
          stepArtifacts.push(mon.relativePath);
          if (mon.assign) {
            namedArtifacts[mon.assign] = {
              kind: "monitor" as ArtifactRef["kind"],
              path: writer.resolve(mon.relativePath),
              relativePath: mon.relativePath,
            };
          }
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.monitor",
            stepId,
            action: mon.action,
            path: mon.relativePath,
            ...(mon.assign ? { assign: mon.assign } : {}),
          });
        }
      } else {
        const r = await runResilientBrowserStep(
          stepToRun,
          opts.backend,
          waitScale,
        );
        stepResolved = r.resolvedElement;
        if (!r.ok) {
          stepStatus = "failed";
          stepError = r.stderr.trim() || `exit ${r.exitCode}`;
        } else if (pendingDownload) {
          downloads[pendingDownload.assign] = pendingDownload.relativePath;
          namedArtifacts[pendingDownload.assign] = {
            kind: "download",
            path: pendingDownload.absolutePath,
            relativePath: pendingDownload.relativePath,
          };
          stepArtifacts.push(pendingDownload.relativePath);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.download",
            stepId,
            path: pendingDownload.relativePath,
            assign: pendingDownload.assign,
          });
        }
      }
    } catch (e) {
      stepStatus = "failed";
      stepError = addEnospcHint((e as Error).message);
      didError = true;
    }

    // The browser PID may only be known after the first navigation (agent-browser
    // spawns its daemon lazily), so retry starting the sampler each step.
    maybeStartSampler();

    // When the backend is wedged, every follow-up subprocess (snapshot,
    // screenshot, diagnostics-eval) re-queues behind an unresponsive daemon
    // and just adds wall time without yielding useful evidence. Skip the
    // post-failure capture phase and record a single artifact noting the
    // short-circuit. The close() call further down escalates to a daemon
    // kill for the same reason.
    if (opts.backend.isWedged?.()) {
      const rel = `diagnostics/${pad(i + 1)}_${stepId}.json`;
      await writer.writeJson(
        rel,
        {
          stepId,
          status: stepStatus,
          stepError,
          wedged: true,
          note: "backend reported isWedged() === true after a child-timeout kill; post-failure capture was skipped to avoid hitting the unresponsive daemon. The close path will escalate to a daemon kill.",
        },
        "diagnostic",
      );
      latestDiagnostics = rel;
      diagnostics.push(rel);
      stepArtifacts.push(rel);
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.diagnostics",
        stepId,
        path: rel,
        wedged: true,
      });
    } else {
      // Capture snapshot and (on failure or always) screenshot.
      if (
        policy.snapshots === "always" ||
        (policy.snapshots === "on-failure" && stepStatus !== "passed")
      ) {
        const rel = `snapshots/${pad(i + 1)}_${stepId}.txt`;
        const snap = await safe(() => opts.backend.snapshot());
        if (snap && snap.ok) {
          await writer.writeText(rel, snap.text, "snapshot");
          latestSnapshot = rel;
          stepArtifacts.push(rel);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.snapshot",
            stepId,
            path: rel,
          });
        }
      }
      const shouldShoot =
        policy.screenshots === "always" ||
        (policy.screenshots === "on-failure" && stepStatus !== "passed");
      if (shouldShoot) {
        const rel = `screenshots/${pad(i + 1)}_${stepId}.png`;
        const screenshotPath = await writer.preparePath(rel, "screenshot");
        const shot = await opts.backend
          .screenshot({ path: screenshotPath })
          .catch((e: unknown) => ({
            ok: false as const,
            path: screenshotPath,
            durationMs: 0,
            error: `screenshot failed: ${(e as Error).message}`,
          }));
        if (shot && shot.ok) {
          latestScreenshot = rel;
          stepArtifacts.push(rel);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.screenshot",
            stepId,
            path: rel,
          });
        } else if (shot) {
          // A producer may have left a truncated PNG behind before reporting
          // failure. Never publish that file as usable evidence.
          await writer.remove(rel);
          const error =
            shot.error ??
            "screenshot capture failed without backend diagnostics";
          const diagnosticRel = `diagnostics/${pad(i + 1)}_${stepId}_screenshot.json`;
          await writer.writeJson(
            diagnosticRel,
            {
              stepId,
              path: rel,
              error,
              note: /timed out|rendering surface/i.test(error)
                ? "The browser did not provide a composited frame before the hard deadline. On a headed or desktop-backed run, confirm the display is awake; on a headless runner, confirm Chromium has a rendering surface."
                : "Screenshot capture is best-effort; the backend returned a concrete failure instead of silently dropping the artifact.",
            },
            "diagnostic",
          );
          latestDiagnostics = diagnosticRel;
          diagnostics.push(diagnosticRel);
          stepArtifacts.push(diagnosticRel);
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.screenshot",
            action: "failed",
            stepId,
            path: rel,
            error,
          });

          // Screenshots are best-effort evidence, never part of the contract.
          // A capture timeout is recorded as a warning + missing-artifact note
          // (the diagnostic above, with action:"failed" on the event) but must
          // NOT fail the step or spec. A timeout does set the backend's wedged
          // flag (see AgentBrowserAdapter); that flag only skips further
          // OPTIONAL captures (console/network/trace/video). A genuinely wedged
          // page fails naturally on its next real interaction.
        }
      }
      if (stepStatus !== "passed" && !opts.backend.isWedged?.()) {
        const rel = `diagnostics/${pad(i + 1)}_${stepId}.json`;
        const captured = await captureDiagnostics(
          opts.backend,
          step,
          stepError,
        );
        await writer.writeJson(rel, captured, "diagnostic");
        latestDiagnostics = rel;
        diagnostics.push(rel);
        stepArtifacts.push(rel);
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "artifact.diagnostics",
          stepId,
          path: rel,
        });
      }
    }

    const durationMs = Date.now() - stepStart;
    stepResults.push({
      id: stepId,
      status: stepStatus,
      durationMs,
      ...(stepError ? { error: stepError } : {}),
      ...(stepArtifacts.length > 0 ? { artifacts: stepArtifacts } : {}),
      ...(stepResolved ? { resolved: stepResolved } : {}),
    });

    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: stepStatus === "passed" ? "step.finished" : "step.failed",
      stepId,
      durationMs,
      ...(stepError ? { error: stepError } : {}),
      ...(stepResolved ? { resolved: stepResolved } : {}),
    });
    opts.listener?.onStepFinish?.(i, stepId, stepStatus, durationMs, stepError);

    if (stepStatus === "passed") {
      lastSuccessfulStep = step;
    } else {
      // Stop on first failure to avoid cascading noise.
      break;
    }
  }

  // A child-timeout kill leaves the adapter's command channel untrustworthy.
  // Keep the artifacts already written and skip only the OPTIONAL follow-up
  // captures (console/network, trace/video) that would queue behind the same
  // wedged daemon and turn one bounded failure into several more timeouts.
  // Outcome evaluation is NOT gated on this — the contract always runs (see
  // the evaluateOutcomes call below).
  const backendWedgedAfterSteps = opts.backend.isWedged?.() === true;

  // Stop the process sampler (if it ever started) and reduce its samples into
  // diagnostics/process.{json,md}. Zero-cost when monitoring was disabled or
  // no browser PID ever became available.
  let processMetricsArtifact: string | undefined;
  if (sampler) {
    processMetricsSummary = await sampler.stop();
    if (
      processMetricsSummary.samples.length > 0 ||
      processMetricsSummary.tree.length > 0
    ) {
      const jsonRel = "diagnostics/process.json";
      const mdRel = "diagnostics/process.md";
      await writer.writeJson(jsonRel, processMetricsSummary, "process-metrics");
      await writer.writeText(
        mdRel,
        renderProcessMarkdown(processMetricsSummary),
        "process-metrics",
      );
      processMetricsArtifact = jsonRel;
      diagnostics.push(mdRel);
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.monitor",
        action: "summary",
        path: jsonRel,
        samples: processMetricsSummary.samples.length,
        peakRssBytes: processMetricsSummary.peakRssBytes,
        peakCpuPercent: processMetricsSummary.peakCpuPercent,
      });
    }
  }

  // Persist console + network even on full pass, so agents have evidence to skim.
  const consoleEntries = backendWedgedAfterSteps
    ? []
    : await safe(() => opts.backend.getConsole()).then((x) => x ?? []);
  const networkEntries = backendWedgedAfterSteps
    ? []
    : await safe(() => opts.backend.getNetworkRequests()).then((x) => x ?? []);
  const consoleErrors = consoleEntries.filter((e) => e.type === "error");
  await writer.writeText(
    "console/console.ndjson",
    consoleEntries.map((entry) => JSON.stringify(entry)).join("\n") +
      (consoleEntries.length ? "\n" : ""),
    "console",
  );
  await writer.writeText(
    "console/errors.ndjson",
    consoleErrors.map((entry) => JSON.stringify(entry)).join("\n") +
      (consoleErrors.length ? "\n" : ""),
    "console",
  );
  const failedNetwork = networkEntries.filter(
    (e) => e.status !== undefined && e.status >= 400,
  );
  await writer.writeText(
    "network/requests.ndjson",
    networkEntries.map((entry) => JSON.stringify(entry)).join("\n") +
      (networkEntries.length ? "\n" : ""),
    "network",
  );
  await writer.writeText(
    "network/failed_requests.ndjson",
    failedNetwork.map((entry) => JSON.stringify(entry)).join("\n") +
      (failedNetwork.length ? "\n" : ""),
    "network",
  );

  // Stop trace recording and save to traces/<backend>-trace.zip.
  const traceRelPath = `traces/${backendName}-trace.zip`;
  let tracePath: string | undefined;
  if (!backendWedgedAfterSteps && policy.trace !== "never") {
    const traceResult = await safe(async () =>
      opts.backend.stopTrace?.(await writer.preparePath(traceRelPath, "trace")),
    );
    if (traceResult?.ok) {
      tracePath = traceRelPath;
    }
  }

  // The video is finalized after outcome evaluation. Playwright cannot save a
  // recording until its page/context closes, while outcome verifiers still
  // need that live page.
  const videoRelPath = `videos/${backendName}-video.webm`;
  let videoPath: string | undefined;

  // Evaluate outcomes first so we know whether the run failed before
  // deciding whether to auto-cut video clips.
  const failedStep = stepResults.find((s) => s.status === "failed")?.id;
  const ctx: VerifierContext = {
    lastSuccessfulStep: lastSuccessfulStep?.id,
    ...(failedStep ? { failedStep } : {}),
    latestScreenshot,
    latestSnapshot,
    latestDiagnostics,
    ...(tracePath ? { trace: tracePath } : {}),
    ...(videoPath ? { video: videoPath } : {}),
    runDir,
    specDir: dirname(specPath),
    artifacts: namedArtifacts,
    responses,
    evals: evalValues,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    vars: resolvedVars,
    ...(processMetricsSummary ? { processMetrics: processMetricsSummary } : {}),
  };
  opts.listener?.onOutcomesStart?.(resolved.outcomes.length);
  // Outcomes are the contract and are ALWAYS evaluated, even when the backend
  // marked itself wedged after a screenshot/child timeout. The verifiers carry
  // their own bounded deadlines, so a genuinely unresponsive page fails each
  // check naturally instead of every outcome being silently voided; a page
  // that merely lost its compositing surface (e.g. a slept display) still
  // reports real pass/fail. The wedged flag only skips the optional artifact
  // captures above (console/network/trace/video).
  // Listener calls ride the evaluation loop itself: a long verifier poll used
  // to buffer EVERY outcome line until the whole set finished, so two 5-min
  // polls meant ten silent minutes and then all verdicts at once.
  const evaluated = await evaluateOutcomes(
    resolved.outcomes,
    opts.backend,
    ctx,
    {
      onStart: (outcome) => opts.listener?.onOutcomeStart?.(outcome),
      onFinish: (outcome, evaluation) =>
        opts.listener?.onOutcomeFinish?.(outcome, evaluation),
    },
  );

  const outcomeResults: OutcomeResult[] = [];
  for (const { outcome, evaluation } of evaluated) {
    const outcomeStatus: OutcomeResult["status"] = evaluation.skipped
      ? "skipped"
      : evaluation.passed
        ? "passed"
        : "failed";
    outcomeResults.push({
      id: outcome.id,
      status: outcomeStatus,
      evidence: `outcomes/${outcome.id}.md`,
      ...(evaluation.raw !== undefined
        ? { evidenceRaw: `outcomes/${outcome.id}.raw.json` }
        : {}),
    });
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type:
        outcomeStatus === "skipped"
          ? "outcome.skipped"
          : evaluation.passed
            ? "outcome.passed"
            : "outcome.failed",
      outcomeId: outcome.id,
    });
  }

  const endedAt = new Date().toISOString();
  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  const stepFailed = stepResults.some((s) => s.status === "failed");
  const outcomeFailed = outcomeResults.some((o) => o.status === "failed");
  const status: RunResult["status"] = didError
    ? "errored"
    : stepFailed || outcomeFailed
      ? "failed"
      : "passed";
  const exitCode: ExitCode =
    status === "errored" ? 2 : status === "failed" ? 1 : 0;

  // Canonical failure reason + one-line summary (FEATURES item 1). On a
  // non-passing run the first failed step wins (it stopped the run and is the
  // root cause); otherwise the first failed outcome carries the reason. The
  // summary is always populated so a consumer can surface a single line
  // without scanning steps[]/outcomes[].
  const failedStepResult = stepResults.find((s) => s.status === "failed");
  const failedOutcomeIdx = outcomeResults.findIndex(
    (o) => o.status === "failed",
  );
  let failure: RunFailure | undefined;
  let summary: string;
  if (status === "passed") {
    const passedOutcomes = outcomeResults.filter(
      (o) => o.status === "passed",
    ).length;
    summary = `${passedOutcomes}/${outcomeResults.length} outcomes passed`;
  } else if (failedStepResult) {
    const stepMsg =
      failedStepResult.error ?? `step '${failedStepResult.id}' failed`;
    failure = { step: failedStepResult.id, message: stepMsg };
    summary =
      status === "errored"
        ? `errored at step '${failedStepResult.id}': ${stepMsg}`
        : `step '${failedStepResult.id}' failed: ${stepMsg}`;
  } else if (failedOutcomeIdx >= 0) {
    const failedOutcome = outcomeResults[failedOutcomeIdx]!;
    const evalEntry = evaluated[failedOutcomeIdx]?.evaluation;
    const detail = evalEntry
      ? `expected ${evalEntry.expected}; actual ${evalEntry.actual}`
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)
      : "verifier failed";
    failure = {
      outcome: failedOutcome.id,
      message: `outcome '${failedOutcome.id}' failed: ${detail}`,
    };
    summary = `outcome '${failedOutcome.id}' failed`;
  } else {
    summary = status;
  }

  // Now that every verifier has finished with the page, finalize the browser
  // context and save the recording.
  if (!backendWedgedAfterSteps && policy.video !== "never") {
    const videoResult = await safe(async () =>
      opts.backend.stopVideo?.(await writer.preparePath(videoRelPath, "video")),
    );
    if (videoResult?.ok) {
      videoPath = videoRelPath;
    }
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.video",
      action: "stop",
      ...(videoPath ? { path: videoPath } : {}),
    });
  }

  // Honor the trace capture policy: with the default "on-failure", a passing
  // run deletes its trace zip (they're the bulk of artifact disk usage).
  if (tracePath && status === "passed" && policy.trace !== "always") {
    await safe(() => writer.remove(traceRelPath));
    tracePath = undefined;
  }

  // Same policy applies to video: a passing run with `on-failure` deletes
  // the .webm to save disk (videos are larger than traces).
  if (videoPath && status === "passed" && policy.video !== "always") {
    await safe(() => writer.remove(videoRelPath));
    videoPath = undefined;
  }

  // Auto-cut clips from spec points when the run failed and video is kept.
  const clips: Record<string, string> = {};
  const clipPoints = spec.artifacts?.clipPoints;
  if (status === "failed" && videoPath && clipPoints && clipPoints.length > 0) {
    const vidtrace = await isVidtraceAvailable();
    if (vidtrace.available) {
      const labels = clipPointsToLabels(clipPoints);
      const cutResult = await cutClipsWithVidtrace(
        writer.resolve(videoRelPath),
        labels,
        {
          outputDir: await writer.ensureDir("videos/clips"),
          name: spec.name,
          tags: runtime.config?.clips?.tags ?? spec.artifacts?.clipTags ?? [],
          reencode: false,
        },
      );
      if (cutResult.ok && cutResult.clips && cutResult.clips.length > 0) {
        const movedClips = await moveClipsIntoRunDir(runDir, cutResult);
        for (const relativePath of Object.values(movedClips)) {
          writer.registerExisting(relativePath, "clip");
        }
        Object.assign(clips, movedClips);
        if (Object.keys(clips).length > 0) {
          await writer.appendEvent({
            ts: new Date().toISOString(),
            type: "artifact.video",
            action: "clip",
            clips,
          });
        }
      } else if (cutResult.error) {
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "artifact.video",
          action: "clip",
          error: cutResult.error,
        });
      }
    } else {
      // Clips were requested but vidtrace isn't installed — surface it
      // instead of silently dropping the evidence the user asked for.
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.video",
        action: "clip",
        error:
          "vidtrace not found on PATH — clipPoints were requested but no clips were cut. Install vidtrace to enable failure clip extraction.",
      });
    }
  }

  // Write outcome evidence, including clips in the source when available.
  for (const { outcome, evaluation } of evaluated) {
    const outcomeStatus: OutcomeResult["status"] = evaluation.skipped
      ? "skipped"
      : evaluation.passed
        ? "passed"
        : "failed";
    await writer.writeOutcomeEvidence({
      outcomeId: outcome.id,
      status: outcomeStatus,
      description: outcome.description,
      expected: evaluation.expected,
      actual: evaluation.actual,
      source: {
        ...(ctx.lastSuccessfulStep
          ? { lastSuccessfulStep: ctx.lastSuccessfulStep }
          : {}),
        ...(latestScreenshot ? { screenshot: latestScreenshot } : {}),
        ...(latestSnapshot ? { snapshot: latestSnapshot } : {}),
        ...(latestDiagnostics ? { diagnostics: latestDiagnostics } : {}),
        ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
        ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
        ...(Object.keys(evals).length > 0 ? { evals } : {}),
        ...(tracePath ? { trace: tracePath } : {}),
        ...(videoPath ? { video: videoPath } : {}),
        ...(Object.keys(clips).length > 0 ? { clips } : {}),
      },
      ...(evaluation.raw !== undefined ? { raw: evaluation.raw } : {}),
      whyThisMatters: outcome.description,
    });
  }

  const artifacts: RunArtifacts = {
    report: "report.html",
    reportJson: "report.json",
    agentContext: "agent_context.md",
    events: "events.ndjson",
    console: "console/errors.ndjson",
    network: "network/failed_requests.ndjson",
    ...(latestScreenshot ? { screenshots: [latestScreenshot] } : {}),
    ...(latestSnapshot ? { snapshots: [latestSnapshot] } : {}),
    ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(evals).length > 0 ? { evals } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(tracePath ? { trace: tracePath } : {}),
    ...(processMetricsArtifact
      ? { processMetrics: processMetricsArtifact }
      : {}),
    ...(videoPath ? { video: videoPath } : {}),
    ...(Object.keys(clips).length > 0 ? { clips } : {}),
    replay: "replay.json",
    manifest: "artifact-manifest.json",
  };
  const labels =
    opts.labels && Object.keys(opts.labels).length > 0
      ? opts.labels
      : undefined;
  const result: RunResult = {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    runDir,
    spec: {
      name: spec.name,
      path: specPath,
      // Always populate contractHash (FEATURES nice-to-have): stamped specs
      // carry it; unstamped specs get the on-the-fly sha256 over intent +
      // outcomes, matching what `cairn spec verify --stamp` would write.
      contractHash: spec.contractHash ?? computeContractHash(spec),
    },
    environment: env,
    backend: backendName as RunResult["backend"],
    coldStart,
    ...(labels ? { labels } : {}),
    status,
    summary,
    ...(failure ? { failure } : {}),
    startedAt,
    endedAt,
    durationMs,
    outcomes: outcomeResults,
    steps: stepResults,
    artifacts,
    exitCode,
  };

  const publicResult = redactor.value(result);
  await writer.writeRun(publicResult);
  await writer.writeOutcomesIndex(publicResult);
  await writer.writeAgentContext(spec, publicResult);

  // Exact-replay manifest (SPEC §7.3): replay.json captures everything an
  // agent needs to reproduce the run without re-reading the resolved spec.
  // Env/var VALUES are never included — only key names — and the writer
  // redacts. Best-effort: a write failure must never fail the completed run.
  await safe(() =>
    writer.writeReplay(
      buildReplayManifest({
        runId,
        specName: spec.name,
        specPath,
        ...(spec.contractHash
          ? { contractHash: spec.contractHash }
          : { contractHash: computeContractHash(spec) }),
        backend: backendName,
        ...(env ? { environment: env } : {}),
        ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
        ...(viewport ? { viewport } : {}),
        capturePolicy: policy,
        envKeys: Object.keys(runtime.vars),
        cairnVersion: CAIRN_VERSION,
        generatedAt: endedAt,
      }),
    ),
  );
  await writer.appendEvent({
    ts: endedAt,
    type:
      status === "passed"
        ? "run.passed"
        : status === "failed"
          ? "run.failed"
          : "run.errored",
    runId,
    durationMs,
  });
  await writer.writeManifest(artifacts.manifest);
  opts.listener?.onRunEnd?.(publicResult);

  // Auto-prune the artifact root per the config retention policy. Best-effort
  // — a prune failure must never fail the run that just completed. Default
  // keepRuns is 3 (see DEFAULT_KEEP_RUNS) when no retention block is set;
  // retention.enabled: false disables pruning entirely.
  const retention = runtime.config?.retention;
  const keepRuns =
    retention?.enabled === false
      ? undefined
      : (retention?.keepRuns ?? DEFAULT_KEEP_RUNS);
  if (keepRuns !== undefined) {
    const requiresArchive = retention?.archiveToStash === true;
    const requiresPublication = retention?.publish?.enabled === true;
    if (
      (requiresArchive && !opts.onArchiveRun) ||
      (requiresPublication && !opts.onPublishRun)
    ) {
      // Fail closed: deleting without the configured archive callback would
      // violate the user's retention policy. Some callers (for example
      // library/MCP integrations) do not inject the CLI's file.cheap adapter.
      await writer.appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.retention",
        action: "warning",
        warning: requiresPublication
          ? "retention.publish.enabled is true but no publication adapter was provided; pruning was skipped"
          : "retention.archiveToStash is enabled but no archive adapter was provided; pruning was skipped",
      });
      return publicResult;
    }

    // Archive pruned runs to fcheap before deletion when configured. The
    // archive callback is injected via opts so the core runner doesn't depend
    // on the stash (fcheap) CLI module.
    const onArchive =
      (requiresArchive || requiresPublication) &&
      (opts.onArchiveRun || opts.onPublishRun)
        ? async (dir: string, rid: string) => {
            const tags = [
              ...(retention?.archiveTags ?? []),
              "retention-archived",
            ];
            if (requiresArchive) await opts.onArchiveRun!(dir, rid, tags);
            if (requiresPublication) {
              await opts.onPublishRun!(
                dir,
                rid,
                tags,
                retention?.publish?.retentionDays ?? 7,
              );
            }
          }
        : undefined;
    const keepFailedRuns =
      retention?.keepFailedRuns ?? DEFAULT_KEEP_FAILED_RUNS;
    await safe(() =>
      pruneRuns(artifactRoot, {
        keepRuns,
        keepFailedRuns,
        ...(onArchive ? { onArchive } : {}),
      }),
    );
  }

  return publicResult;
}

/** Capture policies with sensible defaults. */
function mergeCapturePolicy(
  spec: Spec,
  override: RunOptions["captureOverride"] = {},
): {
  screenshots: "always" | "on-failure" | "never";
  snapshots: "always" | "on-failure" | "never";
  trace: "always" | "on-failure" | "never";
  video: "always" | "on-failure" | "never";
} {
  const c = spec.artifacts?.capture ?? {};
  return {
    screenshots: override.screenshots ?? c.screenshots ?? "on-failure",
    snapshots: override.snapshots ?? c.snapshots ?? "always",
    trace: override.trace ?? c.trace ?? "on-failure",
    video: override.video ?? c.video ?? "never",
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

function downloadRelativePath(saveAs: string): string {
  // Keep downloads inside the run directory even when a spec accidentally
  // provides an absolute or parent-relative path. Nested download paths are
  // deliberately collapsed for now to keep artifact references simple.
  return `downloads/${basename(saveAs)}`;
}

function transformRelativePath(saveAs: string): string {
  return `transforms/${basename(saveAs)}`;
}

function artifactNameFromPath(path: string): string {
  const raw = basename(path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(raw) ? raw : `artifact_${raw || "download"}`;
}

function resolveUploadPath(
  path: string,
  runDir: string,
  artifacts: Record<string, ArtifactRef>,
): string {
  const resolved = resolveArtifactPlaceholders(path, artifacts);
  const usedRelativeArtifact =
    /\$\{artifacts\.[a-z][A-Za-z0-9_]*\.relativePath\}/.test(path);
  if (usedRelativeArtifact && !isAbsolute(resolved)) {
    return resolve(runDir, resolved);
  }
  return resolved;
}

function generateRunToken(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRuntimeVars(
  vars: Record<string, string | number | boolean>,
  runtime: { workerIndex: number; runToken: string },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] =
      typeof value === "string"
        ? value
            .replace(/\$\{worker\.index\}/g, String(runtime.workerIndex))
            .replace(/\$\{run\.token\}/g, runtime.runToken)
        : value;
  }
  return out;
}

function resolveOpenStep(
  step: Step,
  opts: {
    baseUrl?: string;
    artifacts: Record<string, ArtifactRef>;
  },
): Step {
  if (!("open" in step)) return step;
  const path = resolveArtifactPlaceholders(openPath(step), opts.artifacts);
  const resolvedPath =
    opts.baseUrl && isRelativeUrl(path) ? joinUrl(opts.baseUrl, path) : path;
  if (resolvedPath === openPath(step)) return step;
  return typeof step.open === "string"
    ? { ...step, open: resolvedPath }
    : { ...step, open: { ...step.open, path: resolvedPath } };
}

/** Apply a spec-wide click settle only when the click has no local override. */
function applySpecClickSettle(step: Step, settleMs: number | undefined): Step {
  if (
    settleMs === undefined ||
    !("click" in step) ||
    step.settleMs !== undefined
  ) {
    return step;
  }
  return { ...step, settleMs };
}

/** The captured envelope a request step produces. */
interface RequestResponse {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Execute a `request` step through the backend's out-of-page request primitive
 * when available, falling back to bounded page-context fetch for older backends.
 */
async function runRequestStep(opts: {
  step: RequestStep;
  backend: BrowserBackend;
  requestIndex: number;
  baseUrl?: string;
}): Promise<
  | { ok: true; assign: string; response: RequestResponse }
  | { ok: false; error: string }
> {
  const req = opts.step.request;
  const assign = req.assign ?? `request_${opts.requestIndex}`;
  const resolved = await resolveRequestUrl(req.url, opts);
  if (!resolved.ok) return resolved;
  const timeoutMs = req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const request = { ...req, url: resolved.url, timeoutMs };

  if (typeof opts.backend.request === "function") {
    const backendResponse = await opts.backend.request({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      timeoutMs,
    });
    if (!backendResponse.ok) {
      return {
        ok: false,
        error: `request failed: ${backendResponse.error ?? "unknown error"} (${request.method} ${request.url})`,
      };
    }
    return applyExpectStatus(assign, request, {
      url: request.url,
      method: request.method,
      status: backendResponse.status,
      ok: backendResponse.status >= 200 && backendResponse.status < 400,
      headers: backendResponse.headers,
      body: backendResponse.body,
    });
  }

  const origin = await ensureRequestOrigin(opts.backend, request.url);
  if (!origin.ok) return origin;

  const result = await opts.backend.evaluate(buildRequestScript(request), {
    timeoutMs,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: `request eval failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: `request returned non-JSON eval output: ${result.stdout.slice(0, 200)}`,
    };
  }
  if (parsed && typeof parsed["requestError"] === "string") {
    return {
      ok: false,
      error: `request failed: ${parsed["requestError"]} (${request.method} ${request.url})`,
    };
  }

  const response: RequestResponse = {
    url: request.url,
    method: request.method,
    status: typeof parsed["status"] === "number" ? parsed["status"] : 0,
    ok: Boolean(parsed["ok"]),
    headers:
      parsed["headers"] && typeof parsed["headers"] === "object"
        ? (parsed["headers"] as Record<string, string>)
        : {},
    body: parsed["body"],
  };

  return applyExpectStatus(assign, request, response);
}

function applyExpectStatus(
  assign: string,
  request: RequestStep["request"],
  response: RequestResponse,
):
  | { ok: true; assign: string; response: RequestResponse }
  | {
      ok: false;
      error: string;
    } {
  if (request.expectStatus !== undefined) {
    const allowed = Array.isArray(request.expectStatus)
      ? request.expectStatus
      : [request.expectStatus];
    if (!allowed.includes(response.status)) {
      const bodyExcerpt = JSON.stringify(response.body)?.slice(0, 300) ?? "";
      return {
        ok: false,
        error: `request status ${response.status} not in expectStatus [${allowed.join(", ")}] (${request.method} ${request.url}) body: ${bodyExcerpt}`,
      };
    }
  }

  return { ok: true, assign, response };
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

async function resolveRequestUrl(
  url: string,
  opts: { baseUrl?: string; backend: BrowserBackend },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!isRelativeUrl(url)) return { ok: true, url };
  if (opts.baseUrl) return { ok: true, url: joinUrl(opts.baseUrl, url) };

  const currentUrl = await opts.backend.getUrl().catch(() => "about:blank");
  if (currentUrl === "about:blank" || currentUrl.startsWith("about:blank")) {
    return {
      ok: false,
      error: `request: relative URL "${url}" needs a baseUrl (config environments.<env>.baseUrl) or a prior open`,
    };
  }
  return { ok: true, url: resolveUrl(currentUrl, url) };
}

async function ensureRequestOrigin(
  backend: BrowserBackend,
  requestUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const currentUrl = await backend.getUrl().catch(() => "about:blank");
  if (!(currentUrl === "about:blank" || currentUrl.startsWith("about:blank"))) {
    return { ok: true };
  }
  if (!/^https?:\/\//i.test(requestUrl)) return { ok: true };

  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return { ok: true };
  }

  const opened = await backend.runStep({ open: origin });
  if (!opened.ok) {
    return {
      ok: false,
      error: `request: could not establish app origin ${origin} before fetch: ${
        opened.stderr.trim() ||
        opened.stdout.trim() ||
        `exit ${opened.exitCode}`
      }`,
    };
  }
  return { ok: true };
}

function buildRequestScript(req: RequestStep["request"]): string {
  const headers: Record<string, string> = { ...req.headers };
  let bodyExpr: string | undefined;
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      bodyExpr = JSON.stringify(req.body);
    } else {
      bodyExpr = JSON.stringify(JSON.stringify(req.body));
      const hasContentType = Object.keys(headers).some(
        (h) => h.toLowerCase() === "content-type",
      );
      if (!hasContentType) headers["content-type"] = "application/json";
    }
  }
  return [
    `(async () => {`,
    `  try {`,
    `    const res = await fetch(${JSON.stringify(req.url)}, {`,
    `      method: ${JSON.stringify(req.method)},`,
    `      credentials: "include",`,
    `      headers: ${JSON.stringify(headers)},`,
    ...(bodyExpr !== undefined ? [`      body: ${bodyExpr},`] : []),
    ...(req.timeoutMs !== undefined
      ? [`      signal: AbortSignal.timeout(${req.timeoutMs}),`]
      : []),
    `    });`,
    `    const text = await res.text();`,
    `    let body = null;`,
    `    try { body = JSON.parse(text); } catch (_) { body = text; }`,
    `    const headers = {};`,
    `    res.headers.forEach((v, k) => { headers[k] = v; });`,
    `    return { status: res.status, ok: res.ok, headers, body };`,
    `  } catch (e) {`,
    `    return { requestError: String((e && e.message) || e) };`,
    `  }`,
    `})()`,
  ].join("\n");
}

async function runTransformStep(opts: {
  step: TransformStep;
  writer: ArtifactWriter;
  specDir: string;
  artifacts: Record<string, ArtifactRef>;
  vars?: Record<string, string | number | boolean>;
}): Promise<
  | {
      ok: true;
      assign: string;
      relativePath: string;
      absolutePath: string;
    }
  | { ok: false; error: string }
> {
  const target = opts.step.transform;
  const relativePath = transformRelativePath(target.saveAs);
  const absolutePath = await opts.writer.preparePath(relativePath, "transform");

  const file = isAbsolute(target.file)
    ? target.file
    : resolve(opts.specDir, target.file);
  const input = resolveRuntimeFilePath(target.input, {
    artifacts: opts.artifacts,
    runDir: opts.writer.runDir,
    specDir: opts.specDir,
  });

  const result = await runNodeScript({
    file,
    cwd: opts.specDir,
    entryNames: ["transform"],
    ctx: {
      input,
      inputPath: input,
      output: { path: absolutePath, relativePath },
      outputPath: absolutePath,
      fixtures: resolveFixtureMap(target.fixtures, opts.artifacts),
      artifacts: opts.artifacts,
      vars: opts.vars ?? {},
      runDir: opts.writer.runDir,
      specDir: opts.specDir,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      error: `node transform failed: ${result.error?.message ?? result.stderr}`,
    };
  }

  const returned = result.result as { ok?: unknown; evidence?: unknown } | null;
  if (returned && typeof returned === "object" && returned.ok === false) {
    return { ok: false, error: "node transform returned ok=false" };
  }

  if (!(await fileExists(absolutePath))) {
    return {
      ok: false,
      error: `node transform did not write ${absolutePath}`,
    };
  }

  return {
    ok: true,
    assign: target.assign ?? artifactNameFromPath(relativePath),
    relativePath,
    absolutePath,
  };
}

/**
 * Execute an `eval` step — run arbitrary JS in the page context via
 * `backend.evaluate()` and optionally capture the return value.
 *
 * The source is either inline (`js`) or read from a file (`file`, resolved
 * against specDir). The source is wrapped so `args` is passed as the single
 * argument. The return value is JSON-parsed from the backend's stdout
 * (agent-browser auto-stringifies eval results).
 *
 * If `assign` is set, the captured value is written to `evals/<assign>.json`
 * (after redaction) and made available for `${evals.<name>.…}` interpolation.
 */
async function runEvalStep(opts: {
  step: EvalStep;
  backend: BrowserBackend;
  specDir: string;
  writer: ArtifactWriter;
}): Promise<
  { ok: true; assign?: string; value: unknown } | { ok: false; error: string }
> {
  const target = opts.step.eval;

  let source: string;
  try {
    if (target.js) {
      source = target.js;
    } else {
      const file = isAbsolute(target.file!)
        ? target.file!
        : resolve(opts.specDir, target.file!);
      const { readFile } = await import("node:fs/promises");
      source = await readFile(file, "utf8");
    }
  } catch (e) {
    return {
      ok: false,
      error: `eval: failed to load source: ${(e as Error).message}`,
    };
  }

  // Wrap so `args` is the single argument and the value is returned.
  const argsJson = JSON.stringify(target.args ?? {});
  const wrapped = `(async (args) => { ${source} })(${argsJson})`;

  let result;
  try {
    result = await opts.backend.evaluate(
      wrapped,
      target.timeoutMs ? { timeoutMs: target.timeoutMs } : {},
    );
  } catch (e) {
    return {
      ok: false,
      error: `eval: backend.evaluate threw: ${(e as Error).message}`,
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      error: `eval failed: exitCode=${result.exitCode}, stderr=${result.stderr.trim() || "(empty)"}`,
    };
  }

  // Parse the return value from stdout (agent-browser auto-stringifies).
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    // If the result isn't JSON, use the raw stdout as a string value.
    value = result.stdout;
  }

  // Write the captured value to evals/<assign>.json (after redaction).
  if (target.assign) {
    const relativePath = `evals/${target.assign}.json`;
    await opts.writer.writeJson(relativePath, { value }, "eval");
    return { ok: true, assign: target.assign, value };
  }

  return { ok: true, value };
}

/**
 * Execute a `monitor` step: capture a process profile or one-shot sample of
 * the backend's browser process tree via the external `monitor` CLI, and
 * write it to `monitor/<padded>-<action>.json`. With `assign`, register the
 * result as a named artifact (kind `monitor`) reusable via
 * `${artifacts.<assign>.path}`. Fails the step if no browser PID is available
 * or the monitor binary is missing — the author explicitly asked to capture
 * at this point, so a silent skip would hide the gap.
 */
async function runMonitorStep(opts: {
  step: MonitorStep;
  backend: BrowserBackend;
  client: MonitorClient;
  writer: ArtifactWriter;
  index: number;
}): Promise<
  | { ok: true; action: string; relativePath: string; assign?: string }
  | { ok: false; error: string }
> {
  const target = opts.step.monitor;
  const pid = opts.backend.browserPid?.();
  if (pid === undefined || pid <= 1) {
    return {
      ok: false,
      error:
        "monitor step needs a browser PID, but the backend has no spawned browser process (start the run with an `open` step first, or use a backend that exposes browserPid)",
    };
  }
  if (!(await opts.client.available())) {
    return {
      ok: false,
      error:
        "monitor step needs the `monitor` CLI on PATH (github.com/abdul-hamid-achik/monitor) — install it to capture process profiles/snapshots",
    };
  }
  const labelSlug = target.label
    ? `_${target.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "";
  const base = `${pad(opts.index)}_${target.action}${labelSlug}`;
  const relativePath = `monitor/${base}.json`;

  if (target.action === "profile") {
    const profile = await opts.client.captureProfile(
      pid,
      (target.type ?? "heap") as ProfileType,
    );
    if (!profile) {
      return {
        ok: false,
        error: `monitor profile <pid> --type ${target.type ?? "heap"} returned no result (process exited or profile failed)`,
      };
    }
    await opts.writer.writeJson(relativePath, profile, "monitor");
    return {
      ok: true,
      action: `profile:${profile.type}`,
      relativePath,
      ...(target.assign ? { assign: target.assign } : {}),
    };
  }
  // action === "snapshot"
  const sample = await opts.client.sampleProcess(pid);
  if (!sample) {
    return {
      ok: false,
      error: `monitor process ${pid} returned no result (process exited or sample failed)`,
    };
  }
  await opts.writer.writeJson(relativePath, sample, "monitor");
  return {
    ok: true,
    action: "snapshot",
    relativePath,
    ...(target.assign ? { assign: target.assign } : {}),
  };
}

async function fileExists(absPath: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(absPath)).isFile();
  } catch {
    return false;
  }
}

async function captureDiagnostics(
  backend: BrowserBackend,
  step: Step,
  stepError: string | undefined,
): Promise<unknown> {
  const descriptor = diagnosticStepDescriptor(step);
  const needles = diagnosticNeedles(step);
  const selector =
    ("click" in step && step.click.by === "selector" && step.click.selector) ||
    ("hover" in step && step.hover.by === "selector" && step.hover.selector) ||
    ("fill" in step && step.fill.by === "selector" && step.fill.selector) ||
    ("select" in step &&
      step.select.by === "selector" &&
      step.select.selector) ||
    ("upload" in step &&
      step.upload.by === "selector" &&
      step.upload.selector) ||
    ("download" in step &&
      step.download.by === "selector" &&
      step.download.selector) ||
    "";
  const js = [
    `(() => {`,
    `  const descriptor = ${JSON.stringify(descriptor)};`,
    `  const needles = ${JSON.stringify(needles)};`,
    `  const selector = ${JSON.stringify(selector)};`,
    `  const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();`,
    `  const visible = (el) => {`,
    `    if (!el) return false;`,
    `    const style = getComputedStyle(el);`,
    `    const rect = el.getBoundingClientRect();`,
    `    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;`,
    `  };`,
    `  const textOf = (el) => normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent);`,
    `  const sample = (sel, map) => Array.from(document.querySelectorAll(sel)).filter(visible).map(map).filter(Boolean).slice(0, 40);`,
    `  const bodyText = document.body ? document.body.innerText || '' : '';`,
    `  const excerpts = needles.map((needle) => {`,
    `    const idx = bodyText.toLowerCase().indexOf(String(needle).toLowerCase());`,
    `    return { needle, found: idx >= 0, excerpt: idx >= 0 ? normalize(bodyText.slice(Math.max(0, idx - 120), idx + String(needle).length + 120)) : '' };`,
    `  });`,
    `  let selectorCount = null;`,
    `  if (selector) {`,
    `    try { selectorCount = document.querySelectorAll(selector).length; } catch (e) { selectorCount = 'invalid selector: ' + e.message; }`,
    `  }`,
    // Streaming-SSR forensics (2026-07-12 empty-<main> investigation): a
    // Suspense boundary still mid-flush leaves `<!--$?-->` comment markers
    // in the DOM, and one that errored/fell back leaves `<!--$!-->` —
    // counting them plus readyState and landmark shape turns "the wait
    // failed" into "the page was still streaming when it failed."
    `  const suspenseBoundaries = (() => {`,
    `    let pending = 0, clientRendered = 0;`,
    `    try {`,
    `      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);`,
    `      let node;`,
    `      while ((node = walker.nextNode())) {`,
    `        if (node.nodeValue === '$?') pending++;`,
    `        else if (node.nodeValue === '$!') clientRendered++;`,
    `      }`,
    `    } catch (e) {}`,
    `    return { pending, clientRendered };`,
    `  })();`,
    `  const landmarks = {};`,
    `  for (const tag of ['header', 'main', 'footer']) {`,
    `    const el = document.querySelector(tag);`,
    `    landmarks[tag] = {`,
    `      tag,`,
    `      present: Boolean(el),`,
    `      childElementCount: el ? el.childElementCount : 0,`,
    `      visibleTextLength: el ? normalize(el.innerText || '').length : 0,`,
    `    };`,
    `  }`,
    `  return {`,
    `    url: location.href,`,
    `    title: document.title,`,
    `    step: descriptor,`,
    `    stepError: ${JSON.stringify(stepError ?? "")},`,
    `    selectorCount,`,
    `    readyState: document.readyState,`,
    `    suspenseBoundaries,`,
    `    landmarks,`,
    `    expectedTextExcerpts: excerpts,`,
    `    visibleButtons: sample('button, [role=button], input[type=button], input[type=submit]', (el) => ({ text: textOf(el), disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), selector: el.tagName.toLowerCase(), className: String(el.className || '').slice(0, 120) })),`,
    `    visibleLinks: sample('a, [role=link]', (el) => ({ text: textOf(el), href: el.href || '', className: String(el.className || '').slice(0, 120) })),`,
    `    visibleInputs: sample('input, textarea, select, [role=combobox]', (el) => ({ label: normalize(el.labels && el.labels[0] ? el.labels[0].innerText : ''), placeholder: el.getAttribute('placeholder') || '', name: el.getAttribute('name') || '', type: el.getAttribute('type') || el.tagName.toLowerCase(), value: el.type === 'password' ? '[redacted]' : String(el.value || '').slice(0, 80) })),`,
    `    formLabels: sample('label', (el) => textOf(el)),`,
    `    tableHeaders: sample('th, [role=columnheader]', (el) => textOf(el)),`,
    `  };`,
    `})()`,
  ].join("\n");

  const result = await safe(() => backend.evaluate(js));
  if (!result?.ok) {
    return {
      step: descriptor,
      stepError,
      diagnosticsError:
        result?.stderr ||
        `diagnostics eval failed with exit ${result?.exitCode}`,
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return {
      step: descriptor,
      stepError,
      diagnosticsError: `diagnostics JSON parse failed: ${(e as Error).message}`,
      stdout: result.stdout.slice(0, 2000),
    };
  }
}

function diagnosticStepDescriptor(step: Step): Record<string, unknown> {
  if ("click" in step) return { kind: "click", locator: step.click };
  if ("hover" in step) return { kind: "hover", locator: step.hover };
  if ("fill" in step) {
    const { value: _value, ...locator } = step.fill;
    return { kind: "fill", locator };
  }
  if ("select" in step) {
    const { value: _value, label: _label, ...locator } = step.select;
    return { kind: "select", locator };
  }
  if ("upload" in step) {
    const { path: _path, ...locator } = step.upload;
    return { kind: "upload", locator };
  }
  if ("download" in step) {
    const {
      saveAs: _saveAs,
      assign: _assign,
      timeoutMs: _timeoutMs,
      ...locator
    } = step.download;
    return { kind: "download", locator };
  }
  if ("transform" in step) {
    const {
      file,
      input,
      saveAs,
      assign,
      runtime: _runtime,
      fixtures: _fixtures,
    } = step.transform;
    return { kind: "transform", file, input, saveAs, assign };
  }
  if ("open" in step) return { kind: "open", url: openPath(step) };
  if ("batch" in step) {
    return {
      kind: "batch",
      subSteps: step.batch.map((sub) => Object.keys(sub)[0] ?? "?"),
    };
  }
  if ("request" in step) {
    return {
      kind: "request",
      method: step.request.method,
      url: step.request.url,
    };
  }
  if ("eval" in step) {
    return {
      kind: "eval",
      js: step.eval.js ? "(inline)" : undefined,
      file: step.eval.file,
      assign: step.eval.assign,
    };
  }
  if ("wait" in step) return { kind: "wait", condition: step.wait };
  if ("press" in step) return { kind: "press", key: step.press };
  if ("scroll" in step) return { kind: "scroll", scroll: step.scroll };
  if ("snapshot" in step) return { kind: "snapshot" };
  if ("type" in step) return { kind: "type" };
  if ("monitor" in step)
    return {
      kind: "monitor",
      action: step.monitor.action,
      type: step.monitor.type,
    };
  return { kind: "use", action: step.use };
}

function diagnosticNeedles(step: Step): string[] {
  const values: string[] = [];
  const add = (v: string | undefined) => {
    if (v && !values.includes(v)) values.push(v);
  };
  if ("click" in step) add(locatorNeedle(step.click));
  if ("hover" in step) add(locatorNeedle(step.hover));
  if ("fill" in step) add(locatorNeedle(step.fill));
  if ("type" in step) add(locatorNeedle(step.type));
  if ("select" in step) add(locatorNeedle(step.select));
  if ("upload" in step) add(locatorNeedle(step.upload));
  if ("download" in step) add(locatorNeedle(step.download));
  if ("transform" in step) {
    add(step.transform.file);
    add(step.transform.input);
    add(step.transform.saveAs);
  }
  if ("eval" in step) {
    add(step.eval.file);
    add(step.eval.assign);
  }
  if ("wait" in step) {
    if ("text" in step.wait) add(step.wait.text);
    if ("notText" in step.wait) add(step.wait.notText);
    if ("selector" in step.wait) add(step.wait.selector);
  }
  if ("scroll" in step && "to" in step.scroll)
    add(locatorNeedle(step.scroll.to));
  if ("batch" in step) {
    for (const sub of step.batch) {
      if ("click" in sub) add(sub.click.selector);
      else if ("hover" in sub) add(sub.hover.selector);
      else if ("fill" in sub) add(sub.fill.selector);
      else if ("type" in sub) add(sub.type.selector);
      else if ("upload" in sub) add(sub.upload.selector);
      else if ("scroll" in sub && "to" in sub.scroll)
        add(sub.scroll.to.selector);
      else if ("wait" in sub) {
        if ("text" in sub.wait) add(sub.wait.text);
        if ("notText" in sub.wait) add(sub.wait.notText);
        if ("selector" in sub.wait) add(sub.wait.selector);
      }
    }
  }
  return values.slice(0, 10);
}

function locatorNeedle(locator: {
  name?: string;
  text?: string;
  role?: string;
  selector?: string;
}): string | undefined {
  return locator.name ?? locator.text ?? locator.selector ?? locator.role;
}

/**
 * writeFile that ensures parent dir exists. Named with Bun_ prefix to avoid
 * shadowing the global fs.writeFile import; this is just a small helper.
 */
