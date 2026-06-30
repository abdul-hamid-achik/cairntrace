# Verifiers

The verifier vocabulary. Every entry under `outcomes:` is a single typed check the runner evaluates against the page state after the last step ran. The vocabulary is closed; do not invent a new verifier — use `script:` for anything that does not fit, with a `.raw.json` sidecar so the artifact format stays uniform.

## Where outcomes are evaluated

After every step, the runner snapshots the DOM, the console, and the network log. Outcomes bind to that snapshot. There is exactly one snapshot per outcome, not a sliding window — outcomes are assertions on state, not in time.

If you need to assert that *between* step 3 and step 5 the cart went from empty to three items, write two outcomes and pin them to their respective steps. Do not write a `cart-changed-during` outcome.

## `text`

Asserts on rendered text in the live DOM. `contains` is the most common; use `equals`, `regex`, or `notText` when you need them.

```yaml
outcomes:
  - id: banner-shown
    text: { contains: "Welcome back" }
  - id: no-error-message
    notText: { contains: "Something went wrong" }
```

The selector is optional. With no selector, the matcher runs over the visible document text, deduped and trimmed. With a selector, it runs over the text content of the matching element.

## `notText`

Negation of `text`. Same matcher shapes (`contains`, `equals`, `regex`).

## `url`

Matches against the current document URL.

```yaml
outcomes:
  - id: navigated-to-thanks
    url: { matches: "/checkout/thanks" }
  - id: stayed-on-cart
    notText: { contains: "/cart" }   # this is wrong — use url:
```

Use `matches` (regex), `equals`, or `startsWith` per your shape. `equals` is exact.

## `network`

Asserts that a network call matching the predicate was observed.

```yaml
outcomes:
  - id: refresh-called
    network: { method: POST, url: { matches: "/api/.*/refresh" } }
  - id: no-private-tokens-leaked
    network: { response: { body: { notContains: "authorization" } } }
```

Outcomes stack with `notText` and `noFailedRequests` for finer control.

## `noFailedRequests`

A boolean outcome that passes only when no network response in the log is in the 4xx or 5xx range. Mandatory for "the user clicked Submit and got a success page" flows; without it, a 500 response on the side that *did not change the visible text* would still produce a green run.

```yaml
outcomes:
  - id: clean-network
    noFailedRequests: true
```

## `console`

Asserts against the captured browser console.

```yaml
outcomes:
  - id: no-react-warnings
    console: { level: warning, count: { equals: 0 } }
  - id: expected-error-logged
    console: { level: error, message: { contains: "deprecated_xyz" } }
```

`level` is one of `log`, `info`, `warn`, `error`, `debug`. `message` matches the rendered console message; use `contains` for substring and `regex` for pattern.

## `count`

Asserts the count of elements matching a selector.

```yaml
outcomes:
  - id: exactly-seven-results
    count: { path: "[data-testid='result']", equals: 7 }
  - id: at-least-one-banner
    count: { path: "[data-testid='banner']", gte: 1 }
```

`equals`, `gte`, `lte`, `gt`, `lt`. With no `path:`, counts the page-default element.

## `xlsx`

Asserts against a downloaded XLSX file. Useful for "the export button produces the right spreadsheet."

```yaml
outcomes:
  - id: export-has-expected-rows
    xlsx: { file: "export.xlsx", sheet: "Sheet1", minRows: 10 }
```

## `file`

Asserts the existence (or absence) of a file in the artifact dir.

```yaml
outcomes:
  - id: screenshot-written
    file: { path: "screenshots/*.png", existsAtLeast: 1 }
```

## `script`

Last-resort verifier. Wrap the predicate in `cairn.run.assert(condition, evidence)` so that the result is a typed `{ ok, evidence }` record.

```yaml
outcomes:
  - id: server-version-pinned
    script:
      run: |
        const r = await fetch("/version").then(r => r.json());
        return cairn.run.assert(r.build === "1.42.0", { build: r.build });
```

`script` outcomes write a `outcomes/<id>.raw.json` sidecar with the full return value so the artifact pack stays self-contained.

## Honesty signals

Two patterns across verifiers:

- `equals: N` for exact counts. If you write `count: { gte: 1 }` for something that should be exactly one, the spec will silently let bugs through. Be exact when you mean exact.
- `contains: "foo"` for partial matches. The matcher is case-sensitive; use `regex: { matches: "Foo.+Bar" }` when you mean "case-insensitive starts with."

## Sidecar artifact shape

```yaml
# Always written for every outcome
outcomes/<id>.md          # rendered, redacted, human-readable

# Only for script outcomes
outcomes/<id>.raw.json    # the full return value
```

The `outcomes/<id>.md` is what shows up in `report.html` and what an agent sees first when reading the failure context. Keep them dense. The `.raw.json` is for you, not for the agent.

## What to do when you cannot express an outcome

You have two paths:

1. Open an issue describing the missing verifier. If it is small, you may be asked to ship it under `script:` first with a `.raw.json` so the format stays uniform.
2. Do not write a per-agent custom verifier and ship it. The contract is the contract, and the verifier vocabulary is part of it.
