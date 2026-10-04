import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createMasker, isSensitiveName } from "../catalog/mask";
import {
  readProjectFile,
  walkYaml,
  type ParsedAction,
  type ParsedSpec,
} from "../catalog/project";
import { isSensitiveEnvKey } from "../artifacts/redaction";
import type { Config } from "../schema/config.v1";
import { canonicalEnvironment, realEnvironmentNames } from "./envAlias";
import {
  CONFIG_VARS_SCHEMA_ID,
  type ConfigFindingRow,
  type ConfigVarRow,
  type ConfigVarsResult,
  type ConfigVarUse,
  type ConfigVarUseKind,
} from "../schema/configVars.v1";
import { BUILTIN_LOGIN_ACTION } from "../schema/request.v1";
import {
  composeConfigFile,
  formatRef,
  relativeTo,
  varReferencesIn,
  type ConfigComposition,
  type ConfigFinding,
  type VarDefinition,
} from "./compose";
import { findConfigFile } from "./loader";
import { varKind, varRefRoot } from "./varValue";

/**
 * F7 `cairn config vars` / MCP `cairn_config_vars` and the dead-var check of
 * `cairn config validate`. Reads files only: the composed config, the specs
 * and actions under the project (like `cairn catalog`), and the script
 * verifiers they name. Nothing runs.
 */

export interface ConfigVarsOptions {
  /** Explicit config path; else discovered from `cwd` upward. */
  config?: string;
  cwd?: string;
  /** Only this environment (must be defined). */
  env?: string;
  /** Only vars nothing uses. */
  unused?: boolean;
  /** Only vars a spec (path or name) reaches: its actions, fixtures, script verifiers, login. */
  usedBy?: string;
  /** Environment for `${env.X}` in the config text (default process.env). */
  processEnv?: Record<string, string | undefined>;
}

export interface ConfigVarsOutcome {
  result: ConfigVarsResult;
  /** 0 = ok, 4 = config missing / invalid, unknown --env or --used-by spec. */
  exitCode: 0 | 4;
}

const MAX_SCRIPT_BYTES = 512 * 1024;

export async function buildConfigVars(
  opts: ConfigVarsOptions = {},
): Promise<ConfigVarsOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.config
    ? resolve(cwd, opts.config)
    : await findConfigFile(cwd);
  const fail = (path: string, errors: string[]): ConfigVarsOutcome => ({
    result: emptyResult(path, errors),
    exitCode: 4,
  });
  if (!configPath) {
    return fail("(auto-discovery)", [
      `no cairntrace.config.yml found from ${cwd} — pass --config <path>`,
    ]);
  }
  try {
    await stat(configPath);
  } catch {
    return fail(configPath, [`config file not found: ${configPath}`]);
  }
  const composed = await composeConfigFile({
    configPath,
    ...(opts.processEnv ? { env: opts.processEnv } : {}),
  });
  if (!composed.ok) return fail(configPath, composed.errors);
  const { config, composition } = composed;
  const allEnvs = realEnvironmentNames(config.environments);
  // `--env <alias>` reports the alias target (the aliased environment has
  // no vars of its own).
  const requested =
    opts.env !== undefined
      ? canonicalEnvironment(config.environments, opts.env)
      : undefined;
  if (opts.env !== undefined && !Object.hasOwn(config.environments, opts.env)) {
    return fail(configPath, [
      `unknown environment "${opts.env}"; ${configPath} defines: ${
        Object.keys(config.environments).toSorted().join(", ") || "(none)"
      }`,
    ]);
  }
  const selectedEnv = requested?.name;
  const usage = await collectVarUsage(configPath, config, composition);
  let reach: Set<string> | undefined;
  if (opts.usedBy !== undefined) {
    const spec = findSpec(usage.specs, opts.usedBy, cwd, configPath);
    if (!spec) {
      return fail(configPath, [
        `--used-by "${opts.usedBy}": no spec under the project has that path or name`,
      ]);
    }
    reach = varsReachedBy(spec, usage, config, composition);
  }
  const differing = new Set<string>();
  const shared = new Set<string>();
  const rows = buildRows({
    configPath,
    config,
    composition,
    usage,
    envs: selectedEnv !== undefined ? [selectedEnv] : allEnvs,
    differing,
    shared,
  });
  const findings = [
    ...composition.findings.map((f) => findingRow(f, configPath)),
    ...rows
      .filter((row) => row.unused)
      .map(
        (row): ConfigFindingRow => ({
          level: "warning",
          code: "unused-var",
          key: `vars.${row.name}`,
          ...(row.definedAt[0] ? { at: row.definedAt[0].at } : {}),
          message: unusedMessage(row),
        }),
      ),
  ];
  const visible = rows.filter(
    (row) =>
      (!opts.unused || row.unused === true) &&
      (reach === undefined || reach.has(row.name)),
  );
  const filter = {
    ...(selectedEnv !== undefined ? { env: selectedEnv } : {}),
    ...(requested?.alias !== undefined ? { envAlias: requested.alias } : {}),
    ...(opts.unused ? { unused: true as const } : {}),
    ...(opts.usedBy !== undefined ? { usedBy: opts.usedBy } : {}),
  };
  const result: ConfigVarsResult = {
    $schema: CONFIG_VARS_SCHEMA_ID,
    version: "1",
    ok: true,
    path: configPath,
    files: composition.files.map((file) =>
      relativeTo(dirname(configPath), file),
    ),
    environments: selectedEnv !== undefined ? [selectedEnv] : allEnvs,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    totals: {
      vars: rows.length,
      unused: rows.filter((row) => row.unused).length,
      sameInAllEnvironments: rows.filter((row) => row.sameInAllEnvironments)
        .length,
      differing: differing.size,
      sameWhereDefined: shared.size,
    },
    vars: visible,
    findings,
    ...(usage.warnings.length > 0 ? { warnings: usage.warnings } : {}),
  };
  return { result, exitCode: 0 };
}

