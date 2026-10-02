import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildCatalog, CatalogConfigError } from "../core/catalog/buildCatalog";
import { CatalogKindSchema } from "../core/catalog/catalog.v1";
import { renderCatalogSummary } from "../core/catalog/markdown";

/**
 * Rows per kind `cairn_catalog` returns when the call gives neither `query`
 * nor `limit`, so one call cannot flood the agent's context on a large
 * project (`totals` keeps the full counts).
 */
const MCP_CATALOG_DEFAULT_LIMIT = 20;

/**
 * MCP `cairn_catalog` (same document as `cairn catalog --json`) and the
 * `cairn://catalog` resource (the whole catalog of the project the server
 * was started in).
 */
export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "cairn_catalog",
    {
      title: "Project catalog",
      description:
        "What the project already has, so you reuse it instead of re-recording literals: " +
        "reusable actions (description, inputs with defaults, used-by, last green run), " +
        "config vars per environment (masked when secret-like, with their YAML comment), " +
        "script verifiers with their fixtures contract (unknown keys flagged), environments " +
        "with policy/services/secrets provider, flows with their last run, and checkpoints " +
        "with scope and health. Before authoring a spec, call it with `query` set to the " +
        "task's keywords (e.g. 'log in edit website field'): rows are ranked (name > " +
        "description > comments), explained, and capped at 10 per kind. Without `query` " +
        `or \`limit\`, at most ${MCP_CATALOG_DEFAULT_LIMIT} rows per kind are returned; ` +
        "`totals` has the full counts, and `kind`/`limit` narrow or widen. The text " +
        "content is a short summary; the rows are in structuredContent (the " +
        "`cairn catalog --json` document, urn:cairntrace.dev:catalog:v1). Reads files only.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Explicit cairntrace.config.yml (default: discovered from the server cwd)",
          ),
        env: z
          .string()
          .optional()
          .describe(
            "Environment for vars, last runs and checkpoint origin checks",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Keywords, e.g. 'edit website field'; rows that match, best first",
          ),
        kind: z
          .union([CatalogKindSchema, z.array(CatalogKindSchema)])
          .optional()
          .describe("Limit to these kinds (default: all)"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Rows per kind (default 10 with a query, otherwise ${MCP_CATALOG_DEFAULT_LIMIT})`,
          ),
        artifactRoot: z
          .string()
          .optional()
          .describe("Override the artifact root scanned for last runs"),
      },
    },
    async ({ config, env, query, kind, limit, artifactRoot }) => {
      try {
        const catalog = await buildCatalog({
          ...(config ? { config } : {}),
          ...(env ? { env } : {}),
          ...(query?.trim() ? { query: query.trim() } : {}),
          ...(kind ? { kinds: Array.isArray(kind) ? kind : [kind] } : {}),
          ...(limit !== undefined ? { limit } : {}),
          unqueriedLimit: MCP_CATALOG_DEFAULT_LIMIT,
          ...(artifactRoot ? { artifactRoot } : {}),
        });
        return {
          content: [{ type: "text", text: renderCatalogSummary(catalog) }],
          structuredContent: catalog as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const exitCode = e instanceof CatalogConfigError ? 4 : 2;
        return {
          content: [
            { type: "text", text: `catalog failed: ${(e as Error).message}` },
          ],
          structuredContent: { exitCode, error: (e as Error).message },
          isError: true,
        };
      }
    },
  );

  server.registerResource(
    "catalog",
    "cairn://catalog",
    {
      title: "Cairntrace project catalog",
      description:
        "The catalog of the project the server runs in (cairn catalog --json, compact): actions, vars, verifiers, envs, flows, checkpoints. Scoped to the config defaultEnvironment when one is set; use the cairn_catalog tool with env/query/kind to narrow or switch.",
      mimeType: "application/json",
    },
    async (uri) => {
      const catalog = await buildCatalog({ defaultEnv: true });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(catalog),
          },
        ],
      };
    },
  );
}
