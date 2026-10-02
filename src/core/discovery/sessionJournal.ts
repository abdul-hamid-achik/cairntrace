import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ArtifactRedactor } from "../artifacts/ArtifactWriter";
import {
  SessionJournalReadSchema,
  DEFAULT_KEEP_SESSIONS,
  type SessionJournalFile,
} from "../schema/discovery.v1";
import { SessionEventReadSchema, type SessionEvent } from "../schema/events.v1";
import { placeholderSafeRedactor } from "./placeholderRedaction";

/** Directory under the artifact root holding one journal per session. */
export const SESSIONS_DIR = "_sessions";
/** session ids are UUIDs (or similar); never a path or a run-dir id. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export const SESSION_FILE = "session.json";
export const SESSION_EVENTS_FILE = "events.ndjson";
export const DRAFT_FILE = "draft.spec.yml";

const IDENTITY_REDACTOR: ArtifactRedactor = {
  value: <T>(input: T) => input,
  text: (input: string) => input,
};

/** `screenshots/007.png` style zero-padded names. */
export function journalSeq(n: number): string {
  return String(n).padStart(3, "0");
}

export function isSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * The journal of one discovery or accompany session at
 * `<artifactRoot>/_sessions/<sessionId>/`:
 *
 *   session.json      identity, inputs, status (rewritten atomically)
 *   events.ndjson     session.opened, action.performed, step.recorded, …
 *   screenshots/NNN.png   the page after action NNN
 *   snapshots/NNN.txt     full accessibility snapshots (redacted)
 *   network/NNN.json      requests observed during action NNN (redacted)
 *   draft.spec.yml        the spec the session would export right now
 *   setup/<runId>/        the run that executed the session's setup
 *
 * Writes are synchronous (small, ordered, safe from a signal handler) and
 * best-effort: a journal failure never fails the session. Everything that
 * reaches disk goes through the session's redactor, wrapped so a value made
 * only of placeholders (`?token=${secrets.X}`, `Bearer ${env.X}`) is kept:
 * it names a secret without holding one, and resume/export need it.
 */
export class SessionJournal {
  /** Absolute journal directory. */
  readonly dir: string;
  private state: SessionJournalFile;
  private redactor: ArtifactRedactor;

  private constructor(
    dir: string,
    state: SessionJournalFile,
    redactor: ArtifactRedactor,
  ) {
    this.dir = dir;
    this.state = state;
    this.redactor = placeholderSafeRedactor(redactor);
  }

  /**
   * Create `_sessions/<id>/`, write session.json and the `session.opened`
   * event. Undefined when the artifact root is not writable.
   */
  static create(
    artifactRoot: string,
    state: SessionJournalFile,
    redactor: ArtifactRedactor = IDENTITY_REDACTOR,
  ): SessionJournal | undefined {
    const root = join(resolve(artifactRoot), SESSIONS_DIR);
    const journal = new SessionJournal(
      join(root, state.sessionId),
      state,
      redactor,
    );
    try {
      mkdirSync(journal.dir, { recursive: true, mode: DIRECTORY_MODE });
      chmodSync(journal.dir, DIRECTORY_MODE);
      keepOutOfRecencyOrder(root);
      journal.writeState();
    } catch {
      return undefined;
    }
    journal.append({
      ts: state.openedAt,
      type: "session.opened",
      sessionId: state.sessionId,
      kind: state.kind,
    });
    return journal;
  }

  /** Re-attach to an existing journal (resume, export from journal). */
  static attach(
    dir: string,
    state: SessionJournalFile,
    redactor: ArtifactRedactor = IDENTITY_REDACTOR,
  ): SessionJournal {
    return new SessionJournal(dir, state, redactor);
  }

  get snapshot(): SessionJournalFile {
    return structuredClone(this.state);
  }

  get sessionId(): string {
    return this.state.sessionId;
  }

  /** Swap the redactor (secrets resolved after the journal was created). */
  setRedactor(redactor: ArtifactRedactor): void {
    this.redactor = placeholderSafeRedactor(redactor);
  }

