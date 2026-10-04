/**
 * E1 (late-bound sentinels never leak), E2 (runtime splices become real
 * bindings or an explicit test.fixme), and E3 (honest coverage) for the
 * single-file exporter.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";
import { LateBoundLeakError } from "./templateValue";

const LEAK = /__CAIRN_[A-Z_]+__/i;
const RUNTIME_PLACEHOLDER = /\$\{(?:requests|evals|artifacts)\./;

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function spec(overrides: Partial<Spec>): Spec {
  return {
    version: 1,
    name: "late_bound",
    intent: "late-bound references stay late-bound",
    mode: "normal",
    outcomes: [
      {
        id: "ok",
        description: "ok",
        verify: { text: { contains: "ok" }, region: "page" },
      },
    ],
    steps: [],
    ...overrides,
  } as Spec;
}

/** Executable (non-comment) lines of generated source. */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .filter(
      (line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
    );
}

describe("E1: late-bound sentinels never reach generated code", () => {
  it("normalizes a run-token wait.text needle at run time instead of lowercasing the sentinel", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [
          {
            id: "wait_order",
            wait: { text: "Order  __CAIRN_RUN_TOKEN__ Ready", timeoutMs: 5000 },
          },
          {
            id: "wait_gone",
            wait: { notText: "Error __CAIRN_SECRET_REF__TENANT__" },
          },
        ],
      }),
    );
    expect(source).not.toMatch(LEAK);
    expect(source).toContain(
      'includes(String(`Order  ${RUN_TOKEN} Ready`).replace(/\\s+/g, " ").trim().toLowerCase())',
    );
    expect(source).toContain(
      'includes(String(`Error ${process.env.TENANT ?? ""}`).replace(/\\s+/g, " ").trim().toLowerCase())',
    );
    expect(source).toContain(
      `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random()`,
    );
  });

  it("keeps case for caseSensitive late-bound waits and literal needles normalized at export", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [
          {
            wait: {
              text: "ID __CAIRN_RUN_TOKEN__",
              caseSensitive: true,
            },
          },
          { wait: { text: "  Plain   Text " } },
        ],
      }),
    );
    expect(source).toContain(
      'includes(String(`ID ${RUN_TOKEN}`).replace(/\\s+/g, " ").trim())',
    );
    expect(source).not.toContain("trim().toLowerCase().includes(String(`ID");
    expect(source).toContain(`.includes("plain text")`);
  });

  it("passes late-bound when.text needles as page.evaluate arguments (string and object forms)", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [
          {
            id: "maybe_banner",
            when: "text:Welcome __CAIRN_RUN_TOKEN__",
            click: { by: "role", role: "button", name: "Dismiss" },
          },
          {
            id: "maybe_error",
            when: { notText: "Failed __CAIRN_SECRET_REF__TENANT__" },
            click: { by: "role", role: "button", name: "Retry" },
          },
        ],
      }),
    );
    expect(source).not.toMatch(LEAK);
    expect(source).toContain(
      'if (await page.evaluate((needle) => String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().toLowerCase().includes(needle), String(`Welcome ${RUN_TOKEN}`).replace(/\\s+/g, " ").trim().toLowerCase())) {',
    );
    expect(source).toContain(
      'if (!(await page.evaluate((needle) => String(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().toLowerCase().includes(needle), String(`Failed ${process.env.TENANT ?? ""}`).replace(/\\s+/g, " ").trim().toLowerCase()))) {',
    );
    // Comments are humanized, never sentinel-bearing.
    expect(source).toContain(`// when: text:Welcome RUN_TOKEN`);
  });

  it("splices run tokens and secrets into eval source in Node and flags secrets in the browser", () => {
    const result = exportPlaywright(
      spec({
        steps: [
          {
            id: "seed",
            eval: {
              js: "window.__token = '__CAIRN_RUN_TOKEN__'; return '__CAIRN_SECRET_REF__API_KEY__';",
            },
          },
          {
            id: "fill_site",
            fill: {
              by: "label",
              name: "Site",
              value: "site-__CAIRN_RUN_TOKEN__.__CAIRN_SECRET_REF__DOMAIN__",
            },
          },
        ],
      }),
    );
    expect(result.source).not.toMatch(LEAK);
    expect(result.source).toContain(
      "source: `window.__token = '${RUN_TOKEN}'; return '${process.env.API_KEY ?? \"\"}';`",
    );
    expect(result.source).toContain(
      'fill(`site-${RUN_TOKEN}.${process.env.DOMAIN ?? ""}`)',
    );
    expect(result.requiredEnv).toEqual(["API_KEY", "DOMAIN"]);
    expect(result.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "secretInBrowser", id: "seed" }),
    );
    // The eval is exported (no longer a hard skip), so the test is not fixme.
    expect(result.coverage.fixme).toBe(false);
  });

  it("splices sentinels into browser verifier source but leaves its ${…} JavaScript literal", () => {
    const { source } = exportPlaywright(
      spec({
        outcomes: [
          {
            id: "token_rendered",
            description: "token rendered",
            verify: {
              script: {
                run: "return { ok: document.title.includes('__CAIRN_RUN_TOKEN__') && `${requests.x}` !== '' };",
              },
            },
          },
        ],
      }),
    );
    expect(source).not.toMatch(LEAK);
    expect(source).toContain("document.title.includes('${RUN_TOKEN}')");
    expect(source).toContain("\\`\\${requests.x}\\`");
    expect(source).not.toContain("cairnSplice");
  });

  it("refuses to write a file that would still carry a sentinel, naming file and step", () => {
    expect(() =>
      exportPlaywright(
        spec({
          steps: [
            {
              id: "odd_role",
              click: { by: "role", role: "__CAIRN_RUN_TOKEN__" },
            },
          ],
        }),
        { outPath: "/exports/late_bound.spec.ts" },
      ),
    ).toThrow(LateBoundLeakError);
    try {
      exportPlaywright(
        spec({
          steps: [
            {
              id: "odd_role",
              click: { by: "role", role: "__CAIRN_RUN_TOKEN__" },
            },
          ],
        }),
        { outPath: "/exports/late_bound.spec.ts" },
      );
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("/exports/late_bound.spec.ts:");
      expect(message).toContain("spec late_bound");
      expect(message).toContain("step odd_role");
      expect(message).toContain("RUN_TOKEN");
    }
  });
});

