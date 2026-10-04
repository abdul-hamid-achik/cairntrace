import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type YAMLMap,
} from "yaml";
import { z, type ZodError, type ZodTypeAny } from "zod";
import {
  ConfigIncludeSchema,
  ConfigSchema,
  type Config,
  type ConfigVarValue,
} from "../schema/config.v1";
import { parseConfigText, restoreInertText, type EnvLateBinding } from "./text";
import { readVarPath, renderVarValue, varRefRoot } from "./varValue";

/**
 * F7 config composition: `include:`, top-level `vars:`, environment
 * `extends:` and var-to-var references, applied to the parsed config before
 * anything reads it. A config that uses none of them comes out exactly as
 * the schema parsed it.
 *
 * Order:
 *   1. the config text is parsed like before (`${env.X}`, merge keys,
 *      `${config.dir}`);
 *   2. `include:` files (paths or globs relative to the file listing them,
 *      nested includes allowed, cycles are errors) contribute `vars`,
 *      `fixtures`, `gates`, `datasources` and `suites` entries — by name,
 *      later files win and the including file wins over what it includes;
 *   3. the merged document is validated as authored (errors keep their
 *      authored paths);
 *   4. every environment is deep-merged over its `extends` chain, its vars
 *      are the top-level `vars` overridden by the chain's vars by name, and
 *      `${vars.X}` inside var values resolves once per environment (typed
 *      when the value is exactly one reference, JSON in a longer string);
 *   5. the composed document is validated again.
 */

/** Top-level sections an included file may carry. */
export const INCLUDABLE_SECTIONS = [
  "vars",
  "fixtures",
  "gates",
  "datasources",
  "suites",
] as const;

const MAX_INCLUDE_FILES = 500;
const MAX_GLOB_DEPTH = 10;

