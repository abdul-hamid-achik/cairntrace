---
title: "Cairntrace vs Playwright MCP, Playwright test agents, Chrome DevTools MCP, Stagehand, browser-use and hosted AI QA"
description: "How Cairntrace differs from Playwright MCP, Playwright test agents, Chrome DevTools MCP, Stagehand, browser-use and hosted AI QA tools, with sources."
---

# Cairntrace vs the alternatives

Cairntrace stores a browser behavior as a YAML spec: `intent` and `outcomes` are the contract, and `steps` are repairable hints for reaching the state. The contract hash is a sha256 over the canonical JSON of `intent` and `outcomes` only, so a spec keeps the same definition of done after the session that wrote it. `cairn spec heal` rewrites locator fields on the failing step (and can insert a wait step); it does not edit `intent`, `outcomes` or verifier expectations, and a changed contract is refused with exit code 6. Every run writes local evidence (`report.html`, `agent_context.md`, screenshots, console and network logs) that a coding agent can read after a failure. The browser is driven by `agent-browser` (the default) or Playwright Chromium. The same spec runs from the CLI or the MCP server, and `cairn export playwright` turns it into `@playwright/test` files for CI. For a live example, see [/examples](/examples); to try it, see [/quickstart](/quickstart).

## At a glance

| Tool | What it is | Persists a test after the session? | Fixed definition of done | Agent-readable failure evidence | Drift repair | Runs locally or hosted | License / pricing (as stated by source) |
|---|---|---|---|---|---|---|---|
| **Cairntrace** | Browser behavioral specs (YAML) run by a CLI and MCP server | Yes: a spec file in your repo | Yes: contract hash over `intent` + `outcomes` | `report.html`, `agent_context.md`, screenshots, console, network | `cairn spec heal` patches locator fields; `--verify` keeps a fix only if a rerun passes | Local (agent-browser or Playwright) | MIT (`package.json`); no pricing |
| **Playwright MCP** | MCP server that drives Playwright through accessibility snapshots | Not stated | Not stated | Accessibility snapshots returned to the model | Not stated (the README names self-healing tests as a use case) | Local (`npx`, per the README) | Apache-2.0 (GitHub page); pricing not stated |
| **Playwright test agents** | Planner, generator and healer agents that write Playwright Test files | Yes: generated files under `tests/` | Not stated | Not stated | Healer "automatically repairs failing tests" | Local, in your project | Not stated on the page |
| **Chrome DevTools MCP** | MCP server (and CLI) that controls and inspects a live Chrome | Not stated | Not stated | Performance traces and insights, debugging data | Not stated | Local Chrome | Apache-2.0 (GitHub page); pricing not stated |
| **Stagehand** | SDK for browser agents (`act`, `observe`, `extract`) | Code you write | Not stated (`extract` returns schema-validated data) | Not stated | `act`, `observe` and `extract` "refresh how an action happens when the site changes" (README "Self-healing") | Local browser or Browserbase-hosted browser (README examples) | MIT (GitHub page); pricing not stated |
| **browser-use** | Open-source browser agent (Python and TypeScript) plus a hosted cloud | Not stated | Not stated | Not stated | Not stated | Open source, plus cloud browsers and a hosted agent API | MIT (Python library, per README); README: "$0.02 per browser-hour cloud browser" |
| **TestSprite** | Agentic testing tool that writes E2E tests and runs them on a live app | Yes: keeps everything that passed | Not stated | One self-consistent bundle: the failing step and its neighbors, screenshots, DOM snapshots, the test source, a root-cause hypothesis, and a recommended fix | "Auto-Heal repairs tests when the UI drifts" | Cloud ("on our machines, not yours"); driven from a CLI, an MCP server, CI or a dashboard | "Open-source CLI, free tier included" (page description) |
| **Momentic** | "The agentic quality platform": Mo, "an AI QA engineer", writes YAML tests run by a CLI | Yes: YAML test files in your repository | Not stated | Inspect the failing step, screenshots, and traces; failures classified as app bug, flakiness or environment | AI triage and auto-heal; "Permanent healing proposes a test-file repair for you to review" | CLI runs locally and in CI | "Free to start, no credit card" (page) |
| **QA Wolf** | "The AI Test Factory": "agents, infrastructure, and experts for creating, running, and maintaining E2E tests" | Yes: maintained suites | Not stated | Not stated | "Maintaining" tests (mechanism not stated) | Not stated | Not stated |

"Not stated" means the page we checked does not say. Check the source before relying on it.

## Playwright MCP

**Use Playwright MCP when** you want a general-purpose browser tool for an MCP client, and the agent should explore and act on pages without a test artifact. Its README says it "enables LLMs to interact with web pages through structured accessibility snapshots," and notes that for some coding-agent workflows a Playwright CLI with skills may fit better.

