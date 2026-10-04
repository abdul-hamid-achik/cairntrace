import { execa } from "execa";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  DockerConfig,
  Healthcheck,
  SeedConfig,
  ServicesArtifactCaptureSource,
  ServicesArtifactsConfig,
  ServicesConfig,
  ServicesStashConfig,
  TmuxConfig,
  TmuxSessionOption,
  TmuxWindow,
} from "../schema/config.v1";
import { resolveServicesArtifactsConfig } from "../schema/config.v1";
import type { ServicesEventType } from "../schema/events.v1";
import {
  ServicesOwnerLockSchema,
  type ServicesOwnerLock,
} from "../schema/services.v1";
import {
  isTruthyEnv,
  probeOnce,
  probeReady,
  readinessHint,
  runShell,
  runShellDetached,
  sleep,
  warnLegacyReadiness,
  type ReadyProbe,
  type ShellResult,
  type SpawnOpts,
} from "./webServer";
import type { GateEvent } from "../schema/events.v1";
import {
  checkGateOnce,
  gateFailureMessage,
  GateReferenceError,
  waitForGate,
  watchGate,
  type GateContext,
  type GateWatch,
} from "../gates/evaluate";
import {
  gateRefList,
  type GateNode,
  type GateRef,
  type GateRefList,
} from "../gates/schema";
import { gatesRegistryFor } from "../gates/registry";
import { SeedStateStore } from "./seedState";
import {
  normalizeTeardown,
  type NormalizedTeardown,
} from "../runPolicy/schema";
import {
  createArtifactRedactor,
  isSensitiveEnvKey,
  registerSecretValues,
} from "../artifacts/redaction";
import { backoffDelayMs, resolveBackoff } from "../servicesOps/backoff";
import {
  generationMarker,
  generationMarkerCommand,
  newGenerationId,
  sliceAfterGeneration,
} from "../servicesOps/generation";
import { applyServiceFile, ServiceFileError } from "../servicesOps/files";
import {
  dropSeedResumeSync,
  emptyScopedState,
  expectOutputViolation,
  phaseFingerprint,
  phaseStateDecision,
  postCommandApplies,
  resumeFresh,
  ScopedSeedFreshness,
  SeedPhaseStore,
  seedTargetHash,
  type PhaseRecord,
} from "../servicesOps/seedTransaction";
import {
  phaseRun,
  postCommandLabel,
  postCommandRun,
  type ProvisionerConfig,
  type SeedPhase,
  type SeedPostCommand,
  type TunnelConfig,
} from "../servicesOps/schema";
import {
  stopTunnelsFromState,
  tunnelStateKey,
  TunnelSet,
} from "../servicesOps/tunnels";
import { durationMs as toMs } from "../gates/schema";
import {
  removeSupervisorMarker,
  writeSupervisorMarker,
} from "../servicesOps/supervisorMarker";
import {
  tmuxSessionScopeTarget,
  tmuxSessionTarget,
  tmuxWindowTarget,
} from "./tmuxTarget";
import type { ArtifactRedactor } from "../artifacts/ArtifactWriter";
import { LineSplitter } from "../artifacts/liveLog";
import { targetChildEnvWithSelectedTvaultKeys } from "../processEnv";
import {
  descendantPidsSync,
  killProcessTreeSync,
} from "../../adapters/agent-browser/processTree";

/**
 * Multi-service environment lifecycle for `cairn run`:
 *   docker infra → conditional seed → tmux session with service windows
 *   → teardown (reverse order: tmux kill → docker down).
 *
 * Starts once before the spec pool, stops once after — the same scope as
 * `webServer`, but for multi-process environments. Reuses `runShell`,
 * `probeOnce`, and the Bun/node runtime abstraction from `webServer.ts`.
 */

export interface StartServicesContext {
  /** Directory that relative `cwd` values resolve against. */
  configDir: string;
  /** Effective cold-start (CLI `--cold-start` or CI); flips reuse default off. */
  coldStart?: boolean;
  /** Project name (from config) — used for seed state file naming. */
  project: string;
  /**
   * The config file (absent without one): with the project and the
   * environment it keys the tunnel state, so two checkouts never share it.
   */
  configPath?: string;
  /** Invocation-scoped environment; never copied into process.env. */
  env?: NodeJS.ProcessEnv;
  /** Explicit TinyVault names that may retain a `TVAULT_` prefix in targets. */
  selectedTvaultKeys?: Iterable<string>;
  /** Literal vault values used exclusively to redact service diagnostics. */
  secretValues?: Iterable<string>;
  /** Optional narrator for interactive runs (stderr lifecycle lines). */
  log?: (message: string) => void;
  /**
   * Optional narrator for sub-milestone play-by-play (readiness/healthcheck
   * command echoes, tmux scaffolding, retry narration) — the detail behind
   * each `log` milestone. Routed to DEBUG level by the CLI (--verbose /
   * CAIRN_LOG_LEVEL=debug); silent by default. Same optionality as `log`.
   */
  logDetail?: (message: string) => void;
  /** Root for per-window pane logs (default `~/.cairntrace/services`). */
  serviceLogRoot?: string;
  /** Optional live streamer for service command output (interactive runs). */
  onOutput?: (chunk: string) => void;
  /**
   * Live, line-buffered, REDACTED output of the docker and seed commands
   * (`$ <command>` header, every output line, `[exit N]` footer), and of
   * each teardown command once it finished. The CLI writes it to the
   * invocation journal's services-<source>.log.
   */
  onServiceOutput?: (
    source: "docker" | "seed" | "teardown" | "provisioner",
    line: string,
  ) => void;
  /**
   * Signal-path (SIGINT/SIGTERM) evidence, written synchronously while the
   * process exits: `services.teardown.signal` events (the boot command
   * stopped, each teardown command's exit/timeout) and the teardown
   * commands' output. The CLI points it at the invocation journal; without
   * it the signal path records nothing.
   */
  onSignalTeardown?: {
    event(event: ServicesEvent): void;
    output(line: string): void;
  };
  /**
   * Set by startServices: pids of the boot commands running right now
   * (docker, readiness, healthcheck, seed, post-commands), so the signal path
   * can stop that process tree before it runs the teardown commands.
   */
  bootPids?: Set<number>;
  /** Optional structured lifecycle event collector (for events.ndjson). */
  onEvent?: (event: ServicesEvent) => void;
  /**
   * Invoked once, the instant a long-lived process is spawned (docker or tmux),
   * with a synchronous teardown bound to it. Lets the caller register
   * signal-time cleanup for the whole boot window. `criticalPending` says
   * whether that teardown still owes a critical entry (or a provisioner's
   * `down`): the signal path names it before the slow part.
   */
  onSpawn?: (
    terminateSync: () => void,
    criticalPending?: () => boolean,
  ) => void;
  /**
   * Cancellation of the boot: a running docker/seed/readiness/healthcheck
   * command has its process tree killed, readiness and shell waits stop at
   * their next poll, the phases already started are torn down (reuse rules
   * apply) and startServices rejects with {@link ServicesCancelledError}.
   */
  signal?: AbortSignal;
  /**
   * The config's `gates:` registry: named references in `docker.ready`,
   * tmux `readyOn.gate` and `after` resolve here.
   */
  gates?: Readonly<Record<string, GateNode>>;
  /** gate.* events of readiness waits (the invocation journal writes them). */
  onGateEvent?: (event: GateEvent) => void;
  /**
   * Warnings that must reach the user even in non-interactive runs (a
   * readiness URL stuck on a status only the old any-answer rule accepted).
   * Default: `log`, else one stderr line.
   */
  warn?: (message: string) => void;
  /** The environment being started (seed state key, `postCommands.when.env`). */
  envName?: string;
  /** The suite of this run (`postCommands.when.suite`). */
  suite?: string;
  /**
   * Supervise windows (`restart`, `healthcheck.onUnhealthy`) and tunnels
   * (`restart: always`) while the handle is alive. Default true; `cairn
   * services up` passes false (cairn exits right after the boot, so nothing
   * could supervise).
   */
  supervise?: boolean;
  /** Poll period of the window supervisor (default 2000; tests lower it). */
  supervisionIntervalMs?: number;
  /** Where tunnel pid/state and seed state live (default ~/.cairntrace/services). */
  stateRoot?: string;
  /**
   * Set by startServices: windows this call (re)launched. Lets a changed
   * `services.files` entry restart only the windows that were already live.
   */
  launchedWindows?: Set<string>;
}

export interface ServicesHandle {
  /** True when cairn started at least one phase (owns teardown). */
  startedByUs: boolean;
  /** Structured lifecycle events collected during startServices(). */
  events: ServicesEvent[];
  /**
   * Collect a redacted, bounded in-memory bundle for a completed run. This does
   * not write files; the runner integration decides where/how to attach it.
   */
  captureRunArtifacts(
    status: ServicesRunStatus,
    runWindow?: ServicesRunWindow,
  ): Promise<ServicesArtifactBundle>;
  /**
   * Last-chance, synchronous pane capture for SIGINT/SIGTERM. The signal
   * handler calls this before terminateSync() can remove the tmux session.
   */
  captureSignalArtifactsSync(
    runDir: string,
    signal: "SIGINT" | "SIGTERM",
  ): void;
  /** Run teardown commands (best-effort) then stop services. No-op when reused. */
  stop(): Promise<void>;
  /** Synchronous teardown for the signal path (Ctrl-C). No-op when reused. */
  terminateSync(): void;
  /**
   * `critical: true` teardown entries that failed or timed out so far (async
   * path and signal path). A non-empty list fails the run with exit 8.
   */
  criticalTeardownFailures?(): CriticalTeardownFailure[];
  /**
   * A `critical: true` teardown entry (or a provisioner's `down`) will run:
   * the run's exit code can still change after its specs (exit 8).
   */
  hasCriticalTeardown?(): boolean;
  /**
   * Set when the run reuses an environment `cairn services up` owns
   * (`--reuse-services`): nothing was started and nothing is torn down.
   */
  reusedLock?: ServicesOwnerLock;
  /**
   * `services.provisioner.exports`, evaluated at boot: environment
   * variables for every later phase, hook, spec and verifier. The run engine
   * merges them into the invocation env; values are never logged.
   */
  exportedEnv?: Record<string, string>;
}

/** A `critical: true` teardown entry that failed or timed out. */
export interface CriticalTeardownFailure {
  /** 0-based position in `services.teardown`. */
  index: number;
  /** The command, redacted. */
  command: string;
  exitCode?: number;
  timedOut?: boolean;
  signal?: string;
  /** The command could not be executed (error name), or was still running after the signal wait. */
  error?: string;
  /** Which path ran it: the normal async teardown or the SIGINT/SIGTERM path. */
  path: "teardown" | "signal";
  /** The entry is the provisioner's `down`. */
  provisioner?: boolean;
}

/** Thrown for every services lifecycle failure; run.ts maps it to exit 2. */
export class ServicesError extends Error {
  override name = "ServicesError";
}

/** The services boot was cancelled through `StartServicesContext.signal`. */
export class ServicesCancelledError extends ServicesError {
  override name = "ServicesCancelledError";
  constructor(message = "services boot cancelled") {
    super(message);
  }
}

/** Throw {@link ServicesCancelledError} when the boot was cancelled. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ServicesCancelledError();
}

/**
 * `sleep(ms)` that ends early on abort: it rejects with
 * {@link ServicesCancelledError} as soon as `signal` aborts, so readiness
 * polls stop at once instead of at their deadline.
 */
