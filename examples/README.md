# Examples

Smoke pack against a tiny local static app. Used both as documentation
and as Cairntrace's end-to-end integration sanity check against a real
[`agent-browser`](https://agent-browser.dev) install.

## Layout

```
examples/
├── README.md                          (this file)
├── demo-app/
│   ├── index.html                     home page with an "Open dashboard" link
│   ├── dashboard.html                 inventory table with 3 rows
│   ├── api.html                       page that fetches /api/inventory and renders items
│   ├── api-broken.html                page that fetches /api/broken (returns 500)
│   ├── import.html                    workbook download/upload demo
│   ├── table-actions.html             hover-reveal row actions (batch step demo)
│   └── server.ts                      bun server on :8787 with static + JSON routes
├── transforms/
│   └── make-invalid-template.ts       Node transform that creates an invalid upload fixture
├── verifiers/
│   └── check-template-xlsx.ts         Node verifier that reads a downloaded workbook artifact
└── flows/
    ├── 01-dashboard-nav.yml           open → click → URL + text + console outcomes
    ├── 02-row-count.yml               open → count + no-failed-requests outcomes
    ├── 03-network.yml                 network verifier (GET /api/inventory → 200)
    ├── 04-script.yml                  script escape hatch (counts DOM items via JS)
    ├── 05-detects-broken-api.yml      DELIBERATELY failing spec — proves 500 is detected
    ├── 06-drifted-link.yml            DELIBERATELY drifted spec for `cairn spec heal` demo
    ├── 07-config-driven.yml           uses cairntrace.config.yml for baseUrl + ${vars.X}
    ├── 08-conditional-step.yml        demonstrates when: urlContains:/login step skipping
    ├── 09-imported-drift.yml          drift inside an imported action; heal patches the action file
    ├── 10-artifact-xlsx.yml           download → Node verifier → xlsx verifier → transform → upload
    └── 11-batch-hover-click.yml       batch step: hover → click a popover in one invocation
```

## Heal demo (`cairn spec heal`)

`06-drifted-link.yml` ships with a locator that doesn't match the page (it asks
for `link "Dashboard link"` when the real page has `link "Open dashboard"`).

```bash
# 1. Confirm the spec fails as-shipped
./bin/cairn run examples/flows/06-drifted-link.yml

# 2. Ask Cairntrace to propose a fix from the snapshot
./bin/cairn spec heal examples/flows/06-drifted-link.yml

# 3. Apply the proposed fix in place
./bin/cairn spec heal examples/flows/06-drifted-link.yml --apply

# 4. Re-run — the spec now passes
./bin/cairn run examples/flows/06-drifted-link.yml
```

`spec heal` runs the spec, parses the accessibility-tree snapshot agent-browser
captured at the failing step, finds the closest role+name candidate, and emits
a JSON-Pointer patch op. Output is available in `--format json|yaml|md`.

v0 scope: only the `by: role` locator's `name` field is healed; multi-step
drift, role swaps, and wait insertions aren't yet attempted. Comments and
formatting in the YAML are preserved by `--apply` (uses the `yaml` package's
`parseDocument` API).

## Prerequisites

- `bun` (1.3+)
- `agent-browser` on `$PATH` (`cairn doctor` will tell you if it's missing)
- This repo installed: `bun install`

## Run it

1. **Start the demo app** (in one terminal):

   ```bash
   bun examples/demo-app/server.ts
   ```

   It listens on `http://localhost:8787`. Override with `PORT=NNNN`.

2. **Run a spec** (in another terminal):

   ```bash
   ./bin/cairn run examples/flows/01-dashboard-nav.yml
   ```

   This drives a real headless Chrome via `agent-browser`. Add `--headed` to see
   the browser, or `--mock` to skip the browser entirely and use the in-memory
   mock backend.

3. **Inspect the artifacts**:

   ```bash
   ./bin/cairn context latest        # agent_context.md printed to stdout
   ./bin/cairn context latest --path # absolute path only
   ```

   The full run directory is at `~/.cairntrace/runs/<run-id>/`:

   ```
   run.json | run.yaml | run.md
   report.html | report.json | report.theme.json
   agent_context.md
   events.ndjson
   outcomes/
     results.json | .yaml | .md
     <outcome-id>.md           (one per outcome, §13b shape)
   snapshots/<step>.txt
   screenshots/<step>.png      (on failure or when always-on)
   console/console.ndjson, errors.ndjson
   network/requests.ndjson, failed_requests.ndjson
   downloads/<file>
   transforms/<file>
   spec.resolved.yml
   ```

## Try a failing run

Edit `01-dashboard-nav.yml`'s `url_is_dashboard` outcome to expect something the
page doesn't satisfy (e.g. `endsWith: /never`). Re-run. The run exits with code
1, the markdown summary shows `FAILED`, and `outcomes/url_is_dashboard.md`
contains the Expected/Actual evidence.

## What this exercises

- **Backend integration** — real `agent-browser` CLI invocations through
  `AgentBrowserAdapter`, including the semantic `find role link click` mapping,
  `wait --text` waits, and the `{success, data, error}` JSON envelope from
  `network requests --json` / `console --json` / `errors --json`.
- **Outcome vocabulary v0** — the browser-focused verifiers plus artifact
  verifiers are exercised across the specs: `text`, `notText` (implicitly via
  wait), `url`, `count`, `console.errorsMax`, `network`, `noFailedRequests`,
  browser `script`, Node `script`, and `xlsx`.
- **Artifact pack** — every artifact category gets written (JSON+YAML+MD trio,
  evidence files, events, snapshots, console, network, downloads, transforms,
  verifier `.raw.json` sidecar).
- **Exit codes** — passing runs return 0; spec 05 returns 1 by design to
  confirm failure detection.
- **Interactive DX** — in a real terminal, `cairn run` streams per-step ✓/✗
  markers as they happen, with a slim summary at the end. JSON/YAML modes stay
  silent during the run for clean machine output.

The example specs are intentionally minimal so you can read them in one
sitting. The real Cairntrace value shows up when an agent authors a spec
against your actual app from a one-line intent — these are smoke tests for the
infrastructure, not workflow examples.
