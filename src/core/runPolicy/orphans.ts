import { killProcessTreeSync } from "../../adapters/agent-browser/processTree";
import {
  ledgerWrittenAt,
  listLedger,
  removeLedgerFile,
  sessionPids,
  type LedgerEntry,
} from "./sessionLedger";
import type { ProcessProbe, ProcessRow } from "./processProbe";
import { systemProcessProbe } from "./processProbe";

/**
 * Orphan detection shared by `cairn doctor --orphans` and
 * `run.verifyClean: [browsers]`. A process counts only when a ledger entry
 * names it — and only while it is still the process cairn learnt (same
 * start time and command, see `sessionPids`) and still looks like a browser
 * cairn launches. Every pid is checked again right before it is signalled,
 * so a recycled pid (or the user's own browser) is never killed.
 */

/**
 * Commands a ledger-named pid may legitimately be: the agent-browser daemon
 * (its binary, or a script under an `agent-browser` package) and browsers
 * launched for automation (Playwright's cache or profile, a headless shell,
 * `--enable-automation` / `--remote-debugging-pipe`, a cairn / agent-browser
 * / Playwright user-data dir). A plain desktop Chrome or Firefox never is.
 */
export const BROWSER_COMMAND_RE =
  /^\S*agent-browser[\w.-]*(?:\s|$)|\/agent-browser\/|ms-playwright|playwright[_-](?:chromium|firefox|webkit)|headless_shell|--enable-automation|--remote-debugging-pipe|--user-data-dir=\S*(?:agent-browser|playwright|cairn)/i;

/** An owner gone this long leaves an entry that is never resolved again. */
export const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrphanProcess {
  pid: number;
  command: string;
  /** `ps -o lstart=` at scan time: re-checked right before a kill. */
  startedAt?: string;
}

export interface OrphanSession {
  session: string;
  backend: LedgerEntry["backend"];
  invocationId: string;
  ownerPid: number;
  startedAt: string;
  projectDir?: string;
  /** The ledger file (removed once nothing survives). */
  ledgerFile: string;
  processes: OrphanProcess[];
}

export interface OrphanScan {
  /** Sessions whose invocation is gone and whose processes survive. */
  orphans: OrphanSession[];
  /** Entries whose invocation is gone and whose processes are gone too. */
  stale: string[];
  /** Entries whose invocation is still running (never touched). */
  live: number;
}

function descendantsOf(
  rows: readonly ProcessRow[],
  root: number,
): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }
  const out: ProcessRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** The live browser processes (and their children) an entry names. */
export function survivorsOf(
  entry: LedgerEntry,
  probe: ProcessProbe,
  rows: readonly ProcessRow[],
  opts: { writtenAtMs?: number } = {},
): OrphanProcess[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const found = new Map<number, OrphanProcess>();
  const identify = (pid: number, command: string): OrphanProcess => {
    const startedAt = probe.startTime?.(pid);
    return { pid, command, ...(startedAt ? { startedAt } : {}) };
  };
  for (const pid of sessionPids(entry, probe, opts)) {
    if (!probe.isAlive(pid)) continue;
    const command = byPid.get(pid)?.command ?? probe.command(pid);
    if (!command || !BROWSER_COMMAND_RE.test(command)) continue;
    found.set(pid, identify(pid, command));
    for (const child of descendantsOf(rows, pid)) {
      found.set(child.pid, identify(child.pid, child.command));
    }
  }
  return [...found.values()].toSorted((a, b) => a.pid - b.pid);
}

/**
 * Is `proc` still the process the scan found? Alive, the same start time
 * (when both are known) and still a browser cairn launches.
 */
export function stillSameProcess(
  proc: OrphanProcess,
  probe: ProcessProbe,
): boolean {
  if (!probe.isAlive(proc.pid)) return false;
  if (proc.startedAt) {
    const now = probe.startTime?.(proc.pid);
    if (now !== undefined && now !== proc.startedAt) return false;
  }
  const command = probe.command(proc.pid);
  return command !== undefined && BROWSER_COMMAND_RE.test(command);
}

