import {
  buildCatalog,
  CatalogConfigError,
} from "../../core/catalog/buildCatalog";
import {
  SuitesListResultSchema,
  type SuitesListResult,
} from "../../core/catalog/catalog.v1";
import { emit, resolveFormat } from "../format";

export interface SuitesListOptions {
  config?: string;
  env?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/** Markdown of `cairn suites list`. */
export function renderSuitesMarkdown(result: SuitesListResult): string {
  if (result.suites.length === 0) {
    return `# Suites\n\nThe config defines no \`suites:\`.`;
  }
  const lines = [`# Suites${result.project ? `: ${result.project}` : ""}`, ""];
  for (const suite of result.suites) {
    const knobs = [
      suite.parallel !== undefined ? `parallel ${suite.parallel}` : "",
      suite.bail ? "bail" : "",
      suite.tags ? `tags ${suite.tags.join("+")}` : "",
      suite.requires?.env ? `env ${suite.requires.env.join("|")}` : "",
    ].filter(Boolean);
    lines.push(
      `## ${suite.name}${knobs.length > 0 ? ` (${knobs.join(", ")})` : ""}`,
    );
    if (suite.description) lines.push("", suite.description);
    for (const env of suite.envs) {
      lines.push("");
      if (env.problem) {
        lines.push(`- **${env.env}**: ${env.problem}`);
        continue;
      }
      const extras = [
        env.bail !== undefined ? (env.bail ? "bail" : "no bail") : "",
        env.processEnv ? `processEnv ${env.processEnv.join(", ")}` : "",
        env.labels ? `labels ${env.labels.join(", ")}` : "",
        env.seedSkip ? `skips ${env.seedSkip.length} seed postCommand(s)` : "",
      ].filter(Boolean);
      lines.push(
        `- **${env.env}**: ${env.specs.length} spec(s)${
          env.before + env.after > 0
            ? `, hooks ${env.before} before / ${env.after} after`
            : ""
        }${extras.length > 0 ? `; ${extras.join("; ")}` : ""}`,
      );
      for (const spec of env.specs) lines.push(`  - ${spec}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * `cairn suites list [--config] [--env] [--json]`: the config's `suites:`
 * with the specs each resolves to per environment (and why one does not),
 * as `cairn run --suite <name> --env <env>` would run them. Reads files
 * only. Exit 0, 4 on a config error.
 */
export async function suitesListCommand(
  opts: SuitesListOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let catalog;
  try {
    catalog = await buildCatalog({
      kinds: ["suites"],
      ...(opts.config ? { config: opts.config } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
  } catch (e) {
    process.stderr.write(`cairn suites list: ${(e as Error).message}\n`);
    process.exitCode = e instanceof CatalogConfigError ? 4 : 2;
    return;
  }
  const result = SuitesListResultSchema.parse({
    $schema: "urn:cairntrace.dev:suites:v1",
    version: "1",
    ...(catalog.project ? { project: catalog.project } : {}),
    root: catalog.root,
    ...(catalog.configPath ? { configPath: catalog.configPath } : {}),
    ...(catalog.env ? { env: catalog.env } : {}),
    suites: catalog.suites ?? [],
    warnings: catalog.warnings,
  });
  process.stdout.write(emit(format, result, renderSuitesMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}
