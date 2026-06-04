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
`request`, `wait`, `press`, `scroll`, `snapshot`, `use`.

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
included) and captures the response for later steps:

```yaml
- request: { method: POST, url: /api/qr-token, expectStatus: 200, assign: qr }
- fill: { by: label, name: Scanner code, value: "${requests.qr.body.token}" }
```

**Verifiers**

Outcome verifier keys:

`text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`,
`xlsx`, `file`, `script`.

Use typed verifiers for normal UI, URL, network, console, count, workbook,
and on-disk checks (`file` polls a glob, e.g. a local email driver's capture
files). Use `script` when the assertion is product-specific or needs browser
or Node code.

**Config**

`cairntrace.config.yml` can provide `baseUrl`, environment vars, artifact root,
and project settings. Config-backed placeholders such as `${vars.connectionPath}`
resolve before spec validation, so they can appear in required fields.

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
```

Specs can also set a top-level `viewport: { width, height }`, which wins over
the environment's.

Use the same config for validation and runs:

```bash
./bin/cairn spec verify flows/dashboard.yml --config cairntrace.config.yml --json
./bin/cairn run flows/dashboard.yml --config cairntrace.config.yml --cold-start --json
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
`./bin/cairn context latest` to print it.

Disk usage is bounded by `retention.keepRuns` in the config (pruned after
every run) and by `cairn clean [--keep N | --all]`. Traces follow the
`artifacts.capture.trace` policy — the `on-failure` default deletes the trace
zip when the run passes.

## CLI Reference

Common commands:

| Command | Purpose |
| --- | --- |
| `cairn run <spec...>` | Run one or more specs. Supports `--backend`, `--mock`, `--parallel`, `--cold-start`, `--config`, `--artifact-root`, `--var k=v`. |
| `cairn clean` | Prune old run directories (`--keep N` per spec, or `--all`). |
| `cairn spec verify <spec>` | Lint a spec and optionally stamp `contractHash` with `--stamp`. |
| `cairn spec heal <spec>` | Run a spec and propose locator-drift fixes. Add `--apply` to write them. |
| `cairn context <run\|latest>` | Print the run's `agent_context.md`; add `--path` for the file path. |
| `cairn docs [topic]` | Return focused docs for `overview`, `authoring`, `steps`, `verifiers`, `downloads`, `scripts`, `artifacts`, `mcp`, or `backends`. |
| `cairn explain` | Return the current agent-facing command, step, verifier, and rule surface. |
| `cairn diff <runA> <runB>` | Compare two runs by outcomes, steps, console, and network. |
| `cairn checkpoint list/show/delete` | Manage saved browser-state checkpoints. |
| `cairn checkpoint capture-from-session <name>` | Save state from an existing `agent-browser` session. |
| `cairn login <name> --url <url>` | Open a headed login flow and save a checkpoint. |
| `cairn export playwright <spec>` | Emit an `@playwright/test` spec from a Cairntrace spec. |
| `cairn mcp` | Start the MCP server on stdio. |

Structured output is available on commands wired with format flags:

```bash
./bin/cairn run examples/flows/01-dashboard-nav.yml --json
./bin/cairn spec verify examples/flows/01-dashboard-nav.yml --format yaml
./bin/cairn docs verifiers --json
./bin/cairn diff previous latest --format md
```

Commands with structured output today: `run`, `doctor`, `clean`, `explain`,
`docs`, `diff`, `spec verify`, `spec heal`, `checkpoint list`, and
`checkpoint show`.

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
  cookies, captures the response, and later steps splice fields via
  `${requests.<name>.body.<field>}` — e.g. fetch a QR token via API, then
  `fill` it into the scanner UI.
- **Download artifacts:** `download` clicks a locator and saves the file under
  `downloads/`, optionally assigning it as `${artifacts.<name>.path}`.
- **Transform artifacts:** `transform` runs a Node-side script to turn a
  downloaded file into a new upload fixture under `transforms/`.
- **Workbook assertions:** `xlsx` verifies workbook sheet text and Excel data
  validation metadata.
- **Custom assertions:** `script` runs browser or Node code and returns
  `{ ok, evidence }`.
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

## Security

See [SECURITY.md](./SECURITY.md). Short version: Cairntrace specs are trusted
code, like Playwright tests or shell scripts. Do not run specs from untrusted
sources, and only connect MCP clients you trust.

## License

[MIT](./LICENSE)
