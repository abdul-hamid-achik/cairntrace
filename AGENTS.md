# AGENTS.md — Cairntrace

Guidance for any coding agent (Claude Code, Codex, Cursor, OpenCode, …) working
in this repository. Read this once at session start; everything you need to be
productive is here.

## Project

Cairntrace is a **local-first behavioral browser-spec layer** for coding agents.
Specs declare `intent + outcomes` (the contract) and `steps` (repairable hints).
Agents author + run + heal those specs via the `cairn` CLI or the MCP server.

- CLI binary: `./bin/cairn` (bun shebang launcher; no compile step needed for dev)
- MCP server: `cairn mcp` (stdio JSON-RPC) — preferred path for MCP-aware agents
- Plan: `~/notes/cairntrace_project_plan.md` (private to the author)
- Examples: [`examples/`](./examples) — a tiny demo app + spec YAMLs
- Distribution: **not published to npm or GitHub Packages.** Users install by
  cloning `github.com/abdul-hamid-achik/cairntrace`, running `bun install`,
  and using `./bin/cairn` (optionally symlinked onto `$PATH`). Releases are
  git tags mirrored as GitHub release pages.
- Versioning: SemVer tags are the release record. All `v1.x.y` tags are
  Cairntrace v1; do not rewrite old tags/releases just to make the visible
  numbering look cleaner.

## Architecture in 60 seconds

```
spec YAML (intent + outcomes + steps)
        ↓ parseSpec (zod-validated, comment-preserving, ${baseUrl}/${env.X}/${vars.X} substituted)
        ↓ contract-hash check
Runner
        ↓ cold-start? clearBrowserState  (when CI=true or --cold-start)
        ↓ session.resume? loadState <checkpoint>
        ↓ viewport? setViewport  (spec-level wins over environment config)
        ↓ each step:
              when: predicate?  → maybe skip
              ${requests.<name>.…} placeholders spliced from captured responses
              request: → backend.request when available; bounded page-fetch fallback
              runStep(step) on the BrowserBackend  (AgentBrowserAdapter or MockBrowserBackend)
              capture snapshot/screenshot per artifacts policy
        ↓ OutcomeEvaluator (text / notText / url / network / noFailedRequests / console / count / xlsx / file / script)
        ↓ ArtifactWriter
              run.{json,yaml,md}  report.{html,json}
              agent_context.md  events.ndjson
              outcomes/<id>.md (+ .raw.json sidecar for script)
              snapshots/  screenshots/  console/  network/  spec.resolved.yml
```

The **CLI + artifact format are the agent interface.** Cairntrace ships no
per-agent code paths.

## Rules

- Keep the core runner deterministic and testable.
- Never write unredacted Authorization, Cookie, Set-Cookie, access tokens,
  refresh tokens, or passwords to artifacts.
- Keep spec parsing separate from backend execution.
- Keep headless CLI behavior working even if the TUI changes.
- Every agent-callable command must support `--format json|yaml|md` and have
  a stable JSON schema. No interactive prompts on `--json`/`--yaml` paths.
- Run artifacts include `report.html` and `report.json`. Keep report output
  redacted, self-contained, print-friendly, and themeable through
  `cairntrace.config.yml` `report.theme` / `report.colors`; do not add a
  separate report theme config file.
- Exit codes are meaningful: 0 success, 1 outcome-failure, 2 errored,
  3 cold-start gate, 4 lint, 5 heal-no-progress, 6 contract-hash mismatch.
- Prefer small adapters over coupling core logic to agent-browser or Playwright.
- Do **not** introduce per-agent code paths. The CLI + MCP server + artifact
  format are the agent interface.
- Do **not** add a `scripts/` folder for ad-hoc dev tooling. Use a CLI
  subcommand, a test file, or a tmp file you delete afterward.
- Do **not** commit one-off markdown notes, scratch plans, or temporary feature
  checklists. Commit markdown only when it is maintained project documentation
  such as `README.md`, `AGENTS.md`, `CLAUDE.md`, docs pages, changelogs, or
  release notes.