describe("E2: runtime splices are bound or the test is fixme", () => {
  it("binds request and eval assigns and splices them into later steps", () => {
    const result = exportPlaywright(
      spec({
        steps: [
          {
            id: "login",
            request: {
              method: "POST",
              url: "/api/login",
              body: { user: "demo" },
              assign: "login",
            },
          },
          {
            id: "probe",
            eval: { js: "return { id: 7 };", assign: "state" },
          },
          {
            id: "open_order",
            open: "/orders/${evals.state.value.id}?t=${requests.login.body.token}",
          },
        ],
      }),
    );
    const { source, coverage } = result;
    expect(coverage.fixme).toBe(false);
    expect(coverage.skips).toEqual([]);
    expect(source).toContain(`let cairnRequests_login: unknown;`);
    expect(source).toContain(`let cairnEvals_state: unknown;`);
    expect(source).toContain(
      `cairnRequests_login = { url: cairnResponse.url(), method: "POST", status: cairnResponse.status(), ok: cairnResponse.status() >= 200 && cairnResponse.status() < 400, headers: cairnResponse.headers(), body: `,
    );
    expect(source).toContain(
      `cairnEvals_state = { value: await page.evaluate(async ({ source, args }) => {`,
    );
    expect(source).toContain(
      'await page.goto(`/orders/${cairnSplice(cairnEvals_state, ["value","id"])}?t=${cairnSplice(cairnRequests_login, ["body","token"])}`);',
    );
    expect(source).toContain(
      `function cairnSplice(root: unknown, path: string[]): string {`,
    );
    for (const line of codeLines(source)) {
      expect(line).not.toMatch(RUNTIME_PLACEHOLDER);
    }
  });

  it("marks an unbound splice as a hard skip (test.fixme) and a semantic risk", () => {
    const result = exportPlaywright(
      spec({
        steps: [
          {
            id: "too_early",
            open: "/orders/${evals.state.value.id}",
          },
          {
            id: "probe",
            eval: { js: "return { id: 7 };", assign: "state" },
          },
        ],
      }),
    );
    expect(result.source).toContain(`test.fixme("late_bound"`);
    expect(result.source).toContain(
      'await page.goto(`/orders/${cairnUnresolvedSplice("evals.state.value.id")}`);',
    );
    expect(result.source).toContain(
      `function cairnUnresolvedSplice(ref: string): never {`,
    );
    expect(result.coverage.fixme).toBe(true);
    expect(result.coverage.skips).toContainEqual(
      expect.objectContaining({
        kind: "step",
        id: "too_early",
        reason: expect.stringContaining("${evals.state.value.id}"),
      }),
    );
    expect(result.coverage.semanticRisks).toContainEqual(
      expect.objectContaining({ kind: "unresolvedSplice", id: "too_early" }),
    );
    for (const line of codeLines(result.source)) {
      expect(line).not.toMatch(RUNTIME_PLACEHOLDER);
    }
  });

  it("binds downloads (default artifact name) and network postcondition captures", () => {
    const { source, coverage } = exportPlaywright(
      spec({
        steps: [
          {
            id: "export_csv",
            download: {
              by: "role",
              role: "button",
              name: "Export",
              saveAs: "Monthly Report.csv",
            },
          },
          {
            id: "reupload",
            upload: {
              by: "label",
              name: "File",
              path: "${artifacts.monthly_report.relativePath}",
            },
            postcondition: {
              network: {
                method: "POST",
                urlContains: "/api/import",
                assign: "imported",
              },
            },
          },
          {
            id: "echo_body",
            fill: {
              by: "label",
              name: "Echo",
              value: "${requests.imported.body.name}",
            },
          },
        ],
      }),
    );
    expect(coverage.fixme).toBe(false);
    expect(source).toContain(
      `const downloadPath = test.info().outputPath("cairn-run", "downloads", "Monthly Report.csv");`,
    );
    expect(source).toContain(
      `cairnArtifacts_monthly_report = { path: downloadPath, relativePath: "downloads/Monthly Report.csv" };`,
    );
    expect(source).toContain(
      'setInputFiles(test.info().outputPath("cairn-run", `${cairnSplice(cairnArtifacts_monthly_report, ["relativePath"])}`));',
    );
    expect(source).toContain(
      `const networkPostconditionResponse1Matched = await networkPostconditionResponse1;`,
    );
    expect(source).toContain(
      `cairnRequests_imported = { url: networkPostconditionResponse1Matched.url()`,
    );
    expect(source).toContain(
      'cairnSplice(cairnRequests_imported, ["body","name"])',
    );
  });

  it("binds the runner's default request_<n> name and skips bindings nobody reads", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [
          { open: "/" },
          { request: { method: "GET", url: "/api/me" } },
          { request: { method: "GET", url: "/api/unused", assign: "unused" } },
          { eval: { js: "return 1;", assign: "ignored" } },
          {
            fill: {
              by: "label",
              name: "Me",
              value: "${requests.request_2.status}",
            },
          },
        ],
      }),
    );
    expect(source).toContain(`let cairnRequests_request_2: unknown;`);
    expect(source).not.toContain(`cairnRequests_unused`);
    expect(source).not.toContain(`cairnEvals_ignored`);
    expect(source).toContain(`  await page.request.fetch("/api/unused"`);
    expect(source).toContain(
      'cairnSplice(cairnRequests_request_2, ["status"])',
    );
  });
});

