import {
  createArtifactRedactor,
  isSensitiveEnvKey,
} from "../artifacts/redaction";
import {
  type ProjectRuntimeContext,
  resolveProjectRuntimeContext,
} from "../config/runtimeContext";
import { resolveTemplateString } from "../parser/parseSpec";
import { isRelativeUrl, joinUrl } from "../runner/url";
import type {
  BrowserConfig,
  Config,
  ConfigVarValue,
  SecretsConfig,
} from "../schema/config.v1";

/**
 * Where a spec-less browse command (`cairn discover`, `cairn snapshot`, MCP
 * `cairn_discover_open` / `cairn_snapshot`) should navigate, and with which
 * project browser settings. Resolved from the same cairntrace.config.yml a
 * run would use, so discovery sees what the run will see.
 */
export interface BrowseTarget {
  /**
   * The URL as the caller passed it. This is what discovery RECORDS as the
   * `open` step: placeholders (`${secrets.X}`, `${env.X}`, `${vars.X}`) and a
   * relative path stay as written, so an exported spec never carries a
   * resolved secret and still follows the run's environment baseUrl.
   */
  requestedUrl: string;
  /**
   * Absolute URL to open (or the bare path in mock mode without a baseUrl).
   * It can hold resolved env/secret values: navigate with it, but display
   * {@link redactBrowseUrl} output and record {@link requestedUrl}.
   */
  url: string;
  envName: string;
  baseUrl?: string;
  configPath?: string;
  /** Config `browser:` block (provider/device/click tuning/testIdAttribute). */
  browser?: BrowserConfig;
  /** Shortcut for `browser.testIdAttribute` (inventory + `by: testid`). */
  testIdAttribute?: string;
  /** Non-fatal resolution warnings (e.g. implicit environment not defined). */
  warnings: string[];
  /**
   * Values substituted for `${secrets.X}` and for `${env.X}` with a
   * secret-like name (token, password, …). {@link redactBrowseUrl} scrubs
   * them from any URL that is displayed or returned.
   */
  sensitiveValues: string[];
  /** The loaded config (discovery reads `discovery:` / `authoring:`). */
  config?: Config;
  /** `${config.dir}`: the config's directory, or the cwd without one. */
  configDir: string;
  /** Effective `secrets:` block for the environment. */
  secrets?: SecretsConfig;
  /** Resolved `${vars.X}` bag (config env vars + overrides). */
  vars: Record<string, ConfigVarValue>;
}

export interface BrowseTargetOptions {
  url: string;
  /** Environment override; unknown names fail when a config exists. */
  env?: string;
  /** Explicit config path (default: discovery upward from `cwd`). */
  config?: string;
  /** `${vars.X}` overrides; win over config env vars. */
  vars?: Record<string, ConfigVarValue>;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Keep a relative URL as-is when no baseUrl is known instead of failing.
   * Only for the mock backend, which never navigates a real browser.
   */
  allowUnresolvedRelative?: boolean;
  /** Command name used in errors ("discover", "snapshot"). */
  label?: string;
}

/**
 * A relative URL was requested but the selected environment has no
 * `baseUrl`. Navigating a real browser to a bare `/path` would silently land
 * somewhere meaningless, so this fails loudly instead.
 */
export class UnresolvedRelativeUrlError extends Error {
  constructor(
    public readonly requestedUrl: string,
    public readonly envName: string,
    public readonly configPath: string | undefined,
    label: string,
  ) {
    const where = configPath
      ? `${configPath} has no environments.${envName}.baseUrl`
      : "no cairntrace.config.yml was found (pass config / --config)";
    super(
      `relative ${label} URL "${requestedUrl}" requires environments.${envName}.baseUrl: ` +
        `${where}. Pass an absolute URL or configure the baseUrl.`,
    );
    this.name = "UnresolvedRelativeUrlError";
  }
}

