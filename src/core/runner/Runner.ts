import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { ArtifactWriter } from "../artifacts/ArtifactWriter";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { loadConfig } from "../config/loader";
import { parseSpec } from "../parser/parseSpec";
import { evaluateWhen } from "./conditions";
import type { ExitCode } from "../schema/shared";
import type { Spec, Step } from "../schema/spec.v1";
import type {
  OutcomeResult,
  RunArtifacts,
  RunResult,
  StepResult,
} from "../schema/run.v1";
import type { Outcome } from "../schema/spec.v1";
import { evaluateOutcomes } from "./OutcomeEvaluator";
import { generateRunId } from "./runId";
import type { VerifierContext, VerifierEvaluation } from "./verifiers/types";

/**
 * Optional progress callbacks the runner invokes during execution.
 * The CLI attaches a TTY-aware listener for interactive `cairn run` output;
 * tests typically omit it.
 */
export interface ProgressListener {
  onRunStart?(spec: Spec, runId: string, runDir: string): void;
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
  // Load optional project config (cairntrace.config.yml).
  const loaded = await loadConfig(opts.specPath, opts.configPath);
  const config = loaded?.config;

  // Peek at the spec to read its environment field. Cheap — a single parse.
  // Then resolve the env name and re-parse with the right baseUrl + vars.
  const peek = await parseSpec(opts.specPath, {
    ...(opts.env ? { env: opts.env } : {}),
    vars: opts.vars ?? {},
  });
  const envName =
    opts.environmentOverride ??
    peek.spec.environment ??
    config?.defaultEnvironment ??
    "local";
  const envConfig = config?.environments[envName];
  const baseUrl = envConfig?.baseUrl;
  const configVars = envConfig?.vars ?? {};
  const mergedVars = { ...configVars, ...opts.vars };

  const {
    spec,
    resolved,
    path: specPath,
  } = await parseSpec(opts.specPath, {
    ...(opts.env ? { env: opts.env } : {}),
    vars: mergedVars,
    ...(baseUrl ? { baseUrl } : {}),
  });

  const env = envName;
  const backendName =
    opts.backend.name === "mock" ? "mock" : (spec.backend ?? "agent-browser");
  const artifactRoot =
    opts.artifactRoot ??
    config?.artifactRoot ??
    join(homedir(), ".cairntrace", "runs");
  const now = (opts.now ?? (() => new Date()))();
  const runId = generateRunId(spec.name, now);
  const runDir = join(artifactRoot, runId);

  const writer = new ArtifactWriter(runDir);
  await writer.ensureDirs();
  await writer.writeResolvedSpec(resolved);

  const startedAt = now.toISOString();
  await writer.appendEvent({
    ts: startedAt,
    type: "run.started",
    runId,
    spec: spec.name,
  });
  opts.listener?.onRunStart?.(spec, runId, runDir);

  // Reset backend's network/console logs before the run so we don't pick up
  // leakage from a previous spec on the same session.
  await safe(() => opts.backend.clearNetworkLog());
  await safe(() => opts.backend.clearConsole());

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

  const stepResults: StepResult[] = [];
  let lastSuccessfulStep: Step | undefined;
  let latestScreenshot: string | undefined;
  let latestSnapshot: string | undefined;
  let didError = false;

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

    let stepStatus: StepResult["status"] = "passed";
    let stepError: string | undefined;
    try {
      const r = await opts.backend.runStep(step);
      if (!r.ok) {
        stepStatus = "failed";
        stepError = r.stderr.trim() || `exit ${r.exitCode}`;
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
        await Bun_writeFile(writer.resolve(rel), snap.text);
        latestSnapshot = rel;
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
      if (shot && shot.ok) latestScreenshot = rel;
    }

    const durationMs = Date.now() - stepStart;
    stepResults.push({
      id: stepId,
      status: stepStatus,
      durationMs,
      ...(stepError ? { error: stepError } : {}),
    });

    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: stepStatus === "passed" ? "step.finished" : "step.failed",
      stepId,
      durationMs,
      ...(stepError ? { error: stepError } : {}),
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
    consoleEntries.map((e) => JSON.stringify(e)).join("\n") +
      (consoleEntries.length ? "\n" : ""),
    true,
  );
  await Bun_writeFile(
    writer.resolve("console/errors.ndjson"),
    consoleErrors.map((e) => JSON.stringify(e)).join("\n") +
      (consoleErrors.length ? "\n" : ""),
    true,
  );
  const failedNetwork = networkEntries.filter(
    (e) => e.status !== undefined && e.status >= 400,
  );
  await Bun_writeFile(
    writer.resolve("network/requests.ndjson"),
    networkEntries.map((e) => JSON.stringify(e)).join("\n") +
      (networkEntries.length ? "\n" : ""),
    true,
  );
  await Bun_writeFile(
    writer.resolve("network/failed_requests.ndjson"),
    failedNetwork.map((e) => JSON.stringify(e)).join("\n") +
      (failedNetwork.length ? "\n" : ""),
    true,
  );

  // Evaluate outcomes.
  const ctx: VerifierContext = {
    lastSuccessfulStep: lastSuccessfulStep?.id,
    latestScreenshot,
    latestSnapshot,
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
  };

  const result: RunResult = {
    $schema: "https://cairntrace.dev/schemas/run.v1.json",
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

  await writer.writeRun(result);
  await writer.writeOutcomesIndex(result);
  await writer.writeAgentContext(spec, result);

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
  opts.listener?.onRunEnd?.(result);

  return result;
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
    const { dirname } = await import("node:path");
    await mkdir(dirname(absPath), { recursive: true });
  }
  await writeFile(absPath, contents);
}
