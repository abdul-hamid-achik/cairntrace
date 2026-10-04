import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactRedactor } from "../../core/artifacts/ArtifactWriter";
import {
  INVOCATIONS_DIR,
  redactArgv,
  type InvocationJournal,
} from "../../core/artifacts/invocationJournal";
import type { LiveLog } from "../../core/artifacts/liveLog";
import {
  isSensitiveEnvKey,
  registerSecretValues,
} from "../../core/artifacts/redaction";
import type {
  ConfigVarValue,
  EnvironmentRunnerConfig,
} from "../../core/schema/config.v1";
import {
  DelegateRelay,
  type DelegateDiagnostic,
  type DelegatedExitCode,
  type DelegateVerification,
  type RelayedRun,
} from "../../core/delegate/relay";
import {
  RunnerProcess,
  type RunnerExit,
} from "../../core/delegate/runnerProcess";
import { FileLineTail } from "../../core/delegate/stream";
import { resolveTemplateString } from "../../core/parser/parseSpec";
import {
  cairnContextEnv,
  type CairnContextEnvInput,
} from "../../core/processEnv";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DELEGATE_CONTRACT,
  DELEGATE_ENV,
  DELEGATE_LABEL,
  DelegateRequestOptionsSchema,
  IDLE_WARN_MS,
  type DelegatePlan,
  type DelegateRequest,
} from "../../core/schema/delegate.v1";
import type { InvocationPlannedRun } from "../../core/schema/events.v1";
import {
  buildRunNextActions,
  RunResultSchema,
  type InvocationOutcome,
  type RunResult,
} from "../../core/schema/run.v1";
import type { BatchRunResult } from "../../core/schema/runBatch.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import type { Backend, ExitCode } from "../../core/schema/shared";
import { parseLabelFlags } from "../../core/stats/runStats";
import { CAIRN_VERSION } from "../version";
import {
  configPathsOf,
  describeConfigs,
  MULTI_CONFIG_REMEDY,
} from "./lifecycle";
import {
  absoluteSpecPath,
  parseVarFlags,
  resolveRunRuntime,
  runOptionsToArgv,
} from "./options";
import { describeRefusal, type RefusedSpec } from "./policy";
import {
  synthesizeCancelledResult,
  synthesizeInvocationErroredResult,
} from "./results";

/**
 * Engine side of the delegated runner (`environments.<n>.runner`, contract
 * `urn:cairntrace.dev:delegate:v1`, see `src/core/schema/delegate.v1.ts`):
 * which invocations delegate, the runner's resolved command and
 * environment, the request it reads, the masked dry-run plan, the session
 * that spawns the runner and relays its stream (with the asynchronous
 * cancel / timeout and the synchronous signal-path cancel), and the result
 * documents built from the run directories it placed.
 */

/** The environment an invocation resolved to has a runner. */
export interface DelegationTarget {
  runner: EnvironmentRunnerConfig;
  envName: string;
  envAlias?: string;
  configPath: string;
  configDir: string;
  baseUrl?: string;
  vars: Record<string, ConfigVarValue>;
}

/** A delegated invocation that cannot be set up (exit 4, nothing started). */
export class DelegationError extends Error {
  override name = "DelegationError";
  readonly exitCode = 4 as const;
}

/**
 * The runner of the environment `specs` resolve to, when it has one.
 * Every spec's environment is resolved (its own `environment:` without
 * `--env`): one config and one environment per delegated invocation, so an
 * invocation that mixes a runner environment with any other — whatever the
 * spec order — or takes specs from several configs is refused (exit 4).
 * Specs whose environment does not resolve are left to the usual checks;
 * when none resolves to a runner environment, undefined.
 */
