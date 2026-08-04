/**
 * PROJECT export: turn a set of Cairntrace specs into a structured Playwright
 * project instead of N monolithic spec files.
 *
 *   out/
 *   ├── README.md            operating manual (env, preconditions, how to run)
 *   ├── playwright.config.ts baseURL/serial/bypassCSP/globalSetup wired
 *   ├── global-setup.ts      deduped spec preconditions as a runnable scaffold
 *   ├── preconditions.ts     filtered env + process-tree timeout runner
 *   ├── actions/<name>.ts    each reusable action (imports:) as ONE exported
 *   │                        `async function(page)` — tests import it instead
 *   │                        of inlining the same login N times
 *   ├── verifiers/<file>.ts  node verifiers copied in (self-contained project)
 *   └── tests/<spec>.spec.ts steps + outcomes; `use:` steps become action calls
 *
 * The same IR/emission layers as the single-file exporter do all rendering —
 * this module only decides FILE STRUCTURE.
 */
import { lstatSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ParseResult } from "../parser/parseSpec";
import type { Spec, Step } from "../schema/spec.v1";
import {
  blank,
  block,
  comment,
  print,
  raw,
  verbatim,
  type Stmt,
} from "./codegen";
import {
  exportExtension,
  hasNodeFileVerifier,
  newEmitCtx,
  oneLine,
  renderNodeVerifierEvidenceRuntime,
  renderNodeVerifierEvidenceSetup,
  renderOutcomeEvidenceSetup,
  renderOutcome,
  renderStep,
  safeIdent,
  type EmitCtx,
  type ExportCoverage,
  type ExportLang,
} from "./playwrightExporter";
import {
  playwrightProjectTimeoutBudget,
  playwrightTestTimeoutBudget,
} from "./playwrightTimeout";
import { emitValue } from "./templateValue";

const DEFAULT_PRECONDITION_TIMEOUT_MS = 120_000;
const MAX_VERIFIER_MODULES = 128;
const MAX_VERIFIER_MODULE_BYTES = 2 * 1024 * 1024;
const MAX_VERIFIER_GRAPH_BYTES = 8 * 1024 * 1024;
const VERIFIER_MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
] as const;

