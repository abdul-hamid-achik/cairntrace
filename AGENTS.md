# AGENTS.md — Cairntrace

Guidance for any coding agent (Claude Code, Codex, Cursor, OpenCode, …) working
in this repository. Read this once at session start; everything you need to be
productive is here.

## Project

Cairntrace is a **local-first behavioral browser-spec layer** for coding agents.
Specs declare `intent + outcomes` (the contract) and `steps` (repairable hints).
Agents author + run + heal those specs via the `cairn` CLI or the MCP server.

- CLI binary: `./bin/cairn` (bun shebang launcher; no compile step needed for dev)
- MCP server: `cairn mcp` (stdio JSON-RPC) — preferred path for MCP-aware agents
- Plan: the product plan and design notes are private to the author and are
  not part of this repository.
- Examples: [`examples/`](./examples) — a tiny demo app + spec YAMLs
- Distribution: published to npm as **`@thelacanians/cairntrace`** (scoped,
  public) and to Homebrew as **`abdul-hamid-achik/tap/cairntrace`**. Tag
  pushes run `.github/workflows/npm-publish.yml` (verify + Trusted Publisher
  OIDC, no npm token) and `.github/workflows/homebrew-tap.yml` (bumps
  `Formula/cairntrace.rb` in `abdul-hamid-achik/homebrew-tap` via
  `HOMEBREW_TAP_TOKEN`). The published package is the same source layout:
  `bin/cairn` (bun shebang) + `src/` (no build step), so the CLI requires Bun
  `>=1.3.0` at runtime. Installing from source (clone + `bun install`) remains
  supported and equivalent.
- Versioning: SemVer tags are the release record. All `v1.x.y` tags are
  Cairntrace v1; do not rewrite old tags/releases just to make the visible
  numbering look cleaner.

## Docs site (Vercel)

The public site is VitePress at the repo root (`vercel.json`). Git auto-builds
**`main` only**. Feature branches do not create Preview deployments.
`ignoreCommand` skips the build unless `docs/`, lockfiles, or `vercel.json`
changed. Do not `vercel promote`; `main` is the docs release. npm and Homebrew
ship from SemVer tags — that is a separate pipeline from the site.

## Architecture in 60 seconds

```
spec YAML (intent + outcomes + steps)
        ↓ parseSpec (zod-validated, comment-preserving, ${baseUrl}/${env.X}/${vars.X} substituted)
        ↓ contract-hash check
Runner
        ↓ preconditions.wait gates → preconditions.commands → fixtures (ensure, needs first)
        ↓ cold-start? clearBrowserState  (when CI=true or --cold-start)
        ↓ session.resume? loadState <checkpoint>
        ↓ viewport? setViewport  (spec-level wins over environment config)
        ↓ each step:
              when: predicate?  → maybe skip
              ${requests|captures|runs|fixtures.<name>.…} placeholders spliced
              repeat: / if: / use.retry → nested steps (parentId, iteration, branch)
              wait.any|all|optional|app → runner-polled bounded probes
              request: → backend.request when available; bounded page-fetch fallback
                         (v2: until / retry / capture / matrix; use: login → env auth)
              set|check|uncheck|choose|form → in-page widget runtime, read back
              run: → host command / node script (own process group, hard deadline)
              expect: / capture: → one bounded backend.evaluate probe per attempt
              runStep(step) on the BrowserBackend  (AgentBrowserAdapter, PlaywrightAdapter or MockBrowserBackend)
              capture snapshot/screenshot per artifacts policy
        ↓ OutcomeEvaluator (text / notText / url / network / noFailedRequests / console / count /
                            table / value / mongo / temporal / http / xlsx / file / httpJson /
                            process / script; optional poll per outcome)
        ↓ teardown: (always: pass, fail, error, cancel) → run-scoped fixture teardown
        ↓ ArtifactWriter
              run.{json,yaml,md}  report.{html,json}
              agent_context.md  events.ndjson
              outcomes/<id>.md (+ .raw.json sidecar for script, data verifiers, polled outcomes)
              expects/  captures/  requests/  widgets/  evals/  fixtures.json
              snapshots/  screenshots/  console/  network/  spec.resolved.yml
```

The **CLI + artifact format are the agent interface.** Cairntrace ships no
per-agent code paths.

## Rules

- Keep the core runner deterministic and testable.
- Never write unredacted Authorization, Cookie, Set-Cookie, access tokens,
  refresh tokens, or passwords to artifacts.
- Keep spec parsing separate from backend execution.
- Keep headless CLI behavior working even if the TUI changes.
- Every agent-callable command must support `--format json|yaml|md` and have
  a stable JSON schema. No interactive prompts on `--json`/`--yaml` paths.
- Cohort A/B work uses `cairn run --label key=value` (stamped on run.json),
  `cairn run --before/--after <shell>` for domain hooks (path flips, warmers),
  and `cairn stats --group-by <key>` (pass rate + duration/metric percentiles +
  ASCII charts in md). Named test data belongs in the config `fixtures:`
  registry (`scope: seed` for data tied to the services seed); keep
  `services.seed.postCommands` for ensure scripts that are not fixtures. Do
  not invent per-product benchmark commands in the core CLI.
- Run artifacts include `report.html` and `report.json`. Keep report output
  redacted, self-contained, print-friendly, and themeable through
  `cairntrace.config.yml` `report.theme` / `report.colors`; do not add a
  separate report theme config file.
- Exit codes are meaningful: 0 success, 1 outcome-failure, 2 errored (also
  a command-line usage error, on every command: an unknown flag or command, a
  missing option value or argument, never 1; `--help` / `--version` exit 0),
  3 cold-start gate, 4 lint, 5 heal-no-progress, 6 contract-hash mismatch,
  7 refused by the environment policy (`cairn run` when every spec was
  refused, or any spec under `--strict-requires`; `cairn spec heal` on a
  refused spec), 8 a critical teardown failed (a `services.teardown` entry
  with `critical: true`, or the `services.provisioner` `down`), 9 dirty state after the run (config
  `run.verifyClean`). Precedence 8 > 9 > the run's own code; 4 also covers a
  run refused by the config `run:` policy (live run lock, failed preflight,
  dirty machine before the run), `cairn services up|down|restart` while a
  live run holds that lock, or by the engine pin (config
  `requires.cairntrace` not met, `runtimes.node` missing or out of range).
- Prefer small adapters over coupling core logic to agent-browser or Playwright.
- Never await a child process's `exit` event alone: Bun can lose it on Linux
  (the child stays `<defunct>`, the wait never ends, a deadline SIGKILL only
  hits the zombie). Spawn host commands through `runBoundedCommand`, or wrap
  the child in `watchChildExit` (`src/core/runner/childExit.ts`), which
  settles a lost exit from the process table and can be abandoned once a
  deadline killed the child.
- Do **not** introduce per-agent code paths. The CLI + MCP server + artifact
  format are the agent interface.
- Do **not** add a `scripts/` folder for ad-hoc dev tooling. Use a CLI
  subcommand, a test file, or a tmp file you delete afterward.
- Do **not** commit one-off markdown notes, scratch plans, or temporary feature
  checklists. Commit markdown only when it is maintained project documentation
  such as `README.md`, `AGENTS.md`, `CLAUDE.md`, docs pages, changelogs, or
  release notes.

## Rules for agents authoring specs

- Outcomes must use only the typed vocabulary (17 kinds): `text`, `notText`,
  `url`, `network`, `noFailedRequests`, `console`, `count`, `table`, `value`,
  `mongo`, `temporal`, `http`, `xlsx`, `file`, `httpJson`, `process`,
  `script`. Don't invent new verifier types. (`process` asserts on
  `--monitor` metrics; `httpJson` fetches app JSON with browser cookies;
  `http` calls a service from Node without cookies; `table` reads a rendered
  table; `value` asserts on a value the run already holds.)
- Backend state goes through the data verifiers, not script glue: `mongo`,
  `temporal` and `http` read named connections from the config
  `datasources:` block (per-environment overrides; `${secrets.X}`; `guard`;
  `mode: read-only`). Connection strings and credentials never reach the
  spec, the verifier or the artifacts — evidence names a source by
  `{ name, kind, transport, database, hosts }`. Their `assign` exposes the
  result as `${captures.<name>…}` to later outcomes. Matchers are shared
  (`equals`, `contains`, `matches`, `oneOf`, `atLeast`, `atMost`, `exists`,
  `empty`, `each`, `ignoreCase`) and their operands may splice runtime
  references.
- An eventual effect (a job, a worker, a webhook) is an outcome with
  `poll: { timeoutMs, everyMs, stableMs }` next to its verifier — never a
  sleep step or a hand-written polling loop. `stableMs` means "and it stays
  that way" (exactly one, absent). Errors waiting cannot fix (unknown
  datasource, guard refusal, unresolved reference, 401/403) fail at once;
  `failFastOnStepFailure` (default) skips the wait when a step already failed.
- Outcomes see only the final state. Assert mid-flow with an `expect` step
  (locator assertions or `expect.request`; a mismatch fails the step with
  `expects/*.json` evidence), and record a value with a `capture` step
  (`text` / `value` / `attribute` / `table` → `${captures.<assign>…}`), then
  compare it at the end with the `value` verifier. Don't write an outcome
  about the past, and don't use `eval` that throws for this.
- Side effects never live in outcomes. Provision with a `run:` step (shell or
  node, `args` as `$1…$n` — only in the object form — hard deadline, process
  group killed; `assign` → `${runs.<name>…}`), clean up in the spec
  `teardown:` (runs after pass, fail, error and cancel; a failure keeps the
  verdict unless `failRun: true`; `CAIRN_RUN_STATUS` in the child env).
- Test data a spec needs before its first step is a config fixture: list it
  under `fixtures:` (`name`, `name.reset`, `{use, with, write}`), splice
  `${fixtures.<name>.<key>}`. Kinds `exec` / `mongo` / `http` with
  `ensure` / `reset` / `verify` (read-only) / `teardown`, `scope: run | suite
  | seed`, ownership markers, and a dry-run on `shared` / `protected`
  environments unless `--allow-fixture-writes`. `cairn fixtures
  list|status|ensure|reset|teardown|sweep` manages them from a shell.
- Readiness is a gate, not a sleep: `preconditions.wait` names config
  `gates:` (http with status/json/auth, tcp, command, `all`/`any`, `stable`)
  or takes an inline `http(s)://` / `tcp://` target; `cairn wait <gate>`
  checks one from a shell. URL readiness (`webServer.url`, tmux
  `readyOn.url`) needs a 2xx/3xx answer unless `anyResponse: true`.
- The `script` escape hatch remains for checks no typed verifier expresses
  — and only after `value`, `table`, `http`, `mongo`, `temporal`, `network`
  `body`/`count` and `poll` were ruled out. Write node verifiers with the
  SDK (`import { defineVerifier, z } from "@thelacanians/cairntrace/verifier"`):
  a zod fixtures contract (`cairn verifier schema <file>`; lint flags unknown
  or missing keys), `ctx.poll`, `ctx.datasources` (credentials stay in the
  runner), `ctx.network.findOne`, `ctx.fail`. See `cairn docs scripts`.
