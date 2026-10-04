import { canonicalConfigPath } from "../../../core/runner/services";
import {
  acquireRunLock,
  describeRunLockOwner,
  peekRunLock,
  RUN_LOCK_ENV,
  RunLockRefusedError,
  runLockPath,
  runLockTarget,
  type RunLockHandle,
  type RunLockOwnerInfo,
  type RunLockTarget,
} from "../../../core/runPolicy/lock";
import type { ProcessProbe } from "../../../core/runPolicy/processProbe";
import {
  mergeRunPolicy,
  type RunPolicyConfig,
} from "../../../core/runPolicy/schema";
import type { Config } from "../../../core/schema/config.v1";
import type { ServicesRunLock } from "../../../core/schema/services.v1";

/**
 * `cairn services up | down | restart` (and their MCP tools) under the config
 * `run: { lock }`: a live `cairn run` of the same config (or project) owns
 * the stack — its provisioner, tunnels, containers and windows — so these
 * commands refuse (exit 4, nothing touched) while it holds the lock, and
 * otherwise take the lock themselves for their duration, so a run that
 * starts meanwhile refuses instead of booting into a half-torn-down stack.
 * A dead owner's lock is reclaimed as a run reclaims it (unless
 * `staleAfterPidDead: false`). A command the lock's owner started itself (a
 * suite hook, a `run:` step: its env names the lock in `CAIRN_RUN_LOCK`)
 * runs under the owner's lock. Without a configured `run.lock` nothing
 * changes.
 */

export type ServicesLockCommand =
  | "services up"
  | "services down"
  | "services restart";

/** The parts of a services target the guard needs. */
export interface ServicesRunLockTarget {
  configPath: string;
  configDir: string;
  envName: string;
  /** The config's `project:` (project-scope locks). */
  project?: string;
  /** The loaded config (every environment's `run.lock`). */
  config?: Pick<Config, "run" | "environments">;
  /** The selected environment's effective `run:` policy. */
  runPolicy?: RunPolicyConfig;
}

export interface ServicesRunLockOptions {
  command: ServicesLockCommand;
  origin: "cli" | "mcp";
  /** The command line recorded in the lock. */
  argv: readonly string[];
  cwd?: string;
  /** Where `CAIRN_RUN_LOCK` is read (default process.env). */
  env?: Record<string, string | undefined>;
  /** Test seams. */
  root?: string;
  probe?: ProcessProbe;
}

export interface ServicesRunLockGuard {
  /** Present when the command must not run (exit 4). */
  refusal?: string;
  /** What the guard did, for the command's result. */
  report?: ServicesRunLock;
  /** Release the lock this command took (idempotent; a no-op otherwise). */
  release(): void;
}

type LockOptions = { scope: "project" | "config"; staleAfterPidDead: boolean };

function lockOptions(
  policy: RunPolicyConfig | undefined,
): LockOptions | undefined {
  const lock = policy?.lock;
  if (lock === undefined || lock === false) return undefined;
  const object = lock === true ? {} : lock;
  return {
    scope: object.scope ?? "config",
    staleAfterPidDead: object.staleAfterPidDead !== false,
  };
}

/** Every lock scope the config declares (top level or any environment). */
function declaredScopes(
  config: ServicesRunLockTarget["config"],
): Set<"project" | "config"> {
  const scopes = new Set<"project" | "config">();
  if (!config) return scopes;
  const add = (policy: RunPolicyConfig | undefined): void => {
    const options = lockOptions(policy);
    if (options) scopes.add(options.scope);
  };
  add(config.run);
  for (const environment of Object.values(config.environments)) {
    add(mergeRunPolicy(config.run, environment.run));
  }
  return scopes;
}

function ownerReport(
  owner: RunLockOwnerInfo,
): NonNullable<ServicesRunLock["owner"]> {
  return {
    pid: owner.pid,
    startedAt: owner.startedAt,
    ageSeconds: owner.ageSeconds,
    alive: owner.alive,
    ...(owner.invocationId ? { invocationId: owner.invocationId } : {}),
    ...(owner.origin ? { origin: owner.origin } : {}),
    ...(owner.env ? { env: owner.env } : {}),
    ...(owner.command ? { command: owner.command } : {}),
  };
}

const PAST: Record<ServicesLockCommand, string> = {
  "services up": "started",
  "services down": "torn down",
  "services restart": "restarted",
};

/** How to get out of a refusal (never by force: stop the owner instead). */
function remedy(
  command: ServicesLockCommand,
  owner?: RunLockOwnerInfo,
): string {
  const kill = owner
    ? ` (Ctrl-C in its terminal, or \`kill ${owner.pid}\`)`
    : "";
  return command === "services down"
    ? `A live run tears its own services down when it ends: stop it${kill} and its teardown runs, the provisioner's \`down\` included. Once its process is gone the lock is reclaimed and \`cairn services down\` runs.`
    : `Run it after that run ends${kill ? `, or stop the run${kill}` : ""}.`;
}

