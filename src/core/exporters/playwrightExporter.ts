import type {
  CountVerifier,
  NetworkVerifier,
  TextMatcher,
  UrlMatcher,
  Verifier,
} from "../schema/verifier.v1";
import {
  isConsoleVerifier,
  isCountVerifier,
  isHttpJsonVerifier,
  isNetworkVerifier,
  isNoFailedRequestsVerifier,
  isNotTextVerifier,
  isScriptVerifier,
  isTextVerifier,
  isUrlVerifier,
  notTextVerifierRegion,
  textVerifierRegion,
} from "../schema/verifier.v1";
import type {
  BatchSubStep,
  ClickUntil,
  IfStep,
  Locator,
  NetworkPostcondition,
  Outcome,
  RepeatStep,
  RetryUseStep,
  Spec,
  Step,
  UseRetry,
  UseStep,
  RunnerWaitCondition,
  WaitStep,
  WhenObject,
} from "../schema/spec.v1";
import {
  clickLocator,
  fillLocator,
  formFieldDependsOn,
  isBuiltinLoginUse,
  isFormFieldObject,
  isRetryUseStep,
  isRunnerDrivenWait,
  isWaitGroup,
  isWidgetStep,
  plainWaitCondition,
  useActionName,
  useActionVars,
  useRetry,
  walkSteps,
  widgetTargetRef,
  withoutPostcondition,
  type WidgetStep,
  type WidgetTarget,
} from "../schema/spec.v1";
// F4/F5/F16 export coverage: datasource/value/table verifiers, poll, expect/capture.
import type { ExpectStep } from "../schema/spec.v1";
import { evalStepRatio, formatEvalRatio, type EvalRatio } from "./evalRatio";
import type { ValueMatcher } from "../schema/verifier.v1";
import {
  isFileVerifier,
  isHttpVerifier,
  isMongoVerifier,
  isProcessVerifier,
  isTableVerifier,
  isTemporalVerifier,
  isValueVerifier,
  isXlsxVerifier,
  verifierPoll,
} from "../schema/verifier.v1";
import { expectLocator } from "../runner/verifiers/expect";
import { describeMatcher } from "../runner/verifiers/matchers";
import { type ExportEnvTarget, renderRequiresEnvGuard } from "./requiresGuard";
import { formatWhen } from "../runner/conditions";
import {
  type ParsedStepOrigins,
  resolveStepFile,
  stepFileScopeAt,
} from "../runner/stepFiles";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { specFixtureRefParts } from "../fixtures/schema";
import { teardownPlan } from "../schema/spec.v1";
import { gateRefList } from "../gates/schema";
import {
  blank,
  block,
  braces,
  comment,
  iff,
  ifElse,
  print,
  raw,
  tryCatch,
  verbatim,
  type Stmt,
} from "./codegen";
import {
  assertNoLateBoundLeak,
  collectRuntimeRefKeys,
  emitCssAttributeSelector,
  emitEscapedRegexSource,
  emitNormalizedText,
  emitStr,
  emitValue,
  hasSecretSentinel,
  humanizeSentinels,
  newRefUsage,
  parseTemplateValue,
  runtimeRefKey,
  bindingIdent,
  toIdent,
  type RefUsage,
  type RuntimeRefSource,
} from "./templateValue";
import {
  isDocumentaryPrecondition,
  playwrightTestTimeoutBudget,
  playwrightPreconditionTimeoutBudget,
  timeoutBudgetComment,
} from "./playwrightTimeout";
import {
  commandRuntimeImports,
  renderCommandRuntimeLines,
} from "./commandRuntime";
import {
  preconditionsPlan,
  type ExportPreconditionsMode,
  type ExportVerifiersMode,
  type HostFixture,
  type HostGate,
  type HostPrecondition,
} from "./exportModes";
import {
  legacyRunSkip,
  renderCaptureStep,
  renderPreconditionHook,
  renderRunStep,
  renderTeardownFinally,
  wrapPolled,
} from "./playwrightHostSteps";
import {
  renderPollHelperLines,
  renderProbeHelperLines,
} from "./playwrightRuntimeHost";
import {
  dataRefKeys,
  renderExpectRequestStep,
  renderFileOutcome,
  renderHttpOutcome,
  renderNetworkJudged,
  renderNoFailedRequestsJudged,
  renderValueOutcome,
  renderXlsxOutcome,
  specNeedsRichNetworkLog,
  type ExportHttpDatasource,
} from "./playwrightDataVerifiers";
import { inlineDataPieces, type DataPiece } from "./playwrightRuntimeData";
import {
  renderPreludeHelperLines,
  renderSpliceHelperLines,
  renderWidgetHelperLines,
  type PlaywrightLibModule,
  type PreludeHelperName,
  type WidgetHelperName,
} from "./playwrightRuntime";
import { usesCairnPrelude, type AppHandles } from "../prelude/prelude";
import { defaultWidgets, type PreparedWidgets } from "../widgets/runtime";
import {
  prepareExportAuth,
  renderRequestHelperLines,
  requestRuntimeImports,
  type ExportEnvAuth,
  type RequestHelperName,
} from "./requestRuntime";

export type ExportLang = "ts" | "js";

export interface ExportPlaywrightOptions {
  /** Path to the source spec; included in the generated file's header comment. */
  sourcePath?: string;
  /**
   * Path the generated file will be written to. When set, script.file
   * verifier imports are emitted RELATIVE to it (portable across machines);
   * otherwise they fall back to absolute paths.
   */
  outPath?: string;
  /** Override the test title. Defaults to spec.name. */
  testTitle?: string;
  /** Emit TypeScript (default) or plain JavaScript. */
  lang?: ExportLang;
  /**
   * The parse origins of `spec.steps` (`parseSpec` result): relative
   * `eval.file` / `upload.path` of a step that came from an imported action
   * then resolve against the action's directory, exactly like the runner
   * (spec-relative fallback included). Without it they resolve against the
   * spec's directory.
   */
  stepOrigins?: ParsedStepOrigins;
  /**
   * The environment whose baseUrl the export baked in: the requires guard
   * is tied to it, and a policy refusal there is reported as an `envPolicy`
   * risk (the test always skips).
   */
  envTarget?: ExportEnvTarget;
  /**
   * F15: widget config (`browser.fieldRoot`, `browser.widgets` with custom
   * driver sources) for the inlined `cairnWidget` helper. Built-ins and the
   * default fieldRoot when omitted.
   */
  widgets?: PreparedWidgets;
  /**
   * F18: the export environment's `auth:` block, for `use: login`
   * (`cairnLogin`). Without it a `use: login` step is a hard skip.
   */
  envAuth?: ExportEnvAuth;
  /**
   * F20: config `browser.appHandle` for the inlined `CAIRN_PRELUDE` (evals
   * that use `__cairn`, `wait: { app }`).
   */
  appHandles?: AppHandles;
  /**
   * E10 `--preconditions`: `inline` runs preconditions in a `beforeAll` and
   * exports `run:` steps and `teardown:` through the bounded command helper;
   * `skip` / `manifest` (and no flag) list them without running anything.
   * `global` needs a project (a standalone file has no global setup).
   */
  preconditions?: ExportPreconditionsMode;
  /** E10 `--verifiers keep|gate|drop` for node / datasource verifiers. */
  verifiers?: ExportVerifiersMode;
  /** Extra env vars every gated node verifier requires (`--gate-env`). */
  gateEnv?: readonly string[];
  /**
   * Env vars each config datasource needs (its `${env.X}` / `${secrets.X}`
   * references without a default), for `--verifiers gate`.
   */
  datasourceEnv?: Readonly<Record<string, readonly string[]>>;
  /**
   * The export environment's `kind: http` datasources (credentials stay
   * `${env.X}` / `${secrets.X}` text), for exported `http` verifiers.
   */
  httpDatasources?: Readonly<Record<string, ExportHttpDatasource>>;
  /**
   * The spec was parsed with late-bound environment (`parseSpec`'s
   * `lateEnv`): no `${env.X}` value is baked, so the `envBaked` scan of
   * the spec source is skipped.
   */
  lateBoundEnv?: boolean;
  /** Config `browser.testIdAttribute` for the capture probe. */
  testIdAttribute?: string;
  /**
   * Strict locators: do not append `.first()` to a semantic locator without
   * an explicit `nth`. Playwright's strict mode then fails the test on an
   * ambiguous locator, exactly as `cairn run --backend playwright` does.
   * Default (false): `.first()`, the agent-browser first-match semantics.
   */
  strictLocators?: boolean;
}

export interface ExportCoverageSkip {
  kind: "step" | "outcome" | "when";
  id?: string;
  reason: string;
  /**
   * Soft skips (snapshots, monitors, documentary notes) only lose
   * diagnostics and never mark the generated test `test.fixme`.
   */
  soft?: boolean;
}

/**
 * Kinds of hazards that still COMPILE but may make the exported test behave
 * differently from `cairn run`:
 *  - envBaked: `${env.X}` / `${env.X:-default}` resolved to a literal at export;
 *  - absolutePath: a machine-local absolute path in generated code;
 *  - requiredInfra: preconditions that need docker / mongosh / tmux / … ;
 *  - requiredSetup: preconditions a single-file export does not run;
 *  - unresolvedSplice: a `${requests|evals|artifacts.…}` splice with no binding;
 *  - literalSplice: a runtime ref in an outcome field the runner never
 *    splices (compared as literal text by both `cairn run` and the export);
 *  - evalRatio: share of steps that are opaque in-page `eval` JavaScript;
 *  - secretInBrowser: a secret spliced into page-evaluated source/arguments;
 *  - envPolicy: the environment the export baked in is one where the
 *    environment policy refuses the spec, so the test always skips;
 *  - verifierGated: `--verifiers gate` reports the outcome as skipped (never
 *    passed) unless its required env is present, or it cannot run at all;
 *  - verifierDropped: `--verifiers drop` omitted the outcome, so the test can
 *    pass without it;
 *  - globalPreconditions: `--preconditions global` runs the commands once for
 *    the whole suite instead of before each spec;
 *  - pollApproximated: a `poll:` stability window the export emulates;
 *  - transformInProcess: a `transform` step's node module runs inside the
 *    Playwright test process instead of a child with a filtered environment;
 *  - teardownBestEffort: the spec teardown runs in the test body's `finally`,
 *    which a Playwright test timeout or a failed `beforeAll` can skip, and
 *    cairn's SIGINT / early-stop teardown paths have no equivalent;
 *  - mappedOrdering: an export-map fixture / storageState runs before the
 *    test body, but the `use:` step it replaces came after other steps;
 *  - mappedStorageState: the test starts from a storageState (an API login)
 *    but its page comes from a host fixture (`providesPage`), which may build
 *    its own browser context that never sees `test.use({ storageState })`.
 */
export type ExportSemanticRiskKind =
  | "envBaked"
  | "absolutePath"
  | "requiredInfra"
  | "requiredSetup"
  | "unresolvedSplice"
  | "literalSplice"
  | "evalRatio"
  | "secretInBrowser"
  | "envPolicy"
  | "verifierGated"
  | "verifierDropped"
  | "globalPreconditions"
  | "pollApproximated"
  | "teardownBestEffort"
  | "transformInProcess"
  | "mappedOrdering"
  | "mappedStorageState";

export interface ExportSemanticRisk {
  kind: ExportSemanticRiskKind;
  /** Step/outcome id (or "preconditions") the risk is attached to. */
  id?: string;
  detail: string;
}

export interface ExportCoverage {
  stepsTotal: number;
  stepsExported: number;
  outcomesTotal: number;
  outcomesExported: number;
  /** Every skip, hard and soft (kept for backward compatibility). */
  skips: ExportCoverageSkip[];
  /** The soft subset of `skips`: lost diagnostics only (snapshot, monitor). */
  diagnosticSkips: ExportCoverageSkip[];
  /** Exported-but-different hazards; see ExportSemanticRiskKind. */
  semanticRisks: ExportSemanticRisk[];
  /** True when a hard skip makes the generated test `test.fixme`. */
  fixme: boolean;
  /** E12: page `eval` steps / total steps (present when the spec has any eval). */
  evalRatio?: EvalRatio;
}

export interface ExportPlaywrightResult {
  source: string;
  lang: ExportLang;
  coverage: ExportCoverage;
  /** Env var names the generated test reads at runtime (late-bound secrets). */
  requiredEnv: string[];
  /** Preconditions that must run before the test (not exportable to Playwright). */
  preconditions: string[];
  /** Env vars read with a `:-default` (the test works without them). */
  optionalEnv: string[];
  /**
   * The host setup the spec declares, for `--preconditions manifest` and the
   * `global` setup: commands, gates and fixtures (late-bound strings, never
   * environment values).
   */
  setup: ExportHostSetup;
}

export interface ExportHostSetup {
  preconditions: HostPrecondition[];
  gates: HostGate[];
  fixtures: HostFixture[];
}

export function newCoverage(stepsTotal = 0, outcomesTotal = 0): ExportCoverage {
  return {
    stepsTotal,
    stepsExported: 0,
    outcomesTotal,
    outcomesExported: 0,
    skips: [],
    diagnosticSkips: [],
    semanticRisks: [],
    fixme: false,
  };
}

/** Recompute the derived coverage fields (diagnosticSkips, fixme, deduped risks). */
export function finalizeCoverage(coverage: ExportCoverage): ExportCoverage {
  coverage.diagnosticSkips = coverage.skips.filter((entry) => entry.soft);
  coverage.fixme = coverage.skips.some((entry) => !entry.soft);
  const seen = new Set<string>();
  coverage.semanticRisks = coverage.semanticRisks.filter((entry) => {
    const key = `${entry.kind}\u0000${entry.id ?? ""}\u0000${entry.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return coverage;
}

/**
 * Generate a @playwright/test source file from a Cairntrace spec.
 *
 * Architecture (three layers, each owning one concern):
 *  - render*() functions map spec constructs to a statement IR (codegen.ts) —
 *    they decide WHAT code exists, never how it is indented or quoted;
 *  - emitStr()/emitValue() (templateValue.ts) own string quoting and turn
 *    late-bound sentinels (`${secrets.X}`, unset `${env.X}`, `${run.token}`)
 *    into `process.env.X` / RUN_TOKEN splices at the exact emission site, and
 *    `${requests|evals|artifacts.…}` into reads of earlier step bindings;
 *  - print() (codegen.ts) owns indentation and line joining.
 *
 * Steps map to Playwright actions; outcomes map to expect() assertions.
 * Listener-based outcomes (network / noFailedRequests / console) install
 * collectors at the top of the test before any actions, then assert at the end.
 * A generated file that still carries a late-bound sentinel is refused
 * (LateBoundLeakError) instead of returned.
 *
 * Output is meant to live in a separate Playwright project; this function
 * doesn't write files — the CLI does. Spec must have `use:` already expanded
 * (run `parseSpec` first and pass `result.resolved`).
 */
export function exportPlaywright(
  spec: Spec,
  opts: ExportPlaywrightOptions = {},
): ExportPlaywrightResult {
  const lang: ExportLang = opts.lang ?? "ts";
  const title = opts.testTitle ?? spec.name;
  const steps = spec.steps ?? [];
  const coverage = newCoverage(steps.length, spec.outcomes.length);
  if (opts.preconditions === "global") {
    throw new Error(
      "--preconditions global needs --project or --into: a standalone file has no global setup",
    );
  }
  const plan = preconditionsPlan(opts.preconditions, false);
  const ctx: EmitCtx = {
    lang,
    coverage,
    usage: newRefUsage(),
    ...(opts.sourcePath ? { specDir: dirname(resolve(opts.sourcePath)) } : {}),
    ...(opts.stepOrigins ? { stepOrigins: opts.stepOrigins } : {}),
    ...(opts.outPath ? { outDir: dirname(resolve(opts.outPath)) } : {}),
    postconditionCounter: 0,
    referencedRefs: referencedRuntimeRefs(spec, {
      hostCommands: plan.hostCommands,
      ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
    }),
    referencedWaits: referencedWaitNames(steps),
    produced: new Map(),
    ...(opts.envAuth ? { envAuth: opts.envAuth } : {}),
    ...(plan.hostCommands ? { hostCommands: true } : {}),
    ...(opts.testIdAttribute ? { testIdAttribute: opts.testIdAttribute } : {}),
    ...(opts.strictLocators ? { strictLocators: true } : {}),
    verifiersMode: opts.verifiers ?? "keep",
    ...(opts.gateEnv ? { gateEnv: opts.gateEnv } : {}),
    ...(opts.datasourceEnv ? { datasourceEnv: opts.datasourceEnv } : {}),
    ...(opts.httpDatasources ? { httpDatasources: opts.httpDatasources } : {}),
  };
  const timeoutBudget = playwrightTestTimeoutBudget(spec, {
    ...(opts.verifiers ? { verifiers: opts.verifiers } : {}),
    hostCommands: plan.hostCommands,
  });
  const needsNodeVerifierEvidence =
    ctx.specDir !== undefined && hasNodeFileVerifier(spec, opts.verifiers);
  if (needsNodeVerifierEvidence) {
    ctx.nodeVerifierRunDir = "cairnRunDir";
    ctx.nodeVerifierEvidence = "cairnNetworkEvidence";
  }
  if (specNeedsNetworkListener(spec)) ctx.networkRecorder = "requests";

  // ----- test body (rendered FIRST so ctx.usage knows every late-bound ref
  // before the header is assembled) -----
  const body: Stmt[] = [];

  body.push(
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
  );
  const evidenceInsertAt = body.length;

  body.push(...renderOutcomeEvidenceSetup(spec, lang, ctx));
  const bindingsInsertAt = body.length;

  const core: Stmt[] = [];
  if (steps.length > 0) {
    core.push(comment(`--- steps ---`));
    steps.forEach((step, index) => {
      ctx.stepIndex = index;
      const rendered = renderStep(step, spec.settleMs, ctx);
      if (rendered.exported) coverage.stepsExported += 1;
      core.push(...rendered.stmts);
    });
    delete ctx.stepIndex;
    core.push(blank);
  }

  core.push(comment(`--- outcomes (the contract) ---`));
  for (const outcome of spec.outcomes) {
    core.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
    const rendered = renderOutcome(outcome, ctx);
    if (rendered.exported) coverage.outcomesExported += 1;
    core.push(...rendered.stmts, blank);
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

  // ----- host preconditions: a beforeAll (inline), else listed -----
  const preCommands = (spec.preconditions?.commands ?? []).map((c) =>
    typeof c === "string" ? { run: c } : c,
  );
  const executablePreconditions = preCommands.filter(
    (c) => !isDocumentaryPrecondition(c.run),
  );
  const specDir = ctx.specDir ?? process.cwd();
  const preconditionLines: string[] = [];
  const hostPreconditions: HostPrecondition[] = executablePreconditions.map(
    (c) => ({
      ...(c.name ? { name: c.name } : {}),
      run: c.run,
      cwd: c.cwd !== undefined ? resolve(specDir, c.cwd) : specDir,
      timeoutMs: c.timeoutMs ?? 120_000,
      ...(spec.preconditions?.env ? { env: spec.preconditions.env } : {}),
    }),
  );
  let preconditionHook: Stmt | undefined;
  if (plan.inline && executablePreconditions.length > 0) {
    const budget = playwrightPreconditionTimeoutBudget(spec);
    preconditionHook = renderPreconditionHook(
      executablePreconditions,
      spec.preconditions?.env,
      ctx,
      specDir,
      budget,
      timeoutBudgetComment(budget),
    );
  }
  addSpecRisks(
    spec,
    ctx,
    opts.sourcePath && !opts.lateBoundEnv
      ? { sourceText: readSourceText(opts.sourcePath) }
      : {},
  );

  // ----- file assembly -----
  const file: Stmt[] = [];
  const envNames = [...ctx.usage.envNames].toSorted();
  const optionalEnv = [...ctx.usage.optionalEnvNames]
    .filter((name) => !ctx.usage.envNames.has(name))
    .toSorted();
  if (envNames.length > 0) {
    file.push(
      comment(
        `Secrets are NOT inlined — set before running: ${envNames.join(", ")}`,
      ),
    );
  }
  if (optionalEnv.length > 0) {
    file.push(
      comment(
        `Optional env (a default applies when unset): ${optionalEnv.join(", ")}`,
      ),
    );
  }
  file.push(
    comment(
      `Generated by Cairntrace \`cairn export playwright\`. Edit at your own risk —`,
    ),
    comment(
      `re-running export will overwrite. Source: ${opts.sourcePath ?? "<unknown>"}`,
    ),
    comment(`Intent: ${oneLine(spec.intent)}`),
    comment(`Lang: ${lang}`),
  );
  if (preCommands.length > 0) {
    for (const c of preCommands) {
      preconditionLines.push(
        humanizeSentinels(
          `${c.name ? `[${c.name}] ` : ""}${oneLine(c.run).slice(0, 160)}`,
        ),
      );
    }
    if (preconditionHook) {
      file.push(
        comment(``),
        comment(
          `Preconditions run in this file's beforeAll (SKIP_PRECONDITIONS=1 skips them):`,
        ),
        ...preconditionLines.map((line) => comment(`  ${line}`)),
      );
    } else {
      // Preconditions run OUTSIDE the browser (shell/mongo resets, pipeline
      // gates) and have no Playwright equivalent here — surface them so a CI
      // wrapper (globalSetup or a shell step) can run them before the test.
      // `--preconditions inline` runs them in a beforeAll; `--project` does by
      // default.
      if (executablePreconditions.length > 0) {
        skip(
          ctx,
          "step",
          `${executablePreconditions.length} precondition command(s) not exported — run them before the test`,
          "preconditions",
          true,
        );
        addRisk(
          ctx,
          "requiredSetup",
          `${executablePreconditions.length} precondition command(s) must run before this test (a standalone export does not execute them by default; use --preconditions inline to run them in a beforeAll, or --project)`,
          "preconditions",
        );
      }
      file.push(
        comment(``),
        comment(
          `⚠ PRECONDITIONS (NOT exported — run these before the test, e.g. in globalSetup${
            plan.manifest ? "; listed in .cairn-export.json" : ""
          }):`,
        ),
        ...preconditionLines.map((line) => comment(`  ${line}`)),
      );
    }
  }

  const usesExpect = usesExpectCall(print(body));
  const usedWidgets = ctx.usedWidgets ?? new Set<WidgetHelperName>();
  const usedRequest = ctx.usedRequestHelpers ?? new Set<RequestHelperName>();
  const requestImports = requestRuntimeImports(usedRequest);
  const importValues = new Set<string>(["test", ...requestImports.values]);
  if (usesExpect) importValues.add("expect");
  const importTypes = new Set<string>(
    lang === "ts" ? requestImports.types : [],
  );
  if (usedWidgets.size > 0 && lang === "ts") importTypes.add("Page");
  const usedPrelude = ctx.usedPrelude ?? new Set<PreludeHelperName>();
  if (usedPrelude.has("cairnAppCheck") && lang === "ts") {
    importTypes.add("Page");
  }
  if (ctx.usedProbe && lang === "ts") importTypes.add("Page");
  // Data verifiers: the runner's judge modules + glue, inlined.
  const inlinedData =
    ctx.usedData && ctx.usedData.size > 0
      ? inlineDataPieces(ctx.usedData, lang)
      : undefined;
  if (inlinedData) {
    for (const name of inlinedData.playwright.values) importValues.add(name);
    if (lang === "ts") {
      for (const name of inlinedData.playwright.types) importTypes.add(name);
    }
  }
  file.push(
    blank,
    raw(
      `import { ${[
        ...[...importValues].toSorted(),
        ...[...importTypes].toSorted().map((name) => `type ${name}`),
      ].join(", ")} } from "@playwright/test";`,
    ),
  );
  const pathNames = new Set<string>(ctx.usedNodePath ?? []);
  if (ctx.usedCommand?.context) pathNames.add("join");
  const dataNodeImports: Array<{ from: string; names: string[] }> = [];
  for (const entry of inlinedData?.node ?? []) {
    if (entry.from === "node:path") {
      for (const name of entry.names) pathNames.add(name);
    } else {
      dataNodeImports.push(entry);
    }
  }
  if (pathNames.size > 0) {
    file.push(
      raw(
        `import { ${[...pathNames].toSorted().join(", ")} } from "node:path";`,
      ),
    );
  }
  for (const entry of dataNodeImports) {
    file.push(
      raw(
        `import { ${entry.names.join(", ")} } from ${JSON.stringify(entry.from)};`,
      ),
    );
  }
  if (ctx.usedCommand) {
    file.push(
      ...commandRuntimeImports({}).map((line) => raw(line)),
      blank,
      verbatim(
        renderCommandRuntimeLines(lang, {
          ...(ctx.usedCommand.json ? { json: true } : {}),
          ...(ctx.usedCommand.context ? { context: true } : {}),
          ...(ctx.usedCommand.precondition ? { precondition: true } : {}),
        })
          .join("\n")
          .trimEnd()
          .split("\n"),
      ),
    );
  }
  if (ctx.usedProbe) {
    file.push(
      blank,
      verbatim(
        renderProbeHelperLines(lang, {
          ...(ctx.usedProbe.capture ? { capture: true } : {}),
          ...(ctx.usedProbe.table ? { table: true } : {}),
        })
          .join("\n")
          .trimEnd()
          .split("\n"),
      ),
    );
  }
  if (ctx.usedPoll) {
    file.push(
      blank,
      verbatim(renderPollHelperLines(lang).join("\n").trimEnd().split("\n")),
    );
  }
  if (inlinedData) {
    file.push(
      blank,
      verbatim(inlinedData.lines.join("\n").trimEnd().split("\n")),
    );
  }
  if (usedRequest.size > 0) {
    file.push(
      blank,
      verbatim(
        renderRequestHelperLines(lang, usedRequest)
          .join("\n")
          .trimEnd()
          .split("\n"),
      ),
    );
  }
  if (ctx.authConst !== undefined) {
    file.push(
      blank,
      raw(
        `const CAIRN_AUTH${
          lang === "ts" ? ": CairnAuth" : ""
        } = ${ctx.authConst};`,
      ),
    );
  }
  if (usedWidgets.size > 0) {
    file.push(
      blank,
      verbatim(
        renderWidgetHelperLines(lang, opts.widgets ?? defaultWidgets(), {
          form: usedWidgets.has("cairnWidgetForm"),
        })
          .join("\n")
          .trimEnd()
          .split("\n"),
      ),
    );
  }
  if (usedPrelude.size > 0) {
    file.push(
      blank,
      verbatim(
        renderPreludeHelperLines(lang, opts.appHandles, {
          appCheck: usedPrelude.has("cairnAppCheck"),
        }),
      ),
    );
  }
  if (needsNodeVerifierEvidence) {
    file.push(
      blank,
      verbatim(renderNodeVerifierEvidenceRuntime(lang).trimEnd().split("\n")),
    );
  }
  if (ctx.usage.splice || ctx.usage.unresolvedHelper) {
    file.push(
      blank,
      verbatim(
        renderSpliceHelperLines(lang, {
          splice: ctx.usage.splice,
          unresolved: ctx.usage.unresolvedHelper,
        })
          .join("\n")
          .trimEnd()
          .split("\n"),
      ),
    );
  }
  if (ctx.usage.runToken) {
    // Late-bound `${run.token}`: unique per Playwright invocation so exported
    // tests remain re-runnable (unique values keep emitting change events).
    file.push(
      blank,
      raw(
        `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random().toString(36).slice(2, 10);`,
      ),
    );
  }
  finalizeCoverage(coverage);
  const testKw = coverage.fixme ? "test.fixme" : "test";
  // requires → a run-time CAIRN_ENV guard, tied to the baked environment.
  const requiresGuard = renderRequiresEnvGuard(spec.requires, opts.envTarget);
  if (requiresGuard.lines.length > 0) {
    file.push(blank, verbatim(requiresGuard.lines));
  }
  if (requiresGuard.refusedReason) {
    addRisk(ctx, "envPolicy", requiresGuard.refusedReason, "requires");
  }
  if (preconditionHook) file.push(blank, preconditionHook);
  file.push(
    blank,
    block(
      `${testKw}(${JSON.stringify(title)}, async ({ page }${
        needsNodeVerifierEvidence ? ", testInfo" : ""
      }) => {`,
      body,
      `});`,
    ),
  );

  const source = `${print(file)}\n`;
  addGeneratedSourceRisks(coverage, source);
  finalizeCoverage(coverage);
  assertNoLateBoundLeak(
    source,
    opts.outPath ?? `${spec.name}${exportExtension(lang)}`,
    spec.name,
  );

  return {
    source,
    lang,
    coverage,
    requiredEnv: envNames,
    optionalEnv,
    preconditions: preconditionLines,
    setup: {
      preconditions: hostPreconditions,
      gates: hostGates(spec),
      fixtures: [],
    },
  };
}

