import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, substituteEnv, type LoadedConfig } from "./loader";
import type { EnvLateBinding } from "./text";
import type {
  BrowserConfig,
  Config,
  ConfigVarValue,
  EnvironmentServicesConfig,
  SecretsConfig,
  ServicesConfig,
  ViewportConfig,
} from "../schema/config.v1";
import { mergeRunPolicy, type RunPolicyConfig } from "../runPolicy/schema";
import { lookupVar, renderVarValue } from "./varValue";
import { mergeMetrics, type MetricsList } from "../metrics/schema";
import { engineRequirementProblem } from "../engineRequirements";
import { canonicalEnvironment } from "./envAlias";

export interface RuntimeContextOptions {
  /** Override the spec/config default environment. */
  envOverride?: string;
  /** Explicit cairntrace.config.yml path. */
  configPath?: string;
  /** Runtime vars passed by the caller; these override config env vars. */
  vars?: Record<string, ConfigVarValue>;
  /** Defaults to process.cwd(). Used to resolve a relative spec path. */
  cwd?: string;
  /** Forwarded to loadConfig: substitute for `${env.X}` unset with no default. */
  envRef?: (name: string) => string;
  /**
   * Exporter late binding for a spec's own `vars:` (needs `envRef`):
   * `${env.X:-default}` resolves through this instead of the default, and
   * `lateEnv` keeps a plain `${env.X}` late-bound even when X is set.
   * Config-file vars keep resolving from the environment.
   */
  envDefaultRef?: (name: string, fallback: string) => string;
  lateEnv?: boolean;
  /**
   * Exporter late binding for the CONFIG file too (needs `envRef`): no
   * environment value is substituted anywhere in it — config vars,
   * baseUrl, auth and datasources keep late-bound references — and
   * deferred var templates resolve the same way.
   */
  lateConfig?: EnvLateBinding;
  /** Scoped environment used for config interpolation. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /**
   * Do not refuse a config whose `requires.cairntrace` this cairn does not
   * meet (a teardown must never be blocked by the engine pin); a warning
   * says so instead.
   */
  skipRequires?: boolean;
  /**
   * Receives each non-fatal resolution warning as it is produced (they are
   * also returned on `warnings`). The core stays logger-free; CLI callers
   * route this to their logger.
   */
  onWarning?: (message: string) => void;
}

/**
 * How the active environment name was chosen. `override` (CLI `--env`, MCP
 * `env`) is an explicit request and must name a configured environment.
 * `spec` (the spec's `environment:`), `config-default` and `fallback` are
 * defaults: an undefined one runs as before, with a warning.
 */
export type EnvironmentSource =
  | "override"
  | "spec"
  | "config-default"
  | "fallback";

/** The spec-independent part of a run: config + selected environment. */
export interface ProjectRuntimeContext {
  /** The environment the run uses: the TARGET when the request named an alias. */
  envName: string;
  /** The `environments.<name>: { alias }` name the request used, when it named one. */
  envAlias?: string;
  envSource: EnvironmentSource;
  baseUrl?: string;
  vars: Record<string, ConfigVarValue>;
  /** Environment-level viewport from config (spec-level `viewport:` wins). */
  viewport?: ViewportConfig;
  /** Environment-level multiplier for waits/settles. */
  waitScale?: number;
  config?: Config;
  configPath?: string;
  /**
   * Directory of the resolved cairntrace.config.yml, or the cwd when there is
   * no config. This is what `${config.dir}` resolves to.
   */
  configDir: string;
  /** Config `browser:` block (backend tuning, `testIdAttribute`), if any. */
  browser?: BrowserConfig;
  /** Effective services config after merging top-level + per-env override.
   * undefined when no services are configured or the env disables them. */
  services?: ServicesConfig;
  /** Effective secrets config after applying per-env override. */
  secrets?: SecretsConfig;
  /** Effective run policy: the environment's `run:` keys over the top-level ones. */
  runPolicy?: RunPolicyConfig;
  /** Effective metric probes: the environment's `metrics` merged over the top-level list by name. */
  metrics?: MetricsList;
  /** Non-fatal resolution warnings (e.g. the implicit environment is not defined). */
  warnings: string[];
  /** `lateConfig` only: typed config fields a late-bound value could not fill. */
  lateUnbound?: string[];
}

export interface SpecRuntimeContext extends ProjectRuntimeContext {
  specPath: string;
}

/**
 * An explicitly requested environment (CLI `--env`, MCP `env`) is not
 * defined in the resolved config. Running anyway would silently drop that
 * environment's baseUrl and vars, so this is a config error (exit 4), not a
 * run failure. A spec's own `environment:` is a default, not a request: it
 * only warns, so one spec's stale default cannot abort a whole batch.
 */
