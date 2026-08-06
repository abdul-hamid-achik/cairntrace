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