describe("E3: honest coverage", () => {
  it("makes transform a hard skip while snapshot/monitor are diagnostic only", () => {
    const transform = exportPlaywright(
      spec({
        steps: [
          {
            id: "make_invalid",
            transform: {
              file: "../transforms/x.ts",
              input: "in.xlsx",
              saveAs: "out.xlsx",
            },
          },
        ],
      }),
    );
    expect(transform.coverage.fixme).toBe(true);
    expect(transform.source).toContain(`test.fixme("late_bound"`);

    const diagnostic = exportPlaywright(
      spec({
        steps: [
          { id: "snap", snapshot: {} },
          { id: "prof", monitor: { action: "start" } },
        ] as Spec["steps"],
      }),
    );
    expect(diagnostic.coverage.fixme).toBe(false);
    expect(diagnostic.coverage.diagnosticSkips.map((s) => s.id)).toEqual([
      "snap",
      "prof",
    ]);
    expect(diagnostic.source).toContain(`test("late_bound"`);
  });

  it("reports precondition setup/infra, eval ratio, absolute paths, and baked env defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-export-risks-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "risky.yml");
    writeFileSync(
      sourcePath,
      "open: ${env.CAIRN_EXPORT_TEST_UNSET_VAR:-http://localhost:3000}\n",
    );
    const result = exportPlaywright(
      spec({
        preconditions: {
          commands: [
            { run: "echo app must be up" },
            {
              name: "reset",
              run: "docker compose exec -T db psql -c 'select 1'",
            },
          ],
        },
        steps: [
          { id: "probe", eval: { js: "return 1;" } },
          {
            id: "attach",
            upload: {
              by: "label",
              name: "File",
              path: "/home/someone/fixtures/report.pdf",
            },
          },
        ],
      }),
      { sourcePath },
    );
    const kinds = result.coverage.semanticRisks.map((risk) => risk.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "requiredSetup",
        "requiredInfra",
        "evalRatio",
        "absolutePath",
        "envBaked",
      ]),
    );
    expect(
      result.coverage.semanticRisks.find((r) => r.kind === "requiredInfra")
        ?.detail,
    ).toContain("docker, psql");
    // Unrun preconditions are reported, not a reason to fixme the test.
    expect(result.coverage.fixme).toBe(false);
    expect(result.coverage.diagnosticSkips).toContainEqual(
      expect.objectContaining({ id: "preconditions", soft: true }),
    );
  });

  it("feeds request-step responses into the network evidence buffer", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [{ request: { method: "POST", url: "/api/login" } }],
        outcomes: [
          {
            id: "login_ok",
            description: "login returned 200",
            verify: {
              network: {
                method: "POST",
                urlContains: "/api/login",
                status: { equals: 200 },
              },
            },
          },
        ],
      }),
    );
    expect(source).toContain(
      `requests.push({ url: cairnResponse.url(), method: "POST", status: cairnResponse.status() });`,
    );
  });
});

