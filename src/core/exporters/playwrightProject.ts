/**
 * PROJECT export: turn a set of Cairntrace specs into a structured Playwright
 * project instead of N monolithic spec files.
 *
 *   out/
 *   ├── README.md            operating manual (env, preconditions, coverage, risks)
 *   ├── .cairn-export.json   manifest: versions, digests, file hashes (`--check`)
 *   ├── playwright.config.ts baseURL/serial/bypassCSP/globalSetup wired
 *   ├── global-setup.ts      one-time suite hook (per-spec preconditions are NOT here)
 *   ├── preconditions.ts     filtered env + process-tree timeout runner
 *   ├── lib/                 shared runtime (evidence, fill retry, click.until,
 *   │                        splices, fixtures, project root)
 *   ├── actions/<name>.ts    each reusable action as `async function(page, vars?)`
 *   │                        — call-site vars are arguments, not inlined steps;
 *   │                        captured `assign:` values are returned to callers
 *   ├── fixtures/            upload files copied in (relocatable)
 *   ├── verifiers/<file>.ts  node verifiers copied in (self-contained project)
 *   └── tests/<spec>.spec.ts steps + outcomes; `use:` steps become action calls;
 *                            preconditions run in each file's beforeAll
 *
 * The same IR/emission layers as the single-file exporter do all rendering —
 * this module only decides FILE STRUCTURE.
 */
import { createHash } from "node:crypto";
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
import { CAIRN_VERSION } from "../../cli/version";
import { computeContractHash } from "../contractHash";
import { realpathNearest } from "./exportManifest";
import { type ExportEnvTarget, renderRequiresEnvGuard } from "./requiresGuard";
import {
  parseReusableAction,
  type LoadedAction,
  type ParseResult,
} from "../parser/parseSpec";
import type { Spec, Step } from "../schema/spec.v1";
import { useActionName, useActionVars } from "../schema/spec.v1";
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
  addGeneratedSourceRisks,
  addRisk,
  addSpecRisks,
  exportExtension,
  finalizeCoverage,
  hasNodeFileVerifier,
  newEmitCtx,
  oneLine,
  referencedRuntimeRefs,
  renderBindingDeclarations,
  renderNodeVerifierEvidenceRuntime,
  renderNodeVerifierEvidenceSetup,
  renderOutcomeEvidenceSetup,
  renderOutcome,
  renderStep,
  safeIdent,
  specNeedsNetworkListener,
  type EmitCtx,
  type ExportCoverage,
  type ExportCoverageSkip,
  type ExportLang,
  type ExportSemanticRisk,
  usesExpectCall,
} from "./playwrightExporter";
import {
  isDocumentaryPrecondition,
  playwrightPreconditionTimeoutBudget,
  playwrightProjectTimeoutBudget,
  playwrightTestTimeoutBudget,
  timeoutBudgetComment,
} from "./playwrightTimeout";
import {
  assertNoLateBoundLeak,
  emitStr,
  emitValue,
  humanizeSentinels,
  RUN_TOKEN_SENTINEL,
  runtimeRefKey,
  varRefSentinel,
  type RefUsage,
} from "./templateValue";
import {
  playwrightLibRelPath,
  renderClickUntilRuntime,
  renderFixturesRuntime,
  renderHydrationRuntime,
  renderProjectRootRuntime,
  renderSpliceRuntime,
  renderVerifierRuntime,
  type PlaywrightLibModule,
} from "./playwrightRuntime";

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
  /**
   * The environment `baseUrl` came from: every test's requires guard is
   * tied to it, and a policy refusal there is an `envPolicy` risk.
   */
  envTarget?: ExportEnvTarget;
  /**
   * Emit into an existing Playwright tree: actions/lib/tests/verifiers/README
   * only — no package.json, tsconfig, playwright.config, or global-setup.
   */
  into?: boolean;
  /**
   * Directory that spec paths are nested under. Specs below this keep their
   * relative folders (`resilience/foo.yml` → `tests/resilience/<name>.spec.ts`).
   */
  sourceRoot?: string;
  /**
   * Source project root used to make precondition cwd / verifier specDir
   * relocatable via `CAIRN_PROJECT_ROOT` / `lib/projectRoot`.
   */
  projectRoot?: string;
  /** Absolute generated-project directory; used to compute projectRoot relative URL. */
  outDir?: string;
  /**
   * `${config.dir}` for re-parsed reusable actions: the resolved config's
   * directory (honours an explicit `--config`). The cwd when omitted.
   */
  configDir?: string;
  testIdAttribute?: string;
  viewport?: { width: number; height: number };
  /**
   * Copy upload files into `fixtures/` and read them via `cairnFixturePath`.
   * The caller must then write `ProjectExportResult.fixtureFiles` (the CLI
   * does). Off by default so writers that only persist `files` keep working
   * (uploads then reference the resolved absolute source path).
   */
  copyFixtures?: boolean;
  /** The caller writes `.cairn-export.json` (the CLI does); listed in README. */
  writesManifest?: boolean;
}

export interface ProjectFile {
  /** Path relative to the project root (e.g. "tests/foo.spec.ts"). */
  relPath: string;
  source: string;
}

export interface ProjectSpecReport {
  name: string;
  file: string;
  /** Absolute source spec path. */
  sourcePath: string;
  /** sha256 contract hash (intent + outcomes) at export time. */
  contractHash: string;
  /** sha256 over the spec source and every imported action source. */
  sourceDigest: string;
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
  /** eval.file sources copied to evals/ for review. */
  evalFiles: ProjectVerifierFile[];
  /** Upload fixtures copied to fixtures/ (paths rewritten to cairnFixturePath). */
  fixtureFiles: ProjectVerifierFile[];
  specs: ProjectSpecReport[];
  requiredEnv: string[];
}

interface ActionModule {
  fnName: string;
  relPath: string;
  source: string;
  envNames: string[];
  usesRunToken: boolean;
  hasVars: boolean;
  declaredKeys: string[];
  defaults: Record<string, string | number | boolean>;
  /** Runtime bindings the action captures and returns (`requests:x`, …). */
  produces: Map<
    string,
    { source: "requests" | "evals" | "artifacts"; name: string }
  >;
  /** Skips/risks inside the action; propagated into every calling test. */
  coverage: ExportCoverage;
}

