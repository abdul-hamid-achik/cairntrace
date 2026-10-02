import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RUN_DIR_PATTERN } from "../artifacts/retention";
import { FileCache } from "./fileCache";

/** The few run.json fields the catalog reports. */
export interface RunRef {
  runId: string;
  spec: string;
  specPath?: string;
  status: string;
  environment?: string;
  durationMs?: number;
  startedAt?: string;
}

/** Newest run and newest passed run of one spec file. */
export interface SpecRuns {
  latest?: RunRef;
  latestPassed?: RunRef;
  /**
   * No run in the scanned window recorded this spec's path; these are the
   * newest runs recorded under its name (a moved checkout, or a same-named
   * spec of another project sharing the artifact root).
   */
  byName?: true;
}

export interface RunIndex {
  /** Runs per spec name, then per absolute spec path (`""` = unknown path). */
  byName: Map<string, Map<string, SpecRuns>>;
  /** run.json files read. */
  read: number;
}

const runCache = new FileCache<RunRef | null>(2_000);

/**
 * Index the artifact root newest first (run dir names start with an ISO
 * timestamp), reading at most `maxRuns` run.json files. With `specs`, only
 * runs of those spec names are read, and a name stops being read once every
 * one of its `specs` paths has both its newest run and its newest passed run
 * (runs of a same-named spec at another path, e.g. another checkout sharing
 * the artifact root, never stop the scan early). Synthetic and unreadable
 * runs are skipped; `env` keeps only runs of that environment.
 */
export async function indexRuns(
  artifactRoot: string,
  opts: {
    maxRuns?: number;
    specs?: ReadonlyArray<{ name: string; path: string }>;
    env?: string;
  } = {},
): Promise<RunIndex> {
  const maxRuns = opts.maxRuns ?? 500;
  const byName = new Map<string, Map<string, SpecRuns>>();
  const wanted = opts.specs ? new Map<string, Set<string>>() : undefined;
  for (const spec of opts.specs ?? []) {
    const paths = wanted!.get(spec.name) ?? new Set<string>();
    paths.add(spec.path);
    wanted!.set(spec.name, paths);
  }
  const complete = new Set<string>();
  let read = 0;
  let names: string[];
  try {
    names = await readdir(artifactRoot);
  } catch {
    return { byName, read };
  }
  const runDirs = names
    .map((name) => ({ name, m: RUN_DIR_PATTERN.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
    .toSorted((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const { name, m } of runDirs) {
    if (read >= maxRuns) break;
    const specName = m[1]!;
    if (wanted && !wanted.has(specName)) continue;
    if (complete.has(specName)) continue;
    read += 1;
    const run = await runCache.get(
      join(artifactRoot, name, "run.json"),
      parseRunJson,
      16 * 1024 * 1024,
    );
    if (!run) continue;
    if (opts.env !== undefined && run.environment !== opts.env) continue;
    const perPath = byName.get(run.spec) ?? new Map<string, SpecRuns>();
    byName.set(run.spec, perPath);
    const key = run.specPath ?? "";
    const entry = perPath.get(key) ?? {};
    perPath.set(key, entry);
    entry.latest ??= run;
    if (run.status === "passed") entry.latestPassed ??= run;
    const paths = wanted?.get(run.spec);
    if (
      paths &&
      [...paths].every((path) => {
        const e = perPath.get(path);
        return e?.latest !== undefined && e.latestPassed !== undefined;
      })
    ) {
      complete.add(run.spec);
    }
  }
  return { byName, read };
}

/**
 * The runs of a spec: those recorded for its exact path, else (no run in
 * the scanned window recorded that path) the newest ones recorded under its
 * name, flagged `byName`.
 */
export function runsFor(
  index: RunIndex,
  name: string,
  absPath: string,
): SpecRuns {
  const perPath = index.byName.get(name);
  if (!perPath) return {};
  const exact = perPath.get(absPath);
  if (exact) return { ...exact };
  let latest: RunRef | undefined;
  let latestPassed: RunRef | undefined;
  for (const entry of perPath.values()) {
    if (entry.latest && (!latest || newer(entry.latest, latest))) {
      latest = entry.latest;
    }
    if (
      entry.latestPassed &&
      (!latestPassed || newer(entry.latestPassed, latestPassed))
    ) {
      latestPassed = entry.latestPassed;
    }
  }
  if (!latest && !latestPassed) return {};
  return {
    ...(latest ? { latest } : {}),
    ...(latestPassed ? { latestPassed } : {}),
    byName: true,
  };
}

/** True when `a` started after `b` (run ids sort chronologically). */
export function newer(a: RunRef, b: RunRef): boolean {
  return a.runId > b.runId;
}

function parseRunJson(text: string): RunRef | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const run = raw as Record<string, unknown>;
  const spec = run.spec as Record<string, unknown> | undefined;
  if (
    run.synthetic === true ||
    !nonEmpty(run.runId) ||
    !nonEmpty(run.status) ||
    !nonEmpty(spec?.name)
  ) {
    return null;
  }
  return {
    runId: run.runId,
    spec: spec.name,
    ...(typeof spec.path === "string" ? { specPath: spec.path } : {}),
    status: run.status,
    ...(typeof run.environment === "string"
      ? { environment: run.environment }
      : {}),
    ...(typeof run.durationMs === "number"
      ? { durationMs: Math.max(0, Math.round(run.durationMs)) }
      : {}),
    ...(typeof run.startedAt === "string" ? { startedAt: run.startedAt } : {}),
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
