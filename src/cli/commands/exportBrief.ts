import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import {
  exportBrief,
  isBriefSecretEnvKey,
  redactBriefDocument,
  renderBriefMarkdown,
  type ExportBriefOptions,
} from "../../core/exporters/briefExporter";
import { parseSpec } from "../../core/parser/parseSpec";
import type { BriefDocument } from "../../core/schema/brief.v1";
import { RunResultSchema } from "../../core/schema/run.v1";
import { emit, resolveFormat } from "../format";
import {
  listRunDirsNewestFirst,
  resolveArtifactRoot,
  resolveRunRef,
} from "../runRefs";
import { expandSpecArgs, parseVarFlags } from "./run";

export interface ExportBriefCliOptions {
  out?: string;
  outDir?: string;
  stdout?: boolean;
  fromRun?: string;
  config?: string;
  env?: string;
  var?: string[];
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  artifactRoot?: string;
}

export interface ExportBriefFileReport {
  source: string;
  path: string;
  name: string;
  coverage: BriefDocument["coverage"];
  status: "written" | "partial";
}

export interface ExportBriefReport {
  status: "written" | "partial" | "error";
  files: ExportBriefFileReport[];
  summary: { written: number; partial: number; failed: number };
  error?: string;
}

export async function exportOneBrief(
  specPath: string,
  opts: ExportBriefCliOptions,
): Promise<{ document: BriefDocument; markdown: string }> {
  const varOverrides = parseVarFlags(opts.var);
  const safeEnv = briefSafeEnv(process.env);
  const runtime = await resolveSpecRuntimeContext(specPath, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(varOverrides).length > 0 ? { vars: varOverrides } : {}),
    env: safeEnv,
    envRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
  });
  const parsed = await parseSpec(specPath, {
    vars: runtime.vars,
    env: safeEnv,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
    runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
  });
  const fromRun = opts.fromRun
    ? await loadFromRun(opts.fromRun, opts, {
        name: parsed.spec.name,
        path: resolve(specPath),
      })
    : undefined;
  const compiled = exportBrief(parsed.resolved, {
    specPath: resolve(specPath),
    ...(fromRun ? { fromRun } : {}),
  });
  const document = redactBriefDocument(compiled, process.env);
  return { document, markdown: renderBriefMarkdown(document) };
}

function briefSafeEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(out)) {
    if (isBriefSecretEnvKey(key)) out[key] = undefined;
  }
  return out;
}

function specMatchesRun(
  run: { spec: { name: string; path: string }; status: string },
  expected: { name: string; path: string },
): boolean {
  if (resolve(run.spec.path) === resolve(expected.path)) return true;
  return run.spec.name === expected.name;
}

async function readRunJson(runDir: string) {
  const raw = await readFile(resolve(runDir, "run.json"), "utf8").catch(() => {
    throw new Error(`cairn export brief: run.json missing in ${runDir}`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `cairn export brief: run.json is not valid JSON in ${runDir}`,
    );
  }
  const result = RunResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`cairn export brief: run.json failed schema in ${runDir}`);
  }
  return result.data;
}

async function loadFromRun(
  ref: string,
  opts: ExportBriefCliOptions,
  expectedSpec: { name: string; path: string },
): Promise<NonNullable<ExportBriefOptions["fromRun"]>> {
  const artifactRoot = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  if (ref === "latest" || ref === "previous") {
    const dirs = await listRunDirsNewestFirst(artifactRoot);
    const matches: string[] = [];
    for (const dir of dirs) {
      const run = await readRunJson(dir).catch(() => undefined);
      if (!run) continue;
      if (run.status !== "passed") continue;
      if (!specMatchesRun(run, expectedSpec)) continue;
      matches.push(dir);
    }
    const slot = ref === "latest" ? 0 : 1;
    const runDir = matches[slot];
    if (!runDir) {
      throw new Error(
        `cairn export brief: no passed run for spec ${expectedSpec.name} at slot ${ref}`,
      );
    }
    const run = await readRunJson(runDir);
    return { runId: run.runId, runDir, steps: run.steps };
  }

  const runDir = await resolveRunRef(ref, artifactRoot);
  const run = await readRunJson(runDir);
  if (!specMatchesRun(run, expectedSpec)) {
    throw new Error(
      `cairn export brief: run ${run.runId} is for spec ${run.spec.name}, not ${expectedSpec.name}`,
    );
  }
  return {
    runId: run.runId,
    runDir,
    steps: run.steps,
  };
}

