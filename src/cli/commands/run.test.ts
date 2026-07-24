import { execa } from "execa";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import { SelectionResultSchema } from "../../core/schema/selection.v1";
import { ContractHashMismatchError } from "../../core/parser/parseSpec";
import {
  buildSelectionResult,
  expandSpecArgs,
  maybeInjectTvaultSecrets,
  normalizeTagFilters,
  selectSpecsByBlastRadius,
  selectSpecsByTags,
  specMatchesTags,
  synthesizeErroredResult,
  type RunCommandOptions,
} from "./run";
import type { CodemapDeps } from "./annotate";

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

  it("populates canonical failure + summary on errored runs (feature 1)", () => {
    const result = synthesizeErroredResult(
      "/abs/spec.yml",
      new Error("Timeout 30000ms exceeded waiting for locator"),
    );
    RunResultSchema.parse(result);
    expect(result.summary).toBe(
      "errored at step 'parse': Timeout 30000ms exceeded waiting for locator",
    );
    expect(result.failure).toEqual({
      step: "parse",
      message: "Timeout 30000ms exceeded waiting for locator",
    });
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

  it("stamps optional labels onto errored results", () => {
    const result = synthesizeErroredResult("/abs/spec.yml", new Error("x"), {
      labels: { path: "rabbit", suite: "ab" },
    });
    expect(result.labels).toEqual({ path: "rabbit", suite: "ab" });
    expect(RunResultSchema.parse(result).labels).toEqual({
      path: "rabbit",
      suite: "ab",
    });
  });

  it("classifies a changed sealed contract with exit code 6 and a reseal action", () => {
    const path = "/x/changed.yml";
    const result = synthesizeErroredResult(
      path,
      new ContractHashMismatchError(
        `sha256:${"0".repeat(64)}`,
        `sha256:${"1".repeat(64)}`,
        path,
      ),
    );

    expect(RunResultSchema.parse(result)).toMatchObject({
      status: "errored",
      exitCode: 6,
      failure: {
        message: expect.stringContaining("contract changed since seal"),
      },
      nextActions: [
        {
          command: expect.stringContaining("cairn spec verify"),
          safeToAutoRun: false,
        },
      ],
    });
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

describe("tag selection (metadata.tags)", () => {
  it("normalizeTagFilters trims and drops empties", () => {
    expect(normalizeTagFilters(["  a ", "", "b"])).toEqual(["a", "b"]);
    expect(normalizeTagFilters(undefined)).toEqual([]);
  });

  it("specMatchesTags is case-insensitive AND", () => {
    expect(
      specMatchesTags(["checkout-regression", "temporal"], ["temporal"]),
    ).toBe(true);
    expect(
      specMatchesTags(["checkout-regression", "temporal"], ["TEMPORAL"]),
    ).toBe(true);
    expect(
      specMatchesTags(
        ["checkout-regression", "temporal"],
        ["temporal", "buyer-path"],
      ),
    ).toBe(false);
    expect(specMatchesTags([], ["temporal"])).toBe(false);
    expect(specMatchesTags(["x"], [])).toBe(true);
  });

  it("selectSpecsByTags keeps only matching specs with skip reasons", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-tags-"));
    const a = join(dir, "a.yml");
    const b = join(dir, "b.yml");
    const c = join(dir, "c.yml");
    await writeFile(
      a,
      `version: 1\nname: a\nintent: a\nmetadata:\n  tags: [answer-change, temporal]\noutcomes: [{id: o, verify: {text: {contains: x}}}]\n`,
    );
    await writeFile(
      b,
      `version: 1\nname: b\nintent: b\nmetadata:\n  tags: [table-import]\noutcomes: [{id: o, verify: {text: {contains: x}}}]\n`,
    );
    await writeFile(
      c,
      `version: 1\nname: c\nintent: c\noutcomes: [{id: o, verify: {text: {contains: x}}}]\n`,
    );

    const r = await selectSpecsByTags([a, b, c], ["answer-change"]);
    expect(r.selected).toEqual([a]);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped.map((s) => basename(s.path)).toSorted()).toEqual([
      "b.yml",
      "c.yml",
    ]);
    expect(r.skipped.find((s) => s.path === c)?.reason).toMatch(
      /no metadata\.tags/,
    );
    expect(r.skipped.find((s) => s.path === b)?.reason).toMatch(/missing tag/);
  });

  it("buildSelectionResult applies tag filter and lists tags on selected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-tags-sel-"));
    const a = join(dir, "hit.yml");
    const b = join(dir, "miss.yml");
    await writeFile(
      a,
      `version: 1\nname: hit\nintent: hit\nmetadata:\n  tags: [answer-change, checkout-regression]\noutcomes: [{id: o, verify: {text: {contains: x}}}]\n`,
    );
    await writeFile(
      b,
      `version: 1\nname: miss\nintent: miss\nmetadata:\n  tags: [other]\noutcomes: [{id: o, verify: {text: {contains: x}}}]\n`,
    );

    const result = await buildSelectionResult([a, b], undefined, undefined, [
      "answer-change",
    ]);
    expect(SelectionResultSchema.parse(result)).toMatchObject({
      tags: ["answer-change"],
      codemapAvailable: false,
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]!.name).toBe("hit");
    expect(result.selected[0]!.tags).toEqual(
      expect.arrayContaining(["answer-change", "checkout-regression"]),
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe("miss");
  });

  it("CLI --tag --select-only filters without launching a browser", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-tag-cli-"));
    await writeFile(
      join(dir, "yes.yml"),
      `version: 1\nname: yes_spec\nintent: yes\nmetadata:\n  tags: [answer-change]\noutcomes:\n  - id: o\n    verify:\n      text: { contains: x }\n`,
    );
    await writeFile(
      join(dir, "no.yml"),
      `version: 1\nname: no_spec\nintent: no\nmetadata:\n  tags: [tables]\noutcomes:\n  - id: o\n    verify:\n      text: { contains: x }\n`,
    );
    const binCairn = join(process.cwd(), "bin", "cairn");
    const result = await execa(binCairn, [
      "run",
      dir,
      "--tag",
      "answer-change",
      "--select-only",
      "--format",
      "json",
      "--mock",
    ]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      selected: { name: string }[];
      skipped: { name: string }[];
      tags: string[];
    };
    expect(body.tags).toEqual(["answer-change"]);
    // Selection names come from the file basename, not the YAML `name:` field.
    expect(body.selected.map((s) => s.name)).toEqual(["yes"]);
    expect(body.skipped.map((s) => s.name)).toEqual(["no"]);
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
      "--artifact-root",
      join(dir, "runs"),
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
    session: sample-app
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
    - "tmux kill-session -t sample-app"
    - "docker compose down"
`,
      `version: 1
name: test_spec
intent: Test dry-run.
outcomes:
  - id: out1
    description: The mock console stays clean
    verify: { console: { errorsMax: 0 } }
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
    expect(stderr).toContain("tmux: session=sample-app, 2 windows");
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
    description: The mock console stays clean
    verify: { console: { errorsMax: 0 } }
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
    description: The mock console stays clean
    verify: { console: { errorsMax: 0 } }
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

describe("runHookCommands", () => {
  it("runs before hooks and fails fatal on non-zero exit", async () => {
    const { runHookCommands } = await import("./run");
    await expect(
      runHookCommands("before", ["exit 0", "exit 3"]),
    ).rejects.toThrow(/before hook failed \(exit 3\)/);
  });

  it("after hooks non-fatal do not throw", async () => {
    const { runHookCommands } = await import("./run");
    await expect(
      runHookCommands("after", ["exit 7"], { fatal: false }),
    ).resolves.toBeUndefined();
  });

  it("no-ops on empty/undefined", async () => {
    const { runHookCommands } = await import("./run");
    await expect(runHookCommands("before", undefined)).resolves.toBeUndefined();
    await expect(runHookCommands("before", ["  "])).resolves.toBeUndefined();
  });
});

describe("run --before CLI", () => {
  it("runs --before after services and before the spec (single path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-before-"));
    const artifactRoot = join(dir, "runs");
    const marker = join(dir, "before.ok");
    const specPath = join(dir, "hook.yml");
    await writeFile(
      specPath,
      `version: 1
name: before_hook_smoke
intent: --before must run once before the mock spec.
coldStart: guest
outcomes:
  - id: ok
    description: url always matches
    verify: { url: { matches: ".*" } }
steps:
  - open: { path: "data:text/html,<h1>x</h1>", waitUntil: load }
`,
    );

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        specPath,
        "--mock",
        "--no-services",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--before",
        `touch "${marker}"`,
        "--json",
      ],
      { cwd: dir, reject: false, timeout: 15_000 },
    );
    expect(result.exitCode).toBe(0);
    const { access } = await import("node:fs/promises");
    await expect(access(marker)).resolves.toBeUndefined();
  });

  it("aborts when --before exits non-zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-before-fail-"));
    const specPath = join(dir, "hook.yml");
    await writeFile(
      specPath,
      `version: 1
name: before_hook_fail
intent: failing before must not run the spec.
coldStart: guest
outcomes:
  - id: ok
    description: never reached
    verify: { url: { matches: ".*" } }
steps:
  - open: { path: "data:text/html,<h1>x</h1>", waitUntil: load }
`,
    );

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        specPath,
        "--mock",
        "--no-services",
        "--no-web-server",
        "--artifact-root",
        join(dir, "runs"),
        "--before",
        "exit 9",
        "--json",
      ],
      { cwd: dir, reject: false, timeout: 15_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/before hook failed/);
  });
});

