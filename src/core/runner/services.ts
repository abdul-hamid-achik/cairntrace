import { execa } from "execa";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
import type { SecretsConfig, TvaultConfig } from "../schema/config.v1";
import {
  isTruthyEnv,
  probeOnce,
  runShell,
  sleep,
  type ShellResult,
  type SpawnOpts,
} from "./webServer";
import { SeedStateStore } from "./seedState";

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
  /** Secrets config for tvault injection into the seed command. */
  secrets?: SecretsConfig;
  /** Optional narrator for interactive runs (stderr lifecycle lines). */
  log?: (message: string) => void;
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
const SHELL_TAIL_LINES = 40;
const DEFAULT_HC_INTERVAL_S = 30;
const DEFAULT_HC_RETRIES = 3;
const DEFAULT_HC_TIMEOUT_S = 10;

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
    tmuxSession: undefined,
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
    terminateTmuxSync(phases.tmuxSession);
  });

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

      // Teardown commands from config first (best-effort).
      for (const cmd of phases.teardownCommands) {
        try {
          ctx.log?.(`services: teardown (${cmd})`);
          await runShell(cmd, { cwd: ctx.configDir, env: process.env });
        } catch {
          // teardown is best-effort, never fatal
        }
      }
      // Then kill tmux session if we started it.
      if (phases.tmuxSession) {
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
      terminateTmuxSync(phases.tmuxSession);
    },
  };
}

/* ----- phase state ----- */

interface PhaseState {
  dockerStarted: boolean;
  tmuxSession: string | undefined;
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
  const env = { ...process.env, ...cfg.env };
  const timeout = cfg.readyTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;

  // Reuse check: is docker compose already reporting running containers?
  if (reuse) {
    const running = await dockerComposeRunning(cwd);
    if (running) {
      ctx.log?.("services: docker — reusing running containers");
      emit("docker", "reuse", "reusing running containers");
      return;
    }
  }

  ctx.log?.(`services: docker (${cfg.command})`);
  emit("docker", "start", cfg.command);
  const r = await runShellWithTimeout(cfg.command, { cwd, env }, timeout);
  if (r.exitCode !== 0) {
    emit("docker", "fail", `exit ${r.exitCode}`, { exitCode: r.exitCode });
    throw new ServicesError(
      `docker command failed (exit ${r.exitCode}): ${cfg.command}\n` +
        tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
    );
  }