export async function exportBriefCommand(
  specPath: string,
  opts: ExportBriefCliOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const paths = await expandSpecArgs([specPath]);
  if (paths.length === 0) {
    process.stderr.write(`cairn export brief: no specs found at ${specPath}\n`);
    process.exit(2);
  }

  if (opts.stdout) {
    if (paths.length !== 1) {
      process.stderr.write(
        "cairn export brief: --stdout requires a single spec file\n",
      );
      process.exit(2);
    }
    try {
      const { document, markdown } = await exportOneBrief(paths[0]!, opts);
      process.stdout.write(
        format === "md" ? markdown : emit(format, document, () => markdown),
      );
    } catch (e) {
      process.stderr.write(`cairn export brief: ${(e as Error).message}\n`);
      process.exit(2);
    }
    return;
  }

  if (paths.length > 1 && !opts.outDir) {
    process.stderr.write(
      "cairn export brief: directory/batch export requires --out-dir <dir>\n",
    );
    process.exit(2);
  }
  if (opts.out && paths.length > 1) {
    process.stderr.write(
      "cairn export brief: --out is for a single spec; use --out-dir for batch\n",
    );
    process.exit(2);
  }

  const files: ExportBriefFileReport[] = [];
  let failed = 0;
  for (const p of paths) {
    try {
      const { document, markdown } = await exportOneBrief(p, opts);
      const outPath = resolveOutPath(p, document.spec.name, format, opts);
      await mkdir(dirname(outPath), { recursive: true });
      const body =
        format === "md" ? markdown : emit(format, document, () => markdown);
      await writeFile(outPath, body);
      const status: "written" | "partial" =
        document.coverage.skips.length > 0 ? "partial" : "written";
      files.push({
        source: resolve(p),
        path: outPath,
        name: document.spec.name,
        coverage: document.coverage,
        status,
      });
    } catch (e) {
      failed += 1;
      process.stderr.write(
        `cairn export brief: ${p}: ${(e as Error).message}\n`,
      );
    }
  }

  if (files.length === 0) {
    process.exit(failed > 0 ? 4 : 2);
  }

  const partial = files.filter((f) => f.status === "partial").length;
  const written = files.filter((f) => f.status === "written").length;
  const report: ExportBriefReport = {
    status: failed > 0 ? "error" : partial > 0 ? "partial" : "written",
    files,
    summary: { written, partial, failed },
  };
  process.stdout.write(emit(format, report, reportToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function resolveOutPath(
  specPath: string,
  name: string,
  format: "json" | "yaml" | "md",
  opts: ExportBriefCliOptions,
): string {
  if (opts.out) {
    return isAbsolute(opts.out) ? opts.out : resolve(process.cwd(), opts.out);
  }
  const ext = format === "md" ? "md" : format === "yaml" ? "yaml" : "json";
  const file = `${name}.brief.${ext}`;
  if (opts.outDir) {
    const dir = isAbsolute(opts.outDir)
      ? opts.outDir
      : resolve(process.cwd(), opts.outDir);
    return resolve(dir, file);
  }
  return resolve(dirname(resolve(specPath)), file);
}

function reportToMarkdown(report: ExportBriefReport): string {
  const lines = [
    `# Export brief: ${report.status}`,
    "",
    `written ${report.summary.written}, partial ${report.summary.partial}, failed ${report.summary.failed}`,
    "",
  ];
  for (const file of report.files) {
    lines.push(
      `- ${file.name} → ${file.path} (${file.status}; ${file.coverage.stepsBriefed}/${file.coverage.steps} briefed)`,
    );
  }
  return lines.join("\n");
}
