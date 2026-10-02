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
              request: → backend.request when available; bounded page-fetch fallback
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
              expects/  captures/  fixtures.json
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
- Exit codes are meaningful: 0 success, 1 outcome-failure, 2 errored,
  3 cold-start gate, 4 lint, 5 heal-no-progress, 6 contract-hash mismatch,
  7 refused by the environment policy (`cairn run` when every spec was
  refused, or any spec under `--strict-requires`; `cairn spec heal` on a
  refused spec).
- Prefer small adapters over coupling core logic to agent-browser or Playwright.
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
  support use a bounded page-fetch fallback.
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
  `backends`, `discovery`, `export`, `brief`) — don't rely on training-data
  knowledge of the CLI.
  Before authoring, ask `cairn catalog --query "<words>" --json` (MCP
  `cairn_catalog`) what the project already has. For Playwright handoff use
  `cairn export playwright` / MCP `cairn_export_playwright` (see `export`).
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
  `cairn_services_down` refuse. The CLI is not gated.
- `secrets.provider: tvault` injects vault secrets into the seed command's env.
  The `tvault:` block supports two modes: `project` (direct) or `group` + `env`
  (inheritance — resolves missing keys from the base environment via tvault's
  env-group feature).
- `cairn config validate --json` validates the config file (zod schema +
  cross-field `.refine()` rules: unique window names, readyOn constraints,
  tvault provider requires tvault block with either `project` or `group`+`env`,
  known gate names, fixture `needs`, datasource entries after each
  environment's override is merged).
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
  `services:` block deep-merges over the top-level one. Inside a partial block,
  `tmux: false` drops only the inherited local tmux windows while keeping the
  docker and seed phases. An env-level `secrets:` block replaces the top-level
  one entirely. This replaces the need for `--no-services` or
  `--services-dry-run` when running against remote envs.

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
    parser/        parseSpec (YAML + zod + ${X} substitution + imports + baseUrl)
    runner/        Runner, OutcomeEvaluator, verifiers/, conditions (when:)
                   webServer.ts (single-server lifecycle)
                   services.ts (multi-service lifecycle: docker/seed/tmux)
                   seedState.ts (seed freshness tracking)
                   runStep.ts / teardown.ts / boundedCommand.ts (host commands)
    datasources/   mongo (driver | mongosh | docker exec), temporal, http clients
    gates/         readiness gate schema, probes, evaluation, registry
    fixtures/      fixtures registry: exec/mongo/http adapters, ledger, runtime
    artifacts/     ArtifactWriter, renderers/, evidence, agentContext
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
