import { spawn, spawnSync } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import type { WebServerConfig } from "../schema/config.v1";
import type { GateEvent } from "../schema/events.v1";
import { targetChildEnv } from "../processEnv";
import {
  gateFailureMessage,
  waitForGate,
  type GateContext,
} from "../gates/evaluate";
import { probeHttp } from "../gates/probes";
import { gatesRegistryFor } from "../gates/registry";
import { gateRefList, type GateNode, type GateRef } from "../gates/schema";

/**
 * `webServer` lifecycle for the whole `cairn run` invocation: build → boot →
 * readiness → setup, with a matching teardown. One server is shared by every
 * spec in the run (started once before the pool, stopped once after), the same
 * role Playwright's `webServer` plays.
 *
 * Bun-native by design: the real `bin/cairn` runs under Bun, so the server is
 * spawned with `Bun.spawn` and build/setup/teardown shell out through `Bun.$`.
 * Under plain node (the vitest gate, where `Bun` is undefined) the exact same
 * lifecycle runs through `node:child_process` + `execa`, so every path here is
 * exercised by tests. The readiness probe (`fetch`) and the process-group
 * teardown (`process.kill` + `pgrep`) are runtime-agnostic and shared.
 */

export interface StartWebServerContext {
  /** Directory the build/command run in unless `cfg.cwd` overrides it. */
  configDir: string;
  /** Resolved environment baseUrl; the readiness default when `url` is unset. */
  baseUrl?: string;
  /** Effective cold-start (CLI `--cold-start` or CI); flips reuse default off. */
  coldStart?: boolean;
  /** Where `web-server-<pid>.log` is written (the run's artifact root). */
  artifactRoot: string;
  /** Optional narrator for interactive runs (stderr lifecycle lines). */
  log?: (message: string) => void;
  /**
   * Invoked once, the instant the server process is spawned, with a synchronous
   * tree-teardown bound to it. Lets the caller register signal-time cleanup for
   * the WHOLE boot/readiness/setup window — not just after readiness resolves —
   * so a SIGINT/SIGTERM during a slow boot can't orphan the spawned server.
   */
  onSpawn?: (terminateSync: () => void) => void;
  /** The config's `gates:` registry (named references in `ready`). */
  gates?: Readonly<Record<string, GateNode>>;
  /** gate.* events of the `ready` gates (the invocation journal writes them). */
  onGateEvent?: (event: GateEvent) => void;
  /**
   * Warnings that must reach the user even in non-interactive runs (a
   * readiness URL stuck on a status only the old any-answer rule accepted).
   * Default: `log`, else one `cairn: warning:` stderr line.
   */
  warn?: (message: string) => void;
  /** Stops `ready` gate waits (a cancelled invocation). */
  signal?: AbortSignal;
}

export interface WebServerHandle {
  /** True when cairn spawned the server (and therefore owns teardown). */
  startedByUs: boolean;
  /** Absolute path to the captured server log, when one was started. */
  logPath?: string;
  /** Last `maxLines` of captured stdout/stderr (for failure diagnostics). */
  tailLog(maxLines: number): string;
  /** Run teardown (best-effort) then stop the server. No-op when reused. */
  stop(): Promise<void>;
  /** Synchronous teardown for the signal path (Ctrl-C). No-op when reused. */
  terminateSync(): void;
}

/** Thrown for every webServer lifecycle failure; run.ts maps it to exit 2. */
export class WebServerError extends Error {
  override name = "WebServerError";
}

const DEFAULT_READY_MS = 60_000;
const POLL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;
const STOP_GRACE_MS = 5_000;
/**
 * Shorter grace for the synchronous signal path: there the event loop is frozen,
 * so a child that already exited can't be reaped and `kill(pid, 0)` still reports
 * it alive (a zombie). A just-exited child therefore always burns the full grace
 * before a no-op SIGKILL, so keep it tight — Ctrl-C should abort promptly.
 */
const SYNC_STOP_GRACE_MS = 1_500;
const TAIL_MAX_LINES = 200;
const ERR_TAIL_LINES = 80;
const SHELL_TAIL_LINES = 40;
/** Cap the rolling stdout/stderr buffer scanned for `waitForText`. */
const SCAN_TAIL_BYTES = 64 * 1024;

