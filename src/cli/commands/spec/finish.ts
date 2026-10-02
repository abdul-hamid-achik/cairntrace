import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SpecFinishResultSchema,
  type FinishStatus,
  type SpecFinishResult,
} from "../../../core/authoring/authoring.v1";
import { draftsDirFor, isDraftSpec } from "../../../core/authoring/config";
import { lintSpecs, type LintFinding } from "../../../core/authoring/lint";
import {
  contentHash,
  isSyntheticBackend,
  writeFinishReceipt,
} from "../../../core/authoring/promote";
import { resolveSpecRuntimeContext } from "../../../core/config/runtimeContext";
import { readServicesLock } from "../../../core/runner/services";
import type { RunResult } from "../../../core/schema/run.v1";
import type { RunInvocationOptions } from "../../../core/schema/runInvocation.v1";
import type { BackendChoice } from "../../backendFactory";
import { trackAbortReporter } from "../../cleanup";
import { emit, resolveFormat } from "../../format";
import {
  startRunInvocation,
  type RunInvocationRequest,
  type RunInvocationResult,
} from "../../invocation/executeRunInvocation";
import { parseVarFlags } from "../../invocation/options";
import { log } from "../../logger";

/**
 * `cairn spec finish <spec>` (A7): the one call that says whether an
 * authored spec is done — lint (errors stop here), a cold-start run through
 * the same engine as `cairn run` (config, services, secrets, hooks-free),
 * stamp the contract hash when green, and summarize the run's
 * agent_context.md. A green finish leaves a receipt (under the artifact
 * root) that `cairn spec promote` checks against the file's content.
 */

export interface FinishSpecOptions {
  env?: string;
  config?: string;
  var?: string[];
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  /** agent-browser provider / iOS device (as `cairn run`). */
  provider?: string;
  device?: string;
  /** Run artifact root (finish receipts live under it too). */
  artifactRoot?: string;
  /**
   * Run against services a `cairn services up` lock owns. Default: yes
   * when the config's lock is held for this environment.
   */
  reuseServices?: boolean;
  noServices?: boolean;
  /** Skip the config webServer lifecycle (a dev server you already run). */
  noWebServer?: boolean;
  cwd?: string;
}

/** Runs one invocation (CLI: in-process engine; MCP: the server registry). */
export type FinishRunner = (
  request: RunInvocationRequest,
) => Promise<RunInvocationResult>;

const CONTEXT_SECTIONS = [
  "## Outcome results",
  "## Failure evidence",
  "## Suggested next steps",
];
const MAX_CONTEXT = 4_000;

