import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stampSpecContractHash, verifyCommand } from "./verify";

class ExitIntercept extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function runVerify(
  specPath: string,
  opts: Parameters<typeof verifyCommand>[1],
): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: string | number | null,
  ) => {
    throw new ExitIntercept(Number(code ?? 0));
  }) as never);
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
  ) => {
    stdout += String(chunk);
    return true;
  }) as never);

  try {
    await verifyCommand(specPath, opts);
    return { code: 0, stdout };
  } catch (e) {
    if (e instanceof ExitIntercept) return { code: e.code, stdout };
    throw e;
  } finally {
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-verify-"));
});

describe("verifyCommand", () => {
  it("resolves config vars with --config before validating the spec", async () => {
    const configPath = join(dir, "custom.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      connectionPath: /connection/abc
`,
    );
    const specPath = join(dir, "flow.yml");
    await writeFile(
      specPath,
      `version: 1
name: config_verify
intent: verify resolves config vars
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const result = await runVerify(specPath, {
      json: true,
      config: configPath,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "valid",
      path: specPath,
    });
  });

  it("reports a clear error when a config var is missing", async () => {
    const specPath = join(dir, "missing-var.yml");
    await writeFile(
      specPath,
      `version: 1
name: missing_var_verify
intent: missing vars should be explicit
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const result = await runVerify(specPath, { json: true });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "invalid",
      errors: [`missing vars.connectionPath while parsing ${specPath}`],
    });
  });

  it("stamps raw contracts and validates them with resolved config vars", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      expectedPath: /connection/abc
      connectionPath: /connection/abc
`,
    );
    const specPath = join(dir, "raw-contract.yml");
    await writeFile(
      specPath,
      `version: 1
name: raw_contract_verify
intent: hash keeps variables raw
outcomes:
  - id: path_visible
    description: path is visible
    verify:
      text: { contains: "\${vars.expectedPath}" }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const stamped = await runVerify(specPath, { json: true, stamp: true });
    expect(stamped.code).toBe(0);
    expect(JSON.parse(stamped.stdout).status).toBe("stamped");
    const stampedText = await readFile(specPath, "utf8");
    expect(stampedText).toContain("contractHash: sha256:");

    const verified = await runVerify(specPath, {
      json: true,
      config: configPath,
    });
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout).status).toBe("valid");
  });

  it("uses --env to select environment vars during validation", async () => {
    const projectRoot = join(dir, "project");
    const flowsDir = join(projectRoot, "flows");
    await mkdir(flowsDir, { recursive: true });
    await writeFile(
      join(projectRoot, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      connectionPath: /local
  staging:
    vars:
      connectionPath: /staging
`,
    );
    const specPath = join(flowsDir, "env-override.yml");
    await writeFile(
      specPath,
      `version: 1
name: env_override_verify
intent: env override selects vars
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "\${vars.connectionPath}"
`,
    );

    const result = await runVerify(specPath, { json: true, env: "staging" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("valid");
  });
});

describe("stampSpecContractHash", () => {
  it("preserves leading comments and writes the computed contract hash", async () => {
    const specPath = join(dir, "stamp-helper.yml");
    await writeFile(
      specPath,
      `# keep this comment

version: 1
name: stamp_helper
intent: helper stamps contracts
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
`,
    );

    const hash = await stampSpecContractHash(specPath);
    const text = await readFile(specPath, "utf8");
    expect(hash).toMatch(/^sha256:/);
    expect(text.startsWith("# keep this comment\n\n")).toBe(true);
    expect(text).toContain(`contractHash: ${hash}`);
  });
});
