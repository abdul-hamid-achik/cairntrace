# Investigate & audit

When a spec fails, the artifact pack tells you *what* broke in the browser. `cairn investigate` and `cairn audit` close the loop to *which code is responsible*, by stashing the run to fcheap and running [vecgrep](https://github.com/abdul-hamid-achik/vecgrep) semantic code search against your codebase. Both degrade gracefully when fcheap or vecgrep is not installed (`cairn doctor` flags them).

## `cairn investigate <run-id>`

Stash a failed run, then find code candidates responsible for the failure.

```bash
cairn investigate latest --codebase ~/projects/myapp
cairn investigate latest --codebase ~/projects/myapp --mode semantic --limit 5
cairn investigate latest --codebase ~/projects/myapp --query "login redirect error"
```

`<run-id>` accepts a run id, `latest`, or `previous`.

### Flow

1. Resolve the run directory (`--artifact-root` / `--config` honored).
2. Stash it to fcheap (`fcheap save --tool cairntrace --tag investigate-<runId>`).
3. If `--connect --codebase`, run `fcheap connect <stash-id> <codebase>` via vecgrep to get `file:line:score` code matches.
4. **Codemap re-rank** (best-effort): when codemap is on `$PATH`, the raw search matches are re-ranked by graph centrality + caller depth + blast radius, using failing-outcome text and failing network URLs gathered from the run dir. Falls back to the fcheap ranking unchanged when codemap is absent.
5. **Call-trace reconstruction**: from the ranked matches, reconstruct an entry→failure call path and emit one codemap path annotation per edge (best-effort, skipped when codemap is absent or no trace resolves).
6. Write `investigate.json` into the run directory so `agent_context.md` can surface the code matches on the next render.

### Flags

| Flag | Effect |
|---|---|
| `--codebase <dir>` | codebase directory to search with `fcheap connect` (vecgrep) |
| `--connect` | run `fcheap connect` to find code matches after stashing |
| `--query <query>` | override the auto-extracted search query |
| `--mode <mode>` | `semantic` \| `keyword` \| `hybrid` (default `hybrid`) |
| `--limit <n>` | max code matches (default `10`) |
| `--artifact-root <path>`, `--config <path>` | resolution overrides |

`--connect` requires `--codebase` (or `investigate.codebaseDir` in config). The result is a structured `InvestigateResult` with `codeMatches: [{ file, line, score, symbol? }]`, `failureTrace`, and `pathAnnotations`.

## `cairn audit <spec>`

The convenience wrapper: run a spec with video recording, extract vidtrace evidence, then investigate.

```bash
cairn audit flows/login.yml --codebase ~/projects/myapp --connect --cold-start
```

### Flow

1. Run the spec with the `playwright` backend and video recording enabled.
2. If the run has a video and [vidtrace](https://github.com/abdul-hamid-achik/vidtrace) is on `$PATH`, extract a vidtrace evidence bundle from it.
3. Auto-stash the run to fcheap if it failed (`--stash-on-failure` semantics).
4. If `--connect --codebase`, stash (when not already) and run `fcheap connect` for code matches.

### Flags

`--codebase`, `--connect`, `--mode`, `--limit` (same as investigate), plus run-time flags: `--env`, `--cold-start`, `--artifact-root`, `--config`.

`audit` always uses the Playwright backend because video capture needs native recording. Use `investigate` directly when you already have a run directory and do not want to re-run.

## Config

```yaml
# cairntrace.config.yml
investigate:
  codebaseDir: ./src        # default codebase for `cairn investigate --connect`
  mode: hybrid              # semantic | keyword | hybrid
  limit: 10                 # max code matches
  autoInvestigate: on-failure  # auto-investigate failed runs (on-failure | never)
```

## MCP mirror

`cairn_investigate` and `cairn_audit` mirror the CLI and return the same JSON. Both degrade gracefully when fcheap / vecgrep / vidtrace are not installed — the missing tool is recorded in the result, never thrown.

## The failure loop

```text
cairn run flows/login.yml --cold-start      # fails
cairn investigate latest --codebase ./src   # code matches + call trace
cairn context latest                        # the agent-readable post-mortem
outcomes/<id>.md                            # the failing outcome + evidence
```

Read `agent_context.md` (via `cairn context latest`) first; it now also surfaces the `investigate.json` code matches. Do not grep `events.ndjson` until you have read these.

## See also

- [Stash](/stash) — the fcheap integration investigate builds on
- [Annotate](/annotate) — pinning investigate findings to codemap symbols
- [Artifacts](/artifacts) — `agent_context.md` and the failure narrative
- [Doctor & clean](/doctor) — `fcheap` / `vecgrep` / `vidtrace` availability checks