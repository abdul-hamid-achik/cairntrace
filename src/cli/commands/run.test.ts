import { execa } from "execa";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import {
  expandSpecArgs,
  maybeInjectTvaultSecrets,
  synthesizeErroredResult,
  type RunCommandOptions,
} from "./run";

// Mock the tvault helper so CLI tests don't require a real TinyVault project.
vi.mock("./secrets", async () => {
  const actual = await vi.importActual<typeof import("./secrets")>("./secrets");
  return {
    ...actual,
    getTvaultEnv: vi.fn(),
    tvaultArgs: actual.tvaultArgs,
  };
});
const { getTvaultEnv } = await import("./secrets");

describe("synthesizeErroredResult", () => {
  it("produces a RunResult that parses against the v1 wire schema", () => {
    const result = synthesizeErroredResult(
      "/some/absolute/path/to/spec.yml",
      new Error("could not load spec"),
    );
    const parsed = RunResultSchema.parse(result);
    expect(parsed.status).toBe("errored");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.runDir.startsWith("/")).toBe(true);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]!.error).toBe("could not load spec");
  });

  it("absolutifies a relative spec path", () => {
    const result = synthesizeErroredResult(
      "flows/relative.yml",
      new Error("oops"),
    );
    expect(result.spec.path.startsWith("/")).toBe(true);
  });

  it("strips .yml/.yaml from the spec name", () => {
    expect(
      synthesizeErroredResult("/x/import_xlsx.yml", new Error("e")).spec.name,
    ).toBe("import_xlsx");
    expect(
      synthesizeErroredResult("/x/foo.yaml", new Error("e")).spec.name,
    ).toBe("foo");
  });
});

describe("parseVarFlags", () => {
  it("parses repeated key=value pairs", async () => {
    const { parseVarFlags } = await import("./run");
    expect(parseVarFlags(["baseUrl=http://localhost:3123", "a=b"])).toEqual({
      baseUrl: "http://localhost:3123",
      a: "b",
    });
  });

  it("splits on the first = only", async () => {
    const { parseVarFlags } = await import("./run");
    expect(parseVarFlags(["token=a=b=c"])).toEqual({ token: "a=b=c" });
  });

  it("throws on malformed pairs", async () => {
    const { parseVarFlags } = await import("./run");
    expect(() => parseVarFlags(["nodelimiter"])).toThrow(/key=value/);
    expect(() => parseVarFlags(["=value"])).toThrow(/key=value/);
  });

  it("returns an empty bag for undefined", async () => {
    const { parseVarFlags } = await import("./run");
    expect(parseVarFlags(undefined)).toEqual({});
  });
});

describe("expandSpecArgs", () => {
  it("expands directories recursively while skipping actions and underscore specs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-expand-"));
    await mkdir(join(dir, "flows", "nested"), { recursive: true });
    await mkdir(join(dir, "flows", "actions"), { recursive: true });
    await writeFile(join(dir, "flows", "a.yml"), "version: 1\n");
    await writeFile(join(dir, "flows", "nested", "b.yaml"), "version: 1\n");
    await writeFile(join(dir, "flows", "_draft.yml"), "version: 1\n");
    await writeFile(join(dir, "flows", "actions", "login.yml"), "version: 1\n");
    await writeFile(join(dir, "flows", "notes.txt"), "notes\n");

    await expect(expandSpecArgs(["flows"], dir)).resolves.toEqual([
      join(dir, "flows", "a.yml"),
      join(dir, "flows", "nested", "b.yaml"),
    ]);
  });

  it("preserves explicit files and missing paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-expand-"));
    await writeFile(join(dir, "_explicit.yml"), "version: 1\n");

    await expect(
      expandSpecArgs(["_explicit.yml", "missing.yml"], dir),
    ).resolves.toEqual(["_explicit.yml", "missing.yml"]);
  });
});

