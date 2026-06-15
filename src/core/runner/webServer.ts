import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import type { WebServerConfig } from "../schema/config.v1";

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
  const env = { ...process.env, ...cfg.env };

  // Reuse / conflict check: is something already answering the readiness URL?
  if (effectiveUrl && (await probeOnce(effectiveUrl))) {
    if (reuse) {
      ctx.log?.(`web server: reusing the server already answering ${effectiveUrl}`);
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

  const readyTimeoutMs = cfg.readyTimeoutMs ?? DEFAULT_READY_MS;
  const deadline = Date.now() + readyTimeoutMs;
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
      if (effectiveUrl && ready) ready = await probeOnce(effectiveUrl);
      if (ready) break;
      if (Date.now() >= deadline) {
        throw new WebServerError(
          `web server did not become ready within ${readyTimeoutMs}ms ` +
            `(probed ${effectiveUrl ?? "—"}${cfg.waitForText ? `, waiting for "${cfg.waitForText}"` : ""})`,
        );
      }
      await sleep(POLL_MS);
    }
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

/* ----- readiness probe (runtime-agnostic) ----- */

/**
 * One readiness attempt: ANY HTTP response (200/3xx/4xx/5xx) means "the socket
 * accepts and the app replies", i.e. up. Connection refused / timeout = down.
 */
async function probeOnce(url: string): Promise<boolean> {
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

/* ----- spawn (Bun-native, node fallback for the test gate) ----- */

interface SpawnedProc {
  pid: number;
  exited: Promise<number | null>;
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
}

interface SpawnOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function spawnProcess(command: string, opts: SpawnOpts): SpawnedProc {
  return hasBunRuntime()
    ? spawnBun(command, opts)
    : spawnNode(command, opts);
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

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runShell(
  command: string,
  { cwd, env }: SpawnOpts,
): Promise<ShellResult> {
  if (hasBunRuntime()) {
    const r = await getBun()
      .$`/bin/sh -c ${command}`.cwd(cwd)
      .env(env as Record<string, string | undefined>)
      .quiet()
      .nothrow();
    return {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    };
  }
  const r = await execa(command, { cwd, env, shell: true, reject: false });
  return {
    exitCode: r.exitCode ?? 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

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

/* ----- small helpers ----- */

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

function tailText(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n").trim();
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

function hasBunRuntime(): boolean {
  return Boolean(process.versions.bun);
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Synchronous sleep — usable inside the signal handler where timers never fire. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