describe("run --label (batch path)", () => {
  it("stamps the same labels on every spec in a multi-spec run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-label-batch-"));
    const artifactRoot = join(dir, "runs");
    for (const name of ["a", "b"] as const) {
      await writeFile(
        join(dir, `${name}.yml`),
        `version: 1
name: label_batch_${name}
intent: Batch path must stamp labels too.
coldStart: guest
outcomes:
  - id: ok
    description: url always matches
    verify: { url: { matches: ".*" } }
steps:
  - open: { path: "data:text/html,<h1>x</h1>", waitUntil: load }
`,
      );
    }

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        join(dir, "a.yml"),
        join(dir, "b.yml"),
        "--mock",
        "--no-services",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--label",
        "path=rabbit",
        "--label",
        "suite=batch",
        "--json",
      ],
      { cwd: dir, reject: false, timeout: 20_000 },
    );
    expect(result.exitCode).toBe(0);
    const batch = JSON.parse(result.stdout) as {
      results: Array<{ labels?: Record<string, string>; runDir: string }>;
    };
    expect(batch.results).toHaveLength(2);
    for (const r of batch.results) {
      expect(r.labels).toEqual({ path: "rabbit", suite: "batch" });
      const onDisk = JSON.parse(
        await readFile(join(r.runDir, "run.json"), "utf8"),
      ) as { labels?: Record<string, string> };
      expect(onDisk.labels).toEqual({ path: "rabbit", suite: "batch" });
    }
  });
});

