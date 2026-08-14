import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  exportExtension,
  exportPlaywright,
  type ExportCoverage,
  type ExportLang,
} from "../../core/exporters/playwrightExporter";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import { parseSpec } from "../../core/parser/parseSpec";
import { emit, resolveFormat } from "../format";
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
    const result = await exportOne(paths[0]!, lang, opts);
    process.stdout.write(result.source);
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
    await exportProject(paths, lang, { ...opts, outDir: dest }, specPath);
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
  const readmeInfo: Array<{
    name: string;
    file: string;
    requiredEnv: string[];
    preconditions: string[];
  }> = [];
  let failed = 0;
  for (const p of paths) {
    try {
      const exported = await exportOne(p, lang, opts);
      const outPath =
        exported.outPath ?? resolveOutPath(p, exported.name, lang, opts);
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
      readmeInfo.push({
        name: exported.name,
        file: outPath.split("/").pop() ?? outPath,
        requiredEnv: exported.requiredEnv,
        preconditions: exported.preconditions,
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

  // A generated suite must carry its own operating manual: which env vars to
  // provide (from ANY secret source - no cairn/tvault dependency), which
  // preconditions to wire into globalSetup, and how to run. Written on every
  // batch export so it stays in sync with the tests.
  if (opts.outDir && readmeInfo.length > 0) {
    const readmePath = resolve(
      isAbsolute(opts.outDir)
        ? opts.outDir
        : resolve(process.cwd(), opts.outDir),
      "README.md",
    );
    await writeFile(readmePath, renderReadme(readmeInfo));
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

async function parseForExport(
  specPath: string,
  opts: ExportPlaywrightOptions,
): Promise<{
  parsed: Awaited<ReturnType<typeof parseSpec>>;
  baseUrl?: string;
  projectRoot?: string;
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
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
    runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
  });
  const viewport = parsed.spec.viewport ?? runtime.viewport;
  return {
    parsed,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.configPath
      ? { projectRoot: dirname(runtime.configPath) }
      : { projectRoot: dirname(parsed.path) }),
    ...(runtime.config?.browser?.testIdAttribute
      ? { testIdAttribute: runtime.config.browser.testIdAttribute }
      : {}),
    ...(viewport ? { viewport } : {}),
  };
}

async function exportProject(
  paths: string[],
  lang: ExportLang,
  opts: ExportPlaywrightOptions,
  inputPath: string,
): Promise<void> {
  const { exportPlaywrightProject } = await import(
    "../../core/exporters/playwrightProject"
  );
  const outDir = isAbsolute(opts.outDir!)
    ? opts.outDir!
    : resolve(process.cwd(), opts.outDir!);

  const parsedSpecs = [];
  let baseUrl: string | undefined;
  let projectRoot: string | undefined;
  let testIdAttribute: string | undefined;
  let viewport: { width: number; height: number } | undefined;
  for (const p of paths) {
    const r = await parseForExport(p, opts);
    parsedSpecs.push(r.parsed);
    baseUrl = baseUrl ?? r.baseUrl;
    projectRoot = projectRoot ?? r.projectRoot;
    testIdAttribute = testIdAttribute ?? r.testIdAttribute;
    viewport = viewport ?? r.viewport;
  }

  const absInput = isAbsolute(inputPath)
    ? inputPath
    : resolve(process.cwd(), inputPath);
  const sourceRoot = (await stat(absInput)).isDirectory()
    ? absInput
    : dirname(absInput);

  const result = exportPlaywrightProject(parsedSpecs, {
    lang,
    outDir,
    sourceRoot,
    ...(baseUrl ? { baseUrl } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(testIdAttribute ? { testIdAttribute } : {}),
    ...(viewport ? { viewport } : {}),
    ...(opts.into ? { into: true } : {}),
  });

  for (const f of result.files) {
    const abs = join(outDir, f.relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.source);
  }
  // Self-contained project: copy referenced node verifiers in.
  for (const v of [...result.verifierFiles, ...result.evalFiles]) {
    const dest = join(outDir, v.relPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(v.sourcePath, "utf8"));
  }

  const report = {
    status: "written",
    lang,
    outDir,
    files: result.files.map((f) => f.relPath),
    verifiersCopied: result.verifierFiles.map((v) => v.relPath),
    requiredEnv: result.requiredEnv,
    specs: result.specs.map((s) => ({
      name: s.name,
      file: s.file,
      coverage: s.coverage,
    })),
  };
  const format = resolveFormat(opts, "md");
  if (format === "json" || format === "yaml") {
    process.stdout.write(emit(format, report, () => ""));
  } else {
    const lines = [
      `# Export Playwright project`,
      ``,
      `Out: \`${outDir}\``,
      ``,
      ...result.files.map((f) => `- ${f.relPath}`),
      ...result.verifierFiles.map((v) => `- ${v.relPath} (copied)`),
      ...result.evalFiles.map((v) => `- ${v.relPath} (copied)`),
      ``,
      `Required env: ${result.requiredEnv.join(", ") || "none"}`,
      ``,
      ...result.specs.map(
        (s) =>
          `- ${s.name}: steps ${s.coverage.stepsExported}/${s.coverage.stepsTotal}, outcomes ${s.coverage.outcomesExported}/${s.coverage.outcomesTotal}`,
      ),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
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
  outPath?: string;
}> {
  let parsed;
  try {
    ({ parsed } = await parseForExport(specPath, opts));
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
  });
  return {
    source: result.source,
    name: parsed.spec.name,
    coverage: result.coverage,
    requiredEnv: result.requiredEnv,
    preconditions: result.preconditions,
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
