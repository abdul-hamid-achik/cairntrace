import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import {
  ConfigSchema,
  DockerConfigSchema,
  SeedConfigSchema,
  RetentionConfigSchema,
  TmuxConfigSchema,
  TmuxWindowSchema,
  ServicesConfigSchema,
  ServicesArtifactsConfigSchema,
  resolveServicesArtifactsConfig,
  SecretsConfigSchema,
} from "../../../core/schema/config.v1";
import {
  validateConfigFile,
  configValidateCommand,
  type ConfigValidateResult,
} from "./validate";
import { writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpBase = join(tmpdir(), "cairn-config-validate-tests");

function makeTmpDir(): string {
  const dir = join(
    tmpBase,
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(content: string, dir: string): string {
  const path = join(dir, "cairntrace.config.yml");
  writeFileSync(path, content);
  return path;
}

async function runValidate(
  configPath?: string,
): Promise<{ result: ConfigValidateResult; exitCode: number }> {
  return validateConfigFile(configPath);
}

function validBaseConfig(): Record<string, unknown> {
  return {
    version: 1,
    environments: { local: { baseUrl: "http://localhost:8080" } },
  };
}

describe("config validate command", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates a minimal valid config", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path);
    expect(result.keys).toContain("version");
    expect(result.keys).toContain("environments");
  });

  it("validates a config with full services block", async () => {
    const path = writeConfig(
      `version: 1
project: sample-app
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  required: [MONGO_SOURCE_PASSWORD, ES_SOURCE_PASSWORD]
  tvault:
    project: sample-app
services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
  seed:
    command: "yarn demo-import"
    ttlSeconds: 3600
    freshnessCheck: "mongosh --quiet --eval 'db.count()'"
  tmux:
    session: sample-app
    reuseExisting: true
    options:
      - { key: mouse, value: "on" }
      - { key: history-limit, value: "50000" }
    env:
      NODE_ENV: development
    windows:
      - name: web-app
        cwd: web-app
        command: "yarn serve"
        readyOn:
          url: http://localhost:8080
      - name: web-api
        cwd: web-api
        command: "yarn dev-watch"
        env:
          PORT: "3001"
        readyOn:
          text: "listening on"
  teardown:
    - "tmux kill-session -t sample-app"
    - "docker compose down"
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.services).toBeDefined();
    expect(result.services!.docker).toBe(true);
    expect(result.services!.seed).toBe(true);
    expect(result.services!.tmux).toBe(true);
    expect(result.services!.tmuxSession).toBe("sample-app");
    expect(result.services!.tmuxWindows).toBe(2);
    expect(result.services!.teardown).toBe(2);
  });

  it("summarizes the services each environment boots and checks an environment-only provisioner", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
  remote:
    baseUrl: http://localhost:8081
    services:
      provisioner: { up: ./up.sh, down: ./down.sh }
      seed:
        command: ./seed.sh
        postCommands: [{ name: kit, run: ./kit.sh }]
suites:
  s:
    specs: [flows]
    env:
      remote: { seed: { postCommands: { skip: [kit, nope] } } }
`,
      tmpDir,
    );
    mkdirSync(join(tmpDir, "flows"));
    writeFileSync(
      join(tmpDir, "flows", "a.yml"),
      "version: 1\nname: a\nintent: a\nsteps:\n  - open: about:blank\noutcomes: []\n",
    );
    const { result, exitCode } = await runValidate(path);
    expect(result.errors).toEqual([]);
    expect(exitCode).toBe(0);
    expect(result.environmentServices).toEqual({
      remote: ["provisioner", "seed"],
    });
    expect(result.services).toBeUndefined();
    expect(result.warnings).toEqual([
      'suites.s.env.remote.seed.postCommands.skip: "nope" matches no seed postCommand of environment remote (a plain command is matched by its text, a named one by its name)',
    ]);

    const broken = writeConfig(
      `version: 1
environments:
  remote:
    services:
      provisioner: { up: ./up.sh }
`,
      tmpDir,
    );
    const invalid = await runValidate(broken);
    expect(invalid.exitCode).toBe(4);
    expect(invalid.result.errors).toEqual([
      "environments.remote.services.provisioner: no `down` after the merge (there is no top-level services block: the environment's provisioner stands alone); a provisioner needs both `up` and `down` (a provisioned resource must always have a `down`)",
    ]);
  });

  it("lists delegated environments and never counts the top-level services for them", async () => {
    const path = writeConfig(
      `version: 1
services:
  tmux: { session: demo, windows: [{ name: web, command: "true" }] }
environments:
  local:
    baseUrl: http://localhost:8080
  remote:
    runner: { command: [./tools/remote-run.sh], timeoutMs: 600000 }
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(result.errors).toEqual([]);
    expect(exitCode).toBe(0);
    expect(result.delegatedEnvironments).toEqual(["remote"]);
    expect(result.environmentServices).toEqual({ local: ["tmux"] });

    const owning = writeConfig(
      `version: 1
environments:
  remote:
    runner: { command: [./tools/remote-run.sh] }
    services: { tmux: { session: demo, windows: [{ name: web, command: "true" }] } }
`,
      tmpDir,
    );
    const invalid = await runValidate(owning);
    expect(invalid.exitCode).toBe(4);
    expect(invalid.result.errors.join("\n")).toContain(
      'environment "remote" has a runner (it runs elsewhere) and cannot own services',
    );
  });

  it("reports errors for invalid config (wrong version)", async () => {
    const path = writeConfig(
      `version: 2
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports errors for duplicate tmux window names", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
services:
  tmux:
    session: test
    windows:
      - name: web
        command: "yarn start"
      - name: web
        command: "yarn start2"
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unique"))).toBe(true);
  });

  it("reports errors for tvault provider without tvault block", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  required: [API_KEY]
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("tvault"))).toBe(true);
  });

  it("reports errors for empty readyOn object", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
services:
  tmux:
    session: test
    windows:
      - name: web
        command: "yarn start"
        readyOn: {}
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("readyOn"))).toBe(true);
  });

  it("reports errors for invalid YAML syntax", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
services:
  docker:
    command: "docker compose up -d"
    - bad: yaml
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports no config found", async () => {
    const { result, exitCode } = await runValidate("/nonexistent/path.yml");
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("parses like `cairn run`: YAML merge keys, ${env.X:-default}, ${config.dir}", async () => {
    // Before: a private ${env.X} regex + plain parseYaml rejected merge-key
    // configs that run accepted, and left ${config.dir} literal.
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
    vars: &shared
      fixtures: "\${config.dir}/fixtures"
      tenant: "\${env.CAIRN_VALIDATE_UNSET_TENANT:-acme}"
  staging:
    baseUrl: https://staging.example.test
    vars:
      <<: *shared
      tenant: staging
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(result.errors).toEqual([]);
    expect(exitCode).toBe(0);
    expect(result.config?.environments.local?.vars).toEqual({
      fixtures: `${tmpDir}/fixtures`,
      tenant: "acme",
    });
    expect(result.config?.environments.staging?.vars).toEqual({
      fixtures: `${tmpDir}/fixtures`,
      tenant: "staging",
    });
  });

  it("reports a datasource that only breaks after an environment override is merged", async () => {
    const path = writeConfig(
      `version: 1
datasources:
  app:
    kind: mongo
    docker: { service: mongo }
    database: shop
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: http://localhost:8081
    datasources:
      app: { transport: driver }
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringMatching(
        /^environments\.dev\.datasources\.app: .*transport driver needs uri/,
      ),
    ]);
  });

  it("warns when an authored ${vars.X} sits in a config field that stays literal", async () => {
    const path = writeConfig(
      `version: 1
vars:
  host: http://localhost:4173
  token: abc
datasources:
  api:
    kind: http
    baseUrl: "\${vars.host}"
webServer:
  command: "serve \${vars.host}"
  url: http://localhost:4173/health
environments:
  local:
    baseUrl: "\${vars.host}/app"
  dev:
    baseUrl: http://localhost:1
metrics:
  - name: probe
    command: "echo \${vars.token}"
    parse: { regex: "(\\\\d+)" }
  - name: remote
    http: { url: "\${vars.host}/stats", json: { path: n } }
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(result.errors).toEqual([]);
    expect(exitCode).toBe(0);
    const literal = (result.findings ?? []).filter(
      (f) => f.code === "literal-var-ref",
    );
    expect(literal.map((f) => [f.level, f.key])).toEqual([
      ["warning", "webServer.command"],
      ["warning", "metrics[0].command"],
      ["warning", "environments.local.baseUrl"],
    ]);
    expect(literal[2]!.message).toContain("${vars.host}");
    expect(literal[2]!.message).toContain("read literally");
    expect(result.warnings).toEqual(
      expect.arrayContaining(literal.map((f) => f.message)),
    );
  });
});

