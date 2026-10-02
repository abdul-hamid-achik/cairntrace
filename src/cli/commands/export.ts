import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { computeContractHash } from "../../core/contractHash";
import {
  exportExtension,
  exportPlaywright,
  type ExportCoverage,
  type ExportLang,
} from "../../core/exporters/playwrightExporter";
import {
  buildExportManifest,
  diffExport,
  EXPORT_MANIFEST_FILE,
  readExportManifest,
  realpathNearest,
  varsDigest,
  writeGeneratedExport,
  type ExportCheckReport,
  type ExportManifestMode,
  type ExportManifestSpec,
  type ExportManifestV1,
  type GeneratedExportFile,
} from "../../core/exporters/exportManifest";
import type { ExportEnvTarget } from "../../core/exporters/requiresGuard";
import { LateBoundLeakError } from "../../core/exporters/templateValue";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import { parseSpec } from "../../core/parser/parseSpec";
import { emit, resolveFormat } from "../format";
import { CAIRN_VERSION } from "../version";
import { expandSpecArgs, parseVarFlags } from "./run";

export interface ExportPlaywrightOptions {
  /** Generate a structured project (actions/, verifiers/, config, setup). */
  project?: boolean;
  /**
   * Write actions/lib/tests/verifiers into an existing Playwright tree
   * without package.json / playwright.config / global-setup.
   */
  into?: string;
  out?: string;
  outDir?: string;
  lang?: string;
  /** Print source to stdout instead of writing a file (single-spec only). */
  stdout?: boolean;
  /** Explicit cairntrace.config.yml (auto-discovered from the spec dir when omitted). */
  config?: string;
  /** Config environment for var resolution. */
  env?: string;
  /** Repeatable `--var key=value` overrides; win over config env vars. */
  var?: string[];
  /**
   * Check an existing export dir against its `.cairn-export.json`: regenerate
   * in memory from the current sources and report stale/missing/orphaned
   * files. Writes nothing. Exit 0 fresh, 1 stale, 2 error
   * (`cairn export playwright [spec] --check <exportDir>`).
   */
  check?: string;
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
  /** Manifest written next to batch (`--out-dir`) exports. */
  manifest?: string;
  /** Specs that failed to export (also printed on stderr). */
  errors?: ExportSpecError[];
  error?: string;
}

export interface ExportSpecError {
  source: string;
  message: string;
}

export interface ExportProjectReport {
  status: "written";
  lang: ExportLang;
  outDir: string;
  /** Relative paths of generated files. */
  files: string[];
  verifiersCopied: string[];
  /** Upload fixtures copied into fixtures/ (paths rewritten in the tests). */
  fixturesCopied: string[];
  requiredEnv: string[];
  /** `.cairn-export.json` path (drift detection). */
  manifest: string;
  specs: Array<{ name: string; file: string; coverage: ExportCoverage }>;
}

/** Exit code for the export check when the export drifted from its sources. */
export const EXPORT_CHECK_STALE_EXIT = 1;

/**
 * `cairn export playwright <spec|dir> [--out <file>] [--out-dir <dir>] [--lang js|ts]`
 *
 * Reads a spec (with `use:` imports expanded), generates a `@playwright/test`
 * .spec.ts|.spec.js file, and writes it (or pipes to stdout with `--stdout`).
 * `opts.check` verifies an existing export instead of writing one.
 *
 * The generated file lives in your Playwright project — Cairntrace just
 * produces text; running the test requires `@playwright/test` separately.
 */
