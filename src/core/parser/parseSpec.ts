import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, parseDocument, Scalar, visit } from "yaml";
import { computeContractHash } from "../contractHash";
import {
  openPath,
  ReusableActionSchema,
  SpecSchema,
  useActionName,
  useActionVars,
  useRetry,
  type Condition,
  type RetryUseStep,
  type ReusableAction,
  type Spec,
  type Step,
  type UseStep,
} from "../schema/spec.v1";
import {
  hasRuntimeUrlPlaceholder,
  isRelativeUrl,
  joinUrl,
} from "../runner/url";
import { findConfigFile } from "../config/loader";
import { isStructuredVar, lookupVar, renderVarValue } from "../config/varValue";
import { BUILTIN_LOGIN_ACTION } from "../schema/request.v1";
import type { ConfigScalarVarValue, ConfigVarValue } from "../schema/config.v1";

/** A `${vars.X}` bag: config (typed, F7), spec, use-site and CLI vars. */
type VarsBag = Record<string, ConfigVarValue>;

export interface ParseResult {
  /** Parsed spec as written on disk (with `use:` placeholders, no inlining). */
  spec: Spec;
  /** Spec with `use:` references inlined to the imported action's steps. */
  resolved: Spec;
  /** Absolute path of the source file. */
  path: string;
  /** True iff the spec had a `contractHash:` field that matched the computed value. */
  contractHashValid: boolean;
  /**
   * One entry per element of `resolved.steps` (after `use:` expansion + baseUrl
   * substitution). Maps each resolved index back to the file the step came from
   * — used by `cairn spec heal` to patch the right YAML when drift surfaces
   * inside an imported action.
   */
  origins: StepOrigin[];
  /**
   * F14: origins of steps nested in control-flow blocks, keyed by resolved
   * path — `<top index>/steps/<i>` (repeat), `…/then/<i>`, `…/else/<i>` (if),
   * `…/use/<i>` (a `use:` with `retry`), recursively.
   */
  nestedOrigins?: Map<string, StepOrigin>;
  /** Actions loaded from `imports:`, keyed by action name. */
  actionsByName: Map<string, LoadedAction>;
  /**
   * Merged `${vars.X}` bag used while parsing this spec (spec `vars:` then
   * `ParseOptions.vars`). Exporters use it to pass spec-level overrides into
   * parameterized action calls without re-expanding the action body.
   */
  vars?: VarsBag;
  /**
   * F18: every value a `${secrets.X}` resolved to while parsing (spec and
   * imported actions). The runner registers them for redaction before it
   * writes anything, whatever the secret's name.
   */
  secretValues?: string[];
}

export interface LoadedAction {
  action: ReusableAction;
  /** Absolute path of the action YAML on disk. */
  path: string;
  /** Unsubstituted action YAML, re-parsed per `use:` with merged vars. */
  rawSource: string;
  /** `vars:` defaults declared on the action file. */
  actionDefaults: Record<string, ConfigScalarVarValue>;
  /** Actions this action imports (its own `imports:`), by name. */
  scope?: Map<string, LoadedAction>;
  /**
   * Resolved steps one spec-level `use:` of this action expands to (nested
   * actions inlined). Set when the spec uses it directly.
   */
  expandedStepCount?: number;
}

export interface StepOrigin {
  /** The step exactly as it appears in its source file (NOT baseUrl-substituted). */
  step: Step;
  /** Absolute path of the file containing this step. */
  filePath: string;
  /** Index of this step within that file's `steps` array. */
  fileStepIdx: number;
}

export interface ParseOptions {
  /** Defaults to process.cwd(). Used to resolve relative imports. */
  cwd?: string;
  /** Bag for `${vars.X}` substitution. */
  vars?: VarsBag;
  /** Override env for `${env.X}` / `${secrets.X}`. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Base URL prepended to any `open:` step whose value is a path (does not
   * start with `http://` or `https://`). Also substituted as `${baseUrl}`.
   */
  baseUrl?: string;
  /** Built-in runtime placeholders for per-run/per-worker identity. */
  runtime?: RuntimeTemplateContext;
  /**
   * When set, every `${secrets.X}` — and any `${env.X}` that is UNSET with no
   * `:-default` — resolves to `secretRef("X")` instead of the env value. Lets
   * exporters emit runtime references (e.g. `process.env.X`) so secret VALUES
   * never land in generated files and unresolved env stays late-bound.
   */
  secretRef?: (name: string) => string;
  /**
   * Exporter late binding for `${env.X:-default}`: resolves to
   * `envDefaultRef(X, <default, already substituted>)` instead of the
   * variable's value or the default, so the generated test reads the
   * variable (and falls back) at run time. Needs `secretRef`.
   */
  envDefaultRef?: (name: string, fallback: string) => string;
  /**
   * Exporter late binding for plain `${env.X}`: stays `secretRef(X)` even
   * when X is set while exporting, so no environment value is baked into
   * generated code. Needs `secretRef`.
   */
  lateEnv?: boolean;
  /**
   * Directory of the resolved cairntrace.config.yml — the value of
   * `${config.dir}`. Pass it when the config was chosen explicitly
   * (`--config`). When omitted, and only if a file actually uses the
   * placeholder, the config is discovered by walking up from the spec's
   * directory (the same discovery `loadConfig` does); without any config it
   * falls back to `cwd`.
   */
  configDir?: string;
}

