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

The public site auto-builds from **`main` only** (`vercel.json`). Do not
`vercel promote` docs; npm/Homebrew ship from tags. See **Docs site (Vercel)**
in AGENTS.md.
- Run directories include `report.html` and `report.json`. Keep reporting
  changes self-contained, redacted, print-friendly, and compatible with
  `report.theme` / `report.colors` in `cairntrace.config.yml`; do not add a
  separate report theme config file.
- Request steps are no longer documented as page-only fetches. Playwright uses
  an out-of-page, context-cookie-sharing transport with a 30000ms default
  timeout. Under Bun, the cookie bridge runs in a subprocess so the parent can
  kill it at `timeoutMs`; agent-browser currently relies on the bounded
  evaluate fallback.
- Playwright Chromium gets `--no-sandbox` and `--disable-dev-shm-usage`
  automatically when `CI` is truthy. Use `CAIRN_PLAYWRIGHT_LAUNCH_ARGS` only
  when a runner needs different flags.
- Playwright `wait` and browser `evaluate` paths are hard-bounded. Real
  Chromium runs use an external watchdog process that kills the browser at the
  deadline, defaulting to 30000ms unless a specific timeout is supplied.
- Discovery sessions (12 MCP tools: `cairn_discover_open` (optional `setup`
  / `resume` / `backend`) → `_snapshot` / `_inventory` → `_interact` /
  `_navigate` → `_network` / `_suggest` / `_remove_step` → `_export` →
  `_close`, plus `_resume` and `_list`) let an agent explore a live page and
  record steps as a spec. Every action runs through the `cairn run` engine on
  the session's browser. The CLI one-shot is `cairn discover [url]`. Each
  session keeps a journal under `<artifactRoot>/_sessions/<id>/`; the browser
  closes after 30 min idle (`ttlMs`, config `discovery.sessionTtlMs`) and the
  journal stays for export and `_resume`. Exported specs include cold-start
  contract comments but the agent must satisfy the cold-start contract
  separately. New specs follow `cairn docs author-flow` (catalog → discover →
  convention export → `cairn spec finish` → `cairn spec promote`). See
  `cairn docs discovery` or the "Discovery sessions" section in AGENTS.md.
- Backend checks, async effects, test data and cleanup have typed
  primitives — reach for them before a `script` verifier or a precondition:
  `mongo` / `temporal` / `http` verifiers over config `datasources:`, `value`
  and `table`, `poll: { timeoutMs, everyMs, stableMs }` on any verifier,
  `expect` / `capture` steps, `run:` steps and spec `teardown:`, config
  `fixtures:` (`cairn fixtures …`) and `gates:` (`preconditions.wait`,
  `cairn wait`). Node verifiers that remain use the SDK
  (`@thelacanians/cairntrace/verifier`). See AGENTS.md "Rules for agents
  authoring specs".
- The repo is public at `github.com/abdul-hamid-achik/cairntrace` with tagged
  GitHub releases. Don't push or cut a release proactively — the user drives
  that timing. When asked, follow the "Releasing" checklist in AGENTS.md:
  choose the SemVer increment, bump `package.json` + `desktop/package.json`,
  create an annotated `vX.Y.Z` tag, push, then run `gh release create`. Tag
  push publishes npm and updates `abdul-hamid-achik/tap/cairntrace`. Use
  patch releases for fixes/docs/polish, and never create a floating `latest`
  tag or rewrite old releases unless the user explicitly asks to rewrite
  release history.

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

# one-shot page discovery (full a11y tree + locator inventory)
./bin/cairn discover /login --env local --format json

# discovery docs (MCP workflow, step recording, export)
./bin/cairn docs discovery
```
