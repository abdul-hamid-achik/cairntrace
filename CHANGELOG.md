# Changelog

All notable changes to cairntrace are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [1.23.4]

### Added
- **Warnings for clip/video misconfigurations that would silently produce
  nothing.** A run now emits an `artifact.video` warning event when
  `clipPoints` are configured but `artifacts.capture.video` is `never` (so no
  video is recorded and no clips can be cut), or when video is requested on a
  backend that can't record it (only the playwright backend does). The marquee
  "run → video → vidtrace clip" loop no longer fails silently.

### Changed
- **Config `${env.X:-default}` now falls back on an *empty* env var, not just
  an unset one** — matching shell `:-` semantics and the spec parser, so
  `cairntrace.config.yml` and specs resolve the same placeholder identically.

### Internal
- Added GitHub Actions CI (`bun run verify` on push/PR + a real-Chromium
  end-to-end smoke); previously verification ran only via local git hooks.
- Added backend step-shape guards (opt-in strict `MockBrowserBackend`
  validation, a recorder→`StepSchema` contract test, and per-step
  `PlaywrightAdapter` coverage) so step-shape and adapter-no-op bugs can't ship
  green.

## [1.23.3]

### Fixed
- **MCP server now disposes its signal handlers on close.** `buildMcpServer`
  registered process-level `SIGINT`/`SIGTERM` handlers but never removed them,
  so building many servers in one process (e.g. across a test run) accumulated
  listeners past Node's `MaxListeners` default and emitted a warning.
  Production was unaffected (one server per `cairn mcp` process), but the noise
  masked any real listener leak. Handlers are now named and removed when the
  server closes, via the SDK's `Protocol.onclose` hook (chained so the SDK's
  own teardown is preserved).

## [1.23.2]

A review-and-fix pass over the v1.12–v1.23 DX/UX work. All fixes; no CLI/schema
surface changes.

### Fixed
- **Tvault secret values could leak unredacted into artifacts.** The artifact
  redactor only scrubbed env values whose *key* matched a sensitive-name
  heuristic (`token`, `secret`, `password`, …). Vault secrets with ordinary
  key names — `MONGO_URI`, `DATABASE_URL`, `STRIPE_*`, `SMTP_URL` — were
  injected into the environment but never registered for redaction, so their
  plaintext could appear in `spec.resolved.yml`, `run.json`, `report.html`,
  `agent_context.md`, and `events.ndjson`. Every value pulled from the vault is
  now registered with the redactor regardless of key name.
- **`type` step was a silent no-op under the Playwright backend.** The
  `PlaywrightAdapter` had no `type` branch in `runStep` or the batch path, so a
  `type` step reported a green pass while typing nothing (and the Playwright
  exporter dropped it). It now uses `locator.pressSequentially(...)`, and an
  exhaustiveness guard makes any future unhandled step fail loudly instead of
  passing.
- **`--env` did not reach the seed/services phase as `CAIRN_TVAULT_ENV`.**
  Services (docker/seed/tmux) start before secret injection, so under
  `cairn run --env dev` they resolved `${env.CAIRN_TVAULT_ENV:-local}` to
  `local` and could seed/migrate against the wrong environment's database.
  `CAIRN_TVAULT_ENV` is now set from `--env` at the very top of `cairn run`.
- **`${env.X:-default}` defaults containing `/` (URLs/paths) were not
  substituted in specs**, and substituted values that themselves contained
  `${...}` were re-expanded (cross-secret splicing, or a crash on a
  value-borne `${vars.X}`). Both are fixed by a single balanced-brace scanner
  that resolves each placeholder once and never re-scans a resolved value.
- **Discovery recorded schema-invalid `scroll` steps.** The step recorder
  emitted `{ scroll: { down: N } }`, which the strict schema rejects — it threw
  on the agent-browser backend and produced unparseable exported specs. Now
  emits `{ scroll: { direction, px } }`.
- **Services orphaned docker/tmux/seed on a partial-startup failure.** A
  later-phase failure (e.g. a tmux window that never becomes ready) left earlier
  phases running with no teardown. `startServices` now tears down what it
  started before propagating. Readiness and seed-freshness checks are also
  time-bounded now (they previously ran with no timeout and could hang a run
  forever).
- **Discovery browsers were orphaned on SIGINT/SIGTERM.** Session backends were
  created inline and not tracked by the signal-teardown machinery; the shutdown
  hook only fired an un-awaited async close. It now calls `terminateSync()` on
  each session backend so the agent-browser daemon + Chrome are killed on
  Ctrl-C.
- **Reviewing a discovery session could reap it mid-export.** Read-only ops
  (`_suggest`, `_export`) didn't refresh the session TTL, so a long review pause
  let the idle sweep close the session and lose all recorded steps. These ops
  now refresh activity.
- **Failed discovery steps were exported as if they had succeeded.** Export now
  excludes steps that did not execute successfully and reports how many were
  dropped.
- **`cairn spec verify --stamp` stripped hand-authored quoting.** Stamping
  re-serialized the whole spec in PLAIN style, mangling `"${vars.X}"` /
  `"${secrets.X}"` quotes and comments. It now updates only the `contractHash`
  node via the YAML Document API, preserving the rest of the file.