/**
 * Config sections whose strings expand `${vars.X}` when they run: fixtures,
 * gates, datasources, suites and (per probe) the `http` metric source. An
 * environment's `auth`, `datasources`, `runner` and `vars` are expanded
 * the same way.
 * Every other config value is read literally, `environments.<n>.baseUrl`,
 * `webServer`, `services`, `run`, hook and metric `command`s included.
 */
const VAR_EXPANDING_SECTIONS = new Set([
  "vars",
  "include",
  "fixtures",
  "gates",
  "datasources",
  "suites",
]);
const VAR_EXPANDING_ENV_KEYS = new Set([
  "vars",
  "extends",
  "auth",
  "datasources",
  // A delegated runner's command, cwd and env resolve when it is spawned.
  "runner",
]);

/**
 * An authored `${vars.X}` in a config value that never expands it: the run
 * reads the text as written (a `baseUrl` of `${vars.host}/app` is opened
 * literally). One warning per field, naming its path.
 */
export function literalVarRefFindings(config: Config): ConfigFindingRow[] {
  const out: ConfigFindingRow[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const refs = [...value.matchAll(LITERAL_VAR_REF)].map((m) => m[0]);
      if (refs.length > 0) {
        out.push({
          level: "warning",
          code: "literal-var-ref",
          key: path,
          message: `${path} holds ${[...new Set(refs)].join(", ")}, which is not expanded here: this field is read literally at run time (\${vars.X} expands in specs, actions, fixtures, gates, datasources, suites, http metric probes, environment auth and a runner). Write the value, or use \${env.X:-default}.`,
        });
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        walk(item, `${path}.${key}`);
      }
    }
  };
  /** A `metrics:` list: only a probe's `command` stays literal. */
  const walkMetrics = (metrics: unknown, path: string): void => {
    if (!Array.isArray(metrics)) return;
    metrics.forEach((probe, i) => {
      if (isRecord(probe) && "command" in probe) {
        walk(probe.command, `${path}[${i}].command`);
      }
    });
  };
  for (const [key, value] of Object.entries(
    config as unknown as Record<string, unknown>,
  )) {
    if (VAR_EXPANDING_SECTIONS.has(key) || key === "environments") continue;
    if (key === "metrics") walkMetrics(value, "metrics");
    else walk(value, key);
  }
  for (const [envName, env] of Object.entries(config.environments)) {
    for (const [key, value] of Object.entries(env)) {
      if (VAR_EXPANDING_ENV_KEYS.has(key)) continue;
      const path = `environments.${envName}.${key}`;
      if (key === "metrics") walkMetrics(value, path);
      else walk(value, path);
    }
  }
  return out;
}

