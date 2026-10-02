import type {
  CountVerifier,
  NetworkVerifier,
  NoFailedRequestsVerifier,
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
  Locator,
  NetworkPostcondition,
  Outcome,
  Spec,
  Step,
  WhenObject,
} from "../schema/spec.v1";
import { clickLocator, withoutPostcondition } from "../schema/spec.v1";
// F4/F5/F16 export coverage: datasource/value/table verifiers, poll, expect/capture.
import type { ExpectStep } from "../schema/spec.v1";
import type { ValueMatcher } from "../schema/verifier.v1";
import {
  isHttpVerifier,
  isMongoVerifier,
  isTableVerifier,
  isTemporalVerifier,
  isValueVerifier,
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
import { gateRefList } from "../gates/schema";
import {
  blank,
  block,
  braces,
  comment,
  iff,
  print,
  raw,
  tryCatch,
  verbatim,
  type Stmt,
} from "./codegen";
import {
  assertNoLateBoundLeak,
  collectRuntimeRefKeys,
  emitEscapedRegexSource,
  emitNormalizedText,
  emitStr,
  emitValue,
  hasSecretSentinel,
  humanizeSentinels,
  newRefUsage,
  parseTemplateValue,
  runtimeRefKey,
  toIdent,
  type RefUsage,
  type RuntimeRefSource,
} from "./templateValue";
import {
  isDocumentaryPrecondition,
  playwrightTestTimeoutBudget,
  timeoutBudgetComment,
} from "./playwrightTimeout";
import {
  renderSpliceHelperLines,
  type PlaywrightLibModule,
} from "./playwrightRuntime";

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
 *    environment policy refuses the spec, so the test always skips.
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
  | "envPolicy";

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
}

export interface ExportPlaywrightResult {
  source: string;
  lang: ExportLang;
  coverage: ExportCoverage;
  /** Env var names the generated test reads at runtime (late-bound secrets). */
  requiredEnv: string[];
  /** Preconditions that must run before the test (not exportable to Playwright). */
  preconditions: string[];
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
  const ctx: EmitCtx = {
    lang,
    coverage,
    usage: newRefUsage(),
    ...(opts.sourcePath ? { specDir: dirname(resolve(opts.sourcePath)) } : {}),
    ...(opts.stepOrigins ? { stepOrigins: opts.stepOrigins } : {}),
    ...(opts.outPath ? { outDir: dirname(resolve(opts.outPath)) } : {}),
    postconditionCounter: 0,
    referencedRefs: referencedRuntimeRefs(spec),
    produced: new Map(),
  };
  const timeoutBudget = playwrightTestTimeoutBudget(spec);
  const needsNodeVerifierEvidence =
    ctx.specDir !== undefined && hasNodeFileVerifier(spec);
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

  body.push(...renderOutcomeEvidenceSetup(spec, lang));
  const bindingsInsertAt = body.length;

  if (steps.length > 0) {
    body.push(comment(`--- steps ---`));
    steps.forEach((step, index) => {
      ctx.stepIndex = index;
      const rendered = renderStep(step, spec.settleMs, ctx);
      if (rendered.exported) coverage.stepsExported += 1;
      body.push(...rendered.stmts);
    });
    delete ctx.stepIndex;
    body.push(blank);
  }

  body.push(comment(`--- outcomes (the contract) ---`));
  for (const outcome of spec.outcomes) {
    body.push(comment(`${outcome.id}: ${oneLine(outcome.description)}`));
    const rendered = renderOutcome(outcome, ctx);
    if (rendered.exported) coverage.outcomesExported += 1;
    body.push(...rendered.stmts, blank);
  }

  body.splice(bindingsInsertAt, 0, ...renderBindingDeclarations(ctx));
  if (needsNodeVerifierEvidence) {
    body.splice(
      evidenceInsertAt,
      0,
      ...renderNodeVerifierEvidenceSetup(spec, ctx),
    );
  }

