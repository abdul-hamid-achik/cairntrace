import { readFile, access, constants } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type Config } from "../../../core/schema/config.v1";
import { findConfigFile } from "../../../core/config/loader";
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
  /** Summary of services block if present. */
  services?: {
    docker: boolean;
    seed: boolean;
    tmux: boolean;
    tmuxSession?: string;
    tmuxWindows: number;
    teardown: number;
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

  // Substitute ${env.X} the same way loadConfig does
  const substituted = text.replace(
    /\$\{env\.(\w+)\}/g,
    (_match, name: string) => process.env[name] ?? "",
  );

  let raw: unknown;
  try {
    raw = parseYaml(substituted);
  } catch (e) {
    return {
      result: {
        ok: false,
        path: resolvedPath,
        errors: [`YAML parse error: ${(e as Error).message}`],
        keys: [],
      },
      exitCode: 4,
    };
  }

  const parsed = ConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    const keys =
      raw && typeof raw === "object"
        ? Object.keys(raw as Record<string, unknown>)
        : [];
    return {
      result: {
        ok: false,
        path: resolvedPath,
        errors,
        keys,
      },
      exitCode: 4,
    };
  }

  // Valid — build the result with a services summary
  const config = parsed.data;
  return {
    result: {
      ok: true,
      path: resolvedPath,
      errors: [],
      keys: Object.keys(config),
      config,
      services: config.services
        ? {
            docker: !!config.services.docker,
            seed: !!config.services.seed,
            tmux: !!config.services.tmux,
            tmuxSession: config.services.tmux?.session,
            tmuxWindows: config.services.tmux?.windows.length ?? 0,
            teardown: config.services.teardown?.length ?? 0,
            stash: config.services.stash
              ? {
                  enabled: config.services.stash.enabled,
                  autoStash: config.services.stash.autoStash,
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

export async function configValidateCommand(
  opts: ConfigValidateOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const { result, exitCode } = await validateConfigFile(opts.config);

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

  return lines.join("\n");
}
