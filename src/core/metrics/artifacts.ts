import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  METRICS_SCHEMA_ID,
  MetricsDocumentSchema,
  type MetricResult,
  type MetricsDocument,
} from "../schema/metrics.v1";

/**
 * Where the metrics land: `<dir>/metrics.json` (the full rows) and, for a
 * run directory, the flat numerics in `diagnostics/report.json` that
 * `cairn stats --metric <name>.delta` reads.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const METRICS_FILE = "metrics.json";

async function atomicWrite(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: FILE_MODE });
  await rename(temp, path);
}

async function readDocument(
  path: string,
): Promise<MetricsDocument | undefined> {
  try {
    const parsed = MetricsDocumentSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const rowKey = (row: MetricResult): string =>
  `${row.scope}\u0000${row.name}\u0000${row.iteration ?? ""}`;

/**
 * Write (or merge into) `<dir>/metrics.json`: a row replaces an earlier one
 * of the same scope, name and iteration, other rows are kept. `redact`
 * scrubs the document first. Returns the merged rows.
 */
export async function writeMetricsFile(
  dir: string,
  rows: readonly MetricResult[],
  identity: {
    runId?: string;
    invocationId?: string;
    environment?: string;
  },
  redact: (document: MetricsDocument) => MetricsDocument = (d) => d,
): Promise<MetricResult[]> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const path = join(dir, METRICS_FILE);
  const existing = await readDocument(path);
  const incoming = new Set(rows.map(rowKey));
  const merged = [
    ...(existing?.metrics ?? []).filter((row) => !incoming.has(rowKey(row))),
    ...rows,
  ];
  const document: MetricsDocument = {
    $schema: METRICS_SCHEMA_ID,
    version: "1",
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.invocationId ? { invocationId: identity.invocationId } : {}),
    ...(identity.environment ? { environment: identity.environment } : {}),
    metrics: merged,
  };
  await atomicWrite(path, `${JSON.stringify(redact(document), null, 2)}\n`);
  return merged;
}

/** The flat report keys of one row: `<name>.before|after|delta|min|max|mean`. */
export function reportKeysOf(row: MetricResult): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (suffix: string, value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value)) {
      out[`${row.name}.${suffix}`] = value;
    }
  };
  put("before", row.before?.value);
  put("after", row.after?.value);
  put("delta", row.delta);
  put("min", row.series?.min);
  put("max", row.series?.max);
  put("mean", row.series?.mean);
  return out;
}

/**
 * Merge the rows' flat numerics into `<runDir>/diagnostics/report.json`,
 * keeping every other field (an `--after` collector may have written it).
 * A report that is not a JSON object is left alone: returns false.
 */
export async function mergeReportMetrics(
  runDir: string,
  rows: readonly MetricResult[],
): Promise<boolean> {
  const keys = Object.assign({}, ...rows.map(reportKeysOf)) as Record<
    string,
    number
  >;
  if (Object.keys(keys).length === 0) return true;
  const diagnostics = join(runDir, "diagnostics");
  const path = join(diagnostics, "report.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  await mkdir(diagnostics, { recursive: true, mode: DIR_MODE });
  await atomicWrite(
    path,
    `${JSON.stringify({ ...current, ...keys }, null, 2)}\n`,
  );
  return true;
}
