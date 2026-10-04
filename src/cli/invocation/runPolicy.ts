import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import type { ArtifactRedactor } from "../../core/artifacts/ArtifactWriter";
import { cairnContextEnv } from "../../core/processEnv";
import { canonicalConfigPath } from "../../core/runner/services";
import type { CriticalTeardownFailure } from "../../core/runner/services";
import type { GateNode } from "../../core/gates/schema";
import type { ServicesConfig } from "../../core/schema/config.v1";
import type { InvocationSummary } from "../../core/schema/events.v1";
import {
  resolveCleanlinessTargets,
  verifyClean,
  type CleanlinessFinding,
  type CommandRunner,
} from "../../core/runPolicy/cleanliness";
import {
  finallyTimeoutMs,
  runFinallyCommands,
  runShellCommandSync,
  signalTimeout,
  type SignalBudget,
} from "../../core/runPolicy/finally";
import {
  acquireRunLock,
  RunLockRefusedError,
  runLockTarget,
  type RunLockHandle,
} from "../../core/runPolicy/lock";
import type { ProcessProbe } from "../../core/runPolicy/processProbe";
import {
  describePreflightCheck,
  runPreflight,
  selectPreflightChecks,
} from "../../core/runPolicy/preflight";
import type { RunPolicyConfig } from "../../core/runPolicy/schema";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import type { ScopedSecrets } from "../commands/secrets";
import { loadConfig } from "../../core/config/loader";
import { UnknownEnvironmentError } from "../../core/config/runtimeContext";
import {
  configPathsOf,
  describeConfigs,
  MULTI_CONFIG_REMEDY,
} from "./lifecycle";
import { absoluteSpecPath, resolveRunRuntime } from "./options";

/**
 * The run engine's side of the config `run:` block (F8): resolves the
 * effective policy of the invocation, and runs its phases — lock, preflight,
 * verifyClean, finally — recording each in the invocation journal. The pure
 * pieces live in `src/core/runPolicy/`; this file only wires them to the
 * journal, the scoped secrets and the engine's narration.
 */

/** Test seams (and nothing else): where the policy looks at the machine. */
export interface RunPolicyDeps {
  probe?: ProcessProbe;
  run?: CommandRunner;
  lockRoot?: string;
  ledgerRoot?: string;
  /** agent-browser's state directory (`<session>.pid` files). */
  agentBrowserStateDir?: string;
}

export interface ResolvedRunPolicy {
  policy: RunPolicyConfig;
  configPath?: string;
  /** The config directory (or the first spec's directory without a config). */
  configDir: string;
  project?: string;
  envName: string;
  services?: ServicesConfig;
  gates?: Readonly<Record<string, GateNode>>;
}

/** Does the policy ask for anything? */
export function runPolicyActive(policy: RunPolicyConfig | undefined): boolean {
  if (!policy) return false;
  return (
    (policy.lock !== undefined && policy.lock !== false) ||
    (policy.preflight?.length ?? 0) > 0 ||
    (policy.verifyClean?.length ?? 0) > 0 ||
    (policy.finally?.length ?? 0) > 0
  );
}

/**
 * The run policy could not be settled for this invocation: its config does
 * not load, or its specs come from several configs (or environments) whose
 * policies differ. A refusal before anything starts (exit 4).
 */
export class RunPolicyResolutionError extends Error {
  override name = "RunPolicyResolutionError";
  readonly exitCode = 4 as const;
}

/** Deep copy with object keys sorted (stable JSON). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Stable JSON of a policy, for "are these the same policy". */
function policyKey(policy: RunPolicyConfig | undefined): string {
  return JSON.stringify(sortKeys(policy ?? null));
}