async function sleepUnlessCancelled(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfCancelled(signal);
  if (!signal) return sleep(ms);
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectSleep(new ServicesCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Event names the services layer may emit: the `<event>` part of the
 * events.v1 `services.<phase>.<event>` vocabulary. Typing emit sites against
 * it keeps events.ndjson inside the schema without a cast at the writer.
 */
export type ServicesEventName =
  ServicesEventType extends `services.${string}.${infer Name}` ? Name : never;

/** A structured lifecycle event emitted at each phase boundary. */
export interface ServicesEvent {
  /** Phase: docker, seed, tmux, teardown, stash */
  phase:
    | "docker"
    | "seed"
    | "tmux"
    | "teardown"
    | "stash"
    | "restart"
    | "tunnel"
    | "provisioner"
    | "files";
  /** Event type: start, reuse, skip, ready, fail, healthcheck, complete, … */
  event: ServicesEventName;
  /** Human-readable message. */
  message: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Optional structured data (window name, exit code, etc.). */
  data?: Record<string, unknown>;
}

export type ServicesRunStatus = "passed" | "failed" | "errored";

export interface ServicesRunWindow {
  /** Inclusive lower bound for Docker Compose logs. ISO string or Date. */
  startedAt?: string | Date;
  /** Optional upper bound for Docker Compose logs. ISO string or Date. */
  endedAt?: string | Date;
}

export interface ServicesArtifactFile {
  source: ServicesArtifactCaptureSource;
  /** Constrained, portable path intended to be joined below a run directory. */
  relativePath: string;
  label: string;
  content: string;
  bytes: number;
  truncated: boolean;
  metadata?: Record<string, string | number | boolean>;
}

export interface ServicesArtifactCaptureError {
  source: ServicesArtifactCaptureSource;
  label: string;
  message: string;
}

export interface ServicesArtifactBundle {
  version: "1";
  status: ServicesRunStatus;
  captured: boolean;
  reason: "captured" | "policy-never" | "status-passed";
  capturedAt: string;
  policy: ServicesArtifactsConfig;
  runWindow: { startedAt?: string; endedAt?: string };
  ownership: {
    docker?: "started" | "reused";
    tmux?: "created" | "recreated" | "reused";
  };
  files: ServicesArtifactFile[];
  errors: ServicesArtifactCaptureError[];
  totalBytes: number;
  truncated: boolean;
}

/** A lifecycle-compatible handle for `--services-dry-run`. */
export function createNoopServicesHandle(): ServicesHandle {
  return {
    startedByUs: false,
    events: [],
    captureRunArtifacts: async (status, requestedWindow) => {
      const startedAt = normalizeIsoTimestamp(requestedWindow?.startedAt);
      const endedAt = normalizeIsoTimestamp(requestedWindow?.endedAt);
      return {
        version: "1",
        status,
        captured: false,
        reason: "policy-never",
        capturedAt: new Date().toISOString(),
        policy: {
          ...resolveServicesArtifactsConfig(undefined),
          when: "never",
        },
        runWindow: {
          ...(startedAt ? { startedAt } : {}),
          ...(endedAt ? { endedAt } : {}),
        },
        ownership: {},
        files: [],
        errors: [],
        totalBytes: 0,
        truncated: false,
      };
    },
    captureSignalArtifactsSync: () => undefined,
    stop: async () => undefined,
    terminateSync: () => undefined,
  };
}

const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;
/** Readiness-check retry cadence for the docker phase. */
const READINESS_POLL_MS = 1_000;
const DEFAULT_SEED_TIMEOUT_MS = 300_000;
const DEFAULT_TMUX_READY_MS = 90_000;
const POLL_MS = 500;
const TMUX_STALL_INTERVAL_MS = 5_000;
const DEFAULT_TMUX_COLUMNS = 250;
const DEFAULT_TMUX_ROWS = 50;
/** Max wait for an interactive shell to accept send-keys after window create. */
const TMUX_SHELL_READY_MS = 30_000;
/**
 * Max wait for a pre-command (yarn build, etc.) to exit and return the shell
 * prompt before the next send-keys. Cold tsc builds regularly exceed 30s.
 */
const TMUX_PRE_COMMAND_RETURN_MS = 900_000;
/** Consecutive polls that must report the same shell before we send keys. */
const TMUX_SHELL_STABLE_POLLS = 2;
/**
 * After send-keys of the main command, how long to wait for the pane to leave
 * the idle shell (command accepted). If still idle, re-send.
 */
const TMUX_COMMAND_ACCEPT_MS = 3_000;
/** Max send-keys attempts for the main long-lived command. */
const TMUX_COMMAND_SEND_ATTEMPTS = 3;
const SHELL_TAIL_LINES = 40;
const DEFAULT_HC_INTERVAL_S = 30;
const DEFAULT_HC_RETRIES = 3;
const DEFAULT_HC_TIMEOUT_S = 10;
/**
 * Interactive shells that mean "service is not running in this pane" — when
 * the shell is also the terminal's foreground process group (a shell-named
 * foreground job such as `bash start.sh` is a running service).
 */
const TMUX_IDLE_SHELL_RE =
  /^(zsh|bash|fish|sh|dash|ksh|tcsh|csh|-zsh|-bash|-fish)$/i;
/** The `list-panes` format of a readiness probe. */
const TMUX_PANE_STATE_FORMAT =
  "#{pane_dead}\t#{pane_dead_status}\t#{pane_current_command}\t#{pane_pid}";

/**
 * The env of a services child: the inherited env filtered (TinyVault client
 * controls, `CAIRN_TVAULT_ENV` and the publisher token never cross into
 * project processes unless selected), then the phase's own config `env:`
 * as written — a key the config sets explicitly (e.g. `TVAULT_DIR` for a
 * provisioner that reads a non-default vault) is the author's choice.
 */
function targetEnv(
  ctx: StartServicesContext,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = targetChildEnvWithSelectedTvaultKeys(
    ctx.env ?? process.env,
    ctx.selectedTvaultKeys ?? [],
  );
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Start the full services lifecycle. Each phase is optional — only the
 * configured phases run. Returns a handle for teardown tracking.
 */
export async function startServices(
  cfg: ServicesConfig,
  callerCtx: StartServicesContext,
): Promise<ServicesHandle> {
  // Boot commands register their pids here for the signal path.
  const ctx: StartServicesContext = { ...callerCtx, bootPids: new Set() };
  const coldStart = ctx.coldStart ?? isTruthyEnv(process.env.CI);
  const phases = newPhaseState(cfg, ctx);

  const emit = (
    phase: ServicesEvent["phase"],
    event: ServicesEventName,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    const e: ServicesEvent = {
      phase,
      event,
      message,
      timestamp: new Date().toISOString(),
      ...(data ? { data } : {}),
    };
    phases.events.push(e);
    ctx.onEvent?.(e);
  };

  // If stash is configured, create a temp directory to capture artifacts into.
  if (cfg.stash?.enabled) {
    try {
      const dir = join(tmpdir(), `cairn-services-${ctx.project}-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      phases.artifactsDir = dir;
    } catch {
      phases.artifactsDir = undefined;
    }
  }

  // Register signal-time teardown immediately. The callback is a closure
  // that reads `phases.tmuxSession`, so it stays current as phases progress.
  // No-op until the tmux phase sets the session name.
  ctx.onSpawn?.(
    () => {
      terminateServicesSync(phases, ctx);
    },
    () => criticalTeardownPending(phases),
  );

  ctx.launchedWindows = phases.launchedWindows;

  try {
    // Phase 0 (F10): the provisioned resource and its exports — everything
    // after it may use the exported env.
    throwIfCancelled(ctx.signal);
    if (cfg.provisioner) {
      await startProvisioner(cfg.provisioner, ctx, phases, emit);
    }

    // Phase 0b (F10): tunnels (a seed or a window may need one).
    throwIfCancelled(ctx.signal);
    if (cfg.tunnels && cfg.tunnels.length > 0) {
      await startTunnels(cfg.tunnels, ctx, phases, emit);
    }

    // Phase 1: Docker
    throwIfCancelled(ctx.signal);
    if (cfg.docker) {
      await startDocker(cfg.docker, ctx, coldStart, phases, emit);
    }

    // Phase 1b (F10): files (config the seed and the windows read)
    throwIfCancelled(ctx.signal);
    if (cfg.files && cfg.files.length > 0) {
      await applyServicesFiles(cfg.files, cfg.tmux, ctx, phases, emit);
    }

    // Phase 2: Conditional seed
    throwIfCancelled(ctx.signal);
    if (cfg.seed) {
      await startSeed(cfg.seed, ctx, phases, emit);
    }

    // Phase 3: tmux
    throwIfCancelled(ctx.signal);
    if (cfg.tmux) {
      await startTmux(cfg.tmux, ctx, coldStart, phases, emit);
      // A changed `services.files` entry restarts the windows that were
      // already live (a window launched by this call read the new file).
      await restartWindowsAfterFiles(cfg.tmux, ctx, phases, emit);
    }
    throwIfCancelled(ctx.signal);
    if (cfg.tmux && ctx.supervise !== false) {
      const supervisor = new WindowSupervisor(cfg.tmux, ctx, phases, emit);
      if (supervisor.hasWork()) {
        phases.supervisor = supervisor;
        supervisor.start();
      }
    }
  } catch (e) {
    // A later phase failed after an earlier one already started. Tear down
    // what we started so we don't orphan tmux dev-servers or docker
    // containers, then propagate. The caller untracks the signal-time hook on
    // throw, so cleanup MUST happen here — the returned handle never exists.
    emit("teardown", "failure-cleanup", (e as Error).message);
    await teardownStartedPhases(phases, ctx, emit).catch(() => undefined);
    // A critical teardown entry that failed in the cleanup still fails the run.
    if (phases.criticalFailures.length > 0 && e instanceof Error) {
      Object.assign(e, {
        criticalTeardownFailures: [...phases.criticalFailures],
      });
    }
    throw e;
  }

  const startedByUs = phases.dockerStarted || phases.tmuxSession !== undefined;

  return {
    startedByUs,
    ...(Object.keys(phases.exportedEnv).length > 0
      ? { exportedEnv: { ...phases.exportedEnv } }
      : {}),
    /** Structured lifecycle events collected during startServices. */
    events: phases.events,
    captureRunArtifacts: (status, runWindow) => {
      // services.stash autoStash: on-failure needs to know a run failed.
      if (status !== "passed") phases.stashSawFailure = true;
      return collectRunArtifacts(cfg, phases, ctx, status, runWindow);
    },
    captureSignalArtifactsSync: (runDir, signal) => {
      captureTmuxSignalArtifactsSync({
        runDir,
        signal,
        session: phases.tmuxSessionName,
        windows: cfg.tmux?.windows.map((window) => window.name) ?? [],
        policy: phases.localArtifactPolicy,
        redactor: phases.artifactRedactor,
        disposition: phases.tmuxDisposition,
        startedAt: phases.startedAt,
      });
    },
    stop: async () => {
      // Nothing may restart a window or a tunnel while the stack comes down.
      await phases.supervisor?.stop();
      // Deprecated services.stash: capture tmux panes (a reused session
      // too), docker logs and seed output before tearing down, only when
      // autoStash asks for it.
      const stashServices =
        phases.artifactsDir !== undefined &&
        shouldStashServices(cfg.stash, phases.stashSawFailure);
      const deprecation = servicesStashDeprecation(cfg.stash);
      if (deprecation) ctx.log?.(deprecation);
      if (stashServices) {
        await captureSessionArtifacts(cfg, phases, ctx);
      }

      // Teardown commands from config (best-effort), reuse rules applied.
      await runTeardownCommands(phases, ctx, emit, "teardown", "regular");
      // Kill the tmux session only when we created it AND we're not reusing
      // (reuse mode leaves it alive for the next run to reuse — no rebuild).
      if (phases.tmuxSession && !phases.tmuxReuse) {
        try {
          await execa(
            "tmux",
            ["kill-session", "-t", tmuxSessionTarget(phases.tmuxSession)],
            {
              reject: false,
              timeout: 5_000,
            },
          );
        } catch {
          // best-effort
        }
      }
      // Tunnels, then the provisioned resource they point at (critical: a
      // failed `down` is exit 8).
      await phases.tunnels?.stop().catch(() => undefined);
      await runTeardownCommands(phases, ctx, emit, "teardown", "provisioner");

      // Stash artifacts to fcheap if configured.
      if (stashServices && cfg.stash && phases.artifacts.length > 0) {
        await stashServicesArtifacts(cfg.stash, phases, ctx);
      }

      // Clean up the temp artifacts directory.
      if (phases.artifactsDir) {
        await rm(phases.artifactsDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
    terminateSync: () => {
      terminateServicesSync(phases, ctx);
    },
    criticalTeardownFailures: () => [...phases.criticalFailures],
    hasCriticalTeardown: () =>
      phases.teardownPolicies.some((policy) => policy.critical === true),
  };
}

/**
 * Best-effort teardown of whatever startServices already brought up, used when
 * a later phase fails mid-startup. Runs config teardown commands (e.g. docker
 * compose down), kills the tmux session, and removes the temp artifacts dir —
 * so a tmux/seed failure can't orphan running containers or dev-servers.
 *
 * Respects reuse mode exactly like `stop()` and the signal path: when the tmux
 * session is in reuse mode, a mid-startup failure must NOT kill it or run
 * docker-down — the warm session belongs to the user/next run, and nuking it
 * turns every transient readyOn failure into a full cold rebuild of the stack.
 */
async function teardownStartedPhases(
  phases: PhaseState,
  ctx: StartServicesContext,
  emit: EmitFn,
): Promise<void> {
  await phases.supervisor?.stop();
  await runTeardownCommands(phases, ctx, emit, "failure-cleanup", "regular");
  if (phases.tmuxSession && !phases.tmuxReuse) {
    await execa(
      "tmux",
      ["kill-session", "-t", tmuxSessionTarget(phases.tmuxSession)],
      {
        reject: false,
        timeout: 5_000,
      },
    ).catch(() => undefined);
  }
  await phases.tunnels?.stop().catch(() => undefined);
  await runTeardownCommands(
    phases,
    ctx,
    emit,
    "failure-cleanup",
    "provisioner",
  );
  if (phases.artifactsDir) {
    await rm(phases.artifactsDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Run the config teardown commands in order (best-effort), honoring reuse
 * mode: a reused tmux session is never killed, and docker-compose-down style
 * commands are skipped while it lives. Shared by `stop()` and the
 * mid-startup failure cleanup, so both leave the same evidence: one
 * `services.teardown.complete|fail` event per command (index, exitCode,
 * durationMs) and its redacted output in `logs/services-teardown.log`.
 * Progress is kept on `phases` so a signal that lands mid-teardown neither
 * repeats a finished command nor starts a second copy of one that is still
 * running. Each command runs in its own process group (see
 * runShellDetached), so the Ctrl-C or group SIGTERM that stops
 * cairn does not kill a provisioner's `down` halfway.
 */
async function runTeardownCommands(
  phases: PhaseState,
  ctx: StartServicesContext,
  emit: EmitFn,
  label: "teardown" | "failure-cleanup",
  /**
   * `regular`: the configured teardown commands; `provisioner`: the
   * provisioner's `down` (it runs after the tmux session and the tunnels);
   * `all`: both, in order.
   */
  which: "regular" | "provisioner" | "all" = "all",
): Promise<void> {
  const managedSession = phases.tmuxSessionName;
  for (const [index, cmd] of phases.teardownCommands.entries()) {
    if (phases.teardownSettled.has(index)) continue;
    const isProvisioner = index === phases.provisionerIndex;
    if (which === "regular" && isProvisioner) continue;
    if (which === "provisioner" && !isProvisioner) continue;
    // A provisioner whose `up` never started has nothing to destroy.
    if (isProvisioner && !phases.provisionerUpStarted) {
      phases.teardownSettled.add(index);
      continue;
    }
    if (
      !isProvisioner &&
      phases.tmuxReuse &&
      managedSession &&
      killsTmuxSession(cmd, managedSession)
    ) {
      ctx.log?.(
        `${label} (skipped tmux kill for reuse — leaving "${managedSession}" alive)`,
      );
      phases.teardownSettled.add(index);
      continue;
    }
    if (!isProvisioner && phases.tmuxReuse && tearsDownDocker(cmd)) {
      ctx.log?.(
        `${label} (skipped docker down for reuse — tmux services still need infra)`,
      );
      phases.teardownSettled.add(index);
      continue;
    }
    // An `up` that failed (or was cancelled) never got to its exports: the
    // `down` still needs them to find what to destroy.
    if (isProvisioner) await provisionerExportsForDown(phases, ctx);
    const output = serviceOutput(ctx, "teardown", phases.artifactRedactor);
    const startedAt = Date.now();
    const policy = phases.teardownPolicies[index];
    const critical = policy?.critical === true;
    const criticalData = {
      ...(critical ? { critical: true } : {}),
      ...(isProvisioner ? { provisioner: true } : {}),
    };
    phases.teardownRunning = index;
    phases.teardownPid = undefined;
    phases.teardownOutputFile = undefined;
    if (!isProvisioner) phases.regularTeardownRan = true;
    try {
      ctx.log?.(`teardown (${cmd})`);
      output?.announce(cmd);
      const result = await runShellDetached(
        cmd,
        { cwd: ctx.configDir, env: targetEnv(ctx) },
        (started) => {
          phases.teardownPid = started.pid;
          phases.teardownOutputFile = started.outputFile;
        },
        TEARDOWN_OUTPUT_BYTES,
        policy?.timeoutMs,
      );
      if (output) {
        if (result.stdout) output.push(`${result.stdout}\n`);
        if (result.stderr) output.push(`${result.stderr}\n`);
        output.finish(result.exitCode);
      }
      const durationMs = Date.now() - startedAt;
      if (result.exitCode === 0 && !result.timedOut) {
        emit("teardown", "complete", `teardown[${index}] completed`, {
          index,
          exitCode: result.exitCode,
          durationMs,
          ...criticalData,
        });
      } else {
        ctx.log?.(
          `teardown[${index}] ${
            result.timedOut ? "timed out" : `failed (exit ${result.exitCode})`
          }; continuing`,
        );
        emit("teardown", "fail", `teardown[${index}] failed`, {
          index,
          exitCode: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
          durationMs,
          ...criticalData,
        });
        if (critical) {
          phases.criticalFailures.push({
            index,
            command: phases.artifactRedactor.text(cmd),
            ...(isProvisioner ? { provisioner: true } : {}),
            exitCode: result.exitCode,
            ...(result.timedOut ? { timedOut: true } : {}),
            ...(result.signal ? { signal: result.signal } : {}),
            path: "teardown",
          });
        }
      }
    } catch (error) {
      // Teardown remains best-effort, but a thrown execution error is
      // still observable lifecycle evidence rather than silent success.
      output?.finish(-1);
      ctx.log?.(`teardown[${index}] failed to execute; continuing`);
      emit("teardown", "fail", `teardown[${index}] failed to execute`, {
        index,
        error: (error as Error).name,
        durationMs: Date.now() - startedAt,
        ...criticalData,
      });
      if (critical) {
        phases.criticalFailures.push({
          index,
          command: phases.artifactRedactor.text(cmd),
          ...(isProvisioner ? { provisioner: true } : {}),
          error: (error as Error).name,
          path: "teardown",
        });
      }
    } finally {
      phases.teardownRunning = undefined;
      phases.teardownPid = undefined;
      phases.teardownOutputFile = undefined;
      phases.teardownSettled.add(index);
    }
  }
  dropSeedResumeAfterTeardown(phases, ctx.log);
}

/** Bytes of one teardown command's output kept by stop()/the cleanup. */
const TEARDOWN_OUTPUT_BYTES = 1024 * 1024;

/** The last `maxBytes` of a file as UTF-8, for the signal path. */
function readTailSync(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const { size } = fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/* ----- owner lock: `cairn services up` / `down` / `run --reuse-services` ----- */

/** Directory of the services state files (seed freshness, owner locks). */
export function servicesStateRoot(): string {
  return join(homedir(), ".cairntrace", "services");
}

/**
 * A file-name-safe spelling of a name: percent-encoding (dots included), so
 * no name can leave the state directory or fake a `.lock.json` suffix.
 */
function lockSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[.!~*'()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The canonical spelling of a config path — symlinks resolved and, on a
 * case-insensitive filesystem, the on-disk case — so one config file always
 * maps to one owner lock. The resolved path itself when it does not exist.
 */
export async function canonicalConfigPath(configPath: string): Promise<string> {
  const abs = resolve(configPath);
  return realpath(abs).catch(() => abs);
}

/**
 * `~/.cairntrace/services/<config dir>.<sha256 of the config path>.lock.json`
 * for a canonical config path ({@link canonicalConfigPath}): one lock per
 * config file, whatever its `project:` and environment. Environments of one
 * config inherit its compose project and tmux session, so they share one
 * stack; two repos never share a lock because they share a project name.
 */
export function servicesLockPath(
  canonicalPath: string,
  root: string = servicesStateRoot(),
): string {
  const hash = createHash("sha256")
    .update(canonicalPath)
    .digest("hex")
    .slice(0, 16);
  const label = lockSegment(basename(dirname(canonicalPath)) || "config");
  return join(root, `${label}.${hash}.lock.json`);
}

/** The owner lock path of a config file (canonicalized first). */
export async function resolveServicesLockPath(
  configPath: string,
  root?: string,
): Promise<string> {
  return servicesLockPath(await canonicalConfigPath(configPath), root);
}

/** What the owner lock of one config file says right now. */
export type ServicesLockState =
  | { state: "absent"; path: string }
  | { state: "held"; path: string; lock: ServicesOwnerLock }
  | { state: "unreadable"; path: string; reason: string };

/**
 * Read (never create) the owner lock of a config file. Keys a newer cairn
 * added are ignored (only `version` gates compatibility); a lock that names
 * another config file is unreadable.
 */
export async function readServicesLock(
  configPath: string,
  root?: string,
): Promise<ServicesLockState> {
  const canonical = await canonicalConfigPath(configPath);
  const path = servicesLockPath(canonical, root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", path };
    }
    return { state: "unreadable", path, reason: (error as Error).message };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      state: "unreadable",
      path,
      reason: `invalid JSON (${(error as Error).message})`,
    };
  }
  const parsed = ServicesOwnerLockSchema.strip().safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      state: "unreadable",
      path,
      reason: `not a services lock (${
        issue
          ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
          : "invalid"
      })`,
    };
  }
  if (parsed.data.configPath !== canonical) {
    return {
      state: "unreadable",
      path,
      reason: `written for another config (${parsed.data.configPath})`,
    };
  }
  return { state: "held", path, lock: parsed.data };
}

/**
 * Write the owner lock atomically: a temp file in the same directory, then
 * rename, so a reader never sees half a lock. `lock.configPath` keys the
 * file; it is stored canonical ({@link canonicalConfigPath}). Returns the
 * path.
 */
export async function writeServicesLock(
  lock: ServicesOwnerLock,
  root?: string,
): Promise<string> {
  const valid = ServicesOwnerLockSchema.parse({
    ...lock,
    configPath: await canonicalConfigPath(lock.configPath),
  });
  const path = servicesLockPath(valid.configPath, root);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

/** Remove the owner lock of a config file; false when there was none. */
export async function removeServicesLock(
  configPath: string,
  root?: string,
): Promise<boolean> {
  try {
    await unlink(await resolveServicesLockPath(configPath, root));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Whole seconds since the lock was written (0 for a bad/future timestamp). */
export function servicesLockAgeSeconds(
  lock: Pick<ServicesOwnerLock, "startedAt">,
  now: number = Date.now(),
): number {
  const started = Date.parse(lock.startedAt);
  return Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : 0;
}

/** `42s`, `5m`, `3h 12m`, `2d 4h`. */
export function formatServicesAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "`cairn services up` (cli, pid 4242) since <iso> (5m ago)". */
export function describeServicesLock(
  lock: ServicesOwnerLock,
  now: number = Date.now(),
): string {
  return (
    `\`cairn services up\` (${lock.by}, pid ${lock.pid}) since ${lock.startedAt} ` +
    `(${formatServicesAge(servicesLockAgeSeconds(lock, now))} ago)`
  );
}

/**
 * The owner lock blocks this run (`locked`), it was taken for another
 * environment of the same config (`other-env`), the services it owns are not
 * up (`stale`), `--reuse-services` found no lock (`missing`), or the lock
 * file cannot be read (`unreadable`). Nothing was started; maps to exit 4.
 */
export class ServicesLockError extends Error {
  override name = "ServicesLockError";
  readonly exitCode = 4 as const;
  constructor(
    message: string,
    readonly reason:
      | "locked"
      | "other-env"
      | "stale"
      | "missing"
      | "unreadable",
    readonly lockPath: string,
  ) {
    super(message);
  }
}

/** Liveness of an environment `cairn services up` left running. */
export interface ServicesLiveness {
  live: boolean;
  /** One line per phase that is not up (empty when live). */
  problems: string[];
  /**
   * Phases that could not be checked and were trusted (e.g. a docker command
   * whose compose project `docker compose ps` cannot see); never stale.
   */
  unchecked: string[];
}

/** Budget of the one-shot docker readiness check behind a reuse. */
const REUSE_READINESS_TIMEOUT_MS = 10_000;

/** The `unchecked` hint for docker liveness without a readinessCheck. */
const READINESS_CHECK_HINT =
  "set services.docker.readinessCheck for an exact check";

/**
 * One quick look (no polling, no starting) at whether the services are up:
 * docker `readinessCheck` (or, without one, `docker compose ps` with the
 * compose command's own project options and env), the tmux session, each
 * window, and each window's readiness — `readyOn.url` must answer; any
 * window must not have exited to an idle shell or a dead pane. A docker
 * phase it cannot see is reported in `unchecked`, not as a problem. Used by
 * `run` (reuse and lock refusals) and `services status`.
 */
export async function checkServicesLive(
  cfg: ServicesConfig,
  ctx: Pick<
    StartServicesContext,
    "configDir" | "env" | "selectedTvaultKeys" | "signal" | "gates"
  >,
): Promise<ServicesLiveness> {
  const problems: string[] = [];
  const unchecked: string[] = [];
  const envCtx = ctx as StartServicesContext;
  if (cfg.docker) {
    const cwd = resolveCwd(cfg.docker.cwd, ctx.configDir);
    const env = targetEnv(envCtx, cfg.docker.env);
    if (cfg.docker.readinessCheck) {
      const r = await runShellWithTimeout(
        cfg.docker.readinessCheck,
        { cwd, env, signal: ctx.signal },
        REUSE_READINESS_TIMEOUT_MS,
      );
      if (r.exitCode !== 0) {
        problems.push(`docker readiness check failed (exit ${r.exitCode})`);
      }
    } else if (isDockerComposeCommand(cfg.docker.command)) {
      const probe = await probeDockerCompose(cfg.docker.command, cwd, env);
      if (probe.state === "stopped") {
        problems.push(
          `docker compose reports no running containers (${READINESS_CHECK_HINT})`,
        );
      } else if (probe.state === "unknown") {
        unchecked.push(
          `docker: ${probe.reason}; trusted as up (${READINESS_CHECK_HINT})`,
        );
      }
    } else {
      unchecked.push(
        `docker: not a Compose command and no readinessCheck; trusted as up (${READINESS_CHECK_HINT})`,
      );
    }
    // F2: one look at each `ready` gate.
    problems.push(
      ...(await gateProblems(cfg.docker.ready, ctx, {
        env,
        cwd,
        label: "docker",
      })),
    );
  }
  if (cfg.tmux) {
    const session = cfg.tmux.session;
    if (!(await tmuxSessionExists(session))) {
      problems.push(`tmux session "${session}" is not running`);
    } else {
      for (const win of cfg.tmux.windows) {
        const problem = await tmuxWindowProblem(cfg.tmux, win, ctx);
        if (problem) problems.push(problem);
      }
    }
  }
  return { live: problems.length === 0, problems, unchecked };
}

/** Why one window of a running session is not up, or undefined. */
async function tmuxWindowProblem(
  tmux: TmuxConfig,
  win: TmuxWindow,
  ctx: Pick<
    StartServicesContext,
    "configDir" | "env" | "selectedTvaultKeys" | "signal" | "gates"
  >,
): Promise<string | undefined> {
  const session = tmux.session;
  if (!(await tmuxWindowExists(session, win.name))) {
    return `tmux window "${win.name}" is missing`;
  }
  const pane = await inspectTmuxPaneForReadiness(session, win.name);
  if (pane.kind === "missing") return `tmux window "${win.name}" is missing`;
  if (pane.kind === "dead") {
    return `tmux window "${win.name}" pane exited${
      pane.exitCode === undefined ? "" : ` (exit ${pane.exitCode})`
    }`;
  }
  if (pane.kind === "idle-shell") {
    return `tmux window "${win.name}" is back at an idle shell (${pane.currentCommand}); its command is not running`;
  }
  if (win.readyOn?.url) {
    const probe = await probeReady(win.readyOn.url, {
      anyResponse: win.readyOn.anyResponse === true,
    });
    if (!probe.ready) {
      return probe.status === undefined
        ? `tmux window "${win.name}" is not ready (${win.readyOn.url} does not answer)`
        : `tmux window "${win.name}" is not ready (${probe.detail})` +
            readinessHint(probe.status, false);
    }
  }
  if (win.readyOn?.gate !== undefined) {
    const [problem] = await gateProblems(win.readyOn.gate, ctx, {
      env: targetEnv(ctx as StartServicesContext, { ...tmux.env, ...win.env }),
      cwd: resolveCwd(win.cwd, ctx.configDir),
      label: `tmux window "${win.name}"`,
    });
    if (problem) return problem;
  }
  return undefined;
}

/**
 * The handle of a run that reuses an environment `cairn services up` owns:
 * it records `reuse`/`skip` lifecycle events (never `start` or `teardown`),
 * captures run-local service evidence like a reused session, and its stop()
 * and signal-path teardown leave everything running.
 */
export function reuseLockedServices(
  cfg: ServicesConfig,
  ctx: StartServicesContext,
  lock: ServicesOwnerLock,
  exportedEnv: Record<string, string> = {},
): ServicesHandle {
  const phases = newPhaseState(cfg, ctx);
  phases.provisionerIndex = undefined;
  phases.dockerDisposition = cfg.docker ? "reused" : undefined;
  phases.tmuxSessionName = cfg.tmux?.session;
  phases.tmuxDisposition = cfg.tmux ? "reused" : undefined;
  phases.tmuxReuse = true;
  phases.teardownCommands = [];
  phases.teardownPolicies = [];
  const data = {
    owner: lock.owner,
    by: lock.by,
    lockStartedAt: lock.startedAt,
  };
  const emit = (
    phase: ServicesEvent["phase"],
    event: ServicesEventName,
    message: string,
  ): void => {
    const e: ServicesEvent = {
      phase,
      event,
      message,
      timestamp: new Date().toISOString(),
      data,
    };
    phases.events.push(e);
    ctx.onEvent?.(e);
  };
  if (cfg.docker) {
    emit("docker", "reuse", "reusing the containers `cairn services up` owns");
  }
  if (cfg.seed) emit("seed", "skip", "owned by `cairn services up`");
  if (cfg.tmux) {
    emit(
      "tmux",
      "reuse",
      `reusing session "${cfg.tmux.session}" owned by \`cairn services up\``,
    );
  }
  return {
    startedByUs: false,
    events: phases.events,
    reusedLock: lock,
    ...(Object.keys(exportedEnv).length > 0 ? { exportedEnv } : {}),
    captureRunArtifacts: (status, runWindow) =>
      collectRunArtifacts(cfg, phases, ctx, status, runWindow),
    captureSignalArtifactsSync: (runDir, signal) => {
      captureTmuxSignalArtifactsSync({
        runDir,
        signal,
        session: phases.tmuxSessionName,
        windows: cfg.tmux?.windows.map((window) => window.name) ?? [],
        policy: phases.localArtifactPolicy,
        redactor: phases.artifactRedactor,
        disposition: phases.tmuxDisposition,
        startedAt: phases.startedAt,
      });
    },
    stop: async () => {
      ctx.log?.(
        "services: left running for `cairn services up` (stop them with `cairn services down`)",
      );
    },
    terminateSync: () => undefined,
  };
}

/** One teardown command `teardownServices` ran. */
export interface ServicesTeardownStep {
  command: string;
  ok: boolean;
  exitCode?: number;
  error?: string;
  /** A `critical: true` entry, or the provisioner's `down`: a failure is exit 8. */
  critical?: boolean;
  /** The step is the provisioner's `down`. */
  provisioner?: boolean;
  timedOut?: boolean;
}

/** What a full teardown did. */
export interface ServicesTeardownReport {
  steps: ServicesTeardownStep[];
  tmuxSession?: string;
  /** True when the tmux session was still running and teardown killed it. */
  tmuxKilled: boolean;
  /** Tunnels a state file named, and what happened to each. */
  tunnels: Array<{ name: string; result: "stopped" | "gone" | "skipped" }>;
  events: ServicesEvent[];
}

/**
 * Full teardown for `cairn services down`: every configured teardown
 * command in order — with no reuse skipping, so `docker compose down` and
 * `tmux kill-session` run when the config lists them — then the tmux
 * session is killed if it is still running, the tunnels a state file names
 * are stopped, and the provisioner's `down` runs last (critical: a failure
 * is exit 8 in the CLI). Best-effort per command (a failure is reported and
 * the rest still runs); never throws for a command.
 */
export async function teardownServices(
  cfg: ServicesConfig,
  ctx: Pick<
    StartServicesContext,
    | "configDir"
    | "configPath"
    | "env"
    | "envName"
    | "selectedTvaultKeys"
    | "log"
    | "onEvent"
    | "project"
    | "stateRoot"
  >,
): Promise<ServicesTeardownReport> {
  const events: ServicesEvent[] = [];
  const emit = (
    event: ServicesEventName,
    message: string,
    data: Record<string, unknown>,
  ): void => {
    const e: ServicesEvent = {
      phase: "teardown",
      event,
      message,
      timestamp: new Date().toISOString(),
      data,
    };
    events.push(e);
    ctx.onEvent?.(e);
  };
  const steps: ServicesTeardownStep[] = [];
  const runEntry = async (
    index: number,
    command: string,
    policy: { critical: boolean; timeoutMs: number | undefined },
    provisioner: boolean,
    extraEnv: Record<string, string> = {},
  ): Promise<void> => {
    ctx.log?.(`teardown (${command})`);
    const marks = {
      ...(policy.critical ? { critical: true } : {}),
      ...(provisioner ? { provisioner: true } : {}),
    };
    try {
      // A timeout (and the provisioner's `down`) runs in its own process
      // group, killed at the deadline.
      const result =
        policy.timeoutMs !== undefined || provisioner
          ? await runShellDetached(
              command,
              {
                cwd: ctx.configDir,
                env: targetEnv(ctx as StartServicesContext, extraEnv),
              },
              undefined,
              TEARDOWN_OUTPUT_BYTES,
              policy.timeoutMs,
            )
          : await runShell(command, {
              cwd: ctx.configDir,
              env: targetEnv(ctx as StartServicesContext),
            });
      const timedOut =
        "timedOut" in result &&
        (result as { timedOut?: boolean }).timedOut === true;
      const ok = result.exitCode === 0 && !timedOut;
      steps.push({
        command,
        ok,
        exitCode: result.exitCode,
        ...marks,
        ...(timedOut ? { timedOut: true } : {}),
      });
      if (!ok) {
        ctx.log?.(
          `teardown[${index}] ${
            timedOut ? "timed out" : `failed (exit ${result.exitCode})`
          }; continuing`,
        );
      }
      emit(
        ok ? "complete" : "fail",
        `teardown[${index}] ${ok ? "completed" : "failed"}`,
        {
          index,
          exitCode: result.exitCode,
          ...marks,
          ...(timedOut ? { timedOut: true } : {}),
        },
      );
    } catch (error) {
      steps.push({
        command,
        ok: false,
        error: (error as Error).message,
        ...marks,
      });
      ctx.log?.(`teardown[${index}] failed to execute; continuing`);
      emit("fail", `teardown[${index}] failed to execute`, {
        index,
        error: (error as Error).name,
        ...marks,
      });
    }
  };
  const policies = normalizeTeardown(cfg.teardown);
  for (const [index, policy] of policies.entries()) {
    await runEntry(index, policy.run, policy, false);
  }
  const session = cfg.tmux?.session;
  let tmuxKilled = false;
  if (session && (await tmuxSessionExists(session))) {
    ctx.log?.(`tmux — killing session "${session}"`);
    await execa("tmux", ["kill-session", "-t", tmuxSessionTarget(session)], {
      reject: false,
      timeout: 5_000,
    }).catch(() => undefined);
    tmuxKilled = true;
  }
  let tunnels: ServicesTeardownReport["tunnels"] = [];
  if (cfg.tunnels && cfg.tunnels.length > 0) {
    const reports = await stopTunnelsFromState(cfg.tunnels, {
      project: tunnelKeyOf(ctx),
      stateRoot: ctx.stateRoot ?? servicesStateRoot(),
    });
    tunnels = reports.map(({ name, result }) => ({ name, result }));
    for (const report of reports) {
      if (report.result === "stopped") {
        ctx.log?.(`tunnel "${report.name}" stopped`);
      }
    }
  }
  if (cfg.provisioner) {
    const down =
      typeof cfg.provisioner.down === "string"
        ? { run: cfg.provisioner.down }
        : cfg.provisioner.down;
    // `down` usually needs what `up` created (an id, an address): the export
    // commands print those values again, in this separate process too.
    let exported: Record<string, string> = {};
    try {
      exported = await evaluateProvisionerExports(cfg, {
        ...(ctx as StartServicesContext),
        bootPids: new Set(),
      });
    } catch (error) {
      ctx.log?.(
        `provisioner exports could not be evaluated for the down command: ${(error as Error).message.split("\n")[0]}`,
      );
    }
    await runEntry(
      policies.length,
      down.run,
      {
        critical: ("critical" in down ? down.critical : undefined) !== false,
        timeoutMs: toMs("timeout" in down ? down.timeout : undefined),
      },
      true,
      exported,
    );
  }
  // The stack is down: a resume a failed seed left behind no longer holds.
  if (cfg.seed?.phases) {
    try {
      const file = new SeedPhaseStore(ctx.stateRoot).pathFor(
        ctx.project,
        ctx.envName ?? "default",
        seedTargetHash({
          target: cfg.seed.target,
          cwd: resolveCwd(cfg.seed.cwd, ctx.configDir),
          env: cfg.seed.env,
        }),
      );
      if (dropSeedResumeSync(file)) {
        ctx.log?.("seed — resume dropped; the next run repeats every phase");
      }
    } catch {
      // An unusable project name has no seed state to drop.
    }
  }
  return {
    steps,
    ...(session ? { tmuxSession: session } : {}),
    tmuxKilled,
    tunnels,
    events,
  };
}

/* ----- phase state ----- */

/** Fresh state for one boot (or one reuse) of a services environment. */
function newPhaseState(
  cfg: ServicesConfig,
  ctx: Pick<StartServicesContext, "env" | "secretValues">,
): PhaseState {
  const teardownPolicies = normalizeTeardown(cfg.teardown);
  // An environment can patch the provisioner, so the merged one may lack
  // what the top level alone would have needed.
  if (cfg.provisioner && (!cfg.provisioner.up || !cfg.provisioner.down)) {
    throw new ServicesError(
      "services.provisioner needs both `up` and `down` after the environment merge (a provisioned resource must always have a `down`)",
    );
  }
  // F10: a provisioner's `down` is a critical teardown entry placed last
  // (after the tmux session and the other teardown commands), so the
  // resource outlives everything that uses it. It runs through the same
  // machinery as every other critical entry (async path, failure cleanup,
  // signal path), which is what makes "always torn down" and exit 8 hold.
  let provisionerIndex: number | undefined;
  if (cfg.provisioner) {
    const down =
      typeof cfg.provisioner.down === "string"
        ? { run: cfg.provisioner.down }
        : cfg.provisioner.down;
    provisionerIndex = teardownPolicies.length;
    teardownPolicies.push({
      run: down.run,
      critical: ("critical" in down ? down.critical : undefined) !== false,
      timeoutMs: toMs("timeout" in down ? down.timeout : undefined),
      onSignal: ("onSignal" in down ? down.onSignal : undefined) ?? "wait",
    });
  }
  return {
    provisionerIndex,
    provisionerUpStarted: false,
    provisioned: false,
    provisionerConfig: undefined,
    provisionerRunning: false,
    provisionerExportsDone: false,
    exportedEnv: {},
    launchedWindows: new Set<string>(),
    restartAfterBoot: new Set<string>(),
    startedAt: new Date().toISOString(),
    dockerStarted: false,
    dockerDisposition: undefined,
    dockerRefreshed: false,
    tmuxSession: undefined,
    tmuxSessionName: undefined,
    tmuxDisposition: undefined,
    tmuxReuse: false,
    teardownCommands: teardownPolicies.map((policy) => policy.run),
    teardownPolicies,
    criticalFailures: [],
    teardownSettled: new Set(),
    teardownRunning: undefined,
    teardownPid: undefined,
    teardownOutputFile: undefined,
    artifactsDir: undefined,
    artifacts: [],
    events: [],
    localArtifactPolicy: resolveServicesArtifactsConfig(cfg.artifacts),
    artifactRedactor: createArtifactRedactor(
      undefined,
      ctx.env ?? process.env,
      ctx.secretValues,
    ),
    commandArtifactRecords: [],
    commandArtifactBytes: 0,
    commandArtifactOmitted: {},
    stashSawFailure: false,
    seedStateFile: undefined,
    regularTeardownRan: false,
  };
}

/**
 * A teardown command ran: a resume a failed seed phase left behind points at
 * phases whose results that teardown may have destroyed. Drop it so the next
 * run repeats them.
 */
function dropSeedResumeAfterTeardown(
  phases: PhaseState,
  log?: (line: string) => void,
): void {
  if (!phases.regularTeardownRan || !phases.seedStateFile) return;
  if (dropSeedResumeSync(phases.seedStateFile)) {
    log?.("seed — teardown ran; the next run repeats every phase");
  }
}

interface PhaseState {
  /** Index of the provisioner's `down` in teardownCommands (when configured). */
  provisionerIndex: number | undefined;
  /** `up` was started: only then does `down` have anything to destroy. */
  provisionerUpStarted: boolean;
  /** A provisioner exists: tmux is never reused (its services die with it). */
  provisioned: boolean;
  /** The provisioner of this boot (its exports feed the `down`). */
  provisionerConfig: ProvisionerConfig | undefined;
  /** Its `up` or an export command is running right now. */
  provisionerRunning: boolean;
  /** The exports were evaluated (or tried once for the `down`). */
  provisionerExportsDone: boolean;
  /** Values the provisioner exported (never logged). */
  exportedEnv: Record<string, string>;
  tunnels?: TunnelSet;
  supervisor?: WindowSupervisor;
  /** Windows booted (launched) during this startServices call. */
  launchedWindows: Set<string>;
  /** Windows a changed `services.files` entry wants restarted. */
  restartAfterBoot: Set<string>;
  /** Invocation lower bound used when no per-run Docker log window is supplied. */
  startedAt: string;
  dockerStarted: boolean;
  dockerDisposition: "started" | "reused" | undefined;
  /**
   * True when docker compose actually had to bring containers up (they were
   * not already running). Distinct from `dockerStarted`, which is also set
   * when cold-start re-runs `compose up` against already-running containers.
   * Only a real refresh should invalidate a live tmux session.
   */
  dockerRefreshed: boolean;
  tmuxSession: string | undefined;
  /** The managed tmux session name (set even when reused, for teardown-skip). */
  tmuxSessionName: string | undefined;
  tmuxDisposition: "created" | "recreated" | "reused" | undefined;
  /** Whether the tmux session is in reuse mode (leave alive at end-of-run). */
  tmuxReuse: boolean;
  teardownCommands: string[];
  /** The policy of each teardown entry (`critical`, `timeout`, `onSignal`). */
  teardownPolicies: NormalizedTeardown[];
  /** Critical teardown entries that failed or timed out. */
  criticalFailures: CriticalTeardownFailure[];
  /** Teardown indices already run (or skipped for reuse) by stop()/cleanup. */
  teardownSettled: Set<number>;
  /** Index of the teardown command the async path is running right now. */
  teardownRunning: number | undefined;
  /** Pid (= process group) of that command, once spawned. */
  teardownPid: number | undefined;
  /** Private temp file that command writes its output to. */
  teardownOutputFile: string | undefined;
  /** Captured artifacts for fcheap stashing (tmux captures, docker logs, seed output). */
  artifactsDir: string | undefined;
  artifacts: { phase: string; file: string; label: string }[];
  /** Structured lifecycle events collected during startServices. */
  events: ServicesEvent[];
  /** Effective local artifact policy, including defaults when config omitted it. */
  localArtifactPolicy: ServicesArtifactsConfig;
  /** Redactor shared by stored command output and live service captures. */
  artifactRedactor: ArtifactRedactor;
  /** Completed lifecycle command output, bounded at collection time. */
  commandArtifactRecords: StoredServiceCommandArtifactRecord[];
  commandArtifactBytes: number;
  commandArtifactOmitted: Partial<Record<"docker" | "seed", number>>;
  /** A run of this invocation failed or errored (services.stash on-failure). */
  stashSawFailure: boolean;
  /** The F12 seed state file of this boot (a teardown drops its resume). */
  seedStateFile: string | undefined;
  /** A configured (non-provisioner) teardown command ran. */
  regularTeardownRan: boolean;
}

interface StoredServiceCommandArtifactRecord {
  source: "docker" | "seed";
  kind: "command" | "readiness" | "freshness" | "post-command" | "phase";
  index: number;
  label: string;
  content: string;
  bytes: number;
  truncated: boolean;
  exitCode: number;
}

/** Emit callback type used by all phases. */
type EmitFn = (
  phase: ServicesEvent["phase"],
  event: ServicesEventName,
  message: string,
  data?: Record<string, unknown>,
) => void;

/* ----- Phase 1: Docker ----- */

async function startDocker(
  cfg: DockerConfig,
  ctx: StartServicesContext,
  coldStart: boolean,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const reuse = cfg.reuseExisting ?? !coldStart;
  const cwd = resolveCwd(cfg.cwd, ctx.configDir);
  const env = targetEnv(ctx, cfg.env);
  const artifactRedactor = createArtifactRedactor(
    undefined,
    env,
    ctx.secretValues,
  );
  const timeout = cfg.readyTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  // Snapshot before any compose command so cold-start re-runs of
  // `compose up` against already-running containers don't look like a refresh.
  // A provisioner command (Chalupa, Terraform, a remote SSH wrapper) has no
  // relationship to the caller's local Compose context; probing it can both
  // inspect the wrong stack and add a needless 10-second timeout.
  const wasRunning = isDockerComposeCommand(cfg.command)
    ? await dockerComposeRunning(cwd)
    : false;

  // Reuse check: is docker compose already reporting running containers?
  if (reuse && wasRunning) {
    phases.dockerDisposition = "reused";
    ctx.log?.("services: docker — reusing running containers");
    emit("docker", "reuse", "reusing running containers");
    // F2: running containers are not proof of readiness (a restarting
    // Elasticsearch, a mongod still recovering): `ready` gates still apply.
    await waitDockerReadyGates(
      cfg,
      ctx,
      { env, cwd, timeoutMs: timeout },
      emit,
    );
    return;
  }

  ctx.log?.(`docker (${cfg.command})`);
  emit("docker", "start", cfg.command);
  const liveOutput = serviceOutput(ctx, "docker", artifactRedactor);
  liveOutput?.announce(cfg.command);
  const onChunk =
    ctx.onOutput || liveOutput
      ? (_s: "stdout" | "stderr", chunk: string) => {
          ctx.onOutput?.(chunk);
          liveOutput?.push(chunk);
        }
      : undefined;
  const r = await runShellWithTimeout(
    cfg.command,
    { cwd, env, signal: ctx.signal, track: ctx.bootPids },
    timeout,
    onChunk,
  );
  liveOutput?.finish(r.exitCode);
  storeServiceCommandArtifactRecord(phases, "docker", {
    kind: "command",
    index: 0,
    label: "start",
    command: cfg.command,
    result: r,
    redactor: artifactRedactor,
  });
  if (r.exitCode !== 0) {
    emit("docker", "fail", `exit ${r.exitCode}`, { exitCode: r.exitCode });
    throw new ServicesError(
      `docker command failed (exit ${r.exitCode}): ${cfg.command}\n` +
        tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
    );
  }

  // Optional readiness check: a command whose exit 0 means infra is ready.
  // Polled until the phase deadline (`readyTimeoutMs`; 0 waits indefinitely)
  // because a container routinely needs seconds after `Started` before it
  // accepts connections — a single attempt races initdb on a fresh machine.
  // readinessCheck and the `ready` gates share one readiness budget: the
  // gates get what the check left of readyTimeoutMs (like webServer.ready).
  const deadline =
    timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY;
  if (cfg.readinessCheck) {
    ctx.logDetail?.(`docker — readiness check (${cfg.readinessCheck})`);
    emit("docker", "readiness-check", cfg.readinessCheck);
    let attempts = 1;
    let rc = await runShellWithTimeout(
      cfg.readinessCheck,
      { cwd, env, signal: ctx.signal, track: ctx.bootPids },
      timeout,
    );
    while (rc.exitCode !== 0 && Date.now() + READINESS_POLL_MS <= deadline) {
      attempts += 1;
      ctx.logDetail?.(
        `docker — readiness check attempt ${attempts} failed (exit ${rc.exitCode}); retrying in ${READINESS_POLL_MS}ms`,
      );
      await sleepUnlessCancelled(READINESS_POLL_MS, ctx.signal);
      const remaining = deadline - Date.now();
      rc = await runShellWithTimeout(
        cfg.readinessCheck,
        { cwd, env, signal: ctx.signal, track: ctx.bootPids },
        timeout > 0 ? Math.max(1_000, remaining) : timeout,
      );
    }
    storeServiceCommandArtifactRecord(phases, "docker", {
      kind: "readiness",
      index: 0,
      label: "readiness-check",
      command: cfg.readinessCheck,
      result: rc,
      redactor: artifactRedactor,
    });
    if (rc.exitCode !== 0) {
      emit("docker", "fail", `readiness check exit ${rc.exitCode}`, {
        exitCode: rc.exitCode,
      });
      throw new ServicesError(
        `docker readiness check failed after ${attempts} attempt(s) (exit ${rc.exitCode}): ${cfg.readinessCheck}\n` +
          tailText(`${rc.stdout}\n${rc.stderr}`, SHELL_TAIL_LINES),
      );
    }
    if (attempts > 1) {
      ctx.logDetail?.(
        `docker — readiness check passed after ${attempts} attempts`,
      );
      emit(
        "docker",
        "ready",
        `readiness check passed after ${attempts} attempts`,
      );
    }
  }

  // F2: typed readiness gates (tcp/http/command, stable, all/any).
  await waitDockerReadyGates(
    cfg,
    ctx,
    {
      env,
      cwd,
      timeoutMs: timeout > 0 ? Math.max(1, deadline - Date.now()) : 0,
    },
    emit,
  );

  // Optional healthcheck: run once after readiness to verify infra health.
  if (cfg.healthcheck) {
    emit("docker", "healthcheck", "running");
    const hcResult = await runHealthcheck(
      cfg.healthcheck,
      { cwd, env },
      ctx,
      "docker",
    );
    if (!hcResult.healthy) {
      ctx.log?.(
        `docker — healthcheck WARNING: unhealthy after ${hcResult.consecutiveFailures} failures`,
      );
      emit(
        "docker",
        "healthcheck",
        `unhealthy after ${hcResult.consecutiveFailures} failures`,
        {
          healthy: false,
          consecutiveFailures: hcResult.consecutiveFailures,
        },
      );
    } else {
      emit("docker", "healthcheck", "healthy");
    }
  }

  phases.dockerStarted = true;
  phases.dockerDisposition = "started";
  // Only a real bring-up of previously-down containers invalidates tmux panes.
  phases.dockerRefreshed = !wasRunning;
  ctx.log?.("services: docker — ready");
  emit("docker", "ready", "docker ready");
}

export async function dockerComposeRunning(cwd: string): Promise<boolean> {
  try {
    const r = await execa("docker", ["compose", "ps", "--format", "json"], {
      cwd,
      reject: false,
      timeout: 10_000,
    });
    return composePsListsRunning(r.stdout);
  } catch {
    return false;
  }
}

/** Whether `docker compose ps --format json` output lists a running container. */
function composePsListsRunning(output: string): boolean {
  const stdout = output.trim();
  if (!stdout) return false;

  // `docker compose ps --format json` outputs one JSON object per line (NDJSON).
  // Older versions may output a single JSON array. Parse both forms.
  const containers: Array<{ State?: string; Status?: string }> = [];
  try {
    // Try parsing as a single JSON array first.
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      containers.push(...parsed);
    } else {
      containers.push(parsed);
    }
  } catch {
    // NDJSON: one JSON object per line.
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        containers.push(JSON.parse(trimmed));
      } catch {
        // skip unparseable lines
      }
    }
  }

  // A container is running if State is "running" or Status starts with "Up".
  return containers.some(
    (c) =>
      (c.State && c.State.toLowerCase() === "running") ||
      (c.Status && /^Up\b/.test(c.Status)),
  );
}

/** What `docker compose ps` says about the project a compose command starts. */
export type DockerComposeProbe =
  | { state: "running" }
  | { state: "stopped" }
  | { state: "unknown"; reason: string };

/** Compose global options that select the project (kept for `ps`). */
const COMPOSE_PROJECT_OPTIONS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--env-file",
  "--profile",
]);
/** Compose global options with a value that do not select the project. */
const COMPOSE_OUTPUT_OPTIONS = new Set(["--ansi", "--progress", "--parallel"]);
/** Compose global boolean options. */
const COMPOSE_FLAG_OPTIONS = new Set([
  "--compatibility",
  "--dry-run",
  "--all-resources",
]);

