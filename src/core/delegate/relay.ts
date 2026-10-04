import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { z } from "zod";
import type { InvocationJournal } from "../artifacts/invocationJournal";
import { DELEGATE_LABEL } from "../schema/delegate.v1";
import {
  runEventSchemaOf,
  type DelegateDiagnosticCode,
  type InvocationPlannedRun,
  type InvocationStatus,
  type InvocationSummary,
  type RunEvent,
} from "../schema/events.v1";
import { RelativePathSchema, type ExitCode } from "../schema/shared";
import type { RunnerExit } from "./runnerProcess";
import { parseStreamLine, recoverTornLine } from "./stream";

/**
 * The relay half of the delegated-runner contract: each line of the
 * runner's events stream is validated against events.v1 and re-emitted
 * into the LOCAL invocation journal with `delegated: true`, the runs it
 * announces update invocation.json (`runs[]`, `current`) exactly as a local
 * run would, and anything wrong becomes a `delegate.diagnostic` — a bad
 * line never stops the relay. The remote `invocation.started` /
 * `invocation.finished` are recorded as `delegate.remote.*` (the local
 * journal settles only when this process does), remote heartbeats and
 * `log.opened` (paths on the remote machine) are dropped, and a remote
 * `phase.changed` moves the local phase tracker.
 *
 * Nothing the runner says is taken on its word: a run settles once (a
 * re-streamed line never downgrades it), a remote run of a spec the local
 * policy refused is an error, `delegate.*` lines other than
 * `delegate.progress` (cairn's own namespace) and paths that leave their
 * directory are refused, and after the runner exited {@link
 * DelegateRelay.verify} checks every copied run.json (this run, this
 * invocation's `cairn.delegate` label, not a directory that was there
 * before the runner started, the stream's status) and that every planned
 * run was settled.
 */

export interface DelegateDiagnostic {
  level: "warn" | "error";
  code: DelegateDiagnosticCode;
  message: string;
  line?: number;
  runId?: string;
}

type TerminalStatus = "passed" | "failed" | "errored";

export interface RelayedRun {
  /** 1-based position in the plan (past its end when outside it). */
  index: number;
  /** The local plan's spec at that index (the remote path when they differ). */
  spec: string;
  /** The spec path the remote side reported. */
  remoteSpec: string;
  runId: string;
  /** `<artifactRootLocal>/<runId>`. */
  runDir: string;
  /**
   * The run's status: its run.json's once {@link DelegateRelay.verify}
   * vouched for it, else what the stream said.
   */
  status?: TerminalStatus;
  /** What the stream's `invocation.run.finished` said. */
  streamStatus?: TerminalStatus;
  synthetic?: true;
  durationMs?: number;
  /** Its run.json is this invocation's (run id, `cairn.delegate` label, fresh). */
  verified?: true;
  /** A remote run the local plan has no place for (`plan-mismatch`). */
  outsidePlan?: true;
}

/** What {@link DelegateRelay.verify} found once the runner exited. */
export interface DelegateVerification {
  /** Finished runs without a run.json (or an unreadable one, or another run's). */
  missing: RelayedRun[];
  /** Runs that started, never finished, and left no run.json. */
  unfinished: RelayedRun[];
  /** Run directories that are not this invocation's (`foreign-run`, `stale-run`). */
  foreign: RelayedRun[];
  /** Planned runs nothing settled (and the remote side does not account for). */
  unsettled: InvocationPlannedRun[];
}

export interface DelegateRelayOptions {
  journal: InvocationJournal;
  /** The local artifact root the runner places run directories under. */
  artifactRoot: string;
  /** The local plan (refused entries included; see `refusedIndexes`). */
  planned: readonly InvocationPlannedRun[];
  /** The config directory: remote spec paths match local ones relative to it. */
  configDir?: string;
  /**
   * The local invocation id: every copied run.json must carry
   * `labels["cairn.delegate"]` = it (the remote `cairn` adds it from
   * `cairnArgs`). Unset, the label is not checked.
   */
  invocationId?: string;
  /** Planned indexes the local environment policy refused: never run remotely. */
  refusedIndexes?: ReadonlySet<number>;
  /**
   * Names under the artifact root before the runner started: a relayed run
   * naming one is stale (`stale-run`), whatever its run.json says.
   */
  preexisting?: ReadonlySet<string>;
  onRunStarted?: (run: RelayedRun) => void;
  onRunFinished?: (run: RelayedRun) => void;
  onProgress?: (message: string) => void;
  /** Narration of a diagnostic (rate-limited: see `maxDiagnosticNotes`). */
  onDiagnostic?: (diagnostic: DelegateDiagnostic) => void;
  /** `delegate.diagnostic` events written at most (the rest are counted). */
  maxDiagnosticEvents?: number;
  /** `onDiagnostic` calls at most, then one `suppressed` call (the rest are counted). */
  maxDiagnosticNotes?: number;
  /** Distinct lines remembered to drop exact repeats (the oldest forgotten first). */
  maxSeenLines?: number;
  now?: () => Date;
}