/** A spec's own `environment:` (undefined when unset or unreadable). */
async function peekEnvironment(spec: string): Promise<string | undefined> {
  try {
    const raw: unknown = parseYaml(await readFile(spec, "utf8"));
    const env =
      raw !== null && typeof raw === "object"
        ? (raw as { environment?: unknown }).environment
        : undefined;
    return typeof env === "string" && env.length > 0 ? env : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The effective policy of the invocation, resolved for EVERY spec it will
 * run (each spec finds its own config, and its `environment:` may pick
 * another `environments.<n>.run`): undefined when none of them asks for
 * anything. One lock / preflight / clean-machine check covers one config:
 * specs from several configs where any declares a `run:` policy — or one
 * config whose environments give them different policies — are refused
 * (`RunPolicyResolutionError`, exit 4) instead of guarding only the first
 * spec's config. A config that does not load refuses too (never "no
 * policy"); a spec that cannot be read is left to fail on its own.
 */
export async function resolveRunPolicy(
  specs: readonly string[],
  opts: Pick<RunInvocationOptions, "env" | "config" | "var">,
  scopedSecrets: ScopedSecrets,
  cwd: string,
): Promise<ResolvedRunPolicy | undefined> {
  type Entry = {
    spec: string;
    configPath: string | undefined;
    envName: string;
    ctx: Awaited<ReturnType<typeof resolveRunRuntime>>;
    active: boolean;
  };
  const absolute = specs.map((spec) => absoluteSpecPath(spec, cwd));
  // The policy depends on the config and the environment only: resolve it
  // once per (config, environment) group, not once per spec.
  const configs = await configPathsOf(absolute, opts);
  const groups = new Map<string, string[]>();
  for (const [configPath, members] of configs) {
    for (const spec of members) {
      const env = opts.env ?? (await peekEnvironment(spec)) ?? "";
      const key = `${configPath ?? ""}\u0000${env}`;
      groups.set(key, [...(groups.get(key) ?? []), spec]);
    }
  }
  const entries: Entry[] = [];
  for (const members of groups.values()) {
    for (const spec of members) {
      let ctx: Entry["ctx"];
      try {
        ctx = await resolveRunRuntime(spec, opts, { env: scopedSecrets.env });
      } catch (error) {
        // The config, or this spec? A config that loads means the spec
        // itself is unreadable: it errors when it runs; try the next one.
        const configError = await loadConfig(spec, opts.config, {
          env: scopedSecrets.env,
        }).then(
          () => undefined,
          (loadError: unknown) => loadError,
        );
        if (
          configError === undefined &&
          !(error instanceof UnknownEnvironmentError)
        ) {
          continue;
        }
        throw new RunPolicyResolutionError(
          `refusing to start: the config run: policy of ${spec} cannot be resolved: ${
            ((configError ?? error) as Error).message
          }`,
        );
      }
      entries.push({
        spec,
        configPath: ctx.configPath,
        envName: ctx.envName,
        ctx,
        active: runPolicyActive(ctx.runPolicy),
      });
      break;
    }
  }
  const active = entries.filter((entry) => entry.active);
  if (active.length === 0) return undefined;
  if (configs.size > 1) {
    const declaring = [
      ...new Set(active.map((entry) => entry.configPath ?? "(no config)")),
    ];
    throw new RunPolicyResolutionError(
      `refusing to start: the specs of this invocation come from ${configs.size} configs (${describeConfigs(configs)}) and ${declaring.join(", ")} declare${
        declaring.length === 1 ? "s" : ""
      } a run: policy (lock, preflight, verifyClean, finally), which guards one config; ${MULTI_CONFIG_REMEDY}`,
    );
  }
  const policies = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.active ? policyKey(entry.ctx.runPolicy) : "none";
    policies.set(key, [
      ...new Set([...(policies.get(key) ?? []), entry.envName]),
    ]);
  }
  if (policies.size > 1) {
    throw new RunPolicyResolutionError(
      `refusing to start: the specs of this invocation resolve different run: policies (environments ${[
        ...new Set(entries.map((entry) => entry.envName)),
      ].join(
        ", ",
      )} of ${active[0]!.configPath ?? "the config"}); run one environment at a time (--env <name>)`,
    );
  }
  const { ctx, spec } = active[0]!;
  return {
    policy: ctx.runPolicy!,
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    configDir: ctx.configPath ? dirname(ctx.configPath) : dirname(spec),
    ...(ctx.config?.project ? { project: ctx.config.project } : {}),
    envName: ctx.envName,
    ...(ctx.services ? { services: ctx.services } : {}),
    ...(ctx.config?.gates ? { gates: ctx.config.gates } : {}),
  };
}

export interface PolicySessionOptions {
  invocationId: string;
  origin: "cli" | "mcp";
  /** The invocation's argv (redacted before it is stored in the lock). */
  argv: readonly string[];
  cwd: string;
  scopedSecrets: ScopedSecrets;
  redactor: ArtifactRedactor;
  journal: InvocationJournal | undefined;
  note: (kind: "info" | "warn", message: string) => void;
  signal?: AbortSignal;
  /** `--reuse-services`: the stack is `cairn services up`'s, so it is left alone and unchecked. */
  reuseServices?: boolean;
  deps?: RunPolicyDeps;
  /** Pids that are cairn itself (never survivors). */
  ignorePids?: readonly number[];
  /** Redacts one argv list for the lock file. */
  redactArgv: (argv: readonly string[]) => string[];
  /** `--suite`: the suite of this run (preflight `when.suite`). */
  suite?: string;
  /**
   * The environment runs on a delegated runner: the lock is that
   * environment's alone (see `runLockTarget`).
   */
  lockEnvironment?: string;
}

/** How long the after-run check waits for survivors to exit (ms). */
function cleanGraceMs(): number {
  const raw = Number(process.env.CAIRN_VERIFY_CLEAN_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3_000;
}

/** A dirty finding of one phase. */
export interface DirtyFinding extends CleanlinessFinding {
  phase: "before" | "after";
}

export class RunPolicySession {
  private lock: RunLockHandle | undefined;
  private readonly dirty: DirtyFinding[] = [];
  private finallyFailed = 0;
  /** `run.finally` entries that finished (the signal path runs the rest). */
  private finallyDone = 0;
  /** Remembered at acquisition: the lock is released before the summary is written. */
  private lockSummary:
    | { path: string; scope: "project" | "config"; reclaimed?: true }
    | undefined;

  constructor(
    private readonly resolved: ResolvedRunPolicy,
    private readonly opts: PolicySessionOptions,
  ) {}

  private ts(): string {
    return new Date().toISOString();
  }

  private emit(event: Parameters<InvocationJournal["appendEvent"]>[0]): void {
    this.opts.journal?.appendEvent(event);
  }

  get lockHandle(): RunLockHandle | undefined {
    return this.lock;
  }

  /** The lock is configured (not `false`, not absent). */
  private lockOptions():
    | { scope: "project" | "config"; staleAfterPidDead: boolean }
    | undefined {
    const lock = this.resolved.policy.lock;
    if (lock === undefined || lock === false) return undefined;
    const object = lock === true ? {} : lock;
    return {
      scope: object.scope ?? "config",
      staleAfterPidDead: object.staleAfterPidDead !== false,
    };
  }

  /**
   * Take the run lock (a no-op without `lock:`). Throws
   * {@link RunLockRefusedError} (exit 4), after journaling the refusal.
   */
  async acquireLock(): Promise<void> {
    const options = this.lockOptions();
    if (!options || this.lock) return;
    const { resolved } = this;
    const target = runLockTarget({
      scope: options.scope,
      configKey: resolved.configPath
        ? await canonicalConfigPath(resolved.configPath)
        : `${resolved.configDir}/(no config)`,
      ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
      configDir: resolved.configDir,
      ...(resolved.project ? { project: resolved.project } : {}),
      ...(this.opts.lockEnvironment !== undefined
        ? { environment: this.opts.lockEnvironment }
        : {}),
    });
    const { displayName } = target;
    if (target.fellBack) {
      this.opts.note(
        "warn",
        "run.lock.scope: project needs a `project:` name in the config; locking per config file instead",
      );
    }
    try {
      this.lock = acquireRunLock({
        scope: target.scope,
        staleAfterPidDead: options.staleAfterPidDead,
        key: target.key,
        label: target.label,
        displayName,
        invocationId: this.opts.invocationId,
        origin: this.opts.origin,
        env: resolved.envName,
        argv: this.opts.redactArgv(this.opts.argv),
        cwd: this.opts.cwd,
        ...(this.opts.deps?.lockRoot ? { root: this.opts.deps.lockRoot } : {}),
        ...(this.opts.deps?.probe ? { probe: this.opts.deps.probe } : {}),
      });
    } catch (error) {
      if (error instanceof RunLockRefusedError) {
        this.emit({
          ts: this.ts(),
          type: "run.lock.refused",
          path: error.path,
          scope: error.scope,
          reason: error.reason,
          ...(error.owner
            ? {
                owner: {
                  pid: error.owner.pid,
                  startedAt: error.owner.startedAt,
                  ageSeconds: error.owner.ageSeconds,
                  alive: error.owner.alive,
                  ...(error.owner.invocationId
                    ? { invocationId: error.owner.invocationId }
                    : {}),
                  ...(error.owner.origin ? { origin: error.owner.origin } : {}),
                  ...(error.owner.env ? { env: error.owner.env } : {}),
                },
              }
            : {}),
          message: this.opts.redactor.text(error.message),
        });
      }
      throw error;
    }
    const lock = this.lock;
    this.lockSummary = {
      path: lock.path,
      scope: lock.scope,
      ...(lock.reclaimed ? { reclaimed: true as const } : {}),
    };
    if (lock.reclaimed) {
      const previous = lock.reclaimed;
      this.opts.note(
        "warn",
        `reclaimed the run lock of ${displayName}: its owner (pid ${previous.pid}, started ${previous.startedAt}) is gone`,
      );
      this.emit({
        ts: this.ts(),
        type: "run.lock.reclaimed",
        path: lock.path,
        scope: lock.scope,
        previousOwner: {
          pid: previous.pid,
          startedAt: previous.startedAt,
          ageSeconds: previous.ageSeconds,
          alive: false,
          ...(previous.invocationId
            ? { invocationId: previous.invocationId }
            : {}),
          ...(previous.origin ? { origin: previous.origin } : {}),
          ...(previous.env ? { env: previous.env } : {}),
        },
      });
    }
    this.emit({
      ts: this.ts(),
      type: "run.lock.acquired",
      path: lock.path,
      scope: lock.scope,
      ...(lock.reclaimed ? { reclaimed: true as const } : {}),
    });
  }

  /** Release the lock (idempotent), journaling `run.lock.released`. */
  releaseLock(): void {
    const lock = this.lock;
    if (!lock) return;
    this.lock = undefined;
    const removed = lock.release();
    if (removed) {
      this.emit({
        ts: this.ts(),
        type: "run.lock.released",
        path: lock.path,
        scope: lock.scope,
        heldMs: Math.max(0, Date.now() - lock.acquiredAt),
      });
    }
  }

  /** Signal path: release without journaling (the journal is already closed). */
  releaseLockSync(): void {
    const lock = this.lock;
    if (!lock) return;
    this.lock = undefined;
    lock.release();
  }

  /**
   * Run `run.preflight`. Returns the failure message (redacted) naming the
   * failed check, or undefined when every check passed.
   */
  async preflight(): Promise<string | undefined> {
    const all = this.resolved.policy.preflight ?? [];
    if (all.length === 0) return undefined;
    const redact = (text: string): string => this.opts.redactor.text(text);
    // `when: { suite, env }` leaves checks out of this run (named, not run).
    const { run: checks, skipped } = selectPreflightChecks(all, {
      ...(this.opts.suite !== undefined ? { suite: this.opts.suite } : {}),
      env: this.resolved.envName,
    });
    for (const entry of skipped) {
      this.opts.note(
        "info",
        redact(
          `preflight[${entry.index}] ${describePreflightCheck(entry.check)} skipped: ${entry.reason}`,
        ),
      );
    }
    if (checks.length === 0) return undefined;
    this.emit({
      ts: this.ts(),
      type: "preflight.started",
      total: checks.length,
    });
    const outcome = await runPreflight(
      checks,
      {
        configDir: this.resolved.configDir,
        env: this.opts.scopedSecrets.childEnv,
        ...(this.resolved.gates ? { gates: this.resolved.gates } : {}),
        redact,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      },
      (result) => {
        this.emit(
          result.ok
            ? {
                ts: this.ts(),
                type: "preflight.passed",
                index: result.index,
                check: result.kind,
                ...(result.name ? { name: result.name } : {}),
                durationMs: result.durationMs,
              }
            : {
                ts: this.ts(),
                type: "preflight.failed",
                index: result.index,
                check: result.kind,
                ...(result.name ? { name: result.name } : {}),
                durationMs: result.durationMs,
                reason: result.reason ?? "failed",
              },
        );
      },
    );
    if (outcome.ok) return undefined;
    return redact(outcome.message ?? "preflight failed");
  }

  /** `verifyClean` is configured. */
  private cleanlinessWanted(): boolean {
    return (this.resolved.policy.verifyClean?.length ?? 0) > 0;
  }

  /** Notes already given (a warning repeats in every phase otherwise). */
  private readonly noted = new Set<string>();

  /**
   * Assert cleanliness. Returns the dirty findings (journaled as
   * `cleanliness.dirty`; clean ones as `cleanliness.clean`). A kind that
   * cannot be resolved for this environment is a dirty finding too: an
   * unverifiable guarantee is not a guarantee.
   */
  async checkClean(phase: "before" | "after"): Promise<DirtyFinding[]> {
    if (!this.cleanlinessWanted()) return [];
    const entries = this.resolved.policy.verifyClean ?? [];
    const redact = (text: string): string => this.opts.redactor.text(text);
    const ctx = {
      projectDir: this.resolved.configDir,
      services: this.resolved.services,
      env: this.opts.scopedSecrets.childEnv,
      redact,
      ignorePids: [process.pid, process.ppid, ...(this.opts.ignorePids ?? [])],
      ...(this.opts.deps?.probe ? { probe: this.opts.deps.probe } : {}),
      ...(this.opts.deps?.run ? { run: this.opts.deps.run } : {}),
      ...(this.opts.deps?.ledgerRoot
        ? { ledgerRoot: this.opts.deps.ledgerRoot }
        : {}),
      ...(this.opts.deps?.agentBrowserStateDir
        ? { agentBrowserStateDir: this.opts.deps.agentBrowserStateDir }
        : {}),
    };
    const resolvedTargets = resolveCleanlinessTargets(entries, ctx);
    // `--reuse-services`: the tmux session and the compose project are
    // `cairn services up`'s and stay up, so only those two are not checked;
    // browsers are this run's own and still are.
    const reuse = this.opts.reuseServices === true;
    const targets = reuse
      ? resolvedTargets.targets.filter((target) => target.kind === "browsers")
      : resolvedTargets.targets;
    const problems = reuse ? [] : resolvedTargets.problems;
    let findings = verifyClean(targets, ctx);
    // After a run a browser daemon may still be exiting: give survivors a
    // short grace before calling the machine dirty.
    if (phase === "after") {
      const deadline = Date.now() + cleanGraceMs();
      while (findings.some((f) => !f.clean) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        findings = verifyClean(targets, ctx);
      }
    }
    const dirty: DirtyFinding[] = [];
    for (const finding of findings) {
      for (const warning of finding.warnings ?? []) {
        if (this.noted.has(warning)) continue;
        this.noted.add(warning);
        this.opts.note("warn", `verifyClean: ${warning}`);
      }
      if (finding.clean) {
        this.emit({
          ts: this.ts(),
          type: "cleanliness.clean",
          phase,
          kind: finding.kind,
          ...(finding.name ? { name: finding.name } : {}),
        });
        continue;
      }
      dirty.push({ ...finding, phase });
      this.emit({
        ts: this.ts(),
        type: "cleanliness.dirty",
        phase,
        kind: finding.kind,
        ...(finding.name ? { name: finding.name } : {}),
        survivors: finding.survivors,
      });
    }
    for (const problem of problems) {
      const finding: DirtyFinding = {
        kind: "browsers",
        clean: false,
        survivors: [problem],
        phase,
      };
      // Attribute the problem to its real kind.
      if (problem.includes("tmux")) finding.kind = "tmux";
      else if (problem.includes("docker-project"))
        finding.kind = "docker-project";
      dirty.push(finding);
      this.emit({
        ts: this.ts(),
        type: "cleanliness.dirty",
        phase,
        kind: finding.kind,
        survivors: [problem],
      });
    }
    this.dirty.push(...dirty);
    return dirty;
  }

  /** One message listing what is dirty. */
  describeDirty(findings: readonly DirtyFinding[]): string {
    return findings
      .map(
        (f) =>
          `${f.kind}${f.name ? ` ${f.name}` : ""}: ${f.survivors.join("; ")}`,
      )
      .join(" | ");
  }

  /** Run `run.finally`; failures are journaled and counted, never fatal. */
  async runFinally(exitCode: number): Promise<void> {
    const entries = this.resolved.policy.finally ?? [];
    // The signal path may have run them already.
    if (this.finallyDone >= entries.length) return;
    const redact = (text: string): string => this.opts.redactor.text(text);
    const results = await runFinallyCommands(entries, {
      cwd: this.resolved.configDir,
      env: {
        ...this.opts.scopedSecrets.childEnv,
        ...cairnContextEnv({
          environment: this.resolved.envName,
          configDir: this.resolved.configDir,
        }),
      },
      exitCode,
      ...(this.opts.journal ? { invocationDir: this.opts.journal.dir } : {}),
      redact,
      skip: this.finallyDone,
      onStart: (index, total) =>
        this.emit({ ts: this.ts(), type: "finally.started", index, total }),
      onFinish: (result) => {
        this.finallyDone = result.index;
        this.emit({
          ts: this.ts(),
          type: "finally.finished",
          index: result.index,
          ...(result.exitCode !== undefined
            ? { exitCode: result.exitCode }
            : {}),
          durationMs: result.durationMs,
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(result.outputTail ? { outputTail: result.outputTail } : {}),
        });
      },
    });
    for (const result of results) {
      if (result.ok) continue;
      this.finallyFailed += 1;
      this.opts.note(
        "warn",
        `finally[${result.index}] failed (${
          result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`
        }): ${result.command}`,
      );
    }
  }

  /**
   * The signal path: run the `run.finally` entries that have not finished
   * (all of them, unless the async path got through some) synchronously,
   * within the signal budget, with `CAIRN_EXIT_CODE` = the code cairn exits
   * with (130 / 143). An entry the signal interrupted runs again. Output
   * goes to `logs/finally-signal-NN.log` of the journal.
   */
  runFinallySync(
    exitCode: number,
    budget: SignalBudget,
    note: (message: string) => void,
  ): void {
    const entries = this.resolved.policy.finally ?? [];
    if (this.finallyDone >= entries.length) return;
    const redact = (text: string): string => this.opts.redactor.text(text);
    const journalDir = this.opts.journal?.dir;
    const env: NodeJS.ProcessEnv = {
      ...this.opts.scopedSecrets.childEnv,
      ...cairnContextEnv({
        environment: this.resolved.envName,
        configDir: this.resolved.configDir,
      }),
      CAIRN_EXIT_CODE: String(exitCode),
      ...(journalDir ? { CAIRN_INVOCATION_DIR: journalDir } : {}),
    };
    for (let i = this.finallyDone; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const index = i + 1;
      const command = typeof entry === "string" ? entry : entry.run;
      const timeoutMs = signalTimeout(budget, finallyTimeoutMs(entry));
      if (timeoutMs <= 0) {
        note(
          `run.finally[${index}] not run: the signal-path budget is spent (CAIRN_SIGNAL_HOOK_TIMEOUT_MS)`,
        );
        this.finallyFailed += entries.length - i;
        return;
      }
      note(`run.finally[${index}] (up to ${timeoutMs}ms): ${redact(command)}`);
      this.emit({
        ts: this.ts(),
        type: "finally.started",
        index,
        total: entries.length,
      });
      const result = runShellCommandSync(command, {
        cwd: this.resolved.configDir,
        env,
        timeoutMs,
        ...(journalDir
          ? {
              outputFile: `${journalDir}/logs/finally-signal-${String(index).padStart(2, "0")}.log`,
            }
          : {}),
      });
      this.finallyDone = index;
      const ok =
        result.exitCode === 0 && !result.timedOut && !result.spawnError;
      if (!ok) this.finallyFailed += 1;
      const tail = result.outputTail ? redact(result.outputTail) : undefined;
      this.emit({
        ts: this.ts(),
        type: "finally.finished",
        index,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        durationMs: result.durationMs,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(tail ? { outputTail: tail } : {}),
      });
      if (!ok) {
        note(
          `run.finally[${index}] failed (${
            result.timedOut
              ? "timed out"
              : (result.spawnError ?? `exit ${result.exitCode ?? "?"}`)
          })`,
        );
      }
    }
  }

  /** What the session did, for the journal summary (`runPolicy`). */
  summary(): NonNullable<InvocationSummary["runPolicy"]> {
    return {
      ...(this.lockSummary ? { lock: this.lockSummary } : {}),
      ...(this.dirty.length > 0
        ? {
            dirty: this.dirty.map((f) => ({
              phase: f.phase,
              kind: f.kind,
              ...(f.name ? { name: f.name } : {}),
              survivors: f.survivors,
            })),
          }
        : {}),
      ...(this.finallyFailed > 0 ? { finallyFailed: this.finallyFailed } : {}),
    };
  }
}

/** One line naming the critical teardown entries that failed. */
export function describeCriticalTeardown(
  failures: readonly CriticalTeardownFailure[],
): string {
  return failures
    .map((failure) => {
      const how = failure.timedOut
        ? "timed out"
        : failure.exitCode !== undefined
          ? `exit ${failure.exitCode}`
          : (failure.error ?? "failed");
      const command =
        failure.command.length > 100
          ? `${failure.command.slice(0, 97)}...`
          : failure.command;
      return `services.teardown[${failure.index}] (${command}) ${how}`;
    })
    .join("; ");
}

/**
 * The journal summary's `runPolicy` block: what the session did plus the
 * critical teardown failures (which need no `run:` block to exist).
 */
export function summarizeRunPolicy(
  session: RunPolicySession | undefined,
  critical: readonly CriticalTeardownFailure[],
): InvocationSummary["runPolicy"] {
  const out: NonNullable<InvocationSummary["runPolicy"]> = {
    ...session?.summary(),
    ...(critical.length > 0
      ? {
          criticalTeardown: critical.map((failure) => ({
            index: failure.index,
            command: failure.command,
            ...(failure.exitCode !== undefined
              ? { exitCode: failure.exitCode }
              : {}),
            ...(failure.timedOut ? { timedOut: true } : {}),
            ...(failure.signal ? { signal: failure.signal } : {}),
            ...(failure.error ? { error: failure.error } : {}),
            path: failure.path,
          })),
        }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}
