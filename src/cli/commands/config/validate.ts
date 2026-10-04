import { existsSync } from "node:fs";
import { readFile, access, constants } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  environmentDatasourceProblems,
  type Config,
} from "../../../core/schema/config.v1";
import type { ConfigFindingRow } from "../../../core/schema/configVars.v1";
import { findConfigFile } from "../../../core/config/loader";
import { environmentServicesOf } from "../../../core/config/runtimeContext";
import { composeConfigText, relativeTo } from "../../../core/config/compose";
import {
  findingRow,
  literalVarRefFindings,
  unusedConfigVars,
} from "../../../core/config/varsReport";
import { prepareWidgets } from "../../../core/widgets/runtime";
import {
  suiteEnvFallbackFindings,
  validateSuites,
} from "../../../core/suites/validate";
import { engineRequirementProblem } from "../../../core/engineRequirements";
import { validateExportTargets } from "./exportTargets";
import { resolveNodeRuntime } from "../../../core/runtimes";
import { emit, resolveFormat } from "../../format";

export interface ConfigValidateOptions {
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface ConfigValidateResult {
  ok: boolean;
  path: string;
  errors: string[];
  /** Top-level config keys present (for quick overview). */
  keys: string[];
  /** The parsed config if valid (undefined when invalid). */
  config?: Config;
  /** Non-fatal findings (deprecated keys); present only when some exist. */
  warnings?: string[];
  /**
   * F7: config files beyond this one that `include:` merged (relative to
   * the config directory); present only when some exist.
   */
  includes?: string[];
  /**
   * F7: composition findings — `include-override` (info: an included entry
   * replaced by a later file), `include-empty`, `unused-var`, `literal-var-ref` and `suite-env-fallback` (warnings,
   * also in `warnings`); present only when some exist.
   */
  findings?: ConfigFindingRow[];
  /** E8: `export.targets` profiles (name and what each writes into). */
  exportTargets?: Array<{
    name: string;
    into?: string;
    hostConfig?: string;
    input?: string;
    mapFile?: string;
    maxEvalRatio?: number;
  }>;
  /**
   * The services phases each environment boots (its own `services:` merged
   * over the top-level block, or alone without one); environments that boot
   * none are absent. Present when any environment has services.
   */
  environmentServices?: Record<string, string[]>;
  /**
   * Environments with a delegated runner (`environments.<n>.runner`): they
   * run elsewhere and boot nothing locally. Additive.
   */
  delegatedEnvironments?: string[];
  /** Summary of the top-level services block if present. */
  services?: {
    docker: boolean;
    seed: boolean;
    tmux: boolean;
    tmuxSession?: string;
    tmuxWindows: number;
    teardown: number;
    /** A provisioner (`up` / `down` / `exports`) is configured. */
    provisioner?: boolean;
    /** Names of `services.tunnels`. */
    tunnels?: string[];
    /** Paths of `services.files`. */
    files?: string[];
    /** Names of `services.seed.phases`. */
    seedPhases?: string[];
    stash?: {
      enabled: boolean;
      autoStash: string;
      capture: string[];
      tags?: string[];
    };
  };
}

/**
 * Pure validation logic — no process.exit, no stdout writes. Returns the result
 * and an exit code. The CLI command wraps this for output + exit.
 */
export async function validateConfigFile(
  configPath: string | undefined,
): Promise<{ result: ConfigValidateResult; exitCode: number }> {
  // Resolve config path
  let resolvedPath: string | undefined;
  if (configPath) {
    resolvedPath = isAbsolute(configPath)
      ? configPath
      : resolve(process.cwd(), configPath);
    try {
      await access(resolvedPath, constants.R_OK);
    } catch {
      return {
        result: {
          ok: false,
          path: configPath,
          errors: [`config file not found: ${resolvedPath}`],
          keys: [],
        },
        exitCode: 4,
      };
    }
  } else {
    resolvedPath = await findConfigFile(process.cwd());
    if (!resolvedPath) {
      return {
        result: {
          ok: false,
          path: "(auto-discovery)",
          errors: [
            "no cairntrace.config.yml found — pass --config <path> or place cairntrace.config.yml in the project tree",
          ],
          keys: [],
        },
        exitCode: 4,
      };
    }
  }

  const text = await readFile(resolvedPath, "utf8");

  // The exact text → object step `cairn run` uses (loadConfig): `${env.X}` /
  // `${env.X:-default}`, YAML merge keys (`<<: *anchor`), `${config.dir}`,
  // then F7 composition (`include:`, top-level `vars:`, `extends:`, var
  // references). Include and extends cycles, a missing include and an
  // undefined var reference are errors.
  const composed = await composeConfigText(text, { configPath: resolvedPath });
  const rel = (path: string) => relativeTo(dirname(resolvedPath), path);
  if (!composed.ok) {
    const findings = composed.findings.map((f) => findingRow(f, resolvedPath));
    return {
      result: {
        ok: false,
        path: resolvedPath,
        errors: composed.errors,
        keys: composed.keys,
        ...(findings.length > 0 ? { findings } : {}),
      },
      exitCode: 4,
    };
  }

  const config = composed.config;
  const composition = composed.composition;
  // Datasource overrides are validated per half by the schema; a merge that
  // only breaks once an environment's override lands on the top-level entry
  // is reported here instead of on the first verifier that uses it.
  const mergeProblems = environmentDatasourceProblems(config);
  // An environment's services block stands alone without a top-level one
  // (or merges over it): the provisioner it ends up with must still have
  // `up` and `down` (a run refuses to boot it otherwise).
  const envServices = environmentServicesOf(config);
  for (const [envName, services] of Object.entries(envServices)) {
    const provisioner = services?.provisioner as
      | { up?: unknown; down?: unknown }
      | undefined;
    if (
      provisioner &&
      (provisioner.up === undefined || provisioner.down === undefined)
    ) {
      const missing = provisioner.up === undefined ? "up" : "down";
      mergeProblems.push(
        `environments.${envName}.services.provisioner: no \`${missing}\` after the merge ${
          config.services
            ? "over the top-level services"
            : "(there is no top-level services block: the environment's provisioner stands alone)"
        }; a provisioner needs both \`up\` and \`down\` (a provisioned resource must always have a \`down\`)`,
      );
    }
  }
  // F15: widget driver modules must exist and compile (they run in the page).
  try {
    await prepareWidgets(config.browser, dirname(resolvedPath));
  } catch (e) {
    mergeProblems.push((e as Error).message);
  }
  // F18: an environment login's hydrate file runs in the page: it must exist.
  for (const [envName, env] of Object.entries(config.environments)) {
    const file = env.auth?.hydrate?.file;
    if (!file) continue;
    const abs = isAbsolute(file) ? file : resolve(dirname(resolvedPath), file);
    if (!existsSync(abs)) {
      mergeProblems.push(
        `environments.${envName}.auth.hydrate.file: ${file} does not exist (relative to the config directory)`,
      );
    }
  }
  // F19: the cairn this config needs, and the node it pins.
  const engineProblem = engineRequirementProblem(
    config,
    undefined,
    resolvedPath,
  );
  if (engineProblem) mergeProblems.push(engineProblem);
  if (config.runtimes?.node) {
    try {
      resolveNodeRuntime(config.runtimes, { configDir: dirname(resolvedPath) });
    } catch (e) {
      mergeProblems.push(`runtimes.node: ${(e as Error).message}`);
    }
  }
  // F9: every suite must resolve to specs in the environments it can run in.
  const suiteCheck = await validateSuites(config, dirname(resolvedPath));
  mergeProblems.push(...suiteCheck.errors);
  // E8: every export target must work as an export request on its own.
  mergeProblems.push(
    ...(await validateExportTargets(config, dirname(resolvedPath))),
  );
  if (mergeProblems.length > 0) {
    return {
      result: {
        ok: false,
        path: resolvedPath,
        errors: mergeProblems,
        keys: Object.keys(config),
      },
      exitCode: 4,
    };
  }

  // Valid — build the result with a services summary
  const warnings = [...deprecationWarnings(config), ...suiteCheck.warnings];
  // F7: findings of the composition (include overrides, empty globs) and
  // vars nothing uses (dead vars) — warnings, never errors.
  const findings = [
    ...composition.findings.map((f) => findingRow(f, resolvedPath)),
    ...(await unusedConfigVars(resolvedPath, config, composition)),
    ...literalVarRefFindings(config),
    ...suiteEnvFallbackFindings(config).map(
      (f): ConfigFindingRow => ({
        level: "warning",
        code: "suite-env-fallback",
        key: f.key,
        message: f.message,
      }),
    ),
  ];
  for (const finding of findings) {
    if (finding.level === "warning") warnings.push(finding.message);
  }
  const includes = composition.files.slice(1).map(rel);
  return {
    result: {
      ok: true,
      path: resolvedPath,
      errors: [],
      keys: Object.keys(config),
      config,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(includes.length > 0 ? { includes } : {}),
      ...(findings.length > 0 ? { findings } : {}),
      ...(config.export?.targets &&
      Object.keys(config.export.targets).length > 0
        ? {
            exportTargets: Object.entries(config.export.targets).map(
              ([name, target]) => ({
                name,
                ...(target.into ? { into: target.into } : {}),
                ...(target.hostConfig ? { hostConfig: target.hostConfig } : {}),
                ...(target.input ? { input: target.input } : {}),
                ...(target.mapFile ? { mapFile: target.mapFile } : {}),
                ...(target.maxEvalRatio !== undefined
                  ? { maxEvalRatio: target.maxEvalRatio }
                  : {}),
              }),
            ),
          }
        : {}),
      ...environmentServicesSummary(envServices),
      ...delegatedEnvironmentsOf(config),
      services: config.services
        ? {
            docker: !!config.services.docker,
            seed: !!config.services.seed,
            tmux: !!config.services.tmux,
            tmuxSession: config.services.tmux?.session,
            tmuxWindows: config.services.tmux?.windows.length ?? 0,
            teardown: config.services.teardown?.length ?? 0,
            ...(config.services.provisioner ? { provisioner: true } : {}),
            ...(config.services.tunnels
              ? { tunnels: config.services.tunnels.map((t) => t.name) }
              : {}),
            ...(config.services.files
              ? { files: config.services.files.map((f) => f.path) }
              : {}),
            ...(config.services.seed?.phases
              ? { seedPhases: config.services.seed.phases.map((p) => p.name) }
              : {}),
            stash: config.services.stash
              ? {
                  enabled: config.services.stash.enabled,
                  // Unset keeps the legacy "after every invocation".
                  autoStash: config.services.stash.autoStash ?? "always",
                  capture: config.services.stash.capture,
                  tags: config.services.stash.tags,
                }
              : undefined,
          }
        : undefined,
    },
    exitCode: 0,
  };
}

/** `delegatedEnvironments` of the result (absent when none has a runner). */
function delegatedEnvironmentsOf(
  config: Config,
): Pick<ConfigValidateResult, "delegatedEnvironments"> {
  const names = Object.entries(config.environments)
    .filter(([, env]) => env.runner !== undefined)
    .map(([name]) => name)
    .toSorted();
  return names.length > 0 ? { delegatedEnvironments: names } : {};
}

/** `environmentServices` of the result (absent when no environment has services). */
function environmentServicesSummary(
  envServices: Record<string, Config["services"] | undefined>,
): Pick<ConfigValidateResult, "environmentServices"> {
  const phases = [
    "provisioner",
    "tunnels",
    "docker",
    "files",
    "seed",
    "tmux",
  ] as const;
  const out: Record<string, string[]> = {};
  for (const [envName, services] of Object.entries(envServices)) {
    if (!services) continue;
    out[envName] = phases.filter((phase) => services[phase] !== undefined);
  }
  return Object.keys(out).length > 0 ? { environmentServices: out } : {};
}

/** Deprecated-but-valid config keys, one warning each. */
function deprecationWarnings(config: Config): string[] {
  const warnings: string[] = [];
  const servicesStash =
    "is deprecated: use services.artifacts (bounded, redacted service logs inside each run directory) and let stash.autoStash carry them; until removal it stashes separately, honoring autoStash (unset: after every invocation, as before) and ttl (default 7d)";
  if (config.services?.stash) warnings.push(`services.stash ${servicesStash}`);
  for (const [name, environment] of Object.entries(config.environments)) {
    const services = environment.services;
    if (services && typeof services === "object" && services.stash) {
      warnings.push(`environments.${name}.services.stash ${servicesStash}`);
    }
  }
  return warnings;
}

export async function configValidateCommand(
  opts: ConfigValidateOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const { result, exitCode } = await validateConfigFile(opts.config);

  for (const warning of result.warnings ?? []) {
    process.stderr.write(`cairn config validate: warning: ${warning}\n`);
  }
  process.stdout.write(emit(format, result, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exit(exitCode);
}

function toMarkdown(r: ConfigValidateResult): string {
  const lines: string[] = [
    `# Config validation — ${r.ok ? "valid" : "invalid"}`,
    "",
    `- path: ${r.path}`,
    `- ok: ${r.ok}`,
  ];

  if (r.keys.length > 0) {
    lines.push(`- keys: ${r.keys.join(", ")}`);
  }
  if (r.includes?.length) {
    lines.push(`- includes: ${r.includes.join(", ")}`);
  }

  if (r.exportTargets?.length) {
    lines.push("", "## Export targets");
    for (const target of r.exportTargets) {
      lines.push(
        `- ${target.name}: ${[
          target.input ? `input ${target.input}` : undefined,
          target.into ? `into ${target.into}` : undefined,
          target.hostConfig ? `host ${target.hostConfig}` : undefined,
          target.mapFile ? `map ${target.mapFile}` : undefined,
          target.maxEvalRatio !== undefined
            ? `max eval ratio ${target.maxEvalRatio}`
            : undefined,
        ]
          .filter(Boolean)
          .join(", ")}`,
      );
    }
  }

  if (r.environmentServices) {
    lines.push("", "## Services per environment");
    for (const [envName, phases] of Object.entries(r.environmentServices)) {
      lines.push(`- ${envName}: ${phases.join(" → ") || "(teardown only)"}`);
    }
  }

  if (r.services) {
    lines.push("", "## Services");
    lines.push(
      `- docker: ${r.services.docker ? "configured" : "not configured"}`,
    );
    lines.push(`- seed: ${r.services.seed ? "configured" : "not configured"}`);
    lines.push(`- tmux: ${r.services.tmux ? "configured" : "not configured"}`);
    if (r.services.tmuxSession) {
      lines.push(`- tmux session: ${r.services.tmuxSession}`);
    }
    if (r.services.tmuxWindows > 0) {
      lines.push(`- tmux windows: ${r.services.tmuxWindows}`);
    }
    if (r.services.teardown > 0) {
      lines.push(`- teardown commands: ${r.services.teardown}`);
    }
    if (r.services.provisioner) lines.push("- provisioner: configured");
    if (r.services.tunnels?.length) {
      lines.push(`- tunnels: ${r.services.tunnels.join(", ")}`);
    }
    if (r.services.files?.length) {
      lines.push(`- files: ${r.services.files.join(", ")}`);
    }
    if (r.services.seedPhases?.length) {
      lines.push(`- seed phases: ${r.services.seedPhases.join(", ")}`);
    }
    if (r.services.stash) {
      lines.push(`- stash enabled: ${r.services.stash.enabled}`);
      lines.push(`- stash autoStash: ${r.services.stash.autoStash}`);
      if (r.services.stash.capture.length > 0) {
        lines.push(`- stash capture: ${r.services.stash.capture.join(", ")}`);
      }
      if (r.services.stash.tags && r.services.stash.tags.length > 0) {
        lines.push(`- stash tags: ${r.services.stash.tags.join(", ")}`);
      }
    }
  }

  if (r.errors.length > 0) {
    lines.push("", "## Errors");
    for (const err of r.errors) {
      lines.push(`- ${err}`);
    }
  }

  if (r.warnings?.length) {
    lines.push("", "## Warnings");
    for (const warning of r.warnings) lines.push(`- ${warning}`);
  }

  const info = r.findings?.filter((f) => f.level === "info") ?? [];
  if (info.length > 0) {
    lines.push("", "## Include overrides");
    for (const finding of info) lines.push(`- ${finding.message}`);
  }

  return lines.join("\n");
}