/**
 * The `ps` invocation of a plain `[VAR=value …] docker compose [global
 * options] <command> …` (or `docker-compose`) command: its project-selecting
 * global options (`-f`, `-p`, `--project-directory`, `--env-file`,
 * `--profile`) and its leading variable assignments (`COMPOSE_FILE=…`).
 * Undefined for anything else — shell operators or expansions, a wrapper,
 * `docker --context …`, an option of unknown arity — because then nobody can
 * tell which project the command starts.
 */
export function composePsInvocation(
  command: string,
): { args: string[]; env: Record<string, string> } | undefined {
  if (/[;&|<>`$\\(){}\n\r]/.test(command)) return undefined;
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: string | undefined;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return undefined;
  if (inToken) tokens.push(current);

  let i = 0;
  const env: Record<string, string> = {};
  for (; i < tokens.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(tokens[i]!);
    if (!match) break;
    env[match[1]!] = match[2]!;
  }
  if (tokens[i] === "docker" && tokens[i + 1] === "compose") i += 2;
  else if (tokens[i] === "docker-compose") i += 1;
  else return undefined;

  const args: string[] = [];
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    const token = tokens[i]!;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (COMPOSE_FLAG_OPTIONS.has(name) && eq < 0) {
      i += 1;
      continue;
    }
    if (
      !COMPOSE_PROJECT_OPTIONS.has(name) &&
      !COMPOSE_OUTPUT_OPTIONS.has(name)
    ) {
      return undefined;
    }
    const value = eq > 0 ? token.slice(eq + 1) : tokens[i + 1];
    if (value === undefined) return undefined;
    if (COMPOSE_PROJECT_OPTIONS.has(name)) args.push(name, value);
    i += eq > 0 ? 1 : 2;
  }
  // No compose subcommand: not a command that starts anything.
  if (i >= tokens.length) return undefined;
  return { args, env };
}

/**
 * Whether the compose project `command` starts has a running container:
 * `docker compose <its project options> ps --format json` in its cwd and
 * environment. `unknown` (never `stopped`) when the command is not a plain
 * compose invocation or `ps` itself fails (no compose file found, no docker,
 * a timeout) — a liveness check must not call a stack it cannot see stale.
 */
export async function probeDockerCompose(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<DockerComposeProbe> {
  const invocation = composePsInvocation(command);
  if (!invocation) {
    return {
      state: "unknown",
      reason: "the docker command is not a plain `docker compose …` invocation",
    };
  }
  const args = ["compose", ...invocation.args, "ps", "--format", "json"];
  try {
    const r = await execa("docker", args, {
      cwd,
      env: { ...env, ...invocation.env },
      extendEnv: false,
      reject: false,
      timeout: 10_000,
    });
    if (r.failed || r.exitCode !== 0) {
      return {
        state: "unknown",
        reason: `\`docker ${args.join(" ")}\` failed (${
          r.timedOut ? "timed out" : `exit ${r.exitCode ?? "?"}`
        })`,
      };
    }
    return composePsListsRunning(r.stdout)
      ? { state: "running" }
      : { state: "stopped" };
  } catch (error) {
    return {
      state: "unknown",
      reason: `\`docker ${args.join(" ")}\` failed (${(error as Error).message})`,
    };
  }
}

/* ----- Phase 2: Conditional seed ----- */

async function startSeed(
  cfg: SeedConfig,
  ctx: StartServicesContext,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const cwd = resolveCwd(cfg.cwd, ctx.configDir);
  const env = await resolveSeedEnv(cfg, ctx);
  const redactor = createArtifactRedactor(undefined, env, ctx.secretValues);
  const timeout = cfg.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;

  // F12: a seed described as phases keeps its own per-phase state.
  if (cfg.phases) {
    await runSeedPhases(
      cfg,
      cfg.phases,
      { cwd, env, timeout },
      ctx,
      emit,
      phases,
      redactor,
    );
    return;
  }

  const command = cfg.command!;
  // `commit: afterPostCommands` (or a `target`) keeps the freshness record per
  // project + environment + target, and writes it only once the post-commands
  // passed. Without either, the 2.x behavior is unchanged.
  const hold = cfg.commit === "afterPostCommands";
  const store =
    hold || cfg.target !== undefined
      ? new ScopedSeedFreshness(
          new SeedPhaseStore(ctx.stateRoot),
          ctx.envName ?? "default",
          seedTargetHash({ target: cfg.target, cwd, env: cfg.env }),
        )
      : new SeedStateStore();
  const state = await store.read(ctx.project);
  const check = store.checkFreshness(ctx.project, cfg, state);
  let pendingCommit = false;
  const record = async (exitCode: number): Promise<void> => {
    if (hold && exitCode === 0) {
      pendingCommit = true;
      return;
    }
    await store.recordRun(ctx.project, cfg, exitCode);
  };
  const finish = async (): Promise<void> => {
    const summary = await runSeedPostCommands(
      cfg,
      { cwd, env, timeout },
      ctx,
      emit,
      phases,
      redactor,
    );
    if (!pendingCommit) return;
    if (summary.failed.length === 0) {
      await store.recordRun(ctx.project, cfg, 0);
      emit("seed", "commit", "seed committed after its post-commands", {
        committed: true,
      });
    } else {
      const labels = summary.failed.map((f) => f.label);
      ctx.log?.(
        redactor.text(
          `seed — not committed: postCommand(s) ${labels.join(", ")} failed; the next run seeds again`,
        ),
      );
      emit("seed", "commit", "seed not committed: a postCommand failed", {
        committed: false,
        failed: labels,
      });
    }
  };

  if (!check.shouldRun) {
    ctx.log?.(redactor.text(`seed — skipping (${check.reason})`));
    emit("seed", "skip", check.reason);
    await finish();
    return;
  }

  // If the fingerprint + TTL pass but freshnessCheck is configured, run it.
  if (check.reason === "freshness-check-pending" && cfg.freshnessCheck) {
    ctx.logDetail?.(
      redactor.text(`seed — freshness check (${cfg.freshnessCheck})`),
    );
    emit("seed", "freshness-check", redactor.text(cfg.freshnessCheck));
    const fr = await runShellWithTimeout(
      cfg.freshnessCheck,
      { cwd, env, signal: ctx.signal, track: ctx.bootPids },
      timeout,
    );
    storeServiceCommandArtifactRecord(phases, "seed", {
      kind: "freshness",
      index: 0,
      label: "freshness-check",
      command: cfg.freshnessCheck,
      result: fr,
      redactor,
    });
    if (fr.exitCode === 0) {
      ctx.log?.("services: seed — freshness check passed, skipping");
      emit("seed", "skip", "freshness check passed");
      // Still record the freshness check as a successful "non-seed" so the
      // timestamp is updated for the next TTL window.
      await record(0);
      await finish();
      return;
    }
    ctx.log?.(
      redactor.text(
        `seed — freshness check failed (exit ${fr.exitCode}), re-seeding`,
      ),
    );
    emit(
      "seed",
      "freshness-check",
      `failed (exit ${fr.exitCode}), re-seeding`,
      {
        exitCode: fr.exitCode,
      },
    );
  }

  ctx.log?.(redactor.text(`seed — running (${command})`));
  emit("seed", "start", redactor.text(command));
  // A heavy import can run for many minutes; plain/CI runs have no ticker, so
  // emit a bounded info heartbeat so the phase reads as "working, bounded"
  // instead of a silent stall. The tty narrator filters these (its ticker
  // already shows elapsed).
  const seedStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Date.now() - seedStartedAt;
    const m = Math.floor(elapsed / 60_000);
    const s = Math.floor((elapsed - m * 60_000) / 1000);
    ctx.log?.(
      redactor.text(`seed — still running after ${m > 0 ? `${m}m ` : ""}${s}s`),
    );
  }, 60_000);
  heartbeat.unref?.();
  const liveOutput = serviceOutput(ctx, "seed", redactor);
  liveOutput?.announce(command);
  let r: ShellResult;
  try {
    r = await runShellWithTimeout(
      command,
      { cwd, env, signal: ctx.signal, track: ctx.bootPids },
      timeout,
      liveOutput ? (_s, chunk) => liveOutput.push(chunk) : undefined,
    );
  } finally {
    clearInterval(heartbeat);
  }
  liveOutput?.finish(r.exitCode);
  storeServiceCommandArtifactRecord(phases, "seed", {
    kind: "command",
    index: 0,
    label: "seed-command",
    command,
    result: r,
    redactor,
  });
  // Seed details are play-by-play behind the "seed — running" milestone:
  // route the redacted stream through the detail channel (DEBUG — shown with
  // --verbose) instead of the live stream, so a default run stays readable.
  // The full output still lands in the service-log artifact, and a failing
  // seed surfaces its tail through the error below.
  const seedStream = redactor.text(`${r.stdout}\n${r.stderr}`).trimEnd();
  if (seedStream) ctx.logDetail?.(seedStream);

  // F12: a seed that prints an error but exits 0 is a failed seed.
  const violation =
    r.exitCode === 0
      ? expectOutputViolation(`${r.stdout}\n${r.stderr}`, cfg.expectOutput)
      : undefined;

  // Record the result regardless of exit code (failed seeds are tracked too).
  await record(violation ? 1 : r.exitCode);

  if (violation) {
    emit("seed", "fail", "seed output check failed", { exitCode: r.exitCode });
    throw new ServicesError(
      redactor.text(
        `seed command exited 0 but its ${violation}: ${command}\n` +
          tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
      ),
    );
  }
  if (r.exitCode !== 0) {
    emit("seed", "fail", `exit ${r.exitCode}`, { exitCode: r.exitCode });
    throw new ServicesError(
      redactor.text(
        `seed command failed (exit ${r.exitCode}): ${command}\n` +
          tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
      ),
    );
  }
  ctx.log?.("services: seed — complete");
  emit("seed", "complete", "seed complete");
  await finish();
}

/**
 * F12: the seed as ordered phases. A phase runs when `always` is set, or
 * when neither a recorded success of the same command within `ttlSeconds`
 * nor its `skipIf` says it is done. Each outcome is persisted per project +
 * environment + target (right away, or all at once after the post-commands
 * with `commit: afterPostCommands`; a failure is always recorded at once).
 */