export interface RuntimeTemplateContext {
  workerIndex?: number;
  runToken?: string;
}

const CONFIG_DIR_PLACEHOLDER = "${config.dir}";

/**
 * Load and validate a behavioral spec from disk.
 * Performs:
 *   1. YAML parse to an AST
 *   2. ${env.X} / ${vars.X} / ${secrets.X} / ${project.root} / ${config.dir}
 *      substitution into scalar nodes (so resolved values can never break the
 *      YAML). `${project.root}` is the directory of the file being parsed —
 *      inside an imported action it is the ACTION's directory.
 *   3. zod validation against SpecSchema
 *   4. recursive import resolution (only top-level imports for v0)
 *   5. inline `use:` steps from imported actions
 *   6. contractHash verification (throws on mismatch)
 */
export async function parseSpec(
  specPath: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  const absPath = isAbsolute(specPath)
    ? specPath
    : resolve(opts.cwd ?? process.cwd(), specPath);

  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const baseUrl = opts.baseUrl;

  // `${config.dir}` costs a directory walk, so resolve it lazily and only
  // once, for the first file that actually references it.
  let discoveredConfigDir: Promise<string> | undefined;
  const configDirFor = (source: string): Promise<string | undefined> => {
    if (!source.includes(CONFIG_DIR_PLACEHOLDER)) {
      return Promise.resolve(undefined);
    }
    if (opts.configDir !== undefined) return Promise.resolve(opts.configDir);
    discoveredConfigDir ??= findConfigFile(dirname(absPath)).then((found) =>
      found ? dirname(found) : (opts.cwd ?? process.cwd()),
    );
    return discoveredConfigDir;
  };
  const secretValues = new Set<string>();
  const shared = (source: string, vars: VarsBag): Promise<SharedSubstitution> =>
    configDirFor(source).then((configDir) => ({
      env,
      vars,
      baseUrl,
      configDir,
      runtime: opts.runtime,
      ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
      ...(opts.envDefaultRef ? { envDefaultRef: opts.envDefaultRef } : {}),
      ...(opts.lateEnv ? { lateEnv: true } : {}),
      onEnvValue: (ref) => {
        if (ref.ns === "secrets" && ref.value) secretValues.add(ref.value);
      },
    }));

  const rawSource = await readFile(absPath, "utf8");
  const rawDocument = parseYaml(rawSource);
  assertBatchSelectorLocators(rawDocument, absPath);
  assertNoAuthoredResolved(rawDocument, absPath);
  const rawSpec = SpecSchema.parse(rawDocument);
  const vars = { ...rawSpec.vars, ...opts.vars };
  const raw = loadAndParseSource(
    rawSource,
    absPath,
    await shared(rawSource, vars),
  );
  const spec = SpecSchema.parse(raw);

  // A11: actions load recursively — an action's own `imports:` resolve
  // against the action file. Every loaded action lands in actionsByName
  // (heal and step-file scopes find nested ones by path); a name used by two
  // different files is an error, and an import cycle is a parse error.
  const actionsByName = new Map<string, LoadedAction>();
  const loadedByPath = new Map<string, LoadedAction>();
  const loadAction = async (
    actionPath: string,
    chain: readonly string[],
  ): Promise<LoadedAction> => {
    if (chain.includes(actionPath)) {
      throw new ActionImportCycleError([...chain, actionPath]);
    }
    const cached = loadedByPath.get(actionPath);
    if (cached) return cached;
    const actionSource = await readFile(actionPath, "utf8");
    const actionDocument = parseYaml(actionSource);
    const actionDefaults = extractPlainVars(actionDocument);
    const importRaw = loadAndParseSource(
      actionSource,
      actionPath,
      await shared(actionSource, { ...actionDefaults, ...vars }),
    );
    assertBatchSelectorLocators(importRaw, actionPath);
    assertNoAuthoredResolved(importRaw, actionPath);
    const action = ReusableActionSchema.parse(importRaw);
    const clash = actionsByName.get(action.name);
    if (clash && clash.path !== actionPath) {
      throw new DuplicateActionNameError(action.name, clash.path, actionPath);
    }
    const loaded: LoadedAction = {
      action,
      path: actionPath,
      rawSource: actionSource,
      actionDefaults,
      scope: new Map(),
    };
    loadedByPath.set(actionPath, loaded);
    actionsByName.set(action.name, loaded);
    for (const importPath of action.imports ?? []) {
      const nested = await loadAction(
        resolveImportPath(importPath, dirname(actionPath)),
        [...chain, actionPath],
      );
      loaded.scope!.set(nested.action.name, nested);
    }
    return loaded;
  };
  const specScope = new Map<string, LoadedAction>();
  for (const importPath of spec.imports ?? []) {
    const loaded = await loadAction(
      resolveImportPath(importPath, dirname(absPath)),
      [absPath],
    );
    specScope.set(loaded.action.name, loaded);
  }

  // Walk spec.steps in order; expand `use:` (recursively, through nested
  // actions) while tracking origins so heal can map back from
  // `resolved.steps[N]` to (file, file-step-idx) — the innermost action
  // file for a step that came from a nested action.
  //
  // F14: control-flow blocks (repeat / if) keep their nested lists, expanded
  // the same way (a nested `use:` inlines into that list); a `use:` with
  // `retry` stays one step that carries its expanded `steps`. Nested steps'
  // origins live in `nestedOrigins`, keyed by their resolved path
  // (`<top index>/steps/<i>`, `…/then/<i>`, `…/else/<i>`, `…/use/<i>`).
  const origins: StepOrigin[] = [];
  const nestedOrigins = new Map<string, StepOrigin>();
  interface ExpandScope {
    filePath: string;
    /** Lexical scopes, innermost first: the file's imports, then its importer's. */
    scopes: ReadonlyArray<ReadonlyMap<string, LoadedAction>>;
    /** What the enclosing action saw (nested actions inherit it). */
    callScope: VarsBag;
    /** Action files being expanded (use-cycle detection). */
    stack: readonly string[];
    /** The declaring file's vars (F14 `var` predicates resolve against it). */
    bag: VarsBag;
  }
  /**
   * F18: `use: login` with no imported action of that name is the built-in
   * environment login — kept as a step for the runner (and exporters).
   */
  const isBuiltinLogin = (useStep: UseStep, at: ExpandScope): boolean =>
    useActionName(useStep) === BUILTIN_LOGIN_ACTION &&
    findAction(BUILTIN_LOGIN_ACTION, at.scopes) === undefined;
  const loadUse = async (
    useStep: UseStep,
    at: ExpandScope,
  ): Promise<{ loaded: LoadedAction; steps: Step[]; scope: ExpandScope }> => {
    const actionName = useActionName(useStep);
    const loaded = findAction(actionName, at.scopes);
    if (!loaded) {
      throw new UnresolvedActionError(
        actionName,
        at.filePath === absPath
          ? (spec.imports ?? [])
          : [...new Set(at.scopes.flatMap((scope) => [...scope.keys()]))],
      );
    }
    if (at.stack.includes(loaded.path)) {
      throw new ActionImportCycleError([...at.stack, loaded.path], "use");
    }
    // Precedence: the call's own `with:` values, then — only for names
    // this action does not default — what its caller saw, then the spec
    // vars, then the action's defaults. An enclosing call never silently
    // overrides a nested action's own default; pass it explicitly
    // (`use: { action, vars: { name: ${vars.name} } }`) to do that.
    const inherited = Object.fromEntries(
      Object.entries(at.callScope).filter(
        ([key]) => !Object.hasOwn(loaded.actionDefaults, key),
      ),
    );
    const callVars = { ...inherited, ...useActionVars(useStep) };
    const effective = {
      ...loaded.actionDefaults,
      ...vars,
      ...callVars,
    };
    const expanded = ReusableActionSchema.parse(
      loadAndParseSource(
        loaded.rawSource,
        loaded.path,
        await shared(loaded.rawSource, effective),
      ),
    );
    assertBatchSelectorLocators(expanded, loaded.path);
    return {
      loaded,
      steps: expanded.steps,
      scope: {
        filePath: loaded.path,
        scopes: [loaded.scope ?? new Map(), ...at.scopes],
        // Nested actions inherit what this action saw (its defaults too).
        callScope: effective,
        stack: [...at.stack, loaded.path],
        bag: effective,
      },
    };
  };
  const renderVar = (value: ConfigVarValue): string =>
    renderRuntimePlaceholders(renderVarValue(value), opts.runtime);
  /**
   * Expand `steps` into `out`. `prefix` is the resolved path of the list
   * (undefined for the top level); `record` keeps each step's origin.
   */
  const expandList = async (
    steps: readonly Step[],
    at: ExpandScope,
    out: Step[],
    prefix: string | undefined,
  ): Promise<void> => {
    for (let j = 0; j < steps.length; j++) {
      const step = steps[j]!;
      if (
        "use" in step &&
        useRetry(step) === undefined &&
        !isBuiltinLogin(step, at)
      ) {
        const used = await loadUse(step, at);
        const before = out.length;
        await expandList(used.steps, used.scope, out, prefix);
        if (prefix === undefined && at.filePath === absPath) {
          used.loaded.expandedStepCount = out.length - before;
        }
        continue;
      }
      const path =
        prefix === undefined ? String(out.length) : `${prefix}/${out.length}`;
      const origin: StepOrigin = {
        step,
        filePath: at.filePath,
        fileStepIdx: j,
      };
      if (prefix === undefined) origins.push(origin);
      else nestedOrigins.set(path, origin);
      out.push(await resolveStep(step, at, path));
    }
  };
  /** One kept step: var predicates resolved, baseUrl, nested lists expanded. */
  const resolveStep = async (
    step: Step,
    at: ExpandScope,
    path: string,
  ): Promise<Step> => {
    const own = withBaseUrl(annotateStepVars(step, at.bag, renderVar), baseUrl);
    const nestedList = async (
      list: readonly Step[],
      key: string,
      scope: ExpandScope = at,
    ): Promise<Step[]> => {
      const out: Step[] = [];
      await expandList(list, scope, out, `${path}/${key}`);
      return out;
    };
    if ("repeat" in own) {
      return {
        ...own,
        repeat: {
          ...own.repeat,
          steps: await nestedList(own.repeat.steps, "steps"),
        },
      };
    }
    if ("if" in own) {
      return {
        ...own,
        if: {
          ...own.if,
          // oxlint-disable-next-line unicorn/no-thenable -- `if.then` is a step list, never a function
          then: await nestedList(own.if.then, "then"),
          ...(own.if.else
            ? { else: await nestedList(own.if.else, "else") }
            : {}),
        },
      };
    }
    if ("use" in own && isBuiltinLogin(own, at)) return own;
    if ("use" in own) {
      // A `use:` + `retry` (others were inlined): the group to retry.
      const used = await loadUse(own, at);
      const retryUse: RetryUseStep = {
        ...(own as RetryUseStep),
        steps: await nestedList(used.steps, "use", used.scope),
      };
      return retryUse;
    }
    return own;
  };
  const specStepsResolved: Step[] = [];
  await expandList(
    spec.steps ?? [],
    {
      filePath: absPath,
      scopes: [specScope],
      callScope: {},
      stack: [],
      bag: vars,
    },
    specStepsResolved,
    undefined,
  );

  // `resolved.steps` carries baseUrl-prefixed `open:` paths (see
  // withBaseUrl) and parser-resolved var predicates; `origins[i].step`
  // remains the raw file step so heal patches the file's actual content.
  const resolved: Spec = { ...spec, steps: specStepsResolved };

  let contractHashValid = false;
  if (rawSpec.contractHash) {
    const computed = computeContractHash(rawSpec);
    if (computed !== rawSpec.contractHash) {
      throw new ContractHashMismatchError(
        rawSpec.contractHash,
        computed,
        absPath,
      );
    }
    contractHashValid = true;
  }

  return {
    spec,
    resolved,
    path: absPath,
    contractHashValid,
    origins,
    nestedOrigins,
    actionsByName,
    vars,
    ...(secretValues.size > 0 ? { secretValues: [...secretValues] } : {}),
  };
}

