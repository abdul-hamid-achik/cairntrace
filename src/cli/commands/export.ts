import { existsSync } from "node:fs";
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
  type ExportManifestPrecondition,
  type ExportManifestSpec,
  type ExportManifestV1,
  type GeneratedExportFile,
} from "../../core/exporters/exportManifest";
import type { ExportEnvTarget } from "../../core/exporters/requiresGuard";
import {
  authoredPlaceholders,
  envDefaultSentinel,
  hasLateEnvRef,
  LateBoundLeakError,
  withAuthoredDefaults,
} from "../../core/exporters/templateValue";
import {
  parseGateEnv,
  parsePreconditionsMode,
  parseVerifiersMode,
  type ExportPreconditionsMode,
  type ExportVerifiersMode,
} from "../../core/exporters/exportModes";
import { formatWithHostPrettier } from "../../core/exporters/hostFormat";
import {
  ExportMapError,
  exportMapProblems,
  loadExportMap,
  type LoadedExportMap,
} from "../../core/exporters/exportMap";
import {
  applyExportTarget,
  assertBypassCsp,
  assertHostFlags,
  assertMapFlags,
  evalRatioRefusalOf,
  ExportRefusedError,
  hostReport,
  limitOf,
  prepareHost,
  type ExportHostReport,
  type ExportRefusal,
} from "./exportHost";
import { resolveEnvironmentDatasources } from "../../core/datasources/resolve";
import type { Datasource } from "../../core/datasources/schema";
import { lookupVar, renderVarValue } from "../../core/config/varValue";
import type { ConfigVarValue } from "../../core/schema/config.v1";
import type { ExportHttpDatasource } from "../../core/exporters/playwrightDataVerifiers";
import { fixtureScope } from "../../core/fixtures/schema";
import { parse as parseYamlScalar } from "yaml";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import {
  prepareWidgets,
  type PreparedWidgets,
} from "../../core/widgets/runtime";
import type { ExportEnvAuth } from "../../core/exporters/requestRuntime";
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
  /**
   * E10: `inline|global|skip|manifest` — how host commands (preconditions,
   * `run:` steps, `teardown:`, fixtures, gates) are exported. See
   * `cairn docs export`.
   */
  preconditions?: string;
  /** E10: `keep|gate|drop` for node / datasource verifiers. */
  verifiers?: string;
  /** E10: env var names every gated node verifier requires (repeatable / comma list). */
  gateEnv?: string[];
  /**
   * E8: adapt an `--into` tree to an existing Playwright host: the host's
   * playwright.config is read statically (module system, timeouts,
   * testIdAttribute, bypassCSP, testDir / testMatch, tsconfig aliases,
   * prettier). See `cairn docs export`.
   */
  hostConfig?: string;
  /** E8: a named `export.targets.<name>` profile; flags override its fields. */
  target?: string;
  /** E12: refuse a spec whose share of page `eval` steps is above this (0..1). */
  maxEvalRatio?: string | number;
  /** E8: export page evals into a host that does not set `bypassCSP: true`. */
  allowEvalWithoutBypass?: boolean;
  /**
   * Emit no `.first()` on a locator without `nth`: an ambiguous locator
   * then fails the exported test (Playwright strict mode), like
   * `cairn run --backend playwright`. Default: `.first()` (the
   * agent-browser first-match semantics). `--no-strict-locators` turns a
   * profile's `strictLocators: true` off.
   */
  strictLocators?: boolean;
  /**
   * E9: the export map (`--map <file>` or a profile's `mapFile`): binds
   * cairn actions to the host's fixtures and page objects. See
   * `cairn docs export`.
   */
  mapFile?: string;
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
  /**
   * E5: prove an export faithful. A value is an export directory to verify
   * (`--verify ./export`) or a mode (`static` | `differential`) applied to
   * the export this command writes; bare `--verify` verifies the export
   * just written. `cairn docs export` has the gates and exit codes.
   */
  verify?: string | boolean;
  /** E5: also run `cairn run` and the exported test with the same run token and compare. */
  differential?: boolean;
  /** E5: invert one assertion per spec (`all`: every outcome) and require the test to fail. */
  mutate?: string | boolean;
  /** E5: a skipped gate or an inconclusive result fails the verify. */
  verifyStrict?: boolean;
  /** E5: restrict the differential / mutation to specs matching these (repeatable). */
  verifyOnly?: string[];
  /** E5: warn when slower/faster exceeds this ratio (default 3). */
  durationRatio?: string;
  /**
   * The host Playwright project `--verify` lists, runs and mutates under on
   * a multi-project host (default: the manifest's, else one discovering
   * project, Chromium first). Recorded in the manifest at export time.
   */
  verifyProject?: string;
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
  /** E12: specs refused for exceeding `--max-eval-ratio` (the others were written). */
  refused?: ExportRefusal[];
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
  /** E8: how the tree was adapted to the host Playwright config. */
  host?: ExportHostReport;
  /** E8: the `export.targets` profile this export was made from. */
  target?: string;
  /** E12: `--max-eval-ratio`, and the specs it refused (the others were written). */
  maxEvalRatio?: number;
  refused?: ExportRefusal[];
  /** E9: the export map used, and how it bound each action. */
  map?: ExportMapReport;
}