  redactText(text: string): string {
    return this.redactor.text(text);
  }

  redactValue<T>(value: T): T {
    return this.redactor.value(value);
  }

  /**
   * Merge fields into session.json (atomic rewrite). Starts from the file
   * on disk, not this process's copy: another process may have written it
   * since (an export from the journal records `exportedTo` / `intent` while
   * the live session keeps writing), and every change of this process was
   * already written, so the file is the newest state.
   */
  update(patch: Partial<SessionJournalFile>): void {
    const disk = this.readState();
    const exportedTo = [
      ...new Set([
        ...(disk?.exportedTo ?? []),
        ...(this.state.exportedTo ?? []),
        ...(patch.exportedTo ?? []),
      ]),
    ];
    this.state = {
      ...(disk ?? this.state),
      ...patch,
      ...(exportedTo.length > 0 ? { exportedTo } : {}),
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete (this.state as Record<string, unknown>)[key];
      }
    }
    this.writeState();
  }

  /** This session's session.json as written, or undefined. */
  private readState(): SessionJournalFile | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.dir, SESSION_FILE), "utf8"),
      ) as SessionJournalFile | null;
      return parsed &&
        typeof parsed === "object" &&
        parsed.version === 1 &&
        parsed.sessionId === this.state.sessionId
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Bump `lastActivityAt`. */
  touch(now: Date = new Date()): void {
    this.update({ lastActivityAt: now.toISOString() });
  }

  /** Append one session event (redacted). */
  append(event: SessionEvent): void {
    try {
      appendFileSync(
        join(this.dir, SESSION_EVENTS_FILE),
        `${JSON.stringify(this.redactor.value(event))}\n`,
        { mode: FILE_MODE },
      );
    } catch {
      // Best-effort.
    }
  }

  /** Copy a screenshot to `screenshots/NNN.png`; returns its relative path. */
  copyScreenshot(index: number, source: string): string | undefined {
    const rel = `screenshots/${journalSeq(index)}.png`;
    try {
      mkdirSync(join(this.dir, "screenshots"), {
        recursive: true,
        mode: DIRECTORY_MODE,
      });
      copyFileSync(source, join(this.dir, rel));
      chmodSync(join(this.dir, rel), FILE_MODE);
      return rel;
    } catch {
      return undefined;
    }
  }

  /**
   * Write a (redacted) text file; returns its relative path and bytes.
   * `preRedacted`: the caller redacted the content structurally (a YAML
   * draft built from redacted values) — a text pass over YAML would cut a
   * quoted placeholder and leave the file unparseable.
   */
  writeText(
    rel: string,
    text: string,
    opts: { preRedacted?: boolean } = {},
  ): { path: string; bytes: number } | undefined {
    const redacted = opts.preRedacted ? text : this.redactor.text(text);
    try {
      const abs = join(this.dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true, mode: DIRECTORY_MODE });
      writeFileSync(abs, redacted, { mode: FILE_MODE });
      return { path: rel, bytes: Buffer.byteLength(redacted) };
    } catch {
      return undefined;
    }
  }

  /** Write (redacted) JSON; returns its relative path. */
  writeJson(rel: string, value: unknown): string | undefined {
    return this.writeText(
      rel,
      `${JSON.stringify(this.redactor.value(value), null, 2)}\n`,
    )?.path;
  }

  /** The absolute path of a journal-relative file. */
  resolve(rel: string): string {
    return join(this.dir, rel);
  }

  private writeState(): void {
    const target = join(this.dir, SESSION_FILE);
    const temporary = join(this.dir, `.${SESSION_FILE}.${process.pid}.tmp`);
    try {
      const value = this.redactor.value(this.state);
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: FILE_MODE,
      });
      renameSync(temporary, target);
    } catch {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // The temporary file may not exist.
      }
    }
  }
}

/** A journal as read from disk. */
export interface SessionJournalRead {
  dir: string;
  session: SessionJournalFile;
  events: SessionEvent[];
  /**
   * `step.recorded` / `step.removed` lines that could not be read: the
   * recorded steps are incomplete, so export and resume refuse the journal.
   */
  unreadableSteps?: number;
}