export async function resolveDelegation(
  specs: readonly string[],
  opts: Pick<RunInvocationOptions, "env" | "config" | "var">,
  cwd: string,
): Promise<DelegationTarget | undefined> {
  if (specs.length === 0) return undefined;
  const absolute = specs.map((spec) => absoluteSpecPath(spec, cwd));
  // Fast path: no config of these specs declares a runner anywhere.
  const configs = await configPathsOf(absolute, opts);
  let anyRunner = false;
  for (const group of configs.values()) {
    const ctx = await resolveRunRuntime(group[0]!, opts).catch(() => undefined);
    if (
      Object.values(ctx?.config?.environments ?? {}).some(
        (env) => env?.runner !== undefined,
      )
    ) {
      anyRunner = true;
      break;
    }
  }
  if (!anyRunner) return undefined;
  const resolved: Array<{
    spec: string;
    ctx: Awaited<ReturnType<typeof resolveRunRuntime>>;
  }> = [];
  for (const spec of absolute) {
    const ctx = await resolveRunRuntime(spec, opts).catch(() => undefined);
    if (ctx) resolved.push({ spec, ctx });
  }
  const delegated = resolved.find(
    ({ ctx }) =>
      ctx.configPath !== undefined &&
      ctx.config?.environments[ctx.envName]?.runner !== undefined,
  );
  if (!delegated) return undefined;
  const { ctx } = delegated;
  const runner = ctx.config!.environments[ctx.envName]!.runner!;
  if (configs.size > 1) {
    throw new DelegationError(
      `environment "${ctx.envName}" has a runner: a delegated invocation runs the specs of one config, but these come from ${configs.size} (${describeConfigs(configs)}); ${MULTI_CONFIG_REMEDY}`,
    );
  }
  const others = resolved.filter(
    (entry) =>
      entry.ctx.envName !== ctx.envName ||
      entry.ctx.configPath !== ctx.configPath,
  );
  if (others.length > 0) {
    const shown = others
      .slice(0, 3)
      .map(
        (entry) =>
          `${relative(cwd, entry.spec) || entry.spec} → "${entry.ctx.envName}"`,
      )
      .join(", ");
    throw new DelegationError(
      `environment "${ctx.envName}" has a runner (${relative(cwd, delegated.spec) || delegated.spec}), but ${others.length} other spec(s) of this invocation resolve to another environment (${shown}${
        others.length > 3 ? ", …" : ""
      }): a delegated invocation runs one environment and a runner environment never runs locally; run them separately, or pass --env ${ctx.envName} to send them all to the runner`,
    );
  }
  return {
    runner,
    envName: ctx.envName,
    ...(ctx.envAlias ? { envAlias: ctx.envAlias } : {}),
    configPath: ctx.configPath!,
    configDir: ctx.configDir,
    ...(ctx.baseUrl ? { baseUrl: ctx.baseUrl } : {}),
    vars: ctx.vars,
  };
}

/** The runner as it will be spawned. */
export interface RunnerSpawnSpec {
  /** Resolved argv (may hold secret values: never log it). */
  command: string[];
  /** The argv for the journal, plan and narration (redacted). */
  displayCommand: string[];
  cwd: string;
  /** Resolved `runner.env` (secret-bearing). */
  env: Record<string, string>;
  envNames: string[];
  timeoutMs?: number;
  /** `runner.idleTimeoutMs`: the longest silence of the events stream. */
  idleTimeoutMs?: number;
  cancelGraceMs: number;
}

/**
 * Resolve the runner's command, cwd and env: `${env.X}` / `${secrets.X}`
 * from the invocation's scoped env, `${vars.X}` from the environment,
 * `${config.dir}`, `${baseUrl}`. Secret values that resolve (and the
 * values of credential-named `env:` entries) are registered for redaction,
 * so the journal, the plan and the narration never show them. A reference
 * that cannot resolve throws (a config error, exit 4).
 */
export function resolveRunnerSpawn(
  target: DelegationTarget,
  env: Record<string, string | undefined>,
  redactor?: ArtifactRedactor,
): RunnerSpawnSpec {
  const secrets: string[] = [];
  const resolveText = (text: string, label: string): string =>
    resolveTemplateString(text, {
      vars: target.vars,
      env,
      configDir: target.configDir,
      cwd: target.configDir,
      label: `${target.configPath} environments.${target.envName}.${label}`,
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      onEnvValue: (ref) => {
        if (ref.ns === "secrets" || isSensitiveEnvKey(ref.name)) {
          secrets.push(ref.value);
        }
      },
    });
  const { runner } = target;
  const command = runner.command.map((part, index) =>
    resolveText(part, `runner.command[${index}]`),
  );
  const cwdText = runner.cwd ? resolveText(runner.cwd, "runner.cwd") : ".";
  const cwd = isAbsolute(cwdText)
    ? cwdText
    : resolve(target.configDir, cwdText);
  const runnerEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(runner.env ?? {})) {
    const resolved = resolveText(value, `runner.env.${name}`);
    runnerEnv[name] = resolved;
    if (isSensitiveEnvKey(name)) secrets.push(resolved);
  }
  registerSecretValues(secrets.filter((value) => value.trim().length > 0));
  return {
    command,
    displayCommand: redactArgv(command, redactor),
    cwd,
    env: runnerEnv,
    envNames: Object.keys(runnerEnv).toSorted(),
    ...(runner.timeoutMs !== undefined ? { timeoutMs: runner.timeoutMs } : {}),
    ...(runner.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: runner.idleTimeoutMs }
      : {}),
    cancelGraceMs: runner.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
  };
}

/** The planned runs of specs the local environment policy refused. */
export function refusedPlanEntries(
  planned: readonly InvocationPlannedRun[],
  refusals: ReadonlyMap<string, RefusedSpec>,
): Array<{ index: number; spec: string; reason: string }> {
  return planned.flatMap((entry) => {
    const refusal = refusals.get(entry.spec);
    return refusal
      ? [
          {
            index: entry.index,
            spec: entry.spec,
            reason: describeRefusal(refusal),
          },
        ]
      : [];
  });
}