/** E9: the export map an export was made with. */
export interface ExportMapReport {
  /** The map file, relative to the export directory. */
  file: string;
  digest: string;
  strict: boolean;
  /** Mapped vs generated actions (see `MappedActionReport`). */
  actions: import("../../core/exporters/exportMapEmit").MappedActionReport[];
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
  specPathArg: string | undefined,
  optsArg: ExportPlaywrightOptions,
): Promise<void> {
  let specPath = specPathArg;
  let opts = optsArg;
  // E8: `--target <name>` fills what the command line left out from the
  // config's `export.targets.<name>` (flags win).
  if (opts.target !== undefined && !opts.check) {
    try {
      const applied = await applyExportTarget(opts, specPath);
      opts = applied.opts;
      specPath = applied.inputPath;
    } catch (e) {
      process.stderr.write(
        `cairn export playwright: ${(e as Error).message}\n`,
      );
      process.exit(2);
    }
  }
  let verify: VerifyRequest | undefined;
  try {
    verify = resolveVerifyRequest(opts);
  } catch (e) {
    process.stderr.write(`cairn export playwright: ${(e as Error).message}\n`);
    process.exit(2);
  }
  const exportsSomething = Boolean(
    specPath && (opts.project || opts.into || opts.outDir),
  );
  if (verify && !exportsSomething) {
    if (!verify.dir) {
      process.stderr.write(
        "cairn export playwright: --verify needs an export directory (--verify <dir>) or an export to verify (<spec> --project --out-dir <dir> --verify)\n",
      );
      process.exit(2);
    }
    const { exportVerifyCommand } = await import("./exportVerify");
    await exportVerifyCommand(
      verifyOptionsOf(verify, verify.dir, opts),
      resolveFormat(opts, "md"),
    );
    return;
  }
  // With --verify the export report goes to stderr: stdout carries exactly
  // the verify report (one document in json / yaml).
  const exportOut = verify ? process.stderr : process.stdout;
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
  try {
    resolveExportModes(opts);
    assertHostFlags(opts);
    assertMapFlags(opts);
    limitOf(opts);
  } catch (e) {
    process.stderr.write(`cairn export playwright: ${(e as Error).message}\n`);
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
      process.exit(
        e instanceof ExportRefusedError
          ? 1
          : e instanceof LateBoundLeakError
            ? 2
            : 4,
      );
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
      // Every spec over --max-eval-ratio: nothing written, a gate failure (1).
      process.exit(e instanceof ExportRefusedError ? 1 : 2);
    }
    const format = resolveFormat(opts, "md");
    exportOut.write(emit(format, report, projectToMarkdown));
    if (format !== "json" && format !== "yaml") exportOut.write("\n");
    for (const refusal of report.refused ?? []) {
      process.stderr.write(`cairn export playwright: ${refusal.message}\n`);
    }
    // Specs over --max-eval-ratio are refused, the rest written: exit 1.
    if ((report.refused ?? []).length > 0) process.exitCode = 1;
    if (verify) {
      const { exportVerifyCommand } = await import("./exportVerify");
      await exportVerifyCommand(
        verifyOptionsOf(verify, verify.dir ?? report.outDir, opts),
        format,
      );
    }
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
    for (const refusal of written.refused) {
      process.stderr.write(`cairn export playwright: ${refusal.message}\n`);
    }
    process.exit(
      written.leaked
        ? 2
        : written.failed > 0
          ? 4
          : written.refused.length > 0
            ? 1
            : 2,
    );
  }

  const format = resolveFormat(opts, "md");
  exportOut.write(emit(format, written.report, toMarkdown));
  if (format !== "json" && format !== "yaml") exportOut.write("\n");
  for (const refusal of written.refused) {
    process.stderr.write(`cairn export playwright: ${refusal.message}\n`);
  }
  // Specs over --max-eval-ratio are refused, the rest written: exit 1.
  if (written.refused.length > 0) process.exitCode = 1;

  // A sentinel leak is an exporter defect, never a partial success.
  if (written.leaked) process.exit(2);
  if (verify) {
    const dir = verify.dir ?? opts.outDir;
    if (!dir || !written.report.manifest) {
      process.stderr.write(
        "cairn export playwright: --verify needs an export with a manifest (--project, --into or --out-dir)\n",
      );
      process.exit(2);
    }
    const { exportVerifyCommand } = await import("./exportVerify");
    await exportVerifyCommand(verifyOptionsOf(verify, dir, opts), format);
  }
}

interface VerifyRequest {
  /** An explicit export directory (`--verify <dir>`). */
  dir?: string;
  differential: boolean;
  mutate?: "one" | "all";
}

/** `--verify[=<dir>|static|differential]`, `--differential`, `--mutate[=one|all]`. */
function resolveVerifyRequest(
  opts: ExportPlaywrightOptions,
): VerifyRequest | undefined {
  if (
    opts.verify === undefined &&
    !opts.differential &&
    opts.mutate === undefined
  ) {
    return undefined;
  }
  let dir: string | undefined;
  let differential = opts.differential === true;
  if (typeof opts.verify === "string") {
    if (opts.verify === "differential") differential = true;
    else if (opts.verify !== "static") dir = opts.verify;
  }
  let mutate: "one" | "all" | undefined;
  if (opts.mutate === true || opts.mutate === "one") mutate = "one";
  else if (opts.mutate === "all") mutate = "all";
  else if (typeof opts.mutate === "string") {
    throw new Error(
      `--mutate must be one|all (got ${JSON.stringify(opts.mutate)})`,
    );
  }
  if (opts.durationRatio !== undefined) {
    const ratio = Number(opts.durationRatio);
    if (!Number.isFinite(ratio) || ratio <= 1) {
      throw new Error("--duration-ratio must be a number greater than 1");
    }
  }
  if (opts.check) {
    throw new Error(
      "--verify and --check are separate operations (verify runs the check as its freshness gate)",
    );
  }
  return {
    ...(dir ? { dir } : {}),
    differential,
    ...(mutate ? { mutate } : {}),
  };
}

