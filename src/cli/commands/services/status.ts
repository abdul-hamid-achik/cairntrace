import {
  dockerComposeRunning,
  tmuxSessionExists,
  captureTmuxPane,
  resolveCwd,
} from "../../../core/runner/services";
import { SeedStateStore } from "../../../core/runner/seedState";
import { loadConfig, findConfigFile } from "../../../core/config/loader";
import { emit, resolveFormat } from "../../format";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ServicesStatusOptions {
  config?: string;
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
  const services = cfg?.services;
  const configDir = configPath ? dirname(configPath) : process.cwd();

  const result: ServicesStatusResult = {
    hasServices: !!services,
    project,
    docker: { configured: false, running: false },
    seed: { configured: false, expired: true },
    tmux: { configured: false, sessionExists: false, windows: [] },
    errors,
  };

  if (!services) return result;

  // Docker status
  if (services.docker) {
    result.docker.configured = true;
    result.docker.cwd = services.docker.cwd;
    result.docker.reuseExisting = services.docker.reuseExisting;
    try {
      const dockerCwd = resolveCwd(services.docker.cwd, configDir);
      result.docker.running = await dockerComposeRunning(dockerCwd);
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