/** Take (or respect) the run lock for a services command. Never throws. */
export async function guardServicesRunLock(
  target: ServicesRunLockTarget,
  opts: ServicesRunLockOptions,
): Promise<ServicesRunLockGuard> {
  const none: ServicesRunLockGuard = { release: () => undefined };
  const own = lockOptions(target.runPolicy);
  const scopes = declaredScopes(target.config);
  if (own) scopes.add(own.scope);
  if (scopes.size === 0) return none;

  const configKey = await canonicalConfigPath(target.configPath);
  const targetOf = (scope: "project" | "config"): RunLockTarget =>
    runLockTarget({
      scope,
      configKey,
      configPath: target.configPath,
      configDir: target.configDir,
      ...(target.project ? { project: target.project } : {}),
    });
  const targets = new Map<string, RunLockTarget>();
  for (const scope of scopes) {
    const lockTarget = targetOf(scope);
    targets.set(lockTarget.key, lockTarget);
  }
  const pathOf = (lockTarget: RunLockTarget): string =>
    runLockPath(lockTarget.key, lockTarget.label, opts.root);
  const verb = opts.command.replace("services ", "");

  // Started by the owner of a live lock of this config: run under it.
  const inherited = (opts.env ?? process.env)[RUN_LOCK_ENV];
  if (inherited) {
    for (const lockTarget of targets.values()) {
      if (pathOf(lockTarget) !== inherited) continue;
      const peek = peekRunLock(inherited, opts.probe);
      if (peek.state === "live") {
        return {
          report: {
            path: inherited,
            scope: lockTarget.scope,
            state: "nested",
            owner: ownerReport(peek.owner),
          },
          release: () => undefined,
        };
      }
    }
  }

  // A live owner of any lock this config declares refuses the command.
  const ownTarget = own ? targetOf(own.scope) : undefined;
  for (const lockTarget of targets.values()) {
    if (ownTarget && lockTarget.key === ownTarget.key) continue;
    const peek = peekRunLock(pathOf(lockTarget), opts.probe);
    if (peek.state !== "live") continue;
    return {
      refusal:
        `refusing to ${verb} the services of env "${target.envName}": another cairn ${
          peek.lock.command ?? "run"
        } holds the run lock for ${lockTarget.displayName} (${lockTarget.scope} scope): ` +
        `${describeRunLockOwner(peek.owner, peek.lock.argv)}; nothing was ${PAST[opts.command]}. ` +
        `${remedy(opts.command, peek.owner)} The lock file is ${peek.path}`,
      report: {
        path: peek.path,
        scope: lockTarget.scope,
        state: "refused",
        reason: "held",
        owner: ownerReport(peek.owner),
      },
      release: () => undefined,
    };
  }
  if (!own || !ownTarget) return none;

  let handle: RunLockHandle;
  try {
    handle = acquireRunLock({
      scope: ownTarget.scope,
      staleAfterPidDead: own.staleAfterPidDead,
      key: ownTarget.key,
      label: ownTarget.label,
      displayName: ownTarget.displayName,
      origin: opts.origin,
      env: target.envName,
      argv: opts.argv,
      cwd: opts.cwd ?? process.cwd(),
      command: opts.command,
      ...(opts.root ? { root: opts.root } : {}),
      ...(opts.probe ? { probe: opts.probe } : {}),
    });
  } catch (error) {
    if (!(error instanceof RunLockRefusedError)) {
      return {
        refusal: `refusing to ${verb} the services of env "${target.envName}": the run lock could not be taken (${(error as Error).message}); nothing was ${PAST[opts.command]}`,
        release: () => undefined,
      };
    }
    return {
      refusal:
        `refusing to ${verb} the services of env "${target.envName}": ${error.message}; nothing was ${PAST[opts.command]}. ` +
        (error.reason === "held" ? remedy(opts.command, error.owner) : ""),
      report: {
        path: error.path,
        scope: error.scope,
        state: "refused",
        reason: error.reason,
        ...(error.owner ? { owner: ownerReport(error.owner) } : {}),
      },
      release: () => undefined,
    };
  }
  return {
    report: {
      path: handle.path,
      scope: handle.scope,
      state: handle.reclaimed ? "reclaimed" : "held",
      ...(handle.reclaimed ? { owner: ownerReport(handle.reclaimed) } : {}),
    },
    release: () => {
      handle.release();
    },
  };
}

/** The guard's view of a resolved services target. */
export function runLockTargetOf(target: {
  configPath: string;
  configDir: string;
  envName: string;
  configProject?: string;
  runPolicy?: RunPolicyConfig;
  lockConfig?: Pick<Config, "run" | "environments">;
}): ServicesRunLockTarget {
  return {
    configPath: target.configPath,
    configDir: target.configDir,
    envName: target.envName,
    ...(target.configProject ? { project: target.configProject } : {}),
    ...(target.lockConfig ? { config: target.lockConfig } : {}),
    ...(target.runPolicy ? { runPolicy: target.runPolicy } : {}),
  };
}

/** The command line a services command records in the lock. */
export function servicesLockArgv(
  command: ServicesLockCommand,
  opts: { config?: string; env?: string; windows?: readonly string[] },
): string[] {
  return [
    ...command.split(" "),
    ...(opts.windows ?? []),
    ...(opts.env !== undefined ? ["--env", opts.env] : []),
    ...(opts.config !== undefined ? ["--config", opts.config] : []),
  ];
}

/** The markdown line of a run lock report (none without one). */
export function runLockMarkdownLine(
  report: ServicesRunLock | undefined,
): string | undefined {
  if (!report) return undefined;
  const owner = report.owner
    ? ` (pid ${report.owner.pid}${
        report.owner.command ? `, ${report.owner.command}` : ""
      }${report.owner.env ? `, env "${report.owner.env}"` : ""})`
    : "";
  const what =
    report.state === "held"
      ? "held for this command, released when it ended"
      : report.state === "reclaimed"
        ? `reclaimed from an owner that was gone${owner}, released when this command ended`
        : report.state === "nested"
          ? `ran under the lock of the run that started it${owner}`
          : `refused (${report.reason ?? "held"})${owner}`;
  return `- run lock (${report.scope} scope): ${what}`;
}