**Use Cairntrace when** the result must outlive the session: a spec file that replays later, a contract that cannot be silently edited, and a report a reviewer or CI can read. Playwright MCP does not describe a durable spec or a fixed definition of done.

## Playwright test agents

**Use Playwright test agents when** you want Playwright to plan, generate and repair `@playwright/test` files inside your project. The page describes a planner that writes a Markdown plan, a generator that writes test files and "verifies selectors and assertions live," and a healer that "executes the test suite and automatically repairs failing tests." That is a strong fit if you are already committed to Playwright Test.

**Use Cairntrace when** you want the spec, not the generated test code, to be the source of truth. Cairntrace can export a spec to Playwright (`cairn export playwright`), and the contract hash keeps `intent` and `outcomes` fixed when heal runs. Be aware that Cairntrace's heal only patches locators on `click`, `hover`, `focus`, `fill`, `select`, `upload` and `download` steps, so a failing `expect` step is not healed and needs a manual fix; `--verify` checks the rerun before a fix is kept.

## Chrome DevTools MCP

**Use Chrome DevTools MCP when** the agent needs to inspect a live Chrome: performance traces, network and console data, and debugging. Its README lists "performance insights" as a key feature.

**Use Cairntrace when** you need a pass/fail acceptance check of a user flow that stays in the repo. Chrome DevTools MCP is an inspection tool; it does not describe a persisted spec or a contract.

## Stagehand

**Use Stagehand when** you are writing a browser agent or scraper in TypeScript, Python or Go and want natural-language `act`, `observe` and schema-validated `extract` calls inside your own program. Its README shows `act()` "self-heals when the site redesigns its form," runs against a local browser or a Browserbase-hosted one, and it is MIT licensed.

**Use Cairntrace when** the goal is a regression check that a reviewer can read and a coding agent can rerun. Cairntrace specs are declarative YAML with a contract hash, not imperative code, and each run produces a report.

## browser-use

**Use browser-use when** you want an open-source agent that plans its own browser actions, or a hosted agent API and cloud browsers. Its README describes "Browser Use is the open-source browser agent (Python and TypeScript)," with "a $0.02 per browser-hour cloud browser with stealth, CAPTCHA solving and residential proxies."

**Use Cairntrace when** the browser work is a check, not a task. An agent-driven task can succeed differently each run; a Cairntrace spec is checked against the same `outcomes` every run.

## TestSprite

**Use TestSprite when** you want a hosted service to write end-to-end tests from a URL and run them after every change. Its page says it "writes end-to-end tests, runs them on your live app after every change, and tells you exactly what broke," and that its failure bundle includes "a root-cause hypothesis, and a recommended fix." If you want someone else to author and maintain the suite, this is the category to look at.

**Use Cairntrace when** you want the spec to be a file you own in git, runs that happen on your machine, and a contract whose hash is fixed. TestSprite's page says test runs happen in its cloud ("on our machines, not yours"). Its evidence bundle is a real overlap with Cairntrace's report, so the difference is where the spec lives and where it runs.

## Momentic

**Use Momentic when** you want a QA platform with YAML flows, a CLI for local and CI runs, and AI triage that proposes repairs for review. Its page calls Momentic "the agentic quality platform" and Mo "an AI QA engineer," and says "Run the same tests in CI before the next merge or deploy," and "AI triage investigates the cause and proposes a test repair for you to review."

**Use Cairntrace when** you want the repair to be a deterministic locator patch that you can rerun (`--verify`), the contract to be a hash, and the evidence to be a local report for coding agents.

## QA Wolf

**Use QA Wolf when** you want a managed service with "agents, infrastructure, and experts for creating, running, and maintaining E2E tests." Its page description says it "autonomously maps, writes, and runs flake-free E2E tests for web and mobile apps with 100% parallel execution."

**Use Cairntrace when** you want to keep the suite in your repository, run it on your machine or your CI, and read the evidence yourself. The QA Wolf page does not say how it stores or runs tests locally.

## agent-browser is a backend, not a competitor

[agent-browser](https://agent-browser.dev) is the default browser driver that Cairntrace uses. Cairntrace adds the spec contract, the heal rules, the evidence pack and the MCP surface on top of it. Playwright Chromium is the other backend (`--backend playwright`). If you already use agent-browser for agent sessions, Cairntrace runs the same browser as a durable check.

## Sources (checked 2026-10-14)

- https://github.com/microsoft/playwright-mcp
- https://playwright.dev/docs/test-agents
- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/browserbase/stagehand
- https://github.com/browser-use/browser-use
- https://www.testsprite.com
- https://momentic.ai
- https://www.qawolf.com
- https://agent-browser.dev
