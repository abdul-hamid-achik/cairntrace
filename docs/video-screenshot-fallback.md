# Video recording fallback for backends without native recording (screenshot timelapse)

**Status:** Proposed (not yet implemented). Motivated by recording a demo of an OPG-15061 fix on the graphite SPA, where neither backend could practically produce a video.

## Problem

`artifacts.capture.video` only produces a `.webm` on the **Playwright** backend (native
`browserContext({ recordVideo })`). On the **agent-browser** backend (the default, and the
fast/reliable one for heavy SPAs), `video: always` is silently a **no-op** — no file is written and
no warning is emitted. So you cannot record a video of a run on the backend you actually use.

The obvious workaround — `--backend playwright` — fails in practice on heavy SPAs:

- Playwright's `networkidle` wait never settles (the app holds persistent polling / websockets), so
  every `wait: { load: networkidle }` burns its full `timeoutMs`. A real run (login + entity switch
  + ~25 steps) ran **>11 min** and still hadn't reached the table.
- Swapping every `networkidle` → `load` and adding `slowMo` still **timed out at 5 min** (the
  headless-shell login + hydration is simply slow under Playwright here).

Net: there is currently **no practical way to get a video of a passing run** on this class of app.

## Fix: stitch the per-step screenshots into a timelapse video

cairntrace already (a) captures one screenshot per step when `screenshots` capture is enabled, and
(b) **bundles `ffmpeg`** (already used for `artifacts.video.slowMo` / `speed` post-processing). So
when video is requested on a backend with no native recorder, stitch `screenshots/*.png` →
`videos/<backend>-timelapse.mp4` with the bundled ffmpeg.

### Behavior

- If `artifacts.capture.video` is `always` (or `on-failure` and the run failed) **and** the backend
  produced no native video, write `videos/<backend>-timelapse.mp4` from the captured screenshots.
- **Auto-enable per-step screenshots** for the run when video is requested on a non-native backend
  (otherwise there is nothing to stitch); if the author explicitly set `screenshots: never`, warn
  and skip rather than fail.
- Honor `artifacts.video.slowMo` as the per-frame on-screen duration (ms) and `artifacts.video.speed`
  as a playback multiplier, mirroring the native-video semantics (`framerate = 1000 / slowMo`).
- Order frames by the existing zero-padded step index (`001_*.png` … `NNN_*.png`).

### Config (no schema change — reuses existing keys)

```yaml
artifacts:
  capture:
    screenshots: always   # auto-implied when video is requested on a non-native backend
    video: always
  video:
    slowMo: 600           # per-frame duration (ms) for the timelapse
    speed: 1              # playback multiplier
```

### Reference ffmpeg invocation (the proven manual workaround)

```sh
# framerate = 1000 / slowMo  (600ms -> ~1.67 fps; example below uses 0.7 fps)
ffmpeg -y -framerate 0.7 -pattern_type glob -i 'screenshots/*.png' \
  -vf "scale=1400:788:force_original_aspect_ratio=decrease,pad=1400:788:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p videos/agent-browser-timelapse.mp4
```

The `pad` filter keeps every frame a uniform size so libx264 accepts a variable-size screenshot
sequence; `format=yuv420p` keeps it playable in QuickTime / browsers.

## Implementation pointers

- Backend adapter boundary: where the Playwright adapter writes `videos/<backend>-video.webm`
  (native). Add a shared post-run hook: *if no native video file exists and video was requested,
  run the stitch.*
- Reuse the ffmpeg path cairntrace already resolves for `slowMo` / `speed`.
- The run artifact writer that lays out `videos/`, `screenshots/`, `snapshots/`, etc.
- Doc note in `cairn docs artifacts`: "Video works on all backends — native on Playwright, a
  screenshot timelapse (honoring slowMo/speed) elsewhere."

## Acceptance

- `cairn run <spec> --backend agent-browser` with `video: always` writes a playable
  `videos/agent-browser-timelapse.mp4` (screenshots auto-enabled).
- A test runs a 2-step `mock`-backend spec with `video: always` and asserts the timelapse file
  exists and is non-empty.
- `--backend playwright` is unchanged (native recording still used).

## Interim workaround (until shipped)

Run with the fast **agent-browser** backend + `screenshots: always`, then stitch with the reference
ffmpeg invocation above. This is exactly how the OPG-15061 demo video
(`~/Downloads/OPG-15061-blank-row-fix-demo.mp4`, 25 frames) was produced.