describe("review regressions (single-file)", () => {
  it("reports an echo-prefixed reset as an executable precondition, not a note", () => {
    const { coverage } = exportPlaywright(
      spec({
        preconditions: {
          commands: [
            {
              run: 'echo "resetting database" && docker compose exec db psql -c "truncate items"',
            },
          ],
        },
        steps: [{ id: "go", open: "/" }],
      }),
    );
    expect(coverage.skips).toContainEqual(
      expect.objectContaining({ id: "preconditions", soft: true }),
    );
    expect(coverage.semanticRisks.map((risk) => risk.kind)).toEqual(
      expect.arrayContaining(["requiredSetup", "requiredInfra"]),
    );
  });

  it("never shadows the network evidence array with a request assign named `requests`", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [
          {
            id: "login",
            request: { method: "POST", url: "/api/login", assign: "requests" },
          },
          {
            id: "fill_name",
            fill: {
              by: "label",
              name: "Name",
              value: "${requests.requests.body.name}",
            },
          },
        ],
        outcomes: [
          {
            id: "login_ok",
            description: "login answered",
            verify: {
              network: { urlContains: "/api/login", status: { equals: 200 } },
            },
          },
        ],
      }),
    );
    expect(source).not.toMatch(/const requests = await/);
    expect(source).toContain(
      `requests.push({ url: cairnResponse.url(), method: "POST", status: cairnResponse.status() });`,
    );
    expect(source).toContain(
      `cairnSplice(cairnRequests_requests, ["body","name"])`,
    );
  });

  it("does not flag URL routes that look like machine paths as absolutePath", () => {
    const { coverage } = exportPlaywright(
      spec({
        steps: [
          { id: "feed", open: "/home/feed" },
          { id: "opt_in", wait: { url: { includes: "/opt/in" } } },
        ],
        outcomes: [
          {
            id: "on_feed",
            description: "on the feed",
            verify: { url: { startsWith: "/home/feed" } },
          },
        ],
      }),
    );
    expect(
      coverage.semanticRisks.filter((risk) => risk.kind === "absolutePath"),
    ).toEqual([]);
  });

  it("still flags a machine-local upload path", () => {
    const { coverage } = exportPlaywright(
      spec({
        steps: [
          {
            id: "attach",
            upload: {
              by: "label",
              name: "File",
              path: "/opt/fixtures/missing-invoice.pdf",
            },
          },
        ],
      }),
    );
    expect(coverage.semanticRisks).toContainEqual(
      expect.objectContaining({
        kind: "absolutePath",
        detail: expect.stringContaining("/opt/fixtures/missing-invoice.pdf"),
      }),
    );
  });

  it("splices outcome refs only where the runner does (script fixtures, httpJson url)", () => {
    const { source, coverage } = exportPlaywright(
      spec({
        steps: [
          {
            id: "session",
            request: { method: "GET", url: "/api/session", assign: "session" },
          },
        ],
        outcomes: [
          {
            id: "named",
            description: "name shown",
            verify: { text: { contains: "${requests.session.body.name}" } },
          },
          {
            id: "record",
            description: "record readable",
            verify: {
              httpJson: {
                url: "/api/records/${requests.session.body.id}",
                jsonPath: "$.owner",
                equals: "${requests.session.body.name}",
              },
            },
          },
          {
            id: "script",
            description: "page sees the session",
            verify: {
              script: {
                run: "return { ok: fixtures.id !== '' };",
                fixtures: { id: "${requests.session.body.id}" },
              },
            },
          },
        ],
      }),
    );
    // text needle: compared literally, exactly like `cairn run`.
    expect(source).toContain(`.toContainText("\${requests.session.body.name}"`);
    // httpJson: url spliced, matcher literal (the runner splices only the url).
    expect(source).toContain(
      'page.request.get(`/api/records/${cairnSplice(cairnRequests_session, ["body","id"])}`)',
    );
    expect(source).toContain(
      `cairnAssertHttpJson(body, { jsonPath: "$.owner", equals: "\${requests.session.body.name}" });`,
    );
    // script fixtures: spliced.
    expect(source).toContain(
      `"id": \`\${cairnSplice(cairnRequests_session, ["body","id"])}\``,
    );
    expect(coverage.semanticRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "literalSplice", id: "named" }),
        expect.objectContaining({ kind: "literalSplice", id: "record" }),
      ]),
    );
    expect(
      coverage.semanticRisks.filter(
        (risk) => risk.kind === "literalSplice" && risk.id === "script",
      ),
    ).toEqual([]);
    expect(coverage.fixme).toBe(false);
  });

  it("binds nothing for a capture that only an outcome needle mentions", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [
          {
            id: "session",
            request: { method: "GET", url: "/api/session", assign: "session" },
          },
        ],
        outcomes: [
          {
            id: "named",
            description: "name shown",
            verify: { text: { contains: "${requests.session.body.name}" } },
          },
        ],
      }),
    );
    expect(source).not.toContain("cairnRequests_session");
  });

  it("does not import expect because an outcome description says 'expect'", () => {
    const { source } = exportPlaywright(
      spec({
        steps: [{ id: "go", open: "/" }],
        outcomes: [
          {
            id: "report",
            description: "the file looks as we expect.",
            verify: { file: { glob: "reports/*.csv", contains: "ok" } },
          },
        ],
      }),
    );
    expect(source).toContain(`import { test } from "@playwright/test";`);
  });
});
