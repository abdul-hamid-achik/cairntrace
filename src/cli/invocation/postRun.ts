import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute as isAbsolutePath, resolve } from "node:path";
import { renderJUnit } from "../../core/artifacts/renderers/junit";
import {
  EvidenceTransferError,
  type RetentionArchiveOutcome,
  type RetentionEvidencePolicy,
  type RetentionPublishOutcome,
} from "../../core/artifacts/retention";
import type { StashConfig } from "../../core/schema/config.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import { log as cliLog } from "../logger";
import { maybeAutoAnnotateRun } from "../commands/annotate";
import { investigateRunDirectory } from "../commands/investigate";
import { publishRunDirectory } from "../commands/publish";
import { stampSpecContractHash } from "../commands/spec/verify";
import {
  maybeAutoStash,
  pathFreeMessage,
  stashMetaForRun,
  stashRunDirectory,
} from "../commands/stash";
import { absoluteSpecPath, resolveRunRuntime } from "./options";

/**
 * After-the-fact work for a settled run: the retention archive/publish
 * adapters handed to runSpec, failure automation (auto-stash, auto-
 * investigate), auto-annotate, contract stamping and JUnit. Best-effort
 * except where the CLI contract makes a failure change the exit code
 * (stamp-if-green, JUnit).
 */

/** Leveled sink for post-run warnings (the run logger in the CLI). */
export interface PostRunLog {
  warn(message: string): void;
}

/** The lossy-archive notice is printed once per process. */
let warnedArchiveExclusions = false;

/**
 * Archive a pruned run dir to fcheap before the retention prune deletes it.
 * Injected into `runSpec` via `onArchiveRun` so the core runner never imports
 * the stash CLI module directly. The archive goes through the evidence gate
 * (`stash.include`, default [text, screenshots]) and carries `stash.ttl`.
 * Best-effort: failures are caught inside `pruneRuns` (the run is retained
 * on disk when archiving fails, and the runner records the reason).
 */
export function makeArchiveRun(
  warn: (message: string) => void,
): (
  runDir: string,
  runId: string,
  tags: string[],
  evidence?: RetentionEvidencePolicy,
) => Promise<RetentionArchiveOutcome> {
  return async (runDir, runId, tags, evidence = {}) => {
    const r = await stashRunDirectory(runDir, {
      action: "archive",
      tool: "cairntrace",
      tags,
      ...(evidence.include ? { include: evidence.include } : {}),
      ...(evidence.unsafeIncludeRawTraces
        ? { unsafeIncludeRawTraces: true }
        : {}),
      ...(evidence.ttl ? { ttl: evidence.ttl } : {}),
      meta: true,
    });
    // Throw on archive failure so pruneRuns retains the run on disk (move,
    // not copy-and-lose). Log before throwing because pruneRuns catches the
    // exception by design to keep the active run from failing.
    if (!r.ok || !r.stashId) {
      const message = `fcheap archive failed: ${pathFreeMessage(r.error ?? "unknown")}`;
      warn(
        `retention: archiving ${runId} failed (${r.reason ?? "unknown"}): ${message}; the run was retained on disk`,
      );
      throw new EvidenceTransferError(message, r.reason ?? "unknown");
    }
    if (r.secretsFound) {
      warn(
        `retention: archived ${runId} (${r.stashId}); file.cheap's secret scan flagged ${r.secretsFound} potential secret(s)`,
      );
    }
    if (r.excluded.length > 0 && !warnedArchiveExclusions) {
      // The archive is gated: what it leaves out is deleted with the run.
      warnedArchiveExclusions = true;
      warn(
        `retention: the archive of ${runId} left out ${r.excluded.join(", ")}; pruned runs lose them locally (add the categories to stash.include to archive them)`,
      );
    }
    return {
      stashId: r.stashId,
      ...(r.status ? { status: r.status } : {}),
      ...(r.excluded.length > 0 ? { excluded: r.excluded } : {}),
      ...(r.secretsFound !== undefined ? { secretsFound: r.secretsFound } : {}),
      ...(r.ttl ? { ttl: r.ttl } : {}),
      ...(r.expiresAt && !Number.isNaN(Date.parse(r.expiresAt))
        ? { expiresAt: new Date(r.expiresAt).toISOString() }
        : {}),
      tags,
    };
  };
}

