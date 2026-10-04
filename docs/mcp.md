---
title: MCP Server for Browser Testing
description: Connect AI coding agents to Cairntrace MCP tools for browser-spec discovery, authoring, verification, replay, healing, and evidence retrieval.
---

# MCP server

`cairn mcp` runs the same runner as the CLI as a **stdio MCP server**. Every CLI surface that is reasonable for an agent has a matching `cairn_<name>` tool that returns the same JSON shape as the CLI's `--format json`. There are no per-agent code paths.

## Transport

stdio JSON-RPC only. `cairn mcp` reads JSON-RPC from stdin, writes responses to stdout, and keeps its own logs on stderr (anything other than JSON-RPC on stdout would break the protocol). It is meant to be spawned by an MCP client.

There is no HTTP transport, no `serve` subcommand, and no `--port` flag. If you need HTTP, front the stdio server with a bridge — the server itself is stdio.

## Tool surface

68 tools, one prompt and one resource, grouped by concern. Naming mirrors the CLI verb (`cairn_run` ↔ `cairn run`, `cairn_spec_verify` ↔ `cairn spec verify`). Every tool's `--format json` output is identical between transports, so an agent does not special-case which one is in use.

### Bootstrap & docs

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_explain` | `cairn explain --format json` | the full surface: commands, flags, exit codes, step + verifier vocabulary, rules. Call once at session start. |
| `cairn_docs` | `cairn docs [topic]` | focused authoring guidance by topic (`brief` covers journey briefs, `author-flow` the request-to-spec recipe, `catalog` the project catalog) |
| `cairn_doctor` | `cairn doctor --format md` | environment health check (including the same file.cheap checks: version, `--meta` / `--run-index` support, console session, publisher readiness) |
| `cairn_catalog` | `cairn catalog --query <words>` | what the project already has — actions, vars, verifiers, environments, flows, checkpoints — ranked by `query`; reads files only. The text is a short summary and the rows are in `structuredContent`; without `query` or `limit` it returns at most 20 rows per kind (`totals` keeps the full counts). See [Project catalog](/catalog) |

### Spec authoring

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_spec_scaffold` | `cairn spec scaffold <name>` | draft a starter spec (optionally bound to a codemap orphan) |
| `cairn_spec_verify` | `cairn spec verify <spec>` | the same verify code path as the CLI: schema, imports, contract hash, cold-start lint, and the placeholder reference audit (`env`/`config`/`var` inputs; `structuredContent.exitCode`, `findings`, `environment`, `environments` like `--json`; `stamp: true` re-stamps) |
| `cairn_spec_lint` | `cairn spec lint <spec...>` | friendly findings with fix-its before a run (`paths`/`path`, `env` as a name, comma list or array, `config`, `var`; `fix: true` applies the safe edits; `structuredContent.exitCode` 4 on any error) |
| `cairn_spec_finish` | `cairn spec finish <spec>` | lint, a cold-start run through the `cairn_run` engine, stamp when green; returns `status` (green / red / lint-failed / errored / refused), the run, `contractHash`, the `agent_context.md` summary and `nextActions`. `noWebServer: true` reuses a dev server you already run; a `mock: true` finish never touches the app and does not count for promote |
| `cairn_spec_promote` | `cairn spec promote <draft>` | move a draft out of the drafts dir after a green real-backend finish of its exact content; returns `{from, to, intent, outcomes, contractHash, finish}`. Call it only after the human approved |
| `cairn_spec_heal` | `cairn spec heal <spec>` | propose + optionally apply selector-drift fixes (`env`/`config`/`var` resolved like a run; `exitCode` 7 when the environment policy refuses the spec) |

