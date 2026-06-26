import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { computeContractHash } from "../contractHash";
import {
  openPath,
  ReusableActionSchema,
  SpecSchema,
  type ReusableAction,
  type Spec,
  type Step,
} from "../schema/spec.v1";
import {
  hasRuntimeUrlPlaceholder,
  isRelativeUrl,
  joinUrl,
} from "../runner/url";

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
}

export interface LoadedAction {
  action: ReusableAction;
  /** Absolute path of the action YAML on disk. */
  path: string;
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
}

export interface RuntimeTemplateContext {
  workerIndex?: number;
  runToken?: string;
}

/**
 * Load and validate a behavioral spec from disk.
 * Performs:
 *   1. textual ${env.X} / ${vars.X} / ${secrets.X} / ${project.root} substitution
 *   2. YAML parse
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

  const rawSource = await readFile(absPath, "utf8");
  const rawSpec = SpecSchema.parse(parseYaml(rawSource));
  const vars = { ...rawSpec.vars, ...opts.vars };
  const raw = loadAndParseSource(
    rawSource,
    absPath,
    env,
    vars,
    baseUrl,
    opts.runtime,
  );
  const spec = SpecSchema.parse(raw);

  const actionsByName = new Map<string, LoadedAction>();
  for (const importPath of spec.imports ?? []) {
    const resolvedImport = resolveImportPath(importPath, dirname(absPath));
    const importRaw = await loadAndParse(
      resolvedImport,
      env,
      vars,
      baseUrl,
      opts.runtime,
    );
    const action = ReusableActionSchema.parse(importRaw);
    actionsByName.set(action.name, { action, path: resolvedImport });
  }

  // Walk spec.steps in order; expand `use:` while tracking origins so heal
  // can map back from `resolved.steps[N]` to (file, file-step-idx).
  const origins: StepOrigin[] = [];
  const specSteps = spec.steps ?? [];
  for (let i = 0; i < specSteps.length; i++) {
    const step = specSteps[i]!;
    if ("use" in step) {
      const loaded = actionsByName.get(step.use);
      if (!loaded) {
        throw new UnresolvedActionError(step.use, spec.imports ?? []);
      }
      for (let j = 0; j < loaded.action.steps.length; j++) {
        origins.push({
          step: loaded.action.steps[j]!,
          filePath: loaded.path,
          fileStepIdx: j,
        });
      }
    } else {
      origins.push({ step, filePath: absPath, fileStepIdx: i });
    }
  }

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
      throw new ContractHashMismatchError(rawSpec.contractHash, computed);
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
  };
}

export class ContractHashMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `contractHash mismatch: spec stamped ${expected}, computed ${actual}. ` +
        `Intent or outcomes were modified outside review.`,
    );
    this.name = "ContractHashMismatchError";
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

export class MissingTemplateVariableError extends Error {
  constructor(
    public readonly variable: string,
    public readonly filePath: string,
  ) {
    super(`missing vars.${variable} while parsing ${filePath}`);
    this.name = "MissingTemplateVariableError";
  }
}

async function loadAndParse(
  absPath: string,
  env: Record<string, string | undefined>,
  vars: Record<string, string | number | boolean>,
  baseUrl: string | undefined,
  runtime: RuntimeTemplateContext | undefined,
): Promise<unknown> {
  const text = await readFile(absPath, "utf8");
  return loadAndParseSource(text, absPath, env, vars, baseUrl, runtime);
}

function loadAndParseSource(
  text: string,
  absPath: string,
  env: Record<string, string | undefined>,
  vars: Record<string, string | number | boolean>,
  baseUrl: string | undefined,
  runtime: RuntimeTemplateContext | undefined,
): unknown {
  const substituted = substitute(
    text,
    env,
    vars,
    dirname(absPath),
    baseUrl,
    absPath,
    runtime,
  );
  return parseYaml(substituted);
}

function resolveImportPath(p: string, baseDir: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(baseDir, p);
}

/**
 * Textual substitution applied to the raw YAML source *before* parsing.
 * Supports `${env.X}`, `${secrets.X}` (alias of env), `${vars.X}`, `${project.root}`.
 * Unknown patterns are left intact. Done at text-time so substitution works inside
 * any string field without walking the parsed object.
 *
 * Caveat: substituted values that contain YAML metacharacters (`:`, `"`, newlines)
 * may break parsing. Treat `${...}` like a templating concern; sanitize secrets at
 * source if needed.
 */
function substitute(
  text: string,
  env: Record<string, string | undefined>,
  vars: Record<string, string | number | boolean>,
  projectRoot: string,
  baseUrl: string | undefined,
  filePath: string,
  runtime: RuntimeTemplateContext | undefined,
): string {
  // Resolve placeholders from the inside out so nested defaults can reference
  // runtime placeholders like ${env.X:-prefix-${run.token}}. Re-run while
  // the text keeps changing to a max depth that comfortably exceeds real specs.
  let previous = "";
  let current = text;
  for (let depth = 0; depth < 10 && current !== previous; depth++) {
    previous = current;
    current = substitutePass(
      current,
      env,
      vars,
      projectRoot,
      baseUrl,
      filePath,
      runtime,
    );
  }
  return current;
}

function substitutePass(
  text: string,
  env: Record<string, string | undefined>,
  vars: Record<string, string | number | boolean>,
  projectRoot: string,
  baseUrl: string | undefined,
  filePath: string,
  runtime: RuntimeTemplateContext | undefined,
): string {
  return text.replace(/\$\{([\w.:-]+)\}/g, (match, key: string) => {
    if (key === "project.root") return projectRoot;
    if (key === "baseUrl") return baseUrl ?? "";
    if (key === "worker.index") return String(runtime?.workerIndex ?? 0);
    if (key === "run.token") return runtime?.runToken ?? "verify";
    const dotIdx = key.indexOf(".");
    if (dotIdx < 0) return match;
    const ns = key.slice(0, dotIdx);
    const rest = key.slice(dotIdx + 1);
    if (ns === "env" || ns === "secrets") {
      const defaultIdx = rest.indexOf(":-");
      const name = defaultIdx >= 0 ? rest.slice(0, defaultIdx) : rest;
      const defaultValue =
        defaultIdx >= 0 ? rest.slice(defaultIdx + 2) : undefined;
      const val = env[name];
      if (val === undefined || val === "") {
        if (defaultValue === undefined) return '""';
        return quoteEnvValue(renderRuntimePlaceholders(defaultValue, runtime));
      }
      return quoteEnvValue(val);
    }
    if (ns === "vars") {
      const v = vars[rest];
      if (v === undefined)
        throw new MissingTemplateVariableError(rest, filePath);
      const rendered = renderRuntimePlaceholders(String(v), runtime);
      // Empty string vars (usually from missing env-driven config vars) must
      // stay as a YAML string scalar, not YAML null.
      if (rendered === "") return '""';
      return rendered;
    }
    return match;
  });
}

/** Quote a substituted env value so it always remains a YAML string. */
function quoteEnvValue(value: string): string {
  if (value === "") return '""';
  if (/^[\w./:=@~-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function renderRuntimePlaceholders(
  value: string,
  runtime: RuntimeTemplateContext | undefined,
): string {
  return value
    .replace(/\$\{worker\.index\}/g, String(runtime?.workerIndex ?? 0))
    .replace(/\$\{run\.token\}/g, runtime?.runToken ?? "verify");
}
