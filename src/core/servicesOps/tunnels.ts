import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { backoffDelayMs, resolveBackoff } from "./backoff";
import type { TunnelConfig } from "./schema";

/**
 * `services.tunnels`: supervised helper processes. Each tunnel runs in its
 * own process group (pid = pgid) with its output in a log file; its pid,
 * state and owner (the cairn process that started it) live in
 * `<stateRoot>/<key>.tunnel.<name>.json`, keyed by project + environment +
 * a hash of the canonical config path ({@link tunnelStateKey}), so a stop on
 * any exit path (and a later `cairn services down`) can find and end it, and
 * two checkouts or environments never stop each other's tunnels. This module
 * never imports the services runner: it takes callbacks.
 */

/** Consecutive-failure counter resets once a tunnel stayed up this long. */
const STABLE_UPTIME_MS = 30_000;
const DEFAULT_GIVE_UP_AFTER = 5;
const STOP_GRACE_MS = 3_000;

export type TunnelState = "running" | "exited" | "gave-up" | "stopped";

export interface TunnelStateFile {
  version: 1;
  name: string;
  pid: number;
  startedAt: string;
  state: TunnelState;
  /** Consecutive restarts so far. */
  restarts: number;
  logFile: string;
  /**
   * The cairn process that started it (a run, or `cairn services up`,
   * which exits and leaves it). A live owner's tunnel is never reclaimed.
   */
  owner?: { pid: number; startedAt?: string };
}

export interface TunnelStatus {
  name: string;
  state: TunnelState;
  pid?: number;
  restarts: number;
  logFile: string;
}

export interface TunnelSetOptions {
  /** The state key ({@link tunnelStateKey}). */
  project: string;
  /** Where `<key>.tunnel.<name>.json` live. */
  stateRoot: string;
  /** Where `<key>-tunnel-<name>.log` live. */
  logRoot: string;
  envFor(tunnel: TunnelConfig): NodeJS.ProcessEnv;
  cwdFor(tunnel: TunnelConfig): string;
  /** `services.tunnel.<event>` (the caller maps it to the lifecycle event). */
  emit(
    event: "start" | "ready" | "exit" | "restart" | "giveup" | "stop" | "fail",
    message: string,
    data?: Record<string, unknown>,
  ): void;
  log(message: string): void;
  warn(message: string): void;
  redact(text: string): string;
  /** Wait the tunnel's `ready` gate(s); throws when it is not ready. */
  waitReady(tunnel: TunnelConfig): Promise<void>;
  /** Restart a tunnel that exits (`restart: always`). False: start and stop only. */
  supervise: boolean;
}

interface Entry {
  tunnel: TunnelConfig;
  child?: ChildProcess;
  /** The running process (cleared when it exits: a pid can be reused). */
  pid?: number;
  /** The last process' pid, for the state file. */
  recordedPid?: number;
  startedAt: number;
  state: TunnelState;
  restarts: number;
  logFile: string;
  stopping: boolean;
  starting: boolean;
  timer?: ReturnType<typeof setTimeout>;
  exitedEarly?: (error: Error) => void;
}

/** The project as it appears in state file names. */
export function tunnelProjectKey(project: string): string {
  return project.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * The state key of a project's tunnels: project + environment + a hash of
 * the canonical config path (the config directory without a config file).
 * Two checkouts of one project, or two environments of one config, never
 * share (or stop) a tunnel.
 */
export function tunnelStateKey(input: {
  project: string;
  env?: string | undefined;
  configPath?: string | undefined;
  configDir: string;
}): string {
  const anchor = input.configPath ?? input.configDir;
  let canonical: string;
  try {
    canonical = realpathSync(anchor);
  } catch {
    canonical = resolvePath(anchor);
  }
  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 10);
  return `${tunnelProjectKey(input.project)}.${tunnelProjectKey(input.env ?? "default")}.${hash}`;
}

