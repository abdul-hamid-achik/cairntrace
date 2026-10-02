# Stash, pin and publish

`cairn stash` persists run artifact packs in the local [file.cheap](https://file.cheap) vault so they survive Cairntrace retention cleanup and remain searchable across runs on this machine. A stash is not uploaded or replicated automatically; `cairn publish` is the explicit way to send one run to the private file.cheap artifact service. file.cheap is optional to normal Cairntrace runs; stash commands return a clear error when it is unavailable (`cairn doctor` flags it).

## Subcommands

```bash
cairn stash save latest --tag regression              # stash the latest run dir
cairn stash list --tool cairntrace                    # list stashes, filter by tool/tag
cairn stash info <stash-id>                           # detailed info about one stash
cairn stash restore <stash-id> --to /tmp/run-restore  # restore a stash to a directory
cairn stash search "redirected to /error"             # search across all stashes
cairn pin latest --reason "evidence for the checkout bug"   # never prune this run
cairn publish latest --retention-days 7               # remote copy + console listing
```

## What leaves the machine: the evidence gate

Every stash, retention archive and publication goes through the same gate,
and so does any other stash of a run directory (`cairn investigate`,
`cairn audit --connect`, `cairn clip --stash`, auto-investigate). Those
explicit stashes carry the project's `stash.include`,
`stash.unsafeIncludeRawTraces` and `stash.meta`, write a receipt with
`action: "manual"`, and keep no TTL, like `cairn stash save` without
`--ttl` (`ttl` / `passTtl` / `failTtl` are auto-stash and archive
settings). `cairn clip --stash` stashes the clips themselves through
vidtrace; the run stash beside it follows the gate, so add `videos` to
`stash.include` to carry the full recording too. Auto-investigate reuses
the run's auto-stash, or makes one gated auto-stash when none ran. A run
directory is split into categories:

| Category | Contents |
|---|---|
| `text` | run records, events, logs, snapshots, network/console, outcome evidence, and any other file |
| `screenshots` | step screenshots and other images |
| `traces` | `traces/` (Playwright Trace Viewer zip or agent-browser Chrome trace JSON) |
| `videos` | `videos/` (recordings, clips, vidtrace output) |
| `downloads` | `downloads/` and `transforms/` |

The default is `[text, screenshots]`: traces, videos and downloads stay local
unless you opt in (`stash.include`, `retention.publish.include`, or
`--include` on `cairn stash save` / `cairn publish`). `text` is always
included. When something is left out, Cairntrace saves a private staged copy
named after the run, and the receipt lists what was excluded (`traces/`).

`artifact-manifest.json` marks every file with a `sensitivity`:

- `redacted` — written by Cairntrace through the run redactor;
- `safe` — browser-produced media and files with no credential structure
  (screenshots, videos, downloads). They can still show personal data;
- `sanitized` — a backend trace the trace sanitizer rewrote. The sanitizer is
  best effort, so a sanitized trace is stashed when `traces` is included but
  is never published;
- `secret-bearing` — raw bytes that may carry credentials: a trace that could
  not be sanitized (or one from a run older than the sanitizer), a raw
  `monitor` profile (a heap snapshot holds every string in the process), and
  any text file Cairntrace did not write itself, such as `--after` collector
  output in `diagnostics/`.

Publish never sends a `secret-bearing` or `sanitized` file. A stash carries a
`secret-bearing` file only with `stash.unsafeIncludeRawTraces: true` (the
name predates the other members; it covers every secret-bearing file).

Kept traces are sanitized when the run ends. It keeps the JSON shape, so the
Trace Viewer and Perfetto still open the file, and it replaces with
`[redacted]`:

- values of credential headers and cookies (`Authorization`, `Cookie`,
  `Set-Cookie`, `Proxy-Authorization`, names with `token`, `secret`,
  `session`, `auth`, `api-key`, … and the spec's `redaction.headers`);
- `storageState`, `localStorage` and `sessionStorage` contents;
- values typed into password fields (a `type=password` input, or a `fill`
  whose selector names a password, secret, OTP or PIN field), wherever they
  appear: call parameters, log lines and DOM snapshots;
- `name=value` parameters with a sensitive name in URLs, fragments and form
  bodies (`password`, `client_secret`, `id_token`, `code`, `SAMLResponse`, …);
- registered secret values.

It cannot recognize a credential under an unremarkable name in free text, which
is why its output is `sanitized`, not `redacted`. A trace the sanitizer cannot
rewrite stays local as `secret-bearing`.

## `stash save <run-id>`

Stash a run directory to the fcheap vault. `<run-id>` accepts a run id, `latest`, or `previous`.

Structured output includes the resolved `runId`, the file.cheap `stashId`,
`excluded`, `secretsFound` (when file.cheap's save-time secret scan flagged
anything) and the `receipt` path. Cairntrace consumes file.cheap's canonical
`id` field while accepting legacy `stashId` and `path` responses for
compatibility.

| Flag | Effect |
|---|---|
| `--tag <tag>` | tag for this stash (repeatable) |
| `--labels-as-tags` | also add every run.json label (`cairn run --label key=value`) as a `key=value` tag |
| `--ttl <duration>` | file.cheap time-to-live, e.g. `30d` (default: never expires) |
| `--include <category>` | evidence category (repeatable); default config `stash.include`, else `text` + `screenshots` |
| `--tool <name>` | tool name (default `cairntrace`) |
| `--source <path>` | source artifact path |
| `--artifact-root <path>` | override artifact root |
| `--config <path>` | explicit config |

When the installed fcheap supports it (0.36+), the run identity is stored as
manifest metadata: `--meta run_id= status= spec= env= backend= cairn_version=`.
Older versions get a plain save. Set `stash.meta: false` to turn this off.

### `list`

`--tag <tag>` (repeatable; a stash must carry every tag) and `--tool <name>` filter. Without filters, lists every stash in the vault.

A benchmark that labels its runs can keep them as a queryable cohort:

```bash
cairn run flows/checkout.yml --label round=r7 --label sha=abc1234567 --label target=staging
cairn stash save latest --labels-as-tags --tag project=shop --ttl 30d
cairn stash list --tag round=r7 --tag target=staging --json
```

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

```bash
cairn run flows/login.yml --stash-on-failure   # failed/errored runs
cairn run flows/login.yml --stash              # every run, whatever its status
```

```yaml
# cairntrace.config.yml
version: 1
environments:
  local: {}
stash:
  enabled: true
  autoStash: on-failure     # always | on-failure | never (default)
  tags: [regression]        # a spec's `stash: { tags: [...] }` adds to these
  include: [text, screenshots]
  failTtl: 30d              # failed/errored runs (default: ttl, else never expires)
  passTtl: 7d               # passed runs (default 7d)
  # ttl: 14d                # both, unless passTtl/failTtl is set
  labelsAsTags: false       # default; see below
  meta: true                # default; needs fcheap 0.36+
```

A spec adds its own tags with a top-level `stash: { tags: [payments] }` key.

`labelsAsTags` defaults to `false`: labels are free-form cohort values meant
for `cairn stats --group-by`, and turning them into vault tags for every run
would change existing tag sets; `meta` already records the run identity as
structured manifest fields. A run refused by the environment policy is never
stashed.

Auto-stash is best-effort: a missing fcheap never crashes the run. Every
attempt is recorded in the run:

- success: `stash-receipt.json` (`stashId`, `status`, `contentHash`,
  `fileCount`, `sizeBytes`, `ttl`, `expiresAt`, `tags`, `excluded`,
  `secretsFound`, `action`), an `artifact.stash` event, and a refreshed
  `artifact-manifest.json`;
- failure: an `artifact.stash` event with `status: "error"` and a reason code
  (`fcheap-missing`, `save-failed`, `auth`, `too-large`, `timeout`,
  `secrets-blocked`, `unknown`) plus a one-line message without paths.

`cairn stash save` writes the same receipt with `action: "manual"`. The
receipt never contains local paths, stderr or secret values, and it does not
change `run.json`, the reports or the run verdict. The file.cheap snapshot is
created before the receipt exists, so the receipt is not part of the stash
itself. If file.cheap returns a path instead of a safe stash ID, or the active
redactor would change the ID, no receipt is written.

When file.cheap's save-time scan flags potential secrets, the count lands in
`secretsFound` and the CLI prints a warning naming the matched rules (never
the values).

## Retention archive

`retention.archiveToStash: true` archives a run before the retention prune
deletes it, through the same gate (`stash.include`) and with `stash.ttl`. The
outcome is recorded on the run whose retention pass did the pruning:
`artifact.stash` with `action: "archive"` and the pruned run's `runId`, or an
`artifact.retention` warning when archiving failed and the run was kept on
disk. `cairn run` and `cairn clean` print one warning line per failed archive.

The archive is no longer a copy of the whole run: what the gate leaves out
(by default traces, videos and downloads) is deleted with the pruned run. The
`excluded` field of the archive event lists it, and the CLI says so once per
process. Add the categories to `stash.include` to archive them. Retention
re-checks pins right before it archives or deletes a run, so a run pinned
while an earlier archive was running is kept.

## Pin

```bash
cairn pin latest --reason "evidence for the checkout bug" --json
cairn pin latest --stash      # also stash it with the keep tag and no TTL
cairn unpin <run-id> --json
```

Pinning writes `pinned: {at, reason?}` to `run.json`. Retention never prunes a
pinned run, and pinned runs take no `keepRuns` / `keepFailedRuns` slot.
`cairn clean --include-pinned` overrides; `cairn clean --all` alone keeps
pinned runs.

## Publish

```bash
cairn publish latest --json
cairn publish <run-id> --retention-days 3 --include screenshots --include traces
```

`cairn publish` sends one run to the private file.cheap artifact service with
`fcheap publish`. It needs `FILECHEAP_ARTIFACT_SERVICE_URL` and
`FILECHEAP_INGEST_TOKEN`; the token reaches only the fcheap process. The run
is packaged as a bounded `.tar.gz` through the evidence gate (default
`retention.publish.include`, else `text` + `screenshots`; secret-bearing and
sanitized members, so every trace, are never published). When the installed fcheap supports
`--run-index`, Cairntrace also sends a metadata-only RunIndexV1 sidecar
(status, timestamps, counts, outcome ids, and an inventory summarized by
evidence role, at most 12 KiB) so the private console can list the run. The
sidecar never carries logs, intent, failure messages or URLs.

When run metadata alone would exceed 12 KiB, passed outcomes are dropped from
the sidecar first (`counts.outcomes` keeps the full number). When no sidecar
is sent, the outcome and receipt say why in `runIndexSkipped`
(`unsupported`, `too-large`, `build-failed`).

On success the run gains `publish-receipt.json`
(`{version, artifactRef, sha256, sizeBytes, publishedAt, expiresAt, webUrl?,
excluded?, runIndexSkipped?}`) and an `artifact.publish` event. A failure exits `2` and records an
`artifact.publish` event with a reason code; fcheap's stderr is never
surfaced. The local run is never deleted by `cairn publish`.
`retention.publish.enabled` publishes pruned runs automatically with the same
gate.

## Doctor

`cairn doctor` reports the fcheap version (and whether `save --meta` and
`publish --run-index` are available), whether the console session is signed in
(only `fcheap pull` from the console needs it), and whether the publisher
variables are set — never their values.

## `services.stash` (deprecated)

`services.stash` stashes tmux, docker and seed output as a separate stash. Use
`services.artifacts` instead: bounded, redacted service logs inside each run
directory, which `stash.autoStash` then carries. `cairn config validate` warns
about it, and so does the services stop. Until it is removed it honors
`autoStash`; `enabled: true` without `autoStash` keeps the old behavior
(stash after every invocation). It runs every capture through the run
redactor, captures reused tmux sessions and the seed output, and passes `ttl`
(default `7d`).

## MCP mirror

The MCP server exposes `cairn_stash_save` (same gate, `include` and `config`
inputs, receipt), `cairn_stash_list`, `cairn_stash_info`,
`cairn_stash_restore`, `cairn_stash_search`, `cairn_pin` (`unpin: true` to
remove a pin, `stash: true` for the keep stash) and `cairn_publish`. MCP
`cairn_run` accepts `stash: true` like `cairn run --stash`. Info and restore
use declared output schemas and the same strict file.cheap v0.30 response
validation as the CLI. Restore requires hash verification; a mismatch returns
`isError: true` while preserving the normalized receipt under
`structuredContent.restore`. Operational errors carry a stable `code`,
`command`, `message`, and actionable `hint`.

## When to stash

- **A run failed and you want to investigate later** — `cairn investigate latest` stashes automatically; for manual triage, `cairn stash save latest`.
- **Keep it past retention** — `cairn pin latest --reason "<why>"`.
- **Sharing a failure with a teammate** — `cairn publish latest`, or transfer the artifact and restore it from their local vault with `cairn stash restore <id> --to ...`. `report.html` is self-contained.
- **Cross-run regression search** — `cairn stash search "<error text>"` across every stashed run instead of grepping `events.ndjson` file by file.

## See also

- [Artifacts](/artifacts) — what a run directory contains (the unit stashed)
- [Video capture](/video) — video and trace formats, `traceMaxBytes`
- [Investigate & audit](/investigate) — stash + vecgrep code-candidate surfacing
- [Doctor & clean](/doctor) — the `fcheap` checks and `cairn clean --include-pinned`
