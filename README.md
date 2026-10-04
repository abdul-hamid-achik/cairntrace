# Cairntrace

> Mark browser behavior in YAML, replay it, and hand the trace to any coding agent.

Cairntrace is a local-first behavioral browser-spec layer for coding agents.
Specs define `intent + outcomes` as the behavior contract and `steps` as
repairable hints for reaching that state. The same spec can run from the CLI,
through the MCP server, or later be exported to Playwright.

Cairntrace is agent-neutral: there are no Claude, Codex, Cursor, or OpenCode
branches in core. The stable interface is the CLI, MCP tools, and run artifact
format.

## Why Use It

- Give agents a real browser acceptance check while they build a feature.
- Replace manual "click through this workflow" smoke tests with YAML specs.
- Capture DOM snapshots, screenshots, console, network, and outcome evidence
  into one agent-readable artifact pack.
- Heal common locator drift without changing the behavior contract.
- Start with `agent-browser` for agent-in-session work and switch to
  Playwright when you need Playwright-native traces or exported tests.

## Installation Guide

Cairntrace is published to npm as **`@thelacanians/cairntrace`** and to
Homebrew as **`abdul-hamid-achik/tap/cairntrace`**. The CLI ships as a Bun
shebang with no build step, so [Bun](https://bun.com) `>=1.3.0` is required
at runtime (Homebrew installs it as a dependency). Installing from source is
also supported and equivalent: clone + `bun install`. Pin the
[latest release](https://github.com/abdul-hamid-achik/cairntrace/releases/latest)
or use `main`.

### 0. Install the CLI

One-liner (Homebrew if `brew` is on `$PATH`, otherwise bun > pnpm > yarn > npm):

```bash
curl -fsSL https://raw.githubusercontent.com/abdul-hamid-achik/cairntrace/main/install.sh | bash
```

Homebrew (macOS/Linux):

```bash
brew install abdul-hamid-achik/tap/cairntrace
```

npm (or bun / pnpm / yarn):

```bash
npm install -g @thelacanians/cairntrace
bun add -g @thelacanians/cairntrace
pnpm add -g @thelacanians/cairntrace
yarn global add @thelacanians/cairntrace
```

Verify with `cairn --version`. If you prefer to run from source, follow the
clone path below.

### 0b. The desktop app (optional)

**Cairntrace Studio** (`desktop/`) is an Electron console over the same CLI:
run history with one-click evidence (steps, outcome markdown, screenshots,
console/network, `report.html`, run diffs), a spec editor that saves and shows
`cairn spec verify` findings, live step progress streamed from the run's own
`events.ndjson`, cohort stats, and the step/verifier reference read from the
installed binary. It needs the CLI on `$PATH` (or pointed at in Settings) and
nothing else.

```bash
bun run desktop:install   # once
bun run desktop:start     # launch Studio
```

See [desktop/README.md](./desktop/README.md) for the architecture and gates.

### 1. Install prerequisites

- [Bun](https://bun.com) `>=1.3.0`
- A browser backend:
  - [`agent-browser`](https://agent-browser.dev) on `$PATH` for the default
    backend
  - or Playwright Chromium for `--backend playwright`

Check Bun first:

```bash
bun --version
```

### 2. Clone and install dependencies

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
bun install
```

To pin the newest release tag instead of tracking `main`:

```bash
git checkout "$(git tag --sort=-v:refname | head -1)"
```

Updating later is `git pull` (or `git fetch` and re-run the checkout above)
followed by `bun install` — nothing to rebuild.

### 3. Install a browser backend

`agent-browser` is the default backend and the recommended path for
agent-in-session runs:

```bash
brew install vercel-labs/agent-browser/agent-browser
agent-browser --version
```

Playwright is optional. Install its Chromium browser only if you plan to run
with `--backend playwright`, inspect Playwright traces, or execute exported
`@playwright/test` specs:

```bash
bunx playwright install chromium
```

On CI, the Playwright backend launches Chromium with `--no-sandbox` and
`--disable-dev-shm-usage` when `CI` is truthy. Set
`CAIRN_PLAYWRIGHT_LAUNCH_ARGS` to override the launch args for a runner.

### 4. Verify the install

```bash
./bin/cairn doctor
```

`./bin/cairn` is a Bun shebang launcher for development, so there is no compile
step for local use.

### 5. Optional: put `cairn` on your PATH

You can always run Cairntrace from this repo with `./bin/cairn`. To use
`cairn` from any directory, symlink the launcher into a directory already on
your `$PATH`:

```bash
ln -sf "$PWD/bin/cairn" /usr/local/bin/cairn
cairn doctor
```

If `cairn doctor` reports `bun` or `agent-browser` missing, confirm those
commands work in the same shell and that their install directories are on
`$PATH`. For Playwright, doctor reports the package and Chromium separately:
run `bun install` for `playwright-package`, or
`bunx playwright install chromium` for `playwright-chromium`.

## 5-Minute Demo

Start the tiny demo app in one terminal:

```bash
bun examples/demo-app/server.ts
```

Run a real browser spec in another terminal:

```bash
./bin/cairn run examples/flows/01-dashboard-nav.yml
```

Then inspect the agent handoff summary:

```bash
./bin/cairn context latest
```

Useful variants:

```bash
./bin/cairn run examples/flows/01-dashboard-nav.yml --backend playwright
./bin/cairn run examples/flows/01-dashboard-nav.yml --mock
./bin/cairn run examples/flows/01-dashboard-nav.yml examples/flows/02-row-count.yml --parallel 2 --json
./bin/cairn run examples/flows/01-dashboard-nav.yml examples/flows/02-row-count.yml --junit ./.cairntrace/junit.xml --json
./bin/cairn snapshot /dashboard.html --config examples/cairntrace.config.yml --json
./bin/cairn spec heal examples/flows/06-drifted-link.yml
```

See [examples/README.md](./examples/README.md) for the full demo walkthrough,
including the intentionally failing spec, the heal demo, config-backed specs,
downloads, transforms, and `xlsx` verification.

## A First Spec

This is the shape of a Cairntrace spec:

```yaml
version: 1
name: dashboard_nav
intent: |
  A user can open the demo dashboard from the home page.

outcomes:
  - id: url_is_dashboard
    description: browser lands on the dashboard page
    verify:
      url: { endsWith: /dashboard.html }

  - id: dashboard_heading_visible
    description: dashboard heading is visible
    verify:
      text: { contains: "Inventory Dashboard" }

  - id: no_console_errors
    description: page has no console errors
    verify:
      console: { errorsMax: 0 }

steps:
  - open: /
  - click: { by: role, role: link, name: Open dashboard }
  - wait: { text: "Inventory Dashboard" }
```

The example above matches the first demo flow. Run that checked-in spec:

```bash
./bin/cairn run examples/flows/01-dashboard-nav.yml --cold-start --json
```

For your own specs, validate and stamp the behavior contract:

```bash
./bin/cairn spec verify flows/dashboard_nav.yml --json
./bin/cairn spec verify flows/dashboard_nav.yml --stamp
./bin/cairn run flows/dashboard_nav.yml --cold-start --stamp-if-green
```

`intent + outcomes` are the contract. `steps` are hints. `cairn spec heal`
can patch drifted steps, but the contract hash prevents accidental changes to
what the spec asserts.

## Authoring with an agent

Ask for a flow in a few sentences ("sign in as the supplier, change the
profile website, save, check it persisted") and the agent follows one recipe —
the MCP prompt `author-flow`, or `cairn docs author-flow`:

1. `cairn catalog --query "…"` (MCP `cairn_catalog`) — reuse the project's
   actions and vars instead of re-recording literals.
2. `cairn_discover_open` with `setup: [{ use: <login action> }]`, then record
   the journey with `cairn_discover_interact` (snapshot diffs keep it cheap;
   each answer shows the requests the action sent). The session journal is
   visible in Cairntrace Studio.
3. `cairn_discover_export { into: "flows/_drafts", intent, outcomes }` writes
   the draft the project's way: existing actions as `use:`, config values as
   `${vars.X}`, secrets as placeholders, relative URLs, step ids, waits after
   navigations, `postcondition.network` for observed saves.
4. `cairn spec finish <draft> --json` — lint with fix-its, a cold-start run
   through the `cairn run` engine, the contract stamped when green
   (`--no-web-server` reuses a dev server you already run).
5. The human reviews; `cairn spec promote <draft>` moves it out of the drafts
   directory, which `cairn run <dir>` skips. It needs a green finish on a
   real backend: a `--mock` finish never touched the app.

`cairn spec lint <spec> --fix` catches what agents get wrong most (an
unquoted `#` selector, a missing file, an echo-only cold start, a literal
secret, an `eval` a typed step does better), and `cairn init agent-kit --write`
adds a short section on this to your project's `AGENTS.md`. See
[Author a spec from a request](docs/author-flow.md).

## Core Concepts

**Cold-start contract**

Finished specs must replay from a fresh browser session. Use one of:

- imported login actions: `imports: [actions/login_admin.yml]` plus
  `steps: [{ use: login_admin }]`
- checkpoint restore: `session: { resume: <checkpoint-name> }`
- deterministic setup: `preconditions.commands`
- explicit public/sessionless acknowledgement: `coldStart: guest`

Run `cairn run <spec> --cold-start --json` before declaring a spec done.

Rendered `text`/`notText` equals and contains checks normalize whitespace and
match case-insensitively by default. Use `caseSensitive: true` when casing is
part of the contract; regex `matches` keeps raw, case-sensitive semantics.

**Steps**

Current step keys:

`open`, `click`, `hover`, `focus`, `fill`, `type`, `select`, `upload`, `download`,
`transform`, `request`, `wait`, `press`, `scroll`, `snapshot`, `use`, `batch`,
`eval`, `monitor`, `run`, `expect`, `capture`, `repeat`, `if`, `set`, `check`,
`uncheck`, `choose`, `form`.

`expect` asserts mid-flow (locator assertions or `expect.request`; a mismatch
fails the step with evidence), `capture` stores a value from the page
(`text`, `value`, `attribute` or a whole `table`) as `${captures.<name>…}`,
and `run` executes a host command or node script with a hard deadline
(`assign` exposes its JSON result as `${runs.<name>…}`). A spec-level
`teardown:` list always runs after the steps and outcomes — pass, fail, error
or cancel — so cleanup never hides in an outcome.

`select` picks a native `<select>` option by option `value` or visible
`label` (exactly one of the two). `fill` value-sets date-ish inputs
(`type=date|time|datetime-local`) natively with `input`/`change` events —
their shadow-DOM pickers swallow simulated keystrokes; on agent-browser reach
them with `by: selector` (they have no accessibility-snapshot presence).

Interactive steps use locators with `by: role`, `by: label`, `by: text`, or
`by: selector`. Prefer role and label locators when possible; they are clearer
for humans and easier to heal.

Semantic locators are strict: they match accessible names (whole-name,
case-insensitive, visible elements only), scroll the target into view before
acting, fail at the step with candidate diagnostics when nothing matches, and
error on ambiguity. Disambiguate with `exact: true` (case-sensitive),
`nth: <index>` (0-based), or a more specific name.

Use `focus` for custom comboboxes or controls that reveal their options on
focus without accepting a click. Use `wait.value` to poll a live control value
without an inline `eval`:

```yaml
- focus: { by: label, name: Country }
- wait:
    value: { by: label, name: Country, equals: United States }
    timeoutMs: 40000
```

`open` also takes an object form to wait out SPA hydration:

```yaml
- open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }
```

`request` makes an authenticated API call with the browser session's cookies
and captures the response for later steps. On the Playwright backend, request
steps run out of page through a browser-context cookie transport
(`APIRequestContext` when safe; an isolated Bun cookie bridge with a
parent-enforced timeout under Bun), so they share the browser context's cookie
jar and apply a real timeout. Backends without a native request primitive use a
bounded page-fetch fallback. Relative request URLs resolve against config
`baseUrl` when present, so request-first setup actions can run before any
`open` when `baseUrl` is configured:

```yaml
- request:
    method: POST
    url: /api/qr-token
    timeoutMs: 15000 # default: 30000
    expectStatus: 200
    assign: qr
- fill: { by: label, name: Scanner code, value: "${requests.qr.body.token}" }
```

Request steps also take `credentials: omit` (an anonymous call), headers
built from earlier responses (`authorization: "Bearer
${requests.login.body.token}"`), `until` polling with JSON matchers,
`retry` on 5xx or network failures, `capture` with JSONPath filters
(`$.tasks[?(@.title == "Report")].id` → `${requests.<name>.captures.<key>}`),
and `matrix` with `expectStatus` (one request per combination; the step lists
every mismatch). `use: login` signs a run in through the API with the
environment's `auth:` block (an `alreadyAuthenticated` probe, the login, OTP-like
follow-ups, an optional hydrate script) using provider secrets that never reach
artifacts. See [Steps](docs/steps.md#credentials-polling-retries-captures-and-matrices)
and [Configuration](docs/configuration.md#environment-login-auth).

Request-step calls are mirrored into run network evidence, so `network` and
`noFailedRequests` outcomes can assert on API calls made by the spec itself.
Native Playwright entries include a numeric epoch `timestamp` and, for valid
JSON bodies up to 64 KiB, sanitized `postData`. Sensitive JSON keys are
redacted; headers and opaque, invalid, or oversized bodies are never persisted.

`batch` runs a chain of selector interactions in **one** backend invocation
(agent-browser `batch --bail`), so transient UI state survives — e.g. a hover
that reveals a popover stays open long enough to click the button inside it.
Sub-steps are selector-only (`click`, `hover`, `fill`, `type`, `upload`,
`press`, `scroll`, `wait`); the first failing sub-step fails the step. Clicks
are paced by 100 ms, and checkbox/radio/switch clicks are state-verified with
a 300 ms post-action grace and one live-element recovery attempt (including
`aria-checked="mixed"`) so a dropped gesture cannot silently pass:

```yaml
- batch:
    - hover: { by: selector, selector: "#subcontractor-table" }
    - click:
        by: selector
        selector: '.table-header-hover-actions button[aria-label="Upload data"]'
```

Custom form controls are typed too: `set` / `check` / `uncheck` / `choose` /
`form` find a field (`field: <key>` through `browser.fieldRoot`, or any
locator), pick a widget driver (vue-multiselect, PrimeVue calendar and
autocomplete, radio and checkbox groups, pills, native controls, or a project
driver module), write the value in the page and read it back — the step fails
with evidence when the field did not commit:

```yaml
- form:
    fields:
      business_owner: "No"
      country: Spain
      start_date: "2026-11-30"
      legacy_supplier: { value: "No", optional: true }
- click: { by: role, role: button, name: Save, fallback: dispatch }
- fill: { by: label, name: Address line 1, value: 10 Main Street, mode: set }
```

See [Widgets](docs/widgets.md) or `cairn docs widgets`.

Control flow is typed too: `repeat: { max, until?, steps }` loops (≤ 100
iterations; `until` checked before each one), `if: { condition, then, else? }`
branches, `when: { var, equals | in | exists }` gates on config/spec/use-site
vars or runtime values, `wait: { any | all: [...] }` and `wait.optional`
(+ `assign` → `${waits.<name>.matched}`) probe without failing, and
`use: { action, retry: { times, until? } }` retries a flaky action as one
group. Nested steps keep stable ids and carry `parentId` / `iteration` /
`branch` in events and `run.json`:

```yaml
- id: load_all
  repeat:
    max: 20
    until: { text: All rows loaded }
    steps:
      - click: { by: role, role: button, name: Load more }
- id: banner
  if:
    condition: { selector: "#cookie-banner" }
    then:
      - click: { by: role, role: button, name: Accept }
```

Eval steps keep shrinking: a source that mentions `__cairn` gets a page
prelude first (`sleep`, `visible`, `text`, `labelOf`, `nativeSet`, `fire`,
`rows`, `waitFor`), installed once per document and never over a page-owned
`window.__cairn`. Config `browser.appHandle: { <name>: <page expression> }`
adds read-only accessors (`__cairn.app.store`), and `wait: { app: { path:
store.user.id, exists: true } }` waits on one without an eval loop. See
[Steps](docs/steps.md#page-prelude-and-app-handles), and the
[eval → typed step table](docs/steps.md#eval) for the step that replaces
each common eval pattern. The demo suite shows them working:
`examples/flows/08-conditional-step.yml` (control flow),
`13-widgets-form.yml` (widgets, click/fill flags, `wait.app`, the prelude),
`platform/32-api-login-v2.yml` (`use: login`, request v2) and
`platform/33-export-workbook.yml` (xlsx v2).

**Verifiers**

Outcome verifier keys:

`text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`,
`table`, `value`, `mongo`, `temporal`, `http`, `xlsx`, `file`, `httpJson`,
`process`, `script`.

Use typed verifiers for normal UI, URL, network, console, count, workbook,
on-disk checks (`file` polls a glob, e.g. a local email driver's capture
files), backend JSON state (`httpJson` fetches with browser cookies and
asserts a simple JSON path), and process metrics (`process` asserts on
`--monitor` RSS/CPU budgets). `mongo`, `temporal` and `http` check backend
state through named connections in the config `datasources:` block
(credentials stay in the runner and never reach the artifacts), `table`
reads a rendered table, and `value` asserts on anything the run already
holds (`${captures.*}`, `${requests.*}`, `${fixtures.*}`, …). Any verifier
takes `poll: { timeoutMs, everyMs, stableMs }` to wait for an eventual effect
— a background job, a worker, a webhook — with a bounded attempt log as
evidence. Use `script` (preferably a node verifier written with the verifier
SDK, `@thelacanians/cairntrace/verifier`) only when no typed verifier fits.

```yaml
outcomes:
  - id: job_completes
    description: the export job reaches done and stays done
    verify:
      http:
        source: api                      # datasources.api in the config
        url: "/api/jobs/${requests.job.body.id}"
        expect: { json: { status: done } }
      poll: { timeoutMs: 30000, everyMs: 500, stableMs: 2000 }
```

**Test data, readiness and cleanup**

- `fixtures:` in the config declares named test data once (`exec`, `mongo`
  or `http` adapters with `ensure` / `reset` / `verify` / `teardown`, scope
  `run`, `suite` or `seed`); a spec lists the fixtures it needs and splices
  `${fixtures.<name>.<key>}`. `cairn fixtures list|status|ensure|teardown|sweep`
  manages them from a shell, and shared or protected environments get a
  dry-run unless writes are allowed.
- `gates:` in the config names readiness probes (`http` with status/JSON/auth
  checks, `tcp`, `command`, `all` / `any`, `stable`). A spec waits on them in
  `preconditions.wait`; services and the webServer use them in `ready:`;
  `cairn wait <gate|url>` checks one from a shell.

**Config instead of wrapper scripts**

What a Taskfile or a `with-cairn.sh` did around `cairn run` is config, enforced
by the run engine for the CLI and for MCP alike (see
[Services](docs/services.md) and [Configuration](docs/configuration.md)):

- `run:` — `lock` (one run at a time per config; a live owner is exit 4, for
  `cairn services up | down | restart` too),
  `preflight` (a JSON `assert`, a `secret`, a `command` or a `gate` that must
  pass before any service starts), `verifyClean` (no leftover browsers, tmux
  session or compose containers after the run; dirty is exit 9) and `finally`
  commands. `services.teardown` entries with `critical: true` and the
  `services.provisioner` `down` always run, on SIGINT/SIGTERM too; a failed one
  is exit 8.
- `suites:` — `cairn run --suite <name> --env <env>` runs a named, ordered spec
  set with its vars, `processEnv`, `labels`, once-per-run `before` / `after`
  hooks, `parallel` and `bail` (per environment too; `--no-bail` overrides);
  `cairn suites list` shows what each resolves to and `cairn docs run-policy`
  maps a wrapper's jobs to config.
- `metrics:` — command or HTTP probes sampled around each spec into
  `diagnostics/metrics.json`, ready for `cairn stats --metric <name>.delta`.
- `services:` operations — `restart` / `logs`, tunnels, a provisioner
  (`up` / `down` / `exports`), atomic `files`, a phased seed transaction —
  and `requires: { cairntrace: <range> }` to pin the engine.

```yaml
run:
  lock: true
  preflight:
    - { secret: API_TOKEN }
    - { command: ./tools/check-quota.sh, expectExit: 0, timeout: 30s }
  verifyClean: [browsers]
suites:
  smoke: { specs: [flows/smoke], bail: true }
metrics:
  - { name: queue_depth, command: ./tools/queue-depth.sh, parse: { json: $.depth } }
```

Scope `text` / `notText` checks with nested `region`:

```yaml
verify:
  text:
    contains: dead
    region: '[data-testid="objective-ticker"]'
```

When a step fails before producing an artifact, outcomes that reference the
missing `${artifacts.<name>.…}` / `${requests.<name>.…}` report `skipped`
("blocked") instead of a misleading missing-file failure — fix the failed
step first.

**Timeouts and interrupts**

Cairn enforces a hard deadline on every browser-backend invocation (60s
default; a step's own `timeoutMs` plus a 5s grace period when set). A hung
browser command is killed and the step fails with a normal timeout error.
Playwright `wait` and browser `evaluate` paths also have a Cairntrace-side
deadline, defaulting to 30000ms unless the step supplies `timeoutMs`. For real
Chromium runs, an external watchdog process kills the browser at the deadline,
so navigation churn cannot starve the in-process timer and leave the run
waiting on Playwright forever.
Ctrl-C / SIGTERM during a run tears down the run's own agent-browser session
(daemon and Chrome) before exiting with the conventional 130/143 exit code.

**Config**

`cairntrace.config.yml` can provide `baseUrl`, environment vars, artifact root,
project settings, and the `services` lifecycle block. Validate it before use:

```bash
./bin/cairn config validate --config cairntrace.config.yml --json
```

The `services` block lets `cairn run` own the full multi-service environment
lifecycle — docker, conditional data seeding, tmux session management, and
teardown — all config-driven, started once before the spec pool and stopped
after the last spec. Skip it with `--no-services`.

```yaml
# cairntrace.config.yml
version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
secrets:
  provider: tvault
  keys: [MONGO_PASSWORD, ES_PASSWORD] # optional explicit allowlist
  required: [MONGO_PASSWORD, ES_PASSWORD]
  tvault: { project: myapp, identity: ci-reader }
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
    command: "yarn demo-import --mongoSourceUri mongodb://admin:${MONGO_PASSWORD}@host/db"
    ttlSeconds: 21600
    freshnessCheck: "mongosh --quiet --eval 'db.count()' mongodb://localhost:27017/db"
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
      - name: api
        cwd: web-api
        command: "yarn dev-watch"
        env: { PORT: "3001" }
        readyOn: { text: "listening on" }
  stash:
    enabled: true
    autoStash: always
    capture: [tmux, docker, seed]
    tags: [services, myapp]
  teardown:
    - "tmux kill-session -t myapp"
    - "docker compose down"
```

Seed freshness is tracked at `~/.cairntrace/services/<project>.seed.json`
with a three-layer check (fingerprint + TTL + optional data-level command).
The seed only re-runs when the command changed, the TTL expired, or the
freshness check failed. Placeholders such as `${vars.connectionPath}` resolve
before spec validation, so they can appear in required fields. Vars merge as
config environment vars < top-level spec `vars:` < repeatable CLI
`--var key=value`. Built-ins `${worker.index}` and `${run.token}` can derive
isolated users or tenants for realtime/stateful backends. For file paths,
`${project.root}` is the directory of the file being parsed (inside an
imported action, the action's directory) and `${config.dir}` is the directory
of the resolved `cairntrace.config.yml` (an explicit `--config`, else the one
found by walking up from the spec), so shared fixtures never need absolute
paths. The config itself supports YAML anchors and merge keys
(`<<: *shared`), top-level `vars:` shared by every environment,
`environments.<n>.extends`, vars built from other vars, typed (list /
object) vars and `include:` files; `cairn config validate` parses and
composes it exactly like a run, and `cairn config vars` lists each var's
value per environment, where it is defined and what uses it. An `--env` the
config does not define is
an error rather than a run without baseUrl or vars; a spec's own
`environment:` that the config lacks only warns.

TinyVault secrets are resolved once into an invocation-scoped environment.
Cairntrace requests only explicit `secrets.keys`, `secrets.required`, and keys
referenced as `${env.NAME}` or `${secrets.NAME}` in the root spec or imported
actions (plus the environment `auth:` block's `${secrets.NAME}` keys when a
flow uses `use: login`); it never exports an entire project to discover a value. They are
available to spec substitution,
preconditions, hooks, and the seed child process, but are never written into
Cairntrace's global `process.env`. Target children do not inherit `TVAULT_*`
client controls (unless that exact key is explicitly selected, or a services
phase or the `webServer` sets it in its own config `env:`). The MCP
`cairn_run` tool uses the same scope. `tvault.identity` is forwarded to the
selected-key value-resolution command; `cairn secrets` lists key names through
TinyVault metadata commands and never resolves plaintext values.

```yaml
version: 1
defaultEnvironment: local
retention:
  keepRuns: 20 # newest N runs per spec; pruned after every run
report:
  theme: cairn # cairn | slate | midnight | contrast
  colors:
    accent: "#0f766e"
    surface: "#fbfdf9"
browser:
  verifyAfterClick: true # same-tab link delivery guard (default: true)
  postClickSettleMs: 20000 # opt in to network-idle after every click
environments:
  local:
    baseUrl: http://localhost:${env.APP_PORT} # ${env.X} works in config text
    viewport: { width: 1280, height: 800 }
    vars:
      dashboardPath: /dashboard.html
      testUser: player-${worker.index}-${run.token}
```

Specs can also set a top-level `viewport: { width, height }`, which wins over
the environment's.

On agent-browser, same-tab links confirm URL, document, or DOM delivery by
default without waiting for network-idle. A positive click-step or top-level
spec `settleMs`, or config `browser.postClickSettleMs`, explicitly adds a
network-idle wait; click/spec values take precedence over config. Playwright
honors explicit click/spec values and otherwise keeps its native
action/navigation waits. Use `settleMs: 0` to skip both the extra settle and
the link-delivery probe at that scope.

**Per-environment services & secrets.** The `services` and `secrets` blocks
can be overridden per-environment inside `environments.<name>`. This lets you
run the full local stack (docker + seed + tmux) for `local`, but skip all
services for `dev` or `test` where the app is already deployed remotely:

```yaml
version: 1
environments:
  local:
    baseUrl: http://localhost:8080
  dev:
    baseUrl: https://dev.example.com
    services: false # no docker/seed/tmux — app is remote
  test:
    baseUrl: https://test.example.com
    services: false
    secrets: # different tvault project for test env
      provider: tvault
      tvault: { project: test-project }
```

When `services: false`, `cairn run --env dev` skips the entire lifecycle — no
need for `--no-services`. A partial `services:` block deep-merges over the
top-level one (e.g. override just the seed command, keep docker and tmux). An
env-level `secrets:` block replaces the top-level one entirely. Inside a
partial `services:` block, `tmux: false` drops only the inherited local tmux
windows while keeping the docker and seed phases.

Use the same config for validation and runs:

```bash
./bin/cairn spec verify flows/dashboard.yml --config cairntrace.config.yml --json
./bin/cairn run flows/dashboard.yml --config cairntrace.config.yml --cold-start --json
./bin/cairn snapshot /dashboard --config cairntrace.config.yml --json
```

Override vars per invocation without touching YAML:

```bash
./bin/cairn run flows/dashboard.yml --var baseUrl=http://localhost:3123 --var apiBase=http://localhost:3123/api
```

**Artifacts**

Every run writes a self-contained directory under `~/.cairntrace/runs/<run-id>/`
unless config or flags override the artifact root. The important files are:

```text
run.json | run.yaml | run.md
report.html
report.json
agent_context.md
artifact-manifest.json
replay.json
stash-receipt.json  # only after a stash (auto, `cairn stash save`, `pin --stash`)
publish-receipt.json  # only after `cairn publish`
events.ndjson
spec.resolved.yml
outcomes/<outcome-id>.md
snapshots/
screenshots/
console/
network/
downloads/
transforms/
requests/
evals/
diagnostics/
services/            # optional bounded service-log pack
traces/
videos/
```

`report.html` is a self-contained, print-friendly report for sharing or saving
as PDF. It includes summary cards, outcome/step tables, artifact links, and a
theme switcher. `report.json` exposes the same redacted report model for custom
renderers, including selected theme tokens and the built-in theme catalog.
Configure styling with `report.theme` and `report.colors` in
`cairntrace.config.yml`; Cairntrace does not require a separate report theme
configuration file.

`agent_context.md` is the compact handoff file for coding agents. Use
`./bin/cairn context latest` to print it. `context` and `diff` resolve
`latest`/`previous` inside `--artifact-root`, config `artifactRoot`, or the
global default, in that order.

Cairntrace-authored text and JSON artifacts are redacted before they are
written. Producer-owned outputs are not content-inspected: screenshots and
videos can show secrets or personal data, downloads/transforms/traces retain
their original content. Audit adds a post-extraction redaction pass for
vidtrace text formats, but extracted frames/images remain uninspected. Treat
the run directory as sensitive and review producer-owned captures before
sharing or stashing it. `artifact-manifest.json` labels every file with a
`sensitivity` (`redacted`, `safe`, `sanitized` or `secret-bearing`); stash,
the retention archive and `cairn publish` gate on it (see Stash Integration).

Disk usage is bounded by `retention.keepRuns` in the config (pruned after
every run) and by `cairn clean [--keep N | --all]`; `cairn pin <run>` keeps a
run out of pruning. Traces follow the `artifacts.capture.trace` policy — the
`on-failure` default deletes the trace when the run passes (Playwright writes
`traces/playwright-trace.zip`, agent-browser `traces/agent-browser-trace.json`,
a Chrome trace for Perfetto). Videos follow `artifacts.capture.video` (default
`never`) — opt in with `always` or `on-failure` for audit-grade `.webm`
recordings. When steps execute too quickly to audit, set
`artifacts.video.slowMo` (delay in ms between actions) and
`artifacts.video.speed` (playback speed multiplier 0.25–4; values < 1 slow
down via ffmpeg). The Playwright backend supports video natively; feed the
recording to `vidtrace extract` for timestamped evidence extraction.

### Stash Integration (fcheap)

Cairntrace run directories are self-contained — perfect for stashing to
[file.cheap](https://file.cheap) for persistence beyond Cairntrace retention
and cross-run search on the current machine. The local vault is not uploaded
or replicated automatically. Requires `fcheap` on `$PATH`.

```bash
# Stash the latest run
./bin/cairn stash save latest --tag regression

# List stashes
./bin/cairn stash list --tool cairntrace

# Search across all stashed runs
./bin/cairn stash search "redirected to /error"

# Restore a stash to a directory
./bin/cairn stash restore <stash-id> --to /tmp/run-restore
```

Auto-stash failed runs with `--stash-on-failure`:

```bash
./bin/cairn run flows/login.yml --stash-on-failure --cold-start
```

Or enable via config:

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
stash:
  enabled: true
  autoStash: on-failure # or never (default)
  tags: [regression, audit]
```

Successful auto-stash writes a redacted `stash-receipt.json`, appends an
`artifact.stash` event, and refreshes the local artifact manifest without
changing the finalized run result. The receipt excludes paths, stderr, and
failure messages.

The MCP server exposes `cairn_stash_save`, `cairn_stash_list`,
`cairn_stash_info`, `cairn_stash_restore`, and `cairn_stash_search`. Info and
restore validate file.cheap v0.30 output. An unverified restore is a structured
tool error that keeps the restore receipt for forensic review.

### Explicit remote publication

Local fcheap stashes and `ArtifactRefV1` records are not uploads. To publish a
pruned run to a remote fcheap provider, opt in explicitly:

```yaml
retention:
  keepRuns: 3
  publish: { enabled: true, retentionDays: 7 }
```

When enabled, Cairntrace rejects links and special files, packages the complete
run directory into a mode-0600 temporary `.tar.gz`, and calls `fcheap publish`
with that one regular file plus its content type, kind, and producer metadata.
`retentionDays` is required to remain between 1 and 31 days and defaults to
seven; Cairntrace passes the resulting fixed expiry to file.cheap so demo
evidence cannot become an unbounded remote-retention leak.
The compressed archive must fit the Cairntrace producer's 32 MiB file.cheap
publish quota, itself below file.cheap's 64 MiB global ceiling (Cairntrace also
bounds source input to 64 MiB); otherwise the local run is retained. Pruning is
authorized only after the strict `filecheap-publish/1` receipt reports
`server-sha256`, its SHA-256 and size match the exact archive bytes, and its
credential-free ArtifactRef is the canonical private `fcheap-cloud` URI for the
returned artifact with kind `cairntrace.run`.

`FILECHEAP_INGEST_TOKEN` is publisher-only: Cairntrace removes it from browser,
seed, hook, precondition, and ordinary fcheap child environments. The explicit
`fcheap publish` process receives only a small operating-system execution
allowlist, `FILECHEAP_ARTIFACT_SERVICE_URL`, and the ingest token; unrelated
database, Vercel, Blob, TinyVault, and application values are not forwarded.
Supply the token through the invoking environment, never Cairntrace config.
Signed URLs and administrator credentials are neither accepted nor printed. A
missing publish-capable fcheap binary, invalid receipt, unsafe/oversized
archive, or any publication failure retains the complete local run.

### Investigate & Audit (fcheap connect + vecgrep + vidtrace)

When a spec fails, `cairn investigate` stashes the run and runs `fcheap connect`
to surface `file:line` code candidates responsible for the failure using
[vecgrep](https://github.com/abdul-hamid-achik/vecgrep) semantic code search.
Requires `fcheap` and `vecgrep` on `$PATH`.

```bash
# After a failed run, find the responsible code
./bin/cairn investigate latest --codebase ~/projects/myapp

# With specific search mode and limit
./bin/cairn investigate latest --codebase ~/projects/myapp --mode semantic --limit 5

# Build or refresh the vecgrep index before connecting
./bin/cairn investigate latest --codebase ~/projects/myapp --index

# Stash without connecting
./bin/cairn investigate latest
```

`cairn audit` is a convenience wrapper that runs a spec with video, extracts
[vidtrace](https://github.com/abdul-hamid-achik/vidtrace) evidence from the
recording, and connects it to the codebase — all in one command:

```bash
# Run spec with video, extract evidence, connect to code
./bin/cairn audit flows/login.yml --codebase ~/projects/myapp --slow-mo 250 --speed 0.75
```

`audit` forces Playwright video capture and a cold browser by default. Passing
`--codebase` implies connection; `--connect` without a codebase uses the
configured default. Explicit CLI codebase paths resolve from the current
working directory; a relative configured `codebaseDir` resolves from the
config file. The browser audit does not require file.cheap or vecgrep unless
you request connection or enable failed-run auto-stash in config.

Configure defaults via config:

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
investigate:
  codebaseDir: ./src # default for `--connect`
  mode: hybrid # semantic | keyword | hybrid
  limit: 10 # max code matches
  index: false # build/refresh vecgrep before connecting
  autoInvestigate: never # on-failure | never
```

The MCP server exposes `cairn_investigate` and `cairn_audit` tools that mirror
the CLI. `investigate` needs file.cheap to save its input; `audit` can run
without it when stash and connection are not requested. Vidtrace remains
optional.

### Annotate & Secrets (codemap + TinyVault)

`cairn annotate` pins run evidence to a code graph symbol using
[codemap](https://github.com/abdul-hamid-achik/codemap) annotations, building a
knowledge layer of failure points that persists across reindexes. Requires
`codemap` on `$PATH`.

```bash
# After investigate surfaces src/auth/login.ts:42 as a failure point
./bin/cairn annotate src/auth/login.ts:42 \
  --source cairntrace \
  --note "login_flow spec fails: redirect to /error instead of /dashboard" \
  --run-id latest

# Annotate without a run reference
./bin/cairn annotate handleSubmit --note "flaky on cold start"

# Auto-annotate every run (pass + fail) into codemap with run context
./bin/cairn run flows/login.yml --auto-annotate on-run
```

`cairn secrets` reports the [TinyVault](https://github.com/abdul-hamid-achik/tinyvault)
provider status for authenticated specs and lists the secret **key names**
available to a target — values are never printed. Requires `tvault` on
`$PATH` (degrades to provider `env` without it).

```bash
# Provider status (is tvault installed? which provider is active?)
./bin/cairn secrets

# List secret key names in a project (direct mode)
./bin/cairn secrets --project myapp-test

# List secret key names for an environment group (inheritance mode)
./bin/cairn secrets --group mygroup --env test
```

Configure annotation and secret-provider defaults via config. The codebase
searched by codemap remains an explicit `--codebase` argument to
`cairn investigate`:

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
annotate:
  enabled: true
  autoAnnotate: on-run
  source: cairntrace

secrets:
  provider: tvault # env | tvault
  keys: [API_KEY] # explicit values a seed/hook may require
  required: [API_KEY]
  tvault:
    project: myapp-test # direct mode
```

The MCP server exposes `cairn_annotate` and `cairn_secrets_status` tools that
mirror the CLI. Both degrade gracefully when codemap/tvault aren't installed.

## CLI Reference

Common commands:

| Command                                        | Purpose                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cairn run <spec...>`                          | Run one or more specs or directories. Supports `--backend`, `--mock`, `--parallel`, `--cold-start`, `--config`, `--artifact-root`, `--var k=v`, `--junit`, and `--stamp-if-green`. Directory inputs expand `*.yml`/`*.yaml` recursively, skipping imported `actions/` directories and drafts (any folder or file starting with `_`, e.g. `flows/_drafts/`). |
| `cairn clean`                                  | Prune old run directories (`--keep N` per spec, or `--all`; honors `--config` and `--artifact-root`).                                                                                                                                                                                                              |
| `cairn spec verify <spec>`                     | Lint a spec without running it (schema, imports, cold-start, placeholder reference audit) and optionally stamp `contractHash` with `--stamp`. Honors `--config`/`--env`/`--var`; an `--env` the config does not define exits 4. |
| `cairn spec lint <spec...>`                    | Friendly findings with fix-its before a run (unquoted `#` selectors, schema per step, missing files, echo-only cold starts, fixture keys, literal secrets, evals with typed equivalents, host paths, shell placeholders, step ids, vars per `--env a,b`). `--fix` applies only safe edits. Exit 4 on any error. |
| `cairn spec finish <spec>`                     | Lint, then a cold-start run through the `cairn run` engine, stamping the contract when green; returns status, run dir, report and an `agent_context.md` summary. Takes `--no-web-server`, `--no-services`, `--artifact-root`, `--provider`, `--device`. |
| `cairn spec promote <draft>`                   | Move a draft out of the drafts directory after a green real-backend `spec finish` of its exact content (`--force` overrides; a mock finish does not count), rebasing relative paths, stamping the contract, and rolling back if the copy would point at a missing file. |
| `cairn init agent-kit`                         | Print (or `--write` into `AGENTS.md`) a short project section telling agents how to author specs here. |
| `cairn spec heal <spec>`                       | Run a spec and propose locator-drift fixes. Add `--apply` to write them, `--verify` to keep them only if a rerun passes. `--env`/`--config`/`--var` resolve like `cairn run` (vars, `browser:` block); MCP `cairn_spec_heal` takes the same inputs. |
| `cairn snapshot <url>`                         | Open a page and print role and test-id locator inventory (test ids scanned on `browser.testIdAttribute`). Relative URLs resolve through config `baseUrl`; config vars and `--var key=value` fill `${vars.X}` in the URL. |
| `cairn discover [url]`                         | Inspect a page and return the full accessibility tree + locator inventory. Supports `--roles`, `--testids`, `--wait-until`, `--env`, `--var`, `--headed`, `--mock`, `--backend`, `--config`, setup flags (`--use`, `--import`, `--from-spec`/`--until-step`, `--resume`) and `--snapshot-mode`/`--max-bytes`; leaves a session journal. `cairn discover sessions` lists journals; `cairn discover export --from-session` writes a spec from one. |
| `cairn catalog`                                | List what the project already has — actions, vars per environment, script verifiers, environments, flows, checkpoints. `--query` ranks rows by keyword; reads files only. |
| `cairn docs [topic]`                           | Return focused docs for `overview`, `authoring`, `steps`, `verifiers`, `downloads`, `scripts`, `artifacts`, `mcp`, `backends`, `stash`, `investigate`, `clip`, `annotate`, `secrets`, `services`, `fixtures`, `discovery`, `export`, `brief`, `catalog`, or `author-flow`.                                                                                |
| `cairn explain`                                | Return the current agent-facing command, step, verifier, and rule surface.                                                                                                                                                                                                                                         |
| `cairn diff <runA> <runB>`                     | Compare two runs by outcomes, steps, console, and network; supports `--config` and `--artifact-root`.                                                                                                                                                                                                              |
| `cairn checkpoint list/show/delete`            | Manage saved browser-state checkpoints.                                                                                                                                                                                                                                                                            |
| `cairn checkpoint capture-from-session <name>` | Save state from an existing `agent-browser` session.                                                                                                                                                                                                                                                               |
| `cairn login <name> --url <url>`               | Open a headed login flow and save a checkpoint.                                                                                                                                                                                                                                                                    |
| `cairn export playwright <spec\|dir>`          | Emit `@playwright/test` `.spec.ts`/`.spec.js` (`--lang`, `--out-dir`, `--project`, `--into` + `--host-config` + `--map`, `--target`, `--preconditions`, `--verifiers`, `--max-eval-ratio`, `--strict-locators`, `--config`/`--env`/`--var`, coverage report); `--check <dir>` detects drift, `--verify <dir>` proves it faithful (`--differential`, `--mutate`, `--verify-project`; own exit codes 0/1/2/3).                                                                                                                                                                                   |
| `cairn export brief <spec\|dir>`               | Emit an agent-neutral journey brief (what to fill, what to look for). `--from-run latest` attaches the last green run's resolved role/name. MCP: `cairn_export_brief` + `cairn_accompany_*`.                                                                                                                       |
| `cairn import playwright <file>`               | Convert a Playwright test (TypeScript AST: page objects, fixtures, helpers, `test.step` inlined) into reviewable Cairntrace YAML with coverage and TODO comments for what it cannot map; `cairn import playwright-trace <trace.zip>` turns a trace into a draft spec (`--force`, `--allow-empty`).                                                                                                                                                                                              |
| `cairn stash save <run-id>`                    | Stash a run directory to the fcheap vault for persistence and search. Supports `--tag`, `--tool`, `--source`.                                                                                                                                                                                                      |
| `cairn stash list`                             | List stashes, optionally filtered by `--tag` or `--tool`.                                                                                                                                                                                                                                                          |
| `cairn stash info <stash-id>`                  | Show detailed metadata and file list for a stash.                                                                                                                                                                                                                                                                  |
| `cairn stash restore <stash-id>`               | Restore a stash to a directory (`--to <dir>`).                                                                                                                                                                                                                                                                     |
| `cairn stash search <query>`                   | Search across all stashed runs. Supports `--mode keyword\|semantic\|hybrid` and `--limit`.                                                                                                                                                                                                                         |
| `cairn investigate <run-id>`                   | Stash a run and optionally run `fcheap connect` to find code responsible for failures. `--codebase` implies connect; supports `--connect`, `--query`, `--clips`, `--mode`, `--limit`, and `--index`.                                                                                                               |
| `cairn audit <spec>`                           | Run a cold Playwright audit with forced video capture, optional vidtrace extraction, and optional code connection. Supports `--codebase`, `--connect`, `--index`, `--speed`, `--slow-mo`, `--mode`, `--limit`, and `--no-cold-start`.                                                                              |
| `cairn clip <run-ref>`                         | Cut named clips from a run video using vidtrace. Supports repeatable `--label name=start-end`, `--out`, `--name`, `--reencode`, `--stash`, `--tag`.                                                                                                                                                                |
| `cairn annotate <symbol>`                      | Pin run evidence to a codemap code graph symbol. Supports `--source`, `--note`, `--data`, `--run-id`, `--codebase`.                                                                                                                                                                                                |
| `cairn secrets`                                | Check TinyVault provider status and list secret key names (`--project`, or `--group` + `--env`; values are never printed).                                                                                                                                                                                         |
| `cairn config validate`                        | Validate `cairntrace.config.yml` structure and cross-field rules. Supports `--config`, `--format json\|yaml\|md`. Exit 0 = valid, 4 = invalid.                                                                                                                                                                     |
| `cairn config vars`                            | List config vars: kind, effective value per environment (masked when secret-like), definitions (file:line), overrides and uses; dead vars with `--unused`. Supports `--config`, `--env`, `--unused`, `--used-by <spec>`, `--format json\|yaml\|md`. |
| `cairn services status`                        | Check the state of the services environment configured in config (docker containers, seed freshness, tmux session) and the `services up` lock. Supports `--config`, `--env`, `--project`.                                                                                                                         |
| `cairn services up` / `down`                   | Start the config services and leave them running under an owner lock (`cairn run --reuse-services` runs against them), or tear them down and remove the lock. Exit 4 while a live `cairn run` holds the config's `run.lock` (that run owns the stack). Supports `--config`, `--env`. |
| `cairn services restart <window...>` / `logs <window>` | Restart config tmux windows (Ctrl-C, wait for the exit, resend the command, wait for the new generation's `readyOn`; refuses windows the config does not own, exit 4) or read a window's redacted output (`--since-restart`, `--wait <regex>`, `--follow`). No `services exec`, on purpose. |
| `cairn doctor --orphans [--kill] [--yes] [--only]` | List the browser sessions cairn started whose `cairn run` is gone but whose browser survives (owned-session ledger, each pid checked by start time and command, never a process-table guess); `--kill` ends them after a confirmation or with `--yes`; `--only <session|pid,...>` limits it to what you confirmed. Exit 0 none, 1 some. |
| `cairn run --bail`                             | Stop scheduling the remaining specs after the first failed or errored one; they are reported as skipped (`skipped[]`, reason `bailed`) and the exit code follows the usual precedence over the specs that ran. Config `run:` (`lock`, `preflight`, `verifyClean`, `finally`) and critical teardown make a bare `cairn run` safe: exit 4 / 8 / 9 (see `cairn docs services`). |
| `cairn run --suite <name>`                     | Run a config `suites:` entry instead of spec paths: its specs (paths, directories, globs, spec names, tags) in order, the environment's vars, once-per-run before/after hooks (bounded, journaled, after-hooks on every exit path), `parallel` and `bail`. Spec paths next to it narrow it to those of its own specs (another path is exit 2). |
| `cairn suites list`                            | List the config suites with the specs each resolves to per environment (or why not); same rows as `cairn catalog --kind suites`. |
| `cairn wait <gate\|url...>`                    | Wait for readiness gates in order (config `gates:` names, `http(s)://` URLs needing 2xx/3xx, `tcp://host:port`). Exit 0 ready, 1 not ready. |
| `cairn fixtures <list\|status\|ensure\|reset\|teardown\|sweep>` | Manage the config fixtures registry from a shell: what exists per environment (the fixture ledger), ensure or reset one, tear down or sweep leftovers (`--apply`). |
| `cairn verifier schema <file>`                 | Print a node verifier's fixtures contract, read statically from its `defineVerifier` zod schema (never executed; `--load` imports it). |
| `cairn mcp`                                    | Start the MCP server on stdio. `--allow-hooks` accepts the before/after hooks a `cairn_run` request carries (config-declared hooks are trusted config); `--allow-services` lets MCP tools start config services and run their teardown.                                                                                                                                                                                                                             |

Structured output is available on commands wired with format flags:

```bash
./bin/cairn run examples/flows/01-dashboard-nav.yml --json
./bin/cairn snapshot /dashboard.html --config examples/cairntrace.config.yml --json
./bin/cairn import playwright tests/example.spec.ts --json
./bin/cairn spec verify examples/flows/01-dashboard-nav.yml --format yaml
./bin/cairn docs verifiers --json
./bin/cairn diff previous latest --format md
```

Commands with structured output today: `run`, `doctor`, `clean`, `explain`,
`docs`, `snapshot`, `diff`, `import playwright`, `import playwright-trace`, `spec verify`, `spec lint`,
`spec finish`, `spec promote`, `spec heal`, `init agent-kit`, `catalog`,
`config validate`, `config vars`, `wait`, `fixtures`, `verifier schema`, `checkpoint list`,
and `checkpoint show`.

Stable exit codes:

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| 0    | success                                                                                   |
| 1    | outcome failure                                                                           |
| 2    | errored (a [delegated runner](docs/delegate.md) that failed, timed out, went silent, or whose exit code the relayed evidence does not support included), or a command-line usage error (unknown flag or command, a missing subcommand — bare `cairn`, `cairn services` —, missing option value or argument, on every command); `--help` / `--version` exit 0 |
| 3    | cold-start gate                                                                           |
| 4    | lint or config error (spec lint/verify findings, unknown `--env`, a held or refused services lock, a services boot an MCP server may not do, a run refused by the config `run:` policy: live run lock, failed preflight, dirty machine before the run; `cairn services up / down / restart` while a live run holds that lock) |
| 5    | heal made no progress                                                                     |
| 6    | contract-hash mismatch                                                                    |
| 7    | refused by the environment policy (nothing ran, or any refusal under `--strict-requires`) |
| 8    | a critical teardown failed (`services.teardown` entry with `critical: true`); outranks every other code |
| 9    | dirty state after the run (`run.verifyClean` found a survivor); outranks the run's own code except 8 |

A delegated invocation (`environments.<n>.runner`) exits with its runner's code (0–9, or 130 / 143 when the remote side was interrupted) only when the evidence supports it: a 0 needs every planned run settled by a run directory of this invocation, consistent with the stream and the remote invocation's own summary; a 1 needs a run that failed. Otherwise it settles on 2 (or the code the evidence shows); see [Delegated runners](docs/delegate.md#exit-codes).

`cairn export playwright --verify` has its own table: 0 passed, 1 a gate / differential spec / mutant failed (or a refused spec), 2 usage or environment error, 3 inconclusive (nothing proven; never a pass). `--check` exits 0 fresh, 1 stale, 2 error. `cairn import` exits 0 written, 1 a draft that maps nothing was refused, 2 error (an existing `--out` without `--force`).

## MCP Integration

Run the stdio MCP server:

```bash
./bin/cairn mcp
```

Example MCP client config:

```json
{
  "mcpServers": {
    "cairntrace": {
      "command": "cairn",
      "args": ["mcp"]
    }
  }
}
```

The MCP server exposes these tools:

`cairn_explain`, `cairn_docs`, `cairn_doctor`, `cairn_run`, `cairn_run_status`,
`cairn_run_cancel`, `cairn_logs`, `cairn_context`,
`cairn_spec_scaffold`, `cairn_spec_verify`, `cairn_spec_lint`,
`cairn_spec_finish`, `cairn_spec_promote`, `cairn_spec_heal`, `cairn_catalog`,
`cairn_checkpoint_list`, `cairn_checkpoint_show`, `cairn_checkpoint_delete`,
`cairn_checkpoint_capture`, `cairn_snapshot`, `cairn_export_playwright`,
`cairn_export_verify`, `cairn_export_brief`, `cairn_import_playwright`,
`cairn_import_playwright_trace`, `cairn_pin`, `cairn_publish`,
`cairn_config_validate`, `cairn_services_status`, `cairn_services_up`,
`cairn_services_down`, `cairn_wait`, the `cairn_fixtures_*` tools (`list`,
`status`, `ensure`, `reset`, `teardown`, `sweep`), `cairn_stash_save`,
`cairn_stash_list`, `cairn_stash_info`, `cairn_stash_restore`,
`cairn_stash_search`, `cairn_investigate`, `cairn_audit`, `cairn_clip`,
`cairn_annotate`, `cairn_secrets_status`, the `cairn_accompany_*` tools
(`open`, `choose`, `status`, `list`, `close`), and the
`cairn_discover_*` tools (`open`, `resume`, `snapshot`, `interact`,
`navigate`, `inventory`, `network`, `suggest`, `remove_step`, `export`,
`close`, `list`) that drive a stateful, journaled browser session to explore,
record, and export a spec. The `author-flow` prompt holds the recipe from a
request to a promoted spec.

`cairn_run` and `cairn run` share one engine and one options schema: every
run flag is a `cairn_run` input under its camelCase name (`coldStart`,
`noServices`, `stampIfGreen`, `sinceCodemap`, …), config, the `browser:`
block, vars, secrets, services, hooks, post-run stash/investigate/annotate and
retention adapters all apply, and the result is the `--format json` document
(one aggregated BatchRunResult for `repeat`/`matrix`). Like `cairn run`, it
boots the config's webServer unless you pass `noWebServer`. Config services
(docker/seed/tmux) and their teardown start only on a server started as
`cairn mcp --allow-services` (or `CAIRN_MCP_ALLOW_SERVICES=1`); without it a
`cairn_run`, `cairn_spec_finish` or `cairn_audit` that would start them fails
with exit 4 before anything starts (pass `noServices` or `reuseServices`), and
`cairn_services_up` / `cairn_services_down` refuse. `wait: false` returns an `invocationId` at once;
poll `cairn_run_status` and `cairn_logs` (cursor-based slices of the live
logs) and stop it with `cairn_run_cancel`. `before`/`after` hooks a request
carries need `cairn mcp --allow-hooks` (a gate, not a sandbox: config-declared
hooks and other config and spec shell still run), and invocations that boot services or a webServer from the same
config run one at a time inside the server.

Agents should call `cairn_explain` once at session start, then `cairn_docs`
for the focused topic they need.

## Architecture

```text
spec YAML
  -> parseSpec + zod validation + config substitution + imports
  -> contract-hash check
  -> Runner
  -> BrowserBackend
       -> AgentBrowserAdapter
       -> PlaywrightAdapter
       -> MockBrowserBackend
  -> OutcomeEvaluator
  -> ArtifactWriter
```

The parser, runner, browser adapters, verifiers, and artifact writer are kept
separate so the core stays deterministic and testable.

## Advanced Workflows

- **Hybrid API + UI flows:** `request` uses the browser session's cookies,
  resolves relative URLs through config `baseUrl` when present, captures the
  response, and later steps splice fields via
  `${requests.<name>.body.<field>}` — e.g. fetch a QR token via API, then
  `fill` it into the scanner UI. Playwright runs request steps out of page with
  browser-context cookie sharing and a 30000ms default timeout; under Bun the
  cookie bridge runs in a subprocess so a stalled fetch cannot wedge the run.
- **Realtime/stateful isolation:** use `${worker.index}` and `${run.token}` in
  `vars:` to derive a unique user or tenant per spec run, e.g.
  `testUser: player-${worker.index}-${run.token}`.
- **Download artifacts:** `download` clicks a locator and saves the file under
  `downloads/`, optionally assigning it as `${artifacts.<name>.path}`.
- **Transform artifacts:** `transform` runs a Node-side script to turn a
  downloaded file into a new upload fixture under `transforms/`.
- **Workbook assertions:** `xlsx` reads a downloaded workbook without a
  script: text anywhere or per sheet, label/key header rows (present, absent,
  key → label, `includesInOrder` / `withinListInOrder` against a list or a
  captured table), data rows after the key row, cell values and number
  formats, and data validations by type and formula. Node verifiers get the
  same parser as `ctx.xlsx(path)`.
- **Custom assertions:** `script` runs browser or Node code and returns
  `{ ok, evidence }`.
- **Locator inventory:** `cairn snapshot <url> --json` returns role and
  `data-testid` locators before you author or repair steps.
- **Suite CI:** `cairn run flows --junit reports/cairn.xml` expands a
  directory of specs recursively, skips imported `actions/` and `_`-prefixed
  drafts, and writes JUnit XML for CI dashboards.
- **Contract stamping after proof:** `cairn run <spec-or-dir> --stamp-if-green`
  stamps `contractHash` only when every requested spec passes.
- **Playwright import:** `cairn import playwright <file>` walks the test's
  TypeScript AST (page objects, fixtures, helpers, `test.step`) into Cairntrace
  YAML with a coverage summary and TODO comments for what it cannot map;
  `cairn import playwright-trace <trace.zip>` turns a trace archive into a draft
  spec (credentials always `${secrets.X}`). Neither overwrites a file without
  `--force` nor writes a draft that maps nothing without `--allow-empty`
  (exit 1, with the TODOs that say why).
- **Playwright export:** `cairn export playwright <spec|dir> [--lang js|ts]
[--out-dir <dir>] [--project | --into <dir> [--host-config <playwright.config>] [--map <export.map.yml>]] [--target <name>] [--preconditions inline|global|skip|manifest] [--verifiers keep|gate|drop] [--max-eval-ratio <0..1>] [--config <path>] [--env <name>] [--var k=v]`
  emits `@playwright/test` `.spec.ts` or `.spec.js` with a coverage report
  (skips for constructs that cannot translate). `--config`/`--env`/`--var`
  resolve `${vars.*}`/`baseUrl` like `spec verify`; secrets, `${env.X}` (in
  the spec or the config: vars, `baseUrl`, `auth:`, datasources) and
  `${run.token}` are never inlined (env/RUN_TOKEN references instead); `runtime: node` file
  verifiers export via dynamic import; `--project` generates a structured
  project (`playwright.config.ts`, `global-setup.ts`, `actions/`,
  `verifiers/`, `fixtures/`, `tests/`, `README.md`) instead of standalone spec
  files. `--project`, `--into` and `--out-dir` exports write a
  `.cairn-export.json` manifest; `cairn export playwright --check <dir>`
  regenerates in memory and exits 1 when the committed export drifted from
  its specs, and `--verify <dir>` proves it faithful: static gates (sentinels,
  tsc with the target's tsconfig, the host's eslint, `playwright test --list`,
  freshness), `--differential` (`cairn run` and the exported test with the
  same `CAIRN_RUN_TOKEN`, verdicts and network evidence compared) and
  `--mutate` (an inverted assertion must fail); exit 0 pass / 1 failed / 2
  error / 3 inconclusive (nothing proven, e.g. no local tsc or Playwright —
  never a pass). `--into <dir> --host-config <playwright.config>` fits the
  output to an existing Playwright tree (config read statically, never run);
  `--map` binds actions to the host's fixtures and page objects; `--preconditions`
  decides whether `run:` steps, `teardown:`, fixtures and gates run inline, once
  in `global-setup`, or are only listed; `export.targets.<name>` in the config
  names a profile for `--target`. MCP: `cairn_export_playwright` (same code
  path), `cairn_export_verify`. Docs:
  `cairn docs export`.
- **Journey brief:** `cairn export brief <spec> [--from-run latest]` compiles
  operator instructions (what to fill, what to look for) when locators will
  not replay. MCP `cairn_export_brief` plus live try-then-ask
  `cairn_accompany_*`. Docs: `cairn docs brief`.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run format
bun run verify
```

The desktop app has its own gates, all wired to root scripts:

```bash
bun run desktop:test       # node:test over desktop/lib (argv, spawn/kill, artifacts)
bun run desktop:typecheck  # tsc --checkJs over the main-process surface
bun run desktop:smoke      # boots a hidden window and asserts every view mounts
```

Run `bun run verify` before pushing. If you touched the runner, heal flow, or
browser adapters, also smoke-test against the demo app in `examples/`.

More contributor guidance lives in [AGENTS.md](./AGENTS.md). That file is the
canonical instruction set for coding agents working in this repo.

## Release Policy

Cairntrace is distributed through SemVer git tags, GitHub releases, npm
(`@thelacanians/cairntrace`), and Homebrew (`abdul-hamid-achik/tap/cairntrace`).
The install guide does not hardcode a version — `brew upgrade cairntrace`
and `npm update -g @thelacanians/cairntrace` follow the newest tag.

The project follows SemVer tags (`vX.Y.Z`). All `v1.x.y` releases are
Cairntrace v1, so normal maintenance should add the next patch or minor tag
instead of rewriting old releases. Use patch releases for fixes, docs, and
polish; use minor releases for new non-breaking CLI/schema behavior; reserve
major releases for breaking contracts.

For a release, bump `package.json`'s `version`, run `bun run verify`, create an
annotated `vX.Y.Z` tag, push `main` and the tag, then create the GitHub release
with `gh release create`. The tag push publishes npm and updates the Homebrew
formula. Do not create a floating `latest` tag — GitHub keeps
`/releases/latest` pointed at the newest release automatically.

## Related

- [**chalupa.run**](https://chalupa.run) — by the same author: disposable
  DigitalOcean environments from Docker Compose (SSH-only, services bound to
  `127.0.0.1`) with a fleet console for status, test runs, and cost. Cairntrace
  specs run against chalupa-spawned stacks over an SSH tunnel.

## Security

See [SECURITY.md](./SECURITY.md). Short version: Cairntrace specs are trusted
code, like Playwright tests or shell scripts. Do not run specs from untrusted
sources, and only connect MCP clients you trust.

## License

[MIT](./LICENSE)
