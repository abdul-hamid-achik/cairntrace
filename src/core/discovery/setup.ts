import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type {
  DiscoverySetup,
  DiscoverySetupFromSpec,
  DiscoverySetupUse,
} from "../schema/discovery.v1";

/**
 * Setup before exploring: the session reaches its starting state through the
 * project's own building blocks instead of the agent re-recording a login.
 *
 *   setup: [{ use: login_as_admin, vars: {…} }, …]   imported reusable actions
 *   setup: { fromSpec: flows/x.yml, untilStep: open_profile }
 *
 * Both run through the runner (see stepRunner). An exported spec carries the
 * setup as written — `imports:` + `use:` steps, or the source spec's own
 * steps through `untilStep` — never the expanded action steps.
 */

export interface ResolvedSetup {
  /** Steps of the synthetic setup spec. */
  steps: Array<Record<string, unknown>>;
  /** `imports:` of the synthetic spec (absolute, or relative to specDir). */
  imports: string[];
  /** Extra top-level fields of the synthetic spec (fromSpec). */
  extra: Record<string, unknown>;
  /** Directory the synthetic spec must live in (fromSpec: the source's). */
  specDir?: string;
  /** Checkpoint the setup resumes (explicit `resume`, else the source's). */
  resume?: string;
  warnings: string[];
  /** What an export writes for this setup. */
  exported: SetupExport;
}

/** The exported form of a setup (imports are absolute; rebased on export). */
export interface SetupExport {
  steps: Array<Record<string, unknown>>;
  imports: string[];
  vars?: Record<string, unknown>;
  requires?: unknown;
  resume?: string;
  /** A fromSpec source's `coldStart: guest` (its steps need no session). */
  coldStart?: "guest";
}

export interface ResolveSetupOptions {
  /** Explicit `imports` input (relative to `cwd`). */
  imports?: readonly string[];
  /** Directory of the resolved config (or cwd without one). */
  configDir: string;
  /** Raw config object (reads `authoring.template.imports`). */
  config?: unknown;
  /** Explicit `resume` checkpoint. */
  resume?: string;
  cwd?: string;
}

/** Thrown when a setup cannot be resolved (bad action, step id, spec). */
export class SetupResolutionError extends Error {
  override name = "SetupResolutionError";
}

export async function resolveSetup(
  setup: DiscoverySetup,
  opts: ResolveSetupOptions,
): Promise<ResolvedSetup> {
  if (Array.isArray(setup)) return resolveUseSetup(setup, opts);
  return resolveFromSpecSetup(setup as DiscoverySetupFromSpec, opts);
}

/** `use:` steps for `setup` entries (exported and executed alike). */
export function useSteps(
  setup: readonly DiscoverySetupUse[],
): Array<Record<string, unknown>> {
  return setup.map((entry) =>
    entry.vars && Object.keys(entry.vars).length > 0
      ? { use: { action: entry.use, vars: entry.vars } }
      : { use: entry.use },
  );
}

async function resolveUseSetup(
  setup: readonly DiscoverySetupUse[],
  opts: ResolveSetupOptions,
): Promise<ResolvedSetup> {
  const files = await resolveActionFiles(
    setup.map((entry) => entry.use),
    opts,
  );
  const steps = useSteps(setup);
  return {
    steps,
    imports: files,
    extra: {},
    ...(opts.resume ? { resume: opts.resume } : {}),
    warnings: [],
    exported: {
      steps,
      imports: files,
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  };
}

/**
 * Absolute action files defining `names`: explicit imports first, then the
 * config's `authoring.template.imports`, then any `actions/` directory under
 * the config directory.
 */
export async function resolveActionFiles(
  names: readonly string[],
  opts: Pick<ResolveSetupOptions, "imports" | "configDir" | "config" | "cwd">,
): Promise<string[]> {
  const cwd = opts.cwd ?? process.cwd();
  const wanted = new Set(names);
  const found = new Map<string, string>();
  const consider = async (file: string): Promise<void> => {
    const name = await actionNameOf(file);
    if (name && wanted.has(name) && !found.has(name)) found.set(name, file);
  };
  const explicit = (opts.imports ?? []).map((path) => expandPath(path, cwd));
  for (const file of explicit) {
    const name = await actionNameOf(file);
    if (!name) {
      throw new SetupResolutionError(
        `import ${file} is not a reusable action (version/name/steps, no outcomes)`,
      );
    }
    if (wanted.has(name) && !found.has(name)) found.set(name, file);
  }
  for (const file of templateImports(opts.config, opts.configDir)) {
    if (found.size === wanted.size) break;
    await consider(file);
  }
  if (found.size < wanted.size) {
    for (const file of await scanActionFiles(opts.configDir)) {
      if (found.size === wanted.size) break;
      await consider(file);
    }
  }
  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new SetupResolutionError(
      `setup: action${missing.length === 1 ? "" : "s"} ${missing
        .map((name) => `"${name}"`)
        .join(", ")} not found — pass imports: [<path to the action file>], ` +
        `or keep the action under an actions/ directory of ${opts.configDir}`,
    );
  }
  return [...new Set(names.map((name) => found.get(name)!))];
}

