import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  resolveProjectRuntimeContext,
  resolveSpecRuntimeContext,
  UnknownEnvironmentError,
} from "./runtimeContext";

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

  it("resolves ${env.X:-default} in a spec's own vars like a config var", async () => {
    const flowsDir = join(dir, "spec-env-vars");
    await mkdir(flowsDir, { recursive: true });
    const specPath = join(flowsDir, "login.yml");
    await writeFile(
      specPath,
      `version: 1
name: login
intent: a spec var reads the environment
vars:
  password: "\${env.CTX_TEST_DEMO_PASSWORD:-fallback-pass}"
  unset: "\${env.CTX_TEST_UNSET_NO_DEFAULT}"
  plain: keep-\${run.token}
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: /
`,
    );
    const withDefault = await resolveSpecRuntimeContext(specPath, { env: {} });
    expect(withDefault.vars).toEqual({
      password: "fallback-pass",
      unset: "",
      plain: "keep-${run.token}",
    });
    const fromEnv = await resolveSpecRuntimeContext(specPath, {
      env: { CTX_TEST_DEMO_PASSWORD: "from-env" },
      // Exporters keep an unset env late-bound.
      envRef: (name) => `REF(${name})`,
    });
    expect(fromEnv.vars).toMatchObject({
      password: "from-env",
      unset: "REF(CTX_TEST_UNSET_NO_DEFAULT)",
    });
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

  it("surfaces the environment waitScale from config", async () => {
    const projectRoot = join(dir, "wait-scale-project");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: remote
environments:
  remote:
    baseUrl: https://remote.example.com
    waitScale: 3
`,
    );
    const specPath = join(flowsDir, "remote.yml");
    await writeFile(
      specPath,
      `version: 1
name: remote
intent: widen remote waits
outcomes:
  - id: clean
    description: console stays clean
    verify:
      console: { errorsMax: 0 }
steps:
  - open: /
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.waitScale).toBe(3);
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

  it("removes inherited tmux when an environment sets tmux: false", async () => {
    const projectRoot = join(dir, "remote-services-without-local-tmux");
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
    session: sample-app
    windows:
      - name: web
        cwd: web-app
        command: yarn serve
environments:
  local:
    baseUrl: http://localhost:8080
  remote:
    baseUrl: http://localhost:8081
    services:
      tmux: false
      docker:
        command: bun provision-remote
`,
    );
    const specPath = join(flowsDir, "spec.yml");
    await writeFile(
      specPath,
      `version: 1
name: remote_services_without_local_tmux
intent: remote apps keep provisioning and seed but disable inherited tmux
outcomes: []
steps: []
`,
    );

    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "remote",
    });
    expect(ctx.services?.docker?.command).toBe("bun provision-remote");
    expect(ctx.services?.seed?.command).toBe("yarn seed");
    expect(ctx.services?.tmux).toBeUndefined();
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
    session: sample-app
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
    expect(ctx.services?.tmux?.session).toBe("sample-app");
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

const MINIMAL_SPEC = `version: 1
name: env_check
intent: environment selection rules
outcomes: []
steps: []
`;

async function projectWith(
  name: string,
  config: string | undefined,
  spec: string = MINIMAL_SPEC,
): Promise<{ root: string; specPath: string }> {
  const root = join(dir, name);
  await mkdir(join(root, "flows"), { recursive: true });
  if (config !== undefined) {
    await writeFile(join(root, "cairntrace.config.yml"), config);
  }
  const specPath = join(root, "flows", "spec.yml");
  await writeFile(specPath, spec);
  return { root, specPath };
}

const TWO_ENVS = `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
  staging:
    baseUrl: https://staging.example.com
`;

describe("environment selection", () => {
  it("fails with exit 4 when --env names an environment the config lacks", async () => {
    const { specPath, root } = await projectWith("unknown-override", TWO_ENVS);
    const err = await resolveSpecRuntimeContext(specPath, {
      envOverride: "stagin",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownEnvironmentError);
    const typed = err as UnknownEnvironmentError;
    expect(typed.exitCode).toBe(4);
    expect(typed.source).toBe("override");
    expect(typed.knownEnvironments).toEqual(["local", "staging"]);
    expect(typed.message).toContain('unknown environment "stagin"');
    expect(typed.message).toContain("local, staging");
    expect(typed.message).toContain(join(root, "cairntrace.config.yml"));
  });

  it("warns (but still runs) when the spec's environment: is not defined in the config", async () => {
    const { specPath } = await projectWith(
      "unknown-spec-env",
      TWO_ENVS,
      MINIMAL_SPEC.replace("outcomes: []", "environment: qa\noutcomes: []"),
    );
    const seen: string[] = [];
    const ctx = await resolveSpecRuntimeContext(specPath, {
      onWarning: (m) => seen.push(m),
    });
    expect(ctx.envName).toBe("qa");
    expect(ctx.envSource).toBe("spec");
    expect(ctx.baseUrl).toBeUndefined();
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toContain(`the spec's environment "qa"`);
    expect(ctx.warnings[0]).toContain("known: local, staging");
    expect(seen).toEqual(ctx.warnings);
  });

  it("resolves a batch the same in any order when one spec's environment: is stale", async () => {
    // Regression: a throwing spec-level check made `cairn run b.yml a.yml`
    // and `cairn run a.yml b.yml` disagree (the invocation scope is resolved
    // from the FIRST spec, so a stale default there aborted the whole batch).
    const { root, specPath: good } = await projectWith("batch-order", TWO_ENVS);
    const stale = join(root, "flows", "stale.yml");
    await writeFile(
      stale,
      MINIMAL_SPEC.replace("outcomes: []", "environment: qa\noutcomes: []"),
    );
    for (const order of [
      [good, stale],
      [stale, good],
    ]) {
      const resolved = await Promise.all(
        order.map((p) => resolveSpecRuntimeContext(p)),
      );
      expect(resolved.map((c) => c.envName)).toEqual(
        order.map((p) => (p === stale ? "qa" : "local")),
      );
    }
  });

  it("accepts the scaffolded environment: local against a config with no environments", async () => {
    // Every example spec says `environment: local`; a config that defines no
    // environments (`environments: {}`) must keep running them silently.
    const { specPath } = await projectWith(
      "no-environments-spec-local",
      "version: 1\nenvironments: {}\nbrowser: { testIdAttribute: data-qa }\n",
      MINIMAL_SPEC.replace(
        "outcomes: []",
        "environment: local\nopen: https://example.test/\noutcomes: []",
      ),
    );
    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.envName).toBe("local");
    expect(ctx.envSource).toBe("spec");
    expect(ctx.warnings).toEqual([]);
    expect(ctx.browser?.testIdAttribute).toBe("data-qa");
  });

  it("warns for a non-local spec environment against a config with no environments", async () => {
    const { specPath } = await projectWith(
      "no-environments-spec-staging",
      "version: 1\nenvironments: {}\n",
      MINIMAL_SPEC.replace(
        "outcomes: []",
        "environment: staging\noutcomes: []",
      ),
    );
    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.envName).toBe("staging");
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toContain("known: none");
  });

  it("accepts --env local against a config with no environments, like the spec default", async () => {
    // CI wrappers pass --env local to every project, including configs that
    // define no environments; 2.15.0 ran those, and so does the spec default.
    const { specPath } = await projectWith(
      "no-environments-override-local",
      "version: 1\nenvironments: {}\n",
    );
    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "local",
    });
    expect(ctx.envName).toBe("local");
    expect(ctx.envSource).toBe("override");
    expect(ctx.warnings).toEqual([]);
  });

  it("still fails when --env names another environment a no-environments config lacks", async () => {
    const { specPath } = await projectWith(
      "no-environments-override",
      "version: 1\nenvironments: {}\n",
    );
    await expect(
      resolveSpecRuntimeContext(specPath, { envOverride: "staging" }),
    ).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });

  it("lets an explicit --env override a spec environment the config lacks", async () => {
    const { specPath } = await projectWith(
      "override-wins",
      TWO_ENVS,
      MINIMAL_SPEC.replace("outcomes: []", "environment: qa\noutcomes: []"),
    );
    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "staging",
    });
    expect(ctx.envName).toBe("staging");
    expect(ctx.envSource).toBe("override");
    expect(ctx.baseUrl).toBe("https://staging.example.com");
  });

  it("does not validate environment names when there is no config", async () => {
    const { specPath, root } = await projectWith("no-config", undefined);
    const ctx = await resolveSpecRuntimeContext(specPath, {
      envOverride: "anything",
    });
    expect(ctx.envName).toBe("anything");
    expect(ctx.baseUrl).toBeUndefined();
    expect(ctx.configPath).toBeUndefined();
    expect(ctx.warnings).toEqual([]);
    // ${config.dir} falls back to the cwd without a config.
    const withCwd = await resolveSpecRuntimeContext(specPath, { cwd: root });
    expect(withCwd.configDir).toBe(root);
  });

  it("warns (but still runs) when the implicit local fallback is missing", async () => {
    const { specPath } = await projectWith(
      "implicit-local-missing",
      `version: 1
environments:
  staging:
    baseUrl: https://staging.example.com
`,
    );
    const seen: string[] = [];
    const ctx = await resolveSpecRuntimeContext(specPath, {
      onWarning: (m) => seen.push(m),
    });
    expect(ctx.envName).toBe("local");
    expect(ctx.envSource).toBe("fallback");
    expect(ctx.baseUrl).toBeUndefined();
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toContain('no "local" environment');
    expect(ctx.warnings[0]).toContain("known: staging");
    expect(seen).toEqual(ctx.warnings);
  });

  it("warns when defaultEnvironment points at an undefined environment", async () => {
    const { specPath } = await projectWith(
      "bad-default",
      `version: 1
defaultEnvironment: prod
environments:
  local:
    baseUrl: http://localhost:8080
`,
    );
    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.envName).toBe("prod");
    expect(ctx.envSource).toBe("config-default");
    expect(ctx.warnings[0]).toContain('defaultEnvironment "prod"');
  });

  it("stays silent for a config that defines no environments at all", async () => {
    const { specPath } = await projectWith(
      "no-environments",
      "version: 1\nenvironments: {}\n",
    );
    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.envName).toBe("local");
    expect(ctx.warnings).toEqual([]);
  });

  it("exposes configDir and the browser block", async () => {
    const { specPath, root } = await projectWith(
      "config-dir",
      `${TWO_ENVS}browser:
  testIdAttribute: data-qa
`,
    );
    const ctx = await resolveSpecRuntimeContext(specPath);
    expect(ctx.configDir).toBe(root);
    expect(ctx.browser?.testIdAttribute).toBe("data-qa");
    expect(ctx.envSource).toBe("fallback");
    expect(ctx.warnings).toEqual([]);
  });
});

describe("resolveProjectRuntimeContext", () => {
  it("discovers the config upward from cwd and applies the same env rules", async () => {
    const { root } = await projectWith(
      "project-ctx",
      `${TWO_ENVS}browser:
  testIdAttribute: data-qa
`,
    );
    const nested = join(root, "flows");
    const ctx = await resolveProjectRuntimeContext({
      cwd: nested,
      envOverride: "staging",
      vars: { extra: "1" },
    });
    expect(ctx.configPath).toBe(join(root, "cairntrace.config.yml"));
    expect(ctx.configDir).toBe(root);
    expect(ctx.baseUrl).toBe("https://staging.example.com");
    expect(ctx.browser?.testIdAttribute).toBe("data-qa");
    expect(ctx.vars).toEqual({ extra: "1" });

    await expect(
      resolveProjectRuntimeContext({ cwd: nested, envOverride: "nope" }),
    ).rejects.toBeInstanceOf(UnknownEnvironmentError);
  });
});
