import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute as isAbsolutePath,
  join,
  resolve,
} from "node:path";
import { execa } from "execa";
import { registerSecretValues } from "../../core/artifacts/redaction";
import { addEnospcHint } from "../../core/artifacts/retention";
import { renderJUnit } from "../../core/artifacts/renderers/junit";
import { renderRunMarkdown } from "../../core/artifacts/renderers/markdown";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import { ContractHashMismatchError } from "../../core/parser/parseSpec";
import { runPool } from "../../core/runner/pool";
import { runSpec } from "../../core/runner/Runner";
import {
  startWebServer,
  type WebServerHandle,
} from "../../core/runner/webServer";
import { startServices, type ServicesHandle } from "../../core/runner/services";
import type { BrowserConfig } from "../../core/schema/config.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type {
  SelectionResult,
  SelectedSpec,
  SkippedSpec,
} from "../../core/schema/selection.v1";
import type { ExitCode } from "../../core/schema/shared";
import { writeAbortedBatchSummary } from "../abortedBatch";
import { type BackendChoice, createBackend } from "../backendFactory";
import {
  trackAbortReporter,
  trackBackend,
  trackServices,
  trackWebServer,
} from "../cleanup";
import { emit, resolveFormat } from "../format";
import { isInteractive, makeInteractiveListener } from "../progress";
import { log, reconfigureWithConfig } from "../logger";
import { getTvaultEnv, tvaultArgs } from "./secrets";
import { maybeAutoStash, stashDirectory } from "./stash";
import { defaultCodemapDeps, maybeAutoAnnotateRun } from "./annotate";
import type { CodemapDeps } from "./annotate";
import { codemapReview, codemapSemantic } from "./codemap";
import { stampSpecContractHash } from "./spec/verify";
import { parseLabelFlags } from "../../core/stats/runStats";

export { parseLabelFlags };

export interface RunCommandOptions {
  env?: string;
  coldStart?: boolean;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  /** agent-browser provider (-p): ios, browserbase, kernel, etc. */
  provider?: string;
  /** iOS device name (--device), e.g. "iPhone 15 Pro" (provider: ios). */
  device?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  artifactRoot?: string;
  config?: string;
  parallel?: string;
  /** Repeatable `--var key=value` overrides; win over config env vars. */
  var?: string[];
  /** Write a JUnit XML report to this file. */
  junit?: string;
  /** Stamp contract hashes only when the entire run invocation passes. */
  stampIfGreen?: boolean;
  /** Commander sets this to false when `--no-color` is passed. */
  color?: boolean;
  /** Commander sets this to false when `--no-web-server` is passed. */
  webServer?: boolean;
  /** Commander sets this to false when `--no-services` is passed. */
  services?: boolean;
  /** Preview the services lifecycle plan without executing. */
  servicesDryRun?: boolean;
  /** Auto-stash failed runs to fcheap. */
  stashOnFailure?: boolean;
  /** Auto-annotate runs into codemap (on-run | never). */
  autoAnnotate?: string;
  /** Sample the browser process tree (CPU/RSS) during the run via the `monitor` CLI. */
  monitor?: boolean;
  /**
   * `--since-codemap <ref>` (FEATURES item 1): run only the specs whose
   * `coversSymbol` code-match provenance intersects the blast radius of
   * `codemap review --since <ref>`. Degrades to "run all" when codemap is
   * absent (best-effort, never fails the run).
   */
  /**
   * `--select-only` (FEATURES item 2): resolve which specs WOULD run for a
   * change and exit 0 without launching a browser. Emits a SelectionResult
   * v1 envelope. Pairs with `--since-codemap <ref>` for blast-radius scoping
   * and/or `--tag` for metadata.tags filtering; without either, lists all
   * expanded specs as selected.
   */
  selectOnly?: boolean;
  sinceCodemap?: string;
  /**
   * Repeatable `--tag <tag>`: keep only specs whose `metadata.tags` includes
   * every requested tag (AND, case-insensitive). Empty / absent = no filter.
   */
  tag?: string[];
  /**
   * Repeatable `--label key=value`: free-form cohort labels stamped into each
   * run.json (e.g. path=rabbit, suite=opg-14827-ab). Consumed by `cairn stats`.
   */
  label?: string[];
  /**
   * Repeatable `--before <shell>`: run once after services/secrets, before the
   * first spec (e.g. flip Temporal/Rabbit path, warm caches). Failures abort.
   */
  before?: string[];
  /**
   * Repeatable `--after <shell>`: run once after all specs, before services
   * teardown. Failures are logged but do not change the run exit code.
   */
  after?: string[];
}

/**
 * Archive a pruned run dir to fcheap before the retention prune deletes it.
 * Injected into `runSpec` via `onArchiveRun` so the core runner never imports
 * the stash CLI module directly. Best-effort: failures are caught inside
 * `pruneRuns` (the run is retained on disk when archiving fails).
 */
async function archiveRun(
  runDir: string,
  _runId: string,
  tags: string[],
): Promise<void> {
  const r = await stashDirectory(runDir, { tool: "cairntrace", tags });
  // Throw on archive failure so pruneRuns retains the run on disk (move,
  // not copy-and-lose). The caller never sees this — pruneRuns catches it.
  if (!r.ok) throw new Error(`fcheap archive failed: ${r.error ?? "unknown"}`);
}

/** Scoped logger for the run command's lifecycle/errors. */
const runLog = log.scope("run");

/**
 * Parse repeatable `--var key=value` flags into a vars bag.
 * Values may contain `=` (split happens on the first one).
 */
