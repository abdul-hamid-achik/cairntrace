---
layout: home

hero:
  name: Cairntrace
  text: Behavioral browser-spec layer for coding agents
  tagline: Specs declare intent + outcomes as the behavior contract and steps as repairable hints. Run them in-session from any agent harness.
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: Authoring Guide
      link: /authoring
    - theme: alt
      text: View on GitHub
      link: https://github.com/abdul-hamid-achik/cairntrace

features:
  - title: intent + outcomes contract
    details: The behavior contract is the durable thing. Steps are repairable hints agents and humans can rewrite without changing what “success” means.
  - title: Agent-browser first
    details: Default backend is agent-browser so your spec runs inside an existing agent session. Playwright is a drop-in for browser-only CI.
  - title: Semantic locators
    details: Strict role/label/text matchers with `exact:` and `nth:` overrides. Zero matches fail loud; multiple matches error unless opted in.
  - title: Cold-start contract
    details: Every spec must replay from a fresh browser session — via login actions, captured checkpoints, or precondition commands.
  - title: Stable artifact format
    details: report.html, agent_context.md, outcomes/*.md with sidecars, screens/, network/, console/, spec.resolved.yml — no agent coupling.
  - title: Repair + flaky detection
    details: Failure analysis emits step-rewrite proposals. Repeated runs are divergence-tracked so a passing flaky suite can’t pretend to be green.
---