/**
 * True when generated CODE calls `expect`. Every emitted assertion starts a
 * statement (`expect(…)`, `await expect(…)`, `await expect.poll(…)`), so
 * only statement starts count: an outcome described "as we expect." (a
 * comment) or a string containing "expect(" must not import an unused
 * `expect` (TS6133 under `noUnusedLocals`).
 */
export function usesExpectCall(source: string): boolean {
  return source.split("\n").some((line) => {
    const code = line.trim();
    if (code.startsWith("//")) return false;
    // F14 wait groups / assigns call expect inside an expression:
    // `x = await expect.poll(…)`, `Promise.any([expect(…)…, expect.poll(…)])`.
    return (
      /^(?:return\s+)?(?:await\s+)?expect[.(]/.test(code) ||
      // a poll sample's non-retrying `expect.configure({ timeout: 1 })`
      /^const\s+[A-Za-z_$][\w$]*\s*=\s*expect\.configure\(/.test(code) ||
      /^[A-Za-z_$][\w$]*\s*=\s*await\s+expect[.(]/.test(code) ||
      /^(?:[A-Za-z_$][\w$]*\s*=\s*)?await\s+Promise\.(?:any|all)\(\[.*\bexpect[.(]/.test(
        code,
      )
    );
  });
}

/** True when a network / noFailedRequests outcome needs the response listener. */
export function specNeedsNetworkListener(spec: Spec): boolean {
  return spec.outcomes.some(
    (outcome) =>
      isNetworkVerifier(outcome.verify) ||
      isNoFailedRequestsVerifier(outcome.verify),
  );
}

function readSourceText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/* ----- semantic risks ----- */

const INFRA_COMMAND_RE =
  /\b(docker(?:-compose)?|podman|mongosh|mongo|psql|mysql|redis-cli|tmux|kubectl|helm|temporal|tctl|aws|gcloud|az)\b/g;

const ENV_REF_RE = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;

/**
 * Spec-level hazards that compile fine but diverge from `cairn run`:
 * infra the preconditions need, env values baked at export time (needs the
 * raw source text), and the share of opaque eval steps.
 */
export function addSpecRisks(
  spec: Spec,
  ctx: EmitCtx,
  opts: { sourceText?: string; extraSourceTexts?: string[] } = {},
): void {
  for (const text of [opts.sourceText, ...(opts.extraSourceTexts ?? [])]) {
    if (text) addEnvBakedRisks(text, ctx);
  }
  for (const c of spec.preconditions?.commands ?? []) {
    const run = typeof c === "string" ? c : c.run;
    if (isDocumentaryPrecondition(run)) continue;
    const tools = [
      ...new Set([...run.matchAll(INFRA_COMMAND_RE)].map((m) => m[1]!)),
    ];
    if (tools.length > 0) {
      addRisk(
        ctx,
        "requiredInfra",
        `precondition ${
          typeof c === "string" || !c.name
            ? JSON.stringify(oneLine(run).slice(0, 80))
            : c.name
        } needs ${tools.join(", ")} on the machine running the exported suite`,
        "preconditions",
      );
    }
  }
  // Run-time setup the export does not reproduce: config fixtures (their
  // ${fixtures.…} outputs would stay literal → hard skip), the spec teardown
  // (cleanup only runs under `cairn run`) and preconditions.wait gates.
  const fixtureNames = [
    ...new Set(
      (spec.fixtures ?? []).map((ref) => specFixtureRefParts(ref).name),
    ),
  ];
  if (fixtureNames.length > 0 && !ctx.globalSetup) {
    skip(
      ctx,
      "step",
      `fixtures not exported (${fixtureNames.join(", ")}): only --preconditions global ensures them (through \`cairn fixtures ensure\`, which needs the cairn CLI); here \${fixtures.…} outputs are unavailable — verify with cairn run`,
      "fixtures",
    );
    addRisk(
      ctx,
      "requiredSetup",
      `fixtures ${fixtureNames.join(", ")} must exist before this test (\`cairn fixtures ensure <name>\`); this export neither ensures nor tears them down (use --preconditions global)`,
      "fixtures",
    );
  }
  const teardown = Array.isArray(spec.teardown)
    ? spec.teardown
    : (spec.teardown?.steps ?? []);
  if (teardown.length > 0 && !ctx.hostCommands) {
    skip(
      ctx,
      "step",
      `teardown not exported (${teardown.length} item(s)): its cleanup only runs under cairn run (export with --preconditions inline|global to run it)`,
      "teardown",
      true,
    );
    addRisk(
      ctx,
      "requiredSetup",
      `the spec teardown (${teardown.length} item(s)) is not exported: what it cleans up under cairn run is left behind by the exported test`,
      "teardown",
    );
  }
  const gateNames = gateRefList(spec.preconditions?.wait).map((ref) =>
    typeof ref === "string" ? ref : (ref.name ?? "inline gate"),
  );
  if (gateNames.length > 0 && !ctx.globalSetup) {
    skip(
      ctx,
      "step",
      `preconditions.wait not exported (${gateNames.join(", ")}): wait for readiness before the suite (\`cairn wait <gate>\`; --preconditions global does it in the global setup)`,
      "preconditions",
      true,
    );
    addRisk(
      ctx,
      "requiredSetup",
      `readiness gate(s) ${gateNames.join(", ")} must pass before this test (\`cairn wait\`); the export does not wait on them`,
      "preconditions",
    );
  }
  const evalRatio = evalStepRatio(spec);
  if (evalRatio.evalSteps > 0) {
    ctx.coverage.evalRatio = evalRatio;
    addRisk(
      ctx,
      "evalRatio",
      `${formatEvalRatio(evalRatio)} are eval — opaque page JavaScript that needs bypassCSP and cannot be reviewed as Playwright actions`,
    );
  }
}

/** Config readiness gates a spec's `preconditions.wait` lists. */
export function hostGates(spec: Spec): HostGate[] {
  return gateRefList(spec.preconditions?.wait).flatMap((ref) =>
    typeof ref === "string" ? [{ target: ref }] : [],
  );
}

function addEnvBakedRisks(text: string, ctx: EmitCtx): void {
  for (const m of text.matchAll(ENV_REF_RE)) {
    const name = m[1]!;
    const hasDefault = m[2] !== undefined;
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      addRisk(
        ctx,
        "envBaked",
        `\${env.${name}} was set while exporting and its value is inlined as a literal; the exported test will not read ${name} at run time`,
      );
    } else if (hasDefault) {
      addRisk(
        ctx,
        "envBaked",
        `\${env.${name}:-…} default was baked at export time; setting ${name} when running the exported test has no effect`,
      );
    }
  }
}

const ABSOLUTE_PATH_LITERAL_RE =
  /["'`]((?:\/(?:Users|home|root|Volumes|private|var\/folders|mnt|opt|srv)\/|[A-Za-z]:\\\\)[^"'`]*)["'`]/;

/**
 * Generated statements that take a FILE-SYSTEM path: upload inputs, module
 * imports, node verifier `specDir`, precondition `cwd`. URL routes such as
 * `page.goto("/home/feed")` share the same prefixes but are not paths.
 */
const FILE_PATH_SINK_RE =
  /\.setInputFiles\(|\bimport\(|\bspecDir:|\bcwd:|\bcairnProjectPath\(/;

/**
 * Generated-code scan: machine-local absolute paths in executable file-path
 * sinks make an export non-relocatable. Comments are documentation and URL
 * arguments are routes, so both are ignored.
 */
export function addGeneratedSourceRisks(
  coverage: ExportCoverage,
  source: string,
): void {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!FILE_PATH_SINK_RE.test(line)) continue;
    const m = ABSOLUTE_PATH_LITERAL_RE.exec(line);
    // A specific risk (e.g. an upload that was not copied) already names it.
    if (
      m &&
      !coverage.semanticRisks.some(
        (risk) => risk.kind === "absolutePath" && risk.detail.includes(m[1]!),
      )
    ) {
      coverage.semanticRisks.push({
        kind: "absolutePath",
        detail: `generated code references the machine-local path ${m[1]}`,
      });
    }
  }
}

export function addRisk(
  ctx: EmitCtx,
  kind: ExportSemanticRisk["kind"],
  detail: string,
  id?: string,
): void {
  ctx.coverage.semanticRisks.push({
    kind,
    ...(id !== undefined ? { id } : {}),
    detail,
  });
}

/**
 * What wraps the steps and outcomes of one test body: the spec `teardown:`
 * as `try { … } finally { … }` (`--preconditions inline|global`), and the
 * closing `test.skip(...)` of `--verifiers gate` — AFTER the teardown, and
 * only once every other assertion held, so a test whose gated verifier could
 * not run is reported skipped, never passed.
 */
export function renderBodyEnvelope(
  spec: Spec,
  ctx: EmitCtx,
  core: Stmt[],
): Stmt[] {
  const out: Stmt[] = [];
  const plan = teardownPlan(spec.teardown);
  if (ctx.hostCommands && plan.steps.length > 0) {
    addRisk(
      ctx,
      "teardownBestEffort",
      `the spec teardown runs in the test body's finally: a test timeout or a failed beforeAll precondition can skip it, and cairn's SIGINT / early-stop teardown paths have no Playwright equivalent${
        plan.failRun
          ? "; failRun fails a passing test after the whole teardown ran"
          : ""
      }`,
      "teardown",
    );
    out.push(
      raw(
        `let cairnRunStatus${ctx.lang === "ts" ? ": string" : ""} = "failed";`,
      ),
      block(`try {`, [...core, raw(`cairnRunStatus = "passed";`)]),
      ...renderTeardownFinally(plan, ctx, (step) =>
        renderStep(step, spec.settleMs, ctx),
      ),
    );
  } else {
    out.push(...core);
  }
  if (ctx.gated) {
    out.push(
      comment(
        `--verifiers gate: a verifier whose required env is missing (or that cannot run here) is reported as skipped, never passed`,
      ),
      raw(
        `test.skip(cairnSkipped.length > 0, "verifier(s) not run: " + cairnSkipped.join("; "));`,
      ),
    );
  }
  return out;
}

/** Identifier of a fixture's outputs binding. */
export function fixtureBinding(name: string): string {
  return bindingIdent("cairnFixtures", name);
}

/** Hoisted `let` declarations for the runtime bindings a scope produced. */
export function renderBindingDeclarations(ctx: EmitCtx): Stmt[] {
  const produced = [...(ctx.produced ?? new Map<string, string>()).values()];
  const waits = [...(ctx.waitBindings ?? new Map<string, string>()).values()];
  const fixtures = [...(ctx.fixtureOutputs ?? new Map<string, string[]>())];
  const preamble: Stmt[] = [];
  if (fixtures.length > 0) {
    markLib(ctx, "fixtureOutputs", "cairnFixtureOutputs");
    preamble.push(
      comment(
        `Outputs of the config fixtures the global setup ensured (cairn fixtures ensure).`,
      ),
      ...fixtures.map(([name, keys]) =>
        raw(
          `const ${fixtureBinding(name)} = cairnFixtureOutputs(${JSON.stringify(name)}, ${JSON.stringify(keys)});`,
        ),
      ),
    );
  }
  if (ctx.gated) {
    preamble.push(
      comment(`Verifiers --verifiers gate could not run (reported skipped).`),
      raw(`const cairnSkipped${ctx.lang === "ts" ? ": string[]" : ""} = [];`),
    );
  }
  if (preamble.length > 0) preamble.push(blank);
  if (produced.length === 0 && waits.length === 0) return preamble;
  const type = ctx.lang === "ts" ? ": unknown" : "";
  const waitType =
    ctx.lang === "ts" ? ": { matched: boolean; index?: number }" : "";
  return [
    ...preamble,
    ...(produced.length > 0
      ? [
          comment(
            `Values captured by request/eval/download \`assign:\` for later \${…} splices.`,
          ),
          ...produced.map((ident) => raw(`let ${ident}${type};`)),
        ]
      : []),
    ...(waits.length > 0
      ? [
          comment(
            `Results of waits with \`assign:\` (\${waits.<name>.matched}).`,
          ),
          ...waits.map((ident) =>
            raw(`let ${ident}${waitType} = { matched: false };`),
          ),
        ]
      : []),
    blank,
  ];
}

/**
 * F14: wait `assign` names a step list reads — `${waits.<name>…}` splices
 * and `var: waits.<name>…` predicates.
 */
export function referencedWaitNames(steps: readonly Step[]): Set<string> {
  const text = JSON.stringify(steps);
  const names = new Set<string>();
  for (const m of text.matchAll(
    /\$\{waits\.([A-Za-z0-9_]+)|"var":"waits\.([A-Za-z0-9_]+)/g,
  )) {
    names.add((m[1] ?? m[2])!);
  }
  return names;
}

export function hasNodeFileVerifier(
  spec: Spec,
  verifiers: ExportVerifiersMode = "keep",
): boolean {
  // `--verifiers drop` emits none, so it needs no run-dir / evidence setup
  // (an unread `cairnRunDir` would fail noUnusedLocals).
  if (verifiers === "drop") return false;
  return spec.outcomes.some(
    (outcome) =>
      isScriptVerifier(outcome.verify) &&
      outcome.verify.script.runtime === "node" &&
      outcome.verify.script.file !== undefined,
  );
}

/**
 * Install every listener-backed evidence collector before the first step.
 * Both single-file and project exports use this helper so rendering a network
 * or console outcome can never drift away from declaring its backing buffer.
 */
export function renderOutcomeEvidenceSetup(
  spec: Spec,
  lang: ExportLang,
  ctx: EmitCtx,
): Stmt[] {
  const stmts: Stmt[] = [];
  const needsNetwork = spec.outcomes.some(
    (outcome) =>
      isNetworkVerifier(outcome.verify) ||
      isNoFailedRequestsVerifier(outcome.verify),
  );
  const needsConsole = spec.outcomes.some((outcome) =>
    isConsoleVerifier(outcome.verify),
  );

  if (needsNetwork && specNeedsRichNetworkLog(spec)) {
    // A body / count / assign outcome judges real request bodies and times:
    // the log keeps every request (in memory only) and joins the status.
    ctx.richNetwork = true;
    useData(ctx, "dataNetwork", "cairnTrackRequests");
    stmts.push(raw(`const requests = cairnTrackRequests(page);`), blank);
  } else if (needsNetwork) {
    const typeAnn =
      lang === "ts"
        ? `: Array<{ url: string; method: string; status?: number }>`
        : "";
    stmts.push(
      raw(`const requests${typeAnn} = [];`),
      raw(
        `page.on("response", (r) => requests.push({ url: r.url(), method: r.request().method(), status: r.status() }));`,
      ),
      blank,
    );
  }
  if (needsConsole) {
    const typeAnn = lang === "ts" ? `: string[]` : "";
    stmts.push(
      raw(`const consoleErrors${typeAnn} = [];`),
      block(
        `page.on("console", (msg) => {`,
        [
          block(`if (msg.type() === "error") {`, [
            raw(`consoleErrors.push(msg.text());`),
          ]),
        ],
        `});`,
      ),
      raw(`page.on("pageerror", (e) => consoleErrors.push(e.message));`),
      blank,
    );
  }

  return stmts;
}

export function renderNodeVerifierEvidenceSetup(
  spec: Spec,
  ctx: EmitCtx,
): Stmt[] {
  const redaction = spec.redaction;
  const emitArray = (values: string[] | undefined): string =>
    `[${(values ?? []).map((value) => emitValue(value, ctx.usage)).join(", ")}]`;
  const configuredValues = emitArray(redaction?.values);
  const headers = emitArray(redaction?.headers);
  const queryParams = emitArray(redaction?.queryParams);
  const storageKeys = emitArray(redaction?.storageKeys);
  // Every late-bound env reference may be a vault secret even when its name is
  // innocuous (MONGO_URI, DATABASE_URL, ...). Feed its runtime value into the
  // artifact scrubber without ever writing that value into generated source.
  const lateBoundValues = [...ctx.usage.envNames]
    .toSorted()
    .map((name) => `process.env[${JSON.stringify(name)}] ?? ""`);
  const values = [`...${configuredValues}`, ...lateBoundValues].join(", ");

  return [
    comment(
      `Node verifiers consume a self-contained, sanitized Cairn-compatible run directory.`,
    ),
    raw(`const ${ctx.nodeVerifierRunDir} = testInfo.outputPath("cairn-run");`),
    raw(
      `const ${ctx.nodeVerifierEvidence} = createCairnNetworkEvidence(page, { headers: ${headers}, queryParams: ${queryParams}, storageKeys: ${storageKeys}, values: [${values}] });`,
    ),
    blank,
  ];
}

/**
 * Self-contained runtime embedded into exported tests that invoke node file
 * verifiers. It intentionally captures no headers and only retains bounded,
 * valid JSON request bodies after recursive redaction.
 */
export function renderNodeVerifierEvidenceRuntime(lang: ExportLang): string {
  const ts = lang === "ts";
  const lines = [
    `// Cairn-compatible network evidence for exported node verifiers.`,
    ...(ts
      ? [
          `interface CairnEvidenceRequest {`,
          `  url(): string;`,
          `  method(): string;`,
          `  postData(): string | null;`,
          `  headers(): Record<string, string>;`,
          `}`,
          `interface CairnEvidenceResponse {`,
          `  request(): CairnEvidenceRequest;`,
          `  status(): number;`,
          `}`,
          `interface CairnEvidencePage {`,
          `  on(event: "request", listener: (request: CairnEvidenceRequest) => void): unknown;`,
          `  on(event: "response", listener: (response: CairnEvidenceResponse) => void): unknown;`,
          `  on(event: "requestfinished", listener: (request: CairnEvidenceRequest) => void): unknown;`,
          `  on(event: "requestfailed", listener: (request: CairnEvidenceRequest) => void): unknown;`,
          `}`,
          `interface CairnEvidenceRedaction {`,
          `  headers?: string[];`,
          `  queryParams?: string[];`,
          `  storageKeys?: string[];`,
          `  values?: string[];`,
          `  responseTimeoutMs?: number;`,
          `}`,
          `interface CairnNetworkEntry {`,
          `  url: string;`,
          `  method: string;`,
          `  timestamp: number;`,
          `  responseTimestamp?: number;`,
          `  durationMs?: number;`,
          `  status?: number;`,
          `  error?: string;`,
          `  postData?: string;`,
          `  postDataBytes?: number;`,
          `  postDataTruncated?: boolean;`,
          `  postDataOmittedReason?: "non-json" | "invalid-json" | "oversized" | "capture-error";`,
          `}`,
          `interface CairnApiRequestEvidence {`,
          `  url: string;`,
          `  method: string;`,
          `  status?: number;`,
          `  timestamp?: number;`,
          `  body?: unknown;`,
          `  contentType?: string;`,
          `}`,
        ]
      : []),
    `const CAIRN_MAX_JSON_POST_DATA_BYTES = 64 * 1024;`,
    `const CAIRN_PATCH_RESPONSE_TIMEOUT_MS = 120_000;`,
    `const CAIRN_SENSITIVE_NAME_RE = /authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|code[_-]?verifier|otp|passcode|credential|assertion/i;`,
    ``,
    `export function createCairnNetworkEvidence(page${
      ts ? ": CairnEvidencePage" : ""
    }, redaction${ts ? ": CairnEvidenceRedaction" : ""} = {}) {`,
    `  const entries${ts ? ": CairnNetworkEntry[]" : ""} = [];`,
    `  const byRequest = new WeakMap${
      ts ? "<CairnEvidenceRequest, CairnNetworkEntry>" : ""
    }();`,
    `  const pendingPatches = new Map${
      ts
        ? "<CairnEvidenceRequest, { promise: Promise<void>; resolve: () => void }>"
        : ""
    }();`,
    `  const responseTimeoutMs = Math.max(1, redaction.responseTimeoutMs ?? CAIRN_PATCH_RESPONSE_TIMEOUT_MS);`,
    `  const configuredNames = new Set(`,
    `    [...(redaction.headers ?? []), ...(redaction.storageKeys ?? [])]`,
    `      .map((name) => name.trim().toLowerCase())`,
    `      .filter(Boolean),`,
    `  );`,
    `  const configuredQueryParams = new Set(`,
    `    (redaction.queryParams ?? [])`,
    `      .map((name) => name.trim().toLowerCase())`,
    `      .filter(Boolean),`,
    `  );`,
    `  const explicitSecrets = (redaction.values ?? [])`,
    `    .map((value) => String(value ?? "").trim())`,
    `    .filter(Boolean);`,
    `  const ambientSecrets = Object.entries(process.env)`,
    `    .filter(([key, value]) => key !== "CAIRN_RUN_TOKEN" && value && CAIRN_SENSITIVE_NAME_RE.test(key))`,
    `    .map((entry) => String(entry[1] ?? "").trim())`,
    `    .filter(Boolean);`,
    `  const literalSecrets = [...new Set([...explicitSecrets, ...ambientSecrets])]`,
    `    .map((value) => String(value ?? "").trim())`,
    `    .filter(Boolean)`,
    `    .sort((a, b) => b.length - a.length);`,
    ``,
    `  const isSensitiveName = (name${ts ? ": string" : ""}) =>`,
    `    CAIRN_SENSITIVE_NAME_RE.test(name) || configuredNames.has(name.toLowerCase());`,
    `  const redactLiteralText = (input${ts ? ": string" : ""}) => {`,
    `    let output = input;`,
    `    for (const secret of literalSecrets) output = output.split(secret).join("[redacted]");`,
    `    return output;`,
    `  };`,
    `  const redactUrl = (input${ts ? ": string" : ""}) => {`,
    `    const scrubbed = redactLiteralText(input);`,
    `    const hasAbsoluteScheme = /^[a-z][a-z\\d+.-]*:/i.test(scrubbed);`,
    `    const isProtocolRelative = scrubbed.startsWith("//");`,
    `    try {`,
    `      const parsed = new URL(scrubbed, "http://cairn.invalid");`,
    `      const safeParams = new URLSearchParams();`,
    `      for (const [key, value] of parsed.searchParams.entries()) {`,
    `        const safeValue =`,
    `          CAIRN_SENSITIVE_NAME_RE.test(key) || configuredQueryParams.has(key.toLowerCase())`,
    `            ? "[redacted]"`,
    `            : redactLiteralText(value);`,
    `        safeParams.append(key, safeValue);`,
    `      }`,
    `      parsed.search = safeParams.toString();`,
    `      if (hasAbsoluteScheme) return parsed.toString();`,
    `      if (isProtocolRelative) return "//" + parsed.host + parsed.pathname + parsed.search + parsed.hash;`,
    `      return parsed.pathname + parsed.search + parsed.hash;`,
    `    } catch {`,
    `      return "[redacted]";`,
    `    }`,
    `  };`,
    `  const redactValue = (input${ts ? ": unknown" : ""})${
      ts ? ": unknown" : ""
    } => {`,
    `    if (typeof input === "string") return redactLiteralText(input);`,
    `    if (input === null || typeof input !== "object") return input;`,
    `    if (Array.isArray(input)) return input.map(redactValue);`,
    `    const record = input${ts ? " as Record<string, unknown>" : ""};`,
    `    const namedValueIsSensitive =`,
    `      typeof record.name === "string" &&`,
    `      (isSensitiveName(record.name) || configuredQueryParams.has(record.name.toLowerCase()));`,
    `    return Object.fromEntries(`,
    `      Object.entries(record).map(([key, value]) => [`,
    `        key,`,
    `        isSensitiveName(key) || (namedValueIsSensitive && key.toLowerCase() === "value")`,
    `          ? "[redacted]"`,
    `          : redactValue(value),`,
    `      ]),`,
    `    );`,
    `  };`,
    `  const captureJsonPostData = (raw${
      ts ? ": string | null" : ""
    }, contentType${ts ? ": string | undefined" : ""})${
      ts ? ": Partial<CairnNetworkEntry>" : ""
    } => {`,
    `    if (raw === null) return {};`,
    `    const bytes = new TextEncoder().encode(raw).byteLength;`,
    `    if (!contentType || !/(?:\\/|\\+)json(?:\\b|;)/i.test(contentType)) {`,
    `      return { postDataBytes: bytes, postDataOmittedReason: "non-json" };`,
    `    }`,
    `    if (bytes > CAIRN_MAX_JSON_POST_DATA_BYTES) {`,
    `      return { postDataBytes: bytes, postDataTruncated: true, postDataOmittedReason: "oversized" };`,
    `    }`,
    `    try {`,
    `      return { postData: JSON.stringify(redactValue(JSON.parse(raw))) };`,
    `    } catch {`,
    `      return { postDataBytes: bytes, postDataOmittedReason: "invalid-json" };`,
    `    }`,
    `  };`,
    `  const captureRequest = (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const timestamp = Date.now();`,
    `    let entry${ts ? ": CairnNetworkEntry" : ""};`,
    `    try {`,
    `      const headers = request.headers();`,
    `      entry = {`,
    `        url: redactUrl(request.url()),`,
    `        method: request.method().toUpperCase(),`,
    `        timestamp,`,
    `        ...captureJsonPostData(request.postData(), headers["content-type"]),`,
    `      };`,
    `    } catch {`,
    `      entry = {`,
    `        url: "[redacted]",`,
    `        method: "UNKNOWN",`,
    `        timestamp,`,
    `        postDataOmittedReason: "capture-error",`,
    `      };`,
    `    }`,
    `    entries.push(entry);`,
    `    byRequest.set(request, entry);`,
    `    if (entry.method === "PATCH") {`,
    `      let resolveCompletion${ts ? ": () => void" : ""} = () => {};`,
    `      const promise = new Promise${ts ? "<void>" : ""}((resolve) => {`,
    `        resolveCompletion = resolve;`,
    `      });`,
    `      pendingPatches.set(request, { promise, resolve: resolveCompletion });`,
    `    }`,
    `  };`,
    `  const finishRequest = (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const pending = pendingPatches.get(request);`,
    `    if (!pending) return;`,
    `    pendingPatches.delete(request);`,
    `    pending.resolve();`,
    `  };`,
    `  page.on("request", captureRequest);`,
    `  page.on("response", (response${
      ts ? ": CairnEvidenceResponse" : ""
    }) => {`,
    `    const entry = byRequest.get(response.request());`,
    `    if (entry) {`,
    `      entry.status = response.status();`,
    `    }`,
    `  });`,
    `  page.on("requestfinished", (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const entry = byRequest.get(request);`,
    `    if (entry) {`,
    `      if (entry.status === undefined) entry.error = "response status unavailable";`,
    `      entry.responseTimestamp = Date.now();`,
    `      entry.durationMs = Math.max(0, entry.responseTimestamp - entry.timestamp);`,
    `    }`,
    `    finishRequest(request);`,
    `  });`,
    `  page.on("requestfailed", (request${
      ts ? ": CairnEvidenceRequest" : ""
    }) => {`,
    `    const entry = byRequest.get(request);`,
    `    if (entry) {`,
    `      entry.error = "request failed";`,
    `      entry.responseTimestamp = Date.now();`,
    `      entry.durationMs = Math.max(0, entry.responseTimestamp - entry.timestamp);`,
    `    }`,
    `    finishRequest(request);`,
    `  });`,
    ``,
    `  return {`,
    `    recordApiRequest(input${ts ? ": CairnApiRequestEvidence" : ""}) {`,
    `      const responseTimestamp = Date.now();`,
    `      const timestamp = input.timestamp ?? responseTimestamp;`,
    `      const timing = {`,
    `        timestamp,`,
    `        responseTimestamp,`,
    `        durationMs: Math.max(0, responseTimestamp - timestamp),`,
    `      };`,
    `      let raw${ts ? ": string | null" : ""} = null;`,
    `      let contentType = input.contentType;`,
    `      if (input.body !== undefined) {`,
    `        try {`,
    `          raw = typeof input.body === "string" ? input.body : JSON.stringify(input.body);`,
    `          if (typeof input.body !== "string" && !contentType) contentType = "application/json";`,
    `        } catch {`,
    `          entries.push({`,
    `            url: redactUrl(input.url),`,
    `            method: input.method.toUpperCase(),`,
    `            ...timing,`,
    `            ...(input.status === undefined ? {} : { status: input.status }),`,
    `            postDataOmittedReason: "capture-error",`,
    `          });`,
    `          return;`,
    `        }`,
    `      }`,
    `      entries.push({`,
    `        url: redactUrl(input.url),`,
    `        method: input.method.toUpperCase(),`,
    `        ...timing,`,
    `        ...(input.status === undefined ? {} : { status: input.status }),`,
    `        ...captureJsonPostData(raw, contentType),`,
    `      });`,
    `    },`,
    `    async persist(runDir${ts ? ": string" : ""})${
      ts ? ": Promise<void>" : ""
    } {`,
    `      const pending = [...pendingPatches.values()].map((completion) => completion.promise);`,
    `      if (pending.length > 0) {`,
    `        let timeoutId${
      ts ? ": ReturnType<typeof setTimeout> | undefined" : ""
    };`,
    `        const completed = await Promise.race([`,
    `          Promise.all(pending).then(() => true),`,
    `          new Promise${ts ? "<boolean>" : ""}((resolve) => {`,
    `            timeoutId = setTimeout(() => resolve(false), responseTimeoutMs);`,
    `          }),`,
    `        ]);`,
    `        if (timeoutId !== undefined) clearTimeout(timeoutId);`,
    `        if (!completed) {`,
    `          throw new Error("Timed out waiting for captured PATCH response evidence.");`,
    `        }`,
    `      }`,
    `      const [{ mkdir, writeFile }, { join }] = await Promise.all([`,
    `        import("node:fs/promises"),`,
    `        import("node:path"),`,
    `      ]);`,
    `      const networkDir = join(runDir, "network");`,
    `      await mkdir(networkDir, { recursive: true });`,
    `      const body = entries.map((entry) => JSON.stringify(entry)).join("\\n");`,
    `      await writeFile(join(networkDir, "requests.ndjson"), body ? body + "\\n" : "", {`,
    `        encoding: "utf8",`,
    `        mode: 0o600,`,
    `      });`,
    `    },`,
    `  };`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}

/* ----- emit context ----- */

export interface EmitCtx {
  lang: ExportLang;
  coverage: ExportCoverage;
  /** Late-bound reference collector (env names, run token, splice bindings). */
  usage: RefUsage;
  /** Absolute dir of the source spec — used to resolve script.file verifiers. */
  specDir?: string;
  /** Parse origins of the rendered steps (F13 action-relative step files). */
  stepOrigins?: ParsedStepOrigins;
  /**
   * Source expression for the `specDir` passed to node verifiers. Project
   * mode emits a project-root-relative expression instead of a baked path.
   */
  specDirExpr?: string;
  /** Absolute dir of the generated file — verifier imports emit relative to it. */
  outDir?: string;
  /**
   * Project mode: emit verifier imports as `<prefix>/<basename>` and record
   * the resolved source path in `verifierFiles` so the CLI can copy it.
   */
  verifierImportPrefix?: string;
  verifierFiles?: Set<string>;
  /** Generated run directory passed to every exported node file verifier. */
  nodeVerifierRunDir?: string;
  /** Generated sanitized network recorder persisted before node verification. */
  nodeVerifierEvidence?: string;
  /** Unique names for per-action network response promises. */
  postconditionCounter?: number;
  /** Wrap each step/outcome in `test.step(...)` (project mode). */
  wrapSteps?: boolean;
  /** Absolute eval.file paths to copy into `evals/` (project mode). */
  evalFiles?: Set<string>;
  /**
   * Project mode: upload fixtures copied into the export, keyed by absolute
   * source path → path relative to the export root (`fixtures/<name>`).
   */
  fixtureFiles?: Map<string, string>;
  /**
   * Real path that bounds fixture copies: only regular, non-symlink files
   * inside it (and at most MAX_FIXTURE_BYTES) are copied into the export.
   */
  fixtureRoot?: string;
  /**
   * `--project` mode: import shared helpers from this prefix (`../lib`)
   * instead of inlining fill-retry / click.until / verifier interop.
   */
  libImportPrefix?: string;
  usedLib?: Set<PlaywrightLibModule>;
  /** Exact helper names imported from lib/ (only used imports are emitted). */
  usedLibNames?: Set<string>;
  /** True when emitted code calls `test.info()` (action modules import `test`). */
  usesTestInfo?: boolean;
  /**
   * Runtime refs (`requests:x`, `evals:y`, `artifacts:z`) referenced anywhere
   * in the unit; a producing step binds its value only when it is referenced.
   */
  referencedRefs?: Set<string>;
  /** Bind every produced value (action modules return them to callers). */
  bindAllProduced?: boolean;
  /** Bindings produced in this scope: key → hoisted identifier. */
  produced?: Map<string, string>;
  /** Listener-backed network evidence array name (request steps push into it). */
  networkRecorder?: string;
  /** 0-based index of the step being rendered (default `request_<n>` names). */
  stepIndex?: number;
  /**
   * F14: resolved path of a nested step being rendered (`3/steps/0`), so
   * its relative files resolve against the file that declares it.
   */
  stepPath?: string;
  /** F14: counter for loop / attempt variable names. */
  controlCounter?: number;
  /**
   * F14: wait `assign` names something in this unit reads
   * (`${waits.<name>.…}` or `var: waits.<name>.…`); only those get a binding.
   */
  referencedWaits?: Set<string>;
  /** F14: hoisted wait-result bindings (name → identifier). */
  waitBindings?: Map<string, string>;
  /**
   * F14 project mode: render a `use:` (nested in a repeat / if block) as a
   * call to its action module.
   */
  renderUseCall?: (step: UseStep, ctx: EmitCtx) => Rendered | undefined;
  /** F15: widget helpers the unit calls (single-file export inlines them). */
  usedWidgets?: Set<WidgetHelperName>;
  /** F18: request helpers the unit calls (single-file export inlines them). */
  usedRequestHelpers?: Set<RequestHelperName>;
  /** F18: the environment login `use: login` exports (see ExportEnvAuth). */
  envAuth?: ExportEnvAuth;
  /** F18 single-file: the `CAIRN_AUTH` literal the file declares. */
  authConst?: string;
  /** F20: prelude helpers the unit uses (single-file export inlines them). */
  usedPrelude?: Set<PreludeHelperName>;
  /**
   * E10: `--preconditions inline|global` — `run:` steps and `teardown:` export
   * through the command helper (otherwise they stay skips).
   */
  hostCommands?: boolean;
  /**
   * Project root bounding host paths (`cairnProjectPath` in a project export);
   * a standalone export resolves them relative to the running spec file.
   */
  projectRoot?: string;
  /** Command-helper pieces this unit calls (imports / single-file inlining). */
  usedCommand?: {
    command: boolean;
    json?: boolean;
    context?: boolean;
    precondition?: boolean;
  };
  /** `node:path` names the unit's code calls (single-file adds the import). */
  usedNodePath?: Set<string>;
  /** Set while a teardown item renders: CAIRN_RUN_STATUS / deadline vars. */
  runStepOptions?: { statusVar?: string; deadlineVar?: string };
  /** The unit calls the page probe (single-file inlines what it calls). */
  usedProbe?: { capture?: boolean; table?: boolean };
  /** The unit calls `cairnPoll` (a poll with a stability window). */
  usedPoll?: boolean;
  /** Config `browser.testIdAttribute` for the capture probe. */
  testIdAttribute?: string;
  /** No `.first()` on a locator without `nth` (Playwright strictness). */
  strictLocators?: boolean;
  /**
   * E8: the attribute `getByTestId` reads in the HOST (its Playwright
   * `use.testIdAttribute`). When it differs from the spec's attribute
   * (`testIdAttribute`, default data-testid) a `testid` locator is emitted
   * as an explicit attribute selector so it keeps matching what the spec means.
   * null: a host whose attribute is not statically readable (always explicit).
   */
  hostTestIdAttribute?: string | null;
  /** E10 `--verifiers` for node / datasource verifiers. */
  verifiersMode?: ExportVerifiersMode;
  gateEnv?: readonly string[];
  datasourceEnv?: Readonly<Record<string, readonly string[]>>;
  /** A `--verifiers gate` outcome rendered: the test declares `cairnSkipped`. */
  gated?: boolean;
  /** Config fixtures the test reads outputs of (a global export wires them). */
  fixtureOutputs?: Map<string, string[]>;
  /** A `network` outcome needs the rich request log (body / count / assign). */
  richNetwork?: boolean;
  /** Test-time data glue the unit calls (single-file exports inline it). */
  usedData?: Set<DataPiece>;
  /** The export environment's http datasources (`http` verifier `source:`). */
  httpDatasources?: Readonly<Record<string, ExportHttpDatasource>>;
  /** `--preconditions global`: fixtures / gates are ensured by the global setup. */
  globalSetup?: boolean;
}

export function newEmitCtx(
  lang: ExportLang,
  init: Partial<Omit<EmitCtx, "lang" | "coverage" | "usage">> = {},
): EmitCtx {
  return {
    lang,
    coverage: newCoverage(),
    usage: newRefUsage(),
    postconditionCounter: 0,
    usedLib: new Set(),
    usedLibNames: new Set(),
    produced: new Map(),
    ...init,
  };
}

function markLib(
  ctx: EmitCtx,
  name: PlaywrightLibModule,
  ...helpers: string[]
): void {
  (ctx.usedLib ?? (ctx.usedLib = new Set())).add(name);
  const names = ctx.usedLibNames ?? (ctx.usedLibNames = new Set());
  for (const helper of helpers) names.add(helper);
}

/**
 * The unit calls glue of a data piece (`playwrightRuntimeData`): a project
 * export imports it from `lib/`, a single-file export inlines it.
 */
export function useData(
  ctx: EmitCtx,
  piece: DataPiece,
  ...helpers: string[]
): void {
  (ctx.usedData ??= new Set()).add(piece);
  // `dataMatch` has no lib file of its own: `lib/request` imports lib/runtime/matchers.
  if (ctx.libImportPrefix && piece !== "dataMatch") {
    markLib(ctx, piece, ...helpers);
  }
}

export interface Rendered {
  stmts: Stmt[];
  /** True when at least one executable Playwright statement was produced. */
  exported: boolean;
}

export function coverageHasHardSkip(coverage: ExportCoverage): boolean {
  return coverage.skips.some((entry) => !entry.soft);
}

export function skip(
  ctx: EmitCtx,
  kind: ExportCoverageSkip["kind"],
  reason: string,
  id?: string,
  soft = false,
): void {
  ctx.coverage.skips.push({
    kind,
    id,
    reason,
    ...(soft ? { soft: true } : {}),
  });
}

export function skipStmt(
  ctx: EmitCtx,
  kind: ExportCoverageSkip["kind"],
  reason: string,
  note: string,
  id?: string,
  soft = false,
): Rendered {
  skip(ctx, kind, reason, id, soft);
  return { stmts: [comment(note)], exported: false };
}

/** Bind a produced value only when something references it (or always in actions). */
export function wantsBinding(ctx: EmitCtx, key: string): boolean {
  return Boolean(ctx.bindAllProduced || ctx.referencedRefs?.has(key));
}

/** Reserve (or reuse) the hoisted identifier for a produced runtime binding. */
export function declareBinding(
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

/** Make a produced binding visible to later splices in this scope. */
export function publishBinding(ctx: EmitCtx, key: string, ident: string): void {
  ctx.usage.bindings.set(key, ident);
}

/** Inline parse of a body string the way the runner stores captured bodies. */
function parseJsonOrText(expr: string, ctx: EmitCtx): string {
  const asUnknown = ctx.lang === "ts" ? " as unknown" : "";
  return `((text) => { if (text === null || text === undefined) { return null; } try { return JSON.parse(text)${asUnknown}; } catch { return text; } })(${expr})`;
}

/** Same default artifact name the runner derives from a download's saveAs. */
export function artifactNameFromPath(path: string): string {
  const rawName = basename(path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(rawName) ? rawName : `artifact_${rawName || "download"}`;
}

/* ----- step rendering ----- */

export function renderStep(
  step: Step,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const unresolvedBefore = ctx.usage.unresolvedLog.length;
  const whenWrap = "when" in step && step.when ? step.when : undefined;
  // The predicate runs BEFORE the step, so it is rendered first: it must not
  // see a binding the step itself produces.
  const when = whenWrap ? renderWhenCondition(whenWrap, ctx) : undefined;
  const postcondition = step.postcondition?.network;
  const action = postcondition ? withoutPostcondition(step) : step;
  const body = renderStepBody(
    action,
    specSettleMs,
    ctx,
    postcondition !== undefined,
  );
  const guardedBody = postcondition
    ? renderNetworkPostconditionAction(body, postcondition, ctx)
    : body;
  const stmts = step.id
    ? [comment(`step: ${oneLine(step.id)}`), ...guardedBody.stmts]
    : guardedBody.stmts;

  const rendered = !when
    ? { stmts, exported: guardedBody.exported }
    : wrapWhen(when, stmts, guardedBody.exported, ctx, step.id);
  recordUnresolvedSplices(ctx, unresolvedBefore, "step", step.id);
  return wrapTestStep(step, rendered, ctx);
}

/**
 * A `${requests|evals|artifacts.…}` splice emitted without a binding throws at
 * run time; record it as a HARD skip (the test becomes test.fixme) and as a
 * semantic risk so coverage can never claim 100% for it.
 */
function recordUnresolvedSplices(
  ctx: EmitCtx,
  before: number,
  kind: ExportCoverageSkip["kind"],
  id: string | undefined,
): void {
  const refs = [...new Set(ctx.usage.unresolvedLog.slice(before))];
  for (const ref of refs) {
    skip(
      ctx,
      kind,
      `unresolved splice \${${ref}} — its producing step is not exported in this scope`,
      id,
    );
    addRisk(
      ctx,
      "unresolvedSplice",
      `\${${ref}} has no binding in the exported code (cairnUnresolvedSplice throws if the test runs)`,
      id,
    );
  }
}

function wrapTestStep(step: Step, rendered: Rendered, ctx: EmitCtx): Rendered {
  if (!ctx.wrapSteps || !step.id) return rendered;
  const inner = rendered.stmts.filter(
    (stmt) => !(stmt.kind === "comment" && stmt.text.startsWith("step:")),
  );
  return {
    stmts: [
      block(
        `await test.step(${JSON.stringify(oneLine(step.id))}, async () => {`,
        inner.length > 0 ? inner : [comment("no-op")],
        `});`,
      ),
    ],
    exported: rendered.exported,
  };
}

interface WhenCondition {
  serialized: string;
  /** Undefined when the predicate has no Playwright translation. */
  condition?: string;
}

/**
 * Text predicates pass their (normalized) needle as a page.evaluate ARGUMENT:
 * the browser function cannot see Node-side variables, and normalizing at
 * export time would lowercase late-bound sentinels into the source.
 */
function textPredicate(needle: string, negated: boolean, ctx: EmitCtx): string {
  const needleExpr = emitNormalizedText(needle, false, ctx.usage);
  const call = `await page.evaluate((needle) => String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().toLowerCase().includes(needle), ${needleExpr})`;
  return negated ? `!(${call})` : call;
}

function renderWhenCondition(
  when: string | WhenObject,
  ctx: EmitCtx,
): WhenCondition {
  const serialized = formatWhen(when);
  const str = (s: string) => emitStr(s, ctx.usage);
  let condition: string | undefined;
  if (typeof when !== "string") {
    if (when.var !== undefined) {
      condition = varPredicateExpr(when, ctx);
    } else if (when.url !== undefined) {
      condition = urlMatcherExpr(when.url, ctx);
    } else if (when.urlContains !== undefined) {
      condition = `page.url().includes(${str(when.urlContains)})`;
    } else if (when.urlNotContains !== undefined) {
      condition = `!page.url().includes(${str(when.urlNotContains)})`;
    } else if (when.urlMatches !== undefined) {
      condition = `new RegExp(${str(when.urlMatches)}).test(page.url())`;
    } else if (when.text !== undefined) {
      condition = textPredicate(when.text, false, ctx);
    } else if (when.notText !== undefined) {
      condition = textPredicate(when.notText, true, ctx);
    } else if (when.selector !== undefined) {
      condition = when.hasText
        ? `await page.locator(${str(when.selector)}).filter({ hasText: ${str(when.hasText)} }).count() > 0`
        : `await page.locator(${str(when.selector)}).count() > 0`;
    } else if (when.notSelector !== undefined) {
      condition = `(await page.locator(${str(when.notSelector)}).count()) === 0`;
    }
    return { serialized, ...(condition ? { condition } : {}) };
  }
  const colon = serialized.indexOf(":");
  if (colon < 0) return { serialized };
  const kind = serialized.slice(0, colon);
  const arg = serialized.slice(colon + 1);
  switch (kind) {
    case "urlContains":
      condition = `page.url().includes(${str(arg)})`;
      break;
    case "urlNotContains":
      condition = `!page.url().includes(${str(arg)})`;
      break;
    case "urlMatches":
      condition = `new RegExp(${str(arg)}).test(page.url())`;
      break;
    case "text":
      condition = textPredicate(arg, false, ctx);
      break;
    case "notText":
      condition = textPredicate(arg, true, ctx);
      break;
    case "selector":
      condition = `await page.locator(${str(arg)}).count() > 0`;
      break;
    case "notSelector":
      condition = `(await page.locator(${str(arg)}).count()) === 0`;
      break;
  }
  return { serialized, ...(condition ? { condition } : {}) };
}

function wrapWhen(
  when: WhenCondition,
  body: Stmt[],
  exported: boolean,
  ctx: EmitCtx,
  stepId?: string,
): Rendered {
  const { serialized, condition } = when;
  if (!condition) {
    skip(ctx, "when", `unrecognized when predicate: ${serialized}`, stepId);
    return {
      stmts: [
        comment(
          `when: ${oneLine(serialized)} — not translated; step always runs`,
        ),
        ...body,
      ],
      exported,
    };
  }
  return {
    stmts: [comment(`when: ${oneLine(serialized)}`), iff(condition, body)],
    exported,
  };
}

/* ----- F14 control flow ----- */

/** The Playwright promise one wait condition becomes (callers await it). */
function waitPromiseExpr(
  w: RunnerWaitCondition,
  timeout: number,
  ctx: EmitCtx,
): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  if ("app" in w) {
    // F20: the same in-page check `cairn run` polls (prelude + app handles).
    const { path, ...check } = w.app;
    return `expect.poll(() => ${preludeHelper(ctx, "cairnAppCheck")}(page, ${JSON.stringify(path)}, ${JSON.stringify(check)}), { timeout: ${timeout} }).toBe(true)`;
  }
  if ("ms" in w) {
    return `new Promise((resolve) => setTimeout(resolve, ${w.ms}))`;
  }
  if ("text" in w || "notText" in w) {
    const expected = "text" in w;
    // Normalize only literal needles at export time; late-bound needles
    // (action vars, run token, splices) are normalized at run time so a
    // sentinel can never be lowercased into the generated source.
    const needle = emitNormalizedText(
      expected ? w.text : w.notText,
      w.caseSensitive ?? false,
      ctx.usage,
    );
    const text =
      '(await page.locator("body").innerText()).replace(/\\s+/g, " ").trim()' +
      (w.caseSensitive ? "" : ".toLowerCase()");
    return `expect.poll(async () => ${text}.includes(${needle}), { timeout: ${timeout} }).toBe(${expected})`;
  }
  if ("selector" in w) {
    if (w.hasText) {
      return `expect(page.locator(${str(w.selector)}).filter({ hasText: ${str(w.hasText)} })).not.toHaveCount(0, { timeout: ${timeout} })`;
    }
    const state = w.state ?? "visible";
    return `page.waitForSelector(${str(w.selector)}, { timeout: ${timeout}, state: ${JSON.stringify(state)} })`;
  }
  if ("value" in w) {
    const { equals, ...loc } = w.value;
    return `expect(${locator(loc as Locator, ctx)}).toHaveValue(${str(equals)}, { timeout: ${timeout} })`;
  }
  if ("url" in w) {
    const matcher = w.url;
    if (matcher.equals !== undefined) {
      return `page.waitForURL((url) => url.href === ${str(matcher.equals)}, { timeout: ${timeout} })`;
    }
    if (matcher.includes !== undefined) {
      return `page.waitForURL((url) => url.href.includes(${str(matcher.includes)}), { timeout: ${timeout} })`;
    }
    return `page.waitForURL(new RegExp(${str(matcher.pattern ?? "")}), { timeout: ${timeout} })`;
  }
  return `page.waitForLoadState(${JSON.stringify(w.load)}, { timeout: ${timeout} })`;
}

/**
 * One `wait.all` condition as a boolean read that never waits (it may
 * `await` a single page read): the group polls them all on every tick.
 */
function waitCheckExpr(
  w: RunnerWaitCondition,
  ctx: EmitCtx,
  startIdent: string,
): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  if ("app" in w) {
    const { path, ...check } = w.app;
    return `await ${preludeHelper(ctx, "cairnAppCheck")}(page, ${JSON.stringify(path)}, ${JSON.stringify(check)})`;
  }
  if ("ms" in w) return `Date.now() - ${startIdent} >= ${w.ms}`;
  if ("text" in w || "notText" in w) {
    const expected = "text" in w;
    const needle = emitNormalizedText(
      expected ? w.text : w.notText,
      w.caseSensitive ?? false,
      ctx.usage,
    );
    const text =
      '(await page.locator("body").innerText()).replace(/\\s+/g, " ").trim()' +
      (w.caseSensitive ? "" : ".toLowerCase()");
    return `${text}.includes(${needle}) === ${expected}`;
  }
  if ("selector" in w) {
    // The runner's selector-state predicate (any match visible; hidden when
    // none is; detached counts as hidden), read once per tick.
    const needle = w.hasText !== undefined ? str(w.hasText) : '""';
    return `await page.evaluate((a) => { const needle = String(a.needle).replace(/\\s+/g, " ").trim().toLowerCase(); const els = Array.from(document.querySelectorAll(a.selector)).filter((el) => !needle || String(el.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase().includes(needle)); const shown = els.some((el) => { const style = window.getComputedStyle(el); if (style.display === "none" || style.visibility === "hidden") return false; const rect = el.getBoundingClientRect(); return rect.width > 0 || rect.height > 0; }); return a.state === "attached" ? els.length > 0 : a.state === "detached" ? els.length === 0 : a.state === "hidden" ? !shown : shown; }, { selector: ${str(w.selector)}, state: ${JSON.stringify(w.state ?? "visible")}, needle: ${needle} })`;
  }
  if ("value" in w) {
    const { equals, ...loc } = w.value;
    return `(await ${locator(loc as Locator, ctx)}.inputValue({ timeout: 1000 }).catch(() => null)) === ${str(equals)}`;
  }
  if ("url" in w) return urlMatcherExpr(w.url, ctx);
  return w.load === "domcontentloaded"
    ? `await page.evaluate(() => document.readyState !== "loading")`
    : `await page.evaluate(() => document.readyState === "complete")`;
}

/** The `assign` of a wait step, when it has one. */
function waitAssign(step: WaitStep): string | undefined {
  return "assign" in step.wait ? step.wait.assign : undefined;
}

/**
 * Hoisted binding for a wait's `assign`, when this unit reads it
 * (`${waits.<name>…}` / `var: waits.<name>…`); undefined otherwise, so an
 * unread result never becomes an unused local.
 */
function declareWaitBinding(ctx: EmitCtx, name: string): string | undefined {
  if (!ctx.referencedWaits?.has(name)) return undefined;
  const bindings = ctx.waitBindings ?? (ctx.waitBindings = new Map());
  const existing = bindings.get(name);
  const ident = existing ?? bindingIdent("cairnWait", name);
  bindings.set(name, ident);
  ctx.usage.controlBindings.set(`waits.${name}.matched`, `${ident}.matched`);
  ctx.usage.controlBindings.set(`waits.${name}.index`, `${ident}.index`);
  return ident;
}

/**
 * wait.any → `Promise.any`, wait.all → one `expect.poll` over every
 * condition, `optional` → the miss is caught, `assign` → `{ matched, index }`
 * in a hoisted binding. Losing branches of an `any` keep polling until their
 * own timeout and are ignored.
 */
function renderControlWait(step: WaitStep, ctx: EmitCtx): Rendered {
  const w = step.wait;
  const optional = "optional" in w && w.optional === true;
  const ident = (() => {
    const name = waitAssign(step);
    return name ? declareWaitBinding(ctx, name) : undefined;
  })();
  const miss = optional ? ", () => ({ matched: false })" : "";
  if (isWaitGroup(w)) {
    const timeout = w.timeoutMs ?? 30_000;
    const conditions = "any" in w ? w.any : w.all;
    const promises = conditions.map((c) => waitPromiseExpr(c, timeout, ctx));
    if ("any" in w) {
      const race = `Promise.any([${promises
        .map((promise, index) => `${promise}.then(() => ${index})`)
        .join(", ")}])`;
      return one(
        raw(
          ident
            ? `${ident} = await ${race}.then((index) => ({ matched: true, index })${miss});`
            : optional
              ? `await ${race}.catch(() => undefined);`
              : `await ${race};`,
        ),
      );
    }
    // `cairn run` holds a wait.all only when every condition holds at the
    // same poll: one expect.poll reads them all each tick (Promise.all of
    // independent polls would pass on conditions that held at different
    // moments).
    const checks = conditions.map(
      (c) => `(${waitCheckExpr(c, ctx, "cairnWaitStart")})`,
    );
    const poll = `expect.poll(async () => [${checks.join(", ")}].every(Boolean), { timeout: ${timeout} }).toBe(true)`;
    const every = conditions.some((c) => "ms" in c)
      ? `((cairnWaitStart) => ${poll})(Date.now())`
      : poll;
    return one(
      raw(
        ident
          ? `${ident} = await ${every}.then(() => ({ matched: true })${miss});`
          : optional
            ? `await ${every}.catch(() => undefined);`
            : `await ${every};`,
      ),
    );
  }
  const plain = plainWaitCondition(w);
  const timeout = "timeoutMs" in plain ? (plain.timeoutMs ?? 30_000) : 30_000;
  const promise = waitPromiseExpr(plain, timeout, ctx);
  if (ident) {
    return one(
      raw(
        `${ident} = await ${promise}.then(() => ({ matched: true })${miss});`,
      ),
    );
  }
  return one(
    raw(
      optional
        ? `await ${promise}.catch(() => undefined);`
        : `await ${promise};`,
    ),
  );
}

/** `page.url()` against a wait.url matcher. */
function urlMatcherExpr(
  matcher: NonNullable<WhenObject["url"]>,
  ctx: EmitCtx,
): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  if (matcher.equals !== undefined) {
    return `page.url() === ${str(matcher.equals)}`;
  }
  if (matcher.includes !== undefined) {
    return `page.url().includes(${str(matcher.includes)})`;
  }
  return `new RegExp(${str(matcher.pattern ?? "")}).test(page.url())`;
}

/** Runtime namespaces a `var` predicate may name and the export can read. */
const EXPORTABLE_VAR_REFS = /^(requests|evals|artifacts)\./;
/** Refs that translate only when an exported step / setup binds them. */
const BOUND_VAR_REFS = /^(runs|captures|fixtures)\.([a-z][A-Za-z0-9_]*)/;

/**
 * A `var` predicate as a boolean expression, or undefined when its value
 * has no Playwright equivalent (captures, runs, fixtures, …).
 */
function varPredicateExpr(when: WhenObject, ctx: EmitCtx): string | undefined {
  const name = when.var!;
  // undefined: no translation; null: the var is unset where the step lives.
  let subject: string | null | undefined;
  if (!name.includes(".")) {
    subject =
      when.resolved !== undefined
        ? `String(${emitStr(when.resolved, ctx.usage)})`
        : null;
  } else if (/^(repeat|waits)\./.test(name)) {
    const bound = ctx.usage.controlBindings.get(name);
    subject = bound !== undefined ? `String(${bound})` : undefined;
  } else if (EXPORTABLE_VAR_REFS.test(name)) {
    subject = `String(${emitStr(`\${${name}}`, ctx.usage)})`;
  } else {
    const bound = BOUND_VAR_REFS.exec(name);
    if (
      bound &&
      ctx.usage.bindings.has(
        runtimeRefKey(bound[1] as RuntimeRefSource, bound[2]!),
      )
    ) {
      subject = `String(${emitStr(`\${${name}}`, ctx.usage)})`;
    }
  }
  if (subject === undefined) return undefined;
  if (when.exists !== undefined) {
    if (subject === null) return when.exists ? "false" : "true";
    return when.exists ? `${subject} !== ""` : `${subject} === ""`;
  }
  if (subject === null) return "false";
  if (when.equals !== undefined) {
    return `${subject} === ${JSON.stringify(String(when.equals))}`;
  }
  if (when.in !== undefined) {
    return `[${when.in
      .map((value) => JSON.stringify(String(value)))
      .join(", ")}].includes(${subject})`;
  }
  return undefined;
}

/** Render one nested step list (repeat body, if branch, retried action). */
function renderNestedList(
  steps: readonly Step[],
  key: "steps" | "then" | "else" | "use",
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const parentPath = ctx.stepPath ?? String(ctx.stepIndex ?? 0);
  const stmts: Stmt[] = [];
  let exported = false;
  steps.forEach((step, j) => {
    const saved = ctx.stepPath;
    ctx.stepPath = `${parentPath}/${key}/${j}`;
    const rendered = renderStep(step, specSettleMs, ctx);
    ctx.stepPath = saved;
    exported ||= rendered.exported;
    stmts.push(...rendered.stmts);
  });
  return { stmts: stmts.length > 0 ? stmts : [comment("no-op")], exported };
}

/**
 * `repeat` → a bounded `for` loop. `until` is checked before every
 * iteration and once more after the last (the runner's semantics); with
 * `onMax: fail` a final `expect` fails the test when it never held.
 */
function renderRepeatStep(
  step: RepeatStep,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const { max, until, onMax = "fail", indexVar } = step.repeat;
  const n = (ctx.controlCounter = (ctx.controlCounter ?? 0) + 1);
  const loopVar = `cairnRepeat${n}`;
  // Loop variables are visible to the body only; wait bindings the body
  // declares stay visible to `until` (hoisted, like the runner's values).
  const loopRefs: Array<[string, string]> = [
    ["repeat.index", loopVar],
    ["repeat.iteration", `(${loopVar} + 1)`],
    ...(indexVar ? [[`repeat.${indexVar}`, loopVar] as [string, string]] : []),
  ];
  const outer = loopRefs.map(
    ([ref]) => [ref, ctx.usage.controlBindings.get(ref)] as const,
  );
  for (const [ref, expr] of loopRefs) ctx.usage.controlBindings.set(ref, expr);
  const body = renderNestedList(step.repeat.steps, "steps", specSettleMs, ctx);
  for (const [ref, expr] of outer) {
    if (expr === undefined) ctx.usage.controlBindings.delete(ref);
    else ctx.usage.controlBindings.set(ref, expr);
  }
  const cond =
    until !== undefined ? renderWhenCondition(until, ctx) : undefined;
  const header = `repeat: max ${max}${
    cond ? `, until ${oneLine(cond.serialized)}` : ""
  }${cond && onMax === "continue" ? " (onMax: continue)" : ""}`;
  if (cond && !cond.condition) {
    return skipStmt(
      ctx,
      "step",
      `repeat until ${oneLine(cond.serialized)} has no Playwright translation`,
      `repeat skipped — until ${oneLine(cond.serialized)} is not exportable`,
      step.id,
    );
  }
  const loop = (inner: Stmt[]): Stmt =>
    block(
      `for (let ${loopVar} = 0; ${loopVar} < ${max}; ${loopVar}++) {`,
      inner,
    );
  if (!cond) {
    return {
      stmts: [comment(header), loop(body.stmts)],
      exported: body.exported,
    };
  }
  const holds = cond.condition!;
  if (onMax === "continue") {
    return {
      stmts: [
        comment(header),
        loop([iff(holds, [raw("break;")]), ...body.stmts]),
      ],
      exported: body.exported,
    };
  }
  const done = `${loopVar}Done`;
  const message = `repeat${
    step.id ? ` ${oneLine(step.id)}` : ""
  }: until ${oneLine(cond.serialized)} did not hold after ${max} iteration(s)`;
  return {
    stmts: [
      comment(header),
      braces([
        raw(`let ${done} = false;`),
        loop([
          iff(holds, [raw(`${done} = true;`), raw("break;")]),
          ...body.stmts,
        ]),
        iff(`!${done}`, [raw(`${done} = ${holds};`)]),
        raw(`expect(${done}, ${JSON.stringify(message)}).toBe(true);`),
      ]),
    ],
    exported: true,
  };
}

/** `if` → `if (…) { then } else { else }`. */
function renderIfStep(
  step: IfStep,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const cond = renderWhenCondition(step.if.condition, ctx);
  if (!cond.condition) {
    return skipStmt(
      ctx,
      "step",
      `if ${oneLine(cond.serialized)} has no Playwright translation`,
      `if skipped — ${oneLine(cond.serialized)} is not exportable (neither branch is exported)`,
      step.id,
    );
  }
  const then = renderNestedList(step.if.then, "then", specSettleMs, ctx);
  const otherwise = step.if.else
    ? renderNestedList(step.if.else, "else", specSettleMs, ctx)
    : undefined;
  return {
    stmts: [
      comment(`if: ${oneLine(cond.serialized)}`),
      otherwise
        ? ifElse(cond.condition, then.stmts, otherwise.stmts)
        : iff(cond.condition, then.stmts),
    ],
    exported: then.exported || (otherwise?.exported ?? false),
  };
}

/** A resolved `use:` + `retry`: its expanded steps in a retry loop. */
function renderRetryUseStep(
  step: RetryUseStep,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const body = renderNestedList(step.steps, "use", specSettleMs, ctx);
  return renderRetryLoop(body, step.use.retry, step.use.action, ctx, step.id);
}

/**
 * Retry `body` (the action's steps, or its module call in --project): a
 * failing attempt — or an `until` that does not hold after it — runs it
 * again, at most `times` more times; the last error is rethrown.
 */
export function renderRetryLoop(
  body: Rendered,
  retry: UseRetry,
  action: string,
  ctx: EmitCtx,
  stepId?: string,
): Rendered {
  const cond =
    retry.until !== undefined
      ? renderWhenCondition(retry.until, ctx)
      : undefined;
  if (cond && !cond.condition) {
    return skipStmt(
      ctx,
      "step",
      `use ${action} retry until ${oneLine(cond.serialized)} has no Playwright translation`,
      `use ${action} (retry) skipped — until ${oneLine(cond.serialized)} is not exportable`,
      stepId,
    );
  }
  const n = (ctx.controlCounter = (ctx.controlCounter ?? 0) + 1);
  const attempt = `cairnAttempt${n}`;
  const attempts = retry.times + 1;
  const tryBody: Stmt[] = [
    ...body.stmts,
    ...(cond
      ? [
          raw(
            `expect(${cond.condition}, ${JSON.stringify(
              `use ${action}: until ${oneLine(cond.serialized)} did not hold`,
            )}).toBe(true);`,
          ),
        ]
      : []),
    raw("break;"),
  ];
  const handler: Stmt[] = [
    iff(`${attempt} >= ${attempts}`, [raw("throw error;")]),
    ...(retry.delayMs
      ? [
          raw(
            `await new Promise((resolve) => setTimeout(resolve, ${retry.delayMs}));`,
          ),
        ]
      : []),
  ];
  return {
    stmts: [
      comment(
        `use ${action}: retry up to ${retry.times} more time(s)${
          cond ? `, until ${oneLine(cond.serialized)}` : ""
        }`,
      ),
      block(`for (let ${attempt} = 1; ; ${attempt}++) {`, [
        tryCatch(tryBody, "error", handler),
      ]),
    ],
    exported: body.exported,
  };
}

/** A step without its nested lists (its own fields only). */
function ownStepFields(step: Step): Step {
  if ("repeat" in step) {
    return { ...step, repeat: { ...step.repeat, steps: [] } };
  }
  if ("if" in step) {
    // oxlint-disable-next-line unicorn/no-thenable -- `if.then` is a step list
    return { ...step, if: { ...step.if, then: [], else: [] } };
  }
  if (isRetryUseStep(step)) {
    const own: RetryUseStep = { ...step, steps: [] };
    return own;
  }
  return step;
}

function renderNetworkPostconditionAction(
  body: Rendered,
  postcondition: NetworkPostcondition,
  ctx: EmitCtx,
): Rendered {
  if (!body.exported) return body;
  const counter = (ctx.postconditionCounter ?? 0) + 1;
  ctx.postconditionCounter = counter;
  const promise = `networkPostconditionResponse${counter}`;
  const predicate = renderNetworkPostconditionPredicate(postcondition, ctx);
  const timeout = postcondition.timeoutMs ?? 30_000;
  const key = postcondition.assign
    ? runtimeRefKey("requests", postcondition.assign)
    : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(
          ctx,
          key,
          bindingIdent("cairnRequests", postcondition.assign!),
        )
      : undefined;
  const settle: Stmt[] = bindIdent
    ? [
        raw(`const ${promise}Matched = await ${promise};`),
        // Same envelope the runner records for a matched postcondition:
        // the REQUEST body (post data) is what `${requests.<assign>.body…}` reads.
        raw(
          `${bindIdent} = { url: ${promise}Matched.url(), method: ${promise}Matched.request().method(), status: ${promise}Matched.status(), ok: ${promise}Matched.status() >= 200 && ${promise}Matched.status() < 400, headers: {}, body: ${parseJsonOrText(`${promise}Matched.request().postData()`, ctx)} };`,
        ),
      ]
    : [raw(`await ${promise};`)];
  if (key && bindIdent) publishBinding(ctx, key, bindIdent);
  return {
    exported: true,
    stmts: [
      raw(
        `const ${promise} = page.waitForResponse((response) => ${predicate}, { timeout: ${timeout} });`,
      ),
      raw(`void ${promise}.catch(() => undefined);`),
      ...body.stmts,
      ...settle,
    ],
  };
}

function renderNetworkPostconditionPredicate(
  postcondition: NetworkPostcondition,
  ctx: EmitCtx,
): string {
  const conditions = [
    ...(postcondition.method
      ? [
          `response.request().method() === ${JSON.stringify(postcondition.method)}`,
        ]
      : []),
    `response.url().includes(${emitStr(postcondition.urlContains, ctx.usage)})`,
  ];
  const status = postcondition.status;
  if (status?.equals !== undefined) {
    conditions.push(`response.status() === ${status.equals}`);
  } else if (status?.below !== undefined) {
    conditions.push(`response.status() < ${status.below}`);
  } else if (status?.atLeast !== undefined) {
    conditions.push(`response.status() >= ${status.atLeast}`);
  } else if (status?.in !== undefined) {
    conditions.push(`[${status.in.join(", ")}].includes(response.status())`);
  }
  return `(${conditions.join(" && ")})`;
}

function renderStepBody(
  step: Step,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
  suppressMutationRetries = false,
): Rendered {
  const str = (s: string) => emitStr(s, ctx.usage);

  if ("open" in step) {
    if (typeof step.open === "string") {
      return one(raw(`await page.goto(${str(step.open)});`));
    }
    const opts: string[] = [
      `waitUntil: ${JSON.stringify(step.open.waitUntil)}`,
    ];
    if (step.open.timeoutMs !== undefined) {
      opts.push(`timeout: ${step.open.timeoutMs}`);
    }
    return one(
      raw(`await page.goto(${str(step.open.path)}, { ${opts.join(", ")} });`),
    );
  }
  if ("click" in step) {
    const settleMs = step.settleMs ?? specSettleMs;
    const target = locator(clickLocator(step), ctx);
    let stmts: Stmt[];
    if (step.click.until && !suppressMutationRetries) {
      const rendered = renderClickUntilStep(step, settleMs, ctx);
      if (!step.click.optional) return rendered;
      stmts = rendered.stmts;
    } else {
      // F15: dispatch = a DOM click through the runner's own runtime (one
      // visible target, refused when disabled, no post-click settle);
      // fallback: dispatch = pointer first (settled), the DOM click when it
      // fails.
      const settle: Stmt[] =
        settleMs !== undefined && settleMs > 0
          ? [
              raw(
                `await page.waitForLoadState("networkidle", { timeout: ${settleMs} });`,
              ),
            ]
          : [];
      // Built only when used: it pulls the widget helper into the file.
      const dispatched = (): Stmt =>
        raw(
          `await ${widgetHelper(ctx, "cairnWidget")}(page, { op: "click", mode: "dispatch", target: ${emitValue(
            { locator: clickLocator(step) },
            ctx.usage,
          )}, mountMs: ${WIDGET_CLICK_MOUNT_MS} });`,
        );
      stmts = step.click.dispatch
        ? [dispatched()]
        : step.click.fallback === "dispatch"
          ? [
              tryCatch(
                [raw(`await ${target}.click({ timeout: 5000 });`), ...settle],
                "pointerError",
                [
                  comment(
                    "pointer blocked or not actionable: fall back to a DOM click (Cairntrace fallback: dispatch)",
                  ),
                  dispatched(),
                ],
              ),
            ]
          : [raw(`await ${target}.click();`), ...settle];
    }
    // F15 optional: skip when no visible target exists right now.
    return step.click.optional
      ? {
          stmts: [iff(`await ${target}.isVisible().catch(() => true)`, stmts)],
          exported: true,
        }
      : { stmts, exported: true };
  }
  if ("hover" in step) {
    return one(raw(`await ${locator(step.hover, ctx)}.hover();`));
  }
  if ("focus" in step) {
    return one(raw(`await ${locator(step.focus, ctx)}.focus();`));
  }
  if ("fill" in step) {
    const target = locator(fillLocator(step), ctx);
    const emittedValue = str(step.fill.value);
    let rendered: Rendered;
    if (step.fill.mode === "set") {
      // F15 mode: set — the runner's own in-page fill (native setter for
      // input / textarea / select / contenteditable, the text control inside
      // a wrapper, input/change, re-set up to 4 times until the value
      // sticks); `optional` is decided by the same op.
      const optional = step.fill.optional === true;
      return one(
        raw(
          `await ${widgetHelper(ctx, "cairnWidget")}(page, { op: "fill", target: ${emitValue(
            { locator: fillLocator(step) },
            ctx.usage,
          )}, value: ${emittedValue}, mountMs: ${
            optional ? WIDGET_OPTIONAL_PRESENCE_MS : WIDGET_CLICK_MOUNT_MS
          }, verify: ${step.verifyFill !== false}, settleMs: 500, attempts: 4${
            optional ? ", optional: true" : ""
          } });`,
        ),
      );
    } else if (suppressMutationRetries || step.verifyFill === false) {
      rendered = one(raw(`await ${target}.fill(${emittedValue});`));
    } else {
      rendered = renderVerifiedInput(target, emittedValue, "fill", "", ctx);
    }
    return step.fill.optional
      ? {
          stmts: [
            iff(
              `await ${target}.isVisible().catch(() => true)`,
              rendered.stmts,
            ),
          ],
          exported: rendered.exported,
        }
      : rendered;
  }
  if ("type" in step) {
    const { value, delayMs, ...loc } = step.type;
    const opts = delayMs !== undefined ? `, { delay: ${delayMs} }` : "";
    const target = locator(loc as Locator, ctx);
    const emittedValue = str(value);
    if (suppressMutationRetries || step.verifyFill === false) {
      return one(
        raw(`await ${target}.pressSequentially(${emittedValue}${opts});`),
      );
    }
    return renderVerifiedInput(target, emittedValue, "type", opts, ctx);
  }
  if ("select" in step) {
    const { value, label, ...loc } = step.select;
    const option =
      value !== undefined
        ? `{ value: ${str(value)} }`
        : `{ label: ${str(label as string)} }`;
    return one(
      raw(`await ${locator(loc as Locator, ctx)}.selectOption(${option});`),
    );
  }
  if ("upload" in step) {
    const { path, ...loc } = step.upload;
    return one(
      raw(
        `await ${locator(loc as Locator, ctx)}.setInputFiles(${uploadPathExpr(path, ctx)});`,
      ),
    );
  }
  if ("download" in step) {
    return renderDownloadStep(step, ctx);
  }
  if ("transform" in step) {
    return renderTransformStep(step, ctx);
  }
  if ("request" in step) {
    return renderRequestStep(step, ctx);
  }
  if ("eval" in step) {
    return renderEvalStep(step, ctx);
  }
  if ("batch" in step) {
    return renderBatchStep(step, specSettleMs, ctx);
  }
  if ("wait" in step && (isRunnerDrivenWait(step.wait) || waitAssign(step))) {
    return renderControlWait(step, ctx);
  }
  if ("wait" in step) {
    if (isWaitGroup(step.wait)) {
      // Unreachable: groups are runner-driven (renderControlWait above).
      return renderControlWait(step, ctx);
    }
    const w = plainWaitCondition(step.wait);
    const timeout = "timeoutMs" in w ? (w.timeoutMs ?? 30_000) : 30_000;
    return one(raw(`await ${waitPromiseExpr(w, timeout, ctx)};`));
  }
  if ("press" in step) {
    if (step.target) {
      return one(
        raw(`await ${locator(step.target, ctx)}.press(${str(step.press)});`),
      );
    }
    return one(raw(`await page.keyboard.press(${str(step.press)});`));
  }
  if ("scroll" in step) {
    if ("to" in step.scroll) {
      return one(
        raw(`await ${locator(step.scroll.to, ctx)}.scrollIntoViewIfNeeded();`),
      );
    }
    const px = step.scroll.px ?? 400;
    const { direction } = step.scroll;
    const dx = direction === "left" ? -px : direction === "right" ? px : 0;
    const dy = direction === "up" ? -px : direction === "down" ? px : 0;
    return one(raw(`await page.mouse.wheel(${dx}, ${dy});`));
  }
  if ("snapshot" in step) {
    return skipStmt(
      ctx,
      "step",
      "snapshot step not exportable",
      `snapshot step skipped — Playwright traces cover this via context.tracing`,
      step.id,
      true,
    );
  }
  if ("expect" in step) return renderExpectStep(step, ctx);
  if ("run" in step) {
    return ctx.hostCommands
      ? renderRunStep(step, ctx)
      : legacyRunSkip(step, ctx);
  }
  if ("capture" in step) return renderCaptureStep(step, ctx);
  if ("monitor" in step) {
    return skipStmt(
      ctx,
      "step",
      "monitor step not exportable (external CLI)",
      `monitor step skipped — no Playwright equivalent for the monitor CLI`,
      step.id,
      true,
    );
  }
  if (isWidgetStep(step)) return renderWidgetStep(step, ctx);
  if ("repeat" in step) return renderRepeatStep(step, specSettleMs, ctx);
  if ("if" in step) return renderIfStep(step, specSettleMs, ctx);
  if ("use" in step && isRetryUseStep(step)) {
    return renderRetryUseStep(step, specSettleMs, ctx);
  }
  if ("use" in step && ctx.renderUseCall) {
    const call = ctx.renderUseCall(step, ctx);
    if (call) {
      const retry = useRetry(step);
      return retry
        ? renderRetryLoop(call, retry, useActionName(step), ctx, step.id)
        : call;
    }
  }
  if ("use" in step && isBuiltinLoginUse(step)) {
    return renderLoginStep(step, ctx);
  }
  if ("use" in step) {
    return skipStmt(
      ctx,
      "step",
      `use: ${
        typeof step.use === "string" ? step.use : step.use.action
      } not expanded — pass parseSpec().resolved`,
      `use: ${oneLine(typeof step.use === "string" ? step.use : step.use.action)} — expand imports via \`parseSpec\` before exporting`,
      step.id,
    );
  }
  const unknownStep = step as { id?: string };
  return skipStmt(
    ctx,
    "step",
    `unhandled step shape`,
    `unhandled step: ${JSON.stringify(step)}`,
    unknownStep.id,
  );
}

/** A widget helper call: `lib/widgets` in project mode, inlined otherwise. */
/** F20: a prelude helper (inlined, or imported from lib/prelude). */
function preludeHelper(ctx: EmitCtx, name: PreludeHelperName): string {
  if (ctx.libImportPrefix) markLib(ctx, "prelude", name);
  else (ctx.usedPrelude ?? (ctx.usedPrelude = new Set())).add(name);
  return name;
}

function widgetHelper(ctx: EmitCtx, name: WidgetHelperName): string {
  if (ctx.libImportPrefix) markLib(ctx, "widgets", name);
  (ctx.usedWidgets ?? (ctx.usedWidgets = new Set())).add(name);
  return name;
}

/** Runner default per-field budget (DEFAULT_WIDGET_TIMEOUT_MS). */
const WIDGET_DEFAULT_TIMEOUT_MS = 10_000;
/** Runner presence check for optional fields (OPTIONAL_PRESENCE_MS). */
const WIDGET_OPTIONAL_PRESENCE_MS = 750;
/** Runner mount wait of a dispatch click / fill mode: set (CLICK_MOUNT_MS). */
const WIDGET_CLICK_MOUNT_MS = 5_000;

/**
 * F15 set / check / uncheck / choose / form → `cairnWidget` /
 * `cairnWidgetForm` calls running the same in-page drivers as `cairn run`.
 */
function renderWidgetStep(step: WidgetStep, ctx: EmitCtx): Rendered {
  if ("form" in step) {
    const fn = widgetHelper(ctx, "cairnWidgetForm");
    widgetHelper(ctx, "cairnWidget");
    const fields = Object.entries(step.form.fields).map(([key, field]) => {
      const object = isFormFieldObject(field) ? field : undefined;
      const dependsOn = formFieldDependsOn(field);
      const parts = [
        `key: ${JSON.stringify(key)}`,
        `value: ${emitValue(object ? object.value : field, ctx.usage)}`,
        ...(object?.optional ? ["optional: true"] : []),
        ...(dependsOn.length > 0
          ? [`dependsOn: ${JSON.stringify(dependsOn)}`]
          : []),
        ...(object?.driver ? [`driver: ${JSON.stringify(object.driver)}`] : []),
        ...(object?.timeoutMs !== undefined
          ? [`timeoutMs: ${object.timeoutMs}`]
          : []),
      ];
      return raw(`{ ${parts.join(", ")} },`);
    });
    const dump =
      step.form.onFailure === "dumpUnanswered" ||
      (typeof step.form.onFailure === "object" &&
        step.form.onFailure.dumpUnanswered === true);
    return {
      stmts: [
        block(
          `await ${fn}(page, [`,
          fields,
          `], { verify: ${step.form.verify !== "none"}, dumpUnanswered: ${dump}, timeoutMs: ${
            step.form.timeoutMs ?? WIDGET_DEFAULT_TIMEOUT_MS
          } });`,
        ),
      ],
      exported: true,
    };
  }
  const kind =
    "set" in step
      ? "set"
      : "check" in step
        ? "check"
        : "uncheck" in step
          ? "uncheck"
          : "choose";
  const target = (step as Record<string, unknown>)[kind] as WidgetTarget;
  const budget = target.timeoutMs ?? WIDGET_DEFAULT_TIMEOUT_MS;
  const fields = [
    `op: ${JSON.stringify(kind)}`,
    `target: ${emitValue(widgetTargetRef(target), ctx.usage)}`,
    ...("value" in target
      ? [`value: ${emitValue(target.value, ctx.usage)}`]
      : []),
    ...("option" in target && target.option !== undefined
      ? [`option: ${emitStr(String(target.option), ctx.usage)}`]
      : []),
    ...(target.driver ? [`driver: ${JSON.stringify(target.driver)}`] : []),
    ...(target.optional ? ["optional: true"] : []),
    `timeoutMs: ${budget}`,
    `mountMs: ${
      target.optional ? Math.min(budget, WIDGET_OPTIONAL_PRESENCE_MS) : budget
    }`,
  ];
  return one(
    raw(
      `await ${widgetHelper(ctx, "cairnWidget")}(page, { ${fields.join(", ")} });`,
    ),
  );
}

function renderVerifiedInput(
  target: string,
  value: string,
  action: "fill" | "type",
  typeOptions = "",
  ctx?: EmitCtx,
): Rendered {
  if (ctx?.libImportPrefix) {
    const helper = action === "fill" ? "verifiedFill" : "verifiedType";
    markLib(ctx, "hydration", helper);
    const extra =
      action === "type" && typeOptions
        ? `, ${typeOptions.replace(/^, /, "")}`
        : "";
    return one(raw(`await ${helper}(page, ${target}, ${value}${extra});`));
  }
  const invoke =
    action === "fill"
      ? `await ${target}.fill(${value});`
      : `await ${target}.pressSequentially(${value}${typeOptions});`;
  return {
    stmts: [
      braces([
        block(`for (let fillAttempt = 0; ; fillAttempt++) {`, [
          ...(action === "type"
            ? [raw(`if (fillAttempt > 0) await ${target}.fill("");`)]
            : []),
          raw(invoke),
          raw(`await page.waitForTimeout(500);`),
          tryCatch(
            [
              raw(
                `await expect(${target}).toHaveValue(${value}, { timeout: 500 });`,
              ),
              raw(`break;`),
            ],
            "err",
            [
              raw(
                `if (fillAttempt >= 3) throw new Error("hydration wiped value after 4 attempts", { cause: err });`,
              ),
            ],
          ),
        ]),
      ]),
    ],
    exported: true,
  };
}

function renderClickUntilStep(
  step: Extract<Step, { click: unknown }>,
  settleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const until = step.click.until!;
  const timeoutMs = until.timeoutMs ?? 30_000;
  if (ctx.libImportPrefix) {
    markLib(ctx, "clickUntil", "clickUntil");
    const fields = [`timeoutMs: ${timeoutMs}`];
    if (settleMs !== undefined && settleMs > 0) {
      fields.push(`settleMs: ${settleMs}`);
    }
    fields.push(...clickUntilOptionFields(until, ctx));
    return one(
      raw(
        `await clickUntil(page, ${locator(clickLocator(step), ctx)}, { ${fields.join(", ")} });`,
      ),
    );
  }
  const loop: Stmt[] = [
    raw(`await clickTarget.click();`),
    ...(settleMs !== undefined && settleMs > 0
      ? [
          raw(
            `await page.waitForLoadState("networkidle", { timeout: ${settleMs} });`,
          ),
        ]
      : []),
    raw(
      `const clickUntilRemaining = Math.max(1, clickUntilDeadline - Date.now());`,
    ),
    raw(
      `const clickUntilAttemptTimeout = clickAttempt >= 3 ? clickUntilRemaining : Math.min(clickUntilRemaining, 250 * (2 ** clickAttempt));`,
    ),
    tryCatch([raw(clickUntilAssertion(until, ctx)), raw(`break;`)], "err", [
      raw(
        `if (clickAttempt >= 3 || Date.now() >= clickUntilDeadline) throw new Error("click.until condition was not satisfied after 4 attempts", { cause: err });`,
      ),
    ]),
  ];

  return {
    stmts: [
      braces([
        raw(`const clickTarget = ${locator(clickLocator(step), ctx)};`),
        raw(`const clickUntilDeadline = Date.now() + ${timeoutMs};`),
        block(`for (let clickAttempt = 0; ; clickAttempt++) {`, loop),
      ]),
    ],
    exported: true,
  };
}

function clickUntilOptionFields(until: ClickUntil, ctx: EmitCtx): string[] {
  const str = (value: string): string => emitStr(value, ctx.usage);
  if ("selectorGone" in until) {
    return [`selectorGone: ${str(until.selectorGone)}`];
  }
  if ("selector" in until) {
    return [`selector: ${str(until.selector)}`];
  }
  if ("url" in until) {
    if (until.url.equals !== undefined) {
      return [`urlEquals: ${str(until.url.equals)}`];
    }
    if (until.url.includes !== undefined) {
      return [`urlIncludes: ${str(until.url.includes)}`];
    }
    return [`urlPattern: ${str(until.url.pattern!)}`];
  }
  if ("text" in until) {
    return [`text: ${str(until.text)}`];
  }
  return [`notText: ${str(until.notText)}`];
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clickUntilAssertion(until: ClickUntil, ctx: EmitCtx): string {
  const str = (value: string): string => emitStr(value, ctx.usage);
  if ("selectorGone" in until) {
    return `await expect(page.locator(${str(until.selectorGone)})).toHaveCount(0, { timeout: clickUntilAttemptTimeout });`;
  }
  if ("selector" in until) {
    return `await expect(page.locator(${str(until.selector)})).not.toHaveCount(0, { timeout: clickUntilAttemptTimeout });`;
  }
  if ("url" in until) {
    if (until.url.equals !== undefined) {
      return `await expect(page).toHaveURL(${str(until.url.equals)}, { timeout: clickUntilAttemptTimeout });`;
    }
    if (until.url.includes !== undefined) {
      return `await expect(page).toHaveURL(new RegExp(${str(escapeRegExpLiteral(until.url.includes))}), { timeout: clickUntilAttemptTimeout });`;
    }
    return `await expect(page).toHaveURL(new RegExp(${str(until.url.pattern!)}), { timeout: clickUntilAttemptTimeout });`;
  }
  if ("text" in until) {
    return `await expect(page.locator("body")).toContainText(${str(until.text)}, { ignoreCase: true, useInnerText: true, timeout: clickUntilAttemptTimeout });`;
  }
  return `await expect(page.locator("body")).not.toContainText(${str(until.notText)}, { ignoreCase: true, useInnerText: true, timeout: clickUntilAttemptTimeout });`;
}

function renderEvalStep(
  step: Extract<Step, { eval: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const e = step.eval;
  let js = e.js ?? "";
  if (e.file) {
    if (!ctx.specDir) {
      skip(ctx, "step", `eval.file not inlined (${e.file})`, step.id);
      return {
        stmts: [
          comment(
            `eval.file ${JSON.stringify(e.file)} is not inlined — specDir unknown.`,
          ),
        ],
        exported: false,
      };
    }
    const abs = stepFilePath(e.file, ctx, "eval.file");
    try {
      js = readFileSync(abs, "utf8");
      ctx.evalFiles?.add(abs);
    } catch (error) {
      skip(
        ctx,
        "step",
        `eval.file not readable (${e.file}): ${(error as Error).message}`,
        step.id,
      );
      return {
        stmts: [
          comment(
            `eval.file ${JSON.stringify(e.file)} could not be read; keep the Cairntrace spec as SoT.`,
          ),
        ],
        exported: false,
      };
    }
  }
  if (
    hasSecretSentinel(js) ||
    hasSecretSentinel(JSON.stringify(e.args ?? {}))
  ) {
    // The source/args are assembled in NODE (template literal) and handed to
    // the page as data, exactly like the runner substitutes them — but the
    // secret value then lives in page memory and Playwright traces.
    addRisk(
      ctx,
      "secretInBrowser",
      `eval passes a secret into page-evaluated source/args; Playwright traces record evaluate arguments`,
      step.id,
    );
  }
  const argsJson = emitValue(e.args ?? {}, ctx.usage);
  // Late-bound parts (run token, action vars, secrets, splices) are spliced
  // into the source string in Node before it is sent to the page. F20: a
  // source that uses `__cairn` gets the page prelude first, like `cairn run`.
  const sourceExpr = usesCairnPrelude(js)
    ? `${preludeHelper(ctx, "CAIRN_PRELUDE")} + ${emitStr(js, ctx.usage)}`
    : emitStr(js, ctx.usage);
  const key = e.assign ? runtimeRefKey("evals", e.assign) : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(ctx, key, bindingIdent("cairnEvals", e.assign!))
      : undefined;

  const asyncFunctionType =
    ctx.lang === "ts"
      ? ` as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>`
      : "";
  const evalCall = (): Stmt[] => [
    block(
      `${
        bindIdent ? `${bindIdent} = { value: ` : ""
      }await page.evaluate(async ({ source, args }) => {`,
      [
        comment(
          `Cairn eval.js is JavaScript input, so keep it outside the generated TypeScript AST.`,
        ),
        raw(
          `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor${asyncFunctionType};`,
        ),
        raw(`const execute = new AsyncFunction("args", source);`),
        raw(`return await execute(args);`),
      ],
      `}, { source: ${sourceExpr}, args: ${argsJson} })${
        bindIdent ? " }" : ""
      };`,
    ),
  ];

  let stmts: Stmt[];
  if (js.includes("location.reload()")) {
    // agent-browser evals survive an in-page location.reload(); Playwright's
    // evaluate context is destroyed by the navigation instead. Retry in a LOOP
    // (up to 4 contexts): a hot dev server can navigate/reload more than once
    // (HMR recompile) while the rescue eval is in flight.
    stmts = [
      block(`for (let evalAttempt = 0; ; evalAttempt++) {`, [
        tryCatch([...evalCall(), raw(`break;`)], "err", [
          raw(
            `if (evalAttempt >= 3 || !String(err).includes("Execution context was destroyed")) throw err;`,
          ),
          raw(
            `await page.waitForLoadState("networkidle", { timeout: 45000 });`,
          ),
        ]),
      ]),
    ];
  } else {
    stmts = evalCall();
  }
  if (key && bindIdent) publishBinding(ctx, key, bindIdent);
  return { stmts, exported: true };
}

function renderBatchStep(
  step: Extract<Step, { batch: unknown }>,
  specSettleMs: number | undefined,
  ctx: EmitCtx,
): Rendered {
  const stmts: Stmt[] = [
    comment(
      `batch: expanded sequentially — Playwright cannot preserve hover/focus atomicity like agent-browser batch`,
    ),
  ];
  let any = false;
  for (const sub of step.batch as BatchSubStep[]) {
    // Batch sub-steps are a restricted Step subset; cast through unknown.
    const asStep = sub as unknown as Step;
    const rendered = renderStepBody(asStep, specSettleMs, ctx);
    stmts.push(...rendered.stmts);
    if (rendered.exported) any = true;
  }
  return { stmts, exported: any };
}

function renderRequestStep(
  step: Extract<Step, { request: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const r = step.request;
  if (
    r.credentials !== undefined ||
    r.until !== undefined ||
    r.retry !== undefined ||
    r.capture !== undefined ||
    r.matrix !== undefined
  ) {
    return renderRequestV2Step(step, ctx);
  }
  const str = (s: string) => emitStr(s, ctx.usage);
  const method = (r.method ?? "GET").toUpperCase();
  const timeout = r.timeoutMs ?? 30_000;
  const headers: Record<string, string> = { ...r.headers };
  if (
    r.body !== undefined &&
    typeof r.body !== "string" &&
    !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }
  const opts: string[] = [
    `method: ${JSON.stringify(method)}`,
    `timeout: ${timeout}`,
  ];
  if (Object.keys(headers).length > 0) {
    opts.push(`headers: ${emitValue(headers, ctx.usage)}`);
  }
  if (r.body !== undefined) {
    opts.push(`data: ${emitValue(r.body, ctx.usage)}`);
  }
  const urlExpr = str(r.url);
  // The runner names an unassigned response `request_<step number>`.
  const assignName =
    r.assign ??
    (ctx.stepIndex !== undefined ? `request_${ctx.stepIndex + 1}` : undefined);
  const key = assignName ? runtimeRefKey("requests", assignName) : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(ctx, key, bindingIdent("cairnRequests", assignName!))
      : undefined;
  const needsLocal =
    r.expectStatus !== undefined ||
    ctx.nodeVerifierEvidence !== undefined ||
    ctx.networkRecorder !== undefined ||
    bindIdent !== undefined;
  // A reserved, block-scoped local: never derived from `assign:`, which could
  // shadow `requests` (network evidence), `page`, or `consoleErrors`.
  const varName = "cairnResponse";
  const evidenceTimestamp = "cairnResponseTimestamp";
  const stmts: Stmt[] = [
    comment(
      `request step (${r.assign ?? "unnamed"}) — page.request shares browser context cookies`,
    ),
  ];
  if (ctx.nodeVerifierEvidence) {
    stmts.push(raw(`const ${evidenceTimestamp} = Date.now();`));
  }
  stmts.push(
    raw(
      `${
        needsLocal ? `const ${varName} = ` : ""
      }await page.request.fetch(${urlExpr}, { ${opts.join(", ")} });`,
    ),
  );
  if (ctx.networkRecorder) {
    // `cairn run` records request-step calls in its network evidence, so
    // network/noFailedRequests outcomes see them; page listeners do not.
    stmts.push(
      raw(
        `${ctx.networkRecorder}.push({ url: ${varName}.url(), method: ${JSON.stringify(method)}, status: ${varName}.status()${networkLogBody(r.body, ctx)} });`,
      ),
    );
  }
  if (ctx.nodeVerifierEvidence) {
    const contentType = Object.entries(headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1];
    const evidence: string[] = [
      `url: ${varName}.url()`,
      `method: ${JSON.stringify(method)}`,
      `status: ${varName}.status()`,
      `timestamp: ${evidenceTimestamp}`,
    ];
    if (r.body !== undefined) {
      evidence.push(`body: ${emitValue(r.body, ctx.usage)}`);
    }
    if (contentType !== undefined) {
      evidence.push(`contentType: ${emitStr(contentType, ctx.usage)}`);
    }
    stmts.push(
      raw(
        `${ctx.nodeVerifierEvidence}.recordApiRequest({ ${evidence.join(", ")} });`,
      ),
    );
  }
  if (bindIdent) {
    // Same envelope the runner stores for `${requests.<name>.…}`.
    stmts.push(
      raw(
        `${bindIdent} = { url: ${varName}.url(), method: ${JSON.stringify(method)}, status: ${varName}.status(), ok: ${varName}.status() >= 200 && ${varName}.status() < 400, headers: ${varName}.headers(), body: ${parseJsonOrText(`await ${varName}.text()`, ctx)} };`,
      ),
    );
  }
  if (r.expectStatus !== undefined) {
    if (Array.isArray(r.expectStatus)) {
      stmts.push(
        raw(
          `expect([${r.expectStatus.join(", ")}]).toContain(${varName}.status());`,
        ),
      );
    } else {
      stmts.push(raw(`expect(${varName}.status()).toBe(${r.expectStatus});`));
    }
  }
  if (key && bindIdent) publishBinding(ctx, key, bindIdent);
  // Block-scoped so repeated request steps never redeclare their locals.
  return { stmts: [braces(stmts)], exported: true };
}

/**
 * The body a request step sent, for the rich request log a `network`
 * body / count outcome judges (`cairn run` records request-step calls with
 * their bodies): `, postData: <json text>`, or "" when nothing is judged.
 */
function networkLogBody(body: unknown, ctx: EmitCtx): string {
  if (!ctx.richNetwork || body === undefined) return "";
  const value = emitValue(body, ctx.usage);
  return `, timestamp: Date.now(), postData: ${
    typeof body === "string" ? value : `JSON.stringify(${value})`
  }`;
}

/** A request helper: `lib/request` in project mode, inlined otherwise. */
function requestHelper(ctx: EmitCtx, name: RequestHelperName): string {
  if (ctx.libImportPrefix) markLib(ctx, "request", name);
  // The request helpers read paths / match through the runner's own matchers.
  useData(ctx, "dataMatch");
  (ctx.usedRequestHelpers ?? (ctx.usedRequestHelpers = new Set())).add(name);
  return name;
}

function statusList(value: number | number[]): number[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * F18 request v2 → `cairnRequest` / `cairnRequestMatrix`: the runner's
 * credentials / retry / until / capture / matrix semantics, the same
 * envelope (`${requests.<name>.captures.<key>}` splices keep working).
 */
function renderRequestV2Step(
  step: Extract<Step, { request: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const r = step.request;
  const helper = requestHelper(
    ctx,
    r.matrix ? "cairnRequestMatrix" : "cairnRequest",
  );
  const input: string[] = [
    `method: ${emitStr(r.matrix ? r.method : r.method.toUpperCase(), ctx.usage)}`,
    `url: ${emitStr(r.url, ctx.usage)}`,
  ];
  if (r.headers) input.push(`headers: ${emitValue(r.headers, ctx.usage)}`);
  if (r.body !== undefined) input.push(`data: ${emitValue(r.body, ctx.usage)}`);
  input.push(`timeout: ${r.timeoutMs ?? 30_000}`);
  if (r.credentials)
    input.push(`credentials: ${JSON.stringify(r.credentials)}`);
  if (r.until) {
    const until = {
      ...(r.until.status !== undefined
        ? { status: statusList(r.until.status) }
        : {}),
      ...(r.until.json ? { json: r.until.json } : {}),
      ...(r.until.every !== undefined ? { every: r.until.every } : {}),
      ...(r.until.timeoutMs !== undefined
        ? { timeoutMs: r.until.timeoutMs }
        : {}),
    };
    input.push(`until: ${emitValue(until, ctx.usage)}`);
  }
  if (r.retry) input.push(`retry: ${JSON.stringify(r.retry)}`);
  // Capture paths may carry runtime references (a JSONPath filter on a fixture value).
  if (r.capture) input.push(`capture: ${emitValue(r.capture, ctx.usage)}`);
  if (r.expectStatus !== undefined) {
    input.push(`expectStatus: ${JSON.stringify(statusList(r.expectStatus))}`);
  }
  const assignName =
    r.assign ??
    (ctx.stepIndex !== undefined ? `request_${ctx.stepIndex + 1}` : undefined);
  const key = assignName ? runtimeRefKey("requests", assignName) : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(ctx, key, bindingIdent("cairnRequests", assignName!))
      : undefined;
  const varName = "cairnResponse";
  const needsLocal =
    ctx.networkRecorder !== undefined ||
    ctx.nodeVerifierEvidence !== undefined ||
    bindIdent !== undefined;
  const features = (
    ["credentials", "until", "retry", "capture", "matrix"] as const
  ).filter((field) => r[field] !== undefined);
  const call = r.matrix
    ? `await ${helper}(page, { ${input.join(", ")} }, ${emitValue(r.matrix, ctx.usage)})`
    : `await ${helper}(page, { ${input.join(", ")} })`;
  const stmts: Stmt[] = [
    comment(
      `request step (${r.assign ?? "unnamed"}) — ${helper}: ${features.join(", ")} as cairn run`,
    ),
  ];
  const evidenceTimestamp = "cairnResponseTimestamp";
  if (ctx.nodeVerifierEvidence) {
    stmts.push(raw(`const ${evidenceTimestamp} = Date.now();`));
  }
  stmts.push(raw(`${needsLocal ? `const ${varName} = ` : ""}${call};`));
  if (ctx.networkRecorder) {
    stmts.push(
      raw(
        r.matrix
          ? `${ctx.networkRecorder}.push(...(${varName}.matrix ?? []).map((entry) => ({ url: entry.url, method: entry.method, status: entry.status })));`
          : `${ctx.networkRecorder}.push({ url: ${varName}.url, method: ${varName}.method, status: ${varName}.status${networkLogBody(r.body, ctx)} });`,
      ),
    );
  }
  if (ctx.nodeVerifierEvidence && !r.matrix) {
    const evidence: string[] = [
      `url: ${varName}.url`,
      `method: ${varName}.method`,
      `status: ${varName}.status`,
      `timestamp: ${evidenceTimestamp}`,
    ];
    if (r.body !== undefined) {
      evidence.push(`body: ${emitValue(r.body, ctx.usage)}`);
    }
    stmts.push(
      raw(
        `${ctx.nodeVerifierEvidence}.recordApiRequest({ ${evidence.join(", ")} });`,
      ),
    );
  }
  if (bindIdent) stmts.push(raw(`${bindIdent} = ${varName};`));
  if (key && bindIdent) publishBinding(ctx, key, bindIdent);
  return { stmts: [braces(stmts)], exported: true };
}

/** A JSON-shaped value whose `${requests.…}` text stays for the helper. */
export function emitPlainValue(value: unknown, usage: RefUsage): string {
  if (typeof value === "string") {
    return emitStr(value, usage, { runtimeRefs: false });
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => emitPlainValue(item, usage)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, item]) => `${JSON.stringify(k)}: ${emitPlainValue(item, usage)}`,
    );
    return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * F18 `use: login` → `cairnLogin(page, CAIRN_AUTH)`: the environment's
 * auth through `page.request` (the page's cookie jar), secrets as
 * `process.env` reads, hydrate with the login response only. A `use:` call
 * with its own vars passes its literal instead of CAIRN_AUTH.
 */
function renderLoginStep(step: UseStep, ctx: EmitCtx): Rendered {
  const auth = ctx.envAuth;
  if (!auth) {
    return skipStmt(
      ctx,
      "step",
      "use: login not exportable: the export environment has no auth: block",
      "use: login skipped — no environments.<env>.auth to export",
      step.id,
    );
  }
  const useVars = useActionVars(step) ?? {};
  let literal: string;
  try {
    literal = emitPlainValue(prepareExportAuth(auth, useVars), ctx.usage);
  } catch (e) {
    return skipStmt(
      ctx,
      "step",
      `use: login not exportable: ${(e as Error).message}`,
      `use: login skipped — ${(e as Error).message}`,
      step.id,
    );
  }
  let authExpr = "CAIRN_AUTH";
  if (Object.keys(useVars).length > 0) authExpr = literal;
  else if (ctx.libImportPrefix) markLib(ctx, "auth", "CAIRN_AUTH");
  else ctx.authConst = literal;
  const helper = requestHelper(ctx, "cairnLogin");
  const key = runtimeRefKey("requests", "login");
  const bindIdent = wantsBinding(ctx, key)
    ? declareBinding(ctx, key, "cairnRequests_login")
    : undefined;
  // Like `cairn run`: an unset secret fails before anything is sent (signing
  // in with "" would only fail later, and worse).
  const required = requiredAuthEnv(auth.auth);
  const stmts: Stmt[] = [
    comment(
      `use: login — environments.${auth.envName}.auth through page.request; secrets from process.env (never passed to page.evaluate)`,
    ),
    ...(required.length > 0
      ? [
          block(`for (const name of ${JSON.stringify(required)}) {`, [
            raw(
              `if (!process.env[name]) throw new Error("use: login: " + name + " is not set — export it (or add it to the secrets provider) before running this test");`,
            ),
          ]),
        ]
      : []),
    raw(
      `${
        bindIdent ? `${bindIdent} = ` : ""
      }await ${helper}(page, ${authExpr});`,
    ),
  ];
  if (bindIdent) publishBinding(ctx, key, bindIdent);
  return { stmts, exported: true };
}

/** `${secrets.X}` / `${env.X}` names (no `:-default`) an auth block reads. */
function requiredAuthEnv(auth: unknown): string[] {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const m of node.matchAll(
        /\$\{(?:secrets|env)\.([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g,
      )) {
        if (m[2] === undefined) names.add(m[1]!);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  walk(auth);
  return [...names].toSorted();
}

/**
 * `transform`: the step's node module runs in the test's own process (its
 * file is copied next to the project like a node verifier), with the ctx the
 * runner passes it; the file it writes is bound as `${artifacts.<assign>…}`.
 * A transform whose file cannot be located is a HARD skip (test.fixme): later
 * steps upload or verify what it produces.
 */
function renderTransformStep(
  step: Extract<Step, { transform: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const target = step.transform;
  if (!ctx.specDir) {
    return skipStmt(
      ctx,
      "step",
      `transform step not exportable (${target.file}): its file cannot be located without the spec directory`,
      `transform step skipped — ${JSON.stringify(target.file)} cannot be located`,
      step.id,
    );
  }
  const abs = stepFilePath(target.file, ctx, "transform.file");
  const importPath = nodeModuleImportPath(abs, ctx);
  const fileName = basename(target.saveAs);
  const relativePath = `transforms/${fileName}`;
  const name = target.assign ?? artifactNameFromPath(relativePath);
  const key = runtimeRefKey("artifacts", name);
  const bindIdent = wantsBinding(ctx, key)
    ? declareBinding(ctx, key, bindingIdent("cairnArtifacts", name))
    : undefined;
  useData(ctx, "dataTransform", "cairnRunTransform");
  ctx.usesTestInfo = true;
  const literalName = parseTemplateValue(target.saveAs).every(
    (p) => p.kind === "lit",
  );
  const fileNameExpr = literalName
    ? JSON.stringify(fileName)
    : `(String(${emitStr(target.saveAs, ctx.usage)}).split(/[\\\\/]/).pop() || "transform")`;
  const relativeExpr = literalName
    ? JSON.stringify(relativePath)
    : `"transforms/" + ${fileNameExpr}`;
  const artifacts = [...ctx.usage.bindings]
    .filter(([bound]) => bound.startsWith("artifacts:"))
    .map(
      ([bound, ident]) =>
        `${JSON.stringify(bound.slice("artifacts:".length))}: ${ident}`,
    );
  addRisk(
    ctx,
    "transformInProcess",
    `the transform runs in the Playwright test process (cairn run spawns a child with a filtered environment, and its ctx.vars is empty here)`,
    step.id,
  );
  const stmts: Stmt[] = [
    comment(
      `transform step: ${oneLine(target.file)} runs in the test's node context, not the browser`,
    ),
    raw(
      `const cairnTransformOut = test.info().outputPath("cairn-run", "transforms", ${fileNameExpr});`,
    ),
    raw(`const cairnTransformInput = ${uploadPathExpr(target.input, ctx)};`),
    block(
      `await cairnRunTransform(await import(${JSON.stringify(importPath)}), {`,
      [
        raw(`input: cairnTransformInput,`),
        raw(`inputPath: cairnTransformInput,`),
        raw(
          `output: { path: cairnTransformOut, relativePath: ${relativeExpr} },`,
        ),
        raw(`outputPath: cairnTransformOut,`),
        raw(`fixtures: ${emitValue(target.fixtures ?? {}, ctx.usage)},`),
        raw(`artifacts: { ${artifacts.join(", ")} },`),
        raw(`vars: {},`),
        raw(`runDir: test.info().outputPath("cairn-run"),`),
        raw(`specDir: ${ctx.specDirExpr ?? JSON.stringify(ctx.specDir)},`),
      ],
      `}, cairnTransformOut);`,
    ),
  ];
  if (bindIdent) {
    stmts.push(
      raw(
        `${bindIdent} = { path: cairnTransformOut, relativePath: ${relativeExpr} };`,
      ),
    );
    publishBinding(ctx, key, bindIdent);
  }
  return { stmts: [braces(stmts)], exported: true };
}

/**
 * Portable import of a node module the test runs (verifier / transform):
 * the project prefix when it was copied in, else relative to the generated
 * file, else the machine-local absolute path.
 */
function nodeModuleImportPath(abs: string, ctx: EmitCtx): string {
  if (ctx.verifierImportPrefix) {
    ctx.verifierFiles?.add(abs);
    return `${ctx.verifierImportPrefix}/${abs.split("/").pop()}`;
  }
  if (ctx.outDir) return toRelativeImport(ctx.outDir, abs);
  return abs;
}

function renderDownloadStep(
  step: Extract<Step, { download: unknown }>,
  ctx: EmitCtx,
): Rendered {
  const { saveAs, assign, timeoutMs, ...loc } = step.download;
  const timeout = timeoutMs ?? 30_000;
  const literal = parseTemplateValue(saveAs).every((p) => p.kind === "lit");
  // Mirror the runner: downloads land in <runDir>/downloads/<basename>; the
  // exported run dir is Playwright's per-test `cairn-run` output folder.
  const fileNameExpr = literal
    ? JSON.stringify(basename(saveAs))
    : `(String(${emitStr(saveAs, ctx.usage)}).split(/[\\\\/]/).pop() || "download")`;
  const name = assign ?? (literal ? artifactNameFromPath(saveAs) : undefined);
  const key = name ? runtimeRefKey("artifacts", name) : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(ctx, key, bindingIdent("cairnArtifacts", name!))
      : undefined;
  ctx.usesTestInfo = true;
  const stmts: Stmt[] = [
    raw(`const download = await Promise.all([`),
    raw(`  page.waitForEvent("download", { timeout: ${timeout} }),`),
    raw(`  ${locator(loc as Locator, ctx)}.click(),`),
    raw(`]).then(([download]) => download);`),
    raw(
      `const downloadPath = test.info().outputPath("cairn-run", "downloads", ${fileNameExpr});`,
    ),
    raw(`await download.saveAs(downloadPath);`),
  ];
  if (bindIdent) {
    const relativePath = literal
      ? JSON.stringify(`downloads/${basename(saveAs)}`)
      : `"downloads/" + ${fileNameExpr}`;
    stmts.push(
      raw(
        `${bindIdent} = { path: downloadPath, relativePath: ${relativePath} };`,
      ),
    );
  }
  if (key && bindIdent) publishBinding(ctx, key, bindIdent);
  return { stmts: [braces(stmts)], exported: true };
}

/**
 * A relative file path declared by the step being rendered, resolved like
 * the runner (F13): against the declaring file's directory — the imported
 * action's for a step that came from one, with the deprecated spec-relative
 * fallback — else against the spec's directory.
 */
export function stepFilePath(
  file: string,
  ctx: EmitCtx,
  field: string,
): string {
  if (isAbsolute(file)) return file;
  if (ctx.stepOrigins && ctx.stepIndex !== undefined) {
    return resolveStepFile(
      file,
      // F14: a nested step resolves against the file that declares it.
      stepFileScopeAt(ctx.stepOrigins, ctx.stepPath ?? ctx.stepIndex),
      field,
    );
  }
  return resolve(ctx.specDir ?? process.cwd(), file);
}

/**
 * Upload paths: artifact splices read earlier download bindings; a literal
 * path is resolved like the runner (relative to the file that declares the
 * step: the spec, or the imported action). Project mode
 * copies the file into `<export>/fixtures/` so the suite is relocatable;
 * single-file mode emits the resolved absolute path (reported as a risk).
 */
function uploadPathExpr(path: string, ctx: EmitCtx): string {
  const parts = parseTemplateValue(path);
  if (!parts.every((p) => p.kind === "lit")) {
    const relativeArtifact = parts.some(
      (p) =>
        p.kind === "runtime" &&
        p.source === "artifacts" &&
        p.path[0] === "relativePath",
    );
    if (relativeArtifact) {
      ctx.usesTestInfo = true;
      return `test.info().outputPath("cairn-run", ${emitStr(path, ctx.usage)})`;
    }
    return emitStr(path, ctx.usage);
  }
  const abs = isAbsolute(path)
    ? path
    : ctx.specDir
      ? stepFilePath(path, ctx, "upload.path")
      : undefined;
  if (!abs) return JSON.stringify(path);
  if (ctx.fixtureFiles) {
    const blocker = fixtureCopyBlocker(abs, ctx.fixtureRoot);
    if (blocker === undefined) {
      const rel = registerFixture(ctx.fixtureFiles, abs);
      markLib(ctx, "fixtures", "cairnFixturePath");
      return `cairnFixturePath(${JSON.stringify(rel.slice("fixtures/".length))})`;
    }
    addRisk(
      ctx,
      "absolutePath",
      `upload file ${abs} was not copied into fixtures/ (${blocker}); the test reads the machine-local path`,
    );
  }
  return JSON.stringify(abs);
}

/** Largest upload file copied into an export's `fixtures/`. */
export const MAX_FIXTURE_BYTES = 10 * 1024 * 1024;

/**
 * Why an upload file may NOT be copied into the export, or undefined when it
 * may. Exports are usually committed, so copies are bounded like verifier
 * copies: a regular non-symlink file inside the project root, size-capped —
 * never a personal document elsewhere on the machine.
 */
function fixtureCopyBlocker(
  abs: string,
  root: string | undefined,
): string | undefined {
  if (!root) return "no project root bounds fixture copies";
  let stats;
  try {
    stats = lstatSync(abs);
  } catch {
    return "file not found at export time";
  }
  if (stats.isSymbolicLink()) return "it is a symlink";
  if (!stats.isFile()) return "it is not a regular file";
  if (stats.size > MAX_FIXTURE_BYTES) {
    return `it is larger than ${MAX_FIXTURE_BYTES} bytes`;
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return "its real path cannot be resolved";
  }
  const rel = relative(root, real);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return "it is outside the project root";
  }
  return undefined;
}

/** Reserve `fixtures/<name>` for a source file (parent-prefixed on collision). */
export function registerFixture(
  fixtures: Map<string, string>,
  absSource: string,
): string {
  const existing = fixtures.get(absSource);
  if (existing) return existing;
  const taken = new Set(fixtures.values());
  let rel = `fixtures/${basename(absSource)}`;
  if (taken.has(rel)) {
    rel = `fixtures/${basename(dirname(absSource))}-${basename(absSource)}`;
  }
  for (let n = 2; taken.has(rel); n++) {
    rel = `fixtures/${n}-${basename(absSource)}`;
  }
  fixtures.set(absSource, rel);
  return rel;
}

function locator(loc: Locator, ctx: EmitCtx): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  // Cairntrace (agent-browser) acts on the FIRST match of a semantic locator;
  // Playwright strict mode instead fails on multiple matches. When no explicit
  // nth is given, emit .first() so the exported test keeps source semantics,
  // unless strict locators were asked for (then an ambiguous locator fails the
  // exported test, like `cairn run --backend playwright`).
  const nth =
    "nth" in loc && loc.nth !== undefined
      ? `.nth(${loc.nth})`
      : ctx.strictLocators
        ? ""
        : ".first()";
  const hasText = "hasText" in loc ? loc.hasText : undefined;
  const textFilter = hasText ? `.filter({ hasText: ${str(hasText)} })` : "";
  const visibleFilter =
    "visible" in loc && loc.visible === true ? `.locator("visible=true")` : "";
  const inner = locatorFromRoot("page", loc, ctx);
  const near = "near" in loc ? loc.near : undefined;
  if (!near) {
    return loc.by === "selector"
      ? `${inner}${textFilter}${visibleFilter}`
      : `${inner}${textFilter}${visibleFilter}${nth}`;
  }
  const scoped = `page.getByText(${str(near)}).locator("xpath=ancestor-or-self::*").filter({ has: ${inner} }).last()`;
  const scopedLocator = locatorFromRoot(scoped, loc, ctx);
  return loc.by === "selector"
    ? `${scopedLocator}${textFilter}${visibleFilter}`
    : `${scopedLocator}${textFilter}${visibleFilter}${nth}`;
}

function locatorFromRoot(root: string, loc: Locator, ctx: EmitCtx): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  switch (loc.by) {
    case "role": {
      const opts: string[] = [];
      if (loc.name) opts.push(`name: ${str(loc.name)}`);
      if (loc.exact) opts.push("exact: true");
      if (loc.visible === false) opts.push("includeHidden: true");
      return `${root}.getByRole(${JSON.stringify(loc.role)}${
        opts.length > 0 ? `, { ${opts.join(", ")} }` : ""
      })`;
    }
    case "label":
      return `${root}.getByLabel(${str(loc.name)}${
        loc.exact ? ", { exact: true }" : ""
      })`;
    case "text":
      return `${root}.getByText(${str(loc.text)}${
        loc.exact ? ", { exact: true }" : ""
      })`;
    case "selector":
      return `${root}.locator(${str(loc.selector)})`;
    case "testid": {
      const specAttribute = ctx.testIdAttribute ?? "data-testid";
      if (
        ctx.hostTestIdAttribute !== undefined &&
        ctx.hostTestIdAttribute !== specAttribute
      ) {
        return `${root}.locator(${emitCssAttributeSelector(specAttribute, loc.testid, ctx.usage)})`;
      }
      return `${root}.getByTestId(${str(loc.testid)})`;
    }
  }
}

/* ----- outcome rendering ----- */

/** Outcome fields `cairn run` never splices (see withSpliceSources). */
export const NO_SPLICE: ReadonlySet<RuntimeRefSource> = new Set();
const ALL_SPLICE: ReadonlySet<RuntimeRefSource> = new Set([
  "requests",
  "evals",
  "artifacts",
]);
/** httpJson.url: the runner resolves artifacts and requests, not evals. */
const HTTP_JSON_URL_SPLICE: ReadonlySet<RuntimeRefSource> = new Set([
  "requests",
  "artifacts",
]);

/** Emit with a narrowed set of runtime sources the runner splices here. */
export function withSpliceSources<T>(
  ctx: EmitCtx,
  sources: ReadonlySet<RuntimeRefSource>,
  render: () => T,
): T {
  const previous = ctx.usage.spliceSources;
  ctx.usage.spliceSources = sources;
  try {
    return render();
  } finally {
    if (previous) ctx.usage.spliceSources = previous;
    else delete ctx.usage.spliceSources;
  }
}

/**
 * Outcomes splice runtime refs only where `cairn run` does: script
 * `fixtures` and the `httpJson.url`. Everywhere else (text/url/count/network
 * needles, httpJson matchers) the runner compares the raw `${…}` text, so the
 * export keeps it literal too and reports a `literalSplice` risk.
 */
export function renderOutcome(outcome: Outcome, ctx: EmitCtx): Rendered {
  const unresolvedBefore = ctx.usage.unresolvedLog.length;
  const literalBefore = ctx.usage.literalLog.length;
  const infra = classifyInfraVerifier(outcome.verify, ctx);
  let rendered: Rendered;
  if (infra && ctx.verifiersMode === "drop") {
    rendered = dropInfraOutcome(outcome, infra, ctx);
  } else if (infra && ctx.verifiersMode === "gate") {
    rendered = renderGatedOutcome(outcome, infra, ctx);
  } else {
    rendered = withSpliceSources(ctx, NO_SPLICE, () =>
      renderOutcomeBody(outcome, ctx),
    );
  }
  const poll = verifierPoll(outcome.verify);
  if (rendered.exported && poll !== undefined) {
    // `poll:` re-runs the check until it holds (toPass / cairnPoll).
    rendered = {
      stmts: wrapPolled(rendered.stmts, poll, ctx),
      exported: true,
    };
    if (poll.stableMs !== undefined && poll.stableMs > 0) {
      addRisk(
        ctx,
        "pollApproximated",
        `poll.stableMs ${poll.stableMs}ms is emulated by cairnPoll: each sample checks once (assertions with a 1ms timeout instead of Playwright's auto-retry) and green must hold for the window over at least two samples, like cairn run; a locator read inside a sample can still auto-wait, and failFastOnStepFailure does not apply because the exported test stops at its first failed step`,
        outcome.id,
      );
    }
  }
  if (ctx.wrapSteps && rendered.exported) {
    // `cairn export playwright --verify=differential` reads this to compare
    // the requests each side matched (the test reports it even when the
    // assertion below fails).
    const evidence = networkEvidenceAnnotation(outcome, ctx);
    if (evidence) {
      rendered = { ...rendered, stmts: [evidence, ...rendered.stmts] };
    }
  }
  recordUnresolvedSplices(ctx, unresolvedBefore, "outcome", outcome.id);
  for (const ref of new Set(ctx.usage.literalLog.slice(literalBefore))) {
    addRisk(
      ctx,
      "literalSplice",
      `\${${ref}} is compared as literal text: \`cairn run\` does not splice runtime refs into this outcome field, and the export matches that`,
      outcome.id,
    );
  }
  return rendered;
}

/**
 * Project-mode network outcomes record how many requests matched their
 * method + URL (`cairn:network` annotation: `{ outcome, matched }`), so the
 * export verifier can compare network evidence with the runner's request log
 * without parsing the assertion.
 */
function networkEvidenceAnnotation(
  outcome: Outcome,
  ctx: EmitCtx,
): Stmt | undefined {
  const v = outcome.verify;
  let method: string | undefined;
  let urlContains: string;
  if (isNetworkVerifier(v)) {
    method = v.network.method;
    urlContains = v.network.urlContains;
  } else if (isNoFailedRequestsVerifier(v)) {
    method = v.noFailedRequests.method;
    urlContains = v.noFailedRequests.urlContains;
  } else {
    return undefined;
  }
  const conds = [
    ...(method
      ? [`r.method.toUpperCase() === ${JSON.stringify(method.toUpperCase())}`]
      : []),
    `r.url.includes(${emitStr(urlContains, ctx.usage)})`,
  ];
  return raw(
    `test.info().annotations.push({ type: "cairn:network", description: JSON.stringify({ outcome: ${JSON.stringify(outcome.id)}, matched: requests.filter((r${
      ctx.lang === "ts" ? ": { url: string; method: string }" : ""
    }) => ${conds.join(" && ")}).length }) });`,
  );
}

/**
 * Node / datasource verifiers (`--verifiers`): a node `script` (file or
 * inline), `mongo`, `temporal`, `http`. `exportable` ones have a Playwright
 * translation (a node file verifier runs in the test's node context); the
 * rest cannot run in an export at all.
 */
interface InfraVerifier {
  kind: string;
  /** Env vars that must be present for the verifier to run. */
  env: string[];
  /** The export can run it when the env is present. */
  exportable: boolean;
  /** Why it cannot run when it is not exportable. */
  reason?: string;
}

function classifyInfraVerifier(
  v: Verifier,
  ctx: EmitCtx,
): InfraVerifier | undefined {
  const extra = [...(ctx.gateEnv ?? [])];
  const merged = (names: Iterable<string>): string[] =>
    [...new Set([...names, ...extra])].toSorted();
  if (isScriptVerifier(v) && v.script.runtime === "node") {
    const file = v.script.file;
    const envNames = new Set<string>();
    collectEnvRefs(v.script.fixtures ?? {}, envNames);
    if (file && ctx.specDir) {
      return {
        kind: "node verifier",
        env: merged(envNames),
        exportable: true,
      };
    }
    return {
      kind: "node verifier",
      env: merged(envNames),
      exportable: false,
      reason: file
        ? "script.file cannot be located (no spec directory)"
        : "an inline runtime: node script has no Playwright translation",
    };
  }
  if (isMongoVerifier(v)) {
    return {
      kind: "mongo verifier",
      env: merged(ctx.datasourceEnv?.[v.mongo.source] ?? []),
      exportable: false,
      reason: `it queries config datasource "${v.mongo.source}", which only cairn run can open`,
    };
  }
  if (isTemporalVerifier(v)) {
    return {
      kind: "temporal verifier",
      env: merged(ctx.datasourceEnv?.[v.temporal.source] ?? []),
      exportable: false,
      reason: `it reads config datasource "${v.temporal.source}", which only cairn run can open`,
    };
  }
  if (isHttpVerifier(v)) {
    const env = merged(
      v.http.source ? (ctx.datasourceEnv?.[v.http.source] ?? []) : [],
    );
    const known = !v.http.source || ctx.httpDatasources?.[v.http.source];
    return {
      kind: "http verifier",
      env,
      exportable: Boolean(known),
      reason: `it calls config datasource "${v.http.source}", which is not an http datasource of the export environment`,
    };
  }
  return undefined;
}

/** `${env.X}` / `${secrets.X}` (no default) names a value carries. */
function collectEnvRefs(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    for (const part of parseTemplateValue(value)) {
      if (part.kind === "env") into.add(part.name);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvRefs(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectEnvRefs(item, into);
  }
}

/** `--verifiers drop`: the outcome is omitted; the report says so. */
function dropInfraOutcome(
  outcome: Outcome,
  infra: InfraVerifier,
  ctx: EmitCtx,
): Rendered {
  const reason = `${infra.kind} omitted by --verifiers drop: the test can pass without it`;
  addRisk(ctx, "verifierDropped", reason, outcome.id);
  return skipStmt(
    ctx,
    "outcome",
    reason,
    `${infra.kind} dropped (--verifiers drop) — verify it with cairn run`,
    outcome.id,
    true,
  );
}

/**
 * `--verifiers gate`: run the verifier only when its required env is
 * present; otherwise record it in `cairnSkipped`, which ends the test with
 * `test.skip(...)` after every other assertion held (reported skipped, never
 * passed). A verifier that cannot run in an export at all is always recorded.
 */
function renderGatedOutcome(
  outcome: Outcome,
  infra: InfraVerifier,
  ctx: EmitCtx,
): Rendered {
  ctx.gated = true;
  const id = JSON.stringify(outcome.id);
  const needs = infra.env.length > 0 ? ` (needs ${infra.env.join(", ")})` : "";
  if (!infra.exportable) {
    const reason = `${infra.kind} not run in this export: ${infra.reason}${needs}`;
    addRisk(
      ctx,
      "verifierGated",
      `${reason}; the test is reported skipped, never passed`,
      outcome.id,
    );
    skip(ctx, "outcome", reason, outcome.id, true);
    return {
      stmts: [
        comment(`${oneLine(reason)} — recorded as skipped (--verifiers gate)`),
        raw(
          `cairnSkipped.push(${JSON.stringify(`${outcome.id}: ${infra.reason}${needs}`)});`,
        ),
      ],
      exported: false,
    };
  }
  const body = withSpliceSources(ctx, NO_SPLICE, () =>
    renderOutcomeBody(outcome, ctx),
  );
  if (infra.env.length === 0) {
    skip(
      ctx,
      "outcome",
      `--verifiers gate: no required env is known for ${infra.kind} ${outcome.id}, so it always runs (name the env it needs with --gate-env)`,
      outcome.id,
      true,
    );
    return body;
  }
  addRisk(
    ctx,
    "verifierGated",
    `${infra.kind} runs only when ${infra.env.join(", ")} ${
      infra.env.length === 1 ? "is" : "are"
    } set; otherwise the test is reported skipped, never passed`,
    outcome.id,
  );
  return {
    stmts: [
      braces([
        raw(
          `const cairnMissing = ${JSON.stringify(infra.env)}.filter((name) => !process.env[name]);`,
        ),
        ifElse(
          `cairnMissing.length > 0`,
          [
            raw(
              `cairnSkipped.push(${id} + ": needs " + cairnMissing.join(", "));`,
            ),
          ],
          body.stmts,
        ),
      ]),
    ],
    exported: body.exported,
  };
}

function renderOutcomeBody(outcome: Outcome, ctx: EmitCtx): Rendered {
  const v = outcome.verify;
  if (isTextVerifier(v))
    return {
      stmts: renderTextOutcome(v.text, textVerifierRegion(v), false, ctx),
      exported: true,
    };
  if (isNotTextVerifier(v))
    return {
      stmts: renderTextOutcome(v.notText, notTextVerifierRegion(v), true, ctx),
      exported: true,
    };
  if (isUrlVerifier(v))
    return { stmts: renderUrlOutcome(v.url, ctx), exported: true };
  if (isCountVerifier(v))
    return { stmts: renderCountOutcome(v, ctx), exported: true };
  if (isNetworkVerifier(v)) {
    // A body / count / assign needs the request bodies: judged over the
    // rich request log by the runner's own network judge.
    if (ctx.richNetwork) return renderNetworkJudged(v, outcome, ctx);
    return { stmts: renderNetworkOutcome(v, ctx), exported: true };
  }
  if (isNoFailedRequestsVerifier(v)) {
    // The runner's predicate over the request log (network errors included).
    return renderNoFailedRequestsJudged(v, ctx);
  }
  if (isConsoleVerifier(v))
    return {
      stmts: [
        raw(
          `expect(consoleErrors.length).toBeLessThanOrEqual(${v.console.errorsMax});`,
        ),
      ],
      exported: true,
    };
  if (isScriptVerifier(v)) return renderScriptOutcome(v, outcome.id, ctx);
  if (isHttpJsonVerifier(v)) return renderHttpJsonOutcome(v, outcome.id, ctx);
  if (isTableVerifier(v)) return renderTableOutcome(v, ctx);
  if (isValueVerifier(v)) return renderValueOutcome(v, outcome, ctx);
  if (isHttpVerifier(v)) return renderHttpOutcome(v, outcome, ctx);
  if (isFileVerifier(v)) return renderFileOutcome(v, ctx);
  if (isXlsxVerifier(v)) return renderXlsxOutcome(v, outcome, ctx);
  const dataSkip = dataVerifierSkipReason(v);
  if (dataSkip) {
    return skipStmt(ctx, "outcome", dataSkip, oneLine(dataSkip), outcome.id);
  }
  return skipStmt(
    ctx,
    "outcome",
    `unhandled verifier kind: ${Object.keys(v).join(",")}`,
    `unhandled verifier kind for ${JSON.stringify(Object.keys(v))}`,
    outcome.id,
  );
}

function renderTextOutcome(
  m: TextMatcher,
  region: string,
  negated: boolean,
  ctx: EmitCtx,
): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const target =
    region === "page" ? `page.locator("body")` : `page.locator(${str(region)})`;
  const not = negated ? ".not" : "";
  if (m.equals !== undefined) {
    return [
      raw(
        `await expect(${target})${not}.toHaveText(${str(m.equals)}, ${renderTextAssertionOptions(m.caseSensitive ?? false)});`,
      ),
    ];
  }
  if (m.contains !== undefined) {
    return [
      raw(
        `await expect(${target})${not}.toContainText(${str(m.contains)}, ${renderTextAssertionOptions(m.caseSensitive ?? false)});`,
      ),
    ];
  }
  if (m.matches !== undefined) {
    return [
      raw(
        `await expect(${target})${not}.toHaveText(new RegExp(${str(m.matches)}));`,
      ),
    ];
  }
  return [comment(`invalid text matcher`)];
}

function renderTextAssertionOptions(caseSensitive: boolean): string {
  return `{ ignoreCase: ${!caseSensitive}, useInnerText: true }`;
}

function renderUrlOutcome(m: UrlMatcher, ctx: EmitCtx): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  if (m.equals !== undefined) {
    return [raw(`await expect(page).toHaveURL(${str(m.equals)});`)];
  }
  if (m.startsWith !== undefined) {
    return [
      raw(
        `await expect(page).toHaveURL(new RegExp(${emitEscapedRegexSource("^", m.startsWith, "", ctx.usage)}));`,
      ),
    ];
  }
  if (m.endsWith !== undefined) {
    return [
      raw(
        `await expect(page).toHaveURL(new RegExp(${emitEscapedRegexSource("", m.endsWith, "$", ctx.usage)}));`,
      ),
    ];
  }
  if (m.matches !== undefined) {
    return [
      raw(`await expect(page).toHaveURL(new RegExp(${str(m.matches)}));`),
    ];
  }
  return [comment(`invalid url matcher`)];
}

function renderCountOutcome(v: CountVerifier, ctx: EmitCtx): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const c = v.count;
  let target: string;
  const base = c.in_region ? `page.locator(${str(c.in_region)})` : `page`;
  if (c.selector) {
    target = `${base}.locator(${str(c.selector)})`;
  } else if (c.role) {
    target = `${base}.getByRole(${JSON.stringify(c.role)})`;
  } else {
    return [comment(`count verifier requires role/selector`)];
  }
  if (c.equals !== undefined) {
    return [raw(`await expect(${target}).toHaveCount(${c.equals});`)];
  }
  if (c.atLeast !== undefined) {
    return [
      raw(
        `expect(await ${target}.count()).toBeGreaterThanOrEqual(${c.atLeast});`,
      ),
    ];
  }
  if (c.atMost !== undefined) {
    return [
      raw(`expect(await ${target}.count()).toBeLessThanOrEqual(${c.atMost});`),
    ];
  }
  if (c.between !== undefined) {
    const [lo, hi] = c.between;
    return [
      braces([
        raw(`const n = await ${target}.count();`),
        raw(`expect(n).toBeGreaterThanOrEqual(${lo});`),
        raw(`expect(n).toBeLessThanOrEqual(${hi});`),
      ]),
    ];
  }
  return [comment(`invalid count matcher`)];
}

function renderNetworkOutcome(v: NetworkVerifier, ctx: EmitCtx): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const n = v.network;
  const conds: string[] = [];
  if (n.method) conds.push(`r.method === ${JSON.stringify(n.method)}`);
  conds.push(`r.url.includes(${str(n.urlContains)})`);
  const s = n.status;
  if (s?.equals !== undefined) conds.push(`r.status === ${s.equals}`);
  else if (s?.below !== undefined) conds.push(`(r.status ?? 0) < ${s.below}`);
  else if (s?.atLeast !== undefined)
    conds.push(`(r.status ?? 0) >= ${s.atLeast}`);
  else if (s?.in !== undefined)
    conds.push(`[${s.in.join(", ")}].includes(r.status ?? -1)`);
  return [
    raw(`expect(requests.some((r) => ${conds.join(" && ")})).toBe(true);`),
  ];
}

function renderScriptOutcome(
  v: import("../schema/verifier.v1").ScriptVerifier,
  outcomeId: string,
  ctx: EmitCtx,
): Rendered {
  if (v.script.runtime === "node" && v.script.file && ctx.specDir) {
    if (!ctx.nodeVerifierRunDir || !ctx.nodeVerifierEvidence) {
      return skipStmt(
        ctx,
        "outcome",
        "node verifier runDir evidence runtime unavailable",
        `node verifier skipped — export must provide a sanitized runDir`,
        outcomeId,
      );
    }
    // Playwright tests already run in node and its loader transpiles TS
    // imports, so a `runtime: node` file verifier is directly executable:
    // import the module and call its `verify(ctx)` entry with the same ctx
    // shape the Cairntrace runner passes (fixtures/vars/specDir; artifacts
    // and runDir have no Playwright equivalent and are left empty).
    const abs = isAbsolute(v.script.file)
      ? v.script.file
      : resolve(ctx.specDir, v.script.file);
    // Portable import: project prefix (copied verifiers) > relative to the
    // generated file > absolute machine-local path.
    const importPath = nodeModuleImportPath(abs, ctx);
    return {
      stmts: [
        braces([
          comment(
            `node verifier (runs in the test's node context, not the browser)`,
          ),
          raw(
            `await ${ctx.nodeVerifierEvidence}.persist(${ctx.nodeVerifierRunDir});`,
          ),
          ...(ctx.libImportPrefix
            ? (markLib(ctx, "verifier", "loadCairnVerifier"),
              [
                raw(
                  `const verify = await loadCairnVerifier(await import(${JSON.stringify(importPath)}));`,
                ),
              ])
            : [
                raw(
                  `const importedVerifier = await import(${JSON.stringify(importPath)});`,
                ),
                comment(
                  `ESM/CJS interop: Playwright transpiles TS imports to CJS, so a`,
                ),
                comment(
                  `default export may surface as namespace.default.default.`,
                ),
                raw(
                  `const verifierNamespace = importedVerifier${
                    ctx.lang === "ts"
                      ? " as unknown as { verify?: unknown; default?: unknown }"
                      : ""
                  };`,
                ),
                raw(`const verifierDefault = verifierNamespace.default;`),
                raw(
                  `const verifierDefaultNamespace = verifierDefault && typeof verifierDefault === "object"`,
                ),
                raw(
                  `  ? verifierDefault${
                    ctx.lang === "ts"
                      ? " as { verify?: unknown; default?: unknown }"
                      : ""
                  }`,
                ),
                raw(`  : undefined;`),
                raw(`const verify =`),
                raw(`  verifierNamespace.verify ??`),
                raw(`  (typeof verifierDefault === "function"`),
                raw(`    ? verifierDefault`),
                raw(
                  `    : (verifierDefaultNamespace?.verify ?? verifierDefaultNamespace?.default));`,
                ),
                block(`if (typeof verify !== "function") {`, [
                  raw(
                    `throw new Error("verifier module must export a verify() function");`,
                  ),
                ]),
              ]),
          block(
            `const res = await verify({`,
            [
              raw(
                `fixtures: ${withSpliceSources(ctx, ALL_SPLICE, () =>
                  emitValue(v.script.fixtures ?? {}, ctx.usage),
                )},`,
              ),
              raw(`artifacts: {},`),
              raw(`vars: {},`),
              raw(`runDir: ${ctx.nodeVerifierRunDir},`),
              raw(
                `specDir: ${ctx.specDirExpr ?? JSON.stringify(ctx.specDir)},`,
              ),
            ],
            `});`,
          ),
          raw(
            `expect(res && res.ok, \`verifier evidence: \${JSON.stringify(res && (res.evidence ?? res))}\`).toBe(true);`,
          ),
        ]),
      ],
      exported: true,
    };
  }
  if (v.script.runtime !== "node" && v.script.file && ctx.specDir) {
    const abs = isAbsolute(v.script.file)
      ? v.script.file
      : resolve(ctx.specDir, v.script.file);
    const loaded = loadBrowserVerifierSource(abs);
    if (loaded.error) {
      return skipStmt(
        ctx,
        "outcome",
        `script.file ${v.script.file} not inlined: ${loaded.error}`,
        `browser verifier file could not be embedded. Keep the Cairntrace spec as the source of truth.`,
        outcomeId,
      );
    }
    return renderBrowserScriptOutcome(v, loaded.source!, ctx);
  }
  if (v.script.runtime === "node" || v.script.file) {
    const reason = v.script.file
      ? `script.file ${v.script.file} not inlined`
      : "script.runtime node (inline source) not exportable";
    return skipStmt(
      ctx,
      "outcome",
      reason,
      `${reason}. Keep the Cairntrace spec as the source of truth.`,
      outcomeId,
    );
  }
  return renderBrowserScriptOutcome(v, v.script.run ?? "", ctx);
}

function renderBrowserScriptOutcome(
  v: import("../schema/verifier.v1").ScriptVerifier,
  source: string,
  ctx: EmitCtx,
): Rendered {
  const asyncFunctionType =
    ctx.lang === "ts"
      ? ` as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>`
      : "";
  const resultType =
    ctx.lang === "ts" ? ` as { ok?: boolean; evidence?: unknown }` : "";
  return {
    stmts: [
      braces([
        block(
          `const result = await page.evaluate(async ({ source, scriptContext }) => {`,
          [
            comment(
              `Verifier source is authored JavaScript, not generated TypeScript.`,
            ),
            raw(
              `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor${asyncFunctionType};`,
            ),
            raw(
              `const execute = new AsyncFunction("fixtures", "artifacts", "vars", "run", source);`,
            ),
            raw(
              `return await execute(scriptContext.fixtures, scriptContext.artifacts, scriptContext.vars, scriptContext.run);`,
            ),
          ],
          `}, { source: ${
            usesCairnPrelude(source)
              ? `${preludeHelper(ctx, "CAIRN_PRELUDE")} + `
              : ""
          }${emitStr(source, ctx.usage, { runtimeRefs: false })}, scriptContext: { "fixtures": ${withSpliceSources(
            ctx,
            ALL_SPLICE,
            () => emitValue(v.script.fixtures ?? {}, ctx.usage),
          )}, "artifacts": {}, "vars": {}, "run": { "failedStep": null, "lastSuccessfulStep": null } } })${resultType};`,
        ),
        raw(`expect(result.ok).toBe(true);`),
      ]),
    ],
    exported: true,
  };
}

function loadBrowserVerifierSource(absolutePath: string): {
  source?: string;
  error?: string;
} {
  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (extname(absolutePath) !== ".ts") return { source };

  const bun = (
    globalThis as typeof globalThis & {
      Bun?: {
        Transpiler?: new (opts: {
          loader: "ts";
        }) => {
          transformSync(source: string): string;
        };
      };
    }
  ).Bun;
  if (!bun?.Transpiler) {
    return {
      error:
        "TypeScript browser verifier transpilation requires Bun.Transpiler",
    };
  }
  try {
    return {
      source: new bun.Transpiler({ loader: "ts" }).transformSync(source),
    };
  } catch (error) {
    return {
      error: `TypeScript transpilation failed: ${(error as Error).message}`,
    };
  }
}

function renderHttpJsonOutcome(
  v: import("../schema/verifier.v1").HttpJsonVerifier,
  _outcomeId: string,
  ctx: EmitCtx,
): Rendered {
  const str = (s: string) => emitStr(s, ctx.usage);
  const h = v.httpJson;
  // The fetch rides the browser context (cookies); the verdict is the
  // runner's own httpJson judge (path walk + equals / contains / matches /
  // atLeast / atMost / exists), embedded as source.
  useData(ctx, "dataHttpJson", "cairnAssertHttpJson");
  const matcher: string[] = [`jsonPath: ${str(h.jsonPath ?? "$")}`];
  for (const key of [
    "equals",
    "contains",
    "matches",
    "atLeast",
    "atMost",
    "exists",
  ] as const) {
    if (h[key] !== undefined) {
      matcher.push(`${key}: ${emitValue(h[key], ctx.usage)}`);
    }
  }
  const body: Stmt[] = [
    raw(
      `const res = await page.request.get(${withSpliceSources(
        ctx,
        HTTP_JSON_URL_SPLICE,
        () => str(h.url),
      )});`,
    ),
    raw(`expect(res.ok()).toBeTruthy();`),
    raw(`const body = ${parseJsonOrText("await res.text()", ctx)};`),
    raw(`cairnAssertHttpJson(body, { ${matcher.join(", ")} });`),
  ];
  return { stmts: [braces(body)], exported: true };
}

/**
 * The `table` verifier: the runner's own in-page probe reads the rendered
 * table (waiting for it to appear), then the same row-count / blank-row /
 * header / required-row checks run in the test.
 */
function renderTableOutcome(
  v: import("../schema/verifier.v1").TableVerifier,
  ctx: EmitCtx,
): Rendered {
  const t = v.table;
  const semantic =
    t.locator.by === "role" ||
    t.locator.by === "label" ||
    t.locator.by === "text";
  const includeHidden =
    !semantic || ("visible" in t.locator && t.locator.visible === false);
  (ctx.usedProbe ??= {}).table = true;
  const options = [
    `timeoutMs: ${t.timeoutMs ?? 5000}`,
    `includeHidden: ${includeHidden}`,
    ...(ctx.testIdAttribute
      ? [`testIdAttribute: ${JSON.stringify(ctx.testIdAttribute)}`]
      : []),
  ].join(", ");
  const spec = {
    ...(t.rows ? { rows: t.rows } : {}),
    ...(t.headers ? { headers: t.headers } : {}),
    ...(t.contains ? { contains: t.contains } : {}),
  };
  return {
    stmts: [
      braces([
        raw(
          `const cairnTable = await cairnReadTable(page, ${emitValue(t.locator, ctx.usage)}, { ${options} });`,
        ),
        raw(
          `expect(cairnJudgeTable(cairnTable, ${emitValue(spec, ctx.usage)}), "table checks").toEqual([]);`,
        ),
      ]),
    ],
    exported: true,
  };
}

/**
 * Datasource / value verifiers read things a generated Playwright
 * test cannot reach (config datasources, Cairntrace runtime values, the
 * runner's table reader): a hard skip with the reason, never a silent drop.
 */
function dataVerifierSkipReason(v: Verifier): string | undefined {
  if (isMongoVerifier(v)) {
    return `mongo verifier not exported: it queries config datasource "${v.mongo.source}"; verify it with cairn run`;
  }
  if (isTemporalVerifier(v)) {
    return `temporal verifier not exported: it reads config datasource "${v.temporal.source}"; verify it with cairn run`;
  }
  if (isProcessVerifier(v)) {
    return "process verifier not exported: it asserts on the process samples of `cairn run --monitor` (CPU / memory of the app processes), which a Playwright test does not collect; verify it with cairn run";
  }
  return undefined;
}

/**
 * The runtime's match pool for an `expect` locator (count / hidden): semantic
 * names match WHOLE-name, whitespace-normalized and case-insensitive
 * (`exact: true`: case-sensitive), and semantic locators count visible
 * matches only (`visibleOnly`); CSS / testid count DOM matches. Plain
 * `getByText("x")` would match substrings and hidden elements.
 */
function expectPoolLocator(
  loc: Locator,
  ctx: EmitCtx,
  visibleOnly: boolean,
): string {
  const str = (s: string) => emitStr(s, ctx.usage);
  const name = (text: string): string =>
    "exact" in loc && loc.exact ? str(text) : wholeNameRegex(text, ctx);
  const exactOpt = "exact" in loc && loc.exact ? ", { exact: true }" : "";
  let base: string;
  switch (loc.by) {
    case "role": {
      const opts: string[] = [];
      if (loc.name) opts.push(`name: ${name(loc.name)}`);
      if (loc.exact && loc.name) opts.push("exact: true");
      if (loc.visible === false) opts.push("includeHidden: true");
      base = `page.getByRole(${JSON.stringify(loc.role)}${
        opts.length > 0 ? `, { ${opts.join(", ")} }` : ""
      })`;
      break;
    }
    case "label":
      base = `page.getByLabel(${name(loc.name)}${exactOpt})`;
      break;
    case "text":
      base = `page.getByText(${name(loc.text)}${exactOpt})`;
      break;
    default:
      base = locatorFromRoot("page", loc, ctx);
  }
  const hasText = "hasText" in loc ? loc.hasText : undefined;
  const semantic = loc.by === "role" || loc.by === "label" || loc.by === "text";
  const visibleFilter =
    visibleOnly && semantic && !("visible" in loc && loc.visible === false)
      ? ".filter({ visible: true })"
      : "";
  return `${base}${
    hasText ? `.filter({ hasText: ${str(hasText)} })` : ""
  }${visibleFilter}`;
}

/** `new RegExp("^\\s*word\\s+word\\s*$", "i")` — whole-name, any whitespace. */
function wholeNameRegex(text: string, ctx: EmitCtx): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const pieces = words.map((word) =>
    emitEscapedRegexSource("", word, "", ctx.usage),
  );
  const literal = pieces.every((piece) => {
    try {
      return typeof JSON.parse(piece) === "string";
    } catch {
      return false;
    }
  });
  const source = literal
    ? JSON.stringify(
        `^\\s*${pieces.map((piece) => JSON.parse(piece) as string).join("\\s+")}\\s*$`,
      )
    : [
        JSON.stringify("^\\s*"),
        pieces.join(` + ${JSON.stringify("\\s+")} + `),
        JSON.stringify("\\s*$"),
      ].join(" + ");
  return `new RegExp(${source}, "i")`;
}

/**
 * A count matcher as a JS predicate over `n` (the match count), with the
 * runtime's semantics; undefined when a key can never hold for a number
 * (contains, all/each, a non-numeric equals) — those are skipped loudly.
 */
function countPredicate(
  matcher: ValueMatcher,
  ctx: EmitCtx,
): string | undefined {
  if (typeof matcher === "number") return `n === ${matcher}`;
  if (matcher === null || typeof matcher !== "object") return undefined;
  const m = matcher;
  const parts: string[] = [];
  if (Object.hasOwn(m, "equals")) {
    if (typeof m.equals !== "number") return undefined;
    parts.push(`n === ${m.equals}`);
  }
  if (Object.hasOwn(m, "contains") || m.all !== undefined) return undefined;
  if (m.each !== undefined) return undefined;
  if (m.exists === false) parts.push("false");
  if (m.empty === true) parts.push("false");
  if (m.oneOf !== undefined) {
    parts.push(`${JSON.stringify(m.oneOf)}.includes(n)`);
  }
  if (m.matches !== undefined) {
    parts.push(
      `new RegExp(${emitStr(m.matches, ctx.usage)}${
        m.ignoreCase ? ', "i"' : ""
      }).test(String(n))`,
    );
  }
  if (m.atLeast !== undefined) parts.push(`n >= ${m.atLeast}`);
  if (m.atMost !== undefined) parts.push(`n <= ${m.atMost}`);
  return parts.length > 0 ? parts.join(" && ") : "true";
}

/**
 * `expect` step → Playwright web-first assertions (auto-retrying within the
 * step's timeoutMs). An assertion that cannot be rendered (`expect.request`,
 * `count` with `near`, a count matcher that never holds for a number) is a
 * HARD skip with a comment in the generated test — never a silent drop.
 */
function renderExpectStep(step: ExpectStep, ctx: EmitCtx): Rendered {
  const e = step.expect;
  if ("request" in e) return renderExpectRequestStep(step, ctx);
  const str = (s: string) => emitStr(s, ctx.usage);
  const loc = expectLocator(e) as Locator;
  const timeout = e.timeoutMs ?? 5000;
  const target = locator(loc, ctx);
  const near = "near" in loc ? loc.near : undefined;
  const stmts: Stmt[] = [];
  const skipped: string[] = [];
  const opts = `{ timeout: ${timeout} }`;
  if (e.visible === true || e.hidden === false) {
    stmts.push(raw(`await expect(${target}).toBeVisible(${opts});`));
  }
  if (e.hidden === true || e.visible === false) {
    if (near) {
      stmts.push(raw(`await expect(${target}).toBeHidden(${opts});`));
    } else {
      stmts.push(
        raw(
          `await expect(${expectPoolLocator(loc, ctx, false)}.filter({ visible: true })).toHaveCount(0, ${opts});`,
        ),
      );
    }
  }
  if (e.count !== undefined) {
    const c = e.count;
    const pool = near ? undefined : expectPoolLocator(loc, ctx, true);
    const numericKeys =
      c !== null &&
      typeof c === "object" &&
      Object.keys(c).length > 0 &&
      Object.keys(c).every((key) =>
        ["equals", "atLeast", "atMost"].includes(key),
      ) &&
      Object.values(c).every((value) => typeof value === "number");
    const predicate = countPredicate(c, ctx);
    if (!pool) {
      skipped.push(`count ${describeMatcher(c)} with near`);
    } else if (typeof c === "number") {
      stmts.push(raw(`await expect(${pool}).toHaveCount(${c}, ${opts});`));
    } else if (numericKeys) {
      const m = c as { equals?: number; atLeast?: number; atMost?: number };
      const poll = `await expect.poll(async () => ${pool}.count(), ${opts})`;
      if (m.equals !== undefined) stmts.push(raw(`${poll}.toBe(${m.equals});`));
      if (m.atLeast !== undefined) {
        stmts.push(raw(`${poll}.toBeGreaterThanOrEqual(${m.atLeast});`));
      }
      if (m.atMost !== undefined) {
        stmts.push(raw(`${poll}.toBeLessThanOrEqual(${m.atMost});`));
      }
    } else if (predicate !== undefined) {
      const message = JSON.stringify(
        humanizeSentinels(`count ${describeMatcher(c)}`),
      );
      stmts.push(
        raw(
          `await expect.poll(async () => { const n = await ${pool}.count(); return ${predicate}; }, { message: ${message}, timeout: ${timeout} }).toBe(true);`,
        ),
      );
    } else {
      skipped.push(`count ${describeMatcher(c)} (never holds for a number)`);
    }
  }
  // `by: text` keeps `text` as its locator, never as an assertion.
  const textAssertion = e.by === "text" ? undefined : e.text;
  if (textAssertion !== undefined) {
    const m =
      typeof textAssertion === "string"
        ? { equals: textAssertion }
        : textAssertion;
    const textOpts = `{ ignoreCase: ${!("caseSensitive" in m && m.caseSensitive === true)}, useInnerText: true, timeout: ${timeout} }`;
    if (m.equals !== undefined) {
      stmts.push(
        raw(
          `await expect(${target}).toHaveText(${str(m.equals)}, ${textOpts});`,
        ),
      );
    } else if (m.contains !== undefined) {
      stmts.push(
        raw(
          `await expect(${target}).toContainText(${str(m.contains)}, ${textOpts});`,
        ),
      );
    } else if (m.matches !== undefined) {
      stmts.push(
        raw(
          `await expect(${target}).toHaveText(new RegExp(${str(m.matches)}), ${opts});`,
        ),
      );
    }
  }
  if (e.value !== undefined) {
    const m = typeof e.value === "string" ? { equals: e.value } : e.value;
    const expected =
      m.equals !== undefined
        ? str(m.equals)
        : m.contains !== undefined
          ? `new RegExp(${emitEscapedRegexSource("", m.contains, "", ctx.usage)})`
          : `new RegExp(${str(m.matches!)})`;
    stmts.push(
      raw(`await expect(${target}).toHaveValue(${expected}, ${opts});`),
    );
  }
  if (e.attribute !== undefined) {
    const a = e.attribute;
    if (a.exists !== undefined) {
      stmts.push(
        raw(
          `await expect(${target})${
            a.exists ? "" : ".not"
          }.toHaveAttribute(${str(a.name)}, ${opts});`,
        ),
      );
    } else {
      const expected =
        a.equals !== undefined
          ? str(a.equals)
          : a.contains !== undefined
            ? `new RegExp(${emitEscapedRegexSource("", a.contains, "", ctx.usage)})`
            : `new RegExp(${str(a.matches!)})`;
      stmts.push(
        raw(
          `await expect(${target}).toHaveAttribute(${str(a.name)}, ${expected}, ${opts});`,
        ),
      );
    }
  }
  if (e.enabled !== undefined) {
    stmts.push(
      raw(
        `await expect(${target}).${
          e.enabled ? "toBeEnabled" : "toBeDisabled"
        }(${opts});`,
      ),
    );
  }
  const exported = stmts.length > 0;
  if (skipped.length > 0) {
    // A dropped mid-flow assertion would let the export pass where
    // `cairn run` fails: hard skip (test.fixme) and say so in the code.
    skip(
      ctx,
      "step",
      `expect ${skipped.join(", ")} not exported — verify with cairn run`,
      step.id,
    );
    stmts.push(
      comment(
        `expect ${humanizeSentinels(skipped.join(", "))} not exported — verify with cairn run`,
      ),
    );
  }
  return { stmts, exported };
}

/** Emit a ./-prefixed POSIX relative path for a dynamic import. */
function toRelativeImport(fromDir: string, absTarget: string): string {
  const rel = relative(fromDir, absTarget).replaceAll("\\", "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/* ----- helpers ----- */

function one(stmt: Stmt): Rendered {
  return { stmts: [stmt], exported: true };
}

export function oneLine(s: string): string {
  return s.replaceAll(/\s+/g, " ").trim();
}

export function safeIdent(name: string): string {
  return toIdent(name);
}

/**
 * Names generated modules already bind at module or test scope (Playwright's
 * `test` / `expect`, fixtures, node:path / node:url imports, globals and
 * reserved words): an action module's function is never one of them.
 */
const RESERVED_IDENTS = new Set([
  "test",
  "expect",
  "page",
  "request",
  "context",
  "browser",
  "testInfo",
  "vars",
  "runToken",
  "join",
  "resolve",
  "dirname",
  "fileURLToPath",
  "process",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "console",
  "Promise",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Error",
  "RegExp",
  "Date",
  "Math",
  "URL",
  "Buffer",
  "setTimeout",
  "arguments",
  "eval",
  "undefined",
  "NaN",
  "Infinity",
  "await",
  "async",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** An action module's function name: its identifier, suffixed when it would shadow a binding the generated code uses (`page` → `pageAction`). */
export function actionIdent(name: string): string {
  const ident = toIdent(name);
  return RESERVED_IDENTS.has(ident) || /^cairn[A-Z_]/.test(ident)
    ? `${ident}Action`
    : ident;
}

/** Used by tests + the CLI to know whether a verifier type is exportable. */
export function isExportable(v: Verifier): boolean {
  return (
    isTextVerifier(v) ||
    isNotTextVerifier(v) ||
    isUrlVerifier(v) ||
    isCountVerifier(v) ||
    isNetworkVerifier(v) ||
    isNoFailedRequestsVerifier(v) ||
    isConsoleVerifier(v) ||
    isScriptVerifier(v) ||
    isHttpJsonVerifier(v) ||
    isTableVerifier(v) ||
    isValueVerifier(v) ||
    isHttpVerifier(v) ||
    isFileVerifier(v) ||
    isXlsxVerifier(v)
  );
}

/** Extension for the generated Playwright file. */
export function exportExtension(lang: ExportLang): string {
  return lang === "js" ? ".spec.js" : ".spec.ts";
}

/**
 * Runtime refs a spec will actually splice in exported code: steps plus the
 * outcomes the exporter renders (skipped verifier kinds never read bindings,
 * and binding for them would leave unused locals).
 */
/** Step kinds the exporter always renders as a skip comment. */
function isNeverExportedStep(step: Step, hostCommands: boolean): boolean {
  return (
    ("run" in step && !hostCommands) || "monitor" in step || "snapshot" in step
  );
}

export function referencedRuntimeRefs(
  spec: Spec,
  opts: { hostCommands?: boolean; verifiers?: ExportVerifiersMode } = {},
): Set<string> {
  // Steps the export always skips never read a binding: counting their refs
  // would declare a binding nothing reads (noUnusedLocals fails the export).
  // F14: nested steps count too (each control step for its own fields).
  const hostCommands = opts.hostCommands === true;
  const keys = collectRuntimeRefKeys(
    [
      ...walkSteps(spec.steps ?? []),
      // An exported teardown reads bindings like any other step list.
      ...(hostCommands ? walkSteps(teardownPlan(spec.teardown).steps) : []),
    ]
      .filter((step) => !isNeverExportedStep(step, hostCommands))
      .map(ownStepFields),
  );
  // Data verifiers and expect.request resolve references through a typed
  // scope: the bindings they read must be produced (and hoisted).
  dataRefKeys(spec, {
    verifiers: opts.verifiers,
    includeSteps: true,
  }).forEach((key) => keys.add(key));
  for (const outcome of spec.outcomes) {
    const v = outcome.verify;
    if (isScriptVerifier(v)) {
      // Inline `runtime: node` scripts are skipped, so never read bindings;
      // `--verifiers drop` omits the node file ones.
      if (
        v.script.runtime !== "node" ||
        (v.script.file !== undefined && opts.verifiers !== "drop")
      ) {
        collectRuntimeRefKeys(v.script.fixtures ?? {}, keys);
      }
    } else if (isHttpJsonVerifier(v)) {
      for (const key of collectRuntimeRefKeys(v.httpJson.url)) {
        if (HTTP_JSON_URL_SPLICE.has(key.split(":")[0] as RuntimeRefSource)) {
          keys.add(key);
        }
      }
    }
  }
  return keys;
}