export async function startWebServer(
  cfg: WebServerConfig,
  ctx: StartWebServerContext,
): Promise<WebServerHandle> {
  const coldStart = ctx.coldStart ?? isTruthyEnv(process.env.CI);
  const reuse = cfg.reuseExisting ?? !coldStart;
  // baseUrl is a readiness/reuse URL ONLY when neither url nor waitForText is the
  // configured signal. A waitForText-only block must not be forced to also pass
  // an HTTP probe of a baseUrl it never designated (its listen port may differ,
  // or the ready line may print before the socket accepts).
  const effectiveUrl = cfg.url ?? (cfg.waitForText ? undefined : ctx.baseUrl);
  const cwd = cfg.cwd
    ? isAbsolute(cfg.cwd)
      ? cfg.cwd
      : resolve(ctx.configDir, cfg.cwd)
    : ctx.configDir;
  // The inherited env is filtered; keys the config sets in `webServer.env`
  // pass as written (the author chose them, e.g. a non-default TVAULT_DIR).
  const env = { ...targetChildEnv(process.env), ...cfg.env };

  const anyResponse = cfg.anyResponse === true;
  const readyRefs = gateRefList(cfg.ready);
  const readyTimeoutMs = cfg.readyTimeoutMs ?? DEFAULT_READY_MS;
  // The lifecycle narration (leveled, NDJSON under --log-format json) when
  // there is no dedicated warning sink; a raw stderr line only without both.
  const warn =
    ctx.warn ??
    ctx.log ??
    ((message: string) => process.stderr.write(`cairn: warning: ${message}\n`));

  // Reuse / conflict check: is something already answering the readiness URL?
  // (Any answer means the port is taken; readiness itself needs 2xx/3xx.)
  if (effectiveUrl && (await probeOnce(effectiveUrl))) {
    if (reuse) {
      ctx.log?.(
        `web server: reusing the server already answering ${effectiveUrl}`,
      );
      // A reused server must be READY too (2xx/3xx unless anyResponse, then
      // the `ready` gates) within readyTimeoutMs — not merely listening.
      const deadline = Date.now() + readyTimeoutMs;
      let last = await probeReady(effectiveUrl, { anyResponse });
      while (!last.ready && Date.now() < deadline) {
        if (last.status !== undefined) {
          warnLegacyReadiness(effectiveUrl, last.status, warn);
        }
        await sleep(POLL_MS);
        last = await probeReady(effectiveUrl, { anyResponse });
      }
      if (!last.ready) {
        throw new WebServerError(
          `the reused server at ${effectiveUrl} did not become ready within ${readyTimeoutMs}ms (last: ${last.detail})` +
            readinessHint(last.status, anyResponse),
        );
      }
      await waitReadyGates(readyRefs, ctx, deadline - Date.now());
      return reusedHandle();
    }
    throw new WebServerError(
      `something is already listening on ${effectiveUrl} but reuseExisting is false — ` +
        `refusing to test against a server cairn didn't start. Stop it, or set reuseExisting: true.`,
    );
  }

  if (cfg.build) {
    ctx.log?.(`web server: building (${cfg.build})`);
    const r = await runShell(cfg.build, { cwd, env });
    if (r.exitCode !== 0) {
      throw new WebServerError(
        `webServer build failed (exit ${r.exitCode}): ${cfg.build}\n` +
          tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
      );
    }
  }

  await mkdir(ctx.artifactRoot, { recursive: true });
  const logPath = join(ctx.artifactRoot, `web-server-${process.pid}.log`);
  const logStream = createWriteStream(logPath, { flags: "w" });
  const tail = new TailBuffer(TAIL_MAX_LINES);

  ctx.log?.(`web server: starting (${cfg.command})`);
  const proc = spawnProcess(cfg.command, { cwd, env });
  // Register signal-time teardown the instant the child exists, so a signal
  // during the (potentially long) readiness/setup window can't orphan it.
  ctx.onSpawn?.(() => stopProcSync(proc.pid));

  let exited = false;
  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exited = true;
    exitCode = code;
  });

  // Pump both streams into the log file + tail buffer, scanning for waitForText.
  let scanBuf = "";
  let textFound = false;
  const pump = (stream: AsyncIterable<Uint8Array>): Promise<void> =>
    (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        try {
          logStream.write(text);
        } catch {
          // log file may be closed during teardown; capture is best-effort
        }
        tail.push(text);
        if (cfg.waitForText && !textFound) {
          scanBuf = (scanBuf + text).slice(-SCAN_TAIL_BYTES);
          if (scanBuf.includes(cfg.waitForText)) textFound = true;
        }
      }
    })().catch(() => undefined);
  void pump(proc.stdout);
  void pump(proc.stderr);

  const closeLog = (): void => {
    try {
      logStream.end();
    } catch {
      // already closed
    }
  };

  const deadline = Date.now() + readyTimeoutMs;
  let lastProbe: ReadyProbe | undefined;
  try {
    for (;;) {
      // Fail fast: a server that crashes on boot shouldn't poll until timeout.
      if (exited) {
        throw new WebServerError(
          `web server exited (code ${exitCode}) during startup before becoming ready`,
        );
      }
      // Ready when every configured signal is satisfied (url probe AND/OR text).
      let ready = true;
      if (cfg.waitForText) ready = textFound;
      if (effectiveUrl && ready) {
        lastProbe = await probeReady(effectiveUrl, { anyResponse });
        ready = lastProbe.ready;
        if (!ready && lastProbe.status !== undefined) {
          warnLegacyReadiness(effectiveUrl, lastProbe.status, warn);
        }
      }
      if (ready) break;
      if (Date.now() >= deadline) {
        throw new WebServerError(
          `web server did not become ready within ${readyTimeoutMs}ms ` +
            `(probed ${effectiveUrl ?? "—"}${
              lastProbe ? ` — last: ${lastProbe.detail}` : ""
            }${cfg.waitForText ? `, waiting for "${cfg.waitForText}"` : ""})` +
            readinessHint(lastProbe?.status, anyResponse),
        );
      }
      await sleep(POLL_MS);
    }
    // Then the `ready` gates, with what is left of readyTimeoutMs.
    await waitReadyGates(readyRefs, ctx, deadline - Date.now());
  } catch (e) {
    // Async context: await the real teardown so a node-fallback child is reaped
    // (a zombie would defeat the sync poll). The signal path uses stopProcSync.
    await stopProcAsync(proc);
    closeLog();
    const message = e instanceof Error ? e.message : String(e);
    throw new WebServerError(
      `${message}\n--- web-server.log (last ${ERR_TAIL_LINES} lines, full log: ${logPath}) ---\n` +
        tail.text(ERR_TAIL_LINES),
    );
  }

  for (const cmd of cfg.setup ?? []) {
    ctx.log?.(`web server: setup (${cmd})`);
    const r = await runShell(cmd, { cwd, env });
    if (r.exitCode !== 0) {
      await stopProcAsync(proc);
      closeLog();
      throw new WebServerError(
        `webServer setup command failed (exit ${r.exitCode}): ${cmd}\n` +
          tailText(`${r.stdout}\n${r.stderr}`, SHELL_TAIL_LINES),
      );
    }
  }

  ctx.log?.("web server: ready");
  return {
    startedByUs: true,
    logPath,
    tailLog: (n) => tail.text(n),
    stop: async () => {
      for (const cmd of cfg.teardown ?? []) {
        try {
          ctx.log?.(`web server: teardown (${cmd})`);
          await runShell(cmd, { cwd, env });
        } catch {
          // teardown is best-effort, never fatal
        }
      }
      await stopProcAsync(proc);
      closeLog();
    },
    terminateSync: () => {
      stopProcSync(proc.pid);
      closeLog();
    },
  };
}