describe("run --label (single-spec path)", () => {
  it("stamps labels into run.json and stdout RunResult", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-label-"));
    const artifactRoot = join(dir, "runs");
    const specPath = join(dir, "label.yml");
    await writeFile(
      specPath,
      `version: 1
name: label_single
intent: Stamp cohort labels on a single-spec mock run.
coldStart: guest
outcomes:
  - id: ok
    description: url always matches
    verify: { url: { matches: ".*" } }
steps:
  - open: { path: "data:text/html,<h1>x</h1>", waitUntil: load }
`,
    );

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        specPath,
        "--mock",
        "--no-services",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--label",
        "path=temporal",
        "--label",
        "suite=ab",
        "--json",
      ],
      { cwd: dir, reject: false, timeout: 15_000 },
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      labels?: Record<string, string>;
      runDir: string;
    };
    expect(body.labels).toEqual({ path: "temporal", suite: "ab" });
    const onDisk = JSON.parse(
      await readFile(join(body.runDir, "run.json"), "utf8"),
    ) as { labels?: Record<string, string> };
    expect(onDisk.labels).toEqual({ path: "temporal", suite: "ab" });
  });
});

describe("run JSON stdout routing (end-to-end via CLI)", () => {
  it("keeps web-server warning and log tail on stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-json-stderr-"));
    const artifactRoot = join(dir, "runs");
    const configPath = join(dir, "cairntrace.config.yml");
    const specPath = join(dir, "failing.yml");
    const marker = "CAIRN_JSON_STDERR_WEB_SERVER_MARKER";
    const serverScript = `console.error(${JSON.stringify(marker)}); setInterval(() => {}, 1000);`;
    const serverCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(serverScript)}`;
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: test
environments:
  test: {}
artifactRoot: ${JSON.stringify(artifactRoot)}
webServer:
  command: ${JSON.stringify(serverCommand)}
  waitForText: ${JSON.stringify(marker)}
  reuseExisting: false
  readyTimeoutMs: 5000
`,
    );
    await writeFile(
      specPath,
      `version: 1
name: json_stderr_failure
intent: A deliberately failing mock run exercises web-server diagnostics.
outcomes:
  - id: missing_text
    description: Deliberately absent text is visible.
    verify: { text: { contains: "definitely-not-present" } }
steps: []
`,
    );

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "--log-level",
        "info",
        "run",
        specPath,
        "--config",
        configPath,
        "--mock",
        "--json",
      ],
      { cwd: dir, reject: false, timeout: 15_000 },
    );

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "failed",
      exitCode: 1,
    });
    expect(result.stdout).not.toContain("web server log");
    expect(result.stdout).not.toContain(marker);
    expect(result.stderr).toContain("web server log (last 80 lines");
    expect(result.stderr).toContain(marker);
    expect(result.exitCode).toBe(1);
  });

  it("flushes a large batch JSON document before exiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-json-flush-"));
    const configPath = join(dir, "cairntrace.config.yml");
    const specPath = join(dir, "large_batch.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local: {}
retention: { enabled: false }
`,
    );
    await writeFile(
      specPath,
      `version: 1
name: json_flush_${"long_name_segment_".repeat(4)}
intent: A large batch result must drain fully before the CLI exits.
outcomes:
  - id: clean_console_${"long_outcome_segment_".repeat(3)}
    description: The mock console stays clean while producing a large result envelope.
    verify: { console: { errorsMax: 0 } }
steps: []
`,
    );
    const repeatedSpecs = Array.from({ length: 96 }, () => specPath);

    const result = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        ...repeatedSpecs,
        "--parallel",
        "16",
        "--mock",
        "--no-web-server",
        "--config",
        configPath,
        "--artifact-root",
        join(dir, "runs"),
        "--json",
      ],
      { reject: false, timeout: 15_000 },
    );

    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    const parsed = BatchRunResultSchema.parse(JSON.parse(result.stdout));
    expect(parsed.summary).toEqual({
      total: repeatedSpecs.length,
      passed: repeatedSpecs.length,
      failed: 0,
      errored: 0,
    });
    expect(parsed.results).toHaveLength(repeatedSpecs.length);
    expect(result.exitCode).toBe(0);
  });
});

describe("run stable exit codes (end-to-end via CLI)", () => {
  it("returns 6 for a contract mismatch in both single and batch JSON runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-contract-exit-"));
    const makeSpec = async (name: string): Promise<string> => {
      const path = join(dir, `${name}.yml`);
      await writeFile(
        path,
        `version: 1
name: ${name}
intent: The stamped contract no longer matches.
contractHash: sha256:${"0".repeat(64)}
outcomes:
  - id: ok
    description: no console errors
    verify: { console: { errorsMax: 0 } }
steps: []
`,
      );
      return path;
    };
    const first = await makeSpec("contract_one");
    const second = await makeSpec("contract_two");
    const bin = join(process.cwd(), "bin", "cairn");

    const single = await execa(
      bin,
      ["run", first, "--mock", "--no-web-server", "--json"],
      { reject: false },
    );
    expect(single.exitCode).toBe(6);
    expect(JSON.parse(single.stdout)).toMatchObject({
      status: "errored",
      exitCode: 6,
      failure: {
        message: expect.stringContaining("contract changed since seal"),
      },
    });

    const batch = await execa(
      bin,
      ["run", first, second, "--mock", "--no-web-server", "--json"],
      { reject: false },
    );
    expect(batch.exitCode).toBe(6);
    expect(JSON.parse(batch.stdout)).toMatchObject({
      exitCode: 6,
      summary: { total: 2, errored: 2 },
      results: [{ exitCode: 6 }, { exitCode: 6 }],
    });
  });

  it("writes an aborted batch summary and preserves completed reports on SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-abort-"));
    const artifactRoot = join(dir, "runs");
    const first = join(dir, "abort_first.yml");
    const slow = join(dir, "abort_slow.yml");
    await writeFile(
      first,
      `version: 1
name: abort_first
intent: finish before the interrupted spec
outcomes:
  - id: ok
    description: mock console is clean
    verify: { console: { errorsMax: 0 } }
steps: []
`,
    );
    await writeFile(
      slow,
      `version: 1
name: abort_slow
intent: remain in flight long enough to receive SIGTERM
outcomes:
  - id: never
    description: wait for a file that is deliberately absent
    verify:
      file: { glob: ./never-created.txt, timeoutMs: 30000 }
steps: []
`,
    );

    const running = execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        first,
        slow,
        "--parallel",
        "1",
        "--mock",
        "--no-web-server",
        "--artifact-root",
        artifactRoot,
        "--json",
      ],
      { reject: false },
    );

    const completedRunDir = await waitForCompletedRun(
      artifactRoot,
      "abort_first",
    );
    // The next run directory is created only after runPool observed the
    // first result, which is the point runBatch records completedByIndex.
    await waitForRunDir(artifactRoot, "abort_slow");
    running.kill("SIGTERM");
    const terminated = await running;

    expect(terminated.exitCode).toBe(143);
    const entries = await readdir(artifactRoot);
    const abortedFile = entries.find(
      (entry) => entry.startsWith("aborted-") && entry.endsWith(".json"),
    );
    expect(abortedFile).toBeDefined();
    const summary = JSON.parse(
      await readFile(join(artifactRoot, abortedFile!), "utf8"),
    );
    expect(summary).toMatchObject({
      aborted: true,
      signal: "SIGTERM",
      requestedTotal: 2,
      pending: 1,
      completed: [{ spec: { name: "abort_first" }, status: "passed" }],
    });
    expect(
      JSON.parse(await readFile(join(completedRunDir, "report.json"), "utf8")),
    ).toMatchObject({ run: { status: "passed" } });
    expect(terminated.stderr).toContain("wrote aborted batch summary");
  }, 10_000);
});

describe("run failure automation (file.cheap)", () => {
  it("consumes stash + investigate config and reuses one validated stash receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-run-automation-"));
    const runsRoot = join(dir, "runs");
    const codebase = join(dir, "codebase");
    const binDir = join(dir, "bin");
    const specPath = join(dir, "failing.yml");
    const configPath = join(dir, "cairntrace.config.yml");
    const argsPath = join(dir, "fcheap-args.txt");
    await mkdir(codebase, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      specPath,
      `version: 1
name: failure_automation
intent: failed runs trigger configured local investigation
coldStart: guest
outcomes:
  - id: fails
    description: deliberately missing text
    verify: { text: { contains: "never-present" } }
steps:
  - open: /
`,
    );
    await writeFile(
      configPath,
      `version: 1
environments: {}
artifactRoot: ${JSON.stringify(runsRoot)}
retention:
  enabled: false
stash:
  enabled: true
  autoStash: on-failure
  tags: [automation]
investigate:
  codebaseDir: ./codebase
  mode: keyword
  limit: 3
  index: true
  autoInvestigate: on-failure
`,
    );
    const fakeFcheap = join(binDir, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FCHEAP_ARGS_FILE"
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap 0.30.0'
  exit 0
fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"stash-automation","status":"saved"}'
  exit 0
fi
if [ "$1" = "connect" ]; then
  printf '%s\\n' '{"stash_id":"stash-automation","codebase":"${codebase}","query":"failure","matches":[{"stash_id":"stash-automation","file":"src/failure.ts","line":9,"score":0.8,"text":"failure path"}]}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);
    const fakeCodemap = join(binDir, "codemap");
    await writeFile(fakeCodemap, "#!/bin/sh\nexit 1\n");
    await chmod(fakeCodemap, 0o755);

    const command = await execa(
      join(process.cwd(), "bin", "cairn"),
      [
        "run",
        specPath,
        "--mock",
        "--no-web-server",
        "--config",
        configPath,
        "--json",
      ],
      {
        reject: false,
        env: {
          ...process.env,
          FCHEAP_BIN: fakeFcheap,
          FCHEAP_ARGS_FILE: argsPath,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(command.exitCode).toBe(1);
    const run = RunResultSchema.parse(JSON.parse(command.stdout));
    const calls = (await readFile(argsPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(calls.filter((call) => call.startsWith("save "))).toHaveLength(1);
    expect(calls).toContain(
      `connect stash-automation ${codebase} --json --mode keyword --limit 3 --index`,
    );
    expect(
      JSON.parse(await readFile(join(run.runDir, "investigate.json"), "utf8")),
    ).toMatchObject({
      stashId: "stash-automation",
      codeMatches: [{ file: "src/failure.ts", line: 9, score: 0.8 }],
    });
    await rm(dir, { recursive: true, force: true });
  });
});

async function waitForCompletedRun(
  artifactRoot: string,
  specName: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes(`_${specName}_`)) {
        continue;
      }
      const runDir = join(artifactRoot, entry.name);
      const report = await readFile(join(runDir, "report.json"), "utf8").catch(
        () => undefined,
      );
      if (report) return runDir;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for completed ${specName} run`);
}

