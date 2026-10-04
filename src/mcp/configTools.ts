import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildConfigVars } from "../core/config/varsReport";
import { ConfigVarsResultSchema } from "../core/schema/configVars.v1";

/** Rows `cairn_config_vars` returns unless `limit` says otherwise. */
const MCP_CONFIG_VARS_DEFAULT_LIMIT = 50;

/**
 * MCP `cairn_config_vars` (F7): the `cairn config vars --json` document.
 */
export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    "cairn_config_vars",
    {
      title: "Config vars: values per environment, definitions, uses",
      description:
        "Every config var after composition (top-level `vars:`, `include:` files, " +
        "`environments.<n>.extends`, vars built from other vars): kind " +
        "(string/number/boolean/list/object), the effective value in each environment " +
        "(secret-looking values masked), where it is defined (file:line), which " +
        "definition overrides it where, and what uses it (specs, actions, script " +
        "verifiers, fixtures, datasources, gates, env login, other vars). `unused: " +
        "true` lists dead vars only; `usedBy: <spec path or name>` lists only the " +
        "vars that spec reaches. Same document as `cairn config vars --json` " +
        "(urn:cairntrace.dev:config-vars:v1); the text content is a short summary. " +
        `At most ${MCP_CONFIG_VARS_DEFAULT_LIMIT} rows unless \`limit\` is set (totals keep the counts). ` +
        "Reads files only.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Explicit cairntrace.config.yml (default: discovered from the server cwd)",
          ),
        env: z.string().optional().describe("Only this environment"),
        unused: z.boolean().optional().describe("Only vars nothing uses"),
        usedBy: z
          .string()
          .optional()
          .describe("Only vars this spec (path or name) reaches"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Rows to return (default ${MCP_CONFIG_VARS_DEFAULT_LIMIT})`,
          ),
      },
    },
    async ({ config, env, unused, usedBy, limit }) => {
      const { result } = await buildConfigVars({
        ...(config ? { config } : {}),
        ...(env ? { env } : {}),
        ...(unused ? { unused: true } : {}),
        ...(usedBy ? { usedBy } : {}),
      });
      const cap = limit ?? MCP_CONFIG_VARS_DEFAULT_LIMIT;
      const shown = { ...result, vars: result.vars.slice(0, cap) };
      const text = result.ok
        ? [
            `${result.vars.length} of ${result.totals.vars} vars across ${result.environments.join(", ") || "no environments"}` +
              ` (unused ${result.totals.unused}, same everywhere ${result.totals.sameInAllEnvironments}, differing ${result.totals.differing})` +
              (shown.vars.length < result.vars.length
                ? `; first ${shown.vars.length} rows shown`
                : ""),
            ...shown.vars.map(
              (row) =>
                `- ${row.name} (${row.kind})${
                  row.unused ? " unused" : ""
                }: ${Object.entries(row.values)
                  .map(
                    ([envName, v]) => `${envName}=${JSON.stringify(v.value)}`,
                  )
                  .join(" ")
                  .slice(0, 200)}`,
            ),
          ].join("\n")
        : `error: ${(result.errors ?? []).join("; ")}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: ConfigVarsResultSchema.parse(
          shown,
        ) as unknown as Record<string, unknown>,
        isError: !result.ok,
      };
    },
  );
}
