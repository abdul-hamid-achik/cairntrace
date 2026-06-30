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

A `step` is an instruction a code generator (you) or a runtime (cairn) might rewrite without changing the contract. Steps must use the typed step vocabulary too (`open`, `wait`, `click`, `hover`, `fill`, `type`, `press`, `scroll`, `upload`, `download`, `transform`, `request`, `snapshot`, `use`, `batch`, `eval`, `monitor`). Free-form prose inside an `eval:` step is allowed, but if you find yourself reaching for it, stop and ask whether one of the typed steps already encodes the intent.

The same locator philosophy that drives `playwright` should drive cairn: prefer semantic locators (`by: role|label|text`), fall back to `data-testid`, and only touch CSS/XPath when nothing else survives.

```yaml
steps:
  - open: { path: "/settings" }
  - click: { by: { role: tab, name: "API tokens" } }
  - click: { by: { role: button, name: "Rotate token" } }
  - click: { by: { role: button, name: "Yes, rotate" } }
```

## Cold-start is not optional

Every spec must satisfy the **cold-start contract**: replayable from a fresh browser session. Three supported paths, pick one:

1. `imports: [actions/login.yml]` + `steps: [{ use: login }]` — reuse an action file.
2. `session: { resume: <checkpoint> }` — capture a logged-in state once with `cairn checkpoint capture-from-session` and resume it.
3. `preconditions: { commands: [{ run: "..." }] }` — set up state from the shell.

There is no fourth path that "just works because my dev session is logged in." A spec that only runs in dev is a spec that does not run.

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

When a run fails, the artifacts include `agent_context.md`, `outcomes/*.md`, `diagnostics/failure.md`, and the raw `console/`, `network/`, `screens/final.txt`, and `frames/frames.ndjson`. The repair engine reads those and proposes step rewrites that preserve the contract hash.

The repair proposal is a suggestion, not an approval. Open the diff, check that the contract is unchanged, and apply only what keeps the behavior intact. If the diff touches `intent` or `outcomes`, that is *not* a repair; that is a contract change, and the hash must be re-stamped.

## A checklist before you call a spec done

- `cairn explain --format json` — surface-level sanity check.
- `cairn docs <topic> --format json` for focused authoring reminders.
- `cairn spec verify my-spec.yml --format json` — schema, contract hash, dead links.
- `cairn run my-spec.yml --cold-start --format json` — single golden run from a fresh browser.
- `cairn docs snippets --format md` — to lift reusable `actions/*.yml` files.

If `cairn run` passes once on `cold-start`, paste the harness command into your project README. The next agent that touches that flow will thank you.