describe("TmuxConfigSchema validations", () => {
  it("accepts a minimal valid tmux config", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty windows array", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      windows: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate window names", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      windows: [
        { name: "web", command: "yarn start" },
        { name: "web", command: "yarn start" },
      ],
    });
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i: { message: string }) =>
      i.message.includes("unique"),
    );
    expect(issue).toBeDefined();
  });

  it("accepts session options", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      options: [
        { key: "mouse", value: "on" },
        { key: "history-limit", value: "50000" },
        { key: "base-index", value: "1" },
      ],
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts session-level env", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      env: { NODE_ENV: "development", DEBUG: "true" },
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts defaultShell", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      defaultShell: "/bin/zsh",
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts opt-in sequential tmux readiness", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      waitForReadyBeforeNext: true,
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.waitForReadyBeforeNext).toBe(true);
  });

  it("rejects a non-boolean sequential tmux readiness value", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      waitForReadyBeforeNext: "true",
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      windows: [{ name: "web", command: "yarn start" }],
      bogus: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("timeout fields accept 0 (indefinite)", () => {
  it("accepts docker readyTimeoutMs: 0", () => {
    const result = DockerConfigSchema.safeParse({
      command: "docker compose up -d",
      readyTimeoutMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects docker readyTimeoutMs: -1", () => {
    const result = DockerConfigSchema.safeParse({
      command: "docker compose up -d",
      readyTimeoutMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts seed timeoutMs: 0", () => {
    const result = SeedConfigSchema.safeParse({
      command: "yarn seed",
      timeoutMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts seed postCommands (always-run fixture ensure)", () => {
    const result = SeedConfigSchema.safeParse({
      command: "yarn demo-import",
      ttlSeconds: 21600,
      postCommands: [
        "mongosh mongodb://localhost:27017/db --quiet tools/ensure.js",
        "echo ok",
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.postCommands).toHaveLength(2);
    }
  });

  it("rejects empty postCommands entries", () => {
    const result = SeedConfigSchema.safeParse({
      command: "yarn seed",
      postCommands: [""],
    });
    expect(result.success).toBe(false);
  });

  it("accepts tmux readyTimeoutMs: 0", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      readyTimeoutMs: 0,
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("RetentionConfigSchema defaults", () => {
  it("applies defaults for an empty retention block", () => {
    const result = RetentionConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.keepRuns).toBe(3);
      expect(result.data.archiveToStash).toBe(false);
    }
  });

  it("accepts a full retention block with archiving enabled", () => {
    const result = RetentionConfigSchema.safeParse({
      keepRuns: 5,
      archiveToStash: true,
      archiveTags: ["regression", "sample-app"],
      publish: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.keepRuns).toBe(5);
      expect(result.data.archiveToStash).toBe(true);
      expect(result.data.archiveTags).toEqual(["regression", "sample-app"]);
      expect(result.data.publish?.retentionDays).toBe(7);
    }
  });

  it("allows disabling pruning via enabled: false", () => {
    const result = RetentionConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("rejects a non-positive keepRuns", () => {
    const result = RetentionConfigSchema.safeParse({ keepRuns: 0 });
    expect(result.success).toBe(false);
  });

  it("bounds remote publication retention to 31 days", () => {
    expect(
      RetentionConfigSchema.safeParse({
        publish: { enabled: true, retentionDays: 31 },
      }).success,
    ).toBe(true);
    expect(
      RetentionConfigSchema.safeParse({
        publish: { enabled: true, retentionDays: 32 },
      }).success,
    ).toBe(false);
  });
});

describe("TmuxWindowSchema validations", () => {
  it("accepts a minimal window", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web-app",
      command: "yarn serve",
    });
    expect(result.success).toBe(true);
  });

  it("accepts window with readyOn url", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web-app",
      command: "yarn serve",
      readyOn: { url: "http://localhost:8080" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts window with readyOn text", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web-app",
      command: "yarn serve",
      readyOn: { text: "listening on" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts window with both url and text readyOn", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web-app",
      command: "yarn serve",
      readyOn: { url: "http://localhost:8080", text: "ready" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts window with preCommands", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "answers",
      command: "yarn start",
      preCommands: ["yarn build", "yarn migrate"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts window with env", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web-api",
      command: "yarn dev-watch",
      env: { PORT: "3001", DEBUG: "true" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "",
      command: "yarn start",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty command", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web",
      command: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid url in readyOn", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web",
      command: "yarn start",
      readyOn: { url: "not-a-url" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys", () => {
    const result = TmuxWindowSchema.safeParse({
      name: "web",
      command: "yarn start",
      bogus: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("ServicesConfigSchema cross-field validations", () => {
  it("accepts services with only docker", () => {
    const result = ServicesConfigSchema.safeParse({
      docker: { command: "docker compose up -d" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts services with only seed", () => {
    const result = ServicesConfigSchema.safeParse({
      seed: { command: "yarn demo-import", ttlSeconds: 3600 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts services with only tmux", () => {
    const result = ServicesConfigSchema.safeParse({
      tmux: {
        session: "sample-app",
        windows: [{ name: "web", command: "yarn start" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts services with only teardown", () => {
    const result = ServicesConfigSchema.safeParse({
      teardown: ["docker compose down"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a complete services block", () => {
    const result = ServicesConfigSchema.safeParse({
      docker: { command: "docker compose up -d" },
      seed: { command: "yarn seed", ttlSeconds: 3600 },
      tmux: {
        session: "sample-app",
        windows: [
          { name: "web", command: "yarn start", readyOn: { text: "ready" } },
        ],
      },
      teardown: ["tmux kill-session -t sample-app", "docker compose down"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty readyOn object on tmux window", () => {
    const result = ServicesConfigSchema.safeParse({
      tmux: {
        session: "sample-app",
        windows: [{ name: "web", command: "yarn start", readyOn: {} }],
      },
    });
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i: { message: string }) =>
      i.message.includes("readyOn"),
    );
    expect(issue).toBeDefined();
  });

  it("rejects unknown keys in services block", () => {
    const result = ServicesConfigSchema.safeParse({
      docker: { command: "docker compose up -d" },
      bogus: true,
    });
    expect(result.success).toBe(false);
  });

  it("resolves missing services.artifacts to bounded on-failure defaults", () => {
    expect(resolveServicesArtifactsConfig(undefined)).toEqual({
      when: "on-failure",
      capture: ["lifecycle", "tmux", "docker", "seed"],
      maxLinesPerSource: 2_000,
      maxBytesPerSource: 512 * 1024,
      maxBytesPerRun: 8 * 1024 * 1024,
    });
  });

  it("accepts explicit services.artifacts policy and materializes defaults", () => {
    const result = ServicesArtifactsConfigSchema.safeParse({ when: "always" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      when: "always",
      maxLinesPerSource: 2_000,
      maxBytesPerSource: 512 * 1024,
      maxBytesPerRun: 8 * 1024 * 1024,
    });
  });

  it("rejects duplicate sources and a per-source cap above the run cap", () => {
    expect(
      ServicesArtifactsConfigSchema.safeParse({
        capture: ["tmux", "tmux"],
      }).success,
    ).toBe(false);
    expect(
      ServicesArtifactsConfigSchema.safeParse({
        maxBytesPerSource: 1024,
        maxBytesPerRun: 512,
      }).success,
    ).toBe(false);
  });

  it("rejects tmux window artifact-name collisions", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "sample-app",
      windows: [
        { name: "web api", command: "yarn start" },
        { name: "web-api", command: "yarn start" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("SecretsConfigSchema validations", () => {
  it("accepts provider: env without tvault block", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "env",
      required: ["API_KEY"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts provider: tvault with tvault block", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      required: ["API_KEY"],
      tvault: { project: "my-project" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects provider: tvault without tvault block", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      required: ["API_KEY"],
    });
    expect(result.success).toBe(false);
    const issue = result.error!.issues.find((i: { message: string }) =>
      i.message.includes("tvault"),
    );
    expect(issue).toBeDefined();
  });

  it("defaults provider to env", () => {
    const result = SecretsConfigSchema.safeParse({
      required: ["API_KEY"],
    });
    expect(result.success).toBe(true);
    expect(result.data!.provider).toBe("env");
  });

  it("accepts tvault with identity", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { project: "my-project", identity: "default" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tvault with group + env (inheritance mode)", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { group: "myapp", env: "preview" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tvault with group + env + identity", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { group: "myapp", env: "preview", identity: "ci" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects tvault with group but no env", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { group: "myapp" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tvault with env but no group", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { env: "preview" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tvault with both project and group+env", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { project: "myapp-test", group: "myapp", env: "preview" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects tvault with no project, group, or env", () => {
    const result = SecretsConfigSchema.safeParse({
      provider: "tvault",
      tvault: { identity: "ci" },
    });
    expect(result.success).toBe(false);
  });
});

describe("ConfigSchema with services", () => {
  it("accepts config with full services block", () => {
    const cfg = validBaseConfig();
    cfg.services = {
      docker: { command: "docker compose up -d" },
      seed: { command: "yarn seed", ttlSeconds: 3600 },
      tmux: {
        session: "sample-app",
        windows: [
          {
            name: "web",
            cwd: "web-app",
            command: "yarn serve",
            readyOn: { url: "http://localhost:8080" },
          },
        ],
      },
      teardown: ["tmux kill-session -t sample-app"],
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  it("rejects config with unknown top-level key", () => {
    const cfg = validBaseConfig();
    (cfg as Record<string, unknown>).bogus = true;
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  it("accepts config with empty services block", () => {
    const cfg = validBaseConfig();
    cfg.services = { teardown: ["echo done"] };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });
});

describe("BrowserConfigSchema provider/device (iOS/cloud passthrough)", () => {
  it("accepts browser.provider and browser.device", () => {
    const cfg = validBaseConfig();
    cfg.browser = { provider: "ios", device: "iPhone 15 Pro" };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown browser key (strict)", () => {
    const cfg = validBaseConfig();
    cfg.browser = { provider: "ios", bogus: true };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });
});

describe("EnvironmentConfigSchema with per-env services/secrets", () => {
  it("accepts environment with services: false", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      environments: {
        local: { baseUrl: "http://localhost:8080" },
        dev: {
          baseUrl: "https://dev.example.com",
          services: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts environment with partial services override", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      environments: {
        local: { baseUrl: "http://localhost:8080" },
        dev: {
          baseUrl: "https://dev.example.com",
          services: {
            seed: { command: "yarn seed", ttlSeconds: 3600 },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts environment with secrets override", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      environments: {
        local: { baseUrl: "http://localhost:8080" },
        dev: {
          baseUrl: "https://dev.example.com",
          secrets: {
            provider: "tvault",
            tvault: { project: "dev-project" },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects environment with invalid services override", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      environments: {
        dev: {
          baseUrl: "https://dev.example.com",
          services: { docker: { command: 123 } },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("validateConfigFile — auto-discovery", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-discovers cairntrace.config.yml in the cwd", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { result, exitCode } = await runValidate(undefined);
      expect(exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.path).toBe(realpathSync(path));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("reports error when no config file is found anywhere", async () => {
    const emptyDir = makeTmpDir();
    const originalCwd = process.cwd();
    process.chdir(emptyDir);
    try {
      const { result, exitCode } = await runValidate(undefined);
      expect(exitCode).toBe(4);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) => e.includes("no cairntrace.config.yml")),
      ).toBe(true);
      expect(result.path).toBe("(auto-discovery)");
    } finally {
      process.chdir(originalCwd);
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("validateConfigFile — invalid config keys extraction", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts top-level keys from invalid config for diagnostics", async () => {
    const path = writeConfig(
      `version: 1
project: test
environments:
  local:
    baseUrl: http://localhost:8080
services:
  docker:
    command: "docker compose up -d"
    bogus_field: true
`,
      tmpDir,
    );
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    expect(result.keys).toContain("version");
    expect(result.keys).toContain("project");
    expect(result.keys).toContain("environments");
    expect(result.keys).toContain("services");
  });

  it("returns empty keys when YAML root is not an object", async () => {
    const path = writeConfig(`- just\n- a\n- list\n`, tmpDir);
    const { result, exitCode } = await runValidate(path);
    expect(exitCode).toBe(4);
    expect(result.ok).toBe(false);
    // Root is an array — Object.keys returns numeric indices, not top-level config keys
    expect(result.keys).not.toContain("version");
    expect(result.keys).not.toContain("environments");
  });
});

describe("validateConfigFile — ${env.X} substitution", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("substitutes ${env.X} variables from process.env", async () => {
    process.env.TEST_BASE_URL = "http://substituted:9999";
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: \${env.TEST_BASE_URL}
`,
      tmpDir,
    );
    try {
      const { result, exitCode } = await runValidate(path);
      expect(exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.config?.environments?.local?.baseUrl).toBe(
        "http://substituted:9999",
      );
    } finally {
      delete process.env.TEST_BASE_URL;
    }
  });
});

describe("configValidateCommand — CLI wrapper", () => {
  let tmpDir: string;
  let writeSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("outputs JSON when json option is set", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    await configValidateCommand({ config: path, json: true });
    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(path);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("outputs markdown when md option is set (default)", async () => {
    const path = writeConfig(
      `version: 1
project: sample-app
environments:
  local:
    baseUrl: http://localhost:8080
services:
  docker:
    command: "docker compose up -d"
  seed:
    command: "yarn seed"
    ttlSeconds: 3600
  tmux:
    session: sample-app
    windows:
      - name: web
        command: "yarn start"
  teardown:
    - "docker compose down"
`,
      tmpDir,
    );
    await configValidateCommand({ config: path, md: true });
    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("# Config validation — valid");
    expect(output).toContain("path:");
    expect(output).toContain("ok: true");
    expect(output).toContain("## Services");
    expect(output).toContain("docker: configured");
    expect(output).toContain("seed: configured");
    expect(output).toContain("tmux: configured");
    expect(output).toContain("tmux session: sample-app");
    expect(output).toContain("tmux windows: 1");
    expect(output).toContain("teardown commands: 1");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("outputs markdown with errors when config is invalid", async () => {
    const path = writeConfig(
      `version: 2
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    await configValidateCommand({ config: path, md: true });
    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("# Config validation — invalid");
    expect(output).toContain("## Errors");
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it("exits with code 4 when config file not found", async () => {
    await configValidateCommand({ config: "/nonexistent/path.yml", md: true });
    expect(exitSpy).toHaveBeenCalledWith(4);
  });
});

describe("toMarkdown — service summary rendering", () => {
  let tmpDir: string;
  let writeSpy: MockInstance;
  let exitSpy: MockInstance;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("renders keys when present", async () => {
    const path = writeConfig(
      `version: 1
project: myproject
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    await configValidateCommand({ config: path, md: true });
    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain(
      "keys: version, project, defaultEnvironment, environments",
    );
  });

  it("omits services section when no services configured", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
`,
      tmpDir,
    );
    await configValidateCommand({ config: path, md: true });
    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).not.toContain("## Services");
  });

  it("omits tmux session when not configured", async () => {
    const path = writeConfig(
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
services:
  docker:
    command: "docker compose up -d"
`,
      tmpDir,
    );
    await configValidateCommand({ config: path, md: true });
    const output = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("## Services");
    expect(output).toContain("docker: configured");
    expect(output).not.toContain("tmux session:");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe("config validate — F15 widget drivers", () => {
  it("accepts fieldRoot / widgets and reports a missing or invalid driver module", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "drivers"));
      writeFileSync(
        join(dir, "drivers", "ok.js"),
        "export default { name: 'ok', match: () => false, read: () => '', write() {} };",
      );
      writeFileSync(join(dir, "drivers", "bad.js"), "export const x = 1;");
      const base = [
        "version: 1",
        "environments:",
        "  local: {}",
        "browser:",
        "  fieldRoot: '[data-field=\"{key}\"]'",
        "  widgets:",
        "    - use: vue-multiselect",
      ];
      const ok = await runValidate(
        writeConfig(
          [...base, "    - file: ./drivers/ok.js", ""].join("\n"),
          dir,
        ),
      );
      expect(ok.exitCode).toBe(0);
      const missing = await runValidate(
        writeConfig(
          [...base, "    - file: ./drivers/missing.js", ""].join("\n"),
          dir,
        ),
      );
      expect(missing.exitCode).toBe(4);
      expect(missing.result.errors.join("\n")).toContain(
        'browser.widgets[1].file "./drivers/missing.js"',
      );
      const bad = await runValidate(
        writeConfig(
          [...base, "    - file: ./drivers/bad.js", ""].join("\n"),
          dir,
        ),
      );
      expect(bad.exitCode).toBe(4);
      expect(bad.result.errors.join("\n")).toContain("export default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates an environment auth block and its hydrate file", async () => {
    const dir = makeTmpDir();
    try {
      mkdirSync(join(dir, "auth"));
      writeFileSync(join(dir, "auth", "hydrate.js"), "return true;");
      const ok = await runValidate(
        writeConfig(authConfig("auth/hydrate.js"), dir),
      );
      expect(ok.exitCode).toBe(0);
      const missing = await runValidate(
        writeConfig(authConfig("auth/missing.js"), dir),
      );
      expect(missing.exitCode).toBe(4);
      expect(missing.result.errors.join("\n")).toContain(
        "environments.local.auth.hydrate.file: auth/missing.js does not exist",
      );
      const invalid = await runValidate(
        writeConfig(authConfig("auth/hydrate.js", "      retries: 2"), dir),
      );
      expect(invalid.exitCode).toBe(4);
      expect(invalid.result.errors.join("\n")).toContain(
        "environments.local.auth",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function authConfig(hydrate: string, extra = ""): string {
  return [
    "version: 1",
    "environments:",
    "  local:",
    "    baseUrl: http://localhost:3000",
    "    auth:",
    "      login:",
    "        url: /api/login",
    '        body: { email: "${secrets.E2E_EMAIL}", password: "${secrets.E2E_PASSWORD}" }',
    "        expectStatus: 200",
    "      after:",
    "        - when: { var: requests.login.body.mfa, equals: otp }",
    '          request: { method: PUT, url: /api/otp/verify, headers: { authorization: "Bearer ${requests.login.body.token}" } }',
    `      hydrate: { file: ${hydrate} }`,
    extra,
    "",
  ].join("\n");
}

describe("config validate: environment alias and suite env fallback", () => {
  it("accepts an alias and rejects chains, unknown targets and extra keys with exit 4", async () => {
    const dir = makeTmpDir();
    try {
      const ok = await runValidate(
        writeConfig(
          "version: 1\nenvironments:\n  stage: { baseUrl: 'http://localhost:1' }\n  remote: { alias: stage }\n",
          dir,
        ),
      );
      expect(ok.exitCode).toBe(0);
      expect(ok.result.errors).toEqual([]);
      for (const [text, needle] of [
        [
          "version: 1\nenvironments:\n  stage: {}\n  a: { alias: stage }\n  b: { alias: a }\n",
          "alias chain",
        ],
        [
          "version: 1\nenvironments:\n  a: { alias: b }\n  b: { alias: a }\n",
          "alias cycle",
        ],
        [
          "version: 1\nenvironments:\n  stage: {}\n  a: { alias: nope }\n",
          'unknown environment "nope"',
        ],
        [
          "version: 1\nenvironments:\n  stage: {}\n  a: { alias: stage, waitScale: 2 }\n",
          "takes no other keys",
        ],
      ] as const) {
        const bad = await runValidate(writeConfig(text, dir));
        expect(bad.exitCode, text).toBe(4);
        expect(bad.result.errors.join("\n")).toContain(needle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (suite-env-fallback) when an admitted environment lacks the override a sibling has", async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, "a.yml"),
        "version: 1\nname: a\nintent: x\nsteps: []\noutcomes: []\n",
      );
      writeFileSync(
        join(dir, "b.yml"),
        "version: 1\nname: b\nintent: x\nsteps: []\noutcomes: []\n",
      );
      const { result, exitCode } = await runValidate(
        writeConfig(
          `version: 1
environments:
  local: {}
  stage: {}
suites:
  smoke:
    specs: [a.yml]
    requires: { env: [local, stage] }
    env:
      local: { specs: [b.yml] }
`,
          dir,
        ),
      );
      expect(result.errors).toEqual([]);
      expect(exitCode).toBe(0);
      const finding = (result.findings ?? []).find(
        (f) => f.code === "suite-env-fallback",
      );
      expect(finding).toMatchObject({
        level: "warning",
        key: "suites.smoke.env.stage",
      });
      expect(finding?.message).toContain("suites.smoke");
      expect(finding?.message).toContain('"stage"');
      expect(result.warnings).toContain(finding?.message);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
