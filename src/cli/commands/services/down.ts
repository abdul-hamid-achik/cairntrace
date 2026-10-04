import {
  describeServicesLock,
  readServicesLock,
  removeServicesLock,
  teardownServices,
  type ServicesTeardownReport,
} from "../../../core/runner/services";
import {
  teardownCommand,
  type TeardownEntry,
} from "../../../core/runPolicy/schema";
import type { ServicesDownResult } from "../../../core/schema/services.v1";
import { emit, resolveFormat } from "../../format";
import { log } from "../../logger";
import {
  guardServicesRunLock,
  runLockMarkdownLine,
  runLockTargetOf,
  servicesLockArgv,
} from "./runLock";
import {
  noServicesMessage,
  resolveServicesTarget,
  ServicesCommandError,
  type ServicesTarget,
} from "./target";

/**
 * `cairn services down`: full teardown of the config services — the
 * configured `teardown` commands in order (no reuse skipping: `docker compose
 * down` and `tmux kill-session` run when the config lists them; a docker
 * phase no teardown command stops is warned about), then the tmux session if
 * it is still running — and removal of the config's `cairn services up`
 * owner lock. Works without a lock too (a stack a run left alive for reuse);
 * refuses (exit 4, nothing torn down) while the lock is held for another
 * environment of the config, and while a live `cairn run` holds the config's
 * `run.lock` (that run owns the stack and tears it down itself; the lock
 * is taken for the teardown otherwise).
 */

/** Whether a teardown command list stops the docker phase. */
function stopsDocker(teardown: readonly TeardownEntry[] | undefined): boolean {
  return (teardown ?? [])
    .map(teardownCommand)
    .some((command) =>
      /\bdocker(?:\s+compose|-compose)\b.*\b(?:down|stop|kill|rm)\b|\bdocker\s+(?:stop|kill|rm)\b/.test(
        command,
      ),
    );
}

export interface ServicesDownOptions {
  config?: string;
  env?: string;
  cwd?: string;
  /** Who runs the teardown (recorded in the run lock it takes). */
  by?: "cli" | "mcp";
  /** Lifecycle narration (redacted). */
  log?: (message: string) => void;
}

