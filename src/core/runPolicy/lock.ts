import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { ProcessProbe } from "./processProbe";
import { systemProcessProbe } from "./processProbe";

/**
 * The run lock of the config `run: { lock }` block: at most one `cairn run`
 * (CLI or MCP, same engine) per config (or per project) at a time.
 *
 * `~/.cairntrace/locks/<label>.<sha256 of the scope key>.run.lock.json`,
 * created atomically (the complete file is written to a temp name and
 * hard-linked into place, so a reader never sees half a lock and two
 * creators cannot both win). A lock whose owner process is gone — or whose
 * pid now belongs to a younger process — is stale: reclaimed with a warning
 * (default), or refused when `staleAfterPidDead` is false. Released on every
 * exit path: the engine's finally, the signal path (`releaseSync`) and a
 * process `exit` hook.
 */

export const RunLockFileSchema = z
  .object({
    version: z.literal(1),
    /** Unique per acquisition: release only removes its own lock. */
    token: z.string().min(1),
    pid: z.number().int().positive(),
    startedAt: z.string().min(1),
    /** CLI arguments after the binary, redacted; `--var` keys only. */
    argv: z.array(z.string()),
    cwd: z.string().min(1),
    scope: z.enum(["project", "config"]),
    /** What the scope key was made of (config path or project name). */
    key: z.string().min(1),
    invocationId: z.string().min(1).optional(),
    origin: z.enum(["cli", "mcp"]).optional(),
    env: z.string().min(1).optional(),
    /**
     * What holds it: `run` (absent in older locks) or a services command
     * (`services up`, `services down`, `services restart`) that takes the
     * lock for its duration.
     */
    command: z.string().min(1).optional(),
  })
  .passthrough();
export type RunLockFile = z.infer<typeof RunLockFileSchema>;

export type RunLockRefusal = "held" | "stale" | "unreadable";

/** The lock refuses this run (exit 4). */
export class RunLockRefusedError extends Error {
  override name = "RunLockRefusedError";
  readonly exitCode = 4 as const;
  constructor(
    message: string,
    readonly reason: RunLockRefusal,
    readonly path: string,
    readonly scope: "project" | "config",
    readonly owner?: RunLockOwnerInfo,
  ) {
    super(message);
  }
}

export interface RunLockOwnerInfo {
  pid: number;
  startedAt: string;
  ageSeconds: number;
  alive: boolean;
  invocationId?: string;
  origin?: "cli" | "mcp";
  env?: string;
  /** What holds the lock (`run`, `services down`, …). */
  command?: string;
}

/**
 * The env var a run gives every process it starts (hooks, `run:` steps, the
 * services phases): the path of the run lock it holds. A `cairn services`
 * command that finds it naming a live lock runs under that lock (it was
 * started by the owner) instead of refusing.
 */
export const RUN_LOCK_ENV = "CAIRN_RUN_LOCK";

/** Directory of the run lock files. */
export function runLockRoot(): string {
  return join(homedir(), ".cairntrace", "locks");
}