async function waitForRunDir(
  artifactRoot: string,
  specName: string,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(
      () => [],
    );
    const match = entries.find(
      (entry) => entry.isDirectory() && entry.name.includes(`_${specName}_`),
    );
    if (match) return join(artifactRoot, match.name);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for in-flight ${specName} run`);
}

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

/* ---------------------------------------------------------------------------
 * selectSpecsByBlastRadius — `cairn run --since-codemap <ref>` (FEATURES item 1)
 *
 * Intersects `codemap review --since <ref>` blast-radius file paths against
 * each spec's `coversSymbol` code-match provenance. A fake codemap verifies
 * selection without codemap on $PATH; the codemap-absent path degrades to
 * run-all (no crash).
 * ------------------------------------------------------------------------- */

async function writeSpecs(
  dir: string,
  specs: Record<string, string | undefined>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const [name, coversSymbol] of Object.entries(specs)) {
    const p = join(dir, `${name}.yml`);
    const yaml =
      `version: 1\nname: ${name}\nintent: t\noutcomes:\n  - id: o\n    description: o\n    verify: { text: x }\n` +
      (coversSymbol ? `coversSymbol: ${coversSymbol}\n` : "");
    await writeFile(p, yaml);
    paths.push(p);
  }
  return paths;
}

/** Fake codemap: review blast radius hits handler.ts; semantic resolves symbols. */
function fakeReviewCodemap(symbolFiles: Record<string, string>): CodemapDeps {
  const review = {
    indexed: true,
    stale: false,
    changed_files: [{ path: "src/forms/handler.ts" }],
    blast_radius: [
      { symbol: "handleSubmit", file: "src/forms/handler.ts" },
      { symbol: "validateEmail", file: "src/forms/validate.ts" },
    ],
  };
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "review")
        return { exitCode: 0, stdout: JSON.stringify(review), stderr: "" };
      if (args[0] === "semantic" || args[0] === "find") {
        const sym = args[1] ?? "";
        const file = symbolFiles[sym];
        return {
          exitCode: 0,
          stdout: file ? JSON.stringify([{ symbol: sym, file }]) : "[]",
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unknown" };
    },
  };
}

const unavailableCodemap: CodemapDeps = {
  isAvailable: async () => false,
  exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
};

describe("selectSpecsByBlastRadius (feature 1)", () => {
  it("selects only specs whose coversSymbol is in the blast radius", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-since-"));
    const paths = await writeSpecs(dir, {
      form_submit: "handleSubmit",
      email_check: "validateEmail",
      unrelated: "apiPost",
      uncovered: undefined,
    });
    const selected = await selectSpecsByBlastRadius(
      paths,
      "HEAD~1",
      fakeReviewCodemap({ handleSubmit: "src/forms/handler.ts" }),
    );
    // handleSubmit + validateEmail are named in the blast radius; apiPost and
    // the uncovered spec are not.
    expect(selected.map((p) => basename(p)).toSorted()).toEqual(
      ["email_check.yml", "form_submit.yml"].toSorted(),
    );
  });
  it("selects a spec whose coversSymbol resolves to a blast-radius file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-since-file-"));
    const paths = await writeSpecs(dir, { handler_spec: "handleSubmit" });
    // handleSubmit is NOT in the blast-radius symbol set here, but semantic
    // resolves it to handler.ts which IS a blast-radius file.
    const deps = {
      ...fakeReviewCodemap({ handleSubmit: "src/forms/handler.ts" }),
    };
    // Override review so blast_radius has only the file, not the symbol.
    const reviewFileOnly = {
      indexed: true,
      stale: false,
      changed_files: [{ path: "src/forms/handler.ts" }],
      blast_radius: [{ symbol: "someOtherSym", file: "src/forms/handler.ts" }],
    };
    deps.exec = async (args) =>
      args[0] === "review"
        ? { exitCode: 0, stdout: JSON.stringify(reviewFileOnly), stderr: "" }
        : fakeReviewCodemap({ handleSubmit: "src/forms/handler.ts" }).exec(
            args,
          );
    const selected = await selectSpecsByBlastRadius(paths, "HEAD~1", deps);
    expect(selected).toHaveLength(1);
  });

  it("selects ~0 specs for a one-line CSS edit (empty blast radius)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-since-css-"));
    const paths = await writeSpecs(dir, {
      form_submit: "handleSubmit",
      email_check: "validateEmail",
    });
    const cssEditReview = {
      indexed: true,
      stale: false,
      changed_files: [{ path: "src/styles/main.css" }],
      blast_radius: [],
    };
    const deps: CodemapDeps = {
      isAvailable: async () => true,
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(cssEditReview),
        stderr: "",
      }),
    };
    const selected = await selectSpecsByBlastRadius(paths, "HEAD~1", deps);
    expect(selected).toEqual([]);
  });

  it("degrades to run-all when codemap is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-since-absent-"));
    const paths = await writeSpecs(dir, {
      form_submit: "handleSubmit",
      email_check: "validateEmail",
    });
    const selected = await selectSpecsByBlastRadius(
      paths,
      "HEAD~1",
      unavailableCodemap,
    );
    expect(selected).toEqual(paths);
  });

  it("degrades to run-all when since is blank", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-since-blank-"));
    const paths = await writeSpecs(dir, { form_submit: "handleSubmit" });
    const selected = await selectSpecsByBlastRadius(
      paths,
      "",
      unavailableCodemap,
    );
    expect(selected).toEqual(paths);
  });

  it("returns empty input unchanged", async () => {
    expect(
      await selectSpecsByBlastRadius([], "HEAD~1", unavailableCodemap),
    ).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * buildSelectionResult — `cairn run --since-codemap <ref> --select-only --json`
 * (FEATURES item 2): resolves which specs WOULD run and emits a
 * SelectionResult v1 envelope without launching a browser.
 * ------------------------------------------------------------------------- */

describe("buildSelectionResult (feature 2)", () => {
  it("lists all expanded specs as selected when no ref is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-select-none-"));
    const paths = await writeSpecs(dir, {
      form_submit: "handleSubmit",
      uncovered: undefined,
    });
    const result = await buildSelectionResult(
      paths,
      undefined,
      unavailableCodemap,
    );
    SelectionResultSchema.parse(result);
    expect(result.codemapAvailable).toBe(false);
    expect(result.since).toBeUndefined();
    expect(result.selected).toHaveLength(2);
    expect(result.selected[0]!.name).toBe("form_submit");
    expect(result.selected[0]!.coversSymbol).toBe("handleSubmit");
    expect(result.selected[1]!.coversSymbol).toBeUndefined();
    expect(result.skipped).toEqual([]);
  });

  it("degrades to run-all (selected) when codemap is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-select-absent-"));
    const paths = await writeSpecs(dir, { form_submit: "handleSubmit" });
    const result = await buildSelectionResult(
      paths,
      "HEAD~1",
      unavailableCodemap,
    );
    SelectionResultSchema.parse(result);
    expect(result.since).toBe("HEAD~1");
    expect(result.codemapAvailable).toBe(false);
    expect(result.selected).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("selects blast-radius specs and skips the rest with reasons", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-select-blast-"));
    const paths = await writeSpecs(dir, {
      form_submit: "handleSubmit",
      unrelated: "apiPost",
      uncovered: undefined,
    });
    const result = await buildSelectionResult(
      paths,
      "HEAD~1",
      fakeReviewCodemap({ handleSubmit: "src/forms/handler.ts" }),
    );
    SelectionResultSchema.parse(result);
    expect(result.codemapAvailable).toBe(true);
    expect(result.since).toBe("HEAD~1");
    expect(result.selected.map((s) => s.name).toSorted()).toEqual([
      "form_submit",
    ]);
    expect(result.selected[0]!.coversSymbol).toBe("handleSubmit");
    const skippedByName = Object.fromEntries(
      result.skipped.map((s) => [s.name, s.reason]),
    );
    expect(skippedByName["uncovered"]).toBe("no coversSymbol binding");
    expect(skippedByName["unrelated"]).toContain("outside blast radius");
  });

  it("skips every spec for an empty blast radius (CSS edit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-select-css-"));
    const paths = await writeSpecs(dir, {
      form_submit: "handleSubmit",
      email_check: "validateEmail",
    });
    const cssEditReview = {
      indexed: true,
      stale: false,
      changed_files: [{ path: "src/styles/main.css" }],
      blast_radius: [],
    };
    const deps: CodemapDeps = {
      isAvailable: async () => true,
      exec: async () => ({
        exitCode: 0,
        stdout: JSON.stringify(cssEditReview),
        stderr: "",
      }),
    };
    const result = await buildSelectionResult(paths, "HEAD~1", deps);
    SelectionResultSchema.parse(result);
    expect(result.codemapAvailable).toBe(true);
    expect(result.selected).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.reason.includes("no symbols"))).toBe(
      true,
    );
  });
});