function verifyOptionsOf(
  verify: VerifyRequest,
  exportDir: string,
  opts: ExportPlaywrightOptions,
): import("./exportVerify").ExportVerifyOptions {
  return {
    exportDir,
    differential: verify.differential,
    ...(verify.mutate ? { mutate: verify.mutate } : {}),
    ...(opts.verifyStrict ? { strict: true } : {}),
    ...(opts.verifyOnly && opts.verifyOnly.length > 0
      ? { only: opts.verifyOnly }
      : {}),
    ...(opts.durationRatio !== undefined
      ? { durationRatio: Number(opts.durationRatio) }
      : {}),
    ...(opts.verifyProject !== undefined
      ? { project: opts.verifyProject }
      : {}),
    runtime: {
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.var !== undefined ? { var: opts.var } : {}),
    },
  };
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
  refused: ExportRefusal[];
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
        source: manifestSource(outDir, inputPath, opts, batch.projectRoot),
        specs: batch.specs.map((spec) => ({
          ...spec,
          spec: posixRelative(outDir, spec.spec),
          testFile: posixRelative(outDir, spec.testFile),
        })),
        files: batch.generated.map((file) => ({
          ...file,
          relPath: posixRelative(outDir, file.relPath),
        })),
        ...(batch.preconditions
          ? {
              preconditions: batch.preconditions.map((entry) => ({
                ...entry,
                spec: posixRelative(outDir, entry.spec),
              })),
            }
          : {}),
      }),
    );
    manifestPath = join(outDir, EXPORT_MANIFEST_FILE);
  }
  if (files.length === 0) {
    return {
      failed: batch.failed,
      leaked: batch.leaked,
      errors: batch.errors,
      refused: batch.refused,
    };
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
      ...(batch.refused.length > 0 ? { refused: batch.refused } : {}),
    },
    failed: batch.failed,
    leaked: batch.leaked,
    errors: batch.errors,
    refused: batch.refused,
  };
}

interface BatchExport {
  /** `--preconditions manifest`: the commands to list (spec paths absolute here). */
  preconditions?: ExportManifestPrecondition[];
  /** The source project root of the first spec's config. */
  projectRoot?: string;
  entries: Array<{ report: ExportFileReport }>;
  /** Files to write; relPath is ABSOLUTE here (batch outputs may be anywhere). */
  generated: GeneratedExportFile[];
  specs: ExportManifestSpec[];
  failed: number;
  leaked: boolean;
  errors: ExportSpecError[];
  /** E12: specs refused by `--max-eval-ratio` (not failures; the rest exported). */
  refused: ExportRefusal[];
}

/** Render every batch/single-file export in memory (shared by write + check). */
async function buildBatchExport(
  paths: string[],
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
): Promise<BatchExport> {
  const modes = resolveExportModes(opts);
  const manifestPreconditions: ExportManifestPrecondition[] = [];
  let projectRoot: string | undefined;
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
  const refused: ExportRefusal[] = [];
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
      projectRoot = projectRoot ?? exported.projectRoot ?? dirname(resolve(p));
      if (modes.preconditions === "manifest") {
        manifestPreconditions.push(
          ...toManifestPreconditions(
            exported.specPath,
            exported.setup.preconditions,
            exported.projectRoot ?? dirname(resolve(p)),
          ),
        );
      }
    } catch (e) {
      if (e instanceof ExportRefusedError) {
        refused.push(...e.refusals);
        continue;
      }
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
      content: renderReadme(readmeInfo, modes),
    });
  }
  return {
    entries,
    generated,
    specs,
    failed,
    leaked,
    errors,
    refused,
    ...(projectRoot ? { projectRoot } : {}),
    ...(modes.preconditions === "manifest"
      ? { preconditions: manifestPreconditions }
      : {}),
  };
}