## Rules for agents authoring specs

- Outcomes must use only the typed vocabulary: `text`, `notText`, `url`,
  `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`,
  `httpJson`, `process`, `script`. If you need something else, use the `script`
  escape hatch — don't invent new verifier types. (`process` asserts on
  `--monitor` metrics; `httpJson` fetches app JSON with browser cookies.)
- Semantic locators (`by: role|label|text`) are STRICT: accessible-name,
  whole-name, case-insensitive, visible-only matching; zero matches fail the
  step with diagnostics; multiple matches are an error unless the locator
  carries `nth:`. Use `exact: true` for case-sensitive matching. Targets are
  auto-scrolled into view.
- `wait` text/notText and outcome `text`/`notText` equals/contains checks
  normalize whitespace and match case-insensitively by default, so rendered
  CSS casing does not make source-cased assertions fail. Set
  `caseSensitive: true` to opt out. Regex `matches` remains raw and
  case-sensitive. Step `when: "text:…"` / `when: "notText:…"` gates share the
  same rendered-text normalization (whitespace-collapsed, case-insensitive), so
  a `when:` gate and an outcome on the same copy agree; `when: "urlContains:…"`
  / `urlMatches:…` stay raw (URLs are case- and whitespace-significant).
- For authenticated API calls use the typed `request` step (browser-session
  cookies included, `assign:` + `${requests.<name>.body.X}` splicing) — not a
  node-script verifier full of fetch glue. Playwright executes request steps
  out of page with browser-context cookie sharing and a 30000ms default timeout;
  under Bun, the cookie bridge runs in a subprocess so the parent can kill it
  at `timeoutMs` even if native fetch stalls. Backends without native request
  support use a bounded page-fetch fallback.
- When a transient UI state must survive across interactions (a hover that
  reveals a popover you then click), use a `batch` step: ≥2 selector-only
  sub-steps run in one backend invocation (agent-browser `batch --bail`) so
  the state isn't lost between them. Semantic locators are not allowed inside
  `batch` — they need a snapshot round-trip that would defeat the single
  invocation; use `by: selector` there, or separate top-level steps. Batch
  clicks are paced by 100ms; checkboxes/radios/switches are re-queried across
  framework rerenders and verified in two stages: a ~500ms grace lets a slow
  async commit land before a single live-element recovery click, then a ~500ms
  settle confirms the result — if the control flipped back to its original
  value (a double-toggle from a late authored commit plus the recovery) the
  step fails loudly rather than passing a flipped-back state
  (`aria-checked="mixed"` is supported).
- Hydration-sensitive first interactions: prefer
  `open: { path, waitUntil: networkidle }` over a separate
  `wait: { load: … }` step.
- On agent-browser, post-click network-idle settling uses click-step `settleMs`,
  then spec-root `settleMs`, config `browser.postClickSettleMs`, then 5000ms.
  Playwright honors explicit click/spec values and otherwise keeps its native
  action/navigation waits. A resolved `settleMs: 0` skips the extra settle AND
  the link-delivery probe (the author is opting out of post-click waiting).
- Playwright `wait` steps and browser `evaluate` calls are hard-bounded
  (30000ms default, or the step/verifier timeout when supplied). Real Chromium
  runs use an external watchdog process that kills the browser at the deadline,
  so page navigation churn should fail the step instead of wedging the suite.
- Every spec must satisfy the **cold-start contract**: it must be replayable
  from a fresh browser session. Satisfy via one of:
  1. `imports: [actions/login_admin.yml]` + `steps: [{ use: login_admin }]`
  2. `session: { resume: <checkpoint-name> }` (capture with `cairn checkpoint capture-from-session` or `cairn login`)
  3. `preconditions: { commands: [{ run: "..." }] }`
