---
title: Record Browser Test Video
description: Record native Playwright video in Cairntrace, understand capture policies, and use screenshots when a backend cannot record video.
---

# Video capture

Cairntrace records native WebM video with the Playwright backend. The
agent-browser and mock backends do not record video, and Cairntrace does not
build a synthetic video from screenshots.

## Record a Playwright run

Enable video in the spec and run it with Playwright:

```yaml
artifacts:
  capture:
    video: always
  video:
    slowMo: 250
    speed: 1
```

```bash
cairn run flows/checkout.yml --backend playwright
```

A retained recording is written to `videos/playwright-video.webm`.
`slowMo` delays browser actions so short interactions remain visible. `speed`
changes playback speed during post-processing and requires `ffmpeg`.

Capture policy controls retention:

- `always` keeps video for passing and non-passing runs.
- `on-failure` removes the video after a passing run.
- `never` disables recording and is the default.

## Check Playwright readiness

Install the package dependencies and the matching Chromium build:

```bash
bun install
bunx playwright install chromium
cairn doctor --format md
```

Doctor reports `playwright-package` and `playwright-chromium` separately. This
distinguishes a missing dependency install from a missing or non-executable
browser binary.

## Use screenshots on agent-browser

When you use agent-browser, capture screenshots directly:

```yaml
artifacts:
  capture:
    screenshots: always
    video: never
```

Screenshots are written as
`screenshots/<step-ordinal>_<step-id>.png`. If video is requested on a backend
without recording support, Cairntrace writes a warning to `events.ndjson` and
continues the run without a video file.

## Traces

`artifacts.capture.trace` (`on-failure` by default) records a browser trace:

| Backend | File | Open it with |
|---|---|---|
| Playwright | `traces/playwright-trace.zip` | `bunx playwright show-trace <file>` |
| agent-browser | `traces/agent-browser-trace.json` | [Perfetto](https://ui.perfetto.dev) or `chrome://tracing` |

agent-browser writes Chrome trace-event JSON, not a Trace Viewer zip. Older
runs named it `traces/agent-browser-trace.zip`; it is the same JSON, so open
it in Perfetto too. `agent_context.md` names the right viewer for each run.

A trace that is empty or that the backend could not save is dropped with an
`artifact.trace` event (`action: "error"`), and one larger than
`artifacts.capture.traceMaxBytes` (default 50 MiB) is dropped with
`action: "dropped"`. Neither changes the run's status:

```yaml
artifacts:
  capture:
    trace: on-failure
    traceMaxBytes: 20000000
```

A kept trace is sanitized in place, best effort: credential headers and
cookies, storage state, password-field values, sensitive URL and form
parameters, and registered secret values become `[redacted]`. The manifest
marks it `sanitized` (or `secret-bearing` when it could not be rewritten).
Traces and videos stay out of stashes and retention archives unless
`stash.include` lists them; a trace is never published. See
[Stash](/stash#what-leaves-the-machine-the-evidence-gate).

## Audit and clips

`cairn audit` forces the Playwright backend and video capture, then can run
vidtrace extraction under `videos/vidtrace/`. `cairn clip` cuts labelled
segments from an existing retained video; it cannot create a source video for
a run that did not record one.

## See also

- [Artifacts](/artifacts) — exact run-directory layout and redaction boundary
- [Clip](/clip) — cut labelled segments with vidtrace
- [Investigate and audit](/investigate) — one-command video evidence and code connection
- [Doctor and clean](/doctor) — Playwright package and Chromium readiness checks
