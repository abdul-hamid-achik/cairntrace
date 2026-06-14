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

Cairntrace is **not published to npm or GitHub Packages**. The supported
install path is cloning this repository and running it from source with Bun —
there is no build or compile step. Pin the
[latest release](https://github.com/abdul-hamid-achik/cairntrace/releases/latest)
or use `main`.

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
with `--backend playwright`, inspect Playwright traces, or export specs to
`@playwright/test`:

```bash
bunx playwright install chromium
```

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
`$PATH`.

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

## Core Concepts

**Cold-start contract**

Finished specs must replay from a fresh browser session. Use one of:

- imported login actions: `imports: [actions/login_admin.yml]` plus
  `steps: [{ use: login_admin }]`
- checkpoint restore: `session: { resume: <checkpoint-name> }`
- deterministic setup: `preconditions.commands`

Run `cairn run <spec> --cold-start --json` before declaring a spec done.

**Steps**

Current step keys:

`open`, `click`, `hover`, `fill`, `upload`, `download`, `transform`,
`request`, `wait`, `press`, `scroll`, `snapshot`, `use`, `batch`.

Interactive steps use locators with `by: role`, `by: label`, `by: text`, or
`by: selector`. Prefer role and label locators when possible; they are clearer
for humans and easier to heal.

Semantic locators are strict: they match accessible names (whole-name,
case-insensitive, visible elements only), scroll the target into view before
acting, fail at the step with candidate diagnostics when nothing matches, and
error on ambiguity. Disambiguate with `exact: true` (case-sensitive),
`nth: <index>` (0-based), or a more specific name.

`open` also takes an object form to wait out SPA hydration:

```yaml
- open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }
```

`request` makes an authenticated API call from the page (browser cookies
included) and captures the response for later steps. Relative request URLs
resolve against config `baseUrl` when present, so request-first setup actions
can run before any `open`; if the browser is still on `about:blank`, Cairntrace
first navigates to the request origin so the fetch has a real app origin:

```yaml
- request: { method: POST, url: /api/qr-token, expectStatus: 200, assign: qr }
- fill: { by: label, name: Scanner code, value: "${requests.qr.body.token}" }
```

`batch` runs a chain of selector interactions in **one** backend invocation
(agent-browser `batch --bail`), so transient UI state survives — e.g. a hover
that reveals a popover stays open long enough to click the button inside it.
Sub-steps are selector-only (`click`, `hover`, `fill`, `upload`, `press`,
`scroll`, `wait`); the first failing sub-step fails the step:

```yaml
- batch:
    - hover: { by: selector, selector: "#subcontractor-table" }
    - click:
        by: selector
        selector: '.table-header-hover-actions button[aria-label="Upload data"]'
```

**Verifiers**

Outcome verifier keys:

`text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`,
`xlsx`, `file`, `httpJson`, `script`.

Use typed verifiers for normal UI, URL, network, console, count, workbook,
on-disk checks (`file` polls a glob, e.g. a local email driver's capture
files), and backend JSON state (`httpJson` fetches with browser cookies and
asserts a simple JSON path). Use `script` when the assertion is
product-specific or needs browser or Node code.

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
Ctrl-C / SIGTERM during a run tears down the run's own agent-browser session
(daemon and Chrome) before exiting with the conventional 130/143 exit code.

**Config**

`cairntrace.config.yml` can provide `baseUrl`, environment vars, artifact root,
and project settings. Placeholders such as `${vars.connectionPath}` resolve
before spec validation, so they can appear in required fields. Vars merge as
config environment vars < top-level spec `vars:` < repeatable CLI
`--var key=value`. Built-ins `${worker.index}` and `${run.token}` can derive
isolated users or tenants for realtime/stateful backends.

```yaml
version: 1
defaultEnvironment: local
retention:
  keepRuns: 20 # newest N runs per spec; pruned after every run
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
agent_context.md
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
diagnostics/
traces/
```

`agent_context.md` is the compact handoff file for coding agents. Use
`./bin/cairn context latest` to print it. `context` and `diff` resolve
`latest`/`previous` inside `--artifact-root`, config `artifactRoot`, or the
global default, in that order.

Disk usage is bounded by `retention.keepRuns` in the config (pruned after
every run) and by `cairn clean [--keep N | --all]`. Traces follow the
`artifacts.capture.trace` policy — the `on-failure` default deletes the trace
zip when the run passes.

## CLI Reference

Common commands:

| Command | Purpose |
| --- | --- |
| `cairn run <spec...>` | Run one or more specs or directories. Supports `--backend`, `--mock`, `--parallel`, `--cold-start`, `--config`, `--artifact-root`, `--var k=v`, `--junit`, and `--stamp-if-green`. Directory inputs expand `*.yml`/`*.yaml` recursively, skipping imported `actions/` directories and `_*.yml` / `_*.yaml` drafts. |
| `cairn clean` | Prune old run directories (`--keep N` per spec, or `--all`; honors `--config` and `--artifact-root`). |
| `cairn spec verify <spec>` | Lint a spec and optionally stamp `contractHash` with `--stamp`. |
| `cairn spec heal <spec>` | Run a spec and propose locator-drift fixes. Add `--apply` to write them. |
| `cairn snapshot <url>` | Open a page and print role and `data-testid` locator inventory. Relative URLs resolve through config `baseUrl`. |
| `cairn context <run\|latest>` | Print the run's `agent_context.md`; add `--path`, `--config`, or `--artifact-root`. |
| `cairn docs [topic]` | Return focused docs for `overview`, `authoring`, `steps`, `verifiers`, `downloads`, `scripts`, `artifacts`, `mcp`, or `backends`. |
| `cairn explain` | Return the current agent-facing command, step, verifier, and rule surface. |
| `cairn diff <runA> <runB>` | Compare two runs by outcomes, steps, console, and network; supports `--config` and `--artifact-root`. |
| `cairn checkpoint list/show/delete` | Manage saved browser-state checkpoints. |
| `cairn checkpoint capture-from-session <name>` | Save state from an existing `agent-browser` session. |
| `cairn login <name> --url <url>` | Open a headed login flow and save a checkpoint. |
| `cairn export playwright <spec>` | Emit an `@playwright/test` spec from a Cairntrace spec. |
| `cairn import playwright <file>` | Convert common Playwright steps and assertions into reviewable Cairntrace YAML with TODO comments for unmapped lines. |
| `cairn mcp` | Start the MCP server on stdio. |

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
`docs`, `snapshot`, `diff`, `import playwright`, `spec verify`, `spec heal`,
`checkpoint list`, and `checkpoint show`.

Stable exit codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | outcome failure |
| 2 | errored |
| 3 | cold-start gate |
| 4 | lint failure |
| 5 | heal made no progress |
| 6 | contract-hash mismatch |

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

The MCP server exposes 11 tools:

`cairn_explain`, `cairn_docs`, `cairn_doctor`, `cairn_run`, `cairn_context`,
`cairn_spec_scaffold`, `cairn_spec_verify`, `cairn_spec_heal`,
`cairn_checkpoint_list`, `cairn_checkpoint_show`, `cairn_checkpoint_delete`.

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

- **Hybrid API + UI flows:** `request` fetches with the browser session's
  cookies, resolves relative URLs through config `baseUrl` when present,
  captures the response, and later steps splice fields via
  `${requests.<name>.body.<field>}` — e.g. fetch a QR token via API, then
  `fill` it into the scanner UI.
- **Realtime/stateful isolation:** use `${worker.index}` and `${run.token}` in
  `vars:` to derive a unique user or tenant per spec run, e.g.
  `testUser: player-${worker.index}-${run.token}`.
- **Download artifacts:** `download` clicks a locator and saves the file under
  `downloads/`, optionally assigning it as `${artifacts.<name>.path}`.
- **Transform artifacts:** `transform` runs a Node-side script to turn a
  downloaded file into a new upload fixture under `transforms/`.
- **Workbook assertions:** `xlsx` verifies workbook sheet text and Excel data
  validation metadata.
- **Custom assertions:** `script` runs browser or Node code and returns
  `{ ok, evidence }`.
- **Locator inventory:** `cairn snapshot <url> --json` returns role and
  `data-testid` locators before you author or repair steps.
- **Suite CI:** `cairn run flows --junit reports/cairn.xml` expands a
  directory of specs recursively, skips imported `actions/` and `_`-prefixed
  drafts, and writes JUnit XML for CI dashboards.
- **Contract stamping after proof:** `cairn run <spec-or-dir> --stamp-if-green`
  stamps `contractHash` only when every requested spec passes.
- **Playwright import:** `cairn import playwright <file>` converts common
  Playwright actions and assertions to Cairntrace YAML, preserving TODO
  comments for unmapped lines that need human review.
- **Playwright export:** `cairn export playwright <spec>` emits a normal
  `@playwright/test` file when a Cairntrace spec is stable enough for CI.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run format
bun run verify
```

Run `bun run verify` before pushing. If you touched the runner, heal flow, or
browser adapters, also smoke-test against the demo app in `examples/`.

More contributor guidance lives in [AGENTS.md](./AGENTS.md). That file is the
canonical instruction set for coding agents working in this repo.

## Release Policy

Cairntrace is distributed through git tags and GitHub release pages only; it is
not published to npm or GitHub Packages. The install guide intentionally
doesn't hardcode a version because users can pin the newest tag with
`git tag --sort=-v:refname`.

The project follows SemVer tags (`vX.Y.Z`). All `v1.x.y` releases are
Cairntrace v1, so normal maintenance should add the next patch or minor tag
instead of rewriting old releases. Use patch releases for fixes, docs, and
polish; use minor releases for new non-breaking CLI/schema behavior; reserve
major releases for breaking contracts.

For a release, bump `package.json`'s `version`, run `bun run verify`, create an
annotated `vX.Y.Z` tag, push `main` and the tag, then create the GitHub release
with `gh release create`. Do not create a floating `latest` tag — GitHub keeps
`/releases/latest` pointed at the newest release automatically.

## Security

See [SECURITY.md](./SECURITY.md). Short version: Cairntrace specs are trusted
code, like Playwright tests or shell scripts. Do not run specs from untrusted
sources, and only connect MCP clients you trust.

## License

[MIT](./LICENSE)