function reusedHandle(): WebServerHandle {
  return {
    startedByUs: false,
    tailLog: () => "",
    stop: async () => undefined,
    terminateSync: () => undefined,
  };
}

/* ----- shared helpers (exported for services.ts) ----- */

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Runtime-agnostic shell command runner (Bun.$ or execa fallback). */
export async function runShell(
  command: string,
  { cwd, env }: SpawnOpts,
): Promise<ShellResult> {
  if (hasBunRuntime()) {
    const r = await getBun().$`/bin/sh -c ${command}`
      .cwd(cwd)
      .env(env as Record<string, string | undefined>)
      .quiet()
      .nothrow();
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  }
  // extendEnv: false — `env` is already the filtered child env; execa's
  // default would merge the parent process.env (fcheap/tvault credentials)
  // back in. Bun.$().env() and the node spawn path already replace it.
  const r = await execa(command, {
    cwd,
    env,
    extendEnv: false,
    shell: true,
    reject: false,
  });
  return {
    exitCode: r.exitCode ?? 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

/**
 * Run a shell command to completion in its own process group, for commands
 * that must outlive a signal aimed at cairn (a services teardown that sinks
 * billable compute):
 *
 * - `detached`: the command leads its own process group (and session, so it
 *   has no controlling terminal), so a terminal Ctrl-C, Studio's Stop or a
 *   harness's group SIGTERM does not kill it halfway.
 * - Output goes to a private temp file, not a pipe: a command still running
 *   when cairn exits must not die of SIGPIPE on its next write. stdout and
 *   stderr are interleaved in `stdout`; `stderr` is empty. Only the last
 *   `maxOutputBytes` are kept.
 * - `onStart` gets the pid (= process group id) and the output file, so a
 *   signal handler can tell a command that is still running from one that is
 *   gone. The file is removed once the command exits.
 *
 * `env` replaces process.env (pass the filtered target env).
 */
export async function runShellDetached(
  command: string,
  { cwd, env }: SpawnOpts,
  onStart?: (started: { pid: number | undefined; outputFile: string }) => void,
  maxOutputBytes = 1024 * 1024,
  /** Kill the whole process group after this long (SIGTERM, then SIGKILL). */
  timeoutMs?: number,
): Promise<ShellResult & { signal: string | null; timedOut?: boolean }> {
  const outputFile = join(
    tmpdir(),
    `cairn-shell-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2, 8)}.log`,
  );
  const fd = openSync(outputFile, "w", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, {
      cwd,
      env,
      shell: true,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    closeSync(fd);
    await unlink(outputFile).catch(() => undefined);
    throw error;
  }
  // The child holds its own copy of the descriptor.
  closeSync(fd);
  onStart?.({ pid: child.pid, outputFile });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0 && child.pid !== undefined) {
    const pgid = child.pid;
    timer = setTimeout(() => {
      timedOut = true;
      signalGroup(pgid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(pgid, "SIGKILL"), 2_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  }
  const settled = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveExit) => {
    // `on`, not `once`: a late 'error' must never become an uncaught one.
    child.on("error", (error) =>
      resolveExit({ code: null, signal: null, error }),
    );
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (timer) clearTimeout(timer);
  if (killTimer && !timedOut) clearTimeout(killTimer);
  const output = await readFileTail(outputFile, maxOutputBytes);
  await unlink(outputFile).catch(() => undefined);
  if (settled.error) throw settled.error;
  const signalNumber = settled.signal
    ? osConstants.signals[settled.signal]
    : undefined;
  return {
    exitCode:
      settled.code ?? (signalNumber !== undefined ? 128 + signalNumber : -1),
    signal: settled.signal,
    stdout: output.endsWith("\n") ? output.slice(0, -1) : output,
    stderr: "",
    ...(timedOut ? { timedOut: true } : {}),
  };
}

/** Signal a process group; a group that is already gone is not an error. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

/** The last `maxBytes` of a file as UTF-8 (empty when it is unreadable). */
async function readFileTail(file: string, maxBytes: number): Promise<string> {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      return size > maxBytes
        ? `[… ${size - maxBytes} earlier bytes omitted]\n${text}`
        : text;
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

export interface ReadyProbe {
  ready: boolean;
  /** The HTTP status, when the URL answered at all. */
  status?: number;
  /** e.g. `GET http://localhost:3000/ → 503 (want 2xx|3xx)`. */
  detail: string;
}

/**
 * Readiness probe of `webServer.url` (or the environment `baseUrl` it falls
 * back to) and tmux `readyOn.url`: a 2xx or 3xx answer (redirects are not
 * followed). `anyResponse: true` accepts any answer — the old rule, when a
 * 503 counted as ready.
 */
export async function probeReady(
  url: string,
  opts: { anyResponse?: boolean } = {},
): Promise<ReadyProbe> {
  const r = await probeHttp(
    url,
    PROBE_TIMEOUT_MS,
    opts.anyResponse ? { anyResponse: true } : {},
  );
  return {
    ready: r.ok,
    ...(r.status !== undefined ? { status: r.status } : {}),
    detail: r.detail,
  };
}

/** A readiness URL stuck this long on one non-ready status gets a warning. */
const LEGACY_WARN_AFTER_MS = 10_000;
/** A gap this long between answers starts a new streak (a later wait). */
const LEGACY_STREAK_GAP_MS = 5_000;

const warnedReadinessUrls = new Set<string>();
const legacyStreaks = new Map<
  string,
  { status: number; since: number; last: number }
>();

/**
 * Called with every non-ready HTTP answer of a readiness URL. Warns once
 * per URL per process when the URL has kept answering the same status for
 * {@link LEGACY_WARN_AFTER_MS} — a status the old any-answer rule accepted.
 * A dev server that answers 503 while it warms up and then 200 never
 * warns; a URL stuck on 401 or 503 learns why long before the timeout
 * (whose error names the last status and `anyResponse` anyway).
 */
export function warnLegacyReadiness(
  url: string,
  status: number,
  warn: (message: string) => void,
  opts: { afterMs?: number; now?: number } = {},
): void {
  if (warnedReadinessUrls.has(url)) return;
  const now = opts.now ?? Date.now();
  let streak = legacyStreaks.get(url);
  if (
    !streak ||
    streak.status !== status ||
    now - streak.last > LEGACY_STREAK_GAP_MS
  ) {
    streak = { status, since: now, last: now };
    legacyStreaks.set(url, streak);
  }
  streak.last = now;
  const stuckMs = now - streak.since;
  if (stuckMs < (opts.afterMs ?? LEGACY_WARN_AFTER_MS)) return;
  warnedReadinessUrls.add(url);
  legacyStreaks.delete(url);
  warn(
    `readiness: ${url} has answered ${status} for ${Math.round(stuckMs / 1000)}s; readiness needs a 2xx/3xx answer (any answer used to count) — point the readiness url at a route that answers 2xx/3xx once the app is up, or set anyResponse: true to accept ${status}`,
  );
}

/** Error suffix naming the rule when the URL answered with a non-ready status. */
export function readinessHint(
  status: number | undefined,
  anyResponse: boolean,
): string {
  if (status === undefined || anyResponse) return "";
  return ` — readiness needs a 2xx/3xx answer; set anyResponse: true to accept ${status}`;
}

/** Wait the `webServer.ready` gates in order; throws WebServerError. */
async function waitReadyGates(
  refs: readonly GateRef[],
  ctx: StartWebServerContext,
  remainingMs: number,
): Promise<void> {
  if (refs.length === 0) return;
  const gateCtx: GateContext = {
    registry: await gatesRegistryFor(ctx),
    env: targetChildEnv(process.env),
    cwd: ctx.configDir,
    scope: "webServer",
    // A gate without its own timeout gets what is left of readyTimeoutMs.
    defaultTimeoutMs: Math.max(1, remainingMs),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.onGateEvent ? { onEvent: ctx.onGateEvent } : {}),
  };
  for (const ref of refs) {
    let result;
    try {
      result = await waitForGate(ref, gateCtx);
    } catch (error) {
      throw new WebServerError(`webServer.ready: ${(error as Error).message}`);
    }
    if (!result.ok) {
      throw new WebServerError(
        `webServer.ready: ${gateFailureMessage(result)}`,
      );
    }
    ctx.log?.(
      `web server: gate ${result.name} ready after ${result.attempts} attempt(s)`,
    );
  }
}

/**
 * "Something answers here" probe: ANY HTTP response counts. The port
 * conflict / reuse check uses it; readiness needs {@link probeReady}.
 */
export async function probeOnce(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

export function hasBunRuntime(): boolean {
  return Boolean(process.versions.bun);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/* ----- spawn (Bun-native, node fallback for the test gate) ----- */

interface SpawnedProc {
  pid: number;
  exited: Promise<number | null>;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
}

export function spawnProcess(command: string, opts: SpawnOpts): SpawnedProc {
  return hasBunRuntime() ? spawnBun(command, opts) : spawnNode(command, opts);
}

function spawnBun(command: string, { cwd, env }: SpawnOpts): SpawnedProc {
  const proc = getBun().spawn(["/bin/sh", "-c", command], {
    cwd,
    env: env as Record<string, string | undefined>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}

function spawnNode(command: string, { cwd, env }: SpawnOpts): SpawnedProc {
  const child = spawn(command, {
    cwd,
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((res) => {
    child.on("exit", (code) => res(code));
    child.on("error", () => res(null));
  });
  return {
    pid: child.pid ?? -1,
    exited,
    stdout: child.stdout as AsyncIterable<Uint8Array>,
    stderr: child.stderr as AsyncIterable<Uint8Array>,
  };
}

/* ----- shell commands (Bun.$, execa fallback) ----- */

/* (runShell moved to the shared helpers section above) */

/* ----- process-group teardown (runtime-agnostic) ----- */

async function stopProcAsync(proc: SpawnedProc): Promise<void> {
  if (proc.pid <= 1 || !isAlive(proc.pid)) return;
  // Capture the whole tree BEFORE SIGTERM: a child of a non-exec shell command
  // (`cmd && server`) is reparented to init the moment the shell exits, so a
  // post-kill re-scan would miss it. SIGKILL escalation then targets whichever
  // CAPTURED pids are still alive — not just the parent, which may have exited
  // while a SIGTERM-ignoring child lives on. (`await sleep` lets node reap the
  // shell's zombie, so `isAlive` doesn't misreport it as still running.)
  const tree = [proc.pid, ...descendantPidsSync(proc.pid)];
  signalAll(tree, "SIGTERM");
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && tree.some(isAlive)) {
    await sleep(100);
  }
  const survivors = tree.filter(isAlive);
  if (survivors.length > 0) signalAll(survivors, "SIGKILL");
}

/** Synchronous tree teardown for the SIGINT/SIGTERM handler. */
function stopProcSync(pid: number): void {
  if (pid <= 1 || !isAlive(pid)) return;
  const tree = [pid, ...descendantPidsSync(pid)];
  signalAll(tree, "SIGTERM");
  const deadline = Date.now() + SYNC_STOP_GRACE_MS;
  while (Date.now() < deadline && tree.some(isAlive)) {
    sleepSync(50);
  }
  signalAll(tree.filter(isAlive), "SIGKILL");
}

function signalAll(pids: number[], signal: "SIGTERM" | "SIGKILL"): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** All descendant pids of `pid` (BFS via pgrep). Best-effort, darwin/linux. */
function descendantPidsSync(pid: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of childPidsSync(current)) {
      if (!seen.has(child)) {
        seen.add(child);
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

function childPidsSync(pid: number): number[] {
  try {
    const r = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (typeof r.stdout !== "string") return [];
    return r.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Rolling line buffer so failure diagnostics can show the log tail. */
class TailBuffer {
  private lines: string[] = [];
  private partial = "";
  constructor(private readonly max: number) {}
  push(text: string): void {
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.lines.push(line);
    if (this.lines.length > this.max) {
      this.lines.splice(0, this.lines.length - this.max);
    }
  }
  text(n: number): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines;
    return all.slice(-n).join("\n");
  }
}

/* ----- small helpers (not exported) ----- */

function tailText(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n").trim();
}

interface BunSubprocess {
  pid: number;
  exited: Promise<number>;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
}

interface BunShellPromise
  extends Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  cwd(dir: string): BunShellPromise;
  env(vars: Record<string, string | undefined>): BunShellPromise;
  quiet(): BunShellPromise;
  nothrow(): BunShellPromise;
}

interface BunGlobal {
  spawn(
    cmd: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdin?: "ignore";
      stdout?: "pipe";
      stderr?: "pipe";
    },
  ): BunSubprocess;
  $(strings: TemplateStringsArray, ...exprs: unknown[]): BunShellPromise;
}

function getBun(): BunGlobal {
  const bun = (globalThis as typeof globalThis & { Bun?: BunGlobal }).Bun;
  if (!bun) {
    throw new WebServerError("Bun runtime expected but not available");
  }
  return bun;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
