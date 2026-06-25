import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SeedConfig } from "../schema/config.v1";

/**
 * Seed freshness state — tracks when a seed command was last run and whether
 * it should be skipped on the next invocation.
 *
 * State lives at `~/.cairntrace/services/<project>.seed.json`, following the
 * same pattern as `CheckpointStore`. The file is small, human-readable JSON.
 */

export interface SeedState {
  /** Project name (from config). */
  project: string;
  /** SHA-256 fingerprint of the seed command + env keys at last run. */
  fingerprint: string;
  /** ISO timestamp of the last successful seed run. */
  lastRunAt: string;
  /** Exit code of the last seed run (0 = success). */
  lastRunExitCode: number;
}

/**
 * Decides whether the seed should run, skip, or re-run based on three layers:
 * 1. Fingerprint — did the command or env keys change?
 * 2. TTL — is the last run older than `ttlSeconds`?
 * 3. freshnessCheck — optional command whose exit 0 means "data is fresh".
 */
export class SeedStateStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), ".cairntrace", "services");
  }

  /** Path to the seed state file for `project`. */
  pathFor(project: string): string {
    if (!/^[a-z][a-z0-9-_]*$/i.test(project)) {
      throw new Error(
        `invalid project name "${project}" — use letters, digits, hyphen, underscore (must start with a letter)`,
      );
    }
    return join(this.root, `${project}.seed.json`);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async read(project: string): Promise<SeedState | undefined> {
    try {
      const text = await readFile(this.pathFor(project), "utf8");
      return JSON.parse(text) as SeedState;
    } catch {
      return undefined;
    }
  }

  async write(project: string, state: SeedState): Promise<void> {
    await this.ensureRoot();
    await writeFile(
      this.pathFor(project),
      JSON.stringify(state, null, 2),
      "utf8",
    );
  }

  async delete(project: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(project));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compute a fingerprint from the seed config — the command string + sorted
   * env keys (not values, so secret rotation doesn't trigger re-seed). Any
   * change to the command or the set of env keys produces a different hash.
   */
  fingerprint(project: string, cfg: SeedConfig): string {
    const envKeys = Object.keys(cfg.env ?? {}).toSorted();
    const payload = JSON.stringify({
      project,
      command: cfg.command,
      envKeys,
      ttlSeconds: cfg.ttlSeconds ?? 0,
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  /**
   * Check whether the seed should be skipped (data is fresh) or run.
   * Returns `{ shouldRun: true, reason }` when the seed needs to run,
   * or `{ shouldRun: false, reason }` when it can be skipped.
   *
   * The `freshnessCheck` command (if configured) is NOT run here — the caller
   * runs it separately because it needs shell execution context. This function
   * only handles the fingerprint + TTL layers. When both pass and a
   * `freshnessCheck` is configured, `shouldRun` is `true` with reason
   * `"freshness-check-pending"` so the caller knows to run the check command.
   */
  checkFreshness(
    project: string,
    cfg: SeedConfig,
    state: SeedState | undefined,
  ): { shouldRun: boolean; reason: string } {
    const fp = this.fingerprint(project, cfg);

    // No state file — never seeded before.
    if (!state) {
      return { shouldRun: true, reason: "no-previous-seed" };
    }

    // Fingerprint mismatch — command or env keys changed.
    if (state.fingerprint !== fp) {
      return {
        shouldRun: true,
        reason: `fingerprint-changed (was ${state.fingerprint}, now ${fp})`,
      };
    }

    // Previous seed failed — always re-run.
    if (state.lastRunExitCode !== 0) {
      return {
        shouldRun: true,
        reason: `previous-seed-failed (exit ${state.lastRunExitCode})`,
      };
    }

    // TTL check. ttlSeconds defaults to 0 (via schema `?? 0`), meaning
    // "always re-seed unless a freshnessCheck says the data is fresh."
    const ttl = cfg.ttlSeconds ?? 0;
    if (ttl > 0) {
      const lastRunMs = new Date(state.lastRunAt).getTime();
      if (Number.isNaN(lastRunMs)) {
        return { shouldRun: true, reason: "invalid-lastRunAt-timestamp" };
      }
      const ageSec = (Date.now() - lastRunMs) / 1000;
      if (ageSec > ttl) {
        return {
          shouldRun: true,
          reason: `ttl-expired (age ${Math.round(ageSec)}s > ttl ${ttl}s)`,
        };
      }
    } else if (ttl === 0) {
      // ttlSeconds=0 (default) means always re-seed unless freshnessCheck says
      // the data is fresh. But we still let the freshnessCheck layer decide.
      // If no freshnessCheck is configured, always re-seed.
      if (!cfg.freshnessCheck) {
        return { shouldRun: true, reason: "ttl-zero-no-freshness-check" };
      }
    }

    // Fingerprint + TTL pass. If there's a freshnessCheck, the caller must
    // run it to make the final decision.
    if (cfg.freshnessCheck) {
      return { shouldRun: true, reason: "freshness-check-pending" };
    }

    // All checks pass, no freshnessCheck — skip the seed.
    return { shouldRun: false, reason: "within-ttl" };
  }

  /**
   * Record a completed seed run. Called after the seed command finishes
   * (regardless of exit code, so failed runs are tracked too).
   */
  async recordRun(
    project: string,
    cfg: SeedConfig,
    exitCode: number,
  ): Promise<void> {
    const state: SeedState = {
      project,
      fingerprint: this.fingerprint(project, cfg),
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: exitCode,
    };
    await this.write(project, state);
  }
}