/** A run id that names exactly one directory under the artifact root. */
export function isSafeRunId(runId: string): boolean {
  return (
    runId.length <= 255 &&
    runId !== "." &&
    runId !== ".." &&
    !runId.startsWith("_") &&
    !runId.startsWith(".") &&
    !runId.includes("/") &&
    !runId.includes("\\") &&
    !runId.includes("\u0000")
  );
}

/**
 * A path an event declares relative to its run or journal directory that
 * is absolute or climbs out of it (`..`): on this machine it would name a
 * file outside the local copy.
 */
export function isUnsafeRelativePath(path: string): boolean {
  if (path.includes("\u0000")) return true;
  if (path.startsWith("/") || path.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  return path.split(/[\\/]+/).includes("..");
}

/** Every value its schema declares a {@link RelativePathSchema}, into `out`. */
function relativePathsOf(
  schema: z.ZodTypeAny,
  value: unknown,
  out: string[],
): void {
  if (value === undefined || value === null) return;
  if (schema === RelativePathSchema) {
    if (typeof value === "string") out.push(value);
    return;
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    relativePathsOf(schema.unwrap() as z.ZodTypeAny, value, out);
    return;
  }
  if (schema instanceof z.ZodObject && typeof value === "object") {
    for (const [key, child] of Object.entries(
      schema.shape as Record<string, z.ZodTypeAny>,
    )) {
      relativePathsOf(child, (value as Record<string, unknown>)[key], out);
    }
    return;
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    for (const item of value) {
      relativePathsOf(schema.element as z.ZodTypeAny, item, out);
    }
    return;
  }
  if (schema instanceof z.ZodRecord && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      relativePathsOf(schema.valueSchema as z.ZodTypeAny, item, out);
    }
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const TERMINAL = new Set<string>(["passed", "failed", "errored"]);

function isTerminal(status: unknown): status is TerminalStatus {
  return typeof status === "string" && TERMINAL.has(status);
}

/** Exact-repeat memory: insertion-ordered, the oldest forgotten past `max`. */
class BoundedSet {
  private readonly items = new Set<string>();
  constructor(private readonly max: number) {}

  /** True when `key` was new (and is now remembered). */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    if (this.items.size > this.max) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    return true;
  }
}

export class DelegateRelay {
  /** Lines read from the stream. */
  lines = 0;
  /** Events re-emitted into the journal (mapped ones included). */
  relayed = 0;
  /** Heartbeats and `log.opened` lines (meaningful only on the remote machine). */
  dropped = 0;
  /** Repeats: an exact repeat of a line, or a run line for a run already at that state. */
  duplicates = 0;
  /** The remote invocation the stream named (the latest `invocation.started`). */
  remoteInvocationId: string | undefined;
  /** Its `invocation.finished` status (else its summary's); that invocation only. */
  remoteStatus: InvocationStatus | undefined;
  /** Its `invocation.summary`; that invocation only. */
  remoteSummary: InvocationSummary | undefined;
  /** Remote `run.refused` lines (specs the remote side's policy refused). */
  remoteRefusals = 0;
  readonly diagnostics: DelegateDiagnostic[] = [];
  private readonly runs = new Map<string, RelayedRun>();
  /** Remote runs of a spec the local policy refused (diagnosed once each). */
  private readonly refusedRuns = new Set<string>();
  private readonly seen: BoundedSet;
  private suppressed = false;
  private notes = 0;
  private verified: DelegateVerification | undefined;
  private readonly maxDiagnosticEvents: number;
  private readonly maxDiagnosticNotes: number;
  private readonly now: () => Date;

  constructor(private readonly opts: DelegateRelayOptions) {
    this.maxDiagnosticEvents = opts.maxDiagnosticEvents ?? 100;
    this.maxDiagnosticNotes = opts.maxDiagnosticNotes ?? 20;
    this.seen = new BoundedSet(opts.maxSeenLines ?? 50_000);
    this.now = opts.now ?? (() => new Date());
  }

  get errorCount(): number {
    return this.diagnostics.filter((d) => d.level === "error").length;
  }

  /** Every run the stream named, in plan order. */
  runList(): RelayedRun[] {
    return [...this.runs.values()].toSorted((a, b) => a.index - b.index);
  }

  /** A local spec path and a remote one name the same spec file. */
  private sameSpec(local: string, remote: string): boolean {
    const remotePath = remote.replaceAll("\\", "/");
    if (remotePath === local) return true;
    const rel = this.opts.configDir
      ? relative(this.opts.configDir, local).split(sep).join("/")
      : basename(local);
    return remotePath === rel || remotePath.endsWith(`/${rel}`);
  }

  /**
   * Record a diagnostic: always counted, journaled up to
   * `maxDiagnosticEvents`, narrated up to `maxDiagnosticNotes`.
   */
  diagnose(diagnostic: DelegateDiagnostic): void {
    this.diagnostics.push(diagnostic);
    if (this.notes < this.maxDiagnosticNotes) {
      this.opts.onDiagnostic?.(diagnostic);
    } else if (this.notes === this.maxDiagnosticNotes) {
      this.opts.onDiagnostic?.({
        level: "warn",
        code: "suppressed",
        message: `more than ${this.maxDiagnosticNotes} runner diagnostics: the rest are only counted (delegate.diagnostic in the invocation journal)`,
      });
    }
    this.notes += 1;
    if (this.diagnostics.length <= this.maxDiagnosticEvents) {
      this.opts.journal.appendEvent({
        ts: this.now().toISOString(),
        type: "delegate.diagnostic",
        level: diagnostic.level,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
        ...(diagnostic.runId ? { runId: diagnostic.runId } : {}),
      });
    } else if (!this.suppressed) {
      this.suppressed = true;
      this.opts.journal.appendEvent({
        ts: this.now().toISOString(),
        type: "delegate.diagnostic",
        level: "warn",
        code: "suppressed",
        message: `more than ${this.maxDiagnosticEvents} diagnostics: the rest are counted, not recorded`,
      });
    }
  }

  /** One raw line of the events stream. Never throws. */
  consume(line: string): void {
    this.lines += 1;
    const lineNo = this.lines;
    let text = line;
    let parsed = parseStreamLine(text);
    if (parsed.kind === "invalid" && parsed.code === "malformed-line") {
      // A runner that reconnected mid-line and re-streamed from the start:
      // the torn head is lost (the re-stream repeats it), the event glued
      // after it is whole.
      const tail = recoverTornLine(text);
      if (tail !== undefined) {
        this.diagnose({
          level: "warn",
          code: "malformed-line",
          message: `a torn line (${line.length - tail.length} character(s) of a cut-off line, then a whole event — a runner that reconnected mid-line?): the event was relayed, the torn head dropped`,
          line: lineNo,
        });
        text = tail;
        parsed = parseStreamLine(text);
      }
    }
    if (parsed.kind === "invalid") {
      this.diagnose({
        level: parsed.level,
        code: parsed.code,
        message: parsed.message,
        line: lineNo,
      });
      return;
    }
    const { event } = parsed;
    if (event.type === "run.heartbeat" || event.type === "log.opened") {
      this.dropped += 1;
      return;
    }
    if (
      event.type.startsWith("delegate.") &&
      event.type !== "delegate.progress"
    ) {
      this.diagnose({
        level: "error",
        code: "invalid-event",
        message: `${event.type} is cairn's own record of the runner; a runner may write only delegate.progress in that namespace. Not relayed`,
        line: lineNo,
      });
      return;
    }
    const unsafe = this.unsafePath(event);
    if (unsafe !== undefined) {
      this.diagnose({
        level: "error",
        code: "invalid-event",
        message: `${event.type} names a path outside its directory (${JSON.stringify(unsafe.slice(0, 120))}: absolute or with ".."); not relayed`,
        line: lineNo,
      });
      return;
    }
    // Run lines repeat by state (a re-stream may derive them again with
    // other fields), everything else by the exact line.
    if (
      event.type !== "invocation.run.started" &&
      event.type !== "invocation.run.finished" &&
      !this.seen.add(createHash("sha1").update(text.trim()).digest("hex"))
    ) {
      this.duplicates += 1;
      return;
    }
    try {
      this.handle(event, lineNo);
    } catch (error) {
      this.diagnose({
        level: "error",
        code: "invalid-event",
        message: `${event.type} could not be relayed: ${(error as Error).message}`,
        line: lineNo,
      });
    }
  }

  /** The first declared-relative path of `event` that leaves its directory. */
  private unsafePath(event: RunEvent): string | undefined {
    const schema = runEventSchemaOf(event.type);
    if (!schema) return undefined;
    const paths: string[] = [];
    relativePathsOf(schema, event, paths);
    return paths.find(isUnsafeRelativePath);
  }

  private relay(event: RunEvent): void {
    this.opts.journal.appendEvent({ ...event, delegated: true } as RunEvent);
    this.relayed += 1;
  }

  private handle(event: RunEvent, line: number): void {
    const { journal } = this.opts;
    switch (event.type) {
      case "invocation.started": {
        if (
          this.remoteInvocationId !== undefined &&
          this.remoteInvocationId !== event.invocationId
        ) {
          this.diagnose({
            level: "warn",
            code: "unknown-run",
            message: `a second remote invocation ${event.invocationId} (after ${this.remoteInvocationId}); its runs are relayed too, and only its own finish and summary count`,
            line,
          });
          this.remoteStatus = undefined;
          this.remoteSummary = undefined;
        }
        this.remoteInvocationId = event.invocationId;
        journal.appendEvent({
          ts: event.ts,
          type: "delegate.remote.started",
          remoteInvocationId: event.invocationId,
          planned: event.planned,
        });
        this.relayed += 1;
        journal.setDelegate({ remoteInvocationId: event.invocationId });
        return;
      }
      case "invocation.finished": {
        this.remoteInvocationId ??= event.invocationId;
        const own = this.remoteInvocationId === event.invocationId;
        if (own) {
          this.remoteStatus = event.status;
        } else {
          this.diagnose({
            level: "warn",
            code: "unknown-run",
            message: `invocation.finished of ${event.invocationId}, not of the remote invocation the stream named (${this.remoteInvocationId}); its status does not count`,
            line,
          });
        }
        journal.appendEvent({
          ts: event.ts,
          type: "delegate.remote.finished",
          remoteInvocationId: event.invocationId,
          status: event.status,
          ...(event.signal ? { signal: event.signal } : {}),
        });
        this.relayed += 1;
        if (own) {
          journal.setDelegate({
            remoteInvocationId: event.invocationId,
            remoteStatus: event.status,
          });
        }
        return;
      }
      case "phase.changed": {
        void journal.tracker.enter(event.phase, {
          ...(event.item !== undefined ? { item: event.item } : {}),
          ...(event.budgetMs !== undefined ? { budgetMs: event.budgetMs } : {}),
        });
        this.relayed += 1;
        return;
      }
      case "invocation.summary": {
        this.remoteInvocationId ??= event.invocationId;
        if (this.remoteInvocationId === event.invocationId) {
          this.remoteSummary = event.summary;
          this.remoteStatus ??= event.status;
        } else {
          this.diagnose({
            level: "warn",
            code: "unknown-run",
            message: `invocation.summary of ${event.invocationId}, not of the remote invocation the stream named (${this.remoteInvocationId}); it does not count`,
            line,
          });
        }
        this.relay(event);
        return;
      }
      case "run.refused": {
        this.remoteRefusals += 1;
        this.relay(event);
        return;
      }
      case "delegate.progress": {
        this.relay(event);
        this.opts.onProgress?.(event.message);
        if (event.phase) {
          void journal.tracker.enter(event.phase, { item: event.message });
        }
        return;
      }
      case "invocation.run.started": {
        if (this.runs.has(event.runId) || this.refusedRuns.has(event.runId)) {
          // Already known (a re-stream): its state never goes back.
          this.duplicates += 1;
          return;
        }
        const run = this.trackRun(event, line);
        if (!run) return;
        journal.runStarted(run.index, run.spec, run.runId, run.runDir);
        this.relay(event);
        this.opts.onRunStarted?.(run);
        return;
      }
      case "invocation.run.finished": {
        this.runFinished(event, line);
        return;
      }
      default:
        this.relay(event);
    }
  }

  private runFinished(
    event: Extract<RunEvent, { type: "invocation.run.finished" }>,
    line: number,
  ): void {
    if (this.refusedRuns.has(event.runId)) {
      this.duplicates += 1;
      return;
    }
    const known = this.runs.get(event.runId);
    if (known?.streamStatus !== undefined) {
      const status =
        event.synthetic && event.status === "passed" ? "errored" : event.status;
      if (known.streamStatus === status) {
        this.duplicates += 1;
        return;
      }
      // A settled run never changes its mind: the first report stands.
      this.diagnose({
        level: "error",
        code: "status-mismatch",
        message: `run ${event.runId} was reported ${known.streamStatus}, then ${event.status}; the first report stands`,
        line,
        runId: event.runId,
      });
      return;
    }
    const run = known ?? this.trackRun(event, line);
    if (!run) return;
    if (!known) {
      this.diagnose({
        level: "warn",
        code: "unknown-run",
        message: `run ${event.runId} finished without an invocation.run.started line`,
        line,
        runId: event.runId,
      });
    }
    let status: TerminalStatus = event.status;
    if (event.synthetic) {
      run.synthetic = true;
      if (status === "passed") {
        // A pass needs a run directory: a synthetic one proves nothing.
        status = "errored";
        this.diagnose({
          level: "error",
          code: "synthetic-pass",
          message: `run ${event.runId} was reported passed with synthetic: true (no run directory): a pass needs one; recorded errored`,
          line,
          runId: event.runId,
        });
      }
    }
    run.streamStatus = status;
    run.status = status;
    if (event.durationMs !== undefined) run.durationMs = event.durationMs;
    this.journalFinished(run);
    this.relay(event);
    this.opts.onRunFinished?.(run);
  }

  /**
   * The run an `invocation.run.*` line names, created on first sight
   * (undefined: an unsafe run id, or a run of a spec the local policy
   * refused — neither is relayed).
   */
  private trackRun(
    event: { index: number; spec: string; runId: string },
    line: number,
  ): RelayedRun | undefined {
    if (!isSafeRunId(event.runId)) {
      this.diagnose({
        level: "error",
        code: "invalid-event",
        message: `run id ${JSON.stringify(event.runId.slice(0, 80))} does not name a directory under the artifact root; not relayed`,
        line,
      });
      return undefined;
    }
    const refused = this.opts.refusedIndexes ?? new Set<number>();
    // The remote index, when the local plan has the same spec there; else
    // the first free planned entry of that spec (a spec the local policy
    // refused shifts the remote plan); else a run outside the plan.
    const taken = new Set([...this.runs.values()].map((run) => run.index));
    const free = (index: number): boolean =>
      !taken.has(index) && !refused.has(index);
    const local =
      this.opts.planned.find(
        (p) =>
          p.index === event.index &&
          free(p.index) &&
          this.sameSpec(p.spec, event.spec),
      ) ??
      this.opts.planned.find(
        (p) => free(p.index) && this.sameSpec(p.spec, event.spec),
      );
    if (
      !local &&
      this.opts.planned.some(
        (p) => refused.has(p.index) && this.sameSpec(p.spec, event.spec),
      )
    ) {
      this.refusedRuns.add(event.runId);
      this.diagnose({
        level: "error",
        code: "refused-run",
        message: `remote run ${event.runId} is of ${basename(event.spec)}, which the local environment policy refused: it must not run anywhere for this invocation (not relayed)`,
        line,
        runId: event.runId,
      });
      return undefined;
    }
    let index = event.index;
    let spec = event.spec;
    if (local) {
      index = local.index;
      spec = local.spec;
    } else {
      this.diagnose({
        level: "warn",
        code: "plan-mismatch",
        message: `remote run ${event.index} (${basename(event.spec)}) matches no spec of the local plan of ${this.opts.planned.length} run(s)`,
        line,
        runId: event.runId,
      });
      const highest = Math.max(this.opts.planned.length, ...taken, 0);
      if (!free(index) || this.opts.planned.some((p) => p.index === index)) {
        index = highest + 1;
      }
    }
    const run: RelayedRun = {
      index,
      spec,
      remoteSpec: event.spec,
      runId: event.runId,
      runDir: join(this.opts.artifactRoot, event.runId),
      ...(local ? {} : { outsidePlan: true as const }),
    };
    this.runs.set(event.runId, run);
    return run;
  }

  /**
   * After the runner exited. Every run the stream named is checked against
   * its `<artifactRoot>/<runId>/run.json`: none, or another run's
   * (`missing-run-dir`), a directory that was there before the runner
   * started (`stale-run`), a run.json without this invocation's
   * `cairn.delegate` label (`foreign-run`) — none of them counts as evidence, and the run is recorded errored —
   * and a run.json whose status is not the stream's (`status-mismatch`;
   * run.json's stands). A run that never finished settles from its own
   * run.json, else errored (`unfinished-run`). With `coverage` (the runner
   * claimed a result: exit 0 or 1), every planned run must be settled or
   * accounted for by the remote side's refused / skipped runs
   * (`missing-run`). Idempotent: the first call decides.
   */
  verify(options: { coverage?: boolean } = {}): DelegateVerification {
    if (this.verified) return this.verified;
    const missing: RelayedRun[] = [];
    const unfinished: RelayedRun[] = [];
    const foreign: RelayedRun[] = [];
    for (const run of this.runList()) {
      if (run.synthetic) continue;
      const runJson = this.ownRunJson(run, foreign);
      if (runJson === "foreign") {
        this.noEvidence(run);
        continue;
      }
      if (!run.status) {
        const status = isTerminal(runJson?.status) ? runJson.status : undefined;
        run.status = status ?? "errored";
        if (status) run.verified = true;
        this.journalFinished(run);
        if (status) {
          this.diagnose({
            level: "warn",
            code: "unfinished-run",
            message: `run ${run.runId} has no invocation.run.finished line; its status (${status}) comes from run.json`,
            runId: run.runId,
          });
        } else {
          unfinished.push(run);
          this.diagnose({
            level: "error",
            code: "unfinished-run",
            message: `run ${run.runId} started and never finished (no invocation.run.finished line and no run.json under ${run.runDir})`,
            runId: run.runId,
          });
        }
        continue;
      }
      if (!runJson) {
        missing.push(run);
        this.diagnose({
          level: "error",
          code: "missing-run-dir",
          message: `the runner reported run ${run.runId} ${run.status}, but ${join(run.runDir, "run.json")} does not exist (or is not JSON): copy every run directory under the local artifact root`,
          runId: run.runId,
        });
        this.noEvidence(run);
        continue;
      }
      if (typeof runJson.runId === "string" && runJson.runId !== run.runId) {
        missing.push(run);
        this.diagnose({
          level: "error",
          code: "missing-run-dir",
          message: `${join(run.runDir, "run.json")} belongs to run ${runJson.runId}, not ${run.runId}`,
          runId: run.runId,
        });
        this.noEvidence(run);
        continue;
      }
      run.verified = true;
      const recorded = runJson.status;
      if (recorded !== run.streamStatus) {
        const status: TerminalStatus = isTerminal(recorded)
          ? recorded
          : "errored";
        this.diagnose({
          level: "error",
          code: "status-mismatch",
          message: `the stream reported run ${run.runId} ${run.streamStatus}, but its run.json says ${JSON.stringify(recorded)}: ${status} stands`,
          runId: run.runId,
        });
        run.status = status;
        this.journalFinished(run);
      }
      if (!existsSync(join(run.runDir, "artifact-manifest.json"))) {
        this.diagnose({
          level: "warn",
          code: "incomplete-run-dir",
          message: `${run.runDir} has no artifact-manifest.json (copy run.json and artifact-manifest.json last)`,
          runId: run.runId,
        });
      }
    }
    const unsettled = options.coverage ? this.unsettledPlanned() : [];
    this.verified = { missing, unfinished, foreign, unsettled };
    return this.verified;
  }

  /**
   * The run's run.json when it is this invocation's; `"foreign"` (pushed
   * to `foreign`, diagnosed) when the directory is stale or labelled for
   * another invocation; undefined when there is none.
   */
  private ownRunJson(
    run: RelayedRun,
    foreign: RelayedRun[],
  ): Record<string, unknown> | "foreign" | undefined {
    const runJson = readJsonObject(join(run.runDir, "run.json"));
    if (!runJson) return undefined;
    if (this.opts.preexisting?.has(run.runId)) {
      foreign.push(run);
      this.diagnose({
        level: "error",
        code: "stale-run",
        message: `${run.runDir} was under the local artifact root before the runner started: an earlier run, not evidence of this invocation`,
        runId: run.runId,
      });
      return "foreign";
    }
    const expected = this.opts.invocationId;
    if (expected !== undefined) {
      const labels = runJson.labels;
      const label =
        labels !== null && typeof labels === "object"
          ? (labels as Record<string, unknown>)[DELEGATE_LABEL]
          : undefined;
      if (label !== expected) {
        foreign.push(run);
        this.diagnose({
          level: "error",
          code: "foreign-run",
          message: `${join(run.runDir, "run.json")} is labelled ${DELEGATE_LABEL}=${
            typeof label === "string" ? label : "(none)"
          }, not this invocation's ${expected}: run the remote cairn with the request's cairnArgs (they carry the label)`,
          runId: run.runId,
        });
        return "foreign";
      }
    }
    return runJson;
  }

  /**
   * A run whose run directory is missing or not this invocation's: whatever
   * the stream said, it is recorded errored (its document is a stand-in).
   */
  private noEvidence(run: RelayedRun): void {
    if (run.status === "errored") return;
    run.status = "errored";
    this.journalFinished(run);
  }

  private journalFinished(run: RelayedRun): void {
    this.opts.journal.runFinished({
      index: run.index,
      spec: run.spec,
      runId: run.runId,
      runDir: run.runDir,
      status: run.status ?? "errored",
      ...(run.synthetic ? { synthetic: true as const } : {}),
    });
  }

  /**
   * Planned (not refused) runs no relayed run settled, beyond what the
   * remote side refused or skipped (its summary for the invocation the
   * stream named, else its relayed `run.refused` lines). One `missing-run`
   * diagnostic when there are any.
   */
  private unsettledPlanned(): InvocationPlannedRun[] {
    const refused = this.opts.refusedIndexes ?? new Set<number>();
    const settled = new Set(
      this.runList()
        .filter((run) => run.status !== undefined && !run.outsidePlan)
        .map((run) => run.index),
    );
    const expected = this.opts.planned.filter(
      (entry) => !refused.has(entry.index),
    );
    const open = expected.filter((entry) => !settled.has(entry.index));
    const summary = this.remoteSummary;
    const accounted = summary
      ? (summary.refused ?? 0) + (summary.skipped ?? 0)
      : this.remoteRefusals;
    if (open.length <= accounted) return [];
    const shown = open
      .slice(0, 5)
      .map((entry) => `[${entry.index}] ${basename(entry.spec)}`)
      .join(", ");
    this.diagnose({
      level: "error",
      code: "missing-run",
      message: `${open.length} of ${expected.length} planned run(s) were never settled by the stream (no invocation.run.finished, no run.json)${
        accounted > 0
          ? `; the remote side accounts for ${accounted} as refused or skipped`
          : ""
      }: ${shown}${open.length > 5 ? ", …" : ""}`,
    });
    return open.slice(accounted);
  }
}

/* ----- the verdict ----- */

/** A delegated invocation's exit code: a stable code, or a signal's. */
export type DelegatedExitCode = ExitCode | 130 | 143;

const VALID_EXIT_CODES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 130, 143]);