/** A config error raised by composition (include, extends, var references). */
export class ConfigCompositionError extends Error {
  constructor(
    readonly configPath: string,
    readonly problems: string[],
  ) {
    super(
      `invalid ${configPath}:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "ConfigCompositionError";
  }
}

export interface ConfigSourceRef {
  /** Absolute path of the file. */
  file: string;
  /** 1-based line of the key, when known. */
  line?: number;
}

export interface VarDefinition extends ConfigSourceRef {
  /** `vars` (top-level, also from an included file) or `environments.<env>.vars`. */
  scope: string;
  /** Inherited through a YAML merge key / alias: the anchor's owner. */
  inheritedFrom?: string;
  /** The value as parsed (`${env.X}` substituted, var references not yet). */
  value: unknown;
  /** The authored scalar when it held placeholders (unsubstituted). */
  template?: string;
  /**
   * The authored value holds `${env.X}` / `${secrets.X}` somewhere (at any
   * depth): its effective value carries environment data.
   */
  fromEnvironment?: true;
  /** The authored (unsubstituted) list / object when it held placeholders. */
  authored?: unknown;
}

export interface ComposedVar {
  /** The effective value (var references resolved). */
  value: ConfigVarValue;
  /** Every definition that applies, lowest precedence first; the last wins. */
  definitions: VarDefinition[];
}

export interface ConfigFinding {
  level: "error" | "warning" | "info";
  code: "include-override" | "include-empty" | "unused-var" | "var-reference";
  message: string;
  /** Dotted config key, e.g. `vars.region` or `fixtures.supplier`. */
  key?: string;
  file?: string;
  line?: number;
  overriddenBy?: ConfigSourceRef;
  /** The override wrote the same value. */
  identical?: true;
}

export interface ConfigComposition {
  /** The config file, then every included file in merge order. */
  files: string[];
  /** Top-level var definitions per name, in merge order (last wins). */
  topLevel: Record<string, VarDefinition[]>;
  /** Top-level vars resolved without an environment (unresolved refs kept). */
  baseVars: Record<string, ConfigVarValue>;
  /**
   * Per environment: its `extends` chain (root first, itself last), vars,
   * and the vars whose value still holds a `${vars.X}` no config var defines
   * (`deferred`: resolved at run time from `--var` / a spec's `vars:`).
   */
  environments: Record<
    string,
    {
      chain: string[];
      vars: Record<string, ComposedVar>;
      deferred?: DeferredVarReference[];
    }
  >;
  /** Where each effective section entry (`fixtures.<name>`, …) is defined. */
  entries: Record<string, ConfigSourceRef>;
  findings: ConfigFinding[];
}

export type ComposeResult =
  | {
      ok: true;
      config: Config;
      composition: ConfigComposition;
      /**
       * Late binding only: dotted paths of typed fields whose late-bound
       * value the schema could not hold, so a stand-in (see
       * `EnvLateBinding.standIns`) took its place. A reader that emits one
       * of these must refuse instead of using the stand-in.
       */
      lateUnbound?: string[];
    }
  | {
      ok: false;
      stage: "yaml" | "include" | "schema" | "compose";
      errors: string[];
      /** The original error (YAML parse error, ZodError) when there is one. */
      cause?: unknown;
      /** Top-level keys of the document, when it parsed. */
      keys: string[];
      findings: ConfigFinding[];
    };

export interface ComposeOptions {
  /** Absolute path of the config file the text came from. */
  configPath: string;
  envRef?: (name: string) => string;
  env?: Record<string, string | undefined>;
  /** Exporter late binding of every `${env.X}` (see EnvLateBinding). */
  late?: EnvLateBinding;
}

/** Read and compose a config file. */
export async function composeConfigFile(
  opts: ComposeOptions,
): Promise<ComposeResult> {
  return composeConfigText(await readFile(opts.configPath, "utf8"), opts);
}

/** Compose already-read config text (see the module comment). */
export async function composeConfigText(
  text: string,
  options: ComposeOptions,
): Promise<ComposeResult> {
  const result = await composeMarked(text, options);
  if (!result.ok) return result;
  // Environment values were inert while var references resolved; put
  // their `${` back for every reader.
  return {
    ok: true,
    config: restoreInertText(result.config),
    composition: restoreInertText(result.composition),
    ...(result.lateUnbound && result.lateUnbound.length > 0
      ? { lateUnbound: result.lateUnbound }
      : {}),
  };
}

async function composeMarked(
  text: string,
  options: ComposeOptions,
): Promise<ComposeResult> {
  // `${` inside an env VALUE is marked inert while composing: only what the
  // author wrote is ever read as a `${vars.X}` reference.
  const opts: ComposeOptions & { inertEnvValues: true } = {
    ...options,
    inertEnvValues: true,
  };
  const configPath = opts.configPath;
  let raw: unknown;
  try {
    raw = parseConfigText(text, opts);
  } catch (e) {
    return {
      ok: false,
      stage: "yaml",
      errors: [`YAML parse error: ${(e as Error).message}`],
      cause: e,
      keys: [],
      findings: [],
    };
  }
  if (!isPlainObject(raw)) {
    // Not a mapping at all: the schema says so, as before composition.
    const parsed = ConfigSchema.safeParse(raw);
    return parsed.success
      ? {
          ok: false,
          stage: "schema",
          errors: ["(root): Expected object"],
          keys: [],
          findings: [],
        }
      : {
          ok: false,
          stage: "schema",
          errors: zodErrors(parsed.error),
          cause: parsed.error,
          keys: [],
          findings: [],
        };
  }
  const keys = Object.keys(raw);
  const findings: ConfigFinding[] = [];
  const main: Layer = {
    file: configPath,
    data: raw,
    locations: indexLocations(text),
  };
  const rel = (path: string): string => relativeTo(dirname(configPath), path);

  // ---- include ------------------------------------------------------------
  const layers: Layer[] = [];
  const envLayers = new Map<string, Layer[]>();
  const includeErrors: string[] = [];
  if (raw.include !== undefined) {
    const list = ConfigIncludeSchema.safeParse(raw.include);
    if (!list.success) {
      return {
        ok: false,
        stage: "schema",
        errors: list.error.issues.map(
          (issue) =>
            `include${
              issue.path.length > 0 ? `.${issue.path.join(".")}` : ""
            }: ${issue.message}`,
        ),
        cause: list.error,
        keys,
        findings,
      };
    }
    await collectIncludes(
      configPath,
      list.data,
      [configPath],
      new Set([configPath]),
      { layers, errors: includeErrors, findings, opts, rel },
    );
  }
  // Environment-scoped includes: `environments.<name>.include` lists files
  // that hold that environment's own vars. Each environment gets its own
  // seen-set and cycle chain, so two environments may share a file.
  if (isPlainObject(raw.environments)) {
    for (const [envName, env] of Object.entries(raw.environments)) {
      if (!isPlainObject(env) || env.include === undefined) continue;
      const list = ConfigIncludeSchema.safeParse(env.include);
      if (!list.success) {
        return {
          ok: false,
          stage: "schema",
          errors: list.error.issues.map(
            (issue) =>
              `environments.${envName}.include${
                issue.path.length > 0 ? `.${issue.path.join(".")}` : ""
              }: ${issue.message}`,
          ),
          cause: list.error,
          keys,
          findings,
        };
      }
      const envFiles: Layer[] = [];
      await collectIncludes(
        configPath,
        list.data,
        [configPath],
        new Set([configPath]),
        {
          layers: envFiles,
          errors: includeErrors,
          findings,
          opts,
          rel,
          env: envName,
        },
      );
      envLayers.set(envName, envFiles);
    }
  }
  if (includeErrors.length > 0) {
    return {
      ok: false,
      stage: "include",
      errors: includeErrors,
      keys,
      findings,
    };
  }
  const merged = mergeSections(main, layers, findings, rel);
  mergeEnvironmentVars(merged, main, envLayers, findings, rel);

  // ---- validate as authored ----------------------------------------------
  const lateUnbound = new Set<string>();
  const authoredCheck = validateLate(merged.document, opts.late);
  for (const path of authoredCheck.unbound) lateUnbound.add(path);
  merged.document = authoredCheck.document;
  const authored = authoredCheck.parsed;
  if (!authored.success) {
    return {
      ok: false,
      stage: "schema",
      errors: zodErrors(authored.error),
      cause: authored.error,
      keys,
      findings,
    };
  }

  // ---- extends + vars ----------------------------------------------------
  const composed = composeEnvironments(merged, main, findings);
  if (composed.errors.length > 0) {
    return {
      ok: false,
      stage: "compose",
      errors: composed.errors,
      keys,
      findings,
    };
  }
  const composition: ConfigComposition = {
    files: [
      ...new Set([
        configPath,
        ...layers.map((layer) => layer.file),
        ...[...envLayers.values()].flatMap((list) =>
          list.map((layer) => layer.file),
        ),
      ]),
    ],
    topLevel: merged.topLevel,
    baseVars: composed.baseVars,
    environments: composed.environments,
    entries: merged.entries,
    findings,
  };
  const unboundList = (): { lateUnbound?: string[] } =>
    lateUnbound.size > 0 ? { lateUnbound: [...lateUnbound].toSorted() } : {};
  if (!composed.changed) {
    return { ok: true, config: authored.data, composition, ...unboundList() };
  }
  const finalCheck = validateLate(composed.document, opts.late);
  for (const path of finalCheck.unbound) lateUnbound.add(path);
  const final = finalCheck.parsed;
  if (!final.success) {
    return {
      ok: false,
      stage: "schema",
      errors: zodErrors(final.error).map(
        (message) => `${message} (after extends / vars composition)`,
      ),
      cause: final.error,
      keys,
      findings,
    };
  }
  return { ok: true, config: final.data, composition, ...unboundList() };
}

/**
 * Validate a (possibly late-bound) document. Under late binding with
 * `standIns`, a field the schema rejects while it holds a late-bound string
 * gets the hook's stand-ins, one at a time, until the schema accepts it (a
 * URL field, a number, an enum): the stand-in only lets the rest of the
 * config load and the path is reported, so no reader mistakes it for the
 * authored value. A rejection that no stand-in fixes stays an error.
 */
function validateLate(
  document: Record<string, unknown>,
  late: EnvLateBinding | undefined,
): {
  parsed: ReturnType<typeof ConfigSchema.safeParse>;
  document: Record<string, unknown>;
  unbound: string[];
} {
  let parsed = ConfigSchema.safeParse(document);
  const standIns = late?.standIns;
  if (parsed.success || !standIns) return { parsed, document, unbound: [] };
  const attempts = new Map<
    string,
    { path: Array<string | number>; candidates: unknown[]; next: number }
  >();
  let working: Record<string, unknown> = document;
  for (let round = 0; round < 64 && !parsed.success; round++) {
    let progressed = false;
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      if (seen.has(key)) continue;
      seen.add(key);
      let state = attempts.get(key);
      if (!state) {
        const original = valueAt(document, issue.path);
        if (typeof original !== "string") continue;
        const candidates = standIns(original);
        if (candidates.length === 0) continue;
        state = { path: [...issue.path], candidates, next: 0 };
        attempts.set(key, state);
      }
      if (state.next >= state.candidates.length) continue;
      if (working === document) working = structuredClone(document);
      setValueAt(working, state.path, state.candidates[state.next++]);
      progressed = true;
    }
    if (!progressed) break;
    parsed = ConfigSchema.safeParse(working);
  }
  return {
    parsed,
    document: working,
    unbound: [...attempts.values()]
      .filter((state) => state.next > 0)
      .map((state) => state.path.join(".")),
  };
}

function valueAt(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function setValueAt(
  root: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  value: unknown,
): void {
  let current: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (current === null || typeof current !== "object") return;
    current = (current as Record<string | number, unknown>)[key];
  }
  if (current !== null && typeof current === "object" && path.length > 0) {
    (current as Record<string | number, unknown>)[path.at(-1)!] = value;
  }
}

function zodErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/* ------------------------------------------------------------------------ */
/* include                                                                   */
/* ------------------------------------------------------------------------ */

interface Layer {
  file: string;
  data: Record<string, unknown>;
  locations: Locations;
}

interface IncludeContext {
  layers: Layer[];
  errors: string[];
  findings: ConfigFinding[];
  opts: ComposeOptions;
  rel: (path: string) => string;
  /** Environment-scoped include: the files hold this environment's vars. */
  env?: string;
}

let includeSchema: ZodTypeAny | undefined;
let envIncludeSchema: ZodTypeAny | undefined;

/** The top-level keys of the config schema (refinements unwrapped). */
function configShape(): Record<string, ZodTypeAny> {
  let current: ZodTypeAny = ConfigSchema;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof z.ZodObject) {
      return current.shape as Record<string, ZodTypeAny>;
    }
    if (!(current instanceof z.ZodEffects)) break;
    current = current.innerType() as ZodTypeAny;
  }
  return {};
}

/** The keys an included file may carry (`suites` once the config has it). */
function includableKeys(): string[] {
  const shape = configShape();
  return [...INCLUDABLE_SECTIONS.filter((key) => key in shape), "include"];
}

/**
 * An included file: the includable sections, each validated entry by entry
 * with the config's own entry schemas (cross-entry rules — a fixture's
 * `needs`, gate references — run on the merged config).
 */
function includeFileSchema(): ZodTypeAny {
  if (includeSchema) return includeSchema;
  const shape = configShape();
  const fields: Record<string, ZodTypeAny> = {
    include: ConfigIncludeSchema.optional(),
  };
  for (const key of INCLUDABLE_SECTIONS) {
    const section = shape[key];
    if (section) fields[key] = entryLevel(section).optional();
  }
  includeSchema = z.object(fields).strict();
  return includeSchema;
}

/**
 * A file listed by `environments.<name>.include`: that environment's `vars`
 * (validated entry by entry like the config's) and further includes of the
 * same environment.
 */
function envIncludeFileSchema(): ZodTypeAny {
  if (envIncludeSchema) return envIncludeSchema;
  const vars = configShape().vars;
  const fields: Record<string, ZodTypeAny> = {
    include: ConfigIncludeSchema.optional(),
  };
  if (vars) fields.vars = entryLevel(vars).optional();
  envIncludeSchema = z.object(fields).strict();
  return envIncludeSchema;
}

/** A record schema without its registry-level refinements. */
function entryLevel(schema: ZodTypeAny): ZodTypeAny {
  let current: ZodTypeAny = schema;
  for (let depth = 0; depth < 8; depth++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as ZodTypeAny;
    } else if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as ZodTypeAny;
    } else if (current instanceof z.ZodLazy) {
      current = current.schema as ZodTypeAny;
    } else {
      break;
    }
  }
  if (current instanceof z.ZodRecord) {
    return z.record(
      current.keySchema as z.ZodString,
      current.valueSchema as ZodTypeAny,
    );
  }
  return schema;
}

async function collectIncludes(
  fromFile: string,
  patterns: readonly string[],
  chain: readonly string[],
  seen: Set<string>,
  ctx: IncludeContext,
): Promise<void> {
  const base = dirname(fromFile);
  for (const pattern of patterns) {
    const absolute = isAbsolute(pattern) ? pattern : resolve(base, pattern);
    const glob = hasGlob(pattern);
    const files = glob ? await expandGlob(absolute) : [absolute];
    if (glob && files.length === 0) {
      ctx.findings.push({
        level: "warning",
        code: "include-empty",
        message: `include "${pattern}" (in ${ctx.rel(fromFile)}) matched no .yml/.yaml file`,
        file: fromFile,
      });
    }
    for (const file of files) {
      if (chain.includes(file)) {
        ctx.errors.push(
          `include cycle: ${[...chain, file].map(ctx.rel).join(" → ")}`,
        );
        continue;
      }
      if (seen.has(file)) continue;
      seen.add(file);
      if (seen.size > MAX_INCLUDE_FILES) {
        ctx.errors.push(
          `include: more than ${MAX_INCLUDE_FILES} files — narrow the globs`,
        );
        return;
      }
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        ctx.errors.push(
          `include: ${ctx.rel(file)} does not exist (listed as "${pattern}" in ${ctx.rel(fromFile)}, relative to its directory)`,
        );
        continue;
      }
      let data: unknown;
      try {
        data = parseConfigText(text, ctx.opts);
      } catch (e) {
        ctx.errors.push(
          `${ctx.rel(file)}: YAML parse error: ${(e as Error).message}`,
        );
        continue;
      }
      if (data === null || data === undefined) data = {};
      const check = (
        ctx.env !== undefined ? envIncludeFileSchema() : includeFileSchema()
      ).safeParse(data);
      if (!check.success) {
        for (const issue of (check.error as ZodError).issues) {
          const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
          const hint =
            issue.code !== "unrecognized_keys"
              ? ""
              : ctx.env !== undefined
                ? ` (a file listed by environments.${ctx.env}.include may carry vars and include; fixtures, gates, datasources and suites go in a top-level include)`
                : ` (an included file may carry ${includableKeys().join(", ")}; per-environment vars go in a file listed by environments.<name>.include)`;
          ctx.errors.push(`${ctx.rel(file)}: ${path}: ${issue.message}${hint}`);
        }
        continue;
      }
      const record = data as Record<string, unknown>;
      const nested = record.include;
      if (Array.isArray(nested)) {
        await collectIncludes(
          file,
          nested as string[],
          [...chain, file],
          seen,
          ctx,
        );
      }
      ctx.layers.push({ file, data: record, locations: indexLocations(text) });
    }
  }
}

interface MergedSections {
  document: Record<string, unknown>;
  topLevel: Record<string, VarDefinition[]>;
  entries: Record<string, ConfigSourceRef>;
  /**
   * Environments that list `include:` files: per environment and var name,
   * every definition of that environment's own vars (its included files in
   * order, then what it writes itself), lowest precedence first.
   */
  envVarDefs: Record<string, Record<string, VarDefinition[]>>;
}

/**
 * Merge the includable sections of every layer by entry name, then the
 * config's own entries on top. Every replaced entry is an `include-override`
 * finding.
 */
function mergeSections(
  main: Layer,
  layers: readonly Layer[],
  findings: ConfigFinding[],
  rel: (path: string) => string,
): MergedSections {
  const document: Record<string, unknown> = { ...main.data };
  const topLevel: Record<string, VarDefinition[]> = {};
  const entries: Record<string, ConfigSourceRef> = {};
  for (const key of INCLUDABLE_SECTIONS) {
    const sources = [...layers, main].filter(
      (layer) => layer.data[key] !== undefined,
    );
    if (sources.length === 0) continue;
    // A malformed section of the config itself is the schema's to report.
    if (sources.some((layer) => !isPlainObject(layer.data[key]))) continue;
    const merged: Record<string, unknown> = {};
    const from = new Map<string, ConfigSourceRef>();
    for (const layer of sources) {
      for (const [name, value] of Object.entries(
        layer.data[key] as Record<string, unknown>,
      )) {
        const location = layer.locations.get(`${key}.${name}`);
        const at: ConfigSourceRef = {
          file: layer.file,
          ...(location ? { line: location.line } : {}),
        };
        const previous = from.get(name);
        if (previous && Object.hasOwn(merged, name)) {
          const identical =
            JSON.stringify(merged[name]) === JSON.stringify(value);
          findings.push({
            level: "info",
            code: "include-override",
            key: `${key}.${name}`,
            file: previous.file,
            ...(previous.line !== undefined ? { line: previous.line } : {}),
            overriddenBy: at,
            ...(identical ? { identical: true as const } : {}),
            message: `${key}.${name} from ${formatRef(previous, rel)} is overridden by ${formatRef(at, rel)}${
              identical ? " (same value)" : ""
            }`,
          });
        }
        merged[name] = value;
        from.set(name, at);
        if (key === "vars") {
          (topLevel[name] ??= []).push({
            scope: "vars",
            ...at,
            value,
            ...authoredOf(location),
          });
        }
      }
    }
    document[key] = merged;
    for (const [name, at] of from) entries[`${key}.${name}`] = at;
  }
  return { document, topLevel, entries, envVarDefs: {} };
}

/**
 * Fold each environment's included files into its own `vars`: the files in
 * order, then the vars the environment writes itself (the including file
 * wins over what it includes, as at the top level). Every replaced var is an
 * `include-override` finding. The environment's `include` key is dropped
 * from the merged document; the environment's `extends` chain and the
 * top-level vars apply afterwards, unchanged.
 */
function mergeEnvironmentVars(
  merged: MergedSections,
  main: Layer,
  envLayers: ReadonlyMap<string, readonly Layer[]>,
  findings: ConfigFinding[],
  rel: (path: string) => string,
): void {
  const envs = merged.document.environments;
  if (!isPlainObject(envs)) return;
  let rewritten: Record<string, unknown> | undefined;
  for (const [envName, env] of Object.entries(envs)) {
    if (!isPlainObject(env) || env.include === undefined) continue;
    const files = envLayers.get(envName) ?? [];
    const inline = env.vars;
    // A malformed `vars` of the environment itself is the schema's to report.
    if (inline !== undefined && !isPlainObject(inline)) continue;
    const vars: Record<string, unknown> = {};
    const defs: Record<string, VarDefinition[]> = {};
    const from = new Map<string, ConfigSourceRef>();
    const put = (
      name: string,
      value: unknown,
      at: ConfigSourceRef,
      location: Location | undefined,
    ): void => {
      const previous = from.get(name);
      if (previous && Object.hasOwn(vars, name)) {
        const identical = JSON.stringify(vars[name]) === JSON.stringify(value);
        const key = `environments.${envName}.vars.${name}`;
        findings.push({
          level: "info",
          code: "include-override",
          key,
          file: previous.file,
          ...(previous.line !== undefined ? { line: previous.line } : {}),
          overriddenBy: at,
          ...(identical ? { identical: true as const } : {}),
          message: `${key} from ${formatRef(previous, rel)} is overridden by ${formatRef(at, rel)}${
            identical ? " (same value)" : ""
          }`,
        });
      }
      vars[name] = value;
      from.set(name, at);
      (defs[name] ??= []).push({
        scope: `environments.${envName}.vars`,
        ...at,
        ...(location?.inheritedFrom
          ? { inheritedFrom: location.inheritedFrom }
          : {}),
        value,
        ...authoredOf(location),
      });
    };
    for (const layer of files) {
      const own = layer.data.vars;
      if (!isPlainObject(own)) continue;
      for (const [name, value] of Object.entries(own)) {
        const location = layer.locations.get(`vars.${name}`);
        put(
          name,
          value,
          {
            file: layer.file,
            ...(location ? { line: location.line } : {}),
          },
          location,
        );
      }
    }
    for (const [name, value] of Object.entries(inline ?? {})) {
      const location = main.locations.get(
        `environments.${envName}.vars.${name}`,
      );
      put(
        name,
        value,
        {
          file: main.file,
          ...(location ? { line: location.line } : {}),
        },
        location,
      );
    }
    const { include: _include, ...rest } = env;
    rewritten ??= { ...envs };
    rewritten[envName] =
      Object.keys(vars).length > 0 || inline !== undefined
        ? { ...rest, vars }
        : rest;
    merged.envVarDefs[envName] = defs;
  }
  if (rewritten)
    merged.document = { ...merged.document, environments: rewritten };
}

/* ------------------------------------------------------------------------ */
/* extends + vars                                                            */
/* ------------------------------------------------------------------------ */

interface ComposedEnvironments {
  document: Record<string, unknown>;
  environments: ConfigComposition["environments"];
  baseVars: Record<string, ConfigVarValue>;
  errors: string[];
  /** False when nothing differs from the authored document. */
  changed: boolean;
}

function composeEnvironments(
  merged: MergedSections,
  main: Layer,
  findings: ConfigFinding[],
): ComposedEnvironments {
  const document = merged.document;
  const envs = (
    isPlainObject(document.environments) ? document.environments : {}
  ) as Record<string, Record<string, unknown>>;
  const names = Object.keys(envs);
  const errors: string[] = [];
  const reported = new Set<string>();
  const report = (message: string, dedupeKey = message): void => {
    if (reported.has(dedupeKey)) return;
    reported.add(dedupeKey);
    errors.push(message);
  };

  // extends chains (root first)
  const chains: Record<string, string[]> = {};
  for (const name of names) {
    const chain: string[] = [];
    let current: string | undefined = name;
    while (current !== undefined) {
      if (chain.includes(current)) {
        const cycle = [...chain.slice(chain.indexOf(current)), current];
        report(
          `environments.${chain[chain.length - 1]}.extends: cycle ${cycle.join(" → ")}`,
          `cycle:${[...new Set(cycle)].toSorted().join(",")}`,
        );
        break;
      }
      chain.push(current);
      const parent: unknown = envs[current]?.extends;
      if (typeof parent !== "string") break;
      if (!Object.hasOwn(envs, parent)) {
        report(
          `environments.${current}.extends: unknown environment "${parent}" (defined: ${names.toSorted().join(", ")})`,
        );
        break;
      }
      current = parent;
    }
    chains[name] = chain.toReversed();
  }
  if (errors.length > 0) {
    return {
      document,
      environments: {},
      baseVars: {},
      errors,
      changed: false,
    };
  }

  const topVars = (isPlainObject(document.vars) ? document.vars : {}) as Record<
    string,
    unknown
  >;
  const base = resolveVarReferences(topVars);
  let changed = Object.keys(topVars).length > 0;

  const composedEnvs: Record<string, unknown> = {};
  const environments: ConfigComposition["environments"] = {};
  const varProblems = new Map<string, { message: string; envs: string[] }>();
  const deferredRefs = new Map<
    string,
    {
      key: string;
      ref: string;
      owner: VarDefinition | undefined;
      prefix: string;
      envs: string[];
    }
  >();
  for (const name of names) {
    // An alias is the same environment under another name: it carries no
    // vars or chain of its own (readers canonicalize to the target).
    if (typeof envs[name]!.alias === "string") {
      composedEnvs[name] = envs[name];
      continue;
    }
    const chain = chains[name]!;
    if (chain.length > 1) changed = true;
    let env: Record<string, unknown> = {};
    for (const member of chain) env = mergeEnvironment(env, envs[member]!);
    if (envs[name]!.extends !== undefined) env.extends = envs[name]!.extends;
    else delete env.extends;

    // vars: top-level, then the chain (root first), by name
    const definitions: Record<string, VarDefinition[]> = {};
    for (const [varName, defs] of Object.entries(merged.topLevel)) {
      definitions[varName] = [...defs];
    }
    const bag: Record<string, unknown> = { ...topVars };
    for (const member of chain) {
      const own = envs[member]!.vars;
      if (!isPlainObject(own)) continue;
      for (const [varName, value] of Object.entries(own)) {
        bag[varName] = value;
        const known = merged.envVarDefs[member]?.[varName];
        if (known) {
          (definitions[varName] ??= []).push(...known);
          continue;
        }
        const location = main.locations.get(
          `environments.${member}.vars.${varName}`,
        );
        (definitions[varName] ??= []).push({
          scope: `environments.${member}.vars`,
          file: main.file,
          ...(location ? { line: location.line } : {}),
          ...(location?.inheritedFrom
            ? { inheritedFrom: location.inheritedFrom }
            : {}),
          value,
          ...authoredOf(location),
        });
      }
    }
    const resolved = resolveVarReferences(bag);
    for (const problem of resolved.problems) {
      const owner = definitions[problem.name]?.at(-1);
      const key = `${owner?.scope ?? "vars"}.${problem.name}: ${problem.message}`;
      const entry = varProblems.get(key) ?? { message: key, envs: [] };
      entry.envs.push(name);
      varProblems.set(key, entry);
    }
    for (const ref of resolved.deferred) {
      const owner = definitions[ref.name]?.at(-1);
      const key = `${owner?.scope ?? "vars"}.${ref.name}: \${vars.${ref.ref}}`;
      const entry = deferredRefs.get(key) ?? {
        key: `vars.${ref.name}`,
        ref: ref.ref,
        owner,
        prefix: key,
        envs: [],
      };
      entry.envs.push(name);
      deferredRefs.set(key, entry);
    }
    if (resolved.changed) changed = true;
    const hasVars =
      Object.keys(bag).length > 0 || envs[name]!.vars !== undefined;
    if (hasVars) env.vars = resolved.vars;
    composedEnvs[name] = env;
    environments[name] = {
      chain,
      vars: Object.fromEntries(
        Object.entries(resolved.vars).map(([varName, value]) => [
          varName,
          {
            value: value as ConfigVarValue,
            definitions: definitions[varName] ?? [],
          },
        ]),
      ),
      ...(resolved.deferred.length > 0 ? { deferred: resolved.deferred } : {}),
    };
  }
  for (const entry of deferredRefs.values()) {
    findings.push({
      level: "warning",
      code: "var-reference",
      key: entry.key,
      ...(entry.owner ? { file: entry.owner.file } : {}),
      ...(entry.owner?.line !== undefined ? { line: entry.owner.line } : {}),
      message: `${entry.prefix} is not defined by the config (environment${
        entry.envs.length > 1 ? "s" : ""
      } ${entry.envs.join(", ")}); it is left for \`--var ${entry.ref}=…\` or a spec's vars: at run time`,
    });
  }
  for (const { message, envs: where } of varProblems.values()) {
    errors.push(
      `${message} (environment${
        where.length > 1 ? "s" : ""
      } ${where.join(", ")})`,
    );
  }
  return {
    document: changed ? { ...document, environments: composedEnvs } : document,
    environments,
    baseVars: base.vars as Record<string, ConfigVarValue>,
    errors,
    changed,
  };
}

/**
 * Deep-merge one environment over another: objects merge key by key, lists
 * and scalars (and `false`) replace, `vars` merge by name (a var's value is
 * replaced whole, never merged into).
 */
function mergeEnvironment(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (key === "vars") {
      out.vars =
        isPlainObject(base.vars) && isPlainObject(value)
          ? { ...base.vars, ...value }
          : value;
      continue;
    }
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = deepMerge(base[key], value);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* var references                                                            */
/* ------------------------------------------------------------------------ */

const VAR_REF = /\$\{vars\.([^}\s]+)\}/g;
const WHOLE_VAR_REF = /^\$\{vars\.([^}\s]+)\}$/;

