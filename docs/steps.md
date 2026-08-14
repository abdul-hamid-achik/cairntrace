---
title: Browser Automation Steps Reference
description: Reference typed Cairntrace steps for navigation, semantic interaction, uploads, downloads, requests, snapshots, batches, evaluation, and process monitoring.
---

# Steps

The step vocabulary. Every `step:` entry below is a typed verb the runner knows. The vocabulary is closed — exactly the 19 steps the `StepSchema` union accepts; if your intent does not map to one of them, use `eval` (page-context JS) or `request` (typed API call), never invent a new shape. Run `cairn explain --format json` for the machine-readable surface.

Every step also accepts two optional common keys:

- `id: <name>` — a stable step label for cross-referencing in artifacts.
- `when: <condition>` — skip the whole step (do not run, do not capture) when the condition string is false. Conditions are simple names like `notAuthenticated`, resolved by the runner.
- `postcondition.network` — arm a response wait before the action and require a matching response after exactly one mutation.

## Navigation

### `open`

Navigate to a URL. Relative paths resolve against the config `baseUrl` for the active environment. The string form waits for the `load` event; the object form folds a post-navigation wait in, which is what you want for hydration-sensitive SPAs.

```yaml
- open: /admin
- open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }
- open: { path: "/login?next=/account" }
```

`waitUntil` is one of `networkidle | load | domcontentloaded`. Use `networkidle` on the first interaction with an SPA so the click does not land before handlers attach.

### `wait`

An explicit polling step. Hard-bounded at 30000 ms by default; real Chromium runs also start an external watchdog that kills the browser at the deadline, so a page stuck in navigation churn fails the step instead of wedging the suite.

```yaml
- wait: { text: "Saved", timeoutMs: 10000 }
- wait: { notText: "Loading…" }
- wait: { text: "Saved", caseSensitive: true }
- wait: { load: networkidle }
- wait: { selector: "[data-testid='hydrated']", state: visible }
- wait:
    selector: ".invite-entity-blade button"
    hasText: Connect as Supplier
    timeoutMs: 30000
- wait:
    value: { by: label, name: Country, equals: United States }
    timeoutMs: 40000
- wait: { url: { includes: "/connection/" } }
- wait: { url: { equals: "http://localhost:8080/dash" } }
- wait: { url: { pattern: "/app/?$" } }
- wait: { ms: 20000 }
```

Condition shapes, exactly one per step:

| Shape                                       | Asserts                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text: <str>`                               | the page contains the text                                                                                                                                                                                                                                                                                                                                                               |
| `notText: <str>`                            | the page does not contain the text                                                                                                                                                                                                                                                                                                                                                       |
| `load: networkidle\|load\|domcontentloaded` | a load state was reached                                                                                                                                                                                                                                                                                                                                                                 |
| `selector: <css> + state? + hasText?`       | an element matches; `state` is `attached\|visible\|hidden\|detached`. `hasText` keeps only visible nodes whose text contains the string (use this instead of `wait.text` when the same copy also lives in a card concat). On agent-browser, `hidden`/`detached`/`attached`/`hasText` are live DOM predicates (`--fn`) because that CLI's `--state` flag is an auth file, not visibility. |
| `value: <locator + equals>`                 | a form control's live value exactly equals the string                                                                                                                                                                                                                                                                                                                                    |
| `url: { includes \| equals \| pattern }`    | the current page URL matches; `pattern` is a JS regex                                                                                                                                                                                                                                                                                                                                    |
| `ms: <n>`                                   | pause with no predicate (search-index catch-up); max 300000                                                                                                                                                                                                                                                                                                                              |

`text` and `notText` collapse whitespace and match case-insensitively by
default. Set `caseSensitive: true` when rendered casing is significant.

## Interaction

### `click`

Activate a locator. Semantic locators match accessible names (whole-name, case-insensitive; `exact: true` for case-sensitive; a trailing count badge is allowed so `Tasks` matches `Tasks 11`, but `Pay` still does not match `Pay for plan`), scroll into view first, and fail loudly on zero or ambiguous matches. `nth:` picks among several.

```yaml
- click: { by: role, role: button, name: Save }
- click: { by: role, role: button, name: Pay, nth: 1 }
- click: { by: role, role: button, name: Open, near: "Acme Corp" }
- click: { by: testid, testid: product_name }
- click: { by: selector, selector: "button.primary" }
- click: { by: selector, selector: '[data-testid^="entity-switch-item-"]', nth: 1 }
- click: { by: role, role: link, name: Reports }
  settleMs: 15000