const LITERAL_VAR_REF = /\$\{vars\.[^}\s]+\}/g;

/** `vars.<name> … is not used …` (also the `cairn config validate` warning). */
export function unusedMessage(row: Pick<ConfigVarRow, "name" | "definedAt">) {
  const at = row.definedAt.map((d) => d.at);
  return `vars.${row.name} is not used by any spec, action, script verifier, fixture, datasource, gate or config value${
    at.length > 0 ? ` (defined at ${at.join(", ")})` : ""
  }`;
}

/** Names of the vars nothing uses (for `cairn config validate`). */
export async function unusedConfigVars(
  configPath: string,
  config: Config,
  composition: ConfigComposition,
): Promise<ConfigFindingRow[]> {
  const names = new Set<string>(Object.keys(composition.topLevel));
  for (const env of Object.values(composition.environments)) {
    for (const name of Object.keys(env.vars)) names.add(name);
  }
  if (names.size === 0) return [];
  const usage = await collectVarUsage(configPath, config, composition);
  const rows = buildRows({
    configPath,
    config,
    composition,
    usage,
    envs: realEnvironmentNames(config.environments),
  });
  return rows
    .filter((row) => row.unused)
    .map((row) => ({
      level: "warning" as const,
      code: "unused-var" as const,
      key: `vars.${row.name}`,
      ...(row.definedAt[0] ? { at: row.definedAt[0].at } : {}),
      message: unusedMessage(row),
    }));
}

/** A composition finding with paths relative to the config directory. */
export function findingRow(
  finding: ConfigFinding,
  configPath: string,
): ConfigFindingRow {
  const rel = (path: string) => relativeTo(dirname(configPath), path);
  return {
    level: finding.level,
    code: finding.code,
    message: finding.message,
    ...(finding.key ? { key: finding.key } : {}),
    ...(finding.file
      ? {
          at: formatRef(
            {
              file: finding.file,
              ...(finding.line !== undefined ? { line: finding.line } : {}),
            },
            rel,
          ),
        }
      : {}),
    ...(finding.overriddenBy
      ? { overriddenBy: formatRef(finding.overriddenBy, rel) }
      : {}),
    ...(finding.identical ? { identical: true as const } : {}),
  };
}

function emptyResult(path: string, errors: string[]): ConfigVarsResult {
  return {
    $schema: CONFIG_VARS_SCHEMA_ID,
    version: "1",
    ok: false,
    path,
    files: [],
    environments: [],
    totals: {
      vars: 0,
      unused: 0,
      sameInAllEnvironments: 0,
      differing: 0,
      sameWhereDefined: 0,
    },
    vars: [],
    findings: [],
    errors,
  };
}

/* ------------------------------------------------------------------------ */
/* usage                                                                     */
/* ------------------------------------------------------------------------ */

interface VarUsage {
  /** Var name → uses (deduplicated). */
  uses: Map<string, ConfigVarUse[]>;
  /** Var name → vars its values reference (any environment). */
  varRefs: Map<string, Set<string>>;
  specs: ParsedSpec[];
  actions: ParsedAction[];
  /** Script verifier path → var names it reads (`vars.x`, `vars["x"]`). */
  scriptVars: Map<string, Set<string>>;
  warnings: string[];
}