function segment(value: string): string {
  return encodeURIComponent(value).replace(
    /[.!~*'()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The lock file of a scope key. `label` is only for humans listing the
 * directory.
 */
export function runLockPath(
  key: string,
  label: string,
  root: string = runLockRoot(),
): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(root, `${segment(label) || "config"}.${hash}.run.lock.json`);
}

/** Whole seconds since an ISO timestamp (0 for a bad or future one). */
function ageSeconds(startedAt: string, now: number): number {
  const started = Date.parse(startedAt);
  return Number.isFinite(started)
    ? Math.max(0, Math.floor((now - started) / 1000))
    : 0;
}

function describeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * What one run lock covers: the scope, its key (the canonical config path,
 * or `project:<name>`), the file label and how messages name it.
 */
export interface RunLockTarget {
  scope: "project" | "config";
  key: string;
  label: string;
  displayName: string;
}

/**
 * The lock target of a config for a scope. `project` needs a `project:`
 * name; without one it is the config scope (`fellBack: true`).
 */
export function runLockTarget(input: {
  scope: "project" | "config";
  /** The canonical config path (or `<dir>/(no config)` without a config). */
  configKey: string;
  configPath?: string;
  configDir: string;
  project?: string;
  /**
   * A delegated environment (`runner:`): the lock guards that environment
   * only — its runs use nothing of the local stack, so they never exclude
   * the local environments' runs (nor `cairn services` commands).
   */
  environment?: string;
}): RunLockTarget & { fellBack: boolean } {
  const useProject = input.scope === "project" && Boolean(input.project);
  const base: RunLockTarget & { fellBack: boolean } = useProject
    ? {
        scope: "project",
        key: `project:${input.project}`,
        label: input.project!,
        displayName: `project "${input.project}"`,
        fellBack: false,
      }
    : {
        scope: "config",
        key: input.configKey,
        label: runLockLabel(input.configPath, input.configDir),
        displayName: input.configPath ?? input.configDir,
        fellBack: input.scope === "project",
      };
  if (input.environment === undefined) return base;
  return {
    ...base,
    key: `${base.key}\u0000runner-env:${input.environment}`,
    label: `${base.label}-${input.environment}`,
    displayName: `${base.displayName} (delegated environment "${input.environment}")`,
  };
}

/** What a run lock file says right now, without touching it. */
export type RunLockPeek =
  | { state: "absent"; path: string }
  | { state: "unreadable"; path: string; reason: string }
  | {
      state: "live" | "dead";
      path: string;
      lock: RunLockFile;
      owner: RunLockOwnerInfo;
    };

/** Read a lock file and tell whether its owner is alive (never changes it). */
export function peekRunLock(
  path: string,
  probe: ProcessProbe = systemProcessProbe,
  now: number = Date.now(),
): RunLockPeek {
  const existing = readLock(path);
  if (!existing.ok) {
    return existing.reason === "gone"
      ? { state: "absent", path }
      : { state: "unreadable", path, reason: existing.reason };
  }
  const alive = runLockOwnerAlive(existing.lock, probe, now);
  return {
    state: alive ? "live" : "dead",
    path,
    lock: existing.lock,
    owner: ownerInfo(existing.lock, alive, now),
  };
}

export interface AcquireRunLockOptions {
  scope: "project" | "config";
  /** Reclaim a dead owner's lock (default true). */
  staleAfterPidDead?: boolean;
  /** The scope key: the canonical config path, or the project name. */
  key: string;
  /** Directory label of the lock file (config dir name or project). */
  label: string;
  /** The config the lock protects, for messages. */
  displayName: string;
  invocationId?: string;
  origin?: "cli" | "mcp";
  env?: string;
  /** Redacted argv recorded in the lock (`--var` values are dropped). */
  argv: readonly string[];
  cwd: string;
  /** What takes the lock (default `run`; a services command names itself). */
  command?: string;
  /** Defaults: `~/.cairntrace/locks`, this process, real clock and ps. */
  root?: string;
  pid?: number;
  now?: () => number;
  probe?: ProcessProbe;
}

export interface RunLockHandle {
  readonly path: string;
  readonly scope: "project" | "config";
  /** Epoch ms the lock was taken. */
  readonly acquiredAt: number;
  /** Set when a dead owner's lock was taken over. */
  readonly reclaimed?: RunLockOwnerInfo;
  /** Remove this acquisition's lock; false when it was already gone. */
  release(): boolean;
}

function readLock(
  path: string,
): { ok: true; lock: RunLockFile } | { ok: false; reason: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "gone" };
    }
    return { ok: false, reason: (error as Error).message };
  }
  try {
    const parsed = RunLockFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: `not a run lock (${
          issue
            ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
            : "invalid"
        })`,
      };
    }
    return { ok: true, lock: parsed.data };
  } catch (error) {
    return {
      ok: false,
      reason: `invalid JSON (${(error as Error).message})`,
    };
  }
}

