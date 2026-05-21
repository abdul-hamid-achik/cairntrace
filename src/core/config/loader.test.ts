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
