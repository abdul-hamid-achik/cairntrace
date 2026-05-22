import type { OutcomeStatus } from "../schema/shared";

/**
 * Evidence-file shape and budget per plan §13b.
 * Hard caps: ≤80 lines, ≤20 items per list, ≤1 inline screenshot/snapshot path.
 * Deeper data goes to outcomes/<id>.raw.json.
 */
export interface EvidenceInput {
  outcomeId: string;
  status: OutcomeStatus;
  /** From the spec's outcome description field. */
  description: string;
  /** Short, concrete; what the verifier was looking for. */
  expected: string;
  /** What was observed; this string may contain a multi-line bullet list. */
  actual: string;
  source: {
    lastSuccessfulStep?: string;
    /** Relative paths inside the run dir. */
    screenshot?: string;
    snapshot?: string;
    diagnostics?: string;
    downloads?: Record<string, string>;
    trace?: string;
  };
  /** When present, a sidecar .raw.json is written too. */
  raw?: unknown;
  /** Optional extra reason (one line). */
  whyThisMatters?: string;
}

export const MAX_LINES = 80;
export const MAX_LIST_ITEMS = 20;

export function renderEvidenceMarkdown(input: EvidenceInput): string {
  const sourceLines: string[] = [];
  if (input.source.lastSuccessfulStep) {
    sourceLines.push(
      `- last successful step: ${input.source.lastSuccessfulStep}`,
    );
  }
  if (input.source.screenshot) {
    sourceLines.push(`- screenshot: ${input.source.screenshot}`);
  }
  if (input.source.snapshot) {
    sourceLines.push(`- snapshot: ${input.source.snapshot}`);
  }
  if (input.source.diagnostics) {
    sourceLines.push(`- diagnostics: ${input.source.diagnostics}`);
  }
  if (input.source.downloads) {
    for (const [name, path] of Object.entries(input.source.downloads)) {
      sourceLines.push(`- download ${name}: ${path}`);
    }
  }
  if (input.source.trace) {
    sourceLines.push(`- trace: ${input.source.trace}`);
  }
  if (input.raw !== undefined) {
    sourceLines.push(`- raw evidence: outcomes/${input.outcomeId}.raw.json`);
  }

  const all = [
    `# Outcome: ${input.outcomeId}`,
    `**Status:** ${input.status}`,
    `**Description:** ${input.description}`,
    "",
    "## Expected",
    input.expected,
    "",
    "## Actual",
    capListItems(input.actual, MAX_LIST_ITEMS),
    "",
    "## Source",
    sourceLines.length > 0
      ? sourceLines.join("\n")
      : "- (no source artifacts captured for this run)",
    "",
    "## Why this matters",
    input.whyThisMatters ?? input.description,
  ];

  return enforceLineCap(all.join("\n")) + "\n";
}

/**
 * If the `actual` block contains a leading bullet list with more than max items,
 * truncate it with a "…N more" footnote.
 */
function capListItems(text: string, max: number): string {
  const lines = text.split("\n");
  const bulletLines = lines.filter((l) => l.startsWith("- "));
  if (bulletLines.length <= max) return text;

  const result: string[] = [];
  let kept = 0;
  for (const line of lines) {
    if (line.startsWith("- ")) {
      if (kept < max) {
        result.push(line);
        kept++;
      }
    } else {
      result.push(line);
    }
  }
  const extra = bulletLines.length - max;
  result.push(
    `- …${extra} more item${extra === 1 ? "" : "s"} (see raw evidence sidecar)`,
  );
  return result.join("\n");
}

function enforceLineCap(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES) return text;
  const kept = lines.slice(0, MAX_LINES - 1);
  kept.push(
    `<!-- evidence truncated at ${MAX_LINES} lines; see raw evidence if available -->`,
  );
  return kept.join("\n");
}