/** Is the lock's owner still the process that took it? */
export function runLockOwnerAlive(
  lock: Pick<RunLockFile, "pid" | "startedAt">,
  probe: ProcessProbe = systemProcessProbe,
  now: number = Date.now(),
): boolean {
  if (!probe.isAlive(lock.pid)) return false;
  // A recycled pid: the live process is younger than the lock it supposedly
  // wrote (5s of slack for clock and `etime` rounding).
  const elapsed = probe.elapsedSeconds(lock.pid);
  const lockAge = ageSeconds(lock.startedAt, now);
  if (elapsed !== undefined && elapsed + 5 < lockAge) return false;
  return true;
}

function ownerInfo(
  lock: RunLockFile,
  alive: boolean,
  now: number,
): RunLockOwnerInfo {
  return {
    pid: lock.pid,
    startedAt: lock.startedAt,
    ageSeconds: ageSeconds(lock.startedAt, now),
    alive,
    ...(lock.invocationId ? { invocationId: lock.invocationId } : {}),
    ...(lock.origin ? { origin: lock.origin } : {}),
    ...(lock.env ? { env: lock.env } : {}),
    ...(lock.command ? { command: lock.command } : {}),
  };
}

/**
 * The argv a lock records and a refusal shows: `--var` keeps its keys and
 * drops its values (`--var ticket=…`). A var value is run input — often a
 * token, an id or a password — and a lock file is read by every other
 * invocation of the config, whose stderr and `--json` echo the owner.
 */
function keyOnly(pair: string): string {
  const eq = pair.indexOf("=");
  return eq > 0 ? `${pair.slice(0, eq)}=…` : "…";
}