async function collectVarUsage(
  configPath: string,
  config: Config,
  composition: ConfigComposition,
): Promise<VarUsage> {
  const root = dirname(configPath);
  const rel = (path: string) => relativeTo(root, path);
  const defined = new Set<string>(Object.keys(composition.topLevel));
  for (const env of Object.values(composition.environments)) {
    for (const name of Object.keys(env.vars)) defined.add(name);
  }
  const has = (name: string) => defined.has(name);
  const uses = new Map<string, ConfigVarUse[]>();
  const seen = new Set<string>();
  const add = (
    varName: string,
    kind: ConfigVarUseKind,
    name: string,
    file: string,
  ): void => {
    const key = `${varName}\u0000${kind}\u0000${name}\u0000${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    const list = uses.get(varName) ?? [];
    list.push({ kind, name, file });
    uses.set(varName, list);
  };
  const warnings: string[] = [];

  // ---- specs + actions (the catalog's loose reader) -----------------------
  const artifactRoot = resolve(
    root,
    config.artifactRoot?.replace(/^~(?=\/)/, homedir()) ??
      join(homedir(), ".cairntrace", "runs"),
  );
  const scanRoots = config.workflowRoots?.length
    ? [
        ...config.workflowRoots.map((r) => resolve(root, r)),
        join(root, "actions"),
      ]
    : [root];
  const walked = await walkYaml(
    [...new Set(scanRoots)],
    new Set([artifactRoot]),
  );
  if (walked.truncated) {
    warnings.push("file scan stopped at its bound; some files were not read");
  }
  const specs: ParsedSpec[] = [];
  const actionsByPath = new Map<string, ParsedAction>();
  for (const file of walked.files) {
    const parsed = await readProjectFile(file, root);
    if (parsed?.kind === "spec") specs.push(parsed);
    else if (parsed?.kind === "action") actionsByPath.set(parsed.path, parsed);
  }
  for (const path of new Set(
    [...specs, ...actionsByPath.values()].flatMap((f) => f.imports),
  )) {
    if (actionsByPath.has(path)) continue;
    const parsed = await readProjectFile(path, root);
    if (parsed?.kind === "action") actionsByPath.set(path, parsed);
  }
  const actions = [...actionsByPath.values()];
  for (const file of [...specs, ...actions]) {
    for (const ref of file.varRefs) {
      add(varRefRoot(ref, has), file.kind, file.name, rel(file.path));
    }
  }

  // ---- script verifiers ---------------------------------------------------
  const scriptVars = new Map<string, Set<string>>();
  for (const spec of specs) {
    for (const script of spec.scripts) {
      if (!script.path) continue;
      let names = scriptVars.get(script.path);
      if (!names) {
        names = await scriptVarNames(script.path);
        scriptVars.set(script.path, names);
      }
      for (const name of names) {
        if (has(name)) add(name, "script", rel(script.path), rel(script.path));
      }
    }
  }

  // ---- config ------------------------------------------------------------
  const entryFile = (key: string) =>
    rel(composition.entries[key]?.file ?? configPath);
  const scan = (
    value: unknown,
    kind: ConfigVarUseKind,
    name: string,
    file: string,
  ): void => {
    for (const ref of varReferencesIn(value, has)) add(ref, kind, name, file);
  };
  const sectionKind: Record<string, ConfigVarUseKind> = {
    fixtures: "fixture",
    datasources: "datasource",
    gates: "gate",
    suites: "suite",
  };
  const document = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(document)) {
    if (key === "vars" || key === "environments" || key === "include") continue;
    const kind = sectionKind[key];
    if (kind && isRecord(value)) {
      for (const [name, entry] of Object.entries(value)) {
        scan(entry, kind, name, entryFile(`${key}.${name}`));
      }
      continue;
    }
    scan(value, "config", key, rel(configPath));
  }
  for (const [envName, env] of Object.entries(config.environments)) {
    for (const [key, value] of Object.entries(env)) {
      if (key === "vars" || key === "extends") continue;
      const kind: ConfigVarUseKind =
        key === "auth"
          ? "auth"
          : key === "datasources"
            ? "datasource"
            : "config";
      scan(value, kind, `environments.${envName}.${key}`, rel(configPath));
    }
  }

  // ---- var → var ---------------------------------------------------------
  const varRefs = new Map<string, Set<string>>();
  const definitions: Array<[string, VarDefinition]> = [];
  for (const [name, defs] of Object.entries(composition.topLevel)) {
    for (const def of defs) definitions.push([name, def]);
  }
  for (const env of Object.values(composition.environments)) {
    for (const [name, composed] of Object.entries(env.vars)) {
      for (const def of composed.definitions) definitions.push([name, def]);
    }
  }
  for (const [owner, def] of definitions) {
    const refs = varReferencesIn(def.value, has);
    if (def.template) varReferencesIn(def.template, has, refs);
    for (const ref of refs) {
      if (ref === owner) continue;
      const set = varRefs.get(owner) ?? new Set<string>();
      set.add(ref);
      varRefs.set(owner, set);
      add(ref, "var", owner, rel(def.file));
    }
  }
  return { uses, varRefs, specs, actions, scriptVars, warnings };
}

const SCRIPT_VAR_RE =
  /\bvars\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)|\bvars\s*(?:\?\.)?\[\s*["'`]([^"'`]+)["'`]\s*\]/g;

/** Var names a script verifier reads (`ctx.vars.x`, `vars["x"]`). */
async function scriptVarNames(path: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    if ((await stat(path)).size > MAX_SCRIPT_BYTES) return names;
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(SCRIPT_VAR_RE)) {
      names.add((match[1] ?? match[2])!);
    }
  } catch {
    // missing or unreadable: the catalog reports it; nothing to count here
  }
  return names;
}

/* ------------------------------------------------------------------------ */
/* --used-by                                                                 */
/* ------------------------------------------------------------------------ */

function findSpec(
  specs: readonly ParsedSpec[],
  ref: string,
  cwd: string,
  configPath: string,
): ParsedSpec | undefined {
  const candidates = [resolve(cwd, ref), resolve(dirname(configPath), ref)];
  return (
    specs.find((spec) => candidates.includes(spec.path)) ??
    specs.find((spec) => spec.name === ref)
  );
}

/** Every var a spec reaches: itself, its actions, fixtures, scripts, login. */
function varsReachedBy(
  spec: ParsedSpec,
  usage: VarUsage,
  config: Config,
  composition: ConfigComposition,
): Set<string> {
  const defined = new Set<string>(Object.keys(composition.topLevel));
  for (const env of Object.values(composition.environments)) {
    for (const name of Object.keys(env.vars)) defined.add(name);
  }
  const has = (name: string) => defined.has(name);
  const out = new Set<string>();
  const addRefs = (refs: Iterable<string>) => {
    for (const ref of refs) out.add(varRefRoot(ref, has));
  };

  // the spec and the actions it reaches (imports, use:)
  const byPath = new Map(usage.actions.map((a) => [a.path, a]));
  const byName = new Map<string, ParsedAction>();
  for (const action of usage.actions) {
    if (!byName.has(action.name)) byName.set(action.name, action);
  }
  const visited = new Set<string>();
  const queue: Array<ParsedSpec | ParsedAction> = [spec];
  let usesLogin = false;
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file.path)) continue;
    visited.add(file.path);
    addRefs(file.varRefs);
    const imported = file.imports
      .map((path) => byPath.get(path))
      .filter((a): a is ParsedAction => a !== undefined);
    for (const action of imported) queue.push(action);
    for (const use of file.uses) {
      const target =
        imported.find((a) => a.name === use.action) ?? byName.get(use.action);
      if (target) queue.push(target);
      else if (use.action === BUILTIN_LOGIN_ACTION) usesLogin = true;
    }
  }

  // config fixtures it lists (and what they need)
  const fixtures = (config.fixtures ?? {}) as Record<
    string,
    { needs?: string[] }
  >;
  const fixtureQueue = [...spec.fixtures];
  const fixtureSeen = new Set<string>();
  while (fixtureQueue.length > 0) {
    const name = fixtureQueue.shift()!;
    if (fixtureSeen.has(name) || !fixtures[name]) continue;
    fixtureSeen.add(name);
    addRefs(varReferencesIn(fixtures[name], has));
    fixtureQueue.push(...(fixtures[name].needs ?? []));
  }

  // script verifiers
  for (const script of spec.scripts) {
    if (!script.path) continue;
    for (const name of usage.scriptVars.get(script.path) ?? []) {
      if (has(name)) out.add(name);
    }
  }

  // the built-in environment login
  if (usesLogin) {
    for (const env of Object.values(config.environments)) {
      if (env.auth) addRefs(varReferencesIn(env.auth, has));
    }
  }

  // vars those vars are built from
  const pending = [...out];
  while (pending.length > 0) {
    const name = pending.pop()!;
    for (const ref of usage.varRefs.get(name) ?? []) {
      if (out.has(ref)) continue;
      out.add(ref);
      pending.push(ref);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* rows                                                                      */
/* ------------------------------------------------------------------------ */

function buildRows(input: {
  configPath: string;
  config: Config;
  composition: ConfigComposition;
  usage: VarUsage;
  envs: readonly string[];
  /** Filled with the vars whose value differs between environments. */
  differing?: Set<string>;
  /** Filled with the vars defined in 2+ environments with one value. */
  shared?: Set<string>;
}): ConfigVarRow[] {
  const { configPath, composition, usage, envs } = input;
  const rel = (path: string) => relativeTo(dirname(configPath), path);
  const masker = createMasker();
  const names: string[] = [];
  const nameSet = new Set<string>();
  const push = (name: string) => {
    if (nameSet.has(name)) return;
    nameSet.add(name);
    names.push(name);
  };
  for (const name of Object.keys(composition.topLevel)) push(name);
  for (const env of envs) {
    for (const name of Object.keys(composition.environments[env]?.vars ?? {})) {
      push(name);
    }
  }

  // used: anything with a non-var use, then what those vars reference
  const used = new Set<string>();
  for (const [name, list] of usage.uses) {
    if (list.some((use) => use.kind !== "var")) used.add(name);
  }
  const pending = [...used];
  while (pending.length > 0) {
    const name = pending.pop()!;
    for (const ref of usage.varRefs.get(name) ?? []) {
      if (used.has(ref)) continue;
      used.add(ref);
      pending.push(ref);
    }
  }

  // A var whose value carries environment data — its authored value holds
  // `${env.X}` / `${secrets.X}` at any depth, or it references (directly or
  // through other vars) such a var or a credential-named one — never shows
  // its value: the authored template stands in for it.
  const sensitiveSource = new Map<string, boolean>();
  const isSensitiveSource = (
    varName: string,
    env: string,
    stack: Set<string> = new Set(),
  ): boolean => {
    const key = `${env}\u0000${varName}`;
    const known = sensitiveSource.get(key);
    if (known !== undefined) return known;
    if (stack.has(varName)) return false;
    const composed = composition.environments[env]?.vars[varName];
    const def = composed?.definitions.at(-1);
    if (!composed || !def) return false;
    stack.add(varName);
    let result = def.fromEnvironment === true;
    if (!result) {
      const vars = composition.environments[env]?.vars ?? {};
      const refs = varReferencesIn(
        def.authored ?? def.template ?? def.value,
        (ref) => Object.hasOwn(vars, ref),
      );
      for (const ref of refs) {
        if (!Object.hasOwn(vars, ref)) continue;
        if (isSensitiveName(ref) || isSensitiveSource(ref, env, stack)) {
          result = true;
          break;
        }
      }
    }
    stack.delete(varName);
    sensitiveSource.set(key, result);
    return result;
  };

  return names.map((name): ConfigVarRow => {
    const values: ConfigVarRow["values"] = {};
    const definedAt = new Map<string, ConfigVarRow["definedAt"][number]>();
    const overrides = new Map<string, ConfigVarRow["overriddenBy"][number]>();
    const kinds = new Set<string>();
    const serialized = new Set<string>();
    let definedEverywhere = true;
    const defRow = (def: VarDefinition) => ({
      scope: def.scope,
      at: formatRef(def, rel),
      ...(def.inheritedFrom ? { inheritedFrom: def.inheritedFrom } : {}),
    });
    for (const def of composition.topLevel[name] ?? []) {
      const row = defRow(def);
      definedAt.set(`${row.scope}@${row.at}`, row);
    }
    for (const env of envs) {
      const composed = composition.environments[env]?.vars[name];
      if (!composed) {
        definedEverywhere = false;
        continue;
      }
      kinds.add(varKind(composed.value));
      serialized.add(JSON.stringify(composed.value));
      for (const def of composed.definitions) {
        const row = defRow(def);
        definedAt.set(`${row.scope}@${row.at}`, row);
      }
      const effective = composed.definitions.at(-1);
      const fromEnvironment = isSensitiveSource(name, env);
      const masked = fromEnvironment
        ? maskAuthored(
            name,
            effective?.authored ?? effective?.template ?? effective?.value,
          )
        : maskVar(name, composed.value, effective?.template);
      values[env] = {
        value: masked.value,
        ...(masked.masked ? { masked: true as const } : {}),
        ...(fromEnvironment ? { fromEnvironment: true as const } : {}),
        scope: effective?.scope ?? "vars",
        at: effective ? formatRef(effective, rel) : rel(configPath),
        ...(effective?.template !== undefined
          ? { template: maskTemplate(name, effective.template, masker) }
          : {}),
      };
      if (effective && composed.definitions.length > 1) {
        const row = defRow(effective);
        const key = `${row.scope}@${row.at}`;
        const entry = overrides.get(key) ?? { ...row, envs: [] };
        entry.envs.push(env);
        overrides.set(key, entry);
      }
    }
    const usedBy = (usage.uses.get(name) ?? []).toSorted(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        a.file.localeCompare(b.file) ||
        a.name.localeCompare(b.name),
    );
    if (serialized.size > 1) input.differing?.add(name);
    else if (Object.keys(values).length > 1) input.shared?.add(name);
    return {
      name,
      kind:
        kinds.size === 1
          ? ([...kinds][0] as ConfigVarRow["kind"])
          : kinds.size === 0
            ? "string"
            : "mixed",
      ...(envs.length > 1
        ? {
            sameInAllEnvironments: definedEverywhere && serialized.size === 1,
          }
        : {}),
      values,
      definedAt: [...definedAt.values()],
      overriddenBy: [...overrides.values()],
      usedBy,
      ...(used.has(name) ? {} : { unused: true as const }),
    };
  });

  /**
   * The authored template of an environment-derived var, as shown: its
   * placeholders as written, a literal under a credential-like name masked.
   */
  function maskAuthored(
    varName: string,
    authored: unknown,
  ): { value: unknown; masked?: true } {
    let masked = false;
    const walk = (key: string, item: unknown): unknown => {
      if (Array.isArray(item)) return item.map((v) => walk(key, v));
      if (item !== null && typeof item === "object") {
        return Object.fromEntries(
          Object.entries(item).map(([k, v]) => [k, walk(k, v)]),
        );
      }
      if (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      ) {
        // A whole-placeholder string never holds the secret; anything else
        // goes through the masker (literals under credential names, tokens).
        const out = masker.value(key, item);
        if (out.masked) masked = true;
        return out.value;
      }
      return item ?? null;
    };
    const out = walk(varName, authored);
    return masked ? { value: out, masked: true } : { value: out };
  }

  function maskVar(
    varName: string,
    value: unknown,
    template: string | undefined,
  ): { value: unknown; masked?: true } {
    // A value spliced from a sensitive env var or a secret never shows.
    if (
      template !== undefined &&
      [
        ...template.matchAll(/\$\{(env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)/g),
      ].some((m) => m[1] === "secrets" || isSensitiveEnvKey(m[2]!))
    ) {
      return { value: "[redacted]", masked: true };
    }
    let masked = false;
    const walk = (key: string, item: unknown): unknown => {
      if (Array.isArray(item)) return item.map((v) => walk(key, v));
      if (item !== null && typeof item === "object") {
        return Object.fromEntries(
          Object.entries(item).map(([k, v]) => [k, walk(k, v)]),
        );
      }
      if (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
      ) {
        const out = masker.value(key, item);
        if (out.masked) masked = true;
        return out.value;
      }
      return item;
    };
    const out = walk(varName, value);
    return masked ? { value: out, masked: true } : { value: out };
  }
}

function maskTemplate(
  name: string,
  template: string,
  masker: ReturnType<typeof createMasker>,
): string {
  return String(masker.value(name, template).value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