/**
 * Re-parse an action YAML with an explicit vars bag. The Playwright exporter
 * uses this to keep declared `action.vars` as late-bound sentinels so the
 * generated helper stays parameterized.
 */
export function parseReusableAction(
  rawSource: string,
  absPath: string,
  /** Value of `${config.dir}`; the process cwd when omitted. */
  opts: {
    vars?: VarsBag;
    env?: Record<string, string | undefined>;
    baseUrl?: string;
    runtime?: RuntimeTemplateContext;
    secretRef?: (name: string) => string;
    envDefaultRef?: (name: string, fallback: string) => string;
    lateEnv?: boolean;
    configDir?: string;
  } = {},
): ReusableAction {
  const importRaw = loadAndParseSource(rawSource, absPath, {
    env: opts.env ?? {},
    vars: opts.vars ?? {},
    baseUrl: opts.baseUrl,
    configDir: opts.configDir,
    runtime: opts.runtime,
    ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
    ...(opts.envDefaultRef ? { envDefaultRef: opts.envDefaultRef } : {}),
    ...(opts.lateEnv ? { lateEnv: true } : {}),
  });
  assertBatchSelectorLocators(importRaw, absPath);
  assertNoAuthoredResolved(importRaw, absPath);
  const action = ReusableActionSchema.parse(importRaw);
  // F14: `var` predicates read the vars this parse was given (the exporter
  // binds declared action vars to late-bound sentinels).
  return {
    ...action,
    steps: annotateVarPredicates(action.steps, opts.vars ?? {}, (value) =>
      renderRuntimePlaceholders(renderVarValue(value), opts.runtime),
    ),
  };
}