export interface DelegateVerdictInput {
  exit: RunnerExit;
  /** A local cancel was requested (MCP cancel); a signal never gets here. */
  cancelled: boolean;
  timedOut: boolean;
  /** Cancelled after `runner.idleTimeoutMs` without a stream line. */
  idle?: boolean;
  /** Every run the stream named, after {@link DelegateRelay.verify}. */
  runs: readonly RelayedRun[];
  /** Runs the local plan expected the remote side to settle (refused ones excluded). */
  planned: number;
  /** What {@link DelegateRelay.verify} found (counts). */
  verification?: {
    missing: number;
    unfinished: number;
    foreign?: number;
    unsettled?: number;
  };
  /** The relay's diagnostics (error-level ones count against the evidence). */
  diagnostics?: readonly DelegateDiagnostic[];
  /**
   * The remote invocation's own verdict, when the stream gave it for the
   * invocation it named: its `invocation.finished` status and summary.
   */
  remote?: { status?: InvocationStatus; summary?: InvocationSummary };
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface DelegateVerdict {
  exitCode: DelegatedExitCode;
  status: "passed" | "failed" | "errored" | "aborted";
  /** What the relayed runs alone add up to (failed 1 > errored 2 > 0). */
  specsExitCode: ExitCode;
  /** Diagnostics the verdict adds (why the code is not the runner's). */
  diagnostics: DelegateDiagnostic[];
  /** Messages for the summary / invocationOutcome `error`. */
  errors: string[];
}

function statusOf(code: DelegatedExitCode): DelegateVerdict["status"] {
  if (code === 0) return "passed";
  if (code === 1 || code === 7) return "failed";
  if (code === 130 || code === 143) return "aborted";
  return "errored";
}

/** Diagnostics that say a run report contradicts the evidence. */
const CONTRADICTION_CODES: readonly DelegateDiagnosticCode[] = [
  "status-mismatch",
  "synthetic-pass",
  "refused-run",
];
/** Error diagnostics that say the stream itself was corrupt. */
const STREAM_CODES: readonly DelegateDiagnosticCode[] = [
  "malformed-line",
  "invalid-event",
  "line-too-long",
];

/** The code the remote invocation's own verdict stands for (0: it passed). */
function remoteCode(remote: DelegateVerdictInput["remote"]): number {
  const summaryCode = remote?.summary?.exitCode;
  if (summaryCode !== undefined && summaryCode !== 0) {
    return summaryCode >= 1 && summaryCode <= 9 ? summaryCode : 2;
  }
  const status = remote?.status;
  if (status === undefined || status === "passed") return 0;
  return status === "failed" ? 1 : 2;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The exit code of a delegated invocation. The runner's code is a claim:
 * a 0 stands only when every planned run was settled by a run directory of
 * this invocation whose run.json agrees with the stream, the remote
 * invocation's own verdict (same invocation) passed, every relayed run
 * passed and the stream was clean; a 1 only when a relayed run (or the
 * remote verdict) failed. Otherwise the code is raised to what the
 * evidence shows — 2 when the evidence is missing or contradicts itself
 * (an infrastructure failure is never a red test) — with an
 * `exit-mismatch` diagnostic saying why. A local cancel is 130; a runner
 * that could not start, timed out, went idle, died of a foreign signal or
 * exited with a code cairn does not use is 2; 2–9 / 130 / 143 from the
 * runner are never lowered.
 */
export function delegateVerdict(input: DelegateVerdictInput): DelegateVerdict {
  const finished = input.runs.filter((run) => run.status !== undefined);
  const specsExitCode: ExitCode = finished.some((r) => r.status === "failed")
    ? 1
    : finished.some((r) => r.status === "errored")
      ? 2
      : 0;
  const diagnostics: DelegateDiagnostic[] = [];
  const errors: string[] = [];
  const done = (code: DelegatedExitCode): DelegateVerdict => ({
    exitCode: code,
    status: statusOf(code),
    specsExitCode,
    diagnostics,
    errors,
  });
  if (input.exit.spawnError !== undefined) {
    const message = `the runner could not be started: ${input.exit.spawnError}`;
    diagnostics.push({ level: "error", code: "spawn-failed", message });
    errors.push(message);
    return done(2);
  }
  if (input.timedOut) {
    errors.push(
      `the runner outlived runner.timeoutMs (${input.timeoutMs ?? "?"}ms) and was cancelled`,
    );
    return done(2);
  }
  if (input.idle) {
    errors.push(
      `the runner's events stream stayed silent for runner.idleTimeoutMs (${input.idleTimeoutMs ?? "?"}ms) and it was cancelled`,
    );
    return done(2);
  }
  if (input.cancelled) {
    errors.push("the invocation was cancelled; the runner got SIGINT");
    return done(130);
  }
  if (input.exit.exitCode === undefined) {
    const message = `the runner was ended by ${input.exit.signal ?? "a signal"}, which cairn did not send`;
    diagnostics.push({ level: "error", code: "runner-signal", message });
    errors.push(message);
    return done(2);
  }
  const code = input.exit.exitCode;
  if (!VALID_EXIT_CODES.has(code)) {
    const message = `the runner exited ${code}, which is not a cairn exit code (0-9, 130, 143)`;
    diagnostics.push({ level: "error", code: "invalid-exit-code", message });
    errors.push(message);
    return done(2);
  }
  if (code !== 0 && code !== 1) return done(code as DelegatedExitCode);

  const counts = new Map<DelegateDiagnosticCode, number>();
  for (const diagnostic of input.diagnostics ?? []) {
    if (diagnostic.level !== "error") continue;
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  const sum = (codes: readonly DelegateDiagnosticCode[]): number =>
    codes.reduce((total, c) => total + (counts.get(c) ?? 0), 0);
  // Evidence that is wrong: never a pass, never a red test.
  const wrong: string[] = [];
  const verification = input.verification ?? { missing: 0, unfinished: 0 };
  if (verification.missing > 0) {
    wrong.push(
      `${counted(verification.missing, "finished run has", "finished runs have")} no run directory under the local artifact root`,
    );
  }
  if (verification.unfinished > 0) {
    wrong.push(
      `${counted(verification.unfinished, "run", "runs")} started and never finished`,
    );
  }
  const foreign = verification.foreign ?? 0;
  if (foreign > 0) {
    wrong.push(
      `${counted(foreign, "run directory is", "run directories are")} not this invocation's (foreign-run / stale-run)`,
    );
  }
  const contradictions = sum(CONTRADICTION_CODES);
  if (contradictions > 0) {
    wrong.push(
      `${counted(contradictions, "run report contradicts", "run reports contradict")} the evidence (${CONTRADICTION_CODES.filter(
        (c) => counts.has(c),
      ).join(", ")})`,
    );
  }
  // Evidence that is incomplete: no pass (a failure that stopped the rest,
  // `--bail`, still stands).
  const unsettled = verification.unsettled ?? 0;
  const incomplete =
    unsettled > 0
      ? `${counted(unsettled, "planned run was", "planned runs were")} never settled`
      : finished.length === 0 && input.planned > 0
        ? `none of the ${input.planned} planned run(s) was relayed`
        : undefined;
  const corrupt = sum(STREAM_CODES);
  const remote = remoteCode(input.remote);

  let exitCode: DelegatedExitCode = code;
  let why: string | undefined;
  if (wrong.length > 0) {
    exitCode = 2;
    why = wrong.join("; ");
  } else if (code === 0) {
    if (incomplete !== undefined) {
      exitCode = 2;
      why = incomplete;
    } else if (remote !== 0) {
      exitCode = remote as DelegatedExitCode;
      why = `the remote invocation ${input.remote?.status ?? "settled"}${
        input.remote?.summary
          ? ` (its summary says exit ${input.remote.summary.exitCode})`
          : ""
      }`;
    } else if (specsExitCode !== 0) {
      exitCode = specsExitCode;
      why = `its relayed runs did not all pass (exit ${specsExitCode})`;
    } else if (corrupt > 0) {
      exitCode = 2;
      why = `${counted(corrupt, "line", "lines")} of its events stream ${
        corrupt === 1 ? "is" : "are"
      } not a valid events.v1 event (malformed-line / invalid-event / line-too-long)`;
    }
  } else if (specsExitCode !== 1 && remote !== 1) {
    exitCode = 2;
    why =
      finished.length === 0
        ? `none of the ${input.planned} planned run(s) settled, so nothing failed: an infrastructure failure, not a red test`
        : "no relayed run failed and the remote invocation reported no failure: an infrastructure failure, not a red test";
  }
  if (why !== undefined) {
    const message = `the runner exited ${code}, but ${why}`;
    diagnostics.push({ level: "error", code: "exit-mismatch", message });
    errors.push(message);
  }
  return done(exitCode);
}
