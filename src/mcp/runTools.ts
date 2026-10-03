import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { z } from "zod";
import {
  INVOCATION_ID_PATTERN,
  INVOCATIONS_DIR,
  isPidAlive,
  readInvocationJournal,
} from "../core/artifacts/invocationJournal";
import type { ProgressListener } from "../core/runner/Runner";
import type { InvocationJournalFile } from "../core/schema/events.v1";
import {
  buildRunNextActions,
  RunResultSchema,
  type RunResult,
} from "../core/schema/run.v1";
import {
  BatchRunResultSchema,
  type BatchRunResult,
} from "../core/schema/runBatch.v1";
import {
  RunInvocationOptionsShape,
  RunInvocationStatusResultSchema,
  RunLogsCursorSchema,
  RunLogsResultSchema,
  type RunInvocationOptions,
  type RunInvocationState,
  type RunInvocationStatusResult,
  type RunLogsResult,
} from "../core/schema/runInvocation.v1";
import type {
  RunInvocationResult,
  SpecRunContext,
} from "../cli/invocation/executeRunInvocation";
import {
  invocationSettleState,
  isSafeRunRef,
  LogCursorError,
  readLogSlice,
  resolveInvocationDir,
  runSettleState,
  type SettleState,
} from "../cli/invocation/logTail";
import {
  invocationState,
  MAX_RUNNING_INVOCATIONS,
  RegistryFullError,
  type RegisteredInvocation,
  type RunInvocationRegistry,
} from "../cli/invocation/registry";
import { synthesizeErroredResult } from "../cli/invocation/results";
import { log } from "../cli/logger";
import { resolveArtifactRoot, resolveRunRef } from "../cli/runRefs";

/**
 * MCP run tools: `cairn_run` (the same engine as `cairn run`, synchronous or
 * background), `cairn_run_status`, `cairn_run_cancel` and `cairn_logs`.
 */

export const HOOKS_REFUSED_MESSAGE =
  "cairn_run before/after hooks run arbitrary shell commands; this server does not accept them. " +
  "Restart it as `cairn mcp --allow-hooks` (or with CAIRN_MCP_ALLOW_HOOKS=1) to allow hooks, " +
  "or drop `before`/`after` from the request.";

/** How long cairn_run_cancel waits for the graceful teardown by default. */
const CANCEL_WAIT_MS = 120_000;

/** Transport-only cairn_run inputs on top of RunInvocationOptions. */
const RUN_TRANSPORT_SHAPE = {
  specs: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      "Spec paths and/or directories (directories expand recursively, skipping actions/ and drafts: folders and files starting with _)",
    ),
  path: z
    .string()
    .min(1)
    .optional()
    .describe("One spec path (kept for compatibility; same as specs: [path])"),
  wait: z
    .boolean()
    .optional()
    .describe(
      "true (default): run to completion and return the RunResult / BatchRunResult. false: start in the background and return {invocationId, journalDir, status: running} at once; poll cairn_run_status / cairn_logs and stop it with cairn_run_cancel",
    ),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Cohort labels as an object (merged with `label` key=value entries)",
    ),
  since: z
    .string()
    .min(1)
    .optional()
    .describe("Alias of sinceCodemap (kept for compatibility)"),
} as const;

/** The full cairn_run input shape: every run option + transport keys. */
export const CAIRN_RUN_INPUT_SHAPE = {
  ...RUN_TRANSPORT_SHAPE,
  ...RunInvocationOptionsShape,
};

const CairnRunInputSchema = z.object(CAIRN_RUN_INPUT_SHAPE);
type CairnRunInput = z.infer<typeof CairnRunInputSchema>;

/** The run options of a cairn_run request (transport keys folded in). */
export function runOptionsFromMcpInput(input: CairnRunInput): {
  specs: string[];
  options: RunInvocationOptions;
} {
  const { specs, path, wait: _wait, labels, since, ...options } = input;
  const label = [
    ...(options.label ?? []),
    ...Object.entries(labels ?? {}).map(([key, value]) => `${key}=${value}`),
  ];
  return {
    specs: [...(specs ?? []), ...(path !== undefined ? [path] : [])],
    options: {
      ...options,
      ...(label.length > 0 ? { label } : {}),
      ...(since !== undefined && options.sinceCodemap === undefined
        ? { sinceCodemap: since }
        : {}),
    },
  };
}