/* ----- F14 helpers: var predicates, baseUrl ----- */

/**
 * Resolve the plain `var` predicates of a whole step list (nested repeat /
 * if blocks included) against ONE vars bag — for steps that all live in one
 * file, e.g. a spec's own steps as written (the --project exporter renders
 * those, not `resolved`) or a re-parsed action. `use:` is not followed.
 */
export function annotateVarPredicates(
  steps: readonly Step[],
  bag: VarsBag,
  render: (value: ConfigVarValue) => string = renderVarValue,
): Step[] {
  return steps.map((step) => {
    const own = annotateStepVars(step, bag, render);
    if ("repeat" in own) {
      return {
        ...own,
        repeat: {
          ...own.repeat,
          steps: annotateVarPredicates(own.repeat.steps, bag, render),
        },
      };
    }
    if ("if" in own) {
      return {
        ...own,
        if: {
          ...own.if,
          // oxlint-disable-next-line unicorn/no-thenable -- `if.then` is a step list, never a function
          then: annotateVarPredicates(own.if.then, bag, render),
          ...(own.if.else
            ? { else: annotateVarPredicates(own.if.else, bag, render) }
            : {}),
        },
      };
    }
    return own;
  });
}

/**
 * Attach the declaring file's value of a plain `var` predicate as
 * `resolved` (dotted runtime names are read by the runner).
 */
