---
title: Widgets, Forms and Interaction Flags
description: Fill custom form controls (vue-multiselect, PrimeVue calendar and autocomplete, radio and checkbox groups, pills) with typed set, check, choose and form steps that read every value back, plus click optional/dispatch/fallback and fill mode set.
---

# Widgets, forms and interaction flags

Custom form controls are where browser specs rot into `eval` files: open the
picker, type into a search box, click an option, hope it committed. The widget
kit replaces that with typed steps. Each one finds the field, picks a **widget
driver**, writes the value in the page, then **reads it back** — and fails with
evidence when the field does not show what was written.

```yaml
steps:
  - choose: { field: business_owner, option: "No" }
  - set: { field: country, value: Spain }
  - set: { field: start_date, value: "2026-11-30" }
  - check: { field: terms }
  - form:
      fields:
        setup: Shared entity
        entity_code: { value: C100, dependsOn: setup }
        products: [Widget A, Widget B]
        legacy_supplier: { value: "No", optional: true }
      onFailure: dumpUnanswered
```

Run `cairn docs widgets` (MCP `cairn_docs` with topic `widgets`) for the same
guide in agent-sized form.

## Steps

| Step | Shape | What it does |
| --- | --- | --- |
| `set` | `{ field \| locator, value, driver?, optional?, timeoutMs? }` | Write `value` through the detected driver and read it back. |
| `check` | `{ field \| locator, option? }` | Tick a single checkbox, or `option` of a checkbox or radio group. |
| `uncheck` | `{ field \| locator, option? }` | Clear a single checkbox or a checkbox-group option. |
| `choose` | `{ field \| locator, option }` | Pick one option of a single-choice field (radio group, select, single picker). |
| `form` | `{ fields, verify?, onFailure?, timeoutMs? }` | Set several fields in order, then re-read them all. |

Values are text or numbers, an ISO date (`YYYY-MM-DD`) or `today` for a
calendar, a boolean for a single checkbox, a list for multi-selects, checkbox
groups and pills, or `{ query, option }` for a searchable picker (type `query`,
pick the option labelled `option`).

Every widget step is **idempotent**: before writing, the driver reads the field
and leaves it alone when it already holds the value (status `already`). That
matters for radio groups that clear on a second click.

## Finding fields

A widget step targets `field: <key>` or any locator (`by: role | label | text
| selector | testid`, the same strict rules as `click`). A key resolves through
`browser.fieldRoot` in `cairntrace.config.yml`:

```yaml
browser:
  fieldRoot:
    - '[data-field-key$=".{key}"]'   # the key is the suffix of a dotted path
    - '[data-field-key="{key}"]'
```

`{key}` is replaced (quote-escaped inside quotes, CSS-escaped elsewhere).
Templates are tried in order and the first one with a **visible** match wins,
so a hidden duplicate of the same question in another tab is never the target.
Nested matches collapse to the outermost element, and radios or checkboxes that
share one `name` resolve to their group. Without `fieldRoot`, the defaults are
`[<testIdAttribute>="{key}"]` and `[name="{key}"]`.

A field that is not on the page yet is waited for up to the step budget
(`timeoutMs`, default 10000 × `waitScale`). With `optional: true` the presence
check is short (~750 ms) and an absent field records the step as `skipped`
with `skipReason: absent`.

## Drivers

The first driver whose `match(root)` claims the field writes it;
`driver: <name>` forces one. Built-ins, in detection order:

