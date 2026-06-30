# Artifacts

Every `cairn run` writes a self-contained **artifact pack** to a directory on disk. The pack is the canonical record of the run — the human-readable narrative, the machine-readable JSON, the captured DOM, the network log, the console, and one outcome file per outcome.

## Where artifacts land

`<run-dir>` defaults to `./run/<spec-base-name>-<YYYY-MM-DDTHH-MM-SS>-<short-id>/`. Override with `--out <dir>` or set `run.out` in `cairntrace.config.yml`.

```
run/my-spec-2026-06-29T18-22-04-c5a3/
├── run.json              # machine-readable run record
├── run.yaml              # same shape as run.json
├── run.md                # human-readable narrative
├── report.html           # standalone, themed HTML report
├── report.json           # machine-readable, used by dashboards
├── agent_context.md      # the post-mortem agent context
├── spec.resolved.yml     # the spec after ${baseUrl}/${env.X}/${vars.X} substitution
├── events.ndjson         # full event stream
├── outcomes/
│   ├── <id>.md           # rendered outcome + evidence (every outcome)
│   └── <id>.raw.json     # full return value (only for `script:` outcomes)
├── snapshots/            # accessibility snapshots per step (when enabled)
├── screenshots/          # viewport PNGs per step (when enabled)
├── console/              # console.ndjson (when enabled)
├── network/              # network.har + network.ndjson (when enabled)
├── frames/frames.ndjson  # per-step frame markers (when recording)
└── raw/                  # any backend-provided raw artifacts (PTY logs, video, etc.)
```

The pack is **self-contained** — moving it elsewhere loses no information. The two files any agent must learn to read are `agent_context.md` (narrative) and `outcomes/<id>.md` (per-outcome evidence). `report.json` is the same data as `run.json` plus per-outcome render metadata.

## What `run.json` looks like

```jsonc
{
  "spec": { "name": "my-spec", "path": "..." },
  "status": "passed",            // "passed" | "failed" | "errored" | "cold-start-gate" | "lint" | ...
  "contractHash": "sha256:...",  // hash over intent + outcomes
  "startedAt": "2026-...",
  "durationMs": 4231,
  "stepResults": [
    { "kind": "open", "status": "ok", "ordinal": 1, "durationMs": 412 }
  ],
  "outcomes": [
    {
      "id": "results-narrowed",
      "verifier": "count",
      "status": "passed",
      "evidence": "count=7 (expected 7)",
      "value": 7,
      "expected": 7
    }
  ],
  "captures": { },
  "requests": { }
}
```

`run.yaml` is the same shape in YAML for humans who prefer it. `run.md` is the same data rendered as Markdown — it is what `cairn context latest` returns by default.

## What `agent_context.md` is for

When a run fails, the agent context is the post-mortem the next agent should read before touching anything. It contains, in order:

1. The failing outcome and its expected-vs-actual evidence.
2. The step that produced the state at failure (`<step-ordinal>: <kind> <summary>`).
3. The last successful snapshot title (`Last good state`).
4. The console and network errors in chronological order, capped at ~50 lines each.
5. A diff against the most recent passing run of the same spec when one exists.

The agent context is capped — kept under ~16 KB so it fits in any model context window. Detailed DOM diffs, full HAR exports, and per-step frame data live in the dir but not in `agent_context.md`.

## `report.html`

Self-contained HTML — no external CSS, no JS, no fonts. Print-friendly, themed through the project config (`cairntrace.config.yml > report.theme`), redacted of all secret material. The HTML report is what you email to a non-agent teammate who needs to see what happened.

## What `cairn run --format json` prints vs what the artifact pack holds

- `--format json` prints the same data as `report.json`, plus a top-level `runDir` pointing at the on-disk pack.
- The pack is the durable record. The stdout JSON is a convenience for shell pipelines.

## Outcome files

Every outcome always writes `outcomes/<id>.md`. The body is always:

- The verifier and parameters.
- A rendered description of what was checked.
- The evidence as a short block — page text, network call summary, console line, count value, file metadata, etc.
- For `script:` outcomes, a `outcomes/<id>.raw.json` sidecar holds the full return value (not redacted).

The `.md` is what shows up in `report.html` and what an agent sees first. The `.raw.json` is for you, not for the agent.

## Frames and screenshots

Per-step screenshots are off by default (`artifacts.screenshots: 'on-failure'` is the typical setting). When enabled, they live under `screenshots/<step-ordinal>.png`. The video fallback, when active, lives under `videos/<backend>-timelapse.mp4` — see [video-screenshot-fallback](/video-screenshot-fallback) for the proposal.

`frames/frames.ndjson` is a per-step marker stream — one entry per step with timing, status, and a pointer to the screenshot. Used by `cairn studio` and any `replay --tui` flow.

## What never lands in an artifact pack

The redaction layer catches these on the way out. If you see one anyway, that's a bug — file an issue.

- `Authorization` headers (any scheme).
- `Cookie`, `Set-Cookie`, and `Cookie:` request lines.
- Bearer tokens, API keys, basic-auth credentials.
- Postgres / MySQL connection strings.
- AWS / GCP access keys.
- Anything matching a user-supplied regex (`cairntrace.config.yml > redaction.patterns`).

The redactor compiles the patterns on construction, and the runner applies it to every captured field — `network.har` body fields, console messages, even script return values that contain the redacted shape.

## Sharing an artifact pack

A run dir is a directory. Compress it (`tar -czf my-spec-run.tgz run/my-spec-2026-...`) and you can:

- Email it to a teammate — `report.html` opens in any browser.
- Host it on the local-first stash (`cairn stash save <run-dir> --name <label>`).
- Hand it to a repair bot. The repair engine reads the agent context and proposes step rewrites against `spec.yml`.

Anywhere the directory is mounted, the data is self-describing. Nothing required to read it other than a markdown viewer.

## See also

- [Overview](/overview) — what cairntrace is
- [Quickstart](/quickstart) — install + first run
- [Authoring](/authoring) — what makes a contract survive across months
- [Steps](/steps) and [Verifiers](/verifiers) — the typed vocabularies
