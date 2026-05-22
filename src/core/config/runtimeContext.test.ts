import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveSpecRuntimeContext } from "./runtimeContext";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-runtime-context-"));
});

describe("resolveSpecRuntimeContext", () => {
  it("peeks environment without requiring full spec variable substitution", async () => {
    const projectRoot = join(dir, "project");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
    vars:
      connectionPath: /connection/local
  staging:
    baseUrl: https://staging.example.com
    vars:
      connectionPath: /connection/staging
`,
    );
    const specPath = join(flowsDir, "table_import.yml");
    await writeFile(
      specPath,
      `version: 1
name: table_import
intent: resolves config before parsing vars
environment: staging
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.envName).toBe("staging");
    expect(ctx.baseUrl).toBe("https://staging.example.com");
    expect(ctx.vars).toEqual({ connectionPath: "/connection/staging" });
  });

  it("lets CLI vars override environment config vars", async () => {
    const projectRoot = join(dir, "override-project");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      connectionPath: /from-config
`,
    );
    const specPath = join(flowsDir, "override.yml");
    await writeFile(
      specPath,
      `version: 1
name: override_vars
intent: cli vars win
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      vars: { connectionPath: "/from-cli" },
    });
    expect(ctx.envName).toBe("local");
    expect(ctx.vars.connectionPath).toBe("/from-cli");
  });
});