function annotateCondition<T extends Condition | undefined>(
  condition: T,
  bag: VarsBag,
  render: (value: ConfigVarValue) => string,
): T {
  const when = condition as Condition | undefined;
  if (when === undefined || typeof when === "string") return condition;
  // `resolved` is the parser's alone: whatever else reached here never keeps it.
  const { resolved: _authored, ...rest } = when;
  if (when.var === undefined || when.var.includes(".")) {
    return (_authored === undefined ? condition : rest) as T;
  }
  const value = Object.hasOwn(bag, when.var) ? bag[when.var] : undefined;
  return (
    value === undefined ? rest : { ...rest, resolved: render(value) }
  ) as T;
}

/**
 * Resolve the `var` predicates a step owns (its `when`, `repeat.until`,
 * `if.condition`, `use.retry.until`) against `bag`. Nested lists are left
 * alone: each nested step is resolved in the scope of the file declaring it.
 */
export function annotateStepVars(
  step: Step,
  bag: VarsBag,
  render: (value: ConfigVarValue) => string = renderVarValue,
): Step {
  let out: Step = step;
  if (step.when !== undefined && typeof step.when !== "string") {
    out = { ...out, when: annotateCondition(step.when, bag, render) };
  }
  if ("repeat" in out && out.repeat.until !== undefined) {
    out = {
      ...out,
      repeat: {
        ...out.repeat,
        until: annotateCondition(out.repeat.until, bag, render),
      },
    };
  }
  if ("if" in out) {
    out = {
      ...out,
      if: {
        ...out.if,
        condition: annotateCondition(out.if.condition, bag, render),
      },
    };
  }
  if ("use" in out && typeof out.use !== "string" && out.use.retry?.until) {
    out = {
      ...out,
      use: {
        ...out.use,
        retry: {
          ...out.use.retry,
          until: annotateCondition(out.use.retry.until, bag, render),
        },
      },
    } as Step;
  }
  return out;
}

/**
 * Prepend baseUrl to a relative-path `open:` step so specs stay portable
 * across environments without rewriting URLs by hand.
 */
function withBaseUrl(step: Step, baseUrl: string | undefined): Step {
  if (!baseUrl || !("open" in step)) return step;
  const path = openPath(step);
  if (!isRelativeUrl(path) || hasRuntimeUrlPlaceholder(path)) return step;
  return typeof step.open === "string"
    ? { ...step, open: joinUrl(baseUrl, step.open) }
    : {
        ...step,
        open: { ...step.open, path: joinUrl(baseUrl, step.open.path) },
      };
}

/**
 * Resolve `${...}` placeholders in a single free-standing string (not a spec
 * file) — e.g. a URL handed to `cairn discover` / `cairn_discover_open`.
 * Same rules as spec parsing: `${vars.X}` must exist (else
 * MissingTemplateVariableError), `${env.X:-default}`, `${baseUrl}`,
 * `${config.dir}`; `${project.root}` is the given `cwd`.
 *
 * The result holds real env/secret values, so it is for navigation only.
 * Callers that display or persist the URL keep the template (or redact the
 * values reported through `onEnvValue`).
 */
export function resolveTemplateString(
  text: string,
  /** Label used in error messages (default "input"). */
  /**
   * Called for every `${env.X}` / `${secrets.X}` that resolved to a value
   * from the environment (not to its `:-default`), with the namespace and
   * name, so callers can redact secret values from anything they display.
   */
  opts: {
    vars?: VarsBag;
    env?: Record<string, string | undefined>;
    baseUrl?: string;
    configDir?: string;
    cwd?: string;
    label?: string;
    onEnvValue?: (ref: {
      ns: "env" | "secrets";
      name: string;
      value: string;
    }) => void;
  } = {},
): string {
  if (!text.includes("${")) return text;
  const cwd = opts.cwd ?? process.cwd();
  return substituteString(text, {
    env: opts.env ?? (process.env as Record<string, string | undefined>),
    vars: opts.vars ?? {},
    baseUrl: opts.baseUrl,
    configDir: opts.configDir ?? cwd,
    runtime: undefined,
    projectRoot: cwd,
    filePath: opts.label ?? "input",
    ...(opts.onEnvValue ? { onEnvValue: opts.onEnvValue } : {}),
  });
}

export class ContractHashMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
    public readonly specPath: string,
  ) {
    super(
      `contract changed since seal in ${specPath} — review the intent/outcomes diff, ` +
        `then run \`cairn spec verify ${JSON.stringify(specPath)} --stamp\`. ` +
        `Spec stamped ${expected}, computed ${actual}.`,
    );
    this.name = "ContractHashMismatchError";
  }
}

export class BatchSelectorLocatorError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly stepIndex: number,
    public readonly subStepIndex: number,
    public readonly action: string,
    public readonly locatorKind: string,
  ) {
    const path = `steps[${stepIndex}].batch[${subStepIndex}]`;
    super(
      `batch sub-step #${subStepIndex + 1} (${path}, ${action}) in ${filePath} ` +
        `uses by: ${locatorKind}; batch supports selector locators only — ` +
        `use by: selector or move this interaction to a top-level step`,
    );
    this.name = "BatchSelectorLocatorError";
  }
}