/**
 * Publish a pruned run dir (retention `publish`) before deletion, through the
 * evidence gate (`retention.publish.include`). A failure is logged and
 * rethrown so the run stays on disk.
 */
export async function publishRun(
  runDir: string,
  runId: string,
  _tags: string[],
  retentionDays: number,
  evidence: RetentionEvidencePolicy = {},
): Promise<RetentionPublishOutcome> {
  try {
    const published = await publishRunDirectory(runDir, runId, {
      retentionDays,
      ...(evidence.include ? { include: evidence.include } : {}),
    });
    return {
      artifactRef: published.artifactRef,
      ...(published.webUrl ? { webUrl: published.webUrl } : {}),
      ...(published.excluded.length > 0
        ? { excluded: published.excluded }
        : {}),
    };
  } catch (error) {
    cliLog
      .scope("retention")
      .warn(
        `retention: publishing ${runId} failed: ${pathFreeMessage((error as Error).message)}; the run was retained on disk`,
      );
    throw error;
  }
}

type AutomationOptions = Pick<
  RunInvocationOptions,
  "env" | "config" | "var" | "stashOnFailure" | "stash" | "autoAnnotate"
>;

interface FailureAutomationConfig {
  stash?: StashConfig;
  investigate?: {
    autoInvestigate?: "on-failure" | "never";
    codebase?: string;
    mode?: "semantic" | "keyword" | "hybrid";
    limit?: number;
    index?: boolean;
  };
}

async function resolveFailureAutomation(
  specPath: string,
  opts: AutomationOptions,
  cwd: string,
): Promise<FailureAutomationConfig> {
  try {
    const specAbs = absoluteSpecPath(specPath, cwd);
    const ctx = await resolveRunRuntime(specAbs, opts);
    const investigate = ctx.config?.investigate;
    const configuredCodebase = investigate?.codebaseDir;
    const codebase = configuredCodebase
      ? isAbsolutePath(configuredCodebase)
        ? configuredCodebase
        : resolve(
            ctx.configPath ? dirname(ctx.configPath) : dirname(specAbs),
            configuredCodebase,
          )
      : undefined;
    return {
      ...(ctx.config?.stash ? { stash: ctx.config.stash } : {}),
      ...(investigate
        ? {
            investigate: {
              autoInvestigate: investigate.autoInvestigate,
              ...(codebase ? { codebase } : {}),
              ...(investigate.mode ? { mode: investigate.mode } : {}),
              ...(investigate.limit ? { limit: investigate.limit } : {}),
              ...(investigate.index ? { index: true } : {}),
            },
          }
        : {}),
    };
  } catch {
    // The normal run path owns config errors. Post-run integrations remain
    // best-effort and must not change a completed run's verdict.
    return {};
  }
}

/**
 * Auto-stash (`--stash`, `--stash-on-failure`, config `stash.autoStash`
 * always|on-failure) for every settled run, then — for a run that did not
 * pass — auto-investigate (reusing the one stash receipt), then
 * auto-annotate for every run. A run the environment policy refused is never
 * stashed or investigated.
 */
