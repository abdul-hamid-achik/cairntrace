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
├── artifact-manifest.json # path, kind, size, and digest for written artifacts
├── spec.resolved.yml     # the spec after ${baseUrl}/${env.X}/${vars.X} substitution
├── replay.json           # exact-replay manifest (SPEC §7.3): the `cairn run` command, backend, env, viewport, capture policy, redacted env KEY NAMES, cairn version
├── stash-receipt.json    # local file.cheap receipt (only after auto-stash)
├── events.ndjson         # full event stream
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
├── traces/               # backend trace ZIP (when retained by policy)
└── videos/               # Playwright WebM, clips, and audit vidtrace output
```

The pack is **self-contained** — moving it elsewhere loses no information. The
two files any agent must learn to read are `agent_context.md` (narrative) and
`outcomes/<id>.md` (per-outcome evidence). `report.json` is a presentation
envelope that embeds the run plus rendered summaries, artifact links, theme,
and reproduction metadata.

Optional `labels` on `run.json` (from `cairn run --label key=value`) let `cairn stats --group-by` build A/B cohorts across many packs without inventing a separate benchmark format.

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
  "status": "passed", // "passed" | "failed" | "errored"
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
    "manifest": "artifact-manifest.json"
  },
  "exitCode": 0
}
```

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

Trace archives use `traces/<backend>-trace.zip` when enabled and retained by
the capture policy. Native video recording is currently Playwright-only and
uses `videos/playwright-video.webm`. Agent-browser records a warning event
when video is requested; it does not synthesize a video from screenshots.
See [Video capture](/video) for backend-specific behavior.

## Interrupted batch runs

If a multi-spec `cairn run` receives SIGINT or SIGTERM, Cairntrace keeps every
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
reports, event streams, network and console text, request/eval captures,
`investigate.json`, and outcome sidecars.

Producer-owned files are outside that content-redaction boundary:

- Screenshots and videos can show secrets or personal data rendered in the UI.
- Downloads and transform outputs retain whatever data the source file contains.
- Trace archives can embed page state, DOM content, network resources, and
  storage captured by the browser backend.
- After vidtrace extraction, Cairntrace redacts `.json`, `.txt`, `.srt`,
  `.tsv`, `.vtt`, `.md`, and `.csv` files under `videos/vidtrace/`. Extracted
  frames and other images remain uninspected binary evidence.

Treat the entire run directory as sensitive even when its text files are
redacted. Prefer `on-failure`/`never` capture policies for evidence you do not
need, and review binary files before sharing or stashing the pack.

## Bounded remote publication

`retention.publish.enabled` can move a pruned, complete run to the private
file.cheap service. Cairntrace creates one deterministic mode-0600 `.tar.gz`,
rejects links and special files, enforces the 32 MiB remote limit assigned to
the `cairntrace` producer, and invokes
`fcheap publish` with fixed producer metadata. `retentionDays` defaults to
seven and is bounded to 1–31 days. The local run is removed only after the
server-verified receipt matches the package SHA-256, size, kind, and producer.
The publisher token is isolated from browsers, targets, hooks, and services.

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
