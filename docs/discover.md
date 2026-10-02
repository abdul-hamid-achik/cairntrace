---
title: Record Browser Specs with Live Discovery
description: Explore live pages through stateful, journaled Cairntrace discovery sessions — set up with your own actions, record interactions, watch the network, and export a browser spec.
---

# Discover & snapshot

Two page-inspection commands open a URL in a real backend and return agent-facing locator data. `cairn snapshot` returns the locator inventory; `cairn discover` returns the full accessibility tree *plus* the inventory in one call. For multi-step exploration, the MCP discovery session records every interaction as a spec step and exports a spec. Every discovery session — CLI or MCP — leaves a journal on disk that Cairntrace Studio shows live and that outlives the browser.

## `cairn discover [url]`

```bash
cairn discover https://app.com/login --roles --testids --format json
cairn discover /dashboard --env staging       # relative URL → config baseUrl
cairn discover /profile --use login_as_admin  # log in through your own action first
```

Returns:

```jsonc
{
  "status": "ok",
  "requestedUrl": "/dashboard",
  "url": "https://staging.app.com/dashboard",   // after baseUrl resolution
  "backend": "agent-browser",
  "snapshot": [                                  // full a11y tree
    { "role": "main", "level": 0 },
    { "role": "button", "name": "Submit", "level": 2, "ref": "btn-3" }
  ],
  "inventory": {
    "roles":   [{ "role": "button", "name": "Submit", "count": 1, "refs": ["btn-3"], "locator": { "by": "role", "role": "button", "name": "Submit" } }],
    "testids": [{ "testId": "login-submit", "count": 1, "selector": "[data-testid='login-submit']", "locator": { "by": "testid", "testid": "login-submit" }, "tagNames": ["button"], "textSamples": ["Submit"] }],
    "testIdAttribute": "data-testid"             // config browser.testIdAttribute
  },
  "sessionId": "7f0c…",                          // the journal of this one-shot
  "journal": "<artifactRoot>/_sessions/7f0c…",
  "snapshotInfo": { "mode": "full", "elements": 2, "returned": 2, "truncated": false, "path": "snapshots/001.txt" }
}
```

The `snapshot` tree is what the heal `snapshotParser` reads, so `discover` output is exactly what a spec author needs to draft `by: { role, name }` steps. The `inventory` deduplicates the tree into ready-to-paste locators.

### Flags

| Flag | Effect |
|---|---|
| `--roles` | include role/name locators in the inventory |
| `--testids` | include test-id locators, scanned on `browser.testIdAttribute` (default `data-testid`) |
| `--wait-until <state>` | `networkidle` \| `load` \| `domcontentloaded` before capturing (SPA hydration) |
| `--use <action>` | setup: run an imported reusable action first; repeatable; `name` or `name:key=value,…` for its vars |
| `--import <file>` | action file for `--use` (repeatable); default: config `authoring.template.imports`, then `actions/` directories under the config directory |
| `--from-spec <path>` + `--until-step <id>` | setup: replay that spec's steps through a step `id` (or 1-based position) |
| `--resume <checkpoint>` | restore a scoped checkpoint before the setup |
| `--snapshot-mode <mode>` | `full` (default for the CLI) \| `compact` \| `diff` \| `none` |
| `--max-bytes <n>` | cap the returned snapshot JSON (the CLI returns the whole tree by default); the journal keeps the full text |
| `--env <name>` | resolve a relative URL against `environments.<name>.baseUrl`; an environment the config does not define is an error (exit 4) |
| `--headed` | show the browser window |
| `--mock` | use the in-memory mock backend (no real browser) |
| `--backend <name>` | `agent-browser` (default) \| `playwright` \| `mock` |
| `--provider <name>` / `--device <name>` | agent-browser provider (e.g. `ios`) and device; win over `browser.provider` / `browser.device` |
| `--config <path>` | explicit `cairntrace.config.yml` (default: discovered upward from the current directory) |
| `--var <key=value>` | fill `${vars.X}`; repeatable, wins over config environment vars |
| `--format json\|yaml\|md` | output shape |

With neither `--roles` nor `--testids`, both inventories are included. A relative URL with no resolvable `baseUrl` is an error — pass an absolute URL or set `environments.<name>.baseUrl` in config. A `url` is optional when a setup or `--resume` leaves you on the page you want to inspect.

Exit codes: `0` ok, `2` error (including a setup step that failed), `4` config error (unknown environment, bad setup flags, an action or `--until-step` that cannot be found), `7` the environment policy refuses a `--from-spec` spec.

