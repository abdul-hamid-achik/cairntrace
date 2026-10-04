---
title: Browser Automation Steps Reference
description: Reference typed Cairntrace steps for navigation, semantic interaction, uploads, downloads, requests, snapshots, batches, evaluation, and process monitoring.
---

# Steps

The step vocabulary. Every `step:` entry below is a typed verb the runner knows. The vocabulary is closed — exactly the steps the `StepSchema` union accepts; if your intent does not map to one of them, use `eval` (page-context JS) or `request` (typed API call), never invent a new shape. Run `cairn explain --format json` for the machine-readable surface.

Every step also accepts two optional common keys:

- `id: <name>` — a stable step label for cross-referencing in artifacts.
- `when: <condition>` — skip the whole step (do not run, do not capture) when the condition is false: the string form (`text:Saved`, `urlContains:/done`, `selector:#banner`) or an object (`{ selector, hasText }`, `{ url: { includes } }`, `{ var: mode, equals: fast }`). See [Conditions](#conditions-when-until-condition).
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
- wait: { app: { path: store.user.id, equals: 7 }, timeoutMs: 15000 }
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
| `app: { path, equals \| in \| exists }`      | a config [`browser.appHandle`](/configuration#browser) value holds; see [Page prelude and app handles](#page-prelude-and-app-handles)                                                                                                                                                                                                                                                     |

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

Runner-owned click flags handle the controls a pointer cannot reach reliably:

```yaml
- click: { by: role, role: button, name: Start task, optional: true }   # skipped when absent
- click: { by: role, role: button, name: Save, fallback: dispatch }     # pointer, else DOM click
- click: { by: selector, selector: ".dialog-close", dispatch: true }     # DOM click only
```

`optional: true` records the step as `skipped` (`skipReason: absent`) when no
visible target exists. `dispatch: true` fires a DOM click with no pointer and no
actionability wait. `fallback: dispatch` hit-tests the target first: when
another element would receive the pointer it dispatches directly and records
`detail: pointer blocked by <element>`, otherwise it tries the pointer click and
falls back when that fails. See [Widgets](/widgets#click-and-fill-flags).

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

`mode: set` writes through the native value setter and fires input/change only
— no focus, no keydown — so an autocomplete or address overlay that opens on
typing stays closed; the value is still re-read. `optional: true` skips the step
when the control is absent.

```yaml
- fill: { by: label, name: Address line 1, value: 10 Main Street, mode: set }
- fill: { by: label, name: Referral code, value: SPRING, optional: true }
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

Relative file paths in steps — `upload.path`, `transform.file` and `transform.input`, `eval.file`, and the eval host files `args.filePath` / `args.fixtureFiles` — resolve against the directory of the file that **declares** the step. In a spec that is the spec's folder; in an imported action it is the action's folder, so a shared action and its fixtures move together. An action path that only exists next to the importing spec (the old resolution) still works, with a deprecation warning naming the action and step (once per process on stderr, in every run's `run.log`). Eval host files in a spec keep their order: absolute, then the current directory, then the spec's folder. `${file.dir}` (alias `${project.root}`) is the declaring file's directory and `${config.dir}` the config's; `cairn spec verify` exits 4 when one of these files is missing where a run would look.

### `upload`

Set a file input from a local path.

```yaml
- upload: { by: label, name: File, path: ./fixtures/sample.xlsx }
```

On agent-browser the page then checks that the uploaded file is readable. When
the renderer cannot read the CDP-set file (`net::ERR_ACCESS_DENIED`,
`NotReadableError`), Cairntrace rebuilds it from the host bytes inside the page
(DataTransfer) on the input the upload changed and fires input/change again;
`run.json` records `via: setInputFiles | dataTransfer`. Playwright keeps
`setInputFiles`.

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

#### Credentials, polling, retries, captures and matrices

Everything below is optional; a request without these fields behaves as above.

```yaml
- request:                       # a bearer from an earlier response
    method: PUT
    url: /api/otp/verify
    headers: { authorization: "Bearer ${requests.login.body.token}" }
    expectStatus: 200
- request:                       # poll until the task exists, then capture its id
    url: /api/tasks
    until:
      json: { "$.tasks[?(@.title == 'Report')]": { exists: true } }
      every: 1000                # ms between attempts (default 1000)
      timeoutMs: 60000           # the whole poll (default 30000)
    capture: { taskId: "$.tasks[?(@.title == 'Report')].id" }
    assign: tasks
- open: "/tasks/${requests.tasks.captures.taskId}"
- request:                       # warming endpoint
    url: /api/report
    retry: { times: 3, on: [5xx, network], delayMs: 500 }
    expectStatus: 200
- request:                       # anonymous callers are refused everywhere
    method: ${matrix.route.method}
    url: ${matrix.route.path}
    body: ${matrix.route.body}
    headers: { authorization: "${matrix.auth}" }
    credentials: omit
    matrix:
      route:
        - { method: GET, path: /api/admin/list }
        - { method: POST, path: /api/admin/items, body: { name: denied } }
      auth: ["", "Bearer invalid"]
    expectStatus: 401
```

- `credentials: include` (default) sends the browser session's cookies and keeps any `Set-Cookie`; `omit` sends none and keeps none.
- `until: { status?, json?, every?, timeoutMs? }` re-sends the request until the answer satisfies `status` and every `json` [matcher](/verifiers#matchers). The request's own `timeoutMs` bounds each attempt. A transport error counts as "not yet". When the poll runs out, the step fails and the last answer stays in `requests/<name>.json` (with `attempts`).
- `retry: { times (1–10), on?: [5xx, network], delayMs? }` re-sends after a 5xx answer or a transport failure (both by default), `delayMs` (default 500) apart. Any 2xx–4xx answer is final. Not combined with `until`.
- `capture: { <key>: <path> }` reads the JSON body into `${requests.<name>.captures.<key>}`. Paths are the [shared ones](/verifiers#matchers) plus filters: `$.tasks[?(@.title == "x")].id` with `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!` and a bare `@.field` for presence. A wildcard or filter captures its first match. A path that matches nothing fails the step.
- `matrix: { <key>: [values] }` sends one request per combination (the cartesian product, at most 200). `${matrix.<key>}` and `${matrix.<key>.<field>}` splice into `method`, `url`, `headers` and `body`; a value that is exactly one reference keeps its type, so `body: ${matrix.route.body}` sends an object (or nothing). Every combination runs. Each status is recorded under `matrix` in `requests/<name>.json`, and the step fails listing every combination whose status is not in `expectStatus`. Not combined with `until` or `capture`.

Every `${secrets.X}` value, every sensitive header value (`Authorization`, `Cookie`, `X-Api-Key`, … and the token after a `Bearer ` scheme) and every response field under a credential-like key (`token`, `password`, …) is redacted from every artifact written after the request. `artifact.request` events add `attempts`, `combinations` and `mismatches` when they apply.

### Environment login: `use: login`

`use: login` signs a run in through the API instead of the sign-in form. With no imported action named `login`, it runs the environment's `auth:` block in [the config](/configuration#environment-login-auth):

1. `alreadyAuthenticated` (optional): a probe. When its `status` (default any 2xx) and `json` matchers hold, the session is already signed in and nothing else runs.
2. `login`: the sign-in request. Its answer is `${requests.login.…}`.
3. `after` (optional): follow-up requests, such as an OTP verify that sends `Bearer ${requests.login.body.token}`. Each can have a `when: { var: requests.login.body.…, equals | in | exists }` gate.
4. `hydrate` (optional): page JavaScript, run once after a fresh login, for an app that reads its session from a client store. It sees `args.login` (the login response body), never the credentials.

```yaml
steps:
  - use: login                                     # the environment's auth: block
  - use: { action: login, vars: { role: admin } }  # use-site vars feed ${vars.X} in auth:
  - open: /dashboard
```

`use: login` satisfies the [cold-start contract](/authoring).

Secrets come from the run's provider (`secrets.provider`; tvault fetches the names the auth block uses when a flow has `use: login`). They are resolved when the step runs, registered for redaction before the first request, and never written to an artifact. An unset one fails the step before anything is sent. Each request is evidence: `requests/login_check.json`, `login.json` and `login_after_<n>.json`. The step's `detail` says what happened, for example `logged in (POST /api/login → 200); 1 follow-up(s); hydrated`. An imported action named `login` always wins over the built-in. `retry:` is not taken here (set `retry` on the login request instead), and heal never patches the step.

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

`eval` is deliberately the last-resort, locator-free step: opaque to `heal` and bypassing the semantic-locator contract. Use it for state setup and internal-state assertions no UI affordance can reach. Prefer a typed step when one exists; `cairn spec lint` flags the evals it recognizes (`eval-typed-equivalent`):

| Eval pattern | Typed replacement |
| --- | --- |
| Open a picker, type, click an option, hope it committed | [`set` / `choose` / `form`](/widgets) (driver + read-back) |
| Click a radio or checkbox only when it is not already set | `choose` / `check` / `uncheck` (idempotent) |
| Click a control when it is present | [`click.optional: true`](#click), or `wait.optional` + `assign` + `when` |
| `el.click()` because a mask or overlay swallows the pointer | `click.fallback: dispatch` / `click.dispatch: true` |
| Native value setter + `input` / `change` events | `fill.mode: set` |
| Retry ladders, an unrolled N-step loop | [`repeat`](#control-flow) / `use: { action, retry }` |
| Branch on what the page shows | `if` / `when` (+ `wait.any`) |
| `fetch` sign-in, a bearer copied between calls, an OTP call | [`use: login`](#environment-login-use-login) with config `environments.<env>.auth` |
| `fetch` in a sleep loop until a job finishes | `request.until`, or a verifier with `poll` |
| Anonymous or authorization-boundary probes | `credentials: omit` + `matrix` + `expectStatus` |
| Read or poll a framework store | `browser.appHandle` + `wait: { app: … }` |
| An eval that throws to assert | [`expect`](#expect), or `capture` + the `value` verifier |
| Unzip a downloaded workbook | the [`xlsx`](/verifiers#xlsx) verifier (`ctx.xlsx` in a node verifier) |
| Helpers redeclared in every eval file | the `__cairn` prelude (below) |

#### Page prelude and app handles

An eval source (inline or file), a browser `script` verifier or an environment-login `hydrate` script that mentions `__cairn` gets a small helper set installed first, so evals stop redeclaring the same helpers:

| Helper | Does |
| --- | --- |
| `__cairn.sleep(ms)` | resolves after `ms` (at most 600000) |
| `__cairn.visible(el \| selector)` | rendered: connected, not `display:none` / `visibility:hidden`, non-empty box |
| `__cairn.text(el \| selector)` | whitespace-normalized rendered text (`""` when absent) |
| `__cairn.labelOf(el \| selector)` | `aria-label`, `aria-labelledby`, `<label for>` / wrapping label, then `placeholder` / `title` |
| `__cairn.nativeSet(el \| selector, value)` | writes an input / textarea / select through the prototype's native setter (a boolean on a checkbox or radio sets `checked`), fires `input` + `change`, returns the read-back |
| `__cairn.fire(el \| selector, type, init?)` | dispatches a `MouseEvent` / `PointerEvent` / `KeyboardEvent` / `FocusEvent` / `InputEvent` / `Event` that bubbles (except focus/blur/enter/leave) |
| `__cairn.rows(table \| selector)` | visible rows of a `<table>` or role table/grid as `{ <header>: <cell> }` records (`columnN` for an empty header) |
| `__cairn.waitFor(fn \| selector, { timeoutMs?, intervalMs? })` | polls until `fn()` is truthy (or the selector is visible) and resolves with it; rejects after `timeoutMs` (default 5000) naming the last error |
| `__cairn.app.<name>` | the config `browser.appHandle` accessors |

The prelude only defines `window.__cairn` (non-enumerable and read-only), is installed once per document (later sources reuse it and refresh the app handles), and never overwrites a page that already defines `window.__cairn` — the step fails with that message instead. Sources that do not mention `__cairn` are sent unchanged.

Config `browser.appHandle` names read-only accessors: each value is a page expression evaluated on every read, so a store getter stays live.

```yaml
# cairntrace.config.yml
browser:
  appHandle:
    store: document.querySelector("#app").__vue_app__.config.globalProperties.$store
    user: document.querySelector("#app").__vue_app__.config.globalProperties.$store.state.auth.user
```

```yaml
# a spec
- wait: { app: { path: user.id, exists: true }, timeoutMs: 15000 }
- wait: { app: { path: store.getters.cart/count, in: [1, 2] } }
- eval:
    js: "return { rows: __cairn.rows('#people').length, admin: __cairn.app.user.roles.includes('admin') };"
    assign: page
```

`wait: { app: { path, equals | in | exists } }` waits for a value instead of an eval loop: `path` starts with a handle name and walks properties (`store.items[0].status`; a segment may hold `/`, as in the namespaced getter `store.getters.cart/count`). `equals` and `in` compare JSON deeply. App waits are polled by the runner with short bounded probes, like `optional` waits, and take `optional`, `assign` and a place in `wait.any` / `wait.all`. The value never leaves the page. A failure message carries a preview of at most 200 characters, which masks values under credential-like keys (`[redacted]`), shows long or token-shaped strings by length only (`<string, N chars>`), and is never cut inside a string. A path with a credential-like segment (`store.auth.token`) is shown only by type and length. A path whose handle is not configured fails the step at once. Handle expressions are project code, like eval files: they are syntax-checked by `cairn config validate` and run only in the page.

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

## Control flow

Loops, branches and retries are typed steps, so a flow that clicks "Load more"
until the list is complete, dismisses a banner only when it shows up, or retries
a flaky dialog stays reviewable — no unrolled step ladders, no `eval` loops.

### `repeat`

Run nested steps up to `max` times (at most 100).

```yaml
- id: load_all
  repeat:
    max: 20
    until: { text: All rows loaded }
    steps:
      - click: { by: role, role: button, name: Load more }
      - wait: { notText: Loading }
- id: tag_rows
  repeat:
    max: 3
    indexVar: row
    steps:
      - click: { by: selector, selector: "tbody tr:nth-child(${repeat.iteration}) .tag" }
```

- `until` uses the `when:` grammar. It is checked before every iteration and once more after the last; the loop stops as soon as it holds (an `until` that already holds runs zero iterations).
- Reaching `max` with an `until` that never held fails the step (`onMax: fail`, the default) or passes it (`onMax: continue`). Without `until` the loop runs exactly `max` times.
- Nested steps see `${repeat.index}` (0-based) and `${repeat.iteration}` (1-based) of the innermost loop, and `${repeat.<indexVar>}` (0-based) of every enclosing loop that names one.
- A failing nested step fails the repeat and the run.

### `if`

Check a condition once and run one branch.

```yaml
- id: cookie_banner
  if:
    condition: { selector: "#cookie-banner" }
    then:
      - click: { by: role, role: button, name: Accept }
    else:
      - wait: { ms: 100 }
```

The condition uses the `when:` grammar. Without `else`, a false condition runs nothing and the step passes.

### Conditions: `when`, `until`, `condition`

`when:`, `repeat.until`, `if.condition` and `use.retry.until` share one grammar: the string form (`text:Saved`, `notText:Loading`, `urlContains:/done`, `urlNotContains:…`, `urlMatches:…`, `selector:…`, `notSelector:…`) or the object form with exactly one of `urlContains`, `urlNotContains`, `urlMatches`, `url` (`includes | equals | pattern`), `text`, `notText`, `selector` (+ `hasText`), `notSelector`, or `var`. A condition is read once and never waits.

`var` predicates compare a value as a string with exactly one of `equals`, `in` or `exists` (`exists: true` holds for a set, non-empty value):

```yaml
- when: { var: mode, equals: fast }            # config / spec / use-site var
  click: { by: role, role: button, name: Skip tour }
- when: { var: region, in: [eu, uk] }
  click: { by: role, role: button, name: Accept GDPR terms }
- when: { var: waits.banner.matched, equals: true }   # a runtime value
  click: { by: role, role: button, name: Dismiss }
```

A plain name reads the vars of the file that declares the step — inside an action that includes the `use:` call's `vars`. A dotted name reads a runtime value: `waits.<name>.matched` / `.index`, `repeat.index` / `repeat.iteration` / `repeat.<indexVar>`, `captures.<name>.…`, `runs.<name>.…`, `requests.<name>.…`, `evals.<name>.…`, `fixtures.<name>.…`.

### `wait.any`, `wait.all`, `optional`

```yaml
- id: save_result
  wait:
    any:
      - { text: Saved }
      - { text: Already exists }
    timeoutMs: 15000
    assign: saved              # ${waits.saved.matched}, ${waits.saved.index}
- id: maybe_banner
  wait: { text: Maintenance window, timeoutMs: 2000, optional: true, assign: banner }
```

- `any` passes on the first condition that holds; `all` needs every condition at the same poll. Both take one `timeoutMs` for the group (default 30000 × `waitScale`); members take no `timeoutMs` of their own.
- `optional: true` never fails the step: a condition that does not hold within `timeoutMs` passes it with `matched: false`.
- `assign: <name>` exposes `${waits.<name>.matched}` (`true` / `false`) and, for `any`, `${waits.<name>.index}` (0-based) to later steps, `when:` and `if:`.
- Groups and optional waits are polled by the runner with short bounded probes (page text, URL, a DOM predicate, a control value; `load` reads `document.readyState`), so a miss never stops the browser.

### `use` with `retry`

```yaml
- id: save
  use:
    action: submit_form
    retry: { times: 2, until: { text: Saved }, delayMs: 500 }
```

The action's steps run as one group; when one of them fails, or `until` does not hold after they all passed, the group runs again — at most `times` (1–10) more attempts. An exhausted retry fails the step with the last attempt's error. A retried attempt's failed steps leave `run.json` `steps` (their errors are kept under the step's `retries`, and the events keep the `step.failed` with its `iteration`).

### Ids, events and artifacts of nested steps

A nested step keeps its own `id`, otherwise it is `<parent id>.<n>` (repeat body, retried action) or `<parent id>.then.<n>` / `<parent id>.else.<n>`. `step.started` / `step.finished` / `step.failed` events and `run.json` results carry `parentId`, `iteration` (1-based iteration or attempt) and `branch`; a block's own result adds `iterations` (repeat, retry), `taken` (`then | else | none` for `if`) and `matched` (optional or grouped waits). Results are recorded post-order — a block's steps before the block — so the first failed entry is the innermost failure. Screenshots, snapshots, diagnostics and `expects/` files get an `_i<n>` (iteration) or `_a<n>` (attempt) suffix so repeated executions never overwrite each other. A `request` without `assign` inside a block is named after its place — `request_<top>_<n>` for the n-th step of a repeat body or retried action, `request_<top>_then<n>` / `_else<n>` in an if branch, plus the suffix (`request_3_2_i2`) — so each execution keeps its own `requests/<name>.json` and `${requests.<name>}`. A request with `assign` keeps that name: the latest execution wins. Give every step its own id: `cairn spec lint` reports an id used twice (`duplicate-step-id`; an error inside blocks).

`cairn spec heal` does not patch nested steps (it reports `no-heal-possible`); fix them by hand or heal the step at the top level. Control flow is not allowed in `teardown:`. `cairn export playwright` renders `repeat` as a bounded `for` loop, `if` as `if/else`, `wait.any` / `wait.all` as `Promise.any` / `Promise.all` and a retried `use` as a `try/catch` loop; a condition that reads a capture, a run output or a fixture is a hard skip unless an exported step (`capture`, or `run:` with `--preconditions inline|global`) or the global setup binds it. `capture` steps, the `table` verifier and verifier `poll` export; `run:` steps and `teardown:` export with `--preconditions inline|global` (see [Export](/export)).

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

### `run`

Run a host command or a node script as a step: provision a fixture, seed rows, restart a worker, clean up. Use it instead of an outcome with side effects (outcomes are the contract and must stay pure) or of a precondition that only exists to mutate.

```yaml
steps:
  - id: provision
    run:
      node: ./fixtures/provision-entities.mjs   # relative to the file that declares the step
      args: [--count, 3]
      timeoutMs: 60000
      assign: fixture                           # last stdout line must be JSON
  - open: /entities/${runs.fixture.entity.id}
  - run:                                        # object form: args become $1…$n
      shell: 'node ./fixtures/clear-rows.mjs "$1"'
      args: ["${runs.fixture.entity.id}"]
  - run: 'node ./fixtures/reset-cache.mjs'      # string form = shell, no args
```

- `shell` runs through `/bin/sh -c`; `args` arrive as `$1…$n` and are never spliced into the script text. The string form is a `shell` with **no** `args`, so `$1` is always empty there — pass values through the object form's `args`. `node` runs `node <file> [args]` (the `node` on `PATH`). Exactly one of the two. `cwd` defaults to the declaring file's directory; `env` adds variables.
- The child gets the run context: `CAIRN_ENV`, `CAIRN_BASE_URL`, `CAIRN_RUN_ID`, `CAIRN_RUN_DIR`, `CAIRN_RUN_TOKEN`, `CAIRN_CONFIG_DIR` (and, in `teardown:`, `CAIRN_RUN_STATUS`). It never gets the publisher or TinyVault control variables.
- `timeoutMs` (default 120000) is a hard deadline: the command runs in its own process group, and the whole group — background processes included — is killed; the step fails with the tail of its output. A cancelled run kills it the same way. A non-zero exit fails the step.
- The step ends when the command exits, even if a process it started in the background (`server &`) still holds its output open; the step then stops reading that output, so redirect a background process's output (`server > server.log 2>&1 &`) if it must keep running.
- With `assign`, the last non-empty stdout line is parsed as JSON (print progress on stderr). Later steps — and teardown — splice it as `${runs.<assign>.<path>}`; objects render as JSON, unknown paths as `""`.
- Step events use kind `run` and a label without the command text (`run node provision-entities.mjs → fixture`), because substituted placeholders may hold secrets. Output is captured, not streamed live.

## Teardown

`teardown:` is a spec-level list of steps that always runs after the steps and outcomes — when the run passed, failed, errored (a failed precondition or [readiness gate](/services#readiness-gates) included) or was cancelled. Use it for the cleanup that used to hide in outcomes or in `--after` hooks.

```yaml
teardown:
  - run:
      shell: 'node ./fixtures/cleanup.mjs "$1" "$CAIRN_RUN_STATUS"'
      # args resolve like any step: ${runs.<assign>…}, ${requests.<name>…}, ${evals.<name>…}
      args: ["${runs.fixture.entity.id}"]
  - request: { method: DELETE, url: "/api/entities/${runs.fixture.entity.id}" }
```

With a policy:

```yaml
teardown:
  failRun: true      # a failed teardown step errors a run that passed (default false)
  timeoutMs: 120000  # budget of the whole teardown (default 300000)
  steps:
    - run: { node: ./fixtures/cleanup.mjs, timeoutMs: 30000 }
```

- Every item runs, in order, even after an earlier one failed; each is bounded by what is left of `timeoutMs`. Teardown supports `run`, `request`, `eval` and browser actions; `use:` is not expanded there (inline the steps), and `download` / `upload` / `transform` / `monitor` (they produce run artifacts) and `expect` / `capture` (cleanup does not verify) are refused by the schema.
- `CAIRN_RUN_STATUS` is `passed`, `failed` or `errored` — the verdict before teardown. A cancel reports `errored`; its browser was closed, so browser items are `skipped` while `run` items still run (a cancel does not kill teardown commands).
- On **SIGINT/SIGTERM** the process is about to exit: the `run` items that have not started yet run synchronously from the signal handler, before the CLI kills the browser and services, within min(`timeoutMs`, 30000) ms, with `CAIRN_RUN_STATUS=errored` and `CAIRN_RUN_SIGNAL`. Other kinds cannot run there. Each item still runs once: a host that survives the signal (`cairn mcp`) finishes the cancelled run, and its teardown skips the items the signal handler already ran.
- A failed teardown item is reported — `teardown.started` / `teardown.finished` events (`index`, `kind`, `stepId`, `status` passed | failed | skipped, `durationMs`, `error`), a `run.log` line and a CLI warning — but the run keeps its status. Only `failRun: true` changes it, and only from `passed` to `errored` (`failure.phase: teardown`); an outcome failure stays the verdict. The banner shows `phase: teardown` with the item and its budget.

## Assertions & captured values

### `expect`

Assert mid-flow and record evidence like an outcome — the typed replacement for an `eval` that throws when the page is in the wrong state. A locator (the same `by: role|label|text|selector|testid` vocabulary and strict matching rules as `click`) plus any of these assertions; every present one must hold:

```yaml
steps:
  - expect: { id: saved_banner, by: role, role: status, visible: true, text: { contains: Saved } }
  - expect: { by: role, role: button, name: Submit, enabled: false }
  - expect: { by: selector, selector: ".worker-row", count: { atLeast: 1 } }
  - expect: { by: label, name: Email, value: ops@example.test }
  - expect: { by: role, role: link, name: Next, attribute: { name: href, contains: "page=2" } }
  - expect: { by: role, role: dialog, hidden: true, timeoutMs: 10000 }
  - expect:
      request: { url: "/api/orders/${captures.order.id}", json: { status: shipped } }
```

| Assertion | Meaning |
|---|---|
| `visible: true` | a visible match exists (`nth` picks one) |
| `hidden: true` / `visible: false` | no visible match (absent or hidden) |
| `count` | number of matches: a number or `{ equals \| atLeast \| atMost }` (semantic locators count visible matches, CSS/testid count DOM matches) |
| `text` | string (= `equals`) or `{ equals \| contains \| matches, caseSensitive }` — whitespace-normalized, case-insensitive by default |
| `value` | live control value: string or `{ equals \| contains \| matches }`, raw |
| `attribute` | `{ name, equals \| contains \| matches \| exists }` |
| `enabled` | `true` / `false` (disabled, `aria-disabled`, inside a disabled fieldset) |

- `text`, `value`, `attribute` and `enabled` need one target: several matches narrow to the visible one, otherwise add `nth`.
- Inside `expect`, `visible` / `hidden` are assertions (not the locator's include-hidden switch). For `by: text` the `text` key is the locator, not a text assertion.
- `request` sends `{ method (default GET), url, headers?, body? }` with the browser session (like a `request` step) and checks `status` (default 2xx; a number or `{ equals | below | atLeast | in }`) and `json: { path: matcher }` ([matchers](/verifiers#matchers)). Only GET/HEAD are repeated while waiting.
- The expectation is retried every 250ms until `timeoutMs` (default 5000, scaled by `waitScale`). A mismatch fails the step: `expect <id>: expected …; got …`.
- Evidence: `expects/<NNN>_<id>.json` (`{ id, stepId, status, kind, expected, actual, attempts, durationMs, observed }`, redacted and bounded) and an `expect.passed` / `expect.failed` event; `id` defaults to the step id.
- The page is read through one bounded `backend.evaluate` probe per attempt that resolves the locator in the page (accessible role and name computed from `role`, implicit HTML roles, `aria-labelledby`, `aria-label`, labels, `alt`, `title`, `placeholder` and content). Rare edge cases can differ from a backend's snapshot; use `by: testid` / `by: selector` when exact DOM identity matters.

### `capture`

Store a structured value from the page for later steps and outcome verifiers, as `${captures.<assign>…}` (and `captures/<assign>.json`). Exactly one source:

```yaml
steps:
  - capture: { assign: rowsBefore, table: { by: testid, testid: workers-table } }
  - capture: { assign: companyName, text: { by: role, role: heading, name: Company } }
  - capture: { assign: email, value: { by: label, name: Email } }
  - capture: { assign: nextHref, attribute: { by: role, role: link, name: Next, attributeName: href } }
  - fill: { by: label, name: Search, value: "${captures.companyName}" }
```

- `text`: the target's whitespace-normalized text. `value`: the live control value. `attribute`: the attribute named by `attributeName` (`null` when absent).
- `table`: `{ headers, rows: [{ <header>: <cell> }], cells: [[…]], rowCount }` from a `<table>` or role `table`/`grid` (hidden rows skipped; an empty header becomes `columnN`). Read `${captures.rowsBefore.rowCount}` or `${captures.rowsBefore.rows.0.Name}`.
- Waits up to `timeoutMs` (default 5000 × `waitScale`) for the target; a missing or ambiguous target fails the step.
- In later steps a capture splices as text (objects as JSON; unknown names as `""`). `expect` and `capture` steps resolve references themselves: locator and text fields as text, `count` and `expect.request` `json` values typed (`count: "${captures.rows.rowCount}"` compares a number), and an unknown name fails the step instead of becoming `""`. In outcome verifiers (`value`, `mongo`, `http`, …) a string that is exactly one `${captures.…}` keeps its type, and an unknown name fails or blocks the outcome instead of becoming `""`.

## Widgets and forms

Custom form controls are typed steps that write through a widget driver and
read the value back — the step fails with evidence (`widgets/<n>_<id>.json`)
when the field does not show what was written. Targets are `field: <key>`
(resolved through config `browser.fieldRoot`) or any locator.

```yaml
- set: { field: country, value: Spain }                       # vue-multiselect, select, input…
- set: { field: start_date, value: "2026-11-30" }             # PrimeVue calendar picker
- set: { field: contact, value: { query: Ada, option: Ada Lovelace } }
- check: { field: terms }
- uncheck: { field: services, option: Consulting }
- choose: { field: business_owner, option: "No" }
- form:
    fields:
      setup: Shared entity
      entity_code: { value: C100, dependsOn: setup }
      legacy_supplier: { value: "No", optional: true }
    onFailure: dumpUnanswered
```

Built-in drivers: `vue-multiselect`, `primevue-autocomplete`,
`primevue-calendar`, `pills`, `radio-group`, `checkbox-group`, `native-select`,
`native-input`; project drivers come from `browser.widgets`. Every widget step
is idempotent (a field already holding the value is left alone), and `form`
re-reads every field at the end so a later field that wiped an earlier one
fails. See [Widgets](/widgets) for the drivers, evidence, custom driver
contract and its trust model.

## Step output

Every step produces timing and status entries in `events.ndjson`, and its final
result is included in `run.json`, even when no screenshot is requested. Steps
gated by `when:` produce a skipped event. Steps nested in a `repeat`, `if` or
retried `use` carry `parentId` / `iteration` / `branch` (see
[Control flow](#control-flow)). A failed browser step writes
`diagnostics/<step-ordinal>_<step-id>.json` with the captured page diagnostics
when the backend is still responsive.

## What is deliberately not a step

- No `sleep N` — every wait is conditional on a typed observable.
- No per-step backend choice — backends live in `cairntrace.config.yml`, not in steps.
- No per-agent code paths. The CLI + MCP server + artifact shape are the interface; steps do not know who is reading them.

## See also

- [Widgets](/widgets) — set / check / choose / form, drivers and interaction flags
- [Verifiers](/verifiers) — the outcome vocabulary evaluated against the post-step snapshot
- [Snippets](/snippets) — `imports:` / `use:` for reusable action files
- [Process monitoring](/monitor) — the `--monitor` run flag and `process` verifier
- [Authoring](/authoring) — what makes a contract survive across months