/** A spec path relative to the config directory, POSIX separators. */
function portableSpec(configDir: string, spec: string): string {
  const rel = relative(configDir, spec);
  return (rel === "" ? basename(spec) : rel).split(sep).join("/");
}

/** The request a runner reads (real values; never written outside a 0600 file). */
export function buildDelegateRequest(input: {
  invocationId: string;
  target: DelegationTarget;
  suite?: string;
  /** Absolute paths of the specs that will run (refused ones excluded). */
  specs: readonly string[];
  /** The local plan, refused entries included (they move to `refused`). */
  planned: readonly InvocationPlannedRun[];
  /** Planned runs the local environment policy refused. */
  refused?: ReadonlyArray<{ index: number; spec: string; reason: string }>;
  /** The options as the caller gave them. */
  rawOptions: RunInvocationOptions;
  /** The options after `--suite` applied its defaults. */
  resolvedOptions: RunInvocationOptions;
  artifactRoot: string;
  journalDir: string;
  eventsPath: string;
  spawn: Pick<RunnerSpawnSpec, "timeoutMs" | "idleTimeoutMs" | "cancelGraceMs">;
  now?: Date;
}): DelegateRequest {
  const { target } = input;
  const picked = DelegateRequestOptionsSchema.strip().safeParse(
    input.rawOptions,
  );
  const options = picked.success ? picked.data : {};
  const specs = input.specs.map((spec) => portableSpec(target.configDir, spec));
  const resolved = input.resolvedOptions;
  const refused = input.refused ?? [];
  const refusedIndexes = new Set(refused.map((entry) => entry.index));
  // A suite runs by name on the remote side (its hooks, vars and labels
  // come with it); when the local policy refused some of its specs, the
  // explicit list of the others narrows it, so a refused spec never runs.
  const cairnArgs = [
    ...runOptionsToArgv(
      input.suite === undefined || refused.length > 0 ? specs : [],
      {
        ...options,
        ...(input.suite !== undefined ? { suite: input.suite } : {}),
      },
    ),
    "--label",
    `${DELEGATE_LABEL}=${input.invocationId}`,
  ];
  return {
    $schema: DELEGATE_CONTRACT,
    version: 1,
    cairnVersion: CAIRN_VERSION,
    invocationId: input.invocationId,
    createdAt: (input.now ?? new Date()).toISOString(),
    env: target.envName,
    ...(target.envAlias ? { envAlias: target.envAlias } : {}),
    configPath: target.configPath,
    configDir: target.configDir,
    ...(input.suite !== undefined ? { suite: input.suite } : {}),
    specs,
    planned: input.planned
      .filter((entry) => !refusedIndexes.has(entry.index))
      .map((entry) => ({
        ...entry,
        spec: portableSpec(target.configDir, entry.spec),
      })),
    ...(refused.length > 0
      ? {
          refused: refused.map((entry) => ({
            index: entry.index,
            spec: portableSpec(target.configDir, entry.spec),
            reason: entry.reason,
          })),
        }
      : {}),
    options,
    resolved: {
      vars: parseVarFlags(resolved.var),
      labels: parseLabelFlags(resolved.label),
      bail: resolved.bail === true,
      parallel: Math.max(1, resolved.parallel ?? 1),
      ...(resolved.tag && resolved.tag.length > 0
        ? { tags: [...resolved.tag] }
        : {}),
    },
    ...(input.rawOptions.runToken !== undefined
      ? { runToken: input.rawOptions.runToken }
      : {}),
    cairnArgs,
    artifactRootLocal: input.artifactRoot,
    journalDirLocal: input.journalDir,
    eventsPath: input.eventsPath,
    ...(input.spawn.timeoutMs !== undefined
      ? { timeoutMs: input.spawn.timeoutMs }
      : {}),
    ...(input.spawn.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: input.spawn.idleTimeoutMs }
      : {}),
    cancelGraceMs: input.spawn.cancelGraceMs,
  };
}

function maskPairs(pairs: readonly string[] | undefined): string[] | undefined {
  return pairs?.map((pair) => {
    const eq = pair.indexOf("=");
    return eq > 0 && isSensitiveEnvKey(pair.slice(0, eq))
      ? `${pair.slice(0, eq)}=[redacted]`
      : pair;
  });
}

/**
 * The request with every secret masked: `--var` / `--label` values under a
 * credential-like key, registered secret values and literal credentials
 * (the redactor). What the journal keeps and the dry-run plan shows.
 */