Both commands read the project config the way a run does: the selected environment supplies the `baseUrl`, `${vars.X}` placeholders in the URL resolve from config vars and `--var key=value` overrides (MCP `cairn_discover_open` / `cairn_snapshot` take the same `var` list), and the `browser:` block tunes the backend. Printed URLs are redacted: resolved `${secrets.X}` values, token-like query parameters and URL userinfo show as `[redacted]`. In particular `browser.testIdAttribute` (for example `data-qa`) is the attribute the test-id inventory scans, so the locators you copy are the ones `by: testid` resolves at run time.

```bash
cairn discover '/projects/${vars.projectId}' --env staging
cairn snapshot '/projects/${vars.projectId}' --var projectId=42 --json
```

## `cairn snapshot <url>`

The lighter variant: returns only the locator inventory (no accessibility tree). Use it when you already know the page shape and just want the locators refreshed.

```bash
cairn snapshot https://app.com/login --testids --format md
```

The flags match `discover` (without the setup flags). The report shape is the `inventory` object above plus `{ status, requestedUrl, url, backend }`.

## When to use which

- **Drafting a new spec from a live page** — `cairn discover` once, then copy locators from the inventory into `steps:`.
- **Recording a multi-step journey** — the MCP discovery session below.
- **Refreshing locators after a UI change** — `cairn snapshot` (smaller payload, faster).
- **Offline / test harness** — `--mock` runs against the in-memory backend with no browser, useful for asserting the command plumbing.

## Discovery sessions (MCP)

For multi-step exploration — reach a state, act, look, act again, then export a spec — use the MCP discovery tools. The browser stays alive across calls; every step runs through the same engine as `cairn run` (config, environment, `${vars.X}`, `${secrets.X}` from the configured secrets provider, `imports` + `use:`, the click/fill resilience layer). The backend defaults to config `discovery.backend`, else `agent-browser`; `backend: playwright` is accepted per session.

Each action is its own short run on the live browser, so the session carries what one run would share between steps: an `eval` / `request` with `assign` makes `${evals.<name>…}` / `${requests.<name>…}` available to later actions (the recorded step keeps the placeholder), and a `fromSpec` setup's `vars`, `settleMs`, `viewport` and `redaction` apply to every later action. A step that references a capture no earlier action made is refused rather than run with the literal placeholder, and so is one whose captured value is `[redacted]` in the run's artifacts (it resolves when the exported spec runs). `${artifacts.X}` of an earlier action is not available live.

| Tool | What it does |
|---|---|
| `cairn_discover_open` | setup (optional), then open `url`; first snapshot + inventory, the journal directory, the setup outcome |
| `cairn_discover_interact` | one step: `click` `fill` `hover` `type` `select` `upload` `scroll` `press` (+`target`) `focus` `eval` `wait` `request` `assert`, or `step: <any spec step>` |
| `cairn_discover_navigate` | open another URL (recorded as an `open` step) |
| `cairn_discover_snapshot` / `cairn_discover_inventory` | the page now / its locators |
| `cairn_discover_network` | requests the session saw (redacted) |
| `cairn_discover_suggest` / `cairn_discover_remove_step` | what export will write, with action indexes / undo one step |
| `cairn_discover_export` | write the spec (works after the browser closed) |
| `cairn_discover_close` / `cairn_discover_resume` / `cairn_discover_list` | free the browser / re-open from the journal / list sessions |

### Setup before exploring

An authenticated page is rarely one URL away. Reach it with the project's own building blocks instead of re-recording a login:

```jsonc
// imported reusable actions (vars optional)
{ "url": "/profile", "setup": [{ "use": "login_as_supplier" }] }

// a spec's own steps, through one of them
{ "setup": { "fromSpec": "flows/profile.yml", "untilStep": "open_profile" } }

// a scoped checkpoint first (same rules as a run's session.resume)
{ "url": "/profile", "resume": "supplier" }
```

Actions are found by name in `imports` (paths relative to the current directory), then in the config's `authoring.template.imports`, then in any `actions/` directory under the config directory. The same lookup serves a `use:` step recorded later through `cairn_discover_interact` (`step: { use: … }`); its action file joins the session's imports, so export and resume carry it. A `fromSpec` setup replays that spec's steps with its imports, vars and `requires:` (the environment policy applies); its preconditions are not run. The journal keeps the `fromSpec` path absolute, so an export or a resume from another directory reads the same file (it re-reads the spec as it is then). A failed setup fails the open and keeps the setup run in the journal for diagnosis.

