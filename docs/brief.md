---
title: Agent Journey Briefs for Fragile Environments
description: Compile a passing Cairntrace spec into an agent-neutral brief so a harness can complete the same journey when authored locators do not replay.
---

# Journey briefs

When a spec already passes locally but locators miss in another environment,
compile an **agent-neutral brief**: what to fill, what to look for, and
ordered search approximations. The contract stays `intent + outcomes`. The
harness chooses **where** to click; Cairntrace keeps **what** to type.

Use this when the accessibility tree, copy, or DOM in the target environment
is not the local one (i18n, feature flags, vendor widgets, hashed CSS). If
the tree is stable and only CSS drifted, prefer `by: role|label|text` and
[`cairn spec heal`](/authoring) first.

There is no Grok (or any other model) backend. CLI, MCP, and artifacts stay
the interface.

## Export a brief

```bash
# Markdown to paste into a harness
cairn export brief flows/login.yml --stdout --format md

# Attach what the last green run actually clicked (role + accessible name)
cairn export brief flows/login.yml --from-run latest --stdout --format md

# Stable JSON (urn:cairntrace.dev:brief:v1)
cairn export brief flows/login.yml --format json --stdout
```

`--from-run` reads `run.json` `steps[].resolved`. `latest` / `previous` pick
the newest **passed** run whose spec name or path matches — not the newest
directory on disk. That is the signal from a passing local run: “this click
hit a textbox named Email address,” even if the authored locator was
`#email-input-v2`.

Directory input requires `--out-dir`. Default write path for one spec is
`<spec-dir>/<name>.brief.md` (or `.json` / `.yaml`).

MCP: `cairn_export_brief` with `path`, optional `fromRun`, `config`, `env`,
`var`. The tool returns markdown in `content` and the BriefDocument as
`structuredContent`.

## What the brief contains

- **Contract** — intent and every outcome (`done when`).
- **Setup** — environment, plus how the spec satisfies cold-start
  (`guest`, checkpoint resume, imported actions, or preconditions).
- **Rules** — do not invent values or extra navigation; prefer role / name
  over CSS; stop when every outcome holds.
- **Steps** — operator goal, authored locator, `seenLocally` from a green
  run, ordered approximations, done-when.
- **Secrets** — `{ kind: secret, name: PASSWORD }`. Markdown says
  `use secret PASSWORD from the environment`. Never the literal.
- **Coverage skips** — `eval`, `request`, `transform`, `monitor`, and similar
  machine-only steps. A seeing agent should not reimplement them in the page.

Authored `by: selector` is marked brittle. Approximations try accessible
name, visible text, testid, then the CSS as a last resort.

## Live try-then-ask

The choose-loop is MCP-first (same split as [discovery](/discover): CLI is
one-shot, the session is stateful MCP).

1. `cairn_accompany_open` — parse the spec, start a backend, try authored
   locators in order.
2. On a hit, continue. If every locator hits, you get a normal completed
   `RunResult`.
3. On a miss, the session **parks** with a miss packet: that step’s brief,
   live inventory, and snapshot.
4. `cairn_accompany_choose` — supply a `Locator` or a snapshot ref
   (`e12` / `@e12`, agent-browser snapshots only). Cairntrace retries the
   **same authored value** against that locator. Playwright snapshots have
   no `@ref`; choose a role/name locator there.
5. A bad choose stays parked with a fresh inventory. It does not burn the
   session.
6. `cairn_accompany_close` — abort if still parked, write artifacts if the
   run finished, free the backend.

Sessions idle-expire after 5 minutes. Cap is 8, separate from discovery.

Outcomes still run through `OutcomeEvaluator`. A journey that needed
help and still misses the contract is exit 1, not a pass.

There is no `cairn accompany` CLI and no `--assist` that blocks
`cairn run` waiting for a choose. JSON/CI paths must not prompt.

## Miss packet on a normal run

`cairn run` does not change control flow. When an interactive step fails,
`failure.brief` carries that step’s approximations and authored values.
`agent_context.md` renders them. `nextActions` also suggests
`cairn export brief`.

Use that when you want a playbook after a failed run without opening an
accompany session.

## What this is not

- Not a new verifier or step kind.
- Not a rewrite of `intent` / `outcomes` (that is still heal, and only
  for locators).
- Not a license for the harness to change fill values.
- Not a substitute for semantic locators on a stable tree.

## See also

- [Export & import](/export) — Playwright handoff (the other export target)
- [Discovery](/discover) — explore and *record* a spec (the inverse of accompany)
- [MCP](/mcp) — tool list including `cairn_export_brief` and `cairn_accompany_*`
- [Agents](/agents) — recommended agent loop
- `cairn docs brief --json` — the same guidance as a structured topic
