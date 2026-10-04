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
  annotateVarPredicates,
  parseReusableAction,
  type LoadedAction,
  type ParseResult,
} from "../parser/parseSpec";
import type { Spec, Step, UseStep } from "../schema/spec.v1";
import {
  teardownPlan,
  useActionName,
  useActionVars,
  useRetry,
  walkSteps,
} from "../schema/spec.v1";
import { specFixtureRefParts } from "../fixtures/schema";
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
  emitPlainValue,
  exportExtension,
  finalizeCoverage,
  fixtureBinding,
  hasNodeFileVerifier,
  hostGates,
  newEmitCtx,
  oneLine,
  referencedRuntimeRefs,
  referencedWaitNames,
  renderBindingDeclarations,
  renderBodyEnvelope,
  renderRetryLoop,
  renderNodeVerifierEvidenceRuntime,
  renderNodeVerifierEvidenceSetup,
  renderOutcomeEvidenceSetup,
  renderOutcome,
  renderStep,
  actionIdent,
  safeIdent,
  specNeedsNetworkListener,
  type EmitCtx,
  type ExportCoverage,
  type ExportCoverageSkip,
  type ExportLang,
  type ExportSemanticRisk,
  type Rendered,
  usesExpectCall,
} from "./playwrightExporter";
import {
  isDocumentaryPrecondition,
  playwrightPreconditionTimeoutBudget,
  playwrightProjectTimeoutBudget,
  playwrightTestTimeoutBudget,
  setTimeoutStmts,
  timeoutBudgetComment,
} from "./playwrightTimeout";
import {
  preconditionsPlan,
  type PreconditionsPlan,
  type ExportPreconditionsMode,
  type ExportVerifiersMode,
  type HostFixture,
  type HostGate,
  type HostPrecondition,
} from "./exportModes";
import { redactOption, renderCommandModule } from "./commandRuntime";
import {
  specNeedsRichNetworkLog,
  typedOutcomeOperands,
  type ExportHttpDatasource,
} from "./playwrightDataVerifiers";
import {
  DATA_PIECES,
  dataNeedsWorkbook,
  dataPieceExports,
  dataRuntimeModules,
  renderDataPieceModule,
  type DataPiece,
} from "./playwrightRuntimeData";
import { renderRuntimeModule } from "./runtimeSources";
import { renderPreconditionHook } from "./playwrightHostSteps";
import { renderGlobalSetupModule } from "./playwrightGlobalSetup";
import {
  renderFixtureOutputsRuntime,
  renderPollRuntime,
  renderProbeRuntime,
} from "./playwrightRuntimeHost";
import type { ExportHostSetup } from "./playwrightExporter";
import {
  assertNoLateBoundLeak,
  bindingIdent,
  emitStr,
  emitValue,
  envDefaultSentinel,
  humanizeSentinels,
  newRefUsage,
  RUN_TOKEN_SENTINEL,
  runtimeRefKey,
  varRefSentinel,
  withIdentPolicy,
  type RefUsage,
} from "./templateValue";
import {
  playwrightLibRelPath,
  RUNTIME_LIB_DIR,
  renderClickUntilRuntime,
  renderFixturesRuntime,
  renderHydrationRuntime,
  renderProjectRootRuntime,
  renderSpliceRuntime,
  renderVerifierRuntime,
  renderPreludeRuntime,
  renderWidgetsRuntime,
  type ExportModuleSystem,
  type PlaywrightLibModule,
} from "./playwrightRuntime";
import { defaultWidgets, type PreparedWidgets } from "../widgets/runtime";
import type { AppHandles } from "../prelude/prelude";
import {
  prepareExportAuth,
  renderAuthRuntime,
  renderRequestRuntime,
  type ExportEnvAuth,
} from "./requestRuntime";
import { BUILTIN_LOGIN_ACTION } from "../schema/request.v1";
import type { ConfigVarValue } from "../schema/config.v1";
import type { HostEmit } from "./hostProfile";
import { postprocessHostFile } from "./hostPostprocess";
import { ExportMapError, kebabCase, type LoadedExportMap } from "./exportMap";
import {
  apiLoginAuth,
  apiLoginBlocker,
  apiLoginHook,
  authLiteral,
  ExportMapState,
  newSpecMapUse,
  type MapCall,
  type MapDecision,
  type MappedActionReport,
} from "./exportMapEmit";

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
   * E8: adapt the tree to an existing Playwright host (module system,
   * timeouts, test id attribute, test discovery, aliases, import order).
   * Only meaningful with `into`. See hostProfile.
   */
  host?: HostEmit;
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
  /** No `.first()` on a locator without `nth` (Playwright strictness). */
  strictLocators?: boolean;
  /**
   * F15: widget config (`browser.fieldRoot`, `browser.widgets` with custom
   * driver sources) baked into `lib/widgets`. Built-ins and the default
   * fieldRoot when omitted.
   */
  widgets?: PreparedWidgets;
  /** F18: the export environment's `auth:` block (`use: login` → lib/auth). */
  envAuth?: ExportEnvAuth;
  /** F20: config `browser.appHandle`, baked into `lib/prelude`. */
  appHandles?: AppHandles;
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
  /** E10 `--preconditions`; see exportModes. */
  preconditions?: ExportPreconditionsMode;
  /** E10 `--verifiers`; see exportModes. */
  verifiers?: ExportVerifiersMode;
  /** Extra env vars every gated node verifier requires. */
  gateEnv?: readonly string[];
  /** Env vars each config datasource needs (`--verifiers gate`). */
  datasourceEnv?: Readonly<Record<string, readonly string[]>>;
  /** The export environment's `kind: http` datasources (`http` verifiers). */
  httpDatasources?: Readonly<Record<string, ExportHttpDatasource>>;
  /** The specs were parsed with late-bound env (no `${env.X}` value baked). */
  lateBoundEnv?: boolean;
  /** Config file (absolute) the global setup passes to `cairn`. */
  configPath?: string;
  /** Environment the global setup passes to `cairn` (`--env`). */
  envName?: string;
  /** Config fixture name → scope (`run` fixtures are torn down at the end). */
  fixtureScopes?: Readonly<Record<string, string>>;
  /**
   * E9: the export map. Actions bind to host fixtures / page-object methods /
   * a storageState; the rest become generated page objects (lib/pages)
   * instead of `actions/` modules.
   */
  map?: LoadedExportMap;
  /** Names of the host config's `projects` (checks an API login's `setupProject`). */
  hostProjects?: readonly string[];
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
  /** Env vars read with a `:-default` (the test works without them). */
  optionalEnv: string[];
  preconditions: string[];
  /** Host setup the spec declares (commands, gates, fixtures). */
  setup: ExportHostSetup;
  /** E9: the actions of this spec the export map bound or generated. */
  mapped?: MappedActionReport[];
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
  /** E9: how each action the export map touched was bound (absent without a map). */
  mapped?: MappedActionReport[];
}

/** Runtime refs an action module can capture and return to its callers. */
type ProducedSource = "requests" | "evals" | "artifacts" | "runs" | "captures";
const PRODUCED_SOURCES: readonly ProducedSource[] = [
  "requests",
  "evals",
  "artifacts",
  "runs",
  "captures",
];

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
  produces: Map<string, { source: ProducedSource; name: string }>;
  /** Skips/risks inside the action; propagated into every calling test. */
  coverage: ExportCoverage;
  /** The action calls the command helper (`preconditions.ts` must exist). */
  usesCommand: boolean;
  /** The action reads host paths through `lib/projectRoot`. */
  usesProjectPath: boolean;
  /**
   * E9: a generated page-object method (`new Class(page).method(…)`) instead
   * of an `actions/` function.
   */
  method?: { className: string; methodName: string; file: string };
  /** E9: the method of a page object class and the imports it needs (the file is assembled later). */
  pageParts?: { imports: string[]; method: Stmt };
}

export function exportPlaywrightProject(
  parsedSpecs: ParseResult[],
  opts: ProjectExportOptions = {},
): ProjectExportResult {
  // Host profiles spell derived identifiers camelCase (an alias map keeps
  // names that collapse to the same identifier distinct).
  return withIdentPolicy(opts.host ? "camel" : undefined, () =>
    exportPlaywrightProjectUnder(parsedSpecs, opts),
  );
}