- Before declaring a spec complete, run `cairn spec verify --json` once (include
  `--config <path>` if the spec uses config-backed `${vars.X}`), then run
  `cairn run --cold-start --json` once. If that fails, the spec isn't done.
- Do **not** edit `intent` or `outcomes` of an existing spec without surfacing
  a diff to the user. The `contractHash:` stamp will refuse the write if
  changed without `cairn spec verify --stamp`.
- Each outcome's evidence file must fit the §13b shape — if your verifier
  produces more, split outcomes or push detail to an `outcomes/<id>.raw.json`
  sidecar.
- On first contact, run `cairn explain --json` (CLI) or call the
  `cairn_explain` MCP tool to get the current surface and step/verifier
  vocabulary.
  For focused authoring guidance, use `cairn docs <topic> --json` or MCP
  `cairn_docs` (`authoring`, `steps`, `verifiers`, `downloads`, `scripts`,
  `artifacts`, `mcp`, `backends`) — don't rely on training-data knowledge of
  the CLI.

## Services Lifecycle

The `services:` block in `cairntrace.config.yml` lets `cairn run` own the
full multi-service environment lifecycle: docker, conditional data seeding,
tmux session management, and teardown — all config-driven, started once
before the spec pool and stopped after the last spec.

```yaml
services:
  docker:
    command: "docker compose up -d"
    reuseExisting: true
    readinessCheck: "curl -sf http://localhost:27017"
    healthcheck:
      command: "curl -sf http://localhost:9200/_cluster/health | grep -q green"
      intervalSeconds: 15
      retries: 5
  seed:
    command: "yarn demo-import"
    ttlSeconds: 21600
    freshnessCheck: "mongosh --quiet --eval 'db.count()' mongodb://localhost:27017/db"
  tmux:
    session: myapp
    reuseExisting: true
    options:
      - { key: mouse, value: "on" }
    env:
      NODE_ENV: development
    windows:
      - name: web
        cwd: web-app
        command: "yarn serve"
        readyOn: { url: http://localhost:8080 }
        healthcheck:
          command: "curl -sf http://localhost:8080/healthz"
          intervalSeconds: 20
          retries: 3
  stash:
    enabled: true
    autoStash: always
    capture: [tmux, docker, seed]
    tags: [services, myapp]
teardown:
  - "tmux kill-session -t myapp"
  - "docker compose down"
```

Key rules:
- Seed freshness is tracked at `~/.cairntrace/services/<project>.seed.json`
  with a three-layer check (fingerprint + TTL + optional data-level command).
- `--no-services` skips the entire lifecycle.
- `secrets.provider: tvault` injects vault secrets into the seed command's env.
  The `tvault:` block supports two modes: `project` (direct) or `group` + `env`
  (inheritance — resolves missing keys from the base environment via tvault's
  env-group feature).
- `cairn config validate --json` validates the config file (zod schema +
  cross-field `.refine()` rules: unique window names, readyOn constraints,
  tvault provider requires tvault block with either `project` or `group`+`env`).
- Session artifacts (tmux panes, docker logs, seed output) can be stashed to
  fcheap via `services.stash`.
- **tmux session reuse is the default** (decoupled from `--cold-start`, which
  is about the browser profile, not the dev servers). A running tmux session
  + its windows are reused across runs so dev servers aren't rebuilt each
  time; window creation is idempotent (a window that already exists by name is
  skipped, never duplicated). At end-of-run the session is LEFT ALIVE so the
  next run reuses it — cairn skips any `teardown` command that kills the
  managed session (it owns that lifecycle); other teardown (e.g. `docker
  compose down`) still runs. Set `tmux.reuseExisting: false` to force a fresh
  session (kills + recreates, and the kill teardown runs).
