---
title: Browser Test Evidence for Coding Agents
description: Explore Cairntrace artifact packs with HTML and JSON reports, agent context, outcome evidence, browser snapshots, screenshots, console, and network logs.
---

# Artifacts

Every `cairn run` writes a self-contained **artifact pack** to a directory on disk. The pack is the canonical record of the run — the human-readable narrative, the machine-readable JSON, the captured DOM, the network log, the console, and one outcome file per outcome.

## Where artifacts land

`<run-dir>` defaults to
`~/.cairntrace/runs/<ISO-timestamp>_<spec-name>_<6-hex>/`; colons and the
timestamp's decimal point are replaced with hyphens for filesystem safety.
Override the root with `--artifact-root <path>` or set `artifactRoot` in
`cairntrace.config.yml`.

```
2026-06-29T18-22-04-000Z_my-spec_c5a3f9/
├── run.json              # machine-readable run record
├── run.yaml              # same shape as run.json
├── run.md                # human-readable narrative
├── report.html           # standalone, themed HTML report
├── report.json           # machine-readable, used by dashboards
├── agent_context.md      # the post-mortem agent context
├── artifact-manifest.json # path, kind, size, digest and sensitivity for written artifacts
├── spec.resolved.yml     # the spec after ${baseUrl}/${env.X}/${vars.X} substitution
├── replay.json           # exact-replay manifest (SPEC §7.3): the `cairn run` command, backend, env, viewport, capture policy, redacted env KEY NAMES, cairn version
├── stash-receipt.json    # local file.cheap receipt (only after a stash of the run)
├── publish-receipt.json  # remote copy receipt (only after `cairn publish`)
├── events.ndjson         # full event stream
├── run.log               # plain narration of this run (always written)
├── logs/                 # live, redacted logs: precondition-NN-<name>.log, outcome-<id>.log
├── outcomes/
│   ├── results.json      # outcome index (also written as YAML and Markdown)
│   ├── <id>.md           # rendered outcome + evidence (every outcome)
│   └── <id>.raw.json     # full return value (only for `script:` outcomes)
├── snapshots/            # accessibility snapshots per step (when enabled)
├── screenshots/          # viewport PNGs per step (when enabled)
├── console/              # console.ndjson + errors.ndjson
├── network/              # requests.ndjson + failed_requests.ndjson
├── requests/             # assigned request-step responses
├── evals/                # assigned eval-step results
├── downloads/            # files saved by download steps
├── transforms/           # files produced by transform steps
├── diagnostics/          # per-step JSON and optional process summaries
├── services/             # bounded/redacted lifecycle, tmux, Compose and seed logs
├── traces/               # backend trace, sanitized (when retained by policy)
└── videos/               # Playwright WebM, clips, and audit vidtrace output
```

The pack is **self-contained** — moving it elsewhere loses no information. The
two files any agent must learn to read are `agent_context.md` (narrative) and
`outcomes/<id>.md` (per-outcome evidence). `report.json` is a presentation
envelope that embeds the run plus rendered summaries, artifact links, theme,
and reproduction metadata.

`network/requests.ndjson` uses a cross-backend request shape. Native Playwright
entries include a numeric epoch `timestamp` and sanitized `postData` only for
valid JSON bodies no larger than 64 KiB. Headers and opaque, invalid, or
oversized bodies are omitted; the artifact writer reparses JSON `postData` and
redacts sensitive keys again before persistence. Native Playwright stamps
`responseTimestamp` and `durationMs` only when `requestfinished` or
`requestfailed` confirms that the request is terminal; receiving response
headers alone does not count as completion. When agent-browser reports a
terminal status or error without response timing, Cairntrace records the
network-snapshot time as a conservative `responseTimestamp` upper bound and
derives `durationMs`; these entries carry
`responseTimingSource: "network-snapshot-upper-bound"`, while native timing is
left unmarked. Pending entries remain unstamped. This upper bound is causal
evidence, not a precise request-latency measurement.

Optional `labels` on `run.json` (from `cairn run --label key=value`) let `cairn stats --group-by` build A/B cohorts across many packs without inventing a separate benchmark format.