/**
 * Resolve config + environment, substitute `${vars.X}` / `${env.X}` /
 * `${baseUrl}` / `${config.dir}` in the URL, and join a relative URL onto the
 * environment's baseUrl. Throws UnknownEnvironmentError (explicit env not in
 * config), MissingTemplateVariableError, or UnresolvedRelativeUrlError.
 *
 * An absolute URL that needs nothing from the config (no `${vars.X}` or
 * `${baseUrl}`) still opens when the auto-discovered config cannot be loaded:
 * the failure becomes a warning and the page opens without the config's
 * browser settings. With an explicit `config` or `env`, a broken config fails.
 */
export async function resolveBrowseTarget(
  opts: BrowseTargetOptions,
): Promise<BrowseTarget> {
  const cwd = opts.cwd ?? process.cwd();
  let runtime: ProjectRuntimeContext;
  try {
    runtime = await resolveProjectRuntimeContext({
      cwd,
      ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(opts.vars && Object.keys(opts.vars).length > 0
        ? { vars: opts.vars }
        : {}),
    });
  } catch (e) {
    if (!canIgnoreConfigFailure(opts)) throw e;
    runtime = {
      envName: "local",
      envSource: "fallback",
      vars: { ...opts.vars },
      configDir: cwd,
      warnings: [
        `ignoring the auto-discovered cairntrace.config.yml for absolute URL ` +
          `(no browser settings applied): ${firstLine(e)} — pass --config ` +
          `(MCP: config) to require it`,
      ],
    };
  }
  const sensitive = new Set<string>();
  const templated = resolveTemplateString(opts.url, {
    vars: runtime.vars,
    configDir: runtime.configDir,
    cwd,
    label: `${opts.label ?? "browse"} URL`,
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    onEnvValue: ({ ns, name, value }) => {
      if (ns === "secrets" || isSensitiveEnvKey(name)) sensitive.add(value);
    },
  });

  let url = templated;
  if (isRelativeUrl(templated)) {
    if (runtime.baseUrl) {
      url = joinUrl(runtime.baseUrl, templated);
    } else if (!opts.allowUnresolvedRelative) {
      throw new UnresolvedRelativeUrlError(
        opts.url,
        runtime.envName,
        runtime.configPath,
        opts.label ?? "browse",
      );
    }
  }

  const testIdAttribute = runtime.browser?.testIdAttribute;
  return {
    requestedUrl: opts.url,
    url,
    envName: runtime.envName,
    warnings: runtime.warnings,
    sensitiveValues: [...sensitive],
    configDir: runtime.configDir,
    vars: runtime.vars,
    ...(runtime.config ? { config: runtime.config } : {}),
    ...(runtime.secrets ? { secrets: runtime.secrets } : {}),
    ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    ...(runtime.configPath ? { configPath: runtime.configPath } : {}),
    ...(runtime.browser ? { browser: runtime.browser } : {}),
    ...(testIdAttribute ? { testIdAttribute } : {}),
  };
}

/**
 * Scrub a URL before it is displayed, returned to an agent, or written to a
 * report: the target's resolved secret values, vault-registered secrets,
 * credential-like query parameters (`token=`, `password=`, …) and URL
 * userinfo become `[redacted]`. Apply it to the browser-reported page URL
 * too, which still carries any secret the opened URL had.
 */
export function redactBrowseUrl(
  target: Pick<BrowseTarget, "sensitiveValues">,
  url: string,
): string {
  return createArtifactRedactor(undefined, {}, target.sensitiveValues).text(
    url,
  );
}

/**
 * A config load failure may be skipped only when the caller asked for no
 * config and no environment, and the URL needs nothing from the config.
 */
function canIgnoreConfigFailure(opts: BrowseTargetOptions): boolean {
  if (opts.config !== undefined || opts.env !== undefined) return false;
  if (isRelativeUrl(opts.url)) return false;
  return !/\$\{(?:vars\.|baseUrl\})/.test(opts.url);
}

/** One readable line for a config load error (zod issues or a YAML error). */
function firstLine(e: unknown): string {
  const issues = (e as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const first = issues[0] as { path?: unknown[]; message?: string };
    const path = Array.isArray(first.path) ? first.path.join(".") : "";
    const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
    return `${path ? `${path}: ` : ""}${first.message ?? "invalid"}${more}`;
  }
  const message = e instanceof Error ? e.message : String(e);
  const line =
    message
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "invalid config";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
