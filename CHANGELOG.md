# Changelog

All notable changes to cairntrace are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
