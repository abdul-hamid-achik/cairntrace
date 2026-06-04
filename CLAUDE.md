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
- The repo is public at `github.com/abdul-hamid-achik/cairntrace` with tagged
  GitHub releases. Don't push or cut a release proactively — the user drives
  that timing; do it when asked, following the "Releasing" checklist in
  AGENTS.md (annotated `vX.Y.Z` tag → push → `gh release create`; never a
  floating `latest` tag).

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
