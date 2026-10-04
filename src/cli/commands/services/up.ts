import {
  canonicalConfigPath,
  describeServicesLock,
  readServicesLock,
  ServicesError,
  writeServicesLock,
  type CriticalTeardownFailure,
  type ServicesEvent,
} from "../../../core/runner/services";
import type { ServicesConfig } from "../../../core/schema/config.v1";
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
  guardServicesRunLock,
  runLockMarkdownLine,
  runLockTargetOf,
  servicesLockArgv,
  type ServicesRunLockGuard,
} from "./runLock";
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
 * Refuses (exit 4) while a live `cairn run` holds the config's `run.lock`,
 * and holds that lock itself for the boot.
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

  // A live run of this config owns the stack: never boot into it.
  const guard = await guardServicesRunLock(runLockTargetOf(target), {
    command: "services up",
    origin: opts.by ?? "cli",
    argv: servicesLockArgv("services up", opts),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  if (guard.refusal) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      lockPath: before.path,
      ...(guard.report ? { runLock: guard.report } : {}),
      warnings,
      error: target.redactor.text(guard.refusal),
    });
  }
  try {
    return await bootUnderRunLock(
      target,
      target.services,
      opts,
      guard,
      before,
      warnings,
      result,
    );
  } finally {
    guard.release();
  }
}

/** The boot itself, while the run lock (if any) is held. */
async function bootUnderRunLock(
  target: ServicesTarget,
  services: ServicesConfig,
  opts: ServicesUpOptions,
  guard: ServicesRunLockGuard,
  before: Awaited<ReturnType<typeof readServicesLock>>,
  warnings: string[],
  result: (
    fields: Partial<ServicesUpResult> &
      Pick<ServicesUpResult, "ok" | "exitCode">,
  ) => ServicesUpResult,
): Promise<ServicesUpResult> {
  const identity = {
    project: target.project,
    env: target.envName,
    configPath: target.configPath,
    ...(guard.report ? { runLock: guard.report } : {}),
  };

  // Collected live: a failed boot returns no handle, but its events (the
  // failure cleanup's teardown included) belong in the result.
  const live: ServicesEvent[] = [];
  let events: ServicesEvent[];
  try {
    const handle = await startServicesPlan(
      {
        cfg: services,
        coldStart: isTruthyEnv(process.env.CI),
        configDir: target.configDir,
        project: target.project,
        configPath: target.configPath,
        envName: target.envName,
        // cairn exits right after the boot: nothing could supervise.
        supervise: false,
        ...(target.gates ? { gates: target.gates } : {}),
      },
      target.scopedSecrets,
      opts.onSpawn ?? (() => undefined),
      {
        log: opts.log ?? (() => undefined),
        logDetail: opts.logDetail ?? (() => undefined),
        onOutput: opts.onOutput ?? (() => undefined),
        onEvent: (event) => live.push(event),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    events = handle.events;
  } catch (e) {
    // A critical teardown entry (the provisioner's `down`) the failure
    // cleanup could not complete: a resource may still exist (exit 8).
    const critical = criticalFailuresOf(e);
    const redactedEvents = target.redactor.value(live);
    return result({
      ...identity,
      ok: false,
      exitCode:
        critical.length > 0
          ? 8
          : e instanceof ServicesError
            ? 2
            : configErrorExitCode(e),
      phases: phasesFromEvents(redactedEvents),
      events: redactedEvents,
      ...(critical.length > 0
        ? {
            teardown: critical.map((failure) => ({
              command: target.redactor.text(failure.command),
              ok: false,
              critical: true,
              ...(failure.provisioner ? { provisioner: true } : {}),
              ...(failure.exitCode !== undefined
                ? { exitCode: failure.exitCode }
                : {}),
              ...(failure.timedOut ? { timedOut: true } : {}),
              ...(failure.error ? { error: failure.error } : {}),
            })),
          }
        : {}),
      warnings,
      error:
        target.redactor.text((e as Error).message) +
        (critical.length > 0
          ? `\nCRITICAL: the failure cleanup could not complete ${critical
              .map((failure) => target.redactor.text(failure.command))
              .join(", ")}; a provisioned resource may still exist`
          : ""),
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

/** Critical teardown failures a failed boot carries (startServices). */
function criticalFailuresOf(error: unknown): CriticalTeardownFailure[] {
  const failures = (error as { criticalTeardownFailures?: unknown } | null)
    ?.criticalTeardownFailures;
  return Array.isArray(failures) ? (failures as CriticalTeardownFailure[]) : [];
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
  if (has("provisioner", "ready")) phases.provisioner = "up";
  const tunnels = events
    .filter((e) => e.phase === "tunnel" && e.event === "ready")
    .map((e) => String(e.data?.tunnel ?? ""))
    .filter((name) => name !== "");
  if (tunnels.length > 0) phases.tunnels = tunnels;
  const written = events.filter(
    (e) => e.phase === "files" && e.event === "write",
  ).length;
  if (written > 0) phases.files = written;
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
    for (const step of r.teardown ?? []) {
      lines.push(
        `- CRITICAL teardown failed: ${step.command}${
          step.timedOut
            ? " (timed out)"
            : step.exitCode !== undefined
              ? ` (exit ${step.exitCode})`
              : ""
        }`,
      );
    }
  } else {
    lines.push("- status: up (left running)");
    for (const [phase, what] of Object.entries(r.phases)) {
      lines.push(`- ${phase}: ${what}`);
    }
    if (r.lockPath) lines.push(`- lock: ${r.lockPath}`);
    if (r.replacedLock) {
      lines.push(`- replaced lock from ${r.replacedLock.startedAt}`);
    }
    if (r.phases.tunnels) {
      lines.push(
        "- tunnels: left running, not supervised (cairn exits after the boot); `cairn services down` stops them",
      );
    }
    lines.push(
      "",
      `Run specs against them with \`cairn run <spec> --env ${r.env} --reuse-services\`; ` +
        `stop them with \`cairn services down --env ${r.env}\`.`,
    );
  }
  const runLock = runLockMarkdownLine(r.runLock);
  if (runLock) lines.push("", runLock);
  if (r.warnings.length > 0) {
    lines.push("", "## Warnings", ...r.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}
