import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ArtifactRef,
  BrowserBackend,
  ResolvedElement,
} from "../../adapters/browserBackend";
import { ArtifactWriter } from "../artifacts/ArtifactWriter";
import { addEnospcHint, pruneRuns } from "../artifacts/retention";
import { createArtifactRedactor } from "../artifacts/redaction";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { resolveSpecRuntimeContext } from "../config/runtimeContext";
import { parseSpec } from "../parser/parseSpec";
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
  type RequestStep,
  type Spec,
  type Step,
  type TransformStep,
} from "../schema/spec.v1";
import type {
  OutcomeResult,
  RunArtifacts,
  RunResult,
  StepResult,
} from "../schema/run.v1";
import type { Outcome } from "../schema/spec.v1";
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
import { isRelativeUrl, joinUrl, resolveUrl } from "./url";
import type { VerifierContext, VerifierEvaluation } from "./verifiers/types";

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
  const workerIndex = opts.workerIndex ?? 0;
  const runToken = opts.runToken ?? generateRunToken();
  const runtime = await resolveSpecRuntimeContext(opts.specPath, {
    ...(opts.environmentOverride !== undefined
      ? { envOverride: opts.environmentOverride }
      : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
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
    ...(opts.env ? { env: opts.env } : {}),
    vars: resolvedVars,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    runtime: { workerIndex, runToken },
  });

  const env = runtime.envName;
  // The actual backend that ran is authoritative — spec.backend is only
  // advisory metadata that may not match the CLI's --backend choice.
  const backendName = opts.backend.name;
  const artifactRoot =
    opts.artifactRoot ??
    runtime.config?.artifactRoot ??
    join(homedir(), ".cairntrace", "runs");
  const now = (opts.now ?? (() => new Date()))();
  const runId = generateRunId(spec.name, now);
  const runDir = join(artifactRoot, runId);

  const redactor = createArtifactRedactor(
    spec.redaction,
    opts.env ?? (process.env as Record<string, string | undefined>),
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
  opts.listener?.onRunStart?.(spec, runId, runDir, backendName);

  // Reset backend's network/console logs before the run so we don't pick up
  // leakage from a previous spec on the same session.
  await safe(() => opts.backend.clearNetworkLog());
  await safe(() => opts.backend.clearConsole());

  const policy = mergeCapturePolicy(spec);

  // Start trace recording. Trace artifacts are best-effort: backends without
  // trace support no-op, and a failed start is swallowed. With the default
  // `on-failure` policy the trace still has to record from the start — it's
  // deleted after the run if everything passed.
  if (policy.trace !== "never") {
    await safe(async () => opts.backend.startTrace?.());
  }

  // Start video recording. Same best-effort pattern as trace: backends
  // without video support no-op. The default policy is `never` so videos are
  // only recorded when the spec explicitly opts in.
  if (policy.video !== "never") {
    const videoConfig = spec.artifacts?.video;
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

  // Cold-start gate (plan §10.6). Default `false` locally, `true` in CI.
  // Resolves before checkpoint resume so the spec's own setup populates state
  // *after* the wipe.
  const coldStart = opts.coldStart ?? process.env["CI"] === "true";
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
    await safe(async () =>
      opts.backend.setViewport?.(viewport.width, viewport.height),
    );
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "viewport.set",
      width: viewport.width,
      height: viewport.height,
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
    let pendingDownload:
      | {
          assign: string;
          relativePath: string;
          absolutePath: string;
        }
      | undefined;
    if ("download" in stepToRun) {
      const relativePath = downloadRelativePath(stepToRun.download.saveAs);
      const absolutePath = writer.resolve(relativePath);
      pendingDownload = {
        assign: stepToRun.download.assign ?? artifactNameFromPath(relativePath),
        relativePath,
        absolutePath,
      };
      await ensureParentDir(absolutePath);
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
          const absolutePath = writer.resolve(relativePath);
          await Bun_writeFile(
            absolutePath,
            redactor.text(JSON.stringify(requested.response, null, 2) + "\n"),
            true,
          );
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
          runDir,
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
          redactor,
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
      } else {
        const r = await opts.backend.runStep(stepToRun);
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

    // Capture snapshot and (on failure or always) screenshot.
    if (
      policy.snapshots === "always" ||
      (policy.snapshots === "on-failure" && stepStatus !== "passed")
    ) {
      const rel = `snapshots/${pad(i + 1)}_${stepId}.txt`;
      const snap = await safe(() => opts.backend.snapshot());
      if (snap && snap.ok) {
        await Bun_writeFile(writer.resolve(rel), redactor.text(snap.text));
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
      const shot = await safe(() =>
        opts.backend.screenshot({ path: writer.resolve(rel) }),
      );
      if (shot && shot.ok) {
        latestScreenshot = rel;
        stepArtifacts.push(rel);
        await writer.appendEvent({
          ts: new Date().toISOString(),
          type: "artifact.screenshot",
          stepId,
          path: rel,
        });
      }
    }
    if (stepStatus !== "passed") {
      const rel = `diagnostics/${pad(i + 1)}_${stepId}.json`;
      const captured = await captureDiagnostics(opts.backend, step, stepError);
      await Bun_writeFile(
        writer.resolve(rel),
        redactor.text(renderDiagnostics(captured)),
        true,
      );
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

  // Persist console + network even on full pass, so agents have evidence to skim.
  const consoleEntries = await safe(() => opts.backend.getConsole()).then(
    (x) => x ?? [],
  );
  const networkEntries = await safe(() =>
    opts.backend.getNetworkRequests(),
  ).then((x) => x ?? []);
  const consoleErrors = consoleEntries.filter((e) => e.type === "error");
  await Bun_writeFile(
    writer.resolve("console/console.ndjson"),
    redactor.text(consoleEntries.map((e) => JSON.stringify(e)).join("\n")) +
      (consoleEntries.length ? "\n" : ""),
    true,
  );
  await Bun_writeFile(
    writer.resolve("console/errors.ndjson"),
    redactor.text(consoleErrors.map((e) => JSON.stringify(e)).join("\n")) +
      (consoleErrors.length ? "\n" : ""),
    true,
  );
  const failedNetwork = networkEntries.filter(
    (e) => e.status !== undefined && e.status >= 400,
  );
  await Bun_writeFile(
    writer.resolve("network/requests.ndjson"),
    redactor.text(networkEntries.map((e) => JSON.stringify(e)).join("\n")) +
      (networkEntries.length ? "\n" : ""),
    true,
  );
  await Bun_writeFile(
    writer.resolve("network/failed_requests.ndjson"),
    redactor.text(failedNetwork.map((e) => JSON.stringify(e)).join("\n")) +
      (failedNetwork.length ? "\n" : ""),
    true,
  );

  // Stop trace recording and save to traces/<backend>-trace.zip.
  const traceRelPath = `traces/${backendName}-trace.zip`;
  let tracePath: string | undefined;
  if (policy.trace !== "never") {
    const traceResult = await safe(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(writer.resolve("traces"), { recursive: true });
      return opts.backend.stopTrace?.(writer.resolve(traceRelPath));
    });
    if (traceResult?.ok) {
      tracePath = traceRelPath;
    }
  }

  // Stop video recording and save to videos/<backend>-video.webm.
  const videoRelPath = `videos/${backendName}-video.webm`;
  let videoPath: string | undefined;
  if (policy.video !== "never") {
    const videoResult = await safe(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(writer.resolve("videos"), { recursive: true });
      return opts.backend.stopVideo?.(writer.resolve(videoRelPath));
    });
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
  };
  opts.listener?.onOutcomesStart?.(resolved.outcomes.length);
  const evaluated = await evaluateOutcomes(
    resolved.outcomes,
    opts.backend,
    ctx,
  );

  const outcomeResults: OutcomeResult[] = [];
  for (const { outcome, evaluation } of evaluated) {
    opts.listener?.onOutcomeFinish?.(outcome, evaluation);
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

  // Honor the trace capture policy: with the default "on-failure", a passing
  // run deletes its trace zip (they're the bulk of artifact disk usage).
  if (tracePath && status === "passed" && policy.trace !== "always") {
    await safe(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(writer.resolve(traceRelPath), { force: true });
    });
    tracePath = undefined;
  }

  // Same policy applies to video: a passing run with `on-failure` deletes
  // the .webm to save disk (videos are larger than traces).
  if (videoPath && status === "passed" && policy.video !== "always") {
    await safe(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(writer.resolve(videoRelPath), { force: true });
    });
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
          outputDir: writer.resolve("videos/clips"),
          name: spec.name,
          tags: runtime.config?.clips?.tags ?? spec.artifacts?.clipTags ?? [],
          reencode: false,
        },
      );
      if (cutResult.ok && cutResult.clips && cutResult.clips.length > 0) {
        Object.assign(clips, await moveClipsIntoRunDir(runDir, cutResult));
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
    ...(videoPath ? { video: videoPath } : {}),
    ...(Object.keys(clips).length > 0 ? { clips } : {}),
  };

  const result: RunResult = {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    runDir,
    spec: {
      name: spec.name,
      path: specPath,
      ...(spec.contractHash ? { contractHash: spec.contractHash } : {}),
    },
    environment: env,
    backend: backendName as RunResult["backend"],
    coldStart,
    status,
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
  opts.listener?.onRunEnd?.(publicResult);

  // Auto-prune the artifact root per config retention policy. Best-effort —
  // a prune failure must never fail the run that just completed.
  const keepRuns = runtime.config?.retention?.keepRuns;
  if (keepRuns !== undefined) {
    await safe(() => pruneRuns(artifactRoot, { keepRuns }));
  }

  return publicResult;
}

/** Capture policies with sensible defaults. */
function mergeCapturePolicy(spec: Spec): {
  screenshots: "always" | "on-failure" | "never";
  snapshots: "always" | "on-failure" | "never";
  trace: "always" | "on-failure" | "never";
  video: "always" | "on-failure" | "never";
} {
  const c = spec.artifacts?.capture ?? {};
  return {
    screenshots: c.screenshots ?? "on-failure",
    snapshots: c.snapshots ?? "always",
    trace: c.trace ?? "on-failure",
    video: c.video ?? "never",
  };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
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
  runDir: string;
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
  const absolutePath = resolve(opts.runDir, relativePath);
  await ensureParentDir(absolutePath);

  const file = isAbsolute(target.file)
    ? target.file
    : resolve(opts.specDir, target.file);
  const input = resolveRuntimeFilePath(target.input, {
    artifacts: opts.artifacts,
    runDir: opts.runDir,
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
      runDir: opts.runDir,
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
  redactor: ReturnType<typeof createArtifactRedactor>;
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
    const absolutePath = opts.writer.resolve(relativePath);
    await Bun_writeFile(
      absolutePath,
      opts.redactor.text(JSON.stringify({ value }, null, 2) + "\n"),
      true,
    );
    return { ok: true, assign: target.assign, value };
  }

  return { ok: true, value };
}

async function ensureParentDir(absPath: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(absPath), { recursive: true });
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
    `  return {`,
    `    url: location.href,`,
    `    title: document.title,`,
    `    step: descriptor,`,
    `    stepError: ${JSON.stringify(stepError ?? "")},`,
    `    selectorCount,`,
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

function renderDiagnostics(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * writeFile that ensures parent dir exists. Named with Bun_ prefix to avoid
 * shadowing the global fs.writeFile import; this is just a small helper.
 */
async function Bun_writeFile(
  absPath: string,
  contents: string,
  createDir = false,
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  if (createDir) {
    await mkdir(dirname(absPath), { recursive: true });
  }
  await writeFile(absPath, contents);
}
