import { execa } from "execa";
import { createWriteStream, mkdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  DockerConfig,
  Healthcheck,
  SeedConfig,
  ServicesConfig,
  ServicesStashConfig,
  TmuxConfig,
  TmuxSessionOption,
  TmuxWindow,
} from "../schema/config.v1";
import {
  isTruthyEnv,
  probeOnce,
  runShell,
  sleep,
  type ShellResult,
  type SpawnOpts,
} from "./webServer";
import { SeedStateStore } from "./seedState";
import { createArtifactRedactor } from "../artifacts/redaction";
import { targetChildEnvWithSelectedTvaultKeys } from "../processEnv";

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
  /** Optional structured lifecycle event collector (for events.ndjson). */
  onEvent?: (event: ServicesEvent) => void;
  /**
   * Invoked once, the instant a long-lived process is spawned (docker or tmux),
   * with a synchronous teardown bound to it. Lets the caller register
   * signal-time cleanup for the whole boot window.
   */
  onSpawn?: (terminateSync: () => void) => void;
}

export interface ServicesHandle {
  /** True when cairn started at least one phase (owns teardown). */
  startedByUs: boolean;
  /** Structured lifecycle events collected during startServices(). */
  events: ServicesEvent[];
  /** Run teardown commands (best-effort) then stop services. No-op when reused. */
  stop(): Promise<void>;
  /** Synchronous teardown for the signal path (Ctrl-C). No-op when reused. */
  terminateSync(): void;
}

/** Thrown for every services lifecycle failure; run.ts maps it to exit 2. */
export class ServicesError extends Error {
  override name = "ServicesError";
}

/** A structured lifecycle event emitted at each phase boundary. */
export interface ServicesEvent {
  /** Phase: docker, seed, tmux, teardown, stash */
  phase: "docker" | "seed" | "tmux" | "teardown" | "stash";
  /** Event type: start, reuse, skip, ready, fail, healthcheck, complete. */
  event: string;
  /** Human-readable message. */
  message: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Optional structured data (window name, exit code, etc.). */
  data?: Record<string, unknown>;
}

const DEFAULT_DOCKER_TIMEOUT_MS = 120_000;
const DEFAULT_SEED_TIMEOUT_MS = 300_000;
const DEFAULT_TMUX_READY_MS = 90_000;
const POLL_MS = 500;
const TMUX_STALL_INTERVAL_MS = 5_000;
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
/** Interactive shells that mean "service is not running in this pane". */
const TMUX_IDLE_SHELL_RE =
  /^(zsh|bash|fish|sh|dash|ksh|tcsh|csh|-zsh|-bash|-fish)$/i;

function targetEnv(
  ctx: StartServicesContext,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return targetChildEnvWithSelectedTvaultKeys(
    { ...(ctx.env ?? process.env), ...overrides },
    ctx.selectedTvaultKeys ?? [],
  );
}

/**
 * Start the full services lifecycle. Each phase is optional — only the
 * configured phases run. Returns a handle for teardown tracking.
 */