describe("services dry-run (end-to-end via CLI)", () => {
  const binCairn = join(process.cwd(), "bin", "cairn");

  async function runDryRun(
    configYaml: string,
    specYaml: string,
    extraArgs: string[] = [],
  ): Promise<{ stderr: string; exitCode: number | null }> {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-dryrun-"));
    await writeFile(join(dir, "cairntrace.config.yml"), configYaml);
    await writeFile(join(dir, "spec.yml"), specYaml);
    const result = await execa(binCairn, [
      "run",
      join(dir, "spec.yml"),
      "--config",
      join(dir, "cairntrace.config.yml"),
      "--mock",
      "--services-dry-run",
      "--no-web-server",
      "--format",
      "json",
      ...extraArgs,
    ]);
    return { stderr: result.stderr, exitCode: result.exitCode ?? 0 };
  }

  it("prints dry-run plan with all services configured", async () => {
    const { stderr } = await runDryRun(
      `version: 1
project: test-project
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
  seed:
    command: "yarn demo-import --mongo-include=queuelogs --mongo-include=eventlogs"
    ttlSeconds: 3600
  tmux:
    session: graphite
    windows:
      - name: web-app
        cwd: web-app
        command: "yarn serve"
        readyOn:
          url: http://localhost:8080
      - name: web-api
        cwd: web-api
        command: "yarn dev-watch"
        readyOn:
          text: "listening on"
  teardown:
    - "tmux kill-session -t graphite"
    - "docker compose down"
`,
      `version: 1
name: test_spec
intent: Test dry-run.
outcomes:
  - id: out1
    description: A text appears
    verify: { text: "smoke" }
steps:
  - open: { path: "data:text/html,<h1>smoke</h1>", waitUntil: load }
  - wait: { text: smoke }
`,
    );

    expect(stderr).toContain("services dry-run plan:");
    expect(stderr).toContain("project: test-project");
    expect(stderr).toContain("docker: docker compose up -d");
    expect(stderr).toContain("reuseExisting: true");
    expect(stderr).toContain("seed: yarn demo-import");
    expect(stderr).toContain("ttlSeconds: 3600");
    expect(stderr).toContain("tmux: session=graphite, 2 windows");
    expect(stderr).toContain("teardown: 2 command(s)");
  });

  it("prints not-configured for missing phases", async () => {
    const { stderr } = await runDryRun(
      `version: 1
project: minimal
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
services:
  seed:
    command: "echo seeded"
    ttlSeconds: 0
`,
      `version: 1
name: test_spec
intent: Test dry-run.
outcomes:
  - id: out1
    description: A text appears
    verify: { text: "smoke" }
steps:
  - open: { path: "data:text/html,<h1>smoke</h1>", waitUntil: load }
  - wait: { text: smoke }
`,
    );

    expect(stderr).toContain("services dry-run plan:");
    expect(stderr).toContain("docker: (not configured)");
    expect(stderr).toContain("seed: echo seeded");
    expect(stderr).toContain("tmux: (not configured)");
    expect(stderr).toContain("teardown: (none)");
  });

  it("truncates long seed commands in the plan output", async () => {
    const longCmd = "yarn demo-import " + "--flag=value ".repeat(30);
    const { stderr } = await runDryRun(
      `version: 1
project: long-cmd
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
services:
  seed:
    command: "${longCmd}"
    ttlSeconds: 0
`,
      `version: 1
name: test_spec
intent: Test dry-run.
outcomes:
  - id: out1
    description: A text appears
    verify: { text: "smoke" }
steps:
  - open: { path: "data:text/html,<h1>smoke</h1>", waitUntil: load }
  - wait: { text: smoke }
`,
    );

    expect(stderr).toContain("seed: ");
    // The truncation should add "..." for commands over 80 chars
    expect(stderr).toContain("...");
  });
});

describe("tvault secrets injection", () => {
  const dirPromise = mkdtemp(join(tmpdir(), "cairntrace-tvault-run-"));

  beforeEach(() => {
    vi.mocked(getTvaultEnv).mockReset();
    delete process.env["TVAULT_SECRET_A"];
    delete process.env["TVAULT_SECRET_B"];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects tvault secrets into process.env for spec placeholders", async () => {
    vi.mocked(getTvaultEnv).mockResolvedValue({
      ok: true,
      env: {
        TVAULT_SECRET_A: "value-a",
        TVAULT_SECRET_B: "value-b",
      },
    });

    const dir = await dirPromise;
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  tvault:
    project: test-project
`,
    );
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: tvault_spec
intent: Use tvault secrets in spec placeholders.
outcomes:
  - id: secret_a_visible
    description: secret A is visible in page
    verify: { text: "value-a" }
steps:
  - open: { path: "data:text/html,<h1>value-a</h1>", waitUntil: load }
`,
    );

    await maybeInjectTvaultSecrets(join(dir, "spec.yml"), {
      services: false,
    } as RunCommandOptions);

    expect(process.env["TVAULT_SECRET_A"]).toBe("value-a");
    expect(process.env["TVAULT_SECRET_B"]).toBe("value-b");
    expect(getTvaultEnv).toHaveBeenCalledWith({ project: "test-project" });
  });

  it("throws when tvault project is missing required secrets", async () => {
    vi.mocked(getTvaultEnv).mockResolvedValue({
      ok: true,
      env: { TVAULT_SECRET_A: "value-a" },
    });

    const dir = await dirPromise;
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  tvault:
    project: test-project
  required: [TVAULT_SECRET_A, TVAULT_SECRET_B]
`,
    );
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: tvault_missing_spec
intent: Missing required secret should fail fast.
outcomes: []
steps: []
`,
    );

    await expect(
      maybeInjectTvaultSecrets(join(dir, "spec.yml"), {
        services: false,
      } as RunCommandOptions),
    ).rejects.toThrow(
      'tvault "test-project" is missing required secrets: TVAULT_SECRET_B',
    );
  });

  it("does nothing when no tvault secrets are configured", async () => {
    const dir = await dirPromise;
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
`,
    );
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: no_secrets
intent: No secrets configured.
outcomes: []
steps: []
`,
    );

    await maybeInjectTvaultSecrets(join(dir, "spec.yml"), {
      services: false,
    } as RunCommandOptions);

    expect(getTvaultEnv).not.toHaveBeenCalled();
  });

  it("injects tvault secrets from group/env inheritance mode", async () => {
    vi.mocked(getTvaultEnv).mockResolvedValue({
      ok: true,
      env: {
        TVAULT_SECRET_A: "value-a",
      },
    });

    const dir = await dirPromise;
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  tvault:
    group: myapp
    env: preview
`,
    );
    await writeFile(
      join(dir, "spec.yml"),
      `version: 1
name: tvault_group_spec
intent: Use tvault group/env secrets.
outcomes: []
steps: []
`,
    );

    await maybeInjectTvaultSecrets(join(dir, "spec.yml"), {
      services: false,
    } as RunCommandOptions);

    expect(process.env["TVAULT_SECRET_A"]).toBe("value-a");
    expect(getTvaultEnv).toHaveBeenCalledWith({
      group: "myapp",
      env: "preview",
    });
  });
});
