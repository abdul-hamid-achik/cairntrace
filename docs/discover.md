# Discover & snapshot

Two page-inspection commands that open a URL in a real backend and return agent-facing locator data. `cairn snapshot` returns the locator inventory; `cairn discover` returns the full accessibility tree *plus* the inventory in one call. Both are the one-shot CLI equivalent of the interactive MCP discovery session.

## `cairn discover <url>`

```bash
cairn discover https://app.com/login --roles --testids --format json
cairn discover /dashboard --env staging       # relative URL → config baseUrl
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
    "testids": [{ "testId": "login-submit", "count": 1, "selector": "[data-testid='login-submit']", "tagNames": ["button"], "textSamples": ["Submit"] }]
  }
}
```

The `snapshot` tree is what the heal `snapshotParser` reads, so `discover` output is exactly what a spec author needs to draft `by: { role, name }` steps. The `inventory` deduplicates the tree into ready-to-paste locators.

### Flags

| Flag | Effect |
|---|---|
| `--roles` | include role/name locators in the inventory |
| `--testids` | include `data-testid` locators in the inventory |
| `--env <name>` | resolve a relative URL against `environments.<name>.baseUrl` |
| `--headed` | show the browser window |
| `--mock` | use the in-memory mock backend (no real browser) |
| `--backend <name>` | `agent-browser` (default) \| `playwright` \| `mock` |
| `--config <path>` | explicit `cairntrace.config.yml` |
| `--format json\|yaml\|md` | output shape |

With neither `--roles` nor `--testids`, both inventories are included. A relative URL with no resolvable `baseUrl` is an error — pass an absolute URL or set `environments.<name>.baseUrl` in config.

## `cairn snapshot <url>`

The lighter variant: returns only the locator inventory (no accessibility tree). Use it when you already know the page shape and just want the locators refreshed.

```bash
cairn snapshot https://app.com/login --testids --format md
```

The flags are identical to `discover`. The report shape is the `inventory` object above plus `{ status, requestedUrl, url, backend }`.

## When to use which

- **Drafting a new spec from a live page** — `cairn discover` once, then copy locators from the inventory into `steps:`.
- **Refreshing locators after a UI change** — `cairn snapshot` (smaller payload, faster).
- **Offline / test harness** — `--mock` runs against the in-memory backend with no browser, useful for asserting the command plumbing.

## The interactive alternative

For multi-step exploration (click, then snapshot the new state, then export a spec), use the MCP discovery tools — `cairn_discover_open` → `cairn_discover_interact` / `cairn_discover_navigate` → `cairn_discover_export`. The browser stays alive across calls and auto-expires after 5 min of inactivity. The CLI command here is the one-shot equivalent for when you only need a single page's structure.

Run `cairn docs discovery --json` (or MCP `cairn_docs` with topic `discovery`) for the full discovery workflow.

## See also

- [Steps](/steps) — the `by: { role, name }` locator shape these inventories produce
- [Configuration](/configuration) — `environments.<name>.baseUrl` for relative-URL resolution
- [MCP](/mcp) — the interactive `cairn_discover_*` tool family