export class UnknownEnvironmentError extends Error {
  readonly exitCode = 4 as const;
  constructor(
    public readonly envName: string,
    /** Kept for compatibility; only `override` is thrown today. */
    public readonly source: "override" | "spec",
    public readonly knownEnvironments: string[],
    public readonly configPath: string,
  ) {
    const from =
      source === "override"
        ? "requested via --env / the env input"
        : "requested by the spec's `environment:`";
    const known =
      knownEnvironments.length > 0 ? knownEnvironments.join(", ") : "(none)";
    super(
      `unknown environment "${envName}" (${from}); ${configPath} defines: ${known}. ` +
        `Use one of those or add environments.${envName} to the config.`,
    );
    this.name = "UnknownEnvironmentError";
  }
}

/**
 * Resolve config/env/runtime variables before the spec is fully parsed.
 *
 * This intentionally performs only a raw YAML peek to read `environment`;
 * it does not call parseSpec(), because parseSpec() may need the vars we are
 * resolving here to satisfy schema-required fields like `open`.
 *
 * Throws {@link UnknownEnvironmentError} when a config exists and the
 * `envOverride` names an environment it does not define.
 */
export async function resolveSpecRuntimeContext(
  specPath: string,
  opts: RuntimeContextOptions = {},
): Promise<SpecRuntimeContext> {
  const absSpecPath = isAbsolute(specPath)
    ? specPath
    : resolve(opts.cwd ?? process.cwd(), specPath);
  const loaded = await loadConfig(absSpecPath, opts.configPath, {
    ...(opts.envRef ? { envRef: opts.envRef } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.skipRequires ? { skipRequires: true } : {}),
    ...(opts.lateConfig && opts.envRef ? { late: opts.lateConfig } : {}),
  });
  const specSettings = await peekSpecSettings(absSpecPath, opts);
  return {
    specPath: absSpecPath,
    ...buildRuntime(loaded, opts, specSettings),
  };
}

/**
 * Resolve config + environment for commands that have no spec file
 * (`cairn discover`, `cairn snapshot`, MCP discovery). Config discovery walks
 * up from `cwd` (default process.cwd()) unless `configPath` is given. Same
 * environment rules as {@link resolveSpecRuntimeContext}.
 */
export async function resolveProjectRuntimeContext(
  opts: RuntimeContextOptions = {},
): Promise<ProjectRuntimeContext> {
  const cwd = opts.cwd ?? process.cwd();
  // loadConfig discovers from the directory of the path it is given; a
  // placeholder file name inside cwd makes it start the walk at cwd itself.
  const loaded = await loadConfig(
    resolve(cwd, "__cairntrace_project__.yml"),
    opts.configPath,
    {
      ...(opts.envRef ? { envRef: opts.envRef } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.skipRequires ? { skipRequires: true } : {}),
    },
  );
  return buildRuntime(loaded, opts, {});
}

