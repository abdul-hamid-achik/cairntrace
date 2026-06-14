# Claude Code instructions

Cairntrace uses [AGENTS.md](./AGENTS.md) as the canonical instruction set for
all coding agents. Read that file first — everything below assumes you have.

## Claude Code specifics

- The bin shebang uses `bun`, not `node`. Don't suggest `node ./bin/cairn` —
  it won't work without compile.
- Tests run under `vitest`, not `bun:test`. Use `bun run test`, never
  `bun test <file>` (the latter invokes Bun's native runner and quietly
  changes `toContain`/`expect.any` semantics).
- The user prefers terse responses with structured updates. Critique is
  welcomed; soft-pedaling is not.
- Do not introduce a `scripts/` folder for ad-hoc utilities — the user has
  flagged it as a pattern they dislike. CLI subcommands, test files, or
  short-lived tmp files only.
- Do not commit one-off markdown notes, scratch plans, or temporary feature
  checklists. Markdown belongs in the repo only when it is maintained project
  documentation such as README, agent instructions, docs pages, changelogs, or
  release notes.
- Request steps are no longer documented as page-only fetches. Playwright uses
  an out-of-page, context-cookie-sharing transport with a 30000ms default
  timeout. Under Bun, the cookie bridge runs in a subprocess so the parent can
  kill it at `timeoutMs`; agent-browser currently relies on the bounded
  evaluate fallback.
- Playwright Chromium gets `--no-sandbox` and `--disable-dev-shm-usage`
  automatically when `CI` is truthy. Use `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` only
  when a runner needs different flags.
- The repo is public at `github.com/abdul-hamid-achik/cairntrace` with tagged
  GitHub releases. Don't push or cut a release proactively — the user drives
  that timing. When asked, follow the "Releasing" checklist in AGENTS.md:
  choose the SemVer increment, bump only `package.json`, create an annotated
  `vX.Y.Z` tag, push, then run `gh release create`. Use patch releases for
  fixes/docs/polish, and never create a floating `latest` tag or rewrite old
  releases unless the user explicitly asks to rewrite release history.

## Useful one-liners

```bash
# end-to-end smoke (real agent-browser)
bun examples/demo-app/server.ts &
./bin/cairn run examples/flows/01-dashboard-nav.yml

# fake-TTY mode for streaming progress in a non-tty shell
CAIRN_FORCE_TTY=1 ./bin/cairn run examples/flows/<spec>.yml --no-color

# stamp a spec's contractHash after authoring
./bin/cairn spec verify examples/flows/<spec>.yml --stamp

# heal a drifted spec end-to-end
./bin/cairn spec heal examples/flows/06-drifted-link.yml --apply
```