export interface VarReferenceProblem {
  /** The var whose value holds the reference. */
  name: string;
  message: string;
}

/** A `${vars.X}` whose `X` no config var defines: left for run time. */
export interface DeferredVarReference {
  /** The var whose value holds the reference. */
  name: string;
  /** The referenced root name (what `--var` or a spec's `vars:` may supply). */
  ref: string;
}

/**
 * Resolve `${vars.X}` (and `${vars.X.key}`, `${vars.X:-default}`) inside the
 * values of one vars bag, once. A value that is exactly one reference takes
 * the referenced value with its type; a reference inside a longer string
 * renders with {@link renderVarValue}. Cycles and paths missing inside a
 * defined var are problems; a reference to a var the bag does not define is
 * deferred (`--var` or a spec's `vars:` may supply it at run time). Either
 * way the placeholder text is kept.
 */
export function resolveVarReferences(bag: Readonly<Record<string, unknown>>): {
  vars: Record<string, unknown>;
  problems: VarReferenceProblem[];
  deferred: DeferredVarReference[];
  changed: boolean;
} {
  const done = new Map<string, unknown>();
  const stack: string[] = [];
  const problems: VarReferenceProblem[] = [];
  const deferred: DeferredVarReference[] = [];
  const cycles = new Set<string>();
  let changed = false;

  const resolveName = (name: string): unknown => {
    if (done.has(name)) return done.get(name);
    const at = stack.indexOf(name);
    if (at >= 0) {
      const cycle = [...stack.slice(at), name];
      const key = [...new Set(cycle)].toSorted().join(",");
      if (!cycles.has(key)) {
        cycles.add(key);
        problems.push({
          name: stack[at]!,
          message: `reference cycle ${cycle.map((n) => `vars.${n}`).join(" → ")}`,
        });
      }
      return bag[name];
    }
    stack.push(name);
    const value = resolveValue(bag[name], name);
    stack.pop();
    done.set(name, value);
    return value;
  };

  const resolveRef = (
    body: string,
    owner: string,
  ): { found: true; value: unknown } | { found: false } => {
    const split = body.indexOf(":-");
    const ref = split >= 0 ? body.slice(0, split) : body;
    const fallback = split >= 0 ? body.slice(split + 2) : undefined;
    const root = varRefRoot(ref, (name) => Object.hasOwn(bag, name));
    if (!Object.hasOwn(bag, root)) {
      if (fallback !== undefined) return { found: true, value: fallback };
      deferred.push({ name: owner, ref: root });
      return { found: false };
    }
    const value = resolveName(root);
    if (root === ref) return { found: true, value };
    const hit = readVarPath(value, ref.slice(root.length + 1));
    if (hit.found) return hit;
    if (fallback !== undefined) return { found: true, value: fallback };
    problems.push({
      name: owner,
      message: `\${vars.${ref}} does not exist (vars.${root} has no ${ref.slice(root.length + 1)})`,
    });
    return { found: false };
  };

  const resolveString = (text: string, owner: string): unknown => {
    if (!text.includes("${vars.")) return text;
    const whole = WHOLE_VAR_REF.exec(text);
    if (whole) {
      const hit = resolveRef(whole[1]!, owner);
      if (!hit.found) return text;
      changed = true;
      return hit.value;
    }
    return text.replace(VAR_REF, (match, body: string) => {
      const hit = resolveRef(body, owner);
      if (!hit.found) return match;
      changed = true;
      return renderVarValue(hit.value);
    });
  };

  const resolveValue = (value: unknown, owner: string): unknown => {
    if (typeof value === "string") return resolveString(value, owner);
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, owner));
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = resolveValue(item, owner);
      }
      return out;
    }
    return value;
  };

  const vars: Record<string, unknown> = {};
  for (const name of Object.keys(bag)) vars[name] = resolveName(name);
  return { vars, problems, deferred, changed };
}