export async function runPostRunIntegrations(
  result: RunResult,
  specPath: string,
  opts: AutomationOptions,
  sinks: {
    log: PostRunLog;
    /** tty narration for stash lines (undefined = the stash logger). */
    narrate?: (message: string, kind: "info" | "warn") => void;
    cwd?: string;
  },
): Promise<void> {
  const cwd = sinks.cwd ?? process.cwd();
  const status = result.status as string;
  const refused = status === "refused";
  const failed = status !== "passed" && !refused;
  const automation: FailureAutomationConfig = refused
    ? {}
    : await resolveFailureAutomation(specPath, opts, cwd);
  const autoStash = (force: boolean) =>
    maybeAutoStash(result.runDir, result.runId, result.spec.name, {
      status: failed ? (status === "errored" ? "errored" : "failed") : "passed",
      stashOnFailure: opts.stashOnFailure ?? false,
      ...(opts.stash || force ? { stash: true } : {}),
      ...(automation.stash ? { configStash: automation.stash } : {}),
      meta: stashMetaForRun(result),
      narrate: sinks.narrate,
    });
  const stashReceipt = refused ? undefined : await autoStash(false);
  if (failed) {
    if (automation.investigate?.autoInvestigate === "on-failure") {
      if (!automation.investigate.codebase) {
        sinks.log.warn(
          "auto-investigate skipped: investigate.codebaseDir is required",
        );
      } else {
        // Investigation links its findings to a stash. Reuse the auto-stash;
        // when none ran, take one through the same evidence gate (receipt,
        // TTL, include) rather than letting investigate save the whole run.
        // A stash that already failed is not retried.
        const stash = stashReceipt ?? (await autoStash(true));
        if (!stash?.ok || !stash.stashId) {
          sinks.log.warn(
            `auto-investigate skipped: the run could not be stashed (${stash?.reason ?? "unknown"})`,
          );
        } else {
          const investigation = await investigateRunDirectory(
            result.runDir,
            result.runId,
            {
              connect: true,
              codebase: automation.investigate.codebase,
              mode: automation.investigate.mode ?? "hybrid",
              limit: automation.investigate.limit ?? 10,
              index: automation.investigate.index ?? false,
              stashId: stash.stashId,
            },
          );
          if (investigation.error) {
            sinks.log.warn(
              `auto-investigate failed (non-fatal): ${investigation.error}`,
            );
          }
        }
      }
    }
  }

  // Pass + fail: emits one annotation per run with run context.
  await maybeAutoAnnotateRun(
    result,
    await resolveAnnotateOpts(specPath, opts, cwd),
  );
}

/**
 * Resolve the effective auto-annotate options for the run path.
 * The `--auto-annotate` CLI flag wins over the config `annotate.autoAnnotate`
 * value. The `annotate.source` config value provides the default source label.
 * Returns `{ autoAnnotate: "never" }` when neither is set, so
 * `maybeAutoAnnotateRun` is a no-op.
 */
async function resolveAnnotateOpts(
  specPath: string,
  opts: AutomationOptions,
  cwd: string,
): Promise<{ autoAnnotate?: string; source?: string }> {
  // CLI flag wins.
  if (opts.autoAnnotate) {
    return { autoAnnotate: opts.autoAnnotate };
  }
  // Fall back to config annotate block.
  try {
    const ctx = await resolveRunRuntime(absoluteSpecPath(specPath, cwd), {
      config: opts.config,
    });
    const annotate = ctx.config?.annotate;
    if (annotate?.autoAnnotate && annotate.autoAnnotate !== "never") {
      return {
        autoAnnotate: annotate.autoAnnotate,
        ...(annotate.source ? { source: annotate.source } : {}),
      };
    }
  } catch {
    // config resolution failure — silently skip; the run itself will report
  }
  return { autoAnnotate: "never" };
}

/** Write the JUnit report when requested; false when writing failed. */
export async function writeJUnitIfRequested(
  opts: Pick<RunInvocationOptions, "junit">,
  results: RunResult[],
  log: PostRunLog,
  cwd: string = process.cwd(),
): Promise<boolean> {
  if (!opts.junit) return true;
  const outPath = isAbsolutePath(opts.junit)
    ? opts.junit
    : resolve(cwd, opts.junit);
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, renderJUnit(results));
    return true;
  } catch (e) {
    log.warn(`could not write JUnit report: ${(e as Error).message}`);
    return false;
  }
}

/** `--stamp-if-green`: stamp every spec when all passed; false on failure. */
export async function stampIfGreen(
  opts: Pick<RunInvocationOptions, "stampIfGreen">,
  results: RunResult[],
  log: PostRunLog,
): Promise<boolean> {
  if (!opts.stampIfGreen) return true;
  if (results.some((r) => r.status !== "passed")) return true;
  try {
    const paths = new Set(results.map((r) => r.spec.path));
    for (const specPath of paths) await stampSpecContractHash(specPath);
    return true;
  } catch (e) {
    log.warn(`could not stamp contract hash: ${(e as Error).message}`);
    return false;
  }
}
