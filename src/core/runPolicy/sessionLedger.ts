import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ProcessProbe } from "./processProbe";
import { systemProcessProbe } from "./processProbe";

/**
 * The owned browser-session ledger: one small file per browser session
 * cairn starts (agent-browser session or Playwright browser), written when
 * the backend is created and removed when it closed cleanly. It is what
 * lets `cairn doctor --orphans` and `run.verifyClean: [browsers]` tell
 * cairn's own survivors from anybody else's browsers: a process is only ever
 * considered when a ledger entry names it.
 *
 * `~/.cairntrace/sessions-ledger/<invocation>.<session>.json`. Every write is
 * best-effort: the ledger never fails a run.
 */

/**
 * Who a learnt pid was when cairn learnt it: its start time (`ps -o lstart`)
 * and command line. A pid whose start time or command no longer matches is
 * a recycled pid — another process — and is never reported or signalled.
 */
export const LedgerProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    /** `ps -o lstart=` of the process when the pid was learnt. */
    startedAt: z.string().min(1).optional(),
    /** Its command line then (bounded). */
    command: z.string().min(1).optional(),
  })
  .passthrough();
export type LedgerProcess = z.infer<typeof LedgerProcessSchema>;

export const LedgerEntrySchema = z
  .object({
    version: z.literal(1),
    session: z.string().min(1),
    backend: z.enum(["agent-browser", "playwright"]),
    invocationId: z.string().min(1),
    /** The cairn process (CLI process or MCP server) that owns the session. */
    ownerPid: z.number().int().positive(),
    /** When that process started (pid-reuse guard). */
    ownerStartedAt: z.string().min(1),
    startedAt: z.string().min(1),
    /** Directory of the project config (what `verifyClean` scopes to). */
    projectDir: z.string().min(1).optional(),
    /** Browser pids learnt while the session ran (Playwright; agent-browser's daemon). */
    pids: z.array(z.number().int().positive()).optional(),
    /** The identity of each learnt pid (start time + command). */
    processes: z.array(LedgerProcessSchema).optional(),
    /** agent-browser state dir, when it is not `~/.agent-browser`. */
    stateDir: z.string().min(1).optional(),
  })
  .passthrough();
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * The agent-browser session names of `cairn run` / MCP `cairn_run`
 * (`cairntrace-<pid>`, `cairntrace-mcp-<pid>-<id6>`, with `-w<n>-s<n>` per
 * batch spec). Discovery (`cairntrace-disc-…`), accompany, snapshot and heal
 * sessions — and anybody else's — do not match.
 */
const RUN_SESSION_RE =
  /^cairntrace-(?:\d+|mcp-\d+-[0-9a-f]{6})(?:-w\d+-s\d+)?$/;

export function isRunSessionName(session: string): boolean {
  return RUN_SESSION_RE.test(session);
}

