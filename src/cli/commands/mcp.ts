import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../../mcp/server";

/**
 * `cairn mcp` — start the Cairntrace MCP server on stdio.
 *
 * Meant to be spawned by an MCP client (Claude Code, Cursor, Windsurf, …).
 * Example client config:
 *
 *   {
 *     "mcpServers": {
 *       "cairntrace": {
 *         "command": "cairn",
 *         "args": ["mcp"]
 *       }
 *     }
 *   }
 *
 * The server reads JSON-RPC from stdin, writes responses to stdout. Anything
 * other than valid JSON-RPC on stdout will break the protocol — keep our own
 * logs on stderr only.
 */
export async function mcpCommand(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect awaits the protocol handshake; control returns once the
  // client disconnects. We don't print anything to stdout here.
}
