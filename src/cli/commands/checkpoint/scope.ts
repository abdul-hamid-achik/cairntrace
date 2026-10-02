import {
  buildCheckpointMeta,
  type CheckpointMeta,
  parseTtlMs,
  urlOrigin,
} from "../../../core/checkpoint/meta";
import { resolveProjectRuntimeContext } from "../../../core/config/runtimeContext";

/** Scope flags shared by `cairn login` and `cairn checkpoint capture-from-session`. */
export interface CheckpointScopeOptions {
  /** Environment the checkpoint is for (its baseUrl scopes the checkpoint). */
  env?: string;
  /** Explicit cairntrace.config.yml for `--env`. */
  config?: string;
  /** Lifetime, e.g. `12h`, `7d`; resume refuses it afterwards. */
  ttl?: string;
}

/** The validated scope, resolved before any browser work. */
export interface CheckpointScope {
  env?: string;
  /** The environment's baseUrl (absent without `--env`/`--config` or baseUrl). */
  envBaseUrl?: string;
  ttl?: string;
}

/**
 * Validate the scope flags up front: a bad `--ttl` throws, and so does an
 * `--env` the config does not define (UnknownEnvironmentError, exit 4).
 */
export async function resolveCheckpointScope(
  opts: CheckpointScopeOptions,
  cwd?: string,
): Promise<CheckpointScope> {
  if (opts.ttl !== undefined) parseTtlMs(opts.ttl);
  if (opts.env === undefined && opts.config === undefined) {
    return opts.ttl !== undefined ? { ttl: opts.ttl } : {};
  }
  const ctx = await resolveProjectRuntimeContext({
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(cwd ? { cwd } : {}),
  });
  return {
    ...(opts.env !== undefined ? { env: ctx.envName } : {}),
    ...(ctx.baseUrl ? { envBaseUrl: ctx.baseUrl } : {}),
    ...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
  };
}

/**
 * The metadata a capture records at save time: the environment's `baseUrl`
 * when the scope has one, else the origin of the page the state came from.
 */
export function checkpointMetaFor(
  name: string,
  scope: CheckpointScope,
  input: { pageUrl?: string; capturedBy: CheckpointMeta["capturedBy"] },
): CheckpointMeta {
  const baseUrl = scope.envBaseUrl ?? urlOrigin(input.pageUrl);
  return buildCheckpointMeta({
    name,
    ...(baseUrl ? { baseUrl } : {}),
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.ttl !== undefined ? { ttl: scope.ttl } : {}),
    ...(input.capturedBy ? { capturedBy: input.capturedBy } : {}),
  });
}