/** A process' start time (`ps -o lstart=`), ISO; undefined when unknown. */
export function processStartedAt(pid: number): string | undefined {
  try {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const started = Date.parse((result.stdout ?? "").trim());
    return Number.isNaN(started) ? undefined : new Date(started).toISOString();
  } catch {
    return undefined;
  }
}

let selfStartedAt: string | undefined | null = null;

/** This process as the owner of the tunnels it starts. */
function ownerStamp(): NonNullable<TunnelStateFile["owner"]> {
  if (selfStartedAt === null) selfStartedAt = processStartedAt(process.pid);
  return {
    pid: process.pid,
    ...(selfStartedAt ? { startedAt: selfStartedAt } : {}),
  };
}

/**
 * Another live cairn process owns this state: its pid runs and (when the
 * start time was recorded) is the same process, not a reused pid.
 */
function liveForeignOwner(state: TunnelStateFile): boolean {
  const owner = state.owner;
  if (!owner || owner.pid === process.pid || !isAlive(owner.pid)) return false;
  if (!owner.startedAt) return true;
  const now = processStartedAt(owner.pid);
  return (
    now === undefined ||
    Math.abs(Date.parse(now) - Date.parse(owner.startedAt)) <= 5_000
  );
}

export function tunnelStatePath(
  stateRoot: string,
  project: string,
  name: string,
): string {
  return join(stateRoot, `${project}.tunnel.${name}.json`);
}

/**
 * Running: the pid exists and is not a zombie (a process cairn killed stays
 * one until its parent reaps it, which a blocked signal path cannot do).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (typeof result.stdout === "string" && !result.error) {
      const stat = result.stdout.trim();
      return stat !== "" && !stat.startsWith("Z");
    }
  } catch {
    // fall through: signal 0 said it exists
  }
  return true;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is `pid` the process this state file describes? A pid can be reused, so
 * the process' start time must match the recorded one (±5s); where `ps`
 * cannot tell, the command line must contain the tunnel's command.
 */
function isOurProcess(
  state: Pick<TunnelStateFile, "pid" | "startedAt">,
  command: string,
): boolean {
  const started = Date.parse(processStartedAt(state.pid) ?? "");
  const recorded = Date.parse(state.startedAt);
  if (!Number.isNaN(started) && !Number.isNaN(recorded)) {
    return Math.abs(started - recorded) <= 5_000;
  }
  return processCommand(state.pid).includes(command);
}

/** The process an entry started, still running (not a reused pid). */
function entryRunning(entry: Entry, pid: number): boolean {
  return (
    isAlive(pid) &&
    isOurProcess(
      { pid, startedAt: new Date(entry.startedAt).toISOString() },
      entry.tunnel.command,
    )
  );
}