- Semantic locators (`by: role|label|text`) are STRICT: accessible-name,
  whole-name, case-insensitive, visible-only matching; zero matches fail the
  step with diagnostics; multiple matches are an error unless the locator
  carries `nth:`. Use `exact: true` for case-sensitive matching. Targets are
  auto-scrolled into view. `near: <text>` keeps the match whose snapshot
  ancestor is nearest that copy (a card title next to three identical Opens).
  `by: testid` is first-class (`browser.testIdAttribute`, default
  `data-testid`). `wait.url` (`includes` / `equals` / `pattern`) polls the
  current page URL; do not eval `location.pathname` for that. Reusable
  actions may declare `vars:` defaults; spec/config/CLI vars override them.
- `wait` text/notText and outcome `text`/`notText` equals/contains checks
  normalize whitespace and match case-insensitively by default, so rendered
  CSS casing does not make source-cased assertions fail. Set
  `caseSensitive: true` to opt out. Regex `matches` remains raw and
  case-sensitive. Step `when: "text:…"` / `when: "notText:…"` gates share the
  same rendered-text normalization (whitespace-collapsed, case-insensitive), so
  a `when:` gate and an outcome on the same copy agree; `when: "urlContains:…"`
  / `urlMatches:…` stay raw (URLs are case- and whitespace-significant).
- For authenticated API calls use the typed `request` step (browser-session
  cookies included, `assign:` + `${requests.<name>.body.X}` splicing) — not a
  node-script verifier full of fetch glue. Playwright executes request steps
  out of page with browser-context cookie sharing and a 30000ms default timeout;
  under Bun, the cookie bridge runs in a subprocess so the parent can kill it
  at `timeoutMs` even if native fetch stalls. Backends without native request
  support use a bounded page-fetch fallback. Request v2 replaces fetch glue in
  evals: `credentials: omit` (anonymous; no cookies sent or kept), headers
  with `${requests.<name>.…}` (a captured bearer) or `${secrets.X}`,
  `until: { status?, json?, every?, timeoutMs? }` (poll instead of a sleep
  loop), `retry: { times, on: [5xx|network], delayMs? }`, `capture: { key:
  path }` (filters `$.tasks[?(@.title == "x")].id`, first match, a miss
  fails) → `${requests.<name>.captures.<key>}`, and `matrix: { key:
  [values] }` + `expectStatus` (one request per combination, `${matrix.…}`
  spliced; fails listing mismatches). Sign in with `use: login`: with no
  imported `login` action it runs config `environments.<env>.auth`
  (`alreadyAuthenticated?`, `login`, `after?` follow-ups, `hydrate?`) with
  provider secrets that never reach artifacts; it satisfies the cold-start
  contract. See `cairn docs steps` ("Request v2", "Environment Login").
- When a transient UI state must survive across interactions (a hover that
  reveals a popover you then click), use a `batch` step: ≥2 selector-only
  sub-steps run in one backend invocation (agent-browser `batch --bail`) so
  the state isn't lost between them. Semantic locators are not allowed inside
  `batch` — they need a snapshot round-trip that would defeat the single
  invocation; use `by: selector` there, or separate top-level steps. Batch
  clicks are paced by 100ms; checkboxes/radios/switches are re-queried across
  framework rerenders and verified in two stages: a ~500ms grace lets a slow
  async commit land before a single live-element recovery click, then a ~500ms
  settle confirms the result — if the control flipped back to its original
  value (a double-toggle from a late authored commit plus the recovery) the
  step fails loudly rather than passing a flipped-back state
  (`aria-checked="mixed"` is supported).
- Hydration-sensitive first interactions: prefer
  `open: { path, waitUntil: networkidle }` over a separate
  `wait: { load: … }` step.
- Top-level `fill` / `type` steps re-read the live control value after a short
  settle and retry up to three times when hydration wipes it. This is on by
  default; use sibling `verifyFill: false` only for masked/transformed controls
  whose DOM value intentionally differs from the authored text.
- Use `focus` when a custom control reveals options on focus without accepting
  a click. Use `wait: { value: { ...locator, equals: ... } }` for a bounded,
  exact live-value poll instead of an inline DOM `eval`.
- When a click can report success before its effect is delivered, use
  `click.until` with exactly one of `selectorGone`, `selector`, `text`, or
  `notText` plus optional `timeoutMs`. Cairntrace retries with backoff, at most
  four total clicks. Text conditions use the same normalized,
  case-insensitive semantics as waits.
- Loops, branches and retries are typed steps, never unrolled step ladders
  or `eval` loops: `repeat: { max (≤100), until?, steps, indexVar?, onMax? }`
  (`until` checked before each iteration and after the last; `onMax: fail`
  by default; `${repeat.index}` / `${repeat.iteration}` /
  `${repeat.<indexVar>}`), `if: { condition, then, else? }`, `when: { var,
  equals | in | exists }` (plain names read config/spec/use-site vars, dotted
  names read runtime values such as `waits.<name>.matched`),
  `wait: { any | all: [conditions], timeoutMs }`, `wait.optional: true` (+
  `assign` → `${waits.<name>.matched}`), and `use: { action, retry: { times,
  until?, delayMs? } }`. Conditions share the `when:` grammar and never wait.
  Nested steps keep stable ids (`<parent>.<n>`, `<parent>.then.<n>`);
  events and run.json results carry `parentId` / `iteration` / `branch`
  (post-order). Heal does not patch nested steps; teardown refuses control
  flow. See `cairn docs steps` ("Control Flow").
- Custom form controls are typed widget steps, never eval files that open a
  picker and hope: `set: { field | locator, value }`, `check` / `uncheck: {
  field, option? }`, `choose: { field, option }` and `form: { fields: { <key>:
  value | { value, optional?, dependsOn?, driver? } }, verify?, onFailure:
  dumpUnanswered }`. `field: <key>` resolves through config
  `browser.fieldRoot` (CSS templates with `{key}`; visible matches only).
  A driver is detected by `match(root)` (built-ins vue-multiselect,
  primevue-autocomplete, primevue-calendar, pills, radio-group,
  checkbox-group, native-select, native-input; project modules via
  `browser.widgets: [{ file }]`, which run in the page like eval files), the
  value is written in the page and READ BACK — the step fails with
  `widgets/<n>_<id>.json` evidence when it did not commit; a field already
  holding the value is left alone; `form` re-reads every field at the end.
  `click` takes `optional: true` (skipped when absent), `dispatch: true` (DOM
  click) and `fallback: dispatch` (pointer, else DOM click with `detail:
  pointer blocked by …`); `fill` takes `mode: set` (native setter, no
  focus/keydown) and `optional: true`. agent-browser uploads that the page
  cannot read are rebuilt in the page (`via: dataTransfer`). See `cairn docs
  widgets`.
- Workbooks are checked with the typed `xlsx` verifier, never a script that
  unzips XML or installs SheetJS: `sheet` (name, `{ match }`, 0-based index),
  `contains` (every sheet unless `sheet` is set), `headers: { labelRow,
  keyRow, strip, present, absent, labels: { key: label }, includesInOrder |
  withinListInOrder: <list | ${captures.x.headers}> }`, `rows: { afterKeyRow:
  { count | atLeast | atMost }, match: [{ column, matcher }] }`, `cells: [{
  ref, equals | matches | numFmt }]`, `validations: [{ column, type?,
  formulaMatches? }]`. A node verifier that still needs a workbook uses
  `ctx.xlsx(path)` (same parser: `columns()`, `numFmt()`, validation
  formulas). See `cairn docs verifiers` ("Workbooks (xlsx)").
- Eval helpers are not redeclared per file: a source (eval, browser
  `script` verifier, login `hydrate`) that mentions `__cairn` gets the page
  prelude (`sleep`, `visible`, `text`, `labelOf`, `nativeSet`, `fire`,
  `rows`, `waitFor`; namespaced, idempotent, never over a page-owned
  `window.__cairn`). App internals are read through config
  `browser.appHandle: { <name>: <page expression> }` as read-only
  `__cairn.app.<name>`, and waited on with `wait: { app: { path, equals |
  in | exists } }` (runner-polled; unknown handle fails at once). See `cairn
  docs steps` ("Page Prelude And App Handles").
- `eval` is the last resort: it does not heal, its export is opaque page
  JavaScript, and `cairn spec lint` flags evals that a typed step replaces
  (`eval-typed-equivalent`). Before writing one, map the pattern:

  | Eval pattern | Typed replacement |
  | --- | --- |
  | open a picker, type, click an option, hope it committed | `set` / `choose` / `form` (driver + read-back) |
  | click a radio or checkbox only when it is not already set | `choose` / `check` / `uncheck` (idempotent) |
  | click when present ("if present" helpers) | `click.optional: true`, or `wait.optional` + `assign` + `when` |
  | `el.click()` because a mask or overlay swallows the pointer | `click.fallback: dispatch` / `click.dispatch: true` |
  | native value setter + `input` / `change` events | `fill.mode: set` |
  | retry ladders, an unrolled N-step loop | `repeat` / `use: { action, retry }` |
  | branch on what the page shows | `if` / `when` (+ `wait.any`) |
  | `fetch` login, a bearer copied between calls, OTP | `use: login` + config `environments.<env>.auth`; request headers `${requests.login.…}` |
  | `fetch` in a sleep loop until a job finishes | `request.until` (or a verifier with `poll`) |
  | anonymous / authorization-boundary probes | `credentials: omit` + `matrix` + `expectStatus` |
  | read or poll a framework store | `browser.appHandle` + `wait.app` |
  | an eval that throws to assert | `expect` step, or `capture` + the `value` verifier |
  | unzip a downloaded workbook | the `xlsx` verifier (`ctx.xlsx` in a node verifier) |
  | helpers redeclared in every eval file | the `__cairn` prelude |

  What is left for `eval` is state setup or an internal-state read no typed
  step reaches; make it mention `__cairn` instead of redeclaring helpers.
- High-latency environments can set `environments.<name>.waitScale` (or
  override it with `CAIRN_WAIT_SCALE`) to multiply wait/settle budgets and the
  ~500ms network-idle quiet window without hardcoding remote-only budgets into
  shared actions.
- On agent-browser, the default post-click guard confirms same-tab link
  delivery from URL, document, or DOM evidence; it does not wait for
  network-idle. A positive click/spec `settleMs` or
  `browser.postClickSettleMs` explicitly adds network-idle settling.
  Playwright honors explicit click/spec values and otherwise keeps its native
  action/navigation waits. A resolved `settleMs: 0` skips the extra settle AND
  the link-delivery probe (the author is opting out of post-click waiting).
- Playwright `wait` steps and browser `evaluate` calls are hard-bounded
  (30000ms default, or the step/verifier timeout when supplied). Real Chromium
  runs use an external watchdog process that kills the browser at the deadline,
  so page navigation churn should fail the step instead of wedging the suite.
