import { isAbsolute as isAbsolutePath, resolve } from "node:path";
import { resolveSpecRuntimeContext } from "../../core/config/runtimeContext";
import type { BrowserConfig } from "../../core/schema/config.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import { type BackendChoice, createBackend } from "../backendFactory";

export type { RunInvocationOptions };

/**
 * Parse repeatable `--var key=value` flags into a vars bag.
 * Values may contain `=` (split happens on the first one).
 */
export function parseVarFlags(
  pairs: string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--var expects key=value, got "${pair}"`);
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function parseHookTimeoutMs(raw: string | undefined): number {
  const value = raw ?? "600000";
  if (!/^\d+$/.test(value)) {
    throw new Error(`--hook-timeout-ms expects an integer, got "${value}"`);
  }
  const milliseconds = Number(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 7_200_000
  ) {
    throw new Error("--hook-timeout-ms must be between 1 and 7200000");
  }
  return milliseconds;
}

/** `CI=1`-style truthiness: set, non-empty and not "0". */
export function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

/** Absolute spec path (relative paths resolve against `cwd`). */
export function absoluteSpecPath(
  specPath: string,
  cwd: string = process.cwd(),
): string {
  return isAbsolutePath(specPath) ? specPath : resolve(cwd, specPath);
}

/**
 * The ONE runtime resolver every run phase uses (preflight, secrets,
 * services, webServer, browser block, hooks, post-run integrations): the
 * spec's config, environment and vars exactly as the runner will see them.
 * `env` is the invocation's scoped environment where a phase needs it
 * (`${env.X}` / `${secrets.X}` in config values).
 */
export function resolveRunRuntime(
  specPath: string,
  opts: Pick<RunInvocationOptions, "env" | "config" | "var">,
  extra: {
    env?: Record<string, string | undefined>;
    onWarning?: (message: string) => void;
  } = {},
): ReturnType<typeof resolveSpecRuntimeContext> {
  const vars = parseVarFlags(opts.var);
  return resolveSpecRuntimeContext(specPath, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    ...(extra.env ? { env: extra.env } : {}),
    ...(extra.onWarning ? { onWarning: extra.onWarning } : {}),
  });
}

/** Backend-relevant subset of the run options (also used by discover/snapshot). */
export interface BackendFlagOptions {
  mock?: boolean;
  headed?: boolean;
  backend?: BackendChoice;
  provider?: string;
  device?: string;
}

/**
 * Backend construction options: run flags win over the config `browser:`
 * block (provider/device); click tuning and `testIdAttribute` come from the
 * config. Shared by `cairn run`, MCP `cairn_run`, discover and snapshot.
 */
export function backendOpts(
  opts: BackendFlagOptions,
  browser?: BrowserConfig,
): Parameters<typeof createBackend>[0] {
  // CLI flags win over config `browser.*`.
  const provider = opts.provider ?? browser?.provider;
  const device = opts.device ?? browser?.device;
  return {
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(browser?.verifyAfterClick !== undefined
      ? { verifyAfterClick: browser.verifyAfterClick }
      : {}),
    ...(browser?.postClickSettleMs !== undefined
      ? { postClickSettleMs: browser.postClickSettleMs }
      : {}),
    ...(browser?.testIdAttribute !== undefined
      ? { testIdAttribute: browser.testIdAttribute }
      : {}),
  };
}

/**
 * The `cairn run …` command line equivalent to an options object, for the
 * invocation journal of a non-CLI invocation (MCP) and for "rerun this"
 * hints. Values are emitted verbatim; the journal redacts them.
 */
export function runOptionsToArgv(
  specs: readonly string[],
  opts: RunInvocationOptions,
): string[] {
  const argv: string[] = ["run", ...specs];
  const flag = (name: string, value: unknown): void => {
    if (value === undefined || value === false) return;
    if (value === true) argv.push(name);
    else argv.push(name, String(value));
  };
  const each = (name: string, values: string[] | undefined): void => {
    for (const value of values ?? []) argv.push(name, value);
  };
  flag("--env", opts.env);
  flag("--config", opts.config);
  each("--var", opts.var);
  flag("--cold-start", opts.coldStart);
  flag("--headed", opts.headed);
  flag("--mock", opts.mock);
  flag("--backend", opts.backend);
  flag("--provider", opts.provider);
  flag("--device", opts.device);
  flag("--parallel", opts.parallel);
  flag("--artifact-root", opts.artifactRoot);
  flag("--junit", opts.junit);
  flag("--stamp-if-green", opts.stampIfGreen);
  flag("--no-web-server", opts.noWebServer);
  flag("--no-services", opts.noServices);
  flag("--services-dry-run", opts.servicesDryRun);
  flag("--reuse-services", opts.reuseServices);
  flag("--stash-on-failure", opts.stashOnFailure);
  flag("--stash", opts.stash);
  flag("--auto-annotate", opts.autoAnnotate);
  flag("--monitor", opts.monitor);
  flag("--since-codemap", opts.sinceCodemap);
  flag("--select-only", opts.selectOnly);
  flag("--suite", opts.suite);
  each("--tag", opts.tag);
  each("--label", opts.label);
  each("--before", opts.before);
  each("--after", opts.after);
  flag("--hook-timeout-ms", opts.hookTimeoutMs);
  flag("--repeat", opts.repeat);
  flag("--matrix", opts.matrix);
  flag("--stop-on-fail", opts.stopOnFail);
  flag("--bail", opts.bail);
  if (opts.bail === false) argv.push("--no-bail");
  flag("--strict-requires", opts.strictRequires);
  flag("--allow-fixture-writes", opts.allowFixtureWrites);
  flag("--run-token", opts.runToken);
  return argv;
}
