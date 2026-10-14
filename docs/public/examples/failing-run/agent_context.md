# Cairntrace Run Context

## Run
- spec: drifted_dashboard_nav
- env: local
- backend: agent-browser
- status: failed
- cold start: yes
- run id: 2026-10-14T06-23-15-696Z_drifted_dashboard_nav_4144de

## Intent
navigate to dashboard via a renamed link (simulates UI drift)

## Outcome results
- ✗ url_is_dashboard — see outcomes/url_is_dashboard.md

## Last successful step
- step: open_home
- duration: 943ms

## Failure evidence
- outcomes/url_is_dashboard.md
- network/failed_requests.ndjson
- console/errors.ndjson
- diagnostics/002_click_link.json
- traces/agent-browser-trace.json

## Reproduce
```bash
cairn run examples/flows/demos/_06-drifted-link.yml --env local --headed
```

## View the trace
- traces/agent-browser-trace.json is Chrome trace-event JSON: open https://ui.perfetto.dev and load the file, or chrome://tracing.

## Brief (failed step)
## Step click_link
Action: click
Goal: Click the link named "Dashboard link"
Authored: role=link name="Dashboard link"
Search approximations (try in order):
1. role link named "Dashboard link"
2. visible text "Dashboard link"
Done when: the authored effect is visible

## Suggested next steps
- Read each failing outcome's evidence file (paths above). Each contains Expected/Actual/Source. Edit code, re-run.
- If steps failed because of UI drift rather than a real regression, run: cairn spec heal examples/flows/demos/_06-drifted-link.yml
