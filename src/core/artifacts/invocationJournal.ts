import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRedactor } from "./ArtifactWriter";
import { isSensitiveEnvKey } from "./redaction";
import { LiveLog, logIndex, logSlug } from "./liveLog";
import { PhaseTracker } from "./phaseTracker";
import {
  InvocationJournalReadSchema,
  isServicesEventType,
  type InvocationDelegate,
  type InvocationJournalFile,
  type InvocationPlannedRun,
  type InvocationStatus,
  type InvocationSummary,
  type RunEvent,
} from "../schema/events.v1";
import type { RunInvocationRef } from "../schema/run.v1";

/** Directory under the artifact root holding one journal per invocation. */
export const INVOCATIONS_DIR = "_invocations";
/** `<ISO with ':'/'.' → '-'>_<pid>_<6 hex>`; never matches a run-dir id. */
export const INVOCATION_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T[\d-]+Z_\d+_[0-9a-f]{6}$/;
/** Journals kept regardless of whether their runs still exist. */
export const DEFAULT_KEEP_INVOCATIONS = 20;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const JOURNAL_FILE = "invocation.json";
const EVENTS_FILE = "events.ndjson";
const IDENTITY_REDACTOR: ArtifactRedactor = {
  value: <T>(input: T) => input,
  text: (input: string) => input,
};

/** Longest run-id slug in a per-run hook log name. */
const RUN_LOG_SLUG_MAX = 96;
/** Characters kept from the end of a longer run id (`…<spec tail>_<hex6>`). */
const RUN_LOG_SLUG_TAIL = 24;

/**
 * File-name slug for a run id that never loses what makes the id unique: a
 * longer id drops the middle of its spec name, never the `<timestamp>` head
 * or the `_<hex6>` tail, so runs started in the same millisecond still get
 * distinct names.
 */
function runLogSlug(runId: string): string {
  const full = logSlug(runId, Number.POSITIVE_INFINITY);
  if (full.length <= RUN_LOG_SLUG_MAX) return full;
  const head = full.slice(0, RUN_LOG_SLUG_MAX - RUN_LOG_SLUG_TAIL - 2);
  return `${head}--${full.slice(-RUN_LOG_SLUG_TAIL)}`;
}

