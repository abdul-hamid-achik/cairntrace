import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  RetentionConfigSchema,
  StashConfigSchema,
} from "../../../core/schema/config.v1";
import { SpecSchema } from "../../../core/schema/spec.v1";
import { validateConfigFile } from "./validate";

function configFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-config-stash-"));
  const path = join(dir, "cairntrace.config.yml");
  writeFileSync(path, body);
  return path;
}

describe("stash / retention / evidence config", () => {
  it("accepts the evidence gate, TTLs, labelsAsTags and meta", () => {
    const stash = StashConfigSchema.parse({
      enabled: true,
      autoStash: "always",
      include: ["text", "screenshots", "traces"],
      unsafeIncludeRawTraces: false,
      ttl: "30d",
      passTtl: "7d",
      failTtl: "2026-12-31",
      labelsAsTags: true,
      meta: false,
    });
    expect(stash.autoStash).toBe("always");
    // Back-compat: an old block parses unchanged (no new defaults appear).
    expect(StashConfigSchema.parse({ enabled: true })).toEqual({
      enabled: true,
      autoStash: "never",
    });
    expect(
      RetentionConfigSchema.parse({
        publish: { enabled: true, include: ["text"] },
      }).publish,
    ).toEqual({ enabled: true, retentionDays: 7, include: ["text"] });
  });

  it("rejects an include without text, duplicates, unknown categories and bad TTLs", () => {
    expect(
      StashConfigSchema.safeParse({ include: ["screenshots"] }).success,
    ).toBe(false);
    expect(
      StashConfigSchema.safeParse({ include: ["text", "text"] }).success,
    ).toBe(false);
    expect(
      StashConfigSchema.safeParse({ include: ["text", "har"] }).success,
    ).toBe(false);
    expect(StashConfigSchema.safeParse({ ttl: "forever" }).success).toBe(false);
  });

  it("accepts spec stash.tags and capture.traceMaxBytes", () => {
    const spec = SpecSchema.parse({
      version: 1,
      name: "tagged",
      intent: "x",
      outcomes: [
        {
          id: "o",
          description: "d",
          verify: { console: { errorsMax: 0 } },
        },
      ],
      artifacts: { capture: { traceMaxBytes: 1024 } },
      stash: { tags: ["payments"] },
    });
    expect(spec.stash?.tags).toEqual(["payments"]);
    expect(spec.artifacts?.capture?.traceMaxBytes).toBe(1024);
  });

  it("warns that services.stash is deprecated without failing validation", async () => {
    const path = configFile(`version: 1
environments:
  local: {}
  dev:
    services:
      stash: { enabled: true, autoStash: on-failure }
services:
  stash: { enabled: true, autoStash: always, ttl: 3d }
`);
    const { result, exitCode } = await validateConfigFile(path);
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringMatching(/^services\.stash is deprecated/),
      expect.stringMatching(
        /^environments\.dev\.services\.stash is deprecated/,
      ),
    ]);
    expect(ConfigSchema.parse(result.config).services?.stash?.ttl).toBe("3d");
  });

  it("has no warnings for a config without services.stash", async () => {
    const { result } = await validateConfigFile(
      configFile("version: 1\nenvironments:\n  local: {}\n"),
    );
    expect(result.warnings).toBeUndefined();
  });
});
