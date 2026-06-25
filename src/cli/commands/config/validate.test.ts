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
  TmuxConfigSchema,
  TmuxWindowSchema,
  ServicesConfigSchema,
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
project: graphite
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  required: [MONGO_SOURCE_PASSWORD, ES_SOURCE_PASSWORD]
  tvault:
    project: graphite
services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
  seed:
    command: "yarn demo-import"
    ttlSeconds: 3600
    freshnessCheck: "mongosh --quiet --eval 'db.count()'"
  tmux:
    session: graphite
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
    - "tmux kill-session -t graphite"
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
    expect(result.services!.tmuxSession).toBe("graphite");
    expect(result.services!.tmuxWindows).toBe(2);
    expect(result.services!.teardown).toBe(2);
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
});

describe("TmuxConfigSchema validations", () => {
  it("accepts a minimal valid tmux config", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "graphite",
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty windows array", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "graphite",
      windows: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate window names", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "graphite",
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
      session: "graphite",
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
      session: "graphite",
      env: { NODE_ENV: "development", DEBUG: "true" },
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts defaultShell", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "graphite",
      defaultShell: "/bin/zsh",
      windows: [{ name: "web", command: "yarn start" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys", () => {
    const result = TmuxConfigSchema.safeParse({
      session: "graphite",
      windows: [{ name: "web", command: "yarn start" }],
      bogus: true,
    });
    expect(result.success).toBe(false);
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
        session: "graphite",
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
        session: "graphite",
        windows: [
          { name: "web", command: "yarn start", readyOn: { text: "ready" } },
        ],
      },
      teardown: ["tmux kill-session -t graphite", "docker compose down"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty readyOn object on tmux window", () => {
    const result = ServicesConfigSchema.safeParse({
      tmux: {
        session: "graphite",
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
});

describe("ConfigSchema with services", () => {
  it("accepts config with full services block", () => {
    const cfg = validBaseConfig();
    cfg.services = {
      docker: { command: "docker compose up -d" },
      seed: { command: "yarn seed", ttlSeconds: 3600 },
      tmux: {
        session: "graphite",
        windows: [
          {
            name: "web",
            cwd: "web-app",
            command: "yarn serve",
            readyOn: { url: "http://localhost:8080" },
          },
        ],
      },
      teardown: ["tmux kill-session -t graphite"],
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
project: graphite
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
    session: graphite
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
    expect(output).toContain("tmux session: graphite");
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