  // ----- file assembly -----
  const file: Stmt[] = [];
  const envNames = [...ctx.usage.envNames].toSorted();
  if (envNames.length > 0) {
    file.push(
      comment(
        `Secrets are NOT inlined — set before running: ${envNames.join(", ")}`,
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

  const preCommands = (spec.preconditions?.commands ?? []).map((c) =>
    typeof c === "string" ? { run: c } : c,
  );
  const executablePreconditions = preCommands.filter(
    (c) => !isDocumentaryPrecondition(c.run),
  );
  const preconditionLines: string[] = [];
  if (preCommands.length > 0) {
    // Preconditions run OUTSIDE the browser (shell/mongo resets, pipeline
    // gates) and have no Playwright equivalent here — surface them so a CI
    // wrapper (globalSetup or a shell step) can run them before the test.
    // `--project` runs them in each file's beforeAll instead.
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
        `${executablePreconditions.length} precondition command(s) must run before this test (single-file export does not execute them; use --project to run them in beforeAll)`,
        "preconditions",
      );
    }
    file.push(
      comment(``),
      comment(
        `⚠ PRECONDITIONS (NOT exported — run these before the test, e.g. in globalSetup):`,
      ),
    );
    for (const c of preCommands) {
      const line = humanizeSentinels(
        `${c.name ? `[${c.name}] ` : ""}${oneLine(c.run).slice(0, 160)}`,
      );
      preconditionLines.push(line);
      file.push(comment(`  ${line}`));
    }
  }
  addSpecRisks(
    spec,
    ctx,
    opts.sourcePath ? { sourceText: readSourceText(opts.sourcePath) } : {},
  );

  const usesExpect = usesExpectCall(print(body));
  file.push(
    blank,
    raw(
      `import { ${usesExpect ? "expect, " : ""}test } from "@playwright/test";`,
    ),
  );
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
    preconditions: preconditionLines,
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
  return source
    .split("\n")
    .some((line) => /^(?:return\s+)?(?:await\s+)?expect[.(]/.test(line.trim()));
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
  if (fixtureNames.length > 0) {
    skip(
      ctx,
      "step",
      `fixtures not exported (${fixtureNames.join(", ")}): the export does not ensure them, so \${fixtures.…} outputs stay literal — verify with cairn run`,
      "fixtures",
    );
    addRisk(
      ctx,
      "requiredSetup",
      `fixtures ${fixtureNames.join(", ")} must exist before this test (\`cairn fixtures ensure <name>\`); the export neither ensures nor tears them down`,
      "fixtures",
    );
  }
  const teardown = Array.isArray(spec.teardown)
    ? spec.teardown
    : (spec.teardown?.steps ?? []);
  if (teardown.length > 0) {
    skip(
      ctx,
      "step",
      `teardown not exported (${teardown.length} item(s)): its cleanup only runs under cairn run`,
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
  if (gateNames.length > 0) {
    skip(
      ctx,
      "step",
      `preconditions.wait not exported (${gateNames.join(", ")}): wait for readiness before the suite (\`cairn wait <gate>\`)`,
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
  const steps = spec.steps ?? [];
  const evalSteps = steps.filter((step) => "eval" in step).length;
  if (evalSteps > 0) {
    const ratio = evalSteps / steps.length;
    addRisk(
      ctx,
      "evalRatio",
      `${evalSteps}/${steps.length} step(s) (${Math.round(ratio * 100)}%) are eval — opaque page JavaScript that needs bypassCSP and cannot be reviewed as Playwright actions`,
    );
  }
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

/** Hoisted `let` declarations for the runtime bindings a scope produced. */
export function renderBindingDeclarations(ctx: EmitCtx): Stmt[] {
  const produced = [...(ctx.produced ?? new Map<string, string>()).values()];
  if (produced.length === 0) return [];
  const type = ctx.lang === "ts" ? ": unknown" : "";
  return [
    comment(
      `Values captured by request/eval/download \`assign:\` for later \${…} splices.`,
    ),
    ...produced.map((ident) => raw(`let ${ident}${type};`)),
    blank,
  ];
}

export function hasNodeFileVerifier(spec: Spec): boolean {
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

  if (needsNetwork) {
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
      raw(
        `page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });`,
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

interface Rendered {
  stmts: Stmt[];
  /** True when at least one executable Playwright statement was produced. */
  exported: boolean;
}

export function coverageHasHardSkip(coverage: ExportCoverage): boolean {
  return coverage.skips.some((entry) => !entry.soft);
}

function skip(
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

function skipStmt(
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
function wantsBinding(ctx: EmitCtx, key: string): boolean {
  return Boolean(ctx.bindAllProduced || ctx.referencedRefs?.has(key));
}

/** Reserve (or reuse) the hoisted identifier for a produced runtime binding. */
function declareBinding(ctx: EmitCtx, key: string, preferred: string): string {
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
function publishBinding(ctx: EmitCtx, key: string, ident: string): void {
  ctx.usage.bindings.set(key, ident);
}

/** Inline parse of a body string the way the runner stores captured bodies. */
function parseJsonOrText(expr: string, ctx: EmitCtx): string {
  const asUnknown = ctx.lang === "ts" ? " as unknown" : "";
  return `((text) => { if (text === null || text === undefined) return null; try { return JSON.parse(text)${asUnknown}; } catch { return text; } })(${expr})`;
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
    if (when.urlContains !== undefined) {
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
          `cairnRequests_${toIdent(postcondition.assign!)}`,
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
    if (step.click.until && !suppressMutationRetries) {
      return renderClickUntilStep(step, settleMs, ctx);
    }
    const stmts: Stmt[] = [
      raw(`await ${locator(clickLocator(step), ctx)}.click();`),
    ];
    if (settleMs !== undefined && settleMs > 0) {
      stmts.push(
        raw(
          `await page.waitForLoadState("networkidle", { timeout: ${settleMs} });`,
        ),
      );
    }
    return { stmts, exported: true };
  }
  if ("hover" in step) {
    return one(raw(`await ${locator(step.hover, ctx)}.hover();`));
  }
  if ("focus" in step) {
    return one(raw(`await ${locator(step.focus, ctx)}.focus();`));
  }
  if ("fill" in step) {
    const { value, ...loc } = step.fill;
    const target = locator(loc as Locator, ctx);
    const emittedValue = str(value);
    if (suppressMutationRetries || step.verifyFill === false) {
      return one(raw(`await ${target}.fill(${emittedValue});`));
    }
    return renderVerifiedInput(target, emittedValue, "fill", "", ctx);
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
    // A transform produces the artifact later steps upload/verify; without
    // it the test cannot be faithful, so this is a HARD skip (test.fixme).
    return skipStmt(
      ctx,
      "step",
      `transform step not exportable (${step.transform.file})`,
      `transform step skipped — Cairntrace runs ${JSON.stringify(step.transform.file)} in Node`,
      step.id,
    );
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
  if ("wait" in step) {
    const w = step.wait;
    if ("ms" in w) {
      return one(
        raw(`await new Promise((resolve) => setTimeout(resolve, ${w.ms}));`),
      );
    }
    const timeout = "timeoutMs" in w ? (w.timeoutMs ?? 30_000) : 30_000;
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
      return one(
        raw(
          `await expect.poll(async () => ${text}.includes(${needle}), { timeout: ${timeout} }).toBe(${expected});`,
        ),
      );
    }
    if ("selector" in w) {
      if (w.hasText) {
        return one(
          raw(
            `await expect(page.locator(${str(w.selector)}).filter({ hasText: ${str(w.hasText)} })).not.toHaveCount(0, { timeout: ${timeout} });`,
          ),
        );
      }
      const state = w.state ?? "visible";
      return one(
        raw(
          `await page.waitForSelector(${str(w.selector)}, { timeout: ${timeout}, state: ${JSON.stringify(state)} });`,
        ),
      );
    }
    if ("value" in w) {
      const { equals, ...loc } = w.value;
      return one(
        raw(
          `await expect(${locator(loc as Locator, ctx)}).toHaveValue(${str(equals)}, { timeout: ${timeout} });`,
        ),
      );
    }
    if ("url" in w) {
      const matcher = w.url;
      if (matcher.equals !== undefined) {
        return one(
          raw(
            `await page.waitForURL((url) => url.href === ${str(matcher.equals)}, { timeout: ${timeout} });`,
          ),
        );
      }
      if (matcher.includes !== undefined) {
        return one(
          raw(
            `await page.waitForURL((url) => url.href.includes(${str(matcher.includes)}), { timeout: ${timeout} });`,
          ),
        );
      }
      return one(
        raw(
          `await page.waitForURL(new RegExp(${str(matcher.pattern ?? "")}), { timeout: ${timeout} });`,
        ),
      );
    }
    return one(
      raw(
        `await page.waitForLoadState(${JSON.stringify("load" in w ? w.load : "load")}, { timeout: ${timeout} });`,
      ),
    );
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
    // The command text stays out of the generated code and the report: its
    // substituted placeholders may hold secrets (as in run-step events).
    const target =
      typeof step.run === "string"
        ? "shell command"
        : step.run.node !== undefined
          ? `node ${basename(step.run.node)}`
          : "shell command";
    return skipStmt(
      ctx,
      "step",
      `run step not exported (${target}): host commands run only under cairn run${
        typeof step.run !== "string" && step.run.assign
          ? `; later \${runs.${step.run.assign}…} references stay literal`
          : ""
      }`,
      `run step (${target}) skipped — a host command; run it with cairn run`,
      step.id,
    );
  }
  if ("capture" in step) {
    return skipStmt(
      ctx,
      "step",
      `capture step not exportable (${step.capture.assign}): later \${captures.${step.capture.assign}…} references stay literal`,
      `capture ${oneLine(step.capture.assign)} skipped — Cairntrace stores the value for \${captures.…}; no Playwright equivalent is generated`,
      step.id,
    );
  }
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
  // into the source string in Node before it is sent to the page.
  const sourceExpr = emitStr(js, ctx.usage);
  const key = e.assign ? runtimeRefKey("evals", e.assign) : undefined;
  const bindIdent =
    key && wantsBinding(ctx, key)
      ? declareBinding(ctx, key, `cairnEvals_${toIdent(e.assign!)}`)
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
      ? declareBinding(ctx, key, `cairnRequests_${toIdent(assignName!)}`)
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
        `${ctx.networkRecorder}.push({ url: ${varName}.url(), method: ${JSON.stringify(method)}, status: ${varName}.status() });`,
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
      ? declareBinding(ctx, key, `cairnArtifacts_${toIdent(name!)}`)
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
function stepFilePath(file: string, ctx: EmitCtx, field: string): string {
  if (isAbsolute(file)) return file;
  if (ctx.stepOrigins && ctx.stepIndex !== undefined) {
    return resolveStepFile(
      file,
      stepFileScopeAt(ctx.stepOrigins, ctx.stepIndex),
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
  // nth is given, emit .first() so the exported test keeps source semantics.
  const nth =
    "nth" in loc && loc.nth !== undefined ? `.nth(${loc.nth})` : ".first()";
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
    case "testid":
      return `${root}.getByTestId(${str(loc.testid)})`;
  }
}

/* ----- outcome rendering ----- */

/** Outcome fields `cairn run` never splices (see withSpliceSources). */
const NO_SPLICE: ReadonlySet<RuntimeRefSource> = new Set();
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
function withSpliceSources<T>(
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
  const rendered = withSpliceSources(ctx, NO_SPLICE, () =>
    renderOutcomeBody(outcome, ctx),
  );
  if (rendered.exported && verifierPoll(outcome.verify) !== undefined) {
    skip(
      ctx,
      "outcome",
      "poll not exported: the generated check runs once (Playwright locator assertions still auto-retry)",
      outcome.id,
      true,
    );
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
    if (v.network.body !== undefined || v.network.count !== undefined) {
      return skipStmt(
        ctx,
        "outcome",
        "network body/count matching not exported (the generated request log keeps no request bodies)",
        `network ${oneLine(v.network.urlContains)} with body/count skipped — verify with cairn run`,
        outcome.id,
      );
    }
    if (v.network.assign !== undefined) {
      skip(
        ctx,
        "outcome",
        `network.assign ${v.network.assign} not exported: later \${network.${v.network.assign}…} references stay literal`,
        outcome.id,
        true,
      );
    }
    return { stmts: renderNetworkOutcome(v, ctx), exported: true };
  }
  if (isNoFailedRequestsVerifier(v))
    return { stmts: renderNoFailedRequestsOutcome(v, ctx), exported: true };
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

function renderNoFailedRequestsOutcome(
  v: NoFailedRequestsVerifier,
  ctx: EmitCtx,
): Stmt[] {
  const str = (s: string) => emitStr(s, ctx.usage);
  const n = v.noFailedRequests;
  const conds = [`r.url.includes(${str(n.urlContains)})`];
  if (n.method) conds.push(`r.method === ${JSON.stringify(n.method)}`);
  return [
    raw(
      `expect(requests.filter((r) => ${conds.join(" && ")} && (r.status ?? 0) >= 400)).toEqual([]);`,
    ),
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
    let importPath: string;
    if (ctx.verifierImportPrefix) {
      ctx.verifierFiles?.add(abs);
      importPath = `${ctx.verifierImportPrefix}/${abs.split("/").pop()}`;
    } else if (ctx.outDir) {
      importPath = toRelativeImport(ctx.outDir, abs);
    } else {
      importPath = abs;
    }
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
          `}, { source: ${emitStr(source, ctx.usage, { runtimeRefs: false })}, scriptContext: { "fixtures": ${withSpliceSources(
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
  outcomeId: string,
  ctx: EmitCtx,
): Rendered {
  const str = (s: string) => emitStr(s, ctx.usage);
  const h = v.httpJson;
  // Best-effort GET + simple equals/contains on a dotted jsonPath.
  const pathExpr = `String(${str(h.jsonPath ?? "$")}).replace(/^\\$\\.?/, "").split(".").filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), body)`;
  const body: Stmt[] = [
    raw(
      `const res = await page.request.get(${withSpliceSources(
        ctx,
        HTTP_JSON_URL_SPLICE,
        () => str(h.url),
      )});`,
    ),
    raw(`expect(res.ok()).toBeTruthy();`),
    raw(`const body = await res.json();`),
    raw(`const val = ${pathExpr};`),
  ];
  if (h.equals !== undefined) {
    body.push(raw(`expect(val).toEqual(${emitValue(h.equals, ctx.usage)});`));
  } else if (h.contains !== undefined) {
    body.push(
      raw(
        `expect(String(val)).toContain(${emitValue(h.contains, ctx.usage)});`,
      ),
    );
  } else if (h.exists !== undefined) {
    body.push(
      h.exists
        ? raw(`expect(val).not.toBeUndefined();`)
        : raw(`expect(val).toBeUndefined();`),
    );
  } else {
    skip(
      ctx,
      "outcome",
      "httpJson matcher (matches/atLeast/atMost) not fully exported",
      outcomeId,
    );
    body.push(
      comment(
        `httpJson: status ok + path resolved; advanced matchers not exported`,
      ),
    );
  }
  return { stmts: [braces(body)], exported: true };
}

/**
 * Datasource / value / table verifiers read things a generated Playwright
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
  if (isHttpVerifier(v)) {
    return `http verifier not exported: it calls ${
      v.http.source ? `config datasource "${v.http.source}"` : "a service URL"
    } from Node; verify it with cairn run`;
  }
  if (isValueVerifier(v)) {
    return "value verifier not exported: it reads Cairntrace runtime values (evals, requests, captures, fixtures); verify it with cairn run";
  }
  if (isTableVerifier(v)) {
    return "table verifier not exported: the rendered-table reader is Cairntrace's; verify it with cairn run";
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
  if ("request" in e) {
    return skipStmt(
      ctx,
      "step",
      `expect.request not exported (${e.request.method} ${e.request.url}): Cairntrace sends it through the browser-session request transport`,
      `expect request ${oneLine(e.request.url)} skipped — verify with cairn run`,
      step.id,
    );
  }
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
    isHttpJsonVerifier(v)
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
function isNeverExportedStep(step: Step): boolean {
  return (
    ("expect" in step && "request" in step.expect) ||
    "capture" in step ||
    "run" in step ||
    "monitor" in step ||
    "snapshot" in step
  );
}

export function referencedRuntimeRefs(spec: Spec): Set<string> {
  // Steps the export always skips never read a binding: counting their refs
  // would declare a binding nothing reads (noUnusedLocals fails the export).
  const keys = collectRuntimeRefKeys(
    (spec.steps ?? []).filter((step) => !isNeverExportedStep(step)),
  );
  for (const outcome of spec.outcomes) {
    const v = outcome.verify;
    if (isScriptVerifier(v)) {
      // Inline `runtime: node` scripts are skipped, so never read bindings.
      if (v.script.runtime !== "node" || v.script.file !== undefined) {
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
