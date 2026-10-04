import {
  describeServicesLock,
  readServicesLock,
  restartTmuxWindows,
  servicesStateRoot,
  ServicesRefusedError,
  type ServicesEvent,
} from "../../../core/runner/services";
import { liveSupervisor } from "../../../core/servicesOps/supervisorMarker";
import { DurationSchema, durationMs } from "../../../core/gates/schema";
import type { ServicesRestartResult } from "../../../core/schema/services.v1";
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
 * `cairn services restart <window...>`: restart tmux service windows of the
 * configured session: Ctrl-C, wait for the pane's process to exit, clear the
 * history, resend the window's command and wait for `readyOn` of the NEW
 * generation (text below a restart marker, so stale scrollback never counts).
 * Refuses (exit 4, nothing touched) when the session is not running, a name
 * is not a window of the configured session, or a live `cairn run` holds the
 * config's `run.lock` (the lock is taken for the restart otherwise).
 */

export interface ServicesRestartOptions {
  config?: string;
  env?: string;
  cwd?: string;
  windows: readonly string[];
  /** Duration (`30s`, `2m`, or milliseconds). */
  stopTimeout?: string;
  readyTimeout?: string;
  log?: (message: string) => void;
  /** Who restarts (recorded in the run lock it takes). */
  by?: "cli" | "mcp";
}

export interface ServicesRestartCommandOptions {
  config?: string;
  env?: string;
  stopTimeout?: string;
  readyTimeout?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

const SCHEMA = "urn:cairntrace.dev:services-restart:v1" as const;

/** A duration flag as milliseconds; a bad value is a usage error (exit 2). */
export function parseDurationFlag(
  flag: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const candidate = /^\d+$/.test(value) ? Number(value) : value;
  const parsed = DurationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ServicesCommandError(
      `${flag} ${value}: use milliseconds or a number with ms|s|m|h (e.g. 30s)`,
      2,
    );
  }
  return durationMs(parsed.data);
}

/** Restart the windows. Never throws. */
export async function servicesRestart(
  opts: ServicesRestartOptions,
): Promise<ServicesRestartResult> {
  const startedAtMs = Date.now();
  const result = ({
    ok,
    exitCode,
    ...fields
  }: Partial<ServicesRestartResult> &
    Pick<ServicesRestartResult, "ok" | "exitCode">): ServicesRestartResult => ({
    $schema: SCHEMA,
    version: "1",
    ok,
    exitCode,
    ...fields,
    windows: fields.windows ?? [],
    events: fields.events ?? [],
    warnings: fields.warnings ?? [],
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  let stopTimeoutMs: number | undefined;
  let readyTimeoutMs: number | undefined;
  try {
    stopTimeoutMs = parseDurationFlag("--stop-timeout", opts.stopTimeout);
    readyTimeoutMs = parseDurationFlag("--ready-timeout", opts.readyTimeout);
  } catch (e) {
    return result({
      ok: false,
      exitCode: e instanceof ServicesCommandError ? e.exitCode : 2,
      error: (e as Error).message,
    });
  }
  if (opts.windows.length === 0) {
    return result({
      ok: false,
      exitCode: 2,
      error:
        "name at least one window to restart (cairn services restart <window...>)",
    });
  }
  let target: ServicesTarget;
  try {
    target = await resolveServicesTarget(opts, "best-effort");
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
  if (!target.services) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      warnings,
      error: noServicesMessage(target),
    });
  }
  const tmux = target.services.tmux;
  if (!tmux) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      warnings,
      error: `no tmux session is configured for env "${target.envName}" in ${target.configPath}; there are no windows to restart`,
    });
  }
  const lock = await readServicesLock(target.configPath);
  if (lock.state === "held" && lock.lock.env !== target.envName) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      warnings,
      error:
        `services of ${target.configPath} are up for env "${lock.lock.env}" ` +
        `(${describeServicesLock(lock.lock)}), not "${target.envName}"; nothing was restarted. ` +
        `Use \`--env ${lock.lock.env}\`.`,
    });
  }
  // A run that supervises this session restarts its windows itself; a
  // second restarter would race it over the same panes.
  const supervisor = liveSupervisor(servicesStateRoot(), tmux.session);
  if (supervisor) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      session: tmux.session,
      warnings,
      error:
        `a cairn run (pid ${supervisor.pid}) is supervising tmux session "${tmux.session}" ` +
        `(windows: ${supervisor.windows.join(", ") || "none"}); nothing was restarted. ` +
        "Let that run restart its windows, or restart after it ends.",
    });
  }
  // A live run of this config uses these windows: never restart under it.
  const guard = await guardServicesRunLock(runLockTargetOf(target), {
    command: "services restart",
    origin: opts.by ?? "cli",
    argv: servicesLockArgv("services restart", opts),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  if (guard.refusal) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      session: tmux.session,
      ...(guard.report ? { runLock: guard.report } : {}),
      warnings,
      error: target.redactor.text(guard.refusal),
    });
  }
  const reported = {
    ...identity,
    ...(guard.report ? { runLock: guard.report } : {}),
  };
  const redact = (text: string): string => target.redactor.text(text);
  const events: ServicesEvent[] = [];
  try {
    const report = await restartTmuxWindows(
      tmux,
      {
        configDir: target.configDir,
        project: target.project,
        env: target.scopedSecrets.childEnv,
        ...(target.scopedSecrets.selectedKeys
          ? { selectedTvaultKeys: target.scopedSecrets.selectedKeys }
          : {}),
        secretValues: target.scopedSecrets.secretValues,
        ...(target.gates ? { gates: target.gates } : {}),
        log: (m) => opts.log?.(redact(m)),
        logDetail: (m) => opts.log?.(redact(m)),
        warn: (m) => warnings.push(redact(m)),
        onEvent: (event) => events.push(event),
      },
      opts.windows,
      {
        ...(stopTimeoutMs !== undefined ? { stopTimeoutMs } : {}),
        ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
        reason: "manual",
      },
    );
    const failed = report.results.find((w) => !w.ok && !w.skipped);
    return result({
      ...reported,
      ok: !failed,
      exitCode: failed ? 2 : 0,
      session: report.session,
      windows: report.results.map((w) => ({
        window: w.window,
        ok: w.ok,
        alreadyStopped: w.alreadyStopped,
        ...(w.generation ? { generation: w.generation } : {}),
        durationMs: w.durationMs,
        ...(w.error ? { error: redact(w.error) } : {}),
        ...(w.skipped ? { skipped: true } : {}),
      })),
      events: target.redactor.value(events),
      warnings,
      ...(failed
        ? {
            error: redact(
              `window "${failed.window}": ${failed.error ?? "restart failed"}`,
            ),
          }
        : {}),
    });
  } catch (e) {
    return result({
      ...reported,
      ok: false,
      exitCode: e instanceof ServicesRefusedError ? 4 : 2,
      session: tmux.session,
      events: target.redactor.value(events),
      warnings,
      error: redact((e as Error).message),
    });
  } finally {
    guard.release();
  }
}

