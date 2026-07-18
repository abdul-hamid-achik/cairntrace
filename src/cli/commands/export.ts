import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  exportExtension,
  exportPlaywright,
  type ExportCoverage,
  type ExportLang,
} from "../../core/exporters/playwrightExporter";
import { parseSpec } from "../../core/parser/parseSpec";
import { emit, resolveFormat } from "../format";
import { expandSpecArgs } from "./run";

export interface ExportPlaywrightOptions {
  out?: string;
  outDir?: string;
  lang?: string;
  /** Print source to stdout instead of writing a file (single-spec only). */
  stdout?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface ExportFileReport {
  source: string;
  path: string;
  name: string;
  coverage: ExportCoverage;
  status: "written" | "partial";
}

export interface ExportPlaywrightReport {
  status: "written" | "partial" | "error";
  lang: ExportLang;
  files: ExportFileReport[];
  summary: { written: number; partial: number; failed: number };
  error?: string;
}

/**
 * `cairn export playwright <spec|dir> [--out <file>] [--out-dir <dir>] [--lang js|ts]`
 *
 * Reads a spec (with `use:` imports expanded), generates a `@playwright/test`
 * .spec.ts|.spec.js file, and writes it (or pipes to stdout with `--stdout`).
 *
 * The generated file lives in your Playwright project — Cairntrace just
 * produces text; running the test requires `@playwright/test` separately.
 */
export async function exportPlaywrightCommand(
  specPath: string,
  opts: ExportPlaywrightOptions,
): Promise<void> {
  const lang = parseLang(opts.lang);
  const paths = await expandSpecArgs([specPath]);
  if (paths.length === 0) {
    process.stderr.write(
      `cairn export playwright: no specs found at ${specPath}\n`,
    );
    process.exit(2);
  }

  if (opts.stdout) {
    if (paths.length !== 1) {
      process.stderr.write(
        "cairn export playwright: --stdout requires a single spec file\n",
      );
      process.exit(2);
    }
    const result = await exportOne(paths[0]!, lang);
    process.stdout.write(result.source);
    return;
  }

  if (paths.length > 1 && !opts.outDir) {
    process.stderr.write(
      "cairn export playwright: directory/batch export requires --out-dir <dir>\n",
    );
    process.exit(2);
  }
  if (opts.out && paths.length > 1) {
    process.stderr.write(
      "cairn export playwright: --out is for a single spec; use --out-dir for batch\n",
    );
    process.exit(2);
  }

  const files: ExportFileReport[] = [];
  let failed = 0;
  for (const p of paths) {
    try {
      const exported = await exportOne(p, lang);
      const outPath = resolveOutPath(p, exported.name, lang, opts);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, exported.source);
      const status: "written" | "partial" =
        exported.coverage.skips.length > 0 ? "partial" : "written";
      files.push({
        source: resolve(p),
        path: outPath,
        name: exported.name,
        coverage: exported.coverage,
        status,
      });
    } catch (e) {
      failed += 1;
      process.stderr.write(
        `cairn export playwright: ${p}: ${(e as Error).message}\n`,
      );
    }
  }

  if (files.length === 0) {
    process.exit(failed > 0 ? 4 : 2);
  }

  const partial = files.filter((f) => f.status === "partial").length;
  const written = files.filter((f) => f.status === "written").length;
  const report: ExportPlaywrightReport = {
    status: failed > 0 ? "error" : partial > 0 ? "partial" : "written",
    lang,
    files,
    summary: { written, partial, failed },
  };

  const format = resolveFormat(opts, "md");
  process.stdout.write(emit(format, report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");

  if (failed > 0 && files.length === 0) process.exit(4);
}

async function exportOne(
  specPath: string,
  lang: ExportLang,
): Promise<{ source: string; name: string; coverage: ExportCoverage }> {
  let parsed;
  try {
    parsed = await parseSpec(specPath);
  } catch (e) {
    const err = new Error((e as Error).message);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  const result = exportPlaywright(parsed.resolved, {
    sourcePath: parsed.path,
    lang,
  });
  return {
    source: result.source,
    name: parsed.spec.name,
    coverage: result.coverage,
  };
}

function resolveOutPath(
  sourcePath: string,
  name: string,
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
): string {
  const ext = exportExtension(lang);
  if (opts.out) {
    return isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out);
  }
  if (opts.outDir) {
    const dir = isAbsolute(opts.outDir)
      ? opts.outDir
      : resolve(process.cwd(), opts.outDir);
    return join(dir, `${name}${ext}`);
  }
  const abs = isAbsolute(sourcePath)
    ? sourcePath
    : resolve(process.cwd(), sourcePath);
  return join(dirname(abs), `${name}${ext}`);
}

function parseLang(raw: string | undefined): ExportLang {
  if (!raw || raw === "ts" || raw === "typescript") return "ts";
  if (raw === "js" || raw === "javascript") return "js";
  process.stderr.write(
    `cairn export playwright: --lang must be js|ts (got ${JSON.stringify(raw)})\n`,
  );
  process.exit(2);
}

function toMarkdown(report: ExportPlaywrightReport): string {
  const lines = [
    `# Export Playwright (${report.lang})`,
    "",
    `Status: **${report.status}** — written ${report.summary.written}, partial ${report.summary.partial}, failed ${report.summary.failed}`,
    "",
  ];
  for (const f of report.files) {
    lines.push(
      `## ${f.name}`,
      "",
      `- source: \`${f.source}\``,
      `- out: \`${f.path}\``,
      `- coverage: steps ${f.coverage.stepsExported}/${f.coverage.stepsTotal}, outcomes ${f.coverage.outcomesExported}/${f.coverage.outcomesTotal}`,
    );
    if (f.coverage.skips.length > 0) {
      lines.push("", "### Skips");
      for (const s of f.coverage.skips.slice(0, 30)) {
        lines.push(`- [${s.kind}]${s.id ? ` ${s.id}` : ""}: ${s.reason}`);
      }
      if (f.coverage.skips.length > 30) {
        lines.push(`- …and ${f.coverage.skips.length - 30} more`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