export class UnresolvedActionError extends Error {
  constructor(
    public readonly actionName: string,
    public readonly importedFrom: string[],
  ) {
    super(
      `unresolved action '${actionName}'. ` +
        (importedFrom.length === 0
          ? "Spec has no `imports:` block."
          : `Checked imports: ${importedFrom.join(", ")}`),
    );
    this.name = "UnresolvedActionError";
  }
}

/**
 * Reusable actions import (or `use:`) each other in a cycle. `chain` is
 * the files in order, ending with the one that closes the cycle.
 */
export class ActionImportCycleError extends Error {
  constructor(
    public readonly chain: readonly string[],
    public readonly via: "imports" | "use" = "imports",
  ) {
    super(
      `action ${via === "use" ? "use" : "import"} cycle: ${chain
        .map((path) => basename(path))
        .join(" → ")} (${chain.at(-1)})`,
    );
    this.name = "ActionImportCycleError";
  }
}

/** Two different action files declare the same `name:`. */
export class DuplicateActionNameError extends Error {
  constructor(
    public readonly actionName: string,
    public readonly firstPath: string,
    public readonly secondPath: string,
  ) {
    super(
      `action name "${actionName}" is declared by two files: ${firstPath} and ${secondPath}; rename one`,
    );
    this.name = "DuplicateActionNameError";
  }
}

export class MissingTemplateVariableError extends Error {
  constructor(
    public readonly variable: string,
    public readonly filePath: string,
  ) {
    super(`missing vars.${variable} while parsing ${filePath}`);
    this.name = "MissingTemplateVariableError";
  }
}

function extractPlainVars(
  value: unknown,
): Record<string, ConfigScalarVarValue> {
  if (!isRecord(value) || !isRecord(value.vars)) return {};
  const out: Record<string, ConfigScalarVarValue> = {};
  for (const [key, entry] of Object.entries(value.vars)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      out[key] = entry;
    }
  }
  return out;
}

/** Substitution inputs shared by every file of one parse. */
interface SharedSubstitution {
  env: Record<string, string | undefined>;
  vars: VarsBag;
  baseUrl: string | undefined;
  /** `${config.dir}`; undefined only when the file never references it. */
  configDir: string | undefined;
  runtime: RuntimeTemplateContext | undefined;
  secretRef?: (name: string) => string;
  envDefaultRef?: (name: string, fallback: string) => string;
  lateEnv?: boolean;
  /** See resolveTemplateString: reports env/secret values as they resolve. */
  onEnvValue?: (ref: {
    ns: "env" | "secrets";
    name: string;
    value: string;
  }) => void;
}

/** Per-file substitution context: shared inputs + the file's own location. */
interface SubstitutionContext extends SharedSubstitution {
  /** `${project.root}` — the directory of the file being parsed. */
  projectRoot: string;
  /** File named in MissingTemplateVariableError. */
  filePath: string;
}

function loadAndParseSource(
  text: string,
  absPath: string,
  shared: SharedSubstitution,
): unknown {
  // Parse to an AST first, then substitute into scalar *nodes*. Because the
  // YAML library owns serialization, a resolved value containing YAML
  // metacharacters (`:`, `"`, `{`, newlines) can never break the parse — the
  // old text-substitution caveat is gone. Scalar style preserves types: an
  // unquoted (PLAIN) whole-placeholder re-infers its YAML scalar type, while a
  // quoted or embedded placeholder stays a string.
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw doc.errors[0];
  const ctx: SubstitutionContext = {
    ...shared,
    projectRoot: dirname(absPath),
    filePath: absPath,
  };
  // F7: a typed (list / object) var spliced as a whole unquoted value keeps
  // its structure. It is parked under a token (a NUL-delimited string no YAML
  // text or env value can hold) and put back after toJS, so its strings are
  // never substituted a second time.
  const structuredToken = "\u0000cairn-structured-var:";
  const structured: unknown[] = [];
  visit(doc, {
    Scalar(key, node) {
      if (typeof node.value !== "string" || !node.value.includes("${")) return;
      const original = node.value;
      const resolved = substituteString(original, ctx);
      // Only an unquoted whole-placeholder in a *value* position re-infers its
      // YAML type (so `port: ${env.PORT}` → number); map keys and quoted or
      // embedded scalars stay strings (so `port: "${env.PORT}"` → string).
      if (
        key !== "key" &&
        node.type === Scalar.PLAIN &&
        isWholePlaceholder(original)
      ) {
        const typed = structuredVarValue(original, ctx);
        if (typed !== undefined) {
          node.value = `${structuredToken}${structured.length}`;
          structured.push(typed);
          return;
        }
        node.value = coerceScalarValue(resolved);
      } else {
        node.value = resolved;
      }
    },
  });
  const out: unknown = doc.toJS();
  return structured.length > 0
    ? restoreStructuredVars(out, structuredToken, structured)
    : out;
}

/**
 * Give selector-only batch mistakes one focused diagnostic instead of Zod's
 * deeply nested StepSchema union dump. This runs for both specs and imported
 * reusable actions before their respective schemas are parsed.
 */
/**
 * F14: `resolved` on a condition object is set by the parser (the plain
 * var's value in the declaring file's scope) — an authored one would be
 * read as that value. Refused in specs and actions as written.
 */
