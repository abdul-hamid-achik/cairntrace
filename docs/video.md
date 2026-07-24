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
