import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ParseResult } from "./parser/parseSpec";
import {
  resolveScopedEvalHostFile,
  resolveStepFile,
  type StepFileScope,
  stepFileScopeAt,
} from "./runner/stepFiles";
import { nestedStepLists, type Step } from "./schema/spec.v1";
import { isScriptVerifier } from "./schema/verifier.v1";

/**
 * Static file-reference audit for `cairn spec verify` (F13): every file a
 * spec or its imported actions point at — `eval.file`, eval host files
 * (`args.filePath` / `args.fixtureFiles`), `transform.file` /
 * `transform.input`, `upload.path` and script verifier `file:` — resolved
 * EXACTLY as `cairn run` resolves it (an action's paths against the action's
 * own directory, with the deprecated spec-relative fallback), so a missing
 * file fails verify instead of a run minutes in.
 *
 * Paths that still hold a runtime placeholder (`${artifacts.…}`,
 * `${requests.…}`, `${evals.…}`) are produced by the run and skipped.
 */

export type FileReferenceFindingKind =
  | "missing-file"
  | "absolute-path"
  | "deprecated-path";

export interface FileReferenceFinding {
  kind: FileReferenceFindingKind;
  severity: "error" | "warning";
  /** File that declares the reference (spec or imported action). */
  file: string;
  /** Step label (`steps[2] upload_csv`, `action login step 3`) or `outcome <id>`. */
  where: string;
  /** Field, e.g. `eval.file`, `upload.path`, `script.file`. */
  field: string;
  /** The path as written (after placeholder substitution). */
  value: string;
  /** Where it resolves at run time. */
  resolved: string;
  message: string;
}

interface Reference {
  field: string;
  value: string;
  where: string;
  scope: StepFileScope;
  /** Eval host files resolve absolute → (action dir) → cwd → spec dir. */
  hostFile?: boolean;
}

const RUNTIME_PLACEHOLDER = /\$\{(?:artifacts|requests|evals)\./;

export function auditFileReferences(
  parsed: Pick<
    ParseResult,
    "path" | "origins" | "nestedOrigins" | "actionsByName" | "resolved"
  >,
  opts: { projectRoot: string },
): FileReferenceFinding[] {
  const findings: FileReferenceFinding[] = [];
  const references: Reference[] = [];
  // The reference being resolved: the deprecation sink attributes to it.
  let current: (Reference & { deprecation?: FileReferenceFinding }) | undefined;
  const deprecated = new Map<string, FileReferenceFinding>();
  // F14: steps nested in repeat / if / retried use blocks are audited too,
  // each against the file that declares it (looked up by resolved path).
  const located: Array<{ step: Step; index: number | string; label: string }> =
    [];
  const visit = (
    list: readonly Step[],
    prefix: string | undefined,
    labelPrefix: string,
  ): void => {
    list.forEach((step, i) => {
      const index = prefix === undefined ? i : `${prefix}/${i}`;
      const label = `${labelPrefix}[${i}]`;
      located.push({ step, index, label });
      for (const nested of nestedStepLists(step)) {
        visit(nested.steps, `${index}/${nested.key}`, `${label}.${nested.key}`);
      }
    });
  };
  visit(parsed.resolved.steps ?? [], undefined, "steps");
  for (const { step, index, label } of located) {
    const scope = stepFileScopeAt(parsed, index, (key, message) => {
      if (!current || deprecated.has(key)) return;
      current.deprecation = {
        kind: "deprecated-path",
        severity: "warning",
        file: current.scope.action?.path ?? parsed.path,
        where: current.where,
        field: current.field,
        value: current.value,
        resolved: "",
        message,
      };
      deprecated.set(key, current.deprecation);
    });
    const where = scope.action
      ? `action ${scope.action.name} step ${scope.action.stepIndex + 1}`
      : `${label}${step.id ? ` ${step.id}` : ""}`;
    const add = (field: string, value: unknown, hostFile = false): void => {
      if (typeof value !== "string" || value.length === 0) return;
      references.push({
        field,
        value,
        where,
        scope,
        ...(hostFile ? { hostFile } : {}),
      });
    };
    if ("eval" in step) {
      add("eval.file", step.eval.file);
      const args = step.eval.args ?? {};
      add("eval.args.filePath", args.filePath, true);
      const fixtureFiles = args.fixtureFiles;
      if (
        fixtureFiles &&
        typeof fixtureFiles === "object" &&
        !Array.isArray(fixtureFiles)
      ) {
        for (const [name, value] of Object.entries(fixtureFiles)) {
          add(`eval.args.fixtureFiles.${name}`, value, true);
        }
      }
    } else if ("transform" in step) {
      add("transform.file", step.transform.file);
      add("transform.input", step.transform.input);
    } else if ("upload" in step) {
      add("upload.path", step.upload.path);
    }
  }
  const specScope: StepFileScope = {
    specDir: dirname(parsed.path),
    declaringDir: dirname(parsed.path),
    warn: () => undefined,
  };
  for (const outcome of parsed.resolved.outcomes) {
    if (isScriptVerifier(outcome.verify) && outcome.verify.script.file) {
      references.push({
        field: "script.file",
        value: outcome.verify.script.file,
        where: `outcome ${outcome.id}`,
        scope: specScope,
      });
    }
  }

  for (const ref of references) {
    if (RUNTIME_PLACEHOLDER.test(ref.value)) continue;
    const file = ref.scope.action?.path ?? parsed.path;
    let resolved: string;
    let missing = false;
    current = { ...ref };
    if (ref.hostFile) {
      try {
        resolved = resolveScopedEvalHostFile(ref.value, ref.scope, ref.field);
      } catch {
        resolved = resolve(ref.scope.declaringDir, ref.value);
        missing = true;
      }
    } else {
      resolved = resolveStepFile(ref.value, ref.scope, ref.field);
      missing = !existsSync(resolved);
    }
    if (current.deprecation) current.deprecation.resolved = resolved;
    current = undefined;
    const base = {
      file,
      where: ref.where,
      field: ref.field,
      value: ref.value,
      resolved,
    };
    if (missing) {
      findings.push({
        ...base,
        kind: "missing-file",
        severity: "error",
        message: `${ref.field} "${ref.value}" (${ref.where}) does not exist: resolved to ${resolved}${
          ref.scope.action
            ? " (paths in an imported action resolve against the action file's directory)"
            : ""
        }`,
      });
      continue;
    }
    if (isAbsolute(ref.value) && !isInside(resolved, opts.projectRoot)) {
      findings.push({
        ...base,
        kind: "absolute-path",
        severity: "warning",
        message: `${ref.field} "${ref.value}" (${ref.where}) is an absolute host path outside the project (${opts.projectRoot}); use a path relative to the declaring file or \${config.dir}/… so the spec runs on other machines`,
      });
    }
  }
  findings.push(...deprecated.values());
  return findings;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
