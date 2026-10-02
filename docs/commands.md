---
title: Cairntrace CLI Commands for Browser Testing
description: Reference Cairntrace commands for browser-spec discovery, verification, execution, healing, comparison, evidence, sessions, services, and maintenance.
---

# Commands

The `cairn` CLI surface beyond the core run/spec/authoring commands. Each page below documents one command family — flags, flow, and when to reach for it. Every command supports `--format json|yaml|md` and has a stable JSON schema; no interactive prompts on `--json`/`--yaml` paths.

## Maintenance

- [Doctor & clean](/doctor) — `cairn doctor` probes the environment; `cairn clean` prunes old run directories.

## Page inspection

- [Discover & snapshot](/discover) — `cairn discover` / `cairn snapshot` return the accessibility tree and locator inventory for a live page. `cairn discover` can start from a setup (`--use`, `--from-spec`) and leaves a session journal; `cairn discover sessions` lists journals and `cairn discover export --from-session` writes a spec from one.
- [Journey briefs](/brief) — `cairn export brief` compiles a spec into operator instructions for a fragile environment; MCP `cairn_accompany_*` is the live try-then-ask loop.

## Authoring

- [Project catalog](/catalog) — `cairn catalog --query` lists the actions, vars, verifiers, environments, flows and checkpoints a project already has.
- [Author a spec from a request](/author-flow) — the recipe from a few sentences to a promoted spec; `cairn init agent-kit` writes a short version into your `AGENTS.md`.
- [Lint, finish, promote](/authoring#lint-before-you-run) — `cairn spec lint [--fix]` gives fix-its before a run, `cairn spec finish` lints + runs cold + stamps when green, `cairn spec promote` moves a green draft out of `flows/_drafts`.

## Sessions

- [Checkpoints & login](/checkpoint) — `cairn login` captures a session by hand; `cairn checkpoint` manages resumable checkpoints. Captures record their scope (`--env` baseUrl, `--ttl`), `checkpoint list --json` shows each one's health, and a run refuses an expired or other-origin checkpoint.

## Evidence

- [Stash](/stash) — `cairn stash` persists run packs in the local file.cheap vault for retention-safe search.
- [Clip](/clip) — `cairn clip` cuts named clips from a run video via vidtrace.
- [Process monitoring](/monitor) — `--monitor` samples the browser process tree; the `monitor` step and `process` verifier assert on it.
- **Stats** — `cairn stats --group-by <label-key>` aggregates labeled runs (`cairn run --label key=value`) into A/B cohorts with pass rate, duration percentiles, optional domain metrics from `outcomes/*.raw.json`, and ASCII charts in markdown. Pair with `--before` hooks for domain path flips before a suite. `--repeat`/`--matrix` run many labeled iterations in one command, and `--after` hooks can drop `diagnostics/report.json` whose numeric fields feed `cairn stats --metric`.

## Failure → code

- [Investigate & audit](/investigate) — `cairn investigate` stashes an existing
  run for optional code search; `cairn audit` records a Playwright video and
  uses file.cheap/vecgrep only when stash or connection is requested.
- [Annotate](/annotate) — `cairn annotate` pins cairntrace findings to codemap symbols; `--auto-annotate` does it per run.

## Environment

- [Secrets](/secrets) — `cairn secrets` checks the TinyVault secrets provider.
- [Services](/services) — `cairn services status` and the config-driven docker/seed/tmux lifecycle; `cairn services up` / `down` keep the stack running between runs under an owner lock, and `cairn run --reuse-services` runs against it.
- [Fixtures](/fixtures) — `cairn fixtures list | status | ensure | reset | teardown | sweep` drive the config `fixtures:` registry (exec / mongo / http test data) outside a run; `cairn run --allow-fixture-writes` lets fixtures write on a shared or protected environment (never under `policy.mutations: deny`).

## The core commands

The run/spec/authoring surface is documented elsewhere and is not duplicated here:

- [Quickstart](/quickstart) — `cairn run`, first spec.
- [Authoring](/authoring) — tags, labels, `--before`/`--after` hooks, `cairn stats`.
- [Steps](/steps) / [Verifiers](/verifiers) — the typed vocabularies.
- [Snippets](/snippets) — `imports:` / `use:`.
- [MCP](/mcp) — `cairn mcp` and the `cairn_*` tool family.

Run `cairn explain --format json` (or MCP `cairn_explain`) for the machine-readable current surface, including every flag.

## See also

- [Overview](/overview) — what cairntrace is
- [Configuration](/configuration) — config keys the commands read
- [Troubleshooting](/troubleshooting) — common command failure modes