function exportPlaywrightProjectUnder(
  parsedSpecs: ParseResult[],
  opts: ProjectExportOptions,
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
  // E10: how host commands are treated. Without `--preconditions` the
  // per-file beforeAll keeps today's shape (shell strings, `cairnProjectRoot`
  // cwd) and run steps / teardown stay unexported.
  const plan = preconditionsPlan(opts.preconditions, true);
  const legacyHook = opts.preconditions === undefined;
  /** A unit calls the command helper: `preconditions.ts` must exist. */
  let commandModuleNeeded = false;
  /** `--preconditions global`: what the generated global-setup runs, in order. */
  const globalPreconditions = new Map<string, HostPrecondition>();
  const globalGates = new Map<string, HostGate>();
  const globalFixtures = new Map<
    string,
    HostFixture & { reset: boolean; write: boolean }
  >();
  /** E9: API logins (export map) the global setup signs in. */
  const globalAuthStates = new Set<string>();

  // ----- actions: one module per reusable action, deduped by name -----
  const projectUsedLib = new Set<PlaywrightLibModule>();
  const widgets = opts.widgets ?? defaultWidgets(opts.testIdAttribute);
  const evalFiles = new Set<string>();
  const actionModules = new Map<string, ActionModule>();

  // ----- E9: the export map decides what each action call becomes -----
  const map = opts.map
    ? new ExportMapState(opts.map, {
        lang,
        ...(opts.outDir
          ? { outDir: realpathNearest(resolvePath(opts.outDir)) }
          : {}),
        importExt: opts.host?.importExt ?? (lang === "js" ? ".js" : ""),
        moduleSystem: opts.host?.moduleSystem ?? "esm",
        ...(opts.host?.alias ? { alias: opts.host.alias } : {}),
        ...(opts.hostProjects ? { hostProjects: opts.hostProjects } : {}),
        ...(opts.configDir ? { configDir: opts.configDir } : {}),
        ...(opts.envAuth ? { envAuth: opts.envAuth } : {}),
      })
    : undefined;
  /**
   * A top-level step no real step precedes: everything before it is a `use:`
   * the map hoists before the test body (fixture / apiLogin).
   */
  const leadingOf = (parsed: ParseResult, step: Step): boolean => {
    const steps = parsed.spec.steps ?? [];
    const at = steps.indexOf(step);
    if (at < 0 || !map) return false;
    return steps
      .slice(0, at)
      .every(
        (prev) =>
          "use" in prev && map.hoistsBeforeBody(useActionName(prev as UseStep)),
      );
  };
  /** What a `use:` step asks the map. */
  const mapCallOf = (
    parsed: ParseResult,
    step: UseStep,
    nested: boolean,
    scope?: LoadedAction,
  ): MapCall => {
    const action = useActionName(step);
    const loaded =
      scope?.scope?.get(action) ?? parsed.actionsByName.get(action);
    const callVars = useActionVars(step);
    const specVars = parsed.vars ?? {};
    const passed = loaded
      ? resolveActionCallVars(
          Object.keys(loaded.actionDefaults).toSorted(),
          loaded.actionDefaults,
          specVars,
          callVars,
        )
      : { ...callVars };
    return {
      action,
      loaded,
      callVars,
      passed,
      specVars,
      specName: parsed.spec.name,
      nested,
      retried: useRetry(step) !== undefined,
      conditional: step.when !== undefined || step.postcondition !== undefined,
      leading: !nested && leadingOf(parsed, step),
      stepId: step.id,
    };
  };
  /** Actions the map leaves to generated page objects (with their class and method). */
  const generated = new Map<
    string,
    { className: string; methodName: string }
  >();
  if (map) {
    const requireGenerated = (
      parsed: ParseResult,
      action: string,
      decision: Extract<MapDecision, { kind: "generated" }>,
    ): void => {
      map.record(
        {
          action,
          treatment: "generated",
          target: `${decision.className}.${decision.methodName}`,
          ...(decision.note ? { note: decision.note } : {}),
        },
        parsed.spec.name,
      );
      if (generated.has(action)) return;
      const loaded = parsed.actionsByName.get(action);
      if (!loaded) return;
      generated.set(action, {
        className: decision.className,
        methodName: decision.methodName,
      });
      for (const nestedStep of walkSteps(loaded.action.steps)) {
        if (!("use" in nestedStep)) continue;
        const call = mapCallOf(parsed, nestedStep, true, loaded);
        const nestedDecision = map.decide(call);
        if (nestedDecision.kind === "generated") {
          requireGenerated(parsed, call.action, nestedDecision);
        }
      }
    };
    for (const parsed of parsedSpecs) {
      const top = new Set<Step>(parsed.spec.steps ?? []);
      for (const step of walkSteps(parsed.spec.steps ?? [])) {
        if (!("use" in step)) continue;
        const call = mapCallOf(parsed, step, !top.has(step));
        const decision = map.decide(call);
        if (decision.kind === "generated") {
          requireGenerated(parsed, call.action, decision);
        }
      }
    }
    map.assertStrict();
  }
  /** A nested `use:` the map binds to a page-object method (inside a generated page object). */
  const mapNestedFor =
    (parsed: ParseResult, owner: LoadedAction) =>
    (step: UseStep, importerRel: string, nestedCtx: EmitCtx) => {
      if (!map) return undefined;
      const call = mapCallOf(parsed, step, true, owner);
      const decision = map.decide(call);
      if (decision.kind === "generated" || decision.kind === "builtin") {
        return undefined;
      }
      if (decision.kind !== "method") {
        // Fixtures and storageState run before the test body: say why this
        // nested call cannot be one.
        map.requireTopLevel(
          call,
          decision.kind === "fixture"
            ? `fixture ${decision.fixture.name}`
            : "an API login (storageState)",
        );
        return undefined;
      }
      const result = map.methodCall(
        call,
        decision.method,
        importerRel,
        "page",
        nestedCtx.usage,
        undefined,
        decision.note,
      );
      return {
        rendered: {
          stmts: [
            comment(
              `step: ${call.stepId ?? call.action} (action ${call.action}) — host page object ${decision.method.class}.${decision.method.call}`,
            ),
            raw(result.code),
          ],
          exported: true,
        } satisfies Rendered,
        imports: result.imports.map(
          (entry) =>
            `import { ${entry.name} } from ${JSON.stringify(entry.specifier)};`,
        ),
      };
    };

  for (const parsed of parsedSpecs) {
    // A11: an action that `use:`s another (its own imports) calls that
    // action's module, so nested modules are emitted first.
    const emitAction = (name: string, loaded: LoadedAction): void => {
      if (actionModules.has(name)) return;
      // With an export map, only the actions it leaves unmapped are modules
      // (page objects); the bound ones are the host's.
      const asPage = generated.get(name);
      if (map && !asPage) return;
      for (const step of walkSteps(loaded.action.steps)) {
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
        ...(opts.envAuth ? { envAuth: opts.envAuth } : {}),
        ...(plan.hostCommands ? { hostCommands: true } : {}),
        ...(opts.testIdAttribute
          ? { testIdAttribute: opts.testIdAttribute }
          : {}),
        ...(opts.strictLocators ? { strictLocators: true } : {}),
        ...(opts.host
          ? { hostTestIdAttribute: opts.host.testIdAttribute ?? null }
          : {}),
        nestedModules: actionModules,
        ...(map && asPage
          ? {
              method: { ...asPage, pageProperty: map.pageProperty() },
              mapNested: mapNestedFor(parsed, loaded),
            }
          : {}),
      });
      for (const libName of actionLib) projectUsedLib.add(libName);
      for (const e of emitted.envNames) allEnv.add(e);
      if (emitted.usesCommand) commandModuleNeeded = true;
      if (emitted.usesProjectPath) needsProjectRoot = true;
      actionModules.set(name, emitted);
      if (map && asPage && emitted.pageParts) {
        map.addPageMethod(name, asPage.className, asPage.methodName, {
          imports: emitted.pageParts.imports,
          method: emitted.pageParts.method,
        });
      }
    };
    for (const [name, loaded] of parsed.actionsByName) {
      emitAction(name, loaded);
    }
  }
  for (const m of actionModules.values()) {
    // A page-object method is written with its class (map.renderPageFiles).
    if (!m.method) files.push({ relPath: m.relPath, source: m.source });
  }

  // ----- tests: use: steps become action calls -----
  for (const parsed of parsedSpecs) {
    const spec = parsed.spec;
    const specDir = dirOf(parsed.path);
    const timeoutBudget = playwrightTestTimeoutBudget(parsed.resolved, {
      ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
      hostCommands: plan.hostCommands,
    });
    // F14: the spec's own steps as written, with plain `var` predicates
    // resolved against the spec's vars (`resolved` carries them; this
    // export renders `use:` as module calls instead of the expansion).
    const steps = annotateVarPredicates(spec.steps ?? [], parsed.vars ?? {});
    const relPath = testRelPath(parsed, opts.sourceRoot, ext, opts.host);
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
      ...(opts.envAuth ? { envAuth: opts.envAuth } : {}),
      // The test's OWN steps/outcomes: a splice inside an action is bound and
      // consumed in the action module, never in the calling test.
      referencedRefs: referencedRuntimeRefs(parsed.spec, {
        hostCommands: plan.hostCommands,
        ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
      }),
      ...(specDirRel !== undefined
        ? { specDirExpr: `cairnProjectPath(${JSON.stringify(specDirRel)})` }
        : {}),
      ...(projectRoot ? { projectRoot } : {}),
      ...(plan.hostCommands ? { hostCommands: true } : {}),
      ...(plan.global ? { globalSetup: true } : {}),
      ...(opts.testIdAttribute
        ? { testIdAttribute: opts.testIdAttribute }
        : {}),
      ...(opts.strictLocators ? { strictLocators: true } : {}),
      ...(opts.host
        ? { hostTestIdAttribute: opts.host.testIdAttribute ?? null }
        : {}),
      verifiersMode: opts.verifiers ?? "keep",
      ...(opts.gateEnv ? { gateEnv: opts.gateEnv } : {}),
      ...(opts.datasourceEnv ? { datasourceEnv: opts.datasourceEnv } : {}),
      ...(opts.httpDatasources
        ? { httpDatasources: opts.httpDatasources }
        : {}),
    });
    // `--preconditions global`: the global setup ensured this spec's fixtures;
    // their outputs are bound once at the top of the test.
    const specFixtureRefs = (spec.fixtures ?? []).map((ref) =>
      specFixtureRefParts(ref),
    );
    const hostFixtures: HostFixture[] = specFixtureRefs.map((ref) => ({
      name: ref.name,
      ...(ref.with ? { with: ref.with } : {}),
      keys: fixtureOutputKeys(parsed.spec, ref.name, plan.hostCommands),
      runScoped: (opts.fixtureScopes?.[ref.name] ?? "run") === "run",
    }));
    if (plan.global && hostFixtures.length > 0) {
      // Only fixtures a step actually splices get a binding (an unread one
      // would fail noUnusedLocals); outcomes compare `${fixtures.…}` as text.
      ctx.fixtureOutputs = new Map(
        hostFixtures
          .filter(
            (fixture) =>
              fixture.keys.length > 0 &&
              ctx.referencedRefs?.has(`fixtures:${fixture.name}`),
          )
          .map((fixture) => [fixture.name, fixture.keys]),
      );
      for (const name of ctx.fixtureOutputs.keys()) {
        ctx.usage.bindings.set(`fixtures:${name}`, fixtureBinding(name));
      }
    }
    const needsNodeVerifierEvidence = hasNodeFileVerifier(spec, opts.verifiers);
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
    // E9: what the export map binds in this test (fixtures, options, imports, storageState).
    const specUse = map ? newSpecMapUse() : undefined;
    const hostTest = map?.loaded.map.test;
    if (map && specUse && hostTest) {
      specUse.testImport = {
        specifier: map.specifierFor(hostTest.import, relPath),
        name: hostTest.name ?? "test",
      };
    }
    /** Mapped fixtures / storageState run before the body: only legal before the first real step. */
    let mapLeading = true;
    let lastHoisted = false;
    const timeoutStmts = setTimeoutStmts(
      timeoutBudget,
      timeoutBudgetComment(timeoutBudget),
      opts.host?.testTimeoutMs,
    );
    const body: Stmt[] = [
      timeoutStmts[0]!,
      ...(timeoutBudget.capped
        ? [
            comment(
              `WARNING: authored budgets exceed the 4h export ceiling; split this spec.`,
            ),
          ]
        : []),
      ...timeoutStmts.slice(1),
      blank,
    ];
    const evidenceInsertAt = body.length;
    body.push(...renderOutcomeEvidenceSetup(spec, lang, ctx));
    const bindingsInsertAt = body.length;
    let actionCallCounter = 0;
    /** A `use:` as a call to its action module (undefined: no module). */
    /** E9: the call the export map binds (undefined: a generated page object or the built-in login). */
    const mappedCall = (
      step: UseStep,
      nested: boolean,
    ): Rendered | undefined => {
      if (!map || !specUse) return undefined;
      const call = mapCallOf(parsed, step, nested);
      const decision = map.decide(call);
      if (decision.kind === "builtin") return undefined;
      if (decision.kind === "generated") {
        map.record(
          {
            action: call.action,
            treatment: "generated",
            target: `${decision.className}.${decision.methodName}`,
            ...(decision.note ? { note: decision.note } : {}),
          },
          spec.name,
        );
        return undefined;
      }
      if (decision.kind === "method") {
        const result = map.methodCall(
          call,
          decision.method,
          relPath,
          "page",
          ctx.usage,
          specUse,
          decision.note,
        );
        for (const entry of result.imports) {
          const names = specUse.imports.get(entry.specifier) ?? new Set();
          names.add(entry.name);
          specUse.imports.set(entry.specifier, names);
        }
        return {
          stmts: [
            comment(
              `step: ${oneLine(call.stepId ?? call.action)} (action ${call.action}) — host page object ${decision.method.class}.${decision.method.call}`,
            ),
            raw(result.code),
          ],
          exported: true,
        };
      }
      let stmts: Stmt[];
      if (decision.kind === "fixture") {
        stmts = map.useFixture(
          call,
          decision.fixture,
          specUse,
          relPath,
          ctx.usage,
          decision.note,
        );
      } else {
        let auth: { literal: string; requiredEnv: string[] } | undefined;
        if (decision.login.setupProject === undefined) {
          if (call.loaded) {
            const blocker = apiLoginBlocker(call.loaded.action.steps);
            if (blocker) {
              throw new ExportMapError(
                `export map: action ${call.action} cannot be an API login: ${blocker}`,
              );
            }
            auth = apiLoginAuth({
              steps: parseReusableAction(
                call.loaded.rawSource,
                call.loaded.path,
                {
                  vars: {
                    ...call.loaded.actionDefaults,
                    ...call.specVars,
                    ...call.callVars,
                  } as Record<string, ConfigVarValue>,
                  env: {},
                  ...(opts.configDir ? { configDir: opts.configDir } : {}),
                  secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
                  envDefaultRef: envDefaultSentinel,
                  lateEnv: true,
                  runtime: { runToken: RUN_TOKEN_SENTINEL },
                },
              ).steps,
              configDir: opts.configDir ?? process.cwd(),
            });
          } else if (opts.envAuth) {
            auth = authLiteral(opts.envAuth, call.callVars ?? {});
          } else {
            throw new ExportMapError(
              `export map: action ${call.action} is the environment's built-in login, but the export environment has no auth: block to sign in with`,
            );
          }
          for (const name of auth.requiredEnv) ctx.usage.envNames.add(name);
        }
        stmts = map.useApiLogin(
          call,
          decision.login,
          specUse,
          decision.note,
          auth,
        );
      }
      if (!mapLeading) {
        addRisk(
          ctx,
          "mappedOrdering",
          `action ${call.action} is bound to a ${
            decision.kind === "fixture"
              ? `host fixture (${decision.fixture.name})`
              : "storageState"
          }, which is set up before the test body; its use: step comes after other steps, so what ran before it now runs signed in`,
          call.stepId ?? call.action,
        );
      }
      lastHoisted = true;
      return { stmts, exported: true };
    };
    const actionCall = (
      step: UseStep,
      nested = false,
    ): Rendered | undefined => {
      lastHoisted = false;
      const mapped = mappedCall(step, nested);
      if (mapped) return mapped;
      const actionName = useActionName(step);
      const mod = actionModules.get(actionName);
      if (!mod) return undefined;
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
      const call = `await ${moduleCall(mod, passed, ctx)}`;
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
            bindingIdent(`cairn${capitalize(produced.source)}`, produced.name),
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
      return { stmts: callStmts, exported: true };
    };
    // F14: a `use:` nested in a repeat / if block calls its module too.
    ctx.renderUseCall = (step) => actionCall(step, true);
    ctx.referencedWaits = referencedWaitNames(steps);
    const core: Stmt[] = [];
    if (steps.length > 0) {
      core.push(comment(`--- steps ---`));
      let resolvedIdx = 0;
      for (const step of steps) {
        lastHoisted = false;
        if (
          "use" in step &&
          (!isProjectBuiltinLogin(step, actionModules) ||
            map?.loaded.map.actions?.[useActionName(step)] !== undefined)
        ) {
          const actionName = useActionName(step);
          const loaded = parsed.actionsByName.get(actionName);
          const retry = useRetry(step);
          // A `use:` with retry stays ONE resolved step (its group).
          const expandedCount = retry
            ? 1
            : (loaded?.expandedStepCount ?? loaded?.action.steps.length ?? 0);
          const rendered = actionCall(step);
          const hoisted = lastHoisted;
          if (!hoisted) mapLeading = false;
          if (rendered) {
            const callStmts = retry
              ? renderRetryLoop(rendered, retry, actionName, ctx, step.id).stmts
              : rendered.stmts;
            core.push(
              ...(hoisted
                ? []
                : [
                    comment(`step: ${oneLine(step.id ?? actionName)} (action)`),
                  ]),
              ...(ctx.wrapSteps && step.id && !hoisted
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
        mapLeading = false;
        const rendered = renderStep(step as Step, spec.settleMs, ctx);
        if (rendered.exported) ctx.coverage.stepsExported += 1;
        core.push(...rendered.stmts);
      }
      delete ctx.stepIndex;
      core.push(blank);
    }
    core.push(comment(`--- outcomes (the contract) ---`));
    for (const outcome of spec.outcomes) {
      core.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
      const rendered = renderOutcome(outcome, ctx);
      if (rendered.exported) ctx.coverage.outcomesExported += 1;
      if (ctx.wrapSteps) {
        core.push(
          block(
            `await test.step(${JSON.stringify(outcome.id)}, async () => {`,
            rendered.stmts,
            `});`,
          ),
          blank,
        );
      } else {
        core.push(...rendered.stmts, blank);
      }
    }
    if (specUse) {
      // A fixture that only sets state (a login) is destructured but never
      // read: `void` keeps noUnusedParameters / no-unused-vars quiet.
      const unread = [...specUse.fixtures]
        .filter(([, entry]) => !entry.referenced && !entry.providesPage)
        .map(([name]) => name)
        .toSorted();
      core.unshift(...unread.map((name) => raw(`void ${name};`)));
    }
    body.push(...renderBodyEnvelope(spec, ctx, core));
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
    // The legacy hook (no `--preconditions`) keeps today's emission exactly.
    const preconditionEnv = legacyHook
      ? renderPreconditionEnv(spec.preconditions?.env, ctx)
      : undefined;
    const usesProjectRoot = projectRoot !== undefined;
    const hostPreconditions: HostPrecondition[] = [];
    const preconditionLines = specPreconditions.map((p) => {
      const resolvedCwd = resolvePreconditionCwd(specDir, p.cwd);
      const timeoutMs = p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
      allPreconditions.set(JSON.stringify([p.run, resolvedCwd, timeoutMs]), {
        ...p,
        cwd: resolvedCwd,
        timeoutMs,
        specDir,
      });
      if (!isDocumentaryPrecondition(p.run)) {
        hostPreconditions.push({
          ...(p.name ? { name: p.name } : {}),
          run: p.run,
          cwd: resolvedCwd,
          timeoutMs,
          ...(spec.preconditions?.env ? { env: spec.preconditions.env } : {}),
        });
      }
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
    // Legacy: shell strings in a beforeAll. `--preconditions inline`: the
    // same hook through the bounded helper (argv spawn where no shell is
    // needed, host paths through cairnProjectPath).
    const preconditionStmts =
      legacyHook && executablePreconditions.length > 0
        ? executablePreconditions.map((p) => {
            const cwdExpr = emitPreconditionCwd(specDir, p.cwd, projectRoot);
            const timeoutMs = p.timeoutMs ?? DEFAULT_PRECONDITION_TIMEOUT_MS;
            const redact = redactOption(p.run, spec.preconditions?.env);
            return raw(
              `await runPrecondition(${emitStr(p.run, ctx.usage)}, { cwd: ${cwdExpr}, timeoutMs: ${timeoutMs}${
                preconditionEnv ? `, env: ${preconditionEnv}` : ""
              }${redact ? `, ${redact}` : ""} });`,
            );
          })
        : [];
    const inlineHook: Stmt | undefined =
      plan.inline && !legacyHook && executablePreconditions.length > 0
        ? renderPreconditionHook(
            executablePreconditions,
            spec.preconditions?.env,
            ctx,
            specDir,
            preconditionBudget,
            timeoutBudgetComment(preconditionBudget),
            opts.host?.testTimeoutMs,
          )
        : undefined;
    const runsInHook = preconditionStmts.length > 0 || inlineHook !== undefined;
    if (plan.global) {
      for (const pre of hostPreconditions) {
        globalPreconditions.set(
          JSON.stringify([pre.run, pre.cwd, pre.timeoutMs, pre.env ?? null]),
          pre,
        );
      }
      for (const gate of hostGates(parsed.resolved)) {
        globalGates.set(gate.target, gate);
      }
      for (const [index, fixture] of hostFixtures.entries()) {
        const ref = specFixtureRefs[index]!;
        const existing = globalFixtures.get(fixture.name);
        if (!existing) {
          globalFixtures.set(fixture.name, {
            ...fixture,
            reset: ref.reset,
            write: ref.write,
          });
        } else {
          existing.keys = [...new Set([...existing.keys, ...fixture.keys])];
          existing.reset = existing.reset || ref.reset;
          existing.write = existing.write || ref.write;
          if (
            JSON.stringify(existing.with ?? null) !==
            JSON.stringify(fixture.with ?? null)
          ) {
            addRisk(
              ctx,
              "globalPreconditions",
              `fixture ${fixture.name} is ensured once, with the parameters of the first spec that lists it; this spec asks for different \`with:\` values`,
              "fixtures",
            );
          }
        }
      }
      if (hostFixtures.length > 0) {
        addRisk(
          ctx,
          "globalPreconditions",
          `fixture(s) ${hostFixtures.map((fixture) => fixture.name).join(", ")} are ensured once by global-setup and stay live for the whole suite (cairn run ensures them just for this spec), so other specs see their data; cairn fixtures reset runs once, not before this spec`,
          "fixtures",
        );
      }
      if (hostPreconditions.length > 0) {
        addRisk(
          ctx,
          "globalPreconditions",
          `${hostPreconditions.length} precondition command(s) run once in global-setup for the whole suite, not before this spec; backend state a previous spec left behind is not reset`,
          "preconditions",
        );
      }
    }
    if (!plan.global && plan.manifest && hostPreconditions.length > 0) {
      addRisk(
        ctx,
        "requiredSetup",
        `${hostPreconditions.length} precondition command(s) are listed in .cairn-export.json for the host to run; this export does not run them`,
        "preconditions",
      );
    }
    if (
      !plan.global &&
      !plan.manifest &&
      !runsInHook &&
      hostPreconditions.length > 0
    ) {
      addRisk(
        ctx,
        "requiredSetup",
        `${hostPreconditions.length} precondition command(s) must run before this test (--preconditions skip: this export does not run them)`,
        "preconditions",
      );
    }
    const hookSource = inlineHook ? print([inlineHook]) : "";

    if (ctx.usedProbe) {
      ctx.usedLib?.add("probe");
      if (ctx.usedProbe.capture) ctx.usedLibNames?.add("cairnCapture");
      if (ctx.usedProbe.table) {
        ctx.usedLibNames?.add("cairnReadTable");
        ctx.usedLibNames?.add("cairnJudgeTable");
      }
    }
    if (ctx.usedPoll) {
      ctx.usedLib?.add("poll");
      ctx.usedLibNames?.add("cairnPoll");
    }
    const testBodySource = print(body);
    const usesProjectPath = (testBodySource + hookSource).includes(
      "cairnProjectPath(",
    );
    const usesProjectRootFn = usesProjectRoot && preconditionStmts.length > 0;
    if (usesProjectPath || usesProjectRootFn) needsProjectRoot = true;
    if (runsInHook || ctx.usedCommand) commandModuleNeeded = true;

    const head: Stmt[] = [
      comment(
        `Generated by \`cairn export playwright --project\`. Source: ${displayPath(projectRoot, parsed.path)}`,
      ),
      comment(`Intent: ${oneLine(spec.intent)}`),
    ];
    if (preconditionLines.length > 0) {
      head.push(
        comment(
          executablePreconditions.length === 0
            ? `Documentary preconditions only (echo) — nothing runs before this test.`
            : runsInHook
              ? `Preconditions run in this file's beforeAll — see README.`
              : plan.global
                ? `Preconditions run once in global-setup — see README.`
                : plan.manifest
                  ? `Preconditions are listed in .cairn-export.json, not run here — see README.`
                  : `Preconditions are not run by this export (--preconditions skip) — see README.`,
        ),
      );
    }
    const usesExpect = usesExpectCall(
      testBodySource + preconditionStmts.map((s) => print([s])).join("\n"),
    );
    if (specUse?.testImport) {
      const hostTestRef = specUse.testImport;
      head.push(blank);
      if (usesExpect)
        head.push(raw(`import { expect } from "@playwright/test";`));
      head.push(
        raw(
          `import { ${
            hostTestRef.name === "test" ? "test" : `${hostTestRef.name} as test`
          } } from ${JSON.stringify(hostTestRef.specifier)};`,
        ),
      );
    } else {
      head.push(
        blank,
        raw(
          `import { ${
            usesExpect ? "expect, " : ""
          }test } from "@playwright/test";`,
        ),
      );
    }
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
    if (preconditionStmts.length > 0) {
      head.push(
        raw(
          `import { runPrecondition } from ${JSON.stringify(`${importRoot}/preconditions${extName}`)};`,
        ),
      );
    }
    if (ctx.usedCommand) {
      head.push(commandImportStmt(ctx.usedCommand, importRoot, extName));
    }
    const pageClassImports = new Map<string, string>();
    for (const name of [...usedActions].toSorted()) {
      const mod = actionModules.get(name)!;
      if (mod.method) {
        pageClassImports.set(
          mod.method.className,
          `${importRoot}/lib/pages/${mod.method.file.replace(/\.[jt]s$/, "")}${extName}`,
        );
        continue;
      }
      head.push(
        raw(
          `import { ${mod.fnName} } from ${JSON.stringify(`${importRoot}/actions/${name}${extName}`)};`,
        ),
      );
    }
    for (const [className, specifier] of [...pageClassImports].toSorted(
      ([a], [b]) => a.localeCompare(b),
    )) {
      head.push(
        raw(`import { ${className} } from ${JSON.stringify(specifier)};`),
      );
    }
    if (specUse) {
      for (const [specifier, names] of [...specUse.imports].toSorted(
        ([a], [b]) => a.localeCompare(b),
      )) {
        head.push(
          raw(
            `import { ${[...names].toSorted().join(", ")} } from ${JSON.stringify(specifier)};`,
          ),
        );
      }
      if (specUse.storage?.generated) {
        head.push(
          raw(
            `import { ${
              plan.global ? "" : "cairnEnsureState, "
            }cairnStatePath } from ${JSON.stringify(`${importRoot}/lib/authState${extName}`)};`,
          ),
        );
      }
    }
    head.push(...runTokenConst(ctx));

    addSpecRisks(parsed.resolved, ctx, {
      ...(opts.lateBoundEnv ? {} : readOptional(parsed.path)),
      extraSourceTexts: opts.lateBoundEnv
        ? []
        : [...parsed.actionsByName.values()].map((loaded) => loaded.rawSource),
    });
    finalizeCoverage(ctx.coverage);

    const tags = playwrightTags(spec.metadata?.tags);
    // E9: the page (a fixture may provide it) and the fixtures the map binds.
    const pageFixture = specUse
      ? [...specUse.fixtures].find(([, entry]) => entry.providesPage)?.[0]
      : undefined;
    const fixtureParams = [
      pageFixture ? `${pageFixture}: page` : "page",
      ...(specUse
        ? [...specUse.fixtures.keys()]
            .filter((name) => name !== pageFixture)
            .toSorted()
        : []),
    ].join(", ");
    const testKw = ctx.coverage.fixme ? "test.fixme" : "test";
    const testOpen =
      tags.length > 0
        ? `${testKw}(${JSON.stringify(spec.name)}, { tag: ${JSON.stringify(tags)} }, async ({ ${fixtureParams} }${
            needsNodeVerifierEvidence ? ", testInfo" : ""
          }) => {`
        : `${testKw}(${JSON.stringify(spec.name)}, async ({ ${fixtureParams} }${
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
    if (
      spec.coldStart === "guest" &&
      opts.host?.storageState !== undefined &&
      !specUse?.storage
    ) {
      // The host's projects start signed in; a guest spec must not.
      suiteBody.push(
        comment(
          "coldStart: guest — the host's projects set use.storageState; this spec starts signed out.",
        ),
        raw(`test.use({ storageState: { cookies: [], origins: [] } });`),
      );
    }
    if (specUse && (specUse.options.size > 0 || specUse.storage)) {
      suiteBody.push(
        raw(
          `test.use({ ${[
            ...[...specUse.options].map(([name, expr]) => `${name}: ${expr}`),
            ...(specUse.storage
              ? [`storageState: ${specUse.storage.pathExpr}`]
              : []),
          ].join(", ")} });`,
        ),
      );
    }
    if (
      specUse?.storage &&
      [...specUse.fixtures.entries()].some(([, entry]) => entry.providesPage)
    ) {
      const providing = [...specUse.fixtures.entries()].find(
        ([, entry]) => entry.providesPage,
      )![0];
      addRisk(
        ctx,
        "mappedStorageState",
        `the test starts from the storageState of ${specUse.storage.action}, but its page comes from the host fixture ${providing}; a fixture that builds its own browser context (browser.newContext()) never sees test.use({ storageState }) — check that it uses Playwright's context fixture`,
        specUse.storage.action,
      );
    }
    if (specUse?.storage?.generated && specUse.storage.stateName) {
      if (plan.global) {
        globalAuthStates.add(specUse.storage.stateName);
        addRisk(
          ctx,
          "globalPreconditions",
          `the storageState of ${specUse.storage.action} is written once by global-setup (--preconditions global): wire it as the host's globalSetup, or the file is missing`,
          specUse.storage.action,
        );
      } else {
        suiteBody.push(...apiLoginHook(specUse.storage.stateName));
      }
    }
    if (inlineHook) suiteBody.push(inlineHook);
    if (preconditionStmts.length > 0) {
      suiteBody.push(
        block(
          `test.beforeAll(async () => {`,
          [
            block(`if (process.env.SKIP_PRECONDITIONS === "1") {`, [
              raw(`return;`),
            ]),
            ...setTimeoutStmts(
              preconditionBudget,
              timeoutBudgetComment(preconditionBudget),
              opts.host?.testTimeoutMs,
            ),
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
      optionalEnv: [...ctx.usage.optionalEnvNames]
        .filter((name) => !ctx.usage.envNames.has(name))
        .toSorted(),
      preconditions: preconditionLines,
      setup: {
        preconditions: hostPreconditions,
        gates: hostGates(parsed.resolved),
        fixtures: hostFixtures,
      },
    });
  }

  const globalHasWork =
    globalPreconditions.size > 0 ||
    globalGates.size > 0 ||
    globalFixtures.size > 0 ||
    globalAuthStates.size > 0;
  if (
    commandModuleNeeded ||
    globalHasWork ||
    (legacyHook &&
      parsedSpecs.some((parsed) =>
        (parsed.spec.preconditions?.commands ?? []).some(
          (command) =>
            !isDocumentaryPrecondition(
              typeof command === "string" ? command : command.run,
            ),
        ),
      ))
  ) {
    files.push({
      relPath: `preconditions${lang === "js" ? ".js" : ".ts"}`,
      source: renderCommandModule(lang),
    });
  }
  let globalEnv: string[] = [];
  if (plan.global && (globalHasWork || !opts.into)) {
    const rendered = renderGlobalSetupModule({
      preconditions: [...globalPreconditions.values()],
      gates: [...globalGates.values()],
      fixtures: [...globalFixtures.values()],
      authStates: [...globalAuthStates].toSorted(),
      lang,
      projectRoot,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      ...(opts.envName ? { envName: opts.envName } : {}),
    });
    globalEnv = rendered.envNames;
    for (const name of globalEnv) allEnv.add(name);
    files.push({
      relPath: `global-setup${lang === "js" ? ".js" : ".ts"}`,
      source: rendered.source,
    });
    if (globalHasWork && projectRoot) needsProjectRoot = true;
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
          {
            ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
            hostCommands: plan.hostCommands,
            inlinePreconditions: plan.inline,
          },
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
    if (!plan.global) {
      files.push({
        relPath: `global-setup${lang === "js" ? ".js" : ".ts"}`,
        source: renderGlobalSetup(
          [...allPreconditions.values()],
          lang,
          projectRoot,
          plan,
        ),
      });
    }
  }

  // E9: generated page objects, the API-login state module, its .gitignore.
  if (map) {
    for (const page of map.renderPageFiles()) files.push(page);
    const authState = map.renderAuthStateModule();
    if (authState) {
      files.push({
        relPath: `lib/authState${lang === "js" ? ".js" : ".ts"}`,
        source: authState,
      });
      const ignore = map.authGitignore();
      if (ignore)
        files.push({ relPath: ignore.relPath, source: ignore.source });
      projectUsedLib.add("request");
    }
    for (const name of map.requiredEnv) allEnv.add(name);
    const reports = map.sortedReports();
    for (const report of specs) {
      const own = reports.filter((entry) => entry.specs.includes(report.name));
      if (own.length > 0) report.mapped = own;
    }
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
        ...(opts.host ? { host: opts.host } : {}),
        plan,
        ...(opts.preconditions
          ? { preconditionsMode: opts.preconditions }
          : {}),
        ...(opts.verifiers ? { verifiersMode: opts.verifiers } : {}),
        ...(opts.gateEnv && opts.gateEnv.length > 0
          ? { gateEnv: [...opts.gateEnv] }
          : {}),
        globalHasWork,
        ...(map && opts.map
          ? {
              map: {
                file: mapFileForReadme(opts.outDir, opts.map.path),
                strict: map.strict,
                actions: map.sortedReports(),
                states: [...map.states.keys()].toSorted(),
              },
            }
          : {}),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.testIdAttribute
          ? { testIdAttribute: opts.testIdAttribute }
          : {}),
        ...(opts.viewport ? { viewport: opts.viewport } : {}),
        ...aggregatePlaywrightCapture(parsedSpecs.map((p) => p.spec)),
      },
    ),
  });

  // Data glue brings the runner modules it judges with (and the workbook
  // reader) along, as files of lib/ next to it.
  const dataPieces = DATA_PIECES.filter((piece) => projectUsedLib.has(piece));
  for (const name of dataRuntimeModules(dataPieces)) projectUsedLib.add(name);
  if (dataNeedsWorkbook(dataPieces)) projectUsedLib.add("workbook");
  // `lib/request` calls the runner's matchers.
  if (projectUsedLib.has("request")) projectUsedLib.add("matchers");
  for (const libName of [...projectUsedLib].toSorted()) {
    if (libName === "workbook") {
      // The SDK's own reader (plain JS) and its declarations.
      files.push({
        relPath: `${RUNTIME_LIB_DIR}/workbook.js`,
        source: readWorkbookSource("workbook.js"),
      });
      if (lang === "ts") {
        files.push({
          relPath: `${RUNTIME_LIB_DIR}/workbook.d.ts`,
          source: readWorkbookSource("workbook.d.ts"),
        });
      }
      continue;
    }
    files.push({
      relPath: playwrightLibRelPath(libName, lang),
      source: renderLibModule(
        libName,
        lang,
        widgets,
        opts.envAuth,
        opts.appHandles,
        opts.host?.moduleSystem,
      ),
    });
  }
  if (needsProjectRoot) {
    files.push({
      relPath: `lib/projectRoot${lang === "js" ? ".js" : ".ts"}`,
      source: renderProjectRootRuntime(
        lang,
        relativeFromExportRootToProject(opts.outDir, projectRoot),
        opts.host?.moduleSystem,
      ),
    });
  }

  for (const file of files) assertNoLateBoundLeak(file.source, file.relPath);

  // E8: module plumbing for the host tree (imports, aliases, lint banner).
  const hostFiles =
    opts.host && opts.outDir
      ? files.map((file) => ({
          ...file,
          source: postprocessHostFile(file.relPath, file.source, {
            host: opts.host!,
            outDir: realpathNearest(resolvePath(opts.outDir!)),
          }),
        }))
      : files;

  return {
    files: hostFiles,
    verifierFiles: copiedVerifierFiles,
    evalFiles: collectEvalFiles(evalFiles),
    fixtureFiles: [...fixtureFiles]
      .map(([sourcePath, relPath]) => ({ sourcePath, relPath }))
      .toSorted((a, b) => a.relPath.localeCompare(b.relPath)),
    specs,
    requiredEnv: [...allEnv].toSorted(),
    ...(map ? { mapped: map.sortedReports() } : {}),
  };
}

