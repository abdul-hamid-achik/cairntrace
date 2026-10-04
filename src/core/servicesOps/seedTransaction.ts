import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SeedStateStore, type SeedState } from "../runner/seedState";
import type { SeedConfig } from "../schema/config.v1";
import {
  phaseRun,
  type ExpectOutput,
  type SeedPhase,
  type SeedPostCommand,
} from "./schema";

/**
 * Seed transaction (F12): per-phase persisted state keyed by project +
 * environment + target hash, the phase decision, `postCommands.when` and the
 * output assertion. Pure helpers and a small store; the orchestration lives
 * in the services runner.
 */

export interface PhaseRecord {
  /** Hash of the phase command: a changed command is a new phase. */
  fingerprint: string;
  ranAt: string;
  exitCode: number;
  durationMs: number;
}

/** What is persisted for one project + environment + target. */
export interface ScopedSeedState {
  version: 1;
  project: string;
  env: string;
  targetHash: string;
  phases: Record<string, PhaseRecord>;
  /**
   * Set when a run failed on a phase: the phases (name → command fingerprint)
   * that had succeeded in it. The next run skips them instead of starting
   * over; a run that gets through every phase clears it.
   */
  resume?: { at: string; done: Record<string, string> };
  /**
   * Freshness of a single-command seed with `commit: afterPostCommands`:
   * written only once every post-command succeeded.
   */
  committed?: {
    fingerprint: string;
    lastRunAt: string;
    lastRunExitCode: number;
  };
}

function segment(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") ||
    "default"
  );
}

/**
 * Identity of what is seeded: the free-text `target`, the working directory
 * and the seed's env (names and values, hashed so a secret never reaches the
 * state file). Two targets never share a freshness record.
 */
export function seedTargetHash(input: {
  target?: string | undefined;
  cwd: string;
  env?: Record<string, string> | undefined;
}): string {
  const env = Object.entries(input.env ?? {}).toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({ target: input.target ?? null, cwd: input.cwd, env }),
    )
    .digest("hex")
    .slice(0, 12);
}

export function phaseFingerprint(phase: SeedPhase): string {
  return createHash("sha256")
    .update(JSON.stringify({ name: phase.name, run: phaseRun(phase) }))
    .digest("hex")
    .slice(0, 16);
}

export class SeedPhaseStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), ".cairntrace", "services");
  }

  pathFor(project: string, env: string, targetHash: string): string {
    if (!/^[a-z][a-z0-9-_]*$/i.test(project)) {
      throw new Error(
        `invalid project name "${project}" — use letters, digits, hyphen, underscore (must start with a letter)`,
      );
    }
    return join(
      this.root,
      `${project}.${segment(env)}.${targetHash}.seed-state.json`,
    );
  }

  async read(
    project: string,
    env: string,
    targetHash: string,
  ): Promise<ScopedSeedState | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.pathFor(project, env, targetHash), "utf8"),
      ) as ScopedSeedState;
      if (parsed?.version !== 1 || typeof parsed.phases !== "object") {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Atomic write (temp file + rename). */
  async write(state: ScopedSeedState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file = this.pathFor(state.project, state.env, state.targetHash);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, file);
  }
}

/**
 * Forget what a failed seed run left to resume (synchronous: the signal path
 * uses it too). A teardown ran (`docker compose down`, `services down`), so
 * the phases that had succeeded may have nothing left to show for it. True
 * when a resume was dropped; a missing or unreadable file is left alone.
 */