function buildRuntime(
  loaded: LoadedConfig | undefined,
  opts: RuntimeContextOptions,
  specSettings: { environment?: string; vars?: Record<string, ConfigVarValue> },
): ProjectRuntimeContext {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.onWarning?.(message);
  };
  if (loaded && opts.skipRequires) {
    const problem = engineRequirementProblem(
      loaded.config,
      undefined,
      loaded.path,
    );
    if (problem) warn(`${problem} (not enforced for a teardown)`);
  }
  const selected = selectEnvironment(
    loaded,
    opts.envOverride,
    specSettings.environment,
  );
  // An alias (`environments.remote: { alias: chalupa }`) is canonicalized
  // here, for every source of the name: everything downstream (suites,
  // policy, state keys, locks, CAIRN_ENV) sees the target.
  const { name: envName, alias: envAlias } = canonicalEnvironment(
    loaded?.config.environments,
    selected.envName,
  );
  const envSource = selected.envSource;
  checkEnvironment(loaded, envName, envSource, warn);
  const envConfig = loaded?.config.environments[envName];
  // F7: a composed environment's vars already hold the top-level `vars:`
  // and its `extends` chain; an environment the config does not define
  // still gets the top-level vars.
  const configVars = envConfig
    ? envConfig.vars
    : (loaded?.composition?.baseVars ?? loaded?.config.vars);
  const vars = { ...configVars, ...specSettings.vars, ...opts.vars };
  // F7: a config var whose template references a var no config var defines
  // (`runTag: "${vars.ticket}-smoke"` with `ticket` from --var) resolves
  // now, from its authored template, against the run's vars.
  if (loaded) {
    resolveDeferredVars(
      vars,
      loaded,
      envName,
      { ...specSettings.vars, ...opts.vars },
      {
        env: opts.env ?? process.env,
        ...(opts.envRef ? { envRef: opts.envRef } : {}),
        ...(opts.lateConfig && opts.envRef ? { late: opts.lateConfig } : {}),
        configDir: dirname(loaded.path),
      },
      warn,
    );
  }

  // Resolve effective services: env-level `services: false` disables all;
  // env-level partial services deep-merge over top-level; otherwise top-level.
  // An environment with a runner runs elsewhere and boots nothing here.
  const services = resolveEffectiveServices(
    loaded?.config.services,
    envConfig?.runner ? false : envConfig?.services,
  );

  // Resolve effective secrets: env-level secrets replaces top-level entirely.
  const secrets = envConfig?.secrets ?? loaded?.config?.secrets;
  const browser = loaded?.config.browser;
  const runPolicy = mergeRunPolicy(loaded?.config.run, envConfig?.run);
  const metrics = mergeMetrics(loaded?.config.metrics, envConfig?.metrics);

  return {
    envName,
    ...(envAlias !== undefined ? { envAlias } : {}),
    envSource,
    vars,
    configDir: loaded ? dirname(loaded.path) : (opts.cwd ?? process.cwd()),
    warnings,
    ...(envConfig?.baseUrl ? { baseUrl: envConfig.baseUrl } : {}),
    ...(envConfig?.viewport ? { viewport: envConfig.viewport } : {}),
    ...(envConfig?.waitScale !== undefined
      ? { waitScale: envConfig.waitScale }
      : {}),
    ...(loaded ? loadedConfigFields(loaded) : {}),
    ...(browser ? { browser } : {}),
    ...(services ? { services } : {}),
    ...(secrets ? { secrets } : {}),
    ...(runPolicy ? { runPolicy } : {}),
    ...(metrics && metrics.length > 0 ? { metrics } : {}),
    ...(loaded?.lateUnbound ? { lateUnbound: loaded.lateUnbound } : {}),
  };
}

const AUTHORED_TOKEN =
  /\$\{(?:env\.(\w+)(?::-([^}]+))?|vars\.([^}\s]+)|config\.dir)\}/g;
const WHOLE_VAR_TOKEN = /^\$\{vars\.([^}\s]+)\}$/;

/**
 * Resolve the config vars composition left deferred (`${vars.X}` with no
 * config var `X`) from their AUTHORED template, in one pass over what the
 * author wrote: `${vars.X}` from the run's vars, `${env.X}` from the
 * environment, `${config.dir}`. Inserted values are never scanned again,
 * so a `${…}` inside an env value, a secret or a `--var` value stays inert.
 * A spec's `vars:` / `--var` entry with the var's own name replaces it
 * whole and is left alone; a reference nobody supplies stays as text, with
 * a warning.
 */
function resolveDeferredVars(
  vars: Record<string, ConfigVarValue>,
  loaded: LoadedConfig,
  envName: string,
  supplied: Readonly<Record<string, unknown>>,
  ctx: {
    env: Record<string, string | undefined>;
    envRef?: (name: string) => string;
    /** Exporter late binding: env references stay late-bound (needs envRef). */
    late?: EnvLateBinding;
    configDir: string;
  },
  warn: (message: string) => void,
): void {
  const composed = loaded.composition?.environments[envName];
  const deferred = composed?.deferred ?? [];
  for (const name of new Set(deferred.map((ref) => ref.name))) {
    if (Object.hasOwn(supplied, name)) continue;
    const definition = composed?.vars[name]?.definitions.at(-1);
    const source = definition?.authored ?? definition?.template;
    if (source === undefined) continue;
    const missing = new Set<string>();
    const lookup = (body: string): { found: boolean; value?: unknown } => {
      const split = body.indexOf(":-");
      const ref = split >= 0 ? body.slice(0, split) : body;
      const hit = lookupVar(vars, ref);
      if (hit.found) return { found: true, value: hit.value };
      if (split >= 0) return { found: true, value: body.slice(split + 2) };
      missing.add(ref);
      return { found: false };
    };
    const render = (text: string): unknown => {
      const whole = WHOLE_VAR_TOKEN.exec(text);
      if (whole) {
        const hit = lookup(whole[1]!);
        return hit.found ? hit.value : text;
      }
      return text.replace(
        AUTHORED_TOKEN,
        (match, envVar?: string, fallback?: string, varBody?: string) => {
          if (varBody !== undefined) {
            const hit = lookup(varBody);
            return hit.found ? renderVarValue(hit.value) : match;
          }
          if (envVar !== undefined) {
            if (ctx.envRef && ctx.late) {
              if (fallback !== undefined && ctx.late.defaultRef) {
                return ctx.late.defaultRef(envVar, fallback);
              }
              if (fallback === undefined && ctx.late.all) {
                return ctx.envRef(envVar);
              }
            }
            const value = ctx.env[envVar];
            if (value === undefined || value === "") {
              if (fallback !== undefined) return fallback;
              return ctx.envRef ? ctx.envRef(envVar) : "";
            }
            return value;
          }
          return ctx.configDir;
        },
      );
    };
    const walk = (value: unknown, depth = 0): unknown => {
      if (depth > 32) return value;
      if (typeof value === "string") return render(value);
      if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, walk(v, depth + 1)]),
        );
      }
      return value;
    };
    vars[name] = walk(source) as ConfigVarValue;
    for (const ref of missing) {
      warn(
        `vars.${name}: \${vars.${ref}} is not defined by the config, a spec's vars: or --var; it is left as text (pass --var ${ref}=…)`,
      );
    }
  }
}

