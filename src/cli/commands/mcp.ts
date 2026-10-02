import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "../../mcp/server";

export interface McpCommandOptions {
  /**
   * `--allow-hooks`: accept `cairn_run` before/after hooks (arbitrary shell).
   * `CAIRN_MCP_ALLOW_HOOKS=1` enables it too.
   */
  allowHooks?: boolean;
  /**
   * `--allow-services`: let MCP tools start config services and run their
   * teardown. `CAIRN_MCP_ALLOW_SERVICES=1` enables it too.
   */
  allowServices?: boolean;
}

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
export async function mcpCommand(opts: McpCommandOptions = {}): Promise<void> {
  const server = buildMcpServer({
    ...(opts.allowHooks ? { allowHooks: true } : {}),
    ...(opts.allowServices ? { allowServices: true } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  closeOnStdinEnd(process.stdin, () => server.close());
  // server.connect awaits the protocol handshake; control returns once the
  // client disconnects. We don't print anything to stdout here.
}

/**
 * The SDK's stdio transport never notices the client closing stdin, so the
 * server's onclose (which cancels background cairn_run invocations, closes
 * discovery sessions and tears their services down) would never run.
 * Close the server once stdin ends; the process exits by itself once that
 * teardown settled and nothing else holds the event loop.
 */
function closeOnStdinEnd(
  stdin: Pick<NodeJS.ReadableStream, "once">,
  close: () => Promise<void>,
): void {
  let closing = false;
  const onEnd = (): void => {
    if (closing) return;
    closing = true;
    void close().catch(() => undefined);
  };
  stdin.once("end", onEnd);
  stdin.once("close", onEnd);
}
