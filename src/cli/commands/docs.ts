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
        body: "`cairn explain`, `cairn docs`, `cairn run`, `cairn snapshot`, `cairn import playwright`, `cairn spec verify`, `cairn spec heal`, `cairn diff`, and `cairn stats` all support structured output formats where applicable. MCP tools return the same structured content without shell parsing. Use `cairn run --label path=temporal` then `cairn stats --group-by path` for A/B cohort stats (rabbit vs temporal).",
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
        body: "Every finished spec must replay from a clean browser. Satisfy that with an imported login action, `session.resume`, deterministic `preconditions.commands`, or `coldStart: guest` for an intentionally public/sessionless flow. The guest acknowledgement suppresses setup lint but does not skip replay. Before calling a spec done, run `cairn spec verify <spec> --config <path> --json` when using config variables, then run `cairn run <spec> --cold-start --json`.",
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
        body: "Set the browser viewport per environment (`environments.<env>.viewport: { width, height }`) or per spec (top-level `viewport:`); spec wins. High-latency environments can set `environments.<env>.waitScale: 3` (overridden by `CAIRN_WAIT_SCALE`) to multiply wait/settle budgets and the 500ms network-idle quiet window. Bound artifact disk usage with `retention`: `keepRuns` (newest N runs per spec, pruned after every run — default 3 when no `retention` block is set; `retention: { enabled: false }` keeps everything), `archiveToStash: true` (archives pruned run dirs to fcheap before deletion — best-effort; if the archive fails the run is retained), and explicit `publish: { enabled: true, retentionDays: 7 }` (packages a bounded complete run for private file.cheap publication; deletion waits for a byte-matching `server-sha256` receipt). `cairn clean [--keep N | --all]` prunes manually with the same defaults. Traces follow `artifacts.capture.trace` — the on-failure default deletes the trace zip on passing runs. Videos follow `artifacts.capture.video` (default `never`) — opt in with `always` or `on-failure` for audit-grade recordings.",
      },
      {
        title: "Logging",
        body: "All diagnostic/lifecycle logs go to stderr — stdout is reserved for structured results (JSON/YAML/markdown). Control verbosity with `--log-level <debug|info|warn|error|silent>`, `--quiet` (warn), or `--verbose` (debug); default is info on a TTY, warn in CI/piped. `--log-format json` emits one NDJSON object per log line for machine consumption (human is the default). `--no-color` / `NO_COLOR` disable ANSI. Set project defaults in `cairntrace.config.yml` under `logging: { level, format, color }`; flags and env (`CAIRN_LOG_LEVEL`, `CAIRN_LOG_FORMAT`) override the config. The services lifecycle (docker/seed/tmux) and live subprocess output stream through the logger at info, so `--quiet` suppresses them while warnings/errors always show.",
      },
      {
        title: "Authoring Helpers",
        body: "`cairn snapshot <url>` opens a page and reports role and `data-testid` locators for agent-friendly step authoring (pass `--wait-until networkidle` for SPAs so the inventory isn't captured pre-hydration; role entries with multiple matches note that `nth` is needed to disambiguate). `cairn import playwright <file>` converts common Playwright `page.goto`, locator actions, request calls, and `expect` assertions into reviewable YAML with TODO comments for unmapped lines. `cairn run <dir> --junit reports/cairn.xml` expands YAML specs recursively for CI, skipping imported `actions/` directories and `_*.yml` / `_*.yaml` drafts. `--stamp-if-green` stamps contract hashes only after every requested spec passes.",
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
        title: "config-backed spec",
        language: "yaml",
        code: [
          "# flows/table-import.yml",
          "version: 1",
          "name: table_import",
          "intent: Admin can open a configured connection.",
          "vars:",
          "  connectionPath: /connection/from-spec",
          "  testUser: player-${worker.index}-${run.token}",
          "outcomes:",
          "  - id: connection_opened",
          "    description: the configured connection is visible",
          '    verify: { url: { matches: "/connection/" } }',
          "steps:",
          '  - open: "${vars.connectionPath}"',
        ].join("\n"),
      },
      {
        title: "config variables for the spec",
        language: "yaml",
        code: [
          "# cairntrace.config.yml",
          "version: 1",
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
        body: "`open` navigates (object form `{ path, waitUntil, timeoutMs }` waits out SPA hydration), `click` activates a locator (`click.until` retries up to four times until selectorGone|selector|text|notText holds), `hover` reveals hover-only controls, `fill` sets a field value, and `type` types character-by-character as real keyboard events (`delayMs` optionally paces keystrokes). Fill/type re-read the live value after a 500ms settle and retry three times if hydration wipes it; set sibling `verifyFill: false` only for controls whose transformed/masked DOM value intentionally differs. `select` chooses a native <select> option by `value` or `label` (exactly one), `upload` sets a file input, `download` clicks and captures a file artifact, `transform` runs a Node script to create a new artifact, `request` makes an authenticated API call and captures the response, `wait` waits for text/notText/selector/load state, `press` sends a keyboard key, `scroll` scrolls by direction or to a locator, `snapshot` captures the page, `use` invokes an imported reusable action, and `batch` runs a chain of selector interactions in one backend invocation. Text/notText waits and click.until text conditions normalize whitespace and are case-insensitive.",
      },
      {
        title: "Batch Steps",
        body: "`batch` runs ≥2 selector sub-steps in a SINGLE backend invocation (agent-browser `batch --bail`), so transient UI state — a hover popover, focus, an open menu — survives long enough to act on it instead of being lost to a fresh CLI process per step. Sub-steps are `click`/`hover`/`fill`/`type`/`upload`/`press`/`scroll`/`wait` and must use `by: selector` (semantic locators need their own snapshot round-trip, which would break the single invocation). Clicks are paced by 100ms; checkbox/radio/switch state (including aria-checked=mixed) is re-queried after framework rerenders, gets a 300ms post-action grace, then one live-element recovery click before failing loudly. Every command must return an explicit success result; the first failing or missing result fails the whole step. Artifact placeholders are not resolved inside batch sub-steps; use a top-level `upload`/`download` step for those.",
      },
      {
        title: "Locators",
        body: "Interactive steps use locators with `by: role`, `by: label`, `by: text`, or `by: selector`. Prefer role or label locators because they are easier to heal and easier for agents to understand. Semantic locators match ACCESSIBLE names (what the snapshot shows, post-CSS-text-transform): whole-name, case-insensitive, visible elements only. Substring matching is not supported. Zero matches fail the step with candidate diagnostics; multiple matches are a hard error — disambiguate with `exact: true` (case-sensitive), `nth: <index>` (0-based, document order), or a more specific name. Targets are scrolled into view automatically before the action.",
      },
      {
        title: "Click Settling",
        body: "Agent-browser confirms same-tab link delivery from URL, document, or DOM evidence by default without an implicit network-idle wait. A positive click-step or top-level spec `settleMs`, or config `browser.postClickSettleMs`, explicitly adds network-idle settling; click/spec values take precedence over config. Playwright honors explicit click/spec values and otherwise keeps its native action/navigation waits. Set `settleMs: 0` to skip both the extra settle and the link-delivery probe at that scope; `browser.verifyAfterClick: false` disables the agent-browser guard globally. `click.until` is for authored effect confirmation: `{ until: { selectorGone: '#editor', timeoutMs: 12000 } }` retries the click with backoff, at most four total clicks. `environments.<env>.waitScale`/`CAIRN_WAIT_SCALE` multiplies authored waits, settles, and the network-idle quiet window.",
      },
      {
        title: "Request Steps",
        body: "`request` uses the browser session's cookies but is timeout-bounded. On the Playwright backend it runs out of page through a browser-context cookie transport (`APIRequestContext` when safe; an isolated Bun cookie bridge under Bun), which sends existing context cookies and persists `Set-Cookie` responses back into the browser context. The Bun bridge runs in a subprocess so the parent can kill it at `timeoutMs` even if native fetch stalls. Backends without a native request primitive use a bounded page-fetch fallback. Relative URLs resolve against config `baseUrl` when present, otherwise against the current page origin; request-first relative URLs therefore need `baseUrl`. The default request timeout is 30000ms, and `timeoutMs` overrides it per step. `assign: name` writes the `{url, method, status, ok, headers, body}` envelope to `requests/<name>.json` and lets later steps and fixtures splice fields via `${requests.<name>.body.<field>}` or `${requests.<name>.status}`. `expectStatus` fails the step on unexpected statuses; omit it for negative-path flows. Request-step calls are also mirrored into network evidence so `network` and `noFailedRequests` verifiers can match them.",
      },
      {
        title: "Eval Steps",
        body: "`eval` is a page-context JavaScript escape hatch — the last-resort locator-free step. It runs arbitrary JS in the browser via `backend.evaluate()` and optionally captures the JSON-serializable return value as `evals/<assign>.json`. Use it for state setup and internal-state assertions that no UI affordance can reach (seed a Vuex/Redux/Pinia store, read `localStorage`, assert on a computed property). Provide exactly one of `js` (inline source) or `file` (path to a .js file, resolved against specDir). Optional `args` is passed as the single argument to the wrapped function, avoiding `${}` string injection. `assign: name` writes `{ value: <return> }` to `evals/<name>.json` and lets later steps splice fields via `${evals.<name>.value.<field>}`. The captured value is redacted before writing. `eval` is opaque to `heal` — there is no locator to repair, so a failing eval step is a real error, not selector drift. Page-context only: no Node/fs access (that is what `transform` is for). The app must expose a handle to mutate state (e.g. a dev-only `window.__APP__` store ref); that is an app concern, not cairntrace's.",
      },
      {
        title: "Reusable Actions",
        body: "Reusable actions imported via `imports:` use the same step schemas as normal specs, including `hover`, `fill.value`, `upload.path`, `download.saveAs`, and `transform.saveAs`.",
      },
      {
        title: "Process Monitoring",
        body: "`monitor` captures a process profile (`action: profile`, with `type: heap|cpu|goroutine|sample`) or a one-shot sample (`action: snapshot`) of the backend's browser process tree at a point in the flow, via the external `monitor` CLI. It targets `backend.browserPid()`, so it fails if no browser has spawned yet or `monitor` isn't on PATH. With `assign`, the result is written to `monitor/<assign>.json` and registered as a named artifact reusable via `${artifacts.<assign>.path}`. Pair it with `cairn run --monitor` (which samples CPU/RSS across the whole run) and the `process` verifier to assert perf budgets.",
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
          "  - select: { by: label, name: Plan, value: pro }",
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
        body: "`text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`, and `httpJson` cover common UI, navigation, network, console, workbook, on-disk, and backend-JSON assertions. Text/notText `equals` and `contains` normalize whitespace and are case-insensitive by default; set `caseSensitive: true` to opt out. Regex `matches` remains raw and case-sensitive. `text.region` and `notText.region` optionally scope text checks to a selector; the old sibling `region` shape is still accepted for compatibility. `file` polls a glob (filename wildcards, relative to the spec dir) until a matching file exists and optionally contains a needle. `httpJson` fetches JSON in the browser session with cookies, resolves relative URLs through config `baseUrl` or the current page origin, walks a simple dotted JSON path like `$.game.score`, and applies `equals`/`contains`/`matches`/numeric/`exists` matchers.",
      },
      {
        title: "Script Escape Hatch",
        body: "`script` defaults to browser page context and must return `{ ok, evidence }`. Set `runtime: node` to run a JS/TS module in Node with filesystem and npm package access.",
      },
      {
        title: "Process Budget",
        body: "`process` asserts on monitor-reported browser process metrics collected by `cairn run --monitor` (or a run launched under `MONITOR=1`): `peakRss`, `meanRss`, `finalRss` (megabytes), `peakCpu`, `meanCpu` (summed tree CPU percent), and `samples` (count). Each matcher is `{ below | atLeast | equals }` and all present matchers must pass. It reports `skipped` (not `failed`) when the run wasn't monitored, so a spec carrying a perf budget doesn't fail on every non-monitored run. The sampler writes `diagnostics/process.{md,json}` with the timeline and final `monitor tree`.",
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
        body: "Run directories include `run.{json,yaml,md}`, `report.html`, `report.json`, `agent_context.md`, `artifact-manifest.json`, `replay.json`, `events.ndjson`, `spec.resolved.yml`, per-outcome evidence, snapshots, screenshots, console logs, network logs, traces, and videos. A successful automatic stash also adds `stash-receipt.json`. If a multi-spec run receives SIGINT/SIGTERM, completed run directories are retained and a strict `aborted-<timestamp>-<pid>.json` partial batch summary is written at the artifact root before teardown.",
      },
      {
        title: "Traces And Videos",
        body: "Traces follow `artifacts.capture.trace` (default `on-failure` — the trace zip is deleted on passing runs). Videos follow `artifacts.capture.video` (default `never` — opt in with `always` or `on-failure`). Videos are saved as `videos/<backend>-video.webm`; the Playwright backend supports video natively via context-level `recordVideo`. `cairn audit` writes optional vidtrace output under the same run's `videos/vidtrace/`. Playwright WebM is video-only, so audit creates a disposable silent-audio copy only when Whisper extraction needs one, then removes it. Extracted text formats are redacted after extraction; frames/images are not. When steps execute too quickly to audit, configure `artifacts.video.slowMo` and `artifacts.video.speed`.",
      },
      {
        title: "Reports",
        body: "`report.html` is self-contained and print-friendly for sharing or saving as PDF. It summarizes status, timing, outcomes, steps, and artifact links. `report.json` exposes the same redacted report model for custom renderers, including selected theme tokens and built-in theme definitions. Configure styling with `report.theme: cairn|slate|midnight|contrast` and `report.colors` in `cairntrace.config.yml`; there is no separate report theme config file.",
      },
      {
        title: "Downloads And Diagnostics",
        body: "Download steps save files under `downloads/`. Transform steps save generated fixtures under `transforms/`. Request steps save response envelopes under `requests/`. Eval steps save captured return values under `evals/`. Failed steps write diagnostics under `diagnostics/` with current URL, visible controls, table headers, selector counts, and nearby text excerpts; every interactive step also records the element it actually hit (role/name/ref) in its StepResult and events.ndjson.",
      },
      {
        title: "Agent Handoff",
        body: "Use `cairn context latest` or MCP `cairn_context` to hand an agent the compact markdown summary instead of flooding context with every raw artifact. After investigation, its generated Code Matches section includes ranked `file:line` pointers and scores but deliberately omits raw source snippets; the redacted `investigate.json` remains the detailed structured result. The CLI resolves `latest` inside `--artifact-root`, config `artifactRoot`, or the global default, in that order.",
      },
      {
        title: "Redaction Boundary",
        body: "Cairntrace redacts Cairntrace-authored text and structured JSON before writing them: reports, run records, event streams, network and console text, eval/request values, investigation results, and outcome sidecars use the configured literal-value scrubber plus sensitive-key/header heuristics. Producer-owned files usually bypass that layer: screenshots/videos can show rendered secrets, while downloads/transforms/traces preserve source content. Audit adds a post-extraction pass for vidtrace `.json`, `.txt`, `.srt`, `.tsv`, `.vtt`, `.md`, and `.csv`; extracted frames/images remain uninspected. Treat the run directory as sensitive and review producer-owned output before sharing or stashing it.",
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
        title: "Discovery Tools",
        body: "Nine `cairn_discover_*` tools provide interactive page exploration: open a session, snapshot, interact (click/fill/hover/scroll/press), navigate, collect inventory, suggest recorded steps, export as spec YAML, and close. Sessions are stateful and auto-expire after 5 min. See `cairn docs discovery` for the full workflow.",
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
    relatedTopics: ["overview", "artifacts", "backends", "discovery"],
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
        title: "agent-browser Providers (iOS / Cloud)",
        body: 'The agent-browser backend accepts a provider via `--provider <name>` (or config `browser.provider`): `ios` drives Mobile Safari through Appium (macOS + Xcode + `appium driver install xcuitest` required; web-only, first launch boots the simulator in ~30-60s), and cloud providers (`browserbase`, `kernel`, `browseruse`, `browserless`, `agentcore`) connect to a remote browser. Pair `--device "iPhone 15 Pro"` (or config `browser.device`) with `--provider ios` to pick a simulator/device. These flags are accepted by `cairn run`, `discover`, `snapshot`, `spec heal`, `login`, and `checkpoint capture-from-session`. iOS runs use the same spec/contract/artifacts as desktop; touch-only flows should avoid `hover` (no touch equivalent). State capture/resume (`state save/load`) and CDP-only features (traces, HAR) are unverified on the iOS/WebDriver transport — validate before relying on them for authenticated mobile flows.',
      },
      {
        title: "Timeouts And Cleanup",
        body: "Cairn enforces a hard deadline on browser-backend invocations. agent-browser uses a 60s default with step-level `timeoutMs` + 5s grace; a wedged daemon gets killed and the step fails with a normal timeout error instead of hanging the run. Playwright `wait` and browser `evaluate` paths also have Cairntrace-side deadlines (30000ms default, or `timeoutMs` when supplied). Real Chromium runs start an external watchdog process that kills the browser at the deadline, so page navigation churn cannot leave the suite waiting on Playwright forever. Ctrl-C / SIGTERM tears down the run's own browser session before exiting; other sessions are untouched.",
      },
      {
        title: "Post-click Settling",
        body: "On agent-browser, `browser.verifyAfterClick` defaults to true and confirms same-tab link delivery without an implicit network-idle wait. Positive click/spec `settleMs` values or `browser.postClickSettleMs` opt into network-idle settling; click/spec values take precedence over config. Playwright honors explicit click/spec values and otherwise keeps native waits. A resolved `settleMs: 0` skips both the extra settle and the link-delivery probe. Per-environment `waitScale` (or `CAIRN_WAIT_SCALE`) multiplies authored waits/settles and extends the fixed ~500ms network-idle quiet window when one is requested.",
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
        title: "run on iOS Safari or a cloud browser (agent-browser provider)",
        language: "bash",
        code: [
          'cairn run flows/checkout.yml --provider ios --device "iPhone 15 Pro"',
          'cairn snapshot http://localhost:3000 --provider ios --device "iPhone 15 Pro" --wait-until networkidle',
          "# or set it project-wide in cairntrace.config.yml:",
          '# browser: { provider: ios, device: "iPhone 15 Pro" }',
        ].join("\n"),
      },
      {
        title: "webServer block (cairntrace.config.yml)",
        language: "yaml",
        code: [
          "version: 1",
          "environments:",
          "  local: { baseUrl: http://127.0.0.1:3000 }",
          '  ci: { baseUrl: "http://localhost:${env.APP_PORT}" }',
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
        body: "Cairntrace run directories are self-contained: run.json, agent_context.md, events.ndjson, screenshots, snapshots, traces, and videos. Stashing them to file.cheap persists them beyond retention cleanup, makes them searchable across runs on this machine, and enables the investigate pipeline (Phase 3: fcheap connect → vecgrep → code matches). The local vault is not uploaded or replicated automatically.",
      },
      {
        title: "CLI Commands",
        body: "`cairn stash save <run-id>` stashes a run directory (run-id: run id, 'latest', or 'previous'). `cairn stash list` lists stashes (optionally filtered by --tag or --tool). `cairn stash info <stash-id>` shows detailed metadata. `cairn stash restore <stash-id> [--to <dir>]` restores a stash. `cairn stash search <query>` searches across all stashed runs (supports --mode keyword|semantic|hybrid). All commands support --format json|yaml|md.",
      },
      {
        title: "Auto-Stash On Failure",
        body: "Pass `--stash-on-failure` to `cairn run` to automatically stash any run that doesn't pass. The stash is tagged with the spec name. This is best-effort: if fcheap isn't installed, Cairntrace logs a warning and the run continues normally. After a successful or partial save, the local run gains a redacted `stash-receipt.json`, an `artifact.stash` event, and a refreshed artifact manifest. The receipt excludes paths, stderr, tags, and failure messages and does not change the finalized run result. Because the save happens first, Cairntrace does not recursively add this local receipt to the already-created stash. If the active redactor would alter the stash ID, Cairntrace fails closed and writes neither an unusable receipt nor a misleading event. You can also enable this via config: `stash: { enabled: true, autoStash: on-failure }` in cairntrace.config.yml.",
      },
      {
        title: "Config",
        body: "Enable stash integration in cairntrace.config.yml:\n```yaml\nversion: 1\nenvironments:\n  local: {}\nstash:\n  enabled: true\n  autoStash: on-failure   # or never (default)\n  tags: [regression, audit]\n```\nWhen autoStash is on-failure, every failed run is automatically stashed with the spec name and configured tags.",
      },
      {
        title: "MCP Tools",
        body: "Five MCP tools mirror the CLI: `cairn_stash_save` (stash a run by runId), `cairn_stash_list` (list stashes, optional tag/tool filter), `cairn_stash_info` (validated manifest metadata), `cairn_stash_restore` (restore with required hash verification), and `cairn_stash_search` (search across all stashed runs). Save results expose the resolved `runId` and file.cheap identifier as `stashId`. Info and restore declare output schemas and validate file.cheap v0.30 JSON. Operational failures return stable structured error codes and hints; an unverified restore preserves its receipt under `structuredContent.restore`.",
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
          "cairn stash save latest --tag blank-row-regression",
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
      "Connect a failed run to the codebase responsible: stash run artifacts, run fcheap connect (vecgrep) to surface file:line candidates, and optionally extract timestamped video evidence with vidtrace. Investigate requires fcheap; connection also requires vecgrep. Audit can run without either integration.",
    sections: [
      {
        title: "Overview",
        body: "When a spec fails, the run artifacts (agent_context.md, events.ndjson, screenshots, video, clips) contain rich evidence about what went wrong. `cairn investigate` stashes the run to fcheap, then runs `fcheap connect <stash-id> <codebase>` — which uses vecgrep to perform semantic code search over the codebase using the stashed run's text as the query. The result is a ranked list of file:line candidates most likely responsible for the failure.",
      },
      {
        title: "cairn investigate",
        body: "`cairn investigate <run-id>` always stashes the resolved run, so it requires fcheap. Passing `--codebase <dir>` implies `--connect`; passing `--connect` alone uses `investigate.codebaseDir` from config. An explicit CLI codebase path resolves from the current working directory, while configured `codebaseDir` resolves from the directory containing the config file. `--index` asks file.cheap to build or refresh the vecgrep index before connecting. `--query` overrides the extracted query, `--clips` prefers `videos/clips/` when present, and `--mode`/`--limit` override config defaults. Contract or subprocess failures include `error` and exit 2.",
      },
      {
        title: "cairn audit",
        body: "`cairn audit <spec-yaml>` uses the normal configured web-server, services, and TinyVault lifecycle, then forces a cold Playwright run with video capture even when the spec's video policy is `never`. Optional vidtrace output stays under `videos/vidtrace/`; a disposable silent-audio copy bridges Playwright's video-only WebM to Whisper and is removed afterward. Cairntrace redacts extracted vidtrace text formats; frames/images still require review. The browser audit itself does not require file.cheap or vecgrep. It stashes/connects only when requested, or auto-stashes a failed run when explicitly configured. `--index` refreshes vecgrep before connection; `--no-cold-start` reuses browser state.",
      },
      {
        title: "Code Matches",
        body: "Each detailed code match in the redacted `investigate.json` contains `file`, `line`, `score`, and the surrounding `snippet`. The generated `agent_context.md` Code Matches section intentionally includes only ranked `file:line` pointers and scores, not raw source snippets, so the compact handoff does not duplicate source text.",
      },
      {
        title: "Config",
        body: "Configure investigate defaults in cairntrace.config.yml:\n```yaml\nversion: 1\nenvironments:\n  local: {}\ninvestigate:\n  codebaseDir: ./src       # resolved from the config directory\n  mode: hybrid             # semantic | keyword | hybrid\n  limit: 10                # max code matches\n  index: false             # build/refresh vecgrep before connecting\n  autoInvestigate: never   # on-failure | never\n```\nExplicit `--codebase` paths resolve from the current working directory; relative `codebaseDir` values resolve from the config file. When auto-investigation and config auto-stash are both enabled, Cairntrace reuses the validated stash receipt instead of saving the run twice.",
      },
      {
        title: "MCP Tools",
        body: "`cairn_investigate` and `cairn_audit` call the same shared pipelines as the CLI and return the same structured results without writing command output into MCP stdio. They declare and validate `urn:cairntrace.dev:investigate:v1` and `urn:cairntrace.dev:audit:v1` MCP output schemas, including error-shaped results. Both accept optional config/artifact-root overrides. Required-stage failures set `isError`; optional vidtrace failures remain visible in `warnings`.",
      },
      {
        title: "DX Workflow",
        body: "The typical workflow: run a spec → it fails → `cairn investigate latest --codebase ~/projects/myapp` → agent_context.md now shows 'src/auth/login.ts:42 (0.89 match)' → fix the code → re-run to confirm green. For deeper analysis: `cairn audit flows/login.yml --codebase ~/projects/myapp --speed 0.5` produces a video, extracts vidtrace evidence, and connects to code — all in one command. For multi-bug sessions, use `cairn clip latest --label name=start-end` to cut named clips and pass them to investigate.",
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
          "",
          "# override the evidence-derived query and prefer existing clips",
          'cairn investigate latest --codebase ~/projects/myapp --query "login redirect" --clips',
        ].join("\n"),
      },
      {
        title: "audit a spec end-to-end",
        language: "bash",
        code: [
          "# run spec with video, extract evidence, connect to code",
          "cairn audit flows/login.yml --codebase ~/projects/myapp --speed 0.5",
          "",
          "# make interactions easier to inspect in the recording",
          "cairn audit flows/login.yml --codebase ~/projects/myapp --slow-mo 250",
        ].join("\n"),
      },
    ],
    relatedTopics: ["clip", "stash", "artifacts", "overview"],
  },
  clip: {
    title: "Clip Run Videos (vidtrace integration)",
    summary:
      "Cut named clips from a Cairntrace run video using vidtrace. Useful for isolating distinct bugs or interesting moments so they can be kept in the local stash, explicitly transferred after review, or fed into cairn investigate.",
    sections: [
      {
        title: "Overview",
        body: "Cairntrace records a full video of every run when `artifacts.capture.video` is `always` or `on-failure`. The `cairn clip` command calls `vidtrace clip cut` on that video, producing named `.mp4` clips from timestamp ranges. Clips are moved into `<runDir>/videos/clips/` so they stay relative to the run artifacts. When `--stash` is passed, the clips are saved in the local file.cheap vault and the stash ID is returned; no upload or replication occurs.",
      },
      {
        title: "cairn clip",
        body: "`cairn clip <run-id> --label name=start-end [--label ...] [--out DIR] [--name PREFIX] [--stash] [--tag TAG] [--reencode] [--json]` resolves the run directory, finds `videos/playwright-video.webm` or `videos/agent-browser-video.webm`, and runs `vidtrace clip cut`. Timestamps follow vidtrace's `H:MM:SS` / `M:SS` / `S` format. `--stash` stashes the enriched run directory to fcheap with a `vidtrace-clip` tag. All output supports `--format json|yaml|md`.",
      },
      {
        title: "Auto-clip on failure",
        body: "Specs can declare `artifacts.clipPoints` so the runner automatically cuts clips after a failed run. Each point needs a `label`, `start`, and `end`. Clip points are spec-level behavior, not project config. The runner only auto-cuts when a video was captured and `vidtrace` is available. Failures are logged but do not fail the run itself.",
      },
      {
        title: "Spec config",
        body: "Declare clip points under the spec's `artifacts` block:\n```yaml\nartifacts:\n  capture:\n    video: on-failure\n  clipPoints:\n    - label: issue1-blank-row\n      start: 0:18\n      end: 3:40\n    - label: issue2-blank-cells\n      start: 3:40\n      end: 4:05\n```\nProject config may set `clips.tags`, but runtime clip points belong in the spec.",
      },
      {
        title: "MCP Tool",
        body: "`cairn_clip` mirrors the CLI: takes runId, labels, out, name, stash, tags, reencode. Returns clip paths, the source video, output directory, and stashId. Degrades gracefully when vidtrace is unavailable.",
      },
    ],
    examples: [
      {
        title: "cut clips from the latest run",
        language: "bash",
        code: [
          "cairn clip latest \\",
          "  --label issue1-blank-row=0:18-3:40 \\",
          "  --label issue2-blank-cells=3:40-4:05 \\",
          "  --label issue3-date-errors=6:34-11:09 \\",
          "  --label issue4-email-rejected=14:50-16:14 \\",
          "  --stash --tag intel --tag sample-app \\",
          "  --json",
        ].join("\n"),
      },
      {
        title: "spec-level clip config",
        language: "yaml",
        code: [
          "artifacts:",
          "  capture:",
          "    video: on-failure",
          "  clipPoints:",
          "    - label: login-spinner",
          "      start: 0:10",
          "      end: 0:25",
          "    - label: error-toast",
          "      start: 1:05",
          "      end: 1:12",
        ].join("\n"),
      },
    ],
    relatedTopics: ["investigate", "artifacts", "stash", "overview"],
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
        body: "There are two auto-annotate modes. `on-investigate` (set via `annotate.autoAnnotate` in config) annotates each code match from `cairn investigate` results into codemap. `on-run` annotates every run — pass or fail — with run context: `{ specName, contractHash, runId, status, outcomes, failedVerifier }`. The `contractHash` lets codemap consumers invalidate stale green badges when the spec's contract changes. Enable on-run via `cairn run --auto-annotate on-run` or `annotate.autoAnnotate: on-run` in config. Both are best-effort: if codemap isn't installed, the annotation step is silently skipped.",
      },
      {
        title: "Config",
        body: "Configure annotate integration in cairntrace.config.yml:\n```yaml\nversion: 1\nenvironments:\n  local: {}\nannotate:\n  enabled: true\n  autoAnnotate: on-run   # on-run (pass+fail) | on-investigate | never\n  source: cairntrace      # default source label\n```",
      },
      {
        title: "MCP Tool",
        body: "`cairn_annotate` mirrors the CLI: takes symbol, note, optional source and data. Returns the annotation ID and whether the symbol was matched in the indexed graph. Degrades gracefully when codemap isn't installed.",
      },
      {
        title: "DX Workflow",
        body: 'The full workflow: `cairn run flows/login.yml --auto-annotate on-run` → run completes (pass or fail) → codemap symbol `login_flow` now carries an annotation with run status and contractHash → `codemap annotations login_flow` shows the latest cairntrace verdict. For failure investigation: `cairn run flows/login.yml` → fails → `cairn investigate latest --codebase ~/projects/myapp` → code matches → `cairn annotate src/auth/login.ts:42 --note "login_flow fails: redirects to /error"` → `codemap impact handleSubmit` now shows the annotation.',
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
          'cairn annotate "src/auth/login.ts:42" --note "failed blank-row regression" --data \'{"runId":"...","score":0.89}\'',
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
      "Use TinyVault as a selected-key provider for authenticated specs. Cairntrace keeps values invocation-scoped, registers them with the artifact redactor, and supports direct project mode and environment-group inheritance mode.",
    sections: [
      {
        title: "Overview",
        body: "Authenticated specs need credentials (API keys, database URLs, session tokens). TinyVault stores them encrypted locally. Cairntrace resolves only `keys`, `required`, and root-spec/imported-action placeholder names from the configured project or group, keeps them in an invocation-scoped environment instead of global `process.env`, and registers every selected value with the artifact redactor so spec authors do not hardcode secrets.",
      },
      {
        title: "Two modes: project vs group/env",
        body: "TinyVault supports two ways to resolve secrets. The following blocks are fragments for the `secrets:` key inside a complete v1 config.\n\n**Direct mode** — point at a specific tvault project:\n```yaml\nsecrets:\n  provider: tvault\n  tvault:\n    project: myapp-test\n```\n\n**Inheritance mode** — point at a group + environment, and missing keys fall back to the base environment at read time:\n```yaml\nsecrets:\n  provider: tvault\n  tvault:\n    group: myapp\n    env: preview\n```\nThis is useful when preview/staging inherit most keys from production but override a few. The group must be created in tvault first (`tvault env group create myapp --env production=myapp --env preview=myapp-preview`). Inheritance is resolve-time — no values are duplicated across projects.",
      },
      {
        title: "cairn secrets",
        body: "`cairn secrets` checks the tvault status and lists available secret keys (metadata only — values are never shown). Supports both modes:\n```bash\ncairn secrets --project myapp-test          # direct mode\ncairn secrets --group myapp --env preview    # inheritance mode\n```\nThis is a pre-flight check: verify that the required keys exist before running a spec that depends on them.",
      },
      {
        title: "Config",
        body: "Enable tvault as the secrets provider in cairntrace.config.yml. Use either `project` (direct) or `group` + `env` (inheritance) — not both:\n```yaml\nversion: 1\nenvironments:\n  local: {}\nsecrets:\n  provider: tvault\n  keys: [API_KEY, DATABASE_URL]\n  required: [API_KEY, DATABASE_URL]\n  tvault:\n    project: myapp-test\n    # OR:\n    # group: myapp\n    # env: preview\n```\nCairntrace resolves only `keys`, `required`, and keys referenced in root-spec/imported-action placeholders; it never exports the full project. The `required` list is checked before the run starts — missing keys fail fast with a clear error.",
      },
      {
        title: "MCP Tool",
        body: "`cairn_secrets_status` mirrors the read-only CLI preflight: it takes an optional `project` or `group`+`env`, returns tvault installation status and the list of secret keys, and never returns values. Actual browser-run injection happens in `cairn run` from the selected `secrets` config.",
      },
      {
        title: "DX Workflow",
        body: "The typical workflow:\n1. Store secrets in tvault (`tvault set API_KEY ...`)\n2. Optionally create an environment group (`tvault env group create myapp --env production=myapp --env preview=myapp-preview`)\n3. Configure `secrets.provider: tvault` in cairntrace.config.yml with either `project` or `group`+`env`, then declare `keys`/`required`\n4. `cairn secrets --project myapp-test` (or `--group myapp --env preview`) verifies keys exist\n5. `cairn run flows/auth.yml --cold-start` runs the spec with only its selected secrets injected\n\nThe spec YAML uses `${env.SECRET_KEY}` placeholders — never hardcoded values.",
      },
      {
        title: "Security",
        body: "Cairntrace registers resolved TinyVault values with the artifact redactor. Text and JSON artifacts, including `agent_context.md`, `events.ndjson`, run records, reports, and response evidence, scrub those literals along with sensitive keys and Authorization/Cookie headers. Publisher-only `FILECHEAP_INGEST_TOKEN` and TinyVault client controls are removed from browser, target, hook, seed, and tmux child environments. Binary artifacts are outside that boundary: screenshots and videos can show secrets or personal data rendered by the app, while downloads, transforms, and traces can preserve sensitive bytes. Keep run directories private and review binary captures before sharing or stashing them.",
      },
    ],
    examples: [
      {
        title: "check tvault status",
        language: "bash",
        code: [
          "# direct mode — list keys for a project",
          "cairn secrets --project myapp-test",
          "",
          "# inheritance mode — list resolved keys through group/env",
          "cairn secrets --group myapp --env preview",
          "",
          "# configure in cairntrace.config.yml (direct)",
          "# secrets:",
          "#   provider: tvault",
          "#   required: [API_KEY, DATABASE_URL]",
          "#   tvault:",
          "#     project: myapp-test",
          "",
          "# configure in cairntrace.config.yml (inheritance)",
          "# secrets:",
          "#   provider: tvault",
          "#   tvault:",
          "#     group: myapp",
          "#     env: preview",
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
        body: "The `docker` step runs a shell command (typically `docker compose up -d`) and waits for it to complete. `reuseExisting` defaults to true (locally): if `docker compose ps` shows running containers, the step is skipped. Under `--cold-start` or CI, reuse flips to false. `readyTimeoutMs` bounds how long to wait (default 120s); set it to `0` to wait indefinitely (for slow first-up image builds + many containers). In interactive runs, the command's stdout/stderr stream live to the terminal so you see `Container … Created` lines as they happen rather than a silent wait.",
      },
      {
        title: "Conditional Seed",
        body: "The `seed` step runs a data-import command conditionally based on three layers of freshness: (1) fingerprint — a SHA-256 of the command + env keys (not values, so secret rotation doesn't trigger re-seed); (2) TTL — re-seed if the last run was more than `ttlSeconds` ago; (3) optional `freshnessCheck` — a shell command whose exit 0 means data is fresh. State is tracked in `~/.cairntrace/services/<project>.seed.json`. Set `ttlSeconds: 0` (default) to always re-seed unless `freshnessCheck` passes. `timeoutMs` bounds the seed command (default 300s); set it to `0` to wait indefinitely. Optional `postCommands` always run after the seed decision (whether the heavy import ran or was skipped as fresh) — use them for lightweight fixture ensure scripts the bulk import does not ship. Seed output is buffered, redacted as one stream, then forwarded to interactive output so a secret split across chunks cannot leak. When `secrets.provider: tvault` is configured, the seed inherits only the invocation's selected scoped secrets.",
      },
      {
        title: "tmux Phase",
        body: "The `tmux` step creates a tmux session from scratch via `tmux new-session -d`, then creates N windows, each running one service. `reuseExisting` defaults to true: if the session already exists, it's reused. Under `--cold-start`, any existing session is killed first. Each window has a `name` (must be unique), `cwd` (relative to configDir or absolute), `command`, optional `readyOn` readiness signal, optional `env` (per-window env merged over session env + process.env), and optional `preCommands` (run before the main command, e.g. `yarn build` before `yarn start`). A preCommands entry may also be an object `{run, skipIf}`: `skipIf` is a shell probe executed HOST-SIDE with the window's cwd before sending `run` to the pane — exit 0 means already-fresh, skip `run` (the seed freshnessCheck pattern applied to builds: skip a minutes-long `yarn build` when dist/ is newer than every source file). Probe failure or non-zero exit runs the pre-command, so a broken probe can never silently skip a required build. Readiness is probed via `readyOn.url` (HTTP probe) or `readyOn.text` (tmux capture-pane text match). `readyTimeoutMs` bounds the total wait (default 90s); set it to `0` to wait indefinitely. In interactive runs, while a window isn't ready yet its pane tail is streamed every few seconds so you can see startup logs / errors instead of a blind wait. Session-level `options` are applied via `tmux set-option`, and session-level `env` is propagated to all windows via `tmux set-environment`.",
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
        body: "When `secrets.provider: tvault` is set, the seed command runs with tvault secrets injected into its environment. The `${MONGO_SOURCE_PASSWORD}` and `${ES_SOURCE_PASSWORD}` placeholders in the seed command are resolved at runtime rather than stored in the spec or config. Cairntrace registers resolved values with the text/JSON redactor, but producer-owned binary captures still require review before sharing.",
      },
      {
        title: "Session Stash (fcheap)",
        body: "The `services.stash` block optionally saves the session artifacts (tmux pane captures, docker logs, seed output) to fcheap after teardown. Set `enabled: true` (default false) and choose which phases to capture with `capture: [tmux, docker, seed]` (default all). `tags: [services, sample-app]` adds searchable tags. `autoStash: always` stashes on every stop; `on-failure` (default) only when the run has failures. This is best-effort — if fcheap isn't installed, stashing is silently skipped. Stashed artifacts persist beyond retention cleanup and are searchable via `cairn stash search`.",
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
        title: "Per-Environment Services",
        body: "The `services` and `secrets` blocks can be overridden per-environment inside `environments.<name>`. This lets you run the full local stack (docker + seed + tmux) for `local`, but skip all services for `dev` or `test` where the app is already deployed remotely:\n\n```yaml\nversion: 1\nservices:\n  docker:\n    command: docker compose up -d\n  seed:\n    command: bun run seed\n    ttlSeconds: 21600\n  tmux:\n    session: myapp\n    windows:\n      - name: web\n        command: bun run dev\n\nenvironments:\n  local:\n    baseUrl: http://localhost:8080\n  dev:\n    baseUrl: https://dev.example.com\n    services: false   # no docker/seed/tmux — app is remote\n  test:\n    baseUrl: https://test.example.com\n    services: false\n    secrets:\n      provider: tvault\n      tvault:\n        project: test-project  # different secrets for test env\n```\n\nWhen `services: false`, `cairn run --env dev` skips the entire services lifecycle (no docker, no seed, no tmux) — no need for `--no-services` or `--services-dry-run`. When a partial `services:` block is given, it deep-merges over the top-level one (e.g. override just the seed command, keep docker and tmux). The env-level `secrets:` block replaces the top-level one entirely.",
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
          "version: 1",
          "project: sample-app",
          "environments:",
          "  local: {}",
          "secrets:",
          "  provider: tvault",
          "  required: [MONGO_SOURCE_PASSWORD, ES_SOURCE_PASSWORD]",
          "  tvault:",
          "    project: sample-app",
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
          "    session: sample-app",
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
          "    tags: [services, sample-app]",
          "  teardown:",
          "    - tmux kill-session -t sample-app",
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
      {
        title: "per-environment services (local vs dev)",
        language: "yaml",
        code: [
          "version: 1",
          "services:",
          "  docker:",
          "    command: docker compose up -d",
          "  seed:",
          "    command: yarn demo-import",
          "    ttlSeconds: 21600",
          "  tmux:",
          "    session: myapp",
          "    windows:",
          "      - name: web",
          "        cwd: web-app",
          "        command: yarn serve",
          "        readyOn: { url: http://localhost:8080 }",
          "environments:",
          "  local:",
          "    baseUrl: http://localhost:8080",
          "  dev:",
          "    baseUrl: https://dev.example.com",
          "    services: false  # app is already deployed — skip docker/seed/tmux",
          "  test:",
          "    baseUrl: https://test.example.com",
          "    services: false",
          "    secrets:",
          "      provider: tvault",
          "      tvault:",
          "        project: test-project  # different secrets for test",
        ].join("\n"),
      },
    ],
    relatedTopics: ["backends", "secrets", "overview"],
  },
  discovery: {
    title: "Discovery Sessions",
    summary:
      "Interactive page exploration through the harness. An agent opens a session, navigates, interacts, and snapshots — all through MCP tools — then exports recorded steps as a spec YAML. No direct Playwright or agent-browser usage required.",
    sections: [
      {
        title: "Overview",
        body: [
          "Discovery sessions let an agent explore a live page through cairntrace's own browser backend, recording each interaction as a spec-compatible step. The agent can then export the full recorded session as a valid spec YAML. This replaces the blind authoring workflow (write → run → fail → heal) with an explore → record → export workflow.",
          "",
          "The MCP tools are the primary interface (9 tools: cairn_discover_open, _snapshot, _interact, _navigate, _inventory, _suggest, _export, _close, _list). The CLI `cairn discover <url>` is a one-shot enhanced snapshot for quick inspection.",
        ].join("\n"),
      },
      {
        title: "Workflow",
        body: [
          "1. cairn_discover_open(url, mock?) — creates a session, navigates, returns initial snapshot + inventory",
          "2. cairn_discover_snapshot(sessionId) — captures the current accessibility tree",
          "3. cairn_discover_inventory(sessionId) — collects role + testid locators from the current page",
          "4. cairn_discover_interact(sessionId, action, target, value?) — clicks/fills/hovers/types/selects/uploads/scrolls/presses; records the step; returns post-interaction snapshot",
          "5. cairn_discover_navigate(sessionId, url) — navigates to a new URL; records an open step",
          "6. cairn_discover_suggest(sessionId) — shows all recorded steps as YAML for review",
          "7. cairn_discover_export(sessionId, path, intent, outcomes, resume?) — writes a spec YAML with cold-start contract comments; verifies it. Pass resume=<checkpoint> to embed `session: { resume }` for an authenticated flow",
          "   For authenticated flows: log in during discovery, then cairn_checkpoint_capture(sessionId, name) saves the logged-in state as a resumable checkpoint to reference via resume",
          "8. cairn_discover_close(sessionId) — closes the session and frees the backend",
          "",
          "Use cairn_discover_list to check for active sessions (debugging). Sessions auto-expire after 5 minutes of inactivity.",
        ].join("\n"),
      },
      {
        title: "Step Recording",
        body: [
          "Each interaction is recorded as a spec-compatible step object using the same schema as real spec steps:",
          "- click/fill/hover/type → { click/fill/hover/type: { by: role|label|text|selector, ... } }",
          "- select → { select: { by: ..., value } } or { select: { by: ..., label } } (native <select>; exactly one of value | label)",
          "- upload → { upload: { by: ..., path } } (sets a file on a file input)",
          "- scroll → { scroll: { direction: 'down', px: 500 } } or { scroll: { to: locator } }",
          "- press → { press: 'Enter' }",
          "- navigate → { open: '/url' } or { open: { path: '/url', waitUntil: 'networkidle' } }",
          "",
          "The exported spec YAML includes a cold-start contract comment header, same as `cairn spec scaffold`. For an authenticated flow, log in during discovery, call cairn_checkpoint_capture(sessionId, name), then export with resume=name so the spec carries `session: { resume: name }` and replays from the captured session. Otherwise satisfy cold-start with an imported login action or preconditions.",
        ].join("\n"),
      },
      {
        title: "CLI: cairn discover",
        body: [
          "The CLI one-shot command is the quick inspection path:",
          "  cairn discover /login --env local --format json",
          "",
          "Returns the full accessibility tree (structured SnapshotElement[]) plus role and testid locator inventory. Supports --roles, --testids, --wait-until (networkidle|load|domcontentloaded — wait out SPA hydration before capturing), --env, --backend, --mock, --config, --format. Use this when you need a single-page inventory without interactive exploration.",
        ].join("\n"),
      },
    ],
    examples: [
      {
        title: "MCP discovery workflow (login flow)",
        language: "yaml",
        code: [
          "# 1. Open a session",
          'cairn_discover_open(url="/login", mock=true)',
          '# → { sessionId: "abc-123", snapshot: [...], inventory: { roles: [...] } }',
          "",
          "# 2. Fill the email field",
          'cairn_discover_interact(sessionId="abc-123", action="fill",',
          '  target={ by: "role", role: "textbox", name: "Email" }, value="admin@test.com")',
          "",
          "# 3. Click Sign In",
          'cairn_discover_interact(sessionId="abc-123", action="click",',
          '  target={ by: "role", role: "button", name: "Sign In" })',
          "# → URL changed to /dashboard, snapshot shows dashboard elements",
          "",
          "# 4. Export as spec",
          'cairn_discover_export(sessionId="abc-123", path="flows/login.yml",',
          '  intent="User can log in and reach the dashboard",',
          '  outcomes=[{ id: "dashboard_visible", description: "Dashboard heading is shown",',
          '    verify: { text: { contains: "Dashboard" } } }])',
          "",
          "# 5. Close the session",
          'cairn_discover_close(sessionId="abc-123")',
        ].join("\n"),
      },
    ],
    relatedTopics: ["mcp", "authoring", "steps", "overview", "export"],
  },

  export: {
    title: "Export & import (Playwright bridge)",
    summary:
      "Hand off Cairntrace specs to @playwright/test (JS or TS) for CI/legacy runners, or import Playwright tests into reviewable YAML. Cairntrace remains the agent source of truth.",
    sections: [
      {
        title: "When to export",
        body: "Use `cairn export playwright` when a team needs a plain Playwright file for CI, a Playwright-only suite, or a human who does not run cairn. Prefer keeping the YAML spec as source of truth for agent runs, heal, discovery, and outcomes. Export is a one-way bridge — not a full round-trip guarantee with `cairn import playwright`.",
      },
      {
        title: "CLI",
        body: "`cairn export playwright <spec|dir> [--lang js|ts] [--out <file>] [--out-dir <dir>] [--project] [--config <path>] [--env <name>] [--var key=value] [--stdout] [--format json|yaml|md]`. Default language is TypeScript (`.spec.ts`). `--lang js` emits `.spec.js` without type annotations. Directory input requires `--out-dir` and expands recursively (skips `actions/` and `_*.yml` drafts). `--stdout` prints source only for a single spec (no coverage report) so you can pipe into a file.",
      },
      {
        title: "Config-aware export (--config/--env/--var)",
        body: "`--config`, `--env`, and repeatable `--var key=value` resolve `cairntrace.config.yml` vars and `baseUrl` exactly like `cairn spec verify` — auto-discovered from the spec's directory when `--config` is omitted. This means specs using `${vars.*}` are exportable; the resolved values are inlined as literals (they are not secrets). `--project` mode also uses the resolved `baseUrl` to fill in `playwright.config.ts`.",
      },
      {
        title: "Secrets and the run token are never inlined",
        body: '`${secrets.X}` and an unset `${env.X}` (no `:-default`) never appear as literal values in generated source — they emit as `process.env.X ?? ""` template references, and the file\'s header comment lists every required env var so a reviewer/CI knows what to set. `${run.token}` emits a per-invocation `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random()...` so re-running the exported test still produces unique values instead of colliding on stale data.',
      },
      {
        title: "Node file verifiers now export",
        body: "A `script.runtime: node` verifier backed by `script.file` is no longer skipped: the generated test dynamically `import()`s the verifier module (relative path when the output location is known, otherwise absolute) and calls its `verify(ctx)` with the same fixtures/vars/specDir shape the Cairntrace runner passes. ESM/CJS interop is handled (`mod.verify ?? mod.default ?? mod.default.default`) since Playwright's TS loader can surface a default export either way. Inline `runtime: node` scripts (no `file:`) and browser-context `script.file` are still not exportable — there's no equivalent execution context to run them in.",
      },
      {
        title: "Locator and evaluate semantics",
        body: 'Semantic locators (role/label/text) emit `.first()` unless an explicit `nth` is set, matching agent-browser\'s first-match behavior against Playwright\'s default strict mode (which throws on ambiguous matches). Evals containing `location.reload()` emit a try/catch retry: Playwright destroys the evaluate execution context on navigation, so a caught "Execution context was destroyed" error triggers `waitForLoadState("networkidle")` followed by a re-run of the same eval, preserving the reload-as-rescue pattern\'s source semantics.',
      },
      {
        title: "Preconditions are not exportable",
        body: "Spec `preconditions.commands` run outside the browser (shell/mongo resets, pipeline gates) with no Playwright equivalent. Single-file export surfaces them as a ⚠ header comment block instead of silently dropping them. Batch export (`--out-dir`) additionally writes a `README.md` next to the generated files documenting required env vars, config requirements (`bypassCSP: true`, `workers: 1`), and each spec's preconditions so a human can wire them into CI.",
      },
      {
        title: "--project mode (structured project)",
        body: "`--project` (requires `--out-dir`) generates a full Playwright project instead of standalone spec files: `playwright.config.ts` (baseURL from config, serial `workers: 1`, `bypassCSP: true`, `globalSetup` wired), `global-setup.ts` (deduped spec preconditions as a runnable scaffold; set `SKIP_PRECONDITIONS=1` to skip and wire your own), `actions/<name>.ts` (each reusable action from `imports:` becomes one exported `async function(page)` that tests import, instead of inlining the same flow N times), `verifiers/` (node verifier files copied in so the project is self-contained), `tests/<spec>.spec.ts` (`use:` steps become calls into `actions/`), and `README.md`.",
      },
      {
        title: "--project layout",
        body: "```\nexports/\n├── README.md\n├── playwright.config.ts   baseURL, workers: 1, bypassCSP, globalSetup\n├── global-setup.ts        deduped preconditions (SKIP_PRECONDITIONS=1 to skip)\n├── actions/\n│   └── login.ts           async function login(page) — from imports: login\n├── verifiers/\n│   └── check-mongo.ts     copied node verifier, self-contained\n└── tests/\n    ├── login.spec.ts\n    └── checkout.spec.ts\n```",
      },
      {
        title: "Coverage report",
        body: "When writing files, stdout is a structured report: status written|partial|error, per-file coverage (steps/outcomes exported vs total), and skips with reasons. Partial means at least one construct was commented/skipped (eval.file, browser-context script.file, inline runtime: node scripts, transform, snapshot, monitor, unresolved use:). Agents should read `coverage.skips` in `--format json` before treating a handoff as complete.",
      },
      {
        title: "Fidelity (what exports well)",
        body: "Well supported: open, click (including click.until retry loops), hover, fill/type (including verify-after-settle retry loops and verifyFill opt-out), select, upload, download, wait (text/notText/selector/load), press, scroll, request (page.request with cookies + body/headers/expectStatus), eval (inline js, including location.reload() retry), batch (flattened sequential steps — hover atomicity is lost), when: urlContains|urlNotContains|urlMatches|text|notText as real if-blocks, text/notText/url/count/network/console outcomes, browser script.run outcomes, node file verifiers (script.runtime: node + file: — imported and invoked directly), basic httpJson, ${vars.*} via --config/--env/--var, ${secrets.*}/unset ${env.*}/${run.token} as env/RUN_TOKEN references. Skipped or partial: eval.file, browser-context script.file, inline runtime: node scripts (no file), transform, snapshot, monitor, process/xlsx verifiers, preconditions (surfaced as a comment/README instead), ${requests.*}/${evals.*} splicing in later steps, advanced httpJson matchers (matches/atLeast/atMost).",
      },
      {
        title: "MCP",
        body: "`cairn_export_playwright` mirrors the CLI: path (spec or dir), out, outDir, lang js|ts, stdout. structuredContent is the same report schema as `--format json`. `--config`/`--env`/`--var`/`--project` are CLI-only for now.",
      },
      {
        title: "Import (reverse direction)",
        body: "`cairn import playwright <file>` converts common Playwright page.goto, locator actions, and expect assertions into reviewable Cairntrace YAML with TODO comments for unmapped lines. Always re-run `cairn spec verify` and fix cold-start before treating an import as complete.",
      },
      {
        title: "Authoring path (writing tests)",
        body: "To write new tests as an agent: `cairn docs authoring` → discovery (`cairn_discover_*` or `cairn discover`) → export YAML → `cairn run --cold-start` → heal if needed. Only then `cairn export playwright` if a Playwright artifact is required.",
      },
      {
        title: "Under the hood",
        body: "Emission is a small statement IR (`codegen.ts`: raw/comment/block/tryCatch nodes) rendered by a single printer, so indentation and block matching can't drift. String/value quoting is centralized in `templateValue.ts` (`emitStr`/`emitValue`), which is the only place that turns `${secrets.X}`/unset `${env.X}`/`${run.token}` sentinels into `process.env`/`RUN_TOKEN` splices. Golden-file tests (`playwrightExporter.golden.test.ts`, `UPDATE_GOLDENS=1` to regenerate) and a TypeScript parse/type-check pass (`playwrightExporter.validation.test.ts`) guard the generated source against silent drift.",
      },
    ],
    examples: [
      {
        title: "Export one spec to TypeScript",
        language: "bash",
        code: "cairn export playwright flows/login.yml --format json",
      },
      {
        title: "Export a directory as JavaScript",
        language: "bash",
        code: "cairn export playwright flows/ --lang js --out-dir playwright/tests --format md",
      },
      {
        title: "Pipe source only",
        language: "bash",
        code: "cairn export playwright flows/login.yml --lang ts --stdout > tests/login.spec.ts",
      },
      {
        title: "Export a structured project with resolved config",
        language: "bash",
        code: "cairn export playwright flows/ --project --out-dir exports --config cairntrace.config.yml",
      },
    ],
    relatedTopics: [
      "authoring",
      "discovery",
      "steps",
      "verifiers",
      "backends",
      "mcp",
    ],
  },
};