/** Host preconditions as manifest entries: authored text, cwd relative to the project root. */
function toManifestPreconditions(
  specPath: string,
  preconditions: ReadonlyArray<{
    name?: string;
    run: string;
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string | number | boolean>;
  }>,
  projectRoot: string,
): ExportManifestPrecondition[] {
  return preconditions.map((pre) => ({
    spec: specPath,
    ...(pre.name ? { name: pre.name } : {}),
    run: authoredPlaceholders(pre.run),
    cwd: posixRelative(projectRoot, pre.cwd),
    timeoutMs: pre.timeoutMs,
    ...(pre.env && Object.keys(pre.env).length > 0
      ? { envKeys: Object.keys(pre.env).toSorted() }
      : {}),
  }));
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
  /** F15: `browser.fieldRoot` / `browser.widgets` (custom drivers read). */
  widgets: PreparedWidgets;
  /** F18: the environment's `auth:` block for `use: login`. */
  envAuth?: ExportEnvAuth;
  /** F20: config `browser.appHandle` (baked into CAIRN_PRELUDE). */
  appHandles?: Record<string, string>;
  /** The resolved config file, when there is one (global-setup `--config`). */
  configPath?: string;
  /** The environment the export resolved (global-setup `--env`). */
  envName?: string;
  /** Env vars each config datasource needs (`--verifiers gate`). */
  datasourceEnv: Record<string, string[]>;
  /** The environment's `kind: http` datasources, for exported `http` verifiers. */
  httpDatasources: Record<string, ExportHttpDatasource>;
  /** Config fixture name → scope (run-scoped ones are torn down). */
  fixtureScopes: Record<string, string>;
}> {
  const varOverrides = parseVarFlags(opts.var);
  // No environment value set while exporting may reach generated code, the
  // manifest or a report. The config is loaded LATE-BOUND (the only load an
  // export makes): every `${env.X}` / `${env.X:-default}` in it — config
  // vars, baseUrl, `auth:`, datasources — stays a reference the test reads
  // from process.env when it runs, exactly like the spec's own.
  const runtime = await resolveSpecRuntimeContext(specPath, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(varOverrides).length > 0 ? { vars: varOverrides } : {}),
    envRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
    // A spec's own `vars:` read ${env.X[:-default]} at test run time too.
    envDefaultRef: envDefaultSentinel,
    lateEnv: true,
    lateConfig: {
      defaultRef: envDefaultSentinel,
      all: true,
      standIns: lateConfigStandIns,
    },
  });
  assertLateBindable(runtime);
  let parsed: Awaited<ReturnType<typeof parseSpec>>;
  try {
    parsed = await parseSpec(specPath, {
      vars: runtime.vars,
      configDir: runtime.configDir,
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
      // E10: no ${env.X} value is baked into generated code; a `:-default` is
      // read (and falls back) when the test runs.
      envDefaultRef: envDefaultSentinel,
      lateEnv: true,
      runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
    });
  } catch (e) {
    throw withLateVarHint(e, runtime.vars);
  }
  const viewport = parsed.spec.viewport ?? runtime.viewport;
  const envPolicy = runtime.config?.environments[runtime.envName]?.policy;
  const widgets = await prepareWidgets(runtime.browser, runtime.configDir);
  const auth = runtime.config?.environments[runtime.envName]?.auth;
  const datasources = resolveEnvironmentDatasources(
    runtime.config?.datasources,
    runtime.config?.environments[runtime.envName]?.datasources,
  );
  const datasourceEnv = Object.fromEntries(
    Object.entries(datasources.datasources).map(([name, datasource]) => [
      name,
      requiredEnvOf(datasource),
    ]),
  );
  const httpDatasources = exportHttpDatasources(datasources.datasources, {
    ...runtime.vars,
    ...parsed.vars,
  });
  const fixtureScopes = Object.fromEntries(
    Object.entries(runtime.config?.fixtures ?? {}).map(([name, fixture]) => [
      name,
      fixtureScope(fixture),
    ]),
  );
  return {
    parsed,
    widgets,
    datasourceEnv,
    httpDatasources,
    fixtureScopes,
    ...(runtime.configPath ? { configPath: runtime.configPath } : {}),
    ...(runtime.config?.environments[runtime.envName]
      ? { envName: runtime.envName }
      : {}),
    ...(runtime.browser?.appHandle
      ? { appHandles: runtime.browser.appHandle }
      : {}),
    ...(auth
      ? {
          envAuth: {
            auth,
            envName: runtime.envName,
            vars: { ...runtime.vars, ...parsed.vars },
            configDir: runtime.configDir,
            ...(runtime.browser?.appHandle
              ? { appHandles: runtime.browser.appHandle }
              : {}),
          },
        }
      : {}),
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

/**
 * Validation stand-ins for a late-bound config string a typed field cannot
 * hold (a URL, a number, an enum): its authored defaults, typed like YAML
 * would, then neutral values. Never an environment value.
 */
function lateConfigStandIns(text: string): unknown[] {
  if (!hasLateEnvRef(text)) return [];
  const defaulted = withAuthoredDefaults(text);
  const out: unknown[] = [];
  try {
    const typed: unknown = parseYamlScalar(defaulted);
    if (typed !== null && typeof typed !== "object" && typed !== defaulted) {
      out.push(typed);
    }
  } catch {
    // not a YAML scalar: the plain text below
  }
  out.push(defaulted, "http://late-bound.invalid/", 1, true, false);
  return out;
}

/**
 * Config sections an export emits (into code, the manifest or a report) for
 * environment `env` and its `extends` chain. A typed field there that holds
 * a late-bound `${env.X}` cannot be emitted as a process.env read, and its
 * environment value must never be baked: the export refuses.
 */
function assertLateBindable(
  runtime: Awaited<ReturnType<typeof resolveSpecRuntimeContext>>,
): void {
  // Browser settings the export writes as literals (the generated
  // playwright.config's use.testIdAttribute, explicit test id selectors, the
  // capture probe, widget and app-handle code): a string field there can
  // hold ${env.X} in the config, but never as a process.env read in code.
  const browser = (runtime.config?.browser ?? {}) as Record<string, unknown>;
  const literal = LITERAL_BROWSER_FIELDS.filter((key) =>
    hasLateEnvRef(JSON.stringify(browser[key] ?? "")),
  ).map((key) => `browser.${key}`);
  if (literal.length > 0) {
    throw new Error(
      `cannot export: ${literal.join(", ")} ${
        literal.length === 1 ? "reads" : "read"
      } \${env.…} / \${secrets.…}, and the export writes ${
        literal.length === 1 ? "it" : "them"
      } into generated code as a literal (playwright.config use.testIdAttribute, test id selectors, widget code), where it cannot stay late-bound — and baking the value would write the environment into generated code. Write a literal value there.`,
    );
  }
  const unbound = runtime.lateUnbound ?? [];
  if (unbound.length === 0) return;
  const chain = new Set([
    runtime.envName,
    ...(runtime.configPath ? environmentChain(runtime) : []),
  ]);
  // What the export writes from the config: vars, baseUrl, viewport, the
  // auth block, the policy its requires guard reads, the browser settings
  // the generated code carries. (Datasources only lend string fields.)
  const emitted = unbound.filter((path) => {
    if (/^vars(?:\.|$)/.test(path)) return true;
    if (
      /^browser\.(?:testIdAttribute|fieldRoot|widgets|appHandle)(?:\.|$)/.test(
        path,
      )
    ) {
      return true;
    }
    const m =
      /^environments\.([^.]+)\.(auth|baseUrl|vars|viewport|policy)(?:\.|$)/.exec(
        path,
      );
    return m !== null && chain.has(m[1]!);
  });
  if (emitted.length === 0) return;
  throw new Error(
    `cannot export: ${emitted.join(", ")} ${
      emitted.length === 1 ? "reads" : "read"
    } \${env.…} / \${secrets.…} in a typed config field (a number, URL or enum), which an export cannot leave late-bound — and baking the value would write the environment into generated code. Write a literal value there.`,
  );
}

/** `browser.*` settings the export writes into generated code as literals. */
const LITERAL_BROWSER_FIELDS = [
  "testIdAttribute",
  "fieldRoot",
  "widgets",
  "appHandle",
] as const;

/** The export environment's `extends` chain (itself included). */
function environmentChain(
  runtime: Awaited<ReturnType<typeof resolveSpecRuntimeContext>>,
): string[] {
  const chain: string[] = [];
  const envs = runtime.config?.environments ?? {};
  let current: string | undefined = runtime.envName;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    const parent: unknown = (envs[current] as { extends?: unknown } | undefined)
      ?.extends;
    current = typeof parent === "string" ? parent : undefined;
  }
  return chain;
}