- Every spec must satisfy the **cold-start contract**: it must be replayable
  from a fresh browser session. Satisfy via one of:
  1. `imports: [actions/login_admin.yml]` + `steps: [{ use: login_admin }]`
  2. `session: { resume: <checkpoint-name> }` (capture with `cairn checkpoint capture-from-session` or `cairn login`)
  3. `preconditions: { commands: [{ run: "..." }] }`
  4. `coldStart: guest` for an intentionally public/sessionless flow
  5. `steps: [{ use: login }]` with config `environments.<env>.auth`
- New specs follow the author-flow recipe (`cairn docs author-flow`, MCP
  prompt `author-flow`): `cairn catalog --query` first (reuse actions and
  vars), a discovery session started by the project's login action
  (`setup: [{ use: … }]`, `snapshotMode: diff`), `cairn_discover_export` with
  `into` (convention export into the drafts dir: `use:` for existing actions,
  `${vars.X}` for config values, secrets as placeholders, step ids, waits,
  `postcondition.network`), then `cairn spec finish`. Drafts live in
  `authoring.draftsDir` (default `flows/_drafts`; the folder name must start
  with `_`); `cairn run <dir>` skips any folder or file starting with `_` and
  lists them under `--select-only`'s `skipped`. Promote (`cairn spec promote`)
  only after the human approved the draft — promotion requires a green finish
  of that exact content on a real backend (a `--mock` finish never touches the
  app and needs `--force`), and rolls back when the promoted copy would point
  at a missing file.
- Before declaring a spec complete, run `cairn spec finish <spec> --json`
  (MCP `cairn_spec_finish`; add `--config <path>` / `--env` as for a run): it
  lints (`cairn spec lint --fix` applies the safe fixes — quoting `#`
  selectors, step ids), runs the spec once from a cold browser through the
  `cairn run` engine and stamps the contract hash when green. Anything but
  `status: green` means the spec isn't done. With a dev server you already
  run, add `--no-web-server` (MCP `noWebServer: true`); a cold start otherwise
  boots the config `webServer` fresh and refuses a busy port. (`cairn spec verify --json` +
  `cairn run --cold-start --json` remain the manual equivalent.)
  `cairn spec verify` also audits placeholder references statically: an
  `${env.X}` without a `:-default` that no supplied source (process.env,
  config `secrets.required`, or the `CAIRN_*` namespace) covers, or a
  `${secrets.X}` missing from `secrets.required`, fails verify with exit 4 —
  both would otherwise substitute to an empty string mid-run. Imported
  actions are audited too. MCP `cairn_spec_verify` runs the same code path.
- Environment names are checked: when a config exists, an explicit `--env`
  (MCP `env`) that `environments:` does not define is a config error (exit 4
  on run/verify/heal/discover/snapshot; `cairn run` stops before any secret,
  service, hook or spec and still prints an errored JSON/YAML document)
  instead of a run with no baseUrl/vars. Defaults (a spec's `environment:`,
  `defaultEnvironment`, the `local` fallback) that the config lacks only warn
  (once per `cairn run` invocation, on stderr), so one stale spec cannot abort
  a batch.
- A config value lives once, never copied per environment: top-level `vars:`
  (every environment; its own `vars` win by name), `environments.<n>.extends:
  <env>` (deep merge, chains; cycles/unknown names are errors),
  `environments.<n>: { alias: <target> }` (the same environment under another
  name: canonicalized to the target where `--env` is parsed, so suites,
  `requires.env`, policy, state keys, locks and `CAIRN_ENV` see the target;
  `envAlias` in run.json / invocation.json; no other key, no chains, never
  extended or named by a suite), vars built
  from vars (`apiUrl: "${vars.host}/api"`, resolved once per environment;
  cycles are errors; a reference to a var the config does not define is a
  warning, resolved at run time from `--var` / spec `vars:`; a `${vars.X}`
  inside an env or secret value stays inert), typed vars (lists / objects:
  an unquoted whole `key: ${vars.x}` keeps the structure — script verifier
  `fixtures:`, `ctx.vars`, fixture `with:` — strings get compact JSON;
  `${vars.x.key}` reads inside), and `include: [paths or globs]` for shared
  `vars` / `fixtures` / `gates` / `datasources` / `suites` files (later wins,
  the including file wins, overrides are findings). Environments with
  different var sets split into files with `environments.<n>.include:
  [config/vars/<n>.yml]` (files hold `vars:` / `include:` only; precedence:
  top-level vars < extended env < the env's included files < its own inline
  vars) — never promote per-environment vars to the top level, that leaks
  the names into every environment and silences the unresolved-var check of
  `cairn spec verify`. Before adding or renaming
  a var, ask `cairn config vars [--env] [--used-by <spec>] --json` (MCP
  `cairn_config_vars`) where it is defined and who uses it; `cairn config
  validate` warns about dead vars. See `cairn docs services` ("Config
  Composition").
- Discovery records URLs as requested: `${secrets.X}` / `${env.X}` /
  `${vars.X}` placeholders and relative paths stay in the exported spec; the
  browser gets the resolved URL, and returned URLs are redacted.
- Paths: `${file.dir}` (alias `${project.root}`) is the directory of the
  file being parsed — inside an imported action it is the action's directory.
  Relative step files (`upload.path`, `eval.file`, `transform.file` /
  `input`, eval `args.filePath` / `fixtureFiles`) resolve against the file
  that declares the step, so an action's fixtures live next to the action
  (the old spec-relative location still works with a deprecation warning).
  Use `${config.dir}` (the directory of the resolved cairntrace.config.yml —
  an explicit `--config`, or the one found above the spec; cwd without a
  config) for fixtures shared across folders; never hardcode absolute paths.
- Environment policy: a spec declares where it may run with
  `requires: { env: [local, { dev: { optIn: VAR } }], mutates: true }`;
  environments declare `policy: { trait, mutations }`. A refused spec never
  starts anything and has no run directory (its result carries
  `synthetic: true`; do not open its `runDir`). `cairn spec verify --json`
  lists the environments a spec may run in.
- Do **not** edit `intent` or `outcomes` of an existing spec without surfacing
  a diff to the user. The `contractHash:` stamp will refuse the write if
  changed without `cairn spec verify --stamp`.
- Each outcome's evidence file must fit the §13b shape — if your verifier
  produces more, split outcomes or push detail to an `outcomes/<id>.raw.json`
  sidecar.
- On first contact, run `cairn explain --json` (CLI) or call the
  `cairn_explain` MCP tool to get the current surface and step/verifier
  vocabulary.
  For focused authoring guidance, use `cairn docs <topic> --json` or MCP
  `cairn_docs` (`authoring`, `author-flow`, `catalog`, `steps`, `verifiers`,
  `downloads`, `scripts`, `services`, `fixtures`, `artifacts`, `mcp`,
  `backends`, `discovery`, `export`, `import`, `brief`, `widgets`) — don't rely on
  training-data knowledge of the CLI.
  Before authoring, ask `cairn catalog --query "<words>" --json` (MCP
  `cairn_catalog`) what the project already has. For Playwright handoff use
  `cairn export playwright` / MCP `cairn_export_playwright` (see `export`).
  Host commands are explicit: `--preconditions inline|global|skip|manifest`
  (`inline`: bounded helper, `run:` steps and `teardown:` export; `global`:
  gates, preconditions and fixtures once in `global-setup` via the cairn CLI;
  `manifest`: commands listed in `.cairn-export.json`), and node / http
  verifiers follow `--verifiers keep|gate|drop` (`gate` reports skipped, never
  passed, when the env is missing; `--gate-env` names it). `value`, `http`,
  `network` body/count/assign, `file`, `xlsx` (`--project`), `expect.request`
  and `transform` export too, judged by the runner's own modules (generated
  into `lib/`, drift-tested). `${env.X:-d}` is read at test run time; no env
  value set while exporting reaches generated code, the manifest or a report:
  the config is loaded late-bound too (config vars, `baseUrl`, `auth:` / map
  `apiLogin`, datasources), a typed config field the export emits that only an
  env value could fill is refused, and host-command errors scrub secret values
  before the output tail is cut. `noFailedRequests` is judged by the runner's
  `judgeNoFailedRequests` (network errors included). `cairn docs export` has the
  fidelity and risk list — read `coverage` before handing an export off.
  `cairn export playwright --verify <dir>` / MCP `cairn_export_verify` proves
  an export faithful: static gates (sentinels, target tsc, the host's eslint,
  `playwright test --list`, freshness; skipped is never a pass),
  `--differential` (needs the app up: `cairn run --run-token T` and the
  exported test with `CAIRN_RUN_TOKEN=T`, both sides run, so specs must be
  idempotent) and `--mutate` (an inverted assertion must fail; outcome steps
  read from the TypeScript syntax tree, so host formatting is irrelevant). Report
  `urn:cairntrace.dev:export-verify:v1`, also in `.cairn-export-verify.json` and
  the manifest's `verify`; exit 0 pass / 1 failed / 2 environment error / 3
  inconclusive (nothing proven: neither tsc nor `playwright --list` ran, or the
  differential / mutation proved nothing) — never report 3 as a pass.
  On a multi-project host config every Playwright run of the verify uses one
  project (`--project`; its setup dependencies still run): `--verify-project`
  / MCP `verifyProject`, else the manifest's `verifyProject` (export flag or
  `export.targets.<n>.verifyProject`), else the first discovering project
  that runs Chromium (report `playwrightProject`). The lint gate never hands
  eslint the vendored runtime; a gated export that ended skipped is still
  compared on what it judged (a disagreement is a mismatch).
  Into an existing Playwright tree, `--into <dir> --host-config <playwright.config>`
  adapts the output to it (the config, tsconfig and package.json are read
  statically, never executed; options resolve like Playwright — a project's
  value over the top level, only the projects that discover the tests — and an
  option it cannot read is named in `host.unread` / `host.notes`, never
  replaced by a default): CommonJS `__dirname` vs ESM `import.meta.url`,
  no `test.setTimeout` the host's timeout already covers (unread: every test
  sets its own budget), `testid` locators against the host's
  `testIdAttribute` (unread: explicit attribute selectors), page evals
  (`eval`, `wait: { app }`, browser scripts) refused unless the host sets
  `bypassCSP` (or `--allow-eval-without-bypass`), tests placed and named for
  the host's `testDir` / `testMatch` (unread: refused), tsconfig path aliases,
  ordered and used imports only, camelCase identifiers, the host's local
  prettier. It RUNS the host's own local tools (prettier with its JavaScript
  config and plugins; under `--verify` eslint, tsc, `playwright --list`),
  looked up only up to the host's boundary (`.git`, else the outermost package
  root below home). Named
  profiles live in the config's `export.targets.<name>` (`--target <name>`,
  flags override; `cairn config validate` checks them). `--map <export.map.yml>`
  (profile `mapFile`, MCP `mapFile`; with `--into` / `--project`) binds cairn
  actions to the host's own constructs instead of inlining their steps: a
  `fixture` mapping destructures the host fixture in the test signature (vars map
  to `test.use` options or are checked as constants), a `method` mapping calls a
  host page object (`new OrdersPage(page).openOrder(arg)`, args from the action's
  vars), an `apiLogin` writes a request-only login as a storageState (credentials
  `process.env` at run time, never in generated code, manifest or reports);
  unmapped actions become generated page objects over the map's `basePage`
  (`lib/pages`), and `strict: true` makes an unmapped action an error. The
  manifest records the map's digest (`--check` / `--verify` regenerate with it;
  `--verify` typechecks against the host's real types). `--max-eval-ratio <0..1>`
  refuses an export of a spec that is mostly page `eval`: per spec, the rest is
  written, exit 1. `--strict-locators` (profile `strictLocators`) emits no
  `.first()`, so an ambiguous locator fails the exported test like
  `cairn run --backend playwright` does; the default keeps `.first()`
  (first-match, like agent-browser), the manifest records the mode and
  `--verify --differential` names it. `cairn docs export` has the table.
  Which to reach for: a standalone file or `--project` when nothing exists on
  the other side; `--into --host-config` when handing specs to a Playwright
  tree someone else owns (it makes the output pass that tree's tsc / eslint /
  prettier); `--map` only when the host already has fixtures or page objects
  the generated code should call instead of inlining (start without it, read
  `mapped` / `unmapped` in the report, add mappings for what matters);
  `export.targets` once the same flags are typed twice. Run `--verify` before
  claiming an export works (static gates are cheap); add `--differential
  --mutate` when a CI copy will gate merges, with the app up and the specs
  idempotent. Exit 3 means nothing was proven: install the target's local
  `tsc` / Playwright or fix the setup, do not report it as green.
  An existing Playwright test or trace becomes a draft spec with
  `cairn import playwright <file.spec.ts>` / `cairn import playwright-trace
  <trace.zip>` (MCP `cairn_import_playwright` / `cairn_import_playwright_trace`;
  `cairn docs import`): catalog → discover or import → `cairn spec finish` →
  `cairn spec promote`. The test importer is a TypeScript AST walk (the
  project's own `typescript` when it has the JavaScript API, else cairntrace's
  — `typescript` is a runtime dependency; never executes the file) that
  inlines `test.step`, `beforeEach`, page-object methods (through barrels),
  helpers, the selector-first page API and `test.extend` fixtures it can read;
  the report has `coverage { mapped, approximated, unmapped }`, `warnings`,
  TODOs with reasons, approximations and the lint/verify findings still open
  (`check`). The trace importer reads the action and network logs only and
  writes DRAFT outcomes (expects, final URL, API method + path + status). Both
  refuse to overwrite a file (`--force`) and to write a draft that maps nothing
  (exit 1, `--allow-empty`). Neither ever writes a credential it can identify
  as a literal — typed secrets, credential headers, credential-named body
  values (nested), URL user:password, credential query / fragment values,
  credential-shaped values (JWTs, long tokens, token path segments) are
  `${secrets.X}`, and every identified value is scrubbed from the rest of
  the draft, its ids, TODOs and the report. Names match as whole words
  (`importCommon.nameWords`: `Compass`, `tokenizer`, `token_count`,
  `x-session-locale` are not credentials); a hex path segment needs a
  credential-context segment before it; the final pass skips short weak
  values (strong ≥ 4 chars, others ≥ 8 or credential-shaped). The benign
  trace test (`benignTraceEntries`) guards against false positives, the
  hostile ones against leaks: change both together. Keep that invariant when you touch
  `src/core/importers/`; the typed values in tests must be built at runtime
  (`src/testing/traceZip.ts` `hostileTraceEntries` is the regression input).
  For a fragile environment where locators will not replay, use
  `cairn export brief` / MCP `cairn_export_brief` and the live try-then-ask
  session `cairn_accompany_*` (see `brief`). The harness chooses WHERE;
  fill values and outcomes stay authored.

