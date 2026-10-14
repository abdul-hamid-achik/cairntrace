# Cairntrace Run Context

## Run
- spec: dashboard_nav
- env: local
- backend: agent-browser
- status: passed
- cold start: yes
- run id: 2026-10-14T06-23-38-052Z_dashboard_nav_68a219

## Intent
from the home page, follow "Open dashboard" and land on a working dashboard

## Outcome results
- ✓ url_is_dashboard
- ✓ dashboard_heading_visible
- ✓ no_console_errors

## Last successful step
- step: wait_for_dashboard
- duration: 201ms

## Captured artifacts
- network/failed_requests.ndjson
- console/errors.ndjson

## Reproduce
```bash
cairn run examples/flows/01-dashboard-nav.yml --env local --headed
```

## Suggested next steps
- All outcomes passed. If you arrived here from a bug report, double-check that the failing scenario is captured by an outcome.
- If steps failed because of UI drift rather than a real regression, run: cairn spec heal examples/flows/01-dashboard-nav.yml
