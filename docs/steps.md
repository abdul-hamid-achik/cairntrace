# Steps

The step vocabulary. Every `step:` entry below is a typed verb the runner knows. The vocabulary is closed; if your intent does not map to one of these, use `script:` or a `request:` step, never invent a new shape.

## Navigation

### `open`

Open a URL on the current page. The runner waits for the load lifecycle event by default; override with `waitUntil` for hydration-sensitive pages.

```yaml
- open: { path: "/products/42" }
- open: { path: "/dashboard", waitUntil: networkidle }
- open: { path: "/login", query: { next: "/account" } }
```

### `wait`

Wait for an arbitrary page condition. Hard-bounded at 30000 ms by default.

```yaml
- wait: { load: networkidle }
- wait: { selector: "[data-testid='hydrated']", state: visible, timeoutMs: 5000 }
```

### `goto` (alias)

If your team prefers the request-step semantics for navigation, `goto` is just `open` with the same shape — both go through the same backend.

## Interaction

### `click`, `hover`, `scroll`, `paste`

Standard DOM interaction steps.

```yaml
- click: { by: { role: button, name: "Submit" } }
- hover: { by: { role: link, name: "Account" } }
- scroll: { to: "[data-testid='footer']" }
- paste: { by: { role: textbox, name: "Notes" }, text: "fast paste from variable" }
```

### `type`, `key`, `keypress`

Keyboard input. `type` types a string; `key` and `keypress` both press a single named key (`Enter`, `Tab`, `Escape`, arrows, function keys).

```yaml
- type: { by: { role: textbox, name: "Email" }, text: "user@example.com" }
- key:  { by: { role: textbox, name: "Email" }, value: Enter }
```

### `fill`, `clear`, `select`

Convenience steps for forms. Prefer typed interaction when the field semantics matter (`<select>` vs `<input list>` differ).

## Capture

### `screenshot`

Take a single PNG screenshot of the viewport. Bundled in `screenshots/` with the step ordinal.

### `capture`

Bind a screenshot, a snapshot, or a network call to a named handle you can reference later. Useful for "capture the value of this card into a variable," which the runner turns into `${captures.card.title}` substitution.

```yaml
- capture:
    name: card
    as: { text: { by: { role: heading, name: "Plan" } } }
```

### `checkpoint`

Persist the browser state (cookies, local storage, IndexedDB) to a named checkpoint you can later resume with `session: { resume: <name> }`. Captures are explicit, never implicit.

```yaml
- checkpoint: { save-as: admin }   # run-once, later resumes
```

The matching resume lives at the spec root:

```yaml
session: { resume: admin }
```

## Server-side

### `request`

Make a typed HTTP request from inside the browser session. Cookies are inherited automatically (this is the reason `request` lives in the same vocabulary as DOM steps, not next to `script`).

```yaml
- request:
    name: create-entity
    method: POST
    url: /api/entities
    body: { name: "x" }
    assign: { entityId: "${requests.create-entity.body.id}" }
```

Then later:

```yaml
- click: { by: { role: link, name: "${requests.create-entity.body.name}" } }
```

`assign:` writes response fragments to `${requests.<name>.body.X}` so any later step can splice them in.

## Compound

### `batch`

Run two or more selector-only sub-steps in a single backend invocation. Use `batch` whenever the UI has a transient state that has to survive across interactions (a hover that reveals a popover you then click; a press-and-hold that opens a context menu).

```yaml
- batch:
    steps:
      - hover: { by: { css: "[data-testid='menu-trigger']" } }
      - click: { by: { css: "[data-testid='menu-item-delete']" } }
```

`batch` does not allow semantic locators (`by: role|...`) inside its sub-steps; it requires selector-only inputs. That is a feature — selector-only paths are deterministic for the duration of the batch.

## Control flow

### `when`

Conditional step. Skip the whole step (do not run, do not capture) when the predicate is false.

```yaml
- when: { env: FEATURE_BANNER, equals: "on" }
- click: { by: { role: button, name: "Dismiss banner" } }
```

### `controls`

Run a JS evaluation that returns a control value to the runner. Use sparingly — if you reach for `controls` you are usually describing a typed step that does not exist yet, in which case open an issue rather than encoding it as a script.

### `script`

Last-resort step. Anything the typed vocabulary cannot express. Wrap named assertions in `cairn.run.assert(...)` and write a `outcomes/<id>.raw.json` sidecar so the artifact shape stays consistent.

```yaml
- script:
    run: |
      return document.title.includes("checkout")
    assign: { onCheckout: true }
```

## Step output

Every step produces an entry in `screens/final.txt`, `events.ndjson`, and `frames/frames.ndjson` even when no screenshot is requested — that is the agent-context substrate. Steps that are gated by `when:` produce a `skipped` record; steps that failed are surfaced with the full DOM diff in `diagnostics/failure.md`.

## What is deliberately not a step

- No `sleep N` — every wait is conditional on a typed observable.
- No custom backends with side-effects — backend choices live in `cairntrace.config.yml`, not in steps.
- No per-agent code paths. The CLI + MCP server + artifact shape are the interface; steps do not know who is reading them.