export async function exportPlaywrightCommand(
  specPath: string | undefined,
  opts: ExportPlaywrightOptions,
): Promise<void> {
  if (opts.check) {
    const { report, exitCode } = await checkPlaywrightExport(
      opts.check,
      specPath,
      opts,
    );
    const format = resolveFormat(opts, "md");
    process.stdout.write(emit(format, report, checkToMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    // exitCode (not process.exit) so a piped JSON report is fully flushed.
    process.exitCode = exitCode;
    return;
  }
  if (!specPath) {
    process.stderr.write(
      "cairn export playwright: a spec file or directory is required\n",
    );
    process.exit(2);
  }
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
    try {
      const result = await exportOne(paths[0]!, lang, opts);
      process.stdout.write(result.source);
    } catch (e) {
      process.stderr.write(
        `cairn export playwright: ${(e as Error).message}\n`,
      );
      process.exit(e instanceof LateBoundLeakError ? 2 : 4);
    }
    return;
  }

  if (opts.into && opts.project) {
    process.stderr.write(
      "cairn export playwright: use either --project or --into, not both\n",
    );
    process.exit(2);
  }

  if (opts.project || opts.into) {
    const dest = opts.into ?? opts.outDir;
    if (!dest) {
      process.stderr.write(
        opts.into
          ? "cairn export playwright: --into requires a directory\n"
          : "cairn export playwright: --project requires --out-dir <dir>\n",
      );
      process.exit(2);
    }
    let report: ExportProjectReport;
    try {
      report = await writeProjectExport(
        paths,
        lang,
        { ...opts, outDir: dest },
        specPath,
      );
    } catch (e) {
      process.stderr.write(
        `cairn export playwright: ${(e as Error).message}\n`,
      );
      process.exit(2);
    }
    const format = resolveFormat(opts, "md");
    process.stdout.write(emit(format, report, projectToMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
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

  const written = await writeBatchExport(paths, lang, opts, specPath);
  if (!written.report) {
    process.exit(written.leaked ? 2 : written.failed > 0 ? 4 : 2);
  }

  const format = resolveFormat(opts, "md");
  process.stdout.write(emit(format, written.report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");

  // A sentinel leak is an exporter defect, never a partial success.
  if (written.leaked) process.exit(2);
}

/**
 * Single-file / `--out-dir` batch export: write each spec file (+ README and
 * `.cairn-export.json` for `--out-dir`). `report` is undefined when nothing
 * could be exported.
 */
export async function writeBatchExport(
  paths: string[],
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
  inputPath: string,
): Promise<{
  report?: ExportPlaywrightReport;
  failed: number;
  leaked: boolean;
  errors: ExportSpecError[];
}> {
  const batch = await buildBatchExport(paths, lang, opts);
  const files = batch.entries.map((entry) => entry.report);
  for (const file of batch.generated) {
    await mkdir(dirname(file.relPath), { recursive: true });
    await writeFile(file.relPath, file.content);
  }
  let manifestPath: string | undefined;
  if (opts.outDir && batch.entries.length > 0) {
    const outDir = absoluteFrom(opts.outDir);
    await writeGeneratedExport(
      outDir,
      [],
      buildExportManifest({
        exporterVersion: CAIRN_VERSION,
        mode: "files",
        lang,
        source: manifestSource(outDir, inputPath, opts),
        specs: batch.specs.map((spec) => ({
          ...spec,
          spec: posixRelative(outDir, spec.spec),
          testFile: posixRelative(outDir, spec.testFile),
        })),
        files: batch.generated.map((file) => ({
          ...file,
          relPath: posixRelative(outDir, file.relPath),
        })),
      }),
    );
    manifestPath = join(outDir, EXPORT_MANIFEST_FILE);
  }
  if (files.length === 0) {
    return { failed: batch.failed, leaked: batch.leaked, errors: batch.errors };
  }
  const partial = files.filter((f) => f.status === "partial").length;
  const written = files.filter((f) => f.status === "written").length;
  return {
    report: {
      status: batch.failed > 0 ? "error" : partial > 0 ? "partial" : "written",
      lang,
      files,
      summary: { written, partial, failed: batch.failed },
      ...(manifestPath ? { manifest: manifestPath } : {}),
      ...(batch.errors.length > 0 ? { errors: batch.errors } : {}),
    },
    failed: batch.failed,
    leaked: batch.leaked,
    errors: batch.errors,
  };
}

interface BatchExport {
  entries: Array<{ report: ExportFileReport }>;
  /** Files to write; relPath is ABSOLUTE here (batch outputs may be anywhere). */
  generated: GeneratedExportFile[];
  specs: ExportManifestSpec[];
  failed: number;
  leaked: boolean;
  errors: ExportSpecError[];
}

/** Render every batch/single-file export in memory (shared by write + check). */
async function buildBatchExport(
  paths: string[],
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
): Promise<BatchExport> {
  const entries: BatchExport["entries"] = [];
  const generated: GeneratedExportFile[] = [];
  const specs: ExportManifestSpec[] = [];
  const readmeInfo: Array<{
    name: string;
    file: string;
    requiredEnv: string[];
    preconditions: string[];
  }> = [];
  let failed = 0;
  let leaked = false;
  const errors: ExportSpecError[] = [];
  for (const p of paths) {
    try {
      const exported = await exportOne(p, lang, opts);
      const outPath =
        exported.outPath ?? resolveOutPath(p, exported.name, lang, opts);
      generated.push({ relPath: outPath, content: exported.source });
      const status: "written" | "partial" =
        exported.coverage.skips.length > 0 ? "partial" : "written";
      entries.push({
        report: {
          source: resolve(p),
          path: outPath,
          name: exported.name,
          coverage: exported.coverage,
          status,
        },
      });
      specs.push({
        spec: resolve(p),
        contractHash: exported.contractHash,
        testFile: outPath,
        sourceDigest: exported.sourceDigest,
      });
      readmeInfo.push({
        name: exported.name,
        file: outPath.split("/").pop() ?? outPath,
        requiredEnv: exported.requiredEnv,
        preconditions: exported.preconditions,
      });
    } catch (e) {
      failed += 1;
      if (e instanceof LateBoundLeakError) leaked = true;
      errors.push({ source: resolve(p), message: (e as Error).message });
      process.stderr.write(
        `cairn export playwright: ${p}: ${(e as Error).message}\n`,
      );
    }
  }
  // A generated suite must carry its own operating manual: which env vars to
  // provide (from ANY secret source - no cairn/tvault dependency), which
  // preconditions to wire into globalSetup, and how to run. Written on every
  // batch export so it stays in sync with the tests.
  if (opts.outDir && readmeInfo.length > 0) {
    generated.push({
      relPath: join(absoluteFrom(opts.outDir), "README.md"),
      content: renderReadme(readmeInfo),
    });
  }
  return { entries, generated, specs, failed, leaked, errors };
}

export async function parseForExport(
  specPath: string,
  opts: Pick<ExportPlaywrightOptions, "env" | "config" | "var">,
): Promise<{
  parsed: Awaited<ReturnType<typeof parseSpec>>;
  baseUrl?: string;
  /** The environment `baseUrl` belongs to (the export bakes it in). */
  envTarget?: ExportEnvTarget;
  projectRoot?: string;
  /** `${config.dir}`: the resolved config's directory (cwd without one). */
  configDir: string;
  testIdAttribute?: string;
  viewport?: { width: number; height: number };
}> {
  const varOverrides = parseVarFlags(opts.var);
  const runtime = await resolveSpecRuntimeContext(specPath, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(varOverrides).length > 0 ? { vars: varOverrides } : {}),
    envRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
  });
  const parsed = await parseSpec(specPath, {
    vars: runtime.vars,
    configDir: runtime.configDir,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
    runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
  });
  const viewport = parsed.spec.viewport ?? runtime.viewport;
  const envPolicy = runtime.config?.environments[runtime.envName]?.policy;
  return {
    parsed,
    configDir: runtime.configDir,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.baseUrl
      ? {
          envTarget: {
            env: runtime.envName,
            ...(envPolicy ? { policy: envPolicy } : {}),
          },
        }
      : {}),
    ...(runtime.configPath ? { projectRoot: dirname(runtime.configPath) } : {}),
    ...(runtime.config?.browser?.testIdAttribute
      ? { testIdAttribute: runtime.config.browser.testIdAttribute }
      : {}),
    ...(viewport ? { viewport } : {}),
  };
}

export interface BuiltProjectExport {
  outDir: string;
  result: import("../../core/exporters/playwrightProject").ProjectExportResult;
  /** Generated + copied files (verifiers, evals, fixtures), relative to outDir. */
  generated: GeneratedExportFile[];
  manifest: ExportManifestV1;
}

/**
 * Render a `--project` / `--into` export fully in memory: generated sources
 * plus copied verifiers, eval files, and upload fixtures, and the manifest
 * that describes them. Shared by the writer and by the export check.
 */
export async function buildProjectExport(
  paths: string[],
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
  inputPath: string,
): Promise<BuiltProjectExport> {
  const { exportPlaywrightProject } = await import(
    "../../core/exporters/playwrightProject"
  );
  const outDir = absoluteFrom(opts.outDir!);

  const parsedSpecs = [];
  let baseUrl: string | undefined;
  let envTarget: ExportEnvTarget | undefined;
  let projectRoot: string | undefined;
  let configDir: string | undefined;
  let testIdAttribute: string | undefined;
  let viewport: { width: number; height: number } | undefined;
  for (const p of paths) {
    const r = await parseForExport(p, opts);
    parsedSpecs.push(r.parsed);
    // The baked baseURL and the environment it belongs to come together.
    if (baseUrl === undefined && r.baseUrl !== undefined) {
      envTarget = r.envTarget;
    }
    baseUrl = baseUrl ?? r.baseUrl;
    projectRoot = projectRoot ?? r.projectRoot;
    configDir = configDir ?? r.configDir;
    testIdAttribute = testIdAttribute ?? r.testIdAttribute;
    viewport = viewport ?? r.viewport;
  }

  const absInput = absoluteFrom(inputPath);
  const sourceRoot = (await stat(absInput)).isDirectory()
    ? absInput
    : dirname(absInput);
  // Without a cairntrace.config.yml the export INPUT is the project root, so
  // every spec below it (not just the first one's folder) stays relative.
  projectRoot = projectRoot ?? sourceRoot;

  const result = exportPlaywrightProject(parsedSpecs, {
    lang,
    outDir,
    sourceRoot,
    projectRoot,
    ...(configDir ? { configDir } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(envTarget ? { envTarget } : {}),
    ...(testIdAttribute ? { testIdAttribute } : {}),
    ...(viewport ? { viewport } : {}),
    ...(opts.into ? { into: true } : {}),
    copyFixtures: true,
    writesManifest: true,
  });

  const generated: GeneratedExportFile[] = result.files.map((f) => ({
    relPath: f.relPath,
    content: f.source,
  }));
  // Self-contained project: copy referenced node verifiers, eval sources, and
  // upload fixtures (binary-safe) in.
  for (const v of [...result.verifierFiles, ...result.evalFiles]) {
    generated.push({
      relPath: v.relPath,
      content: await readFile(v.sourcePath, "utf8"),
    });
  }
  for (const fixture of result.fixtureFiles) {
    generated.push({
      relPath: fixture.relPath,
      content: await readFile(fixture.sourcePath),
    });
  }

  const mode: ExportManifestMode = opts.into ? "into" : "project";
  const manifest = buildExportManifest({
    exporterVersion: CAIRN_VERSION,
    mode,
    lang,
    source: manifestSource(outDir, inputPath, opts),
    specs: result.specs.map((spec) => ({
      spec: posixRelative(outDir, spec.sourcePath),
      contractHash: spec.contractHash,
      testFile: spec.file,
      sourceDigest: spec.sourceDigest,
    })),
    files: generated,
  });
  return { outDir, result, generated, manifest };
}

export async function writeProjectExport(
  paths: string[],
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
  inputPath: string,
): Promise<ExportProjectReport> {
  const built = await buildProjectExport(paths, lang, opts, inputPath);
  await writeGeneratedExport(built.outDir, built.generated, built.manifest);
  const { result } = built;
  return {
    status: "written",
    lang,
    outDir: built.outDir,
    files: result.files.map((f) => f.relPath),
    verifiersCopied: result.verifierFiles.map((v) => v.relPath),
    fixturesCopied: result.fixtureFiles.map((v) => v.relPath),
    requiredEnv: result.requiredEnv,
    manifest: join(built.outDir, EXPORT_MANIFEST_FILE),
    specs: result.specs.map((s) => ({
      name: s.name,
      file: s.file,
      coverage: s.coverage,
    })),
  };
}

/**
 * Export check: regenerate the export described by its manifest in
 * memory and diff it against disk. `specPath` (when given) overrides the
 * manifest's recorded input. Never writes.
 */
export async function checkPlaywrightExport(
  exportDir: string,
  specPath: string | undefined,
  opts: ExportPlaywrightOptions,
): Promise<{ report: ExportCheckReport; exitCode: number }> {
  const dir = realpathNearest(absoluteFrom(exportDir));
  const errorReport = (message: string): ExportCheckReport => ({
    status: "error",
    exportDir: dir,
    exporterVersion: CAIRN_VERSION,
    files: { checked: 0, stale: [], missing: [], orphaned: [], modified: [] },
    specs: [],
    warnings: [],
    error: message,
  });
  let manifest: ExportManifestV1;
  try {
    manifest = readExportManifest(dir);
  } catch (e) {
    return { report: errorReport((e as Error).message), exitCode: 2 };
  }
  const input = specPath ?? resolve(dir, manifest.source.input);
  const checkOpts: ExportPlaywrightOptions = {
    ...opts,
    ...(opts.config === undefined && manifest.source.config
      ? { config: resolve(dir, manifest.source.config) }
      : {}),
    ...(opts.env === undefined && manifest.source.env
      ? { env: manifest.source.env }
      : {}),
  };
  const warnings: string[] = [];
  const suppliedDigest = varsDigest(parseVarFlags(opts.var));
  if (suppliedDigest !== manifest.source.varsDigest) {
    warnings.push(
      manifest.source.varKeys.length > 0
        ? `export used --var ${manifest.source.varKeys.join(", ")}; pass the same --var values when checking or files may report stale`
        : `--var overrides differ from the export (which used none)`,
    );
  }
  const lang = manifest.lang;
  try {
    const paths = await expandSpecArgs([input]);
    if (manifest.mode === "files") {
      const batch = await buildBatchExport(paths, lang, {
        ...checkOpts,
        outDir: dir,
      });
      const report = diffExport({
        exportDir: dir,
        exporterVersion: CAIRN_VERSION,
        previous: manifest,
        expectedFiles: batch.generated.map((file) => ({
          ...file,
          relPath: posixRelative(dir, file.relPath),
        })),
        expectedSpecs: batch.specs.map((spec) => ({
          ...spec,
          spec: posixRelative(dir, spec.spec),
          testFile: posixRelative(dir, spec.testFile),
        })),
        warnings,
      });
      if (batch.failed > 0) {
        report.warnings.push(
          `${batch.failed} spec(s) failed to export; see stderr`,
        );
      }
      return {
        report,
        exitCode: report.status === "fresh" ? 0 : EXPORT_CHECK_STALE_EXIT,
      };
    }
    const built = await buildProjectExport(
      paths,
      lang,
      {
        ...checkOpts,
        outDir: dir,
        ...(manifest.mode === "into" ? { into: dir } : { project: true }),
      },
      input,
    );
    const report = diffExport({
      exportDir: dir,
      exporterVersion: CAIRN_VERSION,
      previous: manifest,
      expectedFiles: built.generated,
      expectedSpecs: built.manifest.specs,
      warnings,
    });
    return {
      report,
      exitCode: report.status === "fresh" ? 0 : EXPORT_CHECK_STALE_EXIT,
    };
  } catch (e) {
    return { report: errorReport((e as Error).message), exitCode: 2 };
  }
}

function manifestSource(
  outDir: string,
  inputPath: string,
  opts: ExportPlaywrightOptions,
): ExportManifestV1["source"] {
  const vars = parseVarFlags(opts.var);
  const digest = varsDigest(vars);
  return {
    input: posixRelative(outDir, absoluteFrom(inputPath)),
    ...(opts.config
      ? { config: posixRelative(outDir, absoluteFrom(opts.config)) }
      : {}),
    ...(opts.env ? { env: opts.env } : {}),
    varKeys: Object.keys(vars).toSorted(),
    ...(digest ? { varsDigest: digest } : {}),
  };
}

function absoluteFrom(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function posixRelative(from: string, to: string): string {
  return (
    relative(realpathNearest(from), realpathNearest(to)).split(sep).join("/") ||
    "."
  );
}

async function exportOne(
  specPath: string,
  lang: ExportLang,
  opts: ExportPlaywrightOptions = {},
): Promise<{
  source: string;
  name: string;
  coverage: ExportCoverage;
  requiredEnv: string[];
  preconditions: string[];
  contractHash: string;
  sourceDigest: string;
  outPath?: string;
}> {
  let parsed;
  let envTarget: ExportEnvTarget | undefined;
  try {
    ({ parsed, envTarget } = await parseForExport(specPath, opts));
  } catch (e) {
    const err = new Error((e as Error).message);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  // Out path is derived from the PARSED name, so it must be computed before
  // rendering: the exporter emits verifier imports relative to it.
  const outPath = opts.stdout
    ? undefined
    : resolveOutPath(specPath, parsed.spec.name, lang, opts);
  const result = exportPlaywright(parsed.resolved, {
    sourcePath: parsed.path,
    lang,
    ...(outPath ? { outPath } : {}),
    // F13: an imported action's eval.file / upload.path resolve like a run.
    stepOrigins: parsed,
    ...(envTarget ? { envTarget } : {}),
  });
  const { specSourceDigest } = await import(
    "../../core/exporters/playwrightProject"
  );
  return {
    source: result.source,
    name: parsed.spec.name,
    coverage: result.coverage,
    requiredEnv: result.requiredEnv,
    preconditions: result.preconditions,
    contractHash: computeContractHash(parsed.spec),
    sourceDigest: specSourceDigest(parsed),
    ...(outPath ? { outPath } : {}),
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

function renderReadme(
  info: Array<{
    name: string;
    file: string;
    requiredEnv: string[];
    preconditions: string[];
  }>,
): string {
  const allEnv = [...new Set(info.flatMap((i) => i.requiredEnv))].toSorted();
  const lines = [
    "# Exported Playwright suite",
    "",
    "Generated by `cairn export playwright` from Cairntrace specs. The specs",
    "remain the source of truth; re-exporting overwrites these files.",
    "`.cairn-export.json` records the exporter version, each spec's",
    "contract hash and source digest, and a sha256 per generated file;",
    "`cairn export playwright --check <this dir>` reports drift (exit 1).",
    "",
    "## Run",
    "",
    "```bash",
    "npx playwright test        # serial (workers: 1) is required - the tests",
    "                           # share one backend pipeline and must not overlap",
    "```",
    "",
    "## Required environment",
    "",
    allEnv.length > 0
      ? `Provide these env vars from ANY secret source (CI secrets, dotenv, a vault CLI):`
      : "No secret env vars required.",
    ...allEnv.map((e) => `- \`${e}\``),
    "",
    "`CAIRN_RUN_TOKEN` (optional) pins the per-run uniqueness token; omitted, a",
    "random one is generated per invocation so re-runs keep writing new values.",
    "",
    "## Playwright config requirements",
    "",
    "- `use: { bypassCSP: true }` - the app ships a strict CSP (no unsafe-eval)",
    "  that blocks exported string-eval steps.",
    "- `workers: 1, fullyParallel: false` - shared backend state.",
    "- Node-context verifiers (imported relatively from the spec repo) reach",
    "  databases via `MONGO_URI` (or a local `docker exec` fallback) and any",
    "  app APIs via their fixtures — keep those endpoints reachable.",
    "",
    "## Preconditions (NOT exported - wire into globalSetup or a CI step)",
    "",
  ];
  for (const i of info) {
    lines.push(`### ${i.name} (\`${i.file}\`)`);
    if (i.preconditions.length === 0) {
      lines.push("- none");
    } else {
      for (const p of i.preconditions) lines.push(`- ${p}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Skip reasons and semantic risks for one exported spec (markdown bullets). */
function coverageMarkdown(coverage: ExportCoverage): string[] {
  const lines: string[] = [];
  const hard = coverage.skips.filter((s) => !s.soft);
  if (hard.length > 0) {
    lines.push("", "### Skips (test.fixme)");
    for (const s of hard.slice(0, 30)) {
      lines.push(`- [${s.kind}]${s.id ? ` ${s.id}` : ""}: ${s.reason}`);
    }
    if (hard.length > 30) lines.push(`- …and ${hard.length - 30} more`);
  }
  if (coverage.diagnosticSkips.length > 0) {
    lines.push("", "### Diagnostic skips");
    for (const s of coverage.diagnosticSkips.slice(0, 30)) {
      lines.push(`- [${s.kind}]${s.id ? ` ${s.id}` : ""}: ${s.reason}`);
    }
  }
  if (coverage.semanticRisks.length > 0) {
    lines.push("", "### Semantic risks");
    for (const r of coverage.semanticRisks.slice(0, 30)) {
      lines.push(`- ${r.kind}${r.id ? ` (${r.id})` : ""}: ${r.detail}`);
    }
    if (coverage.semanticRisks.length > 30) {
      lines.push(`- …and ${coverage.semanticRisks.length - 30} more`);
    }
  }
  return lines;
}

function coverageLine(coverage: ExportCoverage): string {
  return `steps ${coverage.stepsExported}/${coverage.stepsTotal}, outcomes ${coverage.outcomesExported}/${coverage.outcomesTotal}${
    coverage.fixme ? " — test.fixme" : ""
  }`;
}

function toMarkdown(report: ExportPlaywrightReport): string {
  const lines = [
    `# Export Playwright (${report.lang})`,
    "",
    `Status: **${report.status}** — written ${report.summary.written}, partial ${report.summary.partial}, failed ${report.summary.failed}`,
    ...(report.manifest ? ["", `Manifest: \`${report.manifest}\``] : []),
    "",
  ];
  for (const f of report.files) {
    lines.push(
      `## ${f.name}`,
      "",
      `- source: \`${f.source}\``,
      `- out: \`${f.path}\``,
      `- coverage: ${coverageLine(f.coverage)}`,
      ...coverageMarkdown(f.coverage),
      "",
    );
  }
  return lines.join("\n");
}

function projectToMarkdown(report: ExportProjectReport): string {
  const lines = [
    `# Export Playwright project`,
    ``,
    `Out: \`${report.outDir}\``,
    `Manifest: \`${report.manifest}\``,
    ``,
    ...report.files.map((f) => `- ${f}`),
    ...report.verifiersCopied.map((v) => `- ${v} (copied)`),
    ...report.fixturesCopied.map((v) => `- ${v} (copied fixture)`),
    ``,
    `Required env: ${report.requiredEnv.join(", ") || "none"}`,
    ``,
  ];
  for (const s of report.specs) {
    lines.push(
      `## ${s.name}`,
      ``,
      `- file: \`${s.file}\``,
      `- coverage: ${coverageLine(s.coverage)}`,
      ...coverageMarkdown(s.coverage),
      ``,
    );
  }
  return lines.join("\n");
}

function checkToMarkdown(report: ExportCheckReport): string {
  const lines = [
    `# Export check: ${report.status}`,
    ``,
    `Export: \`${report.exportDir}\``,
  ];
  if (report.error) {
    lines.push(``, `Error: ${report.error}`);
    return lines.join("\n");
  }
  if (report.manifest) {
    lines.push(
      `Generated by cairntrace ${report.manifest.exporterVersion} at ${report.manifest.generatedAt} (${report.manifest.mode}, ${report.manifest.lang})`,
    );
  }
  lines.push(``, `Files checked: ${report.files.checked}`);
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(``, `## ${title}`, ...items.map((item) => `- ${item}`));
  };
  section("Stale (differs from current sources)", report.files.stale);
  section("Missing", report.files.missing);
  section("Orphaned (spec no longer exported)", report.files.orphaned);
  section("Edited after export", report.files.modified);
  section(
    "Specs",
    report.specs
      .filter((spec) => spec.status !== "fresh")
      .map(
        (spec) =>
          `${spec.spec} → ${spec.testFile}: ${spec.status}${
            spec.contractChanged ? " (contract changed)" : ""
          }`,
      ),
  );
  section("Warnings", report.warnings);
  return lines.join("\n");
}
