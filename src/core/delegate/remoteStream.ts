import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readInvocationJournal } from "../artifacts/invocationJournal";
import type { InvocationJournalFile, RunEvent } from "../schema/events.v1";
import { FileLineTail } from "./stream";

/**
 * The producer half of the delegated-runner contract, run where the
 * invocation really runs: `cairn logs --invocation <ref> [--follow]
 * --relay` prints the delegate events stream of one invocation journal —
 * every line of its events.ndjson as written, plus `invocation.run.started`
 * / `invocation.run.finished` lines derived from invocation.json `runs[]`
 * and, once it settled, one `invocation.summary` line. A runner pipes that
 * output into CAIRN_DELEGATE_EVENTS unchanged; it never parses events.
 *
 * A derived line's `ts` never depends on when it was printed (the run id's
 * timestamp, run.json's `startedAt` / `endedAt`, the journal's start), so
 * a runner that reconnects and re-streams from the start prints the same
 * lines again; the relay drops the repeats.
 */
export class DelegateStreamProducer {
  private readonly events: FileLineTail;
  private readonly started = new Set<number>();
  private readonly finished = new Set<number>();
  private summarized = false;

  constructor(
    private readonly journalDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.events = new FileLineTail(join(journalDir, "events.ndjson"));
  }

  /**
   * The stream lines written since the last call. `final` (the invocation
   * settled, or a one-shot replay) also flushes a torn last line and adds
   * the summary.
   */
  async poll(final: boolean): Promise<string[]> {
    const journal = await readInvocationJournal(this.journalDir);
    // One batch, ordered by time: the journal's own lines keep their order,
    // and a derived run line sits where its run started / ended.
    const timed: Array<{ ts: string; line: string }> = [];
    let previous = "";
    for (const line of this.events.read(final)) {
      previous = lineTs(line) ?? previous;
      timed.push({ ts: previous, line });
    }
    if (journal) timed.push(...this.runLines(journal));
    const lines = timed
      .map((entry, order) => ({ ...entry, order }))
      .toSorted((a, b) =>
        a.ts === b.ts ? a.order - b.order : a.ts < b.ts ? -1 : 1,
      )
      .map((entry) => entry.line);
    if (
      final &&
      journal &&
      journal.status !== "running" &&
      journal.summary &&
      !this.summarized
    ) {
      this.summarized = true;
      lines.push(
        this.line({
          ts: journal.endedAt ?? this.now().toISOString(),
          type: "invocation.summary",
          invocationId: journal.invocationId,
          status: journal.status,
          summary: journal.summary,
        }),
      );
    }
    return lines;
  }

  private line(event: RunEvent): string {
    return JSON.stringify(event);
  }

  private runLines(
    journal: InvocationJournalFile,
  ): Array<{ ts: string; line: string }> {
    const out: Array<{ ts: string; line: string }> = [];
    const push = (event: RunEvent): void => {
      out.push({ ts: event.ts, line: this.line(event) });
    };
    for (const run of journal.runs) {
      const settled = run.synthetic ? undefined : readRunTimes(run.runDir);
      const startedTs =
        runIdTs(run.runId) ?? settled?.startedAt ?? journal.startedAt;
      if (!this.started.has(run.index)) {
        this.started.add(run.index);
        push({
          ts: startedTs,
          type: "invocation.run.started",
          index: run.index,
          spec: run.spec,
          runId: run.runId,
        });
      }
      const status = run.status;
      if (
        (status === "passed" || status === "failed" || status === "errored") &&
        !this.finished.has(run.index)
      ) {
        this.finished.add(run.index);
        push({
          ts: settled?.endedAt ?? startedTs,
          type: "invocation.run.finished",
          index: run.index,
          spec: run.spec,
          runId: run.runId,
          status,
          ...(run.synthetic ? { synthetic: true as const } : {}),
          ...(settled?.durationMs !== undefined
            ? { durationMs: settled.durationMs }
            : {}),
        });
      }
    }
    return out;
  }
}

/** The `ts` of one events.ndjson line (undefined when it has none). */
function lineTs(line: string): string | undefined {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    return typeof ts === "string" ? ts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The start a run id carries (`2026-10-03T10-00-00-000Z_<spec>_<hex>`), as
 * an ISO timestamp; undefined for an id that does not start with one.
 */
function runIdTs(runId: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(
    runId,
  );
  if (!match) return undefined;
  return iso(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

/** An ISO timestamp, normalized (undefined when it is not one). */
function iso(input: unknown): string | undefined {
  return typeof input === "string" && !Number.isNaN(Date.parse(input))
    ? new Date(input).toISOString()
    : undefined;
}

/** Start, end and duration of a run directory's run.json, when readable. */
function readRunTimes(
  runDir: string,
): { startedAt?: string; endedAt?: string; durationMs?: number } | undefined {
  let value: { startedAt?: unknown; endedAt?: unknown; durationMs?: unknown };
  try {
    value = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as {
      startedAt?: unknown;
    };
  } catch {
    return undefined;
  }
  const startedAt = iso(value.startedAt);
  const endedAt = iso(value.endedAt);
  return {
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(typeof value.durationMs === "number" &&
    Number.isInteger(value.durationMs) &&
    value.durationMs >= 0
      ? { durationMs: value.durationMs }
      : {}),
  };
}
