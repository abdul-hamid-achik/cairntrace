# Investigate & audit

When a spec fails, the artifact pack tells you *what* broke in the browser.
`cairn investigate` can connect that evidence to the code responsible by
stashing the run in file.cheap and searching the target codebase with
[vecgrep](https://github.com/abdul-hamid-achik/vecgrep). `cairn audit` first
runs a video-backed browser audit and only uses file.cheap/vecgrep when you
request a connection or configure auto-stash. `cairn doctor` reports which
optional integrations are available.

## `cairn investigate <run-id>`

Stash a failed run, then find code candidates responsible for the failure.

```bash
cairn investigate latest --codebase ~/projects/myapp
cairn investigate latest --codebase ~/projects/myapp --mode semantic --limit 5
cairn investigate latest --codebase ~/projects/myapp --query "login redirect error"
cairn investigate latest --codebase ~/projects/myapp --index
cairn investigate latest                              # stash only
```

`<run-id>` accepts a run id, `latest`, or `previous`.
Passing `--codebase` implies `--connect`. Use `--connect` without
`--codebase` to select `investigate.codebaseDir` from config.

### Flow

1. Resolve the run directory (`--artifact-root` / `--config` honored).
2. Stash it to fcheap (`fcheap save --tool cairntrace --tag investigate-<runId>`).
3. If `--codebase` or `--connect` is set, run `fcheap connect <stash-id> <codebase>` via vecgrep to get `file:line:score` code matches.
4. **Codemap re-rank** (best-effort): when codemap is on `$PATH`, the raw search matches are re-ranked by graph centrality + caller depth + blast radius, using failing-outcome text and failing network URLs gathered from the run dir. Falls back to the fcheap ranking unchanged when codemap is absent.
5. **Call-trace reconstruction**: from the ranked matches, reconstruct an entry→failure call path and emit one codemap path annotation per edge (best-effort, skipped when codemap is absent or no trace resolves).
6. Write `investigate.json` into the run directory so `agent_context.md` can surface the code matches on the next render.

### Flags

| Flag | Effect |
|---|---|
| `--codebase <dir>` | codebase directory to search with `fcheap connect` (vecgrep) |
| `--connect` | connect after stashing; uses `investigate.codebaseDir` when `--codebase` is omitted |
| `--query <query>` | override the auto-extracted search query |
| `--clips` | stash `videos/clips/` instead of the full run when clips exist |
| `--mode <mode>` | `semantic` \| `keyword` \| `hybrid` (default: config or `hybrid`) |
| `--limit <n>` | max code matches (default: config or `10`) |
| `--index` | build or refresh the vecgrep index before connecting |
| `--artifact-root <path>`, `--config <path>` | resolution overrides |

An explicit `--codebase` path resolves from the current working directory. A
relative `investigate.codebaseDir` resolves from the directory containing
`cairntrace.config.yml`.

The result is a structured `InvestigateResult` with
`codeMatches: [{ file, line, score, snippet, symbol? }]`, `failureTrace`, and
`pathAnnotations`. Contract or subprocess failures return exit code `2`; a
JSON result still includes the `error` field. JSON/YAML output validates
against `urn:cairntrace.dev:investigate:v1`.

## `cairn audit <spec>`

The convenience wrapper: run a spec with video recording, extract vidtrace evidence, then investigate.

```bash
cairn audit flows/login.yml --codebase ~/projects/myapp
cairn audit flows/login.yml --codebase ~/projects/myapp --slow-mo 250 --speed 0.75
```

### Flow

1. Start the same configured web server, services lifecycle, and TinyVault
   injection used by `cairn run`, then run the spec cold with the `playwright`
   backend and command-level `video: always`.
2. If the run has a video and [vidtrace](https://github.com/abdul-hamid-achik/vidtrace)
   is on `$PATH`, extract an evidence bundle under `videos/vidtrace/`.
   Playwright WebM is video-only, so audit creates a disposable silent-audio
   copy when Whisper needs one and removes it afterward. After extraction,
   Cairntrace redacts vidtrace text artifacts (`.json`, `.txt`, `.srt`, `.tsv`,
   `.vtt`, `.md`, and `.csv`). Frames and other images remain uninspected
   binary evidence; review them before sharing or stashing.
3. When connecting, stash the run once. If vidtrace produced a bundle, stash that evidence separately and connect the evidence stash; otherwise connect the run stash.
4. Without connection, the run remains local unless
   `stash.enabled: true` and `stash.autoStash: on-failure` explicitly enable
   failed-run auto-stash.

### Flags

`--codebase`, `--connect`, `--index`, `--mode`, `--limit` (same as
investigate), plus `--speed <0.25-4>`, `--slow-mo <0-5000>`, `--env`,
`--no-cold-start`, `--artifact-root`, and `--config`.

`audit` always uses the Playwright backend because video capture needs native
recording. Cold start defaults to `true`. The audit itself does not require
file.cheap or vecgrep; those become required only for a requested
stash/connection stage. Use `investigate` directly when you already have a run
directory and do not want to re-run. JSON/YAML output validates against
`urn:cairntrace.dev:audit:v1`.

## Config

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
investigate:
  codebaseDir: ./src        # default codebase for `cairn investigate --connect`
  mode: hybrid              # semantic | keyword | hybrid
  limit: 10                 # max code matches
  index: false              # build/refresh vecgrep before connecting
  autoInvestigate: on-failure  # auto-investigate failed runs (on-failure | never)
```

## MCP mirror

`cairn_investigate` and `cairn_audit` call the same shared pipeline as the CLI
and return the same structured result without writing command output into MCP
stdio. Both tools declare their v1 result as MCP `outputSchema`; Cairntrace
also validates error-shaped results itself because MCP clients may skip output
validation when `isError` is set. An unavailable tool sets `isError` only when
the requested stage requires it; optional vidtrace failures appear in
`warnings`.

## The failure loop

```text
cairn run flows/login.yml --cold-start      # fails
cairn investigate latest --codebase ./src   # code matches + call trace
cairn context latest                        # the agent-readable post-mortem
outcomes/<id>.md                            # the failing outcome + evidence
```

Read `agent_context.md` (via `cairn context latest`) first. Its generated Code
Matches section surfaces only ranked `file:line` pointers and scores; it omits
raw source snippets. The redacted `investigate.json` keeps the detailed
structured matches. Do not grep `events.ndjson` until you have read these.

## See also

- [Stash](/stash) — the fcheap integration investigate builds on
- [Annotate](/annotate) — pinning investigate findings to codemap symbols
- [Artifacts](/artifacts) — `agent_context.md` and the failure narrative
- [Doctor & clean](/doctor) — `fcheap` / `vecgrep` / `vidtrace` availability checks