export async function startServices(
  cfg: ServicesConfig,
  ctx: StartServicesContext,
): Promise<ServicesHandle> {
  const coldStart = ctx.coldStart ?? isTruthyEnv(process.env.CI);
  const phases: PhaseState = {
    dockerStarted: false,
    dockerRefreshed: false,
    tmuxSession: undefined,
    tmuxSessionName: undefined,
    tmuxReuse: false,
    teardownCommands: cfg.teardown ?? [],
    artifactsDir: undefined,
    artifacts: [],
    events: [],
  };

  const emit = (
    phase: ServicesEvent["phase"],
    event: string,
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
  ctx.onSpawn?.(() => {
    terminateServicesSync(phases, ctx.configDir);
  });

  try {
    // Phase 1: Docker
    if (cfg.docker) {
      await startDocker(cfg.docker, ctx, coldStart, phases, emit);
    }

    // Phase 2: Conditional seed
    if (cfg.seed) {
      await startSeed(cfg.seed, ctx, emit);
    }

    // Phase 3: tmux
    if (cfg.tmux) {
      await startTmux(cfg.tmux, ctx, coldStart, phases, emit);
    }
  } catch (e) {
    // A later phase failed after an earlier one already started. Tear down
    // what we started so we don't orphan tmux dev-servers or docker
    // containers, then propagate. The caller untracks the signal-time hook on
    // throw, so cleanup MUST happen here — the returned handle never exists.
    emit("teardown", "failure-cleanup", (e as Error).message);
    await teardownStartedPhases(cfg, phases, ctx).catch(() => undefined);
    throw e;
  }

  const startedByUs = phases.dockerStarted || phases.tmuxSession !== undefined;

  return {
    startedByUs,
    /** Structured lifecycle events collected during startServices. */
    events: phases.events,
    stop: async () => {
      // Capture tmux pane output before tearing down (if stashing is enabled).
      if (phases.artifactsDir && phases.tmuxSession && cfg.stash?.enabled) {
        await captureSessionArtifacts(cfg, phases, ctx);
      }

      // Teardown commands from config (best-effort). When the tmux session is
      // in reuse mode, cairn OWNS its lifecycle (leaves it alive for the next
      // run) — so skip any teardown command that would kill that session, and
      // also skip docker-compose-down style commands: the live tmux services
      // depend on that infra (mongo/rabbit/postgres). Killing docker while
      // leaving tmux alive is what orphaned Go/Node panes against dead ports.
      const managedSession = phases.tmuxSessionName;
      for (const cmd of phases.teardownCommands) {
        if (
          phases.tmuxReuse &&
          managedSession &&
          killsTmuxSession(cmd, managedSession)
        ) {
          ctx.log?.(
            `teardown (skipped tmux kill for reuse — leaving "${managedSession}" alive)`,
          );
          continue;
        }
        if (phases.tmuxReuse && tearsDownDocker(cmd)) {
          ctx.log?.(
            `teardown (skipped docker down for reuse — tmux services still need infra)`,
          );
          continue;
        }
        try {
          ctx.log?.(`teardown (${cmd})`);
          await runShell(cmd, {
            cwd: ctx.configDir,
            env: targetEnv(ctx),
          });
        } catch {
          // teardown is best-effort, never fatal
        }
      }
      // Kill the tmux session only when we created it AND we're not reusing
      // (reuse mode leaves it alive for the next run to reuse — no rebuild).
      if (phases.tmuxSession && !phases.tmuxReuse) {
        try {
          await execa("tmux", ["kill-session", "-t", phases.tmuxSession], {
            reject: false,
            timeout: 5_000,
          });
        } catch {
          // best-effort
        }
      }

      // Stash artifacts to fcheap if configured.
      if (
        phases.artifactsDir &&
        cfg.stash?.enabled &&
        phases.artifacts.length > 0
      ) {
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
      terminateServicesSync(phases, ctx.configDir);
    },
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
  cfg: ServicesConfig,
  phases: PhaseState,
  ctx: StartServicesContext,
): Promise<void> {
  const managedSession = phases.tmuxSessionName;
  for (const cmd of phases.teardownCommands) {
    if (
      phases.tmuxReuse &&
      managedSession &&
      killsTmuxSession(cmd, managedSession)
    ) {
      ctx.log?.(
        `failure-cleanup (skipped tmux kill for reuse — leaving "${managedSession}" alive)`,
      );
      continue;
    }
    if (phases.tmuxReuse && tearsDownDocker(cmd)) {
      ctx.log?.(
        `failure-cleanup (skipped docker down for reuse — tmux services still need infra)`,
      );
      continue;
    }
    try {
      ctx.log?.(`teardown (${cmd})`);
      await runShell(cmd, {
        cwd: ctx.configDir,
        env: targetEnv(ctx),
      });
    } catch {
      // teardown is best-effort, never fatal
    }
  }
  if (phases.tmuxSession && !phases.tmuxReuse) {
    await execa("tmux", ["kill-session", "-t", phases.tmuxSession], {
      reject: false,
      timeout: 5_000,
    }).catch(() => undefined);
  }
  if (phases.artifactsDir) {
    await rm(phases.artifactsDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/* ----- phase state ----- */

interface PhaseState {
  dockerStarted: boolean;
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
  /** Whether the tmux session is in reuse mode (leave alive at end-of-run). */
  tmuxReuse: boolean;
  teardownCommands: string[];
  /** Captured artifacts for fcheap stashing (tmux captures, docker logs, seed output). */
  artifactsDir: string | undefined;
  artifacts: { phase: string; file: string; label: string }[];
  /** Structured lifecycle events collected during startServices. */
  events: ServicesEvent[];
}

/** Emit callback type used by all phases. */
type EmitFn = (
  phase: ServicesEvent["phase"],
  event: string,
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
  const timeout = cfg.readyTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  // Snapshot before any compose command so cold-start re-runs of
  // `compose up` against already-running containers don't look like a refresh.
  const wasRunning = await dockerComposeRunning(cwd);

  // Reuse check: is docker compose already reporting running containers?
  if (reuse && wasRunning) {
    ctx.log?.("services: docker — reusing running containers");
    emit("docker", "reuse", "reusing running containers");
    return;
  }

  ctx.log?.(`docker (${cfg.command})`);
  emit("docker", "start", cfg.command);
  const onChunk = ctx.onOutput
    ? (_s: "stdout" | "stderr", chunk: string) => ctx.onOutput!(chunk)
    : undefined;
  const r = await runShellWithTimeout(
    cfg.command,
    { cwd, env },
    timeout,
    onChunk,
  );
  if (r.exitCode !== 0) {
    emit("docker", "fail", `exit ${r.exitCode}`, { exitCode: r.exitCode });
    throw new ServicesError(
      `docker command failed (exit ${r.exitCode}): ${cfg.command}\n` +
        tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
    );
  }

  // Optional readiness check: a command whose exit 0 means infra is ready.
  if (cfg.readinessCheck) {
    ctx.logDetail?.(`docker — readiness check (${cfg.readinessCheck})`);
    emit("docker", "readiness-check", cfg.readinessCheck);
    const rc = await runShellWithTimeout(
      cfg.readinessCheck,
      { cwd, env },
      timeout,
    );
    if (rc.exitCode !== 0) {
      emit("docker", "fail", `readiness check exit ${rc.exitCode}`, {
        exitCode: rc.exitCode,
      });
      throw new ServicesError(
        `docker readiness check failed (exit ${rc.exitCode}): ${cfg.readinessCheck}\n` +
          tailText(`${rc.stdout}\n${rc.stderr}`, SHELL_TAIL_LINES),
      );
    }
  }

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
    const stdout = r.stdout.trim();
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
  } catch {
    return false;
  }
}

/* ----- Phase 2: Conditional seed ----- */

async function startSeed(
  cfg: SeedConfig,
  ctx: StartServicesContext,
  emit: EmitFn,
): Promise<void> {
  const store = new SeedStateStore();
  const state = await store.read(ctx.project);
  const check = store.checkFreshness(ctx.project, cfg, state);
  const cwd = resolveCwd(cfg.cwd, ctx.configDir);
  const env = await resolveSeedEnv(cfg, ctx);
  const redactor = createArtifactRedactor(undefined, env, ctx.secretValues);
  const timeout = cfg.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;

  if (!check.shouldRun) {
    ctx.log?.(redactor.text(`seed — skipping (${check.reason})`));
    emit("seed", "skip", check.reason);
    await runSeedPostCommands(cfg, { cwd, env, timeout }, ctx, emit);
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
      { cwd, env },
      timeout,
    );
    if (fr.exitCode === 0) {
      ctx.log?.("services: seed — freshness check passed, skipping");
      emit("seed", "skip", "freshness check passed");
      // Still record the freshness check as a successful "non-seed" so the
      // timestamp is updated for the next TTL window.
      await store.recordRun(ctx.project, cfg, 0);
      await runSeedPostCommands(cfg, { cwd, env, timeout }, ctx, emit);
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

  ctx.log?.(redactor.text(`seed — running (${cfg.command})`));
  emit("seed", "start", redactor.text(cfg.command));
  const r = await runShellWithTimeout(cfg.command, { cwd, env }, timeout);
  // Redact the complete stream before forwarding it. Redacting individual
  // chunks could expose a value split across chunk boundaries.
  if (ctx.onOutput) {
    if (r.stdout) ctx.onOutput(redactor.text(r.stdout));
    if (r.stderr) ctx.onOutput(redactor.text(r.stderr));
  }

  // Record the result regardless of exit code (failed seeds are tracked too).
  await store.recordRun(ctx.project, cfg, r.exitCode);

  if (r.exitCode !== 0) {
    emit("seed", "fail", `exit ${r.exitCode}`, { exitCode: r.exitCode });
    throw new ServicesError(
      redactor.text(
        `seed command failed (exit ${r.exitCode}): ${cfg.command}\n` +
          tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
      ),
    );
  }
  ctx.log?.("services: seed — complete");
  emit("seed", "complete", "seed complete");
  await runSeedPostCommands(cfg, { cwd, env, timeout }, ctx, emit, redactor);
}

/**
 * Always-run fixture ensure steps. Invoked after seed skip *or* successful
 * seed so lightweight mongosh/scripts re-apply data the bulk import omits.
 */
async function runSeedPostCommands(
  cfg: SeedConfig,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ctx: StartServicesContext,
  emit: EmitFn,
  redactor = createArtifactRedactor(undefined, opts.env, ctx.secretValues),
): Promise<void> {
  const commands = cfg.postCommands ?? [];
  if (commands.length === 0) return;

  for (const command of commands) {
    ctx.logDetail?.(redactor.text(`seed — postCommand (${command})`));
    emit("seed", "start", redactor.text(`postCommand: ${command}`));
    const r = await runShellWithTimeout(
      command,
      { cwd: opts.cwd, env: opts.env },
      opts.timeout,
    );
    if (r.exitCode !== 0) {
      emit("seed", "fail", `postCommand exit ${r.exitCode}`, {
        exitCode: r.exitCode,
      });
      throw new ServicesError(
        redactor.text(
          `seed postCommand failed (exit ${r.exitCode}): ${command}\n` +
            tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
        ),
      );
    }
    emit("seed", "complete", redactor.text(`postCommand ok: ${command}`));
  }
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
  const reuse = cfg.reuseExisting ?? true;
  phases.tmuxReuse = reuse;
  phases.tmuxSessionName = cfg.session;

  // Reuse path: heal dead/missing windows rather than blindly trusting a
  // leftover session (empty shells after lost send-keys, or services that
  // crashed while scrollback still contains the ready text).
  //
  // Exception: if docker containers were actually down and got brought up
  // this run, leftover pane processes still hold dead connections to the old
  // mongo/rabbit/temporal. Kill and recreate so app services reconnect.
  // (cold-start re-running `compose up` against already-running containers
  // does NOT count — that is not a refresh.)
  if (reuse) {
    const exists = await tmuxSessionExists(cfg.session);
    if (exists && phases.dockerRefreshed) {
      ctx.log?.(
        `tmux — docker was refreshed this run; recreating session "${cfg.session}" so app processes reconnect`,
      );
      emit(
        "tmux",
        "recreate",
        `recreating session after docker refresh: "${cfg.session}"`,
      );
      await execa("tmux", ["kill-session", "-t", cfg.session], {
        reject: false,
        timeout: 5_000,
      });
      // fall through to create path
    } else if (exists) {
      ctx.log?.(`tmux — reusing session "${cfg.session}"`);
      emit("tmux", "reuse", `reusing session "${cfg.session}"`);
      await ensureTmuxWindows(cfg, ctx, emit);
      await waitForAllTmuxWindows(cfg, ctx, emit);
      return;
    }
  }

  // Always kill any leftover session before create so new-session cannot
  // silently fail (reject:false) and boot into a half-dead session.
  await execa("tmux", ["kill-session", "-t", cfg.session], {
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
    // into long-lived service panes.
    env: targetEnv(ctx, cfg.env),
  });

  // Apply session-level options.
  if (cfg.options) {
    for (const opt of cfg.options) {
      await setTmuxOption(cfg.session, opt);
    }
  }

  // Set session-level env vars via tmux set-environment (propagates to all windows).
  if (cfg.env) {
    for (const [key, value] of Object.entries(cfg.env)) {
      await execa("tmux", ["set-environment", "-t", cfg.session, key, value], {
        reject: false,
        timeout: 3_000,
      });
    }
  }

  // Boot first window (wait for shell → clear history → send commands).
  await bootTmuxWindow(cfg.session, firstWin, ctx);

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
      const live = await isTmuxWindowLive(cfg.session, win);
      if (live) continue;
      ctx.logDetail?.(
        `tmux — "${win.name}" exists but is not live; re-launching`,
      );
      emit("tmux", "relaunch", `re-launching "${win.name}"`, {
        window: win.name,
      });
      await bootTmuxWindow(cfg.session, win, ctx);
      continue;
    }
    await execa(
      "tmux",
      [
        "new-window",
        "-t",
        cfg.session,
        "-n",
        win.name,
        ...(win.cwd ? ["-c", resolveCwd(win.cwd, ctx.configDir)] : []),
      ],
      {
        reject: false,
        timeout: 5_000,
      },
    );
    await bootTmuxWindow(cfg.session, win, ctx);
  }

  phases.tmuxSession = cfg.session;
  emit("tmux", "session-created", `session "${cfg.session}" created`);

  await waitForAllTmuxWindows(cfg, ctx, emit);
}

/**
 * On session reuse: create any missing windows and re-launch panes that look
 * dead (idle interactive shell and/or readyOn not currently satisfied).
 */
async function ensureTmuxWindows(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  emit: EmitFn,
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
          cfg.session,
          "-n",
          win.name,
          ...(win.cwd ? ["-c", resolveCwd(win.cwd, ctx.configDir)] : []),
        ],
        { reject: false, timeout: 5_000 },
      );
      await bootTmuxWindow(cfg.session, win, ctx);
      continue;
    }

    const live = await isTmuxWindowLive(cfg.session, win);
    if (live) {
      ctx.log?.(`tmux — "${win.name}" already live; leaving process alone`);
      emit("tmux", "skip", `"${win.name}" already live`, { window: win.name });
      continue;
    }

    ctx.log?.(`tmux — "${win.name}" not live in reused session; re-launching`);
    emit("tmux", "relaunch", `re-launching "${win.name}"`, {
      window: win.name,
    });
    await bootTmuxWindow(cfg.session, win, ctx);
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
  const readyTimeoutMs = cfg.readyTimeoutMs ?? DEFAULT_TMUX_READY_MS;
  // 0 = wait indefinitely (no deadline).
  const deadline =
    readyTimeoutMs > 0 ? Date.now() + readyTimeoutMs : Number.POSITIVE_INFINITY;
  for (const win of cfg.windows) {
    if (!win.readyOn) continue;
    // Pane output is a log of record, not terminal content: full deltas
    // stream to a per-window file while the terminal gets a ~15s heartbeat.
    // Written incrementally so a killed run still leaves the evidence.
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
    try {
      await waitForTmuxWindow(cfg.session, win, deadline, {
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
    } finally {
      // Flush before proceeding: a reader (or the process exiting on error)
      // must find every captured delta on disk.
      await new Promise<void>((resolveEnd) => {
        paneStream.end(() => resolveEnd());
      });
    }
    emit("tmux", "ready", `"${win.name}" ready`, { window: win.name });
  }

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
  session: string,
  win: TmuxWindow,
): Promise<boolean> {
  if (win.readyOn?.url && (await probeOnce(win.readyOn.url))) {
    return true;
  }
  // Non-shell process in the pane → starting or running; do not re-send.
  if (!(await isTmuxPaneIdleShell(session, win.name))) {
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
    ["send-keys", "-t", `${session}:${window}`, command, "Enter"],
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
      await execa("tmux", ["set-environment", "-t", session, key, value], {
        reject: false,
        timeout: 3_000,
      });
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
      await sleep(POLL_MS);
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
    const cmd = await tmuxPaneCurrentCommand(session, window);
    if (cmd && TMUX_IDLE_SHELL_RE.test(cmd)) {
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
    await sleep(POLL_MS);
  }
  ctx.log?.(
    `tmux — "${window}" shell not confirmed idle within ${timeoutMs}ms; sending keys anyway`,
  );
}

async function tmuxPaneCurrentCommand(
  session: string,
  window: string,
): Promise<string> {
  try {
    const r = await execa(
      "tmux",
      [
        "display-message",
        "-p",
        "-t",
        `${session}:${window}`,
        "#{pane_current_command}",
      ],
      { reject: false, timeout: 3_000 },
    );
    return typeof r.stdout === "string" ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

async function isTmuxPaneIdleShell(
  session: string,
  window: string,
): Promise<boolean> {
  const cmd = await tmuxPaneCurrentCommand(session, window);
  // Unknown / empty → treat as idle (not yet running a service). That way
  // send-retry keeps trying and reuse heal re-launches instead of trusting
  // a pane that never started.
  if (!cmd) return true;
  return TMUX_IDLE_SHELL_RE.test(cmd);
}

async function clearTmuxHistory(
  session: string,
  window: string,
): Promise<void> {
  await execa("tmux", ["clear-history", "-t", `${session}:${window}`], {
    reject: false,
    timeout: 3_000,
  });
}

async function setTmuxOption(
  session: string,
  opt: TmuxSessionOption,
): Promise<void> {
  await execa("tmux", ["set-option", "-t", session, opt.key, opt.value], {
    reject: false,
    timeout: 3_000,
  });
}

export async function tmuxSessionExists(session: string): Promise<boolean> {
  try {
    const r = await execa("tmux", ["has-session", "-t", session], {
      reject: false,
      timeout: 3_000,
    });
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
      ["list-windows", "-t", session, "-F", "#{window_name}"],
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
    /** Full pane delta — the log of record, never the terminal. */
    onDelta?: (delta: string) => void;
    /** Bounded proof-of-life line for the terminal, every ~15s. */
    onHeartbeat?: (elapsedMs: number, newLines: number) => void;
  },
): Promise<void> {
  if (!win.readyOn) return;
  const startedAt = Date.now();
  let lastStall = 0;
  let lastBeat = Date.now();
  let linesSinceBeat = 0;
  let lastCapture = "";
  // Rolling tail for the timeout error: a tmux window that never became
  // ready used to throw with ZERO captured output — the one moment the pane
  // content matters most (docker/seed failures already tail theirs).
  const recent: string[] = [];
  for (;;) {
    // Check URL readiness.
    if (win.readyOn.url) {
      if (await probeOnce(win.readyOn.url)) return;
    }
    // Check text readiness via tmux capture-pane.
    if (win.readyOn.text) {
      // Large scrollback: a chatty service may print the readiness line early
      // then flood errors/warnings that push it past a small capture window.
      const pane = await captureTmuxPane(session, win.name, 2000);
      // Case-insensitive: server logs vary in casing ("Listening" vs "listening").
      if (pane.toLowerCase().includes(win.readyOn.text.toLowerCase())) return;
    }
    if (Date.now() >= deadline) {
      throw new ServicesError(
        `tmux window "${win.name}" did not become ready within deadline` +
          (win.readyOn.url ? ` (url: ${win.readyOn.url})` : "") +
          (win.readyOn.text ? ` (text: "${win.readyOn.text}")` : "") +
          (recent.length > 0
            ? `\n--- last pane output ("${win.name}") ---\n${recent
                .slice(-40)
                .join("\n")}`
            : ""),
      );
    }
    // Capture the pane's NEW lines since the last look. The delta goes to the
    // log of record (hooks.onDelta → a file); the terminal only gets a short
    // heartbeat. Streaming raw pane content to the terminal buried entire
    // runs under Go stack traces and 30-line request dumps.
    if (Date.now() - lastStall >= TMUX_STALL_INTERVAL_MS) {
      lastStall = Date.now();
      const tail = await captureTmuxPane(session, win.name, 500);
      if (tail && tail !== lastCapture) {
        const delta =
          lastCapture && tail.startsWith(lastCapture)
            ? tail.slice(lastCapture.length)
            : lastCapture
              ? tailText(tail, 15)
              : tailText(tail, 20);
        if (delta.trim()) {
          hooks?.onDelta?.(delta);
          const deltaLines = delta.split("\n").filter((l) => l.trim());
          linesSinceBeat += deltaLines.length;
          recent.push(...deltaLines);
          if (recent.length > 80) recent.splice(0, recent.length - 80);
        }
        lastCapture = tail;
      }
    }
    if (hooks?.onHeartbeat && Date.now() - lastBeat >= 15_000) {
      hooks.onHeartbeat(Date.now() - startedAt, linesSinceBeat);
      lastBeat = Date.now();
      linesSinceBeat = 0;
    }
    await sleep(POLL_MS);
  }
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
        `${session}:${window}`,
        "-S",
        `-${scrollbackLines}`,
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
 * reused tmux services still need (mongo/rabbit/postgres/etc.).
 */
function tearsDownDocker(cmd: string): boolean {
  return (
    /\bdocker\s+compose\s+down\b/.test(cmd) ||
    /\bdocker-compose\s+down\b/.test(cmd)
  );
}

/**
 * Synchronous, signal-safe teardown for SIGINT/SIGTERM, where the async stop()
 * never runs. Kills the tmux session AND runs any user-declared teardown
 * commands so they aren't silently skipped on Ctrl-C. Each command is
 * time-bounded so a hang can't block process exit.
 *
 * In tmux-reuse mode: leave the session alive and skip both `tmux kill-session`
 * and `docker compose down` — the next run reuses both.
 */
function terminateServicesSync(phases: PhaseState, configDir: string): void {
  if (!phases.tmuxReuse) terminateTmuxSync(phases.tmuxSession);
  if (phases.teardownCommands.length === 0) return;
  try {
    const { spawnSync } =
      require("node:child_process") as typeof import("node:child_process");
    for (const cmd of phases.teardownCommands) {
      if (
        phases.tmuxReuse &&
        phases.tmuxSessionName &&
        killsTmuxSession(cmd, phases.tmuxSessionName)
      ) {
        continue;
      }
      if (phases.tmuxReuse && tearsDownDocker(cmd)) {
        continue;
      }
      spawnSync(cmd, {
        cwd: configDir,
        shell: true,
        timeout: 10_000,
        stdio: "ignore",
      });
    }
  } catch {
    // best-effort, never fatal in the signal path
  }
}

function terminateTmuxSync(session: string | undefined): void {
  if (!session) return;
  try {
    const { spawnSync } =
      require("node:child_process") as typeof import("node:child_process");
    spawnSync("tmux", ["kill-session", "-t", session], {
      timeout: 3_000,
    });
  } catch {
    // best-effort, never fatal in signal path
  }
}

/* ----- fcheap stash helpers ----- */

/**
 * Capture tmux pane output and docker logs into the artifacts directory.
 * Called during `stop()` before the tmux session is killed. Only captures
 * the phases that were actually started and are in the `capture` list.
 */
async function captureSessionArtifacts(
  cfg: ServicesConfig,
  phases: PhaseState,
  ctx: StartServicesContext,
): Promise<void> {
  if (!phases.artifactsDir) return;
  const capture = cfg.stash?.capture ?? ["tmux", "docker", "seed"];

  // Capture tmux pane output for each window.
  if (phases.tmuxSession && capture.includes("tmux") && cfg.tmux) {
    for (const win of cfg.tmux.windows) {
      try {
        const pane = await captureTmuxPane(phases.tmuxSession, win.name);
        const file = join(phases.artifactsDir, `tmux-${win.name}.txt`);
        await writeFile(file, pane, "utf-8");
        phases.artifacts.push({
          phase: "tmux",
          file,
          label: `tmux/${win.name}`,
        });
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
      const file = join(phases.artifactsDir, "docker-logs.txt");
      await writeFile(file, `${r.stdout}\n${r.stderr}`, "utf-8");
      phases.artifacts.push({
        phase: "docker",
        file,
        label: "docker/logs",
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * Stash the captured artifacts directory to the fcheap vault. Best-effort:
 * if fcheap isn't installed, logs a warning and continues.
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
    await sleep(startPeriodMs);
  }

  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await sleep(intervalMs);
    }
    ctx.logDetail?.(
      `${label} — healthcheck attempt ${attempt + 1}/${retries} (${cfg.command})`,
    );
    const r = await runShellWithTimeout(cfg.command, opts, timeoutMs);
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
 * Run a shell command with a timeout. Unlike `runShell` (which is fire-and-forget
 * for long-running servers), this waits for the command to complete and kills
 * it if it exceeds the timeout. Pass `timeoutMs <= 0` to wait indefinitely.
 * When `onChunk` is set, stdout/stderr chunks stream to it live (interactive
 * runs) instead of being captured silently.
 */
async function runShellWithTimeout(
  command: string,
  opts: SpawnOpts,
  timeoutMs: number,
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<ShellResult> {
  // execa works identically under Bun and node. The `shell: true` option
  // gives us shell semantics (pipes, redirects, &&) for docker/seed commands.
  // timeoutMs <= 0 means wait indefinitely (no execa timeout).
  const child = execa(command, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string | undefined>,
    shell: true,
    reject: false,
    ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
  });

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
    return {
      exitCode: r.exitCode ?? -1,
      stdout,
      stderr,
    };
  }

  const r = await child;
  return {
    exitCode: r.exitCode ?? -1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}
