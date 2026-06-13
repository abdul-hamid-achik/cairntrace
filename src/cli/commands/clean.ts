import { pruneRuns, type PruneResult } from "../../core/artifacts/retention";
import { emit, resolveFormat } from "../format";
import { resolveArtifactRootContext } from "../runRefs";

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
}

const DEFAULT_KEEP_RUNS = 10;

/**
 * `cairn clean [--keep N] [--all]` — prune old run directories.
 *
 * Keep-count resolution: --all (0) > --keep N > config retention.keepRuns >
 * 10. Artifact root resolution: --artifact-root > config artifactRoot >
 * ~/.cairntrace/runs. Config discovery walks up from the cwd (same as specs).
 */
export async function cleanCommand(opts: CleanOptions): Promise<void> {
  const format = resolveFormat(opts, "md");

  let artifactRoot: string;
  let keepRunsFromConfig: number | undefined;
  try {
    const resolved = await resolveArtifactRootContext(opts);
    artifactRoot = resolved.artifactRoot;
    keepRunsFromConfig = resolved.loaded?.config.retention?.keepRuns;
  } catch (e) {
    process.stderr.write(`cairn clean: ${(e as Error).message}\n`);
    process.exit(2);
  }

  let keepRuns: number;
  if (opts.all) {
    keepRuns = 0;
  } else if (opts.keep !== undefined) {
    keepRuns = Number(opts.keep);
    if (!Number.isInteger(keepRuns) || keepRuns < 0) {
      process.stderr.write(
        `cairn clean: --keep expects a non-negative integer, got "${opts.keep}"\n`,
      );
      process.exit(2);
    }
  } else {
    keepRuns = keepRunsFromConfig ?? DEFAULT_KEEP_RUNS;
  }

  const pruned = await pruneRuns(artifactRoot, { keepRuns });
  const report: CleanReport = { ...pruned, artifactRoot, keepRuns };

  process.stdout.write(emit(format, report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function toMarkdown(r: CleanReport): string {
  const lines = [
    `# cairn clean — ${r.artifactRoot}`,
    "",
    `Removed ${r.removed.length} run dir(s), freed ${formatBytes(r.freedBytes)}, kept ${r.kept} (keepRuns: ${r.keepRuns} per spec).`,
  ];
  if (r.removed.length > 0) {
    lines.push("", "Removed:");
    for (const id of r.removed.slice(0, 20)) lines.push(`  - ${id}`);
    if (r.removed.length > 20) {
      lines.push(`  …and ${r.removed.length - 20} more`);
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
