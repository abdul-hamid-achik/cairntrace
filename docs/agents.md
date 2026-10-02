---
title: Browser Testing Workflow for AI Coding Agents
description: Give Codex, Claude Code, Cursor, OpenCode, and other coding agents one Cairntrace CLI and MCP loop for browser verification and repair-ready evidence.
---

# Agents

Cairn is built for AI coding agents as much as for people. Every CLI command takes `--format json|yaml|md`, and every capability has a thin MCP tool that returns the same shape. The agent loop below is the recommended path for any harness that speaks MCP (Claude Code, Codex, Cursor, OpenCode, …) and the same loop works against the CLI for harnesses that don't.

## The recommended loop

| When | Tool | Answers |
|---|---|---|
| **First contact with the repo** | `cairn_explain` | the current CLI surface, step vocabulary, and verifier vocabulary |
| **Focus on one task** | `cairn_docs` | focused guidance on authoring, steps, verifiers, downloads, scripts, artifacts, mcp, backends, discovery, export, brief |
| **Locators miss in another env** | `cairn_export_brief` / `cairn_accompany_*` | operator instructions + try-then-ask; see [Journey briefs](/brief) |
| **Validate a spec before running** | `cairn_spec_verify` | schema, contract hash, dead-link check |
| **Replays from a fresh browser** | `cairn_run` with `coldStart: true` | one golden run; rewrites artifact pack |
| **A long suite** | `cairn_run` with `wait: false`, then `cairn_run_status` / `cairn_logs` | an invocation id at once; poll status and live logs, `cairn_run_cancel` to stop |
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
cairn diff <baseline> <run>   # what changed in the DOM, network, console
diagnostics/<step>.json       # structured browser state for a failed step
outcomes/<id>.md              # the failing outcome + its evidence
```

Do not grep through `events.ndjson` until you have read these. The artifact pack is intentionally layered for that order.

## MCP tools vs CLI

Every CLI surface has a matching MCP tool of the form `cairn_<name>`. Naming mirrors the CLI verb (`cairn_run` ↔ `cairn run`, `cairn_spec_verify` ↔ `cairn spec verify`), and the structured result is the document the CLI prints with `--format json`, so the agent does not have to special-case which transport is in use.

For runs this holds by construction: `cairn run` and `cairn_run` call one engine with one options schema. Every run flag is a `cairn_run` input under its camelCase name (`--cold-start` → `coldStart`, `--no-services` → `noServices`, `--since-codemap` → `sinceCodemap`, `--stamp-if-green` → `stampIfGreen`), so a run over MCP reads the same config and `browser:` block (`testIdAttribute`), resolves the same vars and scoped secrets, boots the same services and webServer, runs the same post-run stash/investigate/annotate and retention adapters, and writes the same run directory and invocation journal. Only presentation flags (`--format`, `--progress`, logging) are CLI-only. MCP adds `specs` (paths or directories), `path` (one spec) and `wait`.

Long runs do not have to hold a tool call open:

```text
cairn_run        { specs: ["flows/"], wait: false }   → { invocationId, journalDir, status: "running" }
cairn_run_status { invocationId }                     → status, runs started so far, summary, final document
cairn_logs       { invocationId, log: "narration", cursor } → { text, nextCursor, eof, settled }
cairn_logs       { invocationId, run: "current" }     → the running spec's events.ndjson
cairn_run_cancel { invocationId }                     → browsers and running hooks killed, rest skipped, journal "aborted"
```

Pass `nextCursor` back as `cursor` until `settled` and `eof` are both true; it keeps one position per file, which the multi-file logs (`precondition`, `outcome`, `services`, `hook`) need. In the default synchronous mode, a request that carries a `progressToken` receives `notifications/progress` for each run, step and outcome, and cancelling the request cancels the run. A client whose tool timeout expires cancels the request as well, so use `wait: false` for anything that can outlast that timeout. A cancel kills the process tree of whatever command is running (a hook, a services boot command, a precondition, a node transform or script verifier) and skips the rest; only teardown commands and an in-flight `file`/`xlsx` check (until its own timeout, result ignored) keep running (see [MCP](/mcp)).

The structured result matches `--format json` with one exception: for `repeat`/`matrix` the CLI prints one document per iteration and `cairn_run` returns one BatchRunResult over all of them. Like `cairn run`, `cairn_run` boots the config's services and webServer and runs their teardown; pass `noServices` / `noWebServer` when the stack is yours to manage.

Three safety rules apply to MCP runs only. `before`/`after` hooks are arbitrary shell, so `cairn_run` rejects them unless the server was started as `cairn mcp --allow-hooks` (or with `CAIRN_MCP_ALLOW_HOOKS=1`). Config `services` (docker/seed/tmux) and their teardown start only on a server started as `cairn mcp --allow-services` (or with `CAIRN_MCP_ALLOW_SERVICES=1`); without it a `cairn_run`, `cairn_spec_finish` or `cairn_audit` that would start them fails with exit 4 before anything starts — pass `noServices: true` when the stack is up, or `reuseServices: true` after `cairn services up`. Neither gate is a sandbox: webServer commands, spec preconditions and `script` verifiers are shell too and run without them. Invocations that boot services or a webServer from the same config file run one at a time inside the server, whatever their `env`, so two agents never fight over one docker/tmux stack; an invocation that boots neither (`noServices` and `noWebServer`, or a config without them) never waits.

If you are writing an agent that runs against many harnesses, prefer the MCP transport — Vercel-functions-style stdio keeps the artifact format consistent across Claude Code, Codex, Cursor, and OpenCode. The CLI is for ad-hoc work and CI.

## A note on per-agent code paths

There aren't any. There is no `claude_cairn_run.py`, no `codex_*` wrapper, no `cursor_*` shim. The runner is the surface; agents sit on top of it.

This is deliberate. The contract hash, the verifier vocabulary, the step vocabulary, and the artifact shape are the contract. Anyone who adds a per-agent branch has to maintain it on every release. The CLI + MCP server + artifact shape are how agents and people reach the same runner with the same expectations.

## When you need to extend the runner

- New step kind: open an issue first. The step vocabulary is closed by design.
- New verifier: same. Use `script:` until the new shape lands.
- New capture mode: start with the current backend contract in
  [Video capture](/video) and add tests for both supported and unsupported
  backends.
- New backend: implement the `BrowserBackend` interface, register in `cairntrace.config.yml`, ship a smoke spec under `specs/`.

If the extension is small enough to fit inside an `eval:` step or a `script:` verifier, do that first.