/** `cairn services restart` — CLI wrapper (stdout: the result; stderr: narration). */
export async function servicesRestartCommand(
  windows: string[],
  opts: ServicesRestartCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const services = log.scope("services");
  const result = await servicesRestart({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.stopTimeout !== undefined
      ? { stopTimeout: opts.stopTimeout }
      : {}),
    ...(opts.readyTimeout !== undefined
      ? { readyTimeout: opts.readyTimeout }
      : {}),
    windows,
    by: "cli",
    log: (m) => services.info(m),
  });
  process.stdout.write(emit(format, result, renderServicesRestartMarkdown));
  if (format === "md") process.stdout.write("\n");
  if (!result.ok && format !== "md" && result.error) {
    process.stderr.write(`error: ${result.error}\n`);
  }
  process.exitCode = result.exitCode;
}

export function renderServicesRestartMarkdown(
  r: ServicesRestartResult,
): string {
  const lines = ["# Services restart", ""];
  if (r.project) lines.push(`- project: ${r.project}`);
  if (r.env) lines.push(`- env: ${r.env}`);
  if (r.session) lines.push(`- session: ${r.session}`);
  lines.push(`- status: ${r.ok ? "restarted" : `failed (exit ${r.exitCode})`}`);
  for (const w of r.windows) {
    lines.push(
      `- ${w.window}: ${
        w.skipped
          ? "skipped (an earlier window failed)"
          : w.ok
            ? `ready in ${w.durationMs}ms${
                w.alreadyStopped ? " (was already stopped)" : ""
              }${w.generation ? ` [generation ${w.generation}]` : ""}`
            : `failed — ${w.error ?? "unknown error"}`
      }`,
    );
  }
  const runLock = runLockMarkdownLine(r.runLock);
  if (runLock) lines.push(runLock);
  if (r.error && r.windows.length === 0) lines.push("", r.error);
  if (r.warnings.length > 0) {
    lines.push("", "## Warnings", ...r.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}