function assertNoAuthoredResolved(value: unknown, filePath: string): void {
  if (!isRecord(value) || !Array.isArray(value.steps)) return;
  const walk = (steps: unknown[], where: string): void => {
    steps.forEach((step, index) => {
      if (!isRecord(step)) return;
      const at = `${where}[${index}]`;
      const conditions: Array<[string, unknown]> = [
        [`${at}.when`, step.when],
        [
          `${at}.repeat.until`,
          isRecord(step.repeat) ? step.repeat.until : undefined,
        ],
        [
          `${at}.if.condition`,
          isRecord(step.if) ? step.if.condition : undefined,
        ],
        [
          `${at}.use.retry.until`,
          isRecord(step.use) && isRecord(step.use.retry)
            ? step.use.retry.until
            : undefined,
        ],
      ];
      for (const [path, condition] of conditions) {
        if (isRecord(condition) && Object.hasOwn(condition, "resolved")) {
          throw new Error(
            `${path}.resolved in ${filePath} is set by the parser (a plain var's value), never authored — remove it`,
          );
        }
      }
      if (isRecord(step.repeat) && Array.isArray(step.repeat.steps)) {
        walk(step.repeat.steps, `${at}.repeat.steps`);
      }
      if (isRecord(step.if)) {
        for (const key of ["then", "else"] as const) {
          const list = step.if[key];
          if (Array.isArray(list)) walk(list, `${at}.if.${key}`);
        }
      }
    });
  };
  walk(value.steps, "steps");
}

export function assertBatchSelectorLocators(
  value: unknown,
  filePath: string,
): void {
  if (!isRecord(value) || !Array.isArray(value.steps)) return;

  for (let stepIndex = 0; stepIndex < value.steps.length; stepIndex++) {
    const step = value.steps[stepIndex];
    // F14: batches nested in repeat / if blocks follow the same rule.
    if (isRecord(step)) {
      const blocks = [
        isRecord(step.repeat) ? step.repeat.steps : undefined,
        isRecord(step.if) ? step.if.then : undefined,
        isRecord(step.if) ? step.if.else : undefined,
      ];
      for (const nested of blocks) {
        if (Array.isArray(nested)) {
          assertBatchSelectorLocators({ steps: nested }, filePath);
        }
      }
    }
    if (!isRecord(step) || !Array.isArray(step.batch)) continue;

    for (
      let subStepIndex = 0;
      subStepIndex < step.batch.length;
      subStepIndex++
    ) {
      const subStep = step.batch[subStepIndex];
      if (!isRecord(subStep)) continue;
      const semantic = semanticBatchLocator(subStep);
      if (!semantic) continue;
      throw new BatchSelectorLocatorError(
        filePath,
        stepIndex,
        subStepIndex,
        semantic.action,
        semantic.locatorKind,
      );
    }
  }
}

function semanticBatchLocator(
  subStep: Record<string, unknown>,
): { action: string; locatorKind: string } | undefined {
  for (const action of ["click", "hover", "fill", "type", "upload"]) {
    const locator = subStep[action];
    if (!isRecord(locator)) continue;
    if (typeof locator.by === "string" && locator.by !== "selector") {
      return { action, locatorKind: locator.by };
    }
  }

  const scroll = subStep.scroll;
  if (isRecord(scroll) && isRecord(scroll.to)) {
    const kind = scroll.to.by;
    if (typeof kind === "string" && kind !== "selector") {
      return { action: "scroll.to", locatorKind: kind };
    }
  }
  return undefined;
}

/** The action `actionName` names in lexical scopes (innermost first). */
function findAction(
  actionName: string,
  scopes: ReadonlyArray<ReadonlyMap<string, LoadedAction>>,
): LoadedAction | undefined {
  return scopes
    .map((scope) => scope.get(actionName))
    .find((candidate) => candidate !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveImportPath(p: string, baseDir: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(baseDir, p);
}

/**
 * Resolve every `${...}` placeholder inside a single scalar string and return
 * the RAW resolved string — no YAML quoting, because the AST owns
 * serialization (see loadAndParseSource). Each placeholder is resolved exactly
 * once and emitted verbatim — never re-scanned — so an env/secret/var value
 * that itself contains `${...}` stays inert (no cross-secret injection, no
 * crash from a value-borne `${vars.X}`). `${env.X:-default}` default
 * expressions ARE resolved recursively, so nested placeholders like
 * `${env.X:-prefix-${run.token}}` and defaults containing any character work.
 */
function substituteString(text: string, ctx: SubstitutionContext): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("${", i);
    if (start < 0) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, start);
    const end = findPlaceholderEnd(text, start + 2);
    if (end < 0) {
      // Unterminated `${` — emit the remainder literally.
      result += text.slice(start);
      break;
    }
    const body = text.slice(start + 2, end);
    result += resolvePlaceholder(body, ctx);
    i = end + 1;
  }
  return result;
}

/** True when `text` is exactly one `${...}` placeholder and nothing else. */
function isWholePlaceholder(text: string): boolean {
  if (!text.startsWith("${")) return false;
  return findPlaceholderEnd(text, 2) === text.length - 1;
}

/**
 * Find the index of the `}` that closes a `${` (whose `{` sits just before
 * `from`), accounting for nested `${...}` in default expressions. Returns -1
 * when no matching brace exists.
 */