## Services Lifecycle

The `services:` block in `cairntrace.config.yml` lets `cairn run` own the
full multi-service environment lifecycle: docker, conditional data seeding,
tmux session management, and teardown — all config-driven, started once
before the spec pool and stopped after the last spec.

```yaml
services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
    readinessCheck: "curl -sf http://localhost:27017"
    healthcheck:
      command: "curl -sf http://localhost:9200/_cluster/health | grep -q green"
      intervalSeconds: 15
      retries: 5
  seed:
    command: "yarn demo-import"
    ttlSeconds: 21600
    freshnessCheck: "mongosh --quiet --eval 'db.count()' mongodb://localhost:27017/db"
    # always run after seed decision (even when skipped as fresh)
    postCommands:
      - "mongosh mongodb://localhost:27017/db --quiet tools/ensure-fixture.js"
  tmux:
    session: myapp
    reuseExisting: true
    options:
      - { key: mouse, value: "on" }
    env:
      NODE_ENV: development
    windows:
      - name: web
        cwd: web-app
        command: "yarn serve"
        readyOn: { url: http://localhost:8080 }
        healthcheck:
          command: "curl -sf http://localhost:8080/healthz"
          intervalSeconds: 20
          retries: 3
  artifacts:
    when: on-failure       # bounded, redacted service logs in each run dir
teardown:
  - "tmux kill-session -t myapp"
  - "docker compose down"
```

Key rules:
- Seed freshness is tracked at `~/.cairntrace/services/<project>.seed.json`
  with a three-layer check (fingerprint + TTL + optional data-level command).
- `--no-services` skips the entire lifecycle.
- On SIGINT/SIGTERM the synchronous teardown first waits up to
  `CAIRN_SERVICES_SIGNAL_GRACE_MS` (default 5000) for a still-running boot
  command to exit (no extra signal: a second one forces a provisioner's
  graceful cancel), then runs the teardown commands not yet run, each capped at
  `CAIRN_SERVICES_SIGNAL_TEARDOWN_TIMEOUT_MS` (default 10000). Teardown
  commands run detached (own process group and session, no terminal, output
  in a private temp file), so the Ctrl-C that stops cairn does not kill a
  provisioner's `down` halfway. The signal path waits up to the same cap for
  the one already running and never starts a second copy while it is alive;
  one that is gone runs again. Every step is a `services.teardown.signal`
  journal event, with output in `logs/services-teardown.log`.
- Over MCP, config services (and their teardown) start only when the server
  runs as `cairn mcp --allow-services` (or `CAIRN_MCP_ALLOW_SERVICES=1`).
  Without it `cairn_run` / `cairn_spec_finish` / `cairn_audit` that would
  start them fail with exit 4 before anything starts (`noServices`,
  `reuseServices` and `servicesDryRun` pass), and `cairn_services_up` /
  `cairn_services_down` / `cairn_services_restart` refuse (`cairn_services_logs`
  is read-only and not gated). The CLI is not gated.
- `secrets.provider: tvault` injects vault secrets into the seed command's env.
  The `tvault:` block supports two modes: `project` (direct) or `group` + `env`
  (inheritance — resolves missing keys from the base environment via tvault's
  env-group feature).
- `cairn config validate --json` validates the config file (zod schema +
  cross-field `.refine()` rules: unique window names, readyOn constraints,
  tvault provider requires tvault block with either `project` or `group`+`env`,
  known gate names, fixture `needs`, datasource entries after each
  environment's override is merged) and its composition (missing include,
  include / extends / var-reference cycles, unknown extends target — errors;
  dead vars, empty include globs, var references left for run time and an
  authored `${vars.X}` in a config field that stays literal
  (`literal-var-ref`: `environments.<n>.baseUrl`, `webServer`, a metric
  `command` …; it expands only in specs, actions, fixtures, gates,
  datasources, suites, http metrics and env `auth`), and a suite whose
  `requires.env` admits an environment with no `env.<n>` block while a
  sibling admitted one has one (`suite-env-fallback`) — warnings;
  include overrides — `findings`).
- **Readiness gates:** `services.docker.ready`, tmux `windows[].readyOn.gate`
  (in addition to url/text) and `windows[].after` (boot a window only once its
  gates pass), and `webServer.ready` name entries of the top-level `gates:`
  registry. Gate waits emit `gate.started` / `gate.attempt` / `gate.passed` /
  `gate.failed` into the invocation journal. `readyOn.url` and
  `webServer.url` need a 2xx/3xx answer (`anyResponse: true` restores the old
  any-answer rule).
- Session artifacts (tmux panes, docker logs, seed output) belong in
  `services.artifacts` (bounded, redacted, inside each run directory, so
  `stash.autoStash` carries them). `services.stash` is deprecated
  (`cairn config validate` and the services stop warn).
- **tmux session reuse is the default** (decoupled from `--cold-start`, which
  is about the browser profile, not the dev servers). A running tmux session
  + its windows are reused across runs so dev servers aren't rebuilt each
  time. On reuse, cairn heals the session: missing windows are created, and
  panes sitting at an idle shell (command never started, or process died) are
  re-launched — panes already running a non-shell process are left alone. If
  docker was freshly started this run (not reused), the whole tmux session is
  recreated so app processes reconnect to the new containers instead of holding
  dead mongo/redis/postgres connections. Commands are sent only after the
  interactive shell settles (avoids direnv/zsh swallowing `send-keys`), and pane
  history is cleared first so `readyOn` text cannot match residual scrollback.
  At end-of-run the session is LEFT ALIVE so the next run reuses it — cairn
  skips any `teardown` command that kills the managed session **and** skips
  `docker compose down` / `docker-compose down` (live tmux services still need
  that infra). Set `tmux.reuseExisting: false` to force a fresh session (kills
  + recreates; full teardown including docker down runs).
