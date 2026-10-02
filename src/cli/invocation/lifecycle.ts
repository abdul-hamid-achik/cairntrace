import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { UnknownEnvironmentError } from "../../core/config/runtimeContext";
import { resolveTemplateString } from "../../core/parser/parseSpec";
import {
  checkServicesLive,
  createNoopServicesHandle,
  describeServicesLock,
  readServicesLock,
  reuseLockedServices,
  ServicesLockError,
  startServices,
  type ServicesEvent,
  type ServicesHandle,
  type ServicesLockState,
  type StartServicesContext,
} from "../../core/runner/services";
import type { ServicesOwnerLock } from "../../core/schema/services.v1";
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

type RuntimeOptions = Pick<RunInvocationOptions, "env" | "config" | "var">;

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
): Promise<ScopedSecrets> {
  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  const vars = parseVarFlags(opts.var);

  const scoped = await resolveScopedSecrets(firstSpecAbs, {
    ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
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
  return scoped;
}

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
    } catch (e) {
      if (e instanceof UnknownEnvironmentError) return e;
    }
  }
  const exported = callerEnv.CAIRN_TVAULT_ENV?.trim();
  const others = [...resolvedNames].filter((name) => name !== exported);
  if (exported && others.length > 0) {
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
): Promise<ServicesPlan | undefined> {
  if (opts.noServices) return undefined; // --no-services

  const firstSpecAbs = absoluteSpecPath(firstSpec, cwd);
  if (!(await stat(firstSpecAbs).catch(() => undefined))) return undefined;

  const ctx = await resolveRunRuntime(firstSpecAbs, opts, {
    env: scopedSecrets.env,
  });
  const cfg = ctx.services;
  if (!cfg) return undefined;

  const plan: ServicesPlan = {
    cfg,
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
  const dockerCommand = redactor.text(cfg.docker?.command ?? "");
  const seedCommand = redactor.text(cfg.seed?.command ?? "");
  const lines = [
    "services dry-run plan:",
    `  project: ${project}`,
    `  cold-start: ${coldStart}`,
    cfg.docker
      ? `  docker: ${dockerCommand} (reuseExisting: ${cfg.docker.reuseExisting ?? !coldStart})`
      : "  docker: (not configured)",
    cfg.seed
      ? `  seed: ${seedCommand.slice(0, 80)}${
          seedCommand.length > 80 ? "..." : ""
        } (ttlSeconds: ${cfg.seed.ttlSeconds ?? 0})`
      : "  seed: (not configured)",
    cfg.tmux
      ? `  tmux: session=${cfg.tmux.session}, ${cfg.tmux.windows.length} windows (reuseExisting: ${cfg.tmux.reuseExisting ?? !coldStart})`
      : "  tmux: (not configured)",
    cfg.teardown
      ? `  teardown: ${cfg.teardown.length} command(s)`
      : "  teardown: (none)",
  ];
  const lockLine = plan.lockPreview
    ? dryRunLockLine(plan.lockPreview, plan.envName)
    : undefined;
  if (lockLine) lines.push(lockLine);
  return redactor.text(lines.join("\n") + "\n");
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
  onSpawn: (terminateSync: () => void) => void,
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
    onSpawn,
    env: scopedSecrets.childEnv,
    selectedTvaultKeys: scopedSecrets.selectedKeys,
    secretValues: scopedSecrets.secretValues,
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
        }
      : narration?.onEvent,
    ...(journal
      ? {
          onServiceOutput: (
            source: "docker" | "seed" | "teardown",
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
  return reuseLockedServices(plan.cfg, ctx, lock);
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