- **Discovery hardening:** concurrent operations on one session are now
  serialized (no interleaving on the shared browser), open sessions are capped
  to bound process/FD usage, user-declared services `teardown` commands run on
  the signal path, and a requested clip that can't be cut because vidtrace is
  missing now records a diagnostic instead of being silently dropped.

## [1.23.1]

### Fixed
- **`--env` flag now propagates to `CAIRN_TVAULT_ENV`** — when `cairn run --env dev`
  is used with `secrets.provider: tvault` in group/env mode, the tvault env
  was resolved from `${env.CAIRN_TVAULT_ENV:-local}` in the config. Since
  `--env` only set the cairn env name (for baseUrl/vars), but not
  `CAIRN_TVAULT_ENV`, tvault always resolved to `local` regardless of the
  `--env` flag. This meant dev-pinned secrets (e.g. `MONGO_URI`) were never
  injected. Now `--env <name>` sets `CAIRN_TVAULT_ENV=<name>` automatically,
  unless the caller explicitly set `CAIRN_TVAULT_ENV` to decouple the two.

## [1.23.0]

### Added
- **Tvault secret shadowing warning** — when `secrets.provider: tvault` is
  configured, `cairn run` now warns if any tvault secret key is already set
  in the process environment with a *different* value (e.g. from bun's
  automatic `.env` loading). Previously, stale `.env` credentials silently
  shadowed tvault values with no diagnostic, causing authentication failures
  that were hard to trace. The warning names the affected keys and suggests
  removing them from `.env` or unsetting them.

## [1.22.0]

### Added
- **`${env.X:-default}` fallback syntax** — spec placeholders now support
  shell-style default values when an env var is missing or empty:
  `${env.MISSING:-fallback}`. Defaults can themselves contain runtime
  placeholders like `${run.token}`. Empty-string env vars trigger the
  fallback, not just undefined ones.

## [1.21.0]

### Added
- **Discovery sessions** — interactive page exploration and spec authoring
  via `cairn discover open/navigate/interact/snapshot/export`. Create a
  stateful browser session, navigate, take accessibility snapshots, perform
  actions (click, fill, hover, type, scroll, press), and export recorded
  steps as a spec YAML file.

## [1.16.0]

### Added
- **`eval` step type** — a page-context JavaScript escape hatch that runs
  arbitrary JS in the browser via `backend.evaluate()` and optionally captures
  the JSON-serializable return value as `evals/<assign>.json`. Captured values
  are spliced into later steps via `${evals.<name>.value.<field>}`. Use it for
  state setup and internal-state assertions that no UI affordance can reach
  (seed a Vuex/Redux/Pinia store, read `localStorage`, assert on a computed
  property). Exactly one of `js` (inline) or `file` (path to a .js file) is
  required; optional `args` is passed as the single argument to the wrapped
  function; `assign: name` writes `{ value: <return> }` to `evals/<name>.json`
  (after redaction). Opaque to `heal` — there is no locator to repair. The
  backend primitive (`BrowserBackend.evaluate()`) already existed across all
  three adapters; this is a schema + runner + docs + tests effort.
- **`evals/` artifact directory** — eval step return values are written as
  `evals/<assign>.json` alongside `downloads/`, `transforms/`, `requests/`.
- **`${evals.<name>.value.<field>}` runtime placeholder** — mirrors
  `${requests.<name>.body.<field>}`; resolves into any string field of later
  steps. Unknown names/paths render as empty string.
- **`artifact.eval` event type** — emitted in `events.ndjson` when an eval
  step captures a value.
- **`ArtifactRef.kind: "eval"`** — eval artifacts appear in `RunArtifacts.evals`,
  evidence files, `agent_context.md`, and `report.html` artifact links.
- **`evals` in `VerifierContext`** — script verifiers can access captured eval
  values via `ctx.evals` / `${evals.*}` fixture interpolation.

### Changed
- **`healSpec` skips eval steps** — returns `no-heal-possible` with a clear
  "eval steps are not healable — escape hatch" message instead of attempting
  locator-based repair.
- **`collectUnresolvedRuntimeRefs`** now scans for `${evals.<name>...}` refs
  in addition to `${artifacts.*}` and `${requests.*}` — outcomes depending on
  a never-produced eval value are reported as blocked, not failed.
- **`resolveFixtureMap`** resolves `${evals.*}` placeholders in script verifier
  fixtures.

## [1.15.0]

### Added
- **Per-run codemap auto-annotation (pass + fail)** — `cairn run --auto-annotate on-run`
  emits one codemap annotation per run with run context: `{ specName, contractHash,
  runId, status, outcomes, failedVerifier }`. The `contractHash` lets codemap
  consumers invalidate stale green badges when the spec's contract changes. This
  generalizes the existing `on-investigate` annotate seam from failure-only to
  bidirectional (pass + fail), closing the loop with future impact-driven spec
  selection. (CODEMAP-INTEGRATION.md item B.)
