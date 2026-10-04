import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { lintSpecs } from "../../core/authoring/lint";
import {
  importPlaywright,
  type ImportPlaywrightResult,
} from "../../core/importers/playwrightImporter";
import {
  importPlaywrightTrace,
  type ImportTraceResult,
  type TraceSummary,
} from "../../core/importers/playwrightTrace";
import type { ImportCoverage } from "../../core/importers/importCommon";
import type { Spec } from "../../core/schema/spec.v1";
import { emit, resolveFormat } from "../format";
import { verifySpec } from "./spec/verify";

export interface ImportPlaywrightOptions {
  out?: string;
  stdout?: boolean;
  force?: boolean;
  allowEmpty?: boolean;
  /** Title substring or 1-based index of the test to import. */
  test?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface ImportPlaywrightTraceOptions {
  out?: string;
  stdout?: boolean;
  force?: boolean;
  allowEmpty?: boolean;
  name?: string;
  intent?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/** What `cairn spec lint` and `cairn spec verify` still say about the written draft. */
export interface ImportCheck {
  lint: {
    errors: number;
    warnings: number;
    findings: Array<{
      rule: string;
      severity: "error" | "warning";
      message: string;
      where?: string;
    }>;
  };
  verify: { status: string; errors: string[]; warnings: string[] };
}

export interface ImportReport {
  /**
   * `refused`: nothing mapped to a step or an outcome, so no draft was
   * written (exit 1; `--allow-empty` writes it anyway).
   */
  status: "written" | "printed" | "refused";
  source: "playwright" | "playwright-trace";
  path?: string;
  name: string;
  coverage: ImportCoverage;
  /** Loud findings about the draft as a whole (low coverage, nothing mapped). */
  warnings: string[];
  todos: string[];
  approximations: string[];
  /** Trace imports: what the archive held. */
  trace?: TraceSummary & { secrets: string[] };
  /** Present when the spec was written: the lint/verify findings that remain. */
  check?: ImportCheck;
  /** The generated YAML (stdout mode and MCP). */
  yaml?: string;
}

export class ImportError extends Error {}

/** A draft with no step and only the placeholder outcome maps nothing. */
function isEmptyDraft(spec: Spec): boolean {
  return (
    (spec.steps ?? []).length === 0 &&
    spec.outcomes.every((o) => o.id === "todo_assertion")
  );
}

/** Coverage warnings for the report and stderr. */
function coverageWarnings(spec: Spec, coverage: ImportCoverage): string[] {
  const used = coverage.mapped + coverage.approximated;
  if (isEmptyDraft(spec)) {
    return [
      `nothing was mapped: ${coverage.unmapped} construct(s) looked at, no step or outcome came out (see the TODOs for why)`,
    ];
  }
  if (coverage.unmapped > used) {
    return [
      `low coverage: only ${used} of ${coverage.total} construct(s) mapped; ${coverage.unmapped} are TODOs`,
    ];
  }
  return [];
}

/** Write the draft unless it would overwrite a file (`--force`) or map nothing (`--allow-empty`). */
async function writeDraft(
  outPath: string,
  yaml: string,
  opts: { force?: boolean },
): Promise<void> {
  if (existsSync(outPath) && !opts.force) {
    throw new ImportError(
      `${outPath} already exists; pass --force to overwrite it or --out <file> to write elsewhere`,
    );
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, yaml);
}

function absolutize(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export async function runImportPlaywright(
  sourcePath: string,
  opts: {
    out?: string;
    stdout?: boolean;
    test?: string;
    includeYaml?: boolean;
    force?: boolean;
    allowEmpty?: boolean;
  },
): Promise<ImportReport> {
  let imported: ImportPlaywrightResult;
  try {
    const source = await readFile(sourcePath, "utf8");
    imported = importPlaywright(source, {
      sourcePath,
      ...(opts.test ? { test: opts.test } : {}),
    });
  } catch (e) {
    throw new ImportError((e as Error).message);
  }
  const base = {
    source: "playwright" as const,
    name: imported.spec.name,
    coverage: imported.coverage,
    warnings: coverageWarnings(imported.spec, imported.coverage),
    todos: imported.todos,
    approximations: imported.approximations,
  };
  if (isEmptyDraft(imported.spec) && !opts.allowEmpty) {
    return { status: "refused", ...base };
  }
  if (opts.stdout) {
    return { status: "printed", ...base, yaml: imported.yaml };
  }
  const outPath = opts.out
    ? absolutize(opts.out)
    : join(
        dirname(resolve(process.cwd(), sourcePath)),
        `${imported.spec.name}.yml`,
      );
  await writeDraft(outPath, imported.yaml, opts);
  return {
    status: "written",
    path: outPath,
    ...base,
    check: await checkWritten(outPath),
    ...(opts.includeYaml ? { yaml: imported.yaml } : {}),
  };
}

export async function runImportPlaywrightTrace(
  tracePath: string,
  opts: {
    out?: string;
    stdout?: boolean;
    name?: string;
    intent?: string;
    includeYaml?: boolean;
    force?: boolean;
    allowEmpty?: boolean;
  },
): Promise<ImportReport> {
  let imported: ImportTraceResult;
  try {
    const zip = await readFile(tracePath);
    imported = importPlaywrightTrace(zip, {
      sourceLabel: tracePath,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.intent ? { intent: opts.intent } : {}),
    });
  } catch (e) {
    throw new ImportError((e as Error).message);
  }
  const base = {
    source: "playwright-trace" as const,
    name: imported.spec.name,
    coverage: imported.coverage,
    warnings: coverageWarnings(imported.spec, imported.coverage),
    todos: imported.todos,
    approximations: imported.approximations,
    trace: { ...imported.summary, secrets: imported.secrets },
  };
  if (isEmptyDraft(imported.spec) && !opts.allowEmpty) {
    return { status: "refused", ...base };
  }
  if (opts.stdout) {
    return { status: "printed", ...base, yaml: imported.yaml };
  }
  const outPath = opts.out
    ? absolutize(opts.out)
    : join(process.cwd(), `${imported.spec.name}.yml`);
  await writeDraft(outPath, imported.yaml, opts);
  return {
    status: "written",
    path: outPath,
    ...base,
    check: await checkWritten(outPath),
    ...(opts.includeYaml ? { yaml: imported.yaml } : {}),
  };
}

/** Lint + verify the written draft; report what remains instead of hiding it. */
async function checkWritten(path: string): Promise<ImportCheck> {
  const check: ImportCheck = {
    lint: { errors: 0, warnings: 0, findings: [] },
    verify: { status: "valid", errors: [], warnings: [] },
  };
  try {
    const lint = await lintSpecs([path], { cwd: dirname(path) });
    for (const file of lint.files) {
      for (const f of file.findings) {
        check.lint.findings.push({
          rule: f.rule,
          severity: f.severity,
          message: f.message,
          ...(f.where ? { where: f.where } : {}),
        });
      }
    }
    check.lint.errors = lint.summary.errors;
    check.lint.warnings = lint.summary.warnings;
  } catch (e) {
    check.lint.findings.push({
      rule: "config",
      severity: "error",
      message: `lint could not run: ${(e as Error).message}`,
    });
    check.lint.errors += 1;
  }
  try {
    const { result } = await verifySpec(path);
    check.verify.status = result.status;
    check.verify.errors = result.errors.map(describeFinding);
    check.verify.warnings = result.warnings.map(describeFinding);
  } catch (e) {
    check.verify.status = "error";
    check.verify.errors.push((e as Error).message);
  }
  return check;
}

function describeFinding(f: unknown): string {
  if (typeof f === "string") return f;
  const message = (f as { message?: unknown }).message;
  return typeof message === "string" ? message : JSON.stringify(f);
}

async function runAndPrint(
  command: string,
  opts: {
    format?: string;
    json?: boolean;
    yaml?: boolean;
    md?: boolean;
    stdout?: boolean;
  },
  run: () => Promise<ImportReport>,
): Promise<void> {
  let report: ImportReport;
  try {
    report = await run();
  } catch (e) {
    process.stderr.write(`cairn ${command}: ${(e as Error).message}\n`);
    process.exit(2);
  }
  for (const warning of report.warnings) {
    process.stderr.write(`cairn ${command}: WARNING ${warning}\n`);
  }
  if (report.status === "refused") {
    process.stderr.write(
      `cairn ${command}: no draft written (nothing mapped); pass --allow-empty to write the placeholder draft anyway\n`,
    );
  }
  if (opts.stdout && report.yaml) {
    process.stdout.write(report.yaml);
  } else {
    const format = resolveFormat(opts, "md");
    process.stdout.write(emit(format, report, toMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  }
  if (report.status === "refused") process.exitCode = 1;
}

export async function importPlaywrightCommand(
  sourcePath: string,
  opts: ImportPlaywrightOptions,
): Promise<void> {
  await runAndPrint("import playwright", opts, () =>
    runImportPlaywright(sourcePath, {
      ...(opts.out ? { out: opts.out } : {}),
      ...(opts.stdout ? { stdout: true } : {}),
      ...(opts.test ? { test: opts.test } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.allowEmpty ? { allowEmpty: true } : {}),
      includeYaml: Boolean(opts.stdout),
    }),
  );
}

export async function importPlaywrightTraceCommand(
  tracePath: string,
  opts: ImportPlaywrightTraceOptions,
): Promise<void> {
  await runAndPrint("import playwright-trace", opts, () =>
    runImportPlaywrightTrace(tracePath, {
      ...(opts.out ? { out: opts.out } : {}),
      ...(opts.stdout ? { stdout: true } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.intent ? { intent: opts.intent } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.allowEmpty ? { allowEmpty: true } : {}),
      includeYaml: Boolean(opts.stdout),
    }),
  );
}

export function toMarkdown(report: ImportReport): string {
  const title =
    report.source === "playwright-trace"
      ? "Import Playwright trace"
      : "Import Playwright";
  const lines = [`# ${title}: ${report.name}`, ""];
  if (report.path) lines.push(`Wrote ${report.path}`);
  if (report.status === "refused") {
    lines.push(
      "No draft written: nothing mapped. Pass --allow-empty to write the placeholder draft anyway.",
    );
  }
  for (const warning of report.warnings) lines.push(`**WARNING:** ${warning}`);
  const c = report.coverage;
  lines.push(
    "",
    `Coverage: ${c.mapped} mapped, ${c.approximated} approximated, ${c.unmapped} unmapped (of ${c.total}).`,
  );
  if (report.trace) {
    const t = report.trace;
    lines.push(
      `Trace: ${t.calls} call(s), ${t.readsIgnored} read(s) ignored, ${t.network.candidates} of ${t.network.responses} network response(s) kept as outcome candidates.` +
        (t.secrets.length > 0
          ? ` Secrets as placeholders: ${t.secrets.map((s) => `\${secrets.${s}}`).join(", ")}.`
          : ""),
    );
  }
  if (report.approximations.length > 0) {
    lines.push("", "## Approximated");
    for (const a of report.approximations.slice(0, 20)) lines.push(`- ${a}`);
    if (report.approximations.length > 20) {
      lines.push(`- ...and ${report.approximations.length - 20} more`);
    }
  }
  if (report.todos.length > 0) {
    lines.push("", "## TODO");
    for (const todo of report.todos.slice(0, 20)) lines.push(`- ${todo}`);
    if (report.todos.length > 20) {
      lines.push(`- ...and ${report.todos.length - 20} more`);
    }
  }
  if (report.check) {
    const { lint, verify } = report.check;
    lines.push(
      "",
      "## Remaining checks",
      `- lint: ${lint.errors} error(s), ${lint.warnings} warning(s)`,
    );
    for (const f of lint.findings.slice(0, 20)) {
      lines.push(
        `  - ${f.severity} ${f.rule}${
          f.where ? ` (${f.where})` : ""
        }: ${f.message}`,
      );
    }
    lines.push(`- verify: ${verify.status}`);
    for (const e of verify.errors.slice(0, 10)) lines.push(`  - error: ${e}`);
    for (const w of verify.warnings.slice(0, 10))
      lines.push(`  - warning: ${w}`);
  }
  return lines.join("\n");
}