/** The parts of agent_context.md an agent needs to decide what to do. */
export function contextSummary(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let keep = false;
  for (const line of lines) {
    if (line.startsWith("## ")) keep = CONTEXT_SECTIONS.includes(line.trim());
    if (keep) out.push(line);
  }
  const text = out.join("\n").trim();
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n…` : text;
}

async function readContractHash(path: string): Promise<string | undefined> {
  try {
    const raw = parseYaml(await readFile(path, "utf8")) as Record<
      string,
      unknown
    > | null;
    const hash = raw?.["contractHash"];
    return typeof hash === "string" && hash ? hash : undefined;
  } catch {
    return undefined;
  }
}

function lintSummary(findings: LintFinding[]): SpecFinishResult["lint"] {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    status: errors > 0 ? "errors" : warnings > 0 ? "warnings" : "ok",
    errors,
    warnings,
    findings,
  };
}

/** Should the run reuse a `cairn services up` stack? */
async function shouldReuseServices(
  absPath: string,
  opts: FinishSpecOptions,
  vars: Record<string, string>,
): Promise<boolean> {
  if (opts.reuseServices !== undefined) return opts.reuseServices;
  if (opts.noServices || opts.mock) return false;
  try {
    const runtime = await resolveSpecRuntimeContext(absPath, {
      ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    if (!runtime.services || !runtime.configPath) return false;
    // One lock per config file; reuse only the environment it was taken for
    // (a lock of another env makes the run refuse with exit 4 instead).
    const lock = await readServicesLock(runtime.configPath);
    return lock.state === "held" && lock.lock.env === runtime.envName;
  } catch {
    return false;
  }
}

async function draftInfo(
  absPath: string,
  opts: FinishSpecOptions,
): Promise<boolean> {
  try {
    const runtime = await resolveSpecRuntimeContext(absPath, {
      ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return isDraftSpec(absPath, {
      draftsDir: draftsDirFor(runtime.configDir, runtime.config),
      root: runtime.configDir,
    });
  } catch {
    return false;
  }
}

export async function finishSpec(
  specPath: string,
  opts: FinishSpecOptions,
  runner: FinishRunner,
): Promise<SpecFinishResult> {
  const cwd = opts.cwd ?? process.cwd();
  const absPath = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);
  const shown = specPath;
  const vars = parseVarFlags(opts.var);
  const draft = await draftInfo(absPath, opts);
  const envFlag = opts.env !== undefined ? ` --env ${opts.env}` : "";

  // 1. Lint: errors stop here.
  const lint = await lintSpecs([absPath], {
    ...(opts.env !== undefined ? { envs: [opts.env] } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    cwd,
  });
  const findings = lint.files[0]?.findings ?? [];
  const lintPart = lintSummary(findings);
  const hashBefore = await readContractHash(absPath);
  if (lintPart.errors > 0) {
    const fixable = findings.some(
      (f) => f.severity === "error" && f.fix?.safe === true,
    );
    return SpecFinishResultSchema.parse({
      $schema: "urn:cairntrace.dev:spec-finish:v1",
      version: "1",
      path: shown,
      status: "lint-failed",
      exitCode: 4,
      draft,
      lint: lintPart,
      ...(hashBefore ? { contractHash: hashBefore } : {}),
      nextActions: [
        ...(fixable
          ? [
              `cairn spec lint ${shown} --fix --json  (safe fixes: quoting, step ids)`,
            ]
          : []),
        "fix the error findings (each carries a fix hint), then run cairn spec finish again",
      ],
    });
  }

  // 2. Cold-start run through the run engine, stamping when green.
  const reuseServices = await shouldReuseServices(absPath, opts, vars);
  const options: RunInvocationOptions = {
    coldStart: true,
    stampIfGreen: true,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.var && opts.var.length > 0 ? { var: opts.var } : {}),
    ...(opts.headed ? { headed: true } : {}),
    ...(opts.mock ? { mock: true } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.device !== undefined ? { device: opts.device } : {}),
    ...(opts.artifactRoot !== undefined
      ? { artifactRoot: resolve(cwd, opts.artifactRoot) }
      : {}),
    ...(reuseServices ? { reuseServices: true } : {}),
    ...(opts.noServices ? { noServices: true } : {}),
    ...(opts.noWebServer ? { noWebServer: true } : {}),
  };
  let invocation: RunInvocationResult;
  try {
    invocation = await runner({ specs: [absPath], options, cwd });
  } catch (e) {
    return SpecFinishResultSchema.parse({
      $schema: "urn:cairntrace.dev:spec-finish:v1",
      version: "1",
      path: shown,
      status: "errored",
      exitCode: 2,
      draft,
      lint: lintPart,
      run: { status: "errored", exitCode: 2, error: (e as Error).message },
      nextActions: ["the run engine failed; read the error and retry"],
    });
  }
  const run = (
    invocation.kind === "single" || invocation.kind === "errored"
      ? invocation.document
      : invocation.documents[0]
  ) as RunResult | undefined;
  const runStatus =
    run && "status" in run && typeof run.status === "string"
      ? run.status
      : "errored";
  const hashAfter = await readContractHash(absPath);
  let status: FinishStatus =
    runStatus === "passed"
      ? "green"
      : runStatus === "failed"
        ? "red"
        : runStatus === "refused"
          ? "refused"
          : "errored";
  if (status === "green" && (!hashAfter || invocation.exitCode !== 0)) {
    // Passed, but stamping (or a post-run step) failed.
    status = "errored";
  }
  const exitCode =
    status === "green"
      ? 0
      : invocation.exitCode !== 0
        ? invocation.exitCode
        : status === "refused"
          ? 7
          : 2;

  // 3. The run's agent_context.md.
  let context: SpecFinishResult["context"];
  if (run && run.runDir && !run.synthetic) {
    const path = join(run.runDir, "agent_context.md");
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined) context = { path, summary: contextSummary(text) };
  }

  // 4. Receipt for `cairn spec promote` (green only, this exact content).
  if (invocation.artifactRoot) {
    const text = await readFile(absPath, "utf8").catch(() => undefined);
    if (text !== undefined) {
      writeFinishReceipt(invocation.artifactRoot, {
        version: 1,
        path: absPath,
        status,
        contentHash: contentHash(text),
        ...(hashAfter ? { contractHash: hashAfter } : {}),
        ...(run?.environment ? { env: run.environment } : {}),
        ...(run?.backend ? { backend: run.backend } : {}),
        ...(run && !run.synthetic
          ? { runId: run.runId, runDir: run.runDir }
          : {}),
        finishedAt: new Date().toISOString(),
      });
    }
  }

  const reportPath =
    run && !run.synthetic && run.artifacts?.report
      ? join(run.runDir, run.artifacts.report)
      : undefined;
  const nextActions: string[] = [];
  const mockRun = isSyntheticBackend(run?.backend);
  switch (status) {
    case "green":
      if (mockRun) {
        // Green on the mock backend says the spec parses and its steps
        // replay, not that the app does what the outcomes claim.
        nextActions.push(
          `green on the mock backend only: no browser touched the app. Finish it on a real backend (cairn spec finish ${shown}${envFlag} without --mock / backend mock) before calling it done${
            draft
              ? "; cairn spec promote refuses a mock finish without --force"
              : ""
          }`,
        );
        break;
      }
      nextActions.push(
        draft
          ? `report to the human: intent, outcomes and the run report${
              reportPath ? ` (${reportPath})` : ""
            }; after their review: cairn spec promote ${shown} --json (MCP cairn_spec_promote)`
          : "done: the spec ran green from a cold start and its contract hash is stamped",
      );
      break;
    case "red":
      nextActions.push(
        `read the failure: ${context?.path ?? "the run's agent_context.md"} (cairn context ${run?.runId ?? "latest"})`,
        "fix the steps (not the outcomes, unless the human agrees to the contract change), then cairn spec finish again",
        `UI drift rather than a regression: cairn spec heal ${shown}${envFlag} --json`,
      );
      break;
    case "refused":
      nextActions.push(
        `the environment policy refused the spec${
          run?.refusal ? ` (${run.refusal.reason})` : ""
        }; pick an environment its requires.env allows (cairn spec verify ${shown} --json lists them)`,
      );
      break;
    default: {
      const message = invocation.error ?? run?.failure?.message;
      nextActions.push(
        invocation.error
          ? `the run errored: ${invocation.error}`
          : `the run errored${
              run?.failure ? `: ${run.failure.message}` : ""
            }; read ${context?.path ?? "the run's agent_context.md"}`,
      );
      if (message && /already listening/i.test(message) && !opts.noWebServer) {
        // A cold start boots the config webServer fresh; the dev server
        // the agent already runs is in the way.
        nextActions.push(
          `a server already runs on the webServer url: reuse it with cairn spec finish ${shown}${envFlag} --no-web-server (MCP noWebServer: true)`,
        );
      }
    }
  }

  return SpecFinishResultSchema.parse({
    $schema: "urn:cairntrace.dev:spec-finish:v1",
    version: "1",
    path: shown,
    status,
    exitCode,
    draft,
    lint: lintPart,
    run: {
      status: runStatus,
      exitCode: invocation.exitCode,
      invocationId: invocation.invocationId,
      ...(run && !run.synthetic
        ? { runId: run.runId, runDir: run.runDir }
        : {}),
      ...(reportPath ? { report: reportPath } : {}),
      ...(run?.environment ? { environment: run.environment } : {}),
      ...(run?.backend ? { backend: run.backend } : {}),
      ...(run ? { coldStart: run.coldStart, durationMs: run.durationMs } : {}),
      ...(reuseServices ? { reusedServices: true } : {}),
      ...(invocation.error ? { error: invocation.error } : {}),
    },
    ...(hashAfter ? { contractHash: hashAfter } : {}),
    ...(hashAfter && hashAfter !== hashBefore ? { stamped: true } : {}),
    ...(context ? { context } : {}),
    nextActions,
  });
}

/* ----- CLI ----- */

export interface FinishCommandOptions extends Omit<FinishSpecOptions, "cwd"> {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  /** commander `--no-services` → false. */
  services?: boolean;
  /** commander `--no-web-server` → false. */
  webServer?: boolean;
}

export async function finishCommand(
  specPath: string,
  opts: FinishCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const controller = new AbortController();
  let terminate: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
  const untrack = trackAbortReporter((signal) => {
    terminate?.(signal);
    controller.abort();
  });
  let result: SpecFinishResult;
  try {
    result = await finishSpec(
      specPath,
      {
        ...opts,
        ...(opts.services === false ? { noServices: true } : {}),
        ...(opts.webServer === false ? { noWebServer: true } : {}),
      },
      async (request) => {
        const handle = startRunInvocation(
          { ...request, argv: process.argv.slice(2) },
          { origin: "cli", logger: log, signal: controller.signal },
        );
        terminate = (signal) => handle.terminateSync(signal);
        return handle.result;
      },
    );
  } catch (e) {
    process.stderr.write(`cairn spec finish: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  } finally {
    untrack();
  }
  process.stdout.write(emit(format, result, finishToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exitCode = result.exitCode;
}

export function finishToMarkdown(r: SpecFinishResult): string {
  const lines = [
    `# Finish: ${r.path} — ${r.status.toUpperCase()}`,
    "",
    `- lint: ${r.lint.status} (${r.lint.errors} error(s), ${r.lint.warnings} warning(s))`,
  ];
  if (r.run) {
    lines.push(
      `- run: ${r.run.status}${
        r.run.environment ? ` in ${r.run.environment}` : ""
      }${
        r.run.backend === "mock"
          ? " on the MOCK backend (the app was not touched)"
          : ""
      }${r.run.coldStart ? " (cold start)" : ""}${
        r.run.runDir ? ` — ${r.run.runDir}` : ""
      }`,
    );
    if (r.run.report) lines.push(`- report: ${r.run.report}`);
    if (r.run.error) lines.push(`- error: ${r.run.error}`);
  }
  if (r.contractHash) {
    lines.push(
      `- contractHash: ${r.contractHash}${r.stamped ? " (stamped)" : ""}`,
    );
  }
  if (r.draft) lines.push("- draft: yes");
  const shownFindings = r.lint.findings.filter((f) => f.severity === "error");
  if (shownFindings.length > 0) {
    lines.push("", "## Lint errors");
    for (const f of shownFindings) {
      lines.push(
        `- ${f.line ? `line ${f.line}: ` : ""}${f.message}${
          f.fix ? ` — fix: ${f.fix.description}` : ""
        }`,
      );
    }
  }
  if (r.context?.summary) lines.push("", r.context.summary);
  lines.push("", "## Next", ...r.nextActions.map((a) => `- ${a}`));
  return lines.join("\n");
}