interface ProjectPrecondition {
  name?: string;
  run: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ProjectExportOptions {
  lang?: ExportLang;
  /** baseURL for the generated playwright.config.ts. */
  baseUrl?: string;
}

export interface ProjectFile {
  /** Path relative to the project root (e.g. "tests/foo.spec.ts"). */
  relPath: string;
  source: string;
}

export interface ProjectSpecReport {
  name: string;
  file: string;
  testTimeoutMs: number;
  coverage: ExportCoverage;
  requiredEnv: string[];
  preconditions: string[];
}

export interface ProjectVerifierFile {
  /** Absolute source module path. */
  sourcePath: string;
  /** Destination relative to the generated project root. */
  relPath: string;
}

export interface ProjectExportResult {
  files: ProjectFile[];
  /** Direct verifiers plus their bounded, safe relative dependency closure. */
  verifierFiles: ProjectVerifierFile[];
  specs: ProjectSpecReport[];
  requiredEnv: string[];
}

export function exportPlaywrightProject(
  parsedSpecs: ParseResult[],
  opts: ProjectExportOptions = {},
): ProjectExportResult {
  const lang: ExportLang = opts.lang ?? "ts";
  const ext = exportExtension(lang);
  const files: ProjectFile[] = [];
  const verifierFiles = new Set<string>();
  const specs: ProjectSpecReport[] = [];
  const allEnv = new Set<string>();
  const allPreconditions = new Map<
    string,
    ProjectPrecondition & { specDir: string }
  >();

  // ----- actions: one module per reusable action, deduped by name -----
  const actionModules = new Map<
    string,
    {
      fnName: string;
      relPath: string;
      source: string;
      envNames: string[];
      usesRunToken: boolean;
    }
  >();
  for (const parsed of parsedSpecs) {
    for (const [name, loaded] of parsed.actionsByName) {
      if (actionModules.has(name)) continue;
      const fnName = safeIdent(name);
      const ctx = newEmitCtx(lang, {
        specDir: dirOf(loaded.path),
        verifierImportPrefix: "../verifiers",
        verifierFiles,
      });
      const body: Stmt[] = [];
      for (const step of loaded.action.steps) {
        body.push(...renderStep(step, undefined, ctx).stmts);
      }
      if (ctx.usage.runToken) {
        body.unshift(raw(`const RUN_TOKEN = runToken;`), blank);
      }
      const stmts: Stmt[] = [
        comment(
          `Generated from reusable action ${JSON.stringify(name)} (${loaded.path}).`,
        ),
        comment(`Re-exporting overwrites this file.`),
        blank,
        raw(
          lang === "js"
            ? `import { expect } from "@playwright/test";`
            : `import { expect, type Page } from "@playwright/test";`,
        ),
        blank,
        block(
          `export async function ${fnName}(page${
            lang === "ts" ? ": Page" : ""
          }${
            ctx.usage.runToken
              ? `, runToken${lang === "ts" ? ": string" : ""}`
              : ""
          })${lang === "ts" ? ": Promise<void>" : ""} {`,
          body,
        ),
      ];
      for (const e of ctx.usage.envNames) allEnv.add(e);
      actionModules.set(name, {
        fnName,
        relPath: `actions/${name}${lang === "js" ? ".js" : ".ts"}`,
        source: `${print(stmts)}\n`,
        envNames: [...ctx.usage.envNames],
        usesRunToken: ctx.usage.runToken,
      });
    }
  }
  for (const m of actionModules.values()) {
    files.push({ relPath: m.relPath, source: m.source });
  }

  // ----- tests: use: steps become action calls -----
  for (const parsed of parsedSpecs) {
    const spec = parsed.spec;
    const specDir = dirOf(parsed.path);
    const timeoutBudget = playwrightTestTimeoutBudget(parsed.resolved);
    const steps = spec.steps ?? [];
    const ctx = newEmitCtx(lang, {
      specDir,
      verifierImportPrefix: "../verifiers",
      verifierFiles,
    });
    const needsNodeVerifierEvidence = hasNodeFileVerifier(spec);
    if (needsNodeVerifierEvidence) {
      ctx.nodeVerifierRunDir = "cairnRunDir";
      ctx.nodeVerifierEvidence = "cairnNetworkEvidence";
    }
    ctx.coverage.stepsTotal = steps.length;
    ctx.coverage.outcomesTotal = spec.outcomes.length;

    const usedActions = new Set<string>();
    const body: Stmt[] = [
      comment(
        `Derived from sequential step/outcome budgets; bounded to 30m–4h.`,
      ),
      ...(timeoutBudget.capped
        ? [
            comment(
              `WARNING: authored budgets exceed the 4h export ceiling; split this spec.`,
            ),
          ]
        : []),
      raw(`test.setTimeout(${timeoutBudget.timeoutMs});`),
      blank,
    ];
    const evidenceInsertAt = body.length;
    body.push(...renderOutcomeEvidenceSetup(spec, lang));
    if (steps.length > 0) {
      body.push(comment(`--- steps ---`));
      for (const step of steps) {
        if ("use" in step) {
          const mod = actionModules.get(step.use);
          if (mod) {
            usedActions.add(step.use);
            for (const envName of mod.envNames) {
              ctx.usage.envNames.add(envName);
            }
            if (mod.usesRunToken) ctx.usage.runToken = true;
            body.push(
              comment(`step: ${oneLine(step.id ?? step.use)} (action)`),
              raw(
                `await ${mod.fnName}(page${
                  mod.usesRunToken ? ", RUN_TOKEN" : ""
                });`,
              ),
            );
            ctx.coverage.stepsExported += 1;
            continue;
          }
        }
        const rendered = renderStep(step as Step, spec.settleMs, ctx);
        if (rendered.exported) ctx.coverage.stepsExported += 1;
        body.push(...rendered.stmts);
      }
      body.push(blank);
    }
    body.push(comment(`--- outcomes (the contract) ---`));
    for (const outcome of spec.outcomes) {
      body.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
      const rendered = renderOutcome(outcome, ctx);
      if (rendered.exported) ctx.coverage.outcomesExported += 1;
      body.push(...rendered.stmts, blank);
    }
    if (needsNodeVerifierEvidence) {
      body.splice(
        evidenceInsertAt,
        0,
        ...renderNodeVerifierEvidenceSetup(spec, ctx),
      );
    }

    const specPreconditions = collectPreconditions(spec);
    const preconditionEnv = renderPreconditionEnv(spec.preconditions?.env, ctx);
    const preconditionLines = specPreconditions.map((p) => {
      const resolvedCwd = resolvePreconditionCwd(specDir, p.cwd);
      const timeoutMs = p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
      allPreconditions.set(JSON.stringify([p.run, resolvedCwd, timeoutMs]), {
        ...p,
        cwd: resolvedCwd,
        timeoutMs,
        specDir,
      });
      return `${
        p.name ? `[${p.name}] ` : ""
      }${oneLine(p.run).slice(0, 160)} (cwd: ${resolvedCwd}; timeout: ${timeoutMs}ms)`;
    });

    const head: Stmt[] = [
      comment(
        `Generated by \`cairn export playwright --project\`. Source: ${parsed.path}`,
      ),
      comment(`Intent: ${oneLine(spec.intent)}`),
    ];
    if (preconditionLines.length > 0) {
      head.push(
        comment(`Preconditions run in this file's beforeAll — see README.`),
      );
    }
    head.push(blank, raw(`import { expect, test } from "@playwright/test";`));
    if (needsNodeVerifierEvidence) {
      head.push(
        blank,
        verbatim(renderNodeVerifierEvidenceRuntime(lang).trimEnd().split("\n")),
      );
    }
    if (specPreconditions.length > 0) {
      head.push(
        raw(
          `import { runPrecondition } from "../preconditions${
            lang === "js" ? ".js" : ""
          }";`,
        ),
      );
    }
    for (const name of [...usedActions].toSorted()) {
      const mod = actionModules.get(name)!;
      head.push(
        raw(
          `import { ${mod.fnName} } from "../actions/${name}${
            lang === "js" ? ".js" : ""
          }";`,
        ),
      );
    }
    head.push(...runTokenConst(ctx));
    if (specPreconditions.length > 0) {
      // Cairntrace runs preconditions PER SPEC (pipeline gates, data resets)
      // — beforeAll preserves that semantic; globalSetup alone would gate the
      // suite only once and let test debris pile up between tests.
      head.push(
        blank,
        block(
          `test.beforeAll(async () => {`,
          [
            raw(`if (process.env.SKIP_PRECONDITIONS === "1") return;`),
            ...specPreconditions.map((p) => {
              const resolvedCwd = resolvePreconditionCwd(specDir, p.cwd);
              const timeoutMs = p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
              return raw(
                `await runPrecondition(${JSON.stringify(p.run)}, { cwd: ${JSON.stringify(resolvedCwd)}, timeoutMs: ${timeoutMs}${
                  preconditionEnv ? `, env: ${preconditionEnv}` : ""
                } });`,
              );
            }),
          ],
          `});`,
        ),
      );
    }
    head.push(
      blank,
      block(
        `test(${JSON.stringify(spec.name)}, async ({ page }${
          needsNodeVerifierEvidence ? ", testInfo" : ""
        }) => {`,
        body,
        `});`,
      ),
    );

    for (const e of ctx.usage.envNames) allEnv.add(e);
    const relPath = `tests/${spec.name}${ext}`;
    files.push({ relPath, source: `${print(head)}\n` });
    specs.push({
      name: spec.name,
      file: relPath,
      testTimeoutMs: timeoutBudget.timeoutMs,
      coverage: ctx.coverage,
      requiredEnv: [...ctx.usage.envNames].toSorted(),
      preconditions: preconditionLines,
    });
  }

  if (
    parsedSpecs.some(
      (parsed) => (parsed.spec.preconditions?.commands?.length ?? 0) > 0,
    )
  ) {
    files.push({
      relPath: `preconditions${lang === "js" ? ".js" : ".ts"}`,
      source: renderPreconditionRuntime(lang),
    });
  }

  // ----- executable project metadata -----
  files.push({ relPath: "package.json", source: renderPackageJson(lang) });
  if (lang === "ts") {
    files.push({ relPath: "tsconfig.json", source: renderTsconfig() });
  }

  // ----- playwright.config -----
  files.push({
    relPath: `playwright.config${lang === "js" ? ".js" : ".ts"}`,
    source: renderConfig(
      opts.baseUrl,
      lang,
      playwrightProjectTimeoutBudget(
        parsedSpecs.map((parsed) => parsed.resolved),
      ),
    ),
  });

  // ----- global-setup: one-time stack sanity note (per-spec preconditions
  // run in each file's beforeAll, mirroring cairn semantics) -----
  files.push({
    relPath: `global-setup${lang === "js" ? ".js" : ".ts"}`,
    source: renderGlobalSetup([...allPreconditions.values()], lang),
  });

  // ----- README -----
  files.push({
    relPath: "README.md",
    source: renderProjectReadme(
      specs,
      [...allEnv].toSorted(),
      actionModules,
      lang,
    ),
  });

  return {
    files,
    verifierFiles: collectVerifierFiles(verifierFiles),
    specs,
    requiredEnv: [...allEnv].toSorted(),
  };
}

function runTokenConst(ctx: EmitCtx): Stmt[] {
  if (!ctx.usage.runToken) return [];
  return [
    blank,
    raw(
      `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random().toString(36).slice(2, 10);`,
    ),
  ];
}

function collectPreconditions(spec: Spec): ProjectPrecondition[] {
  const out: ProjectPrecondition[] = [];
  for (const c of spec.preconditions?.commands ?? []) {
    if (typeof c === "string") out.push({ run: c });
    else {
      out.push({
        ...(c.name ? { name: c.name } : {}),
        run: c.run,
        ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
        ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
      });
    }
  }
  return out;
}

function resolvePreconditionCwd(
  specDir: string,
  authoredCwd: string | undefined,
): string {
  return authoredCwd ? resolvePath(specDir, authoredCwd) : specDir;
}

function renderPreconditionEnv(
  env: Record<string, string | number | boolean> | undefined,
  ctx: EmitCtx,
): string | undefined {
  if (env === undefined) return undefined;
  const entries = Object.entries(env).map(
    ([key, value]) =>
      `${JSON.stringify(key)}: String(${emitValue(value, ctx.usage)})`,
  );
  return `{ ${entries.join(", ")} }`;
}

function renderPreconditionRuntime(lang: ExportLang): string {
  const ts = lang === "ts";
  const lines = [
    `// Generated by \`cairn export playwright --project\` — edit knowingly;`,
    `// Runs preconditions with Cairn's child-env and process-tree boundaries.`,
    `import { spawn, spawnSync } from "node:child_process";`,
    ``,
    ...(ts
      ? [
          `interface RunPreconditionOptions {`,
          `  cwd: string;`,
          `  timeoutMs: number;`,
          `  env?: Record<string, string>;`,
          `}`,
          ``,
        ]
      : []),
    `const PUBLISHER_ONLY_ENV_KEYS = new Set(["FILECHEAP_INGEST_TOKEN"]);`,
    `const TVAULT_CONTROL_PREFIX = "TVAULT_";`,
    `const CAIRN_TVAULT_ENV = "CAIRN_TVAULT_ENV";`,
    ``,
    `export async function runPrecondition(command${
      ts ? ": string" : ""
    }, options${ts ? ": RunPreconditionOptions" : ""})${
      ts ? ": Promise<void>" : ""
    } {`,
    `  const env = targetPreconditionEnv(options.env ?? {});`,
    `  await new Promise${ts ? "<void>" : ""}((resolve, reject) => {`,
    `    const windows = process.platform === "win32";`,
    `    const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/bash";`,
    `    const args = windows ? ["/d", "/s", "/c", command] : ["-c", command];`,
    `    const child = spawn(shell, args, {`,
    `      cwd: options.cwd,`,
    `      env,`,
    `      stdio: "inherit",`,
    `    });`,
    `    let settled = false;`,
    `    const finish = (error${ts ? "?: Error" : ""}) => {`,
    `      if (settled) return;`,
    `      settled = true;`,
    `      clearTimeout(timer);`,
    `      if (error) reject(error);`,
    `      else resolve();`,
    `    };`,
    `    const timer = setTimeout(() => {`,
    `      const killed = killProcessTreeSync(child.pid);`,
    `      finish(new Error(`,
    `        "Precondition timed out after " + options.timeoutMs +`,
    `        "ms; killed " + killed.length + " process(es) in the owned tree.",`,
    `      ));`,
    `    }, options.timeoutMs);`,
    `    timer.unref?.();`,
    `    child.once("error", (error) => finish(error));`,
    `    child.once("exit", (code, signal) => {`,
    `      if (settled) return;`,
    `      if (code === 0) finish();`,
    `      else {`,
    `        const detail = signal ? " (signal " + signal + ")" : "";`,
    `        finish(new Error("Precondition failed with exit " + String(code) + detail + "."));`,
    `      }`,
    `    });`,
    `  });`,
    `}`,
    ``,
    `export function targetPreconditionEnv(overrides${
      ts ? ": Record<string, string>" : ""
    } = {})${ts ? ": Record<string, string>" : ""} {`,
    `  const allowedTvaultKeys = new Set(`,
    `    Object.keys(overrides).filter((key) => key.startsWith(TVAULT_CONTROL_PREFIX)),`,
    `  );`,
    `  return Object.fromEntries(`,
    `    Object.entries({ ...process.env, ...overrides }).filter(`,
    `      (entry) =>`,
    `        entry[1] !== undefined &&`,
    `        !PUBLISHER_ONLY_ENV_KEYS.has(entry[0]) &&`,
    `        entry[0] !== CAIRN_TVAULT_ENV &&`,
    `        (!entry[0].startsWith(TVAULT_CONTROL_PREFIX) ||`,
    `          allowedTvaultKeys.has(entry[0])),`,
    `    ),`,
    `  )${ts ? " as Record<string, string>" : ""};`,
    `}`,
    ``,
    `function killProcessTreeSync(rootPid${ts ? ": number | undefined" : ""})${
      ts ? ": number[]" : ""
    } {`,
    `  if (!rootPid || !Number.isInteger(rootPid) || rootPid <= 1) return [];`,
    `  if (process.platform === "win32") {`,
    `    spawnSync("taskkill", ["/pid", String(rootPid), "/t", "/f"], {`,
    `      stdio: "ignore",`,
    `      timeout: 5_000,`,
    `      env: targetPreconditionEnv(),`,
    `    });`,
    `    return [rootPid];`,
    `  }`,
    `  const tree = [rootPid, ...descendantPidsSync(rootPid)];`,
    `  for (const pid of tree.toReversed()) {`,
    `    try {`,
    `      process.kill(pid, "SIGKILL");`,
    `    } catch {`,
    `      // A process may exit between discovery and the signal.`,
    `    }`,
    `  }`,
    `  return tree;`,
    `}`,
    ``,
    `function descendantPidsSync(rootPid${ts ? ": number" : ""})${
      ts ? ": number[]" : ""
    } {`,
    `  const descendants${ts ? ": number[]" : ""} = [];`,
    `  const pending = [rootPid];`,
    `  const seen = new Set(pending);`,
    `  while (pending.length > 0) {`,
    `    const parentPid = pending.shift()${ts ? "!" : ""};`,
    `    for (const childPid of directChildPidsSync(parentPid)) {`,
    `      if (seen.has(childPid)) continue;`,
    `      seen.add(childPid);`,
    `      descendants.push(childPid);`,
    `      pending.push(childPid);`,
    `    }`,
    `  }`,
    `  return descendants;`,
    `}`,
    ``,
    `function directChildPidsSync(pid${ts ? ": number" : ""})${
      ts ? ": number[]" : ""
    } {`,
    `  try {`,
    `    const result = spawnSync("pgrep", ["-P", String(pid)], {`,
    `      encoding: "utf8",`,
    `      timeout: 2_000,`,
    `      env: targetPreconditionEnv(),`,
    `    });`,
    `    if (typeof result.stdout !== "string") return [];`,
    `    return result.stdout`,
    `      .split("\\n")`,
    `      .map((line) => Number(line.trim()))`,
    `      .filter((childPid) => Number.isInteger(childPid) && childPid > 1);`,
    `  } catch {`,
    `    return [];`,
    `  }`,
    `}`,
    ``,
  ];
  return `${lines.join("\n")}\n`;
}

function renderConfig(
  baseUrl: string | undefined,
  lang: ExportLang,
  timeoutBudget: ReturnType<typeof playwrightProjectTimeoutBudget>,
): string {
  const lines = [
    `// Generated by \`cairn export playwright --project\` — edit knowingly;`,
    `// re-exporting overwrites this file.`,
    `import { defineConfig } from "@playwright/test";`,
    ``,
    `export default defineConfig({`,
    `  testDir: "./tests",`,
    `  // Specs share one backend pipeline — they must never overlap.`,
    `  workers: 1,`,
    `  fullyParallel: false,`,
    `  // Maximum derived test/precondition budget; individual tests narrow it.`,
    ...(timeoutBudget.capped
      ? [
          `  // WARNING: at least one authored budget exceeds the 4h export ceiling; split it.`,
        ]
      : []),
    `  timeout: ${timeoutBudget.timeoutMs},`,
    `  globalSetup: "./global-setup",`,
    `  use: {`,
    ...(baseUrl ? [`    baseURL: ${JSON.stringify(baseUrl)},`] : []),
    `    headless: true,`,
    `    // The app ships a strict CSP (script-src without unsafe-eval) which`,
    `    // blocks exported string-eval steps — standard test-context bypass.`,
    `    bypassCSP: true,`,
    `  },`,
    `  reporter: [["list"]],`,
    `});`,
    ``,
  ];
  return lines.join("\n");
}

function renderPackageJson(lang: ExportLang): string {
  const scripts =
    lang === "ts"
      ? { test: "playwright test", typecheck: "tsc --noEmit" }
      : { test: "playwright test" };
  const devDependencies: Record<string, string> = {
    "@playwright/test": "^1.61.1",
  };
  if (lang === "ts") {
    devDependencies["@types/node"] = "^22.20.1";
    devDependencies.typescript = "^5.9.3";
  }
  return `${JSON.stringify(
    {
      name: "cairntrace-playwright-export",
      private: true,
      type: "module",
      scripts,
      devDependencies,
    },
    null,
    2,
  )}\n`;
}

function renderTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: ["node"],
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        skipLibCheck: true,
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules", "test-results"],
    },
    null,
    2,
  )}\n`;
}

function collectVerifierFiles(entries: Set<string>): ProjectVerifierFile[] {
  const copiedByDestination = new Map<string, string>();
  const visited = new Set<string>();
  let totalBytes = 0;

  const visit = (sourcePath: string, root: string): void => {
    const absolutePath = resolvePath(sourcePath);
    if (visited.has(absolutePath)) return;
    assertSafeVerifierModule(absolutePath, root);
    const source = readFileSync(absolutePath, "utf8");
    const bytes = Buffer.byteLength(source);
    if (bytes > MAX_VERIFIER_MODULE_BYTES) {
      throw new Error(
        `Verifier module exceeds ${MAX_VERIFIER_MODULE_BYTES} bytes: ${absolutePath}`,
      );
    }
    if (visited.size >= MAX_VERIFIER_MODULES) {
      throw new Error(
        `Verifier dependency graph exceeds ${MAX_VERIFIER_MODULES} modules`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_VERIFIER_GRAPH_BYTES) {
      throw new Error(
        `Verifier dependency graph exceeds ${MAX_VERIFIER_GRAPH_BYTES} bytes`,
      );
    }

    const moduleRelativePath = relative(root, absolutePath)
      .split(sep)
      .join("/");
    const destination = `verifiers/${moduleRelativePath}`;
    const collision = copiedByDestination.get(destination);
    if (collision && collision !== absolutePath) {
      throw new Error(
        `Verifier copy collision at ${destination}: ${collision} and ${absolutePath}`,
      );
    }
    copiedByDestination.set(destination, absolutePath);
    visited.add(absolutePath);

    for (const specifier of staticRelativeModuleSpecifiers(source)) {
      const dependency = resolveVerifierDependency(
        absolutePath,
        specifier,
        root,
      );
      visit(dependency, root);
    }
  };

  for (const entry of [...entries].toSorted()) {
    const absoluteEntry = resolvePath(entry);
    try {
      visit(absoluteEntry, dirname(absoluteEntry));
    } catch (error) {
      // Keep the renderer usable with synthetic ParseResults. The CLI copy
      // still fails closed when this source is read; only real files can have
      // a transitive dependency graph.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const destination = `verifiers/${basename(absoluteEntry)}`;
      const collision = copiedByDestination.get(destination);
      if (collision && collision !== absoluteEntry) {
        throw new Error(
          `Verifier copy collision at ${destination}: ${collision} and ${absoluteEntry}`,
          { cause: error },
        );
      }
      copiedByDestination.set(destination, absoluteEntry);
    }
  }

  return [...copiedByDestination]
    .map(([relPath, sourcePath]) => ({ sourcePath, relPath }))
    .toSorted((a, b) => a.relPath.localeCompare(b.relPath));
}

function staticRelativeModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
  }
  return [...specifiers].toSorted();
}

function resolveVerifierDependency(
  importer: string,
  specifier: string,
  root: string,
): string {
  if (specifier.includes("?") || specifier.includes("#")) {
    throw new Error(
      `Verifier dependency specifiers cannot contain query/hash suffixes: ${specifier} (${importer})`,
    );
  }
  const unresolved = resolvePath(dirname(importer), specifier);
  const extension = extname(unresolved);
  const candidates = extension
    ? [
        unresolved,
        ...(extension === ".js"
          ? [unresolved.slice(0, -3) + ".ts", unresolved.slice(0, -3) + ".tsx"]
          : []),
      ]
    : [
        ...VERIFIER_MODULE_EXTENSIONS.map((ext) => unresolved + ext),
        ...VERIFIER_MODULE_EXTENSIONS.map((ext) =>
          resolvePath(unresolved, `index${ext}`),
        ),
      ];
  for (const candidate of candidates) {
    if (!isPathInside(root, candidate)) {
      throw new Error(
        `Verifier dependency escapes its module directory: ${specifier} (${importer})`,
      );
    }
    try {
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Verifier dependency cannot be a symlink: ${candidate}`,
        );
      }
      if (stats.isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `Cannot resolve verifier dependency ${JSON.stringify(specifier)} from ${importer}`,
  );
}

