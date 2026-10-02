import { SpecLintResultSchema } from "../../../core/authoring/authoring.v1";
import {
  lintExitCode,
  lintSpecs,
  type LintResult,
} from "../../../core/authoring/lint";
import { emit, resolveFormat } from "../../format";
import { expandSpecArgs } from "../../invocation/selection";
import { parseVarFlags } from "../../invocation/options";

/**
 * `cairn spec lint <spec...> [--env a,b] [--fix]` (A7). Exit 0 when no
 * finding is an error, 4 otherwise. Directories expand like `cairn run`
 * (actions/ and `_` drafts skipped); files named explicitly are always
 * linted, reusable actions included.
 */

export interface LintCommandOptions {
  env?: string;
  config?: string;
  var?: string[];
  fix?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/** `--env a,b` / `["a", "b,c"]` → ["a", "b", "c"]. */
export function splitEnvs(
  input: string | readonly string[] | undefined,
): string[] {
  const list = typeof input === "string" ? [input] : [...(input ?? [])];
  return [
    ...new Set(
      list
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export async function runSpecLint(
  specs: readonly string[],
  opts: {
    envs?: readonly string[];
    config?: string;
    var?: readonly string[];
    fix?: boolean;
    cwd?: string;
  },
): Promise<{ result: LintResult; exitCode: 0 | 4 }> {
  const cwd = opts.cwd ?? process.cwd();
  const vars = parseVarFlags(opts.var ? [...opts.var] : undefined);
  const paths = await expandSpecArgs([...specs], cwd);
  const result = await lintSpecs(paths, {
    ...(opts.envs && opts.envs.length > 0 ? { envs: opts.envs } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    ...(opts.fix ? { fix: true } : {}),
    cwd,
  });
  return {
    result: SpecLintResultSchema.parse(result) as LintResult,
    exitCode: lintExitCode(result),
  };
}

export async function lintCommand(
  specs: string[],
  opts: LintCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let outcome: Awaited<ReturnType<typeof runSpecLint>>;
  try {
    outcome = await runSpecLint(specs, {
      envs: splitEnvs(opts.env),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.var ? { var: opts.var } : {}),
      ...(opts.fix ? { fix: true } : {}),
    });
  } catch (e) {
    process.stderr.write(`cairn spec lint: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(emit(format, outcome.result, lintToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  process.exitCode = outcome.exitCode;
}

export function lintToMarkdown(r: LintResult): string {
  const lines = [
    `# Spec lint: ${r.summary.errors} error(s), ${r.summary.warnings} warning(s)${
      r.summary.fixed > 0 ? `, ${r.summary.fixed} fixed` : ""
    }`,
  ];
  for (const file of r.files) {
    lines.push(
      "",
      `## ${file.path} — ${file.status}${
        file.envs.length > 0 ? ` (env ${file.envs.join(", ")})` : ""
      }`,
    );
    if (file.findings.length === 0) lines.push("- no findings");
    for (const f of file.findings) {
      const at = f.line !== undefined ? `line ${f.line}: ` : "";
      const fix = f.fix
        ? ` — fix${
            f.fix.applied ? " (applied)" : f.fix.safe ? " (safe: --fix)" : ""
          }: ${f.fix.description}`
        : "";
      lines.push(`- ${f.severity} [${f.rule}] ${at}${f.message}${fix}`);
    }
  }
  return lines.join("\n");
}