/** `~/x`, absolute, or relative to `base`. */
export function expandPath(path: string, base: string): string {
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

function templateImports(config: unknown, configDir: string): string[] {
  const authoring =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)["authoring"]
      : undefined;
  const template =
    authoring && typeof authoring === "object"
      ? (authoring as Record<string, unknown>)["template"]
      : undefined;
  const imports =
    template && typeof template === "object"
      ? (template as Record<string, unknown>)["imports"]
      : undefined;
  if (!Array.isArray(imports)) return [];
  return imports
    .filter((path): path is string => typeof path === "string")
    .map((path) => expandPath(path, configDir));
}

/** The `name:` of a reusable action file, or undefined for anything else. */
async function actionNameOf(file: string): Promise<string | undefined> {
  try {
    const doc = parseYaml(await readFile(file, "utf8")) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
    const record = doc as Record<string, unknown>;
    if ("outcomes" in record || !Array.isArray(record["steps"])) {
      return undefined;
    }
    return typeof record["name"] === "string" ? record["name"] : undefined;
  } catch {
    return undefined;
  }
}

const SCAN_SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_FILES = 2000;

/** YAML files inside `actions/` directories under `root` (bounded walk). */
async function scanActionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let visited = 0;
  const walk = async (
    dir: string,
    depth: number,
    inActions: boolean,
  ): Promise<void> => {
    if (depth > SCAN_MAX_DEPTH || visited > SCAN_MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      visited++;
      if (visited > SCAN_MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP.has(entry.name)) continue;
        await walk(path, depth + 1, inActions || entry.name === "actions");
      } else if (inActions && /\.ya?ml$/i.test(entry.name)) {
        out.push(path);
      }
    }
  };
  await walk(root, 0, false);
  return out;
}

async function resolveFromSpecSetup(
  setup: DiscoverySetupFromSpec,
  opts: ResolveSetupOptions,
): Promise<ResolvedSetup> {
  const cwd = opts.cwd ?? process.cwd();
  const specPath = expandPath(setup.fromSpec, cwd);
  let doc: unknown;
  try {
    doc = parseYaml(await readFile(specPath, "utf8"));
  } catch (e) {
    throw new SetupResolutionError(
      `setup.fromSpec: cannot read ${setup.fromSpec}: ${(e as Error).message}`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SetupResolutionError(
      `setup.fromSpec: ${setup.fromSpec} is not a spec`,
    );
  }
  const spec = doc as Record<string, unknown>;
  const rawSteps = Array.isArray(spec["steps"])
    ? (spec["steps"] as Array<Record<string, unknown>>)
    : [];
  const until = stepPosition(rawSteps, setup.untilStep);
  if (until === undefined) {
    const ids = rawSteps
      .map((step) =>
        typeof step?.["id"] === "string" ? step["id"] : undefined,
      )
      .filter((id): id is string => id !== undefined);
    throw new SetupResolutionError(
      `setup.untilStep: no step ${JSON.stringify(setup.untilStep)} in ${setup.fromSpec}` +
        (ids.length > 0
          ? ` (step ids: ${ids.join(", ")}; or a 1-based position up to ${rawSteps.length})`
          : ` (its steps have no ids; use a 1-based position up to ${rawSteps.length})`),
    );
  }
  const steps = rawSteps.slice(0, until + 1);
  const specDir = dirname(specPath);
  const imports = Array.isArray(spec["imports"])
    ? (spec["imports"] as unknown[]).filter(
        (path): path is string => typeof path === "string",
      )
    : [];
  const session = spec["session"] as Record<string, unknown> | undefined;
  const sourceResume =
    session && typeof session["resume"] === "string"
      ? session["resume"]
      : undefined;
  const resume = opts.resume ?? sourceResume;
  const extra: Record<string, unknown> = {};
  for (const key of ["vars", "requires", "settleMs", "viewport", "redaction"]) {
    if (spec[key] !== undefined) extra[key] = spec[key];
  }
  const warnings: string[] = [];
  const preconditions = spec["preconditions"] as
    | { commands?: unknown[] }
    | undefined;
  if ((preconditions?.commands?.length ?? 0) > 0) {
    warnings.push(
      `setup.fromSpec: ${setup.fromSpec} has preconditions; discovery does not run them (run the spec, or its precondition commands, first when the steps need that data)`,
    );
  }
  return {
    steps,
    imports,
    extra,
    specDir,
    ...(resume ? { resume } : {}),
    warnings,
    exported: {
      steps,
      imports: imports.map((path) => expandPath(path, specDir)),
      ...(extra["vars"] !== undefined
        ? { vars: extra["vars"] as Record<string, unknown> }
        : {}),
      ...(extra["requires"] !== undefined
        ? { requires: extra["requires"] }
        : {}),
      ...(resume ? { resume } : {}),
      ...(spec["coldStart"] === "guest" ? { coldStart: "guest" as const } : {}),
    },
  };
}

function stepPosition(
  steps: ReadonlyArray<Record<string, unknown>>,
  until: string | number,
): number | undefined {
  if (typeof until === "number") {
    return until >= 1 && until <= steps.length ? until - 1 : undefined;
  }
  const byId = steps.findIndex((step) => step?.["id"] === until);
  if (byId >= 0) return byId;
  if (/^\d+$/.test(until)) return stepPosition(steps, Number(until));
  return undefined;
}

/** An import path for a spec written at `specPath` (POSIX separators). */
export function rebaseImport(absImport: string, specPath: string): string {
  return relative(dirname(specPath), absImport).split(sep).join("/");
}