The export writes the setup **as it was given**: `imports:` (relative to the written spec) and `use:` steps — or the source spec's own steps — never the expanded action steps, plus `session: { resume }` when a checkpoint was used. That also satisfies the cold-start contract.

### Recording richer steps

```jsonc
{ "action": "fill",   "target": { "by": "label", "name": "Website" }, "value": "https://example.test" }
{ "action": "press",  "value": "Enter", "target": { "by": "label", "name": "Search" } }
{ "action": "eval",   "eval": { "js": "return window.store.state.count" } }      // result: { value }
{ "action": "request","request": { "method": "GET", "url": "/api/me" } }          // result: { status, body }
{ "action": "wait",   "wait": { "url": { "includes": "/done" } } }
{ "action": "assert", "assert": { "text": "Saved" } }                             // recorded as a wait step
{ "step": { "click": { "by": "role", "role": "button", "name": "Save", "until": { "text": "Saved" } } } }
```

Recorded steps are validated against the spec schema, so they are steps the exported spec can run. Failed steps are journaled but never recorded. Secrets stay placeholders: write `${secrets.NAME}` — and a value equal to a known secret (a provider key, a name in `secrets.required` / `secrets.keys`, or a secret-looking environment variable) is recorded as its placeholder anyway. A relative `upload` / `eval.file` path is recorded as `${config.dir}/…` so the spec finds it wherever it is written.

### Network visibility

`cairn_discover_interact` and `cairn_discover_navigate` return `network.mutations` — the non-GET requests the action caused, as method, path (no query string) and status:

```jsonc
"network": { "mutations": [{ "method": "PATCH", "path": "/api/answers/42", "status": 204 }] }
```

`cairn_discover_network { sessionId, sinceAction?, method?, urlContains? }` lists every request the session saw, including ones that completed after an action returned (a debounced autosave). Entries carry method, URL without query string, path, status, resource type and timing — never headers or bodies. Use them to author `postcondition.network` on the step that triggers the mutation.

### Context economy

Full accessibility snapshots of real apps are large. `snapshotMode` on open, interact, navigate and snapshot chooses what comes back:

- `diff` (default) — only elements added or changed since the previous snapshot. Each element carries a stable `key` (agent-browser `ref`s are renumbered on every snapshot); `snapshotInfo.removed` lists what disappeared and `snapshotInfo.unchanged` counts the rest.
- `compact` — elements with a ref or a name.
- `full` — everything. `none` — nothing.

`maxBytes` (default 16384 for the MCP tools) caps the returned JSON — the elements plus `snapshotInfo.removed`, which takes at most a quarter (`snapshotInfo.truncated`). In `diff` mode a snapshot of an unchanged page returns no elements; ask for `compact` or `full` to see the page again. The mode and budget passed to `cairn_discover_open` become the session's defaults; any later call can override them. Element names and attribute values are redacted before they are diffed or measured, including in `removed`. The full snapshot text is always in the journal (`snapshotInfo.path`).

### The session journal

Every session writes `<artifactRoot>/_sessions/<sessionId>/`:

