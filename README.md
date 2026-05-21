# Cairntrace

> Mark the path, replay the browser, hand the trace to the agent.

A **local-first behavioral browser-spec layer** for coding agents (Claude Code,
Codex, Cursor, OpenCode, etc.). You write `intent + outcomes` in YAML; agents
execute, capture, and heal those specs against a real browser through
[`agent-browser`](https://agent-browser.dev). Cairntrace is **agent-neutral**
— there is no per-agent code path, just a CLI any agent can invoke.

## Status

**v0.1** — runs end-to-end against real `agent-browser`. The full v0 verifier
vocabulary, multi-format artifacts, contract hashing, spec heal, checkpoints,
and config-driven environments are wired and tested. See
[`docs/`](#documentation) (or [the plan in `~/notes`][plan-link] if you're me)
for the design rationale.

[plan-link]: #-the-design-doc

## Quickstart

```bash
# Install deps (Bun 1.3+)
bun install

# Sanity check the environment
./bin/cairn doctor

# Start the demo app (in a separate terminal)
bun examples/demo-app/server.ts

# Run an example spec end-to-end
./bin/cairn run examples/flows/01-dashboard-nav.yml

# Inspect what an agent would read after a run
./bin/cairn context latest
```

## What `cairn` does

| Command | What it does |
|---|---|
| `cairn run <spec>` | Runs a behavioral spec. Streams per-step / per-outcome ✓/✗ in a TTY; emits structured JSON/YAML/MD via `--format`. |
| `cairn doctor` | Checks node/bun/agent-browser/artifact dir health. |
| `cairn explain` | Dumps the full agent-facing surface (commands + verifier vocabulary + rules) as structured data. |
| `cairn context <run\|latest>` | Prints or locates the run's `agent_context.md`. |
| `cairn spec scaffold <name> --intent ...` | Writes a starter YAML with the cold-start header comment block. |
| `cairn spec verify <spec> [--stamp]` | Lints; with `--stamp` writes a fresh `contractHash:` into the file. |
| `cairn spec heal <spec> [--apply]` | Re-runs the spec, proposes selector-drift fixes from the accessibility-tree snapshot, optionally writes them back (preserves YAML comments). |
| `cairn checkpoint capture-from-session <name> --session <ab-session>` | Saves the state of an existing agent-browser session as a named checkpoint. |
| `cairn checkpoint list / show / delete` | Manage saved checkpoints. |
| `cairn login <name> --url ... [--wait-for text:\|url:]` | Open a headed browser, let the user log in, capture state into a checkpoint. |
| `cairn mcp` | Start the MCP server on stdio for MCP-aware agents (Claude Code, Cursor, etc.). |

Every agent-callable command supports `--format json|yaml|md` (or `--json`,
`--yaml`, `--md` shorthand). Exit codes are stable across versions:
0 pass, 1 outcome failure, 2 errored, 3 cold-start gate, 4 lint, 5 heal-no-progress,
6 contract-hash mismatch.

## A spec looks like this

```yaml
version: 1
name: import_xlsx_invoices
intent: |
  Given a seeded org with no invoices, when an admin uploads sample.xlsx via
  the Invoices > Import flow, the invoice list shows all rows with correct
  totals and one audit-log entry per row.

environment: local
outcomes:
  - id: invoice_count_visible
    description: invoice list shows 42 rows after import
    verify:
      text: { contains: "Showing 42 invoices" }
  - id: import_request_succeeded
    description: the import API returned 2xx
    verify:
      network:
        method: POST
        urlContains: /api/invoices/import
        status: { in: [200, 201] }
  - id: no_console_errors
    verify:
      console: { errorsMax: 0 }

steps:
  - use: login_admin
  - open: /invoices
  - id: open_import
    click: { by: role, role: button, name: Import }
  - id: upload
    upload: { by: label, name: Upload file, path: ./fixtures/sample.xlsx }
  - wait: { text: "Import complete", timeoutMs: 30000 }
```

**Intent and outcomes are the contract.** Steps are repairable hints — when a
button is renamed, run `cairn spec heal` and Cairntrace will patch the locator
from the snapshot.

## Examples

A tiny end-to-end demo lives in [`examples/`](./examples). It includes a
local static + JSON server and six spec YAMLs that exercise every v0 verifier
plus the heal flow:

```bash
bun examples/demo-app/server.ts        # in one terminal
./bin/cairn run examples/flows/01-dashboard-nav.yml
```

See [`examples/README.md`](./examples/README.md) for the full walkthrough.

## Architecture

```
behavioral spec (intent + outcomes + steps)
        ↓ parser + validator (zod, comment-preserving YAML)
        ↓ contract-hash check
        ↓
config-aware Runner
        ↓ runs each step against
        ↓
BrowserBackend interface ── implemented by ──→ AgentBrowserAdapter
                                          ──→ MockBrowserBackend (tests)

        ↓ evaluates outcomes via
OutcomeEvaluator + 8 verifiers (text, notText, url, network, noFailedRequests,
                                console, count, script)
        ↓
ArtifactWriter
        ↓ writes
run.{json,yaml,md} + agent_context.md + outcomes/*.md (+ raw.json sidecar)
+ events.ndjson + snapshots/ + screenshots/ + console/ + network/
```

The CLI surface and artifact format are the agent interface — Cairntrace ships
no per-agent code.

## Stack

- [**Bun**](https://bun.com) — package manager + runtime
- [**TypeScript**](https://www.typescriptlang.org) — typed source
- [**Zod**](https://zod.dev) — schema validation
- [**Vitest**](https://vitest.dev) — tests
- [**Oxlint**](https://oxc.rs/docs/guide/usage/linter.html) — lint (Vite+ stack)
- [**Oxfmt**](https://oxc.rs/docs/guide/usage/formatter/quickstart) — format (Vite+ stack)
- [**yaml**](https://eemeli.org/yaml/) — comment-preserving YAML
- [**agent-browser**](https://agent-browser.dev) — execution backend

## Development

```bash
bun install            # install deps
bun run typecheck      # tsc --noEmit
bun run test           # vitest
bun run lint           # oxlint
bun run format         # oxfmt
bun run verify         # all of the above
```

## MCP integration

Cairntrace exposes its surface as an MCP server. Add it to your agent's MCP
config (the example below is for Claude Code):

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

Tools exposed: `cairn_explain`, `cairn_doctor`, `cairn_run`, `cairn_context`,
`cairn_spec_scaffold`, `cairn_spec_verify`, `cairn_spec_heal`,
`cairn_checkpoint_list`. Each tool returns both `content` (text summary) and
`structuredContent` (the canonical JSON matching the v1 wire schemas).

Agents that don't speak MCP can use the same surface via the shell CLI — the
output is identical.

## License

MIT — see [LICENSE](./LICENSE).