function hasHooks(options: RunInvocationOptions): boolean {
  return [...(options.before ?? []), ...(options.after ?? [])].some(
    (command) => command.trim().length > 0,
  );
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Where a result's evidence lives, for the text answer. A refused spec, or one
 * that errored before its run started, has no run directory (`synthetic`):
 * its placeholder runDir is never shown, so agents do not try to open it.
 */
function resultLocation(r: RunResult): string {
  if (r.status === "refused") {
    return `refused in ${r.refusal?.env ?? r.environment}: ${
      r.refusal?.reason ?? r.failure?.message ?? "environment policy"
    } (no run directory)`;
  }
  if (r.synthetic) {
    return `${r.failure?.message ?? r.status} (no run directory)`;
  }
  return r.runDir;
}

function summarizeRun(r: RunResult): string {
  const passed = r.outcomes.filter((o) => o.status === "passed").length;
  return [
    `${r.status.toUpperCase()}: ${r.spec.name} (${passed}/${r.outcomes.length} outcomes, ${r.durationMs}ms)`,
    ...r.outcomes.map(
      (o) =>
        `  ${
          o.status === "passed" ? "✓" : o.status === "failed" ? "✗" : "·"
        } ${o.id}${o.evidence ? ` (${o.evidence})` : ""}`,
    ),
    r.status === "refused" || r.synthetic
      ? resultLocation(r)
      : `Run dir: ${r.runDir}`,
  ].join("\n");
}

function summarizeBatch(b: BatchRunResult): string {
  const refused = b.summary.refused ?? 0;
  return [
    `${b.summary.passed}/${b.summary.total} passed, ${b.summary.failed} failed, ${b.summary.errored} errored${
      refused > 0 ? `, ${refused} refused` : ""
    } (exit ${b.exitCode})`,
    ...b.results.map(
      (r) =>
        `  ${r.status.toUpperCase()} ${r.spec.name} → ${resultLocation(r)}`,
    ),
  ].join("\n");
}

/** RunResult + nextActions (kept when the result already carries some). */
function withNextActions(result: RunResult): RunResult {
  return {
    ...result,
    nextActions: result.nextActions ?? buildRunNextActions(result),
  };
}

function invocationLine(result: RunInvocationResult): string {
  return `invocation ${result.invocationId}${
    result.journalDir ? ` (journal ${result.journalDir})` : ""
  }`;
}

/** The structured cairn_run answer for a settled invocation. */
export function runToolResult(
  result: RunInvocationResult,
  requested: { specs: string[]; path?: string; labels: string[] },
): ToolResult {
  const document = result.document;
  const isError = result.exitCode !== 0;
  if (document && "$schema" in document) {
    if (document.$schema === "urn:cairntrace.dev:run:v1") {
      const run = withNextActions(document as RunResult);
      return {
        content: [
          {
            type: "text",
            text: `${
              result.error ? `${result.error}\n` : ""
            }${summarizeRun(run)}\n${invocationLine(result)}`,
          },
        ],
        structuredContent: RunResultSchema.parse(run) as unknown as Record<
          string,
          unknown
        >,
        isError,
      };
    }
    if (document.$schema === "urn:cairntrace.dev:run-batch:v1") {
      const batch = document as BatchRunResult;
      const withActions: BatchRunResult = {
        ...batch,
        results: batch.results.map(withNextActions),
      };
      return {
        content: [
          {
            type: "text",
            text: `${
              result.error ? `${result.error}\n` : ""
            }${summarizeBatch(withActions)}\n${invocationLine(result)}`,
          },
        ],
        structuredContent: BatchRunResultSchema.parse(
          withActions,
        ) as unknown as Record<string, unknown>,
        isError,
      };
    }
    // SelectionResult v1.
    return {
      content: [
        {
          type: "text",
          text: `selection: ${(document as { selected: unknown[] }).selected.length} selected, ${(document as { skipped: unknown[] }).skipped.length} skipped`,
        },
      ],
      structuredContent: document as unknown as Record<string, unknown>,
      isError: false,
    };
  }
  if (result.kind === "skipped" && document) {
    return {
      content: [
        {
          type: "text",
          text: `skipped: ${requested.specs.join(", ")} not in blast radius of ${
            (document as { since: string }).since
          } (sinceCodemap)`,
        },
      ],
      structuredContent: {
        ...(document as unknown as Record<string, unknown>),
        ...(requested.path !== undefined ? { path: requested.path } : {}),
      },
      isError: false,
    };
  }
  if (result.kind === "services-dry-run" && document) {
    const plan = (document as { plan: string[] }).plan;
    return {
      content: [
        {
          type: "text",
          text: plan.length > 0 ? plan.join("\n") : "no services block applies",
        },
      ],
      structuredContent: document as unknown as Record<string, unknown>,
      isError: false,
    };
  }
  // An invocation that stopped before/around its specs without a document
  // (bad options, secrets, services/webServer boot, a fatal --before hook,
  // a crash): the same schema-valid errored RunResult/batch the CLI prints
  // for an unknown --env, carrying the invocation error.
  const message = result.error ?? "run errored";
  const labels = Object.fromEntries(
    requested.labels
      .map((pair) => [
        pair.slice(0, pair.indexOf("=")),
        pair.slice(pair.indexOf("=") + 1),
      ])
      .filter(([key]) => key),
  );
  const errored = requested.specs.map((spec) => ({
    ...synthesizeErroredResult(spec, new Error(message), { labels }),
    summary: `errored before the spec ran: ${message}`,
    failure: { phase: "invocation", message },
    steps: [],
    exitCode: result.exitCode,
  }));
  const text = `${message}\n${invocationLine(result)}`;
  if (errored.length === 1) {
    return {
      content: [{ type: "text", text }],
      structuredContent: RunResultSchema.parse(
        withNextActions(errored[0]!),
      ) as unknown as Record<string, unknown>,
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: BatchRunResultSchema.parse({
      $schema: "urn:cairntrace.dev:run-batch:v1",
      version: "1",
      parallel: 1,
      totalDurationMs: 0,
      summary: {
        total: errored.length,
        passed: 0,
        failed: 0,
        errored: errored.length,
      },
      results: errored.map(withNextActions),
      exitCode: result.exitCode,
    }) as unknown as Record<string, unknown>,
    isError: true,
  };
}

/** MCP progress notifications for run/step/outcome milestones. */
function progressNotifier(
  send: (params: { progress: number; message: string }) => void,
): (ctx: SpecRunContext) => ProgressListener {
  let progress = 0;
  const notify = (message: string): void => {
    progress += 1;
    send({ progress, message });
  };
  return (ctx) => {
    const at = `[${ctx.planIndex}/${ctx.plannedTotal}]`;
    return {
      onRunStart(spec, runId) {
        notify(`${at} ${spec.name} started (${runId})`);
      },
      onStepFinish(_idx, stepId, status, durationMs) {
        notify(`${at} step ${stepId} ${status} (${durationMs}ms)`);
      },
      onOutcomeFinish(outcome, evaluation) {
        notify(
          `${at} outcome ${outcome.id} ${
            evaluation.skipped
              ? "skipped"
              : evaluation.passed
                ? "passed"
                : "failed"
          }`,
        );
      },
      onRunEnd(result) {
        notify(`${at} ${result.spec.name} ${result.status}`);
      },
    };
  };
}

/** Map an on-disk journal to a status (a dead writer means interrupted). */
function journalState(journal: InvocationJournalFile): RunInvocationState {
  if (journal.status !== "running") return journal.status;
  return isPidAlive(journal.pid) ? "running" : "aborted";
}

/** Status of an invocation: this server's registry merged with its journal. */
async function statusOf(
  invocationId: string,
  entry: RegisteredInvocation | undefined,
  journalDir: string | undefined,
  artifactRoot: string | undefined,
): Promise<RunInvocationStatusResult> {
  let journal = journalDir
    ? await readInvocationJournal(journalDir)
    : undefined;
  const result = entry?.result;
  // The engine writes the final journal state before it settles, but a read
  // can still land in between (or before the file is visible): once this
  // server knows the invocation settled, give the journal a moment to show
  // the same terminal state and summary instead of returning a partial view.
  const settledHere = result !== undefined || entry?.failure !== undefined;
  if (journalDir && settledHere) {
    for (
      let attempt = 0;
      attempt < 20 &&
      (!journal || journal.status === "running" || !journal.summary);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      journal = await readInvocationJournal(journalDir);
    }
  }
  const status: RunInvocationState = entry
    ? invocationState(entry)
    : journal
      ? journalState(journal)
      : "running";
  const document =
    result?.document && typeof result.document === "object"
      ? (result.document as unknown as Record<string, unknown>)
      : undefined;
  return RunInvocationStatusResultSchema.parse({
    $schema: "urn:cairntrace.dev:run-invocation:v1",
    version: "1",
    invocationId,
    status,
    owned: entry !== undefined,
    ...((entry?.origin ?? journal?.origin)
      ? { origin: entry?.origin ?? journal?.origin }
      : {}),
    ...((entry?.client ?? journal?.client)
      ? { client: entry?.client ?? journal?.client }
      : {}),
    ...(artifactRoot ? { artifactRoot } : {}),
    ...(journalDir
      ? {
          journalDir: `${INVOCATIONS_DIR}/${invocationId}`,
          journalDirAbsolute: journalDir,
        }
      : {}),
    ...(journal?.startedAt
      ? { startedAt: journal.startedAt }
      : entry
        ? { startedAt: entry.startedAt }
        : {}),
    ...(journal?.endedAt ? { endedAt: journal.endedAt } : {}),
    ...(journal ? { planned: journal.planned.length } : {}),
    ...(journal?.current ? { current: journal.current } : {}),
    runs: journal?.runs ?? [],
    ...(journal?.summary ? { summary: journal.summary } : {}),
    ...(entry?.cancelRequested ? { cancelRequested: true } : {}),
    ...(result ? { kind: result.kind, exitCode: result.exitCode } : {}),
    ...(result?.error
      ? { error: result.error }
      : entry?.failure
        ? { error: entry.failure }
        : {}),
    ...(document ? { document } : {}),
  });
}

function statusText(status: RunInvocationStatusResult): string {
  const runs = status.runs
    .map(
      (run) =>
        `  ${run.index}. ${run.spec} ${run.status ?? "?"} ${
          run.synthetic ? "(no run directory)" : run.runDir
        }`,
    )
    .join("\n");
  const summary = status.summary;
  return [
    `invocation ${status.invocationId}: ${status.status}${
      status.exitCode !== undefined ? ` (exit ${status.exitCode})` : ""
    }`,
    ...(status.journalDirAbsolute
      ? [`journal: ${status.journalDirAbsolute}`]
      : []),
    ...(status.planned !== undefined
      ? [`runs: ${status.runs.length}/${status.planned} started`]
      : []),
    ...(runs ? [runs] : []),
    ...(summary
      ? [
          `summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored${
            summary.refused
              ? `, ${summary.refused} refused (no run directory)`
              : ""
          } (exit ${summary.exitCode})`,
        ]
      : []),
    ...(status.error ? [`error: ${status.error}`] : []),
  ].join("\n");
}

const InvocationIdInput = z
  .string()
  .regex(
    INVOCATION_ID_PATTERN,
    "invocationId must be an id returned by cairn_run (<iso>_<pid>_<hex6>)",
  )
  .describe("Invocation id returned by cairn_run");

export function registerRunTools(
  server: McpServer,
  ctx: {
    allowHooks: boolean;
    /** Start config services / run their teardown (`cairn mcp --allow-services`). */
    allowServices: boolean;
    registry: RunInvocationRegistry;
  },
): void {
  const { registry } = ctx;
  const clientName = (): string | undefined => {
    const info = server.server.getClientVersion();
    return info ? `${info.name}/${info.version}` : undefined;
  };

  server.registerTool(
    "cairn_run",
    {
      title: "Run behavioral specs",
      description:
        "Run specs through the same engine as `cairn run`: config + browser.* (testIdAttribute, click tuning), vars, scoped secrets, services/webServer lifecycle, before/after hooks, repeat/matrix, post-run stash/investigate/annotate, retention adapters, stamp-if-green, JUnit and the invocation journal. " +
        "Every `cairn run` flag is an input (camelCase: noServices, stampIfGreen, sinceCodemap, …). Like `cairn run`, it boots the config webServer and runs its teardown unless noWebServer is set. Config services (docker/seed/tmux) start, and their teardown runs, only on a server started as `cairn mcp --allow-services` (or CAIRN_MCP_ALLOW_SERVICES=1); otherwise a run whose config would start them fails with exit 4 before anything starts: pass noServices: true when the stack is already up, or reuseServices: true after `cairn services up`. " +
        "wait:true (default) returns the `cairn run --format json` document (RunResult, BatchRunResult for several specs, SelectionResult for selectOnly) plus nextActions; repeat/matrix return ONE BatchRunResult over every iteration (the CLI prints one document per iteration). isError when the exit code is not 0; a failed stamp-if-green or JUnit write is named in the text. Cancelling or timing out the request cancels the run: use wait:false for long suites. " +
        `wait:false starts it in the background and returns {invocationId, journalDir, status}; poll cairn_run_status / cairn_logs, stop it with cairn_run_cancel. A server runs at most ${MAX_RUNNING_INVOCATIONS} invocations at once. before/after hooks need \`cairn mcp --allow-hooks\`. ` +
        "Invocations that boot services or a webServer from the same config file run one at a time (whatever their env); one with neither (noServices + noWebServer, or a config without them) never waits.",
      inputSchema: CAIRN_RUN_INPUT_SHAPE,
    },
    async (input, extra) => {
      const { specs, options } = runOptionsFromMcpInput(input);
      if (specs.length === 0) {
        return textError(
          "cairn_run needs `specs` (spec paths or directories) or `path`",
        );
      }
      if (hasHooks(options) && !ctx.allowHooks) {
        return textError(HOOKS_REFUSED_MESSAGE);
      }
      const wait = input.wait ?? true;
      // oxlint-disable-next-line no-underscore-dangle -- MCP request metadata
      const progressToken = extra._meta?.progressToken;
      const client = clientName();
      let entry: RegisteredInvocation;
      try {
        entry = registry.start(
          { specs, options, cwd: process.cwd() },
          {
            origin: "mcp",
            ...(client ? { client } : {}),
            logger: log,
            allowServicesBoot: ctx.allowServices,
            ...(wait && progressToken !== undefined
              ? {
                  progressListener: progressNotifier(
                    ({ progress, message }) => {
                      void extra
                        .sendNotification({
                          method: "notifications/progress",
                          params: { progressToken, progress, message },
                        })
                        .catch(() => undefined);
                    },
                  ),
                }
              : {}),
          },
        );
      } catch (error) {
        if (error instanceof RegistryFullError) {
          return textError(`cairn_run refused: ${error.message}`);
        }
        throw error;
      }

      if (!wait) {
        await Promise.race([entry.handle.started, entry.settled]);
        const status = await statusOf(
          entry.id,
          entry,
          entry.journalDir,
          entry.artifactRoot,
        );
        return {
          content: [
            {
              type: "text",
              text: `${statusText(status)}\npoll: cairn_run_status {invocationId: "${entry.id}"} · cairn_logs {invocationId: "${entry.id}"} · cancel: cairn_run_cancel`,
            },
          ],
          structuredContent: status as unknown as Record<string, unknown>,
        };
      }

      // A cancelled MCP request cancels the run (graceful teardown).
      const onCancel = (): void => {
        registry.cancel(entry.id);
      };
      extra.signal.addEventListener("abort", onCancel, { once: true });
      try {
        await entry.settled;
      } finally {
        extra.signal.removeEventListener("abort", onCancel);
      }
      if (!entry.result) {
        return textError(
          `cairn_run failed: ${entry.failure ?? "unknown error"} (invocation ${entry.id})`,
        );
      }
      return runToolResult(entry.result, {
        specs,
        ...(input.path !== undefined ? { path: input.path } : {}),
        labels: options.label ?? [],
      });
    },
  );

  server.registerTool(
    "cairn_run_status",
    {
      title: "Status of a run invocation",
      description:
        "Status of a cairn_run invocation (or any `cairn run` journal under the artifact root): running / cancelling / passed / failed / errored / aborted, planned vs started runs with their run dirs and statuses, the current run, the final summary, and — once settled and started by this server — the result document.",
      inputSchema: {
        invocationId: InvocationIdInput,
        artifactRoot: z
          .string()
          .optional()
          .describe(
            "Artifact root holding _invocations/ (for invocations this server did not start)",
          ),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml"),
      },
    },
    async ({ invocationId, artifactRoot, config }) => {
      const entry = registry.get(invocationId);
      let journalDir = entry?.journalDir;
      let root = entry?.artifactRoot;
      if (entry && !journalDir) {
        // The registry learns the journal dir only from the settled result;
        // resolve it from the artifact root so a just-settled (or still
        // running) invocation reports its journal, summary and runs.
        root ??= await resolveArtifactRoot({
          ...(artifactRoot !== undefined ? { artifactRoot } : {}),
          ...(config !== undefined ? { config } : {}),
        });
        journalDir = await resolveInvocationDir(root, invocationId);
      }
      if (!entry) {
        root = await resolveArtifactRoot({
          ...(artifactRoot !== undefined ? { artifactRoot } : {}),
          ...(config !== undefined ? { config } : {}),
        });
        journalDir = await resolveInvocationDir(root, invocationId);
        if (!journalDir) {
          return textError(
            `no invocation ${invocationId} in this server or under ${root}/${INVOCATIONS_DIR}`,
          );
        }
      }
      const status = await statusOf(invocationId, entry, journalDir, root);
      return {
        content: [{ type: "text", text: statusText(status) }],
        structuredContent: status as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cairn_run_cancel",
    {
      title: "Cancel a run invocation",
      description:
        "Cancel a cairn_run invocation this server started: browser sessions are killed, a running before/after hook and a booting webServer are killed, specs that have not started are skipped, the webServer and services are torn down and the journal is marked aborted. " +
        "Inside the spec that is running, the process tree of a running services boot command (docker, seed, readiness check, healthcheck), precondition, node transform or node script verifier is killed, services readiness waits stop, and its remaining preconditions, steps and outcomes are reported skipped; that spec's run directory is still written (status errored, failure.phase cancelled). Only the teardown commands, and an in-flight file/xlsx outcome check (its result ignored), keep running to completion. Idempotent. wait (default true) returns once the teardown finished, or after 120s with status cancelling.",
      inputSchema: {
        invocationId: InvocationIdInput,
        wait: z
          .boolean()
          .optional()
          .describe("Wait for the graceful teardown (default true)"),
      },
    },
    async ({ invocationId, wait }) => {
      const entry = registry.cancel(invocationId);
      if (!entry) {
        return textError(
          `invocation ${invocationId} was not started by this MCP server; cancel it where it runs (Ctrl-C for \`cairn run\`)`,
        );
      }
      if (wait ?? true) {
        await Promise.race([
          entry.settled,
          new Promise((resolveWait) => {
            const timer = setTimeout(resolveWait, CANCEL_WAIT_MS);
            timer.unref?.();
          }),
        ]);
      }
      const status = await statusOf(
        invocationId,
        entry,
        entry.journalDir,
        entry.artifactRoot,
      );
      return {
        content: [{ type: "text", text: statusText(status) }],
        structuredContent: status as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cairn_logs",
    {
      title: "Read run / invocation logs incrementally",
      description:
        "Read a slice of a run's or an invocation's live logs; pass nextCursor back as cursor to continue (poll until settled and eof). " +
        "Runs: log events (events.ndjson, default) | run (run.log) | precondition | outcome | <file under logs/>. " +
        "Invocations: events | narration | services | hook | <file under logs/>. " +
        "precondition, outcome, services and hook span several files that grow independently: each file keeps its own position in nextCursor and its new bytes come after a `==> <file> <==` header; single-file logs also accept nextOffset back as offset. " +
        "Pass invocationId for the invocation journal; add run (an id, latest, previous, or current = the invocation's current run) to read one of its runs. Files are redacted on disk.",
      inputSchema: {
        run: z
          .string()
          .optional()
          .describe(
            "Run id, latest, previous (or current with invocationId); default latest when no invocationId",
          ),
        invocationId: InvocationIdInput.optional(),
        log: z
          .string()
          .min(1)
          .optional()
          .describe(
            "events (default) | run | precondition | outcome | narration | services | hook | <file>",
          ),
        cursor: RunLogsCursorSchema.optional().describe(
          "nextCursor of the previous slice (per-file byte positions); continues every log, and is required to continue precondition / outcome / services / hook",
        ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Byte offset to read a single-file log from (default 0); ignored when cursor is set",
          ),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(1_048_576)
          .optional()
          .describe("Slice size in bytes (default 65536, max 1048576)"),
        artifactRoot: z
          .string()
          .optional()
          .describe("Artifact root (default: config artifactRoot)"),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml"),
      },
    },
    async ({
      run,
      invocationId,
      log: selection,
      cursor,
      offset,
      maxBytes,
      artifactRoot,
      config,
    }) => {
      const rootFor = async (): Promise<string> =>
        resolveArtifactRoot({
          ...(artifactRoot !== undefined ? { artifactRoot } : {}),
          ...(config !== undefined ? { config } : {}),
        });
      const logName = selection ?? "events";
      let target: "run" | "invocation";
      let id: string;
      let dir: string;
      let state: SettleState;
      if (invocationId !== undefined) {
        const entry = registry.get(invocationId);
        const root = entry?.artifactRoot ?? (await rootFor());
        const journalDir =
          entry?.journalDir ?? (await resolveInvocationDir(root, invocationId));
        if (!journalDir) {
          return textError(
            entry
              ? `invocation ${invocationId} has not written its journal yet (still resolving secrets/config); retry shortly`
              : `no invocation ${invocationId} under ${root}/${INVOCATIONS_DIR}`,
          );
        }
        if (run === undefined) {
          target = "invocation";
          id = invocationId;
          dir = journalDir;
          state = entry?.result
            ? "settled"
            : await invocationSettleState(journalDir);
        } else {
          const journal = await readInvocationJournal(journalDir);
          let runId: string | undefined;
          let runDir: string | undefined;
          if (run === "current") {
            runId = journal?.current?.runId;
            if (!runId) {
              return textError(
                `invocation ${invocationId} has no current run yet (services or --before hooks may still be running); read its narration log instead`,
              );
            }
            runDir =
              journal?.runs.find((entryRun) => entryRun.runId === runId)
                ?.runDir ?? join(root, runId);
          } else {
            if (!isSafeRunRef(run))
              return textError(`invalid run reference "${run}"`);
            runDir = await resolveRunRef(run, root).catch(() => undefined);
            if (!runDir) return textError(`no run "${run}" under ${root}`);
            runId = runDir.split("/").pop() ?? run;
          }
          target = "run";
          id = runId;
          dir = runDir;
          state = await runSettleState(runDir);
        }
      } else {
        const ref = run ?? "latest";
        if (!isSafeRunRef(ref) || ref === "current") {
          return textError(
            ref === "current"
              ? "run: current needs invocationId"
              : `invalid run reference "${ref}"`,
          );
        }
        const root = await rootFor();
        const runDir = await resolveRunRef(ref, root).catch(() => undefined);
        if (!runDir) return textError(`no run "${ref}" under ${root}`);
        target = "run";
        id = runDir.split("/").pop() ?? ref;
        dir = runDir;
        state = await runSettleState(runDir);
      }
      if (
        (target === "run" &&
          ["narration", "services", "hook"].includes(logName)) ||
        (target === "invocation" &&
          ["run", "precondition", "outcome"].includes(logName))
      ) {
        return textError(
          target === "run"
            ? `log "${logName}" belongs to an invocation: pass invocationId without run`
            : `log "${logName}" belongs to a run: add run (an id, latest or current)`,
        );
      }
      let slice: RunLogsResult;
      try {
        slice = await readLogSlice({
          target,
          id,
          dir,
          log: logName,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
          state,
        });
      } catch (error) {
        if (error instanceof LogCursorError) return textError(error.message);
        throw error;
      }
      const parsed = RunLogsResultSchema.parse(slice);
      return {
        content: [
          {
            type: "text",
            text: `${parsed.text}${
              parsed.text.endsWith("\n") || parsed.text === "" ? "" : "\n"
            }[${parsed.target} ${parsed.id} ${parsed.log}: bytes ${parsed.offset}-${parsed.nextOffset} of ${parsed.size}${
              parsed.eof ? ", eof" : ""
            }, ${parsed.state}]`,
          },
        ],
        structuredContent: parsed as unknown as Record<string, unknown>,
      };
    },
  );
}