/** Read `session.json`; undefined when missing or unreadable. */
export async function readSessionFile(
  dir: string,
): Promise<SessionJournalFile | undefined> {
  try {
    const parsed = SessionJournalReadSchema.safeParse(
      JSON.parse(await readFile(join(dir, SESSION_FILE), "utf8")),
    );
    return parsed.success ? (parsed.data as SessionJournalFile) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a journal: session.json plus every event this build understands.
 * Fields a newer cairn added are dropped, not fatal; an event type this
 * build does not know and a torn last line are skipped. A step event that
 * still cannot be read is counted ({@link SessionJournalRead.unreadableSteps}).
 */
export async function readSessionJournal(
  dir: string,
): Promise<SessionJournalRead | undefined> {
  const session = await readSessionFile(dir);
  if (!session) return undefined;
  const raw = await readFile(join(dir, SESSION_EVENTS_FILE), "utf8").catch(
    () => "",
  );
  const events: SessionEvent[] = [];
  let unreadableSteps = 0;
  const lines = raw.split("\n");
  lines.forEach((line, n) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A torn last line (process killed mid-write) is skipped; a torn
      // step line anywhere else lost a step.
      if (n < lines.length - 1 && /"type":"step\./.test(line)) {
        unreadableSteps++;
      }
      return;
    }
    const parsed = SessionEventReadSchema.safeParse(value);
    if (parsed.success) {
      events.push(parsed.data);
      return;
    }
    const type = (value as { type?: unknown } | null)?.type;
    if (type === "step.recorded" || type === "step.removed") unreadableSteps++;
  });
  return {
    dir,
    session,
    events,
    ...(unreadableSteps > 0 ? { unreadableSteps } : {}),
  };
}

/**
 * The exportable steps of a journal: every `step.recorded` not later undone
 * by a `step.removed`, in action order; plus the number of failed actions.
 */
export function journalSteps(events: readonly SessionEvent[]): {
  steps: Array<{ index: number; step: Record<string, unknown> }>;
  failedActions: number;
} {
  const recorded = new Map<number, Record<string, unknown>>();
  let failedActions = 0;
  for (const event of events) {
    if (event.type === "step.recorded") recorded.set(event.index, event.step);
    else if (event.type === "step.removed") recorded.delete(event.index);
    else if (
      event.type === "action.performed" &&
      !event.ok &&
      event.action !== "setup"
    ) {
      failedActions++;
    }
  }
  return {
    steps: [...recorded.entries()]
      .toSorted((a, b) => a[0] - b[0])
      .map(([index, step]) => ({ index, step })),
    failedActions,
  };
}