export function ledgerRoot(): string {
  return join(homedir(), ".cairntrace", "sessions-ledger");
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

export interface RecordSessionOptions {
  session: string;
  backend: "agent-browser" | "playwright";
  invocationId: string;
  projectDir?: string;
  stateDir?: string;
  root?: string;
  pid?: number;
  now?: () => number;
  /** Where pid identities are read (tests pass a fake; default `ps`). */
  probe?: ProcessProbe;
}

/** How long a command line is kept for the identity check. */
const IDENTITY_COMMAND_CHARS = 300;
/** How much of it must still match (a browser may append to its title). */
const IDENTITY_MATCH_CHARS = 80;

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** The identity of a live pid, as far as the probe can tell. */
export function processIdentity(
  pid: number,
  probe: ProcessProbe,
): LedgerProcess {
  const startedAt = probe.startTime?.(pid);
  const command = probe.command(pid);
  return {
    pid,
    ...(startedAt ? { startedAt } : {}),
    ...(command
      ? { command: normalizeCommand(command).slice(0, IDENTITY_COMMAND_CHARS) }
      : {}),
  };
}

/**
 * Is the live `pid` still the process `identity` recorded? A different
 * start time or command means the pid was recycled. What the probe cannot
 * read is not held against it.
 */
export function sameProcess(
  identity: LedgerProcess,
  probe: ProcessProbe,
): boolean {
  if (identity.startedAt) {
    const now = probe.startTime?.(identity.pid);
    if (now !== undefined && now !== identity.startedAt) return false;
  }
  if (identity.command) {
    const now = probe.command(identity.pid);
    if (now !== undefined) {
      const a = normalizeCommand(now).slice(0, IDENTITY_MATCH_CHARS);
      const b = identity.command.slice(0, IDENTITY_MATCH_CHARS);
      if (a !== b) return false;
    }
  }
  return true;
}

/** `ps -o lstart=` text → epoch ms (undefined when it does not parse). */
export function parseLstart(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const ms = Date.parse(text.trim().replace(/\s+/g, " "));
  return Number.isFinite(ms) ? ms : undefined;
}

export interface LedgerHandle {
  readonly path: string;
  /** Record browser pids (merged, written only when they changed). */
  setPids(pids: readonly number[]): void;
  /**
   * The session closed. The entry is removed unless a recorded or session
   * pid is still alive (a survivor stays on the ledger for `doctor --orphans`).
   */
  finish(probe?: ProcessProbe): void;
  /** Remove the entry unconditionally. */
  remove(): void;
}

/** Record one session. Never throws. */
export function recordLedgerSession(opts: RecordSessionOptions): LedgerHandle {
  const root = opts.root ?? ledgerRoot();
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const probe = opts.probe ?? systemProcessProbe;
  const path = join(
    root,
    `${slug(opts.invocationId)}.${slug(opts.session)}.${randomBytes(2).toString("hex")}.json`,
  );
  const entry: LedgerEntry = {
    version: 1,
    session: opts.session,
    backend: opts.backend,
    invocationId: opts.invocationId,
    ownerPid: pid,
    ownerStartedAt: new Date(now() - process.uptime() * 1000).toISOString(),
    startedAt: new Date(now()).toISOString(),
    ...(opts.projectDir ? { projectDir: opts.projectDir } : {}),
    ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
  };
  const write = (): void => {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temp = `${path}.${pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temp, path);
    } catch {
      // The ledger is best-effort.
    }
  };
  write();
  const remove = (): void => {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  };
  return {
    path,
    setPids(pids) {
      const merged = [...new Set([...(entry.pids ?? []), ...pids])]
        .filter((p) => Number.isInteger(p) && p > 1)
        .toSorted((a, b) => a - b);
      if (
        merged.length === (entry.pids?.length ?? 0) &&
        merged.every((p, i) => p === entry.pids?.[i])
      ) {
        return;
      }
      // Learnt now, while the session runs: this is who the pid is. A later
      // scan only trusts the pid while it is still this process.
      const known = new Set((entry.processes ?? []).map((p) => p.pid));
      const learnt = merged
        .filter((p) => !known.has(p))
        .map((p) => processIdentity(p, probe));
      entry.pids = merged;
      entry.processes = [...(entry.processes ?? []), ...learnt].toSorted(
        (a, b) => a.pid - b.pid,
      );
      write();
    },
    finish(finishProbe = probe) {
      // The owner is this process: its own session's pid file is current.
      const live = sessionPids(entry, finishProbe, {
        trustPidFile: true,
      }).filter((p) => finishProbe.isAlive(p));
      if (live.length === 0) remove();
    },
    remove,
  };
}

/** How far from the entry's start an unlearnt daemon may have started (ms). */
const PID_FILE_WINDOW_MS = 120_000;
/** Clock and `lstart` rounding slack (ms). */
const START_SLACK_MS = 5_000;

export interface SessionPidsOptions {
  /**
   * When the ledger file was last written (epoch ms): a pid recorded
   * without an identity (an older entry) must have started before it.
   */
  writtenAtMs?: number;
  /** The owner itself asks (its session's pid file is current). */
  trustPidFile?: boolean;
}

function readSessionPidFile(entry: LedgerEntry): number | undefined {
  try {
    const raw = readFileSync(
      join(
        entry.stateDir ?? join(homedir(), ".agent-browser"),
        `${entry.session}.pid`,
      ),
      "utf8",
    );
    const daemon = Number(raw.trim());
    return Number.isInteger(daemon) && daemon > 1 ? daemon : undefined;
  } catch {
    // no pid file: the daemon is gone or never started
    return undefined;
  }
}

/**
 * The pids an entry can still name, verified: a learnt pid only while it is
 * the process cairn learnt (same start time and command), an older entry's
 * bare pid only when it started before the entry was last written, and
 * agent-browser's `<session>.pid` file only for an entry that never learnt a
 * pid and only for a daemon that started with the entry (a later process
 * reusing the session name — `cairntrace-<pid>` recurs with pid reuse — is
 * someone else's).
 */
export function sessionPids(
  entry: LedgerEntry,
  probe: ProcessProbe = systemProcessProbe,
  opts: SessionPidsOptions = {},
): number[] {
  const out = new Set<number>();
  const identities = new Map(
    (entry.processes ?? []).map((identity) => [identity.pid, identity]),
  );
  const recorded = new Set<number>([
    ...(entry.pids ?? []),
    ...identities.keys(),
  ]);
  for (const pid of recorded) {
    const identity = identities.get(pid);
    if (identity) {
      if (sameProcess(identity, probe)) out.add(pid);
      continue;
    }
    // A bare pid (written before identities were recorded).
    if (opts.writtenAtMs !== undefined) {
      const started = parseLstart(probe.startTime?.(pid));
      if (
        started !== undefined &&
        started > opts.writtenAtMs + START_SLACK_MS
      ) {
        continue;
      }
    }
    out.add(pid);
  }
  if (entry.backend === "agent-browser" && recorded.size === 0) {
    const daemon = readSessionPidFile(entry);
    if (daemon !== undefined) {
      if (opts.trustPidFile) {
        out.add(daemon);
      } else {
        const started = parseLstart(probe.startTime?.(daemon));
        const entryStart = Date.parse(entry.startedAt);
        if (
          started !== undefined &&
          Number.isFinite(entryStart) &&
          started >= entryStart - START_SLACK_MS &&
          started <= entryStart + PID_FILE_WINDOW_MS
        ) {
          out.add(daemon);
        }
      }
    }
  }
  return [...out];
}

/** When a ledger file was last written (epoch ms), if it can be read. */
export function ledgerWrittenAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export interface LedgerListing {
  path: string;
  entry: LedgerEntry;
}

/** Every readable entry; unreadable files are skipped. */
export function listLedger(root: string = ledgerRoot()): LedgerListing[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: LedgerListing[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try {
      const parsed = LedgerEntrySchema.safeParse(
        JSON.parse(readFileSync(path, "utf8")),
      );
      if (parsed.success) out.push({ path, entry: parsed.data });
    } catch {
      // not a ledger entry
    }
  }
  return out;
}

/** Remove one ledger file; false when it was already gone. */
export function removeLedgerFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
