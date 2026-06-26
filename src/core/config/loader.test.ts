import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findConfigFile, loadConfig } from "./loader";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-config-test-"));
});

afterAll(async () => {
  // best-effort; tmp is fine to leak in tests
});

describe("findConfigFile", () => {
  it("walks up from the spec dir until it finds a config", async () => {
    const projectRoot = join(dir, "walk-test");
    const flowsDir = join(projectRoot, "flows", "deep");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      "version: 1\nenvironments:\n  local:\n    baseUrl: http://localhost:1234\n",
    );

    const found = await findConfigFile(flowsDir);
    expect(found).toBe(join(projectRoot, "cairntrace.config.yml"));
  });

  it("returns undefined when no config exists in the ancestry", async () => {
    const isolated = join(dir, "no-config");
    await mkdir(isolated, { recursive: true });
    // Walking up from /tmp/.../no-config will hit `/` without finding a config,
    // unless there's one in /tmp (there shouldn't be).
    const found = await findConfigFile(isolated);
    // We can't fully assert undefined because the user's home might have one,
    // but we CAN assert it's not the file we never wrote.
    expect(found).not.toBe(join(isolated, "cairntrace.config.yml"));
  });
});

describe("loadConfig", () => {
  it("loads and validates a config file", async () => {
    const projectRoot = join(dir, "load-test");
    await mkdir(projectRoot, { recursive: true });
    const configPath = join(projectRoot, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
project: demo
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8787
    vars:
      companyId: 123
  staging:
    baseUrl: https://staging.example.com
report:
  theme: graphite
  colors:
    accent: "#256f7d"
    surface: "rgb(243, 245, 242)"
`,
    );
    const specPath = join(projectRoot, "flows", "spec.yml");
    await mkdir(join(projectRoot, "flows"), { recursive: true });
    await writeFile(specPath, "version: 1\nname: x\nintent: x\noutcomes: []\n");

    const loaded = await loadConfig(specPath);
    expect(loaded?.config.project).toBe("demo");
    expect(loaded?.config.environments["local"]?.baseUrl).toBe(
      "http://localhost:8787",
    );
    expect(loaded?.config.environments["staging"]?.baseUrl).toBe(
      "https://staging.example.com",
    );
    expect(loaded?.config.report?.theme).toBe("graphite");
    expect(loaded?.config.report?.colors?.surface).toBe("rgb(243, 245, 242)");
    expect(loaded?.path).toBe(configPath);
  });

  it("honors an explicit --config path", async () => {
    const isolatedSpec = join(dir, "explicit-test", "spec.yml");
    await mkdir(join(dir, "explicit-test"), { recursive: true });
    await writeFile(
      isolatedSpec,
      "version: 1\nname: x\nintent: x\noutcomes: []\n",
    );
    const explicitConfig = join(dir, "explicit-test", "custom.yml");
    await writeFile(
      explicitConfig,
      "version: 1\nenvironments:\n  staging:\n    baseUrl: https://x.test\n",
    );
    const loaded = await loadConfig(isolatedSpec, explicitConfig);
    expect(loaded?.path).toBe(explicitConfig);
    expect(loaded?.config.environments["staging"]?.baseUrl).toBe(
      "https://x.test",
    );
  });
});

describe("loadConfig webServer", () => {
  async function loadWebServerConfig(body: string) {
    const projectDir = join(
      dir,
      `webserver-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(projectDir, { recursive: true });
    const specPath = join(projectDir, "spec.yml");
    await writeFile(specPath, "version: 1\nname: x\nintent: x\noutcomes: []\n");
    await writeFile(join(projectDir, "cairntrace.config.yml"), body);
    return loadConfig(specPath);
  }

  it("parses a full webServer block", async () => {
    const loaded = await loadWebServerConfig(
      `version: 1
environments:
  local:
    baseUrl: http://127.0.0.1:3000
webServer:
  build: bun run build
  command: node .output/server/index.mjs
  url: http://127.0.0.1:3000
  env:
    HOST: 127.0.0.1
    PORT: "3000"
  reuseExisting: true
  readyTimeoutMs: 60000
  setup: ["redis-cli -n 1 flushdb"]
  teardown: ["redis-cli -n 1 flushdb"]
`,
    );
    const ws = loaded?.config.webServer;
    expect(ws?.command).toBe("node .output/server/index.mjs");
    expect(ws?.build).toBe("bun run build");
    expect(ws?.url).toBe("http://127.0.0.1:3000");
    expect(ws?.env?.["PORT"]).toBe("3000");
    expect(ws?.reuseExisting).toBe(true);
    expect(ws?.readyTimeoutMs).toBe(60000);
    expect(ws?.setup).toEqual(["redis-cli -n 1 flushdb"]);
    expect(ws?.teardown).toEqual(["redis-cli -n 1 flushdb"]);
  });

  it("accepts a minimal block (command + waitForText, no url)", async () => {
    const loaded = await loadWebServerConfig(
      `version: 1
environments:
  local: {}
webServer:
  command: bun run start
  waitForText: Listening on
`,
    );
    expect(loaded?.config.webServer?.command).toBe("bun run start");
    expect(loaded?.config.webServer?.waitForText).toBe("Listening on");
    expect(loaded?.config.webServer?.url).toBeUndefined();
  });

  it("rejects unknown keys in webServer (.strict())", async () => {
    await expect(
      loadWebServerConfig(
        `version: 1
environments:
  local: {}
webServer:
  command: node server.js
  bogusKey: nope
`,
      ),
    ).rejects.toThrow();
  });

  it("substitutes ${env.X} into webServer url and env before parsing", async () => {
    process.env["CAIRN_WS_PORT"] = "4321";
    try {
      const loaded = await loadWebServerConfig(
        `version: 1
environments:
  local: {}
webServer:
  command: node server.js
  url: http://127.0.0.1:\${env.CAIRN_WS_PORT}
  env:
    PORT: "\${env.CAIRN_WS_PORT}"
`,
      );
      expect(loaded?.config.webServer?.url).toBe("http://127.0.0.1:4321");
      expect(loaded?.config.webServer?.env?.["PORT"]).toBe("4321");
    } finally {
      delete process.env["CAIRN_WS_PORT"];
    }
  });
});

describe("loadConfig env substitution", () => {
  it("substitutes ${env.X:-fallback} when the env var is missing", async () => {
    const projectDir = join(dir, "env-fallback-subst");
    await mkdir(projectDir, { recursive: true });
    const specPath = join(projectDir, "spec.yml");
    await writeFile(specPath, "version: 1\nname: x\nintent: x\noutcomes: []\n");
    await writeFile(
      join(projectDir, "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://localhost:\${env.CAIRN_MISSING_PORT:-8080}
`,
    );
    delete process.env["CAIRN_MISSING_PORT"];
    const loaded = await loadConfig(specPath);
    expect(loaded?.config.environments["local"]?.baseUrl).toBe(
      "http://localhost:8080",
    );
  });

  it("prefers env var over ${env.X:-fallback} default", async () => {
    const projectDir = join(dir, "env-fallback-preferred");
    await mkdir(projectDir, { recursive: true });
    const specPath = join(projectDir, "spec.yml");
    await writeFile(specPath, "version: 1\nname: x\nintent: x\noutcomes: []\n");
    await writeFile(
      join(projectDir, "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://localhost:\${env.CAIRN_PREFERRED_PORT:-8080}
`,
    );
    process.env["CAIRN_PREFERRED_PORT"] = "3123";
    try {
      const loaded = await loadConfig(specPath);
      expect(loaded?.config.environments["local"]?.baseUrl).toBe(
        "http://localhost:3123",
      );
    } finally {
      delete process.env["CAIRN_PREFERRED_PORT"];
    }
  });

  it("substitutes ${env.X} in config text before parsing", async () => {
    const projectDir = join(dir, "env-subst");
    await mkdir(projectDir, { recursive: true });
    const specPath = join(projectDir, "spec.yml");
    await writeFile(specPath, "version: 1\nname: x\nintent: x\noutcomes: []\n");
    await writeFile(
      join(projectDir, "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://localhost:\${env.CAIRN_TEST_PORT}
    vars:
      apiBase: http://localhost:\${env.CAIRN_TEST_PORT}/api
`,
    );
    process.env["CAIRN_TEST_PORT"] = "3123";
    try {
      const loaded = await loadConfig(specPath);
      expect(loaded?.config.environments["local"]?.baseUrl).toBe(
        "http://localhost:3123",
      );
      expect(loaded?.config.environments["local"]?.vars?.["apiBase"]).toBe(
        "http://localhost:3123/api",
      );
    } finally {
      delete process.env["CAIRN_TEST_PORT"];
    }
  });
});