/** Session ids under the artifact root (directory names). */
export async function listSessionIds(artifactRoot: string): Promise<string[]> {
  const entries = await readdir(join(artifactRoot, SESSIONS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && isSessionId(entry.name))
    .map((entry) => entry.name);
}

/** Every readable session.json under the artifact root, newest first. */
export async function listSessions(
  artifactRoot: string,
): Promise<Array<{ dir: string; session: SessionJournalFile }>> {
  const out: Array<{ dir: string; session: SessionJournalFile }> = [];
  for (const id of await listSessionIds(artifactRoot)) {
    const dir = join(artifactRoot, SESSIONS_DIR, id);
    const session = await readSessionFile(dir);
    if (session) out.push({ dir, session });
  }
  return out.toSorted((a, b) =>
    b.session.openedAt.localeCompare(a.session.openedAt),
  );
}

/**
 * Resolve `--from-session <dir|id>`: an existing directory holding a
 * session.json, else a session id under `<artifactRoot>/_sessions/`.
 */
export async function resolveSessionDir(
  ref: string,
  artifactRoot: string,
): Promise<string> {
  const asPath = isAbsolute(ref) ? ref : resolve(ref);
  if (
    (ref.includes("/") || ref.includes("\\") || isAbsolute(ref)) &&
    (await exists(join(asPath, SESSION_FILE)))
  ) {
    return asPath;
  }
  if (isSessionId(ref)) {
    const dir = join(resolve(artifactRoot), SESSIONS_DIR, ref);
    if (await exists(join(dir, SESSION_FILE))) return dir;
  }
  if (await exists(join(asPath, SESSION_FILE))) return asPath;
  throw new Error(
    `session journal not found: ${ref} (looked for ${SESSIONS_DIR}/${ref}/${SESSION_FILE} under ${artifactRoot})`,
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The pid of another live process holding a journal open: status `open`, a
 * pid other than this one that is alive, and a TTL that has not run out (a
 * pid recycled after a crash must not hold the journal forever). Two
 * writers on one journal collide on action indexes and screenshot files.
 */
export function openElsewhere(
  session: SessionJournalFile,
  opts: { now?: number; pidAlive?: (pid: number) => boolean } = {},
): number | undefined {
  if (session.status !== "open" || session.pid === process.pid) {
    return undefined;
  }
  const idleMs = (opts.now ?? Date.now()) - Date.parse(session.lastActivityAt);
  if (Number.isFinite(idleMs) && idleMs > session.ttlMs) return undefined;
  return (opts.pidAlive ?? defaultPidAlive)(session.pid)
    ? session.pid
    : undefined;
}

/** Whether `pid` names a live process (EPERM counts as alive). */
function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PruneSessionsOptions {
  /** Newest journals always kept. Default {@link DEFAULT_KEEP_SESSIONS}. */
  keep?: number;
  pidAlive?: (pid: number) => boolean;
}

/**
 * Remove session journals beyond the newest `keep`, except:
 *   - an `open` session whose process is alive,
 *   - a session a draft still references: one of its `exportedTo` specs
 *     exists and names the session (the exported header carries the id),
 *   - a session.json this build cannot read (it may come from a newer cairn).
 * Returns the removed ids.
 */
export async function pruneSessions(
  artifactRoot: string,
  opts: PruneSessionsOptions = {},
): Promise<string[]> {
  const keep = Math.max(0, opts.keep ?? DEFAULT_KEEP_SESSIONS);
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  const root = join(artifactRoot, SESSIONS_DIR);
  const ids = await listSessionIds(artifactRoot);
  const dated: Array<{ id: string; at: string; session?: SessionJournalFile }> =
    [];
  for (const id of ids) {
    const dir = join(root, id);
    const session = await readSessionFile(dir);
    if (!session) {
      // Unreadable: skip when a session.json exists (newer cairn), else a
      // husk dated by its mtime.
      if (await exists(join(dir, SESSION_FILE))) continue;
      const mtime = (await stat(dir).catch(() => undefined))?.mtime;
      dated.push({ id, at: (mtime ?? new Date(0)).toISOString() });
      continue;
    }
    dated.push({ id, at: session.openedAt, session });
  }
  dated.sort((a, b) => b.at.localeCompare(a.at));
  const removed: string[] = [];
  for (const entry of dated.slice(keep)) {
    const session = entry.session;
    if (session) {
      if (session.status === "open" && pidAlive(session.pid)) continue;
      if (await referencedByDraft(session)) continue;
    }
    await rm(join(root, entry.id), { recursive: true, force: true });
    removed.push(entry.id);
  }
  if (removed.length > 0) keepOutOfRecencyOrder(root);
  return removed.toSorted();
}

async function referencedByDraft(
  session: SessionJournalFile,
): Promise<boolean> {
  for (const path of session.exportedTo ?? []) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text?.includes(session.sessionId)) return true;
  }
  return false;
}

/**
 * Tools that pick the "latest" run by directory mtime list every directory
 * under the artifact root; pin `_sessions/` to the epoch so it never looks
 * like the newest run (journals inside are found by name).
 */
function keepOutOfRecencyOrder(sessionsRoot: string): void {
  try {
    utimesSync(sessionsRoot, new Date(0), new Date(0));
  } catch {
    // Best-effort.
  }
}