function findPlaceholderEnd(text: string, from: number): number {
  let depth = 1;
  for (let j = from; j < text.length; j++) {
    if (text[j] === "$" && text[j + 1] === "{") {
      depth++;
      j++;
    } else if (text[j] === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Resolve a single placeholder body (the text between `${` and its `}`) to its
 * raw string value. Unknown namespaces are returned unchanged.
 */
function resolvePlaceholder(body: string, ctx: SubstitutionContext): string {
  const { env, vars, runtime, secretRef } = ctx;
  // `${file.dir}` is the documented alias of `${project.root}`: the
  // directory of the file being parsed (an imported action's own directory).
  if (body === "project.root" || body === "file.dir") return ctx.projectRoot;
  if (body === "config.dir") return ctx.configDir ?? process.cwd();
  if (body === "baseUrl") return ctx.baseUrl ?? "";
  if (body === "worker.index") return String(runtime?.workerIndex ?? 0);
  if (body === "run.token") return runtime?.runToken ?? "verify";

  const dotIdx = body.indexOf(".");
  if (dotIdx < 0) return `\${${body}}`;
  const ns = body.slice(0, dotIdx);
  const rest = body.slice(dotIdx + 1);

  if (ns === "env" || ns === "secrets") {
    const defaultIdx = rest.indexOf(":-");
    const name = defaultIdx >= 0 ? rest.slice(0, defaultIdx) : rest;
    const defaultExpr =
      defaultIdx >= 0 ? rest.slice(defaultIdx + 2) : undefined;
    if (ns === "secrets" && secretRef) return secretRef(name);
    if (ns === "env" && secretRef) {
      // Exporter late binding: the generated test reads process.env itself.
      if (defaultExpr !== undefined && ctx.envDefaultRef) {
        return ctx.envDefaultRef(name, substituteString(defaultExpr, ctx));
      }
      if (defaultExpr === undefined && ctx.lateEnv) return secretRef(name);
    }
    const val = env[name];
    if (val === undefined || val === "") {
      if (defaultExpr === undefined) {
        return secretRef ? secretRef(name) : "";
      }
      // Resolve placeholders WITHIN the default expression only — a present
      // env value is returned without recursion.
      return substituteString(defaultExpr, ctx);
    }
    ctx.onEnvValue?.({ ns, name, value: val });
    return val;
  }

  if (ns === "vars") {
    // F7: `${vars.name.key}` / `${vars.name.0}` read inside a typed var; in
    // this (string) context a list or object renders as compact JSON.
    const hit = lookupVar(vars, rest);
    if (!hit.found) {
      throw new MissingTemplateVariableError(rest, ctx.filePath);
    }
    return renderRuntimePlaceholders(renderVarValue(hit.value), runtime);
  }

  return `\${${body}}`;
}

/**
 * F7: the list / object an unquoted whole `${vars.X}` placeholder stands
 * for (runtime placeholders inside it rendered), else undefined — scalars
 * keep the YAML re-inference of {@link coerceScalarValue}.
 */
function structuredVarValue(
  placeholder: string,
  ctx: SubstitutionContext,
): unknown {
  const body = placeholder.slice(2, -1);
  if (!body.startsWith("vars.")) return undefined;
  const hit = lookupVar(ctx.vars, body.slice("vars.".length));
  if (!hit.found || !isStructuredVar(hit.value)) return undefined;
  const render = (value: unknown): unknown => {
    if (typeof value === "string") {
      return renderRuntimePlaceholders(value, ctx.runtime);
    }
    if (Array.isArray(value)) return value.map(render);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, render(item)]),
      );
    }
    return value;
  };
  return render(hit.value);
}

/** Put the structured values parked under `token<i>` back into a parsed tree. */
function restoreStructuredVars(
  value: unknown,
  token: string,
  values: readonly unknown[],
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith(token)) return value;
    const index = Number(value.slice(token.length));
    return Number.isInteger(index) && index < values.length
      ? values[index]
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => restoreStructuredVars(item, token, values));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        restoreStructuredVars(item, token, values),
      ]),
    );
  }
  return value;
}

/**
 * Coerce a resolved PLAIN whole-placeholder value to the YAML scalar type it
 * would have had if written literally (`8080` → number, `true` → boolean,
 * `null` → null), so an unquoted placeholder behaves like its value was
 * inlined. Structural results (arrays/maps) are NEVER adopted — they stay
 * strings — so a value like `a: b` or `[1,2]` can't silently restructure the
 * spec. An empty value stays an empty string rather than becoming null.
 */
function coerceScalarValue(value: string): unknown {
  if (value === "") return "";
  let parsed: unknown;
  try {
    parsed = parseYaml(value);
  } catch {
    return value;
  }
  if (typeof parsed === "object" && parsed !== null) return value;
  return parsed;
}

function renderRuntimePlaceholders(
  value: string,
  runtime: RuntimeTemplateContext | undefined,
): string {
  return value
    .replace(/\$\{worker\.index\}/g, String(runtime?.workerIndex ?? 0))
    .replace(/\$\{run\.token\}/g, runtime?.runToken ?? "verify");
}
