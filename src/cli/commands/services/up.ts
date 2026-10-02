import {
  canonicalConfigPath,
  describeServicesLock,
  readServicesLock,
  ServicesError,
  writeServicesLock,
  type ServicesEvent,
} from "../../../core/runner/services";
import type {
  ServicesOwnerLock,
  ServicesUpResult,
} from "../../../core/schema/services.v1";
import { trackServices } from "../../cleanup";
import { emit, resolveFormat } from "../../format";
import { log } from "../../logger";
import {
  configErrorExitCode,
  startServicesPlan,
} from "../../invocation/lifecycle";
import { isTruthyEnv } from "../../invocation/options";
import {
  noServicesMessage,
  resolveServicesTarget,
  ServicesCommandError,
  type ServicesTarget,
} from "./target";

/**
 * `cairn services up`: start the config services (docker → seed → tmux)
 * through the same code path as `cairn run`, leave them running, and write
 * the owner lock of the config (`~/.cairntrace/services/<config dir>.<hash>.lock.json`,
 * one per config file). While it exists, `cairn run` for that environment
 * refuses (exit 4) unless it passes `--reuse-services`, and every other
 * environment of the config refuses; `cairn services down` removes it.
 */

export interface ServicesUpOptions {
  config?: string;
  env?: string;
  /** Config discovery start (default process.cwd()). */
  cwd?: string;
  /** Who started the services (stamped into the lock). */
  by?: "cli" | "mcp";
  /** Cancels the boot (kills running commands, tears started phases down). */
  signal?: AbortSignal;
  /** Lifecycle narration (redacted). */
  log?: (message: string) => void;
  logDetail?: (message: string) => void;
  /** Live docker/seed output chunks (interactive). */
  onOutput?: (chunk: string) => void;
  /** Signal-time teardown registration for the boot window. */
  onSpawn?: (terminateSync: () => void) => void;
}

export interface ServicesUpCommandOptions {
  config?: string;
  env?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

const SCHEMA = "urn:cairntrace.dev:services-up:v1" as const;

/** Start the services and write the owner lock. Never throws. */
export async function servicesUp(
  opts: ServicesUpOptions = {},
): Promise<ServicesUpResult> {
  const startedAtMs = Date.now();
  const result = ({
    ok,
    exitCode,
    ...fields
  }: Partial<ServicesUpResult> &
    Pick<ServicesUpResult, "ok" | "exitCode">): ServicesUpResult => ({
    // Verdict and identity first; `fields` keeps its own key order.
    $schema: SCHEMA,
    version: "1",
    ok,
    exitCode,
    ...fields,
    phases: fields.phases ?? {},
    events: fields.events ?? [],
    warnings: fields.warnings ?? [],
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  let target: ServicesTarget;
  try {
    target = await resolveServicesTarget(opts, "required");
  } catch (e) {
    return result({
      ok: false,
      exitCode: e instanceof ServicesCommandError ? e.exitCode : 2,
      error: (e as Error).message,
    });
  }
  const identity = {
    project: target.project,
    env: target.envName,
    configPath: target.configPath,
  };
  if (!target.services) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      warnings: target.warnings,
      error: noServicesMessage(target),
    });
  }

