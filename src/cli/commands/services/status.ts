import {
  checkServicesLive,
  dockerComposeRunning,
  formatServicesAge,
  probeDockerCompose,
  readServicesLock,
  servicesLockAgeSeconds,
  tmuxSessionExists,
  captureTmuxPane,
  resolveCwd,
} from "../../../core/runner/services";
import { SeedStateStore } from "../../../core/runner/seedState";
import { loadConfig, findConfigFile } from "../../../core/config/loader";
import { resolveProjectRuntimeContext } from "../../../core/config/runtimeContext";
import type { GateNode } from "../../../core/gates/schema";
import type { ServicesConfig } from "../../../core/schema/config.v1";
import type { ServicesLockReport } from "../../../core/schema/services.v1";
import { emit, resolveFormat } from "../../format";
import { resolveScopedSecrets, type ScopedSecrets } from "../secrets";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ServicesStatusOptions {
  config?: string;
  /** Environment whose effective services and owner lock are reported. */
  env?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  project?: string;
}

export interface ServicesStatusResult {
  /** Whether a services config block was found. */
  hasServices: boolean;
  /** Project name from config. */
  project: string;
  /** Resolved environment (`--env`, else defaultEnvironment, else local). */
  env?: string;
  /**
   * The `cairn services up` owner lock of the config (one per config file,
   * `lock.env` names its environment): who holds it, its age, and (a lock
   * held for this environment) whether the services it owns are actually up.
   */
  lock?: ServicesLockReport;
  /** Docker status. */
  docker: {
    configured: boolean;
    running: boolean;
    cwd?: string;
    reuseExisting?: boolean;
  };
  /** Seed status. */
  seed: {
    configured: boolean;
    lastRunAt?: string;
    lastRunExitCode?: number;
    expired: boolean;
    fingerprint?: string;
    ttlSeconds?: number;
    freshnessCheck?: string;
  };
  /** tmux status. */
  tmux: {
    configured: boolean;
    sessionExists: boolean;
    session?: string;
    windows: Array<{
      name: string;
      healthy?: boolean;
      paneTail?: string;
    }>;
  };
  /** Errors encountered during status check. */
  errors: string[];
}

/**
 * Check the current status of the services environment (docker, seed, tmux).
 */