/** `${vars.<ref>}` references inside a value (root names, each once). */
export function varReferencesIn(
  value: unknown,
  has: (name: string) => boolean,
  out: Set<string> = new Set(),
): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(VAR_REF)) {
      const body = match[1]!;
      const split = body.indexOf(":-");
      out.add(varRefRoot(split >= 0 ? body.slice(0, split) : body, has));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) varReferencesIn(item, has, out);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) varReferencesIn(item, has, out);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* source locations                                                          */
/* ------------------------------------------------------------------------ */

interface Location {
  line: number;
  /** Authored scalar text holding a placeholder. */
  template?: string;
  /** Came through a merge key / alias: the anchor's owner. */
  inheritedFrom?: string;
  /** The authored value holds `${env.X}` / `${secrets.X}` at some depth. */
  fromEnvironment?: true;
  /** The authored list / object, when it holds a placeholder. */
  authored?: unknown;
}

/** The authored-text facts of a var definition (template, env origin). */
function authoredOf(
  location: Location | undefined,
): Pick<VarDefinition, "template" | "fromEnvironment" | "authored"> {
  return {
    ...(location?.template !== undefined
      ? { template: location.template }
      : {}),
    ...(location?.fromEnvironment ? { fromEnvironment: true as const } : {}),
    ...(location?.authored !== undefined
      ? { authored: location.authored }
      : {}),
  };
}