/** The command line of a live pid (empty when unknown). */
function processCommand(pid: number): string {
  try {
    const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return typeof result.stdout === "string" ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

function readState(path: string): TunnelStateFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TunnelStateFile;
    return parsed?.version === 1 && Number.isInteger(parsed.pid)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function writeState(path: string, state: TunnelStateFile): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // State is best-effort evidence; the in-memory entry stays authoritative.
  }
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .slice(-lines)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

export class TunnelSet {
  private readonly entries: Entry[];
  private stopped = false;

  constructor(
    private readonly tunnels: readonly TunnelConfig[],
    private readonly opts: TunnelSetOptions,
  ) {
    this.entries = tunnels.map((tunnel) => ({
      tunnel,
      startedAt: 0,
      state: "stopped" as TunnelState,
      restarts: 0,
      logFile: join(opts.logRoot, `${opts.project}-tunnel-${tunnel.name}.log`),
      stopping: false,
      starting: false,
    }));
  }

  statuses(): TunnelStatus[] {
    return this.entries.map((entry) => ({
      // `pid` only while it runs.
      name: entry.tunnel.name,
      state: entry.state,
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      restarts: entry.restarts,
      logFile: entry.logFile,
    }));
  }

  /** Start every tunnel in order, waiting for each one's `ready` gate. */
  async start(): Promise<void> {
    mkdirSync(this.opts.logRoot, { recursive: true });
    for (const entry of this.entries) {
      try {
        this.reclaimStale(entry);
        entry.starting = true;
        const early = new Promise<never>((_resolve, reject) => {
          entry.exitedEarly = reject;
        });
        early.catch(() => undefined);
        await this.spawnEntry(entry, "start");
        if (entry.tunnel.ready !== undefined) {
          await Promise.race([this.opts.waitReady(entry.tunnel), early]);
        } else {
          // Without a gate: a tunnel that dies right away is still a failure.
          await Promise.race([
            new Promise<void>((resolve) => setTimeout(resolve, 300)),
            early,
          ]);
        }
        entry.starting = false;
        entry.exitedEarly = undefined;
        this.opts.emit("ready", `tunnel "${entry.tunnel.name}" ready`, {
          tunnel: entry.tunnel.name,
          pid: entry.pid,
        });
      } catch (error) {
        entry.starting = false;
        entry.exitedEarly = undefined;
        const logTail = this.opts.redact(tail(entry.logFile, 15));
        this.opts.emit(
          "fail",
          `tunnel "${entry.tunnel.name}" failed to start`,
          {
            tunnel: entry.tunnel.name,
          },
        );
        throw new Error(
          `tunnel "${entry.tunnel.name}": ${this.opts.redact((error as Error).message)}${
            logTail ? `\n--- tunnel output ---\n${logTail}` : ""
          }`,
          { cause: error },
        );
      }
    }
  }

  /** Stop every tunnel (SIGTERM, grace, SIGKILL) and drop its state file. */
  async stop(): Promise<void> {
    const live = this.beginStop();
    for (const { pid } of live) signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (live.some(({ pid }) => isAlive(pid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.killSurvivors(live);
    this.finishStop();
  }

  /** The signal-path stop: same steps, blocking. */
  stopSync(): void {
    const live = this.beginStop();
    for (const { pid } of live) signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (live.some(({ pid }) => isAlive(pid)) && Date.now() < deadline) {
      sleepSync(100);
    }
    this.killSurvivors(live);
    this.finishStop();
  }

  /**
   * No more restarts; the entries whose process still runs — only a running
   * entry, and only its own process (start time checked), is ever signalled.
   */
  private beginStop(): Array<{ entry: Entry; pid: number }> {
    this.stopped = true;
    const live: Array<{ entry: Entry; pid: number }> = [];
    for (const entry of this.entries) {
      entry.stopping = true;
      if (entry.timer) clearTimeout(entry.timer);
      const pid = entry.pid;
      if (pid !== undefined && entry.state === "running") {
        if (entryRunning(entry, pid)) live.push({ entry, pid });
      }
    }
    return live;
  }

  private killSurvivors(live: Array<{ entry: Entry; pid: number }>): void {
    for (const { entry, pid } of live) {
      if (entryRunning(entry, pid)) signalGroup(pid, "SIGKILL");
    }
  }

  private finishStop(): void {
    for (const entry of this.entries) {
      if (entry.recordedPid === undefined && entry.state === "stopped") {
        continue;
      }
      try {
        this.opts.emit("stop", `tunnel "${entry.tunnel.name}" stopped`, {
          tunnel: entry.tunnel.name,
        });
      } catch {
        // evidence only
      }
      entry.state = "stopped";
      entry.pid = undefined;
      const path = tunnelStatePath(
        this.opts.stateRoot,
        this.opts.project,
        entry.tunnel.name,
      );
      // Only our own state file: another process may have written it since.
      const current = readState(path);
      if (
        !current ||
        current.owner?.pid === process.pid ||
        current.pid === entry.recordedPid
      ) {
        rmSync(path, { force: true });
      }
    }
  }

  /** A tunnel a crashed earlier run left behind is stopped before this one starts. */
  private reclaimStale(entry: Entry): void {
    const path = tunnelStatePath(
      this.opts.stateRoot,
      this.opts.project,
      entry.tunnel.name,
    );
    const previous = readState(path);
    if (!previous) return;
    if (isAlive(previous.pid) && liveForeignOwner(previous)) {
      // Another live cairn process (a run of this config and environment)
      // owns it: never stop it, never take its state file over.
      throw new Error(
        `it is running for another live cairn process (pid ${previous.owner!.pid}) of this config and environment (state ${path}); stop that run first`,
      );
    }
    if (isAlive(previous.pid)) {
      if (isOurProcess(previous, entry.tunnel.command)) {
        this.opts.warn(
          `tunnel "${entry.tunnel.name}": stopping a copy left by an earlier run (pid ${previous.pid})`,
        );
        signalGroup(previous.pid, "SIGTERM");
        const deadline = Date.now() + STOP_GRACE_MS;
        while (isAlive(previous.pid) && Date.now() < deadline) sleepSync(100);
        if (isAlive(previous.pid)) signalGroup(previous.pid, "SIGKILL");
      } else {
        this.opts.warn(
          `tunnel "${entry.tunnel.name}": ignoring a stale state file (pid ${previous.pid} is another process)`,
        );
      }
    }
    rmSync(path, { force: true });
  }

  private async spawnEntry(
    entry: Entry,
    event: "start" | "restart",
  ): Promise<void> {
    const { tunnel } = entry;
    const fd = openSync(entry.logFile, event === "start" ? "w" : "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(tunnel.command, {
        cwd: this.opts.cwdFor(tunnel),
        env: this.opts.envFor(tunnel),
        shell: true,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    // Nothing waits on a tunnel at process exit: `cairn services up` leaves
    // it running, a run stops it explicitly.
    child.unref();
    entry.child = child;
    entry.pid = child.pid;
    entry.recordedPid = child.pid;
    entry.startedAt = Date.now();
    entry.state = "running";
    child.on("error", () => undefined);
    child.once("exit", (code, signal) =>
      this.onExit(entry, child, code, signal),
    );
    this.persist(entry);
    if (event === "start") {
      this.opts.emit("start", `tunnel "${tunnel.name}" started`, {
        tunnel: tunnel.name,
        pid: entry.pid,
      });
    }
  }

  private persist(entry: Entry): void {
    const pid = entry.pid ?? entry.recordedPid;
    if (pid === undefined) return;
    writeState(
      tunnelStatePath(
        this.opts.stateRoot,
        this.opts.project,
        entry.tunnel.name,
      ),
      {
        version: 1,
        name: entry.tunnel.name,
        pid,
        startedAt: new Date(entry.startedAt).toISOString(),
        state: entry.state,
        restarts: entry.restarts,
        logFile: entry.logFile,
        owner: ownerStamp(),
      },
    );
  }

  private onExit(
    entry: Entry,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (entry.child !== child) return;
    // The process is gone: its pid may be reused, never signal it again.
    entry.child = undefined;
    entry.pid = undefined;
    const uptimeMs = Date.now() - entry.startedAt;
    if (entry.stopping || this.stopped) return;
    this.opts.emit("exit", `tunnel "${entry.tunnel.name}" exited`, {
      tunnel: entry.tunnel.name,
      ...(code !== null ? { exitCode: code } : {}),
      ...(signal ? { signal } : {}),
      uptimeMs,
    });
    if (entry.starting && entry.exitedEarly) {
      entry.state = "exited";
      this.persist(entry);
      entry.exitedEarly(
        new Error(
          `exited${
            code !== null ? ` (exit ${code})` : signal ? ` (${signal})` : ""
          } before it was ready`,
        ),
      );
      return;
    }
    entry.state = "exited";
    this.persist(entry);
    if (entry.tunnel.restart !== "always" || !this.opts.supervise) {
      this.opts.warn(
        `tunnel "${entry.tunnel.name}" exited${
          code !== null ? ` (exit ${code})` : ""
        }; restart is ${entry.tunnel.restart ?? "never"}`,
      );
      return;
    }
    if (uptimeMs >= STABLE_UPTIME_MS) entry.restarts = 0;
    entry.restarts += 1;
    const limit = entry.tunnel.giveUpAfter ?? DEFAULT_GIVE_UP_AFTER;
    if (entry.restarts > limit) {
      entry.state = "gave-up";
      this.persist(entry);
      this.opts.emit(
        "giveup",
        `tunnel "${entry.tunnel.name}" gave up after ${limit} restarts`,
        { tunnel: entry.tunnel.name, restarts: entry.restarts - 1 },
      );
      this.opts.warn(
        `tunnel "${entry.tunnel.name}" gave up after ${limit} consecutive restarts; see ${entry.logFile}`,
      );
      return;
    }
    const delayMs = backoffDelayMs(
      resolveBackoff(entry.tunnel.backoff),
      entry.restarts,
    );
    this.opts.log(
      `tunnel "${entry.tunnel.name}" exited; restarting in ${delayMs}ms (${entry.restarts}/${limit})`,
    );
    entry.timer = setTimeout(() => {
      if (entry.stopping || this.stopped) return;
      this.opts.emit("restart", `tunnel "${entry.tunnel.name}" restarting`, {
        tunnel: entry.tunnel.name,
        attempt: entry.restarts,
        delayMs,
      });
      this.spawnEntry(entry, "restart").catch((error) => {
        this.opts.warn(
          `tunnel "${entry.tunnel.name}" could not restart: ${this.opts.redact((error as Error).message)}`,
        );
      });
    }, delayMs);
    entry.timer.unref?.();
  }
}

/** What `cairn services status` / `down` find in the state files of a project. */
export async function readTunnelStates(
  project: string,
  stateRoot: string,
): Promise<TunnelStateFile[]> {
  let names: string[];
  try {
    names = await readdir(stateRoot);
  } catch {
    return [];
  }
  const prefix = `${project}.tunnel.`;
  const out: TunnelStateFile[] = [];
  for (const file of names) {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
    const state = readState(join(stateRoot, file));
    if (state) out.push(state);
  }
  return out;
}

export interface TunnelStopReport {
  name: string;
  /** `stopped`: ended now; `gone`: not running (state removed); `skipped`: pid is another process. */
  result: "stopped" | "gone" | "skipped";
  pid?: number;
}

/**
 * Stop the tunnels of `tunnels` that a state file says are running (for
 * `cairn services down`, which runs in another process than `services up`).
 * A pid that is not running the tunnel's command is left alone, and so is a
 * tunnel another live cairn process (a run) owns.
 */
export async function stopTunnelsFromState(
  tunnels: readonly TunnelConfig[],
  input: { project: string; stateRoot: string },
): Promise<TunnelStopReport[]> {
  const reports: TunnelStopReport[] = [];
  for (const tunnel of tunnels) {
    const path = tunnelStatePath(input.stateRoot, input.project, tunnel.name);
    const state = readState(path);
    if (!state) continue;
    if (!isAlive(state.pid)) {
      rmSync(path, { force: true });
      reports.push({ name: tunnel.name, result: "gone", pid: state.pid });
      continue;
    }
    if (liveForeignOwner(state)) {
      reports.push({ name: tunnel.name, result: "skipped", pid: state.pid });
      continue;
    }
    if (!isOurProcess(state, tunnel.command)) {
      rmSync(path, { force: true });
      reports.push({ name: tunnel.name, result: "skipped", pid: state.pid });
      continue;
    }
    signalGroup(state.pid, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (isAlive(state.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(state.pid)) signalGroup(state.pid, "SIGKILL");
    rmSync(path, { force: true });
    reports.push({ name: tunnel.name, result: "stopped", pid: state.pid });
  }
  return reports;
}
