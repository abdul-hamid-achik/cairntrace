import { createInterface } from "node:readline";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import {
  killOrphans,
  pruneStale,
  scanOrphans,
  type OrphanSession,
} from "../../core/runPolicy/orphans";
import type { ProcessProbe } from "../../core/runPolicy/processProbe";
import {
  OrphansResultSchema,
  type OrphansResult,
} from "../../core/schema/orphans.v1";

/**
 * `cairn doctor --orphans [--kill] [--yes] [--json]`: list the browser
 * sessions cairn started whose invocation is gone and whose processes
 * survive. With `--kill`, end them — after a confirmation on a terminal, or
 * with `--yes`; a structured (`--json` / `--yaml`) or non-interactive run
 * never prompts and refuses `--kill` without `--yes` (exit 2). Only
 * processes a ledger entry names are ever signalled, and only while they
 * still look like a browser.
 */

export interface OrphansOptions {
  kill?: boolean;
  yes?: boolean;
  /** Structured output: never prompt. */
  structured?: boolean;
  /**
   * `--only`: session names and/or pids (comma-separated entries). Only
   * orphans in this set are listed and, with `--kill`, ended: a caller that
   * confirmed a listing (Studio) passes exactly what it confirmed, so a
   * session or pid that changed in between is never touched.
   */
  only?: readonly string[];
}

/** Keep the orphans (and their processes) that `only` names. */
export function selectOrphans(
  orphans: readonly OrphanSession[],
  only: readonly string[] | undefined,
): OrphanSession[] {
  const tokens = (only ?? [])
    .flatMap((entry) => entry.split(","))
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [...orphans];
  const pids = new Set(
    tokens.filter((t) => /^\d+$/.test(t)).map((t) => Number(t)),
  );
  const sessions = new Set(tokens.filter((t) => !/^\d+$/.test(t)));
  const out: OrphanSession[] = [];
  for (const orphan of orphans) {
    if (sessions.size > 0 && !sessions.has(orphan.session)) continue;
    const processes =
      pids.size > 0
        ? orphan.processes.filter((p) => pids.has(p.pid))
        : orphan.processes;
    if (processes.length > 0) out.push({ ...orphan, processes });
  }
  return out;
}

export interface OrphansDeps {
  probe?: ProcessProbe;
  ledgerRoot?: string;
  /** Interactive confirmation (default: a y/N question on a terminal). */
  confirm?: (question: string) => Promise<boolean>;
  /** Is there a terminal to ask on (default: stdin and stderr are TTYs). */
  interactive?: boolean;
  /** Allow `--kill` of real processes (tests pass their fake probe). */
  kill?: typeof killOrphans;
}

const COMMAND_MAX = 200;