### Run & read

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_run` | `cairn run <spec...>` | the runner — the same engine and options as `cairn run` (see below); writes the artifact pack and the invocation journal |
| `cairn_run_status` | `cairn logs --invocation <id> --json` | status of an invocation: runs started so far, summary, final document |
| `cairn_run_cancel` | Ctrl-C on `cairn run` | graceful cancel of an invocation this server started (idempotent) |
| `cairn_logs` | `cairn logs [ref] [--invocation <id>] [--log …]` | an incremental, cursor-based slice of a run's or invocation's live logs |
| `cairn_context` | `cairn context <run>` | the `agent_context.md` post-mortem (`latest`/`previous`) |
| `cairn_config_validate` | `cairn config validate` | validate `cairntrace.config.yml` |
| `cairn_config_vars` | `cairn config vars` | config vars per environment: value, definitions, overrides, uses, dead vars |

### `cairn_run` is `cairn run`

`cairn run` and `cairn_run` are two thin adapters over one run engine with one options schema, so they cannot drift. Every run flag is an input under its camelCase name:

| `cairn run` flag | `cairn_run` input |
|---|---|
| `--env`, `--config`, `--var k=v` | `env`, `config`, `var: ["k=v"]` |
| `--cold-start`, `--headed`, `--mock`, `--backend`, `--provider`, `--device` | `coldStart`, `headed`, `mock`, `backend`, `provider`, `device` |
| `--parallel`, `--repeat`, `--matrix`, `--stop-on-fail` | `parallel`, `repeat`, `matrix`, `stopOnFail` |
| `--tag`, `--label`, `--since-codemap`, `--select-only` | `tag`, `label` (or a `labels` object), `sinceCodemap` (alias `since`), `selectOnly` |
| `--no-services`, `--no-web-server`, `--services-dry-run`, `--reuse-services` | `noServices`, `noWebServer`, `servicesDryRun`, `reuseServices` |
| `--before`, `--after`, `--hook-timeout-ms` | `before`, `after`, `hookTimeoutMs` (hooks need `--allow-hooks`, below) |
| `--stash-on-failure`, `--auto-annotate`, `--monitor` | `stashOnFailure`, `autoAnnotate`, `monitor` |
| `--artifact-root`, `--junit`, `--stamp-if-green` | `artifactRoot`, `junit`, `stampIfGreen` |

Only presentation flags (`--format`, `--progress`, logging) have no input. MCP adds `specs` (paths or directories), `path` (one spec, kept for compatibility) and `wait`. A test enumerates the commander flags of `run` and fails when one is missing from the schema or from the tool's input schema.

The engine does everything `cairn run` does: config and the `browser:` block (`testIdAttribute`, click tuning), vars, scoped TinyVault secrets passed explicitly to child processes, the services environment and webServer, hooks, repeat/matrix, post-run auto-stash/investigate/annotate, the retention archive/publish adapters, stamp-if-green, JUnit, and the invocation journal (`invocation.json` records `origin: mcp` and the client). Each invocation gets its own browser sessions.

Like `cairn run`, a `cairn_run` on a project whose config has a `webServer:` block boots it and stops it afterwards; pass `noWebServer: true` to use a dev server you already run.

**Services.** Config `services:` (docker, seed commands, tmux) and their `teardown` can create remote or billable infrastructure, so MCP tools start them only on a server started as `cairn mcp --allow-services` (or with `CAIRN_MCP_ALLOW_SERVICES=1`). Without it, a `cairn_run`, `cairn_spec_finish` or `cairn_audit` whose effective config would start services fails with exit 4 before anything starts (no secrets beyond the scoped read, no services, no webServer, no hooks, no browser), and the error names the way out: `noServices: true` when the stack is already up, or `reuseServices: true` against a stack `cairn services up` started from a shell. An environment with `services: false`, `servicesDryRun: true`, `noServices` and `reuseServices` are never gated. `cairn_services_up` and `cairn_services_down` refuse outright without the flag. With the flag, a `cairn_run` boots the services and runs their `teardown` afterwards, like `cairn run` — including `docker compose down` style commands when `reuseExisting` is off.

**Synchronous (default).** The structured result is the `cairn run --format json` document — RunResult, BatchRunResult for several specs, SelectionResult for `selectOnly` — plus `nextActions`; `isError` is set when the exit code is not 0. With `repeat`/`matrix`, `cairn run --format json` prints one document per iteration, while `cairn_run` returns one BatchRunResult over every iteration. An invocation that stops before its specs (bad options, secrets, services boot, a fatal `before` hook, a cancel) returns a schema-valid errored RunResult carrying the error. A spec the environment policy refuses is `status: "refused"` with its `refusal`; when every spec was refused (or any under `strictRequires`) the exit code is 7 and `isError` is set, and the text lists the refused specs with their reason and a `summary.refused` count. A refused result, and one that errored or was cancelled before its run started, carries `synthetic: true`: its `runId` / `runDir` are placeholders with nothing on disk, so the text never prints them. When stamp-if-green or the JUnit write fails, the document still reads as the runs did, `isError` is set (exit 2) and the text names the failure. The config `run:` block (lock, preflight, verifyClean, finally) and critical teardown run in the same engine: a refusal before anything starts is exit 4 with the reason as the error text, a critical teardown that failed is exit 8 and a dirty machine after the run is exit 9: the document is held until that verdict and agrees with it (`exitCode` 8 / 9, a passed spec reads `status: "errored"` with `failure.phase: "invocation"`, `invocationOutcome: { exitCode, specsExitCode, error, runPolicy }`; `isError` is set, the text names the failure, and `cairn_run_status` reports the exit code, the same document, the journal `summary` and `runPolicy`). `bail: true` is `--bail`: the rest of a batch is skipped after the first failure (`BatchRunResult.skipped[]`, `summary.skipped`). A request with a `progressToken` receives `notifications/progress` for each run, step and outcome; cancelling the request cancels the run. A client whose tool timeout expires cancels the request too, so start suites that can outlast it with `wait: false`.

**Background (`wait: false`).** Returns `{invocationId, journalDir, journalDirAbsolute, status: "running"}` as soon as the journal exists. One server runs at most 8 invocations at a time; past that `cairn_run` is refused until one settles. Then:

- `cairn_run_status {invocationId}` — `running` / `cancelling` / `passed` / `failed` / `errored` / `aborted`, planned vs started runs with their run dirs, the summary and, once settled, the document. It also reads journals of invocations this server did not start (pass `artifactRoot`/`config`). An environment with a [delegated runner](/delegate) runs the same way: the status comes from the local journal and adds its `delegate` block (runner command, remote invocation, runner exit code, diagnostics); `cairn_run_cancel` sends the runner SIGINT and settles with exit 130 once it stopped.
- `cairn_logs {invocationId?, run?, log?, cursor?, offset?, maxBytes?}` — `{text, nextCursor, nextOffset, eof, settled}`. Pass `nextCursor` back as `cursor` until `settled` and `eof` are both true. Invocation logs: `events` (default), `narration`, `services`, `hook`. Run logs (`run`: an id, `latest`, `previous`, or `current` with an `invocationId`): `events`, `run`, `precondition`, `outcome`. `precondition`, `outcome`, `services` and `hook` are sets of files that appear and grow independently (two iterations share `hook-before-01.log`, every run has its own `hook-after-*` file), so the cursor keeps one byte position per file and each file's new bytes follow a `==> <file> <==` header; a non-zero `offset` without a cursor is refused for them. Single-file logs also accept `nextOffset` back as `offset`. `maxBytes` defaults to 64 KiB (max 1 MiB). Slices end on a line boundary unless a settled file ends without a newline or one line is longer than `maxBytes`. Files are already redacted on disk.
- `cairn_run_cancel {invocationId}` — kills the invocation's browser sessions and the whole process tree of the command that is running: a `before`/`after` hook, a services boot command (docker, seed, readiness check, healthcheck), a precondition, a node `transform` or a node `script` verifier. It stops services readiness waits (docker readiness polls, tmux windows) and a webServer that is still booting, skips the specs that have not started, the rest of the running spec (its remaining preconditions, steps and outcomes, reported `skipped`) and the post-run work, tears down the webServer and the services phases already started, and marks the journal `aborted`. The running spec still writes a consistent run directory: `status: errored`, `failure.phase: "cancelled"`. Idempotent; waits for the teardown (up to 120s, then it answers `cancelling`) unless `wait: false`. What still runs after a cancel: the teardown commands, and an in-flight outcome check that neither uses the browser nor is a node script (`file`, `xlsx`), which keeps polling in the background until its own timeout while its result is ignored.

Background invocations live in the server process. When the client disconnects (it closes stdin or the transport), the server cancels them as above; a server that exits on a signal marks their journals aborted and kills their browsers, webServer and services.

**Result schemas.** `cairn_run {wait: false}`, `cairn_run_status` and `cairn_run_cancel` return `urn:cairntrace.dev:run-invocation:v1`; `cairn_logs` returns `urn:cairntrace.dev:run-logs:v1`. Both only grow additively.

**Hooks.** The `before`/`after` inputs a request carries run arbitrary shell, so `cairn_run` rejects them with an error naming the flag unless the server runs as `cairn mcp --allow-hooks` (or with `CAIRN_MCP_ALLOW_HOOKS=1`). The flag gates only those request-carried hooks. Hooks the config itself declares — suite `before`/`after`, `run.preflight` / `run.finally`, metric `command` probes — are project configuration like its webServer, preconditions and `script` verifiers, and run without the flag. The gate is defense in depth, not a sandbox: shell still runs over MCP without it through the project's own files — config `services` / `webServer` / `teardown` commands, spec `preconditions`, `script` verifiers — and through a `config` input that points at another config file. Only connect clients you would let run `cairn run` in that checkout.

**Shared environments.** Invocations that boot services or a webServer from the same config file run one at a time inside the server, whatever their `env` (environments of one config share its compose project and tmux session unless they override them), so two agents never fight over one docker/tmux stack; the waiting invocation says so in its narration log. A queued invocation can be cancelled without disturbing the queue. An invocation that boots neither (`noServices: true` and `noWebServer: true`, or a config without `services`/`webServer`) never waits.

### Sessions & evidence

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_checkpoint_list` / `_show` / `_delete` | `cairn checkpoint …` | manage resumable checkpoints (`health`, `staleMeta` and scope like `--json`) |
| `cairn_checkpoint_capture` | `cairn checkpoint capture-from-session` | save the live discovery session's browser state as a scoped checkpoint for `session: { resume: <name> }` |
| `cairn_stash_save` / `_list` / `_info` / `_restore` / `_search` | `cairn stash …` | validated file.cheap v0.30 save, discovery, inspection, restore, and search |
| `cairn_pin` | `cairn pin <run>` / `cairn unpin <run>` | keep a run past retention (`unpin: true` removes the pin; `stash: true` also saves it with the `keep` tag) |
| `cairn_publish` | `cairn publish <run>` | send the gated run to the private file.cheap artifact service with a metadata-only run index |
| `cairn_clip` | `cairn clip <run-ref>` | cut vidtrace video clips from a run |