const ENV_PLACEHOLDER_RE = /\$\{(?:env|secrets)\./;

/** Every string scalar of an authored node (aliases followed, bounded). */
function authoredStrings(
  node: unknown,
  doc: Document,
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 32) return out;
  if (isAlias(node)) {
    return authoredStrings(node.resolve(doc), doc, out, depth + 1);
  }
  if (isScalar(node)) {
    if (typeof node.value === "string") out.push(node.value);
    return out;
  }
  if (isMap(node) || isSeq(node)) {
    for (const item of node.items) {
      if (isPair(item)) {
        authoredStrings(item.key, doc, out, depth + 1);
        authoredStrings(item.value, doc, out, depth + 1);
      } else {
        authoredStrings(item, doc, out, depth + 1);
      }
    }
  }
  return out;
}

/** Dotted key (`vars.x`, `environments.dev.vars.x`, `fixtures.f`) → line. */
type Locations = Map<string, Location>;

/**
 * Index the keys `cairn config vars` and the include findings point at, from
 * the authored text (no substitution). A file that does not parse on its own
 * has no locations — composition still works, findings just lack lines.
 */
export function indexLocations(text: string): Locations {
  const out: Locations = new Map();
  const lines = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(text, { merge: true, lineCounter: lines });
  } catch {
    return out;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return out;
  const lineOf = (node: unknown): number | undefined => {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return range ? lines.linePos(range[0]).line : undefined;
  };
  const root = doc.contents;

  // anchors of `environments.<env>.vars` blocks name their environment
  const owners = new Map<string, string>();
  const envs = root.get("environments", true);
  if (isMap(envs)) {
    for (const pair of envs.items) {
      const envName = isScalar(pair.key) ? String(pair.key.value) : undefined;
      const vars = isMap(pair.value) ? pair.value.get("vars", true) : undefined;
      const anchor = (vars as { anchor?: string } | undefined)?.anchor;
      if (envName && anchor) owners.set(anchor, envName);
    }
  }

  const index = (
    prefix: string,
    node: unknown,
    inheritedFrom: string | undefined,
    depth = 0,
  ): void => {
    if (depth > 8) return;
    let map = node;
    let from = inheritedFrom;
    if (isAlias(map)) {
      from ??= owners.get(map.source) ?? `&${map.source}`;
      map = map.resolve(doc);
    }
    if (!isMap(map)) return;
    const merges: unknown[] = [];
    for (const pair of (map as YAMLMap).items) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      if (typeof key === "symbol" || key === "<<") {
        merges.push(...(isSeq(pair.value) ? pair.value.items : [pair.value]));
        continue;
      }
      if (key === undefined || key === null) continue;
      const path = `${prefix}.${String(key)}`;
      if (out.has(path)) continue;
      const line = lineOf(pair.key);
      if (line === undefined) continue;
      const value = pair.value;
      const template =
        isScalar(value) &&
        typeof value.value === "string" &&
        value.value.includes("${")
          ? value.value
          : undefined;
      // Only vars need the deep look (what `cairn config vars` may show).
      const isVar = /(?:^|\.)vars$/.test(prefix);
      const strings = isVar ? authoredStrings(value, doc) : [];
      const fromEnvironment = strings.some((scalar) =>
        ENV_PLACEHOLDER_RE.test(scalar),
      );
      let authored: unknown;
      if (
        isVar &&
        template === undefined &&
        strings.some((scalar) => scalar.includes("${"))
      ) {
        try {
          authored = (
            (isAlias(value) ? value.resolve(doc) : value) as {
              toJS(document: Document): unknown;
            }
          ).toJS(doc);
        } catch {
          authored = undefined;
        }
      }
      out.set(path, {
        line,
        ...(template !== undefined ? { template } : {}),
        ...(from ? { inheritedFrom: from } : {}),
        ...(fromEnvironment ? { fromEnvironment: true as const } : {}),
        ...(authored !== undefined ? { authored } : {}),
      });
    }
    for (const source of merges) {
      if (!isAlias(source)) continue;
      index(
        prefix,
        source,
        from ?? owners.get(source.source) ?? `&${source.source}`,
        depth + 1,
      );
    }
  };

  for (const key of INCLUDABLE_SECTIONS) {
    index(key, root.get(key, true), undefined);
  }
  if (isMap(envs)) {
    for (const pair of envs.items) {
      const envName = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (!envName) continue;
      const line = lineOf(pair.key);
      if (line !== undefined) out.set(`environments.${envName}`, { line });
      if (!isMap(pair.value)) continue;
      const extendsNode = pair.value.items.find(
        (item) => isScalar(item.key) && item.key.value === "extends",
      );
      const extendsLine = lineOf(extendsNode?.key);
      if (extendsLine !== undefined) {
        out.set(`environments.${envName}.extends`, { line: extendsLine });
      }
      index(
        `environments.${envName}.vars`,
        pair.value.get("vars", true),
        undefined,
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* globs                                                                     */
/* ------------------------------------------------------------------------ */

export function hasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** One glob path segment (`*`, `?`) as an anchored RegExp. */
export function globSegmentRegExp(segment: string): RegExp {
  const body = segment
    .split("")
    .map((ch) =>
      ch === "*"
        ? "[^/]*"
        : ch === "?"
          ? "[^/]"
          : ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

/**
 * Expand an absolute glob (`*` and `?` within a path segment, `**` for any
 * number of directories) to the `.yml` / `.yaml` files it matches, sorted.
 * Hidden entries match only a pattern segment that starts with a dot.
 */
export async function expandGlob(absPattern: string): Promise<string[]> {
  const segments = absPattern.split(sep);
  const first = segments.findIndex((segment) => hasGlob(segment));
  const base = segments.slice(0, first).join(sep) || sep;
  const found = new Set<string>();
  const walk = async (
    dir: string,
    rest: readonly string[],
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_GLOB_DEPTH || found.size > MAX_INCLUDE_FILES) return;
    const [segment, ...tail] = rest;
    if (segment === undefined) return;
    if (segment === "**") {
      await walk(dir, tail, depth);
      for (const entry of await entriesOf(dir)) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          await walk(join(dir, entry.name), rest, depth + 1);
        }
      }
      return;
    }
    if (!hasGlob(segment)) {
      const next = join(dir, segment);
      if (tail.length === 0) {
        if (isYamlFile(segment) && (await isFile(next))) found.add(next);
      } else {
        await walk(next, tail, depth + 1);
      }
      return;
    }
    const re = globSegmentRegExp(segment);
    for (const entry of await entriesOf(dir)) {
      if (!re.test(entry.name)) continue;
      if (entry.name.startsWith(".") && !segment.startsWith(".")) continue;
      const next = join(dir, entry.name);
      if (tail.length === 0) {
        if (entry.isFile() && isYamlFile(entry.name)) found.add(next);
      } else if (entry.isDirectory()) {
        await walk(next, tail, depth + 1);
      }
    }
  };
  await walk(base, segments.slice(first), 0);
  return [...found].toSorted();
}

async function entriesOf(dir: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isYamlFile(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/* ------------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `path` relative to `dir` with forward slashes (absolute outside it). */
export function relativeTo(dir: string, path: string): string {
  const rel = relative(dir, path);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

/** `file:line` (relative to the config dir). */
export function formatRef(
  ref: ConfigSourceRef,
  rel: (path: string) => string,
): string {
  return ref.line !== undefined
    ? `${rel(ref.file)}:${ref.line}`
    : rel(ref.file);
}
