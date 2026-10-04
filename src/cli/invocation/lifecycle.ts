import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { findConfigFile, loadConfig } from "../../core/config/loader";
import { UnknownEnvironmentError } from "../../core/config/runtimeContext";
import { EngineRequirementError } from "../../core/engineRequirements";
import { NodeRuntimeError, resolveNodeRuntime } from "../../core/runtimes";
import { resolveTemplateString } from "../../core/parser/parseSpec";
import {
  checkServicesLive,
  createNoopServicesHandle,
  describeServicesLock,
  readServicesLock,
  evaluateProvisionerExports,
  reuseLockedServices,
  ServicesLockError,
  startServices,
  type ServicesEvent,
  type ServicesHandle,
  type ServicesLockState,
  type StartServicesContext,
} from "../../core/runner/services";
import type { ServicesOwnerLock } from "../../core/schema/services.v1";
import type { SeedPostCommand } from "../../core/servicesOps/schema";
import { postCommandApplies } from "../../core/servicesOps/seedTransaction";
import {
  startWebServer,
  type WebServerHandle,
} from "../../core/runner/webServer";
import type {
  BrowserConfig,
  ServicesConfig,
} from "../../core/schema/config.v1";
import type { GateNode } from "../../core/gates/schema";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import type { RedactionConfig } from "../../core/schema/spec.v1";
import type { LoggingConfig } from "../logger";
import { resolveScopedSecrets, type ScopedSecrets } from "../commands/secrets";
import {
  absoluteSpecPath,
  isTruthyEnv,
  parseVarFlags,
  resolveRunRuntime,
} from "./options";

/**
 * Invocation lifecycle around the specs: environment preflight, scoped
 * secrets, the services environment and the webServer, the config `browser:`
 * block and the journal's artifact root. Everything here takes its sinks as
 * arguments; nothing writes stdout, touches process.env or registers signal
 * handlers.
 */

/** The narration sinks of a services boot (an Ink narrator in tty mode). */
export type ServicesNarration = Pick<
  StartServicesContext,
  "log" | "logDetail" | "onOutput" | "onEvent"
>;