export function argvWithoutVarValues(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--var" && i + 1 < argv.length) {
      out.push(arg, keyOnly(argv[i + 1]!));
      i += 1;
    } else if (arg.startsWith("--var=")) {
      out.push(`--var=${keyOnly(arg.slice("--var=".length))}`);
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** "pid 4242 (cli, invocation <id>, env "local"), running for 5m: cairn run a.yml". */
export function describeRunLockOwner(
  owner: RunLockOwnerInfo,
  argv?: readonly string[],
): string {
  const bits = [
    ...(owner.origin ? [owner.origin] : []),
    ...(owner.invocationId ? [`invocation ${owner.invocationId}`] : []),
    ...(owner.env ? [`env "${owner.env}"`] : []),
  ];
  // A lock written by an older cairn may still hold values: never echo them.
  const shownArgv = argv ? argvWithoutVarValues(argv) : [];
  const command = shownArgv.length > 0 ? `: cairn ${shownArgv.join(" ")}` : "";
  const shown = command.length > 200 ? `${command.slice(0, 197)}...` : command;
  return `pid ${owner.pid}${
    bits.length > 0 ? ` (${bits.join(", ")})` : ""
  }, started ${owner.startedAt} (${describeAge(owner.ageSeconds)} ago)${shown}`;
}

/**
 * Take the run lock. Throws {@link RunLockRefusedError} (exit 4) when a live
 * owner holds it (or a dead one does and `staleAfterPidDead` is false, or
 * the file is not a lock).
 */
export function acquireRunLock(opts: AcquireRunLockOptions): RunLockHandle {
  const root = opts.root ?? runLockRoot();
  const probe = opts.probe ?? systemProcessProbe;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const path = runLockPath(opts.key, opts.label, root);
  const staleOk = opts.staleAfterPidDead !== false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const token = randomBytes(8).toString("hex");
  const lock: RunLockFile = {
    version: 1,
    token,
    pid,
    startedAt: new Date(now()).toISOString(),
    argv: argvWithoutVarValues(opts.argv),
    cwd: opts.cwd,
    scope: opts.scope,
    key: opts.key,
    ...(opts.invocationId ? { invocationId: opts.invocationId } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.command && opts.command !== "run"
      ? { command: opts.command }
      : {}),
  };
  const temp = `${path}.${pid}.${token}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }

  let reclaimed: RunLockOwnerInfo | undefined;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        // Atomic: the lock appears complete, and only one creator wins.
        linkSync(temp, path);
        return makeHandle(path, opts.scope, token, now(), reclaimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const existing = readLock(path);
      if (!existing.ok) {
        if (existing.reason === "gone") continue;
        // A just-created file may be mid-rename; give it a moment before
        // calling it garbage.
        const age = fileAgeMs(path, now());
        if (age !== undefined && age < 2_000) {
          sleepSync(50);
          continue;
        }
        throw new RunLockRefusedError(
          `the run lock file ${path} for ${opts.displayName} is unreadable (${existing.reason}); ` +
            `remove it if no cairn run is active`,
          "unreadable",
          path,
          opts.scope,
        );
      }
      const current = existing.lock;
      const alive = runLockOwnerAlive(current, probe, now());
      const owner = ownerInfo(current, alive, now());
      if (alive) {
        throw new RunLockRefusedError(
          `another cairn ${current.command ?? "run"} holds the run lock for ${opts.displayName} (${opts.scope} scope): ` +
            `${describeRunLockOwner(owner, current.argv)}. ` +
            `Wait for it to finish, or stop that process; the lock file is ${path}`,
          "held",
          path,
          opts.scope,
          owner,
        );
      }
      if (!staleOk) {
        throw new RunLockRefusedError(
          `the run lock for ${opts.displayName} (${opts.scope} scope) belongs to a process that is gone: ` +
            `${describeRunLockOwner(owner, current.argv)}. ` +
            `run.lock.staleAfterPidDead is false, so remove ${path} yourself`,
          "stale",
          path,
          opts.scope,
          owner,
        );
      }
      // Reclaim: move the stale file aside atomically (only one reclaimer
      // wins the rename), then try the atomic link again.
      const aside = `${path}.stale.${pid}.${token}`;
      try {
        renameSync(path, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = readLock(aside);
      if (moved.ok && moved.lock.token !== current.token) {
        // Someone reclaimed and re-acquired between our read and the rename:
        // we moved a live lock. Put it back if the slot is still free.
        try {
          linkSync(aside, path);
        } catch {
          // A third creator took the slot; the displaced lock is dropped.
        }
        safeUnlink(aside);
        continue;
      }
      safeUnlink(aside);
      reclaimed = owner;
    }
    throw new RunLockRefusedError(
      `could not take the run lock ${path} for ${opts.displayName}: it kept changing under us`,
      "held",
      path,
      opts.scope,
    );
  } finally {
    safeUnlink(temp);
  }
}

function makeHandle(
  path: string,
  scope: "project" | "config",
  token: string,
  acquiredAt: number,
  reclaimed: RunLockOwnerInfo | undefined,
): RunLockHandle {
  let released = false;
  const onExit = (): void => {
    release();
  };
  const release = (): boolean => {
    if (released) return false;
    released = true;
    process.off("exit", onExit);
    const existing = readLock(path);
    if (!existing.ok || existing.lock.token !== token) return false;
    return safeUnlink(path);
  };
  // Last resort for a path that skips the engine's finally (process.exit,
  // an uncaught exception): the lock never outlives its process.
  process.on("exit", onExit);
  return {
    path,
    scope,
    acquiredAt,
    ...(reclaimed ? { reclaimed } : {}),
    release,
  };
}

function safeUnlink(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function fileAgeMs(path: string, now: number): number | undefined {
  try {
    return Math.max(0, now - statSync(path).mtimeMs);
  } catch {
    return undefined;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The label of a lock file: the config's directory name. */
export function runLockLabel(
  configPath: string | undefined,
  dir: string,
): string {
  return basename(configPath ? dirname(configPath) : dir) || "config";
}
