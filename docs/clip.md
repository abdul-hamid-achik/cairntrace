# Clip

`cairn clip` cuts named clips from a run's recorded video using [vidtrace](https://github.com/abdul-hamid-achik/vidtrace). Use it to extract the few seconds around a failure for a bug report, a PR review, or a regression reel — without re-running the spec. Vidtrace is optional (`cairn doctor` flags it); the command errors clearly when it is not on `$PATH`.

## `cairn clip <run-ref>`

```bash
cairn clip latest --label "failure=0:12-0:18" --label "recovery=0:20-0:24"
cairn clip latest --label "login=0:05-0:10" --out ./clips --name login-fail
cairn clip latest --label "bug=0:12-0:18" --stash --tag regression
```

`<run-ref>` accepts a run id, `latest`, or `previous`. The command resolves the run directory, finds the recorded run video, and calls `vidtrace clip cut` to produce one named clip per `--label`.

### Labels

Each `--label` is `name=start-end` in `MM:SS` (or `HH:MM:SS`). The clip is named `<prefix>-<name>.<ext>` and moved into the run dir's `videos/clips/` (or `--out`), plus written to a clips manifest.

### Flags

| Flag | Effect |
|---|---|
| `--label <label=start-end>` | clip label with start/end timestamps (repeatable, required) |
| `--out <dir>` | clip output directory (default `run/videos/clips`) |
| `--name <prefix>` | clip filename prefix |
| `--reencode` | re-encode clips instead of stream-copy (slower, needed for some codecs) |
| `--stash` | stash the run directory to fcheap after cutting clips |
| `--tag <tag>` | tag for the stash (repeatable) |
| `--artifact-root <path>`, `--config <path>` | resolution overrides |

At least one `--label` is required. With `--stash`, the enriched run directory (now containing the clips) is stashed to fcheap and the `stashId` is returned in the result.

### Result

```jsonc
{
  "runId": "login-2026-...",
  "runDir": "run/login-2026-...",
  "sourceVideo": "run/login-2026-.../videos/playwright.mp4",
  "outputDir": "run/login-2026-.../videos/clips",
  "clips": { "failure": "login-failure-0:12-0:18.mp4" },
  "stashId": "fcheap-..."   // only with --stash
}
```

## When to clip

- **A failing run you want to show a teammate** — clip the seconds around the failure, stash, and share the clip. Smaller than the full video; self-contained.
- **A regression reel** — clip the same label across several stashed runs and stitch them in vidtrace.
- **A PR review** — clip the interaction the spec covers so a reviewer sees the behavior, not just the green check.

## Prerequisites

- A recorded run video. Clips need `artifacts.capture.video` enabled (or `--backend playwright` with video on) at run time. Without a video, `clip` reports `sourceVideo` missing.
- `vidtrace` on `$PATH`. `cairn doctor` flags it; install via the maintainer's tap.

## See also

- [Artifacts](/artifacts) — `videos/` and `frames/` (the source `clip` reads)
- [Stash](/stash) — the `--stash` post-clip handoff
- [Doctor & clean](/doctor) — the `vidtrace` availability check