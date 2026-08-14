---
title: Write Durable Browser Specs for Coding Agents
description: Author Cairntrace contracts with typed outcomes, semantic locators, repairable steps, contract hashes, and reliable cold-start browser replay.
---

# Authoring specs that survive

Authoring a cairn spec is closer to authoring a contract than to authoring a test. The contract is the durable thing. Steps are repairable hints. This page is the discipline that makes a spec live across months of code churn instead of weeks.

## The contract first, the steps second

Start every spec with `intent` and `outcomes`, never with steps. `intent` is one sentence describing what the user wants to happen. `outcomes` are the typed observables that confirm it did. Until both are written, the spec has no contract; running it just produces a transcript of whatever the steps happened to do.

```yaml
intent: Search for "spiced chickpeas", filter by category, and see exactly 7 results.
outcomes:
  - id: results-narrowed
    count: { selector: "[data-testid='result-count']", equals: 7 }
  - id: filter-applied
    text: { contains: "category:baking" }
steps:
  - open: { path: "/search?q=spiced+chickpeas" }
  - click: { by: { role: checkbox, name: "Baking" } }
```

If a colleague can delete every `step:` in the file and you can still describe what the spec should prove, the contract is right. If removing `step:` turns the spec into pure prose, the contract is not yet there.

## Outcomes are typed observables

The verifier vocabulary is closed: `text`, `notText`, `url`, `network`, `noFailedRequests`, `console`, `count`, `xlsx`, `file`, `httpJson`, `script`, `process`. If you find yourself wanting a new verb, use `script` with a small JS expression and a `.raw.json` sidecar — never invent a new verifier type, because then every agent has to learn the new vocabulary.

Each outcome must be enforceable from a single page state. Outcomes are not assertions-in-time; they are assertions-on-state. If you need a sequence ("after step 3 the cart is empty, after step 5 it has 3 items"), write two outcomes and pin them to their step.

```yaml
outcomes:
  - id: cart-empty-after-clear
    count: { selector: "[data-testid='cart-count']", equals: 0 }
  - id: cart-three-after-add
    count: { selector: "[data-testid='cart-count']", equals: 3 }
```

## Steps are hints, not scripts

A `step` is an instruction a code generator (you) or a runtime (cairn) might rewrite without changing the contract. Steps must use the typed step vocabulary too (`open`, `wait`, `click`, `hover`, `focus`, `fill`, `type`, `press`, `scroll`, `upload`, `download`, `transform`, `request`, `snapshot`, `use`, `batch`, `eval`, `monitor`). Free-form prose inside an `eval:` step is allowed, but if you find yourself reaching for it, stop and ask whether one of the typed steps already encodes the intent.

The same locator philosophy that drives `playwright` should drive cairn: prefer semantic locators (`by: role|label|text`), fall back to `by: testid` (honors `browser.testIdAttribute`, default `data-testid`), and only touch CSS/XPath when nothing else survives. When a name is repeated on the page (three **Open** buttons), add `near: "the heading a user would look at"` instead of hardcoding an ObjectId or `nth: 0`. After a click that navigates, `wait: { url: { includes: "/connection/" } }` is the typed wait — do not `eval` `location.pathname`.

```yaml
steps:
  - open: { path: "/settings" }
  - click: { by: { role: tab, name: "API tokens" } }
  - click: { by: { role: button, name: "Rotate token" } }
  - click: { by: { role: button, name: "Yes, rotate" } }
```

## Tags for suite selection

Put stable labels on a spec under `metadata.tags`. Agents and humans then run a **subset** of a directory without inventing new folders:

```yaml
metadata:
  feature: checkout-next
  priority: high
  tags:
    - checkout-regression
    - next
    - checkout
```

```bash
# preview which specs match (no browser)
cairn run flows/ --tag checkout --select-only --json

# run every matching spec (AND if you pass multiple --tag)
cairn run flows/ --tag checkout --cold-start --headed
cairn run flows/ --tag next --tag checkout-regression --cold-start
```

Matching is **case-insensitive**. Multiple `--tag` flags mean **AND** (the spec must declare every listed tag). Specs with no `metadata.tags` never match a tag filter.

## Labels, hooks, and A/B stats

Stamp free-form **cohort labels** on every run in an invocation:

```bash
cairn run flows/ --tag checkout \
  --label path=next \
  --label suite=checkout-ab \
  --before 'tools/flip-path.sh next' \
  --cold-start
```