export function dropSeedResumeSync(file: string): boolean {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as
      | Partial<ScopedSeedState>
      | undefined;
    if (!state || typeof state !== "object" || !state.resume) return false;
    delete state.resume;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is a resume still usable? With `ttlSeconds` set, a resume older than the
 * TTL is stale (what the phases made may have expired with it).
 */
export function resumeFresh(
  resume: ScopedSeedState["resume"],
  ttlSeconds: number,
  now: number = Date.now(),
): boolean {
  if (!resume) return false;
  if (ttlSeconds <= 0) return true;
  const at = Date.parse(resume.at);
  return !Number.isNaN(at) && (now - at) / 1000 <= ttlSeconds;
}

export function emptyScopedState(
  project: string,
  env: string,
  targetHash: string,
): ScopedSeedState {
  return { version: 1, project, env, targetHash, phases: {} };
}

/**
 * Does a recorded outcome let `phase` be skipped? (The caller handles
 * `always` and the `skipIf` probe first.) Only a success of the same command
 * within `ttlSeconds` counts; with no TTL a phase has no memory and runs.
 */
export function phaseStateDecision(
  phase: SeedPhase,
  record: PhaseRecord | undefined,
  ttlSeconds: number,
  now: number = Date.now(),
): { run: boolean; reason: string } {
  if (!record) return { run: true, reason: "no-previous-run" };
  if (record.fingerprint !== phaseFingerprint(phase)) {
    return { run: true, reason: "command-changed" };
  }
  if (record.exitCode !== 0) {
    return {
      run: true,
      reason: `previous-run-failed (exit ${record.exitCode})`,
    };
  }
  if (ttlSeconds <= 0) return { run: true, reason: "no-ttl" };
  const ranAt = Date.parse(record.ranAt);
  if (Number.isNaN(ranAt)) return { run: true, reason: "invalid-timestamp" };
  const ageSeconds = (now - ranAt) / 1000;
  if (ageSeconds > ttlSeconds) {
    return {
      run: true,
      reason: `ttl-expired (age ${Math.round(ageSeconds)}s > ttl ${ttlSeconds}s)`,
    };
  }
  return { run: false, reason: "within-ttl" };
}

/**
 * The first reason `output` breaks `expectOutput`, or undefined. The message
 * names the pattern and quotes the matching line (bounded; the caller
 * redacts it).
 */
export function expectOutputViolation(
  output: string,
  expectOutput: ExpectOutput | undefined,
): string | undefined {
  if (!expectOutput) return undefined;
  for (const source of expectOutput.notMatches) {
    let regex: RegExp;
    try {
      regex = new RegExp(source);
    } catch {
      continue;
    }
    for (const line of output.split(/\r?\n/)) {
      if (!regex.test(line)) continue;
      const shown = line.trim();
      return `output matches the forbidden pattern /${source}/: ${
        shown.length > 200 ? `${shown.slice(0, 197)}...` : shown
      }`;
    }
  }
  return undefined;
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Does a post-command run for this suite and environment? A plain string
 * always does; an object with `when` needs every key that is set to match
 * (a `suite` condition never matches a run without a suite).
 */
export function postCommandApplies(
  entry: SeedPostCommand,
  current: { suite?: string | undefined; env?: string | undefined },
): { applies: boolean; reason?: string } {
  if (typeof entry === "string" || !entry.when) return { applies: true };
  const suites = asList(entry.when.suite);
  if (
    suites &&
    (current.suite === undefined || !suites.includes(current.suite))
  ) {
    return {
      applies: false,
      reason: `when.suite ${suites.join("|")} (this run: ${current.suite ?? "no suite"})`,
    };
  }
  const envs = asList(entry.when.env);
  if (envs && (current.env === undefined || !envs.includes(current.env))) {
    return {
      applies: false,
      reason: `when.env ${envs.join("|")} (this run: ${current.env ?? "unknown"})`,
    };
  }
  return { applies: true };
}

/**
 * The freshness record of a single-command seed with `commit:
 * afterPostCommands` (or a `target`): the legacy store's read / check / record
 * interface, kept per project + environment + target instead of per project.
 */
export class ScopedSeedFreshness {
  private readonly checker = new SeedStateStore();

  constructor(
    private readonly store: SeedPhaseStore,
    private readonly env: string,
    private readonly targetHash: string,
  ) {}

  async read(project: string): Promise<SeedState | undefined> {
    const state = await this.store.read(project, this.env, this.targetHash);
    return state?.committed ? { project, ...state.committed } : undefined;
  }

  checkFreshness(
    project: string,
    cfg: SeedConfig,
    state: SeedState | undefined,
  ): { shouldRun: boolean; reason: string } {
    return this.checker.checkFreshness(project, cfg, state);
  }

  async recordRun(
    project: string,
    cfg: SeedConfig,
    exitCode: number,
  ): Promise<void> {
    const state =
      (await this.store.read(project, this.env, this.targetHash)) ??
      emptyScopedState(project, this.env, this.targetHash);
    state.committed = {
      fingerprint: this.checker.fingerprint(project, cfg),
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: exitCode,
    };
    await this.store.write(state);
  }
}
