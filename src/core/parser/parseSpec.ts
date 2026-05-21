import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { computeContractHash } from "../contractHash";
import {
  ReusableActionSchema,
  SpecSchema,
  type ReusableAction,
  type Spec,
  type Step,
} from "../schema/spec.v1";

export interface ParseResult {
  /** Parsed spec as written on disk (with `use:` placeholders, no inlining). */
  spec: Spec;
  /** Spec with `use:` references inlined to the imported action's steps. */
  resolved: Spec;
  /** Absolute path of the source file. */
  path: string;
  /** True iff the spec had a `contractHash:` field that matched the computed value. */
  contractHashValid: boolean;
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
  const vars = opts.vars ?? {};
  const baseUrl = opts.baseUrl;

  const raw = await loadAndParse(absPath, env, vars, baseUrl);
  const spec = SpecSchema.parse(raw);

  const actions = new Map<string, ReusableAction>();
  for (const importPath of spec.imports ?? []) {
    const resolvedImport = resolveImportPath(importPath, dirname(absPath));
    const importRaw = await loadAndParse(resolvedImport, env, vars, baseUrl);
    const action = ReusableActionSchema.parse(importRaw);
    actions.set(action.name, action);
  }

  const resolvedSteps: Step[] = (spec.steps ?? []).flatMap((step) => {
    if ("use" in step) {
      const action = actions.get(step.use);
      if (!action) {
        throw new UnresolvedActionError(step.use, spec.imports ?? []);
      }
      return action.steps;
    }
    return [step];
  });

  // Prepend baseUrl to relative-path `open:` steps so specs can be portable
  // across environments without rewriting URLs by hand.
  const stepsWithBaseUrl = baseUrl
    ? resolvedSteps.map((step) =>
        "open" in step && isRelativeUrl(step.open)
          ? { ...step, open: joinUrl(baseUrl, step.open) }
          : step,
      )
    : resolvedSteps;

  const resolved: Spec = { ...spec, steps: stepsWithBaseUrl };

  let contractHashValid = false;
  if (spec.contractHash) {
    const computed = computeContractHash(spec);
    if (computed !== spec.contractHash) {
      throw new ContractHashMismatchError(spec.contractHash, computed);
    }
    contractHashValid = true;
  }

  return { spec, resolved, path: absPath, contractHashValid };
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

async function loadAndParse(
  absPath: string,
  env: Record<string, string | undefined>,
  vars: Record<string, string | number | boolean>,
  baseUrl: string | undefined,
): Promise<unknown> {
  const text = await readFile(absPath, "utf8");
  const substituted = substitute(text, env, vars, dirname(absPath), baseUrl);
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
): string {
  return text.replace(/\$\{([\w.]+)\}/g, (match, key: string) => {
    if (key === "project.root") return projectRoot;
    if (key === "baseUrl") return baseUrl ?? "";
    const dotIdx = key.indexOf(".");
    if (dotIdx < 0) return match;
    const ns = key.slice(0, dotIdx);
    const name = key.slice(dotIdx + 1);
    if (ns === "env" || ns === "secrets") {
      return env[name] ?? "";
    }
    if (ns === "vars") {
      const v = vars[name];
      return v === undefined ? "" : String(v);
    }
    return match;
  });
}

/** True when `url` is missing an http:/https: scheme (path-like). */
function isRelativeUrl(url: string): boolean {
  return !/^https?:\/\//i.test(url);
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "");
  if (path.startsWith("/")) return `${b}${path}`;
  return `${b}/${path}`;
}