/** The map file as a README names it: relative to the export, never an absolute path. */
function mapFileForReadme(outDir: string | undefined, mapPath: string): string {
  if (!outDir) return basename(mapPath);
  return (
    relative(realpathNearest(resolvePath(outDir)), realpathNearest(mapPath))
      .split(sep)
      .join("/") || basename(mapPath)
  );
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
  specVars: Record<string, ConfigVarValue>,
  lang: ExportLang,
  opts: {
    verifierFiles: Set<string>;
    evalFiles: Set<string>;
    fixtureFiles?: Map<string, string>;
    usedLib: Set<PlaywrightLibModule>;
    projectRoot?: string;
    configDir?: string;
    envAuth?: ExportEnvAuth;
    /** Modules of actions this one may `use:` (emitted before it). */
    nestedModules?: ReadonlyMap<string, ActionModule>;
    /** `--preconditions inline|global`: run steps export through the helper. */
    hostCommands?: boolean;
    testIdAttribute?: string;
    strictLocators?: boolean;
    /** null: the host's attribute is not statically readable (explicit selectors). */
    hostTestIdAttribute?: string | null;
    /** E9: emit the action as a page-object method instead of a function. */
    method?: { className: string; methodName: string; pageProperty: string };
    /**
     * E9: a nested `use:` the export map binds (a page-object method call);
     * the importing file is this module's own file.
     */
    mapNested?: (
      step: UseStep,
      importerRel: string,
      ctx: EmitCtx,
    ) => { rendered: Rendered; imports: string[] } | undefined;
  },
): ActionModule {
  // Actions live in actions/; generated page objects in lib/pages/.
  const root = opts.method ? "../.." : "..";
  const ownRel = opts.method
    ? `lib/pages/${kebabCase(opts.method.className)}${
        lang === "js" ? ".js" : ".ts"
      }`
    : `actions/${loaded.action.name}${lang === "js" ? ".js" : ".ts"}`;
  const mapImports: string[] = [];
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
        envDefaultRef: envDefaultSentinel,
        lateEnv: true,
        runtime: { runToken: RUN_TOKEN_SENTINEL },
      });
    } catch {
      action = loaded.action;
    }
  }

  const ctx = newEmitCtx(lang, {
    specDir: dirOf(loaded.path),
    verifierImportPrefix: `${root}/verifiers`,
    verifierFiles: opts.verifierFiles,
    evalFiles: opts.evalFiles,
    ...(opts.fixtureFiles ? { fixtureFiles: opts.fixtureFiles } : {}),
    ...(opts.projectRoot ? { fixtureRoot: opts.projectRoot } : {}),
    libImportPrefix: `${root}/lib`,
    usedLib: opts.usedLib,
    // Callers decide which captured values they splice; the action returns all.
    bindAllProduced: true,
    ...(opts.envAuth ? { envAuth: opts.envAuth } : {}),
    ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.hostCommands ? { hostCommands: true } : {}),
    ...(opts.testIdAttribute ? { testIdAttribute: opts.testIdAttribute } : {}),
    ...(opts.strictLocators ? { strictLocators: true } : {}),
    ...(opts.hostTestIdAttribute !== undefined
      ? { hostTestIdAttribute: opts.hostTestIdAttribute }
      : {}),
  });
  ctx.coverage.stepsTotal = action.steps.length;
  ctx.referencedWaits = referencedWaitNames(action.steps);
  const body: Stmt[] = [];
  const nestedImports = new Map<string, ActionModule>();
  /** A nested action is a call to its own module (undefined: no module). */
  const nestedCall = (step: UseStep): Rendered | undefined => {
    const mapped = opts.mapNested?.(step, ownRel, ctx);
    if (mapped) {
      mapImports.push(...mapped.imports);
      return mapped.rendered;
    }
    const nested = opts.nestedModules?.get(useActionName(step));
    if (!nested) return undefined;
    nestedImports.set(nested.fnName, nested);
    if (nested.usesRunToken) ctx.usage.runToken = true;
    for (const envName of nested.envNames) ctx.usage.envNames.add(envName);
    propagateActionCoverage(
      ctx.coverage,
      nested,
      step.id ?? useActionName(step),
    );
    const passed = resolveActionCallVars(
      nested.declaredKeys,
      nested.defaults,
      specVars,
      useActionVars(step),
    );
    return {
      stmts: [raw(`await ${moduleCall(nested, passed, ctx)};`)],
      exported: true,
    };
  };
  // F14: a `use:` nested in a repeat / if block calls its module too.
  ctx.renderUseCall = (step) => nestedCall(step);
  for (const step of action.steps) {
    const call = "use" in step ? nestedCall(step) : undefined;
    if ("use" in step && call) {
      const callId = step.id ?? useActionName(step);
      const retry = useRetry(step);
      body.push(
        comment(`step: ${oneLine(callId)} (action)`),
        ...(retry
          ? renderRetryLoop(call, retry, useActionName(step), ctx, step.id)
              .stmts
          : call.stmts),
      );
      ctx.coverage.stepsExported += 1;
      continue;
    }
    const rendered = renderStep(step, undefined, ctx);
    if (rendered.exported) ctx.coverage.stepsExported += 1;
    body.push(...rendered.stmts);
  }
  const produced = new Map(ctx.produced ?? []);
  const produces = new Map<string, { source: ProducedSource; name: string }>();
  for (const key of produced.keys()) {
    const [source, name] = key.split(":") as [ProducedSource, string];
    produces.set(runtimeRefKey(source, name), { source, name });
  }
  body.unshift(...renderBindingDeclarations(ctx));
  if (produced.size > 0) {
    const group = (source: ProducedSource): string => {
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
        `return { ${PRODUCED_SOURCES.map((source) => `${source}: ${group(source)}`).join(", ")} };`,
      ),
    );
    opts.usedLib.add("splice");
    ctx.usedLibNames?.add("type CairnActionBindings");
  }
  // Only the vars the body reads: a declared-but-unused one would trip the
  // host's noUnusedLocals / noUnusedParameters (and the call site passes
  // exactly these).
  const usedKeys = declaredKeys.filter((key) => ctx.usage.varNames.has(key));
  if (usedKeys.length > 0) {
    body.unshift(
      ...usedKeys.map((key) =>
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

  const fnName = actionIdent(loaded.action.name);
  const varsAnnot =
    lang === "ts" && usedKeys.length > 0
      ? `: { ${usedKeys
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
  // A method has no `page` parameter: the base class holds it.
  const lead = opts.method ? "" : ", ";
  const varsParam = usedKeys.length > 0 ? `${lead}vars${varsAnnot} = {}` : "";
  const tokenParam = ctx.usage.runToken
    ? `${varsParam === "" && opts.method ? "" : ", "}runToken${
        lang === "ts" ? ": string" : ""
      }`
    : "";
  const returnType =
    lang === "ts"
      ? produced.size > 0
        ? ": Promise<CairnActionBindings>"
        : ": Promise<void>"
      : "";

  if (ctx.usedProbe) {
    opts.usedLib.add("probe");
    if (ctx.usedProbe.capture) ctx.usedLibNames?.add("cairnCapture");
    if (ctx.usedProbe.table) {
      ctx.usedLibNames?.add("cairnReadTable");
      ctx.usedLibNames?.add("cairnJudgeTable");
    }
  }
  if (ctx.usedPoll) {
    opts.usedLib.add("poll");
    ctx.usedLibNames?.add("cairnPoll");
  }
  const bodySource = print(body);
  const usesProjectPath = bodySource.includes("cairnProjectPath(");
  const playwrightImports = [
    ...(usesExpectCall(bodySource) ? ["expect"] : []),
    ...(ctx.usesTestInfo ? ["test"] : []),
    ...(lang === "ts" && !opts.method ? ["type Page"] : []),
  ];
  if (opts.method) {
    // A page-object method: the file is assembled with its siblings (the
    // class of the export map's generated pages), so only the parts return.
    const pageLine = /\bpage\b/.test(bodySource)
      ? [raw(`const page = this.${opts.method.pageProperty};`)]
      : [];
    const methodImports = [
      ...(playwrightImports.length > 0
        ? [
            `import { ${playwrightImports.join(", ")} } from "@playwright/test";`,
          ]
        : []),
      ...libImportStmts(ctx.usedLibNames ?? new Set(), lang, root).map((stmt) =>
        print([stmt]),
      ),
      ...(ctx.usedCommand
        ? [
            print([
              commandImportStmt(
                ctx.usedCommand,
                root,
                lang === "js" ? ".js" : "",
              ),
            ]),
          ]
        : []),
      ...(usesProjectPath
        ? [
            `import { cairnProjectPath } from "${root}/lib/projectRoot${
              lang === "js" ? ".js" : ""
            }";`,
          ]
        : []),
      ...[...nestedImports.values()]
        .filter((nested) => nested.method?.className !== opts.method!.className)
        .map((nested) =>
          nested.method
            ? `import { ${nested.method.className} } from "./${nested.method.file.replace(/\.[jt]s$/, "")}${
                lang === "js" ? ".js" : ""
              }";`
            : `import { ${nested.fnName} } from "${root}/${nested.relPath.replace(/\.ts$/, "")}";`,
        ),
      ...mapImports,
    ];
    for (const libName of ctx.usedLib ?? []) opts.usedLib.add(libName);
    const methodStmt = block(
      `async ${opts.method.methodName}(${varsParam}${tokenParam})${returnType} {`,
      [...pageLine, ...body],
    );
    const methodSource = print([methodStmt]);
    addGeneratedSourceRisks(ctx.coverage, methodSource);
    finalizeCoverage(ctx.coverage);
    assertNoLateBoundLeak(methodSource, ownRel);
    return {
      fnName,
      relPath: ownRel,
      source: "",
      envNames: [...ctx.usage.envNames],
      usesRunToken: ctx.usage.runToken,
      hasVars: usedKeys.length > 0,
      declaredKeys: usedKeys,
      defaults: loaded.actionDefaults,
      produces,
      coverage: ctx.coverage,
      usesCommand: ctx.usedCommand !== undefined,
      usesProjectPath,
      method: {
        className: opts.method.className,
        methodName: opts.method.methodName,
        file: ownRel.replace(/^lib\/pages\//, ""),
      },
      pageParts: { imports: methodImports, method: methodStmt },
    };
  }
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
    ...(ctx.usedCommand
      ? [commandImportStmt(ctx.usedCommand, "..", lang === "js" ? ".js" : "")]
      : []),
    ...(usesProjectPath
      ? [
          raw(
            `import { cairnProjectPath } from "../lib/projectRoot${
              lang === "js" ? ".js" : ""
            }";`,
          ),
        ]
      : []),
    ...[...nestedImports.values()].map((nested) =>
      raw(
        `import { ${nested.fnName} } from "./${nested.relPath
          .replace(/^actions\//, "")
          .replace(/\.ts$/, "")}";`,
      ),
    ),
    ...mapImports.map((line) => raw(line)),
    blank,
    block(
      `export async function ${fnName}(page${
        lang === "ts" ? ": Page" : ""
      }${varsParam}${tokenParam})${returnType} {`,
      body,
    ),
  ];
  for (const libName of ctx.usedLib ?? []) opts.usedLib.add(libName);

  const relPath = ownRel;
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
    hasVars: usedKeys.length > 0,
    declaredKeys: usedKeys,
    defaults: loaded.actionDefaults,
    produces,
    coverage: ctx.coverage,
    usesCommand: ctx.usedCommand !== undefined,
    usesProjectPath,
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
  specVars: Record<string, unknown>,
  callVars?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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
  passed: Record<string, unknown>,
  mod: Pick<ActionModule, "hasVars" | "usesRunToken">,
  ctx: EmitCtx,
): string[] {
  const args: string[] = [];
  const hasPassed = Object.keys(passed).length > 0;
  if (hasPassed) args.push(emitValue(passed, ctx.usage));
  else if (mod.hasVars && mod.usesRunToken) args.push("{}");
  if (mod.usesRunToken) args.push("RUN_TOKEN");
  return args;
}

