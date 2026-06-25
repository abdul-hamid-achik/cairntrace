import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emit, resolveFormat } from "../format";
import type { OutputFormat } from "../format";

/* ---------------------------------------------------------------------------
 * codemap annotate wrapper
 *
 * `codemap annotate <symbol> --source <label> --note <text> --data <json> --json`
 * returns an annotation object. If codemap isn't installed, we return a clear
 * error. We also support reading investigate.json from a run dir to auto-
 * annotate all code matches.
 * ------------------------------------------------------------------------- */

export interface AnnotateResult {
  symbol: string;
  source: string;
  note: string;
  data?: string;
  annotationId?: number;
  matched?: boolean;
  warning?: string;
  error?: string;
}

export interface AnnotateOptions {
  source?: string;
  note?: string;
  data?: string;
  from?: string;
  to?: string;
  path?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function isCodemapAvailable(): Promise<boolean> {
  try {
    const r = await execa("codemap", ["version"], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * `cairn annotate <symbol>` — pin a note and/or external data to a code symbol
 * via codemap. Also supports call-path annotations with --from and --to.
 *
 * Wraps `codemap annotate <symbol> --source <label> --note <text> --data <json> --json`.
 */
export async function annotateCommand(
  symbol: string,
  opts: AnnotateOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const source = opts.source ?? "cairntrace";
  const note = opts.note ?? "";

  if (!note && !opts.data) {
    process.stderr.write(
      "cairn annotate: nothing to attach — pass --note and/or --data\n",
    );
    process.exit(2);
  }

  const result: AnnotateResult = {
    symbol,
    source,
    note,
    ...(opts.data ? { data: opts.data } : {}),
  };

  const codemapOk = await isCodemapAvailable();
  if (!codemapOk) {
    result.error =
      "codemap not on $PATH. Install: brew install abdul-hamid-achik/tap/codemap";
    process.stderr.write(`cairn annotate: ${result.error}\n`);
    process.stdout.write(emit(format, result, () => annotateMarkdown(result)));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    return;
  }

  const args = ["annotate"];
  // Call-path annotation: --from X --to Y
  if (opts.from && opts.to) {
    args.push(opts.from, opts.to);
    result.symbol = `${opts.from} → ${opts.to}`;
  } else {
    args.push(symbol);
  }
  args.push("--source", source, "--note", note);
  if (opts.data) args.push("--data", opts.data);
  args.push("--json");

  try {
    const r = await execa("codemap", args, { reject: false, timeout: 30_000 });
    if (r.exitCode === 0) {
      const data = JSON.parse(r.stdout);
      result.annotationId = data.id ?? data.annotationId;
      result.matched = data.matched ?? true;
      if (data.warning) result.warning = data.warning;
    } else {
      result.error = r.stderr || "codemap annotate failed";
    }
  } catch (e) {
    result.error = (e as Error).message;
  }

  process.stdout.write(emit(format, result, () => annotateMarkdown(result)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function annotateMarkdown(r: AnnotateResult): string {
  const lines = [
    `# Annotation: ${r.symbol}`,
    "",
    `- source: ${r.source}`,
    ...(r.annotationId ? [`- annotationId: ${r.annotationId}`] : []),
    ...(r.matched === false
      ? [
          `- matched: false (symbol not indexed — annotation saved but won't surface until indexed)`,
        ]
      : []),
  ];
  if (r.note) lines.push("", "## Note", "", r.note);
  if (r.warning) lines.push("", "## Warning", "", r.warning);
  if (r.error) lines.push("", "## Error", "", r.error);
  return lines.join("\n");
}

/* ---------------------------------------------------------------------------
 * Auto-annotate from investigate.json
 *
 * Reads `investigate.json` from a run directory, annotates each code match
 * into codemap with the run's failure context.
 * ------------------------------------------------------------------------- */

export interface AutoAnnotateResult {
  runId: string;
  annotated: number;
  skipped: number;
  errors: string[];
}

export async function maybeAutoAnnotate(
  runDir: string,
  runId: string,
  opts: {
    autoAnnotate?: string;
    source?: string;
  },
): Promise<AutoAnnotateResult> {
  const result: AutoAnnotateResult = {
    runId,
    annotated: 0,
    skipped: 0,
    errors: [],
  };

  if (opts.autoAnnotate !== "on-investigate") return result;

  const investigatePath = join(runDir, "investigate.json");
  if (!existsSync(investigatePath)) {
    result.skipped = 1;
    return result;
  }

  const codemapOk = await isCodemapAvailable();
  if (!codemapOk) {
    result.errors.push("codemap not on $PATH");
    return result;
  }

  let investigateData: {
    codeMatches?: Array<{
      file: string;
      line: number;
      score: number;
      snippet?: string;
    }>;
  };
  try {
    investigateData = JSON.parse(readFileSync(investigatePath, "utf8"));
  } catch (e) {
    result.errors.push(
      `failed to read investigate.json: ${(e as Error).message}`,
    );
    return result;
  }

  const matches = investigateData.codeMatches ?? [];
  const source = opts.source ?? "cairntrace";

  for (const m of matches) {
    const symbol = `${m.file}:${m.line}`;
    const note = `cairntrace run ${runId} flagged this location (score: ${m.score.toFixed(2)})`;
    const data = JSON.stringify({
      runId,
      file: m.file,
      line: m.line,
      score: m.score,
      ...(m.snippet ? { snippet: m.snippet } : {}),
    });

    try {
      const r = await execa(
        "codemap",
        [
          "annotate",
          symbol,
          "--source",
          source,
          "--note",
          note,
          "--data",
          data,
          "--json",
        ],
        { reject: false, timeout: 10_000 },
      );
      if (r.exitCode === 0) {
        result.annotated++;
      } else {
        result.errors.push(
          `${symbol}: ${r.stderr || "codemap annotate failed"}`,
        );
      }
    } catch (e) {
      result.errors.push(`${symbol}: ${(e as Error).message}`);
    }
  }

  if (result.annotated > 0) {
    process.stderr.write(
      `cairn: auto-annotated ${result.annotated} code match(es) into codemap\n`,
    );
  }

  return result;
}

export type { OutputFormat };