  // One lock per config: environments of a config share its stack.
  const before = await readServicesLock(target.configPath);
  const warnings = [...target.warnings];
  if (before.state === "held" && before.lock.env !== target.envName) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      lockPath: before.path,
      warnings,
      error:
        `services of ${target.configPath} are already up for env "${before.lock.env}" ` +
        `(${describeServicesLock(before.lock)}); environments of one config share its stack ` +
        `(compose project, tmux session). Stop them first with \`cairn services down --env ${before.lock.env}\`.`,
    });
  }
  if (before.state === "unreadable") {
    warnings.push(
      `replacing an unreadable services lock (${before.reason}): ${before.path}`,
    );
  }

  let events: ServicesEvent[];
  try {
    const handle = await startServicesPlan(
      {
        cfg: target.services,
        coldStart: isTruthyEnv(process.env.CI),
        configDir: target.configDir,
        project: target.project,
        configPath: target.configPath,
        envName: target.envName,
        ...(target.gates ? { gates: target.gates } : {}),
      },
      target.scopedSecrets,
      opts.onSpawn ?? (() => undefined),
      {
        log: opts.log ?? (() => undefined),
        logDetail: opts.logDetail ?? (() => undefined),
        onOutput: opts.onOutput ?? (() => undefined),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    events = handle.events;
  } catch (e) {
    return result({
      ...identity,
      ok: false,
      exitCode: e instanceof ServicesError ? 2 : configErrorExitCode(e),
      warnings,
      error: target.redactor.text((e as Error).message),
    });
  }

  const lock: ServicesOwnerLock = {
    version: 1,
    owner: "services-up",
    project: target.project,
    env: target.envName,
    // Canonical: it keys the lock file (one lock per config file).
    configPath: await canonicalConfigPath(target.configPath),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    by: opts.by ?? "cli",
  };
  const redactedEvents = target.redactor.value(events);
  let lockPath: string;
  try {
    lockPath = await writeServicesLock(lock);
  } catch (e) {
    return result({
      ...identity,
      ok: false,
      exitCode: 2,
      phases: phasesFromEvents(redactedEvents),
      events: redactedEvents,
      warnings,
      error: `services started but the lock could not be written (${(e as Error).message}); stop them with \`cairn services down --env ${target.envName}\``,
    });
  }
  return result({
    ...identity,
    ok: true,
    exitCode: 0,
    lockPath,
    lock,
    ...(before.state === "held" ? { replacedLock: before.lock } : {}),
    phases: phasesFromEvents(redactedEvents),
    events: redactedEvents,
    warnings,
  });
}

/** What each phase did, read from the lifecycle events. */
export function phasesFromEvents(
  events: readonly ServicesEvent[],
): ServicesUpResult["phases"] {
  const has = (phase: ServicesEvent["phase"], event: string): boolean =>
    events.some((e) => e.phase === phase && e.event === event);
  const phases: ServicesUpResult["phases"] = {};
  if (has("docker", "reuse")) phases.docker = "reused";
  else if (has("docker", "start")) phases.docker = "started";
  if (has("seed", "start")) phases.seed = "ran";
  else if (has("seed", "skip")) phases.seed = "skipped";
  if (has("tmux", "recreate")) phases.tmux = "recreated";
  else if (has("tmux", "start")) phases.tmux = "created";
  else if (has("tmux", "reuse")) phases.tmux = "reused";
  return phases;
}

/** `cairn services up` — CLI wrapper (stdout: the result; stderr: narration). */
export async function servicesUpCommand(
  opts: ServicesUpCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const services = log.scope("services");
  let untrack: (() => void) | undefined;
  const result = await servicesUp({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    by: "cli",
    log: (m) => services.info(m),
    logDetail: (m) => services.debug(m),
    onOutput: (chunk) => log.raw(chunk),
    // Ctrl-C during the boot tears down what started (run semantics); once
    // the services are up they are left running on exit.
    onSpawn: (terminateSync) => {
      untrack = trackServices({ terminateSync });
    },
  });
  untrack?.();
  process.stdout.write(emit(format, result, renderServicesUpMarkdown));
  if (format === "md") process.stdout.write("\n");
  if (!result.ok && format !== "md" && result.error) {
    process.stderr.write(`error: ${result.error}\n`);
  }
  process.exitCode = result.exitCode;
}

export function renderServicesUpMarkdown(r: ServicesUpResult): string {
  const lines = ["# Services up", ""];
  if (r.project) lines.push(`- project: ${r.project}`);
  if (r.env) lines.push(`- env: ${r.env}`);
  if (r.configPath) lines.push(`- config: ${r.configPath}`);
  if (!r.ok) {
    lines.push(`- status: failed (exit ${r.exitCode})`);
    if (r.error) lines.push("", r.error);
  } else {
    lines.push("- status: up (left running)");
    for (const [phase, what] of Object.entries(r.phases)) {
      lines.push(`- ${phase}: ${what}`);
    }
    if (r.lockPath) lines.push(`- lock: ${r.lockPath}`);
    if (r.replacedLock) {
      lines.push(`- replaced lock from ${r.replacedLock.startedAt}`);
    }
    lines.push(
      "",
      `Run specs against them with \`cairn run <spec> --env ${r.env} --reuse-services\`; ` +
        `stop them with \`cairn services down --env ${r.env}\`.`,
    );
  }
  if (r.warnings.length > 0) {
    lines.push("", "## Warnings", ...r.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}
