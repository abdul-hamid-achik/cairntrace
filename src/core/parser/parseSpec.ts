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
  /** Actions loaded from `imports:`, keyed by action name. */
  actionsByName: Map<string, LoadedAction>;
  /**
   * Merged `${vars.X}` bag used while parsing this spec (spec `vars:` then
   * `ParseOptions.vars`). Exporters use it to pass spec-level overrides into
   * parameterized action calls without re-expanding the action body.
   */
  vars?: Record<string, string | number | boolean>;
}

export interface LoadedAction {
  action: ReusableAction;
  /** Absolute path of the action YAML on disk. */
  path: string;
  /** Unsubstituted action YAML, re-parsed per `use:` with merged vars. */
  rawSource: string;
  /** `vars:` defaults declared on the action file. */
  actionDefaults: Record<string, string | number | boolean>;
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
  vars?: Record<string, string | number | boolean>;
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
  const shared = (
    source: string,
    vars: Record<string, string | number | boolean>,
  ): Promise<SharedSubstitution> =>
    configDirFor(source).then((configDir) => ({
      env,
      vars,
      baseUrl,
      configDir,
      runtime: opts.runtime,
      ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
    }));

  const rawSource = await readFile(absPath, "utf8");
  const rawDocument = parseYaml(rawSource);
  assertBatchSelectorLocators(rawDocument, absPath);
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
  const origins: StepOrigin[] = [];
  const expandSteps = async (
    steps: readonly Step[],
    filePath: string,
    /** Lexical scopes, innermost first: the file's imports, then its importer's. */
    scopes: ReadonlyArray<ReadonlyMap<string, LoadedAction>>,
    /** What the enclosing action saw (nested actions inherit it). */
    callScope: Record<string, string | number | boolean>,
    /** Action files being expanded (use-cycle detection). */
    stack: readonly string[],
  ): Promise<void> => {
    for (let j = 0; j < steps.length; j++) {
      const step = steps[j]!;
      if (!("use" in step)) {
        origins.push({ step, filePath, fileStepIdx: j });
        continue;
      }
      const useStep = step as UseStep;
      const actionName = useActionName(useStep);
      const loaded = scopes
        .map((scope) => scope.get(actionName))
        .find((candidate) => candidate !== undefined);
      if (!loaded) {
        throw new UnresolvedActionError(
          actionName,
          filePath === absPath
            ? (spec.imports ?? [])
            : [...new Set(scopes.flatMap((scope) => [...scope.keys()]))],
        );
      }
      if (stack.includes(loaded.path)) {
        throw new ActionImportCycleError([...stack, loaded.path], "use");
      }
      // Precedence: the call's own `with:` values, then — only for names
      // this action does not default — what its caller saw, then the spec
      // vars, then the action's defaults. An enclosing call never silently
      // overrides a nested action's own default; pass it explicitly
      // (`use: { action, vars: { name: ${vars.name} } }`) to do that.
      const inherited = Object.fromEntries(
        Object.entries(callScope).filter(
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
      const before = origins.length;
      await expandSteps(
        expanded.steps,
        loaded.path,
        [loaded.scope ?? new Map(), ...scopes],
        // Nested actions inherit what this action saw (its defaults too).
        effective,
        [...stack, loaded.path],
      );
      if (filePath === absPath) {
        loaded.expandedStepCount = origins.length - before;
      }
    }
  };
  await expandSteps(spec.steps ?? [], absPath, [specScope], {}, []);

  // Prepend baseUrl to relative-path `open:` steps so specs can be portable
  // across environments without rewriting URLs by hand. This only affects
  // `resolved.steps`; `origins[i].step` remains the raw file step so heal
  // patches the file's actual content.
  const stepsWithBaseUrl = origins.map(({ step }) => {
    const path = "open" in step ? openPath(step) : "";
    if (
      !baseUrl ||
      !("open" in step) ||
      !isRelativeUrl(path) ||
      hasRuntimeUrlPlaceholder(path)
    ) {
      return step;
    }
    return typeof step.open === "string"
      ? { ...step, open: joinUrl(baseUrl, step.open) }
      : {
          ...step,
          open: { ...step.open, path: joinUrl(baseUrl, step.open.path) },
        };
  });

  const resolved: Spec = { ...spec, steps: stepsWithBaseUrl };

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
    actionsByName,
    vars,
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
    vars?: Record<string, string | number | boolean>;
    env?: Record<string, string | undefined>;
    baseUrl?: string;
    runtime?: RuntimeTemplateContext;
    secretRef?: (name: string) => string;
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
  });
  assertBatchSelectorLocators(importRaw, absPath);
  return ReusableActionSchema.parse(importRaw);
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
    vars?: Record<string, string | number | boolean>;
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
): Record<string, string | number | boolean> {
  if (!isRecord(value) || !isRecord(value.vars)) return {};
  const out: Record<string, string | number | boolean> = {};
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
  vars: Record<string, string | number | boolean>;
  baseUrl: string | undefined;
  /** `${config.dir}`; undefined only when the file never references it. */
  configDir: string | undefined;
  runtime: RuntimeTemplateContext | undefined;
  secretRef?: (name: string) => string;
}

/** Per-file substitution context: shared inputs + the file's own location. */
interface SubstitutionContext extends SharedSubstitution {
  /** `${project.root}` — the directory of the file being parsed. */
  projectRoot: string;
  /** File named in MissingTemplateVariableError. */
  filePath: string;
  /** See resolveTemplateString: reports env/secret values as they resolve. */
  onEnvValue?: (ref: {
    ns: "env" | "secrets";
    name: string;
    value: string;
  }) => void;
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
        node.value = coerceScalarValue(resolved);
      } else {
        node.value = resolved;
      }
    },
  });
  return doc.toJS();
}

/**
 * Give selector-only batch mistakes one focused diagnostic instead of Zod's
 * deeply nested StepSchema union dump. This runs for both specs and imported
 * reusable actions before their respective schemas are parsed.
 */
export function assertBatchSelectorLocators(
  value: unknown,
  filePath: string,
): void {
  if (!isRecord(value) || !Array.isArray(value.steps)) return;

  for (let stepIndex = 0; stepIndex < value.steps.length; stepIndex++) {
    const step = value.steps[stepIndex];
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
    const v = vars[rest];
    if (v === undefined) {
      throw new MissingTemplateVariableError(rest, ctx.filePath);
    }
    return renderRuntimePlaceholders(String(v), runtime);
  }

  return `\${${body}}`;
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
