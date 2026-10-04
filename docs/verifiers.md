---
title: Browser Test Assertions and Verifiers
description: Reference typed Cairntrace assertions for page text, URLs, network traffic, console errors, counts, tables, files, JSON, workbooks, in-run values, MongoDB, Temporal, HTTP services, scripts, and process metrics.
---

# Verifiers

The verifier vocabulary. Every entry under `outcomes:` is a single typed check the runner evaluates after the last step ran. The vocabulary is closed — exactly the 17 verifiers the `VerifierSchema` union accepts; do not invent a new verifier, use `script` for anything that does not fit, with a `outcomes/<id>.raw.json` sidecar so the artifact format stays uniform. Run `cairn explain --format json` for the machine-readable surface.

Every outcome has an `id`, a `description` and a `verify:` block holding exactly one verifier kind, plus an optional [`poll`](#polling) modifier next to it:

```yaml
outcomes:
  - id: banner_shown
    description: the welcome banner renders
    verify:
      text: { contains: "Welcome back" }
```

## Where outcomes are evaluated

Outcomes are evaluated once, after the last step ran, against the page, console, and network state at that moment. An outcome has no step pin — there is no field that binds it to an earlier step — so outcomes are assertions on the final state, not on a moment mid-flow.

If you need to check intermediate state — say the cart went from empty to three items between step 3 and step 5 — check it with steps, then assert at the end:

- **Assert in the flow:** put an [`expect`](/steps#expect) step where the state must hold (`expect: { by: role, role: status, text: { contains: "Cart (0)" } }` after step 3). A failed expect fails that step with evidence, so the run stops at the point the state was wrong.
- **Capture and assert:** record the value with a [`capture`](/steps#capture) step (`assign: cartBefore`), an `eval` step or a `request` step, then compare it at the end with the [`value`](#value) verifier (`actual: "${captures.cartBefore}"`).

Do not write a `cart-changed-during` outcome; it cannot observe the past.

Outcomes run in order, and verifiers with `assign` make their result available to the ones after them (`${captures.<name>…}`, `${network.<name>…}`).

## `text`

Asserts that rendered text appears on the page. Exactly one matcher (`equals`, `contains`, or `matches`); `region` optionally scopes to a selector (default `page`).

```yaml
verify:
  text: { contains: "Welcome", region: "[data-testid='hero']" }
```

`equals` and `contains` collapse whitespace and match case-insensitively by default, including text transformed by CSS. Set `caseSensitive: true` to preserve case. `matches` takes a raw, case-sensitive regex source string and does not accept `caseSensitive`. The legacy sibling `region:` (next to `text:`) is still accepted, but prefer nesting `region` under `text`.

## `notText`

Negation of `text`. Same matcher shape and `region` semantics.

```yaml
verify:
  notText: { contains: "Something went wrong" }
```

## `url`

Matches against the current document URL. Exactly one of `equals`, `startsWith`, `endsWith`, `matches`.

```yaml
verify:
  url: { endsWith: "/checkout/thanks" }
```

`equals` is exact; `matches` is a regex source.

## `network`

Asserts on the requests the page made. `urlContains` is required; `method` and `status` narrow it (`status` is exactly one of `equals | below | atLeast | in`; absent = any status, a still-pending request included). The status is recorded when the response headers arrive, and a request a `network` / `noFailedRequests` outcome judges that has neither a status nor an error when the steps end (its response event may lag the page by a moment) is waited for, at most 2 seconds, before the outcomes are judged and the network evidence is written; nothing waits when no judged request is in flight. The `agent-browser` backend never marks a failed or cancelled request (its request log keeps neither a status nor an error for one, like a request still in flight), so there the log is read once more after 100ms instead of waiting out the 2 seconds.

```yaml
verify:
  network: { method: POST, urlContains: "/api/qr-token", status: { in: [200, 201] } }
```

Three optional keys turn it into a request-log check:

- `body: { json, match: subset | exact }` matches the captured JSON request body (`postData`). `subset` (default) requires every key/value of `json`; `exact` requires deep equality. Runtime references such as `${captures.order.id}` are resolved first.
- `count` is a number or matcher over the matching requests (`count: 1`, `count: { atMost: 2 }`, `count: 0` = it never happened). Without `count`, at least one request must match.
- `assign: <name>` exposes the last matching request to the outcomes after this one as `${network.<name>.at}` (ISO time), `.firstAt`, `.count`, `.url`, `.method`, `.status` and `.body` — e.g. a datasource filter `createdAt: { $gte: { $date: "${network.save.at}" } }`.

```yaml
verify:
  network:
    method: POST
    urlContains: /api/export
    status: { equals: 200 }
    body: { json: { groupId: "${vars.groupId}" } }
    count: 1
    assign: exportCall
```

## `noFailedRequests`

Passes only when no matching request failed (4xx/5xx, or a transport failure: refused, blocked, aborted). `urlContains` is required; `method` is optional. Mandatory for "the user clicked Submit and got a success page" flows — without it, a 500 on the side that did not change visible text would still produce a green run.

On the `agent-browser` backend a refused, blocked or cancelled request cannot be told from one still in flight: agent-browser's request log (`network requests`, also `network request <id>`) records neither a status nor an error for it, and only a HAR capture carries the `net::ERR_*` text. Such requests are not judged failed there; the outcome's evidence says how many matching requests never completed and that the backend could not judge them. Use `--backend playwright` when transport failures must fail the run.

```yaml
verify:
  noFailedRequests: { urlContains: "/api/" }
```

## `console`

Asserts on the captured browser console. Bounded to error count: `errorsMax` is the maximum number of error-level console messages allowed.

```yaml
verify:
  console: { errorsMax: 0 }
```

## `count`

Asserts the count of elements matching a role or selector in an optional region. Exactly one of `role` or `selector` is required (counting by visible text is not supported — use `text` for presence or `script` for a text-based count); exactly one of `equals`, `atLeast`, `atMost`, `between`.

```yaml
verify:
  count: { role: row, in_region: 'table[name="Invoices"]', equals: 7 }
```

`between` is a two-element tuple `[min, max]`.

## `table`

Reads a rendered table — a `<table>`, or an element with role `table`/`grid` and row/cell roles — found by `locator` (the same `by: role|label|text|selector|testid` locators as [steps](/steps#click)), waiting up to `timeoutMs` (default 5000) for it to render. At least one of `rows`, `contains`, `headers`.

```yaml
verify:
  table:
    locator: { by: testid, testid: workers-table }
    rows: { atLeast: 1, noBlank: true, ignoreCells: [Edit, Delete] }
    contains:
      - { Name: Ada, Country: Mexico }
      - "Pending review"
    headers: { includes: [Name, Country], inOrder: true }
```

- `rows`: `equals`, `atLeast`, `atMost` bound the data-row count (header rows and hidden rows do not count). `noBlank: true` fails on a row whose cells are all empty; cells whose text — or whose column header — is listed in `ignoreCells` (action buttons) do not count as content.
- `contains`: every entry must match some row. A string matches the row's text; an object maps column headers to cell text. Both are whitespace-normalized, case-insensitive substrings.
- `headers.includes` lists required column headers; `inOrder: true` also requires that relative order.

The raw evidence keeps the headers, the row count and the first 20 rows.

## `value`

Asserts on a value the run already holds, without a script. `actual` is a runtime expression; a string that is exactly one reference keeps the value's type, and an object or array may embed references. `file` reads a JSON (or text) file instead — artifact placeholders work, relative paths resolve against the spec directory. `expect` maps paths (`$` = the value itself) to [matchers](#matchers).

```yaml
verify:
  value:
    actual: "${evals.finalState.value}"
    expect:
      blankRowCount: 0
      "rows[*].status": { each: { oneOf: [active, pending] } }
```

References: `${evals.<name>.value…}`, `${requests.<name>.status|body…}`, `${captures.<name>…}`, `${network.<name>…}`, `${fixtures.<name>.<key>}`, `${runs.<name>…}`, `${artifacts.<name>.path}` and `${run.startedAt}`. An unresolved reference fails the outcome (or blocks it, when a failed step never produced it) — it never turns into an empty string.

## `mongo`

Queries a [datasource](#datasources) of kind `mongo`: `find` (+ `countDocuments`) on `collection` with an extended-JSON `filter`, optional `projection`, `sort` and `limit` (default 20). Without `expect` it requires at least one document.

```yaml
verify:
  mongo:
    source: app
    collection: tasks
    filter:
      title: "${vars.taskTitle}"
      updatedAt: { $gte: { $date: "${run.startedAt}" } }
    sort: { updatedAt: -1 }
    expect:
      count: { atLeast: 1 }
      fields: { completed: true, deleted: false }
  poll: { timeoutMs: 45000, everyMs: 2000 }
```

- `expect.count` matches `countDocuments(filter)`; `exists: true | false` is sugar for at least one / none; `fields` maps paths of the **first** document to matchers — sort to assert on the latest one.
- Filters are extended JSON: `{ $oid: "…" }`, `{ $date: "…" }`, `{ $numberLong: "…" }`. Runtime references are resolved first; a whole reference keeps its type.
- `database` overrides the datasource database (still subject to `guard.databases`); `queryTimeoutMs` (default 15000) bounds each query.
- `assign: <name>` exposes `{ count, docs }` as `${captures.<name>…}` in a plain view — ObjectIds as hex strings, dates as ISO strings. Wrap a value back when it feeds another filter: `{ _id: { $oid: "${captures.company.docs.0._id}" } }`.

The query reaches mongosh as data (an environment variable holding EJSON), never as built JavaScript, so a title with quotes or `$` cannot change the query.

## `temporal`

Inspects a Temporal workflow through a [datasource](#datasources) of kind `temporal` (the Temporal UI / HTTP API). Exactly one of `workflowId` (describe; a 404 means absent) or `query` (a visibility list query plus its count).

```yaml
verify:
  temporal:
    source: temporal
    workflowId: "order-${captures.order.id}"
    expect:
      status: COMPLETED
      activities: { includeAll: [reserveStock, chargeCard], maxAttempts: 3 }
      inputBytes: { atMost: 4096 }
  poll: { timeoutMs: 120000, everyMs: 2000 }
```

- `status`: the execution status without the `WORKFLOW_EXECUTION_STATUS_` prefix; a list means any of them. With `query`, every listed execution must match.
- `activities`: `includeAnyOf` / `includeAll` check activity types that completed; `maxAttempts` bounds the highest activity attempt (a retried activity shows attempt > 1). With `workflowId`, an activity that is still retrying or backing off counts too: its attempt comes from describe's pending activities, which history does not show until the attempt ends.
- `inputBytes.atMost`: decoded size of the workflow input payloads.
- `count` (with `query`): matcher over the number of matching executions.
- `absent: true` — no such workflow; `absent: { stableMs: 10000 }` — and it stays absent for 10 seconds (a stability window, see [Polling](#polling)). `absent` cannot be combined with other expectations.

`activities` and `inputBytes` read the whole history: every page, following continue-as-new into the next run (from `runId`, else the execution's first run). 5xx replies and transport errors are retried within the deadline; a 400, 401 or 403 fails at once, even under `poll`. `requestTimeoutMs` (default 15000) bounds each request. `assign` exposes the described workflow.

## `http`

A Node-side HTTP call — no browser cookies — to a [datasource](#datasources) of kind `http` (its `baseUrl`, `headers` and `auth` apply) or to a URL (relative URLs use the environment `baseUrl`). Checks `status` (default: any 2xx) and JSON paths.

```yaml
verify:
  http:
    source: api
    url: /ready
    expect:
      status: 200
      json: { ready: true, workers: { atLeast: 1 } }
```

`method`, `headers`, `body` (JSON; references resolved) and `requestTimeoutMs` are optional; `assign` exposes `{ status, body }`. For calls that need the signed-in browser session use `httpJson` or an [`expect.request`](/steps#expect) step instead.

With `source`, the datasource's credentials never leave its origin: `url` is a path relative to `baseUrl`, and an absolute URL — written or spliced from `${captures.*}` — must have the same origin as `baseUrl`, or the verifier fails at once. To call another host, drop `source`. Redirects are followed for at most 5 hops: a same-origin hop keeps every header; a cross-origin hop drops the datasource and spec headers, and a request body is never re-sent to another origin (the 3xx reply is checked as-is).

## `xlsx`

Asserts against a downloaded workbook without a script verifier. `path` is the workbook (artifact placeholders like `${artifacts.template.path}` are supported); the file is read, never written. Every check below is optional, but at least one is required, and every failure is listed (the raw sidecar records the sheet, its header columns and each check).

```yaml
verify:
  xlsx:
    path: ${artifacts.template.path}
    sheet: Import Template            # name, { match: <regex> } or 0-based index; default: the first sheet
    contains: [TOKEN-123]             # anywhere in `sheet`, or in ANY sheet when no sheet is given
    headers:
      labelRow: 1                     # 1-based Excel rows; labelRow defaults to 1
      keyRow: 2
      strip: '\s*\*$'                 # removed before comparing (e.g. a required-field marker)
      present: [Staff_Email, { matches: "^Start" }]
      absent: [Address]
      labels: { Staff_Name: Name, Staff_Country: Country }
      includesInOrder: ${captures.screen.headers}
    rows:
      afterKeyRow: { count: 0 }       # or atLeast / atMost
      match:
        - { column: Staff_Name, matcher: Ada }
        - { column: Email, matcher: { matches: "@example\\.test$" } }
    cells:
      - { ref: C3, numFmt: "@" }      # text-formatted
      - { ref: D3, numFmt: yyyy-mm-dd }
      - { ref: C1, sheet: Template Guide, equals: Guidance }
    validations:
      - { column: Staff_Email, type: custom, formulaMatches: ['SEARCH\("@"', COUNTIF] }
      - { column: Country, type: list, formulaMatches: "^Lists!" }
    sheets:
      - name: "Template Guide"
        contains: ["Help Text", "Allowed Values"]
```

- **`sheet`** selects the worksheet for `headers`, `rows`, `cells` and `validations` (a cell or validation may name its own `sheet`). It also scopes `contains`, which otherwise searches every sheet.
- **`headers`**: a header name matches a column whose label (the `labelRow` cell) or key (the `keyRow` cell) equals it after whitespace is collapsed and `strip` is removed, ignoring case unless `caseSensitive: true`. `present` / `absent` take names or `{ matches }`; `labels` maps keys to their labels (needs `keyRow`).
  - The subject of both is the workbook's header row; they check opposite directions.
  - `includesInOrder` (list ⊆ workbook): every listed name is a column, in that relative order. Extra workbook columns are allowed. Use it to check that the columns shown on screen appear in the export, in the same order.
  - `withinListInOrder` (workbook ⊆ list): every workbook column is in the list, in the list's relative order. Extra list names are allowed; an extra or reordered workbook column fails. Use it to check that an export has no column outside a template's allowed list.
  - `includesInOrder` is the name for the list-in-workbook check (it was drafted as `orderedSubsetOf`; neither draft name ever shipped in a release, so there is no alias). The opposite direction is `withinListInOrder`.
  - Both take a list or one runtime reference that resolves to a list. `${captures.screen.headers}` from a [`capture: table`](/steps#capture) step compares the workbook with what the page rendered; blank entries are skipped.
- **`rows`** reads the data rows below the key row (the label row without one). `afterKeyRow` counts non-blank rows: `count`, or `atLeast` and/or `atMost`. `match` needs ONE row where every entry's [matcher](#matchers) holds against that row's cell in `column` (a label or key).
- **`cells`**: `ref` is an A1 reference. `equals` compares the stored string, `matches` is a regex. `numFmt` is the applied number format: a format code (`@` is text, `yyyy-mm-dd`, `General`; case-insensitive) or a built-in id (`49`). It resolves the cell's style, else its row's, else its column's, so it also works on an empty cell.
- **`validations`** finds the column by header label or key, falling back to a cell with that text in the first 20 rows. It then needs a data validation that covers the column, of `type` when given, whose formula1 or formula2 matches every `formulaMatches` regex. Excel 2010 `x14` validations (lists that reference another sheet) count.
- **`sheets[].contains`** is a list of strings that sheet's text must include.

Values are the strings Excel stores: numbers and dates are unformatted (a date is its serial number), booleans are `1` / `0`. Operands may splice runtime references (`${captures.…}`, `${fixtures.…}`). A reference that does not resolve fails the outcome at once, even under `poll`. The same parser backs [`ctx.xlsx(path)`](/scripts) in node verifiers.

## `file`

Polls for a file on disk, optionally requiring its text to contain a needle. Covers file-based test doubles (e.g. a local email driver writing `*-welcome-user@example.com.json` captures) without a hand-rolled script poller.

```yaml
verify:
  file: { glob: "./mail-captures/*-welcome-*.json", contains: "Your QR code", timeoutMs: 5000 }
```

`glob` resolves relative to the spec's directory; `*` and `?` wildcards are supported in the **filename** only — the directory part is literal. `timeoutMs` is the poll deadline (default 10000).

## `httpJson`

Fetches app JSON in the browser session and asserts a simple JSON path, without a `script` verifier. `url` is required (relative paths use config `baseUrl` or the current page origin); `jsonPath` defaults to `$`. Exactly one matcher: `equals`, `contains`, `matches`, `atLeast`, `atMost`, `exists`.

```yaml
verify:
  httpJson:
    url: "/api/test/state?gameId=${requests.game.body.gameId}"
    jsonPath: "$.roshan.alive"
    equals: false
```

`equals` accepts any JSON scalar; `contains` accepts string/number/boolean; `exists` is a boolean.

## `script`

Last-resort verifier. Runs browser or Node JS returning `{ ok, evidence }`. Exactly one of `run` (inline JS body) or `file` (path to a JS/TS verifier, resolved against the spec dir). `runtime` is `browser` (page context) or `node` (a Node process with fs/import access); default `browser`. See [Scripts](/scripts).

```yaml
verify:
  script:
    runtime: node
    file: ./verifiers/check-template.ts
    fixtures:
      templatePath: ${artifacts.template.path}
```

`script` outcomes write an `outcomes/<id>.raw.json` sidecar with the full return value so the artifact pack stays self-contained. Before reaching for one, check whether `value`, `table`, `mongo`, `temporal` or `http` already says it.

## `process`

Asserts on monitor-reported browser process metrics collected by `cairn run --monitor` (or `MONITOR=1`). Each metric is optional; every present matcher must pass. Each matcher is exactly one of `below | atLeast | equals`.

```yaml
verify:
  process:
    peakRss: { below: 500 }     # megabytes
    meanCpu: { below: 90 }      # summed tree CPU percent
```

| Metric | Unit |
|---|---|
| `peakRss`, `meanRss`, `finalRss` | megabytes (tree RSS) |
| `peakCpu`, `meanCpu` | summed tree CPU percent (may exceed 100 on multi-core) |
| `samples` | number of successful sample points |

The verifier reports `skipped` (not `failed`) when the run was not monitored, so a spec carrying a perf budget does not fail on every non-monitored run. See [Process monitoring](/monitor).

## Polling

Every verifier accepts `poll` next to its kind key:

```yaml
verify:
  mongo: { source: app, collection: events, filter: { type: ORDER_SHIPPED }, expect: { count: 1 } }
  poll: { timeoutMs: 60000, everyMs: 2000, stableMs: 10000 }
```

| Field | Meaning |
|---|---|
| `timeoutMs` | total budget (required) |
| `everyMs` | pause between attempts (default 1000, at least 50) |
| `stableMs` | a pass only counts once it held green this long over at least two samples; a red sample restarts the window. Use it for "exactly one, and it stays one" and "absent, and it stays absent". `stableMs + everyMs` must be ≤ `timeoutMs`: the window opens at the first green sample and needs one more sample to close inside the budget. |
| `failFastOnStepFailure` | default `true`: when a step already failed, evaluate once without waiting — the side effect is not coming. A green sample that still needed a stability window is reported `skipped`. |

While an outcome polls, `outcome.progress` events (and the live narration) say `attempt 3/~30: count=0 (want 1)`. The final `outcome.passed` / `outcome.failed` event carries `attempts` and `polledMs`, and `outcomes/<id>.raw.json` keeps a bounded attempt log (`{ at, ok, summary }`, first 5 and last 15). Errors that waiting cannot fix — an unknown datasource, a guard refusal, an unresolved reference (`network.body` included), a missing `mongosh` / `docker` binary, a Temporal 400/401/403, an `http` URL outside its datasource's origin — fail at once instead of burning the budget. Under `poll`, `network`, `noFailedRequests` and `console` re-read the live log after the first attempt.

## Matchers

The data verifiers (`mongo` `fields` and `count`, `temporal` `count`, `http` `json`, `value`, `network.count`) share one matcher shape. A bare scalar means `equals`:

```yaml
fields:
  status: COMPLETED                       # equals
  total: { atLeast: 10, atMost: 20 }      # every present key must hold
  tags: { contains: urgent }              # substring, array element, or object subset
  "items[*].qty": { each: { atLeast: 1 } }
  owner: { exists: true }                 # null counts as present
  notes: { empty: true }                  # missing, null, "", [] or {}
  kind: { oneOf: [order, refund], ignoreCase: true }
  code: { matches: "^ORD-[0-9]+$" }
```

Matcher operands may hold runtime references (`${captures.*}`, `${fixtures.*}`, `${requests.*}`, `${runs.*}`, …), resolved like `actual`: a string that is exactly one reference keeps the value's type, a reference embedded in text renders as text, and an unresolved one fails the outcome at once. Comparisons are raw and case-sensitive (this is data, not rendered text) unless `ignoreCase: true`. `atLeast` / `atMost` accept numbers and numeric strings only — `[]`, `null` and booleans are never coerced. Paths are `$`-rooted: `a.b`, `items[0]`, `items.0`, `items[-1]`, `rows[*].name`, `items.length`, `$['key.with.dots']`.

## Datasources

`mongo`, `temporal` and `http` read through named connections in `cairntrace.config.yml`:

```yaml
datasources:
  app:
    kind: mongo
    docker: { service: mongo }          # docker exec into the compose service's container
    database: shop
    guard: { databases: [shop] }
  temporal:
    kind: temporal
    api: http://localhost:8080          # Temporal UI / HTTP API
    namespace: default
  api:
    kind: http
    baseUrl: http://localhost:4000
    auth: { bearer: "${secrets.API_TOKEN}" }

environments:
  local: {}
  dev:
    datasources:
      app: { uri: "${secrets.DEV_MONGO_URI}", mode: read-only }
      temporal: { api: "https://temporal.dev.example.test", auth: { basic: "${secrets.TEMPORAL_BASIC}" } }
```

- **mongo**: `uri` (usually `${secrets.X}`) or `docker: { service | container, project?, uri? }`, plus `database`. With a `uri`, Cairntrace uses the official `mongodb` driver when the project installed it (an optional peer dependency — `bun add mongodb` in the project; it is looked up from the spec's directory and the working directory first, so a global or Homebrew `cairn` finds it too), else `mongosh`; `transport: driver | mongosh | docker` forces one. `docker` resolves the container from its compose service label (`project` picks between stacks) and runs `docker exec -i <container> mongosh`. The query goes to `mongosh` on stdin (no size ceiling) and the connection string through the environment, never on a command line. `guard.databases` / `guard.hosts` refuse anything else — `guard.hosts` also checks `docker.uri` (the default in-container `mongodb://127.0.0.1:27017` is the container's own server); `mode: read-only` refuses writes.
- **temporal**: `api`, `namespace`, optional `auth: { basic: "user:password" | bearer }`.
- **http**: `baseUrl`, optional `headers` and `auth`; both are only ever sent to `baseUrl`'s origin (see [`http`](#http)).
- `environments.<env>.datasources` merges a partial entry over the top-level one field by field (a `uri` override drops an inherited `docker` transport); `<name>: false` disables a source in that environment; an entry that only exists in an environment must be complete.
- Strings may use `${secrets.X}`, `${env.X}` (`:-default` supported) and `${vars.X}`. An unset secret fails the verifier at once — it never connects to an empty or default address.

Connection strings and credentials never reach artifacts: evidence names a source by `{ name, kind, transport, database, hosts }`, and transport errors are scrubbed before they are recorded.

## Honesty signals

Two patterns across verifiers:

- `equals: N` for exact counts. If you write `count: { atLeast: 1 }` for something that should be exactly one, the spec will silently let bugs through. Be exact when you mean exact — and add `stableMs` when "exactly one" must still hold a moment later.
- `contains: "foo"` for human-facing partial text matches. Text/notText contains checks are whitespace-normalized and case-insensitive unless `caseSensitive: true`; regex `matches` stays raw and case-sensitive.

## Sidecar artifact shape

```yaml
# Always written for every outcome
outcomes/<id>.md          # rendered, redacted, human-readable

# script, mongo, temporal, http, value, table, network with body/count/assign,
# and any outcome evaluated under poll
outcomes/<id>.raw.json
```

For the data verifiers the sidecar is:

```json
{
  "kind": "mongo",
  "source": { "name": "app", "kind": "mongo", "transport": "docker", "database": "shop" },
  "request": { "collection": "tasks", "filter": { "title": "Ship order" }, "limit": 20 },
  "observed": { "count": 1, "docs": [{ "_id": "65f0c0ffee", "completed": true }], "truncated": false },
  "attempts": [{ "at": "2026-10-02T10:00:01.000Z", "ok": true, "summary": "count=1" }],
  "polledMs": 1240
}
```

`request` is redacted (credential headers masked, URLs without userinfo); `observed` keeps at most 20 rows of at most 4KB each and says when it `truncated`. The `outcomes/<id>.md` is what shows up in `report.html` and what an agent sees first when reading the failure context.

## What to do when you cannot express an outcome

You have two paths:

1. Use `script:` with a `.raw.json` sidecar so the format stays uniform.
2. Open an issue describing the missing verifier. Only promote a new typed verifier when 3+ real specs would benefit — the verifier vocabulary is part of the contract, and adding one is a schema change.

Do not write a per-agent custom verifier and ship it. The contract is the contract, and the verifier vocabulary is part of it.

## See also

- [Steps](/steps) — the typed step vocabulary, including `expect` and `capture`
- [Process monitoring](/monitor) — the `--monitor` flag and `monitor` step that feed the `process` verifier
- [Authoring](/authoring) — what makes a contract survive across months
- [Artifacts](/artifacts) — `outcomes/<id>.md` and the `.raw.json` sidecar
