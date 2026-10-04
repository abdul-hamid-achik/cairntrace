import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/**
 * Where a step's relative file paths resolve (F13): the directory of the
 * file that DECLARES the step. For a spec step that is the spec's directory
 * (unchanged); for a step of an imported action it is the action file's
 * directory. A path that only exists under the old spec-relative resolution
 * is still used, with a deprecation warning naming the action and step.
 */
export interface StepFileScope {
  specDir: string;
  declaringDir: string;
  /** Set when the step comes from an imported action. */
  action?: { name: string; path: string; stepIndex: number };
  /** Deprecation sink: `key` identifies the action step + field. */
  warn: (key: string, message: string) => void;
}

/** Spec-level scope (a step declared in the spec itself). */
export function specFileScope(specDir: string): StepFileScope {
  return { specDir, declaringDir: specDir, warn: () => undefined };
}

function legacyPathWarning(
  scope: StepFileScope,
  field: string,
  raw: string,
  legacy: string,
): void {
  const action = scope.action;
  if (!action) return;
  scope.warn(
    `${action.path}#${action.stepIndex}#${field}`,
    `deprecated: ${field} "${raw}" in action "${action.name}" (step ${
      action.stepIndex + 1
    } of ${basename(action.path)}) was found relative to the spec, not the action file (${legacy}); paths in an imported action resolve against the action's own directory — move the file next to the action or use \${config.dir}/…`,
  );
}

/** Resolve a relative file path declared by a step (see StepFileScope). */
export function resolveStepFile(
  raw: string,
  scope: StepFileScope,
  field: string,
): string {
  if (isAbsolute(raw)) return raw;
  const primary = resolve(scope.declaringDir, raw);
  if (!scope.action || existsSync(primary)) return primary;
  const legacy = resolve(scope.specDir, raw);
  if (legacy !== primary && existsSync(legacy)) {
    legacyPathWarning(scope, field, raw, legacy);
    return legacy;
  }
  return primary;
}

/**
 * Eval host files (`args.filePath` / `args.fixtureFiles`): a spec step keeps
 * absolute → cwd → spec dir; an action step looks in the action's directory
 * first and falls back to cwd → spec dir with a deprecation warning.
 */
export function resolveScopedEvalHostFile(
  raw: string,
  scope: StepFileScope,
  field: string,
): string {
  if (!scope.action || isAbsolute(raw)) {
    return resolveEvalHostFile(raw, scope.specDir);
  }
  const primary = resolve(scope.declaringDir, raw);
  if (existsSync(primary)) return primary;
  for (const legacy of [
    resolve(process.cwd(), raw),
    resolve(scope.specDir, raw),
  ]) {
    if (existsSync(legacy)) {
      legacyPathWarning(scope, field, raw, legacy);
      return legacy;
    }
  }
  throw new Error(
    `host file not found: ${raw} (action dir=${scope.declaringDir} cwd=${process.cwd()} specDir=${scope.specDir})`,
  );
}

/** Resolve a host fixture path: absolute, cwd, then specDir. */
export function resolveEvalHostFile(filePath: string, specDir: string): string {
  const candidates = isAbsolute(filePath)
    ? [filePath]
    : [resolve(process.cwd(), filePath), resolve(specDir, filePath)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `host file not found: ${filePath} (cwd=${process.cwd()} specDir=${specDir})`,
  );
}

/** What a scope needs from a parsed spec (`parseSpec` result). */
export interface ParsedStepOrigins {
  /** Absolute spec path. */
  path: string;
  origins: ReadonlyArray<{ filePath: string; fileStepIdx: number }>;
  /** F14: origins of nested steps by resolved path (see parseSpec). */
  nestedOrigins?: ReadonlyMap<
    string,
    { filePath: string; fileStepIdx: number }
  >;
  actionsByName: ReadonlyMap<
    string,
    { path: string; action: { name: string } }
  >;
}

/**
 * The file scope of `resolved.steps[index]`: the spec's directory for a
 * spec step, the action's directory (plus its name and step index) for a
 * step that came from an imported action. `index` may also be the resolved
 * path of a step nested in a control-flow block (`"2/steps/0"`); a nested
 * step without a recorded origin falls back to its top-level step's scope.
 */
export function stepFileScopeAt(
  parsed: ParsedStepOrigins,
  index: number | string,
  warn: StepFileScope["warn"] = () => undefined,
): StepFileScope {
  const specDir = dirname(parsed.path);
  const origin =
    typeof index === "number"
      ? parsed.origins[index]
      : (parsed.nestedOrigins?.get(index) ??
        parsed.origins[Number.parseInt(index, 10)]);
  const declaringFile = origin?.filePath ?? parsed.path;
  if (declaringFile === parsed.path) {
    return { specDir, declaringDir: specDir, warn };
  }
  let actionName: string | undefined;
  for (const loaded of parsed.actionsByName.values()) {
    if (loaded.path === declaringFile) actionName = loaded.action.name;
  }
  return {
    specDir,
    declaringDir: dirname(declaringFile),
    ...(actionName !== undefined
      ? {
          action: {
            name: actionName,
            path: declaringFile,
            stepIndex: origin?.fileStepIdx ?? 0,
          },
        }
      : {}),
    warn,
  };
}
