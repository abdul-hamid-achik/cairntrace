# Verifiers

The verifier vocabulary. Every entry under `outcomes:` is a single typed check the runner evaluates against the page state after the last step ran. The vocabulary is closed — exactly the 12 verifiers the `VerifierSchema` union accepts; do not invent a new verifier, use `script` for anything that does not fit, with a `outcomes/<id>.raw.json` sidecar so the artifact format stays uniform. Run `cairn explain --format json` for the machine-readable surface.

## Where outcomes are evaluated

After every step, the runner snapshots the DOM, the console, and the network log. Outcomes bind to that snapshot. There is exactly one snapshot per outcome, not a sliding window — outcomes are assertions on state, not in time.

If you need to assert that *between* step 3 and step 5 the cart went from empty to three items, write two outcomes and pin them to their respective steps. Do not write a `cart-changed-during` outcome.

## `text`

Asserts that rendered text appears on the page. Exactly one matcher (`equals`, `contains`, or `matches`); `region` optionally scopes to a selector (default `page`).

```yaml
outcomes:
  - id: banner-shown
    text: { contains: "Welcome back" }
  - id: banner-in-region
    text: { contains: "Welcome", region: "[data-testid='hero']" }
```

`matches` takes a regex source string. The legacy sibling `region:` (next to `text:`) is still accepted, but prefer nesting `region` under `text`.

## `notText`

Negation of `text`. Same matcher shape and `region` semantics.

```yaml
outcomes:
  - id: no-error-message
    notText: { contains: "Something went wrong" }
```

## `url`

Matches against the current document URL. Exactly one of `equals`, `startsWith`, `endsWith`, `matches`.

```yaml
outcomes:
  - id: navigated-to-thanks
    url: { endsWith: "/checkout/thanks" }
  - id: stayed-on-cart
    url: { matches: "/cart" }
```

`equals` is exact; `matches` is a regex source.

## `network`

Asserts that at least one matching request happened. `urlContains` is required; `method` and `status` narrow it. `status` is exactly one of `equals | below | atLeast | in` (an int, or an array for `in`).

```yaml
outcomes:
  - id: refresh-called
    network: { method: POST, urlContains: "/api/qr-token", status: { in: [200, 201] } }
```

## `noFailedRequests`

Passes only when no matching request failed (4xx/5xx). `urlContains` is required; `method` is optional. Mandatory for "the user clicked Submit and got a success page" flows — without it, a 500 on the side that did not change visible text would still produce a green run.

```yaml
outcomes:
  - id: clean-api
    noFailedRequests: { urlContains: "/api/" }
```

## `console`

Asserts on the captured browser console. Bounded to error count: `errorsMax` is the maximum number of error-level console messages allowed (default expected 0).

```yaml
outcomes:
  - id: no-console-errors
    console: { errorsMax: 0 }
```

## `count`

Asserts the count of elements matching a role or selector in an optional region. Exactly one of `role` or `selector` is required (counting by visible text is not supported — use `text` for presence or `script` for a text-based count); exactly one of `equals`, `atLeast`, `atMost`, `between`.

```yaml
outcomes:
  - id: exactly-seven-results
    count: { role: row, in_region: 'table[name="Invoices"]', equals: 7 }
  - id: at-least-one-banner
    count: { selector: "[data-testid='banner']", atLeast: 1 }
```

`between` is a two-element tuple `[min, max]`.

## `xlsx`

Asserts against a downloaded XLSX workbook. `path` is the workbook (artifact placeholders like `${artifacts.template.path}` are supported). At least one of `sheets` or `validations` is required.

```yaml
outcomes:
  - id: template-has-guide
    xlsx:
      path: ${artifacts.template.path}
      sheets:
        - name: "Template Guide"
          contains: ["Help Text", "Allowed Values", "Examples"]
  - id: email-column-validated
    xlsx:
      path: ${artifacts.template.path}
      validations:
        - { sheet: "RBA Academy Training", column: "Email", type: "textLength" }
```

`sheets[].contains` is a list of strings the sheet text must include. `validations[]` checks a sheet/column carries an Excel data validation, optionally of a given `type`.

## `file`

Polls for a file on disk, optionally requiring its text to contain a needle. Covers file-based test doubles (e.g. a local email driver writing `*-welcome-user@example.com.json` captures) without a hand-rolled script poller.

