---
title: 'Cairntrace Quickstart: Run Your First Browser Spec'
description: Install Cairntrace from source, verify a real YAML browser spec, run it from a fresh browser session, and inspect the agent-ready evidence.
---

# Cairntrace quickstart

Go from clone to a passing behavioral browser spec against Cairntrace's tiny demo app. The walkthrough uses the checked-in flow so the first thing you run is also the thing the project maintains.

## Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer.
- [`agent-browser`](https://agent-browser.dev/) on your `PATH` for the default real-browser backend.
- Git.

You can use Playwright instead, but the commands below follow the default agent-browser path.

## 1. Clone and install

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
bun install
./bin/cairn doctor
```

Cairntrace runs directly through its Bun launcher. There is no compile step and it is not published to npm.

## 2. Start the demo app

In your first terminal:

```bash
bun examples/demo-app/server.ts
```

The app listens on `http://localhost:8787`. Leave it running for the next steps.

## 3. Read the browser contract

The checked-in `examples/flows/01-dashboard-nav.yml` is a complete current-schema spec:

```yaml
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
      url: { endsWith: /dashboard.html }

  - id: dashboard_heading_visible
    description: the page shows the Dashboard heading
    verify:
      text: { contains: Dashboard }

  - id: no_console_errors
    description: the navigation produced no console errors
    verify:
      console: { errorsMax: 0 }

steps:
  - id: open_home
    open: http://localhost:8787/
  - id: click_open_dashboard
    click: { by: role, role: link, name: Open dashboard }
  - id: wait_for_dashboard
    wait: { text: Dashboard, timeoutMs: 5000 }
```

`intent + outcomes` are the durable behavior contract. The steps are the repairable path used to reach it.

## 4. Verify, then replay from a clean browser

In a second terminal, from the repository root:

```bash
./bin/cairn spec verify examples/flows/01-dashboard-nav.yml --json
./bin/cairn run examples/flows/01-dashboard-nav.yml --cold-start --json
```

The verifier checks the schema and contract hash before the run. `--cold-start` clears the browser profile first, so the pass does not depend on leftover session state.

To watch the browser, add `--headed`. To exercise only the command plumbing without Chrome, use `--mock`.

## 5. Inspect the evidence

```bash
./bin/cairn context latest
./bin/cairn context latest --path
```

Every run writes a self-contained artifact pack under `~/.cairntrace/runs/`, including:

```text
report.html          human-readable, shareable run report
report.json          structured result for tools and CI
agent_context.md     focused handoff for the next coding agent
outcomes/            one evidence file per promised outcome
snapshots/           accessibility state captured during the run
screenshots/         visual evidence when the capture policy requests it
console/             browser console messages and errors
network/             observed requests and failures
services/            bounded service logs when services are configured
replay.json          the exact replay manifest
```

Humans can open the HTML report. Agents start with `agent_context.md`. CI can consume JSON or JUnit.

## Where to go next

- [Authoring contracts](/authoring) — write outcomes that survive UI changes.
- [Discovery sessions](/discover) — explore a live page and record interactions before exporting a spec.
- [Steps](/steps) and [verifiers](/verifiers) — learn the typed vocabulary.
- [MCP server](/mcp) — give an MCP-aware coding agent the same author, run, and evidence loop.
