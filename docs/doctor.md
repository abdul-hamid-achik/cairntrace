# Doctor & clean

Two maintenance commands: `cairn doctor` checks that every external tool cairntrace talks to is reachable; `cairn clean` prunes old run directories so the artifact root does not fill the disk.

## `cairn doctor`

`cairn doctor` probes the environment and reports which runtimes, browser
backends, and optional integrations are available. It is the first thing to
run when a command degrades — every `--format json|yaml|md` is supported and
the JSON shape is stable for harnesses. The `cairn_doctor` MCP tool runs the
same Playwright package and browser-executable preflight.

```bash
cairn doctor --format md
```

The report is a list of `{ name, ok, detail }` checks. `ok: true` means the
binary is on `$PATH`, the package/browser is ready, or the filesystem check
passed. The detail line carries the version, resolved browser path, or reason
the check failed.

| Check | What it gates |
|---|---|
| `node`, `bun` | the runtime |
| `agent-browser` | `cairn run` without `--mock`. Present but older than 0.34.0 is a fail (`wait --state` collision, implicit role names, idle timeout). Upgrade with `brew upgrade agent-browser`. |
| `playwright-package` | the `playwright` dependency loads from the current Bun install |
| `playwright-chromium` | the matching Chromium executable exists and is executable for `--backend playwright` |
| `fcheap` | `cairn stash` and `--stash-on-failure` |
| `vecgrep` | `cairn investigate --connect` and `cairn audit --connect` |
| `vidtrace` | `cairn clip` and `cairn audit` video extraction |
| `monitor` | `cairn run --monitor`, monitor steps, and process evidence |
| `ffmpeg` | non-default video speed adjustment and audit's temporary audio bridge |
| `codemap` | `cairn annotate`, `--auto-annotate`, `--since-codemap` |
| `codemap-index` | freshness of the target codebase's codemap index (best-effort) |
| `tvault` | `secrets.provider: tvault` in config |
| `artifact-root` | `~/.cairntrace/runs` is writable |
| `disk-space` | at least 1 GB free at the artifact root |
| `config-requires` | the config's `requires.cairntrace` range is satisfied by this cairn (only when the config declares it) |
| `config-node-runtime` | the config's `runtimes.node` (`path` / `version`, or `CAIRN_NODE`) resolves to a node that satisfies it (only when declared) |

`cairn doctor [--config <path>]` reads the config from `--config`, else the `cairntrace.config.yml` found from the working directory; the two `config-*` rows exist only for what it declares. Exit code is `0` when every check passes, `2` otherwise, and `4` when a config pin (`requires.cairntrace`, `runtimes.node`) is not met. A missing optional tool is never fatal to a run that does not need it — `doctor` just surfaces what is and is not wired up so you do not chase a "stash unavailable" error mid-run.

## `cairn doctor --orphans`

`cairn doctor --orphans [--kill] [--yes] [--only <session|pid,...>] [--json]` skips the checks above and looks for browser sessions cairn started whose `cairn run` is gone but whose browser survives (a crashed machine, a `kill -9`). Cairn records every browser session it starts in `~/.cairntrace/sessions-ledger/` — each browser pid with its start time and command — and removes the entry when the browser closed cleanly. Only a ledger-named process that is still that same process and still looks like a browser cairn launches (the agent-browser daemon, Playwright's browsers, a browser with `--enable-automation`) is ever listed, and each is checked again right before it is signalled, so a recycled pid, your desktop browser or another tool's browser is never touched. Ledger entries with nothing left running, or whose owner has been gone for 7 days, are removed. `--only` limits the listing and the kill to those sessions and pids (comma-separated, repeatable): pass exactly what you confirmed, so an orphan that appeared or changed in between is left alone (Studio does).

```bash
cairn doctor --orphans              # list; exit 1 when any, 0 when none
cairn doctor --orphans --kill       # asks first on a terminal
cairn doctor --orphans --kill --yes # no prompt (required with --json / --yaml or without a terminal)
cairn doctor --orphans --kill --yes --only cairntrace-4242,51234   # only what you confirmed
```

The result is `urn:cairntrace.dev:doctor-orphans:v1`: `orphans[]` (`session`, `backend`, `invocationId`, `ownerPid`, `projectDir`, `processes[]` with redacted commands, `killed` under `--kill`), `staleEntriesRemoved`, `liveSessions`, `killed`, `remaining`. Exit codes: `0` none (or all ended), `1` orphans listed or some survived `--kill`, `2` error, or `--kill` without a terminal or `--yes`. The config `run.verifyClean: [browsers]` uses the same ledger to refuse a run on a dirty machine.

If `playwright-package` fails, run `bun install`. If
`playwright-chromium` fails, run:

```bash
bunx playwright install chromium
```

Doctor checks installation readiness without launching Chromium or contacting
the network.

```bash
# CI: fail the job if the integrations the suite needs are missing
cairn doctor --format json | jq '.ok'
```

## `cairn clean`

`cairn clean` removes old run directories from the artifact root, keeping the newest N per spec. Run it from cron or a CI cleanup step; one evening of trace-heavy runs has produced 12 GB before.

```bash
cairn clean --keep 10          # keep the newest 10 runs per spec
cairn clean --all             # remove every run directory
cairn clean --artifact-root /tmp/cairn-runs
```

Keep-count resolution, in priority order:

1. `--all` (sets keep to `0`)
2. `--keep N`
3. `retention.keepRuns` in `cairntrace.config.yml`
4. `3` (the default)

Failed and errored runs get their own quota on top of the keep-count:
`retention.keepFailedRuns` (default 10) protects the newest N non-passed runs
per spec from pruning, so `cairn clean` — and the automatic post-run prune —
can never destroy the only evidence of a failure that has stopped reproducing.
`--all` overrides this and wipes failures too.

Artifact-root resolution: `--artifact-root` > `config artifactRoot` > `~/.cairntrace/runs`. The config is discovered by walking up from the cwd, the same lookup specs use.

The report lists what was removed, how much space was freed, and how many runs were kept. `--format json` returns `{ removed: [...], freedBytes, kept, keepRuns, keepFailedRuns }` for dashboards.

## When to run which

- **On a new machine or after `bun install`** — `cairn doctor` to see which
  integrations are ready and whether Playwright's matching Chromium build is
  installed.
- **A command says "X not on `$PATH`"** — `cairn doctor` confirms and points at the install tap (`brew install abdul-hamid-achik/tap/...`).
- **`doctor` flags `disk-space` as low** — `cairn clean` (or raise `retention.keepRuns`).
- **After a big CI run** — `cairn clean --keep 5` to bound disk growth between scheduled cleanups.

## See also

- [Configuration](/configuration) — `retention.keepRuns`, `artifactRoot`
- [Troubleshooting](/troubleshooting) — "Browser backend unavailable" and other doctor-flagged failures
- [Overview](/overview) — what cairntrace is