function selectEnvironment(
  loaded: LoadedConfig | undefined,
  override: string | undefined,
  specEnvironment: string | undefined,
): { envName: string; envSource: EnvironmentSource } {
  if (override !== undefined && override.length > 0) {
    return { envName: override, envSource: "override" };
  }
  if (specEnvironment !== undefined) {
    return { envName: specEnvironment, envSource: "spec" };
  }
  const configDefault = loaded?.config.defaultEnvironment;
  if (configDefault !== undefined && configDefault.length > 0) {
    return { envName: configDefault, envSource: "config-default" };
  }
  return { envName: "local", envSource: "fallback" };
}

/**
 * An explicit `--env` / MCP `env` must exist in the config. Defaults (the
 * spec's `environment:`, `defaultEnvironment`, the `local` fallback) keep
 * the historical lenient behavior — run without that environment's baseUrl /
 * vars — but say so. Without a config there is nothing to check:
 * absolute-URL specs run config-free by design.
 */
function checkEnvironment(
  loaded: LoadedConfig | undefined,
  envName: string,
  envSource: EnvironmentSource,
  warn: (message: string) => void,
): void {
  if (!loaded) return;
  const environments = loaded.config.environments;
  if (Object.hasOwn(environments, envName)) return;
  const known = Object.keys(environments).toSorted();
  // "local" is the scaffolded default and the implicit fallback; against a
  // config that defines no environments at all it means "no environment",
  // not a typo — whether a spec says `environment: local` or a wrapper
  // passes `--env local` to every project.
  if (known.length === 0 && envName === "local") return;
  if (envSource === "override") {
    throw new UnknownEnvironmentError(envName, envSource, known, loaded.path);
  }
  if (envSource === "spec") {
    warn(
      `the spec's environment "${envName}" is not defined in ${loaded.path} ` +
        `(known: ${known.length > 0 ? known.join(", ") : "none"}); running ` +
        `without an environment baseUrl or vars — pass --env <name> or add ` +
        `environments.${envName}`,
    );
    return;
  }
  if (envSource === "config-default") {
    warn(
      `defaultEnvironment "${envName}" is not defined in ${loaded.path} ` +
        `(known: ${known.length > 0 ? known.join(", ") : "none"}); ` +
        `running without an environment baseUrl or vars`,
    );
    return;
  }
  // Implicit "local" fallback: only worth saying when the config does define
  // environments (a config without any is a deliberate no-environments setup).
  if (known.length > 0) {
    warn(
      `no environment selected and ${loaded.path} defines no "local" ` +
        `environment (known: ${known.join(", ")}); running without an ` +
        `environment baseUrl or vars — pass --env <name> or set defaultEnvironment`,
    );
  }
}

/**
 * Deep-merge two ServicesConfig objects. The env-level override takes
 * precedence: any defined field in `override` replaces the corresponding
 * field from `base`. Nested objects (docker, seed, tmux, stash) are merged
 * field-by-field; teardown arrays are replaced (not concatenated). An
 * environment may set `tmux: false` to remove inherited local windows while
 * keeping its docker and seed phases, `docker: false` to drop the docker
 * phase while keeping the rest, and `provisioner` / `tunnels` / `files:
 * false` to drop those. `tunnels` and `files` replace as lists.
 */
