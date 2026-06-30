# Annotate

`cairn annotate` pins a note and/or opaque data to a code symbol via [codemap](https://github.com/abdul-hamid-achik/codemap). It is the bridge from a cairntrace finding ("this run failed like this") to a durable, searchable annotation on the code graph ("this symbol has a known failure mode"). Codemap is optional — the command reports a clear error and exits non-zero when it is not on `$PATH`.

## `cairn annotate <symbol>`

```bash
cairn annotate HandleSubmit --note "fails on empty form"
cairn annotate HandleSubmit --note "..." --data '{"runId":"abc","status":"failed"}'
cairn annotate --from loginUser --to redirectHandler --note "entry→failure path"
```

Wraps `codemap annotate <symbol> --source <label> --note <text> --data <json> --json`.

| Flag | Effect |
|---|---|
| `--note <text>` | free-form note attached to the symbol |
| `--data <json>` | opaque data payload (e.g. JSON from a cairntrace run) |
| `--source <label>` | annotation source label (default `cairntrace`) |
| `--from <symbol>` | annotate a call path `from→to` instead of a single symbol |
| `--to <symbol>` | call path end symbol (use with `--from`) |

Passing neither `--note` nor `--data` is a usage error (exit `2`). The result carries `annotationId` and `matched` — `matched: false` means the symbol is not yet indexed; the annotation is saved but will not surface until codemap indexes it.

## Auto-annotate

Two modes that annotate without a manual `annotate` call:

### `on-run` — every run, pass or fail

```bash
cairn run flows/login.yml --auto-annotate on-run
```

Emits one codemap annotation per run, pinning the spec name as the symbol with run context: `{ specName, contractHash, runId, status, outcomes, failedVerifier }`. The `contractHash` lets codemap consumers invalidate stale green badges when the spec's contract changes. Best-effort: silently skipped if codemap is not installed.

### `on-investigate` — after `cairn investigate`

Reads `investigate.json` from a run directory and annotates each code match into codemap with the run's failure context.

### Config

```yaml
# cairntrace.config.yml
annotate:
  enabled: true
  autoAnnotate: on-run    # on-run (pass+fail) | on-investigate | never
  source: cairntrace      # default source label
```

`--auto-annotate <mode>` on `cairn run` overrides config `annotate.autoAnnotate`; accepts `on-run` or `never`.

## The full workflow

```text
cairn run flows/login.yml --auto-annotate on-run
  → run completes (pass or fail)
  → codemap symbol `login_flow` carries an annotation with run status + contractHash
  → `codemap annotations login_flow` shows the latest cairntrace verdict

# Failure investigation
cairn run flows/login.yml                  → fails
cairn investigate latest --codebase ./src  → code matches
cairn annotate src/auth/login.ts:42 --note "login_flow fails: redirects to /error"
```

## What cairntrace gets from codemap

- `codemap annotate` — pin cairntrace evidence to a symbol (this command).
- `codemap symbol_at` — resolve a `file:line` (from a stack trace) to the enclosing symbol, the entry point for joining evidence onto the code graph. Used by `investigate` re-ranking.
- `codemap_callers` / `codemap_impact` — structural expansion from a symbol; `impact` powers `cairn run --since-codemap <ref>` (run only specs whose `coversSymbol` intersects the blast radius).
- `codemap_semantic` — semantic search used by `investigate` re-ranking and `stash search` symbol expansion.

All codemap calls are best-effort and never fail a run when codemap is absent.

## See also

- [Investigate & audit](/investigate) — produces the code matches `on-investigate` annotates
- [Stash](/stash) — `stash search` uses codemap symbol expansion
- [Doctor & clean](/doctor) — the `codemap` availability check