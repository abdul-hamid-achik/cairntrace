# GitHub

Cairntrace development happens on `main`, with a single GitHub Actions workflow enforcing the same checks locally and in CI. Releases are git tags mirrored as GitHub release pages; cairntrace is **not** published to npm or any other registry — it installs by clone + `bun install` (see [Distribution](/distribution)).

## Repository layout

```
bin/cairn          bun shebang launcher (the CLI + MCP entrypoint)
src/
  cli/             commands/* — one file per CLI subcommand (commander)
  core/
    parser/        parseSpec (YAML + zod + ${X} substitution + imports + baseUrl)
    runner/        Runner, OutcomeEvaluator, verifiers/, services lifecycle
    artifacts/     ArtifactWriter, renderers/, evidence, agentContext
    schema/        zod-first schemas (spec.v1, verifier.v1, config.v1, …)
    checkpoint/    CheckpointStore (~/.cairntrace/checkpoints/<name>.json)
    config/        loader for cairntrace.config.yml
    contractHash   sha256 over intent + outcomes
    healer/        snapshotParser, Healer
  adapters/
    agent-browser/ real backend (commandBuilder + AgentBrowserAdapter)
    playwright/    Playwright backend (native traces, video, HAR)
    mock/          MockBrowserBackend for tests + --mock
  mcp/             buildMcpServer() — tools mirror the CLI surface
examples/          demo-app + spec YAMLs (see examples/README.md)
docs/              this VitePress site
AGENTS.md / CLAUDE.md — agent guidance
```

The dependency direction is one-way: `cli → core → {adapters, mcp}`. The CLI, MCP, and any future surface are thin callers of `src/core` — never the reverse. No per-agent code paths live in core.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR (concurrency cancels superseded runs on the same ref). The job:

1. Sets up Bun (latest) + installs deps (`bun install`).
2. Installs Playwright Chromium (`bunx playwright install --with-deps chromium`).
3. Runs `bun run verify` — typecheck (`tsc --noEmit`), lint (`oxlint`), format check (`oxfmt`), knip, and the vitest suite (coverage threshold 80%).
4. Smoke-runs a real spec end-to-end against Chromium: boots `examples/demo-app/server.ts`, waits for it to answer on `:8787`, then `./bin/cairn run examples/flows/01-dashboard-nav.yml --backend playwright`.

A red CI on `main` is a P1. Open a revert PR before shipping the next fix. CI runs the same `bun run verify` you run locally — if it fails locally, it fails in CI.

## Releases

Releases are SemVer tags mirrored to GitHub releases. Bump only `package.json`'s `version` in the release commit, then:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin main
git push origin vX.Y.Z
gh release create vX.Y.Z --title vX.Y.Z --generate-notes
```

Versioning (see AGENTS.md): patch for fixes/docs/polish, minor for new agent-callable commands/steps/verifiers/stable schema fields, major for breaking CLI/spec/artifact/MCP contracts. `vX.Y.Z` tags are the only tag kind — do not create or move a floating `latest` tag; GitHub marks the newest release "Latest" automatically. Do not rewrite old tags/releases unless explicitly asked.

## Branching and PRs

- Work happens on feature branches off `main`.
- One logical change per commit. Multi-purpose commits make bisect painful.
- Subject line ≤ 72 chars, imperative ("Add ...", "Fix ...", not "Fixed ...").
- Body explains *why*, not *what* (the diff shows the what). Reference any issue or spec section that motivated the change.
- Don't push directly to `main` — open a PR even for small fixes so the diff is reviewable.
- Run `bun run verify` before pushing. CI runs the same checks; if it fails locally, it fails in CI.

## Working agreements for agents

The `AGENTS.md` and `CLAUDE.md` files pin the working rules for AI coding agents. Read them once per session. The unconditional "do not"s:

- Don't add per-agent code paths. The CLI + MCP server + artifact format are the agent interface.
- Don't write unredacted authorization, cookie, set-cookie, bearer, or basic-auth material to artifacts.
- Don't edit `intent` or `outcomes` of an existing spec without re-stamping the contract hash.
- Don't commit one-off scratch markdown notes — keep the repo clean.
- Don't bypass `lefthook` or CI without calling it out in the PR body.

## Companion tools (not cairntrace)

`cairn doctor` checks a set of optional companion tools on `$PATH`. Each has its own install path; cairntrace itself is **not** on Homebrew — it installs by clone. The companions:

- `fcheap`, `vecgrep`, `vidtrace`, `codemap`, `tvault` — install via the maintainer's Homebrew tap (e.g. `brew install abdul-hamid-achik/tap/fcheap`) or per their own docs. `cairn doctor --format md` tells you which are missing.

## See also

- [Distribution](/distribution) — clone-to-install, version pinning
- [Configuration](/configuration) — config schema and env resolution
- [Doctor & clean](/doctor) — the companion-tool availability check
- [Overview](/overview) — what cairntrace is