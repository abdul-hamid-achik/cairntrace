---
title: Cairntrace CLI Commands for Browser Testing
description: Reference Cairntrace commands for browser-spec discovery, verification, execution, healing, comparison, evidence, sessions, services, and maintenance.
---

# Commands

The `cairn` CLI surface beyond the core run/spec/authoring commands. Each page below documents one command family — flags, flow, and when to reach for it. Every command supports `--format json|yaml|md` and has a stable JSON schema; no interactive prompts on `--json`/`--yaml` paths.

A command-line usage error (an unknown flag or command, a missing option value or required argument) exits `2`, on every command, and never `1`, which means a failed outcome: a typo cannot read as a red test. `--help` and `--version` exit `0`. See the exit-code table in the README.

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
- **Stats** — `cairn stats --group-by <label-key>` aggregates labeled runs (`cairn run --label key=value`) into A/B cohorts (`--label` filters, `--invocation <id>` keeps one `cairn run`'s runs) with pass rate, duration percentiles, optional domain metrics from `outcomes/*.raw.json`, and ASCII charts in markdown. Pair with `--before` hooks for domain path flips before a suite. `--repeat`/`--matrix` run many labeled iterations in one command, and `--after` hooks can drop `diagnostics/report.json` whose numeric fields feed `cairn stats --metric`; the config `metrics:` probes write the same keys (`<name>.delta`) without a script.

## Failure → code

- [Investigate & audit](/investigate) — `cairn investigate` stashes an existing
  run for optional code search; `cairn audit` records a Playwright video and
  uses file.cheap/vecgrep only when stash or connection is requested.
- [Annotate](/annotate) — `cairn annotate` pins cairntrace findings to codemap symbols; `--auto-annotate` does it per run.

## Environment

- [Secrets](/secrets) — `cairn secrets` checks the TinyVault secrets provider.
- [Config composition](/configuration#composing-a-config) — top-level `vars`, `environments.<n>.extends`, vars that reference vars, `include:` and `environments.<n>.include` (per-environment var files) keep a value in one place; `cairn config vars [--env] [--unused] [--used-by <spec>]` shows where each var is defined, its value per environment and what reads it, and `cairn config validate` reports composition errors, dead vars and include overrides.
- [Services](/services) — `cairn services status` and the config-driven docker/seed/tmux lifecycle (top-level, or declared per environment); `cairn services up` / `down` keep the stack running between runs under an owner lock, and `cairn run --reuse-services` runs against it. `services up` / `down` / `restart` refuse (exit 4) while a live `cairn run` holds the config's `run.lock`. `cairn run --services-dry-run` prints the whole plan without running anything.
- [Service operations](/services#service-operations-restart-logs-supervision) — `cairn services restart <window...>` (Ctrl-C, wait for the exit, resend the command, wait for the new generation's `readyOn`; refuses windows the config does not own) and `cairn services logs <window> [--since-restart] [--wait <regex>] [--follow]`; tmux windows' `restart` policy and `healthcheck.onUnhealthy` are supervised during a run; `services.tunnels`, `services.provisioner` (`up` / `down` / `exports`, always torn down, a failed `down` is exit 8) and `services.files` (atomic validated writes). There is no `services exec`, on purpose.
- [Seed transaction](/services#seed-transaction) — `services.seed.phases`, `commit: afterPostCommands`, object `postCommands` (`when`, `continueOnError`, `timeout`) and `expectOutput` for a seed that prints an error but exits 0.
- [Engine pin](/services#engine-pin) — config `requires: { cairntrace: <range> }` (exit 4 on an older cairn) and `runtimes.node` / `CAIRN_NODE`; `cairn doctor [--config <path>]` reports both.
- [Run policy](/services#run-policy-run-lock-preflight-clean-machine-belts) — the config `run:` block (`lock`, `preflight`, `verifyClean`, `finally`) and `services.teardown` entries with `critical: true` make a bare `cairn run` safe: exit 4 for a refusal before anything starts, exit 8 when a critical teardown failed, exit 9 for a dirty machine after the run. A preflight check's `when: { suite, env }` limits it to some suites. `cairn run --bail` skips the remaining specs after the first failure (`--no-bail` overrides a suite's `bail`); `cairn docs run-policy` maps a wrapper script's jobs to config; `cairn doctor --orphans [--kill]` lists and ends cairn-owned browser survivors.
- [Suites](/services#suites-cairn-run-suite) — the config `suites:` registry: `cairn run --suite <name> --env <env>` runs a named, ordered spec set with the environment's vars, `processEnv` (exported to every process of the run), `labels` (stamped on every run), once-per-run before/after hooks, `parallel`, `bail` and seed skips (per environment too); `cairn suites list` shows the specs each suite resolves to per environment.
- [Metrics](/services#metrics-probes-diagnostics-metrics-json) — the config `metrics:` probes (command + parse, or http + json path) sampled around each spec or iteration into `diagnostics/metrics.json` and `diagnostics/report.json`, ready for `cairn stats --metric <name>.delta`.
- [Delegated runners](/delegate) — `environments.<n>.runner: { command, cwd?, env?, timeoutMs?, idleTimeoutMs?, cancelGraceMs? }` hands a `cairn run --env <n>` to a command that runs it on another machine (contract `urn:cairntrace.dev:delegate:v1`) while the local process keeps the journal, the run directories, the exit code and Ctrl-C / Studio Stop. On the remote side, `cairn logs --invocation <id|label:cairn.delegate=<id>> --follow --relay [--wait-timeout 10m]` prints the events stream the runner pipes back. The runner's exit code is checked against that stream and the copied run directories.
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
