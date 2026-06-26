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

  it("surfaces the environment viewport from config", async () => {
    const projectRoot = join(dir, "viewport-project");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
    viewport: { width: 1280, height: 800 }
`,
    );
    const specPath = join(flowsDir, "viewport.yml");
    await writeFile(
      specPath,
      `version: 1
name: viewport_spec
intent: env viewport flows into runtime context
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: /
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.viewport).toEqual({ width: 1280, height: 800 });
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

  it("merges vars as config env < spec vars < CLI vars", async () => {
    const projectRoot = join(dir, "spec-vars-project");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      scenario: from-config
      untouched: keep-me
      cliOnly: from-config
`,
    );
    const specPath = join(flowsDir, "spec-vars.yml");
    await writeFile(
      specPath,
      `version: 1
name: spec_vars_runtime
intent: spec vars override config vars
vars:
  scenario: from-spec
  specOnly: yes
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      vars: { cliOnly: "from-cli" },
    });

    expect(ctx.vars).toEqual({
      scenario: "from-spec",
      untouched: "keep-me",
      cliOnly: "from-cli",
      specOnly: "yes",
    });
  });

  it("disables services when env says services: false", async () => {
    const projectRoot = join(dir, "no-services");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
services:
  docker:
    command: docker compose up -d
  seed:
    command: yarn seed
    ttlSeconds: 3600
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: https://dev.example.com
    services: false
`,
    );
    const specPath = join(flowsDir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: no_services
intent: dev env disables services
outcomes: []
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "dev",
    });
    expect(ctx.services).toBeUndefined();
  });

  it("keeps top-level services when env has no services key", async () => {
    const projectRoot = join(dir, "keep-services");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
services:
  docker:
    command: docker compose up -d
  seed:
    command: yarn seed
    ttlSeconds: 3600
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: https://dev.example.com
`,
    );
    const specPath = join(flowsDir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: keep_services
intent: dev env inherits top-level services
outcomes: []
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "dev",
    });
    expect(ctx.services).toBeDefined();
    expect(ctx.services?.docker?.command).toBe("docker compose up -d");
  });

  it("merges env services override over top-level", async () => {
    const projectRoot = join(dir, "merge-services");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
services:
  docker:
    command: docker compose up -d
  seed:
    command: yarn seed
    ttlSeconds: 3600
  tmux:
    session: graphite
    windows:
      - name: web
        cwd: web-app
        command: yarn serve
        readyOn: { url: http://localhost:8080 }
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: https://dev.example.com
    services:
      seed:
        command: echo skip-seed
        ttlSeconds: 0
`,
    );
    const specPath = join(flowsDir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: merge_services
intent: dev env overrides seed only
outcomes: []
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "dev",
    });
    expect(ctx.services).toBeDefined();
    expect(ctx.services?.docker?.command).toBe("docker compose up -d");
    expect(ctx.services?.seed?.command).toBe("echo skip-seed");
    expect(ctx.services?.seed?.ttlSeconds).toBe(0);
    expect(ctx.services?.tmux?.session).toBe("graphite");
  });

  it("applies env secrets override over top-level", async () => {
    const projectRoot = join(dir, "env-secrets");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
secrets:
  provider: tvault
  tvault:
    project: local-project
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: https://dev.example.com
    secrets:
      provider: tvault
      tvault:
        project: dev-project
`,
    );
    const specPath = join(flowsDir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: env_secrets
intent: dev env overrides secrets
outcomes: []
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "dev",
    });
    expect(ctx.secrets?.tvault?.project).toBe("dev-project");
  });

  it("inherits top-level secrets when env has no secrets key", async () => {
    const projectRoot = join(dir, "inherit-secrets");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
secrets:
  provider: tvault
  tvault:
    group: myapp
    env: local
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: https://dev.example.com
`,
    );
    const specPath = join(flowsDir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: inherit_secrets
intent: dev inherits top-level secrets
outcomes: []
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "dev",
    });
    expect(ctx.secrets?.tvault?.group).toBe("myapp");
    expect(ctx.secrets?.tvault?.env).toBe("local");
  });
});