function assertSafeVerifierModule(sourcePath: string, root: string): void {
  if (!isPathInside(root, sourcePath)) {
    throw new Error(
      `Verifier module escapes its module directory: ${sourcePath}`,
    );
  }
  const extension = extname(sourcePath);
  if (
    !VERIFIER_MODULE_EXTENSIONS.some((candidate) => candidate === extension)
  ) {
    throw new Error(`Unsupported verifier module extension: ${sourcePath}`);
  }
  const stats = lstatSync(sourcePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Verifier module cannot be a symlink: ${sourcePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Verifier module is not a regular file: ${sourcePath}`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(candidate));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function renderGlobalSetup(
  preconditions: Array<ProjectPrecondition & { specDir: string }>,
  lang: ExportLang,
): string {
  const names = preconditions
    .map(
      (p) =>
        `//   - ${p.name ?? oneLine(p.run).slice(0, 80)} (cwd: ${p.cwd ?? p.specDir}; timeout: ${p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS}ms)`,
    )
    .join("\n");
  return `// Generated by \`cairn export playwright --project\`.
//
// Per-spec preconditions run in each test file's beforeAll (mirroring the
// Cairntrace per-spec semantics — a single global gate would let backend
// debris pile up between tests). This hook is the place for ONE-TIME suite
// setup (auth warmup, seeding); it currently only logs. Known per-spec
// preconditions, for reference:
${names}
export default async function globalSetup()${
    lang === "ts" ? ": Promise<void>" : ""
  } {
  console.log("[global-setup] per-spec preconditions run in each file's beforeAll");
}
`;
}

function renderProjectReadme(
  specs: ProjectSpecReport[],
  env: string[],
  actions: Map<
    string,
    { fnName: string; relPath: string; usesRunToken: boolean }
  >,
  lang: ExportLang,
): string {
  const lines = [
    "# Exported Playwright project",
    "",
    "Generated by `cairn export playwright --project` from Cairntrace specs —",
    "the specs remain the source of truth; re-exporting overwrites these files.",
    "",
    "```",
    "package.json          installable @playwright/test + typecheck scripts",
    ...(lang === "ts"
      ? ["tsconfig.json         strict TS/DOM config; portable .ts imports"]
      : []),
    "playwright.config.*   serial, bypassCSP, derived timeout, globalSetup wired",
    "global-setup.*        spec preconditions (data resets, pipeline gates)",
    "preconditions.*       filtered env + process-tree timeout runner",
    "actions/              shared UI flows (login, …) imported by tests",
    "verifiers/            node-context durable-processing verifiers (copied)",
    "tests/                one spec file per Cairntrace spec",
    "```",
    "",
    "## Run",
    "",
    "```bash",
    "npm install",
    "npx playwright install chromium",
    ...(lang === "ts" ? ["npm run typecheck"] : []),
    "npm test",
    "```",
    "",
    "Tests with node file verifiers create a per-test `cairn-run/network/requests.ndjson` under Playwright's output directory and pass that run directory to every verifier. The capture omits headers, retains only bounded valid-JSON request bodies, redacts configured/late-bound secrets, and fails closed when a PATCH response cannot be completed or persisted.",
    "",
    "## Required environment",
    "",
    env.length > 0
      ? "Provide from ANY secret source (CI secrets, dotenv, a vault CLI):"
      : "No secret env vars required.",
    ...env.map((e) => `- \`${e}\``),
    "",
    "Optional:",
    "- `CAIRN_RUN_TOKEN` — pins the per-run uniqueness token (default: random per run).",
    "- `CAIRN_COMPLETION_TIMEOUT_MS` — widens verifier completion waits on slow machines.",
    "- `SKIP_PRECONDITIONS=1` — skip global-setup preconditions (wire your own in CI).",
    "- `MONGO_URI` — point verifiers at a remote MongoDB instead of local docker.",
    "",
    "## Actions",
    "",
    ...[...actions.entries()].map(
      ([name, a]) =>
        `- \`${a.relPath}\` → \`${a.fnName}(page${
          a.usesRunToken ? ", runToken" : ""
        })\` (from action \`${name}\`)`,
    ),
    "",
    "## Specs",
    "",
  ];
  for (const s of specs) {
    lines.push(
      `### ${s.name} (\`${s.file}\`)`,
      `- coverage: steps ${s.coverage.stepsExported}/${s.coverage.stepsTotal}, outcomes ${s.coverage.outcomesExported}/${s.coverage.outcomesTotal}`,
      `- test timeout: ${formatDuration(s.testTimeoutMs)} (derived from sequential budgets; 4h ceiling)`,
      ...(s.preconditions.length > 0
        ? [`- preconditions:`, ...s.preconditions.map((p) => `  - ${p}`)]
        : []),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}