export function exportPlaywrightProject(
  parsedSpecs: ParseResult[],
  opts: ProjectExportOptions = {},
): ProjectExportResult {
  const lang: ExportLang = opts.lang ?? "ts";
  const ext = exportExtension(lang);
  const files: ProjectFile[] = [];
  const verifierFiles = new Set<string>();
  const fixtureFiles = new Map<string, string>();
  const specs: ProjectSpecReport[] = [];
  const allEnv = new Set<string>();
  let needsProjectRoot = false;
  const allPreconditions = new Map<
    string,
    ProjectPrecondition & { specDir: string }
  >();
  const projectRoot = opts.projectRoot
    ? realpathNearest(resolvePath(opts.projectRoot))
    : undefined;

  // ----- actions: one module per reusable action, deduped by name -----
  const projectUsedLib = new Set<PlaywrightLibModule>();
  const evalFiles = new Set<string>();
  const actionModules = new Map<string, ActionModule>();
  for (const parsed of parsedSpecs) {
    // A11: an action that `use:`s another (its own imports) calls that
    // action's module, so nested modules are emitted first.
    const emitAction = (name: string, loaded: LoadedAction): void => {
      if (actionModules.has(name)) return;
      for (const step of loaded.action.steps) {
        if (!("use" in step)) continue;
        const nestedName = useActionName(step);
        const nested =
          loaded.scope?.get(nestedName) ?? parsed.actionsByName.get(nestedName);
        if (nested && nested !== loaded) emitAction(nestedName, nested);
      }
      const actionLib = new Set<PlaywrightLibModule>();
      const emitted = emitActionModule(loaded, parsed.vars ?? {}, lang, {
        verifierFiles,
        evalFiles,
        ...(opts.copyFixtures ? { fixtureFiles } : {}),
        usedLib: actionLib,
        ...(projectRoot ? { projectRoot } : {}),
        ...(opts.configDir ? { configDir: opts.configDir } : {}),
        nestedModules: actionModules,
      });
      for (const libName of actionLib) projectUsedLib.add(libName);
      for (const e of emitted.envNames) allEnv.add(e);
      actionModules.set(name, emitted);
    };
    for (const [name, loaded] of parsed.actionsByName) {
      emitAction(name, loaded);
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
    const relPath = testRelPath(parsed, opts.sourceRoot, ext);
    const importRoot = importRootFromTestRel(relPath);
    const extName = lang === "js" ? ".js" : "";
    const specDirRel = projectRelative(projectRoot, specDir);
    const ctx = newEmitCtx(lang, {
      specDir,
      verifierImportPrefix: `${importRoot}/verifiers`,
      verifierFiles,
      evalFiles,
      ...(opts.copyFixtures ? { fixtureFiles } : {}),
      ...(projectRoot ? { fixtureRoot: projectRoot } : {}),
      wrapSteps: true,
      libImportPrefix: `${importRoot}/lib`,
      usedLib: new Set<PlaywrightLibModule>(),
      // The test's OWN steps/outcomes: a splice inside an action is bound and
      // consumed in the action module, never in the calling test.
      referencedRefs: referencedRuntimeRefs(parsed.spec),
      ...(specDirRel !== undefined
        ? { specDirExpr: `cairnProjectPath(${JSON.stringify(specDirRel)})` }
        : {}),
    });
    const needsNodeVerifierEvidence = hasNodeFileVerifier(spec);
    if (needsNodeVerifierEvidence) {
      ctx.nodeVerifierRunDir = "cairnRunDir";
      ctx.nodeVerifierEvidence = "cairnNetworkEvidence";
      ctx.usedLib?.add("networkEvidence");
      ctx.usedLibNames?.add("createCairnNetworkEvidence");
    }
    if (specNeedsNetworkListener(spec)) ctx.networkRecorder = "requests";
    ctx.coverage.stepsTotal = steps.length;
    ctx.coverage.outcomesTotal = spec.outcomes.length;

    const usedActions = new Set<string>();
    const body: Stmt[] = [
      comment(timeoutBudgetComment(timeoutBudget)),
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
    const bindingsInsertAt = body.length;
    let actionCallCounter = 0;
    if (steps.length > 0) {
      body.push(comment(`--- steps ---`));
      let resolvedIdx = 0;
      for (const step of steps) {
        if ("use" in step) {
          const actionName = useActionName(step);
          const loaded = parsed.actionsByName.get(actionName);
          const expandedCount =
            loaded?.expandedStepCount ?? loaded?.action.steps.length ?? 0;
          const mod = actionModules.get(actionName);
          if (mod) {
            usedActions.add(actionName);
            for (const envName of mod.envNames) {
              ctx.usage.envNames.add(envName);
            }
            if (mod.usesRunToken) ctx.usage.runToken = true;
            propagateActionCoverage(ctx.coverage, mod, step.id ?? actionName);
            const passed = resolveActionCallVars(
              mod.declaredKeys,
              mod.defaults,
              parsed.vars ?? {},
              useActionVars(step),
            );
            const call = `await ${mod.fnName}(${formatActionCallArgs(passed, mod, ctx)})`;
            // Bindings the action returns that this spec later splices.
            const needed = [...mod.produces].filter(([key]) =>
              ctx.referencedRefs?.has(key),
            );
            const callStmts: Stmt[] = [];
            if (needed.length > 0) {
              actionCallCounter += 1;
              const result = `cairnAction${actionCallCounter}`;
              callStmts.push(raw(`const ${result} = ${call};`));
              for (const [key, produced] of needed) {
                const ident = declareProjectBinding(
                  ctx,
                  key,
                  `cairn${capitalize(produced.source)}_${safeIdent(produced.name)}`,
                );
                callStmts.push(
                  raw(
                    `${ident} = ${result}.${produced.source}[${JSON.stringify(produced.name)}];`,
                  ),
                );
                ctx.usage.bindings.set(key, ident);
              }
            } else {
              callStmts.push(raw(`${call};`));
            }
            body.push(
              comment(`step: ${oneLine(step.id ?? actionName)} (action)`),
              ...(ctx.wrapSteps && step.id
                ? [
                    block(
                      `await test.step(${JSON.stringify(oneLine(step.id))}, async () => {`,
                      callStmts,
                      `});`,
                    ),
                  ]
                : callStmts),
            );
            ctx.coverage.stepsExported += 1;
            resolvedIdx += expandedCount;
            continue;
          }
          resolvedIdx += expandedCount;
          ctx.stepIndex = resolvedIdx - 1;
        } else {
          ctx.stepIndex = resolvedIdx;
          resolvedIdx += 1;
        }
        const rendered = renderStep(step as Step, spec.settleMs, ctx);
        if (rendered.exported) ctx.coverage.stepsExported += 1;
        body.push(...rendered.stmts);
      }
      delete ctx.stepIndex;
      body.push(blank);
    }
    body.push(comment(`--- outcomes (the contract) ---`));
    for (const outcome of spec.outcomes) {
      body.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
      const rendered = renderOutcome(outcome, ctx);
      if (rendered.exported) ctx.coverage.outcomesExported += 1;
      if (ctx.wrapSteps) {
        body.push(
          block(
            `await test.step(${JSON.stringify(outcome.id)}, async () => {`,
            rendered.stmts,
            `});`,
          ),
          blank,
        );
      } else {
        body.push(...rendered.stmts, blank);
      }
    }
    body.splice(bindingsInsertAt, 0, ...renderBindingDeclarations(ctx));
    if (needsNodeVerifierEvidence) {
      body.splice(
        evidenceInsertAt,
        0,
        ...renderNodeVerifierEvidenceSetup(spec, ctx),
      );
    }

    const specPreconditions = collectPreconditions(spec);
    const executablePreconditions = specPreconditions.filter(
      (p) => !isDocumentaryPrecondition(p.run),
    );
    const preconditionEnv = renderPreconditionEnv(spec.preconditions?.env, ctx);
    const usesProjectRoot = projectRoot !== undefined;
    const preconditionLines = specPreconditions.map((p) => {
      const resolvedCwd = resolvePreconditionCwd(specDir, p.cwd);
      const timeoutMs = p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
      allPreconditions.set(JSON.stringify([p.run, resolvedCwd, timeoutMs]), {
        ...p,
        cwd: resolvedCwd,
        timeoutMs,
        specDir,
      });
      return humanizeSentinels(
        `${
          p.name ? `[${p.name}] ` : ""
        }${oneLine(p.run).slice(0, 160)} (cwd: ${displayPath(
          projectRoot,
          resolvedCwd,
        )}; timeout: ${timeoutMs}ms)`,
      );
    });
    const preconditionBudget = playwrightPreconditionTimeoutBudget(spec);
    const preconditionStmts =
      executablePreconditions.length > 0
        ? executablePreconditions.map((p) => {
            const cwdExpr = emitPreconditionCwd(specDir, p.cwd, projectRoot);
            const timeoutMs = p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
            return raw(
              `await runPrecondition(${emitStr(p.run, ctx.usage)}, { cwd: ${cwdExpr}, timeoutMs: ${timeoutMs}${
                preconditionEnv ? `, env: ${preconditionEnv}` : ""
              } });`,
            );
          })
        : [];

    const testBodySource = print(body);
    const usesProjectPath = testBodySource.includes("cairnProjectPath(");
    const usesProjectRootFn =
      usesProjectRoot && executablePreconditions.length > 0;
    if (usesProjectPath || usesProjectRootFn) needsProjectRoot = true;

    const head: Stmt[] = [
      comment(
        `Generated by \`cairn export playwright --project\`. Source: ${displayPath(projectRoot, parsed.path)}`,
      ),
      comment(`Intent: ${oneLine(spec.intent)}`),
    ];
    if (preconditionLines.length > 0) {
      head.push(
        comment(
          executablePreconditions.length > 0
            ? `Preconditions run in this file's beforeAll — see README.`
            : `Documentary preconditions only (echo) — nothing runs before this test.`,
        ),
      );
    }
    const usesExpect = usesExpectCall(
      testBodySource + preconditionStmts.map((s) => print([s])).join("\n"),
    );
    head.push(
      blank,
      raw(
        `import { ${
          usesExpect ? "expect, " : ""
        }test } from "@playwright/test";`,
      ),
    );
    if (usesProjectRootFn) {
      head.push(raw(`import { join } from "node:path";`));
    }
    const projectRootNames = [
      ...(usesProjectPath ? ["cairnProjectPath"] : []),
      ...(usesProjectRootFn ? ["cairnProjectRoot"] : []),
    ];
    if (projectRootNames.length > 0) {
      head.push(
        raw(
          `import { ${projectRootNames.join(", ")} } from ${JSON.stringify(`${importRoot}/lib/projectRoot${extName}`)};`,
        ),
      );
    }
    if (ctx.usage.splice || ctx.usage.unresolvedHelper) {
      ctx.usedLib?.add("splice");
      if (ctx.usage.splice) ctx.usedLibNames?.add("cairnSplice");
      if (ctx.usage.unresolvedHelper) {
        ctx.usedLibNames?.add("cairnUnresolvedSplice");
      }
    }
    head.push(
      ...libImportStmts(ctx.usedLibNames ?? new Set(), lang, importRoot),
    );
    if (needsNodeVerifierEvidence && !ctx.libImportPrefix) {
      head.push(
        blank,
        verbatim(renderNodeVerifierEvidenceRuntime(lang).trimEnd().split("\n")),
      );
    }
    if (executablePreconditions.length > 0) {
      head.push(
        raw(
          `import { runPrecondition } from ${JSON.stringify(`${importRoot}/preconditions${extName}`)};`,
        ),
      );
    }
    for (const name of [...usedActions].toSorted()) {
      const mod = actionModules.get(name)!;
      head.push(
        raw(
          `import { ${mod.fnName} } from ${JSON.stringify(`${importRoot}/actions/${name}${extName}`)};`,
        ),
      );
    }
    head.push(...runTokenConst(ctx));

    addSpecRisks(parsed.resolved, ctx, {
      ...readOptional(parsed.path),
      extraSourceTexts: [...parsed.actionsByName.values()].map(
        (loaded) => loaded.rawSource,
      ),
    });
    finalizeCoverage(ctx.coverage);

    const tags = playwrightTags(spec.metadata?.tags);
    const testKw = ctx.coverage.fixme ? "test.fixme" : "test";
    const testOpen =
      tags.length > 0
        ? `${testKw}(${JSON.stringify(spec.name)}, { tag: ${JSON.stringify(tags)} }, async ({ page }${
            needsNodeVerifierEvidence ? ", testInfo" : ""
          }) => {`
        : `${testKw}(${JSON.stringify(spec.name)}, async ({ page }${
            needsNodeVerifierEvidence ? ", testInfo" : ""
          }) => {`;
    const testBlock = block(testOpen, body, `});`);
    const suiteBody: Stmt[] = [];
    // requires → a run-time CAIRN_ENV guard tied to the baked baseURL's
    // environment, before beforeAll so a skipped suite never runs its
    // preconditions.
    const requiresGuard = renderRequiresEnvGuard(spec.requires, opts.envTarget);
    if (requiresGuard.lines.length > 0) {
      suiteBody.push(verbatim(requiresGuard.lines));
    }
    if (requiresGuard.refusedReason) {
      addRisk(ctx, "envPolicy", requiresGuard.refusedReason, "requires");
    }
    if (spec.viewport) {
      suiteBody.push(
        raw(
          `test.use({ viewport: { width: ${spec.viewport.width}, height: ${spec.viewport.height} } });`,
        ),
      );
    }
    if (executablePreconditions.length > 0) {
      suiteBody.push(
        block(
          `test.beforeAll(async () => {`,
          [
            raw(`if (process.env.SKIP_PRECONDITIONS === "1") return;`),
            comment(timeoutBudgetComment(preconditionBudget)),
            raw(`test.setTimeout(${preconditionBudget.timeoutMs});`),
            ...preconditionStmts,
          ],
          `});`,
        ),
      );
    }
    suiteBody.push(blank, testBlock);
    const feature = spec.metadata?.feature;
    head.push(
      blank,
      ...(feature
        ? [
            block(
              `test.describe(${JSON.stringify(feature)}, () => {`,
              suiteBody,
              `});`,
            ),
          ]
        : suiteBody),
    );

    for (const e of ctx.usage.envNames) allEnv.add(e);
    for (const libName of ctx.usedLib ?? []) projectUsedLib.add(libName);
    const source = `${print(head)}\n`;
    addGeneratedSourceRisks(ctx.coverage, source);
    finalizeCoverage(ctx.coverage);
    assertNoLateBoundLeak(source, relPath, spec.name);
    files.push({ relPath, source });
    specs.push({
      name: spec.name,
      file: relPath,
      sourcePath: parsed.path,
      contractHash: computeContractHash(spec),
      sourceDigest: specSourceDigest(parsed),
      testTimeoutMs: timeoutBudget.timeoutMs,
      coverage: ctx.coverage,
      requiredEnv: [...ctx.usage.envNames].toSorted(),
      preconditions: preconditionLines,
    });
  }

  if (
    parsedSpecs.some((parsed) =>
      (parsed.spec.preconditions?.commands ?? []).some(
        (command) =>
          !isDocumentaryPrecondition(
            typeof command === "string" ? command : command.run,
          ),
      ),
    )
  ) {
    files.push({
      relPath: `preconditions${lang === "js" ? ".js" : ".ts"}`,
      source: renderPreconditionRuntime(lang),
    });
  }

  const copiedVerifierFiles = collectVerifierFiles(verifierFiles);
  if (!opts.into) {
    files.push({
      relPath: "package.json",
      source: renderPackageJson(lang, {
        verifierSdk: copiedVerifierFiles.some((file) =>
          importsVerifierSdk(file.sourcePath),
        ),
      }),
    });
    if (lang === "ts") {
      files.push({ relPath: "tsconfig.json", source: renderTsconfig() });
    }
    files.push({
      relPath: `playwright.config${lang === "js" ? ".js" : ".ts"}`,
      source: renderConfig(
        opts.baseUrl,
        lang,
        playwrightProjectTimeoutBudget(
          parsedSpecs.map((parsed) => parsed.resolved),
        ),
        {
          ...(opts.testIdAttribute
            ? { testIdAttribute: opts.testIdAttribute }
            : {}),
          ...(opts.viewport ? { viewport: opts.viewport } : {}),
          ...aggregatePlaywrightCapture(parsedSpecs.map((p) => p.spec)),
        },
      ),
    });
    files.push({
      relPath: `global-setup${lang === "js" ? ".js" : ".ts"}`,
      source: renderGlobalSetup(
        [...allPreconditions.values()],
        lang,
        projectRoot,
      ),
    });
  }

  files.push({
    relPath: "README.md",
    source: renderProjectReadme(
      specs,
      [...allEnv].toSorted(),
      actionModules,
      lang,
      {
        into: Boolean(opts.into),
        fixtures: fixtureFiles.size > 0,
        manifest: Boolean(opts.writesManifest),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.testIdAttribute
          ? { testIdAttribute: opts.testIdAttribute }
          : {}),
        ...(opts.viewport ? { viewport: opts.viewport } : {}),
        ...aggregatePlaywrightCapture(parsedSpecs.map((p) => p.spec)),
      },
    ),
  });

  for (const libName of [...projectUsedLib].toSorted()) {
    files.push({
      relPath: playwrightLibRelPath(libName, lang),
      source: renderLibModule(libName, lang),
    });
  }
  if (needsProjectRoot) {
    files.push({
      relPath: `lib/projectRoot${lang === "js" ? ".js" : ".ts"}`,
      source: renderProjectRootRuntime(
        lang,
        relativeFromExportRootToProject(opts.outDir, projectRoot),
      ),
    });
  }

  for (const file of files) assertNoLateBoundLeak(file.source, file.relPath);

  return {
    files,
    verifierFiles: copiedVerifierFiles,
    evalFiles: collectEvalFiles(evalFiles),
    fixtureFiles: [...fixtureFiles]
      .map(([sourcePath, relPath]) => ({ sourcePath, relPath }))
      .toSorted((a, b) => a.relPath.localeCompare(b.relPath)),
    specs,
    requiredEnv: [...allEnv].toSorted(),
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function declareProjectBinding(
  ctx: EmitCtx,
  key: string,
  preferred: string,
): string {
  const produced = ctx.produced ?? (ctx.produced = new Map());
  const existing = produced.get(key);
  if (existing) return existing;
  const taken = new Set(produced.values());
  let ident = preferred;
  for (let n = 2; taken.has(ident); n++) ident = `${preferred}${n}`;
  produced.set(key, ident);
  return ident;
}

/** Copy an action's hard/soft skips and risks into a calling test's coverage. */
function propagateActionCoverage(
  coverage: ExportCoverage,
  mod: ActionModule,
  callId: string,
): void {
  for (const entry of mod.coverage.skips) {
    const propagated: ExportCoverageSkip = {
      kind: entry.kind,
      id: callId,
      reason: `action ${mod.fnName}${
        entry.id ? ` (${entry.id})` : ""
      }: ${entry.reason}`,
      ...(entry.soft ? { soft: true } : {}),
    };
    coverage.skips.push(propagated);
  }
  for (const risk of mod.coverage.semanticRisks) {
    const propagated: ExportSemanticRisk = {
      kind: risk.kind,
      id: callId,
      detail: `action ${mod.fnName}${
        risk.id ? ` (${risk.id})` : ""
      }: ${risk.detail}`,
    };
    coverage.semanticRisks.push(propagated);
  }
}

function readOptional(path: string): { sourceText?: string } {
  try {
    return { sourceText: readFileSync(path, "utf8") };
  } catch {
    return {};
  }
}

/**
 * sha256 over the spec source and every imported action's NAME + source
 * (sorted by name). Content only — never an absolute path — so the digest is
 * identical in a fresh clone, on CI, or after moving the tree.
 */
export function specSourceDigest(parsed: ParseResult): string {
  const hash = createHash("sha256");
  hash.update(readOptional(parsed.path).sourceText ?? "");
  for (const [name, loaded] of [...parsed.actionsByName].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update("\u0000");
    hash.update(name);
    hash.update("\u0000");
    hash.update(loaded.rawSource);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** POSIX path of `target` inside `root`, or undefined when not inside. */
function projectRelative(
  root: string | undefined,
  target: string,
): string | undefined {
  if (!root) return undefined;
  const real = realpathNearest(resolvePath(target));
  const rel = relative(root, real);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(sep).join("/");
}

/**
 * Human display of a source path for generated comments: relative to the
 * project root (with `../` when it lives outside), so generated files never
 * embed a machine-local absolute path. Absolute only without a root.
 */
function displayPath(root: string | undefined, target: string): string {
  const inside = projectRelative(root, target);
  if (inside !== undefined || !root) return inside ?? target;
  const rel = relative(root, realpathNearest(resolvePath(target)));
  return isAbsolute(rel) ? target : rel.split(sep).join("/");
}

function emitActionModule(
  loaded: LoadedAction,
  specVars: Record<string, string | number | boolean>,
  lang: ExportLang,
  opts: {
    verifierFiles: Set<string>;
    evalFiles: Set<string>;
    fixtureFiles?: Map<string, string>;
    usedLib: Set<PlaywrightLibModule>;
    projectRoot?: string;
    configDir?: string;
    /** Modules of actions this one may `use:` (emitted before it). */
    nestedModules?: ReadonlyMap<string, ActionModule>;
  },
): ActionModule {
  const declaredKeys = Object.keys(loaded.actionDefaults).toSorted();
  let action = loaded.action;
  if (loaded.rawSource && declaredKeys.length > 0) {
    try {
      action = parseReusableAction(loaded.rawSource, loaded.path, {
        vars: {
          ...specVars,
          ...Object.fromEntries(
            declaredKeys.map((key) => [key, varRefSentinel(key)]),
          ),
        },
        env: {},
        ...(opts.configDir ? { configDir: opts.configDir } : {}),
        secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
        runtime: { runToken: RUN_TOKEN_SENTINEL },
      });
    } catch {
      action = loaded.action;
    }
  }

  const ctx = newEmitCtx(lang, {
    specDir: dirOf(loaded.path),
    verifierImportPrefix: "../verifiers",
    verifierFiles: opts.verifierFiles,
    evalFiles: opts.evalFiles,
    ...(opts.fixtureFiles ? { fixtureFiles: opts.fixtureFiles } : {}),
    ...(opts.projectRoot ? { fixtureRoot: opts.projectRoot } : {}),
    libImportPrefix: "../lib",
    usedLib: opts.usedLib,
    // Callers decide which captured values they splice; the action returns all.
    bindAllProduced: true,
  });
  ctx.coverage.stepsTotal = action.steps.length;
  const body: Stmt[] = [];
  const nestedImports = new Map<string, ActionModule>();
  for (const step of action.steps) {
    const nested =
      "use" in step ? opts.nestedModules?.get(useActionName(step)) : undefined;
    if ("use" in step && nested) {
      // A nested action is a call to its own module.
      nestedImports.set(nested.fnName, nested);
      if (nested.usesRunToken) ctx.usage.runToken = true;
      for (const envName of nested.envNames) ctx.usage.envNames.add(envName);
      const callId = step.id ?? useActionName(step);
      propagateActionCoverage(ctx.coverage, nested, callId);
      const passed = resolveActionCallVars(
        nested.declaredKeys,
        nested.defaults,
        specVars,
        useActionVars(step),
      );
      body.push(
        comment(`step: ${oneLine(callId)} (action)`),
        raw(
          `await ${nested.fnName}(${formatActionCallArgs(passed, nested, ctx)});`,
        ),
      );
      ctx.coverage.stepsExported += 1;
      continue;
    }
    const rendered = renderStep(step, undefined, ctx);
    if (rendered.exported) ctx.coverage.stepsExported += 1;
    body.push(...rendered.stmts);
  }
  const produced = new Map(ctx.produced ?? []);
  const produces = new Map<
    string,
    { source: "requests" | "evals" | "artifacts"; name: string }
  >();
  for (const key of produced.keys()) {
    const [source, name] = key.split(":") as [
      "requests" | "evals" | "artifacts",
      string,
    ];
    produces.set(runtimeRefKey(source, name), { source, name });
  }
  body.unshift(...renderBindingDeclarations(ctx));
  if (produced.size > 0) {
    const group = (source: "requests" | "evals" | "artifacts"): string => {
      const entries = [...produced]
        .filter(([key]) => key.startsWith(`${source}:`))
        .map(
          ([key, ident]) =>
            `${JSON.stringify(key.slice(source.length + 1))}: ${ident}`,
        );
      return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
    };
    body.push(
      blank,
      raw(
        `return { requests: ${group("requests")}, evals: ${group("evals")}, artifacts: ${group("artifacts")} };`,
      ),
    );
    opts.usedLib.add("splice");
    ctx.usedLibNames?.add("type CairnActionBindings");
  }
  if (declaredKeys.length > 0) {
    body.unshift(
      ...declaredKeys.map((key) =>
        raw(
          `const ${safeIdent(key)} = vars.${safeIdent(key)} ?? ${emitActionDefault(
            loaded.actionDefaults[key]!,
            ctx.usage,
          )};`,
        ),
      ),
      blank,
    );
  }
  if (ctx.usage.runToken) {
    body.unshift(raw(`const RUN_TOKEN = runToken;`), blank);
  }
  if (ctx.usage.splice || ctx.usage.unresolvedHelper) {
    opts.usedLib.add("splice");
    if (ctx.usage.splice) ctx.usedLibNames?.add("cairnSplice");
    if (ctx.usage.unresolvedHelper) {
      ctx.usedLibNames?.add("cairnUnresolvedSplice");
    }
  }

  const fnName = safeIdent(loaded.action.name);
  const varsAnnot =
    lang === "ts" && declaredKeys.length > 0
      ? `: { ${declaredKeys
          .map((key) => {
            const value = loaded.actionDefaults[key];
            const typeName =
              typeof value === "number"
                ? "number"
                : typeof value === "boolean"
                  ? "boolean"
                  : "string";
            return `${safeIdent(key)}?: ${typeName}`;
          })
          .join("; ")} }`
      : "";
  const varsParam = declaredKeys.length > 0 ? `, vars${varsAnnot} = {}` : "";
  const tokenParam = ctx.usage.runToken
    ? `, runToken${lang === "ts" ? ": string" : ""}`
    : "";
  const returnType =
    lang === "ts"
      ? produced.size > 0
        ? ": Promise<CairnActionBindings>"
        : ": Promise<void>"
      : "";

  const bodySource = print(body);
  const playwrightImports = [
    ...(usesExpectCall(bodySource) ? ["expect"] : []),
    ...(ctx.usesTestInfo ? ["test"] : []),
    ...(lang === "ts" ? ["type Page"] : []),
  ];
  const stmts: Stmt[] = [
    comment(
      `Generated from reusable action ${JSON.stringify(loaded.action.name)} (${displayPath(opts.projectRoot, loaded.path)}).`,
    ),
    comment(`Re-exporting overwrites this file.`),
    blank,
    ...(playwrightImports.length > 0
      ? [
          raw(
            `import { ${playwrightImports.join(", ")} } from "@playwright/test";`,
          ),
        ]
      : []),
    ...libImportStmts(ctx.usedLibNames ?? new Set(), lang),
    ...[...nestedImports.values()].map((nested) =>
      raw(
        `import { ${nested.fnName} } from "./${nested.relPath
          .replace(/^actions\//, "")
          .replace(/\.ts$/, "")}";`,
      ),
    ),
    blank,
    block(
      `export async function ${fnName}(page${
        lang === "ts" ? ": Page" : ""
      }${varsParam}${tokenParam})${returnType} {`,
      body,
    ),
  ];
  for (const libName of ctx.usedLib ?? []) opts.usedLib.add(libName);

  const relPath = `actions/${loaded.action.name}${
    lang === "js" ? ".js" : ".ts"
  }`;
  const source = `${print(stmts)}\n`;
  addGeneratedSourceRisks(ctx.coverage, source);
  finalizeCoverage(ctx.coverage);
  assertNoLateBoundLeak(source, relPath);
  return {
    fnName,
    relPath,
    source,
    envNames: [...ctx.usage.envNames],
    usesRunToken: ctx.usage.runToken,
    hasVars: declaredKeys.length > 0,
    declaredKeys,
    defaults: loaded.actionDefaults,
    produces,
    coverage: ctx.coverage,
  };
}

function emitActionDefault(
  value: string | number | boolean,
  usage: RefUsage,
): string {
  if (typeof value !== "string") return JSON.stringify(value);
  return emitStr(value.replaceAll("${run.token}", RUN_TOKEN_SENTINEL), usage);
}

function resolveActionCallVars(
  declaredKeys: string[],
  defaults: Record<string, string | number | boolean>,
  specVars: Record<string, string | number | boolean>,
  callVars?: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of declaredKeys) {
    if (callVars && Object.hasOwn(callVars, key)) {
      out[key] = callVars[key]!;
      continue;
    }
    if (Object.hasOwn(specVars, key) && specVars[key] !== defaults[key]) {
      out[key] = specVars[key]!;
    }
  }
  return out;
}

function formatActionCallArgs(
  passed: Record<string, string | number | boolean>,
  mod: Pick<ActionModule, "hasVars" | "usesRunToken">,
  ctx: EmitCtx,
): string {
  const args = ["page"];
  const hasPassed = Object.keys(passed).length > 0;
  if (hasPassed) args.push(emitValue(passed, ctx.usage));
  else if (mod.hasVars && mod.usesRunToken) args.push("{}");
  if (mod.usesRunToken) args.push("RUN_TOKEN");
  return args.join(", ");
}

const LIB_IMPORT_ORDER: Array<[PlaywrightLibModule, string[]]> = [
  ["networkEvidence", ["createCairnNetworkEvidence"]],
  ["hydration", ["verifiedFill", "verifiedType"]],
  ["clickUntil", ["clickUntil"]],
  ["verifier", ["loadCairnVerifier"]],
  [
    "splice",
    ["cairnSplice", "cairnUnresolvedSplice", "type CairnActionBindings"],
  ],
  ["fixtures", ["cairnFixturePath"]],
];

/** Import only the lib helpers the module actually references. */
function libImportStmts(
  usedNames: Set<string>,
  lang: ExportLang,
  importRoot = "..",
): Stmt[] {
  const ext = lang === "js" ? ".js" : "";
  const stmts: Stmt[] = [];
  for (const [module, names] of LIB_IMPORT_ORDER) {
    const used = names.filter(
      (name) =>
        usedNames.has(name) && (lang === "ts" || !name.startsWith("type ")),
    );
    if (used.length === 0) continue;
    stmts.push(
      raw(
        `import { ${used.join(", ")} } from ${JSON.stringify(`${importRoot}/lib/${module}${ext}`)};`,
      ),
    );
  }
  return stmts;
}

function renderLibModule(name: PlaywrightLibModule, lang: ExportLang): string {
  switch (name) {
    case "networkEvidence":
      return `${renderNodeVerifierEvidenceRuntime(lang).trimEnd()}\n`;
    case "hydration":
      return renderHydrationRuntime(lang);
    case "clickUntil":
      return renderClickUntilRuntime(lang);
    case "verifier":
      return renderVerifierRuntime(lang);
    case "splice":
      return renderSpliceRuntime(lang);
    case "fixtures":
      return renderFixturesRuntime(lang);
  }
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

function emitPreconditionCwd(
  specDir: string,
  authoredCwd: string | undefined,
  projectRoot: string | undefined,
): string {
  const abs = resolvePreconditionCwd(specDir, authoredCwd);
  if (!projectRoot) return JSON.stringify(abs);
  const rel =
    relative(projectRoot, realpathNearest(abs)).split(sep).join("/") || ".";
  return `join(cairnProjectRoot(), ${JSON.stringify(rel)})`;
}

function testRelPath(
  parsed: ParseResult,
  sourceRoot: string | undefined,
  ext: string,
): string {
  if (!sourceRoot) return `tests/${parsed.spec.name}${ext}`;
  const rel = relative(sourceRoot, parsed.path).replaceAll("\\", "/");
  const dir = dirname(rel);
  if (dir.startsWith("..")) return `tests/${parsed.spec.name}${ext}`;
  const nested = dir === "." || dir === "" ? "" : `${dir}/`;
  return `tests/${nested}${parsed.spec.name}${ext}`;
}

function importRootFromTestRel(relPath: string): string {
  const dir = dirname(relPath).replaceAll("\\", "/");
  const depth = dir === "." ? 0 : dir.split("/").filter(Boolean).length;
  if (depth <= 0) return ".";
  return Array.from({ length: depth }, () => "..").join("/");
}

function playwrightTags(tags: string[] | undefined): string[] {
  return (tags ?? []).map((tag) => (tag.startsWith("@") ? tag : `@${tag}`));
}

function aggregatePlaywrightCapture(specs: Spec[]): {
  screenshot: "on" | "off" | "only-on-failure";
  trace: "on" | "off" | "retain-on-failure";
} {
  let screenshot: "on" | "off" | "only-on-failure" = "only-on-failure";
  let trace: "on" | "off" | "retain-on-failure" = "off";
  for (const spec of specs) {
    const shot = spec.artifacts?.capture?.screenshots;
    const tr = spec.artifacts?.capture?.trace;
    if (shot === "always") screenshot = "on";
    else if (shot === "never" && screenshot !== "on") screenshot = "off";
    else if (shot === "on-failure" && screenshot === "off") {
      screenshot = "only-on-failure";
    }
    if (tr === "always") trace = "on";
    else if (tr === "on-failure" && trace === "off") {
      trace = "retain-on-failure";
    }
  }
  return { screenshot, trace };
}

/**
 * Relative path from the EXPORT ROOT to the source project root, computed on
 * real paths (a symlinked out dir such as macOS `/tmp` → `/private/tmp` would
 * otherwise produce a path that resolves somewhere that does not exist).
 */
export function relativeFromExportRootToProject(
  outDir: string | undefined,
  projectRoot: string | undefined,
): string | undefined {
  if (!outDir || !projectRoot) return undefined;
  const from = realpathNearest(resolvePath(outDir));
  const to = realpathNearest(resolvePath(projectRoot));
  return relative(from, to).split(sep).join("/") || ".";
}

function collectEvalFiles(entries: Set<string>): ProjectVerifierFile[] {
  const used = new Map<string, string>();
  for (const sourcePath of [...entries].toSorted()) {
    let relPath = `evals/${basename(sourcePath)}`;
    const collision = used.get(relPath);
    if (collision && collision !== sourcePath) {
      const parent = basename(dirname(sourcePath));
      relPath = `evals/${parent}-${basename(sourcePath)}`;
    }
    used.set(relPath, sourcePath);
  }
  return [...used]
    .map(([relPath, sourcePath]) => ({ sourcePath, relPath }))
    .toSorted((a, b) => a.relPath.localeCompare(b.relPath));
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
    `import { existsSync } from "node:fs";`,
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
    `  if (!existsSync(options.cwd)) {`,
    `    throw new Error(`,
    `      "Precondition cwd does not exist: " + options.cwd + ". " +`,
    `        "Set CAIRN_PROJECT_ROOT to the Cairntrace project root (the directory holding the source specs); this export may have been moved.",`,
    `    );`,
    `  }`,
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
  extras: {
    testIdAttribute?: string;
    viewport?: { width: number; height: number };
    screenshot?: "on" | "off" | "only-on-failure";
    trace?: "on" | "off" | "retain-on-failure";
  } = {},
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
    `    // Cairntrace bounds each step (default 30s); without these a stuck locator`,
    `    // would consume the whole derived test timeout before failing.`,
    `    actionTimeout: 30_000,`,
    `    navigationTimeout: 30_000,`,
    `    // The app ships a strict CSP (script-src without unsafe-eval) which`,
    `    // blocks exported string-eval steps — standard test-context bypass.`,
    `    bypassCSP: true,`,
    ...(extras.testIdAttribute
      ? [`    testIdAttribute: ${JSON.stringify(extras.testIdAttribute)},`]
      : []),
    ...(extras.viewport
      ? [
          `    viewport: { width: ${extras.viewport.width}, height: ${extras.viewport.height} },`,
        ]
      : []),
    ...(extras.screenshot
      ? [`    screenshot: ${JSON.stringify(extras.screenshot)},`]
      : []),
    ...(extras.trace ? [`    trace: ${JSON.stringify(extras.trace)},`] : []),
    `  },`,
    `  reporter: [["list"]],`,
    `});`,
    ``,
  ];
  return lines.join("\n");
}

const VERIFIER_SDK_SPECIFIER = /["']@thelacanians\/cairntrace\/verifier["']/;

/** A copied verifier module that imports the verifier SDK needs the package. */
function importsVerifierSdk(sourcePath: string): boolean {
  try {
    return VERIFIER_SDK_SPECIFIER.test(readFileSync(sourcePath, "utf8"));
  } catch {
    return false;
  }
}

function renderPackageJson(
  lang: ExportLang,
  needs: { verifierSdk?: boolean } = {},
): string {
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
  // Outside `cairn run` nothing redirects the SDK import to the runner's own
  // copy, so the exported project installs the package that ships it.
  if (needs.verifierSdk) {
    devDependencies["@thelacanians/cairntrace"] = `^${CAIRN_VERSION}`;
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
  projectRoot?: string,
): string {
  const executable = preconditions.filter(
    (p) => !isDocumentaryPrecondition(p.run),
  );
  const names = executable
    .map((p) =>
      humanizeSentinels(
        `//   - ${p.name ?? oneLine(p.run).slice(0, 80)} (cwd: ${displayPath(
          projectRoot,
          p.cwd ?? p.specDir,
        )}; timeout: ${p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS}ms)`,
      ),
    )
    .join("\n");
  return `// Generated by \`cairn export playwright --project\`.
//
// Per-spec preconditions run in each test file's beforeAll (mirroring the
// Cairntrace per-spec semantics — a single global gate would let backend
// debris pile up between tests). This hook is the place for ONE-TIME suite
// setup (auth warmup, seeding); it currently only logs.${
    names
      ? ` Known per-spec\n// preconditions (run by beforeAll, not here), for reference:\n${names}`
      : ""
  }
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
    {
      fnName: string;
      relPath: string;
      usesRunToken: boolean;
      hasVars: boolean;
    }
  >,
  lang: ExportLang,
  extras: {
    into?: boolean;
    fixtures?: boolean;
    manifest?: boolean;
    baseUrl?: string;
    testIdAttribute?: string;
    viewport?: { width: number; height: number };
    screenshot?: "on" | "off" | "only-on-failure";
    trace?: "on" | "off" | "retain-on-failure";
  } = {},
): string {
  const lines = [
    extras.into
      ? "# Exported Playwright suite (host tree)"
      : "# Exported Playwright project",
    "",
    "Generated by `cairn export playwright` from Cairntrace specs —",
    "the specs remain the source of truth; re-exporting overwrites these files.",
    "",
    "```",
    ...(extras.into
      ? []
      : [
          "package.json          installable @playwright/test + typecheck scripts",
          ...(lang === "ts"
            ? [
                "tsconfig.json         strict TS/DOM config; portable .ts imports",
              ]
            : []),
          "playwright.config.*   serial, bypassCSP, derived timeout, globalSetup wired",
          "global-setup.*        one-time suite hook (per-spec preconditions run in beforeAll)",
        ]),
    "preconditions.*       filtered env + process-tree timeout runner",
    "lib/                  fill retry, click.until, verifier loader, evidence",
    "actions/              shared UI flows (login, …) imported by tests",
    "verifiers/            node-context durable-processing verifiers (copied)",
    "evals/                copied eval.file sources (embedded at export time)",
    ...(extras.fixtures
      ? [
          "fixtures/             copied upload files (resolved via lib/fixtures)",
        ]
      : []),
    ...(extras.manifest
      ? [
          ".cairn-export.json    export manifest; `cairn export playwright --check <dir>` detects drift",
        ]
      : []),
    "tests/                one spec file per Cairntrace spec (folders preserved)",
    "```",
    "",
    "## Run",
    "",
    ...(extras.into
      ? [
          "Add a Playwright project to the **host** `playwright.config` (this export does not overwrite it):",
          "",
          "```ts",
          "{",
          `  name: "cairn",`,
          `  testDir: "./tests",`,
          `  timeout: 2 * 60 * 60_000,`,
          `  workers: 1,`,
          `  fullyParallel: false,`,
          "  use: {",
          extras.baseUrl
            ? `    baseURL: process.env.BASE_URL ?? ${JSON.stringify(extras.baseUrl)},`
            : '    baseURL: process.env.BASE_URL ?? "http://localhost:8080",',
          "    bypassCSP: true,",
          extras.testIdAttribute
            ? `    testIdAttribute: ${JSON.stringify(extras.testIdAttribute)},`
            : "",
          extras.viewport
            ? `    viewport: { width: ${extras.viewport.width}, height: ${extras.viewport.height} },`
            : "",
          extras.screenshot
            ? `    screenshot: ${JSON.stringify(extras.screenshot)},`
            : "",
          extras.trace ? `    trace: ${JSON.stringify(extras.trace)},` : "",
          "  },",
          "}",
          "```",
          "",
          "Point `testDir` at this folder's `tests/` (or keep the prefix you passed to `--into`).",
          "",
        ]
      : [
          "```bash",
          "npm install",
          "npx playwright install chromium",
          ...(lang === "ts" ? ["npm run typecheck"] : []),
          "npm test",
          "```",
          "",
        ]),
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
    "- `SKIP_PRECONDITIONS=1` — skip per-file beforeAll preconditions (wire your own in CI).",
    "- `CAIRN_PROJECT_ROOT` — Cairntrace source project root for precondition cwd and verifier specDir (default: resolved relative to this export, as recorded at export time; preconditions fail fast with guidance when it does not exist).",
    "- `MONGO_URI` — point verifiers at a remote MongoDB instead of local docker.",
    "",
    "## Actions",
    "",
    ...[...actions.entries()].map(([name, a]) => {
      const args = [
        "page",
        ...(a.hasVars ? ["vars?"] : []),
        ...(a.usesRunToken ? ["runToken"] : []),
      ];
      return `- \`${a.relPath}\` → \`${a.fnName}(${args.join(", ")})\` (from action \`${name}\`)`;
    }),
    "",
    "## Specs",
    "",
  ];
  for (const s of specs) {
    lines.push(
      `### ${s.name} (\`${s.file}\`)`,
      `- coverage: steps ${s.coverage.stepsExported}/${s.coverage.stepsTotal}, outcomes ${s.coverage.outcomesExported}/${s.coverage.outcomesTotal}${
        s.coverage.fixme ? " — **test.fixme**" : ""
      }`,
      ...coverageReadmeLines(s.coverage),
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

/** README bullets for hard skips, diagnostic skips, and semantic risks. */
function coverageReadmeLines(coverage: ExportCoverage): string[] {
  const lines: string[] = [];
  const hard = coverage.skips.filter((entry) => !entry.soft);
  if (hard.length > 0) {
    lines.push(`- skipped (marks test.fixme):`);
    for (const entry of hard) {
      lines.push(
        `  - [${entry.kind}]${entry.id ? ` ${entry.id}` : ""}: ${entry.reason}`,
      );
    }
  }
  if (coverage.diagnosticSkips.length > 0) {
    lines.push(`- diagnostic skips (no effect on pass/fail):`);
    for (const entry of coverage.diagnosticSkips) {
      lines.push(
        `  - [${entry.kind}]${entry.id ? ` ${entry.id}` : ""}: ${entry.reason}`,
      );
    }
  }
  if (coverage.semanticRisks.length > 0) {
    lines.push(`- semantic risks:`);
    for (const risk of coverage.semanticRisks) {
      lines.push(
        `  - ${risk.kind}${risk.id ? ` (${risk.id})` : ""}: ${risk.detail}`,
      );
    }
  }
  return lines.map(humanizeSentinels);
}