| Driver | Writes | Reads back |
| --- | --- | --- |
| `vue-multiselect` | Opens the component, picks the option straight from the rendered list (a search filter that does not match the label cannot hide it), types to search remote lists, clicks the option, falls back to pointer + Enter. Lists deselect extra tags. | `.multiselect__single`, or the tags of a multiple select |
| `primevue-autocomplete` | Types the query, waits for the overlay (found through the input's `aria-controls`), clicks the suggestion. | The input value, or the chips in multiple mode |
| `primevue-calendar` | ISO dates and `today` go through the picker (month navigation, day cell, Today button); other text is typed and must survive blur. A read-only input (`manualInput: false`) asks for an ISO date. | The input, compared by date parts (`03/15/2027` matches `2027-03-15`) |
| `pills` | PrimeVue Chips add on Enter; a `+Add` list reveals an input committed with Tab. Pills only add. | Chip labels and input values; passes when every listed item is present |
| `radio-group` | Native and ARIA radios, matched by label (a value attribute also works). | The checked option's label |
| `checkbox-group` | Native and ARIA checkboxes; a single checkbox takes a boolean. | Checked labels, or a boolean |
| `native-select` | Sets `<select>` (single or multiple) by label or value, fires input/change. | Selected labels |
| `native-input` | Native value setter + input/change (no focus, no keys). A root with several text inputs is refused rather than guessed. | The value |

Options match by label: an exact match (case- and whitespace-insensitive)
first, then one unique "contains" match. An ambiguous label fails and lists the
candidates; a missing one lists the options that were there.

## Forms

`form.fields` runs in declared order. Each field is a value, or an object:

```yaml
- form:
    fields:
      owner: "No"
      contact: { value: { query: Ada, option: Ada Lovelace }, dependsOn: owner }
      legacy: { value: "No", optional: true }
      legacy_reason: { value: Merged, dependsOn: legacy }
    verify: committed       # default; `none` writes without reading back
    onFailure: dumpUnanswered
```

- `dependsOn` names earlier fields. The dependent field gets the full mount
  wait once they are written, and is skipped when one of them was skipped.
- After the last field, **every written field is re-read once more**: a later
  field that re-rendered the form and wiped an earlier answer fails the step.
- `onFailure: dumpUnanswered` adds the page's empty fields to the evidence,
  enumerated from attribute templates such as `[data-field-key$=".{key}"]`.
- Keys must not be plain integers — JavaScript reorders such keys.

## Evidence

Each widget step writes `widgets/<n>_<id>.json`:

```json
{
  "version": 1,
  "stepId": "answer_form",
  "kind": "form",
  "status": "failed",
  "error": "form field \"country\": vue-multiselect did not commit \"Spain\"; field shows \"\"",
  "fields": [
    { "field": "owner", "status": "committed", "driver": "radio-group",
      "expected": "No", "actual": "No", "durationMs": 12,
      "final": { "status": "present", "matches": true } },
    { "field": "country", "status": "failed", "driver": "vue-multiselect",
      "expected": "Spain", "actual": "", "root": "div.question",
      "rootText": "Country * Type to search", "durationMs": 2410 }
  ]
}
```

The file goes through the run redactor, and password controls and
sensitive-looking keys are masked. Each field also emits a `widget.field` event
(key, driver, status — never the value), and `run.json` step results carry
`driver` and `via`.

## Custom drivers

A project driver is a module listed under `browser.widgets`. Listing drivers
also sets the detection order; the native drivers are appended when not listed.

```yaml
browser:
  widgets:
    - use: vue-multiselect
    - file: ./drivers/user-picker.js
```

```js
// drivers/user-picker.js
export default {
  name: "user-picker",
  match: (root) => !!root.querySelector(".user-picker"),
  read: (root) => (root.querySelector(".user-card .name")?.textContent ?? "").trim(),
  async write(root, value, ctx) {
    ctx.pointer(root.querySelector(".user-picker__open"));
    ctx.typeText(root.querySelector(".user-picker input"), String(value));
    const option = await ctx.waitFor(() =>
      [...document.querySelectorAll(".user-picker__option")].find((el) =>
        el.textContent.includes(value),
      ),
    );
    if (!option) throw new Error("no option " + value);
    ctx.pointer(option);
  },
};
```

The contract is `{ name, match(root, ctx), read(root, ctx), write(root, value,
ctx), equals?(actual, expected) }`, exported with `export default` or
`module.exports` (no imports). `read` returns a string, a list or a boolean;
`write` may return `{ label }` (what the field should show when it differs from
the value) or `{ via }`. `ctx` provides `sleep`, `waitFor(fn, ms)`, `fire(el,
type)`, `pointer(el)`, `press(el, key)`, `nativeSet(el, value)`, `typeText(el,
text)`, `matchOption(items, wanted, labelFn)`, `note(text)`, `option`,
`deadline` and `remaining()`.

**Trust model.** A driver module is project code with the same trust as an
`eval` file. Its source is sent into the page with every widget call and runs
with the page's privileges; Cairntrace compiles it when it is loaded (a syntax
error fails the step that needs it) but never executes it in Node. Review
driver changes like any other test code.

