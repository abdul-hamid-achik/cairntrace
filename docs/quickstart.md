---
title: 'Cairntrace Quickstart: Run Your First Browser Spec'
description: Install Cairntrace with Homebrew or npm, add a browser driver, and run your first browser check that confirms a page behaves as a user expects.
---

# Quickstart

Cairntrace checks that a web page does what a user expects, in a real browser, and saves the evidence so a coding agent can read what failed. This page installs it, then runs one ready-made check against a small demo app.

## Prerequisites

- [Bun](https://bun.sh/) 1.3 or newer. Homebrew installs it for you. With npm, Bun must already be on your `PATH`, because the `cairn` command runs on Bun.
- A browser driver: [`agent-browser`](https://agent-browser.dev/) (the default) or Playwright Chromium.
- Git, and a clone of this repository, only for the demo app in step 3.

## 1. Install Cairntrace

::: code-group

```bash [Homebrew]
brew install abdul-hamid-achik/tap/cairntrace
cairn --version
```

```bash [npm]
npm install -g @thelacanians/cairntrace
cairn --version
```

```bash [From source]
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
bun install
./bin/cairn --version
```

:::

The source path needs no build step. Cairntrace runs directly through its Bun launcher. In the rest of this page, `cairn` means `./bin/cairn` when you work from the clone.

## 2. Install a browser driver and check the setup

Cairntrace uses `agent-browser` by default:

```bash
brew install vercel-labs/agent-browser/agent-browser
agent-browser --version
```

Playwright is optional. Use it if you want the `--backend playwright` option or Playwright traces. Install its Chromium with `bunx playwright install chromium`.

Then check that everything Cairntrace needs is visible from your shell:

```bash
cairn doctor
```

If `doctor` reports a missing tool, confirm the tool runs in the same shell and that its install directory is on your `PATH`. For Playwright, `doctor` reports the package and the Chromium browser separately: `playwright-package` (in a clone, run `bun install`; for a Homebrew or npm install, reinstall Cairntrace) and `playwright-chromium` (run `bunx playwright install chromium`).

## 3. Start the demo app

The demo app and the example spec live in the repository's `examples/` folder. They are not part of the npm package, so this step needs a clone, whichever way you installed `cairn`. If you installed from source in step 1, you already have the clone: skip the `git clone` and `bun install` lines and run only `bun examples/demo-app/server.ts` from that checkout.

```bash
git clone https://github.com/abdul-hamid-achik/cairntrace
cd cairntrace
bun install
bun examples/demo-app/server.ts
```

The app listens on `http://localhost:8787`. Leave it running and open a second terminal in the same clone for the next steps.

## 4. Read the browser contract

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

## 5. Verify, then replay from a clean browser

From the repository root, in the second terminal:

```bash
cairn spec verify examples/flows/01-dashboard-nav.yml --json
cairn run examples/flows/01-dashboard-nav.yml --cold-start --json
```

The verifier checks the schema and contract hash before the run. `--cold-start` clears the browser profile first, so the pass does not depend on leftover session state.

To watch the browser, add `--headed`. To exercise only the command plumbing without a browser, use `--mock`.

## 6. Inspect the evidence

```bash
cairn context latest
cairn context latest --path
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

## Connect your agent

Cairntrace also runs as an MCP server, so an MCP-aware coding agent can write, run, and read specs with the same tools you just used. You don't run `cairn mcp` yourself. You register it as a stdio server in your MCP client, which starts it when the client needs it. For Claude Code:

```bash
claude mcp add cairntrace -- cairn mcp
```

A from-source install (a clone with `bun install`) puts no `cairn` on your `PATH`, so register the absolute path to the launcher instead, for example `claude mcp add cairntrace -- /path/to/cairntrace/bin/cairn mcp`.

See [MCP server](/mcp) for other clients.

## Where to go next

- [Authoring contracts](/authoring) — write outcomes that survive UI changes.
- [Discovery sessions](/discover) — explore a live page and record interactions before exporting a spec.
- [Journey briefs](/brief) — hand a passing spec to a harness when locators miss in another environment.
- [Steps](/steps) and [verifiers](/verifiers) — learn the typed vocabulary.
- [MCP server](/mcp) — give an MCP-aware coding agent the same author, run, and evidence loop.
