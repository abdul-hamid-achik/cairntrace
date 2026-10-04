import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  replaceContractHashLine,
  stampSpecContractHash,
  verifyCommand,
  verifySpec,
} from "./verify";

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

  it("does not rewrite quoted # selectors or ${vars} placeholders", async () => {
    const specPath = join(dir, "quoted-selectors.yml");
    const source = `version: 1
name: quoted_selectors
intent: stamp must keep YAML quoting
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - click:
      by: selector
      selector: "#element_abc"
  - click:
      by: selector
      selector: "\${vars.tableSelector}"
`;
    await writeFile(specPath, source);
    const hash = await stampSpecContractHash(specPath);
    const text = await readFile(specPath, "utf8");
    expect(text).toContain('selector: "#element_abc"');
    expect(text).toContain('selector: "${vars.tableSelector}"');
    expect(text).toContain(`contractHash: ${hash}`);
    expect(text.replace(/\ncontractHash: sha256:[a-f0-9]+\n$/, "\n")).toBe(
      source,
    );
  });

  it("replaceContractHashLine appends when the file has no hash", () => {
    expect(replaceContractHashLine("version: 1\n", "sha256:abc")).toBe(
      "version: 1\ncontractHash: sha256:abc\n",
    );
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

describe("verifySpec (shared CLI + MCP verify path)", () => {
  const SPEC = `version: 1
name: shared_verify
intent: shared verify path
preconditions:
  commands:
    - run: "echo \${secrets.ENV_LEVEL_SECRET}"
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
`;

  it("fails with exit 4 and a clear error for an unknown --env", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      "version: 1\nenvironments:\n  local:\n    baseUrl: http://localhost:9\n",
    );
    const specPath = join(dir, "unknown-env.yml");
    await writeFile(specPath, SPEC);
    const { result, exitCode } = await verifySpec(specPath, {
      env: "prod",
      config: configPath,
    });
    expect(exitCode).toBe(4);
    expect(result.status).toBe("invalid");
    expect(result.errors[0]).toContain('unknown environment "prod"');
    expect(result.errors[0]).toContain("defines: local");

    const cli = await runVerify(specPath, {
      json: true,
      env: "prod",
      config: configPath,
    });
    expect(cli.code).toBe(4);
  });

  it("audits against the EFFECTIVE (environment-level) secrets.required", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
secrets:
  provider: env
  required: [TOP_LEVEL_ONLY]
environments:
  local:
    baseUrl: http://localhost:9
  ci:
    baseUrl: http://localhost:9
    secrets:
      provider: env
      required: [ENV_LEVEL_SECRET]
`,
    );
    const specPath = join(dir, "env-secrets.yml");
    await writeFile(specPath, SPEC);
    const local = await verifySpec(specPath, { config: configPath });
    expect(local.exitCode).toBe(4);
    expect(local.result.referenceFindings).toBe(1);
    const ci = await verifySpec(specPath, { config: configPath, env: "ci" });
    expect(ci.exitCode).toBe(0);
    expect(ci.result.referenceFindings).toBe(0);
    expect(ci.result.coldStartSatisfied).toBe(true);
  });

  it("checks wait.app handles against config browser.appHandle (F20)", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      "version: 1\nenvironments:\n  local:\n    baseUrl: http://localhost:9\nbrowser:\n  appHandle:\n    store: window.appStore\n",
    );
    const specPath = join(dir, "app-wait.yml");
    await writeFile(
      specPath,
      `version: 1
name: app_wait
intent: wait on app state
coldStart: guest
steps:
  - wait: { app: { path: store.ready, equals: true } }
  - wait:
      any: [{ text: Saved }, { app: { path: cart.count, exists: true } }]
      timeoutMs: 5000
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
`,
    );
    const { result, exitCode } = await verifySpec(specPath, {
      config: configPath,
    });
    expect(exitCode).toBe(4);
    expect(result.errors).toEqual([
      'wait.app: no browser.appHandle named "cart" (configured: store) — add it to the config browser.appHandle',
    ]);
  });

  it("surfaces implicit-environment warnings without failing", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      "version: 1\nenvironments:\n  staging:\n    baseUrl: http://localhost:9\n",
    );
    const specPath = join(dir, "implicit-env.yml");
    await writeFile(specPath, SPEC.replace("ENV_LEVEL_SECRET", "X:-x"));
    const { result, exitCode } = await verifySpec(specPath, {
      config: configPath,
    });
    expect(exitCode).toBe(0);
    expect(result.warnings.some((w) => w.includes('no "local"'))).toBe(true);
  });

  it("keeps `environment: local` specs valid against a config with no environments", async () => {
    // Regression: the spec-level environment was briefly a hard error, which
    // broke every scaffolded spec (`environment: local`) in projects whose
    // config defines `environments: {}`.
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      "version: 1\nenvironments: {}\nbrowser: { testIdAttribute: data-qa }\n",
    );
    const specPath = join(dir, "spec-local.yml");
    await writeFile(
      specPath,
      `${SPEC.replace("ENV_LEVEL_SECRET", "X:-x")}environment: local\nsteps:\n  - open: https://example.test/\n`,
    );
    const { result, exitCode } = await verifySpec(specPath, {
      config: configPath,
    });
    expect(exitCode).toBe(0);
    expect(result.status).not.toBe("invalid");
    expect(result.warnings.join("\n")).not.toContain("environment");
  });

  it("only warns when a spec's environment: is not defined in the config", async () => {
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      "version: 1\nenvironments:\n  dev: {}\n  prod: {}\n",
    );
    const specPath = join(dir, "spec-stale-env.yml");
    await writeFile(
      specPath,
      `${SPEC.replace("ENV_LEVEL_SECRET", "X:-x")}environment: local\n`,
    );
    const { result, exitCode } = await verifySpec(specPath, {
      config: configPath,
    });
    expect(exitCode).toBe(0);
    expect(
      result.warnings.some((w) => w.includes(`the spec's environment "local"`)),
    ).toBe(true);
  });
});

describe("verifySpec with environment-scoped include", () => {
  const FIXTURE = join(
    import.meta.dirname,
    "../../../core/config/__fixtures__/composition-env",
  );

  it("gives the same verdict in every environment as the unsplit config (a var an environment does not define is still unresolved there)", async () => {
    const verdicts = async (side: "before" | "after") => {
      const out: Record<string, { status: string; errors: string[] }> = {};
      for (const env of ["local", "tunnel", "dev", "test"]) {
        const { result } = await verifySpec(join(FIXTURE, side, "spec.yml"), {
          config: join(FIXTURE, side, "cairntrace.config.yml"),
          env,
        });
        out[env] = {
          status: result.status,
          // paths differ by design (two fixture directories)
          errors: result.errors.map((e) =>
            e.replaceAll(join(FIXTURE, side), "<dir>"),
          ),
        };
      }
      return out;
    };
    const before = await verifySpec(join(FIXTURE, "before", "spec.yml"), {
      config: join(FIXTURE, "before", "cairntrace.config.yml"),
      env: "dev",
    });
    expect(before.result.errors.join("\n")).toContain(
      "missing vars.sandboxPath",
    );
    const split = await verdicts("after");
    expect(split).toEqual(await verdicts("before"));
    expect(split.local!.status).not.toBe("invalid");
    expect(split.tunnel!.status).not.toBe("invalid");
    expect(split.dev!.status).toBe("invalid");
    expect(split.test!.status).toBe("invalid");
  });
});
