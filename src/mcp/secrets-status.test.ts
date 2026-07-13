import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "./server";

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: execaMock,
}));

async function connectInMemory(): Promise<Client> {
  const server = buildMcpServer();
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const connected = new Client(
    { name: "secrets-status-test", version: "0" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverSide), connected.connect(client)]);
  return connected;
}

describe("cairn_secrets_status", () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "tvault 0.17.0", stderr: "" };
      }
      if (args.includes("--names-only")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify(["DATABASE_URL", "STRIPE_SECRET_KEY"]),
          stderr: "",
        };
      }
      return {
        exitCode: 3,
        stdout: JSON.stringify({ error: "vault_locked", locked: true }),
        stderr: "",
      };
    });
  });

  it("returns project key names through the lock-free TinyVault path", async () => {
    const client = await connectInMemory();
    const result = await client.callTool({
      name: "cairn_secrets_status",
      arguments: { project: "linkglow" },
    });

    expect(result.structuredContent).toMatchObject({
      provider: "tvault",
      tvaultInstalled: true,
      target: "linkglow",
      keys: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
    });
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "tvault",
      ["list", "--project", "linkglow", "--json", "--names-only"],
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
    await client.close();
  });
});
