# GitHub

Cairntrace development happens on `main`, with GitHub Actions enforcing the same checks locally and in CI. Releases are git tags mirrored as GitHub release pages; cairntrace is **not** published to npm or any other registry.

## Repository layout

- `cmd/cairn/` — entrypoint, dispatches CLI vs MCP.
- `internal/spec/` — spec parsing, validation, contract hash.
- `internal/core/` — runner + outcome evaluator.
- `internal/adapters/` — browser-backend adapters (`agent-browser`, `Playwright`, `Mock`).
- `internal/mcp/` — stdio MCP server.
- `internal/cli/` — cobra command handlers (thin).
- `specs/` — glyphrun E2E specs (`*.yml`).
- `examples/` — demo app + spec YAMLs meant to be copied.
- `docs/` — this site.
- `AGENTS.md` / `CLAUDE.md` — agent guidance.

The dependency direction is one-way: `cmd → core → {spec, adapters, mcp, cli}`. The CLI, MCP, and any future surface are thin callers of `internal/core` — never the reverse.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR. The CI matrix mirrors what `bun run verify` does locally:

1. `lefthook pre-commit` — typecheck (TS), lint (oxlint), format check (oxfmt), knip, vitest.
2. Build the CLI artifact.
3. Glyphrun flow suite (skipped on cold runners because they need a real browser backend).
4. Mark release artifacts into GitHub Releases on tag.

A red CI on `main` is a P1. Open a revert PR before shipping the next fix.

## Releases

```bash
git tag -s v1.25.0 -m "v1.25.0 — codemap integration"
git push origin v1.25.0
```

GitHub Actions handles the rest — GoReleaser builds binaries for darwin/linux × arm64/amd64, attaches them to the GitHub release, and updates the Homebrew tap via a workflow in the dedicated `homebrew-tap` repository.

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

## Homebrew tap

`abdul-hamid-achik/homebrew-tap` carries the `cairn` formula, updated automatically on each GitHub release. End users that want the CLI on `$PATH`:

```bash
brew install abdul-hamid-achik/tap/cairn
```

That's it — no `npm install` or `bun install` step. The tap CI runs against the latest release on every push.

## See also

- [Distribution](/distribution) — install paths and version pinning
- [Configuration](/configuration) — config schema and env resolution
- [Overview](/overview) — what cairntrace is