export function maskDelegateRequest(
  request: DelegateRequest,
  redactor?: ArtifactRedactor,
): Record<string, unknown> {
  const masked: DelegateRequest = {
    ...request,
    options: {
      ...request.options,
      ...(request.options.var ? { var: maskPairs(request.options.var) } : {}),
      ...(request.options.label
        ? { label: maskPairs(request.options.label) }
        : {}),
    },
    resolved: {
      ...request.resolved,
      vars: Object.fromEntries(
        Object.entries(request.resolved.vars).map(([key, value]) => [
          key,
          isSensitiveEnvKey(key) ? "[redacted]" : value,
        ]),
      ),
      labels: Object.fromEntries(
        Object.entries(request.resolved.labels).map(([key, value]) => [
          key,
          isSensitiveEnvKey(key) ? "[redacted]" : value,
        ]),
      ),
    },
    cairnArgs: redactArgv(request.cairnArgs, redactor),
  };
  const value = redactor ? redactor.value(masked) : masked;
  return value as unknown as Record<string, unknown>;
}

/** `--services-dry-run` / `--select-only`: what would be spawned. */
export function buildDelegatePlan(
  target: DelegationTarget,
  spawn: RunnerSpawnSpec,
  request: DelegateRequest,
  redactor?: ArtifactRedactor,
): DelegatePlan {
  return {
    contract: DELEGATE_CONTRACT,
    env: target.envName,
    command: spawn.displayCommand,
    cwd: spawn.cwd,
    envNames: spawn.envNames,
    ...(spawn.timeoutMs !== undefined ? { timeoutMs: spawn.timeoutMs } : {}),
    ...(spawn.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: spawn.idleTimeoutMs }
      : {}),
    cancelGraceMs: spawn.cancelGraceMs,
    request: maskDelegateRequest(request, redactor),
  };
}

/** The plan as text (stderr of `--services-dry-run` / `--select-only`). */
export function renderDelegatePlan(plan: DelegatePlan): string {
  const lines = [
    `delegated runner (${plan.contract}) for environment "${plan.env}" — nothing was spawned:`,
    `  command: ${plan.command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")}`,
    `  cwd: ${plan.cwd}`,
    `  env: ${
      plan.envNames.length > 0
        ? `${plan.envNames.join(", ")} (values not shown)`
        : "(none beyond the scoped env)"
    }`,
    `  timeoutMs: ${plan.timeoutMs ?? "none"} · idleTimeoutMs: ${plan.idleTimeoutMs ?? "none"} · cancelGraceMs: ${plan.cancelGraceMs}`,
    "  locally: run policy lock + preflight + finally; no services, webServer, browser, suite hooks, metrics or verifyClean",
    "  request (CAIRN_DELEGATE_REQUEST, masked):",
    ...JSON.stringify(plan.request, null, 2)
      .split("\n")
      .map((line) => `    ${line}`),
  ];
  return `${lines.join("\n")}\n`;
}

/* ----- the session ----- */

export interface DelegateSessionHooks {
  /** Batch-level narration (journal + UI) on the async path. */
  note: (kind: "info" | "warn", message: string) => void;
  /** Narration on the synchronous signal path (stderr only). */
  signalNote: (message: string) => void;
  onRunStarted?: (run: RelayedRun) => void;
  onRunFinished?: (run: RelayedRun) => void;
  onProgress?: (message: string) => void;
  onDiagnostic?: (diagnostic: DelegateDiagnostic) => void;
  /** One line of the runner's stdout / stderr (redacted). */
  onOutputLine?: (line: string) => void;
}

export interface DelegateSessionInput {
  invocationId: string;
  journal: InvocationJournal;
  artifactRoot: string;
  /** The local plan, refused entries included. */
  planned: readonly InvocationPlannedRun[];
  /** Planned indexes the local environment policy refused. */
  refusedIndexes?: ReadonlySet<number>;
  /** The config directory (remote spec paths are matched relative to it). */
  configDir: string;
  spawn: RunnerSpawnSpec;
  /** Builds the request once the events path is known. */
  request: (paths: { eventsPath: string }) => DelegateRequest;
  redactor: ArtifactRedactor;
  /** The scoped child env (+ CAIRN_ENV / CAIRN_BASE_URL / CAIRN_CONFIG_DIR). */
  childEnv: Record<string, string | undefined>;
  context: CairnContextEnvInput;
  hooks: DelegateSessionHooks;
  /** Stream poll cadence (default 250ms). */
  pollMs?: number;
  /** Silence after which the stream is warned about once (default 5 minutes). */
  idleWarnMs?: number;
}

export interface DelegateSettled {
  exit: RunnerExit;
  cancelled: boolean;
  timedOut: boolean;
  /** Cancelled after `runner.idleTimeoutMs` without a stream line. */
  idle: boolean;
  /** The signal path settled the session first (the process is exiting). */
  terminated: boolean;
  verification: DelegateVerification;
  durationMs: number;
}

