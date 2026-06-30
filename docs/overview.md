# Overview

Cairntrace is a local-first behavioral browser-spec layer for coding agents. Specs define `intent + outcomes` as the behavior contract and `steps` as repairable hints for reaching that state. The same spec can run from the CLI, through the MCP server, or be exported to Playwright.

It captures DOM snapshots, screenshots, console logs, network traffic, and outcome evidence into one agent-readable artifact pack. Heals common locator drift without changing the behavior contract. Agent-neutral: there are no Claude, Codex, Cursor, or OpenCode branches in core.

## Why browser specs for agents

A real browser acceptance check is the difference between "the model says it's done" and "this is what the user will see." Cairntrace gives your agent the means to write that check, run it, and read what failed — without inventing new verifier types every run.

The "intent + outcomes" pair is the contract. Steps are repairable hints. When the contract changes, the spec is broken (use `cairn spec verify --stamp` to re-stamp). When only the steps change, the contract survives and the runner keeps trusting the spec.

## Where to go next

- [Quickstart](/quickstart) — install `cairn` and run your first browser spec.
- [Authoring](/authoring), [Steps](/steps), and [Verifiers](/verifiers) — the typed vocabularies and what makes a contract survive.
- [Commands](/commands) — the `cairn` CLI surface: doctor, discover, checkpoints, stash, investigate, annotate, clip, process monitoring, secrets, and services.