export async function getServicesStatus(
  opts: ServicesStatusOptions,
): Promise<ServicesStatusResult> {
  const errors: string[] = [];

  // Load config
  let configPath: string | undefined;
  try {
    if (opts.config) {
      configPath = isAbsolute(opts.config)
        ? opts.config
        : resolve(process.cwd(), opts.config);
    } else {
      const discovered = await findConfigFile(process.cwd());
      configPath = discovered ?? undefined;
    }
  } catch (e) {
    errors.push(`config discovery: ${(e as Error).message}`);
  }

  let loaded: Awaited<ReturnType<typeof loadConfig>> | undefined;
  if (configPath) {
    try {
      loaded = await loadConfig(configPath, configPath);
    } catch (e) {
      errors.push(`config load: ${(e as Error).message}`);
    }
  }

  const cfg = loaded?.config;
  const project = cfg?.project ?? opts.project ?? "cairntrace";
  let services: ServicesConfig | undefined = cfg?.services;
  const configDir = configPath ? dirname(configPath) : process.cwd();

  // The environment's effective services (per-env overrides applied), like
  // `cairn run` / `services up` resolve them.
  let envName: string | undefined;
  if (loaded) {
    try {
      const ctx = await resolveProjectRuntimeContext({
        configPath: loaded.path,
        ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      });
      envName = ctx.envName;
      services = ctx.services;
    } catch (e) {
      errors.push(`env: ${(e as Error).message}`);
    }
  }

  const result: ServicesStatusResult = {
    hasServices: !!services,
    project,
    ...(envName !== undefined ? { env: envName } : {}),
    docker: { configured: false, running: false },
    seed: { configured: false, expired: true },
    tmux: { configured: false, sessionExists: false, windows: [] },
    errors,
  };

  if (envName !== undefined && loaded) {
    try {
      result.lock = await servicesLockReport(
        loaded.path,
        envName,
        services,
        configDir,
        errors,
        cfg?.gates,
      );
    } catch (e) {
      errors.push(`lock: ${(e as Error).message}`);
    }
  }

  if (!services) return result;

  // Docker status
  if (services.docker) {
    result.docker.configured = true;
    result.docker.cwd = services.docker.cwd;
    result.docker.reuseExisting = services.docker.reuseExisting;
    try {
      const dockerCwd = resolveCwd(services.docker.cwd, configDir);
      // The compose project the command starts (its -f/-p options and env);
      // a bare `docker compose ps` in its cwd when that cannot be told.
      const probe = await probeDockerCompose(
        services.docker.command,
        dockerCwd,
        { ...process.env, ...services.docker.env },
      );
      result.docker.running =
        probe.state === "unknown"
          ? await dockerComposeRunning(dockerCwd)
          : probe.state === "running";
    } catch (e) {
      errors.push(`docker: ${(e as Error).message}`);
    }
  }

  // Seed status
  if (services.seed) {
    result.seed.configured = true;
    result.seed.ttlSeconds = services.seed.ttlSeconds;
    result.seed.freshnessCheck = services.seed.freshnessCheck;
    try {
      const store = new SeedStateStore();
      const state = await store.read(project);
      if (state) {
        result.seed.lastRunAt = state.lastRunAt;
        result.seed.lastRunExitCode = state.lastRunExitCode;
        result.seed.fingerprint = state.fingerprint;
        const ttl = services.seed.ttlSeconds ?? 0;
        if (ttl > 0 && state.lastRunAt) {
          const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
          result.seed.expired = elapsed > ttl * 1000;
        } else {
          result.seed.expired = ttl === 0;
        }
      }
    } catch (e) {
      errors.push(`seed: ${(e as Error).message}`);
    }
  }

  // tmux status
  if (services.tmux) {
    result.tmux.configured = true;
    result.tmux.session = services.tmux.session;
    try {
      result.tmux.sessionExists = await tmuxSessionExists(
        services.tmux.session,
      );
      if (result.tmux.sessionExists && services.tmux.windows) {
        for (const win of services.tmux.windows) {
          const paneTail = await captureTmuxPane(
            services.tmux.session,
            win.name,
          ).catch(() => "");
          result.tmux.windows.push({
            name: win.name,
            paneTail: paneTail.slice(-200),
          });
        }
      }
    } catch (e) {
      errors.push(`tmux: ${(e as Error).message}`);
    }
  }

  return result;
}

/**
 * The owner lock of the config (one per config file). A lock held for this
 * environment also gets one quick liveness look — the same check a run makes,
 * with the environment's scoped secrets when they resolve — and reports
 * `stale: true` with the problems when the services it owns are not up. A
 * lock another environment holds is reported as is (`lock.env`).
 */
async function servicesLockReport(
  configPath: string,
  envName: string,
  services: ServicesConfig | undefined,
  configDir: string,
  errors: string[],
  gates?: Readonly<Record<string, GateNode>>,
): Promise<ServicesLockReport> {
  const state = await readServicesLock(configPath);
  if (state.state === "absent") return { state: "absent", path: state.path };
  if (state.state === "unreadable") {
    return { state: "unreadable", path: state.path, reason: state.reason };
  }
  const report: ServicesLockReport = {
    state: "held",
    path: state.path,
    lock: state.lock,
    ageSeconds: servicesLockAgeSeconds(state.lock),
  };
  if (state.lock.env !== envName) return report;
  if (!services) {
    return {
      ...report,
      stale: true,
      problems: [`no services configured for env "${envName}"`],
    };
  }
  // A docker readinessCheck may need vault values, as in a run.
  let scoped: ScopedSecrets | undefined;
  try {
    scoped = await resolveScopedSecrets(configPath, {
      configPath,
      environmentOverride: envName,
    });
  } catch (e) {
    errors.push(
      `lock: liveness checked without vault secrets (${(e as Error).message})`,
    );
  }
  const liveness = await checkServicesLive(services, {
    configDir,
    ...(gates ? { gates } : {}),
    ...(scoped
      ? { env: scoped.childEnv, selectedTvaultKeys: scoped.selectedKeys }
      : {}),
  });
  return {
    ...report,
    stale: !liveness.live,
    ...(liveness.live ? {} : { problems: liveness.problems }),
    ...(liveness.unchecked.length > 0 ? { unchecked: liveness.unchecked } : {}),
  };
}