  // Optional readiness check: a command whose exit 0 means infra is ready.
  if (cfg.readinessCheck) {
    ctx.log?.(`services: docker — readiness check (${cfg.readinessCheck})`);
    emit("docker", "readiness-check", cfg.readinessCheck);
    const rc = await runShell(cfg.readinessCheck, { cwd, env });
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
        `services: docker — healthcheck WARNING: unhealthy after ${hcResult.consecutiveFailures} failures`,
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

  if (!check.shouldRun) {
    ctx.log?.(`services: seed — skipping (${check.reason})`);
    emit("seed", "skip", check.reason);
    return;
  }

  // If the fingerprint + TTL pass but freshnessCheck is configured, run it.
  if (check.reason === "freshness-check-pending" && cfg.freshnessCheck) {
    const cwd = resolveCwd(cfg.cwd, ctx.configDir);
    const env = await resolveSeedEnv(cfg, ctx);
    ctx.log?.(`services: seed — freshness check (${cfg.freshnessCheck})`);
    emit("seed", "freshness-check", cfg.freshnessCheck);
    const fr = await runShell(cfg.freshnessCheck, { cwd, env });
    if (fr.exitCode === 0) {
      ctx.log?.("services: seed — freshness check passed, skipping");
      emit("seed", "skip", "freshness check passed");
      // Still record the freshness check as a successful "non-seed" so the
      // timestamp is updated for the next TTL window.
      await store.recordRun(ctx.project, cfg, 0);
      return;
    }
    ctx.log?.(
      `services: seed — freshness check failed (exit ${fr.exitCode}), re-seeding`,
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

  const cwd = resolveCwd(cfg.cwd, ctx.configDir);
  const env = await resolveSeedEnv(cfg, ctx);
  const timeout = cfg.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;

  ctx.log?.(`services: seed — running (${cfg.command})`);
  emit("seed", "start", cfg.command);
  const r = await runShellWithTimeout(cfg.command, { cwd, env }, timeout);

  // Record the result regardless of exit code (failed seeds are tracked too).
  await store.recordRun(ctx.project, cfg, r.exitCode);

  if (r.exitCode !== 0) {
    emit("seed", "fail", `exit ${r.exitCode}`, { exitCode: r.exitCode });
    throw new ServicesError(
      `seed command failed (exit ${r.exitCode}): ${cfg.command}\n` +
        tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
    );
  }
  ctx.log?.("services: seed — complete");
  emit("seed", "complete", "seed complete");
}

/**
 * Resolve env for the seed command: process.env + cfg.env + tvault secrets.
 * This is where `getTvaultEnv` finally gets called from the run path.
 */
async function resolveSeedEnv(
  cfg: SeedConfig,
  ctx: StartServicesContext,
): Promise<NodeJS.ProcessEnv> {
  let env: NodeJS.ProcessEnv = { ...process.env, ...cfg.env };

  if (ctx.secrets?.provider === "tvault" && ctx.secrets.tvault) {
    const tvaultCfg = ctx.secrets.tvault;
    // Lazy import to avoid circular dependency (secrets.ts imports execa, not runner code).
    const { tvaultArgs } = await import("../../cli/commands/secrets");
    const { target } = tvaultArgs(tvaultCfg);
    const tvaultResult = await getTvaultEnvSafe(tvaultCfg);
    if (!tvaultResult.ok) {
      throw new ServicesError(`tvault secrets for seed: ${tvaultResult.error}`);
    }
    env = { ...env, ...tvaultResult.env };
    ctx.log?.(
      `services: seed — injected ${Object.keys(tvaultResult.env).length} secrets from tvault "${target}"`,
    );
  }

  return env;
}

/**
 * Safe wrapper around `getTvaultEnv` that doesn't expose secret values.
 * Delegates to the secrets module but keeps the import lazy to avoid a
 * circular dependency (secrets.ts imports execa, not runner code).
 */
async function getTvaultEnvSafe(
  cfg: TvaultConfig,
): Promise<{ ok: boolean; env: Record<string, string>; error?: string }> {
  try {
    // Dynamic import to avoid circular dependency.
    const { getTvaultEnv } = await import("../../cli/commands/secrets");
    return await getTvaultEnv(cfg);
  } catch (e) {
    return { ok: false, env: {}, error: (e as Error).message };
  }
}

/* ----- Phase 3: tmux ----- */

async function startTmux(
  cfg: TmuxConfig,
  ctx: StartServicesContext,
  coldStart: boolean,
  phases: PhaseState,
  emit: EmitFn,
): Promise<void> {
  const reuse = cfg.reuseExisting ?? !coldStart;

  // Reuse check: does the session already exist?
  if (reuse) {
    const exists = await tmuxSessionExists(cfg.session);
    if (exists) {
      ctx.log?.(`services: tmux — reusing session "${cfg.session}"`);
      emit("tmux", "reuse", `reusing session "${cfg.session}"`);
      return;
    }
  }

  // Cold-start: kill any existing session with the same name.
  if (coldStart) {
    await execa("tmux", ["kill-session", "-t", cfg.session], {
      reject: false,
      timeout: 5_000,
    });
  }

  // Create the session with the first window, then add the rest.
  ctx.log?.(
    `services: tmux — creating session "${cfg.session}" with ${cfg.windows.length} windows`,
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

  // Send pre-commands then the main command for the first window.
  await sendWindowCommands(cfg.session, firstWin, ctx);

  // Create remaining windows.
  for (let i = 1; i < cfg.windows.length; i++) {
    const win = cfg.windows[i]!;
    await execa(
      "tmux",
      [
        "new-window",
        "-t",
        `${cfg.session}:${i}`,
        "-n",
        win.name,
        ...(win.cwd ? ["-c", resolveCwd(win.cwd, ctx.configDir)] : []),
      ],
      {
        reject: false,
        timeout: 5_000,
      },
    );
    await sendWindowCommands(cfg.session, win, ctx);
  }

  phases.tmuxSession = cfg.session;
  emit("tmux", "session-created", `session "${cfg.session}" created`);

  // Wait for readiness on each window that has a readyOn config.
  const readyTimeoutMs = cfg.readyTimeoutMs ?? DEFAULT_TMUX_READY_MS;
  const deadline = Date.now() + readyTimeoutMs;
  for (const win of cfg.windows) {
    if (!win.readyOn) continue;
    ctx.log?.(`services: tmux — waiting for "${win.name}" to be ready`);
    emit("tmux", "ready-wait", `waiting for "${win.name}"`, {
      window: win.name,
    });
    await waitForTmuxWindow(cfg.session, win, deadline);
    emit("tmux", "ready", `"${win.name}" ready`, { window: win.name });
  }

  // Run healthchecks for windows that have them.
  for (const win of cfg.windows) {
    if (!win.healthcheck) continue;
    emit("tmux", "healthcheck", `checking ${win.name}`, { window: win.name });
    const winEnv = { ...process.env, ...cfg.env, ...win.env };
    const hcResult = await runHealthcheck(
      win.healthcheck,
      { cwd: resolveCwd(win.cwd, ctx.configDir), env: winEnv },
      ctx,
      `tmux/${win.name}`,
    );
    if (!hcResult.healthy) {
      ctx.log?.(
        `services: tmux/${win.name} — healthcheck WARNING: unhealthy after ${hcResult.consecutiveFailures} failures`,
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

  ctx.log?.(`services: tmux — session "${cfg.session}" ready`);
  emit("tmux", "ready", `session "${cfg.session}" ready`);
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
 * Pre-commands are sent sequentially; each one is given a short grace period
 * before the next is sent. The main command is always sent last.
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
  for (const pre of win.preCommands ?? []) {
    ctx.log?.(`services: tmux — ${win.name}: pre-command (${pre})`);
    await sendTmuxCommand(session, win.name, pre);
    // Give the pre-command a short grace period to finish before sending the
    // next one. This is a best-effort approach — pre-commands should be
    // short-lived build/migrate steps that exit quickly.
    await sleep(500);
  }
  // Send the main command (no env needed — already set above).
  await sendTmuxCommand(session, win.name, win.command);
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

async function waitForTmuxWindow(
  session: string,
  win: TmuxWindow,
  deadline: number,
): Promise<void> {
  if (!win.readyOn) return;

  for (;;) {
    // Check URL readiness.
    if (win.readyOn.url) {
      if (await probeOnce(win.readyOn.url)) return;
    }
    // Check text readiness via tmux capture-pane.
    if (win.readyOn.text) {
      const pane = await captureTmuxPane(session, win.name);
      if (pane.includes(win.readyOn.text)) return;
    }
    if (Date.now() >= deadline) {
      throw new ServicesError(
        `tmux window "${win.name}" did not become ready within deadline` +
          (win.readyOn.url ? ` (url: ${win.readyOn.url})` : "") +
          (win.readyOn.text ? ` (text: "${win.readyOn.text}")` : ""),
      );
    }
    await sleep(POLL_MS);
  }
}

export async function captureTmuxPane(
  session: string,
  window: string,
): Promise<string> {
  try {
    const r = await execa(
      "tmux",
      ["capture-pane", "-p", "-t", `${session}:${window}`, "-S", "-100"],
      { reject: false, timeout: 3_000 },
    );
    return typeof r.stdout === "string" ? r.stdout : "";
  } catch {
    return "";
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
        `services: stashed ${phases.artifacts.length} artifacts to fcheap → ${result.stashId ?? "(unknown)"}`,
      );
    } else {
      ctx.log?.(
        `services: stash to fcheap failed (non-fatal): ${result.error}`,
      );
    }
  } catch (e) {
    ctx.log?.(
      `services: stash to fcheap failed (non-fatal): ${(e as Error).message}`,
    );
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
    ctx.log?.(
      `services: ${label} — healthcheck waiting ${cfg.startPeriodSeconds ?? 0}s before first check`,
    );
    await sleep(startPeriodMs);
  }

  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      await sleep(intervalMs);
    }
    ctx.log?.(
      `services: ${label} — healthcheck attempt ${attempt + 1}/${retries} (${cfg.command})`,
    );
    const r = await runShellWithTimeout(cfg.command, opts, timeoutMs);
    if (r.exitCode === 0) {
      return { healthy: true, consecutiveFailures: 0 };
    }
    consecutiveFailures++;
    ctx.log?.(
      `services: ${label} — healthcheck attempt ${attempt + 1} failed (exit ${r.exitCode})`,
    );
  }

  return { healthy: false, consecutiveFailures };
}

/**
 * Run a shell command with a timeout. Unlike `runShell` (which is fire-and-forget
 * for long-running servers), this waits for the command to complete and kills
 * it if it exceeds the timeout.
 */
async function runShellWithTimeout(
  command: string,
  opts: SpawnOpts,
  timeoutMs: number,
): Promise<ShellResult> {
  // execa works identically under Bun and node. The `shell: true` option
  // gives us shell semantics (pipes, redirects, &&) for docker/seed commands.
  const r = await execa(command, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string | undefined>,
    shell: true,
    reject: false,
    timeout: timeoutMs,
  });
  return {
    exitCode: r.exitCode ?? -1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}