/** `fn(page, …)`, or `new Class(page).method(…)` for a generated page object. */
function moduleCall(
  mod: ActionModule,
  passed: Record<string, unknown>,
  ctx: EmitCtx,
  pageExpr = "page",
): string {
  const args = formatActionCallArgs(passed, mod, ctx);
  return mod.method
    ? `new ${mod.method.className}(${pageExpr}).${mod.method.methodName}(${args.join(", ")})`
    : `${mod.fnName}(${[pageExpr, ...args].join(", ")})`;
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
  ["fixtureOutputs", ["cairnFixtureOutputs"]],
  ["probe", ["cairnCapture", "cairnReadTable", "cairnJudgeTable"]],
  ["poll", ["cairnPoll"]],
  ...DATA_PIECES.map((piece): [PlaywrightLibModule, string[]] => [
    piece,
    dataPieceExports(piece),
  ]),
  ["widgets", ["cairnWidget", "cairnWidgetForm"]],
  ["request", ["cairnRequest", "cairnRequestMatrix", "cairnLogin"]],
  ["auth", ["CAIRN_AUTH"]],
  ["prelude", ["CAIRN_PRELUDE", "cairnAppCheck"]],
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

/** F18: `use: login` that no action module answers — the built-in login. */
function isProjectBuiltinLogin(
  step: UseStep,
  modules: ReadonlyMap<string, ActionModule>,
): boolean {
  return (
    useActionName(step) === BUILTIN_LOGIN_ACTION &&
    useRetry(step) === undefined &&
    !modules.has(BUILTIN_LOGIN_ACTION)
  );
}

function renderLibModule(
  name: PlaywrightLibModule,
  lang: ExportLang,
  widgets: PreparedWidgets,
  envAuth: ExportEnvAuth | undefined,
  appHandles: AppHandles | undefined,
  moduleSystem?: ExportModuleSystem,
): string {
  switch (name) {
    case "prelude":
      return renderPreludeRuntime(lang, appHandles);
    case "request":
      return renderRequestRuntime(lang);
    case "auth":
      return renderAuthRuntime(
        lang,
        envAuth
          ? emitPlainValue(prepareExportAuth(envAuth), newRefUsage())
          : "{}",
      );
    case "widgets":
      return renderWidgetsRuntime(lang, widgets);
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
      return renderFixturesRuntime(lang, moduleSystem);
    case "probe":
      return renderProbeRuntime(lang);
    case "poll":
      return renderPollRuntime(lang);
    case "fixtureOutputs":
      return renderFixtureOutputsRuntime(lang);
    case "workbook":
      throw new Error("the workbook reader is written as plain files");
    default:
      return isDataPiece(name)
        ? renderDataPieceModule(name, lang)
        : renderRuntimeModule(name, lang);
  }
}

function isDataPiece(name: PlaywrightLibModule): name is DataPiece {
  return (DATA_PIECES as readonly string[]).includes(name);
}

/** A file of the SDK next to the verifier modules (read from this package). */
function readWorkbookSource(file: "workbook.js" | "workbook.d.ts"): string {
  return readFileSync(new URL(`../../sdk/${file}`, import.meta.url), "utf8");
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
  host?: Pick<HostEmit, "testsDir" | "testSuffix">,
): string {
  // A host profile decides where Playwright will find the tests and how the
  // files are named (its testDir / testMatch); otherwise `tests/<name>.spec`.
  const base = host ? host.testsDir : "tests";
  const suffix = host ? host.testSuffix : ".spec";
  const prefix = base === "" ? "" : `${base}/`;
  const file = `${parsed.spec.name}${suffix}${ext.replace(/^\.spec/, "")}`;
  if (!sourceRoot) return `${prefix}${file}`;
  const rel = relative(sourceRoot, parsed.path).replaceAll("\\", "/");
  const dir = dirname(rel);
  if (dir.startsWith("..")) return `${prefix}${file}`;
  const nested = dir === "." || dir === "" ? "" : `${dir}/`;
  return `${prefix}${nested}${file}`;
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

/**
 * Output keys the spec's steps (and an exported teardown) read from a fixture
 * (`${fixtures.<name>.<key>…}`).
 */
function fixtureOutputKeys(
  spec: Spec,
  name: string,
  hostCommands: boolean,
): string[] {
  const keys = new Set<string>();
  const text = JSON.stringify([
    spec.steps ?? [],
    hostCommands ? teardownPlan(spec.teardown).steps : [],
    // Data verifiers resolve `${fixtures.…}` operands through a typed scope.
    spec.outcomes.map((outcome) =>
      typedOutcomeOperands(
        outcome.verify,
        undefined,
        specNeedsRichNetworkLog(spec),
      ),
    ),
  ]);
  for (const m of text.matchAll(
    new RegExp(`\\$\\{fixtures\\.${name}\\.([^.}]+)`, "g"),
  )) {
    keys.add(m[1]!);
  }
  return [...keys].toSorted();
}

/** `import { … } from "<root>/preconditions"` for the helper pieces a unit calls. */
function commandImportStmt(
  used: NonNullable<EmitCtx["usedCommand"]>,
  importRoot: string,
  extName: string,
): Stmt {
  const names = [
    ...(used.command ? ["cairnCommand"] : []),
    ...(used.json ? ["cairnLastJson"] : []),
    ...(used.context ? ["cairnTestContext"] : []),
    ...(used.precondition ? ["runPrecondition"] : []),
  ];
  return raw(
    `import { ${names.join(", ")} } from ${JSON.stringify(`${importRoot}/preconditions${extName}`)};`,
  );
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
    // A late-bound baseUrl (`${env.X}` in the config) is read when the
    // suite runs; never the value set while exporting.
    ...(baseUrl ? [`    baseURL: ${emitStr(baseUrl, newRefUsage())},`] : []),
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
  projectRoot: string | undefined,
  plan: PreconditionsPlan,
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
  const where = plan.inline
    ? "Per-spec preconditions run in each test file's beforeAll (mirroring the\n// Cairntrace per-spec semantics — a single global gate would let backend\n// debris pile up between tests)."
    : plan.manifest
      ? "Per-spec preconditions are listed in .cairn-export.json for the host to run\n// (--preconditions manifest); this export does not run them."
      : "Per-spec preconditions are NOT run by this export (--preconditions skip).";
  const logged = plan.inline
    ? "per-spec preconditions run in each file's beforeAll"
    : plan.manifest
      ? "per-spec preconditions are listed in .cairn-export.json (run them yourself)"
      : "per-spec preconditions are not run (--preconditions skip)";
  return `// Generated by \`cairn export playwright --project\`.
//
// ${where} This hook is the place for ONE-TIME suite setup (auth warmup,
// seeding); it currently only logs.${
    names
      ? ` Known per-spec\n// preconditions (not run here), for reference:\n${names}`
      : ""
  }
export default async function globalSetup()${
    lang === "ts" ? ": Promise<void>" : ""
  } {
  console.log("[global-setup] ${logged}");
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
      method?: unknown;
    }
  >,
  lang: ExportLang,
  /** The global setup runs preconditions, gates or fixtures. */
  /** E9: the export map and how it bound the actions. */
  extras: {
    plan?: PreconditionsPlan;
    preconditionsMode?: ExportPreconditionsMode;
    verifiersMode?: ExportVerifiersMode;
    gateEnv?: string[];
    globalHasWork?: boolean;
    into?: boolean;
    fixtures?: boolean;
    manifest?: boolean;
    host?: HostEmit;
    baseUrl?: string;
    testIdAttribute?: string;
    viewport?: { width: number; height: number };
    screenshot?: "on" | "off" | "only-on-failure";
    trace?: "on" | "off" | "retain-on-failure";
    map?: {
      file: string;
      strict: boolean;
      actions: readonly MappedActionReport[];
      states: readonly string[];
    };
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
          extras.plan?.global
            ? "global-setup.*        runs gates, preconditions and fixtures ONCE before the suite"
            : "global-setup.*        one-time suite hook (per-spec preconditions run in beforeAll)",
        ]),
    "preconditions.*       bounded host-command runner: filtered env, process-tree timeout",
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
    ...(extras.into && extras.host
      ? [...hostReadmeLines(extras.host), ...globalSetupReadmeLines(extras)]
      : extras.into
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
              ? `    baseURL: process.env.BASE_URL ?? ${emitStr(extras.baseUrl, newRefUsage())},`
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
            ...globalSetupReadmeLines(extras),
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
    ...(extras.plan?.global && extras.globalHasWork
      ? [
          "- `CAIRN_BIN` — the `cairn` CLI global-setup calls for gates and fixtures (default: `cairn` on PATH).",
          "- `CAIRN_FIXTURES_FILE` — JSON of the fixture outputs global-setup writes (tests read it; set it yourself when you run the fixtures elsewhere).",
        ]
      : []),
    ...optionalEnvReadme(specs),
    "",
    ...hostCommandsReadme(extras),
    ...mapReadmeLines(extras.map),
    "## Actions",
    "",
    ...[...actions.entries()]
      .filter(([, a]) => !a.method)
      .map(([name, a]) => {
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

/** E9: README section of the export map's bindings. */
function mapReadmeLines(
  map:
    | {
        file: string;
        strict: boolean;
        actions: readonly MappedActionReport[];
        states: readonly string[];
      }
    | undefined,
): string[] {
  if (!map) return [];
  return [
    "## Export map",
    "",
    `Actions are bound to this tree's own constructs by \`${map.file}\`${
      map.strict ? " (strict: every action used must be mapped)" : ""
    }; the map is part of the export's inputs (\`.cairn-export.json\` records its digest, \`--check\` regenerates with it).`,
    "",
    ...(map.actions.length > 0
      ? map.actions.map(
          (entry) =>
            `- \`${entry.action}\` → ${
              entry.treatment === "fixture"
                ? "host fixture"
                : entry.treatment === "method"
                  ? "host page object"
                  : entry.treatment === "storageState"
                    ? "storageState"
                    : "generated page object"
            } \`${entry.target}\`${entry.note ? ` — ${entry.note}` : ""}`,
        )
      : ["- (no action was bound or generated)"]),
    "",
    ...(map.states.length > 0
      ? [
          `API logins (${map.states.join(", ")}) are written to \`.auth/\` as Playwright storageState files by \`lib/authState\`: credentials come from the environment when the sign-in runs, and \`.auth/.gitignore\` keeps the saved sessions out of version control.`,
          "",
        ]
      : []),
  ];
}

/** How to register the generated global setup in the host config. */
function globalSetupReadmeLines(extras: {
  plan?: PreconditionsPlan;
  globalHasWork?: boolean;
}): string[] {
  return extras.plan?.global && extras.globalHasWork
    ? [
        'This export runs gates, preconditions and fixtures in a global setup (`--preconditions global`). Register it in the **host** config (a `globalSetup` array runs several): `globalSetup: [..., require.resolve("./<this folder>/global-setup")]` (or the ESM equivalent).',
        "",
      ]
    : [];
}

/** README section of an `--into` tree adapted to a host Playwright config. */
function hostReadmeLines(host: HostEmit): string[] {
  const where =
    host.testsDir === ""
      ? "in this folder"
      : `in \`${host.testsDir}/\` under this folder`;
  return [
    "Adapted to the **host** Playwright config, read statically at export time (the host config is not modified):",
    "",
    `- module system: ${
      host.moduleSystem === "cjs"
        ? "CommonJS (`__dirname`)"
        : "ES modules (`import.meta.url`)"
    } — ${host.moduleReason}`,
    `- tests are \`<name>${host.testSuffix}.*\` files ${where}, where the host's testDir / testMatch find them`,
    host.testTimeoutMs === undefined
      ? "- test timeout: the host's is not statically readable (or its projects disagree); every spec sets `test.setTimeout` to its own derived budget"
      : host.testTimeoutMs === Number.MAX_SAFE_INTEGER
        ? "- test timeout: the host disables it; no `test.setTimeout` is emitted"
        : `- test timeout: the host's is ${host.testTimeoutMs}ms; a spec only calls \`test.setTimeout\` when its derived budget is higher`,
    host.testIdAttribute === undefined
      ? "- test ids: the host's `testIdAttribute` is not statically readable (or its projects disagree); every `testid` locator is an explicit attribute selector"
      : `- test ids: the host reads \`${host.testIdAttribute}\`; \`testid\` locators that mean another attribute are emitted as explicit attribute selectors`,
    host.bypassCsp
      ? "- bypassCSP: the host sets it, so page evals run under a strict CSP"
      : "- bypassCSP: the host does not set it; the export refuses page evals unless `--allow-eval-without-bypass` was given",
    ...(host.alias
      ? [
          `- generated modules import each other through the tsconfig alias \`${host.alias.prefix}*\``,
        ]
      : []),
    ...(host.prettier
      ? ["- files are formatted with the host's local prettier and its config"]
      : []),
    ...host.notes.map((note) => `- ${note}`),
    "",
    "These tests share one backend pipeline when preconditions or verifiers touch it: run them serially (`--workers=1`) unless your specs are independent.",
    "",
    "Add `.cairn-export.json` and `.cairn-export-verify.*` to the host's `.prettierignore` (and `.gitignore` for the verify report) if it checks the whole tree.",
    "",
  ];
}

/** `${env.X:-default}` the tests read at run time (the test works without them). */
function optionalEnvReadme(specs: ProjectSpecReport[]): string[] {
  const names = [
    ...new Set(specs.flatMap((spec) => spec.optionalEnv)),
  ].toSorted();
  return names.map(
    (name) =>
      `- \`${name}\` — read at run time (\`\${env.${name}:-default}\` in a spec); an unset or empty value falls back to the authored default.`,
  );
}

/** What the export did with host commands, verifiers, fixtures and gates. */
function hostCommandsReadme(extras: {
  plan?: PreconditionsPlan;
  preconditionsMode?: ExportPreconditionsMode;
  verifiersMode?: ExportVerifiersMode;
  gateEnv?: string[];
}): string[] {
  const plan = extras.plan;
  const lines: string[] = ["## Host commands and verifiers", ""];
  if (plan?.global) {
    lines.push(
      "Exported with `--preconditions global`: `global-setup.*` runs the specs' readiness gates (`cairn wait`), their preconditions and their config fixtures (`cairn fixtures ensure`) once before the suite, and tears the run-scoped fixtures down afterwards. The commands run once for the whole suite, not before each spec. `run:` steps and `teardown:` run in the test body through the bounded helper in `preconditions.*`. Gates and fixtures need the `cairn` CLI and the source project (`CAIRN_PROJECT_ROOT`).",
    );
  } else if (extras.preconditionsMode === "inline") {
    lines.push(
      "Exported with `--preconditions inline`: each file's `beforeAll` runs its preconditions through the bounded helper in `preconditions.*` (an argument-vector spawn where no shell is needed, `/bin/sh -c` otherwise); `run:` steps and `teardown:` run in the test body (teardown in a `finally`). Fixtures and readiness gates are not exported in this mode.",
    );
  } else if (extras.preconditionsMode === "manifest") {
    lines.push(
      "Exported with `--preconditions manifest`: nothing runs the preconditions; they are listed in `.cairn-export.json` (`preconditions`, with `${env.X}` placeholders and cwd relative to `source.projectRoot`) for the host to run before the suite.",
    );
  } else if (extras.preconditionsMode === "skip") {
    lines.push(
      "Exported with `--preconditions skip`: no host command runs; the commands are reported as requiredSetup risks.",
    );
  } else {
    lines.push(
      "Default: each file's `beforeAll` runs its preconditions through `preconditions.*`. `run:` steps, `teardown:`, fixtures and readiness gates are not exported (re-export with `--preconditions inline|global`).",
    );
  }
  if (extras.verifiersMode === "gate") {
    lines.push(
      "",
      `Exported with \`--verifiers gate\`: a node / datasource verifier runs only when its required env is present${
        extras.gateEnv && extras.gateEnv.length > 0
          ? ` (${extras.gateEnv.map((name) => `\`${name}\``).join(", ")} plus any env its fixtures read)`
          : ""
      }; otherwise the test ends with \`test.skip(...)\` after every other assertion held — reported skipped, never passed. A verifier that cannot run in an export (datasource verifiers, inline node scripts) is always reported skipped.`,
    );
  } else if (extras.verifiersMode === "drop") {
    lines.push(
      "",
      "Exported with `--verifiers drop`: node / datasource verifiers are omitted (verifierDropped risks), so a test can pass without them.",
    );
  }
  lines.push("");
  return lines;
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
