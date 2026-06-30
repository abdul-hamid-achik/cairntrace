# Agents

Cairn is built for AI coding agents as much as for people. Every CLI command takes `--format json|yaml|md`, and every capability has a thin MCP tool that returns the same shape. The agent loop below is the recommended path for any harness that speaks MCP (Claude Code, Codex, Cursor, OpenCode, …) and the same loop works against the CLI for harnesses that don't.

## The recommended loop

| When | Tool | Answers |
|---|---|---|
| **First contact with the repo** | `cairn_explain` | the current CLI surface, step vocabulary, and verifier vocabulary |
| **Focus on one task** | `cairn_docs` | focused guidance on authoring, steps, verifiers, downloads, scripts, artifacts, mcp, backends |
| **Validate a spec before running** | `cairn_spec_verify` | schema, contract hash, dead-link check |
| **Replays from a fresh browser** | `cairn_run` with `cold_start=true` | one golden run; rewrites artifact pack |
| **Read what failed** | `cairn_context` (latest) | the agent-readable failure narrative |

The two stages that protect a run from being a flaky green-check theater are:

- `spec_verify --stamp` — re-stamp the contract hash after editing `intent` or `outcomes`.
- `run --cold-start` — replay the spec from a fresh browser so the cold-start contract is real, not a side-effect of your dev session.

## Cold-start, every time

A spec that runs only because your dev session is logged in is a spec that does not run. Always run with `--cold-start` before committing a spec.

```bash
cairn run examples/specs/checkout.yml --cold-start --format json
```

If `--cold-start` fails but a warm run passes, your spec broke the cold-start contract. Fix that first; warming is not a fallback.

## Agents run, then read

After a failed run, the right sequence is:

```text
cairn context latest          # the agent-narrative post-mortem
cairn_diff <baseline> <run>   # what changed in the DOM, network, console
diagnostics/failure.md        # when context is too dense
outcomes/<id>.md              # the failing outcome + its evidence
```

Do not grep through `events.ndjson` until you have read these. The artifact pack is intentionally layered for that order.

## MCP tools vs CLI

Every CLI surface has a matching MCP tool of the form `cairn_<name>`. Naming mirrors the CLI verb (`cairn_run` ↔ `cairn run`, `cairn_spec_verify` ↔ `cairn spec verify`). Output JSON is identical between the two, so the agent does not have to special-case which transport is in use.

If you are writing an agent that runs against many harnesses, prefer the MCP transport — Vercel-functions-style stdio keeps the artifact format consistent across Claude Code, Codex, Cursor, and OpenCode. The CLI is for ad-hoc work and CI.

## A note on per-agent code paths

There aren't any. There is no `claude_cairn_run.py`, no `codex_*` wrapper, no `cursor_*` shim. The runner is the surface; agents sit on top of it.

This is deliberate. The contract hash, the verifier vocabulary, the step vocabulary, and the artifact shape are the contract. Anyone who adds a per-agent branch has to maintain it on every release. The CLI + MCP server + artifact shape are how agents and people reach the same runner with the same expectations.

## When you need to extend the runner

- New step kind: open an issue first. The step vocabulary is closed by design.
- New verifier: same. Use `script:` until the new shape lands.
- New capture mode: see how `artifacts.capture.video` evolved (see [video-screenshot-fallback](/video-screenshot-fallback)).
- New backend: implement the `BrowserBackend` interface, register in `cairntrace.config.yml`, ship a smoke spec under `specs/`.

If the extension is small enough to fit inside `script:` or `controls:`, do that first.