async function runSeedPhases(
  cfg: SeedConfig,
  list: readonly SeedPhase[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ctx: StartServicesContext,
  emit: EmitFn,
  phases: PhaseState,
  redactor: ArtifactRedactor,
): Promise<void> {
  const envName = ctx.envName ?? "default";
  const store = new SeedPhaseStore(ctx.stateRoot);
  const targetHash = seedTargetHash({
    target: cfg.target,
    cwd: opts.cwd,
    env: cfg.env,
  });
  const state =
    (await store.read(ctx.project, envName, targetHash)) ??
    emptyScopedState(ctx.project, envName, targetHash);
  phases.seedStateFile = store.pathFor(ctx.project, envName, targetHash);
  const hold = cfg.commit === "afterPostCommands";
  const held: Record<string, PhaseRecord> = {};
  const ttl = cfg.ttlSeconds ?? 0;

  // Phases that succeeded in a run that then failed on a later phase: the
  // next run resumes after them (a seed transaction does not start over) —
  // unless the resume is older than the TTL, and a phase with a `skipIf`
  // still has to pass it (its result may be gone). A teardown drops it.
  const resumeAt = state.resume?.at ?? "earlier";
  const resumable = resumeFresh(state.resume, ttl)
    ? (state.resume?.done ?? {})
    : {};
  // What a later failure of this run lets the next one resume after: phases
  // that ran to success now, and resumed phases whose skipIf confirmed them.
  // A phase only carried over from an earlier resume is not passed on again,
  // so a seed whose earlier results are gone recovers on the next run.
  const doneThisRun: Record<string, string> = {};

  for (const [index, phase] of list.entries()) {
    throwIfCancelled(ctx.signal);
    const command = phaseRun(phase);
    const fingerprint = phaseFingerprint(phase);
    const resumed = !phase.always && resumable[phase.name] === fingerprint;
    let skipReason: string | undefined;
    if (phase.always) {
      skipReason = undefined;
    } else if (resumed && phase.skipIf !== undefined) {
      const confirmed = await seedPhaseSkipIf(
        phase,
        opts,
        ctx,
        phases,
        redactor,
      );
      if (confirmed !== undefined) {
        skipReason = `resumed after a failed run (${resumeAt}); ${confirmed}`;
        doneThisRun[phase.name] = fingerprint;
      }
    } else if (resumed) {
      skipReason = `resumed after a failed run (${resumeAt})`;
    } else {
      skipReason = await seedPhaseSkipReason(
        phase,
        state,
        ttl,
        opts,
        ctx,
        phases,
        redactor,
      );
    }
    if (skipReason !== undefined) {
      ctx.log?.(
        redactor.text(`seed — phase ${phase.name} skipped (${skipReason})`),
      );
      emit("seed", "phase.skip", `phase ${phase.name} skipped`, {
        phase: phase.name,
        reason: skipReason,
      });
      continue;
    }
    ctx.log?.(redactor.text(`seed — phase ${phase.name} (${command})`));
    emit("seed", "phase.start", `phase ${phase.name}`, { phase: phase.name });
    const startedAt = Date.now();
    const r = await runSeedShell(
      command,
      {
        cwd: phase.cwd ? resolveCwd(phase.cwd, ctx.configDir) : opts.cwd,
        env: phase.env ? { ...opts.env, ...phase.env } : opts.env,
        timeoutMs: toMs(phase.timeout) ?? opts.timeout,
        label: `phase-${phase.name}`,
        kind: "phase",
        index,
      },
      ctx,
      phases,
      redactor,
    );
    const output = `${r.stdout}\n${r.stderr}`;
    const violation =
      r.exitCode === 0
        ? (expectOutputViolation(output, phase.expectOutput) ??
          expectOutputViolation(output, cfg.expectOutput))
        : undefined;
    const exitCode = violation ? 1 : r.exitCode;
    const record: PhaseRecord = {
      fingerprint: phaseFingerprint(phase),
      ranAt: new Date().toISOString(),
      exitCode,
      durationMs: Date.now() - startedAt,
    };
    if (exitCode === 0) doneThisRun[phase.name] = record.fingerprint;
    if (exitCode !== 0 || !hold) {
      state.phases[phase.name] = record;
      if (exitCode !== 0) {
        state.resume = { at: record.ranAt, done: { ...doneThisRun } };
      }
      await store.write(state);
    } else {
      held[phase.name] = record;
    }
    if (exitCode !== 0) {
      emit("seed", "phase.fail", `phase ${phase.name} failed`, {
        phase: phase.name,
        exitCode: r.exitCode,
        ...(violation ? { outputCheck: true } : {}),
      });
      throw new ServicesError(
        redactor.text(
          violation
            ? `seed phase ${phase.name} exited 0 but its ${violation}: ${command}\n`
            : `seed phase ${phase.name} failed (exit ${r.exitCode}): ${command}\n`,
        ) + redactor.text(tailText(output, SHELL_TAIL_LINES)),
      );
    }
    emit("seed", "phase.complete", `phase ${phase.name} complete`, {
      phase: phase.name,
      durationMs: record.durationMs,
    });
  }

  // Every phase is done: nothing is left to resume.
  if (state.resume) {
    delete state.resume;
    await store.write(state);
  }

  const summary = await runSeedPostCommands(
    cfg,
    opts,
    ctx,
    emit,
    phases,
    redactor,
  );
  if (!hold) return;
  if (summary.failed.length === 0) {
    Object.assign(state.phases, held);
    await store.write(state);
    emit("seed", "commit", "seed committed after its post-commands", {
      committed: true,
      phases: Object.keys(held),
    });
  } else {
    const labels = summary.failed.map((f) => f.label);
    ctx.log?.(
      redactor.text(
        `seed — phases not committed: postCommand(s) ${labels.join(", ")} failed; the next run repeats them`,
      ),
    );
    emit("seed", "commit", "seed not committed: a postCommand failed", {
      committed: false,
      failed: labels,
    });
  }
}

/**
 * Why a (non-`always`) phase need not run, or undefined when it must: a
 * recorded success of the same command still inside the TTL, then its
 * `skipIf` probe or gate.
 */
async function seedPhaseSkipReason(
  phase: SeedPhase,
  state: { phases: Record<string, PhaseRecord> },
  ttlSeconds: number,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ctx: StartServicesContext,
  phases: PhaseState,
  redactor: ArtifactRedactor,
): Promise<string | undefined> {
  const decision = phaseStateDecision(
    phase,
    state.phases[phase.name],
    ttlSeconds,
  );
  if (!decision.run) return decision.reason;
  return seedPhaseSkipIf(phase, opts, ctx, phases, redactor);
}

/** The phase's `skipIf` passes: the reason, else undefined (run it). */
async function seedPhaseSkipIf(
  phase: SeedPhase,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ctx: StartServicesContext,
  phases: PhaseState,
  redactor: ArtifactRedactor,
): Promise<string | undefined> {
  const skipIf = phase.skipIf;
  if (skipIf === undefined) return undefined;
  const cwd = phase.cwd ? resolveCwd(phase.cwd, ctx.configDir) : opts.cwd;
  const env = phase.env ? { ...opts.env, ...phase.env } : opts.env;
  if (typeof skipIf === "string" || "command" in skipIf) {
    const probe = typeof skipIf === "string" ? skipIf : skipIf.command;
    const r = await runShellWithTimeout(
      probe,
      { cwd, env, signal: ctx.signal, track: ctx.bootPids },
      opts.timeout,
    );
    storeServiceCommandArtifactRecord(phases, "seed", {
      kind: "freshness",
      index: 0,
      label: `phase-${phase.name}-skipIf`,
      command: probe,
      result: r,
      redactor,
    });
    return r.exitCode === 0 ? "skipIf passed" : undefined;
  }
  const problems = await gateProblems(skipIf.gate, ctx, {
    env,
    cwd,
    label: `seed phase ${phase.name}`,
  });
  return problems.length === 0 ? "skipIf gate passed" : undefined;
}

/** One seed shell command with live output and a stored artifact record. */
async function runSeedShell(
  command: string,
  input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    label: string;
    kind: StoredServiceCommandArtifactRecord["kind"];
    index: number;
  },
  ctx: StartServicesContext,
  phases: PhaseState,
  redactor: ArtifactRedactor,
): Promise<ShellResult> {
  const liveOutput = serviceOutput(ctx, "seed", redactor);
  liveOutput?.announce(command);
  const r = await runShellWithTimeout(
    command,
    {
      cwd: input.cwd,
      env: input.env,
      signal: ctx.signal,
      track: ctx.bootPids,
    },
    input.timeoutMs,
    liveOutput ? (_s, chunk) => liveOutput.push(chunk) : undefined,
  );
  liveOutput?.finish(r.exitCode);
  storeServiceCommandArtifactRecord(phases, "seed", {
    kind: input.kind,
    index: input.index,
    label: input.label,
    command,
    result: r,
    redactor,
  });
  return r;
}

interface PostCommandSummary {
  /** Post-commands that failed and were allowed to (`continueOnError`). */
  failed: Array<{ label: string; reason: string }>;
  skipped: string[];
}

/**
 * Always-run fixture ensure steps. Invoked after seed skip *or* successful
 * seed so lightweight mongosh/scripts re-apply data the bulk import omits.
 * An object entry may limit itself (`when`), carry its own timeout and output
 * check, and survive its own failure (`continueOnError`). A fatal failure
 * stops the rest and names every earlier tolerated failure too.
 */
async function runSeedPostCommands(
  cfg: SeedConfig,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ctx: StartServicesContext,
  emit: EmitFn,
  phases: PhaseState,
  redactor = createArtifactRedactor(undefined, opts.env, ctx.secretValues),
): Promise<PostCommandSummary> {
  const summary: PostCommandSummary = { failed: [], skipped: [] };
  const commands: readonly SeedPostCommand[] = cfg.postCommands ?? [];
  if (commands.length === 0) return summary;

  for (const [index, entry] of commands.entries()) {
    const command = postCommandRun(entry);
    const label = postCommandLabel(entry);
    const applies = postCommandApplies(entry, {
      suite: ctx.suite,
      env: ctx.envName,
    });
    if (!applies.applies) {
      summary.skipped.push(label);
      ctx.logDetail?.(
        redactor.text(
          `seed — postCommand ${label} skipped (${applies.reason})`,
        ),
      );
      emit("seed", "postcommand.skip", `postCommand ${label} skipped`, {
        postCommand: label,
        reason: applies.reason,
      });
      continue;
    }
    ctx.logDetail?.(redactor.text(`seed — postCommand (${command})`));
    emit("seed", "start", redactor.text(`postCommand: ${command}`));
    const object = typeof entry === "string" ? undefined : entry;
    const r = await runSeedShell(
      command,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs: toMs(object?.timeout) ?? opts.timeout,
        label: `post-command-${index}`,
        kind: "post-command",
        index,
      },
      ctx,
      phases,
      redactor,
    );
    const output = `${r.stdout}\n${r.stderr}`;
    const violation =
      r.exitCode === 0
        ? expectOutputViolation(output, object?.expectOutput)
        : undefined;
    if (r.exitCode === 0 && !violation) {
      emit("seed", "complete", redactor.text(`postCommand ok: ${command}`));
      continue;
    }
    // The output check quotes the matching line: redact it once, here, so
    // the tolerated-failure summary, logs and the aggregated error agree.
    const reason = redactor.text(violation ?? `exit ${r.exitCode}`);
    const detail = redactor.text(
      `seed postCommand ${
        typeof entry === "string" ? "" : `${label} `
      }failed (${reason}): ${command}\n${tailText(output, SHELL_TAIL_LINES)}`,
    );
    emit("seed", "fail", `postCommand ${label} failed`, {
      exitCode: r.exitCode,
      postCommand: label,
      ...(object?.continueOnError ? { continued: true } : {}),
    });
    if (object?.continueOnError) {
      summary.failed.push({ label, reason });
      ctx.log?.(`seed — postCommand ${label} failed (${reason}); continuing`);
      continue;
    }
    throw new ServicesError(
      [
        ...summary.failed.map(
          (f) =>
            `earlier postCommand ${f.label} failed too (${f.reason}; continueOnError)`,
        ),
        detail,
      ].join("\n"),
    );
  }
  if (summary.failed.length > 0) {
    ctx.log?.(
      `seed — ${summary.failed.length} postCommand(s) failed and were tolerated: ${summary.failed
        .map((f) => f.label)
        .join(", ")}`,
    );
  }
  return summary;
}

/**
 * Resolve the already-authorized child environment plus seed overrides. The
 * CLI resolves a selected TinyVault key set before lifecycle startup; seed
 * must never widen that scope by fetching an entire vault project itself.
 */
async function resolveSeedEnv(
  cfg: SeedConfig,
  ctx: StartServicesContext,
): Promise<NodeJS.ProcessEnv> {
  const env = targetEnv(ctx, cfg.env);

  return env;
}

function storeServiceCommandArtifactRecord(
  phases: PhaseState,
  source: StoredServiceCommandArtifactRecord["source"],
  input: {
    kind: StoredServiceCommandArtifactRecord["kind"];
    index: number;
    label: string;
    command: string;
    result: ShellResult;
    redactor?: ArtifactRedactor;
  },
): void {
  const policy = phases.localArtifactPolicy;
  if (
    policy.when === "never" ||
    !policy.capture.includes(source) ||
    phases.commandArtifactBytes >= policy.maxBytesPerRun
  ) {
    if (policy.when !== "never" && policy.capture.includes(source)) {
      phases.commandArtifactOmitted[source] =
        (phases.commandArtifactOmitted[source] ?? 0) + 1;
    }
    return;
  }

  const raw = [
    `$ ${input.command}`,
    `exitCode: ${input.result.exitCode}`,
    "--- stdout ---",
    input.result.stdout,
    "--- stderr ---",
    input.result.stderr,
  ].join("\n");
  const prepared = prepareArtifactText(
    input.redactor ?? phases.artifactRedactor,
    raw,
  );
  const remaining = policy.maxBytesPerRun - phases.commandArtifactBytes;
  const bounded = boundArtifactText(
    prepared,
    policy.maxLinesPerSource,
    Math.min(policy.maxBytesPerSource, remaining),
  );
  phases.commandArtifactRecords.push({
    source,
    kind: input.kind,
    index: input.index,
    label: input.label,
    content: bounded.content,
    bytes: bounded.bytes,
    truncated: bounded.truncated,
    exitCode: input.result.exitCode,
  });
  phases.commandArtifactBytes += bounded.bytes;
}

/* ----- Phase 3: tmux ----- */

async function startTmux(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  coldStart: boolean,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  // Reuse by default: a tmux session holds long-running dev servers that are
  // expensive to rebuild; reusing them across runs avoids recompiles. Decoupled
  // from --cold-start (browser profile only).
  void coldStart;
  // A provisioned environment is this run's own: its windows talk to a
  // resource that `down` destroys, so a surviving session would only hold
  // dead connections.
  const reuse = (cfg.reuseExisting ?? true) && !phases.provisioned;
  let recreated = false;
  phases.tmuxReuse = reuse;
  phases.tmuxSessionName = cfg.session;

  // Reuse path: heal dead/missing windows rather than blindly trusting a
  // leftover session (empty shells after lost send-keys, or services that
  // crashed while scrollback still contains the ready text).
  //
  // Exception: if docker containers were actually down and got brought up
  // this run, leftover pane processes still hold dead connections to the old
  // mongo/redis/postgres. Kill and recreate so app services reconnect.
  // (cold-start re-running `compose up` against already-running containers
  // does NOT count — that is not a refresh.)
  if (reuse) {
    const exists = await tmuxSessionExists(cfg.session);
    if (exists && phases.dockerRefreshed) {
      recreated = true;
      ctx.log?.(
        `tmux — docker was refreshed this run; recreating session "${cfg.session}" so app processes reconnect`,
      );
      emit(
        "tmux",
        "recreate",
        `recreating session after docker refresh: "${cfg.session}"`,
      );
      await execa(
        "tmux",
        ["kill-session", "-t", tmuxSessionTarget(cfg.session)],
        {
          reject: false,
          timeout: 5_000,
        },
      );
      // fall through to create path
    } else if (exists) {
      phases.tmuxDisposition = "reused";
      ctx.log?.(`tmux — reusing session "${cfg.session}"`);
      emit("tmux", "reuse", `reusing session "${cfg.session}"`);
      const sequentialDeadline = cfg.waitForReadyBeforeNext
        ? tmuxReadinessDeadline(cfg)
        : undefined;
      await ensureTmuxWindows(cfg, ctx, emit, sequentialDeadline);
      if (sequentialDeadline !== undefined) {
        await finishTmuxReadiness(cfg, ctx, emit);
      } else {
        await waitForAllTmuxWindows(cfg, ctx, emit);
      }
      return;
    }
  }

  // Always kill any leftover session before create so new-session cannot
  // silently fail (reject:false) and boot into a half-dead session.
  await execa("tmux", ["kill-session", "-t", tmuxSessionTarget(cfg.session)], {
    reject: false,
    timeout: 5_000,
  });

  // Create the session with the first window, then add the rest.
  ctx.logDetail?.(
    `tmux — creating session "${cfg.session}" with ${cfg.windows.length} windows`,
  );
  emit(
    "tmux",
    "start",
    `creating session "${cfg.session}" with ${cfg.windows.length} windows`,
  );
  const firstWin = cfg.windows[0]!;
  const newSessionArgs = [
    "new-session",
    "-d",
    // A wide, tall detached session: at tmux's 80x24 default long log lines
    // and URLs wrap, and `readyOn.text` / `services logs` would see them cut.
    "-x",
    String(cfg.columns ?? DEFAULT_TMUX_COLUMNS),
    "-y",
    String(cfg.rows ?? DEFAULT_TMUX_ROWS),
    "-s",
    cfg.session,
    "-n",
    firstWin.name,
    ...(firstWin.cwd ? ["-c", resolveCwd(firstWin.cwd, ctx.configDir)] : []),
    ...(cfg.defaultShell ? [cfg.defaultShell] : []),
  ];
  await execa("tmux", newSessionArgs, {
    reject: false,
    timeout: 5_000,
    // A tmux server inherits this environment exactly once. Use the same
    // narrow target scope as docker/seed so publisher credentials never leak
    // into long-lived service panes (extendEnv: false, or execa would merge
    // the parent's process.env back in).
    env: targetEnv(ctx, cfg.env),
    extendEnv: false,
  });

  // Apply session-level options.
  if (cfg.options) {
    for (const opt of cfg.options) {
      await setTmuxOption(cfg.session, opt);
    }
  }

  // What the provisioner exported must reach the windows too (a tmux server
  // that already runs does not take the new-session client env). A
  // credential-named export is left out: set-environment would put it on a
  // command line; it still reaches a session created with a new server.
  for (const [key, value] of Object.entries(phases.exportedEnv)) {
    if (isSensitiveEnvKey(key)) continue;
    await execa(
      "tmux",
      ["set-environment", "-t", tmuxSessionTarget(cfg.session), key, value],
      {
        reject: false,
        timeout: 3_000,
      },
    );
  }
  // Set session-level env vars via tmux set-environment (propagates to all windows).
  if (cfg.env) {
    for (const [key, value] of Object.entries(cfg.env)) {
      await execa(
        "tmux",
        ["set-environment", "-t", tmuxSessionTarget(cfg.session), key, value],
        {
          reject: false,
          timeout: 3_000,
        },
      );
    }
  }

  const sequentialDeadline = cfg.waitForReadyBeforeNext
    ? tmuxReadinessDeadline(cfg)
    : undefined;
  // A sequential readiness failure can happen before the remaining windows
  // are created. Record ownership now so failure cleanup can still terminate
  // a non-reused session instead of orphaning the first service.
  if (sequentialDeadline !== undefined) {
    phases.tmuxSession = cfg.session;
    phases.tmuxDisposition = recreated ? "recreated" : "created";
  }

  // Boot first window (wait for shell → clear history → send commands).
  await bootTmuxWindowAfterGates(cfg, firstWin, ctx, emit);
  if (sequentialDeadline !== undefined) {
    await waitForTmuxWindowReady(cfg, firstWin, sequentialDeadline, ctx, emit);
  }

  // Create remaining windows. Append to the session by name (no index target)
  // so window creation is robust to `base-index 1` / `renumber-windows on` in
  // a user's ~/.tmux.conf — index-based insertion (`-t session:i`) collides
  // with existing windows under those settings and mis-assigns cwds/commands.
  for (let i = 1; i < cfg.windows.length; i++) {
    const win = cfg.windows[i]!;
    // Idempotent: skip windows that already exist (e.g. a leftover session
    // that wasn't killed) so re-runs never pile up duplicate panes — but still
    // boot them if the pane is idle (command was never launched).
    if (await tmuxWindowExists(cfg.session, win.name)) {
      const live = await isTmuxWindowLive(cfg, win, ctx);
      if (live) {
        if (sequentialDeadline !== undefined) {
          await waitForTmuxWindowReady(cfg, win, sequentialDeadline, ctx, emit);
        }
        continue;
      }
      ctx.logDetail?.(
        `tmux — "${win.name}" exists but is not live; re-launching`,
      );
      emit("tmux", "relaunch", `re-launching "${win.name}"`, {
        window: win.name,
      });
      await bootTmuxWindowAfterGates(cfg, win, ctx, emit);
      if (sequentialDeadline !== undefined) {
        await waitForTmuxWindowReady(cfg, win, sequentialDeadline, ctx, emit);
      }
      continue;
    }
    await execa(
      "tmux",
      [
        "new-window",
        "-t",
        tmuxSessionScopeTarget(cfg.session),
        "-n",
        win.name,
        ...(win.cwd ? ["-c", resolveCwd(win.cwd, ctx.configDir)] : []),
      ],
      {
        reject: false,
        timeout: 5_000,
      },
    );
    await bootTmuxWindowAfterGates(cfg, win, ctx, emit);
    if (sequentialDeadline !== undefined) {
      await waitForTmuxWindowReady(cfg, win, sequentialDeadline, ctx, emit);
    }
  }

  if (sequentialDeadline === undefined) {
    phases.tmuxSession = cfg.session;
    phases.tmuxDisposition = recreated ? "recreated" : "created";
  }
  emit("tmux", "session-created", `session "${cfg.session}" created`);

  if (sequentialDeadline !== undefined) {
    await finishTmuxReadiness(cfg, ctx, emit);
  } else {
    await waitForAllTmuxWindows(cfg, ctx, emit);
  }
}

/**
 * On session reuse: create any missing windows and re-launch panes that look
 * dead (idle interactive shell and/or readyOn not currently satisfied).
 */
async function ensureTmuxWindows(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  emit: EmitFn,
  sequentialDeadline?: number,
): Promise<void> {
  for (const win of cfg.windows) {
    if (!(await tmuxWindowExists(cfg.session, win.name))) {
      ctx.log?.(
        `tmux — window "${win.name}" missing in reused session; creating`,
      );
      emit("tmux", "create-window", `creating missing "${win.name}"`, {
        window: win.name,
      });
      await execa(
        "tmux",
        [
          "new-window",
          "-t",
          tmuxSessionScopeTarget(cfg.session),
          "-n",
          win.name,
          ...(win.cwd ? ["-c", resolveCwd(win.cwd, ctx.configDir)] : []),
        ],
        { reject: false, timeout: 5_000 },
      );
      await bootTmuxWindowAfterGates(cfg, win, ctx, emit);
    } else {
      const live = await isTmuxWindowLive(cfg, win, ctx);
      if (live) {
        ctx.log?.(`tmux — "${win.name}" already live; leaving process alone`);
        emit("tmux", "skip", `"${win.name}" already live`, {
          window: win.name,
        });
      } else {
        ctx.log?.(
          `tmux — "${win.name}" not live in reused session; re-launching`,
        );
        emit("tmux", "relaunch", `re-launching "${win.name}"`, {
          window: win.name,
        });
        await bootTmuxWindowAfterGates(cfg, win, ctx, emit);
      }
    }

    if (sequentialDeadline !== undefined) {
      await waitForTmuxWindowReady(cfg, win, sequentialDeadline, ctx, emit);
    }
  }
}

/**
 * Wait for every window's readyOn (and optional healthcheck). Shared by the
 * create path and the reuse/heal path.
 */
async function waitForAllTmuxWindows(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  emit: EmitFn,
): Promise<void> {
  const deadline = tmuxReadinessDeadline(cfg);
  for (const win of cfg.windows) {
    await waitForTmuxWindowReady(cfg, win, deadline, ctx, emit);
  }
  await finishTmuxReadiness(cfg, ctx, emit);
}

/** One deadline is shared across the complete tmux readiness phase. */
function tmuxReadinessDeadline(cfg: TmuxConfig): number {
  const readyTimeoutMs = cfg.readyTimeoutMs ?? DEFAULT_TMUX_READY_MS;
  // 0 = wait indefinitely (no deadline).
  return readyTimeoutMs > 0
    ? Date.now() + readyTimeoutMs
    : Number.POSITIVE_INFINITY;
}

/**
 * Wait for one window using the same pane logging, terminal detection, and
 * deadline policy as the traditional all-windows readiness pass.
 */
async function waitForTmuxWindowReady(
  cfg: TmuxConfig,
  win: TmuxWindow,
  deadline: number,
  ctx: StartServicesContext,
  emit: EmitFn,
): Promise<void> {
  if (!win.readyOn) return;
  const session = cfg.session;
  // Pane output is a log of record, not terminal content: full deltas stream
  // to a per-window file while the terminal gets a ~15s heartbeat. Written
  // incrementally so a killed run still leaves the evidence.
  const paneLog = join(
    ctx.serviceLogRoot ?? join(homedir(), ".cairntrace", "services"),
    `${ctx.project}-${win.name}.pane.log`,
  );
  mkdirSync(dirname(paneLog), { recursive: true });
  const paneStream = createWriteStream(paneLog, { flags: "w" });
  ctx.logDetail?.(
    `tmux — waiting for "${win.name}" to be ready (pane log: ${paneLog})`,
  );
  emit("tmux", "ready-wait", `waiting for "${win.name}"`, {
    window: win.name,
  });
  // F2: readyOn.gate is watched inside the pane poll (its stable/every
  // apply; the window deadline replaces its timeout).
  const gate = await tmuxReadyOnGate(cfg, win, ctx);
  const warn = readinessWarn(ctx);
  try {
    await waitForTmuxWindow(session, win, deadline, {
      ...(gate ? { gate } : {}),
      onUrlStatus: (url, status) => warnLegacyReadiness(url, status, warn),
      signal: ctx.signal,
      onDelta: (delta) =>
        paneStream.write(delta.endsWith("\n") ? delta : `${delta}\n`),
      ...(ctx.log
        ? {
            onHeartbeat: (elapsedMs: number, newLines: number) =>
              ctx.log?.(
                `tmux — "${win.name}" still starting after ${Math.round(
                  elapsedMs / 1000,
                )}s (${
                  newLines > 0
                    ? `+${newLines} pane lines captured`
                    : "pane idle"
                })`,
              ),
          }
        : {}),
    });
  } catch (error) {
    gate?.watch.finish(
      false,
      error instanceof ServicesCancelledError
        ? { cancelled: true }
        : { timedOut: Date.now() >= deadline },
    );
    const reason =
      error instanceof TmuxTerminalReadinessError
        ? error.reason
        : "readiness-failed";
    emit("tmux", "fail", `"${win.name}" readiness failed`, {
      window: win.name,
      reason,
      ...(error instanceof TmuxTerminalReadinessError ? error.details : {}),
    });
    throw error;
  } finally {
    // Flush before proceeding: a reader (or the process exiting on error)
    // must find every captured delta on disk.
    await new Promise<void>((resolveEnd) => {
      paneStream.end(() => resolveEnd());
    });
  }
  emit("tmux", "ready", `"${win.name}" ready`, { window: win.name });
}

/** Run post-readiness healthchecks and announce the complete session. */
async function finishTmuxReadiness(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  emit: EmitFn,
): Promise<void> {
  for (const win of cfg.windows) {
    if (!win.healthcheck) continue;
    emit("tmux", "healthcheck", `checking ${win.name}`, { window: win.name });
    const winEnv = targetEnv(ctx, { ...cfg.env, ...win.env });
    const hcResult = await runHealthcheck(
      win.healthcheck,
      { cwd: resolveCwd(win.cwd, ctx.configDir), env: winEnv },
      ctx,
      `tmux/${win.name}`,
    );
    if (!hcResult.healthy) {
      ctx.log?.(
        `tmux/${win.name} — healthcheck WARNING: unhealthy after ${hcResult.consecutiveFailures} failures`,
      );
      emit("tmux", "healthcheck", `unhealthy: ${win.name}`, {
        window: win.name,
        healthy: false,
        consecutiveFailures: hcResult.consecutiveFailures,
      });
    } else {
      emit("tmux", "healthcheck", `healthy: ${win.name}`, { window: win.name });
    }
  }

  ctx.log?.(`tmux — session "${cfg.session}" ready`);
  emit("tmux", "ready", `session "${cfg.session}" ready`);
}

