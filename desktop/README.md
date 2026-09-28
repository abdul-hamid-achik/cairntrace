# Cairntrace Studio

The desktop console for [Cairntrace](../README.md): author, run, watch, and
forensically inspect behavioral browser specs without leaving one window.

Studio is a **thin console over the `cairn` CLI**. It owns no runner logic of
its own: every action spawns the same `cairn` binary an agent would use
(`--format json` on stdout, `--log-format json` on stderr), and every screen
renders artifacts the runner already wrote (`run.json`, `events.ndjson`,
`outcomes/*.md`, `screenshots/`, `report.html`). If the CLI's behaviour
changes, Studio follows automatically.

## What it does

| View          | Purpose                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Runs**      | The artifact-root history: every run, newest first, filterable by status/spec/text, one click into full evidence.   |
| **Run detail**| One run's whole directory: failure summary, per-step timeline with resolved locators and artifacts, outcome evidence rendered as Markdown, screenshots, console/network captures, `agent_context.md`, `report.html`, and `cairn diff` against any other run. |
| **Specs**     | List/read/edit specs; save runs `cairn spec verify` and shows its findings (including contract-hash refusals, exit 6); stamp hashes behind a confirm; run, run headed, cold-start run, and `cairn spec heal` (dry run or `--apply`); scaffold new specs. |
| **Live**      | Runs started from the app, streaming step progress from the run's own `events.ndjson` plus cairn's NDJSON logs, with cancel and re-run. |
| **Cohorts**   | `cairn stats --group-by`: pass rate, duration p50/p95, harvested domain metric, and baseline deltas for A/B labels. |
| **Docs**      | The authoring reference read live from the binary: `cairn docs <topic>` plus the full `cairn explain` surface (commands, step kinds, verifiers, rules). |
| **Environment**| `cairn doctor` checks, the config cairn discovered for the open project, services and checkpoint state, and retention/clean controls. |
| **Settings**  | cairn binary override, artifact-root override, default run options (backend, env, headed, cold-start, monitor, parallel, labels, vars), recent projects. |

## Run it

```bash
bun run desktop:install   # once: installs electron + electron-builder under desktop/
bun run desktop:start     # launch the app
bun run desktop:smoke     # headless boot harness: boots a hidden window, waits for
                          # the renderer to report ready, prints one JSON line, exits
```

`desktop:smoke` is the gate before shipping: it proves the window, the
context-isolated preload bridge, the IPC surface, and every view script parse
and mount (it fails if any view is missing, which is how a script with a syntax
error gets caught).

## Gates

```bash
bun run desktop:test       # node:test over desktop/lib + the argv/spawn contracts
bun run desktop:typecheck  # tsc --checkJs over the main-process surface
bun run lint               # repo-wide oxlint, includes desktop/
bun run format:check       # repo-wide oxfmt, includes desktop/
```

CI runs `desktop:test` + `desktop:typecheck` (see `.github/workflows/ci.yml`);
the smoke harness needs a display and the Electron binary, so it stays a local
gate.

## Architecture

```
desktop/
  main.js        window lifecycle, menu, single-instance lock, --smoke harness
  preload.js     contextBridge allowlist (invoke channels + push channels)
  ipc.js         every ipcMain.handle; the whole trust boundary
  windows.js     secondary report.html windows
  lib/           pure, testable core — no Electron imports
    cli.js       binary discovery, argv builders, NDJSON decoding, spawn+kill
    runs.js      artifact-root indexing, run detail, bounded artifact reads
    specs.js     config discovery, spec discovery, YAML summaries
    live.js      run-directory discovery + events.ndjson tailing
    settings.js  the settings store (userData/settings.json)
    format.js    shared formatters (also loaded by the renderer as a script)
  renderer/      classic <script> files, no bundler, no innerHTML anywhere
  test/          node:test suites over lib/ (temp-fixture artifact roots)
```

Design rules that keep it honest:

- **Sandboxed renderer.** `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. The preload exposes channel allowlists only; a
  compromised renderer can call the commands the app already offers, nothing
  else. External opens are restricted to `http(s)`.
- **Paths are validated at the boundary.** A renderer-supplied artifact path
  must resolve inside the run directory (`lib/runs.js safeJoin`); spec writes
  must stay inside the open project.
- **Spawned children die with their tree.** `lib/cli.js execCairn` runs each
  cairn in its own process group and escalates SIGTERM → SIGKILL on deadline or
  cancel, because cairn spawns browsers/docker/tmux whose inherited pipes would
  otherwise keep a "cancelled" run alive.
- **macOS GUI PATH.** Finder-launched apps get a near-empty PATH, so
  `augmentedEnv()` adds `/opt/homebrew/bin`, `/usr/local/bin`, `~/.bun/bin`,
  `~/.local/bin`, `~/.volta/bin`, and friends before resolving `cairn`.
- **No bundled copy of the truth.** Docs, vocabulary, verify results, stats,
  and diffs all come from the CLI at call time (cached briefly in the main
  process), so the app can never disagree with the installed cairn.

## Packaging

```bash
bun run desktop:dist      # unpacked mac app under desktop/dist/
bun run desktop:dist:dmg  # zip target (unsigned; identity: null)
```

The packaged app resolves `cairn` from PATH or the Settings override; in a
source checkout it also falls back to `<repo>/bin/cairn`.

## Brand assets

`build/icon.svg` is the app-icon rendition of the product mark — the same
cairn geometry as `docs/public/favicon.svg`, scaled ×16 onto the deep-green
tile. `build/icon.icns` / `build/icon.png` are generated from it (Electron
`capturePage` at 1024px → `sips` resize into an iconset → `iconutil -c icns`);
electron-builder picks them up from `buildResources`. The renderer topbar
inlines the mark as SVG and keeps the wordmark as text so it stays crisp at
any zoom. The UI accent is the brand emerald (`#34D399`), so selection, focus,
and primary actions read as the same product as the docs site.
