import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  ProjectLedgerRecordSchema,
  type FixtureAdapter,
  type FixtureEventStatus,
  type FixtureScope,
  type FixtureVerbName,
  type ProjectLedgerRecord,
} from "./schema";

/**
 * The project fixture ledger: `~/.cairntrace/fixtures/<project>.ledger.jsonl`,
 * one line per verb that ran anywhere (a run, an invocation, the CLI, a
 * sweep). It is append-only; `foldLedger` turns it into the live state per
 * environment and fixture — per instance for a run-scoped fixture (each run
 * owns its own) — which drives seed/suite freshness, `cairn fixtures
 * status` and `cairn fixtures sweep` (fixtures a hard kill left behind are
 * still "live" there).
 */

export function defaultLedgerRoot(): string {
  return join(homedir(), ".cairntrace", "fixtures");
}

export function projectLedgerPath(
  project: string,
  root: string = defaultLedgerRoot(),
): string {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(project)) {
    throw new Error(
      `invalid project name "${project}" for the fixture ledger (letters, digits, ., _, -)`,
    );
  }
  return join(root, `${project}.ledger.jsonl`);
}

/** Append one record; best effort (a read-only home never fails a run). */
export async function appendProjectLedger(
  record: Omit<ProjectLedgerRecord, "v" | "pid" | "host"> & {
    pid?: number;
    host?: string;
  },
  root: string = defaultLedgerRoot(),
): Promise<boolean> {
  const full: ProjectLedgerRecord = {
    v: 1,
    pid: process.pid,
    host: hostname(),
    ...record,
  };
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await appendFile(
      projectLedgerPath(record.project, root),
      `${JSON.stringify(full)}\n`,
      {
        mode: 0o600,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** Every valid record, oldest first (invalid lines are skipped). */
export async function readProjectLedger(
  project: string,
  root: string = defaultLedgerRoot(),
): Promise<ProjectLedgerRecord[]> {
  let text: string;
  try {
    text = await readFile(projectLedgerPath(project, root), "utf8");
  } catch {
    return [];
  }
  const records: ProjectLedgerRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = ProjectLedgerRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // A torn line (crash mid-append) is skipped.
    }
  }
  return records;
}

/**
 * The folded state of one fixture (instance) in one environment:
 * - `live`: ensured and not torn down since;
 * - `failed`: the last ensure (or teardown) failed — data may be partial;
 * - `torn-down`: the last teardown succeeded;
 * - `released`: cairn owes no teardown — the ensure adopted a record it did
 *   not create, or nothing was recorded to tear it down with.
 */
export type FixtureLiveStateName = "live" | "failed" | "torn-down" | "released";

export interface FixtureLiveState {
  env: string;
  name: string;
  adapter: FixtureAdapter;
  scope: FixtureScope;
  state: FixtureLiveStateName;
  defHash: string;
  ensuredAt?: string;
  outputs?: Record<string, unknown>;
  with?: Record<string, unknown>;
  ttlMs?: number;
  seed?: { lastRunAt: string };
  /** Live through a reset (a reset-only fixture), never through an ensure. */
  fromReset?: true;
  lastVerb: FixtureVerbName;
  lastStatus: FixtureEventStatus;
  lastAt: string;
  lastError?: string;
  origin: ProjectLedgerRecord["origin"];
  /** A run-scoped fixture's instance (its run, or the CLI token). */
  instance?: string;
  /** The ensure found a record it did not create (no marker on it). */
  adopted?: true;
  runId?: string;
  invocationId?: string;
  pid?: number;
  host?: string;
}

/** The fold key: (env, name), plus the instance of a run-scoped fixture. */
export function ledgerKey(
  env: string,
  name: string,
  instance?: string,
): string {
  return instance === undefined
    ? `${env}\u0000${name}`
    : `${env}\u0000${name}\u0000${instance}`;
}

function recordKey(record: ProjectLedgerRecord): string {
  return ledgerKey(
    record.env,
    record.name,
    record.scope === "run" ? record.instance : undefined,
  );
}

/**
 * Every folded state of one fixture in one environment (one per run
 * instance for a run-scoped fixture), newest first.
 */
export function fixtureStates(
  states: ReadonlyMap<string, FixtureLiveState>,
  env: string,
  name: string,
): FixtureLiveState[] {
  return [...states.values()]
    .filter((state) => state.env === env && state.name === name)
    .toSorted((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

/** Still owed a teardown (or worth a look): live or failed. */
export function isOpenState(state: FixtureLiveState): boolean {
  return state.state === "live" || state.state === "failed";
}

/**
 * Fold the records into the latest state per (env, fixture) — per (env,
 * fixture, instance) for a run-scoped fixture.
 */
export function foldLedger(
  records: readonly ProjectLedgerRecord[],
): Map<string, FixtureLiveState> {
  const states = new Map<string, FixtureLiveState>();
  for (const record of records) {
    const released =
      record.verb === "teardown" &&
      record.status === "skipped" &&
      record.released === true;
    if (
      !released &&
      (record.status === "dry-run" || record.status === "skipped")
    ) {
      continue;
    }
    if (record.verb === "verify") continue;
    const key = recordKey(record);
    const previous = states.get(key);
    const base = {
      env: record.env,
      name: record.name,
      adapter: record.adapter,
      scope: record.scope,
      lastVerb: record.verb,
      lastStatus: record.status,
      lastAt: record.ts,
      origin: record.origin,
      ...(record.scope === "run" && record.instance
        ? { instance: record.instance }
        : {}),
      ...(record.error ? { lastError: record.error } : {}),
      ...(record.runId ? { runId: record.runId } : {}),
      ...(record.invocationId ? { invocationId: record.invocationId } : {}),
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      ...(record.host ? { host: record.host } : {}),
    };
    if (record.verb === "ensure") {
      states.set(key, {
        ...base,
        state: record.status === "ok" ? "live" : "failed",
        defHash: record.defHash,
        ensuredAt: record.ts,
        ...(record.outputs ? { outputs: record.outputs } : {}),
        ...(record.with ? { with: record.with } : {}),
        ...(record.ttlMs !== undefined ? { ttlMs: record.ttlMs } : {}),
        ...(record.seed ? { seed: record.seed } : {}),
        ...(record.adopted ? { adopted: true as const } : {}),
      });
      continue;
    }
    if (record.verb === "teardown") {
      if (released) {
        states.set(key, {
          ...(previous ?? { defHash: record.defHash }),
          ...base,
          state: "released",
        } as FixtureLiveState);
      } else if (record.status === "ok") {
        states.set(key, {
          ...(previous ?? { defHash: record.defHash }),
          ...base,
          state: "torn-down",
        } as FixtureLiveState);
      } else if (previous) {
        states.set(key, { ...previous, ...base, state: previous.state });
      } else {
        states.set(key, {
          ...base,
          state: "failed",
          defHash: record.defHash,
        });
      }
      continue;
    }
    // reset: the fixture is still there; remember when it was last touched.
    // A reset-only fixture is "ensured" by its reset.
    if (previous) {
      states.set(key, { ...previous, ...base, state: previous.state });
    } else if (record.status === "ok") {
      states.set(key, {
        ...base,
        state: "live",
        fromReset: true,
        defHash: record.defHash,
        ensuredAt: record.ts,
        ...(record.with ? { with: record.with } : {}),
      });
    }
  }
  return states;
}

/** When a live fixture with a ttl stops being fresh. */
export function expiresAt(state: FixtureLiveState): string | undefined {
  if (state.ttlMs === undefined || state.ensuredAt === undefined) {
    return undefined;
  }
  return new Date(Date.parse(state.ensuredAt) + state.ttlMs).toISOString();
}

/** Whether the process that recorded the state is still running here. */
export function ownerProcessAlive(state: FixtureLiveState): boolean {
  if (state.pid === undefined || state.pid === process.pid) return false;
  if (state.host !== undefined && state.host !== hostname()) return false;
  try {
    process.kill(state.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When a `cairn run` invocation last saw the services seed actually run
 * (not skipped as fresh): `<root>/<project>.seed-runs.json`. A seed-scoped
 * fixture ensured before it is stale, even when the invocation that reseeded
 * used no fixtures.
 */
function seedRunsPath(project: string, root: string): string {
  return projectLedgerPath(project, root).replace(
    /\.ledger\.jsonl$/,
    ".seed-runs.json",
  );
}

export async function recordSeedRun(
  project: string,
  at: string,
  root: string = defaultLedgerRoot(),
): Promise<void> {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(
      seedRunsPath(project, root),
      `${JSON.stringify({ lastSeedRunAt: at })}\n`,
      {
        mode: 0o600,
      },
    );
  } catch {
    // Best effort: freshness then falls back to the services seed state.
  }
}

export async function lastSeedRun(
  project: string,
  root: string = defaultLedgerRoot(),
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(seedRunsPath(project, root), "utf8"),
    ) as {
      lastSeedRunAt?: unknown;
    };
    return typeof parsed.lastSeedRunAt === "string"
      ? parsed.lastSeedRunAt
      : undefined;
  } catch {
    return undefined;
  }
}
