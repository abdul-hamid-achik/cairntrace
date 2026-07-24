# Stash

`cairn stash` persists run artifact packs in the local [file.cheap](https://file.cheap) vault so they survive Cairntrace retention cleanup and remain searchable across runs on this machine. A stash is not uploaded or replicated automatically; another machine can resolve it only after you deliberately transfer the artifact or its vault data. file.cheap is optional to normal Cairntrace runs; stash commands return a clear error when it is unavailable (`cairn doctor` flags it).

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

Structured output includes the resolved `runId` and the file.cheap identifier as `stashId`. Cairntrace consumes file.cheap's canonical `id` field while accepting legacy `stashId` and `path` responses for compatibility.

Stashing preserves the artifact bytes. Cairntrace-authored text/JSON and
supported vidtrace text formats have passed through the redactor, but
screenshots, videos, downloads, transforms, traces, and extracted frames may
still contain secrets or personal data. Review the pack before stashing it or
transferring the local vault.

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

Detailed metadata for one stash: tags, size, source path, creation time, and
the file inventory. Cairntrace validates file.cheap's v0.30 manifest before
emitting structured output.

### `restore <stash-id>`

Restores a stash to a directory. `--to <dir>` targets a specific path; default
is a fresh temp dir. Cairntrace preserves file.cheap's restore receipt even
when hash verification fails; an unverified restore exits with code `2` and
must be treated as forensic evidence, not a trusted artifact pack. A verified
pack is the same self-contained directory `cairn run` wrote —
`report.html` opens in any browser.

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
version: 1
environments:
  local: {}
stash:
  enabled: true
  autoStash: on-failure   # on-failure | never (default)
  tags: [regression, audit]
```

Auto-stash is best-effort: a missing fcheap never crashes the run — the failure
is logged to stderr and the run proceeds. Stashes carry the spec name and any
configured tags.

After a successful or partially successful automatic save, Cairntrace adds a
redacted `stash-receipt.json` to the local run directory, appends an
`artifact.stash` record to `events.ndjson`, and refreshes
`artifact-manifest.json`. The receipt contains only the safe stash ID, save
status, post-save failure count, and timestamp. It deliberately excludes local
paths, tags, stderr, and failure messages, and it does not change `run.json`,
the reports, or the finalized run verdict.

The file.cheap snapshot is created before this local receipt can exist, so
Cairntrace does not recursively write the receipt back into that already-saved
stash. If save fails or file.cheap returns a path instead of a safe,
single-component stash ID, no receipt is written. Cairntrace also fails closed
when the active redactor would change the stash ID: it keeps the successful
file.cheap save, logs a non-fatal warning, and writes neither an unusable
receipt nor a misleading event.

## MCP mirror

The MCP server exposes `cairn_stash_save`, `cairn_stash_list`,
`cairn_stash_info`, `cairn_stash_restore`, and `cairn_stash_search`. Info and
restore use declared output schemas and the same strict file.cheap v0.30
response validation as the CLI. Restore requires hash verification; a
mismatch returns `isError: true` while preserving the normalized receipt under
`structuredContent.restore`. Operational errors carry a stable `code`,
`command`, `message`, and actionable `hint`.

## When to stash

- **A run failed and you want to investigate later** — `cairn investigate latest` stashes automatically; for manual triage, `cairn stash save latest`.
- **Sharing a failure with a teammate** — explicitly export or transfer the artifact first; after it exists in their local vault, they can restore it with `cairn stash restore <id> --to ...`. `report.html` is self-contained.
- **Cross-run regression search** — `cairn stash search "<error text>"` across every stashed run instead of grepping `events.ndjson` file by file.

## See also

- [Artifacts](/artifacts) — what a run directory contains (the unit stashed)
- [Investigate & audit](/investigate) — stash + vecgrep code-candidate surfacing
- [Doctor & clean](/doctor) — the `fcheap` availability check