Runs started by `cairn run` also carry an optional `invocation` link,
`{ id, index, total, dir }`, on `run.json` and on the `run.started` event.
`dir` is relative to the artifact root and points at the
[invocation journal](#the-invocation-journal) that groups the runs of one
`cairn run` process.

## What `run.json` looks like

```jsonc
{
  "$schema": "urn:cairntrace.dev:run:v1",
  "version": "1",
  "runId": "2026-06-29T18-22-04-000Z_my-spec_c5a3f9",
  "runDir": "/artifact/root/2026-06-29T18-22-04-000Z_my-spec_c5a3f9",
  "spec": {
    "name": "my-spec",
    "path": "/project/flows/my-spec.yml",
    "contractHash": "sha256:..."
  },
  "environment": "local",
  "backend": "agent-browser",
  "coldStart": true,
  "status": "passed", // "passed" | "failed" | "errored" | "refused"
  "summary": "1/1 outcomes passed",
  "startedAt": "2026-...",
  "endedAt": "2026-...",
  "durationMs": 4231,
  "outcomes": [
    {
      "id": "results-narrowed",
      "status": "passed",
      "evidence": "outcomes/results-narrowed.md"
    }
  ],
  "steps": [
    {
      "id": "open-results",
      "status": "passed",
      "durationMs": 412,
      "artifacts": ["snapshots/001_open-results.txt"]
    }
  ],
  "artifacts": {
    "report": "report.html",
    "reportJson": "report.json",
    "agentContext": "agent_context.md",
    "events": "events.ndjson",
    "services": "services/manifest.json",
    "manifest": "artifact-manifest.json"
  },
  "exitCode": 0
}
```

A pinned run carries `"pinned": { "at": "…", "reason": "…" }` (`cairn pin`);
retention never prunes it.

A spec the environment policy refused has `"status": "refused"`, a
`refusal` block (`reason`, `env`, `requires`, `code`) and exit code 7, but
no run directory: that document only exists as `cairn run --format json`
output (and MCP `cairn_run`). Such a result, and one for a spec that errored
or was cancelled before its run started, carries `"synthetic": true`: its
`runId` and `runDir` are placeholders with nothing on disk, so do not open
them.

`run.yaml` is the same shape in YAML for humans who prefer it. `run.md` is the
same data rendered as Markdown. `cairn context latest` prints
`agent_context.md`, not `run.md`.

## What `agent_context.md` is for

When a run fails, the agent context is the post-mortem the next agent should read before touching anything. It contains, in order:

1. The failing outcome and its expected-vs-actual evidence.
2. The step that produced the state at failure (`<step-ordinal>: <kind> <summary>`).
3. The last successful snapshot title (`Last good state`).
4. The console and network errors in chronological order, capped at ~50 lines each.
5. A diff against the most recent passing run of the same spec when one exists.
6. After `cairn investigate`, ranked Code Matches as `file:line` pointers and
   scores. Raw source snippets stay out of the compact handoff.

The agent context is capped — kept under ~16 KB so it fits in any model
context window. Detailed snapshots, per-step diagnostics, network/console
streams, traces, and video remain in the run directory but not in
`agent_context.md`.

## `report.html`

Self-contained HTML with inline CSS and a small inline theme-switch script; it
loads no external CSS, JavaScript, or fonts. It is print-friendly, themed
through the project config (`cairntrace.config.yml > report.theme`), and passes
through the text/JSON redactor. Review any linked binary artifacts separately
before sharing the report directory.

## What `cairn run --format json` prints vs what the artifact pack holds

- `--format json` prints the same run document written to `run.json`, including
  the top-level `runDir`.
- The pack is the durable record. The stdout JSON is a convenience for shell pipelines.

## Outcome files

Every outcome always writes `outcomes/<id>.md`. The body is always:

- The verifier and parameters.
- A rendered description of what was checked.
- The evidence as a short block — page text, network call summary, console line, count value, file metadata, etc.
- For `script:` outcomes, an `outcomes/<id>.raw.json` sidecar holds the full
  return value after applying the same text/JSON redaction as the rest of the
  pack.

The `.md` is what shows up in `report.html` and what an agent sees first. The `.raw.json` is for you, not for the agent.

## Screenshots, traces, and video

Per-step screenshots default to `on-failure`. Configure them under
`artifacts.capture.screenshots`; retained files use
`screenshots/<step-ordinal>_<step-id>.png`. Step timing and status are recorded
in `events.ndjson` and `run.json`.

Traces are kept when enabled and retained by the capture policy: Playwright
writes a Trace Viewer zip, `traces/playwright-trace.zip` (`playwright
show-trace`), and agent-browser writes Chrome trace-event JSON,
`traces/agent-browser-trace.json` (open it in Perfetto or chrome://tracing;
older runs used a `.zip` name for the same JSON). A kept trace is sanitized
when the run ends (see [Sensitivity](#sensitivity-and-the-evidence-gate)). A
trace over `artifacts.capture.traceMaxBytes` (default 50 MiB) is dropped, and
an empty or failed one is reported; both write an `artifact.trace` event and
never change the run status. Native video recording is currently Playwright-only and
uses `videos/playwright-video.webm`. Agent-browser records a warning event
when video is requested; it does not synthesize a video from screenshots.
See [Video capture](/video) for backend-specific behavior.

## The event stream (`events.ndjson`)

`events.ndjson` is append-only: one JSON object per line, always
`{ "ts": "<ISO timestamp>", "type": "<event type>", ...fields }`, written while
the run happens. The vocabulary is versioned as **events v1**. New types and new
optional fields are additive; readers should ignore types and fields they do not
know.

| Type | When | Notable fields |
| --- | --- | --- |
| `run.started` / `run.passed` / `run.failed` / `run.errored` | run boundaries | `runId`, `spec`, `invocation`, `durationMs`; a precondition error adds `phase`, `name`, `timedOut` |
| `phase.changed` | entering preconditions, steps, outcomes | `phase`, `item` (e.g. the precondition name), `budgetMs`, `deadline` |
| `run.heartbeat` | every 15s while a run is active | `phase`, `item`, `elapsedMs` (in the current phase/item), `budgetMs`, `runElapsedMs`, `pid` |
| `precondition.started` / `precondition.run` | each setup command | `name`, `timeoutMs`, `index`/`total`, `logPath`; `exitCode`, `timedOut`, `output` |
| `step.started` | each step | `stepId`, `index`/`total` (1-based), `kind`, `label` (e.g. ``click role=button "Save"``) |
| `step.finished` / `step.failed` | each step | `durationMs`, `error`, `resolved`, `url`, `screenshot`; a skipped `when:` step is `step.finished` with `skipped: true` |
| `outcome.started` / `outcome.passed` / `outcome.failed` / `outcome.skipped` | each outcome, live | `outcomeId`, `kind`, `timeoutMs`; verdicts carry `durationMs` |
| `outcome.progress` / `precondition.progress` | a verifier or setup command reports progress | `outcomeId` or `name`, `message` (see [Progress messages](#progress-messages)) |
| `log.opened` | a live log file is created | `kind` (`narration`, `precondition`, `outcome`, `hook`, `services`), `name`, `path` |
| `artifact.*`, `viewport.set` | evidence written | `stepId`, `path` (relative to the run directory) |
| `artifact.trace` | a trace was saved, failed, or dropped | `action` (`saved` \| `error` \| `dropped`), `format`, `reason`, `bytes`, `maxBytes`, `sensitivity` |
| `artifact.stash` / `artifact.publish` / `artifact.retention` | stash, archive, publication, retention outcomes | `action`, `status` (`error` with a `reason` code and a path-free `message`), `stashId` / `artifactRef`, `excluded`, `runId` of a pruned run |
| `services.<phase>.<event>` | copied from the shared services lifecycle | `message`, `data` |

Some details matter when you build on the stream:

- Step labels come from the locator and target only. They never contain fill,
  type, or select values, upload paths, request bodies, or URL query strings.
- `url` on a step event is free evidence only: the navigation target of an
  `open` step that passed, or the page URL the failure diagnostics captured.
  Query strings and fragments are dropped. A step without free evidence has no
  `url`, and Cairntrace never adds a backend round-trip to get one.
- `precondition.run.output` keeps the **last** 4000 characters of the command's
  combined output. `outputTruncated: true` marks a tail. A failed
  precondition's `failure.message` ends with the last 500 characters.
- Heartbeats stop before the final `run.*` event, so nothing is appended after
  `artifact-manifest.json` checksums the log.
- Paths inside events (`path`, `logPath`, `screenshot`) are relative to the
  directory that holds the `events.ndjson` announcing them.

## Live logs

Each run writes its logs while it runs, so you can tail them instead of
waiting for the verdict. Every line is redacted with the run's redactor before
it reaches the disk, and ANSI color codes are removed.

| File | Content |
| --- | --- |
| `run.log` | The plain narration of this run (the `--progress plain` lines, plus a final `run end:` line). It is written for every run, whatever `--format` or `--progress` you use. |
| `logs/precondition-NN-<name>.log` | The combined stdout and stderr of precondition command `NN`, as it runs. `precondition.started` and `precondition.run` point at it with `logPath`. |
| `logs/outcome-<id>.log` | The stdout and stderr of a `runtime: node` script verifier. |

`run.log` and the files under `logs/` are complete before
`artifact-manifest.json` is written, and the manifest lists them with the kinds
`run-log` and `log`.

### Progress messages

A long setup command or verifier can report where it is. Cairntrace sets
`CAIRN_PROGRESS_FILE` for precondition commands and `runtime: node` script
verifiers. Each line appended to that file becomes a `precondition.progress` or
`outcome.progress` event, a `run.log` line, and a line in the terminal
narration. Cairntrace reads the file about once per second while the item
runs, and once more when it ends.

In a node script verifier, call `ctx.progress(message)`:

```yaml
outcomes:
  - id: tasks_terminal
    description: Every queued task reached a terminal state.
    verify:
      script:
        runtime: node
        timeoutMs: 300000
        file: ./verifiers/tasks-terminal.mjs
```

```js
export async function verify(ctx) {
  for (;;) {
    const { done, total } = await countTerminalTasks(ctx.vars);
    ctx.progress(`${done}/${total} tasks terminal`);
    if (done === total) return { ok: true, evidence: { done, total } };
    await new Promise((r) => setTimeout(r, 5000));
  }
}
```

A precondition command appends to the file itself:

```yaml
preconditions:
  commands:
    - name: quiesce
      run: ./tools/wait-for-queues.sh
      timeoutMs: 1500000
```

```sh
echo "3/9 queues idle" >> "$CAIRN_PROGRESS_FILE"
```

Without the variable (for example when the script runs outside Cairntrace),
`ctx.progress()` does nothing. Messages are cut at 500 characters, and a
burst keeps its newest 20 lines per read. The progress file lives in a
temporary directory outside the run, so only the redacted events reach the
artifact pack.

## The invocation journal

One `cairn run` process (a single spec, a batch, or a `--repeat`/`--matrix`
plan) is one **invocation**. It writes a journal next to the runs:

```
<artifact-root>/_invocations/<invocation-id>/
├── invocation.json   # plan, live status, current run, runs, final summary
├── events.ndjson     # invocation.*, services.*, hook.*, phase.changed, run.heartbeat
└── logs/
    ├── narration.log         # batch-level lines: [i/N] starting, verdicts, summary
    ├── services-docker.log   # docker command output, live
    ├── services-seed.log     # seed command and postCommands output, live
    ├── services-teardown.log # teardown commands' output (normal, failure cleanup, signal path)
    ├── hook-before-NN.log         # --before hook NN, every iteration appended
    └── hook-after-NN-<runId>.log  # --after hook NN for one run
```

The id is `<ISO timestamp with ':' and '.' replaced by '-'>_<pid>_<6 hex>`.
`_invocations` is not a run: it never matches the run-directory name pattern,
so retention skips it and `latest` / `previous` (in `cairn logs`, `stash`,
`investigate`, `diff`, `context`, `clip`, `export brief --from-run`, `stats`
and the MCP tools) never resolve to it.

`--after` hooks run once per spec run, at the same time under `--parallel`, so
each run's execution gets its own log file and concurrent output never
interleaves. The journal's redactor applies every planned spec's `redaction`
block from its first line, so services output and `--before` hooks are
scrubbed too, not only what follows the first run.

`invocation.json` is rewritten atomically (temporary file, then rename) each
time a run starts or settles, so you can poll it:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `invocationId`, `pid`, `cwd`, `configPath`, `env` | who is running, where, and against which environment |
| `argv` | CLI arguments, redacted. `key=value` pairs with a sensitive key (`--var password=…`) keep only the key. |
| `labels`, `parallel` | `--label` pairs and `--parallel` |
| `planned` | `[{ index, spec, labels? }]`: every spec × iteration, in order |
| `status` | `running`, then `passed`, `failed`, `errored`, or `aborted`. Exit 7 (every spec refused by the environment policy, or any under `--strict-requires`) settles as `failed` |
| `startedAt`, `endedAt` | ISO timestamps |
| `current` | `{ index, spec, runId? }` of the run that started last |
| `runs` | `[{ index, spec, runId, runDir, status, synthetic? }]`; `status` is `running` until the run settles. A refused spec gets no entry (a `run.refused` event in the journal's `events.ndjson` instead); `synthetic: true` marks a spec that errored before its run started (no directory) |
| `summary` | `{ total, passed, failed, errored, refused?, durationMs, exitCode, iterations?, error? }`: the batch summary that `cairn run` prints, persisted; `refused` only when the environment policy refused a spec |
| `signal` | `SIGINT` or `SIGTERM` when a signal aborted the invocation |

A `status: "running"` journal whose `pid` is no longer alive was killed
without a chance to update itself; treat it as aborted. On SIGINT or SIGTERM,
Cairntrace marks the journal `aborted` synchronously before it exits.

Services events are written to the journal live, as they happen. Each run's
own `events.ndjson` keeps its back-dated copy of the same `services.*` events
for compatibility. The journal's `phase.changed` events walk through
`services`, `before-hooks`, `steps` (`item` names the planned run, for
example `spec 2/5 checkout.yml`), `after-hooks`, and `teardown`. `hook.started`
and `hook.finished` carry the hook kind, its 1-based `index`, the redacted
`command`, `logPath`, `runId` for `--after` hooks, `iteration` under
`--repeat`/`--matrix`, the `exitCode`, and the last 2000 characters of the
redacted output in `outputTail`.

Retention keeps the newest 20 journals. An older journal is removed once none
of the run directories it lists still exists, unless its process is still
running. A journal whose `invocation.json` this version cannot read (for
example one written by a newer Cairntrace) is never removed; readers ignore
fields they do not know.

## Following a run live

`cairn logs` reads the same files:

```sh
cairn logs latest --follow                     # events.ndjson until the run settles
cairn logs latest --follow --log run           # run.log
cairn logs latest --follow --log precondition  # every logs/precondition-*.log
cairn logs latest --log outcome-tasks_terminal # one log, printed once
cairn logs --invocation latest                 # journal summary (--format json|yaml|md)
cairn logs --invocation latest --follow --log narration
```

`--follow` streams from the start of the file, picks up new matching log
files as they appear, and exits 0 once the run's `artifact-manifest.json`
exists (or the invocation journal has a terminal status). It exits 2 when the
process that wrote the run is gone without finishing it, or when there is no
such run. Events stream as NDJSON, unchanged. When several files are
followed, a `==> logs/<file> <==` line marks each switch between them.

While a `cairn run` is still going, `cairn logs latest --follow` follows the
current run of that invocation rather than the newest run folder. If the
invocation is still starting services or running `--before` hooks, no run
folder exists yet: the command says so on stderr and waits for the first run
(exit 2 if the invocation ends before starting one). To watch that boot phase
itself, follow the journal: `cairn logs --invocation latest --follow`.

`--format` / `--json` shape only the invocation summary. On a run
reference they are refused with exit 2; use `--events` for a run's NDJSON.

## Run context for setup commands and hooks

Precondition commands, `--before` hooks, and `--after` hooks get the run's
non-secret context in their environment. Values that are not known yet are
omitted. For example, a `--before` hook runs before any run directory exists.

| Variable | Value | Preconditions | `--before` | `--after` |
| --- | --- | --- | --- | --- |
| `CAIRN_ENV` | resolved environment name | ✓ | ✓ | ✓ |
| `CAIRN_BASE_URL` | the environment's `baseUrl` | ✓ | ✓ | ✓ |
| `CAIRN_CONFIG_DIR` | directory of the resolved `cairntrace.config.yml` | ✓ | ✓ | ✓ |
| `CAIRN_RUN_ID`, `CAIRN_RUN_DIR` | this run's id and directory | ✓ | — | ✓ |
| `CAIRN_RUN_TOKEN` | the run's `${run.token}` value | ✓ | — | ✓ |
| `CAIRN_RUN_STATUS`, `CAIRN_SPEC_PATH` | verdict and spec path | — | — | ✓ |
| `CAIRN_PROGRESS_FILE` | per-command progress file ([Progress messages](#progress-messages)) | ✓ | — | — |

A precondition's own `preconditions.env` entries override these values.

## Machine-readable narration

`--format json` and `--format yaml` reserve stdout for the document, so they do
not print the human narration. Add the global `--log-format json` flag to get
the same milestones as NDJSON on stderr instead. These milestones are run start,
precondition start and finish (with the budget), step finish (with an error
summary), outcome verdicts (with expected and actual values on failure), batch
rows (`specIndex`/`specTotal`), and run end. Each entry has
`"scope": "progress"`. Every entry after run start carries the `runId`.
Failures are logged at `warn`, so `--quiet` keeps them. Streamed service output
is wrapped as `{"stream": "raw"}` entries, so stderr stays valid NDJSON.

## Interrupted batch runs

The [invocation journal](#the-invocation-journal) of an interrupted
`cairn run` is marked `aborted` with the signal. If a multi-spec `cairn run`
receives SIGINT or SIGTERM, Cairntrace also keeps every
completed per-spec run directory and synchronously writes
`aborted-<timestamp>-<pid>.json` at the artifact root before browser/service
teardown. The strict `run-batch-aborted:v1` document records the signal,
requested and pending counts, and the complete `RunResult` for each finished
spec in input order. An in-flight run directory may be incomplete
(missing/corrupt/statusless `run.json`); such runs are not carve-out protected
and count toward the `retention.keepRuns` window like any other run, so the
newest interrupted run is kept up to the cap but older ones age out. Stale
`aborted-<timestamp>-<pid>.json` summaries are swept under the same cap. An
explicit `cairn clean --all` removes everything.

## Redaction boundary

The redactor runs before Cairntrace writes its own text or structured JSON. It
replaces registered literal secrets with `[redacted]`, replaces values under
sensitive keys (`authorization`, `cookie`, `token`, `secret`, `password`,
`api_key`, …), scrubs `Authorization`/`Cookie`/`Set-Cookie` header lines, and
removes values from common token-bearing query parameters. Values resolved
from TinyVault and literal values in the spec's `redaction.values` are
registered automatically. This covers Cairntrace-authored run records,
reports, event streams, live logs, network and console text, request/eval
captures, `investigate.json`, and outcome sidecars.

Live logs are redacted one line at a time. So that a multi-line secret (a PEM
key, a JSON service-account file) cannot slip through, every line of 8 or more
characters of such a value is registered as a secret of its own. Precondition
commands, hooks, and services commands receive exactly the filtered child
environment: `FILECHEAP_INGEST_TOKEN`, `CAIRN_TVAULT_ENV`, and every `TVAULT_*`
variable that is not an explicitly selected secret key are not passed to them
(read `CAIRN_ENV` for the environment name), and the credential values are
scrubbed from artifacts as a backstop. The filter applies to what is
inherited: a key a services phase or the `webServer` sets in its own config
`env:` (for example `TVAULT_DIR` for a provisioner that reads a non-default
vault) is passed as written.

Producer-owned files are outside that content-redaction boundary:

- Screenshots and videos can show secrets or personal data rendered in the UI.
- Downloads and transform outputs retain whatever data the source file contains.
- Traces can embed page state, DOM content, network resources, and storage
  captured by the browser backend. The trace sanitizer removes known
  credential classes but is best effort (see below).
- After vidtrace extraction, Cairntrace redacts `.json`, `.txt`, `.srt`,
  `.tsv`, `.vtt`, `.md`, and `.csv` files under `videos/vidtrace/`. Extracted
  frames and other images remain uninspected binary evidence.

Treat the entire run directory as sensitive even when its text files are
redacted. Prefer `on-failure`/`never` capture policies for evidence you do not
need, and review binary files before sharing or stashing the pack.

## Sensitivity and the evidence gate

`artifact-manifest.json` lists every file with its `path`, `kind`, `bytes`,
`sha256` and a `sensitivity`:

| Sensitivity | Meaning | Stash | Publish |
| --- | --- | --- | --- |
| `redacted` | written by Cairntrace through the run redactor (run records, events, logs, snapshots, network/console, outcome evidence) | yes | yes |
| `safe` | browser-produced media and files with no credential structure: screenshots, videos, downloads. They can still show personal data | when the category is included | when the category is included |
| `sanitized` | a backend trace the trace sanitizer rewrote | when `traces` is included | never |
| `secret-bearing` | raw bytes that may carry credentials: a trace that could not be sanitized, a raw `monitor` heap profile, any text file Cairntrace did not write itself (such as `--after` collector output in `diagnostics/`) | only with `stash.unsafeIncludeRawTraces: true` | never |

Kept traces are sanitized when the run ends, keeping their shape so Trace
Viewer and Perfetto still open them: credential headers and cookies (by name
pattern and the spec's `redaction.headers`), `storageState` /
`localStorage` / `sessionStorage` contents, values typed into password
fields wherever they appear, sensitive `name=value` parameters in URLs,
fragments and form bodies, and registered secret values become
`[redacted]`. It cannot recognize a credential under an unremarkable name in
free text, which is why its output is `sanitized`, not `redacted`. A trace it
cannot rewrite stays local as `secret-bearing`.

Every stash of a run directory (auto-stash, `cairn stash save`,
`cairn pin --stash`, the retention archive, `cairn investigate`,
`cairn audit --connect`, `cairn clip --stash`) and every publication goes
through one gate. It sorts files into `text`, `screenshots`, `traces`,
`videos` and `downloads` and carries only `[text, screenshots]` by default;
`stash.include`, `retention.publish.include` or `--include` opt into the
rest. What is left out is listed as `excluded` on the receipt and event. See
[Stash, pin and publish](/stash).

## Bounded remote publication

`cairn publish <run>` and `retention.publish.enabled` send a gated run to the
private file.cheap service. Cairntrace creates one deterministic mode-0600
`.tar.gz` of the members the gate selects (`retention.publish.include`,
default `[text, screenshots]`; `sanitized` and `secret-bearing` files, so
every trace, never), rejects links and special files, enforces the 32 MiB
remote limit assigned to the `cairntrace` producer, and invokes
`fcheap publish` with fixed producer metadata plus, when supported, a
metadata-only RunIndexV1 sidecar. `retentionDays` defaults to seven and is
bounded to 1–31 days. The run gains `publish-receipt.json` and an
`artifact.publish` event. A retention publication removes the local run only
after the server-verified receipt matches the package SHA-256, size, kind, and
producer. The publisher token is isolated from browsers, targets, hooks, and
services.

## Sharing an artifact pack

A run dir is a directory. Compress it
(`tar -czf my-spec-run.tgz 2026-..._my-spec_<6-hex>/`) and you can:

- Email it to a teammate — `report.html` opens in any browser.
- Save it in the local file.cheap vault
  (`cairn stash save <run-id> --tag <label>`). Stashing does not upload or
  replicate it.
- Hand it to a repair bot. The repair engine reads the agent context and proposes step rewrites against `spec.yml`.

Anywhere the directory is mounted, the data is self-describing. Nothing is
required to read the text evidence other than a Markdown viewer. Transfer it
only through a channel appropriate for its potentially sensitive binary
contents.

## See also

- [Overview](/overview) — what cairntrace is
- [Quickstart](/quickstart) — install + first run
- [Authoring](/authoring) — what makes a contract survive across months
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies
