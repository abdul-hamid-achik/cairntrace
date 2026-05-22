# Cairntrace

> Mark the path, replay the browser, hand the trace to the agent.

**A local-first behavioral browser-spec layer for coding agents.** You write
`intent + outcomes` in YAML; agents (Claude Code, Codex, Cursor, OpenCode,
whatever ships next) execute, capture, and heal those specs against a real
browser through [`agent-browser`](https://agent-browser.dev) or
[Playwright](https://playwright.dev). Cairntrace is **agent-neutral** — no
per-agent code paths, just a CLI + MCP server any agent can call.

```yaml
# A Cairntrace spec — the contract is intent + outcomes; steps are repairable hints.
version: 1
name: import_xlsx_invoices
intent: |
  An admin uploads sample.xlsx via the Invoices > Import flow. The invoice list
  shows all rows with correct totals and one audit-log entry per row.

outcomes:
  - id: invoice_count_visible
    verify: { text: { contains: "Showing 42 invoices" } }
  - id: import_request_succeeded
    verify:
      network: { method: POST, urlContains: /api/invoices/import, status: { in: [200, 201] } }
  - id: no_console_errors
    verify: { console: { errorsMax: 0 } }

steps:
  - use: login_admin
  - open: /invoices
  - click: { by: role, role: button, name: Import }
  - hover: { by: selector, selector: ".question-table-wrap .table-title" }
  - upload: { by: label, name: Upload file, path: ./fixtures/sample.xlsx }
  - wait: { text: "Import complete", timeoutMs: 30000 }
```

```bash
cairn run flows/import_xlsx_invoices.yml          # → exit 0/1, structured artifacts
cairn spec heal flows/import_xlsx_invoices.yml    # ← UI drifted? patch the locator
cairn export playwright flows/import_xlsx_invoices.yml  # eject to a real Playwright test
```

---

## Why

Agents are good at writing code and bad at clicking 40 buttons to verify their
own changes. Manual E2E in a complex repo is the bottleneck.

Cairntrace lets an agent (or you) define **what success looks like** —
behavioral outcomes against the real DOM and network — separate from **how
to get there**. The agent picks the steps; the runner verifies the outcomes;
when the UI drifts, `cairn spec heal` rewrites the steps from the
accessibility-tree snapshot. The contract (`intent + outcomes`) is preserved
mechanically via a sha256 stamp, so heal can't quietly change what the spec
asserts.

The same spec runs across two backends:

- **`agent-browser`** (default) — AI-native browser CLI, semantic locators,
  compact accessibility snapshots, optimized for token efficiency.
- **`playwright`** — full Playwright runtime, native traces + HAR + video,
  Trace Viewer integration.

And the same spec can be **exported to a real `@playwright/test` `.spec.ts`**
once it's stable, giving you CI lock-in (sharding, retries, HTML reports)
without rewriting anything.

## Three pillars

| Pillar | What it solves |
|---|---|
| **Feature development driver** | Author + iterate on a spec while building a feature. The spec acts as both the acceptance check and the regression test. `cairn run` is the inner loop. |
| **Manual-E2E replacement** | Have a complex repo with no E2E suite? Write 10 behavioral specs instead of standing up Playwright + fixtures + page objects + CI. Eject stable specs to Playwright later via `cairn export`. |
| **Bug repro + agent handoff** | Reach a bug state, capture the full artifact pack (DOM, network, console, screenshots, trace), hand the run id to any agent. `agent_context.md` is the universal interface — no per-agent prompt template. |

## Install

Cairntrace runs on [**Bun 1.3+**](https://bun.com). The `cairn` binary is a
bun-shebang TypeScript file — no compile step in v1. A compiled
Node-compatible distribution is a v1.x goal.

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
bun install

# Optional: install one of the browser backends
brew install vercel-labs/agent-browser/agent-browser   # default; see https://agent-browser.dev
# or
bunx playwright install chromium                       # for `--backend playwright`

# Verify the environment
./bin/cairn doctor
```

`./bin/cairn` works from this directory; to use `cairn` anywhere, symlink it
to a location on your `$PATH`.

You do not need Playwright's browser binary for the default `agent-browser`
backend. Install Chromium through Playwright only when you plan to run
`--backend playwright`, debug with Playwright-native traces, or validate a spec
before exporting it to `@playwright/test`.

## Quickstart

```bash
# 1. Start the demo app
bun examples/demo-app/server.ts          # listens on :8787

# 2. Run an example spec
./bin/cairn run examples/flows/01-dashboard-nav.yml

#   ✓ open_home (483ms)
#   ✓ click_open_dashboard (446ms)
#   ✓ wait_for_dashboard (425ms)
#
#   Outcomes (3)
#     ✓ url_is_dashboard
#     ✓ dashboard_heading_visible
#     ✓ no_console_errors
#
#   ✓ PASSED  3/3 outcomes  3.5s

# 3. Inspect the agent-readable handoff
./bin/cairn context latest
```

Try `--backend playwright`, `--mock` (in-memory), `--json` (for agents), or
`--parallel 4` (against multiple specs at once).

## Concepts

### Intent + outcomes is the contract

```yaml
intent: |
  When an admin clicks "Import" and uploads sample.xlsx, the invoice list shows
  all rows from the file.

outcomes:
  - id: invoice_count_visible
    description: invoice list shows 42 rows after import
    verify:
      text: { contains: "Showing 42 invoices" }
```

The spec gets a `contractHash:` stamped over `intent + outcomes` by
`cairn spec verify --stamp`. `cairn spec heal` may rewrite **steps** but
refuses to touch `intent` or `outcomes` without that diff being seen by a
human at PR review.

### Steps are repairable hints

```yaml
steps:
  - use: login_admin                       # imported reusable action
  - open: /invoices                        # baseUrl prepended from config
  - click: { by: role, role: button, name: Import }
  - hover: { by: selector, selector: ".question-table-wrap .table-title" }
  - upload: { by: label, name: Upload file, path: ./fixtures/sample.xlsx }
  - download: { by: role, role: button, name: Download template, saveAs: template.xlsx, assign: template }
  - wait: { text: "Import complete", timeoutMs: 30000 }
  - id: settle
    when: urlContains:/imported            # conditional execution
    open: /invoices?refresh=1
```

If the button gets renamed `Import → Import xlsx`, the spec breaks. Run
`cairn spec heal` — it reads the snapshot, finds the new name, and rewrites
the step (preserving YAML comments). Comments survive.

### Config variables resolve before validation

Specs can put config-backed variables in schema-required fields. Cairntrace
loads `cairntrace.config.yml`, resolves the environment, merges environment
vars with caller vars, then parses the spec.

```yaml
# flows/table-import.yml
steps:
  - open: "${vars.connectionPath}"
```

```yaml
# cairntrace.config.yml
version: 1
defaultEnvironment: local
environments:
  local:
    baseUrl: http://localhost:8080
    vars:
      connectionPath: /connection/abc
```

Use the same config path for validation and runs:

```bash
cairn spec verify flows/table-import.yml --config cairntrace.config.yml --json
cairn run flows/table-import.yml --config cairntrace.config.yml --cold-start --json
```

Missing `${vars.X}` placeholders fail with a clear parse error instead of being
silently replaced by an empty string. `contractHash` remains based on the raw
`intent + outcomes` contract, so hashes do not change across environments.

### The v0 verifier vocabulary

Eight typed verifiers plus an escape hatch. Promote `script` patterns to
typed verifiers when 3+ specs need them.

| Verifier | What it checks |
|---|---|
| `text` | text appears in a region (page-wide or a selector) |
| `notText` | text does NOT appear |
| `url` | URL equals / startsWith / endsWith / matches |
| `network` | at least one matching request (method + urlContains + status) |
| `noFailedRequests` | no 4xx/5xx for requests matching a pattern |
| `console` | `errorsMax: N` — bounded console + pageerror events |
| `count` | N elements match (`role` or `selector` in optional `in_region`) |
| `script` | escape hatch: page-evaluated JS returning `{ ok, evidence }` |

`script` supports either inline `run:` or an external JS/TS body via `file:`.
External files resolve relative to the spec file. Download steps can expose
named artifacts to scripts with `${artifacts.<name>.path}`.

```yaml
outcomes:
  - id: template_shape
    verify:
      script:
        file: ./verifiers/check-template.ts
        fixtures:
          templatePath: ${artifacts.template.path}
steps:
  - download:
      by: role
      role: button
      name: Download template
      saveAs: template.xlsx
      assign: template
```

Each outcome writes a structured `outcomes/<id>.md` evidence file (≤80 lines,
fixed shape) that agents can drop straight into context.

### Cold-start contract

Specs must replay from a clean browser. Satisfy with one of:

1. `imports:` a reusable login action + `steps: [{ use: login_admin }]`
2. `session: { resume: <checkpoint-name> }` (captured by
   `cairn checkpoint capture-from-session` or `cairn login`)
3. `preconditions.commands` to seed the database

`cairn run --cold-start` (auto-on in CI) wipes cookies + localStorage +
sessionStorage before the first step.

## Heal demo

```bash
# 0. The action in examples/actions/open_dashboard.yml is intentionally drifted —
#    the click locator says name="Dashboard link" but the page has "Open dashboard".

# 1. Run — fails (locator not found, URL outcome doesn't hold)
./bin/cairn run examples/flows/09-imported-drift.yml --backend playwright

# 2. Heal — reads the snapshot, proposes the right name
./bin/cairn spec heal examples/flows/09-imported-drift.yml --backend playwright
#   ▸ patch proposed: replace /steps/1/click/name from "Dashboard link" to "Open dashboard"
#     why: snapshot shows role=link with name="Open dashboard" (1 candidate)

# 3. Apply — patches the ACTION FILE (open_dashboard.yml), comments preserved
./bin/cairn spec heal examples/flows/09-imported-drift.yml --apply --backend playwright

# 4. Re-run — passes
./bin/cairn run examples/flows/09-imported-drift.yml --backend playwright
```

Heal follows the **origin** of the failed step. If the drifted step lives
inside an imported action, the patch lands in the action file, not the spec
that imported it.

## Diff two runs

```bash
./bin/cairn diff previous latest
```

```
# Diff: a5286e → a59ccd

## Overall
- Status: passed → failed (changed)
- Duration: 5.1s → 2.9s (−2.2s)

## Outcomes
- ✗→✓ price_displayed
- ✓→✗ checkout_request_succeeded

## Network
- Failures: +1 (1 new)
  - POST /api/checkout → 500
```

`<runA> <runB>` can be run ids, absolute paths, or the literal
`latest` / `previous` against `~/.cairntrace/runs/`. Pairs well with CI
post-mortems and `cairn run` re-runs.

## CLI reference

| Command | What it does |
|---|---|
| `cairn run <spec...>` | Run one or more behavioral specs. Streams ✓/✗ live in a TTY; multi-spec mode emits a `BatchRunResult`. |
| `cairn run --parallel N` | Run N specs concurrently, each in its own browser session. |
| `cairn run --backend agent-browser \| playwright \| mock` | Select the backend. Mock is for tests/demos. |
| `cairn run --cold-start` | Wipe cookies + storage before steps. Auto-on when `CI=true`. |
| `cairn doctor` | Check Node/Bun/agent-browser/artifact-dir health. |
| `cairn explain` | Return the full agent-facing surface (commands + verifiers + rules + config) as structured data. |
| `cairn docs [topic]` | Return focused agent docs for `overview`, `authoring`, `steps`, `verifiers`, `downloads`, `scripts`, `artifacts`, `mcp`, or `backends`. |
| `cairn context <run\|latest> [--path]` | Print or locate the run's `agent_context.md`. |
| `cairn spec scaffold <name> --intent ...` | Write a starter spec YAML with the cold-start header. |
| `cairn spec verify <spec> [--stamp] [--env <name>] [--config <path>]` | Lint the spec; `--stamp` writes a fresh raw-contract `contractHash:`. |
| `cairn spec heal <spec> [--apply]` | Propose selector-drift fixes from the snapshot. `--apply` writes them (comments preserved). |
| `cairn checkpoint capture-from-session <name> --session <ab-session>` | Save state of an existing agent-browser session. |
| `cairn checkpoint list / show / delete` | Manage saved checkpoints. |
| `cairn login <name> --url ... [--wait-for text:\|url:]` | Open a headed browser, let the user log in, capture state into a checkpoint. |
| `cairn diff <runA> <runB>` | Structurally compare two runs — outcomes, steps, console, network. |
| `cairn export playwright <spec> [--out <file>]` | Emit a real `@playwright/test` `.spec.ts` from a stable spec for CI lock-in. |
| `cairn mcp` | Start the MCP server on stdio. |

Every agent-callable command supports `--format json|yaml|md` (or `--json`,
`--yaml`, `--md` shorthand).

**Exit codes** are stable across versions:

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | outcome failure (run completed; contract didn't hold) |
| 2 | errored (crash, parse failure, FS error) |
| 3 | cold-start gate failed |
| 4 | lint failed |
| 5 | heal-no-progress |
| 6 | contract-hash mismatch |

## MCP integration

Add Cairntrace to any MCP-aware agent (Claude Code, Cursor, Windsurf, etc.):

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

Eleven tools exposed, all returning `content` (text summary) + `structuredContent`
(JSON matching the v1 wire schemas):

| Tool | Maps to |
|---|---|
| `cairn_explain` | `cairn explain` |
| `cairn_docs` | `cairn docs` |
| `cairn_doctor` | `cairn doctor` |
| `cairn_run` | `cairn run` |
| `cairn_context` | `cairn context` |
| `cairn_spec_scaffold` | `cairn spec scaffold` |
| `cairn_spec_verify` | `cairn spec verify` |
| `cairn_spec_heal` | `cairn spec heal` |
| `cairn_checkpoint_list` | `cairn checkpoint list` |
| `cairn_checkpoint_show` | `cairn checkpoint show` |
| `cairn_checkpoint_delete` | `cairn checkpoint delete` |

Agents that don't speak MCP use the same surface via the shell CLI — the
output is identical.

For agent bootstrapping, call `cairn_explain` first, then call `cairn_docs`
for the topic the agent is about to work on. This keeps docs fetches small:

```bash
cairn explain --json
cairn docs steps --json
cairn docs authoring --json
cairn docs downloads --json
cairn docs backends --json
```

## Wire contract (v1)

The CLI + MCP outputs are stable across v1.x. Six v1 schemas:

| URN | Source | Emitted by |
|---|---|---|
| `urn:cairntrace.dev:run:v1` | [`run.v1.ts`](./src/core/schema/run.v1.ts) | `cairn run` (single spec) |
| `urn:cairntrace.dev:run-batch:v1` | [`runBatch.v1.ts`](./src/core/schema/runBatch.v1.ts) | `cairn run --parallel` (multi-spec) |
| `urn:cairntrace.dev:heal:v1` | [`heal.v1.ts`](./src/core/schema/heal.v1.ts) | `cairn spec heal` |
| `urn:cairntrace.dev:explain:v1` | [`explain.v1.ts`](./src/core/schema/explain.v1.ts) | `cairn explain` + MCP `cairn_explain` |
| `urn:cairntrace.dev:docs:v1` | [`docs.v1.ts`](./src/core/schema/docs.v1.ts) | `cairn docs` + MCP `cairn_docs` |
| `urn:cairntrace.dev:diff:v1` | [`diff.v1.ts`](./src/core/schema/diff.v1.ts) | `cairn diff` |

Plus the YAML spec format itself ([`spec.v1.ts`](./src/core/schema/spec.v1.ts))
and the verifier union ([`verifier.v1.ts`](./src/core/schema/verifier.v1.ts)).

Schemas are zod-first; TypeScript types come from `z.infer`. Schemas are
currently `urn:` IDs (no published JSON Schema file yet); v1.x will host
fetchable JSON Schemas without changing the wire format.

## Artifact layout

Each run produces a fully self-contained directory:

```
~/.cairntrace/runs/<run-id>/
  run.{json,yaml,md}          # canonical result in three formats
  agent_context.md            # narrative summary for agent handoff
  events.ndjson               # streaming run log
  spec.resolved.yml           # spec after imports + var substitution
  outcomes/
    results.{json,yaml,md}    # per-outcome summary
    <outcome-id>.md           # §13b evidence file (≤80 lines, fixed shape)
    <outcome-id>.raw.json     # script-verifier deep data (when present)
  snapshots/<NN>_<step>.txt   # accessibility tree per step
  screenshots/<NN>_<step>.png # on-failure or always-on per spec policy
  console/console.ndjson, errors.ndjson
  network/requests.ndjson, failed_requests.ndjson
  downloads/<file>           # files captured by download steps
  diagnostics/<NN>_<step>.json # failed-step UI diagnostics
  traces/<backend>-trace.zip  # Playwright Trace Viewer compatible
```

View the trace: `bunx playwright show-trace <runDir>/traces/<backend>-trace.zip`

## Architecture

```
behavioral spec (intent + outcomes + steps + imports)
        ↓ parser + validator (zod, comment-preserving YAML, origin tracking)
        ↓ contract-hash check
config-aware Runner (cairntrace.config.yml resolves baseUrl + vars per env)
        ↓ runs each step against
BrowserBackend interface
        ↓ implemented by
        ├── AgentBrowserAdapter   (default; AI-native compact snapshots)
        ├── PlaywrightAdapter     (full traces, HAR, ariaSnapshot)
        └── MockBrowserBackend    (tests + `--mock`)
        ↓ evaluates outcomes via
OutcomeEvaluator + 8 verifiers
        ↓ produces
ArtifactWriter → run.{json,yaml,md} + agent_context.md + evidence + events
                + trace.zip + snapshots/screenshots/console/network
```

The CLI surface + the artifact format + the MCP tools are the agent
interface. Cairntrace ships no per-agent code paths.

## Examples

A tiny end-to-end demo in [`examples/`](./examples) with a static + JSON
server and nine spec YAMLs covering every v0 verifier, the heal flow, and
imported-action drift. See [`examples/README.md`](./examples/README.md) for
the walkthrough.

| Spec | Demonstrates |
|---|---|
| `01-dashboard-nav.yml` | open → click → URL + text + console outcomes |
| `02-row-count.yml` | `count` verifier + `noFailedRequests` |
| `03-network.yml` | `network` verifier against a real fetch |
| `04-script.yml` | `script` escape hatch (DOM-evaluated JS) |
| `05-detects-broken-api.yml` | proves `noFailedRequests` catches 500s (designed to fail) |
| `06-drifted-link.yml` | UI drift; `cairn spec heal` demo |
| `07-config-driven.yml` | `cairntrace.config.yml` baseUrl + `${vars.X}` |
| `08-conditional-step.yml` | `when:` predicate skips redundant steps |
| `09-imported-drift.yml` | drift inside an imported action — heal patches the action file |

## Development

```bash
bun install            # install deps
bun run typecheck      # tsc --noEmit
bun run test           # vitest (125 tests across 16 files)
bun run lint           # oxlint
bun run format         # oxfmt src bin
bun run verify         # typecheck + lint + tests (the gate)
```

Layout summary in [`AGENTS.md`](./AGENTS.md), which is the canonical
instruction set for any coding agent working in this repo.
[`CLAUDE.md`](./CLAUDE.md) is the Claude Code-specific overlay.

## Stack

- [**Bun**](https://bun.com) — runtime + package manager
- [**TypeScript**](https://www.typescriptlang.org) — typed source
- [**Zod**](https://zod.dev) — runtime schema validation (TS types derived via `z.infer`)
- [**Vitest**](https://vitest.dev) — tests
- [**Oxlint**](https://oxc.rs/docs/guide/usage/linter.html) + [**Oxfmt**](https://oxc.rs/docs/guide/usage/formatter/quickstart) — lint + format (Rust-based, fast)
- [**yaml**](https://eemeli.org/yaml/) — comment-preserving YAML
- [**agent-browser**](https://agent-browser.dev) — default execution backend
- [**Playwright**](https://playwright.dev) — alternate execution backend
- [**@modelcontextprotocol/sdk**](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — MCP server
- [**Commander**](https://github.com/tj/commander.js) — CLI parser
- [**execa**](https://github.com/sindresorhus/execa) — subprocess helper

## Security

See [SECURITY.md](./SECURITY.md). Short version: **Cairntrace specs are
trusted code, just like a Playwright test file or a shell script.** Don't run
specs from untrusted sources. The MCP server widens the trust boundary to
"any process speaking MCP over stdio" — only connect MCP clients you trust.

## Roadmap (v1.x)

Not blocking v1.0 — landing as additive minor releases:

- Compiled Node-compatible distribution (no Bun required for users)
- Published JSON Schema files at fetchable URLs (replacing the `urn:` IDs)
- `RedactionConfig` wired through artifacts (currently a no-op schema)
- Real unit tests for the Playwright adapter's side-effecting paths
- `cairn replay <runId>` (replay an events.ndjson for incident analysis)
- `cairn report <dir>` (HTML dashboard of run history + flake rates)
- Heal beyond name-drift: selector swaps, role swaps, multi-step diffs
- TUI (`cairn tui`) — interactive flow picker + live dashboard

## Contributing

PRs welcome. Before pushing:

1. `bun run verify` must be green.
2. New verifiers / step kinds need a schema entry, a verifier file, a
   dispatcher branch, an `cairn explain` entry, and tests. See
   [AGENTS.md](./AGENTS.md) for the recipe.
3. Add a test for any bug fix. The fix isn't done until something would
   catch a regression.
4. Format with `bun run format`; lint with `bun run lint`.

## License

[MIT](./LICENSE) — © 2026 Abdul Hamid

---

<sub>Cairntrace is named for the cairns that mark a hiking trail — small
stacks of stone left by previous travelers so the next one can find the
way. A trace is the debugging artifact left by a run. The tool's job is to
mark browser paths, replay them, and preserve traces for humans and agents
alike.</sub>