- click: { by: text, text: "Cairn task abc", exact: true }
- click:
    by: selector
    selector: ".company-link"
    until:
      url: { includes: "/connection/" }
      timeoutMs: 60000
```

`click.until` retries the click at most four times until `selectorGone`, `selector`, `text`, `notText`, or `url` (same matcher as `wait.url`) holds.

`near: <text>` scopes a locator to the control nearest that visible copy — the Open button in the card titled Acme Corp, not the other two Opens on the page; the Delete in the confirm dialog, not the Delete on the form. Matching is whitespace-normalized and case-insensitive. `hasText: <str>` keeps only matches whose visible text contains that string (also whitespace-normalized, case-insensitive). Use it to pick `Yes` inside `[data-qa="…"]` without an eval:

```yaml
- click:
    by: selector
    selector: '[data-qa="business_owner"] .radio-label'
    hasText: "Yes"
```

`by: testid` reads `browser.testIdAttribute` (default `data-testid`). `by: text` is the visible copy. On agent-browser, `by: text` and any locator with `near` read the full snapshot (not the interactive `-i` slice, which drops `StaticText`); a text match with no `@ref` clicks the nearest ancestor that has one. `hasText` on a selector locator also drops `display:none` / zero-size nodes so a vue-multiselect option that stays in the a11y tree is not clicked while hidden.

Agent-browser confirms same-tab link delivery from URL, document, or DOM
evidence by default; it does not add an implicit network-idle wait. A positive
click-step or top-level spec `settleMs`, or config
`browser.postClickSettleMs`, explicitly adds network-idle settling. Click/spec
values take precedence over config. Playwright honors explicit click/spec
values and otherwise keeps its native action/navigation waits. A resolved
`settleMs: 0` skips the extra settle at that scope AND the agent-browser
link-delivery probe (you are declaring that the next step waits on the
destination itself).

### `hover`

Move the pointer over a locator to reveal hover-only UI.

```yaml
- hover: { by: selector, selector: ".question-table-wrap .table-title" }
```

### `focus`

Focus a locator without clicking it. This is useful for custom comboboxes and
controls that reveal dependent UI on focus.

```yaml
- focus: { by: selector, selector: '[data-qa="country"] input' }
```

### `fill`

Set a field's value in one bulk operation.

```yaml
- fill: { by: label, name: Email, value: "user@example.com" }
```

`fill` is a value-set, not keystroke events. SPA frameworks whose validation listens for `keydown`/`keyup`/`input` may not react — the classic symptom is a submit button staying `[disabled]` after `fill`. Use `type` when the framework needs real key events.

Date-ish inputs (`type=date|time|datetime-local`) are value-set natively — value property plus bubbling `input`/`change` events — because their shadow-DOM pickers swallow simulated keystrokes. Values must be normalized (`date=YYYY-MM-DD`, `time=HH:MM`, `datetime-local=YYYY-MM-DDTHH:MM`); a rejected value fails the step with the field left untouched, instead of silently leaving it empty. On the agent-browser backend, reach date-ish inputs with `by: selector` — they have no presence in the accessibility snapshot (only their shadow spinbutton parts appear), so a semantic locator fails at resolution; Playwright resolves semantic locators for them too.

```yaml
- fill: { by: selector, selector: "#birth-date", value: "1990-04-01" }
```

### `select`

Choose an option in a native `<select>` element by option `value` or visible `label` — exactly one of the two. Both backends fire native `input`/`change` events, and a non-matching choice fails the step listing the available options. This exists as a first-class step because clicking a `<select>` open and clicking an `<option>` does not work under automation — the dropdown is browser chrome, not DOM.

```yaml
- select: { by: label, name: Plan, value: pro }
- select: { by: selector, selector: "#plan", label: "Pro plan" }
```

An empty `value: ""` is legal and picks a value-less placeholder option. Playwright matches strictly by the key you author (`value` against option values, `label` against visible text); agent-browser's CLI matches the choice against both, so author the key you actually mean to stay portable.

### `type`

Type text character-by-character into a field, sending each character as a real keyboard event. This is what reactive frameworks (Vue, React) need to fire their form validation. `delayMs` adds a per-keystroke delay for slow, debounced validators (default 0) on both agent-browser (`--delay`) and Playwright.

```yaml
- type: { by: label, name: Token, value: "${requests.qr.body.token}", delayMs: 50 }
```

### `press`

A single keyboard key press — `Enter` to submit, `Control+a` to select, `Escape` to dismiss. Without `target`, the key goes to the currently focused element (page-level). With `target`, the runner focuses that locator first so Vue `@keyup.enter` on an input actually fires.

```yaml
- press: Enter
- press: "Control+a"
- press: Enter
  target:
    by: selector
    selector: "#search-filter-header-search"
  until:
    selector: ".company-link"
    timeoutMs: 180000