type CancelReason = "cancel" | "timeout" | "idle" | "signal";

/** Names under the artifact root right now (empty when it cannot be read). */
function artifactRootNames(artifactRoot: string): Set<string> {
  try {
    return new Set(readdirSync(artifactRoot));
  } catch {
    return new Set();
  }
}

/**
 * One delegated runner: spawns it, tails its events stream and its output
 * into the journal, cancels it (MCP cancel, `runner.timeoutMs`,
 * `runner.idleTimeoutMs`, or a signal — synchronously, keeping the relay
 * going while it waits), verifies the run directories it placed and
 * records `delegate.*` events.
 */
export class DelegateSession {
  readonly relay: DelegateRelay;
  private runner: RunnerProcess | undefined;
  private readonly tempDir: string;
  private readonly eventsPath: string;
  private readonly outputPath: string;
  private readonly requestPath: string;
  private readonly events: FileLineTail;
  private readonly output: FileLineTail;
  private outputLog: LiveLog | undefined;
  private cancelReason: CancelReason | undefined;
  private cancelling: Promise<void> | undefined;
  private recorded = false;
  private terminated = false;
  private readonly startedAt = Date.now();
  /** When the events stream last gained a line (or the runner started). */
  private lastLineAt = Date.now();
  private idleWarned = false;

  constructor(private readonly input: DelegateSessionInput) {
    this.relay = new DelegateRelay({
      journal: input.journal,
      artifactRoot: input.artifactRoot,
      planned: input.planned,
      configDir: input.configDir,
      invocationId: input.invocationId,
      ...(input.refusedIndexes ? { refusedIndexes: input.refusedIndexes } : {}),
      // What is under the artifact root before the runner exists: a relayed
      // run naming one of these is an earlier run, not this invocation's.
      preexisting: artifactRootNames(input.artifactRoot),
      ...(input.hooks.onRunStarted
        ? { onRunStarted: input.hooks.onRunStarted }
        : {}),
      ...(input.hooks.onRunFinished
        ? { onRunFinished: input.hooks.onRunFinished }
        : {}),
      ...(input.hooks.onProgress ? { onProgress: input.hooks.onProgress } : {}),
      ...(input.hooks.onDiagnostic
        ? { onDiagnostic: input.hooks.onDiagnostic }
        : {}),
    });
    this.tempDir = mkdtempSync(join(tmpdir(), "cairn-delegate-"));
    chmodSync(this.tempDir, 0o700);
    this.eventsPath = join(this.tempDir, "events.ndjson");
    this.outputPath = join(this.tempDir, "runner.log");
    this.requestPath = join(this.tempDir, "request.json");
    writeFileSync(this.eventsPath, "", { mode: 0o600 });
    this.events = new FileLineTail(this.eventsPath);
    this.output = new FileLineTail(this.outputPath);
  }

  /** Spawn the runner and relay until it exited. */
  async run(): Promise<DelegateSettled> {
    const { journal, spawn } = this.input;
    const request = this.input.request({ eventsPath: this.eventsPath });
    writeFileSync(this.requestPath, `${JSON.stringify(request, null, 2)}\n`, {
      mode: 0o600,
    });
    this.writeJournalRequest(request);
    journal.setDelegate({
      contract: DELEGATE_CONTRACT,
      command: spawn.displayCommand,
    });
    this.outputLog = journal.delegateLog();
    const env: NodeJS.ProcessEnv = {
      ...this.input.childEnv,
      ...cairnContextEnv(this.input.context),
      ...spawn.env,
      [DELEGATE_ENV.request]: this.requestPath,
      [DELEGATE_ENV.events]: this.eventsPath,
      [DELEGATE_ENV.contract]: DELEGATE_CONTRACT,
      [DELEGATE_ENV.invocationId]: this.input.invocationId,
      [DELEGATE_ENV.invocationDir]: journal.dir,
      [DELEGATE_ENV.artifactRoot]: this.input.artifactRoot,
    };
    const runner = RunnerProcess.spawn({
      command: spawn.command,
      cwd: spawn.cwd,
      env,
      outputPath: this.outputPath,
    });
    this.runner = runner;
    this.lastLineAt = Date.now();
    journal.appendEvent({
      ts: new Date().toISOString(),
      type: "delegate.started",
      contract: DELEGATE_CONTRACT,
      command: spawn.displayCommand,
      cwd: spawn.cwd,
      ...(runner.pid !== undefined ? { pid: runner.pid } : {}),
      ...(spawn.timeoutMs !== undefined ? { timeoutMs: spawn.timeoutMs } : {}),
      cancelGraceMs: spawn.cancelGraceMs,
    });
    if (runner.pid !== undefined) journal.setDelegate({ pid: runner.pid });
    void journal.tracker.enter("steps", { item: "delegated runner" });
    this.input.hooks.note(
      "info",
      `delegating environment "${request.env}" to its runner: ${spawn.displayCommand.join(" ")}`,
    );
    const poll = setInterval(() => {
      this.pump(false);
      this.checkIdle();
    }, this.input.pollMs ?? 250);
    const deadline =
      spawn.timeoutMs !== undefined
        ? setTimeout(() => this.cancel("timeout"), spawn.timeoutMs)
        : undefined;
    let exit: RunnerExit;
    try {
      exit = await runner.exited;
    } finally {
      clearInterval(poll);
      if (deadline) clearTimeout(deadline);
    }
    if (this.cancelling) await this.cancelling;
    if (this.terminated) {
      return this.settledResult(exit);
    }
    this.pump(true);
    runner.killLeftovers();
    this.record(exit, this.verifyFor(exit));
    return this.settledResult(exit);
  }