/**
 * A spec that fails to parse because a late-bound config var landed in a
 * typed spec field (a number, a boolean): say which vars stay late-bound.
 */
function withLateVarHint(
  error: unknown,
  vars: Record<string, ConfigVarValue>,
): unknown {
  const late = Object.entries(vars)
    .filter(([, value]) => hasLateEnvRef(JSON.stringify(value) ?? ""))
    .map(([name]) => name);
  if (late.length === 0 || !(error instanceof Error)) return error;
  error.message += `\n(export: vars ${late.join(", ")} read \${env.…} / \${secrets.…} and stay late-bound — process.env reads when the test runs — so a typed spec field cannot hold them; pass the value with --var to export it as a literal)`;
  return error;
}

/**
 * `${env.X}` / `${secrets.X}` a datasource carries WITHOUT a `:-default`
 * (also an unset env the config loader left as a late-bound reference): the
 * env vars `--verifiers gate` waits for.
 */
function requiredEnvOf(value: unknown, into = new Set<string>()): string[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(
      /\$\{(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)\}|__CAIRN_SECRET_REF__([A-Za-z0-9_]+)__/g,
    )) {
      into.add((m[1] ?? m[2])!);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) requiredEnvOf(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) requiredEnvOf(item, into);
  }
  return [...into].toSorted();
}

/**
 * The `kind: http` datasources of the export environment as the exporter
 * takes them: `${vars.X}` resolved now (a var is plain data), every
 * `${env.X}` / `${secrets.X}` left as text for the test to read at run time.
 */