export function parseVarFlags(
  pairs: string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--var expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Run repeatable `--before` / `--after` shell hooks.
 * `before` failures are fatal (default); `after` can be non-fatal.
 */
export async function runHookCommands(
  phase: "before" | "after",
  commands: string[] | undefined,
  opts: { fatal?: boolean; cwd?: string } = {},
): Promise<void> {
  const list = (commands ?? []).map((c) => c.trim()).filter(Boolean);
  if (list.length === 0) return;
  const fatal = opts.fatal ?? true;
  const cwd = opts.cwd ?? process.cwd();
  for (const command of list) {
    runLog.info(`${phase}: ${command}`);
    try {
      const r = await execa(command, {
        shell: true,
        cwd,
        env: process.env,
        // Path-flip + service restart scripts are short; long builds should
        // use services preCommands instead. 10 min ceiling for slow boots.
        timeout: 600_000,
        reject: false,
        all: true,
      });
      if (r.exitCode !== 0) {
        const tail = (r.all ?? r.stderr ?? "").trim().slice(-2000);
        const msg = `${phase} hook failed (exit ${r.exitCode}): ${command}${
          tail ? `\n${tail}` : ""
        }`;
        if (fatal) throw new Error(msg);
        runLog.warn(msg);
      }
    } catch (e) {
      if (fatal) throw e;
      runLog.warn(`${phase} hook error: ${(e as Error).message}`);
    }
  }
}

/**
 * `cairn run <spec...> [--parallel N]`
 *
 * - Single spec, parallel=1 → rich interactive progress, RunResult output
 *   (back-compat with v0.0 — existing JSON consumers still get RunResult).
 * - Multiple specs OR parallel>1 → BatchRunResult, per-spec one-liners only.
 */
export async function runCommand(
  specs: string[],
  opts: RunCommandOptions,
): Promise<void> {
  const parallel = Math.max(1, Number(opts.parallel ?? "1"));
  let expandedSpecs: string[];

  try {
    expandedSpecs = await expandSpecArgs(specs);
  } catch (e) {
    runLog.error((e as Error).message);
    process.exit(2);
  }

  if (expandedSpecs.length === 0) {
    runLog.error("at least one spec path is required");
    process.exit(2);
  }

  const requiredTags = normalizeTagFilters(opts.tag);

  try {
    parseVarFlags(opts.var);
    parseLabelFlags(opts.label);
  } catch (e) {
    runLog.error((e as Error).message);
    process.exit(2);
  }

  // `--select-only`: resolve which specs WOULD run and exit 0 WITHOUT launching
  // a browser, services, or webServer. Emits SelectionResult v1. Applies
  // `--tag` and/or `--since-codemap` filters with skip reasons.
  if (opts.selectOnly) {
    const selection = await buildSelectionResult(
      expandedSpecs,
      opts.sinceCodemap,
      defaultCodemapDeps,
      requiredTags,
    );
    const format = resolveFormat(opts, "md");
    await writeStdoutFully(
      `${emit(format, selection, renderSelectionMarkdown)}${
        format !== "json" && format !== "yaml" ? "\n" : ""
      }`,
    );
    process.exitCode = 0;
    return;
  }

  // Tag filter (AND): keep only specs that declare every requested tag in
  // `metadata.tags`. Applied before blast-radius so codemap sees the narrowed set.
  if (requiredTags.length > 0) {
    const tagSel = await selectSpecsByTags(expandedSpecs, requiredTags);
    expandedSpecs = tagSel.selected;
    runLog.info(
      `tag filter [${requiredTags.join(", ")}]: ${expandedSpecs.length} spec(s)`,
    );
    if (expandedSpecs.length === 0) {
      runLog.error(
        `no specs matched --tag ${requiredTags.map((t) => JSON.stringify(t)).join(" --tag ")} ` +
          `(need every tag on metadata.tags; case-insensitive)`,
      );
      process.exit(2);
    }
  }

  // `--since-codemap <ref>` (FEATURES item 1): narrow to the specs a change can
  // actually hit via `codemap review` blast-radius intersection. Best-effort —
  // degrades to the full set when codemap is absent.
  if (opts.sinceCodemap) {
    expandedSpecs = await selectSpecsByBlastRadius(
      expandedSpecs,
      opts.sinceCodemap,
    );
    if (expandedSpecs.length === 0) {
      runLog.info(
        `--since-codemap ${opts.sinceCodemap} selected 0 specs (blast radius matched no spec's coversSymbol); nothing to run`,
      );
      process.exitCode = 0;
      return;
    }
  }

  // Propagate --env to CAIRN_TVAULT_ENV as early as possible — before the
  // webServer, services, and secret-injection phases — so config-level
  // `${env.CAIRN_TVAULT_ENV:-local}` placeholders resolve to the same tvault
  // env everywhere (the seed/docker/tmux phases run before secret injection).
  // The caller can still decouple them by exporting CAIRN_TVAULT_ENV in the
  // shell.
  if (opts.env !== undefined && process.env.CAIRN_TVAULT_ENV === undefined) {
    process.env.CAIRN_TVAULT_ENV = opts.env;
  }

  // Bring up the configured webServer (if any) once for the whole invocation,
  // before any spec runs. A boot/setup failure here is fatal (exit 2).
  let server: WebServerHandle | undefined;
  let untrackServer: (() => void) | undefined;
  try {
    server = await maybeStartWebServer(
      expandedSpecs[0]!,
      opts,
      // Track for signal teardown the instant the server is spawned — before
      // readiness/setup — so a SIGINT/SIGTERM during a slow boot can't orphan it.
      (terminateSync) => {
        untrackServer = trackWebServer({ terminateSync });
      },
    );
  } catch (e) {
    untrackServer?.();
    runLog.error((e as Error).message);
    process.exit(2);
  }

  // Bring up the configured services environment (docker/seed/tmux), if any.
  // Same scope as webServer — starts once before the pool, stops once after.
  let svcHandle: ServicesHandle | undefined;
  let untrackSvc: (() => void) | undefined;
  try {
    svcHandle = await maybeStartServices(
      expandedSpecs[0]!,
      opts,
      (terminateSync) => {
        untrackSvc = trackServices({ terminateSync });
      },
    );
  } catch (e) {
    untrackSvc?.();
    // Tear down the web server too before exiting.
    if (server) await server.stop().catch(() => undefined);
    untrackServer?.();
    runLog.error((e as Error).message);
    process.exit(2);
  }

  // Inject tvault secrets into process.env so that `${env.SECRET_KEY}`
  // placeholders in specs resolve to the actual secret values.
  // This runs once for the whole invocation, before any spec executes.
  // Errors are fatal because a missing required secret would just fail later
  // in a more confusing way.
  try {
    await maybeInjectTvaultSecrets(expandedSpecs[0]!, opts);
  } catch (e) {
    runLog.error((e as Error).message);
    process.exit(2);
  }

  // Project-level browser tuning (config `browser:` block) applied to every
  // backend this invocation constructs. Resolved once, same scope as
  // webServer/services. Best-effort: no config → undefined → adapter defaults.
  const browser = await resolveBrowserConfig(expandedSpecs[0]!, opts);

  // Domain hooks (e.g. tools/set-answer-change-path.sh temporal) run AFTER
  // services+secrets so they can restart tmux panes, and BEFORE the first spec.
  try {
    await runHookCommands("before", opts.before);
  } catch (e) {
    runLog.error((e as Error).message);
    if (svcHandle) {
      await svcHandle.stop().catch(() => undefined);
      untrackSvc?.();
    }
    if (server) {
      await server.stop().catch(() => undefined);
      untrackServer?.();
    }
    process.exit(2);
  }

  // Resolve one final exit status only after lifecycle teardown; forcing an
  // exit inside runSingle/runBatch would skip finally and orphan resources.
  let exitCode: ExitCode = 2;
  try {
    exitCode =
      expandedSpecs.length === 1 && parallel === 1
        ? await runSingle(expandedSpecs[0]!, opts, svcHandle?.events, browser)
        : await runBatch(
            expandedSpecs,
            parallel,
            opts,
            svcHandle?.events,
            browser,
          );
  } finally {
    // after hooks run while services are still up (can query mongo/tmux).
    // Best-effort: log failures, keep the suite exit code.
    try {
      await runHookCommands("after", opts.after, { fatal: false });
    } catch (e) {
      runLog.warn(`after hook: ${(e as Error).message}`);
    }
    if (svcHandle) {
      await svcHandle.stop().catch(() => undefined);
      untrackSvc?.();
    }
    if (server) {
      if (server.startedByUs && exitCode !== 0) {
        const logTail = server.tailLog(80).trim();
        if (logTail) {
          runLog.warn(
            `web server log (last 80 lines${
              server.logPath ? `, full: ${server.logPath}` : ""
            }):`,
          );
          // The tail is server output — stream it raw so it isn't re-leveled.
          log.raw(`${logTail}\n`);
        }
      }
      await server.stop().catch(() => undefined);
      untrackServer?.();
    }
  }

  // runSingle/runBatch return the stable wire exit code so lifecycle teardown
  // above always completes first. Do not force process.exit here: stdout may
  // still be draining a large batch JSON/YAML document into a pipe.
  process.exitCode = exitCode;
}

/**
 * Resolve config for the invocation and, if it declares a `webServer`, start it
 * once. Returns undefined when there is no config, no `webServer`, or
 * `--no-web-server` was passed. Throws (fatal) on a boot/setup failure.
 */
async function maybeStartWebServer(
  firstSpec: string,
  opts: RunCommandOptions,
  onSpawn: (terminateSync: () => void) => void,
): Promise<WebServerHandle | undefined> {
  if (opts.webServer === false) return undefined; // --no-web-server

  const firstSpecAbs = isAbsolutePath(firstSpec)
    ? firstSpec
    : resolve(process.cwd(), firstSpec);
  // Unknown/unreadable first arg: let the normal spec-run path report it.
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;

  const vars = parseVarFlags(opts.var);
  const ctx = await resolveSpecRuntimeContext(firstSpecAbs, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
  const cfg = ctx.config?.webServer;
  if (!cfg) return undefined;

  // Run-scope readiness validation: a bare baseUrl satisfies it even when the
  // block sets neither url nor waitForText (the schema can't see baseUrl).
  if (!cfg.url && !cfg.waitForText && !ctx.baseUrl) {
    throw new Error(
      "webServer needs `url`, `waitForText`, or an environment `baseUrl` for readiness",
    );
  }

  const coldStart = opts.coldStart ?? isTruthyEnv(process.env.CI);
  const configDir = ctx.configPath
    ? dirname(ctx.configPath)
    : dirname(firstSpecAbs);
  const artifactRoot =
    opts.artifactRoot ??
    ctx.config?.artifactRoot ??
    join(homedir(), ".cairntrace", "runs");
  // Apply the config `logging` block as a project default (flags/env still win).
  reconfigureWithConfig(ctx.config?.logging);

  return startWebServer(cfg, {
    configDir,
    coldStart,
    artifactRoot,
    onSpawn,
    ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
    // Lifecycle narration always routes through the logger (leveled, stderr);
    // on non-interactive/json paths the default warn level suppresses info.
    log: (m: string) => log.scope("web-server").info(m),
  });
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Resolve the config `browser:` block for the invocation (run scope, same
 * discovery as webServer/services). Returns undefined when there is no
 * config or no `browser` block — backends then use their built-in defaults.
 */
async function resolveBrowserConfig(
  firstSpec: string,
  opts: RunCommandOptions,
): Promise<BrowserConfig | undefined> {
  const firstSpecAbs = isAbsolutePath(firstSpec)
    ? firstSpec
    : resolve(process.cwd(), firstSpec);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;

  const vars = parseVarFlags(opts.var);
  const ctx = await resolveSpecRuntimeContext(firstSpecAbs, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  }).catch(() => undefined);
  return ctx?.config?.browser;
}

/**
 * Resolve config for the invocation and, if it declares a `services` block,
 * start the environment (docker/seed/tmux) once. Returns undefined when there
 * is no config, no `services`, or `--no-services` was passed. Throws (fatal)
 * on a boot failure.
 */
async function maybeStartServices(
  firstSpec: string,
  opts: RunCommandOptions,
  onSpawn: (terminateSync: () => void) => void,
): Promise<ServicesHandle | undefined> {
  if (opts.services === false) return undefined; // --no-services

  const firstSpecAbs = isAbsolutePath(firstSpec)
    ? firstSpec
    : resolve(process.cwd(), firstSpec);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;

  const vars = parseVarFlags(opts.var);
  const ctx = await resolveSpecRuntimeContext(firstSpecAbs, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
  const cfg = ctx.services;
  if (!cfg) return undefined;

  const coldStart = opts.coldStart ?? isTruthyEnv(process.env.CI);
  const configDir = ctx.configPath
    ? dirname(ctx.configPath)
    : dirname(firstSpecAbs);
  const project = ctx.config?.project ?? "cairntrace";

  // --services-dry-run: print the plan, return a no-op handle, don't execute.
  if (opts.servicesDryRun) {
    const lines = [
      "services dry-run plan:",
      `  project: ${project}`,
      `  cold-start: ${coldStart}`,
      cfg.docker
        ? `  docker: ${cfg.docker.command} (reuseExisting: ${cfg.docker.reuseExisting ?? !coldStart})`
        : "  docker: (not configured)",
      cfg.seed
        ? `  seed: ${cfg.seed.command.slice(0, 80)}${
            cfg.seed.command.length > 80 ? "..." : ""
          } (ttlSeconds: ${cfg.seed.ttlSeconds ?? 0})`
        : "  seed: (not configured)",
      cfg.tmux
        ? `  tmux: session=${cfg.tmux.session}, ${cfg.tmux.windows.length} windows (reuseExisting: ${cfg.tmux.reuseExisting ?? !coldStart})`
        : "  tmux: (not configured)",
      cfg.teardown
        ? `  teardown: ${cfg.teardown.length} command(s)`
        : "  teardown: (none)",
    ];
    process.stderr.write(lines.join("\n") + "\n");
    return {
      startedByUs: false,
      events: [],
      stop: async () => undefined,
      terminateSync: () => undefined,
    };
  }

  return startServices(cfg, {
    configDir,
    coldStart,
    project,
    onSpawn,
    ...(ctx.secrets ? { secrets: ctx.secrets } : {}),
    // Lifecycle narration + live subprocess output route through the logger
    // (leveled, always stderr). info lines + raw streaming show on an
    // interactive TTY (default info); --quiet/json suppresses them.
    log: (m: string) => log.scope("services").info(m),
    onOutput: (c: string) => log.raw(c),
  });
}

/* ----- single-spec path (preserves v0.0 behavior) ----- */

async function runSingle(
  specPath: string,
  opts: RunCommandOptions,
  servicesEvents?: ServicesHandle["events"],
  browser?: BrowserConfig,
): Promise<ExitCode> {
  const format = resolveFormat(opts, "md");
  const backend = createBackend(backendOpts(opts, browser));
  const untrack = trackBackend(backend);
  const interactive = format === "md" && isInteractive();
  const listener = interactive
    ? makeInteractiveListener({ color: colorEnabled() })
    : undefined;

  let exitCode: ExitCode = 2;
  try {
    const vars = parseVarFlags(opts.var);
    const labels = parseLabelFlags(opts.label);
    const result = await runSpec({
      specPath,
      backend,
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
      ...(opts.coldStart !== undefined ? { coldStart: opts.coldStart } : {}),
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(servicesEvents !== undefined && servicesEvents.length > 0
        ? { servicesEvents }
        : {}),
      workerIndex: 0,
      ...(opts.monitor ? { monitor: opts.monitor } : {}),
      ...(listener ? { listener } : {}),
      onArchiveRun: archiveRun,
    });
    exitCode = result.exitCode;
    if (!(await stampIfGreen(opts, [result]))) {
      return 2;
    }
    if (!(await writeJUnitIfRequested(opts, [result]))) {
      return 2;
    }

    // Auto-stash failed runs to fcheap (best-effort, never fatal).
    if (result.status !== "passed") {
      await maybeAutoStash(result.runDir, result.runId, result.spec.name, {
        stashOnFailure: opts.stashOnFailure ?? false,
      });
    }

    // Auto-annotate runs into codemap (best-effort, never fatal).
    // Pass + fail: emits one annotation per run with run context.
    await maybeAutoAnnotateRun(
      result,
      await resolveAnnotateOpts(specPath, opts),
    );

    if (!interactive) {
      process.stdout.write(emit(format, result, renderRunMarkdown));
      if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    }
  } catch (e) {
    const result = synthesizeErroredResult(specPath, e as Error, {
      labels: parseLabelFlags(opts.label),
    });
    exitCode = result.exitCode;
    if (!(await writeJUnitIfRequested(opts, [result]))) {
      return 2;
    }
    emitErroredResult(result, format);
  } finally {
    untrack();
    await backend.close().catch(() => undefined);
  }
  return exitCode;
}

/* ----- multi-spec path ----- */

// BatchRunResult is the v1 wire schema in src/core/schema/runBatch.v1.ts.
// Re-export for convenience so callers don't need to know the file path.
export type { BatchRunResult } from "../../core/schema/runBatch.v1";
import type { BatchRunResult } from "../../core/schema/runBatch.v1";

async function runBatch(
  specs: string[],
  parallel: number,
  opts: RunCommandOptions,
  servicesEvents?: ServicesHandle["events"],
  browser?: BrowserConfig,
): Promise<ExitCode> {
  const format = resolveFormat(opts, "md");
  const interactive = format === "md" && isInteractive();
  const tStart = Date.now();
  const startedAt = new Date(tStart).toISOString();
  const artifactRoot = await resolveBatchArtifactRoot(specs[0]!, opts);
  const completedByIndex: Array<RunResult | undefined> = Array.from({
    length: specs.length,
  });
  const untrackAbortReporter = trackAbortReporter((signal) => {
    const completed = completedByIndex.filter(
      (result): result is RunResult => result !== undefined,
    );
    try {
      const written = writeAbortedBatchSummary(artifactRoot, {
        signal,
        startedAt,
        parallel,
        requestedTotal: specs.length,
        completed,
      });
      process.stderr.write(
        `cairn: wrote aborted batch summary to ${written.path}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `cairn: could not write aborted batch summary: ${(error as Error).message}\n`,
      );
    }
  });

  if (interactive) {
    log.raw(
      `\x1b[1mRunning\x1b[0m ${specs.length} spec${
        specs.length === 1 ? "" : "s"
      } (parallel: ${parallel})\n\n`,
    );
  }

  // Each worker gets its own session id so parallel runs don't share an
  // agent-browser session (which would cross-contaminate cookies, storage,
  // and network logs across specs). Playwright/Mock ignore the field but
  // it's harmless for them.
  const sessionRoot = `cairntrace-${process.pid}`;
  let results: RunResult[];
  try {
    results = await runPool(
      specs,
      parallel,
      async (specPath, idx, workerIndex) => {
        const backend = createBackend({
          ...backendOpts(opts, browser),
          session: `${sessionRoot}-w${workerIndex}`,
        });
        const untrack = trackBackend(backend);
        try {
          const vars = parseVarFlags(opts.var);
          const labels = parseLabelFlags(opts.label);
          const r = await runSpec({
            specPath,
            backend,
            ...(opts.artifactRoot !== undefined
              ? { artifactRoot: opts.artifactRoot }
              : {}),
            ...(opts.coldStart !== undefined
              ? { coldStart: opts.coldStart }
              : {}),
            ...(opts.env !== undefined
              ? { environmentOverride: opts.env }
              : {}),
            ...(opts.config !== undefined ? { configPath: opts.config } : {}),
            ...(Object.keys(vars).length > 0 ? { vars } : {}),
            ...(Object.keys(labels).length > 0 ? { labels } : {}),
            ...(servicesEvents !== undefined && servicesEvents.length > 0
              ? { servicesEvents }
              : {}),
            workerIndex,
            ...(opts.monitor ? { monitor: opts.monitor } : {}),
            onArchiveRun: archiveRun,
          });
          // runSpec returns only after run.json/report.json/manifest are durable.
          // Record immediately, before best-effort annotation/stash work, so a
          // signal can index every completed per-spec artifact directory.
          completedByIndex[idx] = r;
          if (interactive) {
            const mark =
              r.status === "passed"
                ? "\x1b[32m✓\x1b[0m"
                : r.status === "failed"
                  ? "\x1b[31m✗\x1b[0m"
                  : "\x1b[33m·\x1b[0m";
            log.raw(
              `  ${mark} [${idx + 1}/${specs.length}] ${r.spec.name} (${formatMs(r.durationMs)}, ${
                r.outcomes.filter((o) => o.status === "passed").length
              }/${r.outcomes.length} outcomes)\n`,
            );
          }
          // Auto-stash failed runs to fcheap (best-effort, never fatal).
          if (r.status !== "passed") {
            await maybeAutoStash(r.runDir, r.runId, r.spec.name, {
              stashOnFailure: opts.stashOnFailure ?? false,
            });
          }
          // Auto-annotate runs into codemap (best-effort, never fatal).
          // Pass + fail: emits one annotation per run with run context.
          await maybeAutoAnnotateRun(
            r,
            await resolveAnnotateOpts(specPath, opts),
          );
          return r;
        } catch (e) {
          // Synthesize an errored RunResult so the batch survives.
          const err = e as Error;
          if (interactive) {
            log.raw(
              `  \x1b[33m·\x1b[0m [${idx + 1}/${specs.length}] ${specPath}: ${err.message}\n`,
            );
          }
          const errored = synthesizeErroredResult(specPath, err, {
            labels: parseLabelFlags(opts.label),
          });
          completedByIndex[idx] = errored;
          return errored;
        } finally {
          untrack();
          await backend.close().catch(() => undefined);
        }
      },
    );
  } catch (error) {
    untrackAbortReporter();
    throw error;
  }

  // Keep the signal-time reporter registered through stamping, JUnit, and
  // stdout drain. A signal in this final window must still preserve a durable
  // batch summary instead of truncating the only aggregate result.
  try {
    const totalDurationMs = Date.now() - tStart;
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      errored: results.filter((r) => r.status === "errored").length,
    };
    const exitCode: ExitCode = results.some((result) => result.exitCode === 6)
      ? 6
      : summary.failed > 0
        ? 1
        : summary.errored > 0
          ? 2
          : 0;

    const batch: BatchRunResult = {
      $schema: "urn:cairntrace.dev:run-batch:v1",
      version: "1",
      parallel,
      totalDurationMs,
      summary,
      results,
      exitCode,
    };

    if (!(await stampIfGreen(opts, results))) {
      return 2;
    }
    if (!(await writeJUnitIfRequested(opts, results))) {
      return 2;
    }

    const output =
      format === "json" || format === "yaml"
        ? emit(format, batch, () => "")
        : `${renderBatchMarkdown(batch)}\n`;
    await writeStdoutFully(output);
    return exitCode;
  } finally {
    untrackAbortReporter();
  }
}

/* ----- helpers ----- */

/** Wait for a piped stdout buffer to drain without forcing process exit. */
async function writeStdoutFully(output: string): Promise<void> {
  if (process.stdout.write(output)) return;
  await new Promise<void>((resolveDrain, rejectDrain) => {
    const onDrain = (): void => {
      process.stdout.off("error", onError);
      resolveDrain();
    };
    const onError = (error: Error): void => {
      process.stdout.off("drain", onDrain);
      rejectDrain(error);
    };
    process.stdout.once("drain", onDrain);
    process.stdout.once("error", onError);
  });
}

/** Resolve the same artifact root runSpec will use, without making parse errors fatal. */
async function resolveBatchArtifactRoot(
  firstSpec: string,
  opts: RunCommandOptions,
): Promise<string> {
  if (opts.artifactRoot !== undefined) return resolve(opts.artifactRoot);
  const fallback = join(homedir(), ".cairntrace", "runs");
  try {
    const firstSpecAbs = isAbsolutePath(firstSpec)
      ? firstSpec
      : resolve(process.cwd(), firstSpec);
    const vars = parseVarFlags(opts.var);
    const ctx = await resolveSpecRuntimeContext(firstSpecAbs, {
      ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
    });
    return resolve(ctx.config?.artifactRoot ?? fallback);
  } catch {
    return resolve(fallback);
  }
}

/**
 * When `secrets.provider: tvault` is configured, resolve the tvault project
 * name (substituting `${env.X:-default}` from process.env) and inject all
 * secrets from that project into process.env. This makes them available to
 * `${env.SECRET_KEY}` placeholders in specs via parseSpec's substitute().
 *
 * Without this, tvault secrets were only injected into the seed command's env
 * (resolveSeedEnv in services.ts), not into the spec execution path.
 */
export async function maybeInjectTvaultSecrets(
  firstSpec: string,
  opts: RunCommandOptions,
): Promise<void> {
  const firstSpecAbs = isAbsolutePath(firstSpec)
    ? firstSpec
    : resolve(process.cwd(), firstSpec);
  const vars = parseVarFlags(opts.var);

  // When --env <name> is passed, propagate it to CAIRN_TVAULT_ENV so that
  // config-level `${env.CAIRN_TVAULT_ENV:-local}` resolves to the cairn env
  // name automatically — unless the caller explicitly set CAIRN_TVAULT_ENV
  // to decouple the two.
  if (opts.env !== undefined && process.env.CAIRN_TVAULT_ENV === undefined) {
    process.env.CAIRN_TVAULT_ENV = opts.env;
  }

  const ctx = await resolveSpecRuntimeContext(firstSpecAbs, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
  const secrets = ctx.secrets;
  if (!secrets || secrets.provider !== "tvault" || !secrets.tvault) return;

  const tvaultCfg = secrets.tvault;
  const { target } = tvaultArgs(tvaultCfg);
  const result = await getTvaultEnv(tvaultCfg);
  if (!result.ok) {
    throw new Error(
      `tvault secrets injection failed: ${result.error ?? "unknown error"}`,
    );
  }

  // Every value pulled from the vault is sensitive regardless of its key name
  // (e.g. MONGO_URI, DATABASE_URL). Register them so the artifact redactor
  // scrubs their plaintext from resolved specs, run.json, report.html, etc.
  registerSecretValues(Object.values(result.env));

  // Inject all tvault secrets into process.env. Existing env vars are NOT
  // overwritten — the caller's shell env takes precedence (e.g. when running
  // inside `tvault run -- cairn run ...`, the secrets are already in env).
  let injected = 0;
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(result.env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      injected++;
    } else if (process.env[key] !== value) {
      shadowed.push(key);
    }
  }

  if (shadowed.length > 0) {
    runLog.warn(
      `tvault "${target}" secrets shadowed by existing env vars (bun .env auto-load or shell): ${shadowed.join(", ")}. Remove these from .env or unset them to use tvault values.`,
    );
  }

  // Also inject into the required list — fail fast if any required key is
  // still missing (not in tvault and not in the shell env).
  if (secrets.required) {
    const missing = secrets.required.filter(
      (k) => process.env[k] === undefined || process.env[k] === "",
    );
    if (missing.length > 0) {
      throw new Error(
        `tvault "${target}" is missing required secrets: ${missing.join(", ")}`,
      );
    }
  }

  if (injected > 0) {
    runLog.info(`injected ${injected} secrets from tvault "${target}"`);
  }
}

function backendOpts(
  opts: RunCommandOptions,
  browser?: BrowserConfig,
): Parameters<typeof createBackend>[0] {
  // CLI flags win over config `browser.*`.
  const provider = opts.provider ?? browser?.provider;
  const device = opts.device ?? browser?.device;
  return {
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(browser?.verifyAfterClick !== undefined
      ? { verifyAfterClick: browser.verifyAfterClick }
      : {}),
    ...(browser?.postClickSettleMs !== undefined
      ? { postClickSettleMs: browser.postClickSettleMs }
      : {}),
  };
}
function colorEnabled(): boolean {
  return log.color && process.env.TERM !== "dumb";
}

/**
 * Resolve the effective auto-annotate options for the run path.
 * The `--auto-annotate` CLI flag wins over the config `annotate.autoAnnotate`
 * value. The `annotate.source` config value provides the default source label.
 * Returns `{ autoAnnotate: "never" }` when neither is set, so
 * `maybeAutoAnnotateRun` is a no-op.
 */
async function resolveAnnotateOpts(
  specPath: string,
  opts: RunCommandOptions,
): Promise<{ autoAnnotate?: string; source?: string }> {
  // CLI flag wins.
  if (opts.autoAnnotate) {
    return { autoAnnotate: opts.autoAnnotate };
  }
  // Fall back to config annotate block.
  try {
    const firstSpecAbs = isAbsolutePath(specPath)
      ? specPath
      : resolve(process.cwd(), specPath);
    const ctx = await resolveSpecRuntimeContext(firstSpecAbs, {
      configPath: opts.config,
    });
    const annotate = ctx.config?.annotate;
    if (annotate?.autoAnnotate && annotate.autoAnnotate !== "never") {
      return {
        autoAnnotate: annotate.autoAnnotate,
        ...(annotate.source ? { source: annotate.source } : {}),
      };
    }
  } catch {
    // config resolution failure — silently skip; the run itself will report
  }
  return { autoAnnotate: "never" };
}

function emitErroredResult(result: RunResult, format: string): void {
  // Errored runs go through the same synthesizeErroredResult path as
  // mid-run failures so consumers see a schema-valid RunResult either way.
  if (format === "json" || format === "yaml") {
    process.stdout.write(emit(format, result, renderRunMarkdown));
  } else {
    const failed = result.steps.find((s) => s.status === "failed");
    runLog.error(failed?.error ?? "run errored");
  }
}

export async function expandSpecArgs(
  args: string[],
  cwd = process.cwd(),
): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    const abs = isAbsolutePath(arg) ? arg : resolve(cwd, arg);
    const s = await stat(abs).catch(() => undefined);
    if (!s) {
      out.push(arg);
      continue;
    }
    if (!s.isDirectory()) {
      out.push(arg);
      continue;
    }
    out.push(...(await collectSpecFiles(abs)));
  }
  return out;
}

async function collectSpecFiles(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).toSorted(
    (a, b) => a.name.localeCompare(b.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "actions") continue;
      out.push(...(await collectSpecFiles(path)));
      continue;
    }
    if (
      entry.isFile() &&
      /\.ya?ml$/i.test(entry.name) &&
      !basename(entry.name).startsWith("_")
    ) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Read a spec's `coversSymbol` binding from disk via a loose YAML parse (no
 * zod validation, no contractHash check) — selection only needs the symbol
 * name. Returns undefined when the field is absent or the file can't be parsed.
 */
async function readCoversSymbol(specPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(specPath, "utf8");
    const doc = parseYaml(raw) as Record<string, unknown> | null;
    const sym = doc?.coversSymbol;
    return typeof sym === "string" && sym.length > 0 ? sym : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read `metadata.tags` from a spec via a loose YAML parse (selection only).
 * Returns [] when absent or unreadable.
 */
export async function readSpecTags(specPath: string): Promise<string[]> {
  try {
    const raw = await readFile(specPath, "utf8");
    const doc = parseYaml(raw) as {
      metadata?: { tags?: unknown };
    } | null;
    const tags = doc?.metadata?.tags;
    if (!Array.isArray(tags)) return [];
    return tags.filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
  } catch {
    return [];
  }
}

/** Trim empty entries from repeatable `--tag` flags. */
export function normalizeTagFilters(tags: string[] | undefined): string[] {
  return (tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * True when `specTags` includes every entry in `required` (case-insensitive).
 * Empty `required` always matches.
 */
export function specMatchesTags(
  specTags: string[],
  required: string[],
): boolean {
  if (required.length === 0) return true;
  const have = new Set(specTags.map((t) => t.toLowerCase()));
  return required.every((r) => have.has(r.toLowerCase()));
}

/**
 * Filter expanded specs by `metadata.tags`. AND semantics: every required tag
 * must be present. Returns selected paths and skip reasons for the rest.
 */
export async function selectSpecsByTags(
  specs: string[],
  requiredTags: string[],
): Promise<{
  selected: string[];
  skipped: { path: string; reason: string }[];
}> {
  const required = normalizeTagFilters(requiredTags);
  if (required.length === 0) {
    return { selected: [...specs], skipped: [] };
  }
  const selected: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const need = required.map((t) => t.toLowerCase());
  for (const p of specs) {
    const tags = await readSpecTags(p);
    const have = new Set(tags.map((t) => t.toLowerCase()));
    const missing = need.filter((t) => !have.has(t));
    if (missing.length === 0) {
      selected.push(p);
    } else {
      skipped.push({
        path: p,
        reason:
          tags.length === 0
            ? `no metadata.tags (need: ${required.join(", ")})`
            : `missing tag(s): ${missing.join(", ")} (have: ${tags.join(", ")})`,
      });
    }
  }
  return { selected, skipped };
}

/**
 * `--since-codemap <ref>` (FEATURES item 1): intersect `codemap review --since
 * <ref>` blast-radius file paths against each spec's `coversSymbol` code-match
 * provenance and return only the minimal set a change can actually hit.
 *
 * A spec is selected when EITHER its `coversSymbol` is directly named in the
 * blast-radius symbol set, OR resolving that symbol to a file via
 * `codemap semantic` yields a path in the blast-radius file set.
 *
 * Degrades to the full input list (run-all) when codemap is absent, when
 * `since` is blank, or when codemap failed to produce a positive review —
 * best-effort, never fails the run. An indexed review with an empty blast
 * radius (e.g. a one-line CSS edit touching no symbols) selects no specs.
 */
export async function selectSpecsByBlastRadius(
  specs: string[],
  since: string,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<string[]> {
  if (specs.length === 0 || !since) return specs;
  if (!(await deps.isAvailable())) return specs;
  const review = await codemapReview(since, deps);
  // codemap failed / returned nothing → run-all so a broken codemap never
  // silently skips a run.
  if (!review.indexed && review.blastRadiusFiles.length === 0) return specs;
  // Indexed but empty radius → genuinely nothing impacted (CSS edit case).
  if (
    review.blastRadiusFiles.length === 0 &&
    review.blastRadiusSymbols.length === 0
  )
    return [];
  const blastFiles = new Set(review.blastRadiusFiles);
  const blastSymbols = new Set(review.blastRadiusSymbols);
  const selected: string[] = [];
  for (const specPath of specs) {
    const sym = await readCoversSymbol(specPath);
    if (!sym) continue; // uncovered spec — not selected by blast radius
    if (blastSymbols.has(sym)) {
      selected.push(specPath);
      continue;
    }
    // Resolve the symbol to its file(s) via codemap semantic and intersect.
    const files = (await codemapSemantic(sym, deps))
      .map((s) => s.file)
      .filter((f): f is string => !!f);
    if (files.some((f) => blastFiles.has(f))) selected.push(specPath);
  }
  return selected;
}

/** Spec name from a path: the basename minus .yml/.yaml. */
function specNameFromPath(specPath: string): string {
  return (
    specPath
      .split("/")
      .pop()
      ?.replace(/\.ya?ml$/, "") ?? specPath
  );
}

/** Absolutify a spec path (expandSpecArgs may pass explicit relative files through). */
function absolutifySpec(specPath: string): string {
  return isAbsolutePath(specPath) ? specPath : resolve(process.cwd(), specPath);
}

/**
 * `--select-only`: resolve which specs WOULD run and return a SelectionResult
 * v1 envelope, WITHOUT launching a browser.
 *
 * Filters (applied in order):
 * 1. `--tag` AND-filter on `metadata.tags` (case-insensitive)
 * 2. `--since-codemap` blast-radius (when provided)
 *
 * - No `since` / no tags: all expanded specs selected; codemapAvailable=false.
 * - Tags only: non-matching skipped with reason; codemapAvailable=false.
 * - `since` + codemap absent: degrade to run-all on the tag-filtered set.
 * - `since` + codemap present + empty radius: all remaining skipped.
 * - `since` + non-empty radius: blast-radius intersection.
 */
export async function buildSelectionResult(
  specs: string[],
  since: string | undefined,
  deps: CodemapDeps = defaultCodemapDeps,
  requiredTags: string[] = [],
): Promise<SelectionResult> {
  const selected: SelectedSpec[] = [];
  const skipped: SkippedSpec[] = [];
  const tagsFilter = normalizeTagFilters(requiredTags);
  const enter = async (
    p: string,
  ): Promise<{ name: string; path: string; tags?: string[] }> => {
    const tags = await readSpecTags(p);
    return {
      name: specNameFromPath(p),
      path: absolutifySpec(p),
      ...(tags.length > 0 ? { tags } : {}),
    };
  };
  const base = {
    $schema: "urn:cairntrace.dev:selection:v1" as const,
    version: "1" as const,
    ...(tagsFilter.length > 0 ? { tags: tagsFilter } : {}),
  };

  // 1) Tag filter first — skipped specs stay skipped even if codemap would
  // have selected them.
  let candidates = specs;
  if (tagsFilter.length > 0) {
    const tagSel = await selectSpecsByTags(specs, tagsFilter);
    candidates = tagSel.selected;
    for (const s of tagSel.skipped) {
      skipped.push({
        name: specNameFromPath(s.path),
        path: absolutifySpec(s.path),
        reason: s.reason,
      });
    }
  }

  const pushSelected = async (p: string, coversSymbol?: string) => {
    const e = await enter(p);
    selected.push({
      ...e,
      ...(coversSymbol ? { coversSymbol } : {}),
    });
  };

  if (!since) {
    for (const p of candidates) {
      const sym = await readCoversSymbol(p);
      await pushSelected(p, sym);
    }
    return {
      ...base,
      codemapAvailable: false,
      selected,
      skipped,
    };
  }

  if (!(await deps.isAvailable())) {
    for (const p of candidates) {
      const sym = await readCoversSymbol(p);
      await pushSelected(p, sym);
    }
    return { ...base, since, codemapAvailable: false, selected, skipped };
  }

  const review = await codemapReview(since, deps);
  // codemap failed / returned nothing → run-all so a broken codemap never
  // silently skips a run.
  if (!review.indexed && review.blastRadiusFiles.length === 0) {
    for (const p of candidates) {
      const sym = await readCoversSymbol(p);
      await pushSelected(p, sym);
    }
    return { ...base, since, codemapAvailable: false, selected, skipped };
  }

  const blastFiles = new Set(review.blastRadiusFiles);
  const blastSymbols = new Set(review.blastRadiusSymbols);
  const emptyRadius =
    review.blastRadiusFiles.length === 0 &&
    review.blastRadiusSymbols.length === 0;
  // Indexed but empty radius → genuinely nothing impacted (CSS-edit case).
  if (emptyRadius) {
    for (const p of candidates) {
      skipped.push({
        ...(await enter(p)),
        reason: `blast radius of '${since}' matched no symbols`,
      });
    }
    return { ...base, since, codemapAvailable: true, selected, skipped };
  }

  for (const p of candidates) {
    const sym = await readCoversSymbol(p);
    if (!sym) {
      skipped.push({
        ...(await enter(p)),
        reason: "no coversSymbol binding",
      });
      continue;
    }
    if (blastSymbols.has(sym)) {
      await pushSelected(p, sym);
      continue;
    }
    const files = (await codemapSemantic(sym, deps))
      .map((s) => s.file)
      .filter((f): f is string => !!f);
    if (files.some((f) => blastFiles.has(f))) {
      await pushSelected(p, sym);
    } else {
      skipped.push({
        ...(await enter(p)),
        reason: `coversSymbol '${sym}' outside blast radius of '${since}'`,
      });
    }
  }
  return { ...base, since, codemapAvailable: true, selected, skipped };
}

function renderSelectionMarkdown(s: SelectionResult): string {
  const filterBits: string[] = [];
  if (s.tags && s.tags.length > 0) {
    filterBits.push(`--tag ${s.tags.join(" --tag ")}`);
  }
  if (s.since) filterBits.push(`--since-codemap ${s.since}`);
  const lines: string[] = [
    "",
    `\x1b[1mSelection\x1b[0m ${s.selected.length} selected, ${s.skipped.length} skipped` +
      (filterBits.length > 0 ? `  (${filterBits.join(", ")})` : ""),
  ];
  if (s.selected.length > 0) {
    lines.push("", "Selected:");
    for (const x of s.selected) {
      const extras: string[] = [];
      if (x.coversSymbol) extras.push(x.coversSymbol);
      if (x.tags && x.tags.length > 0)
        extras.push(`tags: ${x.tags.join(", ")}`);
      lines.push(
        `  \x1b[32m✓\x1b[0m ${x.name}${
          extras.length > 0 ? `  (${extras.join(" · ")})` : ""
        }`,
      );
    }
  }
  if (s.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const x of s.skipped) {
      lines.push(`  \x1b[33m·\x1b[0m ${x.name}  — ${x.reason}`);
    }
  }
  if (!s.codemapAvailable && s.since) {
    lines.push(
      "",
      "\x1b[2m(codemap unavailable — selection degraded to run-all on remaining specs)\x1b[0m",
    );
  }
  return lines.join("\n");
}

async function writeJUnitIfRequested(
  opts: RunCommandOptions,
  results: RunResult[],
): Promise<boolean> {
  if (!opts.junit) return true;
  const outPath = isAbsolutePath(opts.junit)
    ? opts.junit
    : resolve(process.cwd(), opts.junit);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, renderJUnit(results));
    return true;
  } catch (e) {
    runLog.warn(`could not write JUnit report: ${(e as Error).message}`);
    return false;
  }
}

async function stampIfGreen(
  opts: RunCommandOptions,
  results: RunResult[],
): Promise<boolean> {
  if (!opts.stampIfGreen) return true;
  if (results.some((r) => r.status !== "passed")) return true;
  try {
    const paths = new Set(results.map((r) => r.spec.path));
    for (const specPath of paths) await stampSpecContractHash(specPath);
    return true;
  } catch (e) {
    runLog.warn(`could not stamp contract hash: ${(e as Error).message}`);
    return false;
  }
}

export function synthesizeErroredResult(
  specPath: string,
  err: Error,
  extras: { labels?: Record<string, string> } = {},
): RunResult {
  const now = new Date().toISOString();
  const runId = `errored_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const absoluteSpecPath = isAbsolutePath(specPath)
    ? specPath
    : `${process.cwd()}/${specPath}`;
  const message = addEnospcHint(err.message);
  const contractChanged = err instanceof ContractHashMismatchError;
  const exitCode: ExitCode = contractChanged ? 6 : 2;
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
    // joining paths don't crash. The dir itself is never written.
    runDir: `${process.cwd()}/.cairntrace/errored/${runId}`,
    spec: {
      name:
        specPath
          .split("/")
          .pop()
          ?.replace(/\.ya?ml$/, "") ?? "errored",
      path: absoluteSpecPath,
    },
    environment: "local",
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

function renderBatchMarkdown(b: BatchRunResult): string {
  const bannerColor =
    b.exitCode === 0 ? "\x1b[32m" : b.exitCode === 1 ? "\x1b[31m" : "\x1b[33m";
  const lines: string[] = [
    "",
    `${bannerColor}\x1b[1m${b.summary.passed}/${b.summary.total} passed\x1b[0m  ${b.summary.failed} failed  ${b.summary.errored} errored  in ${formatMs(b.totalDurationMs)}`,
    "",
  ];
  const failed = b.results.filter((r) => r.status !== "passed");
  if (failed.length > 0) {
    lines.push("Failing specs:");
    for (const r of failed) {
      lines.push(
        `  - ${r.spec.name} → ${r.runDir}/${r.artifacts.agentContext}`,
      );
    }
  }
  return lines.join("\n");
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}
