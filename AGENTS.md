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
              run.{json,yaml,md}  agent_context.md  events.ndjson
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
  `script`. If you need something else, use the `script` escape hatch —
  don't invent new verifier types.
- Semantic locators (`by: role|label|text`) are STRICT: accessible-name,
  whole-name, case-insensitive, visible-only matching; zero matches fail the
  step with diagnostics; multiple matches are an error unless the locator
  carries `nth:`. Use `exact: true` for case-sensitive matching. Targets are
  auto-scrolled into view.
- For authenticated API calls use the typed `request` step (browser-session
  cookies included, `assign:` + `${requests.<name>.body.X}` splicing) — not a
  node-script verifier full of fetch glue. Playwright executes request steps
  out of page with browser-context cookie sharing and a 30000ms default timeout;
  backends without native request support use a bounded page-fetch fallback.
- When a transient UI state must survive across interactions (a hover that
  reveals a popover you then click), use a `batch` step: ≥2 selector-only
  sub-steps run in one backend invocation (agent-browser `batch --bail`) so
  the state isn't lost between them. Semantic locators are not allowed inside
  `batch` — they need a snapshot round-trip that would defeat the single
  invocation; use `by: selector` there, or separate top-level steps.
- Hydration-sensitive first interactions: prefer
  `open: { path, waitUntil: networkidle }` over a separate
  `wait: { load: … }` step.
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
  when safe, Bun-safe cookie bridge under Bun), so they send page cookies,
  persist `Set-Cookie`, and are not coupled to page evaluation.

### agent-browser quirks (when reading `AgentBrowserAdapter.ts`):

- `--session <name>` is a global flag; the adapter stamps this on every call.
- Interactive steps (click/hover/fill/upload, plus semantic `scroll.to` and
  downloads) do NOT use agent-browser's `find` family — `find` reports
  success on zero matches. The adapter resolves semantic locators against
  `snapshot -i`, scrolls the `@ref` into view, acts on the ref, and records
  the resolved element as step evidence.
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
  run — the child is killed and the step fails with a timeout error.
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
- No native `--notText` wait; we synthesize it as `wait --fn "() => !document.body.innerText.includes(...)"`.
- The special region token `"page"` translates to `body` for `get text`.

## Development

```bash
bun install            # install deps
bun run typecheck      # tsc --noEmit
bun run test           # vitest run
bun run lint           # oxlint
bun run format         # oxfmt src bin
bun run verify         # typecheck + lint + tests (the gate)
./bin/cairn doctor     # sanity check (node/bun/agent-browser/artifact root)
```

## Layout

```
src/
  cli/             commands/* — one file per CLI subcommand
  core/
    parser/        parseSpec (YAML + zod + ${X} substitution + imports + baseUrl)
    runner/        Runner, OutcomeEvaluator, verifiers/, conditions (when:)
    artifacts/     ArtifactWriter, renderers/, evidence, agentContext
    schema/        zod-first schemas (spec.v1, verifier.v1, run.v1, heal.v1, explain.v1, ...)
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
