import {
  DocsResultSchema,
  DocsTopicSchema,
  type DocsResult,
  type DocsTopic,
} from "../../core/schema/docs.v1";
import { authorFlowSteps } from "../../core/authoring/authorFlow";
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
    ...(topic === "run-policy" ? runPolicyDocs() : DOCS[topic]),
  });
}

/** `services` topic sections the `run-policy` topic carries, by title prefix. */
const RUN_POLICY_SECTIONS = [
  "Run Policy",
  "Suites",
  "Metrics Probes",
  "Per-Environment Services",
  "Keeping Services Up",
  "Dry-Run Mode",
  "Engine Pin",
];

/**
 * `cairn docs run-policy`: what replaces a Taskfile / wrapper script around
 * `cairn run` — the `run:` block, `suites:`, `metrics:`, per-environment
 * services and the services commands under the run lock — in one topic. The
 * sections are the `services` topic's own (one text, two entry points).
 */
function runPolicyDocs(): DocsTemplate {
  const services = DOCS.services;
  return {
    title: "Run Policy: replace your Taskfile (run:, suites:, metrics:)",
    summary:
      "A wrapper around `cairn run` (a Taskfile, a Makefile, a with-cairn.sh) usually locks the stack, checks the machine and the vault, picks specs per suite, sets per-suite env and labels, brings a billable resource up and always down, and collects numbers. Each of those is config the run engine enforces for `cairn run` and MCP `cairn_run` alike, so a bare `cairn run --suite <name> --env <env>` is as safe as the wrapper was.",
    sections: [
      {
        title: "The wrapper did → config",
        body: "- picks specs per suite (`case $SUITE`) → `suites:` + `cairn run --suite <name>`\n- exports env per suite (`ENGINE_MODE=x cairn run …`) → `suites.<n>.processEnv` / `suites.<n>.env.<env>.processEnv` (exported to preflight, services, hooks, specs; names only in the journal)\n- stamps a cohort label → `suites.<n>.labels` (+ `--label`, which wins) and `cairn stats --group-by <key>` / `--invocation <id>`\n- bails on the first failure, except sometimes → `suites.<n>.bail`, `suites.<n>.env.<env>.bail`, `--bail` / `--no-bail`\n- skips seed steps per environment → `suites.<n>.env.<env>.seed.postCommands.skip` (on top of the suite's)\n- refuses to start twice, checks a quota or a secret → `run.lock`, `run.preflight` (`when: { suite, env }` limits a check)\n- greps for leftovers → `run.verifyClean`, `cairn doctor --orphans`\n- always destroys the billable thing → `services.provisioner.down` (also per environment, with no top-level `services:`), `services.teardown` `critical: true`\n- refuses `task sink` while a suite runs → nothing to do: `cairn services down|up|restart` refuse (exit 4, naming the owner) while a live run holds the config's `run.lock`\n- prints what it would do → `cairn run --suite <name> --env <env> --services-dry-run` (provisioner, tunnels, files, seed post-commands and the suite's skips included)",
      },
      ...RUN_POLICY_SECTIONS.flatMap((prefix) =>
        services.sections.filter((section) => section.title.startsWith(prefix)),
      ),
    ],
    examples: [
      {
        title: "a suite that replaces a Taskfile target",
        language: "yaml",
        code: [
          "run:",
          "  lock: true",
          "  preflight:",
          "    - { secret: DEPLOY_TOKEN }",
          "    - name: engine posture",
          "      when: { suite: [checkout-ab] }",
          "      json: docker/posture.json",
          "      assert: .engine.workers >= 2",
          "suites:",
          "  checkout-ab:",
          "    specs: [flows/checkout]",
          "    bail: true",
          '    processEnv: { ENGINE_MODE: "${env.ENGINE_MODE:-durable}" }',
          '    labels: { cohort: "${env.ENGINE_MODE:-durable}" }',
          "    env:",
          "      staging:",
          "        bail: false",
          "        seed: { postCommands: { skip: [staging-only-fixture] } }",
        ].join("\n"),
      },
      {
        title: "run it, preview it, compare it",
        language: "bash",
        code: [
          "cairn run --suite checkout-ab --env staging --services-dry-run   # the whole plan, nothing runs",
          "cairn run --suite checkout-ab --env staging --no-bail",
          "cairn stats --group-by cohort --label suite=checkout-ab",
        ].join("\n"),
      },
    ],
    relatedTopics: ["services", "secrets", "mcp"],
  };
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

const DOCS: Record<Exclude<DocsTopic, "run-policy">, DocsTemplate> = {
  overview: {
    title: "Cairntrace Agent Docs",
    summary:
      "Cairntrace is a local-first browser-spec layer. Agents should call `cairn explain --json` once to learn the tool surface, then use `cairn docs <topic> --json` for focused authoring guidance.",
    sections: [
      {
        title: "Agent Bootstrap",
        body: 'Start with `cairn explain --json` or MCP `cairn_explain`. Use `cairn docs authoring --json` before writing specs, and `cairn docs steps --json` or `cairn docs verifiers --json` when choosing YAML shapes. To turn a request ("log in, edit X, save, check it persisted") into a spec, follow `cairn docs author-flow` (MCP prompt `author-flow`): catalog → discover (or import an existing Playwright test or trace, `cairn docs import`) → convention export → `cairn spec finish` → promote after review.',
      },
      {
        title: "Core Loop",
        body: "Write intent and outcomes as the contract. Add steps as repairable hints. Use `cairn snapshot <url> --json` when you need locator inventory, then run `cairn run <spec> --cold-start --json`; inspect `agent_context.md` and outcome evidence; heal locator drift with `cairn spec heal` when the UI changes.",
      },
      {
        title: "Machine-Readable Surfaces",
        body: "`cairn explain`, `cairn docs`, `cairn run`, `cairn snapshot`, `cairn import playwright`, `cairn spec verify`, `cairn spec heal`, `cairn diff`, and `cairn stats` all support structured output formats where applicable. MCP tools return the same structured content without shell parsing. Use `cairn run --label path=next` then `cairn stats --group-by path` for A/B cohort stats (legacy vs next).",
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
        body: "Every finished spec must replay from a clean browser. Satisfy that with an imported login action, `use: login` (the environment's `auth:` block), `session.resume`, deterministic `preconditions.commands`, or `coldStart: guest` for an intentionally public/sessionless flow. The guest acknowledgement suppresses setup lint but does not skip replay. Before calling a spec done, run `cairn spec verify <spec> --config <path> --json` when using config variables, then run `cairn run <spec> --cold-start --json`.",
      },
      {
        title: "Small YAML",
        body: "Keep YAML readable. Use normal steps for navigation and interaction, first-class `download` for file capture, `transform` for Node-side fixture generation, and `script.file` when a script body would make the YAML noisy.",
      },
      {
        title: "Data, Readiness And Cleanup",
        body: 'Reach for the typed primitives before a script. Mid-flow state: an `expect` step (fails the step with evidence) or a `capture` step (`${captures.<assign>…}`) compared at the end with the `value` verifier — outcomes only see the final state. Backend state: the `mongo`, `temporal` and `http` verifiers over config `datasources:` (credentials stay in the runner; evidence names the source, never the URI), `table` for rendered tables, `network` with `body`/`count`. Eventual effects: `poll: { timeoutMs, everyMs, stableMs }` next to any verifier instead of a hand-written polling loop (`stableMs` for "exactly one, and it stays one" or "absent, and it stays absent"). Readiness: `preconditions.wait` (config `gates:` — http/tcp/command probes, `all`/`any`, `stable`) instead of a sleep-and-curl precondition; `cairn wait <gate>` checks one from a shell. Test data: config `fixtures:` (exec/mongo/http with ensure/reset/verify/teardown, scope run/suite/seed) listed in the spec, `${fixtures.<name>.<key>}` in steps and verifiers. Side effects: a `run:` step (shell or node, `assign` → `${runs.<name>…}`) and a spec `teardown:` that always runs — never an outcome with side effects. Still need code? Write the node verifier with the SDK (`defineVerifier`, see `cairn docs scripts`). See `cairn docs verifiers`, `cairn docs services` (gates) and `cairn docs fixtures`.',
      },
      {
        title: "Config Variables",
        body: "`${vars.X}` placeholders are resolved before spec validation, so they can safely appear in required fields like `open`. Vars merge in this order: imported action `vars:` defaults < config environment vars < top-level spec `vars:` < repeatable CLI `--var key=value`. Missing vars fail with a clear `missing vars.X` error. A spec's own `vars:` value may use `${env.X:-default}`; it resolves like a config var before it is spliced. Built-ins `${worker.index}` and `${run.token}` are also available; use them in vars such as `testUser: player-${worker.index}-${run.token}` to isolate realtime/stateful backends. Contract hashes are computed from the raw unresolved intent and outcomes, not environment-specific values. Config TEXT itself substitutes `${env.X}` (e.g. `baseUrl: http://localhost:${env.APP_PORT}`), so dynamic-port runners need no per-run YAML.",
      },
      {
        title: "Environments",
        body: "The active environment is `--env <name>` (MCP `env`), else the spec's `environment:`, else config `defaultEnvironment`, else `local`. When a cairntrace.config.yml exists, an explicit `--env` (MCP `env`) that `environments:` does not define is a config error that lists the known environments (exit 4 on `cairn run` — before any spec, service or hook starts, with an errored JSON document under `--format json` — and on `cairn spec verify` / `spec heal` / `discover` / `snapshot`) — it no longer runs silently without that environment's baseUrl and vars. Defaults stay lenient: a spec's `environment:`, a `defaultEnvironment`, or the `local` fallback that the config does not define runs without that environment's baseUrl and vars, and `cairn run` / `spec verify` / `spec heal` / `discover` / `snapshot` print a warning on stderr (`local` against a config with no environments at all, from the spec or an explicit `--env local`, is silent). Without any config, environment names are not checked.",
      },
      {
        title: "Environment Policy",
        body: "Declare where a spec may run instead of guarding it in a precondition: `requires: { env: [local, { dev: { optIn: CAIRN_ALLOW_DEV_MUTATIONS } }], mutates: true }`. An `{ <env>: { optIn: VAR } }` entry is allowed only when VAR is `1`/`true` in the caller's environment. The config holds the other half: `environments.<name>.policy: { trait: owned|shared|protected, mutations: allow|deny, description }` — a `protected` environment runs only specs that list it in `requires.env`, and `mutations: deny` refuses `requires.mutates: true`. `cairn run` (and MCP `cairn_run`) checks each spec before secrets, services, the webServer, hooks, preconditions or a browser start. A refused spec gets status `refused` with a `refusal` block (`reason`, `env`, `requires`, `code`: env-not-listed | opt-in-missing | mutations-denied | protected-env), outcomes `skipped`, no run directory (`synthetic: true`: its `runId` / `runDir` are never-written placeholders — do not open them), a `run.refused` event in the invocation journal (counted in its `summary.refused`), and is never stashed, investigated or retained. When every spec of the run was refused (one or many, whatever `--parallel`) nothing ran and the run exits 7; a batch where other specs ran lists it (`summary.refused`) and keeps going, failing with exit 7 only under `--strict-requires`. `--select-only` lists refused specs under `skipped` with the reason. `cairn spec verify --env <name>` fails with an `env-not-allowed` finding (exit 4); without `--env` it returns `environments[]` with the verdict for every config environment. Exported Playwright tests get a run-time `test.skip` guard on `process.env.CAIRN_ENV` — set `CAIRN_ENV` when running them. When the export baked an environment's baseUrl, the guard accepts only that environment; if the policy refuses the spec there the test always skips and the export reports an `envPolicy` risk.",
      },
      {
        title: "Path Placeholders",
        body: "Relative step paths (`upload.path`, `eval.file`, `transform.file`/`input`, eval `args.filePath`/`fixtureFiles`) resolve against the file that DECLARES the step: the spec's directory for its own steps, the ACTION's directory for an imported action's steps. An action path that only exists next to the importing spec (the old resolution) still works with a deprecation warning naming the action and step, and `cairn spec verify` exits 4 when a referenced file is missing where a run would look (absolute paths outside the project only warn). `${file.dir}` (alias `${project.root}`) is the directory of the FILE being parsed: in a spec it is the spec's directory, but inside an imported action it is the ACTION's directory (so `${file.dir}/fixture.csv` in `actions/upload.yml` means `actions/fixture.csv`). `${config.dir}` is the directory of the resolved cairntrace.config.yml — the explicit `--config` (MCP `config`) when given, else the one found by walking up from the spec (the cwd when there is no config) — use it for fixtures shared by specs and actions in different folders: `path: ${config.dir}/fixtures/import.xlsx`. `${config.dir}` also works inside cairntrace.config.yml itself (e.g. in `vars`), and the config supports YAML anchors and merge keys (`vars: &shared` under one environment, `<<: *shared` in another; keys written next to the merge win). Prefer these over absolute paths so specs stay portable across machines.",
      },
      {
        title: "Viewport And Retention",
        body: "Set the browser viewport per environment (`environments.<env>.viewport: { width, height }`) or per spec (top-level `viewport:`); spec wins. High-latency environments can set `environments.<env>.waitScale: 3` (overridden by `CAIRN_WAIT_SCALE`) to multiply wait/settle budgets and the 500ms network-idle quiet window. Bound artifact disk usage with `retention`: `keepRuns` (newest N runs per spec, pruned after every run — default 3 when no `retention` block is set; `retention: { enabled: false }` keeps everything), `archiveToStash: true` (archives pruned run dirs to fcheap before deletion through the evidence gate — `stash.include`, default text + screenshots, so excluded traces/videos/downloads are deleted with the run; if the archive fails the run is retained), and explicit `publish: { enabled: true, retentionDays: 7 }` (packages a bounded, gated run — `retention.publish.include`; traces never — for private file.cheap publication; deletion waits for a byte-matching `server-sha256` receipt). `cairn pin <run>` keeps a run out of pruning (retention re-checks pins before it archives or deletes). `cairn clean [--keep N | --all]` prunes manually with the same defaults (`--include-pinned` also removes pinned runs). Traces follow `artifacts.capture.trace` — the on-failure default deletes the trace on passing runs (`artifacts.capture.traceMaxBytes`, default 50 MiB, drops a larger one). Videos follow `artifacts.capture.video` (default `never`) — opt in with `always` or `on-failure` for audit-grade recordings.",
      },
      {
        title: "Logging",
        body: "All diagnostic/lifecycle logs go to stderr — stdout is reserved for structured results (JSON/YAML/markdown). Control verbosity with `--log-level <debug|info|warn|error|silent>`, `--quiet` (warn), or `--verbose` (debug); default is info on a TTY, warn in CI/piped. `--log-format json` emits one NDJSON object per log line for machine consumption (human is the default). `--no-color` / `NO_COLOR` disable ANSI. Set project defaults in `cairntrace.config.yml` under `logging: { level, format, color }`; flags and env (`CAIRN_LOG_LEVEL`, `CAIRN_LOG_FORMAT`) override the config. The services lifecycle (docker/seed/tmux) and live subprocess output stream through the logger at info, so `--quiet` suppresses them while warnings/errors always show.",
      },
      {
        title: "Authoring Helpers",
        body: "`cairn snapshot <url>` opens a page and reports role and test-id locators for agent-friendly step authoring (pass `--wait-until networkidle` for SPAs so the inventory isn't captured pre-hydration; role entries with multiple matches note that `nth` is needed to disambiguate). Test ids are scanned on the config's `browser.testIdAttribute` (default `data-testid`), the same attribute `by: testid` resolves at run time; `--config/--env/--var` resolve the baseUrl, `${vars.X}` (config vars, `--var key=value` overrides) in the URL, and the browser block exactly like a run. Printed URLs are redacted (secret values, token-like query params, userinfo). `cairn import playwright <file>` converts common Playwright `page.goto`, locator actions, request calls, and `expect` assertions into reviewable YAML with TODO comments for unmapped lines. `cairn run <dir> --junit reports/cairn.xml` expands YAML specs recursively for CI, skipping imported `actions/` directories and drafts — any folder or file below the directory whose name starts with `_` (`flows/_drafts/`, `_wip.yml`); naming a draft or the drafts folder explicitly still runs it. `--stamp-if-green` stamps contract hashes only after every requested spec passes.",
      },
      {
        title: "Lint, Finish, Promote",
        body: "`cairn spec lint <spec...> [--env a,b] [--fix] --json` (MCP `cairn_spec_lint`) gives friendly findings with fix-its before anything runs: `unquoted-hash` (a `selector: #id` YAML reads as a comment), `schema` (explained per step against that step kind's schema), `missing-file`, `cold-start-echo-only` / `cold-start-missing`, `unknown-fixture-key` / `missing-fixture-key` (script verifier contracts), `literal-secret`, `eval-typed-equivalent` (location.assign → open, fetch login → request, .click() → click, value setter → fill, polling loops → wait / click.until), `eval-ratio` (an `export.targets` `maxEvalRatio` would refuse the spec), `absolute-path`, `residual-placeholder` (a `${requests.x}` in a precondition would reach the shell literally), `missing-step-id`, `duplicate-step-id` (an authored id used twice: an error inside `repeat` / `if` blocks, a warning between top-level steps), `shell-arg-unset` (a `run:` shell command reads `$N` the step does not pass in `args`), and per-environment `unresolved-var` / `unknown-env` for every `--env`. `--fix` applies only safe text edits (quote `#` selectors, insert step ids) — comments and quoting elsewhere stay byte-identical. Exit 4 when any finding is an error. `cairn spec finish <spec> [--env] [--config] [--var] [--headed] [--mock] [--backend] [--reuse-services] [--no-services] --json` (MCP `cairn_spec_finish`) is the done-check: lint (errors stop: `lint-failed`, exit 4), then a cold-start run through the same engine as `cairn run` with `--stamp-if-green` (a `cairn services up` lock for the env is reused automatically), returning `status` green|red|lint-failed|errored|refused, the run (status, runDir, report), `contractHash`, the run's agent_context.md summary and `nextActions`. `cairn spec promote <draft> [--to <path>] [--force] --json` (MCP `cairn_spec_promote`) moves a draft out of the drafts dir only after a green finish of its exact content (or `--force`), rebases its relative imports and file paths, stamps the contract hash and returns `{from, to, intent, outcomes, contractHash}`; it never replaces an existing spec.",
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
    relatedTopics: [
      "steps",
      "verifiers",
      "downloads",
      "scripts",
      "author-flow",
    ],
  },
  steps: {
    title: "Step Vocabulary",
    summary:
      "Steps are executable hints. They can be repaired by heal without changing the behavior contract.",
    sections: [
      {
        title: "Supported Steps",
        body: "`open` navigates (object form `{ path, waitUntil, timeoutMs }` waits out SPA hydration), `click` activates a locator (`click.until` retries up to four times until selectorGone|selector|text|notText holds), `hover` reveals hover-only controls, `focus` focuses a control without clicking, `fill` sets a field value, and `type` types character-by-character as real keyboard events (`delayMs` optionally paces keystrokes). Fill/type re-read the live value after a 500ms settle and retry three times if hydration wipes it; set sibling `verifyFill: false` only for controls whose transformed/masked DOM value intentionally differs. `select` chooses a native <select> option by `value` or `label` (exactly one), `upload` sets a file input, `download` clicks and captures a file artifact, `transform` runs a Node script to create a new artifact, `request` makes an authenticated API call and captures the response, `wait` waits for text/notText/selector/exact control value/load state/URL (`includes`|`equals`|`pattern`), `press` sends a keyboard key, `scroll` scrolls by direction or to a locator, `snapshot` captures the page, `use` invokes an imported reusable action, and `batch` runs a chain of selector interactions in one backend invocation. Any browser mutation may also carry `postcondition.network`, which arms a matching response listener/baseline before the action and never retries that mutation. Text/notText waits and click.until text conditions normalize whitespace and are case-insensitive.",
      },
      {
        title: "Control Flow",
        body: "`repeat: { max, until?, steps, indexVar?, onMax? }` runs nested steps up to `max` (≤ 100) times; `until` (the `when:` grammar) is checked before every iteration and once after the last, and the loop stops when it holds. Reaching `max` with an `until` that never held fails the step (`onMax: fail`, default) or passes it (`onMax: continue`); without `until` the loop simply runs `max` times. Nested steps see `${repeat.index}` (0-based) and `${repeat.iteration}` (1-based) of the innermost loop, plus `${repeat.<indexVar>}` of every named loop. `if: { condition, then, else? }` checks its condition once and runs one branch. `when:` also takes `{ var: <name>, equals | in | exists }`: a plain name reads the config/spec/use-site vars of the file that declares the step, a dotted name reads a runtime value (`waits.<name>.matched`, `repeat.index`, `captures.<name>.…`, `runs.<name>.…`); values compare as strings. `wait.any` / `wait.all` poll a list of conditions under one `timeoutMs`; `optional: true` never fails a wait (a miss passes with `matched: false`); `assign: <name>` exposes `${waits.<name>.matched}` (and `.index` for any). Groups and optional waits are polled by the runner, so a miss never stops the browser. `use: { action, vars, retry: { times, until?, delayMs? } }` re-runs the action's steps as one group when one fails or `until` does not hold after them. A failing nested step fails its block and the run. Nested steps keep stable ids (`<parent>.<n>`, `<parent>.then.<n>`, or their own `id`); `step.started` events and run.json results carry `parentId`, `iteration` and `branch`, results are recorded post-order (a block's steps before the block) and artifacts get an `_i<n>` / `_a<n>` suffix per iteration / attempt; a `request` without `assign` inside a block is named after its place (`request_<top>_<n>`, `request_<top>_then<n>`, plus that suffix), so iterations never share a `requests/` file or binding, and `cairn spec lint` flags an authored id used twice (`duplicate-step-id`). A retried attempt's failed steps leave run.json `steps` (their errors stay in the block's `retries` and in events). `cairn spec heal` does not patch nested steps. Control flow is not allowed in `teardown:`.",
      },
      {
        title: "Page Prelude And App Handles",
        body: "An `eval` source, a browser `script` verifier or a login `hydrate` script that mentions `__cairn` gets `window.__cairn` installed first (once per document, namespaced, read-only; a page that already owns `window.__cairn` is never overwritten — the step fails instead): `sleep(ms)`, `visible(el|selector)`, `text(el|selector)` (normalized rendered text), `labelOf(el|selector)`, `nativeSet(el|selector, value)` (prototype setter + input/change, read-back; a boolean sets a checkbox/radio), `fire(el|selector, type, init?)` (typed DOM event), `rows(table|selector)` (visible rows as header-keyed records), `waitFor(fn|selector, { timeoutMs?, intervalMs? })`, and `app.<name>` — read-only accessors from config `browser.appHandle: { <name>: <page expression> }` (re-evaluated on every read, e.g. a store getter). `wait: { app: { path: <name>.<prop>…, equals | in | exists }, timeoutMs? }` polls one from the runner with bounded probes (works in `wait.any` / `wait.all`, with `optional` / `assign`); the value stays in the page and an unknown handle fails at once. Sources that never mention `__cairn` are sent unchanged. Exported tests embed the same prelude (`CAIRN_PRELUDE`, `cairnAppCheck`; `lib/prelude` in `--project`).",
      },
      {
        title: "Widgets And Interaction Flags",
        body: "Custom form controls are typed steps, not `eval` files: `set: { field | locator, value }` writes through a widget driver and reads the value back (failing with evidence when it did not commit), `check` / `uncheck: { field, option? }` are idempotent, `choose: { field, option }` picks one option, and `form: { fields }` sets several fields in order with `dependsOn` mount waits, optional fields and a final re-read. `field: <key>` resolves through config `browser.fieldRoot` templates. Built-in drivers: vue-multiselect, primevue-autocomplete, primevue-calendar, pills, radio-group, checkbox-group, native-select, native-input; project drivers via `browser.widgets: [{ file }]`. `click` takes `optional: true`, `dispatch: true` and `fallback: dispatch`; `fill` takes `mode: set` (native setter, no focus/keydown) and `optional: true`. See `cairn docs widgets`.",
      },
      {
        title: "Network Postconditions",
        body: "Attach `postcondition: { network: { urlContains, method?, status?, timeoutMs? } }` to an upload or other browser mutation when its completion is a response rather than immediate DOM state. `urlContains` is required; `status` uses `equals`, `below`, `atLeast`, or `in`. Playwright registers `page.waitForResponse` before the action, including `setInputFiles`; the action is dispatched once and a timeout reports failure without repeating it. Agent-browser uses a bounded request-log baseline when its backend has no native response event.",
      },
      {
        title: "Batch Steps",
        body: "`batch` runs ≥2 selector sub-steps in a SINGLE backend invocation (agent-browser `batch --bail`), so transient UI state — a hover popover, focus, an open menu — survives long enough to act on it instead of being lost to a fresh CLI process per step. Sub-steps are `click`/`hover`/`fill`/`type`/`upload`/`press`/`scroll`/`wait` and must use `by: selector` (semantic locators need their own snapshot round-trip, which would break the single invocation). Clicks are paced by 100ms; checkbox/radio/switch state (including aria-checked=mixed) is re-queried after framework rerenders, gets a 300ms post-action grace, then one live-element recovery click before failing loudly. Every command must return an explicit success result; the first failing or missing result fails the whole step. Artifact placeholders are not resolved inside batch sub-steps; use a top-level `upload`/`download` step for those.",
      },
      {
        title: "Locators",
        body: "Interactive steps use locators with `by: role`, `by: label`, `by: text`, `by: testid`, or `by: selector`. Prefer role or label locators because they are easier to heal and easier for agents to understand. Semantic locators match ACCESSIBLE names (what the snapshot shows, post-CSS-text-transform): whole-name, case-insensitive, visible elements only. Substring matching is not supported. Zero matches fail the step with candidate diagnostics; multiple matches are a hard error — disambiguate with `exact: true` (case-sensitive), `nth: <index>` (0-based, document order), `near: <nearby visible text>` (the Open in the Acme Corp card), or a more specific name. `by: testid` reads `browser.testIdAttribute` (default `data-testid`). Targets are scrolled into view automatically before the action.",
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
        title: "Request v2",
        body: 'All optional and additive. `credentials: omit` sends no browser cookies and keeps no `Set-Cookie` (an anonymous caller; `include` is the default). Headers splice runtime values — `authorization: "Bearer ${requests.login.body.token}"` — and `${secrets.X}`; every `${secrets.X}` value, every sensitive header value (and the token after its scheme) and every response field under a credential-like key is redacted from all artifacts. `until: { status?, json?: { <path>: matcher }, every?, timeoutMs? }` re-sends the request until the answer holds — `every` (ms, default 1000) between attempts, `timeoutMs` (default 30000) the whole poll, the request\'s own `timeoutMs` each attempt; a transport error counts as "not yet"; an exhausted poll fails with the last answer kept in `requests/<name>.json`. `retry: { times (1–10), on?: [5xx, network], delayMs? }` re-sends after a 5xx or a transport failure (not with until). `capture: { <key>: <path> }` reads the JSON body into `${requests.<name>.captures.<key>}`; paths are the shared ones (`$.a.b`, `items[0]`, `rows[*].id`) plus filters `$.tasks[?(@.title == "x")].id` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, bare `@.field` for presence); a wildcard or filter captures its first match and a path that matches nothing fails the step. `matrix: { <key>: [values] }` sends one request per combination (cartesian, ≤ 200) with `${matrix.<key>}` / `${matrix.<key>.<field>}` spliced into `method`, `url`, `headers` and `body` (a whole reference keeps its type, so `body: ${matrix.route.body}` sends an object); every combination runs, its status is recorded under `matrix` in `requests/<name>.json`, and the step fails listing each combination whose status is not in `expectStatus` (not with until or capture). `artifact.request` events add `attempts`, `combinations` and `mismatches`.',
      },
      {
        title: "Environment Login (use: login)",
        body: "`use: login` (or `use: { action: login, vars }`) with no imported action named `login` runs the environment's `auth:` block (config `environments.<env>.auth`) instead of a sign-in form: `alreadyAuthenticated?` (a probe: when its `status` — default any 2xx — and `json` matchers hold, nothing else runs), `login` (the sign-in request, default POST, `expectStatus`, `retry`, `capture`; its answer is `${requests.login.…}`), `after?` (follow-up requests — an OTP verify with `Bearer ${requests.login.body.token}` — each with an optional `when: { var: requests.login.body.…, equals | in | exists }`) and `hydrate?` (`eval` or a config-relative `file` run in the app page once after a fresh login, seeing `args.login` — the login response body — never the credentials). `${secrets.X}` resolves from the run's provider when the step runs (tvault fetches the names when a flow uses login), `${vars.X}` from config/spec/use-site vars; every secret value is registered for redaction before the first request, and an unset one fails the step at once. Each request is evidence (`requests/login_check.json`, `login.json`, `login_after_<n>.json`); the step's `detail` says what happened (`logged in (POST /api/login → 200); 1 follow-up(s); hydrated` or `already authenticated …; login skipped`). It satisfies the cold-start contract, heal never patches it, and the Playwright export calls `cairnLogin(page, CAIRN_AUTH)` (`cairnLoginState` writes a storageState for globalSetup).",
      },
      {
        title: "Eval Steps",
        body: "`eval` is a page-context JavaScript escape hatch — the last-resort locator-free step. It runs arbitrary JS in the browser via `backend.evaluate()` and optionally captures the JSON-serializable return value as `evals/<assign>.json`. Use it for state setup and internal-state assertions that no UI affordance can reach (seed a Vuex/Redux/Pinia store, read `localStorage`, assert on a computed property). Provide exactly one of `js` (inline source) or `file` (path to a .js file, resolved against the directory of the file that declares the step — an imported action's own directory). Optional `args` is passed as the single argument to the wrapped function, avoiding `${}` string injection. `assign: name` writes `{ value: <return> }` to `evals/<name>.json` and lets later steps splice fields via `${evals.<name>.value.<field>}`. The captured value is redacted before writing. `eval` is opaque to `heal` — there is no locator to repair, so a failing eval step is a real error, not selector drift. Page-context only: no Node/fs access (that is what `transform` is for). The app must expose a handle to its state (e.g. a dev-only `window.__APP__` store ref); read it through config `browser.appHandle` (`__cairn.app.<name>`) instead of repeating the expression in every eval. Before writing an eval, map the pattern to its typed replacement — `cairn spec lint` flags the ones it recognizes (`eval-typed-equivalent`): open a picker / type / click an option → `set` / `choose` / `form` (read back); click a radio or checkbox only when unset → `choose` / `check` / `uncheck`; click when present → `click.optional`; `el.click()` past a mask or overlay → `click.fallback: dispatch` / `click.dispatch`; native value setter + input/change → `fill.mode: set`; retry ladders and unrolled loops → `repeat` / `use: { action, retry }`; branch on page state → `if` / `when`; `fetch` login, bearer or OTP → `use: login` with config `environments.<env>.auth`; `fetch` in a sleep loop → `request.until`; anonymous boundary probes → `credentials: omit` + `matrix` + `expectStatus`; poll a framework store → `wait.app`; an eval that throws to assert → `expect`, or `capture` + the `value` verifier; unzip a workbook → the `xlsx` verifier; helpers redeclared per file → the `__cairn` prelude. What remains is state setup or an internal-state read no typed step reaches.",
      },
      {
        title: "Reusable Actions",
        body: "Reusable actions imported via `imports:` use the same step schemas as normal specs, including `hover`, `fill.value`, `upload.path`, `download.saveAs`, and `transform.saveAs`. An action may declare `vars:` defaults for `${vars.X}` in its steps; spec, config, and CLI vars override those defaults. An action may declare its own `imports:` (paths relative to the action file) and `use:` other actions: a nested `use:` resolves against the action's own imports, then its importer's; call vars flow down (the inner call's `vars` win); import or use cycles and two files declaring the same action name are parse errors; origins (heal, step-relative paths) point at the innermost action file. Test data a spec needs belongs in the config `fixtures:` registry, listed under the spec's `fixtures:` (see `cairn docs fixtures`), not in preconditions or outcomes with side effects.",
      },
      {
        title: "Expect And Capture",
        body: "`expect` asserts mid-flow and records evidence like an outcome: a locator (`by: role|label|text|selector|testid`, same strict rules) plus any of `visible`, `hidden`, `count` (number or `{ equals | atLeast | atMost }`), `text` (string or `{ equals | contains | matches, caseSensitive }`, normalized and case-insensitive), `value`, `attribute: { name, equals | contains | matches | exists }`, `enabled` — or `request: { method, url, status, json: { path: matcher } }` sent with the browser session. It retries until `timeoutMs` (default 5000 × waitScale), writes `expects/NNN_<id>.json`, emits `expect.passed` / `expect.failed`, and fails the step on a mismatch — use it instead of an `eval` that throws. `capture` stores a value for later steps and outcomes as `${captures.<assign>…}` (and `captures/<assign>.json`): exactly one of `text`, `value`, `attribute` (locator + `attributeName`) or `table` (`{ headers, rows: [{ <header>: <cell> }], cells, rowCount }`). Inside `expect`, `visible`/`hidden` are assertions; for `by: text` the `text` key stays the locator.",
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
        title:
          "environment login, bearer follow-up, polling and an anonymous matrix",
        language: "yaml",
        code: [
          '# cairntrace.config.yml → environments.local.auth: { login: { url: /api/login, body: { email: "${secrets.E2E_EMAIL}", password: "${secrets.E2E_PASSWORD}" }, expectStatus: 200 } }',
          "steps:",
          "  - use: login",
          "  - request:",
          "      method: PUT",
          "      url: /api/otp/verify",
          '      headers: { authorization: "Bearer ${requests.login.body.token}" }',
          "      expectStatus: 200",
          "  - request:",
          "      url: /api/tasks",
          "      until: { json: { \"$.tasks[?(@.title == 'Report')]\": { exists: true } }, every: 1000, timeoutMs: 60000 }",
          "      capture: { taskId: \"$.tasks[?(@.title == 'Report')].id\" }",
          "      assign: tasks",
          '  - open: "/tasks/${requests.tasks.captures.taskId}"',
          "  - request:",
          "      method: ${matrix.route.method}",
          "      url: ${matrix.route.path}",
          "      credentials: omit",
          "      matrix:",
          "        route: [{ method: GET, path: /api/admin/list }, { method: DELETE, path: /api/admin/item }]",
          "      expectStatus: 401",
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
        title:
          "control flow: load all rows, branch on an optional banner, retry a flaky action",
        language: "yaml",
        code: [
          "steps:",
          "  - id: maybe_banner",
          "    wait: { text: Maintenance window, timeoutMs: 2000, optional: true, assign: banner }",
          "  - id: dismiss_banner",
          "    if:",
          "      condition: { var: waits.banner.matched, equals: true }",
          "      then:",
          "        - click: { by: role, role: button, name: Dismiss }",
          "  - id: load_all",
          "    repeat:",
          "      max: 20",
          "      until: { text: All rows loaded }",
          "      steps:",
          "        - click: { by: role, role: button, name: Load more }",
          "        - wait: { any: [{ notText: Loading }, { text: No more rows }], timeoutMs: 10000 }",
          "  - id: save",
          "    use: { action: submit_form, retry: { times: 2, until: { text: Saved } } }",
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
    relatedTopics: ["downloads", "authoring", "verifiers", "widgets"],
  },
  verifiers: {
    title: "Verifier Vocabulary",
    summary:
      "Outcomes use the v0 verifier vocabulary. Prefer typed verifiers and use `script` only for assertions that do not fit the built-ins.",
    sections: [
      {
        title: "Typed Verifiers",
        body: "`text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`, `httpJson`, `table`, `value`, `mongo`, `temporal` and `http` cover UI, navigation, network, console, workbook, on-disk, backend-JSON, rendered-table, in-run value and datasource assertions. Text/notText `equals` and `contains` normalize whitespace and are case-insensitive by default; set `caseSensitive: true` to opt out. Regex `matches` remains raw and case-sensitive. `text.region` and `notText.region` optionally scope text checks to a selector; the old sibling `region` shape is still accepted for compatibility. `file` polls a glob (filename wildcards, relative to the spec dir) until a matching file exists and optionally contains a needle. `httpJson` fetches JSON in the browser session with cookies, resolves relative URLs through config `baseUrl` or the current page origin, walks a simple dotted JSON path like `$.game.score`, and applies `equals`/`contains`/`matches`/numeric/`exists` matchers. `network` also matches the captured JSON request `body` (`{ json, match: subset|exact }`), a `count` of matching requests (0 allowed) and `assign`s the last match as `${network.<name>.at|firstAt|count|url|status|body}` for later outcomes. `table` reads a rendered table by locator: `rows` (`equals|atLeast|atMost`, `noBlank` with `ignoreCells` such as Edit/Delete), `contains` (row text or `{ header: cell }`) and `headers` (`includes`, `inOrder`). `value` asserts on what the run already holds — `actual: ${evals.x.value}` / `${requests.y.body}` / `${captures.z}` / `${fixtures.a.b}` / `${network.n.at}` (a whole reference keeps its type) or a JSON `file` — with `expect: { path: matcher }`.",
      },
      {
        title: "Workbooks (xlsx)",
        body: "`xlsx` reads a downloaded workbook (read-only; the parser `ctx.xlsx` uses). `sheet` (name, `{ match: <regex> }` or 0-based index; default the first sheet) is what `headers` / `rows` / `cells` / `validations` read, and scopes `contains`, which otherwise searches EVERY sheet. `headers: { labelRow (default 1), keyRow?, strip?, caseSensitive?, present, absent, labels: { <key>: <label> }, includesInOrder, withinListInOrder }` — a name matches a column whose label or key equals it (whitespace collapsed, `strip` regex removed, case-insensitive); `includesInOrder: <list | >` = every listed name is a column in that relative order (extra columns allowed), `withinListInOrder` = every workbook column is in the list in the list's order. `rows: { afterKeyRow: { count | atLeast | atMost }, match: [{ column, matcher }] }` — data rows below the key row; `match` needs ONE row where every matcher holds. `cells: [{ ref, sheet?, equals | matches | numFmt }]` — `numFmt` is a format code (`@` text, `yyyy-mm-dd`) or built-in id, resolved from the cell, row or column style. `validations: [{ column, sheet?, type?, formulaMatches? }]` — a data validation (x14 included) covering the column whose formula matches every regex. `sheets: [{ name, contains }]` remains. Values are the strings Excel stores (dates as serials).",
      },
      {
        title: "Datasources",
        body: "Config `datasources:` names the connections data verifiers read through (`environments.<env>.datasources` merges a partial entry over the top-level one; `<name>: false` disables it there). `kind: mongo` takes `uri` (often `${secrets.X}`; used through the OPTIONAL `mongodb` driver when the project installed it, else `mongosh`) or `docker: { service | container, project? }` (runs `docker exec <container> mongosh`, the container found by its compose service label), plus `database`, `guard: { databases, hosts }` and `mode: read-only`. `kind: temporal` takes the UI/HTTP API base `api`, `namespace` and `auth: { basic: user:password | bearer }`. `kind: http` takes `baseUrl`, `headers`, `auth`. Requests travel to mongosh as EJSON data in the environment, never as built JavaScript; connection strings and credentials are never written to artifacts (evidence names a source by name, kind, transport, database and hosts).",
      },
      {
        title: "Data Verifiers",
        body: "`mongo` runs `find` + `countDocuments` on `source`/`collection` with an extended-JSON `filter` (`{ $oid: … }`, `{ $date: '${run.startedAt}' }`), optional `projection`/`sort`/`limit`, and `expect: { count, exists, fields: { path: matcher } }` — `fields` read the FIRST document, so sort to assert on the latest; default `exists: true`. `temporal` takes exactly one of `workflowId` (describe; 404 = absent) or `query` (visibility query + count) and `expect: { status, count, activities: { includeAnyOf, includeAll, maxAttempts }, inputBytes: { atMost }, absent: true | { stableMs } }`; history is read page by page and follows continue-as-new; 5xx is retried. `http` calls a `kind: http` source (or a URL relative to the environment baseUrl) from Node — no browser cookies — and checks `status` (default 2xx) and `json` paths. `mongo`/`temporal`/`http` accept `assign` → `${captures.<name>…}` for the outcomes after them (mongo: `{count, docs}` in a plain view: ObjectIds as hex, dates as ISO strings).",
      },
      {
        title: "Matchers",
        body: "Data matchers (mongo `fields`, `count`, http `json`, `value.expect`, `network.count`): a bare scalar means `equals`; an object combines `equals`, `contains` (substring / array element / object subset), `matches` (regex), `oneOf`, `atLeast`, `atMost` (numbers or numeric strings only), `exists` (null counts as present), `empty`, and `all`/`each` (every array item matches a nested matcher); every present key must hold. Comparisons are raw and case-sensitive unless `ignoreCase: true`. Paths are `$`-rooted: `a.b`, `items[0]`, `items.0`, `rows[*].name`, `items.length`, `$['key.with.dots']`.",
      },
      {
        title: "Polling",
        body: 'Every verifier accepts `poll: { timeoutMs, everyMs?, stableMs?, failFastOnStepFailure? }` next to its kind key. The verifier re-runs every `everyMs` (default 1000) until it passes or `timeoutMs` elapses; with `stableMs` the pass only counts after it HELD green that long over at least two samples (a red sample restarts the window) — use it for "exactly one, and still one" and "absent, and still absent". When a step already failed, `failFastOnStepFailure` (default true) evaluates once without waiting. While polling, `outcome.progress` events narrate `attempt N/~M: <actual> (want <expected>)`; `outcome.passed|failed` carry `attempts` and `polledMs`, and `outcomes/<id>.raw.json` keeps a bounded attempt log. Configuration errors (unknown datasource, guard refusal, unresolved reference) fail at once instead of burning the budget.',
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
        body: "Each outcome writes a compact markdown evidence file. Script verifiers also write raw evidence JSON when the evidence is too deep for the markdown budget. `mongo`, `temporal`, `http`, `value`, `table` and `network` with body/count/assign write `outcomes/<id>.raw.json` as `{ kind, source?, request, observed, attempts?, polledMs? }` — `request` redacted (credential headers masked, URLs without userinfo), `observed` bounded to 20 rows of at most 4KB each with a `truncated` flag; any verifier evaluated under `poll` adds `attempts`/`polledMs`.",
      },
      {
        title: "Blocked Outcomes",
        body: "When a step fails before producing an artifact or response, outcomes whose verifier references the missing `${artifacts.<name>.…}` / `${requests.<name>.…}` / `${evals.…}` / `${captures.…}` / `${network.…}` / `${fixtures.…}` / `${runs.…}` are reported as `skipped` (evidence says `blocked: … never produced — run stopped at failed step`), not `failed` — fix the failed step first. On a run with no step failure, a reference to an unknown name is a real failure.",
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
      {
        title: "datasource verifiers with poll",
        language: "yaml",
        code: [
          "# cairntrace.config.yml",
          "datasources:",
          "  app: { kind: mongo, docker: { service: mongo }, database: shop }",
          "  temporal: { kind: temporal, api: http://localhost:8080, namespace: default }",
          "environments:",
          "  dev:",
          "    datasources:",
          "      app: { uri: '${secrets.DEV_MONGO_URI}' }",
          "# spec outcomes",
          "outcomes:",
          "  - id: order_event_logged_once",
          "    description: exactly one ORDER_SHIPPED event, and it stays one",
          "    verify:",
          "      mongo:",
          "        source: app",
          "        collection: events",
          "        filter: { type: ORDER_SHIPPED, createdAt: { $gte: { $date: '${run.startedAt}' } } }",
          "        expect: { count: 1 }",
          "      poll: { timeoutMs: 60000, everyMs: 2000, stableMs: 10000 }",
          "  - id: order_workflow_completed",
          "    description: the order workflow completed its activities",
          "    verify:",
          "      temporal:",
          "        source: temporal",
          "        workflowId: order-${captures.order.id}",
          "        expect: { status: COMPLETED, activities: { includeAll: [reserveStock, chargeCard] } }",
          "      poll: { timeoutMs: 120000, everyMs: 2000 }",
          "  - id: final_state_clean",
          "    description: the captured state has no blank rows",
          "    verify:",
          "      value:",
          "        actual: '${evals.finalState.value}'",
          "        expect: { blankRowCount: 0 }",
        ].join("\n"),
      },
    ],
    relatedTopics: ["scripts", "artifacts", "authoring", "steps"],
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
      "Script verifiers keep custom checks available while preserving the typed outcome contract. Node verifiers written with the verifier SDK get typed fixtures, polling, datasources and evidence without glue code.",
    sections: [
      {
        title: "Inline Or External",
        body: "Use `script.run` for short bodies and `script.file` for longer JS/TS bodies. External files resolve relative to the spec file. Browser TypeScript files are transpiled before page evaluation; Node runtime files are imported by Node. Set `script.timeoutMs` on node verifiers: it is the hard budget (the child is killed) and the SDK's `ctx.deadline`.",
      },
      {
        title: "Verifier SDK",
        body: "Write node verifiers with `import { defineVerifier, z } from \"@thelacanians/cairntrace/verifier\"` and `export default defineVerifier({ description, fixtures: z.object({ … }), run(ctx) { … } })`. The runner supplies its own SDK to the child, so no local install is needed (add the package as a dev dependency only for editor types). `ctx.fixtures` is parsed by the schema: typed, defaults applied, strings from YAML or `${vars.X}` coerced to the declared number/boolean/date/array/object, an empty string for an optional non-string key treated as absent. A mismatch (wrong type, missing required key, unknown key — rejected unless the schema is `.passthrough()`) fails the outcome with every issue as its observed value; fixture values are never echoed by the SDK's own messages (a `.refine()` message is the author's to keep clean). Return `ctx.result.ok(details)` or `ctx.result.fail(message, details)` (or throw with `ctx.fail(message, details)`): the message becomes the outcome's observed line and the details go to `outcomes/<id>.raw.json`.",
      },
      {
        title: "SDK Context",
        body: "`ctx.vars` (resolved config/CLI vars), `ctx.run` ({ id, token, startedAt, labels, failedStep, lastSuccessfulStep, dir }), `ctx.network` ({ entries, find(filter), findOne(filter) — exactly one match or the outcome fails listing the candidates, json(entry) }), `ctx.evals`, `ctx.requests`, `ctx.captures`, `ctx.runs` (run step outputs), `ctx.fixturesOutputs`, `ctx.artifacts`, `ctx.datasources.<name>.<method>(…)` (config `datasources:` — mongo find/findOne/count/query/write/ping, temporal describe/list/count/history, http request/get/post/put/patch/delete; calls run in the runner over a loopback channel, so connection strings and credentials never enter the verifier, and each call is logged in the outcome log), `ctx.poll(fn, { until, within, every, stableFor, failWhen, describe, want })` (one progress line per attempt; on timeout the outcome fails with the bounded last observation and attempt log, and the outcome events carry attempts/polledMs), `ctx.deadline` / `ctx.remainingMs()`, `ctx.signal` (aborted at the deadline and on cancel: the child gets SIGTERM and 1s before its process tree is killed), `ctx.progress(msg)`, `ctx.xlsx(path)` (read-only workbook, the `xlsx` verifier's parser: sheets, rows, cell(ref), records(), columns({ labelRow, keyRow }), numFmt(ref), validations with formula1/formula2), `ctx.log(…)`.",
      },
      {
        title: "Structured Fixtures",
        body: "A fixture value may be a YAML list or map; it reaches the verifier as JSON with its nested types kept (`owners: [a, b]`, `expected: { status: shipped, count: 2 }`). Top-level scalars stay strings for existing scripts. Use lists and maps instead of pipe-separated strings or JSON inside a string.",
      },
      {
        title: "Fixtures Contract",
        body: "`cairn verifier schema <file> --json` prints a verifier's fixtures contract. It reads `defineVerifier({ fixtures: z.object({ … }) })` statically, never executing the file: keys, types, required, defaults, `.describe()` text, enum values, strictness. A schema imported from another module is reported as `mode: dynamic`; `--load` imports the module in a Node child killed after `--timeout-ms` (default 10000) to read it — that runs the module's top-level code, so use it only on files you trust. Plain scripts fall back to the header comment (`Fixtures:` block), an exported fixtures object, or the keys the code reads. `cairn spec lint`, `cairn spec finish` (which lints) and `cairn catalog` use the same contract; with an SDK schema an unknown or missing required key is an error.",
      },
      {
        title: "Execution Context (plain scripts)",
        body: "Browser scripts can read DOM state and use injected `fixtures`, `artifacts`, `vars` and `run`. Plain node scripts (`export default async function verify(ctx)`) keep working unchanged and receive `ctx` with `fixtures`, `artifacts`, `vars`, `runDir`, `specDir`, `run` (failedStep, lastSuccessfulStep, id, token, startedAt, labels), `evals`, `requests`, `captures`, `runs`, `fixturesOutputs`, `deadline` (epoch ms or null) and `progress`, and can import project dependencies or read files with `fs`.",
      },
      {
        title: "Progress And Logs",
        body: 'Long node verifiers can report progress with `ctx.progress(message)`; it becomes an `outcome.progress` event and a narration line while the verifier runs. Precondition commands get the same channel through `CAIRN_PROGRESS_FILE` (append one line per update, e.g. `echo "seeded 3/10" >> "$CAIRN_PROGRESS_FILE"`), surfaced as `precondition.progress`. A node verifier\'s stdout/stderr is kept, redacted, in `logs/outcome-<id>.log` in the run directory.',
      },
      {
        title: "Return Shape",
        body: "A plain script returns `{ ok: boolean, evidence: unknown }`. Evidence is summarized in the outcome markdown and retained in a raw JSON sidecar when needed.",
      },
      {
        title: "Node Import Gotcha",
        body: "Node verifier files run under Node's TypeScript type-stripping, so relative imports MUST carry an explicit extension: `import { helper } from './lib.ts'` — a bare `./lib` fails with `Cannot find module`.",
      },
    ],
    examples: [
      {
        title: "SDK verifier (verifiers/order-shipped.ts)",
        language: "ts",
        code: [
          'import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";',
          "",
          "export default defineVerifier({",
          '  description: "The order saved in the UI reaches shipped in the database",',
          "  fixtures: z.object({",
          '    orderId: z.string().describe("Order created by the spec"),',
          "    owners: z.array(z.string()).default([]),",
          "    within: z.number().default(30_000),",
          "  }),",
          "  async run(ctx) {",
          "    const save = ctx.network.findOne({",
          '      method: "PATCH",',
          '      path: "/api/orders/" + ctx.fixtures.orderId,',
          "    });",
          "    const doc = await ctx.poll(",
          '      () => ctx.datasources.app.findOne("orders", { orderId: ctx.fixtures.orderId }),',
          "      {",
          '        until: (d) => d?.status === "shipped",',
          '        failWhen: (d) => d?.status === "cancelled" && "order was cancelled",',
          "        within: ctx.fixtures.within,",
          "        every: 2_000,",
          '        describe: (d) => "status=" + (d?.status ?? "missing"),',
          '        want: "shipped",',
          "      },",
          "    );",
          "    return ctx.result.ok({ status: doc.status, saveStatus: save.status });",
          "  },",
          "});",
        ].join("\n"),
      },
      {
        title: "outcome using it",
        language: "yaml",
        code: [
          "verify:",
          "  script:",
          "    runtime: node",
          "    file: ./verifiers/order-shipped.ts",
          "    timeoutMs: 60000",
          "    fixtures:",
          "      orderId: ${requests.order.body.id}",
          "      owners: [ops, billing]",
        ].join("\n"),
      },
      {
        title: "plain script file body",
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
        title: "Live Logs And Events",
        body: "Every run also writes `run.log` (plain narration ending in a `run end:` line), `logs/precondition-NN-<name>.log` and `logs/outcome-<id>.log` (node script verifiers), each redacted line by line and announced by a `log.opened` event. `events.ndjson` follows the versioned `events.v1` schema: besides `run.*`, `step.*`, `outcome.*`, `precondition.*` and `artifact.*` it carries `phase.changed` (phase, item, budget, deadline), `run.heartbeat` every 15s while a phase is active, `step.started` with index/total/kind/label (never fill values or URL query strings), `step.finished`/`step.failed` with `url` and `screenshot`, `outcome.started` with kind and timeout, live outcome verdicts with `durationMs`, and `precondition.progress`/`outcome.progress`. `precondition.run.output` keeps the redacted last 4000 characters (`outputTruncated` when cut). Follow a live run with `cairn logs latest --follow` or `cairn logs latest --follow --log precondition`: while a `cairn run` is still going it follows that invocation's current run, waiting while services or `--before` hooks boot (`cairn logs --invocation latest --follow` streams that phase). Exit 0 when it settled, 2 when its process died or there is no run.",
      },
      {
        title: "Invocation Journal",
        body: "Each `cairn run` (single, batch, `--repeat`/`--matrix`) writes `<artifactRoot>/_invocations/<id>/`: `invocation.json` (redacted argv, plan, current spec, each run's status, final summary; atomically rewritten, `aborted` on SIGINT/SIGTERM), its own `events.ndjson` (`invocation.*`, live `services.*`, `hook.*`, `phase.changed`, heartbeats), and `logs/` (`narration.log`, `services-docker.log`, `services-seed.log`, `services-teardown.log`, `hook-before-NN.log`, one `hook-after-NN-<runId>.log` per after-hook execution). Runs carry an `invocation {id, index, total, dir}` link in run.json and `run.started`. Read it with `cairn logs --invocation latest [--json]`, follow it with `--follow [--log narration|services|hook]`. Retention keeps the newest 20 journals plus any that still reference a run directory, and never removes a live one; `latest`/`previous` run refs never resolve to `_invocations/`.",
      },
      {
        title: "Run Context For Hooks And Preconditions",
        body: 'Preconditions receive `CAIRN_ENV`, `CAIRN_BASE_URL`, `CAIRN_CONFIG_DIR`, `CAIRN_RUN_ID`, `CAIRN_RUN_DIR` and `CAIRN_RUN_TOKEN` (a precondition\'s own `env:` wins); `--before` hooks get the environment, base URL and config dir (no run exists yet); `--after` hooks get all six. Child processes (preconditions, hooks, docker/seed/tmux, the webServer) get a filtered environment without `FILECHEAP_INGEST_TOKEN`, `CAIRN_TVAULT_ENV` or any `TVAULT_*` variable that is not an explicitly selected secret key (read `CAIRN_ENV` for the environment name; `cairn run` warns when an exported `CAIRN_TVAULT_ENV` names another environment than the run resolves), and the credential values are also scrubbed from artifacts. With `--format json|yaml --log-format json`, progress is narrated as NDJSON on stderr (`scope: "progress"`).',
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
        body: "Use `cairn_explain` once at session start to learn commands, verifiers, rules, and config. Use `cairn_docs` for topic-specific guidance without reading README files from disk. Before authoring, `cairn_catalog {query}` lists the actions, vars, verifiers, environments, flows and checkpoints the project already has (the `cairn://catalog` resource holds the whole catalog).",
      },
      {
        title: "Execution Tools",
        body: "`cairn_run`, `cairn_spec_verify`, `cairn_spec_heal`, `cairn_context`, and checkpoint tools mirror their CLI counterparts. `cairn_run` and `cairn run` are one engine: config and the `browser:` block (`testIdAttribute`, click tuning), vars, scoped secrets, services/webServer, hooks, repeat/matrix, post-run stash/investigate/annotate, retention archive/publish, stamp-if-green, JUnit and the invocation journal. Every run flag is a `cairn_run` input under its camelCase name (`coldStart`, `noServices`, `noWebServer`, `stampIfGreen`, `sinceCodemap` (alias `since`), `hookTimeoutMs`, …) plus `specs` (paths or directories), `path` (one spec) and `wait`. The structured result is the `cairn run --format json` document (RunResult, BatchRunResult for several specs, SelectionResult for `selectOnly`) plus `nextActions`; for repeat/matrix it is ONE BatchRunResult over every iteration (the CLI prints one document per iteration). `isError` is set for a non-zero exit code, and a failed stamp-if-green or JUnit write is named in the text. Like `cairn run`, it boots the config webServer and stops it afterwards unless `noWebServer` is set. Config services (docker/seed/tmux) start, and their teardown runs, only on a server started as `cairn mcp --allow-services` (or with `CAIRN_MCP_ALLOW_SERVICES=1`); otherwise a run whose config would start them fails with exit 4 before anything starts — pass `noServices` when the stack is up or `reuseServices` after `cairn services up`.",
      },
      {
        title: "Long Runs",
        body: "`cairn_run {wait: false}` starts the invocation in the server and returns `{invocationId, journalDir, journalDirAbsolute, status: running}` at once. Poll `cairn_run_status {invocationId}` (status, planned vs started runs, final summary and document) and read live logs with `cairn_logs {invocationId, log?, cursor?, maxBytes?}` → `{text, nextCursor, eof, settled}`: pass `nextCursor` back as `cursor` until `settled` and `eof` (single-file logs also accept `nextOffset` as `offset`). Invocation logs: `events` (default), `narration`, `services`, `hook`; add `run` (an id, `latest`, or `current`) for a run's `events`, `run`, `precondition` or `outcome` log. `precondition`, `outcome`, `services` and `hook` are several files that grow independently: the cursor keeps one position per file and each file's new bytes follow a `==> <file> <==` header. `cairn_run_cancel {invocationId}` stops it gracefully: browser sessions killed, the process tree of the running command killed (a before/after hook, a services boot command — docker, seed, readiness check, healthcheck — a precondition, a node transform or node script verifier), services readiness waits and a booting webServer stopped, specs not yet started and the rest of the running spec skipped (remaining outcomes reported `skipped`; the spec writes `status: errored`, `failure.phase: cancelled`), started services/webServer torn down, journal `aborted`. Only teardown commands and an in-flight file/xlsx check (until its own timeout, result ignored) keep running. A server runs at most 8 invocations at once, and a client that disconnects cancels its background invocations. In synchronous mode a request carrying a `progressToken` gets `notifications/progress` for run, step and outcome milestones, and cancelling the request cancels the run — a client whose tool timeout expires cancels it too, so start suites that can outlast it with `wait: false`.",
      },
      {
        title: "Hooks and Shared Environments",
        body: "`before`/`after` hooks passed in a `cairn_run` request run arbitrary shell, so `cairn_run` refuses them unless the server was started as `cairn mcp --allow-hooks` (or with `CAIRN_MCP_ALLOW_HOOKS=1`). The flag gates only request-carried hooks: suite `before`/`after`, `run.preflight` / `run.finally` and metric `command` probes come from the config, which is trusted like its webServer and preconditions. Config services and their teardown need `cairn mcp --allow-services` (or `CAIRN_MCP_ALLOW_SERVICES=1`) for `cairn_run`, `cairn_spec_finish`, `cairn_audit`, `cairn_services_up` and `cairn_services_down`; `noServices`, `reuseServices` and `servicesDryRun` are never gated. Neither gate is a sandbox: webServer commands, spec preconditions and `script` verifiers are shell too and run without them. Invocations that boot services or a webServer from the same config file queue inside the server, whatever their `env`, so two agents never fight over one docker/tmux stack; one that boots neither (`noServices` and `noWebServer`, or a config without them) never waits. Each invocation gets its own browser sessions, and `invocation.json` records `origin: mcp` and the client.",
      },
      {
        title: "Discovery Tools",
        body: "Twelve `cairn_discover_*` tools provide interactive page exploration: open a session (optional `setup` from imported actions or a spec's first steps, `resume`, `backend`), snapshot (`snapshotMode` none|diff|compact|full), interact (click/fill/hover/scroll/press/focus/eval/wait/request/assert or a raw step), navigate, network, inventory, suggest, remove a recorded step, export as spec YAML, close, resume and list. Every action runs through the `cairn_run` engine on the session's browser. Each session journals to `<artifactRoot>/_sessions/<id>/`; the browser closes after 30 min idle (`ttlMs`, config `discovery.sessionTtlMs`) and the journal stays for export and `cairn_discover_resume`. See `cairn docs discovery` for the full workflow.",
      },
      {
        title: "Authoring and Services Tools",
        body: "The `author-flow` prompt (and `cairn docs author-flow`) is the recipe from a request to a promoted spec: `cairn_catalog` → `cairn_discover_open` with a login setup → interact → `cairn_discover_export` into the drafts dir with conventions → `cairn_spec_lint` / `cairn_spec_finish` until green → report, then `cairn_spec_promote` only after the human approved. `cairn_services_up` / `cairn_services_down` (server started with `--allow-services`) keep the config services running between runs under an owner lock; while it is held, `cairn_run` and `cairn_audit` for that environment need `reuseServices: true` (readiness check, nothing started or torn down, cold browser).",
      },
      {
        title: "Journey briefs",
        body: "`cairn_export_brief` compiles a spec into operator instructions (what to fill, what to look for). `cairn_accompany_open` / `_choose` / `_status` / `_list` / `_close` run the spec with try-then-ask: authored locators first; on miss the harness picks WHERE and Cairntrace keeps WHAT. See `cairn docs brief`. Discovery records a spec; accompany plays one.",
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
    relatedTopics: ["overview", "artifacts", "backends", "discovery", "brief"],
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
        body: "Cairntrace does not start your app by default, but an optional `webServer:` block in `cairntrace.config.yml` lets `cairn run` own the build → boot → readiness → setup → teardown for the whole invocation (one server shared by every spec, started once before the pool and stopped once after — parallel-safe), the same role Playwright's `webServer` plays. Readiness is satisfied by `url` (an HTTP probe that needs a 2xx/3xx answer; `anyResponse: true` restores the 2.x any-answer rule; a reused server must also be ready within `readyTimeoutMs`), `waitForText` (a stdout/stderr substring), or the resolved environment `baseUrl` when neither is set. `reuseExisting` defaults to true (reuse a server already answering the URL and skip its build/setup/teardown), but flips to false under `--cold-start` or a truthy `CI` so CI always boots fresh; an explicit value wins. `env:` is merged over `process.env` for the spawned process and the setup/teardown commands, and `${env.X}` substitutes in config text so dynamic ports need no per-run YAML. On readiness timeout, an early crash, or a non-zero run, the last 80 lines of the captured `web-server-<pid>.log` are surfaced. Boot/setup failures exit 2 (errored); teardown is best-effort. Ctrl-C tears the server (and its process tree) down. Pass `--no-web-server` to skip the block when you manage the server out of band. Under Bun the server is spawned with `Bun.spawn` and setup/teardown shell out through `Bun.$`.",
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
        body: "Cairntrace run directories are self-contained: run.json, agent_context.md, events.ndjson, screenshots, snapshots, traces, and videos. Stashing them to file.cheap persists them beyond retention cleanup, makes them searchable across runs on this machine, and enables the investigate pipeline (fcheap connect → vecgrep → code matches). The local vault is not uploaded or replicated automatically; `cairn publish` is the explicit upload.",
      },
      {
        title: "Evidence gate",
        body: "Every stash of a run directory (auto-stash, `cairn stash save`, `pin --stash`, the retention archive, `cairn investigate`, `cairn audit --connect`, `cairn clip --stash`, auto-investigate) and every publication goes through one gate. Categories: `text` (run records, events, logs, snapshots, network/console, outcome evidence), `screenshots`, `traces`, `videos`, `downloads` (downloads/ and transforms/). Default `[text, screenshots]`: traces, videos and downloads stay local unless `stash.include` / `retention.publish.include` / `--include` lists them (`text` is always included; `--include` replaces the list). When something is left out a private staged copy named after the run is saved, and the receipt lists `excluded`. `artifact-manifest.json` gives every file a `sensitivity`: `redacted` (written by cairn through the run redactor), `safe` (screenshots, videos, downloads — no credential structure, may still show personal data), `sanitized` (a trace the best-effort sanitizer rewrote: stashed when `traces` is included, never published) and `secret-bearing` (an unsanitized trace, a raw monitor heap profile, text cairn did not write itself such as `--after` collector output: stashed only with `stash.unsafeIncludeRawTraces: true`, never published). The retention archive is lossy for what the gate leaves out: it is deleted with the pruned run.",
      },
      {
        title: "CLI Commands",
        body: "`cairn stash save <run-id> [--tag] [--ttl] [--include <category>] [--labels-as-tags]` stashes a run directory through the gate (run-id: run id, 'latest', or 'previous') and writes `stash-receipt.json` with `action: manual`. `cairn stash list` lists stashes (repeatable --tag, --tool). `cairn stash info <stash-id>` shows detailed metadata. `cairn stash restore <stash-id> [--to <dir>]` restores a stash. `cairn stash search <query>` searches across all stashed runs (supports --mode keyword|semantic|hybrid). `cairn pin <run> [--reason] [--stash]` / `cairn unpin <run>` keep a run out of retention (`--stash` saves it with the `keep` tag and no TTL). `cairn publish <run> [--retention-days N] [--include]` sends the gated run to the private file.cheap artifact service (needs FILECHEAP_ARTIFACT_SERVICE_URL + FILECHEAP_INGEST_TOKEN) and writes `publish-receipt.json`. All commands support --format json|yaml|md.",
      },
      {
        title: "Auto-stash",
        body: "`cairn run --stash` stashes every run whatever its status; `--stash-on-failure` stashes failed/errored runs; config `stash: { enabled: true, autoStash: always | on-failure | never }` does it per project. A refused run (environment policy) is never stashed. Tags: the spec name, `stash.tags`, a spec's top-level `stash: { tags }`, and run labels with `stash.labelsAsTags: true` (default false). TTLs: `passTtl` (passed runs, default 7d), `failTtl` (failed/errored, default `ttl`, else 90d; `failTtl: never` keeps them, and a pinned run saved with `cairn pin --stash` has no TTL), `ttl` for both. `stash.meta` (default true) passes run identity (run_id, status, spec, env, backend, cairn_version) as `fcheap save --meta` when fcheap supports it. Best-effort: a missing fcheap never fails the run. Success writes `stash-receipt.json` (stashId, status, action, contentHash, fileCount, sizeBytes, ttl, expiresAt, tags, excluded, secretsFound), an `artifact.stash` event and a refreshed manifest; a failure writes an `artifact.stash` event with `status: error` and a reason code (fcheap-missing, save-failed, auth, too-large, timeout, secrets-blocked, unknown). The receipt never contains local paths, stderr or secret values and does not change the run verdict; because the save happens first, the receipt is not part of the stash itself. Explicit stashes (`cairn stash save` without `--ttl`, investigate, audit `--connect`, `clip --stash`) carry `stash.include` and `stash.meta` but no TTL.",
      },
      {
        title: "Config",
        body: "Enable stash integration in cairntrace.config.yml:\n```yaml\nversion: 1\nenvironments:\n  local: {}\nstash:\n  enabled: true\n  autoStash: on-failure   # always | on-failure | never (default)\n  tags: [regression, audit]\n  include: [text, screenshots]   # add traces / videos / downloads to carry them\n  failTtl: 30d   # default 90d; `never` opts out\n  passTtl: 7d\nretention:\n  keepRuns: 3\n  archiveToStash: true           # gated by stash.include, carries stash.ttl\n```\nWhen autoStash is on-failure, every failed run is automatically stashed with the spec name and configured tags.",
      },
      {
        title: "MCP Tools",
        body: "MCP tools mirror the CLI: `cairn_stash_save` (stash a run by runId through the same gate; `include` and `config` inputs; writes the receipt), `cairn_stash_list` (list stashes, optional tag/tool filter), `cairn_stash_info` (validated manifest metadata), `cairn_stash_restore` (restore with required hash verification), `cairn_stash_search` (search across all stashed runs), `cairn_pin` (`unpin: true` removes the pin, `stash: true` saves the keep stash) and `cairn_publish`; `cairn_run` accepts `stash: true`. Save results expose the resolved `runId` and file.cheap identifier as `stashId`. Info and restore declare output schemas and validate file.cheap v0.30 JSON. Operational failures return stable structured error codes and hints; an unverified restore preserves its receipt under `structuredContent.restore`.",
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
          "  --stash --tag demo --tag sample-app \\",
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
  fixtures: {
    title: "Fixtures registry (exec, mongo, http)",
    summary:
      "Declare test data once in the config `fixtures:` block and list it in a spec's `fixtures:`; cairn ensures it (needs first) after the preconditions, splices its outputs as `${fixtures.<name>.<key>}`, and tears run-scoped fixtures down on every exit path. Replaces ensure/clear/provision scripts in preconditions and outcomes with side effects.",
    sections: [
      {
        title: "Registry",
        body: "`fixtures: { <name>: { kind: exec | mongo | http, scope, ensure, reset, verify, teardown, with, outputs, needs, owner, ttl, timeoutMs, description } }` in cairntrace.config.yml. A fixture needs `ensure` or `reset`. `needs` are ensured first; a fixture may only need fixtures that live at least as long (seed > suite > run); cycles and unknown names are config errors. `with` holds default parameters (`${with.X}`); a spec reference overrides them. `timeoutMs` is the default budget of each verb (120000); a verb's own `timeoutMs` wins. Strings may use `${with.X}`, `${fixtures.<name>.<key>}` (a need's outputs, or the fixture's own in reset/verify/teardown), `${vars.X}`, `${secrets.X}` / `${env.X}`, `${baseUrl}`, `${run.token}` and `${now}`; a whole-string placeholder keeps its type and an unresolved one fails the verb.",
      },
      {
        title: "Verbs and scopes",
        body: "`ensure` makes it exist (idempotent), `reset` puts it back to its initial state, `verify` is a read-only presence check (it also runs right after ensure), `teardown` removes it. A spec lists `name` (ensure; a fixture with only `reset` is reset instead), `name.reset` (ensure, then reset, before the steps) or `{use: name | name.reset, with: {…}, write: true}`. Scope `run` (default): ensured per run, torn down after the spec teardown in reverse order — after a failure, a cancel, and (exec fixtures) from the SIGINT/SIGTERM handler too. `suite`: ensured once per `cairn run` invocation (parallel runs wait on the same ensure) and torn down when it ends. `seed`: ensured once per services seed and never torn down by a run; with `ttl` (and a passing `verify`) a recorded ensure is reused instead of running again, and a new seed run makes it stale.",
      },
      {
        title: "Adapters",
        body: "`exec`: a shell string or `{shell | node, args, cwd, env, timeoutMs}` (node scripts and cwd resolve against the config directory; args arrive as $1…$n); the child sees CAIRN_FIXTURE_NAME / _VERB / _SCOPE / _WITH / _OUTPUTS / _MARKER plus the run context, and its last stdout line, when it is JSON, is the result. `mongo`: a list of operations on a `datasources:` entry — insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, cloneDoc ({from: filter | [fallbacks], to: {_id}, set, unset, fromCollection}: copy the first matching source onto the target with replaceOne upsert), findOne, count — each with `expect` ({matched, modified, upserted, deleted, inserted, count, found, fields}) and `as`; values are extended JSON (`{$oid}`, `{$date}`); a read-only datasource refuses every write. `{script, args}` is the escape hatch: a mongosh script (relative to the config dir) with `db` bound to the datasource and `args` decoded from EJSON; its last stdout line is the result. `http`: `{find: {path, items, where}, create: {path, body, item}, refind, requests}` (find-or-create by natural key) or a request list, against an `http` datasource or `baseUrl` (default the environment's); `login: {path, body, token: $.token, header, scheme}` logs in once per verb and sends the token on every request; statuses default to 2xx.",
      },
      {
        title: "Outputs, ownership and evidence",
        body: '`outputs: { key: "$.path" | template | {from, secret: true} }` — a JSONPath reads the verb result (exec: the JSON line; mongo: `$.ops[i]`, `$.<as>`, `$.last` with counts, `upsertedId`, `insertedId`, a found document, cloneDoc\'s `id` / `sourceId`; http: `$.item`, `$.created`, `$.found`, `$.<as>`, `$.last`); a template is resolved; a secret output is usable but never written to evidence. Without `outputs` an exec result object becomes the outputs. `owner.exactlyOne` fails when the natural key matches more than one record (http find, mongo update/replace/delete/clone targets). `owner.marker` is stamped on everything the fixture creates (mongo inserts, clones, replacements, `$setOnInsert` on upserts; merged into an http create body; CAIRN_FIXTURE_MARKER for exec), and mongo deletes — and every mongo write of teardown — only touch documents that carry it. Every verb emits `fixture.ensure | fixture.reset | fixture.verify | fixture.teardown` {name, adapter, status ok | failed | skipped | dry-run, durationMs, scope, outputs?, error?, reason?} (suite and seed fixtures also to the invocation journal), the run writes `fixtures.json` {version 1, entries [{name, adapter, scope, ensuredAt, outputs, status, reset, teardown}]}, and every verb is appended to `~/.cairntrace/fixtures/<project>.ledger.jsonl`. A failed ensure or reset errors the run in phase `fixture` (what was ensured before it is still torn down); a failed teardown is reported and never changes the run status.',
      },
      {
        title: "Shared environments",
        body: "On an environment whose `policy.trait` is `shared`, ensure / reset / teardown are dry-run (`status: dry-run`, nothing written) unless `cairn run --allow-fixture-writes` (MCP `allowFixtureWrites`) or the spec reference says `write: true` (it covers the fixture's needs). A dry-run ensure still runs the read-only `verify` to prove the data is there and read its outputs (else the ledger's last outputs); a failing verify errors the run.",
      },
      {
        title: "CLI and MCP",
        body: "`cairn fixtures list | status [name…] [--verify] | ensure <name> [--with k=v] [--allow-writes] | reset <name> | teardown <name> | sweep [--older-than 1h] [--apply] [--include-seed]` with `--config`, `--env` and `--format json|yaml|md` (`urn:cairntrace.dev:fixtures:v1`; exit 0 ok incl. dry-run, 1 a verb failed, 2 error, 4 invalid input). `status` folds the ledger into live / expired / failed / torn-down / never per environment; `teardown` and `sweep` use the outputs the last ensure recorded; `sweep` skips fixtures whose recording process is still running, without a teardown verb, no longer in the config, younger than --older-than, and seed fixtures unless --include-seed or past their ttl. MCP: `cairn_fixtures_list`, `_status`, `_ensure`, `_reset`, `_teardown`, `_sweep`. `cairn catalog --kind fixtures` lists the registry with the specs that use each fixture.",
      },
    ],
    examples: [
      {
        title: "fixtures registry (cairntrace.config.yml)",
        language: "yaml",
        code: 'version: 1\nproject: demo\ndefaultEnvironment: local\nenvironments:\n  local:\n    baseUrl: http://localhost:3000\n  staging:\n    baseUrl: https://staging.demo.test\n    policy: { trait: shared }\ndatasources:\n  appdb:\n    kind: mongo\n    docker: { service: mongo }\n    database: demo\n    guard: { databases: [demo] }\nfixtures:\n  # A kit cloned from seed data onto a fixed id; re-applied after each seed.\n  demo_kit:\n    kind: mongo\n    datasource: appdb\n    scope: seed\n    ttl: 6h\n    with: { kitId: 6a0000000000000000000001 }\n    owner: { exactlyOne: true, marker: { cairnFixture: demo_kit } }\n    ensure:\n      - cloneDoc:\n          collection: kits\n          from: [{ kind: deliverable, cairnFixture: { $exists: false } }]\n          to: { _id: { $oid: "${with.kitId}" } }\n          set: { label: Demo kit 2026 }\n          unset: [taskCounts]\n        as: clone\n    verify:\n      - findOne: { collection: kits, filter: { _id: { $oid: "${with.kitId}" } } }\n        expect: { found: true }\n    outputs: { kitId: "${with.kitId}" }\n  # Empty the kit\'s rows before every run that asks for kit_rows.reset.\n  kit_rows:\n    kind: mongo\n    datasource: appdb\n    needs: [demo_kit]\n    reset:\n      - updateOne:\n          collection: kits\n          filter: { _id: { $oid: "${fixtures.demo_kit.kitId}" } }\n          update: { $set: { rows: [] } }\n        expect: { matched: 1 }\n  # Find-or-create by natural key through the app API (the env\'s baseUrl), torn down per run.\n  buyer:\n    kind: http\n    with: { name: Demo Buyer }\n    owner: { exactlyOne: true }\n    login:\n      path: /api/login\n      body: { email: fixtures@demo.test, password: "${secrets.FIXTURE_PASSWORD}" }\n      token: $.token\n    ensure:\n      find: { path: /api/entities, items: $.entities, where: { name: "${with.name}" } }\n      create: { path: /api/entities, body: { name: "${with.name}" }, item: $.entity }\n    teardown:\n      - { method: DELETE, path: "/api/entities/${fixtures.buyer.id}", status: [204, 404] }\n    outputs: { id: $.item.id }\n  # Anything else: a script whose last stdout line is JSON.\n  worker:\n    kind: exec\n    scope: suite\n    ensure: { node: tools/start-worker.mjs, args: ["${vars.queue}"] }\n    teardown: { node: tools/stop-worker.mjs, args: ["${fixtures.worker.pid}"] }\n    outputs: { pid: $.pid }',
      },
      {
        title: "a spec that uses fixtures",
        language: "yaml",
        code: 'version: 1\nname: import_rows_render\nintent: Imported rows render in the kit table for a fresh buyer.\nrequires: { env: [local] }\nfixtures:\n  - kit_rows.reset\n  - { use: buyer, with: { name: Demo Buyer Import } }\nimports: [../actions/login.yml]\nsteps:\n  - use: login\n  - open: /kits/${fixtures.demo_kit.kitId}?buyer=${fixtures.buyer.id}\noutcomes:\n  - id: kit_persisted\n    description: The kit the flow opened is still in the database\n    verify:\n      mongo:\n        source: appdb\n        collection: kits\n        filter: { _id: { $oid: "${fixtures.demo_kit.kitId}" } }\n        expect: { count: 1 }',
      },
      {
        title: "inspect and clean up",
        language: "bash",
        code: "cairn fixtures status --verify --json\ncairn fixtures ensure buyer --with name=Demo\\ Buyer --env local\ncairn fixtures sweep --older-than 2h --apply",
      },
    ],
    relatedTopics: ["services", "verifiers", "steps", "authoring"],
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
        body: "The `seed` step runs a data-import command conditionally based on three layers of freshness: (1) fingerprint — a SHA-256 of the command + env keys (not values, so secret rotation doesn't trigger re-seed); (2) TTL — re-seed if the last run was more than `ttlSeconds` ago; (3) optional `freshnessCheck` — a shell command whose exit 0 means data is fresh. State is tracked in `~/.cairntrace/services/<project>.seed.json`. Set `ttlSeconds: 0` (default) to always re-seed unless `freshnessCheck` passes. `timeoutMs` bounds the seed command (default 300s); set it to `0` to wait indefinitely. Optional `postCommands` always run after the seed decision (whether the heavy import ran or was skipped as fresh) — use them for lightweight fixture ensure scripts the bulk import does not ship. They may be objects (`name`, `when`, `continueOnError`, `timeout`); see Seed Transaction for phases, `commit` and `expectOutput`. Seed output is buffered, redacted as one stream, then forwarded to interactive output so a secret split across chunks cannot leak. When `secrets.provider: tvault` is configured, the seed inherits only the invocation's selected scoped secrets.",
      },
      {
        title: "tmux Phase",
        body: "The `tmux` step creates a tmux session from scratch via `tmux new-session -d`, then creates N windows, each running one service. `reuseExisting` defaults to true: if the session already exists, it's reused. Under `--cold-start`, any existing session is killed first. Each window has a `name` (must be unique), `cwd` (relative to configDir or absolute), `command`, optional `readyOn` readiness signal, optional `env` (per-window env merged over session env + process.env), and optional `preCommands` (run before the main command, e.g. `yarn build` before `yarn start`). A preCommands entry may also be an object `{run, skipIf}`: `skipIf` is a shell probe executed HOST-SIDE with the window's cwd before sending `run` to the pane — exit 0 means already-fresh, skip `run` (the seed freshnessCheck pattern applied to builds: skip a minutes-long `yarn build` when dist/ is newer than every source file). Probe failure or non-zero exit runs the pre-command, so a broken probe can never silently skip a required build. Readiness is probed via `readyOn.url` (HTTP probe: a 2xx/3xx answer unless `anyResponse: true`) or `readyOn.text` (tmux capture-pane text match), plus an optional `readyOn.gate` that must also pass; `after: [gates]` delays booting a window until those gates pass. `readyTimeoutMs` bounds the total wait (default 90s); set it to `0` to wait indefinitely. In interactive runs, while a window isn't ready yet its pane tail is streamed every few seconds so you can see startup logs / errors instead of a blind wait. Session-level `options` are applied via `tmux set-option`, and session-level `env` is propagated to all windows via `tmux set-environment`.",
      },
      {
        title: "Healthchecks",
        body: "Both docker and individual tmux windows support a `healthcheck` block — modeled on Docker's healthcheck semantics. It runs a command after the service is ready: `command` is the check command (exit 0 = healthy), `startPeriodSeconds` is a grace period before the first check (default 0), `intervalSeconds` is the delay between retry attempts (default 30), `timeoutSeconds` bounds each check (default 10), and `retries` is the max attempts before marking unhealthy (default 3). Healthcheck failure is a WARNING — it does not fail the run, it logs a diagnostic. This mirrors Docker Compose healthcheck semantics and lets you catch infra that started but isn't healthy (e.g. ES responding on 9200 but cluster is red).",
      },
      {
        title: "Docker Readiness Check",
        body: "The `docker.readinessCheck` field runs a shell command after `docker compose up` completes. Exit 0 means infra is ready; non-zero fails the run with the stderr tail. Use this when `docker compose up -d` returns before the services are actually reachable (e.g. `curl -sf http://localhost:27017` for mongo). For anything beyond one command, prefer typed readiness gates (`docker.ready`).",
      },
      {
        title: "Readiness Gates",
        body: "A readiness gate is a typed probe plus a waiting policy, declared in the config's top-level `gates:` registry and referenced by name (or inline) wherever something must be ready. Exactly one probe per gate: `tcp` (`host:port`), `http` (a URL, or `{url, method, status, json, text, headers, auth, timeoutMs}` — `status` is a code, a class like `2xx`, a range like `200-299` or a list, default 2xx/3xx with redirects not followed; `json` maps dotted paths to a value or `{equals, in, contains, matches, exists, gt, gte, lt, lte}`; `auth` is `{basic}` or `{bearer}`, never reported — write credentials as `${secrets.X}`, resolved from the scoped environment when the gate runs; `${env.X}` is substituted when the config loads and an unset one becomes empty, which a 401/403 then names), `command` (`{run, exitCode, stdout, cwd, env, timeoutMs}`; each attempt runs in its own process group, settled by the shell's exit and killed once it exits or past `timeoutMs`, default 30s), `gate` (another name), `all` / `any` (lists). Policy of the waited gate: `stable` (N consecutive passing attempts; a nested gate's `stable` counts its own streak, once per attempt; one-look liveness checks ignore `stable`), `every` (pause, default 1s), `timeout` (budget, default 60s; 0 = none); durations take ms or `500ms`/`30s`/`5m`/`1h`. String references: a registry name, `http(s)://…` (2xx/3xx) or `tcp://host:port`. Use them in `services.docker.ready` (after the start command and readinessCheck, also on container reuse; default budget what readinessCheck left of the docker `readyTimeoutMs`), tmux `windows[].after` (waited before booting the window, with the session + window env; default budget the tmux `readyTimeoutMs` per gate), tmux `windows[].readyOn.gate` (must pass in addition to url/text; the window deadline is its budget), `webServer.ready` (after url/waitForText, also for a reused server), a spec's `preconditions.wait` (before the commands; failure = precondition `wait <gate>`) and `cairn wait <gate|url…>` / MCP `cairn_wait` (`urn:cairntrace.dev:wait:v1`; exit 0 ready, 1 not ready, 2 unreadable config, 4 invalid input). `preconditions.wait` writes `gate.started` (name, budgetMs, scope), coalesced `gate.attempt` (attempt, ok, detail) and `gate.passed` / `gate.failed` (attempts, durationMs, lastDetail, timedOut, cancelled) to events.ndjson and sets the phase banner item to the gate name with its budget; services waits record `services.docker.readiness-check` / `services.tmux.ready-wait` events with the gate name. Unknown gate names (in the registry, `services` and `webServer`) and reference cycles are config errors.",
      },
      {
        title: "URL Readiness Needs 2xx/3xx",
        body: "`webServer.url` (or the environment `baseUrl` it probes when the block sets neither `url` nor `waitForText`) and tmux `readyOn.url` used to accept ANY HTTP answer as ready, a 503 from a proxy in front of a booting app included. They now need a 2xx or 3xx answer. Set `anyResponse: true` on the `webServer` block or the window's `readyOn` to keep the old rule, or point the URL at a health route. A readiness timeout names the last status and the `anyResponse` fix, and a URL stuck on the same non-ready status for 10s gets one warning (`readiness: <url> has answered 401 for 10s …`); a short 503 warm-up does not. The webServer port-conflict check still treats any answer as 'something is listening', and a reused server must also become ready within `readyTimeoutMs`. `--reuse-services` liveness applies the same rule to `readyOn.url` and takes one look at each `readyOn.gate` and `docker.ready` gate.",
      },
      {
        title: "Run-Local Service Artifacts",
        body: "Before each run is finalized, Cairntrace can attach bounded, redacted service evidence under `<runDir>/services/`: lifecycle NDJSON, docker/provisioner command transcripts, tmux pane tails (including reused sessions), timestamped local Docker Compose logs limited to the run window, and seed/post-command output. A remote provisioner such as Chalupa keeps its launch/tunnel transcript without probing an unrelated local Compose project. `services.artifacts.when` accepts `on-failure` (default), `always`, or `never`; source defaults are all four with `maxLinesPerSource: 2000`, `maxBytesPerSource: 524288`, and `maxBytesPerRun: 8388608`. Capture errors are recorded in `services/manifest.json` and never change the behavioral verdict. Inspect with `cairn logs [ref] --services` or replay one pane with `cairn logs [ref] --service <window>`. Normal run retention removes the pack with its run.",
      },
      {
        title: "Config Validation",
        body: "Run `cairn config validate [--config <path>]` to validate a cairntrace.config.yml file. It parses and composes the file exactly like `cairn run` (`${env.X}` / `${env.X:-default}`, YAML merge keys `<<: *anchor`, `${config.dir}`, `include:`, top-level `vars:`, `extends:`, `${vars.X}` inside vars), then checks structure (zod schema), cross-field rules (unique tmux window names, readyOn must have url or text, tvault provider requires tvault block) and composition (missing include, include / extends / var-reference cycles, unknown extends target; a var reference left for run time is a warning), and reports all errors with JSON-path locations (an included file's errors name the file). A valid config can carry warnings: dead vars (nothing uses them), include globs (top-level or `environments.<n>.include`) that match nothing, `suite-env-fallback` (a suite's `requires.env` admits an environment with no `env.<n>` block while a sibling admitted environment has one: a run there silently takes the suite-level specs, vars and hooks) and `literal-var-ref` (an authored `${vars.X}` in a config field that is read literally at run time, such as `environments.<n>.baseUrl`, `webServer` or a metric `command`; `${vars.X}` expands only in specs, actions, fixtures, gates, datasources, suites, http metrics, environment `auth` and other vars); include overrides are `findings` (info) and `includes` lists the merged files. Exit 0 = valid, 4 = invalid. Supports `--format json|yaml|md`.",
      },
      {
        title: "Config Composition (include, vars, extends)",
        body: "Shared values live once. Top-level `vars:` apply to every environment (an environment's own `vars` win by name). `environments.<n>.extends: <other>` starts an environment from another one: objects merge key by key, lists and scalars replace, `vars` merge by name, `services: false` / `datasources.<name>: false` replace; chains are allowed, cycles and unknown names are errors. `environments.<n>: { alias: <target> }` is the same environment under another name (`extends` inherits and then overrides a NEW environment; an alias copies nothing): `--env <alias>`, a spec's `environment:` and `defaultEnvironment` are canonicalized to the target where they are parsed, so suites (`requires.env` / `env.<n>`), a spec's `requires.env`, the environment policy, seed and tunnel state keys, locks, `CAIRN_ENV` and `cairn config vars --env` all see the target; `run.json` and `invocation.json` record `envAlias` additively. An alias takes no other key and names a real environment (chains, cycles, unknown targets, an alias extended by another environment and an alias named in a suite are errors). `${vars.X}` inside a var value resolves once per environment after the merge (`apiUrl: \"${vars.host}/api\"`); a value that is exactly one reference keeps the referenced value's type; `${vars.X:-default}`; cycles are errors, while a reference to a var the config does not define is a warning and resolves at run time from `--var` or a spec's `vars:` (from the authored template: a `${vars.X}` inside an env or secret value stays inert). Vars may be lists and objects: an unquoted whole `key: ${vars.X}` in a spec keeps the structure (a script verifier's `fixtures:`, `ctx.vars`), a string context gets compact JSON, `${vars.X.key}` / `${vars.X.0}` read inside. `include: [paths or globs]` (relative to the listing file; `*`, `?`, `**`; .yml/.yaml) merges `vars`, `fixtures`, `gates`, `datasources` and `suites` from other files validated with the same schema — by name, later files win, the including file wins, every override is a finding. `environments.<n>.include: [paths or globs]` does the same for one environment's own vars: the listed files hold `vars:` (and may `include:` more files of the same environment), they merge in order and the environment's own inline `vars` win over them. Precedence per environment: top-level `vars` (and top-level includes) < the `extends` chain, root first, each member's included files then its own vars < the environment's included files, then its own vars. Use it when environments carry different var sets: `local: { include: [config/vars/local.yml] }` keeps each file's names out of the other environments (a var an environment does not define stays unresolved there), unlike promoting them to top-level `vars:`. An included file may carry only `vars` and `include` here; a top-level include may not declare `environments:`. Missing files, cycles and other keys are errors naming the file; overrides are `include-override` findings keyed `environments.<n>.vars.<name>`; a var's `definedAt` / `at` is the file:line of the included file. `cairn config vars [--env] [--unused] [--used-by <spec>]` (MCP `cairn_config_vars`) lists each var's kind, effective value per environment (masked when secret-like), definitions (file:line), overrides and uses. A config that uses none of this reads exactly as before.",
      },
      {
        title: "Teardown",
        body: "Teardown commands run in reverse order after all specs finish (best-effort, non-fatal). The tmux session is killed if we started it. `--no-services` skips the entire block when you manage the environment out of band. Ctrl-C / SIGTERM triggers synchronous tmux kill via the cleanup tracker; a second Ctrl-C, a SIGTERM or a SIGHUP while that bounded cleanup runs is ignored (cairn prints `cleanup in progress (…); send SIGKILL to force`), so a provisioner `down`, `run.finally` and the lock release are never cut short. An entry may be `{ run, critical: true, timeout, onSignal: wait }`: a critical entry that exits non-zero or times out fails the run with exit 8 (outranks every verdict and exit 9); `timeout` kills its process group; `onSignal: wait` makes the SIGINT/SIGTERM path wait for it up to its timeout instead of the short signal cap. See Run Policy.",
      },
      {
        title: "Service Operations (restart, logs, supervision)",
        body: "A stack that outlives one run needs the operations a Taskfile used to carry: restart one service, read its output since the restart, keep a tunnel up, bring a billable resource up and always take it down, rewrite a config file the services read. They are config. Phase order: `provisioner` → `tunnels` → `docker` → `files` → `seed` → `tmux`; teardown runs the other way (supervision stops, teardown commands, tmux kill, tunnels stop, provisioner `down`).\n\n- `cairn services restart <window...> [--stop-timeout 30s] [--ready-timeout 90s] --json` (`urn:cairntrace.dev:services-restart:v1`): Ctrl-C (again at 40% of the budget), wait for the pane's process to exit (never a hard kill; a window that ignores Ctrl-C fails with `stop-timeout`), clear the history, print a `@@cairn-restart:<id>@@` marker, resend `env`, `preCommands` (with `skipIf`) and `command`, and wait for `readyOn` of the NEW output: `readyOn.text` is matched only below the marker, so stale scrollback never counts. A failure stops the sequence (the rest are `skipped`). Refuses with exit 4 and touches nothing when the session is not running, a name is not a window of the configured session, the window is missing from the live session, or a live `cairn run` supervises the session. tmux targets are exact (`=session:=window`): a session or window whose name only starts with the configured one is never touched; a pane whose shell runs a foreground job (`bash start.sh`) counts as running.\n- `cairn services logs <window> [--since-restart] [--lines 200] [--wait <regex> --timeout 30s] [--follow]` (`urn:cairntrace.dev:services-logs:v1`): the pane (`capture-pane -J`, wrapped lines joined), redacted. `--since-restart` keeps what follows the last marker (everything, and it says so, without one); `--wait` exits 0 on a match, 1 on timeout; `--follow` streams text until interrupted.\n- `services exec <window> -- <cmd>` is deliberately absent: keys typed into a service's pane interleave with its output, report no exit status and race the process. Use a `run:` step, a `teardown`/`finally` entry, a fixture, `services.files` or `restart`.\n- Supervision (only while a run is active; `cairn services up` exits after the boot): a window with `restart: {policy: on-exit, backoff, max}` is started again when its process exits (backoff default 1s doubling to 30s, `max` consecutive restarts default 5, then `services.restart.giveup`); `healthcheck.onUnhealthy: warn|restart` runs the check every `intervalSeconds` for the whole run and warns or restarts the window after `retries` failures. New sessions are 250x50 (`tmux.columns` / `rows`) and panes are captured with `-J`.\n- `tunnels: [{name, command, restart: always|never, giveUpAfter, backoff, ready: gate, readyTimeout}]`: own process group, output in `~/.cairntrace/services/<key>-tunnel-<name>.log`, pid, state and owner in `<key>.tunnel.<name>.json` (`<key>` = project + environment + a hash of the config path, so two checkouts or environments never stop each other's tunnels; one a live cairn process owns is never reclaimed, and only a running tunnel's own process is signalled). A tunnel that exits before `ready` fails the boot with its output; `restart: always` restarts it during a run (`giveUpAfter` consecutive failures, default 5); stopped on every exit path and by `services down`; a copy a crashed run left (same pid and start time) is stopped first. Events `services.tunnel.start|ready|exit|restart|giveup|stop|fail`.\n- `provisioner: {up, down, exports}`: `up` runs first; each `exports` command prints exactly one value and becomes an env var of every later phase, hook, spec and verifier (events carry names only; credential-named values are redacted; `PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `LD_*`, `DYLD_*` are refused). `down` is mandatory, defaults to `critical: true` + `onSignal: wait`, is registered before `up` runs and so runs after a failed `up`, a failed later phase and SIGINT/SIGTERM, after the tmux session and tunnels; a failed or timed-out `down` is exit 8 (also from `cairn services down`). A provisioned environment never reuses a tmux session. `--reuse-services` re-evaluates the exports.\n- `files: [{path, json | text, restart: [windows], mode}]`: atomic write (temp + rename; an existing file keeps its mode, a new one is `600` unless `mode` is set; a symlink is written through to its target) before the seed; `json` deep-merges (`null` removes a key) and never overwrites a file that is not a JSON object; `${exports.NAME}` (late-bound) and `${env.NAME}` in values; `services.files.write|unchanged|fail` record before/after `sha256:` fingerprints and byte counts, never content; a changed file restarts the listed windows that were already running.\n- Per environment: `docker: false` drops the docker phase; `provisioner` merges key by key (`false` removes it); `tunnels` / `files` replace (`false` removes them).",
      },
      {
        title: "Seed Transaction (phases, commit, post-commands, expectOutput)",
        body: '`seed.phases: [{name, command|run, skipIf, always, timeout, cwd, env, expectOutput}]` replaces the single `command`. A phase runs when `always` is set; otherwise it is skipped when a recorded success of the same command is within `ttlSeconds` (no TTL: it runs) or its `skipIf` passes (`skipIf: "<cmd>"` / `{command}`, exit 0 = skip; `{gate}`). Each outcome is persisted per project + environment + `seed.target` hash in `~/.cairntrace/services/<project>.<env>.<hash>.seed-state.json`; a failed phase is recorded at once, so the next run repeats it; a run that failed on a phase is resumed (the phases that had succeeded in it are skipped next time, until a run completes every phase), once: a resumed phase with a `skipIf` must still pass it, a resume older than `ttlSeconds` is ignored, a phase only carried by a resume is not carried again, and a teardown (failure cleanup, signal, `cairn services down`) drops it. Events `services.seed.phase.start|skip|complete|fail`.\n\n`seed.commit: afterPostCommands` stamps freshness (the single-command record, or every phase) only after every post-command succeeded; otherwise the next run seeds again (`services.seed.commit` says which). The default `afterCommand` is the 2.x behavior. A seed with `commit` or `target` keeps its record per environment and target.\n\n`postCommands` entries are strings or `{name, run, when: {suite, env}, continueOnError, timeout, expectOutput}`. `when` skips the command for other suites/environments (`services.seed.postcommand.skip`); `continueOnError` records the failure and goes on (with `commit: afterPostCommands` it still blocks the commit); a fatal failure names every earlier tolerated one. `suites.<n>.seed.postCommands.skip` matches a named post-command by `name` and a plain string by its exact text; a stray entry is a warning.\n\n`expectOutput: {notMatches: [regex]}` (on the seed, a phase or a post-command) fails a command that exits 0 but prints a match; the error quotes the line and the freshness record is not stamped.',
      },
      {
        title: "Engine Pin (requires, runtimes)",
        body: '`requires: {cairntrace: ">=3.1"}` (a semver range: `>=`, `^`, `~`, x-ranges, `||`, hyphen ranges) is enforced when the config loads: a run, `cairn spec verify`, `cairn catalog`, every command that reads the config and every MCP tool refuse a cairn that does not satisfy it with exit 4 and a message naming both versions. `cairn doctor [--config <path>]` (rows `config-requires`, `config-node-runtime`, only for what is declared; exit 4 when unmet) and `cairn config validate` report it. `runtimes.node: {path, version}` picks the node binary of node scripts, `script` verifiers and transforms: `CAIRN_NODE` wins, then `path` (relative to the config directory), then the first `node` on PATH that satisfies `version`, then the highest install that does under nvm, fnm, volta, asdf, mise or Homebrew. A node that is missing or out of range is exit 4 before anything starts. The chosen binary is exported to children as `CAIRN_NODE`.',
      },
      {
        title: "Run Policy (lock, preflight, verifyClean, finally, --bail)",
        body: "A wrapper script around `cairn run` usually does four things: it takes a lock so two suites do not fight over one stack, it refuses to start on a bad machine, it proves nothing survived, and it runs belt cleanup that must happen whatever the verdict. The config `run:` block declares all four, and the run engine enforces them for `cairn run` and for MCP `cairn_run` alike, so a bare `cairn run --env <name>` is as safe as the wrapper was. Every field is optional; a config without `run:` behaves as before.\n\n```yaml\nversion: 1\nenvironments:\n  local: {}\ngates:\n  stack-reachable: { tcp: \"127.0.0.1:8080\" }\nrun:\n  lock: { scope: config, staleAfterPidDead: true }   # or lock: true\n  preflight:\n    - name: engine posture\n      json: docker/posture.json\n      assert: .engine.mode == \"durable\" and .engine.workers >= 2\n    - { secret: DEPLOY_TOKEN }\n    - { command: \"bun tools/check-quota.ts\", expectExit: 0, timeout: 30s }\n    - { gate: stack-reachable }\n  verifyClean: [browsers, tmux, docker-project]\n  finally:\n    - \"bun tools/collect-diagnostics.ts\"\nservices:\n  teardown:\n    - { run: \"bun tools/destroy-compute.ts\", critical: true, timeout: 10m, onSignal: wait }\n```\n\nA top-level `run:` applies to every environment; `environments.<name>.run` merges over it key by key (lists replace, `lock: false` turns the lock off there).\n\n**Order.** Config and secrets resolve, then: lock, `preflight`, `verifyClean` (before), services and webServer boot, the specs, teardown, the critical-teardown verdict, `finally`, `verifyClean` (after), and the lock is released last. A refusal in the first three phases stops the run with exit 4 before anything of cairn's starts.\n\n- **`lock`**: `~/.cairntrace/locks/<label>.<hash>.run.lock.json`, created atomically (the finished file is hard-linked into place, so a reader never sees half a lock and two creators cannot both win) and holding the owner's pid, start time, redacted argv (`--var` keys only, never their values), invocation id, origin and environment. `scope: config` (default) is one lock per config file whatever the environment; `scope: project` is one per `project:` name across checkouts (a config without `project:` falls back to config scope). A live foreign owner refuses with exit 4 naming its pid, age and command line, and the `run.lock.refused` event says the same. A lock whose owner process is gone, or whose pid now belongs to a younger process, is stale: it is reclaimed with a warning (`run.lock.reclaimed`), unless `staleAfterPidDead: false`, which refuses until you remove the file. The lock is released on every exit path: the engine's own finally, the SIGINT/SIGTERM handler (last: after the run's still-running commands were ended, services stopped and `finally` ran) and a process `exit` hook. Two MCP invocations of one config in one server refuse the second (exit 4) instead of queueing. `cairn services up | down | restart` respect it too: exit 4 while a live run holds it, the lock held for their own duration otherwise (see Keeping Services Up). A policy guards one config: an invocation whose specs come from several configs where any declares `run:` (or one config whose environments give its specs different policies) is refused with exit 4, naming each config with a spec that resolves to it — run each config's specs in an invocation of their own, or pass `--config <path>` to run them all under one config (`--suite` alone does not help: a suite's specs still load their nearest config); a config that does not load refuses too.\n- **`preflight`**: checks run in order and the first failure refuses the run (exit 4) with a message naming it (`preflight[2] \"engine posture\" failed: assert ... is false for docker/posture.json (.engine.workers = 1)`). `json` reads a file relative to the config directory and evaluates `assert`; `secret` needs the name to resolve to a non-empty value in the run's scoped environment (it never prints the value; with `secrets.provider: tvault` every `preflight[].secret` name, and every `${env.X}` a preflight `command` or a `finally` entry uses, is fetched from the vault); `command` runs a shell command in the config directory with the scoped environment (`expectExit` default 0, `timeout` default 60s; the process group is killed at the deadline); `gate` looks once at a named `gates:` entry (it never waits). Failure text is redacted, and observed JSON values under credential-like keys show as `[redacted]`. `when: { suite, env }` (a name or a list, as on seed post-commands) runs a check only for those suites / environments: a `suite` condition never matches a run without `--suite`, a check left out is named in the log as skipped, and a failure keeps the check's own index.\n- **Assertion language** (`assert`): paths `.a.b[0]` (or `a.b`) against the JSON document; literals (numbers, `\"strings\"`, `true`, `false`, `null`); `==` `!=` `<` `<=` `>` `>=` (no type coercion; ordering needs two numbers or two strings); `in [..]`; `exists` (present and not null); `and` / `or` / `not` (also `&&` `||` `!`) and parentheses. A missing path is unequal to everything and unordered. It is a real tokenizer and parser, never `eval`; a syntax error is a `cairn config validate` error with its offset, and so is nesting deeper than 64 levels or more than 1024 tokens.\n- **`verifyClean`**: asserts that nothing of this project survives, before the run (a dirty machine refuses it, exit 4) and after it (exit 9, listing what survived; nothing is killed). `browsers`: browser sessions the owned-session ledger names for this project (a pid only while it is still the process cairn learnt — same start time and command — and still looks like a browser cairn launches) plus agent-browser daemons of cairn run sessions (`<session>.pid` in agent-browser's state directory) whose working directory is inside the project; another project's browser, a discovery or user session, a process that merely mentions agent-browser and cairn's own ancestors are never flagged. `tmux`: the services tmux session. `docker-project`: containers labelled with the compose project (taken from `-p` / `--project-name` in `services.docker.command`, `COMPOSE_PROJECT_NAME`, else the docker working directory's name; name it explicitly with `{ docker-project: <name> }` when the command changes directory). `{ tmux: <session> }` names a session. A Docker daemon that is not running (or no docker CLI) counts as clean, with a warning: no container can be running; any other failure to query it counts as dirty (an unverifiable guarantee is not one). After the run, survivors get a short grace (`CAIRN_VERIFY_CLEAN_GRACE_MS`, default 3000) to finish exiting. Under `--reuse-services` the stack is `cairn services up`'s: `tmux` and `docker-project` are not checked, `browsers` still is.\n- **`finally`**: commands run after the services/webServer teardown with `CAIRN_EXIT_CODE` (the code the run settled on, critical-teardown failures included, before the cleanliness check), `CAIRN_INVOCATION_DIR` (the journal directory), `CAIRN_ENV` and `CAIRN_CONFIG_DIR`. They are non-fatal: a failure is logged and journaled (`finally.finished` with its exit code) and never changes the exit code. A string or `{ run, timeout }` (default 60s). They also run after a failed boot, and not at all when the run was refused before anything started. On SIGINT/SIGTERM they run synchronously after the services teardown with `CAIRN_EXIT_CODE` 130 / 143 (output in `logs/finally-signal-NN.log`), each bounded by `CAIRN_SIGNAL_HOOK_TIMEOUT_MS` (default 10s) and all of them together by three times that: a window of their own, so suite `after` hooks that used up theirs never cost `finally` its run.\n- **Critical teardown**: a `services.teardown` entry may be `{ run, critical: true, timeout, onSignal: wait }`. A critical entry that exits non-zero or times out fails the run with **exit 8**, which outranks every verdict: precedence is 8, then 9, then the run's own code, so a billable resource that did not stop is never hidden behind a red or green test. `timeout` bounds any entry of a `cairn run` (the process group is killed); `cairn services down` runs every entry as a plain command. `onSignal: wait` makes the SIGINT/SIGTERM path wait for the entry up to its timeout (10 minutes when none) instead of the short `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` cap; a critical entry that fails or is still running after the wait is recorded in the journal (the process exits 130/143 as always).\n- **Exit codes**: 4 = a refusal before anything started (live lock, failed preflight, dirty machine before, specs from several configs); 8 = critical teardown failed; 9 = dirty state after the run. When a `run:` policy or a critical teardown applies, `cairn run` holds its `--json` / `--yaml` / md document until that verdict, so the document agrees with the process exit code: its `exitCode` is the invocation's, a spec that passed reads `status: errored` with `failure.phase: invocation`, and `invocationOutcome` (`exitCode`, `specsExitCode`, `error`, `runPolicy`) says why (`run.json` in the run directory keeps what the spec did). A SIGINT/SIGTERM that ends cairn before that verdict prints the documents of the iterations that finished, with `invocationOutcome.exitCode` 130 / 143 (their top-level `exitCode` stays the specs'). MCP `cairn_run` and `cairn_run_status` return the same document. The journal summary carries `runPolicy` (`lock`, `criticalTeardown`, `dirty`, `finallyFailed`), and the journal events are `run.lock.acquired|reclaimed|refused|released`, `preflight.started|passed|failed`, `cleanliness.clean|dirty`, `finally.started|finished`, `invocation.bailed`.\n\n**`cairn run --bail`** (MCP `bail`) stops scheduling the remaining specs after the first failed or errored one. They are reported as skipped, never as results: `BatchRunResult.skipped[]` (`{ spec, reason: \"bailed\", bailedBy }`) and `summary.skipped` (not part of `total`), plus the `invocation.bailed` event. Specs already running finish, teardown runs as usual, and the exit code is the first failure's. With `--repeat` / `--matrix`, later iterations do not start. A spec refused by the environment policy does not trip it. Unset, a suite's `bail` (or its `env.<name>.bail`) applies; `--no-bail` (MCP `bail: false`) runs every spec anyway.\n\n**Owned browser sessions.** Every browser session cairn starts is recorded in `~/.cairntrace/sessions-ledger/` (session name, backend, invocation, owner pid, browser pids) and removed when the browser closed cleanly. `cairn doctor --orphans [--kill] [--yes] [--json]` lists the sessions whose cairn process is gone but whose browser survives (`urn:cairntrace.dev:doctor-orphans:v1`; exit 0 none, 1 some). `--kill` ends them after a confirmation on a terminal; a structured or non-interactive run needs `--yes`. A learnt pid is recorded with its start time and command, and only a process that is still that one (and still looks like a browser cairn launches: the agent-browser daemon, Playwright's browsers, `--enable-automation`) is listed — and checked again right before it is signalled — so a recycled pid, the desktop Chrome or another tool's browser is safe; an entry whose owner has been gone for 7 days is dropped without being resolved. `--only <session|pid,...>` limits the listing and the kill to those sessions / pids (Studio passes exactly what its confirmation showed).",
      },
      {
        title: "Suites (cairn run --suite)",
        body: "A wrapper script usually keeps a table from a suite name to spec paths, then adds what differs per environment: commands to run before and after, vars, which seed steps to skip. The config `suites:` registry declares that table once and `cairn run --suite <name> [--env <env>]` (MCP `cairn_run {suite}`) runs it through the same engine as any run.\n\n```yaml\nsuites:\n  checkout:\n    description: Checkout flows\n    specs: [flows/checkout, flows/smoke/login.yml, payment-happy-path]\n    tags: [critical]          # AND on metadata.tags, case-insensitive\n    order: [login]            # these run first, in this order\n    parallel: 2\n    bail: true\n    requires: { env: [local, staging] }\n    vars: { region: eu }\n    env:\n      staging:\n        vars: { region: us }\n        before: [\"./tools/warm-cache.sh\"]\n        after: [\"./tools/collect-diagnostics.sh\"]\n        hookTimeoutMs: 120000\n        specs: [flows/checkout/smoke]     # replaces `specs` in staging\n    seed: { postCommands: { skip: [\"./tools/seed-extra.sh\"] } }\n    processEnv: { ENGINE_MODE: \"${env.ENGINE_MODE:-durable}\" }\n    labels: { cohort: \"${env.ENGINE_MODE:-durable}\" }\n```\n\n- **Selection.** `specs` entries are a glob (`*`, `?`, `**`), an existing path (file or directory, relative to the config; `dir/**` means everything below) or a spec `name`. Directories and globs skip drafts (a `_` folder or file below them); a draft named by path runs. `tags` keeps the specs that carry every tag; with no `specs`, it picks from every spec of the project. `order` runs the named specs first; the rest follow in resolved order (an `order` entry outside the selection is an error). Without `specs` and `tags`, `order` is the selection. An environment's `specs` replaces the base list there. Duplicates keep their first place.\n- **Settings.** `parallel` yields to `--parallel`; `bail` is added to by `--bail` and turned off by `--no-bail` (MCP `bail: false`), and `env.<name>.bail` replaces it in one environment; suite and environment `vars` sit under `--var` (in the specs and in the hooks' `CAIRN_SUITE_VAR_<NAME>` alike) and resolve once the vault's secrets are in (a suite var whose `${env.X}` is still unset is not passed; `requires.vars` is checked then; two vars that reach hooks as one `CAIRN_SUITE_VAR_<NAME>` are a `cairn config validate` error); `--tag` narrows further; every run is labelled `suite=<name>` (`cairn stats --group-by suite`). `requires.env` and `requires.vars` refuse the suite (exit 7) before anything starts. `seed.postCommands.skip` removes seed post-commands by exact command text (or by name, when a post-command has one) from this run's services plan; an entry that matches nothing is a warning; `env.<name>.seed.postCommands.skip` adds an environment's own skips (checked by `cairn config validate` against that environment's post-commands).\n- **Process env and labels.** `processEnv: { NAME: value }` (and `env.<name>.processEnv`, merged over it by name) is exported to every process of the run — `run.preflight` commands, the services phases (provisioner, tunnels, docker, seed), suite hooks, specs, their commands and verifiers — and `${env.NAME}` in the config and specs resolves to it. Values resolve after the vault (`${env.X}`, `${vars.X}`); an entry whose `${env.X}` is unset is not exported (a warning says so). `PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `TVAULT_*` and the variables cairn sets itself (`CAIRN_SUITE`, `CAIRN_SUITE_VAR_*`, `CAIRN_EXIT_CODE`, `CAIRN_RUN_LOCK`, …) are refused; only names reach the log. `labels: { key: value }` (and `env.<name>.labels`) are stamped on every run before `suite=<name>` and the caller's `--label` (later wins); `cairn stats --group-by <key>` cohorts them and `cairn stats --invocation <id>` keeps one invocation's runs.\n- **Hooks.** `before` commands run once, after services and the webServer are up and before the first spec; a failure or timeout stops the run (exit 2). `after` commands run once after the last spec, on every exit path once the before phase began (a cancel included, and a SIGINT/SIGTERM — then synchronously, each bounded by `CAIRN_SIGNAL_HOOK_TIMEOUT_MS`), while services are still up, with `CAIRN_EXIT_CODE` (the specs' verdict: 8 / 9 settle after the teardown that follows these hooks; 130 / 143 on a signal); they are non-fatal. Both run in the config directory, each bounded by `hookTimeoutMs` (default `--hook-timeout-ms`) with the process group killed at the deadline, and see `CAIRN_SUITE`, `CAIRN_SUITE_VAR_<NAME>`, `CAIRN_INVOCATION_DIR`, `CAIRN_ENV`, `CAIRN_BASE_URL` and `CAIRN_CONFIG_DIR`. A suite's hooks are lists of suite-level commands followed by the environment's. They are separate from `--before` (per iteration) and `--after` (per spec), which still work next to a suite.\n- **Journal.** `invocation.json` carries `suite`; events are `suite.started`, `suite.hook.started|finished` (with a live log `logs/hook-suite-<phase>-NN.log`) and `suite.finished` (`hooksFailed`).\n- **Inspect.** `cairn suites list [--env] --json` (`urn:cairntrace.dev:suites:v1`) and `cairn catalog --kind suites` show the specs each suite resolves to per environment, and why one does not. `cairn config validate` reports a suite that resolves to nothing. `suites:` merges through `include:` like `fixtures:`.\n- **Exit codes.** 2: `--suite` next to spec paths, or a failed before hook; 4: unknown suite or an unresolvable reference; 7: `requires` refused it; otherwise the run's own code (8 and 9 as for any run).",
      },
      {
        title: "Metrics Probes (diagnostics/metrics.json)",
        body: 'Numbers a collector script used to write by hand can be declared as `metrics:` probes. The engine samples them around each spec (`scope: spec`, the default) or around each iteration\'s specs (`scope: invocation`) and writes the result next to the run.\n\n```yaml\nmetrics:\n  - name: queue_depth\n    command: ./tools/queue-depth.sh\n    parse: { json: $.depth }            # or { regex: "depth=(\\\\d+)", unit: msgs }\n    sample: [before, after]             # default; or every: 5s\n  - name: indexed_docs\n    scope: invocation\n    http:\n      url: ${vars.searchUrl}/_stats\n      auth: { bearer: "${secrets.SEARCH_TOKEN}" }\n      json: { path: "$.indices[*].docs.count", reduce: sum }\n    timeout: 5s\n```\n\n- **Sources.** `command` runs a shell command in the config directory with the run\'s scoped environment (plus `CAIRN_ENV`, `CAIRN_RUN_TOKEN`, and `CAIRN_RUN_ID` / `CAIRN_RUN_DIR` for the after sample) and reads one number from stdout with `parse`: `{ json: <path>, reduce? }` or `{ regex, group?, unit? }`. `http` GETs a URL (`headers`, `auth: { bearer | basic }`) and reads `json: { path, reduce? }`. A path that selects several values needs `reduce: sum | max | min | count`. In an `http` probe `${secrets.X}`, `${env.X}` and `${vars.X}` resolve at every sample; an unset one fails that sample. A `command` is not expanded: the shell sees `${vars.X}` literally (`cairn config validate` warns).\n- **When.** `sample` lists `before` and/or `after` (default both). `every: <duration>` (at least 250ms) also samples while the scope runs, plus once at each end; the ticks stop when the scope ends (the timer is cleared and an in-flight probe is killed).\n- **Bounded and soft.** Every sample is limited by `timeout` (default 10s, at most 5m); the process group is killed at the deadline. A failure (non-zero exit, no match, HTTP error, unset secret) is recorded with a short redacted reason, warned once per metric and journaled, and never changes the verdict.\n- **Where it lands.** `<runDir>/diagnostics/metrics.json` (`urn:cairntrace.dev:metrics:v1`: `before`, `after`, `delta`, `series` stats for `every`, `failures`, `error`), and the flat numerics `<name>.before`, `<name>.after`, `<name>.delta` (and `.min`, `.max`, `.mean`) merged into `diagnostics/report.json` after the `--after` hooks, keeping whatever a collector wrote. `cairn stats --metric queue_depth.delta --group-by path` then works like any report metric (`cairn stats` reads non-negative numbers; a negative delta stays in metrics.json). Invocation-scope rows also go to `<journalDir>/metrics.json` and to every run of the iteration, stamped with the `--repeat` / `--matrix` iteration. The journal records `metric.sampled` events for the before and after samples.\n- **Secrets.** Resolved secret values, auth tokens and header values are scrubbed from errors and artifacts; an `${env.X}` / `${secrets.X}` / `${vars.X}` in an `http` block stays a placeholder until the sample, so evidence names an HTTP source by its config template (origin + path, without the query), never a resolved value.\n- **Environments.** `environments.<name>.metrics` merges over the top-level list by metric name.',
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
        body: "Run `cairn services status [--config <path>] [--env <name>]` to check the current state of the services environment without starting anything. Reports: docker (running/stopped), seed (last run, TTL expiry, freshness), tmux (session exists, window pane tails), the resolved `env` (its effective services, per-environment overrides applied) and the `cairn services up` owner `lock` of the config (`state: absent|held|unreadable`, owner, `env`, `ageSeconds`; a lock held for this env also gets `stale: true` plus `problems` when the services it owns are not actually up, and `unchecked` for a phase it could not see). Supports `--format json|yaml|md`. Also available as the `cairn_services_status` MCP tool (`config`, `env`) — agents can query the environment before deciding to run specs.",
      },
      {
        title: "Keeping Services Up (services up / down)",
        body: 'For exploration (discovery, accompany, manual checks) the stack has to stay up between runs. `cairn services up [--config <path>] [--env <name>]` starts docker → seed → tmux through the same code path as `cairn run`, leaves them running, and writes the owner lock of the config — one per config file, `~/.cairntrace/services/<config dir>.<hash>.lock.json` (`{version: 1, owner: "services-up", project, env, configPath, startedAt, pid, by: "cli"|"mcp"}`, written atomically; `pid` is informational — the command exits after the boot). Running it again for the same env re-runs the boot under the normal reuse rules (heals missing/idle windows) and refreshes the lock (`replacedLock`); for another env of the config it is exit 4, because environments inherit the compose project and tmux session of the config. While the lock exists, `cairn run` for that environment refuses before any hook, service, webServer or browser starts (exit 4) — it would otherwise start and tear down a stack it does not own — unless it passes `--reuse-services` (MCP `reuseServices: true`): one quick readiness look (docker `readinessCheck`, else `docker compose ps` with the `-f`/`-p`/`--project-directory` options and env of the Compose command — a command it cannot read is trusted and reported as unchecked; the tmux session and each window must exist, a pane that died or fell back to an idle shell fails, `readyOn.url` must answer), then the run starts nothing and tears nothing down (events `services.docker.reuse`, `services.seed.skip`, `services.tmux.reuse`; never `start` or `teardown`) and uses a cold browser. A stale lock (the services it owns are not up) fails with exit 4 and names what is down, with or without `--reuse-services`; `--reuse-services` without a lock and an unreadable lock file are exit 4 too. Runs of other environments of the config refuse (exit 4) while the lock is held; `--no-services` and environments with `services: false` never look at the lock. `cairn services down [--config] [--env]` is the full teardown: the configured `teardown` commands in order (no reuse skipping, so `docker compose down` runs when the config lists it; a docker phase no teardown command stops gets a warning), then `tmux kill-session` if the session is still alive, then the lock is removed — it also stops a stack a run left alive for reuse (no lock needed), and refuses (exit 4, nothing torn down) while the lock is held for another env. A failing teardown command is reported (exit 2) and the lock is still removed. `--services-dry-run` prints the lock line (would reuse / would refuse; liveness is not checked there) instead of refusing. Under a config `run: { lock }` (any scope the config declares), `services up` / `down` / `restart` refuse with exit 4 while a live `cairn run` of the config holds it (that run owns the stack and tears it down itself: no provisioner `down`, no tunnel stopped; `runLock` in the result names the owner), hold the lock for their own duration otherwise (`runLock.state: held`, the file\'s `command` names them, so a run started meanwhile refuses), reclaim a dead owner\'s lock like a run, and run under the owner\'s lock when the owner started them (`CAIRN_RUN_LOCK`, which a run exports to its processes: `nested`). There is no `--force`: stop the run instead. MCP: `cairn_services_up` / `cairn_services_down` (`config`, `env`) wait for a `cairn_run` of the same server holding that config. Results: `urn:cairntrace.dev:services-up:v1` (`phases`, `lock`, redacted `events`) and `urn:cairntrace.dev:services-down:v1` (`teardown[]`, `tmuxKilled`, `removedLock`). Exit codes: 0 ok; 4 no config found by discovery, unknown `--env`, no services for the env (up), or the lock held for another env; 2 boot failure (nothing locked; failure cleanup applies), failed teardown command, or a `--config` that does not exist or cannot be read.',
      },
      {
        title: "Dry-Run Mode",
        body: "Pass `--services-dry-run` to `cairn run` to preview the services lifecycle plan without executing anything. It prints the plan of the environment's effective `services:` block to stderr (redacted) — the environment, the suite and the names of its `processEnv`, the provisioner's `up` / `down` (and whether `down` is critical) and its export names, each tunnel with its `ready` gate, docker, each `files` entry, the seed with how many post-commands run, which ones the suite's `seed.postCommands.skip` removes and which ones a `when` leaves out, tmux, the teardown count (and how many entries are critical), a `secrets:` line with the NAMES a real run would inject from tvault (the vault is never called in a dry run: no `tvault` process starts, no value is read) and the `services up` lock line — then exits successfully before starting a web server, hooks, browser, preconditions, or the spec (the document's `plan` holds the same lines). An environment without services prints a line saying so. Use this to verify your `services:` block (and a suite's skips) before a real run: `cairn run --suite <name> --env <env> --services-dry-run`.",
      },
      {
        title: "Per-Environment Services",
        body: "The `services` and `secrets` blocks can be overridden per-environment inside `environments.<name>`. This lets you run the full local stack (docker + seed + tmux) for `local`, but skip all services for `dev` or `test` where the app is already deployed remotely:\n\n```yaml\nversion: 1\nservices:\n  docker:\n    command: docker compose up -d\n  seed:\n    command: bun run seed\n    ttlSeconds: 21600\n  tmux:\n    session: myapp\n    windows:\n      - name: web\n        command: bun run dev\n\nenvironments:\n  local:\n    baseUrl: http://localhost:8080\n  dev:\n    baseUrl: https://dev.example.com\n    services: false   # no docker/seed/tmux — app is remote\n  test:\n    baseUrl: https://test.example.com\n    services: false\n    secrets:\n      provider: tvault\n      tvault:\n        project: test-project  # different secrets for test env\n  remote:\n    baseUrl: https://remote.example.com\n    services:\n      tmux: false   # keep docker/seed, drop inherited local tmux windows\n```\n\nWhen `services: false`, `cairn run --env dev` skips the entire services lifecycle (no docker, no seed, no tmux) — no need for `--no-services` or `--services-dry-run`. When a partial `services:` block is given, it deep-merges over the top-level one (e.g. override just the seed command, keep docker and tmux). Inside a partial `services:` block, `tmux: false` drops only the inherited local tmux windows while keeping the docker and seed phases. A config without a top-level `services:` block may still give one environment its own (a provisioner only the paid environment owns): that block stands alone and only that environment boots services; `cairn config validate` lists the phases each environment boots (`environmentServices`) and refuses a provisioner left without `up` or `down`. The env-level `secrets:` block replaces the top-level one entirely.",
      },
      {
        title: "Lifecycle Events",
        body: "The services lifecycle emits structured events named `services.<phase>.<event>` — e.g. `services.docker.start|reuse|ready|fail|healthcheck|readiness-check`, `services.seed.start|skip|complete|fail|freshness-check`, `services.tmux.start|session-created|recreate|reuse|create-window|skip|relaunch|ready-wait|ready|fail|healthcheck`, `services.provisioner.start|ready|exports|fail`, `services.tunnel.start|ready|exit|restart|giveup|stop|fail`, `services.files.write|unchanged|fail`, `services.restart.start|stop|ready|fail|giveup`, `services.seed.phase.start|skip|complete|fail`, `services.seed.postcommand.skip`, `services.seed.commit`, `services.teardown.complete|fail|failure-cleanup|signal`, `services.stash.complete` — with a timestamp and details (seed freshness verdict, window name, healthcheck result). They stream live into the invocation journal's `events.ndjson` (`_invocations/<id>/`) while services boot, and each run's `events.ndjson` keeps a copy. Docker and seed command output streams, redacted, into the journal's `logs/services-docker.log` / `logs/services-seed.log`, and each teardown command's output (normal, failure cleanup, SIGINT/SIGTERM) into `logs/services-teardown.log` (`cairn logs --invocation latest --log services`). On SIGINT/SIGTERM the teardown first waits up to `CAIRN_SERVICES_SIGNAL_GRACE_MS` (default 5000) for a boot command still running to exit (no extra signal, so a provisioner's graceful cancel is not forced), and each remaining teardown command is capped at `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (default 10000). Teardown commands run detached (own process group and session, no terminal), so the Ctrl-C that stops cairn does not kill a provisioner's `down` halfway; the signal path waits up to the same cap for one already running and never starts a second copy while it is alive, and runs it again when it is gone. `services.teardown.signal` events record each step. Every event validates against the `events.v1` schema.",
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
        title: "readiness gates (cairntrace.config.yml)",
        language: "yaml",
        code: [
          "version: 1",
          "environments:",
          "  local: {}",
          "gates:",
          "  mongo:",
          "    tcp: localhost:27017",
          "  search:",
          "    http:",
          "      url: http://localhost:9200/_cluster/health",
          "      json: { status: { in: [yellow, green] } }",
          "  web:",
          "    all:",
          "      - http: http://localhost:8080/",
          "      - http: { url: http://localhost:8080/api/session, status: [200, 401, 403] }",
          "    stable: 2",
          "    every: 2s",
          "    timeout: 5m",
          "services:",
          "  docker:",
          "    command: docker compose up -d",
          "    ready: [mongo, search]",
          "  tmux:",
          "    session: sample-app",
          "    windows:",
          "      - name: worker",
          "        command: yarn worker",
          "        after: [mongo]",
          "        readyOn: { text: listening }",
          "      - name: web",
          "        command: yarn serve",
          "        readyOn: { gate: web }",
        ].join("\n"),
      },
      {
        title: "wait for gates by hand",
        language: "bash",
        code: [
          "cairn wait mongo search --json                       # config gates, in order",
          "cairn wait http://localhost:8080/health --timeout 2m --stable 2",
          "cairn wait http://localhost:9200/ --status 2xx,401",
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
        title: "keep services up while exploring, then validate cold",
        language: "bash",
        code: [
          "cairn services up --env local --json            # boot once, write the owner lock",
          "cairn discover /login --env local                # explore against the warm stack",
          "cairn run flows/new.yml --env local --reuse-services --json   # no start, no teardown, cold browser",
          "cairn services down --env local                  # full teardown + remove the lock",
        ].join("\n"),
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
      "Interactive page exploration through the harness. An agent opens a session (optionally after a setup: imported actions, a spec's first steps, or a checkpoint), interacts, and exports the recorded steps as a spec YAML. Every step runs through the same engine as `cairn run`, and every session is journaled to <artifactRoot>/_sessions/<id>/ so Studio can follow it and it survives the browser.",
    sections: [
      {
        title: "Overview",
        body: [
          "Discovery sessions let an agent explore a live page through cairntrace's own browser backend, recording each interaction as a spec-compatible step, then export the session as a valid spec YAML. This replaces the blind authoring workflow (write → run → fail → heal) with explore → record → export.",
          "",
          "The MCP tools are the primary interface: cairn_discover_open, _snapshot, _interact, _navigate, _network, _inventory, _suggest, _remove_step, _export, _close, _resume, _list. The CLI `cairn discover [url]` is a one-shot snapshot (with the same setup flags) that also leaves a journal; `cairn discover export --from-session` and `cairn discover sessions` work on journals.",
          "",
          "Every step a session runs — setup, the first open, each interaction, a resume replay — goes through runSpec: config, environment, `${vars.X}`, `${secrets.X}` from the configured provider (never literals), imports and `use:` expansion, and the interaction resilience layer. Discovery sees what `cairn run` will see.",
        ].join("\n"),
      },
      {
        title: "Workflow",
        body: [
          "1. cairn_discover_open(url?, setup?, imports?, resume?, env?, config?, var?, backend?, ttlMs?, snapshotMode?, maxBytes?, mock?) — setup, then the url; returns the first snapshot + inventory, the journal dir and the setup outcome",
          "2. cairn_discover_interact(sessionId, action, …) — click | fill | hover | type | select | upload | scroll | press (+target) | focus | eval { js|file, args, assign } | wait { … } | request { … } | assert { text|notText|url|value|selector } (recorded as a wait step); or step: <any spec step>. Returns the post-action snapshot, network.mutations, a journal screenshot, and eval/request values in result",
          "3. cairn_discover_navigate(sessionId, url) — records an open step; a relative url joins the config baseUrl and is recorded relative",
          "4. cairn_discover_snapshot / cairn_discover_inventory — the page now / its locators (inventory scans browser.testIdAttribute)",
          "5. cairn_discover_network(sessionId, sinceAction?, method?, urlContains?) — requests seen (redacted; no headers, bodies or query strings), including ones that completed after an action returned",
          "6. cairn_discover_suggest(sessionId) — the exportable steps with their action indexes; cairn_discover_remove_step(sessionId, index) undoes one",
          "7. cairn_discover_export(sessionId, path, intent, outcomes, resume?, overwrite?, close?) — writes the spec: setup as imports + use: (or the source spec's steps), then the recorded steps; parsed with the session's config/env/vars; cold-start and contractHash gaps come back as warnings",
          "8. cairn_discover_close(sessionId) — frees the browser; the journal stays",
          "",
          "Failed actions are journaled but not recorded. cairn_discover_list lists open sessions (all: true adds journaled ones).",
        ].join("\n"),
      },
      {
        title: "Setup before exploring",
        body: [
          "setup: [{ use: login_as_admin, vars: { … } }, …] runs imported reusable actions. The action files come from `imports` (paths relative to the cwd), else config authoring.template.imports, else any actions/ directory under the config dir. setup: { fromSpec: flows/x.yml, untilStep: open_profile } replays that spec's steps through a step id (or 1-based position), with its imports, vars and requires; its preconditions are not run (a warning says so). resume: <checkpoint> restores a scoped checkpoint first, exactly like a run's session.resume (wrong origin or expired → the open fails).",
          "",
          "A failed setup fails the open; the setup run stays in the journal (setup/<runId>/) for diagnosis. An environment policy that refuses a fromSpec spec refuses the open (exit 7 on the CLI).",
          "",
          "Export writes the setup as it was given — imports (relative to the written spec) + `use:` steps, or the source spec's own steps — never the expanded action steps, plus session: { resume } when a checkpoint was used.",
        ].join("\n"),
      },
      {
        title: "Context economy",
        body: "snapshotMode on open/interact/navigate/snapshot: diff (default) returns only elements added or changed since the previous snapshot — each element carries a stable `key` (role + name + ancestor chain + position among identical siblings; agent-browser refs renumber every snapshot) and snapshotInfo lists removed ones; compact returns elements with a ref or a name; full returns all; none returns nothing. maxBytes (default 16384) caps the returned JSON (snapshotInfo.truncated). The mode/budget given to cairn_discover_open become the session's defaults; later calls may override them. The full snapshot text is always written to the journal (snapshotInfo.path).",
      },
      {
        title: "Session journal",
        body: [
          "<artifactRoot>/_sessions/<sessionId>/ — session.json (atomic: kind, origin, client, startUrl as requested, backend, env, configPath, status open|expired|closed|exported, ttlMs, setup, imports, exportedTo, …), events.ndjson (session.opened, action.performed {index, action, locator, ok, error, urlBefore, urlAfter, durationMs, screenshot, snapshot, network.mutations}, step.recorded, step.removed, snapshot.captured, draft.updated, export.written, screenshots.disabled {index, reason} — after the first screenshot timeout (45s limit) the session takes no more and that action's result carries `warnings`, session.closed), screenshots/NNN.png, snapshots/NNN.txt, network/NNN.json (redacted), draft.spec.yml (regenerated after every recorded step; secrets as placeholders).",
          "",
          "The browser closes after ttlMs idle (default 30 min; config discovery.sessionTtlMs; open input ttlMs); the journal stays with status expired. cairn_discover_export, _suggest and _network work from the journal alone, and cairn_discover_resume re-opens a browser, restores the checkpoint, runs the setup and replays every recorded step to reach the same state, continuing the same journal. Retention keeps the newest 50 journals plus open ones and any an existing exported draft still names.",
        ].join("\n"),
      },
      {
        title: "Convention export",
        body: [
          "cairn_discover_export (and `cairn discover export`) applies the project's conventions when given `into` (a folder or .yml file relative to the config dir), `conventions: true`, or no `path`: the spec lands in the drafts dir (config authoring.draftsDir, default flows/_drafts; `cairn run <dir>` skips `_` folders and files) and refuses an existing file unless overwrite.",
          "",
          "reuseActions (default true): runs of recorded steps an existing action performs (catalog actions; authoring.template.imports first) become `use: { action, vars }` — action steps are templates whose ${vars.X} bind to the recorded literals; names compare case-insensitively unless the action says exact; one-step actions and matches below confidence 0.8 are reported, not applied. The setup's `use:` steps are reported too. liftVars (default true): a literal equal to one config var of the session env becomes `${vars.name}` (ambiguous values are kept and reported). Known secret values are always written as their placeholders; a literal typed into a password-type field (or passed as a credential var) that no known secret explains refuses the export unless refuseSecrets: false. Absolute URLs under the env baseUrl become relative; `open:` gets `waitUntil: networkidle`; a click/press/select that changed the page gets a `wait: { url: { includes } }`; a mutation the session observed (PATCH/POST/PUT/DELETE, status < 400) during a click/fill/press/select/upload becomes `postcondition.network`; every step gets a unique snake_case id; authoring.template requires / metadata.tags apply (explicit requires/tags win or merge).",
          "",
          "The result's `report` lists liftedVars, reusedActions (source setup|recorded, steps, vars, confidence, applied), secretsPlaceholdered and warnings; `nextActions` says to run cairn_spec_finish, then (drafts) cairn_spec_promote after the human approves. See `cairn docs author-flow`.",
        ].join("\n"),
      },
      {
        title: "Project Config & secrets",
        body: [
          "cairn_discover_open reads the same cairntrace.config.yml a run would (discovered upward from the server's cwd, or `config`): the environment supplies the baseUrl, `var` / config vars fill `${vars.X}`, and the `browser:` block tunes the backend (browser.testIdAttribute is what the inventory scans). backend defaults to config discovery.backend, else agent-browser. An `env` the config does not define is an error; a relative URL with no baseUrl is an error on a real browser (mock sessions keep the bare path).",
          "",
          "The browser opens the resolved URL, but the session RECORDS it as requested — `${secrets.X}`, `${env.X}`, `${vars.X}` and relative paths stay as written. A fill/type value (or any step string) equal to a known secret — a provider key, a config secrets.required/keys name, or a secret-looking environment variable — is recorded as its `${secrets.NAME}` / `${env.NAME}` placeholder, never the value. Relative upload/eval files are recorded as `${config.dir}/…`. Returned URLs, errors, snapshots and journal files are redacted.",
        ].join("\n"),
      },
      {
        title: "CLI",
        body: [
          "cairn discover [url] [--use <action>[:k=v,…]]… [--import <file>]… [--from-spec <path> --until-step <id>] [--resume <checkpoint>] [--snapshot-mode none|diff|compact|full] [--max-bytes n] [--roles] [--testids] [--wait-until …] [--env] [--config] [--var k=v] [--backend] [--mock] [--format json|yaml|md] — one-shot: setup, open, full snapshot (default for the CLI) + inventory; reports sessionId + journal.",
          "cairn discover export --from-session <dir|id> (--path <spec> | --into <dir|file> [--name <name>] | --conventions) [--intent <text>] [--outcomes <file.yml|json>] (both default to the session's last export, reported in warnings) [--no-reuse-actions] [--no-lift-vars] [--allow-secret-literals] [--requires-env a,b] [--mutates] [--tag t]… [--resume] [--overwrite] [--format] — exit 0 written + parsed, 4 refused (existing file, secret literal, invalid) or verify failed, 2 error.",
          "cairn discover sessions [--limit n] [--format] — journals, newest first.",
        ].join("\n"),
      },
    ],
    examples: [
      {
        title: "MCP discovery workflow (authenticated flow, setup + network)",
        language: "yaml",
        code: [
          "# 1. Open after logging in through the project's own action",
          'cairn_discover_open(url="/profile", env="local",',
          '  setup=[{ use: "login_as_supplier" }], snapshotMode="diff")',
          '# → { sessionId: "abc-123", journal: ".../_sessions/abc-123", setup: { ok: true, steps: 4 }, snapshot: [...] }',
          "",
          "# 2. Edit and save; the result shows the mutation",
          'cairn_discover_interact(sessionId="abc-123", action="fill",',
          '  target={ by: "label", name: "Website" }, value="https://example.test")',
          'cairn_discover_interact(sessionId="abc-123", action="click",',
          '  target={ by: "role", role: "button", name: "Save" })',
          '# → network: { mutations: [{ method: "PATCH", path: "/api/answers/42", status: 204 }] }',
          "",
          "# 3. Assert what the user sees (recorded as a wait step)",
          'cairn_discover_interact(sessionId="abc-123", action="assert", assert={ text: "Saved" })',
          "",
          "# 4. Export: imports + use: login_as_supplier, then the recorded steps",
          'cairn_discover_export(sessionId="abc-123", path="flows/_drafts/profile_website.yml",',
          '  intent="A supplier updates the profile website and it persists",',
          '  outcomes=[{ id: "website_saved", description: "Saved confirmation",',
          '    verify: { text: { contains: "Saved" } } }], close=true)',
        ].join("\n"),
      },
      {
        title: "Export a session after its browser expired (CLI)",
        language: "bash",
        code: [
          "cairn discover sessions --json",
          "cairn discover export --from-session abc-123 --path flows/_drafts/profile_website.yml \\",
          "  --intent 'A supplier updates the profile website' --outcomes outcomes.yml --json",
        ].join("\n"),
      },
    ],
    relatedTopics: ["mcp", "authoring", "steps", "overview", "export", "brief"],
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
        body: "`cairn export playwright <spec|dir> [--lang js|ts] [--out <file>] [--out-dir <dir>] [--project] [--into <dir>] [--preconditions inline|global|skip|manifest] [--verifiers keep|gate|drop] [--gate-env <names>] [--host-config <playwright.config.ts>] [--map <export.map.yml>] [--target <name>] [--max-eval-ratio <0..1>] [--allow-eval-without-bypass] [--config <path>] [--env <name>] [--var key=value] [--stdout] [--format json|yaml|md]`, or `cairn export playwright [spec|dir] --check <exportDir>` to verify an existing export (see Export manifest). Default language is TypeScript (`.spec.ts`). `--lang js` emits `.spec.js` without type annotations. Directory input requires `--out-dir` and expands recursively (skips `actions/` and drafts: folders and files starting with `_`). `--stdout` prints source only for a single spec (no coverage report) so you can pipe into a file. A generated file that would still carry an internal `__CAIRN_…__` placeholder is refused (exit 2) with the file, line, spec, and step named.",
      },
      {
        title: "Config-aware export (--config/--env/--var)",
        body: "`--config`, `--env`, and repeatable `--var key=value` resolve `cairntrace.config.yml` vars and `baseUrl` exactly like `cairn spec verify` — auto-discovered from the spec's directory when `--config` is omitted. This means specs using `${vars.*}` are exportable; the resolved values are inlined as literals (they are not secrets). `--project` mode also uses the resolved `baseUrl` to fill in `playwright.config.ts`. Environment variables are the exception: an `${env.X}` / `${env.X:-default}` / `${secrets.X}` is never resolved at export time — in a spec, a spec's own `vars:` AND the config file (loaded late-bound: config vars, `baseUrl` — `baseURL: (process.env.APP_URL || \"…\")` in a project —, the `auth:` of `use: login`, also behind a map `apiLogin`, and datasources all read process.env when the test runs, so `--check` does not churn with the environment). A typed config field the export emits (a viewport width, an `expectStatus`) cannot hold one: the export refuses it naming the field (exit 4 for a single file) instead of baking the value; fields it does not emit (`webServer.url`, services) never block it. See Secrets and the run token.",
      },
      {
        title: "Secrets and the run token are never inlined",
        body: '`${secrets.X}` and `${env.X}` (set or not while exporting) never appear as literal values in generated source — they emit as `process.env.X ?? ""` template references, and the file\'s header comment lists every required env var so a reviewer/CI knows what to set. `${env.X:-default}` emits `(process.env.X || "default")` — read, and falling back, when the test runs; an unset OR empty variable falls back, exactly like `cairn run` — and is listed as optional env, not required; the default may itself hold `${run.token}` or other late-bound parts. `${run.token}` emits a per-invocation `const RUN_TOKEN = process.env.CAIRN_RUN_TOKEN ?? Math.random()...` so re-running the exported test still produces unique values instead of colliding on stale data. A reusable action\'s `${vars.X}` becomes a function parameter. Text needles (`wait.text`/`notText`, `when: text:`/`notText:`) with a late-bound part are normalized at run time (never lowercased into the source), `when:` text predicates pass the needle to `page.evaluate` as an argument, and `eval.js` is assembled in Node with the run token/secrets spliced in before it reaches the page.',
      },
      {
        title: "Runtime splices (${requests|evals|artifacts.…})",
        body: "`request` / `eval` / `download` steps (and network postconditions) with `assign:` bind their captured value when a later step or outcome splices it; the reference becomes `cairnSplice(binding, path)`, rendered the way the runner renders it (objects as JSON, missing as \"\"). Splices are exported only where `cairn run` performs them: step fields, script verifier `fixtures`, and `httpJson.url` (requests/artifacts). Every other outcome field (text/url/count/network needles, httpJson matchers) is compared by the runner against the raw `${…}` text, so the export keeps it literal too and reports a `literalSplice` risk. The runner's default names are honored (`request_<step number>`, slugged download `saveAs`). Downloads land in Playwright's per-test `cairn-run/downloads/`. In `--project`, action functions return `{ requests, evals, artifacts }` and callers merge what they splice. A splice that cannot be bound becomes a throwing `cairnUnresolvedSplice(...)`, a hard skip (`test.fixme`), and an `unresolvedSplice` risk — a splice the runner performs is never emitted as a raw `${…}` placeholder. Request-step responses also feed the test's network evidence so `network`/`noFailedRequests` outcomes see them.",
      },
      {
        title: "External verifier files export",
        body: "A `script.runtime: node` verifier backed by `script.file` is exported by dynamically importing the verifier module and calling `verify(ctx)`. A browser-context `script.file` is read during export and embedded into `page.evaluate`; TypeScript files are transpiled with Bun before emission. Browser fixtures are passed as page data so late-bound env/run-token values are evaluated in Node rather than referenced as unavailable browser globals. Inline `runtime: node` scripts (no `file:`) remain non-exportable.",
      },
      {
        title: "Locator and evaluate semantics",
        body: 'Semantic locators (role/label/text) emit `.first()` unless an explicit `nth` is set, matching agent-browser\'s first-match behavior against Playwright\'s default strict mode (which throws on ambiguous matches). Authored eval bodies remain JavaScript data executed in the browser, so strict generated-project typechecking validates the Playwright/DOM boundary without treating untyped page snippets as TypeScript. Evals containing `location.reload()` emit a try/catch retry: Playwright destroys the evaluate execution context on navigation, so a caught "Execution context was destroyed" error triggers `waitForLoadState("networkidle")` followed by a re-run of the same eval, preserving the reload-as-rescue pattern\'s source semantics.',
      },
      {
        title:
          "Host commands: --preconditions (inline | global | skip | manifest)",
        body: "`--preconditions` decides how everything that runs outside the browser is exported: spec preconditions, `run:` steps, the spec `teardown:`, config fixtures and readiness gates. `inline`: a bounded helper written into the generated runtime (inlined in a standalone file, `preconditions.ts` in a project) — each file's `beforeAll` runs its preconditions, `run:` steps run in the test body (`assign` → `${runs.<name>…}` splices through the helper's captured stdout, last line JSON like cairn), and the spec `teardown:` runs in a `finally` after the outcomes on every exit path with CAIRN_RUN_STATUS (passed|failed), each item isolated, a failed item reported (a `teardown-failed` annotation) but never failing the test unless `failRun: true`, the whole teardown bounded by its `timeoutMs`. A command that needs no shell (plain words and quotes) is spawned as an argument vector — `${env.X}` values can never be re-split or re-interpreted — anything else runs through `/bin/sh -c` like cairn; command text comes from the spec while `${env.X}` / `${secrets.X}` stay `process.env` reads at run time, and errors carry the output tail, never the command. `global` (`--project` / `--into` only): `global-setup` runs ONCE before the suite, in cairn's order — readiness gates (`cairn wait <gate>`), the specs' preconditions, then the config fixtures (`cairn fixtures ensure <name> --json`, with the spec's `with:`); fixture outputs go to a private temp file named by CAIRN_FIXTURES_FILE which tests read (`${fixtures.<name>.<key>}` becomes a splice; secret outputs are never in it) and run-scoped fixtures are torn down when the suite ends. Gates and fixtures need the cairn CLI (`CAIRN_BIN`, default `cairn`) and the source project (`CAIRN_PROJECT_ROOT`); the commands run once for the whole suite, not before each spec (a `globalPreconditions` risk says so). `skip`: nothing runs (soft skip + `requiredSetup` risk). `manifest`: nothing runs; `.cairn-export.json` gains `preconditions: [{spec, name?, run, cwd, timeoutMs, envKeys?}]` — authored text with `${env.X}` placeholders (never values), `cwd` relative to `source.projectRoot` — for the host to run; `--check` flags a changed command as stale. `--stdout` and a single `--out` file need a manifest-writing mode (`--project`, `--into`, `--out-dir`) for `manifest`, and `global` needs `--project` / `--into` (exit 2 otherwise). Without the flag the behavior is unchanged: a standalone file lists preconditions (soft skip), `--project` / `--into` run them per file; `run:` steps, `teardown:`, fixtures and gates stay unexported (hard skip / soft skip with the reason).",
      },
      {
        title: "Node / datasource verifiers: --verifiers (keep | gate | drop)",
        body: "`keep` (default): node file verifiers run in the test's node context, `http` verifiers run (their datasource's env is read when the test runs; missing, the test fails with a clear message), `mongo` / `temporal` verifiers are a hard skip. `gate`: a node file verifier runs only when its required env is present — the env its `fixtures:` read (`${secrets.X}` / `${env.X}`) plus `--gate-env NAME[,NAME]`; a datasource verifier needs the env its config datasource references. Otherwise the test records it and ends with `test.skip(cairnSkipped.length > 0, …)` AFTER every other assertion held and after the teardown — reported skipped, never passed. A verifier that cannot run in an export at all (`mongo` / `temporal` datasources, inline node scripts) is always recorded as skipped instead of fixme-ing the whole test, with a `verifierGated` risk. A node verifier with no known env runs unconditionally (name its env with `--gate-env`). `drop`: the verifiers are omitted with a diagnostic and a `verifierDropped` risk — the test can pass without them. The 30-minute timeout floor applies only to a test that emits a node file verifier (never with `drop`).",
      },
      {
        title:
          "Data verifiers (value, http, network body/count, file, xlsx, expect.request, transform)",
        body: "These judge data, and export with the runner's OWN code, not a re-implementation: the matcher engine (equals/contains/matches/oneOf/atLeast/atMost/exists/empty/each/ignoreCase and JSONPath-style paths), the `${…}` resolver, the network / response / httpJson / file / xlsx judges and the HTTP wire rules are emitted from src/core/runner/verifiers/* and src/core/datasources/* (a project writes `lib/runtime/matchers`, `refs`, `networkJudge`, `responseJudge`, `httpWire`, `xlsxJudge`, … (a folder of their own) plus thin `lib/data*` glue; a single file inlines what it calls). A checked-in generated copy is rebuilt from the live modules by `runtimeSources.test.ts`, which fails on drift, and the equivalence tests run the generated JavaScript against the runner. References (`${requests|evals|captures|network|fixtures|runs|artifacts.…}`) in value / http / network.body.json / xlsx / expect.request resolve TYPED like the runner (a whole reference keeps its type; an unresolved one fails the check) against the bindings the exported steps produced; a reference with no producer in the export is a hard skip naming it, and `${run.startedAt}` has no export. `value` → `cairnAssertValue`. `http` → Playwright's APIRequestContext (no browser cookies; the runner's header, body, content-type, redirect, size and error rules; `assign` → `${captures.<assign>.status|body}`); a `source:` datasource (kind: http) is baked as baseUrl + header names with `${secrets.X}` / `${env.X}` as process.env reads at test time (never a value; missing → a clear failure, or reported skipped under `--verifiers gate`); an inline URL needs an absolute URL or Playwright's baseURL. `httpJson` keeps the cookie-carrying fetch; its matchers (equals/contains/matches/atLeast/atMost/exists) are the runner's. `network` with body / count / assign judges a richer in-memory request log (bodies, times; request steps included) and `assign` → `${network.<assign>…}`. `file` waits for the glob; `xlsx` reads the workbook with the SDK's reader (`lib/runtime/workbook.js`) and needs --project. `expect.request` → `page.request` (browser cookies; GET/HEAD retried for the step's timeoutMs). `transform` copies the node module next to the project and runs `transform(ctx)` in the test process (flagged `transformInProcess`).",
      },
      {
        title: "Primitives that export (capture, poll)",
        body: "`capture` (text / value / attribute / table) is page-derived and always exports: `cairnCapture` runs the same in-page probe cairn run uses (locators with late-bound parts travel as run-time data), retries every 250 ms for the step's `timeoutMs` (default 5000), applies the same single-target rule and table shaping, and binds `${captures.<assign>…}` for later steps (`lib/probe` in a project). A verifier `poll: { timeoutMs, everyMs }` exports as `expect(async () => {…}).toPass({ timeout, intervals: [everyMs] })`; with `stableMs` it exports as `cairnPoll` (green must hold for the window over at least two samples; a red sample restarts it — the runner's semantics, flagged `pollApproximated`; each sample checks once like the runner's: its assertions go through `expect.configure({ timeout: 1 })`, since a web-first assertion would wait a red sample out; `failFastOnStepFailure` cannot apply because an exported test stops at its first failed step). The `table` verifier exports through the same probe: `cairnReadTable` waits (every 250 ms, default 5000) for the rendered table and `cairnJudgeTable` applies the row-count / blank-row / header / required-row checks. Outcome-level `network.assign` stays a diagnostic skip: its only consumers (value / mongo / temporal / http verifiers) have no export. `value`, `http`, `xlsx` and `file` verifiers, `transform`, `expect.request` and `network` body/count matching remain hard skips.",
      },
      {
        title: "Preconditions",
        body: "Spec `preconditions.commands` run outside the browser (shell/mongo resets, pipeline gates). `--project` / `--into` run them in each test file's `beforeAll` (not in `global-setup`, which is a one-time suite hook that only logs), with their spec-relative `cwd`, own `timeoutMs`, authored `preconditions.env` over a filtered child env, and a process-tree kill at the deadline; `SKIP_PRECONDITIONS=1` skips them and documentary preconditions (a single `echo …` with no shell control or substitution outside single quotes) never run — `echo \"resetting\" && psql …` is executable. The `beforeAll` sets its own timeout from the precondition budgets. Single-file export does not run them: it lists them in a ⚠ header comment and reports `requiredSetup` (and `requiredInfra` for docker/mongosh/psql/tmux…) risks. Batch export (`--out-dir`) also writes a `README.md` documenting required env vars, config requirements (`bypassCSP: true`, `workers: 1`), and each spec's preconditions. A spec's `requires.env` becomes a run-time `test.skip(...)` on `process.env.CAIRN_ENV` (plus its opt-in variables), emitted before `beforeAll` so a skipped suite never runs its preconditions — the export-time environment is never baked in; set `CAIRN_ENV` when running the exported tests. `requires.mutates` and environment policies stay a comment (the exported suite does not read the cairntrace config).",
      },
      {
        title: "Timeouts",
        body: "Each test's timeout is derived from its sequential step/outcome budgets (30s per operation without an explicit limit, node verifier `script.timeoutMs` added in full) plus 10% headroom (at least 1m), under a 4h ceiling. A step with `postcondition.network` reserves the longer of its action budget and the postcondition `timeoutMs` (default 30s). The 30-minute floor applies only to tests that EMIT a durable node verifier (`--verifiers drop` or no node file verifier: no floor), and to a `beforeAll` whose preconditions are long (≥5 min) and actually run there (`skip` / `manifest` / `global`: none); a UI-only spec fails in minutes, not half an hour. An exported `run:` step adds its own timeout (default 120s), a capture its wait, an exported teardown its items (capped by its own `timeoutMs`), and a polled outcome its poll window. `--project` config sets `actionTimeout`/`navigationTimeout` to 30s so a stuck locator cannot consume the whole test budget.",
      },
      {
        title: "--project mode (structured project)",
        body: "`--project` (requires `--out-dir`) generates an installable Playwright project instead of standalone spec files: `package.json` (`@playwright/test`, TypeScript, and test/typecheck scripts), strict `tsconfig.json` with DOM/Node types and portable `.ts` imports, `playwright.config.ts` (baseURL from config, serial `workers: 1`, `bypassCSP: true`, `globalSetup` wired), `global-setup.ts`, `actions/<name>.ts` (each reusable action from `imports:` becomes one exported `async function(page, vars?)` that tests import and that returns its captured `assign:` values), `lib/` (only the helpers in use), `fixtures/` (copied upload files), `verifiers/` (node verifier files plus a bounded safe relative dependency closure), `tests/<spec>.spec.ts`, `.cairn-export.json`, and an executable `README.md`. Each file imports only what it uses (generated projects compile under `strict` + `noUnusedLocals`). Run `npm install`, `npx playwright install chromium`, `npm run typecheck`, then `npm test`.",
      },
      {
        title: "Relocatable exports (CAIRN_PROJECT_ROOT)",
        body: "Precondition `cwd` and node verifiers' `specDir` resolve through `lib/projectRoot` relative to the export root (computed on real paths at export time), never as a baked absolute path; `CAIRN_PROJECT_ROOT` overrides it after a move. When the resolved root or a precondition `cwd` does not exist, the hook fails fast and says to set `CAIRN_PROJECT_ROOT` (no confusing `spawn /bin/bash ENOENT`). The project root is the `cairntrace.config.yml` directory, or the export input directory without a config. Upload files are copied into `fixtures/` and read via `cairnFixturePath(name)` — only regular, non-symlink files inside the project root up to 10 MiB; anything else keeps its absolute path and reports an `absolutePath` risk saying why. MCP `project`/`into` exports take the same path (fixtures copied, manifest written).",
      },
      {
        title: "--project layout",
        body: "```\nexports/\n├── README.md\n├── .cairn-export.json     manifest (versions, digests, file hashes)\n├── package.json           install + test/typecheck scripts\n├── tsconfig.json          strict DOM/Node typing, explicit .ts imports\n├── playwright.config.ts   baseURL, workers: 1, bypassCSP, globalSetup, actionTimeout\n├── global-setup.ts        one-time suite hook (preconditions run in each file's beforeAll)\n├── preconditions.ts       filtered env + process-tree timeout runner\n├── lib/                   helpers in use (hydration, splice, fixtures, projectRoot, …)\n├── actions/\n│   └── login.ts           async function login(page, vars?) — from imports: login\n├── fixtures/\n│   └── invoice.pdf        copied upload file\n├── verifiers/\n│   ├── check-mongo.ts     copied node verifier\n│   └── support.ts         copied transitive relative helper\n└── tests/\n    ├── login.spec.ts\n    └── checkout.spec.ts\n```",
      },
      {
        title: "Export manifest and --check",
        body: "`--project`, `--into`, and batch `--out-dir` exports (CLI and MCP) write `.cairn-export.json` in the export root: `{version: 1, exporterVersion, generatedAt, mode, lang, source: {input, config?, env?, varKeys, varsDigest?, preconditions?, verifiers?, gateEnv?, hostConfig?, map?: {file, digest}, target?, maxEvalRatio?, allowEvalWithoutBypass?, strictLocators?, projectRoot?}, specs: [{spec, contractHash, testFile, sourceDigest}], files: [{path, sha256}], preconditions?: [{spec, name?, run, cwd, timeoutMs, envKeys?}]}` (paths relative to the export root; `--var` values are never recorded). `sourceDigest` hashes spec and imported-action CONTENT (actions by name, never absolute paths), so the manifest is the same in a fresh clone or after a move, and `generatedAt` is kept when a re-export changes nothing else. `cairn export playwright --check <exportDir>` regenerates the export in memory from the manifest's recorded input/config/env (a spec/dir argument, `--config` or `--env` override them), writes nothing, and reports `stale`, `missing`, `orphaned` and `modified` files plus a per-spec status (`fresh`/`changed`/`new`/`removed`; a comment-only YAML edit stays fresh). Pass the same `--var` values the export used. Exit 0 fresh, 1 stale, 2 error (no/unreadable manifest, regeneration failed) — a CI gate for committed exports.",
      },
      {
        title: "Verify an export (--verify)",
        body: "`cairn export playwright --verify <exportDir>` (MCP `cairn_export_verify`) proves an export faithful; a bare `--verify` verifies the export just written. Static gates, no browser, each `passed` | `failed` | `skipped` with a reason (a skipped gate is never a pass): `sentinels` (no `__CAIRN_*__` left in any exported file), `freshness` (the `--check` engine; skipped when the sources cannot be read), `typecheck` (the target's own `tsc`: a generated project's tsconfig plus `noUnusedLocals`, a host tsconfig as is — export files it does not include get a strict fallback and host errors are not the export's; skipped for `--lang js` and without a local `tsc`), `lint` (the host's eslint when an eslint config exists above the export; JSON errors fail, warnings do not; skipped without a config or binary), `list` (`playwright test --list` shows exactly one test per exported spec; `test.fixme` skips are counted and reported). Tools are the target's local binaries found by walking up from the export; nothing is installed. `--differential` (or `--verify=differential`) also runs, per spec and sequentially, `cairn run --backend playwright --no-web-server --no-services --run-token T` and the exported test with `CAIRN_RUN_TOKEN=T` against the app that is already running, then compares: step verdicts by id (an export step is its `test.step` title; ids that repeat, such as action steps, are not compared), outcome verdicts, the requests each network / noFailedRequests outcome matched (project exports record a `cairn:network` annotation: zero on one side only is a mismatch, a different count a warning) and the duration ratio (`--duration-ratio`, default 3). Both sides run, so a spec that mutates shared state must be idempotent or reset by preconditions / teardown; the export side runs what `--preconditions` exported (inline and the default per-file hook, `global` through the suite's global setup; `skip` and `manifest` run nothing there, so the cairn run's own preconditions are all that prepared the app). A baseline that did not pass makes the spec `inconclusive` when the export agrees with it (both failed), never a match; a disagreement is a `mismatch`. `test.fixme` and gated exports are `skipped`, except that a gated export is first compared on the steps and outcomes it did judge (a disagreement there is a `mismatch`). `--mutate[=all]` inverts one assertion per spec (every outcome with `all`) in a temp copy next to the export test and requires the copy to fail at that outcome: `killed`, `survived` (assertion not effective), `invalid` (failed elsewhere) or `not-applicable` (judged by a throwing helper). `--verify-only <spec>` narrows the runs, `--verify-strict` fails on anything skipped or inconclusive. Output: `urn:cairntrace.dev:export-verify:v1` in json / yaml / md, also written to `.cairn-export-verify.json` and `.md` and summarized in the manifest's `verify` (kept by a re-export only while the files are identical). On a host config with several projects (the `npm init playwright` chromium / firefox / webkit trio, devices with a setup project and `dependencies`) a listing shows each test once per project and an unfiltered run would run every browser: every Playwright run of the verify (list, differential, mutants) uses one project with `--project` — `--verify-project <name>` (MCP `verifyProject`), else the one recorded in the manifest at export time (the flag or `export.targets.<name>.verifyProject`), else the first project that discovers the exported tests and runs Chromium, else the first in config order; Playwright still runs its dependencies (a setup project) and a failed dependency makes the spec an `error`; the report's `playwrightProject` says which and why, and an unknown name is exit 2. Exit 0 all passed, 1 a gate / differential spec / mutant failed, 2 usage or environment error (no manifest, app unreachable, no local Playwright for the runs, an unknown `--verify-project`), 3 inconclusive: what was requested proved nothing (neither `tsc` nor `playwright --list` ran, the differential matched no spec, no mutant was killed or survived) — never a pass; merged with the export's own exit code by severity 2 > 1 > 3 > 0.",
      },
      {
        title: "Host profiles (--into --host-config)",
        body: "`cairn export playwright <spec|dir> --into <dir> --host-config <playwright.config.ts>` (MCP `hostConfig`) fits the generated code to an existing Playwright tree. The host's config, its tsconfig (with `extends`) and nearest package.json are READ, never executed: the config is parsed to a syntax tree and only literal-shaped values are evaluated (strings, numbers, booleans, regexes, objects, arrays, consts, relative imports of other config modules, `__dirname` / `import.meta.dirname`, `path.join` / `path.resolve` / `path.dirname`, templates, `30 * 1000`, `process.env.X || \"fallback\"`, `a ?? b` / `a || b` with JavaScript truthiness, `defineConfig(a, b)` merged like Playwright, `module.exports =`; a device, spread `...devices[...]` or bare `use: devices[...]`, sets none of the options read — only its browser is read, for `--verify` to prefer a Chromium project). Options resolve like Playwright: a project's value over the top level (`use` merged key by key), and only the projects whose testDir / testMatch / testIgnore discover the generated tests count; testMatch is matched like Playwright's file matcher (regex against the absolute path, a glob prefixed with `**/`). An option that cannot be read (computed, behind a spread or import it cannot follow, or disagreeing between the running projects) is NAMED in `host.unread` and `host.notes`, never replaced by a default: an unread timeout → every test sets its own derived budget; an unread testIdAttribute → explicit attribute selectors (`process.env.X ?? \"lit\"` uses the fallback and says so); an unread bypassCSP → page evals count as not bypassed; an unread testDir / testMatch / testIgnore / projects → REFUSED (exit 2), discovery cannot be checked. `typescript` is the host's when it has the JavaScript API, else cairntrace's own (a runtime dependency); a TypeScript without it (native TS 7) is skipped and named. The host's `use.storageState`: a `coldStart: guest` spec resets it with `test.use({ storageState: { cookies: [], origins: [] } })`. RUNS THE HOST'S TOOLS: `--host-config` (and `--check` / `--verify` of such an export) runs the host's local prettier with its config (a JavaScript config and its plugins load), and `--verify` its local eslint, tsc and `playwright test --list`; configs and binaries are looked up only up to the host's boundary (the nearest `.git`, else the outermost package root below the home directory), never a stray ~/.prettierrc. What changes: MODULE SYSTEM (`\"type\": \"module\"` → `import.meta.url`, else `__dirname`; also fixes `lib/projectRoot` / `lib/fixtures` in a CommonJS host; node16/nodenext ESM gets `.js` import extensions); TIMEOUTS (a test calls `test.setTimeout` only when its derived budget is above the host's `timeout`, default 30s — never to fight it); TEST IDS (`getByTestId` when the host's `use.testIdAttribute` is the attribute the spec means — config `browser.testIdAttribute`, default data-testid — else explicit attribute selectors, a run-time value CSS-escaped); `bypassCSP` (a page eval — `eval` steps, `wait: { app }` checks, browser `script` outcomes, inside actions and teardown too — in an export to a host whose running projects do not all set `use.bypassCSP: true` is REFUSED, exit 2, unless `--allow-eval-without-bypass`; an exported `wait: { app }` a CSP blocks fails at once naming the CSP); tsconfig `module: nodenext` / `node16` without moduleResolution counts as that resolution (`.js` imports in an ESM package); DISCOVERY (`testDir` / `testMatch` / `testIgnore`: tests land flat in the --into folder when it is under testDir, in the testDir subfolder when testDir is under it, named *.spec / *.test / *.e2e to match; an --into the host would not discover is an error); tsconfig `paths` (generated modules import each other through an alias covering the export); IMPORTS (only used ones, packages before relative, alphabetical); IDENTIFIERS (camelCase, an alias suffix when two names collapse); braces on every if; vendored runtime files carry an eslint-disable banner when the host has an eslint config (tests and actions do not); the host's LOCAL prettier formats every text file when a prettier config exists (never installed; run until stable, so `prettier --check` passes and `--check` / `--verify` reproduce the text). The report (`--format json`) has `host` (config relative to the export, moduleSystem + moduleReason, testTimeoutMs and testIdAttribute (absent when not readable), projects (those that run the tests), unread, testsDir, testSuffix, bypassCsp, alias, formatted, formatSkipped, baseUrl, notes). The manifest's `source.hostConfig` makes `--check` and `--verify` regenerate with the same profile; `--verify` type-checks with the tsconfig the profile names, lints with the host's eslint and lists with `playwright test --list --config <host>`. A tsc that rejects the host tsconfig (an option error such as TS5095) skips the typecheck gate instead of passing it. Add .cairn-export.json and .cairn-export-verify.* to the host's .prettierignore when it checks the whole tree.",
      },
      {
        title: "Export targets (config export.targets, --target)",
        body: "`export: { targets: { <name>: { input, into, hostConfig, preconditions, verifiers, gateEnv, lang, env, mapFile, maxEvalRatio, allowEvalWithoutBypass, strictLocators, verifyProject } } }` in cairntrace.config.yml names a handoff; `cairn export playwright --target <name>` (MCP `target`) uses it, with a flag given on the command line overriding the profile field and the spec argument optional when the profile has `input`. Paths are relative to the config file. The config is `--config`, else the nearest cairntrace.config.yml above the path (or the working directory). `mapFile` is the export map (`--map`, see Export map); `cairn config validate` checks it exists, parses, and that its relative imports name files. `cairn config validate` checks every target as an export request on its own (modes that combine, `input` and `hostConfig` exist, `hostConfig` needs `into`, the host config reads statically and its testDir / testMatch discover the tree, `maxEvalRatio` within 0..1) and lists them under `exportTargets`. The manifest records `source.target`, `maxEvalRatio`, `allowEvalWithoutBypass` and `verifyProject` (the host Playwright project a later `--verify` lists, runs and mutates under on a multi-project config; `--verify-project` on the export command records it too).",
      },
      {
        title: "Export map (--map export.map.yml)",
        body: "`--map <file>` (profile `mapFile`, MCP `mapFile`; needs `--into` or `--project`) binds cairn actions to the host's own constructs. The map is YAML data, never executed: `{version: 1, strict?, test?: {import, name?}, basePage?: {import, name, pageProperty?}, actions?: {<action>: <mapping> | [<mapping with when>, …]}}`; imports are module specifiers (package or tsconfig alias, as written) or `./relative` paths relative to the map file. A mapping has exactly one of: `fixture: {name, import?, testName?, type?, providesPage?, vars?}` (the test destructures the host fixture in its signature, `test` comes from the host module, the action's steps are not emitted; each var the call passes needs a rule: `{option: <name>}` -> `test.use({ name: value })` (the action's default when the call passes none), `{const: v}` -> checked against the call, `{ignore: true}`); `method: {import, class, call, args?: [{var, default?} | {const}], instance?: {fixture}, ignoreVars?}` (`await new OrdersPage(page).openOrder(arg)`, or the fixture's instance — which needs the same `test` as the spec's fixtures, two different `test` modules are an error; a passed var no argument takes is an error; in an ESM host a barrel import keeps `/index.js`, `.mts` / `.cts` become `.mjs` / `.cjs`); `apiLogin: {storageState?, setupProject?}`; `generate: {class?, method?}` (names the generated page object). `when: {var, equals|in}` on a mapping of a list picks by the call's var; `note` is kept in the report. Unmapped actions become generated page objects under `lib/pages/` (one class per action, extending `basePage` or a generated minimal `lib/pages/base-page`; the call is `await new LoginPage(page).login(vars)`; a derived class name that is already a host class the map imports gets a number, `OrdersPage2`); with `strict: true` an unmapped action a spec uses is an error naming every one. Fixture and apiLogin bindings run before the test body: a `use:` that was not first is exported with a `mappedOrdering` risk, and one nested in another action / repeat / if / retry (or with `when`) is an error. API login: an action whose steps are all plain `request` steps (no matrix / until / credentials: omit), named for signing in (login, log_in, signin, sign_in, authenticate; never logout / revoke / delete / refresh / reset …) and preceded by no real step, or any request-only action mapped `apiLogin`, becomes `lib/authState`: request.newContext, the session saved under `<export>/.auth/` owner-only (0600) and atomically (git-ignored by `.auth/.gitignore`; a storageState path outside `.auth/` is an error), a `providesPage` fixture in the same test reported as a `mappedStorageState` risk (a fixture that builds its own context never sees the storageState), signed in once per process in a `test.beforeAll` (`--preconditions global`: once in global-setup; `setupProject` uses the host's own project and generates nothing). Credentials are `process.env` reads at run time (a missing one fails naming it) and never appear in generated code, manifest, report or saved state, nor in page.evaluate. The report carries `map: {file, digest, strict, actions: [{action, treatment: fixture|method|storageState|generated, target, specs, note?, type?}]}` and each spec's `mapped`; the manifest's `source.map` records the file and a digest of the parsed map, so `--check` / `--verify` regenerate with it (a missing map is exit 2; a changed one warns, and is stale when the output changes). `--verify` typechecks the mapped export against the host's real fixture and page-object types.",
      },
      {
        title: "Eval ratio (--max-eval-ratio)",
        body: "`--max-eval-ratio <0..1>` (profile `maxEvalRatio`, MCP `maxEvalRatio`) refuses a spec whose share of page `eval` steps is above the limit: eval steps / steps over the spec as it runs and exports (imported actions expanded, if / repeat bodies walked, a container counts as one step, `teardown:` steps counted; `wait: { app }` does not raise the ratio but is a page-eval site for bypassCSP); equal passes. The refusal is per spec: the other specs are still exported, each refusal is printed on stderr and listed under `refused` (name, evalSteps, totalSteps, ratio, limit, message), and the command exits 1 after writing the rest; every spec refused writes nothing (exit 1); `--stdout` prints nothing and exits 1; MCP returns isError with the same report. The manifest records the limit so `--check` / `--verify` regenerate the same set. Each spec's coverage has `evalRatio: {evalSteps, totalSteps, ratio}` when it has any eval (markdown: `eval 2/3 (67%)`), and `cairn spec lint` warns (`eval-ratio`) when an export target's `maxEvalRatio` would refuse the spec.",
      },
      {
        title: "Coverage report",
        body: "When writing files, stdout is a structured report with per-spec coverage: steps/outcomes exported vs total; `skips` (every construct not exported — a HARD skip marks the test `test.fixme`: unreadable eval.file / browser script.file, inline runtime: node scripts, the process verifier, mongo/temporal verifiers under `--verifiers keep`, an xlsx verifier in a single file (needs --project), an http verifier whose datasource is not an http datasource of the export environment, unresolved use:, unbound runtime splices or typed references); `diagnosticSkips` (the soft subset that only loses diagnostics: snapshot, monitor, and single-file preconditions); `semanticRisks` (`envBaked`, `absolutePath`, `requiredInfra`, `requiredSetup`, `unresolvedSplice`, `literalSplice`, `evalRatio` (with `coverage.evalRatio`: evalSteps, totalSteps, ratio), `secretInBrowser`, `envPolicy`, `verifierGated`, `verifierDropped`, `globalPreconditions`, `pollApproximated`, `teardownBestEffort`, `transformInProcess`, `mappedOrdering`, `mappedStorageState`); and `fixme`. Coverage of an imported action is propagated into every test that calls it. Markdown output prints skip reasons and risks per spec. Agents should read `coverage` in `--format json` before treating a handoff as complete.",
      },
      {
        title: "Fidelity (what exports well)",
        body: "Well supported: open, click (including click.until retry loops), hover, focus, fill/type (including verify-after-settle retry loops and verifyFill opt-out), select, upload (fixtures copied in --project), `postcondition.network` (response listener before the mutation; mutation emitted once), download, wait (text/notText/selector/value/load/url), press, scroll, request (page.request with cookies + body/headers/expectStatus; v2 credentials/until/retry/capture/matrix through the `cairnRequest` / `cairnRequestMatrix` helpers — inlined, or `lib/request` in --project), `use: login` (`cairnLogin(page, CAIRN_AUTH)` through page.request with secrets as process.env reads — an unset one throws before anything is sent — and the hydrate script given only the login response; `--project` writes `lib/auth` and `cairnLoginState` saves a storageState for globalSetup; without an `auth:` block at export time it is a hard skip), eval (inline js and eval.file — embedded at export time and copied to `evals/` in --project — including location.reload() retry; a source that uses __cairn runs after CAIRN_PRELUDE, the same page prelude with the config browser.appHandle accessors — lib/prelude in --project), wait.app (expect.poll over cairnAppCheck, the in-page check cairn run polls), `${requests|evals|artifacts.…}` splices via bindings, batch (flattened sequential steps — hover atomicity is lost), when: urlContains|urlNotContains|urlMatches|text|notText|selector|notSelector (string or object form, including selector+hasText, url and var predicates) as real if-blocks, control flow (repeat → a bounded for loop that checks until before each iteration plus a final expect for onMax: fail; if/else → if/else blocks; wait.any → Promise.any; wait.all → one expect.poll that reads every condition each tick (all must hold at once, like cairn run); optional waits → a caught miss; wait assign → a typed binding read by ${waits.…} and var predicates; use retry → a try/catch retry loop, around the action module call in --project; ${repeat.*} → the loop variable), locator visible/includeHidden, text/notText/url/count/network/console outcomes, browser script.run and browser script.file outcomes, node file verifiers (script.runtime: node + file: — imported and invoked directly), basic httpJson, ${vars.*} via --config/--env/--var, ${secrets.*}/unset ${env.*}/${run.token} as env/RUN_TOKEN references. Skipped or partial: unreadable eval.file / browser script.file, inline runtime: node scripts (no file), transform, snapshot, monitor, file/process/xlsx verifiers, documentary echo preconditions, advanced httpJson matchers (matches/atLeast/atMost), control-flow conditions that read run-only values (captures/runs/fixtures vars — the whole block is a hard skip). A hard skip marks the generated test `test.fixme`.",
      },
      {
        title: "MCP",
        body: "`cairn_export_verify` is `--verify` (exportDir, differential?, mutate: one|all?, strict?, only?, durationRatio?, config?, env?, var?, verifyProject?; the report is structuredContent, isError unless it passed: failed exit 1, error 2, inconclusive 3). `cairn_export_playwright` runs the CLI code path: path (spec or dir; optional with a target that names an input), out, outDir, lang js|ts, stdout, project, into, config, env, var, preconditions (inline|global|skip|manifest), verifiers (keep|gate|drop), gateEnv (names; with verifiers gate), hostConfig (with into), mapFile (with into or project: the export map), target, maxEvalRatio (0..1; refused specs under `refused`, isError), allowEvalWithoutBypass. project/into exports copy fixtures and write `.cairn-export.json`; batch outDir exports write the README and manifest; specs that fail to export are listed under `errors`. structuredContent is the same report schema as `--format json`. For an agent-readable journey (not Playwright source) see `cairn docs brief` / `cairn export brief`.",
      },
      {
        title: "Import (reverse direction)",
        body: "`cairn import playwright <file>` (TypeScript AST walk) and `cairn import playwright-trace <trace.zip>` go the other way, into reviewable Cairntrace YAML with TODO comments and a coverage summary for everything they cannot map. See `cairn docs import`. Always re-run `cairn spec verify` and fix cold-start before treating an import as complete.",
      },
      {
        title: "Authoring path (writing tests)",
        body: "To write new tests as an agent: `cairn docs authoring` → discovery (`cairn_discover_*` or `cairn discover`) → export YAML → `cairn run --cold-start` → heal if needed. Only then `cairn export playwright` if a Playwright artifact is required.",
      },
      {
        title: "Under the hood",
        body: "Emission is a small statement IR (`codegen.ts`: raw/comment/block/tryCatch nodes) rendered by a single printer, so indentation and block matching can't drift. String/value quoting is centralized in `templateValue.ts` (`emitStr`/`emitValue`), which is the only place that turns `${secrets.X}`/unset `${env.X}`/`${run.token}`/action-var sentinels into `process.env`/`RUN_TOKEN`/parameter splices and `${requests|evals|artifacts.…}` into binding reads; every generated file is then scanned for a surviving sentinel. Golden-file tests (`playwrightExporter.golden.test.ts`, `UPDATE_GOLDENS=1` to regenerate) and a TypeScript type-check under `strict` + `noUnusedLocals` (`playwrightExporter.validation.test.ts`, plus a whole `--project` export of `examples/flows`) guard the generated source against silent drift; CI also runs an exported examples project against the demo app.",
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
      {
        title: "Fail CI when a committed export drifted from its specs",
        language: "bash",
        code: "cairn export playwright --check exports --format json",
      },
      {
        title: "Prove an export faithful against the running app",
        language: "bash",
        code: "cairn export playwright --verify exports --differential --mutate --format json",
      },
    ],
    relatedTopics: [
      "authoring",
      "discovery",
      "steps",
      "verifiers",
      "backends",
      "mcp",
      "brief",
    ],
  },

  brief: {
    title: "Journey briefs",
    summary:
      "Compile a spec into an agent-neutral journey brief: what to fill, what to look for, and locator approximations. Use this when authored selectors do not replay in a delicate environment but a harness can still drive agent-browser. The contract stays intent + outcomes. The harness chooses WHERE; Cairntrace keeps WHAT.",
    sections: [
      {
        title: "When to use",
        body: "Use a brief when the local spec already passes and you know the values, but CSS/testid locators miss in another environment (different build, i18n, vendor widgets). Prefer semantic locators (`by: role|label|text`) and `cairn spec heal` first when the accessibility tree is stable. A brief is not a new verifier and does not rewrite the spec.",
      },
      {
        title: "CLI",
        body: "`cairn export brief <spec|dir> [--from-run <runDir|latest>] [--out <file>] [--out-dir <dir>] [--stdout] [--format json|yaml|md] [--config] [--env] [--var key=value]`. JSON is the stable `urn:cairntrace.dev:brief:v1` document. Markdown is a renderer of that document. `--from-run` copies `StepResult.resolved` (role/name the green run actually hit) onto each step. The brief header includes environment and how the spec satisfies cold-start (guest, checkpoint, imports, or preconditions).",
      },
      {
        title: "Live try-then-ask",
        body: "MCP `cairn_accompany_open` runs the spec and tries authored locators first. On a miss it parks with a miss packet (brief step + live inventory + snapshot). `cairn_accompany_choose` accepts a locator or a snapshot ref; Cairntrace dispatches the same authored value to that locator. Close with `cairn_accompany_close`. Sessions idle-expire after 5 minutes. There is no CLI choose loop in v1.",
      },
      {
        title: "Decisions journal and draft copy",
        body: "Each accompany session is journaled like a discovery session (<artifactRoot>/_sessions/<id>/, kind accompany; `cairn discover sessions` lists it). Every choose is an `action.performed` (action choose, ok once the step passed with it), an accepted one a `step.recorded` with the replacement step and where it is declared. Accepted replacements of spec-level steps are applied to a draft copy (draft.spec.yml in the journal, plus `draftTo` when given) with the authored values and placeholders intact; a snapshot @ref is recorded as role + accessible name. The source spec — and an imported action file — is never written: replacements inside actions stay suggestions in the journal. `cairn_accompany_status` returns the decisions and the draft path.",
      },
      {
        title: "WHERE not WHAT",
        body: "The harness may pick a different control. It may not change fill/type/select values, URLs, or outcomes. Secrets appear as `{ kind: secret, name }` — never inlined. `eval` / `request` / `transform` / `monitor` are machine-only: the live session still runs them; the static brief marks them as coverage skips.",
      },
      {
        title: "Run miss packet",
        body: "A failed interactive step on `cairn run` attaches `failure.brief` (that step's approximations + authored values) and suggests `cairn export brief`. `agent_context.md` renders the parked step.",
      },
    ],
    examples: [
      {
        title: "Export a markdown brief",
        language: "bash",
        code: "cairn export brief flows/login.yml --from-run latest --stdout --format md",
      },
      {
        title: "Export JSON for a harness",
        language: "bash",
        code: "cairn export brief flows/login.yml --format json --stdout",
      },
    ],
    relatedTopics: ["export", "discovery", "authoring", "steps", "mcp"],
  },

  catalog: {
    title: "Project catalog",
    summary:
      "Ask what the project already has before authoring: reusable actions (description, inputs, used-by, last green run), config vars per environment, script verifiers and their fixtures contract, environments and their policy, flows with their last run, and checkpoints. Reuse `use: <action>` and `${vars.X}` instead of re-recording literals. Reads files only.",
    sections: [
      {
        title: "CLI and MCP",
        body: "`cairn catalog [--config <path>] [--env <name>] [--query <text>] [--kind actions|vars|verifiers|envs|flows|checkpoints|fixtures|suites] [--limit N] [--artifact-root <path>] [--format json|yaml|md]`. `--kind` is repeatable or comma-separated. JSON is the stable `urn:cairntrace.dev:catalog:v1` document; every `file` is relative to `root` (the config directory). MCP `cairn_catalog` takes config, env, query, kind, limit and artifactRoot and returns the same document as structuredContent, with a short text summary (rows per kind, the first names, how to narrow); without query or limit it returns at most 20 rows per kind (`totals` keeps the full counts). The `cairn://catalog` resource is the catalog of the project the server runs in (compact JSON, scoped to the config defaultEnvironment when one is set). Exit 0 ok, 2 usage error, 4 config error (invalid config, an --env the config does not define, or --env with no config found). A malformed project file never fails the catalog: an unreadable file or a row the schema rejects is left out and named in `warnings`.",
      },
      {
        title: "Query",
        body: "`--query` splits names, descriptions and comments into words (camelCase, snake_case and kebab-case boundaries, light stemming) and ranks rows: name > description/intent/tags > inputs > comments and other text. Rows that do not match are dropped; the default limit becomes 10 per kind and `totals` keeps the full count. Each row carries `score` and `matched` ({token, field}) so you can see why it ranked.",
      },
      {
        title: "Rows",
        body: "actions: name, file, description (`description:` field, else the leading YAML comment; descriptionSource says which), inputs (declared under `inputs:`, referenced as `${vars.X}`, default, required, configEnvs), steps, usedBy, lastGreenRun, problems. vars: one row per environment with the authored value (placeholders kept, secret-like values `[redacted]`), the YAML comment above the key, definedIn environment|inherited (`<<:` merge or `vars: *anchor`, inheritedFrom)|top-level (top-level `vars:` or an included file)|extends (inheritedFrom names the environment), `file` (file:line of a definition the environment does not write) and usedBy; `cairn config vars` adds effective values, overrides and uses beyond specs/actions. verifiers: each `script.file` with its header comment, fixtures contract (source header|export|usage|none, dynamic) and per use the fixture keys passed, unknownKeys and missingKeys. envs: baseUrl, policy, services (enabled, phases), secrets provider and key names. flows: name, intent, tags, requires, actions, checkpoint, draft, lastRun. checkpoints: the ones specs resume plus saved ones captured for an origin a configured environment uses, with health, scope, problem (with --env: origin mismatch), usedBy; checkpoints of other projects are only counted (`scan.otherCheckpoints`). fixtures: the config `fixtures:` registry (kind, scope, datasource, verbs, needs, output keys, params, ttlMs) with the specs that list each one (usedBy). suites: the config `suites:` registry (selectors as authored, parallel, bail, requires, seedSkip) with `envs`: per environment the resolved spec files in run order, or a `problem` (unknown spec, ambiguous name, empty selection, `requires` refusal), var names and hook counts (never values or commands) — `cairn suites list` prints the same rows. Last runs are matched by the spec's own path; when no scanned run recorded it, the newest run under the spec's name is used and marked `matchedBy: \"name\"` (it can come from a same-named spec of another checkout).",
      },
      {
        title: "Documenting actions and verifiers",
        body: "Actions may declare `description:` and `inputs: { <name>: { description, required, default } }`. `vars:` still holds the values a run uses: an input `default` must equal `vars.<name>`, and a `required` input cannot have a default (the spec parser rejects either). A `required` input must reach the action from the importing spec's `vars:`, a config environment var or `--var`; a `use:` call site can override it, but a value passed only there is not enough. Script verifiers document their fixtures in the header comment (a `Fixtures:` block, one `name: description (required)` per line, or `@fixture name description`), or export `fixtures` / `contract = { fixtures }` as an object literal; otherwise the catalog infers the keys the code reads.",
      },
    ],
    examples: [
      {
        title: "Find what to reuse before authoring",
        language: "bash",
        code: 'cairn catalog --query "edit website field" --json',
      },
      {
        title: "One environment's vars and checkpoints",
        language: "bash",
        code: "cairn catalog --env staging --kind vars,checkpoints --format md",
      },
      {
        title: "A documented action",
        language: "yaml",
        code: 'version: 1\nname: edit_and_save_text_field\ndescription: Reveal, edit and save a profile text field.\nvars:\n  textFieldValue: hello\ninputs:\n  textFieldSelector: { description: CSS selector of the input, required: true }\n  textFieldValue: { description: Value to type, default: hello }\nsteps:\n  - fill: { by: selector, selector: "${vars.textFieldSelector}", value: "${vars.textFieldValue}" }',
      },
    ],
    relatedTopics: ["authoring", "discovery", "verifiers", "mcp"],
  },

  delegate: {
    title: "Delegated runners",
    summary:
      "`environments.<n>.runner: { command, cwd?, env?, timeoutMs?, idleTimeoutMs?, cancelGraceMs? }` makes `cairn run --env <n>` (and MCP `cairn_run`) hand the execution to a command that runs the invocation on another machine, while the local cairn keeps the journal, the run directories, the exit code and Ctrl-C / Studio Stop and Live Cancel. Contract `urn:cairntrace.dev:delegate:v1`: a request file, an events stream file, run directories under the local artifact root. The runner's exit code is a claim cairn checks against that evidence.",
    sections: [
      {
        title: "What runs where",
        body: "Locally: config + engine pin, `--suite` resolution, the environment policy (`requires.env` / `mutates`), `--select-only`, scoped secrets, `run.lock` (scoped to the delegated environment, so it never blocks the local environments or `cairn services`; `environments.<n>.run.lock: false` when the runner manages capacity), `run.preflight`, then — after the runner exited — `run.finally`, JUnit and the result document. Not locally: services, webServer, browser, suite before/after hooks, metrics, fixtures, `--before` / `--after` (passed to the runner in the request), `run.verifyClean` (nothing of the run is local), `runtimes.node`. An environment with a runner may not own a `services:` block (one inherited through `extends` included: set `services: false`); `cairn config validate` lists `delegatedEnvironments`. A runner environment never runs a spec locally, and an invocation that mixes it with any other environment (a spec's own `environment:`, in any order) is refused, exit 4. A spec the local policy refused never runs remotely: the request moves it from `planned` to `refused` and `cairnArgs` name the other specs explicitly (next to `--suite` they narrow the suite, which keeps its hooks, vars and labels).",
      },
      {
        title: "The contract (v1)",
        body: "cairn spawns `command` (argv, no shell; `${env.X}`, `${secrets.X}`, `${vars.X}`, `${config.dir}` resolve) in its own process group, stdout/stderr to a file copied redacted into `<journal>/logs/delegate.log`, with `CAIRN_DELEGATE_REQUEST` (JSON, 0600: contract, cairnVersion, invocationId, env, configDir, suite, specs relative to the config directory, planned, refused (only when the policy refused something), the caller's portable `options`, `resolved` vars/labels/bail/parallel, `runToken` when pinned, `cairnArgs` for the remote `cairn` without `--env` and with `--label cairn.delegate=<invocationId>`, artifactRootLocal, journalDirLocal, eventsPath, timeoutMs, idleTimeoutMs, cancelGraceMs), `CAIRN_DELEGATE_EVENTS` (a file to append NDJSON to), `CAIRN_DELEGATE_CONTRACT`, `CAIRN_INVOCATION_ID` / `CAIRN_INVOCATION_DIR`, `CAIRN_ARTIFACT_ROOT` and the scoped env + `runner.env`. The runner runs `cairnArgs` as given, appends the remote journal's events.v1 lines plus `invocation.run.started` / `invocation.run.finished` / `invocation.summary` — exactly what `cairn logs --invocation <ref> --follow --relay` prints on the remote side (`<ref>` may be `label:cairn.delegate=<id>`, waited for with `--follow` at most `--wait-timeout`, default 10m, then exit 2) — and may add its own `delegate.progress {message, phase?}` lines (no other `delegate.*`). It copies every run directory to `<artifactRootLocal>/<runId>/` (`run.json` and `artifact-manifest.json` last, mtimes kept); v1 conformance: each run.json carries `labels[\"cairn.delegate\"]` = the local invocationId (the remote cairn adds it from `cairnArgs`). It exits with the remote exit code (2, never 1, for its own infrastructure failure). Fields a runner does not know are ignored; v1 changes only additively.",
      },
      {
        title: "Relay and verification",
        body: "Every line is validated against events.v1: a malformed, invalid or too long (1 MiB) line is an error `delegate.diagnostic` (malformed-line, invalid-event, line-too-long) and is skipped — the relay never stops; an unknown type is a warning (unknown-event); a known event with unknown fields is relayed without them; `delegate.*` other than `delegate.progress` and relative paths that are absolute or climb out with `..` are refused (invalid-event). Re-streaming is safe: exact repeats are dropped (the last 50 000 distinct lines), run lines repeat by state (a settled run never goes back to running; a different second status is `status-mismatch`), and the event after a torn line (a reconnect mid-line) is recovered with a warning. Remote heartbeats and `log.opened` are dropped, remote `phase.changed` moves the local phase, remote `invocation.started` / `invocation.finished` become `delegate.remote.started` / `delegate.remote.finished` (a finish or summary of another remote invocation does not count), everything else lands in the local journal with `delegated: true`. Remote runs map onto the local plan by spec path; a run of a locally refused spec is `refused-run` (not relayed); a synthetic pass is `synthetic-pass` (recorded errored). After the runner exits each run's `<artifactRootLocal>/<runId>/run.json` is checked: missing (`missing-run-dir`), labelled for another invocation (`foreign-run`), a directory that was there before the runner started (`stale-run`), a status that is not the stream's (`status-mismatch`; run.json wins), never finished (`unfinished-run`), no manifest (`incomplete-run-dir`, warning); when the runner claimed a result (exit 0/1) every planned run must be settled or accounted for by the remote summary's refused/skipped counts (`missing-run`). Foreign and stale run directories never become this invocation's documents.",
      },
      {
        title: "Exit codes and cancel",
        body: "The runner's exit code is a claim. 0 stands only when every planned run was settled by a run directory of this invocation whose run.json agrees with the stream, every relayed run passed, the remote invocation's own finish/summary (same id) passed and the stream had no error line; otherwise it becomes 2 (evidence missing, foreign, stale or contradicting), the remote invocation's code, or the runs' code (1/2). 1 stands only when a relayed run (or the remote verdict) failed; otherwise 2 (an infrastructure failure is never a red test; runs `--bail` stopped do not change a real 1). 2–9, 130 and 143 are never lowered. Any other code (`invalid-exit-code`), a foreign signal (`runner-signal`), a runner that cannot start (`spawn-failed`), `runner.timeoutMs` (`timeout`) and `runner.idleTimeoutMs` of silence (`idle`; without it a warning after 5 minutes) are 2. Every override adds an `exit-mismatch` diagnostic. Every spec refused locally: nothing delegated, exit 7. Ctrl-C, SIGTERM, Studio Stop and Live Cancel (both SIGINT; Live Cancel never SIGKILLs a delegated run early) and MCP `cairn_run_cancel`: SIGINT to the runner's pid only, so its helpers (an ssh follower, an rsync) keep working (`delegate.cancel.requested`), up to `cancelGraceMs` (default 180000) while the relay and the heartbeat keep going, then SIGTERM and 10s later SIGKILL to its process group (`delegate.cancel.escalated`), then the last lines, the run-directory check, `delegate.cancel.finished` / `delegate.finished`, the journal aborted, `run.finally`, the lock; exit 130 (143 for SIGTERM). A shell wrapper must `exec` the runner (or pass SIGINT on). The document carries `invocationOutcome.delegate` {remoteInvocationId, runnerExitCode, runnerSignal, diagnostics}; invocation.json and `cairn_run_status` carry `delegate` {contract, command, pid, remoteInvocationId, remoteStatus, exitCode, signal, cancelled, timedOut, idle, diagnostics}. `--services-dry-run` / `--select-only` print the masked plan (argv, env names, request) and spawn nothing.",
      },
      {
        title: "Writing a runner",
        body: "1. Read the request, check `$schema`. 2. Take capacity (or exit 4). 3. Ship the project (same layout) to a machine with a recent enough cairn. 4. Deliver secrets through your own channel, never through the stream. 5. Start `cairn <cairnArgs…> --env <remote env>` there, `cairnArgs` exactly as given (the label, the explicit spec list). 6. Pipe `cairn logs --invocation label:cairn.delegate=<invocationId> --follow --relay --wait-timeout 10m` into CAIRN_DELEGATE_EVENTS (reconnect freely). 7. Mirror this invocation's `runs/<runId>/` into artifactRootLocal periodically and at the end, run.json + artifact-manifest.json last, mtimes kept. 8. On SIGINT (your pid only) cancel remotely, keep following until the remote journal settled, mirror, stop your helpers, exit 130 within cancelGraceMs (then your group gets SIGTERM, SIGKILL). 9. Release capacity on every path. 10. Exit with the remote exit code; 2 for your own failures, never 1. `src/testing/fakeDelegateRunner.ts` is a reference runner; `docs/delegate.md` has a skeleton.",
      },
    ],
    examples: [
      {
        title: "A delegated environment",
        language: "yaml",
        code: 'environments:\n  local: { baseUrl: "http://localhost:8080" }\n  remote:\n    services: false\n    runner:\n      command: [bun, tools/remote-run.ts, --pool, "${vars.pool}"]\n      env: { REMOTE_TOKEN: "${secrets.REMOTE_TOKEN}" }\n      timeoutMs: 14400000\n      idleTimeoutMs: 600000\n      cancelGraceMs: 180000\n    run: { lock: false }\nvars: { pool: default }',
      },
      {
        title: "Run, inspect the plan, follow",
        language: "bash",
        code: "cairn run --suite smoke --env remote --services-dry-run   # the masked plan, nothing spawned\ncairn run --suite smoke --env remote\ncairn logs --invocation latest --follow                   # the local journal, relayed events included",
      },
      {
        title: "The remote side of a runner",
        language: "bash",
        code: 'cairn "${CAIRN_ARGS[@]}" --env worker &\ncairn logs --invocation "label:cairn.delegate=$INVOCATION_ID" --follow --relay --wait-timeout 10m >> "$CAIRN_DELEGATE_EVENTS"',
      },
    ],
    relatedTopics: ["run-policy", "services", "artifacts", "mcp"],
  },

  widgets: {
    title: "Widget Kit",
    summary:
      "Typed steps for custom form controls — set / check / uncheck / choose / form — that detect a widget driver, write the value in the page and READ IT BACK, plus the click optional/dispatch/fallback and fill mode: set flags. They replace eval files that open pickers, type, click options and hope.",
    sections: [
      {
        title: "Fields And Locators",
        body: 'Every widget step targets either `field: <key>` or a locator (`by: role|label|text|selector|testid`, same strict rules: visible matches only, `nth` to pick). A field key resolves through config `browser.fieldRoot` — one CSS template or a list, each containing `{key}` (inside quotes it is quote-escaped, elsewhere CSS-escaped): `\'[data-field-key$=".{key}"]\'`, `\'[data-qa="{key}"]\'`. Templates are tried in order; the first with a VISIBLE match wins (a hidden duplicate is never the target), nested matches collapse to the outermost, and radios/checkboxes sharing one name resolve to their group. The default is `[<testIdAttribute>="{key}"]`, then `[name="{key}"]`. A missing field is waited for up to the step budget (`timeoutMs`, default 10000 × waitScale), then fails naming the hidden matches it saw; `optional: true` checks presence for ~750ms and records the step as skipped (`skipReason: absent`).',
      },
      {
        title: "Drivers",
        body: "The driver is the first whose `match(root)` claims the field (or `driver: <name>` forces one). Built-ins, in detection order: `vue-multiselect` (.multiselect: opens via the caret/placeholder, matches options already in the list before typing — so a filter that does not match the label cannot hide it — types to search remote lists, clicks the option, falls back to pointer + Enter, reads `.multiselect__single` or the tags), `primevue-autocomplete` (types, waits for the overlay found through aria-controls, picks by label; chips in multiple mode), `primevue-calendar` (ISO `YYYY-MM-DD` and `today` go through the picker — month navigation, day cell, Today button — other text is typed and must survive blur; comparison is by date parts, so `03/15/2027` matches `2027-03-15`), `pills` (PrimeVue Chips add on Enter; a `+Add` list reveals an input committed on Tab; pills only add — set passes when every listed item is present), `radio-group`, `checkbox-group` (native and ARIA, labels from label/aria-label/wrapper text, value attribute as a fallback), `native-select`, `native-input` (native value setter + input/change; a root with several text inputs is refused rather than guessed). Options match by label: exact (case/whitespace-insensitive) first, then one unique contains; ambiguity fails listing the candidates. `{ query, option }` types `query` and picks `option`.",
      },
      {
        title: "Read-Back And Evidence",
        body: "Before writing, the driver reads the field: a field that already holds the value is left alone (status `already`) — allow-unset radios are never clicked twice. After writing, the value is read back until it matches (≤ 2000ms × waitScale) or the step fails with `<driver> did not commit <expected>; field shows <actual>`. `widgets/<n>_<id>.json` records per field: driver, status (committed | already | written | skipped | failed), via, expected, actual, the root element and its visible text, notes; password fields and sensitive keys are masked and the file goes through the run redactor. Each field also emits a `widget.field` event (key, driver, status — never the value). run.json step results carry `driver` and `via`.",
      },
      {
        title: "Forms",
        body: '`form: { fields: { <key>: value | { value, optional?, dependsOn?, driver?, timeoutMs? } }, verify?: committed | none, onFailure?: dumpUnanswered, timeoutMs? }` runs fields in declared order (keys must not be integers — JavaScript reorders them). `dependsOn: <earlier key or keys>` gives a conditionally mounted field the full mount wait and skips it when a dependency was skipped. After the last field, every written field is re-read once more: a later field that re-rendered and wiped an earlier one fails the step. `onFailure: dumpUnanswered` (or `{ dumpUnanswered: true }`) adds the page\'s empty fields — enumerated from attribute templates like `[data-field-key$=".{key}"]` — to the evidence.',
      },
      {
        title: "Custom Drivers (Trust Model)",
        body: "`browser.widgets: [{ use: vue-multiselect }, { file: ./drivers/user-picker.js }]` lists drivers in detection order (the native drivers are appended when not listed). A driver module exports `{ name, match(root, ctx), read(root, ctx), write(root, value, ctx), equals?(actual, expected) }` with `export default` or `module.exports` (no imports). It is project code with the same trust as an `eval` file: its source is sent into the page with every widget call and runs with the page's privileges; cairn compiles it on load (syntax errors fail the step that needs it) and never runs it in Node. `ctx` offers sleep, waitFor(fn, ms), fire(el, type), pointer(el), press(el, key), nativeSet(el, value), typeText(el, text), matchOption(items, wanted, labelFn), note(text), option, deadline and remaining(). `read` returns a string, a list or a boolean; `write` may return `{ label }` (what the field should show) or `{ via }`.",
      },
      {
        title: "Click And Fill Flags",
        body: "`click: { …, optional: true }` skips (status skipped) when no visible target shows up within a short presence window (750ms × waitScale), and also when the target vanished before a failed click. Presence is decided in the page by the locator resolver `expect` uses (open shadow roots and image-alt names included; closed shadow roots and iframes are not seen). `dispatch: true` fires a DOM click on the resolved element — no pointer, no actionability wait — and fails on a disabled target. `fallback: dispatch` hit-tests the target's center first: when another element would receive the pointer (a leftover `.p-dialog-mask`), it dispatches directly and records `detail: pointer blocked by <element>`; otherwise it clicks with the pointer and falls back to the DOM click when that fails. `dispatch` / `fallback` cannot be combined with `until` or `postcondition`. `fill: { …, mode: set }` writes through the native value setter and fires input/change only (no focus, no keydown: an address overlay that opens on typing stays closed), then re-reads like fill; `fill.optional` skips a control absent after the same presence window. run.json `via` is `pointer` | `dispatch` | `set`.",
      },
      {
        title: "Uploads On agent-browser",
        body: "agent-browser sets file inputs through CDP with a host path; some Chrome builds accept it but never let the page read the File (`net::ERR_ACCESS_DENIED`, `NotReadableError`), so the app's upload silently never leaves the browser. After every upload, cairn checks in the page that the File is readable — only on the input the upload changed (file inputs are marked just before it), never another input holding a same-named file; when it is not, it rebuilds the File from the host bytes in the page (DataTransfer, ≤ 25 MB), assigns it to that same input and fires input/change again. run.json records `via: setInputFiles | dataTransfer` and `detail` with the read error (or that readability was not verified when the app cleared the input). Playwright keeps `setInputFiles`.",
      },
      {
        title: "Export",
        body: '`cairn export playwright` renders widget steps as `cairnWidget(page, …)` / `cairnWidgetForm(page, …)` calls — a helper that embeds the same in-page runtime and the project\'s fieldRoot/widgets config (`lib/widgets.ts` in `--project`), so an exported test commits and reads back exactly like `cairn run`. `click.dispatch` and `fill mode: set` run through the same helper (`op: "click"` / `op: "fill"`: one visible target, a disabled target fails, a wiped value is re-set), `fallback: dispatch` becomes a try/catch around a 5s pointer click with that dispatch as the fallback, and `optional` an `isVisible()` guard. Errors of a password control or a credential-named field never include its values.',
      },
    ],
    examples: [
      {
        title: "config",
        language: "yaml",
        code: [
          "browser:",
          "  testIdAttribute: data-field-key",
          "  fieldRoot:",
          "    - '[data-field-key$=\".{key}\"]'",
          "    - '[data-field-key=\"{key}\"]'",
          "  widgets:",
          "    - use: vue-multiselect",
          "    - use: primevue-calendar",
          "    - file: ./drivers/user-picker.js",
        ].join("\n"),
      },
      {
        title: "steps",
        language: "yaml",
        code: [
          "steps:",
          "  - id: answer_owner",
          "    choose: { field: business_owner, option: 'No' }",
          "  - id: answer_form",
          "    form:",
          "      fields:",
          "        country: Spain",
          "        setup: Shared entity",
          "        entity_code: { value: C100, dependsOn: setup }",
          "        start_date: today",
          "        products: [Widget A]",
          "        legacy_supplier: { value: 'No', optional: true }",
          "      onFailure: dumpUnanswered",
          "  - check: { field: certify, option: 'Yes' }",
          "  - click: { by: role, role: button, name: Start task, optional: true }",
          "  - click: { by: role, role: button, name: Save, fallback: dispatch }",
          "  - fill: { by: label, name: Address line 1, value: 10 Main Street, mode: set }",
        ].join("\n"),
      },
      {
        title: "custom driver (./drivers/user-picker.js)",
        language: "js",
        code: [
          "export default {",
          '  name: "user-picker",',
          '  match: (root) => !!root.querySelector(".user-picker"),',
          '  read: (root) => (root.querySelector(".user-card .name")?.textContent ?? "").trim(),',
          "  async write(root, value, ctx) {",
          '    ctx.pointer(root.querySelector(".user-picker__open"));',
          '    ctx.typeText(root.querySelector(".user-picker input"), String(value));',
          "    const option = await ctx.waitFor(() =>",
          '      [...document.querySelectorAll(".user-picker__option")].find((el) => el.textContent.includes(value)),',
          "    );",
          '    if (!option) throw new Error("no option " + value);',
          "    ctx.pointer(option);",
          "  },",
          "};",
        ].join("\n"),
      },
    ],
    relatedTopics: ["steps", "authoring", "export", "backends"],
  },
  "author-flow": {
    title: "Author a spec from a request",
    summary:
      "The recipe an agent follows to go from a few sentences of request to a promoted spec: catalog → discovery session started by the project's login action → record the journey → convention export into the drafts dir → `cairn spec finish` until green → report and let the human promote. MCP clients get the same text as the `author-flow` prompt (arguments: request, env, targetDir).",
    sections: [
      ...authorFlowSteps().map((step, i) => ({
        title: `${i + 1}. ${step.title}`,
        body: step.body,
      })),
      {
        title: "Starting from a Playwright test or a recording",
        body: "When the journey already exists, import replaces the discover → export steps: catalog (reuse actions and vars) → `cairn import playwright <file.spec.ts>` for a test, or `cairn import playwright-trace <trace.zip>` for a recording (MCP `cairn_import_playwright` / `cairn_import_playwright_trace`) → read the report (coverage, TODOs, approximations, remaining lint/verify findings) → replace TODO steps and draft outcomes by hand or with a discovery session (`cairn_discover_open` at the failing page) → `cairn spec finish` until green → `cairn spec promote` after the human approves. An import is a first draft, never a finished spec: its outcomes describe what the source asserted or what the recording showed, and the intent needs a human sentence. See `cairn docs import`.",
      },
      {
        title: "Drafts",
        body: "Convention exports land in the drafts dir — config `authoring.draftsDir`, default `flows/_drafts`, relative to the config. Folders and files starting with `_` are skipped by `cairn run <dir>` (and so by suites), so a draft never joins a run until `cairn spec promote` moves it out. `authoring.template` sets what every export starts with: `requires`, `metadata.tags`, and `imports` (action files exports look in first).",
      },
      {
        title: "Project setup for agents",
        body: "`cairn init agent-kit` prints a short AGENTS.md section for this project (its config, environments, drafts dir and actions) that points agents at this recipe; `--write` puts it in the AGENTS.md next to the config (an earlier agent-kit block is replaced). `cairn spec lint <spec> --fix` repairs the mistakes agents make most (unquoted # selectors, missing step ids) and explains the rest.",
      },
    ],
    examples: [
      {
        title: "From a CLI journal (interactions need the MCP session tools)",
        language: "bash",
        code: [
          'cairn catalog --query "profile website" --env local --json',
          "cairn discover /profile --use login_as_supplier --env local --json   # setup + open; leaves a session journal",
          "cairn discover export --from-session <sessionId> --into flows/_drafts --name profile_website_saved \\",
          '  --intent "A supplier can change the profile website" --outcomes outcomes.yml --json',
          "cairn spec lint flows/_drafts/profile_website_saved.yml --fix --json",
          "cairn spec finish flows/_drafts/profile_website_saved.yml --env local --json",
          "cairn spec promote flows/_drafts/profile_website_saved.yml --json   # after the human approves",
        ].join("\n"),
      },
      {
        title: "Project conventions",
        language: "yaml",
        code: [
          "# cairntrace.config.yml",
          "authoring:",
          "  draftsDir: flows/_drafts",
          "  template:",
          "    requires: { env: [local] }",
          "    metadata: { tags: [authored] }",
          "    imports: [actions/login.yml]",
        ].join("\n"),
      },
    ],
    relatedTopics: ["catalog", "discovery", "authoring", "import", "mcp"],
  },
  import: {
    title: "Import Playwright tests and traces",
    summary:
      "Turn an existing @playwright/test file or a Playwright trace archive into a reviewable Cairntrace spec, with a coverage summary and TODOs for what cannot be mapped. An import is a draft: finish and promote it through the author flow.",
    sections: [
      {
        title: "cairn import playwright <file.spec.ts>",
        body: "A TypeScript AST walk (the file is parsed, never executed). `typescript` is the project's own (walking up from the file) when it has the JavaScript API, else cairntrace's own (a runtime dependency); a TypeScript without the API (native TS 7) is skipped and named when nothing else is left. It maps ONE test (the first, or `--test <title substring | 1-based n>`; the others are named in TODOs) and what runs around it: enclosing `beforeEach` hooks, `test.step` bodies (titles become step ids), page-object methods (fields, getters, constructors, base classes, same file or relative imports, through `export *` / `export { A as B } from` barrels; an `if` on a flag passed as a literal runs only its branch, approximated), helper functions, `Promise.all([...])` (sequentially), and custom fixtures in the test signature (a `test.extend({...})` found through the test file's relative imports, barrels included: setup runs before the body in signature order; an option fixture's default is its value unless a `test.use({ option })` in scope sets it; a fixture or helper that builds its page with `browser.newContext()` becomes the spec's page, approximated; code after `use()` is a TODO). Calls it resolves: goto / waitForURL / waitForLoadState / waitForTimeout / waitForSelector, getByRole (name, exact) / getByLabel / getByText / getByTestId / getByPlaceholder / getByAltText / getByTitle / locator (CSS, text=, id=, role=, :has-text), filter({ hasText }), nth / first, click / dblclick / hover / focus / fill / clear / pressSequentially / press / check / uncheck / setChecked / selectOption / setInputFiles / scrollIntoViewIfNeeded / waitFor, the selector-first page API (`page.fill(sel, v)`, `page.click(sel)`, `type` / `check` / `press` / `selectOption` / `hover` …; `css=… >> text=…` chains), keyboard.press, request.get|post|put|patch|delete|fetch; assertions toHaveURL, toBeVisible / toBeHidden (and .not), toHaveText / toContainText, toHaveCount, toHaveValue (a wait step), toBeEnabled / toBeDisabled and toHaveAttribute (expect steps), expect(page.url()), expect(await loc.isVisible() / count() / textContent()). Static values only: literals, consts, template strings, `process.env.X` (→ `${env.X}`, or `${secrets.X}` for credential-named variables). Refuses to overwrite an existing `--out` file (exit 2; `--force`); a draft that maps nothing (no step, no outcome) is not written: a stderr WARNING, `status: refused` with the TODOs, exit 1 (`--allow-empty` writes it); more TODOs than mapped constructs adds a `low coverage` warning (`warnings`).",
      },
      {
        title: "Coverage: mapped, approximated, unmapped",
        body: "Every construct is counted once: mapped (exact), approximated (a loose mapping, with the reason in a `# APPROXIMATED:` header line: a regex pattern treated as text, a role name that a count verifier cannot filter by, `dblclick` as click, a test id assuming the default attribute, a dropped scope or `.last()`), unmapped (a `# TODO:` comment before the step it precedes, with the reason: control flow, page.evaluate, XPath or Playwright-only CSS, locator `.and`/`.or`, unresolved fixtures, `expect.poll`, `toBeChecked`, hooks other than beforeEach, `test.use` browser options, `test.skip`). Nothing is dropped silently. Output (json | yaml | md): `coverage { mapped, approximated, unmapped, total }`, `todos`, `approximations`, and `check` — the `cairn spec lint` and `cairn spec verify` findings that still apply to the written file. Typed credentials (password-, token-, key-, pin-, one-time-code-like fields, credential headers, values under credential-named request body keys — nested and numbers included —, a URL's user:password, credential-named or credential-shaped query values and path segments, credential-shaped literals such as a JWT or a long hex / base64 token) become `${secrets.X}`; the literal never reaches the YAML or its comments, whichever argument it was (`page.fill(selector, value)`). Names are matched as whole words (separators and camelCase split them): `password`, `passe`, `pin`, `otp`, `secret`, `api_key`, `access_token`, `X-CSRFToken`, `session_id` are credentials; `Compass`, `passengers`, `tokenizer`, `token_count`, `secretary`, `x-session-locale` and a body `signature` are not (a value's shape still decides). A hex path segment is a credential only after a credential-context segment (`/reset/<token>`, `/reset-password/<token>`, `/verify/<code>`), never as a commit SHA, a digest or a collection id (`/commit/<sha>`, `/api/tokens/<id>`); a request / trace id header (`x-request-id`, `traceparent`) is not judged by its hex shape. A number under a credential key becomes a `${secrets.X}` reference, which is always text: an approximation says the request now sends it as a string.",
      },
      {
        title: "cairn import playwright-trace <trace.zip>",
        body: "Reads a trace archive (`trace: 'on'` in the Playwright config, or `context.tracing.stop({ path })`): the structured action logs (`trace.trace`, `<n>-trace.trace`, `test.trace`) and the network logs; never screenshots, sources, DOM snapshots or response bodies. Output is a DRAFT: `open` for navigations (same-origin URLs become paths relative to the recorded baseURL, named in the header), `click` / `fill` / `type` / `press` / `select` / `check` / `uncheck` / `hover` / `focus` / `request` for the recorded actions, `wait` for waitForSelector / waitForTimeout. Locators come from the recorded selector (role+name, label, test id, text, css); a CSS-only selector is upgraded from the element the call log resolved (role+name from a button or link's text or aria-label, else the test-id attribute) — uniqueness is not verified. `test.step` titles become step ids. Outcomes are drafts (`DRAFT:` descriptions) from recorded `expect()` calls (visible, text, count, URL), the final main-frame URL (`url.endsWith` the path; id-like or token segments become `url.matches` with `[^/?#]+`), and same-origin fetch/XHR responses (method + path pattern with id-like segments cut, no query string, status; never bodies or headers). Failed recorded calls, raw keyboard input, evaluate, reload / back, cookies and routes become TODOs. Credentials: values typed into password-like fields (type=password, or a name/label/id such as password, token, otp, pin — whole words: `Compass heading` is not one), credential headers on API calls (not `x-session-locale`; a request / trace id header is not judged by its hex shape), values under credential-named JSON body keys (nested, numbers included — a number becomes a text reference, said in an approximation), a URL's user:password (cross-origin too), credential-named query and fragment values and credential-shaped values (JWT, long base64 tokens; a long hex value under any body key or header, and as a path segment only after a credential-context one such as `/reset-password/<token>` — a commit SHA or `/api/tokens/<id>` stays) are `${secrets.X}`; a final pass replaces every identified value wherever else it was recorded (an earlier call, TODO / approximation text, the YAML) when it is a strong credential (typed into a password field or under a credential's name) of 4+ characters, or any other of 8+ characters or credential-shaped — so a short word never rewrites URLs or titles; a step id derived from one becomes `<verb>_redacted`, never a placeholder; the header lists the names, never values. Bounds: a .trace / .network entry above 64 MB or more than 160 MB decompressed per archive is refused (exit 2); parent links that cycle terminate. Flags: `--out`, `--name`, `--intent` (default: the trace's test title), `--stdout`, `--force` (overwrite), `--allow-empty` (write a draft that maps nothing; default: refused, exit 1), `--format`.",
      },
      {
        title: "After the import",
        body: "Run `cairn spec lint` / `cairn spec verify` (the report's `check` already shows the findings): a draft that types secrets needs them listed under config `secrets.required` and provided by your secrets source; a cold-start warning means the spec still needs a login action, `session.resume` or preconditions to replay from a fresh browser. Draft outcomes assert what happened once, not what must hold: keep the ones that state the behavior, delete the rest, write the intent in a sentence. Then `cairn spec finish` → `cairn spec promote` (see `cairn docs author-flow`). MCP: `cairn_import_playwright { path, out?, test?, stdout?, force?, allowEmpty? }` and `cairn_import_playwright_trace { path, out?, name?, intent?, stdout?, force?, allowEmpty? }` return the same report as structuredContent, YAML included (`status: refused` with `isError` when nothing mapped).",
      },
    ],
    examples: [
      {
        title: "Import a test, then a recording",
        language: "bash",
        code: [
          "cairn import playwright e2e/tests/checkout.spec.ts --test 'pays with a card' --out flows/_drafts/checkout.yml --json",
          "cairn import playwright-trace test-results/checkout/trace.zip --intent 'A shopper pays with a card' --out flows/_drafts/checkout_recorded.yml",
          "cairn spec lint flows/_drafts/checkout.yml --fix",
          "cairn spec finish flows/_drafts/checkout.yml --env local",
        ].join("\n"),
      },
    ],
    relatedTopics: ["author-flow", "export", "authoring", "mcp"],
  },
};