- `readyTimeoutMs: 0` (docker/tmux) and `timeoutMs: 0` (seed) wait
  **indefinitely** instead of timing out — use for slow first-up image builds
  or many containers. In interactive (TTY, `--format md`) runs, the docker
  phase's `compose up` status lines are collapsed — buffered while the
  command runs and cleared when the phase settles (ready/reused/failed); a
  failing phase still surfaces its output tail through the error, and the
  full output is kept in the run's service-log artifact. Seed output is
  buffered, redacted, and routed to the detail channel (DEBUG — shown with
  --verbose, hidden by default);
  a failing seed surfaces its tail through the error, and the full output is
  kept in the run's service-log artifact. Each not-yet-ready
  tmux window's pane tail is streamed every few seconds so a stuck window
  shows its startup logs/errors instead of a blind wait. Non-interactive/CI
  runs stay quiet (the logger's default warn level suppresses info).
- **Per-environment overrides:** `environments.<name>` can carry `services:`
  and `secrets:` blocks. `services: false` disables all services for that env
  (e.g. `dev`/`test` where the app is already deployed remotely). A partial
  `services:` block deep-merges over the top-level one; without a top-level
  block it stands alone (only that environment boots services, its
  provisioner included). Every reader resolves the same effective block
  (`resolveEffectiveServices` in `src/core/config/runtimeContext.ts`): the
  run engine, `services up|down|restart|logs|status`, the dry run,
  `verifyClean`, catalog, `config validate` and Studio — never read
  `config.services` alone. Inside a partial block,
  `tmux: false` drops only the inherited local tmux windows while keeping the
  docker and seed phases. An env-level `secrets:` block replaces the top-level
  one entirely. This replaces the need for `--no-services` or
  `--services-dry-run` when running against remote envs.

## Replace your Taskfile / wrapper scripts with config

When a project drives `cairn run` through a Taskfile, a `Makefile` or a
`with-cairn.sh`, move what the wrapper does into `cairntrace.config.yml`.
The run engine enforces it for the CLI and for MCP `cairn_run` alike, so a bare
`cairn run` is as safe as the wrapper was.

| The wrapper did | Config |
| --- | --- |
| `case $SUITE in …` picks specs | `suites:` + `cairn run --suite <name>` |
| copies the same vars into every environment | top-level `vars:`, `environments.<n>.extends`, `include:`, `environments.<n>.include:` |
| refuses to start twice, checks a quota or a secret first | `run.lock`, `run.preflight` |
| warms a cache before, collects diagnostics after | suite `before` / `after`, `run.finally` |
| greps for leftover browsers, containers or tmux sessions | `run.verifyClean`, `cairn doctor --orphans` |
| always destroys the billable thing, even on Ctrl-C | `services.provisioner.down`, `services.teardown` `critical: true` |
| restarts one service, tails its output | `cairn services restart` / `logs` |
| curls a number before and after | `metrics:` probes → `cairn stats --metric <name>.delta` |
| checks the tool versions | `requires: { cairntrace }`, `runtimes.node` |
| exports env per suite (`MODE=x task …`) | `suites.<n>.processEnv` / `env.<e>.processEnv` |
| stamps a cohort / round label | `suites.<n>.labels`, `cairn stats --group-by` / `--invocation` |
| bails, except in one environment | `suites.<n>.bail`, `env.<e>.bail`, `--no-bail` |
| skips a seed step only in one environment | `suites.<n>.env.<e>.seed.postCommands.skip` |
| runs a check only for one suite | `run.preflight[].when: { suite, env }` |
| refuses `task sink` while a suite runs | nothing: `services down` / `up` / `restart` respect `run.lock` |
| owns a billable box in one environment only | `environments.<e>.services.provisioner` (no top-level `services:` needed) |
| ssh-es to another machine, runs `cairn` there, copies the results back | `environments.<e>.runner` (a delegated runner; see "Delegated runners") |

```yaml
version: 1
project: shop
vars: { region: eu }
environments:
  local: { baseUrl: "http://localhost:3000" }
  staging: { extends: local, baseUrl: "https://staging.shop.example", vars: { region: us } }
run:
  lock: true
  preflight:
    - { secret: API_TOKEN }
    - { command: ./tools/check-quota.sh, expectExit: 0, timeout: 30s }
  verifyClean: [browsers]
suites:
  smoke: { specs: [flows/smoke], bail: true, after: ["./tools/collect-logs.sh"] }
metrics:
  - { name: queue_depth, command: ./tools/queue-depth.sh, parse: { json: $.depth } }
```

`cairn run --suite smoke --env staging` replaces `task e2e:smoke ENV=staging`;
`--services-dry-run` prints the whole plan (provisioner, tunnels, files, seed
post-commands and the suite's skips, the secret NAMES a run would inject —
the vault is never called) without running anything, and `cairn docs
run-policy` is this table as a docs topic.
Exit codes tell a script what happened without parsing output: 4 refused before
anything started, 8 a critical teardown failed, 9 a dirty machine afterwards.
Do not copy the shell into config; declare the intent. The sections below have
the details, and `examples/cairntrace.config.yml` is a working config with a
lock, a preflight, a suite, `extends` and a metrics probe.

## Run policy (config `run:`)

What a wrapper script (a Taskfile, a `with-cairn.sh`, an ownership check, a
bail-fast watcher) used to do around `cairn run` is config, enforced by the
shared run engine — so `cairn run` and MCP `cairn_run` are equally safe:

```yaml
run:
  lock: { scope: config, staleAfterPidDead: true }   # or lock: true
  preflight:
    - { json: docker/posture.json, assert: ".engine.mode == \"durable\" and .engine.workers >= 2" }
    - { secret: DEPLOY_TOKEN }
    - { command: "bun tools/check-quota.ts", expectExit: 0, timeout: 30s }
    - { gate: stack-reachable }
  verifyClean: [browsers, tmux, docker-project]
  finally: ["bun tools/collect-diagnostics.ts"]
services:
  teardown:
    - { run: "bun tools/destroy-compute.ts", critical: true, timeout: 10m, onSignal: wait }
```

- Order: config + secrets → lock → `preflight` → `verifyClean` (before) →
  services/webServer → specs → teardown → critical-teardown verdict →
  `finally` → `verifyClean` (after) → lock released. A refusal in the first
  three is exit 4 and nothing of cairn's started. One policy guards one
  config: specs from several configs where any declares `run:` (or one
  config whose environments give them different policies) are refused (exit
  4, naming each config with a spec that resolves to it: "run each config's
  specs in an invocation of their own, or pass --config <path>"; `--suite` is
  no remedy, a suite's specs still load their nearest config), and so is a
  `run:` whose config does not load — never "no policy". `runtimes.node`
  follows the same rule.
- `lock` is `~/.cairntrace/locks/<label>.<hash>.run.lock.json` (pid, start
  time, redacted argv with `--var` keys only, invocation, env), taken atomically (temp file hard-linked
  into place) and released on every exit path, signals included. A live foreign
  owner refuses (exit 4, names pid/age/command); a dead owner (or a recycled
  pid) is reclaimed with a warning unless `staleAfterPidDead: false`.
  `cairn services up|down|restart` (CLI + MCP, `src/cli/commands/services/runLock.ts`)
  refuse with exit 4 while a live owner holds a lock the config declares (any
  scope, any environment), naming it in `runLock`, and otherwise hold the
  lock for their duration (`command: "services down"` in the file; the
  refusal text says "another cairn services down holds"). The run exports
  `CAIRN_RUN_LOCK` to its processes: a services command started by the owner
  runs under its lock (`nested`). No `--force`: stop the owner instead.
- `preflight` stops at the first failure and names it; `assert` is the small
  language in `src/core/runPolicy/expression.ts` (paths, `== != < <= > >=`,
  `in [..]`, `exists`, `and`/`or`/`not`, parentheses): a real parser,
  never `eval`, validated by `cairn config validate`. Secrets are checked for
  presence only; every message is redacted. `when: { suite, env }` limits a
  check (as on seed post-commands); a skipped one is noted, failures keep the
  original index.
- `verifyClean` only counts cairn-owned or this-project resources: browsers
  named by the owned-session ledger (`~/.cairntrace/sessions-ledger/`, a pid
  only while it is still the process cairn learnt: same `ps` start time and
  command) or agent-browser daemons of cairn run sessions (`<session>.pid` in
  agent-browser's state dir) working inside the project — never discovery or
  user sessions, argv substrings or cairn's ancestors — the services tmux
  session, containers of the compose project (a Docker daemon that is not
  running is clean, with a warning). It reports survivors (exit 9) and kills
  nothing; under `--reuse-services` only `browsers` is checked.
- `finally` commands are non-fatal and see `CAIRN_EXIT_CODE` /
  `CAIRN_INVOCATION_DIR`. A critical `services.teardown` entry that fails or
  times out is exit 8 (above every verdict); `onSignal: wait` makes the signal
  path wait for it up to its timeout.
- Signal path (`ResourceScope.terminateSync`, synchronous): reporters → every
  still-running bounded command (preconditions, hooks, preflight, `run:` steps;
  `killLiveCommandsSync`) → browsers → suite `after` hooks (services up) →
  webServer/services → `run.finally` → lock released. The hooks run with
  `CAIRN_EXIT_CODE` 130/143, each bounded by `CAIRN_SIGNAL_HOOK_TIMEOUT_MS`
  (default 10s): the suite `after` hooks together by three times that, and
  `run.finally` by three times that again after the services teardown,
  whose own caps (a provisioner's `down` included) never depend on either.
  A one-line notice (`cleanup in progress (critical teardown pending); …
  send SIGKILL to force`) precedes the slow part. The CLI handler
  (`src/cli/cleanup.ts`) keeps persistent SIGINT/SIGTERM listeners and adds
  SIGHUP once the cleanup starts: a second Ctrl-C while the synchronous
  cleanup runs is held (no JS runs until it returns), never the default
  action that would kill cairn halfway; it always exits 130/143 after.
  `cairn mcp` keeps its own listeners during `terminateAllSync` and, by
  design, survives the signal (it exits on stdin EOF or a second SIGTERM).
- With a `run:` policy or a critical teardown the documents (`--json`, md,
  MCP `structuredContent`, `cairn_run_status.document`) are held until the
  verdict: top-level `exitCode` = the process exit code, a passed spec reads
  `status: errored` (`failure.phase: invocation`), `invocationOutcome`
  `{exitCode, specsExitCode, error, runPolicy}` explains it; run.json on disk
  keeps the spec's own result. A signal before the verdict hands the
  finished iterations' documents over synchronously (`onDocumentSync`;
  the CLI writes stdout with a bounded `writeSync`) with
  `invocationOutcome.exitCode` 130/143.
- `cairn run --bail` (MCP `bail`) stops scheduling after the first failed or
  errored spec: the rest are `BatchRunResult.skipped[]` (reason `bailed`),
  never results; running specs finish, teardown runs, exit = the usual
  precedence over the specs that ran (never lower than without `--bail`).
- `cairn doctor --orphans [--kill] [--yes] [--only <session|pid,...>] [--json]`
  lists (and ends) cairn-owned browser survivors whose invocation is gone; only
  ledger-named processes that are still the learnt process (start time +
  command) and still look like a browser cairn launches are touched, each
  re-checked right before the kill; entries whose owner is gone 7 days expire.
  Studio passes the confirmed set as `--only`.
- Journal events (additive `events.v1`, invocation journal only):
  `run.lock.acquired|reclaimed|refused|released`, `preflight.started|passed|failed`,
  `cleanliness.clean|dirty`, `finally.started|finished`, `invocation.bailed`;
  `invocation.json` `summary.runPolicy` / `summary.skipped`. Goldens:
  `src/core/schema/__fixtures__/events/run-policy-*.ndjson`. See `cairn docs
  services` ("Run Policy").

## Service operations, seed transaction, engine pin (config `services:`, `requires:`)

All optional and additive; a config that uses none behaves as before. Phase
order: provisioner → tunnels → docker → files → seed → tmux; teardown runs
the other way (supervision stops, teardown commands, tmux kill, tunnels stop,
provisioner `down`). See `cairn docs services` and `docs/services.md`.

- `cairn services restart <window...> [--stop-timeout] [--ready-timeout]`:
  Ctrl-C, wait for the pane's process to exit (never a hard kill), clear
  history, print a `@@cairn-restart:<id>@@` marker, resend the window's
  command, wait for `readyOn` of the new generation (text only below the
  marker). Refuses (exit 4, nothing touched) a window the config does not own,
  a missing session, a window missing from it, or a session a live run
  supervises (its `tmux-supervisor.*.json` marker). Every tmux call uses exact
  targets (`src/core/runner/tmuxTarget.ts`: `=session`, `=session:`,
  `=session:=window`) and reads panes with `list-panes` (never
  `display-message`, which answers for another pane); a pane counts as idle
  only when its shell is also the foreground process group. `cairn services logs <window>
  [--since-restart] [--wait <regex> --timeout] [--follow]` reads the pane
  (`capture-pane -J`, redacted). There is deliberately no `services exec`:
  typed keys race the service and report no exit status; use a `run:` step,
  `teardown`/`finally`, a fixture, `services.files` or `restart`.
- Windows: `restart: {policy: on-exit|never, backoff, max}` and
  `healthcheck.onUnhealthy: restart|warn` are supervised by cairn only while a
  run is active (`cairn services up` exits after the boot: no supervision).
  Sessions are created 250x50 (`tmux.columns`/`rows`).
- `services.tunnels`: own process group, state + owner in
  `~/.cairntrace/services/<project>.<env>.<config hash>.tunnel.<name>.json`
  (`tunnelStateKey`), `ready` gate, `restart: always` + `giveUpAfter`, stopped
  on every exit path (and by `services down`); a copy left by a crashed run is
  stopped first, one a live cairn process owns never is; only a running
  tunnel's own process (lstart checked) is signalled.
- `services.provisioner`: `up`, mandatory `down` (critical, `onSignal: wait`
  by default; registered before `up` runs, so it runs after a failed boot and
  on signals; a failed `down` is exit 8, `services down` too), `exports`
  (each command prints one value) become env for every later phase, hook, spec
  and verifier (`${exports.X}` in files). Never log export values (events carry
  names; credential-named values are registered for redaction). A provisioned
  environment never reuses a tmux session.
- `services.files`: atomic validated writes (never clobbers an unparseable
  file; symlinks written through; new files `600` unless `mode`), per-run
  keyed `hmac-sha256:` fingerprints in `services.files.*` events, never
  content; `restart: [windows]` restarts windows that were already live.
- Seed: `phases` (state per project + env + `target` hash in
  `~/.cairntrace/services/<project>.<env>.<hash>.seed-state.json`),
  `commit: afterPostCommands`, post-command objects `{name, run, when: {suite,
  env}, continueOnError, timeout, expectOutput}`, `expectOutput.notMatches`.
  A resume (phases a failed run completed) is used once: `skipIf` still
  decides, TTL expires it, and any teardown (or `services down`) drops it.
  Events `services.seed.phase.*`, `services.seed.postcommand.skip`,
  `services.seed.commit`.
- Engine pin: config `requires: {cairntrace: <range>}` is enforced in
  `loadConfig` (run, verify, catalog, MCP, services up/restart/logs/status:
  exit 4; `services down` loads with `skipRequires` and warns — a teardown
  never waits on the pin); `runtimes.node` /
  `CAIRN_NODE` choose the node binary of node scripts (`src/core/runtimes.ts`,
  `src/core/runner/nodeScripts.ts`); `cairn doctor [--config]` and `config
  validate` report both.
- Journal events (additive `events.v1`): `services.provisioner.start|ready|
  exports|fail`, `services.tunnel.*`, `services.files.*`, `services.restart.*`
  and the seed ones above. Goldens: `src/core/schema/__fixtures__/events/
  services-*.ndjson`. Code: `src/core/servicesOps/` (schema, tunnels, files,
  seed transaction, logs), the orchestration in `src/core/runner/services.ts`,
  CLI in `src/cli/commands/services/{restart,logs}.ts`. Tests use a stub tmux
  (`src/testing/fakeTmux.ts`; it resolves targets like tmux 3.x, prefix
  matches included, so a non-exact target fails the tests), never a real tmux
  server, docker or cloud machine.

## Suites and metrics (config `suites:` / `metrics:`)

**Replace Taskfile suites with config.** A Taskfile target that picks specs with
a `case` on `SUITE`, runs per-environment commands before and after, passes
per-environment flags and collects numbers around the run is one config block and
one command. Do not copy the shell; declare it:

```yaml
suites:
  checkout:
    description: Checkout flows
    specs: [flows/checkout, flows/smoke/login.yml]   # paths, dirs, globs, spec names
    tags: [critical]                                 # AND on metadata.tags
    order: [login]                                   # these first, in this order
    parallel: 2
    bail: true
    requires: { env: [local, staging] }
    vars: { region: eu }
    env:
      staging:
        vars: { region: us }
        before: ["./tools/warm-cache.sh"]            # once, services up
        after: ["./tools/collect-diagnostics.sh"]    # once, every exit path
        hookTimeoutMs: 120000
        specs: [flows/checkout/smoke]                # replaces `specs` here
    seed: { postCommands: { skip: ["./tools/seed-extra.sh"] } }
metrics:
  - name: queue_depth
    scope: invocation
    command: ./tools/queue-depth.sh
    parse: { json: $.depth }
  - name: indexed_docs
    http:
      url: ${vars.searchUrl}/_stats
      auth: { bearer: "${secrets.SEARCH_TOKEN}" }
      json: { path: "$.indices[*].docs.count", reduce: sum }
```

```bash
cairn run --suite checkout --env staging
cairn suites list --json                 # specs each suite resolves to per environment
cairn stats --metric queue_depth.delta --group-by suite
```

- `--suite` replaces spec paths (spec paths next to it narrow it to those of its own
  specs, its hooks/vars/labels kept; a path outside it is exit 2) and finds the config from
  the working directory (else `--config <path>`; none found is exit 4); `--parallel` beats
  the suite's `parallel`, `--bail` adds to its `bail` and `--no-bail` (MCP
  `bail: false`) turns it off (`env.<e>.bail` replaces it per environment),
  `--var` beats its vars (specs and the hooks' `CAIRN_SUITE_VAR_*` alike),
  `--tag` narrows it. Every run is labelled with the suite's `labels`, then
  `suite=<name>`, then `--label` (later wins).
- `processEnv` (suite and `env.<e>`) is merged into the invocation's scoped
  env right after the suite vars refresh (after the vault), so preflight, the
  services phases, hooks, specs and verifiers all see it; an unset `${env.X}`
  entry is dropped, reserved names (`PATH`, `CAIRN_SUITE*`, `TVAULT_*`, …) are
  a schema error, only names are logged. `env.<e>.seed.postCommands.skip` adds
  to the suite's skips. Unknown suite or an
  unresolvable reference is exit 4; `requires` refusing the environment is exit 7.
  Suite vars resolve again once the vault's secrets are in (an unset
  `${env.X}` suite var is not passed; `requires.vars` is checked then); two vars
  that reach hooks as one `CAIRN_SUITE_VAR_<NAME>` are a validate error.
- Suite `before` hooks run once after services/webServer are up (a failure is exit 2);
  `after` hooks run once on every exit path once the before phase began (a
  signal included, synchronously), with `CAIRN_EXIT_CODE` (the specs' verdict:
  8/9 settle after the teardown that follows them; 130/143 on a signal) and
  services still up, non-fatal. Both are bounded by
  `hookTimeoutMs`, run in the config directory and are journaled as
  `suite.hook.started|finished` (`suite.started|finished` around them). `--before`
  / `--after` keep their per-iteration / per-spec meaning.
- `seed.postCommands.skip` names a named seed post-command (object form) by its
  `name` and a plain string one by its exact command text; a stray entry is a
  warning. `suites:` merges through `include:`; `cairn config
  validate` resolves every suite per environment.
- Metrics: probes run bounded (`timeout`, default 10s), never fail a run, stop
  with their scope (`every:` ticks included) and write
  `<runDir>/diagnostics/metrics.json` (`urn:cairntrace.dev:metrics:v1`) plus flat
  `<name>.before|after|delta` numerics merged into `diagnostics/report.json` after
  the `--after` hooks (`cairn stats --metric <name>.delta`). Invocation-scope rows
  also land in `<journal>/metrics.json` and in every run of the iteration. Secrets
  resolve per sample and never reach artifacts. Events: `metric.sampled`.
- Code: `src/core/suites/` (schema, resolver, validate), `src/core/metrics/`
  (schema, probes, sampler, artifacts), engine wiring in
  `src/cli/invocation/suite.ts` and `metrics.ts`. Docs: `cairn docs services`
  ("Suites", "Metrics Probes"), `docs/services.md`, `docs/configuration.md`.

## Delegated runners (config `environments.<n>.runner`)

An environment can run elsewhere: `environments.<n>.runner: { command: [argv…],
cwd?, env?, timeoutMs?, idleTimeoutMs?, cancelGraceMs? }` (contract
`urn:cairntrace.dev:delegate:v1`). `cairn run --env <n>` and MCP `cairn_run`
keep the invocation locally — journal, run directories under the local
artifact root, exit code, Ctrl-C / Studio Stop and Live Cancel /
`cairn_run_cancel` — and hand the execution to `command`. Cairntrace knows
nothing about where it goes; keep it that way (no infrastructure names in
code, tests, fixtures or docs). **Never take the runner's word for a result**:
every exit code is checked against the evidence (see Exit below).

- Locally: config + engine pin, `--suite`, the environment policy, scoped
  secrets, `run.lock` (scoped to that environment by `runLockTarget({
  environment })`, so it never blocks local environments or `cairn services`;
  `environments.<n>.run.lock: false` when the runner manages capacity),
  `run.preflight`, then `run.finally`, JUnit and the document after the runner
  exited. Never locally: services, webServer, browser, suite hooks, metrics,
  fixtures, `--before/--after` (passed in the request), `run.verifyClean`,
  the `runtimes.node` pin. A runner environment may not own a `services:`
  block (schema refine, also through `extends`); readers that list an
  environment's services pass `env.runner ? false : env.services`.
- One environment per delegated invocation: `resolveDelegation` resolves
  EVERY spec's environment and refuses (exit 4) a mix of a runner environment
  with any other, in any order, or several configs. `runSpec` throws
  `DelegatedEnvironmentError` (exit 4) for a runner environment, so no other
  path (heal, investigate, discovery, accompany) runs one in a local browser.
- A locally refused spec never runs remotely: the request's `planned` drops
  its entries (`refused` lists them) and `cairnArgs` carry the explicit
  runnable list (next to `--suite` it narrows the suite: `applySuite` takes
  spec paths that are its own; another path is exit 2).
- The runner gets `CAIRN_DELEGATE_REQUEST` (`DelegateRequestSchema`,
  `src/core/schema/delegate.v1.ts`; specs relative to the config dir,
  portable `options`, `cairnArgs` without `--env` and with `--label
  cairn.delegate=<invocationId>` — v1 conformance: every copied run.json
  carries that label), `CAIRN_DELEGATE_EVENTS` (a FILE it appends
  events.v1 NDJSON to — never a pipe: the synchronous signal path keeps reading
  it while it waits), `CAIRN_INVOCATION_ID/DIR`, `CAIRN_ARTIFACT_ROOT`; its
  stdout/stderr go to a file copied redacted into `logs/delegate.log`. It is
  spawned `detached` (own process group).
- The stream is what `cairn logs --invocation <ref> --follow --relay` prints
  on the remote side (`DelegateStreamProducer`, `src/core/delegate/
  remoteStream.ts`): journal lines + `invocation.run.started|finished` +
  `invocation.summary` (derived run lines have deterministic timestamps);
  `<ref>` may be `label:<key>=<value>` (waited for at most `--wait-timeout`,
  default 10m). The relay (`DelegateRelay`, `relay.ts`) validates every
  line (strict, then lenient for a newer producer), never throws, records
  bad lines as `delegate.diagnostic` (rate-limited narration), recovers the
  event after a torn line, drops exact repeats (bounded memory) /
  heartbeats / `log.opened`, dedups `invocation.run.*` by run state (a
  settled run never goes back; a different second status is
  `status-mismatch`), refuses `delegate.*` other than `delegate.progress`
  and RelativePath fields with `..`/absolute paths, maps remote
  `invocation.started|finished` to `delegate.remote.*` (finish/summary of
  another remote invocation do not count), remote `phase.changed` to the
  local tracker, runs onto the local plan by spec path (a run of a locally
  refused spec is `refused-run`, not relayed), and writes everything else
  with `delegated: true` (the optional marker every `RunEventSchema` member
  accepts). `FileLineTail` keeps at most 1 MiB + 1 of a line. `verify()`
  checks each run's `<root>/<runId>/run.json`: missing (`missing-run-dir`),
  `labels["cairn.delegate"]` ≠ the local id (`foreign-run`), a dir that
  existed before the runner started (`stale-run`), status ≠ the stream's
  (`status-mismatch`, run.json wins); with coverage (runner exit 0/1) every
  planned run settled or accounted for by the remote summary (`missing-run`).
  Only `verified` runs hand their run.json to the document.
- Exit (`delegateVerdict`, pure): the runner's code is a claim. 0 stands
  only with every planned run settled by a verified run dir, no
  contradiction, the remote invocation's own finish/summary (same id)
  passed, every relayed run passed and no error line in the stream; else
  2 (evidence missing/wrong), the remote's code, or the runs' code. 1 stands
  only when a relayed run (or the remote verdict) failed; else 2 (infra
  failure, never a red test). 2–9/130/143 are never lowered; any other code,
  a foreign signal, a spawn failure, `timeoutMs`, `idleTimeoutMs` → 2;
  cancel → 130 (143 SIGTERM); all specs refused locally → 7, nothing
  spawned. Every override adds an `exit-mismatch` diagnostic.
  `RunInvocationResult.exitCode` may be 130/143 for a delegated invocation;
  documents keep a stable code and carry `invocationOutcome.delegate`.
- Cancel: graceful (`DelegateSession.cancel`; also `timeout` and `idle`) and
  signal path (`cancelSync`, synchronous: SIGINT to the runner's PID only — its
  helpers keep working — `cancelGraceMs` default 180000, then SIGTERM and 10s
  later SIGKILL to its process GROUP; zombie detection via `/proc` on Linux,
  `ps` elsewhere, an unknown state counts as running, because the event
  loop cannot reap; it keeps relaying and beating the heartbeat) both record
  `delegate.cancel.requested|escalated|finished`, then `delegate.finished`;
  the delegated reporter runs BEFORE `journal.abortSync` so the journal stays
  live while the runner stops.
- `invocation.json` `delegate` block, MCP `cairn_run_status.delegate`,
  Studio's "delegated" tag, `cairn config validate` `delegatedEnvironments`,
  `cairn stats --invocation <local id>` (matches the `cairn.delegate` label),
  `cairn logs <runId> --follow` and Studio's run liveness (both follow the
  local owner, not the remote heartbeat pid). Studio's Live Cancel sends a
  delegated run SIGINT with no early SIGKILL (`cancelPolicy` in
  `desktop/lib/cli.js`). `--services-dry-run` / `--select-only` print the
  masked plan (`DelegatePlanSchema`) and spawn nothing.
- Code: `src/core/delegate/` (stream, runnerProcess, relay, remoteStream),
  `src/cli/invocation/delegate.ts` (target, spawn spec, request, plan,
  session, results) wired by `RunInvocation.runDelegated`. Tests use the
  reference runner `src/testing/fakeDelegateRunner.ts` (replays a recording
  of a real mock invocation made with `--label cairn.delegate={{invocationId}}`,
  copies run dirs, misbehaves on demand: dropped/edited lines, `labelRuns:
  false`, `reconnectAfter`, `helperProbe`, hangs, signals) and
  `src/testing/delegateFixtures.ts`; never a real remote machine. Docs:
  `docs/delegate.md`, `cairn docs delegate`.

## Logging & output

**Contract:** stdout is reserved for structured results (JSON/YAML/markdown
via `--format`). All diagnostic/lifecycle logs go to **stderr** — including the
services lifecycle narration and live subprocess output. `cairn run`/`cairn
clean` route through the leveled logger (`src/cli/logger.ts`); other commands
are migrating incrementally.

**Interactive TUI:** under `--format md --progress tty` the narration renders
through an **Ink**-based TUI (`src/cli/ui/` — store-driven views for the
services lifecycle, single-spec runs, and batches, all on one theme). All
narration flows through the store; nothing writes to the viewport directly.
Non-TTY/CI keeps the byte-stable plain listener (`src/cli/progress.ts`) and
`--log-format json` keeps machine-readable NDJSON. clack remains only for
interactive prompts (login/heal).

**Verbosity** (global flags + env + config, highest priority first):
- `--log-level <debug|info|warn|error|silent>`, `--quiet` (=warn),
  `--verbose` (=debug). Default: info on a TTY, warn in CI/piped.
- `--log-format <human|json>` (json = one NDJSON object per log line).
- `--no-color` / `NO_COLOR`. `CAIRN_LOG_LEVEL` / `CAIRN_LOG_FORMAT` env.
- `logging: { level, format, color }` in cairntrace.config.yml sets project
  defaults that flags/env override.

## Retention

`retention: { keepRuns: N }` prunes the artifact root to the newest N runs per
spec after every run (and via `cairn clean`). **Default is 3** when no
`retention` block is set; `retention: { enabled: false }` keeps everything.
`archiveToStash: true` archives pruned run dirs to fcheap before deletion
(best-effort — if the archive fails the run is retained on disk;
`archiveTags: [...]` tags them). The archive goes through the evidence gate
(`stash.include`, default `[text, screenshots]`) and carries `stash.ttl`,
so it is **lossy** for what the gate leaves out: traces, videos and downloads
of a pruned run are deleted with it unless `stash.include` lists them (the
CLI says so once per process). `retention.publish` publishes pruned runs the
same way (`retention.publish.include`; traces never). Every archive and
publication is recorded on the run whose retention pass pruned:
`artifact.stash` with `action: "archive"` and the pruned `runId`,
`artifact.publish`, or an `artifact.retention` warning when one failed and the
run was kept. `cairn pin <run>` writes `pinned` to run.json: retention never
prunes a pinned run (it re-checks the pin right before archiving and before
deleting), pinned runs take no `keepRuns` / `keepFailedRuns` slot, and only
`cairn clean --include-pinned` removes them. Runs refused by the environment
policy have no run directory and are never retained. Failed/errored runs get a
`keepFailedRuns` carve-out (default 10) so a real failure's forensics survive
routine pruning. Interrupted runs — a signal killed the process before
`run.json` was written, leaving missing/corrupt/statusless metadata — are NOT
carve-out protected; they count toward the `keepRuns` window like any other
run, so the newest interrupted run is preserved up to the cap but old ones age
out. Signal-time `aborted-<ts>-<pid>.json` partial-batch summaries at the
artifact root are swept under the same `keepRuns` cap. `cairn clean --all`
(keepRuns 0, keepFailedRuns 0) removes everything except pinned runs.

## Discovery sessions

Discovery is the interactive authoring path — an agent explores a live page
through the harness and records each interaction as a spec step, then exports
the session as a spec YAML. This replaces blind authoring (write → run →
fail → heal) with explore → record → export.

**MCP tools** (primary interface, 12 tools):
`cairn_discover_open` (optional `setup`: imported actions or a spec's first
steps; `resume`; `backend`) → `cairn_discover_snapshot` /
`cairn_discover_inventory` → `cairn_discover_interact` /
`cairn_discover_navigate` (`snapshotMode: diff` by default; results carry
`network.mutations`) → `cairn_discover_network` / `cairn_discover_suggest` /
`cairn_discover_remove_step` → `cairn_discover_export` (with `into` it
applies the project conventions and writes a draft; see `cairn docs
author-flow`) → `cairn_discover_close`. `cairn_discover_resume` re-opens a
session from its journal; `cairn_discover_list` lists sessions.

**CLI** (one-shot): `cairn discover <url> [--roles] [--testids] [--env <name>]`
returns the full accessibility tree + locator inventory in one call (and
leaves a journal); `cairn discover export --from-session <id> --into
flows/_drafts --intent … --outcomes <file>` writes it as a convention draft,
`cairn discover sessions` lists journals.

Discovery and `cairn snapshot` read the project config like a run:
`env`/`config`/`var` select the baseUrl and fill `${vars.X}` in the URL, and
the test-id inventory scans `browser.testIdAttribute` (what `by: testid`
resolves). A relative URL with no baseUrl fails on a real browser instead of
navigating to a bare `/path`.

Sessions are stateful — the browser stays alive across MCP tool calls and
closes after 30 min idle (`ttlMs`, config `discovery.sessionTtlMs`). Every
session is journaled to `<artifactRoot>/_sessions/<id>/` (session.json,
events.ndjson, screenshots, snapshots, network, draft.spec.yml), which
outlives the browser: export and resume work from it. Use `mock: true` for
fast offline exploration. A session started with `setup: [{ use: <login> }]`
exports `imports:` + `use:`, which satisfies the cold-start contract; other
sessions still need a checkpoint or preconditions. Run `cairn docs discovery
--json` or MCP `cairn_docs` with topic `discovery` for the full workflow
guide.

## Browser automation

Cairntrace has two backends; the spec doesn't have to know which one runs.

- **`agent-browser`** (default) — AI-native browser CLI with semantic
  locators and compact accessibility snapshots. See
  `src/adapters/agent-browser/`.
- **`playwright`** — full Playwright with native traces, video, and HAR. Pass
  `--backend playwright` to `cairn run` or `cairn spec heal`. Install the
  browser binary with `bunx playwright install chromium`. The adapter uses
  `locator.ariaSnapshot()`, whose output the heal `snapshotParser` reads.
  Request steps run out of page with context-cookie sharing (`browserContext.request`
  when safe, isolated Bun cookie bridge under Bun), so they send page cookies,
  persist `Set-Cookie`, and are not coupled to page evaluation. In CI,
  Playwright Chromium launches with `--no-sandbox` and
  `--disable-dev-shm-usage` by default; override with
  `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` when a runner needs different flags.
  Its request/console logs live in the cairn process (`evidenceInProcess`),
  so a run wedged by a hard deadline still writes `network/` and `console/`
  up to the kill; `close()` is bounded (10s) and then kills the browser, and
  the engine bounds every backend close (90s) before `terminateSync()`.

### agent-browser quirks (when reading `AgentBrowserAdapter.ts`):

- `--session <name>` is a global flag; the adapter stamps this on every call.
- Interactive steps (click/hover/fill/upload, plus semantic `scroll.to` and
  downloads) do NOT use agent-browser's `find` family — `find` reports
  success on zero matches. The adapter resolves semantic locators against
  `snapshot -i`, scrolls the `@ref` into view, acts on the ref, and records
  the resolved element as step evidence.
- Link clicks are classified first: only a same-tab http(s)/relative nav link
  installs the short URL/DOM-mutation delivery probe. If such a link reports
  success without either signal and remains enabled, Cairntrace retries once
  with low-level mouse input at its live center. External-effect links —
  `target="_blank"`, a `download` attribute, or a `mailto:`/`tel:`/`javascript:`
  scheme — legitimately never mutate the current document, so they are clicked
  exactly once and pass with a diagnostic note (no verification, no retry).
  Ordinary buttons never receive this retry, and the whole probe is skipped
  when the click resolves to `settleMs: 0` or `verifyAfterClick: false`.
- `batch` steps are the exception that runs through agent-browser's native
  `batch --bail`: each selector sub-step maps to one command via
  `batchSubStepToArgv`, joined and quoted with `quoteIfNeeded`. This is the
  only path that issues multiple interactions per invocation (to preserve
  hover/focus state); it's selector-only precisely because there's no
  per-sub-step snapshot resolution.
- Transient `os error 35` / daemon-busy failures are retried twice with
  backoff inside `invoke()`.
- Every invocation carries a hard execa `timeout` (60s default; step-level
  `timeoutMs` + 5s grace when present) so a wedged daemon can never hang a
  run — the child is killed and the step fails with a timeout error. Screenshot
  capture uses a tighter 15s deadline and reports a rendering-surface/display
  hint instead of publishing a partial PNG. A screenshot timeout is
  best-effort: it records a warning + missing-artifact note but never fails the
  step, spec, or outcomes. Only the capture command is stopped; the adapter
  then gives the session daemon up to 20s to finish it (a late capture counts
  as a real screenshot) and turns screenshots off for the session when none
  landed. Only when the capture still blocks the daemon after that drain is
  the session stopped and marked wedged (later commands are refused at once,
  diagnostics and OPTIONAL captures are skipped); outcome verifiers still run.
  A real interaction, wait or query that hits its deadline marks it wedged
  too.
- The session daemon's command queue is serial: a `close` issued mid-`wait`
  queues behind it, and a SIGTERM delivered while the daemon is busy is
  dropped (verified on 0.26–0.27). Signal-time cleanup therefore goes through
  `terminateSync()` — SIGTERM the daemon via `~/.agent-browser/<session>.pid`,
  then escalate to killing its Chrome children + SIGKILL. The handler must
  stay fully synchronous: with an in-flight execa child, signal-exit
  re-raises the signal as soon as the sync portion returns.
- `navigate <url>` (not `open <url>`) is what we send for `OpenStep` — `open`
  is for launching the browser, `navigate` for navigation.
- `network requests --json` and `console --json` wrap results in
  `{success, data: {requests|messages: [...]}, error}` — see `parseEnvelope()`.
- `eval <expr>` auto-stringifies the result as JSON; the `script` verifier
  wrapper returns the object directly (no extra `JSON.stringify`).
- No native `--notText` wait; we synthesize it with `wait --fn` using the
  normalized text predicate and the step's `caseSensitive` setting.
- The special region token `"page"` translates to `body` for `get text`.

## Development

```bash
bun install            # install deps
bun run typecheck      # tsc --noEmit
bun run test           # vitest run (coverage threshold: 80%)
bun run lint           # oxlint
bun run format         # oxfmt src bin
bun run knip           # detect unused exports/deps
bun run verify         # typecheck + lint + format:check + knip + tests (the gate)
./bin/cairn doctor     # sanity check (node/bun/agent-browser/artifact root)
```

## Layout

```
src/
  cli/             commands/* — one file per CLI subcommand
  core/
    importers/     playwrightImporter (facade), playwrightAst (test importer, TS AST),
                   playwrightTrace (trace importer), zipReader, playwrightLocators,
                   assertionOutcomes, importCommon (coverage, secret heuristics, YAML)
    parser/        parseSpec (YAML + zod + ${X} substitution + imports + baseUrl)
    runner/        Runner, OutcomeEvaluator, verifiers/, conditions (when:)
                   webServer.ts (single-server lifecycle)
                   services.ts (multi-service lifecycle: docker/seed/tmux)
                   seedState.ts (seed freshness tracking)
                   runStep.ts / teardown.ts / boundedCommand.ts (host commands)
                   controlFlow.ts (repeat / if / use.retry), waitGroups.ts
                   (wait.any|all|optional|app), requestStep.ts (request v2),
                   envAuth.ts (use: login)
    widgets/       widget kit: in-page runtime + built-in drivers (widgetRuntime.page.js),
                   host side (execute.ts, runtime.ts)
    prelude/       window.__cairn page prelude + browser.appHandle accessors
    datasources/   mongo (driver | mongosh | docker exec), temporal, http clients
    gates/         readiness gate schema, probes, evaluation, registry
    fixtures/      fixtures registry: exec/mongo/http adapters, ledger, runtime
    artifacts/     ArtifactWriter, renderers/, evidence, agentContext
    suites/        config suites: registry — schema, SuiteResolver (paths, globs,
                   names, tags, order), validate; wired in cli/invocation/suite.ts
    metrics/       config metrics: probes — schema, probes (command/http), sampler
                   (before/after/every), artifacts (metrics.json, report.json merge);
                   wired in cli/invocation/metrics.ts
    delegate/      delegated runner (environments.<n>.runner): stream.ts (line
                   parser + file tail), runnerProcess.ts (process group, cancel),
                   relay.ts (stream → journal, verdict), remoteStream.ts
                   (`cairn logs --relay`); wired in cli/invocation/delegate.ts
    runPolicy/     config run: block — expression.ts (assert language), lock.ts,
                   preflight.ts, cleanliness.ts, finally.ts, sessionLedger.ts,
                   orphans.ts (doctor --orphans); wired in cli/invocation/runPolicy.ts
    schema/        zod-first schemas (spec.v1, verifier.v1, run.v1, heal.v1, explain.v1,
                   config.v1 (services, healthcheck, stash), docs.v1, ...)
    checkpoint/    CheckpointStore (~/.cairntrace/checkpoints/<name>.json)
    config/        loader for cairntrace.config.yml
    contractHash   sha256 over intent + outcomes
    healer/        snapshotParser, Healer
  adapters/
    browserBackend.ts          the interface
    agent-browser/             real backend (commandBuilder + AgentBrowserAdapter)
    mock/                      MockBrowserBackend for tests + --mock
  mcp/             buildMcpServer() — tools mirror the CLI surface
  sdk/             verifier SDK (`@thelacanians/cairntrace/verifier`, plain JS + .d.ts)
desktop/           Cairntrace Studio (Electron): a thin console over the CLI +
                   artifacts. main/preload/ipc + lib/ (testable core) +
                   renderer/ (classic scripts, no bundler, no innerHTML).
                   Spawns `cairn`; never reimplements runner behaviour.
                   Gates: desktop:test, desktop:typecheck, desktop:smoke
                   (see desktop/README.md).
examples/          demo-app + spec YAMLs (see examples/README.md)
bin/cairn          bun shebang launcher
```

## Adding a new verifier (when you really need one)

1. Add the typed schema in `src/core/schema/verifier.v1.ts` to the union +
   `VerifierKindSchema` enum + `is<X>Verifier` predicate + `verifierKind()` switch.
2. Implement `src/core/runner/verifiers/<name>.ts`.
3. Add the dispatcher branch in `src/core/runner/OutcomeEvaluator.ts`.
4. Update `cairn explain` (CLI command + MCP tool).
5. Add tests in `src/core/runner/verifiers/verifiers.test.ts`.
6. A verifier that judges data (not the page) keeps its judging in a pure
   module and joins the Playwright export through
   `src/core/exporters/runtimeSources.ts` (never re-implement it there).
   After changing any module listed in `RUNTIME_SOURCE_FILES`, regenerate the
   checked-in copy: `CAIRN_UPDATE_GENERATED=1 bun run test
   src/core/exporters/runtimeSources.test.ts`, then `bunx oxfmt
   src/core/exporters/runtimeSources.generated.ts`; the drift test fails
   until you do.

But: prefer the `script` escape hatch if the need only shows up in one spec.
Only promote to a typed verifier when 3+ real specs would benefit.

## When you finish a task

- Run `bun run verify`. It must be green.
- Smoke-test against the demo app if you touched anything in the run/heal
  pipeline (see `examples/README.md`).
- Version intentionally — choose patch/minor/major using the release rules
  below. Bump `package.json` `version` in the release commit. Push tags and
  create releases only when the user asks.

## Releasing (on the user's request only)

Cairntrace uses SemVer tags mirrored to GitHub releases.

- Patch: bug fixes, docs, importer/exporter polish, verifier fixes, runtime
  reliability work, or follow-up work that does not expand the CLI/schema
  surface in a meaningful way.
- Minor: new agent-callable commands, new typed steps/verifiers, new stable
  schema/artifact fields, or substantial non-breaking behavior.
- Major: breaking CLI flags, spec schema, artifact schema, MCP contracts, or
  migration-heavy behavior changes.

Before cutting a release:

- Inspect `git status --short` and make sure every file in the commit belongs
  to the release.
- Run `bun run verify`. It must be green.
- Smoke-test the demo app if runner, heal, backend, importer/exporter, or
  artifact behavior changed.
- Bump `version` in `package.json` and `desktop/package.json` (Studio reports
  its own version from it) and nothing else; the README install guide
  deliberately hardcodes no version and resolves the newest tag dynamically.
- Do not delete, recreate, or rename old GitHub releases/tags unless the user
  explicitly asks to rewrite release history.

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main
git push origin vX.Y.Z
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

Tag push also publishes npm and updates the Homebrew formula. Do not bump
`Formula/cairntrace.rb` by hand unless the workflow is broken.

- `vX.Y.Z` tags are the **only** tag kind. Do not create or move a floating
  `latest` tag — GitHub marks the newest release "Latest" automatically, and
  `<repo>/releases/latest` always points at it.