```

### `scroll`

Scroll the page by direction/pixels, or bring a locator into view.

```yaml
- scroll: { direction: down, px: 600 }
- scroll: { to: { by: role, role: button, name: Submit } }
```

## File

### `upload`

Set a file input from a local path.

```yaml
- upload: { by: label, name: File, path: ./fixtures/sample.xlsx }
```

For an upload that starts asynchronous server work, attach a typed network
postcondition. Cairntrace observes the response before dispatching
`setInputFiles` and does not retry the upload if the response times out:

```yaml
- upload:
    by: selector
    selector: "input[type=file]"
    path: ./fixtures/w9.pdf
  postcondition:
    network:
      method: POST
      urlContains: /api/files/extract-content-by-package
      status: { in: [200, 201] }
      timeoutMs: 45000
```

`urlContains` is required; `method`, `status`, `timeoutMs`, and `assign` are
optional. `status` accepts `equals`, `below`, `atLeast`, or `in`. `assign`
writes `requests/<name>.json` and exposes `${requests.<name>.status}`,
`${requests.<name>.url}`, `${requests.<name>.id}`, and `${requests.<name>.body}`
when a JSON request body was captured. The same guard can cover `click`,
`fill`, `type`, and `select`; it intentionally disables mutation retries for
that action.

### `download`

Click a locator and capture the resulting download. `saveAs` names the file in the artifact dir; `assign` registers it as a named artifact so later steps and verifiers reference it via `${artifacts.<assign>.path}`.

```yaml
- download:
    { by: role, role: button, name: "Download template", saveAs: template.xlsx, assign: template }
```

`assign` must be a lowerCamel identifier (`/^[a-z][A-Za-z0-9_]*$/`). `timeoutMs` bounds the wait for the download to start.

### `transform`

Run a Node transform that writes a new named file artifact. The transform reads an `input` file (often a downloaded artifact via `${artifacts.<name>.path}`) and writes `saveAs`. Use it to mutate a downloaded template into a broken variant for an import test, etc.

```yaml
- transform:
    runtime: node
    file: ./transforms/make-invalid-template.ts
    input: ${artifacts.template.path}
    saveAs: invalid-template.xlsx
    assign: invalidTemplate
    fixtures: { flag: "stripped" }
```

`runtime` is `node` (the only option, optional). `fixtures` is a string→string map passed into the transform.

## Server-side

### `request`

Typed authenticated API call. Cookies are inherited from the browser session, so `request` runs in the same vocabulary as DOM steps — it is the replacement for `fetch` glue inside `script` verifiers. Relative `url` resolves against config `baseUrl` or the current page origin.

```yaml
- request:
    method: POST
    url: /api/qr-token
    body: { memberId: 42 }
    timeoutMs: 15000
    expectStatus: 200
    assign: qr
- fill: { by: label, name: "Scanner code", value: "${requests.qr.body.token}" }
```

`assign` captures the response: the full envelope is written to `requests/<name>.json` (also addressable as `${artifacts.<name>.path}`), and later steps splice response fields with `${requests.<name>.body.<field>}` or `${requests.<name>.status}`. `expectStatus` accepts a single int or a non-empty array; omit it to accept any completed response. `body` objects are JSON-encoded (content-type `application/json` unless `headers` overrides); strings are sent raw. Playwright runs `request` out of page with browser-context cookie sharing; under Bun an isolated subprocess bridge enforces `timeoutMs` even if native fetch stalls; backends without native request support fall back to a bounded page-fetch.

## Capture & artifacts

### `snapshot`

Capture an accessibility snapshot for evidence or healing. `interactive: true` captures the interactive tree (the one `heal` reads); `label` tags it.

```yaml
- snapshot: { interactive: true }
```

### `use`

Invoke an imported reusable action by name. See [Snippets](/snippets) for the `imports:` / `use:` DAG.

```yaml
- use: login_admin
- use:
    action: edit_and_save_text_field
    vars:
      textFieldValue: https://example.com
```

An action file may declare `vars:` defaults for `${vars.X}` placeholders in its steps. Precedence: action defaults < config env vars < spec `vars:` < CLI `--var` < **use-site `vars:`** (highest, only for that expansion). The same action can be invoked twice with different values.

`when:` can be the string DSL (`text:Password`, `selector:.invite`) or an object. Use the object when the gate needs `hasText` on a selector — the same visible-node predicate as `wait.selector` + `hasText`, so a card-concat `Connect as Supplier` does not skip or fire the wrong step.

```yaml
- when:
    selector: .invite-entity-blade
    hasText: Connect as Supplier
  click:
    by: role
    role: button
    name: Connect as Supplier
