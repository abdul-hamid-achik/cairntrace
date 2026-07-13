import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTvaultKeys } from "./secrets";

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: execaMock,
}));

describe("getTvaultKeys", () => {
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

  it("lists project key names without requiring the vault passphrase", async () => {
    const result = await getTvaultKeys({ project: "linkglow" });

    expect(result).toEqual({
      ok: true,
      keys: ["DATABASE_URL", "STRIPE_SECRET_KEY"],
    });
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "tvault",
      ["list", "--project", "linkglow", "--json", "--names-only"],
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
  });
});
