import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { RunResult } from "../schema/run.v1";
import { DEFAULT_REQUEST_TIMEOUT_MS, runSpec } from "./Runner";
import {
  cutClipsWithVidtrace,
  isVidtraceAvailable,
  moveClipsIntoRunDir,
} from "../clip/vidtraceClip";

vi.mock("../clip/vidtraceClip", () => ({
  isVidtraceAvailable: vi
    .fn()
    .mockResolvedValue({ available: false, version: "" }),
  cutClipsWithVidtrace: vi
    .fn()
    .mockResolvedValue({ ok: false, outputDir: "", clips: [] }),
  moveClipsIntoRunDir: vi.fn().mockResolvedValue({}),
  clipPointsToLabels: vi.fn().mockImplementation((points) =>
    points.map((p: { label: string; start: string; end: string }) => ({
      label: p.label,
      start: p.start,
      end: p.end,
    })),
  ),
}));

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

async function writeSpecIn(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const p = join(dir, `${name}.yml`);
  await writeFile(p, body);
  return p;
}

function withoutNativeRequest(backend: MockBrowserBackend): BrowserBackend {
  return new Proxy(backend, {
    get(target, prop) {
      if (prop === "request") return undefined;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as BrowserBackend;
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
    expect(runJson.artifacts.report).toBe("report.html");
    expect(runJson.artifacts.reportJson).toBe("report.json");

    const runYaml = await readFile(join(result.runDir, "run.yaml"), "utf8");
    expect(runYaml).toContain("name: happy");

    const runMd = await readFile(join(result.runDir, "run.md"), "utf8");
    expect(runMd).toContain("# Run: happy");
    expect(runMd).toContain("PASSED");

    const reportJson = JSON.parse(
      await readFile(join(result.runDir, "report.json"), "utf8"),
    );
    expect(reportJson.summary.outcomes.passed).toBe(2);
    expect(reportJson.theme.selected).toBe("cairn");
    expect(reportJson.theme.available.midnight.label).toBe("Midnight");

    const reportHtml = await readFile(
      join(result.runDir, "report.html"),
      "utf8",
    );
    expect(reportHtml).toContain("Cairntrace Report");
    expect(reportHtml).toContain("Print / Save PDF");

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

  it("dispatches a batch step as a single composite interaction", async () => {
    const specPath = await writeSpec(
      "batch",
      `version: 1
name: batch_demo
intent: hover then click the revealed popover in one invocation
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: open_import_modal
    batch:
      - hover: { by: selector, selector: "#subcontractor-table" }
      - click: { by: selector, selector: ".hover-actions button" }
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.id).toBe("open_import_modal");
    // The whole batch is one dispatched step, not expanded into N steps.
    expect(backend.stepLog).toHaveLength(1);
    expect(backend.stepLog[0]).toMatchObject({
      batch: [
        { hover: { by: "selector", selector: "#subcontractor-table" } },
        { click: { by: "selector", selector: ".hover-actions button" } },
      ],
    });
  });

  it("fails the run when a batch step fails, with batch diagnostics", async () => {
    const specPath = await writeSpec(
      "batch_fail",
      `version: 1
name: batch_fail
intent: a failing batch step fails the run
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: chain
    batch:
      - hover: { by: selector, selector: "#row" }
      - click: { by: selector, selector: "#missing" }
`,
    );

    const backend = new MockBrowserBackend();
    backend.failNextStep("batch failed at sub-step #2 (click #missing)");

    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[0]!.error).toContain("sub-step #2");
    // A failed batch still writes a diagnostics artifact for the step.
    expect(result.artifacts.diagnostics?.[0]).toMatch(
      /^diagnostics\/001_chain/,
    );
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

  it("transforms a downloaded artifact and resolves it for upload", async () => {
    await writeFile(
      join(workDir, "make-invalid-template.ts"),
      `import { copyFile, appendFile } from "node:fs/promises";

export default async function transform(ctx) {
  await copyFile(ctx.input, ctx.output.path);
  await appendFile(ctx.output.path, "\\ninvalid row");
  return { ok: true, evidence: { output: ctx.output.relativePath } };
}
`,
    );
    const specPath = await writeSpec(
      "transform_upload",
      `version: 1
name: transform_upload
intent: transform a downloaded template into an upload fixture
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
  - id: invalid_template
    transform:
      runtime: node
      file: ./make-invalid-template.ts
      input: "\${artifacts.template.path}"
      saveAs: invalid-template.xlsx
      assign: invalidTemplate
  - id: upload_invalid
    upload:
      by: label
      name: Upload data
      path: "\${artifacts.invalidTemplate.path}"
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.artifacts.downloads).toEqual({
      template: "downloads/template.xlsx",
    });
    expect(result.artifacts.transforms).toEqual({
      invalidTemplate: "transforms/invalid-template.xlsx",
    });
    expect(result.steps[1]!.artifacts).toContain(
      "transforms/invalid-template.xlsx",
    );
    expect(backend.stepLog[1]).toMatchObject({
      upload: {
        path: join(result.runDir, "transforms/invalid-template.xlsx"),
      },
    });
    const transformed = await readFile(
      join(result.runDir, "transforms/invalid-template.xlsx"),
      "utf8",
    );
    expect(transformed).toContain("mock download");
    expect(transformed).toContain("invalid row");
  });

  it("redacts secrets from failed node verifier artifacts", async () => {
    await writeFile(
      join(workDir, "secret-fail.ts"),
      `export default async function verify() {
  throw new Error("supersecret-token leaked in stack");
}
`,
    );
    const specPath = await writeSpec(
      "node_redaction",
      `version: 1
name: node_redaction
intent: node verifier failures redact configured secrets
redaction:
  values: ["supersecret-token"]
outcomes:
  - id: node_failure
    description: failed node verifier has redacted stack evidence
    verify:
      script:
        runtime: node
        file: ./secret-fail.ts
steps: []
`,
    );

    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    const evidence = await readFile(
      join(result.runDir, "outcomes/node_failure.md"),
      "utf8",
    );
    const raw = await readFile(
      join(result.runDir, "outcomes/node_failure.raw.json"),
      "utf8",
    );
    const runJson = await readFile(join(result.runDir, "run.json"), "utf8");
    expect(`${evidence}\n${raw}\n${runJson}`).not.toContain(
      "supersecret-token",
    );
    expect(raw).toContain("[redacted]");
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

  it("marks artifact-dependent outcomes as skipped when the producing step failed", async () => {
    const specPath = await writeSpec(
      "blocked_outcomes",
      `version: 1
name: blocked_outcomes
intent: outcomes blocked by a failed step must not report as failed
outcomes:
  - id: template_contract
    description: workbook has the expected sheet
    verify:
      xlsx:
        path: "\${artifacts.template.path}"
        sheets:
          - name: Data
            contains: ["Total"]
  - id: template_script
    description: script fixture depends on the same artifact
    verify:
      script:
        run: "({ ok: true, evidence: null })"
        fixtures:
          templatePath: "\${artifacts.template.path}"
  - id: url_ok
    description: page-level outcome still evaluates
    verify:
      url: { endsWith: "/exports" }
steps:
  - id: grab
    download:
      by: selector
      selector: "#download-template"
      saveAs: template.xlsx
      assign: template
`,
    );

    const backend = new MockBrowserBackend();
    backend.setUrl("/exports");
    backend.failNextStep("element not found: #download-template");

    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.steps[0]!.status).toBe("failed");

    const byId = Object.fromEntries(result.outcomes.map((o) => [o.id, o]));
    expect(byId["template_contract"]!.status).toBe("skipped");
    expect(byId["template_script"]!.status).toBe("skipped");
    expect(byId["url_ok"]!.status).toBe("passed");

    const evidence = await readFile(
      join(result.runDir, byId["template_contract"]!.evidence!),
      "utf8",
    );
    expect(evidence).toContain("blocked");
    expect(evidence).toContain("artifacts.template");
    expect(evidence).toContain('failed step "grab"');

    const ctx = await readFile(join(result.runDir, "agent_context.md"), "utf8");
    expect(ctx).toContain("template_contract — blocked by a failed step");

    const events = (
      await readFile(join(result.runDir, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(
      events.some(
        (e) =>
          e.type === "outcome.skipped" && e.outcomeId === "template_contract",
      ),
    ).toBe(true);
  });

  it("still fails artifact outcomes on a missing artifact when no step failed", async () => {
    const specPath = await writeSpec(
      "typo_artifact",
      `version: 1
name: typo_artifact
intent: a typo'd artifact name on a green run is a real failure, not a skip
outcomes:
  - id: wrong_name
    description: references an artifact that never existed
    verify:
      xlsx:
        path: "\${artifacts.templte.path}"
        sheets:
          - name: Data
            contains: ["Total"]
steps:
  - id: nav
    open: /exports
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.steps[0]!.status).toBe("passed");
    expect(result.outcomes[0]!.status).toBe("failed");
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

  it("exposes resolved config vars as ctx.vars to node verifiers", async () => {
    await writeFile(
      join(workDir, "vars-check.ts"),
      `export default async function verify(ctx) {
  return { ok: ctx.vars.connectionPath === "/connection/abc", evidence: ctx.vars };
}
`,
    );
    const specPath = await writeSpec(
      "node_ctx_vars",
      `version: 1
name: node_ctx_vars
intent: node verifiers see resolved vars without fixture threading
outcomes:
  - id: vars_visible
    description: ctx.vars carries config vars
    verify:
      script:
        runtime: node
        file: ./vars-check.ts
steps: []
`,
    );

    // workDir has a cairntrace.config.yml (written by the config-var test
    // above) defining vars.connectionPath = /connection/abc.
    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
  });

  it("captures request responses and splices fields into later steps", async () => {
    const specPath = await writeSpec(
      "request_flow",
      `version: 1
name: request_flow
intent: fetch a token via API and fill it into the UI
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: get_token
    request:
      method: POST
      url: /api/qr-token
      body: { memberId: 42 }
      expectStatus: 200
      assign: qr
  - id: fill_token
    fill:
      by: label
      name: Scanner code
      value: "\${requests.qr.body.token}"
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      ok: true,
      headers: { "content-type": "application/json" },
      body: { token: "tok-123" },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.requestLog[0]).toMatchObject({
      method: "POST",
      url: "http://localhost:8080/api/qr-token",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    expect(backend.lastEvaluatedScript).not.toContain("/api/qr-token");
    expect(result.artifacts.requests).toEqual({ qr: "requests/qr.json" });
    const envelope = JSON.parse(
      await readFile(join(result.runDir, "requests/qr.json"), "utf8"),
    );
    expect(envelope).toMatchObject({
      method: "POST",
      url: "http://localhost:8080/api/qr-token",
      status: 200,
      body: { token: "tok-123" },
    });
    // The fill step received the spliced token value.
    expect(backend.stepLog[0]).toMatchObject({
      fill: { by: "label", name: "Scanner code", value: "tok-123" },
    });
  });

  it("resolves request-first relative URLs against config baseUrl", async () => {
    const dir = await mkdtemp(join(workDir, "request-base-"));
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://host
`,
    );
    const specPath = await writeSpecIn(
      dir,
      "request_first",
      `version: 1
name: request_first
intent: relative request URLs can run before any open
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: seed
    request:
      method: POST
      url: /api/test/login-as
      expectStatus: 200
      assign: login
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      ok: true,
      headers: {},
      body: { ok: true },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.steps).toHaveLength(1);
    expect(backend.stepLog).toEqual([]);
    expect(backend.requestLog[0]).toMatchObject({
      method: "POST",
      url: "http://host/api/test/login-as",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const envelope = JSON.parse(
      await readFile(join(result.runDir, "requests/login.json"), "utf8"),
    );
    expect(envelope.url).toBe("http://host/api/test/login-as");
  });

  it("fails request-first relative URLs clearly when no baseUrl exists", async () => {
    const dir = await mkdtemp(join(workDir, "request-no-base-"));
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local: {}
`,
    );
    const specPath = await writeSpecIn(
      dir,
      "request_no_base",
      `version: 1
name: request_no_base
intent: relative request URLs need an origin
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: seed
    request:
      method: POST
      url: /api/test/login-as
      assign: login
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.steps[0]!.error).toContain(
      'request: relative URL "/api/test/login-as" needs a baseUrl',
    );
    expect(backend.lastEvaluatedScript).not.toContain("fetch(");
    expect(backend.requestLog).toEqual([]);
  });

  it("resolves relative request URLs against the current page after open", async () => {
    const dir = await mkdtemp(join(workDir, "request-after-open-"));
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local: {}
`,
    );
    const specPath = await writeSpecIn(
      dir,
      "request_after_open",
      `version: 1
name: request_after_open
intent: relative request URLs can use a prior open as origin
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: open_app
    open: http://host/admin/page
  - id: fetch_state
    request:
      method: GET
      url: /api/state
      expectStatus: 200
      assign: state
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      ok: true,
      headers: {},
      body: { ok: true },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.stepLog[0]).toMatchObject({
      open: "http://host/admin/page",
    });
    expect(backend.requestLog[0]).toMatchObject({
      method: "GET",
      url: "http://host/api/state",
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    const envelope = JSON.parse(
      await readFile(join(result.runDir, "requests/state.json"), "utf8"),
    );
    expect(envelope.url).toBe("http://host/api/state");
  });

  it("passes explicit request timeouts to native backend requests", async () => {
    const specPath = await writeSpec(
      "request_timeout",
      `version: 1
name: request_timeout
intent: request timeout is backend-visible
environment: local
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: seed
    request:
      method: POST
      url: /api/seed
      timeoutMs: 1234
      expectStatus: 200
      assign: seed
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      ok: true,
      headers: {},
      body: { ok: true },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.requestLog[0]).toMatchObject({
      url: "http://localhost:8080/api/seed",
      timeoutMs: 1234,
    });
  });

  it("keeps request-step calls visible to network verifiers", async () => {
    const specPath = await writeSpec(
      "request_network_parity",
      `version: 1
name: request_network_parity
intent: request steps appear in network evidence
environment: local
outcomes:
  - id: request_seen
    description: seed call is captured in network log
    verify:
      network:
        method: POST
        urlContains: /api/seed
        status: { equals: 201 }
steps:
  - id: seed
    request:
      method: POST
      url: /api/seed
      expectStatus: 201
      assign: seed
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 201,
      ok: true,
      headers: {},
      body: { id: 1 },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.outcomes[0]).toMatchObject({
      id: "request_seen",
      status: "passed",
    });
  });

  it("falls back to bounded in-page fetch when the backend has no native request", async () => {
    const dir = await mkdtemp(join(workDir, "request-fallback-"));
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://host
`,
    );
    const specPath = await writeSpecIn(
      dir,
      "request_fallback",
      `version: 1
name: request_fallback
intent: backends without request still use bounded fetch
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: seed
    request:
      method: POST
      url: /api/test/login-as
      timeoutMs: 1234
      expectStatus: 200
      assign: login
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      ok: true,
      headers: {},
      body: { ok: true },
    });
    const result = await runSpec({
      specPath,
      backend: withoutNativeRequest(backend),
      artifactRoot,
    });

    expect(result.status).toBe("passed");
    expect(backend.stepLog[0]).toEqual({ open: "http://host" });
    expect(backend.lastEvaluatedScript).toContain(
      'fetch("http://host/api/test/login-as"',
    );
    expect(backend.lastEvaluatedScript).toContain("AbortSignal.timeout(1234)");
    expect(backend.lastEvaluateOptions).toEqual({ timeoutMs: 1234 });
  });

  it("joins runtime request placeholders in open paths without double slashes", async () => {
    const dir = await mkdtemp(join(workDir, "request-open-"));
    await writeFile(
      join(dir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://host/
`,
    );

    for (const [name, capturedUrl] of [
      ["leading_slash", "/play?id=1"],
      ["bare_path", "play?id=1"],
    ] as const) {
      const specPath = await writeSpecIn(
        dir,
        `request_open_${name}`,
        `version: 1
name: request_open_${name}
intent: captured URLs can drive the next open
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: seed
    request:
      method: POST
      url: /api/game
      expectStatus: 200
      assign: game
  - id: open_game
    open: "\${requests.game.body.url}"
`,
      );
      const backend = new MockBrowserBackend();
      backend.enqueueEvalResult({
        status: 200,
        ok: true,
        headers: {},
        body: { url: capturedUrl },
      });

      const result = await runSpec({ specPath, backend, artifactRoot });

      expect(result.status).toBe("passed");
      expect(backend.stepLog[backend.stepLog.length - 1]).toMatchObject({
        open: "http://host/play?id=1",
      });
    }
  });

  it("fails the request step when expectStatus does not match", async () => {
    const specPath = await writeSpec(
      "request_bad_status",
      `version: 1
name: request_bad_status
intent: expectStatus guards against silent API failures
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: checkout
    request:
      method: POST
      url: /api/billing/checkout
      expectStatus: [200, 201]
      assign: checkout
  - id: never_runs
    open: /unreachable
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 500,
      ok: false,
      headers: {},
      body: { error: "boom" },
    });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.error).toContain("500");
    expect(result.steps[0]!.error).toContain("expectStatus");
  });

  it("applies the spec-level viewport before steps run", async () => {
    const specPath = await writeSpec(
      "viewport",
      `version: 1
name: viewport_demo
intent: mobile-width regression check
viewport: { width: 390, height: 844 }
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
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.viewportLog).toEqual([{ width: 390, height: 844 }]);
  });

  it("resolves worker and run placeholders through runSpec vars", async () => {
    const specPath = await writeSpec(
      "runtime_identity",
      `version: 1
name: runtime_identity
intent: runtime placeholders derive isolated identities
vars:
  testUser: "player-\${worker.index}-\${run.token}"
outcomes:
  - id: no_errors
    description: no errors
    verify:
      console: { errorsMax: 0 }
steps:
  - open: "/session/\${vars.testUser}"
`,
    );

    const backend = new MockBrowserBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
      workerIndex: 3,
      runToken: "abc123",
    });

    expect(result.status).toBe("passed");
    expect(backend.stepLog[0]).toEqual({
      open: "http://localhost:8080/session/player-3-abc123",
    });
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

  // ---- Video recording tests ----

  it("does not record video by default (policy: never)", async () => {
    const specPath = await writeSpec(
      "video-default",
      `version: 1
name: video_default
intent: video should not be recorded by default
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.artifacts.video).toBeUndefined();
    expect(backend.startVideoCalls).toBe(0);
    expect(backend.stopVideoCalls).toBe(0);
  });

  it("records video when artifacts.capture.video is always", async () => {
    const specPath = await writeSpec(
      "video-always",
      `version: 1
name: video_always
intent: video should be recorded when capture.video is always
artifacts:
  capture:
    video: always
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    expect(result.artifacts.video).toBe("videos/mock-video.webm");
    expect(backend.startVideoCalls).toBe(1);
    expect(backend.stopVideoCalls).toBe(1);
    // Video file should exist
    const videoStat = await stat(join(result.runDir, result.artifacts.video!));
    expect(videoStat.isFile()).toBe(true);
  });

  it("deletes video on passing run when policy is on-failure", async () => {
    const specPath = await writeSpec(
      "video-on-failure-pass",
      `version: 1
name: video_on_failure_pass
intent: video should be deleted on pass with on-failure
artifacts:
  capture:
    video: on-failure
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    // Video was recorded then deleted
    expect(backend.startVideoCalls).toBe(1);
    expect(backend.stopVideoCalls).toBe(1);
    expect(result.artifacts.video).toBeUndefined();
  });

  it("keeps video on failing run when policy is on-failure", async () => {
    const specPath = await writeSpec(
      "video-on-failure-fail",
      `version: 1
name: video_on_failure_fail
intent: video should be kept on failure with on-failure
artifacts:
  capture:
    video: on-failure
outcomes:
  - id: should_fail
    description: should fail
    verify:
      url: { endsWith: "/nonexistent" }
steps:
  - id: nav
    open: /
`,
    );
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("failed");
    expect(result.artifacts.video).toBe("videos/mock-video.webm");
    expect(backend.startVideoCalls).toBe(1);
    expect(backend.stopVideoCalls).toBe(1);
  });

  it("includes video in agent_context.md when recorded", async () => {
    const specPath = await writeSpec(
      "video-context",
      `version: 1
name: video_context
intent: video should appear in agent context
artifacts:
  capture:
    video: always
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    const ctx = await readFile(join(result.runDir, "agent_context.md"), "utf8");
    expect(ctx).toContain("## View the video");
    expect(ctx).toContain("videos/mock-video.webm");
  });

  it("includes clips in agent_context.md when auto-cut on failure", async () => {
    mockVidtraceClip();

    const specPath = await writeSpec(
      "video-clip-context",
      `version: 1
name: video_clip_context
intent: clips should appear in agent context on failure
artifacts:
  capture:
    video: on-failure
  clipPoints:
    - label: issue1
      start: 0:10
      end: 0:20
outcomes:
  - id: should_fail
    description: should fail
    verify:
      url: { endsWith: "/nonexistent" }
steps:
  - id: nav
    open: /
`,
    );

    const backend = new VideoMockBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.artifacts.clips).toEqual({
      issue1: "videos/clips/issue1.mp4",
    });
    const ctx = await readFile(join(result.runDir, "agent_context.md"), "utf8");
    expect(ctx).toContain('clip "issue1"');
    expect(ctx).toContain("videos/clips/issue1.mp4");
  });

  it("auto-cuts clips on failing run when clipPoints are declared", async () => {
    mockVidtraceClip();

    const specPath = await writeSpec(
      "video-clip-points",
      `version: 1
name: video_clip_points
intent: auto-cut clips from spec-defined points on failure
artifacts:
  capture:
    video: on-failure
  clipPoints:
    - label: issue1
      start: 0:10
      end: 0:20
outcomes:
  - id: should_fail
    description: should fail
    verify:
      url: { endsWith: "/nonexistent" }
steps:
  - id: nav
    open: /
`,
    );

    const backend = new VideoMockBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.artifacts.video).toBe("videos/mock-video.webm");
    expect(result.artifacts.clips).toEqual({
      issue1: "videos/clips/issue1.mp4",
    });
    expect(cutClipsWithVidtrace).toHaveBeenCalledWith(
      expect.stringContaining("videos/mock-video.webm"),
      [{ label: "issue1", start: "0:10", end: "0:20" }],
      expect.objectContaining({
        outputDir: expect.stringContaining("videos/clips"),
        name: "video_clip_points",
        tags: [],
        reencode: false,
      }),
    );
  });

  it("does not auto-cut clips when the run passes", async () => {
    mockVidtraceClip();

    const specPath = await writeSpec(
      "video-clip-points-pass",
      `version: 1
name: video_clip_points_pass
intent: no clips when passing
artifacts:
  capture:
    video: always
  clipPoints:
    - label: issue1
      start: 0:10
      end: 0:20
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

    const backend = new VideoMockBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("passed");
    expect(result.artifacts.clips).toBeUndefined();
    expect(cutClipsWithVidtrace).not.toHaveBeenCalled();
  });

  it("does not auto-cut clips when vidtrace is unavailable", async () => {
    mockVidtraceClipUnavailable();

    const specPath = await writeSpec(
      "video-clip-points-no-vidtrace",
      `version: 1
name: video_clip_points_no_vidtrace
intent: clips are skipped when vidtrace is unavailable
artifacts:
  capture:
    video: on-failure
  clipPoints:
    - label: issue1
      start: 0:10
      end: 0:20
outcomes:
  - id: should_fail
    description: should fail
    verify:
      url: { endsWith: "/nonexistent" }
steps:
  - id: nav
    open: /
`,
    );

    const backend = new VideoMockBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.artifacts.video).toBe("videos/mock-video.webm");
    expect(result.artifacts.clips).toBeUndefined();
    expect(cutClipsWithVidtrace).not.toHaveBeenCalled();
  });

  it("does not set clips when vidtrace cut fails", async () => {
    mockVidtraceClipCutFailure();

    const specPath = await writeSpec(
      "video-clip-points-cut-fail",
      `version: 1
name: video_clip_points_cut_fail
intent: clips ignored when vidtrace cut fails
artifacts:
  capture:
    video: on-failure
  clipPoints:
    - label: issue1
      start: 0:10
      end: 0:20
outcomes:
  - id: should_fail
    description: should fail
    verify:
      url: { endsWith: "/nonexistent" }
steps:
  - id: nav
    open: /
`,
    );

    const backend = new VideoMockBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.artifacts.video).toBe("videos/mock-video.webm");
    expect(result.artifacts.clips).toBeUndefined();
    expect(cutClipsWithVidtrace).toHaveBeenCalled();
  });

  it("does not set clips when moving clips into run dir fails", async () => {
    mockVidtraceClipMoveFailure();

    const specPath = await writeSpec(
      "video-clip-points-move-fail",
      `version: 1
name: video_clip_points_move_fail
intent: clips ignored when move fails
artifacts:
  capture:
    video: on-failure
  clipPoints:
    - label: issue1
      start: 0:10
      end: 0:20
outcomes:
  - id: should_fail
    description: should fail
    verify:
      url: { endsWith: "/nonexistent" }
steps:
  - id: nav
    open: /
`,
    );

    const backend = new VideoMockBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.artifacts.video).toBe("videos/mock-video.webm");
    expect(result.artifacts.clips).toBeUndefined();
    expect(moveClipsIntoRunDir).toHaveBeenCalled();
  });

  it("includes video link in report.html when recorded", async () => {
    const specPath = await writeSpec(
      "video-report",
      `version: 1
name: video_report
intent: video should appear in report
artifacts:
  capture:
    video: always
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    const reportHtml = await readFile(
      join(result.runDir, "report.html"),
      "utf8",
    );
    expect(reportHtml).toContain("videos/mock-video.webm");
  });

  it("emits artifact.video events in events.ndjson", async () => {
    const specPath = await writeSpec(
      "video-events",
      `version: 1
name: video_events
intent: video events should be in events.ndjson
artifacts:
  capture:
    video: always
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    const events = await readFile(join(result.runDir, "events.ndjson"), "utf8");
    const videoEvents = events
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((e: { type?: string }) => e.type === "artifact.video");
    expect(videoEvents.length).toBe(2);
    expect(videoEvents[0]).toMatchObject({ action: "start" });
    expect(videoEvents[1]).toMatchObject({ action: "stop" });
  });

  it("passes slowMo and speed to startVideo when configured", async () => {
    const specPath = await writeSpec(
      "video-slowmo",
      `version: 1
name: video_slowmo
intent: slowMo and speed should be passed to the backend
artifacts:
  capture:
    video: always
  video:
    slowMo: 500
    speed: 0.5
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    expect(backend.startVideoCalls).toBe(1);
    expect(backend.lastVideoOpts).toEqual({ slowMo: 500, speed: 0.5 });

    // The artifact.video start event should include slowMo and speed.
    const events = await readFile(join(result.runDir, "events.ndjson"), "utf8");
    const videoStart = events
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .find(
        (e: { type?: string; action?: string }) =>
          e.type === "artifact.video" && e.action === "start",
      );
    expect(videoStart).toMatchObject({ slowMo: 500, speed: 0.5 });
  });

  it("uses default slowMo=0 and speed=1 when video config is absent", async () => {
    const specPath = await writeSpec(
      "video-defaults",
      `version: 1
name: video_defaults
intent: default video config when not specified
artifacts:
  capture:
    video: always
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
    const backend = new VideoMockBackend();
    const result = await runSpec({ specPath, backend, artifactRoot });
    expect(result.status).toBe("passed");
    expect(backend.lastVideoOpts).toEqual({
      slowMo: undefined,
      speed: undefined,
    });
  });
});

/**
 * MockBrowserBackend with video recording support.
 * Writes a real (empty) file to the requested path so the artifact
 * writer's existence checks pass.
 */
class VideoMockBackend extends MockBrowserBackend {
  startVideoCalls = 0;
  stopVideoCalls = 0;
  lastVideoOpts: { slowMo?: number; speed?: number } | undefined;

  async startVideo(opts?: { slowMo?: number; speed?: number }): Promise<void> {
    this.startVideoCalls++;
    this.lastVideoOpts = opts;
  }

  async stopVideo(path: string): Promise<{ ok: boolean; path: string }> {
    this.stopVideoCalls++;
    try {
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(join(path, ".."), { recursive: true });
      await wf(path, "");
      return { ok: true, path };
    } catch {
      return { ok: false, path };
    }
  }
}

function resetClipMocks() {
  vi.mocked(isVidtraceAvailable).mockClear();
  vi.mocked(isVidtraceAvailable).mockResolvedValue({
    available: false,
    version: "",
  });
  vi.mocked(cutClipsWithVidtrace).mockClear();
  vi.mocked(cutClipsWithVidtrace).mockResolvedValue({
    ok: false,
    outputDir: "",
    clips: [],
  });
  vi.mocked(moveClipsIntoRunDir).mockClear();
  vi.mocked(moveClipsIntoRunDir).mockResolvedValue({});
}

function mockVidtraceClip() {
  resetClipMocks();
  vi.mocked(isVidtraceAvailable).mockResolvedValue({
    available: true,
    version: "0.0.0",
  });
  vi.mocked(cutClipsWithVidtrace).mockResolvedValue({
    ok: true,
    outputDir: "/tmp/clips",
    clips: [
      {
        label: "issue1",
        start_seconds: 10,
        end_seconds: 20,
        duration_seconds: 10,
        path: "/tmp/clips/issue1.mp4",
      },
    ],
  });
  vi.mocked(moveClipsIntoRunDir).mockResolvedValue({
    issue1: "videos/clips/issue1.mp4",
  });
}

function mockVidtraceClipUnavailable() {
  resetClipMocks();
  vi.mocked(isVidtraceAvailable).mockResolvedValue({
    available: false,
    version: "",
  });
}

function mockVidtraceClipCutFailure() {
  resetClipMocks();
  vi.mocked(isVidtraceAvailable).mockResolvedValue({
    available: true,
    version: "0.0.0",
  });
  vi.mocked(cutClipsWithVidtrace).mockResolvedValue({
    ok: false,
    clips: [],
    outputDir: "",
  });
}

function mockVidtraceClipMoveFailure() {
  resetClipMocks();
  vi.mocked(isVidtraceAvailable).mockResolvedValue({
    available: true,
    version: "0.0.0",
  });
  vi.mocked(cutClipsWithVidtrace).mockResolvedValue({
    ok: true,
    outputDir: "/tmp/clips",
    clips: [
      {
        label: "issue1",
        start_seconds: 10,
        end_seconds: 20,
        duration_seconds: 10,
        path: "/tmp/clips/issue1.mp4",
      },
    ],
  });
  vi.mocked(moveClipsIntoRunDir).mockResolvedValue({});
}

describe("agent_context.md Code Matches", () => {
  it("includes code matches when investigate.json exists in the run dir", async () => {
    const specPath = await writeSpec(
      "code-matches",
      `version: 1
name: code_matches
intent: agent_context should show investigate code matches
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
    expect(result.status).toBe("passed");

    // Simulate what `cairn investigate` writes
    await writeFile(
      join(result.runDir, "investigate.json"),
      JSON.stringify({
        runId: result.runId,
        runDir: result.runDir,
        codeMatches: [
          {
            file: "src/auth/login.ts",
            line: 42,
            score: 0.89,
            snippet: "handleSubmit",
          },
          { file: "src/router.ts", line: 15, score: 0.72 },
        ],
      }),
    );

    // Re-render agent_context.md by calling the function directly
    const { renderAgentContext } = await import(
      "../../core/artifacts/agentContext"
    );
    const { parseSpec } = await import("../../core/parser/parseSpec");
    const parsed = await parseSpec(specPath);
    const ctx = renderAgentContext(parsed.spec, result);
    expect(ctx).toContain("## Code Matches");
    expect(ctx).toContain("src/auth/login.ts:42 (score: 0.89): handleSubmit");
    expect(ctx).toContain("src/router.ts:15 (score: 0.72)");
    expect(ctx).toContain("codemap annotate");
  });

  it("does not include code matches when investigate.json is absent", async () => {
    const specPath = await writeSpec(
      "no-code-matches",
      `version: 1
name: no_code_matches
intent: agent_context should not show code matches without investigate.json
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
    const ctx = await readFile(join(result.runDir, "agent_context.md"), "utf8");
    expect(ctx).not.toContain("## Code Matches");
  });
});

describe("eval steps", () => {
  it("captures the return value as evals/<assign>.json and populates artifacts", async () => {
    const specPath = await writeSpec(
      "eval_basic",
      `version: 1
name: eval_basic
intent: eval step captures return value
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: get_state
    eval:
      js: "return { count: 42, label: 'test' }"
      assign: state
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ count: 42, label: "test" });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.artifacts.evals).toEqual({ state: "evals/state.json" });
    expect(result.steps[0]!.artifacts).toContain("evals/state.json");
    const captured = JSON.parse(
      await readFile(join(result.runDir, "evals/state.json"), "utf8"),
    );
    expect(captured).toEqual({ value: { count: 42, label: "test" } });
  });

  it("splices ${evals.<name>.value.X} into later steps", async () => {
    const specPath = await writeSpec(
      "eval_interpolate",
      `version: 1
name: eval_interpolate
intent: eval value drives a later fill
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: get_token
    eval:
      js: "return { token: 'eval-tok-999' }"
      assign: auth
  - id: fill_token
    fill:
      by: label
      name: Token
      value: "\${evals.auth.value.token}"
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ token: "eval-tok-999" });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(backend.stepLog[0]).toMatchObject({
      fill: { by: "label", name: "Token", value: "eval-tok-999" },
    });
  });

  it("reads JS from a file when file: is given instead of js:", async () => {
    await writeFile(
      join(workDir, "eval-source.js"),
      `return { items: [1, 2, 3], total: 6 }`,
    );
    const specPath = await writeSpec(
      "eval_file",
      `version: 1
name: eval_file
intent: eval step reads from file
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: compute
    eval:
      file: ./eval-source.js
      assign: result
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ items: [1, 2, 3], total: 6 });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    const captured = JSON.parse(
      await readFile(join(result.runDir, "evals/result.json"), "utf8"),
    );
    expect(captured.value).toEqual({ items: [1, 2, 3], total: 6 });
  });

  it("fails the step when backend.evaluate returns an error", async () => {
    const specPath = await writeSpec(
      "eval_fail",
      `version: 1
name: eval_fail
intent: eval failure surfaces as a step failure
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: bad_eval
    eval:
      js: "throw new Error('boom')"
      assign: broken
  - id: never_runs
    open: /unreachable
`,
    );

    // Override evaluate() to return a failure so the eval step fails.
    const backend = new MockBrowserBackend();
    (backend as unknown as { evaluate: () => Promise<unknown> }).evaluate =
      async () => ({
        ok: false,
        stdout: "",
        stderr: "eval boom",
        exitCode: 1,
        durationMs: 0,
        argv: ["eval"],
      });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.status).toBe("failed");
    expect(result.steps[0]!.error).toContain("eval");
  });

  it("passes args to the eval function", async () => {
    const specPath = await writeSpec(
      "eval_args",
      `version: 1
name: eval_args
intent: eval step receives args object
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: with_args
    eval:
      js: "return { doubled: args.n * 2 }"
      args: { n: 21 }
      assign: computed
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ doubled: 42 });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    // The wrapped script should contain the args JSON
    expect(backend.lastEvaluatedScript).toContain('"n":21');
  });

  it("works without assign (fire-and-forget eval)", async () => {
    const specPath = await writeSpec(
      "eval_no_assign",
      `version: 1
name: eval_no_assign
intent: eval without assign runs without capturing
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: seed_state
    eval:
      js: "window.__seeded = true; return { ok: true }"
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ ok: true });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    expect(result.artifacts.evals).toBeUndefined();
  });

  it("redacts secrets from eval artifact output", async () => {
    const specPath = await writeSpec(
      "eval_redaction",
      `version: 1
name: eval_redaction
intent: eval values are redacted before writing
redaction:
  values: ["supersecret-eval-token"]
outcomes:
  - id: ok
    description: ok
    verify:
      console: { errorsMax: 0 }
steps:
  - id: leak
    eval:
      js: "return { token: 'supersecret-eval-token' }"
      assign: leaked
`,
    );

    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ token: "supersecret-eval-token" });
    const result = await runSpec({ specPath, backend, artifactRoot });

    expect(result.status).toBe("passed");
    const captured = await readFile(
      join(result.runDir, "evals/leaked.json"),
      "utf8",
    );
    expect(captured).not.toContain("supersecret-eval-token");
    expect(captured).toContain("[redacted]");
  });
});
