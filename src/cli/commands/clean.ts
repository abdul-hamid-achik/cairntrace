import {
  pruneRuns,
  DEFAULT_KEEP_RUNS,
  DEFAULT_KEEP_FAILED_RUNS,
  type PruneResult,
} from "../../core/artifacts/retention";
import { emit, resolveFormat } from "../format";
import { log, reconfigureWithConfig } from "../logger";
import { resolveArtifactRootContext } from "../runRefs";
import { stashDirectory } from "./stash";

const cleanLog = log.scope("clean");

export interface CleanOptions {
  keep?: string;
  all?: boolean;
  artifactRoot?: string;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

interface CleanReport extends PruneResult {
  artifactRoot: string;
  keepRuns: number;
  keepFailedRuns: number;
}

/**
 * `cairn clean [--keep N] [--all]` — prune old run directories.
 *
 * Keep-count resolution: --all (0) > --keep N > config retention.keepRuns >
 * DEFAULT_KEEP_RUNS (3). Artifact root resolution: --artifact-root > config
 * artifactRoot > ~/.cairntrace/runs. Config discovery walks up from the cwd
 * (same as specs). When config `retention.archiveToStash` is true, pruned
 * runs are archived to fcheap before deletion (best-effort). The
 * `retention.keepFailedRuns` carve-out (config value, default
 * DEFAULT_KEEP_FAILED_RUNS) also applies here, except `--all` forces it to 0
 * — a full clean means full, no failed-run exemption.
 */
export async function cleanCommand(opts: CleanOptions): Promise<void> {
  const format = resolveFormat(opts, "md");

  let artifactRoot: string;
  let keepRunsFromConfig: number | undefined;
  let keepFailedRunsFromConfig: number | undefined;
  let retention:
    | { archiveToStash?: boolean; archiveTags?: string[] }
    | undefined;
  try {
    const resolved = await resolveArtifactRootContext(opts);
    artifactRoot = resolved.artifactRoot;
    keepRunsFromConfig = resolved.loaded?.config.retention?.keepRuns;
    keepFailedRunsFromConfig =
      resolved.loaded?.config.retention?.keepFailedRuns;
    retention = resolved.loaded?.config.retention;
    // Apply the config `logging` block as a project default (flags/env win).
    reconfigureWithConfig(resolved.loaded?.config?.logging);
  } catch (e) {
    cleanLog.error((e as Error).message);
    process.exit(2);
  }

  let keepRuns: number;
  if (opts.all) {
    keepRuns = 0;
  } else if (opts.keep !== undefined) {
    keepRuns = Number(opts.keep);
    if (!Number.isInteger(keepRuns) || keepRuns < 0) {
      cleanLog.error(
        `--keep expects a non-negative integer, got "${opts.keep}"`,
      );
      process.exit(2);
    }
  } else {
    keepRuns = keepRunsFromConfig ?? DEFAULT_KEEP_RUNS;
  }

  const keepFailedRuns = opts.all
    ? 0
    : (keepFailedRunsFromConfig ?? DEFAULT_KEEP_FAILED_RUNS);

  const onArchive =
    retention?.archiveToStash === true
      ? async (runDir: string, _runId: string) => {
          const r = await stashDirectory(runDir, {
            tool: "cairntrace",
            tags: [...(retention.archiveTags ?? []), "retention-archived"],
          });
          // Throw on archive failure so pruneRuns retains the run on disk.
          if (!r.ok)
            throw new Error(`fcheap archive failed: ${r.error ?? "unknown"}`);
        }
      : undefined;
  const pruned = await pruneRuns(artifactRoot, {
    keepRuns,
    keepFailedRuns,
    ...(onArchive ? { onArchive } : {}),
  });
  const report: CleanReport = {
    ...pruned,
    artifactRoot,
    keepRuns,
    keepFailedRuns,
  };

  process.stdout.write(emit(format, report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (report.archiveFailures.length > 0) {
    cleanLog.warn(
      `${report.archiveFailures.length} run archive(s) failed; source directories were retained`,
    );
    process.exitCode = 2;
  }
}

function toMarkdown(r: CleanReport): string {
  const lines = [
    `# cairn clean — ${r.artifactRoot}`,
    "",
    `Removed ${r.removed.length} run dir(s), freed ${formatBytes(r.freedBytes)}, kept ${r.kept} (keepRuns: ${r.keepRuns} per spec, keepFailedRuns: ${r.keepFailedRuns} per spec).`,
  ];
  if (r.removed.length > 0) {
    lines.push("", "Removed:");
    for (const id of r.removed.slice(0, 20)) lines.push(`  - ${id}`);
    if (r.removed.length > 20) {
      lines.push(`  …and ${r.removed.length - 20} more`);
    }
  }
  if (r.archiveFailures.length > 0) {
    lines.push("", "Archive failures (retained on disk):");
    for (const failure of r.archiveFailures.slice(0, 20)) {
      lines.push(`  - ${failure.runId}: ${failure.error}`);
    }
    if (r.archiveFailures.length > 20) {
      lines.push(`  …and ${r.archiveFailures.length - 20} more`);
    }
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
