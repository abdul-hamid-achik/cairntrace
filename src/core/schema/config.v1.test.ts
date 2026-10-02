import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./config.v1";

describe("diagnostics monitor targets", () => {
  it("accepts an exact runtime/codebase/entrypoint selector", () => {
    const config = ConfigSchema.parse({
      version: 1,
      environments: { local: {} },
      diagnostics: {
        monitor: {
          binary: "/opt/monitor/bin/monitor",
          targets: {
            worker: {
              runtime: "node",
              codebaseRoot: "/workspace/worker",
              mainScriptSuffix: "dist/server.js",
            },
          },
        },
      },
    });

    expect(config.diagnostics?.monitor?.binary).toBe(
      "/opt/monitor/bin/monitor",
    );
    expect(config.diagnostics?.monitor?.targets.worker).toEqual({
      runtime: "node",
      codebaseRoot: "/workspace/worker",
      mainScriptSuffix: "dist/server.js",
    });
  });
});

describe("discovery block", () => {
  it("accepts sessionTtlMs and backend, and rejects unknown keys", () => {
    const config = ConfigSchema.parse({
      version: 1,
      environments: { local: {} },
      discovery: { sessionTtlMs: 600000, backend: "playwright" },
    });
    expect(config.discovery).toEqual({
      sessionTtlMs: 600000,
      backend: "playwright",
    });
    expect(
      ConfigSchema.safeParse({
        version: 1,
        environments: { local: {} },
        discovery: { ttl: 5 },
      }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        version: 1,
        environments: { local: {} },
        discovery: { sessionTtlMs: 0 },
      }).success,
    ).toBe(false);
  });
});