function mergeServicesConfig(
  base: ServicesConfig,
  override: EnvironmentServicesConfig,
): ServicesConfig {
  const merged: ServicesConfig = {
    ...base,
    ...(override.docker !== undefined && override.docker !== false
      ? { docker: { ...base.docker, ...override.docker } }
      : {}),
    ...(override.seed !== undefined
      ? { seed: { ...base.seed, ...override.seed } }
      : {}),
    ...(override.tmux !== undefined && override.tmux !== false
      ? { tmux: { ...base.tmux, ...override.tmux } }
      : {}),
    ...(override.teardown !== undefined ? { teardown: override.teardown } : {}),
    ...(override.stash !== undefined
      ? { stash: { ...base.stash, ...override.stash } }
      : {}),
    ...(override.provisioner !== undefined && override.provisioner !== false
      ? {
          provisioner: {
            ...base.provisioner,
            ...override.provisioner,
          } as NonNullable<ServicesConfig["provisioner"]>,
        }
      : {}),
    ...(override.tunnels !== undefined && override.tunnels !== false
      ? { tunnels: override.tunnels }
      : {}),
    ...(override.files !== undefined && override.files !== false
      ? { files: override.files }
      : {}),
  };
  if (override.tmux === false) delete merged.tmux;
  if (override.docker === false) delete merged.docker;
  if (override.provisioner === false) delete merged.provisioner;
  if (override.tunnels === false) delete merged.tunnels;
  if (override.files === false) delete merged.files;
  return merged;
}

/**
 * Resolve the effective services config for a given environment.
 * - Env says `services: false` → undefined (explicitly disabled for this env)
 * - Env has no services key → the top-level block as-is (undefined: none)
 * - Env has a services block → deep-merged over the top-level one, or over
 *   nothing when the config has no top-level `services:` (an environment
 *   may own its whole lifecycle, a provisioner included); a block that
 *   leaves no phase at all (`tmux: false` over nothing) is no services
 */
export function resolveEffectiveServices(
  topLevel: ServicesConfig | undefined,
  envServices: false | EnvironmentServicesConfig | undefined,
): ServicesConfig | undefined {
  if (envServices === false) return undefined;
  if (envServices === undefined) return topLevel;
  const merged = mergeServicesConfig(
    topLevel ?? {},
    envServices as EnvironmentServicesConfig,
  );
  if (!topLevel && Object.keys(merged).length === 0) return undefined;
  return merged;
}

/**
 * The effective services of every environment of a config, by name (for
 * readers that list environments: catalog, `config validate`).
 */
export function environmentServicesOf(
  config: Pick<Config, "services" | "environments">,
): Record<string, ServicesConfig | undefined> {
  return Object.fromEntries(
    Object.entries(config.environments).map(([name, env]) => [
      name,
      resolveEffectiveServices(
        config.services,
        env.runner ? false : env.services,
      ),
    ]),
  );
}

async function peekSpecSettings(
  specPath: string,
  opts: Pick<
    RuntimeContextOptions,
    "env" | "envRef" | "envDefaultRef" | "lateEnv"
  > = {},
): Promise<{
  environment?: string;
  vars?: Record<string, ConfigVarValue>;
}> {
  const text = await readFile(specPath, "utf8");
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object") return {};
  const environment = (raw as { environment?: unknown }).environment;
  const vars = (raw as { vars?: unknown }).vars;
  return {
    ...(typeof environment === "string" && environment.length > 0
      ? { environment }
      : {}),
    // A spec var's `${env.X:-default}` resolves like a config var's: before
    // it is spliced as ${vars.X} (one pass would leave the env placeholder
    // in the step as literal text).
    ...(isVarsRecord(vars)
      ? {
          vars: Object.fromEntries(
            Object.entries(vars).map(([key, value]) => [
              key,
              typeof value === "string" && value.includes("${env.")
                ? substituteEnv(
                    value,
                    opts.envRef,
                    opts.env ?? process.env,
                    undefined,
                    opts.envRef
                      ? {
                          ...(opts.envDefaultRef
                            ? { defaultRef: opts.envDefaultRef }
                            : {}),
                          ...(opts.lateEnv ? { all: true } : {}),
                        }
                      : undefined,
                  )
                : value,
            ]),
          ),
        }
      : {}),
  };
}

function isVarsRecord(value: unknown): value is Record<string, ConfigVarValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (v) =>
      typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
}

function loadedConfigFields(
  loaded: LoadedConfig,
): Pick<SpecRuntimeContext, "config" | "configPath"> {
  return { config: loaded.config, configPath: loaded.path };
}