  /**
   * The run-directory check, once: with planned-run coverage only when the
   * runner exited on its own claiming a result (0 or 1).
   */
  private verifyFor(exit: RunnerExit): DelegateVerification {
    return this.relay.verify({
      coverage:
        this.cancelReason === undefined &&
        (exit.exitCode === 0 || exit.exitCode === 1),
    });
  }

  private settledResult(exit: RunnerExit): DelegateSettled {
    return {
      exit,
      cancelled:
        this.cancelReason === "cancel" || this.cancelReason === "signal",
      timedOut: this.cancelReason === "timeout",
      idle: this.cancelReason === "idle",
      terminated: this.terminated,
      verification: this.verifyFor(exit),
      durationMs: Date.now() - this.startedAt,
    };
  }

  /** Relay what the stream and the output gained since the last call. */
  private pump(final: boolean): void {
    const lines = this.events.read(final);
    if (lines.length > 0) {
      this.lastLineAt = Date.now();
      this.idleWarned = false;
    }
    for (const line of lines) this.relay.consume(line);
    for (const line of this.output.read(final)) {
      this.outputLog?.writeLine(line);
      this.input.hooks.onOutputLine?.(this.input.redactor.text(line));
    }
  }

  /**
   * A silent stream: one `idle` warning per silence past `idleWarnMs`, and
   * past `runner.idleTimeoutMs` a cancel like the deadline's (exit 2). Any
   * line counts, remote heartbeats included.
   */
  private checkIdle(): void {
    if (this.cancelReason || !this.runner || this.runner.settled) return;
    const silentMs = Date.now() - this.lastLineAt;
    const { idleTimeoutMs } = this.input.spawn;
    if (idleTimeoutMs !== undefined && silentMs >= idleTimeoutMs) {
      this.cancel("idle");
      return;
    }
    const warnMs = this.input.idleWarnMs ?? IDLE_WARN_MS;
    if (!this.idleWarned && silentMs >= warnMs) {
      this.idleWarned = true;
      this.relay.diagnose({
        level: "warn",
        code: "idle",
        message: `the runner's events stream has been silent for ${Math.round(silentMs / 1000)}s (a followed remote journal beats every 15s)${
          idleTimeoutMs !== undefined
            ? `; it is cancelled at runner.idleTimeoutMs (${idleTimeoutMs}ms)`
            : "; set runner.idleTimeoutMs to cancel a runner that hangs"
        }`,
      });
    }
  }

  /**
   * A graceful cancel (MCP `cairn_run_cancel`), the runner's deadline or a
   * silent stream: SIGINT to the runner's pid, `cancelGraceMs`, SIGTERM to
   * its process group, 10s, SIGKILL. The relay keeps going; `run()`
   * settles once the runner exited.
   */
  cancel(reason: "cancel" | "timeout" | "idle"): void {
    const runner = this.runner;
    if (!runner || runner.settled || this.cancelReason) return;
    this.cancelReason = reason;
    const { journal, spawn } = this.input;
    const start = Date.now();
    journal.appendEvent({
      ts: new Date().toISOString(),
      type: "delegate.cancel.requested",
      reason,
      signal: "SIGINT",
      graceMs: spawn.cancelGraceMs,
    });
    if (reason === "timeout") {
      this.relay.diagnose({
        level: "error",
        code: "timeout",
        message: `the runner outlived runner.timeoutMs (${spawn.timeoutMs}ms): cancelling it`,
      });
    } else if (reason === "idle") {
      this.relay.diagnose({
        level: "error",
        code: "idle",
        message: `the runner's events stream stayed silent for runner.idleTimeoutMs (${spawn.idleTimeoutMs}ms): cancelling it`,
      });
    }
    journal.setDelegate(
      reason === "timeout"
        ? { timedOut: true }
        : reason === "idle"
          ? { idle: true }
          : { cancelled: true },
    );
    this.input.hooks.note(
      "warn",
      `${
        reason === "timeout"
          ? "runner timed out"
          : reason === "idle"
            ? "runner went silent"
            : "cancel requested"
      }: SIGINT sent to the delegated runner; it has ${Math.round(spawn.cancelGraceMs / 1000)}s to cancel its remote invocation and copy the results back`,
    );
    this.cancelling = runner
      .cancel(spawn.cancelGraceMs, (signal, afterMs) => {
        journal.appendEvent({
          ts: new Date().toISOString(),
          type: "delegate.cancel.escalated",
          signal,
          afterMs,
        });
        this.input.hooks.note(
          "warn",
          `the delegated runner is still running after ${Math.round(afterMs / 1000)}s: ${signal} to its process group`,
        );
      })
      .then((outcome) => {
        journal.appendEvent({
          ts: new Date().toISOString(),
          type: "delegate.cancel.finished",
          durationMs: Date.now() - start,
          graceful: outcome.graceful,
          ...(outcome.stillRunning ? { stillRunning: true as const } : {}),
        });
      });
  }