### Failure → code

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_investigate` | `cairn investigate <run-id>` | stash a failed run + vecgrep code candidates |
| `cairn_audit` | `cairn audit <spec>` | run with video + investigate (`reuseServices` like `cairn_run`) |
| `cairn_annotate` | `cairn annotate <symbol>` | pin a note/data to a codemap symbol |

### Environment

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_secrets_status` | `cairn secrets` | TinyVault provider status + keys |
| `cairn_services_status` | `cairn services status` | services environment state (docker/seed/tmux) for `env`, plus the `cairn services up` lock (owner, age, `stale` / `problems`) |
| `cairn_services_up` | `cairn services up` | start the config services through the run's own code path, leave them running and write the config's owner lock; `cairn_run` for that env then needs `reuseServices: true`. Needs `cairn mcp --allow-services` |
| `cairn_services_down` | `cairn services down` | run the configured teardown commands, kill a still-running tmux session, stop the tunnels and run the provisioner's `down` (exit 8 when a critical entry failed), and remove the lock. Like `cairn_services_up` / `cairn_services_restart`, exit 4 with nothing touched while a live `cairn run` (another process) holds the config's `run.lock` (`runLock` names the owner) |
| `cairn_services_restart` | `cairn services restart <window...>` | restart tmux service windows (Ctrl-C, wait for the exit, resend the command, wait for the new generation's `readyOn`); `windows`, `config`, `env`, `stopTimeout`, `readyTimeout`; `urn:cairntrace.dev:services-restart:v1`. Needs `cairn mcp --allow-services` |
| `cairn_services_logs` | `cairn services logs <window>` | a service window's redacted output: `sinceRestart`, `lines`, `wait` + `timeout` (exit 1 on timeout); read-only; `urn:cairntrace.dev:services-logs:v1` |
| `cairn_wait` | `cairn wait <gate\|url...>` | wait for readiness gates in order (`targets`: config `gates:` names, `http(s)://` URLs, `tcp://host:port`; `status`, `anyResponse`, `timeoutMs`, `everyMs`, `stable`); `urn:cairntrace.dev:wait:v1` |
| `cairn_fixtures_list` / `_status` | `cairn fixtures list` / `status` | the config `fixtures:` registry, and each fixture's ledger state in `env` (`verify: true` re-checks it) |
| `cairn_fixtures_ensure` / `_reset` / `_teardown` | `cairn fixtures ensure` / `reset` / `teardown` | run one fixture verb (`name`, `with`, `allowWrites` for a shared or protected environment); `urn:cairntrace.dev:fixtures:v1` with the `fixture.*` events and outputs |
| `cairn_fixtures_sweep` | `cairn fixtures sweep` | find fixtures the ledger still shows live or failed, one row per run instance (`olderThan`, `includeSeed`) and, with `apply: true`, tear them down |

See [Services](/services#keeping-services-up-cairn-services-up-down) for the lock rules.

### Discovery (interactive authoring)

Twelve stateful tools that keep a browser session alive across calls. Every action runs through the same engine as `cairn_run` on the session's browser, and each session keeps a journal under `<artifactRoot>/_sessions/<id>/`. The browser closes after 30 minutes idle (`ttlMs`, config `discovery.sessionTtlMs`); the journal stays, so export, suggest and network still work and `cairn_discover_resume` re-opens the session.

`cairn_discover_open` (optional `setup`, `resume`, `backend`) → `cairn_discover_snapshot` / `cairn_discover_inventory` → `cairn_discover_interact` / `cairn_discover_navigate` (`snapshotMode: diff` by default; results carry `network.mutations`) → `cairn_discover_network` / `cairn_discover_suggest` / `cairn_discover_remove_step` → `cairn_discover_export` → `cairn_discover_close`. `cairn_discover_list` lists sessions (`all: true` includes closed journals). `cairn_snapshot` is the stateless one-shot; the CLI equivalent is `cairn discover [url]`. See [Discover & snapshot](/discover). With `into` (or `conventions: true`), `cairn_discover_export` writes a draft the project's way — existing actions as `use:`, config values as `${vars.X}`, secrets as placeholders, step ids, waits, `postcondition.network` — and reports what it did; see [Author a spec from a request](/author-flow).

`cairn_discover_open` and `cairn_snapshot` read the project config like a run (`env`, `config`, `var`): relative URLs join the environment `baseUrl`, and the test-id inventory scans `browser.testIdAttribute`. An `env` the config does not define, or a relative URL with no baseUrl on a real browser, is an error. Discovery records the URL as requested (placeholders and relative paths intact), so `cairn_discover_export` never writes a resolved secret; URLs the tools return are redacted.

### Prompts

`author-flow` (arguments `request`, optional `env` and `targetDir`) returns the recipe from a few sentences of request to a promoted spec: `cairn_catalog` → `cairn_discover_open` with a login setup → `cairn_discover_interact` (snapshot diffs) → `cairn_discover_export` into the drafts dir → `cairn_spec_finish` → report, and `cairn_spec_promote` only after the human approves. `cairn docs author-flow` prints the same steps.

### Export

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_export_playwright` | `cairn export playwright` | convert a spec (or a directory) into `@playwright/test` source with a coverage report; `project`/`into` exports write `.cairn-export.json` |
| `cairn_export_verify` | `cairn export playwright --verify` | prove an export faithful: static gates (sentinels, target `tsc`, the host's eslint, `playwright test --list`, freshness), `differential` (`cairn run` and the exported test with one run token) and `mutate` (an inverted assertion must fail); `verifyProject` picks the host project on a multi-project config; returns `urn:cairntrace.dev:export-verify:v1`, `isError` when not passed (failed 1, error 2, inconclusive 3) |

### Import

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_import_playwright` | `cairn import playwright` | convert a `@playwright/test` file into a reviewable spec by a TypeScript AST walk (page objects, fixtures, helpers and `test.step` inlined); returns `coverage`, `warnings`, `todos`, `approximations`, `check` and the YAML (`force` overwrites; a draft that maps nothing is `refused` / `isError` unless `allowEmpty`) |
| `cairn_import_playwright_trace` | `cairn import playwright-trace` | convert a Playwright trace archive into a DRAFT spec (recorded actions as steps, draft outcomes from expects, the final URL and API calls; credentials are `${secrets.X}`); same report, same `force` / `allowEmpty` |

See [Export & import](/export#import).

### Journey briefs (fragile environments)

Compile a passing spec into operator instructions, or run it with try-then-ask when locators miss. See [Journey briefs](/brief).

| MCP tool | CLI | Purpose |
|---|---|---|
| `cairn_export_brief` | `cairn export brief` | compile intent, outcomes, fill values, and locator approximations (`--from-run latest` attaches the last **passed** run of this spec) |
| `cairn_accompany_open` | — (MCP-only session) | try authored locators; park on miss with brief + inventory |
| `cairn_accompany_choose` | — | supply a locator or snapshot `@ref`; Cairntrace retries the authored value and writes accepted replacements to a draft copy (`draft.spec.yml` / `draftTo`), never the source spec |
| `cairn_accompany_status` / `_list` | — | parked cursor and active sessions |
| `cairn_accompany_close` | — | abort or finalize; free the backend |

Discovery *records* a spec. Accompany *plays* one. They do not share a session registry.

### Resources

`cairn://catalog` is the catalog of the project the server runs in, as compact JSON scoped to the config's `defaultEnvironment`. Use `cairn_catalog` with a `query` for anything narrower.

## Read-only vs mutating

The bootstrap/docs trio (`cairn_explain`, `cairn_docs`, `cairn_doctor`) and `cairn_config_validate`, `cairn_config_vars`, `cairn_checkpoint_show`, `cairn_stash_list`, `cairn_stash_info`, `cairn_secrets_status`, `cairn_services_status`, `cairn_discover_list`/`_snapshot`/`_inventory`, `cairn_accompany_list`/`_status`, and `cairn_export_brief` (when used as a compile-only call) are read-only. `cairn_run_status`, `cairn_logs`, `cairn_catalog`, `cairn_discover_network`, `cairn_spec_lint` without `fix`, `cairn_fixtures_list` and `cairn_fixtures_status` are read-only too (`status` with `verify: true` runs each fixture's read-only verify verb). The rest are mutating — they write spec changes, run the runner, restore or stash artifacts, cut clips, or annotate codemap. `cairn_accompany_open` / `_choose` / `_close` drive a live browser.

Cairntrace ships **no built-in confirm gate**. If your harness wants a typed "I really meant to run that" gate, enforce it harness-side with a tool-permission allowlist: allow the read-only set freely, gate the mutating set behind an explicit approval. The server does not pause for interactive prompts.

`cairn_stash_info` and `cairn_stash_restore` declare MCP output schemas.
Malformed file.cheap responses are rejected before they reach
`structuredContent`. Operational failures return `isError: true` with a stable
error code and a next-step hint. A restore that wrote bytes but failed hash
verification also preserves its normalized receipt under
`structuredContent.restore`; do not treat that target as trusted.

## Secret redaction

The MCP server inherits the CLI's text/JSON redaction layer. Structured tool
responses and text evidence use the same redacted shape written to disk:
registered literal secrets, sensitive keys, Authorization/Cookie header lines,
and common token-bearing query parameters are scrubbed. Tool results can still
contain paths to producer-owned binary artifacts. Screenshots, videos,
downloads, transforms, and trace archives are not content-redacted and may
contain secrets or personal data. Audit post-processes vidtrace text formats
through the redactor, but extracted frames/images remain uninspected. Treat a
run-directory path as access to sensitive evidence; do not make it available
to an untrusted MCP client.

## Cookbook: setting up an MCP client

For Claude Code, Codex, Cursor, OpenCode, or any other MCP-aware harness, register the `cairn` binary on stdio:

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

Use `"args": ["mcp", "--allow-hooks"]` only for trusted clients that need `cairn_run` before/after hooks, and add `"--allow-services"` only where an agent may start and tear down the config services itself (never for environments whose services provision paid infrastructure).

Pin the binary version in your setup script (`brew install abdul-hamid-achik/tap/cairntrace`, `npm install -g @thelacanians/cairntrace@3.0.0`, or `git checkout v3.0.0 && bun install`). A 3.x server starts config services only as `cairn mcp --allow-services` and runs `before`/`after` hooks only as `cairn mcp --allow-hooks`. The first `cairn_explain` call you make surfaces the current tool surface so the agent can bootstrap without guessing.

## See also

- [Distribution](/distribution) — how to install the CLI/MCP binary
- [Configuration](/configuration) — config keys (there is no `mcp:` block; transport is stdio-only)
- [Agents](/agents) — the recommended agent loop
- [Discover & snapshot](/discover) — the interactive discovery tool family
- [Overview](/overview) — what cairntrace is