/** A fresh invocation id for `now` and `pid`. */
export function generateInvocationId(
  now: Date = new Date(),
  pid: number = process.pid,
  suffix: string = randomBytes(3).toString("hex"),
): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}_${pid}_${suffix}`;
}

export interface InvocationJournalOptions {
  artifactRoot: string;
  /** CLI arguments after the binary; redacted before they are written. */
  argv: readonly string[];
  cwd: string;
  /** Entry point that started the invocation (`cli` | `mcp`). */
  origin?: "cli" | "mcp";
  /** MCP client that requested it (`name/version`). */
  client?: string;
  configPath?: string;
  env?: string;
  /** The alias name `--env` used, when `env` is its target. */
  envAlias?: string;
  labels?: Record<string, string>;
  /** `cairn run --suite`: the config suite the specs came from. */
  suite?: string;
  parallel: number;
  planned: InvocationPlannedRun[];
  redactor?: ArtifactRedactor;
  now?: () => Date;
  pid?: number;
  /** Heartbeat cadence (default 15s; 0 disables). */
  heartbeatIntervalMs?: number;
  /** Override the generated id (tests). */
  invocationId?: string;
}

type LogKind = "hook" | "services" | "narration" | "delegate";

/**
 * The journal of one `cairn run` process at
 * `<artifactRoot>/_invocations/<invocationId>/`:
 *
 *   invocation.json   plan, status, current run, runs, final summary
 *                     (rewritten atomically: temp file + rename)
 *   events.ndjson     invocation.*, services.* (live), hook.*,
 *                     phase.changed, run.heartbeat
 *   logs/             services-docker.log, services-seed.log,
 *                     services-teardown.log,
 *                     hook-before-NN.log, hook-after-NN-<runId>.log,
 *                     narration.log
 *
 * Everything is written synchronously: the writes are small and rare, they
 * keep their order, and `abortSync()` can run inside a signal handler. Every
 * write is best-effort; a journal failure never fails the run.
 */
export class InvocationJournal {
  readonly id: string;
  /** Absolute journal directory. */
  readonly dir: string;
  /** Journal directory relative to the artifact root. */
  readonly relativeDir: string;
  readonly tracker: PhaseTracker;
  private readonly redactor: ArtifactRedactor;
  private readonly now: () => Date;
  private readonly logs = new Map<string, LiveLog>();
  /** Every per-run hook log name handed out; a name is never reused. */
  private readonly perRunLogFiles = new Set<string>();
  private state: InvocationJournalFile;
  private settled = false;

  private constructor(opts: InvocationJournalOptions) {
    this.redactor = opts.redactor ?? IDENTITY_REDACTOR;
    this.now = opts.now ?? (() => new Date());
    const startedAt = this.now();
    const pid = opts.pid ?? process.pid;
    this.id = opts.invocationId ?? generateInvocationId(startedAt, pid);
    this.relativeDir = `${INVOCATIONS_DIR}/${this.id}`;
    this.dir = join(opts.artifactRoot, INVOCATIONS_DIR, this.id);
    const labels =
      opts.labels && Object.keys(opts.labels).length > 0
        ? opts.labels
        : undefined;
    this.state = {
      version: 1,
      invocationId: this.id,
      pid,
      argv: redactArgv(opts.argv, this.redactor),
      cwd: opts.cwd,
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.envAlias ? { envAlias: opts.envAlias } : {}),
      ...(labels ? { labels } : {}),
      ...(opts.suite ? { suite: opts.suite } : {}),
      parallel: Math.max(1, opts.parallel),
      planned: opts.planned,
      status: "running",
      startedAt: startedAt.toISOString(),
      runs: [],
    };
    this.tracker = new PhaseTracker({
      append: async (event) => this.appendEvent(event),
      pid,
      ...(opts.heartbeatIntervalMs !== undefined
        ? { intervalMs: opts.heartbeatIntervalMs }
        : {}),
    });
  }

  /**
   * Create the journal directory, write the first invocation.json and the
   * `invocation.started` event. Returns undefined when the artifact root is
   * not writable (the run goes on without a journal).
   */
  static create(opts: InvocationJournalOptions): InvocationJournal | undefined {
    const journal = new InvocationJournal(opts);
    try {
      const root = join(opts.artifactRoot, INVOCATIONS_DIR);
      mkdirSync(journal.dir, { recursive: true, mode: DIRECTORY_MODE });
      chmodSync(journal.dir, DIRECTORY_MODE);
      keepOutOfRecencyOrder(root);
      journal.writeState();
    } catch {
      return undefined;
    }
    journal.appendEvent({
      ts: journal.state.startedAt,
      type: "invocation.started",
      invocationId: journal.id,
      planned: journal.state.planned.length,
    });
    journal.openLog("narration.log", "narration", "invocation");
    return journal;
  }

  /** A snapshot of the journal as last written. */
  get snapshot(): InvocationJournalFile {
    return structuredClone(this.state);
  }

  /** Number of planned spec runs. */
  get plannedTotal(): number {
    return this.state.planned.length;
  }

  /** The link stamped into run.json / run.started for planned run `index`. */
  ref(index: number): RunInvocationRef {
    return {
      id: this.id,
      index,
      total: this.state.planned.length,
      dir: this.relativeDir,
    };
  }

  /** Append one invocation-level event (redacted). */
  appendEvent(event: RunEvent): void {
    try {
      appendFileSync(
        join(this.dir, EVENTS_FILE),
        `${JSON.stringify(this.redactor.value(event))}\n`,
        { mode: FILE_MODE },
      );
    } catch {
      // Best-effort: the run's own events.ndjson stays authoritative.
    }
  }

  /** Write one services lifecycle event live (`services.<phase>.<event>`). */
  appendServicesEvent(event: {
    phase: string;
    event: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }): void {
    const type = `services.${event.phase}.${event.event}`;
    if (!isServicesEventType(type)) return;
    this.appendEvent({
      ts: event.timestamp,
      type,
      message: event.message,
      ...(event.data ? { data: event.data } : {}),
    });
  }

  /** Redact free text with the invocation's redactor. */
  redactText(text: string): string {
    return this.redactor.text(text);
  }

  /**
   * The live log `logs/<file>`, opened (and announced with `log.opened`) on
   * first use and appended to afterwards.
   */
  openLog(file: string, kind: LogKind, name: string): LiveLog {
    const existing = this.logs.get(file);
    if (existing) return existing;
    const path = `logs/${file}`;
    const log = new LiveLog(join(this.dir, path), {
      redact: (line) => this.redactor.text(line),
    });
    this.logs.set(file, log);
    this.appendEvent({
      ts: this.now().toISOString(),
      type: "log.opened",
      kind,
      name,
      path,
    });
    return log;
  }

  /**
   * The live log of one hook execution. `--before` hooks run one at a time,
   * so every iteration shares `logs/hook-before-NN.log`. An `--after` hook
   * runs once per spec run, concurrently under `--parallel`, so each run gets
   * its own `logs/hook-after-NN-<runId>.log`: concurrent output never
   * interleaves inside one file. A long run id loses the middle of its spec
   * name, never its timestamp or random suffix, and a per-run name is never
   * handed out twice (a repeat gets `-2`, `-3`, …), so two executions can
   * never share a file. Call `release()` when the execution ends; it closes
   * a per-run file (a shared one stays open until `finish`).
   */
  hookLog(
    hook: "before" | "after",
    index: number,
    runId?: string,
  ): {
    log: LiveLog;
    path: string;
    release(): void;
  } {
    if (!runId) {
      const file = `hook-${hook}-${logIndex(index)}.log`;
      return {
        log: this.openLog(file, "hook", `${hook}#${index}`),
        path: `logs/${file}`,
        release: () => {},
      };
    }
    const stem = `hook-${hook}-${logIndex(index)}-${runLogSlug(runId)}`;
    let file = `${stem}.log`;
    for (let n = 2; this.perRunLogFiles.has(file); n += 1) {
      file = `${stem}-${n}.log`;
    }
    this.perRunLogFiles.add(file);
    const log = this.openLog(file, "hook", `${hook}#${index}`);
    return {
      log,
      path: `logs/${file}`,
      release: () => {
        log.close();
        this.logs.delete(file);
      },
    };
  }

  /** `logs/services-<source>.log` for docker / seed / teardown command output. */
  servicesLog(source: "docker" | "seed" | "teardown" | "provisioner"): LiveLog {
    return this.openLog(`services-${source}.log`, "services", source);
  }

  /**
   * Signal path: append one redacted line to `logs/services-<source>.log`
   * synchronously, even after `abortSync()` closed the live logs (the
   * services teardown runs after the journal was marked aborted).
   */
  appendServicesLogSync(source: "teardown", line: string): void {
    try {
      const dir = join(this.dir, "logs");
      mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
      appendFileSync(
        join(dir, `services-${source}.log`),
        `${this.redactor.text(line)}\n`,
        { mode: FILE_MODE },
      );
    } catch {
      // Best-effort, like every journal write.
    }
  }

  /**
   * `logs/delegate.log`: a delegated runner's stdout and stderr, redacted
   * line by line as cairn copies them from the runner's raw output file.
   */
  delegateLog(): LiveLog {
    return this.openLog("delegate.log", "delegate", "runner");
  }

  /**
   * Merge `patch` into invocation.json's `delegate` block and rewrite the
   * file (also after the journal settled: the runner's last facts land on
   * the signal path, right before the process exits).
   */
  setDelegate(patch: Partial<InvocationDelegate>): void {
    // The first call names the contract and the command.
    this.state.delegate = {
      ...this.state.delegate,
      ...patch,
    } as InvocationDelegate;
    this.writeState();
  }

  /** One batch-level narration line in `logs/narration.log`. */
  narrate(message: string): void {
    const log = this.openLog("narration.log", "narration", "invocation");
    const stamp = this.now().toISOString().slice(11, 19);
    for (const line of message.split(/\r?\n/)) {
      if (line.trim().length > 0) log.writeLine(`[${stamp}] ${line}`);
    }
  }

  /** A planned run is about to start (no run directory yet). */
  runStarting(index: number, spec: string): void {
    if (this.settled) return;
    this.state.current = { index, spec };
    this.writeState();
  }

  /** The run directory of planned run `index` exists. */
  runStarted(index: number, spec: string, runId: string, runDir: string): void {
    if (this.settled) return;
    // A run that already settled never goes back to running (a delegated
    // runner that re-streams its run lines).
    const existing = this.state.runs.find((run) => run.index === index);
    if (
      existing?.runId === runId &&
      existing.status !== undefined &&
      existing.status !== "running"
    ) {
      return;
    }
    this.state.current = { index, spec, runId };
    this.upsertRun({ index, spec, runId, runDir, status: "running" });
    this.writeState();
  }

  /**
   * Planned run `index` was refused by the environment policy before its run
   * started: it never gets a run entry, and `current` no longer points at it.
   */
  runRefused(index: number): void {
    if (this.settled) return;
    if (this.state.current?.index === index && !this.state.current.runId) {
      delete this.state.current;
      this.writeState();
    }
  }

  /** Planned run `index` settled. */
  runFinished(entry: {
    index: number;
    spec: string;
    runId: string;
    runDir: string;
    status: "passed" | "failed" | "errored";
    /** No run directory was ever written (`runId`/`runDir` are placeholders). */
    synthetic?: true;
  }): void {
    if (this.settled) return;
    this.upsertRun(entry);
    this.writeState();
  }

  /**
   * Terminal status + final summary. Idempotent; the first call wins. The
   * final event and the logs land BEFORE invocation.json turns terminal, so
   * a follower that stops on the terminal status has already seen them.
   */
  finish(
    status: Exclude<InvocationStatus, "running">,
    summary?: InvocationSummary,
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.tracker.stop();
    const endedAt = this.now().toISOString();
    this.appendEvent({
      ts: endedAt,
      type: "invocation.finished",
      invocationId: this.id,
      status,
    });
    this.closeLogs();
    this.state.status = status;
    this.state.endedAt = endedAt;
    if (summary) this.state.summary = summary;
    this.writeState();
  }

  /**
   * Signal path: mark the journal aborted synchronously (the process exits as
   * soon as the signal handler returns).
   */
  abortSync(signal: "SIGINT" | "SIGTERM"): void {
    if (this.settled) return;
    this.settled = true;
    this.tracker.stop();
    const endedAt = this.now().toISOString();
    this.appendEvent({
      ts: endedAt,
      type: "invocation.finished",
      invocationId: this.id,
      status: "aborted",
      signal,
    });
    this.closeLogs();
    this.state.status = "aborted";
    this.state.signal = signal;
    this.state.endedAt = endedAt;
    this.writeState();
  }

  private upsertRun(entry: InvocationJournalFile["runs"][number]): void {
    const at = this.state.runs.findIndex((run) => run.index === entry.index);
    if (at < 0) this.state.runs.push(entry);
    else this.state.runs[at] = entry;
    this.state.runs.sort((a, b) => a.index - b.index);
  }

  private closeLogs(): void {
    for (const log of this.logs.values()) log.close();
  }

  private writeState(): void {
    const target = join(this.dir, JOURNAL_FILE);
    const temporary = join(this.dir, `.${JOURNAL_FILE}.${process.pid}.tmp`);
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

/**
 * Redact CLI arguments: literal secrets/URI credentials via the redactor, and
 * the value of `key=value` pairs (`--var`, `--label`, `--matrix`, …) whose
 * key looks sensitive (`--var password=…` → `password=[redacted]`).
 */
export function redactArgv(
  argv: readonly string[],
  redactor: ArtifactRedactor = IDENTITY_REDACTOR,
): string[] {
  return argv.map((arg) => {
    const text = redactor.text(arg);
    if (arg.startsWith("-")) {
      const eq = text.indexOf("=");
      // --flag=key=value
      if (eq > 0) {
        const flag = text.slice(0, eq + 1);
        return `${flag}${redactPair(text.slice(eq + 1))}`;
      }
      return text;
    }
    return redactPair(text);
  });
}

function redactPair(text: string): string {
  const eq = text.indexOf("=");
  if (eq <= 0) return text;
  const key = text.slice(0, eq);
  if (/\s/.test(key)) return text;
  return isSensitiveEnvKey(key) ? `${key}=[redacted]` : text;
}

/**
 * Read one journal; undefined when missing or malformed. Lenient: fields this
 * build does not know (a journal from a newer cairn) are ignored, not fatal.
 */
export async function readInvocationJournal(
  dir: string,
): Promise<InvocationJournalFile | undefined> {
  try {
    const parsed = InvocationJournalReadSchema.safeParse(
      JSON.parse(await readFile(join(dir, JOURNAL_FILE), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The writer pid encoded in an invocation id (`<iso>_<pid>_<hex>`). */
export function invocationIdPid(id: string): number | undefined {
  if (!INVOCATION_ID_PATTERN.test(id)) return undefined;
  const pid = Number(id.split("_").at(-2));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Journal ids under the artifact root, oldest first. */
export async function listInvocationIds(
  artifactRoot: string,
): Promise<string[]> {
  const entries = await readdir(join(artifactRoot, INVOCATIONS_DIR), {
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter(
      (entry) => entry.isDirectory() && INVOCATION_ID_PATTERN.test(entry.name),
    )
    .map((entry) => entry.name)
    .toSorted();
}

/** Whether `pid` names a live process (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PruneInvocationsOptions {
  /** Newest journals always kept. Default {@link DEFAULT_KEEP_INVOCATIONS}. */
  keep?: number;
  pidAlive?: (pid: number) => boolean;
}

/**
 * Remove invocation journals that no longer reference any existing run
 * directory and are not among the newest `keep`. A journal whose process is
 * still running is never removed, and neither is an invocation.json this
 * build cannot read (it may come from a newer cairn). A directory without an
 * invocation.json whose writer is gone is an empty husk and goes. Returns the
 * removed ids, oldest first.
 */
export async function pruneInvocations(
  artifactRoot: string,
  opts: PruneInvocationsOptions = {},
): Promise<string[]> {
  const keep = Math.max(0, opts.keep ?? DEFAULT_KEEP_INVOCATIONS);
  const pidAlive = opts.pidAlive ?? isPidAlive;
  const ids = await listInvocationIds(artifactRoot);
  const removed: string[] = [];
  const cutoff = Math.max(0, ids.length - keep);
  for (const id of ids.slice(0, cutoff)) {
    const dir = join(artifactRoot, INVOCATIONS_DIR, id);
    const journal = await readInvocationJournal(dir);
    if (!journal) {
      const hasFile = await access(join(dir, JOURNAL_FILE)).then(
        () => true,
        () => false,
      );
      if (hasFile) continue;
      const pid = invocationIdPid(id);
      if (pid !== undefined && pidAlive(pid)) continue;
    } else {
      if (journal.status === "running" && pidAlive(journal.pid)) continue;
      if (await referencesExistingRun(artifactRoot, journal)) continue;
    }
    await rm(dir, { recursive: true, force: true });
    removed.push(id);
  }
  if (removed.length > 0) {
    keepOutOfRecencyOrder(join(artifactRoot, INVOCATIONS_DIR));
  }
  return removed;
}

async function referencesExistingRun(
  artifactRoot: string,
  journal: InvocationJournalFile,
): Promise<boolean> {
  for (const run of journal.runs) {
    for (const candidate of [run.runDir, join(artifactRoot, run.runId)]) {
      const entry = await stat(candidate).catch(() => undefined);
      if (entry?.isDirectory()) return true;
    }
  }
  return false;
}

/**
 * Tools that pick the "latest" run by directory mtime (`cairn logs latest`,
 * `cairn stats`, older Studio builds) list every directory under the artifact
 * root. Creating or pruning a journal touches `_invocations/`'s mtime, which
 * would make it look like the newest run. Pin its mtime to the epoch so it
 * always sorts last; journals inside are found by name, never by mtime.
 */
function keepOutOfRecencyOrder(invocationsRoot: string): void {
  try {
    utimesSync(invocationsRoot, new Date(0), new Date(0));
  } catch {
    // Best-effort; a failure only affects mtime-ordered listings.
  }
}
