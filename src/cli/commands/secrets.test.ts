import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnvWithoutTvaultControls,
  getTvaultKeys,
  getTvaultSelectedEnv,
  resolveScopedSecrets,
  tvaultProcessEnv,
} from "./secrets";

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

  it("uses the configured identity and selected-key surface for a scoped child environment", async () => {
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "tvault 0.18.0", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ DATABASE_URL: "not-for-output" }),
        stderr: "",
      };
    });

    const result = await getTvaultSelectedEnv(
      { project: "sealed-project", identity: "ci-reader" },
      ["DATABASE_URL"],
    );

    expect(result.ok).toBe(true);
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "tvault",
      [
        "run",
        "--project",
        "sealed-project",
        "--identity",
        "ci-reader",
        "--only",
        "DATABASE_URL",
        "--",
        process.execPath,
        "-e",
        expect.any(String),
        JSON.stringify(["DATABASE_URL"]),
      ],
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
  });

  it("lists group metadata without calling tvault env plaintext export", async () => {
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "tvault 0.18.0", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          inherited: ["DATABASE_URL"],
          local: ["API_KEY"],
        }),
        stderr: "",
      };
    });

    const result = await getTvaultKeys({ group: "app", env: "preview" });

    expect(result).toEqual({ ok: true, keys: ["API_KEY", "DATABASE_URL"] });
    expect(execaMock).toHaveBeenNthCalledWith(
      2,
      "tvault",
      ["env", "inherited", "--group", "app", "--env", "preview", "--json"],
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
  });
});

describe("scoped TinyVault child environments", () => {
  it("removes vault client controls while preserving explicitly selected values", () => {
    expect(
      childEnvWithoutTvaultControls(
        {
          SAFE: "ok",
          CAIRN_TVAULT_ENV: "preview",
          TVAULT_TOKEN: "control-value",
          TVAULT_SELECTED: "explicit-secret",
        },
        ["TVAULT_SELECTED"],
      ),
    ).toEqual({ SAFE: "ok", TVAULT_SELECTED: "explicit-secret" });
  });

  it("preserves an explicitly selected TVAULT_ value while excluding client controls", async () => {
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "tvault 0.18.0", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ TVAULT_SELECTED: "explicit-secret" }),
        stderr: "",
      };
    });
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-scoped-tvault-"));
    const specPath = join(dir, "flow.yml");
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
secrets:
  provider: tvault
  keys: [TVAULT_SELECTED]
  tvault: { project: sealed-project }
`,
    );
    await writeFile(
      specPath,
      `version: 1
name: scoped_tvault
intent: preserve explicitly selected vault values
outcomes: []
steps: []
`,
    );

    const scoped = await resolveScopedSecrets(specPath, {
      baseEnv: {
        SAFE: "ok",
        TVAULT_TOKEN: "ambient-client-control",
      },
    });

    expect(scoped.env).toMatchObject({
      SAFE: "ok",
      TVAULT_SELECTED: "explicit-secret",
    });
    expect(scoped.childEnv).toMatchObject({
      SAFE: "ok",
      TVAULT_SELECTED: "explicit-secret",
    });
    expect(scoped.env.TVAULT_TOKEN).toBeUndefined();
    expect(scoped.childEnv.TVAULT_TOKEN).toBeUndefined();
    expect(scoped.selectedKeys).toEqual(["TVAULT_SELECTED"]);
  });

  it("selects placeholder keys referenced by imported actions", async () => {
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "tvault 0.18.0", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ IMPORTED_SECRET: "action-secret" }),
        stderr: "",
      };
    });
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-imported-tvault-"));
    const specPath = join(dir, "flow.yml");
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
environments:
  local: {}
secrets:
  provider: tvault
  tvault: { project: sealed-project }
`,
    );
    await writeFile(
      specPath,
      `version: 1
name: imported_secret
intent: imported action resolves its selected secret
imports: [action.yml]
outcomes: []
steps: []
`,
    );
    await writeFile(
      join(dir, "action.yml"),
      `version: 1
name: protected_action
steps:
  - open: "https://example.test/\${env.IMPORTED_SECRET}"
`,
    );

    const scoped = await resolveScopedSecrets(specPath);

    expect(scoped.env.IMPORTED_SECRET).toBe("action-secret");
    expect(scoped.selectedKeys).toEqual(["IMPORTED_SECRET"]);
    expect(execaMock).toHaveBeenLastCalledWith(
      "tvault",
      expect.arrayContaining(["--only", "IMPORTED_SECRET"]),
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
  });
});

describe("tvaultProcessEnv", () => {
  it("keeps an explicit passphrase file", () => {
    const env = tvaultProcessEnv({
      TVAULT_PASSPHRASE_FILE: "/custom/env",
    });
    expect(env.TVAULT_PASSPHRASE_FILE).toBe("/custom/env");
  });

  it("does not override an exported passphrase", () => {
    const env = tvaultProcessEnv({ TVAULT_PASSPHRASE: "from-shell" });
    expect(env.TVAULT_PASSPHRASE).toBe("from-shell");
  });
});