  /**
   * The signal path (Ctrl-C, SIGTERM, Studio's Stop / Live Cancel), fully
   * synchronous: SIGINT to the runner's pid, then wait for it — up to
   * `cancelGraceMs`, then SIGTERM, then SIGKILL to its group — while the
   * stream keeps being relayed and the heartbeat keeps beating; then the
   * last lines, the run-directory check and `delegate.finished`. The caller
   * marks the journal aborted afterwards. Idempotent.
   */
  cancelSync(signal: "SIGINT" | "SIGTERM"): void {
    if (this.recorded) return;
    this.terminated = true;
    const runner = this.runner;
    const { journal, spawn } = this.input;
    if (runner && runner.isRunningSync()) {
      this.cancelReason = "signal";
      const start = Date.now();
      journal.appendEvent({
        ts: new Date().toISOString(),
        type: "delegate.cancel.requested",
        reason: "signal",
        trigger: signal,
        signal: "SIGINT",
        graceMs: spawn.cancelGraceMs,
      });
      journal.setDelegate({ cancelled: true });
      this.input.hooks.signalNote(
        `cancelling the delegated runner: SIGINT sent to it; waiting up to ${Math.round(spawn.cancelGraceMs / 1000)}s for it to cancel its remote invocation and copy the results back (further Ctrl-C is ignored; SIGKILL forces)`,
      );
      let lastBeat = Date.now();
      const outcome = runner.cancelSync(
        spawn.cancelGraceMs,
        (escalation, afterMs) => {
          journal.appendEvent({
            ts: new Date().toISOString(),
            type: "delegate.cancel.escalated",
            signal: escalation,
            afterMs,
          });
          this.input.hooks.signalNote(
            `the delegated runner is still running after ${Math.round(afterMs / 1000)}s: ${escalation} to its process group`,
          );
        },
        () => {
          this.pump(false);
          if (Date.now() - lastBeat >= 15_000) {
            lastBeat = Date.now();
            void journal.tracker.beat();
          }
        },
      );
      journal.appendEvent({
        ts: new Date().toISOString(),
        type: "delegate.cancel.finished",
        durationMs: Date.now() - start,
        graceful: outcome.graceful,
        ...(outcome.stillRunning ? { stillRunning: true as const } : {}),
      });
    }
    this.pump(true);
    runner?.killLeftovers();
    const exit = runner?.settled ?? {};
    this.record(exit, this.verifyFor(exit));
  }

  /** `delegate.finished`, the journal's delegate block, and the temp files gone. */
  private record(exit: RunnerExit, verification: DelegateVerification): void {
    if (this.recorded) return;
    this.recorded = true;
    const { journal } = this.input;
    const finishedRuns = this.relay
      .runList()
      .filter((run) => run.status !== undefined).length;
    journal.appendEvent({
      ts: new Date().toISOString(),
      type: "delegate.finished",
      durationMs: Date.now() - this.startedAt,
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
      ...(exit.signal ? { signal: exit.signal } : {}),
      ...(this.cancelReason === "cancel" || this.cancelReason === "signal"
        ? { cancelled: true as const }
        : {}),
      ...(this.cancelReason === "timeout" ? { timedOut: true as const } : {}),
      ...(this.cancelReason === "idle" ? { idle: true as const } : {}),
      relayed: this.relay.relayed,
      runs: finishedRuns,
      missingRunDirs: verification.missing.length + verification.foreign.length,
      diagnostics: this.relay.diagnostics.length,
    });
    journal.setDelegate({
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
      ...(exit.signal ? { signal: exit.signal } : {}),
      diagnostics: this.relay.diagnostics.length,
    });
    this.cleanup();
  }