```

```yaml
# actions/open_home_connection.yml
version: 1
name: open_home_connection
vars:
  connectionCompanyName: Acme Corp
steps:
  - open: /dash
  - click:
      by: role
      role: button
      name: Open
      near: "${vars.connectionCompanyName}"
```

### `eval`

Page-context JavaScript escape hatch. Runs arbitrary JS in the browser via `backend.evaluate()` and optionally captures the JSON-serializable return value as `evals/<assign>.json`, spliced into later steps via `${evals.<name>.value.<field>}`. Exactly one of `js` or `file` is required; `args` is passed as the single argument to the wrapped function.

```yaml
- eval:
    js: "window.__APP__.$store.state.profile.answers"
    assign: answersBefore
- eval:
    file: ./scripts/seed-state.js
    assign: seeded
    args: { flag: "stripped" }
- fill: { by: label, name: Token, value: "${evals.answersBefore.value.token}" }
```

`eval` is deliberately the last-resort, locator-free step: opaque to `heal` and bypassing the semantic-locator contract. Use it for state setup and internal-state assertions no UI affordance can reach. Prefer a typed step when one exists.

## Compound

### `batch`

Run a chain of selector interactions in ONE backend invocation so transient UI state (a hover popover, a focus state, a transient menu) survives long enough to act on it. On agent-browser this maps to `agent-browser batch --bail`: the first failing sub-step fails the whole batch.

```yaml
- batch:
    - hover: { by: selector, selector: "#row-actions" }
    - click: { by: selector, selector: 'button[aria-label="Upload data"]' }
```

Sub-steps are selector-only — semantic locators are not allowed inside `batch`, because they need a snapshot round-trip that would defeat the single invocation. Allowed sub-steps: `click`, `hover`, `fill`, `type`, `upload`, `press`, `scroll`, `wait` (all selector-locator form). A batch needs at least 2 sub-steps; for one, use a normal step.

Agent-browser paces click sub-steps by 100 ms. Checkbox, radio, and switch
clicks also record their pre-state (including `aria-checked="mixed"`) and
re-query after framework rerenders. Verification runs in two stages: a ~500 ms
grace lets a slow async commit land before Cairntrace calls the live element's
`.click()` once, then a ~500 ms settle confirms the result. If the control
flips back to its original value (a double-toggle from a late authored commit
plus the recovery both applying) or state never changes at all, the batch fails
at the authored sub-step and names the failed probe/action/verification phase —
it never passes a flipped-back state.

## Process

### `monitor`

Capture a process profile or a one-shot sample of the backend's browser process tree at a point in the flow, via the external `monitor` CLI. The step targets `backend.browserPid()`; it **fails** if no browser PID is available or `monitor` is not on `$PATH` — the author explicitly asked to capture here, so it is a step failure, not a silent skip.

```yaml
- open: /heavy-dashboard
- monitor: { action: profile, type: heap, assign: heapAfterLoad }
- monitor: { action: snapshot, label: after-scroll }
```

- `action: profile` requires `type: heap | cpu | goroutine | sample`. With `assign`, the result is written to `monitor/<assign>.json` and registered as a named artifact, reusable via `${artifacts.<assign>.path}`.
- `action: snapshot` captures a single `monitor process <pid>` sample, optionally labeled.

`monitor` is handled by the runner _before_ adapter dispatch — it is not a backend interaction. Pair it with the run-wide `--monitor` flag and the `process` verifier (see [Process monitoring](/monitor)) to turn "the spec got slow" into an assertable budget.

## Step output

Every step produces timing and status entries in `events.ndjson`, and its final
result is included in `run.json`, even when no screenshot is requested. Steps
gated by `when:` produce a skipped event. A failed browser step writes
`diagnostics/<step-ordinal>_<step-id>.json` with the captured page diagnostics
when the backend is still responsive.

## What is deliberately not a step

- No `sleep N` — every wait is conditional on a typed observable.
- No per-step backend choice — backends live in `cairntrace.config.yml`, not in steps.
- No per-agent code paths. The CLI + MCP server + artifact shape are the interface; steps do not know who is reading them.

## See also

- [Verifiers](/verifiers) — the outcome vocabulary evaluated against the post-step snapshot
- [Snippets](/snippets) — `imports:` / `use:` for reusable action files
- [Process monitoring](/monitor) — the `--monitor` run flag and `process` verifier
- [Authoring](/authoring) — what makes a contract survive across months
