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
  it("warns for unacknowledged sessionless specs", async () => {
    const specPath = join(dir, "sessionless.yml");
    await writeFile(
      specPath,
      `version: 1
name: sessionless
intent: sessionless specs should acknowledge guest mode
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
`,
    );
    const result = await runVerify(specPath, { json: true });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).warnings).toContainEqual(
      expect.stringContaining("cold-start: no imports"),
    );
  });

  it("accepts coldStart: guest as an intentional sessionless acknowledgement", async () => {
    const specPath = join(dir, "guest.yml");
    await writeFile(
      specPath,
      `version: 1
name: guest
intent: public flow intentionally starts without a session
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
`,
    );
    const result = await runVerify(specPath, { json: true });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "valid",
      warnings: [expect.stringContaining("no contractHash")],
    });
    expect(JSON.parse(result.stdout).warnings).not.toContainEqual(
      expect.stringContaining("cold-start:"),
    );
  });

  it("keeps focused selector-only batch diagnostics on the --stamp path", async () => {
    const specPath = join(dir, "invalid-batch-stamp.yml");
    await writeFile(
      specPath,
      `version: 1
name: invalid_batch_stamp
intent: stamp reports the authored batch locator mistake
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - batch:
      - hover: { by: selector, selector: "#menu" }
      - click: { by: role, role: button, name: Save }
`,
    );

    const result = await runVerify(specPath, { json: true, stamp: true });

    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "invalid",
      errors: [expect.stringContaining("batch sub-step #2")],
    });
    expect(await readFile(specPath, "utf8")).not.toContain("contractHash:");
  });

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

  it("flags silent-empty env refs and undeclared secrets", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:9
secrets:
  provider: env
  required:
    - SUPPLIED_SECRET
`,
    );
    const specPath = join(dir, "silent-empty.yml");
    await writeFile(
      specPath,
      `version: 1
name: silent_empty_refs
intent: silent empty substitutions must fail verify
preconditions:
  commands:
    - run: "echo \${env.NOT_SUPPLIED} \${secrets.UNDECLARED} \${env.SUPPLIED_SECRET} \${env.CAIRN_TVAULT_ENV:-local}"
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
`,
    );

    const result = await runVerify(specPath, {
      json: true,
      config: configPath,
    });
    expect(result.code).toBe(4);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("invalid");
    expect(parsed.referenceFindings).toBe(2);
    const errors = parsed.errors as string[];
    expect(errors.some((e) => e.includes("${env.NOT_SUPPLIED}"))).toBe(true);
    expect(errors.some((e) => e.includes("${secrets.UNDECLARED}"))).toBe(true);
    // Declared secrets and defaulted env refs are not findings.
    expect(errors.some((e) => e.includes("SUPPLIED_SECRET"))).toBe(false);
    expect(errors.some((e) => e.includes("CAIRN_TVAULT_ENV"))).toBe(false);
  });

  it("accepts env refs with defaults and declared secrets", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:9
secrets:
  provider: env
  required:
    - SUPPLIED_SECRET
`,
    );
    const specPath = join(dir, "clean-refs.yml");
    await writeFile(
      specPath,
      `version: 1
name: clean_refs
intent: supplied refs verify clean
preconditions:
  commands:
    - run: "echo \${env.NODE_ENV:-development} \${secrets.SUPPLIED_SECRET}"
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
`,
    );

    const result = await runVerify(specPath, {
      json: true,
      config: configPath,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("valid");
    expect(parsed.referenceFindings).toBe(0);
  });
});