/**
 * True when a window's service should be left alone on session reuse.
 *
 * Core signal: is the pane sitting at an idle interactive shell? If a
 * non-shell process is running (`go`, `node`, `yarn`, …) we treat it as live
 * even before readyOn matches — re-sending `go run .` mid-compile would
 * corrupt the pane. Idle shell + leftover scrollback ("listening on" from a
 * crash) is the failure mode we re-launch for.
 *
 * URL readyOn: if the URL already probes OK, treat as live even when the pane
 * command is unknown (service may run outside this pane).
 */
async function isTmuxWindowLive(
  cfg: TmuxConfig,
  win: TmuxWindow,
  ctx?: StartServicesContext,
): Promise<boolean> {
  // "Something serves there" (any answer), not readiness: a relaunch onto a
  // port that answers 503 would only fail with EADDRINUSE.
  if (win.readyOn?.url && (await probeOnce(win.readyOn.url))) {
    return true;
  }
  if (ctx && win.readyOn?.gate !== undefined) {
    // The window's env, like its readiness wait: session env + window env.
    const problems = await gateProblems(win.readyOn.gate, ctx, {
      env: targetEnv(ctx, { ...cfg.env, ...win.env }),
      cwd: resolveCwd(win.cwd, ctx.configDir),
      label: `tmux window "${win.name}"`,
    });
    if (problems.length === 0) return true;
  }
  // Non-shell process in the pane → starting or running; do not re-send.
  if (!(await isTmuxPaneIdleShell(cfg.session, win.name))) {
    return true;
  }
  // Idle shell: service is not running here. Re-launch on the reuse path.
  return false;
}

/**
 * Wait for the pane's interactive shell to settle, clear residual scrollback
 * (so readyOn text can't match stale history), then send preCommands + command.
 */
async function bootTmuxWindow(
  session: string,
  win: TmuxWindow,
  ctx: StartServicesContext,
): Promise<void> {
  ctx.launchedWindows?.add(win.name);
  await waitForTmuxShellReady(session, win.name, ctx);
  await clearTmuxHistory(session, win.name);
  await sendWindowCommands(session, win, ctx);
}

/**
 * Send a command to a tmux window's pane via `tmux send-keys`. Env vars for
 * the window are set separately by `sendWindowCommands` via `tmux
 * set-environment` before this is called.
 */
async function sendTmuxCommand(
  session: string,
  window: string,
  command: string,
): Promise<void> {
  await execa(
    "tmux",
    ["send-keys", "-t", tmuxWindowTarget(session, window), command, "Enter"],
    {
      reject: false,
      timeout: 5_000,
    },
  );
}

/**
 * Set per-window env vars (if any) via `tmux set-environment`, then send
 * pre-commands (if any) followed by the main command to a tmux window.
 *
 * Waits for an idle shell before each send-keys so direnv/zsh startup cannot
 * swallow the command, and waits for the shell to return after each
 * pre-command (build/migrate) before sending the next.
 */
async function sendWindowCommands(
  session: string,
  win: TmuxWindow,
  ctx: StartServicesContext,
): Promise<void> {
  // Set per-window env vars once, before any commands are sent. These
  // propagate to the window's shell via tmux set-environment. This is safer
  // than inline `export` with JSON.stringify, which can break on values
  // containing $, backticks, !, or quotes.
  if (win.env && Object.keys(win.env).length > 0) {
    for (const [key, value] of Object.entries(win.env)) {
      await execa(
        "tmux",
        ["set-environment", "-t", tmuxSessionTarget(session), key, value],
        {
          reject: false,
          timeout: 3_000,
        },
      );
    }
  }

  // Send pre-commands first (no env needed — already set above).
  for (const preEntry of win.preCommands ?? []) {
    const pre = typeof preEntry === "string" ? { run: preEntry } : preEntry;
    // Freshness probe (mirrors the seed freshnessCheck pattern): run the
    // skipIf shell HOST-SIDE with the window's cwd; exit 0 = the expensive
    // pre-command (yarn build, tsc, migrate) is already satisfied — skip it.
    // Probe errors are treated as "not fresh" so a broken probe can never
    // silently skip a required build.
    if (pre.skipIf) {
      try {
        const probe = await runShell(pre.skipIf, {
          cwd: resolveCwd(win.cwd, ctx.configDir),
          env: targetEnv(ctx, win.env),
        });
        if (probe.exitCode === 0) {
          ctx.log?.(
            `tmux — ${win.name}: pre-command skipped, skipIf passed (${pre.run})`,
          );
          continue;
        }
        ctx.logDetail?.(
          `tmux — ${win.name}: skipIf exited ${probe.exitCode} — running pre-command`,
        );
      } catch (e) {
        ctx.log?.(
          `tmux — ${win.name}: skipIf probe failed (${(e as Error).message}) — running pre-command`,
        );
      }
    }
    // Ensure the shell is accepting input (direnv may have just reloaded).
    await waitForTmuxShellReady(session, win.name, ctx, TMUX_SHELL_READY_MS);
    ctx.log?.(`tmux — ${win.name}: pre-command (${pre.run})`);
    await sendTmuxCommand(session, win.name, pre.run);
    // Wait until the pre-command exits and the shell is idle again before
    // sending the next one / main command. Long deadline: cold `yarn build` /
    // tsc regularly takes minutes.
    await waitForTmuxShellReady(
      session,
      win.name,
      ctx,
      TMUX_PRE_COMMAND_RETURN_MS,
    );
  }
  // Main long-lived command: wait for shell, send, verify it was accepted
  // (pane left idle shell). direnv/zsh double-load can swallow the first
  // send-keys — retry a few times rather than hang forever on readyOn.
  await sendMainCommandWithRetry(session, win, ctx);
}

/**
 * Send the window's main command and confirm the pane left the idle shell
 * (or the readyOn URL already answers). Retries when direnv/zsh ate the keys.
 */
async function sendMainCommandWithRetry(
  session: string,
  win: TmuxWindow,
  ctx: StartServicesContext,
): Promise<void> {
  for (let attempt = 1; attempt <= TMUX_COMMAND_SEND_ATTEMPTS; attempt++) {
    await waitForTmuxShellReady(session, win.name, ctx, TMUX_SHELL_READY_MS);
    if (attempt > 1) {
      ctx.logDetail?.(
        `tmux — ${win.name}: re-sending command (attempt ${attempt}/${TMUX_COMMAND_SEND_ATTEMPTS})`,
      );
    }
    await sendTmuxCommand(session, win.name, win.command);

    const acceptedBy = Date.now() + TMUX_COMMAND_ACCEPT_MS;
    while (Date.now() < acceptedBy) {
      // Only trust a non-shell pane command as "accepted". URL readyOn can
      // lag (vite still compiling) and must not short-circuit send retries
      // or the ready-wait stall stream.
      if (!(await isTmuxPaneIdleShell(session, win.name))) return;
      await sleepUnlessCancelled(POLL_MS, ctx.signal);
    }
  }
  ctx.log?.(
    `tmux — ${win.name}: command may not have started (pane still idle after ${TMUX_COMMAND_SEND_ATTEMPTS} sends); continuing to ready wait`,
  );
}

/**
 * Poll until `#{pane_current_command}` looks like a stable interactive shell
 * (or until the deadline). Best-effort: on timeout we still proceed so a
 * misreported pane command can't brick startup.
 *
 * Empty pane_current_command is NOT treated as ready — that was the web-app
 * failure mode: send-keys fired during direnv init and were swallowed, then
 * the pane sat at an empty zsh prompt forever.
 */
async function waitForTmuxShellReady(
  session: string,
  window: string,
  ctx: StartServicesContext,
  timeoutMs: number = TMUX_SHELL_READY_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let last = "";
  while (Date.now() < deadline) {
    const { command: cmd, idle } = await tmuxPaneShell(session, window);
    if (cmd && idle) {
      if (cmd === last) stable += 1;
      else {
        stable = 1;
        last = cmd;
      }
      if (stable >= TMUX_SHELL_STABLE_POLLS) return;
    } else {
      // Empty (shell still booting) or a non-shell child still running.
      stable = 0;
      last = cmd;
    }
    await sleepUnlessCancelled(POLL_MS, ctx.signal);
  }
  ctx.log?.(
    `tmux — "${window}" shell not confirmed idle within ${timeoutMs}ms; sending keys anyway`,
  );
}

/** The first line of a `list-panes` answer (a split window lists more). */
function firstPaneLine(stdout: unknown): string {
  return String(stdout ?? "").split(/\r?\n/)[0] ?? "";
}