- **`annotate.autoAnnotate: on-run`** config mode — the enum now accepts
  `on-run | on-investigate | never` (previously `on-investigate | never`).
- **`--auto-annotate <mode>`** CLI flag on `cairn run` — overrides config
  `annotate.autoAnnotate`; accepts `on-run` or `never`.
- **`maybeAutoAnnotateRun`** exported from `annotate.ts` — wired into both
  `runSingle` and `runBatch` paths, best-effort (silently skipped if codemap
  isn't installed).

## [1.14.1]

### Fixed
- **tvault availability checks** in `doctor`, `secrets`, and the MCP server used
  `tvault version` (a non-existent subcommand). tvault expects `tvault --version`.
  The old call always failed, so tvault was misreported as unavailable even when
  installed.

## [1.14.0]

### Added
- **Services lifecycle block** — `cairn run` can now own the full multi-service
  environment lifecycle via the `services:` config block:
  - **Docker**: `docker compose up -d` with `reuseExisting` detection,
    `readinessCheck` command, and `healthcheck` (command + startPeriod + interval
    + timeout + retries).
  - **Conditional seed**: runs once, then skips if fresh (three-layer check:
    fingerprint + TTL + optional `freshnessCheck`). State tracked at
    `~/.cairntrace/services/<project>.seed.json`.
  - **tmux session management**: creates sessions from scratch with session-level
    `options`, `env` (via `tmux set-environment`), `defaultShell`, per-window `env`,
    `preCommands`, `readyOn` (URL or text), and per-window `healthcheck`.
  - **Teardown**: reverse order (tmux kill → docker down).
  - **fcheap session stash**: optionally stash session artifacts (tmux panes, docker
    logs, seed output) to fcheap via `services.stash`.
  - **tvault integration**: `secrets.provider: tvault` injects vault secrets into
    the seed command's env (first time `getTvaultEnv()` is called from the run path).
  - **`--no-services`** CLI flag to skip the entire lifecycle.
- **`cairn config validate`** command — validates `cairntrace.config.yml` structure
  (zod schema) and cross-field rules (unique window names, readyOn constraints, tvault
  provider requires tvault block). Supports `--config`, `--format json|yaml|md`.
- **`cairn_config_validate` MCP tool** — mirrors the CLI command.
- **`services` doc topic** — `cairn docs services` returns full documentation for the
  services lifecycle, healthchecks, and fcheap session stash.
- **HealthcheckSchema** — Docker-style healthcheck semantics for docker and tmux
  windows (command, startPeriod, interval, timeout, retries).
- **`docker.readinessCheck`** — shell command run after `docker compose up` completes.
- **SeedStateStore** — seed freshness tracking at
  `~/.cairntrace/services/<project>.seed.json`.
- **lefthook** pre-commit hooks (typecheck, lint, format:check, knip, tests).
- **knip** configuration for unused exports/deps detection.
- **Coverage enforcement** — 80% minimum threshold in vitest config.
- **Shared helpers exported from `webServer.ts`** — `runShell`, `probeOnce`, `sleep`,
  `spawnProcess` for reuse by `services.ts`.

### Fixed
- **`script` verifier no longer rejects numeric/boolean `fixtures` values with a misleading error.**
  `verify.script.fixtures` previously required string values (`z.record(string, string)`). Spec
  authors routinely supply numbers/booleans — most often through `${var}` interpolation (e.g. an
  expected row count of `0`, which YAML parses as a number). Because `ScriptVerifierSchema` is one
  member of the **strict** `VerifierSchema` `z.union`, a single non-string fixture value made the
  whole `script` member fail to parse, and Zod then surfaced the *sibling* members' rejection of
  the unmatched `script` key as:

  ```
  Unrecognized key(s) in object: 'script'
  ```

  i.e. a valid-looking spec read as *"the `script` verifier isn't supported."* This was easy to
  misdiagnose as a parser/schema "cold-init" defect (it appeared intermittent because it depended
  on whether a given spec's fixture values happened to be strings or numbers).

  `fixtures` now accepts `string | number | boolean` and stringifies each value, so verifiers still
  receive `Record<string, string>`. Objects/arrays are still rejected as genuine errors, and the
  `exactly one of run | file` rule is unchanged.

  - Authors no longer need to defensively quote numeric interpolations
    (`expectedRowCount: "${vars.count}"`); `expectedRowCount: ${vars.count}` works.

### Investigation note
- An earlier hypothesis blamed a TDZ / circular-import in `src/core/schema/*` causing union members
  to be dropped at construction. This was **refuted**: the schema dependency graph is an acyclic
  DAG, `VerifierSchema`/`StepSchema` build with all members, and the defect did not reproduce
  against source. The true cause was the strict-union error masking a fixture type mismatch (above).

### Tests
- Added `src/core/schema/verifier.v1.test.ts` covering string/number/boolean fixtures, object/array
  rejection, and the `run`/`file` exclusivity rule.

## [1.12.0]
- Video capture (`artifacts.capture.video`), fcheap stash integration, `investigate`/`audit`,
  codemap + TinyVault integration, doctor checks. (See release notes.)
