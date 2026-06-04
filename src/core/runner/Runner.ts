import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ArtifactRef,
  BrowserBackend,
  ResolvedElement,
} from "../../adapters/browserBackend";
import { ArtifactWriter } from "../artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../artifacts/redaction";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { resolveSpecRuntimeContext } from "../config/runtimeContext";
import { parseSpec } from "../parser/parseSpec";
import { evaluateWhen } from "./conditions";
import type { ExitCode } from "../schema/shared";
import {
  openPath,
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
  resolveArtifactPlaceholders,
  resolveFixtureMap,
  resolveRuntimeFilePath,
} from "./runtimePlaceholders";
import { generateRunId } from "./runId";
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
  const runtime = await resolveSpecRuntimeContext(opts.specPath, {
    ...(opts.environmentOverride !== undefined
      ? { envOverride: opts.environmentOverride }
      : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
  });
  const {
    spec,
    resolved,
    path: specPath,
  } = await parseSpec(opts.specPath, {
    ...(opts.env ? { env: opts.env } : {}),
    vars: runtime.vars,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
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
  const writer = new ArtifactWriter(runDir, redactor);
  await writer.ensureDirs();
  await writer.writeResolvedSpec(resolved);

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

  // Start trace recording. Trace artifacts are best-effort: backends without
  // trace support no-op, and a failed start is swallowed.
  await safe(async () => opts.backend.startTrace?.());

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
  const namedArtifacts: Record<string, ArtifactRef> = {};
  const diagnostics: string[] = [];

  const policy = mergeCapturePolicy(spec);

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
    let stepToRun = step;
    let pendingDownload:
      | {
          assign: string;
          relativePath: string;
          absolutePath: string;
        }
      | undefined;
    if ("download" in step) {
      const relativePath = downloadRelativePath(step.download.saveAs);
      const absolutePath = writer.resolve(relativePath);
      pendingDownload = {
        assign: step.download.assign ?? artifactNameFromPath(relativePath),
        relativePath,
        absolutePath,
      };
      await ensureParentDir(absolutePath);
      stepToRun = {
        ...step,
        download: { ...step.download, saveAs: absolutePath },
      };
    } else if ("upload" in step) {
      stepToRun = {
        ...step,
        upload: {
          ...step.upload,
          path: resolveUploadPath(step.upload.path, runDir, namedArtifacts),
        },
      };
    }

    let stepStatus: StepResult["status"] = "passed";
    let stepError: string | undefined;
    let stepResolved: ResolvedElement | undefined;
    try {
      if ("transform" in step) {
        const transformed = await runTransformStep({
          step,
          runDir,
          specDir: dirname(specPath),
          artifacts: namedArtifacts,
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
      stepError = (e as Error).message;
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
  const traceResult = await safe(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(writer.resolve("traces"), { recursive: true });
    return opts.backend.stopTrace?.(writer.resolve(traceRelPath));
  });
  if (traceResult?.ok) {
    tracePath = traceRelPath;
  }

  // Evaluate outcomes.
  const ctx: VerifierContext = {
    lastSuccessfulStep: lastSuccessfulStep?.id,
    latestScreenshot,
    latestSnapshot,
    latestDiagnostics,
    ...(tracePath ? { trace: tracePath } : {}),
    runDir,
    specDir: dirname(specPath),
    artifacts: namedArtifacts,
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
    const evidenceRel = `outcomes/${outcome.id}.md`;
    await writer.writeOutcomeEvidence({
      outcomeId: outcome.id,
      status: evaluation.passed ? "passed" : "failed",
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
        ...(tracePath ? { trace: tracePath } : {}),
      },
      ...(evaluation.raw !== undefined ? { raw: evaluation.raw } : {}),
      whyThisMatters: outcome.description,
    });
    outcomeResults.push({
      id: outcome.id,
      status: evaluation.passed ? "passed" : "failed",
      evidence: evidenceRel,
      ...(evaluation.raw !== undefined
        ? { evidenceRaw: `outcomes/${outcome.id}.raw.json` }
        : {}),
    });
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: evaluation.passed ? "outcome.passed" : "outcome.failed",
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

  const artifacts: RunArtifacts = {
    agentContext: "agent_context.md",
    events: "events.ndjson",
    console: "console/errors.ndjson",
    network: "network/failed_requests.ndjson",
    ...(latestScreenshot ? { screenshots: [latestScreenshot] } : {}),
    ...(latestSnapshot ? { snapshots: [latestSnapshot] } : {}),
    ...(Object.keys(downloads).length > 0 ? { downloads } : {}),
    ...(Object.keys(transforms).length > 0 ? { transforms } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(tracePath ? { trace: tracePath } : {}),
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

  return publicResult;
}

/** Capture policies with sensible defaults. */
function mergeCapturePolicy(spec: Spec): {
  screenshots: "always" | "on-failure" | "never";
  snapshots: "always" | "on-failure" | "never";
} {
  const c = spec.artifacts?.capture ?? {};
  return {
    screenshots: c.screenshots ?? "on-failure",
    snapshots: c.snapshots ?? "always",
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

async function runTransformStep(opts: {
  step: TransformStep;
  runDir: string;
  specDir: string;
  artifacts: Record<string, ArtifactRef>;
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
  if ("wait" in step) return { kind: "wait", condition: step.wait };
  if ("press" in step) return { kind: "press", key: step.press };
  if ("scroll" in step) return { kind: "scroll", scroll: step.scroll };
  if ("snapshot" in step) return { kind: "snapshot" };
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
  if ("upload" in step) add(locatorNeedle(step.upload));
  if ("download" in step) add(locatorNeedle(step.download));
  if ("transform" in step) {
    add(step.transform.file);
    add(step.transform.input);
    add(step.transform.saveAs);
  }
  if ("wait" in step) {
    if ("text" in step.wait) add(step.wait.text);
    if ("notText" in step.wait) add(step.wait.notText);
  }
  if ("scroll" in step && "to" in step.scroll)
    add(locatorNeedle(step.scroll.to));
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