function parsePanePid(field: string | undefined): number | undefined {
  const pid = Number.parseInt(field ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * True when the pane's shell (`#{pane_pid}`, a session leader) is not the
 * terminal's foreground process group: a job runs in the foreground even
 * though `#{pane_current_command}` reads as a shell name (`bash start.sh`,
 * `sh -c …`). Unknown (no pid, `ps` failed, no terminal) is false, and the
 * name alone decides.
 */
async function shellRunsForegroundJob(
  panePid: number | undefined,
): Promise<boolean> {
  if (panePid === undefined) return false;
  try {
    const r = await execa("ps", ["-o", "tpgid=", "-p", String(panePid)], {
      reject: false,
      timeout: 3_000,
    });
    if (r.exitCode !== 0) return false;
    const tpgid = Number.parseInt(String(r.stdout ?? "").trim(), 10);
    return Number.isInteger(tpgid) && tpgid > 0 && tpgid !== panePid;
  } catch {
    return false;
  }
}

/** True when the pane sits at its interactive shell with nothing running. */
async function paneShellIdle(
  command: string,
  panePid: number | undefined,
): Promise<boolean> {
  if (!TMUX_IDLE_SHELL_RE.test(command)) return false;
  return !(await shellRunsForegroundJob(panePid));
}

/**
 * The pane's current command, and whether it is an idle shell (a shell name
 * with no foreground job). `list-panes` with an exact target fails on a
 * missing window (empty command); `display-message` would answer for
 * another pane.
 */
async function tmuxPaneShell(
  session: string,
  window: string,
): Promise<{ command: string; idle: boolean }> {
  try {
    const r = await execa(
      "tmux",
      [
        "list-panes",
        "-t",
        tmuxWindowTarget(session, window),
        "-F",
        "#{pane_current_command}\t#{pane_pid}",
      ],
      { reject: false, timeout: 3_000 },
    );
    if (r.exitCode !== 0) return { command: "", idle: false };
    const [field = "", pid] = firstPaneLine(r.stdout).split("\t");
    const command = field.trim();
    if (!command) return { command, idle: false };
    return {
      command,
      idle: await paneShellIdle(command, parsePanePid(pid)),
    };
  } catch {
    return { command: "", idle: false };
  }
}

async function isTmuxPaneIdleShell(
  session: string,
  window: string,
): Promise<boolean> {
  const { command, idle } = await tmuxPaneShell(session, window);
  // Unknown / empty → treat as idle (not yet running a service). That way
  // send-retry keeps trying and reuse heal re-launches instead of trusting
  // a pane that never started.
  if (!command) return true;
  return idle;
}

async function clearTmuxHistory(
  session: string,
  window: string,
): Promise<void> {
  await execa(
    "tmux",
    ["clear-history", "-t", tmuxWindowTarget(session, window)],
    {
      reject: false,
      timeout: 3_000,
    },
  );
}

async function setTmuxOption(
  session: string,
  opt: TmuxSessionOption,
): Promise<void> {
  await execa(
    "tmux",
    ["set-option", "-t", tmuxSessionScopeTarget(session), opt.key, opt.value],
    {
      reject: false,
      timeout: 3_000,
    },
  );
}

export async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    const r = await execa(
      "tmux",
      ["has-session", "-t", tmuxSessionTarget(session)],
      {
        reject: false,
        timeout: 3_000,
      },
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** True if a window named `windowName` exists in the session. */
async function tmuxWindowExists(
  session: string,
  windowName: string,
): Promise<boolean> {
  try {
    const r = await execa(
      "tmux",
      [
        "list-windows",
        "-t",
        tmuxSessionTarget(session),
        "-F",
        "#{window_name}",
      ],
      { reject: false, timeout: 3_000 },
    );
    if (r.exitCode !== 0) return false;
    return r.stdout.split("\n").some((name) => name === windowName);
  } catch {
    return false;
  }
}

async function waitForTmuxWindow(
  session: string,
  win: TmuxWindow,
  deadline: number,
  hooks?: {
    /** Stops the wait at its next poll (ServicesCancelledError). */
    signal?: AbortSignal | undefined;
    /** Full pane delta — the log of record, never the terminal. */
    onDelta?: (delta: string) => void;
    /** Bounded proof-of-life line for the terminal, every ~15s. */
    onHeartbeat?: (elapsedMs: number, newLines: number) => void;
    /** `readyOn.gate`: required in addition to url/text (see F2). */
    gate?: { watch: GateWatch; everyMs: number };
    /** The readyOn url answered with a non-ready status. */
    onUrlStatus?: (url: string, status: number) => void;
    /**
     * A restart's generation id: `readyOn.text` is looked for only below the
     * generation marker, so scrollback of the previous process never counts.
     */
    generation?: string;
  },
): Promise<void> {
  if (!win.readyOn) return;
  const startedAt = Date.now();
  let lastUrlProbe: ReadyProbe | undefined;
  let lastGateAt = Number.NEGATIVE_INFINITY;
  let lastStall = 0;
  let lastBeat = Date.now();
  let linesSinceBeat = 0;
  let lastCapture = "";
  // Rolling tail for the timeout error: a tmux window that never became
  // ready used to throw with ZERO captured output — the one moment the pane
  // content matters most (docker/seed failures already tail theirs).
  const recent: string[] = [];
  const capturePaneDelta = async (): Promise<void> => {
    const tail = await captureTmuxPane(session, win.name, 500);
    if (!tail || tail === lastCapture) return;
    const delta =
      lastCapture && tail.startsWith(lastCapture)
        ? tail.slice(lastCapture.length)
        : lastCapture
          ? tailText(tail, 15)
          : tailText(tail, 20);
    if (delta.trim()) {
      hooks?.onDelta?.(delta);
      const deltaLines = delta.split("\n").filter((line) => line.trim());
      linesSinceBeat += deltaLines.length;
      recent.push(...deltaLines);
      if (recent.length > 80) recent.splice(0, recent.length - 80);
    }
    lastCapture = tail;
  };
  for (;;) {
    // url and text are alternatives (either one); without both, only the
    // gate decides. A configured gate must pass in addition.
    let signalled = !win.readyOn.url && !win.readyOn.text;
    // Check URL readiness: a 2xx/3xx answer unless anyResponse (F2).
    if (win.readyOn.url) {
      lastUrlProbe = await probeReady(win.readyOn.url, {
        anyResponse: win.readyOn.anyResponse === true,
      });
      if (lastUrlProbe.ready) signalled = true;
      else if (lastUrlProbe.status !== undefined) {
        hooks?.onUrlStatus?.(win.readyOn.url, lastUrlProbe.status);
      }
    }
    // Check text readiness via tmux capture-pane.
    if (!signalled && win.readyOn.text) {
      // Large scrollback: a chatty service may print the readiness line early
      // then flood errors/warnings that push it past a small capture window.
      const pane = await captureTmuxPane(
        session,
        win.name,
        hooks?.generation ? 10_000 : 2000,
      );
      // After a restart only the new generation's output counts.
      const visible = hooks?.generation
        ? sliceAfterGeneration(pane, hooks.generation)
        : { text: pane, found: true };
      // Case-insensitive: server logs vary in casing ("Listening" vs "listening").
      if (
        visible.found &&
        visible.text.toLowerCase().includes(win.readyOn.text.toLowerCase())
      ) {
        signalled = true;
      }
    }
    if (signalled && !hooks?.gate) return;
    if (
      signalled &&
      hooks?.gate &&
      Date.now() - lastGateAt >= hooks.gate.everyMs
    ) {
      lastGateAt = Date.now();
      const look = await hooks.gate.watch.attempt(deadline - Date.now());
      if (look.ok) {
        hooks.gate.watch.finish(true);
        return;
      }
    }
    // Capture the pane's NEW lines since the last look. The delta goes to the
    // log of record (hooks.onDelta → a file); the terminal only gets a short
    // heartbeat. Streaming raw pane content to the terminal buried entire
    // runs under Go stack traces and 30-line request dumps.
    if (Date.now() - lastStall >= TMUX_STALL_INTERVAL_MS) {
      lastStall = Date.now();
      await capturePaneDelta();
    }
    // A zero timeout intentionally removes the clock deadline, but it must
    // not turn a terminated service into an infinite wait. The tmux pane is
    // an interactive shell, so a service that exits normally leaves the pane
    // alive at zsh/bash; inspect both pane_dead and pane_current_command.
    // This is observation only: readiness never restarts a failed command.
    const paneState = await inspectTmuxPaneForReadiness(session, win.name);
    if (
      paneState.kind === "dead" ||
      paneState.kind === "idle-shell" ||
      paneState.kind === "missing"
    ) {
      // A process can print its decisive Fatal line and exit between the
      // periodic capture above and this pane-state probe. Take one final,
      // deduplicated snapshot before constructing the error so both the pane
      // log and its bounded recent tail include that last output.
      await capturePaneDelta();
      throw terminalTmuxReadinessError(win, paneState, recent);
    }
    if (Date.now() >= deadline) {
      throw new ServicesError(
        `tmux window "${win.name}" did not become ready within deadline` +
          (win.readyOn.url
            ? ` (url: ${win.readyOn.url}${
                lastUrlProbe ? ` — last: ${lastUrlProbe.detail}` : ""
              })` +
              readinessHint(
                lastUrlProbe?.status,
                win.readyOn.anyResponse === true,
              )
            : "") +
          (win.readyOn.text ? ` (text: "${win.readyOn.text}")` : "") +
          (hooks?.gate
            ? ` (gate ${hooks.gate.watch.name}: ${hooks.gate.watch.lastDetail})`
            : "") +
          (recent.length > 0
            ? `\n--- last pane output ("${win.name}") ---\n${recent
                .slice(-40)
                .join("\n")}`
            : ""),
      );
    }
    if (hooks?.onHeartbeat && Date.now() - lastBeat >= 15_000) {
      hooks.onHeartbeat(Date.now() - startedAt, linesSinceBeat);
      lastBeat = Date.now();
      linesSinceBeat = 0;
    }
    await sleepUnlessCancelled(POLL_MS, hooks?.signal);
  }
}

type TmuxPaneReadinessState =
  | { kind: "running" }
  | { kind: "unknown" }
  | { kind: "missing" }
  | { kind: "idle-shell"; currentCommand: string }
  | { kind: "dead"; exitCode?: number };

class TmuxTerminalReadinessError extends ServicesError {
  constructor(
    message: string,
    readonly reason: "pane-dead" | "pane-missing" | "service-command-exited",
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Inspect a pane without mutating it. The tab-delimited prefix makes this
 * query distinguishable from the older pane_current_command-only probe and
 * lets us preserve compatibility if an older/mocked tmux returns a shape we
 * cannot prove.
 */
async function inspectTmuxPaneForReadiness(
  session: string,
  window: string,
): Promise<TmuxPaneReadinessState> {
  try {
    const r = await execa(
      "tmux",
      [
        "list-panes",
        "-t",
        tmuxWindowTarget(session, window),
        "-F",
        TMUX_PANE_STATE_FORMAT,
      ],
      { reject: false, timeout: 3_000 },
    );
    if (r.exitCode !== 0) return { kind: "missing" };

    const fields = firstPaneLine(r.stdout).split("\t");
    if (fields.length < 3 || !/^[01]$/.test(fields[0] ?? "")) {
      return { kind: "unknown" };
    }

    const currentCommand = (fields[2] ?? "").trim();
    if (fields[0] === "1") {
      const parsedStatus = Number.parseInt(fields[1] ?? "", 10);
      return {
        kind: "dead",
        ...(Number.isFinite(parsedStatus) ? { exitCode: parsedStatus } : {}),
      };
    }
    if (
      currentCommand &&
      (await paneShellIdle(currentCommand, parsePanePid(fields[3])))
    ) {
      return { kind: "idle-shell", currentCommand };
    }
    return currentCommand ? { kind: "running" } : { kind: "unknown" };
  } catch {
    // An inspection timeout is not proof that the service exited. The normal
    // readiness deadline (when configured) remains the fail-closed fallback.
    return { kind: "unknown" };
  }
}

function terminalTmuxReadinessError(
  win: TmuxWindow,
  state: Extract<
    TmuxPaneReadinessState,
    { kind: "dead" | "idle-shell" | "missing" }
  >,
  recent: string[],
): TmuxTerminalReadinessError {
  const readyOn =
    (win.readyOn?.url ? ` (url: ${win.readyOn.url})` : "") +
    (win.readyOn?.text ? ` (text: "${win.readyOn.text}")` : "");
  const tail =
    recent.length > 0
      ? `\n--- last pane output ("${win.name}") ---\n${recent
          .slice(-40)
          .join("\n")}`
      : "";

  if (state.kind === "idle-shell") {
    return new TmuxTerminalReadinessError(
      `tmux window "${win.name}" service command exited before readiness; ` +
        `pane returned to idle shell "${state.currentCommand}"${readyOn}${tail}`,
      "service-command-exited",
      { currentCommand: state.currentCommand },
    );
  }
  if (state.kind === "dead") {
    const status =
      state.exitCode === undefined ? "" : ` (exit ${state.exitCode})`;
    return new TmuxTerminalReadinessError(
      `tmux window "${win.name}" pane exited${status} before readiness${readyOn}${tail}`,
      "pane-dead",
      state.exitCode === undefined ? {} : { exitCode: state.exitCode },
    );
  }
  return new TmuxTerminalReadinessError(
    `tmux window "${win.name}" disappeared before readiness${readyOn}${tail}`,
    "pane-missing",
    {},
  );
}

export async function captureTmuxPane(
  session: string,
  window: string,
  scrollbackLines = 100,
): Promise<string> {
  try {
    const r = await execa(
      "tmux",
      [
        "capture-pane",
        "-p",
        "-t",
        tmuxWindowTarget(session, window),
        "-S",
        `-${scrollbackLines}`,
        // -J joins wrapped lines (a log line is one line, however wide the pane).
        "-J",
      ],
      { reject: false, timeout: 3_000 },
    );
    return typeof r.stdout === "string" ? r.stdout : "";
  } catch {
    return "";
  }
}

/**
 * True if a teardown command would kill the given tmux session (e.g.
 * `tmux kill-session -t sample-app`). Used to skip such teardown when the
 * session is in reuse mode (cairn owns its lifecycle and leaves it alive).
 */
function killsTmuxSession(cmd: string, session: string): boolean {
  return (
    /\bkill-session\b/.test(cmd) &&
    (cmd.includes(`-t ${session}`) ||
      cmd.includes(`-t=${session}`) ||
      new RegExp(`\\b${session}\\b`).test(cmd))
  );
}

/**
 * True if a teardown command would tear down docker compose infra that
 * reused tmux services still need (mongo/redis/postgres/etc.).
 */
function tearsDownDocker(cmd: string): boolean {
  return (
    /\bdocker\s+compose\s+down\b/.test(cmd) ||
    /\bdocker-compose\s+down\b/.test(cmd)
  );
}

/** Per-command cap of a teardown command on the signal path. */
const DEFAULT_SIGNAL_TEARDOWN_TIMEOUT_MS = 10_000;
/** Signal wait of an `onSignal: wait` teardown entry that sets no timeout. */
const SIGNAL_WAIT_DEFAULT_MS = 600_000;
/** How long the signal path lets a running boot command stop on its own. */
const DEFAULT_SIGNAL_GRACE_MS = 5_000;
/** Bytes of one teardown command's output kept by the signal path. */
const SIGNAL_TEARDOWN_OUTPUT_BYTES = 64 * 1024;

/** `750ms`, `10s`. */
function formatBudget(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${Math.round(ms / 1_000)}s`;
}

/** A positive whole number of ms from `process.env[name]`, else the fallback. */
function signalBudgetMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A critical teardown entry (the provisioner's `down` once its `up`
 * started) that has not run yet.
 */
function criticalTeardownPending(phases: PhaseState): boolean {
  return phases.teardownPolicies.some(
    (policy, index) =>
      policy?.critical === true &&
      !phases.teardownSettled.has(index) &&
      (index !== phases.provisionerIndex || phases.provisionerUpStarted),
  );
}

/**
 * Synchronous, signal-safe teardown for SIGINT/SIGTERM, where the async stop()
 * never runs (process.exit follows as soon as this returns):
 *
 * 1. kill the tmux session cairn created (not a reused one);
 * 2. give a boot command that is still running (docker/seed/readiness …)
 *    up to `CAIRN_SERVICES_SIGNAL_GRACE_MS` (5000) to exit — a terminal
 *    Ctrl-C reached it too — so the teardown below does not race a
 *    provisioner that is still cancelling (see awaitBootCommandsSync);
 * 3. run the teardown commands stop() has not run, each capped at
 *    `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (10000). One that stop() or
 *    the failure cleanup is running right now is not started a second time
 *    while it is alive (two copies of a provisioner's `down` race for its
 *    state lock): the signal path waits up to the same cap for it, then
 *    leaves it to finish in the background. One that is gone (a signal
 *    killed it) runs again, as in 2.x (see awaitInFlightTeardownSync);
 * 4. the tunnels stop AFTER the regular teardown commands (a teardown that
 *    needs a tunnel, a database dump through one, still reaches it) and
 *    BEFORE the provisioner's `down`, the same order as a normal stop.
 *
 * Each step lands in `ctx.onSignalTeardown` (the invocation journal) as a
 * `services.teardown.signal` event, with the commands' redacted output.
 * In tmux-reuse mode the session stays alive and `docker compose down` is
 * skipped — the next run reuses both.
 */
function terminateServicesSync(
  phases: PhaseState,
  ctx: StartServicesContext,
): void {
  const redact = (text: string): string => phases.artifactRedactor.text(text);
  const record = (message: string, data: Record<string, unknown>): void => {
    try {
      ctx.onSignalTeardown?.event({
        phase: "teardown",
        event: "signal",
        message,
        timestamp: new Date().toISOString(),
        data,
      });
    } catch {
      // Evidence is best-effort on the signal path.
    }
  };
  const note = (line: string): void => {
    try {
      process.stderr.write(`cairn: ${redact(line)}\n`);
    } catch {
      // stderr may already be gone.
    }
  };
  // No window or tunnel restarts while the stack comes down.
  try {
    phases.supervisor?.stopSync();
  } catch {
    // best-effort, never fatal in the signal path
  }
  if (!phases.tmuxReuse) terminateTmuxSync(phases.tmuxSession);
  // The tunnels outlive the regular teardown commands (they may need one);
  // they stop right before the provisioner's `down` — see stopTunnels below.
  let tunnelsStopped = false;
  const stopTunnels = (): void => {
    if (tunnelsStopped) return;
    tunnelsStopped = true;
    try {
      phases.tunnels?.stopSync();
    } catch {
      // best-effort, never fatal in the signal path
    }
  };
  const capMs = signalBudgetMs(
    "CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS",
    DEFAULT_SIGNAL_TEARDOWN_TIMEOUT_MS,
  );
  try {
    // The provisioner's `up` (or an export) is running: its `down` must not
    // race it. Forward SIGTERM to its tree (a `kill <cairn pid>` reaches
    // only cairn) and wait as long as the `down` itself may take.
    const graceMs = phases.provisionerRunning
      ? provisionerSignalWaitMs(phases, capMs)
      : signalBudgetMs(
          "CAIRN_SERVICES_SIGNAL_GRACE_MS",
          DEFAULT_SIGNAL_GRACE_MS,
        );
    if (phases.provisionerRunning) signalBootCommandsSync(ctx.bootPids);
    awaitBootCommandsSync(ctx.bootPids, graceMs, record, note);
  } catch {
    // best-effort, never fatal in the signal path
  }
  if (phases.teardownCommands.length === 0) {
    stopTunnels();
    return;
  }
  try {
    provisionerExportsForDownSync(phases, ctx, capMs, note);
  } catch {
    // best-effort, never fatal in the signal path
  }
  for (const [index, cmd] of phases.teardownCommands.entries()) {
    try {
      if (phases.teardownSettled.has(index)) continue;
      const isProvisioner = index === phases.provisionerIndex;
      if (isProvisioner && !phases.provisionerUpStarted) continue;
      if (isProvisioner) stopTunnels();
      const policy = phases.teardownPolicies[index];
      const critical = policy?.critical === true;
      // `onSignal: wait`: the entry's own timeout (10 minutes when it has
      // none) replaces the short signal cap.
      const timeoutMs =
        policy?.onSignal === "wait"
          ? (policy.timeoutMs ?? SIGNAL_WAIT_DEFAULT_MS)
          : capMs;
      if (
        phases.teardownRunning === index &&
        awaitInFlightTeardownSync(phases, index, cmd, timeoutMs, ctx, {
          record,
          note,
          redact,
        })
      ) {
        if (
          critical &&
          phases.teardownPid !== undefined &&
          liveProcessGroupSync(phases.teardownPid).length > 0
        ) {
          phases.criticalFailures.push({
            index,
            command: redact(cmd),
            ...(isProvisioner ? { provisioner: true } : {}),
            timedOut: true,
            error: "still running after the signal wait",
            path: "signal",
          });
        }
        continue;
      }
      if (
        !isProvisioner &&
        phases.tmuxReuse &&
        phases.tmuxSessionName &&
        killsTmuxSession(cmd, phases.tmuxSessionName)
      ) {
        continue;
      }
      if (!isProvisioner && phases.tmuxReuse && tearsDownDocker(cmd)) {
        continue;
      }
      note(
        `services teardown[${index}] (${
          cmd.length > 160 ? `${cmd.slice(0, 157)}...` : cmd
        }), up to ${formatBudget(timeoutMs)}`,
      );
      // Settled before it runs: an async cleanup still in progress (an MCP
      // server outlives the signal path) must not run it a second time.
      phases.teardownSettled.add(index);
      if (!isProvisioner) phases.regularTeardownRan = true;
      const result = runSignalTeardownCommand(cmd, ctx, timeoutMs, redact);
      const status = result.timedOut
        ? "timed-out"
        : result.exitCode === 0
          ? "completed"
          : "failed";
      record(`teardown[${index}] ${status} (signal path)`, {
        index,
        status,
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
        durationMs: result.durationMs,
        timeoutMs,
        ...(critical ? { critical: true } : {}),
      });
      if (critical && status !== "completed") {
        note(
          `CRITICAL services teardown[${index}] ${status}; the invocation journal records it`,
        );
        phases.criticalFailures.push({
          index,
          command: redact(cmd),
          ...(isProvisioner ? { provisioner: true } : {}),
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(result.signal ? { signal: result.signal } : {}),
          path: "signal",
        });
      }
    } catch {
      // best-effort, never fatal in the signal path
    }
  }
  stopTunnels();
  dropSeedResumeAfterTeardown(phases);
}

/**
 * One teardown command on the signal path. Output goes to a private temp
 * file (never a pipe: a background grandchild holding a pipe would block
 * spawnSync past its timeout), then into the evidence sink, redacted.
 */
function runSignalTeardownCommand(
  cmd: string,
  ctx: StartServicesContext,
  timeoutMs: number,
  redact: (text: string) => string,
): {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
} {
  const sink = ctx.onSignalTeardown;
  let file: string | undefined;
  let fd: number | undefined;
  if (sink) {
    try {
      file = join(
        tmpdir(),
        `cairn-signal-teardown-${process.pid}-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2, 8)}.log`,
      );
      fd = openSync(file, "w", 0o600);
    } catch {
      file = undefined;
      fd = undefined;
    }
  }
  const startedAt = Date.now();
  let result: ReturnType<typeof spawnSync> | undefined;
  try {
    // `detached` is honored by spawnSync (setsid) though the typings only
    // declare it for spawn.
    const options: SpawnSyncOptions & { detached: boolean } = {
      cwd: ctx.configDir,
      // Same filtered env as the async teardown: the scoped secrets, never
      // the parent's file.cheap / TinyVault client credentials.
      env: targetEnv(ctx),
      shell: true,
      // Its own process group, like the async teardown: a second Ctrl-C or
      // a launcher's group SIGKILL (Studio's Stop escalates after 2s) stops
      // cairn, not a provisioner's `down` halfway.
      detached: true,
      timeout: timeoutMs,
      stdio: fd !== undefined ? ["ignore", fd, fd] : "ignore",
    };
    result = spawnSync(cmd, options);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  const durationMs = Date.now() - startedAt;
  const timedOut =
    (result?.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const exitCode = result?.status ?? null;
  const signal = result?.signal ?? null;
  if (sink && file) {
    try {
      sink.output(redact(`$ ${cmd}`));
      const text = readFileSync(file, "utf8");
      const kept =
        text.length > SIGNAL_TEARDOWN_OUTPUT_BYTES
          ? text.slice(-SIGNAL_TEARDOWN_OUTPUT_BYTES)
          : text;
      for (const line of kept.split(/\r?\n/)) {
        if (line.length > 0) sink.output(redact(line));
      }
      sink.output(
        timedOut
          ? `[timed out after ${timeoutMs}ms${signal ? `, ${signal}` : ""}]`
          : `[exit ${exitCode ?? signal ?? "?"}]`,
      );
    } catch {
      // Evidence is best-effort on the signal path.
    } finally {
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
  return { exitCode, signal, timedOut, durationMs };
}

/**
 * The teardown command stop() or the failure cleanup was running when the
 * signal arrived (it runs detached, in its own process group, so the signal
 * that stops cairn normally does not reach it).
 *
 * - Something of it is still running: wait up to `timeoutMs` for it to
 *   finish, without starting a second copy (two copies of a provisioner's
 *   `down` race for its state lock); past the wait it is left to finish in
 *   the background, its output in a private temp file. Returns true.
 * - Nothing of it is left (a tree kill took it, or it was never spawned):
 *   returns false, and the caller runs it again, as 2.x did. A command that
 *   completed just before the signal, while cairn had not yet seen its exit,
 *   runs again too: running a teardown twice is cheaper than skipping one.
 */
function awaitInFlightTeardownSync(
  phases: PhaseState,
  index: number,
  cmd: string,
  timeoutMs: number,
  ctx: StartServicesContext,
  io: {
    record: (message: string, data: Record<string, unknown>) => void;
    note: (line: string) => void;
    redact: (text: string) => string;
  },
): boolean {
  const pid = phases.teardownPid;
  const outputFile = phases.teardownOutputFile;
  const startedAt = Date.now();
  let alive = pid === undefined ? [] : liveProcessGroupSync(pid);
  if (alive.length === 0) {
    io.note(
      `services teardown[${index}] was running but is gone; running it again, up to ${formatBudget(timeoutMs)}`,
    );
    io.record(
      `teardown[${index}] was running when the signal arrived but is gone; running it again (signal path)`,
      { index, status: "re-run" },
    );
    return false;
  }
  io.note(
    `services teardown[${index}] is already running; waiting up to ${formatBudget(timeoutMs)} for it to finish`,
  );
  const deadline = startedAt + timeoutMs;
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(Math.min(250, Math.max(1, deadline - Date.now())));
    alive = liveProcessGroupSync(pid!);
  }
  const durationMs = Date.now() - startedAt;
  if (alive.length > 0) {
    io.note(
      `services teardown[${index}] is still running after ${formatBudget(timeoutMs)}; it finishes in the background${
        outputFile ? ` (output: ${outputFile})` : ""
      } (CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS waits longer)`,
    );
    io.record(
      `teardown[${index}] was still running after the wait; left to finish in the background`,
      {
        index,
        status: "in-flight",
        pid,
        stillRunning: alive.length,
        durationMs,
        timeoutMs,
        ...(outputFile ? { outputFile } : {}),
      },
    );
    return true;
  }
  const sink = ctx.onSignalTeardown;
  if (sink && outputFile) {
    try {
      sink.output(io.redact(`$ ${cmd}`));
      const text = readTailSync(outputFile, SIGNAL_TEARDOWN_OUTPUT_BYTES);
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) sink.output(io.redact(line));
      }
      sink.output("[exited while the signal path waited]");
    } catch {
      // Evidence is best-effort on the signal path.
    }
  }
  if (outputFile) {
    try {
      unlinkSync(outputFile);
    } catch {
      // stop() may still read it (an MCP server outlives the signal path).
    }
  }
  io.record(
    `teardown[${index}] finished while the signal path waited (signal path)`,
    { index, status: "finished", durationMs, timeoutMs },
  );
  return true;
}

/**
 * Live (non-zombie) members of process group `pgid`. A teardown command runs
 * detached, so its shell leads its own group and every process it starts
 * stays in that group even after the shell exits and they are re-parented.
 */
function liveProcessGroupSync(pgid: number): number[] {
  try {
    const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (typeof r.stdout === "string" && !r.error && r.status === 0) {
      const live: number[] = [];
      for (const line of r.stdout.split("\n")) {
        const [pid, group, stat] = line.trim().split(/\s+/);
        if (pid && stat && Number(group) === pgid && !stat.startsWith("Z")) {
          live.push(Number(pid));
        }
      }
      return live;
    }
  } catch {
    // fall through
  }
  // Without ps: signal 0 to the group (a zombie leader still counts).
  try {
    process.kill(-pgid, 0);
    return [pgid];
  } catch {
    return [];
  }
}

/**
 * Give the boot commands still running when the signal arrived up to
 * `graceMs` to exit before the teardown starts. A terminal Ctrl-C (or a
 * process-group SIGTERM) reached them too, and a provisioner that cancels its
 * `up` gracefully holds its state lock until it exits: a teardown started
 * meanwhile races it. No signal is sent here, because a second signal turns a
 * graceful cancel into a forced one. A command still running after the grace
 * keeps running, as in 2.x, and the teardown proceeds.
 */
function awaitBootCommandsSync(
  roots: Set<number> | undefined,
  graceMs: number,
  record: (message: string, data: Record<string, unknown>) => void,
  note: (line: string) => void,
): void {
  if (!roots || roots.size === 0) return;
  const startedAt = Date.now();
  const tree: number[] = [];
  for (const root of roots) {
    for (const pid of [root, ...descendantPidsSync(root)]) {
      if (!tree.includes(pid)) tree.push(pid);
    }
  }
  let alive = livePidsSync(tree);
  if (alive.length === 0) return;
  note(
    `waiting up to ${formatBudget(graceMs)} for the running services command to exit before the teardown`,
  );
  alive = waitForExitSync(alive, graceMs);
  if (alive.length > 0) {
    note(
      `the services command is still running after ${formatBudget(graceMs)}; tearing down anyway (CAIRN_SERVICES_SIGNAL_GRACE_MS waits longer)`,
    );
  }
  record(
    alive.length === 0
      ? "services boot command exited before the teardown (signal path)"
      : "services boot command still running after the grace (signal path)",
    {
      kind: "boot",
      exited: alive.length === 0,
      pids: tree.length,
      stillRunning: alive.length,
      graceMs,
      durationMs: Date.now() - startedAt,
    },
  );
}

/** How long the signal path waits for a running provisioner `up`: the `down`'s own signal budget. */
function provisionerSignalWaitMs(phases: PhaseState, capMs: number): number {
  const policy =
    phases.provisionerIndex === undefined
      ? undefined
      : phases.teardownPolicies[phases.provisionerIndex];
  return policy?.onSignal === "wait"
    ? (policy.timeoutMs ?? SIGNAL_WAIT_DEFAULT_MS)
    : capMs;
}

/** SIGTERM every running boot command's tree (children first). */
function signalBootCommandsSync(roots: Set<number> | undefined): void {
  for (const root of roots ?? []) {
    for (const pid of [root, ...descendantPidsSync(root)].toReversed()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

/** Poll until every pid exited (zombies count as exited) or `ms` passed. */
function waitForExitSync(pids: number[], ms: number): number[] {
  const deadline = Date.now() + ms;
  let alive = livePidsSync(pids);
  while (alive.length > 0 && Date.now() < deadline) {
    sleepSync(Math.min(100, Math.max(1, deadline - Date.now())));
    alive = livePidsSync(alive);
  }
  return alive;
}

/**
 * The pids still running. `ps` tells a zombie (our own exited child, not
 * reaped while the event loop is blocked) from a live process; without it,
 * signal 0 decides.
 */
function livePidsSync(pids: number[]): number[] {
  if (pids.length === 0) return [];
  try {
    const r = spawnSync("ps", ["-o", "pid=,stat=", "-p", pids.join(",")], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (typeof r.stdout === "string" && !r.error) {
      const live = new Set<number>();
      for (const line of r.stdout.split("\n")) {
        const [pid, stat] = line.trim().split(/\s+/);
        if (pid && stat && !stat.startsWith("Z")) live.add(Number(pid));
      }
      return pids.filter((pid) => live.has(pid));
    }
  } catch {
    // fall through
  }
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function terminateTmuxSync(session: string | undefined): void {
  if (!session) return;
  try {
    spawnSync("tmux", ["kill-session", "-t", tmuxSessionTarget(session)], {
      timeout: 3_000,
    });
  } catch {
    // best-effort, never fatal in signal path
  }
}

interface SignalTmuxCaptureInput {
  runDir: string;
  signal: "SIGINT" | "SIGTERM";
  session: string | undefined;
  windows: string[];
  policy: ServicesArtifactsConfig;
  redactor: ArtifactRedactor;
  disposition: "created" | "recreated" | "reused" | undefined;
  startedAt: string;
}

type CapturePaneSync = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

/**
 * Persist tmux tails while the signal handler still has a live session.
 *
 * This intentionally uses only synchronous APIs: execa/signal-exit re-raises
 * SIGINT/SIGTERM as soon as Cairn's synchronous cleanup returns, so an async
 * promise cannot be trusted to finish. The normal completed-run path remains
 * `collectRunArtifacts`; this is only the interrupted-run safety net.
 */
export function captureTmuxSignalArtifactsSync(
  input: SignalTmuxCaptureInput,
  capturePane: CapturePaneSync = (command, args, options) =>
    spawnSync(command, args, options),
): void {
  const { policy } = input;
  if (
    policy.when === "never" ||
    !policy.capture.includes("tmux") ||
    !input.session ||
    input.windows.length === 0
  ) {
    return;
  }

  const servicesDir = resolve(input.runDir, "services");
  const tmuxDir = resolve(servicesDir, "tmux");
  const capturedAt = new Date().toISOString();
  const files: Array<{
    source: "tmux";
    path: string;
    label: string;
    bytes: number;
    truncated: boolean;
    metadata: Record<string, string | number>;
  }> = [];
  const errors: ServicesArtifactCaptureError[] = [];
  let totalBytes = 0;
  let truncated = false;

  const recordError = (label: string, error: unknown): void => {
    errors.push({
      source: "tmux",
      label: safeArtifactLabel(label),
      message: prepareArtifactText(
        input.redactor,
        error instanceof Error ? error.message : String(error),
      ),
    });
  };

  try {
    mkdirSync(tmuxDir, { recursive: true, mode: 0o700 });
    chmodSync(servicesDir, 0o700);
    chmodSync(tmuxDir, 0o700);
  } catch {
    // If the run directory cannot be written, there is nowhere safe to leave
    // diagnostics. Signal teardown must still continue.
    return;
  }

  for (const window of input.windows) {
    const label = `tmux/${safeArtifactLabel(window)}`;
    const relativePath = `services/tmux/${safeArtifactSegment(window)}.log`;
    const remaining = policy.maxBytesPerRun - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      recordError(label, "bundle maxBytesPerRun reached; pane omitted");
      continue;
    }

    try {
      const result = capturePane(
        "tmux",
        [
          "capture-pane",
          "-p",
          "-t",
          tmuxWindowTarget(input.session, window),
          "-S",
          `-${policy.maxLinesPerSource}`,
          "-J",
        ],
        {
          encoding: "utf8",
          timeout: 3_000,
          maxBuffer: rawCaptureBufferLimit(policy),
        },
      );
      const stdout =
        typeof result.stdout === "string"
          ? result.stdout
          : (result.stdout?.toString("utf8") ?? "");
      const stderr =
        typeof result.stderr === "string"
          ? result.stderr
          : (result.stderr?.toString("utf8") ?? "");
      const raw = `${stdout}${stderr ? `\n${stderr}` : ""}`;
      const prepared = prepareArtifactText(input.redactor, raw);
      const bounded = boundArtifactText(
        prepared,
        policy.maxLinesPerSource,
        Math.min(policy.maxBytesPerSource, remaining),
      );
      const absolutePath = resolve(
        input.runDir,
        "services",
        "tmux",
        `${safeArtifactSegment(window)}.log`,
      );
      writeFileSync(absolutePath, bounded.content, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(absolutePath, 0o600);
      files.push({
        source: "tmux",
        path: relativePath,
        label,
        bytes: bounded.bytes,
        truncated: bounded.truncated,
        metadata: {
          window: safeArtifactLabel(window),
          disposition: input.disposition ?? "reused",
          exitCode: result.status ?? -1,
        },
      });
      totalBytes += bounded.bytes;
      if (bounded.truncated) truncated = true;
      if (result.error) recordError(label, result.error);
      if ((result.status ?? -1) !== 0) {
        recordError(
          label,
          `capture-pane exited ${result.status ?? -1}${
            result.signal ? ` (${result.signal})` : ""
          }`,
        );
      }
    } catch (error) {
      recordError(label, error);
    }
  }

  // Use the same manifest location as completed runs so `cairn logs latest
  // --services` works for interrupted runs too. No asynchronous finalizer will
  // run after this handler returns.
  try {
    const manifestPath = resolve(servicesDir, "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        input.redactor.value({
          $schema: "urn:cairntrace.dev:service-artifacts:v1",
          version: "1",
          status: "errored",
          interrupted: true,
          signal: input.signal,
          capturedAt,
          runWindow: { startedAt: input.startedAt, endedAt: capturedAt },
          policy,
          ownership: {
            tmux: input.disposition ?? "reused",
          },
          files,
          errors,
          totalBytes,
          truncated,
        }),
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(manifestPath, 0o600);
  } catch {
    // Pane logs are the primary evidence. A manifest write failure must not
    // prevent service teardown or discard panes that were already written.
  }
}

/* ----- local per-run service artifact collection ----- */

async function collectRunArtifacts(
  cfg: ServicesConfig,
  phases: PhaseState,
  ctx: StartServicesContext,
  status: ServicesRunStatus,
  requestedWindow?: ServicesRunWindow,
): Promise<ServicesArtifactBundle> {
  const policy = phases.localArtifactPolicy;
  const startedAt =
    normalizeIsoTimestamp(requestedWindow?.startedAt) ?? phases.startedAt;
  const endedAt = normalizeIsoTimestamp(requestedWindow?.endedAt);
  const bundle: ServicesArtifactBundle = {
    version: "1",
    status,
    captured: false,
    reason:
      policy.when === "never"
        ? "policy-never"
        : policy.when === "on-failure" && status === "passed"
          ? "status-passed"
          : "captured",
    capturedAt: new Date().toISOString(),
    policy,
    runWindow: {
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
    },
    ownership: {
      ...(phases.dockerDisposition ? { docker: phases.dockerDisposition } : {}),
      ...(phases.tmuxDisposition ? { tmux: phases.tmuxDisposition } : {}),
    },
    files: [],
    errors: [],
    totalBytes: 0,
    truncated: false,
  };

  if (bundle.reason !== "captured") return bundle;
  bundle.captured = true;

  const addError = (
    source: ServicesArtifactCaptureSource,
    label: string,
    error: unknown,
  ): void => {
    const raw = error instanceof Error ? error.message : String(error);
    bundle.errors.push({
      source,
      label: safeArtifactLabel(label),
      message: prepareArtifactText(phases.artifactRedactor, raw),
    });
  };

  const addFile = (
    source: ServicesArtifactCaptureSource,
    relativePath: string,
    label: string,
    rawContent: string,
    metadata?: Record<string, string | number | boolean>,
  ): void => {
    const remaining = policy.maxBytesPerRun - bundle.totalBytes;
    if (remaining <= 0) {
      bundle.truncated = true;
      addError(source, label, "bundle maxBytesPerRun reached; source omitted");
      return;
    }
    const prepared = prepareArtifactText(phases.artifactRedactor, rawContent);
    const bounded = boundArtifactText(
      prepared,
      policy.maxLinesPerSource,
      Math.min(policy.maxBytesPerSource, remaining),
    );
    bundle.files.push({
      source,
      relativePath: confinedServiceArtifactPath(relativePath),
      label: safeArtifactLabel(label),
      content: bounded.content,
      bytes: bounded.bytes,
      truncated: bounded.truncated,
      ...(metadata ? { metadata } : {}),
    });
    bundle.totalBytes += bounded.bytes;
    if (bounded.truncated) bundle.truncated = true;
  };

  const addStoredCommandRecords = (source: "docker" | "seed"): void => {
    const records = phases.commandArtifactRecords.filter(
      (record) => record.source === source,
    );
    for (const [recordIndex, record] of records.entries()) {
      addFile(
        source,
        `services/${source}/${String(recordIndex).padStart(2, "0")}-${safeArtifactSegment(record.label)}.log`,
        `${source}/${record.label}`,
        record.content,
        {
          kind: record.kind,
          index: record.index,
          exitCode: record.exitCode,
          storedTruncated: record.truncated,
        },
      );
      if (record.truncated) bundle.truncated = true;
    }
    const omitted = phases.commandArtifactOmitted[source] ?? 0;
    if (omitted > 0) {
      bundle.truncated = true;
      addError(
        source,
        `${source}/output`,
        `${omitted} ${source} command output source(s) omitted while storing bounded diagnostics`,
      );
    }
  };

  if (policy.capture.includes("lifecycle")) {
    try {
      const lifecycle = phases.events
        .map((event) => JSON.stringify(phases.artifactRedactor.value(event)))
        .join("\n");
      addFile(
        "lifecycle",
        "services/lifecycle.ndjson",
        "services/lifecycle",
        `${lifecycle}${lifecycle ? "\n" : ""}`,
      );
    } catch (error) {
      addError("lifecycle", "services/lifecycle", error);
    }
  }

  // tmuxSessionName is deliberately used instead of tmuxSession: the latter
  // means "created by this invocation", while diagnostics must also capture a
  // reused session that the run depended on.
  if (policy.capture.includes("tmux") && cfg.tmux && phases.tmuxSessionName) {
    for (const win of cfg.tmux.windows) {
      const label = `tmux/${safeArtifactLabel(win.name)}`;
      try {
        const result = await execa(
          "tmux",
          [
            "capture-pane",
            "-p",
            "-t",
            tmuxWindowTarget(phases.tmuxSessionName, win.name),
            "-S",
            `-${policy.maxLinesPerSource}`,
            "-J",
          ],
          {
            reject: false,
            timeout: 3_000,
            maxBuffer: rawCaptureBufferLimit(policy),
          },
        );
        const output = `${
          typeof result.stdout === "string" ? result.stdout : ""
        }${result.stderr ? `\n${result.stderr}` : ""}`;
        addFile(
          "tmux",
          `services/tmux/${safeArtifactSegment(win.name)}.log`,
          label,
          output,
          {
            window: safeArtifactLabel(win.name),
            disposition: phases.tmuxDisposition ?? "reused",
            exitCode: result.exitCode ?? -1,
          },
        );
        if (result.exitCode !== 0) {
          addError("tmux", label, `capture-pane exited ${result.exitCode}`);
        }
      } catch (error) {
        addError("tmux", label, error);
      }
    }
  }

  if (policy.capture.includes("docker") && cfg.docker) {
    addStoredCommandRecords("docker");
    // A `docker` lifecycle command may be a remote provisioner (for example
    // Chalupa), not a local Compose project. Its bounded command transcript is
    // still useful; only ask the local Docker CLI for logs when the authored
    // command actually names Compose.
    if (isDockerComposeCommand(cfg.docker.command)) {
      const args = [
        "compose",
        "logs",
        "--no-color",
        "--timestamps",
        "--tail",
        String(policy.maxLinesPerSource),
        "--since",
        startedAt,
        ...(endedAt ? ["--until", endedAt] : []),
      ];
      try {
        const result = await execa("docker", args, {
          cwd: resolveCwd(cfg.docker.cwd, ctx.configDir),
          env: targetEnv(ctx, cfg.docker.env),
          extendEnv: false,
          reject: false,
          timeout: 15_000,
          maxBuffer: rawCaptureBufferLimit(policy),
        });
        const output = `${
          typeof result.stdout === "string" ? result.stdout : ""
        }${result.stderr ? `\n${result.stderr}` : ""}`;
        addFile(
          "docker",
          "services/docker/compose.log",
          "docker/compose",
          output,
          {
            disposition: phases.dockerDisposition ?? "reused",
            exitCode: result.exitCode ?? -1,
            since: startedAt,
            ...(endedAt ? { until: endedAt } : {}),
          },
        );
        if (result.exitCode !== 0) {
          addError(
            "docker",
            "docker/compose",
            `compose logs exited ${result.exitCode}`,
          );
        }
      } catch (error) {
        addError("docker", "docker/compose", error);
      }
    }
  }

  if (policy.capture.includes("seed")) {
    addStoredCommandRecords("seed");
  }

  return bundle;
}

function normalizeIsoTimestamp(
  value: string | Date | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function safeArtifactSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return safe || "service";
}

function rawCaptureBufferLimit(policy: ServicesArtifactsConfig): number {
  return Math.min(
    Math.max(policy.maxBytesPerRun, policy.maxBytesPerSource * 4),
    64 * 1024 * 1024,
  );
}

function isDockerComposeCommand(command: string): boolean {
  return /\b(?:docker\s+compose|docker-compose)\b/.test(command);
}

function safeArtifactLabel(value: string): string {
  return stripAnsiAndControls(value).replaceAll("\\", "/").slice(0, 160);
}

function confinedServiceArtifactPath(relativePath: string): string {
  const portable = relativePath.replaceAll("\\", "/");
  if (
    !portable.startsWith("services/") ||
    portable.startsWith("/") ||
    portable.includes("\0") ||
    portable.split("/").includes("..")
  ) {
    throw new Error(`invalid service artifact path: ${relativePath}`);
  }
  return portable;
}

function prepareArtifactText(
  redactor: ArtifactRedactor,
  input: string,
): string {
  return redactor.text(stripAnsiAndControls(input));
}

function stripAnsiAndControls(input: string): string {
  const normalized = stripVTControlCharacters(input)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  let clean = "";
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    const allowedWhitespace = character === "\n" || character === "\t";
    if (
      allowedWhitespace ||
      (codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      clean += character;
    }
  }
  return clean;
}

function boundArtifactText(
  input: string,
  maxLines: number,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const lines = input.split("\n");
  const hadTrailingNewline = input.endsWith("\n");
  if (hadTrailingNewline) lines.pop();
  const linesTruncated = lines.length > maxLines;
  const tail = linesTruncated ? lines.slice(-maxLines) : lines;
  const boundedTail = `${tail.join("\n")}${
    hadTrailingNewline && tail.length > 0 ? "\n" : ""
  }`;
  const lineBounded = linesTruncated
    ? `[cairntrace: truncated to last ${maxLines} lines]\n${boundedTail}`
    : input;
  const byteBounded = boundUtf8Tail(lineBounded, maxBytes);
  return {
    ...byteBounded,
    truncated: linesTruncated || byteBounded.truncated,
  };
}

function boundUtf8Tail(
  input: string,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { content: input, bytes: bytes.byteLength, truncated: false };
  }
  if (maxBytes <= 0) return { content: "", bytes: 0, truncated: true };

  const marker = Buffer.from(
    `[cairntrace: truncated ${bytes.byteLength - maxBytes} or more bytes; tail follows]\n`,
    "utf8",
  );
  if (marker.byteLength >= maxBytes) {
    const content = marker.subarray(0, maxBytes).toString("utf8");
    return {
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      truncated: true,
    };
  }
  const tailBudget = maxBytes - marker.byteLength;
  let start = Math.max(0, bytes.byteLength - tailBudget);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
  const content = `${marker.toString("utf8")}${bytes.subarray(start).toString("utf8")}`;
  return {
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    truncated: true,
  };
}

/* ----- fcheap stash helpers (deprecated services.stash) ----- */

/** Default TTL of a services stash (`services.stash.ttl`). */
const DEFAULT_SERVICES_STASH_TTL = "7d";

/**
 * Whether the deprecated `services.stash` block stashes after this
 * invocation: enabled, and autoStash `always` (also when unset, as before
 * autoStash was honored), or `on-failure` when a run failed or errored.
 * `never` never stashes.
 */
export function shouldStashServices(
  stash: Pick<ServicesStashConfig, "enabled" | "autoStash"> | undefined,
  sawFailure: boolean,
): boolean {
  if (!stash?.enabled) return false;
  // Unset keeps what `enabled: true` meant before autoStash was honored.
  const mode = stash.autoStash ?? "always";
  if (mode === "always") return true;
  return mode === "on-failure" && sawFailure;
}

/** The services-stop line for a deprecated `services.stash` block. */
export function servicesStashDeprecation(
  stash: Pick<ServicesStashConfig, "enabled" | "autoStash"> | undefined,
): string | undefined {
  if (!stash?.enabled) return undefined;
  return stash.autoStash === undefined
    ? "services.stash is deprecated: `enabled: true` without `autoStash` still stashes after every invocation; set autoStash (always | on-failure | never) or move to services.artifacts"
    : "services.stash is deprecated: move to services.artifacts (redacted service logs inside each run, carried by stash.autoStash)";
}

/**
 * Capture tmux pane output (a reused session too), docker logs and seed
 * output into the artifacts directory, each redacted with the services
 * redactor (registered secrets, credential headers, URI userinfo). Called
 * during `stop()` before the tmux session is killed. Only captures the
 * phases that ran and are in the `capture` list; empty captures are skipped.
 */
async function captureSessionArtifacts(
  cfg: ServicesConfig,
  phases: PhaseState,
  ctx: StartServicesContext,
): Promise<void> {
  if (!phases.artifactsDir) return;
  const capture = cfg.stash?.capture ?? ["tmux", "docker", "seed"];
  // A fresh redactor also covers values the runs registered after the
  // services started (spec `redaction.values`, vault secrets).
  const late = createArtifactRedactor(
    undefined,
    ctx.env ?? process.env,
    ctx.secretValues,
  );
  const redact = (text: string): string =>
    late.text(phases.artifactRedactor.text(text));
  const keep = async (
    phase: string,
    name: string,
    label: string,
    content: string,
  ): Promise<void> => {
    if (!phases.artifactsDir || content.trim() === "") return;
    const file = join(phases.artifactsDir, name);
    await writeFile(file, redact(content), { encoding: "utf-8", mode: 0o600 });
    phases.artifacts.push({ phase, file, label });
  };

  // Capture tmux pane output for each window (created or reused session).
  const session = phases.tmuxSession ?? phases.tmuxSessionName;
  if (session && capture.includes("tmux") && cfg.tmux) {
    for (const win of cfg.tmux.windows) {
      try {
        const pane = await captureTmuxPane(session, win.name);
        await keep(
          "tmux",
          `tmux-${win.name.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`,
          `tmux/${win.name}`,
          pane,
        );
      } catch {
        // best-effort
      }
    }
  }

  // Capture docker compose logs.
  if (phases.dockerStarted && capture.includes("docker") && cfg.docker) {
    try {
      const cwd = resolveCwd(cfg.docker.cwd, ctx.configDir);
      const r = await execa("docker", ["compose", "logs", "--tail=200"], {
        cwd,
        reject: false,
        timeout: 15_000,
      });
      await keep(
        "docker",
        "docker-logs.txt",
        "docker/logs",
        `${r.stdout}\n${r.stderr}`,
      );
    } catch {
      // best-effort
    }
  }

  // Seed output: the bounded, redacted command records the seed phase kept.
  if (capture.includes("seed")) {
    const seed = phases.commandArtifactRecords
      .filter((record) => record.source === "seed")
      .map((record) => `# ${record.label}\n${record.content}`)
      .join("\n\n");
    try {
      await keep("seed", "seed-output.txt", "seed/output", seed);
    } catch {
      // best-effort
    }
  }
}

/**
 * Stash the captured artifacts directory to the fcheap vault with a TTL
 * (default 7d). Best-effort: if fcheap isn't installed, logs a warning and
 * continues.
 */
async function stashServicesArtifacts(
  stashCfg: ServicesStashConfig,
  phases: PhaseState,
  ctx: StartServicesContext,
): Promise<void> {
  if (!phases.artifactsDir || phases.artifacts.length === 0) return;

  try {
    const { stashDirectory } = await import("../../cli/commands/stash");
    const tags = ["services", ctx.project, ...(stashCfg.tags ?? [])];
    const result = await stashDirectory(phases.artifactsDir, {
      name: `${ctx.project}-services-${new Date().toISOString()}`,
      tool: "cairntrace-services",
      tags,
      ttl: stashCfg.ttl ?? DEFAULT_SERVICES_STASH_TTL,
    });
    if (result.ok) {
      ctx.log?.(
        `stashed ${phases.artifacts.length} artifacts to fcheap → ${result.stashId ?? "(unknown)"}`,
      );
    } else {
      ctx.log?.(`stash to fcheap failed (non-fatal): ${result.error}`);
    }
  } catch (e) {
    ctx.log?.(`stash to fcheap failed (non-fatal): ${(e as Error).message}`);
  }
}

/* ----- shared helpers ----- */

export function resolveCwd(cwd: string | undefined, configDir: string): string {
  if (!cwd) return configDir;
  return isAbsolute(cwd) ? cwd : resolve(configDir, cwd);
}

function tailText(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n").trim();
}

/* ----- healthcheck ----- */

/* ----- readiness gates (F2) ----- */

/** Warning sink for the readiness behavior change (see warnLegacyReadiness). */
function readinessWarn(
  ctx: Pick<StartServicesContext, "warn" | "log">,
): (message: string) => void {
  return (
    ctx.warn ??
    ctx.log ??
    ((message: string) => process.stderr.write(`cairn: warning: ${message}\n`))
  );
}

/**
 * Gate context of a services readiness wait: registry gates run their
 * command probes from the config directory, the phase's env is the probe
 * env (`${secrets.X}` resolves from the scoped secrets), and gate.* events
 * go to `onGateEvent`. `onStarted` lets the phase emit its services event.
 */
async function serviceGateContext(
  ctx: Pick<
    StartServicesContext,
    | "gates"
    | "onGateEvent"
    | "signal"
    | "configDir"
    | "logDetail"
    | "secretValues"
  >,
  input: {
    scope: string;
    label: string;
    env: NodeJS.ProcessEnv;
    cwd: string;
    defaultTimeoutMs?: number;
    onStarted?: (name: string, budgetMs: number) => void;
  },
): Promise<GateContext> {
  const redactor = createArtifactRedactor(
    undefined,
    input.env,
    ctx.secretValues,
  );
  return {
    registry: await gatesRegistryFor(ctx),
    env: input.env as Record<string, string | undefined>,
    cwd: input.cwd,
    registryCwd: ctx.configDir,
    scope: input.scope,
    ...(input.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: input.defaultTimeoutMs }
      : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    redact: (text) => redactor.text(text),
    onEvent: (event) => {
      if (event.type === "gate.started") {
        input.onStarted?.(event.name, event.budgetMs);
      }
      if (event.type === "gate.attempt" && !event.ok) {
        ctx.logDetail?.(
          `${input.label} — gate ${event.name} attempt ${event.attempt}: ${event.detail}`,
        );
      }
      ctx.onGateEvent?.(event);
    },
  };
}

/**
 * Wait the gates in order. Throws ServicesError for a gate that is not
 * ready or an unknown name, ServicesCancelledError on cancel.
 */
async function waitServiceGates(
  refs: readonly GateRef[],
  gateCtx: GateContext,
  label: string,
  ctx: Pick<StartServicesContext, "log">,
): Promise<void> {
  for (const ref of refs) {
    let result;
    try {
      result = await waitForGate(ref, gateCtx);
    } catch (error) {
      if (error instanceof GateReferenceError) {
        throw new ServicesError(`${label}: ${error.message}`);
      }
      throw error;
    }
    if (result.cancelled) throw new ServicesCancelledError();
    if (!result.ok) {
      throw new ServicesError(`${label}: ${gateFailureMessage(result)}`);
    }
    ctx.log?.(
      `${label} — gate ${result.name} ready (${result.attempts} attempt(s), ${result.durationMs}ms)`,
    );
  }
}

/**
 * `docker.ready`: after the start command and `readinessCheck`, and also
 * when running containers are reused. A gate without its own `timeout`
 * gets what `readinessCheck` left of the docker `readyTimeoutMs` (all of it
 * on reuse; 0 = no deadline).
 */
async function waitDockerReadyGates(
  cfg: DockerConfig,
  ctx: StartServicesContext,
  input: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
  emit: EmitFn,
): Promise<void> {
  const refs = gateRefList(cfg.ready);
  if (refs.length === 0) return;
  const gateCtx = await serviceGateContext(ctx, {
    scope: "services.docker",
    label: "docker",
    env: input.env,
    cwd: input.cwd,
    defaultTimeoutMs: input.timeoutMs,
    onStarted: (name, budgetMs) =>
      emit("docker", "readiness-check", `gate ${name}`, {
        gate: name,
        budgetMs,
      }),
  });
  try {
    await waitServiceGates(refs, gateCtx, "docker", ctx);
  } catch (error) {
    if (!(error instanceof ServicesCancelledError)) {
      emit("docker", "fail", (error as Error).message, { reason: "gate" });
    }
    throw error;
  }
}

/**
 * Boot a window after its `after` gates passed (e.g. the database it
 * connects to). A gate without its own `timeout` gets the tmux
 * `readyTimeoutMs` (0 = no deadline).
 */
async function bootTmuxWindowAfterGates(
  cfg: TmuxConfig,
  win: TmuxWindow,
  ctx: StartServicesContext,
  emit: EmitFn,
): Promise<void> {
  const refs = gateRefList(win.after);
  if (refs.length > 0) {
    const gateCtx = await serviceGateContext(ctx, {
      scope: "services.tmux",
      label: `tmux/${win.name}`,
      env: targetEnv(ctx, { ...cfg.env, ...win.env }),
      cwd: resolveCwd(win.cwd, ctx.configDir),
      defaultTimeoutMs: cfg.readyTimeoutMs ?? DEFAULT_TMUX_READY_MS,
      onStarted: (name, budgetMs) =>
        emit("tmux", "ready-wait", `"${win.name}" waits for gate ${name}`, {
          window: win.name,
          gate: name,
          budgetMs,
        }),
    });
    try {
      await waitServiceGates(refs, gateCtx, `tmux/${win.name}`, ctx);
    } catch (error) {
      if (!(error instanceof ServicesCancelledError)) {
        emit("tmux", "fail", `"${win.name}" after-gate failed`, {
          window: win.name,
          reason: "after-gate",
        });
      }
      throw error;
    }
  }
  await bootTmuxWindow(cfg.session, win, ctx);
}

/** The `readyOn.gate` watch of one window's readiness wait. */
async function tmuxReadyOnGate(
  cfg: TmuxConfig,
  win: TmuxWindow,
  ctx: StartServicesContext,
): Promise<{ watch: GateWatch; everyMs: number } | undefined> {
  if (win.readyOn?.gate === undefined) return undefined;
  const gateCtx = await serviceGateContext(ctx, {
    scope: "services.tmux",
    label: `tmux/${win.name}`,
    env: targetEnv(ctx, { ...cfg.env, ...win.env }),
    cwd: resolveCwd(win.cwd, ctx.configDir),
    // The window's readiness deadline governs; only stable/every apply.
    defaultTimeoutMs: 0,
  });
  try {
    const { watch, everyMs } = watchGate(win.readyOn.gate, gateCtx, {
      timeoutMs: 0,
    });
    return { watch, everyMs };
  } catch (error) {
    if (error instanceof GateReferenceError) {
      throw new ServicesError(
        `tmux window "${win.name}" readyOn.gate: ${error.message}`,
      );
    }
    throw error;
  }
}

/** One look at a list of gates (liveness of a reused environment). */
async function gateProblems(
  refs: GateRefList | undefined,
  ctx: Pick<StartServicesContext, "gates" | "configDir" | "signal">,
  input: { env: NodeJS.ProcessEnv; cwd: string; label: string },
): Promise<string[]> {
  const problems: string[] = [];
  for (const ref of gateRefList(refs)) {
    try {
      const look = await checkGateOnce(ref, {
        registry: await gatesRegistryFor(ctx),
        env: input.env as Record<string, string | undefined>,
        cwd: input.cwd,
        registryCwd: ctx.configDir,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!look.ok) {
        problems.push(
          `${input.label} gate ${look.name} is not ready (${look.detail})`,
        );
      }
    } catch (error) {
      problems.push(`${input.label}: ${(error as Error).message}`);
    }
  }
  return problems;
}

interface HealthcheckResult {
  healthy: boolean;
  consecutiveFailures: number;
}

/**
 * Run a healthcheck command after the `startPeriod` grace period. Polls at
 * `intervalSeconds`; after `retries` consecutive failures, marks unhealthy.
 * This is an initial post-readiness check — it runs the check once (after the
 * grace period) and reports the result. Continuous monitoring is out of scope
 * for the run lifecycle (services start once, specs run, services stop).
 */
async function runHealthcheck(
  cfg: Healthcheck,
  opts: SpawnOpts,
  ctx: StartServicesContext,
  label: string,
): Promise<HealthcheckResult> {
  const intervalMs = (cfg.intervalSeconds ?? DEFAULT_HC_INTERVAL_S) * 1000;
  const startPeriodMs = (cfg.startPeriodSeconds ?? 0) * 1000;
  const retries = cfg.retries ?? DEFAULT_HC_RETRIES;
  const timeoutMs = (cfg.timeoutSeconds ?? DEFAULT_HC_TIMEOUT_S) * 1000;

  // Wait for the start period before the first check.
  if (startPeriodMs > 0) {
    ctx.logDetail?.(
      `${label} — healthcheck waiting ${cfg.startPeriodSeconds ?? 0}s before first check`,
    );
    await sleepUnlessCancelled(startPeriodMs, ctx.signal);
  }

  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await sleepUnlessCancelled(intervalMs, ctx.signal);
    }
    ctx.logDetail?.(
      `${label} — healthcheck attempt ${attempt + 1}/${retries} (${cfg.command})`,
    );
    const r = await runShellWithTimeout(
      cfg.command,
      { ...opts, signal: ctx.signal, track: ctx.bootPids },
      timeoutMs,
    );
    if (r.exitCode === 0) {
      return { healthy: true, consecutiveFailures: 0 };
    }
    consecutiveFailures++;
    ctx.logDetail?.(
      `${label} — healthcheck attempt ${attempt + 1} failed (exit ${r.exitCode})`,
    );
  }

  return { healthy: false, consecutiveFailures };
}

/**
 * Line-buffered, redacted live output for one docker/seed command. Only
 * complete lines are redacted, so a secret split across chunks still matches.
 * `undefined` when the caller did not ask for live service output.
 */
function serviceOutput(
  ctx: StartServicesContext,
  source: "docker" | "seed" | "teardown" | "provisioner",
  redactor: ArtifactRedactor,
):
  | {
      announce(command: string): void;
      push(chunk: string): void;
      finish(exitCode: number): void;
    }
  | undefined {
  const sink = ctx.onServiceOutput;
  if (!sink) return undefined;
  const emitLine = (line: string): void => {
    try {
      sink(source, redactor.text(line));
    } catch {
      // A log sink failure must never fail the services lifecycle.
    }
  };
  const splitter = new LineSplitter(emitLine, { redact: redactor.text });
  return {
    announce: (command) => emitLine(`$ ${command}`),
    push: (chunk) => splitter.push(chunk),
    finish: (exitCode) => {
      splitter.flush();
      emitLine(`[exit ${exitCode}]`);
    },
  };
}

/**
 * Run a shell command with a timeout. Unlike `runShell` (which is fire-and-forget
 * for long-running servers), this waits for the command to complete and kills
 * it if it exceeds the timeout. Pass `timeoutMs <= 0` to wait indefinitely.
 * When `onChunk` is set, stdout/stderr chunks stream to it live (interactive
 * runs) instead of being captured silently.
 */
async function runShellWithTimeout(
  command: string,
  opts: SpawnOpts & {
    signal?: AbortSignal | undefined;
    /** Running pids (the signal path stops these trees before teardown). */
    track?: Set<number> | undefined;
  },
  timeoutMs: number,
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<ShellResult> {
  throwIfCancelled(opts.signal);
  // execa works identically under Bun and node. The `shell: true` option
  // gives us shell semantics (pipes, redirects, &&) for docker/seed commands.
  // timeoutMs <= 0 means wait indefinitely (no execa timeout).
  const child = execa(command, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string | undefined>,
    // opts.env is already the filtered target env; execa's default would
    // merge the parent's process.env (publisher/TinyVault credentials) back.
    extendEnv: false,
    shell: true,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });
  // Cancel: SIGKILL the shell's whole process tree (compose, the seed
  // importer, a readiness curl) instead of waiting out the timeout.
  const signal = opts.signal;
  let killedByCancel = false;
  const onAbort = (): void => {
    killedByCancel = true;
    killProcessTreeSync(child.pid);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const pid = child.pid;
  if (pid !== undefined) opts.track?.add(pid);
  try {
    const result = await collectShellResult(child, onChunk);
    if (killedByCancel) {
      throw new ServicesCancelledError(
        `services boot cancelled: killed ${command.slice(0, 80)}`,
      );
    }
    return result;
  } finally {
    if (pid !== undefined) opts.track?.delete(pid);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Await a shell child, streaming chunks to `onChunk` when given. */
async function collectShellResult(
  child: ReturnType<typeof execa>,
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<ShellResult> {
  // Stream live output when a callback is provided (interactive runs). We
  // accumulate ourselves so the returned stdout/stderr match what was streamed
  // even if execa's own collection behaves differently with extra listeners.
  if (onChunk && child.stdout && child.stderr) {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer | string) => {
      const s = typeof d === "string" ? d : d.toString();
      stdout += s;
      onChunk("stdout", s);
    });
    child.stderr.on("data", (d: Buffer | string) => {
      const s = typeof d === "string" ? d : d.toString();
      stderr += s;
      onChunk("stderr", s);
    });
    const r = await child;
    // Match execa's own capture (the non-streaming branch): one final
    // newline stripped.
    return {
      exitCode: r.exitCode ?? -1,
      stdout: stripFinalNewline(stdout),
      stderr: stripFinalNewline(stderr),
    };
  }

  const r = await child;
  return {
    exitCode: r.exitCode ?? -1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function stripFinalNewline(text: string): string {
  return text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
}

/* ===== F10: provisioner, tunnels, files, restart, supervision ===== */

const DEFAULT_PROVISIONER_UP_MS = 600_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;
const DEFAULT_RESTART_STOP_MS = 30_000;
const DEFAULT_RESTART_MAX = 5;
/** A restarted window that stays up this long has its failure streak reset. */
const SUPERVISOR_STABLE_MS = 30_000;
const DEFAULT_SUPERVISION_INTERVAL_MS = 2_000;

/** A request refused up front: nothing was changed (exit 4 in the CLI). */
export class ServicesRefusedError extends ServicesError {
  override name = "ServicesRefusedError";
}

/** The tunnel state key of a services context (project + env + config). */
export function tunnelKeyOf(
  ctx: Pick<
    StartServicesContext,
    "project" | "envName" | "configPath" | "configDir"
  >,
): string {
  return tunnelStateKey({
    project: ctx.project,
    env: ctx.envName,
    configPath: ctx.configPath,
    configDir: ctx.configDir,
  });
}

/* ----- provisioner ----- */

/**
 * `services.provisioner.up` + exports. The `down` entry is already in the
 * teardown list (see newPhaseState) and `provisionerUpStarted` is set BEFORE
 * `up` runs, so a failed or cancelled `up` is still torn down.
 */
async function startProvisioner(
  cfg: ProvisionerConfig,
  ctx: StartServicesContext,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  phases.provisioned = true;
  phases.provisionerUpStarted = true;
  phases.provisionerConfig = cfg;
  phases.provisionerRunning = true;
  try {
    await runProvisionerUp(cfg, ctx, phases, emit);
  } finally {
    phases.provisionerRunning = false;
  }
}

async function runProvisionerUp(
  cfg: ProvisionerConfig,
  ctx: StartServicesContext,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const up = typeof cfg.up === "string" ? { run: cfg.up } : cfg.up;
  const cwd = resolveCwd(cfg.cwd, ctx.configDir);
  const env = targetEnv(ctx, cfg.env);
  const redactor = createArtifactRedactor(undefined, env, ctx.secretValues);
  const timeout =
    toMs("timeout" in up ? up.timeout : undefined) ??
    toMs(cfg.timeout) ??
    DEFAULT_PROVISIONER_UP_MS;
  ctx.log?.(redactor.text(`provisioner — up (${up.run})`));
  emit("provisioner", "start", redactor.text(up.run));
  const live = serviceOutput(ctx, "provisioner", redactor);
  live?.announce(up.run);
  const r = await runShellWithTimeout(
    up.run,
    { cwd, env, signal: ctx.signal, track: ctx.bootPids },
    timeout,
    live ? (_stream, chunk) => live.push(chunk) : undefined,
  );
  live?.finish(r.exitCode);
  if (r.exitCode !== 0) {
    emit("provisioner", "fail", `up exit ${r.exitCode}`, {
      exitCode: r.exitCode,
    });
    throw new ServicesError(
      redactor.text(
        `provisioner up failed (exit ${r.exitCode}): ${up.run}\n` +
          tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
      ),
    );
  }
  let values: Record<string, string>;
  try {
    values = await runProvisionerExports(cfg, ctx, { cwd, env, redactor });
  } catch (error) {
    emit("provisioner", "fail", (error as Error).message, {
      reason: "exports",
    });
    throw error;
  }
  phases.provisionerExportsDone = true;
  applyProvisionerExports(ctx, phases, values);
  const names = Object.keys(values);
  ctx.log?.(
    `provisioner — up${
      names.length > 0 ? `, exported ${names.join(", ")}` : ""
    }`,
  );
  emit("provisioner", "ready", "provisioner up", { exports: names });
  if (names.length > 0) {
    // Names only: an export is a value the config never wrote down.
    emit("provisioner", "exports", `exported ${names.length} value(s)`, {
      names,
    });
  }
}

/**
 * The provisioner's `up` started but its exports were never evaluated (the
 * `up` failed, timed out or was cancelled): evaluate them once, best-effort
 * and bounded by each export's timeout, so the `down` gets the values that
 * name the resource. Never throws; a failure is logged and the `down` runs
 * without them.
 */
async function provisionerExportsForDown(
  phases: PhaseState,
  ctx: StartServicesContext,
): Promise<void> {
  const cfg = phases.provisionerConfig;
  if (
    !cfg?.exports ||
    !phases.provisionerUpStarted ||
    phases.provisionerExportsDone
  ) {
    return;
  }
  phases.provisionerExportsDone = true;
  // Not the boot's signal: a cancelled boot still tears down.
  const evalCtx: StartServicesContext = { ...ctx, bootPids: new Set() };
  delete evalCtx.signal;
  try {
    const values = await runProvisionerExports(cfg, evalCtx, {
      cwd: resolveCwd(cfg.cwd, ctx.configDir),
      env: targetEnv(ctx, cfg.env),
      redactor: phases.artifactRedactor,
    });
    applyProvisionerExports(ctx, phases, values);
    ctx.log?.(
      `provisioner — exports evaluated for the down command (${Object.keys(values).join(", ")})`,
    );
  } catch (error) {
    ctx.log?.(
      phases.artifactRedactor.text(
        `provisioner exports could not be evaluated for the down command: ${(error as Error).message.split("\n")[0]}`,
      ),
    );
  }
}

/**
 * The signal path's copy of {@link provisionerExportsForDown}: synchronous,
 * each export capped at the signal teardown cap.
 */
function provisionerExportsForDownSync(
  phases: PhaseState,
  ctx: StartServicesContext,
  capMs: number,
  note: (line: string) => void,
): void {
  const cfg = phases.provisionerConfig;
  if (
    !cfg?.exports ||
    !phases.provisionerUpStarted ||
    phases.provisionerExportsDone
  ) {
    return;
  }
  phases.provisionerExportsDone = true;
  const cwd = resolveCwd(cfg.cwd, ctx.configDir);
  const env = targetEnv(ctx, cfg.env);
  const values: Record<string, string> = {};
  for (const [name, entry] of Object.entries(cfg.exports)) {
    const command = typeof entry === "string" ? entry : entry.run;
    const timeout = Math.min(
      toMs(typeof entry === "string" ? undefined : entry.timeout) ??
        DEFAULT_EXPORT_TIMEOUT_MS,
      capMs,
    );
    const r = spawnSync(command, {
      cwd,
      env: { ...env, ...values },
      shell: true,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = String(r.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (r.status !== 0 || lines.length !== 1) {
      note(
        `provisioner export ${name} could not be evaluated for the down command; it runs without the rest`,
      );
      break;
    }
    values[name] = lines[0]!;
  }
  applyProvisionerExports(ctx, phases, values);
}

/** Run each export command in order; one value (one line) each. */
async function runProvisionerExports(
  cfg: ProvisionerConfig,
  ctx: StartServicesContext,
  input: { cwd: string; env: NodeJS.ProcessEnv; redactor: ArtifactRedactor },
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [name, entry] of Object.entries(cfg.exports ?? {})) {
    const command = typeof entry === "string" ? entry : entry.run;
    const timeout =
      toMs(typeof entry === "string" ? undefined : entry.timeout) ??
      DEFAULT_EXPORT_TIMEOUT_MS;
    const r = await runShellWithTimeout(
      command,
      {
        cwd: input.cwd,
        env: { ...input.env, ...values },
        signal: ctx.signal,
        track: ctx.bootPids,
      },
      timeout,
    );
    if (r.exitCode !== 0) {
      throw new ServicesError(
        input.redactor.text(
          `provisioner export ${name} failed (exit ${r.exitCode}): ${command}\n${tailText(
            r.stderr || r.stdout,
            10,
          )}`,
        ),
      );
    }
    const lines = r.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length !== 1) {
      throw new ServicesError(
        `provisioner export ${name}: the command printed ${
          lines.length === 0 ? "nothing" : `${lines.length} lines`
        }; it must print exactly one value`,
      );
    }
    values[name] = lines[0]!;
  }
  return values;
}

/**
 * Hand exported values to every later phase (ctx.env), keep them out of
 * artifacts (a credential-named export is registered for redaction) and
 * remember them for the run engine.
 */
function applyProvisionerExports(
  ctx: StartServicesContext,
  phases: PhaseState,
  values: Record<string, string>,
): void {
  if (Object.keys(values).length === 0) return;
  const sensitive = Object.entries(values)
    .filter(([name]) => isSensitiveEnvKey(name))
    .map(([, value]) => value);
  registerSecretValues(sensitive);
  ctx.secretValues = [...(ctx.secretValues ?? []), ...sensitive];
  ctx.env = { ...(ctx.env ?? process.env), ...values };
  Object.assign(phases.exportedEnv, values);
  phases.artifactRedactor = createArtifactRedactor(
    undefined,
    ctx.env,
    ctx.secretValues,
  );
}

/**
 * Re-evaluate the exports of a provisioner owned by `cairn services up`
 * (`--reuse-services`): nothing is created, the export commands just print
 * their values again.
 */
export async function evaluateProvisionerExports(
  cfg: ServicesConfig,
  ctx: StartServicesContext,
): Promise<Record<string, string>> {
  if (!cfg.provisioner?.exports) return {};
  const cwd = resolveCwd(cfg.provisioner.cwd, ctx.configDir);
  const env = targetEnv(ctx, cfg.provisioner.env);
  const redactor = createArtifactRedactor(undefined, env, ctx.secretValues);
  const values = await runProvisionerExports(cfg.provisioner, ctx, {
    cwd,
    env,
    redactor,
  });
  const sensitive = Object.entries(values)
    .filter(([name]) => isSensitiveEnvKey(name))
    .map(([, value]) => value);
  registerSecretValues(sensitive);
  return values;
}

/* ----- tunnels ----- */

async function startTunnels(
  tunnels: readonly TunnelConfig[],
  ctx: StartServicesContext,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const stateRoot = ctx.stateRoot ?? servicesStateRoot();
  const set = new TunnelSet(tunnels, {
    project: tunnelKeyOf(ctx),
    stateRoot,
    logRoot: ctx.serviceLogRoot ?? stateRoot,
    envFor: (tunnel) => targetEnv(ctx, tunnel.env),
    cwdFor: (tunnel) => resolveCwd(tunnel.cwd, ctx.configDir),
    emit: (event, message, data) => emit("tunnel", event, message, data),
    log: (message) => ctx.log?.(phases.artifactRedactor.text(message)),
    warn: (message) =>
      readinessWarn(ctx)(phases.artifactRedactor.text(message)),
    redact: (text) => phases.artifactRedactor.text(text),
    supervise: ctx.supervise !== false,
    waitReady: async (tunnel) => {
      const refs = gateRefList(tunnel.ready);
      if (refs.length === 0) return;
      const gateCtx = await serviceGateContext(ctx, {
        scope: "services.tunnel",
        label: `tunnel/${tunnel.name}`,
        env: targetEnv(ctx, tunnel.env),
        cwd: resolveCwd(tunnel.cwd, ctx.configDir),
        defaultTimeoutMs: toMs(tunnel.readyTimeout) ?? 60_000,
      });
      await waitServiceGates(refs, gateCtx, `tunnel/${tunnel.name}`, ctx);
    },
  });
  // Registered before the start: a tunnel that fails (or a later phase that
  // fails) still has every spawned tunnel stopped by the cleanup.
  phases.tunnels = set;
  ctx.log?.(`tunnels — starting ${tunnels.map((t) => t.name).join(", ")}`);
  try {
    await set.start();
  } catch (error) {
    throw new ServicesError((error as Error).message);
  }
}

/* ----- files ----- */

async function applyServicesFiles(
  files: NonNullable<ServicesConfig["files"]>,
  tmux: TmuxConfig | undefined,
  ctx: StartServicesContext,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const env = targetEnv(ctx);
  for (const file of files) {
    try {
      const r = await applyServiceFile(file, {
        configDir: ctx.configDir,
        env,
        exports: phases.exportedEnv,
      });
      emit(
        "files",
        r.changed ? "write" : "unchanged",
        `${file.path} ${r.changed ? "written" : "unchanged"}`,
        {
          path: file.path,
          changed: r.changed,
          existed: r.existed,
          ...(r.before
            ? { before: r.before.sha, beforeBytes: r.before.bytes }
            : {}),
          after: r.after.sha,
          afterBytes: r.after.bytes,
          ...(file.restart ? { restart: file.restart } : {}),
        },
      );
      ctx.log?.(
        `files — ${file.path} ${
          r.changed ? "updated" : "unchanged"
        } (${r.after.sha})`,
      );
      if (r.changed) {
        for (const window of file.restart ?? []) {
          if (!tmux) {
            ctx.log?.(
              `files — ${file.path} asks to restart "${window}", but no tmux session is configured`,
            );
            continue;
          }
          phases.restartAfterBoot.add(window);
        }
      }
    } catch (error) {
      emit("files", "fail", `${file.path} failed`, { path: file.path });
      throw error instanceof ServiceFileError
        ? new ServicesError(error.message)
        : error;
    }
  }
}

/** After the tmux phase: restart windows a changed file named that were already live. */
async function restartWindowsAfterFiles(
  tmux: TmuxConfig,
  ctx: StartServicesContext,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const wanted = [...phases.restartAfterBoot].filter(
    (name) => !phases.launchedWindows.has(name),
  );
  if (wanted.length === 0) return;
  const report = await restartTmuxWindows(tmux, ctx, wanted, {
    emit,
    reason: "files",
  });
  const failed = report.results.find((result) => !result.ok);
  if (failed) {
    throw new ServicesError(
      `restarting window "${failed.window}" after a services.files change failed: ${failed.error ?? "unknown error"}`,
    );
  }
}

/* ----- restart ----- */

export interface RestartWindowsOptions {
  /** Wait for the old process to exit after Ctrl-C (default 30000). */
  stopTimeoutMs?: number;
  /** Wait for readiness of the new process (default tmux readyTimeoutMs, else 90000). */
  readyTimeoutMs?: number;
  /** Why (event data): `manual`, `exited`, `unhealthy`, `files`. */
  reason?: string;
  /** Event sink; default: ctx.onEvent. */
  emit?: EmitFn;
}

export interface WindowRestartResult {
  window: string;
  ok: boolean;
  /** The pane was already at an idle shell: nothing to stop. */
  alreadyStopped: boolean;
  /** Restart generation id (the marker printed into the pane). */
  generation?: string;
  durationMs: number;
  error?: string;
  /** Not attempted: an earlier window failed. */
  skipped?: boolean;
}

export interface RestartWindowsReport {
  session: string;
  results: WindowRestartResult[];
  events: ServicesEvent[];
}

/**
 * Restart tmux windows of the configured session, one after the other:
 * Ctrl-C, wait for the pane's process to exit (never a hard kill), clear the
 * history, print a generation marker, resend the window's command (env,
 * preCommands, command) and wait for `readyOn` of the NEW generation — text
 * is read only below the marker, so stale scrollback never counts.
 *
 * Refuses (ServicesRefusedError, nothing touched) when the session is not
 * running, a name is not a window of the configured session, or the window is
 * missing from the live session. A runtime failure stops the sequence and is
 * reported per window.
 */
export async function restartTmuxWindows(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  names: readonly string[],
  opts: RestartWindowsOptions = {},
): Promise<RestartWindowsReport> {
  const events: ServicesEvent[] = [];
  const emit: EmitFn =
    opts.emit ??
    ((phase, event, message, data) => {
      const e: ServicesEvent = {
        phase,
        event,
        message,
        timestamp: new Date().toISOString(),
        ...(data ? { data } : {}),
      };
      events.push(e);
      ctx.onEvent?.(e);
    });
  const unique = [...new Set(names)];
  if (unique.length === 0) {
    throw new ServicesRefusedError("name at least one window to restart");
  }
  const configured = new Map(cfg.windows.map((w) => [w.name, w]));
  for (const name of unique) {
    if (!configured.has(name)) {
      throw new ServicesRefusedError(
        `"${name}" is not a window of the configured tmux session "${cfg.session}" (configured: ${[
          ...configured.keys(),
        ].join(", ")}); cairn only restarts windows it owns`,
      );
    }
  }
  if (!(await tmuxSessionExists(cfg.session))) {
    throw new ServicesRefusedError(
      `tmux session "${cfg.session}" is not running; start the services first (cairn services up)`,
    );
  }
  for (const name of unique) {
    if (!(await tmuxWindowExists(cfg.session, name))) {
      throw new ServicesRefusedError(
        `window "${name}" is missing from the running session "${cfg.session}"; cairn services up recreates it`,
      );
    }
  }
  const results: WindowRestartResult[] = [];
  let stopped = false;
  for (const name of unique) {
    if (stopped) {
      results.push({
        window: name,
        ok: false,
        alreadyStopped: false,
        durationMs: 0,
        skipped: true,
      });
      continue;
    }
    const result = await restartOneWindow(
      cfg,
      configured.get(name)!,
      ctx,
      emit,
      opts,
    );
    results.push(result);
    if (!result.ok) stopped = true;
  }
  return { session: cfg.session, results, events };
}

async function restartOneWindow(
  cfg: TmuxConfig,
  win: TmuxWindow,
  ctx: StartServicesContext,
  emit: EmitFn,
  opts: RestartWindowsOptions,
): Promise<WindowRestartResult> {
  const session = cfg.session;
  const target = tmuxWindowTarget(session, win.name);
  const startedAt = Date.now();
  const reason = opts.reason ?? "manual";
  const generation = newGenerationId();
  let alreadyStopped = false;
  const fail = (why: string, message: string): WindowRestartResult => {
    emit("restart", "fail", `"${win.name}" restart failed`, {
      window: win.name,
      reason,
      why,
    });
    return {
      window: win.name,
      ok: false,
      alreadyStopped: false,
      generation,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  };
  emit("restart", "start", `restarting "${win.name}"`, {
    window: win.name,
    reason,
  });
  try {
    // 1. Graceful stop: Ctrl-C (again at 40% of the budget), then wait for
    // the pane to return to an idle shell. Never a hard kill.
    const stopBudget = opts.stopTimeoutMs ?? DEFAULT_RESTART_STOP_MS;
    alreadyStopped = await isTmuxPaneIdleShell(session, win.name);
    if (!alreadyStopped) {
      const sendInterrupt = async (): Promise<void> => {
        await execa("tmux", ["send-keys", "-t", target, "C-c"], {
          reject: false,
          timeout: 5_000,
        });
      };
      await sendInterrupt();
      const stopStart = Date.now();
      let second = false;
      while (!(await isTmuxPaneIdleShell(session, win.name))) {
        const waited = Date.now() - stopStart;
        if (waited >= stopBudget) {
          return fail(
            "stop-timeout",
            `"${win.name}" did not exit within ${formatBudget(stopBudget)} after Ctrl-C (the process ignores it; stop it by hand or raise --stop-timeout)`,
          );
        }
        if (!second && waited >= stopBudget * 0.4) {
          second = true;
          await sendInterrupt();
        }
        await sleepUnlessCancelled(300, ctx.signal);
      }
      emit("restart", "stop", `"${win.name}" stopped`, {
        window: win.name,
        graceful: true,
        durationMs: Date.now() - stopStart,
      });
    }
    // 2. A clean pane and a generation marker below which only the new
    // process' output will appear.
    await waitForTmuxShellReady(session, win.name, ctx);
    await clearTmuxHistory(session, win.name);
    await sendTmuxCommand(
      session,
      win.name,
      generationMarkerCommand(generation),
    );
    const markerDeadline = Date.now() + 10_000;
    for (;;) {
      const pane = await captureTmuxPane(session, win.name, 200);
      if (
        pane
          .split("\n")
          .some((line) => line.trim() === generationMarker(generation))
      ) {
        break;
      }
      if (Date.now() >= markerDeadline) {
        return fail("marker", `"${win.name}": the pane did not accept input`);
      }
      await sleepUnlessCancelled(200, ctx.signal);
    }
    // 3. Resend env, preCommands and the command.
    ctx.launchedWindows?.add(win.name);
    await sendWindowCommands(session, win, ctx);
    // 4. Readiness of the new generation.
    if (win.readyOn) {
      const readyMs =
        opts.readyTimeoutMs ?? cfg.readyTimeoutMs ?? DEFAULT_TMUX_READY_MS;
      const deadline =
        readyMs > 0 ? Date.now() + readyMs : Number.POSITIVE_INFINITY;
      const gate = await tmuxReadyOnGate(cfg, win, ctx);
      const warn = readinessWarn(ctx);
      try {
        await waitForTmuxWindow(session, win, deadline, {
          ...(gate ? { gate } : {}),
          generation,
          signal: ctx.signal,
          onUrlStatus: (url, status) => warnLegacyReadiness(url, status, warn),
        });
      } catch (error) {
        gate?.watch.finish(false, { timedOut: Date.now() >= deadline });
        return fail(
          error instanceof TmuxTerminalReadinessError
            ? error.reason
            : "ready-timeout",
          (error as Error).message,
        );
      }
    }
  } catch (error) {
    if (error instanceof ServicesCancelledError) throw error;
    return fail("error", (error as Error).message);
  }
  const durationMs = Date.now() - startedAt;
  emit("restart", "ready", `"${win.name}" restarted`, {
    window: win.name,
    reason,
    generation,
    durationMs,
  });
  return {
    window: win.name,
    ok: true,
    alreadyStopped,
    generation,
    durationMs,
  };
}

/* ----- supervision ----- */

interface SupervisedWindow {
  /** Consecutive failed-or-short-lived runs since the last stable one. */
  consecutive: number;
  lastRestartAt: number | undefined;
  nextRestartAt: number | undefined;
  pendingReason: "exited" | "unhealthy" | undefined;
  restarting: boolean;
  gaveUp: boolean;
  nextHealthAt: number | undefined;
  healthFailures: number;
  unhealthy: boolean;
}

/**
 * While a run is active: restart windows whose process exited
 * (`restart.policy: on-exit`) and react to `healthcheck.onUnhealthy`.
 * Polls every 2s; each restart waits `restart.backoff` and the window is
 * given up on after `restart.max` consecutive failures. Stopped before any
 * teardown, so nothing restarts while the stack comes down.
 */
class WindowSupervisor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly windows: TmuxWindow[];
  private readonly states = new Map<string, SupervisedWindow>();

  constructor(
    private readonly cfg: TmuxConfig,
    private readonly ctx: StartServicesContext,
    private readonly phases: PhaseState,
    private readonly emit: EmitFn,
  ) {
    this.windows = cfg.windows.filter(
      (win) =>
        win.restart?.policy === "on-exit" ||
        win.healthcheck?.onUnhealthy !== undefined,
    );
    const onCancel = (): void => this.abort.abort();
    ctx.signal?.addEventListener("abort", onCancel, { once: true });
  }

  hasWork(): boolean {
    return this.windows.length > 0;
  }

  start(): void {
    // Another process' `services restart` refuses while this one supervises.
    writeSupervisorMarker(
      this.ctx.stateRoot ?? servicesStateRoot(),
      this.cfg.session,
      this.windows.map((win) => win.name),
    );
    const everyMs =
      this.ctx.supervisionIntervalMs ?? DEFAULT_SUPERVISION_INTERVAL_MS;
    this.timer = setInterval(() => {
      if (this.inflight || this.stopped) return;
      this.inflight = this.tick()
        .catch(() => undefined)
        .finally(() => {
          this.inflight = undefined;
        });
    }, everyMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopSync();
    await this.inflight?.catch(() => undefined);
  }

  stopSync(): void {
    const first = !this.stopped;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    if (first) {
      try {
        removeSupervisorMarker(
          this.ctx.stateRoot ?? servicesStateRoot(),
          this.cfg.session,
        );
      } catch {
        // best-effort, also on the signal path
      }
    }
  }

  private stateOf(win: TmuxWindow): SupervisedWindow {
    let state = this.states.get(win.name);
    if (!state) {
      state = {
        consecutive: 0,
        lastRestartAt: undefined,
        nextRestartAt: undefined,
        pendingReason: undefined,
        restarting: false,
        gaveUp: false,
        nextHealthAt: undefined,
        healthFailures: 0,
        unhealthy: false,
      };
      this.states.set(win.name, state);
    }
    return state;
  }

  private async tick(): Promise<void> {
    for (const win of this.windows) {
      if (this.stopped) return;
      const state = this.stateOf(win);
      if (state.gaveUp || state.restarting) continue;
      // A restart waiting out its backoff.
      if (state.nextRestartAt !== undefined) {
        if (Date.now() >= state.nextRestartAt) {
          await this.restart(win, state, state.pendingReason ?? "exited");
        }
        continue;
      }
      if (win.restart?.policy === "on-exit")
        await this.superviseExit(win, state);
      if (this.stopped || state.gaveUp || state.restarting) continue;
      if (win.healthcheck?.onUnhealthy !== undefined) {
        await this.superviseHealth(win, state);
      }
    }
  }

  private async superviseExit(
    win: TmuxWindow,
    state: SupervisedWindow,
  ): Promise<void> {
    const pane = await inspectTmuxPaneForReadiness(this.cfg.session, win.name);
    if (pane.kind !== "idle-shell") return;
    this.schedule(win, state, "exited");
  }

  /** Count a failure; schedule the restart after its backoff, or give up. */
  private schedule(
    win: TmuxWindow,
    state: SupervisedWindow,
    reason: "exited" | "unhealthy",
  ): void {
    const now = Date.now();
    const sinceLast =
      state.lastRestartAt === undefined
        ? Number.POSITIVE_INFINITY
        : now - state.lastRestartAt;
    state.consecutive =
      sinceLast >= SUPERVISOR_STABLE_MS ? 1 : state.consecutive + 1;
    const max = win.restart?.max ?? DEFAULT_RESTART_MAX;
    if (state.consecutive > max) {
      state.gaveUp = true;
      this.emit(
        "restart",
        "giveup",
        `"${win.name}" gave up after ${max} restarts`,
        {
          window: win.name,
          reason,
          restarts: max,
        },
      );
      readinessWarn(this.ctx)(
        `tmux window "${win.name}" gave up after ${max} consecutive restarts (${reason})`,
      );
      return;
    }
    const delayMs = backoffDelayMs(
      resolveBackoff(win.restart?.backoff),
      state.consecutive,
    );
    state.nextRestartAt = now + delayMs;
    state.pendingReason = reason;
    this.ctx.log?.(
      `tmux — "${win.name}" ${
        reason === "exited" ? "exited" : "is unhealthy"
      }; restarting in ${delayMs}ms (${state.consecutive}/${max})`,
    );
  }

  private async restart(
    win: TmuxWindow,
    state: SupervisedWindow,
    reason: "exited" | "unhealthy",
  ): Promise<void> {
    state.restarting = true;
    state.nextRestartAt = undefined;
    state.pendingReason = undefined;
    try {
      const ctx: StartServicesContext = {
        ...this.ctx,
        signal: this.abort.signal,
      };
      const report = await restartTmuxWindows(this.cfg, ctx, [win.name], {
        emit: this.emit,
        reason,
      });
      if (!report.results[0]?.ok) {
        readinessWarn(this.ctx)(
          `tmux window "${win.name}" restart failed: ${report.results[0]?.error ?? "unknown error"}`,
        );
      }
    } catch (error) {
      if (!(error instanceof ServicesCancelledError)) {
        readinessWarn(this.ctx)(
          `tmux window "${win.name}" could not restart: ${(error as Error).message}`,
        );
      }
    } finally {
      state.lastRestartAt = Date.now();
      state.restarting = false;
      state.healthFailures = 0;
      state.unhealthy = false;
      state.nextHealthAt = undefined;
    }
  }

  private async superviseHealth(
    win: TmuxWindow,
    state: SupervisedWindow,
  ): Promise<void> {
    const hc = win.healthcheck!;
    const now = Date.now();
    if (state.nextHealthAt === undefined) {
      state.nextHealthAt = now + (hc.startPeriodSeconds ?? 0) * 1000;
    }
    if (now < state.nextHealthAt) return;
    state.nextHealthAt =
      now + (hc.intervalSeconds ?? DEFAULT_HC_INTERVAL_S) * 1000;
    const r = await runShellWithTimeout(
      hc.command,
      {
        cwd: resolveCwd(win.cwd, this.ctx.configDir),
        env: targetEnv(this.ctx, { ...this.cfg.env, ...win.env }),
        signal: this.abort.signal,
      },
      (hc.timeoutSeconds ?? DEFAULT_HC_TIMEOUT_S) * 1000,
    ).catch(() => undefined);
    if (!r) return;
    if (r.exitCode === 0) {
      if (state.unhealthy) {
        state.unhealthy = false;
        this.ctx.log?.(`tmux/${win.name} — healthcheck recovered`);
        this.emit("tmux", "healthcheck", `healthy: ${win.name}`, {
          window: win.name,
          healthy: true,
        });
      }
      state.healthFailures = 0;
      return;
    }
    state.healthFailures += 1;
    if (state.healthFailures < (hc.retries ?? DEFAULT_HC_RETRIES)) return;
    if (!state.unhealthy) {
      state.unhealthy = true;
      readinessWarn(this.ctx)(
        `tmux/${win.name} — healthcheck WARNING: unhealthy after ${state.healthFailures} failures`,
      );
      this.emit("tmux", "healthcheck", `unhealthy: ${win.name}`, {
        window: win.name,
        healthy: false,
        consecutiveFailures: state.healthFailures,
      });
    }
    if (hc.onUnhealthy === "restart") this.schedule(win, state, "unhealthy");
  }
}
