import {
  DocsResultSchema,
  DocsTopicSchema,
  type DocsResult,
  type DocsTopic,
} from "../../core/schema/docs.v1";
import { emit, resolveFormat } from "../format";

export interface DocsOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

type DocsTemplate = Omit<DocsResult, "$schema" | "version" | "topic">;

export const DOC_TOPICS = DocsTopicSchema.options;

export async function docsCommand(
  topicArg: string | undefined,
  opts: DocsOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const topic = parseTopic(topicArg);
  if (!topic) {
    process.stderr.write(
      `Unknown docs topic "${topicArg}". Valid topics: ${DOC_TOPICS.join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const doc = buildDocs(topic);
  process.stdout.write(emit(format, doc, docsToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

export function buildDocs(topic: DocsTopic = "overview"): DocsResult {
  return DocsResultSchema.parse({
    $schema: "urn:cairntrace.dev:docs:v1",
    version: "1",
    topic,
    ...DOCS[topic],
  });
}

export function docsToMarkdown(doc: DocsResult): string {
  const lines = [
    `# ${doc.title}`,
    "",
    doc.summary,
    "",
    ...doc.sections.flatMap((section) => [
      `## ${section.title}`,
      section.body,
      "",
    ]),
    ...doc.examples.flatMap((example) => [
      `## Example: ${example.title}`,
      `\`\`\`${example.language}`,
      example.code,
      "```",
      "",
    ]),
  ];
  if (doc.relatedTopics.length > 0) {
    lines.push(
      "## Related Topics",
      doc.relatedTopics.map((topic) => `- ${topic}`).join("\n"),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

function parseTopic(topicArg: string | undefined): DocsTopic | undefined {
  if (!topicArg) return "overview";
  const parsed = DocsTopicSchema.safeParse(topicArg);
  if (parsed.success) return parsed.data;
  return undefined;
}

const DOCS: Record<DocsTopic, DocsTemplate> = {
  overview: {
    title: "Cairntrace Agent Docs",
    summary:
      "Cairntrace is a local-first browser-spec layer. Agents should call `cairn explain --json` once to learn the tool surface, then use `cairn docs <topic> --json` for focused authoring guidance.",
    sections: [
      {
        title: "Agent Bootstrap",
        body: "Start with `cairn explain --json` or MCP `cairn_explain`. Use `cairn docs authoring --json` before writing specs, and `cairn docs steps --json` or `cairn docs verifiers --json` when choosing YAML shapes.",
      },
      {
        title: "Core Loop",
        body: "Write intent and outcomes as the contract. Add steps as repairable hints. Use `cairn snapshot <url> --json` when you need locator inventory, then run `cairn run <spec> --cold-start --json`; inspect `agent_context.md` and outcome evidence; heal locator drift with `cairn spec heal` when the UI changes.",
      },
      {
        title: "Machine-Readable Surfaces",
        body: "`cairn explain`, `cairn docs`, `cairn run`, `cairn snapshot`, `cairn import playwright`, `cairn spec verify`, `cairn spec heal`, and `cairn diff` all support structured output formats where applicable. MCP tools return the same structured content without shell parsing.",
      },
    ],
    examples: [
      {
        title: "agent startup",
        language: "bash",
        code: [
          "cairn explain --json",
          "cairn docs authoring --json",
          "cairn docs steps --json",
        ].join("\n"),
      },
    ],
    relatedTopics: ["authoring", "steps", "verifiers", "mcp"],
  },
  authoring: {
    title: "Spec Authoring",
    summary:
      "A spec is a behavior contract: `intent + outcomes` define success, while `steps` are hints that can be healed.",
    sections: [
      {
        title: "Contract First",
        body: "Keep `intent` and `outcomes` focused on user-visible behavior, network effects, console health, or a narrow script assertion. Do not change existing outcomes casually; stamp or re-stamp the contract hash only after surfacing the diff.",
      },
      {
        title: "Cold Start",
        body: "Every finished spec must replay from a clean browser. Satisfy that with an imported login action, `session.resume`, or deterministic `preconditions.commands`. Before calling a spec done, run `cairn spec verify <spec> --config <path> --json` when using config variables, then run `cairn run <spec> --cold-start --json`.",
      },
      {
        title: "Small YAML",
        body: "Keep YAML readable. Use normal steps for navigation and interaction, first-class `download` for file capture, `transform` for Node-side fixture generation, and `script.file` when a script body would make the YAML noisy.",
      },
      {
        title: "Config Variables",
        body: "`${vars.X}` placeholders are resolved before spec validation, so they can safely appear in required fields like `open`. Vars merge in this order: config environment vars < top-level spec `vars:` < repeatable CLI `--var key=value`. Missing vars fail with a clear `missing vars.X` error. Built-ins `${worker.index}` and `${run.token}` are also available; use them in vars such as `testUser: player-${worker.index}-${run.token}` to isolate realtime/stateful backends. Contract hashes are computed from the raw unresolved intent and outcomes, not environment-specific values. Config TEXT itself substitutes `${env.X}` (e.g. `baseUrl: http://localhost:${env.APP_PORT}`), so dynamic-port runners need no per-run YAML.",
      },
      {
        title: "Viewport And Retention",
        body: "Set the browser viewport per environment (`environments.<env>.viewport: { width, height }`) or per spec (top-level `viewport:`); spec wins. Bound artifact disk usage with `retention: { keepRuns: N }` (newest N runs per spec, pruned after every run) or `cairn clean [--keep N | --all]`. Traces follow `artifacts.capture.trace` — the on-failure default deletes the trace zip on passing runs.",
      },
      {
        title: "Authoring Helpers",
        body: "`cairn snapshot <url>` opens a page and reports role and `data-testid` locators for agent-friendly step authoring. `cairn import playwright <file>` converts common Playwright `page.goto`, locator actions, request calls, and `expect` assertions into reviewable YAML with TODO comments for unmapped lines. `cairn run <dir> --junit reports/cairn.xml` expands YAML specs recursively for CI, skipping imported `actions/` directories and `_*.yml` / `_*.yaml` drafts. `--stamp-if-green` stamps contract hashes only after every requested spec passes.",
      },
    ],
    examples: [
      {
        title: "minimal spec shape",
        language: "yaml",
        code: [
          "version: 1",
          "name: table_import_template",
          "intent: Admin can download the table import template.",
          "outcomes:",
          "  - id: template_downloaded",
          "    description: template download is captured as an artifact",
          "    verify:",
          "      script:",
          "        runtime: node",
          "        file: ./verifiers/template-downloaded.ts",
          "        fixtures:",
          "          templatePath: ${artifacts.template.path}",
          "steps:",
          "  - use: login_admin",
          "  - open: /tables/import",
          "  - download:",
          "      by: role",
          "      role: button",
          "      name: Download template",
          "      saveAs: template.xlsx",
          "      assign: template",
        ].join("\n"),
      },
      {
        title: "config-backed open path",
        language: "yaml",
        code: [
          "# flows/table-import.yml",
          "vars:",
          "  connectionPath: /connection/from-spec",
          "  testUser: player-${worker.index}-${run.token}",
          "steps:",
          '  - open: "${vars.connectionPath}"',
          "",
          "# cairntrace.config.yml",
          "environments:",
          "  local:",
          "    baseUrl: http://localhost:8080",
          "    vars:",
          "      connectionPath: /connection/abc",
        ].join("\n"),
      },
      {
        title: "locator inventory",
        language: "bash",
        code: [
          "cairn snapshot /settings --config cairntrace.config.yml --json",
          "cairn snapshot http://localhost:8787/dashboard.html --roles --testids",
        ].join("\n"),
      },
    ],
    relatedTopics: ["steps", "verifiers", "downloads", "scripts"],
  },
  steps: {
    title: "Step Vocabulary",
    summary:
      "Steps are executable hints. They can be repaired by heal without changing the behavior contract.",
    sections: [
      {
        title: "Supported Steps",
        body: "`open` navigates (object form `{ path, waitUntil, timeoutMs }` waits out SPA hydration), `click` activates a locator, `hover` reveals hover-only controls, `fill` types a value, `upload` sets a file input, `download` clicks and captures a file artifact, `transform` runs a Node script to create a new artifact, `request` makes an authenticated API call and captures the response, `wait` waits for text/notText/load state, `press` sends a keyboard key, `scroll` scrolls by direction or to a locator, `snapshot` captures the page, `use` invokes an imported reusable action, and `batch` runs a chain of selector interactions in one backend invocation.",
      },
      {
        title: "Batch Steps",
        body: "`batch` runs ≥2 selector sub-steps in a SINGLE backend invocation (agent-browser `batch --bail`), so transient UI state — a hover popover, focus, an open menu — survives long enough to act on it instead of being lost to a fresh CLI process per step. Sub-steps are `click`/`hover`/`fill`/`upload`/`press`/`scroll`/`wait` and must use `by: selector` (semantic locators need their own snapshot round-trip, which would break the single invocation). The first failing sub-step fails the whole step. Artifact placeholders are not resolved inside batch sub-steps; use a top-level `upload`/`download` step for those.",
      },
      {
        title: "Locators",
        body: "Interactive steps use locators with `by: role`, `by: label`, `by: text`, or `by: selector`. Prefer role or label locators because they are easier to heal and easier for agents to understand. Semantic locators match ACCESSIBLE names (what the snapshot shows, post-CSS-text-transform): whole-name, case-insensitive, visible elements only. Substring matching is not supported. Zero matches fail the step with candidate diagnostics; multiple matches are a hard error — disambiguate with `exact: true` (case-sensitive), `nth: <index>` (0-based, document order), or a more specific name. Targets are scrolled into view automatically before the action.",
      },
      {
        title: "Request Steps",
        body: "`request` uses the browser session's cookies but is timeout-bounded. On the Playwright backend it runs out of page through a browser-context cookie transport (`APIRequestContext` when safe; an isolated Bun cookie bridge under Bun), which sends existing context cookies and persists `Set-Cookie` responses back into the browser context. The Bun bridge runs in a subprocess so the parent can kill it at `timeoutMs` even if native fetch stalls. Backends without a native request primitive use a bounded page-fetch fallback. Relative URLs resolve against config `baseUrl` when present, otherwise against the current page origin; request-first relative URLs therefore need `baseUrl`. The default request timeout is 30000ms, and `timeoutMs` overrides it per step. `assign: name` writes the `{url, method, status, ok, headers, body}` envelope to `requests/<name>.json` and lets later steps and fixtures splice fields via `${requests.<name>.body.<field>}` or `${requests.<name>.status}`. `expectStatus` fails the step on unexpected statuses; omit it for negative-path flows. Request-step calls are also mirrored into network evidence so `network` and `noFailedRequests` verifiers can match them.",
      },
      {
        title: "Reusable Actions",
        body: "Reusable actions imported via `imports:` use the same step schemas as normal specs, including `hover`, `fill.value`, `upload.path`, `download.saveAs`, and `transform.saveAs`.",
      },
    ],
    examples: [
      {
        title: "common steps",
        language: "yaml",
        code: [
          "steps:",
          "  - open: { path: /settings, waitUntil: networkidle }",
          "  - click: { by: role, role: button, name: Edit }",
          "  - click: { by: role, role: button, name: Save, nth: 1 }",
          '  - hover: { by: selector, selector: ".question-table-wrap .table-title" }',
          "  - fill: { by: label, name: Display name, value: Example Inc }",
          "  - press: Enter",
          "  - scroll: { to: { by: role, role: button, name: Submit } }",
          "  - upload: { by: label, name: Logo, path: ./fixtures/logo.png }",
          "  - download: { by: role, role: button, name: Download template, saveAs: template.xlsx, assign: template }",
          "  - transform: { runtime: node, file: ./transforms/make-invalid-template.ts, input: ${artifacts.template.path}, saveAs: invalid-template.xlsx, assign: invalidTemplate }",
          "  - upload: { by: label, name: File, path: ${artifacts.invalidTemplate.path} }",
          "  - wait: { text: Saved, timeoutMs: 10000 }",
        ].join("\n"),
      },
      {
        title: "hybrid API + UI flow",
        language: "yaml",
        code: [
          "steps:",
          "  - use: login_admin",
          "  - request: { method: POST, url: /api/qr-token, body: { memberId: 42 }, timeoutMs: 15000, expectStatus: 200, assign: qr }",
          "  - open: /scanner",
          '  - fill: { by: label, name: Scanner code, value: "${requests.qr.body.token}" }',
          "  - press: Enter",
        ].join("\n"),
      },
      {
        title: "batch: hover then click the revealed popover button",
        language: "yaml",
        code: [
          "steps:",
          "  - batch:",
          '      - hover: { by: selector, selector: "${vars.subContractorTableSelector}" }',
          "      - click:",
          "          by: selector",
          "          selector: '.table-header-hover-actions button[aria-label=\"Upload data\"]'",
        ].join("\n"),
      },
    ],
    relatedTopics: ["downloads", "authoring", "verifiers"],
  },
  verifiers: {
    title: "Verifier Vocabulary",
    summary:
      "Outcomes use the v0 verifier vocabulary. Prefer typed verifiers and use `script` only for assertions that do not fit the built-ins.",
    sections: [
      {
        title: "Typed Verifiers",
        body: "`text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`, and `httpJson` cover common UI, navigation, network, console, workbook, on-disk, and backend-JSON assertions. `text.region` and `notText.region` optionally scope text checks to a selector; the old sibling `region` shape is still accepted for compatibility. `file` polls a glob (filename wildcards, relative to the spec dir) until a matching file exists and optionally contains a needle. `httpJson` fetches JSON in the browser session with cookies, resolves relative URLs through config `baseUrl` or the current page origin, walks a simple dotted JSON path like `$.game.score`, and applies `equals`/`contains`/`matches`/numeric/`exists` matchers.",
      },
      {
        title: "Script Escape Hatch",
        body: "`script` defaults to browser page context and must return `{ ok, evidence }`. Set `runtime: node` to run a JS/TS module in Node with filesystem and npm package access.",
      },
      {
        title: "Evidence",
        body: "Each outcome writes a compact markdown evidence file. Script verifiers also write raw evidence JSON when the evidence is too deep for the markdown budget.",
      },
      {
        title: "Blocked Outcomes",
        body: "When a step fails before producing an artifact or response, outcomes whose verifier references the missing `${artifacts.<name>.…}` / `${requests.<name>.…}` are reported as `skipped` (evidence says `blocked: … never produced — run stopped at failed step`), not `failed` — fix the failed step first. On a run with no step failure, a reference to an unknown artifact name is a real failure.",
      },
    ],
    examples: [
      {
        title: "mixed verifier outcomes",
        language: "yaml",
        code: [
          "outcomes:",
          "  - id: import_request_succeeded",
          "    description: import API succeeds",
          "    verify:",
          "      network: { method: POST, urlContains: /api/import, status: { in: [200, 201] } }",
          "  - id: no_console_errors",
          "    description: page has no console errors",
          "    verify:",
          "      console: { errorsMax: 0 }",
          "  - id: objective_ticker_updates",
          "    description: objective ticker shows state",
          "    verify:",
          "      text:",
          "        contains: dead",
          "        region: '[data-testid=\"objective-ticker\"]'",
          "  - id: backend_state_matches",
          "    description: backend state reflects the seeded game",
          "    verify:",
          "      httpJson:",
          "        url: /api/test/state?gameId=${requests.game.body.gameId}",
          '        jsonPath: "$.roshan.alive"',
          "        equals: false",
        ].join("\n"),
      },
    ],
    relatedTopics: ["scripts", "artifacts", "authoring"],
  },
  downloads: {
    title: "Download Capture",
    summary:
      "`download` captures a browser download into the run artifact directory and can assign it a stable artifact name.",
    sections: [
      {
        title: "Atomic Click And Capture",
        body: "Use a `download` step instead of separate click and script plumbing. The backend arms download capture before activating the locator, then saves the file under `downloads/<saveAs>`.",
      },
      {
        title: "Named Artifacts",
        body: "`assign` gives the download a stable name. Verifiers can reference `${artifacts.<name>.path}` for the absolute path or `${artifacts.<name>.relativePath}` for the run-relative path.",
      },
      {
        title: "Backend Support",
        body: "Playwright uses native browser download events. The agent-browser backend resolves semantic locators to interactive snapshot refs, then delegates to top-level `agent-browser download`. Blob/object URL downloads should be handled by the active backend's download support; if a product bypasses browser download semantics entirely, use a product API or fixture precondition instead.",
      },
    ],
    examples: [
      {
        title: "download a template",
        language: "yaml",
        code: [
          "steps:",
          "  - download:",
          "      by: role",
          "      role: button",
          "      name: Download template",
          "      saveAs: template.xlsx",
          "      assign: template",
        ].join("\n"),
      },
    ],
    relatedTopics: ["artifacts", "scripts", "steps"],
  },
  scripts: {
    title: "Script Verifiers",
    summary:
      "Script verifiers keep custom checks available while preserving the typed outcome contract.",
    sections: [
      {
        title: "Inline Or External",
        body: "Use `script.run` for short bodies and `script.file` for longer JS/TS bodies. External files resolve relative to the spec file. Browser TypeScript files are transpiled before page evaluation; Node runtime files are imported by Node.",
      },
      {
        title: "Execution Context",
        body: "Browser scripts can read DOM state and use injected `fixtures`, `artifacts`, and `vars`. Node scripts receive `ctx` with `fixtures`, `artifacts`, `vars` (resolved config/CLI vars for the active environment), `runDir`, and `specDir`, and can import project dependencies or read files with `fs`.",
      },
      {
        title: "Return Shape",
        body: "The body should `return { ok: boolean, evidence: unknown }`. Evidence is summarized in the outcome markdown and retained in a raw JSON sidecar when needed.",
      },
      {
        title: "Node Import Gotcha",
        body: "Node verifier files run under Node's TypeScript type-stripping, so relative imports MUST carry an explicit extension: `import { helper } from './lib.ts'` — a bare `./lib` fails with `Cannot find module`.",
      },
    ],
    examples: [
      {
        title: "external TypeScript verifier",
        language: "yaml",
        code: [
          "verify:",
          "  script:",
          "    runtime: node",
          "    file: ./verifiers/check-template.ts",
          "    fixtures:",
          "      templatePath: ${artifacts.template.path}",
        ].join("\n"),
      },
      {
        title: "script file body",
        language: "ts",
        code: [
          "import { stat } from 'node:fs/promises';",
          "",
          "export default async function verify(ctx) {",
          "  const file = await stat(ctx.fixtures.templatePath);",
          "  return {",
          "    ok: file.isFile(),",
          "    evidence: { templatePath: ctx.fixtures.templatePath, size: file.size },",
          "  };",
          "}",
        ].join("\n"),
      },
    ],
    relatedTopics: ["verifiers", "downloads", "artifacts"],
  },
  artifacts: {
    title: "Run Artifacts",
    summary:
      "Every run writes a self-contained artifact directory for agent handoff, debugging, and CI evidence.",
    sections: [
      {
        title: "Core Files",
        body: "Run directories include `run.{json,yaml,md}`, `report.html`, `report.json`, `agent_context.md`, `events.ndjson`, `spec.resolved.yml`, per-outcome evidence, snapshots, screenshots, console logs, and network logs.",
      },
      {
        title: "Reports",
        body: "`report.html` is self-contained and print-friendly for sharing or saving as PDF. It summarizes status, timing, outcomes, steps, and artifact links. `report.json` exposes the same redacted report model for custom renderers, including selected theme tokens and built-in theme definitions. Configure styling with `report.theme: cairn|graphite|midnight|contrast` and `report.colors` in `cairntrace.config.yml`; there is no separate report theme config file.",
      },
      {
        title: "Downloads And Diagnostics",
        body: "Download steps save files under `downloads/`. Transform steps save generated fixtures under `transforms/`. Request steps save response envelopes under `requests/`. Failed steps write diagnostics under `diagnostics/` with current URL, visible controls, table headers, selector counts, and nearby text excerpts; every interactive step also records the element it actually hit (role/name/ref) in its StepResult and events.ndjson.",
      },
      {
        title: "Agent Handoff",
        body: "Use `cairn context latest` or MCP `cairn_context` to hand an agent the compact markdown summary instead of flooding context with every raw artifact. The CLI resolves `latest` inside `--artifact-root`, config `artifactRoot`, or the global default, in that order.",
      },
    ],
    examples: [
      {
        title: "inspect latest run",
        language: "bash",
        code: "cairn context latest\ncairn context latest --path\ncairn context latest --artifact-root tests/bdd/runs",
      },
    ],
    relatedTopics: ["downloads", "mcp", "verifiers"],
  },
  mcp: {
    title: "MCP Agent Interface",
    summary:
      "`cairn mcp` exposes the same core surface as the CLI, returning text summaries plus structured content.",
    sections: [
      {
        title: "Bootstrap Tools",
        body: "Use `cairn_explain` once at session start to learn commands, verifiers, rules, and config. Use `cairn_docs` for topic-specific guidance without reading README files from disk.",
      },
      {
        title: "Execution Tools",
        body: "`cairn_run`, `cairn_spec_verify`, `cairn_spec_heal`, `cairn_context`, and checkpoint tools mirror their CLI counterparts. `cairn_run` supports `artifactRoot` for sandboxes and tests.",
      },
      {
        title: "No Per-Agent Paths",
        body: "The MCP tools are an adapter over the same runner, schemas, and artifact format as the CLI. Agent-specific behavior belongs in the client, not Cairntrace core.",
      },
    ],
    examples: [
      {
        title: "MCP config",
        language: "json",
        code: [
          "{",
          '  "mcpServers": {',
          '    "cairntrace": {',
          '      "command": "cairn",',
          '      "args": ["mcp"]',
          "    }",
          "  }",
          "}",
        ].join("\n"),
      },
    ],
    relatedTopics: ["overview", "artifacts", "backends"],
  },
  backends: {
    title: "Browser Backends",
    summary:
      "Cairntrace can run against agent-browser, Playwright, or the in-memory mock backend.",
    sections: [
      {
        title: "agent-browser",
        body: "`agent-browser` is the default backend. Use it for the normal agent-in-session workflow: semantic locators, compact snapshots, lower context cost, and no Playwright browser install requirement.",
      },
      {
        title: "Timeouts And Cleanup",
        body: "Cairn enforces a hard deadline on browser-backend invocations. agent-browser uses a 60s default with step-level `timeoutMs` + 5s grace; a wedged daemon gets killed and the step fails with a normal timeout error instead of hanging the run. Playwright `wait` and browser `evaluate` paths also have Cairntrace-side deadlines (30000ms default, or `timeoutMs` when supplied). Real Chromium runs start an external watchdog process that kills the browser at the deadline, so page navigation churn cannot leave the suite waiting on Playwright forever. Ctrl-C / SIGTERM tears down the run's own browser session before exiting; other sessions are untouched.",
      },
      {
        title: "Playwright",
        body: "You do not need Playwright's browser binary to run specs with the agent-browser backend. Use `--backend playwright` when you specifically need native traces, HAR/video-style debugging, Playwright parity, or a pre-export CI confidence check. Playwright `request` steps run out of page with browser-context cookie sharing while applying a hard per-request timeout. When `CI` is truthy, Chromium launches with `--no-sandbox` and `--disable-dev-shm-usage`; set `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` to override those flags.",
      },
      {
        title: "Mock",
        body: "`--mock` is for Cairntrace tests and fast smoke checks. It does not validate real browser behavior.",
      },
    ],
    examples: [
      {
        title: "choose a backend",
        language: "bash",
        code: [
          "cairn run flows/import.yml --backend agent-browser",
          "cairn run flows/import.yml --backend playwright",
          "cairn run flows/import.yml --mock",
        ].join("\n"),
      },
    ],
    relatedTopics: ["overview", "downloads", "artifacts"],
  },
};