/**
 * `cairn services status` — check the current state of the services environment.
 */
export async function servicesStatusCommand(
  opts: ServicesStatusOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const result = await getServicesStatus(opts);

  const md = renderMarkdown(result);
  process.stdout.write(emit(format, result, () => md));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");

  if (result.errors.length > 0 && format !== "json" && format !== "yaml") {
    process.stderr.write(
      `\nWarnings:\n${result.errors.map((e) => `  - ${e}`).join("\n")}\n`,
    );
  }
}

function renderMarkdown(r: ServicesStatusResult): string {
  const lines: string[] = ["# Services status", "", `- project: ${r.project}`];
  if (r.env) lines.push(`- env: ${r.env}`);
  if (r.lock) lines.push(`- lock: ${describeLockReport(r.lock, r.env)}`);

  if (!r.hasServices) {
    lines.push("- no services config block found");
    return lines.join("\n");
  }

  // Docker
  lines.push("", "## Docker");
  if (!r.docker.configured) {
    lines.push("- not configured");
  } else {
    lines.push(`- running: ${r.docker.running ? "yes" : "no"}`);
    if (r.docker.cwd) lines.push(`- cwd: ${r.docker.cwd}`);
    if (r.docker.reuseExisting !== undefined)
      lines.push(`- reuseExisting: ${r.docker.reuseExisting}`);
  }

  // Seed
  lines.push("", "## Seed");
  if (!r.seed.configured) {
    lines.push("- not configured");
  } else {
    lines.push(
      `- expired: ${r.seed.expired ? "yes (would re-seed)" : "no (fresh)"}`,
    );
    if (r.seed.lastRunAt) lines.push(`- lastRunAt: ${r.seed.lastRunAt}`);
    if (r.seed.lastRunExitCode !== undefined)
      lines.push(`- lastRunExitCode: ${r.seed.lastRunExitCode}`);
    if (r.seed.ttlSeconds !== undefined)
      lines.push(`- ttlSeconds: ${r.seed.ttlSeconds}`);
    if (r.seed.freshnessCheck)
      lines.push(`- freshnessCheck: ${r.seed.freshnessCheck}`);
  }

  // tmux
  lines.push("", "## tmux");
  if (!r.tmux.configured) {
    lines.push("- not configured");
  } else {
    lines.push(`- session: ${r.tmux.session ?? "(unnamed)"}`);
    lines.push(`- sessionExists: ${r.tmux.sessionExists ? "yes" : "no"}`);
    if (r.tmux.windows.length > 0) {
      lines.push("- windows:");
      for (const w of r.tmux.windows) {
        lines.push(`  - ${w.name}`);
      }
    }
  }

  if (r.errors.length > 0) {
    lines.push("", "## Warnings");
    for (const e of r.errors) lines.push(`- ${e}`);
  }

  return lines.join("\n");
}

/** One markdown line for the owner lock (also the MCP text summary). */
export function describeLockReport(
  lock: ServicesLockReport,
  /** The environment the status is for (a lock may hold another one). */
  env?: string,
): string {
  if (lock.state === "absent") return "none";
  if (lock.state === "unreadable") {
    return `unreadable (${lock.reason ?? "invalid"}): ${lock.path} — \`cairn services down\` clears it`;
  }
  const held = lock.lock!;
  const age = formatServicesAge(lock.ageSeconds ?? 0);
  const owner = `held by \`cairn services up\` (${held.by}, pid ${held.pid}) since ${held.startedAt} (${age} ago)`;
  if (env !== undefined && held.env !== env) {
    return `${owner} for env "${held.env}" — runs of env "${env}" refuse (exit 4): environments of one config share its stack; \`cairn services status --env ${held.env}\` checks it`;
  }
  const unchecked = lock.unchecked?.length
    ? ` (not checked: ${lock.unchecked.join("; ")})`
    : "";
  return lock.stale
    ? `${owner} — STALE: ${(lock.problems ?? []).join("; ")}; \`cairn services down --env ${held.env}\` clears it`
    : `${owner} — runs need --reuse-services${unchecked}`;
}