/** Is the cairn process that owned the entry still the same process? */
export function ownerStillRunning(
  entry: LedgerEntry,
  probe: ProcessProbe,
  now: number = Date.now(),
): boolean {
  if (!probe.isAlive(entry.ownerPid)) return false;
  const elapsed = probe.elapsedSeconds(entry.ownerPid);
  const started = Date.parse(entry.ownerStartedAt);
  if (elapsed !== undefined && Number.isFinite(started)) {
    // The live process is younger than the owner that wrote the entry: the
    // pid was recycled.
    if (elapsed + 5 < Math.floor((now - started) / 1000)) return false;
  }
  return true;
}

export interface ScanOptions {
  root?: string;
  probe?: ProcessProbe;
  now?: number;
}

/** Find cairn-owned browser survivors whose invocation is gone. */
export function scanOrphans(opts: ScanOptions = {}): OrphanScan {
  const probe = opts.probe ?? systemProcessProbe;
  const now = opts.now ?? Date.now();
  const rows = probe.list();
  const scan: OrphanScan = { orphans: [], stale: [], live: 0 };
  for (const { path, entry } of listLedger(opts.root)) {
    if (ownerStillRunning(entry, probe, now)) {
      scan.live += 1;
      continue;
    }
    // Expired: an entry this old is never resolved again (its pids, and its
    // session's pid file, long belong to other processes).
    const started = Date.parse(entry.startedAt);
    if (Number.isFinite(started) && now - started > LEDGER_MAX_AGE_MS) {
      scan.stale.push(path);
      continue;
    }
    const processes = survivorsOf(entry, probe, rows, {
      writtenAtMs: ledgerWrittenAt(path),
    });
    if (processes.length === 0) {
      scan.stale.push(path);
      continue;
    }
    scan.orphans.push({
      session: entry.session,
      backend: entry.backend,
      invocationId: entry.invocationId,
      ownerPid: entry.ownerPid,
      startedAt: entry.startedAt,
      ...(entry.projectDir ? { projectDir: entry.projectDir } : {}),
      ledgerFile: path,
      processes,
    });
  }
  return scan;
}

/** How long `killOrphans` waits for SIGKILLed processes to disappear. */
const KILL_SETTLE_MS = 2_000;

/**
 * Terminate the processes of orphan sessions (their trees, root first
 * discovered) and drop their ledger entries once nothing is left. Each
 * process is checked again right before it is signalled: one that exited,
 * was recycled (another start time) or no longer looks like a browser is
 * left alone. Returns the pids that are still alive afterwards.
 */
export function killOrphans(
  orphans: readonly OrphanSession[],
  probe: ProcessProbe = systemProcessProbe,
): { killed: number; remaining: number[] } {
  let killed = 0;
  const remaining: number[] = [];
  for (const orphan of orphans) {
    const verified = orphan.processes.filter((p) => stillSameProcess(p, probe));
    for (const proc of verified) {
      // The tree of each root (the daemon, or the browser itself).
      if (!probe.isAlive(proc.pid)) continue;
      killProcessTreeSync(proc.pid);
    }
    const pids = verified.map((p) => p.pid);
    // SIGKILL is not instant: give the processes a moment to disappear.
    const deadline = Date.now() + KILL_SETTLE_MS;
    let still = pids.filter((pid) => probe.isAlive(pid));
    while (still.length > 0 && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      still = pids.filter((pid) => probe.isAlive(pid));
    }
    killed += pids.length - still.length;
    if (still.length === 0) removeLedgerFile(orphan.ledgerFile);
    else remaining.push(...still);
  }
  return { killed, remaining };
}

/** Drop ledger files of entries with no owner and no survivors. */
export function pruneStale(paths: readonly string[]): number {
  let removed = 0;
  for (const path of paths) if (removeLedgerFile(path)) removed += 1;
  return removed;
}
