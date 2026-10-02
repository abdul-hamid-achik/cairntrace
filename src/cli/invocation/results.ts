import { isAbsolute as isAbsolutePath } from "node:path";
import { addEnospcHint } from "../../core/artifacts/retention";
import { UnknownEnvironmentError } from "../../core/config/runtimeContext";
import { ContractHashMismatchError } from "../../core/parser/parseSpec";
import { RunCancelledError, SpecRefusedError } from "../../core/runner/Runner";
import type { RunResult } from "../../core/schema/run.v1";
import type { Backend, ExitCode } from "../../core/schema/shared";
import { synthesizeRefusedResult } from "./policy";

export function synthesizeErroredResult(
  specPath: string,
  err: Error,
  extras: { labels?: Record<string, string> } = {},
  cwd: string = process.cwd(),
): RunResult {
  // runSpec's own policy guard (a spec the preflight could not evaluate, or
  // an opt-in variable that changed since): report it as refused, not errored.
  if (err instanceof SpecRefusedError) {
    return synthesizeRefusedResult(
      {
        specPath,
        specName:
          err.spec?.name ??
          specPath
            .split("/")
            .pop()
            ?.replace(/\.ya?ml$/, "") ??
          specPath,
        refusal: err.refusal,
        outcomeIds: err.spec?.outcomeIds ?? [],
      },
      extras,
      cwd,
    );
  }
  // Cancelled while runSpec resolved/parsed the spec (no run dir yet).
  if (err instanceof RunCancelledError) {
    return synthesizeCancelledResult(specPath, extras, cwd);
  }
  const now = new Date().toISOString();
  const runId = `errored_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const absoluteSpecPath = isAbsolutePath(specPath)
    ? specPath
    : `${cwd}/${specPath}`;
  const message = addEnospcHint(err.message);
  const contractChanged = err instanceof ContractHashMismatchError;
  const unknownEnvironment = err instanceof UnknownEnvironmentError;
  const exitCode: ExitCode = contractChanged
    ? 6
    : unknownEnvironment
      ? err.exitCode
      : 2;
  const labels =
    extras.labels && Object.keys(extras.labels).length > 0
      ? extras.labels
      : undefined;
  return {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    // runDir is the absolute anchor for all relative artifact paths in
    // RunResult; use a synthetic dir under the artifact root so consumers
    // joining paths don't crash. The dir itself is never written, and
    // `synthetic: true` says so (see adoptStartedRun for the exception).
    runDir: `${cwd}/.cairntrace/errored/${runId}`,
    synthetic: true,
    spec: {
      name:
        specPath
          .split("/")
          .pop()
          ?.replace(/\.ya?ml$/, "") ?? "errored",
      path: absoluteSpecPath,
    },
    environment: unknownEnvironment ? err.envName : "local",
    backend: "agent-browser",
    coldStart: false,
    ...(labels ? { labels } : {}),
    status: "errored",
    summary: `errored at step 'parse': ${message}`,
    failure: { step: "parse", message },
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    outcomes: [],
    steps: [
      {
        id: "parse",
        status: "failed",
        durationMs: 0,
        error: message,
      },
    ],
    artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
    exitCode,
    ...(contractChanged
      ? {
          nextActions: [
            {
              command: `cairn spec verify ${JSON.stringify(absoluteSpecPath)} --stamp --json`,
              reason:
                "the behavior contract changed since it was sealed; review the intent/outcomes diff before resealing",
              safeToAutoRun: false,
            },
          ],
        }
      : {}),
  };
}

/**
 * A planned spec that never started because the invocation stopped in its
 * lifecycle phase (a `cairn services up` lock refusal, a services or
 * webServer boot failure). Same shape the MCP server synthesizes for an
 * invocation error: no steps, `failure.phase: "invocation"`, and the
 * invocation's exit code. `message` must already be redacted.
 */
export function synthesizeInvocationErroredResult(
  specPath: string,
  message: string,
  exitCode: ExitCode,
  extras: {
    labels?: Record<string, string>;
    environment?: string;
    backend?: Backend;
  } = {},
  cwd: string = process.cwd(),
): RunResult {
  const base = synthesizeErroredResult(
    specPath,
    new Error(message),
    extras.labels ? { labels: extras.labels } : {},
    cwd,
  );
  const detail = base.failure?.message ?? message;
  return {
    ...base,
    ...(extras.environment ? { environment: extras.environment } : {}),
    ...(extras.backend ? { backend: extras.backend } : {}),
    summary: `errored before the spec ran: ${detail}`,
    failure: { phase: "invocation", message: detail },
    steps: [],
    exitCode,
  };
}

/** A planned spec that never started because the invocation was cancelled. */
export function synthesizeCancelledResult(
  specPath: string,
  extras: { labels?: Record<string, string> } = {},
  cwd: string = process.cwd(),
): RunResult {
  const message = "invocation cancelled before this spec started";
  const base = synthesizeErroredResult(
    specPath,
    new Error(message),
    extras,
    cwd,
  );
  return {
    ...base,
    summary: `cancelled before start: ${message}`,
    failure: { phase: "cancelled", message },
    steps: [],
  };
}

/**
 * A synthesized result for a spec whose run had already started (runSpec
 * threw after `run.started`): point it at the real run directory instead of
 * the placeholder, and drop `synthetic` — that directory exists.
 */
export function adoptStartedRun(
  result: RunResult,
  startedRun: { runId: string; runDir: string } | undefined,
): RunResult {
  if (!startedRun || result.status === "refused") return result;
  const adopted: RunResult = {
    ...result,
    runId: startedRun.runId,
    runDir: startedRun.runDir,
  };
  delete adopted.synthetic;
  return adopted;
}
