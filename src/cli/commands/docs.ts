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
    relatedTopics: [
      "authoring",
      "steps",
      "verifiers",
      "mcp",
      "stash",
      "investigate",
    ],
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
        body: "Set the browser viewport per environment (`environments.<env>.viewport: { width, height }`) or per spec (top-level `viewport:`); spec wins. Bound artifact disk usage with `retention: { keepRuns: N }` (newest N runs per spec, pruned after every run) or `cairn clean [--keep N | --all]`. Traces follow `artifacts.capture.trace` — the on-failure default deletes the trace zip on passing runs. Videos follow `artifacts.capture.video` (default `never`) — opt in with `always` or `on-failure` for audit-grade recordings.",
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
        body: "Run directories include `run.{json,yaml,md}`, `report.html`, `report.json`, `agent_context.md`, `events.ndjson`, `spec.resolved.yml`, per-outcome evidence, snapshots, screenshots, console logs, network logs, traces, and videos.",
      },
      {
        title: "Traces And Videos",
        body: "Traces follow `artifacts.capture.trace` (default `on-failure` — the trace zip is deleted on passing runs). Videos follow `artifacts.capture.video` (default `never` — opt in with `always` or `on-failure`). Videos are saved as `videos/<backend>-video.webm`; the Playwright backend supports video natively via context-level `recordVideo`. When steps execute too quickly to audit, configure `artifacts.video.slowMo` (delay in ms between actions) and `artifacts.video.speed` (playback speed multiplier, 0.25–4; values < 1 slow down via ffmpeg post-processing). Videos are ideal for audit: feed them to vidtrace for timestamped evidence extraction.",
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
        body: "You do not need Playwright's browser binary to run specs with the agent-browser backend. Use `--backend playwright` when you specifically need native traces, video recording, HAR/video-style debugging, Playwright parity, or a pre-export CI confidence check. Playwright `request` steps run out of page with browser-context cookie sharing while applying a hard per-request timeout. When `CI` is truthy, Chromium launches with `--no-sandbox` and `--disable-dev-shm-usage`; set `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` to override those flags.",
      },
      {
        title: "Mock",
        body: "`--mock` is for Cairntrace tests and fast smoke checks. It does not validate real browser behavior.",
      },
      {
        title: "Web Server Lifecycle",
        body: "Cairntrace does not start your app by default, but an optional `webServer:` block in `cairntrace.config.yml` lets `cairn run` own the build → boot → readiness → setup → teardown for the whole invocation (one server shared by every spec, started once before the pool and stopped once after — parallel-safe), the same role Playwright's `webServer` plays. Readiness is satisfied by `url` (an HTTP probe — any response, including 3xx/4xx, counts as up), `waitForText` (a stdout/stderr substring), or the resolved environment `baseUrl` when neither is set. `reuseExisting` defaults to true (reuse a server already answering the URL and skip its build/setup/teardown), but flips to false under `--cold-start` or a truthy `CI` so CI always boots fresh; an explicit value wins. `env:` is merged over `process.env` for the spawned process and the setup/teardown commands, and `${env.X}` substitutes in config text so dynamic ports need no per-run YAML. On readiness timeout, an early crash, or a non-zero run, the last 80 lines of the captured `web-server-<pid>.log` are surfaced. Boot/setup failures exit 2 (errored); teardown is best-effort. Ctrl-C tears the server (and its process tree) down. Pass `--no-web-server` to skip the block when you manage the server out of band. Under Bun the server is spawned with `Bun.spawn` and setup/teardown shell out through `Bun.$`.",
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
      {
        title: "webServer block (cairntrace.config.yml)",
        language: "yaml",
        code: [
          "environments:",
          "  local: { baseUrl: http://127.0.0.1:3000 }",
          "  ci: { baseUrl: http://localhost:${env.APP_PORT} }",
          "webServer:",
          "  build: bun run build           # once, skipped when a server is reused",
          "  command: node .output/server/index.mjs",
          "  url: http://127.0.0.1:3000     # readiness probe; defaults to baseUrl",
          '  env: { HOST: 127.0.0.1, PORT: "3000" }',
          "  reuseExisting: true            # default true; false under --cold-start/CI",
          "  readyTimeoutMs: 60000",
          '  setup:    [ "redis-cli -n 1 flushdb" ]   # after ready, before specs',
          '  teardown: [ "redis-cli -n 1 flushdb" ]   # after specs, best-effort',
        ].join("\n"),
      },
    ],
    relatedTopics: ["overview", "downloads", "artifacts"],
  },
  stash: {
    title: "Stash Integration (fcheap)",
    summary:
      "Save, list, search, and restore run directories via fcheap — a local-first stash vault. Requires fcheap on $PATH.",
    sections: [
      {
        title: "Overview",
        body: "Cairntrace run directories are self-contained: run.json, agent_context.md, events.ndjson, screenshots, snapshots, traces, and videos. Stashing them to fcheap persists them beyond retention cleanup, makes them searchable across runs, and enables the investigate pipeline (Phase 3: fcheap connect → vecgrep → code matches).",
      },
      {
        title: "CLI Commands",
        body: "`cairn stash save <run-id>` stashes a run directory (run-id: run id, 'latest', or 'previous'). `cairn stash list` lists stashes (optionally filtered by --tag or --tool). `cairn stash info <stash-id>` shows detailed metadata. `cairn stash restore <stash-id> [--to <dir>]` restores a stash. `cairn stash search <query>` searches across all stashed runs (supports --mode keyword|semantic|hybrid). All commands support --format json|yaml|md.",
      },
      {
        title: "Auto-Stash On Failure",
        body: "Pass `--stash-on-failure` to `cairn run` to automatically stash any run that doesn't pass. The stash is tagged with the spec name. This is best-effort: if fcheap isn't installed, the flag is silently ignored and the run continues normally. You can also enable this via config: `stash: { enabled: true, autoStash: on-failure }` in cairntrace.config.yml.",
      },
      {
        title: "Config",
        body: "Enable stash integration in cairntrace.config.yml:\n```yaml\nstash:\n  enabled: true\n  autoStash: on-failure   # or never (default)\n  tags: [regression, audit]\n```\nWhen autoStash is on-failure, every failed run is automatically stashed with the spec name and configured tags.",
      },
      {
        title: "MCP Tools",
        body: "Three MCP tools mirror the CLI: `cairn_stash_save` (stash a run by runId), `cairn_stash_list` (list stashes, optional tag/tool filter), `cairn_stash_search` (search across all stashed runs). All return structured JSON and degrade gracefully when fcheap isn't installed.",
      },
      {
        title: "DX Workflow",
        body: 'The typical workflow: run a spec → it fails → auto-stash captures the run dir → `cairn stash search "error message"` finds it later → restore or investigate. Stashes persist across retention cleanup, so you can compare a failing run from last week against today\'s passing run. The stash is the entry point for the Phase 3 investigate pipeline: `fcheap connect <stash-id> <codebase>` runs vecgrep to find the code responsible.',
      },
    ],
    examples: [
      {
        title: "stash a run",
        language: "bash",
        code: [
          "# stash the latest run",
          "cairn stash save latest --tag OPG-15061",
          "",
          "# list all stashes tagged with a spec name",
          "cairn stash list --tag login_flow",
          "",
          "# search across all stashed runs",
          'cairn stash search "redirected to /error"',
        ].join("\n"),
      },
      {
        title: "auto-stash on failure",
        language: "bash",
        code: [
          "# auto-stash any failed run",
          "cairn run flows/login.yml --stash-on-failure --cold-start",
          "",
          "# or via config",
          "# stash:",
          "#   enabled: true",
          "#   autoStash: on-failure",
        ].join("\n"),
      },
    ],
    relatedTopics: ["overview", "artifacts", "mcp"],
  },
  investigate: {
    title: "Investigate & Audit (fcheap connect + vecgrep + vidtrace)",
    summary:
      "Connect a failed run to the codebase responsible: stash run artifacts, run fcheap connect (vecgrep) to surface file:line candidates, and optionally run vidtrace extract on the run video for timestamped evidence. Requires fcheap + vecgrep on $PATH.",
    sections: [
      {
        title: "Overview",
        body: "When a spec fails, the run artifacts (agent_context.md, events.ndjson, screenshots, video) contain rich evidence about what went wrong. `cairn investigate` stashes the run to fcheap, then runs `fcheap connect <stash-id> <codebase>` — which uses vecgrep to perform semantic code search over the codebase using the stashed run's text as the query. The result is a ranked list of file:line candidates most likely responsible for the failure.",
      },
      {
        title: "cairn investigate",
        body: "`cairn investigate <run-id> --codebase <dir>` stashes the run, runs fcheap connect, and prints code matches. Accepts `--mode semantic|keyword|hybrid` (default: hybrid), `--limit <n>` (default: 10), `--connect` (default: true, use --no-connect to skip), and `--keep-stash` (keep the fcheap stash after investigate). All output supports `--format json|yaml|md`. Run-id accepts 'latest', 'previous', or a concrete run ID.",
      },
      {
        title: "cairn audit",
        body: "`cairn audit <spec-yaml> --codebase <dir>` is a convenience wrapper that: (1) runs the spec with `--backend playwright --cold-start` and video recording enabled, (2) runs `vidtrace extract` on the resulting video to produce timestamped evidence, (3) stashes the run + vidtrace evidence to fcheap, (4) runs `fcheap connect` to find code matches. Accepts `--speed <0.25-4.0>` and `--slow-mo <ms>` for video control. Requires vidtrace on $PATH for the video extraction step.",
      },
      {
        title: "Code Matches",
        body: "Each code match contains: `file` (relative path), `line` (line number), `score` (0.0–1.0 similarity), `snippet` (surrounding code). Matches are written to the run's `agent_context.md` under a '## Code Matches' section, giving agents a direct pointer to the code responsible. The matches also appear in `investigate.json` in the run directory.",
      },
      {
        title: "Config",
        body: "Configure investigate defaults in cairntrace.config.yml:\n```yaml\ninvestigate:\n  codebase: ./src          # default codebase path\n  mode: hybrid             # semantic | keyword | hybrid\n  limit: 10                # max code matches\n  keepStash: false         # keep fcheap stash after investigate\n```",
      },
      {
        title: "MCP Tools",
        body: "`cairn_investigate` mirrors the CLI: takes runId, codebase (optional, uses config default), mode, limit, keepStash. Returns structured code matches. `cairn_audit` mirrors the audit wrapper: takes spec path, codebase, speed, slowMo, mode, limit. Both degrade gracefully when fcheap/vecgrep/vidtrace aren't installed.",
      },
      {
        title: "DX Workflow",
        body: "The typical workflow: run a spec → it fails → `cairn investigate latest --codebase ~/projects/myapp` → agent_context.md now shows 'src/auth/login.ts:42 (0.89 match)' → fix the code → re-run to confirm green. For deeper analysis: `cairn audit flows/login.yml --codebase ~/projects/myapp --speed 0.5` produces a video, extracts vidtrace evidence, and connects to code — all in one command.",
      },
    ],
    examples: [
      {
        title: "investigate a failed run",
        language: "bash",
        code: [
          "# after a failed run, find the responsible code",
          "cairn investigate latest --codebase ~/projects/myapp",
          "",
          "# with specific search mode and limit",
          "cairn investigate latest --codebase ~/projects/myapp --mode semantic --limit 5",
        ].join("\n"),
      },
      {
        title: "audit a spec end-to-end",
        language: "bash",
        code: [
          "# run spec with video, extract evidence, connect to code",
          "cairn audit flows/login.yml --codebase ~/projects/myapp --speed 0.5",
          "",
          "# keep the fcheap stash for later analysis",
          "cairn audit flows/login.yml --codebase ~/projects/myapp --keep-stash",
        ].join("\n"),
      },
    ],
    relatedTopics: ["stash", "artifacts", "overview"],
  },
  annotate: {
    title: "Annotate Code (codemap)",
    summary:
      "Pin cairntrace run findings to code symbols via codemap annotate. Builds a persistent knowledge layer over the code graph — future agents querying codemap see what cairntrace flagged.",
    sections: [
      {
        title: "Overview",
        body: "After `cairn investigate` surfaces code matches (file:line candidates responsible for a failure), `cairn annotate` pins those findings to codemap symbols. The annotation persists across reindex, so any agent that later queries codemap — `codemap callers`, `codemap impact`, `codemap annotations` — sees that cairntrace flagged this location. This closes the loop: run → investigate → annotate → codemap remembers.",
      },
      {
        title: "cairn annotate",
        body: "`cairn annotate <symbol> --note <text> [--data <json>] [--source <label>]` wraps `codemap annotate`. The symbol can be a FQN, a file:line, or any string codemap accepts. Use `--from X --to Y` to annotate a call path instead of a single symbol. The `--source` defaults to `cairntrace`. The `--data` field is opaque — codemap stores it as-is, so you can pass JSON from investigate.json.",
      },
      {
        title: "Auto-Annotate",
        body: "When `annotate.autoAnnotate: on-investigate` is set in config, `cairn investigate` automatically annotates each code match into codemap after the investigate run. This is best-effort: if codemap isn't installed, the annotation step is silently skipped. The annotation note includes the run ID and match score; the data field contains the full match JSON.",
      },
      {
        title: "Config",
        body: "Configure annotate integration in cairntrace.config.yml:\n```yaml\nannotate:\n  enabled: true\n  autoAnnotate: on-investigate   # auto-annotate after investigate\n  source: cairntrace             # default source label\n```",
      },
      {
        title: "MCP Tool",
        body: "`cairn_annotate` mirrors the CLI: takes symbol, note, optional source and data. Returns the annotation ID and whether the symbol was matched in the indexed graph. Degrades gracefully when codemap isn't installed.",
      },
      {
        title: "DX Workflow",
        body: 'The full workflow: `cairn run flows/login.yml` → fails → `cairn investigate latest --codebase ~/projects/myapp` → code matches in agent_context.md → `cairn annotate src/auth/login.ts:42 --note "login_flow fails: redirects to /error"` → `codemap impact handleSubmit` now shows the annotation. Or with auto-annotate: just run investigate and it\'s automatic.',
      },
    ],
    examples: [
      {
        title: "annotate a code match",
        language: "bash",
        code: [
          "# after investigate surfaces src/auth/login.ts:42",
          'cairn annotate "src/auth/login.ts:42" --note "login_flow fails: redirect to /error instead of /dashboard"',
          "",
          "# with JSON data from the investigate result",
          'cairn annotate "src/auth/login.ts:42" --note "failed run OPG-15061" --data \'{"runId":"...","score":0.89}\'',
        ].join("\n"),
      },
      {
        title: "annotate a call path",
        language: "bash",
        code: [
          "# annotate the path from handleSubmit to navigateTo",
          'cairn annotate handleSubmit --from handleSubmit --to navigateTo --note "cairntrace: this path navigates to /error"',
        ].join("\n"),
      },
    ],
    relatedTopics: ["investigate", "stash", "overview"],
  },
  secrets: {
    title: "Secrets (TinyVault)",
    summary:
      "Use TinyVault as a secrets provider for authenticated specs. Secret values never enter the AI context — tvault injects them into the subprocess environment at run time.",
    sections: [
      {
        title: "Overview",
        body: "Authenticated specs need credentials (API keys, database URLs, session tokens). TinyVault stores them encrypted locally and injects them into subprocess environments via `tvault run`. Cairntrace integrates with tvault as a config-level secrets provider, so spec authors never hardcode secrets and agent_context.md never exposes them.",
      },
      {
        title: "cairn secrets",
        body: "`cairn secrets [--project <name>]` checks the tvault status and lists available secret keys (metadata only — values are never shown). This is a pre-flight check: verify that the required keys exist before running a spec that depends on them.",
      },
      {
        title: "Config",
        body: "Enable tvault as the secrets provider in cairntrace.config.yml:\n```yaml\nsecrets:\n  provider: tvault\n  required: [API_KEY, DATABASE_URL]\n  tvault:\n    project: myapp-test\n    identity: ci\n```\nWhen provider is tvault, `cairn run` wraps the backend launch in `tvault run --project myapp-test -- <command>`, injecting all project secrets as environment variables. The `required` list is checked before the run starts — missing keys fail fast with a clear error.",
      },
      {
        title: "MCP Tool",
        body: "`cairn_secrets_status` mirrors the CLI: takes an optional project name, returns tvault installation status and the list of secret keys. Values are never returned — only key names. For actual secret injection in commands, use TinyVault's own MCP tools (`vault_run_with_secrets`).",
      },
      {
        title: "DX Workflow",
        body: "The typical workflow: store secrets in tvault (`tvault set API_KEY ...`) → configure `secrets.provider: tvault` in cairntrace.config.yml → `cairn secrets --project myapp-test` verifies keys exist → `cairn run flows/auth.yml --cold-start` runs the spec with secrets injected. The spec YAML uses `${vars.API_KEY}` or environment variables — never hardcoded values.",
      },
      {
        title: "Security",
        body: "Secret values are NEVER written to artifacts: not in agent_context.md, not in events.ndjson, not in run.json. The ArtifactWriter redacts Authorization, Cookie, and Set-Cookie headers. tvault's own output redaction also catches any secret values that leak into command output. This is defense-in-depth: even if a spec captures a response header, the artifact is redacted.",
      },
    ],
    examples: [
      {
        title: "check tvault status",
        language: "bash",
        code: [
          "# check if tvault is installed and list keys",
          "cairn secrets --project myapp-test",
          "",
          "# configure in cairntrace.config.yml",
          "# secrets:",
          "#   provider: tvault",
          "#   required: [API_KEY, DATABASE_URL]",
          "#   tvault:",
          "#     project: myapp-test",
        ].join("\n"),
      },
    ],
    relatedTopics: ["overview", "artifacts", "mcp"],
  },
  services: {
    title: "Services Lifecycle (docker + seed + tmux)",
    summary:
      "The `services:` block in cairntrace.config.yml lets `cairn run` own the full multi-service environment: docker infrastructure, conditional data seeding (TTL-based freshness), and a tmux session with service windows. Starts once before the spec pool, stops once after.",
    sections: [
      {
        title: "Overview",
        body: "For projects that need multiple services running before specs can execute (docker containers, a seeded database, a tmux session with 8 service tabs), the `services:` block automates the entire lifecycle. It starts once before the spec pool — like `webServer` but for multi-process environments — and tears down once after all specs finish. Each phase is optional: configure only docker, only seed, only tmux, or any combination.",
      },
      {
        title: "Docker Phase",
        body: "The `docker` step runs a shell command (typically `docker compose up -d`) and waits for it to complete. `reuseExisting` defaults to true (locally): if `docker compose ps` shows running containers, the step is skipped. Under `--cold-start` or CI, reuse flips to false. The `readyTimeoutMs` bounds how long to wait (default 120s).",
      },
      {
        title: "Conditional Seed",
        body: "The `seed` step runs a data-import command conditionally based on three layers of freshness: (1) fingerprint — a SHA-256 of the command + env keys (not values, so secret rotation doesn't trigger re-seed); (2) TTL — re-seed if the last run was more than `ttlSeconds` ago; (3) optional `freshnessCheck` — a shell command whose exit 0 means data is fresh. State is tracked in `~/.cairntrace/services/<project>.seed.json`. Set `ttlSeconds: 0` (default) to always re-seed unless `freshnessCheck` passes. When `secrets.provider: tvault` is configured, the seed command's env is augmented with tvault secrets — this is where `getTvaultEnv` is actually called from the run path.",
      },
      {
        title: "tmux Phase",
        body: "The `tmux` step creates a tmux session from scratch via `tmux new-session -d`, then creates N windows, each running one service. `reuseExisting` defaults to true: if the session already exists, it's reused. Under `--cold-start`, any existing session is killed first. Each window has a `name` (must be unique), `cwd` (relative to configDir or absolute), `command`, optional `readyOn` readiness signal, optional `env` (per-window env merged over session env + process.env), and optional `preCommands` (run before the main command, e.g. `yarn build` before `yarn start`). Readiness is probed via `readyOn.url` (HTTP probe) or `readyOn.text` (tmux capture-pane text match). `readyTimeoutMs` bounds the total wait (default 90s). Session-level `options` are applied via `tmux set-option` after creation (e.g. `mouse: on`, `history-limit: 50000`). Session-level `env` applies to all windows. `defaultShell` sets the shell for `tmux new-session`.",
      },
      {
        title: "Healthchecks",
        body: "Both docker and individual tmux windows support a `healthcheck` block — modeled on Docker's healthcheck semantics. It runs a command after the service is ready: `command` is the check command (exit 0 = healthy), `startPeriodSeconds` is a grace period before the first check (default 0), `intervalSeconds` is the delay between retry attempts (default 30), `timeoutSeconds` bounds each check (default 10), and `retries` is the max attempts before marking unhealthy (default 3). Healthcheck failure is a WARNING — it does not fail the run, it logs a diagnostic. This mirrors Docker Compose healthcheck semantics and lets you catch infra that started but isn't healthy (e.g. ES responding on 9200 but cluster is red).",
      },
      {
        title: "Docker Readiness Check",
        body: "The `docker.readinessCheck` field runs a shell command after `docker compose up` completes. Exit 0 means infra is ready; non-zero fails the run with the stderr tail. Use this when `docker compose up -d` returns before the services are actually reachable (e.g. `curl -sf http://localhost:27017` for mongo).",
      },
      {
        title: "Config Validation",
        body: "Run `cairn config validate [--config <path>]` to validate a cairntrace.config.yml file. Checks structure (zod schema), cross-field rules (unique tmux window names, readyOn must have url or text, tvault provider requires tvault block), and reports all errors with JSON-path locations. Exit 0 = valid, 4 = invalid. Supports `--format json|yaml|md`.",
      },
      {
        title: "Teardown",
        body: "Teardown commands run in reverse order after all specs finish (best-effort, non-fatal). The tmux session is killed if we started it. `--no-services` skips the entire block when you manage the environment out of band. Ctrl-C / SIGTERM triggers synchronous tmux kill via the cleanup tracker.",
      },
      {
        title: "Secrets Integration",
        body: "When `secrets.provider: tvault` is set, the seed command runs with tvault secrets injected into its environment. The `${MONGO_SOURCE_PASSWORD}` and `${ES_SOURCE_PASSWORD}` placeholders in the seed command are resolved from tvault — secret values never appear in the spec YAML, config file, or agent context.",
      },
      {
        title: "Session Stash (fcheap)",
        body: "The `services.stash` block optionally saves the session artifacts (tmux pane captures, docker logs, seed output) to fcheap after teardown. Set `enabled: true` (default false) and choose which phases to capture with `capture: [tmux, docker, seed]` (default all). `tags: [services, graphite]` adds searchable tags. `autoStash: always` stashes on every stop; `on-failure` (default) only when the run has failures. This is best-effort — if fcheap isn't installed, stashing is silently skipped. Stashed artifacts persist beyond retention cleanup and are searchable via `cairn stash search`.",
      },
      {
        title: "Services Status",
        body: "Run `cairn services status [--config <path>]` to check the current state of the services environment without starting anything. Reports: docker (running/stopped), seed (last run, TTL expiry, freshness), tmux (session exists, window pane tails). Supports `--format json|yaml|md`. Also available as the `cairn_services_status` MCP tool — agents can query the environment before deciding to run specs.",
      },
      {
        title: "Dry-Run Mode",
        body: "Pass `--services-dry-run` to `cairn run` to preview the services lifecycle plan without executing anything. Prints the docker/seed/tmux/teardown configuration to stderr, then returns a no-op handle. No docker commands run, no tmux session is created, no seed is executed. Use this to verify your `services:` block is correctly configured before a real run.",
      },
      {
        title: "Lifecycle Events",
        body: "The services lifecycle emits structured events via the `onEvent` callback. Each event has a `phase` (docker, seed, tmux, teardown, stash), an `action` (start, ready, skip, fail, done), a timestamp, and optional details (e.g., the seed freshness verdict, the tmux window name, the healthcheck result). These events are collected in the `ServicesHandle.events` array and can be written to `events.ndjson` by the runner for post-run diagnostics.",
      },
    ],
    examples: [
      {
        title: "full services block (cairntrace.config.yml)",
        language: "yaml",
        code: [
          "project: graphite",
          "secrets:",
          "  provider: tvault",
          "  required: [MONGO_SOURCE_PASSWORD, ES_SOURCE_PASSWORD]",
          "  tvault:",
          "    project: graphite",
          "services:",
          "  docker:",
          "    command: docker compose up -d",
          "    readyTimeoutMs: 120000",
          "    readinessCheck: curl -sf http://localhost:27017",
          "    healthcheck:",
          "      command: curl -sf http://localhost:9200/_cluster/health | grep -q green",
          "      startPeriodSeconds: 10",
          "      intervalSeconds: 15",
          "      timeoutSeconds: 5",
          "      retries: 5",
          "  seed:",
          "    command: >",
          "      yarn demo-import",
          "      --mongoSourceUri mongodb+srv://admin:${MONGO_SOURCE_PASSWORD}@host/db",
          "      --esSourceUri https://elastic:${ES_SOURCE_PASSWORD}@es.example.io",
          "      --mongoLocalUri mongodb://localhost:27017",
          "      --esLocalUri http://localhost:9200",
          "    ttlSeconds: 21600",
          "    freshnessCheck: mongosh --quiet --eval 'db.something.countDocuments()' mongodb://localhost:27017/test",
          "  tmux:",
          "    session: graphite",
          "    readyTimeoutMs: 90000",
          "    options:",
          '      - { key: mouse, value: "on" }',
          '      - { key: history-limit, value: "50000" }',
          "    env:",
          "      NODE_ENV: development",
          "    windows:",
          "      - name: web-app",
          "        cwd: web-app",
          "        command: yarn serve",
          "        readyOn: { url: http://localhost:8080 }",
          "      - name: web-api",
          "        cwd: web-api",
          "        command: yarn dev-watch",
          "        env:",
          '          PORT: "3001"',
          "        readyOn: { text: listening on }",
          "      - name: answers",
          "        cwd: answers",
          "        command: yarn start",
          "        preCommands:",
          "          - yarn build",
          "        readyOn: { text: server started }",
          "      - name: warehouse",
          "        cwd: go/app/warehouse",
          "        command: go run .",
          "        readyOn: { text: listening on }",
          "        healthcheck:",
          "          command: curl -sf http://localhost:8081/healthz",
          "          intervalSeconds: 20",
          "          retries: 3",
          "  stash:",
          "    enabled: true",
          "    capture: [tmux, docker, seed]",
          "    autoStash: always",
          "    tags: [services, graphite]",
          "  teardown:",
          "    - tmux kill-session -t graphite",
          "    - docker compose down",
        ].join("\n"),
      },
      {
        title: "skip services when managing out of band",
        language: "bash",
        code: "cairn run flows/ --no-services --cold-start",
      },
      {
        title: "validate config before running",
        language: "bash",
        code: "cairn config validate --config cairntrace.config.yml --json",
      },
      {
        title: "check services environment status",
        language: "bash",
        code: "cairn services status --config cairntrace.config.yml --json",
      },
      {
        title: "preview services lifecycle without executing",
        language: "bash",
        code: "cairn run flows/ --services-dry-run",
      },
    ],
    relatedTopics: ["backends", "secrets", "overview"],
  },
};