function exportHttpDatasources(
  datasources: Record<string, Datasource>,
  vars: Record<string, ConfigVarValue>,
): Record<string, ExportHttpDatasource> {
  const resolveVars = (text: string): string =>
    text.replace(
      /\$\{vars\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)(?::-([^}]*))?\}/g,
      (match, key: string, fallback: string | undefined) => {
        const hit = lookupVar(vars, key);
        if (hit.found) return renderVarValue(hit.value);
        return fallback ?? match;
      },
    );
  const out: Record<string, ExportHttpDatasource> = {};
  for (const [name, datasource] of Object.entries(datasources)) {
    if (datasource.kind !== "http") continue;
    out[name] = {
      baseUrl: resolveVars(datasource.baseUrl),
      ...(datasource.headers
        ? {
            headers: Object.fromEntries(
              Object.entries(datasource.headers).map(([key, value]) => [
                key,
                resolveVars(value),
              ]),
            ),
          }
        : {}),
      ...(datasource.auth
        ? {
            auth: {
              ...(datasource.auth.basic !== undefined
                ? { basic: resolveVars(datasource.auth.basic) }
                : {}),
              ...(datasource.auth.bearer !== undefined
                ? { bearer: resolveVars(datasource.auth.bearer) }
                : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

/** The validated `--preconditions` / `--verifiers` / `--gate-env` of a request. */
export interface ExportModes {
  preconditions?: ExportPreconditionsMode;
  verifiers?: ExportVerifiersMode;
  gateEnv: string[];
}

/**
 * Parse and cross-check the E10 flags. Throws a plain Error (exit 2 in the
 * CLI, a tool error over MCP) naming the flag.
 */
export function resolveExportModes(
  opts: Pick<
    ExportPlaywrightOptions,
    | "preconditions"
    | "verifiers"
    | "gateEnv"
    | "project"
    | "into"
    | "outDir"
    | "out"
    | "stdout"
  >,
): ExportModes {
  const preconditions = parsePreconditionsMode(opts.preconditions);
  const verifiers = parseVerifiersMode(opts.verifiers);
  const gateEnv = parseGateEnv(opts.gateEnv);
  const structured = Boolean(opts.project || opts.into);
  if (preconditions === "global" && !structured) {
    throw new Error(
      "--preconditions global needs --project or --into: it writes the project's global setup",
    );
  }
  if (
    preconditions === "manifest" &&
    (opts.stdout || (!structured && !opts.outDir))
  ) {
    throw new Error(
      "--preconditions manifest needs --project, --into or --out-dir: the commands are listed in .cairn-export.json",
    );
  }
  if (gateEnv.length > 0 && verifiers !== "gate") {
    throw new Error("--gate-env only applies with --verifiers gate");
  }
  return {
    ...(preconditions ? { preconditions } : {}),
    ...(verifiers ? { verifiers } : {}),
    gateEnv,
  };
}

export interface BuiltProjectExport {
  /** E9: the export map the tree was made with. */
  map?: LoadedExportMap;
  outDir: string;
  result: import("../../core/exporters/playwrightProject").ProjectExportResult;
  /** Generated + copied files (verifiers, evals, fixtures), relative to outDir. */
  generated: GeneratedExportFile[];
  manifest: ExportManifestV1;
  /** E8: the host profile the tree was adapted to (with the formatting outcome). */
  host?: ExportHostReport;
  /** E12: specs refused by `--max-eval-ratio` (not part of `result`). */
  refused: ExportRefusal[];
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

  const parsedSpecs: Awaited<ReturnType<typeof parseForExport>>["parsed"][] =
    [];
  const refused: ExportRefusal[] = [];
  const evalLimit = limitOf(opts);
  let baseUrl: string | undefined;
  let envTarget: ExportEnvTarget | undefined;
  let projectRoot: string | undefined;
  let configDir: string | undefined;
  let testIdAttribute: string | undefined;
  let viewport: { width: number; height: number } | undefined;
  let widgets: PreparedWidgets | undefined;
  let envAuth: ExportEnvAuth | undefined;
  let appHandles: Record<string, string> | undefined;
  let configPath: string | undefined;
  let envName: string | undefined;
  const datasourceEnv: Record<string, string[]> = {};
  const httpDatasources: Record<string, ExportHttpDatasource> = {};
  const fixtureScopes: Record<string, string> = {};
  const modes = resolveExportModes(opts);
  for (const p of paths) {
    const r = await parseForExport(p, opts);
    // E12: a spec over --max-eval-ratio is refused; the others still export.
    const refusal = evalRatioRefusalOf(r.parsed, evalLimit);
    if (refusal) {
      refused.push(refusal);
      continue;
    }
    parsedSpecs.push(r.parsed);
    configPath = configPath ?? r.configPath;
    envName = envName ?? r.envName;
    Object.assign(datasourceEnv, r.datasourceEnv);
    Object.assign(httpDatasources, r.httpDatasources);
    Object.assign(fixtureScopes, r.fixtureScopes);
    widgets = widgets ?? r.widgets;
    envAuth = envAuth ?? r.envAuth;
    appHandles = appHandles ?? r.appHandles;
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

  if (parsedSpecs.length === 0 && refused.length > 0) {
    throw new ExportRefusedError(refused);
  }

  const absInput = absoluteFrom(inputPath);
  const sourceRoot = (await stat(absInput)).isDirectory()
    ? absInput
    : dirname(absInput);
  // Without a cairntrace.config.yml the export INPUT is the project root, so
  // every spec below it (not just the first one's folder) stays relative.
  projectRoot = projectRoot ?? sourceRoot;

  // E8: the host's own Playwright config decides module system, timeouts,
  // test discovery and the rest (read statically, never executed).
  const host = await prepareHost(opts, lang, outDir);
  if (host) assertBypassCsp(parsedSpecs, host, opts.allowEvalWithoutBypass);
  // E9: the export map (validated before any file is rendered).
  const loadedMap = opts.mapFile ? loadMapFile(opts.mapFile) : undefined;

  const result = exportPlaywrightProject(parsedSpecs, {
    lang,
    outDir,
    ...(host ? { host: host.emit } : {}),
    ...(loadedMap ? { map: loadedMap } : {}),
    ...(host && loadedMap ? { hostProjects: host.profile.projects } : {}),
    sourceRoot,
    projectRoot,
    ...(configDir ? { configDir } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(envTarget ? { envTarget } : {}),
    ...(testIdAttribute ? { testIdAttribute } : {}),
    ...(opts.strictLocators ? { strictLocators: true } : {}),
    ...(widgets ? { widgets } : {}),
    ...(envAuth ? { envAuth } : {}),
    ...(appHandles ? { appHandles } : {}),
    ...(viewport ? { viewport } : {}),
    ...(opts.into ? { into: true } : {}),
    copyFixtures: true,
    writesManifest: true,
    lateBoundEnv: true,
    ...(modes.preconditions ? { preconditions: modes.preconditions } : {}),
    ...(modes.verifiers ? { verifiers: modes.verifiers } : {}),
    ...(modes.gateEnv.length > 0 ? { gateEnv: modes.gateEnv } : {}),
    datasourceEnv,
    httpDatasources,
    ...(configPath ? { configPath } : {}),
    ...(envName ? { envName } : {}),
    fixtureScopes,
  });

  // Self-contained project: generated files, plus the referenced node
  // verifiers and eval sources copied in as text (and upload fixtures below,
  // binary-safe).
  let textFiles: Array<{ relPath: string; source: string }> = [...result.files];
  for (const v of [...result.verifierFiles, ...result.evalFiles]) {
    textFiles.push({
      relPath: v.relPath,
      source: await readFile(v.sourcePath, "utf8"),
    });
  }
  // E8: against a host with a prettier config and a local prettier, every
  // text file of the tree (the verifier / eval copies too, so the host's
  // `prettier --check` passes) is formatted with the host's own settings.
  let formatted = { formatted: 0, skipped: [] as FormatSkips };
  if (host?.emit.prettier) {
    const done = await formatWithHostPrettier(
      textFiles,
      host.emit.prettier,
      outDir,
      existingAncestor(outDir),
    );
    textFiles = done.files;
    formatted = { formatted: done.formatted, skipped: done.skipped };
  }
  const generated: GeneratedExportFile[] = textFiles.map((f) => ({
    relPath: f.relPath,
    content: f.source,
  }));
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
    source: manifestSource(outDir, inputPath, opts, projectRoot, loadedMap),
    specs: result.specs.map((spec) => ({
      spec: posixRelative(outDir, spec.sourcePath),
      contractHash: spec.contractHash,
      testFile: spec.file,
      sourceDigest: spec.sourceDigest,
    })),
    files: generated,
    ...(modes.preconditions === "manifest"
      ? {
          preconditions: result.specs.flatMap((spec) =>
            toManifestPreconditions(
              posixRelative(outDir, spec.sourcePath),
              spec.setup.preconditions,
              projectRoot,
            ),
          ),
        }
      : {}),
  });
  return {
    outDir,
    result,
    generated,
    manifest,
    refused,
    ...(loadedMap ? { map: loadedMap } : {}),
    ...(host ? { host: hostReport(host, outDir, formatted) } : {}),
  };
}

/** Load the export map and refuse one whose host imports name no file. */
function loadMapFile(path: string): LoadedExportMap {
  const loaded = loadExportMap(absoluteFrom(path));
  const problems = exportMapProblems(loaded);
  if (problems.length > 0) {
    throw new ExportMapError(
      `export map ${loaded.path}: ${problems.join("; ")}`,
    );
  }
  return loaded;
}

type FormatSkips = Array<{ relPath: string; reason: string }>;

/** The nearest existing directory at or above `path` (a spawn cwd for a tree not written yet). */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
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
    ...(built.host ? { host: built.host } : {}),
    ...(built.map
      ? {
          map: {
            file: posixRelative(built.outDir, built.map.path),
            digest: built.map.digest,
            strict: built.map.map.strict === true,
            actions: result.mapped ?? [],
          },
        }
      : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(limitOf(opts) !== undefined ? { maxEvalRatio: limitOf(opts)! } : {}),
    ...(built.refused.length > 0 ? { refused: built.refused } : {}),
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
    // The modes the export was written with (the check regenerates the same).
    ...(opts.preconditions === undefined && manifest.source.preconditions
      ? { preconditions: manifest.source.preconditions }
      : {}),
    ...(opts.verifiers === undefined && manifest.source.verifiers
      ? { verifiers: manifest.source.verifiers }
      : {}),
    ...(opts.gateEnv === undefined && manifest.source.gateEnv
      ? { gateEnv: manifest.source.gateEnv }
      : {}),
    // E8 / E12: the host profile and the eval gate the export was made with.
    ...(opts.hostConfig === undefined && manifest.source.hostConfig
      ? { hostConfig: resolve(dir, manifest.source.hostConfig) }
      : {}),
    ...(opts.maxEvalRatio === undefined &&
    manifest.source.maxEvalRatio !== undefined
      ? { maxEvalRatio: manifest.source.maxEvalRatio }
      : {}),
    ...(opts.allowEvalWithoutBypass === undefined &&
    manifest.source.allowEvalWithoutBypass
      ? { allowEvalWithoutBypass: true }
      : {}),
    // The locator mode the export was made with (the check regenerates it).
    ...(opts.strictLocators === undefined && manifest.source.strictLocators
      ? { strictLocators: true }
      : {}),
    // E9: the export map the export was made with.
    ...(opts.mapFile === undefined && manifest.source.map
      ? { mapFile: resolve(dir, manifest.source.map.file) }
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
        ...(batch.preconditions
          ? {
              expectedPreconditions: batch.preconditions.map((entry) => ({
                ...entry,
                spec: posixRelative(dir, entry.spec),
              })),
            }
          : {}),
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
    if (
      manifest.source.map &&
      built.manifest.source.map?.digest !== manifest.source.map.digest
    ) {
      warnings.push(
        `the export map changed since this export (${manifest.source.map.digest.slice(0, 19)}… → ${(built.manifest.source.map?.digest ?? "none").slice(0, 19)}…)`,
      );
    }
    const report = diffExport({
      exportDir: dir,
      exporterVersion: CAIRN_VERSION,
      previous: manifest,
      expectedFiles: built.generated,
      expectedSpecs: built.manifest.specs,
      ...(built.manifest.preconditions
        ? { expectedPreconditions: built.manifest.preconditions }
        : {}),
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
  projectRoot?: string,
  map?: LoadedExportMap,
): ExportManifestV1["source"] {
  const vars = parseVarFlags(opts.var);
  const digest = varsDigest(vars);
  const modes = resolveExportModes(opts);
  return {
    ...(modes.preconditions ? { preconditions: modes.preconditions } : {}),
    ...(modes.verifiers ? { verifiers: modes.verifiers } : {}),
    ...(modes.gateEnv.length > 0 ? { gateEnv: modes.gateEnv } : {}),
    ...(opts.hostConfig
      ? {
          hostConfig: posixRelative(outDir, absoluteFrom(opts.hostConfig)),
        }
      : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(limitOf(opts) !== undefined ? { maxEvalRatio: limitOf(opts)! } : {}),
    ...(opts.allowEvalWithoutBypass ? { allowEvalWithoutBypass: true } : {}),
    ...(opts.strictLocators ? { strictLocators: true } : {}),
    ...(opts.verifyProject ? { verifyProject: opts.verifyProject } : {}),
    ...(map
      ? { map: { file: posixRelative(outDir, map.path), digest: map.digest } }
      : {}),
    ...(projectRoot ? { projectRoot: posixRelative(outDir, projectRoot) } : {}),
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
  setup: import("../../core/exporters/playwrightExporter").ExportHostSetup;
  specPath: string;
  projectRoot?: string;
  outPath?: string;
}> {
  const modes = resolveExportModes(opts);
  let parsed;
  let envTarget: ExportEnvTarget | undefined;
  let widgets: PreparedWidgets | undefined;
  let envAuth: ExportEnvAuth | undefined;
  let appHandles: Record<string, string> | undefined;
  let datasourceEnv: Record<string, string[]> = {};
  let httpDatasources: Record<string, ExportHttpDatasource> = {};
  let testIdAttribute: string | undefined;
  let projectRoot: string | undefined;
  try {
    ({
      parsed,
      envTarget,
      widgets,
      envAuth,
      appHandles,
      datasourceEnv,
      httpDatasources,
      testIdAttribute,
      projectRoot,
    } = await parseForExport(specPath, opts));
  } catch (e) {
    const err = new Error((e as Error).message);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  // E12: a spec over --max-eval-ratio is refused, not exported.
  const refusal = evalRatioRefusalOf(parsed, limitOf(opts));
  if (refusal) throw new ExportRefusedError([refusal]);
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
    ...(widgets ? { widgets } : {}),
    ...(envAuth ? { envAuth } : {}),
    ...(appHandles ? { appHandles } : {}),
    ...(testIdAttribute ? { testIdAttribute } : {}),
    ...(opts.strictLocators ? { strictLocators: true } : {}),
    // E10: no env value is baked (parseForExport late-binds them).
    lateBoundEnv: true,
    ...(modes.preconditions ? { preconditions: modes.preconditions } : {}),
    ...(modes.verifiers ? { verifiers: modes.verifiers } : {}),
    ...(modes.gateEnv.length > 0 ? { gateEnv: modes.gateEnv } : {}),
    datasourceEnv,
    httpDatasources,
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
    setup: result.setup,
    specPath: parsed.path,
    ...(projectRoot ? { projectRoot } : {}),
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
  modes: ExportModes,
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
    ...(modes.preconditions === "inline"
      ? [
          "## Preconditions (run in each file's beforeAll)",
          "",
          "Exported with `--preconditions inline`: each file runs its preconditions",
          "through a bounded helper (`SKIP_PRECONDITIONS=1` skips them), and `run:`",
          "steps and `teardown:` run in the test body.",
        ]
      : modes.preconditions === "manifest"
        ? [
            "## Preconditions (listed in .cairn-export.json)",
            "",
            "Exported with `--preconditions manifest`: nothing here runs them. The",
            "commands, with `${env.X}` placeholders and a cwd relative to",
            "`source.projectRoot`, are in the manifest's `preconditions` for the host to",
            "run before the suite.",
          ]
        : [
            "## Preconditions (NOT exported - wire into globalSetup or a CI step)",
          ]),
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
  const evals = coverage.evalRatio;
  return `steps ${coverage.stepsExported}/${coverage.stepsTotal}, outcomes ${coverage.outcomesExported}/${coverage.outcomesTotal}${
    evals
      ? `, eval ${evals.evalSteps}/${evals.totalSteps} (${Math.round(evals.ratio * 100)}%)`
      : ""
  }${coverage.fixme ? " — test.fixme" : ""}`;
}

/** The refused specs and the limit, for the markdown reports. */
function refusalMarkdown(refused: ExportRefusal[] | undefined): string[] {
  if (!refused || refused.length === 0) return [];
  return [
    "## Refused (--max-eval-ratio)",
    "",
    ...refused.map(
      (r) =>
        `- ${r.name}: eval ${r.evalSteps}/${r.totalSteps} (${Math.round(r.ratio * 100)}%) is over ${Math.round(r.limit * 100)}% — not exported`,
    ),
    "",
  ];
}

function hostMarkdown(host: ExportHostReport | undefined): string[] {
  if (!host) return [];
  return [
    "## Host profile",
    "",
    `- config: \`${host.config}\``,
    `- module system: ${host.moduleSystem} — ${host.moduleReason}`,
    `- test timeout: ${
      host.testTimeoutMs !== undefined
        ? `${host.testTimeoutMs}ms`
        : "not statically readable (each test sets its own budget)"
    }; testIdAttribute: ${
      host.testIdAttribute ??
      "not statically readable (explicit attribute selectors)"
    }; bypassCSP: ${host.bypassCsp}`,
    ...(host.unread.length > 0
      ? [`- not statically readable: ${host.unread.join(", ")}`]
      : []),
    `- tests: \`${host.testsDir}\` as *${host.testSuffix}.*`,
    `- prettier: ${host.formatted} file(s) formatted${
      host.formatSkipped.length > 0
        ? `, ${host.formatSkipped.length} left as generated`
        : ""
    }`,
    ...host.notes.map((note) => `- ${note}`),
    "",
  ];
}

function toMarkdown(report: ExportPlaywrightReport): string {
  const lines = [
    `# Export Playwright (${report.lang})`,
    "",
    `Status: **${report.status}** — written ${report.summary.written}, partial ${report.summary.partial}, failed ${report.summary.failed}`,
    ...(report.manifest ? ["", `Manifest: \`${report.manifest}\``] : []),
    "",
    ...refusalMarkdown(report.refused),
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
    ...hostMarkdown(report.host),
    ...mapMarkdown(report.map),
    ...refusalMarkdown(report.refused),
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

function mapMarkdown(map: ExportMapReport | undefined): string[] {
  if (!map) return [];
  return [
    `## Export map`,
    ``,
    `File: \`${map.file}\` (${map.digest.slice(0, 19)}…)${
      map.strict ? ", strict" : ""
    }`,
    ``,
    ...(map.actions.length > 0
      ? map.actions.map(
          (entry) =>
            `- ${entry.action}: ${entry.treatment} → ${entry.target} (${entry.specs.join(", ")})${
              entry.note ? ` — ${entry.note}` : ""
            }`,
        )
      : [`- (no action was bound or generated)`]),
    ``,
  ];
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