## Click and fill flags

```yaml
- click: { by: role, role: button, name: Start task, optional: true }
- click: { by: role, role: button, name: Save, fallback: dispatch }
- click: { by: selector, selector: ".dialog-close", dispatch: true }
- fill: { by: label, name: Address line 1, value: 10 Main Street, mode: set }
- fill: { by: label, name: Referral code, value: SPRING, optional: true }
```

- `click.optional: true` skips the click (status `skipped`) when no visible
  target shows up within a short presence window (750 ms × `waitScale`), or
  when the target vanished before a failed click. Presence is decided in the
  page by the same locator resolver `expect` uses: it sees open shadow roots
  and names that come from an image's `alt`, but not closed shadow roots or
  iframes, and its `near` ranking can differ from the backend's. For such
  targets, use a plain click or a `when:` gate.
- `click.dispatch: true` fires a DOM click on the resolved element — no
  pointer, no actionability wait. A disabled target fails.
- `click.fallback: dispatch` hit-tests the target first. When another element
  would receive the pointer (a leftover modal mask), it dispatches directly and
  records `detail: pointer blocked by div.p-dialog-mask`; otherwise it clicks
  with the pointer and falls back to the DOM click when that fails.
  `dispatch` and `fallback` cannot be combined with `until` or a
  `postcondition`.
- `fill.mode: set` writes through the native value setter and fires
  input/change only — no focus, no keydown — so an address or autocomplete
  overlay that opens on typing stays closed. The value is read back like a
  normal `fill`.
- `fill.optional: true` skips a control that is absent after the same presence
  window.

`run.json` records the path taken in `via` (`pointer`, `dispatch`, `set`).

## Uploads on agent-browser

agent-browser sets file inputs through CDP with a host path. Some Chrome builds
accept it but never let the page read the file (`net::ERR_ACCESS_DENIED`,
`NotReadableError`), so the app's upload silently never leaves the browser.
After every upload, Cairntrace checks in the page that the file is readable.
The check looks only at the input the upload changed (the file inputs are
marked just before it), never at another input that happens to hold a file
with the same name. When the file is not readable, Cairntrace rebuilds it from
the host bytes inside the page (DataTransfer, up to 25 MB), assigns it to that
same input and fires input/change again. `run.json` records `via:
setInputFiles | dataTransfer`, with the read error in `detail`. When no input
holds the file after the upload (an app that clears the input on change),
`detail` says that readability was not verified. Playwright keeps
`setInputFiles`.

## Export

`cairn export playwright` renders widget steps as `cairnWidget(page, …)` and
`cairnWidgetForm(page, …)` calls. The helper embeds the same in-page runtime
and your `fieldRoot` / `widgets` config (`lib/widgets.ts` in `--project`), so
an exported test writes and reads back exactly like `cairn run`.
`click.dispatch` and `fill.mode: set` run through the same helper (one visible
target; a disabled target fails a dispatch; the fill re-sets a wiped value),
`fallback: dispatch` becomes a try/catch around a 5-second pointer click with
that dispatch as the fallback, and `optional` an `isVisible()` guard. Error
messages of a password control or a credential-named field never include its
values.

## Example

The repository's demo suite has a working spec: `examples/flows/13-widgets-form.yml`
fills the demo app's `/widgets.html` (a native select, radio and checkbox
groups, a vue-multiselect look-alike, a field that mounts later and a Save
button behind a leftover dialog mask) with `form`, `choose`, `check`,
`click.optional`, `fallback: dispatch` and `fill.mode: set`, then waits on the
page's store with `wait: { app: … }`. Its config sets `browser.fieldRoot:
'[data-field-key$=".{key}"]'`.

## See also

- [Steps](/steps) — the full step vocabulary
- [Configuration](/configuration) — the `browser:` block
- [Export & import](/export) — what the Playwright export emits