export interface ServicesDownCommandOptions {
  config?: string;
  env?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

const SCHEMA = "urn:cairntrace.dev:services-down:v1" as const;

/** Tear the services down and remove the owner lock. Never throws. */
export async function servicesDown(
  opts: ServicesDownOptions = {},
): Promise<ServicesDownResult> {
  const startedAtMs = Date.now();
  const result = ({
    ok,
    exitCode,
    ...fields
  }: Partial<ServicesDownResult> &
    Pick<ServicesDownResult, "ok" | "exitCode">): ServicesDownResult => ({
    // Verdict and identity first; `fields` keeps its own key order.
    $schema: SCHEMA,
    version: "1",
    ok,
    exitCode,
    ...fields,
    teardown: fields.teardown ?? [],
    tmuxKilled: fields.tmuxKilled ?? false,
    events: fields.events ?? [],
    warnings: fields.warnings ?? [],
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  let target: ServicesTarget;
  try {
    target = await resolveServicesTarget(opts, "best-effort", "teardown");
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
  const warnings = [...target.warnings];
  // One lock per config: environments of a config share its stack.
  const lockState = await readServicesLock(target.configPath);
  const redact = (text: string): string => target.redactor.text(text);
  if (lockState.state === "held" && lockState.lock.env !== target.envName) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      lockPath: lockState.path,
      lockState: lockState.state,
      warnings,
      error:
        `services of ${target.configPath} are up for env "${lockState.lock.env}" ` +
        `(${describeServicesLock(lockState.lock)}), not "${target.envName}"; nothing was torn down. ` +
        `Stop them with \`cairn services down --env ${lockState.lock.env}\`.`,
    });
  }

  // A live run of this config owns the stack: never tear it down under it.
  const guard = await guardServicesRunLock(runLockTargetOf(target), {
    command: "services down",
    origin: opts.by ?? "cli",
    argv: servicesLockArgv("services down", opts),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  if (guard.refusal) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      lockPath: lockState.path,
      lockState: lockState.state,
      ...(guard.report ? { runLock: guard.report } : {}),
      warnings,
      error: redact(guard.refusal),
    });
  }
  try {
    let report: ServicesTeardownReport = {
      steps: [],
      tmuxKilled: false,
      tunnels: [],
      events: [],
    };
    if (target.services) {
      if (target.services.docker && !stopsDocker(target.services.teardown)) {
        warnings.push(
          "services.docker is configured but no teardown command stops it " +
            "(e.g. `docker compose down`); its containers keep running",
        );
      }
      report = await teardownServices(target.services, {
        configDir: target.configDir,
        configPath: target.configPath,
        project: target.project,
        envName: target.envName,
        env: target.scopedSecrets.childEnv,
        ...(target.scopedSecrets.selectedKeys
          ? { selectedTvaultKeys: target.scopedSecrets.selectedKeys }
          : {}),
        log: (m) => opts.log?.(redact(m)),
      });
    } else {
      warnings.push(`${noServicesMessage(target)}; nothing to tear down`);
    }

    let lockError: string | undefined;
    if (lockState.state !== "absent") {
      try {
        await removeServicesLock(target.configPath);
      } catch (e) {
        lockError = `could not remove the services lock ${lockState.path}: ${(e as Error).message}`;
      }
    }

    const failed = report.steps.filter((step) => !step.ok);
    // A critical entry (and a provisioner's `down`) that failed is exit 8, the
    // same as in a run: the resource may still exist.
    const criticalFailed = failed.some((step) => step.critical);
    const problems = [
      ...(failed.length > 0
        ? [
            `${failed.length} teardown command(s) failed: ${failed
              .map((step) =>
                redact(
                  `${step.command} (${
                    step.exitCode !== undefined
                      ? `exit ${step.exitCode}`
                      : (step.error ?? "error")
                  })`,
                ),
              )
              .join("; ")}`,
          ]
        : []),
      ...(lockError ? [lockError] : []),
    ];
    return result({
      ...identity,
      ok: problems.length === 0,
      exitCode: problems.length === 0 ? 0 : criticalFailed ? 8 : 2,
      lockPath: lockState.path,
      lockState: lockState.state,
      ...(lockState.state === "held" && !lockError
        ? { removedLock: lockState.lock }
        : {}),
      ...(guard.report ? { runLock: guard.report } : {}),
      teardown: report.steps.map((step) => ({
        command: redact(step.command),
        ok: step.ok,
        ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
        ...(step.error !== undefined ? { error: redact(step.error) } : {}),
        ...(step.critical ? { critical: true } : {}),
        ...(step.provisioner ? { provisioner: true } : {}),
        ...(step.timedOut ? { timedOut: true } : {}),
      })),
      ...(report.tunnels.length > 0 ? { tunnels: report.tunnels } : {}),
      ...(report.tmuxSession ? { tmuxSession: report.tmuxSession } : {}),
      tmuxKilled: report.tmuxKilled,
      events: target.redactor.value(report.events),
      warnings,
      ...(problems.length > 0 ? { error: problems.join("\n") } : {}),
    });
  } finally {
    guard.release();
  }
}

/** `cairn services down` — CLI wrapper (stdout: the result; stderr: narration). */
export async function servicesDownCommand(
  opts: ServicesDownCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const services = log.scope("services");
  const result = await servicesDown({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    by: "cli",
    log: (m) => services.info(m),
  });
  process.stdout.write(emit(format, result, renderServicesDownMarkdown));
  if (format === "md") process.stdout.write("\n");
  if (!result.ok && format !== "md" && result.error) {
    process.stderr.write(`error: ${result.error}\n`);
  }
  process.exitCode = result.exitCode;
}

export function renderServicesDownMarkdown(r: ServicesDownResult): string {
  const lines = ["# Services down", ""];
  if (r.project) lines.push(`- project: ${r.project}`);
  if (r.env) lines.push(`- env: ${r.env}`);
  if (r.configPath) lines.push(`- config: ${r.configPath}`);
  lines.push(`- status: ${r.ok ? "down" : `incomplete (exit ${r.exitCode})`}`);
  for (const step of r.teardown) {
    lines.push(
      `- teardown: ${step.command} — ${
        step.ok
          ? "ok"
          : step.exitCode !== undefined
            ? `exit ${step.exitCode}`
            : (step.error ?? "failed")
      }`,
    );
  }
  for (const tunnel of r.tunnels ?? []) {
    lines.push(`- tunnel "${tunnel.name}": ${tunnel.result}`);
  }
  if (r.tmuxSession) {
    lines.push(
      `- tmux session "${r.tmuxSession}": ${
        r.tmuxKilled ? "killed" : "not running"
      }`,
    );
  }
  if (r.lockState) {
    lines.push(
      `- lock: ${
        r.removedLock
          ? `removed (held since ${r.removedLock.startedAt})`
          : r.lockState === "absent"
            ? "none"
            : r.lockState
      }`,
    );
  }
  const runLock = runLockMarkdownLine(r.runLock);
  if (runLock) lines.push(runLock);
  if (r.error) lines.push("", r.error);
  if (r.warnings.length > 0) {
    lines.push("", "## Warnings", ...r.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}
