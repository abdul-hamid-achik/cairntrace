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

## Architecture in 60 seconds

```
spec YAML (intent + outcomes + steps)
        ↓ parseSpec (zod-validated, comment-preserving, ${baseUrl}/${env.X}/${vars.X} substituted)
        ↓ contract-hash check
Runner
        ↓ cold-start? clearBrowserState  (when CI=true or --cold-start)
        ↓ session.resume? loadState <checkpoint>
        ↓ each step:
              when: predicate?  → maybe skip
              runStep(step) on the BrowserBackend  (AgentBrowserAdapter or MockBrowserBackend)
              capture snapshot/screenshot per artifacts policy
        ↓ OutcomeEvaluator (text / notText / url / network / noFailedRequests / console / count / script)
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

## Rules for agents authoring specs

- Outcomes must use only the v0 vocabulary: `text`, `notText`, `url`,
  `network`, `noFailedRequests`, `console`, `count`, `script`. If you need
  something else, use the `script` escape hatch — don't invent new verifier types.
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
  `cairn_explain` MCP tool to get the current surface and verifier vocabulary.
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

### agent-browser quirks (when reading `AgentBrowserAdapter.ts`):

- `--session <name>` is a global flag; the adapter stamps this on every call.
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
- Tag intentionally — significant feature sets get a `vX.Y.Z` git tag with a
  release-note style commit message.