| File | Contents |
|---|---|
| `session.json` | identity, inputs (URL as requested, environment, config, setup), backend, status `open` \| `expired` \| `closed` \| `exported`, TTL, exported paths — rewritten atomically |
| `events.ndjson` | `session.opened`, `action.performed` (index, action, locator, ok, error, URL before/after without query string, duration, screenshot, snapshot, network mutations), `step.recorded`, `step.removed`, `snapshot.captured`, `draft.updated`, `export.written`, `screenshots.disabled` (index, reason: the first screenshot that timed out; the session takes no more), `session.closed` |
| `screenshots/NNN.png` | the page after action NNN (skipped when the backend cannot screenshot, and after a screenshot timed out: each capture is limited to 45s, the first timeout turns screenshots off for the session and that action's result carries a `warnings` entry) |
| `snapshots/NNN.txt` | full accessibility snapshots (redacted) |
| `network/NNN.json` | requests seen during action NNN (redacted) |
| `draft.spec.yml` | the spec the session would export now, regenerated after every recorded step; secrets as placeholders |
| `setup/` | the run that executed the setup |

The browser closes after `ttlMs` of inactivity (default 30 minutes; config `discovery.sessionTtlMs`, or `ttlMs` on open), but the journal stays with status `expired`. `cairn_discover_export`, `_suggest` and `_network` still work from the journal, and `cairn_discover_resume { sessionId }` opens a fresh browser, restores the checkpoint, runs the setup and replays every recorded step to reach the same state, continuing the same journal. Retention keeps the newest 50 journals, plus open ones and any that a still-existing exported spec names (`cairn clean` applies the same rule).

Recorded steps keep their placeholders in the journal: `open: …?token=${secrets.CB_TOKEN}` and `Authorization: "Bearer ${env.API_TOKEN}"` are written as they are, because they name a secret without holding one. A literal secret is written as `[redacted]`; resume refuses a journal with such a step (remove it with `cairn_discover_remove_step` and record the value as a `${secrets.X}` placeholder), and an export from the journal warns. One journal has one writer: resume refuses a session that is still open in this or another live process (until its TTL has run out). An export from the journal of a session that is still open works and warns; the live session keeps the export's `exportedTo` and intent.

### Recording URLs safely

`cairn_discover_open` takes the same `env` and `config` inputs, plus `var` (a `key=value` list for `${vars.X}`). The session remembers the config `baseUrl` (a relative `cairn_discover_navigate` URL joins it; without one it resolves against the current page) and `browser.testIdAttribute` (what `cairn_discover_inventory` scans).

The browser opens the resolved URL, but the session records the URL **as requested**: `${secrets.X}`, `${env.X}` and `${vars.X}` placeholders stay placeholders, and a relative path that joined the `baseUrl` stays relative. An exported spec therefore never contains a resolved secret, and it follows whichever environment runs it. `cairn_discover_export` re-parses the spec with the session's `env`/`config`/`var` inputs and warns when a `${vars.X}` value came only from `var` (pass the same `--var` to `cairn run`). On a real browser, a relative URL that cannot be resolved is an error instead of a navigation to a bare `/path`; `mock: true` sessions keep the bare path for offline exploration.

## Export a session from its journal

```bash
cairn discover sessions --json
cairn discover export --from-session <dir|id> --path flows/profile_website.yml \
  --intent "A supplier updates the profile website" --outcomes outcomes.yml --json
```

`--outcomes` is a YAML or JSON file holding the outcomes array (the contract). On a re-export, `--intent` and `--outcomes` default to the ones the session's last export recorded in `session.json` (a warning says so); a session that was never exported needs both. `--resume <checkpoint>` writes `session: { resume }`, and `--overwrite` replaces a spec with a stamped `contractHash`. Exit codes: `0` written and parsed, `4` refused (a stamped spec without `--overwrite`, an existing file for a convention export, a secret literal, an invalid spec) or the written spec failed to parse, `2` error (for example, no such session).

### Convention export

`--into <dir|file>` (relative to the config directory; default the drafts directory, `authoring.draftsDir`, `flows/_drafts`) — or `--conventions`, or no `--path` — writes the spec the project's way: runs of steps an existing action performs become `use: { action, vars }`, literals equal to a config var become `${vars.X}`, absolute URLs under the `baseUrl` become relative, `open:` waits for `networkidle`, a click that changed the page gets a `wait: { url }`, a request the session saw a click or fill send becomes `postcondition.network`, every step gets a snake_case `id`, and `authoring.template` adds `requires` and `metadata.tags`. `--name` names the file, `--requires-env a,b` / `--mutates` / `--tag` set `requires` and tags, `--no-reuse-actions` / `--no-lift-vars` turn those passes off. Known secret values are always written as their placeholders, and a literal typed into a field whose name sounds like a credential that matches no known secret refuses the export (`--allow-secret-literals` keeps it with a warning; a plain `--path` export only warns). The result's `report` lists what was reused, lifted and placeholdered. MCP `cairn_discover_export` takes the same options (`into`, `name`, `conventions`, `reuseActions`, `liftVars`, `refuseSecrets`, `requires`, `tags`). Next: `cairn spec finish`, then `cairn spec promote` — see [Author a spec from a request](/author-flow).

Run `cairn docs discovery --json` (or MCP `cairn_docs` with topic `discovery`) for the full discovery workflow.

## See also

- [Steps](/steps) — the `by: { role, name }` locator shape these inventories produce
- [Configuration](/configuration) — `environments.<name>.baseUrl` for relative-URL resolution
- [MCP](/mcp) — the interactive `cairn_discover_*` tool family
- [Checkpoints](/checkpoint) — scoped checkpoints for `resume`
- [Journey briefs](/brief) — the inverse: play a spec when locators miss (`cairn_accompany_*`)
