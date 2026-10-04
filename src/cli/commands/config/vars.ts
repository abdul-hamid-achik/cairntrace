import { buildConfigVars } from "../../../core/config/varsReport";
import type {
  ConfigVarRow,
  ConfigVarsResult,
} from "../../../core/schema/configVars.v1";
import { emit, resolveFormat } from "../../format";

export interface ConfigVarsCommandOptions {
  config?: string;
  env?: string;
  unused?: boolean;
  usedBy?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * `cairn config vars` (F7): every config var — kind, effective value per
 * environment (secret-looking values masked), where it is defined, what
 * overrides it and what uses it. Exit 0, or 4 when the config is missing or
 * invalid, `--env` is unknown or `--used-by` names no spec.
 */
export async function configVarsCommand(
  opts: ConfigVarsCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const { result, exitCode } = await buildConfigVars({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.unused ? { unused: true } : {}),
    ...(opts.usedBy !== undefined ? { usedBy: opts.usedBy } : {}),
  });
  for (const warning of result.warnings ?? []) {
    process.stderr.write(`cairn config vars: warning: ${warning}\n`);
  }
  process.stdout.write(emit(format, result, configVarsToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  // exitCode, not exit(): a large document must drain into a pipe first.
  process.exitCode = exitCode;
}

const MAX_CELL = 48;

function cell(value: unknown): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const short =
    text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
  return short.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function usedBySummary(row: ConfigVarRow): string {
  if (row.unused) return "**unused**";
  const counts = new Map<string, number>();
  for (const use of row.usedBy) {
    counts.set(use.kind, (counts.get(use.kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`)
    .join(", ");
}

export function configVarsToMarkdown(r: ConfigVarsResult): string {
  const lines: string[] = [
    `# Config vars — ${
      r.ok ? `${r.vars.length} of ${r.totals.vars}` : "error"
    }`,
    "",
    `- config: ${r.path}`,
  ];
  if (r.files.length > 1) {
    lines.push(`- included: ${r.files.slice(1).join(", ")}`);
  }
  if (r.environments.length > 0) {
    lines.push(`- environments: ${r.environments.join(", ")}`);
  }
  if (r.filter) {
    const parts = [
      r.filter.env !== undefined ? `--env ${r.filter.env}` : undefined,
      r.filter.unused ? "--unused" : undefined,
      r.filter.usedBy !== undefined
        ? `--used-by ${r.filter.usedBy}`
        : undefined,
    ].filter(Boolean);
    lines.push(`- filter: ${parts.join(" ")}`);
  }
  if (r.ok) {
    lines.push(
      `- unused: ${r.totals.unused} · same in every environment: ${r.totals.sameInAllEnvironments} · same wherever defined (2+ environments): ${r.totals.sameWhereDefined} · differing: ${r.totals.differing}`,
    );
  }
  if (r.errors?.length) {
    lines.push("", "## Errors");
    for (const error of r.errors) lines.push(`- ${error}`);
    return lines.join("\n");
  }
  if (r.vars.length > 0) {
    const envs = r.environments;
    lines.push(
      "",
      `| var | kind | ${envs.join(" | ")} | defined at | used by |`,
      `|---|---|${envs.map(() => "---|").join("")}---|---|`,
    );
    for (const row of r.vars) {
      const values = envs.map((env) => {
        const value = row.values[env];
        return value === undefined ? "—" : cell(value.value);
      });
      const defined = row.definedAt.map((d) => d.at).join(", ");
      lines.push(
        `| ${row.name} | ${row.kind} | ${values.join(" | ")} | ${cell(defined)} | ${usedBySummary(row)} |`,
      );
    }
  }
  const overrides = r.vars.filter((row) => row.overriddenBy.length > 0);
  if (overrides.length > 0) {
    lines.push("", "## Overrides");
    for (const row of overrides) {
      for (const o of row.overriddenBy) {
        lines.push(
          `- ${row.name}: ${o.scope} (${o.at}) wins in ${o.envs.join(", ")}`,
        );
      }
    }
  }
  if (r.findings.length > 0) {
    lines.push("", "## Findings");
    for (const f of r.findings) {
      lines.push(`- [${f.level}] ${f.message}`);
    }
  }
  return lines.join("\n");
}