/** Leveled sinks for lifecycle messages. */
export interface LifecycleSinks {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

type RuntimeOptions = Pick<
  RunInvocationOptions,
  "env" | "config" | "var" | "servicesDryRun"
>;

/**
 * Resolve an invocation-scoped TinyVault environment. This intentionally keeps
 * values out of process.env; callers pass the returned map only to runSpec and
 * the explicitly authorized child processes that need it.
 */
export async function maybeInjectTvaultSecrets(
  firstSpec: string,
  opts: RuntimeOptions,
  sinks: LifecycleSinks = {},
  cwd: string = process.cwd(),
  /** Every spec the invocation will run (the node pin checks all their configs). */
  allSpecs?: readonly string[],
  /**
   * `skipNodePin`: a delegated environment runs its node scripts elsewhere
   * (the remote cairn enforces `runtimes.node` itself).
   */
  extra: { skipNodePin?: boolean } = {},
): Promise<ScopedSecrets> {
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  const vars = parseVarFlags(opts.var);

  const scoped = await resolveScopedSecrets(firstSpecAbs, {
    ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    // A services dry-run plans: it names the secrets it would inject and
    // never calls the vault.
    ...(opts.servicesDryRun ? { namesOnly: true } : {}),
  });
  if (scoped.plannedKeys !== undefined) {
    if (scoped.plannedKeys.length > 0) {
      sinks.info?.(
        `dry-run: would prepare ${scoped.plannedKeys.length} scoped secret name(s) from tvault "${scoped.target}" (vault not read): ${scoped.plannedKeys.join(", ")}`,
      );
    }
  }
  if (scoped.shadowedKeys.length > 0) {
    sinks.warn?.(
      `tvault "${scoped.target}" secrets shadowed by existing env vars: ${scoped.shadowedKeys.join(", ")}`,
    );
  }
  if (scoped.injectedKeys.length > 0) {
    sinks.info?.(
      `prepared ${scoped.injectedKeys.length} scoped secrets from tvault "${scoped.target}"`,
    );
  }
  if (!extra.skipNodePin) {
    await pinNodeRuntime(
      firstSpecAbs,
      opts,
      scoped,
      sinks,
      (allSpecs ?? [firstSpec]).map((spec) => absoluteSpecPath(spec, cwd)),
    );
  }
  return scoped;
}

/**
 * The distinct configs the specs of an invocation resolve to (`--config`,
 * else the one found from each spec's directory); `undefined` stands for
 * specs without a config. Cheap: config discovery only, nothing parsed.
 */
export async function configPathsOf(
  specs: readonly string[],
  opts: Pick<RuntimeOptions, "config">,
): Promise<Map<string | undefined, string[]>> {
  const out = new Map<string | undefined, string[]>();
  const byDir = new Map<string, string | undefined>();
  for (const spec of specs) {
    let configPath: string | undefined;
    if (opts.config !== undefined) {
      configPath = resolve(opts.config);
    } else {
      const dir = dirname(spec);
      if (!byDir.has(dir)) byDir.set(dir, await findConfigFile(dir));
      configPath = byDir.get(dir);
    }
    out.set(configPath, [...(out.get(configPath) ?? []), spec]);
  }
  return out;
}

/**
 * F19: `runtimes.node` of the config picks the node binary of node scripts
 * and verifiers. It is exported to the invocation's child env as
 * `CAIRN_NODE` (an explicit `CAIRN_NODE` wins). A node that is missing or
 * out of range throws a NodeRuntimeError (exit 4) before anything starts.
 * A config without `runtimes.node` changes nothing.
 */
async function pinNodeRuntime(
  firstSpecAbs: string,
  opts: RuntimeOptions,
  scoped: ScopedSecrets,
  sinks: LifecycleSinks,
  allSpecs: readonly string[],
): Promise<void> {
  // One CAIRN_NODE serves the whole invocation: specs from several configs,
  // any of which pins node, cannot share it.
  const configs = await configPathsOf(allSpecs, opts);
  if (configs.size > 1) {
    const pinning: string[] = [];
    for (const [configPath, specs] of configs) {
      if (configPath === undefined) continue;
      const loaded = await loadConfig(specs[0]!, configPath, {
        env: scoped.env,
      });
      if (loaded?.config.runtimes?.node) pinning.push(configPath);
    }
    if (pinning.length > 0) {
      throw new NodeRuntimeError(
        `runtimes.node: the specs of this invocation come from ${configs.size} configs (${describeConfigs(configs)}) and ${pinning.join(", ")} pin${
          pinning.length === 1 ? "s" : ""
        } node; ${MULTI_CONFIG_REMEDY}`,
      );
    }
    return;
  }
  const ctx = await resolveRunRuntime(firstSpecAbs, opts, {
    env: scoped.env,
  }).catch(() => undefined);
  const runtimes = ctx?.config?.runtimes;
  if (!ctx?.configPath || !runtimes?.node) return;
  const resolution = resolveNodeRuntime(runtimes, {
    configDir: dirname(ctx.configPath),
    env: { ...process.env, ...scoped.childEnv },
  });
  if (resolution.command !== "node" && resolution.source !== "CAIRN_NODE") {
    scoped.env.CAIRN_NODE = resolution.command;
    scoped.childEnv.CAIRN_NODE = resolution.command;
  }
  sinks.info?.(
    `node runtime: ${resolution.command} (v${resolution.version}) via ${resolution.source}`,
  );
}

/** "a.yml, b.yml and 1 without a config", for messages. */
export function describeConfigs(
  configs: ReadonlyMap<string | undefined, readonly string[]>,
): string {
  const parts: string[] = [];
  let without: readonly string[] = [];
  for (const [configPath, specs] of configs) {
    if (configPath === undefined) {
      without = specs;
      continue;
    }
    parts.push(`${configPath}: ${describeSpecs(specs, dirname(configPath))}`);
  }
  if (without.length > 0) {
    parts.push(
      `${without.length} spec(s) without a config: ${describeSpecs(without)}`,
    );
  }
  return parts.join("; ");
}

/** The first spec (relative to `dir` when given) and how many more. */
function describeSpecs(specs: readonly string[], dir?: string): string {
  const first = specs[0];
  if (first === undefined) return "no specs";
  const shown = dir ? relative(dir, first) || first : first;
  return specs.length > 1 ? `${shown} +${specs.length - 1} more` : shown;
}

/**
 * What to do when one policy (`run:`, `runtimes.node`) would have to guard
 * specs from several configs. `--suite` is no remedy: a suite's specs still
 * load their own nearest config, so a suite that reaches into a directory
 * with another config spans two as well.
 */
export const MULTI_CONFIG_REMEDY =
  "run each config's specs in an invocation of their own, or pass --config <path> to run them all under one config (its environments and policy then apply to every spec)";

/**
 * Resolve every planned spec's runtime context once per invocation. Each
 * distinct environment warning (a spec `environment:` or `defaultEnvironment`
 * the config does not define) is reported once through `onWarning`, and so
 * is a caller-exported `CAIRN_TVAULT_ENV` that names another environment
 * than the run resolves: precondition, hook and service children no longer
 * receive it (they get `CAIRN_ENV`), so a shell guard reading it would
 * silently fall back. Returns the {@link UnknownEnvironmentError} of an
 * explicit `--env` some spec's config does not define; other resolution
 * errors are left to the phases that already report them.
 */
export async function preflightEnvironments(
  specPaths: readonly string[],
  opts: RuntimeOptions,
  onWarning: (message: string) => void,
  callerEnv: Record<string, string | undefined> = process.env,
): Promise<UnknownEnvironmentError | undefined> {
  const seen = new Set<string>();
  const resolvedNames = new Set<string>();
  const aliasNames = new Set<string>();
  for (const specPath of specPaths) {
    try {
      const ctx = await resolveRunRuntime(specPath, opts, {
        onWarning: (message) => {
          if (seen.has(message)) return;
          seen.add(message);
          onWarning(message);
        },
      });
      resolvedNames.add(ctx.envName);
      if (ctx.envAlias) aliasNames.add(ctx.envAlias);
    } catch (e) {
      if (e instanceof UnknownEnvironmentError) return e;
    }
  }
  const exported = callerEnv.CAIRN_TVAULT_ENV?.trim();
  const others = [...resolvedNames].filter((name) => name !== exported);
  // An exported name that is the alias the run was asked for is not a mismatch.
  if (exported && others.length > 0 && !aliasNames.has(exported)) {
    onWarning(
      `CAIRN_TVAULT_ENV is "${exported}" but this run resolves environment ` +
        `${others.map((name) => `"${name}"`).join(", ")}: preconditions, ` +
        `--before/--after hooks and service commands no longer receive ` +
        `CAIRN_TVAULT_ENV (read CAIRN_ENV instead); pass --env ${exported} ` +
        `if that is the environment you meant`,
    );
  }
  return undefined;
}

/**
 * Every planned spec's `redaction` block, merged, with `${env.X}` /
 * `${secrets.X}` placeholders in `values` resolved against the invocation env.
 * The journal applies it from the first line (services, `--before` hooks),
 * long before each run registers its own spec's block. Best-effort: an
 * unreadable spec, or a value that cannot be resolved yet (`${vars.X}`), is
 * skipped here; that spec's run still redacts its artifacts itself.
 */
export async function collectSpecRedaction(
  specPaths: readonly string[],
  env: Record<string, string | undefined>,
): Promise<RedactionConfig> {
  const merged = {
    headers: new Set<string>(),
    queryParams: new Set<string>(),
    storageKeys: new Set<string>(),
    values: new Set<string>(),
  };
  for (const specPath of new Set(specPaths)) {
    let block: Record<string, unknown> | undefined;
    try {
      const doc = parseYaml(await readFile(specPath, "utf8")) as {
        redaction?: unknown;
      } | null;
      if (doc?.redaction && typeof doc.redaction === "object") {
        block = doc.redaction as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!block) continue;
    for (const key of ["headers", "queryParams", "storageKeys"] as const) {
      for (const name of stringList(block[key])) merged[key].add(name);
    }
    for (const raw of stringList(block.values)) {
      try {
        const value = resolveTemplateString(raw, {
          env,
          configDir: dirname(specPath),
          label: specPath,
        });
        if (value.trim()) merged.values.add(value);
      } catch {
        // Needs --var / runtime context; the run registers it when it starts.
      }
    }
  }
  const config: RedactionConfig = {};
  for (const key of [
    "headers",
    "queryParams",
    "storageKeys",
    "values",
  ] as const) {
    if (merged[key].size > 0) config[key] = [...merged[key]];
  }
  return config;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `~/.cairntrace/runs`, the artifact root without config or flag. */
function defaultArtifactRoot(): string {
  return join(homedir(), ".cairntrace", "runs");
}

/**
 * Artifact root, config path and environment name for the journal, resolved
 * like the runs will be (first spec). Never throws: an unreadable spec or
 * config falls back to the default artifact root and leaves the rest unset.
 */
export async function resolveInvocationContext(
  firstSpec: string,
  opts: RuntimeOptions & Pick<RunInvocationOptions, "artifactRoot">,
  scopedSecrets: ScopedSecrets,
  cwd: string = process.cwd(),
): Promise<{
  artifactRoot: string;
  configPath?: string;
  environment?: string;
  envAlias?: string;
}> {
  const fallback = resolve(opts.artifactRoot ?? defaultArtifactRoot());
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  try {
    const ctx = await resolveRunRuntime(firstSpecAbs, opts, {
      env: scopedSecrets.env,
    });
    return {
      artifactRoot:
        opts.artifactRoot !== undefined
          ? resolve(opts.artifactRoot)
          : resolve(ctx.config?.artifactRoot ?? defaultArtifactRoot()),
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
      ...(ctx.envName ? { environment: ctx.envName } : {}),
      ...(ctx.envAlias ? { envAlias: ctx.envAlias } : {}),
    };
  } catch {
    return { artifactRoot: fallback };
  }
}

/** Resolve the same artifact root runSpec will use, without making parse errors fatal. */
export async function resolveBatchArtifactRoot(
  firstSpec: string,
  opts: RuntimeOptions & Pick<RunInvocationOptions, "artifactRoot">,
  cwd: string = process.cwd(),
): Promise<string> {
  if (opts.artifactRoot !== undefined) return resolve(opts.artifactRoot);
  const fallback = defaultArtifactRoot();
  try {
    const ctx = await resolveRunRuntime(absoluteSpecPath(firstSpec, cwd), opts);
    return resolve(ctx.config?.artifactRoot ?? fallback);
  } catch {
    return resolve(fallback);
  }
}

/**
 * Resolve config for the invocation and, if it declares a `webServer`, start it
 * once. Returns undefined when there is no config, no `webServer`, or
 * `--no-web-server` was passed. Throws (fatal) on a boot/setup failure.
 */
export async function maybeStartWebServer(
  firstSpec: string,
  opts: RuntimeOptions &
    Pick<RunInvocationOptions, "noWebServer" | "coldStart" | "artifactRoot">,
  onSpawn: (terminateSync: () => void) => void,
  /** The config `logging` block (the CLI applies it as a project default). */
  /** Lifecycle narration (leveled, stderr in the CLI). */
  /** Warnings that must surface even when `log` is below the level shown. */
  /** The invocation journal gets the `ready` gates' gate.* events. */
  /** Stops `ready` gate waits when the invocation is cancelled. */
  hooks: {
    onLoggingConfig?: (config: LoggingConfig | undefined) => void;
    log?: (message: string) => void;
    warn?: (message: string) => void;
    journal?: InvocationJournal;
    signal?: AbortSignal;
    cwd?: string;
  } = {},
): Promise<WebServerHandle | undefined> {
  if (opts.noWebServer) return undefined; // --no-web-server

  const firstSpecAbs = absoluteSpecPath(firstSpec, hooks.cwd);
  // Unknown/unreadable first arg: let the normal spec-run path report it.
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;

  const ctx = await resolveRunRuntime(firstSpecAbs, opts);
  const cfg = ctx.config?.webServer;
  if (!cfg) return undefined;

  // Run-scope readiness validation: a bare baseUrl satisfies it even when the
  // block sets neither url nor waitForText (the schema can't see baseUrl).
  if (!cfg.url && !cfg.waitForText && !ctx.baseUrl) {
    throw new Error(
      "webServer needs `url`, `waitForText`, or an environment `baseUrl` for readiness",
    );
  }

  const coldStart = opts.coldStart ?? isTruthyEnv(process.env.CI);
  const configDir = ctx.configPath
    ? dirname(ctx.configPath)
    : dirname(firstSpecAbs);
  const artifactRoot =
    opts.artifactRoot ?? ctx.config?.artifactRoot ?? defaultArtifactRoot();
  // Apply the config `logging` block as a project default (flags/env still win).
  hooks.onLoggingConfig?.(ctx.config?.logging);

  const journal = hooks.journal;
  return startWebServer(cfg, {
    configDir,
    coldStart,
    artifactRoot,
    onSpawn,
    ...(ctx.baseUrl !== undefined ? { baseUrl: ctx.baseUrl } : {}),
    ...(hooks.log ? { log: hooks.log } : {}),
    ...(hooks.warn ? { warn: hooks.warn } : {}),
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    // The resolved config's registry: a fallback lookup from configDir would
    // miss a `--config` file not named cairntrace.config.yml.
    ...(ctx.config?.gates ? { gates: ctx.config.gates } : {}),
    ...(journal ? { onGateEvent: (event) => journal.appendEvent(event) } : {}),
  });
}

/**
 * Whether this invocation would start a webServer (config block present and
 * not skipped). Best-effort; used only to decide whether to queue for the
 * environment lock.
 */
export async function plansWebServer(
  firstSpec: string,
  opts: RuntimeOptions & Pick<RunInvocationOptions, "noWebServer">,
  cwd: string = process.cwd(),
): Promise<boolean> {
  if (opts.noWebServer) return false;
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return false;
  const ctx = await resolveRunRuntime(firstSpecAbs, opts).catch(
    () => undefined,
  );
  return ctx?.config?.webServer !== undefined;
}

/**
 * Resolve the config `browser:` block for the invocation (run scope, same
 * discovery as webServer/services). Returns undefined when there is no
 * config or no `browser` block — backends then use their built-in defaults.
 */
export async function resolveBrowserConfig(
  firstSpec: string,
  opts: RuntimeOptions,
  cwd: string = process.cwd(),
): Promise<BrowserConfig | undefined> {
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;
  const ctx = await resolveRunRuntime(firstSpecAbs, opts).catch(
    () => undefined,
  );
  return ctx?.config?.browser;
}

/** A resolved, not yet started services environment. */
export interface ServicesPlan {
  cfg: ServicesConfig;
  coldStart: boolean;
  configDir: string;
  project: string;
  /** Resolved config path (absent without a config file). */
  configPath?: string;
  /** Resolved environment name. */
  envName: string;
  /**
   * `--reuse-services` against a `cairn services up` lock: verify readiness,
   * then run without starting or tearing anything down.
   */
  reuse?: { lock: ServicesOwnerLock; path: string };
  /** `--services-dry-run` only: the lock state the plan text reports. */
  lockPreview?: { state: ServicesLockState; reuseRequested: boolean };
  /** The config's `gates:` registry (`docker.ready`, tmux `readyOn.gate` / `after`). */
  gates?: Readonly<Record<string, GateNode>>;
  /** Seed post-commands a suite's `seed.postCommands.skip` removed from `cfg`. */
  skippedPostCommands?: string[];
  /** The suite of this run (`postCommands.when.suite`). */
  suite?: string;
  /** `--services-dry-run` only: names of the suite's `processEnv`. */
  processEnv?: string[];
  /**
   * false: do not supervise windows and tunnels after the boot (`cairn
   * services up` exits right after it).
   */
  supervise?: boolean;
}

/** What `suites.<n>.seed.postCommands.skip` matches: a name, or the trimmed text. */
function labelOf(entry: SeedPostCommand): string {
  return typeof entry === "string" ? entry.trim() : entry.name;
}

/**
 * Drop the seed post-commands a suite skips (F9). A named post-command (the
 * object form) is matched by its `name`; a plain string by its exact command
 * text (trimmed). Returns the config to use and the labels of what was
 * dropped (a name, or the trimmed command text).
 */
function skipSeedPostCommands(
  cfg: ServicesConfig,
  skip: readonly string[] | undefined,
): { cfg: ServicesConfig; skipped: string[] } {
  const commands = cfg.seed?.postCommands;
  if (!skip || skip.length === 0 || !commands || !cfg.seed) {
    return { cfg, skipped: [] };
  }
  const wanted = new Set(skip.map((entry) => entry.trim()));
  const skipped = commands
    .filter((entry) => wanted.has(labelOf(entry)))
    .map(labelOf);
  if (skipped.length === 0) return { cfg, skipped };
  return {
    cfg: {
      ...cfg,
      seed: {
        ...cfg.seed,
        postCommands: commands.filter((entry) => !wanted.has(labelOf(entry))),
      },
    },
    skipped,
  };
}

/**
 * The services environment this invocation would start, or undefined when
 * there is no config, no `services` block, or `--no-services` was passed.
 * Throws on a config resolution error (the caller reports it), and with
 * {@link ServicesLockError} (exit 4) when the `cairn services up` lock of
 * the same config decides against this run (see {@link decideServicesLock})
 * — before any hook, service, webServer or browser starts. A refusal of a
 * lock whose services are not up says the lock is stale.
 */
export async function resolveServicesPlan(
  firstSpec: string,
  opts: RuntimeOptions &
    Pick<
      RunInvocationOptions,
      "noServices" | "coldStart" | "reuseServices" | "servicesDryRun"
    >,
  scopedSecrets: ScopedSecrets,
  cwd: string = process.cwd(),
  /** `--suite`: seed post-commands the suite does not run. */
  skipPostCommands?: readonly string[],
  /** `--suite`: the suite's name. */
  suite?: string,
): Promise<ServicesPlan | undefined> {
  if (opts.noServices) return undefined; // --no-services

  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;

  const ctx = await resolveRunRuntime(firstSpecAbs, opts, {
    env: scopedSecrets.env,
  });
  const resolvedServices = ctx.services;
  if (!resolvedServices) return undefined;
  const { cfg, skipped } = skipSeedPostCommands(
    resolvedServices,
    skipPostCommands,
  );

  const plan: ServicesPlan = {
    cfg,
    ...(skipped.length > 0 ? { skippedPostCommands: skipped } : {}),
    ...(suite !== undefined ? { suite } : {}),
    coldStart: opts.coldStart ?? isTruthyEnv(process.env.CI),
    configDir: ctx.configPath ? dirname(ctx.configPath) : dirname(firstSpecAbs),
    project: ctx.config?.project ?? "cairntrace",
    ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    envName: ctx.envName,
    ...(ctx.config?.gates ? { gates: ctx.config.gates } : {}),
  };
  // Services come from a config file; without one no lock can exist.
  if (!plan.configPath) return plan;
  const lockState = await readServicesLock(plan.configPath);
  const reuseRequested = opts.reuseServices === true;
  // A dry run reports what a real run would do instead of refusing.
  if (opts.servicesDryRun) {
    return { ...plan, lockPreview: { state: lockState, reuseRequested } };
  }
  let reuse: ServicesPlan["reuse"];
  try {
    reuse = decideServicesLock(lockState, plan, reuseRequested);
  } catch (e) {
    // Refusing anyway: one quick liveness look so a dead stack behind the
    // lock (reboot, crash) is named as stale instead of "owned".
    if (
      e instanceof ServicesLockError &&
      e.reason === "locked" &&
      lockState.state === "held"
    ) {
      const liveness = await checkServicesLive(cfg, {
        configDir: plan.configDir,
        env: scopedSecrets.childEnv,
        selectedTvaultKeys: scopedSecrets.selectedKeys,
        ...(plan.gates ? { gates: plan.gates } : {}),
      });
      if (!liveness.live) {
        throw new ServicesLockError(
          staleLockMessage(plan, lockState, liveness.problems, false),
          "stale",
          lockState.path,
        );
      }
    }
    throw e;
  }
  return reuse ? { ...plan, reuse } : plan;
}

/**
 * What a run does about the `cairn services up` lock of its config (one lock
 * per config file, whatever the environment): no lock and no
 * `--reuse-services` → the normal lifecycle (undefined); a lock held for the
 * run's environment with `--reuse-services` → reuse it; anything else throws
 * {@link ServicesLockError} (exit 4): a held lock without the flag (the run
 * would start and tear down a stack it does not own), a lock held for
 * another environment of the config (environments inherit its compose
 * project and tmux session, so they share the stack), the flag without a
 * lock, or an unreadable lock file.
 */
export function decideServicesLock(
  state: ServicesLockState,
  target: Pick<ServicesPlan, "project" | "envName" | "configPath">,
  reuseRequested: boolean,
): { lock: ServicesOwnerLock; path: string } | undefined {
  const who = `project "${target.project}" env "${target.envName}"`;
  const down = `cairn services down --env ${target.envName}`;
  if (state.state === "unreadable") {
    throw new ServicesLockError(
      `the services lock of ${target.configPath ?? who} cannot be read (${state.reason}): ${state.path}. ` +
        `Run \`${down}\` to tear the services down and clear it.`,
      "unreadable",
      state.path,
    );
  }
  if (state.state === "absent") {
    if (!reuseRequested) return undefined;
    throw new ServicesLockError(
      `--reuse-services: no \`cairn services up\` lock for ${who} (${state.path}). ` +
        `Start them with \`cairn services up --env ${target.envName}\`, or run without --reuse-services to start and stop them with this run.`,
      "missing",
      state.path,
    );
  }
  const { lock } = state;
  if (lock.env !== target.envName) {
    throw new ServicesLockError(
      `services of ${target.configPath ?? `project "${target.project}"`} are up for env "${lock.env}", ` +
        `owned by ${describeServicesLock(lock)}; env "${target.envName}" of the same config shares that ` +
        `stack (compose project, tmux session), so ${
          reuseRequested
            ? "--reuse-services cannot reuse it for another env"
            : "this run would start and tear down the same stack"
        }. Run with \`--env ${lock.env} --reuse-services\`, pass --no-services if env "${target.envName}" ` +
        `does not need them, or stop them first with \`cairn services down --env ${lock.env}\`.`,
      "other-env",
      state.path,
    );
  }
  if (reuseRequested) return { lock, path: state.path };
  throw new ServicesLockError(
    `services for ${who} are owned by ${describeServicesLock(lock)}; ` +
      `this run would start and tear down the same stack. Pass --reuse-services ` +
      `(MCP reuseServices: true) to run against them, or stop them first with \`${down}\`.`,
    "locked",
    state.path,
  );
}

/** The exit-4 message of a lock whose services are not up. */
function staleLockMessage(
  plan: Pick<ServicesPlan, "project" | "envName">,
  state: { lock: ServicesOwnerLock; path: string },
  problems: readonly string[],
  reuseRequested: boolean,
): string {
  const env = plan.envName;
  return (
    `${
      reuseRequested ? "--reuse-services: " : ""
    }the services lock for project "${plan.project}" env "${env}" is stale — ` +
    `${describeServicesLock(state.lock)} owns them, but ${problems.join("; ")}. ` +
    `Run \`cairn services down --env ${env}\` to clear it, then ${
      reuseRequested
        ? `\`cairn services up --env ${env}\` (or run without --reuse-services once it is down)`
        : `run again (the run starts and stops its own stack), or \`cairn services up --env ${env}\` and --reuse-services`
    }. Lock: ${state.path}`
  );
}

/** The `--services-dry-run` line for a lock (none when absent and unused). */
function dryRunLockLine(
  preview: NonNullable<ServicesPlan["lockPreview"]>,
  envName: string,
): string | undefined {
  const { state, reuseRequested } = preview;
  if (state.state === "held") {
    const owner = describeServicesLock(state.lock);
    if (state.lock.env !== envName) {
      return `  lock: held for env "${state.lock.env}" by ${owner} — a run of env "${envName}" would refuse (exit 4): environments of one config share its stack`;
    }
    return `  lock: held by ${owner} — a run ${
      reuseRequested
        ? "would reuse it after a readiness check (no start, no teardown)"
        : "would refuse (exit 4) without --reuse-services"
    } (liveness not checked here; \`cairn services status\` checks it)`;
  }
  if (state.state === "unreadable") {
    return `  lock: unreadable (${state.reason}) — a run would refuse (exit 4)`;
  }
  return reuseRequested
    ? "  lock: none — --reuse-services would refuse (exit 4); run `cairn services up` first"
    : undefined;
}

/** The `--services-dry-run` plan text (redacted; one trailing newline). */
export function renderServicesDryRunPlan(
  plan: ServicesPlan,
  scopedSecrets: ScopedSecrets,
): string {
  const { cfg, coldStart, project } = plan;
  const redactor = createArtifactRedactor(
    undefined,
    scopedSecrets.env,
    scopedSecrets.secretValues,
  );
  // Redact complete commands before truncating them. Truncating first could
  // expose a prefix of a long secret that no longer matches the registered
  // literal value.
  const command = (text: string, max = 80): string => {
    const redacted = redactor.text(text);
    return `${redacted.slice(0, max)}${redacted.length > max ? "..." : ""}`;
  };
  const dockerCommand = redactor.text(cfg.docker?.command ?? "");
  const lines = [
    "services dry-run plan:",
    `  project: ${project}`,
    `  env: ${plan.envName}`,
    `  cold-start: ${coldStart}`,
    ...(plan.suite !== undefined ? [`  suite: ${plan.suite}`] : []),
    ...(plan.processEnv && plan.processEnv.length > 0
      ? [`  suite processEnv: ${plan.processEnv.join(", ")} (names only)`]
      : []),
    ...dryRunProvisionerLines(cfg, command),
    ...(cfg.tunnels
      ? cfg.tunnels.map(
          (tunnel) =>
            `  tunnel ${tunnel.name}: ${command(tunnel.command)}${
              tunnel.ready !== undefined
                ? ` (ready: ${gateRefText(tunnel.ready)})`
                : ""
            }${tunnel.restart === "always" ? " (restart: always)" : ""}`,
        )
      : []),
    cfg.docker
      ? `  docker: ${dockerCommand} (reuseExisting: ${cfg.docker.reuseExisting ?? !coldStart})`
      : "  docker: (not configured)",
    ...(cfg.files
      ? cfg.files.map(
          (file) =>
            `  file: ${file.path} (${
              file.json !== undefined ? "json merge" : "text"
            }${file.restart ? `; restarts ${file.restart.join(", ")}` : ""})`,
        )
      : []),
    cfg.seed
      ? `  seed: ${command(
          cfg.seed.command ??
            `phases ${(cfg.seed.phases ?? []).map((p) => p.name).join(", ")}`,
        )} (ttlSeconds: ${cfg.seed.ttlSeconds ?? 0})`
      : "  seed: (not configured)",
    ...dryRunPostCommandLines(plan),
    cfg.tmux
      ? `  tmux: session=${cfg.tmux.session}, ${cfg.tmux.windows.length} windows (reuseExisting: ${cfg.tmux.reuseExisting ?? !coldStart})`
      : "  tmux: (not configured)",
    cfg.teardown
      ? `  teardown: ${cfg.teardown.length} command(s)${
          cfg.teardown.some((e) => typeof e !== "string" && e.critical)
            ? ` (${
                cfg.teardown.filter((e) => typeof e !== "string" && e.critical)
                  .length
              } critical: a failure is exit 8)`
            : ""
        }`
      : "  teardown: (none)",
    ...(scopedSecrets.plannedKeys !== undefined
      ? [
          scopedSecrets.plannedKeys.length > 0
            ? `  secrets: tvault "${scopedSecrets.target ?? "?"}" would inject ${scopedSecrets.plannedKeys.length} name(s): ${scopedSecrets.plannedKeys.join(", ")} (names only; the vault is not read in a dry run)`
            : `  secrets: tvault "${scopedSecrets.target ?? "?"}": none to inject (the vault is not read in a dry run)`,
        ]
      : []),
  ];
  const lockLine = plan.lockPreview
    ? dryRunLockLine(plan.lockPreview, plan.envName)
    : undefined;
  if (lockLine) lines.push(lockLine);
  return redactor.text(lines.join("\n") + "\n");
}

/** A tunnel's `ready` gate reference(s), for the dry-run text. */
function gateRefText(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (Array.isArray(ref) && ref.every((item) => typeof item === "string")) {
    return ref.join(", ");
  }
  const json = JSON.stringify(ref) ?? "";
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}

/** The provisioner's `up` / `down` / `exports` (names only), for the dry-run text. */
function dryRunProvisionerLines(
  cfg: ServicesConfig,
  command: (text: string, max?: number) => string,
): string[] {
  const provisioner = cfg.provisioner;
  if (!provisioner) return [];
  const up =
    typeof provisioner.up === "string" ? provisioner.up : provisioner.up.run;
  const down =
    typeof provisioner.down === "string"
      ? { run: provisioner.down }
      : provisioner.down;
  const exportsList = Object.keys(provisioner.exports ?? {});
  return [
    `  provisioner up: ${command(up)}`,
    // `down` defaults to critical + onSignal: wait (it runs on every exit path).
    `  provisioner down: ${command(down.run)} (critical: ${
      down.critical !== false
    }; runs on every exit path, signals included)`,
    ...(exportsList.length > 0
      ? [`  provisioner exports: ${exportsList.join(", ")} (names only)`]
      : []),
  ];
}

/** A post-command label, cut for one dry-run line. */
function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * The seed post-commands of the plan: how many run, which the suite's
 * `seed.postCommands.skip` removed, and which a `when` leaves out of this
 * run.
 */
function dryRunPostCommandLines(plan: ServicesPlan): string[] {
  const commands = plan.cfg.seed?.postCommands ?? [];
  const skipped = plan.skippedPostCommands ?? [];
  if (commands.length === 0 && skipped.length === 0) return [];
  const notThisRun: string[] = [];
  let runs = 0;
  for (const entry of commands) {
    const applies = postCommandApplies(entry, {
      ...(plan.suite !== undefined ? { suite: plan.suite } : {}),
      env: plan.envName,
    });
    if (applies.applies) runs += 1;
    else notThisRun.push(`${labelOf(entry)} (${applies.reason ?? "when"})`);
  }
  return [
    `  seed postCommands: ${runs} run`,
    ...(skipped.length > 0
      ? [
          `  seed postCommands skipped by ${
            plan.suite !== undefined ? `suite ${plan.suite}` : "the suite"
          }: ${skipped.map(shorten).join(", ")}`,
        ]
      : []),
    ...(notThisRun.length > 0
      ? [`  seed postCommands not for this run: ${notThisRun.join(", ")}`]
      : []),
  ];
}

/**
 * Start a resolved services environment (docker/seed/tmux) once. Lifecycle
 * narration goes to `narration` (the tty renderer) or the leveled sinks;
 * the journal gets services.* events live plus redacted docker/seed output.
 * Throws (fatal) on a boot failure. A plan that reuses a `cairn services up`
 * lock starts nothing: one quick readiness look, then a handle whose stop()
 * leaves the services running (a stale lock throws ServicesLockError).
 */
export async function startServicesPlan(
  plan: ServicesPlan,
  scopedSecrets: ScopedSecrets,
  onSpawn: NonNullable<StartServicesContext["onSpawn"]>,
  sinks: {
    journal?: InvocationJournal;
    narration?: ServicesNarration;
    /** Leveled defaults when no tty narration is mounted. */
    log: (message: string) => void;
    logDetail: (message: string) => void;
    onOutput: (chunk: string) => void;
    /** Warnings that must surface even when `log` is below the level shown. */
    warn?: (message: string) => void;
    /** Cancels the boot (kills running commands, tears started phases down). */
    signal?: AbortSignal;
    /** Every lifecycle event, a failed boot's too (`cairn services up`). */
    onEvent?: (event: ServicesEvent) => void;
  },
): Promise<ServicesHandle> {
  const { journal, narration } = sinks;
  // Lifecycle lines quote commands (`docker (<command>)`, teardown, tmux
  // pre-commands); under --log-format json they reach stderr by default.
  const fallbackRedactor = journal
    ? undefined
    : createArtifactRedactor(
        undefined,
        scopedSecrets.env,
        scopedSecrets.secretValues,
      );
  const redactLine = (line: string): string =>
    journal ? journal.redactText(line) : fallbackRedactor!.text(line);

  const ctx: StartServicesContext = {
    configDir: plan.configDir,
    coldStart: plan.coldStart,
    project: plan.project,
    ...(plan.configPath ? { configPath: plan.configPath } : {}),
    onSpawn,
    env: scopedSecrets.childEnv,
    selectedTvaultKeys: scopedSecrets.selectedKeys,
    secretValues: scopedSecrets.secretValues,
    envName: plan.envName,
    ...(plan.suite !== undefined ? { suite: plan.suite } : {}),
    ...(plan.supervise === false ? { supervise: false } : {}),
    ...(sinks.signal ? { signal: sinks.signal } : {}),
    ...(plan.gates ? { gates: plan.gates } : {}),
    ...(sinks.warn ? { warn: (m: string) => sinks.warn!(redactLine(m)) } : {}),
    // gate.* events of docker.ready / tmux readyOn.gate / after waits.
    ...(journal
      ? {
          onGateEvent: (event) => {
            if (journal.tracker.phase === undefined) {
              void journal.tracker.enter("services");
            }
            journal.appendEvent(event);
          },
        }
      : {}),
    // Lifecycle narration + live subprocess output route through the logger
    // (leveled, always stderr) in plain mode; the Ink tree owns them in tty.
    log: narration
      ? (m: string) => narration.log?.(redactLine(m))
      : (m: string) => sinks.log(redactLine(m)),
    logDetail: narration
      ? (m: string) => narration.logDetail?.(redactLine(m))
      : (m: string) => sinks.logDetail(redactLine(m)),
    onOutput: narration ? narration.onOutput : sinks.onOutput,
    // The journal gets services.* live (each run's events.ndjson keeps its
    // back-dated copy) plus redacted docker/seed output in logs/.
    onEvent: journal
      ? (event) => {
          // Services boot is the first invocation phase; teardown events
          // arrive later inside the "teardown" phase.
          if (journal.tracker.phase === undefined) {
            void journal.tracker.enter("services");
          }
          journal.appendServicesEvent(event);
          narration?.onEvent?.(event);
          sinks.onEvent?.(event);
        }
      : narration?.onEvent || sinks.onEvent
        ? (event) => {
            narration?.onEvent?.(event);
            sinks.onEvent?.(event);
          }
        : undefined,
    ...(journal
      ? {
          onServiceOutput: (
            source: "docker" | "seed" | "teardown" | "provisioner",
            line: string,
          ) => journal.servicesLog(source).writeLine(line),
          // SIGINT/SIGTERM: what the synchronous teardown did, written after
          // the journal was marked aborted (its live logs are closed then).
          onSignalTeardown: {
            event: (event: ServicesEvent) => journal.appendServicesEvent(event),
            output: (line: string) =>
              journal.appendServicesLogSync("teardown", line),
          },
        }
      : {}),
  };
  if (plan.reuse) return reuseServicesPlan(plan, plan.reuse, ctx);
  return startServices(plan.cfg, ctx);
}

/**
 * `--reuse-services`: one quick readiness look at the environment the lock
 * owns (docker readinessCheck / compose ps, tmux session, windows, readyOn
 * URLs), then a handle that neither started nor will tear down anything.
 */
async function reuseServicesPlan(
  plan: ServicesPlan,
  reuse: NonNullable<ServicesPlan["reuse"]>,
  ctx: StartServicesContext,
): Promise<ServicesHandle> {
  const { lock, path } = reuse;
  ctx.log?.(
    `services: reusing the environment owned by ${describeServicesLock(lock)} — no start, no teardown`,
  );
  const liveness = await checkServicesLive(plan.cfg, ctx);
  if (!liveness.live) {
    throw new ServicesLockError(
      staleLockMessage(plan, reuse, liveness.problems, true),
      "stale",
      path,
    );
  }
  for (const note of liveness.unchecked) ctx.log?.(`services: ${note}`);
  // A provisioned environment's exports (a droplet address, a tenant id) are
  // printed again by their commands: the run needs them in its env.
  const exported = await evaluateProvisionerExports(plan.cfg, ctx);
  return reuseLockedServices(plan.cfg, ctx, lock, exported);
}

/**
 * Resolve and (unless dry-run) start the services environment. A dry run
 * hands the plan text to `onDryRunPlan` and returns a no-op handle.
 */
export async function maybeStartServices(
  firstSpec: string,
  opts: RuntimeOptions &
    Pick<
      RunInvocationOptions,
      "noServices" | "coldStart" | "reuseServices" | "servicesDryRun"
    >,
  scopedSecrets: ScopedSecrets,
  onSpawn: (terminateSync: () => void) => void,
  sinks: {
    journal?: InvocationJournal;
    narration?: () => ServicesNarration | undefined;
    onDryRunPlan: (text: string) => void;
    log: (message: string) => void;
    logDetail: (message: string) => void;
    onOutput: (chunk: string) => void;
    cwd?: string;
    /** false: refuse a plan that would start services (MCP without --allow-services). */
    allowServicesBoot?: boolean;
  },
): Promise<ServicesHandle | undefined> {
  const plan = await resolveServicesPlan(
    firstSpec,
    opts,
    scopedSecrets,
    sinks.cwd,
  );
  if (!plan) return undefined;
  // --services-dry-run: print the plan, return a no-op handle, don't execute.
  if (opts.servicesDryRun) {
    sinks.onDryRunPlan(renderServicesDryRunPlan(plan, scopedSecrets));
    return createNoopServicesHandle();
  }
  assertServicesBootAllowed(plan, sinks.allowServicesBoot);
  return startServicesPlan(plan, scopedSecrets, onSpawn, {
    ...(sinks.journal ? { journal: sinks.journal } : {}),
    ...(sinks.narration ? { narration: sinks.narration() } : {}),
    log: sinks.log,
    logDetail: sinks.logDetail,
    onOutput: sinks.onOutput,
  });
}

/**
 * The key two invocations would fight over: the config file, not the
 * environment. Environments of one config inherit its compose project and
 * tmux session unless they override them, so `--env local` and `--env e2e`
 * usually boot (and tear down) the same stack; serializing them per config
 * is the safe default.
 */
export function environmentLockKey(
  configPath: string | undefined,
  fallbackDir: string,
): string {
  return configPath ?? `${fallbackDir}/(no config)`;
}

/**
 * The caller may not boot (or tear down) config services: an MCP server
 * started without `--allow-services`. Thrown before anything starts; maps to
 * exit 4 like a services-lock refusal.
 */
export class ServicesBootRefusedError extends Error {
  override name = "ServicesBootRefusedError";
  readonly exitCode = 4 as const;
}

/** How an MCP caller avoids the services boot, or allows it. */
export const MCP_SERVICES_GATE_HINT =
  "Pass noServices: true when the stack is already up, reuseServices: true to run against a " +
  "`cairn services up` stack (started from a shell), or restart the server as " +
  "`cairn mcp --allow-services` (or with CAIRN_MCP_ALLOW_SERVICES=1).";

/**
 * Refuse a plan that would start services (and later run their teardown)
 * when the caller may not boot them. A plan that reuses a `cairn services up`
 * lock starts and stops nothing, so it always passes.
 */
export function assertServicesBootAllowed(
  plan: Pick<ServicesPlan, "project" | "envName" | "reuse"> | undefined,
  allowed: boolean | undefined,
): void {
  if (allowed !== false || !plan || plan.reuse) return;
  throw new ServicesBootRefusedError(
    `this MCP server does not boot services: the config services (docker/seed/tmux) of project ` +
      `"${plan.project}" env "${plan.envName}" would start, and their teardown would run afterwards. ` +
      MCP_SERVICES_GATE_HINT,
  );
}

/**
 * Exit code for a resolution error: 4 for an unknown --env, a
 * `cairn services up` lock that refuses the run, or a services boot the
 * caller may not do; else 2.
 */
export function configErrorExitCode(e: unknown): 2 | 4 {
  if (e instanceof ServicesLockError) return e.exitCode;
  if (e instanceof ServicesBootRefusedError) return e.exitCode;
  if (e instanceof EngineRequirementError || e instanceof NodeRuntimeError) {
    return e.exitCode;
  }
  return e instanceof UnknownEnvironmentError ? e.exitCode : 2;
}

/** Resolve the runtime context of the first spec for lock keys (best-effort). */
export async function resolveLockContext(
  firstSpec: string,
  opts: RuntimeOptions,
  scopedSecrets: ScopedSecrets,
  cwd: string = process.cwd(),
): Promise<{ configPath?: string; envName: string; dir: string }> {
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  const ctx = await resolveRunRuntime(firstSpecAbs, opts, {
    env: scopedSecrets.env,
  }).catch(() => undefined);
  return {
    ...(ctx?.configPath ? { configPath: ctx.configPath } : {}),
    envName: ctx?.envName ?? opts.env ?? "local",
    dir: dirname(firstSpecAbs),
  };
}
