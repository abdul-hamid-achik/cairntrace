# Steps

The step vocabulary. Every `step:` entry below is a typed verb the runner knows. The vocabulary is closed — exactly the 17 steps the `StepSchema` union accepts; if your intent does not map to one of them, use `eval` (page-context JS) or `request` (typed API call), never invent a new shape. Run `cairn explain --format json` for the machine-readable surface.

Every step also accepts two optional common keys:

- `id: <name>` — a stable step label for cross-referencing in artifacts.
- `when: <condition>` — skip the whole step (do not run, do not capture) when the condition string is false. Conditions are simple names like `notAuthenticated`, resolved by the runner.

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
- wait: { load: networkidle }
- wait: { selector: "[data-testid='hydrated']", state: visible }
```

Four condition shapes, exactly one per step:

| Shape | Asserts |
|---|---|
| `text: <str>` | the page contains the text |
| `notText: <str>` | the page does not contain the text |
| `load: networkidle\|load\|domcontentloaded` | a load state was reached |
| `selector: <css> + state?` | an element matches; `state` is `attached\|visible\|hidden\|detached` |

## Interaction

### `click`

Activate a locator. Semantic locators match accessible names (whole-name, case-insensitive; `exact: true` for case-sensitive), scroll into view first, and fail loudly on zero or ambiguous matches. `nth:` picks among several.

```yaml
- click: { by: role, role: button, name: Save }
- click: { by: role, role: button, name: Cobrar, nth: 1 }
- click: { by: selector, selector: "button.primary" }
```

### `hover`

Move the pointer over a locator to reveal hover-only UI.

```yaml
- hover: { by: selector, selector: ".question-table-wrap .table-title" }
```

### `fill`

Set a field's value in one bulk operation.

```yaml
- fill: { by: label, name: Email, value: "user@example.com" }
```

`fill` is a value-set, not keystroke events. SPA frameworks whose validation listens for `keydown`/`keyup`/`input` may not react — the classic symptom is a submit button staying `[disabled]` after `fill`. Use `type` when the framework needs real key events.

### `type`

Type text character-by-character into a field, sending each character as a real keyboard event. This is what reactive frameworks (Vue, React) need to fire their form validation. `delayMs` adds a per-keystroke delay for slow, debounced validators (default 0).

```yaml
- type: { by: label, name: Token, value: "${requests.qr.body.token}", delayMs: 50 }
```

### `press`

A single keyboard key press — `Enter` to submit, `Control+a` to select, `Escape` to dismiss.

```yaml
- press: Enter
- press: "Control+a"
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

### `download`

Click a locator and capture the resulting download. `saveAs` names the file in the artifact dir; `assign` registers it as a named artifact so later steps and verifiers reference it via `${artifacts.<assign>.path}`.

```yaml
- download: { by: role, role: button, name: "Download template", saveAs: template.xlsx, assign: template }
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

`monitor` is handled by the runner *before* adapter dispatch — it is not a backend interaction. Pair it with the run-wide `--monitor` flag and the `process` verifier (see [Process monitoring](/monitor)) to turn "the spec got slow" into an assertable budget.

## Step output

Every step produces an entry in `events.ndjson` and `frames/frames.ndjson` even when no screenshot is requested — that is the agent-context substrate. Steps gated by `when:` produce a `skipped` record; steps that failed are surfaced with the full DOM diff in `diagnostics/failure.md`.

## What is deliberately not a step

- No `sleep N` — every wait is conditional on a typed observable.
- No per-step backend choice — backends live in `cairntrace.config.yml`, not in steps.
- No per-agent code paths. The CLI + MCP server + artifact shape are the interface; steps do not know who is reading them.

## See also

- [Verifiers](/verifiers) — the outcome vocabulary evaluated against the post-step snapshot
- [Snippets](/snippets) — `imports:` / `use:` for reusable action files
- [Process monitoring](/monitor) — the `--monitor` run flag and `process` verifier
- [Authoring](/authoring) — what makes a contract survive across months