- `--label key=value` (repeatable) is written into each `run.json` as `labels`.
- `--before <shell>` (repeatable) runs **after** services/secrets and **before** the first spec — use it for domain setup (path flips, warmers). Failures abort the run.
- `--after <shell>` (repeatable) runs after all specs and before services teardown; failures are logged, non-fatal.
- `--hook-timeout-ms <ms>` bounds each hook independently (10 minutes by default, 2 hours maximum). Raise it explicitly when a fenced drain/restart has a larger documented wall-clock budget; prefix the hook with `exec` when its cancellation must reach the target process directly.
- `services.seed.postCommands` always run after seed (even when seed is skipped as fresh) — use for fixture ensure scripts.

Aggregate cohorts:

```bash
cairn stats --group-by path --label suite=checkout-ab --baseline legacy --format md
```

Markdown output includes a table, ASCII bar charts (pass rate / duration p50 / optional domain metric), and pairwise deltas. JSON/YAML use schema `urn:cairntrace.dev:stats:v1`. Domain latency is harvested from `outcomes/*.raw.json` when fields like `processingDurationMS` are present.

Keep product-specific scripts (path flip, mongosh fixtures) in the automation project; cairn only orchestrates via hooks + postCommands.

## Cold-start is not optional

Every spec must satisfy the **cold-start contract**: replayable from a fresh browser session. Four supported paths, pick one:

1. `imports: [actions/login.yml]` + `steps: [{ use: login }]` — reuse an action file.
2. `session: { resume: <checkpoint> }` — capture a logged-in state once with `cairn checkpoint capture-from-session` and resume it.
3. `preconditions: { commands: [{ run: "..." }] }` — set up state from the shell.
4. `coldStart: guest` — explicitly acknowledge that a public flow intentionally starts without a session.

Each precondition command is bounded by `timeoutMs` (120 seconds by default). On timeout Cairn
hard-kills the command and its descendant process tree, so a child setup tool cannot survive into
teardown or mutate the next run.

There is no path that "just works because my dev session is logged in." A spec that only runs in dev is a spec that does not run. The guest acknowledgement suppresses the setup lint; it does not skip the required cold-start replay.

## The contract hash exists for a reason

After editing `intent` or `outcomes`, the contract hash changes. If you forget to re-stamp, `cairn run` refuses the spec — by design. To re-stamp:

```bash
cairn spec verify my-spec.yml --stamp
```

You should be running `cairn spec verify --stamp` exactly once per contract change, never zero times and never five times. The hash is meant to be noisy when you skip it.

## Wait steps are bounded

`wait`, `evaluate`, and browser-network calls are all hard-bounded at 30000 ms by default. Override per-step with `timeoutMs` when the app genuinely needs more time. Do not blanket-timeout the whole spec — make the slow step slow, not the spec slow.

For hydration-sensitive first interactions, prefer:

```yaml
- open: { path: "/app", waitUntil: networkidle }
```

over a separate `wait:` step. Two `wait`s in series are how a fast spec turns into a slow one.

## Repairs are first-class

When a run fails, start with `agent_context.md` and `outcomes/*.md`. The run
also retains `events.ndjson`, `console/`, `network/`, per-step files under
`diagnostics/`, and any snapshots, screenshots, trace, or video enabled by the
capture policy. The repair engine reads the structured evidence and proposes
step rewrites that preserve the contract hash.

The repair proposal is a suggestion, not an approval. Open the diff, check that the contract is unchanged, and apply only what keeps the behavior intact. If the diff touches `intent` or `outcomes`, that is *not* a repair; that is a contract change, and the hash must be re-stamped.

## A checklist before you call a spec done

- `cairn explain --format json` — surface-level sanity check.
- `cairn docs <topic> --format json` for focused authoring reminders.
- `cairn spec verify my-spec.yml --format json` — schema, contract hash, dead links.
- `cairn run my-spec.yml --cold-start --format json` — single golden run from a fresh browser.
- `cairn docs snippets --format md` — to lift reusable `actions/*.yml` files.

If `cairn run` passes once on `cold-start`, paste the harness command into your project README. The next agent that touches that flow will thank you.

## When locators will not replay

A green local run and a miss in another environment is not a reason to
weaken `intent` or `outcomes`. Compile a [journey brief](/brief)
(`cairn export brief <spec> --from-run latest`) so a harness can find the
controls. The harness chooses WHERE; fill values stay authored. Prefer
semantic locators and `cairn spec heal` first if the accessibility tree is
the same and only CSS drifted.
