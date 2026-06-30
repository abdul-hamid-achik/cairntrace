# Stash

`cairn stash` persists run artifact packs to [fcheap](https://github.com/abdul-hamid-achik/file.cheap) so they survive across machines, are searchable, and can be handed to a teammate. fcheap is optional — every stash command degrades gracefully when it is not on `$PATH` (`cairn doctor` flags it).

## Subcommands

```bash
cairn stash save latest --tag regression              # stash the latest run dir
cairn stash list --tool cairntrace                    # list stashes, filter by tool/tag
cairn stash info <stash-id>                           # detailed info about one stash
cairn stash restore <stash-id> --to /tmp/run-restore  # restore a stash to a directory
cairn stash search "redirected to /error"             # search across all stashes
```

### `save <run-id>`

Stash a run directory to the fcheap vault. `<run-id>` accepts a run id, `latest`, or `previous`.

| Flag | Effect |
|---|---|
| `--tag <tag>` | tag for this stash (repeatable) |
| `--tool <name>` | tool name (default `cairntrace`) |
| `--source <path>` | source artifact path |
| `--artifact-root <path>` | override artifact root |
| `--config <path>` | explicit config |

### `list`

`--tag <tag>` and `--tool <name>` filter. Without filters, lists every stash in the vault.

### `info <stash-id>`

Detailed metadata for one stash: tags, size, source path, creation time.

### `restore <stash-id>`

Restores a stash to a directory. `--to <dir>` targets a specific path; default is a fresh temp dir. The restored pack is the same self-contained directory `cairn run` wrote — `report.html` opens in any browser.

### `search <query>`

Searches across all stashed runs. When [codemap](https://github.com/abdul-hamid-achik/codemap) is on `$PATH`, a symbol query is expanded via the codemap graph before searching, so `cairn stash search HandleSubmit` finds stashes whose evidence references that symbol's call path.

| Flag | Effect |
|---|---|
| `--mode <mode>` | `keyword` \| `semantic` \| `hybrid` |
| `--limit <n>` | max results (default `20`) |

## Auto-stash

You do not have to stash by hand. Two ways to auto-stash failed runs:

```bash
# CLI flag
cairn run flows/login.yml --stash-on-failure --cold-start
```

```yaml
# cairntrace.config.yml
stash:
  enabled: true
  autoStash: on-failure   # on-failure | never (default)
  tags: [regression, audit]
```

Auto-stash is best-effort: a missing fcheap never crashes the run — the failure is logged to stderr and the run proceeds. Stashes carry the run id, spec name, and any configured tags.

## MCP mirror

The MCP server exposes `cairn_stash_save`, `cairn_stash_list`, and `cairn_stash_search` that return the same JSON as `--format json`. Both degrade gracefully when fcheap is not installed.

## When to stash

- **A run failed and you want to investigate later** — `cairn investigate latest` stashes automatically; for manual triage, `cairn stash save latest`.
- **Sharing a failure with a teammate** — stash, then `cairn stash restore <id> --to ...` on their machine; `report.html` is self-contained.
- **Cross-run regression search** — `cairn stash search "<error text>"` across every stashed run instead of grepping `events.ndjson` file by file.

## See also

- [Artifacts](/artifacts) — what a run directory contains (the unit stashed)
- [Investigate & audit](/investigate) — stash + vecgrep code-candidate surfacing
- [Doctor & clean](/doctor) — the `fcheap` availability check