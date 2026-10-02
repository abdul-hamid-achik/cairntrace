import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSnapshotTarget, resolveSnapshotUrl } from "./snapshot";

describe("resolveSnapshotUrl", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cairntrace-snapshot-"));
  });

  it("passes absolute URLs through", async () => {
    await expect(resolveSnapshotUrl("https://example.com/x")).resolves.toBe(
      "https://example.com/x",
    );
  });

  it("resolves relative URLs against the selected config baseUrl", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      [
        "version: 1",
        "defaultEnvironment: local",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:8787",
        "  preview:",
        "    baseUrl: https://preview.example.com/app",
      ].join("\n"),
    );

    await expect(
      resolveSnapshotUrl("/dashboard", { config: configPath }),
    ).resolves.toBe("http://localhost:8787/dashboard");
    await expect(
      resolveSnapshotUrl("settings", { config: configPath, env: "preview" }),
    ).resolves.toBe("https://preview.example.com/app/settings");
  });

  it("fails clearly when a relative URL has no config baseUrl", async () => {
    await expect(resolveSnapshotUrl("/dashboard")).rejects.toThrow(
      /requires environments\.local\.baseUrl/,
    );
  });
});

describe("resolveSnapshotTarget", () => {
  it("carries the config browser.testIdAttribute and --var values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-snapshot-target-"));
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      [
        "version: 1",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:8787",
        "browser:",
        "  testIdAttribute: data-qa",
      ].join("\n"),
    );
    const target = await resolveSnapshotTarget("/t/${vars.id}", {
      config: configPath,
      var: ["id=7"],
    });
    expect(target.url).toBe("http://localhost:8787/t/7");
    expect(target.testIdAttribute).toBe("data-qa");
  });
});
