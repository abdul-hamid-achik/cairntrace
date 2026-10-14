---
title: Example Runs and Specs
description: Real Cairntrace runs against the demo app, one failing with a locator not found and one passing, with the reports, agent context, spec YAML, CLI output and the other example flows.
---

# Example runs and specs

These are real runs of two specs against the demo app in `examples/`, captured with the CLI in this repo. Apart from replacing absolute local paths with `run-dir` or repo-relative paths, nothing here is hand-edited: the reports are the files `cairn` wrote.

- A failing run: [`examples/flows/demos/_06-drifted-link.yml`](#failing-run-the-spec-and-its-output), which clicks a link named "Dashboard link" that the page no longer has.
- A passing run: [`examples/flows/01-dashboard-nav.yml`](#passing-run-the-spec-and-its-output), which follows "Open dashboard" to the dashboard.

## Reports and agent context

Failing run (`drifted_dashboard_nav`):

- <a href="/examples/failing-run/report.html" target="_self">Run report (report.html)</a>
- <a href="/examples/failing-run/agent_context.md" target="_self">Agent context (agent_context.md)</a>
- <a href="/examples/failing-run/report.json" target="_self">Report data (report.json)</a>

Passing run (`dashboard_nav`):

- <a href="/examples/passing-run/report.html" target="_self">Run report (report.html)</a>
- <a href="/examples/passing-run/agent_context.md" target="_self">Agent context (agent_context.md)</a>
- <a href="/examples/passing-run/report.json" target="_self">Report data (report.json)</a>

The trace file of the failing run (about 12 MB) is not published here, so the Trace link inside that report does not resolve.

## Setup used

The demo app serves on `http://localhost:8787` and needs the demo Postgres from `examples/docker-compose.yaml` (port 5433) seeded with `bun examples/demo-app/db/seed.ts`. `examples/cairntrace.config.yml` can start both for you (`webServer` and `services`). The runs below were started with the app and database already up, so they used `--no-services --no-web-server`.

```bash
bun examples/demo-app/server.ts
./bin/cairn run examples/flows/demos/_06-drifted-link.yml --cold-start --no-services --no-web-server
./bin/cairn run examples/flows/01-dashboard-nav.yml --cold-start --no-services --no-web-server
./bin/cairn spec heal examples/flows/demos/_06-drifted-link.yml
```

`spec heal` was run without `--apply`, so the example spec was not changed.

## Failing run: the spec and its output

The spec, copied from `examples/flows/demos/_06-drifted-link.yml`:

```yaml
# Cairntrace example spec — selector drift, healed by `cairn spec heal`.
#
# This spec is INTENTIONALLY broken: the click locator uses name="Dashboard link",
# but the real page has a link named "Open dashboard". Running it fails with a
# locator-not-found error.
#
# Then run:
#   ./bin/cairn spec heal examples/flows/demos/_06-drifted-link.yml
# to see Cairntrace inspect the snapshot and propose:
#   replace /steps/1/click/name  from "Dashboard link"  to "Open dashboard"
#
# Add --apply to write the fix back to the file (comments preserved), then re-run
# with `cairn run examples/flows/demos/_06-drifted-link.yml` to confirm it passes.
#
version: 1
name: drifted_dashboard_nav
intent: navigate to dashboard via a renamed link (simulates UI drift)
environment: local
preconditions:
  commands:
    - run: "echo demo-app must be running on :8787"
outcomes:
  - id: url_is_dashboard
    description: after clicking, URL ends with /dashboard.html
    verify:
      url:
        endsWith: /dashboard.html
steps:
  - id: open_home
    open: http://localhost:8787/
  - id: click_link
    click:
      by: role
      role: link
      name: Dashboard link
```

`cairn run` output (narration on stdout, then the Markdown summary):

````text
[06:23:15] run start: drifted_dashboard_nav (env=local, backend=agent-browser)
[06:23:15] run dir: run-dir
[06:23:15] precondition precondition[0] started (budget 2m 0s)
[06:23:15] precondition precondition[0] ok 5ms
[06:23:24] step open_home passed 943ms
[06:23:35] step click_link failed 10.4s
  element not found: could not resolve role=link name="Dashboard link" for click within 10000ms
matching candidates (6):
  - link "Open dashboard" ref=e3
  - link "Products" ref=e4
  - link "Documents"…
[06:23:36] outcomes: evaluating 1
[06:23:36] outcome url_is_dashboard verifying…
[06:23:36] outcome url_is_dashboard failed
  expected: URL endsWith "/dashboard.html"
  actual:   URL was "http://localhost:8787/"
# Run: drifted_dashboard_nav — FAILED

- env: local | backend: agent-browser | cold-start: yes
- duration: 20.7s | outcomes: 0/1 passed
- run id: 2026-10-14T06-23-15-696Z_drifted_dashboard_nav_4144de
- reason: element not found: could not resolve role=link name="Dashboard link" for click within 10000ms matching candidates (6): - link "Open dashboard" ref=e3 - link "Products" ref=e4 - link "Documents" ref=e5 - link "Form controls" ref=e6 - link "Vendor profile" ref=e7 - link "Sign in" ref=e8

## Outcomes
- ✗ url_is_dashboard → outcomes/url_is_dashboard.md

## Steps
- ✓ open_home (943ms)
- ✗ click_link (10.4s) — element not found: could not resolve role=link name="Dashboard link" for click within 10000ms
matching candidates (6):
 …

## Reproduce
```bash
cairn run examples/flows/demos/_06-drifted-link.yml --env local
```

Run dir: run-dir
Agent context: run-dir/agent_context.md
````

The reproduce line is shortened to a repo-relative path from the checkout root.

`cairn spec heal` output for the same spec (a separate run, no `--apply`):

```text
[06:23:42] run start: drifted_dashboard_nav (env=local, backend=agent-browser)
[06:23:42] run dir: run-dir
[06:23:42] precondition precondition[0] started (budget 2m 0s)
[06:23:42] precondition precondition[0] ok 6ms
[06:23:44] step open_home passed 223ms
[06:23:54] step click_link failed 10.5s
  element not found: could not resolve role=link name="Dashboard link" for click within 10000ms
matching candidates (6):
  - link "Open dashboard" ref=e3
  - link "Products" ref=e4
  - link "Documents"…
[06:23:55] outcomes: evaluating 1
[06:23:55] outcome url_is_dashboard verifying…
[06:23:55] outcome url_is_dashboard failed
  expected: URL endsWith "/dashboard.html"
  actual:   URL was "http://localhost:8787/"
# Heal: examples/flows/demos/_06-drifted-link.yml
Status: patch-proposed
Outcomes still reachable: yes
Based on run: run-dir

▸ patch proposed (re-run with --apply to write)

proposed 1 op(s) on examples/flows/demos/_06-drifted-link.yml; pass --apply to write

## Proposed ops (1)

- **insert** `/steps/1`
  - value: {"id":"wait_for_dashboard_link","wait":{"text":"Dashboard link","timeoutMs":5000}}
  - why:  no name candidate matched — insert a wait for "Dashboard link" in case the element appears after async
```

The heal proposal is an inserted wait for "Dashboard link", not the rename to "Open dashboard" that the spec's header comment describes. The candidates list shows the rename would be the fix. Heal output can differ from the comment, so check the proposal before applying it.

## Passing run: the spec and its output

The spec, copied from `examples/flows/01-dashboard-nav.yml`:

```yaml
# Cairntrace example spec — navigation + URL/text outcomes
#
# Demonstrates: open → click → wait → URL outcome + text outcome.
# Run against the demo app served at http://localhost:8787 (see examples/README.md).
#
version: 1
name: dashboard_nav
intent: from the home page, follow "Open dashboard" and land on a working dashboard
environment: local
preconditions:
  commands:
    - run: "echo demo-app must be running on :8787"
outcomes:
  - id: url_is_dashboard
    description: after clicking the link, URL ends with /dashboard.html
    verify:
      url:
        endsWith: /dashboard.html
  - id: dashboard_heading_visible
    description: the page shows the "Dashboard" heading
    verify:
      text:
        contains: Dashboard
  - id: no_console_errors
    description: the navigation produced no console errors
    verify:
      console:
        errorsMax: 0
steps:
  - id: open_home
    open: http://localhost:8787/
  - id: click_open_dashboard
    click:
      by: role
      role: link
      name: Open dashboard
  - id: wait_for_dashboard
    wait:
      text: Dashboard
      timeoutMs: 5000
```

`cairn run` output:

```text
[06:23:38] run start: dashboard_nav (env=local, backend=agent-browser)
[06:23:38] run dir: run-dir
[06:23:38] precondition precondition[0] started (budget 2m 0s)
[06:23:38] precondition precondition[0] ok 4ms
[06:23:39] step open_home passed 247ms
[06:23:40] step click_open_dashboard passed 875ms
[06:23:41] step wait_for_dashboard passed 201ms
[06:23:41] outcomes: evaluating 3
[06:23:41] outcome url_is_dashboard verifying…
[06:23:42] outcome url_is_dashboard passed
[06:23:42] outcome dashboard_heading_visible verifying…
[06:23:42] outcome dashboard_heading_visible passed
[06:23:42] outcome no_console_errors verifying…
[06:23:42] outcome no_console_errors passed
# Run: dashboard_nav — PASSED

- env: local | backend: agent-browser | cold-start: yes
- duration: 4.2s | outcomes: 3/3 passed
- run id: 2026-10-14T06-23-38-052Z_dashboard_nav_68a219

## Outcomes
- ✓ url_is_dashboard → outcomes/url_is_dashboard.md
- ✓ dashboard_heading_visible → outcomes/dashboard_heading_visible.md
- ✓ no_console_errors → outcomes/no_console_errors.md

## Steps
- ✓ open_home (247ms)
- ✓ click_open_dashboard (875ms)
- ✓ wait_for_dashboard (201ms)
```

## Other example flows

Every flow in `examples/flows/` runs against the demo app. Files starting with `_` (in `demos/`) are intentionally failing and are not part of the passing set.

- `02-row-count.yml`: counts the inventory table rows (exactly 3) and checks that no request failed.
- `03-network.yml`: checks that the page calls `/api/inventory` and gets a 2xx response.
- `04-script.yml`: uses a page-evaluated script to assert that exactly 3 `[data-item]` elements exist after a fetch.
- `07-config-driven.yml`: opens the dashboard through relative paths resolved from the environment `baseUrl`.
- `08-conditional-step.yml`: control flow with `if`, `repeat` with `until`, optional waits and `when` gates.
- `10-artifact-xlsx.yml`: downloads a workbook template, checks it with the `xlsx` verifier, and rejects a transformed invalid upload.
- `11-batch-hover-click.yml`: runs a hover and a click as one `batch` step so a hover-revealed button is acted on in one invocation.
- `12-focus-value.yml`: focuses a control, types into it and waits for its exact live value, without `eval`.
- `13-widgets-form.yml`: fills custom form controls on `/widgets.html` with the widget steps (`form`, `choose`, `check`, optional clicks).
- `demos/_05-detects-broken-api.yml`: fails by design; its `noFailedRequests` outcome is meant to surface the 500 from `/api/broken`.
- `demos/_09-imported-drift.yml`: fails by design; a stale locator sits in the imported `examples/actions/open_dashboard.yml`, so heal should patch the action file, not the spec.
- `platform/20-login-journey.yml` to `platform/33-export-workbook.yml`: the platform flows against the Postgres-backed app: sign-in, catalog, product create and duplicate SKU, document upload and preview, CSV/XLSX exports, API session and API login, form controls, auth redirect, async restock job, `run:`/`teardown:` provisioning and the workbook `xlsx` check.
