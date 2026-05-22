import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { RunResult } from "../schema/run.v1";
import { runSpec } from "./Runner";

let workDir: string;
let artifactRoot: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cairntrace-runner-"));
  artifactRoot = join(workDir, ".cairntrace", "runs");
});

afterAll(async () => {
  // best-effort cleanup; tmp is fine to leak in tests
});

async function writeSpec(name: string, body: string): Promise<string> {
  const p = join(workDir, `${name}.yml`);
  await writeFile(p, body);
  return p;
}

describe("runSpec e2e (mock backend)", () => {
  it("produces a complete run dir with passing outcomes", async () => {
    const specPath = await writeSpec(
      "happy",
      `version: 1
name: happy
intent: smoke test happy path
environment: local
outcomes:
  - id: dashboard_url
    description: url is correct after navigate
    verify:
      url: { endsWith: "/dashboard" }
  - id: no_console_errors
    description: console must be clean
    verify:
      console: { errorsMax: 0 }
steps:
  - id: nav
    open: /dashboard
`,
    );

    const backend = new MockBrowserBackend();
    backend.setUrl("/dashboard"); // initial value before any step runs

    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.status === "passed")).toBe(true);

    // Inspect the run dir
    const runJson = JSON.parse(
      await readFile(join(result.runDir, "run.json"), "utf8"),
    ) as RunResult;
    expect(runJson.spec.name).toBe("happy");
    expect(runJson.status).toBe("passed");

    const runYaml = await readFile(join(result.runDir, "run.yaml"), "utf8");
    expect(runYaml).toContain("name: happy");

    const runMd = await readFile(join(result.runDir, "run.md"), "utf8");
    expect(runMd).toContain("# Run: happy");
    expect(runMd).toContain("PASSED");

    const ctx = await readFile(join(result.runDir, "agent_context.md"), "utf8");
    expect(ctx).toContain("# Cairntrace Run Context");
    expect(ctx).toContain("smoke test happy path");

    // outcomes/results.*
    const outcomesJson = JSON.parse(
      await readFile(join(result.runDir, "outcomes/results.json"), "utf8"),
    );
    expect(outcomesJson.outcomes).toHaveLength(2);

    // each outcome evidence file exists and matches §13b shape
    for (const o of result.outcomes) {
      const text = await readFile(join(result.runDir, o.evidence!), "utf8");
      expect(text.startsWith(`# Outcome: ${o.id}`)).toBe(true);
      expect(text).toContain("## Expected");
      expect(text).toContain("## Actual");
      expect(text).toContain("## Source");
      const lines = text.split("\n");
      expect(lines.length).toBeLessThanOrEqual(80);
    }

    const events = (
      await readFile(join(result.runDir, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "run.started")).toBe(true);
    expect(events.some((e) => e.type === "run.passed")).toBe(true);

    // spec.resolved.yml exists
    const resolved = await stat(join(result.runDir, "spec.resolved.yml"));
    expect(resolved.isFile()).toBe(true);
  });

  it("returns failed status when an outcome doesn't hold", async () => {
    const specPath = await writeSpec(
      "fails",
      `version: 1
name: fails_one_outcome
intent: ensure failed outcomes mark the run failed
outcomes:
  - id: url_mismatch
    description: this outcome won't be met
    verify:
      url: { equals: "https://example.com/never" }
steps:
  - id: nav
    open: /somewhere-else
`,
    );

    const backend = new MockBrowserBackend();
    backend.setUrl("/somewhere-else");

    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.outcomes[0]!.status).toBe("failed");
  });

  it("captures downloads as named run artifacts", async () => {
    const specPath = await writeSpec(
      "download",
      `version: 1
name: download_demo
intent: capture a downloaded template
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: template
    download:
      by: role
      role: button
      name: Download template
      saveAs: template.xlsx
      assign: template
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.artifacts.downloads).toEqual({
      template: "downloads/template.xlsx",
    });
    expect(result.steps[0]!.artifacts).toContain("downloads/template.xlsx");
    const downloaded = await readFile(
      join(result.runDir, "downloads/template.xlsx"),
      "utf8",
    );
    expect(downloaded).toContain("mock download");
    expect(backend.stepLog[0]).toMatchObject({
      download: {
        by: "role",
        role: "button",
        name: "Download template",
        saveAs: join(result.runDir, "downloads/template.xlsx"),
      },
    });
  });

  it("runs hover steps as first-class interactions", async () => {
    const specPath = await writeSpec(
      "hover",
      `version: 1
name: hover_demo
intent: reveal table controls before continuing
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: reveal_header_actions
    hover:
      by: selector
      selector: ".question-table-wrap .table-title"
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.stepLog[0]).toMatchObject({
      hover: {
        by: "selector",
        selector: ".question-table-wrap .table-title",
      },
    });
  });

  it("resolves config vars before parsing schema-required step fields", async () => {
    await writeFile(
      join(workDir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
    vars:
      connectionPath: /connection/abc
`,
    );
    const specPath = await writeSpec(
      "config_var_open",
      `version: 1
name: config_var_open
intent: config vars can supply required open values
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: nav
    open: "\${vars.connectionPath}"
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.stepLog[0]).toMatchObject({
      open: "http://localhost:8080/connection/abc",
    });
  });

  it("exposes downloaded artifacts and external script files to script verifiers", async () => {
    await writeFile(
      join(workDir, "download-check.js"),
      `return {
  ok: Boolean(artifacts.template && fixtures.templatePath === artifacts.template.path),
  evidence: { templatePath: fixtures.templatePath, relativePath: artifacts.template.relativePath }
};`,
    );
    const specPath = await writeSpec(
      "download_script_file",
      `version: 1
name: download_script_file
intent: external verifier files can inspect named artifacts
outcomes:
  - id: script_can_see_artifact
    description: script verifier can see the downloaded artifact
    verify:
      script:
        file: ./download-check.js
        fixtures:
          templatePath: "\${artifacts.template.path}"
steps:
  - id: template
    download:
      by: role
      role: button
      name: Download template
      saveAs: template.xlsx
      assign: template
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueScriptResult({
      ok: true,
      evidence: { checked: true },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.lastEvaluatedScript).toContain("templatePath");
    expect(backend.lastEvaluatedScript).toContain("const artifacts = ");
    expect(backend.lastEvaluatedScript).toContain(
      join(result.runDir, "downloads/template.xlsx"),
    );
  });

  it("stops on step failure and surfaces the error in the step result", async () => {
    const specPath = await writeSpec(
      "step_fail",
      `version: 1
name: step_fail
intent: step failure should short-circuit and not run later steps
outcomes:
  - id: dummy
    description: dummy
    verify:
      console: { errorsMax: 0 }
steps:
  - id: bad
    click:
      by: role
      role: button
      name: Submit
  - id: never_runs
    open: /unreachable
`,
    );

    const backend = new MockBrowserBackend();
    backend.failNextStep("selector 'button[name=Submit]' not found");

    const result = await runSpec({ specPath, backend, artifactRoot });

    // First step failed → run is failed
    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[0]!.error).toContain("selector");
    expect(result.artifacts.diagnostics?.[0]).toMatch(
      /^diagnostics\/001_bad\.json$/,
    );
    const diagnostics = await readFile(
      join(result.runDir, result.artifacts.diagnostics![0]!),
      "utf8",
    );
    expect(diagnostics).toContain("Submit");
  });

  it("includes hover selectors in failed-step diagnostics", async () => {
    const specPath = await writeSpec(
      "hover_fail",
      `version: 1
name: hover_fail
intent: hover failure should capture selector diagnostics
outcomes:
  - id: dummy
    description: dummy
    verify:
      console: { errorsMax: 0 }
steps:
  - id: reveal_header_actions
    hover:
      by: selector
      selector: ".question-table-wrap .table-title"
`,
    );

    const backend = new MockBrowserBackend();
    backend.failNextStep("hover target not found");

    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.artifacts.diagnostics?.[0]).toMatch(
      /^diagnostics\/001_reveal_header_actions\.json$/,
    );
    expect(backend.lastEvaluatedScript).toContain('"kind":"hover"');
    expect(backend.lastEvaluatedScript).toContain(
      ".question-table-wrap .table-title",
    );
  });

  it("--cold-start wipes browser state before steps", async () => {
    const specPath = await writeSpec(
      "cold",
      `version: 1
name: cold_start_demo
intent: prove the cold-start gate fires
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: nav
    open: /home
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
      coldStart: true,
    });

    expect(result.coldStart).toBe(true);
    expect(backend.clearBrowserStateCalls).toBe(1);
  });

  it("cold-start defaults to off without CI=true", async () => {
    const specPath = await writeSpec(
      "default",
      `version: 1
name: default_demo
intent: cold-start should default to off
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: nav
    open: /
`,
    );
    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.coldStart).toBe(false);
    expect(backend.clearBrowserStateCalls).toBe(0);
  });
});
