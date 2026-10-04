import { dirname, isAbsolute, resolve } from "node:path";
import { findConfigFile } from "../../../core/config/loader";
import {
  resolveProjectRuntimeContext,
  UnknownEnvironmentError,
} from "../../../core/config/runtimeContext";
import { createArtifactRedactor } from "../../../core/artifacts/redaction";
import { EngineRequirementError } from "../../../core/engineRequirements";
import type { ArtifactRedactor } from "../../../core/artifacts/ArtifactWriter";
import type { GateNode } from "../../../core/gates/schema";
import type { Config, ServicesConfig } from "../../../core/schema/config.v1";
import type { RunPolicyConfig } from "../../../core/runPolicy/schema";
import { noSecretsScope } from "../../invocation/policy";
import { resolveScopedSecrets, type ScopedSecrets } from "../secrets";

/**
 * The project + environment `cairn services up` / `down` act on: the config
 * (explicit `--config`, else discovered from the cwd upward), the environment
 * (`--env`, else `defaultEnvironment`, else `local`) and its effective
 * `services` block, resolved like `cairn run` resolves them.
 */
export interface ServicesTarget {
  configPath: string;
  configDir: string;
  project: string;
  envName: string;
  /** Effective services (undefined: no block, or `services: false` for the env). */
  services?: ServicesConfig;
  /** The config's `gates:` registry (`docker.ready`, tmux readiness gates). */
  gates?: Readonly<Record<string, GateNode>>;
  /** The config's own `project:` (unset: none; `project` then reads "cairntrace"). */
  configProject?: string;
  /** The environment's effective `run:` policy (its `lock` guards services commands). */
  runPolicy?: RunPolicyConfig;
  /** The config's `run:` and environments (every declared run lock). */
  lockConfig?: Pick<Config, "run" | "environments">;
  scopedSecrets: ScopedSecrets;
  /** Redacts the scoped secret values out of commands and events. */
  redactor: ArtifactRedactor;
  warnings: string[];
}

/** A `services up` / `down` target problem with its exit code. */
export class ServicesCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 4,
  ) {
    super(message);
    this.name = "ServicesCommandError";
  }
}

export interface ServicesTargetOptions {
  config?: string;
  env?: string;
  cwd?: string;
}

/** An unmet `requires.cairntrace` refuses with exit 4, like a run. */
function targetExitCode(e: unknown): 2 | 4 {
  return e instanceof UnknownEnvironmentError ||
    e instanceof EngineRequirementError
    ? 4
    : 2;
}

/**
 * Resolve the target. `secrets: "required"` (up) fails when the TinyVault
 * scope cannot be resolved, like a run; `"best-effort"` (down) falls back to
 * an environment without vault values and says so in `warnings`, so a locked
 * vault never prevents a teardown. Throws {@link ServicesCommandError}: exit 4
 * for a missing config or an environment the config does not define, exit 2
 * for an unreadable/invalid config or a vault failure.
 */
export async function resolveServicesTarget(
  opts: ServicesTargetOptions,
  secrets: "required" | "best-effort",
  /**
   * `teardown` (`services down`): an unmet `requires.cairntrace` is a
   * warning, never a refusal — a pinned config must still be torn down.
   */
  purpose: "boot" | "teardown" = "boot",
): Promise<ServicesTarget> {
  const skipRequires = purpose === "teardown";
  const cwd = opts.cwd ?? process.cwd();
  const configPath = await resolveServicesConfigPath(opts);
  if (!configPath) {
    throw new ServicesCommandError(
      `no cairntrace.config.yml found from ${cwd} upward; pass --config <path>`,
      4,
    );
  }
  const warnings: string[] = [];
  let scopedSecrets: ScopedSecrets;
  try {
    // The config doubles as the "spec" anchor: it has no `environment:` /
    // `vars:` of its own, and its `${env.X}` / `${secrets.X}` names join the
    // selected vault keys next to `secrets.keys` / `secrets.required`.
    scopedSecrets = await resolveScopedSecrets(configPath, {
      configPath,
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(skipRequires ? { skipRequires: true } : {}),
    });
  } catch (e) {
    if (targetExitCode(e) === 4) {
      throw new ServicesCommandError((e as Error).message, 4);
    }
    if (secrets === "required" || !/tvault/i.test((e as Error).message)) {
      throw new ServicesCommandError((e as Error).message, 2);
    }
    warnings.push(
      `${(e as Error).message}; teardown commands run without vault secrets`,
    );
    scopedSecrets = noSecretsScope(
      process.env as Record<string, string | undefined>,
    );
  }
  let ctx: Awaited<ReturnType<typeof resolveProjectRuntimeContext>>;
  try {
    ctx = await resolveProjectRuntimeContext({
      configPath,
      cwd,
      env: scopedSecrets.env,
      ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      ...(skipRequires ? { skipRequires: true } : {}),
      onWarning: (message) => warnings.push(message),
    });
  } catch (e) {
    throw new ServicesCommandError((e as Error).message, targetExitCode(e));
  }
  return {
    configPath,
    configDir: ctx.configPath ? dirname(ctx.configPath) : dirname(configPath),
    project: ctx.config?.project ?? "cairntrace",
    envName: ctx.envName,
    ...(ctx.services ? { services: ctx.services } : {}),
    ...(ctx.config?.gates ? { gates: ctx.config.gates } : {}),
    ...(ctx.config?.project ? { configProject: ctx.config.project } : {}),
    ...(ctx.runPolicy ? { runPolicy: ctx.runPolicy } : {}),
    ...(ctx.config
      ? {
          lockConfig: {
            ...(ctx.config.run ? { run: ctx.config.run } : {}),
            environments: ctx.config.environments,
          },
        }
      : {}),
    scopedSecrets,
    redactor: createArtifactRedactor(
      undefined,
      scopedSecrets.env,
      scopedSecrets.secretValues,
    ),
    warnings,
  };
}

/**
 * The config file a services command acts on: `config` (relative to `cwd`),
 * else the first cairntrace.config.yml from `cwd` upward. Also the key the
 * MCP server serializes services up/down and runs on.
 */
export async function resolveServicesConfigPath(
  opts: Pick<ServicesTargetOptions, "config" | "cwd">,
): Promise<string | undefined> {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.config) {
    return isAbsolute(opts.config) ? opts.config : resolve(cwd, opts.config);
  }
  return findConfigFile(cwd);
}

/** The "nothing to start" message for an environment without services. */
export function noServicesMessage(target: ServicesTarget): string {
  return (
    `no services configured for env "${target.envName}" in ${target.configPath} ` +
    `(no \`services:\` block, or environments.${target.envName}.services: false)`
  );
}
