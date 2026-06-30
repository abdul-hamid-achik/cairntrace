# Glyphrun × Cairntrace

A side-by-side for the two spec runners under [the-lacanians](https://www.thelacanians.com). They look like siblings on purpose. Both are local-first, both speak `intent + outcomes`, both emit a self-contained artifact pack for humans and coding agents. They differ on the surface they drive — Glyphrun on terminals, Cairntrace on browsers.

## Where the two overlap

| Concept | cairntrace | glyphrun |
|---|---|---|
| **Behavior contract** | `intent + outcomes` in `spec.yml` | `intent + outcomes` in `spec.yml` |
| **Repairable hints** | typed `steps:` vocabulary | typed `steps:` vocabulary |
| **Agent interface** | CLI + MCP server + artifact pack | CLI + MCP server + artifact pack |
| **Closed verifiers** | `text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`, `httpJson`, `script`, `process` | same |
| **Cold-start contract** | required; login/checkpoint/preconditions | required; login/checkpoint/preconditions |
| **Artifact format** | `run.{json,yaml,md}`, `report.html`, `outcomes/<id>.md`, `screenshots/`, `network/`, `console/`, `spec.resolved.yml` | same shape, plus `frames/frames.ndjson` and `raw/pty.raw.log` |
| **MCP tools** | `cairn_*` mirrors every CLI verb | `glyph_*` mirrors every CLI verb |

## Where they diverge

| Surface | cairntrace | glyphrun |
|---|---|---|
| **Driver** | Headless Chrome (Playwright backend) or `agent-browser` adapter | Real PTY (Unix PTY / Windows ConPTY) |
| **DOM model** | Real DOM, snapshots via Playwright accessibility tree | Virtual terminal emulator (`internal/terminal`); deterministic, no display dependency |
| **Locator strategy** | Semantic locators (`role|label|text`) with `data-testid` fallback | Screen regions + cell coords; SGR/colors/OSC 8/hyperlinks parsed |
| **Hydration waits** | `open: { waitUntil: networkidle }` | not applicable — terminals hydrate synchronously |
| **Mouse input** | Playwright `click`/`hover` | DEC mouse + SGR mouse; emits explicit `MouseClick` step type |
| **Video capture** | optional `.webm` (Playwright only); stub for agent-browser (`video-screenshot-fallback`) | `frames/frames.ndjson` per step + scriptable replay via `replay --tui` |

## What is shared by design

- **The contract hash.** Both runners mint a hash over `intent + outcomes` and refuse silent edits. Both expose `cairn spec verify --stamp` / `glyph spec verify --stamp` for re-stamping.
- **The artifact pack.** Same file shapes — what differs is the inside of `screens/` and `frames/` — so an agent that reads one format reads the other without code change.
- **The MCP shape.** Same `*_explain`, `*_spec_verify`, `*_run`, `*_context` tools, in the same order. An agent that learned one learned the other.
- **The repair engine.** Both runners read failed-artifact packs and propose step rewrites that preserve the contract hash. The repair proposals are suggestions, not approvals.

## When to choose which

- **GUI / SPA / form / accessibility tree / screenshots / video** → cairntrace.
- **TUI / REPL / interactive shell / pipes / mouse-enabled terminal / SGR-styled output** → glyphrun.
- **Mixed flows** (CLI-driven install followed by a browser-based dashboard) → glyphrun for the CLI portion, cairntrace for the dashboard; share state via `captures:` and `requests:` handles, not by inventing a bridge.

## What will not merge

- The browsers and terminals do not share a VM model. cairntrace's accessibility-tree snapshots would be meaningless against glyphrun's cell model. We are not going to invent a common abstraction that one of them wants and the other doesn't.
- Repair proposals, the contract hash, and the artifact pack stay cross-compatible because they are *contracts*, not implementations. That's the whole reason both projects ship from the same org.

## Suggested reading

- [Authoring](/authoring) — what makes a contract survive across months.
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies.
- [Glyphrun's cairntrace-comparison doc](https://glyphrun.dev/cairntrace-comparison) — the side from the other side of the fence.