```yaml
outcomes:
  - id: welcome-email-captured
    file: { glob: "./mail-captures/*-welcome-*.json", contains: "Your QR code", timeoutMs: 5000 }
```

`glob` resolves relative to the spec's directory; `*` and `?` wildcards are supported in the **filename** only — the directory part is literal. `timeoutMs` is the poll deadline (default 10000).

## `httpJson`

Fetches app JSON in the browser session and asserts a simple JSON path, without a `script` verifier. `url` is required (relative paths use config `baseUrl` or the current page origin); `jsonPath` defaults to `$`. Exactly one matcher: `equals`, `contains`, `matches`, `atLeast`, `atMost`, `exists`.

```yaml
outcomes:
  - id: roshan-alive
    httpJson:
      url: "/api/test/state?gameId=${requests.game.body.gameId}"
      jsonPath: "$.roshan.alive"
      equals: false
  - id: score-at-least-100
    httpJson: { url: "/api/score", jsonPath: "$.game.score", atLeast: 100 }
```

`equals` accepts any JSON scalar; `contains` accepts string/number/boolean; `exists` is a boolean. Use `httpJson` instead of a `script` verifier full of `fetch` glue whenever the check is "this endpoint returns this value at this path."

## `script`

Last-resort verifier. Runs browser or Node JS returning `{ ok, evidence }`. Exactly one of `run` (inline JS body) or `file` (path to a JS/TS verifier, resolved against the spec dir). `runtime` is `browser` (page context) or `node` (a Node process with fs/import access); default `browser`. Wrap the predicate in `cairn.run.assert(condition, evidence)` so the result is a typed record.

```yaml
outcomes:
  - id: server-version-pinned
    script:
      runtime: node
      file: ./verifiers/check-template.ts
      fixtures:
        templatePath: ${artifacts.template.path}
```

```yaml
outcomes:
  - id: cart-total-correct
    script:
      run: |
        const r = await fetch("/cart").then(r => r.json());
        return cairn.run.assert(r.total === 0, { total: r.total });
```

`fixtures` is a name→value map (numbers/booleans are stringified). `script` outcomes write an `outcomes/<id>.raw.json` sidecar with the full return value so the artifact pack stays self-contained.

## `process`

Asserts on monitor-reported browser process metrics collected by `cairn run --monitor` (or `MONITOR=1`). Each metric is optional; every present matcher must pass. Each matcher is exactly one of `below | atLeast | equals`.

```yaml
outcomes:
  - id: rss-budget
    process:
      peakRss: { below: 500 }     # megabytes
      meanCpu: { below: 90 }        # summed tree CPU percent
```

| Metric | Unit |
|---|---|
| `peakRss`, `meanRss`, `finalRss` | megabytes (tree RSS) |
| `peakCpu`, `meanCpu` | summed tree CPU percent (may exceed 100 on multi-core) |
| `samples` | number of successful sample points |

The verifier reports `skipped` (not `failed`) when the run was not monitored, so a spec carrying a perf budget does not fail on every non-monitored run. Pair it with `--monitor` (or `MONITOR=1`) to actually enforce the budget. See [Process monitoring](/monitor).

## Honesty signals

Two patterns across verifiers:

- `equals: N` for exact counts. If you write `count: { atLeast: 1 }` for something that should be exactly one, the spec will silently let bugs through. Be exact when you mean exact.
- `contains: "foo"` for partial matches. The matcher is case-sensitive; use `matches: { matches: "Foo.+Bar" }` when you mean a case-insensitive pattern. (Inside `text`/`notText`, the matcher key is `matches`; inside `url`, also `matches`.)

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

1. Use `script:` with a `.raw.json` sidecar so the format stays uniform.
2. Open an issue describing the missing verifier. Only promote a new typed verifier when 3+ real specs would benefit — the verifier vocabulary is part of the contract, and adding one is a schema change.

Do not write a per-agent custom verifier and ship it. The contract is the contract, and the verifier vocabulary is part of it.

## See also

- [Steps](/steps) — the typed step vocabulary
- [Process monitoring](/monitor) — the `--monitor` flag and `monitor` step that feed the `process` verifier
- [Authoring](/authoring) — what makes a contract survive across months
- [Artifacts](/artifacts) — `outcomes/<id>.md` and the `.raw.json` sidecar