  /** The journal's copy of the request (masked). */
  private writeJournalRequest(request: DelegateRequest): void {
    try {
      const dir = join(this.input.journal.dir, "delegate");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(dir, "request.json"),
        `${JSON.stringify(maskDelegateRequest(request, this.input.redactor), null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Evidence only; the runner reads the private copy.
    }
  }

  /** Remove the private copies (real request, raw stream and output). */
  cleanup(): void {
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // A temp dir the OS cleans eventually.
    }
  }
}

/* ----- results ----- */

/** A run directory's run.json as a RunResult, when the runner placed one. */
export function readSettledRun(runDir: string): RunResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  } catch {
    return undefined;
  }
  const parsed = RunResultSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // A newer remote cairn may write fields this build does not know: keep
  // the document as written when it still looks like a run.
  const run = value as Partial<RunResult> | null;
  return run &&
    typeof run.runId === "string" &&
    typeof run.status === "string" &&
    typeof run.spec?.name === "string"
    ? (run as RunResult)
    : undefined;
}

/**
 * The result documents of a delegated invocation, in plan order: each
 * finished run's `run.json` from the local artifact root when the relay
 * vouched for it (this run, this invocation's label, fresh), else an
 * errored stand-in, then the specs the local environment policy refused.
 * With nothing at all (the runner crashed before any run), one errored (or
 * cancelled) result per spec it was to run.
 */
export function delegatedResults(input: {
  runs: readonly RelayedRun[];
  refused: readonly RunResult[];
  specs: readonly string[];
  exitCode: DelegatedExitCode;
  error?: string;
  cancelled: boolean;
  labels: Record<string, string>;
  backend: Backend;
  environment: string;
  cwd: string;
}): RunResult[] {
  const extras = {
    labels: input.labels,
    backend: input.backend,
    environment: input.environment,
  };
  const results: RunResult[] = [];
  for (const run of input.runs) {
    if (run.status === undefined) continue;
    const onDisk = run.verified ? readSettledRun(run.runDir) : undefined;
    if (onDisk) {
      // run.json is the remote cairn's own record (its runDir is a path on
      // the other machine); the document points at the local copy, which
      // every relative artifact path resolves against.
      results.push({ ...onDisk, runDir: run.runDir });
      continue;
    }
    const message = run.synthetic
      ? `the remote run of ${basename(run.spec)} ${run.status} before its run directory was written`
      : `the delegated runner reported ${basename(run.spec)} ${run.streamStatus ?? run.status}, but ${join(run.runDir, "run.json")} is missing or not this invocation's (see its delegate.diagnostic)`;
    results.push(
      synthesizeInvocationErroredResult(
        run.spec,
        message,
        2,
        extras,
        input.cwd,
      ),
    );
  }
  results.push(...input.refused);
  if (results.length > 0) return results;
  return input.specs.map((spec) =>
    input.cancelled
      ? synthesizeCancelledResult(spec, { labels: input.labels }, input.cwd)
      : synthesizeInvocationErroredResult(
          spec,
          input.error ?? "the delegated runner produced no run",
          isExitCode(input.exitCode) && input.exitCode !== 0
            ? input.exitCode
            : 2,
          extras,
          input.cwd,
        ),
  );
}

function isExitCode(code: number): code is ExitCode {
  return Number.isInteger(code) && code >= 0 && code <= 9;
}

/**
 * A result document with the delegated verdict: `invocationOutcome` always
 * (with its `delegate` block); the top-level `exitCode` of a batch is the
 * invocation's (a signal's 130 / 143 leaves the specs' own), and a single
 * run that passed reads `errored` (`failure.phase: invocation`) when the
 * invocation settled on another code.
 */
export function withDelegatedOutcome(
  document: RunResult | BatchRunResult,
  outcome: InvocationOutcome,
): RunResult | BatchRunResult {
  const code = outcome.exitCode;
  if (document.$schema === "urn:cairntrace.dev:run-batch:v1") {
    return {
      ...document,
      ...(isExitCode(code) ? { exitCode: code } : {}),
      invocationOutcome: outcome,
    };
  }
  const run = document as RunResult;
  if (!isExitCode(code) || run.exitCode === code) {
    return { ...run, invocationOutcome: outcome };
  }
  const message = outcome.error ?? `the invocation settled on exit ${code}`;
  const next: RunResult = {
    ...run,
    exitCode: code,
    invocationOutcome: outcome,
    ...(run.status === "passed"
      ? {
          status: "errored" as const,
          summary: `the spec passed, then the invocation failed (exit ${code}): ${message}`,
          failure: { phase: "invocation", message },
        }
      : {}),
  };
  return run.status === "passed" && run.nextActions !== undefined
    ? { ...next, nextActions: buildRunNextActions(next) }
    : next;
}

/** The would-be journal directory of an invocation (dry runs). */
export function journalDirOf(
  artifactRoot: string,
  invocationId: string,
): string {
  return join(artifactRoot, INVOCATIONS_DIR, invocationId);
}