- `readyTimeoutMs: 0` (docker/tmux) and `timeoutMs: 0` (seed) wait
  **indefinitely** instead of timing out — use for slow first-up image builds
  or many containers. In interactive (TTY, `--format md`) runs, docker/seed
  command stdout+stderr stream live to the terminal, and each not-yet-ready
  tmux window's pane tail is streamed every few seconds so a stuck window
  shows its startup logs/errors instead of a blind wait. Non-interactive/CI
  runs stay quiet (the logger's default warn level suppresses info).
- **Per-environment overrides:** `environments.<name>` can carry `services:`
  and `secrets:` blocks. `services: false` disables all services for that env
  (e.g. `dev`/`test` where the app is already deployed remotely). A partial
  `services:` block deep-merges over the top-level one. An env-level `secrets:`
  block replaces the top-level one entirely. This replaces the need for
  `--no-services` or `--services-dry-run` when running against remote envs.

## Logging & output

**Contract:** stdout is reserved for structured results (JSON/YAML/markdown
via `--format`). All diagnostic/lifecycle logs go to **stderr** — including the
services lifecycle narration and live subprocess output. `cairn run`/`cairn
clean` route through the leveled logger (`src/cli/logger.ts`); other commands
are migrating incrementally.

**Verbosity** (global flags + env + config, highest priority first):
- `--log-level <debug|info|warn|error|silent>`, `--quiet` (=warn),
  `--verbose` (=debug). Default: info on a TTY, warn in CI/piped.
- `--log-format <human|json>` (json = one NDJSON object per log line).
- `--no-color` / `NO_COLOR`. `CAIRN_LOG_LEVEL` / `CAIRN_LOG_FORMAT` env.
- `logging: { level, format, color }` in cairntrace.config.yml sets project
  defaults that flags/env override.

## Retention

`retention: { keepRuns: N }` prunes the artifact root to the newest N runs per
spec after every run (and via `cairn clean`). **Default is 3** when no
`retention` block is set; `retention: { enabled: false }` keeps everything.
`archiveToStash: true` archives pruned run dirs to fcheap before deletion
(best-effort — if the archive fails the run is retained on disk so no
artifacts are lost; `archiveTags: [...]` tags them). Failed/errored runs get a
`keepFailedRuns` carve-out (default 10) so a real failure's forensics survive
routine pruning. Interrupted runs — a signal killed the process before
`run.json` was written, leaving missing/corrupt/statusless metadata — are NOT
carve-out protected; they count toward the `keepRuns` window like any other
run, so the newest interrupted run is preserved up to the cap but old ones age
out. Signal-time `aborted-<ts>-<pid>.json` partial-batch summaries at the
artifact root are swept under the same `keepRuns` cap. `cairn clean --all`
(keepRuns 0, keepFailedRuns 0) removes everything.

## Discovery sessions

Discovery is the interactive authoring path — an agent explores a live page
through the harness and records each interaction as a spec step, then exports
the session as a spec YAML. This replaces blind authoring (write → run →
fail → heal) with explore → record → export.

**MCP tools** (primary interface, 9 tools):
`cairn_discover_open` → `cairn_discover_snapshot` / `cairn_discover_inventory` →
`cairn_discover_interact` / `cairn_discover_navigate` →
`cairn_discover_suggest` → `cairn_discover_export` → `cairn_discover_close`.
Use `cairn_discover_list` to check for active sessions.

**CLI** (one-shot): `cairn discover <url> [--roles] [--testids] [--env <name>]`
returns the full accessibility tree + locator inventory in one call.

Sessions are stateful — the browser stays alive across MCP tool calls.
Auto-expire after 5 min of inactivity. Use `mock: true` for fast offline
exploration. Exported specs include cold-start contract comments but the
agent must satisfy the cold-start contract separately (imports, checkpoint,
or preconditions). Run `cairn docs discovery --json` or MCP `cairn_docs` with
topic `discovery` for the full workflow guide.

## Browser automation

Cairntrace has two backends; the spec doesn't have to know which one runs.

- **`agent-browser`** (default) — AI-native browser CLI with semantic
  locators and compact accessibility snapshots. See
  `src/adapters/agent-browser/`.
- **`playwright`** — full Playwright with native traces, video, and HAR. Pass
  `--backend playwright` to `cairn run` or `cairn spec heal`. Install the
  browser binary with `bunx playwright install chromium`. The adapter uses
  `locator.ariaSnapshot()`, whose output the heal `snapshotParser` reads.
  Request steps run out of page with context-cookie sharing (`browserContext.request`
  when safe, isolated Bun cookie bridge under Bun), so they send page cookies,
  persist `Set-Cookie`, and are not coupled to page evaluation. In CI,
  Playwright Chromium launches with `--no-sandbox` and
  `--disable-dev-shm-usage` by default; override with
  `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` when a runner needs different flags.

### agent-browser quirks (when reading `AgentBrowserAdapter.ts`):

- `--session <name>` is a global flag; the adapter stamps this on every call.
- Interactive steps (click/hover/fill/upload, plus semantic `scroll.to` and
  downloads) do NOT use agent-browser's `find` family — `find` reports
  success on zero matches. The adapter resolves semantic locators against
  `snapshot -i`, scrolls the `@ref` into view, acts on the ref, and records
  the resolved element as step evidence.
- Link clicks are classified first: only a same-tab http(s)/relative nav link
  installs the short URL/DOM-mutation delivery probe. If such a link reports
  success without either signal and remains enabled, Cairntrace retries once
  with low-level mouse input at its live center. External-effect links —
  `target="_blank"`, a `download` attribute, or a `mailto:`/`tel:`/`javascript:`
  scheme — legitimately never mutate the current document, so they are clicked
  exactly once and pass with a diagnostic note (no verification, no retry).
  Ordinary buttons never receive this retry, and the whole probe is skipped
  when the click resolves to `settleMs: 0` or `verifyAfterClick: false`.
- `batch` steps are the exception that runs through agent-browser's native
  `batch --bail`: each selector sub-step maps to one command via
  `batchSubStepToArgv`, joined and quoted with `quoteIfNeeded`. This is the
  only path that issues multiple interactions per invocation (to preserve
  hover/focus state); it's selector-only precisely because there's no
  per-sub-step snapshot resolution.
- Transient `os error 35` / daemon-busy failures are retried twice with
  backoff inside `invoke()`.
- Every invocation carries a hard execa `timeout` (60s default; step-level
  `timeoutMs` + 5s grace when present) so a wedged daemon can never hang a
  run — the child is killed and the step fails with a timeout error. Screenshot
  capture uses a tighter 15s deadline and reports a rendering-surface/display
  hint instead of publishing a partial PNG. A screenshot timeout is
  best-effort: it records a warning + missing-artifact note but never fails the
  step, spec, or outcomes; it only marks the backend wedged so the remaining
  OPTIONAL captures (console/network/trace/video) are skipped — outcome
  verifiers still run and a truly wedged page fails on its next interaction.
- The session daemon's command queue is serial: a `close` issued mid-`wait`
  queues behind it, and a SIGTERM delivered while the daemon is busy is
  dropped (verified on 0.26–0.27). Signal-time cleanup therefore goes through
  `terminateSync()` — SIGTERM the daemon via `~/.agent-browser/<session>.pid`,
  then escalate to killing its Chrome children + SIGKILL. The handler must
  stay fully synchronous: with an in-flight execa child, signal-exit
  re-raises the signal as soon as the sync portion returns.
- `navigate <url>` (not `open <url>`) is what we send for `OpenStep` — `open`
  is for launching the browser, `navigate` for navigation.
- `network requests --json` and `console --json` wrap results in
  `{success, data: {requests|messages: [...]}, error}` — see `parseEnvelope()`.
- `eval <expr>` auto-stringifies the result as JSON; the `script` verifier
  wrapper returns the object directly (no extra `JSON.stringify`).
- No native `--notText` wait; we synthesize it with `wait --fn` using the
  normalized text predicate and the step's `caseSensitive` setting.
- The special region token `"page"` translates to `body` for `get text`.

## Development

```bash
bun install            # install deps
bun run typecheck      # tsc --noEmit
bun run test           # vitest run (coverage threshold: 80%)
bun run lint           # oxlint
bun run format         # oxfmt src bin
bun run knip           # detect unused exports/deps
bun run verify         # typecheck + lint + format:check + knip + tests (the gate)
./bin/cairn doctor     # sanity check (node/bun/agent-browser/artifact root)
```

## Layout

```
src/
  cli/             commands/* — one file per CLI subcommand
  core/
    parser/        parseSpec (YAML + zod + ${X} substitution + imports + baseUrl)
    runner/        Runner, OutcomeEvaluator, verifiers/, conditions (when:)
                   webServer.ts (single-server lifecycle)
                   services.ts (multi-service lifecycle: docker/seed/tmux)
                   seedState.ts (seed freshness tracking)
    artifacts/     ArtifactWriter, renderers/, evidence, agentContext
    schema/        zod-first schemas (spec.v1, verifier.v1, run.v1, heal.v1, explain.v1,
                   config.v1 (services, healthcheck, stash), docs.v1, ...)
    checkpoint/    CheckpointStore (~/.cairntrace/checkpoints/<name>.json)
    config/        loader for cairntrace.config.yml
    contractHash   sha256 over intent + outcomes
    healer/        snapshotParser, Healer
  adapters/
    browserBackend.ts          the interface
    agent-browser/             real backend (commandBuilder + AgentBrowserAdapter)
    mock/                      MockBrowserBackend for tests + --mock
  mcp/             buildMcpServer() — tools mirror the CLI surface
examples/          demo-app + spec YAMLs (see examples/README.md)
bin/cairn          bun shebang launcher
```

## Adding a new verifier (when you really need one)

1. Add the typed schema in `src/core/schema/verifier.v1.ts` to the union +
   `VerifierKindSchema` enum + `is<X>Verifier` predicate + `verifierKind()` switch.
2. Implement `src/core/runner/verifiers/<name>.ts`.
3. Add the dispatcher branch in `src/core/runner/OutcomeEvaluator.ts`.
4. Update `cairn explain` (CLI command + MCP tool).
5. Add tests in `src/core/runner/verifiers/verifiers.test.ts`.

But: prefer the `script` escape hatch if the need only shows up in one spec.
Only promote to a typed verifier when 3+ real specs would benefit.

## When you finish a task

- Run `bun run verify`. It must be green.
- Smoke-test against the demo app if you touched anything in the run/heal
  pipeline (see `examples/README.md`).
- Version intentionally — choose patch/minor/major using the release rules
  below. Bump `package.json` `version` in the release commit. Push tags and
  create releases only when the user asks.

## Releasing (on the user's request only)

Cairntrace uses SemVer tags mirrored to GitHub releases.

- Patch: bug fixes, docs, importer/exporter polish, verifier fixes, runtime
  reliability work, or follow-up work that does not expand the CLI/schema
  surface in a meaningful way.
- Minor: new agent-callable commands, new typed steps/verifiers, new stable
  schema/artifact fields, or substantial non-breaking behavior.
- Major: breaking CLI flags, spec schema, artifact schema, MCP contracts, or
  migration-heavy behavior changes.

Before cutting a release:

- Inspect `git status --short` and make sure every file in the commit belongs
  to the release.
- Run `bun run verify`. It must be green.
- Smoke-test the demo app if runner, heal, backend, importer/exporter, or
  artifact behavior changed.
- Bump only `package.json`'s `version`; the README install guide deliberately
  hardcodes no version and resolves the newest tag dynamically.
- Do not delete, recreate, or rename old GitHub releases/tags unless the user
  explicitly asks to rewrite release history.

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main
git push origin vX.Y.Z
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

- `vX.Y.Z` tags are the **only** tag kind. Do not create or move a floating
  `latest` tag — GitHub marks the newest release "Latest" automatically, and
  `<repo>/releases/latest` always points at it.