function toResultSession(
  orphan: OrphanSession,
  redact: (text: string) => string,
  killed?: boolean,
): OrphansResult["orphans"][number] {
  return {
    session: orphan.session,
    backend: orphan.backend,
    invocationId: orphan.invocationId,
    ownerPid: orphan.ownerPid,
    startedAt: orphan.startedAt,
    ...(orphan.projectDir ? { projectDir: orphan.projectDir } : {}),
    processes: orphan.processes.map((p) => ({
      pid: p.pid,
      command: redact(
        p.command.length > COMMAND_MAX
          ? `${p.command.slice(0, COMMAND_MAX - 3)}...`
          : p.command,
      ),
    })),
    ...(killed !== undefined ? { killed } : {}),
  };
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [y/N] `, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function findOrphans(
  opts: OrphansOptions = {},
  deps: OrphansDeps = {},
): Promise<OrphansResult> {
  const redactor = createArtifactRedactor(undefined, process.env);
  const redact = (text: string): string => redactor.text(text);
  const base = {
    $schema: "urn:cairntrace.dev:doctor-orphans:v1" as const,
    version: "1" as const,
    killRequested: opts.kill === true,
  };
  const scanned = scanOrphans({
    ...(deps.probe ? { probe: deps.probe } : {}),
    ...(deps.ledgerRoot ? { root: deps.ledgerRoot } : {}),
  });
  const scan = {
    ...scanned,
    orphans: selectOrphans(scanned.orphans, opts.only),
  };
  const staleEntriesRemoved = pruneStale(scan.stale);
  if (!opts.kill || scan.orphans.length === 0) {
    const ok = scan.orphans.length === 0;
    return OrphansResultSchema.parse({
      ...base,
      ok,
      exitCode: ok ? 0 : 1,
      orphans: scan.orphans.map((o) => toResultSession(o, redact)),
      staleEntriesRemoved,
      liveSessions: scan.live,
      killed: 0,
      remaining: [],
    });
  }
  // --kill: confirm first.
  const interactive =
    deps.interactive ??
    (process.stdin.isTTY === true && process.stderr.isTTY === true);
  const processes = scan.orphans.reduce((n, o) => n + o.processes.length, 0);
  let approved = opts.yes === true;
  if (!approved) {
    if (opts.structured || !interactive) {
      return OrphansResultSchema.parse({
        ...base,
        ok: false,
        exitCode: 2,
        orphans: scan.orphans.map((o) => toResultSession(o, redact)),
        staleEntriesRemoved,
        liveSessions: scan.live,
        killed: 0,
        remaining: [],
        error:
          "--kill needs a confirmation and there is no terminal to ask on (or the output is structured): re-run with --yes",
      });
    }
    approved = await (deps.confirm ?? askYesNo)(
      `Kill ${processes} process(es) of ${scan.orphans.length} orphaned browser session(s)?`,
    );
  }
  if (!approved) {
    return OrphansResultSchema.parse({
      ...base,
      ok: false,
      exitCode: 1,
      orphans: scan.orphans.map((o) => toResultSession(o, redact)),
      staleEntriesRemoved,
      liveSessions: scan.live,
      killed: 0,
      remaining: [],
    });
  }
  const outcome = (deps.kill ?? killOrphans)(scan.orphans, deps.probe);
  const stillAlive = new Set(outcome.remaining);
  const orphans = scan.orphans.map((o) =>
    toResultSession(
      o,
      redact,
      o.processes.every((p) => !stillAlive.has(p.pid)),
    ),
  );
  return OrphansResultSchema.parse({
    ...base,
    ok: outcome.remaining.length === 0,
    exitCode: outcome.remaining.length === 0 ? 0 : 1,
    orphans,
    staleEntriesRemoved,
    liveSessions: scan.live,
    killed: outcome.killed,
    remaining: outcome.remaining,
  });
}

/** Markdown rendering of the result. */
export function renderOrphansMarkdown(result: OrphansResult): string {
  const lines: string[] = [];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.orphans.length === 0) {
    lines.push("No orphaned cairn browser sessions.");
  } else {
    lines.push(
      `${result.orphans.length} orphaned browser session(s) (their cairn run is gone):`,
    );
    for (const orphan of result.orphans) {
      lines.push(
        `- ${orphan.session} (${orphan.backend}, invocation ${orphan.invocationId}, owner pid ${orphan.ownerPid} gone)${
          orphan.killed === true ? " — killed" : ""
        }`,
      );
      for (const proc of orphan.processes) {
        lines.push(`    pid ${proc.pid} ${proc.command}`);
      }
    }
    if (!result.killRequested) {
      lines.push("", "End them with: cairn doctor --orphans --kill [--yes]");
    }
  }
  if (result.staleEntriesRemoved > 0) {
    lines.push(
      `Removed ${result.staleEntriesRemoved} stale ledger entr${
        result.staleEntriesRemoved === 1 ? "y" : "ies"
      } (nothing left running).`,
    );
  }
  if (result.liveSessions > 0) {
    lines.push(`${result.liveSessions} session(s) belong to a running cairn.`);
  }
  if (result.killRequested && result.killed > 0) {
    lines.push(`Ended ${result.killed} process(es).`);
  }
  if (result.remaining.length > 0) {
    lines.push(`Still alive: ${result.remaining.join(", ")}`);
  }
  return lines.join("\n");
}
