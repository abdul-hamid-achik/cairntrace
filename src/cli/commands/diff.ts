import { diffRuns, type RunDiff } from "../../core/diff/runDiff";
import { emit, resolveFormat } from "../format";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";

export interface DiffOptions {
  artifactRoot?: string;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn diff <runA> <runB>` — structural comparison of two runs.
 * Each arg may be:
 *   - an absolute run-dir path
 *   - a run id (resolved against ~/.cairntrace/runs/<id>)
 *   - the literal "latest" / "previous"
 */
export async function diffCommand(
  refA: string,
  refB: string,
  opts: DiffOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let dirA: string | undefined;
  let dirB: string | undefined;
  try {
    const runsRoot = await resolveArtifactRoot(opts);
    dirA = await resolveRunRef(refA, runsRoot);
    dirB = await resolveRunRef(refB, runsRoot);
  } catch (e) {
    process.stderr.write(`cairn diff: ${(e as Error).message}\n`);
    process.exit(2);
  }
  if (!dirA || !dirB) {
    process.stderr.write(`cairn diff: could not resolve both runs\n`);
    process.exit(2);
  }

  const result = await diffRuns(dirA, dirB);
  process.stdout.write(emit(format, result, renderMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function renderMarkdown(d: RunDiff): string {
  const lines: string[] = [
    `# Diff: ${shortId(d.a.id)} → ${shortId(d.b.id)}`,
    "",
    "## Overall",
    `- Status: ${d.a.status} → ${d.b.status}${
      d.overall.statusChanged ? " (changed)" : ""
    }`,
    `- Duration: ${formatMs(d.a.durationMs)} → ${formatMs(d.b.durationMs)} (${formatDelta(d.overall.durationDeltaMs)})`,
  ];

  if (
    d.outcomes.flipped.length > 0 ||
    d.outcomes.addedInB.length > 0 ||
    d.outcomes.removedInB.length > 0
  ) {
    lines.push("", "## Outcomes");
    for (const f of d.outcomes.flipped) {
      const arrow = arrowFor(f.from, f.to);
      lines.push(`- ${arrow} ${f.id} (${f.from} → ${f.to})`);
    }
    for (const id of d.outcomes.addedInB) {
      lines.push(`- + ${id} (new in B)`);
    }
    for (const id of d.outcomes.removedInB) {
      lines.push(`- − ${id} (removed in B)`);
    }
  }

  if (d.steps.flipped.length > 0 || d.steps.slowdowns.length > 0) {
    lines.push("", "## Steps");
    for (const f of d.steps.flipped) {
      const arrow = arrowFor(f.from, f.to);
      lines.push(`- ${arrow} ${f.id} (${f.from} → ${f.to})`);
    }
    for (const s of d.steps.slowdowns) {
      lines.push(
        `- ⏳ ${s.id}: ${formatMs(s.fromMs)} → ${formatMs(s.toMs)} (${s.factor}× slower, +${formatMs(s.deltaMs)})`,
      );
    }
  }

  if (d.console.errorCountDelta !== 0 || d.console.newErrors.length > 0) {
    lines.push("", "## Console");
    lines.push(
      `- Errors: ${formatCountDelta(d.console.errorCountDelta)} (${d.console.newErrors.length} new)`,
    );
    for (const e of d.console.newErrors.slice(0, 5)) {
      lines.push(`  - [${e.type}] ${truncate(e.text, 200)}`);
    }
    if (d.console.newErrors.length > 5) {
      lines.push(`  - …${d.console.newErrors.length - 5} more`);
    }
  }

  if (d.network.failureCountDelta !== 0 || d.network.newFailures.length > 0) {
    lines.push("", "## Network");
    lines.push(
      `- Failures: ${formatCountDelta(d.network.failureCountDelta)} (${d.network.newFailures.length} new)`,
    );
    for (const f of d.network.newFailures.slice(0, 10)) {
      lines.push(`  - ${f.method} ${f.url} → ${f.status ?? "?"}`);
    }
    if (d.network.newFailures.length > 10) {
      lines.push(`  - …${d.network.newFailures.length - 10} more`);
    }
  }

  return lines.join("\n");
}

function arrowFor(from: string, to: string): string {
  if (from === "passed" && to === "failed") return "✓→✗";
  if (from === "failed" && to === "passed") return "✗→✓";
  if (to === "skipped") return "·→·";
  return "→";
}

function shortId(id: string): string {
  // Run ids are long; show the trailing 6-hex suffix when available.
  const m = /_([a-f0-9]{6})$/.exec(id);
  return m ? m[1]! : id;
}

function formatMs(ms: number): string {
  if (Math.abs(ms) < 1000) return `${Math.round(ms)}ms`;
  if (Math.abs(ms) < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatDelta(ms: number): string {
  const sign = ms >= 0 ? "+" : "−";
  return `${sign}${formatMs(Math.abs(ms))}`;
}

function formatCountDelta(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
